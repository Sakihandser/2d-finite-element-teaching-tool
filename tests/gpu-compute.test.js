"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { encodeCalculationModelBinary, decodeCalculationResultBinary } = require("../calculation-ipc");
const root = path.resolve(__dirname, "..");
const exe = path.join(root, "计算力学程序计算核心/x64/Release/计算力学程序计算核心.exe");

// A connected, constrained plate exercises assembly and LDLT as well as both
// kernels. Nonuniform coordinates, mixed materials and loads expose packing,
// shear, matrix-transpose and batch-boundary errors.
function plate(divisions) {
  const materials = [0.17, 0.32].map((poissonRatio, i) => ({
    materialNo: i + 1, elasticModulus: (i + 1) * 70e9, poissonRatio,
    density: 2700, yieldStrength: 5e4, tensileStrength: 8e4, compressiveStrength: 8e4,
  }));
  const nodes = [], elements = [];
  const number = (x, y) => y * (divisions + 1) + x + 1;
  for (let y = 0; y <= divisions; y++) for (let x = 0; x <= divisions; x++) {
    const nodeNo = number(x, y);
    nodes.push({ nodeNo, x: 2 * (x / divisions) ** 1.1, y: (y / divisions) ** 1.05,
      fixUx: x === 0, fixUy: x === 0, dofUx: nodeNo * 2 - 1, dofUy: nodeNo * 2,
      forceX: x === divisions ? 500 / divisions : 0,
      forceY: x === divisions ? -1000 / divisions : 0, materialNo: 1, regionNo: 1 });
  }
  for (let y = 0; y < divisions; y++) for (let x = 0; x < divisions; x++) {
    for (const ids of [[number(x, y), number(x + 1, y), number(x + 1, y + 1)],
      [number(x, y), number(x + 1, y + 1), number(x, y + 1)]]) {
      const [a, b, c] = ids.map(id => nodes[id - 1]);
      const material = materials[x < divisions / 2 ? 0 : 1];
      elements.push({ ...material, elementNo: elements.length + 1,
        node1: ids[0], node2: ids[1], node3: ids[2], nodeNumbers: ids,
        area: ((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y))/2,
        centroidX: (a.x+b.x+c.x)/3, centroidY: (a.y+b.y+c.y)/3 });
    }
  }
  return { modelName: "gpu-parity-plate", generatedAt: "2026-10-13",
    units: { length: "m", force: "N", elasticModulus: "Pa", density: "kg/m3", strength: "Pa" },
    counts: { nodes: nodes.length, elements: elements.length, materials: materials.length,
      pointLoads: divisions + 1, distributedLoads: 0, bodyLoads: 0 },
    materials, nodes, elements, elementNodeLoads: [], warnings: [] };
}

function solve(model, mode, device = "", threshold = "") {
  const start = performance.now();
  const execution = spawnSync(exe, ["--binary-ipc"], { cwd: root,
    input: encodeCalculationModelBinary(model), encoding: null, windowsHide: true,
    timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FEM_COMPUTE: mode, FEM_GPU_DEVICE: device, FEM_GPU_MIN_ELEMENTS: String(threshold) } });
  assert.equal(execution.error, undefined, execution.error?.message);
  const status = execution.stderr?.toString("utf8");
  assert.equal(execution.status, 0, status);
  return { result: decodeCalculationResultBinary(execution.stdout), status, ms: performance.now()-start };
}

function compare(actual, expected) {
  for (const section of ["nodeDisplacements", "elementResults"]) {
    assert.equal(actual[section].length, expected[section].length);
    actual[section].forEach((row, i) => {
      for (const [key, value] of Object.entries(row)) {
        if (typeof value !== "number") continue;
        const reference = expected[section][i][key];
        if (/No$|safetyCode/.test(key)) assert.equal(value, reference);
        else {
          assert.ok(Number.isFinite(value), `${section}/${i}/${key} finite`);
          const tolerance = Math.max(1e-12, Math.abs(reference)*1e-8,
            key.startsWith("stress") ? 1e-5 : 0);
          assert.ok(Math.abs(value-reference) <= tolerance,
            `${section}/${i}/${key}: ${value} != ${reference}`);
        }
      }
    });
  }
}

test("small automatic model uses CPU; forced unavailable GPU falls back with identical results", () => {
  const model = plate(8);
  const cpu = solve(model, "cpu");
  assert.match(cpu.status, /CPU explicitly selected/);
  const auto = solve(model, "auto");
  assert.match(auto.status, /CPU: no validated GPU crossover/);
  compare(auto.result, cpu.result);
  const belowThreshold = solve(model, "auto", "", "131072");
  assert.match(belowThreshold.status, /CPU: small model/);
  compare(belowThreshold.result, cpu.result);
  for (const threshold of ["0", "-1", "131072garbage", "9999999999999999999999999"]) {
    const invalid = solve(model, "auto", "", threshold);
    assert.match(invalid.status, /CPU: invalid FEM_GPU_MIN_ELEMENTS/);
    compare(invalid.result, cpu.result);
  }
  const missing = solve(model, "gpu", "__nonexistent_gpu_for_fallback_test__");
  assert.match(missing.status, /CPU fallback:|CPU: optional OpenCL/);
  compare(missing.result, cpu.result);
});

test("GPU plate results match CPU across the 16384-element batch boundary", t => {
  const model = plate(92); // 16928 elements: two GPU batches.
  const cpu = solve(model, "cpu");
  const gpu = solve(model, "gpu");
  if (!gpu.status.includes("OpenCL FP64:")) {
    assert.notEqual(process.env.FEM_TEST_REQUIRE_GPU, "1", gpu.status);
    compare(gpu.result, cpu.result);
    t.skip("No compatible OpenCL FP64 GPU; CPU fallback verified");
    return;
  }
  compare(gpu.result, cpu.result);
  assert.match(gpu.status, /Element strain\/stress backend: OpenCL GPU FP64/);
  const auto = solve(model, "auto");
  assert.match(auto.status, /CPU: no validated GPU crossover/);
  compare(auto.result, cpu.result);
  t.diagnostic(`wall time including process/IPC: CPU ${cpu.ms.toFixed(1)}ms, GPU ${gpu.ms.toFixed(1)}ms, auto ${auto.ms.toFixed(1)}ms`);
});

test("large default model stays on CPU; a configured threshold selects GPU at its boundary", t => {
  const model = plate(256); // 131072 elements: explicit threshold boundary.
  const cpu = solve(model, "cpu");
  const defaultAuto = solve(model, "auto");
  assert.match(defaultAuto.status, /CPU: no validated GPU crossover/);
  compare(defaultAuto.result, cpu.result);
  const auto = solve(model, "auto", "", 131072);
  if (!auto.status.includes("OpenCL FP64:")) {
    assert.notEqual(process.env.FEM_TEST_REQUIRE_GPU, "1", auto.status);
    compare(auto.result, cpu.result);
    t.skip("No compatible GPU; automatic CPU fallback verified");
    return;
  }
  assert.match(auto.status, /Element strain\/stress backend: OpenCL GPU FP64/);
  compare(auto.result, cpu.result);
  t.diagnostic(`131072 elements, wall time including IPC: CPU ${cpu.ms.toFixed(1)}ms, auto GPU ${auto.ms.toFixed(1)}ms`);
  if (process.env.FEM_GPU_BENCHMARK === "1") {
    const cpuTimes = [], gpuTimes = [];
    // The preceding solves warm up the driver; alternate order to reduce bias.
    for (let i = 0; i < 5; i++) {
      const modes = i % 2 ? ["gpu", "cpu"] : ["cpu", "gpu"];
      for (const mode of modes) {
        const run = solve(model, mode);
        if (mode === "gpu") assert.match(run.status, /Element strain\/stress backend: OpenCL GPU FP64/);
        compare(run.result, cpu.result);
        (mode === "cpu" ? cpuTimes : gpuTimes).push(run.ms);
      }
    }
    const median = times => [...times].sort((a,b) => a-b)[2].toFixed(1);
    t.diagnostic(`5-run median, 131072 elements, including process/IPC: CPU ${median(cpuTimes)}ms, GPU ${median(gpuTimes)}ms`);
  }
});
