'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {markAdaptiveHotspots,planAdaptiveRefinement,createAdaptiveRefinementPolicy}=require('../src/core/adaptive-mesh');
const nodes=[{id:'a',x:0,y:0},{id:'b',x:1,y:0},{id:'c',x:0,y:1},{id:'d',x:1,y:1}];
const elements=[{id:'hot',nodeIds:['a','b','c'],area:.5},{id:'other',nodeIds:['b','d','c'],area:.5}];
const policy=createAdaptiveRefinementPolicy(nodes,elements);

test('compact point protection leaves remote hotspots available and never relaxes the force core',()=>{
  const payload={nodes,loads:{point:[{fx:1,fy:0,anchor:{x:0,y:0}}]},elements:[
    {id:'core',area:policy.minArea*2,centroid:{x:0,y:0}},
    {id:'support',area:policy.minArea*2,centroid:{x:policy.pointLoadRadius*2,y:0}},
    {id:'background',area:policy.baseArea,centroid:{x:100,y:0}}]};
  const estimate={indicators:[{id:'core',value:10},{id:'support',value:100},{id:'background',value:1}]};
  assert.ok(markAdaptiveHotspots(payload,estimate,policy).ordinaryFrozenErrorFraction>.9);
  for(const level of [1,2,3,100]){
    const result=markAdaptiveHotspots(payload,estimate,policy,level);
    assert.ok(result.marked.has('support'));
    assert.ok(!result.marked.has('core'));
    assert.ok(result.rescueLevel<=3);
    assert.ok(result.ordinaryFloor>=1e-10);
  }
});

test('raw error gets priority with a bounded marked set and a shared-edge node forecast',()=>{
  const payload={nodes,elements:Array.from({length:5000},(_,i)=>({id:String(i),area:1,centroid:{x:i,y:0}}))};
  const selected=markAdaptiveHotspots(payload,{indicators:payload.elements.map((e,i)=>({id:e.id,value:i===4999?1e6:1}))},policy);
  assert.equal([...selected.marked][0],'4999');
  assert.ok(selected.marked.size<=96);
  assert.ok(selected.markedErrorFraction>.99);
  assert.deepEqual([...planAdaptiveRefinement(nodes,elements,new Set(['hot','other']),7).marked],['hot']);
  assert.equal(planAdaptiveRefinement(nodes,elements,new Set(['hot','other']),9).predictedNodes,9);
});

test('quality-node overflow retries smaller candidates under a shared deadline',async()=>{
  const context=vm.createContext({console,performance:{now:()=>0},module:{exports:{}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/core/adaptive-mesh.js'),'utf8'),context);
  const calls=[];
  context.refineAdaptiveSafely=async(api,n,e,marked,time,options)=>{
    calls.push({marked:[...marked],time,cap:options.maxNodes});
    return {analysisNodes:Array(marked.size===2?11:8),elements:[]};
  };
  const result=await context.refineAdaptiveWithinBudget(null,nodes,elements,new Set(['hot','other']),10,1000);
  assert.equal(result.mesh.analysisNodes.length,8);
  assert.deepEqual(calls.map(c=>c.marked),[['hot','other'],['hot']]);
  assert.ok(calls.every(c=>c.cap===10&&c.time<=1000));
  assert.equal(result.attempts.length,2);
});
