'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {GenerationBridge}=require('../generation-bridge');
const id=n=>n.toString(16).padStart(32,'0');
const root=path.resolve(__dirname,'..');
const exists=file=>fs.stat(file).then(()=>true,()=>false);

async function fixture(t) {
  const store=await fs.mkdtemp(path.join(os.tmpdir(),'fem-history-test-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(store)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(store).startsWith('fem-history-test-'));
    await fs.rm(store,{recursive:true,force:true});
  });
  const training={request:async command=>{assert.equal(command,'status');return {current:null};}};
  const bridge=new GenerationBridge(root,store,training);
  await fs.mkdir(bridge.directory);
  async function job(number,rows=[{key:'g1-c1',status:'generated'}]) {
    const value={id:id(number),createdAt:new Date(number).toISOString(),status:'completed',config:{seed:'history-test'},cases:rows};
    const directory=path.join(bridge.directory,value.id);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(value));
    for(const row of rows)for(const suffix of ['.json','.source.json','.result.json'])
      await fs.writeFile(path.join(directory,row.key+suffix),JSON.stringify({name:row.key,dataGeneration:{batchId:value.id,geometryIndex:Number(row.key.match(/^g(\d+)/)[1])-1,caseIndex:Number(row.key.match(/c(\d+)$/)[1])-1}}));
    return value;
  }
  async function dataset(number,jobValue,key='g1-c1',split='train') {
    const record={id:id(number),split,dataGeneration:{batchId:jobValue.id,geometryIndex:Number(key.match(/^g(\d+)/)[1])-1,caseIndex:Number(key.match(/c(\d+)$/)[1])-1}};
    const directory=path.join(store,'datasets',record.id);
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,'metadata.json'),JSON.stringify(record));
    await fs.writeFile(path.join(directory,'graphs.pt'),'independent training graphs');
    return record;
  }
  async function remove(payload) {return bridge.history.remove({...payload,token:(await bridge.history.impact(payload)).token});}
  return {store,bridge,training,job,dataset,remove};
}

test('case deletion removes physical files with exact prefixes and retains other cases',async t=>{
  const {bridge,job,remove}=await fixture(t);
  const value=await job(1,[{key:'g1-c1'},{key:'g1-c10'}]),directory=path.join(bridge.directory,value.id);
  bridge.current=value;
  const result=await remove({scope:'case',jobId:value.id,key:'g1-c1'});
  assert.deepEqual(result.failed,[]);
  assert.deepEqual(result.deletedCases,[{jobId:value.id,key:'g1-c1'}]);
  assert.equal(await exists(path.join(directory,'g1-c1.json')),false);
  assert.equal(await exists(path.join(directory,'g1-c1.source.json')),false);
  assert.equal(await exists(path.join(directory,'g1-c1.result.json')),false);
  assert.equal(await exists(path.join(directory,'g1-c10.json')),true);
  assert.deepEqual(bridge.current.cases.map(r=>r.key),['g1-c10']);
  assert.equal(bridge.current.historyDeletedCount,1);
  const last=await remove({scope:'case',jobId:value.id,key:'g1-c10'});
  assert.deepEqual(last.deletedJobs,[value.id]);
  assert.equal(await exists(directory),false);
  assert.equal(bridge.current,null);
});

test('assigned bulk deletion spans all batches and uses actual training records',async t=>{
  const {store,bridge,job,dataset,remove}=await fixture(t);
  for(let index=1;index<=22;index++) {
    const value=await job(index,[{key:'g1-c1',status:'imported',datasetId:id(index+100)},{key:'g1-c2',status:'generated'}]);
    await dataset(index+100,value);
  }
  const missing=await job(23,[{key:'g1-c1',status:'imported',datasetId:id(999)}]);
  const status=await bridge.status();
  assert.equal(status.jobs.length,23);
  assert.deepEqual(status.history,{batches:23,cases:45,assigned:22});
  assert.equal((await bridge.history.job(missing.id)).cases[0].assigned,false);
  const impact=await bridge.history.impact({scope:'assigned'});
  assert.equal(impact.batches,22);assert.equal(impact.cases,22);assert.equal(impact.files,66);
  const result=await remove({scope:'assigned'});
  assert.deepEqual(result.failed,[]);assert.equal(result.deletedCases.length,22);assert.equal(result.deletedJobs.length,0);
  for(let index=1;index<=22;index++) {
    const remaining=await bridge.history.job(id(index));
    assert.deepEqual(remaining.cases.map(r=>r.key),['g1-c2']);
    assert.equal(await exists(path.join(store,'datasets',id(index+100),'graphs.pt')),true);
  }
  assert.equal(await exists(path.join(bridge.directory,missing.id,'g1-c1.json')),true);
});

test('all deletion clears full batches and orphan files, preserving datasets and checkpoints',async t=>{
  const {store,bridge,job,dataset,remove}=await fixture(t);
  const value=await job(1);bridge.current=value;
  const record=await dataset(100,value);
  const checkpoint=path.join(store,'runs',id(200),'weights.pt');
  await fs.mkdir(path.dirname(checkpoint),{recursive:true});await fs.writeFile(checkpoint,'weights');
  await fs.mkdir(path.join(bridge.directory,id(2),'nested'),{recursive:true});
  await fs.writeFile(path.join(bridge.directory,id(2),'nested','solver-result.bin'),'orphan');
  // Verify readonly artifacts can be removed on Windows as well.
  await fs.chmod(path.join(bridge.directory,value.id,'g1-c1.json'),0o444);
  const result=await remove({scope:'all'});
  assert.deepEqual(result.failed,[]);assert.equal(result.deletedJobs.length,2);
  assert.deepEqual(await fs.readdir(bridge.directory),[]);
  assert.equal(bridge.current,null);
  assert.equal(await exists(path.join(store,'datasets',record.id,'graphs.pt')),true);
  assert.equal(await fs.readFile(checkpoint,'utf8'),'weights');
});

test('stale deletion confirmation detects file, manifest, and assignment changes',async t=>{
  const {bridge,job,dataset}=await fixture(t),value=await job(1),payload={scope:'job',jobId:id(1)};
  const file=path.join(bridge.directory,value.id,'g1-c1.result.json');
  let impact=await bridge.history.impact(payload);
  await fs.appendFile(file,'changed');
  await assert.rejects(()=>bridge.history.remove({...payload,token:impact.token}),/已改变/);
  impact=await bridge.history.impact(payload);
  await dataset(100,value);
  await assert.rejects(()=>bridge.history.remove({...payload,token:impact.token}),/已改变/);
  impact=await bridge.history.impact(payload);
  await fs.appendFile(path.join(bridge.directory,value.id,'manifest.json'),' ');
  await assert.rejects(()=>bridge.history.remove({...payload,token:impact.token}),/已改变/);
  assert.equal(await exists(file),true);assert.equal(bridge.managing,false);
});

test('invalid paths and directory links are rejected before history deletion',async t=>{
  const {bridge,store,job}=await fixture(t),value=await job(1);
  for(const payload of [{scope:'bad'},{scope:'job',jobId:'../datasets'},{scope:'case',jobId:value.id,key:'../escape'}])
    await assert.rejects(()=>bridge.history.impact(payload));
  const outside=path.join(store,'datasets');await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'keep.txt'),'keep');
  await fs.symlink(outside,path.join(bridge.directory,value.id,'linked'),'junction');
  await assert.rejects(()=>bridge.history.impact({scope:'all'}),/包含链接/);
  assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
});

test('assignment imports the requested split with provenance and can reassign a removed training copy',async t=>{
  const {bridge,training,job,dataset,store}=await fixture(t),value=await job(1);
  const seen=[];
  training.request=async(command,payload)=>{
    if(command==='status')return {current:null};
    assert.equal(command,'import');
    const scene=JSON.parse(await fs.readFile(payload.path,'utf8'));seen.push(scene);
    const sample=await dataset(100,value,'g1-c1',payload.split);
    return {sample,duplicate:false};
  };
  const request={jobId:value.id,key:'g1-c1',split:'validation'};
  const result=await bridge.history.assign(request);
  assert.equal(result.sample.split,'validation');assert.equal(seen[0].dataGeneration.split,'validation');
  assert.equal(seen[0].dataGeneration.batchId,value.id);
  let row=(await bridge.history.job(value.id)).cases[0];
  assert.equal(row.assigned,true);assert.equal(row.assignedSplit,'validation');
  await assert.rejects(()=>bridge.history.assign(request),/已经分配/);
  await fs.rm(path.join(store,'datasets',id(100)),{recursive:true,force:true});
  row=(await bridge.history.job(value.id)).cases[0];assert.equal(row.assigned,false);
  await bridge.history.assign({...request,split:'train'});
  assert.equal((await bridge.history.job(value.id)).cases[0].assignedSplit,'train');
  assert.equal(await exists(path.join(bridge.directory,value.id,'g1-c1.assignment.json')),false);
});

test('failed or conflicting assignment leaves the original reference and manifest intact',async t=>{
  const {bridge,training,job}=await fixture(t),value=await job(1);
  const output=path.join(bridge.directory,value.id,'g1-c1.json'),manifest=path.join(bridge.directory,value.id,'manifest.json');
  const before=await fs.readFile(output,'utf8'),beforeManifest=await fs.readFile(manifest,'utf8');
  for(const failure of ['group','duplicate']) {
    training.request=async command=>{
      if(command==='status')return {current:null};
      if(failure==='group')throw new Error('同一几何不能跨训练集和验证集');
      return {duplicate:true,sample:{id:id(100),split:'train'}};
    };
    await assert.rejects(()=>bridge.history.assign({jobId:value.id,key:'g1-c1',split:'validation'}),/同一几何/);
    assert.equal(await fs.readFile(output,'utf8'),before);
    assert.equal(await fs.readFile(manifest,'utf8'),beforeManifest);
    assert.equal(await exists(output.replace('.json','.assignment.json')),false);
    assert.equal(bridge.busy,false);
  }
});

test('generation, training and concurrent history mutations are guarded',async t=>{
  const {bridge,job,training}=await fixture(t),value=await job(1),payload={scope:'job',jobId:id(1)};
  const impact=await bridge.history.impact(payload);
  bridge.starting=true;
  await assert.rejects(()=>bridge.history.impact(payload),/等待/);
  await assert.rejects(()=>bridge.history.remove({...payload,token:impact.token}),/等待/);
  bridge.starting=false;
  training.request=async()=>({current:{status:'training'}});
  await assert.rejects(()=>bridge.history.remove({...payload,token:impact.token}),/暂停训练/);
  assert.equal(bridge.managing,false);
  let entered,release;
  const entering=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  training.request=async()=>{entered();await hold;return {current:null};};
  const removal=bridge.history.remove({...payload,token:impact.token});await entering;
  assert.equal(bridge.busy,true);
  await assert.rejects(()=>bridge.history.assign({jobId:value.id,key:'g1-c1',split:'train'}),/等待/);
  release();assert.deepEqual((await removal).failed,[]);assert.equal(bridge.busy,false);
});
