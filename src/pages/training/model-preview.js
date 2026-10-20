(function () {
  'use strict';
  // Scene-local curve sampling keeps previews independent from the drawing
  // model. Pure curve evaluators are shared with the original geometry engine.
  function curvePoint(curve, nodes, t) {
    const [a,b]=curve.geometryNodeIds.map(id=>nodes.get(id));
    if(!a||!b)return null;
    const controls=curve.controls||[],middle=lerpPoint(a,b,.5);
    if(curve.type==='quadratic')return quadraticPoint(a,controls[0]||middle,b,t);
    if(curve.type==='cubic')return cubicPoint(a,controls[0]||lerpPoint(a,b,.33),controls[1]||lerpPoint(a,b,.67),b,t);
    if(curve.type==='arc')return arcPoint(a,controls[0]||middle,b,t);
    if(curve.type==='ellipse')return rationalQuadraticPoint(a,controls[0]||middle,b,t);
    return lerpPoint(a,b,t);
  }
  function draw(canvas,data,mesh=null) {
    const ctx=canvas.getContext('2d'),nodes=data.geometryNodes||[],curves=data.curves||[];
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(!nodes.length)return;
    const byId=new Map(nodes.map(n=>[n.id,n]));
    const samples=new Map(curves.map(c=>[c.id,Array.from({length:c.type==='line'?2:65},(_,i)=>curvePoint(c,byId,i/(c.type==='line'?1:64))).filter(Boolean)]));
    const coordinates=[...nodes,...[...samples.values()].flat()];
    const bounds=coordinates.reduce((b,p)=>({minX:Math.min(b.minX,p.x),maxX:Math.max(b.maxX,p.x),minY:Math.min(b.minY,p.y),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity});
    const scale=Math.min((canvas.width-100)/(bounds.maxX-bounds.minX||1),(canvas.height-80)/(bounds.maxY-bounds.minY||1));
    const point=p=>({x:canvas.width/2+(p.x-(bounds.minX+bounds.maxX)/2)*scale,y:canvas.height/2-(p.y-(bounds.minY+bounds.maxY)/2)*scale});
    for(const r of [...(data.regions||[])].sort((a,b)=>Number(a.isAir)-Number(b.isAir))) {
      const points=(r.polygon||[]).map(point);if(!points.length)continue;
      ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();
      ctx.fillStyle=r.isAir?'#f4f8fa':r.materialColor||r.material?.color||'#97c4ca';ctx.globalAlpha=r.isAir?1:.55;ctx.fill();ctx.globalAlpha=1;
    }
    if(mesh) {
      ctx.beginPath();ctx.strokeStyle='#698a99';ctx.lineWidth=.5;ctx.globalAlpha=.6;
      const edges=new Set();let batch=0;
      for(const triangle of mesh.triangles||[]) {
        for(let j=0;j<3;j++){
          const a=triangle[j],b=triangle[(j+1)%3],key=Math.min(a,b)+':'+Math.max(a,b);
          if(edges.has(key)||!mesh.nodes[a]||!mesh.nodes[b])continue;
          edges.add(key);
          const p=point({x:mesh.nodes[a][0],y:mesh.nodes[a][1]}),q=point({x:mesh.nodes[b][0],y:mesh.nodes[b][1]});
          ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);
          // Shared edges are drawn once; bounded paths avoid a large dense
          // reference mesh turning a single Canvas stroke into a long UI stall.
          if(++batch===4096){ctx.stroke();ctx.beginPath();batch=0;}
        }
      }
      if(batch)ctx.stroke();ctx.globalAlpha=1;
    }
    for(const c of curves) {
      const points=samples.get(c.id).map(point);if(!points.length)continue;
      ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));
      ctx.strokeStyle=c.mechanicalState==='static'?'#167a5a':'#4c6675';ctx.lineWidth=c.mechanicalState==='static'?5:1.2;ctx.stroke();
    }
    for(const n of nodes.filter(n=>n.mechanicalState==='static')) {
      const p=point(n);ctx.fillStyle='#167a5a';ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x-5,p.y+10);ctx.lineTo(p.x+5,p.y+10);ctx.closePath();ctx.fill();
    }
    const arrow=(anchor,dx,dy,length=30,color='#b74f37')=>{
      if(!anchor)return;
      const p=point(anchor),norm=Math.hypot(dx,dy)||1,v={x:dx/norm,y:-dy/norm},tail={x:p.x-v.x*length,y:p.y-v.y*length};
      ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1.8;ctx.beginPath();ctx.moveTo(tail.x,tail.y);ctx.lineTo(p.x,p.y);ctx.stroke();
      ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x-v.x*8-v.y*4,p.y-v.y*8+v.x*4);ctx.lineTo(p.x-v.x*8+v.y*4,p.y-v.y*8-v.x*4);ctx.closePath();ctx.fill();
    };
    for(const load of data.pointLoads||[])arrow(byId.get(load.geometryNodeId)||load.anchor,load.fx,load.fy,36);
    for(const load of data.distributedLoads||[]) {
      const c=curves.find(c=>c.id===load.curveId);if(!c)continue;
      for(let i=0;i<5;i++){
        const u=i/4,t=(load.start||0)+((load.end??1)-(load.start||0))*u;
        const q0=load.qStart??load.q??0,q1=load.qEnd??q0,maximum=Math.max(q0,q1,1e-12);
        arrow(curvePoint(c,byId,t),load.direction.x,load.direction.y,15+18*(q0*(1-t)+q1*t)/maximum);
      }
    }
    for(const load of data.bodyLoads||[]) {
      const r=(data.regions||[]).find(r=>r.id===load.regionId&&!r.isAir)||(data.regions||[]).find(r=>!r.isAir);
      if(r?.centroid)arrow(r.centroid,load.direction.x,load.direction.y,30,'#7d61a9');
    }
    ctx.fillStyle='#59717d';ctx.font='12px sans-serif';ctx.fillText('绿色：固定支撑   红色：外载荷   紫色：体力',16,canvas.height-15);
  }
  window.femTrainingPreview={draw,curvePoint};
})();
