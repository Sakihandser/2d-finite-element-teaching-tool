const test=require('node:test'),assert=require('node:assert/strict');
const {blastRing}=require('./helpers/blast-ring'),{solidCard,solidSettings}=require('./helpers/solid-cards'),{runBlastCore}=require('../server'),{removeRun}=require('../blast-runner');
for(let law=4;law<=14;law++)test(`native blast law ${law}: material sidecar, internal forces and streamed frames`,async t=>{
  const m=blastRing({sectors:24,rings:3,outer:.5});m.materials[0].blastConstitutive=solidCard(law);
  const settings={rockModel:1,fracture:true,pressure:1e5,frames:3,pulse:1e-5,duration:2e-5,loadMode:1,...solidSettings(law)};
  if(law===9)Object.assign(settings,{loadMode:0,planeMode:1,confineX:1e6,confineY:1e6});
  const h=await runBlastCore(m,settings);t.after(()=>removeRun(h.id));assert.equal(h.solidConstitutiveVersion,1);assert.equal(h.frames.length,3);assert.equal(h.cellScalarCount,14);
  if(law===5)assert.ok(h.frames[0].elements.every(e=>e[10]===293));
  if(law===10)assert.ok(h.frames[0].elements.every(e=>e[11]===m.materials[0].blastConstitutive.cap.pressure));
  assert.ok(h.frames.at(-1).maxStress>0);for(const f of h.frames){assert.ok(f.u.every(Number.isFinite));assert.ok(f.elements.every(e=>e.every(Number.isFinite)));assert.ok(f.plasticWork>=0);}
});
test('multi-material blast honors per-material solid law overrides',async t=>{
  const m=blastRing({sectors:24,rings:3,outer:.5});m.materials[0].blastConstitutive=solidCard(4);m.materials.push({...m.materials[0],materialNo:2,blastConstitutive:solidCard(12)});
  for(let i=0;i<m.elements.length;i++)m.elements[i].materialNo=i%2+1;
  const h=await runBlastCore(m,{rockModel:1,fracture:false,pressure:1e5,frames:3,pulse:1e-5,duration:2e-5});t.after(()=>removeRun(h.id));assert.ok(h.frames.at(-1).maxStress>0);
});
test('MCC rejects absent initial confinement and plastic preloads are not silently accepted',async()=>{
  const m=blastRing({sectors:24,rings:3,outer:.5});m.materials[0].blastConstitutive=solidCard(9);
  await assert.rejects(runBlastCore(m,{fracture:false,pressure:0,frames:2,pulse:1e-5,duration:2e-5}),/positive initial/);
  m.materials[0].blastConstitutive=solidCard(4);m.materials[0].blastConstitutive.j2.yield=1e3;
  await assert.rejects(runBlastCore(m,{fracture:false,pressure:0,confineX:1e6,confineY:1e6,frames:2,pulse:1e-5,duration:2e-5}),/exceeds solid yield/);
});
for(const law of [4,5,6,10,11,14])test(`high-load blast law ${law}: inelastic states evolve and remain irreversible`,async t=>{
  const m=blastRing({sectors:24,rings:3,outer:.5});m.materials[0].blastConstitutive=solidCard(law);
  const metal=[4,5,11].includes(law),h=await runBlastCore(m,{rockModel:1,loadMode:1,planeMode:1,fracture:true,pressure:metal?1e9:5e8,pulse:metal?1e-4:2e-5,duration:metal?2e-4:5e-5,frames:5});t.after(()=>removeRun(h.id));
  assert.ok(h.frames.at(-1).plasticWork>0);assert.ok(h.frames.at(-1).elements.some(e=>e[8]>0));
  for(let f=1;f<h.frames.length;f++){assert.ok(h.frames[f].plasticWork>=h.frames[f-1].plasticWork);for(let i=0;i<m.elements.length;i++){const old=h.frames[f-1].elements[i],next=h.frames[f].elements[i];assert.ok(next[6]>=old[6]);assert.ok(next[8]>=old[8]);}}
  if(law===5)assert.ok(h.frames.at(-1).elements.some(e=>e[10]>293));
});
