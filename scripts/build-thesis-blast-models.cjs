// Generate editable, already-meshed scene files through the real app workflow.
const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),http=require("node:http"),vm=require("node:vm");
const {sceneWorkflowHarness}=require("../tests/helpers/scene-workflow");
const {compactScene}=require("./compact-thesis-scene.cjs");
const Thesis=require("./thesis-blast-geometry.cjs"),library=require("../explosives/library.json");
const triangle=require("../src/vendor/triangle-wasm/triangle-wasm");
const root=path.resolve(__dirname,".."),directory=path.join(root,"models/thesis-4-3");
async function main(){
  const server=http.createServer((req,res)=>{res.setHeader("Content-Type","application/wasm");fs.createReadStream(path.join(root,"src/vendor/triangle-wasm/triangle.out.wasm")).pipe(res);});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    await triangle.init(`http://127.0.0.1:${server.address().port}/triangle.out.wasm`);
    const api={...triangle,init:()=>Promise.resolve()},explosive=library.explosives.find(e=>e.id==="petn-thesis-section43");
    await fsp.mkdir(directory,{recursive:true});
    const manifest={version:1,reference:Thesis.reference,sourceExplosive:explosive.id,meshSpacing:.005,models:[]};
    for(const code of Thesis.cases){
      const input=Thesis.scene(code,0,explosive),h=sceneWorkflowHarness(input,api);
      const built=await h.context.autoGenerateAnalysisMesh({adaptive:false,regenerateNodes:true,maxNodes:50000,spacing:.005,maxEdgeLength:.007,tolerance:1e-6});
      const data=JSON.parse(vm.runInContext("JSON.stringify(scene)",h.context));
      data.blastSettings=input.blastSettings;data.blastExplosiveId=explosive.id;
      // source name is populated by normal import/export; no active DOM needed.
      const model={code,file:`${code}.json`,nodes:data.analysisNodes.length,elements:data.mesh.elements.length,coverage:built.mesh.coverage};
      if(!model.coverage?.passed || data.regions.filter(r=>!r.isAir).length!==2)throw new Error(`${code}: invalid material partition or coverage`);
      await fsp.writeFile(path.join(directory,model.file),JSON.stringify(compactScene(data))+"\n");
      manifest.models.push(model);console.log(JSON.stringify({code,nodes:model.nodes,elements:model.elements,coverage:model.coverage.passed}));
    }
    await fsp.writeFile(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  }finally{await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
