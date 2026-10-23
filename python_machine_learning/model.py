"""Conditional multiscale message-passing network for element mesh sizes."""
import torch
import math
from torch import nn
from graph_data import FEATURE_NAMES


def mlp(inputs, width, outputs):
    return nn.Sequential(nn.Linear(inputs,width),nn.SiLU(),nn.Linear(width,outputs))


def mean_aggregate(values, destinations, count):
    output = values.new_zeros((count,values.shape[-1]))
    output.index_add_(0,destinations,values)
    degree = values.new_zeros(count).index_add_(0,destinations,values.new_ones(len(destinations)))
    return output / degree.clamp_min(1)[:,None]


class MessageBlock(nn.Module):
    def __init__(self,width,edge_width,residual_scale=None):
        super().__init__()
        self.message = mlp(2*width+edge_width,width,width)
        self.update = mlp(2*width,width,width)
        self.norm = nn.LayerNorm(width)
        self.residual_scale = residual_scale

    def forward(self,h,edges,features):
        residual = h
        if self.residual_scale is not None:
            h = self.norm(h)
        source,target = edges
        # DirectML rejects concatenation with a zero-width tensor. Coarse
        # propagation has no edge features; its mathematical input is just h.
        if edges.shape[1]:
            inputs = (h[source],h[target],features) if features.shape[1] else (h[source],h[target])
            messages = self.message(torch.cat(inputs,dim=-1))
            aggregated = mean_aggregate(messages,target,len(h))
        else:
            aggregated = h.new_zeros(h.shape)
        update = self.update(torch.cat((h,aggregated),dim=-1))
        if self.residual_scale is not None:
            return residual+self.residual_scale*update
        return self.norm(h+update)


class MeshSizingNetwork(nn.Module):
    def __init__(self,width=64,layers=6,architecture=1):
        super().__init__()
        if architecture not in (1,2):
            raise ValueError('未知网络结构版本。')
        self.config = {'width':width,'layers':layers,'architecture':architecture}
        self.architecture = architecture
        self.regularization_dropout = 0.
        if architecture == 2:
            self.register_buffer('feature_mean',torch.zeros(len(FEATURE_NAMES)))
            self.register_buffer('feature_scale',torch.ones(len(FEATURE_NAMES)))
        self.encoder = mlp(len(FEATURE_NAMES),width,width)
        scale = 1/math.sqrt(layers+2) if architecture == 2 else None
        self.blocks = nn.ModuleList([MessageBlock(width,5,scale) for _ in range(layers)])
        self.coarse_blocks = nn.ModuleList([MessageBlock(width,0,scale) for _ in range(2)])
        self.broadcast = mlp(2*width,width,width)
        self.decoder = mlp(width+(len(FEATURE_NAMES) if architecture == 2 else 0),width,1)
        # A neutral initial prediction is the present coarse size, not a random
        # mesh density spanning many orders of magnitude.
        nn.init.zeros_(self.decoder[-1].weight)
        nn.init.zeros_(self.decoder[-1].bias)

    @torch.no_grad()
    def fit_normalization(self,graphs):
        """Training graphs only; buffers travel with checkpoints and stay fixed on resume."""
        if self.architecture != 2: return
        mean = torch.zeros(len(FEATURE_NAMES),dtype=torch.float64)
        square = torch.zeros_like(mean)
        count = 0
        for graph in graphs:
            x = graph['x'].double().cpu()
            weight = graph['weight'].double().cpu()
            weight = weight/weight.sum()
            mean += (x*weight[:,None]).sum(0)
            square += (x.square()*weight[:,None]).sum(0)
            count += 1
        if not count: raise ValueError('没有训练图可用于特征标准化。')
        mean /= count
        scale = (square/count-mean.square()).clamp_min(0).sqrt()
        # Constant fields retain meaningful changes on unseen load cases.
        scale = torch.where(scale<1e-4,torch.ones_like(scale),scale)
        self.feature_mean.copy_(mean)
        self.feature_scale.copy_(scale)

    def forward(self,graph):
        x = graph['x']
        if self.architecture == 2:
            x = ((x-self.feature_mean)/self.feature_scale).clamp(-10,10)
        h = self.encoder(x)
        h = torch.nn.functional.dropout(h,p=self.regularization_dropout,training=self.training)
        for index,block in enumerate(self.blocks):
            h = block(h,graph['edges'],graph['edge_features'])
            if index == len(self.blocks)//2:
                pool = graph['pool']
                count = graph.get('pool_count')
                if count is None: count = int(pool.max().item())+1
                coarse = mean_aggregate(h,pool,count)
                edges = graph['coarse_edges']
                empty_features = h.new_empty((edges.shape[1],0))
                for coarse_block in self.coarse_blocks:
                    coarse = coarse_block(coarse,edges,empty_features)
                h = h+self.broadcast(torch.cat((h,coarse[pool]),dim=-1))*(1/math.sqrt(len(self.blocks)+2) if self.architecture == 2 else 1)
        # Direct local-feature path cannot be erased by graph propagation.
        decoded = torch.cat((h,x),dim=-1) if self.architecture == 2 else h
        return (graph['current']+self.decoder(decoded).squeeze(-1)).clamp(-14,1)


def sizing_loss(prediction,graph):
    # Area weighting prevents a dense reference patch from dominating solely
    # because it has many cells; refinement weighting retains concentrated zones.
    importance = 1+(graph['current']-graph['y']).clamp(0,3)
    weight = graph['weight']*importance
    loss = (torch.nn.functional.smooth_l1_loss(prediction,graph['y'],reduction='none')*weight).sum()/weight.sum()
    source,target = graph['edges']
    if len(source):
        loss = loss+.05*torch.nn.functional.smooth_l1_loss(prediction[source]-prediction[target], graph['y'][source]-graph['y'][target])
    return loss


@torch.no_grad()
def sizing_metrics(prediction, graph):
    """Label agreement, not a finite-element accuracy or efficiency verdict."""
    weight=graph['weight']/graph['weight'].sum()
    difference=prediction-graph['y']
    residual=prediction-graph['current']
    target_residual=graph['y']-graph['current']
    threshold=math.log(1.25)
    values=torch.stack([sizing_loss(prediction,graph),sizing_loss(graph['current'],graph),
        (difference.abs()*weight).sum(),(difference*weight).sum(),
        ((difference>threshold).to(weight.dtype)*weight).sum(),
        ((difference< -threshold).to(weight.dtype)*weight).sum(),
        ((residual-(residual*weight).sum()).square()*weight).sum().sqrt(),
        ((target_residual-(target_residual*weight).sum()).square()*weight).sum().sqrt()]).cpu().tolist()
    result=dict(zip(('loss','baselineLoss','logMae','logBias','coarserFraction','finerFraction','residualStd','targetResidualStd'),values))
    result['sizeFactor']=math.exp(min(result['logMae'],20))
    return result
