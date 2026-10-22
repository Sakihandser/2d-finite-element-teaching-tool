let gasLibraryPayload={version:1,revision:0,gases:[]};
let gasLibraryBusy=false;
const gasElement=id=>document.getElementById(id);
function syncGasLibrarySelection(){
  const select=gasElement("gasPreset");if(!select)return;
  select.replaceChildren();
  const empty=document.createElement("option");empty.value="";empty.textContent="手动输入 / 新建气体";select.append(empty);
  for(const record of gasLibraryPayload.gases){const option=document.createElement("option");option.value=record.id;option.textContent=record.name;select.append(option);}
  select.value=scene.blastGasId || "";
}
function applyGasRecord(id){
  const record=gasLibraryPayload.gases.find(e=>e.id===id);if(!record)return;
  for(const [key,value] of Object.entries(record.settings)){const [control,scale]=BLAST_FIELDS[key];gasElement(control).value=String(value/scale);}
  scene.blastGasId=record.id;
  scene.blastSettings={...scene.blastSettings,...record.settings};
  
  syncGasLibrarySelection();gasElement("gasLibraryStatus").textContent="已填入气体参数，炸药和其他计算设置保持原值。";
}
async function reloadGasLibrary(){
  const response=await fetch("./api/gases",{cache:"no-store"});
  const payload=response.ok ? await response.json() : await (await fetch("./gases/library.json",{cache:"no-store"})).json();
  gasLibraryPayload=GasLibrary.normalize(payload);syncGasLibrarySelection();
  if(typeof renderBlastLibraryList==="function")renderBlastLibraryList();
}
async function persistGasLibrary(records){
  gasLibraryBusy=true;
  try{
    const response=await fetch("./api/gases",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...gasLibraryPayload,gases:records})});
    if(!response.ok){let detail="";try{detail=(await response.json()).error || "";}catch{}
      throw new Error(detail || "无法保存气体库，请重启程序服务后重试。");}
    gasLibraryPayload=GasLibrary.normalize(await response.json());syncGasLibrarySelection();
  }finally{gasLibraryBusy=false;}
}
function initializeGasLibrary(){
  gasElement("gasPreset").addEventListener("change",event=>{
    if(event.target.value)applyGasRecord(event.target.value);
    else{scene.blastGasId=null;gasElement("gasLibraryStatus").textContent="";}
  });
  return reloadGasLibrary().catch(error=>{gasElement("gasLibraryStatus").textContent=blastErrorText(error.message);});
}
