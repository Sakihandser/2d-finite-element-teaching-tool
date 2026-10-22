const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function harness(preference) {
  const elements = new Map(), storage = new Map();
  if (preference !== undefined) storage.set("fem.professional-calculations.v1", preference);
  function element(id) {
    if (!elements.has(id)) elements.set(id, { id, value: "1000", textContent: "", hidden: false,
      dataset: {}, listeners: {}, classList: { toggle() {} }, append(child) { child.parent = id; },
      addEventListener(name, fn) { this.listeners[name] = fn; }, contains() { return false; },
      querySelector() { return { focus() {} }; },
    });
    return elements.get(id);
  }
  const pages = ["home", "calculation", "results", "materials", "blast-library", "blast", "blast-results"].map(key => ({...element(key), dataset: {page: key}, hidden: key !== "home"}));
  const tabs = pages.map(p => ({...element("tab-" + p.dataset.page), dataset: {pageTab: p.dataset.page}, hidden: ["blast-library", "blast", "blast-results"].includes(p.dataset.page)}));
  const specialty = tabs.filter(t => ["blast-library", "blast", "blast-results"].includes(t.dataset.pageTab));
  const channels = ["safety", "reload", "damage", "tnt", "blastTimeline"].map(id => {
    const e = element(id); e.dataset.resultChannel = ["safety", "reload"].includes(id) ? "static" : "blast"; return e;
  });
  const context = vm.createContext({
    document: {getElementById: element, addEventListener() {}, querySelectorAll(selector) {
      return selector.includes("data-professional") ? specialty : selector.includes("data-result-channel") ? channels : [];
    }}, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    pageViews: pages, pageTabs: tabs, maxAnalysisNodes: element("maxAnalysisNodes"),
    blastRunController: null, blastPlayback: null, blastHistory: null, blastLoadTicket: 0, calculationResultData: {name: "static"},
    activeResultView: "stress", resultView: {scale: 12}, resultDashboardView: {zoom: 2, panX: 4, panY: -3},
    resultDeformationScale: {value: "6"}, resultViewButtons: [], resultPanelCache: {}, resultLegendCache: {},
    requestAnimationFrame: fn => fn(), cancelAnimationFrame() {}, closeShapeEditor() {}, hideRegionMaterialMenu() {},
    cancelCalculationAnimationFrame() {}, resizeCanvas() {}, resizeCalculationCanvas() {}, renderCalculationView() {},
    resizeResultCanvas() {}, loadCalculationResultsFromProjectFolder() {}, renderMaterialLibrary() {}, renderBlastLibrary() {},
    render() {}, renderResultView() {}, resetResultDeformationScale() {},
    setResultDeformationScale(value) { context.resultDeformationScale.value = String(value); },
    setResultStatus(text) { element("resultLoadStatus").textContent = text; },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/pages/professional.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "src/pages/tabs.js"), "utf8"), context);
  return {api: context, element, tabs, storage, channels};
}

test("default and malformed preferences expose only basic pages, while explicit opt-in is restored", () => {
  for (const pref of [undefined, "broken", '{"blast":"true"}']) {
    const h = harness(pref); h.api.initializeProfessionalCalculations();
    assert.equal(h.api.isProfessionalCalculationEnabled("blast"), false);
    assert.equal(h.tabs.filter(t => !t.hidden).length, 4);
    h.api.setPage("blast-results");
    assert.equal(h.api.currentPageKey(), "calculation");
    h.api.setPage("blast-library");assert.equal(h.api.currentPageKey(), "calculation");
    assert.equal(h.api.isProfessionalCalculationEnabled("blast"), false);
  }
  const h = harness('{"blast":true}'); h.api.initializeProfessionalCalculations();
  assert.equal(h.api.isProfessionalCalculationEnabled("blast"), true);
  assert.equal(h.tabs.filter(t => !t.hidden).length, 7);
});

test("disabling a specialty exits its page, cancels work and retains its data and settings", () => {
  const h = harness(); h.api.setBlastModuleEnabled(true);
  h.api.setPage("blast-results");
  let cancelled = false; h.api.blastRunController = {abort() { cancelled = true; }};
  h.api.blastHistory = {frames: [{time: 0}]}; h.element("blastX").value = "5";
  h.api.setBlastModuleEnabled(false);
  assert.equal(cancelled, true); assert.equal(h.api.currentPageKey(), "calculation");
  assert.equal(h.api.blastHistory.frames.length, 1); assert.equal(h.element("blastX").value, "5");
  assert.equal(JSON.parse(h.storage.get("fem.professional-calculations.v1")).blast, false);
});

test("static and blast results preserve independent data, camera, plot, scale and controls", () => {
  const h = harness(); h.api.setBlastModuleEnabled(true);
  const staticData = h.api.calculationResultData;
  h.api.setPage("blast-results");
  assert.equal(h.api.calculationResultData, null);
  assert.equal(h.api.activeResultView, "tnt");
  const blastData = {name: "blast"}; h.api.calculationResultData = blastData;
  h.api.activeResultView = "damage"; h.api.resultView.scale = 50; h.api.resultDeformationScale.value = "2";
  h.api.blastHistory = {frames: [{}]};
  h.api.setPage("results");
  assert.equal(h.api.calculationResultData, staticData);
  assert.equal(h.api.activeResultView, "stress"); assert.equal(h.api.resultView.scale, 12);
  assert.equal(h.api.resultDeformationScale.value, "6");
  assert.equal(h.element("resultWorkspace").parent, "resultsPage");
  assert.equal(h.element("safety").hidden, false); assert.equal(h.element("blastTimeline").hidden, true);
  h.api.setPage("blast-results");
  assert.equal(h.api.calculationResultData, blastData); assert.equal(h.api.activeResultView, "damage");
  assert.equal(h.api.resultView.scale, 50); assert.equal(h.api.resultDeformationScale.value, "2");
  assert.equal(h.element("safety").hidden, true); assert.equal(h.element("blastTimeline").hidden, false);
});

test("clearing blast history does not erase static results", () => {
  const h = harness(); const staticData = h.api.calculationResultData;
  h.api.activateResultWorkspace("blast"); h.api.calculationResultData = {name: "blast"};
  h.api.resetBlastResultWorkspace();
  assert.equal(h.api.calculationResultData, null);
  h.api.activateResultWorkspace("static");
  assert.equal(h.api.calculationResultData, staticData);
});

test("a delayed static result read cannot overwrite the blast workspace", async () => {
  let resolveRead, loaded = false;
  const context = vm.createContext({activeResultChannel: "static", resultCtx: {}, calculationResultData: null,
    setResultStatus() {}, renderResultView() {}, console,
    readCalculationResultTexts: () => new Promise(resolve => { resolveRead = resolve; }),
    loadCalculationResultsFromData() { loaded = true; },
  });
  const source = fs.readFileSync(path.join(root, "src/pages/results/render.js"), "utf8");
  const loader = source.slice(source.indexOf("async function loadCalculationResultsFromProjectFolder"), source.indexOf("async function readCalculationResultTexts"));
  vm.runInContext(loader, context);
  const pending = context.loadCalculationResultsFromProjectFolder({quietMissing: true});
  context.activeResultChannel = "blast";
  resolveRead({inputData: {nodes: []}, resultData: {nodeDisplacements: []}});
  assert.equal(await pending, null); assert.equal(loaded, false);
});

test("a static solve completing during blast playback displays its own result page", () => {
  const h = harness(); h.api.setBlastModuleEnabled(true); h.api.setPage("blast-results");
  h.api.blastHistory = {frames: [{}]};
  Object.assign(h.api, {buildCalculationResultData: () => ({elements: [{id: 1}], runInfo: {}}),
    applyCalculationResultsToScene() {}, updateResultPanel() {}, fitResultViewToData() {}, updateCalculationPanel() {},
    handleCalculationResultLoadError(error) { throw error; },
  });
  const source = fs.readFileSync(path.join(root, "src/pages/results/render.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("function loadCalculationResultsFromData("), source.indexOf("function handleCalculationResultLoadError(")), h.api);
  const data = h.api.loadCalculationResultsFromData({nodes: []}, {nodeDisplacements: []});
  assert.equal(data.elements.length, 1); assert.equal(h.api.currentPageKey(), "results");
  assert.equal(h.element("resultWorkspace").parent, "resultsPage");
  assert.equal(h.api.blastHistory.frames.length, 1);
});

 test("disabling blast while editing its library hides the tab and leaves the library page",()=>{
  const h=harness();h.api.setBlastModuleEnabled(true);h.api.setPage("blast-library");
  assert.equal(h.api.currentPageKey(),"blast-library");
  h.api.setBlastModuleEnabled(false);assert.equal(h.api.currentPageKey(),"calculation");
  assert.equal(h.tabs.find(tab=>tab.dataset.pageTab==="blast-library").hidden,true);
});
