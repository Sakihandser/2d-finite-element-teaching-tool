"""Real Triangle session: cached scene, bounded refinement and process cleanup."""
import json
from pathlib import Path
import tempfile
import unittest

from mesh_runtime import MeshSession
from random_geometry import generate
from worker import NODE, ROOT, atomic_json
from graph_data import mesh_arrays


class MeshRuntimeTests(unittest.TestCase):
    def test_cached_rounds_preserve_area_materials_and_budget_in_one_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            source=directory/'source.json';output=directory/'output.json'
            scene=generate({'seed':'mesh-session','conditions':1,'maxPrimitives':1,'maxRegions':1,'maxHoles':0},0)[0]
            atomic_json(source,scene)
            with MeshSession(NODE,ROOT/'mesh-worker.cjs') as mesher:
                process=mesher.process
                prepared=mesher.request('seed-cached',source,output)
                seed=prepared['meshes'][0]
                budget=len(seed['nodes'])+12
                atomic_json(source,{'marked':[c['id'] for c in seed['cells']],'maxNodes':budget})
                refined=mesher.request('refine-cached',source,output)
                self.assertLessEqual(len(refined['mesh']['nodes']),budget)
                self.assertTrue(refined['budgetLimited'])
                self.assertEqual({c['region'] for c in seed['cells']},{c['region'] for c in refined['mesh']['cells']})
                self.assertEqual({c['E'] for c in seed['cells']},{c['E'] for c in refined['mesh']['cells']})
                atomic_json(source,{})
                final=mesher.request('scene',source,output)
                self.assertEqual(len(final['analysisNodes']),len(refined['mesh']['nodes']))
                self.assertIsNone(process.poll())
                self.assertAlmostEqual(mesh_arrays(seed)[3].sum(),mesh_arrays(refined['mesh'])[3].sum(),places=7)
                # A failed request does not poison subsequent session requests.
                with self.assertRaisesRegex(ValueError,'Unknown mesh command'):
                    mesher.request('invalid',source,output)
                self.assertEqual(mesher.request('scene',source,output),final)
            self.assertIsNotNone(process.poll())
