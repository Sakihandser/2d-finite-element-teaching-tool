const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { Worker } = require("node:worker_threads");
const { executeCalculationCoreBinary } = require("../server");
const root = path.resolve(__dirname, "..");

test("native timeout terminates a real child process instead of leaving it running", async () => {
  let pid;
  await assert.rejects(executeCalculationCoreBinary(process.execPath, Buffer.alloc(0),
    ["-e", "process.stderr.write(String(process.pid));setInterval(()=>{},1000)"], false, 1000), error => {
    assert.equal(error.code, "ETIMEDOUT");
    pid = Number(error.stderr);
    return true;
  });
  assert.ok(pid > 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("the refinement worker loads actual Triangle WASM and returns a conforming refined mesh", async t => {
  const server = http.createServer((request, response) => {
    const file = path.join(root, request.url);
    response.setHeader("Content-Type", request.url.endsWith(".wasm") ? "application/wasm" : "text/javascript");
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/src/core/adaptive-refinement-worker.js`;
  // Provide browser worker globals while executing the actual worker source
  // and Triangle module in a separate OS thread; fetch resolves relative URLs
  // using the worker's own location, just as it does in a browser.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
    const context = vm.createContext({ console, WebAssembly, TextDecoder, TextEncoder, setTimeout, clearTimeout,
      fetch: (url, options) => fetch(new URL(url, workerData.url), options) });
    context.self = context;
    context.location = { href: workerData.url };
    context.postMessage = result => parentPort.postMessage(result);
    context.importScripts = (...urls) => {
      for (const url of urls) {
        const file = path.join(workerData.root, new URL(url, workerData.url).pathname);
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
      }
    };
    vm.runInContext(fs.readFileSync(path.join(workerData.root, 'src/core/adaptive-refinement-worker.js'), 'utf8'), context);
    parentPort.on('message', data => context.onmessage({ data }));
  `, { eval: true, workerData: { root, url } });
  t.after(() => worker.terminate());
  const nodes = [{ id: "A1", x: 0, y: 0 }, { id: "A2", x: 1, y: 0 }, { id: "A3", x: 1, y: 1 }, { id: "A4", x: 0, y: 1 }];
  const elements = [["A1", "A2", "A3"], ["A1", "A3", "A4"]].map((nodeIds, index) => ({
    id: `E${index + 1}`, nodeIds, regionId: "R1", materialId: "M1", area: 0.5,
    edges: nodeIds.map((a, i) => ({ nodeIds: [a, nodeIds[(i + 1) % 3]], boundary: !([a, nodeIds[(i + 1) % 3]].includes("A1") && [a, nodeIds[(i + 1) % 3]].includes("A3")) })),
  }));
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("refinement worker did not respond")), 10000);
    worker.once("message", data => { clearTimeout(timer); resolve(data); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.postMessage({ nodes, elements, marked: ["E1"], options:{maxNodes:7} });
  });
  assert.equal(response.error, undefined);
  assert.ok(response.result.analysisNodes.length<=7);
  assert.ok(response.result.elements.length > 2);
  assert.ok(Math.abs(response.result.elements.reduce((sum, e) => sum + e.area, 0) - 1) < 1e-10);
  assert.ok(response.result.elements.every(e => e.regionId === "R1" && e.materialId === "M1"));
  assert.equal(response.result.quality.engine, "triangle-wasm-rpq20");
});
