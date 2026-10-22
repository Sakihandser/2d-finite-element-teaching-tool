(function(root,factory){
  if(typeof module==="object" && module.exports)module.exports=factory(require("../blast-settings"),require("../explosive-library"));
  else root.ThesisBlastModels=factory(root.BlastSettings,root.ExplosiveLibrary);
})(typeof globalThis!=="undefined" ? globalThis : this,function(Settings,Explosives){
  const cases=["W45","W90","H45","H90"],pressures=[[0,0],[20,20],[10,5],[5,10]];
  const reference={
    granite:{density:2660,K:25.7,G:21.9,T:54},sandstone:{density:2340,K:12.67,G:9.98,T:44},
    jh2:{A:.76,N:.62,B:.25,M:.62,sigmaHEL:4.5e9,pHEL:3.7e9,D1:.005,D2:.7,strainRate0:1,remainingStrength:.25,C:.005,K1:25.7e9,K2:-4500e9,K3:300000e9},
    geometry:{side:.6,cavityRadius:.008,chargeRadius:.005,inclusionWidth:.054,inclusionCenterDistance:.3,hardRockClearance:.12},
    source:"用户提供论文：图4.1、图4.11，PDF第122、136页；表2.2.5及表4.0.3，PDF第59、137页。",
  };
  function material(key){
    const p=reference[key],E=9*p.K*p.G/(3*p.K+p.G),nu=(3*p.K-2*p.G)/(2*(3*p.K+p.G));
    return {id:`thesis43-${key}`,name:key==="granite" ? "论文4.3 花岗岩（弹性近似）" : "论文4.3 青砂岩（弹性近似）",
      elasticModulus:E,poissonRatio:nu,density:p.density,tensileStrength:key==="granite" ? 8 : 4,compressiveStrength:null,yieldStrength:null,
      color:key==="granite" ? "#92c9ca" : "#dfeacb",sourceUrl:"",sourceUrls:[],
      notes:`由论文JH2弹性常数K=${p.K} GPa、G=${p.G} GPa换算E、ν。当前核心未实现JH2；静水拉伸强度T=${p.T} MPa不是单轴抗拉强度，不直接填入损伤阈值。演示单轴抗拉强度：花岗岩8 MPa、青砂岩4 MPa，未经标定，仅用于测试当前拉伸损伤通道。`};
  }
  function scene(code,pressureIndex,explosive){
    if(!cases.includes(code) || !pressures[pressureIndex])throw new Error("Invalid thesis model case.");
    const hard=code.startsWith("H"),angle=code.endsWith("45") ? 135 : 90,theta=angle*Math.PI/180;
    const center=hard ? (angle===90 ? {x:.147,y:0} : {x:.147*Math.SQRT1_2,y:.147*Math.SQRT1_2}) : {x:0,y:0};
    const data={version:6,name:`论文4.3 ${code}-${pressures[pressureIndex].join("-")}（二维拉伸损伤演示）`,geometryNodes:[],curves:[],regions:[],pointLoads:[],distributedLoads:[],bodyLoads:[],analysisNodes:[],analysisNodePlacement:null,mesh:{elements:[],metadata:null},blastExplosiveId:explosive.id};
    function point(p){const id=`G${data.geometryNodes.length+1}`;data.geometryNodes.push({id,x:p.x,y:p.y,mechanicalState:"free"});return id;}
    function curve(type,a,b,control){const id=`C${data.curves.length+1}`;data.curves.push({id,type,geometryNodeIds:[a,b],controls:control ? [control] : [],mechanicalState:"free"});return id;}
    const box=[[-.3,-.3],[.3,-.3],[.3,.3],[-.3,.3]].map(([x,y])=>point({x,y}));
    const boxCurves=box.map((a,i)=>curve("line",a,box[(i+1)%4]));
    const r=.027,l=.15;
    const transform=({x,y})=>({x:center.x+x*Math.cos(theta)-y*Math.sin(theta),y:center.y+x*Math.sin(theta)+y*Math.cos(theta)});
    const cap=[{x:l,y:r},{x:-l,y:r},{x:-l-r,y:0},{x:-l,y:-r},{x:l,y:-r},{x:l+r,y:0}].map(p=>point(transform(p)));
    const control=[null,{x:-l-r*Math.SQRT1_2,y:r*Math.SQRT1_2},{x:-l-r*Math.SQRT1_2,y:-r*Math.SQRT1_2},null,{x:l+r*Math.SQRT1_2,y:-r*Math.SQRT1_2},{x:l+r*Math.SQRT1_2,y:r*Math.SQRT1_2}];
    const capCurves=cap.map((a,i)=>curve(control[i] ? "arc" : "line",a,cap[(i+1)%6],control[i] ? transform(control[i]) : null));
    const radius=.008,ring=Array.from({length:4},(_,i)=>point({x:radius*Math.cos(i*Math.PI/2),y:radius*Math.sin(i*Math.PI/2)}));
    const holeCurves=ring.map((a,i)=>curve("arc",a,ring[(i+1)%4],{x:radius*Math.cos((i+.5)*Math.PI/2),y:radius*Math.sin((i+.5)*Math.PI/2)}));
    for(const [i,ids,kind,mat,name] of [[1,boxCurves,"structure",material("granite"),"花岗岩基体"],[2,capCurves,"structure",material("sandstone"),"青砂岩弱夹层"],[3,holeCurves,"air",null,"炮孔（径向空气与装药）"]])data.regions.push({id:`R${i}`,name,boundaryCurveIds:ids,boundarySignature:[...ids].sort().join("|"),regionKind:kind,material:mat,fillColor:mat?.color || "#ffffff"});
    const [sx,sy]=pressures[pressureIndex];
    data.blastSettings=Explosives.apply({...Settings.defaults,x:0,y:0,radius:.008,chargeRadius:.005,planeMode:0,
      duration:.0002,dt:0,frames:101,fracture:true,boundary:2,loadMode:0,confineX:sx*1e6,confineY:sy*1e6,
      airDensity:1.25,airPressure:100000,airGamma:1.4,gasCells:192,timeLimitSeconds:600},explosive);
    return data;
  }
  return {cases,pressures,reference,material,scene};
});
