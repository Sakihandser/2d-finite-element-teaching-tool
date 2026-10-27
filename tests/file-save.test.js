const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function load(context,file){vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);}
function fixture(picker){
  const events=[],stream={async write(value){events.push(value);},async close(){events.push('close');},async abort(){events.push('abort');}};
  const handle={async createWritable(){events.push('open');return stream;}};
  const context=vm.createContext({window:{showSaveFilePicker:picker|| (async options=>{events.push(options);return handle;})},Blob,console});
  load(context,'src/core/file-save.js');return {context,events,stream,handle};
}
test('save picker suggests sanitized Chinese filename and streams bytes before committing',async()=>{
  const {context,events}=fixture();
  await vm.runInContext("(async()=>{const h=await chooseExportFile('模型:一.zip','application/zip','.zip');await writeExportChunks(h,[new Uint8Array([1,2]),new Uint8Array([3])]);})()",context);
  assert.equal(events[0].suggestedName,'模型_一.zip');assert.equal(events[0].types[0].accept['application/zip'][0],'.zip');
  assert.equal(events[1],'open');assert.deepEqual(Array.from(events[2]),[1,2]);assert.deepEqual(Array.from(events[3]),[3]);assert.equal(events[4],'close');
});
test('cancel does not open a file; unsupported environments report an error',async()=>{
  const {context,events}=fixture(async()=>{throw Object.assign(new Error('cancel'),{name:'AbortError'});});
  assert.equal(await vm.runInContext("chooseExportFile('a.json','application/json','.json')",context),null);assert.equal(events.length,0);
  context.window.showSaveFilePicker=undefined;
  await assert.rejects(vm.runInContext("chooseExportFile('a.json','application/json','.json')",context),/启动器/);
});
test('generation and disk failures abort instead of committing a partial file',async()=>{
  for(const diskFailure of [false,true]){
    const {context,events,stream,handle}=fixture();context.handle=handle;
    if(diskFailure)stream.write=async()=>{throw new Error('disk full');};
    await assert.rejects(vm.runInContext("writeExportFile(handle,async writable=>{await writable.write('data');throw new Error('generation failed');})",context),diskFailure?/disk full/:/generation failed/);
    assert.equal(events.at(-1),'abort');assert.ok(!events.includes('close'));
  }
});
test('result button opens picker before archive work, and cancellation restores button without generation',async()=>{
  for(const cancel of [false,true]){
    const {context,events,handle}=fixture();
    context.window.showSaveFilePicker=async()=>{events.push('picker');return cancel?null:handle;};
    const buttons=Object.fromEntries(['exportCalculationResults','exportResultPng'].map(id=>[id,{disabled:false,addEventListener(type,fn){this.click=fn;}}]));
    Object.assign(context,{document:{getElementById:id=>buttons[id]},calculationResultData:{modelName:'模型',nodes:[{}]},setResultStatus:message=>events.push(message),ResultExport:{documents:()=>{events.push('generate');return [];},archive:async function*(){yield new Uint8Array([80,75]);}}});
    load(context,'src/pages/results/export.js');vm.runInContext('initializeResultExports()',context);
    await buttons.exportCalculationResults.click();assert.equal(events[0],'picker');assert.equal(buttons.exportCalculationResults.disabled,false);
    assert.equal(events.includes('generate'),!cancel);assert.equal(events.includes('close'),!cancel);
  }
});
test('model export saves JSON with view state and handles cancellation without serializing',async()=>{
  for(const cancel of [false,true]){
    const {context,events,handle}=fixture();
    context.window.showSaveFilePicker=async()=>cancel?null:handle;
    context.window.alert=message=>assert.fail(message);
    const button={disabled:false};
    Object.assign(context,{document:{getElementById:()=>button},scene:{name:'旧名称',geometryNodes:[{id:'G1',x:1,y:2}]},modelName:{value:'中文模型'},view:{offsetX:12,offsetY:34,scale:5},syncRegionMaterialSnapshots:()=>events.push('snapshot'),classifyAnalysisElements:()=>{},getCalculationViewState:()=>({scale:9})});
    load(context,'src/core/scene-io.js');await vm.runInContext('exportScene()',context);
    assert.equal(button.disabled,false);
    if(cancel){assert.equal(events.length,0);continue;}
    const blob=events.find(value=>value instanceof Blob),model=JSON.parse(await blob.text());
    assert.equal(model.name,'中文模型');assert.equal(model.geometryNodes[0].id,'G1');assert.deepEqual(model.viewport,{offsetX:12,offsetY:34,scale:5});assert.equal(model.calculationViewport.scale,9);assert.equal(events.at(-1),'close');
  }
});
