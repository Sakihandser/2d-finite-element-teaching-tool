"""Disconnected graph batches and exact symmetries of isotropic 2D elasticity."""
import torch


def symmetry_graph(graph, transform):
    """D4: rotate/reflect positions AND all vector features; scalar labels stay fixed.

    The graph is already centered and length-normalized. Connectivity and spatial
    pool membership remain valid under a rigid transformation. Never mutate cache.
    """
    if transform == 0:
        return graph
    x = graph['x'].clone()
    edge = graph['edge_features'].clone()
    # Every directional feature in FEATURE_NAMES; material/support/distance,
    # force magnitude and requested accuracy are scalar invariants.
    pairs = [(0,1),(9,10),(11,12),(14,15),(17,18)]
    if transform >= 4:
        for a,_ in pairs: x[:,a] = -x[:,a]
        edge[:,0] = -edge[:,0]
    turns = transform % 4
    for _ in range(turns):
        for a,b in pairs:
            first = x[:,a].clone()
            x[:,a] = -x[:,b]; x[:,b] = first
        first = edge[:,0].clone()
        edge[:,0] = -edge[:,1]; edge[:,1] = first
    if turns % 2:
        x[:,[21,22]] = x[:,[22,21]]
    return {**graph,'x':x,'edge_features':edge}


def pack_graphs(graphs, coefficients=None):
    """One disconnected graph; loss equals the mean of weighted per-graph losses.

    Area and edge losses are normalized WITHIN each input graph. In particular,
    a fine mesh cannot dominate a batch just because it has more triangles.
    """
    if coefficients is None: coefficients = [1.] * len(graphs)
    if not graphs or len(coefficients) != len(graphs):
        raise ValueError('无效的训练批次。')
    fields = {k:[] for k in ['x','edges','edge_features','pool','coarse_edges','current','weight','y','loss_weight','edge_loss_weight']}
    nodes = pools = 0
    for graph,coefficient in zip(graphs,coefficients):
        factor = coefficient / len(graphs)
        for key in ['x','edge_features','current','weight','y']:
            fields[key].append(graph[key])
        fields['edges'].append(graph['edges']+nodes)
        fields['pool'].append(graph['pool']+pools)
        fields['coarse_edges'].append(graph['coarse_edges']+pools)
        importance = graph['weight']*(1+(graph['current']-graph['y']).clamp(0,3))
        fields['loss_weight'].append(importance/importance.sum()*factor)
        count = graph['edges'].shape[1]
        fields['edge_loss_weight'].append(graph['weight'].new_full((count,),factor/max(1,count)))
        nodes += len(graph['x'])
        count = graph.get('pool_count')
        pools += count if count is not None else int(graph['pool'].max())+1
    result = {key:torch.cat(items,dim=1 if key in ('edges','coarse_edges') else 0) for key,items in fields.items()}
    result['pool_count'] = pools
    return result
