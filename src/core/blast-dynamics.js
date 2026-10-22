// Transient orchestration; the native solver owns all dynamics and damage history.
let blastHistory = null;
let blastPlayback = null;
let blastLoadTicket = 0;
let blastRunController = null;
let blastBoundaryControlKey = "";

function updateBlastProgress(progress={}) {
  const bar=document.getElementById("blastProgress"),label=document.getElementById("blastProgressText");
  if(!bar || !label)return;
  bar.hidden=false;label.hidden=false;
  const fraction=Math.max(0,Math.min(1,progress.fraction || 0));
  if(fraction>0 || progress.phase==="complete")bar.value=fraction;else bar.removeAttribute("value");
  const time=seconds=>seconds<60 ? `${Math.ceil(seconds)} 秒` : `${Math.floor(seconds/60)} 分 ${Math.ceil(seconds%60)} 秒`;
  const phase=({preparing:"正在准备模型与初始平衡",solving:"正在求解",saving:"正在保存结果",complete:"计算完成"})[progress.phase] || "正在准备网格";
  label.textContent=`${phase} · ${(fraction*100).toFixed(1)}%`+
    (progress.totalSteps ? ` · ${progress.completedSteps ?? progress.totalSteps} / ${progress.totalSteps} 步` : "")+
    (progress.elapsedSeconds!==undefined ? ` · 已用 ${time(progress.elapsedSeconds)}` : "")+
    (Number.isFinite(progress.remainingSeconds) ? ` · 预计剩余 ${time(progress.remainingSeconds)}` : fraction<1 ? " · 正在估算剩余时间…" : "");
}

async function readBlastRunResponse(response) {
  if(!response.ok || !response.headers.get("content-type")?.includes("application/x-ndjson"))return response.json();
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending="",history;
  const consume=line=>{
    if(!line.trim())return;
    const message=JSON.parse(line);
    if(message.type==="error")throw new Error(message.error);
    if(message.type==="progress")updateBlastProgress(message);
    if(message.type==="result")history=message.history;
  };
  try {
    while(true){
      const {value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});
      let end;while((end=pending.indexOf("\n"))>=0){consume(pending.slice(0,end));pending=pending.slice(end+1);}
      if(done)break;
    }
    consume(pending);
    if(!history)throw new Error("爆破进度连接中断，请重新计算。");
    return history;
  } finally {reader.releaseLock();}
}
const BLAST_FIELDS = {x:["blastX",1],y:["blastY",1],radius:["blastCavityRadius",1],chargeRadius:["blastRadius",1],pressure:["blastPressure",1e6],
  pulse:["blastPulse",.001],duration:["blastDuration",.001],dt:["blastDt",1e-6],
  damping:["blastDamping",1],gf:["blastGf",1],frames:["blastFrames",1],
  confineX:["blastConfineX",1e6],confineY:["blastConfineY",1e6],timeLimitSeconds:["blastTimeLimit",1],
  boundary:["blastBoundary",1],loadMode:["blastLoadMode",1],planeMode:["blastPlaneMode",1],
  sourceMode:["blastSourceMode",1],productEOS:["blastProductEOS",1],productDensity:["blastProductDensity",1],
  detonationVelocity:["blastDetonationVelocity",1],productEnergy:["blastProductEnergy",1e6],productGamma:["blastProductGamma",1],
  jwlA:["blastJwlA",1e9],jwlB:["blastJwlB",1e9],jwlR1:["blastJwlR1",1],jwlR2:["blastJwlR2",1],jwlOmega:["blastJwlOmega",1],
  airDensity:["blastAirDensity",1],airPressure:["blastAirPressure",1e6],airGamma:["blastAirGamma",1],gasCells:["blastGasCells",1],
  rockModel:['blastRockModel',1],gasFracture:['blastGasFracture',1],crackDamage:['blastCrackDamage',1],kinematics:['blastKinematics',1],
  ventEnds:['blastVentEnds',1],specimenThickness:['blastSpecimenThickness',.001],ventOpeningTime:['blastVentOpeningTime',.001]};

function readBlastControls() {
  const settings={fracture:document.getElementById("blastFracture").checked};
  const gasMode=Number(document.getElementById("blastSourceMode").value)===1;
  const eos=Number(document.getElementById("blastProductEOS").value),jwl=eos===1;
  for(const [key,[id,scale]] of Object.entries(BLAST_FIELDS)) {
    const gasKey=["detonationVelocity","productEOS","productDensity","productEnergy","productGamma","jwlA","jwlB","jwlR1","jwlR2","jwlOmega","airDensity","airPressure","airGamma","gasCells","ventEnds","specimenThickness","ventOpeningTime"].includes(key);
    const inactive=(gasKey && !gasMode) || (gasMode && ["pressure","pulse"].includes(key)) ||
      (!jwl && key.startsWith("jwl")) || (eos!==0 && key==="productGamma") || (eos!==2 && key==="detonationVelocity");
    const value=document.getElementById(id).value;
    settings[key]=value.trim()==="" ? (key==="radius" ? scene.blastSettings?.radius ?? BlastSettings.defaults.radius : NaN) : Number(value)*scale;
    // Keep valid inactive values for scene save and switching models.
    if(inactive && !Number.isFinite(settings[key]))settings[key]=BlastSettings.defaults[key];
  }
  return BlastSettings.normalize(settings);
}
function restoreBlastControls() {
  if(typeof blastRockDrafts!=='undefined'){blastRockDrafts.clear();blastRockControlKey='';}
  const settings=BlastSettings.normalize(scene.blastSettings || {});
  for(const [key,[id,scale]] of Object.entries(BLAST_FIELDS)) document.getElementById(id).value=String(settings[key]/scale);
  document.getElementById("blastCavityRadius").value="";
  document.getElementById("blastFracture").checked=settings.fracture;
  const cavityChoice=document.getElementById("blastCavityChoice");
  if(cavityChoice) {cavityChoice.hidden=true;cavityChoice.replaceChildren();}
  const cavityStatus=document.getElementById("blastCavityStatus");if(cavityStatus)cavityStatus.textContent="";
  blastBoundaryControlKey="";
  syncBlastBoundaryControls();
  syncBlastSourceControls();
  if(typeof syncBlastFractureControls==="function")syncBlastFractureControls(true);
  if(typeof syncExplosiveLibrarySelection==="function")syncExplosiveLibrarySelection();
  if(typeof syncGasLibrarySelection==="function")syncGasLibrarySelection();
}
function syncBlastSourceControls() {
  const gasMode=Number(document.getElementById("blastSourceMode").value)===1;
  const eos=["ideal","jwl","common"][Number(document.getElementById("blastProductEOS").value)];
  document.querySelectorAll("[data-blast-source-mode]").forEach(element=>{element.hidden=(element.dataset.blastSourceMode==="gas")!==gasMode;});
  document.querySelectorAll("[data-product-eos]").forEach(element=>{element.hidden=element.dataset.productEos!==eos;});
}
function syncBlastBoundaryControls() {
  const container=document.getElementById("blastBoundaryOverrides");if(!container)return;
  const curves=scene.curves.filter(curve=>!curve.construction),modes=scene.blastBoundaryModes || {};
  const key=JSON.stringify([curves.map(c=>[c.id,c.geometryNodeIds]),modes]);if(key===blastBoundaryControlKey)return;
  blastBoundaryControlKey=key;container.replaceChildren();
  for(const curve of curves) {
    const label=document.createElement("label");label.className="blast-boundary-row";
    const text=document.createElement("span");text.textContent=curve.id;
    const select=document.createElement("select");select.setAttribute("aria-label",`Boundary ${curve.id}`);
    for(const [value,name] of [[-1,"随全局设置"],[0,"沿用原约束（反射）"],[1,"自由面（反射）"],[2,"吸收（近似无反射）"],[3,"固定边界（反射）"]]){
      const option=document.createElement("option");option.value=String(value);option.textContent=name;select.append(option);
    }
    select.value=String(modes[curve.id] ?? -1);
    select.addEventListener("change",()=>{
      scene.blastBoundaryModes ||= {};
      if(select.value==="-1")delete scene.blastBoundaryModes[curve.id];else scene.blastBoundaryModes[curve.id]=Number(select.value);
      blastBoundaryControlKey="";renderCalculationView();
    });
    label.append(text,select);container.append(label);
  }
}
function blastBoundaryEdges(payload,model) {
  const counts=new Map(),byId=new Map(payload.nodes.map(node=>[String(node.id),node.number]));
  for(const e of model.elements)for(let j=0;j<3;j++) {
    const a=e.nodeNumbers[j],b=e.nodeNumbers[(j+1)%3],key=[a,b].sort((a,b)=>a-b).join(":");counts.set(key,(counts.get(key)||0)+1);
  }
  const edges=new Map();
  for(const e of payload.elements)for(const edge of e.edges || []) {
    const mode=scene.blastBoundaryModes?.[edge.curveId];if(mode===undefined || !edge.boundary)continue;
    const [a,b]=(edge.nodeIds || []).map(id=>byId.get(String(id)));if(!a || !b)continue;
    const key=[a,b].sort((a,b)=>a-b).join(":");if(counts.get(key)===1)edges.set(key,{node1:a,node2:b,mode});
  }
  return [...edges.values()];
}
function clearBlastHistory() {
  if(blastHistory && typeof gpuMeshRenderer!=="undefined")gpuMeshRenderer.release(blastHistory.model);
  blastHistory?.displayController?.abort();
  if(blastPlayback!==null) cancelAnimationFrame(blastPlayback);
  blastPlayback=null; blastHistory=null;
  blastLoadTicket++;
  if (typeof tntCurrentFrame !== "undefined") tntCurrentFrame=null;
  const timeline=document.getElementById("blastTimeline");
  if(timeline) timeline.hidden=true;
  if(typeof resetBlastResultWorkspace === "function") resetBlastResultWorkspace();
}
function initializeBlastControls() {
  restoreBlastControls();
  initializeBlastFractureControls();
  for(const id of ["blastSourceMode","blastProductEOS"])document.getElementById(id).addEventListener("change",syncBlastSourceControls);
  document.getElementById("identifyBlastCavity").addEventListener("click",identifyBlastCavity);
  for(const id of ["blastX","blastY","blastRadius"])document.getElementById(id).addEventListener("input",()=>{
    document.getElementById("blastCavityStatus").textContent="";
    document.getElementById("blastCavityChoice").hidden=true;
  });
  document.getElementById("blastCavityChoice").addEventListener("change",event=>{
    if(!event.target.value)return;
    try {
      if(!blastMeshCanBeReused())throw new Error(blastCavityText("网格已变化，请重新识别炮孔。"));
      const model=calculationInputPayloadToDirectModel(buildCalculationInputExport({adaptive:false}));
      const cavity=BlastCavity.analyze(model).cavities.find(item=>item.key===event.target.value);
      if(!cavity)throw new Error(blastCavityText("网格已变化，请重新识别炮孔。"));
      applyDetectedBlastCavity(cavity);
    } catch(error) {document.getElementById("blastCavityStatus").textContent=blastErrorText(error.message);}
  });
  document.getElementById("startBlast").addEventListener("click",()=>startBlastWorkflow().catch(console.error));
  document.getElementById("cancelBlast")?.addEventListener("click",()=>blastRunController?.abort());
  const loadExample=async(gasExample)=>{
    try {
      const response=await fetch("./examples/blast-cavity.json");
      if(!response.ok)throw new Error("Unable to load blast example.");
      document.getElementById("maxAnalysisNodes").value="1000";
      if(document.getElementById("blastMaxAnalysisNodes")) document.getElementById("blastMaxAnalysisNodes").value="1000";
      const data=await response.json();
      if(gasExample){data.name="气体—岩体耦合验证（非 TNT 标定）";data.blastSettings={...data.blastSettings,sourceMode:1,productEOS:0,gasCells:192,duration:.0001,frames:51,fracture:false,planeMode:1};}
      importScene(new File([JSON.stringify(data)],"blast-cavity.json",{type:"application/json"}));
    } catch(error) {document.getElementById("blastStatus").textContent=blastErrorText(error.message);}
  };
  document.getElementById("loadBlastExample").addEventListener("click",()=>loadExample(false));
  document.getElementById("loadGasBlastExample").addEventListener("click",()=>loadExample(true));
  document.getElementById("blastFrame").addEventListener("input",event=>selectBlastFrame(Number(event.target.value)));
  document.getElementById("blastPlay").addEventListener("click",toggleBlastPlayback);
  document.getElementById("blastDownload").addEventListener("click",()=>{
    if(!blastHistory)return;
    if(blastHistory.downloadUrl) {
      const link=document.createElement("a");link.href=blastHistory.downloadUrl;link.download="blast-history.json.gz";link.click();return;
    }
    const url=URL.createObjectURL(new Blob([JSON.stringify(blastHistory)],{type:"application/json"}));
    const link=document.createElement("a");link.href=url;link.download="blast-history.json";link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
}
function blastModelSignature(model) { return JSON.stringify([model.nodes,model.elements,model.materials,model.elementNodeLoads]); }
function blastGeometrySignature() { return JSON.stringify([scene.geometryNodes,scene.curves,scene.regions,scene.pointLoads,scene.distributedLoads,scene.bodyLoads,scene.blastBoundaryModes]); }

// Keep complete source messages in the DOM so language changes can restore them.
function blastCavityText(text) { return text; }
function blastErrorText(error) { return typeof window!=="undefined" && window.femI18n ? window.femI18n.sourceMessage(error) : error; }
function blastCavityNumber(value) { return Number(value.toPrecision(6)).toString(); }
function blastCavityDescription(cavity) {
  return `x = ${blastCavityNumber(cavity.x)}, y = ${blastCavityNumber(cavity.y)}, r = ${blastCavityNumber(cavity.radius)} m` +
    (cavity.edgeCount ? ` / ${blastCavityText("孔壁边数")} = ${cavity.edgeCount}` : "");
}
function blastCavityProblem(inspection, settings) {
  if (!inspection.holeCount) return blastCavityText("当前实体网格没有闭合内孔。请将炮孔设为外部空气区域，并更新网格。");
  if (!inspection.cavities.length) return blastCavityText("网格内孔未识别为圆孔。请检查孔壁形状，确认圆孔中心、半径与网格一致。");
  const nearest = [...inspection.cavities].sort((a, b) => Math.hypot(a.x - settings.x, a.y - settings.y) - Math.hypot(b.x - settings.x, b.y - settings.y))[0];
  return blastCavityText("炮孔参数与网格孔壁不匹配。") + "\n" + blastCavityText("当前参数：") + blastCavityDescription(settings) +
    "\n" + blastCavityText("最近圆孔：") + blastCavityDescription(nearest) + "\n" +
    blastCavityText(nearest.edgeCount < 6 ? "孔壁至少需要 6 条网格边，请细化网格。" : "请使用“识别并填入炮孔”，或手动修正中心与半径后运行；无需仅因参数不匹配而重划网格。");
}
function validateBlastCavity(model, settings) {
  const inspection = BlastCavity.analyze(model, settings);
  if (!inspection.match) throw new Error(blastCavityProblem(inspection, settings));
  return inspection;
}
function resolveBlastCavitySettings(model, settings) {
  const inspection=BlastCavity.analyze(model);
  const candidates=inspection.cavities.filter(cavity=>Math.hypot(cavity.x-settings.x,cavity.y-settings.y)<=Math.max(cavity.radius*.03,1e-10));
  if(!candidates.length)throw new Error(blastCavityText("未在装药中心找到闭合圆形孔壁。请修正中心或识别实际炮孔；装药半径可以小于炮孔半径。"));
  if(candidates.length!==1)throw new Error(blastCavityText("装药中心对应多个圆形孔壁，请先明确实际炮孔。"));
  const wall=candidates[0];
  const resolved={...settings,radius:wall.radius};
  validateBlastCavity(model,resolved);
  if(settings.chargeRadius>wall.radius*(1+1e-8))throw new Error(blastCavityText("装药半径大于实际炮孔半径，请减小装药半径。"));
  return {settings:resolved,edgeCount:wall.edgeCount};
}
function blastMeshCanBeReused() {
  return Boolean(scene.mesh?.elements?.length && scene.analysisNodes?.length &&
    !scene.mesh.metadata?.stale && !scene.analysisNodePlacement?.stale &&
    Number(scene.mesh.metadata?.version) === ANALYSIS_MESH_VERSION &&
    Number(scene.analysisNodePlacement?.version) === ANALYSIS_NODE_PLACEMENT_VERSION);
}
function blastMeshReuseMessage() {
  if (!scene.mesh?.elements?.length) return "尚未生成网格；可在基础计算页或本页生成。";
  if (!blastMeshCanBeReused()) return "当前网格已过期，运行时将更新网格。";
  if(scene.mesh.metadata?.blastDamage)return "当前损伤细化网格可复用；运行时按当前强度与断裂能复查。";
  return scene.mesh.metadata?.adaptive ? "当前自适应网格可直接用于爆破，无需重新划分。" : "当前普通网格可直接用于爆破，无需重新划分。";
}
function identifyBlastCavity() {
  const status = document.getElementById("blastCavityStatus"), selector = document.getElementById("blastCavityChoice");
  try {
    if (calculationWorkflowRunning) throw new Error(blastCavityText("请等待当前计算结束后识别炮孔。"));
    if (!blastMeshCanBeReused()) throw new Error(blastCavityText("请先生成或更新有效网格；基础计算页的均匀网格和自适应网格均可使用。"));
    const model = calculationInputPayloadToDirectModel(buildCalculationInputExport({adaptive:false}));
    const inspection = BlastCavity.analyze(model);
    if (!inspection.cavities.length) throw new Error(blastCavityProblem(inspection, readBlastControls()));
    selector.replaceChildren();
    const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = blastCavityText("请选择要起爆的圆孔"); selector.append(placeholder);
    for (const cavity of inspection.cavities) {
      const option = document.createElement("option"); option.value = cavity.key; option.textContent = blastCavityDescription(cavity); selector.append(option);
    }
    selector.hidden = inspection.cavities.length === 1;
    if (inspection.cavities.length === 1) applyDetectedBlastCavity(inspection.cavities[0]);
    else status.textContent = blastCavityText("发现多个圆孔，请选择要起爆的圆孔；不会自动替换为其他孔。");
  } catch (error) { status.textContent = blastErrorText(error.message); }
}
function applyDetectedBlastCavity(cavity) {
  document.getElementById("blastX").value = String(cavity.x);
  document.getElementById("blastY").value = String(cavity.y);
  document.getElementById("blastCavityRadius").value = blastCavityNumber(cavity.radius);
  scene.blastSettings = {...scene.blastSettings, x:cavity.x, y:cavity.y, radius:cavity.radius,chargeRadius:Number(document.getElementById("blastRadius").value)};
  document.getElementById("blastCavityStatus").textContent = blastCavityText("已从当前网格填入炮孔：") + blastCavityDescription(cavity) +
    (cavity.edgeCount < 6 ? "\n" + blastCavityText("孔壁至少需要 6 条网格边，请细化网格。") : "");
  render();
}
async function startBlastWorkflow() {
  if(typeof isProfessionalCalculationEnabled === "function" && !isProfessionalCalculationEnabled("blast"))return;
  if(calculationWorkflowRunning)return;
  const button=document.getElementById("startBlast"), status=document.getElementById("blastStatus");
  calculationWorkflowRunning=true;button.disabled=true;
  blastRunController=new AbortController();document.getElementById("cancelBlast").disabled=false;
  try {
    updateBlastProgress();
    let settings=readBlastControls();
    if(typeof saveBlastRockCards==='function')await saveBlastRockCards(settings);
    if(settings.fracture && settings.rockModel===0)await saveBlastStrengthInputs();
    status.textContent="正在运行爆破模拟…";
    await ensureCalculationMeshReadyForExport({adaptive:false});
    blastRunController.signal.throwIfAborted();
    let payload=buildCalculationInputExport({adaptive:false});
    let model=calculationInputPayloadToDirectModel(payload);
    for(const material of model.materials)BlastMaterials.validate(material,settings);
    // Check the source before spending time refining an unusable cavity.
    resolveBlastCavitySettings(model,settings);
    ({payload,model}=await ensureBlastDamageMeshReady(payload,model,settings,blastRunController.signal));
    try {
      const resolved=resolveBlastCavitySettings(model,settings);settings=resolved.settings;
      document.getElementById("blastCavityRadius").value=blastCavityNumber(settings.radius);
      document.getElementById("blastCavityStatus").textContent=blastCavityText("已识别实际孔壁；装药半径保持不变。孔壁边数：")+resolved.edgeCount;
    } catch(error) { document.getElementById("blastCavityStatus").textContent=blastErrorText(error.message); throw error; }
    scene.blastSettings=settings;
    if(typeof renderBlastSetup==="function")renderBlastSetup();
    model.blastBoundaryEdges=blastBoundaryEdges(payload,model);
    const signature=blastModelSignature(model);
    const geometrySignature=blastGeometrySignature();
    blastRunController.signal.throwIfAborted();
    const response=await fetch("./api/blast-runs",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/x-ndjson"},body:JSON.stringify({model,settings}),signal:blastRunController.signal});
    const history=await readBlastRunResponse(response);
    if(!response.ok || !history.ok)throw new Error(history.error || "Blast simulation failed.");
    if(settings.sourceMode===1 && history.sourceMode!==1)throw new Error("气体求解需要重新编译核心并重启程序服务。");
    const current=calculationInputPayloadToDirectModel(buildCalculationInputExport({adaptive:false}));
    if(blastModelSignature(current)!==signature || blastGeometrySignature()!==geometrySignature)throw new Error("模型在计算期间发生变化，请重新计算。");
    clearBlastHistory();blastHistory={...history,settings,model,frameCache:new Map(),pendingFrames:new Map()};
    if(typeof activateResultWorkspace === "function") setPage("blast-results");
    document.getElementById("blastTimeline").hidden=false;
    const slider=document.getElementById("blastFrame");slider.max=String(history.frames.length-1);
    const actualSteps=history.frames.at(-1).actualSteps??history.steps;
    status.textContent=history.stepCountIsEstimate?`完成 / ${actualSteps} 步 / 自适应 Δt ≤ ${(history.dt*1e6).toPrecision(4)} μs`:`完成 / ${actualSteps} 步 / Δt = ${(history.dt*1e6).toPrecision(4)} μs`;
    if(!await selectBlastFrame(0))throw new Error("爆破历史不可用，请重新计算。");
    setPage(typeof activateResultWorkspace === "function" ? "blast-results" : "results");setResultView("tnt");
    return blastHistory;
  } catch(error) { status.textContent=error.name==="AbortError" ? "爆破计算已取消。" : blastErrorText(error.message);document.getElementById("blastProgressText").textContent=status.textContent;document.getElementById("blastProgress").hidden=true;throw error; }
  finally { calculationWorkflowRunning=false;button.disabled=false;blastRunController=null;document.getElementById("cancelBlast").disabled=true; }
}
function blastFrameResult(model, frame, baseline = null) {
  return {modelName:model.modelName,units:{stress:"Pa",strain:"1",displacement:"m"},
    nodeDisplacements:model.nodes.map((node,i)=>({nodeNo:node.nodeNo,ux:frame.u[2*i],uy:frame.u[2*i+1],magnitude:Math.hypot(frame.u[2*i],frame.u[2*i+1])})),
    elementResults:model.elements.map((element,i)=>{
      const [ex,ey,gxy,sx,sy,txy,damage]=frame.elements[i];
      const sz=frame.elements[i][7]??0;
      const initial=baseline?.elements[i],dx=sx-(initial?.[3] || 0),dy=sy-(initial?.[4] || 0),dxy=txy-(initial?.[5] || 0);
      const dz=sz-(initial?.[7]||0);
      return {elementNo:element.elementNo,strainXx:ex,strainYy:ey,strainXy:gxy/2,strainYx:gxy/2,
        stressXx:sx,stressYy:sy,stressXy:txy,stressYx:txy,damage,
        ...(frame.elements[i].length>7?{stressZz:sz,plasticStrain:frame.elements[i][8]??0}:{}),
        equivalentStress:Math.sqrt(Math.max(0,sx*sx+sy*sy+sz*sz-sx*sy-sy*sz-sz*sx+3*txy*txy)),
        dynamicEquivalentStress:Math.sqrt(Math.max(0,dx*dx+dy*dy+dz*dz-dx*dy-dy*dz-dz*dx+3*dxy*dxy)),
        equivalentStrain:Math.sqrt(Math.max(0,ex*ex-ex*ey+ey*ey+.75*gxy*gxy)),
        safetyCode:0,safetyText:"Transient frame"};
    })};
}

// Transient topology stays fixed. Update numeric fields without rebuilding maps,
// node connectivity, bounds, or allocating several copies of every element.
function updateBlastFrameData(history,frame,baseline) {
  let data=history.resultData;
  if(!data) {
    data=buildCalculationResultData(history.model,blastFrameResult(history.model,frame,baseline),{blastFrame:true});
    history.resultData=data;
  } else {
    data={...data};history.resultData=data;
    for(let i=0;i<data.nodes.length;i++) {
      const n=data.nodes[i];n.ux=frame.u[2*i];n.uy=frame.u[2*i+1];n.displacementMagnitude=Math.hypot(n.ux,n.uy);
    }
    const keys=["stressXx","stressXy","stressYy","strainXx","strainXy","strainYy","displacementMagnitude","equivalentStress","equivalentStrain"];
    const ranges=Object.fromEntries(keys.map(k=>[k,{min:Infinity,max:-Infinity}]));
    data.maxDisplacement=0;data.maxStress=0;data.maxStrain=0;
    for(const n of data.nodes)data.maxDisplacement=Math.max(data.maxDisplacement,n.displacementMagnitude);
    for(let i=0;i<data.elements.length;i++) {
      const e=data.elements[i],[ex,ey,gxy,sx,sy,txy,damage]=frame.elements[i],initial=baseline.elements[i];
      const dx=sx-initial[3],dy=sy-initial[4],dxy=txy-initial[5];
      e.strainXx=ex;e.strainYy=ey;e.strainXy=e.strainYx=gxy/2;
      e.stressXx=sx;e.stressYy=sy;e.stressXy=e.stressYx=txy;e.damage=damage;
      const sz=frame.elements[i][7]??0;
      if(frame.elements[i].length>7){e.stressZz=sz;e.plasticStrain=frame.elements[i][8]??0;}
      e.equivalentStress=Math.sqrt(Math.max(0,sx*sx+sy*sy+sz*sz-sx*sy-sy*sz-sz*sx+3*txy*txy));
      const dz=sz-(initial[7]??0);e.dynamicEquivalentStress=Math.sqrt(Math.max(0,dx*dx+dy*dy+dz*dz-dx*dy-dy*dz-dz*dx+3*dxy*dxy));
      e.equivalentStrain=Math.sqrt(Math.max(0,ex*ex-ex*ey+ey*ey+.75*gxy*gxy));
      e.displacementMagnitude=Math.max(e.nodes[0].displacementMagnitude,e.nodes[1].displacementMagnitude,e.nodes[2].displacementMagnitude);
      data.maxStress=Math.max(data.maxStress,e.equivalentStress);data.maxStrain=Math.max(data.maxStrain,e.equivalentStrain);
      for(const k of keys){ranges[k].min=Math.min(ranges[k].min,e[k]);ranges[k].max=Math.max(ranges[k].max,e[k]);}
    }
    data.ranges=ranges;
    // Avoid retaining the first frame's duplicate numeric records.
    data.result=null;
  }
  data.gpuOwner=history.model;data.frameRevision=(history.frameRevision || 0)+1;history.frameRevision=data.frameRevision;
  return data;
}
async function fetchBlastFrame(history,index,signal) {
  if(history.frames[index].u)return history.frames[index];
  history.frameCache ||= new Map();history.pendingFrames ||= new Map();
  if(history.frameCache.has(index)){const frame=history.frameCache.get(index);history.frameCache.delete(index);history.frameCache.set(index,frame);return frame;}
  const existing=history.pendingFrames.get(index);
  if(existing && !existing.signal?.aborted)return existing.promise;
  const pending=(async()=>{
    const response=await fetch(history.frameBaseUrl+index,{cache:"no-store",signal});
    if(!response.ok)throw new Error("爆破历史不可用，请重新计算。");
    const frame=BlastFrameCodec.decode(await response.arrayBuffer(),history);
    history.frameCache.set(index,frame);
    while(history.frameCache.size>3){const oldest=[...history.frameCache.keys()].find(key=>key!==0 && key!==index);if(oldest===undefined)break;history.frameCache.delete(oldest);}
    return frame;
  })();
  const entry={promise:pending,signal};history.pendingFrames.set(index,entry);
  try{return await pending;}finally{if(history.pendingFrames.get(index)===entry)history.pendingFrames.delete(index);}
}
async function selectBlastFrame(index) {
  if(!blastHistory)return;
  const history=blastHistory,ticket=++blastLoadTicket;
  history.displayController?.abort();history.displayController=new AbortController();
  const i=Math.max(0,Math.min(history.frames.length-1,Math.round(index)));
  let frame,baseline;
  if(!history.frames[i].u && !history.frameCache?.has(i))setResultStatus("正在读取爆破帧…");
  try {[frame,baseline]=await Promise.all([fetchBlastFrame(history,i,i===0 ? undefined : history.displayController.signal),fetchBlastFrame(history,0)]);}
  catch(error){if(history===blastHistory && ticket===blastLoadTicket)setResultStatus(blastErrorText(error.message));return;}
  if(history!==blastHistory || ticket!==blastLoadTicket)return;
  if(typeof activeResultChannel !== "undefined" && activeResultChannel !== "blast")return;
  if (typeof tntCurrentFrame !== "undefined") tntCurrentFrame=frame;
  // Preserve viewport and scale while scrubbing; build fresh frame data for renderer cache invalidation.
  const factor=resultDeformationScale?.value;
  calculationResultData=updateBlastFrameData(history,frame,baseline);
  resetResultDeformationScale(calculationResultData);
  if(factor!==undefined) setResultDeformationScale(Number(factor));
  if(!history.fitted){fitResultViewToData(false);history.fitted=true;}
  renderResultView();
  document.getElementById("blastFrame").value=String(i);
  document.getElementById("blastTime").textContent=`t = ${(frame.time*1000).toFixed(5)} ms / p = ${(frame.pressure/1e6).toFixed(3)} MPa`;
  let damaged=0;for(const e of frame.elements)if(e[6]>.01)damaged++;
  document.getElementById("blastDiagnostics").textContent=`K = ${frame.kineticEnergy.toPrecision(4)} J / U = ${frame.strainEnergy.toPrecision(4)} J / U₀ = ${(history.preloadEnergy || 0).toPrecision(4)} J / W = ${frame.externalWork.toPrecision(4)} J / D = ${(frame.dissipatedEnergy || 0).toPrecision(4)} J / d > 0.01: ${damaged}`;
  if(frame.plasticWork!==undefined)document.getElementById('blastDiagnostics').textContent+=`\n塑性耗能 = ${frame.plasticWork.toPrecision(4)} J / 连通裂隙体积 = ${frame.crackVolume.toExponential(3)} m³/m / 裂隙储气功 = ${frame.gasStorageWork.toPrecision(4)} J`;
  if(frame.actualSteps!==undefined)document.getElementById('blastDiagnostics').textContent+=`\n实际步数 = ${frame.actualSteps} / 最小 J = ${frame.minimumJacobian.toPrecision(4)} / 稀疏波返回 = ${frame.gasRarefactionFallbacks}`;
  if(frame.gasVentedEnergy!==undefined)document.getElementById('blastDiagnostics').textContent+=`\n轴向流出能量 = ${frame.gasVentedEnergy.toPrecision(4)} J / 流出质量 = ${frame.gasVentedMass.toPrecision(4)} kg/m`;
  if(!history.settings.kinematics && (frame.maxStrain??calculationResultData.maxStrain)>.05)document.getElementById('blastDiagnostics').textContent+='\n小变形结果存在大应变，请采用有限变形对照并检查网格。';
  if(history.sourceMode===1) {
    const balance=(frame.gasInternalEnergy+frame.gasKineticEnergy+frame.gasWallWork+(frame.gasVentedEnergy||0)-history.initialGasEnergy)/Math.max(history.initialGasEnergy,1e-30);
    document.getElementById("blastDiagnostics").textContent+=`\n气体 U = ${frame.gasInternalEnergy.toPrecision(4)} J / K = ${frame.gasKineticEnergy.toPrecision(4)} J / Wwall = ${frame.gasWallWork.toPrecision(4)} J / ΔE/E₀ = ${balance.toExponential(2)}`;
  }
  document.getElementById("blastDiagnostics").textContent+=resultCtx.canvas.dataset.renderBackend==="webgl" ? "\n渲染：WebGL（GPU）" : "\n渲染：Canvas 2D（WebGL 不可用）";
  setResultStatus(`t = ${(frame.time*1000).toFixed(5)} ms`);
  if (typeof updateTntTimeline === "function") updateTntTimeline();
  // Fetch the next frame while this frame is displayed. Keep the same bounded cache.
  if(blastPlayback!==null)fetchBlastFrame(history,(i+1)%history.frames.length).catch(()=>{});
  return frame;
}
function toggleBlastPlayback() {
  if(blastPlayback!==null) {cancelAnimationFrame(blastPlayback);blastPlayback=null;return;}
  if(!blastHistory)return;
  let previous=0,loading=false;
  const tick=now=>{
    if(!blastHistory || !["results","blast-results"].includes(currentPageKey())) {blastPlayback=null;return;}
    if(now-previous>=100 && !loading) {
      previous=now;
      const next=(Number(document.getElementById("blastFrame").value)+1)%blastHistory.frames.length;
      loading=true;selectBlastFrame(next).finally(()=>{loading=false;});
    }
    blastPlayback=requestAnimationFrame(tick);
  };
  blastPlayback=requestAnimationFrame(tick);
}
function drawBlastDamage() {
  if(!calculationResultData.runInfo?.blastFrame) {
    resultCtx.fillStyle="#334155";
    resultCtx.fillText("暂无爆破损伤结果。",24,36);
    return;
  }
  const color=element=>resultColorForScalar(element.damage || 0,{min:0,max:1});
  if(drawGpuResultMesh("blast-damage",element=>gpuScalarColor(element.damage || 0,{min:0,max:1},.9)))return;
  for(const element of calculationResultData.elements) drawResultElement(element.nodes,color(element),"rgba(30,41,59,.12)");
}
