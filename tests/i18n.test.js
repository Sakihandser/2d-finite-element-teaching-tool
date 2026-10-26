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
    disconnect() {}
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

test('新版自适应节点保护与停止原因支持英文',()=>{
  const translate=createBrowserHarness('en').context.window.femI18n.translateEnglish;
  for(const value of ['自适应安全节点上限','自适应安全节点上限必须是 100–1000000 的整数。',
    '基础网格超过自适应安全节点上限，请提高该上限。',
    '自适应完成：达到奇点保护限制；ZZ 估计误差 12.53%',
    '自适应完成：误差下降停滞，已保留最后成功结果；ZZ 估计误差 10.00%',
    '自适应完成：达到自适应安全节点上限；ZZ 估计误差 5.10%']){
    assert.equal(/[\u3400-\u9fff]/u.test(translate(value)),false,value);
  }
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

 test("untranslated user text and attributes do not feed an observer loop when switching to Chinese",()=>{
  const h=createBrowserHarness("en"),parent=new h.context.Element("SPAN");
  let value="自定义模型XYZ",writes=0;
  const node={nodeType:3,parentElement:parent,get data(){return value;},set data(next){writes++;value=next;}};
  parent.setAttribute("title","自定义模型XYZ");let attributeWrites=0;
  const setAttribute=parent.setAttribute.bind(parent);parent.setAttribute=(name,text)=>{attributeWrites++;setAttribute(name,text);};
  h.context.document.documentElement._walk.push(node,parent);
  h.observer()([{type:"characterData",target:node},{type:"attributes",target:parent,attributeName:"title"}]);
  h.context.window.femI18n.setLanguage("zh-CN",{refresh:false});
  for(let i=0;i<10;i++)h.observer()([{type:"characterData",target:node},{type:"attributes",target:parent,attributeName:"title"}]);
  assert.equal(writes,0);assert.equal(attributeWrites,0);assert.equal(value,"自定义模型XYZ");
 });
 test("complete damage messages and backend errors use the selected language and restore their source",()=>{
  const h=createBrowserHarness("en"),i18n=h.context.window.femI18n;
  const source="损伤网格与断裂能不匹配：当前 Gf = 100 J/m²；青砂岩 / E940 要求 Gf > 235.92875 J/m²。请细化网格或检查已标定的强度、断裂能。";
  const node={nodeType:3,data:source,parentElement:new h.context.Element("OUTPUT")};
  h.context.document.documentElement._walk.push(node);h.observer()([{type:"characterData",target:node}]);
  assert.match(node.data,/Green sandstone \/ E940 requires Gf > 235.92875/);assert.doesNotMatch(node.data,/[\u3400-\u9fff]/u);
  const english=node.data;
  for(let i=0;i<10;i++){
    i18n.setLanguage("zh-CN",{refresh:false});assert.equal(node.data,source);
    i18n.setLanguage("en",{refresh:false});assert.equal(node.data,english);
  }
  assert.equal(i18n.t("完成 / 4995 步 / Δt = 0.04004 μs"),"Completed / 4995 steps / Δt = 0.04004 μs");
  assert.equal(i18n.t("花岗岩 — 单轴抗拉强度 (MPa)"),"Granite — Uniaxial tensile strength (MPa)");
  assert.equal(i18n.t("损伤网格细化：2 轮 / 70265 节点 / 139642 单元"),"Damage mesh refinement: 2 rounds / 70265 nodes / 139642 elements");
  assert.match(i18n.t("损伤网格已兼容：70265 节点 / 139642 单元；保留输入的强度与断裂能。"),/^Damage mesh compatible/);
  const error="Blast simulation failed: Requested blast dt exceeds stability or pressure-resolution limit; use dt=0.";
  i18n.setLanguage("zh-CN",{refresh:false});assert.match(i18n.t(error),/^爆破计算失败：时间步/);
  i18n.setLanguage("en",{refresh:false});assert.equal(i18n.t(error),error);
 });
 test("language changes redraw only the active page and source labels survive cloning in English",()=>{
  const h=createBrowserHarness("en"),calls=[];
  h.context.document.querySelector=()=>({dataset:{page:"blast"}});
  for(const name of ["render","renderCalculationView","renderResultView","renderMaterialLibrary","renderBlastSetup"])h.context.window[name]=()=>calls.push(name);
  h.context.window.femI18n.setLanguage("zh-CN");assert.deepEqual(calls,["renderBlastSetup"]);
  h.context.window.femI18n.setLanguage("en",{refresh:false});
  const span=new h.context.Element("SPAN");span.childNodes=[h.pageText];
  assert.equal(h.pageText.data,"Structure");assert.equal(h.context.window.femI18n.sourceText(span),"结构绘制");
 });

 test("blast backend diagnostics have Chinese text and English text",()=>{
  const h=createBrowserHarness("zh-CN"),i18n=h.context.window.femI18n,untranslated=[];
  for(const file of ["blast-runner.js","blast-frame-codec.js","explosive-library.js","gas-library.js","explosive-store.js","计算力学程序计算核心/BlastDynamics.cpp","计算力学程序计算核心/GasDynamics.cpp","计算力学程序计算核心/SolidConstitutive.h","计算力学程序计算核心/GasConstitutive.h"]){
    const code=fs.readFileSync(path.join(__dirname,"..",file),"utf8");
    for(const match of code.matchAll(/"([^"\n]+[.!])"/g)){
      const message=match[1];if(!/^[A-Z][A-Za-z0-9]/.test(message) || !message.includes(" "))continue;
      const source=i18n.sourceMessage(message);if(!/[\u3400-\u9fff]/u.test(source))untranslated.push(message);
      if(/[\u3400-\u9fff]/u.test(i18n.translateEnglish(source)))untranslated.push("English: "+source);
    }
  }
  assert.deepEqual([...new Set(untranslated)],[]);
 });
 test("all solid model names, help and parameter labels support English",()=>{
  const h=createBrowserHarness("en"),i18n=h.context.window.femI18n,cards=require('../blast-materials');
  for(const text of [...cards.names,...cards.help,...Object.values(cards.fields).flat().map(f=>f[1])])assert.doesNotMatch(i18n.translateEnglish(text),/[\u3400-\u9fff]/u,text);
 });
 test("gas model names, requirements and configuration errors support English",()=>{
  const i18n=createBrowserHarness('en').context.window.femI18n,gas=require('../gas-eos'),cards=require('../blast-materials');
  for(const text of [...Object.values(gas.names),...Object.values(gas.help),...cards.compatibility({blastConstitutive:{law:8}},{planeMode:0,kinematics:0}).errors])assert.doesNotMatch(i18n.translateEnglish(text),/[\u3400-\u9fff]/u,text);
 });
