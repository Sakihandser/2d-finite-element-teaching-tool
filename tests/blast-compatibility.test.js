const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Settings=require('../blast-settings'),Cards=require('../blast-materials'),GasEOS=require('../gas-eos'),{solidCard}=require('./helpers/solid-cards');
function harness(input={},materials=[]){
  class Element{
    constructor(){this.value='';this.checked=false;this.textContent='';this.hidden=false;this.disabled=false;this.open=false;this.shows=0;this.dataset={};this.children=[];this.listeners={};this.classList={toggle(){}};}
    append(...x){this.children.push(...x);}replaceChildren(){this.children=[];}addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}showModal(){this.open=true;this.shows++;}close(){this.open=false;}
  }
  const elements=new Map(),element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const c=vm.createContext({console,structuredClone,BlastSettings:Settings,BlastMaterials:Cards,GasEOS,calculationWorkflowRunning:false,
    scene:{blastSettings:Settings.normalize({}),regions:[],pointLoads:[],distributedLoads:[],bodyLoads:[]},blastStrengthMaterials:()=>materials,
    document:{getElementById:element,createElement:()=>new Element(),querySelectorAll:()=>[]},syncRegionMaterialSnapshots(){},setRegionMaterialData(){},syncBlastFractureControls(){}});
  for(const f of ['src/core/blast-dynamics.js','src/core/blast-rock-ui.js','src/core/blast-compatibility-ui.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),c);
  c.saved={...Settings.defaults,...input};vm.runInContext(`for(const [key,[id,scale]] of Object.entries(BLAST_FIELDS))document.getElementById(id).value=String(saved[key]/scale);document.getElementById('blastFracture').checked=saved.fracture;`,c);
  c.initializeBlastCompatibility();return {c,element};
}
test('plane stress plus hyperelasticity immediately opens a warning, blocks Run and clears after both conditions are corrected',()=>{
  const h=harness({rockModel:8,planeMode:0,kinematics:0});const r=h.c.syncBlastCompatibility(true);assert.equal(r.errors.length,2);assert.match(h.element('blastCompatibilityMessages').textContent,/平面应力/);assert.ok(h.element('startBlast').disabled);assert.ok(h.element('blastCompatibilityDialog').open);
  h.c.syncBlastCompatibility(true);assert.equal(h.element('blastCompatibilityDialog').shows,1);
  h.element('blastPlaneMode').value='1';h.c.syncBlastCompatibility();assert.ok(h.element('startBlast').disabled);
  h.element('blastKinematics').value='1';h.c.syncBlastCompatibility();assert.equal(h.element('startBlast').disabled,false);assert.equal(h.element('blastCompatibilityDialog').open,false);assert.equal(h.element('blastCompatibility').hidden,true);
});
test('changing the 2D assumption warns without silently changing the user selection',()=>{
  const h=harness({rockModel:8,planeMode:1,kinematics:1});h.element('blastPlaneMode').value='0';for(const fn of h.element('blastPlaneMode').listeners.change)fn();
  assert.equal(h.element('blastPlaneMode').value,'0');assert.ok(h.element('blastCompatibilityDialog').open);assert.ok(h.element('startBlast').disabled);
});
test('effective per-material overrides and unsaved law drafts participate in compatibility checks',()=>{
  const material={id:'rubber',name:'rubber',blastConstitutive:solidCard(8)},h=harness({rockModel:1},[material]);assert.ok(h.c.syncBlastCompatibility().errors.some(x=>x.includes('rubber')));
  vm.runInContext(`blastRockDrafts.set('rubber',{card:{law:1}});`,h.c);assert.equal(h.c.syncBlastCompatibility().errors.length,0);
});
for(const law of [7,9,12])test(`small-deformation-only law ${law} blocks finite deformation`,()=>{
  const h=harness({rockModel:law,kinematics:1,planeMode:1});assert.ok(h.c.syncBlastCompatibility().errors.some(x=>x.includes('小变形')));assert.ok(h.element('startBlast').disabled);
});
test('MCC initial compression and unsupported HJC/hyperelastic preloads are reported before mesh generation',()=>{
  const h=harness({rockModel:9});assert.ok(h.c.syncBlastCompatibility().errors.some(x=>x.includes('初始压缩')));
  h.element('blastLoadMode').value='1';assert.ok(h.c.syncBlastCompatibility().errors.some(x=>x.includes('突然加载')));
  h.element('blastLoadMode').value='0';h.element('blastConfineX').value='1';assert.equal(h.c.syncBlastCompatibility().errors.length,0);assert.ok(h.c.syncBlastCompatibility().warnings.length>0);
  h.element('blastRockModel').value='14';assert.ok(h.c.syncBlastCompatibility().errors.some(x=>x.includes('预载')));
});
test('nonideal gas bounds, sealed-end restriction and correcting values update the Run state immediately',()=>{
  const h=harness({sourceMode:1,productEOS:3,productDensity:10,productCovolume:.01});assert.equal(h.c.syncBlastCompatibility().errors.length,0);
  h.element('blastProductCovolume').value='.2';for(const fn of h.element('blastProductCovolume').listeners.input)fn();assert.ok(h.element('startBlast').disabled);assert.match(h.element('blastCompatibilityMessages').textContent,/bρ/);
  h.element('blastProductCovolume').value='.01';h.element('blastVentEnds').value='1';for(const fn of h.element('blastVentEnds').listeners.change)fn();assert.match(h.element('blastCompatibilityDialogText').textContent,/两端封堵/);
  h.element('blastVentEnds').value='0';h.c.syncBlastCompatibility();assert.equal(h.element('startBlast').disabled,false);
});
test('a valid configuration cannot re-enable Run during an active solve',()=>{
  const h=harness({rockModel:1});h.c.calculationWorkflowRunning=true;h.c.syncBlastCompatibility();assert.ok(h.element('startBlast').disabled);h.c.calculationWorkflowRunning=false;h.c.syncBlastCompatibility();assert.equal(h.element('startBlast').disabled,false);
});
test('raw controls report restrictions before strict settings normalization can throw',()=>{
  const h=harness({rockModel:13,kinematics:1,planeMode:0});assert.throws(()=>Settings.normalize({kinematics:1,planeMode:0}));assert.doesNotThrow(()=>h.c.syncBlastCompatibility(true));assert.match(h.element('blastCompatibilityDialogText').textContent,/平面应力/);
});
