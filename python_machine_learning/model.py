"""Conditional multiscale message-passing network for element mesh sizes."""
import torch
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
    def __init__(self,width,edge_width):
        super().__init__()
        self.message = mlp(2*width+edge_width,width,width)
        self.update = mlp(2*width,width,width)
        self.norm = nn.LayerNorm(width)

    def forward(self,h,edges,features):
        source,target = edges
        messages = self.message(torch.cat((h[source],h[target],features),dim=-1))
        aggregated = mean_aggregate(messages,target,len(h))
        return self.norm(h+self.update(torch.cat((h,aggregated),dim=-1)))


class MeshSizingNetwork(nn.Module):
    def __init__(self,width=64,layers=6):
        super().__init__()
        self.config = {'width':width,'layers':layers}
        self.encoder = mlp(len(FEATURE_NAMES),width,width)
        self.blocks = nn.ModuleList([MessageBlock(width,5) for _ in range(layers)])
        self.coarse_blocks = nn.ModuleList([MessageBlock(width,0) for _ in range(2)])
        self.broadcast = mlp(2*width,width,width)
        self.decoder = mlp(width,width,1)
        # A neutral initial prediction is the present coarse size, not a random
        # mesh density spanning many orders of magnitude.
        nn.init.zeros_(self.decoder[-1].weight)
        nn.init.zeros_(self.decoder[-1].bias)

    def forward(self,graph):
        h = self.encoder(graph['x'])
        for index,block in enumerate(self.blocks):
            h = block(h,graph['edges'],graph['edge_features'])
            if index == len(self.blocks)//2:
                pool = graph['pool']
                coarse = mean_aggregate(h,pool,int(pool.max().item())+1)
                edges = graph['coarse_edges']
                empty_features = h.new_empty((edges.shape[1],0))
                for coarse_block in self.coarse_blocks:
                    coarse = coarse_block(coarse,edges,empty_features)
                h = h+self.broadcast(torch.cat((h,coarse[pool]),dim=-1))
        return (graph['current']+self.decoder(h).squeeze(-1)).clamp(-14,1)


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
