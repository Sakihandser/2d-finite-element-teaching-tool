"""Opt-in real hardware cross-build recovery test, using disposable storage.

Run directly with .venv-cpu/Scripts/python.exe test_runtime_transfer.py.
Requires installed CUDA and DirectML environments with working hardware.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
from runtime_launcher import python_path
SNIPPET = '''
import json, os, sys
from worker import TrainingService
from test_training import TrainingTests
service = TrainingService(sys.argv[1])
if sys.argv[2] == 'seed':
    run = TrainingTests().seed(service, device='auto')
else:
    run = sys.argv[2]
    service.restore(run)
    service.state['config']['epochs'] += 1
before = service.state['step']
service.train()
assert service.state['status'] == 'completed', service.state.get('error')
assert service.state['step'] > before
checkpoint = service.load_checkpoint(run)
assert all(t.device.type == 'cpu' for t in checkpoint['network'].values())
print(json.dumps({'run':run, 'backend':service.device_info['backend'], 'step':service.state['step']}))
'''


def main():
    reports = []
    with tempfile.TemporaryDirectory(prefix='fem-runtime-transfer-') as temporary:
        run = 'seed'
        for environment, backend in [('.venv-cpu','cpu'),('.venv','cuda'),('.venv-directml','directml'),('.venv-cpu','cpu')]:
            python = python_path(ROOT/environment)
            result = subprocess.run([str(python),'-c',SNIPPET,temporary,run], cwd=ROOT,
                env={**os.environ,'FEM_ML_DEVICE':backend,'PYTHONIOENCODING':'utf-8'},
                capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=120)
            if result.returncode:
                raise RuntimeError(f'{backend}: {result.stdout}\n{result.stderr}')
            report = json.loads(result.stdout.strip().splitlines()[-1])
            run = report['run']
            reports.append(report)
    print(json.dumps({'status':'PASS','transfers':reports},ensure_ascii=False,indent=2))


if __name__ == '__main__': main()
