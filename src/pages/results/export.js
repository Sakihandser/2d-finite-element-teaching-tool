// Export snapshots independently of zoom, display layers and playback rendering.
function resultExportName(data){return (data.modelName||'results').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80);}
async function resultExportAction(button,action){
  if(button.disabled)return;
  button.disabled=true;
  try{await action();}catch(error){console.error(error);setResultStatus('导出失败：'+error.message);}finally{button.disabled=false;}
}
function initializeResultExports(){
  const button=document.getElementById('exportCalculationResults');
  button.addEventListener('click',()=>resultExportAction(button,async()=>{
    const data=calculationResultData;
    if(!data?.nodes?.length)throw new Error('请先完成计算或读取结果。');
    const handle=await chooseExportFile(resultExportName(data)+'-results.zip','application/zip','.zip');
    if(!handle)return;
    setResultStatus('正在生成结果表格与云图…');
    await writeExportChunks(handle,ResultExport.archive(ResultExport.documents(data)));
    setResultStatus('结果包已生成，解压后打开 index.html 查看表格和云图。');
  }));
  const png=document.getElementById('exportResultPng');
  png.addEventListener('click',()=>resultExportAction(png,async()=>{
    let data=calculationResultData;
    if(!data?.nodes?.length)throw new Error('请先完成计算或读取结果。');
    let suffix='';
    const index=Number(document.getElementById('blastFrame').value);
    if(activeResultChannel==='blast')suffix='-frame_'+String(index).padStart(4,'0');
    const handle=await chooseExportFile(resultExportName(data)+suffix+'-png.zip','application/zip','.zip');
    if(!handle)return;
    if(activeResultChannel==='blast'){
      const history=blastHistory;
      const [frame,baseline]=await Promise.all([fetchBlastFrame(history,index),fetchBlastFrame(history,0)]);
      data=ResultExport.blastData(history.model,frame,baseline);suffix='-frame_'+String(index).padStart(4,'0');
    }
    const keys=activeResultView==='stress'?['stressXx','stressXy','stressYy','equivalentStress']:activeResultView==='strain'?['strainXx','strainXy','strainYy','equivalentStrain']:activeResultView==='damage'||activeResultView==='tnt'?['damage']:activeResultView==='safety'?['safetyCode']:['displacementMagnitude'];
    const entries=[];
    for(const field of ResultExport.fields(data).filter(f=>keys.includes(f.key))){
      const source=ResultExport.svg(data,field),url=URL.createObjectURL(new Blob([source],{type:'image/svg+xml'}));
      try{
        const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('云图图片转换失败。'));img.src=url;});
        const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=1500;
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        if(!blob)throw new Error('云图图片转换失败。');
        entries.push({name:field.key+suffix+'.png',bytes:new Uint8Array(await blob.arrayBuffer())});
      }finally{URL.revokeObjectURL(url);}
    }
    await writeExportChunks(handle,ResultExport.archive(entries));
    setResultStatus('PNG 云图已导出（2400 × 1500，含单位、色标与帧时间）。');
  }));
}
