import copy
import unittest

from shapely.geometry import Polygon
from shapely.ops import unary_union

from random_geometry import generate


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


if __name__ == '__main__':
    unittest.main()
