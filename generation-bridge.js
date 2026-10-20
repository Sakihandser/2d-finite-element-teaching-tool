'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { validateConfig, generateGeometry } = require('./python_machine_learning/generation-core.cjs');
const { GenerationHistory } = require('./generation-history');

const activeStates = ['starting','running','stopping'];
function splitFor(seed, index, fraction) {
  const hash = createHash('sha256').update(JSON.stringify([seed,'split',index])).digest().readUInt32BE();
  return hash / 2**32 < fraction ? 'validation' : 'train';
}
async function atomicJson(file, data) {
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(data, null, 2));
  await fs.rename(temporary, file);
}

class GenerationBridge {
  constructor(root, store, training) {
    this.root = root; this.directory = path.join(store, 'generated'); this.training = training;
    this.current = null; this.starting = false; this.stopRequested = false; this.saving = Promise.resolve();
    this.managing=false;this.history=new GenerationHistory(this);
  }
  get generating() { return this.starting || activeStates.includes(this.current?.status); }
  get busy() { return this.generating || this.managing; }
  async jobs() {
    await fs.mkdir(this.directory, { recursive: true });
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      try {
        const job = JSON.parse(await fs.readFile(path.join(this.directory, entry.name, 'manifest.json'), 'utf8'));
        if(job.id!==entry.name||!Array.isArray(job.cases)||!job.config)continue;
        // After a server restart, finished files stay downloadable. We never
        // claim a former in-flight run is still computing or silently restart it.
        if (activeStates.includes(job.status) && this.current?.id !== job.id) {
          job.status = 'interrupted'; job.error = '服务已重启；已完成工况保留，未完成工况未导入。';
        }
        result.push(job);
      } catch { /* Interrupted atomic writes never expose partial records. */ }
    }
    return result.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  async status() {
    const raw=await this.jobs();
    if(this.current){const index=raw.findIndex(j=>j.id===this.current.id);if(index<0)raw.unshift(this.current);else raw[index]=this.current;}
    const jobs = await this.history.decorate(raw);
    const current=this.current?jobs.find(j=>j.id===this.current.id):jobs[0]||null;
    return { busy:this.busy,generating:this.generating,managing:this.managing,current,
      history:{batches:jobs.length,cases:jobs.reduce((n,j)=>n+j.cases.length,0),assigned:jobs.reduce((n,j)=>n+j.cases.filter(r=>r.assigned).length,0)},
      jobs:jobs.map(({cases,config,...job})=>({...job,config:{seed:config.seed},caseCount:cases.length})) };
  }
  persist() {
    const file = path.join(this.directory, this.current.id, 'manifest.json');
    const snapshot = structuredClone(this.current);
    this.saving = this.saving.catch(() => {}).then(() => atomicJson(file, snapshot));
    return this.saving;
  }
  async start(input) {
    if (this.busy) throw new Error('已有数据生成任务正在运行。');
    const config = validateConfig(input);
    this.starting = true;
    try {
      const state = await this.training.request('status');
      if (['starting','training','pausing'].includes(state.current?.status)) throw new Error('请先保存并暂停神经网络训练，再生成参考数据。');
      // Freeze material values for reproducibility if the library is edited
      // during a batch. The full snapshots are retained in the job manifest.
      const materials = JSON.parse(await fs.readFile(path.join(this.root,'materials/materials.json'),'utf8')).materials;
      config.materials = materials;
      this.current = { id: randomUUID().replaceAll('-',''), createdAt: new Date().toISOString(),
        status: 'running', config, completed: 0, failed: 0, imported: 0, rejected: 0,
        total: config.geometries*config.conditions, cases: [], stage: 'geometry' };
      this.stopRequested = false;
      await fs.mkdir(path.join(this.directory,this.current.id),{ recursive:true });
      await this.persist();
      this.run().catch(async error => {
        this.current.status='failed'; this.current.error=error.message;
        await this.persist().catch(() => {});
      });
      return { id: this.current.id };
    } finally { this.starting = false; }
  }
  async stop() {
    if (activeStates.includes(this.current?.status)) { this.stopRequested=true; this.current.status='stopping'; await this.persist(); }
    return { ok:true };
  }
  worker(request, onProgress = () => {}) {
    return new Promise((resolve,reject) => {
      const child = fork(path.join(this.root,'python_machine_learning/generation-worker.cjs'), [], {
        windowsHide:true, stdio:['ignore','pipe','pipe','ipc'], execPath: process.execPath,
      });
      let error='', done=false, timedOut=false;
      // Includes geometry/meshing and at most maxIterations+1 solves. Individual
      // native solves have their own timeout. This outer guard also bounds WASM.
      const seconds = request.preview ? 60 : 60+Math.min(request.config.caseTimeLimitSeconds??600,(request.config.maxIterations+1)*request.config.timeLimitSeconds*3);
      const timer=setTimeout(() => { timedOut=true; child.kill(); },seconds*1000);
      child.stdout.on('data',() => {});
      child.stderr.on('data',chunk => { error=(error+chunk).slice(-4000); });
      child.on('error',err => { clearTimeout(timer); reject(err); });
      child.on('message',message => {
        if(message.type==='progress') onProgress(message);
        if(message.type==='error') error=message.error;
        if(message.type==='done') done=true;
      });
      child.on('exit',code => {
        clearTimeout(timer);
        if(code===0 && done) resolve();
        else reject(new Error(timedOut?'工况进程超过耗时保护，已跳过。':error || '工况进程异常退出。'));
      });
      child.send(request);
    });
  }
  async preview(input) {
    const config = validateConfig({ ...input, conditions:1 });
    const generated = await generateGeometry(config,0);
    const directory = path.join(this.directory,'preview-'+randomUUID());
    await fs.mkdir(directory,{recursive:true});
    try {
      const source=path.join(directory,'source.json'), output=path.join(directory,'scene.json');
      await fs.writeFile(source,JSON.stringify(generated[0]));
      await this.worker({preview:true,input:source,output});
      return {scene:JSON.parse(await fs.readFile(output,'utf8'))};
    } finally {
      // Exact, freshly created task-local directory; no user supplied paths.
      await fs.unlink(path.join(directory,'source.json')).catch(() => {});
      await fs.unlink(path.join(directory,'scene.json')).catch(() => {});
      await fs.rmdir(directory);
    }
  }
  async run() {
    const job=this.current, config=job.config, directory=path.join(this.directory,job.id);
    for(let i=0;i<config.geometries && !this.stopRequested;i++) {
      job.geometryIndex=i; job.stage='geometry'; await this.persist();
      let scenes;
      try { scenes=await generateGeometry(config,i); }
      catch(error) {
        for(let j=0;j<config.conditions;j++) { job.failed++; job.cases.push({key:`g${i+1}-c${j+1}`,status:'failed',error:error.message}); }
        await this.persist(); continue;
      }
      const split=config.importSplit==='auto'?splitFor(config.seed,i,config.validationFraction):config.importSplit;
      for(let j=0;j<scenes.length && !this.stopRequested;j++) {
        const key=`g${i+1}-c${j+1}`, source=scenes[j];
        const sourceFile=path.join(directory,key+'.source.json'), output=path.join(directory,key+'.json'), result=path.join(directory,key+'.result.json');
        const row={key,name:source.name,split,status:'running'};
        job.currentCase=key; job.cases.push(row); job.stage='mesh'; await this.persist();
        try {
          source.dataGeneration={...source.dataGeneration,batchId:job.id,split};
          await atomicJson(sourceFile,source);
          await this.worker({input:sourceFile,output,result,config},detail => { job.progress=detail; job.stage=detail.stage; });
          const scene=JSON.parse(await fs.readFile(output,'utf8'));
          const final=scene.mesh.metadata.adaptive.history.at(-1);
          const achieved=Number(final.relativeError);
          const meetsTarget=Number.isFinite(achieved)&&achieved>0&&achieved<1&&achieved<=config.targetError;
          Object.assign(row,{status:'generated',nodes:scene.analysisNodes.length,elements:scene.mesh.elements.length,meetsTarget,
            errorEstimate:final.relativeError,stopReason:final.stopReason,
            downloadUrl:`/api/training/generator/sample/${job.id}/${key}`});
          job.completed++;
          if(config.autoImport && meetsTarget) {
            job.stage='import'; await this.persist();
            try {
              const imported=await this.training.request('import',{path:output,split});
              if(imported.sample.split!==split)throw new Error('该工况已存在于另一数据集中；请保留原用途，或使用新种子生成不同几何。');
              row.datasetId=imported.sample.id; row.projectionFallbacks=imported.sample.projectionFallbacks || 0;
              row.status=imported.duplicate?'duplicate':'imported';
              if(!imported.duplicate) job.imported++;
            } catch(error) { row.status='import-failed'; row.error=error.message; }
          } else if(config.autoImport) { row.status='rejected'; job.rejected++; }
        } catch(error) { row.status='failed'; row.error=error.message; job.failed++; }
        await this.persist();
      }
    }
    job.status=this.stopRequested?'stopped':'completed'; job.stage='done'; job.finishedAt=new Date().toISOString();
    delete job.progress;
    await this.persist();
  }
  async sample(jobId,key,source=false) {
    if(!/^[a-f0-9]{32}$/.test(jobId) || !/^g[1-9]\d*-c[1-9]\d*$/.test(key)) throw new Error('工况路径无效。');
    return fs.readFile(path.join(this.directory,jobId,key+(source?'.source':'')+'.json'));
  }
}
module.exports={GenerationBridge,splitFor};
