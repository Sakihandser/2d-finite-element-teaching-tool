const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
const Gas=require("../gas-library"),Settings=require("../blast-settings"),preset=require("../gases/library.json");
const {createParameterStore}=require("../explosive-store");
test("air polynomial EOS parameters map to the stored ideal gas without overwriting explosive settings",()=>{
  const record=Gas.normalize(preset).gases[0],p=record.settings;
  assert.equal(p.airDensity,1.25);assert.equal(p.airGamma,1.4);assert.equal(p.airPressure,.4*250000);
  const current=Settings.normalize({sourceMode:1,productEOS:1,productDensity:1620,productEnergy:7e9/1620,jwlA:373.77e9,jwlB:3.7471e9,chargeRadius:.005,radius:.008});
  const applied=Gas.apply(current,record);
  for(const key of Object.keys(current).filter(k=>!Gas.fields.includes(k)))assert.equal(applied[key],current[key],key);
});
test("gas records persist independently and failed validation or a stale save preserves the existing file",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"fem-gas-test-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,"library.json"),JSON.stringify(preset));
  const store=createParameterStore(directory,Gas.normalize),original=await store.read(),updated=structuredClone(original);
  updated.gases.push({...structuredClone(updated.gases[0]),id:"custom-gas",name:"Custom gas"});
  const saved=await store.save(updated);assert.deepEqual(await createParameterStore(directory,Gas.normalize).read(),saved);
  await assert.rejects(store.save(updated),/changed in another window/);
  for(const bad of [{airDensity:0},{airPressure:-1},{airGamma:1}]){const invalid=structuredClone(saved);Object.assign(invalid.gases[0].settings,bad);await assert.rejects(store.save(invalid));}
  assert.deepEqual(await store.read(),saved);
});
test("selecting air updates only gas inputs and survives subsequent library deletion through scene snapshots",async()=>{
  const elements=new Map();function element(id){if(!elements.has(id))elements.set(id,{value:"",textContent:"",disabled:false,append(){},replaceChildren(){}});return elements.get(id);}
  const api=vm.createContext({GasLibrary:Gas,BlastSettings:Settings,scene:{blastSettings:Settings.normalize({productDensity:1620})},document:{getElementById:element,createElement:()=>({}),querySelectorAll:()=>[]}});
  vm.runInContext(await fs.readFile(path.join(__dirname,"../src/core/blast-dynamics.js"),"utf8"),api);
  vm.runInContext(await fs.readFile(path.join(__dirname,"../src/core/gas-library-ui.js"),"utf8"),api);
  api.preset=preset;vm.runInContext("gasLibraryPayload=preset;",api);element("blastProductDensity").value="1620";
  api.applyGasRecord("air-user-parameter-image");assert.equal(element("blastAirDensity").value,"1.25");assert.equal(element("blastAirPressure").value,"0.1");
  assert.equal(element("blastProductDensity").value,"1620");assert.equal(api.scene.blastSettings.productDensity,1620);
  vm.runInContext("gasLibraryPayload={version:1,revision:1,gases:[]};syncGasLibrarySelection();",api);
  assert.equal(api.scene.blastSettings.airDensity,1.25);
});
