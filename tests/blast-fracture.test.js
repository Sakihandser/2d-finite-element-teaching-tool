const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const Fracture=require('../blast-fracture'),{blastRing}=require('./helpers/blast-ring');
test('damage preflight names missing tensile strengths and skips the law when damage is disabled',()=>{
 const model=blastRing({rings:1,sectors:12});model.materials[0].name='Granite';model.elements[2].tensileStrength=0;
 const report=Fracture.inspect(model,{fracture:true,gf:100});assert.equal(report.valid,false);assert.equal(report.materials[0].missingStrength,1);
 assert.throws(()=>Fracture.assertValid(model,{fracture:true,gf:100}),/tensile strength.*Granite/);
 assert.equal(Fracture.inspect(model,{fracture:false,gf:100}).valid,true);
});
test('damage preflight checks the native crack-band limit from geometry and identifies the critical element',()=>{
 const model={nodes:[{nodeNo:1,x:0,y:0},{nodeNo:2,x:.01,y:0},{nodeNo:3,x:0,y:.01}],materials:[{materialNo:1,name:'Rock'}],
 elements:[{elementNo:42,materialNo:1,node1:1,node2:2,node3:3,elasticModulus:20e9,tensileStrength:10e6,area:999}]};
 const threshold=.01*(10e6)**2/(2*20e9);
 assert.equal(Fracture.inspect(model,{fracture:true,gf:threshold}).valid,false);
 assert.equal(Fracture.inspect(model,{fracture:true,gf:threshold+1e-6}).valid,true);
 assert.equal(Fracture.inspect(model,{fracture:true,gf:1}).materials[0].criticalElement,42);
 assert.throws(()=>Fracture.assertValid(model,{fracture:true,gf:1}),/Gf must exceed 25.*element 42/);
});
test('editing tensile strength preserves mesh and persists only validated values; a failed save rolls back',async()=>{
 const initial=[{id:'a',name:'Rock A',elasticModulus:20,tensileStrength:null},{id:'b',name:'Rock B',elasticModulus:30,tensileStrength:null}];
 const inputs=initial.map((m,i)=>({value:String(8-i*4),dataset:{blastStrengthMaterial:m.id},focus(){}}));
 const scene={regions:initial.map(material=>({materialId:material.id,material})),mesh:{elements:[{id:'E1'}],metadata:{stale:false}},analysisNodePlacement:{stale:false}};
 let saves=0;const api=vm.createContext({scene,materialLibrary:structuredClone(initial),document:{getElementById:()=>({textContent:''}),querySelectorAll:()=>inputs},
 materialSnapshotForRegion:r=>api.materialLibrary.find(m=>m.id===r.materialId),saveMaterialLibrary:async()=>{saves++;},syncRegionMaterialSnapshots(){},blastCavityText:s=>s});
 vm.runInContext(fs.readFileSync(require.resolve('../src/core/blast-fracture-ui.js'),'utf8'),api);api.syncBlastFractureControls=()=>{};
 const mesh=scene.mesh;await api.saveBlastStrengthInputs();assert.equal(saves,1);assert.deepEqual(Array.from(api.materialLibrary,m=>m.tensileStrength),[8,4]);
 assert.equal(scene.mesh,mesh);assert.equal(scene.mesh.metadata.stale,false);assert.equal(scene.analysisNodePlacement.stale,false);
 inputs[0].value='';await assert.rejects(api.saveBlastStrengthInputs(),/Rock A/);assert.equal(saves,1);
 inputs[0].value='9';api.saveMaterialLibrary=async()=>{throw new Error('disk failure');};await assert.rejects(api.saveBlastStrengthInputs(),/disk failure/);
 assert.equal(api.materialLibrary[0].tensileStrength,8);
});
