"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness() {
  const element = { getContext: () => ({}), value: "", classList: { toggle() {} } };
  const context = vm.createContext({ console, Math, window: { devicePixelRatio: 1 },
    document: { getElementById: () => element, querySelectorAll: () => [] },
    updatePanel() {}, render() {}, selectObject() {}, closeShapeEditor() {},
  });
  for (const file of ["global/state", "core/numbers", "core/material-utils", "core/scene-objects",
    "core/regular-shapes", "core/regions", "core/analysis-classification", "core/analysis-node-placement",
    "core/analysis-mesh", "pages/drawing/load-hit-testing", "pages/drawing/inspector", "core/scene-io"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", file + ".js"), "utf8"), context);
  }
  // UI 刷新留给浏览器测试；此处验证真实几何、区域与序列化流程。
  vm.runInContext("updatePanel = () => {}; selectObject = () => {};", context);
  return context;
}

const parameters = { x: 2.75, y: -1.125, angle: 31, width: 6, height: 4, radius: 3 };

for (const [type, expectedArea] of [["rectangle", 24], ["triangle", 12], ["circle", 9 * Math.PI], ["ellipse", 6 * Math.PI]]) {
  test(type + " creates a closed region at the requested centroid and survives JSON import", () => {
    const api = harness();
    api.createRegularShape({ ...parameters, type });
    const scene = vm.runInContext("scene", api);
    assert.equal(scene.regions.length, 1);
    const region = scene.regions[0];
    assert.ok(Math.abs(region.area - expectedArea) / expectedArea < 0.0001);
    assert.ok(Math.abs(region.centroid.x - parameters.x) < 1e-6);
    assert.ok(Math.abs(region.centroid.y - parameters.y) < 1e-6);
    assert.equal(api.getStructureRegionAtPoint(parameters).id, region.id);
    const original = scene.curves.map((curve) => api.pointOnCurve(curve, 0.37));
    const restored = api.normalizeScene(JSON.parse(JSON.stringify(scene)));
    api.restoredScene = restored;
    vm.runInContext("scene = restoredScene; rebuildDerivedRegions();", api);
    assert.equal(vm.runInContext("scene.regions.length", api), 1);
    restored.curves.forEach((curve, index) => {
      const point = api.pointOnCurve(curve, 0.37);
      assert.ok(Math.hypot(point.x - original[index].x, point.y - original[index].y) < 1e-9);
    });
  });
}

test("ellipse samples lie on the analytic ellipse, including rotated shapes", () => {
  const api = harness();
  api.createRegularShape({ ...parameters, type: "ellipse" });
  const radians = parameters.angle * Math.PI / 180;
  for (const curve of vm.runInContext("scene.curves", api)) {
    for (const point of api.sampleCurve(curve, 100)) {
      const dx = point.x - parameters.x, dy = point.y - parameters.y;
      const x = dx * Math.cos(radians) + dy * Math.sin(radians);
      const y = -dx * Math.sin(radians) + dy * Math.cos(radians);
      assert.ok(Math.abs(x * x / 9 + y * y / 4 - 1) < 1e-6);
    }
  }
});

test("invalid parameters leave the model untouched", () => {
  const api = harness();
  for (const invalid of [{ width: 0 }, { height: -1 }, { x: NaN }, { angle: Infinity }, { type: "unknown" }]) {
    assert.throws(() => api.createRegularShape({ ...parameters, type: "rectangle", ...invalid }));
    assert.equal(vm.runInContext("scene.curves.length + scene.geometryNodes.length", api), 0);
  }
});
