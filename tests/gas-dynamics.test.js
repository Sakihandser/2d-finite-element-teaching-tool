const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const {runBlastCore}=require("../server"),{blastRing}=require("./helpers/blast-ring");
const Settings=require("../blast-settings"),Codec=require("../blast-frame-codec");
const root=path.resolve(__dirname,".."),executable=path.join(__dirname,"native/x64/Release/gas-verification.exe");
test.before(()=>{
  const inputs=["tests/native/GasVerification.cpp","tests/native/GasVerification.vcxproj","计算力学程序计算核心/GasDynamics.cpp","计算力学程序计算核心/GasDynamics.h","计算力学程序计算核心/GasConstitutive.h"].map(file=>path.join(root,file));
  if(fs.existsSync(executable) && inputs.every(file=>fs.statSync(file).mtimeMs<=fs.statSync(executable).mtimeMs))return;
  const msbuild=path.join(process.env.ProgramFiles || "C:/Program Files","Microsoft Visual Studio/2022/Community/MSBuild/Current/Bin/MSBuild.exe");
  const result=spawnSync(msbuild,["tests/native/GasVerification.vcxproj","/p:Configuration=Release","/p:Platform=x64","/v:minimal","/nologo"],{cwd:root,encoding:"utf8",windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
function verify(mode,cells=200,time=.2){
  const result=spawnSync(executable,[mode,String(cells),String(time)],{encoding:"utf8",windowsHide:true,timeout:20000});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
function balance(h){return (h.internalEnergy+h.kineticEnergy+h.wallWork-h.initialEnergy)/h.initialEnergy;}
function sodDensity(x,time=.2){
  const gamma=1.4,left={rho:1,p:1},right={rho:.125,p:.1},alpha=(gamma-1)/(gamma+1);
  const cL=Math.sqrt(gamma),cR=Math.sqrt(gamma*right.p/right.rho);
  const f=(p,state)=>p>state.p ? (p-state.p)*Math.sqrt(2/((gamma+1)*state.rho)/(p+alpha*state.p))
    : 2*Math.sqrt(gamma*state.p/state.rho)/(gamma-1)*(Math.pow(p/state.p,(gamma-1)/(2*gamma))-1);
  let lo=1e-12,hi=1;
  for(let i=0;i<80;i++){const mid=(lo+hi)/2;if(f(mid,left)+f(mid,right)>0)hi=mid;else lo=mid;}
  const p=(lo+hi)/2,u=.5*(f(p,right)-f(p,left)),xi=(x-.5)/time;
  if(xi<u){
    if(xi<=-cL)return left.rho;
    const tail=u-cL*Math.pow(p/left.p,(gamma-1)/(2*gamma));
    if(xi>=tail)return left.rho*Math.pow(p/left.p,1/gamma);
    const sound=2/(gamma+1)*(cL-(gamma-1)*xi/2);return left.rho*Math.pow(sound/cL,2/(gamma-1));
  }
  const shock=cR*Math.sqrt((gamma+1)/(2*gamma)*p/right.p+(gamma-1)/(2*gamma));
  return xi>shock ? right.rho : right.rho*(p/right.p+alpha)/(alpha*p/right.p+1);
}
test("Sod shock tube converges toward the exact Riemann solution and conserves total energy",()=>{
  const errors=[];
  for(const n of [100,200,400]){
    const h=verify("sod",n);errors.push(h.cells.reduce((sum,[x,rho,,,width])=>sum+Math.abs(rho-sodDensity(x))*width,0));
    assert.ok(Math.abs(balance(h))<1e-10);
  }
  assert.ok(errors[1]<errors[0] && errors[2]<errors[1],`density L1 errors: ${errors}`);
  assert.ok(errors[2]<.02,`fine-grid density L1 error: ${errors[2]}`);
});
test("stationary pressure-equilibrium material contacts do not launch a spurious wave",()=>{
  const h=verify("contact");assert.equal(h.kineticEnergy,0);
  assert.ok(h.cells.every(cell=>cell[2]===1 && cell[3]===0));assert.equal(balance(h),0);
});
test("moving cylindrical wall work balances internal plus kinetic gas energy",()=>{
  const h=verify("moving");assert.ok(h.wallWork<0);assert.ok(h.internalEnergy>h.initialEnergy);
  assert.ok(Math.abs(balance(h))<1e-10);
});
test("JWL pressure and adiabatic sound speed agree with the reference form and thermodynamic derivative",()=>{
  const h=verify("eos"),rho=.7,e=100,x=1/rho;
  const a=20*Math.exp(-4.5*x),b=3*Math.exp(-1.1*x),expected=a+b+.3*rho*(e-a/4.5-b/1.1);
  assert.ok(Math.abs(h.pressure-expected)<1e-12);
  assert.ok(Math.abs(h.c2-h.finiteDifference)/h.c2<1e-7);
});
test('strong non-vacuum expansion uses the exact ideal-gas pressure relation instead of a pressure floor',()=>{
 const h=verify('expansion'),expected=.4*Math.pow(1-.4*4/(4*Math.sqrt(.56)),7);assert.equal(h.fallback,true);assert.ok(h.pressure>0);assert.ok(Math.abs(h.pressure/expected-1)<1e-12);assert.ok(Math.abs(h.velocity)<1e-12);
 const r=spawnSync(executable,['vacuum'],{encoding:'utf8',windowsHide:true});assert.notEqual(r.status,0);assert.match(r.stderr,/Physical vacuum/);
});
test('open axial ends match analytic adiabatic tank blowdown and account for escaping energy and mass',()=>{
 const t=.00002,h=verify('axial',64,t),gamma=1.4,c0=Math.sqrt(1.4*.4*2.5e6),k=2/.05*c0*(2/(gamma+1))**((gamma+1)/(2*(gamma-1))),ratio=(1+(gamma-1)/2*k*t)**(-2/(gamma-1));
 assert.ok(Math.abs(h.productMass/(10*Math.PI)-ratio)<2e-4);assert.ok(Math.abs(h.wallPressure/(.4*10*2.5e6)-ratio**gamma)<2e-4);
 assert.ok(Math.abs(h.productMass+h.ventedMass-10*Math.PI)<1e-10);assert.ok(Math.abs(h.internalEnergy+h.kineticEnergy+h.wallWork+h.ventedEnergy-h.initialEnergy)/h.initialEnergy<1e-12);
});
const model=blastRing({sectors:24,rings:4});
const gas={sourceMode:1,chargeRadius:.05,gasCells:64,fracture:false,frames:11,duration:.0001};
test("air-gap pressure reaches the rock after a delay, with positive gas states and matched wall work",async()=>{
  const h=await runBlastCore(model,gas);assert.equal(h.sourceMode,1);assert.equal(h.frameScalarCount,12);
  assert.ok(h.frames[1].pressure<h.settings.airPressure*1.01,"pressure is not imposed instantaneously at the wall");
  assert.ok(h.frames.some(frame=>frame.pressure>h.settings.airPressure*10));
  for(const frame of h.frames){
    assert.ok(frame.gasInternalEnergy>0 && frame.gasKineticEnergy>=0);
    assert.ok(Math.abs(frame.gasInternalEnergy+frame.gasKineticEnergy+frame.gasWallWork-h.initialGasEnergy)/h.initialGasEnergy<1e-8);
    assert.ok(Math.abs(frame.gasWallWork-frame.externalWork)/Math.max(1,Math.abs(frame.gasWallWork))<1e-7);
  }
  assert.ok(h.frames.at(-1).gasWallRadius>.1);assert.ok(h.frames.at(-1).u.some(value=>Math.abs(value)>1e-8));
});
test("gas mode derives pressure from material state and ignores manual pulse peak/duration",async()=>{
  const a=await runBlastCore(model,{...gas,pressure:1,pulse:1e-6});
  const b=await runBlastCore(model,{...gas,pressure:1e10,pulse:.01});
  assert.deepEqual(a.frames.map(frame=>frame.pressure),b.frames.map(frame=>frame.pressure));
  assert.deepEqual(a.frames.at(-1).u,b.frames.at(-1).u);
});
test("equal initial gas/product pressure remains quiet after rock pre-equilibration",async()=>{
  const h=await runBlastCore(model,{...gas,productDensity:1.2,productEnergy:101325/(.3*1.2)});
  const initial=h.frames[0].u;
  for(const frame of h.frames){
    assert.ok(Math.abs(frame.pressure-101325)<.01);
    assert.ok(frame.u.every((value,i)=>Math.abs(value-initial[i])<1e-10));
  }
});
test("calibrated-coefficient JWL mode runs and invalid gas/EOS inputs fail explicitly",async()=>{
  const h=await runBlastCore(model,{...gas,productEOS:1,jwlA:1e8,jwlB:1e7});
  assert.ok(h.frames.at(-1).pressure>0);
  for(const invalid of [{gasCells:15},{airDensity:0},{airGamma:1},{productEnergy:0},{productEOS:1},{sourceMode:2}])
    assert.throws(()=>Settings.normalize({...gas,...invalid}));
});
test("extended gas frames preserve typed offsets, reject non-finite extras and retain legacy layouts",()=>{
  const metadata={nodeCount:3,elementCount:1,frameScalarCount:12};
  const values=new Float64Array(Codec.frameBytes(metadata)/8);values.forEach((_,i)=>{values[i]=i+1;});
  const frame=Codec.decode(values,metadata);
  assert.equal(frame.gasInternalEnergy,9);assert.equal(frame.u[0],13);assert.equal(frame.v[0],19);assert.equal(frame.elements[0][0],25);
  assert.equal(Codec.summary(new Uint8Array(values.buffer),metadata).gasWallRadius,12);
  values[9]=NaN;assert.throws(()=>Codec.decode(values,metadata),/Non-finite/);
  assert.equal(Codec.frameBytes({nodeCount:3,elementCount:1}),Codec.frameBytes(metadata)-32);
});


test("common-parameter CJ closure agrees with the matching ideal EOS and responds to detonation speed",async()=>{
  const common=await runBlastCore(model,{...gas,productEOS:2,detonationVelocity:2000});
  const gamma=Math.sqrt(3);
  assert.ok(Math.abs(common.effectiveProductGamma-gamma)<1e-12);
  const ideal=await runBlastCore(model,{...gas,productEOS:0,productGamma:gamma});
  assert.deepEqual(common.frames.map(f=>f.pressure),ideal.frames.map(f=>f.pressure));
  const changed=await runBlastCore(model,{...gas,productEOS:2,detonationVelocity:2500});
  assert.notDeepEqual(changed.frames.map(f=>f.pressure),common.frames.map(f=>f.pressure));
  assert.throws(()=>Settings.normalize({...gas,productEOS:2,detonationVelocity:0}));
  assert.throws(()=>Settings.normalize({...gas,productEOS:2,detonationVelocity:1e8}));
  assert.throws(()=>Settings.normalize({...gas,productEOS:2,detonationVelocity:1e-12}));
});

test("source and EOS controls preserve inactive settings and show only the selected model",()=>{
  const vm=require("node:vm"),elements=new Map(),groups=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{value:"",checked:false});return elements.get(id);};
  for(const kind of ["ideal","jwl","common"])groups.push({dataset:{productEos:kind},hidden:false});
  const source=[{dataset:{blastSourceMode:"gas"}},{dataset:{blastSourceMode:"pressure"}}];
  const api=vm.createContext({BlastSettings:Settings,scene:{blastSettings:{}},document:{getElementById:element,querySelectorAll:selector=>selector==="[data-product-eos]"?groups:source}});
  vm.runInContext(fs.readFileSync(path.join(root,"src/core/blast-dynamics.js"),"utf8"),api);
  vm.runInContext('for(const [key,[id,scale]] of Object.entries(BLAST_FIELDS))document.getElementById(id).value=String(BlastSettings.defaults[key]/scale);',api);
  element("blastSourceMode").value="1";element("blastProductEOS").value="2";
  element("blastJwlA").value="12.5";element("blastPressure").value="22";
  element("blastProductGamma").value="1.6";element("blastDetonationVelocity").value="2500";
  const saved=api.readBlastControls();assert.equal(saved.jwlA,12.5e9);assert.equal(saved.pressure,22e6);assert.equal(saved.productGamma,1.6);
  api.syncBlastSourceControls();assert.deepEqual(groups.map(g=>g.hidden),[true,true,false]);assert.deepEqual(source.map(g=>g.hidden),[false,true]);
  element("blastProductEOS").value="1";api.syncBlastSourceControls();assert.deepEqual(groups.map(g=>g.hidden),[true,false,true]);
  assert.equal(api.readBlastControls().detonationVelocity,2500);
  element("blastProductGamma").value="-1";assert.equal(api.readBlastControls().productEOS,1);
  element("blastProductGamma").value="";assert.equal(api.readBlastControls().productGamma,Settings.defaults.productGamma);
});


test("wall-filling charge loads immediately without allocating a degenerate air annulus",async()=>{
  const h=await runBlastCore(model,{...gas,chargeRadius:.1,duration:1e-5,frames:3});
  assert.ok(Math.abs(h.frames[0].pressure-.3*1000*1e6)<.1);
  assert.ok(h.frames.at(-1).u.some(value=>Math.abs(value)>1e-8));
  assert.ok(h.frames.every(f=>f.gasInternalEnergy>0 && Number.isFinite(f.pressure)));
});

test("compressed air remains tractable over 5 ms while material masses, energy and pressure impulse converge",()=>{
  const histories=[96,192,384].map(cells=>verify("blast",cells,.005));
  for(const h of histories){
    assert.ok(h.rezones>0,"the compressed air annulus exercises conservative remapping");
    assert.ok(h.substeps<1000000,`unnecessarily small gas steps: ${h.substeps}`);
    assert.ok(Math.abs(h.productMass-1000*Math.PI*.05**2)<1e-11);
    assert.ok(Math.abs(h.airMass-1.2*Math.PI*(.1**2-.05**2))<1e-13);
    assert.ok(Math.abs(balance(h))<1e-10);
    assert.ok(h.cells.every(([,rho,p,u,width])=>rho>0 && p>0 && width>0 && Number.isFinite(u)));
  }
  const impulse=histories.map(h=>h.averagePressure*.005);
  assert.ok(Math.abs(impulse[2]-impulse[1])<Math.abs(impulse[1]-impulse[0]),`pressure impulses: ${impulse}`);
  assert.ok(Math.abs(impulse[2]/impulse[1]-1)<.005);
});

test("rezoning conserves wall work for a strongly driven moving wall and supports JWL products",()=>{
  for(const mode of ["blast-moving","blast-jwl"]){
    const h=verify(mode,96,.001);
    assert.ok(h.rezones>0);assert.ok(Math.abs(balance(h))<1e-10);
    assert.ok(Math.abs(h.productMass-1000*Math.PI*.05**2)<1e-11);
    assert.ok(Math.abs(h.airMass-1.2*Math.PI*(.1**2-.05**2))<1e-13);
    assert.ok(h.wallPressure>0);
    if(mode==="blast-moving")assert.ok(h.wallWork>0);
  }
});

test("the 5 ms coupled calculation completes at 0.1 microsecond steps with matched wall work",async t=>{
  const {removeRun}=require("../blast-runner");
  const h=await runBlastCore(model,{...gas,gasCells:192,duration:.005,dt:1e-7,frames:11,boundary:2},{lazy:true});
  t.after(()=>removeRun(h.id));
  assert.equal(h.steps,50000);assert.equal(h.frames.at(-1).time,.005);
  for(const f of h.frames){
    assert.ok(f.pressure>0 && f.gasInternalEnergy>0);
    assert.ok(Math.abs(f.gasInternalEnergy+f.gasKineticEnergy+f.gasWallWork-h.initialGasEnergy)/h.initialGasEnergy<1e-9);
    assert.ok(Math.abs(f.gasWallWork-f.externalWork)/Math.max(1,Math.abs(f.gasWallWork))<1e-7);
  }
});
