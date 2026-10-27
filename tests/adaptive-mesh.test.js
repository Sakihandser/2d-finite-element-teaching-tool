"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { estimateZZError, refineAdaptiveTriangles } = require("../src/core/adaptive-mesh");
const { encodeCalculationModelBinary, decodeCalculationResultBinary } = require("../calculation-ipc");
const ROOT = path.resolve(__dirname, "..");

function square() {
  return {
    analysisNodes: [{ id: "A1", x: 0, y: 0 }, { id: "A2", x: 1, y: 0 }, { id: "A3", x: 1, y: 1 }, { id: "A4", x: 0, y: 1 }],
    elements: [{ id: "E1", nodeIds: ["A1", "A2", "A3"], regionId: "R1" }, { id: "E2", nodeIds: ["A1", "A3", "A4"], regionId: "R1" }],
  };
}

function checkMesh(mesh, expectedArea) {
  const nodes = new Map(mesh.analysisNodes.map((n) => [n.id, n]));
  const edges = new Map();
  let area = 0;
  for (const e of mesh.elements) {
    const p = e.nodeIds.map((id) => nodes.get(id));
    const a = ((p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y)) / 2;
    assert.ok(a > 0);
    area += a;
    for (let i = 0; i < 3; i++) {
      const ids = [e.nodeIds[i], e.nodeIds[(i + 1) % 3]].sort();
      const key = ids.join("|");
      edges.set(key, (edges.get(key) || 0) + 1);
      const [u, v] = ids.map((id) => nodes.get(id));
      for (const n of nodes.values()) {
        if (ids.includes(n.id)) continue;
        const cross = (v.x - u.x) * (n.y - u.y) - (v.y - u.y) * (n.x - u.x);
        const dot = (n.x - u.x) * (n.x - v.x) + (n.y - u.y) * (n.y - v.y);
        assert.ok(Math.abs(cross) > 1e-10 || dot >= -1e-10, "no hanging node on any edge");
      }
    }
  }
  assert.ok(Math.abs(area - expectedArea) < 1e-10);
  assert.ok([...edges.values()].every((n) => n === 1 || n === 2));
}

test("local refinement preserves area and shared edges without a node limit", () => {
  let mesh = square();
  const before = JSON.stringify(mesh);
  const refined = refineAdaptiveTriangles(mesh.analysisNodes, mesh.elements, new Set(["E1"]), 6);
  assert.ok(refined.analysisNodes.length > 6);
  assert.equal(JSON.stringify(mesh), before);
  for (let i = 0; i < 3; i++) {
    mesh = refineAdaptiveTriangles(mesh.analysisNodes, mesh.elements, new Set(["E1"]), 1000);
    checkMesh(mesh, 1);
  }
});

test("two split edges close conformingly and retain material regions", () => {
  const nodes = [{ id: "A1", x: 0, y: 0 }, { id: "A2", x: 1, y: 0 }, { id: "A3", x: 0, y: 1 }, { id: "A4", x: 0, y: -1 }, { id: "A5", x: -1, y: 0 }];
  const elements = [{ id: "E1", nodeIds: ["A1", "A2", "A3"], regionId: "middle" }, { id: "E2", nodeIds: ["A2", "A1", "A4"], regionId: "lower" }, { id: "E3", nodeIds: ["A1", "A3", "A5"], regionId: "left" }];
  const result = refineAdaptiveTriangles(nodes, elements, new Set(["E2", "E3"]), 100);
  checkMesh(result, 1.5);
  assert.equal(result.elements.filter((e) => e.regionId === "middle").length, 3);
});

function zzPayload(materials = ["M1", "M1"]) {
  return { elements: square().elements.map((e, i) => ({ ...e, number: i + 1, area: 0.5, materialId: materials[i], region: { id: "R1" }, mechanicalProperties: { elasticModulus: 1, poissonRatio: 0 } })) };
}
const stresses = (values) => ({ elementResults: values.map((s, i) => ({ elementNo: i + 1, stressXx: s, stressYy: 0, stressXy: 0 })) });

test("ZZ uses exact quadratic integration and does not smear material jumps", () => {
  assert.equal(estimateZZError(zzPayload(), stresses([2, 2])).totalError, 0);
  const estimate = estimateZZError(zzPayload(), stresses([0, 1]));
  assert.ok(Math.abs(estimate.totalError - 0.25) < 1e-14);
  assert.ok(Math.abs(estimate.relativeError - 0.5) < 1e-14);
  assert.equal(estimateZZError(zzPayload(["M1", "M2"]), stresses([0, 1])).totalError, 0);
  assert.throws(() => estimateZZError(zzPayload(), stresses([NaN, 1])));
});

test("boundary parameter and varying distributed-load resultant survive refinement", () => {
  const mesh = square();
  mesh.elements[0].edges = [{ nodeIds: ["A1", "A2"], boundary: true, curveId: "C1", tRange: [0, 1], length: 1 }];
  mesh.analysisNodes[0].placement = { curveId: "C1", curveT: 0 };
  mesh.analysisNodes[1].placement = { curveId: "C1", curveT: 1 };
  const refined = refineAdaptiveTriangles(mesh.analysisNodes, mesh.elements, new Set(["E1"]), 100);
  const context = vm.createContext({ window: undefined, clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)), lerp: (a, b, t) => a + (b - a) * t, roundCoord: (v) => v, finiteOrNull: (v) => Number.isFinite(Number(v)) ? Number(v) : null });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/core/scene-objects.js"), "utf8"), context);
  // Check the integration itself before the application's 1e-6 display rounding.
  context.roundCoord = (v) => v;
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/core/calculation-export.js"), "utf8"), context);
  const load = { id: "L1", curveId: "C1", start: 0, end: 1, qStart: 2, qEnd: 6, direction: { x: 0, y: -1 } };
  const sum = (m) => m.elements.flatMap((e) => e.edges || []).filter((e) => e.curveId).reduce((total, edge) => {
    const c = context.distributedLoadContributionForElementEdge(edge, load, new Map(m.analysisNodes.map((n) => [n.id, n])));
    return total + c.nodeLoads.reduce((s, n) => s + n.fy, 0);
  }, 0);
  assert.equal(sum(mesh), -4);
  assert.ok(Math.abs(sum(refined) + 4) < 1e-12);
  const moment = (m) => m.elements.flatMap((e) => e.edges || []).filter((e) => e.curveId).reduce((total, edge) => {
    const nodes = new Map(m.analysisNodes.map((n) => [n.id, n]));
    const c = context.distributedLoadContributionForElementEdge(edge, load, nodes);
    return total + c.nodeLoads.reduce((s, n) => s + nodes.get(n.nodeId).x * n.fy, 0);
  }, 0);
  assert.ok(Math.abs(moment(mesh) + 7 / 3) < 1e-12);
  assert.ok(Math.abs(moment(refined) - moment(mesh)) < 1e-12);
  const mid = refined.analysisNodes.find((n) => n.placement?.sourceType === "adaptiveBoundary");
  assert.equal(mid.placement.curveT, 0.5);
  const body = { id: "B1", targetType: "region", regionId: "R1", magnitude: 2, direction: { x: 0, y: -1 } };
  const bodySum = refined.elements.reduce((sum, e) => {
    const c = context.bodyLoadContributionForElement({ ...e, region: { id: "R1" }, mechanicalProperties: { density: 10 } }, body);
    return sum + c.nodeLoads.reduce((s, n) => s + n.fy, 0);
  }, 0);
  assert.ok(Math.abs(bodySum + 20) < 1e-12);
});

test("reversed boundary ranges follow endpoint parameters when splitting a varying traction", () => {
  const mesh=square();
  mesh.elements[0].edges=[{nodeIds:['A2','A1'],boundary:true,curveId:'C1',tRange:[0,1],length:1}];
  mesh.analysisNodes[0].placement={curveId:'C1',curveT:0};
  mesh.analysisNodes[1].placement={curveId:'C1',curveT:1};
  const refined=refineAdaptiveTriangles(mesh.analysisNodes,mesh.elements,new Set(['E1']));
  const context=vm.createContext({window:undefined,clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v)),lerp:(a,b,t)=>a+(b-a)*t,roundCoord:v=>v,finiteOrNull:v=>Number.isFinite(Number(v))?Number(v):null});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'src/core/scene-objects.js'),'utf8'),context);
  context.roundCoord=v=>v;
  vm.runInContext(fs.readFileSync(path.join(ROOT,'src/core/calculation-export.js'),'utf8'),context);
  const byId=new Map(refined.analysisNodes.map(n=>[n.id,n]));
  const load={curveId:'C1',start:0,end:1,qStart:2,qEnd:6,direction:{x:0,y:-1}};
  let force=0,moment=0;
  for(const edge of refined.elements.flatMap(e=>e.edges).filter(e=>e.curveId==='C1')){
    const contribution=context.distributedLoadContributionForElementEdge(edge,load,byId);
    assert.ok(contribution);
    for(const nodal of contribution.nodeLoads){force+=nodal.fy;moment+=byId.get(nodal.nodeId).x*nodal.fy;}
  }
  assert.ok(Math.abs(force+4)<1e-12);
  assert.ok(Math.abs(moment+7/3)<1e-12);
});

test("curved boundary chord midpoint retains its fixed support through classification", () => {
  const context = vm.createContext({ scene: { curves: [{ id: "C1", mechanicalState: "static" }] }, DEFAULT_CLASSIFICATION_TOLERANCE: 0.001 });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/core/analysis-classification.js"), "utf8"), context);
  context.getGeometryStateAtPoint = () => ({ mechanicalState: "free", isStatic: false, isFree: true });
  const node = { x: 0.5, y: 0, placement: { sourceType: "adaptiveBoundary", curveId: "C1", curveT: 0.5 } };
  context.classifyAnalysisNode(node);
  assert.equal(node.mechanicalState, "static");
  assert.equal(node.geometrySourceId, "C1");
});

function beam(nx = 8, ny = 2) {
  const analysisNodes = [], elements = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) analysisNodes.push({ id: "A" + (analysisNodes.length + 1), x: 4 * i / nx, y: j / ny });
  const id = (i, j) => "A" + (j * (nx + 1) + i + 1);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    for (const ids of [[id(i, j), id(i + 1, j), id(i + 1, j + 1)], [id(i, j), id(i + 1, j + 1), id(i, j + 1)]]) elements.push({ id: "E" + (elements.length + 1), nodeIds: ids });
  }
  return { analysisNodes, elements };
}

function solveBeam(mesh) {
  const numbers = new Map(mesh.analysisNodes.map((n, i) => [n.id, i + 1]));
  const properties = { elasticModulus: 1000, poissonRatio: 0.3, density: 0 };
  const payload = { elements: mesh.elements.map((e, i) => {
    const p = e.nodeIds.map((id) => mesh.analysisNodes[numbers.get(id) - 1]);
    const area = Math.abs((p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y)) / 2;
    return { ...e, number: i + 1, area, materialId: "M1", region: { id: "R1" }, mechanicalProperties: properties };
  }) };
  const model = { modelName: "AMR beam", materials: [{ ...properties, materialNo: 1 }], nodes: mesh.analysisNodes.map((n, i) => ({ nodeNo: i + 1, ...n, fixUx: n.x === 0, fixUy: n.x === 0, dofUx: 2 * i + 1, dofUy: 2 * i + 2, forceX: 0, forceY: n.x === 4 && n.y === 1 ? -1 : 0, materialNo: 1, regionNo: 1 })), elements: payload.elements.map((e) => ({ ...properties, elementNo: e.number, node1: numbers.get(e.nodeIds[0]), node2: numbers.get(e.nodeIds[1]), node3: numbers.get(e.nodeIds[2]), nodeNumbers: e.nodeIds.map((id) => numbers.get(id)), area: e.area, centroidX: 0, centroidY: 0, materialNo: 1 })), elementNodeLoads: [], counts: { nodes: mesh.analysisNodes.length, elements: mesh.elements.length, materials: 1 } };
  const executable = path.join(ROOT, "TensoraCore/x64/Release/TensoraCore.exe");
  const run = spawnSync(executable, ["--binary-ipc"], { input: encodeCalculationModelBinary(model), maxBuffer: 32 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr?.toString() || run.error?.message);
  const result = decodeCalculationResultBinary(run.stdout);
  payload.nodes = model.nodes;
  payload.counts = model.counts;
  return { payload, model, result, estimate: estimateZZError(payload, result), tip: result.nodeDisplacements.find((n) => n.nodeNo === numbers.get(mesh.analysisNodes.find((n) => n.x === 4 && n.y === 1).id)).uy };
}

test("native C++ cantilever solves successive local meshes with decreasing ZZ error", (t) => {
  let mesh = beam();
  const first = solveBeam(mesh);
  let solved = first;
  for (let iteration = 0; iteration < 3; iteration++) {
    const marked = new Set(solved.estimate.indicators.filter((e) => e.value > 0.7 * solved.estimate.maxError).map((e) => e.id));
    mesh = refineAdaptiveTriangles(mesh.analysisNodes, mesh.elements, marked, 10000);
    solved = solveBeam(mesh);
  }
  assert.ok(mesh.elements.length > 32);
  assert.ok(solved.estimate.relativeError < first.estimate.relativeError);
  assert.ok(Math.abs(solved.tip) > Math.abs(first.tip));
  t.diagnostic(`ZZ relative error: ${(100 * first.estimate.relativeError).toFixed(2)}% -> ${(100 * solved.estimate.relativeError).toFixed(2)}%; elements: 32 -> ${mesh.elements.length}`);
});

function workflowHarness(failAt = -1) {
  const mesh = beam();
  const scene = { ...mesh, mesh: { elements: mesh.elements, metadata: { version: 7, counts: {} } }, analysisNodePlacement: {}, geometryNodes: [], curves: [], regions: [], pointLoads: [], distributedLoads: [], bodyLoads: [] };
  let solves = 0;
  const context = vm.createContext({ scene, structuredClone, console, document: { getElementById: () => null }, generateCalculationTextFiles: { checked: false }, calculationStatuses: {}, calculationRunStatusMessage: "", module: { exports: {} } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/core/calculation-export.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/core/adaptive-mesh.js"), "utf8"), context);
  const ensureMesh = context.ensureCalculationMeshReadyForExport;
  Object.assign(context, {
    initializeTriangleWasm: async () => null,
    refineAdaptiveWithTriangle: (_api, nodes, elements, marked) => refineAdaptiveTriangles(nodes, elements, marked),
    ensureCalculationMeshReadyForExport: async () => {
      if (!scene.mesh.elements.length) {
        const seed = beam();
        scene.analysisNodes = seed.analysisNodes;
        scene.mesh = { elements: seed.elements, metadata: { version: 7, counts: {} } };
      }
    }, syncRegionMaterialSnapshots: () => {},
    updateCalculationPanel: () => {}, updateCalculationRunStatus: () => {}, renderCalculationView: () => {},
    readAnalysisNodeLimit: () => 10000, buildRegionElementSets: () => [],
    buildCalculationInputExport: () => solveBeam({ analysisNodes: scene.analysisNodes, elements: scene.mesh.elements }).payload,
    calculationInputPayloadToDirectModel: (payload) => payload,
    runCalculationCoreDirect: async () => {
      if (solves++ === failAt) return { ok: false, error: "deliberate solver failure" };
      return { ok: true, resultData: solveBeam({ analysisNodes: scene.analysisNodes, elements: scene.mesh.elements }).result };
    },
    loadCalculationResultsFromData: () => true,
    setAnalysisMesh: (data) => {
      scene.analysisNodes = structuredClone(data.analysisNodes);
      scene.mesh = { elements: structuredClone(data.elements), metadata: structuredClone(data.meshMetadata) };
    },
  });
  return { context, scene, ensureMesh, solves: () => solves };
}

test('adaptive safety budget is independent of the ordinary limit and preserves a solved final mesh',async()=>{
  const h=workflowHarness();
  const r=await h.context.startCalculationWorkflow({adaptive:true,maxIterations:20,relativeTolerance:.001,maxNodes:1,maxAdaptiveNodes:100});
  assert.equal(r.adaptive.history.at(-1).stopReason,'node-budget');
  assert.ok(h.scene.analysisNodes.length<=100);
  assert.equal(r.adaptive.config.maxAdaptiveNodes,100);
  assert.equal(r.runResult.resultData.elementResults.length,h.scene.mesh.elements.length);
  assert.ok(r.adaptive.history.every(s=>s.nodes<=100));
});

test('hotspot rescue is capped and survives a subsequent manual refinement',async()=>{
  const h=workflowHarness(),mark=h.context.markAdaptiveHotspots;
  h.context.markAdaptiveHotspots=(p,e,policy,level)=>({...mark(p,e,policy,level),ordinaryFrozenErrorFraction:level<3?.9:0});
  const r=await h.context.startCalculationWorkflow({adaptive:true,maxIterations:4,relativeTolerance:.001});
  assert.equal(r.adaptive.config.refinementState.rescueLevel,3);
  assert.equal(r.adaptive.history.filter(s=>s.hotspotRescue).length,3);
  const next=await h.context.startCalculationWorkflow({adaptive:true,refineOnce:true,relativeTolerance:.001});
  assert.equal(next.adaptive.config.refinementState.rescueLevel,3);
  assert.equal(next.adaptive.history.some(s=>s.hotspotRescue),false);
});

test('a singularity plateau stops automatic iteration well before the configured maximum',async()=>{
  const h=workflowHarness(),estimate=h.context.estimateZZError,mark=h.context.markAdaptiveHotspots;
  h.context.estimateZZError=(...args)=>({...estimate(...args),relativeError:.2});
  h.context.markAdaptiveHotspots=(...args)=>({...mark(...args),ordinaryFrozenErrorFraction:0,pointFrozenErrorFraction:.9});
  const r=await h.context.startCalculationWorkflow({adaptive:true,maxIterations:100,relativeTolerance:.01});
  assert.equal(r.adaptive.history.at(-1).stopReason,'singularity-limit');
  assert.equal(h.solves(),4);
  assert.equal(r.runResult.resultData.elementResults.length,h.scene.mesh.elements.length);
});

test('refinement errors retain the successful reference and leave the workflow usable',async()=>{
  const h=workflowHarness();
  h.context.refineAdaptiveSafely=async()=>{throw new Error('invalid candidate mesh');};
  const r=await h.context.startCalculationWorkflow({adaptive:true,maxIterations:4,relativeTolerance:.001});
  assert.equal(r.adaptive.history.at(-1).stopReason,'refinement-failure');
  assert.equal(r.adaptive.history.at(-1).refinementError,'invalid candidate mesh');
  assert.equal(h.scene.mesh.elements.length,32);
  assert.equal(r.runResult.resultData.elementResults.length,32);
  assert.equal((await h.context.startCalculationWorkflow({adaptive:false})).runResult.ok,true);
});

test('refinement shares the remaining round time with its native solve',async()=>{
  const h=workflowHarness(),solve=h.context.runCalculationCoreDirect,refine=h.context.refineAdaptiveSafely;
  let elapsed=0,budget;
  h.context.performance={now:()=>elapsed};
  h.context.runCalculationCoreDirect=async(...args)=>{const r=await solve(...args);elapsed+=4500;return r;};
  h.context.refineAdaptiveSafely=async(api,n,e,m,time,options)=>{budget=time;return refine(api,n,e,m,time,options);};
  await h.context.startCalculationWorkflow({adaptive:true,maxIterations:1,relativeTolerance:.001,timeLimitSeconds:10});
  assert.equal(budget,5500);
});

test("adaptive rounds preserve the GPU choice captured at workflow start", async () => {
  const harness = workflowHarness();
  const checkbox = { checked: true };
  harness.context.document.getElementById = id => id === "useGpuAcceleration" ? checkbox : null;
  const originalRun = harness.context.runCalculationCoreDirect;
  const choices = [];
  harness.context.runCalculationCoreDirect = async (model, options) => {
    choices.push(options.useGpuAcceleration);
    checkbox.checked = false;
    return originalRun(model, options);
  };
  const options = { adaptive: true, maxIterations: 2, relativeTolerance: 0.001 };
  await harness.context.startCalculationWorkflow(options);
  assert.deepEqual(choices, [true, true, true]);
  assert.equal(options.useGpuAcceleration, undefined);
});

test("public workflow solves the final refined mesh and records a bounded history", async () => {
  const harness = workflowHarness();
  const result = await harness.context.startCalculationWorkflow({ adaptive: true, maxIterations: 3, relativeTolerance: 0.001, maxNodes: 10000 });
  assert.equal(harness.solves(), 4);
  assert.equal(result.adaptive.history.length, 4);
  assert.equal(result.adaptive.history.at(-1).stopReason, "iteration-limit");
  assert.equal(result.runResult.resultData.elementResults.length, harness.scene.mesh.elements.length);
  assert.ok(harness.scene.mesh.metadata.adaptive);
});

test("a successful round reaching ten seconds keeps its result without further refinement", async () => {
  const harness = workflowHarness();
  let elapsed = 0, refinements = 0;
  harness.context.performance = { now: () => elapsed };
  const solve = harness.context.runCalculationCoreDirect;
  harness.context.runCalculationCoreDirect = async (...args) => {
    assert.equal(args[1].adaptive, true);
    const result = await solve(...args);
    elapsed += 10000;
    return result;
  };
  harness.context.refineAdaptiveWithTriangle = () => { refinements++; };
  const result = await harness.context.startCalculationWorkflow({ adaptive: true, maxIterations: 6, relativeTolerance: 0.001 });
  assert.equal(harness.solves(), 1);
  assert.equal(refinements, 0);
  assert.equal(result.adaptive.history[0].stopReason, "time-limit");
  assert.equal(result.adaptive.history[0].durationMs, 10000);
  assert.equal(result.runResult.resultData.elementResults.length, harness.scene.mesh.elements.length);
});

test("custom time limits govern each round and reach the solver", async () => {
  for (const [seconds, expectedSolves, reason] of [[5, 1, "time-limit"], [20, 3, "iteration-limit"]]) {
    const harness = workflowHarness();
    let elapsed = 0;
    harness.context.performance = { now: () => elapsed };
    const solve = harness.context.runCalculationCoreDirect;
    harness.context.runCalculationCoreDirect = async (model, options) => {
      assert.equal(options.timeLimitMs, seconds * 1000);
      const result = await solve(model, options);
      elapsed += 10000;
      return result;
    };
    const result = await harness.context.startCalculationWorkflow({adaptive: true, maxIterations: 2, relativeTolerance: 0.001, timeLimitSeconds: seconds});
    assert.equal(harness.solves(), expectedSolves);
    assert.equal(result.adaptive.config.timeLimitMs, seconds * 1000);
    assert.equal(result.adaptive.history.at(-1).stopReason, reason);
    if (reason === "time-limit") assert.match(harness.context.calculationRunStatusMessage, /达到 5 秒耗时保护/);
  }
});

test("native timeout restores the previous successful mesh and releases the workflow lock", async () => {
  const harness = workflowHarness();
  let requests = 0;
  const solve = harness.context.runCalculationCoreDirect;
  harness.context.runCalculationCoreDirect = async (...args) => ++requests === 2 ? { ok: false, timedOut: true } : solve(...args);
  const result = await harness.context.startCalculationWorkflow({ adaptive: true, maxIterations: 6, relativeTolerance: 0.001 });
  assert.equal(result.adaptive.history.length, 1);
  assert.equal(result.adaptive.history[0].stopReason, "time-limit");
  assert.ok(result.adaptive.history[0].timedOutAttempt.elements > 32);
  assert.equal(harness.scene.mesh.elements.length, 32);
  assert.equal(result.runResult.ok, true);
  assert.equal((await harness.context.startCalculationWorkflow({ adaptive: false })).runResult.ok, true);
});

test("first-round native timeout reports an actionable error and does not refine", async () => {
  const harness = workflowHarness();
  harness.context.runCalculationCoreDirect = async () => ({ ok: false, timedOut: true });
  await assert.rejects(harness.context.startCalculationWorkflow({ adaptive: true }), /首轮求解超过 10 秒/);
  assert.equal(harness.scene.mesh.elements.length, 32);
});

test("slow refinement discards its candidate and preserves the current solved mesh", async () => {
  const harness = workflowHarness();
  let elapsed = 0;
  harness.context.performance = { now: () => elapsed };
  const refine = harness.context.refineAdaptiveWithTriangle;
  harness.context.refineAdaptiveWithTriangle = (...args) => {
    const result = refine(...args);
    elapsed += 10001;
    return result;
  };
  const result = await harness.context.startCalculationWorkflow({ adaptive: true, maxIterations: 6, relativeTolerance: 0.001 });
  assert.equal(result.adaptive.history[0].stopReason, "time-limit");
  assert.equal(harness.scene.mesh.elements.length, 32);
  assert.equal(harness.solves(), 1);
});

test("a timed-out refinement worker is terminated and leaves the solved mesh intact", async () => {
  const harness = workflowHarness();
  let timer, terminated = 0;
  harness.context.setTimeout = (callback, delay) => { assert.ok(delay>0&&delay<=10000); timer = callback; return 1; };
  harness.context.clearTimeout = () => {};
  harness.context.Worker = class {
    postMessage() { timer(); }
    terminate() { terminated++; }
  };
  const result = await harness.context.startCalculationWorkflow({ adaptive: true, refineOnce: true, relativeTolerance: 0.001 });
  assert.equal(terminated, 1);
  assert.equal(result.adaptive.history[0].refinementTimedOut, true);
  assert.equal(result.adaptive.history[0].stopReason, "time-limit");
  assert.equal(harness.scene.mesh.elements.length, 32);
  assert.equal(harness.solves(), 1);
});

test("custom time limit applies to refine-once workers and first-round errors", async () => {
  const harness = workflowHarness();
  let timer, terminated = 0;
  harness.context.setTimeout = (callback, delay) => { assert.ok(delay>0&&delay<=25000); timer = callback; return 1; };
  harness.context.clearTimeout = () => {};
  harness.context.Worker = class {
    postMessage() { timer(); }
    terminate() { terminated++; }
  };
  const result = await harness.context.startCalculationWorkflow({adaptive: true, refineOnce: true, relativeTolerance: 0.001, timeLimitSeconds: 25});
  assert.equal(terminated, 1);
  assert.equal(result.adaptive.history[0].refinementTimedOut, true);
  harness.context.runCalculationCoreDirect = async () => ({ok: false, timedOut: true});
  await assert.rejects(harness.context.startCalculationWorkflow({adaptive: true, timeLimitSeconds: 25}), /首轮求解超过 25 秒/);
});

test("automatic adaptation clears the current mesh before rebuilding its seed", async () => {
  const harness = workflowHarness();
  const ensure = harness.context.ensureCalculationMeshReadyForExport;
  let seeds = 0;
  harness.context.ensureCalculationMeshReadyForExport = async (options) => {
    if (!harness.scene.mesh.elements.length) {
      assert.equal(harness.scene.analysisNodes.length, 0);
      assert.deepEqual(Object.keys(harness.scene.analysisNodePlacement || {}), []);
      seeds++;
    }
    return ensure(options);
  };
  for (let i = 0; i < 2; i++) {
    const result = await harness.context.startCalculationWorkflow({ adaptive: true, maxIterations: 1, relativeTolerance: 0.001 });
    assert.equal(result.adaptive.history[0].elements, 32);
  }
  assert.equal(seeds, 2);
});

test("single-step refinement continues from the current mesh even below the error target", async () => {
  const harness = workflowHarness();
  for (let i = 0; i < 2; i++) {
    const nodes = structuredClone(harness.scene.analysisNodes);
    const elements = harness.scene.mesh.elements.length;
    const result = await harness.context.startCalculationWorkflow({ adaptive: true, refineOnce: true, maxIterations: 12, relativeTolerance: 0.99 });
    assert.equal(result.adaptive.config.maxIterations, 1);
    assert.equal(result.adaptive.history.length, 2);
    assert.equal(result.adaptive.history[0].elements, elements);
    assert.ok(harness.scene.mesh.elements.length > elements);
    for (const node of nodes) {
      const retained = harness.scene.analysisNodes.find(n => n.id === node.id);
      assert.equal(retained.x, node.x);
      assert.equal(retained.y, node.y);
    }
    assert.equal(result.runResult.resultData.elementResults.length, harness.scene.mesh.elements.length);
  }
  assert.equal(harness.solves(), 4);
});

test("enabling adaptation clears nodes and elements before placing the fresh nodes", () => {
  const harness = workflowHarness();
  const alerts = [];
  harness.context.alert = message => alerts.push(message);
  const checkbox = { checked: true }, limit = { disabled: false };
  harness.context.document.getElementById = id => id === "adaptiveMeshEnabled" ? checkbox : id === "maxAnalysisNodes" ? limit : null;
  let placements = 0;
  harness.context.autoPlaceAnalysisNodes = options => {
    assert.equal(options.adaptive, true);
    assert.equal(harness.scene.analysisNodes.length, 0);
    assert.equal(harness.scene.mesh.elements.length, 0);
    placements++;
  };
  harness.context.onAdaptiveMeshChange({ target: checkbox });
  assert.equal(limit.disabled, true);
  assert.equal(placements, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /裂纹与应力集中/);
  assert.match(alerts[0], /不建议使用/);
  checkbox.checked = false;
  harness.context.onAdaptiveMeshChange({ target: checkbox });
  assert.equal(placements, 1);
  assert.equal(limit.disabled, false);
  assert.equal(alerts.length, 1);
});

test("single-step refinement requires a current mesh and does not regenerate a missing mesh", async () => {
  const harness = workflowHarness();
  harness.context.ANALYSIS_MESH_VERSION = 7;
  harness.context.ANALYSIS_NODE_PLACEMENT_VERSION = 2;
  harness.scene.analysisNodePlacement.version = 2;
  harness.scene.mesh.elements = [];
  harness.context.autoGenerateAnalysisMesh = () => { throw new Error("must not regenerate"); };
  await assert.rejects(harness.ensureMesh({ adaptive: true, refineOnce: true }), /请先生成有效网格/);
});

test("single-step refinement restores the existing solved mesh if the refined solve fails", async () => {
  const harness = workflowHarness(1);
  const nodes = structuredClone(harness.scene.analysisNodes);
  await assert.rejects(harness.context.startCalculationWorkflow({ adaptive: true, refineOnce: true }), /deliberate solver failure/);
  assert.equal(harness.scene.mesh.elements.length, 32);
  assert.equal(harness.scene.analysisNodes.length, nodes.length);
  assert.equal(harness.solves(), 2);
});

test("failed refined solve restores the last solved mesh and releases the workflow lock", async () => {
  const harness = workflowHarness(1);
  await assert.rejects(harness.context.startCalculationWorkflow({ adaptive: true, maxIterations: 3, relativeTolerance: 0.001, maxNodes: 10000 }), /deliberate solver failure/);
  assert.equal(harness.scene.mesh.elements.length, 32);
  const result = await harness.context.startCalculationWorkflow({ adaptive: false });
  assert.equal(result.runResult.ok, true);
});

test("workflow stops at target or iteration count and ignores a small node limit", async () => {
  const target = workflowHarness();
  const success = await target.context.startCalculationWorkflow({ adaptive: true, maxIterations: 3, relativeTolerance: 0.9, maxNodes: 10000 });
  assert.equal(target.solves(), 1);
  assert.equal(success.adaptive.history.at(-1).stopReason, "target-error");
  const budget = workflowHarness();
  const limited = await budget.context.startCalculationWorkflow({ adaptive: true, maxIterations: 3, relativeTolerance: 0.001, maxNodes: 28 });
  assert.equal(limited.adaptive.history.at(-1).stopReason, "iteration-limit");
  assert.ok(budget.scene.analysisNodes.length > 28);
  assert.ok(budget.scene.mesh.elements.length > 32);
  assert.equal(budget.solves(), 4);
  assert.equal("maxNodes" in limited.adaptive.config, false);
});

test("adaptive initial placement ignores both UI and API node limits while ordinary placement retains them", () => {
  const checkbox = { checked: true }, limit = { disabled: false };
  const context = vm.createContext({ document: { getElementById: (id) => id === "adaptiveMeshEnabled" ? checkbox : id === "maxAnalysisNodes" ? limit : null }, module: { exports: {} } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/core/analysis-node-placement.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/core/adaptive-mesh.js"), "utf8"), context);
  context.readAnalysisNodeLimit = () => { throw new Error("adaptive mode must not read the node limit"); };
  const low = context.resolveAnalysisNodePlacementOptions({ maxNodes: 1, spacing: 0.00001 });
  const high = context.resolveAnalysisNodePlacementOptions({ maxNodes: 1000000 });
  assert.equal(low.maxNodes, high.maxNodes);
  assert.equal(low.maxNodes, 1000);
  assert.equal(low.spacing, undefined);
  context.syncAdaptiveMeshControls();
  assert.equal(limit.disabled, true);
  checkbox.checked = false;
  context.readAnalysisNodeLimit = () => 2000;
  assert.equal(context.resolveAnalysisNodePlacementOptions().maxNodes, 2000);
  assert.equal(context.resolveAnalysisNodePlacementOptions({ maxNodes: 400 }).maxNodes, 400);
  context.syncAdaptiveMeshControls();
  assert.equal(limit.disabled, false);
});

test("mesh readiness preserves compatible meshes between rounds and regenerates legacy meshes", async () => {
  const harness = workflowHarness();
  harness.context.ANALYSIS_MESH_VERSION = 7;
  harness.context.ANALYSIS_NODE_PLACEMENT_VERSION = 2;
  harness.scene.analysisNodePlacement.version = 2;
  let generations = 0;
  harness.context.readAnalysisNodeLimit = () => { throw new Error("node limit must be ignored"); };
  harness.context.autoGenerateAnalysisMesh = async (options) => {
    generations++;
    assert.equal(options.adaptive, true);
    assert.equal(options.maxNodes, undefined);
    assert.equal(options.regenerateNodes, true);
    harness.scene.mesh.metadata.adaptiveInitialMesh = true;
    harness.scene.mesh.metadata.adaptive = null;
  };
  await harness.ensureMesh({ adaptive: true, maxNodes: 1000000 });
  await harness.ensureMesh({ adaptive: true, maxNodes: 1 });
  assert.equal(generations, 0);
  harness.scene.mesh.metadata.adaptive = {config:{connectionVersion:5,refinementPolicy:{baseArea:1}}};
  await harness.ensureMesh({adaptive:true});
  assert.equal(generations,0,'current hotspot-policy meshes remain compatible');
  harness.scene.mesh.metadata.adaptive.config.connectionVersion=4;
  await harness.ensureMesh({adaptive:true});
  assert.equal(generations,1,'previous interactive policies are reseeded');
  // Models saved by the former capped implementation must also be reseeded.
  harness.scene.mesh.metadata.adaptive = { config: { maxNodes: 1000000 } };
  await harness.ensureMesh({ adaptive: true });
  assert.equal(generations, 2);
});

test("model edits during a solve reject stale results and preserve the user's edit", async () => {
  const harness = workflowHarness();
  const originalRun = harness.context.runCalculationCoreDirect;
  let applied = 0;
  harness.context.loadCalculationResultsFromData = () => { applied++; return true; };
  harness.context.runCalculationCoreDirect = async () => {
    const result = await originalRun();
    harness.scene.geometryNodes.push({ id: "N-new", x: 1, y: 1 });
    return result;
  };
  await assert.rejects(harness.context.startCalculationWorkflow({ adaptive: true, maxIterations: 3, relativeTolerance: 0.001, maxNodes: 10000 }), /模型/);
  assert.equal(applied, 0);
  assert.equal(harness.scene.geometryNodes[0].id, "N-new");
});
