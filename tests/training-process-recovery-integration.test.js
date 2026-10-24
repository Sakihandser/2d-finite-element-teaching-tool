'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const test=require('node:test');
const {TrainingBridge}=require('../training-bridge');
const root=path.join(__dirname,'..');
const directory=path.join(root,'python_machine_learning');
const python=path.join(directory,'.venv-cpu',process.platform==='win32'?'Scripts/python.exe':'bin/python');

test('a terminated real Python process resumes isolated continuous training and still honors pause',
  {skip:!fs.existsSync(python),timeout:60000},async t=>{
    const storage=fs.mkdtempSync(path.join(os.tmpdir(),'fem-process-recovery-real-'));
    const env={...process.env,FEM_ML_STORAGE:storage,FEM_ML_DEVICE:'cpu',FEM_ML_RUNTIME_VERIFIED:'1',PYTHONIOENCODING:'utf-8'};
    const children=[];
    let bridge;
    t.after(async()=>{
      if(bridge)bridge.desiredRun=null;
      for(const child of children)child.stdin.destroy();
      if(bridge?.recovering)await bridge.recovering;
      await new Promise(resolve=>setTimeout(resolve,300));
      fs.rmSync(storage,{recursive:true,force:true,maxRetries:20,retryDelay:100});
    });
    const seed=spawnSync(python,['-c',
      'import os; from test_training import TrainingTests; f=TrainingTests(); s=f.service(os.environ["FEM_ML_STORAGE"]); print(f.seed(s))'],
      {cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(seed.status,0,seed.stderr);
    const runId=seed.stdout.trim();
    bridge=new TrainingBridge(root,{restartDelay:1000,spawnProcess:()=>{
      // Launch the actual protocol service directly so killing the selected
      // process also tests Windows venv redirector/orphan stdin cleanup.
      const child=spawn(python,['-u',path.join(directory,'worker.py')],{cwd:directory,env,
        windowsHide:true,stdio:['pipe','pipe','pipe']});
      children.push(child);return child;
    }});
    await bridge.request('resume',{runId,continuousTraining:true,unattendedTraining:true,batchGraphs:2,symmetryAugmentation:true,additionalEpochs:4});
    let before=await bridge.request('status');
    assert.equal(before.current.status,'training');
    const lost=children[0];const exited=once(lost,'exit');lost.kill();await exited;
    await bridge.recovering;
    const recovered=await bridge.request('status');
    assert.equal(recovered.current?.id,runId,JSON.stringify(recovered.processRecovery));
    assert.equal(recovered.current.status,'training');
    assert.equal(recovered.processRecovery.attempts,1);
    assert.equal(recovered.processRecovery.error,'');
    await bridge.request('pause');
    let paused;
    const deadline=Date.now()+10000;
    do {
      paused=await bridge.request('status');
      if(paused.current.status==='paused')break;
      await new Promise(resolve=>setTimeout(resolve,20));
    } while(Date.now()<deadline);
    assert.equal(paused.current.status,'paused');
    assert.equal(paused.current.stopReason,'manual-pause');
    assert.equal(bridge.desiredRun,null);
    const child=children.at(-1);const closed=once(child,'exit');child.stdin.end();await closed;
  });
