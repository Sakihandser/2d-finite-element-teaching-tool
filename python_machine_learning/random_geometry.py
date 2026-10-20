"""Independent random CAD/physics generator; coordinates m, E GPa, forces N.

The downloaded fea-diffusion sources are reading references, not dependencies.
Only Shapely is needed here; meshing and FEA use the application's own engines.
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import random
import sys

import shapely
from shapely import affinity, set_precision
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import polygonize, unary_union

ROOT = Path(__file__).resolve().parent.parent
# Match the application's 1e-6 region-node key. Finer decimal grids can put
# endpoints exactly on a key's half-step: interpolation then rounds the two
# adjacent edges differently and opens an otherwise closed hole contour.
GRID = 1e-6
SHAPES = ('rectangle', 'triangle', 'circle', 'ellipse', 'polygon')


def seeded(seed, *parts):
    digest = hashlib.sha256(json.dumps([str(seed), *parts]).encode()).digest()
    return random.Random(int.from_bytes(digest[:16], 'big'))


def primitive(rng, kind, x, y, size):
    w, h = size * rng.uniform(.65, 1.4), size * rng.uniform(.65, 1.4)
    if kind == 'rectangle':
        shape = box(-w/2, -h/2, w/2, h/2)
    elif kind == 'triangle':
        shape = Polygon([(-w/2, -h/3), (w/2, -h/3), (0, 2*h/3)])
    elif kind in ('circle', 'ellipse'):
        shape = Point(0, 0).buffer(1, quad_segs=6)
        shape = affinity.scale(shape, w/2, w/2 if kind == 'circle' else h/2)
    else:
        count = rng.randint(5, 8)
        angles = sorted(rng.uniform(0, math.tau) for _ in range(count))
        shape = Polygon([(math.cos(a)*w*rng.uniform(.35, .6),
                          math.sin(a)*h*rng.uniform(.35, .6)) for a in angles]).convex_hull
    angle = rng.uniform(0, 180)
    return set_precision(affinity.translate(affinity.rotate(shape, angle), x, y), GRID), {
        'type': kind, 'x': x, 'y': y, 'width': w, 'height': h, 'angle': angle}


def geometry(config, index):
    rng = seeded(config['seed'], 'geometry', index)
    kinds = config.get('shapes', list(SHAPES))
    scale = rng.uniform(config.get('minSize', 2), config.get('maxSize', 8))
    shape, descriptor = primitive(rng, rng.choice(kinds), 0, 0, scale)
    primitives = [descriptor]
    for _ in range(rng.randint(1, config.get('maxPrimitives', 4)) - 1):
        for _attempt in range(60):
            anchor = shape.exterior.interpolate(rng.random(), normalized=True)
            piece, descriptor = primitive(rng, rng.choice(kinds), anchor.x, anchor.y,
                                          scale * rng.uniform(.4, .8))
            combined = set_precision(shape.union(piece), GRID)
            if (combined.geom_type == 'Polygon' and not combined.interiors and
                    shape.intersection(piece).area > min(shape.area, piece.area)*.12 and
                    combined.area > shape.area*1.025):
                shape = combined
                primitives.append(descriptor)
                break
    # Straight, randomly oriented CAD cuts, accepted only if both sides have
    # meaningful area and a useful width. Cut before drilling so holes stay whole.
    parts = [shape]
    network = shape.boundary
    requested_regions = rng.randint(1, config.get('maxRegions', 4))
    for _ in range(80):
        if len(parts) >= requested_regions:
            break
        candidate = max(parts, key=lambda p: p.area)
        xmin, ymin, xmax, ymax = candidate.bounds
        p = Point(rng.uniform(xmin, xmax), rng.uniform(ymin, ymax))
        if not candidate.contains(p):
            continue
        a = rng.uniform(0, math.tau)
        reach = max(xmax-xmin, ymax-ymin)*3
        cutter = LineString([(p.x-math.cos(a)*reach, p.y-math.sin(a)*reach),
                             (p.x+math.cos(a)*reach, p.y+math.sin(a)*reach)])
        # Add one full line to a single global graph. Splitting polygons one at
        # a time and rounding their edges independently can open shared borders.
        proposed = unary_union(set_precision(unary_union([network, cutter]), GRID))
        children = [p for p in polygonize(proposed)
                    if shape.buffer(GRID*2).covers(p.representative_point())]
        if (len(parts) < len(children) <= requested_regions and
                all(q.area > shape.area*.055 and not q.buffer(-scale*.025).is_empty for q in children)):
            parts = children
            network = unary_union([p.boundary for p in parts])
    # Snap the complete planar line graph together, then recover its faces.
    # Rounding each child polygon separately can leave microscopic gaps at a
    # material junction, or create short spurious edges in a neighbour's ring.
    holes = []
    target_holes = rng.randint(0, config.get('maxHoles', 2))
    for _ in range(100):
        if len(holes) >= target_holes:
            break
        owner = rng.choice(parts)
        xmin, ymin, xmax, ymax = owner.bounds
        x, y = rng.uniform(xmin, xmax), rng.uniform(ymin, ymax)
        hole, descriptor = primitive(rng, rng.choice(['circle', 'ellipse', 'rectangle']),
                                     x, y, scale*rng.uniform(.07, .20))
        if (owner.contains(hole.buffer(scale*.035)) and
                all(hole.distance(h) > scale*.04 for h in holes)):
            holes.append(hole)
    parts = [p.difference(unary_union(holes)) for p in parts]
    solid = unary_union(parts)
    if solid.geom_type != 'Polygon' or not solid.is_valid or solid.area <= 0:
        raise ValueError('随机几何合并后不连通或无效。')
    # Node ALL shared interfaces before assigning IDs; no coincident duplicate
    # curves, dangling intersections, or incompatible material meshes.
    linework = unary_union([p.boundary for p in parts])
    nodes, curves, segments, by_point = [], [], [], {}

    def node(coordinate):
        key = tuple(round(v, 6) for v in coordinate)
        if key not in by_point:
            identifier = f'G{len(nodes)+1}'
            by_point[key] = identifier
            nodes.append({'id': identifier, 'x': key[0], 'y': key[1], 'mechanicalState': 'free'})
        return by_point[key]

    lines = list(linework.geoms) if hasattr(linework, 'geoms') else [linework]
    seen = set()
    for line in lines:
        for a, b in zip(line.coords, list(line.coords)[1:]):
            ids = [node(a), node(b)]
            key = tuple(sorted(ids))
            if key in seen or ids[0] == ids[1]:
                continue
            seen.add(key)
            segment = LineString([a, b])
            curves.append({'id': f'C{len(curves)+1}', 'type': 'line',
                           'geometryNodeIds': ids, 'controls': [], 'mechanicalState': 'free'})
            segments.append(segment)
    regions = []
    for polygon, air in [(p, False) for p in parts] + [(h, True) for h in holes]:
        ring = LineString(polygon.exterior.coords)
        ids = [c['id'] for c, segment in zip(curves, segments)
               if ring.distance(segment.interpolate(.5, normalized=True)) < GRID*.1]
        if len(ids) < 3:
            raise ValueError('区域边界编码失败。')
        regions.append({'id': f'R{len(regions)+1}', 'boundaryCurveIds': ids,
                        'regionKind': 'air' if air else 'structure', 'isAir': air,
                        'polygon': [{'x': x, 'y': y} for x, y in polygon.exterior.coords[:-1]],
                        'area': polygon.area, 'material': None})
    outer = LineString(shape.exterior.coords)
    exterior_ids = [c['id'] for c, segment in zip(curves, segments)
                    if outer.distance(segment.interpolate(.5, normalized=True)) < GRID*2
                    and segment.length > scale*.025]
    if len(exterior_ids) < 3:
        raise ValueError('没有足够的外边界施加支撑和载荷。')
    return {'version': 6, 'name': '', 'geometryNodes': nodes, 'curves': curves, 'regions': regions,
            'pointLoads': [], 'distributedLoads': [], 'bodyLoads': [], 'analysisNodes': [],
            'mesh': {'elements': [], 'metadata': None},
            'dataGeneration': {'version': 1, 'algorithm': 'random-cad-v2', 'seed': str(config['seed']),
                               'pythonVersion': sys.version.split()[0], 'shapelyVersion': shapely.__version__,
                               'geometryIndex': index, 'primitives': primitives, 'holes': len(holes),
                               'regions': len(parts), 'solidArea': solid.area,
                               'exteriorCurveIds': exterior_ids, 'scale': scale}}


def condition(base, config, case_index, materials):
    scene = copy.deepcopy(base)
    meta = scene['dataGeneration']
    rng = seeded(config['seed'], 'physics', meta['geometryIndex'], case_index)
    materials = [m for m in materials if isinstance(m.get('elasticModulus'), (float, int))
                 and m['elasticModulus'] > 0 and isinstance(m.get('poissonRatio'), (float, int))
                 and -1 < m['poissonRatio'] < .49 and (m.get('density') or 0) > 0]
    if config.get('materialIds'):
        materials = [m for m in materials if m['id'] in config['materialIds']]
    if not materials:
        raise ValueError('材料库中没有可用于生成的有效各向同性材料。')
    for r in scene['regions']:
        if not r['isAir']:
            r['material'] = copy.deepcopy(rng.choice(materials))
    by_id = {n['id']: n for n in scene['geometryNodes']}
    exterior = [c for c in scene['curves'] if c['id'] in meta['exteriorCurveIds']]
    lengths = lambda c: math.dist(*[(by_id[n]['x'], by_id[n]['y']) for n in c['geometryNodeIds']])
    # A full nonzero edge fixes both displacement components at >=2 distinct
    # nodes, removing all 2D rigid-body modes on this connected solid.
    support = rng.choice(sorted(exterior, key=lengths, reverse=True)[:max(1, len(exterior)//2)])
    support['mechanicalState'] = 'static'
    fixed = set(support['geometryNodeIds'])
    for n in scene['geometryNodes']:
        if n['id'] in fixed:
            n['mechanicalState'] = 'static'
    free_edges = [c for c in exterior if c['id'] != support['id']]
    free_nodes = sorted({n for c in free_edges for n in c['geometryNodeIds']} - fixed)
    types = config.get('loadTypes', ['point', 'distributed', 'body'])
    for kind in types:
        angle = rng.uniform(0, math.tau)
        direction = {'x': math.cos(angle), 'y': math.sin(angle)}
        magnitude = math.exp(rng.uniform(math.log(config.get('minForce', 100)),
                                         math.log(config.get('maxForce', 10000))))
        if kind == 'point':
            for _ in range(rng.randint(1, min(3, len(free_nodes)))):
                identifier = rng.choice(free_nodes)
                n = by_id[identifier]
                scene['pointLoads'].append({'id': f'F{len(scene["pointLoads"])+1}',
                    'geometryNodeId': identifier, 'anchor': {'x': n['x'], 'y': n['y']},
                    'fx': magnitude*direction['x'], 'fy': magnitude*direction['y'], 'label': 'F'})
        elif kind == 'distributed':
            curve = rng.choice(free_edges)
            scene['distributedLoads'].append({'id': 'Q1', 'curveId': curve['id'],
                'q': magnitude, 'qStart': magnitude, 'qEnd': magnitude*rng.uniform(.1, 1.8),
                'direction': direction, 'start': 0, 'end': 1, 'label': 'q'})
        elif kind == 'body':
            region = rng.choice([r for r in scene['regions'] if not r['isAir']])
            regional = rng.random() < .5
            scene['bodyLoads'].append({'id': 'B1', 'targetType': 'region' if regional else 'global',
                'regionId': region['id'] if regional else None, 'magnitude': rng.uniform(1, 20),
                'direction': direction, 'label': 'g'})
    meta['caseIndex'] = case_index
    scene['name'] = f'随机模型 {config["seed"]} / G{meta["geometryIndex"]+1} / C{case_index+1}'
    return scene


def generate(config, index):
    materials = config.get('materials')
    if materials is None:
        materials = json.loads((ROOT/'materials/materials.json').read_text(encoding='utf-8'))['materials']
    base = geometry(config, index)
    return [condition(base, config, j, materials) for j in range(config.get('conditions', 1))]


if __name__ == '__main__':
    request = json.load(sys.stdin)
    try:
        json.dump(generate(request['config'], request.get('index', 0)), sys.stdout, ensure_ascii=True, allow_nan=False)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
