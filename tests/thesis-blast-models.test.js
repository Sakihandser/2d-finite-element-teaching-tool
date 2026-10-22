const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const Thesis=require("../scripts/thesis-blast-geometry.cjs"),library=require("../explosives/library.json"),Cavity=require("../src/core/blast-cavity");
const {sceneWorkflowHarness}=require("./helpers/scene-workflow");
const {runBlastCore}=require("../server"),{removeRun}=require("../blast-runner");
const root=path.resolve(__dirname,"..");
test("the sixteen thesis cases retain geometry, original elastic constants, initial equilibrium and separate explosive records",()=>{
  for(const code of Thesis.cases)for(let p=0;p<4;p++){
    const scene=Thesis.scene(code,p,library.explosives.find(e=>e.id==="petn-thesis-section43"));
    assert.equal(scene.curves.length,14);assert.equal(scene.blastSettings.radius,.008);assert.equal(scene.blastSettings.chargeRadius,.005);
    assert.equal(scene.blastSettings.confineX,Thesis.pressures[p][0]*1e6);assert.equal(scene.blastSettings.confineY,Thesis.pressures[p][1]*1e6);
    assert.equal(scene.blastSettings.fracture,true);assert.equal(scene.blastSettings.boundary,2);assert.equal(scene.blastSettings.loadMode,0);
    assert.equal(scene.blastSettings.productDensity,1320);
    for(const key of ["granite","sandstone"]){
      const m=Thesis.material(key),r=Thesis.reference[key];
      assert.ok(Math.abs(m.elasticModulus/(3*(1-2*m.poissonRatio))/r.K-1)<1e-12);
      assert.ok(Math.abs(m.elasticModulus/(2*(1+m.poissonRatio))/r.G-1)<1e-12);assert.equal(m.tensileStrength,key==="granite" ? 8 : 4);
    }
    const capCenter=scene.geometryNodes.slice(4,10).reduce((s,n)=>({x:s.x+n.x/6,y:s.y+n.y/6}),{x:0,y:0});
    assert.ok(Math.abs(Math.hypot(capCenter.x,capCenter.y)-(code.startsWith("H") ? .147 : 0))<1e-12);
  }
});
function load(code){
  const local=path.join(root,"models/thesis-4-3",code+".json");
  const file=fs.existsSync(local) ? local : path.join(root,"..",code+".json");
  const data=JSON.parse(fs.readFileSync(file,"utf8"));
  const h=sceneWorkflowHarness(data);return {h,data};
}
test("prepared meshes survive normal import with two conforming material regions and the real 8 mm cavity",()=>{
  for(const code of Thesis.cases){
    const {h,data}=load(code),scene=h.scene;
    assert.equal(scene.regions.filter(r=>r.isAir).length,1);assert.equal(scene.regions.filter(r=>r.isStructure).length,2);
    assert.equal(scene.mesh.metadata.stale,false);assert.equal(scene.mesh.metadata.coverage.passed,true);
    assert.equal(scene.mesh.elements.length,data.mesh.elements.length);
    const nodes=scene.analysisNodes.map((n,i)=>({nodeNo:i+1,x:n.x,y:n.y})),numbers=new Map(scene.analysisNodes.map((n,i)=>[n.id,i+1]));
    const elements=scene.mesh.elements.map(e=>({nodeNumbers:e.analysisNodeIds.map(id=>numbers.get(id))}));
    const cavity=Cavity.analyze({nodes,elements},{x:0,y:0,radius:.008});assert.ok(cavity.match.edgeCount>=12);
    const edgeMaterials=new Map();let shared=0;
    for(const e of scene.mesh.elements){
      assert.ok(e.materialId==="thesis43-granite" || e.materialId==="thesis43-sandstone");
      for(let j=0;j<3;j++){
        const key=[e.analysisNodeIds[j],e.analysisNodeIds[(j+1)%3]].sort().join(":");
        if(edgeMaterials.has(key) && edgeMaterials.get(key)!==e.materialId)shared++;else edgeMaterials.set(key,e.materialId);
      }
    }
    assert.ok(shared>=24,`${code}: shared conforming interface edges ${shared}`);
    assert.ok(scene.mesh.elements.every(e=>e.generation.algorithm.startsWith("triangle-")));
  }
});
test("the prepared W45 geometry exports and completes a coupled PETN run with finite states and gas energy balance",{timeout:240000},async t=>{
  const {h,data}=load("W45");
  const payload=h.context.buildCalculationInputExport({adaptive:false}),model=h.context.calculationInputPayloadToDirectModel(payload);
  assert.equal(model.elements.length,data.mesh.elements.length);assert.equal(model.materials.length,2);
  assert.ok(model.elements.every(e=>e.elasticModulus>0 && e.density>0));
  const history=await runBlastCore(model,{...data.blastSettings,duration:2e-5,frames:5},{lazy:true});t.after(()=>removeRun(history.id));
  assert.equal(history.frames.at(-1).time,2e-5);assert.ok(history.frames.at(-1).maxStress>0);
  for(const f of history.frames){assert.ok(f.pressure>0 && f.gasInternalEnergy>0);assert.ok(Math.abs(f.gasInternalEnergy+f.gasKineticEnergy+f.gasWallWork-history.initialGasEnergy)/history.initialGasEnergy<1e-9);}
});
