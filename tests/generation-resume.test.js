'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {GenerationBridge,continuationIndex}=require('../generation-bridge');
const {atomicJson,replaceFile}=require('../generation-files');

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fem-generation-resume-'));
  t.after(async()=>{
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('fem-generation-resume-'));
    await fs.rm(root,{recursive:true,force:true});
  });
  await fs.mkdir(path.join(root,'materials'));
  await fs.writeFile(path.join(root,'materials/materials.json'),JSON.stringify({materials:[{id:'original'}]}));
  const imports=[];
  const training={request:async(command,payload)=>{
    if(command==='status')return {current:null};
    imports.push(JSON.parse(await fs.readFile(payload.path,'utf8')).name);
    return {sample:{id:'a'.repeat(32),split:payload.split},duplicate:false};
  }};
  const calls=[];
  function bridge() {
    const value=new GenerationBridge(root,path.join(root,'storage'),training);
    value.generateGeometry=async(config,index)=>Array.from({length:config.conditions},(_,j)=>({
      name:`${config.seed}-g${index+1}-c${j+1}`,dataGeneration:{geometryIndex:index,caseIndex:j}}));
    value.worker=async request=>{
      const source=JSON.parse(await fs.readFile(request.input,'utf8'));calls.push(source.name);
      const scene={...source,analysisNodes:[{}],mesh:{elements:[{}],metadata:{adaptive:{history:[{relativeError:.01,stopReason:'target-error'}]}}}};
      await fs.writeFile(request.output,JSON.stringify(scene));
    };
    return value;
  }
  const config={seed:'resume-test',geometries:2,conditions:3,autoImport:true};
  return {root,bridge,config,imports,calls,training};
}

test('atomic replacement retries transient Windows sharing errors and cleans unique temp files',async t=>{
  const {root}=await fixture(t),file=path.join(root,'manifest.json');
  await atomicJson(file,{previous:true});
  const rename=fs.rename;let attempts=0;
  t.mock.method(fs,'rename',async(...args)=>{
    if(++attempts<=3) {
      assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{previous:true});
      throw Object.assign(new Error('OneDrive sharing lock'),{code:['EPERM','EACCES','EBUSY'][attempts-1]});
    }
    return rename(...args);
  });
  await atomicJson(file,{next:true});
  assert.equal(attempts,4);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{next:true});
  assert.equal((await fs.readdir(root)).some(name=>name.endsWith('.tmp')),false);
});

test('permanent storage errors are bounded and preserve the previous manifest',async t=>{
  const {root}=await fixture(t),file=path.join(root,'manifest.json');
  await atomicJson(file,{previous:true});
  t.mock.method(fs,'rename',async()=>{throw Object.assign(new Error('locked'),{code:'EPERM'});});
  await assert.rejects(()=>replaceFile('unused',file,{timeout:0}),/locked/);
  t.mock.method(fs,'writeFile',async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});});
  await assert.rejects(()=>atomicJson(file,{next:true}),/disk full/);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{previous:true});
});

test('pause finishes and imports current case; restart resumes original batch without duplicates',async t=>{
  const f=await fixture(t),first=f.bridge(),worker=first.worker;
  first.worker=async request=>{await first.pause();await worker(request);};
  const {id}=await first.start(f.config);await first.runningTask;
  assert.equal(first.current.status,'paused');assert.equal(first.current.nextCase,1);
  assert.equal(first.current.imported,1);assert.equal(first.busy,false);
  const snapshot=structuredClone(first.current.config);
  await fs.writeFile(path.join(f.root,'materials/materials.json'),JSON.stringify({materials:[{id:'changed'}]}));
  const second=f.bridge();await second.resume({jobId:id});await second.runningTask;
  assert.equal(second.current.id,id);assert.equal(second.current.status,'completed');
  assert.deepEqual(second.current.config,snapshot);
  assert.equal(second.current.completed,6);assert.equal(second.current.imported,6);
  assert.equal(new Set(f.calls).size,6);assert.equal(f.calls.length,6);
  assert.equal(f.imports.length,6);assert.equal(second.current.cases.length,6);
});

test('single solver error is recorded and skipped while remaining cases complete',async t=>{
  const f=await fixture(t),bridge=f.bridge(),worker=bridge.worker;
  bridge.worker=async request=>{
    if(request.output.endsWith('g1-c2.json'))throw new Error('native solver crashed');
    await worker(request);
  };
  await bridge.start(f.config);await bridge.runningTask;
  assert.equal(bridge.current.status,'completed');assert.equal(bridge.current.failed,1);
  assert.equal(bridge.current.completed,5);assert.equal(bridge.current.imported,5);
  assert.equal(bridge.current.cases[1].status,'failed');assert.equal(bridge.current.nextCase,6);
});

test('a lost checkpoint pauses safely; continuation retains the completed case',async t=>{
  const f=await fixture(t),bridge=f.bridge(),write=fs.writeFile;let injected=false;
  t.mock.method(fs,'writeFile',async(file,contents,...rest)=>{
    if(!injected&&String(file).includes('manifest.json.')&&JSON.parse(contents).nextCase===1) {
      injected=true;throw Object.assign(new Error('disk full'),{code:'ENOSPC'});
    }
    return write(file,contents,...rest);
  });
  const {id}=await bridge.start(f.config);await bridge.runningTask;
  assert.equal(bridge.current.status,'paused');assert.match(bridge.current.error,/保存生成记录失败/);
  assert.equal(bridge.current.nextCase,1);assert.equal(bridge.busy,false);
  await bridge.resume({jobId:id});await bridge.runningTask;
  assert.equal(bridge.current.status,'completed');assert.equal(f.calls.length,6);assert.equal(f.imports.length,6);
});

test('interrupted worker reuses its completed reference then continues remaining cases',async t=>{
  const f=await fixture(t),bridge=f.bridge(),worker=bridge.worker;
  bridge.worker=async request=>{await bridge.pause();await worker(request);};
  const {id}=await bridge.start(f.config);await bridge.runningTask;
  const file=path.join(bridge.directory,id,'manifest.json');
  const record=JSON.parse(await fs.readFile(file,'utf8'));
  delete record.nextCase;record.status='running';record.completed=0;record.imported=0;
  record.cases[0]={key:'g1-c1',status:'running',split:record.cases[0].split};
  await atomicJson(file,record);
  const restored=f.bridge();assert.equal((await restored.jobs())[0].status,'interrupted');
  await restored.resume({jobId:id});await restored.runningTask;
  assert.equal(restored.current.status,'completed');assert.equal(restored.current.completed,6);
  assert.equal(f.calls.length,6); // first case is reused, not solved again
  assert.equal(restored.current.cases.length,6);
});

test('resume rejects concurrent jobs and active training, and retains compatibility with stopped batches',async t=>{
  const f=await fixture(t),bridge=f.bridge(),worker=bridge.worker;
  bridge.worker=async request=>{await bridge.stop();await worker(request);};
  const {id}=await bridge.start(f.config);
  await assert.rejects(()=>bridge.resume({jobId:id}),/正在运行/);await bridge.runningTask;
  assert.equal(bridge.current.status,'stopped');
  f.training.request=async()=>({current:{status:'training'}});
  await assert.rejects(()=>bridge.resume({jobId:id}),/暂停/);assert.equal(bridge.busy,false);
  f.training.request=async()=>({current:null});bridge.worker=worker;
  await bridge.resume({jobId:id});await bridge.runningTask;
  assert.equal(bridge.current.status,'completed');
  await assert.rejects(()=>bridge.resume({jobId:id}),/请选择/);
  await assert.rejects(()=>bridge.resume({jobId:'../escape'}),/路径/);
});

test('legacy cursor skips failed cases while retrying only the interrupted case',()=>{
  assert.equal(continuationIndex({config:{conditions:3},cases:[
    {key:'g1-c1',status:'imported'},{key:'g1-c2',status:'failed'},{key:'g1-c3',status:'running'}]}),2);
  assert.equal(continuationIndex({nextCase:4,config:{conditions:3},cases:[]}),4);
});

test('pause requested on the last case reports the batch as completed',async t=>{
  const f=await fixture(t),bridge=f.bridge(),worker=bridge.worker;
  bridge.worker=async request=>{await bridge.pause();await worker(request);};
  await bridge.start({...f.config,geometries:1,conditions:1});await bridge.runningTask;
  assert.equal(bridge.current.status,'completed');assert.equal(bridge.current.nextCase,1);
});

test('geometry failure skips its group and initial save failure does not leave a busy task',async t=>{
  const f=await fixture(t),bridge=f.bridge(),geometry=bridge.generateGeometry;
  bridge.generateGeometry=async(config,index)=>{
    if(index===0)throw new Error('invalid geometry');
    return geometry(config,index);
  };
  await bridge.start(f.config);await bridge.runningTask;
  assert.equal(bridge.current.status,'completed');assert.equal(bridge.current.failed,3);
  assert.equal(bridge.current.completed,3);assert.equal(bridge.current.cases.length,6);
  const next=f.bridge();
  t.mock.method(fs,'writeFile',async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});});
  await assert.rejects(()=>next.start(f.config),/保存生成记录失败/);
  assert.equal(next.busy,false);assert.equal(next.current.status,'paused');
});
