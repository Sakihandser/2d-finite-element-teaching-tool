import copy
import unittest

from shapely.geometry import Polygon
from shapely.ops import unary_union

from random_geometry import generate, condition


class RandomGeometryTests(unittest.TestCase):
    def config(self, **options):
        return {'seed': 'geometry-regression', 'conditions': 3, 'maxPrimitives': 5,
                'maxRegions': 4, 'maxHoles': 3, **options}

    def test_reproducibility_and_physics_variants_share_exact_geometry(self):
        config = self.config()
        first = generate(config, 0)
        self.assertEqual(first, generate(config, 0))
        self.assertNotEqual(first, generate({**config, 'seed': 'other-seed'}, 0))
        for variant in first[1:]:
            for key in ['geometryNodes', 'curves']:
                def geometry_only(values):
                    return [{k: v for k, v in item.items() if k != 'mechanicalState'} for item in values]
                self.assertEqual(geometry_only(first[0][key]), geometry_only(variant[key]))
            self.assertNotEqual(first[0]['pointLoads'], variant['pointLoads'])

    def test_connected_partition_with_nonoverlapping_holes_and_effective_supports(self):
        seen_holes, seen_regions = False, False
        for index in range(12):
            with self.subTest(index=index):
                scene = generate(self.config(conditions=1), index)[0]
                solid = [Polygon([(p['x'], p['y']) for p in r['polygon']])
                         for r in scene['regions'] if not r['isAir']]
                holes = [Polygon([(p['x'], p['y']) for p in r['polygon']])
                         for r in scene['regions'] if r['isAir']]
                outer = unary_union(solid)
                self.assertTrue(outer.is_valid)
                self.assertEqual(outer.geom_type, 'Polygon')
                self.assertAlmostEqual(sum(p.area for p in solid), outer.area, places=5)
                for hole in holes:
                    self.assertTrue(outer.contains(hole))
                for i, a in enumerate(holes):
                    for b in holes[i+1:]:
                        self.assertFalse(a.intersects(b))
                unique_edges = {tuple(sorted(c['geometryNodeIds'])) for c in scene['curves']}
                self.assertEqual(len(unique_edges), len(scene['curves']))
                fixed = {n['id'] for n in scene['geometryNodes'] if n['mechanicalState'] == 'static'}
                self.assertGreaterEqual(len(fixed), 2)
                for load in scene['pointLoads']:
                    self.assertNotIn(load['geometryNodeId'], fixed)
                for c in scene['curves']:
                    if c['mechanicalState'] == 'static':
                        self.assertIn(c['id'], scene['dataGeneration']['exteriorCurveIds'])
                seen_holes |= bool(holes)
                seen_regions |= len(solid) > 1
        self.assertTrue(seen_holes)
        self.assertTrue(seen_regions)

    def test_material_filter_and_individual_load_modes(self):
        for kind in ['point', 'distributed', 'body']:
            scene = generate(self.config(conditions=1, loadTypes=[kind], materialIds=['mat-q235-steel']), 0)[0]
            self.assertTrue(scene[{'point': 'pointLoads', 'distributed': 'distributedLoads', 'body': 'bodyLoads'}[kind]])
            self.assertTrue(all(r['isAir'] or r['material']['id'] == 'mat-q235-steel' for r in scene['regions']))
        with self.assertRaisesRegex(ValueError, '材料库'):
            generate(self.config(materialIds=['missing-material']), 0)

    def test_balanced_sampling_covers_load_subsets_and_keeps_point_anchors_unique(self):
        config = self.config(conditions=7, physicsSampling='balanced')
        scenes = generate(config, 0)
        combinations = set()
        for scene in scenes:
            types = frozenset(scene['dataGeneration']['sampledLoadTypes'])
            combinations.add(types)
            for kind, field in [('point', 'pointLoads'), ('distributed', 'distributedLoads'), ('body', 'bodyLoads')]:
                self.assertEqual(bool(scene[field]), kind in types)
            point_ids = [load['geometryNodeId'] for load in scene['pointLoads']]
            self.assertEqual(len(point_ids), len(set(point_ids)))
        self.assertEqual(len(combinations), 7)
        self.assertEqual(scenes, generate(config, 0))

    def test_missing_sampling_mode_preserves_historical_physics(self):
        first = generate(self.config(), 0)
        explicit = generate(self.config(physicsSampling='all'), 0)
        self.assertEqual(first, explicit)

    def test_finite_width_load_records_physical_width_and_resultant(self):
        scene = generate(self.config(conditions=1, loadTypes=['point'], pointLoadMode='patch',
            patchFraction=.2, minForce=100, maxForce=100), 0)[0]
        self.assertFalse(scene['pointLoads'])
        nodes = {n['id']: n for n in scene['geometryNodes']}
        curves = {c['id']: c for c in scene['curves']}
        for load, provenance in zip(scene['distributedLoads'], scene['dataGeneration']['finiteWidthLoads']):
            a, b = [nodes[n] for n in curves[load['curveId']]['geometryNodeIds']]
            length = ((b['x']-a['x'])**2+(b['y']-a['y'])**2)**.5
            width = length*(load['end']-load['start'])
            self.assertAlmostEqual(width, provenance['width'])
            self.assertAlmostEqual(load['q']*width, 100)
            for axis in ('x', 'y'):
                self.assertAlmostEqual(load['q']*width*load['direction'][axis], provenance['force'][axis])
                self.assertAlmostEqual(provenance['center'][axis], (a[axis]+b[axis])/2)

    def test_continuous_support_extends_only_adjacent_collinear_outer_edges(self):
        points = [(0,0),(1,0),(2,0),(2,1),(0,1)]
        base = {'geometryNodes':[{'id':f'G{i}', 'x':p[0], 'y':p[1], 'mechanicalState':'free'} for i,p in enumerate(points)],
            'curves':[{'id':f'C{i}', 'geometryNodeIds':[f'G{i}',f'G{(i+1)%5}'], 'mechanicalState':'free'} for i in range(5)],
            'regions':[{'id':'R1','isAir':False}], 'pointLoads':[], 'distributedLoads':[], 'bodyLoads':[],
            'dataGeneration':{'geometryIndex':0,'scale':2,'exteriorCurveIds':[f'C{i}' for i in range(5)]}}
        material = {'id':'M','elasticModulus':200,'poissonRatio':.3,'density':7850}
        seen = False
        for i in range(20):
            scene = condition(base, self.config(loadTypes=['point'], supportSampling='chain'), i, [material])
            supports = scene['dataGeneration']['supportCurveIds']
            if len(supports)>1:
                self.assertEqual(set(supports), {'C0','C1'})
                seen = True
        self.assertTrue(seen)


if __name__ == '__main__':
    unittest.main()
