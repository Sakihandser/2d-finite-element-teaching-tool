"""Management operations use disposable stores, never the user's trained models."""
import hashlib
import json
import stat
from pathlib import Path
import tempfile
import unittest
import zipfile

import torch

import test_training
from worker import atomic_json


class ManagementTests(unittest.TestCase):
    service = test_training.TrainingTests.service
    seed = test_training.TrainingTests.seed

    def test_rename_survives_checkpoint_restore_and_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service)
            service.manager.rename({'runId':run, 'name':'renamed model'})
            service.restore(run)
            self.assertEqual(service.state['name'], 'renamed model')
            service.resume({'runId':run})
            self.assertEqual(service.manager.metadata(service.store/'runs'/run)['name'], 'renamed model')
            service.release_run()

    def test_selected_checkpoint_creates_branch_without_changing_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service)
            first = service.state['checkpointFile']
            service.train()
            directory = service.store/'runs'/run
            before = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.suffix != '.lock'}
            result = service.resume({'runId':run, 'checkpointFile':first})
            self.assertNotEqual(result['id'],run)
            self.assertEqual(service.state['step'],0)
            self.assertEqual(service.state['parentRunId'],run)
            self.assertEqual(service.state['parentCheckpoint'],first)
            after = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.suffix != '.lock'}
            self.assertEqual(before,after)
            service.train()
            self.assertEqual(service.state['step'],8)
            self.assertEqual(service.load_checkpoint(run)['state']['step'],8)

    def test_checkpoint_delete_repairs_latest_and_protects_last_valid_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service)
            original = service.state['checkpointFile']
            service.state['step']=2; service.save()
            newest = service.state['checkpointFile']
            result = service.manager.delete_checkpoint({'runId':run, 'checkpointFile':newest})
            self.assertTrue(result['deleted'])
            self.assertFalse((service.store/'runs'/run/newest).exists())
            self.assertFalse((service.store/'trash').exists())
            self.assertIsNone(service.state)
            rows = service.manager.checkpoints(run)['checkpoints']
            self.assertEqual(len(rows),1)
            self.assertTrue(rows[0]['latest'])
            self.assertEqual(rows[0]['file'],original)
            self.assertEqual(service.manager.metadata(service.store/'runs'/run)['step'],0)
            with self.assertRaisesRegex(ValueError,'最后一个'):
                service.manager.delete_checkpoint({'runId':run, 'checkpointFile':original})
            service.restore(run)
            self.assertEqual(service.state['step'],0)

    def test_delete_model_physically_removes_directory_but_preserves_shared_samples(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service)
            checkpoint = service.state['checkpointFile']
            result = service.manager.delete_model({'runId':run})
            self.assertTrue(result['deleted'])
            self.assertFalse((service.store/'runs'/run).exists())
            self.assertFalse((service.store/'trash').exists())
            self.assertTrue((service.store/'datasets'/('a'*32)/'graphs.pt').is_file())
            self.assertEqual(service.records('runs'),[])
            self.assertIsNone(service.state)
            with self.assertRaisesRegex(ValueError,'不存在'): service.acquire_run(run)

    def test_deleted_best_checkpoint_is_not_restored_as_a_dangling_pointer(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service)
            service.state['bestValidationLoss']=.1
            service.save(best=True)
            best = service.state['bestCheckpointFile']
            service.state['step']=2; service.save()
            service.manager.delete_checkpoint({'runId':run,'checkpointFile':best})
            service.restore(run)
            self.assertIsNone(service.state['bestCheckpointFile'])
            self.assertIsNone(service.state['bestValidationLoss'])

    def test_editing_respects_training_and_other_process_locks(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = self.service(temporary); run = self.seed(first)
            second = self.service(temporary)
            first.acquire_run(run)
            try:
                for operation in [second.manager.rename,second.manager.delete_model,second.manager.export_model]:
                    with self.assertRaisesRegex(ValueError,'另一程序实例'):
                        operation({'runId':run,'name':'blocked'})
            finally: first.release_run()
            second.thread=type('Busy', (), {'is_alive':lambda self:True})()
            with self.assertRaisesRegex(ValueError,'暂停'):
                second.manager.delete_model({'runId':run})

    def test_cleanup_removes_only_requested_temporary_data_and_old_orphans(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary); run=self.seed(service)
            directory=service.store/'runs'/run
            before={p.name:p.read_bytes() for p in directory.iterdir()}
            for category,filename in [('exports','c'*32+'.zip'),('predictions','d'*32+'.json')]:
                path=service.store/category/filename; path.parent.mkdir(exist_ok=True); path.write_bytes(b'cache')
            # Unknown files and user-created folders are outside the cleanup scope.
            (service.store/'exports'/'notes.txt').write_text('keep')
            orphan=service.store/'runs'/('b'*32); orphan.mkdir(); (orphan/'training.lock').write_bytes(b'0')
            trash=service.store/'trash'/('model-'+'b'*32+'-'+'e'*32)
            trash.mkdir(parents=True); (trash/'old.pt').write_bytes(b'old weights')
            summary=service.manager.storage_summary()
            self.assertEqual(summary['exports'],{'count':1,'bytes':5})
            self.assertEqual(summary['legacy-deleted']['count'],2)
            self.assertEqual(service.manager.clean_storage({'kind':'exports'})['deleted'],1)
            self.assertTrue((service.store/'predictions'/('d'*32+'.json')).exists())
            service.manager.clean_storage({'kind':'predictions'})
            service.manager.clean_storage({'kind':'legacy-deleted'})
            self.assertFalse(orphan.exists()); self.assertFalse(trash.exists())
            self.assertTrue((service.store/'exports'/'notes.txt').is_file())
            self.assertTrue((service.store/'datasets'/('a'*32)/'graphs.pt').is_file())
            self.assertEqual(before,{p.name:p.read_bytes() for p in directory.iterdir()})
            for invalid in ['runs','datasets','../runs',None]:
                with self.assertRaises(ValueError): service.manager.clean_storage({'kind':invalid})

    def test_cleanup_cannot_remove_orphan_locked_by_another_instance(self):
        with tempfile.TemporaryDirectory() as temporary:
            first=self.service(temporary); run=self.seed(first)
            first.acquire_run(run)
            (first.store/'runs'/run/'metadata.json').unlink()
            (first.store/'runs'/run/'checkpoint-metadata.json').unlink()
            for path in (first.store/'runs'/run).glob('*.pt'): path.unlink()
            second=self.service(temporary)
            try:
                with self.assertRaisesRegex(ValueError,'另一程序实例'):
                    second.manager.clean_storage({'kind':'legacy-deleted'})
                self.assertTrue((first.store/'runs'/run).is_dir())
            finally: first.release_run()

    def test_read_only_directories_and_cached_files_can_be_deleted(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary); run=self.seed(service)
            directory=service.store/'runs'/run
            for path in directory.iterdir(): path.chmod(stat.S_IREAD)
            directory.chmod(stat.S_IREAD)
            service.manager.delete_model({'runId':run})
            self.assertFalse(directory.exists())
            exports=service.store/'exports'; exports.mkdir()
            cached=exports/('f'*32+'.zip'); cached.write_bytes(b'export'); cached.chmod(stat.S_IREAD)
            service.manager.clean_storage({'kind':'exports'})
            self.assertFalse(cached.exists())

    def test_package_roundtrip_transfers_samples_checkpoints_and_optimizer(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = self.service(Path(temporary)/'first'); run = self.seed(first)
            first.train()
            first.manager.rename({'runId':run,'name':'portable'})
            result = first.manager.export_model({'runId':run})
            archive = first.store/'exports'/(result['downloadUrl'].split('/')[-1]+'.zip')
            second = self.service(Path(temporary)/'second')
            imported = second.manager.import_model({'path':str(archive)})
            self.assertNotEqual(imported['id'],run)
            self.assertEqual(imported['name'],'portable')
            self.assertEqual(len(second.manager.checkpoints(imported['id'])['checkpoints']),2)
            second.restore(imported['id'])
            self.assertEqual(second.state['step'],8)
            self.assertEqual(second.state['name'],'portable')
            for actual,expected in zip(second.model.parameters(),first.model.parameters()):
                torch.testing.assert_close(actual,expected,rtol=0,atol=0)
            self.assertEqual(second.optimizer.state_dict()['param_groups'],first.optimizer.state_dict()['param_groups'])
            second.launch=lambda:None
            second.resume({'runId':imported['id'],'additionalEpochs':1})
            second.train()
            self.assertEqual(second.state['step'],10)

    def test_pt_import_requires_samples_and_never_overwrites_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = self.service(Path(temporary)/'first'); run = self.seed(first)
            checkpoint = first.store/'runs'/run/first.state['checkpointFile']
            second = self.service(Path(temporary)/'second')
            with self.assertRaisesRegex(ValueError,'缺少训练样本'):
                second.manager.import_model({'path':str(checkpoint)})
            self.assertEqual(second.records('runs'),[])
            result = first.manager.import_model({'path':str(checkpoint)})
            self.assertNotEqual(result['id'],run)
            self.assertEqual(len(first.records('runs')),2)

    def test_package_rejects_traversal_and_sample_conflicts_without_partial_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service)
            result = service.manager.export_model({'runId':run})
            archive = service.store/'exports'/(result['downloadUrl'].split('/')[-1]+'.zip')
            bad = Path(temporary)/'bad.zip'
            with zipfile.ZipFile(archive) as original, zipfile.ZipFile(bad,'w') as output:
                for entry in original.infolist(): output.writestr(entry,original.read(entry))
                output.writestr('../escaped.txt','no')
            with self.assertRaisesRegex(ValueError,'无效路径'):
                service.manager.import_model({'path':str(bad)})
            self.assertFalse((Path(temporary)/'escaped.txt').exists())
            metadata = service.store/'datasets'/('a'*32)/'metadata.json'
            changed = json.loads(metadata.read_text()); changed['group']='different'
            atomic_json(metadata,changed)
            with self.assertRaisesRegex(ValueError,'编号冲突'):
                service.manager.import_model({'path':str(archive)})
            self.assertEqual(len(service.records('runs')),1)
            for invalid in ['../latest.pt','C:/latest.pt','checkpoint-1.pt']:
                with self.assertRaises(ValueError):
                    service.manager.delete_checkpoint({'runId':run,'checkpointFile':invalid})


if __name__ == '__main__': unittest.main()
