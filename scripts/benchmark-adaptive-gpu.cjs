"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const os = require("node:os");
const { createHash } = require("node:crypto");
const triangle = require("../src/vendor/triangle-wasm/triangle-wasm");
const { plateMesh, buildPlateModel } = require("../tests/helpers/adaptive-plate");
const { estimateZZError, refineAdaptiveWithTriangle, createAdaptiveRefinementPolicy, markAdaptiveElements } = require("../src/core/adaptive-mesh");
const { encodeCalculationModelBinary, decodeCalculationResultBinary } = require("../calculation-ipc");
const { run, compareBuffers, median } = require("./benchmark-gpu-compute.cjs");
const root = path.resolve(__dirname,"..");

async function main() {
  const server=http.createServer((request,response)=>{
    response.setHeader("Content-Type","application/wasm");
    fs.createReadStream(path.join(root,"src/vendor/triangle-wasm/triangle.out.wasm")).pipe(response);
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    await triangle.init(`http://127.0.0.1:${server.address().port}/triangle.out.wasm`);
    const report={schema:1,date:new Date().toISOString(),cpu:os.cpus()[0].model,
      executableSha256:createHash("sha256").update(fs.readFileSync(path.join(root,"计算力学程序计算核心/x64/Release/计算力学程序计算核心.exe"))).digest("hex"),
      case:"elliptical slit with concentrated force; actual ZZ marking and Triangle refinement",
      rounds:8,repeats:5,lifecycle:"one native process per solve, unchanged application architecture",snapshots:[],trials:[]};
    let mesh=plateMesh(triangle,1);
    const policy=createAdaptiveRefinementPolicy(mesh.analysisNodes,mesh.elements);
    // Freeze one CPU-selected mesh trajectory: both backends solve identical
    // topology, coordinates and loads, rather than comparing diverging meshes.
    const inputs=[], references=[];
    for (let iteration=0;iteration<=8;iteration++) {
      const {model,payload}=buildPlateModel(mesh,true);
      const input={buffer:encodeCalculationModelBinary(model)};
      const reference=run(input,"cpu");
      const result=decodeCalculationResultBinary(reference.bytes);
      const estimate=estimateZZError(payload,result);
      report.snapshots.push({iteration,nodes:model.nodes.length,elements:model.elements.length,relativeError:estimate.relativeError});
      inputs.push(input); references.push(reference.bytes);
      if (iteration<8) {
        const selection=markAdaptiveElements(payload,estimate,policy);
        assert.ok(selection.marked.size>0);
        mesh=refineAdaptiveWithTriangle(triangle,mesh.analysisNodes,mesh.elements,selection.marked);
      }
    }
    const solveSequence=mode=>{
      const start=performance.now();
      const runs=inputs.map(input=>run(input,mode));
      const totalMs=performance.now()-start;
      runs.forEach((result,i)=>compareBuffers(result.bytes,references[i]));
      return {totalMs,nativeWallMs:runs.reduce((s,r)=>s+r.metrics.wallMs,0),runs:runs.map(r=>r.metrics)};
    };
    solveSequence("cpu"); solveSequence("gpu"); // Excluded warmup.
    for (let repeat=0;repeat<5;repeat++) {
      const trial={};
      for (const mode of repeat%2?["gpu","cpu"]:["cpu","gpu"]) trial[mode]=solveSequence(mode);
      report.trials.push(trial);
      console.log(`adaptive sequence ${repeat+1}/5: CPU ${trial.cpu.totalMs.toFixed(1)}ms GPU ${trial.gpu.totalMs.toFixed(1)}ms`);
    }
    report.medians={cpuMs:median(report.trials.map(t=>t.cpu.totalMs)),gpuMs:median(report.trials.map(t=>t.gpu.totalMs))};
    report.scope="times native solves+IPC+log reading across fixed real adaptive snapshots; excludes ZZ/meshing and browser rendering, which run identically on CPU";
    fs.mkdirSync(path.join(root,"docs/benchmarks"),{recursive:true});
    fs.writeFileSync(path.join(root,"docs/benchmarks/gpu-adaptive-sequence.json"),JSON.stringify(report,null,2)+"\n");
    console.log(JSON.stringify({snapshots:report.snapshots,medians:report.medians}));
  } finally { await new Promise(resolve=>server.close(resolve)); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
