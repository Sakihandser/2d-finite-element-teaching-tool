// Exercise actual download buttons and SVG -> PNG conversion in Edge.
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/hongm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..');
function storedZip(buffer){
 const files=new Map();let at=0;
 while(buffer.readUInt32LE(at)===0x04034b50){assert.equal(buffer.readUInt16LE(at+8),0);const size=buffer.readUInt32LE(at+18),n=buffer.readUInt16LE(at+26),start=at+30+n;files.set(buffer.subarray(at+30,start).toString(),buffer.subarray(start,start+size));at=start+size;}return files;
}
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fem-export-browser-'));
 const server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'5298',FEM_OPEN_BROWSER:'0'},windowsHide:true});let browser;
 try{
  await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{if(b.toString().includes('5298'))resolve();});server.once('error',reject);server.once('exit',code=>reject(Error('server exited '+code)));});
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5298/');await page.waitForFunction(()=>window.femSketchApi);
  const input=fs.readFileSync(path.join(root,'tests/fixtures/calculation-input.txt'),'utf8'),result=fs.readFileSync(path.join(root,'tests/fixtures/calculation-result.txt'),'utf8');
  await page.evaluate(({input,result})=>{setPage('results');loadCalculationResultsFromData(parseCalculationInputText(input),parseCalculationResultText(result));setResultView('stress');},{input,result});
  let waiting=page.waitForEvent('download');await page.click('#exportCalculationResults');let download=await waiting;const file=path.join(directory,'static.zip');await download.saveAs(file);
  const files=storedZip(fs.readFileSync(file));assert.ok(files.has('nodes.csv'));assert.ok(files.has('figures/equivalentStress.svg'));
  waiting=page.waitForEvent('download');await page.click('#exportResultPng');download=await waiting;const pngFile=path.join(directory,'png.zip');await download.saveAs(pngFile);
  const images=storedZip(fs.readFileSync(pngFile));assert.equal(images.size,4);
  for(const bytes of images.values()){assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),2400);assert.equal(bytes.readUInt32BE(20),1500);}
  fs.writeFileSync(path.join(directory,'stress.png'),images.get('stressXx.png'));
  // The same PNG flow must use the requested blast frame, even with playback data cached elsewhere.
  const {blastRing}=require('./helpers/blast-ring');
  const model=blastRing({sectors:12,rings:2});
  await page.evaluate(async model=>{
   setBlastModuleEnabled(true,false);
   const response=await fetch('/api/blast-runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,settings:{fracture:false,frames:3,pulse:.00005,duration:.0001}})});
   const h=await response.json();if(!response.ok)throw Error(h.error);
   clearBlastHistory();blastHistory={...h,model};setPage('blast-results');
   document.getElementById('blastFrame').max='2';await selectBlastFrame(2);setResultView('damage');
  },model);
  waiting=page.waitForEvent('download');await page.click('#blastDownload');download=await waiting;await download.saveAs(path.join(directory,'blast.zip'));
  const blastBytes=fs.readFileSync(path.join(directory,'blast.zip'));assert.ok(blastBytes.includes(Buffer.from('frames/frame_0002_nodes.csv')));
  waiting=page.waitForEvent('download');await page.click('#exportResultPng');download=await waiting;await download.saveAs(path.join(directory,'blast-png.zip'));
  assert.ok(storedZip(fs.readFileSync(path.join(directory,'blast-png.zip'))).has('damage-frame_0002.png'));
  assert.deepEqual(errors,[]);console.log('Browser export checks passed. Artifacts: '+directory);
 }finally{await browser?.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
