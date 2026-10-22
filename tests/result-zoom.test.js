"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../src/pages/results/render.js"), "utf8");

function harness(kind) {
  const api = vm.createContext({
    activeResultView: kind, resultView: { width: 1000, height: 800, scale: 48, offsetX: 500, offsetY: 400 },
    calculationResultData: { baseBounds: { minX: 0, maxX: 10, minY: 0, maxY: 5 } },
    resultInteraction: null, resultCtx: {}, resultUi: {}, resultViewButtons: [],
    resultCanvas: { setPointerCapture() {}, classList: { add() {}, remove() {} } },
    resultCoordReadout: {}, resultZoomReadout: {}, resultModeName: null, resultModelName: null,
    RESULT_VIEW_LABELS: {}, formatNumber: String,
    clamp: (value, min, max) => Math.max(min, Math.min(value, max)),
    resultPointerPoint: (event) => ({ x: event.clientX, y: event.clientY }),
    gpuMeshRenderer: { requestFrame() {} },
  });
  vm.runInContext(source, api);
  api.updateResultLegend = () => {};
  api.renderResultView = () => {};
  return api;
}
function event(x, y, deltaY = -400) {
  return { clientX: x, clientY: y, deltaY, pointerId: 1, preventDefault() {} };
}

for (const kind of ["stress", "strain"]) {
  test(`${kind}: zoom changes actual panel projections and keeps the cursor world point fixed`, () => {
    const api = harness(kind);
    const panel = api.resultDashboardPanels()[1];
    const cursor = { x: panel.x + panel.width * 0.7, y: panel.y + panel.height * 0.6 };
    const world = api.resultInteractionWorldPoint(cursor);
    const before = api.resultPanelProjector(panel, api.calculationResultData.baseBounds);
    const beforeSize = before({ x: 10, y: 0 }).x - before({ x: 0, y: 0 }).x;
    api.onResultWheel(event(cursor.x, cursor.y));
    const after = api.resultPanelProjector(panel, api.calculationResultData.baseBounds);
    assert.ok(after({ x: 10, y: 0 }).x - after({ x: 0, y: 0 }).x > beforeSize);
    assert.ok(Math.abs(after(world).x - cursor.x) < 1e-9);
    assert.ok(Math.abs(after(world).y - cursor.y) < 1e-9);
    api.updateResultPanel();
    assert.equal(api.resultZoomReadout.textContent, "162%");
  });

  test(`${kind}: drag pans all panels and Fit restores the original projection`, () => {
    const api = harness(kind);
    const panels = api.resultDashboardPanels();
    const bounds = api.calculationResultData.baseBounds;
    const point = { x: 5, y: 2 };
    const before = panels.map((panel) => api.resultPanelProjector(panel, bounds)(point));
    api.onResultPointerDown(event(panels[1].x + 150, panels[1].y + 150));
    api.onResultPointerMove(event(panels[1].x + 210, panels[1].y + 175));
    api.onResultPointerUp();
    panels.forEach((panel, i) => {
      const after = api.resultPanelProjector(panel, bounds)(point);
      assert.ok(Math.abs(after.x - before[i].x - 60) < 1e-9);
      assert.ok(Math.abs(after.y - before[i].y - 25) < 1e-9);
    });
    api.onResultWheel(event(panels[1].x + 200, panels[1].y + 150));
    api.fitResultViewToData(false);
    panels.forEach((panel, i) => {
      const after = api.resultPanelProjector(panel, bounds)(point);
      assert.equal(after.x, before[i].x);
      assert.equal(after.y, before[i].y);
    });
    assert.equal(api.resultZoomReadout.textContent, "100%");
  });
}

test("panel headers and gaps ignore zoom, and zoom remains bounded", () => {
  const api = harness("stress");
  api.onResultWheel(event(100, 20));
  assert.equal(vm.runInContext("resultDashboardView.zoom", api), 1);
  api.onResultWheel(event(700, 200, -1e6));
  assert.equal(vm.runInContext("resultDashboardView.zoom", api), 32);
  api.onResultWheel(event(700, 200, 1e6));
  assert.equal(vm.runInContext("resultDashboardView.zoom", api), 0.25);
});

for(const kind of ["damage","tnt"]){
  test(`${kind}: millimetre models fit their real size and zoom past the former ceiling around the cursor`,()=>{
    const api=harness(kind);
    vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/core/viewports.js"),"utf8"),api);
    api.resultCanvas.getBoundingClientRect=()=>({left:0,top:0});
    api.updateResultPanel=()=>{};
    api.calculationResultData.baseBounds={minX:-.008,maxX:.008,minY:-.008,maxY:.008};
    api.fitResultViewToData(false);
    assert.ok(Math.abs(api.resultView.scale*.016-620)<1e-8,"the 16 mm model fills the available height");
    const cursor={x:630,y:470},world=api.resultScreenToWorld(cursor);
    api.onResultWheel(event(cursor.x,cursor.y,-1200));
    assert.ok(api.resultView.scale>100000,"fine detail is no longer capped at 600 px/m");
    const after=api.resultWorldToScreen(world);
    assert.ok(Math.abs(after.x-cursor.x)<1e-8);assert.ok(Math.abs(after.y-cursor.y)<1e-8);
    api.onResultWheel(event(cursor.x,cursor.y,-1e6));assert.equal(api.resultView.scale,1e7);
    api.onResultWheel(event(cursor.x,cursor.y,1e6));assert.equal(api.resultView.scale,1e-4);
    assert.ok(Number.isFinite(api.resultView.offsetX) && Number.isFinite(api.resultView.offsetY));
    api.fitResultViewToData(false);assert.ok(Math.abs(api.resultView.scale*.016-620)<1e-8);
  });
}
