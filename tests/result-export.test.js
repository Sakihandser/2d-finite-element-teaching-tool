const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{inflateRawSync,deflateRawSync}=require('node:zlib');
const Export=require('../result-export');
function readZip(buffer){
  const files=new Map();let at=0;
  while(buffer.readUInt32LE(at)===0x04034b50){
    const method=buffer.readUInt16LE(at+8),size=buffer.readUInt32LE(at+18),length=buffer.readUInt32LE(at+22),names=buffer.readUInt16LE(at+26),extra=buffer.readUInt16LE(at+28),name=buffer.subarray(at+30,at+30+names).toString();
    const start=at+30+names+extra,raw=buffer.subarray(start,start+size),body=method===8?inflateRawSync(raw):raw;
    assert.equal(body.length,length);files.set(name,body);at=start+size;
  }
  assert.equal(buffer.readUInt32LE(at),0x02014b50);
  assert.equal(buffer.readUInt32LE(buffer.length-22),0x06054b50);
  assert.equal(buffer.readUInt16LE(buffer.length-12),files.size);
  return files;
}
async function packed(entries,compress){const chunks=[];for await(const b of Export.archive(entries,compress))chunks.push(b);return Buffer.concat(chunks);}
const model={modelName:'测试 <模型> "A"',nodes:[{nodeNo:4,x:0,y:0},{nodeNo:9,x:1,y:0},{nodeNo:12,x:0,y:1}],elements:[{elementNo:7,nodeNumbers:[4,9,12],materialNo:2}]};
const baseline={time:0,pressure:0,u:[0,0,0,0,0,0],v:[0,0,0,0,0,0],elements:[[0,0,0,-10,-10,0,0,-10,0,0]]};
const frame={time:.0001,pressure:1e8,u:[0,0,3e-6,4e-6,0,0],v:[0,0,3,4,0,0],elements:[[.001,-.002,.006,-8,-8,2,.8,-8,.3,0]]};
test('blast tables preserve IDs, SI values, velocities, tensor shear and 3D incremental stress',()=>{
  const data=Export.blastData(model,frame,baseline),e=data.elements[0];
  assert.equal(data.nodes[1].speed,5);assert.ok(Math.abs(data.nodes[1].displacementMagnitude-5e-6)<1e-20);
  assert.equal(e.strainXy,.003);assert.equal(e.equivalentStress,Math.sqrt(12));assert.equal(e.dynamicEquivalentStress,Math.sqrt(12));
  assert.equal(e.stressZz,-8);assert.equal(e.plasticStrain,.3);
  const tables=Export.tables(data);assert.match(tables[0].text,/9,1,0,0.000003,0.000004,/);assert.match(tables[0].text,/,3,4,5,/);assert.match(tables[1].text,/7,4,9,12,2/);
});
test('standard ZIP holds all frame tables, history and selected-frame self-contained SVG with escaped labels',async()=>{
  const reads=[],manifest={settings:{duration:.0001},frames:[{time:0,pressure:0},{time:.0001,pressure:1e8,gasVentedMass:.25}]};
  const entries=Export.blastDocuments(model,manifest,async i=>{reads.push(i);return [baseline,frame][i];},1);
  const files=readZip(await packed(entries,raw=>deflateRawSync(raw)));
  assert.ok(files.has('frames/frame_0000_nodes.csv'));assert.ok(files.has('frames/frame_0001_elements.csv'));
  assert.match(files.get('history.csv').toString(),/gasVentedMass \[kg\/m\]/);
  const svg=files.get('figures/frame_0001_stressXx.svg').toString();
  assert.match(svg,/Stress xx \[Pa\]/);assert.match(svg,/t = 1.00000e-4 s/);assert.match(svg,/&lt;模型&gt;/);assert.match(svg,/<polygon/);assert.doesNotMatch(svg,/<script|NaN|Infinity/);
  assert.match(files.get('index.html').toString(),/帧 1/);assert.deepEqual(reads,[0,1,1]);
});
test('static export uses loaded results and contains tables, independent component figures and source records',async()=>{
  const context=vm.createContext({isFinitePoint:p=>Number.isFinite(p.x)&&Number.isFinite(p.y)});vm.runInContext(fs.readFileSync(require.resolve('../src/pages/results/render.js'),'utf8'),context);
  const input=context.parseCalculationInputText(fs.readFileSync(require.resolve('./fixtures/calculation-input.txt'),'utf8'));
  const result=context.parseCalculationResultText(fs.readFileSync(require.resolve('./fixtures/calculation-result.txt'),'utf8'));
  const data=context.buildCalculationResultData(input,result),files=readZip(await packed(Export.documents(data)));
  assert.ok(files.has('nodes.csv'));assert.ok(files.has('elements.csv'));assert.ok(files.has('figures/safetyCode.svg'));assert.ok(files.has('figures/strainXy.svg'));
  assert.deepEqual(JSON.parse(files.get('result.json')),JSON.parse(JSON.stringify(result)));
  assert.match(files.get('nodes.csv').toString(),/ux \[model\]/);
});
test('CSV handles Unicode, quotes, newlines, missing values and prevents spreadsheet formulas',()=>{
  assert.equal(Export.csv([['中文,"\n','=1+1',-1,NaN,undefined]]),'\uFEFF"中文,""\n","\'=1+1",-1,,""\r\n');
});
module.exports={readZip};
