"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const { runCalculationCore } = require("../server");
const root = path.resolve(__dirname,"..");
const read = file => fs.readFileSync(path.join(root,file),"utf8");

test("calculation controls and non-DOM defaults agree with requested settings", () => {
  const html=read("index.html");
  for (const [id,value] of [["maxAnalysisNodes","20000"],["adaptiveIterations","6"],["adaptiveTolerance","0.02"],["adaptiveTimeLimitSeconds","10"]]) {
    assert.match(html,new RegExp(`<input id="${id}"[^>]*value="${value}"`));
  }
  const checkbox=html.match(/<input id="useGpuAcceleration"[^>]*>/)[0];
  assert.doesNotMatch(checkbox,/\bchecked\b/);
  const context=vm.createContext({document:{getElementById:()=>null},module:{exports:{}}});
  vm.runInContext(read("src/core/analysis-node-placement.js"),context);
  assert.equal(context.normalizeAnalysisNodeLimit(undefined),20000);
  vm.runInContext(read("src/core/adaptive-mesh.js"),context);
  const config=context.readAdaptiveMeshOptions({});
  assert.equal(config.maxIterations,6);
  assert.equal(config.relativeTolerance,0.02);
  assert.equal(config.timeLimitMs,10000);
});

test("adaptive time limit reads the UI, accepts overrides, and rejects invalid durations", () => {
  const controls = {
    adaptiveMeshEnabled: {checked: false},
    adaptiveTimeLimitSeconds: {value: "25.5"},
    maxAnalysisNodes: {},
  };
  const context = vm.createContext({document: {getElementById: id => controls[id]}});
  vm.runInContext(read("src/core/adaptive-mesh.js"),context);
  assert.equal(context.readAdaptiveMeshOptions().timeLimitMs,25500);
  assert.equal(context.readAdaptiveMeshOptions({timeLimitSeconds: 3}).timeLimitMs,3000);
  for (const timeLimitSeconds of ["",0,-1,NaN,Infinity,0.01,2147484]) {
    assert.throws(()=>context.readAdaptiveMeshOptions({timeLimitSeconds}),/最长耗时/);
  }
  context.syncAdaptiveMeshControls();
  assert.equal(controls.adaptiveTimeLimitSeconds.disabled,true);
  controls.adaptiveMeshEnabled.checked=true;
  context.syncAdaptiveMeshControls();
  assert.equal(controls.adaptiveTimeLimitSeconds.disabled,false);
  assert.equal(controls.maxAnalysisNodes.disabled,true);
  assert.equal(controls.adaptiveTimeLimitSeconds.value,"25.5");
});

test("enabling GPU shows the recommendation; requests transmit an explicit boolean", async () => {
  const alerts=[],bodies=[];
  const context=vm.createContext({alert:message=>alerts.push(message),
    fetch:async (_url,options)=>{
      bodies.push(JSON.parse(options.body));
      return {ok:true,json:async()=>({ok:true})};
    }});
  vm.runInContext(read("src/core/calculation-export.js"),context);
  context.onGpuAccelerationChange({target:{checked:false}});
  assert.equal(alerts.length,0);
  context.onGpuAccelerationChange({target:{checked:true}});
  assert.match(alerts[0],/200 万/);
  await context.runCalculationCoreDirect({nodes:[],elements:[]});
  await context.runCalculationCoreDirect({nodes:[],elements:[]},{useGpuAcceleration:true,adaptive:true,timeLimitMs:25000});
  assert.deepEqual(bodies.map(body=>body.useGpuAcceleration),[false,true]);
  assert.deepEqual(bodies.map(body=>body.adaptive),[false,true]);
  assert.equal(bodies[1].timeLimitMs,25000);
});

test("server forwards adaptive time limits to the native process and retains ordinary defaults", async () => {
  const context = vm.createContext({
    require: createRequire(path.join(root,"server.js")),
    module: {exports:{}}, __dirname: root, process, Buffer,
  });
  vm.runInContext(read("server.js"),context);
  const timeouts = [];
  context.findCalculationCoreExecutable = async () => "test-core.exe";
  context.encodeCalculationModelBinary = () => Buffer.alloc(0);
  context.executeCalculationCoreBinary = async (_exe,_input,_args,_gpu,timeout) => {
    timeouts.push(timeout);
    const error = new Error("simulated timeout");
    error.code = "ETIMEDOUT";
    throw error;
  };
  for (const options of [{adaptive:true,timeLimitMs:25000},{adaptive:true},{timeLimitMs:25000}]) {
    assert.equal((await context.runCalculationCore({nodes:[],elements:[]},options)).timedOut,true);
  }
  assert.deepEqual(timeouts,[25000,10000,120000]);
  for (const timeLimitMs of [0,-100,NaN,Infinity,99,2147483001]) {
    await assert.rejects(context.runCalculationCore({nodes:[],elements:[]},{adaptive:true,timeLimitMs}),/最长耗时/);
  }
  assert.equal(timeouts.length,3);
});

test("server honors each request's GPU choice without changing inherited process settings", async t => {
  const previous=process.env.FEM_COMPUTE;
  process.env.FEM_COMPUTE="gpu";
  t.after(()=>{if(previous===undefined) delete process.env.FEM_COMPUTE; else process.env.FEM_COMPUTE=previous;});
  const properties={elasticModulus:200e9,poissonRatio:0.3,density:7850};
  const model={modelName:"backend-setting-triangle",materials:[{...properties,materialNo:1}],
    nodes:[
      {nodeNo:1,x:0,y:0,dofUx:1,dofUy:2,fixUx:true,fixUy:true},
      {nodeNo:2,x:1,y:0,dofUx:3,dofUy:4,fixUx:false,fixUy:true},
      {nodeNo:3,x:0,y:1,dofUx:5,dofUy:6,forceY:-1000},
    ].map(node=>({materialNo:1,regionNo:1,...node})),
    elements:[{...properties,elementNo:1,node1:1,node2:2,node3:3,area:0.5,centroidX:1/3,centroidY:1/3,materialNo:1}],
    elementNodeLoads:[]};
  const [cpu,gpu]=await Promise.all([runCalculationCore(model),runCalculationCore(model,{useGpuAcceleration:true})]);
  assert.equal(cpu.ok,true,cpu.stderr);
  assert.equal(gpu.ok,true,gpu.stderr);
  assert.match(cpu.stderr,/CPU explicitly selected/);
  assert.match(gpu.stderr,/OpenCL FP64:|CPU fallback:|CPU: optional OpenCL/);
  if(process.env.FEM_TEST_REQUIRE_GPU==="1") {
    assert.match(gpu.stderr,/OpenCL FP64:/);
    assert.match(gpu.stderr,/Element strain\/stress backend: OpenCL GPU FP64/);
  }
  assert.equal(process.env.FEM_COMPUTE,"gpu");
  assert.ok(Math.abs(cpu.resultData.nodeDisplacements[2].uy-gpu.resultData.nodeDisplacements[2].uy)<1e-12);
});
