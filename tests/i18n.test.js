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

test("随机生成器动态进度、质量标记和预览摘要支持英文", () => {
  const translate = createBrowserHarness("en").context.window.femI18n.translateEnglish;
  for (const text of ["生成中 · 1/2 · 已加入 1 · 失败 0", "批次已完成：生成 2，加入训练 2，失败 0，未达标过滤 0。",
    "随机模型 seed / G1 / C1 · 4 个图形 · 3 个区域 · 1 个孔洞", "532 节点 / 953 单元",
    "有限元求解 · g1-c1 · 500 节点。已生成工况保存在本机，停止会等待当前工况完成。",
    "2026/10/20 · seed · 已完成", "未达到目标，未导入", "节点预算上限",
    "已求解 8/9 · 精度达标 5/8 · 已分配 6 · 每参考计算小时达标 32.1",
    "热点补救 3 级 · 末次加密冻结误差 85.2% · 预算重试 2 次",
    "奇点保护限制", "误差下降停滞", "加密失败，保留已解网格"]) {
    assert.equal(/[\u3400-\u9fff]/u.test(translate(text)), false, text);
  }
  for(const text of ['已暂停 · 1/6 · 已加入 1 · 失败 0','批次已暂停：生成 1，加入训练 1，失败 0，未达标过滤 0。',
    '有限元求解 · g1-c1 · 500 节点。已生成工况保存在本机，暂停会等待当前工况完成。',
    '2026/10/22 · seed · 已暂停','2026/10/22 · seed · 完成当前工况后暂停',
    '正在恢复生成批次…','暂停请求已提交，当前工况完成并保存后暂停。']) {
    assert.equal(/[\u3400-\u9fff]/u.test(translate(text)),false,text);
  }
});

test("训练工况预览和删除管理的动态提示支持英文", () => {
  const translate=createBrowserHarness("en").context.window.femI18n.translateEnglish;
  for(const value of ['已勾选 3 个工况','参考网格 · 22,108 节点','输入粗网格 1 · 400 节点',
    '标签对照：平均尺寸偏差因子 1.25 · 偏粗区域 10.00% · 偏细区域 20.00% · 基础网格损失 0.2500',
    '当前学习率 1.00e-4 · 训练几何 8 · 验证几何 2 · 验证几何少于 3，诊断仅供参考。',
    '更改学习用途','改为训练集','改为验证集','应用到勾选工况','正在更改学习用途…',
    '已更改 3 个工况的学习用途，同一几何的工况同步更改。',
    '训练 · 参考误差 3.88% · 细化轮数上限 · 22,108 节点 / 43,688 单元',
    '已永久删除 2 个训练工况。部分文件删除失败，请刷新列表后重试。',
    '永久删除所选工况的整个训练数据目录（参考模型、训练图和元数据）？文件无法恢复。原始导入 JSON 和生成批次文件保留。被以下训练记录引用：origin。删除后将无法完整恢复原任务的数据与读取进度，或导出包含原数据的完整模型包；权重仍可预测，也可用于后续训练，但当前恢复入口要求原数据。']) {
    assert.equal(/[\u3400-\u9fff]/u.test(translate(value)),false,value);
  }
});

test("生成历史管理、分配和删除清单支持英文", () => {
  const translate=createBrowserHarness("en").context.window.femI18n.translateEnglish;
  for(const value of ['0 个批次 · 0 个历史工况','23 个批次 · 45 个历史工况 · 22 个已分配',
    '所有历史生成数据\n22 个批次 · 22 个工况 · 66 个文件 · 1.23 MiB',
    '分配用途 g1-c1','训练副本已删除，可重新分配','历史工况已成功分配。',
    '已删除 22 个历史工况、0 个完整批次。部分历史文件删除失败，请重新查看清单后重试。'])
    assert.equal(/[\u3400-\u9fff]/u.test(translate(value)),false,value);
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

test('部分译文再次匹配动态规则时，反馈队列仍收敛且完整保留原文',()=>{
  const h=createBrowserHarness('zh-CN'),original='几何 · 2 轮 · 裂纹 · 5 轮 · 已完成';
  const translated=h.context.window.femI18n.translateEnglish(original);
  // Reproduces a non-idempotent translation: names can themselves contain
  // phrases matching a second dynamic rule. Observer feedback must not run it.
  assert.notEqual(h.context.window.femI18n.translateEnglish(translated),translated);
  const input=new h.context.HTMLInputElement('INPUT');input.setAttribute('value',original);
  const text={nodeType:3,parentElement:new h.context.Element('SPAN')};
  const attribute=new h.context.Element('SPAN');attribute.setAttribute('title',original);
  h.context.document.documentElement._walk.push(text,attribute,input);
  let textValue=original,inputValue=original,writes=0,queue=[];
  Object.defineProperty(text,'data',{get:()=>textValue,set:value=>{
    textValue=value;writes++;queue.push({type:'characterData',target:text});
  }});
  Object.defineProperty(input,'value',{get:()=>inputValue,set:value=>{inputValue=value;writes++;}});
  const setAttribute=attribute.setAttribute.bind(attribute);
  attribute.setAttribute=(name,value)=>{writes++;setAttribute(name,value);queue.push({type:'attributes',target:attribute,attributeName:name});};
  function flush() {
    let rounds=0;
    while(queue.length) {
      assert.ok(++rounds<=4,'MutationObserver feedback did not settle');
      const records=queue;queue=[];h.observer()(records);
    }
  }
  for(let cycle=0;cycle<5;cycle++)for(const language of ['en','zh-CN']) {
    const before=writes;h.context.window.femI18n.setLanguage(language,{refresh:false});flush();
    assert.equal(writes-before,3,'each value should be written once per language change');
    const expected=language==='en'?translated:original;
    assert.equal(text.data,expected);assert.equal(attribute.getAttribute('title'),expected);assert.equal(input.value,expected);
    // Re-selecting the same language and duplicate mutation records do no work.
    const settled=writes;h.context.window.femI18n.setLanguage(language,{refresh:false});
    h.observer()(Array.from({length:100},()=>({type:'characterData',target:text})));flush();
    assert.equal(writes,settled);
  }
});

test('动态内容被业务刷新后不恢复旧值，未知中文及路径不触发写入循环',()=>{
  const h=createBrowserHarness('en'),text=h.pageText;
  text.data='训练服务连接失败：该历史工况尚未分配到训练库。';
  h.observer()([{type:'characterData',target:text}]);
  assert.equal(text.data,'Training service connection failed: This historical case has not been assigned to the dataset library.');
  text.data='External English update';h.observer()([{type:'characterData',target:text}]);
  h.context.window.femI18n.setLanguage('zh-CN',{refresh:false});
  assert.equal(text.data,'External English update');
  text.data='保存生成记录失败，进度已保留在当前程序中，请恢复文件访问后继续生成：EPERM C:\\用户\\模型\\manifest.json';
  const original=text.data;h.context.window.femI18n.setLanguage('en',{refresh:false});
  assert.ok(text.data.includes('EPERM C:\\用户\\模型\\manifest.json'));
  const translated=text.data;
  for(let i=0;i<20;i++)h.observer()([{type:'characterData',target:text}]);
  assert.equal(text.data,translated);
  h.context.window.femI18n.setLanguage('zh-CN',{refresh:false});assert.equal(text.data,original);
});

test('生成历史与训练服务的完整中文错误提示都有英文翻译',()=>{
  const translate=createBrowserHarness('en').context.window.femI18n.translateEnglish;
  for(const file of ['generation-bridge.js','generation-history.js','training-bridge.js',
    'python_machine_learning/dataset_management.py','python_machine_learning/worker.py',
    'src/pages/training/generator.js']) {
    const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    for(const match of source.matchAll(/(['"])([^'"\r\n]*[\u3400-\u9fff][^'"\r\n]*)\1/gu)) {
      const value=match[2];
      if(/[{}<>]/u.test(value)||!/[。！…]$/u.test(value)||value.startsWith(' ')||value.startsWith('；'))continue;
      assert.equal(/[\u3400-\u9fff]/u.test(translate(value)),false,`${file}: ${value}`);
    }
  }
});
