"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const I18N_SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "global", "i18n.js"), "utf8");
const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function createBrowserHarness(language = "en") {
  class ElementStub {
    constructor(tagName = "DIV") {
      this.tagName = tagName;
      this.attributes = new Map();
      this.value = "";
      this._listeners = new Map();
      this._walk = [];
    }
    hasAttribute(name) {
      return this.attributes.has(name);
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    addEventListener(name, listener) {
      this._listeners.set(name, listener);
    }
  }

  class InputStub extends ElementStub {}
  class CanvasStub {
    fillText(text) {
      this.lastFillText = text;
    }
    strokeText(text) {
      this.lastStrokeText = text;
    }
  }

  const pageText = { nodeType: 3, data: "结构绘制", parentElement: new ElementStub("BUTTON") };
  const titledButton = new ElementStub("BUTTON");
  titledButton.setAttribute("title", "自动划分网格");
  const selector = new ElementStub("SELECT");
  const documentElement = new ElementStub("HTML");
  documentElement._walk = [pageText, titledButton, selector];
  let observerCallback = null;
  const storage = new Map([["fem-interface-language", language]]);
  const alerts = [];
  const confirmations = [];

  class MutationObserverStub {
    constructor(callback) {
      observerCallback = callback;
    }
    observe() {}
  }

  const context = {
    console,
    Element: ElementStub,
    HTMLInputElement: InputStub,
    CanvasRenderingContext2D: CanvasStub,
    MutationObserver: MutationObserverStub,
    CustomEvent: class CustomEventStub {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    document: {
      documentElement,
      getElementById(id) {
        return id === "interfaceLanguage" ? selector : null;
      },
      createTreeWalker(root) {
        const nodes = [...(root?._walk || [])];
        return { nextNode: () => nodes.shift() || null };
      },
    },
    window: {
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
      },
      alert: (message) => alerts.push(message),
      confirm: (message) => {
        confirmations.push(message);
        return true;
      },
      addEventListener() {},
      dispatchEvent() {},
    },
  };
  context.window.window = context.window;
  vm.runInNewContext(I18N_SOURCE, context, { filename: "i18n.js" });
  return { context, pageText, titledButton, selector, alerts, confirmations, CanvasStub, observer: () => observerCallback };
}

test("英文模式翻译静态文字、动态状态、弹窗和 Canvas 标签", () => {
  const harness = createBrowserHarness("en");
  const { window } = harness.context;
  assert.equal(harness.pageText.data, "Structure");
  assert.equal(harness.titledButton.getAttribute("title"), "Generate Mesh");
  assert.equal(window.femI18n.t("已布点 120 节点"), "120 nodes placed");
  assert.equal(window.femI18n.t("R2：外部空气"), "R2: Exterior Air");
  assert.equal(window.femI18n.t("R1 结构"), "R1 Structure");
  assert.equal(window.femI18n.t("state: 静态支撑"), "state: Fixed Support");
  assert.equal(window.femI18n.t("kind: 外部空气"), "kind: Exterior Air");
  assert.equal(window.femI18n.t("material: Q235钢"), "material: Q235 Steel");
  assert.equal(window.femI18n.t("Q235钢"), "Q235 Steel");

  window.alert("请输入材料名称。");
  window.confirm("删除材料“Steel”？");
  assert.deepEqual(harness.alerts, ["Enter a material name."]);
  assert.deepEqual(harness.confirmations, ["Delete material “Steel”?"]);

  const canvas = new harness.CanvasStub();
  canvas.fillText("应力云图", 0, 0);
  assert.equal(canvas.lastFillText, "Stress Contours");

  const dynamicText = { nodeType: 3, data: "待结果", parentElement: new harness.context.Element("SPAN") };
  harness.observer()([{ type: "characterData", target: dynamicText }]);
  assert.equal(dynamicText.data, "Awaiting Results");
});

test("语言切换可原位恢复中文并保存偏好", () => {
  const harness = createBrowserHarness("en");
  harness.context.window.femI18n.setLanguage("zh-CN", { refresh: false });
  assert.equal(harness.pageText.data, "结构绘制");
  assert.equal(harness.titledButton.getAttribute("title"), "自动划分网格");
  assert.equal(harness.context.document.documentElement.lang, "zh-CN");

  harness.context.window.femI18n.setLanguage("en", { refresh: false });
  assert.equal(harness.pageText.data, "Structure");
  assert.equal(harness.context.window.localStorage.getItem("fem-interface-language"), "en");
});

test("index.html 中所有可见中文和辅助文本都有英文翻译", () => {
  const harness = createBrowserHarness("en");
  const translate = harness.context.window.femI18n.translateEnglish;
  const html = INDEX_SOURCE.replace(/<!--[\s\S]*?-->/g, "");
  const candidates = [];
  for (const match of html.matchAll(/>([^<>]+)</g)) {
    const text = match[1].trim();
    if (/[\u3400-\u9fff]/u.test(text)) candidates.push(text);
  }
  for (const match of html.matchAll(/(?:title|aria-label|placeholder|value)="([^"]*[\u3400-\u9fff][^"]*)"/gu)) {
    candidates.push(match[1]);
  }
  const untranslated = [...new Set(candidates)].filter((text) => translate(text) === text);
  assert.deepEqual(untranslated, []);
});

test("仪表盘的提示、状态、样本和训练记录支持英文", () => {
  const { context } = createBrowserHarness("en");
  const t = context.window.femI18n.t;
  assert.match(t("训练环境已连接。导入自适应模型后即可开始；小样本试训仅用于验证流程。"), /^Training environment connected/);
  assert.equal(t("已完成"), "Completed");
  assert.equal(t("细化轮数上限"), "Refinement step limit");
  assert.equal(t("训练"), "Training");
  assert.equal(t("2.68 MiB · 最新 · 最佳验证"), "2.68 MiB · Latest · Best validation");
  assert.equal(t("checkpoint-1-2.pt · 0 / 0 · 不可读取"), "checkpoint-1-2.pt · 0 / 0 · Unreadable");
  assert.equal(t("裂纹模型接入试训 · 50 轮 · 已完成"), "裂纹模型接入试训 · 50 epochs · Completed");
  assert.equal(t("3 种粗网格 · 实际误差；目标未确认达标"), "3 coarse meshes · Achieved error; target not confirmed");
  assert.equal(t("已生成 14,308 个节点、28,008 个单元。达到节点预算，已保留上一张网格。尚未进行误差验算。"), "Generated 14,308 nodes and 28,008 elements. Node budget reached; the previous mesh was kept. Accuracy has not been verified.");
  assert.equal(t("已导入 1型裂纹扩展：1 个工况，3 张独立粗网格。"), "Imported 1型裂纹扩展: 1 case, 3 independent coarse meshes.");
  // Cover every Chinese UI literal in the dashboard, excluding template fragments.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "training", "dashboard.js"), "utf8");
  const literals = [...source.matchAll(/'([\u3400-\u9fff][^'"`<>{}\r\n]*)'/gu)].map(m => m[1]);
  const fragments = new Set(["优化步数 ", "训练服务连接失败：", " 轮 · ", " 轮", "训练集 ", " · 验证集 ", "训练 ", " · 验证 "]);
  assert.deepEqual(literals.filter(s => !fragments.has(s) && t(s) === s), []);
});

test("切回中文后，未翻译文字和属性不会触发无限 MutationObserver 写回", () => {
  const harness = createBrowserHarness("en");
  let data = "用户自定义中文工况名", writes = 0;
  const dynamicText = { nodeType: 3, parentElement: new harness.context.Element("SPAN") };
  Object.defineProperty(dynamicText, "data", {
    get: () => data,
    set: value => { data = value; writes++; },
  });
  const attribute = new harness.context.Element("INPUT");
  attribute.setAttribute("aria-label", "用户自定义中文提示");
  const nativeSetAttribute = attribute.setAttribute.bind(attribute);
  attribute.setAttribute = (name, value) => { writes++; nativeSetAttribute(name, value); };
  const records = [{type:"characterData", target:dynamicText}, {type:"attributes", target:attribute, attributeName:"aria-label"}];
  harness.observer()(records);
  harness.context.window.femI18n.setLanguage("zh-CN", {refresh:false});
  for (let i = 0; i < 5; i++) harness.observer()(records);
  assert.equal(writes, 0);
  assert.equal(data, "用户自定义中文工况名");
});

test("语言切换只重绘当前工作区，仪表盘不重算隐藏的大网格", () => {
  const { context } = createBrowserHarness("en");
  const calls = [];
  for (const name of ["updatePanel", "updateCalculationPanel", "render", "renderCalculationView", "renderResultView", "renderMaterialLibrary"]) {
    context.window[name] = () => calls.push(name);
  }
  context.window.currentPageKey = () => "training";
  context.window.femI18n.setLanguage("zh-CN");
  assert.deepEqual(calls, []);
  context.window.currentPageKey = () => "calculation";
  context.window.femI18n.setLanguage("en");
  assert.deepEqual(calls, ["updateCalculationPanel", "renderCalculationView"]);
});

test("中英混合的用户名称不会覆盖原文，记录与辅助标签可反复切换", () => {
  const harness = createBrowserHarness("zh-CN");
  const original = "裂纹模型接入试训 · 50 轮 · 已完成";
  harness.pageText.data = original;
  harness.titledButton.setAttribute("title", "选择 1型裂纹扩展");
  const records = [{type:"characterData", target:harness.pageText}, {type:"attributes", target:harness.titledButton, attributeName:"title"}];
  for (let i = 0; i < 3; i++) {
    harness.context.window.femI18n.setLanguage("en", {refresh:false});
    // Real observers also deliver the mutations generated by translation itself.
    harness.observer()(records);
    assert.equal(harness.pageText.data, "裂纹模型接入试训 · 50 epochs · Completed");
    harness.context.window.femI18n.setLanguage("zh-CN", {refresh:false});
    harness.observer()(records);
    assert.equal(harness.pageText.data, original);
    assert.equal(harness.titledButton.getAttribute("title"), "选择 1型裂纹扩展");
  }
});
