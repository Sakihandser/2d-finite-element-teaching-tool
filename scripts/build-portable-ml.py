"""Build a relocatable Windows distribution with complete Python runtimes.

Run with the development CPU interpreter. Output must be outside this checkout.
The final application never needs uv/pip/activation or the developer's Python.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENTS = ('.venv-cpu', '.venv-directml', '.venv')
CRT_DLLS = ('concrt140.dll','msvcp140.dll','msvcp140_1.dll','msvcp140_2.dll',
    'msvcp140_atomic_wait.dll','msvcp140_codecvt_ids.dll','vcruntime140.dll',
    'vcruntime140_1.dll','vcruntime140_threads.dll')


def bundle_crt(destination, directory):
    """App-local release CRT only; never redistribute debug or arbitrary DLLs.

    Select a current licensed Microsoft VC redistributable installation, or
    pass its extracted x64 CRT directory explicitly with --crt-directory.
    """
    for name in CRT_DLLS:
        source=directory/name
        if not source.is_file():
            raise ValueError(f'Missing Microsoft x64 release CRT: {source}')
        for environment in ENVIRONMENTS:
            shutil.copy2(source,destination/'python_machine_learning'/environment/name)
    # _pth isolation deliberately ignores PYTHONIOENCODING. Configure the
    # JSON-lines protocol locally so Chinese names and errors remain UTF-8.
    for environment in ENVIRONMENTS:
        (destination/'python_machine_learning'/environment/'sitecustomize.py').write_text(
            'import sys\nfor name in ("stdin", "stdout", "stderr"):\n'
            '    stream = getattr(sys, name, None)\n'
            '    if stream is not None and hasattr(stream, "reconfigure"):\n'
            '        stream.reconfigure(encoding="utf-8")\n',encoding='utf-8')
    return list(CRT_DLLS)


def ignore_runtime(directory, names):
    ignored = {'__pycache__', '.git', 'Include', 'include', 'libs', 'Scripts',
               'test', 'tests', 'pyvenv.cfg', '_virtualenv.py', '_virtualenv.pth'}
    return [name for name in names if name in ignored or name.endswith(
        ('.pyc','.pyo','.whl','.log','.h','.hpp','.lib','.a','.pdb'))]


def copy_sources(destination):
    tracked = subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode('utf-8').split('\0')
    # Include uncommitted new sources while preparing the release; verify the
    # eventual source snapshot separately before publishing.
    untracked = subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z'],cwd=ROOT).decode('utf-8').split('\0')
    for relative in sorted(set(tracked+untracked)):
        if not relative or relative.startswith('.github/'):
            continue
        source = ROOT/relative
        if source.is_file():
            target = destination/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(source,target)
    shutil.copy2(ROOT/'node-v24.21.0-win-x64/node.exe',destination/'node-v24.21.0-win-x64/node.exe')


def build(destination, crt_directory):
    destination = destination.resolve()
    if destination == ROOT or ROOT in destination.parents or destination.exists():
        raise ValueError('Choose a new output directory outside the source checkout.')
    destination.mkdir(parents=True)
    copy_sources(destination)
    reports = []
    for name in ENVIRONMENTS:
        source = ROOT/'python_machine_learning'/name
        interpreter = source/'Scripts/python.exe'
        info = json.loads(subprocess.check_output([str(interpreter),'-c',
            'import json,sys; print(json.dumps({"base":sys.base_prefix,"version":sys.version,"minor":f"{sys.version_info.major}{sys.version_info.minor}"}))'],encoding='utf-8'))
        target = destination/'python_machine_learning'/name
        shutil.copytree(Path(info['base']),target,ignore=ignore_runtime)
        # Replace base-installation packages with exactly the verified venv.
        # Base uv Python has no application dependencies; overlay is deliberate.
        shutil.copytree(source/'Lib/site-packages',target/'Lib/site-packages',
                        dirs_exist_ok=True,ignore=ignore_runtime)
        # _pth ignores registry/PYTHONHOME/PYTHONPATH and uses relative paths.
        # The last path is python_machine_learning, containing worker modules.
        (target/f"python{info['minor']}._pth").write_text(
            '.\nDLLs\nLib\nLib/site-packages\n..\nimport site\n',encoding='utf-8')
        freeze = subprocess.check_output(['uv','pip','freeze','--python',str(interpreter)],encoding='utf-8')
        (target/'PACKAGES.txt').write_text(freeze,encoding='utf-8')
        reports.append({'environment':name,'python':info['version'].splitlines()[0],
                        'packageInventory':f'python_machine_learning/{name}/PACKAGES.txt'})
        print(f'Bundled {name}',flush=True)
    manifest = {'release':'GNNv1.1','platform':'windows-x64','runtimes':reports,
        'appLocalMicrosoftCrt':bundle_crt(destination,crt_directory),
        'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'sourceWasDirty':bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT))}
    (destination/'PORTABLE-MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    assert not (destination/'python_machine_learning/storage').exists()
    assert not (destination/'.git').exists()
    print(json.dumps(manifest,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination',type=Path)
    parser.add_argument('--refresh-source',action='store_true')
    parser.add_argument('--crt-directory',type=Path,
        default=Path(os.environ.get('SystemRoot','C:/Windows'))/'System32')
    args = parser.parse_args()
    if args.refresh_source:
        destination = args.destination.resolve()
        if destination == ROOT or ROOT in destination.parents or not (destination/'PORTABLE-MANIFEST.json').is_file():
            raise ValueError('Refresh requires an existing portable output outside the checkout.')
        copy_sources(destination)
        manifest = json.loads((destination/'PORTABLE-MANIFEST.json').read_text(encoding='utf-8'))
        manifest['sourceCommit'] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
        manifest['sourceWasDirty'] = bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT))
        manifest['appLocalMicrosoftCrt'] = bundle_crt(destination,args.crt_directory)
        (destination/'PORTABLE-MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    else:
        build(args.destination,args.crt_directory)
