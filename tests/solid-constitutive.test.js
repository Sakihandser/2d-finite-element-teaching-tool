const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const Cards=require('../blast-materials'),Settings=require('../blast-settings'),{solidCard,solidSettings}=require('./helpers/solid-cards');
const root=path.resolve(__dirname,'..'),exe=path.join(__dirname,'native/x64/Release/solid-verification.exe');
test.before(()=>{const inputs=['tests/native/SolidVerification.cpp','tests/native/SolidVerification.vcxproj','TensoraCore/RockConstitutive.h','TensoraCore/SolidConstitutive.h'];if(fs.existsSync(exe)&&inputs.every(f=>fs.statSync(path.join(root,f)).mtimeMs<=fs.statSync(exe).mtimeMs))return;
  const r=spawnSync('C:/Program Files/Microsoft Visual Studio/2022/Community/MSBuild/Current/Bin/MSBuild.exe',['tests/native/SolidVerification.vcxproj','/p:Configuration=Release','/p:Platform=x64','/v:minimal','/nologo'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stdout+r.stderr);
});
function driver(mode,n=200){const r=spawnSync(exe,[mode,String(n)],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function near(a,b,tol=1e-8){assert.ok(Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);}
const G=210e9/2.6;
test('J2 radial return satisfies the analytical hardening solution and elastic unloading',()=>{
  const x=driver('j2'),trial=Math.sqrt(3)*G*.02,ep=(trial-200e6)/(3*G+1e9);near(x.ep,ep);near(x.q,200e6+1e9*ep);near(x.oldEp,x.unloadEp);assert.ok(x.work>0&&x.energy>0);assert.ok(Math.abs(x.szz)<1);
});
test('JC return uses plastic strain rate in the independent strength equation',()=>{
  const x=driver('jc'),expected=(200e6+400e6*x.ep**.4)*(1+.02*Math.log(Math.max(1,x.ep/1e-5)));near(x.q,expected);near(x.temperature,293);
  const hot=driver('jc-adiabatic');assert.ok(hot.temperature>293);near(hot.temperature,293+.9*hot.work/(7800*480));
});
test('MC resolves the actual principal stress surface, hydrostatic tension, corners and rotated paths',()=>{
  const x=driver('mc');near(1.5*x.max-.5*x.min,10e6*Math.cos(Math.PI/6),1e-6);assert.ok(x.apexMax<=1e6+1);assert.ok(x.work>0&&x.ep>0);assert.ok(x.rotationError<1e-10);assert.ok(driver('mc-random').violation<1);
});
test('Prony exponential integration matches the closed-form ramp/hold and exact dissipation',()=>{
  const x=driver('maxwell'),ramp=(g,tau)=>G*g*.01*(tau/.01)*(1-Math.exp(-.01/tau));
  near(x.rampShear,G*.5*.01+ramp(.3,.02)+ramp(.2,.1));near(x.holdShear,G*.5*.01+ramp(.3,.02)*Math.exp(-.05/.02)+ramp(.2,.1)*Math.exp(-.05/.1));near(x.holdLoss,x.energyDrop);assert.ok(x.holdLoss>0);assert.ok(Math.abs(x.szz)<1);
});
for(const mode of ['neo','mooney'])test(`${mode} total-F stress is objective and agrees with the derivative of strain energy`,()=>{
  const x=driver(mode);assert.ok(x.sx>0&&x.sy<0&&x.energy>0);assert.ok(x.rotationError<1e-12);assert.ok(x.energyDerivativeError<1e-8);assert.ok(x.rigidStress<1e-7);
  const b=[1.4**2,1/1.4**2,1],i1=b.reduce((a,b)=>a+b,0),i2=b[0]*b[1]+b[1]*b[2]+b[0]*b[2];
  const c10=mode==='neo'?1e6:.7e6,c01=mode==='neo'?0:.3e6;
  near(x.sx,2*c10*(b[0]-i1/3)+2*c01*(i1*b[0]-b[0]**2-2*i2/3));
});
test('MCC hydrostatic return satisfies both the yield ellipse and exponential pc hardening',()=>{
  const x=driver('mcc');near(x.p,x.pc);near(x.pc,200e3*Math.exp((1+.8)*Math.exp(-.02)/(.2-.04)*x.plasticVolume));assert.ok(x.plasticVolume>0&&x.work>0);
});
test('MCC dry-side shear softens pc toward the critical state and converges under refinement',()=>{
  const a=driver('mcc-shear',200),b=driver('mcc-shear',400);assert.ok(b.pc<250e3&&b.pc>0&&b.work>0);near(b.q*b.q+1.2**2*b.p*(b.p-b.pc),0,1e-3);
  assert.ok(Math.abs(b.q/(1.2*b.p)-1)<.01);assert.ok(Math.abs(a.q/b.q-1)<.01);
});
test('DP-Cap hydrostatic compression returns to its hardening elliptical cap',()=>{
  const x=driver('cap');near(x.pa,20e6+500e6*x.plasticVolume);near(x.p,x.pa+2*(5e6+Math.tan(Math.PI/6)*x.pa));assert.ok(x.work>0&&x.plasticVolume>0);
});
test('Perzyna implicit update satisfies its overstress flow equation and plane stress',()=>{
  const x=driver('perzyna');near(x.ep,Math.max(0,(x.q-(200e6+1e9*x.ep))/200e6)**2);assert.ok(x.q>200e6+1e9*x.ep);assert.ok(x.work>0);assert.ok(Math.abs(x.szz)<1);
});
test('orthotropic reciprocal compliance, material orientation and plane stress are consistent',()=>{
  const x=driver('orthotropic');near(x.sx,10e6);assert.ok(Math.abs(x.sy)<1&&Math.abs(x.sz)<1&&Math.abs(x.szz)<1);assert.ok(x.rotationError<1e-12);
});
test('HJC compaction, unloading and damage are irreversible',()=>{
  const x=driver('hjc');assert.ok(x.pressure>16e6&&x.pressure<800e6);assert.ok(x.damage>0&&x.damage<=1&&x.work>0);assert.ok(x.plasticVolume>0);assert.ok(x.unloadPressure<x.pressure);assert.ok(x.unloadDamage>=x.damage);near(x.unloadPlasticVolume,x.plasticVolume);near(x.holdDamageChange,0);near(x.holdWorkChange,0);near(x.holdPressureChange,0);
});
for(let law=4;law<=14;law++)test(`law ${law}: SI card roundtrip, settings and SOLID1 field order`,()=>{
  const card=solidCard(law),group=Cards.groups[law],settings={rockModel:law,...solidSettings(law)};
  assert.deepEqual(Cards.normalize(JSON.parse(JSON.stringify(card))),card);assert.equal(Settings.normalize(settings).rockModel,law);
  assert.equal(Cards.validate({blastConstitutive:card},settings).model,law);
  const row=Cards.rows({materials:[{materialNo:9,blastConstitutive:card}]},settings).trim().split(/\s+/),at=row.indexOf('SOLID1');assert.ok(at>0);assert.deepEqual(row.slice(at+1).map(Number),Cards.fields[group].map(([k])=>card[group][k]));
  const bad=structuredClone(card);delete bad[group][Cards.fields[group][0][0]];assert.throws(()=>Cards.validate({blastConstitutive:bad},settings));bad[group][Cards.fields[group][0][0]]=Infinity;assert.throws(()=>Cards.normalize(bad));
});
test('invalid Prony fractions, anisotropic compliance and mode mismatches fail before spawning',()=>{
  const p=solidCard(7);p.maxwell.g1=.9;assert.throws(()=>Cards.validate({blastConstitutive:p},{}));
  const o=solidCard(12);o.orthotropic.nu12=10;assert.throws(()=>Cards.validate({blastConstitutive:o},{}));
  for(const law of [8,13])assert.throws(()=>Cards.validate({blastConstitutive:solidCard(law)},{}),/有限变形/);
  for(const law of [7,9,12])assert.throws(()=>Cards.validate({blastConstitutive:solidCard(law)},{kinematics:1}),/小变形/);
  for(const law of [15,1.5,'4'])assert.throws(()=>Cards.normalize({law}));
});
test('extended solid frames and CSV retain temperature, hardening pressure and compaction in SI units',()=>{
  const Codec=require('../blast-frame-codec'),Export=require('../result-export'),{blastRing}=require('./helpers/blast-ring'),m=blastRing({sectors:8,rings:1}),meta={nodeCount:m.nodes.length,elementCount:m.elements.length,frameScalarCount:20,cellScalarCount:14};
  const bytes=new Float64Array(Codec.frameBytes(meta)/8),start=20+4*meta.nodeCount;bytes[start+10]=350;bytes[start+11]=5e6;bytes[start+12]=.02;bytes[start+13]=.05;
  const frame=Codec.decode(bytes,meta,true);assert.equal(frame.elements[0][10],350);assert.equal(frame.elements[0][13],.05);
  const data=Export.blastData(m,frame,frame),e=data.elements[0];assert.equal(e.temperature,350);assert.equal(e.hardeningPressure,5e6);assert.equal(e.plasticVolumeStrain,.02);
  const csv=Export.tables(data)[1].text;assert.match(csv,/temperature \[K\]/);assert.match(csv,/hardeningPressure \[Pa\]/);assert.match(csv,/maximumCompression \[1\]/);
});
