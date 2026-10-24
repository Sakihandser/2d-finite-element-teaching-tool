"""Batch equivalence, physical symmetry and restartable continuous training."""
import copy
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import torch
import test_training as fixtures
import test_training_monitor as monitor_fixtures
from model import MeshSizingNetwork, sizing_loss
from training_batches import pack_graphs, symmetry_graph
from training_monitor import update_monitor


class BatchTests(unittest.TestCase):
    def graphs(self):
        return [fixtures.build_graph(fixtures.grid(n),fixtures.GEOMETRY,fixtures.grid(4)) for n in [1,3]]

    def test_batch_predictions_loss_and_gradients_match_independent_graphs(self):
        for architecture in [1,2]:
            torch.manual_seed(42)
            model=MeshSizingNetwork(16,2,architecture)
            torch.nn.init.normal_(model.decoder[-1].weight,std=.01)
            graphs=self.graphs();weights=[.5,1.5]
            independent=[model(g) for g in graphs]
            reference=sum(w*sizing_loss(pred,g) for w,pred,g in zip(weights,independent,graphs))/2
            reference.backward()
            gradients=[p.grad.clone() for p in model.parameters()]
            model.zero_grad()
            batch=pack_graphs(graphs,weights)
            prediction=model(batch)
            torch.testing.assert_close(prediction,torch.cat(independent),rtol=1e-5,atol=1e-6)
            actual=sizing_loss(prediction,batch)
            torch.testing.assert_close(actual,reference)
            actual.backward()
            for parameter,expected in zip(model.parameters(),gradients):
                torch.testing.assert_close(parameter.grad,expected,rtol=3e-4,atol=2e-6)

    def test_batch_connections_and_pool_never_cross_cases(self):
        graphs=self.graphs();batch=pack_graphs(graphs)
        split=len(graphs[0]['x']);first_pool=graphs[0]['pool_count']
        source,target=batch['edges']
        self.assertTrue(torch.equal(source<split,target<split))
        source,target=batch['coarse_edges']
        self.assertTrue(torch.equal(source<first_pool,target<first_pool))
        self.assertTrue(bool((batch['pool'][:split]<first_pool).all()))
        self.assertTrue(bool((batch['pool'][split:]>=first_pool).all()))

    def test_all_eight_symmetries_preserve_scalars_and_cached_tensors(self):
        graph=self.graphs()[1];original=copy.deepcopy(graph)
        pairs=[(0,1),(9,10),(11,12),(14,15),(17,18)]
        for transform in range(8):
            changed=symmetry_graph(graph,transform)
            for a,b in pairs:
                torch.testing.assert_close(changed['x'][:,[a,b]].square().sum(1),graph['x'][:,[a,b]].square().sum(1))
            for key in ['y','current','weight','edges','pool','coarse_edges']:
                torch.testing.assert_close(changed[key],graph[key],rtol=0,atol=0)
            torch.testing.assert_close(changed['edge_features'][:,2:],graph['edge_features'][:,2:])
        for key,value in original.items():
            if isinstance(value,torch.Tensor):torch.testing.assert_close(graph[key],value,rtol=0,atol=0)
        rotated=graph
        for _ in range(4):rotated=symmetry_graph(rotated,1)
        torch.testing.assert_close(rotated['x'],graph['x'],rtol=0,atol=0)

    def test_rotation_matches_rebuilt_physical_features(self):
        geometry=copy.deepcopy(fixtures.GEOMETRY)
        mesh=fixtures.grid(3)
        graph=fixtures.build_graph(mesh,geometry,fixtures.grid(4))
        for node in mesh['nodes']:node[0],node[1]=-node[1],node[0]
        # The fixture has a distributed load; rotate its prescribed direction.
        for load in geometry['distributedLoads']:
            direction=load.get('direction') or {'x':0,'y':-1}
            load['direction']={'x':-direction['y'],'y':direction['x']}
        rebuilt=fixtures.build_graph(mesh,geometry)
        transformed=symmetry_graph(graph,1)
        torch.testing.assert_close(transformed['x'],rebuilt['x'],rtol=1e-5,atol=1e-6)
        torch.testing.assert_close(transformed['edge_features'],rebuilt['edge_features'],rtol=1e-5,atol=1e-6)

    def test_batch_respects_element_budget_with_single_oversize_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            service=fixtures.TrainingTests().service(tmp);fixtures.TrainingTests().seed(service)
            service.state['config'].update(batchGraphs=4,maxBatchElements=5)
            service.state['order']=list(service.graphs)
            keys,graph,_=service.next_training_batch()
            self.assertEqual(len(keys),1)
            service.state['cursor']=1
            keys,graph,_=service.next_training_batch()
            self.assertEqual(len(keys),1)
            self.assertGreater(len(graph['x']),5)
            service.release_run()


class ContinuousTests(unittest.TestCase):
    def test_continuous_controller_restarts_instead_of_exhausting_retries(self):
        state={'config':{'adaptiveTraining':True,'continuousTraining':True,'automaticRecovery':True,
            'lrPatience':2,'earlyStoppingPatience':2,'maxRecoveryAttempts':0},
            'epoch':12,'monitor':{'best':.2,'bestTrainLoss':.2,'badEpochs':20,'recoveryAttempts':3}}
        optimizer=torch.optim.AdamW([torch.nn.Parameter(torch.zeros(1))],lr=1e-6)
        scheduler=torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer)
        metric=monitor_fixtures.metrics
        stop,_=update_monitor(state,optimizer,scheduler,{**metric(.1),'groups':3},{**metric(.3),'groups':3},'independent')
        self.assertFalse(stop)
        self.assertEqual(state['diagnostics']['action'],'restart-cycle')
        self.assertFalse(state['diagnostics']['earlyStoppingEnabled'])

    def test_multiple_cycles_exceed_epoch_budget_and_honor_manual_pause(self):
        with tempfile.TemporaryDirectory() as tmp:
            service,run=monitor_fixtures.MonitorTests().seed(tmp)
            service.state['config'].update(continuousTraining=True,epochs=2,cycleEpochs=2,
                automaticRecovery=False,batchGraphs=2,symmetryAugmentation=True)
            save=service.save
            def stop_after_cycles(*args,**kwargs):
                result=save(*args,**kwargs)
                if service.state.get('trainingCycle',0)>=2:service.stop.set()
                return result
            service.save=stop_after_cycles
            with monitor_fixtures.MonitorTests().constant_evaluation(service):service.train()
            self.assertEqual(service.state['status'],'paused')
            self.assertEqual(service.state['stopReason'],'manual-pause')
            self.assertGreaterEqual(service.state['epoch'],4)
            self.assertEqual(service.state['trainingCycle'],2)
            self.assertIsNotNone(service.state['bestCheckpointFile'])
            restored=fixtures.TrainingTests().service(tmp);restored.restore(run)
            self.assertEqual(restored.state['trainingCycle'],2)
            self.assertEqual(restored.state['cyclePeakRate'],.0001)

    def test_augmented_batch_pause_resume_has_identical_weights_and_rng(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            service=fixtures.TrainingTests().service(root/'seed');run=fixtures.TrainingTests().seed(service)
            service.state['config'].update(batchGraphs=2,symmetryAugmentation=True)
            service.state['regularizationDropout']=.1;service.model.regularization_dropout=.1
            service.save();service.release_run()
            for name in ['continuous','paused']:shutil.copytree(service.store,root/name)
            full=fixtures.TrainingTests().service(root/'continuous');full.restore(run);full.train()
            paused=fixtures.TrainingTests().service(root/'paused');paused.restore(run)
            step=paused.optimizer.step
            def pause(*args,**kwargs):
                result=step(*args,**kwargs);paused.stop.set();return result
            paused.optimizer.step=pause;paused.train()
            self.assertEqual(paused.state['status'],'paused')
            resumed=fixtures.TrainingTests().service(root/'paused');resumed.restore(run);resumed.train()
            self.assertEqual(resumed.state['optimizerSteps'],full.state['optimizerSteps'])
            self.assertEqual(resumed.state['step'],full.state['step'])
            for key,value in full.model.state_dict().items():
                torch.testing.assert_close(resumed.model.state_dict()[key],value,rtol=0,atol=0)

    def test_cosine_cycles_and_best_weights_resume_identically_after_pause(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            seed,run=monitor_fixtures.MonitorTests().seed(root/'seed')
            seed.state['config'].update(continuousTraining=True,epochs=2,cycleEpochs=2,
                automaticRecovery=False,batchGraphs=2,symmetryAugmentation=True)
            seed.state['regularizationDropout']=.1;seed.model.regularization_dropout=.1
            seed.save();seed.release_run()
            for name in ['full','paused']:shutil.copytree(seed.store,root/name)
            def until_two_cycles(service):
                save=service.save
                def save_and_stop(*args,**kwargs):
                    result=save(*args,**kwargs)
                    if service.state.get('trainingCycle',0)>=2:service.stop.set()
                    return result
                service.save=save_and_stop
                with monitor_fixtures.MonitorTests().constant_evaluation(service):service.train()
            full=fixtures.TrainingTests().service(root/'full');full.restore(run);until_two_cycles(full)
            paused=fixtures.TrainingTests().service(root/'paused');paused.restore(run)
            step=paused.optimizer.step
            def stop_after_step(*args,**kwargs):
                result=step(*args,**kwargs);paused.stop.set();return result
            paused.optimizer.step=stop_after_step
            with monitor_fixtures.MonitorTests().constant_evaluation(paused):paused.train()
            resumed=fixtures.TrainingTests().service(root/'paused');resumed.restore(run);until_two_cycles(resumed)
            for key in ['epoch','step','trainingCycle','cycleStartEpoch','cyclePeakRate','monitor']:
                self.assertEqual(resumed.state[key],full.state[key])
            self.assertEqual(resumed.optimizer.param_groups[0]['lr'],full.optimizer.param_groups[0]['lr'])
            for key,value in full.model.state_dict().items():
                torch.testing.assert_close(resumed.model.state_dict()[key],value,rtol=0,atol=0)


if __name__=='__main__':unittest.main()
