"""Disposable real-data comparison. Reads user data; never saves trained weights."""
import argparse
import json
from pathlib import Path
import sys
import time

ROOT=Path(__file__).resolve().parents[1]/'python_machine_learning'
sys.path.insert(0,str(ROOT))
import torch
from graph_data import to_device
from model import MeshSizingNetwork,sizing_loss,sizing_metrics
from training_monitor import aggregate_metrics

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run',required=True)
parser.add_argument('--epochs',type=int,default=20)
parser.add_argument('--cases',type=int,default=12)
parser.add_argument('--output',type=Path)
args=parser.parse_args()
torch.set_num_threads(4)
device='cuda' if torch.cuda.is_available() else 'cpu'
meta=json.loads((ROOT/'storage/runs'/args.run/'metadata.json').read_text(encoding='utf-8'))
graphs={};groups={}
for split,ids in [('train',meta['trainIds'][:args.cases]),('validation',meta['validationIds'])]:
    graphs[split]=[]
    for ident in ids:
        directory=ROOT/'storage/datasets'/ident
        groups[ident]=json.loads((directory/'metadata.json').read_text(encoding='utf-8'))['group']
        for graph in torch.load(directory/'graphs.pt',weights_only=True)['graphs']:
            graphs[split].append((ident,to_device(graph,device)))
def evaluate(model,split):
    model.eval()
    with torch.inference_mode():
        result=aggregate_metrics([(groups[ident],ident,sizing_metrics(model(g),g)) for ident,g in graphs[split]])
    model.train()
    return {k:result[k] for k in ['loss','logMae','sizeFactor','groups','cases']} if result else None

report={'device':device,'epochs':args.epochs,'trainGraphs':len(graphs['train'])}
for version in (1,2):
    torch.manual_seed(42)
    model=MeshSizingNetwork(64,6,version).to(device)
    if version==2:model.fit_normalization(g for _,g in graphs['train'])
    optimizer=torch.optim.AdamW(model.parameters(),lr=.001,weight_decay=.0001,foreach=False)
    order_rng=torch.Generator().manual_seed(42)
    initial=evaluate(model,'train');start=time.perf_counter()
    history=[]
    for epoch in range(args.epochs):
        for index in torch.randperm(len(graphs['train']),generator=order_rng).tolist():
            _,g=graphs['train'][index]
            optimizer.zero_grad(set_to_none=True)
            loss=sizing_loss(model(g),g);loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(),1.,foreach=False)
            optimizer.step()
        row={'architecture':version,'epoch':epoch+1,'train':evaluate(model,'train'),'validation':evaluate(model,'validation')}
        history.append(row)
        if (epoch+1)%5==0:print(json.dumps(row),flush=True)
    best=min((row for row in history if row['validation']),key=lambda row:row['validation']['loss'],default=None)
    report[str(version)]={'initial':initial,'train':history[-1]['train'],'validation':history[-1]['validation'],'best':best,'history':history,'seconds':time.perf_counter()-start}
print(json.dumps(report,indent=2),flush=True)
if args.output:args.output.write_text(json.dumps(report,indent=2),encoding='utf-8')
