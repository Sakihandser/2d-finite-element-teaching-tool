// Portable result documents shared by the browser and the local streaming service.
(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;else root.ResultExport=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const encoder=new TextEncoder();
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function csv(rows){
    return '\uFEFF'+rows.map(row=>row.map(value=>{
      if(typeof value==='number')return Number.isFinite(value)?String(value):'';
      let text=String(value??'');
      if(/^[\s]*[=+@-]/.test(text))text="'"+text;
      return '"'+text.replace(/"/g,'""')+'"';
    }).join(',')).join('\r\n')+'\r\n';
  }
  const stressKeys=['stressXx','stressYy','stressXy','stressYx','stressZz','equivalentStress','dynamicEquivalentStress'];
  const strainKeys=['strainXx','strainYy','strainXy','strainYx','equivalentStrain','plasticStrain'];
  function fields(data){
    const list=[['displacementMagnitude','Displacement magnitude','model'],['stressXx','Stress xx','Pa'],['stressYy','Stress yy','Pa'],['stressXy','Stress xy','Pa'],['equivalentStress','Equivalent stress','Pa'],['strainXx','Strain xx','1'],['strainYy','Strain yy','1'],['strainXy','Tensor strain xy','1'],['equivalentStrain','Equivalent strain','1']];
    if(data.blast)list.push(['damage','Damage','1'],['dynamicEquivalentStress','Dynamic equivalent stress','Pa']);
    else list.push(['safetyCode','Safety code','1']);
    if(data.elements.some(e=>e.stressZz!==undefined))list.push(['stressZz','Stress zz','Pa'],['plasticStrain','Equivalent plastic strain','1']);
    return list.map(([key,title,unit])=>({key,title,unit}));
  }
  function tables(data){
    const nodeKeys=['ux','uy','displacementMagnitude',...(data.blast?['vx','vy','speed']:[])];
    const elementKeys=[...strainKeys,...stressKeys,...(data.blast?['damage','plasticWorkDensity']:['safetyCode','safetyText'])].filter(k=>data.elements.some(e=>e[k]!==undefined));
    return [
      {name:'nodes.csv',text:csv([['node_id','x [model]','y [model]',...nodeKeys.map(k=>`${k} [${['vx','vy','speed'].includes(k)?'m/s':'model'}]`),'fixUx','fixUy','forceX [N]','forceY [N]'],...data.nodes.map(n=>[n.nodeNo,n.x,n.y,...nodeKeys.map(k=>n[k]),n.fixUx,n.fixUy,n.forceX,n.forceY])])},
      {name:'elements.csv',text:csv([['element_id','node_1','node_2','node_3','material_id',...elementKeys.map(k=>`${k}${stressKeys.includes(k)?' [Pa]':strainKeys.includes(k)||k==='damage'?' [1]':k==='plasticWorkDensity'?' [J/m3]':''}`)],...data.elements.map(e=>[e.elementNo,...e.nodeNumbers,e.materialNo,...elementKeys.map(k=>e[k])])])},
    ];
  }
  function blastData(model,frame,baseline){
    const nodes=model.nodes.map((n,i)=>({...n,ux:frame.u[2*i],uy:frame.u[2*i+1],vx:frame.v[2*i],vy:frame.v[2*i+1],displacementMagnitude:Math.hypot(frame.u[2*i],frame.u[2*i+1]),speed:Math.hypot(frame.v[2*i],frame.v[2*i+1])}));
    const byNo=new Map(nodes.map(n=>[n.nodeNo,n]));
    const equivalent=(x,y,z,xy)=>Math.sqrt(Math.max(0,x*x+y*y+z*z-x*y-y*z-z*x+3*xy*xy));
    const elements=model.elements.map((e,i)=>{
      const [ex,ey,gxy,sx,sy,txy,damage,sz=0,plasticStrain,plasticWorkDensity]=frame.elements[i],b=baseline.elements[i];
      return {...e,nodes:e.nodeNumbers.map(id=>byNo.get(id)),strainXx:ex,strainYy:ey,strainXy:gxy/2,strainYx:gxy/2,stressXx:sx,stressYy:sy,stressXy:txy,stressYx:txy,
        ...(frame.elements[i].length>7?{stressZz:sz,plasticStrain,plasticWorkDensity}:{}),damage,equivalentStress:equivalent(sx,sy,sz,txy),dynamicEquivalentStress:equivalent(sx-b[3],sy-b[4],sz-(b[7]??0),txy-b[5]),equivalentStrain:Math.sqrt(Math.max(0,ex*ex-ex*ey+ey*ey+.75*gxy*gxy))};
    });
    return {modelName:model.modelName,nodes,elements,blast:true,time:frame.time};
  }
  function color(t){t=Math.max(0,Math.min(1,t));return `rgb(${Math.round(255*t)},${Math.round(200*(1-Math.abs(2*t-1)))},${Math.round(255*(1-t))})`;}
  function svg(data,field){
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const n of data.nodes){minX=Math.min(minX,n.x);minY=Math.min(minY,n.y);maxX=Math.max(maxX,n.x);maxY=Math.max(maxY,n.y);}
    if(!Number.isFinite(minX))throw new Error('No result nodes to export.');
    const scale=Math.min(960/Math.max(maxX-minX,1e-12),630/Math.max(maxY-minY,1e-12));
    const project=n=>`${(60+(n.x-minX)*scale).toFixed(3)},${(740-(n.y-minY)*scale).toFixed(3)}`;
    const value=e=>field.key==='displacementMagnitude'?Math.max(...e.nodes.map(n=>n.displacementMagnitude)):e[field.key];
    let min=Infinity,max=-Infinity;for(const e of data.elements){const v=value(e);if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);}}
    if(min===Infinity){min=0;max=0;}
    const number=n=>Number(n).toExponential(5);
    const polygons=data.elements.map(e=>{const v=value(e);return `<polygon points="${e.nodes.map(project).join(' ')}" fill="${Number.isFinite(v)?color(max===min?.5:(v-min)/(max-min)):'#aaa'}"><title>Element ${escape(e.elementNo)}: ${escape(v)}</title></polygon>`;}).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="white"/><g font-family="Arial, sans-serif" fill="#172b40"><text x="60" y="35" font-size="23">${escape(field.title)} [${escape(field.unit)}]</text><text x="60" y="65" font-size="16">${escape(data.modelName||'Result')}${data.time!==undefined?' | t = '+number(data.time)+' s':''}</text><text x="60" y="90" font-size="14">Original geometry | x, y: model coordinates | ${field.key==='displacementMagnitude'?'Element maximum of nodal displacement':'Element values'}</text><g stroke="none">${polygons}</g><text x="60" y="780" font-size="14">x: ${number(minX)} ... ${number(maxX)} | y: ${number(minY)} ... ${number(maxY)} | deformation scale = 1 (reference mesh)</text><defs><linearGradient id="legend" x1="0" y1="1" x2="0" y2="0"><stop stop-color="${color(0)}"/><stop offset="50%" stop-color="${color(.5)}"/><stop offset="100%" stop-color="${color(1)}"/></linearGradient></defs><rect x="1070" y="140" width="30" height="530" fill="url(#legend)"/>${[0,.25,.5,.75,1].map(t=>`<text x="1110" y="${675-530*t}" font-size="15">${number(min+t*(max-min))}</text>`).join('')}</g></svg>`;
  }
  function report(data,files,description){
    return '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>计算结果</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto;padding:0 20px}img{width:100%;border:1px solid #ddd}a{color:#155e9b}</style><h1>'+escape(data.modelName||'计算结果')+'</h1><p>'+escape(description)+'</p><p>CSV 为 UTF-8（带 BOM），可用 Excel、WPS 或数据分析软件打开。SVG 为矢量云图，可用浏览器打开或插入报告。数值保留原始精度；缺失值留空。应力单位 Pa，应变无量纲，坐标和位移沿用模型单位（爆破模型应使用 m），速度 m/s，时间 s。爆破按单位厚度计算：汇总能量 J/m、气体质量 kg/m、裂隙容积 m²（每米厚度）；单元塑性功密度 J/m³。εxy 为张量剪应变，工程剪应变 γxy = 2 εxy。</p><p>云图使用原始网格，每张图独立色标；位移图为每个单元三个节点位移幅值的最大值。不同时间的云图不可仅按颜色比较。基础计算的等效应力、应变和安全代码沿用求解结果；安全代码 0 表示通过，其他代码请结合 safetyText。爆破动态等效应力为相对初始帧的应力增量，损伤 0 完好、1 完全损伤。</p><ul>'+files.map(name=>'<li><a href="'+escape(name)+'">'+escape(name)+'</a></li>').join('')+'</ul>'+files.filter(n=>n.endsWith('.svg')).map(name=>'<figure><img src="'+escape(name)+'"><figcaption>'+escape(name)+'</figcaption></figure>').join('')+'</html>';
  }
  async function* documents(data){
    const entries=tables(data);
    entries.push({name:'model.json',text:JSON.stringify(data.input,null,2)},{name:'result.json',text:JSON.stringify(data.result,null,2)});
    for(const f of fields(data))entries.push({name:`figures/${f.key}.svg`,text:svg(data,f)});
    yield {name:'index.html',text:report(data,entries.map(e=>e.name),'基础计算结果；导出时间 '+new Date().toISOString())};
    yield* entries;
  }
  const summaryUnits={time:'s',pressure:'Pa',kineticEnergy:'J/m',strainEnergy:'J/m',externalWork:'J/m',dissipatedEnergy:'J/m',maxStress:'Pa',maxDynamicStress:'Pa',gasInternalEnergy:'J/m',gasKineticEnergy:'J/m',gasWallWork:'J/m',gasWallRadius:'m',plasticWork:'J/m',crackVolume:'m2',gasStorageWork:'J/m',maxStrain:'1',actualSteps:'1',minimumJacobian:'1',gasRarefactionFallbacks:'1',maximumCflRatio:'1',gasVentedMass:'kg/m',gasVentedEnergy:'J/m',gasProductMass:'kg/m',gasAirMass:'kg/m'};
  async function* blastDocuments(model,manifest,readFrame,selected){
    const baseline=await readFrame(0),current=selected===0?baseline:await readFrame(selected),data=blastData(model,current,baseline);
    const names=['history.csv','model.json','settings.json'];
    for(let i=0;i<manifest.frames.length;i++)for(const name of ['nodes','elements'])names.push(`frames/frame_${String(i).padStart(4,'0')}_${name}.csv`);
    for(const f of fields(data))names.push(`figures/frame_${String(selected).padStart(4,'0')}_${f.key}.svg`);
    yield {name:'index.html',text:report(data,names,`爆破结果：共 ${manifest.frames.length} 个保存帧，云图对应帧 ${selected}（从 0 编号），t = ${current.time} s。history.csv 给出帧编号与物理时间。导出时间 ${new Date().toISOString()}`)};
    const keys=Object.keys(summaryUnits).filter(k=>manifest.frames.some(f=>f[k]!==undefined));
    yield {name:'history.csv',text:csv([['frame_index',...keys.map(k=>`${k} [${summaryUnits[k]}]`)],...manifest.frames.map((f,i)=>[i,...keys.map(k=>f[k])])])};
    yield {name:'model.json',text:JSON.stringify(model,null,2)};
    yield {name:'settings.json',text:JSON.stringify(manifest.settings,null,2)};
    for(const f of fields(data))yield {name:`figures/frame_${String(selected).padStart(4,'0')}_${f.key}.svg`,text:svg(data,f)};
    for(let i=0;i<manifest.frames.length;i++){
      const frame=i===0?baseline:await readFrame(i);
      for(const entry of tables(blastData(model,frame,baseline)))yield {name:`frames/frame_${String(i).padStart(4,'0')}_${entry.name}`,text:entry.text};
    }
  }
  // Standard ZIP (UTF-8 names, CRC32, central directory). One file at a time;
  // the server optionally deflates entries without collecting the full history.
  const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
  function record(size,values){const bytes=new Uint8Array(size),v=new DataView(bytes.buffer);for(const [offset,width,value] of values)v[width===2?'setUint16':'setUint32'](offset,value,true);return bytes;}
  async function* archive(entries,compress){
    let offset=0;const central=[];
    for await(const entry of entries){
      const name=encoder.encode(entry.name),raw=entry.bytes||encoder.encode(entry.text),body=compress?await compress(raw):raw,method=compress?8:0,crc=crc32(raw);
      if(offset+30+name.length+body.length>0xffffffff || raw.length>0xffffffff || central.length>=65535)throw new Error('Export exceeds ZIP limits (4 GiB / 65535 files).');
      const local=record(30,[[0,4,0x04034b50],[4,2,20],[6,2,0x800],[8,2,method],[12,2,33],[14,4,crc],[18,4,body.length],[22,4,raw.length],[26,2,name.length]]);
      central.push([record(46,[[0,4,0x02014b50],[4,2,20],[6,2,20],[8,2,0x800],[10,2,method],[14,2,33],[16,4,crc],[20,4,body.length],[24,4,raw.length],[28,2,name.length],[42,4,offset]]),name]);
      yield local;yield name;yield body;offset+=local.length+name.length+body.length;
    }
    const start=offset;for(const parts of central)for(const part of parts){yield part;offset+=part.length;}
    if(offset+22>0xffffffff)throw new Error('Export exceeds ZIP limit (4 GiB).');
    yield record(22,[[0,4,0x06054b50],[8,2,central.length],[10,2,central.length],[12,4,offset-start],[16,4,start]]);
  }
  return {csv,tables,fields,svg,blastData,documents,blastDocuments,archive};
});
