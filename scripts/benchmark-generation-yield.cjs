'use strict';
// Read-only source benchmark. References live in a fresh temporary directory;
// only compact metrics are retained. Never imports into the training library.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { validateConfig, generateGeometry } = require('../python_machine_learning/generation-core.cjs');
const root = path.resolve(__dirname,'..');

async function main() {
  const [manifestFile, outputFile, holdoutText='24', roundsText] = process.argv.slice(2);
  if (!manifestFile || !outputFile) throw new Error('Usage: node benchmark-generation-yield.cjs <manifest.json> <metrics.json> [holdout-count] [rounds-override]');
  const holdoutCount = Number(holdoutText);
  if (!Number.isInteger(holdoutCount) || holdoutCount<0 || holdoutCount>50) throw new Error('holdout-count must be 0–50');
  const rounds=roundsText==null?null:Number(roundsText);
  if(rounds!=null&&(!Number.isInteger(rounds)||rounds<0||rounds>100))throw new Error('rounds-override must be 0–100');
  const original=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fem-yield-benchmark-'));
  const input=path.join(directory,'source.json'),output=path.join(directory,'reference.json'),result=path.join(directory,'result.json');
  const report={version:1,createdAt:new Date().toISOString(),originalBatch:original.id,
    policy:'bounded-raw-error-with-compact-point-protection-v1',holdoutSeed:'yield-holdout-20261022-v1',cases:[]};
  await fs.mkdir(path.dirname(path.resolve(outputFile)),{recursive:true});
  async function run(source,config,identity,baseline) {
    const started=Date.now();await fs.writeFile(input,JSON.stringify(source));
    let error;
    try {
      await new Promise((resolve,reject)=>{
        const child=fork(path.join(root,'python_machine_learning/generation-worker.cjs'),[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
        let message='',done=false,stderr='';
        const timer=setTimeout(()=>{message='benchmark case timeout';child.kill();},(config.caseTimeLimitSeconds+60)*1000);
        child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
        child.on('message',data=>{if(data.type==='done')done=true;if(data.type==='error')message=data.error;});
        child.on('error',e=>{clearTimeout(timer);reject(e);});
        child.on('exit',code=>{clearTimeout(timer);code===0&&done?resolve():reject(new Error(message||stderr||`exit ${code}`));});
        child.send({input,output,result,config});
      });
    } catch(e) {error=e.message;}
    const row={identity,baseline,config:{seed:config.seed,maxIterations:config.maxIterations,maxNodes:config.maxNodes,targetError:config.targetError,
      timeLimitSeconds:config.timeLimitSeconds,caseTimeLimitSeconds:config.caseTimeLimitSeconds,physicsSampling:config.physicsSampling||'all'},durationMs:Date.now()-started};
    if(error)row.error=error;
    else {
      const scene=JSON.parse(await fs.readFile(output,'utf8')),history=scene.mesh.metadata.adaptive.history,last=history.at(-1);
      Object.assign(row,{nodes:scene.analysisNodes.length,elements:scene.mesh.elements.length,errorEstimate:last.relativeError,
        meetsTarget:last.relativeError>0&&last.relativeError<=config.targetError,stopReason:last.stopReason,history});
    }
    report.cases.push(row);await fs.writeFile(outputFile,JSON.stringify(report,null,2));
    console.log(JSON.stringify({case:identity,nodes:row.nodes,error:row.errorEstimate,stop:row.stopReason,failure:row.error,seconds:row.durationMs/1000}));
    for(const file of [input,output,result])await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
  try {
    for(const row of original.cases) {
      if(!Number.isFinite(row.errorEstimate))continue;
      const source=JSON.parse(await fs.readFile(path.join(path.dirname(manifestFile),row.key+'.source.json'),'utf8'));
      await run(source,rounds==null?original.config:{...original.config,maxIterations:rounds},'existing/'+row.key,{nodes:row.nodes,errorEstimate:row.errorEstimate,stopReason:row.stopReason});
    }
    const config=validateConfig({seed:report.holdoutSeed,conditions:1});
    for(let i=0;i<holdoutCount;i++)await run((await generateGeometry(config,i))[0],config,'holdout/'+i);
  } finally {
    for(const file of [input,output,result])await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await fs.rmdir(directory);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
