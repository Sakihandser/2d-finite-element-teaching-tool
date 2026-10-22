(function () {
  'use strict';
  const element = id => document.getElementById(id);
  const labels = { starting:'准备中', training:'训练中', pausing:'正在保存并暂停', paused:'已暂停', completed:'已完成',
    failed:'训练停止', recoverable:'可恢复', unavailable:'无检查点' };
  const reasons = { 'target-error':'达到目标误差', 'iteration-limit':'细化轮数上限', 'time-limit':'达到耗时上限', 'case-time-limit':'工况总耗时上限',
    'local-size-limit':'局部尺寸限制', 'manual-reference':'手动参考网格', 'no-marked-elements':'无可细化单元' };
  const checked = new Map();
  let snapshot = null, refreshing = false, pending = false, prediction = null, predictionSignature = null, runOptions = '';
  let preferredRun=null, managementRun=null, managementKey='', checkpointOptions='', checkpointRows=[];
  let deleteRequest=null;
  let storageRefreshed=0;
  let datasetRows='', datasetPreview=null, previewSequence=0;
  const text = (id,value) => { element(id).textContent = value; };
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count = value => Number(value || 0).toLocaleString();
  const loss = value => value == null ? '—' : Number(value).toPrecision(4);
  const percent = value => value == null ? '未知' : (value*100).toFixed(2)+'%';
  const notice = (message,error=false) => { text('trainingNotice',message); element('trainingNotice').classList.toggle('error',error); };
  const selectedIds = () => (snapshot?.datasets||[]).filter(sample=>checked.get(sample.id)).map(sample=>sample.id);
  const active = () => snapshot?.current && ['training','pausing','starting'].includes(snapshot.current.status);

  async function api(action,payload,method='POST') {
    const response = await fetch('/api/training/'+action,{ method,
      ...(method==='POST' ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(payload || {})} : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '训练请求失败');
    return result;
  }
  async function task(message,operation) {
    pending=true; controls(); notice(message);
    try { await operation(); }
    catch (error) { notice(error.message,true); }
    finally { pending=false; controls(); await refresh(); }
  }
  function controls() {
    const busy = active(), waiting=pending || !snapshot || Boolean(window.dataGenerator?.busy);
    for (const id of ['trainingStart','trainingResume','trainingImport','trainingImportScene','trainingImportPath','trainingPredict']) {
      element(id).disabled = waiting || Boolean(busy);
    }
    element('trainingPause').disabled = waiting || !busy || snapshot?.current?.status==='pausing';
    element('trainingSave').disabled = waiting || !snapshot?.current;
    element('trainingRun').disabled = waiting || Boolean(busy);
    element('trainingResume').disabled ||= !element('trainingRun').value;
    element('trainingPredict').disabled ||= !element('trainingRun').value;
    const noRun=!element('trainingRun').value;
    for(const id of ['trainingRename','trainingExportModel','trainingDeleteModel','trainingRefreshCheckpoints']) element(id).disabled=waiting || Boolean(busy) || noRun;
    element('trainingImportModel').disabled=waiting || Boolean(busy);
    element('trainingModelName').disabled=waiting || Boolean(busy) || noRun;
    element('trainingCheckpoint').disabled=waiting || Boolean(busy) || noRun;
    const point=checkpointRows.find(row=>row.file===element('trainingCheckpoint').value);
    element('trainingDeleteCheckpoint').disabled=waiting || Boolean(busy) || !point;
    element('trainingResumeCheckpoint').disabled=waiting || Boolean(busy) || !point?.valid;
    for(const id of ['trainingCleanExports','trainingCleanPredictions','trainingCleanLegacy']) element(id).disabled=waiting || Boolean(busy);
    if(point && !point.valid) { element('trainingResume').disabled=true; element('trainingPredict').disabled=true; }
    element('trainingDeleteDatasets').disabled=waiting || Boolean(busy) || !selectedIds().length;
    element('trainingChangeSplitApply').disabled=waiting || Boolean(busy) || !selectedIds().length;
    element('trainingChangeSplit').disabled=waiting || Boolean(busy);
    for(const id of ['trainingAdaptive','trainingLrPatience','trainingEarlyPatience'])element(id).disabled=waiting || Boolean(busy);
    document.querySelectorAll('[data-change-dataset-split]').forEach(button=>{button.disabled=waiting || Boolean(busy);});
    for(const id of ['trainingSelectAllData','trainingClearDataSelection']) element(id).disabled=pending || !snapshot?.datasets.length;
    document.querySelectorAll('[data-delete-dataset]').forEach(button=>{button.disabled=waiting || Boolean(busy);});
  }
  function chart(history) {
    const svg=element('trainingChart'), values=history.flatMap(row => [row.loss,row.validationLoss]).filter(v => v!=null && Number.isFinite(v));
    if (!values.length) { svg.innerHTML='<text x="380" y="118" text-anchor="middle" fill="#8796a0" font-size="13">完成一轮训练后显示学习曲线</text>'; return; }
    const min=Math.min(...values), max=Math.max(...values), range=Math.max(max-min,.00001);
    const x=index => 62+index/Math.max(history.length-1,1)*674;
    const y=value => 185-(value-min)/range*160;
    const boundaries=new Set();
    for(let i=1;i<history.length;i++)if((history[i].phase??0)!==(history[i-1].phase??0)||
      (history[i].phase==null&&history[i-1].phase==null&&Boolean(history[i].validationLoss!=null)!==Boolean(history[i-1].validationLoss!=null)))boundaries.add(i);
    let content='';
    for(let i=0;i<4;i++) { const v=min+range*i/3, py=y(v); content+=`<line x1="62" y1="${py}" x2="736" y2="${py}" stroke="#e5ecef"/><text x="52" y="${py+4}" text-anchor="end" fill="#86969f" font-size="10">${v.toPrecision(3)}</text>`; }
    for(const [key,color] of [['loss','#007c89'],['validationLoss','#b87819']]) {
      let points=[];
      const flush=()=>{
        if(points.length===1) { const [cx,cy]=points[0].split(','); content+=`<circle cx="${cx}" cy="${cy}" r="3" fill="${color}"/>`; }
        else if(points.length)content+=`<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
        points=[];
      };
      history.forEach((row,i)=>{if(boundaries.has(i)||!Number.isFinite(row[key]))flush();if(Number.isFinite(row[key]))points.push(`${x(i)},${y(row[key])}`);});flush();
    }
    for(const index of boundaries)content+=`<line x1="${x(index)}" y1="20" x2="${x(index)}" y2="185" stroke="#98a4ac" stroke-dasharray="4 4"><title>数据或评估口径调整</title></line>`;
    content+=`<text x="62" y="216" fill="#86969f" font-size="10">第 ${history[0].epoch} 轮</text><text x="736" y="216" text-anchor="end" fill="#86969f" font-size="10">第 ${history.at(-1).epoch} 轮</text>`;
    svg.innerHTML=content;
  }
  function renderDashboard() {
    const current=snapshot.current, runs=snapshot.runs;
    const selection=preferredRun || element('trainingRun').value;
    const selected=runs.some(r=>r.id===selection) ? selection : current?.id || runs[0]?.id || '';
    const options=runs.length ? runs.map(r=>`<option value="${escape(r.id)}">${escape(r.name)} [${escape(r.id.slice(0,8))}] · ${r.epoch} 轮 · ${escape(labels[r.status] || r.status)}</option>`).join('') : '<option value="">尚无记录</option>';
    if(options!==runOptions) { element('trainingRun').innerHTML=options; runOptions=options; }
    element('trainingRun').value=selected;
    if(selected===preferredRun) preferredRun=null;
    const run=current && (active() || current.id===selected) ? current : runs.find(r=>r.id===selected);
    if(managementRun!==selected) {
      managementRun=selected; managementKey=''; checkpointRows=[]; checkpointOptions='';
      element('trainingModelName').value=run?.name || '';
      element('trainingCheckpoint').innerHTML='<option value="">自动：续训用最新，预测优先最佳验证</option>';
      element('trainingCheckpointRows').innerHTML='<tr><td colspan="6">请选择模型以查看检查点。</td></tr>';
      element('trainingModelDownload').hidden=true;
    }
    const training=snapshot.datasets.filter(s=>s.split==='train'), validation=snapshot.datasets.filter(s=>s.split==='validation');
    text('trainingUnique',count(run?.seenIds?.length)); text('trainingSamples',count(run?.samplesSeen));
    text('trainingElements',count(run?.elementsSeen)); text('trainingSteps','优化步数 '+count(run?.step));
    text('trainingState',labels[run?.status] || '未开始');
    text('trainingEpoch',run ? `已完成 ${run.epoch} / ${run.config.epochs} 轮` : '已完成 0 轮');
    text('trainingDatasetCount',`训练集 ${training.length} · 验证集 ${validation.length}`);
    text('trainingDataSummary',snapshot.datasets.length+' 个独立工况');
    const env=snapshot.environment;
    const backend={cuda:'CUDA',rocm:'ROCm',directml:'DirectML',xpu:'Intel XPU',mps:'Metal',cpu:'CPU'}[env.backend] || env.backend;
    text('trainingDevice',`${env.deviceName || env.gpu || 'CPU'} · ${backend} · PyTorch ${env.torch}`);
    element('trainingDevice').title=[...(env.diagnostics || []),...(env.runtimeDiagnostics || [])].join('\n');
    text('trainingSaved',run?.lastSavedAt ? `已保存第 ${run.lastSavedStep} 步 · ${new Date(run.lastSavedAt).toLocaleTimeString()}（${run.id.slice(0,8)}）` : '尚无检查点');
    text('trainingLoss',`训练 ${loss(run?.loss)} · 验证 ${loss(run?.validationLoss)}`);
    text('trainingValidation',run?.diagnostics?.validationIntegrity==='previously-trained'?'验证几何曾参与训练，不能作为独立泛化验证':run?.validationIds?.length ? '验证工况独立于训练几何' : '尚无验证集，不能评估泛化能力');
    const diagnosis={learning:'当前未触发明显的拟合风险，继续观察验证趋势。','no-validation':'没有验证集；仅调整学习率，不自动判断过拟合或早停。','validation-leakage':'验证几何曾参与训练；已禁用基于该验证集的自动早停。','warming-up':'当前数据阶段轮数较少，继续观察趋势。','overfitting-risk':'存在过拟合风险：验证表现变差且明显落后于训练。','baseline-not-beaten':'尚未优于基础网格标签基线；可能训练不足、模型能力不足或标签存在差异。',plateau:'验证指标进入平台期，正在观察学习率调整效果。'};
    text('trainingDiagnosis',run?.stopReason==='early-stopping'?'已因验证指标持续未改善而早停；可使用最佳验证检查点预测。':diagnosis[run?.diagnostics?.code]||'完成一轮训练后显示诊断。');
    const metrics=run?.validationMetrics||run?.trainingMetrics;
    text('trainingMetrics',metrics?`标签对照：平均尺寸偏差因子 ${metrics.sizeFactor.toFixed(2)} · 偏粗区域 ${percent(metrics.coarserFraction)} · 偏细区域 ${percent(metrics.finerFraction)} · 基础网格损失 ${loss(metrics.baselineLoss)}`:'');
    const diagnostic=run?.diagnostics;
    text('trainingPolicyState',diagnostic?`当前学习率 ${diagnostic.learningRate.toPrecision(3)} · 训练几何 ${diagnostic.trainingGroups} · 验证几何 ${diagnostic.validationGroups}${diagnostic.smallValidation?' · 验证几何少于 3，诊断仅供参考。':''}`:'');
    chart(run?.history || []);
    renderDatasets();
    element('trainingLog').innerHTML=snapshot.events.length ? [...snapshot.events].reverse().map(event=>`<div><time>${new Date(event.at).toLocaleTimeString()}</time>${escape(event.message)}</div>`).join('') : '尚无训练操作记录。';
    if(run?.error && !pending) notice(run.error,true);
    controls();
  }
  function renderDatasets() {
    const available=new Set(snapshot.datasets.map(s=>s.id));
    for(const id of checked.keys())if(!available.has(id))checked.delete(id);
    if(datasetPreview&&!available.has(datasetPreview.sample.id))closeDatasetPreview();
    const content=snapshot.datasets.length ? snapshot.datasets.map(sample=> {
      if(!checked.has(sample.id)) checked.set(sample.id,true);
      const warning=sample.precisionSource==='user-assumed' ? '精度为人工假定值' : sample.stopReason!=='target-error' ? '实际误差；目标未确认达标' : '';
      return `<tr class="${datasetPreview?.sample.id===sample.id?'training-preview-selected':''}"><td><input type="checkbox" data-training-sample="${sample.id}" ${checked.get(sample.id)?'checked':''} aria-label="选择 ${escape(sample.name)}"></td><td><button class="training-dataset-name" type="button" data-preview-dataset="${sample.id}">${escape(sample.name)}</button><small>${sample.variants} 种粗网格${warning?' · '+escape(warning):''}</small></td><td>${sample.split==='train'?'训练':'验证'} <button class="ghost-action" type="button" data-change-dataset-split="${sample.id}">${sample.split==='train'?'改为验证集':'改为训练集'}</button></td><td>${count(sample.referenceNodes)}</td><td>${percent(sample.referenceError)}</td><td>${escape(reasons[sample.stopReason] || sample.stopReason)}</td><td><button class="ghost-action" type="button" data-preview-dataset="${sample.id}">预览</button> <button class="ghost-action training-danger" type="button" data-delete-dataset="${sample.id}">删除</button></td></tr>`;
    }).join('') : '<tr><td colspan="7">尚无样本，请先导入自适应模型 JSON。</td></tr>';
    if(content!==datasetRows){element('trainingDatasets').innerHTML=content;datasetRows=content;}
    text('trainingDataSelection',`已勾选 ${selectedIds().length} 个工况`);
  }
  function closeDatasetPreview() {
    previewSequence++;datasetPreview=null;element('trainingDatasetPreview').hidden=true;
    element('trainingDatasetCanvas').getContext('2d').clearRect(0,0,760,440);
  }
  function drawDatasetPreview() {
    if(!datasetPreview)return;
    const mesh=datasetPreview.meshes.find(m=>String(m.index)===element('trainingDatasetPreviewMesh').value);
    try { window.femTrainingPreview.draw(element('trainingDatasetCanvas'),datasetPreview.scene,mesh); }
    catch(error){text('trainingDatasetPreviewInfo','预览失败：'+error.message);return;}
    const sample=datasetPreview.sample;
    text('trainingDatasetPreviewTitle','工况模型预览：'+sample.name);
    text('trainingDatasetPreviewInfo',`${sample.split==='validation'?'验证':'训练'} · 参考误差 ${percent(sample.referenceError)} · ${reasons[sample.stopReason]||sample.stopReason} · ${mesh?`${count(mesh.nodes.length)} 节点 / ${count(mesh.triangles.length)} 单元`:'几何、材料与载荷'}${sample.precisionSource==='user-assumed'?' · 精度为人工假定值':''}`);
  }
  async function previewDataset(id) {
    if(datasetPreview?.sample.id===id){element('trainingDatasetPreview').hidden=false;drawDatasetPreview();return;}
    const sequence=++previewSequence;
    datasetPreview=null;element('trainingDatasetPreview').hidden=false;
    element('trainingDatasetCanvas').getContext('2d').clearRect(0,0,760,440);
    text('trainingDatasetPreviewTitle','工况模型预览');text('trainingDatasetPreviewInfo','正在读取工况模型…');
    try {
      const result=await api('dataset/'+encodeURIComponent(id)+'/preview',null,'GET');
      if(sequence!==previewSequence || !snapshot.datasets.some(s=>s.id===id))return;
      datasetPreview=result;
      element('trainingDatasetPreviewMesh').innerHTML='<option value="geometry">几何、材料与载荷</option>'+result.meshes.map(m=>`<option value="${m.index}">${m.kind==='reference'?'参考网格':'输入粗网格 '+m.index} · ${count(m.nodes.length)} 节点</option>`).join('');
      element('trainingDatasetPreviewMesh').value=result.meshes.length?String(result.meshes[0].index):'geometry';
      drawDatasetPreview();renderDatasets();controls();
    }catch(error){if(sequence===previewSequence)text('trainingDatasetPreviewInfo',error.message);}
  }
  async function refresh() {
    if(refreshing) return;
    refreshing=true;
    try { snapshot=await api('status',null,'GET'); renderDashboard(); await loadCheckpoints(); if(Date.now()-storageRefreshed>10000) await loadStorage(); if(!element('trainingNotice').dataset.connected) { notice('训练环境已连接。导入自适应模型后即可开始；小样本试训仅用于验证流程。'); element('trainingNotice').dataset.connected='true'; } }
    catch(error) { notice('训练服务连接失败：'+error.message,true); }
    finally { refreshing=false; }
  }
  async function loadCheckpoints(force=false) {
    const id=element('trainingRun').value;
    if(!id) return;
    const run=snapshot?.runs.find(r=>r.id===id), key=id+':'+run?.lastSavedAt;
    if(!force && key===managementKey) return;
    const result=await api('checkpoints',{runId:id});
    if(element('trainingRun').value!==id) return;
    checkpointRows=result.checkpoints; managementKey=key;
    const selected=element('trainingCheckpoint').value;
    const options='<option value="">自动：续训用最新，预测优先最佳验证</option>'+checkpointRows.map(row=>`<option value="${escape(row.file)}">${escape(row.file)} · ${count(row.step)} / ${count(row.epoch)}${row.valid?'':' · '+escape('不可读取')}</option>`).join('');
    if(options!==checkpointOptions) { element('trainingCheckpoint').innerHTML=options; checkpointOptions=options; }
    element('trainingCheckpoint').value=checkpointRows.some(row=>row.file===selected)?selected:'';
    element('trainingCheckpointRows').innerHTML=checkpointRows.length ? checkpointRows.map(row=>`<tr><td>${escape(row.file)}</td><td>${count(row.step)} / ${count(row.epoch)}</td><td>${loss(row.loss)}</td><td>${loss(row.validationLoss)}</td><td>${escape(row.lastSavedAt?new Date(row.lastSavedAt).toLocaleString():'—')}</td><td>${(row.bytes/1024**2).toFixed(2)} MiB${row.latest?' · '+escape('最新'):''}${row.best?' · '+escape('最佳验证'):''}${!row.valid?' · '+escape('不可读取'):''}</td></tr>`).join('') : '<tr><td colspan="6">尚无检查点</td></tr>';
    controls();
  }
  async function loadStorage() {
    const result=await api('storage-summary');
    for(const [key,id] of [['exports','trainingExportStorage'],['predictions','trainingPredictionStorage'],['legacy-deleted','trainingLegacyStorage']]) {
      text(id,`${count(result[key].count)} / ${(result[key].bytes/1024**2).toFixed(2)} MiB`);
    }
    storageRefreshed=Date.now();
  }
  const managementTask=(message,operation)=>task(message,async()=> { await operation(); managementKey=''; storageRefreshed=0; });
  element('trainingRename').addEventListener('click',()=>managementTask('正在重命名模型…',async()=> {
    await api('rename-model',{runId:element('trainingRun').value,name:element('trainingModelName').value}); notice('模型已重命名。');
  }));
  function confirmDelete(checkpoint) {
    const runId=element('trainingRun').value, checkpointFile=element('trainingCheckpoint').value;
    deleteRequest={action:checkpoint?'delete-checkpoint':'delete-model',payload:{runId,...(checkpoint?{checkpointFile}:{})}};
    text('trainingDeleteMessage',checkpoint?'永久删除选中的检查点？文件无法恢复，至少需要保留一个可用检查点。':'永久删除当前模型及其全部检查点？文件无法恢复，共享样本不会删除。');
    text('trainingDeleteTarget',checkpoint?checkpointFile:element('trainingModelName').value);
    element('trainingDeleteDialog').showModal();
  }
  element('trainingDeleteModel').addEventListener('click',()=>confirmDelete(false));
  element('trainingDeleteCheckpoint').addEventListener('click',()=>confirmDelete(true));
  function confirmCleanup(kind,target) {
    deleteRequest={action:'clean-storage',payload:{kind}};
    text('trainingDeleteMessage','永久清理此类别的全部暂存文件？文件无法恢复，模型检查点和训练样本不受影响。');
    text('trainingDeleteTarget',target);
    element('trainingDeleteDialog').showModal();
  }
  element('trainingCleanExports').addEventListener('click',()=>confirmCleanup('exports','暂存导出包'));
  element('trainingCleanPredictions').addEventListener('click',()=>confirmCleanup('predictions','预测 JSON'));
  element('trainingCleanLegacy').addEventListener('click',()=>confirmCleanup('legacy-deleted','历史删除残留'));
  element('trainingCancelDelete').addEventListener('click',()=>element('trainingDeleteDialog').close());
  element('trainingDeleteDialog').addEventListener('close',()=>{
    if(deleteRequest){deleteRequest=null;notice('已取消删除。');}
  });
  element('trainingConfirmDelete').addEventListener('click',()=> {
    const request=deleteRequest; deleteRequest=null; element('trainingDeleteDialog').close();
    if(!request) return;
    managementTask('正在删除选中内容…',async()=> {
      const result=await api(request.action,request.payload);
      if(request.action==='delete-datasets') {
        for(const id of result.deletedIds)checked.delete(id);
        if(datasetPreview&&result.deletedIds.includes(datasetPreview.sample.id))closeDatasetPreview();
        notice(`已永久删除 ${result.deletedIds.length} 个训练工况。${result.failed.length?'部分文件删除失败，请刷新列表后重试。':''}`,Boolean(result.failed.length));
        return;
      }
      if(request.action==='clean-storage' && request.payload.kind==='exports') {
        element('trainingModelDownload').hidden=true; element('trainingModelDownload').removeAttribute('href');
      }
      if(request.action==='clean-storage' && request.payload.kind==='predictions') {
        prediction=null; predictionSignature=null; element('trainingApply').disabled=true;
        element('trainingDownload').hidden=true; element('trainingDownload').removeAttribute('href'); text('trainingPrediction','');
      }
      notice('文件已永久删除。');
    });
  });
  element('trainingRefreshCheckpoints').addEventListener('click',()=>task('正在读取检查点…',async()=> { await loadCheckpoints(true); notice('检查点列表已更新。'); }));
  element('trainingCheckpoint').addEventListener('change',controls);
  element('trainingExportModel').addEventListener('click',()=>task('正在打包模型和训练样本…',async()=> {
    const result=await api('export-model',{runId:element('trainingRun').value});
    element('trainingModelDownload').href=result.downloadUrl; element('trainingModelDownload').hidden=false;
    storageRefreshed=0;
    notice('模型包已准备好，请点击“下载模型包”。');
  }));
  element('trainingImportModel').addEventListener('click',()=>element('trainingModelFile').click());
  element('trainingModelFile').addEventListener('change',event=> {
    const file=event.target.files[0]; event.target.value=''; if(!file) return;
    managementTask('正在导入模型并验证检查点和样本…',async()=> {
      const response=await fetch('/api/training/import-model',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
      const result=await response.json(); if(!response.ok) throw new Error(result.error);
      preferredRun=result.id; notice('模型已导入为独立记录，可继续训练或预测。');
    });
  });
  const importOptions = () => ({split:element('trainingSplit').value,referenceError:Number(element('trainingReferenceError').value)});
  async function upload(file,name) {
    const params=new URLSearchParams({...importOptions(),name:name || file.name});
    const response=await fetch('/api/training/import?'+params,{method:'POST',headers:{'Content-Type':'application/json'},body:file});
    const result=await response.json(); if(!response.ok) throw new Error(result.error);
    notice(result.duplicate ? '该工况已存在，未重复计数。' : '模型已导入，可在数据列表中选择训练用途。');
  }
  const geometry = () => Object.fromEntries(['version','name','geometryNodes','curves','regions','pointLoads','distributedLoads','bodyLoads'].map(key=>[key,structuredClone(scene[key])]));
  const signature = () => JSON.stringify(geometry());
  const policyOptions=()=>({adaptiveTraining:element('trainingAdaptive').checked,
    lrPatience:Number(element('trainingLrPatience').value),earlyStoppingPatience:Number(element('trainingEarlyPatience').value)});
  element('trainingStart').addEventListener('click',()=>task('正在建立训练任务（自动选择 GPU / CPU）…',async()=> {
    const result=await api('start',{datasetIds:selectedIds(),name:element('trainingName').value,device:'auto',...policyOptions(),
      epochs:Number(element('trainingEpochs').value),learningRate:Number(element('trainingLearningRate').value),
      width:Number(element('trainingWidth').value),layers:Number(element('trainingLayers').value),autosaveSeconds:Number(element('trainingAutosave').value)});
    preferredRun=result.id;
    notice('训练已开始。切换标签页不会中断训练；暂停会先保存检查点。');
  }));
  element('trainingPause').addEventListener('click',()=>task('正在请求保存并暂停…',async()=> { await api('pause'); notice('正在完成当前训练步并保存，状态变为“已暂停”后可关闭程序。'); }));
  element('trainingSave').addEventListener('click',()=>task('正在请求保存检查点…',async()=> { await api('save'); notice('保存请求已提交，请查看检查点步数和训练记录。'); }));
  const resume=()=>task('正在恢复模型、优化器与训练进度…',async()=> {
    const checkpointFile=element('trainingCheckpoint').value;
    const result=await api('resume',{runId:element('trainingRun').value,checkpointFile:checkpointFile || undefined,datasetIds:selectedIds(),additionalEpochs:Number(element('trainingEpochs').value),...policyOptions()});
    preferredRun=result.id; notice(checkpointFile?'已从指定检查点创建训练分支。':'已恢复训练。');
  });
  element('trainingResume').addEventListener('click',resume);
  element('trainingResumeCheckpoint').addEventListener('click',resume);
  element('trainingRun').addEventListener('change',()=> { renderDashboard(); loadCheckpoints().catch(error=>notice(error.message,true)); });
  element('trainingDatasets').addEventListener('change',event=> {
    const id=event.target.dataset.trainingSample;if(!id)return;
    checked.set(id,event.target.checked);renderDatasets();controls();
    if(event.target.checked)previewDataset(id);
  });
  function requestDatasetDelete(ids) {
    if(!ids.length)return;
    task('正在核对工况文件与训练记录的关联…',async()=>{
      const impact=await api('dataset-delete-impact',{datasetIds:ids});
      deleteRequest={action:'delete-datasets',payload:{datasetIds:ids,token:impact.token,allowReferenced:impact.dependencies.length>0}};
      const dependency=impact.dependencies.length?'被以下训练记录引用：'+impact.dependencies.map(r=>r.name).join('、')+'。删除后将无法完整恢复原任务的数据与读取进度，或导出包含原数据的完整模型包；权重仍可预测，也可用于后续训练，但当前恢复入口要求原数据。'+(impact.dependencies.some(r=>r.unreadableFiles.length)?'部分检查点不可读取，无法确认其数据依赖。':''):'';
      text('trainingDeleteMessage','永久删除所选工况的整个训练数据目录（参考模型、训练图和元数据）？文件无法恢复。原始导入 JSON 和生成批次文件保留。'+dependency);
      text('trainingDeleteTarget',impact.samples.map(s=>s.name+' ['+s.id.slice(0,8)+']').join('\n')+`\n${impact.files} 个文件 · ${(impact.bytes/1024**2).toFixed(2)} MiB`);
      element('trainingDeleteDialog').showModal();
      notice('删除清单已准备，请在确认框中核对。');
    });
  }
  element('trainingDatasets').addEventListener('click',event=>{
    const previewId=event.target.dataset.previewDataset,deleteId=event.target.dataset.deleteDataset;
    if(previewId)previewDataset(previewId);
    if(deleteId)requestDatasetDelete([deleteId]);
    const changeId=event.target.dataset.changeDatasetSplit;
    if(changeId){const sample=snapshot.datasets.find(s=>s.id===changeId);if(sample)return changeDatasetSplit([changeId],sample.split==='train'?'validation':'train');}
  });
  function changeDatasetSplit(ids,split) {
    if(!ids.length)return;
    return task('正在更改学习用途…',async()=>{
      const result=await api('change-dataset-split',{datasetIds:ids,split});
      if(datasetPreview&&result.updatedIds.includes(datasetPreview.sample.id)) {datasetPreview.sample.split=split;drawDatasetPreview();}
      await window.dataGenerator?.refresh();
      notice(`已更改 ${result.updatedIds.length} 个工况的学习用途，同一几何的工况同步更改。`);
    });
  }
  element('trainingChangeSplitApply').addEventListener('click',()=>changeDatasetSplit(selectedIds(),element('trainingChangeSplit').value));
  element('trainingSelectAllData').addEventListener('click',()=>{for(const s of snapshot.datasets)checked.set(s.id,true);renderDatasets();controls();});
  element('trainingClearDataSelection').addEventListener('click',()=>{for(const s of snapshot.datasets)checked.set(s.id,false);renderDatasets();controls();});
  element('trainingDeleteDatasets').addEventListener('click',()=>requestDatasetDelete(selectedIds()));
  element('trainingDatasetPreviewMesh').addEventListener('change',drawDatasetPreview);
  element('trainingCloseDatasetPreview').addEventListener('click',()=>{closeDatasetPreview();renderDatasets();});
  element('trainingImport').addEventListener('click',()=>element('trainingFiles').click());
  element('trainingFiles').addEventListener('change',event=> {
    const files=[...event.target.files]; event.target.value='';
    if(files.length) task('正在导入模型并建立三种粗网格，请稍候…',async()=> { for(const file of files) await upload(file); });
  });
  element('trainingImportScene').addEventListener('click',()=>task('正在提取当前模型的几何与自适应参考网格…',async()=> {
    syncRegionMaterialSnapshots();
    await upload(new Blob([JSON.stringify(scene)],{type:'application/json'}),scene.name || '当前模型');
  }));
  element('trainingImportPath').addEventListener('click',()=>task('正在读取本机 JSON 并准备训练样本…',async()=> {
    const result=await api('import-path',{path:element('trainingPath').value,...importOptions()});
    notice(result.duplicate?'该工况已存在，未重复计数。':'模型已导入。');
  }));
  element('trainingPredict').addEventListener('click',()=>task('正在预测当前模型的局部尺寸并生成约束网格…',async()=> {
    syncRegionMaterialSnapshots(); predictionSignature=signature();
    const result=await api('predict',{scene:geometry(),runId:element('trainingRun').value,checkpointFile:element('trainingCheckpoint').value || undefined,targetError:Number(element('predictionError').value),maxNodes:Number(element('predictionNodes').value)});
    const response=await fetch(result.downloadUrl+'?preview=1');
    if(!response.ok) throw new Error('无法读取预测网格。');
    prediction=await response.json();
    text('trainingPrediction',`已生成 ${count(result.nodes)} 个节点、${count(result.elements)} 个单元。${result.stopReason==='node-budget'?'达到节点预算，已保留上一张网格。':''}尚未进行误差验算。`);
    element('trainingApply').disabled=false;
    element('trainingDownload').href=result.downloadUrl; element('trainingDownload').hidden=false;
    storageRefreshed=0;
    notice('预测网格已生成，可下载或应用到计算页。');
  }));
  element('trainingApply').addEventListener('click',()=> {
    if(!prediction) return;
    if(signature()!==predictionSignature) { notice('当前模型已改变，请重新预测后再应用。',true); return; }
    scene=normalizeScene(prediction); rebuildDerivedRegions({markAnalysisNodePlacementStale:false});
    classifyAnalysisNodes(); classifyAnalysisElements(); updatePanel(); render(); setPage('calculation'); fitCalculationViewToScene();
    notice('预测节点已应用，可在计算页求解验算。');
  });
  window.trainingDashboard={refresh,controls,get busy(){return pending || active();}};
  controls();
  setInterval(()=> { if(currentPageKey()==='training') refresh(); },1500);
})();
