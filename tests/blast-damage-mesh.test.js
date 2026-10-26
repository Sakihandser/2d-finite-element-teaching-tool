const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const DamageMesh=require('../src/core/blast-damage-mesh'),Fracture=require('../blast-fracture');
const {sceneWorkflowHarness}=require('./helpers/scene-workflow');
const {runBlastCore}=require('../server'),{removeRun,readBlastFrame}=require('../blast-runner');

function patch(){
  const nodes=[{id:'A1',x:0,y:0},{id:'A2',x:.01,y:0},{id:'A3',x:.01,y:.01},{id:'A4',x:0,y:.01}];
  const elements=[{id:'E1',regionId:'R1',materialId:'hard',analysisNodeIds:['A1','A2','A3'],edges:[{boundary:true,curveId:'C1',nodeIds:['A1','A2'],tRange:[0,1]}]},
    {id:'E2',regionId:'R2',materialId:'soft',analysisNodeIds:['A1','A3','A4']}];
  const properties=[{id:'E1',elasticModulus:20e9,tensileStrength:10e6},{id:'E2',elasticModulus:20e9,tensileStrength:1e6}];
  return {nodes,elements,properties};
}
test('damage refinement preserves area, material interfaces and boundary provenance with no hanging nodes',()=>{
  const input=patch(),before=structuredClone(input),settings={fracture:true,gf:10};
  const result=DamageMesh.prepare(input.nodes,input.elements,input.properties,settings);
  assert.deepEqual(input,before);assert.equal(result.rounds,2);
  const byId=new Map(result.analysisNodes.map(n=>[n.id,n])),edges=new Map(),areas=new Map();
  for(const e of result.elements){
    areas.set(e.materialId,(areas.get(e.materialId)||0)+e.area);
    for(let j=0;j<3;j++){
      const a=e.analysisNodeIds[j],b=e.analysisNodeIds[(j+1)%3],key=[a,b].sort().join(':');edges.set(key,(edges.get(key)||0)+1);
      const p=byId.get(a),q=byId.get(b);
      for(const n of result.analysisNodes)if(n.id!==a && n.id!==b){
        const cross=(q.x-p.x)*(n.y-p.y)-(q.y-p.y)*(n.x-p.x),dot=(n.x-p.x)*(n.x-q.x)+(n.y-p.y)*(n.y-q.y);
        assert.ok(Math.abs(cross)>1e-15 || dot>=-1e-15,'no midpoint inside an unsplit edge');
      }
    }
  }
  assert.ok([...edges.values()].every(n=>n===1 || n===2));
  for(const area of areas.values())assert.ok(Math.abs(area-.00005)<1e-15);
  const wall=result.elements.flatMap(e=>e.edges).filter(e=>e.curveId==='C1');
  assert.equal(wall.length,4);assert.ok(Math.abs(wall.reduce((s,e)=>s+e.length,0)-.01)<1e-15);
  assert.ok(result.analysisNodes.some(n=>n.placement?.curveId==='C1'));
});
test('compatible or disabled damage avoids refinement, and resource failure leaves the source intact',()=>{
  const p=patch(),before=structuredClone(p);
  assert.equal(DamageMesh.prepare(p.nodes,p.elements,p.properties,{fracture:true,gf:26}).rounds,0);
  assert.equal(DamageMesh.prepare(p.nodes,p.elements,p.properties,{fracture:false,gf:1}).rounds,0);
  assert.throws(()=>DamageMesh.prepare(p.nodes,p.elements,p.properties,{fracture:true,gf:1},{maxNodes:4}),/资源上限/);
  assert.throws(()=>DamageMesh.prepare(p.nodes,p.elements,p.properties.map(p=>({...p,tensileStrength:0})),{fracture:true,gf:1}),/tensile strength/);
  assert.deepEqual(p,before);
});
test('saved curve samples correct reversed legacy edge parameters before subdivision',()=>{
  const p=patch();p.elements[0].edges[0].tRange=[1,0];
  const result=DamageMesh.prepare(p.nodes,p.elements,p.properties,{fracture:true,gf:10},{boundarySegments:[{curveId:'C1',samples:[{nodeId:'A1',t:0},{nodeId:'A2',t:1}]}]});
  const byId=new Map(result.analysisNodes.map(n=>[n.id,n]));
  for(const e of result.elements)for(const edge of e.edges)if(edge.curveId==='C1'){
    edge.nodeIds.forEach((id,i)=>assert.ok(Math.abs(edge.tRange[i]-byId.get(id).x/.01)<1e-12));
  }
  assert.deepEqual(p.elements[0].edges[0].tRange,[1,0]);
});
// Execute the actual browser worker entry point, including its importScripts,
// in an isolated context; structuredClone matches the browser message boundary.
class DamageWorker {
  constructor(){this.stopped=false;}
  terminate(){this.stopped=true;}
  postMessage(data){
    const cloned=structuredClone(data);
    setImmediate(()=>{
      if(this.stopped)return;
      const api=vm.createContext({self:{postMessage:data=>{if(!this.stopped)this.onmessage({data:structuredClone(data)});}}});
      api.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../src/core',file),'utf8'),api));
      try{
        vm.runInContext(fs.readFileSync(require.resolve('../src/core/blast-damage-mesh-worker.js'),'utf8'),api);
        api.self.onmessage({data:cloned});
      }catch(error){this.onerror(error);}
    });
  }
}
function workflow(data){
  const h=sceneWorkflowHarness(data),c=h.context;
  Object.assign(c,{BlastFracture:Fracture,BlastCavity:require('../src/core/blast-cavity'),Worker:DamageWorker,AbortController,DOMException,setTimeout,clearTimeout,
    console,clearBlastHistory(){}});
  c.currentLibrary=require('../materials/materials.json').materials;
  vm.runInContext('materialLibrary=structuredClone(currentLibrary)',c);
  for(const file of ['blast-dynamics','blast-fracture-ui'])vm.runInContext(fs.readFileSync(require.resolve('../src/core/'+file+'.js'),'utf8'),c);
  return h;
}
test('the damage worker prepares a compatible cavity mesh that runs in the native solver',async t=>{
 const source=require('./helpers/blast-ring').blastRing({sectors:24,rings:4,outer:.6}),settings={fracture:true,gf:5,pressure:1e8,radius:.1,chargeRadius:.1,duration:1e-4,pulse:5e-5,frames:3};
 const nodes=source.nodes.map(n=>({...n,id:'A'+n.nodeNo})),elements=source.elements.map(e=>({...e,id:'E'+e.elementNo,analysisNodeIds:e.nodeNumbers.map(n=>'A'+n)}));
 const properties=elements.map(e=>({id:e.id,elasticModulus:e.elasticModulus,tensileStrength:e.tensileStrength}));
 const candidate=await new Promise((resolve,reject)=>{const worker=new DamageWorker();worker.onmessage=({data})=>{if(data.error)reject(Error(data.error));else if(data.result)resolve(data.result);};worker.onerror=reject;worker.postMessage({nodes,elements,properties,settings,boundarySegments:[]});});
 assert.ok(candidate.elements.length>elements.length);const ids=new Map(candidate.analysisNodes.map((n,i)=>[n.id,i+1]));
 const model={...source,nodes:candidate.analysisNodes.map((n,i)=>({...n,nodeNo:i+1,dofUx:2*i+1,dofUy:2*i+2,materialNo:1,regionNo:1})),elements:candidate.elements.map((e,i)=>{const numbers=e.analysisNodeIds.map(n=>ids.get(n));return {...source.materials[0],...e,materialNo:1,elementNo:i+1,node1:numbers[0],node2:numbers[1],node3:numbers[2],nodeNumbers:numbers};})};
 assert.equal(Fracture.inspect(model,settings).valid,true);const history=await runBlastCore(model,settings,{lazy:true});t.after(()=>removeRun(history.id));
 let maximum=0,previous=new Float64Array(model.elements.length);for(let i=0;i<history.frames.length;i++){const f=await readBlastFrame(history.id,i);f.elements.forEach((row,j)=>{assert.ok(row.every(Number.isFinite));assert.ok(row[6]>=previous[j]&&row[6]<=1);previous[j]=row[6];maximum=Math.max(maximum,row[6]);});}assert.ok(maximum>0);
});

test('cancelling mesh preparation terminates the worker without committing a mesh',async()=>{
  const h=workflow({}),c=h.context;
  const p=patch(),controller=new AbortController(),status={};let worker;
  c.Worker=class{constructor(){worker=this;}postMessage(){}terminate(){this.terminated=true;}};
  const original=h.scene.mesh;
  const pending=c.refineBlastDamageInWorker(p.nodes,p.elements,p.properties,{fracture:true,gf:1},controller.signal,status);
  controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(worker.terminated,true);assert.equal(h.scene.mesh,original);
});
test('an edit while the damage worker is running rejects its candidate without overwriting the source',async()=>{
  const input=patch(),mesh={elements:input.elements},status={};
  const model={nodes:input.nodes.map(n=>({...n,nodeNo:n.id})),elements:input.elements.map((e,i)=>({...input.properties[i],elementNo:i+1,node1:e.analysisNodeIds[0],node2:e.analysisNodeIds[1],node3:e.analysisNodeIds[2]}))};
  const payload={elements:input.elements},scene={analysisNodes:input.nodes,mesh};let complete,commits=0;
  const c=vm.createContext({scene,BlastFracture:Fracture,BlastMaterials:require('../blast-materials'),document:{getElementById:()=>status},
    blastModelSignature:JSON.stringify,blastGeometrySignature:()=>'',buildCalculationInputExport:()=>payload,calculationInputPayloadToDirectModel:()=>model,
    setAnalysisMesh(){commits++;},clearBlastHistory(){}});
  vm.runInContext(fs.readFileSync(require.resolve('../src/core/blast-fracture-ui.js'),'utf8'),c);
  c.refineBlastDamageInWorker=()=>new Promise(resolve=>{complete=resolve;});
  const pending=c.ensureBlastDamageMeshReady(payload,model,{fracture:true,gf:10},new AbortController().signal);
  model.nodes[0].x=1;complete({});
  await assert.rejects(pending,/模型在计算期间发生变化/);assert.equal(commits,0);assert.equal(scene.mesh,mesh);assert.equal(scene.analysisNodes[0].x,0);
});
test('blast HTTP uploads can exceed 50 MB while ordinary calculation uploads retain their limit',async t=>{
  const http=require('node:http'),{createRequire}=require('node:module'),root=path.resolve(__dirname,'..');
  const c=vm.createContext({require:createRequire(path.join(root,'server.js')),module:{exports:{}},__dirname:root,process,Buffer,URL,AbortController});
  vm.runInContext(fs.readFileSync(path.join(root,'server.js'),'utf8'),c);
  let runs=0;c.runBlastCore=async model=>{runs++;assert.equal(model.padding.length,50000512);return {ok:true};};
  const server=http.createServer((request,response)=>c.handleRequest(request,response));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port,body=JSON.stringify({model:{padding:'x'.repeat(50000512)},settings:{}});
  const blast=await fetch(base+'/api/blast-runs',{method:'POST',body});
  assert.equal(blast.status,200);assert.equal((await blast.json()).ok,true);assert.equal(runs,1);
  const ordinary=await fetch(base+'/api/calculation-runs',{method:'POST',body});
  assert.equal(ordinary.status,400);assert.match((await ordinary.json()).error,/请求体过大/);
});
