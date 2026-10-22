// TNT is a source illustration. Wave contours and response boundaries use FEM
// results; this module does not infer pressure from explosive mass or chemistry.
let tntCurrentFrame = null;
const tntHistoryCache = new WeakMap();

function tntSourceState(settings, frame = null) {
  if (!settings || ![settings.x, settings.y, settings.radius, settings.pressure, settings.pulse].every(Number.isFinite) ||
      settings.radius <= 0 || settings.pulse <= 0 || settings.pressure < 0) return null;
  const chargeRadius=settings.chargeRadius ?? settings.radius;
  if(!Number.isFinite(chargeRadius) || chargeRadius<=0)return null;
  const time = frame ? Math.max(0, frame.time) : 0;
  const pressure = frame ? Math.max(0, frame.pressure) : 0;
  if (![time, pressure].every(Number.isFinite)) return null;
  const gasMode=settings.sourceMode===1,overpressure=Math.max(0,pressure-(settings.airPressure || 0));
  const ratio = gasMode ? overpressure/(overpressure+(settings.airPressure || 1)) : settings.pressure > 0 ? Math.min(1, pressure / settings.pressure) : 0;
  return {x:settings.x,y:settings.y,radius:chargeRadius,cavityRadius:settings.radius,airGap:Math.max(0,settings.radius-chargeRadius),time,pressure,ratio,
    phase:gasMode ? (!frame || time===0 ? "产物初态" : overpressure>(settings.airPressure || 1)*.01 ? "气体加载" : "空气传播中")
      : !frame || time === 0 ? "待起爆" : time < settings.pulse ? "压力脉冲" : "脉冲结束"};
}

function tntVisualizationVisible() {
  if (typeof isProfessionalCalculationEnabled === "function" && !isProfessionalCalculationEnabled("blast")) return false;
  return document.getElementById("showTntSource")?.checked !== false;
}

function drawTntSource(context, projector, settings, frame = null) {
  if (!tntVisualizationVisible()) return;
  const source = tntSourceState(settings, frame);
  if (!source) return;
  const p = projector(source), edge = projector({x:source.x + source.radius,y:source.y});
  const r = Math.hypot(edge.x-p.x,edge.y-p.y);
  if (!Number.isFinite(r) || r < .5) return;
  context.save();
  context.translate(p.x,p.y);
  const cavityEdge=projector({x:source.x+source.cavityRadius,y:source.y});
  const cavityR=Math.hypot(cavityEdge.x-p.x,cavityEdge.y-p.y);
  if(cavityR-r>1) {
    context.fillStyle="rgba(107,195,220,.12)";
    context.beginPath();context.arc(0,0,cavityR,0,Math.PI*2);context.arc(0,0,r,0,Math.PI*2,true);context.fill("evenodd");
    if(cavityR-r>24) {
      context.fillStyle="#42869a";context.font="11px Microsoft YaHei";context.textAlign="center";
      context.fillText("空气间隙",0,(cavityR+r)/2);
    }
  }
  // The dashed outline and bundled icon follow the charge radius; the annulus
  // between this outline and the mesh cavity represents the air gap.
  context.strokeStyle = source.ratio > 0 ? "#e78823" : "#b95b35";
  context.lineWidth = 1.6;
  context.setLineDash([4,3]);
  context.beginPath();context.arc(0,0,r,0,Math.PI*2);context.stroke();
  context.setLineDash([]);
  if (source.ratio > 0) {
    const glow = context.createRadialGradient(0,0,r*.3,0,0,r*(1.15+source.ratio*.6));
    glow.addColorStop(0,`rgba(255,225,125,${.25+.45*source.ratio})`);
    glow.addColorStop(1,"rgba(255,169,51,0)");
    context.fillStyle=glow;context.beginPath();context.arc(0,0,r*(1.15+source.ratio*.6),0,Math.PI*2);context.fill();
  }
  const size = Math.min(r*.60,38);
  const spent = source.phase === "脉冲结束";
  for (let j=-1;j<=1;j++) {
    const x=j*size*.48-size*.22,y=-size*.7+(j===0?-.1*size:0),w=size*.44,h=size*1.4;
    const gradient=context.createLinearGradient(x,0,x+w,0);
    gradient.addColorStop(0,spent ? "#4b4850" : "#9b302c");
    gradient.addColorStop(.45,spent ? "#8a7a70" : "#ee7860");
    gradient.addColorStop(1,spent ? "#5e5354" : "#ae3b32");
    context.fillStyle=gradient;context.strokeStyle=spent ? "#453d40" : "#8c332b";context.lineWidth=.8;
    context.beginPath();
    if(context.roundRect)context.roundRect(x,y,w,h,w*.44);else context.rect(x,y,w,h);
    context.fill();context.stroke();
  }
  // Two paper bands and a fuse make the small bundled-charge symbol legible.
  context.fillStyle=spent ? "#c8bca9" : "#f3dcb3";
  context.fillRect(-size*.73,-size*.4,size*1.46,size*.15);
  context.fillRect(-size*.73,size*.25,size*1.46,size*.15);
  context.strokeStyle="#65514a";context.lineWidth=1.8;
  context.beginPath();context.moveTo(0,-size*.82);context.quadraticCurveTo(size*.12,-size*1.22,size*.45,-size*1.02);context.stroke();
  if(source.ratio>0) {
    context.fillStyle="#fff1b0";context.strokeStyle="#f58c2f";
    context.beginPath();context.arc(size*.45,-size*1.02,2.5+source.ratio*2,0,2*Math.PI);context.fill();context.stroke();
  }
  if(r>=12) {
    context.fillStyle="#faf2d4";context.font=`800 ${Math.max(8,Math.min(12,size*.55))}px Segoe UI, sans-serif`;
    context.textAlign="center";context.textBaseline="middle";context.fillText("TNT",0,0);
  }
  context.restore();
}

function initializeTntVisualization() {
  const redraw=()=>{
    try { scene.blastSettings=readBlastControls(); } catch { return; }
    render();
  };
  for(const [id] of Object.values(BLAST_FIELDS)) document.getElementById(id)?.addEventListener("input",redraw);
  document.getElementById("showTntSource")?.addEventListener("change",()=>{render();renderResultView();});
  document.getElementById("showTntFront")?.addEventListener("change",renderResultView);
}

function tntHistoryMetrics(history) {
  let cached=tntHistoryCache.get(history);
  if(cached)return cached;
  let peak=0;
  if(Number.isFinite(history.peakDynamicStress))peak=history.peakDynamicStress;
  else for(const frame of history.frames) for(const e of frame.elements || []) {
    const [,,,sx,sy,txy]=e;
    peak=Math.max(peak,Math.sqrt(Math.max(0,sx*sx-sx*sy+sy*sy+3*txy*txy)));
  }
  const edgeMap=new Map();
  history.model.elements.forEach((element,index)=>{
    const nodes=element.nodeNumbers || [element.node1,element.node2,element.node3];
    for(let j=0;j<3;j++) {
      const a=nodes[j],b=nodes[(j+1)%3],key=a<b ? `${a}:${b}` : `${b}:${a}`;
      const edge=edgeMap.get(key) || {a,b,cells:[]};edge.cells.push(index);edgeMap.set(key,edge);
    }
  });
  cached={peak,threshold:peak*.03,edges:[...edgeMap.values()].filter(edge=>edge.cells.length===2)};
  tntHistoryCache.set(history,cached);
  return cached;
}

function tntResponseEdges(elements, metrics) {
  if(!(metrics.threshold>0))return [];
  const active=elements.map(e=>(e.dynamicEquivalentStress ?? e.equivalentStress)>=metrics.threshold);
  return metrics.edges.filter(edge=>active[edge.cells[0]]!==active[edge.cells[1]]);
}

function drawTntResultView() {
  if(!blastHistory || !calculationResultData.runInfo?.blastFrame) {
    resultCtx.fillStyle="#334155";resultCtx.fillText("暂无爆破损伤结果。",24,36);return;
  }
  const metrics=tntHistoryMetrics(blastHistory),range={min:0,max:metrics.peak || 1};
  const color=e=>resultColorForScalar(e.dynamicEquivalentStress ?? e.equivalentStress,range);
  if(!drawGpuResultMesh("tnt-stress",e=>gpuColor(color(e),.88),{stroke:[.12,.16,.23,.08],lineWidth:.35}))
    for(const element of calculationResultData.elements)drawResultElement(element.nodes,color(element),"rgba(30,41,59,.08)");
  resultCtx.save();
  if(document.getElementById("showTntFront")?.checked !== false) {
    resultCtx.strokeStyle="#8cf4ee";resultCtx.lineWidth=2;
    resultCtx.beginPath();
    for(const edge of tntResponseEdges(calculationResultData.elements,metrics)) {
      const a=resultWorldToScreen(calculationResultData.nodeByNo.get(edge.a));
      const b=resultWorldToScreen(calculationResultData.nodeByNo.get(edge.b));
      resultCtx.moveTo(a.x,a.y);resultCtx.lineTo(b.x,b.y);
    }
    resultCtx.stroke();
  }
  // Outline the computed highly damaged cells; no fabricated crack paths.
  resultCtx.strokeStyle="rgba(55,24,27,.65)";resultCtx.lineWidth=.9;resultCtx.beginPath();
  for(const e of calculationResultData.elements)if(e.damage>=.8) {
    e.nodes.forEach((n,i)=>{const p=resultWorldToScreen(n);if(i===0)resultCtx.moveTo(p.x,p.y);else resultCtx.lineTo(p.x,p.y);});
    resultCtx.closePath();
  }
  resultCtx.stroke();resultCtx.restore();
}

function drawTntResultOverlay() {
  if(!blastHistory || !calculationResultData?.runInfo?.blastFrame || !tntCurrentFrame)return;
  if(isResultTensorDashboard()) {
    // Match each dashboard's projector and clipping, including its deformation panel.
    resultDashboardPanels().forEach((panel,index)=>{
      const bounds=index===0 ? resultPanelBoundsCache.get(calculationResultData) || calculationResultData.baseBounds : calculationResultData.baseBounds;
      const projector=resultPanelProjector(panel,bounds);
      drawResultPanelClipped(panel,()=>drawTntSource(resultCtx,projector,blastHistory.settings,tntCurrentFrame));
    });
  } else if(activeResultView!=="safety") drawTntSource(resultCtx,resultWorldToScreen,blastHistory.settings,tntCurrentFrame);
}

function updateTntTimeline() {
  const canvas=document.getElementById("tntPressureChart"), label=document.getElementById("tntPhase");
  if(!canvas || !blastHistory || !tntCurrentFrame)return;
  const source=tntSourceState(blastHistory.settings,tntCurrentFrame);
  label.textContent=source.phase;
  const ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height,pad=12;
  ctx.clearRect(0,0,w,h);ctx.fillStyle="#102732";ctx.fillRect(0,0,w,h);
  ctx.strokeStyle="rgba(190,225,234,.2)";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad,h-pad);ctx.lineTo(w-pad,h-pad);ctx.stroke();
  const {pressure,pulse,duration}=blastHistory.settings;
  const gasMode=blastHistory.settings.sourceMode===1;
  const peak=gasMode ? Math.max(1,...blastHistory.frames.map(frame=>frame.pressure)) : pressure;
  ctx.strokeStyle="#ffb767";ctx.lineWidth=2;ctx.beginPath();
  // Draw the prescribed pulse analytically; the marker uses the saved frame pressure.
  const count=gasMode ? blastHistory.frames.length-1 : 180;
  for(let i=0;i<=count;i++) {
    const t=gasMode ? blastHistory.frames[i].time : duration*i/count;
    const value=gasMode ? blastHistory.frames[i].pressure/peak : pressure>0 && t<pulse ? Math.sin(Math.PI*t/pulse) : 0;
    const x=pad+(w-2*pad)*t/duration,y=h-pad-value*(h-2*pad);
    if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.stroke();
  const x=pad+(w-2*pad)*source.time/duration,y=h-pad-(peak>0 ? source.pressure/peak : 0)*(h-2*pad);
  ctx.strokeStyle="#8cf4ee";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,pad);ctx.lineTo(x,h-pad);ctx.stroke();
  ctx.fillStyle="#8cf4ee";ctx.beginPath();ctx.arc(x,y,3.5,0,2*Math.PI);ctx.fill();
}
