'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('dataset row and batch actions change learning split and refresh actual assignment displays',async()=>{
  const elements=new Map(),requests=[];
  const el=id=>{
    if(!elements.has(id))elements.set(id,{value:'',dataset:{},style:{},listeners:{},classList:{toggle(){}},
      addEventListener(name,callback){this.listeners[name]=callback;},getContext(){return {clearRect(){}};}});
    return elements.get(id);
  };
  const datasets=['a','b','c'].map((letter,i)=>({id:letter.repeat(32),name:letter,group:i<2?'same':'other',split:'train',variants:3,referenceNodes:100,referenceError:.05,stopReason:'target-error'}));
  let historyRefreshes=0;
  const context={console,Date,setInterval(){},document:{getElementById:el,querySelectorAll:()=>[]},
    window:{dataGenerator:{busy:false,refresh:async()=>{historyRefreshes++;}}},
    fetch:async(url,options)=>{
      const payload=options?.body?JSON.parse(options.body):{};requests.push({url,payload});
      let result;
      if(url.endsWith('/status'))result={current:null,runs:[],datasets,events:[],environment:{backend:'cpu',torch:'fixture'}};
      else if(url.endsWith('/storage-summary'))result={};
      else if(url.endsWith('/change-dataset-split')) {
        const selected=datasets.filter(s=>payload.datasetIds.includes(s.id)),groups=new Set(selected.map(s=>s.group));
        const changed=datasets.filter(s=>groups.has(s.group)&&s.split!==payload.split);
        for(const sample of changed)sample.split=payload.split;
        result={updatedIds:changed.map(s=>s.id),split:payload.split};
      } else throw new Error(url);
      return {ok:true,json:async()=>structuredClone(result)};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/pages/training/dashboard.js'),'utf8'),context);
  await context.window.trainingDashboard.refresh();
  assert.equal(el('trainingChangeSplitApply').disabled,false);
  await el('trainingDatasets').listeners.click({target:{dataset:{changeDatasetSplit:'a'.repeat(32)}}});
  assert.deepEqual(datasets.map(s=>s.split),['validation','validation','train']);
  assert.ok(el('trainingDatasets').innerHTML.includes('改为训练集'));
  assert.equal(historyRefreshes,1);
  el('trainingChangeSplit').value='train';
  await el('trainingChangeSplitApply').listeners.click();
  assert.ok(datasets.every(s=>s.split==='train'));
  assert.equal(historyRefreshes,2);
  const changes=requests.filter(r=>r.url.endsWith('/change-dataset-split'));
  assert.deepEqual(changes[0].payload,{datasetIds:['a'.repeat(32)],split:'validation'});
  assert.equal(changes[1].payload.datasetIds.length,3);
});
