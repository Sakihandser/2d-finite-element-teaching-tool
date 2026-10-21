"""Backend ordering, fallback and portable checkpoint regression tests."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch

from device_runtime import cpu_tensors, select_device, training_probe
from runtime_launcher import select_runtime
from worker import TrainingService
import test_training


class RuntimeTests(unittest.TestCase):
    def test_all_gpu_builds_are_tried_before_cpu(self):
        paths = [Path('/app/.venv/Scripts/python.exe'), Path('/app/.venv-directml/Scripts/python.exe'),
                 Path('/app/.venv-cpu/Scripts/python.exe')]
        calls = []
        def probe(python, backend):
            calls.append((python, backend))
            if backend == 'directml' and '.venv-directml' in python.parts:
                return {'status':'PASS','backend':backend,'deviceName':'AMD fixture'}
            if backend == 'cpu':
                return {'status':'PASS','backend':backend,'deviceName':'CPU'}
            raise RuntimeError('GPU driver not available')
        python, info, diagnostics = select_runtime(paths, probe_fn=probe)
        self.assertEqual(info['backend'], 'directml')
        self.assertEqual(python, paths[1])
        self.assertFalse(any(backend == 'cpu' for _, backend in calls))
        self.assertTrue(diagnostics)

    def test_broken_or_crashed_gpu_probes_fall_back_to_dedicated_cpu(self):
        paths = [Path('/app/.venv/Scripts/python.exe'), Path('/app/.venv-cpu/Scripts/python.exe')]
        def probe(python, backend):
            if backend != 'cpu': raise RuntimeError('unsupported graph backward operator')
            return {'status':'PASS','backend':'cpu'}
        python, info, diagnostics = select_runtime(paths, probe_fn=probe)
        self.assertEqual(python, paths[1])
        self.assertEqual(info['backend'], 'cpu')
        self.assertTrue(diagnostics)

    def test_explicit_gpu_never_silently_uses_cpu(self):
        with self.assertRaisesRegex(RuntimeError, '没有可用'):
            select_runtime([Path('/app/python')], 'cuda',
                probe_fn=lambda *args: (_ for _ in ()).throw(RuntimeError('no CUDA')))

    def test_unsupported_first_adapter_does_not_hide_second(self):
        select_device.cache_clear()
        with patch('device_runtime.device_count', return_value=2), \
             patch('device_runtime.backend_device', side_effect=[RuntimeError('bad adapter'), (torch.device('cpu'),'second GPU')]), \
             patch('device_runtime.training_probe'):
            _, info = select_device('directml')
            self.assertEqual(info['deviceIndex'],1)
        select_device.cache_clear()

    def test_cpu_graph_training_and_resume_probe(self):
        training_probe(torch.device('cpu'))

    def test_cpu_default_start_and_saved_tensor_portability(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {'FEM_ML_DEVICE':'cpu'}):
            service = TrainingService(temporary)
            self.assertEqual(service.status()['environment']['backend'], 'cpu')
            test_training.TrainingTests().seed(service)
            checkpoint = service.load_checkpoint(service.state['id'])
            self.assertTrue(all(value.device.type == 'cpu' for value in checkpoint['network'].values()))
            service.train()
            self.assertEqual(service.state['status'], 'completed')
            restored = TrainingService(temporary)
            restored.restore(service.state['id'])
            self.assertEqual(restored.state['step'],8)
            restored.shutdown()

    def test_nested_optimizer_tensors_are_copied_to_cpu(self):
        value = {'optimizer': [{'moment': torch.ones(2, requires_grad=True)}]}
        portable = cpu_tensors(value)
        self.assertEqual(portable['optimizer'][0]['moment'].device.type, 'cpu')
        self.assertFalse(portable['optimizer'][0]['moment'].requires_grad)


if __name__ == '__main__': unittest.main()
