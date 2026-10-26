// Independent library drafts never mutate the current simulation on selection or save.
let blastLibraryKind="explosive",blastLibraryId=null,blastLibraryDraft=null,blastLibraryBusy=false;
const blastLibraryElement=id=>document.getElementById(id);
function blastLibraryRecords(){return blastLibraryKind==="explosive" ? explosiveLibraryPayload.explosives : gasLibraryPayload.gases;}
function blastLibrarySchema(){return blastLibraryKind==="explosive" ? ExplosiveLibrary : GasLibrary;}
function blastLibraryMessage(text){blastLibraryElement("blastLibraryStatus").textContent=blastErrorText(text);}
function renderBlastLibraryList(){
  const list=blastLibraryElement("blastLibraryList");if(!list)return;
  list.replaceChildren();const records=blastLibraryRecords();blastLibraryElement("blastLibraryCount").textContent=String(records.length);
  for(const record of records){
    const button=document.createElement("button");button.type="button";button.className="blast-library-item";
    button.classList.toggle("active",record.id===blastLibraryId);button.textContent=record.name;
    button.disabled=blastLibraryBusy;button.addEventListener("click",()=>openBlastLibraryRecord(record));list.append(button);
  }
}
function openBlastLibraryRecord(record){
  blastLibraryId=record?.id || null;
  blastLibraryDraft=structuredClone(record || {name:"",notes:"",source:"用户保存",cjPressure:null,settings:Object.fromEntries(blastLibrarySchema().fields.map(key=>[key,BlastSettings.defaults[key]]))});
  blastLibraryElement("blastLibraryName").value=blastLibraryDraft.name;
  blastLibraryElement("blastLibrarySource").value=blastLibraryDraft.source;
  blastLibraryElement("blastLibraryNotes").value=blastLibraryDraft.notes;
  blastLibraryElement("blastLibraryTitle").textContent=record ? record.name : "新建参数";
  const fields=blastLibraryElement("blastLibraryFields");fields.replaceChildren();
  for(const key of blastLibrarySchema().fields){
    const label=document.createElement("label");label.className="material-field";
    const source=document.getElementById(BLAST_FIELDS[key][0]);
    const text=document.createElement("span");text.textContent=window.femI18n.sourceText(source.closest("label").querySelector("span"));
    const input=source.cloneNode(true);input.id=`library-${key}`;input.removeAttribute("aria-describedby");
    if(source.options)Array.from(source.options).forEach((option,index)=>{input.options[index].textContent=window.femI18n.sourceText(option);});
    input.value=String((blastLibraryDraft.settings[key]??BlastSettings.defaults[key])/BLAST_FIELDS[key][1]);
    if(key==="detonationVelocity")text.textContent="参考爆速 D (m/s)";
    label.append(text,input);fields.append(label);
    input.addEventListener("change",syncBlastLibraryEOS);
  }
  if(blastLibraryKind==="explosive"){
    const label=document.createElement("label");label.className="material-field";
    const text=document.createElement("span");text.textContent="参考 CJ 压力 (GPa，可留空)";
    const input=document.createElement("input");input.id="library-cjPressure";input.type="number";input.step="any";input.min="0";
    input.value=blastLibraryDraft.cjPressure==null ? "" : String(blastLibraryDraft.cjPressure/1e9);
    label.append(text,input);fields.append(label);
  }
  blastLibraryElement("blastLibraryDelete").disabled=!record;
  blastLibraryMessage("");syncBlastLibraryEOS();renderBlastLibraryList();
}
function syncBlastLibraryEOS(){
  const explosive=blastLibraryKind==='explosive',eos=Number(blastLibraryElement(explosive?'library-productEOS':'library-airEOS').value);
  for(const key of blastLibrarySchema().fields){
    const input=blastLibraryElement(`library-${key}`);
    const extra=GasEOS.extraKeys.find(k=>key.endsWith(k));
    input.closest("label").hidden=(key.startsWith("jwl") && eos!==1) || (key==="productGamma" && ![0,3,4,5,6].includes(eos)) || (key==='detonationVelocity'&&eos!==2) || (extra&&!GasEOS.active(extra,eos));
  }
}
function renderBlastLibrary(){
  if(!blastLibraryDraft)openBlastLibraryRecord(blastLibraryRecords()[0]);else renderBlastLibraryList();
}
function readBlastLibraryDraft(copy=false){
  const settings={};
  for(const key of blastLibrarySchema().fields){
    const input=blastLibraryElement(`library-${key}`),value=input.value.trim();
    const inactive=input.closest("label").hidden;
    settings[key]=value==="" && inactive ? blastLibraryDraft.settings[key]??BlastSettings.defaults[key] : value==="" ? NaN : Number(value)*BLAST_FIELDS[key][1];
  }
  const raw={id:!copy && blastLibraryId ? blastLibraryId : `${blastLibraryKind}-${crypto.randomUUID()}`,
    name:blastLibraryElement("blastLibraryName").value,notes:blastLibraryElement("blastLibraryNotes").value,
    source:blastLibraryElement("blastLibrarySource").value,settings};
  if(blastLibraryKind==="explosive"){
    const value=blastLibraryElement("library-cjPressure").value.trim();raw.cjPressure=value==="" ? null : Number(value)*1e9;
  }
  return blastLibrarySchema().entry(raw);
}
async function saveBlastLibraryDraft(copy){
  if(blastLibraryBusy)return;
  try{
    const record=readBlastLibraryDraft(copy),records=[...blastLibraryRecords().filter(e=>e.id!==record.id),record];
    await withBlastLibraryBusy(()=>blastLibraryKind==="explosive" ? persistExplosiveLibrary(records) : persistGasLibrary(records));
    openBlastLibraryRecord(record);blastLibraryMessage("参数已保存到爆破库。");
  }catch(error){blastLibraryMessage(error.message);}
}
async function withBlastLibraryBusy(action){
  blastLibraryBusy=true;
  const controls=[...blastLibraryElement("blastLibraryPage").querySelectorAll("input,select,textarea,button")];
  const previous=controls.map(control=>control.disabled);controls.forEach(control=>{control.disabled=true;});
  try{return await action();}finally{blastLibraryBusy=false;controls.forEach((control,i)=>{control.disabled=previous[i];});renderBlastLibraryList();}
}
async function deleteBlastLibraryDraft(){
  if(!blastLibraryId || blastLibraryBusy)return;
  if(!window.confirm("删除所选参数？当前模型中的计算参数仍然保留。"))return;
  try{
    const id=blastLibraryId,records=blastLibraryRecords().filter(record=>record.id!==id);
    await withBlastLibraryBusy(()=>blastLibraryKind==="explosive" ? persistExplosiveLibrary(records) : persistGasLibrary(records));
    const key=blastLibraryKind==="explosive" ? "blastExplosiveId" : "blastGasId";
    if(scene[key]===id)scene[key]=null;
    syncExplosiveLibrarySelection();syncGasLibrarySelection();openBlastLibraryRecord(records[0]);blastLibraryMessage("已删除所选参数。");
  }catch(error){blastLibraryMessage(error.message);}
}
function initializeBlastLibrary(){
  document.querySelectorAll("[data-blast-library-kind]").forEach(button=>button.addEventListener("click",()=>{
    blastLibraryKind=button.dataset.blastLibraryKind;blastLibraryElement("blastLibraryKind").value=blastLibraryKind;
    const id=scene[blastLibraryKind==="explosive" ? "blastExplosiveId" : "blastGasId"];
    openBlastLibraryRecord(blastLibraryRecords().find(record=>record.id===id) || blastLibraryRecords()[0]);
  }));
  blastLibraryElement("blastLibraryKind").addEventListener("change",event=>{blastLibraryKind=event.target.value;openBlastLibraryRecord(blastLibraryRecords()[0]);});
  blastLibraryElement("blastLibraryNew").addEventListener("click",()=>openBlastLibraryRecord(null));
  blastLibraryElement("blastLibraryForm").addEventListener("submit",event=>{event.preventDefault();saveBlastLibraryDraft(false);});
  blastLibraryElement("blastLibraryCopy").addEventListener("click",()=>saveBlastLibraryDraft(true));
  blastLibraryElement("blastLibraryDelete").addEventListener("click",deleteBlastLibraryDraft);
  blastLibraryElement("blastLibraryReload").addEventListener("click",async()=>{
    if(blastLibraryBusy)return;
    try{await withBlastLibraryBusy(()=>blastLibraryKind==="explosive" ? reloadExplosiveLibrary() : reloadGasLibrary());
      openBlastLibraryRecord(blastLibraryRecords().find(record=>record.id===blastLibraryId) || blastLibraryRecords()[0]);
      blastLibraryMessage("参数库已重新读取。");
    }catch(error){blastLibraryMessage(error.message);}
  });
  blastLibraryElement("blastLibraryApply").addEventListener("click",()=>{
    if(!blastLibraryId){blastLibraryMessage("请先保存参数，再应用到爆破设置。");return;}
    // Applying uses the visible draft, so an unsaved edit is never silently ignored.
    try{
      const record=readBlastLibraryDraft(),key=blastLibraryKind==="explosive" ? "blastExplosiveId" : "blastGasId";
      for(const [field,value] of Object.entries(record.settings)){const [id,scale]=BLAST_FIELDS[field];document.getElementById(id).value=String(value/scale);}
      scene[key]=record.id;scene.blastSettings={...scene.blastSettings,...record.settings};
      document.getElementById("blastSourceMode").value="1";scene.blastSettings.sourceMode=1;
      syncExplosiveLibrarySelection();syncGasLibrarySelection();syncBlastSourceControls();
      setBlastModuleEnabled(true);setPage("blast");
    }catch(error){blastLibraryMessage(error.message);}
  });
}
