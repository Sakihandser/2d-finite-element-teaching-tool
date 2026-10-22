'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/pages/training/dashboard.js'),'utf8');
const chart=source.slice(source.indexOf('  function chart(history)'),source.indexOf('  function renderDashboard()'));
function render(history) {
  const svg={innerHTML:''};
  vm.runInNewContext(chart+'\nchart(history);',{history,element:()=>svg});
  return svg.innerHTML;
}

test('legacy curve marks the first validation epoch and does not connect across data changes',()=>{
  const svg=render([
    {epoch:99,loss:.03,validationLoss:null},{epoch:100,loss:.02,validationLoss:null},
    {epoch:101,loss:.3,validationLoss:.4},{epoch:102,loss:.2,validationLoss:.3}]);
  assert.equal((svg.match(/<polyline /g)||[]).length,3);
  assert.equal((svg.match(/stroke-dasharray=/g)||[]).length,1);
  assert.ok(svg.includes('数据或评估口径调整'));
});

test('phase boundaries and missing values break curves without smoothing away spikes',()=>{
  const svg=render([
    {epoch:1,loss:.1,validationLoss:.2,phase:0},{epoch:2,loss:.05,validationLoss:null,phase:0},
    {epoch:3,loss:.8,validationLoss:.9,phase:1},{epoch:4,loss:.4,validationLoss:.6,phase:1}]);
  assert.equal((svg.match(/<polyline /g)||[]).length,3);
  assert.equal((svg.match(/<circle /g)||[]).length,1);
  assert.equal((svg.match(/stroke-dasharray=/g)||[]).length,1);
  assert.ok(!svg.includes('NaN'));
});
