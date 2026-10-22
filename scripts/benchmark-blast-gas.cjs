// Reproduce the long-duration air-gap regression with bounded-memory histories.
// node scripts/benchmark-blast-gas.cjs --cells 192,384 --rings 68 --output <external-report-path>
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{createHash}=require("node:crypto");
const {runBlastCore}=require("../server"),{removeRun}=require("../blast-runner"),{blastRing}=require("../tests/helpers/blast-ring");
const root=path.resolve(__dirname,"..");
function option(name,fallback){const i=process.argv.indexOf(`--${name}`);return i<0 ? fallback : process.argv[i+1];}
async function main(){
  const cells=option("cells","192,384").split(",").map(Number),rings=Number(option("rings","10"));
  if(!Number.isInteger(rings) || rings<1 || cells.some(n=>!Number.isInteger(n) || n<16 || n>2048))throw new Error("Invalid rings or gas cells.");
  const model=blastRing({sectors:48,rings});
  const settings={sourceMode:1,chargeRadius:.05,duration:.005,dt:Number(option("dt","1e-7")),frames:61,fracture:false,boundary:2,timeLimitSeconds:600};
  const hashes={};
  for(const file of ["GasDynamics.cpp","GasDynamics.h","BlastDynamics.cpp"])
    hashes[file]=createHash("sha256").update(await fs.readFile(path.join(root,"计算力学程序计算核心",file))).digest("hex");
  const report={date:new Date().toISOString(),node:process.version,cpu:os.cpus()[0]?.model,nodes:model.nodes.length,elements:model.elements.length,settings,sourceHashes:hashes,runs:[]};
  for(const gasCells of cells){
    const start=performance.now();
    const h=await runBlastCore(model,{...settings,gasCells},{lazy:true});
    try{
      const run={gasCells,seconds:(performance.now()-start)/1000,steps:h.steps,frames:h.frames.length,workers:h.workers,
        compressedBytes:h.compressedBytes,maxRelativeGasEnergyError:Math.max(...h.frames.map(f=>Math.abs(f.gasInternalEnergy+f.gasKineticEnergy+f.gasWallWork-h.initialGasEnergy)/h.initialGasEnergy)),
        maxRelativeWallWorkMismatch:Math.max(...h.frames.map(f=>Math.abs(f.gasWallWork-f.externalWork)/Math.max(1,Math.abs(f.gasWallWork)))),lastFrame:h.frames.at(-1)};
      report.runs.push(run);console.log(JSON.stringify(run));
    }finally{await removeRun(h.id);}
  }
  const output=option("output",null);
  if(output){await fs.writeFile(path.resolve(root,output),JSON.stringify(report,null,2)+"\n");console.log(`Saved ${output}`);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
