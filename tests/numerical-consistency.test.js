'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {encodeCalculationModelBinary,decodeCalculationResultBinary}=require('../calculation-ipc');
const exe=path.join(__dirname,'../TensoraCore/x64/Release/TensoraCore.exe');
function model(){const p={elasticModulus:200e9,poissonRatio:.25,density:2500,yieldStrength:0,tensileStrength:0,compressiveStrength:0};return {
 modelName:'Analytic constant-strain triangle',units:{length:'m',force:'N',elasticModulus:'Pa',density:'kg/m3',strength:'Pa'},
 materials:[{materialNo:1,...p}],nodes:[
 {nodeNo:1,x:0,y:0,fixUx:true,fixUy:true,dofUx:1,dofUy:2,materialNo:1},
 {nodeNo:2,x:1,y:0,fixUx:false,fixUy:true,dofUx:3,dofUy:4,forceX:5e5,materialNo:1},
 {nodeNo:3,x:0,y:1,fixUx:true,fixUy:false,dofUx:5,dofUy:6,forceY:0,materialNo:1}],
 elements:[{elementNo:1,node1:1,node2:2,node3:3,area:.5,centroidX:1/3,centroidY:1/3,materialNo:1,...p}],elementNodeLoads:[]};}
function run(m,backend='cpu'){for(const n of m.nodes)n.regionNo=1;return spawnSync(exe,['--binary-ipc'],{input:encodeCalculationModelBinary(m),env:{...process.env,FEM_COMPUTE:backend},windowsHide:true,timeout:30000});}
function solve(m,backend){const r=run(m,backend);assert.equal(r.status,0,r.stderr.toString());return decodeCalculationResultBinary(r.stdout);}
function close(a,b){assert.ok(Math.abs(a-b)<1e-9*Math.max(1,Math.abs(b)),`${a} != ${b}`);}
test('TRI3 analytic uniaxial response has positive tension, Poisson contraction and correct SI scale',()=>{
 const r=solve(model()),e=r.elementResults[0];close(e.stressXx,1e6);close(e.stressYy,0);close(e.strainXx,5e-6);close(e.strainYy,-1.25e-6);close(e.strainXy,0);
});
test('analytic pure shear keeps engineering gamma equal to twice the exported tensor strain on CPU and GPU',()=>{
 const m=model();m.nodes[1].fixUx=true;m.nodes[1].forceX=0;m.nodes[2].fixUx=false;m.nodes[2].fixUy=true;m.nodes[2].forceX=5e5;
 for(const backend of ['cpu','gpu']){const e=solve(m,backend).elementResults[0];close(e.stressXy,1e6);close(e.strainXy,6.25e-6);close(e.strainYx,e.strainXy);close(e.stressXx,0);close(e.stressYy,0);}
});
test('reversing triangle connectivity preserves displacement, stress signs and tensor shear',()=>{
 const m=model(),a=solve(m);[m.elements[0].node2,m.elements[0].node3]=[m.elements[0].node3,m.elements[0].node2];const b=solve(m);
 for(const k of ['stressXx','stressYy','stressXy','strainXx','strainYy','strainXy'])close(b.elementResults[0][k],a.elementResults[0][k]);
 for(let i=0;i<3;i++)for(const k of ['ux','uy'])close(b.nodeDisplacements[i][k],a.nodeDisplacements[i][k]);
 const gpu=solve(m,'gpu');for(const k of ['stressXx','stressYy','stressXy','strainXx','strainYy','strainXy'])close(gpu.elementResults[0][k],a.elementResults[0][k]);
});
test('legacy quantized area is normalized to geometry rather than changing stiffness',()=>{
 const m=model();m.elements[0].area+=4e-7;const r=solve(m);close(r.elementResults[0].stressXx,1e6);close(r.elementResults[0].strainXx,5e-6);
});
test('solver text serialization preserves small-cell areas and small physical values',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),context=vm.createContext({});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/core/calculation-export.js'),'utf8'),context);
 for(const v of [1.234567891234567e-12,1e-18,123456789.12345679])assert.equal(Number(context.solverTextNumber(v)),v);
 assert.throws(()=>context.solverTextNumber(NaN),/finite/);
});
test('normal frontend export already orders nodes counterclockwise and recomputes geometric area',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),context=vm.createContext({MATERIAL_SWATCHES:['#000000']});
 for(const f of ['numbers','material-utils','scene-objects','regions','analysis-classification','calculation-export'])vm.runInContext(fs.readFileSync(path.join(__dirname,`../src/core/${f}.js`),'utf8'),context);
 const nodes=[{id:'A1',x:0,y:0},{id:'A2',x:1,y:0},{id:'A3',x:0,y:1}],byId=new Map(nodes.map(n=>[n.id,n])),indices=new Map(nodes.map((n,i)=>[n.id,i+1]));
 const p={elasticModulus:200,poissonRatio:.25,density:2500,tensileStrength:2,compressiveStrength:100};
 const e=context.serializeCalculationElement({id:'E1',nodeIds:['A1','A3','A2'],area:999,materialId:'rock',materialName:'Rock',materialProperties:p},0,byId,indices,[]);
 assert.deepEqual(Array.from(e.nodeNumbers),[1,2,3]);assert.equal(e.area,.5);assert.equal(e.mechanicalProperties.elasticModulus,200e9);assert.equal(e.mechanicalProperties.tensileStrength,2e6);
 const m=model();Object.assign(m.elements[0],{node1:e.nodeNumbers[0],node2:e.nodeNumbers[1],node3:e.nodeNumbers[2],area:e.area});close(solve(m).elementResults[0].stressXx,1e6);
});
test('solver rejects inconsistent area, degenerate topology, invalid material, duplicate DOFs and explicit non-SI units',()=>{
 for(const mutate of [m=>m.elements[0].area=1,m=>m.nodes[2].y=0,m=>m.elements[0].elasticModulus=-1,
 m=>m.elements[0].poissonRatio=.5,m=>m.nodes[2].dofUy=3,m=>m.units.length='mm',m=>m.units.elasticModulus='GPa']){
  const m=model();mutate(m);const r=run(m);assert.notEqual(r.status,0,`Invalid input accepted: ${JSON.stringify(m)}`);
 }
});
