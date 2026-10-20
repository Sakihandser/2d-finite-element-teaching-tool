"""Local JSON-lines training service. stdout is reserved for protocol messages."""
import copy
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
from model import MeshSizingNetwork, sizing_loss
from model_management import ModelManager, checkpoint_name
from dataset_management import DatasetManager

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
        self.graphs = {}
        self.state = None
        self.device = torch.device('cuda:0' if torch.cuda.is_available() else 'cpu')
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        self.events = []
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
                    record['status'] = (record['status'] if record.get('status') in ['paused','completed'] else 'recoverable') if self.checkpoint_exists(record['id']) else 'unavailable'
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
                'environment':{'torch':torch.__version__,'cuda':torch.version.cuda,
                    'cudaAvailable':torch.cuda.is_available(),'device':str(self.device),
                    'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                    'memoryMiB':round(torch.cuda.memory_allocated()/1024**2,1) if torch.cuda.is_available() else 0},
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
        available = {sample['id']:sample for sample in self.records('datasets')}
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
        missing = [identifier for identifier in self.state['trainIds']+self.state['validationIds']
                   if not (self.store/'datasets'/valid_id(identifier)/'graphs.pt').is_file()]
        if missing:
            raise ValueError('训练工况文件已删除或缺失，无法继续训练：'+', '.join(missing))
        for identifier in self.state['trainIds']+self.state['validationIds']:
            payload = torch.load(self.store/'datasets'/valid_id(identifier)/'graphs.pt',map_location='cpu',weights_only=True)
            if payload['version'] != FEATURE_VERSION:
                raise ValueError('样本特征版本不兼容，请重新导入。')
            for index,graph in enumerate(payload['graphs']):
                self.graphs[f'{identifier}:{index}'] = graph

    def persist_state(self):
        with self.lock:
            atomic_json(self.store/'runs'/self.state['id']/'metadata.json',self.state)

    def save(self, best=False):
        with self.lock:
            state = copy.deepcopy(self.state)
            state['lastSavedAt'] = now()
            state['lastSavedStep'] = state['step']
            state['checkpointFile'] = f'checkpoint-{state["step"]:012d}-{time.time_ns()}.pt'
            if best: state['bestCheckpointFile']=state['checkpointFile']
        checkpoint = {'version':FEATURE_VERSION,'state':state,'network':self.model.state_dict(),
            'optimizer':self.optimizer.state_dict(),'pythonRng':random.getstate(),
            'numpyRng':[np.random.get_state()[0],np.random.get_state()[1].tolist(),*np.random.get_state()[2:]],
            'torchRng':torch.get_rng_state(),
            'cudaRng':torch.cuda.get_rng_state_all() if self.device.type=='cuda' else []}
        directory=self.store/'runs'/state['id']
        # Never replace a checkpoint that OneDrive may still be uploading.
        # A small metadata pointer plus scanning the last complete generations
        # supports recovery even if the process exits before updating metadata.
        atomic_checkpoint(directory/state['checkpointFile'],checkpoint)
        with self.lock:
            self.state['lastSavedAt']=state['lastSavedAt']
            self.state['lastSavedStep']=state['lastSavedStep']
            self.state['checkpointFile']=state['checkpointFile']
            if best: self.state['bestCheckpointFile']=state['checkpointFile']
        self.persist_state()
        atomic_json(directory/'checkpoint-metadata.json',self.state)
        previous=sorted(directory.glob('checkpoint-*.pt'),reverse=True)
        for old in previous[3:]:
            if old.name==self.state.get('bestCheckpointFile'): continue
            try: old.unlink(missing_ok=True)
            except OSError: pass

    def start(self,payload):
        self.idle()
        if self.device.type != 'cuda' and payload.get('device','cuda')=='cuda':
            raise ValueError('CUDA 不可用，请检查 GPU 环境。')
        train,validation = self.select_datasets(payload.get('datasetIds',[]))
        config = {'epochs':number(payload.get('epochs'),100,1,100000,True),
            'learningRate':number(payload.get('learningRate'),.001,1e-7,.1),
            'width':number(payload.get('width'),64,16,128,True),
            'layers':number(payload.get('layers'),6,2,10,True),
            'autosaveSeconds':number(payload.get('autosaveSeconds'),60,10,3600,True)}
        random.seed(42); np.random.seed(42); torch.manual_seed(42)
        self.model = MeshSizingNetwork(config['width'],config['layers']).to(self.device)
        self.optimizer = torch.optim.AdamW(self.model.parameters(),lr=config['learningRate'],weight_decay=1e-5)
        identifier = uuid.uuid4().hex
        self.state = {'id':identifier,'name':str(payload.get('name') or '网格尺寸学习'),
            'createdAt':now(),'status':'starting','config':config,'trainIds':train,'validationIds':validation,
            'step':0,'epoch':0,'cursor':0,'order':[],'epochLossSum':0.,'epochLossCount':0,
            'samplesSeen':0,'elementsSeen':0,'seenIds':[],'loss':None,'validationLoss':None,
            'bestValidationLoss':None,'history':[],'lastSavedAt':None,'lastSavedStep':0,'error':None,
            'featureVersion':FEATURE_VERSION,'elapsedSeconds':0.}
        (self.store/'runs'/identifier).mkdir()
        self.load_graphs()
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

    def restore(self,identifier,filename=None):
        checkpoint = self.load_checkpoint(identifier,filename)
        self.state = checkpoint['state']
        config = self.state['config']
        self.model = MeshSizingNetwork(config['width'],config['layers']).to(self.device)
        self.model.load_state_dict(checkpoint['network'])
        self.optimizer = torch.optim.AdamW(self.model.parameters(),lr=config['learningRate'])
        self.optimizer.load_state_dict(checkpoint['optimizer'])
        random.setstate(checkpoint['pythonRng'])
        rng = checkpoint['numpyRng']
        np.random.set_state((rng[0],np.array(rng[1],dtype=np.uint32),*rng[2:]))
        torch.set_rng_state(checkpoint['torchRng'])
        if self.device.type=='cuda' and checkpoint['cudaRng']:
            torch.cuda.set_rng_state_all(checkpoint['cudaRng'])
        self.load_graphs()

    def resume(self,payload):
        self.idle()
        identifier=payload.get('runId') or (self.state or {}).get('id')
        self.acquire_run(identifier)
        try:
            return self.resume_locked(payload,identifier)
        except Exception:
            self.release_run()
            raise

    def resume_locked(self,payload,identifier):
        self.restore(identifier,payload.get('checkpointFile'))
        if payload.get('datasetIds'):
            old = self.state['trainIds']+self.state['validationIds']
            train,validation = self.select_datasets(old+payload['datasetIds'])
            if train != self.state['trainIds'] or validation != self.state['validationIds']:
                added_training=set(train)-set(self.state['trainIds'])
                self.state['trainIds'],self.state['validationIds'] = train,validation
                self.state['bestValidationLoss'] = None
                if added_training and self.state['order'] and self.state['epoch']+1>=self.state['config']['epochs']:
                    self.state['config']['epochs']=self.state['epoch']+2
                self.load_graphs()
                self.event('已加入新样本；当前轮结束后新样本将与旧样本一起参与训练。')
        if self.state['epoch'] >= self.state['config']['epochs']:
            self.state['config']['epochs'] += number(payload.get('additionalEpochs'),100,1,100000,True)
        if payload.get('checkpointFile'):
            # Validate sample/epoch changes before creating the branch directory.
            # Preserve the source run and every later checkpoint when rewinding.
            self.release_run()
            self.state.update(id=uuid.uuid4().hex, createdAt=now(),
                name=(self.state['name'][:70]+f' · step {self.state["step"]}')[:100],
                parentRunId=identifier, parentCheckpoint=payload['checkpointFile'], bestCheckpointFile=None, bestValidationLoss=None)
            (self.store/'runs'/self.state['id']).mkdir()
        self.state['error'] = None
        self.save()
        self.launch()
        return {'id':self.state['id']}

    def launch(self):
        if self.run_lock is None: self.acquire_run(self.state['id'])
        self.stop.clear(); self.save_requested.clear()
        self.state['status'] = 'training'
        self.thread = threading.Thread(target=self.train,name='mesh-training',daemon=False)
        self.thread.start()
        self.event('训练已在 '+str(self.device)+' 上开始。')

    def control(self,command):
        if not self.state:
            raise ValueError('尚无训练任务。')
        if command=='pause' and self.busy():
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

    def evaluate(self):
        keys = [key for key in self.graphs if key.split(':')[0] in self.state['validationIds']]
        if not keys:
            return None
        self.model.eval()
        with torch.no_grad():
            losses = [sizing_loss(self.model(graph),graph).item() for key in keys
                for graph in [to_device(self.graphs[key],self.device)]]
        self.model.train()
        return sum(losses)/len(losses)

    def train(self):
        previous_time = time.monotonic()
        last_save = previous_time
        last_persist = previous_time
        try:
            self.model.train()
            while self.state['epoch'] < self.state['config']['epochs']:
                if self.stop.is_set():
                    break
                if not self.state['order']:
                    keys = [key for key in self.graphs if key.split(':')[0] in self.state['trainIds']]
                    random.shuffle(keys)
                    with self.lock:
                        self.state['order'] = keys
                if self.state['cursor'] < len(self.state['order']):
                    key = self.state['order'][self.state['cursor']]
                    graph = to_device(self.graphs[key],self.device)
                    self.optimizer.zero_grad(set_to_none=True)
                    prediction = self.model(graph)
                    loss = sizing_loss(prediction,graph)
                    if not torch.isfinite(loss):
                        raise ValueError('损失出现非有限值，已停止训练。')
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(self.model.parameters(),1.,error_if_nonfinite=True)
                    self.optimizer.step()
                    value = loss.item()
                    with self.lock:
                        self.state['step'] += 1; self.state['cursor'] += 1
                        self.state['samplesSeen'] += 1
                        self.state['elementsSeen'] += len(graph['x'])
                        sample = key.split(':')[0]
                        if sample not in self.state['seenIds']:
                            self.state['seenIds'].append(sample)
                        self.state['loss'] = value
                        self.state['epochLossSum'] += value; self.state['epochLossCount'] += 1
                moment = time.monotonic()
                with self.lock:
                    self.state['elapsedSeconds'] += moment-previous_time
                previous_time = moment
                epoch_complete = self.state['cursor'] >= len(self.state['order'])
                improved = False
                if epoch_complete:
                    validation = self.evaluate()
                    with self.lock:
                        mean_loss = self.state['epochLossSum']/max(1,self.state['epochLossCount'])
                        self.state['epoch'] += 1
                        self.state['validationLoss'] = validation
                        self.state['history'].append({'epoch':self.state['epoch'],'step':self.state['step'],
                            'loss':mean_loss,'validationLoss':validation,'at':now()})
                        self.state['history'] = self.state['history'][-1000:]
                        improved = validation is not None and (self.state['bestValidationLoss'] is None or validation<self.state['bestValidationLoss'])
                        if improved: self.state['bestValidationLoss'] = validation
                        self.state['cursor']=0; self.state['order']=[]
                        self.state['epochLossSum']=0.; self.state['epochLossCount']=0
                if improved or self.save_requested.is_set() or moment-last_save >= self.state['config']['autosaveSeconds']:
                    self.save(best=improved)
                    if self.save_requested.is_set(): self.event('检查点已保存。')
                    self.save_requested.clear(); last_save = moment
                elif moment-last_persist >= 1:
                    self.persist_state(); last_persist=moment
            with self.lock:
                self.state['status'] = 'paused' if self.stop.is_set() else 'completed'
            self.save()
            self.event('已保存并暂停。' if self.stop.is_set() else '本次训练完成，检查点已保存。')
        except Exception as error:
            with self.lock:
                self.state['status']='failed'; self.state['error']=str(error)
            self.persist_state()
            self.event('训练停止：'+str(error)+'；可恢复最近完整检查点。')
            traceback.print_exc(file=sys.stderr)
        finally:
            self.release_run()

    def predict(self,payload):
        self.idle()
        identifier = payload.get('runId') or (self.state or {}).get('id')
        if not identifier: raise ValueError('请先训练或选择一个检查点。')
        checkpoint = self.load_checkpoint(identifier,payload.get('checkpointFile'))
        if checkpoint['state']['step']<1: raise ValueError('该检查点尚未完成任何训练步。')
        config = checkpoint['state']['config']
        network = MeshSizingNetwork(config['width'],config['layers']).to(self.device)
        network.load_state_dict(checkpoint['network']); network.eval()
        tolerance = number(payload.get('targetError'),.05,1e-6,.999)
        max_nodes = number(payload.get('maxNodes'),20000,100,100000,True)
        rounds = number(payload.get('rounds'),4,0,8,True)
        with tempfile.TemporaryDirectory(dir=self.store/'incoming') as temporary:
            temporary = Path(temporary)
            prepared = self.mesh_command('seed',payload['path'],temporary/'seed.json')
            scene,mesh = prepared['scene'],prepared['meshes'][0]
            if len(mesh['nodes'])>max_nodes:
                raise ValueError('节点预算小于几何基础网格节点数，请提高节点预算。')
            stopped = 'round-limit'
            for iteration in range(rounds):
                graph = to_device(build_graph(mesh,prepared['geometry'],reference_error=tolerance),self.device)
                with torch.no_grad():
                    desired = network(graph).cpu().numpy()
                _,_,_,areas = mesh_arrays(mesh)
                desired_area = math.sqrt(3)/4*np.exp(2*desired)*graph['length']**2
                marked = [str(element['id']) for element,area,target in zip(scene['mesh']['elements'],areas,desired_area) if area>1.5*target]
                if not marked:
                    stopped='size-field-satisfied'; break
                atomic_json(temporary/'refine-input.json',{'scene':scene,'marked':marked})
                refined = self.mesh_command('refine',temporary/'refine-input.json',temporary/'refined.json')
                if len(refined['mesh']['nodes'])>max_nodes:
                    stopped='node-budget'; break
                scene,mesh = refined['scene'],refined['mesh']
            prediction = uuid.uuid4().hex
            scene['mesh']['metadata']['algorithm']='gnn-size-field-triangle'
            scene['mesh']['metadata']['prediction']={'runId':identifier,'step':checkpoint['state']['step'],
                'targetError':tolerance,'verifiedError':None,'stopReason':stopped,'generatedAt':now()}
            atomic_json(self.store/'predictions'/(prediction+'.json'),scene)
        self.event('已生成预测网格；需有限元求解后检查实际误差。')
        return {'id':prediction,'nodes':len(mesh['nodes']),'elements':len(mesh['cells']),
            'stopReason':stopped,'verifiedError':None,'downloadUrl':'/api/training/prediction/'+prediction}

    def dispatch(self,command,payload):
        if command=='status': return self.status()
        if command=='import': return self.import_sample(payload)
        if command=='dataset-preview': return self.datasets.preview(payload)
        if command=='dataset-delete-impact': return self.datasets.impact(payload)
        if command=='delete-datasets': return self.datasets.delete(payload)
        if command=='start':
            try: return self.start(payload)
            except Exception as error:
                self.release_run()
                if self.state and self.state['status']=='starting':
                    self.state['status']='failed'; self.state['error']=str(error)
                    self.persist_state()
                raise
        if command=='resume': return self.resume(payload)
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
        self.stop.set()
        if self.thread and self.thread.is_alive(): self.thread.join()


def main():
    service = TrainingService()
    signal.signal(signal.SIGINT,lambda *_:service.stop.set())
    signal.signal(signal.SIGTERM,lambda *_:service.stop.set())
    try:
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
