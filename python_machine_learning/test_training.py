"""Small deterministic tests for labels, holdouts and exact mid-epoch recovery."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch

from graph_data import build_graph, FEATURE_VERSION
from model import MeshSizingNetwork
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

    def seed(self,service):
        identifier='a'*32
        directory=service.store/'datasets'/identifier
        directory.mkdir()
        graphs=[build_graph(grid(n),GEOMETRY,grid(4),.05) for n in [1,2]]
        torch.save({'version':FEATURE_VERSION,'graphs':graphs},directory/'graphs.pt')
        atomic_json(directory/'metadata.json',{'id':identifier,'name':'fixture','split':'train','group':'square','createdAt':'2026'})
        service.launch=lambda:None
        service.start({'datasetIds':[identifier],'epochs':4,'width':16,'layers':2,'device':'cpu'})
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

    def test_network_accepts_different_mesh_sizes_and_backpropagates(self):
        network=MeshSizingNetwork(16,2)
        for n in [1,3]:
            graph=build_graph(grid(n),GEOMETRY)
            output=network(graph)
            self.assertEqual(len(output),2*n*n)
            output.sum().backward()
            self.assertTrue(all(p.grad is not None and torch.isfinite(p.grad).all() for p in network.parameters()))

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

    def test_new_cases_join_even_when_paused_in_the_last_epoch(self):
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
            self.assertEqual(service.state['config']['epochs'],5)
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
