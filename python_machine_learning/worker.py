"""Local JSON-lines training service. stdout is reserved for protocol messages."""
import copy
import gc
from contextlib import contextmanager
from collections import Counter, OrderedDict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import random
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid

import numpy as np
import torch

from graph_data import FEATURE_VERSION, build_graph, mesh_arrays, to_device
from model import MeshSizingNetwork, sizing_loss, sizing_metrics
from training_monitor import aggregate_metrics, update_monitor
from model_management import ModelManager, checkpoint_name
from dataset_management import DatasetManager
from device_runtime import cpu_tensors, environment_report, select_device
from mesh_runtime import MeshSession
from graph_store import GraphStore
from unattended_runtime import keep_awake
from training_batches import pack_graphs, symmetry_graph

ROOT = Path(__file__).resolve().parent
STORE = Path(os.environ.get('FEM_ML_STORAGE', ROOT / 'storage')).resolve()
NODE = os.environ.get('FEM_NODE', str(ROOT.parent / 'node-v24.21.0-win-x64' / 'node.exe'))


def now():
    return datetime.now(timezone.utc).isoformat()


def replace_retry(source, destination):
    # Windows sync clients and virus scanners can temporarily hold a closed file.
    deadline=time.monotonic()+8
    while True:
        try:
            os.replace(source,destination)
            return
        except PermissionError:
            if time.monotonic()>=deadline: raise
            time.sleep(.1)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as output:
            json.dump(value, output, ensure_ascii=False, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        replace_retry(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_checkpoint(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    try:
        with temporary.open('wb') as output:
            torch.save(value, output)
            output.flush()
            os.fsync(output.fileno())
        # A previous complete generation remains available if the latest file
        # cannot be read after a disk or synchronization failure.
        if path.exists():
            replace_retry(path, path.with_suffix('.previous.pt'))
        replace_retry(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def valid_id(value):
    value = str(value)
    if not value or len(value)>80 or any(c not in '0123456789abcdef-' for c in value):
        raise ValueError('无效的记录编号。')
    return value


def number(value, default, low, high, integer=False):
    result = float(default if value is None else value)
    if not math.isfinite(result) or not low <= result <= high or (integer and not result.is_integer()):
        raise ValueError(f'参数必须在 {low}–{high} 范围内。')
    return int(result) if integer else result


class TrainingService:
    def __init__(self, store=STORE):
        self.store = Path(store)
        for directory in ['datasets','runs','predictions','incoming']:
            (self.store/directory).mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.save_requested = threading.Event()
        self.thread = None
        self.model = self.optimizer = None
        self.scheduler = None
        self.graphs = {}
        self.device_graphs = OrderedDict()
        self.device_graph_bytes = 0
        self.state = None
        self.device, self.device_info = select_device(os.environ.get('FEM_ML_DEVICE','auto'),
            int(os.environ['FEM_ML_DEVICE_INDEX']) if 'FEM_ML_DEVICE_INDEX' in os.environ else None,
            verify_training=os.environ.get('FEM_ML_RUNTIME_VERIFIED') != '1')
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        self.events = []
        if self.device_info['backend'] == 'cpu':
            self.event('当前使用 CPU；未发现通过网络训练自检的 GPU 后端，或已指定 CPU。')
        elif self.device_info['backend'] == 'directml':
            self.event('当前使用 DirectML；部分图聚合算子会在 CPU 执行，速度取决于显卡与图规模。')
        self.run_lock = None
        self.legacy_run_lock = None
        self.manager = ModelManager(self)
        self.datasets = DatasetManager(self)

    def acquire_run(self, identifier, allow_missing=False):
        identifier=valid_id(identifier)
        directory=self.store/'runs'/identifier
        locks=self.store/'locks'
        locks.mkdir(exist_ok=True)
        handles=[]
        try:
            # A stable lock outside the run allows its entire directory to be
            # removed on Windows without losing exclusion between processes.
            for path in [locks/(identifier+'.lock'), directory/'training.lock']:
                if path.parent == directory and (not directory.is_dir() or (not allow_missing and not (directory/'metadata.json').is_file())):
                    raise ValueError('模型记录不存在。')
                handle=path.open('a+b')
                handles.append(handle)
                if handle.tell()==0: handle.write(b'0'); handle.flush()
                handle.seek(0)
                if os.name=='nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            for handle in reversed(handles): handle.close()
            raise ValueError('该训练记录已被另一程序实例使用，请先在该实例中暂停。')
        except Exception:
            for handle in reversed(handles): handle.close()
            raise
        self.run_lock,self.legacy_run_lock=handles

    def release_legacy_run(self):
        if self.legacy_run_lock:
            self.legacy_run_lock.close()
            self.legacy_run_lock=None

    def release_run(self):
        self.release_legacy_run()
        if self.run_lock:
            self.run_lock.close()
            self.run_lock=None

    def event(self, message):
        with self.lock:
            self.events.append({'at':now(),'message':str(message)})
            self.events = self.events[-100:]

    def records(self, category):
        records = []
        for path in (self.store/category).glob('*/metadata.json'):
            try:
                record = json.loads(path.read_text(encoding='utf-8'))
                if category == 'runs' and (not self.state or record['id'] != self.state['id']):
                    saved=path.with_name('checkpoint-metadata.json')
                    if saved.exists(): record=json.loads(saved.read_text(encoding='utf-8'))
                    record['status'] = (record['status'] if record.get('status') in ['ready','paused','completed'] else 'recoverable') if self.checkpoint_exists(record['id']) else 'unavailable'
                records.append(record)
            except (OSError, ValueError):
                continue
        return sorted(records,key=lambda r:r.get('createdAt',''),reverse=True)

    def checkpoint_exists(self, run):
        directory = self.store/'runs'/valid_id(run)
        return any(directory.glob('checkpoint-*.pt')) or any((directory/name).exists() for name in ['latest.pt','latest.previous.pt'])

    def busy(self):
        return self.thread is not None and self.thread.is_alive()

    def idle(self):
        if self.busy():
            raise ValueError('请先暂停训练，待保存完成后再执行此操作。')

    def status(self):
        with self.lock:
            current = copy.deepcopy(self.state)
            datasets = self.records('datasets')
            runs = self.records('runs')
            return {'current':current,'datasets':datasets,'runs':runs,'events':self.events[-30:],
                'environment':{**environment_report(self.device,self.device_info),
                    'runtimeDiagnostics':json.loads(os.environ.get('FEM_ML_RUNTIME_DIAGNOSTICS','[]'))},
                'storage':str(self.store)}

    def mesh_command(self, command, source, destination):
        result = subprocess.run([NODE,str(ROOT/'mesh-worker.cjs'),command,str(source),str(destination)],
            cwd=ROOT.parent, capture_output=True, encoding='utf-8', errors='replace', timeout=240,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        if result.returncode:
            raise ValueError((result.stderr or result.stdout or '网格准备失败。')[-3000:])
        return json.loads(Path(destination).read_text(encoding='utf-8'))

    def import_sample(self, payload):
        self.idle()
        source = Path(payload['path']).expanduser().resolve()
        if not source.is_file() or source.suffix.lower() != '.json':
            raise ValueError('请选择有效的模型 JSON 文件。')
        split = payload.get('split','train')
        if split not in ['train','validation']:
            raise ValueError('样本用途必须是训练或验证。')
        self.event('正在从几何重新生成粗网格并提取参考尺寸标签。')
        with tempfile.TemporaryDirectory(dir=self.store/'incoming') as temporary:
            prepared = self.mesh_command('prepare',source,Path(temporary)/'prepared.json')
        for existing in self.records('datasets'):
            if existing['fingerprint'] == prepared['fingerprint']:
                self.event('该工况已存在，已跳过重复导入。')
                return {'duplicate':True,'sample':existing}
            if existing['group'] == prepared['group'] and existing['split'] != split:
                raise ValueError('相同几何的载荷工况必须放在同一组，不能跨训练集和验证集。')
        error = prepared['referenceError']
        if error is None or error <= 0 or error >= 1:
            error = number(payload.get('referenceError'),.05,1e-6,.999)
            precision_source = 'user-assumed'
        else:
            precision_source = 'zz-achieved'
        identifier = uuid.uuid4().hex
        directory = self.store/'datasets'/identifier
        directory.mkdir()
        try:
            graphs = [build_graph(mesh,prepared['geometry'],prepared['reference'],error) for mesh in prepared['meshes']]
            atomic_checkpoint(directory/'graphs.pt',{'version':FEATURE_VERSION,'graphs':graphs})
            # Compact auditable geometry/reference; never save model results as features.
            atomic_json(directory/'reference.json',prepared)
            metadata = {'id':identifier,'name':str(payload.get('name') or prepared['name']),
                'createdAt':now(),'split':split,'group':prepared['group'],'fingerprint':prepared['fingerprint'],
                'variants':len(graphs),'inputElements':[len(g['x']) for g in graphs],
                'referenceNodes':len(prepared['reference']['nodes']), 'referenceElements':len(prepared['reference']['cells']),
                'referenceError':error,'precisionSource':precision_source,'requestedError':prepared['requestedError'],
                'stopReason':prepared['stopReason'],'projectionFallbacks':sum(g.get('projection_fallback',0) for g in graphs),
                'featureVersion':FEATURE_VERSION,'dataGeneration':prepared.get('provenance')}
            atomic_json(directory/'metadata.json',metadata)
        except Exception:
            # No metadata means the partially prepared record is never selectable.
            raise
        self.event(f'已导入 {metadata["name"]}：1 个工况，{len(graphs)} 张独立粗网格。')
        return {'sample':metadata,'duplicate':False}

    def select_datasets(self, identifiers):
        if not isinstance(identifiers, list):
            raise ValueError('训练工况选择必须是列表。')
        available = {sample['id']:sample for sample in self.records('datasets')}
        missing = [valid_id(identifier) for identifier in identifiers if valid_id(identifier) not in available]
        if missing:
            raise ValueError('所选训练工况已删除或缺失，请刷新数据列表重新勾选：'+', '.join(missing))
        selected = [available[valid_id(identifier)] for identifier in dict.fromkeys(identifiers)]
        train = [s['id'] for s in selected if s['split']=='train']
        validation = [s['id'] for s in selected if s['split']=='validation']
        if not train:
            raise ValueError('请至少选择一个训练工况。')
        train_groups = {available[i]['group'] for i in train}
        if any(available[i]['group'] in train_groups for i in validation):
            raise ValueError('训练集与验证集存在相同几何，不能开始训练。')
        return train, validation

    def load_graphs(self):
        self.graphs = {}
        self.device_graphs = OrderedDict()
        self.device_graph_bytes = 0
        self.dataset_metadata={sample['id']:sample for sample in self.records('datasets')}
        missing = [identifier for identifier in self.state['trainIds']+self.state['validationIds']
                   if not (self.store/'datasets'/valid_id(identifier)/'graphs.pt').is_file()]
        if missing:
            raise ValueError('训练工况文件已删除或缺失，无法继续训练：'+', '.join(missing))
        self.graphs=GraphStore(self.store/'datasets',self.state['trainIds']+self.state['validationIds'],self.dataset_metadata)
        keys=[key for key in self.graphs if key.split(':')[0] in self.state['trainIds']]
        groups={key:self.dataset_metadata[key.split(':')[0]].get('group',key.split(':')[0]) for key in keys}
        case_groups={key.split(':')[0]:group for key,group in groups.items()}
        cases_per_group=Counter(case_groups.values())
        graphs_per_case=Counter(key.split(':')[0] for key in keys)
        self.graph_weights={key:len(keys)/(len(cases_per_group)*cases_per_group[group]*graphs_per_case[key.split(':')[0]])
            for key,group in groups.items()}

    def training_graph(self,key):
        if key in self.device_graphs:
            self.device_graphs.move_to_end(key)
            return self.device_graphs[key]
        stored = self.graphs[key]
        size = sum(v.numel()*v.element_size() for v in stored.values() if isinstance(v,torch.Tensor))
        limit = 256*1024**2 if self.device.type == 'cuda' else 0
        while self.device_graphs and self.device_graph_bytes+size > limit:
            _,old = self.device_graphs.popitem(last=False)
            self.device_graph_bytes -= sum(v.numel()*v.element_size() for v in old.values() if isinstance(v,torch.Tensor))
        graph = to_device(stored,self.device)
        if limit and size <= limit:
            self.device_graphs[key] = graph
            self.device_graph_bytes += size
        return graph

    def setup_scheduler(self):
        config=self.state['config']
        self.scheduler=torch.optim.lr_scheduler.ReduceLROnPlateau(self.optimizer,mode='min',factor=.5,
            patience=config.get('lrPatience',8),threshold=config.get('minDelta',.0001),threshold_mode='abs',
            min_lr=min(config.get('minLearningRate',1e-6),self.optimizer.param_groups[0]['lr']))

    def training_options(self, payload):
        return {'adaptiveTraining':payload.get('adaptiveTraining',True) is True,
            'continuousTraining':payload.get('continuousTraining',False) is True,
            'batchGraphs':number(payload.get('batchGraphs'),4,1,32,True),
            'maxBatchElements':number(payload.get('maxBatchElements'),12000,100,100000,True),
            'symmetryAugmentation':payload.get('symmetryAugmentation',True) is True,
            'unattendedTraining':payload.get('unattendedTraining',True) is True,
            'automaticRecovery':payload.get('automaticRecovery',True) is True,
            'maxRecoveryAttempts':number(payload.get('maxRecoveryAttempts'),3,0,20,True),
            'recoveryPatience':number(payload.get('recoveryPatience'),3,2,1000,True),
            'lrPatience':number(payload.get('lrPatience'),8,1,1000,True),
            'earlyStoppingPatience':number(payload.get('earlyStoppingPatience'),25,0,10000,True),
            'minDelta':number(payload.get('minDelta'),.0001,0,1),
            'minLearningRate':number(payload.get('minLearningRate'),1e-6,1e-8,.1)}

    def reset_monitor(self):
        self.state['monitor']={}
        self.state['phaseStartEpoch']=self.state['epoch']
        self.state['trainingMetrics']=self.state['validationMetrics']=None
        self.state['diagnostics']=None
        self.state['stopReason']=None
        self.state['validationBaselinePending']=True
        self.state['cycleStartEpoch']=self.state['epoch']
        self.state['cyclePeakRate']=float(self.optimizer.param_groups[0]['lr'])
        self.setup_scheduler()

    def cycle_learning_rate(self):
        if not self.state['config'].get('continuousTraining'):return
        config=self.state['config']
        duration=config.get('cycleEpochs',100)
        progress=min(1.,max(0.,(self.state['epoch']-self.state.get('cycleStartEpoch',self.state['epoch']))/duration))
        peak=self.state.get('cyclePeakRate',float(self.optimizer.param_groups[0]['lr']))
        floor=min(peak,config.get('minLearningRate',1e-6))
        rate=floor+.5*(peak-floor)*(1+math.cos(math.pi*progress))
        for group in self.optimizer.param_groups:group['lr']=rate

    def restart_training_cycle(self,reason):
        """Keep the best held-out model across cycles; never rewind data counters/RNG."""
        config=self.state['config']
        cycle=self.state.get('trainingCycle',0)+1
        # Explore bounded rates rather than repeatedly restoring the original
        # aggressive rate or decaying to a permanently ineffective floor.
        peak=max(config.get('minLearningRate',1e-6),config['learningRate']*(.25,.1,.05)[(cycle-1)%3])
        restored=self.recover_best(rate=peak,reason='overfitting' if reason=='overfitting' else 'cycle')
        if not restored:
            self.optimizer=torch.optim.AdamW(self.model.parameters(),lr=peak,
                weight_decay=float(self.optimizer.param_groups[0].get('weight_decay',.0001)),foreach=False)
            self.setup_scheduler()
            self.state['phase']=self.state.get('phase',0)+1
        self.state.update(trainingCycle=cycle,cycleStartEpoch=self.state['epoch'],cyclePeakRate=peak)
        monitor=self.state.setdefault('monitor',{})
        monitor.update(recoveryAttempts=0,badEpochs=0,overfitEpochs=0,lrReductions=0,lastRecoveryEpoch=self.state['epoch'])
        if self.state['epoch']>=config['epochs']:
            config['epochs']=self.state['epoch']+config.get('cycleEpochs',100)
        self.state['stopReason']=None
        self.state['cycleReason']=reason
        if self.state.get('diagnostics'):
            self.state['diagnostics'].update(action='cycle-restarted',trainingCycle=cycle+1,recoveryAttempts=0,continuousTraining=True,earlyStoppingEnabled=False)
        self.event(f'持续训练进入第 {cycle+1} 个周期（{reason}），保留全程最佳模型。')

    def next_training_batch(self):
        config=self.state['config'];keys=[];graphs=[];elements=0
        remaining=self.state['order'][self.state['cursor']:]
        for key in remaining[:config.get('batchGraphs',1)]:
            size=len(self.graphs[key]['x'])
            if keys and elements+size>config.get('maxBatchElements',12000):break
            keys.append(key);elements+=size
            graph=self.training_graph(key)
            if config.get('symmetryAugmentation',False):graph=symmetry_graph(graph,random.randrange(8))
            graphs.append(graph)
        if len(graphs)==1:
            return keys,graphs[0],self.graph_weights.get(keys[0],1.)
        return keys,pack_graphs(graphs,[self.graph_weights.get(key,1.) for key in keys]),1.

    def initialize_validation_baseline(self):
        """Restored weights are candidates before the first new optimizer step."""
        if not self.state.get('validationBaselinePending'): return
        if self.state['step']<1 or self.validation_integrity()!='independent':
            self.state['validationBaselinePending']=False
            return
        training=self.evaluate_split(self.state['trainIds'])
        validation=self.evaluate_split(self.state['validationIds'])
        self.state.update(trainingMetrics=training,validationMetrics=validation,
            loss=training['loss'],validationLoss=validation['loss'])
        best=self.state.get('bestValidationLoss')
        improved=best is None or validation['loss']<best
        if improved:self.state['bestValidationLoss']=validation['loss']
        monitor=self.state.setdefault('monitor',{})
        best_training=training['loss']
        if not improved and self.state.get('bestCheckpointFile'):
            saved=self.load_checkpoint(self.state['id'],self.state['bestCheckpointFile'])['state']
            saved_loss=(saved.get('trainingMetrics') or {}).get('loss',saved.get('loss'))
            if saved_loss is not None:best_training=saved_loss
        monitor.update(best=self.state['bestValidationLoss'],bestTrainLoss=best_training,badEpochs=0)
        self.state['validationBaselinePending']=False
        if improved:self.save(best=True)

    def recover_best(self,rate=None,reason='plateau',final=False):
        """Change weights/optimizer only; counters, RNG and retry budget stay monotonic."""
        filename=self.state.get('bestCheckpointFile')
        if not filename or self.validation_integrity()!='independent':return False
        checkpoint=self.load_checkpoint(self.state['id'],filename)
        saved=checkpoint['state']
        if (set(saved['trainIds'])!=set(self.state['trainIds']) or
                set(saved['validationIds'])!=set(self.state['validationIds'])):
            raise ValueError('最佳检查点的数据划分与当前训练不一致，无法自动恢复。')
        previous_rate=float(self.optimizer.param_groups[0]['lr'])
        decay=float(self.optimizer.param_groups[0].get('weight_decay',.0001))
        self.model.load_state_dict(checkpoint['network'])
        if final:
            self.optimizer.load_state_dict(checkpoint['optimizer'])
            # Do not revive the large rate or weaker regularization from an
            # early checkpoint when the user later resumes this completed run.
            for group in self.optimizer.param_groups:
                group.update(lr=previous_rate,weight_decay=decay,foreach=False)
        else:
            rate=rate if rate is not None else max(self.state['config'].get('minLearningRate',1e-6),previous_rate*.5)
            if reason=='overfitting':decay=min(.01,max(decay*5,.0005))
            self.optimizer=torch.optim.AdamW(self.model.parameters(),lr=rate,weight_decay=decay,foreach=False)
        self.setup_scheduler()
        monitor=self.state.setdefault('monitor',{})
        self.scheduler.best=self.state['bestValidationLoss']
        if not final:
            monitor['recoveryAttempts']=monitor.get('recoveryAttempts',0)+1
            monitor['lastRecoveryEpoch']=self.state['epoch'];monitor['overfitEpochs']=0;monitor['badEpochs']=0
            monitor['lrReductions']=monitor.get('lrReductions',0)+int(rate<previous_rate)
            self.state['phase']=self.state.get('phase',0)+1
            if reason=='overfitting':
                self.state['regularizationDropout']=min(.2,self.state.get('regularizationDropout',0.)+.05)
        self.model.regularization_dropout=self.state.get('regularizationDropout',0.)
        training=self.evaluate_split(self.state['trainIds'])
        validation=self.evaluate_split(self.state['validationIds'])
        monitor['bestTrainLoss']=training['loss']
        self.state.update(trainingMetrics=training,validationMetrics=validation,loss=training['loss'],
            validationLoss=validation['loss'],activeWeightSource={'checkpointFile':filename,
            'epoch':saved['epoch'],'step':saved['step'],'reason':'final-best' if final else reason})
        diagnostic=self.state.setdefault('diagnostics',{}) or {}
        diagnostic.update(learningRate=self.optimizer.param_groups[0]['lr'],weightDecay=decay,
            recoveryAttempts=monitor.get('recoveryAttempts',0),dropout=self.model.regularization_dropout,
            trainingGroups=training['groups'],validationGroups=validation['groups'],
            validationIntegrity='independent',automaticRecovery=True,smallValidation=validation['groups']<3,
            action='best-restored' if final else 'recovered-best')
        self.state['diagnostics']=diagnostic
        if not final:
            self.state.setdefault('adjustments',[]).append({'epoch':self.state['epoch'],'step':self.state['step'],
                'reason':reason,'source':filename,'learningRate':self.optimizer.param_groups[0]['lr'],
                'weightDecay':decay,'dropout':self.model.regularization_dropout,'attempt':monitor['recoveryAttempts'],'at':now()})
            self.state['adjustments']=self.state['adjustments'][-100:]
            self.event('已自动恢复最佳验证权重，降低学习率后重试。')
        return True

    def persist_state(self):
        with self.lock:
            self.storage_operation(lambda:atomic_json(self.store/'runs'/self.state['id']/'metadata.json',self.state))

    def storage_operation(self,operation):
        attempts=3 if self.state['config'].get('unattendedTraining',False) else 1
        for attempt in range(attempts):
            try:return operation()
            except (OSError,RuntimeError) as error:
                transient=isinstance(error,OSError) or 'file write failed' in str(error).lower()
                if not transient or attempt+1==attempts:raise
                self.event('文件访问暂时失败，正在自动重试保存。')
                self.stop.wait(2**attempt)

    def save(self, best=False):
        with self.lock:
            state = copy.deepcopy(self.state)
            state['lastSavedAt'] = now()
            state['lastSavedStep'] = state['step']
            state['checkpointFile'] = f'checkpoint-{state["step"]:012d}-{time.time_ns()}.pt'
            if best: state['bestCheckpointFile']=state['checkpointFile']
        checkpoint = {'version':FEATURE_VERSION,'backend':self.device_info['backend'],'state':state,'network':self.model.state_dict(),
            'optimizer':self.optimizer.state_dict(),'pythonRng':random.getstate(),
            'numpyRng':[np.random.get_state()[0],np.random.get_state()[1].tolist(),*np.random.get_state()[2:]],
            'torchRng':torch.get_rng_state(),
            'cudaRng':torch.cuda.get_rng_state_all() if self.device.type=='cuda' else []}
        if self.scheduler is not None: checkpoint['scheduler']=self.scheduler.state_dict()
        directory=self.store/'runs'/state['id']
        # Never replace a checkpoint that OneDrive may still be uploading.
        # A small metadata pointer plus scanning the last complete generations
        # supports recovery even if the process exits before updating metadata.
        serialized=cpu_tensors(checkpoint)
        self.storage_operation(lambda:atomic_checkpoint(directory/state['checkpointFile'],serialized))
        with self.lock:
            self.state['lastSavedAt']=state['lastSavedAt']
            self.state['lastSavedStep']=state['lastSavedStep']
            self.state['checkpointFile']=state['checkpointFile']
            if best: self.state['bestCheckpointFile']=state['checkpointFile']
        self.persist_state()
        self.storage_operation(lambda:atomic_json(directory/'checkpoint-metadata.json',self.state))
        previous=sorted(directory.glob('checkpoint-*.pt'),reverse=True)
        for old in previous[3:]:
            if old.name==self.state.get('bestCheckpointFile'): continue
            try: old.unlink(missing_ok=True)
            except OSError: pass

    def start(self,payload):
        self.idle()
        requested=payload.get('device','auto')
        if requested not in ('auto', self.device_info['backend'], self.device.type):
            raise ValueError('请求的计算设备与当前后端不匹配，请重启服务后选择相应环境。')
        train,validation = self.select_datasets(payload.get('datasetIds',[]))
        config = {'epochs':number(payload.get('epochs'),100,1,100000,True),
            'learningRate':number(payload.get('learningRate'),.001,1e-7,.1),
            'width':number(payload.get('width'),64,16,128,True),
            'layers':number(payload.get('layers'),6,2,10,True),
            'autosaveSeconds':number(payload.get('autosaveSeconds'),60,10,3600,True),
            'weightDecay':number(payload.get('weightDecay'),.0001,0,.1),**self.training_options(payload)}
        config['architecture']=2
        config['cycleEpochs']=config['epochs']
        random.seed(42); np.random.seed(42); torch.manual_seed(42)
        self.model = MeshSizingNetwork(config['width'],config['layers'],config.get('architecture',1)).to(self.device)
        self.optimizer = torch.optim.AdamW(self.model.parameters(),lr=config['learningRate'],weight_decay=config['weightDecay'],foreach=False)
        identifier = uuid.uuid4().hex
        self.state = {'id':identifier,'name':str(payload.get('name') or '网格尺寸学习'),
            'createdAt':now(),'status':'starting','config':config,'trainIds':train,'validationIds':validation,
            'step':0,'epoch':0,'cursor':0,'order':[],'epochLossSum':0.,'epochLossCount':0,
            'samplesSeen':0,'elementsSeen':0,'seenIds':[],'loss':None,'validationLoss':None,
            'bestValidationLoss':None,'history':[],'lastSavedAt':None,'lastSavedStep':0,'error':None,
            'featureVersion':FEATURE_VERSION,'elapsedSeconds':0.,'metricVersion':2,'phase':0,
            'learnedGroups':[],'regularizationDropout':.05 if config['symmetryAugmentation'] else 0.}
        self.model.regularization_dropout=self.state['regularizationDropout']
        self.reset_monitor()
        (self.store/'runs'/identifier).mkdir()
        self.load_graphs()
        self.model.fit_normalization(self.graphs[key] for key in self.graphs if key.split(':')[0] in train)
        self.save()
        self.launch()
        return {'id':identifier}

    def load_checkpoint(self,identifier,filename=None):
        directory = self.store/'runs'/valid_id(identifier)
        failures = []
        names=[checkpoint_name(filename)] if filename else [path.name for path in sorted(directory.glob('checkpoint-*.pt'),reverse=True)]+['latest.pt','latest.previous.pt']
        for index,name in enumerate(names):
            try:
                checkpoint = torch.load(directory/name,map_location='cpu',weights_only=True)
                if checkpoint['version'] != FEATURE_VERSION:
                    raise ValueError('检查点特征版本不兼容。')
                if index:
                    self.event('最新检查点无法读取，已恢复上一份完整检查点。')
                # A rename applies to all generations without rewriting tensors.
                metadata = self.manager.metadata(directory)
                checkpoint['state']['name'] = metadata['name']
                checkpoint['state']['checkpointFile'] = name
                best = checkpoint['state'].get('bestCheckpointFile')
                if best and not (directory/checkpoint_name(best)).is_file():
                    checkpoint['state']['bestCheckpointFile'] = None
                    checkpoint['state']['bestValidationLoss'] = None
                return checkpoint
            except Exception as error:
                failures.append(str(error))
        raise ValueError('无法恢复检查点：'+'; '.join(failures))

    def restore(self,identifier,filename=None,load_datasets=True):
        checkpoint = self.load_checkpoint(identifier,filename)
        self.state = checkpoint['state']
        config = self.state['config']
        if self.state.get('runtimeCpuFallback') and config.get('unattendedTraining'):
            self.device=torch.device('cpu')
            self.device_info={'backend':'cpu','gpu':None,'device':'cpu','deviceName':'CPU','deviceIndex':0,
                'diagnostics':['显存不足后已自动切换 CPU，训练速度可能降低。']}
        self.model = MeshSizingNetwork(config['width'],config['layers'],config.get('architecture',1)).to(self.device)
        self.model.load_state_dict(checkpoint['network'])
        self.model.regularization_dropout=self.state.get('regularizationDropout',0.)
        self.optimizer = torch.optim.AdamW(self.model.parameters(),lr=config['learningRate'],foreach=False)
        self.setup_scheduler()
        self.optimizer.load_state_dict(checkpoint['optimizer'])
        if checkpoint.get('scheduler'): self.scheduler.load_state_dict(checkpoint['scheduler'])
        for group in self.optimizer.param_groups: group['foreach']=False
        random.setstate(checkpoint['pythonRng'])
        rng = checkpoint['numpyRng']
        np.random.set_state((rng[0],np.array(rng[1],dtype=np.uint32),*rng[2:]))
        torch.set_rng_state(checkpoint['torchRng'])
        if self.device.type=='cuda' and checkpoint.get('cudaRng') and checkpoint.get('backend','cuda')==self.device_info['backend']:
            try:
                torch.cuda.set_rng_state_all(checkpoint['cudaRng'][:torch.cuda.device_count()])
            except (RuntimeError, TypeError):
                self.event('原 GPU 随机状态与当前设备不兼容，保留模型和优化器并使用当前随机状态。')
        if load_datasets:
            self.load_graphs()

    @contextmanager
    def preparing_training(self):
        """Failed preparation must not publish a phantom active run to the UI."""
        fields = ['state','model','optimizer','scheduler','graphs','dataset_metadata','graph_weights','thread','device_graphs','device_graph_bytes']
        previous = {key:getattr(self,key) for key in fields if hasattr(self,key)}
        rng = (random.getstate(),np.random.get_state(),torch.get_rng_state(),
               torch.cuda.get_rng_state_all() if self.device.type=='cuda' else None)
        try:
            yield
        except Exception:
            if not self.busy():
                self.release_run()
                for key in fields:
                    if key in previous: setattr(self,key,previous[key])
                    elif hasattr(self,key): delattr(self,key)
                random.setstate(rng[0]);np.random.set_state(rng[1]);torch.set_rng_state(rng[2])
                if rng[3] is not None: torch.cuda.set_rng_state_all(rng[3])
            raise

    def restore_checkpoint(self,payload):
        """Restore weights into a persistent idle branch; old data is optional."""
        self.idle()
        identifier=valid_id(payload.get('runId'))
        filename=checkpoint_name(payload.get('checkpointFile'))
        with self.preparing_training():
            self.acquire_run(identifier)
            try:
                self.restore(identifier,filename,load_datasets=False)
                available={sample['id']:sample for sample in self.records('datasets')}
                learned=set(self.state.get('learnedGroups',[]))
                learned.update(available[i].get('group',i) for i in self.state.get('seenIds',[]) if i in available)
                incomplete=self.state.get('trainingHistoryIncomplete',False) or (
                    'learnedGroups' not in self.state and any(i not in available for i in self.state.get('seenIds',[])))
                self.state.update(id=uuid.uuid4().hex,createdAt=now(),status='ready',error=None,
                    name=(self.state['name'][:70]+f' · step {self.state["step"]}')[:100],
                    parentRunId=identifier,parentCheckpoint=filename,
                    weightSource={'runId':identifier,'checkpointFile':filename,'step':self.state['step'],'epoch':self.state['epoch']},
                    trainIds=[],validationIds=[],order=[],cursor=0,epochLossSum=0.,epochLossCount=0,
                    dataSelectionPending=True,learnedGroups=sorted(learned),trainingHistoryIncomplete=incomplete,
                    bestCheckpointFile=None,bestValidationLoss=None,loss=None,validationLoss=None,stepLoss=None,
                    metricVersion=2,phase=self.state.get('phase',0)+1)
                # This is a fresh training phase from saved weights, not a replay
                # of the old data cursor or Adam momentum on removed samples.
                self.state['config']['epochs']=self.state['epoch']
                self.optimizer=torch.optim.AdamW(self.model.parameters(),lr=self.state['config']['learningRate'],
                    weight_decay=self.state['config'].get('weightDecay',.0001),foreach=False)
                self.reset_monitor();self.graphs={};self.dataset_metadata={};self.graph_weights={}
                self.release_run()
                (self.store/'runs'/self.state['id']).mkdir()
                self.acquire_run(self.state['id'],allow_missing=True)
                self.save()
            finally:
                self.release_run()
        self.event('检查点权重已恢复为独立记录；尚未启动训练，请勾选当前训练数据后点击“继续训练”。')
        return {'id':self.state['id'],'status':'ready','source':self.state['weightSource']}

    def resume(self,payload):
        self.idle()
        identifier=payload.get('runId') or (self.state or {}).get('id')
        with self.preparing_training():
            self.acquire_run(identifier)
            return self.resume_locked(payload,identifier)

    def resume_locked(self,payload,identifier):
        # Select the current data before loading any graph from an old checkpoint.
        self.restore(identifier,payload.get('checkpointFile'),load_datasets=False)
        pending=self.state.get('dataSelectionPending',False)
        reset=self.state.get('metricVersion')!=2
        # Legacy checkpoints keep their settings unless the caller opts into
        # adaptive control. Optimizer and random states remain recoverable.
        options=self.training_options({**self.state['config'],**payload})
        if 'additionalEpochs' in payload:
            self.state['config']['cycleEpochs']=number(payload['additionalEpochs'],100,1,100000,True)
        reset_best=reset
        previous_stop=self.state.get('stopReason')
        # Upgrade old runs to automatic recovery without changing their data
        # baseline or reviving the learning rate from the configuration field.
        self.state['config'].update({key:value for key,value in options.items() if key not in self.state['config']})
        if any(key in payload for key in options):
            reset |= any(self.state['config'].get(key)!=value for key,value in options.items())
            self.state['config'].update(options)
        old = self.state['trainIds']+self.state['validationIds']
        selected=payload['datasetIds'] if 'datasetIds' in payload else old
        train,validation = self.select_datasets(selected)
        if set(train) != set(self.state['trainIds']) or set(validation) != set(self.state['validationIds']):
            reset=True
            reset_best=True
            added_training=set(train)-set(self.state['trainIds'])
            moved = set(self.state['trainIds']).intersection(validation) | set(self.state['validationIds']).intersection(train)
            self.state['trainIds'],self.state['validationIds'] = train,validation
            self.state['bestValidationLoss'] = None
            self.state['bestCheckpointFile'] = None
            self.state['validationLoss'] = None
            if 'datasetIds' in payload:
                self.state.update(order=[],cursor=0,epochLossSum=0.,epochLossCount=0)
            elif moved:
                # A saved mid-epoch order must never optimize a case that
                # has since been reassigned to validation.
                order=self.state['order'];cursor=self.state['cursor'];allowed=set(train)
                consumed=[key for key in order[:cursor] if key.split(':')[0] in allowed]
                remaining=[key for key in order[cursor:] if key.split(':')[0] in allowed]
                self.state['order']=consumed+remaining;self.state['cursor']=len(consumed)
            if added_training and self.state['order'] and self.state['epoch']+1>=self.state['config']['epochs']:
                self.state['config']['epochs']=self.state['epoch']+2
            if 'datasetIds' in payload and 'additionalEpochs' in payload:
                self.state['config']['epochs']=self.state['epoch']+number(payload['additionalEpochs'],100,1,100000,True)
            self.event('已按当前勾选和学习用途更新训练集与验证集。')
        self.load_graphs()
        self.state['dataSelectionPending']=False
        if 'learningRate' in payload:
            rate=number(payload['learningRate'],.001,1e-7,.1)
            if rate != self.state['config']['learningRate']:
                reset=True;self.state['config']['learningRate']=rate
                for group in self.optimizer.param_groups: group['lr']=rate
        if reset:
            self.state['phase']=self.state.get('phase',0)+1
            self.state['metricVersion']=2
            if reset_best:
                self.state['bestValidationLoss']=None;self.state['bestCheckpointFile']=None
            self.reset_monitor()
        elif self.state.get('stopReason')=='early-stopping':
            if not self.state['config'].get('automaticRecovery',False):
                self.reset_monitor()
                self.state['phase']=self.state.get('phase',0)+1
        if (previous_stop=='early-stopping' and self.state['config'].get('adaptiveTraining') and
                not self.state['config'].get('continuousTraining',False) and
                self.state['config'].get('automaticRecovery') and self.state.get('bestCheckpointFile') and
                self.state.get('monitor',{}).get('recoveryAttempts',0)<self.state['config'].get('maxRecoveryAttempts',3)):
            self.state['recoverBeforeTraining']=True
        if pending:
            self.state['config']['epochs']=self.state['epoch']+number(payload.get('additionalEpochs'),100,1,100000,True)
        elif self.state['epoch'] >= self.state['config']['epochs']:
            self.state['config']['epochs'] += number(payload.get('additionalEpochs'),100,1,100000,True)
        if payload.get('checkpointFile'):
            # Validate sample/epoch changes before creating the branch directory.
            # Preserve the source run and every later checkpoint when rewinding.
            self.release_run()
            self.state.update(id=uuid.uuid4().hex, createdAt=now(),
                name=(self.state['name'][:70]+f' · step {self.state["step"]}')[:100],
                parentRunId=identifier, parentCheckpoint=payload['checkpointFile'], bestCheckpointFile=None, bestValidationLoss=None)
            self.state['validationBaselinePending']=True
            (self.store/'runs'/self.state['id']).mkdir()
        self.state.update(error=None,status='paused')
        self.save()
        self.launch()
        return {'id':self.state['id']}

    def launch(self):
        if self.run_lock is None: self.acquire_run(self.state['id'])
        self.stop.clear(); self.save_requested.clear()
        self.state.pop('serviceInterrupted',None)
        self.state['status'] = 'training'
        self.state['stopReason'] = None
        # Persist the running intent before acknowledging start/resume. Even a
        # crash before the first timed autosave must be recoverable by Node.
        self.save()
        self.thread = threading.Thread(target=self.train,name='mesh-training',daemon=False)
        self.thread.start()
        self.event('训练已在 '+str(self.device)+' 上开始。')

    def control(self,command):
        if not self.state:
            raise ValueError('尚无训练任务。')
        if command=='pause' and self.busy():
            self.state.pop('serviceInterrupted',None)
            self.stop.set()
            with self.lock:
                self.state['status'] = 'pausing'
            return {'requested':True}
        if command=='save' and self.busy():
            self.save_requested.set()
            return {'requested':True,'step':self.state['step']}
        if command=='save':
            if self.state['status']=='failed': raise ValueError('请先从完整检查点恢复，再保存训练。')
            self.event('当前检查点已保存。')
        return {'saved':True}

    def evaluate_split(self, identifiers):
        selected=set(identifiers)
        rows=[]
        mode=self.model.training
        self.model.eval()
        try:
            with torch.no_grad():
                for key in self.graphs:
                    sample=key.split(':')[0]
                    if sample not in selected: continue
                    graph=self.training_graph(key)
                    metrics=sizing_metrics(self.model(graph),graph)
                    if not all(math.isfinite(value) for value in metrics.values()):
                        raise ValueError('评估指标出现非有限值，已停止训练。')
                    rows.append((self.dataset_metadata[sample].get('group',sample),sample,metrics))
        finally: self.model.train(mode)
        return aggregate_metrics(rows)

    def evaluate(self):
        metrics=self.evaluate_split(self.state['validationIds'])
        return metrics['loss'] if metrics else None

    def validation_integrity(self):
        if not self.state['validationIds']: return 'none'
        learned=set(self.state.get('learnedGroups',[]))
        learned.update(self.dataset_metadata[i].get('group',i) for i in self.state.get('seenIds',[]) if i in self.dataset_metadata)
        heldout={self.dataset_metadata[i].get('group',i) for i in self.state['validationIds']}
        return 'previously-trained' if learned.intersection(heldout) else 'unknown' if self.state.get('trainingHistoryIncomplete') else 'independent'

    def train(self):
        def awake_status(active):
            self._sleep_prevented=active
            self.state['sleepPrevented']=active
        try:
            with keep_awake(self.state['config'].get('unattendedTraining',False),awake_status):
                while True:
                    self._training_failure=None
                    self.train_once()
                    if self._training_failure is None:break
                    if not self.recover_runtime(self._training_failure):break
        finally:
            try:self.persist_state()
            except (OSError,RuntimeError):pass
            finally:self.release_run()

    def recover_runtime(self,error):
        if self.stop.is_set() or not self.state['config'].get('unattendedTraining',False):return False
        attempts=self.state.get('runtimeRecoveryAttempts',0)
        message=str(error).lower()
        oom=isinstance(error,torch.cuda.OutOfMemoryError) or 'cuda out of memory' in message
        numeric='non-finite' in message or 'nonfinite' in message or '非有限' in message
        if attempts>=2 or not (oom or numeric):return False
        if oom and (self.device.type!='cuda' or self.state.get('runtimeCpuFallback')):return False
        previous_rate=float(self.optimizer.param_groups[0]['lr'])
        floor=self.state['config'].get('minLearningRate',1e-6)
        if numeric and previous_rate<=floor:return False
        identifier=self.state['id']
        recovery_history=copy.deepcopy(self.state.get('runtimeRecoveries',[]))
        fell_back=bool(self.state.get('runtimeCpuFallback')) or oom
        try:
            if oom:
                self.model=self.optimizer=self.scheduler=None
                self.device_graphs.clear();self.device_graph_bytes=0
                gc.collect();torch.cuda.empty_cache()
                self.device=torch.device('cpu')
                self.device_info={'backend':'cpu','gpu':None,'device':'cpu','deviceName':'CPU','deviceIndex':0,
                    'diagnostics':['显存不足后已自动切换 CPU，训练速度可能降低。']}
            filename=None
            if numeric:
                def finite(value):
                    if isinstance(value,torch.Tensor):return not value.is_floating_point() or bool(torch.isfinite(value).all())
                    if isinstance(value,dict):return all(finite(v) for v in value.values())
                    if isinstance(value,(list,tuple)):return all(finite(v) for v in value)
                    return True
                for path in sorted((self.store/'runs'/identifier).glob('checkpoint-*.pt'),reverse=True):
                    try:checkpoint=self.load_checkpoint(identifier,path.name)
                    except ValueError:continue
                    if finite(checkpoint['network']) and finite(checkpoint['optimizer']):
                        filename=path.name;break
                if filename is None:raise ValueError('没有数值有效的完整检查点，无法自动恢复。')
            self.restore(identifier,filename)
            self.state.update(runtimeRecoveryAttempts=attempts+1,runtimeCpuFallback=fell_back,
                error=None,status='training',sleepPrevented=getattr(self,'_sleep_prevented',False))
            if numeric:
                for group in self.optimizer.param_groups:group['lr']=max(floor,previous_rate*.25)
                self.state.update(cyclePeakRate=float(self.optimizer.param_groups[0]['lr']),cycleStartEpoch=self.state['epoch'])
                self.setup_scheduler()
            recovery_history.append({'at':now(),'reason':'cuda-oom' if oom else 'non-finite',
                'device':str(self.device),'restoredStep':self.state['step'],'attempt':attempts+1})
            self.state['runtimeRecoveries']=recovery_history
            self.save()
            self.event('已从完整检查点自动恢复训练；显存不足时切换 CPU，数值异常时降低学习率。')
            return True
        except Exception as recovery_error:
            self.state.update(status='failed',error=str(recovery_error))
            self.event('自动恢复失败，请检查数据、设备或磁盘；最近完整检查点已保留。')
            return False

    def train_once(self):
        previous_time = time.monotonic()
        last_save = previous_time
        last_persist = previous_time
        try:
            self.model.train()
            self.initialize_validation_baseline()
            if self.state.pop('recoverBeforeTraining',False):
                if self.recover_best(reason='overfitting'):
                    self.save()
            early_stop=False
            while self.state['epoch'] < self.state['config']['epochs'] or self.state['config'].get('continuousTraining',False):
                if self.stop.is_set():
                    break
                if self.state['epoch']>=self.state['config']['epochs']:
                    self.restart_training_cycle('epoch-limit');self.save();last_save=time.monotonic()
                    if self.stop.is_set():break
                if not self.state['order']:
                    self.cycle_learning_rate()
                    keys = [key for key in self.graphs if key.split(':')[0] in self.state['trainIds']]
                    random.shuffle(keys)
                    with self.lock:
                        self.state['order'] = keys
                if self.state['cursor'] < len(self.state['order']):
                    keys,graph,coefficient = self.next_training_batch()
                    self.optimizer.zero_grad(set_to_none=True)
                    prediction = self.model(graph)
                    loss = sizing_loss(prediction,graph)
                    if not torch.isfinite(loss):
                        raise ValueError('损失出现非有限值，已停止训练。')
                    (loss*coefficient).backward()
                    torch.nn.utils.clip_grad_norm_(self.model.parameters(),1.,error_if_nonfinite=True,foreach=False)
                    self.optimizer.step()
                    value = loss.item()
                    with self.lock:
                        self.state.pop('activeWeightSource',None)
                        self.state['step'] += len(keys); self.state['cursor'] += len(keys)
                        self.state['optimizerSteps']=self.state.get('optimizerSteps',0)+1
                        self.state['samplesSeen'] += len(keys)
                        self.state['elementsSeen'] += len(graph['x'])
                        for key in keys:
                            sample = key.split(':')[0]
                            if sample not in self.state['seenIds']:
                                self.state['seenIds'].append(sample)
                            group=self.dataset_metadata[sample].get('group',sample)
                            if group not in self.state.setdefault('learnedGroups',[]):self.state['learnedGroups'].append(group)
                        self.state['stepLoss'] = value
                        if not self.state.get('trainingMetrics'):self.state['loss'] = value
                        self.state['epochLossSum'] += value*len(keys); self.state['epochLossCount'] += len(keys)
                moment = time.monotonic()
                with self.lock:
                    self.state['elapsedSeconds'] += moment-previous_time
                previous_time = moment
                epoch_complete = self.state['cursor'] >= len(self.state['order'])
                improved = False
                if epoch_complete:
                    training_metrics=self.evaluate_split(self.state['trainIds'])
                    validation_metrics=self.evaluate_split(self.state['validationIds'])
                    validation=validation_metrics['loss'] if validation_metrics else None
                    integrity=self.validation_integrity()
                    with self.lock:
                        mean_loss = self.state['epochLossSum']/max(1,self.state['epochLossCount'])
                        self.state['epoch'] += 1
                        self.state['trainingMetrics']=training_metrics;self.state['validationMetrics']=validation_metrics
                        self.state['loss']=training_metrics['loss']
                        self.state['validationLoss'] = validation
                        early_stop,reduced=update_monitor(self.state,self.optimizer,self.scheduler,training_metrics,validation_metrics,integrity)
                        self.state['history'].append({'epoch':self.state['epoch'],'step':self.state['step'],
                            'loss':training_metrics['loss'],'validationLoss':validation,'optimizerLoss':mean_loss,
                            'phase':self.state.get('phase',0),'learningRate':self.optimizer.param_groups[0]['lr'],'at':now()})
                        self.state['history'] = self.state['history'][-1000:]
                        improved = validation is not None and integrity=='independent' and (self.state['bestValidationLoss'] is None or validation<self.state['bestValidationLoss'])
                        if improved: self.state['bestValidationLoss'] = validation
                        self.state['cursor']=0; self.state['order']=[]
                        self.state['epochLossSum']=0.; self.state['epochLossCount']=0
                    if reduced:self.event('验证或训练指标停滞，已自动降低学习率。')
                    action=(self.state.get('diagnostics') or {}).get('action')
                    if action=='restart-cycle' and not improved and not self.stop.is_set():
                        self.restart_training_cycle(self.state['diagnostics']['recoveryReason'])
                        self.save();last_save=time.monotonic()
                    if action=='recover-best' and not early_stop and not improved:
                        diagnostic=self.state['diagnostics']
                        if self.recover_best(rate=diagnostic['nextLearningRate'],reason=diagnostic['recoveryReason']):
                            self.save();last_save=time.monotonic()
                if improved or self.save_requested.is_set() or moment-last_save >= self.state['config']['autosaveSeconds']:
                    self.save(best=improved)
                    if self.save_requested.is_set(): self.event('检查点已保存。')
                    self.save_requested.clear(); last_save = moment
                elif moment-last_persist >= 1:
                    self.persist_state(); last_persist=moment
                if early_stop: break
            with self.lock:
                self.state['status'] = 'paused' if self.stop.is_set() else 'completed'
                self.state['stopReason']=('service-interrupted' if self.state.get('serviceInterrupted') else 'manual-pause') if self.stop.is_set() else 'early-stopping' if early_stop else 'epoch-limit'
            if (not self.stop.is_set() and self.state['config'].get('adaptiveTraining') and
                    self.state['config'].get('automaticRecovery')):
                self.recover_best(final=True)
            self.save()
            self.event('验证指标持续未改善，已提前停止；最佳验证检查点已保留。' if early_stop else '已保存并暂停。' if self.stop.is_set() else '本次训练完成，检查点已保存。')
        except Exception as error:
            self._training_failure=error
            with self.lock:
                self.state['status']='failed'; self.state['error']=str(error)
            try:self.persist_state()
            except (OSError,RuntimeError):pass
            self.event('训练停止：'+str(error)+'；可恢复最近完整检查点。')
            traceback.print_exc(file=sys.stderr)
            # Release the failed autograd frame before an OOM recovery.
            error.__traceback__=None

    def predict(self,payload):
        self.idle()
        started = time.perf_counter()
        timings = dict(checkpointSeconds=0.,seedSeconds=0.,graphSeconds=0.,networkSeconds=0.,refineSeconds=0.)
        identifier = payload.get('runId') or (self.state or {}).get('id')
        if not identifier: raise ValueError('请先训练或选择一个检查点。')
        checkpoint = self.load_checkpoint(identifier,payload.get('checkpointFile'))
        if not payload.get('checkpointFile'):
            metadata=self.manager.metadata(self.store/'runs'/valid_id(identifier))
            best=metadata.get('bestCheckpointFile')
            if (metadata.get('diagnostics') or {}).get('validationIntegrity')=='previously-trained':best=None
            if best:
                try:checkpoint=self.load_checkpoint(identifier,best)
                except ValueError:self.event('最佳验证检查点不可用，预测使用最新可用检查点。')
        if checkpoint['state']['step']<1: raise ValueError('该检查点尚未完成任何训练步。')
        config = checkpoint['state']['config']
        network = MeshSizingNetwork(config['width'],config['layers'],config.get('architecture',1)).to(self.device)
        network.load_state_dict(checkpoint['network']); network.eval()
        timings['checkpointSeconds'] = time.perf_counter()-started
        tolerance = number(payload.get('targetError'),.05,1e-6,.999)
        max_nodes = number(payload.get('maxNodes'),20000,100,100000,True)
        rounds = number(payload.get('rounds'),4,0,8,True)
        with tempfile.TemporaryDirectory(dir=self.store/'incoming') as temporary, MeshSession(NODE,ROOT/'mesh-worker.cjs') as mesher:
            temporary = Path(temporary)
            moment = time.perf_counter()
            prepared = mesher.request('seed-cached',payload['path'],temporary/'seed.json')
            timings['seedSeconds'] += time.perf_counter()-moment
            mesh = prepared['meshes'][0]
            if len(mesh['nodes'])>max_nodes:
                raise ValueError('节点预算小于几何基础网格节点数，请提高节点预算。')
            stopped = 'round-limit'
            for iteration in range(rounds):
                moment = time.perf_counter()
                graph = to_device(build_graph(mesh,prepared['geometry'],reference_error=tolerance),self.device)
                if self.device.type == 'cuda': torch.cuda.synchronize(self.device)
                timings['graphSeconds'] += time.perf_counter()-moment
                moment = time.perf_counter()
                with torch.inference_mode():
                    desired = network(graph).cpu().numpy()
                timings['networkSeconds'] += time.perf_counter()-moment
                _,_,_,areas = mesh_arrays(mesh)
                desired_area = math.sqrt(3)/4*np.exp(2*desired)*graph['length']**2
                marked = [str(element['id']) for element,area,target in zip(mesh['cells'],areas,desired_area) if area>1.5*target]
                if not marked:
                    stopped='size-field-satisfied'; break
                moment = time.perf_counter()
                atomic_json(temporary/'refine-input.json',{'marked':marked,'maxNodes':max_nodes})
                refined = mesher.request('refine-cached',temporary/'refine-input.json',temporary/'refined.json')
                timings['refineSeconds'] += time.perf_counter()-moment
                if len(refined['mesh']['nodes'])>max_nodes:
                    stopped='node-budget'; break
                mesh = refined['mesh']
                if refined.get('budgetLimited'):
                    stopped='node-budget'; break
            prediction = uuid.uuid4().hex
            atomic_json(temporary/'scene-request.json',{})
            scene = mesher.request('scene',temporary/'scene-request.json',temporary/'scene.json')
            scene['mesh']['metadata']['algorithm']='gnn-size-field-triangle'
            scene['mesh']['metadata']['prediction']={'runId':identifier,'step':checkpoint['state']['step'],
                'targetError':tolerance,'verifiedError':None,'stopReason':stopped,'generatedAt':now(),
                'device':str(self.device),'backend':self.device_info['backend'],'timings':timings}
            timings['totalSeconds']=time.perf_counter()-started
            atomic_json(self.store/'predictions'/(prediction+'.json'),scene)
        self.event('已生成预测网格；需有限元求解后检查实际误差。')
        timings['totalSeconds']=time.perf_counter()-started
        return {'id':prediction,'nodes':len(mesh['nodes']),'elements':len(mesh['cells']),
            'stopReason':stopped,'verifiedError':None,'device':str(self.device),
            'deviceName':self.device_info['deviceName'],'backend':self.device_info['backend'],
            'timings':timings,'downloadUrl':'/api/training/prediction/'+prediction}

    def dispatch(self,command,payload):
        if command=='status': return self.status()
        if command=='import': return self.import_sample(payload)
        if command=='dataset-preview': return self.datasets.preview(payload)
        if command=='dataset-delete-impact': return self.datasets.impact(payload)
        if command=='delete-datasets': return self.datasets.delete(payload)
        if command=='change-dataset-split': return self.datasets.change_split(payload)
        if command=='start':
            try: return self.start(payload)
            except Exception as error:
                self.release_run()
                if self.state and self.state['status']=='starting':
                    self.state['status']='failed'; self.state['error']=str(error)
                    self.persist_state()
                raise
        if command=='resume': return self.resume(payload)
        if command=='restore-checkpoint': return self.restore_checkpoint(payload)
        if command in ['pause','save']: return self.control(command)
        if command=='predict': return self.predict(payload)
        if command=='checkpoints': return self.manager.checkpoints(payload['runId'])
        if command=='rename-model': return self.manager.rename(payload)
        if command=='delete-model': return self.manager.delete_model(payload)
        if command=='delete-checkpoint': return self.manager.delete_checkpoint(payload)
        if command=='export-model': return self.manager.export_model(payload)
        if command=='import-model': return self.manager.import_model(payload)
        if command=='storage-summary': return self.manager.storage_summary()
        if command=='clean-storage': return self.manager.clean_storage(payload)
        raise ValueError('未知训练操作。')

    def shutdown(self):
        if self.busy() and not self.stop.is_set():self.state['serviceInterrupted']=True
        self.stop.set()
        if self.thread and self.thread.is_alive(): self.thread.join()


def main():
    service = TrainingService()
    signal.signal(signal.SIGINT,lambda *_:service.stop.set())
    signal.signal(signal.SIGTERM,lambda *_:service.stop.set())
    try:
        if os.environ.get('FEM_ML_READY_FILE'):
            atomic_json(os.environ['FEM_ML_READY_FILE'], environment_report(service.device, service.device_info))
        for line in sys.stdin:
            message = {}
            try:
                message = json.loads(line)
                result = service.dispatch(message['command'],message.get('payload',{}))
                response = {'id':message['id'],'ok':True,'result':result}
            except Exception as error:
                service.event(str(error))
                response = {'id':message.get('id'),'ok':False,'error':str(error)}
            print(json.dumps(response,ensure_ascii=False,allow_nan=False),flush=True)
    finally:
        service.shutdown()


if __name__=='__main__': main()
