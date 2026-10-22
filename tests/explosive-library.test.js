const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
const Library=require("../explosive-library"),Settings=require("../blast-settings"),presets=require("../explosives/library.json");
const {createExplosiveStore}=require("../explosive-store");
test("PETN and TNT preserve original JWL units, specific energy and reference CJ pressure",()=>{
  const records=Library.normalize(presets).explosives;
  const petn=records.find(e=>e.id==="petn-thesis-section43"),tnt=records.find(e=>e.id==="tnt-user-parameter-image");
  assert.equal(petn.settings.jwlA,586e9);assert.equal(petn.settings.jwlB,21.6e9);
  assert.ok(Math.abs(petn.settings.productEnergy*1320/7.38e9-1)<1e-15);
  assert.equal(tnt.settings.jwlA,3.7377e8*1000);assert.equal(tnt.settings.jwlB,3.7471e6*1000);
  assert.ok(Math.abs(tnt.settings.productEnergy*1620/7e9-1)<1e-15);assert.equal(tnt.cjPressure,21e9);
  const current=Settings.normalize({x:.15,y:.1,radius:.008,chargeRadius:.005,duration:.0002,dt:1e-8,confineX:20e6,airDensity:1.25,gasCells:384});
  const applied=Library.apply(current,tnt);
  for(const key of Object.keys(current).filter(k=>!Library.fields.includes(k) && k!=="sourceMode"))assert.equal(applied[key],current[key],key);
  assert.equal(applied.sourceMode,1);assert.equal(applied.productEOS,1);assert.equal(applied.pressure,current.pressure);
});
test("explosive storage persists edits across reopening, rejects stale concurrent writes and leaves invalid data untouched",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"fem-explosive-test-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,"library.json");await fs.writeFile(file,JSON.stringify(presets));
  const store=createExplosiveStore(directory),original=await store.read(),updated=structuredClone(original);
  updated.explosives.push({...structuredClone(original.explosives[0]),id:"custom-test",name:"Custom PETN"});
  const saved=await store.save(updated);assert.equal(saved.revision,original.revision+1);
  assert.deepEqual(await createExplosiveStore(directory).read(),saved);
  await assert.rejects(store.save(updated),/changed in another window/);
  const invalid=structuredClone(saved);invalid.explosives[0].settings.productDensity=0;
  await assert.rejects(store.save(invalid));assert.deepEqual(await store.read(),saved);
  const duplicate=structuredClone(saved);duplicate.explosives.push(duplicate.explosives[0]);await assert.rejects(store.save(duplicate),/Duplicate/);
  const a=structuredClone(saved),b=structuredClone(saved);a.explosives[0].name="First writer";b.explosives[0].name="Second writer";
  const concurrent=await Promise.allSettled([store.save(a),store.save(b)]);
  assert.equal(concurrent.filter(r=>r.status==="fulfilled").length,1);assert.equal((await store.read()).explosives[0].name,"First writer");
});
test("selecting a preset fills source controls while model snapshots survive a library change",async()=>{
  const elements=new Map();function element(id){if(!elements.has(id))elements.set(id,{value:"",textContent:"",disabled:false,append(){},replaceChildren(){}});return elements.get(id);}
  const api=vm.createContext({ExplosiveLibrary:Library,BlastSettings:Settings,scene:{blastSettings:Settings.normalize({radius:.008,chargeRadius:.005})},
    document:{getElementById:element,createElement:()=>({}),querySelectorAll:()=>[]},syncBlastSourceControls(){}});
  const dynamics=await fs.readFile(path.join(__dirname,"../src/core/blast-dynamics.js"),"utf8");
  vm.runInContext(dynamics,api);
  vm.runInContext(await fs.readFile(path.join(__dirname,"../src/core/explosive-library-ui.js"),"utf8"),api);
  api.loaded=presets;vm.runInContext("explosiveLibraryPayload=loaded;",api);
  element("blastX").value="0.17";element("blastAirDensity").value="1.25";element("blastDt").value=".05";
  api.applyExplosiveRecord("tnt-user-parameter-image");
  assert.equal(element("blastProductEnergy").value,String(7e9/1620/1e6));assert.equal(element("blastJwlA").value,"373.77");
  assert.equal(element("blastX").value,"0.17");assert.equal(element("blastAirDensity").value,"1.25");assert.equal(element("blastDt").value,".05");
  assert.equal(api.scene.blastSettings.productDensity,1620);
  vm.runInContext("explosiveLibraryPayload={version:1,revision:1,explosives:[]};syncExplosiveLibrarySelection();",api);
  assert.equal(api.scene.blastSettings.productDensity,1620);
});
