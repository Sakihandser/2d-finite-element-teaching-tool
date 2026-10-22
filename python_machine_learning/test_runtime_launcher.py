"""Startup cache and fallback regressions; no PyTorch import required."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import runtime_launcher as launcher


class RuntimeCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.file = Path(self.temporary.name)/'runtime-cache.json'
        self.python = Path(sys.executable).resolve()
        self.info = {'backend': 'cuda', 'deviceIndex': 1, 'deviceName': 'fixture GPU'}

    def save(self):
        launcher.save_cached_runtime(self.file, self.python, self.info)

    def test_cache_round_trip_and_explicit_backend(self):
        self.save()
        for requested in ('auto', 'cuda'):
            self.assertEqual(launcher.read_cached_runtime(self.file, [self.python], requested),
                (self.python, self.info))
        self.assertIsNone(launcher.read_cached_runtime(self.file, [self.python], 'cpu'))

    def test_missing_corrupt_and_invalid_cache_are_ignored(self):
        for value in ('', '{broken', 'null', '[]', '{"version": 1}'):
            self.file.write_text(value, encoding='utf-8')
            self.assertIsNone(launcher.read_cached_runtime(self.file, [self.python], 'auto'))
        self.save()
        self.assertIsNone(launcher.read_cached_runtime(self.file, [], 'auto'))
        record = json.loads(self.file.read_text(encoding='utf-8'))
        record['info']['deviceIndex'] = -1
        self.file.write_text(json.dumps(record), encoding='utf-8')
        self.assertIsNone(launcher.read_cached_runtime(self.file, [self.python], 'auto'))

    def test_changed_python_override_does_not_reuse_old_cache(self):
        self.save()
        with patch.dict(os.environ, {'FEM_ML_PYTHON': 'another-python'}):
            self.assertIsNone(launcher.read_cached_runtime(self.file, [self.python], 'auto'))

    def run_main(self, cached, starts):
        child = Mock()
        child.wait.return_value = 0
        with patch.dict(os.environ, {'FEM_ML_DEVICE': 'auto'}), \
             patch.object(launcher, 'cache_path', return_value=self.file), \
             patch.object(launcher, 'candidates', return_value=[self.python]), \
             patch.object(launcher, 'read_cached_runtime', return_value=cached), \
             patch.object(launcher, 'select_runtime', return_value=(self.python, self.info, [])) as select, \
             patch.object(launcher, 'start_worker', side_effect=[
                 (child, self.info) if result == 'success' else result for result in starts]) as start, \
             patch.object(launcher, 'save_cached_runtime') as save:
            result = launcher.main()
        return result, select, start, save

    def test_cached_connection_skips_full_probes(self):
        result, select, start, save = self.run_main((self.python, self.info), ['success'])
        self.assertEqual(result, 0)
        select.assert_not_called()
        start.assert_called_once_with(self.python, self.info, [])
        save.assert_called_once_with(self.file, self.python, self.info)

    def test_failed_cached_connection_falls_back_and_replaces_cache(self):
        self.save()
        result, select, start, save = self.run_main((self.python, self.info),
            [RuntimeError('driver unavailable'), 'success'])
        self.assertEqual(result, 0)
        select.assert_called_once_with([self.python], 'auto')
        self.assertEqual(start.call_count, 2)
        self.assertIn('重新自检', start.call_args.args[2][0])
        save.assert_called_once()
        self.assertFalse(self.file.exists())

    def test_first_connection_saves_only_after_worker_ready(self):
        result, select, start, save = self.run_main(None, ['success'])
        self.assertEqual(result, 0)
        select.assert_called_once()
        save.assert_called_once()
        result, _, _, save = self.run_main(None, [RuntimeError('worker import failed')])
        self.assertEqual(result, 1)
        save.assert_not_called()

    def test_worker_crash_before_ready_is_detected(self):
        root = Path(self.temporary.name)
        (root/'worker.py').write_text('raise SystemExit(7)\n', encoding='utf-8')
        with patch.object(launcher, 'ROOT', root):
            with self.assertRaisesRegex(RuntimeError, '7'):
                launcher.start_worker(self.python, self.info, [])

    def test_worker_receives_queued_protocol_request_and_eof(self):
        root = Path(self.temporary.name)
        (root/'worker.py').write_text(
            'import os, pathlib, sys\n'
            'pathlib.Path(os.environ["FEM_ML_READY_FILE"]).write_text("{}")\n'
            'for line in sys.stdin: print(line.strip(), flush=True)\n', encoding='utf-8')
        script = (
            'import runtime_launcher as launcher\n'
            'from pathlib import Path\n'
            'import sys\n'
            'launcher.ROOT = Path(sys.argv[1])\n'
            'child, _ = launcher.start_worker(Path(sys.executable), {"backend": "cpu"}, [])\n'
            'raise SystemExit(child.wait())\n')
        result = subprocess.run([str(self.python), '-c', script, str(root)],
            cwd=launcher.ROOT, input='{"id":1,"command":"status"}\n',
            capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'id': 1, 'command': 'status'})

    def test_worker_ready_and_timeout_cleanup(self):
        root = Path(self.temporary.name)
        (root/'worker.py').write_text(
            'import os, pathlib, time\n'
            'pathlib.Path(os.environ["FEM_ML_READY_FILE"]).write_text("{}")\n'
            'time.sleep(30)\n', encoding='utf-8')
        with patch.object(launcher, 'ROOT', root):
            child, report = launcher.start_worker(self.python, self.info, [])
            try:
                self.assertEqual(report, {})
                self.assertIsNone(child.poll())
            finally:
                child.kill()
                child.wait()
        (root/'worker.py').write_text('import time; time.sleep(30)\n', encoding='utf-8')
        popen = subprocess.Popen
        children = []
        def tracked(*args, **kwargs):
            child = popen(*args, **kwargs)
            children.append(child)
            return child
        with patch.object(launcher, 'ROOT', root), \
             patch.object(launcher.subprocess, 'Popen', side_effect=tracked), \
             patch.object(launcher.time, 'monotonic', side_effect=[0, 100]):
            with self.assertRaises(TimeoutError):
                launcher.start_worker(self.python, self.info, [])
        self.assertIsNotNone(children[0].poll())


if __name__ == '__main__':
    unittest.main()
