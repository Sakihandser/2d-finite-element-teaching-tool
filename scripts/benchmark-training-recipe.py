"""Compare training recipes on temporary copies of one real checkpoint/split."""
import argparse
import json
from pathlib import Path
import random
import shutil
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python_machine_learning'))
import numpy as np
import torch
from worker import TrainingService, STORE


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',required=True)
    parser.add_argument('--epochs',type=int,default=24)
    parser.add_argument('--seeds',type=int,nargs='+',default=[42,43])
    parser.add_argument('--continuous',action='store_true',help='Bounded real continuous-mode smoke test; pauses after the requested total epochs')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.epochs<1:parser.error('--epochs must be positive')
    source=json.loads((STORE/'runs'/args.run/'metadata.json').read_text(encoding='utf-8'))
    report={'sourceRun':args.run,'sourceBestValidationLoss':source['bestValidationLoss'],
        'epochsPerTrial':args.epochs,'trials':[],
        'scope':'Same restored best weights, selected split and graph exposures; finite mode isolates batching and augmentation. Validation is used for model selection, not an unseen test set.'}
    report['continuousSmokeTest']=args.continuous
    recipes=[('continuous-batched-symmetry',4,True)] if args.continuous else [('previous',1,False),('batched-symmetry',4,True)]
    for seed in args.seeds:
        for name,batch,augmentation in recipes:
            with tempfile.TemporaryDirectory(prefix='fem-recipe-') as temporary:
                directory=Path(temporary)
                shutil.copytree(STORE/'runs'/args.run,directory/'runs'/args.run,ignore=shutil.ignore_patterns('*.lock'))
                for identifier in source['trainIds']+source['validationIds']:
                    target=directory/'datasets'/identifier;target.mkdir(parents=True)
                    for file in ['metadata.json','graphs.pt']:shutil.copy2(STORE/'datasets'/identifier/file,target/file)
                service=TrainingService(directory)
                service.restore_checkpoint({'runId':args.run,'checkpointFile':source['bestCheckpointFile']})
                service.launch=lambda:None
                service.resume({'runId':service.state['id'],'datasetIds':source['trainIds']+source['validationIds'],
                    'additionalEpochs':6 if args.continuous else args.epochs,'adaptiveTraining':True,'automaticRecovery':True,
                    'continuousTraining':args.continuous,'earlyStoppingPatience':0,'batchGraphs':batch,
                    'symmetryAugmentation':augmentation})
                random.seed(seed);np.random.seed(seed);torch.manual_seed(seed)
                if service.device.type=='cuda':torch.cuda.manual_seed_all(seed)
                initial_epoch=service.state['epoch'];initial_step=service.state['step']
                if args.continuous:
                    save=service.save
                    def save_and_pause(*a,**kw):
                        result=save(*a,**kw)
                        if service.state['epoch']>=initial_epoch+args.epochs:service.stop.set()
                        return result
                    service.save=save_and_pause
                start=time.perf_counter();service.train();elapsed=time.perf_counter()-start
                state=service.state
                expected_status='paused' if args.continuous else 'completed'
                if state['status']!=expected_status:raise RuntimeError(state.get('error'))
                best=service.load_checkpoint(state['id'],state['bestCheckpointFile'])
                equal=all(torch.equal(service.model.state_dict()[key].cpu(),value) for key,value in best['network'].items())
                if not args.continuous:assert equal
                trial={'recipe':name,'seed':seed,'device':str(service.device),'seconds':elapsed,
                    'completedEpochs':state['epoch']-initial_epoch,'graphExposures':state['step']-initial_step,
                    'optimizerSteps':state.get('optimizerSteps',0),'bestValidationLoss':state['bestValidationLoss'],
                    'finalTrainingLoss':state['loss'],'finalValidationLoss':state['validationLoss'],
                    'finalWeightsEqualBest':equal,'stopReason':state['stopReason'],'cycles':state.get('trainingCycle',0),
                    'adjustments':state.get('adjustments',[]),'history':state['history']}
                report['trials'].append(trial)
                args.output.parent.mkdir(parents=True,exist_ok=True)
                args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
                print(json.dumps({key:value for key,value in trial.items() if key not in ['history','adjustments']},ensure_ascii=True),flush=True)
                service.release_run()


if __name__=='__main__':main()
