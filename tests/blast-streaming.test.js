const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),http=require("node:http"),{gunzipSync}=require("node:zlib");
const Codec=require("../blast-frame-codec"),{runBlastCore}=require("../server"),{serveBlastHistory,removeRun}=require("../blast-runner"),{blastRing}=require("./helpers/blast-ring");

test("frame decoder rejects malformed buffers and keeps aligned fields as typed views",()=>{
  const metadata={nodeCount:3,elementCount:1};const buffer=Buffer.alloc(Codec.frameBytes(metadata));
  buffer.writeDoubleLE(.1,0);buffer.writeDoubleLE(7,64);buffer.writeDoubleLE(8,64+6*8);
  const frame=Codec.decode(buffer,metadata);assert.equal(frame.time,.1);assert.equal(frame.u[0],7);assert.equal(frame.v[0],8);
  assert.ok(frame.u instanceof Float64Array);assert.equal(frame.elements[0].length,7);
  assert.throws(()=>Codec.decode(buffer.subarray(1),metadata),/Incomplete/);
  assert.throws(()=>Codec.frameBytes({nodeCount:0,elementCount:1}),/dimensions/);
});
test("HTTP frame retrieval and compressed full-history export round-trip complete native fields",async t=>{
  const model=blastRing({sectors:12,rings:2});
  const h=await runBlastCore(model,{fracture:false,frames:3,pulse:.00005,duration:.0001},{lazy:true});
  t.after(()=>removeRun(h.id));
  const server=http.createServer((request,response)=>serveBlastHistory(new URL(request.url,"http://localhost"),response));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const root=`http://127.0.0.1:${server.address().port}/api/blast-runs/${h.id}`;
  const response=await fetch(root+"/frames/2"),frame=Codec.decode(await response.arrayBuffer(),h);
  assert.equal(response.status,200);assert.equal(frame.time,h.frames[2].time);assert.equal(frame.elements.length,model.elements.length);
  const download=await fetch(root+"/download");
  const result=JSON.parse(gunzipSync(Buffer.from(await download.arrayBuffer())));
  assert.equal(result.frames.length,3);assert.equal(result.frames[2].u.length,model.nodes.length*2);
  assert.deepEqual(result.frames[2].elements[0],Array.from(frame.elements[0]));
  assert.equal((await fetch(root+"/frames/100")).status,404);
});
test("frame scrubbing retains baseline plus only two other frames and derives perturbations from preload",async()=>{
  const context=vm.createContext({fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)}),BlastFrameCodec:{decode:()=>({u:[0,0],elements:[]})}});
  vm.runInContext(fs.readFileSync(require.resolve("../src/core/blast-dynamics.js"),"utf8"),context);
  const history={frames:Array.from({length:12},()=>({time:0})),frameBaseUrl:"/frames/"};
  for(let i=0;i<12;i++)await context.fetchBlastFrame(history,i);
  assert.equal(history.frameCache.size,3);assert.ok(history.frameCache.has(0));assert.ok(history.frameCache.has(11));
  const model={nodes:[{nodeNo:1}],elements:[{elementNo:1}]};
  const initial={u:[0,0],elements:[[0,0,0,-10,-10,0,0]]},frame={u:[0,0],elements:[[0,0,0,-8,-8,0,0]]};
  const result=context.blastFrameResult(model,frame,initial);
  assert.equal(result.elementResults[0].dynamicEquivalentStress,2);assert.equal(result.elementResults[0].equivalentStress,8);
});
test("cancelling a streamed calculation kills the native process instead of waiting for every frame",async()=>{
  const controller=new AbortController();
  await assert.rejects(runBlastCore(blastRing(),{fracture:false,duration:.1,frames:201},{lazy:true,signal:controller.signal,onProgress:()=>controller.abort()}),/cancelled/);
});


test("gas histories retain extended thermodynamic scalars through HTTP and compressed export",async t=>{
  const h=await runBlastCore(blastRing({sectors:12,rings:2}),{sourceMode:1,chargeRadius:.05,gasCells:32,fracture:false,frames:3,duration:.0001},{lazy:true});
  t.after(()=>removeRun(h.id));
  const server=http.createServer((request,response)=>serveBlastHistory(new URL(request.url,"http://localhost"),response));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const root="http://127.0.0.1:"+server.address().port+"/api/blast-runs/"+h.id;
  const frame=Codec.decode(await (await fetch(root+"/frames/2")).arrayBuffer(),h);
  const exported=JSON.parse(gunzipSync(Buffer.from(await (await fetch(root+"/download")).arrayBuffer())));
  for(const key of ["gasInternalEnergy","gasKineticEnergy","gasWallWork","gasWallRadius"]){
    assert.equal(frame[key],h.frames[2][key]);assert.equal(exported.frames[2][key],frame[key]);
  }
  assert.equal(exported.sourceMode,1);assert.equal(exported.frameScalarCount,12);
});
