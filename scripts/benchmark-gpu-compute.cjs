"use strict";
// Run one benchmark at a time on an otherwise idle machine. Encoding and parity
// checks are outside the timer; process startup, input/output pipes
// are inside it, matching server.js's current per-solve process lifecycle.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const exe = path.join(root, "TensoraCore/x64/Release/TensoraCore.exe");
const args = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, "").split("=")));
const divisions = (args.divisions || "32,64,128,256,384,512,704").split(",").map(Number);
const repeats = Number(args.repeats || 5);
assert.ok(divisions.every(n => Number.isInteger(n) && n >= 2 && n <= 704));
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 9);
const output = path.resolve(args.output || path.join(os.tmpdir(), "fem-gpu-compute-sweep.json"));
const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length/2)];

function encodePlate(n) {
  const nodeCount = (n+1)**2, elementCount = 2*n*n;
  // Generate directly into the existing binary protocol to avoid retaining a
  // million JS element objects. Nonuniform grading and two materials are used.
  const strings = ["gpu-sweep-graded-plate", "2026-10-13", "m", "N", "Pa", "kg/m3", "Pa"];
  const bytes = 12 + strings.reduce((s,v) => s+4+Buffer.byteLength(v),0) + 40 + 2*52 + nodeCount*54 + elementCount*92 + 4;
  const buffer = Buffer.allocUnsafe(bytes);
  let p = 0;
  const i32 = v => { buffer.writeInt32LE(v,p); p+=4; };
  const u32 = v => { buffer.writeUInt32LE(v,p); p+=4; };
  const f64 = v => { buffer.writeDoubleLE(v,p); p+=8; };
  Buffer.from("FEMBIN01").copy(buffer,p); p+=8; u32(1);
  for (const s of strings) { const b = Buffer.from(s); u32(b.length); b.copy(buffer,p); p+=b.length; }
  [nodeCount,elementCount,2,n+1,0,0].forEach(i32);
  [2,nodeCount,elementCount,0].forEach(u32);
  for (let m=0;m<2;m++) { i32(m+1); [70e9*(m+1),[0.17,0.32][m],2700,5e4,8e4,8e4].forEach(f64); }
  const x = Array.from({length:n+1}, (_,i) => 2*(i/n)**1.1);
  const y = Array.from({length:n+1}, (_,i) => (i/n)**1.05);
  const number = (i,j) => j*(n+1)+i+1;
  for (let j=0;j<=n;j++) for (let i=0;i<=n;i++) {
    const no=number(i,j); i32(no); f64(x[i]); f64(y[j]);
    buffer[p++]=i===0?1:0; buffer[p++]=i===0?1:0;
    i32(no*2-1); i32(no*2); f64(i===n?500/n:0); f64(i===n?-1000/n:0); i32(1); i32(1);
  }
  let element = 0;
  for (let j=0;j<n;j++) for (let i=0;i<n;i++) {
    const m = i<n/2?0:1, area=(x[i+1]-x[i])*(y[j+1]-y[j])/2;
    for (let t=0;t<2;t++) {
      const ids=t===0?[number(i,j),number(i+1,j),number(i+1,j+1)]:[number(i,j),number(i+1,j+1),number(i,j+1)];
      [++element,...ids].forEach(i32); f64(area);
      f64(t===0?(x[i]+2*x[i+1])/3:(2*x[i]+x[i+1])/3);
      f64(t===0?(2*y[j]+y[j+1])/3:(y[j]+2*y[j+1])/3);
      i32(m+1); [70e9*(m+1),[0.17,0.32][m],2700,5e4,8e4,8e4].forEach(f64);
    }
  }
  u32(0); assert.equal(p,bytes);
  return { buffer, nodes:nodeCount, elements:elementCount };
}

function compareBuffers(actual, expected) {
  assert.equal(actual.length,expected.length);
  assert.ok(actual.subarray(0,20).equals(expected.subarray(0,20)),"result header");
  const nodes=actual.readUInt32LE(12), elements=actual.readUInt32LE(16);
  let p=20, maxRelative=0, maxAbsoluteStress=0;
  for (const [count,width,doubles] of [[nodes,28,3],[elements,72,8]]) {
    for (let i=0;i<count;i++,p+=width) {
      assert.equal(actual.readInt32LE(p),expected.readInt32LE(p));
      for (let j=0;j<doubles;j++) {
        const a=actual.readDoubleLE(p+4+8*j), b=expected.readDoubleLE(p+4+8*j);
        assert.ok(Number.isFinite(a)&&Number.isFinite(b));
        const diff=Math.abs(a-b), stress=doubles===8 && j>=4;
        const tolerance=Math.max(1e-12, Math.abs(b)*1e-8,stress?1e-5:0);
        assert.ok(diff<=tolerance,`record ${i}/${j}: ${a} != ${b}`);
        if (Math.abs(b)>1e-8) maxRelative=Math.max(maxRelative,diff/Math.abs(b));
        if (stress) maxAbsoluteStress=Math.max(maxAbsoluteStress,diff);
      }
      if (doubles===8) assert.equal(actual.readInt32LE(p+68),expected.readInt32LE(p+68),"safety code");
    }
  }
  assert.equal(p,actual.length);
  return { maxRelative, maxAbsoluteStress };
}

function run(input,mode) {
  const start=performance.now();
  const child=spawnSync(exe,["--binary-ipc"],{cwd:root,input:input.buffer,encoding:null,
    env:{...process.env,FEM_COMPUTE:mode,FEM_GPU_DEVICE:"",FEM_THREADS:"8"},
    windowsHide:true,timeout:120000,maxBuffer:100000000});
  const wallMs=performance.now()-start;
  assert.equal(child.error,undefined,child.error?.message);
  const stderr=child.stderr.toString("utf8"); assert.equal(child.status,0,stderr);
  if (mode==="gpu") {
    assert.match(stderr,/Element compute backend: OpenCL FP64:/);
    assert.match(stderr,/Element strain\/stress backend: OpenCL GPU FP64/);
  }
  return { bytes:child.stdout, metrics:{ wallMs,
    backend:stderr.match(/Element compute backend: (.+)/)?.[1]?.trim() } };
}

function main() {
const report={ schema:1,date:new Date().toISOString(),cpu:os.cpus()[0].model,
  executableSha256:createHash("sha256").update(fs.readFileSync(exe)).digest("hex"),completed:false,
  ramGB:os.totalmem()/2**30,platform:os.platform(),threads:8,repeats,
  family:"graded rectangular plate, two materials, sequential increasing meshes",
  lifecycle:"fresh native process per solve, as current adaptive workflow",
  timing:"pre-encoded IPC input; process, native solve and result IPC; excludes JS encode/decode, ZZ and meshing",
  decisionRule:"GPU wall median >=10% faster, wins >=4/5 paired trials, at three consecutive tested scales; threshold must lie within tested interval",
  rows:[],validatedThreshold:null };
fs.mkdirSync(path.dirname(output),{recursive:true});
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n");
for (const n of divisions) {
  const input=encodePlate(n);
  console.log(`Testing ${input.elements} elements / ${input.nodes} nodes ...`);
  const warmCpu=run(input,"cpu"), warmGpu=run(input,"gpu");
  const parity=compareBuffers(warmGpu.bytes,warmCpu.bytes);
  const row={divisions:n,nodes:input.nodes,elements:input.elements,parity,cpu:[],gpu:[]};
  for (let repeat=0;repeat<repeats;repeat++) {
    for (const mode of repeat%2?["gpu","cpu"]:["cpu","gpu"]) {
      const result=run(input,mode);
      compareBuffers(result.bytes,warmCpu.bytes);
      row[mode].push(result.metrics);
    }
    console.log(`  pair ${repeat+1}/${repeats}: CPU ${row.cpu.at(-1).wallMs.toFixed(1)}ms GPU ${row.gpu.at(-1).wallMs.toFixed(1)}ms`);
  }
  row.medians={};
  for (const mode of ["cpu","gpu"]) for (const key of ["wallMs"])
    (row.medians[mode]??={})[key]=median(row[mode].map(r=>r[key]));
  row.gpuSpeedup=row.medians.cpu.wallMs/row.medians.gpu.wallMs;
  row.gpuWins=row.cpu.filter((r,i)=>row.gpu[i].wallMs<r.wallMs).length;
  report.rows.push(row); save();
  console.log(`  median: CPU ${row.medians.cpu.wallMs.toFixed(1)}ms GPU ${row.medians.gpu.wallMs.toFixed(1)}ms speedup ${row.gpuSpeedup.toFixed(3)}x`);
}
for (let i=0;i+2<report.rows.length;i++) {
  const window=report.rows.slice(i,i+3);
  if (window.every(r=>r.gpuSpeedup>=1/0.9 && r.gpuWins>=Math.ceil(repeats*0.8))) {
    report.validatedThreshold=window[0].elements; break;
  }
}
report.sequence={cpuMs:median(Array.from({length:repeats},(_,i)=>report.rows.reduce((s,r)=>s+r.cpu[i].wallMs,0))),
  gpuMs:median(Array.from({length:repeats},(_,i)=>report.rows.reduce((s,r)=>s+r.gpu[i].wallMs,0)))};
report.completed=true;
save();
console.log(`Validated threshold: ${report.validatedThreshold??"none in tested range"}; saved ${output}`);
}
if (require.main === module) main();
module.exports = { encodePlate, compareBuffers, run, median };
