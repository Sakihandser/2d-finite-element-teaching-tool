"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../src/pages/results/render.js"), "utf8");
function harness() {
  const context = vm.createContext({ isFinitePoint: (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
    scene: { analysisNodes: [], mesh: { elements: [] } }, resultUi: {}, activeResultView: "stress",
    escapeHtml: String, formatNumber: String, RESULT_SAFETY_LABELS: {} });
  vm.runInContext(source, context);
  return context;
}

test("large result ranges and bounds do not overflow the JavaScript argument stack", () => {
  const api = harness();
  const values = Array.from({ length: 300000 }, (_, index) => index - 150000);
  const range = api.rangeForValues(values);
  assert.equal(range.min, -150000); assert.equal(range.max, 149999);
  const bounds = api.boundsForPoints(values.map((value) => ({ x: value, y: -value })));
  assert.equal(bounds.minX, -150000); assert.equal(bounds.maxY, 150000);
});

test("result writeback uses numbered matches and index fallback without repeated array scans", () => {
  const api = harness();
  api.scene.analysisNodes = [{ number: 2 }, { number: 1 }];
  api.scene.mesh.elements = [{ number: 2 }, { number: 1 }];
  api.scene.analysisNodes.find = () => { throw new Error("quadratic scan"); };
  api.scene.mesh.elements.find = () => { throw new Error("quadratic scan"); };
  api.applyCalculationResultsToScene({ nodes: [{ nodeNo: 1, ux: 5, uy: 6 }, { nodeNo: 2, ux: 7, uy: 8 }],
    elements: [{ elementNo: 1, stressXx: 10 }, { elementNo: 2, stressXx: 20 }] });
  assert.equal(api.scene.analysisNodes[1].ux, 5);
  assert.equal(api.scene.mesh.elements[0].result.stress.xx, 20);
});

test("panning and animation reuse the legend instead of replacing its DOM each frame", () => {
  const api = harness();
  let writes = 0;
  api.activeResultView = "deformation";
  api.resultUi.legend = { set innerHTML(value) { writes++; } };
  const data = { ranges: { displacementMagnitude: { min: 0, max: 1 } } };
  for (let i = 0; i < 60; i++) api.updateResultLegend(data);
  assert.equal(writes, 1);
  api.updateResultLegend({ ...data });
  assert.equal(writes, 2);
});

test("partial GPU failure draws only the missing deformation layer in Canvas", () => {
  const api = harness();
  api.calculationResultData = { elements: [{ nodes: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], displacementMagnitude: 0 }], ranges: { displacementMagnitude: { min: 0, max: 1 } } };
  api.resultDisplacementFactor = () => 1;
  let gpuCalls = 0, canvasCalls = 0;
  api.drawGpuResultMesh = () => ++gpuCalls === 1;
  api.resultCtx = { save() {}, restore() {}, setLineDash() {} };
  api.COLORS = { resultOriginalMesh: "#000000" };
  api.resultColorForScalar = () => "#007c89";
  api.hexToRgba = (color) => color;
  api.drawResultElement = () => canvasCalls++;
  api.drawResultDeformation();
  assert.equal(gpuCalls, 2);
  assert.equal(canvasCalls, 1);
});
