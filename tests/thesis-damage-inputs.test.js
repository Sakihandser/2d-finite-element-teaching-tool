const test=require('node:test'),assert=require('node:assert/strict');
const {directModel}=require('../scripts/verify-thesis-damage.cjs'),Fracture=require('../blast-fracture');
const DamageMesh=require('../src/core/blast-damage-mesh');
test('all four thesis models retain current library strengths and can prepare a compatible damage mesh',()=>{
 for(const code of ['W45','W90','H45','H90']){
  const {model,settings}=directModel(code);assert.equal(settings.fracture,true);
  assert.ok(model.elements.every(e=>e.tensileStrength>0));
  const nodes=model.nodes.map(n=>({...n,id:'A'+n.nodeNo})),elements=model.elements.map(e=>({...e,id:'E'+e.elementNo,analysisNodeIds:e.nodeNumbers.map(n=>'A'+n)}));
  const result=DamageMesh.prepare(nodes,elements,elements.map(e=>({id:e.id,elasticModulus:e.elasticModulus,tensileStrength:e.tensileStrength})),settings);
  const prepared={nodes:result.analysisNodes.map(n=>({...n,nodeNo:n.id})),elements:result.elements.map(e=>({...e,node1:e.analysisNodeIds[0],node2:e.analysisNodeIds[1],node3:e.analysisNodeIds[2]}))};
  assert.equal(Fracture.inspect(prepared,settings).valid,true,code);
 }
});
