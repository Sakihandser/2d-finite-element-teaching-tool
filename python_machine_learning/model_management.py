"""Portable model packages and locked, physical storage management."""
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import time
import uuid
import zipfile

import torch

from graph_data import FEATURE_VERSION
from model import MeshSizingNetwork


def checkpoint_name(value):
    value = str(value)
    if not re.fullmatch(r'checkpoint-[0-9]+-[0-9]+\.pt|latest(?:\.previous)?\.pt', value):
        raise ValueError('无效的检查点文件名。')
    return value


class ModelManager:
    def __init__(self, service):
        self.service = service
        self.cache = {}

    def directory(self, identifier):
        # Keep identifiers and filenames separate; never accept arbitrary paths.
        identifier = str(identifier)
        if not re.fullmatch(r'[a-f0-9-]{1,80}', identifier):
            raise ValueError('无效的记录编号。')
        directory = self.service.store/'runs'/identifier
        if not (directory/'metadata.json').is_file():
            raise ValueError('模型记录不存在。')
        return directory

    @contextmanager
    def editing(self, identifier):
        self.service.idle()
        directory = self.directory(identifier)
        self.service.acquire_run(identifier)
        try:
            yield directory
        finally:
            self.service.release_run()

    def detach(self, identifier):
        if self.service.state and self.service.state['id'] == identifier:
            self.service.state = None
            self.service.model = self.service.optimizer = None
            self.service.graphs = {}

    def metadata(self, directory):
        path = directory/'checkpoint-metadata.json'
        if not path.exists(): path = directory/'metadata.json'
        return json.loads(path.read_text(encoding='utf-8'))

    def write_metadata(self, directory, state):
        from worker import atomic_json
        atomic_json(directory/'metadata.json', state)
        atomic_json(directory/'checkpoint-metadata.json', state)

    def checkpoints(self, identifier):
        directory = self.directory(identifier)
        state = self.metadata(directory)
        paths = sorted(directory.glob('checkpoint-*.pt'), reverse=True)
        paths += [p for p in [directory/'latest.pt', directory/'latest.previous.pt'] if p.exists()]
        rows = []
        for path in paths:
            checkpoint_name(path.name)
            try: stat = path.stat()
            except FileNotFoundError: continue  # A concurrent save may rotate it.
            key = (str(path), stat.st_mtime_ns, stat.st_size)
            if key not in self.cache:
                try:
                    checkpoint = torch.load(path, map_location='cpu', weights_only=True)
                    saved = checkpoint['state']
                    self.cache[key] = {k: saved.get(k) for k in ['step','epoch','loss','validationLoss','lastSavedAt']}
                    self.cache[key]['valid'] = checkpoint['version'] == FEATURE_VERSION
                except Exception:
                    self.cache[key] = {'valid':False}
            rows.append({**self.cache[key], 'file':path.name, 'bytes':stat.st_size,
                         'latest':path.name == state.get('checkpointFile'),
                         'best':path.name == state.get('bestCheckpointFile')})
        # Do not retain tensor data, or stale entries from deleted generations.
        existing = {str(p) for p in paths}
        self.cache = {k:v for k,v in self.cache.items() if k[0] in existing}
        if rows and not any(r['latest'] for r in rows):
            next((r for r in rows if r['valid']), rows[0])['latest'] = True
        return {'runId':identifier, 'checkpoints':rows}

    def rename(self, payload):
        identifier = payload['runId']
        name = str(payload.get('name', '')).strip()
        if not name or len(name) > 100:
            raise ValueError('模型名称需为 1–100 个字符。')
        with self.editing(identifier) as directory:
            state = self.metadata(directory)
            state['name'] = name
            self.write_metadata(directory, state)
            if self.service.state and self.service.state['id'] == identifier:
                self.service.state['name'] = name
        return {'id':identifier, 'name':name}

    def stored_path(self, category, name):
        parent=(self.service.store/category).resolve()
        path=self.service.store/category/name
        if path.resolve().parent != parent or path.is_symlink():
            raise ValueError('清理目标超出允许的存储目录。')
        return path

    def remove_tree(self, category, name):
        path=self.stored_path(category,name)
        deadline=time.monotonic()+5
        def writable_retry(function, failed, error):
            # OneDrive may set the read-only attribute on directories as well
            # as files. Change it only on the validated deletion target.
            target=Path(failed)
            if not isinstance(error,PermissionError) or not target.resolve().is_relative_to(path.resolve()):
                raise error
            target.chmod(stat.S_IWRITE)
            function(failed)
        while path.exists():
            try: shutil.rmtree(path,onexc=writable_retry)
            except OSError:
                if time.monotonic()>=deadline: raise
                time.sleep(.1)

    def remove_file(self, path):
        deadline=time.monotonic()+5
        while True:
            try:
                path.unlink(missing_ok=True)
                return
            except OSError:
                if time.monotonic()>=deadline: raise
                if path.exists(): path.chmod(stat.S_IWRITE)
                time.sleep(.1)

    def delete_model(self, payload):
        identifier = payload['runId']
        with self.editing(identifier) as directory:
            self.service.release_legacy_run()
            self.remove_tree('runs',identifier)
            self.detach(identifier)
        return {'deleted':True}

    def delete_checkpoint(self, payload):
        identifier, filename = payload['runId'], checkpoint_name(payload['checkpointFile'])
        with self.editing(identifier) as directory:
            rows = self.checkpoints(identifier)['checkpoints']
            selected = next((r for r in rows if r['file'] == filename), None)
            if selected is None: raise ValueError('检查点不存在。')
            remaining = [r for r in rows if r['file'] != filename and r['valid']]
            if not remaining:
                raise ValueError('不能删除最后一个可用检查点；如不再需要，请删除整个模型。')
            metadata = self.metadata(directory)
            try:
                if selected['latest']:
                    checkpoint = self.service.load_checkpoint(identifier, remaining[0]['file'])
                    state = copy.deepcopy(checkpoint['state'])
                    state.update(id=identifier, name=metadata['name'], status='paused', error=None,
                                 checkpointFile=remaining[0]['file'])
                    state['bestCheckpointFile'] = metadata.get('bestCheckpointFile')
                else:
                    state = metadata
                if state.get('bestCheckpointFile') == filename:
                    state['bestCheckpointFile'] = None
                    state['bestValidationLoss'] = None
                self.write_metadata(directory, state)
                self.remove_file(self.stored_path('runs',identifier)/filename)
            except Exception:
                self.write_metadata(directory, metadata)
                raise
            self.detach(identifier)
        return {'deleted':True}

    def cleanup_targets(self, kind):
        if kind in ['exports','predictions']:
            suffix='zip' if kind=='exports' else 'json'
            parent=self.service.store/kind
            if not parent.exists(): return []
            return [(kind,p.name) for p in parent.iterdir() if p.is_file() and re.fullmatch(r'[a-f0-9]{32}\.'+suffix,p.name)]
        if kind=='legacy-deleted':
            parent=self.service.store/'trash'
            targets=[] if not parent.exists() else [('trash',p.name) for p in parent.iterdir()
                if p.is_dir() and re.fullmatch(r'(?:model|checkpoint)-[a-f0-9-]{1,80}-[a-f0-9]{32}',p.name)]
            targets += [('runs',p.name) for p in (self.service.store/'runs').iterdir()
                if p.is_dir() and re.fullmatch(r'[a-f0-9-]{1,80}',p.name)
                and not (p/'metadata.json').exists() and all(f.name=='training.lock' for f in p.iterdir())]
            return targets
        raise ValueError('未知的存储清理类别。')

    def storage_summary(self):
        summary={}
        for kind in ['exports','predictions','legacy-deleted']:
            targets=self.cleanup_targets(kind)
            total=0
            for category,name in targets:
                path=self.stored_path(category,name)
                files=path.rglob('*') if path.is_dir() else [path]
                for file in files:
                    if file.is_file() and not file.is_symlink():
                        try: total+=file.stat().st_size
                        except FileNotFoundError: pass
            summary[kind]={'count':len(targets),'bytes':total}
        return summary

    def clean_storage(self, payload):
        self.service.idle()
        kind=payload.get('kind')
        targets=self.cleanup_targets(kind)
        removed=0
        for category,name in targets:
            path=self.stored_path(category,name)
            if category=='runs':
                # Recheck after acquiring the same lock as a training process.
                self.service.acquire_run(name,allow_missing=True)
                try:
                    if any(f.name!='training.lock' for f in path.iterdir()): continue
                    self.service.release_legacy_run()
                    self.remove_tree(category,name)
                finally: self.service.release_run()
            elif path.is_dir(): self.remove_tree(category,name)
            else: self.remove_file(path)
            removed+=1
        return {'deleted':removed,'kind':kind,'summary':self.storage_summary()}

    def validate_checkpoint(self, checkpoint):
        if checkpoint.get('version') != FEATURE_VERSION:
            raise ValueError('检查点特征版本不兼容。')
        state = checkpoint['state']
        config = state['config']
        if not 16 <= int(config['width']) <= 128 or not 2 <= int(config['layers']) <= 10:
            raise ValueError('模型结构参数无效。')
        required = ['optimizer','pythonRng','numpyRng','torchRng','cudaRng','network']
        if any(key not in checkpoint for key in required):
            raise ValueError('需要包含优化器和训练状态的完整检查点。')
        network = MeshSizingNetwork(config['width'], config['layers'])
        network.load_state_dict(checkpoint['network'])
        optimizer = torch.optim.AdamW(network.parameters(), lr=config['learningRate'])
        optimizer.load_state_dict(checkpoint['optimizer'])
        ids = state['trainIds'] + state['validationIds']
        if not state['trainIds'] or any(not re.fullmatch(r'[a-f0-9-]{1,80}', str(i)) for i in ids):
            raise ValueError('模型样本依赖无效。')
        return state

    def export_model(self, payload):
        identifier = payload['runId']
        with self.editing(identifier) as directory:
            rows = [r for r in self.checkpoints(identifier)['checkpoints'] if r['valid']]
            if not rows: raise ValueError('没有可导出的检查点。')
            datasets = set()
            for row in rows:
                saved = self.service.load_checkpoint(identifier, row['file'])['state']
                datasets.update(saved['trainIds'] + saved['validationIds'])
            exports = self.service.store/'exports'
            exports.mkdir(exist_ok=True)
            output = exports/(uuid.uuid4().hex+'.zip')
            temporary = output.with_suffix('.tmp')
            try:
                with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                    archive.writestr('manifest.json', json.dumps({'format':'fem-mesh-model', 'version':1,
                        'featureVersion':FEATURE_VERSION, 'name':self.metadata(directory)['name'],
                        'checkpoints':[r['file'] for r in rows], 'datasets':sorted(datasets)}, ensure_ascii=False))
                    for row in rows: archive.write(directory/row['file'], 'checkpoints/'+row['file'])
                    for dataset in sorted(datasets):
                        for name in ['metadata.json','graphs.pt','reference.json']:
                            source = self.service.store/'datasets'/dataset/name
                            if source.exists(): archive.write(source, 'datasets/'+dataset+'/'+name)
                            elif name != 'reference.json': raise ValueError('模型依赖的训练样本不完整，无法导出。')
                os.replace(temporary, output)
            finally:
                temporary.unlink(missing_ok=True)
        return {'downloadUrl':'/api/training/model-package/'+output.stem}

    def import_model(self, payload):
        from worker import atomic_checkpoint, atomic_json, now
        self.service.idle()
        source = Path(payload['path'])
        identifier = uuid.uuid4().hex
        created = []
        with tempfile.TemporaryDirectory(dir=self.service.store/'incoming') as temporary:
            stage = Path(temporary)
            package = False
            if zipfile.is_zipfile(source):
                # PyTorch's .pt format is itself a ZIP; only our manifest
                # distinguishes a portable model package from a PT checkpoint.
                with zipfile.ZipFile(source) as probe:
                    if len(probe.infolist()) > 2000 or sum(e.file_size for e in probe.infolist()) > 1024**3:
                        raise ValueError('模型包解压后超过 1 GiB 或文件数量过多。')
                    package = 'manifest.json' in probe.namelist()
            if package:
                with zipfile.ZipFile(source) as archive:
                    entries = archive.infolist()
                    if len(entries) > 2000 or sum(e.file_size for e in entries) > 1024**3:
                        raise ValueError('模型包解压后超过 1 GiB 或文件数量过多。')
                    manifest = json.loads(archive.read('manifest.json'))
                    if manifest.get('format') != 'fem-mesh-model' or manifest.get('version') != 1:
                        raise ValueError('请选择本程序导出的模型 ZIP 包或完整 PT 检查点。')
                    filenames = manifest['checkpoints']
                    datasets = manifest['datasets']
                    if not filenames or len(set(filenames)) != len(filenames): raise ValueError('模型包检查点清单无效。')
                    if any(not re.fullmatch(r'[a-f0-9-]{1,80}', str(i)) for i in datasets):
                        raise ValueError('模型样本依赖无效。')
                    allowed = {'manifest.json'} | {'checkpoints/'+checkpoint_name(f) for f in filenames}
                    allowed |= {'datasets/'+i+'/'+n for i in datasets for n in ['metadata.json','graphs.pt','reference.json']}
                    if len({e.filename for e in entries}) != len(entries) or any(e.filename not in allowed for e in entries):
                        raise ValueError('模型包包含无效路径或重复文件。')
                    for entry in entries:
                        target = stage/entry.filename
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with archive.open(entry) as data, target.open('wb') as output:
                            shutil.copyfileobj(data, output)
                name = str(manifest.get('name') or '导入模型')[:100]
            else:
                filenames = ['checkpoint-000000000000-0.pt']
                (stage/'checkpoints').mkdir()
                shutil.copyfile(source, stage/'checkpoints'/filenames[0])
                datasets = []
                name = None
            checkpoints, required = {}, set()
            # Loading uses weights_only: no arbitrary pickle globals are allowed.
            for filename in filenames:
                checkpoint = torch.load(stage/'checkpoints'/filename, map_location='cpu', weights_only=True)
                state = self.validate_checkpoint(checkpoint)
                checkpoints[filename] = checkpoint
                required.update(state['trainIds'] + state['validationIds'])
            for dataset in required:
                local = self.service.store/'datasets'/dataset
                staged = stage/'datasets'/dataset
                candidate = staged if staged.exists() else local
                if not (candidate/'metadata.json').is_file() or not (candidate/'graphs.pt').is_file():
                    raise ValueError('缺少训练样本，请导入包含样本的模型 ZIP 包。')
                metadata = json.loads((candidate/'metadata.json').read_text(encoding='utf-8'))
                graphs = torch.load(candidate/'graphs.pt', map_location='cpu', weights_only=True)
                if metadata['id'] != dataset or graphs['version'] != FEATURE_VERSION or not graphs['graphs']:
                    raise ValueError('模型包中的样本无效。')
                if staged.exists() and local.exists():
                    # Refuse to silently overwrite data shared with other models.
                    def digest(path):
                        with path.open('rb') as file: return hashlib.file_digest(file, 'sha256').hexdigest()
                    existing = json.loads((local/'metadata.json').read_text(encoding='utf-8'))
                    if digest(local/'graphs.pt') != digest(staged/'graphs.pt') or any(existing.get(k) != metadata.get(k) for k in ['split','group']):
                        raise ValueError('样本编号冲突，现有样本与模型包内容不同。')
            latest = max(checkpoints, key=lambda f:(checkpoints[f]['state']['step'], checkpoints[f]['state'].get('lastSavedAt') or ''))
            new_run = stage/'run'
            new_run.mkdir()
            for filename, checkpoint in checkpoints.items():
                state = checkpoint['state']
                state.update(id=identifier, name=name or state['name'], status='paused', error=None,
                             createdAt=now(), checkpointFile=filename)
                if state.get('bestCheckpointFile') not in filenames: state['bestCheckpointFile'] = None
                atomic_checkpoint(new_run/filename, checkpoint)
            self.write_metadata(new_run, checkpoints[latest]['state'])
            try:
                for dataset in required:
                    local = self.service.store/'datasets'/dataset
                    if not local.exists():
                        os.replace(stage/'datasets'/dataset, local)
                        created.append(local)
                os.replace(new_run, self.service.store/'runs'/identifier)
            except Exception:
                for local in created:
                    # Only remove newly installed, validated dataset directories.
                    if local.resolve().parent != (self.service.store/'datasets').resolve(): raise
                    shutil.rmtree(local)
                raise
        return {'id':identifier, 'name':name or checkpoints[latest]['state']['name']}
