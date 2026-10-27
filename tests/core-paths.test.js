'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {runCalculationCore}=require('../server');

test('server locates TensoraCore and solves through its binary pipe',async()=>{
  const p={elasticModulus:200e9,poissonRatio:.25,density:2500};
  const model={modelName:'core-path-check',materials:[{materialNo:1,...p}],nodes:[
    {nodeNo:1,x:0,y:0,fixUx:true,fixUy:true,dofUx:1,dofUy:2,materialNo:1,regionNo:1},
    {nodeNo:2,x:1,y:0,fixUy:true,dofUx:3,dofUy:4,forceX:500000,materialNo:1,regionNo:1},
    {nodeNo:3,x:0,y:1,fixUx:true,dofUx:5,dofUy:6,materialNo:1,regionNo:1}],
    elements:[{elementNo:1,node1:1,node2:2,node3:3,area:.5,materialNo:1,...p}]};
  const result=await runCalculationCore(model);
  assert.equal(result.ok,true,result.stderr);
  assert.equal(result.executable,'TensoraCore/x64/Release/TensoraCore.exe');
  assert.equal(result.resultData.elementResults.length,1);
  assert.ok(Math.abs(result.resultData.elementResults[0].stressXx-1e6)<1e-6);
});

test('core project and all shipped core paths use ASCII names',()=>{
  const core=path.join(__dirname,'../TensoraCore');
  assert.match(fs.readFileSync(path.join(core,'TensoraCore.sln'),'utf8'),/"TensoraCore", "TensoraCore\.vcxproj"/);
  for(const relative of fs.readdirSync(core,{recursive:true}))assert.match(relative,/^[\x00-\x7f]+$/,relative);
});
