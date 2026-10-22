const test=require("node:test"),assert=require("node:assert/strict");
const {runBlastCore,runCalculationCore}=require("../server");
const {removeRun,readBlastFrame}=require("../blast-runner");
const {blastRing}=require("./helpers/blast-ring");
const base={fracture:false,frames:9,pulse:.00005,duration:.0012};

test("viscous boundaries remove outgoing energy and reduce reflected waves",async()=>{
  const model=blastRing();
  const reflecting=await runBlastCore(model,base),absorbing=await runBlastCore(model,{...base,boundary:2});
  const energy=h=>h.frames.at(-1).kineticEnergy+h.frames.at(-1).strainEnergy;
  assert.equal(absorbing.absorbingEdges,48);assert.equal(reflecting.absorbingEdges,0);
  assert.ok(energy(absorbing)<energy(reflecting)*.3,`remaining energy ratio ${energy(absorbing)/energy(reflecting)}`);
  assert.ok(absorbing.frames.at(-1).dissipatedEnergy>0);
  const f=absorbing.frames.at(-1);
  assert.ok(Math.abs(f.externalWork-energy(absorbing)-f.dissipatedEnergy)/f.externalWork<.04);
});
test("confinement is initially equilibrated and produces no startup wave, including on quiet boundaries",async()=>{
  for(const planeMode of [0,1]){
    const h=await runBlastCore(blastRing(),{...base,frames:5,pressure:0,boundary:2,confineX:10e6,confineY:10e6,planeMode});
    assert.ok(h.preloadResidual<1e-8);assert.ok(h.preloadEnergy>0);
    const first=h.frames[0];assert.ok(first.u.some(x=>Math.abs(x)>1e-6));assert.ok(first.elements.some(e=>e[3]<-1e6));
    for(const f of h.frames){assert.ok(f.kineticEnergy<1e-10);assert.ok(f.u.every((u,i)=>Math.abs(u-first.u[i])<1e-10));}
  }
});
test("elastic confinement and blast superpose while nodal/distributed load records are not double-counted",async()=>{
  const model=blastRing();
  for(const n of model.nodes)if(Math.hypot(n.x,n.y)>.99)n.fixUx=n.fixUy=true;
  model.nodes[0].forceX=1000;
  model.elementNodeLoads=[{elementNo:1,forceX1:1000,forceY1:0,forceX2:0,forceY2:0,forceX3:0,forceY3:0}];
  const staticResult=await runCalculationCore(model);assert.equal(staticResult.ok,true,staticResult.stderr);
  const h=await runBlastCore(model,{...base,frames:3,pressure:0,duration:.0003});
  assert.ok(Math.abs(h.frames[0].u[0]-staticResult.resultData.nodeDisplacements[0].ux)<1e-10);
  const wave=await runBlastCore(blastRing(),{...base,frames:3,boundary:2});
  const confined=await runBlastCore(blastRing(),{...base,frames:3,boundary:2,confineX:10e6,confineY:10e6});
  const last=confined.frames.at(-1),initial=confined.frames[0];
  assert.ok(last.u.every((value,i)=>Math.abs(value-initial.u[i]-wave.frames.at(-1).u[i])<1e-10));
});
test("existing assembled boundary tractions match the built-in confinement pressure",async()=>{
  const model=blastRing(),n=48,start=model.nodes.length-n,pressure=8e6;
  for(let j=0;j<n;j++){
    const a=model.nodes[start+j],b=model.nodes[start+(j+1)%n],dx=b.x-a.x,dy=b.y-a.y;
    for(const node of [a,b]){node.forceX=(node.forceX || 0)-pressure*dy/2;node.forceY=(node.forceY || 0)+pressure*dx/2;}
  }
  const options={...base,frames:2,pressure:0,duration:.0001,boundary:2};
  const existing=await runBlastCore(model,options),builtin=await runBlastCore(blastRing(),{...options,confineX:pressure,confineY:pressure});
  assert.ok(existing.frames[0].u.every((u,i)=>Math.abs(u-builtin.frames[0].u[i])<1e-10));
});
test("sudden external loads accelerate the body; explicit fixed/free/quiet edge overrides take precedence",async()=>{
  const model=blastRing();model.nodes[0].forceX=100;
  const sudden=await runBlastCore(model,{...base,frames:2,pressure:0,loadMode:1,duration:.0001});
  assert.ok(sudden.frames.at(-1).kineticEnergy>0);assert.ok(sudden.frames[0].u.every(x=>x===0));
  const mixed=blastRing(),n=48,start=mixed.nodes.length-n;
  mixed.blastBoundaryEdges=Array.from({length:n/2},(_,i)=>({node1:start+i+1,node2:start+(i+1)%n+1,mode:3}));
  const fixed=await runBlastCore(mixed,{...base,frames:2,boundary:2,duration:.0003});
  assert.equal(fixed.fixedBoundaryEdges,24);assert.equal(fixed.absorbingEdges,24);
  for(let i=0;i<=24;i++){assert.equal(fixed.frames.at(-1).u[2*(start+i)],0);assert.equal(fixed.frames.at(-1).u[2*(start+i)+1],0);}
  mixed.blastBoundaryEdges=[{node1:1,node2:49,mode:2}];
  await assert.rejects(runBlastCore(mixed,base),/true exterior/);
});
test("a 30,720-cell, 61-frame confined blast streams beyond the old history cap",{timeout:180000},async t=>{
  const model=blastRing({sectors:192,rings:80,outer:2.5}),start=performance.now();
  const h=await runBlastCore(model,{fracture:true,pressure:20e6,pulse:.0001,duration:.0006,frames:61,boundary:2,confineX:10e6,confineY:10e6,planeMode:1},{lazy:true});
  t.after(()=>removeRun(h.id));
  assert.equal(h.frames.length,61);assert.equal(h.elementCount,30720);assert.ok(!h.frames[0].u);
  assert.ok((4*h.nodeCount+7*h.elementCount)*h.frameCount>2000000);
  const last=await readBlastFrame(h.id,60),first=await readBlastFrame(h.id,0);
  assert.ok(last.elements.every(e=>e.every(Number.isFinite)));assert.ok(first.kineticEnergy===0);assert.ok(last.kineticEnergy>0);
  assert.ok(h.preloadResidual<1e-7);
  t.diagnostic(JSON.stringify({nodes:h.nodeCount,elements:h.elementCount,frames:h.frameCount,steps:h.steps,seconds:(performance.now()-start)/1000,compressedMB:h.compressedBytes/1024**2,workers:h.workers,preloadResidual:h.preloadResidual}));
});
