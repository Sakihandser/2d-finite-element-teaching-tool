const {rockCard}=require('./helpers/rock-card');
const test=require('node:test'),assert=require('node:assert/strict');
const {blastRing}=require('./helpers/blast-ring'),{runBlastCore}=require('../server'),{removeRun}=require('../blast-runner'),Cards=require('../blast-materials');
function model(){const m=blastRing({sectors:24,rings:6,outer:.6});m.materials[0].blastConstitutive=rockCard();return m;}
test('JH2 accepts a hydrostatic material card without misusing a tensile ft/Gf preflight',async t=>{
 const m=model();m.materials[0].tensileStrength=0;for(const e of m.elements)e.tensileStrength=0;
 const h=await runBlastCore(m,{rockModel:3,fracture:true,confineX:20e6,confineY:20e6,planeMode:1,boundary:2,pressure:0,frames:3,duration:.00005,pulse:.00001});t.after(()=>removeRun(h.id));
 assert.equal(h.constitutiveVersion,2);assert.equal(h.cellScalarCount,10);assert.ok(h.preloadResidual<1e-8);
 for(const f of h.frames){assert.ok(f.kineticEnergy<1e-8);assert.ok(f.elements.every(e=>e[6]===0&&e[8]===0));}
});
test('new elastic model matches the original elastic solution with a full 3D stress state',async t=>{
 const m=blastRing({sectors:24,rings:4});const settings={fracture:false,pressure:2e6,pulse:.00001,duration:.00005,planeMode:1,frames:3};
 const old=await runBlastCore(m,settings),next=await runBlastCore(m,{...settings,rockModel:1});t.after(()=>Promise.all([removeRun(old.id),removeRun(next.id)]));
 for(let i=0;i<next.frames.at(-1).u.length;i++)assert.ok(Math.abs(next.frames.at(-1).u[i]-old.frames.at(-1).u[i])<1e-10);
 assert.ok(next.frames.at(-1).elements.some(e=>Math.abs(e[7])>100));
});
test('connected fracture storage has matched pressure work and conservative gas energy',async t=>{
 const m=model();const h=await runBlastCore(m,{rockModel:3,fracture:true,planeMode:1,boundary:2,sourceMode:1,chargeRadius:.09,gasCells:48,gasFracture:1,crackDamage:.8,frames:13,duration:.0003});t.after(()=>removeRun(h.id));
 for(const f of h.frames){assert.ok(f.crackVolume>=0);assert.ok(f.plasticWork>=0);assert.ok(Math.abs(f.gasInternalEnergy+f.gasKineticEnergy+f.gasWallWork-h.initialGasEnergy)/h.initialGasEnergy<1e-10);assert.ok(Math.abs(f.gasWallWork-f.externalWork-f.gasStorageWork)/Math.max(1,Math.abs(f.gasWallWork))<1e-7);}
 assert.ok(h.frames.some(f=>f.elements.some(e=>e[8]>0)));assert.ok(h.frames.some(f=>f.crackVolume>0),'must exercise connected open fracture volume');
});
test('per-material law override survives the sidecar and invalid cards fail before the native run',async t=>{
 const m=model();m.materials[0].blastConstitutive.law=1;const h=await runBlastCore(m,{rockModel:3,fracture:true,frames:2,duration:.00002,pulse:.00001});t.after(()=>removeRun(h.id));assert.ok(h.frames.at(-1).elements.every(e=>e[6]===0&&e[8]===0));
 m.materials[0].blastConstitutive.law=3;m.materials[0].blastConstitutive.jh2.HEL=1;await assert.rejects(runBlastCore(m,{rockModel:3}),/JH2/);
});
test('finite-deformation cavity coupling conserves interface work with adaptive CFL and exact frame times',async t=>{
 const m=blastRing({sectors:24,rings:4});const h=await runBlastCore(m,{rockModel:1,kinematics:1,planeMode:1,fracture:false,sourceMode:1,productEnergy:10000,chargeRadius:.08,gasCells:32,frames:5,duration:.0001});t.after(()=>removeRun(h.id));
 assert.equal(h.stepCountIsEstimate,true);assert.ok(Math.abs(h.frames.at(-1).time-.0001)<1e-13);
 for(let i=0;i<h.frames.length;i++){const f=h.frames[i];assert.ok(Math.abs(f.time-.0001*i/4)<1e-13);assert.ok(Math.abs(f.gasWallWork-f.externalWork)/Math.max(1,Math.abs(f.externalWork))<1e-7);}
});
test('axial end conditions preserve delayed opening and conserve vented mass and energy',async t=>{
 const m=blastRing({sectors:24,rings:4}),settings={rockModel:1,kinematics:1,planeMode:1,fracture:false,sourceMode:1,productEnergy:10000,chargeRadius:.1,gasCells:32,frames:5,duration:.0001,specimenThickness:.05};
 const histories=[];t.after(()=>Promise.all(histories.map(h=>removeRun(h.id))));
 for(const ventEnds of [0,1,2])histories.push(await runBlastCore(m,{...settings,ventEnds}));
 const delayed=await runBlastCore(m,{...settings,ventEnds:2,ventOpeningTime:.00005});histories.push(delayed);
 for(const h of histories.slice(1)){
  assert.equal(h.frameScalarCount,24);const initial=h.frames[0].gasProductMass+h.frames[0].gasAirMass;
  for(const f of h.frames){assert.ok(Math.abs(f.gasProductMass+f.gasAirMass+f.gasVentedMass-initial)/initial<1e-11);assert.ok(Math.abs(f.gasInternalEnergy+f.gasKineticEnergy+f.gasWallWork+f.gasVentedEnergy-h.initialGasEnergy)/h.initialGasEnergy<1e-10);}
 }
 assert.ok(histories[2].frames.at(-1).gasVentedMass>histories[1].frames.at(-1).gasVentedMass);
 assert.equal(delayed.frames[2].gasVentedMass,0);assert.ok(delayed.frames.at(-1).gasVentedMass>0);
 assert.ok(Math.abs(delayed.frames[2].pressure/histories[0].frames[2].pressure-1)<1e-12);
 await assert.rejects(runBlastCore(m,{...settings,ventEnds:3}),/axial/);await assert.rejects(runBlastCore(m,{...settings,specimenThickness:0}),/axial/);
});
