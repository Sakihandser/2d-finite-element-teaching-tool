"""Small deterministic tests for labels, holdouts and exact mid-epoch recovery."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch

from graph_data import build_graph, preview_size_field, FEATURE_VERSION
from model import MeshSizingNetwork, sizing_loss
from worker import TrainingService, atomic_json, valid_id


def grid(n):
    nodes = [[x/n,y/n,int(y==0)] for y in range(n+1) for x in range(n+1)]
    cells, boundaries = [], []
    for y in range(n):
        for x in range(n):
            a=y*(n+1)+x; b=a+1; c=a+n+1; d=c+1
            for refs in [[a,b,d],[a,d,c]]:
                cells.append({'nodes':refs,'region':'R1','E':2e11,'nu':.3,'rho':7850})
            if y==0: boundaries.append({'nodes':[a,b],'curveId':'bottom','fixed':True,'tRange':[x/n,(x+1)/n]})
            if y==n-1: boundaries.append({'nodes':[c,d],'curveId':'top','fixed':False,'tRange':[x/n,(x+1)/n]})
    return {'nodes':nodes,'cells':cells,'boundaries':boundaries}


GEOMETRY = {'pointLoads':[],'distributedLoads':[{'curveId':'top','qStart':10,'qEnd':10,
    'direction':{'x':0,'y':1},'start':0,'end':1}],'geometryNodes':[],'bodyLoads':[]}


class TrainingTests(unittest.TestCase):
    def service(self,path):
        service=TrainingService(path)
        service.device=torch.device('cpu')
        return service

    def seed(self,service,device='cpu'):
        identifier='a'*32
        directory=service.store/'datasets'/identifier
        directory.mkdir()
        graphs=[build_graph(grid(n),GEOMETRY,grid(4),.05) for n in [1,2]]
        torch.save({'version':FEATURE_VERSION,'graphs':graphs},directory/'graphs.pt')
        atomic_json(directory/'metadata.json',{'id':identifier,'name':'fixture','split':'train','group':'square','createdAt':'2026'})
        service.launch=lambda:None
        service.start({'datasetIds':[identifier],'epochs':4,'width':16,'layers':2,'device':device})
        return service.state['id']

    def test_uniform_reference_projection_and_result_independence(self):
        graph=build_graph(grid(1),GEOMETRY,grid(4),.05)
        expected=np.log(np.sqrt(4*(.5/16)/np.sqrt(3)))
        torch.testing.assert_close(graph['y'],torch.full_like(graph['y'],expected))
        changed=copy.deepcopy(GEOMETRY)
        changed['stress']=[1e99]*100
        changed['displacements']=[-1e99]*100
        changed['analysisNodes']=[{'x':999,'y':999}]
        second=build_graph(grid(1),changed,grid(4),.05)
        torch.testing.assert_close(graph['x'],second['x'],rtol=0,atol=0)
        self.assertEqual(graph['projection_fallback'],0)

    def test_load_and_support_changes_are_visible_to_network(self):
        original=build_graph(grid(2),GEOMETRY)
        changed=copy.deepcopy(GEOMETRY)
        changed['distributedLoads'][0]['direction']={'x':1,'y':0}
        changed_graph=build_graph(grid(2),changed)
        self.assertFalse(torch.equal(original['x'],changed_graph['x']))
        mesh=grid(2)
        for boundary in mesh['boundaries']: boundary['fixed']=False
        for node in mesh['nodes']: node[2]=0
        self.assertFalse(torch.equal(original['x'],build_graph(mesh,GEOMETRY)['x']))

    def test_uniform_input_preserves_nonuniform_supervision_and_preview_matches_training(self):
        reference=grid(8)
        for node in reference['nodes']: node[0]*=.5
        right=grid(2); offset=len(reference['nodes'])
        for node in right['nodes']: node[0]=.5+.5*node[0]
        for cell in right['cells']: cell['nodes']=[n+offset for n in cell['nodes']]
        reference['nodes']+=right['nodes']; reference['cells']+=right['cells']
        mesh=grid(4)
        graph=build_graph(mesh,GEOMETRY,reference)
        uniform=build_graph(mesh,GEOMETRY,grid(8))
        torch.testing.assert_close(graph['x'],uniform['x'],rtol=0,atol=0)
        self.assertLess(float(graph['current'].max()-graph['current'].min()),1e-6)
        centers=np.array(mesh['nodes'])[[c['nodes'] for c in mesh['cells']],:2].mean(1)
        left=centers[:,0]<.5
        self.assertAlmostEqual(float(graph['y'][~left].mean()-graph['y'][left].mean()),np.log(4),places=5)
        self.assertGreater(float(sizing_loss(graph['y'].mean().expand_as(graph['y']),graph)),0.1)
        field=preview_size_field(mesh,reference)
        np.testing.assert_allclose(np.log(np.array(field['targetSize'])/graph['length']),graph['y'].numpy(),rtol=0,atol=1e-12)
        np.testing.assert_allclose(np.log(field['refinementRatio']),graph['current'].double().numpy()-graph['y'].double().numpy(),rtol=0,atol=1e-12)
        self.assertEqual(field['projectionFallbacks'],graph['projection_fallback'])

    def test_network_accepts_different_mesh_sizes_and_backpropagates(self):
        network=MeshSizingNetwork(16,2)
        for n in [1,3]:
            graph=build_graph(grid(n),GEOMETRY)
            output=network(graph)
            self.assertEqual(len(output),2*n*n)
            output.sum().backward()
            self.assertTrue(all(p.grad is not None and torch.isfinite(p.grad).all() for p in network.parameters()))

    def test_v2_learns_a_local_size_field_without_collapsing(self):
        torch.manual_seed(42)
        graph=build_graph(grid(4),GEOMETRY)
        # A spatial target cannot be fitted by a constant global size shift.
        graph['y']=graph['current']-1.5*(graph['x'][:,0]>.0).float()-.2
        model=MeshSizingNetwork(16,4,2)
        model.fit_normalization([graph])
        optimizer=torch.optim.AdamW(model.parameters(),lr=.003)
        initial=float(sizing_loss(model(graph),graph).detach())
        for _ in range(100):
            optimizer.zero_grad()
            loss=sizing_loss(model(graph),graph)
            loss.backward();optimizer.step()
        self.assertLess(float(loss.detach()),initial*.08)
        self.assertGreater(float((model(graph)-graph['current']).std().detach()),.4)
        self.assertGreater(float(model.encoder[0].weight.grad.norm()),1e-5)
        restored=MeshSizingNetwork(16,4,2)
        restored.load_state_dict(model.state_dict())
        torch.testing.assert_close(restored(graph),model(graph),rtol=0,atol=0)

    def test_new_run_normalization_uses_only_training_data_and_resume_keeps_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary);run=self.seed(service)
            self.assertEqual(service.model.architecture,2)
            mean=service.model.feature_mean.clone()
            self.assertTrue(torch.isfinite(service.model.feature_scale).all())
            restored=self.service(temporary);restored.restore(run)
            torch.testing.assert_close(mean,restored.model.feature_mean,rtol=0,atol=0)
            # Validation outliers must not leak into fitted normalization.
            validation='b'*32;directory=service.store/'datasets'/validation;directory.mkdir()
            graph=build_graph(grid(2),GEOMETRY,grid(4))
            graph['x']+=1000
            torch.save({'version':FEATURE_VERSION,'graphs':[graph]},directory/'graphs.pt')
            atomic_json(directory/'metadata.json',{'id':validation,'split':'validation','group':'holdout'})
            service.start({'datasetIds':service.state['trainIds']+[validation],'width':16,'layers':2})
            torch.testing.assert_close(mean,service.model.feature_mean,rtol=0,atol=0)

    def test_legacy_checkpoint_without_architecture_still_resumes_exactly(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary);run=self.seed(service)
            service.state['config'].pop('architecture')
            service.model=MeshSizingNetwork(16,2)
            service.optimizer=torch.optim.AdamW(service.model.parameters(),lr=.001,foreach=False)
            service.setup_scheduler();service.save()
            restored=self.service(temporary);restored.restore(run)
            self.assertEqual(restored.model.architecture,1)
            for expected,actual in zip(service.model.parameters(),restored.model.parameters()):
                torch.testing.assert_close(expected,actual,rtol=0,atol=0)
            restored.train()
            self.assertEqual(restored.state['status'],'completed')

    def test_process_restart_mid_epoch_matches_continuous_training(self):
        with tempfile.TemporaryDirectory() as temporary:
            seed=self.service(Path(temporary)/'seed')
            run=self.seed(seed)
            # Give each trajectory its own storage so checkpoint replacement
            # cannot accidentally let one trajectory consume the other's state.
            import shutil
            uninterrupted_path=Path(temporary)/'continuous'
            interrupted_path=Path(temporary)/'interrupted'
            shutil.copytree(seed.store,uninterrupted_path)
            shutil.copytree(seed.store,interrupted_path)
            continuous=self.service(uninterrupted_path)
            continuous.restore(run); continuous.train()
            interrupted=self.service(interrupted_path)
            interrupted.restore(run)
            original_step=interrupted.optimizer.step
            def pause_after_third_step(*args,**kwargs):
                result=original_step(*args,**kwargs)
                if interrupted.state['step']==2: interrupted.stop.set()
                return result
            interrupted.optimizer.step=pause_after_third_step
            interrupted.train()
            self.assertEqual(interrupted.state['status'],'paused')
            self.assertEqual(interrupted.state['cursor'],1)
            restored=self.service(interrupted_path)
            restored.restore(run)
            self.assertEqual(restored.state['step'],3)
            restored.train()
            self.assertEqual(restored.state['step'],8)
            self.assertEqual(restored.state['samplesSeen'],continuous.state['samplesSeen'])
            self.assertEqual(restored.state['elementsSeen'],continuous.state['elementsSeen'])
            for actual,expected in zip(restored.model.parameters(),continuous.model.parameters()):
                torch.testing.assert_close(actual,expected,rtol=0,atol=0)
            self.assertEqual([h['loss'] for h in restored.state['history']],[h['loss'] for h in continuous.state['history']])

    def test_previous_checkpoint_is_recoverable(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary); run=self.seed(service)
            service.save()
            (service.store/'runs'/run/service.state['checkpointFile']).write_bytes(b'incomplete checkpoint')
            restored=self.service(temporary); restored.restore(run)
            self.assertEqual(restored.state['step'],0)

    def test_same_geometry_cannot_cross_validation_split(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary)
            for identifier,split in [('a'*32,'train'),('b'*32,'validation')]:
                atomic_json(service.store/'datasets'/identifier/'metadata.json',{'id':identifier,'split':split,'group':'same-geometry'})
            with self.assertRaisesRegex(ValueError,'相同几何'):
                service.select_datasets(['a'*32,'b'*32])
        for invalid in ['../runs','C:/windows','',None]:
            with self.assertRaises(ValueError): valid_id(invalid)

    def test_only_one_process_can_train_a_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            first=self.service(temporary); run=self.seed(first)
            second=self.service(temporary)
            first.acquire_run(run)
            with self.assertRaisesRegex(ValueError,'另一程序实例'): second.acquire_run(run)
            first.release_run()
            second.acquire_run(run)
            second.release_run()

    def test_selected_data_replaces_old_data_even_when_paused_in_the_last_epoch(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary); self.seed(service)
            original_step=service.optimizer.step
            def stop_in_last_epoch(*args,**kwargs):
                result=original_step(*args,**kwargs)
                if service.state['step']==6: service.stop.set()
                return result
            service.optimizer.step=stop_in_last_epoch
            service.train()
            new='b'*32; directory=service.store/'datasets'/new; directory.mkdir()
            torch.save({'version':FEATURE_VERSION,'graphs':[build_graph(grid(3),GEOMETRY,grid(4),.05)]},directory/'graphs.pt')
            atomic_json(directory/'metadata.json',{'id':new,'split':'train','group':'new-geometry'})
            service.resume({'runId':service.state['id'],'datasetIds':[new]})
            self.assertEqual(service.state['config']['epochs'],4)
            self.assertEqual(service.state['trainIds'],[new])
            self.assertEqual(service.state['order'],[])
            service.stop.clear(); service.train()
            self.assertIn(new,service.state['seenIds'])

    def test_validation_is_not_counted_as_learning_and_keeps_best_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary); self.seed(service)
            validation='b'*32; directory=service.store/'datasets'/validation; directory.mkdir()
            mesh,reference=grid(2),grid(4)
            for data in [mesh,reference]:
                for node in data['nodes']: node[0]*=2
            torch.save({'version':FEATURE_VERSION,'graphs':[build_graph(mesh,GEOMETRY,reference,.05)]},directory/'graphs.pt')
            atomic_json(directory/'metadata.json',{'id':validation,'split':'validation','group':'rectangle'})
            service.state['validationIds']=[validation]; service.load_graphs(); service.train()
            self.assertEqual(service.state['samplesSeen'],8)
            self.assertNotIn(validation,service.state['seenIds'])
            self.assertIsNotNone(service.state['validationLoss'])
            self.assertTrue((service.store/'runs'/service.state['id']/service.state['bestCheckpointFile']).is_file())


if __name__=='__main__': unittest.main()
