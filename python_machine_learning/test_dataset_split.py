"""Reassign existing datasets without rebuilding labels or mutating old models."""
import copy
import hashlib
import json
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

import test_dataset_management
from worker import atomic_json


class DatasetSplitTests(unittest.TestCase):
    def setup_service(self, temporary):
        helper=test_dataset_management.DatasetManagementTests()
        service=helper.service(temporary)
        run=helper.seed(service)
        helper.reference(service)
        service.release_run()
        original=service.store/'datasets'/('a'*32)
        for identifier,group in [('b'*32,'square'),('c'*32,'other')]:
            directory=service.store/'datasets'/identifier
            shutil.copytree(original,directory)
            metadata=json.loads((directory/'metadata.json').read_text(encoding='utf-8'))
            metadata.update(id=identifier,group=group)
            atomic_json(directory/'metadata.json',metadata)
        return service,run

    def test_reassignment_moves_whole_geometry_group_and_preserves_graphs_and_checkpoints(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run=self.setup_service(temporary)
            paths=[p for p in service.store.rglob('*') if p.is_file() and p.name!='metadata.json' and p.suffix!='.lock']
            before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
            result=service.dispatch('change-dataset-split',{'datasetIds':['a'*32],'split':'validation'})
            self.assertEqual(set(result['updatedIds']),{'a'*32,'b'*32})
            self.assertEqual(result['groupedCount'],1)
            self.assertEqual({r['id']:r['split'] for r in service.records('datasets')},
                {'a'*32:'validation','b'*32:'validation','c'*32:'train'})
            self.assertEqual(before,{p:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})
            result=service.datasets.change_split({'datasetIds':['a'*32,'c'*32],'split':'train'})
            self.assertEqual(len(result['updatedIds']),2)
            self.assertTrue(all(r['split']=='train' for r in service.records('datasets')))
            self.assertEqual(service.datasets.change_split({'datasetIds':['a'*32],'split':'train'})['updatedIds'],[])

    def test_invalid_requests_and_mid_group_write_failure_do_not_partially_change_split(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,_=self.setup_service(temporary)
            for payload in [{'datasetIds':['a'*32],'split':'bad'},
                            {'datasetIds':['a'*32,'d'*32],'split':'validation'},
                            {'datasetIds':['../escape'],'split':'validation'}]:
                with self.assertRaises(ValueError): service.datasets.change_split(payload)
            def failing(file,value):
                if file.parent.name=='b'*32 and value['split']=='validation': raise OSError('write blocked')
                atomic_json(file,value)
            with patch('worker.atomic_json',side_effect=failing):
                with self.assertRaisesRegex(OSError,'write blocked'):
                    service.datasets.change_split({'datasetIds':['a'*32],'split':'validation'})
            self.assertTrue(all(r['split']=='train' for r in service.records('datasets')))

    def test_active_training_and_other_instance_locks_block_reassignment(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run=self.setup_service(temporary)
            payload={'datasetIds':['a'*32],'split':'validation'}
            stop=threading.Event();service.thread=threading.Thread(target=stop.wait);service.thread.start()
            try:
                with self.assertRaisesRegex(ValueError,'暂停'): service.datasets.change_split(payload)
            finally: stop.set();service.thread.join()
            other=test_dataset_management.DatasetManagementTests().service(temporary);other.acquire_run(run)
            try:
                with self.assertRaisesRegex(ValueError,'另一程序实例'): service.datasets.change_split(payload)
            finally: other.release_run()

    def test_resume_reconciles_splits_without_selected_ids_and_removes_validation_from_pending_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run=self.setup_service(temporary)
            # Give the middle sample a separate geometry and original holdout role.
            file=service.store/'datasets'/('b'*32)/'metadata.json'
            metadata=json.loads(file.read_text(encoding='utf-8'));metadata.update(group='second',split='validation')
            atomic_json(file,metadata)
            service.state.update(trainIds=['a'*32,'c'*32],validationIds=['b'*32],
                order=['a'*32+':0','c'*32+':0','a'*32+':1','c'*32+':1'],cursor=1,
                bestValidationLoss=.01,validationLoss=.01,bestCheckpointFile=service.state['checkpointFile'])
            service.load_graphs();service.save()
            checkpoint=copy.deepcopy(service.load_checkpoint(run)['state'])
            service.datasets.change_split({'datasetIds':['a'*32],'split':'validation'})
            service.datasets.change_split({'datasetIds':['b'*32],'split':'train'})
            self.assertEqual(service.load_checkpoint(run)['state'],checkpoint)
            service.resume({'runId':run})
            try:
                self.assertEqual(set(service.state['trainIds']),{'b'*32,'c'*32})
                self.assertEqual(service.state['validationIds'],['a'*32])
                self.assertEqual(service.state['order'],['c'*32+':0','c'*32+':1'])
                self.assertEqual(service.state['cursor'],0)
                self.assertIsNone(service.state['bestValidationLoss'])
                self.assertIsNone(service.state['bestCheckpointFile'])
            finally: service.release_run()


if __name__=='__main__': unittest.main()
