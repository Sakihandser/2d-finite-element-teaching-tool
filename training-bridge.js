const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

class TrainingBridge {
  constructor(root) {
    this.root = root;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
  }
  start() {
    if (this.child) return;
    const directory = path.join(this.root, 'python_machine_learning');
    const python = path.join(directory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const child = spawn(python, ['-u', path.join(directory, 'worker.py')], {
      cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', FEM_NODE: process.execPath },
    });
    this.child = child;
    this.stderr = '';
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error));
    });
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8000); });
    const finish = error => {
      if (this.child !== child) return;
      this.child = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`训练服务已退出：${error?.message || this.stderr || '重新连接后可从检查点恢复'}`));
      }
      this.pending.clear();
    };
    child.on('error', finish);
    child.on('exit', () => finish());
    child.stdin.on('error', finish);
  }
  request(command, payload = {}) {
    this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('训练服务响应超时，请刷新状态查看后台任务。'));
      }, 300000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, command, payload }) + '\n');
    });
  }
}
module.exports = { TrainingBridge };
