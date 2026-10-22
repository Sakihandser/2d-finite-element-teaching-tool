'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {atomicJson,replaceFile}=require('./generation-files');
const idPattern=/^[a-f0-9]{32}$/;
const keyPattern=/^g[1-9]\d*-c[1-9]\d*$/;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

class GenerationHistory {
  constructor(bridge) { this.bridge=bridge;this.directory=path.resolve(bridge.directory); }
  async datasets() {
    const directory=path.join(path.dirname(this.directory),'datasets'),records=[];
    for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
      if(!entry.isDirectory()||entry.isSymbolicLink()||!idPattern.test(entry.name))continue;
      try {
        const metadata=JSON.parse(await fs.readFile(path.join(directory,entry.name,'metadata.json'),'utf8'));
        if(metadata.id===entry.name)records.push(metadata);
      }catch { /* Only fully registered training records count as assigned. */ }
    }
    return records;
  }
  async decorate(jobs,records=undefined) {
    records ||= await this.datasets();
    const byId=new Map(records.map(r=>[r.id,r]));
    return Promise.all(jobs.map(async original=>{
      const job=structuredClone(original);
      for(const row of job.cases) {
        const key=String(row.key||'').match(/^g(\d+)-c(\d+)$/);
        const record=byId.get(row.datasetId)||records.find(r=>r.dataGeneration?.batchId===job.id&&key&&
          r.dataGeneration.geometryIndex===Number(key[1])-1&&r.dataGeneration.caseIndex===Number(key[2])-1);
        row.assigned=Boolean(record);row.assignedSplit=record?.split||null;
        if(record)row.datasetId=record.id;
        row.hasReference=keyPattern.test(row.key)&&await fs.stat(path.join(this.directory,job.id,row.key+'.json')).then(s=>s.isFile(),()=>false);
      }
      const solved=job.cases.filter(row=>Number.isFinite(row.errorEstimate)&&row.errorEstimate>0&&row.errorEstimate<1);
      const met=solved.filter(row=>row.errorEstimate<=job.config.targetError).length;
      const finished=job.cases.filter(row=>row.status==='failed'||solved.includes(row));
      const durationsKnown=finished.length>0&&finished.every(row=>Number.isFinite(row.referenceDurationMs)&&row.referenceDurationMs>=0);
      const duration=finished.reduce((sum,row)=>sum+(row.referenceDurationMs||0),0);
      job.quality={solved:solved.length,met,attempted:finished.length,assigned:job.cases.filter(row=>row.assigned).length,
        referencesPerHour:durationsKnown&&duration>0?met*3600000/duration:null};
      return job;
    }));
  }
  async job(identifier) {
    const job=(await this.bridge.jobs()).find(j=>j.id===identifier);
    if(!job)throw new Error('找不到生成记录。');
    return (await this.decorate([job]))[0];
  }
  async jobPath(identifier) {
    if(!idPattern.test(identifier||''))throw new Error('历史批次路径无效。');
    const directory=path.join(this.directory,identifier),stat=await fs.lstat(directory);
    const root=await fs.realpath(this.directory),resolved=await fs.realpath(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||path.dirname(resolved)!==root||path.basename(resolved)!==identifier)
      throw new Error('历史删除目标超出生成数据目录。');
    return directory;
  }
  async files(directory,relative='') {
    const result=[];
    for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})) {
      const name=path.join(relative,entry.name),file=path.join(directory,name),stat=await fs.lstat(file);
      if(stat.isSymbolicLink())throw new Error('历史目录包含链接，已拒绝删除。');
      if(stat.isDirectory())result.push(...await this.files(directory,name));
      else if(stat.isFile())result.push({name,bytes:stat.size,modified:stat.mtimeMs});
      else throw new Error('历史目录包含不支持的文件类型。');
    }
    return result.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async plan(payload) {
    const scope=payload.scope;
    if(!['all','assigned','job','case'].includes(scope))throw new Error('请选择有效的历史删除范围。');
    if(['job','case'].includes(scope)&&!idPattern.test(payload.jobId||''))throw new Error('历史批次路径无效。');
    if(scope==='case'&&!keyPattern.test(payload.key||''))throw new Error('历史工况编号无效。');
    const known=await this.decorate(await this.bridge.jobs());
    let identifiers;
    if(scope==='all')identifiers=(await fs.readdir(this.directory,{withFileTypes:true})).filter(e=>e.isDirectory()&&idPattern.test(e.name)).map(e=>e.name);
    else identifiers=['job','case'].includes(scope)?[payload.jobId]:known.filter(j=>j.cases.some(r=>r.assigned)).map(j=>j.id);
    const targets=[];
    for(const identifier of identifiers.sort()) {
      const directory=await this.jobPath(identifier),job=known.find(j=>j.id===identifier);
      if(scope!=='all'&&!job)throw new Error('找不到生成记录。');
      if(scope==='case'&&!job.cases.some(r=>r.key===payload.key))throw new Error('找不到历史工况。');
      const rows=job?.cases||[],selected=scope==='assigned'?rows.filter(r=>r.assigned):scope==='case'?rows.filter(r=>r.key===payload.key):rows;
      const keys=selected.map(r=>r.key);
      const whole=scope==='all'||scope==='job'||(keys.length>0&&keys.length===rows.length);
      const files=(await this.files(directory)).filter(f=>whole||keys.some(key=>f.name.startsWith(key+'.')&&!f.name.includes(path.sep)));
      targets.push({jobId:identifier,whole,keys,files,assignments:selected.map(r=>[r.key,r.assigned,r.datasetId||null,r.assignedSplit]),
        manifestHash:job?digest(await fs.readFile(path.join(directory,'manifest.json'),'utf8')):null});
    }
    const token=digest([scope,payload.jobId||null,payload.key||null,targets]);
    return {scope,token,targets,files:targets.reduce((n,t)=>n+t.files.length,0),bytes:targets.reduce((n,t)=>n+t.files.reduce((s,f)=>s+f.bytes,0),0),
      cases:targets.reduce((n,t)=>n+t.keys.length,0),batches:targets.length};
  }
  async impact(payload) {
    if(this.bridge.busy)throw new Error('请等待生成或历史管理操作完成后再删除。');
    const {targets,...summary}=await this.plan(payload);
    return {...summary,items:targets.map(t=>({jobId:t.jobId,whole:t.whole,keys:t.keys,files:t.files.length}))};
  }
  async editing(operation) {
    if(this.bridge.busy)throw new Error('请等待生成或历史管理操作完成后再操作。');
    this.bridge.managing=true;
    try {
      await this.bridge.saving;
      const state=await this.bridge.training.request('status');
      if(['starting','training','pausing'].includes(state.current?.status))throw new Error('请先保存并暂停训练，再管理生成历史。');
      return await operation();
    }finally {this.bridge.managing=false;}
  }
  async writeJob(job) {
    const directory=await this.jobPath(job.id);
    await atomicJson(path.join(directory,'manifest.json'),job);
    if(this.bridge.current?.id===job.id)this.bridge.current=job;
  }
  async removeFile(file) {
    try {await fs.unlink(file);}
    catch(error){if(error.code==='ENOENT')return;if(!['EPERM','EACCES'].includes(error.code))throw error;await fs.chmod(file,0o666);await fs.unlink(file);}
  }
  async remove(payload) {
    return this.editing(async()=>{
      const plan=await this.plan(payload);
      if(!payload.token||payload.token!==plan.token)throw new Error('历史文件或分配状态已改变，请重新查看删除清单后确认。');
      const deletedJobs=[],deletedCases=[],failed=[];
      for(const target of plan.targets) {
        try {
          const directory=await this.jobPath(target.jobId);
          // Revalidate immediately before removal. No paths come from request
          // filenames: the directory is an exact real child of generated/.
          await this.files(directory);
          if(target.whole) {
            await fs.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
            deletedJobs.push(target.jobId);
            if(this.bridge.current?.id===target.jobId)this.bridge.current=null;
          }else {
            for(const file of target.files)await this.removeFile(path.join(directory,file.name));
            const job=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
            if(!Number.isInteger(job.nextCase)&&Number.isInteger(job.config.conditions))job.nextCase=this.bridge.nextIndex(job);
            job.cases=job.cases.filter(r=>!target.keys.includes(r.key));
            job.historyDeletedCount=(job.historyDeletedCount||0)+target.keys.length;
            await this.writeJob(job);
          }
          deletedCases.push(...target.keys.map(key=>({jobId:target.jobId,key})));
        }catch(error){failed.push({jobId:target.jobId,error:error.message});}
      }
      return {deletedJobs,deletedCases,failed};
    });
  }
  async assign(payload) {
    if(!['train','validation'].includes(payload.split))throw new Error('请选择训练集或验证集。');
    return this.editing(async()=>{
      const job=await this.job(payload.jobId),row=job.cases.find(r=>r.key===payload.key);
      if(!row||!row.hasReference)throw new Error('工况没有可分配的参考模型文件。');
      if(row.assigned)throw new Error('该历史工况已经分配，请在训练数据列表中管理。');
      const directory=await this.jobPath(job.id),output=path.join(directory,row.key+'.json');
      const stat=await fs.lstat(output);
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error('历史参考模型必须是生成目录内的普通文件。');
      const scene=JSON.parse(await fs.readFile(output,'utf8'));
      scene.dataGeneration={...scene.dataGeneration,batchId:job.id,split:payload.split};
      const temporary=path.join(directory,row.key+'.assignment.json');
      try {
        await fs.writeFile(temporary,JSON.stringify(scene));
        const result=await this.bridge.training.request('import',{path:temporary,split:payload.split});
        if(result.sample.split!==payload.split)throw new Error('该工况已存在于另一数据集中；同一几何的工况不能跨训练集和验证集。');
        await replaceFile(temporary,output);
        Object.assign(row,{datasetId:result.sample.id,split:payload.split,assignedSplit:payload.split,assigned:true,
          status:result.duplicate?'duplicate':'imported',assignedAt:new Date().toISOString(),projectionFallbacks:result.sample.projectionFallbacks||0});
        delete row.error;
        await this.writeJob(job);
        return {jobId:job.id,key:row.key,sample:result.sample,duplicate:result.duplicate};
      }finally {await fs.unlink(temporary).catch(()=>{});}
    });
  }
  async changeSplit(payload) {
    if(!['train','validation'].includes(payload.split))throw new Error('请选择训练集或验证集。');
    return this.editing(async()=>{
      const job=await this.job(payload.jobId),row=job.cases.find(row=>row.key===payload.key);
      if(!row?.assigned||!row.datasetId)throw new Error('该历史工况尚未分配到训练库。');
      return this.bridge.training.request('change-dataset-split',{datasetIds:[row.datasetId],split:payload.split});
    });
  }
}
module.exports={GenerationHistory};
