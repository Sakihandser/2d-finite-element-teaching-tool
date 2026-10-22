"""Dataset management always operates on disposable stores in these tests."""
import copy
import hashlib
import json
import stat
import tempfile
import threading
import unittest

import test_training
from worker import atomic_json


class DatasetManagementTests(unittest.TestCase):
    service = test_training.TrainingTests.service
    seed = test_training.TrainingTests.seed

    def reference(self, service, identifier='a'*32):
        geometry = {'version': 6, 'name': 'square', 'geometryNodes': [{'id': 'G1', 'x': 0, 'y': 0}],
                    'curves': [], 'regions': [], **copy.deepcopy(test_training.GEOMETRY)}
        geometry['geometryNodes'] = [{'id': 'G1', 'x': 0, 'y': 0}]
        atomic_json(service.store/'datasets'/identifier/'reference.json', {
            'geometry': geometry, 'reference': test_training.grid(4), 'meshes': [test_training.grid(1), test_training.grid(2)],
            'provenance': {'seed': 'test-seed'}})

    def test_preview_restores_geometry_and_both_reference_and_coarse_meshes_without_graph_deserialization(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); self.seed(service); self.reference(service)
            graph = service.store/'datasets'/('a'*32)/'graphs.pt'
            graph.write_bytes(b'preview must not read torch tensors')
            result = service.datasets.preview({'datasetId': 'a'*32})
            self.assertEqual(result['scene']['dataGeneration']['seed'], 'test-seed')
            self.assertEqual([len(m['triangles']) for m in result['meshes']], [32, 2, 8])
            self.assertEqual([m['kind'] for m in result['meshes']], ['reference', 'coarse', 'coarse'])
            self.assertEqual(len(result['meshes'][0]['nodes'][0]), 2)
            self.assertIn('distributedLoads', result['scene'])
            self.assertNotIn('sizing',result['meshes'][0])
            for mesh in result['meshes'][1:]:
                self.assertEqual(len(mesh['sizing']['targetSize']),len(mesh['triangles']))
                self.assertEqual(mesh['sizing']['projectionFallbacks'],0)
            self.assertAlmostEqual(result['meshes'][1]['sizing']['refinementRatio'][0],4,places=5)

    def test_preview_keeps_geometry_when_label_version_is_unsupported(self):
        with tempfile.TemporaryDirectory() as temporary:
            service=self.service(temporary); self.seed(service); self.reference(service)
            file=service.store/'datasets'/('a'*32)/'metadata.json'
            metadata=json.loads(file.read_text());metadata['featureVersion']=999
            atomic_json(file,metadata)
            result=service.datasets.preview({'datasetId':'a'*32})
            self.assertNotIn('sizing',result['meshes'][1])
            self.assertIn('版本不兼容',result['meshes'][1]['sizingWarning'])

    def test_referenced_deletion_requires_current_impact_and_removes_files_but_keeps_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service); self.reference(service)
            checkpoint = service.store/'runs'/run/service.state['checkpointFile']
            digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
            impact = service.datasets.impact({'datasetIds': ['a'*32]})
            self.assertEqual(impact['dependencies'][0]['id'], run)
            self.assertEqual(impact['files'], 3)
            with self.assertRaisesRegex(ValueError, '确认'):
                service.datasets.delete({'datasetIds': ['a'*32], 'token': impact['token']})
            self.assertTrue((service.store/'datasets'/('a'*32)/'graphs.pt').is_file())
            result = service.datasets.delete({'datasetIds': ['a'*32], 'token': impact['token'], 'allowReferenced': True})
            self.assertEqual(result['deletedIds'], ['a'*32])
            self.assertFalse((service.store/'datasets'/('a'*32)).exists())
            self.assertFalse((service.store/'trash').exists())
            self.assertEqual(hashlib.sha256(checkpoint.read_bytes()).hexdigest(), digest)
            self.assertIn('network', service.load_checkpoint(run))
            self.assertEqual(service.graphs, {})
            with self.assertRaisesRegex(ValueError, '已删除或缺失'):
                service.resume({'runId': run})

    def test_stale_confirmation_and_invalid_paths_do_not_delete_anything(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); self.seed(service)
            impact = service.datasets.impact({'datasetIds': ['a'*32]})
            metadata = service.store/'datasets'/('a'*32)/'metadata.json'
            data = json.loads(metadata.read_text()); data['name'] = 'changed'; atomic_json(metadata, data)
            with self.assertRaisesRegex(ValueError, '已改变'):
                service.datasets.delete({'datasetIds': ['a'*32], 'token': impact['token'], 'allowReferenced': True})
            for invalid in ['../runs', 'a'*31, 'a'*32+'/../runs', 'MISSING']:
                with self.assertRaises(ValueError):
                    service.datasets.impact({'datasetIds': [invalid]})
            self.assertTrue(metadata.exists())
            with self.assertRaises(ValueError):
                service.datasets.impact({'datasetIds': ['a'*32, 'b'*32]})
            self.assertTrue(metadata.exists())

    def test_active_training_and_another_instances_run_lock_block_deletion(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service)
            impact = service.datasets.impact({'datasetIds': ['a'*32]})
            command = {'datasetIds': ['a'*32], 'token': impact['token'], 'allowReferenced': True}
            stop = threading.Event(); thread = threading.Thread(target=stop.wait)
            service.thread = thread; thread.start()
            try:
                with self.assertRaisesRegex(ValueError, '暂停'):
                    service.datasets.delete(command)
            finally:
                stop.set(); thread.join()
            other = self.service(temporary); other.acquire_run(run)
            try:
                with self.assertRaisesRegex(ValueError, '另一程序实例'):
                    service.datasets.delete(command)
            finally:
                other.release_run()
            self.assertTrue((service.store/'datasets'/('a'*32)).exists())

    def test_batch_deletes_only_selected_directories_including_readonly_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); self.seed(service)
            for identifier in ['b'*32, 'c'*32]:
                directory = service.store/'datasets'/identifier; directory.mkdir()
                atomic_json(directory/'metadata.json', {'id': identifier, 'name': identifier})
                (directory/'graphs.pt').write_bytes(b'fixture')
                (directory/'graphs.pt').chmod(stat.S_IREAD)
            payload = {'datasetIds': ['b'*32, 'c'*32, 'b'*32]}
            impact = service.datasets.impact(payload)
            self.assertEqual(impact['dependencies'], [])
            result = service.datasets.delete({**payload, 'token': impact['token']})
            self.assertEqual(result['deletedIds'], ['b'*32, 'c'*32])
            self.assertTrue((service.store/'datasets'/('a'*32)/'graphs.pt').exists())

    def test_dependencies_in_older_checkpoints_are_not_hidden_by_current_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = self.service(temporary); run = self.seed(service)
            for name in ['metadata.json', 'checkpoint-metadata.json']:
                file = service.store/'runs'/run/name
                data = json.loads(file.read_text(encoding='utf-8')); data['trainIds'] = []; atomic_json(file, data)
            impact = service.datasets.impact({'datasetIds': ['a'*32]})
            self.assertEqual(impact['dependencies'][0]['datasetIds'], ['a'*32])


if __name__ == '__main__':
    unittest.main()
