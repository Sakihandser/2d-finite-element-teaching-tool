"""Backend selection and an application-level training probe (no user data)."""
import io
import os
from functools import lru_cache

import torch

BACKENDS = ('cuda', 'rocm', 'xpu', 'directml', 'mps', 'cpu')


def cpu_tensors(value):
    """Serialize ordinary CPU tensors, including PrivateUse1 optimizer states."""
    if isinstance(value, torch.Tensor):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {key: cpu_tensors(item) for key, item in value.items()}
    if isinstance(value, list):
        return [cpu_tensors(item) for item in value]
    if isinstance(value, tuple):
        return tuple(cpu_tensors(item) for item in value)
    return value


def backend_device(backend, index=0):
    if backend in ('cuda', 'rocm'):
        if not torch.cuda.is_available() or bool(torch.version.hip) != (backend == 'rocm'):
            raise RuntimeError(f'{backend.upper()} 不可用')
        return torch.device('cuda', index), torch.cuda.get_device_name(index)
    if backend == 'xpu':
        if not hasattr(torch, 'xpu') or not torch.xpu.is_available():
            raise RuntimeError('XPU 不可用')
        return torch.device('xpu', index), torch.xpu.get_device_name(index)
    if backend == 'directml':
        import torch_directml
        if not torch_directml.is_available():
            raise RuntimeError('DirectML 不可用')
        return torch_directml.device(index), torch_directml.device_name(index).rstrip('\0')
    if backend == 'mps':
        if not torch.backends.mps.is_available():
            raise RuntimeError('MPS 不可用')
        return torch.device('mps'), 'Apple Metal GPU'
    if backend == 'cpu':
        return torch.device('cpu'), 'CPU'
    raise ValueError(f'未知计算后端：{backend}')


def device_count(backend):
    if backend in ('cuda', 'rocm'):
        return torch.cuda.device_count() if bool(torch.version.hip) == (backend == 'rocm') else 0
    if backend == 'xpu':
        return torch.xpu.device_count() if hasattr(torch, 'xpu') else 0
    if backend == 'directml':
        import torch_directml
        return torch_directml.device_count()
    return 1


def training_probe(device):
    """Exercise the real graph network, loss, clipping, AdamW and CPU checkpoint.

    A driver availability flag or matrix multiplication alone does not prove
    support for this network's indexed aggregation and backward operators.
    """
    from graph_data import FEATURE_NAMES, to_device
    from model import MeshSizingNetwork, sizing_loss
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(42)
        graph = {
            'x': torch.randn(6, len(FEATURE_NAMES)),
            'edges': torch.tensor([[0,1,1,2,2,3,3,4,4,5], [1,0,2,1,3,2,4,3,5,4]]),
            'edge_features': torch.randn(10,5), 'pool': torch.tensor([0,0,1,1,2,2]),
            'coarse_edges': torch.tensor([[0,1,1,2],[1,0,2,1]]),
            'current': torch.full((6,), -1.), 'y': torch.full((6,), -1.5),
            'weight': torch.ones(6)/6,
        }
        graph = to_device(graph, device)
        model = MeshSizingNetwork(16,2).to(device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=.001, foreach=False)
        def step(network, optim):
            optim.zero_grad(set_to_none=True)
            loss = sizing_loss(network(graph), graph)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(network.parameters(), 1., error_if_nonfinite=True, foreach=False)
            optim.step()
            if not torch.isfinite(loss).item():
                raise RuntimeError('后端训练自检损失非有限值')
            return loss.item()
        initial = step(model, optimizer)
        buffer = io.BytesIO()
        torch.save(cpu_tensors({'network': model.state_dict(), 'optimizer': optimizer.state_dict()}), buffer)
        buffer.seek(0)
        saved = torch.load(buffer, map_location='cpu', weights_only=True)
        restored = MeshSizingNetwork(16,2).to(device)
        restored.load_state_dict(saved['network'])
        resumed_optimizer = torch.optim.AdamW(restored.parameters(), lr=.001, foreach=False)
        resumed_optimizer.load_state_dict(saved['optimizer'])
        step(model, optimizer)
        final = step(restored, resumed_optimizer)
        for original, resumed in zip(model.parameters(), restored.parameters()):
            torch.testing.assert_close(original.cpu(), resumed.cpu(), rtol=1e-4, atol=1e-6)
        return {'initialLoss': initial, 'resumedLoss': final}


@lru_cache(maxsize=None)
def select_device(requested='auto', index=None):
    if requested != 'auto' and requested not in BACKENDS:
        raise ValueError(f'未知计算后端：{requested}')
    failures = []
    for backend in BACKENDS if requested == 'auto' else (requested,):
        try:
            count = device_count(backend)
            for adapter in range(count) if index is None else (index,):
                try:
                    device, name = backend_device(backend, adapter)
                    training_probe(device)
                    return device, {'backend': backend, 'gpu': None if backend == 'cpu' else name,
                        'device': str(device), 'deviceName': name, 'deviceIndex': adapter,
                        'diagnostics': failures + (['DirectML 的部分图聚合算子会在 CPU 执行，速度取决于显卡与图规模。'] if backend == 'directml' else [])}
                except Exception as error:
                    failures.append(f'{backend}:{adapter}: {error}')
        except Exception as error:
            failures.append(f'{backend}: {error}')
    raise RuntimeError('计算后端自检失败：' + '; '.join(failures))


def environment_report(device, info):
    report = {**info, 'device': str(device), 'torch': str(torch.__version__),
        'cuda': torch.version.cuda, 'hip': torch.version.hip,
        'cudaAvailable': device.type == 'cuda' and not bool(torch.version.hip),
        'memoryMiB': None}
    if device.type == 'cuda':
        report['memoryMiB'] = round(torch.cuda.memory_allocated(device)/1024**2, 1)
    return report
