'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {validateConfig,generateGeometry,initializeTriangle,normalizeGenerated,buildReference}=require('../python_machine_learning/generation-core.cjs');
const {runCalculationCore}=require('../server');
const {GenerationBridge,splitFor}=require('../generation-bridge');
const root=path.resolve(__dirname,'..');
const config=validateConfig({seed:'20261020',geometries:1,conditions:2,maxIterations:1,seedNodes:150,maxNodes:3000,maxRegions:2,maxHoles:1});
let sources;
test.before(async()=>{sources=await generateGeometry(config);await initializeTriangle();});

test('invalid generation parameters are rejected before computation',()=>{
  for(const input of [{geometries:0},{conditions:1.5},{minForce:0},{maxHoles:10},{shapes:[]},
    {shapes:['bad']},{loadTypes:[]},{seedNodes:2000,maxNodes:1000},{minSize:9,maxSize:2},
    {geometries:200,conditions:20},{seed:' '},{maxIterations:101},{timeLimitSeconds:3601},
    {caseTimeLimitSeconds:0},{caseTimeLimitSeconds:86401},{importSplit:'invalid'}])assert.throws(()=>validateConfig(input));
  const limits=validateConfig({maxIterations:70,timeLimitSeconds:900,caseTimeLimitSeconds:3600,importSplit:'validation',targetOnly:false});
  assert.equal(limits.maxIterations,70);assert.equal(limits.timeLimitSeconds,900);
  assert.equal(limits.caseTimeLimitSeconds,3600);assert.equal(limits.importSplit,'validation');assert.equal(limits.targetOnly,true);
});

test('multi-region geometry preserves materials, holes, shared edges and provenance after import',async()=>{
  for(let i=0;i<4;i++){
    const source=(await generateGeometry(validateConfig({conditions:1}),i))[0];
    const {context,scene}=normalizeGenerated(source);
    assert.equal(scene.dataGeneration.geometryIndex,i);
    const restored=context.normalizeScene(JSON.parse(JSON.stringify(scene)));
    assert.equal(JSON.stringify(restored.dataGeneration),JSON.stringify(scene.dataGeneration));
    assert.equal(scene.regions.filter(r=>r.isAir).length,source.dataGeneration.holes);
    assert.equal(scene.regions.filter(r=>!r.isAir).length,source.dataGeneration.regions);
    assert.ok(scene.regions.filter(r=>!r.isAir).every(r=>r.materialProperties.elasticModulus>0));
  }
  // Regression: a hole endpoint on a half-step of the application's region key
  // used to round differently in its two interpolated adjacent edges.
  const holeCase=(await generateGeometry(validateConfig({seed:'pilot-20261020',conditions:1}),0))[0];
  assert.equal(normalizeGenerated(holeCase).scene.regions.filter(r=>r.isAir).length,holeCase.dataGeneration.holes);
});

test('native FEA produces finite ZZ labels for the exact reference mesh and effective loads',async()=>{
  const result=await buildReference(sources[0],config,runCalculationCore);
  const scene=result.scene,history=scene.mesh.metadata.adaptive.history,last=history.at(-1);
  assert.equal(history.length,2);
  assert.equal(last.nodes,scene.analysisNodes.length);
  assert.equal(last.elements,scene.mesh.elements.length);
  assert.equal(last.stopReason,'iteration-limit');
  assert.ok(history.every(row=>row.relativeError>0&&row.relativeError<1));
  assert.equal(result.result.nodeDisplacements.length,last.nodes);
  assert.ok(result.result.nodeDisplacements.every(n=>Number.isFinite(n.ux)&&Number.isFinite(n.uy)));
  assert.ok(result.result.nodeDisplacements.some(n=>Math.hypot(n.ux,n.uy)>0));
  assert.ok(scene.analysisNodes.some(n=>Math.hypot(n.ux,n.uy)>0));
});

test('node limit and timed-out later solve retain only the last solved reference',async()=>{
  const capped=await buildReference(sources[0],{...config,maxNodes:130},runCalculationCore);
  assert.equal(capped.scene.mesh.metadata.adaptive.history.at(-1).stopReason,'node-budget');
  assert.ok(capped.scene.analysisNodes.length<=130);
  let calls=0;
  const timed=await buildReference(sources[0],config,async(model,options)=>++calls===1?runCalculationCore(model,options):{ok:false,timedOut:true});
  const last=timed.scene.mesh.metadata.adaptive.history.at(-1);
  assert.equal(calls,2);
  assert.equal(last.stopReason,'time-limit');
  assert.equal(last.nodes,timed.scene.analysisNodes.length);
  assert.equal(last.elements,timed.scene.mesh.elements.length);
  assert.equal(timed.result.nodeDisplacements.length,last.nodes);
});

test('total case budget bounds the native solve and restores the last solved reference on expiry',async()=>{
  const realNow=Date.now;
  let elapsed=0,calls=0;
  const budgets=[];
  Date.now=()=>100000+elapsed;
  try {
    const result=await buildReference(sources[0],{...config,maxIterations:5,timeLimitSeconds:10,caseTimeLimitSeconds:2,targetError:1e-6},async(model,options)=>{
      budgets.push(options.timeLimitMs);
      if(++calls===1){const solved=await runCalculationCore(model,options);elapsed=1500;return solved;}
      elapsed=2000;return {ok:false,timedOut:true};
    });
    assert.deepEqual(budgets,[2000,500]);
    const final=result.scene.mesh.metadata.adaptive.history.at(-1);
    assert.equal(final.stopReason,'case-time-limit');assert.equal(final.iteration,0);
    assert.equal(final.nodes,result.scene.analysisNodes.length);
    assert.equal(final.elements,result.scene.mesh.elements.length);
    assert.equal(result.result.nodeDisplacements.length,final.nodes);
    assert.equal(result.scene.mesh.metadata.adaptive.config.caseTimeLimitMs,2000);
    elapsed=0;
    await assert.rejects(()=>buildReference(sources[0],{...config,timeLimitSeconds:10,caseTimeLimitSeconds:1},async()=>({ok:false,timedOut:true})),/总耗时.*首次求解/);
  }finally{Date.now=realNow;}
});

test('automatic imports honor fixed or grouped splits and require actual achieved accuracy',async()=>{
  const store=await fs.mkdtemp(path.join(os.tmpdir(),'fem-import-policy-'));
  try {
    for(const mode of ['train','validation','auto']) {
      const imports=[],configs=[];
      const bridge=new GenerationBridge(root,store,{request:async(command,payload)=>{
        if(command==='status')return {current:null};
        imports.push(payload);
        return {sample:{id:'a'.repeat(32),split:payload.split},duplicate:false};
      }});
      bridge.worker=async request=>{
        configs.push(request.config);
        const scene=JSON.parse(await fs.readFile(request.input,'utf8'));
        const index=scene.dataGeneration.caseIndex;
        // The stop-reason string alone must never be trusted as proof of accuracy.
        const relativeError=[.2,.01,null][index];
        scene.analysisNodes=[];scene.mesh={elements:[],metadata:{adaptive:{history:[{relativeError,stopReason:index===0?'target-error':'iteration-limit'}]}}};
        await fs.writeFile(request.output,JSON.stringify(scene));
      };
      await bridge.start({...config,conditions:3,maxIterations:37,timeLimitSeconds:240,caseTimeLimitSeconds:1800,importSplit:mode,targetOnly:false});
      const deadline=Date.now()+20000;
      while(bridge.busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(bridge.busy,false);assert.equal(bridge.current.imported,1);assert.equal(bridge.current.rejected,2);
      assert.equal(imports.length,1);
      assert.equal(imports[0].split,mode==='auto'?splitFor(config.seed,0,config.validationFraction):mode);
      assert.deepEqual(bridge.current.cases.map(r=>r.meetsTarget),[false,true,false]);
      assert.ok(bridge.current.cases.every(r=>r.split===imports[0].split));
      assert.ok(configs.every(c=>c.maxIterations===37&&c.timeLimitSeconds===240&&c.caseTimeLimitSeconds===1800&&c.targetOnly));
      if(mode==='validation') {
        bridge.training.request=async command=>command==='status'?{current:null}:{duplicate:true,sample:{id:'a'.repeat(32),split:'train'}};
        await bridge.start({...config,conditions:2,importSplit:'validation'});
        const duplicateDeadline=Date.now()+20000;
        while(bridge.busy&&Date.now()<duplicateDeadline)await new Promise(resolve=>setTimeout(resolve,20));
        assert.equal(bridge.busy,false);assert.equal(bridge.current.imported,0);
        assert.equal(bridge.current.cases[1].status,'import-failed');
        assert.match(bridge.current.cases[1].error,/另一数据集/);
      }
    }
  }finally {
    assert.equal(path.dirname(path.resolve(store)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(store).startsWith('fem-import-policy-'));
    await fs.rm(store,{recursive:true,force:true});
  }
});

test('batch isolates cases, gates training, groups splits, filters quality, and stops after the current case',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fem-generator-test-'));
  const imported=[];
  const training={request:async(command,payload)=>{
    if(command==='status')return {current:null};
    if(command==='import'){
      const scene=JSON.parse(await fs.readFile(payload.path,'utf8'));
      imported.push({scene,split:payload.split});
      return {sample:{id:String(imported.length).padStart(32,'a'),split:payload.split},duplicate:false};
    }
    throw new Error(command);
  }};
  try{
    const bridge=new GenerationBridge(root,directory,training);
    const {id}=await bridge.start({...config,conditions:2,maxIterations:0,targetError:.95});
    await assert.rejects(()=>bridge.start(config),/正在运行/);
    const deadline=Date.now()+60000;
    while(bridge.busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(bridge.busy,false);
    const state=await bridge.status(),job=state.current;
    assert.equal(job.id,id);assert.equal(job.completed,2);assert.equal(job.failed,0);assert.equal(job.imported,2);
    assert.equal(imported[0].split,imported[1].split);
    assert.equal(imported[0].split,splitFor(config.seed,0,config.validationFraction));
    for(const row of job.cases){
      const scene=JSON.parse(await bridge.sample(id,row.key));
      assert.equal(scene.dataGeneration.batchId,id);
      assert.ok(scene.mesh.metadata.adaptive.history.at(-1).relativeError>0);
    }
    await assert.rejects(()=>bridge.sample('../escape','g1-c1'),/路径/);
    assert.equal((await new GenerationBridge(root,directory,training).status()).current.completed,2);
    const blocked=new GenerationBridge(root,directory,{request:async()=>({current:{status:'training'}})});
    await assert.rejects(()=>blocked.start(config),/暂停/);
    const strict=new GenerationBridge(root,directory,training);
    await strict.start({...config,conditions:1,maxIterations:0,targetOnly:true,targetError:.000001});
    while(strict.busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(strict.current.rejected,1);
    assert.equal(strict.current.imported,0);
    assert.equal(strict.current.cases[0].status,'rejected');
    assert.ok(JSON.parse(await strict.sample(strict.current.id,'g1-c1')).mesh.elements.length>0);
    const stopping=new GenerationBridge(root,directory,training);
    const nativeWorker=stopping.worker.bind(stopping);
    let stopTask;
    stopping.worker=(request,onProgress)=>nativeWorker(request,detail=>{
      onProgress(detail);
      if(!stopTask)stopTask=stopping.stop();
    });
    await stopping.start({...config,conditions:2,maxIterations:0,targetError:.95});
    while(stopping.busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
    await stopTask;
    assert.equal(stopping.current.status,'stopped');
    assert.equal(stopping.current.completed,1);
    assert.equal(stopping.current.imported,1);
    assert.equal(stopping.current.cases.length,1);
  }finally{
    const absolute=path.resolve(directory);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(absolute,{recursive:true,force:true});
  }
});
