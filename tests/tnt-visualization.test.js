const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const source=fs.readFileSync(require.resolve("../src/core/tnt-visualization.js"),"utf8");
function harness(){const context=vm.createContext({});vm.runInContext(source,context);return context;}

test("late damage and wavefront overlays use GPU batches, reuse camera redraws and refresh per frame",()=>{
  const calls=[],data={runInfo:{blastFrame:true},frameRevision:1,nodeByNo:new Map(),elements:[
    {damage:.79,dynamicEquivalentStress:10},{damage:.8,dynamicEquivalentStress:0},{damage:1,dynamicEquivalentStress:0}]};
  const history={peakDynamicStress:100,model:{elements:[{nodeNumbers:[1,2,3]},{nodeNumbers:[2,4,3]},{nodeNumbers:[2,5,4]}]},frames:[]};
  const api=vm.createContext({calculationResultData:data,blastHistory:history,
    resultCtx:{save(){},restore(){},beginPath(){throw new Error('GPU path must not construct Canvas paths');}},
    document:{getElementById:()=>({checked:true})},gpuColor:()=>[0,1,1,1],drawGpuResultMesh:(key,color,options)=>{calls.push({key,options});return true;}});
  vm.runInContext(source,api);api.drawTntResultView();
  assert.deepEqual(calls.map(c=>c.key),['tnt-stress','tnt-front','tnt-damage-outline']);
  assert.equal(calls[1].options.edges.length,1);assert.equal(calls[2].options.elements.length,2);
  const front=calls[1].options.edges,damaged=calls[2].options.elements;
  calls.length=0;api.drawTntResultView();assert.equal(calls[1].options.edges,front);assert.equal(calls[2].options.elements,damaged);
  data.elements[0].damage=.9;data.frameRevision++;calls.length=0;api.drawTntResultView();
  assert.notEqual(calls[2].options.elements,damaged);assert.equal(calls[2].options.elements.length,3);
});

test("TNT source uses saved frame pressure and time without modifying solver settings",()=>{
  const api=harness(),settings=Object.freeze({x:2,y:-1,radius:.1,pressure:1e7,pulse:.001});
  assert.equal(api.tntSourceState(settings).phase,"待起爆");
  const active=api.tntSourceState(settings,{time:.0005,pressure:5e6});
  assert.equal(active.ratio,.5);assert.equal(active.phase,"压力脉冲");assert.equal(active.x,2);
  assert.equal(api.tntSourceState(settings,{time:.002,pressure:0}).phase,"脉冲结束");
  assert.equal(api.tntSourceState({...settings,pressure:0},{time:.0005,pressure:0}).ratio,0);
  assert.equal(api.tntSourceState({...settings,radius:0}),null);
});
test("TNT wave scale stays fixed across frames and the threshold boundary follows computed cells",()=>{
  const api=harness();
  const history={model:{elements:[{node1:1,node2:2,node3:3},{node1:2,node2:4,node3:3}]},
    frames:[{elements:[[0,0,0,10,0,0,0],[0,0,0,0,0,0,0]]},
      {elements:[[0,0,0,100,0,0,0],[0,0,0,1,0,0,0]]}]};
  const metrics=api.tntHistoryMetrics(history);
  assert.equal(metrics.peak,100);assert.equal(metrics.threshold,3);
  assert.equal(metrics.edges.length,1,"only the internal shared edge is a response interface");
  const boundary=api.tntResponseEdges([{equivalentStress:10},{equivalentStress:1}],metrics);
  assert.equal(boundary.length,1);
  assert.deepEqual([boundary[0].a,boundary[0].b].sort(),[2,3]);
  assert.equal(api.tntResponseEdges([{equivalentStress:10},{equivalentStress:10}],metrics).length,0);
});
test("zero-stress histories do not fabricate a wavefront",()=>{
  const api=harness();
  const metrics=api.tntHistoryMetrics({model:{elements:[]},frames:[{elements:[[0,0,0,0,0,0,0]]}]});
  assert.equal(metrics.peak,0);assert.equal(api.tntResponseEdges([],metrics).length,0);
});

test("TNT charge and air annulus use independent radii while retaining saved wall pressure",()=>{
  const api=harness(),settings=Object.freeze({x:0,y:0,radius:1,chargeRadius:.5,pressure:1e7,pulse:.001});
  const source=api.tntSourceState(settings,{time:.0005,pressure:3e6});
  assert.equal(source.radius,.5);assert.equal(source.cavityRadius,1);assert.equal(source.airGap,.5);
  assert.equal(source.pressure,3e6);assert.equal(source.ratio,.3);
  assert.equal(api.tntSourceState({...settings,chargeRadius:0}),null);
});


test("gas timeline plots computed wall-pressure samples and keeps loading after the unused pulse",()=>{
  const commands=[],ctx=new Proxy({},{get:(_,key)=>key==="lineTo"?((x,y)=>commands.push([x,y])):()=>{}});
  const labels={},canvas={width:120,height:100,getContext:()=>ctx};
  const api=vm.createContext({document:{getElementById:id=>id==="tntPressureChart"?canvas:(labels[id] ||= {})}});
  vm.runInContext(source,api);
  vm.runInContext('blastHistory={settings:{x:0,y:0,radius:.1,chargeRadius:.05,sourceMode:1,airPressure:1,pressure:999,pulse:.01,duration:1},frames:[{time:0,pressure:1},{time:.5,pressure:2},{time:1,pressure:4}]};tntCurrentFrame=blastHistory.frames[2];updateTntTimeline();',api);
  assert.equal(labels.tntPhase.textContent,"气体加载");
  assert.ok(commands.some(([x,y])=>x===60 && y===50),"midpoint follows sample p=2 / peak=4");
});
