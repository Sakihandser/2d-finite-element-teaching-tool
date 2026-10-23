'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness() {
  const elements=new Map(),requests=[];
  const el=id=>{
    if(!elements.has(id))elements.set(id,{value:'',dataset:{},style:{},listeners:{},classList:{toggle(){}},
      addEventListener(name,callback){this.listeners[name]=callback;},getContext(){return {clearRect(){}};}});
    return elements.get(id);
  };
  for(const [id,value] of Object.entries({trainingEpochs:'2',trainingLearningRate:'.001',trainingLrPatience:'8',trainingEarlyPatience:'25'}))el(id).value=value;
  el('trainingAdaptive').checked=true;
  const source={id:'a'.repeat(32),name:'old model',status:'completed',epoch:4,step:8,config:{epochs:4},history:[],seenIds:[]};
  const branch={...source,id:'f'.repeat(32),name:'restored weights',status:'ready',epoch:2,step:4,dataSelectionPending:true,config:{epochs:2}};
  const datasets=['b','c','d'].map(letter=>({id:letter.repeat(32),name:letter,split:letter==='c'?'validation':'train',variants:2}));
  const state={current:null,runs:[source],datasets,events:[],environment:{backend:'cpu',torch:'fixture'}};
  const point={file:'checkpoint-000000000004-1.pt',valid:true,step:4,epoch:2,bytes:1024};
  const errors=new Map();
  const context={console,Date,setInterval(){},document:{getElementById:el,querySelectorAll:()=>[]},window:{},
    fetch:async(url,options)=>{
      const payload=options?.body?JSON.parse(options.body):{};requests.push({url,payload});
      if(errors.has(url))return {ok:false,json:async()=>({error:errors.get(url)})};
      let result;
      if(url.endsWith('/status'))result=state;
      else if(url.endsWith('/checkpoints'))result={checkpoints:[point]};
      else if(url.endsWith('/storage-summary'))result=Object.fromEntries(['exports','predictions','legacy-deleted'].map(k=>[k,{count:0,bytes:0}]));
      else if(url.endsWith('/restore-checkpoint')){
        state.current=branch;state.runs=[branch,source];result={id:branch.id,status:'ready'};
      }else if(url.endsWith('/resume')){
        branch.status='training';branch.dataSelectionPending=false;result={id:branch.id};
      }else throw new Error(url);
      return {ok:true,json:async()=>structuredClone(result)};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/pages/training/dashboard.js'),'utf8'),context);
  return {el,requests,errors,context,point,source,branch,state};
}

test('checkpoint button restores idle weights; training button uses the new record and exact current selection',async()=>{
  const h=harness();await h.context.window.trainingDashboard.refresh();
  h.el('trainingCheckpoint').value=h.point.file;h.el('trainingCheckpoint').listeners.change();
  await h.el('trainingResumeCheckpoint').listeners.click();
  assert.deepEqual(h.requests.filter(r=>r.url.endsWith('/restore-checkpoint')).map(r=>r.payload),[{runId:h.source.id,checkpointFile:h.point.file}]);
  assert.equal(h.requests.filter(r=>r.url.endsWith('/resume')).length,0);
  assert.equal(h.el('trainingRun').value,h.branch.id);
  assert.equal(h.el('trainingState').textContent,'待训练');
  assert.equal(h.el('trainingResume').disabled,false);
  h.el('trainingDatasets').listeners.change({target:{dataset:{trainingSample:'d'.repeat(32)},checked:false}});
  // A selection in the management dropdown must not silently rewind weights
  // again when the user clicks the separate training-control button.
  h.el('trainingCheckpoint').value=h.point.file;
  await h.el('trainingResume').listeners.click();
  const request=h.requests.find(r=>r.url.endsWith('/resume'));
  assert.equal(request.payload.runId,h.branch.id);
  assert.deepEqual(request.payload.datasetIds,['b'.repeat(32),'c'.repeat(32)]);
  assert.equal(request.payload.additionalEpochs,2);
  assert.equal(request.payload.automaticRecovery,true);
  assert.equal(request.payload.maxRecoveryAttempts,3);
  assert.equal(Object.hasOwn(request.payload,'checkpointFile'),false);
});

test('failed preparation leaves controls usable and permits correcting the selection and retrying',async()=>{
  const h=harness();await h.context.window.trainingDashboard.refresh();
  h.el('trainingCheckpoint').value=h.point.file;
  h.errors.set('/api/training/restore-checkpoint','无法恢复检查点');
  await h.el('trainingResumeCheckpoint').listeners.click();
  assert.equal(h.el('trainingRun').disabled,false);
  assert.equal(h.el('trainingResume').disabled,false);
  assert.equal(h.context.window.trainingDashboard.busy,null);
  h.errors.clear();await h.el('trainingResumeCheckpoint').listeners.click();
  h.errors.set('/api/training/resume','训练工况文件已删除或缺失');
  await h.el('trainingResume').listeners.click();
  assert.equal(h.el('trainingState').textContent,'待训练');
  assert.equal(h.el('trainingResume').disabled,false);
  assert.equal(h.el('trainingRun').disabled,false);
  assert.equal(h.context.window.trainingDashboard.busy,false);
  h.errors.clear();await h.el('trainingResume').listeners.click();
  assert.equal(h.el('trainingState').textContent,'训练中');
});
