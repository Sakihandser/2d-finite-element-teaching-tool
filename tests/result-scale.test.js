"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const input = { value: "1", setAttribute(name, value) { this[name] = value; } };
  let renders = 0;
  const api = vm.createContext({
    resultDeformationScale: input, resultDeformationScaleValue: {}, resultDeformationScaleRecommended: {},
    calculationResultData: null, activeResultView: "deformation", resultViewButtons: [],
    RESULT_VIEW_LABELS: { deformation: "Deformation", stress: "Stress" },
    readNumber: (element, fallback) => Number(element.value) || fallback,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)), formatNumber: String,
    requestAnimationFrame() { throw new Error("Result scale must not animate"); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/pages/results/render.js"), "utf8"), api);
  api.renderResultView = () => { renders++; };
  api.updateResultPanel = api.applyCalculationResultsToScene = api.fitResultViewToData =
    api.setResultStatus = api.updateCalculationPanel = api.renderCalculationView = () => {};
  api.buildCalculationResultData = () => ({ modelSize: 100, maxDisplacement: 0.02, elements: [] });
  return { api, input, renders: () => renders };
}

test("loading results starts at 1x with a manual slider bounded by the recommendation", () => {
  const { api, input } = harness();
  const result = api.loadCalculationResultsFromData({ nodes: [] }, { nodeDisplacements: [] });
  assert.ok(result);
  assert.equal(input.value, "1");
  assert.equal(input.min, "1");
  assert.equal(input.max, "800");
  assert.equal(input.disabled, false);
  assert.equal(api.resultDisplacementFactor(), 1);
  assert.equal(api.resultDeformationScaleValue.textContent, "1×");
  assert.equal(api.resultDeformationScaleRecommended.textContent, "800×");
});

test("dragging the slider updates geometry and its readout without animation", () => {
  const h = harness();
  h.api.calculationResultData = { modelSize: 100, maxDisplacement: 0.02 };
  h.api.resetResultDeformationScale();
  h.input.value = "123.75";
  h.api.handleResultDeformationScaleInput();
  assert.equal(h.api.resultDisplacementFactor(), 123.75);
  assert.equal(h.api.deformedResultNode({ x: 3, y: 5, ux: 0.02, uy: 0 }, h.api.resultDisplacementFactor()).x, 5.475);
  assert.equal(h.api.resultDeformationScaleValue.textContent, "123.8×");
  assert.equal(h.renders(), 1);
  h.api.setResultDeformationScale(10000);
  assert.equal(h.input.value, "800");
  h.api.setResultDeformationScale(-2);
  assert.equal(h.input.value, "1");
});

test("switching plots preserves the manual scale; loading a new result resets to 1x and updates its bound", () => {
  const { api, input } = harness();
  api.calculationResultData = { modelSize: 100, maxDisplacement: 0.02 };
  api.resetResultDeformationScale();
  api.setResultDeformationScale(200);
  api.setResultView("stress");
  api.setResultView("deformation");
  assert.equal(input.value, "200");
  api.buildCalculationResultData = () => ({ modelSize: 20, maxDisplacement: 0.1, elements: [] });
  api.loadCalculationResultsFromData({ nodes: [] }, { nodeDisplacements: [] });
  assert.equal(input.value, "1");
  assert.equal(input.max, "32");
});

test("missing, zero, or invalid displacement data leaves a stable disabled 1x slider", () => {
  const { api, input } = harness();
  for (const data of [null, { modelSize: 5, maxDisplacement: 0 }, { modelSize: NaN, maxDisplacement: 0.2 }, { modelSize: 1, maxDisplacement: 5 }]) {
    api.calculationResultData = data;
    api.resetResultDeformationScale();
    assert.equal(input.value, "1");
    assert.equal(input.max, "1");
    assert.equal(input.disabled, true);
  }
});
