// Editable material cards are kept as drafts until Save / Run succeeds.
const blastRockDrafts=new Map();let blastRockControlKey='';
function rememberBlastRockInput(input){
  const id=input.dataset.rockMaterial,material=blastStrengthMaterials().find(m=>m.id===id);
  const draft=blastRockDrafts.get(id)||{card:structuredClone(material?.blastConstitutive||{law:-1})};
  const [group,key]=input.dataset.rockField.split('.'),value=input.value.trim()===''?null:Number(input.value)*Number(input.dataset.rockScale||1);
  if(group==='strength')draft[key]=value;else {(draft.card[group]||={})[key]=value;}
  blastRockDrafts.set(id,draft);
  if(typeof syncBlastCompatibility==='function')syncBlastCompatibility();
}
function readBlastRockDrafts(){
  for(const input of document.querySelectorAll('[data-rock-field]'))rememberBlastRockInput(input);
}
function syncBlastRockControls(force=false){
  const host=document.getElementById('blastRockCards');if(!host)return;
  const selected=Number(document.getElementById('blastRockModel').value),materials=blastStrengthMaterials();
  const key=JSON.stringify([selected,materials.map(m=>[m.id,m.blastConstitutive,m.tensileStrength,m.compressiveStrength]),[...blastRockDrafts]]);
  if(!force && key===blastRockControlKey)return;blastRockControlKey=key;host.replaceChildren();
  document.getElementById('blastRockHelp').textContent=BlastMaterials.help[selected];
  for(const material of materials){
    const draft=blastRockDrafts.get(material.id),card=draft?.card||material.blastConstitutive||{law:-1};
    const law=card.law>=0?card.law:selected,details=document.createElement('details');details.className='blast-boundary-details';details.open=law>=2;
    const summary=document.createElement('summary');summary.textContent=`${material.name} · ${BlastMaterials.names[law]}`;details.append(summary);
    const select=document.createElement('select');select.setAttribute('aria-label',`${material.name} 本构`);select.dataset.rockLaw='';select.dataset.rockMaterial=material.id;
    for(const [value,label] of [[-1,'随全局本构'],...BlastMaterials.names.map((n,i)=>[i,n])]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
    select.value=card.law??-1;select.addEventListener('change',()=>{readBlastRockDrafts();const current=blastRockDrafts.get(material.id)||{card:structuredClone(card)};current.card.law=Number(select.value);blastRockDrafts.set(material.id,current);syncBlastRockControls(true);if(typeof syncBlastCompatibility==='function')syncBlastCompatibility(true);});details.append(select);
    const grid=document.createElement('div');grid.className='blast-form-grid';
    function number(group,key,label,scale,value){const field=document.createElement('label');field.className='number-field calculation-field';const text=document.createElement('span');text.textContent=label;const input=document.createElement('input');input.type='number';input.step='any';input.dataset.rockField=`${group}.${key}`;input.dataset.rockMaterial=material.id;input.dataset.rockScale=scale;input.value=value===undefined||value===null?'':String(value/scale);input.addEventListener('input',()=>rememberBlastRockInput(input));field.append(text,input);grid.append(field);}
    if(law===2 || (law===0 && selected!==0)){
      const borrowedT=law===2 && material.blastConstitutive?.law!==2 &&
        material.blastConstitutive?.jh2?.T===material.tensileStrength*1e6;
      const strength=draft && Object.hasOwn(draft,'tensileStrength') ? draft.tensileStrength : borrowedT ? undefined : material.tensileStrength*1e6;
      number('strength','tensileStrength','单轴抗拉强度 (MPa)',1e6,strength);
    }
    if(law===2){number('strength','compressiveStrength','单轴抗压强度 (MPa)',1e6,draft?.compressiveStrength??material.compressiveStrength*1e6);for(const [k,label,scale] of BlastMaterials.fields.dp)number('dp',k,label,scale,card.dp?.[k]);}
    if(law===3){
      for(const [k,label,scale] of BlastMaterials.fields.jh2)number('jh2',k,label,scale,card.jh2?.[k]);
      const note=document.createElement('p');note.className='blast-note';note.textContent='归一化应力可直接填写 σHEL；填 0 时按 σHEL = 1.5 × (HEL − pHEL) 换算。EOS K1 控制初始体积刚度；β 和参考长度须独立标定。';details.append(note);

    }
    if(law>=4){
      const group=BlastMaterials.groups[law];
      for(const [k,label,scale] of BlastMaterials.fields[group])number(group,k,label,scale,card[group]?.[k]??(law===7?0:undefined));
      const note=document.createElement('p');note.className='blast-note';note.textContent=BlastMaterials.help[law];details.append(note);
    }
    details.append(grid);host.append(details);
  }
  if(typeof syncBlastCompatibility==='function')syncBlastCompatibility();
}
async function saveBlastRockCards(settings=readBlastControls()){
  readBlastRockDrafts();const previous=materialLibrary;const changes=new Map();
  const oldStrengths=new Map([...document.querySelectorAll('[data-blast-strength-material]')].map(input=>[input.dataset.blastStrengthMaterial,Number(input.value)]));
  for(const m of blastStrengthMaterials()){
    const draft=blastRockDrafts.get(m.id),card=BlastMaterials.normalize(draft?.card||m.blastConstitutive),next={...m,blastConstitutive:card};
    if(draft?.tensileStrength!==undefined)next.tensileStrength=draft.tensileStrength/1e6;
    if(draft?.compressiveStrength!==undefined)next.compressiveStrength=draft.compressiveStrength/1e6;
    const law=BlastMaterials.law(next,settings);
    if(settings.rockModel===0 && law===0 && oldStrengths.has(m.id))next.tensileStrength=oldStrengths.get(m.id);
    if(settings.fracture && law===0 && !(next.tensileStrength>0))throw new Error(`${m.name}：请填写实测单轴抗拉强度。`);
    BlastMaterials.validate({...next,tensileStrength:next.tensileStrength*1e6,compressiveStrength:next.compressiveStrength*1e6},settings);
    if(JSON.stringify(next)!==JSON.stringify(m))changes.set(m.id,next);
  }
  if(changes.size){const merged=new Map(materialLibrary.map(m=>[m.id,m]));for(const [id,m] of changes)merged.set(id,{...m,updatedAt:new Date().toISOString()});materialLibrary=[...merged.values()];
    try{await saveMaterialLibrary();}catch(error){materialLibrary=previous;throw error;}
    for(const region of scene.regions||[])if(changes.has(region.materialId))setRegionMaterialData(region,changes.get(region.materialId));
    syncRegionMaterialSnapshots();
  }
  blastRockDrafts.clear();syncBlastFractureControls(true);syncBlastRockControls(true);
}
function populateBlastRockModelOptions(){
  const globalSelect=document.getElementById('blastRockModel');globalSelect.replaceChildren();
  for(const [value,label] of BlastMaterials.names.entries()){const option=document.createElement('option');option.value=value;option.textContent=label;globalSelect.append(option);}
}
function initializeBlastRockControls(){
  // The TNT preview listens to input and redraws before change. Capture the
  // outgoing fields before that redraw replaces the previous model's controls.
  document.getElementById('blastRockModel').addEventListener('input',readBlastRockDrafts);
  document.getElementById('blastRockModel').addEventListener('change',()=>{readBlastRockDrafts();scene.blastSettings={...scene.blastSettings,rockModel:Number(document.getElementById('blastRockModel').value)};syncBlastFractureControls(true);syncBlastRockControls(true);});
  document.getElementById('saveBlastRockCards').addEventListener('click',async()=>{
    const button=document.getElementById('saveBlastRockCards'),status=document.getElementById('blastRockStatus');button.disabled=true;status.textContent='正在保存本构参数…';
    try{await saveBlastRockCards();status.textContent='本构参数已保存。';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  });
}
