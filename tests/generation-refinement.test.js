'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { markTrainingAdaptiveElements, planAdaptiveRefinement, createAdaptiveRefinementPolicy } = require('../src/core/adaptive-mesh');
const { refineWithinBudget, refineInWorker } = require('../python_machine_learning/generation-refinement.cjs');

const nodes = [{id:'a',x:0,y:0},{id:'b',x:1,y:0},{id:'c',x:0,y:1},{id:'d',x:1,y:1}];
const elements = [{id:'hot',nodeIds:['a','b','c'],area:.5,edges:[],regionId:'R1',materialId:'M'},
  {id:'other',nodeIds:['b','d','c'],area:.5,edges:[],regionId:'R1',materialId:'M'}];
const policy = createAdaptiveRefinementPolicy(nodes,elements);

test('point protection ends at its patch and ordinary hotspots can relax only three levels', () => {
  const payload = {nodes,loads:{point:[{fx:1,fy:0,anchor:{x:0,y:0}}]},elements:[
    {id:'core',area:policy.minArea*2,centroid:{x:0,y:0}},
    {id:'support',area:policy.minArea*2,centroid:{x:policy.pointLoadRadius*2,y:0}},
    {id:'far',area:policy.baseArea,centroid:{x:100,y:0}},
  ]};
  const estimate = {indicators:[{id:'core',value:10},{id:'support',value:100},{id:'far',value:1}]};
  const initial = markTrainingAdaptiveElements(payload,estimate,policy);
  assert.ok(initial.ordinaryFrozenErrorFraction>.9);
  const rescue = markTrainingAdaptiveElements(payload,estimate,policy,1);
  assert.ok(rescue.marked.has('support'), 'force halo must not shield a remote support');
  assert.ok(!rescue.marked.has('core'), 'core floor never relaxes');
  assert.equal(markTrainingAdaptiveElements(payload,estimate,policy,100).ordinaryFloor,
    markTrainingAdaptiveElements(payload,estimate,policy,3).ordinaryFloor);
  assert.ok(rescue.markedErrorFraction>.9);
});

test('raw high-error hotspot keeps priority and the marked set is bounded', () => {
  const payload = {nodes,loads:{point:[]},elements:Array.from({length:5000},(_,i)=>({id:String(i),area:1,centroid:{x:i,y:0}}))};
  const result = markTrainingAdaptiveElements(payload,{indicators:payload.elements.map((e,i)=>({id:e.id,value:i===4999?1e6:1}))},policy);
  assert.equal([...result.marked][0],'4999');
  assert.ok(result.marked.size<=96);
  assert.ok(result.markedErrorFraction>.99);
});

test('preflight counts shared edges once and retains high-priority cells within the node budget', () => {
  const planned = planAdaptiveRefinement(nodes,elements,new Set(['hot','other']),7);
  assert.deepEqual([...planned.marked],['hot']);
  assert.equal(planned.predictedNodes,7);
  assert.equal(planAdaptiveRefinement(nodes,elements,new Set(['hot','other']),9).predictedNodes,9);
  assert.equal(planAdaptiveRefinement(nodes,elements,new Set(['hot']),4).marked.size,0);
});

test('quality-node overflow retries a smaller selection without mutating the solved mesh', async () => {
  const saved = JSON.stringify({nodes,elements}),calls=[];
  const result = await refineWithinBudget(nodes,elements,new Set(['hot','other']),10,1000,async(n,e,marked)=>{
    calls.push([...marked]);return {analysisNodes:Array(marked.size===2?11:8).fill({}),elements:[]};
  });
  assert.deepEqual(calls,[['hot','other'],['hot']]);
  assert.equal(result.mesh.analysisNodes.length,8);
  assert.equal(result.attempts.length,2);
  assert.equal(JSON.stringify({nodes,elements}),saved);
});

test('timeout, failure and exhausted budget return no unsolved candidate', async () => {
  for (const [failure,reason] of [[Object.assign(new Error('timeout'),{timedOut:true}),'time-limit'],[new Error('invalid mesh'),'refinement-failure']]) {
    const result=await refineWithinBudget(nodes,elements,new Set(['hot']),10,1000,async()=>{throw failure;});
    assert.equal(result.stopReason,reason);assert.equal(result.mesh,undefined);
  }
  let calls=0;
  const capped=await refineWithinBudget(nodes,elements,new Set(['hot','other']),10,1000,async()=>{calls++;return {analysisNodes:Array(11)};});
  assert.equal(capped.stopReason,'node-budget');assert.ok(calls<=4);
});

test('actual refinement thread is terminated and awaited on timeout', async () => {
  await assert.rejects(refineInWorker(nodes,elements,new Set(['hot']),1),error=>error.timedOut===true);
});

test('actual isolated Triangle refinement preserves area and respects a small budget', async () => {
  const result=await refineWithinBudget(nodes,elements,new Set(['hot','other']),7,10000);
  assert.ok(result.mesh,result.error);
  assert.ok(result.mesh.analysisNodes.length<=7);
  assert.ok(Math.abs(result.mesh.elements.reduce((sum,e)=>sum+e.area,0)-1)<1e-10);
});

test('Triangle receives a finite quality-node allowance, while ordinary callers retain their switches', async () => {
  const {initializeTriangle}=require('../python_machine_learning/generation-core.cjs');
  const {refineAdaptiveWithTriangle}=require('../src/core/adaptive-mesh');
  const api=await initializeTriangle(),switches=[];
  const traced={...api,triangulate:(options,...args)=>{switches.push(options);return api.triangulate(options,...args);}};
  const capped=refineAdaptiveWithTriangle(traced,nodes,elements,new Set(['hot']),{maxNodes:7});
  assert.ok(capped.analysisNodes.length<=7);
  refineAdaptiveWithTriangle(traced,nodes,elements,new Set(['hot']));
  assert.ok(switches[0].includes('S0'));
  assert.equal(switches[1],'rpzq20YYQ');
});
