"""Lazy, bounded CPU graph storage; graph tensors are never copied into checkpoints."""
from collections import OrderedDict
from collections.abc import Mapping

import torch
from graph_data import FEATURE_VERSION


def tensor_bytes(value):
    if isinstance(value,torch.Tensor):return value.numel()*value.element_size()
    if isinstance(value,dict):return sum(tensor_bytes(v) for v in value.values())
    if isinstance(value,(tuple,list)):return sum(tensor_bytes(v) for v in value)
    return 0


class GraphStore(Mapping):
    def __init__(self,directory,identifiers,metadata,limit=256*1024**2):
        self.directory=directory;self.limit=limit;self.cache=OrderedDict();self.cached_bytes=0
        self._keys=[];self.locations={}
        for identifier in identifiers:
            count=metadata[identifier].get('variants')
            if type(count) is not int or count<1:
                count=len(self.read(identifier))
            for index in range(count):
                key=f'{identifier}:{index}'
                self._keys.append(key);self.locations[key]=(identifier,index)

    def read(self,identifier):
        payload=torch.load(self.directory/identifier/'graphs.pt',map_location='cpu',weights_only=True)
        if payload['version']!=FEATURE_VERSION:raise ValueError('样本特征版本不兼容，请重新导入。')
        if not payload.get('graphs'):raise ValueError('训练工况没有可用的训练图，请重新导入：'+identifier)
        return payload['graphs']

    def __getitem__(self,key):
        identifier,index=self.locations[key]
        if identifier in self.cache:
            graphs,size=self.cache.pop(identifier);self.cache[identifier]=(graphs,size)
        else:
            graphs=self.read(identifier);size=tensor_bytes(graphs)
            while self.cache and self.cached_bytes+size>self.limit:
                _,(_,removed)=self.cache.popitem(last=False);self.cached_bytes-=removed
            if size<=self.limit:
                self.cache[identifier]=(graphs,size);self.cached_bytes+=size
        if index>=len(graphs):raise ValueError('训练图数量与元数据不一致，请重新导入。')
        return graphs[index]

    def __iter__(self):return iter(self._keys)
    def __len__(self):return len(self._keys)

    def discard(self,identifiers):
        removed=set(identifiers)
        self._keys=[k for k in self._keys if self.locations[k][0] not in removed]
        self.locations={k:self.locations[k] for k in self._keys}
        for identifier in removed:
            old=self.cache.pop(identifier,None)
            if old:self.cached_bytes-=old[1]
