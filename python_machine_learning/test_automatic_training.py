"""Bounded automatic recovery, restored baselines and resumable retry state."""
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import torch
import test_training_monitor as fixtures
from training_monitor import update_monitor
metrics=fixtures.metrics


class AutomaticTrainingTests(unittest.TestCase):
    def seed(self,path):
        service,run=fixtures.MonitorTests().seed(path)
        service.state['config'].update(automaticRecovery=True,maxRecoveryAttempts=2,
            recoveryPatience=2,lrPatience=2,earlyStoppingPatience=25,epochs=30)
        service.setup_scheduler();service.save()
        return service,run

    def plateau(self,service):
        return patch.object(service,'evaluate_split',side_effect=lambda ids:{
            **metrics(.1 if ids==service.state['trainIds'] else .2),'groups':1,'cases':1,'graphs':2})

    def test_plateau_automatically_recovers_with_decreasing_rates_then_stops_at_best(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,run=self.seed(tmp)
            with self.plateau(service):service.train()
            self.assertEqual(service.state['status'],'completed')
            self.assertEqual(service.state['stopReason'],'early-stopping')
            attempts=service.state['adjustments']
            self.assertEqual(len(attempts),2)
            self.assertEqual([r['learningRate'] for r in attempts],[.0005,.00025])
            self.assertEqual(service.state['monitor']['recoveryAttempts'],2)
            best=service.load_checkpoint(run,service.state['bestCheckpointFile'])
            latest=service.load_checkpoint(run)
            for key,value in best['network'].items():
                torch.testing.assert_close(latest['network'][key],value,rtol=0,atol=0)
            self.assertGreater(latest['state']['step'],best['state']['step'])
            self.assertEqual(service.state['activeWeightSource']['reason'],'final-best')

    def test_recovery_and_dropout_resume_exactly_without_resetting_attempt_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            original,run=self.seed(Path(tmp)/'seed')
            # Enable dropout to exercise saved CPU RNG, as well as optimizer,
            # scheduler, adjustment history and epoch cursor.
            original.state['regularizationDropout']=.1
            original.model.regularization_dropout=.1;original.save()
            for name in ['continuous','paused']:shutil.copytree(original.store,Path(tmp)/name)
            continuous=fixtures.MonitorTests().service(Path(tmp)/'continuous');continuous.restore(run)
            with self.plateau(continuous):continuous.train()
            paused=fixtures.MonitorTests().service(Path(tmp)/'paused');paused.restore(run)
            # Pause after the first recovery at the checkpoint save boundary.
            save=paused.save
            def save_then_pause(*args,**kwargs):
                result=save(*args,**kwargs)
                if paused.state['monitor'].get('recoveryAttempts')==1:paused.stop.set()
                return result
            paused.save=save_then_pause
            with self.plateau(paused):paused.train()
            self.assertEqual(paused.state['status'],'paused')
            resumed=fixtures.MonitorTests().service(Path(tmp)/'paused');resumed.restore(run)
            self.assertEqual(resumed.state['monitor']['recoveryAttempts'],1)
            self.assertEqual(resumed.model.regularization_dropout,.1)
            with self.plateau(resumed):resumed.train()
            self.assertEqual(resumed.state['monitor'],continuous.state['monitor'])
            self.assertEqual(resumed.state['step'],continuous.state['step'])
            for key,value in continuous.model.state_dict().items():
                torch.testing.assert_close(resumed.model.state_dict()[key],value,rtol=0,atol=0)

    def test_overfitting_requires_persistence_and_increases_regularization(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,run=self.seed(tmp)
            service.state.update(step=1,epoch=1,bestValidationLoss=.2)
            service.state['monitor']={'best':.2,'bestTrainLoss':.2}
            service.save(best=True)
            for epoch in [2,3]:
                service.state['epoch']=epoch
                stop,_=update_monitor(service.state,service.optimizer,service.scheduler,
                    {**metrics(.08),'groups':1},{**metrics(.3),'groups':1},'independent')
                self.assertFalse(stop)
                if epoch==2:self.assertIsNone(service.state['diagnostics']['action'])
            diagnostic=service.state['diagnostics']
            self.assertEqual(diagnostic['action'],'recover-best')
            self.assertEqual(diagnostic['recoveryReason'],'overfitting')
            with self.plateau(service):service.recover_best(diagnostic['nextLearningRate'],'overfitting')
            self.assertEqual(service.optimizer.param_groups[0]['lr'],.0005)
            self.assertEqual(service.optimizer.param_groups[0]['weight_decay'],.0005)
            self.assertEqual(service.model.regularization_dropout,.05)
            self.assertEqual(service.state['epoch'],3)
            self.assertEqual(service.state['monitor']['badEpochs'],0)

    def test_restored_model_is_validated_before_training_and_not_replaced_by_worse_first_epoch(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,run=self.seed(tmp)
            service.state.update(step=1,epoch=1,bestValidationLoss=None,bestCheckpointFile=None,trainingMetrics=None)
            service.save()
            with self.plateau(service):service.initialize_validation_baseline()
            best=service.state['bestCheckpointFile']
            self.assertIsNotNone(best)
            self.assertEqual(service.load_checkpoint(run,best)['state']['epoch'],1)
            self.assertEqual(service.state['monitor']['best'],.2)
            service.state['config']['epochs']=2
            with patch.object(service,'evaluate_split',side_effect=lambda ids:{
                    **metrics(.05 if ids==service.state['trainIds'] else .3),'groups':1,'cases':1,'graphs':2}):
                service.train()
            self.assertEqual(service.state['bestCheckpointFile'],best)
            self.assertEqual(service.state['bestValidationLoss'],.2)

    def test_no_recovery_or_validation_selection_for_leaked_or_missing_holdout(self):
        for integrity in ['none','previously-trained','unknown']:
            state={'config':{'adaptiveTraining':True,'automaticRecovery':True,'lrPatience':1},
                'epoch':10,'monitor':{'best':.1,'badEpochs':9,'bestTrainLoss':.2}}
            optimizer=torch.optim.AdamW([torch.nn.Parameter(torch.zeros(1))],lr=.001)
            scheduler=torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer)
            stop,_=update_monitor(state,optimizer,scheduler,{**metrics(.01),'groups':1},
                {**metrics(1),'groups':1} if integrity!='none' else None,integrity)
            self.assertFalse(stop)
            self.assertIsNone(state['diagnostics']['action'])

    def test_enabling_automatic_control_preserves_best_checkpoint_and_actual_learning_rate(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,run=fixtures.MonitorTests().seed(tmp)
            service.state.update(step=1,epoch=1,bestValidationLoss=.2)
            service.save(best=True);best=service.state['bestCheckpointFile']
            service.optimizer.param_groups[0]['lr']=.000125;service.save()
            service.resume({'runId':run,'automaticRecovery':True,'learningRate':.001})
            try:
                self.assertEqual(service.state['bestCheckpointFile'],best)
                self.assertEqual(service.optimizer.param_groups[0]['lr'],.000125)
                self.assertTrue(service.state['validationBaselinePending'])
            finally:service.release_run()
