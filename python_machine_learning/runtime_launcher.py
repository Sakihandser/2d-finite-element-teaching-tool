"""Stdlib-only launcher: incompatible PyTorch builds live in separate venvs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent
RUNTIMES = ('.venv', '.venv-rocm', '.venv-xpu', '.venv-directml', '.venv-cpu')
BACKENDS = ('cuda', 'rocm', 'xpu', 'directml', 'mps', 'cpu')


def cache_path():
    return Path(os.environ.get('FEM_ML_STORAGE', ROOT/'storage')).resolve()/'runtime-cache.json'


def read_cached_runtime(file, paths, requested):
    try:
        record = json.loads(file.read_text(encoding='utf-8'))
        python = Path(record['python'])
        info = record['info']
        if (record['version'] != 1 or record['root'] != str(ROOT)
                or record.get('pythonOverride', '') != os.environ.get('FEM_ML_PYTHON', '')
                or python not in paths or not python.is_file()
                or info['backend'] not in BACKENDS
                or requested not in ('auto', info['backend'])
                or type(info['deviceIndex']) is not int or info['deviceIndex'] < 0):
            return None
        return python, info
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save_cached_runtime(file, python, info):
    # Cache failures must never prevent using an otherwise healthy service.
    temporary = None
    try:
        file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=file.parent,
                prefix='runtime-cache-', suffix='.tmp', delete=False) as output:
            temporary = Path(output.name)
            json.dump({'version': 1, 'root': str(ROOT), 'python': str(python), 'info': info,
                'pythonOverride': os.environ.get('FEM_ML_PYTHON', '')}, output, ensure_ascii=False)
        os.replace(temporary, file)
    except OSError as error:
        print(f'无法保存训练环境连接记录：{error}', file=sys.stderr, flush=True)
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def start_worker(python, info, diagnostics):
    # Inherit the protocol streams: requests queued by Node remain unread until
    # initialization succeeds, so a failed cached start can safely fall back.
    with tempfile.TemporaryDirectory(prefix='fem-ml-ready-') as temporary:
        ready = Path(temporary)/'ready.json'
        env = {**os.environ, 'FEM_ML_DEVICE': info['backend'],
            'FEM_ML_DEVICE_INDEX': str(info.get('deviceIndex', 0)),
            'FEM_ML_RUNTIME_VERIFIED': '1', 'FEM_ML_READY_FILE': str(ready),
            'FEM_ML_RUNTIME_DIAGNOSTICS': json.dumps(diagnostics, ensure_ascii=True)}
        child = subprocess.Popen([str(python), '-u', str(ROOT/'worker.py')], cwd=ROOT, env=env,
            stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            deadline = time.monotonic() + (240 if info['backend'] == 'cpu' else 90)
            while True:
                if ready.is_file():
                    report = json.loads(ready.read_text(encoding='utf-8'))
                    return child, report
                if child.poll() is not None:
                    raise RuntimeError(f'训练环境启动失败（退出码 {child.returncode}）')
                if time.monotonic() >= deadline:
                    raise TimeoutError('训练环境连接超时')
                time.sleep(.05)
        except BaseException:
            if child.poll() is None:
                # Windows venv python.exe can be a redirector with a second
                # interpreter process; terminate both before retrying.
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                child.kill()
            child.wait()
            raise


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
    if requested not in ('auto',) + BACKENDS:
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
        paths = candidates()
        requested = os.environ.get('FEM_ML_DEVICE', 'auto')
        if requested not in ('auto',) + BACKENDS:
            raise ValueError('无效的 FEM_ML_DEVICE：'+requested)
        file = cache_path()
        cached = read_cached_runtime(file, paths, requested)
        diagnostics = []
        if cached:
            python, info = cached
            print(f"正在连接上次使用的训练环境：{info['backend']} / {python}", file=sys.stderr, flush=True)
            try:
                child, report = start_worker(python, info, diagnostics)
            except Exception as error:
                diagnostics.append(f'上次训练环境连接失败，重新自检：{error}')
                print(diagnostics[-1], file=sys.stderr, flush=True)
                try:
                    file.unlink(missing_ok=True)
                except OSError:
                    pass
            else:
                save_cached_runtime(file, python, report)
                return child.wait()
        python, info, failures = select_runtime(paths, requested)
        diagnostics += failures
        print(f"机器学习选择 {info['backend']} / {info['deviceName']} / {python}", file=sys.stderr, flush=True)
        child, report = start_worker(python, info, diagnostics)
        save_cached_runtime(file, python, report)
        return child.wait()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
