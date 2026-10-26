const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const EOS=require('../gas-eos'),Settings=require('../blast-settings'),Gas=require('../gas-library'),Explosives=require('../explosive-library'),{runBlastCore}=require('../server'),{removeRun}=require('../blast-runner'),{blastRing}=require('./helpers/blast-ring');
const root=path.resolve(__dirname,'..'),exe=path.join(__dirname,'native/x64/Release/real-gas-verification.exe');
test.before(()=>{const files=['tests/native/RealGasVerification.cpp','tests/native/RealGasVerification.vcxproj','计算力学程序计算核心/GasDynamics.cpp','计算力学程序计算核心/GasDynamics.h','计算力学程序计算核心/GasConstitutive.h'];if(fs.existsSync(exe)&&files.every(f=>fs.statSync(path.join(root,f)).mtimeMs<=fs.statSync(exe).mtimeMs))return;
  const r=spawnSync('C:/Program Files/Microsoft Visual Studio/2022/Community/MSBuild/Current/Bin/MSBuild.exe',['tests/native/RealGasVerification.vcxproj','/p:Configuration=Release','/p:Platform=x64','/v:minimal','/nologo'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stdout+r.stderr);
});
function run(mode,law,n=64){const r=spawnSync(exe,[mode,String(law),String(n)],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function near(a,b,tol=1e-9){assert.ok(Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);}
function values(law){return {sourceMode:1,productEOS:law,productGamma:1.4,productDensity:10,productEnergy:2e6,productCovolume:.005,productPressureOffset:1e5,productEnergyShift:2e4,productAttraction:100,
  airEOS:law,airGamma:1.4,airDensity:1.2,airPressure:101325,airCovolume:.001,airPressureOffset:1e4,airEnergyShift:2e4,airAttraction:20};}
for(const law of [3,4,5,6]){
  test(`EOS ${law}: native pressure, isentropic sound-speed derivative and inverse energy agree with independent equations`,()=>{
    const x=run('eos',law),gamma=1.4,rho=5,u=2e6-2e4,b=[3,5,6].includes(law)?.01:0,pinf=[4,5].includes(law)?2e4:0,a=law===6?200:0,d=1-b*rho;
    const pressure=(gamma-1)*rho*(u+a*rho)/d-gamma*pinf-a*rho*rho,c2=gamma*(pressure+pinf+a*rho*rho)/(rho*d)-2*a*rho;
    near(x.pressure,pressure);near(x.c2,c2);near(x.c2,x.derivative,1e-8);near(x.energy,2e6);
    near(EOS.evaluate({model:law,gamma,b,pinf,q:2e4,a},rho,2e6).pressure,pressure);
  });
  test(`EOS ${law}: stationary material contact stays equilibrated`,()=>{
    const x=run('contact',law);near(x.minPressure,1e6);near(x.maxPressure,1e6);assert.ok(x.maxVelocity<1e-9);near(x.internal+x.kinetic,x.initial);near(x.productMass,2.5);near(x.airMass,.3);
  });
  test(`EOS ${law}: moving wall and shock evolution preserve mass and total energy`,()=>{
    for(const mode of ['moving','shock']){const x=run(mode,law);near(x.internal+x.kinetic+x.work,x.initial,1e-11);assert.ok(x.minPressure>0&&x.maxVelocity>0);if(mode==='moving'){assert.ok(x.work<0);near(x.productMass,5*Math.PI);}}
  });
  test(`EOS ${law}: blast uses product and gap laws, streams finite states and conserves gas energy`,async t=>{
    const m=blastRing({sectors:24,rings:3,outer:.5}),h=await runBlastCore(m,{...values(law),rockModel:1,fracture:false,loadMode:1,gasCells:32,chargeRadius:.08,frames:3,duration:2e-5});t.after(()=>removeRun(h.id));
    assert.equal(h.gasConstitutiveVersion,1);assert.equal(h.airEOS,law);assert.equal(h.productEOS,law);
    for(const f of h.frames){assert.ok(f.pressure>0&&f.gasInternalEnergy>0);near(f.gasInternalEnergy+f.gasKineticEnergy+f.gasWallWork,h.initialGasEnergy,1e-8);assert.ok(f.elements.every(e=>e.every(Number.isFinite)));}
  });
  test(`EOS ${law}: both parameter libraries preserve new SI fields without changing unrelated settings`,()=>{
    const s=Settings.normalize(values(law)),g=Gas.entry({id:'real',name:'real',settings:s}),e=Explosives.entry({id:'real',name:'real',settings:s});
    for(const k of Gas.fields)assert.equal(g.settings[k],s[k]);for(const k of Explosives.fields)assert.equal(e.settings[k],s[k]);
    const current=Settings.normalize({productDensity:123});assert.equal(Gas.apply(current,g).productDensity,123);
  });
}
test('excluded density, phase, energy, missing calibration and axial vent configurations fail explicitly',()=>{
  for(const [law,bad] of [[3,{productCovolume:.2}],[3,{productCovolume:0}],[4,{productPressureOffset:0}],[5,{productEnergy:1}],[6,{productAttraction:0}],[6,{productAttraction:1e7}],[3,{ventEnds:1}]])assert.throws(()=>Settings.normalize({...values(law),...bad}));
  for(const mode of ['invalid','vent']){const r=spawnSync(exe,[mode,'3','64'],{encoding:'utf8',windowsHide:true});assert.notEqual(r.status,0);assert.match(r.stderr,/covolume|sealed/);}
});
test('legacy three-field gas and old explosive records gain safe defaults',()=>{
  const g=Gas.entry({id:'old',name:'old',settings:{airDensity:1.2,airPressure:101325,airGamma:1.4}});assert.equal(g.settings.airEOS,0);assert.equal(g.settings.airCovolume,0);
  const e=Explosives.entry(require('../explosives/library.json').explosives[0]);assert.equal(e.settings.productCovolume,0);
});
