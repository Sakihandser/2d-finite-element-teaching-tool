r"""Verify this environment's CUDA training and checkpoint support.

Run with: .\.venv\Scripts\python.exe .\check_gpu.py
Uses synthetic data only; does not read or modify FEM models.
"""

import json
import platform
import tempfile
from pathlib import Path

import torch


def main():
    if not torch.cuda.is_available():
        raise RuntimeError(f"CUDA unavailable; installed torch: {torch.__version__}")

    device = torch.device("cuda:0")
    torch.manual_seed(42)

    # Exercise a real CUDA kernel, rather than only querying driver availability.
    matrix = torch.randn(1024, 1024, device=device)
    assert torch.isfinite(matrix @ matrix.T).all().item()
    torch.cuda.reset_peak_memory_stats(device)

    def make_model():
        return torch.nn.Sequential(
            torch.nn.Linear(8, 32), torch.nn.SiLU(), torch.nn.Linear(32, 2)
        ).to(device)

    model = make_model()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.02)
    x = torch.randn(256, 8, device=device)
    target = torch.stack((x[:, 0] + 2 * x[:, 1], x[:, 2] - x[:, 3]), dim=1)

    def step(network, optim):
        optim.zero_grad(set_to_none=True)
        loss = torch.nn.functional.mse_loss(network(x), target)
        loss.backward()
        assert all(
            parameter.grad is not None and torch.isfinite(parameter.grad).all().item()
            for parameter in network.parameters()
        )
        optim.step()
        return loss.item()

    initial_loss = torch.nn.functional.mse_loss(model(x), target).item()
    for _ in range(60):
        step(model, optimizer)
    trained_loss = torch.nn.functional.mse_loss(model(x), target).item()
    assert trained_loss < initial_loss * 0.2, (initial_loss, trained_loss)

    # Check graph-message aggregation and its backward pass on the GPU.
    messages = torch.randn(512, 32, device=device, requires_grad=True)
    destinations = torch.arange(512, device=device) % 128
    aggregated = torch.zeros(128, 32, device=device).index_add(0, destinations, messages)
    aggregated.square().mean().backward()
    assert torch.isfinite(messages.grad).all().item()

    # Confirm a saved model AND optimizer can resume the same next training step.
    with tempfile.TemporaryDirectory(prefix="fem-cuda-check-") as temporary:
        checkpoint_path = Path(temporary) / "checkpoint.pt"
        torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict(), "step": 60}, checkpoint_path)
        checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=True)
        restored = make_model()
        restored_optimizer = torch.optim.AdamW(restored.parameters(), lr=0.02)
        restored.load_state_dict(checkpoint["model"])
        restored_optimizer.load_state_dict(checkpoint["optimizer"])
        assert checkpoint["step"] == 60
        step(model, optimizer)
        step(restored, restored_optimizer)
        for original, resumed in zip(model.parameters(), restored.parameters()):
            torch.testing.assert_close(original, resumed, rtol=1e-6, atol=1e-7)

    torch.cuda.synchronize(device)
    import pytorch_lightning
    import pytorch_metric_learning
    import torchmetrics

    report = {
        "status": "PASS",
        "python": platform.python_version(),
        "torch": torch.__version__,
        "cuda_runtime": torch.version.cuda,
        "cuda_available": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(device),
        "gpu_memory_gib": round(torch.cuda.get_device_properties(device).total_memory / 1024**3, 2),
        "initial_loss": initial_loss,
        "trained_loss": trained_loss,
        "graph_aggregation_backward": "PASS",
        "checkpoint_resume_next_step": "PASS",
        "lightning": pytorch_lightning.__version__,
        "torchmetrics": torchmetrics.__version__,
        "metric_learning": pytorch_metric_learning.__version__,
        "peak_allocated_mib": round(torch.cuda.max_memory_allocated(device) / 1024**2, 1),
    }
    report_text = json.dumps(report, indent=2)
    Path(__file__).with_name("gpu-check-result.json").write_text(report_text + "\n", encoding="utf-8")
    print(report_text)


if __name__ == "__main__":
    main()
