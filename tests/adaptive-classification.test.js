const test = require("node:test");
const assert = require("node:assert/strict");
const { sceneWorkflowHarness } = require("./helpers/scene-workflow");

function boundaryHarness() {
  const { context, scene } = sceneWorkflowHarness({});
  const material = { id: "M1", name: "Solid", elasticModulus: 200, poissonRatio: 0.26 };
  scene.regions = [
    { id: "R1", regionKind: "structure", area: 9, polygon: [{ x: -1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 2 }, { x: -1, y: 2 }], material },
    { id: "R2", regionKind: "air", area: 0.5, polygon: [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }] },
  ];
  context.setAnalysisMesh({
    analysisNodes: [{ id: "A1", x: 0.4999, y: 0 }, { id: "A2", x: 0.5, y: 0 }, { id: "A3", x: 0.49999, y: 1 }],
    elements: [{ id: "E1", nodeIds: ["A1", "A2", "A3"], regionId: "R1", generation: { algorithm: "triangle-zz-hybrid-tri3" } }],
    meshMetadata: { stale: false },
  });
  return { context, scene };
}

test("constrained solid element retains its region and material inside a hole's centroid tolerance", () => {
  const { context, scene } = boundaryHarness();
  const element = scene.mesh.elements[0];
  assert.equal(context.getStructureRegionAtPoint(context.elementCentroid(element)).id, "R2");
  for (let i = 0; i < 3; i++) {
    context.classifyAnalysisElements();
    assert.equal(element.regionId, "R1");
    assert.equal(element.materialId, "M1");
    assert.equal(element.isAir, false);
    const payload = context.buildCalculationInputExport();
    assert.equal(payload.elements[0].mechanicalProperties.elasticModulus, 200e9);
    assert.doesNotThrow(() => context.validateAdaptiveElementData(payload));
  }
});

test("preserved mesh region still picks up material edits and respects stale geometry", () => {
  const { context, scene } = boundaryHarness();
  scene.regions[0].material.elasticModulus = 100;
  context.classifyAnalysisElements();
  assert.equal(scene.mesh.elements[0].materialProperties.elasticModulus, 100);
  scene.mesh.metadata.stale = true;
  context.classifyAnalysisElements();
  assert.equal(scene.mesh.elements[0].regionId, "R2");
  assert.equal(scene.mesh.elements[0].materialId, null);
});

test("adaptive input rejects missing material before invoking the native solver", async () => {
  const { context, scene } = boundaryHarness();
  scene.regions[0].material = null;
  scene.regions[0].materialId = null;
  scene.regions[0].materialProperties = null;
  context.ensureCalculationMeshReadyForExport = async () => {};
  context.runCalculationCoreDirect = () => { throw new Error("solver must not run"); };
  await assert.rejects(context.startSingleCalculationWorkflow({ adaptive: true }), /单元 E1（区域 R1）/);
});

test("ZZ reports the affected element when its stress result is invalid", () => {
  const { context } = boundaryHarness();
  const payload = context.buildCalculationInputExport();
  assert.throws(() => context.estimateZZError(payload, { elementResults: [] }), /单元 E1 的应力结果缺失或无效/);
});

test('batched node classification matches individual curve distances and refreshes after geometry edits',()=>{
  const {context:c,scene}=sceneWorkflowHarness(require('../examples/blast-cavity.json'));
  scene.curves[0].mechanicalState='static';
  const nodes=[{id:'A0',x:-.5,y:-1},...Array.from({length:100},(_,i)=>({id:'A'+(i+1),x:-1+(i%10)*.2,y:-1+Math.floor(i/10)*.2})),
    ...c.sampleCurve(scene.curves[4],96).map((p,i)=>({...p,id:'B'+i}))];
  const check=()=>{
    const individual=structuredClone(nodes),batch=structuredClone(nodes);
    for(const n of individual)c.classifyAnalysisNode(n);
    c.classifyAnalysisNodeBatch(batch);
    assert.equal(JSON.stringify(batch),JSON.stringify(individual));
    return batch;
  };
  assert.equal(check()[0].mechanicalState,'static');
  scene.geometryNodes[0].y=-2;
  assert.equal(check()[0].mechanicalState,'free');
});
