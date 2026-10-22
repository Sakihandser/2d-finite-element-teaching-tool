'use strict';
// Exercise main's actual static workflow with its own C++ solver. Sources are
// read-only; no reference scene, training data or drawing model is overwritten.
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const vm=require('node:vm');
const triangle=require('../src/vendor/triangle-wasm/triangle-wasm');
const {sceneWorkflowHarness}=require('../tests/helpers/scene-workflow');
const {runCalculationCore}=require('../server');
const root=path.resolve(__dirname,'..');

async function run(source,mode,stress=false){
  const {context:c,scene}=sceneWorkflowHarness(source,triangle);
  Object.assign(c,{initializeTriangleWasm:async()=>triangle,updateCalculationPanel(){},updateCalculationRunStatus(){},
    renderCalculationView(){},loadCalculationResultsFromData:()=>true,
    runCalculationCoreDirect:(model,options)=>runCalculationCore(model,{...options,useGpuAcceleration:false})});
  // Preserve the prior bulk policy as a comparison under the SAME workflow,
  // initial placement, boundary fix, solver, node budget and round limit.
  if(mode==='previous-marking')c.markAdaptiveHotspots=c.markAdaptiveElements;
  const started=Date.now();
  const result=await c.startCalculationWorkflow({adaptive:true,maxIterations:stress?100:16,relativeTolerance:.05,
    maxAdaptiveNodes:stress?100000:30000,timeLimitSeconds:30,useGpuAcceleration:false});
  const history=JSON.parse(JSON.stringify(result.adaptive.history)),last=history.at(-1);
  return {mode,durationMs:Date.now()-started,nodes:scene.analysisNodes.length,elements:scene.mesh.elements.length,
    error:last.relativeError,stopReason:last.stopReason,meetsTarget:last.relativeError<=.05,
    resultNodes:result.runResult.resultData.nodeDisplacements.length,resultElements:result.runResult.resultData.elementResults.length,history};
}

async function main(){
  const [sourceDirectory,outputFile,stressFlag]=process.argv.slice(2);
  if(!sourceDirectory||!outputFile||(stressFlag!=null&&stressFlag!=='stress'))throw new Error('Usage: node --expose-gc benchmark-adaptive-hotspots.cjs <source-directory> <metrics.json> [stress]');
  const stress=stressFlag==='stress';
  const wasm=await fs.readFile(path.join(root,'src/vendor/triangle-wasm/triangle.out.wasm'));
  const server=http.createServer((request,response)=>{response.setHeader('Content-Type','application/wasm');response.end(wasm);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await triangle.init(`http://127.0.0.1:${server.address().port}/triangle.out.wasm`);}
  finally{await new Promise(resolve=>server.close(resolve));}
  const report={version:1,createdAt:new Date().toISOString(),branch:'main',targetError:.05,maxIterations:stress?100:16,maxAdaptiveNodes:stress?100000:30000,timeLimitSeconds:30,cases:[]};
  await fs.mkdir(path.dirname(path.resolve(outputFile)),{recursive:true});
  for(const key of stress?['g2-c1']:['g1-c2','g3-c2','g2-c1']){
    const source=JSON.parse(await fs.readFile(path.join(sourceDirectory,key+'.source.json'),'utf8'));
    for(const mode of stress?['bounded-hotspots']:['previous-marking','bounded-hotspots']){
      let result;
      try{result=await run(source,mode,stress);}catch(error){result={mode,failure:error.stack||String(error)};}
      report.cases.push({key,...result});await fs.writeFile(outputFile,JSON.stringify(report,null,2));
      console.log(JSON.stringify({key,mode,nodes:result.nodes,error:result.error,stop:result.stopReason,seconds:result.durationMs/1000,failure:result.failure}));
      global.gc?.();
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
