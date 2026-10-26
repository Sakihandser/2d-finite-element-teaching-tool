// Configuration feedback uses raw controls so invalid combinations can be shown
// before the strict settings normalizer accepts them. No condition is silently changed.
let blastCompatibilityDialogKey='';
function blastCompatibilitySettings(){
  const settings=readBlastControlValues();
  settings.hasExternalLoads=['pointLoads','distributedLoads','bodyLoads'].some(key=>(scene[key]||[]).length>0);
  return settings;
}
function blastCompatibilityReport(settings=blastCompatibilitySettings()){
  const errors=[],warnings=[],materials=blastStrengthMaterials();
  const effective=materials.length?materials:[{name:'默认固体本构',blastConstitutive:{law:settings.rockModel}}];
  for(const m of effective){
    const draft=blastRockDrafts.get(m.id),card=draft?.card||m.blastConstitutive,material={...m,blastConstitutive:card};
    const report=BlastMaterials.compatibility(material,settings),prefix=`${m.name} · ${BlastMaterials.names[report.model]}`;
    for(const message of report.errors)errors.push(`${prefix}：${message}`);
    for(const message of report.warnings)warnings.push(`${prefix}：${message}`);
    if(m.id && !report.errors.length){try{
      const tensileStrength=draft?.tensileStrength??m.tensileStrength*1e6;
      if(settings.fracture&&report.model===0&&!(tensileStrength>0))throw new Error(`${m.name}：请填写实测单轴抗拉强度。`);
      BlastMaterials.validate({...material,tensileStrength,compressiveStrength:(draft?.compressiveStrength??m.compressiveStrength*1e6)},settings);
    }catch(error){errors.push(error.message);}}
  }
  const gas=GasEOS.constraints(settings);
  errors.push(...gas.errors.map(e=>`${e.scope}：${e.message}`));warnings.push(...gas.warnings);
  if(!errors.length)try{BlastSettings.normalize(settings);}catch(error){errors.push(error.message);}
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}
function syncBlastCompatibility(showDialog=false){
  const host=document.getElementById('blastCompatibility');if(!host)return {errors:[],warnings:[]};
  const report=blastCompatibilityReport(),blocked=report.errors.length>0;
  host.hidden=!blocked&&!report.warnings.length;host.classList.toggle('blast-compatibility-error',blocked);
  const title=document.getElementById('blastCompatibilityTitle'),body=document.getElementById('blastCompatibilityMessages');
  title.textContent=blocked?'当前设置无法计算，请修改条件或本构。':'本构适用条件';body.textContent=[...report.errors,...report.warnings].join('\n');
  const button=document.getElementById('startBlast');if(button)button.disabled=blocked||(typeof calculationWorkflowRunning!=='undefined'&&calculationWorkflowRunning);
  const dialog=document.getElementById('blastCompatibilityDialog'),key=report.errors.join('\n');
  if(!blocked){blastCompatibilityDialogKey='';if(dialog?.open)dialog.close();}
  if(showDialog&&blocked&&key!==blastCompatibilityDialogKey){
    blastCompatibilityDialogKey=key;document.getElementById('blastCompatibilityDialogText').textContent=key;
    if(dialog?.showModal&&!dialog.open)dialog.showModal();
  }
  return report;
}
function populateGasEOSOptions(){
  for(const [id,ids] of [['blastProductEOS',[2,1,0,3,4,5,6]],['blastAirEOS',GasEOS.ids]]){
    const select=document.getElementById(id);select.replaceChildren();
    for(const value of ids){const option=document.createElement('option');option.value=String(value);option.textContent=GasEOS.names[value];select.append(option);}
  }
}
function syncGasEOSControls(){
  for(const prefix of ['product','air']){
    const model=Number(document.getElementById(prefix==='product'?'blastProductEOS':'blastAirEOS').value);
    const help=document.getElementById(prefix==='product'?'blastProductEOSHelp':'blastAirEOSHelp');if(help)help.textContent=GasEOS.help[model]||'';
    for(const label of document.querySelectorAll('[data-gas-extra]')){const [group,key]=label.dataset.gasExtra.split('.');if(group===prefix)label.hidden=!GasEOS.active(key,model);}
  }
}
function initializeBlastCompatibility(){
  const modalFields=new Set(['rockModel','kinematics','planeMode','loadMode','sourceMode','productEOS','airEOS','ventEnds']);
  for(const [key,[id]] of Object.entries(BLAST_FIELDS)){
    const input=document.getElementById(id);if(!input)continue;
    input.addEventListener('input',()=>syncBlastCompatibility());
    input.addEventListener('change',()=>{syncGasEOSControls();syncBlastCompatibility(modalFields.has(key));});
  }
  document.getElementById('blastCompatibilityClose').addEventListener('click',()=>document.getElementById('blastCompatibilityDialog').close());
  syncBlastCompatibility();
}
