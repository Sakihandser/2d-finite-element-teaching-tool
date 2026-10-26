const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Cards=require('../blast-materials'),{solidCard,solidSettings}=require('./helpers/solid-cards');
function harness(law){
  class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.value='';this.listeners={};}append(...children){this.children.push(...children);}replaceChildren(){this.children=[];}setAttribute(k,v){this[k]=v;}addEventListener(k,fn){this.listeners[k]=fn;}all(){return [this,...this.children.flatMap(c=>c.all())];}}
  const elements=Object.fromEntries(['blastRockCards','blastRockModel','blastRockHelp','blastKinematics','blastPlaneMode','saveBlastRockCards'].map(k=>[k,new Element('div')]));elements.blastRockModel.value=String(law);
  const document={getElementById:id=>elements[id],createElement:tag=>new Element(tag),querySelectorAll:selector=>{
    const all=elements.blastRockCards.all();return selector==='[data-rock-field]'?all.filter(x=>x.dataset.rockField):[];
  }};
  const card=solidCard(law),material={id:'M1',name:'test',elasticModulus:210,poissonRatio:.3,density:7800,blastConstitutive:card};
  const context=vm.createContext({document,structuredClone,BlastMaterials:Cards,materialLibrary:[material],scene:{regions:[{materialId:'M1',material}]},
    blastStrengthMaterials:()=>context.scene.regions.map(r=>r.material),syncBlastFractureControls:()=>{},syncRegionMaterialSnapshots:()=>{},
    setRegionMaterialData:(r,m)=>{r.material=m;},saveMaterialLibrary:async()=>{context.saved=structuredClone(context.materialLibrary);}
  });vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/core/blast-rock-ui.js'),'utf8'),context);context.initializeBlastRockControls();context.syncBlastRockControls(true);
  return {context,elements,inputs:()=>document.querySelectorAll('[data-rock-field]')};
}
test('changing global models retains incomplete drafts with SI conversions',()=>{
  const h=harness(5),{context:c,elements:e}=h;c.scene.regions[0].material.blastConstitutive={law:-1};c.syncBlastRockControls(true);
  h.inputs().find(x=>x.dataset.rockField==='jc.A').value='210';h.inputs().find(x=>x.dataset.rockField==='jc.B').value='400';
  e.blastRockModel.value='7';e.blastRockModel.listeners.change();e.blastRockModel.value='5';e.blastRockModel.listeners.change();
  assert.equal(h.inputs().find(x=>x.dataset.rockField==='jc.A').value,'210');assert.equal(h.inputs().find(x=>x.dataset.rockField==='jc.B').value,'400');
});
test('preview input redraw and a language redraw preserve unsaved field values',()=>{
  const h=harness(5),{context:c,elements:e}=h;c.scene.regions[0].material.blastConstitutive={law:-1};c.syncBlastRockControls(true);
  const input=h.inputs().find(x=>x.dataset.rockField==='jc.A');input.value='210';input.listeners.input();c.syncBlastRockControls();
  assert.equal(h.inputs().find(x=>x.dataset.rockField==='jc.A').value,'210');
  e.blastRockModel.value='7';e.blastRockModel.listeners.input();c.syncBlastRockControls();e.blastRockModel.listeners.change();
  e.blastRockModel.value='5';e.blastRockModel.listeners.input();c.syncBlastRockControls();e.blastRockModel.listeners.change();
  assert.equal(h.inputs().find(x=>x.dataset.rockField==='jc.A').value,'210');
});
for(let law=4;law<=14;law++)test(`law ${law}: UI renders every field in its display unit and saves the card to region/library`,async()=>{
  const h=harness(law),{context:c}=h,group=Cards.groups[law],card=solidCard(law);assert.equal(h.inputs().length,Cards.fields[group].length);
  for(const [key,,scale] of Cards.fields[group])assert.equal(Number(h.inputs().find(x=>x.dataset.rockField===`${group}.${key}`).value),card[group][key]/scale);
  // Change a value without touching unrelated fields, then use the actual Save path.
  const key=law===7?'tau1':law===12?'angle':Cards.fields[group][0][0],input=h.inputs().find(x=>x.dataset.rockField===`${group}.${key}`),next=Number(input.value)*1.01;input.value=String(next);
  await c.saveBlastRockCards({rockModel:1,...solidSettings(law)});
  const saved=c.saved[0].blastConstitutive;assert.equal(saved.law,law);assert.equal(saved[group][key],next*Number(input.dataset.rockScale));assert.equal(c.scene.regions[0].material.blastConstitutive[group][key],saved[group][key]);
});
test('new global model IDs survive initial option population and scene restore order',()=>{
  const h=harness(14);h.context.populateBlastRockModelOptions();assert.equal(h.elements.blastRockModel.children.length,15);
  const source=fs.readFileSync(path.join(__dirname,'../src/core/blast-dynamics.js'),'utf8'),start=source.indexOf('function initializeBlastControls()');assert.ok(source.indexOf('populateBlastRockModelOptions();',start)<source.indexOf('restoreBlastControls();',start));
});
