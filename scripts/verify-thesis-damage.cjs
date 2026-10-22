const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function directModel(code='W45'){
  const data=JSON.parse(fs.readFileSync(path.resolve(root,'..',`${code}.json`),'utf8'));
  const library=JSON.parse(fs.readFileSync(path.join(root,'materials/materials.json'),'utf8')).materials;
  const ids=new Map(),materials=[];
  for(const region of data.regions){
    const id=region.materialId || region.material?.id;if(!id || ids.has(id))continue;
    const m=library.find(m=>m.id===id) || region.material;
    const materialNo=materials.length+1;ids.set(id,materialNo);
    materials.push({materialNo,name:m.name,elasticModulus:m.elasticModulus*1e9,poissonRatio:m.poissonRatio,density:m.density,tensileStrength:m.tensileStrength*1e6});
  }
  const regions=new Map(data.regions.map(r=>[r.id,r])),numbers=new Map(data.analysisNodes.map((n,i)=>[n.id,i+1]));
  const nodes=data.analysisNodes.map((n,i)=>({nodeNo:i+1,x:n.x,y:n.y,materialNo:1,regionNo:1,dofUx:2*i+1,dofUy:2*i+2}));
  const elements=data.mesh.elements.map((e,i)=>{
    const region=regions.get(e.regionId),materialNo=ids.get(region.materialId || region.material.id);
    const [node1,node2,node3]=e.analysisNodeIds.map(id=>numbers.get(id));
    return {...materials[materialNo-1],elementNo:i+1,node1,node2,node3,nodeNumbers:[node1,node2,node3],area:e.area};
  });
  return {model:{modelName:data.name,nodes,elements,materials,elementNodeLoads:[],units:{length:'m',elasticModulus:'Pa',strength:'Pa'}},settings:data.blastSettings};
}
async function verify(){
  const code=process.argv[2] || 'W45',{model,settings}=directModel(code);
  const {runBlastCore}=require('../server'),{readBlastFrame,removeRun}=require('../blast-runner');
  const report=require('../blast-fracture').inspect(model,settings);if(!report.valid)throw new Error(JSON.stringify(report));
  const start=performance.now(),history=await runBlastCore(model,{...settings,fracture:true},{lazy:true});
  try{
    let maximumDamage=0,damagedElements=0,previous=new Float64Array(model.elements.length);
    for(let index=0;index<history.frames.length;index++){
      const frame=await readBlastFrame(history.id,index);
      for(let i=0;i<frame.elements.length;i++){
        const row=frame.elements[i],damage=row[6];if(!row.every(Number.isFinite) || damage<previous[i] || damage<0 || damage>1)throw new Error('Invalid damage history');
        previous[i]=damage;maximumDamage=Math.max(maximumDamage,damage);
      }
      if(index===history.frames.length-1)damagedElements=previous.filter(d=>d>.01).length;
    }
    if(!(maximumDamage>0 && damagedElements>0))throw new Error('No tensile damage developed');
    const result={case:code,duration:history.settings.duration,steps:history.steps,dt:history.dt,frames:history.frames.length,nodes:model.nodes.length,elements:model.elements.length,
      seconds:(performance.now()-start)/1000,maximumDamage,damagedElements,materials:report.materials,settings:history.settings,
      note:'User-authorized uncalibrated tensile-damage demonstration: granite 8 MPa, sandstone 4 MPa; not a JH2 reproduction.'};
    fs.writeFileSync(path.join(root,'docs/benchmarks/thesis-damage-'+code+'.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  }finally{await removeRun(history.id);}
}
if(require.main===module)verify().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={directModel};
