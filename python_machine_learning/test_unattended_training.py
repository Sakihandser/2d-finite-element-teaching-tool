"""Fault injection for unattended recovery and bounded dataset memory."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace

import torch
import worker
from graph_data import FEATURE_VERSION
from graph_store import GraphStore,tensor_bytes
import test_training as fixtures
from unattended_runtime import keep_awake


class UnattendedTests(unittest.TestCase):
    def seed(self,path):
        service=fixtures.TrainingTests().service(path)
        run=fixtures.TrainingTests().seed(service)
        return service,run

    def test_graph_store_loads_only_requested_cases_with_bounded_lru(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);graphs=[{'x':torch.ones(8,23)} for _ in range(2)]
            for name in ['a','b']:
                (root/name).mkdir();torch.save({'version':FEATURE_VERSION,'graphs':graphs},root/name/'graphs.pt')
            with patch('graph_store.torch.load',wraps=torch.load) as read:
                store=GraphStore(root,['a','b'],{'a':{'variants':2},'b':{'variants':2}},limit=tensor_bytes(graphs))
                self.assertEqual(read.call_count,0)
                self.assertEqual(len(store),4)
                store['a:0'];store['a:1'];self.assertEqual(read.call_count,1)
                store['b:0'];self.assertEqual(list(store.cache),['b'])
                self.assertLessEqual(store.cached_bytes,store.limit)
                store['a:0'];self.assertEqual(read.call_count,3)
                store.discard(['a']);self.assertNotIn('a:0',store);self.assertEqual(store.cached_bytes,0)

    def test_transient_storage_retry_is_bounded_and_does_not_swallow_other_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,_=self.seed(tmp)
            with patch.object(service.stop,'wait') as wait:
                operation=Mock(side_effect=[PermissionError('busy'),PermissionError('busy'),42])
                self.assertEqual(service.storage_operation(operation),42)
                self.assertEqual(wait.call_count,2)
                operation=Mock(side_effect=OSError('disk full'))
                with self.assertRaises(OSError):service.storage_operation(operation)
                self.assertEqual(operation.call_count,3)
                operation=Mock(side_effect=ValueError('invalid data'))
                with self.assertRaises(ValueError):service.storage_operation(operation)
                self.assertEqual(operation.call_count,1)

    def test_nonfinite_failure_restores_checkpoint_reduces_rate_and_completes(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,run=self.seed(tmp);loss=worker.sizing_loss
            calls=0
            def fail_once(*args):
                nonlocal calls
                calls+=1
                if calls==2:raise ValueError('non-finite loss injected')
                return loss(*args)
            with patch('worker.sizing_loss',side_effect=fail_once),patch('worker.traceback.print_exc'):
                service.train()
            self.assertEqual(service.state['status'],'completed')
            self.assertEqual(service.state['runtimeRecoveryAttempts'],1)
            self.assertEqual(service.state['runtimeRecoveries'][0]['restoredStep'],0)
            self.assertEqual(service.state['step'],8)
            self.assertEqual(service.optimizer.param_groups[0]['lr'],.00025)
            self.assertFalse(service.state['sleepPrevented'])

    def test_cuda_oom_can_fall_back_to_cpu_once_with_persisted_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,run=self.seed(tmp)
            service.device=torch.device('cuda')
            with patch('worker.torch.cuda.empty_cache'):
                self.assertTrue(service.recover_runtime(torch.cuda.OutOfMemoryError('injected')))
            self.assertEqual(service.device.type,'cpu')
            self.assertEqual(service.device_info['backend'],'cpu')
            self.assertTrue(service.state['runtimeCpuFallback'])
            self.assertEqual(service.state['runtimeRecoveryAttempts'],1)
            self.assertFalse(service.recover_runtime(torch.cuda.OutOfMemoryError('injected again')))
            restored=fixtures.TrainingTests().service(tmp)
            restored.device=torch.device('cuda');restored.restore(run)
            self.assertEqual(restored.state['runtimeRecoveryAttempts'],1)
            self.assertEqual(restored.device.type,'cpu')

    def test_persistent_nonfinite_error_stops_after_two_recoveries(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,_=self.seed(tmp)
            with patch('worker.sizing_loss',side_effect=ValueError('non-finite loss')), \
                 patch('worker.traceback.print_exc'):
                service.train()
            self.assertEqual(service.state['status'],'failed')
            self.assertEqual(service.state['runtimeRecoveryAttempts'],2)

    def test_windows_sleep_request_is_scoped_and_cleared_on_exception(self):
        setter=Mock(return_value=1);statuses=[]
        windll=SimpleNamespace(kernel32=SimpleNamespace(SetThreadExecutionState=setter))
        with patch('unattended_runtime.os.name','nt'),patch('ctypes.windll',windll,create=True):
            with self.assertRaisesRegex(ValueError,'interrupt'):
                with keep_awake(True,statuses.append):raise ValueError('interrupt')
        self.assertEqual([call.args[0] for call in setter.call_args_list],[0x80000001,0x80000000])
        self.assertEqual(statuses,[True,False])
