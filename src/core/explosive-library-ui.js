let explosiveLibraryPayload={version:1,revision:0,explosives:[]};
let explosiveLibraryBusy=false;
const explosiveElement=id=>document.getElementById(id);
function syncExplosiveLibrarySelection(){
  const select=explosiveElement("explosivePreset");if(!select)return;
  select.replaceChildren();
  const empty=document.createElement("option");empty.value="";empty.textContent="手动输入 / 新建炸药";select.append(empty);
  for(const record of explosiveLibraryPayload.explosives){const option=document.createElement("option");option.value=record.id;option.textContent=record.name;select.append(option);}
  select.value=scene.blastExplosiveId || "";
}
function applyExplosiveRecord(id){
  const record=explosiveLibraryPayload.explosives.find(e=>e.id===id);if(!record)return;
  for(const [key,value] of Object.entries(record.settings)){const [control,scale]=BLAST_FIELDS[key];explosiveElement(control).value=String(value/scale);}
  scene.blastExplosiveId=record.id;
  scene.blastSettings={...scene.blastSettings,...record.settings,sourceMode:1};
  explosiveElement("blastSourceMode").value="1";syncBlastSourceControls();
  syncExplosiveLibrarySelection();explosiveElement("explosiveLibraryStatus").textContent="已填入炸药参数；修改后可保存更新或另存为新条目。";
}
async function reloadExplosiveLibrary(){
  const response=await fetch("./api/explosives",{cache:"no-store"});
  const payload=response.ok ? await response.json() : await (await fetch("./explosives/library.json",{cache:"no-store"})).json();
  explosiveLibraryPayload=ExplosiveLibrary.normalize(payload);syncExplosiveLibrarySelection();
  if(typeof renderBlastLibraryList==="function")renderBlastLibraryList();
}
async function persistExplosiveLibrary(records){
  explosiveLibraryBusy=true;
  try{
    const response=await fetch("./api/explosives",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...explosiveLibraryPayload,explosives:records})});
    if(!response.ok){let detail="";try{detail=(await response.json()).error || "";}catch{}
      throw new Error(detail || "无法保存炸药库，请重启程序服务后重试。");}
    explosiveLibraryPayload=ExplosiveLibrary.normalize(await response.json());syncExplosiveLibrarySelection();
  }finally{explosiveLibraryBusy=false;}
}
function initializeExplosiveLibrary(){
  explosiveElement("explosivePreset").addEventListener("change",event=>{
    if(event.target.value)applyExplosiveRecord(event.target.value);
    else{scene.blastExplosiveId=null;explosiveElement("explosiveLibraryStatus").textContent="";}
  });
  return reloadExplosiveLibrary().catch(error=>{explosiveElement("explosiveLibraryStatus").textContent=blastErrorText(error.message);});
}
