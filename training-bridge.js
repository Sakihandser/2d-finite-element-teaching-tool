const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');

function launcherPython(directory) {
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const candidates = [process.env.FEM_ML_PYTHON,
    ...['.venv-cpu', '.venv', '.venv-directml', '.venv-rocm', '.venv-xpu'].flatMap(name =>
      process.platform === 'win32' ? [path.join(directory, name, 'python.exe'), path.join(directory, name, executable)] : [path.join(directory, name, executable)])];
  const python = candidates.find(file => file && fs.existsSync(file));
  if (!python) throw new Error('缺少机器学习环境，请先运行 scripts/setup-ml.ps1。');
  return python;
}

class TrainingBridge {
  constructor(root, { spawnProcess = spawn, restartDelay = 2000, maxProcessRestarts = 3 } = {}) {
    this.root = root;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.spawnProcess = spawnProcess;
    this.restartDelay = restartDelay;
    this.maxProcessRestarts = maxProcessRestarts;
    this.desiredRun = null;
    this.recovering = null;
    this.processRestarts = 0;
    this.recoveryError = '';
  }
  start() {
    if (this.child) return;
    const directory = path.join(this.root, 'python_machine_learning');
    const python = launcherPython(directory);
    const child = this.spawnProcess(python, ['-u', path.join(directory, 'runtime_launcher.py')], {
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
      // The launcher and the selected Python interpreter share stdin. Closing
      // it also stops an orphan worker if only its launcher was terminated.
      child.stdin.destroy();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`训练服务已退出：${error?.message || this.stderr || '重新连接后可从检查点恢复'}`));
      }
      this.pending.clear();
      if (this.desiredRun && !this.recovering) this.recoverProcess();
    };
    child.on('error', finish);
    child.on('exit', () => finish());
    child.stdin.on('error', finish);
  }
  recoverProcess() {
    // The web service owns this bounded supervisor. It can recover a lost
    // Python process while the web service itself remains running.
    this.recovering = (async () => {
      while (this.desiredRun && this.processRestarts < this.maxProcessRestarts) {
        this.processRestarts++;
        await new Promise(resolve => setTimeout(resolve, this.restartDelay * this.processRestarts));
        if (!this.desiredRun) return;
        try {
          const status = await this.send('status');
          const run = status.runs.find(item => item.id === this.desiredRun);
          if (!run) throw new Error('自动恢复所需的训练记录或完整检查点不存在。');
          if (run.status === 'unavailable') throw new Error('训练记录没有可用的完整检查点。');
          if (['completed','ready'].includes(run.status) || (run.status === 'paused' && run.stopReason !== 'service-interrupted')) {
            this.desiredRun = null;
            return;
          }
          if (!this.desiredRun) return;
          // Resume precisely the checkpoint's selection/cursor/strategy. Do
          // not replay the original start request or append another epoch budget.
          await this.send('resume', { runId: this.desiredRun });
          this.recoveryError = '';
          return;
        } catch (error) {
          this.recoveryError = error.message;
        }
      }
      if (this.desiredRun) this.recoveryError = `训练进程自动恢复次数已用尽：${this.recoveryError || this.stderr || '请从检查点继续训练'}`;
    })().finally(() => { this.recovering = null; });
  }
  async request(command, payload = {}) {
    const wasRecovering = Boolean(this.recovering);
    // A pause must cancel restart intent immediately, including during backoff.
    if (command === 'pause') this.desiredRun = null;
    if (this.recovering) await this.recovering;
    if (command === 'pause' && wasRecovering && !this.child) return { requested: true };
    const result = await this.send(command, payload);
    if (['start','resume'].includes(command)) {
      this.desiredRun = payload.continuousTraining === true && payload.unattendedTraining !== false ? result.id : null;
      this.processRestarts = 0;
      this.recoveryError = '';
    }
    if (command === 'status') {
      if (this.desiredRun && result.current?.id === this.desiredRun && ['paused','completed','failed'].includes(result.current.status)) this.desiredRun = null;
      result.processRecovery = { attempts: this.processRestarts, maximum: this.maxProcessRestarts, error: this.recoveryError };
    }
    return result;
  }
  send(command, payload = {}) {
    this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('训练服务响应超时，请刷新状态查看后台任务。'));
      }, 600000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, command, payload }) + '\n');
    });
  }
}
module.exports = { TrainingBridge, launcherPython };
