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
