'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {harness}=require('../python_machine_learning/mesh-worker.cjs');

test('preview samples imported curved boundaries from local geometry without modifying the drawing scene',()=>{
  const context=harness({name:'drawing model',geometryNodes:[],curves:[],regions:[]});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/pages/training/model-preview.js'),'utf8'),context);
  for(const type of ['rectangle','triangle','circle','ellipse']){
    const shape=context.buildRegularShape({type,x:2,y:3,angle:27,width:4,height:2,radius:2});
    const nodes=new Map(shape.vertices.map((p,i)=>['G'+i,p]));
    for(const boundary of shape.boundaries){
      const curve={...boundary,geometryNodeIds:['G'+boundary.start,'G'+boundary.end]};
      const midpoint=context.window.femTrainingPreview.curvePoint(curve,nodes,.5);
      assert.ok(Number.isFinite(midpoint.x)&&Number.isFinite(midpoint.y));
      if(type==='circle')assert.ok(Math.abs(Math.hypot(midpoint.x-2,midpoint.y-3)-2)<1e-9);
      if(type==='ellipse'){
        const a=27*Math.PI/180,dx=midpoint.x-2,dy=midpoint.y-3;
        assert.ok(Math.abs(((dx*Math.cos(a)+dy*Math.sin(a))/2)**2+(-dx*Math.sin(a)+dy*Math.cos(a))**2-1)<1e-9);
      }
    }
  }
  const data={geometryNodes:[{id:'G1',x:0,y:0,mechanicalState:'static'},{id:'G2',x:1,y:0},{id:'G3',x:0,y:1}],
    curves:[{id:'C1',type:'line',geometryNodeIds:['G1','G2'],mechanicalState:'static',controls:[]}],
    regions:[{polygon:[{x:0,y:0},{x:1,y:0},{x:0,y:1}],materialColor:'#abcdef'}],pointLoads:[{geometryNodeId:'G3',fx:0,fy:10}],distributedLoads:[],bodyLoads:[]};
  const mesh={nodes:[[0,0],[1,0],[0,1]],triangles:[[0,1,2]]};
  const drawingBefore=vm.runInContext('JSON.stringify(scene)',context),dataBefore=JSON.stringify(data);
  let strokes=0,legend='';
  const ctx={clearRect(){},beginPath(){},moveTo(x,y){assert.ok(Number.isFinite(x)&&Number.isFinite(y));},
    lineTo(x,y){assert.ok(Number.isFinite(x)&&Number.isFinite(y));},closePath(){},fill(){},stroke(){strokes++;},fillText(value){legend=value;}};
  context.window.femTrainingPreview.draw({width:760,height:440,getContext:()=>ctx},data,mesh);
  assert.ok(strokes>=3);assert.ok(legend.includes('固定支撑'));
  assert.equal(vm.runInContext('JSON.stringify(scene)',context),drawingBefore);
  assert.equal(JSON.stringify(data),dataBefore);
});
