const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const cavity = require("../src/core/blast-cavity");
const {refineAdaptiveTriangles} = require("../src/core/adaptive-mesh");
const {runBlastCore} = require("../server");
const {blastRing} = require("./helpers/blast-ring");
const BlastSettings = require("../blast-settings");
const dynamics = fs.readFileSync(require.resolve("../src/core/blast-dynamics.js"), "utf8");

function scaledRing(scale = 1, x = 0, y = 0) {
  const model = blastRing({sectors:48, rings:6, outer:.5});
  for (const node of model.nodes) {node.x = x + node.x * scale; node.y = y + node.y * scale;}
  for (const element of model.elements) {element.area *= scale * scale; element.centroidX = x + element.centroidX * scale; element.centroidY = y + element.centroidY * scale;}
  return model;
}
function browser(model, radius = .5) {
  const controls = new Map();
  const element = id => {
    if (!controls.has(id)) controls.set(id, {value:"", textContent:"", disabled:false, hidden:true, checked:false,
      children:[], append(child) {this.children.push(child);}, replaceChildren() {this.children=[];},
      removeAttribute(name) {delete this[name];},
    });
    return controls.get(id);
  };
  const api = vm.createContext({BlastCavity:cavity, BlastSettings, BlastMaterials:require('../blast-materials'), BlastFracture:require('../blast-fracture'), AbortController, console,
    ANALYSIS_MESH_VERSION:7, ANALYSIS_NODE_PLACEMENT_VERSION:2, calculationWorkflowRunning:false,
    scene:{mesh:{elements:model.elements, metadata:{version:7}},analysisNodes:model.nodes,analysisNodePlacement:{version:2},blastSettings:{}},
    document:{getElementById:element,createElement:()=>({})}, render() {},
    buildCalculationInputExport:()=>model, calculationInputPayloadToDirectModel:input=>input,
    ensureCalculationMeshReadyForExport:async()=>{},
  });
  vm.runInContext(dynamics, api);
  vm.runInContext(fs.readFileSync(require.resolve('../src/core/blast-fracture-ui.js'),'utf8'),api);
  vm.runInContext(`for(const [key,[id,scale]] of Object.entries(BLAST_FIELDS)) document.getElementById(id).value=String(BlastSettings.defaults[key]/scale);`, api);
  element("blastRadius").value=String(radius);
  return {api, element};
}

test("detecting the real wall preserves the smaller charge and the original mesh", () => {
  const model = scaledRing(10), original = JSON.stringify(model), h = browser(model);
  assert.throws(() => h.api.validateBlastCavity(model, {x:0,y:0,radius:.5}), /当前参数：x = 0, y = 0, r = 0.5 m[\s\S]*最近圆孔：x = 0, y = 0, r = 1 m/);
  h.api.identifyBlastCavity();
  assert.equal(h.element("blastRadius").value, "0.5");
  assert.ok(Math.abs(Number(h.element("blastCavityRadius").value)-1)<1e-12);
  assert.equal(h.element("blastX").value, "0");
  assert.equal(h.api.validateBlastCavity(model, h.api.readBlastControls()).match.edgeCount, 48);
  assert.equal(JSON.stringify(model), original);
});

test("air-gap charge reaches the actual cavity wall with confinement on the original mesh", async () => {
  const model = scaledRing(10), h = browser(model);
  h.api.identifyBlastCavity();
  const history = await runBlastCore(model, {...h.api.readBlastControls(), fracture:false, frames:3, pulse:.0001, duration:.0002, confineX:1e5, confineY:1e5});
  assert.equal(history.loadedEdges, 48);
  assert.equal(history.frames[0].u.length, model.nodes.length * 2);
  assert.ok(history.preloadEnergy > 0);
  assert.ok(history.frames.at(-1).u.some(value => Math.abs(value) > 0));
});

test("detection excludes outer boundaries, filled domains and noncircular holes", () => {
  const model = scaledRing();
  assert.equal(cavity.analyze(model).cavities.length, 1);
  assert.equal(cavity.analyze(model,{x:0,y:0,radius:.5}).match, null, "the circular outer boundary is not a cavity");
  const filled = {nodes:[{nodeNo:1,x:0,y:0},{nodeNo:2,x:1,y:0},{nodeNo:3,x:0,y:1}],elements:[{node1:1,node2:2,node3:3}]};
  assert.equal(cavity.analyze(filled).holeCount, 0);
  for (const node of model.nodes) node.x *= 2;
  assert.equal(cavity.analyze(model).cavities.length, 0);
});

test("circle fitting handles translated models and reversed triangle orientation", () => {
  const model = scaledRing(10, 1e8, -1e8);
  model.elements.forEach(element => {element.nodeNumbers.reverse();});
  const inspection = cavity.analyze(model,{x:1e8,y:-1e8,radius:1});
  assert.equal(inspection.match.edgeCount, 48);
  assert.ok(Math.abs(inspection.cavities[0].radius - 1) < 1e-7);
});

test("multiple cavities require a choice and never overwrite the blast location automatically", () => {
  const left = scaledRing(1,-1), right = scaledRing(1,1), offset=left.nodes.length;
  for (const node of right.nodes) node.nodeNo += offset;
  for (const element of right.elements) {element.nodeNumbers=element.nodeNumbers.map(id=>id+offset); element.node1+=offset;element.node2+=offset;element.node3+=offset;}
  const model={nodes:[...left.nodes,...right.nodes],elements:[...left.elements,...right.elements]};
  assert.equal(cavity.analyze(model).cavities.length, 2);
  const h=browser(model,.5);h.api.identifyBlastCavity();
  assert.equal(h.element("blastRadius").value, "0.5");
  assert.equal(h.element("blastX").value, "0");
  assert.equal(h.element("blastCavityChoice").hidden, false);
  assert.match(h.element("blastCavityStatus").textContent, /多个圆孔/);
});

test("a conforming adaptive mesh retains a closed cavity and runs directly in the native solver", async () => {
  const model=scaledRing(), props=model.elements[0];
  const nodes=model.nodes.map(node=>({...node,id:"A"+node.nodeNo}));
  const elements=model.elements.map((element,i)=>({...element,id:"E"+(i+1),nodeIds:element.nodeNumbers.map(n=>"A"+n),regionId:"R1"}));
  const refined=refineAdaptiveTriangles(nodes,elements,new Set(elements.slice(0,15).map(element=>element.id)));
  const byId=new Map(refined.analysisNodes.map((node,i)=>[node.id,i+1]));
  const direct={...model,nodes:refined.analysisNodes.map((node,i)=>({...node,nodeNo:i+1,dofUx:2*i+1,dofUy:2*i+2,materialNo:1,regionNo:1})),
    elements:refined.elements.map((element,i)=>{
      const ids=element.nodeIds.map(id=>byId.get(id));
      return {...props,elementNo:i+1,area:element.area,node1:ids[0],node2:ids[1],node3:ids[2],nodeNumbers:ids};
    })};
  assert.ok(direct.nodes.length>model.nodes.length);
  const inspection=cavity.analyze(direct,{x:0,y:0,radius:.1});
  assert.ok(inspection.match.edgeCount>48);
  const history=await runBlastCore(direct,{fracture:false,frames:3,pulse:.00002,duration:.00005});
  assert.equal(history.loadedEdges,inspection.match.edgeCount);
  assert.equal(history.frames.at(-1).u.length,direct.nodes.length*2);
});

test("blast mesh preparation reuses ordinary and adaptive meshes even when static adaptive mode is selected", async () => {
  for (const adaptive of [null,{config:{maxNodes:100,connectionVersion:3}}]) {
    let regenerations=0;
    const scene={analysisNodes:[{id:"A1"}],analysisNodePlacement:{version:2},mesh:{elements:[{id:"E1"}],metadata:{version:7,adaptive}}};
    const nodes=scene.analysisNodes, elements=scene.mesh.elements;
    const api=vm.createContext({scene,ANALYSIS_MESH_VERSION:7,ANALYSIS_NODE_PLACEMENT_VERSION:2,
      document:{getElementById:()=>({checked:true})},autoGenerateAnalysisMesh:async()=>{regenerations++;}});
    vm.runInContext(fs.readFileSync(require.resolve("../src/core/calculation-export.js"),"utf8"),api);
    await api.ensureCalculationMeshReadyForExport({adaptive:false});
    assert.equal(regenerations,0);assert.equal(scene.analysisNodes,nodes);assert.equal(scene.mesh.elements,elements);
  }
});

test("a charge larger than the actual hole is rejected before HTTP and the workflow lock is released", async () => {
  const h=browser(scaledRing(10),2);let calls=0;
  h.api.fetch=async()=>{calls++;throw new Error("Unexpected native request");};
  await assert.rejects(h.api.startBlastWorkflow(),/装药半径大于实际炮孔半径/);
  assert.equal(calls,0);assert.equal(h.api.calculationWorkflowRunning,false);
  assert.equal(h.element("startBlast").disabled,false);assert.equal(h.element("cancelBlast").disabled,true);
});

test("running resolves the actual wall automatically and transmits independent charge geometry", async () => {
  const h=browser(scaledRing(10),.5);let sent;
  h.api.fetch=async(url,request)=>{sent=JSON.parse(request.body);throw new Error("test transport stopped");};
  await assert.rejects(h.api.startBlastWorkflow(),/test transport stopped/);
  assert.ok(Math.abs(sent.settings.radius-1)<1e-12);
  assert.equal(sent.settings.chargeRadius,.5);
  assert.equal(sent.settings.pressure,BlastSettings.defaults.pressure);
  assert.equal(h.element("blastRadius").value,"0.5");
  assert.equal(sent.model.nodes.length,scaledRing(10).nodes.length);
});

test("prescribed wall pressure gives identical rock response for coupled and air-gap charge geometry", async () => {
  const model=scaledRing(10), settings={radius:1,fracture:false,frames:3,pulse:.0001,duration:.0002};
  const coupled=await runBlastCore(model,{...settings,chargeRadius:1});
  const gap=await runBlastCore(model,{...settings,chargeRadius:.5});
  assert.deepEqual(gap.frames.at(-1).u,coupled.frames.at(-1).u);
  assert.equal(gap.settings.chargeRadius,.5);
  await assert.rejects(runBlastCore(model,{...settings,chargeRadius:2}),/Charge radius exceeds/);
  assert.equal(BlastSettings.normalize({radius:1}).chargeRadius,1,"legacy scenes remain coupled by default");
});
