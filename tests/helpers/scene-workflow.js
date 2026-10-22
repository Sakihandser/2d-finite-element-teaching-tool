const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");

function sceneWorkflowHarness(data, triangle) {
  const element = { getContext: () => ({}), value: "", checked: false, classList: { toggle() {} } };
  const context = vm.createContext({ console, Math, structuredClone,
    BlastSettings:require("../../blast-settings"),
    window: { devicePixelRatio: 1 },
    document: { getElementById: () => element, querySelectorAll: () => [] },
    updatePanel() {}, render() {}, renderCalculationView() {}, setCalculationLayer() {},
    selectObject() {}, closeShapeEditor() {}, TriangleWasm: triangle,
  });
  for (const file of ["global/state", "core/numbers", "core/material-utils", "core/scene-objects",
    "core/regions", "core/analysis-classification", "core/analysis-node-placement",
    "core/analysis-mesh", "pages/drawing/load-hit-testing", "pages/drawing/inspector",
    "core/scene-io", "core/calculation-export", "core/adaptive-mesh"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "src", file + ".js"), "utf8"), context, { filename: file + ".js" });
  }
  context.savedScene = data;
  vm.runInContext("updatePanel = () => {}; selectObject = () => {}; scene = normalizeScene(savedScene); rebuildDerivedRegions({markAnalysisNodePlacementStale:false,markAnalysisMeshStale:false});", context);
  return { context, scene: vm.runInContext("scene", context) };
}

module.exports = { sceneWorkflowHarness };
