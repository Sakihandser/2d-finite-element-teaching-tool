const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const {runBlastCore}=require("../server");
const {blastRing}=require("./helpers/blast-ring");
const settings=require("../blast-settings");
const model=blastRing();
const options={pulse:.00005,duration:.0003,frames:31,fracture:false};

test("blast settings reject invalid values instead of silently replacing them",()=>{
  for(const input of [{radius:0},{chargeRadius:0},{chargeRadius:-1},{pressure:-1},{pulse:NaN},{dt:-1},{frames:2.1},{frames:202},{fracture:1},{x:"0"}])
    assert.throws(()=>settings.normalize(input));
});
test("zero pressure stays exactly at rest",async()=>{
  const history=await runBlastCore(model,{...options,pressure:0});
  assert.equal(history.frames.length,31);
  assert.equal(history.frames.at(-1).time,options.duration);
  for(const f of history.frames) {
    assert.ok(f.u.every(x=>x===0));assert.ok(f.v.every(x=>x===0));
    assert.equal(f.kineticEnergy,0);assert.equal(f.externalWork,0);
    assert.ok(f.elements.every(e=>e.every(x=>x===0)));
  }
});
test("pressure launches a finite-speed wave with balanced momentum and conserved post-pulse energy",async()=>{
  const h=await runBlastCore(model,options);
  assert.equal(h.loadedEdges,48);
  assert.ok(h.dt<=h.stableDt);
  const early=h.frames[1];
  assert.ok(early.u[0]>0,"hole moves outward under compressive pressure");
  assert.equal(early.u[model.nodes.length*2-2],0,"wave has not instantly reached outer edge");
  const last=h.frames.at(-1);
  assert.ok(last.u.some(x=>Math.abs(x)>1e-7));
  const masses=model.nodes.map(()=>0);
  for(const e of model.elements) for(const n of e.nodeNumbers) masses[n-1]+=e.area*e.density/3;
  let px=0,py=0,absolute=0;
  for(let i=0;i<masses.length;i++) {px+=masses[i]*last.v[2*i];py+=masses[i]*last.v[2*i+1];absolute+=masses[i]*Math.hypot(last.v[2*i],last.v[2*i+1]);}
  assert.ok(Math.hypot(px,py)<absolute*1e-9);
  const energies=h.frames.filter(f=>f.time>options.pulse*1.5).map(f=>f.kineticEnergy+f.strainEnergy);
  assert.ok((Math.max(...energies)-Math.min(...energies))/Math.max(...energies)<.03);
  assert.ok(Math.abs(last.kineticEnergy+last.strainEnergy-last.externalWork)/last.externalWork<.03);
  assert.ok(last.elements.every(e=>e[6]===0));
});
test("central difference displacement converges under time-step reduction",async()=>{
  const first=await runBlastCore(model,{...options,frames:2});
  const half=await runBlastCore(model,{...options,frames:2,dt:first.dt/2});
  const quarter=await runBlastCore(model,{...options,frames:2,dt:first.dt/4});
  const distance=(a,b)=>Math.sqrt(a.reduce((s,v,i)=>s+(v-b[i])**2,0));
  const error1=distance(first.frames.at(-1).u,half.frames.at(-1).u);
  const error2=distance(half.frames.at(-1).u,quarter.frames.at(-1).u);
  assert.ok(error1/error2>3 && error1/error2<5,`convergence ratio ${error1/error2}`);
});
test("damage grows irreversibly and all stress/history values remain finite",async()=>{
  const h=await runBlastCore(model,{...options,pressure:20e6,fracture:true,gf:100});
  let maximum=0;
  for(let i=0;i<model.elements.length;i++) {
    let previous=0;
    for(const f of h.frames) {
      const e=f.elements[i];assert.ok(e.every(Number.isFinite));
      assert.ok(e[6]>=previous && e[6]<=1);previous=e[6];maximum=Math.max(maximum,e[6]);
    }
  }
  assert.ok(maximum>.5);
});
test("native solver rejects unstable dt, missing material, unmatched cavity and unbalanced preloads",async()=>{
  await assert.rejects(runBlastCore(model,{...options,dt:.001}),/dt exceeds/);
  await assert.rejects(runBlastCore(model,{...options,radius:.2}),/cavity/);
  const bad=structuredClone(model);bad.elements[0].density=0;
  await assert.rejects(runBlastCore(bad,options),/density/);
  bad.elements[0].density=2500;bad.nodes[0].forceX=1;
  await assert.rejects(runBlastCore(bad,options),/cannot equilibrate/);
  const fracture=structuredClone(model);fracture.elements[0].tensileStrength=0;
  await assert.rejects(runBlastCore(fracture,{...options,fracture:true}),/tensile strength/);
});
test("browser frame conversion preserves engineering shear and damage",()=>{
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../src/core/blast-dynamics.js"),"utf8"),context);
  const result=context.blastFrameResult({nodes:[{nodeNo:7}],elements:[{elementNo:9}]},
    {u:[3,4],elements:[[1,2,6,10,20,30,.7]]});
  assert.equal(result.nodeDisplacements[0].magnitude,5);
  assert.equal(result.elementResults[0].strainXy,3);
  assert.equal(result.elementResults[0].damage,.7);
});
test("fixed degrees of freedom stay zero and mass damping reduces post-pulse kinetic energy",async()=>{
  const supported=structuredClone(model);
  for(const n of supported.nodes) if(Math.hypot(n.x,n.y)>.99) {n.fixUx=true;n.fixUy=true;}
  const h=await runBlastCore(supported,options);
  for(const f of h.frames) for(let i=0;i<supported.nodes.length;i++) if(supported.nodes[i].fixUx) {
    assert.equal(f.u[2*i],0);assert.equal(f.u[2*i+1],0);assert.equal(f.v[2*i],0);assert.equal(f.v[2*i+1],0);
  }
  const free=await runBlastCore(model,{...options,frames:2});
  const damped=await runBlastCore(model,{...options,frames:2,damping:2000});
  const energy=h=>h.frames.at(-1).kineticEnergy+h.frames.at(-1).strainEnergy;
  assert.ok(energy(damped)<energy(free));
});
