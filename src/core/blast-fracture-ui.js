let blastStrengthControlKey="";
function blastStrengthMaterials(){
  const materials=new Map();
  for(const region of scene.regions || []){
    const snapshot=materialSnapshotForRegion(region);if(!snapshot)continue;
    const id=snapshot.id || region.materialId;if(!id)continue;
    if(!materials.has(id))materials.set(id,snapshot);
  }
  return [...materials.values()];
}
function syncBlastFractureControls(force=false){
  const panel=document.getElementById("blastFracturePanel");if(!panel)return;
  panel.hidden=!document.getElementById("blastFracture").checked;if(panel.hidden)return;
  const materials=blastStrengthMaterials(),key=JSON.stringify(materials.map(m=>[m.id,m.name,m.tensileStrength]));
  if(!force && key===blastStrengthControlKey)return;blastStrengthControlKey=key;
  const container=document.getElementById("blastFractureMaterials");container.replaceChildren();
  for(const material of materials){
    const label=document.createElement("label");label.className="number-field";
    const text=document.createElement("span");text.textContent=`${material.name} — ${blastCavityText("单轴抗拉强度 (MPa)")}`;
    const input=document.createElement("input");input.type="number";input.min="0";input.step="any";
    input.dataset.blastStrengthMaterial=material.id;input.value=material.tensileStrength>0 ? String(material.tensileStrength) : "";
    input.placeholder=blastCavityText("必须填写正值");label.append(text,input);container.append(label);
  }
  document.getElementById("blastFractureStatus").textContent=materials.some(m=>!(m.tensileStrength>0))
    ? blastCavityText("请补齐各材料的单轴抗拉强度后运行；不会自动用静水拉伸强度替代。") : "";
}
async function saveBlastStrengthInputs(){
  syncBlastFractureControls();
  const values=new Map(),materials=blastStrengthMaterials();
  for(const input of document.querySelectorAll("[data-blast-strength-material]")){
    const value=Number(input.value);
    if(!(input.value.trim() && Number.isFinite(value) && value>0)){
      input.focus();const name=materials.find(m=>m.id===input.dataset.blastStrengthMaterial)?.name || input.dataset.blastStrengthMaterial;
      throw new Error(`${name}：${blastCavityText("请填写大于 0 的单轴抗拉强度 (MPa)。")}`);
    }
    values.set(input.dataset.blastStrengthMaterial,value);
  }
  const changes=materials.filter(m=>values.has(m.id) && Number(m.tensileStrength)!==values.get(m.id));
  if(!changes.length)return;
  const previous=materialLibrary;
  const merged=new Map(materialLibrary.map(m=>[m.id,m]));
  for(const material of changes)merged.set(material.id,{...material,...merged.get(material.id),tensileStrength:values.get(material.id),updatedAt:new Date().toISOString()});
  materialLibrary=[...merged.values()];
  try{await saveMaterialLibrary();}catch(error){materialLibrary=previous;throw error;}
  // Only strength changes: retain the geometric mesh and classification versions.
  syncRegionMaterialSnapshots();blastStrengthControlKey="";syncBlastFractureControls();
  document.getElementById("blastFractureStatus").textContent=blastCavityText("抗拉强度已保存；当前网格继续复用。");
}
function validateBlastFractureModel(model,settings){
  const report=BlastFracture.inspect(model,settings);if(report.valid)return report;
  const missing=report.materials.filter(m=>m.missingStrength);
  if(missing.length)throw new Error(`${blastCavityText("缺少单轴抗拉强度：")}${missing.map(m=>m.name).join("、")}${blastCavityText("。请在“时间积分与损伤”中填写，单位 MPa。")}`);
  const bad=report.materials.filter(m=>m.incompatible),required=Math.max(...bad.map(m=>m.minGf));
  const detail=bad.find(m=>m.minGf===required);
  throw new Error(`${blastCavityText("损伤网格与断裂能不匹配：当前 Gf = ")}${settings.gf} J/m²；${detail.name} / E${detail.criticalElement}${blastCavityText(" 要求 Gf > ")}${Number(required.toPrecision(8))}${blastCavityText(" J/m²。请细化网格或检查已标定的强度、断裂能。")}`);
}
function refineBlastDamageInWorker(nodes,elements,properties,settings,signal,status){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const worker=new Worker('./src/core/blast-damage-mesh-worker.js');
    const finish=(error,result)=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();
      if(error)reject(error);else resolve(result);
    };
    const abort=()=>finish(new DOMException('Cancelled','AbortError'));
    const timer=setTimeout(()=>finish(new Error('损伤网格细化超过 60 秒，已停止；请缩小模型范围或检查材料参数。')),60000);
    signal?.addEventListener('abort',abort,{once:true});
    worker.onmessage=({data})=>{
      if(data.progress){
        status.textContent=`损伤网格细化：${data.progress.rounds} 轮 / ${data.progress.nodes} 节点 / ${data.progress.elements} 单元`;
      }else finish(data.error ? new Error(data.error) : null,data.result);
    };
    worker.onerror=event=>finish(new Error(event.message || '损伤网格细化失败。'));
    try{worker.postMessage({nodes,elements,properties,settings,boundarySegments:scene.analysisNodePlacement?.boundarySegments});}catch(error){finish(error);}
  });
}
async function ensureBlastDamageMeshReady(payload,model,settings,signal){
  const report=BlastFracture.inspect(model,settings);
  if(report.valid)return {payload,model};
  // Missing strengths require user input; only geometric incompatibility can
  // be repaired automatically without changing the material calibration.
  if(report.materials.some(m=>m.missingStrength))validateBlastFractureModel(model,settings);
  const status=document.getElementById('blastMeshStatus');
  status.textContent='正在按断裂能与抗拉强度细化损伤网格…';
  const signature=blastModelSignature(model),geometry=blastGeometrySignature();
  const properties=payload.elements.map((e,i)=>({id:e.id,elasticModulus:model.elements[i].elasticModulus,tensileStrength:model.elements[i].tensileStrength}));
  const result=await refineBlastDamageInWorker(scene.analysisNodes,scene.mesh.elements,properties,settings,signal,status);
  signal?.throwIfAborted();
  const current=calculationInputPayloadToDirectModel(buildCalculationInputExport({adaptive:false}));
  if(blastModelSignature(current)!==signature || blastGeometrySignature()!==geometry)throw new Error('模型在计算期间发生变化，请重新计算。');
  const metadata={...scene.mesh.metadata,algorithm:'triangle-damage-red-green-tri3',stale:false,adaptive:null,
    generatedAt:new Date().toISOString(),regionElementSets:[],
    counts:{...scene.mesh.metadata?.counts,nodes:result.analysisNodes.length,elements:result.elements.length},
    blastDamage:{gf:settings.gf,rounds:result.rounds}};
  // Rebuild placement sets instead of retaining node/edge IDs from the old mesh.
  const boundary=new Map(),regions=new Map();
  for(const e of result.elements){
    const id=e.regionId || e.structureRegionId;
    if(!regions.has(id))regions.set(id,new Set());
    for(const n of e.analysisNodeIds)regions.get(id).add(n);
    for(const edge of e.edges || [])if(edge.boundary && edge.curveId)boundary.set(adaptiveEdgeKey(...edge.nodeIds),edge);
  }
  const boundaryNodes=new Set([...boundary.values()].flatMap(e=>e.nodeIds)),byId=new Map(result.analysisNodes.map(n=>[n.id,n]));
  const sources=new Map((scene.analysisNodePlacement?.boundarySegments || []).map(s=>[s.curveId,s])),segments=new Map();
  for(const edge of boundary.values()){
    if(!segments.has(edge.curveId)){
      const curve=scene.curves.find(c=>c.id===edge.curveId);
      segments.set(edge.curveId,{...sources.get(edge.curveId),curveId:edge.curveId,curveType:curve?.type,
        mechanicalState:curve?.mechanicalState,length:0,byNode:new Map()});
    }
    const segment=segments.get(edge.curveId);segment.length+=edge.length;
    edge.nodeIds.forEach((id,i)=>{const n=byId.get(id);segment.byNode.set(id,{nodeId:id,t:edge.tRange?.[i] ?? 0,x:n.x,y:n.y});});
  }
  const boundarySegments=[...segments.values()].map(({byNode,...segment})=>{
    const samples=[...byNode.values()].sort((a,b)=>a.t-b.t);
    return {...segment,samples,nodeIds:samples.map(s=>s.nodeId)};
  });
  const placement={...scene.analysisNodePlacement,stale:false,generatedAt:metadata.generatedAt,
    counts:{...scene.analysisNodePlacement?.counts,analysisNodes:result.analysisNodes.length,boundarySegments:boundarySegments.length},
    boundarySegments,
    regionNodeSets:[...regions].map(([regionId,ids])=>{
      const region=regionById(regionId);
      return {regionId,regionKind:'structure',materialId:region?.materialId,materialName:region?.materialName,boundaryCurveIds:region?.boundaryCurveIds || [],
        nodeIds:[...ids],boundaryNodeIds:[...ids].filter(id=>boundaryNodes.has(id)),interiorNodeIds:[...ids].filter(id=>!boundaryNodes.has(id))};
    })};
  clearBlastHistory();
  setAnalysisMesh({...result,meshMetadata:metadata,analysisNodePlacement:placement});
  const nextPayload=buildCalculationInputExport({adaptive:false}),nextModel=calculationInputPayloadToDirectModel(nextPayload);
  validateBlastFractureModel(nextModel,settings);
  status.textContent=`损伤网格已兼容：${nextModel.nodes.length} 节点 / ${nextModel.elements.length} 单元；保留输入的强度与断裂能。`;
  return {payload:nextPayload,model:nextModel};
}
function initializeBlastFractureControls(){
  document.getElementById("blastFracture").addEventListener("change",()=>syncBlastFractureControls());
  document.getElementById("saveBlastStrengths").addEventListener("click",()=>saveBlastStrengthInputs().catch(error=>{document.getElementById("blastFractureStatus").textContent=blastErrorText(error.message);}));
}
