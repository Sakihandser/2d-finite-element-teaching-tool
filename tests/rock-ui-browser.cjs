// Real browser regression; material POSTs are intercepted and no images are saved.
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/hongm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {rockCard}=require('./helpers/rock-card');const root=path.resolve(__dirname,'..');
(async()=>{const server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'5297',FEM_OPEN_BROWSER:'0'},windowsHide:true});let browser;
try{
 await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{if(b.toString().includes('5297'))resolve();});server.once('error',reject);server.once('exit',code=>reject(Error(`server exited ${code}`)));});
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1500,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let saved,fail=false;await page.route('**/api/materials',async route=>{if(route.request().method()!=='POST')return route.continue();if(fail)return route.fulfill({status:500,body:'test rollback'});saved=route.request().postDataJSON();return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(saved)});});
 await page.goto('http://127.0.0.1:5297/');await page.waitForFunction(()=>window.femSketchApi&&typeof materialLibrary!=='undefined');
 const data=JSON.parse(fs.readFileSync(path.join(root,'examples/blast-cavity.json'),'utf8'));data.name='Material card verification';data.regions.find(r=>r.material).material.tensileStrength=54;
 await page.evaluate(data=>{setBlastModuleEnabled(true,false);scene=normalizeScene(data);modelName.value=scene.name;rebuildDerivedRegions({markAnalysisNodePlacementStale:false,markAnalysisMeshStale:false});restoreBlastControls();setPage('blast');},data);
 assert.equal(await page.locator('#applyThesisRockConfiguration').count(),0);assert.ok(!/论文|原模型|对照/.test(await page.locator('.blast-rock-card').innerText()));
 await page.selectOption('#blastSourceMode','1');assert.equal(await page.locator('#blastVentEnds option').count(),3);
 await page.selectOption('#blastVentEnds','2');await page.fill('#blastSpecimenThickness','50');await page.fill('#blastVentOpeningTime','0.025');
 const original=await page.evaluate(()=>readBlastControls());await page.selectOption('#blastRockModel','3');await page.selectOption('#blastKinematics','1');assert.equal(await page.inputValue('#blastPlaneMode'),'1');
 const card=rockCard();for(const [key,value] of Object.entries(card.jh2)){const field=page.locator(`[data-rock-field="jh2.${key}"][data-rock-material="blast-demo-rock"]`),scale=Number(await field.getAttribute('data-rock-scale'));await field.fill(String(value/scale));}
 await page.click('#saveBlastRockCards');await page.waitForFunction(()=>document.getElementById('blastRockStatus').textContent==='本构参数已保存。');
 assert.equal(saved.materials.find(m=>m.id==='blast-demo-rock').blastConstitutive.jh2.normalizationStress,4.5e9);
 await page.fill('#blastMaxAnalysisNodes','500');await page.click('#generateBlastMesh');await page.waitForFunction(()=>document.getElementById('blastMeshStatus').textContent==='网格已更新。');
 const check=await page.evaluate(()=>{const direct=calculationInputPayloadToDirectModel(buildCalculationInputExport({adaptive:false})),roundtrip=normalizeScene(structuredClone(scene));return {settings:readBlastControls(),materials:direct.materials,roundtrip:roundtrip.regions.filter(r=>r.material).map(r=>r.material.blastConstitutive)};});
 assert.ok(check.materials.every(m=>m.blastConstitutive?.jh2.T>0));assert.ok(check.roundtrip.every(c=>c?.jh2.T>0));
 assert.equal(check.settings.ventEnds,2);assert.equal(check.settings.specimenThickness,.05);assert.equal(check.settings.ventOpeningTime,.000025);
 for(const key of ['productDensity','productEnergy','jwlA','jwlB','confineX','confineY','chargeRadius'])assert.equal(check.settings[key],original[key],key);
 const restored=await page.evaluate(()=>{scene.blastSettings=readBlastControls();restoreBlastControls();return readBlastControls();});assert.equal(restored.ventEnds,2);
 const before=await page.evaluate(()=>JSON.stringify(materialLibrary));fail=true;
 await page.locator('[data-rock-field="jh2.T"][data-rock-material="blast-demo-rock"]').fill('55');await page.click('#saveBlastRockCards');await page.waitForFunction(()=>document.getElementById('blastRockStatus').textContent.includes('HTTP 500'));assert.equal(await page.evaluate(()=>JSON.stringify(materialLibrary)),before);
 fail=false;await page.evaluate(()=>{materialLibrary=materialLibrary.filter(m=>m.id!=='blast-demo-rock');});
 await page.locator('[data-rock-field="jh2.T"][data-rock-material="blast-demo-rock"]').fill('54');await page.click('#saveBlastRockCards');await page.waitForFunction(()=>document.getElementById('blastRockStatus').textContent==='本构参数已保存。');assert.equal(saved.materials.find(m=>m.id==='blast-demo-rock').blastConstitutive.jh2.T,54e6);
 await page.locator('[data-rock-law][data-rock-material="blast-demo-rock"]').selectOption('2');assert.equal(await page.inputValue('[data-rock-field="strength.tensileStrength"][data-rock-material="blast-demo-rock"]'),'');
 for(const [key,value] of Object.entries({'strength.tensileStrength':'7','strength.compressiveStrength':'100','dp.friction':'35','dp.dilation':'5'}))await page.locator(`[data-rock-field="${key}"][data-rock-material="blast-demo-rock"]`).fill(value);
 await page.click('#saveBlastRockCards');await page.waitForFunction(()=>materialLibrary.find(m=>m.id==='blast-demo-rock')?.blastConstitutive?.law===2);assert.equal(saved.materials.find(m=>m.id==='blast-demo-rock').tensileStrength,7);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,models:4,axialEndChoices:3,manualCards:true,persistence:true,modelRoundTrip:true,rollback:true,noEmbeddedPresets:true,pageErrors:errors}));
}finally{await browser?.close();server.kill();}})().catch(error=>{console.error(error);process.exitCode=1;});
