// Reproduce the screenshot's W45 mesh/Gf failure and run the repaired mesh.
const fs=require('node:fs'),path=require('node:path');
const {directModel}=require('./verify-thesis-damage.cjs'),DamageMesh=require('../src/core/blast-damage-mesh'),Fracture=require('../blast-fracture');
const {runBlastCore}=require('../server'),{readBlastFrame,removeRun}=require('../blast-runner');
async function verify(){
  const {model,settings}=directModel('W45');
  for(const m of model.materials)m.tensileStrength=m.name.includes('青砂岩') ? 44e6 : 54e6;
  for(const e of model.elements)e.tensileStrength=model.materials.find(m=>m.materialNo===e.materialNo).tensileStrength;
  settings.gf=100;settings.fracture=true;
  const before=Fracture.inspect(model,settings),start=performance.now();
  const nodes=model.nodes.map(n=>({...n,id:'A'+n.nodeNo})),elements=model.elements.map(e=>({...e,id:'E'+e.elementNo,analysisNodeIds:e.nodeNumbers.map(n=>'A'+n)}));
  const mesh=DamageMesh.prepare(nodes,elements,elements.map(e=>({id:e.id,elasticModulus:e.elasticModulus,tensileStrength:e.tensileStrength})),settings,{onProgress:p=>console.log(JSON.stringify(p))});
  const ids=new Map(mesh.analysisNodes.map((n,i)=>[n.id,i+1]));
  const prepared={...model,nodes:mesh.analysisNodes.map((n,i)=>({...n,nodeNo:i+1,materialNo:1,regionNo:1,dofUx:2*i+1,dofUy:2*i+2})),elements:mesh.elements.map((e,i)=>{
    const refs=e.analysisNodeIds.map(id=>ids.get(id));
    return {...e,elementNo:i+1,node1:refs[0],node2:refs[1],node3:refs[2],nodeNumbers:refs};
  })};
  Fracture.assertValid(prepared,settings);
  const history=await runBlastCore(prepared,settings,{lazy:true});
  try{
    let maximumDamage=0,damagedElements=0,gasEnergyError=0,previous=new Float64Array(prepared.elements.length);
    for(let i=0;i<history.frames.length;i++){
      const f=await readBlastFrame(history.id,i);
      for(let j=0;j<f.elements.length;j++){
        const row=f.elements[j],d=row[6];
        if(!row.every(Number.isFinite) || d<previous[j] || d<0 || d>1)throw new Error('Invalid or decreasing damage');
        previous[j]=d;maximumDamage=Math.max(maximumDamage,d);
      }
      gasEnergyError=Math.max(gasEnergyError,Math.abs(f.gasInternalEnergy+f.gasKineticEnergy+f.gasWallWork-history.initialGasEnergy)/history.initialGasEnergy);
    }
    damagedElements=previous.filter(d=>d>.01).length;
    if(!damagedElements)throw new Error('No tensile damage');
    const result={case:'W45',originalNodes:model.nodes.length,originalElements:model.elements.length,nodes:prepared.nodes.length,elements:prepared.elements.length,
      rounds:mesh.rounds,before:before.materials,after:Fracture.inspect(prepared,settings).materials,
      settings:history.settings,steps:history.steps,dt:history.dt,frames:history.frames.length,maximumDamage,damagedElements,gasEnergyError,seconds:(performance.now()-start)/1000,
      note:'44/54 MPa treated as user-entered uniaxial strengths for numerical verification only; not a JH2 calibration or experimental reproduction.'};
    fs.writeFileSync(path.resolve(__dirname,'../docs/benchmarks/blast-damage-mesh-W45.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  }finally{await removeRun(history.id);}
}
verify().catch(error=>{console.error(error);process.exitCode=1;});
