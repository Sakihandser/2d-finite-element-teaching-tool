"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { encodeCalculationModelBinary, decodeCalculationResultBinary } = require("../calculation-ipc");

const ROOT = path.resolve(__dirname, "..");
const RELEASE_EXE = path.join(ROOT, "TensoraCore", "x64", "Release", "TensoraCore.exe");
const FIXTURE_DIR = path.join(__dirname, "fixtures");
const CURRENT_INPUT = path.join(FIXTURE_DIR, "calculation-input.txt");
const CURRENT_RESULT = path.join(FIXTURE_DIR, "calculation-result.txt");

function triangleModel() {
  return {
    modelName: "binary-pipe-triangle",
    generatedAt: new Date().toISOString(),
    units: { length: "m", force: "N", elasticModulus: "Pa", density: "kg/m3", strength: "Pa" },
    counts: { nodes: 3, elements: 1, materials: 1, pointLoads: 1, distributedLoads: 0, bodyLoads: 0 },
    materials: [
      {
        materialNo: 1,
        elasticModulus: 200e9,
        poissonRatio: 0.3,
        density: 7850,
        yieldStrength: 0,
        tensileStrength: 0,
        compressiveStrength: 0,
      },
    ],
    nodes: [
      { nodeNo: 1, x: 0, y: 0, fixUx: true, fixUy: true, dofUx: 1, dofUy: 2, forceX: 0, forceY: 0, materialNo: 1, regionNo: 1 },
      { nodeNo: 2, x: 1, y: 0, fixUx: false, fixUy: true, dofUx: 3, dofUy: 4, forceX: 0, forceY: 0, materialNo: 1, regionNo: 1 },
      { nodeNo: 3, x: 0, y: 1, fixUx: false, fixUy: false, dofUx: 5, dofUy: 6, forceX: 0, forceY: -1000, materialNo: 1, regionNo: 1 },
    ],
    elements: [
      {
        elementNo: 1,
        node1: 1,
        node2: 2,
        node3: 3,
        nodeNumbers: [1, 2, 3],
        area: 0.5,
        centroidX: 1 / 3,
        centroidY: 1 / 3,
        materialNo: 1,
        elasticModulus: 200e9,
        poissonRatio: 0.3,
        density: 7850,
        yieldStrength: 0,
        tensileStrength: 0,
        compressiveStrength: 0,
      },
    ],
    elementNodeLoads: [
      { elementNo: 1, forceX1: 0, forceY1: 0, forceX2: 0, forceY2: 0, forceX3: 0, forceY3: 0 },
    ],
    warnings: [],
  };
}

function parseCurrentTextModel(text) {
  const model = {
    modelName: "",
    generatedAt: "",
    units: {},
    counts: {},
    materials: [],
    nodes: [],
    elements: [],
    elementNodeLoads: [],
    warnings: [],
  };
  let section = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (["MATERIALS", "NODES", "ELEMENTS", "ELEMENT_NODE_LOADS", "WARNINGS"].includes(line)) {
      section = line;
      continue;
    }
    if (line === "END") break;
    if (!section) {
      if (line.startsWith("MODEL ")) model.modelName = line.slice(6);
      if (line.startsWith("GENERATED_AT ")) model.generatedAt = line.slice(13);
      if (line.startsWith("UNITS ")) {
        for (const token of line.slice(6).split(/\s+/)) {
          const [key, value] = token.split("=");
          if (key === "LENGTH") model.units.length = value;
          if (key === "FORCE") model.units.force = value;
          if (key === "ELASTIC_MODULUS") model.units.elasticModulus = value;
          if (key === "DENSITY") model.units.density = value;
          if (key === "STRENGTH") model.units.strength = value;
        }
      }
      if (line.startsWith("COUNTS ")) {
        const values = Object.fromEntries(line.slice(7).split(/\s+/).map((token) => token.split("=")));
        model.counts = {
          nodes: Number(values.NODES),
          elements: Number(values.ELEMENTS),
          materials: Number(values.MATERIALS),
          pointLoads: Number(values.POINT_LOADS),
          distributedLoads: Number(values.DISTRIBUTED_LOADS),
          bodyLoads: Number(values.BODY_LOADS),
        };
      }
      continue;
    }
    const v = line.split(/\s+/).map(Number);
    if (section === "MATERIALS") {
      model.materials.push({ materialNo: v[0], elasticModulus: v[1], poissonRatio: v[2], density: v[3], yieldStrength: v[4], tensileStrength: v[5], compressiveStrength: v[6] });
    } else if (section === "NODES") {
      model.nodes.push({ nodeNo: v[0], x: v[1], y: v[2], fixUx: v[3] !== 0, fixUy: v[4] !== 0, dofUx: v[5], dofUy: v[6], forceX: v[7], forceY: v[8], materialNo: v[9], regionNo: v[10] });
    } else if (section === "ELEMENTS") {
      model.elements.push({ elementNo: v[0], node1: v[1], node2: v[2], node3: v[3], nodeNumbers: v.slice(1, 4), area: v[4], centroidX: v[5], centroidY: v[6], materialNo: v[7], elasticModulus: v[8], poissonRatio: v[9], density: v[10], yieldStrength: v[11], tensileStrength: v[12], compressiveStrength: v[13] });
    } else if (section === "ELEMENT_NODE_LOADS") {
      model.elementNodeLoads.push({ elementNo: v[0], forceX1: v[1], forceY1: v[2], forceX2: v[3], forceY2: v[4], forceX3: v[5], forceY3: v[6] });
    }
  }
  return model;
}

function parseCurrentTextResult(text) {
  const result = { nodeDisplacements: [], elementResults: [] };
  let section = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "NODE_DISPLACEMENTS" || line === "ELEMENT_RESULTS") {
      section = line;
      continue;
    }
    if (line === "SAFETY_CODE_MEANING" || line === "END") {
      section = "";
      continue;
    }
    const values = line.split(/\s+/);
    if (section === "NODE_DISPLACEMENTS" && values.length >= 4) {
      result.nodeDisplacements.push({
        nodeNo: Number(values[0]),
        ux: Number(values[1]),
        uy: Number(values[2]),
        magnitude: Number(values[3]),
      });
    } else if (section === "ELEMENT_RESULTS" && values.length >= 10) {
      result.elementResults.push({
        elementNo: Number(values[0]),
        strainXx: Number(values[1]),
        strainXy: Number(values[2]),
        strainYx: Number(values[3]),
        strainYy: Number(values[4]),
        stressXx: Number(values[5]),
        stressXy: Number(values[6]),
        stressYx: Number(values[7]),
        stressYy: Number(values[8]),
        safetyCode: Number(values[9]),
      });
    }
  }
  return result;
}

function assertNumericallyEqual(actual, expected, label) {
  const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-10);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
}

test("Node.js 与 C++ 通过二进制 stdin/stdout 完成 TRI3 求解", () => {
  const model = triangleModel();
  const binaryInput = encodeCalculationModelBinary(model);
  const execution = spawnSync(RELEASE_EXE, ["--binary-ipc"], {
    cwd: ROOT,
    input: binaryInput,
    encoding: null,
    timeout: 30_000,
    maxBuffer: 10_000_000,
    windowsHide: true,
  });

  assert.equal(execution.error, undefined, execution.error?.message);
  assert.equal(execution.status, 0, execution.stderr?.toString("utf8"));
  const result = decodeCalculationResultBinary(execution.stdout, { modelName: model.modelName });
  assert.equal(result.nodeDisplacements.length, 3);
  assert.equal(result.elementResults.length, 1);
  assert.equal(result.nodeDisplacements[0].ux, 0);
  assert.equal(result.nodeDisplacements[0].uy, 0);
  assert.equal(result.nodeDisplacements[1].uy, 0);
  assert.ok(result.nodeDisplacements[2].uy < 0);
  assert.ok(Number.isFinite(result.elementResults[0].stressYy));
  assert.equal(result.elementResults[0].safetyCode, 0);
});

test("完整模型夹具的二进制结果与 TXT 基准逐项一致", () => {
  const model = parseCurrentTextModel(fs.readFileSync(CURRENT_INPUT, "utf8"));
  const textResult = parseCurrentTextResult(fs.readFileSync(CURRENT_RESULT, "utf8"));
  const inputModifiedBefore = fs.statSync(CURRENT_INPUT).mtimeMs;
  const resultModifiedBefore = fs.statSync(CURRENT_RESULT).mtimeMs;
  const execution = spawnSync(RELEASE_EXE, ["--binary-ipc"], {
    cwd: ROOT,
    input: encodeCalculationModelBinary(model),
    encoding: null,
    timeout: 30_000,
    maxBuffer: 20_000_000,
    windowsHide: true,
  });
  assert.equal(execution.status, 0, execution.stderr?.toString("utf8"));
  assert.equal(fs.statSync(CURRENT_INPUT).mtimeMs, inputModifiedBefore, "默认二进制计算不应改写输入 TXT");
  assert.equal(fs.statSync(CURRENT_RESULT).mtimeMs, resultModifiedBefore, "默认二进制计算不应改写结果 TXT");
  const result = decodeCalculationResultBinary(execution.stdout, { modelName: model.modelName });
  assert.equal(result.nodeDisplacements.length, model.nodes.length);
  assert.equal(result.elementResults.length, model.elements.length);
  assert.equal(result.nodeDisplacements.length, textResult.nodeDisplacements.length);
  assert.equal(result.elementResults.length, textResult.elementResults.length);
  result.nodeDisplacements.forEach((actual, index) => {
    const expected = textResult.nodeDisplacements[index];
    assert.equal(actual.nodeNo, expected.nodeNo);
    assertNumericallyEqual(actual.ux, expected.ux, `node ${actual.nodeNo} ux`);
    assertNumericallyEqual(actual.uy, expected.uy, `node ${actual.nodeNo} uy`);
    assertNumericallyEqual(actual.magnitude, expected.magnitude, `node ${actual.nodeNo} magnitude`);
  });
  result.elementResults.forEach((actual, index) => {
    const expected = textResult.elementResults[index];
    assert.equal(actual.elementNo, expected.elementNo);
    ["strainXx", "strainXy", "strainYx", "strainYy", "stressXx", "stressXy", "stressYx", "stressYy"].forEach((key) =>
      assertNumericallyEqual(actual[key], expected[key], `element ${actual.elementNo} ${key}`),
    );
    assert.equal(actual.safetyCode, expected.safetyCode);
  });
});
