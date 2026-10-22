"""Two-step checkpoint recovery and failures with deleted historical datasets."""
import copy
import hashlib
from pathlib import Path
import shutil
import tempfile
import unittest

import torch

import test_training
from worker import atomic_json


class CheckpointRestoreTests(unittest.TestCase):
    service = test_training.TrainingTests.service
    seed = test_training.TrainingTests.seed

    def setup_case(self, temporary):
        service=self.service(temporary);run=self.seed(service)
        first=service.state['checkpointFile']
        service.train()
        old=service.store/'datasets'/('a'*32)
        for letter,split in [('b','train'),('c','validation'),('d','train')]:
            directory=service.store/'datasets'/(letter*32)
            shutil.copytree(old,directory)
            atomic_json(directory/'metadata.json',{'id':letter*32,'name':letter,'split':split,'group':letter})
        shutil.rmtree(old)
        return service,run,first

    def digests(self, directory):
        return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.suffix!='.lock'}

    def test_restore_without_old_data_waits_then_trains_only_current_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run,first=self.setup_case(temporary)
            before=self.digests(service.store/'runs'/run)
            expected=service.load_checkpoint(run,first)['network']
            calls=[];service.launch=lambda:calls.append(True)
            result=service.dispatch('restore-checkpoint',{'runId':run,'checkpointFile':first})
            branch=result['id']
            self.assertNotEqual(branch,run)
            self.assertEqual(service.state['status'],'ready')
            self.assertTrue(service.state['dataSelectionPending'])
            self.assertEqual(service.state['step'],0)
            self.assertEqual(service.state['trainIds'],[])
            self.assertEqual(service.graphs,{})
            self.assertEqual(calls,[])
            self.assertFalse(service.busy())
            self.assertIsNone(service.run_lock)
            self.assertFalse(service.optimizer.state)
            for key,value in service.model.state_dict().items():
                torch.testing.assert_close(value,expected[key],rtol=0,atol=0)
            service.resume({'runId':branch,'datasetIds':['b'*32,'c'*32],'additionalEpochs':2})
            self.assertEqual(service.state['trainIds'],['b'*32])
            self.assertEqual(service.state['validationIds'],['c'*32])
            self.assertEqual(service.state['config']['epochs'],2)
            self.assertEqual(len(calls),1)
            service.train()
            self.assertEqual(service.state['step'],4)
            self.assertEqual(service.state['seenIds'],['b'*32])
            self.assertFalse(any(key.startswith('d'*32) for key in service.graphs))
            self.assertTrue(any(not torch.equal(value,expected[key]) for key,value in service.model.state_dict().items()))
            self.assertEqual(self.digests(service.store/'runs'/run),before)

    def test_ready_weights_survive_restart_and_package_roundtrip_without_old_samples(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run,first=self.setup_case(Path(temporary)/'source')
            result=service.restore_checkpoint({'runId':run,'checkpointFile':first})
            branch=result['id']
            reconnected=self.service(service.store)
            self.assertEqual(next(r for r in reconnected.records('runs') if r['id']==branch)['status'],'ready')
            exported=reconnected.manager.export_model({'runId':branch})
            package=reconnected.store/'exports'/(exported['downloadUrl'].split('/')[-1]+'.zip')
            target=self.service(Path(temporary)/'target')
            imported=target.manager.import_model({'path':str(package)})
            saved=target.load_checkpoint(imported['id'])
            self.assertTrue(saved['state']['dataSelectionPending'])
            self.assertEqual(saved['state']['status'],'ready')
            self.assertEqual(saved['state']['trainIds'],[])
            # Restoration is persistent; it does not depend on the source record
            # or an in-memory pending checkpoint when new data is selected later.
            shutil.copytree(service.store/'datasets'/('b'*32),target.store/'datasets'/('b'*32))
            target.launch=lambda:None
            try:
                target.resume({'runId':imported['id'],'datasetIds':['b'*32],'additionalEpochs':1})
                target.train()
                self.assertEqual(target.state['epoch'],1)
            finally:target.release_run()

    def test_failed_resume_restores_idle_state_weights_rng_and_releases_locks(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run,first=self.setup_case(temporary)
            before=copy.deepcopy(service.state);model=service.model;optimizer=service.optimizer
            random_before=torch.get_rng_state().clone()
            # The saved first checkpoint says starting and references deleted
            # data. Previously this failure left the dashboard permanently busy.
            with self.assertRaisesRegex(ValueError,'已删除或缺失'):
                service.resume({'runId':run,'checkpointFile':first})
            self.assertEqual(service.state,before)
            self.assertIs(service.model,model)
            self.assertIs(service.optimizer,optimizer)
            torch.testing.assert_close(torch.get_rng_state(),random_before,rtol=0,atol=0)
            self.assertFalse(service.busy());self.assertIsNone(service.run_lock)
            other=self.service(temporary)
            other.acquire_run(run);other.release_run()
            self.assertEqual(service.status()['current']['status'],'completed')

    def test_missing_corrupt_or_empty_selected_data_can_be_corrected_and_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run,first=self.setup_case(temporary)
            branch=service.restore_checkpoint({'runId':run,'checkpointFile':first})['id']
            before=copy.deepcopy(service.state)
            file=service.store/'datasets'/('b'*32)/'graphs.pt';contents=file.read_bytes()
            for invalid in ['unselected','missing-graph','corrupt-graph','empty-graphs','invalid-epochs']:
                file.write_bytes(contents)
                payload={'runId':branch,'datasetIds':['b'*32],'additionalEpochs':1}
                if invalid=='unselected':payload['datasetIds']=[]
                elif invalid=='missing-graph':file.unlink()
                elif invalid=='corrupt-graph':file.write_bytes(b'not a torch graph')
                elif invalid=='empty-graphs':torch.save({'version':test_training.FEATURE_VERSION,'graphs':[]},file)
                else:payload['additionalEpochs']=0
                with self.subTest(invalid=invalid),self.assertRaises(Exception):service.resume(payload)
                self.assertEqual(service.state,before)
                self.assertFalse(service.busy());self.assertIsNone(service.run_lock)
                self.assertEqual(service.status()['current']['status'],'ready')
            file.write_bytes(contents)
            service.resume({'runId':branch,'datasetIds':['b'*32],'additionalEpochs':1})
            service.train()
            self.assertEqual(service.state['epoch'],1)

    def test_regular_resume_can_replace_deleted_old_samples_without_restoring_weights_first(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run,_=self.setup_case(temporary)
            service.resume({'runId':run,'datasetIds':['b'*32],'additionalEpochs':1})
            service.train()
            self.assertEqual(service.state['trainIds'],['b'*32])
            self.assertEqual(service.state['epoch'],5)

    def test_legacy_missing_geometry_history_is_not_claimed_as_independent_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run,_=self.setup_case(temporary)
            # Simulate an old checkpoint whose learned sample metadata has gone.
            service.state.pop('learnedGroups',None);service.save()
            branch=service.restore_checkpoint({'runId':run,'checkpointFile':service.state['checkpointFile']})['id']
            self.assertTrue(service.state['trainingHistoryIncomplete'])
            service.resume({'runId':branch,'datasetIds':['b'*32,'c'*32],'additionalEpochs':1})
            service.train()
            self.assertEqual(service.state['diagnostics']['validationIntegrity'],'unknown')
            self.assertFalse(service.state['diagnostics']['earlyStoppingEnabled'])


if __name__=='__main__':unittest.main()
