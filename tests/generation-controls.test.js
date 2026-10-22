'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('generator controls pause active work and resume the selected historical batch',async()=>{
  const elements=new Map(),requests=[];
  function el(id) {
    if(!elements.has(id))elements.set(id,{
      value:'',style:{},listeners:{},disabled:false,
      addEventListener(name,callback){this.listeners[name]=callback;},appendChild(){},
    });
    return elements.get(id);
  }
  const old={id:'a'.repeat(32),createdAt:new Date().toISOString(),config:{seed:'original'},status:'paused',
    cases:[],nextCase:1,completed:1,failed:0,imported:0,total:3};
  const latest={...old,id:'b'.repeat(32),status:'completed',nextCase:3,completed:3};
  let snapshot={busy:false,generating:false,current:latest,jobs:[latest,old],history:{batches:2,cases:4,assigned:0}};
  const context={Date,console,document:{getElementById:el,querySelectorAll:()=>[]},
    window:{trainingDashboard:{controls(){},refresh(){}}},currentPageKey:()=> 'training',setInterval(){},
    fetch:async(url,options)=>{
      requests.push({url,body:options?.body&&JSON.parse(options.body)});
      let result;
      if(url==='/api/materials')result={materials:[]};
      else if(url.endsWith('/status'))result=snapshot;
      else if(url.includes('/manifest/'))result=old;
      else if(url.endsWith('/resume')) {
        assert.equal(JSON.parse(options.body).jobId,old.id);
        snapshot={...snapshot,busy:true,generating:true,current:{...old,status:'running'}};
        result={id:old.id};
      } else if(url.endsWith('/pause')){
        snapshot={...snapshot,current:{...snapshot.current,status:'pausing'}};result={ok:true};
      } else throw new Error(url);
      return {ok:true,json:async()=>structuredClone(result)};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/pages/training/generator.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(el('generationResume').disabled,true);
  el('generationJob').value=old.id;
  await el('generationJob').listeners.change();
  assert.equal(el('generationResume').disabled,false);
  await el('generationResume').listeners.click();
  assert.equal(el('generationResume').disabled,true);
  assert.equal(el('generationStop').disabled,false);
  await el('generationStop').listeners.click();
  assert.equal(el('generationStop').disabled,true);
  assert.ok(requests.some(r=>r.url.endsWith('/pause')));
  assert.equal(requests.some(r=>r.url.endsWith('/start')),false);
});
