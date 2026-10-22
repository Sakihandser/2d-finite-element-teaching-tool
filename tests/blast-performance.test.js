const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {blastRing}=require('./helpers/blast-ring');
function harness(extra={}) {
  const context=vm.createContext({isFinitePoint:p=>Number.isFinite(p.x)&&Number.isFinite(p.y),...extra});
  for(const file of ['src/pages/results/render.js','src/core/blast-dynamics.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+file),'utf8'),context);
  return context;
}
test('reused transient topology matches full result conversion for every field and range',()=>{
  const context=harness(),model=blastRing({sectors:12,rings:2});
  const frame=k=>({u:model.nodes.flatMap((_,i)=>[k*i*.001,-k*i*.002]),elements:model.elements.map((_,i)=>[k*i*.01,-k*i*.02,k*i*.03,k*i*13,-k*i*7,k*i*3,k*.1])});
  const baseline=frame(0),history={model};
  const first=context.updateBlastFrameData(history,frame(1),baseline),nodes=first.nodes,elements=first.elements;
  for(const k of [2,0,3]) {
    const actual=context.updateBlastFrameData(history,frame(k),baseline);
    const expected=context.buildCalculationResultData(model,context.blastFrameResult(model,frame(k),baseline),{blastFrame:true});
    assert.equal(actual.nodes,nodes);assert.equal(actual.elements,elements);assert.notEqual(actual,first);
    for(const key of ['nodes','elements','ranges','maxDisplacement','maxStress','maxStrain','baseBounds'])assert.equal(JSON.stringify(actual[key]),JSON.stringify(expected[key]),key);
  }
});
test('NDJSON reader handles split UTF-8, multiple messages, errors, and truncated responses',async()=>{
  const progress=[];const context=harness({TextDecoder});context.updateBlastProgress=p=>progress.push(p);
  const response=text=>{const bytes=new TextEncoder().encode(text);let index=0;return {ok:true,headers:{get:()=> 'application/x-ndjson'},body:{getReader:()=>({read:async()=> index<bytes.length ? {value:bytes.slice(index,index+=7),done:false} : {done:true},releaseLock(){}})}};};
  const h=await context.readBlastRunResponse(response(JSON.stringify({type:'progress',fraction:.2})+'\n'+JSON.stringify({type:'result',history:{ok:true,name:'爆破'}})+'\n'));
  assert.equal(h.name,'爆破');assert.equal(progress[0].fraction,.2);
  await assert.rejects(context.readBlastRunResponse(response('{"type":"error","error":"failed"}\n')),/failed/);
  await assert.rejects(context.readBlastRunResponse(response('{"type":"progress"}\n')),/连接中断/);
});
test('native progress is monotonic and ends at completion',async t=>{
  const {runBlastCore}=require('../server'),{removeRun}=require('../blast-runner'),progress=[];
  const h=await runBlastCore(blastRing({sectors:12,rings:2}),{fracture:false,frames:3,duration:.0001},{lazy:true,onProgress:p=>progress.push(p)});
  t.after(()=>removeRun(h.id));
  assert.equal(progress[0].fraction,0);assert.equal(progress.at(-1).fraction,1);
  assert.ok(progress.some(p=>p.totalSteps===h.steps));
  for(let i=1;i<progress.length;i++)assert.ok(progress[i].fraction>=progress[i-1].fraction);
});
