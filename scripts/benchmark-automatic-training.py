"""Try automatic training on copies; original run/dataset files stay untouched."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python_machine_learning'))
from worker import TrainingService, STORE

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run',required=True)
parser.add_argument('--epochs',type=int,default=24)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
source=json.loads((STORE/'runs'/args.run/'metadata.json').read_text(encoding='utf-8'))
with tempfile.TemporaryDirectory(prefix='fem-auto-training-') as temporary:
    directory=Path(temporary)
    shutil.copytree(STORE/'runs'/args.run,directory/'runs'/args.run,ignore=shutil.ignore_patterns('*.lock'))
    for ident in source['trainIds']+source['validationIds']:
        target=directory/'datasets'/ident;target.mkdir(parents=True)
        for name in ['metadata.json','graphs.pt']:shutil.copy2(STORE/'datasets'/ident/name,target/name)
    service=TrainingService(directory)
    service.restore_checkpoint({'runId':args.run,'checkpointFile':source['bestCheckpointFile']})
    service.launch=lambda:None
    service.resume({'runId':service.state['id'],'datasetIds':source['trainIds']+source['validationIds'],
        'additionalEpochs':args.epochs,'adaptiveTraining':True,'automaticRecovery':True})
    start=time.perf_counter();service.train()
    state=service.state
    assert state['status']=='completed',state.get('error')
    best=service.load_checkpoint(state['id'],state['bestCheckpointFile'])
    import torch
    for key,value in best['network'].items():
        torch.testing.assert_close(service.model.state_dict()[key].cpu(),value,rtol=0,atol=0)
    report={'sourceRun':args.run,'sourceBestValidationLoss':source['bestValidationLoss'],
        'device':str(service.device),'seconds':time.perf_counter()-start,'status':state['status'],
        'stopReason':state['stopReason'],'epoch':state['epoch'],'bestValidationLoss':state['bestValidationLoss'],
        'finalValidationLoss':state['validationLoss'],'finalWeightsEqualBest':True,
        'adjustments':state.get('adjustments',[]),'monitor':state.get('monitor'),
        'history':state['history'],'events':service.events}
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({key:value for key,value in report.items() if key not in ['events','history']},ensure_ascii=True,indent=2))
