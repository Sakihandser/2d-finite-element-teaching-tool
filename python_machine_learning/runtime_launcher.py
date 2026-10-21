"""Stdlib-only launcher: incompatible PyTorch builds live in separate venvs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
RUNTIMES = ('.venv', '.venv-rocm', '.venv-xpu', '.venv-directml', '.venv-cpu')


def python_path(directory):
    if os.name == 'nt' and (directory/'python.exe').is_file():
        return directory/'python.exe'
    return directory / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def candidates():
    paths = [Path(os.environ['FEM_ML_PYTHON'])] if os.environ.get('FEM_ML_PYTHON') else []
    paths += [python_path(ROOT / name) for name in RUNTIMES]
    paths.append(Path(sys.executable))
    return list(dict.fromkeys(path.resolve() for path in paths if path.is_file()))


def probe(python, backend):
    result = subprocess.run([str(python), '-u', str(ROOT/'check_runtime.py'), '--backend', backend],
        # A cold portable install on an HDD can spend over a minute loading
        # native libraries. CPU is the required fallback, so allow more time.
        cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=240 if backend == 'cpu' else 90,
        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise RuntimeError((result.stdout or result.stderr)[-1600:])
    return json.loads(result.stdout.strip().splitlines()[-1])


def select_runtime(paths, requested='auto', probe_fn=probe):
    if requested not in ('auto', 'cuda', 'rocm', 'xpu', 'directml', 'mps', 'cpu'):
        raise ValueError('无效的 FEM_ML_DEVICE：'+requested)
    diagnostics = []
    deadline = time.monotonic()+150
    # GPU priority is global, not per environment: a CPU fallback in one build
    # must not prevent trying the next installed GPU build.
    backends = ('cuda','rocm','xpu','directml','mps','cpu') if requested == 'auto' else (requested,)
    # CPU-only torch is preferred for fallback, even if a CUDA build imports.
    for backend in backends:
        ordered = sorted(paths, key=lambda p: ('.venv-cpu' not in p.parts)) if backend == 'cpu' else paths
        for python in ordered:
            if backend != 'cpu' and time.monotonic() >= deadline:
                diagnostics.append('GPU 探测达到总耗时限制，继续尝试 CPU。')
                break
            # Known dedicated builds cannot contain these other GPU backends.
            dedicated = next((name for name in RUNTIMES[1:] if name in python.parts), None)
            if backend != 'cpu' and dedicated and dedicated != '.venv-'+backend:
                continue
            try:
                info = probe_fn(python, backend)
                if info.get('status') != 'PASS' or info.get('backend') != backend:
                    raise RuntimeError('自检返回无效后端')
                return python, info, diagnostics
            except Exception as error:
                diagnostics.append(f'{python.parent.parent.name}/{backend}: {error}')
    raise RuntimeError('没有可用的机器学习环境。请运行 scripts/setup-ml.ps1。\n'+'\n'.join(diagnostics))


def main():
    try:
        python, info, diagnostics = select_runtime(candidates(), os.environ.get('FEM_ML_DEVICE','auto'))
        print(f"机器学习选择 {info['backend']} / {info['deviceName']} / {python}", file=sys.stderr, flush=True)
        env = {**os.environ, 'FEM_ML_DEVICE': info['backend'],
            'FEM_ML_DEVICE_INDEX': str(info.get('deviceIndex',0)),
            'FEM_ML_RUNTIME_DIAGNOSTICS': json.dumps(diagnostics, ensure_ascii=True)}
        return subprocess.call([str(python), '-u', str(ROOT/'worker.py')], cwd=ROOT, env=env)
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
