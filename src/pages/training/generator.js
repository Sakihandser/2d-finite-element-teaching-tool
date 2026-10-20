(function () {
  'use strict';
  const el=id=>document.getElementById(id);
  function resetSeed() {
    const now=new Date();
    el('generationSeed').value=[now.getFullYear(),now.getMonth()+1,now.getDate(),now.getHours(),now.getMinutes(),now.getSeconds()]
      .map((value,index)=>String(value).padStart(index===0?4:2,'0')).join('');
  }
  resetSeed();
  el('generationResetSeed').addEventListener('click',resetSeed);
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const states={running:'生成中',stopping:'完成当前工况后停止',stopped:'已停止',completed:'已完成',failed:'失败',interrupted:'已中断',
    generated:'已生成',imported:'已加入训练',duplicate:'已存在',rejected:'未达到目标，未导入','import-failed':'生成成功，导入失败'};
  const reasons={'target-error':'达到目标误差','iteration-limit':'加密轮数上限','node-budget':'节点预算上限',
    'time-limit':'每轮耗时上限','case-time-limit':'工况总耗时上限','local-size-limit':'局部尺寸限制','no-marked-elements':'无可细化单元'};
  let busy=false,generating=false,pending=false,refreshing=false,preview=null,previewOrigin=null,selectedJob='',jobOptions='',lastCompleted=null,casesContent='';
  let history={batches:0,cases:0,assigned:0},shownJob=null,deleteRequest=null;
  const assignmentChoices=new Map();
  const notice=(message,error=false)=>{el('generationNotice').textContent=message;el('generationNotice').style.color=error?'#a63226':'';};
  async function api(action,payload) {
    const response=await fetch('/api/training/generator/'+action,payload===undefined?{}:
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const result=await response.json();
    if(!response.ok) throw new Error(result.error||'数据生成请求失败。');
    return result;
  }
  function config() {
    const fields={geometries:'Geometries',conditions:'Conditions',maxPrimitives:'Primitives',maxRegions:'Regions',maxHoles:'Holes',
      validationFraction:'Validation',targetError:'Error',minSize:'MinSize',maxSize:'MaxSize',minForce:'MinForce',maxForce:'MaxForce',
      seedNodes:'SeedNodes',maxNodes:'MaxNodes',maxIterations:'Iterations',timeLimitSeconds:'TimeLimit',caseTimeLimitSeconds:'CaseTimeLimit'};
    const result=Object.fromEntries(Object.entries(fields).map(([key,suffix])=>[key,Number(el('generation'+suffix).value)]));
    return {...result,seed:el('generationSeed').value,
      shapes:[...document.querySelectorAll('[name=generationShape]:checked')].map(n=>n.value),
      loadTypes:[...document.querySelectorAll('[name=generationLoad]:checked')].map(n=>n.value),
      materialIds:el('generationMaterial').value?[el('generationMaterial').value]:undefined,
      autoImport:el('generationAutoImport').checked,importSplit:el('generationImportSplit').value,targetOnly:true,useGpuAcceleration:el('generationGpu').checked};
  }
  function controls() {
    el('generationStart').disabled=busy||pending||Boolean(window.trainingDashboard?.busy);
    el('generationPreview').disabled=pending;
    el('generationStop').disabled=!generating||pending;
    el('generationApply').disabled=!preview||pending;
    const locked=busy||pending||Boolean(window.trainingDashboard?.busy);
    el('generationDeleteAll').disabled=locked||!history.batches;
    el('generationDeleteAssigned').disabled=locked||!history.assigned;
    el('generationDeleteJob').disabled=locked||!shownJob;
    document.querySelectorAll('[data-generation-delete],[data-generation-assign],[data-generation-split]').forEach(button=>{button.disabled=locked;});
    document.querySelectorAll('.generation-parameters input,.generation-parameters select').forEach(input=>{input.disabled=pending||generating;});
    el('generationValidation').disabled=pending||generating||el('generationImportSplit').value!=='auto';
    el('generationImportSplit').disabled=pending||generating||!el('generationAutoImport').checked;
    el('generationResetSeed').disabled=pending||generating;
    window.trainingDashboard?.controls();
  }
  async function task(message,operation) {
    pending=true;controls();notice(message);
    try {await operation();}catch(error){notice(error.message,true);}
    finally{pending=false;controls();await refresh(true);}
  }
  function draw(data) {
    preview=data;previewOrigin=null;
    const canvas=el('generationCanvas'),ctx=canvas.getContext('2d'),nodes=data.geometryNodes;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(!nodes.length)return;
    const minX=Math.min(...nodes.map(n=>n.x)),maxX=Math.max(...nodes.map(n=>n.x)),minY=Math.min(...nodes.map(n=>n.y)),maxY=Math.max(...nodes.map(n=>n.y));
    const scale=Math.min((canvas.width-100)/(maxX-minX||1),(canvas.height-80)/(maxY-minY||1));
    const point=p=>({x:canvas.width/2+(p.x-(minX+maxX)/2)*scale,y:canvas.height/2-(p.y-(minY+maxY)/2)*scale});
    const byId=new Map(nodes.map(n=>[n.id,n]));
    for(const r of [...data.regions].sort((a,b)=>Number(a.isAir)-Number(b.isAir))) {
      const points=(r.polygon||[]).map(point);if(!points.length)continue;
      ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();
      ctx.fillStyle=r.isAir?'#f4f8fa':r.materialColor||r.material?.color||'#97c4ca';ctx.globalAlpha=r.isAir?1:.55;ctx.fill();ctx.globalAlpha=1;
    }
    for(const c of data.curves) {
      const [a,b]=c.geometryNodeIds.map(id=>point(byId.get(id)));
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=c.mechanicalState==='static'?'#167a5a':'#4c6675';ctx.lineWidth=c.mechanicalState==='static'?5:1.2;ctx.stroke();
    }
    for(const n of nodes.filter(n=>n.mechanicalState==='static')) {
      const p=point(n);ctx.fillStyle='#167a5a';ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x-5,p.y+10);ctx.lineTo(p.x+5,p.y+10);ctx.closePath();ctx.fill();
    }
    const arrow=(anchor,dx,dy,length=30,color='#b74f37')=>{
      const p=point(anchor),norm=Math.hypot(dx,dy)||1,v={x:dx/norm,y:-dy/norm},tail={x:p.x-v.x*length,y:p.y-v.y*length};
      ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1.8;ctx.beginPath();ctx.moveTo(tail.x,tail.y);ctx.lineTo(p.x,p.y);ctx.stroke();
      ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x-v.x*8-v.y*4,p.y-v.y*8+v.x*4);ctx.lineTo(p.x-v.x*8+v.y*4,p.y-v.y*8-v.x*4);ctx.closePath();ctx.fill();
    };
    for(const load of data.pointLoads)arrow(load.anchor,load.fx,load.fy,36);
    for(const load of data.distributedLoads) {
      const c=data.curves.find(c=>c.id===load.curveId);if(!c)continue;
      const [a,b]=c.geometryNodeIds.map(id=>byId.get(id));
      for(let i=0;i<5;i++){const t=i/4;arrow({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},load.direction.x,load.direction.y,15+18*((load.qStart*(1-t)+load.qEnd*t)/Math.max(load.qStart,load.qEnd)));}
    }
    for(const load of data.bodyLoads||[]) {
      const r=data.regions.find(r=>r.id===load.regionId&&!r.isAir)||data.regions.find(r=>!r.isAir);
      if(r?.centroid)arrow(r.centroid,load.direction.x,load.direction.y,30,'#7d61a9');
    }
    ctx.fillStyle='#59717d';ctx.font='12px sans-serif';ctx.fillText('绿色：固定支撑   红色：外载荷   紫色：体力',16,canvas.height-15);
    const meta=data.dataGeneration;
    el('generationPreviewInfo').textContent=meta?`${data.name} · ${meta.primitives.length} 个图形 · ${meta.regions} 个区域 · ${meta.holes} 个孔洞`:'已载入生成工况';
    controls();
  }
  function rows(job) {
    shownJob=job;
    const content=job?.cases.length?job.cases.map(row=>{
      const identity=job.id+'/'+row.key,choice=assignmentChoices.get(identity)||row.split||'train';
      const state=row.assigned?'已分配':row.status==='imported'||row.status==='duplicate'?'训练副本已删除，可重新分配':states[row.status]||row.status;
      const assign=!row.assigned&&row.hasReference?`<div class="generation-assignment"><select data-generation-split="${escape(identity)}" aria-label="${escape('分配用途 '+row.key)}"><option value="train" ${choice==='train'?'selected':''}>训练集</option><option value="validation" ${choice==='validation'?'selected':''}>验证集</option></select><button type="button" class="ghost-action" data-generation-assign="${escape(identity)}">分配</button></div>`:'';
      return `<tr><td>${escape(row.key)}</td><td>${row.assigned?(row.assignedSplit==='validation'?'验证集':'训练集'):'未分配'}${assign}</td><td>${escape(state)}${row.error?`<small>${escape(row.error)}</small>`:''}</td><td>${row.nodes?`${row.nodes} 节点 / ${row.elements} 单元`:'—'}</td><td>${row.errorEstimate!=null?(row.errorEstimate*100).toFixed(2)+'%':'—'}<small>${escape(reasons[row.stopReason]||row.stopReason||'')}</small></td><td>${row.hasReference&&row.downloadUrl?`<a href="${escape(row.downloadUrl)}">下载 JSON</a> · <button type="button" class="ghost-action" data-generation-preview="${escape(row.downloadUrl)}">预览</button> `:''}<button type="button" class="ghost-action training-danger" data-generation-delete="${escape(identity)}">删除</button></td></tr>`;
    }).join(''):'<tr><td colspan="6">尚未生成工况。</td></tr>';
    if(content!==casesContent){el('generationCases').innerHTML=content;casesContent=content;}
    el('generationManifest').hidden=!job;
    if(job)el('generationManifest').href='/api/training/generator/manifest/'+job.id;
    controls();
  }
  async function refresh(quiet=false) {
    if(refreshing)return;refreshing=true;
    try {
      const snapshot=await api('status');busy=snapshot.busy;generating=snapshot.generating??snapshot.busy;
      history=snapshot.history||history;
      el('generationHistorySummary').textContent=`${history.batches} 个批次 · ${history.cases} 个历史工况 · ${history.assigned} 个已分配`;
      const job=snapshot.current;
      const options=snapshot.jobs.map(j=>`<option value="${escape(j.id)}">${escape(new Date(j.createdAt).toLocaleString())} · ${escape(j.config.seed)} · ${escape(states[j.status]||j.status)}</option>`).join('')||'<option value="">尚无记录</option>';
      if(options!==jobOptions){el('generationJob').innerHTML=options;jobOptions=options;}
      if(!snapshot.jobs.some(j=>j.id===selectedJob))selectedJob=job?.id||'';
      el('generationJob').value=selectedJob;
      el('generationState').textContent=job?`${states[job.status]||job.status} · ${job.completed}/${job.total} · 已加入 ${job.imported} · 失败 ${job.failed}`:'尚未生成';
      el('generationProgress').max=job?.total||1;el('generationProgress').value=(job?.completed||0)+(job?.failed||0);
      if(job&&selectedJob===job.id)rows(job);
      else if(selectedJob)rows(await api('manifest/'+selectedJob));
      else rows(null);
      if(generating&&job&&!pending) {
        const stage={geometry:'生成几何',mesh:'生成参考网格',solve:'有限元求解',refine:'ZZ 自适应加密',import:'准备训练图'}[job.stage]||job.stage;
        notice(`${stage} · ${job.currentCase||'准备中'}${job.progress?.nodes?` · ${job.progress.nodes} 节点`:''}。已生成工况保存在本机，停止会等待当前工况完成。`);
      } else if(!pending&&!snapshot.managing&&job&&lastCompleted!==job.id+job.status) {
        lastCompleted=job.id+job.status;
        if(!quiet)notice(job.error||`批次${states[job.status]||job.status}：生成 ${job.completed}，加入训练 ${job.imported}，失败 ${job.failed}，未达标过滤 ${job.rejected}。`,Boolean(job.error));
        window.trainingDashboard?.refresh();
      }
      controls();
    }catch(error){notice(error.message,true);}finally{refreshing=false;}
  }
  el('generationPreview').addEventListener('click',()=>task('正在拼装几何、划分区域并生成物理条件…',async()=>{draw((await api('preview',config())).scene);notice('预览已更新。可开始批量求解，或载入结构页检查。');}));
  el('generationStart').addEventListener('click',()=>task('正在建立数据生成任务…',async()=>{const result=await api('start',config());selectedJob=result.id;busy=true;notice('批量生成已开始。');}));
  el('generationStop').addEventListener('click',()=>task('正在请求停止…',async()=>{await api('stop',{});notice('停止请求已提交，当前工况完成后停止。');}));
  el('generationImportSplit').addEventListener('change',controls);
  el('generationAutoImport').addEventListener('change',controls);
  el('generationApply').addEventListener('click',()=>{
    if(!preview)return;
    closeShapeEditor();scene=normalizeScene(structuredClone(preview));modelName.value=scene.name;
    selected=null;draft=null;hideRegionMaterialMenu();rebuildDerivedRegions({markAnalysisNodePlacementStale:false,markAnalysisMeshStale:false});
    updatePanel();setPage('home');resizeCanvas();fitViewToScene();render();
  });
  el('generationCases').addEventListener('click',event=>{
    const url=event.target.dataset.generationPreview,remove=event.target.dataset.generationDelete,assign=event.target.dataset.generationAssign;
    if(url)task('正在读取生成工况…',async()=>{const response=await fetch(url+'?preview=1');if(!response.ok)throw new Error('工况文件读取失败。');draw(await response.json());const parts=url.split('/');previewOrigin={jobId:parts.at(-2),key:parts.at(-1)};notice('工况预览已更新。');});
    if(remove){const[jobId,key]=remove.split('/');requestDelete({scope:'case',jobId,key});}
    if(assign){const[jobId,key]=assign.split('/'),row=shownJob?.cases.find(r=>r.key===key),split=assignmentChoices.get(assign)||row?.split||'train';
      task('正在分配历史工况并建立三种输入粗网格…',async()=>{const result=await api('assign',{jobId,key,split});await window.trainingDashboard?.refresh();notice(result.duplicate?'该工况已在训练库中，分配状态已更新。':'历史工况已成功分配。');});}
  });
  el('generationCases').addEventListener('change',event=>{const identity=event.target.dataset.generationSplit;if(identity)assignmentChoices.set(identity,event.target.value);});
  function clearDeletedPreview(result) {
    if(!previewOrigin)return;
    if(result.deletedJobs.includes(previewOrigin.jobId)||result.deletedCases.some(r=>r.jobId===previewOrigin.jobId&&r.key===previewOrigin.key)){
      preview=null;previewOrigin=null;el('generationCanvas').getContext('2d').clearRect(0,0,640,370);
      el('generationPreviewInfo').textContent='对应历史文件已删除，预览已清除。';controls();
    }
  }
  function requestDelete(payload) {
    task('正在核对历史生成文件…',async()=>{
      const impact=await api('delete-impact',payload);
      if(!impact.batches){notice('没有符合条件的历史生成数据。');return;}
      deleteRequest={...payload,token:impact.token};
      el('generationDeleteMessage').textContent='确认永久删除这些历史生成文件？源模型、参考模型、求解结果和对应历史记录将直接从磁盘删除，无法恢复。训练库中的独立副本与模型检查点保留。';
      const scopes={all:'所有历史生成数据',assigned:'已分配历史生成数据',job:'当前历史批次',case:'所选历史工况'};
      el('generationDeleteTarget').textContent=`${scopes[payload.scope]}\n${impact.batches} 个批次 · ${impact.cases} 个工况 · ${impact.files} 个文件 · ${(impact.bytes/1024**2).toFixed(2)} MiB`+(payload.jobId?'\n'+payload.jobId+(payload.key?' / '+payload.key:''):'');
      el('generationDeleteDialog').showModal();notice('历史删除清单已准备，请核对。');
    });
  }
  el('generationDeleteAll').addEventListener('click',()=>requestDelete({scope:'all'}));
  el('generationDeleteAssigned').addEventListener('click',()=>requestDelete({scope:'assigned'}));
  el('generationDeleteJob').addEventListener('click',()=>requestDelete({scope:'job',jobId:selectedJob}));
  el('generationCancelDelete').addEventListener('click',()=>el('generationDeleteDialog').close());
  el('generationDeleteDialog').addEventListener('close',()=>{if(deleteRequest){deleteRequest=null;notice('已取消删除。');}});
  el('generationConfirmDelete').addEventListener('click',()=>{
    const request=deleteRequest;deleteRequest=null;el('generationDeleteDialog').close();if(!request)return;
    task('正在永久删除历史生成文件…',async()=>{
      const result=await api('delete-history',request);clearDeletedPreview(result);shownJob=null;
      notice(`已删除 ${result.deletedCases.length} 个历史工况、${result.deletedJobs.length} 个完整批次。${result.failed.length?'部分历史文件删除失败，请重新查看清单后重试。':''}`,Boolean(result.failed.length));
    });
  });
  el('generationJob').addEventListener('change',()=>task('正在读取生成记录…',async()=>{selectedJob=el('generationJob').value;if(selectedJob)rows(await api('manifest/'+selectedJob));notice('生成记录已更新。');}));
  // Snapshot the actual material library through the existing read-only API.
  fetch('/api/materials').then(r=>r.json()).then(data=>{
    for(const material of data.materials||[])if(material.elasticModulus>0&&material.poissonRatio> -1&&material.poissonRatio<.49&&material.density>0){
      const option=document.createElement('option');option.value=material.id;option.textContent=material.name;el('generationMaterial').appendChild(option);
    }
  }).catch(()=>{});
  window.dataGenerator={get busy(){return busy||pending;},refresh};
  controls();refresh();setInterval(()=>{if(busy||currentPageKey()==='training')refresh();},2000);
})();
