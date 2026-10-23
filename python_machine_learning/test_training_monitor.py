"""Label-direction metrics, geometry balance and restartable adaptive control."""
import copy
import math
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
import test_training
from model import sizing_metrics
from training_monitor import aggregate_metrics, update_monitor
from worker import atomic_json


def metrics(loss=.1,baseline=1.):
    return {'loss':loss,'baselineLoss':baseline,'logMae':loss,'sizeFactor':math.exp(loss),
        'logBias':0.,'coarserFraction':0.,'finerFraction':0.}


class MonitorTests(unittest.TestCase):
    def test_direction_and_baseline_are_label_metrics_not_physical_quality(self):
        graph=test_training.build_graph(test_training.grid(2),test_training.GEOMETRY,test_training.grid(4),.05)
        exact=sizing_metrics(graph['y'],graph)
        coarse=sizing_metrics(graph['y']+math.log(2),graph)
        fine=sizing_metrics(graph['y']-math.log(2),graph)
        self.assertEqual(exact['loss'],0)
        self.assertAlmostEqual(coarse['coarserFraction'],1,places=5)
        self.assertAlmostEqual(fine['finerFraction'],1,places=5)
        self.assertAlmostEqual(coarse['sizeFactor'],2,places=5)
        self.assertAlmostEqual(coarse['logBias'],-fine['logBias'],places=5)
        self.assertGreater(exact['baselineLoss'],0)
        self.assertAlmostEqual(coarse['loss'],fine['loss'],places=5)

    def test_geometry_macro_average_does_not_overweight_many_load_cases_or_variants(self):
        rows=[('a',f'a{i}',metrics(1)) for i in range(5)]+[('b','b',metrics(9))]
        rows += [('a','a0',metrics(1))]*4
        result=aggregate_metrics(rows)
        self.assertEqual(result['loss'],5)
        self.assertEqual(result['groups'],2)
        self.assertEqual(result['cases'],6)
        self.assertEqual(result['worstCases'][0]['id'],'b')

    def controller(self):
        optimizer=torch.optim.AdamW([torch.nn.Parameter(torch.zeros(1))],lr=.01)
        scheduler=torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer,patience=1,factor=.5)
        state={'config':{'adaptiveTraining':True,'lrPatience':1,'earlyStoppingPatience':3},'epoch':0}
        return state,optimizer,scheduler

    def test_constant_size_collapse_has_a_separate_diagnosis(self):
        state,optimizer,scheduler=self.controller();state['epoch']=6
        training={**metrics(.3),'groups':4,'residualStd':1e-7,'targetResidualStd':.4}
        update_monitor(state,optimizer,scheduler,training,{**metrics(.3),'groups':3},'independent')
        self.assertEqual(state['diagnostics']['code'],'constant-size-collapse')

    def test_plateau_reduces_learning_rate_before_early_stopping(self):
        state,optimizer,scheduler=self.controller()
        stop=False
        for epoch in range(1,11):
            state['epoch']=epoch
            stop,_=update_monitor(state,optimizer,scheduler,{**metrics(.1),'groups':4},{**metrics(1),'groups':2},'independent')
            if epoch<10:self.assertFalse(stop)
        self.assertTrue(stop)
        self.assertLess(optimizer.param_groups[0]['lr'],.01)
        self.assertTrue(state['diagnostics']['smallValidation'])

    def test_no_independent_holdout_never_triggers_early_stop(self):
        for integrity in ['none','previously-trained']:
            state,optimizer,scheduler=self.controller()
            for epoch in range(1,30):
                state['epoch']=epoch
                stop,_=update_monitor(state,optimizer,scheduler,{**metrics(.1),'groups':2},
                    {**metrics(1),'groups':1} if integrity!='none' else None,integrity)
                self.assertFalse(stop)
            self.assertFalse(state['diagnostics']['earlyStoppingEnabled'])

    def test_exact_labels_with_zero_baseline_are_not_reported_as_underfitting(self):
        state,optimizer,scheduler=self.controller();state['epoch']=6
        update_monitor(state,optimizer,scheduler,{**metrics(0,0),'groups':4},{**metrics(0,0),'groups':3},'independent')
        self.assertEqual(state['diagnostics']['code'],'learning')

    def service(self,directory):
        service=test_training.TrainingTests().service(directory)
        return service

    def seed(self,directory):
        service=self.service(directory)
        run=test_training.TrainingTests().seed(service)
        service.release_run()
        original=service.store/'datasets'/('a'*32)
        validation=service.store/'datasets'/('b'*32)
        shutil.copytree(original,validation)
        atomic_json(validation/'metadata.json',{'id':'b'*32,'name':'holdout','split':'validation','group':'other'})
        service.state['validationIds']=['b'*32]
        service.state['config'].update(epochs=12,lrPatience=1,earlyStoppingPatience=0,automaticRecovery=False)
        service.load_graphs();service.setup_scheduler();service.save()
        return service,run

    def constant_evaluation(self,service):
        return patch.object(service,'evaluate_split',side_effect=lambda ids:{**metrics(.1 if ids==service.state['trainIds'] else 1.),'groups':1,'cases':1,'graphs':2})

    def test_scheduler_and_optimizer_resume_exactly_after_mid_epoch_pause(self):
        with tempfile.TemporaryDirectory() as temporary:
            seed,run=self.seed(Path(temporary)/'seed')
            continuous_path=Path(temporary)/'continuous';resumed_path=Path(temporary)/'resumed'
            shutil.copytree(seed.store,continuous_path);shutil.copytree(seed.store,resumed_path)
            continuous=self.service(continuous_path);continuous.restore(run)
            with self.constant_evaluation(continuous):continuous.train()
            paused=self.service(resumed_path);paused.restore(run)
            step=paused.optimizer.step
            def interrupt(*args,**kwargs):
                result=step(*args,**kwargs)
                if paused.state['step']==7:paused.stop.set()
                return result
            paused.optimizer.step=interrupt
            with self.constant_evaluation(paused):paused.train()
            self.assertLess(paused.optimizer.param_groups[0]['lr'],.001)
            resumed=self.service(resumed_path);resumed.restore(run)
            with self.constant_evaluation(resumed):resumed.train()
            self.assertEqual(continuous.scheduler.state_dict(),resumed.scheduler.state_dict())
            self.assertEqual(continuous.state['monitor'],resumed.state['monitor'])
            for key,value in continuous.model.state_dict().items():
                torch.testing.assert_close(value,resumed.model.state_dict()[key],rtol=0,atol=0)

    def test_previously_trained_geometry_is_flagged_even_for_different_case(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,_=self.seed(temporary)
            service.state['learnedGroups']=['other']
            self.assertEqual(service.validation_integrity(),'previously-trained')
            service.state['config']['epochs']=2
            service.train()
            self.assertIsNone(service.state.get('bestCheckpointFile'))
            self.assertFalse(service.state['diagnostics']['earlyStoppingEnabled'])

    def test_best_checkpoint_is_used_for_automatic_prediction_but_manual_selection_is_honored(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run=self.seed(temporary)
            service.state['step']=1;service.save(best=True);best=service.state['bestCheckpointFile']
            service.state['step']=2;service.save();latest=service.state['checkpointFile']
            for requested,expected in [(None,best),(latest,latest)]:
                with patch.object(service,'load_checkpoint',wraps=service.load_checkpoint) as load, \
                     patch('worker.MeshSession') as mesher:
                    mesher.return_value.__enter__.return_value.request.side_effect=RuntimeError('stop before generating files')
                    with self.assertRaisesRegex(RuntimeError,'stop before'):
                        service.predict({'runId':run,'checkpointFile':requested,'path':'unused'})
                    self.assertEqual(load.call_args.args[1],expected)

    def test_actual_epoch_metrics_are_comparable_and_evaluation_does_not_train_holdout(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,_=self.seed(temporary)
            service.state['activeWeightSource']={'reason':'final-best'}
            service.state['config']['epochs']=2;service.train()
            self.assertEqual(service.state['status'],'completed')
            self.assertEqual(service.state['samplesSeen'],4)
            self.assertEqual(service.state['loss'],service.state['trainingMetrics']['loss'])
            self.assertEqual(service.state['validationLoss'],service.state['validationMetrics']['loss'])
            self.assertNotIn('b'*32,service.state['seenIds'])
            self.assertNotIn('activeWeightSource',service.state)

    def test_training_loop_stops_and_preserves_best_checkpoint_then_can_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,run=self.seed(temporary)
            service.state['config'].update(epochs=60,earlyStoppingPatience=3)
            with self.constant_evaluation(service):service.train()
            self.assertEqual(service.state['stopReason'],'early-stopping')
            self.assertEqual(service.state['epoch'],10)
            best=service.state['bestCheckpointFile']
            self.assertEqual(service.load_checkpoint(run,best)['state']['epoch'],1)
            service.resume({'runId':run})
            try:
                self.assertEqual(service.state['monitor'],{})
                self.assertEqual(service.state['phase'],1)
            finally:service.release_run()

    def test_legacy_checkpoint_upgrades_on_resume_without_changing_labels(self):
        from worker import atomic_checkpoint
        with tempfile.TemporaryDirectory() as temporary:
            service,run=self.seed(temporary)
            checkpoint=service.load_checkpoint(run)
            checkpoint.pop('scheduler')
            for key in ['metricVersion','monitor','phase','phaseStartEpoch','diagnostics']:
                checkpoint['state'].pop(key,None)
            for key in ['adaptiveTraining','earlyStoppingPatience','lrPatience','minDelta','minLearningRate']:
                checkpoint['state']['config'].pop(key,None)
            file=service.store/'runs'/run/service.state['checkpointFile']
            atomic_checkpoint(file,checkpoint)
            service.resume({'runId':run,'adaptiveTraining':True})
            try:
                self.assertEqual(service.state['metricVersion'],2)
                self.assertEqual(service.state['phase'],1)
                self.assertTrue(service.state['config']['adaptiveTraining'])
                self.assertIsNone(service.state['bestValidationLoss'])
            finally:service.release_run()

    def test_optimizer_geometry_weights_balance_different_numbers_of_cases(self):
        with tempfile.TemporaryDirectory() as temporary:
            service,_=self.seed(temporary)
            original=service.store/'datasets'/('a'*32)
            duplicate=service.store/'datasets'/('c'*32)
            shutil.copytree(original,duplicate)
            atomic_json(duplicate/'metadata.json',{'id':'c'*32,'name':'same geometry','split':'train','group':'square'})
            payload=torch.load(duplicate/'graphs.pt',map_location='cpu',weights_only=True)
            payload['graphs']=payload['graphs'][:1]
            torch.save(payload,duplicate/'graphs.pt')
            service.state.update(trainIds=['a'*32,'b'*32,'c'*32],validationIds=[])
            service.load_graphs()
            square=sum(weight for key,weight in service.graph_weights.items() if not key.startswith('b'*32))
            other=sum(weight for key,weight in service.graph_weights.items() if key.startswith('b'*32))
            self.assertEqual(square,other)
            first=sum(weight for key,weight in service.graph_weights.items() if key.startswith('a'*32))
            last=sum(weight for key,weight in service.graph_weights.items() if key.startswith('c'*32))
            self.assertEqual(first,last)


if __name__=='__main__':unittest.main()
