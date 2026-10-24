'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {TrainingBridge}=require('../training-bridge');

function harness(t,{rejectResume=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fem-supervisor-'));
  const python=path.join(root,'python_machine_learning','.venv-cpu',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const children=[],requests=[];
  let savedStatus='recoverable';
  const bridge=new TrainingBridge(root,{restartDelay:0,spawnProcess:()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(data,encoding,callback){
      const request=JSON.parse(data.toString());requests.push(request);
      if(request.command==='pause')savedStatus='paused';
      const result=request.command==='status'?{current:null,runs:[{id:'a'.repeat(32),status:savedStatus}]}:{id:'a'.repeat(32)};
      queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,
        ok:!(rejectResume&&request.command==='resume'),result,error:'resume rejected'})+'\n'));
      callback();
    }});
    children.push(child);return child;
  }});
  return {bridge,children,requests,setSavedStatus:status=>{savedStatus=status;}};
}

test('unexpected Python exit resumes the saved run without replaying datasets or adding epochs',async t=>{
  const h=harness(t);
  await h.bridge.request('start',{continuousTraining:true,unattendedTraining:true,datasetIds:['fixture']});
  h.children[0].emit('exit',1);
  await h.bridge.recovering;
  assert.equal(h.children.length,2);
  assert.deepEqual(h.requests.find(r=>r.command==='resume').payload,{runId:'a'.repeat(32)});
  const status=await h.bridge.request('status');
  assert.equal(status.processRecovery.attempts,1);
  assert.equal(status.processRecovery.error,'');
});

test('pause during restart backoff cancels the resume intent',async t=>{
  const h=harness(t);
  await h.bridge.request('start',{continuousTraining:true});
  h.children[0].emit('exit',1);
  await h.bridge.request('pause');
  assert.equal(h.requests.filter(r=>r.command==='resume').length,0);
  assert.equal(h.children.length,1);
  assert.equal(h.bridge.desiredRun,null);
});

test('repeated restart errors have a strict budget and visible reason',async t=>{
  const h=harness(t,{rejectResume:true});
  await h.bridge.request('start',{continuousTraining:true});
  h.children[0].emit('exit',1);
  await h.bridge.recovering;
  assert.equal(h.requests.filter(r=>r.command==='resume').length,3);
  const status=await h.bridge.request('status');
  assert.match(status.processRecovery.error,/次数已用尽.*resume rejected/);
});

test('finished or manually paused checkpoints are never automatically restarted',async t=>{
  for(const status of ['completed','paused']) {
    const h=harness(t);await h.bridge.request('start',{continuousTraining:true});
    h.setSavedStatus(status);h.children[0].emit('exit',0);await h.bridge.recovering;
    assert.equal(h.requests.filter(r=>r.command==='resume').length,0);
  }
});

test('finite training and disabled unattended protection do not enable the supervisor',async t=>{
  for(const options of [{continuousTraining:false},{continuousTraining:true,unattendedTraining:false}]) {
    const h=harness(t);await h.bridge.request('start',options);h.children[0].emit('exit',1);
    assert.equal(h.bridge.recovering,null);assert.equal(h.children.length,1);
  }
});
