"""Reference-model previews and explicit, physical training-dataset deletion."""
from contextlib import contextmanager, ExitStack
import copy
import hashlib
import json
import os
import re

import torch
from graph_data import FEATURE_VERSION, preview_size_field


class DatasetManager:
    def __init__(self, service):
        self.service = service

    def directory(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{32}', identifier):
            raise ValueError('无效的训练工况编号。')
        parent = (self.service.store/'datasets').resolve()
        directory = self.service.store/'datasets'/identifier
        if directory.is_symlink() or directory.resolve().parent != parent or not (directory/'metadata.json').is_file():
            raise ValueError('训练工况不存在或路径无效。')
        return directory

    def preview(self, payload):
        directory = self.directory(payload.get('datasetId'))
        metadata = json.loads((directory/'metadata.json').read_text(encoding='utf-8'))
        reference = json.loads((directory/'reference.json').read_text(encoding='utf-8'))
        geometry = reference.get('geometry')
        if not isinstance(geometry, dict) or not geometry.get('geometryNodes'):
            raise ValueError('该训练工况缺少可预览的几何参考文件，请重新导入原模型。')
        scene = copy.deepcopy(geometry)
        scene['name'] = metadata['name']
        scene['dataGeneration'] = reference.get('provenance') or metadata.get('dataGeneration')
        meshes = []
        for index, mesh in enumerate([reference.get('reference'), *reference.get('meshes', [])]):
            if not mesh:
                continue
            # Reconstruct supervision with the training projector from JSON;
            # graphs.pt and checkpoint tensors are never deserialized here.
            item = {'kind': 'reference' if index == 0 else 'coarse', 'index': index,
                           'nodes': [n[:2] for n in mesh['nodes']],
                           'triangles': [c['nodes'] for c in mesh['cells']]}
            if index and reference.get('reference'):
                if metadata.get('featureVersion', FEATURE_VERSION) != FEATURE_VERSION:
                    item['sizingWarning'] = '标签版本不兼容，无法重建学习目标。'
                else:
                    try:
                        item['sizing'] = preview_size_field(mesh, reference['reference'])
                    except (ValueError, KeyError, IndexError) as error:
                        item['sizingWarning'] = '无法重建学习目标：'+str(error)
            meshes.append(item)
        return {'sample': metadata, 'scene': scene, 'meshes': meshes}

    def identifiers(self, payload):
        values = payload.get('datasetIds')
        if not isinstance(values, list) or not 1 <= len(values) <= 1000:
            raise ValueError('请选择 1–1000 个训练工况。')
        if any(not isinstance(value, str) for value in values):
            raise ValueError('无效的训练工况编号。')
        identifiers = list(dict.fromkeys(values))
        for identifier in identifiers:
            self.directory(identifier)
        return identifiers

    def change_split(self, payload):
        from worker import atomic_json, now
        self.service.idle()
        split = payload.get('split')
        if split not in ('train', 'validation'):
            raise ValueError('样本用途必须是训练或验证。')
        identifiers = self.identifiers(payload)
        with ExitStack() as stack:
            stack.enter_context(self.run_guard('dataset-management'))
            for directory in sorted((self.service.store/'runs').iterdir()):
                if directory.is_dir() and not directory.is_symlink():
                    stack.enter_context(self.run_guard(directory.name))
            records = self.service.records('datasets')
            selected = set(identifiers)
            groups = {sample['group'] for sample in records if sample['id'] in selected and sample.get('group')}
            affected = [sample for sample in records if sample['id'] in selected or sample.get('group') in groups]
            originals, changed = [], []
            try:
                for sample in affected:
                    if sample['split'] == split:
                        continue
                    file = self.directory(sample['id'])/'metadata.json'
                    updated = {**sample, 'split': split, 'splitUpdatedAt': now()}
                    atomic_json(file, updated)
                    originals.append((file, copy.deepcopy(sample)))
                    changed.append(updated)
            except Exception:
                # Keep a geometry group together if a later write fails.
                for file, original in reversed(originals):
                    atomic_json(file, original)
                raise
            self.service.event(f'已更改 {len(changed)} 个工况的学习用途，同一几何的工况同步更改。')
            return {'updatedIds': [sample['id'] for sample in changed], 'split': split,
                    'groupedCount': sum(sample['id'] not in selected for sample in changed)}

    def impact(self, payload):
        identifiers = self.identifiers(payload)
        samples, signatures = [], []
        for identifier in identifiers:
            directory = self.directory(identifier)
            metadata = json.loads((directory/'metadata.json').read_text(encoding='utf-8'))
            files = [p for p in directory.rglob('*') if p.is_file() and not p.is_symlink()]
            samples.append({'id': identifier, 'name': metadata['name'], 'files': len(files),
                            'bytes': sum(p.stat().st_size for p in files)})
            signatures.extend((str(p.relative_to(self.service.store)), p.stat().st_mtime_ns, p.stat().st_size) for p in files)
        dependencies = []
        selected = set(identifiers)
        for directory in sorted((self.service.store/'runs').iterdir()):
            if not directory.is_dir() or directory.is_symlink():
                continue
            states, unknown = [], []
            paths = [directory/'metadata.json', directory/'checkpoint-metadata.json',
                     *sorted(directory.glob('checkpoint-*.pt')), directory/'latest.pt', directory/'latest.previous.pt']
            for file in paths:
                if not file.is_file():
                    continue
                signatures.append((str(file.relative_to(self.service.store)), file.stat().st_mtime_ns, file.stat().st_size))
                try:
                    saved = (torch.load(file, map_location='cpu', weights_only=True)['state']
                             if file.suffix == '.pt' else json.loads(file.read_text(encoding='utf-8')))
                    states.append(saved)
                except Exception:
                    unknown.append(file.name)
            used = selected.intersection(i for s in states for i in s.get('trainIds', [])+s.get('validationIds', []))
            if used or unknown:
                dependencies.append({'id': directory.name, 'name': next((s.get('name') for s in states if s.get('name')), directory.name),
                                     'datasetIds': sorted(used), 'unreadableFiles': unknown})
        token = hashlib.sha256(json.dumps([sorted(identifiers), sorted(signatures)], ensure_ascii=True).encode()).hexdigest()
        return {'samples': samples, 'dependencies': dependencies, 'token': token,
                'bytes': sum(s['bytes'] for s in samples), 'files': sum(s['files'] for s in samples)}

    @contextmanager
    def run_guard(self, identifier):
        # Acquire the SAME stable lock as training without altering this
        # service's active-run handles. Hold all affected-run locks until delete.
        if identifier != 'dataset-management' and not re.fullmatch(r'[a-f0-9-]{1,80}', identifier):
            raise ValueError('模型记录编号无效。')
        locks = self.service.store/'locks'
        locks.mkdir(exist_ok=True)
        with (locks/(identifier+'.lock')).open('a+b') as handle:
            if handle.tell() == 0:
                handle.write(b'0'); handle.flush()
            handle.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise ValueError('有训练记录正被另一程序实例使用，请先暂停再操作数据。') from error
            yield

    def delete(self, payload):
        self.service.idle()
        identifiers = self.identifiers(payload)
        with ExitStack() as stack:
            for directory in sorted((self.service.store/'runs').iterdir()):
                if directory.is_dir() and not directory.is_symlink():
                    stack.enter_context(self.run_guard(directory.name))
            impact = self.impact(payload)
            if payload.get('token') != impact['token']:
                raise ValueError('数据或训练记录已改变，请重新查看删除清单后确认。')
            if impact['dependencies'] and payload.get('allowReferenced') is not True:
                raise ValueError('选中数据被训练记录引用，删除前需要确认对继续训练和模型导出的影响。')
            deleted, failed = [], []
            for identifier in identifiers:
                try:
                    # ModelManager validates the resolved absolute target under
                    # datasets/ and permanently removes the full directory.
                    self.service.manager.remove_tree('datasets', identifier)
                    deleted.append(identifier)
                except OSError as error:
                    failed.append({'id': identifier, 'error': str(error)})
            if hasattr(self.service.graphs,'discard'):
                self.service.graphs.discard(deleted)
            else:
                self.service.graphs = {k: v for k, v in self.service.graphs.items() if k.split(':')[0] not in deleted}
            self.service.event(f'已永久删除 {len(deleted)} 个训练工况的磁盘文件。')
            return {'deletedIds': deleted, 'failed': failed}
