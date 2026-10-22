// Bounded-memory native stream -> independently compressed frames on local disk.
const {spawn}=require("node:child_process");
const fs=require("node:fs/promises"),nativeFs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {randomUUID}=require("node:crypto"),{gzip,gunzip,createGzip}=require("node:zlib"),{promisify}=require("node:util"),{once}=require("node:events");
const zip=promisify(gzip),unzip=promisify(gunzip);
const Settings=require("./blast-settings"),RockMaterials=require('./blast-materials'),Codec=require("./blast-frame-codec"),{encodeCalculationModelBinary}=require("./calculation-ipc");
const runs=new Map();
const ownedDirectories=new Set();
process.once("exit",()=>{
  for(const directory of ownedDirectories)try{nativeFs.rmSync(directory,{recursive:true,force:true});}catch{}
});
let activeRuns=0;
async function removeRun(id){const run=runs.get(id);if(!run)return;runs.delete(id);await fs.rm(run.directory,{recursive:true,force:true});ownedDirectories.delete(run.directory);}
async function pruneRuns(){
  for(const [id,run] of runs)if(Date.now()-run.createdAt>12*3600*1000 && !run.readers)await removeRun(id);
  while(runs.size>=8){const candidate=[...runs].find(([,run])=>!run.readers);if(!candidate)throw new Error("All blast history slots are in use.");await removeRun(candidate[0]);}
}
class StreamReader {
  constructor(stream){this.iterator=stream[Symbol.asyncIterator]();this.chunk=Buffer.alloc(0);this.offset=0;}
  async read(size){
    const result=Buffer.allocUnsafe(size);let written=0;
    while(written<size){
      if(this.offset===this.chunk.length){const next=await this.iterator.next();if(next.done)throw new Error("Native blast stream ended before all frames arrived.");this.chunk=next.value;this.offset=0;}
      const count=Math.min(size-written,this.chunk.length-this.offset);this.chunk.copy(result,written,this.offset,this.offset+count);this.offset+=count;written+=count;
    }
    return result;
  }
  async finish(){if(this.offset!==this.chunk.length)throw new Error("Unexpected trailing blast stream data.");const next=await this.iterator.next();if(!next.done)throw new Error("Unexpected trailing blast stream data.");}
}
async function readBlastFrame(id,index,materialize=false){
  const run=runs.get(id);if(!run || !Number.isInteger(index) || index<0 || index>=run.manifest.frames.length)throw new Error("Blast history expired or frame does not exist. Run the simulation again.");
  run.readers++;
  try{return Codec.decode(await unzip(await fs.readFile(path.join(run.directory,`${index}.bin.gz`))),run.manifest,materialize);}
  finally{run.readers--;}
}
async function runNativeBlastImpl(executable,root,model,inputSettings={},options={}){
  const settings=Settings.normalize(inputSettings);
  if(settings.chargeRadius>settings.radius*(1+1e-8))throw new Error("Charge radius exceeds the cavity radius.");
  if(!model || !Array.isArray(model.nodes) || !Array.isArray(model.elements))throw new Error("Blast requires model nodes and elements.");
  require("./blast-fracture").assertValid(model,settings);
  const rockRows=RockMaterials.rows(model,settings);
  await pruneRuns();
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"fem-blast-")),id=randomUUID();
  ownedDirectories.add(directory);
  let child,timer,stderr="",processError=null;
  try{
    const args=["--binary-ipc","--blast-ipc"];
    const rockFile=path.join(directory,'rock-materials.txt');await fs.writeFile(rockFile,rockRows);args.push('--blast-rock-file',rockFile);
    for(const [key,value] of Object.entries(settings))if(key!=="timeLimitSeconds")args.push(`--blast-${key}`,String(key==="fracture" ? Number(value) : value));
    const boundaryEdges=model.blastBoundaryEdges || [];
    if(boundaryEdges.length){
      const rows=boundaryEdges.map(edge=>{
        if(![edge.node1,edge.node2].every(n=>Number.isInteger(n) && n>0) || ![0,1,2,3].includes(edge.mode))throw new Error("Invalid blast boundary edge.");
        return `${edge.node1} ${edge.node2} ${edge.mode}`;
      });
      const file=path.join(directory,"boundaries.txt");await fs.writeFile(file,rows.join("\n")+"\n");args.push("--blast-boundary-file",file);
    }
    child=spawn(executable,args,{cwd:root,windowsHide:true,stdio:["pipe","pipe","pipe"]});
    child.on("error",error=>{processError=error;});
    const abort=()=>{processError=new Error("Blast calculation cancelled.");child.kill();};
    options.signal?.addEventListener("abort",abort,{once:true});
    child.once("close",()=>options.signal?.removeEventListener("abort",abort));
    if(options.signal?.aborted)abort();
    let progressLines="",lastProgress=0,completedSteps=0;
    const started=Date.now();
    const report=progress=>{
      const fraction=Math.max(lastProgress,Math.min(1,progress.fraction || 0));lastProgress=fraction;
      const elapsedSeconds=(Date.now()-started)/1000;
      completedSteps=Math.max(completedSteps,progress.completedSteps || 0);
      options.onProgress?.({...progress,...(progress.totalSteps ? {completedSteps} : {}),fraction,elapsedSeconds,remainingSeconds:fraction>0 && fraction<1 ? elapsedSeconds*(1-fraction)/fraction : null});
    };
    report({phase:"preparing",fraction:0});
    child.stderr.on("data",chunk=>{
      progressLines+=chunk.toString("utf8");
      let end;
      while((end=progressLines.indexOf("\n"))>=0){
        const line=progressLines.slice(0,end).trim();progressLines=progressLines.slice(end+1);
        const match=/^BLAST_PROGRESS (\d+) (\d+)$/.exec(line);
        if(match)report({phase:"solving",completedSteps:Number(match[1]),totalSteps:Number(match[2]),fraction:.98*Number(match[1])/Number(match[2])});
        else stderr=(stderr+line+"\n").slice(-65536);
      }
      if(progressLines.length>65536){stderr=(stderr+progressLines).slice(-65536);progressLines="";}
    });
    child.stdin.on("error",error=>{if(error.code!=="EPIPE")processError=error;});
    const completion=new Promise(resolve=>child.on("close",code=>resolve(code)));
    timer=setTimeout(()=>{processError=new Error(`Blast calculation exceeded ${settings.timeLimitSeconds} seconds.`);child.kill();},settings.timeLimitSeconds*1000);
    child.stdin.end(encodeCalculationModelBinary(model));
    const reader=new StreamReader(child.stdout),header=await reader.read(12);
    if(header.subarray(0,8).toString("ascii")!=="FEMBLT02")throw new Error("Unsupported blast stream; rebuild the C++ core.");
    const length=header.readUInt32LE(8);if(length>65536)throw new Error("Invalid blast metadata length.");
    const metadata=JSON.parse((await reader.read(length)).toString("utf8"));
    if((settings.rockModel!==0 || settings.gasFracture!==0 || settings.kinematics!==0 || settings.ventEnds>0 || (model.materials||[]).some(m=>m.blastConstitutive?.law>0)) && metadata.constitutiveVersion!==2)throw new Error('Rebuild the native core for the selected rock model.');
    if(settings.sourceMode===1 && metadata.sourceMode!==1)throw new Error("Native core does not support gas dynamics; rebuild and restart the program.");
    if(metadata.nodeCount!==model.nodes.length || metadata.elementCount!==model.elements.length || !Number.isInteger(metadata.frameCount) || metadata.frameCount<2 || metadata.frameCount>201)throw new Error("Invalid blast stream dimensions.");
    const frameSize=Codec.frameBytes(metadata),frames=[];
    let bytes=0,peakStress=0,peakDynamicStress=0;
    for(let i=0;i<metadata.frameCount;i++){
      const raw=await reader.read(frameSize),frame=Codec.summary(raw,metadata);
      if(Object.values(frame).some(value=>!Number.isFinite(value)))throw new Error("Invalid blast frame summary.");
      const compressed=await zip(raw,{level:1});bytes+=compressed.length;
      if(bytes>4*1024**3)throw new Error("Compressed blast history exceeds 4 GiB. Reduce saved frames or duration.");
      await fs.writeFile(path.join(directory,`${i}.bin.gz`),compressed);frames.push(frame);
      peakStress=Math.max(peakStress,frame.maxStress);peakDynamicStress=Math.max(peakDynamicStress,frame.maxDynamicStress);
      report({phase:i===metadata.frameCount-1 ? "saving" : "solving",savedFrames:i+1,totalFrames:metadata.frameCount,
        completedSteps:Math.round(frame.time/settings.duration*metadata.steps),totalSteps:metadata.steps,fraction:.98*frame.time/settings.duration});
    }
    await reader.finish();const exitCode=await completion;
    if(processError || exitCode!==0)throw processError || new Error(stderr || "Native blast solver failed.");
    const manifest={ok:true,...metadata,id,settings,frames,peakStress,peakDynamicStress,storage:"compressed-frame-files",compressedBytes:bytes,
      frameBaseUrl:`./api/blast-runs/${id}/frames/`,downloadUrl:`./api/blast-runs/${id}/download`};
    runs.set(id,{directory,manifest,model,readers:0,createdAt:Date.now()});
    await fs.writeFile(path.join(directory,"manifest.json"),JSON.stringify(manifest));
    report({phase:"complete",fraction:1,savedFrames:frames.length,totalFrames:frames.length});
    if(options.lazy)return manifest;
    // Small-model compatibility for programmatic callers; the browser always uses lazy frames.
    if(frameSize*metadata.frameCount>128*1024*1024)throw new Error("Use lazy:true for histories larger than 128 MiB.");
    const materialized=[];for(let i=0;i<frames.length;i++)materialized.push(await readBlastFrame(id,i,true));
    return {...manifest,frames:materialized};
  }catch(error){
    if(child && child.exitCode===null){child.kill();await Promise.race([once(child,"close").catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);}
    runs.delete(id);await fs.rm(directory,{recursive:true,force:true});ownedDirectories.delete(directory);
    throw processError || new Error(stderr.replace(/^Performance log written to:.*$/gm,"").trim() || error.message);
  }finally{clearTimeout(timer);}
}
async function runNativeBlast(...args){
  if(activeRuns>=2)throw new Error("Two blast calculations are already running. Wait or cancel a run before starting another.");
  activeRuns++;try{return await runNativeBlastImpl(...args);}finally{activeRuns--;}
}
async function serveBlastHistory(url,response){
  const match=/^\/api\/blast-runs\/([a-f0-9-]+)\/(?:frames\/(\d+)|download)$/.exec(url.pathname);if(!match)return false;
  const run=runs.get(match[1]);
  if(!run){response.writeHead(404,{"Content-Type":"application/json"});response.end(JSON.stringify({ok:false,error:"Blast history expired. Run the simulation again."}));return true;}
  run.readers++;
  try{
    if(match[2]!==undefined){
      const index=Number(match[2]);if(index>=run.manifest.frames.length){response.writeHead(404);response.end();return true;}
      const file=path.join(run.directory,`${index}.bin.gz`),stat=await fs.stat(file);
      response.writeHead(200,{"Content-Type":"application/octet-stream","Content-Encoding":"gzip","Content-Length":stat.size,"Cache-Control":"no-store"});
      await new Promise((resolve,reject)=>{const input=nativeFs.createReadStream(file);input.on("error",reject);response.on("close",()=>{input.destroy();resolve();});response.on("finish",resolve);input.pipe(response);});
    }else{
      response.writeHead(200,{"Content-Type":"application/gzip","Content-Disposition":"attachment; filename=blast-history.json.gz"});
      const gzipStream=createGzip({level:1});gzipStream.on("error",()=>response.destroy());gzipStream.pipe(response);
      response.on("close",()=>gzipStream.destroy());
      const write=async text=>{if(gzipStream.destroyed)throw new Error("Download closed.");if(!gzipStream.write(text))await once(gzipStream,"drain");};
      await write(JSON.stringify({...run.manifest,model:run.model,frames:undefined}).replace(/}$/,',"frames":['));
      for(let i=0;i<run.manifest.frames.length;i++)await write((i ? "," : "")+JSON.stringify(await readBlastFrame(match[1],i,true)));
      gzipStream.end("]}");await new Promise(resolve=>{response.on("finish",resolve);response.on("close",resolve);});
    }
  }catch(error){response.destroy(error);}finally{run.readers--;}
  return true;
}
module.exports={runNativeBlast,readBlastFrame,serveBlastHistory,removeRun};
