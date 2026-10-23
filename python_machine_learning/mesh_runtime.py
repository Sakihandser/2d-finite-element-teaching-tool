"""One initialized Triangle process per prediction, reused across refinement rounds."""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading


class MeshSession:
    def __init__(self,node,script):
        self.errors = tempfile.TemporaryFile()
        self.responses = queue.Queue()
        self.process = subprocess.Popen([node,str(script),'serve'],cwd=Path(script).parent.parent,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.errors,
            text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.reader = threading.Thread(target=self._read,daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.process.stdout:
            try: self.responses.put(json.loads(line))
            except ValueError: pass  # Ignore third-party mesher diagnostics.
        self.responses.put({'ok':False,'error':'网格处理进程已退出。'})

    def request(self,command,source,destination):
        try:
            self.process.stdin.write(json.dumps({'command':command,'source':str(source),'destination':str(destination)})+'\n')
            self.process.stdin.flush()
            result = self.responses.get(timeout=240)
        except queue.Empty:
            raise TimeoutError('网格处理超时。')
        if not result['ok']: raise ValueError(result['error'])
        return json.loads(Path(destination).read_text(encoding='utf-8'))

    def __enter__(self): return self

    def __exit__(self,*args):
        try: self.process.stdin.close()
        except OSError: pass
        try: self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.reader.join(timeout=2)
        self.process.stdout.close()
        self.errors.close()
