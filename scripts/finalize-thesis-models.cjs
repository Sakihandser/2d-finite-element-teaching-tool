// Persist the experiment materials and export ordinary app JSON files. This
// script is offline authoring support; the app contains no experiment loader.
const fs=require("node:fs/promises"),path=require("node:path");
const Thesis=require("./thesis-blast-geometry.cjs"),{compactScene}=require("./compact-thesis-scene.cjs");
const root=path.resolve(__dirname,"..");
async function main(){
  const materialsPath=path.join(root,"materials/materials.json"),payload=JSON.parse(await fs.readFile(materialsPath,"utf8"));
  for(const key of ["granite","sandstone"]){
    const m=Thesis.material(key),r=Thesis.reference[key];
    m.elasticModulus=Math.round(m.elasticModulus*1e6)/1e6;m.poissonRatio=Math.round(m.poissonRatio*1e6)/1e6;
    m.notes+=` 原始JH2参考（当前未实现）：ρ=${r.density} kg/m³，K=${r.K} GPa，G=${r.G} GPa，T=${r.T} MPa；${JSON.stringify(Thesis.reference.jh2)}。参考JSON中的应力及K1/K2/K3单位为Pa，应变率单位为1/s，其余无量纲。来源：论文PDF第${key==="granite" ? 59 : 137}页。`;
    m.createdAt=new Date().toISOString();m.updatedAt=m.createdAt;
    if(!payload.materials.some(existing=>existing.id===m.id))payload.materials.push(m);
  }
  payload.updatedAt=new Date().toISOString();await fs.writeFile(materialsPath,JSON.stringify(payload,null,2)+"\n");
  const embeddedPath=path.join(root,"materials/materials.js"),embedded=await fs.readFile(embeddedPath,"utf8");
  await fs.writeFile(embeddedPath,embedded.slice(0,embedded.indexOf("window.PROJECT_MATERIAL_LIBRARY ="))+"window.PROJECT_MATERIAL_LIBRARY = "+JSON.stringify(payload,null,2)+";\n");
  const source=path.resolve(root,"examples/thesis-4-3"),destination=path.resolve(root,"models/thesis-4-3");
  for(const target of [source,destination]){const relative=path.relative(root,target);if(relative.startsWith("..") || path.isAbsolute(relative))throw new Error("Model path outside workspace.");}
  await fs.mkdir(path.dirname(destination),{recursive:true});
  try{await fs.access(source);await fs.rename(source,destination);}catch(error){if(error.code!=="ENOENT")throw error;}
  const petn=JSON.parse(await fs.readFile(path.join(root,"explosives/library.json"),"utf8")).explosives.find(e=>e.id==="petn-thesis-section43");
  for(const code of Thesis.cases){
    const exported=path.resolve(root,"..",`${code}.json`),local=path.join(destination,`${code}.json`);
    let file=local;try{await fs.access(file);}catch(error){if(error.code!=="ENOENT")throw error;file=exported;}
    const data=JSON.parse(await fs.readFile(file,"utf8"));
    data.blastSettings=Thesis.scene(code,0,petn).blastSettings;data.blastExplosiveId=petn.id;data.blastGasId="air-user-parameter-image";
    data.viewport={scale:500,offsetX:0,offsetY:0};
    for(const region of data.regions){
      const material=payload.materials.find(m=>m.id===region.materialId);if(material){region.material=structuredClone(material);region.materialProperties=Object.fromEntries(["elasticModulus","poissonRatio","density","tensileStrength","compressiveStrength","yieldStrength"].map(key=>[key,material[key]]));}
    }
    await fs.writeFile(exported,JSON.stringify(compactScene(data))+"\n");console.log(code,(await fs.stat(exported)).size);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
