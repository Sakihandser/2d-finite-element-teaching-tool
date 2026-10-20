'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {GenerationBridge}=require('../generation-bridge');
const {TrainingBridge}=require('../training-bridge');
const root=path.resolve(__dirname,'..');

test('historical references import three real coarse meshes with split isolation and survive history cleanup', {timeout:120000}, async()=>{
  const store=await fs.mkdtemp(path.join(os.tmpdir(),'fem-history-import-'));
  const previousStore=process.env.FEM_ML_STORAGE;
  process.env.FEM_ML_STORAGE=store;
  const training=new TrainingBridge(root),bridge=new GenerationBridge(root,store,training);
  try {
    await bridge.start({seed:'history-import-verification',geometries:1,conditions:2,maxPrimitives:2,maxRegions:1,maxHoles:0,
      seedNodes:150,maxNodes:3000,maxIterations:1,autoImport:false});
    const deadline=Date.now()+90000;
    while(bridge.busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(bridge.busy,false);
    const snapshot=await bridge.status(),job=snapshot.current;
    assert.equal(job.completed,2);assert.equal(job.failed,0);assert.equal(snapshot.history.assigned,0);
    const first=await bridge.history.assign({jobId:job.id,key:'g1-c1',split:'validation'});
    assert.equal(first.sample.split,'validation');assert.equal(first.sample.variants,3);
    await assert.rejects(()=>bridge.history.assign({jobId:job.id,key:'g1-c2',split:'train'}),/几何|geometry/i);
    assert.equal((await bridge.history.job(job.id)).cases[1].assigned,false);
    const second=await bridge.history.assign({jobId:job.id,key:'g1-c2',split:'validation'});
    assert.equal(second.sample.variants,3);
    assert.equal((await bridge.status()).history.assigned,2);
    const impact=await bridge.history.impact({scope:'assigned'});
    const removed=await bridge.history.remove({scope:'assigned',token:impact.token});
    assert.deepEqual(removed.failed,[]);assert.equal(removed.deletedCases.length,2);assert.equal(removed.deletedJobs.length,1);
    for(const sample of [first.sample,second.sample]) {
      const directory=path.join(store,'datasets',sample.id);
      const metadata=JSON.parse(await fs.readFile(path.join(directory,'metadata.json'),'utf8'));
      assert.equal(metadata.split,'validation');assert.equal(metadata.dataGeneration.batchId,job.id);
      assert.ok((await fs.stat(path.join(directory,'graphs.pt'))).size>0);
      const prepared=JSON.parse(await fs.readFile(path.join(directory,'reference.json'),'utf8'));
      assert.equal(prepared.meshes.length,3);assert.equal(metadata.variants,3);
    }
    assert.deepEqual((await bridge.status()).history,{batches:0,cases:0,assigned:0});
  }finally {
    if(training.child){const child=training.child;const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();await exited;}
    if(previousStore===undefined)delete process.env.FEM_ML_STORAGE;else process.env.FEM_ML_STORAGE=previousStore;
    assert.equal(path.dirname(path.resolve(store)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(store).startsWith('fem-history-import-'));
    await fs.rm(store,{recursive:true,force:true});
  }
});
