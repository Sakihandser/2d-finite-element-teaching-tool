'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {encodeCalculationModelBinary,decodeCalculationResultBinary}=require('../calculation-ipc');
test('successful and rejected native solves do not create automatic performance logs',()=>{
 const root=path.resolve(__dirname,'..'),core=path.join(root,'计算力学程序计算核心'),logs=path.join(core,'log');
 const list=()=>fs.existsSync(logs)?fs.readdirSync(logs).filter(n=>/^performance-.*\.txt$/.test(n)).sort():[];
 const before=list(),p={elasticModulus:200e9,poissonRatio:.25,density:2500},m={materials:[{...p,materialNo:1}],
  nodes:[{nodeNo:1,x:0,y:0,fixUx:true,fixUy:true,dofUx:1,dofUy:2,materialNo:1,regionNo:1},
   {nodeNo:2,x:1,y:0,fixUy:true,dofUx:3,dofUy:4,forceX:100,materialNo:1,regionNo:1},
   {nodeNo:3,x:0,y:1,fixUx:true,dofUx:5,dofUy:6,materialNo:1,regionNo:1}],
  elements:[{...p,elementNo:1,node1:1,node2:2,node3:3,area:.5,materialNo:1}]};
 const run=()=>spawnSync(path.join(core,'x64/Release/计算力学程序计算核心.exe'),['--binary-ipc'],{cwd:root,input:encodeCalculationModelBinary(m),windowsHide:true,timeout:30000,env:{...process.env,FEM_COMPUTE:'cpu'}});
 const good=run();assert.equal(good.status,0,good.stderr.toString());assert.equal(decodeCalculationResultBinary(good.stdout).elementResults.length,1);
 m.elements[0].poissonRatio=.5;const bad=run();assert.notEqual(bad.status,0);assert.match(bad.stderr.toString(),/Materials require/);
 assert.doesNotMatch(good.stderr.toString()+bad.stderr.toString(),/Performance log written|Failed to write performance log/);assert.deepEqual(list(),before);
});
