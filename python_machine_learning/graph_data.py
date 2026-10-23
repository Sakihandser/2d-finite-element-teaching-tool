"""Geometry/physics-only graph features and reference size-field supervision."""
import math

import numpy as np
import torch
from scipy.spatial import cKDTree

FEATURE_VERSION = 1
FEATURE_NAMES = [
    'x/L', 'y/L', 'log(h/L)', 'log(E/Pa)/10', 'nu', 'log1p(rho)/10',
    'fixed_fraction', 'boundary_distance/L', 'support_distance/L',
    'point_field_x', 'point_field_y', 'nearest_point_dx/L', 'nearest_point_dy/L',
    'point_distance/L', 'traction_field_x', 'traction_field_y', 'traction_distance/L',
    'body_x', 'body_y', 'log(force_scale)/10', 'log(reference_error)/5', 'width/L', 'height/L',
]


def mesh_arrays(mesh):
    nodes = np.asarray(mesh['nodes'], dtype=np.float64)
    triangles = np.asarray([cell['nodes'] for cell in mesh['cells']], dtype=np.int64)
    if nodes.ndim != 2 or nodes.shape[1] != 3 or triangles.ndim != 2 or triangles.shape[1] != 3:
        raise ValueError('节点或三角形数据不完整。')
    if not np.isfinite(nodes).all() or triangles.min() < 0 or triangles.max() >= len(nodes):
        raise ValueError('节点坐标或单元引用无效。')
    vertices = nodes[triangles, :2]
    u, v = vertices[:, 1]-vertices[:, 0], vertices[:, 2]-vertices[:, 0]
    areas = np.abs(u[:,0]*v[:,1]-u[:,1]*v[:,0]) / 2
    if not np.isfinite(areas).all() or (areas <= 0).any():
        raise ValueError('网格包含退化三角形。')
    return nodes, triangles, vertices, areas


def segment_distances(points, a, b):
    delta = b - a
    t = np.clip(((points - a) * delta).sum(axis=1) / max(float(delta @ delta), 1e-30), 0, 1)
    return np.linalg.norm(points - (a + t[:, None] * delta), axis=1)


def project_reference(points, regions, reference, length):
    """Seven-point log-size quadrature, with material-region-aware cell lookup.

    This projects a demonstration mesh; it is not a true error estimator.
    Nearest-centroid fallback handles different polygonal curve approximations.
    """
    _, _, vertices, areas = mesh_arrays(reference)
    centers = vertices.mean(axis=1)
    ref_regions = np.array([cell['region'] for cell in reference['cells']])
    size = np.log(np.sqrt(4 * areas / math.sqrt(3)) / length)
    values = np.empty(points.shape[:2])
    fallback = 0
    for region in np.unique(regions):
        selected = np.where(regions == region)[0]
        indices = np.where(ref_regions == region)[0]
        if not len(indices):
            raise ValueError(f'参考网格缺少区域 {region}，无法建立尺寸标签。')
        flat = points[selected].reshape(-1, 2)
        _, candidates = cKDTree(centers[indices]).query(flat, k=min(24, len(indices)))
        candidates = np.asarray(candidates).reshape(len(flat), -1)
        candidates = indices[candidates]
        v = vertices[candidates]
        a, b, c = v[:, :, 0], v[:, :, 1], v[:, :, 2]
        p = flat[:, None, :]
        cross = lambda u, w: u[..., 0] * w[..., 1] - u[..., 1] * w[..., 0]
        signs = np.stack([cross(b-a, p-a), cross(c-b, p-b), cross(a-c, p-c)], axis=-1)
        inside = (signs >= -1e-10 * length**2).all(-1) | (signs <= 1e-10 * length**2).all(-1)
        fallback += int((~inside.any(axis=1)).sum())
        chosen = candidates[np.arange(len(flat)), inside.argmax(axis=1)]
        values[selected] = size[chosen].reshape(len(selected), -1)
    return values.mean(axis=1), fallback


def reference_labels(vertices, regions, reference, length):
    """Shared supervision projection for training and the auditable preview."""
    barycentric = np.array([[1/3]*3,[.6,.2,.2],[.2,.6,.2],[.2,.2,.6],[.1,.45,.45],[.45,.1,.45],[.45,.45,.1]])
    points = np.einsum('qv,nvc->nqc',barycentric,vertices)
    return project_reference(points,regions,reference,length)


def preview_size_field(mesh, reference):
    """Reconstruct labels from JSON, without loading saved graphs or weights."""
    nodes, _, vertices, areas = mesh_arrays(mesh)
    length = float(np.ptp(nodes[:, :2], axis=0).max())
    labels, fallback = reference_labels(vertices, np.array([c['region'] for c in mesh['cells']]), reference, length)
    # Training stores log sizes as float32. Preserve that rounding in the preview.
    target = labels.astype(np.float32).astype(np.float64)
    current = np.log(np.sqrt(4 * areas / math.sqrt(3)) / length).astype(np.float32).astype(np.float64)
    return {'targetSize': (np.exp(target)*length).tolist(),
            'refinementRatio': np.exp(current-target).tolist(), 'projectionFallbacks': fallback}


def build_graph(mesh, geometry, reference=None, reference_error=0.05):
    nodes, triangles, vertices, areas = mesh_arrays(mesh)
    centers = vertices.mean(axis=1)
    lower, upper = nodes[:, :2].min(0), nodes[:, :2].max(0)
    span = upper - lower
    length = float(span.max())
    if not length > 0 or not 0 < reference_error < 1:
        raise ValueError('模型尺寸或参考误差无效。')
    regions = np.array([cell['region'] for cell in mesh['cells']])
    E = np.array([cell['E'] for cell in mesh['cells']])
    nu = np.array([cell['nu'] for cell in mesh['cells']])
    rho = np.array([cell['rho'] for cell in mesh['cells']])
    if (E <= 0).any() or (nu <= -1).any() or (nu >= .5).any() or (rho < 0).any():
        raise ValueError('材料参数无效。')
    current = np.log(np.sqrt(4 * areas / math.sqrt(3)) / length)
    boundary_d = np.full(len(centers), length)
    support_d = np.full(len(centers), length)
    traction_d = np.full(len(centers), length)
    traction_field = np.zeros_like(centers)
    traction_weight = np.zeros(len(centers))
    point_field = np.zeros_like(centers)
    point_delta = np.zeros_like(centers)
    point_d = np.full(len(centers), length)
    body = np.zeros_like(centers)
    loads = geometry.get('pointLoads') or []
    distributed = geometry.get('distributedLoads') or []
    force_scale = max([1e-30, *[math.hypot(f.get('fx',0), f.get('fy',0))/length for f in loads],
                       *[abs(q.get('qStart', q.get('q',0))) for q in distributed],
                       *[abs(q.get('qEnd', q.get('q',0))) for q in distributed]])
    for load in geometry.get('bodyLoads') or []:
        mask = np.ones(len(centers), dtype=bool) if load.get('targetType') != 'region' else regions == load.get('regionId')
        direction = load.get('direction') or {'x':0, 'y':-1}
        body[mask] += rho[mask, None] * float(load.get('magnitude',0)) * length * np.array([direction['x'], direction['y']])
    force_scale = max(force_scale, float(np.linalg.norm(body, axis=1).max()))
    for load in loads:
        anchor = load['anchor']
        delta = (centers - [anchor['x'], anchor['y']]) / length
        dist = np.linalg.norm(delta, axis=1)
        near = dist < point_d / length
        point_delta[near] = delta[near]
        point_d = np.minimum(point_d, dist * length)
        point_field += np.array([load.get('fx',0), load.get('fy',0)]) / (length * force_scale) / (1 + 20*dist[:, None])
    for edge in mesh['boundaries']:
        a, b = nodes[edge['nodes'], :2]
        distance = segment_distances(centers, a, b)
        boundary_d = np.minimum(boundary_d, distance)
        if edge['fixed']:
            support_d = np.minimum(support_d, distance)
        for load in distributed:
            if load['curveId'] != edge.get('curveId'):
                continue
            t0, t1 = sorted(edge['tRange'])
            start, end = sorted([load.get('start',0), load.get('end',1)])
            overlap = max(0, min(t1,end) - max(t0,start))
            if overlap <= 0:
                continue
            t = (max(t0,start) + min(t1,end)) / 2
            q0, q1 = load.get('qStart', load.get('q',0)), load.get('qEnd', load.get('q',0))
            q = q0 + (q1-q0) * (t-start) / max(end-start, 1e-30)
            d = load.get('direction') or {'x':0,'y':-1}
            weight = np.linalg.norm(b-a) * overlap / max(t1-t0,1e-30) / length / (.02 + distance/length)**2
            traction_field += weight[:,None] * q / force_scale * np.array([d['x'],d['y']])
            traction_weight += weight
            traction_d = np.minimum(traction_d, distance)
    # Fixed geometry points must be visible even when no whole boundary is fixed.
    for point in geometry.get('geometryNodes') or []:
        if point.get('mechanicalState') == 'static':
            support_d = np.minimum(support_d, np.linalg.norm(centers-[point['x'],point['y']],axis=1))
    traction_field /= np.maximum(traction_weight[:,None],1e-30)
    x = np.column_stack([(centers-(lower+upper)/2)/length, current,
        np.log(E)/10, nu, np.log1p(rho)/10, nodes[triangles,2].mean(axis=1),
        boundary_d/length, support_d/length, point_field, point_delta,
        point_d/length, traction_field, traction_d/length, body/force_scale,
        np.full(len(centers), math.log(force_scale)/10),
        np.full(len(centers), math.log(reference_error)/5), np.tile(span/length,(len(centers),1))])
    owners, adjacency = {}, []
    for index, refs in enumerate(triangles):
        for j in range(3):
            key = tuple(sorted((int(refs[j]),int(refs[(j+1)%3]))))
            if key in owners:
                other = owners[key]
                adjacency.extend([(index,other),(other,index)])
            else:
                owners[key] = index
    edges = np.array(adjacency, dtype=np.int64).reshape(-1,2).T
    source, target = edges
    relative = (centers[target]-centers[source])/length
    edge_features = np.column_stack([relative, np.linalg.norm(relative,axis=1),
        (regions[source] == regions[target]).astype(float), np.log(E[target]/E[source])/10])
    region_numbers = np.unique(regions,return_inverse=True)[1]
    bins = np.minimum(((centers-lower)/length*8).astype(int),7)
    _, pool = np.unique(np.column_stack([region_numbers,bins]),axis=0,return_inverse=True)
    coarse_edges = np.unique(pool[edges].T,axis=0)
    coarse_edges = coarse_edges[coarse_edges[:,0] != coarse_edges[:,1]].T
    if x.shape[1] != len(FEATURE_NAMES) or not np.isfinite(x).all() or not np.isfinite(edge_features).all():
        raise ValueError('图特征存在无效数值。')
    graph = {'x':torch.tensor(x,dtype=torch.float32), 'edges':torch.tensor(edges),
        'edge_features':torch.tensor(edge_features,dtype=torch.float32),
        'pool':torch.tensor(pool), 'pool_count':int(pool.max())+1, 'coarse_edges':torch.tensor(coarse_edges),
        'weight':torch.tensor(areas/areas.sum(),dtype=torch.float32),
        'current':torch.tensor(current,dtype=torch.float32), 'length':length}
    if reference is not None:
        labels, fallback = reference_labels(vertices,regions,reference,length)
        graph['y'] = torch.tensor(labels,dtype=torch.float32)
        graph['projection_fallback'] = fallback
    return graph


def to_device(graph, device):
    # Derive shape metadata on the CPU for legacy saved graphs too.
    if 'pool_count' not in graph:
        graph = {**graph,'pool_count':int(graph['pool'].max().item())+1}
    return {key: value.to(device) if isinstance(value,torch.Tensor) else value for key,value in graph.items()}
