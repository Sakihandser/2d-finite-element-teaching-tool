const CALCULATION_INPUT_FILE_URL = "./calculation-data/calculation-input.txt";
const CALCULATION_RESULT_FILE_URL = "./calculation-data/calculation-result.txt";
const CALCULATION_RESULTS_API_URL = "./api/calculation-results";
const CALCULATION_RESULT_FILENAME = "calculation-result.txt";
let resultLegendCache = { data: undefined, view: undefined };
let resultPanelCache = { data: undefined, view: undefined, zoom: undefined };
const resultPanelBoundsCache = new WeakMap();
// 四个子图共享相对缩放和平移，窗口尺寸改变后仍保留观察位置。
let resultDashboardView = { zoom: 1, panX: 0, panY: 0 };

function isResultTensorDashboard() {
  return activeResultView === "stress" || activeResultView === "strain";
}


// 从 calculation-data 重新读取输入和结果 TXT，并刷新结果页。
async function loadCalculationResultsFromProjectFolder(options = {}) {
  if (typeof activeResultChannel !== "undefined" && activeResultChannel === "blast") return calculationResultData;
  if (options.quietMissing && calculationResultData) { renderResultView(); return calculationResultData; }
  if (!resultCtx) return null;
  setResultStatus("正在读取 calculation-data...");
  try {
    const bundle = await readCalculationResultTexts(options);
    // A pending static-file read must not replace the blast workspace after a tab switch.
    if (typeof activeResultChannel !== "undefined" && activeResultChannel !== "static") return null;
    const runInfo = { source: bundle.source, input: bundle.input, result: bundle.result, ranAt: bundle.ranAt };
    if (bundle.inputData && bundle.resultData) {
      return loadCalculationResultsFromData(bundle.inputData, bundle.resultData, runInfo);
    }
    return loadCalculationResultsFromText(bundle.inputText, bundle.resultText, runInfo);
  } catch (error) {
    console.warn(error);
    if (!options.quietMissing) {
      setResultStatus(error.message || "读取结果失败");
    } else if (!calculationResultData) {
      setResultStatus("暂无结果文件");
    }
    renderResultView();
    return null;
  }
}

async function readCalculationResultTexts(options = {}) {
  const errors = [];
  if (typeof fetch === "function" && !isFileProtocolPage()) {
    try {
      return await fetchCalculationResultBundleFromApi();
    } catch (error) {
      errors.push(error);
    }
    try {
      return await fetchCalculationResultBundleFromStaticFiles();
    } catch (error) {
      errors.push(error);
    }
  }
  if (canUseBrowserFolderWriter() && options.allowPicker !== false && !options.quietMissing) {
    try {
      return await readCalculationResultBundleFromBrowserDirectory();
    } catch (error) {
      errors.push(error);
    }
  }
  throw errors[errors.length - 1] || new Error("无法读取 calculation-data 中的计算结果。");
}

async function fetchCalculationResultBundleFromApi() {
  const response = await fetch(`${CALCULATION_RESULTS_API_URL}?t=${Date.now()}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `无法读取计算结果：HTTP ${response.status}`);
  }
  return {
    source: "api",
    input: payload.input,
    result: payload.result,
    inputText: payload.inputText,
    resultText: payload.resultText,
    inputData: payload.inputData,
    resultData: payload.resultData,
    ranAt: payload.ranAt,
  };
}

async function fetchCalculationResultBundleFromStaticFiles() {
  const stamp = Date.now();
  const [inputText, resultText] = await Promise.all([
    fetchCalculationTextFile(`${CALCULATION_INPUT_FILE_URL}?t=${stamp}`),
    fetchCalculationTextFile(`${CALCULATION_RESULT_FILE_URL}?t=${stamp}`),
  ]);
  return {
    source: "static-files",
    input: { filename: CALCULATION_INPUT_FILENAME },
    result: { filename: CALCULATION_RESULT_FILENAME },
    inputText,
    resultText,
  };
}

async function fetchCalculationTextFile(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`无法读取 ${url.split("?")[0]}：HTTP ${response.status}`);
  }
  return response.text();
}

async function readCalculationResultBundleFromBrowserDirectory() {
  const directory = await resultReadableCalculationDataDirectory();
  const [inputText, resultText] = await Promise.all([
    readTextFileFromDirectory(directory, CALCULATION_INPUT_FILENAME),
    readTextFileFromDirectory(directory, CALCULATION_RESULT_FILENAME),
  ]);
  return {
    source: "browser-folder",
    input: { filename: CALCULATION_INPUT_FILENAME },
    result: { filename: CALCULATION_RESULT_FILENAME },
    inputText,
    resultText,
  };
}

async function resultReadableCalculationDataDirectory() {
  if (!canUseBrowserFolderWriter()) {
    throw new Error("当前浏览器不支持读取本地文件夹，请通过 start.bat 启动本地服务。");
  }
  if (rememberedCalculationDataDirectoryHandle && (await ensureDirectoryReadPermission(rememberedCalculationDataDirectoryHandle, false))) {
    return rememberedCalculationDataDirectoryHandle;
  }
  const selectedDirectory = await showCalculationResultDirectoryPicker();
  const targetDirectory = await calculationResultDataTargetDirectory(selectedDirectory);
  await ensureDirectoryReadPermission(targetDirectory, true);
  if (typeof storeCalculationDataDirectoryHandle === "function") {
    await storeCalculationDataDirectoryHandle(targetDirectory);
  }
  return targetDirectory;
}

async function showCalculationResultDirectoryPicker() {
  const options = {
    id: CALCULATION_DIRECTORY_PICKER_ID,
    mode: "read",
    startIn: rememberedCalculationDataDirectoryHandle || "documents",
  };
  try {
    return await window.showDirectoryPicker(options);
  } catch (error) {
    if (!rememberedCalculationDataDirectoryHandle || error.name === "AbortError") {
      throw error;
    }
    console.warn(error);
    return window.showDirectoryPicker({
      id: CALCULATION_DIRECTORY_PICKER_ID,
      mode: "read",
      startIn: "documents",
    });
  }
}

async function calculationResultDataTargetDirectory(selectedDirectory) {
  if (!selectedDirectory) {
    throw new Error("没有选择计算数据文件夹。");
  }
  if (selectedDirectory.name === CALCULATION_DATA_DIRECTORY_NAME) {
    return selectedDirectory;
  }
  return selectedDirectory.getDirectoryHandle(CALCULATION_DATA_DIRECTORY_NAME);
}

async function ensureDirectoryReadPermission(directoryHandle, shouldRequest = true) {
  if (!directoryHandle) return false;
  const permission = { mode: "read" };
  if (typeof directoryHandle.queryPermission === "function") {
    const current = await directoryHandle.queryPermission(permission);
    if (current === "granted") return true;
  }
  if (!shouldRequest || typeof directoryHandle.requestPermission !== "function") {
    return false;
  }
  const requested = await directoryHandle.requestPermission(permission);
  if (requested === "granted") return true;
  throw new Error("没有获得读取 calculation-data 文件夹的权限。");
}

async function readTextFileFromDirectory(directoryHandle, filename) {
  try {
    const fileHandle = await directoryHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return file.text();
  } catch (error) {
    throw new Error(`无法读取 ${filename}，请确认选择的是项目根目录或 calculation-data 文件夹。`);
  }
}

function isFileProtocolPage() {
  return typeof window !== "undefined" && window.location?.protocol === "file:";
}

// 使用给定 TXT 文本刷新结果页；开始计算接口运行完成后也复用这个入口。
function loadCalculationResultsFromText(inputText, resultText, runInfo = {}) {
  try {
    const input = parseCalculationInputText(inputText);
    const result = parseCalculationResultText(resultText);
    return loadCalculationResultsFromData(input, result, runInfo);
  } catch (error) {
    return handleCalculationResultLoadError(error);
  }
}

// 使用 Node.js 从 C++ 二进制管道解码后的结构化数据刷新结果页，不再进行 TXT 解析。
function loadCalculationResultsFromData(input, result, runInfo = {}) {
  try {
    if (!input || !result || !Array.isArray(input.nodes) || !Array.isArray(result.nodeDisplacements)) {
      throw new Error("二进制计算结果缺少节点或单元数据。");
    }
    if (!runInfo.blastFrame && typeof activateResultWorkspace === "function") {
      // A static solve can finish while the user is viewing an older blast run.
      // Keep the visible page and the shared workspace in the same channel.
      if (currentPageKey() === "blast-results") setPage("results");
      else activateResultWorkspace("static");
    }
    if (typeof gpuMeshRenderer !== "undefined") gpuMeshRenderer.release?.(calculationResultData);
    calculationResultData = buildCalculationResultData(input, result, runInfo);
    resetResultDeformationScale(calculationResultData);
    applyCalculationResultsToScene(calculationResultData);
    updateResultPanel();
    fitResultViewToData(false);
    renderResultView();
    setResultStatus(`已读取 ${calculationResultData.elements.length} 个单元结果`);
    calculationRunStatusMessage = "已就绪";
    updateCalculationPanel();
    renderCalculationView();
    return calculationResultData;
  } catch (error) {
    return handleCalculationResultLoadError(error);
  }
}

function handleCalculationResultLoadError(error) {
  console.error(error);
  setResultStatus(error.message || "结果解析失败");
  calculationRunStatusMessage = error.message || "结果解析失败";
  updateCalculationPanel();
  renderResultView();
  return null;
}

function parseCalculationInputText(text) {
  const data = {
    header: "",
    modelName: "",
    generatedAt: "",
    units: {},
    counts: {},
    nodes: [],
    elements: [],
  };
  let section = "";
  for (const rawLine of normalizedTextLines(text)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!data.header) {
      data.header = removeUtf8Bom(line);
      if (data.header !== "FEM_CALCULATION_INPUT_TXT_V1") {
        throw new Error(`计算输入文件格式不支持：${data.header}`);
      }
      continue;
    }
    if (line === "END") break;
    const upper = line.toUpperCase();
    if (["MATERIALS", "NODES", "ELEMENTS", "ELEMENT_NODE_LOADS", "WARNINGS"].includes(upper)) {
      section = upper;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (!section) {
      parseCalculationInputHeaderLine(line, data);
      continue;
    }
    if (section === "NODES") {
      const values = line.split(/\s+/);
      if (values.length < 11) continue;
      data.nodes.push({
        nodeNo: Number(values[0]),
        x: Number(values[1]),
        y: Number(values[2]),
        fixUx: Number(values[3]) !== 0,
        fixUy: Number(values[4]) !== 0,
        dofUx: Number(values[5]),
        dofUy: Number(values[6]),
        forceX: Number(values[7]),
        forceY: Number(values[8]),
        materialNo: Number(values[9]),
        regionNo: Number(values[10]),
      });
    } else if (section === "ELEMENTS") {
      const values = line.split(/\s+/);
      if (values.length < 14) continue;
      data.elements.push({
        elementNo: Number(values[0]),
        nodeNumbers: [Number(values[1]), Number(values[2]), Number(values[3])],
        area: Number(values[4]),
        centroid: { x: Number(values[5]), y: Number(values[6]) },
        materialNo: Number(values[7]),
        elasticModulus: Number(values[8]),
        poissonRatio: Number(values[9]),
        density: Number(values[10]),
        yieldStrength: Number(values[11]),
        tensileStrength: Number(values[12]),
        compressiveStrength: Number(values[13]),
      });
    }
  }
  return data;
}

function parseCalculationInputHeaderLine(line, data) {
  if (line.startsWith("MODEL ")) {
    data.modelName = line.slice("MODEL ".length).trim();
  } else if (line.startsWith("GENERATED_AT ")) {
    data.generatedAt = line.slice("GENERATED_AT ".length).trim();
  } else if (line.startsWith("UNITS ")) {
    data.units = parseSolverKeyValues(line.slice("UNITS ".length));
  } else if (line.startsWith("COUNTS ")) {
    data.counts = parseSolverKeyValues(line.slice("COUNTS ".length), Number);
  }
}

function parseCalculationResultText(text) {
  const data = {
    header: "",
    modelName: "",
    generatedAt: "",
    sourceInput: "",
    units: {},
    counts: {},
    nodeDisplacements: [],
    elementResults: [],
  };
  let section = "";
  for (const rawLine of normalizedTextLines(text)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!data.header) {
      data.header = removeUtf8Bom(line);
      if (data.header !== "FEM_CALCULATION_RESULT_TXT_V1") {
        throw new Error(`计算结果文件格式不支持：${data.header}`);
      }
      continue;
    }
    if (line === "END") break;
    const upper = line.toUpperCase();
    if (["NODE_DISPLACEMENTS", "ELEMENT_RESULTS", "SAFETY_CODE_MEANING"].includes(upper)) {
      section = upper;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (!section) {
      parseCalculationResultHeaderLine(line, data);
      continue;
    }
    if (section === "NODE_DISPLACEMENTS") {
      const values = line.split(/\s+/);
      if (values.length < 4) continue;
      data.nodeDisplacements.push({
        nodeNo: Number(values[0]),
        ux: Number(values[1]),
        uy: Number(values[2]),
        magnitude: Number(values[3]),
      });
    } else if (section === "ELEMENT_RESULTS") {
      const values = line.split(/\s+/);
      if (values.length < 11) continue;
      const result = {
        elementNo: Number(values[0]),
        strainXx: Number(values[1]),
        strainXy: Number(values[2]),
        strainYx: Number(values[3]),
        strainYy: Number(values[4]),
        stressXx: Number(values[5]),
        stressXy: Number(values[6]),
        stressYx: Number(values[7]),
        stressYy: Number(values[8]),
        safetyCode: Number(values[9]),
        safetyText: values.slice(10).join(" "),
      };
      result.equivalentStress = equivalentTensorValue(result.stressXx, result.stressXy, result.stressYx, result.stressYy);
      result.equivalentStrain = equivalentTensorValue(result.strainXx, result.strainXy, result.strainYx, result.strainYy);
      data.elementResults.push(result);
    }
  }
  return data;
}

function parseCalculationResultHeaderLine(line, data) {
  if (line.startsWith("MODEL ")) {
    data.modelName = line.slice("MODEL ".length).trim();
  } else if (line.startsWith("GENERATED_AT ")) {
    data.generatedAt = line.slice("GENERATED_AT ".length).trim();
  } else if (line.startsWith("SOURCE_INPUT ")) {
    data.sourceInput = line.slice("SOURCE_INPUT ".length).trim();
  } else if (line.startsWith("UNITS ")) {
    data.units = parseSolverKeyValues(line.slice("UNITS ".length));
  } else if (line.startsWith("COUNTS ")) {
    data.counts = parseSolverKeyValues(line.slice("COUNTS ".length), Number);
  }
}

function normalizedTextLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function removeUtf8Bom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function parseSolverKeyValues(text, mapper = String) {
  const values = {};
  String(text || "")
    .trim()
    .split(/\s+/)
    .forEach((token) => {
      const index = token.indexOf("=");
      if (index <= 0) return;
      values[token.slice(0, index).toLowerCase()] = mapper(token.slice(index + 1));
    });
  return values;
}

function buildCalculationResultData(input, result, runInfo = {}) {
  const displacementsByNo = new Map(result.nodeDisplacements.map((node) => [node.nodeNo, node]));
  const elementResultsByNo = new Map(result.elementResults.map((element) => [element.elementNo, element]));
  const nodes = input.nodes.map((node) => {
    const displacement = displacementsByNo.get(node.nodeNo) || {};
    return {
      ...node,
      ux: Number(displacement.ux) || 0,
      uy: Number(displacement.uy) || 0,
      displacementMagnitude: Number(displacement.magnitude) || 0,
    };
  });
  const nodeByNo = new Map(nodes.map((node) => [node.nodeNo, node]));
  const elements = input.elements
    .map((element) => {
      const elementNodes = element.nodeNumbers.map((nodeNo) => nodeByNo.get(nodeNo)).filter(Boolean);
      const elementResult = elementResultsByNo.get(element.elementNo) || {};
      const displacementMagnitude = elementNodes.length
        ? Math.max(...elementNodes.map((node) => node.displacementMagnitude || 0))
        : 0;
      return {
        ...element,
        nodes: elementNodes,
        strainXx: Number(elementResult.strainXx) || 0,
        strainXy: Number(elementResult.strainXy) || 0,
        strainYx: Number(elementResult.strainYx) || 0,
        strainYy: Number(elementResult.strainYy) || 0,
        stressXx: Number(elementResult.stressXx) || 0,
        stressXy: Number(elementResult.stressXy) || 0,
        stressYx: Number(elementResult.stressYx) || 0,
        stressYy: Number(elementResult.stressYy) || 0,
        ...(elementResult.stressZz!==undefined?{stressZz:Number(elementResult.stressZz)||0,plasticStrain:Number(elementResult.plasticStrain)||0}:{}),
        equivalentStress: Number(elementResult.equivalentStress) || 0,
        dynamicEquivalentStress: Number(elementResult.dynamicEquivalentStress) || 0,
        equivalentStrain: Number(elementResult.equivalentStrain) || 0,
        safetyCode: Number.isFinite(Number(elementResult.safetyCode)) ? Number(elementResult.safetyCode) : 0,
        safetyText: elementResult.safetyText || "OK",
        damage: Number(elementResult.damage) || 0,
        displacementMagnitude,
      };
    })
    .filter((element) => element.nodes.length === 3);

  const maxDisplacement = maxValue(nodes, "displacementMagnitude");
  const maxStress = maxValue(elements, "equivalentStress");
  const maxStrain = maxValue(elements, "equivalentStrain");
  const unsafeCount = elements.filter((element) => element.safetyCode !== 0).length;
  const baseBounds = boundsForPoints(nodes);
  const modelSize = Math.max(baseBounds.maxX - baseBounds.minX, baseBounds.maxY - baseBounds.minY, 1);

  return {
    input,
    result,
    runInfo,
    modelName: result.modelName || input.modelName || "未命名模型",
    generatedAt: result.generatedAt || "",
    nodes,
    nodeByNo,
    elements,
    maxDisplacement,
    maxStress,
    maxStrain,
    unsafeCount,
    modelSize,
    baseBounds,
    ranges: {
      ...Object.fromEntries(["stressXx", "stressXy", "stressYy", "strainXx", "strainXy", "strainYy"]
        .map((key) => [key, rangeForValues(elements.map((element) => element[key]))])),
      displacementMagnitude: rangeForValues(elements.map((element) => element.displacementMagnitude)),
      equivalentStress: rangeForValues(elements.map((element) => element.equivalentStress)),
      equivalentStrain: rangeForValues(elements.map((element) => element.equivalentStrain)),
    },
  };
}

function equivalentTensorValue(xx, xy, yx, yy) {
  const shear = ((Number(xy) || 0) + (Number(yx) || 0)) * 0.5;
  const sx = Number(xx) || 0;
  const sy = Number(yy) || 0;
  return Math.sqrt(Math.max(0, sx * sx - sx * sy + sy * sy + 3 * shear * shear));
}

function maxValue(items, key) {
  return items.reduce((max, item) => Math.max(max, Number(item[key]) || 0), 0);
}

function rangeForValues(values) {
  let min = Infinity, max = -Infinity;
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) { min = Math.min(min, number); max = Math.max(max, number); }
  }
  return min === Infinity ? { min: 0, max: 0 } : { min, max };
}

function boundsForPoints(points) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const point of points) {
    if (!isFinitePoint(point)) continue;
    bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y); bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds.minX === Infinity ? { minX: -1, maxX: 1, minY: -1, maxY: 1 } : bounds;
}

// 把结果回写到当前 scene，计算页的变形图层也能使用同一份位移。
function applyCalculationResultsToScene(data) {
  if (!data) return;
  if (typeof gpuMeshRenderer !== "undefined") gpuMeshRenderer.invalidateScene();
  const indexByNumber = (items) => {
    const index = new Map();
    for (const item of items) {
      const number = Number(item.number || item.index);
      if (Number.isFinite(number) && !index.has(number)) index.set(number, item);
    }
    return index;
  };
  const nodesByNumber = indexByNumber(scene.analysisNodes);
  const elementsByNumber = indexByNumber(scene.mesh?.elements || []);
  data.nodes.forEach((resultNode, index) => {
    const sceneNode =
      nodesByNumber.get(resultNode.nodeNo) ||
      scene.analysisNodes[index];
    if (!sceneNode) return;
    sceneNode.ux = resultNode.ux;
    sceneNode.uy = resultNode.uy;
    sceneNode.displacementMagnitude = resultNode.displacementMagnitude;
  });
  data.elements.forEach((resultElement, index) => {
    const sceneElement =
      elementsByNumber.get(resultElement.elementNo) ||
      (scene.mesh?.elements || [])[index];
    if (!sceneElement) return;
    sceneElement.result = {
      strain: {
        xx: resultElement.strainXx,
        xy: resultElement.strainXy,
        yx: resultElement.strainYx,
        yy: resultElement.strainYy,
        equivalent: resultElement.equivalentStrain,
      },
      stress: {
        xx: resultElement.stressXx,
        xy: resultElement.stressXy,
        yx: resultElement.stressYx,
        yy: resultElement.stressYy,
        equivalent: resultElement.equivalentStress,
      },
      safetyCode: resultElement.safetyCode,
      safetyText: resultElement.safetyText,
    };
  });
}

function renderResultView() {
  if (!resultCtx || resultView.width <= 0 || resultView.height <= 0) return;
  if (!["results", "blast-results"].includes(currentPageKey())) { updateResultPanel(); return; }
  resultCtx.setTransform(resultDpr, 0, 0, resultDpr, 0, 0);
  resultCtx.clearRect(0, 0, resultView.width, resultView.height);
  const isTensorDashboard = activeResultView === "stress" || activeResultView === "strain";
  if (!isTensorDashboard) {
    drawResultGrid();
  } else {
    drawResultBackground();
  }
  if (!calculationResultData) {
    drawResultEmptyState();
    updateResultPanel();
    return;
  }
  if (activeResultView === "deformation") {
    drawResultDeformation();
  } else if (activeResultView === "stress") {
    drawResultTensorDashboard("stress");
  } else if (activeResultView === "strain") {
    drawResultTensorDashboard("strain");
  } else if (activeResultView === "safety") {
    drawResultSafety();
  } else if (activeResultView === "damage") {
    drawBlastDamage();
  } else if (activeResultView === "tnt") {
    drawTntResultView();
  }
  if (typeof drawTntResultOverlay === "function") drawTntResultOverlay();
  updateResultPanel();
}

function drawResultBackground() {
  resultCtx.save();
  resultCtx.fillStyle = COLORS.canvasBackground;
  resultCtx.fillRect(0, 0, resultView.width, resultView.height);
  resultCtx.restore();
}

function drawResultGrid() {
  resultCtx.save();
  resultCtx.fillStyle = COLORS.canvasBackground;
  resultCtx.fillRect(0, 0, resultView.width, resultView.height);

  const step = gridStepForScale(resultView.scale);
  const startWorld = resultScreenToWorld({ x: 0, y: resultView.height });
  const endWorld = resultScreenToWorld({ x: resultView.width, y: 0 });
  const x0 = Math.floor(startWorld.x / step) * step;
  const x1 = Math.ceil(endWorld.x / step) * step;
  const y0 = Math.floor(startWorld.y / step) * step;
  const y1 = Math.ceil(endWorld.y / step) * step;

  resultCtx.lineWidth = 1;
  for (let x = x0; x <= x1; x += step) {
    const p = resultWorldToScreen({ x, y: 0 });
    resultCtx.strokeStyle = isMajorGridLine(x, step) ? COLORS.gridMajor : COLORS.grid;
    drawResultLineScreen({ x: p.x, y: 0 }, { x: p.x, y: resultView.height });
  }
  for (let y = y0; y <= y1; y += step) {
    const p = resultWorldToScreen({ x: 0, y });
    resultCtx.strokeStyle = isMajorGridLine(y, step) ? COLORS.gridMajor : COLORS.grid;
    drawResultLineScreen({ x: 0, y: p.y }, { x: resultView.width, y: p.y });
  }

  const origin = resultWorldToScreen({ x: 0, y: 0 });
  resultCtx.strokeStyle = COLORS.axis;
  resultCtx.lineWidth = 1.4;
  drawResultLineScreen({ x: 0, y: origin.y }, { x: resultView.width, y: origin.y });
  drawResultLineScreen({ x: origin.x, y: 0 }, { x: origin.x, y: resultView.height });
  resultCtx.restore();
}

function drawResultEmptyState() {
  resultCtx.save();
  resultCtx.fillStyle = "#516070";
  resultCtx.font = "700 14px Segoe UI, Arial, sans-serif";
  resultCtx.textAlign = "center";
  resultCtx.textBaseline = "middle";
  const message = typeof activeResultChannel !== "undefined" && activeResultChannel === "blast"
    ? "暂无爆破结果，请在爆破设置页运行模拟。"
    : "暂无计算结果，请先在计算页开始计算，或点击左侧重新读取结果。";
  resultCtx.fillText(message, resultView.width / 2, resultView.height / 2);
  resultCtx.restore();
}

function drawResultDeformation() {
  const data = calculationResultData;
  const factor = resultDisplacementFactor(data);
  const originalOnGpu = drawGpuResultMesh("original", () => [1, 1, 1, 0.24], { stroke: [83 / 255, 97 / 255, 113 / 255, 0.26], dashed: true });
  if (originalOnGpu) {
    if (drawGpuResultMesh("displacement", (element) => gpuScalarColor(element.displacementMagnitude, data.ranges.displacementMagnitude, 0.7),
      { factor, stroke: [30 / 255, 41 / 255, 59 / 255, 0.48], lineWidth: 0.9 })) return;
  }

  resultCtx.save();
  resultCtx.strokeStyle = COLORS.resultOriginalMesh;
  resultCtx.lineWidth = 1;
  resultCtx.setLineDash([7, 6]);
  if (!originalOnGpu) for (const element of data.elements) {
    drawResultElement(element.nodes, "rgba(255, 255, 255, 0.24)", COLORS.resultOriginalMesh);
  }
  resultCtx.restore();

  for (const element of data.elements) {
    const fill = resultColorForScalar(element.displacementMagnitude, data.ranges.displacementMagnitude);
    drawResultElement(element.nodes.map((node) => deformedResultNode(node, factor)), hexToRgba(fill, 0.7), "rgba(30, 41, 59, 0.48)");
  }
}

function drawResultScalarCloud(metricKey) {
  const data = calculationResultData;
  const range = data.ranges[metricKey];
  if (drawGpuResultMesh(metricKey, (element) => gpuScalarColor(element[metricKey], range, 0.78),
    { stroke: [30 / 255, 41 / 255, 59 / 255, 0.36], lineWidth: 0.9 })) return;
  for (const element of data.elements) {
    const fill = resultColorForScalar(element[metricKey], range);
    drawResultElement(element.nodes, hexToRgba(fill, 0.78), "rgba(30, 41, 59, 0.36)");
  }
}

function drawResultTensorDashboard(kind) {
  const isStress = kind === "stress";
  const panels = resultDashboardPanels();
  const definitions = [
    { title: "变形图", subtitle: "真实位移 1倍", type: "deformation" },
    {
      title: isStress ? "应力云图 σxx / xx 方向" : "应变云图 εxx / xx 方向",
      metricKey: isStress ? "stressXx" : "strainXx",
    },
    {
      title: isStress ? "应力云图 σxy / xy 方向" : "应变云图 εxy / xy 方向",
      metricKey: isStress ? "stressXy" : "strainXy",
    },
    {
      title: isStress ? "应力云图 σyy / yy 方向" : "应变云图 εyy / yy 方向",
      metricKey: isStress ? "stressYy" : "strainYy",
    },
  ];

  definitions.forEach((definition, index) => {
    const panel = panels[index];
    if (definition.type === "deformation") {
      drawResultDeformationPanel(panel, definition.title, definition.subtitle);
    } else {
      const range = calculationResultData.ranges[definition.metricKey];
      drawResultScalarPanel(panel, definition.title, definition.metricKey, range);
    }
  });
}

function resultDashboardPanels() {
  const margin = 14;
  const gap = 12;
  const width = (resultView.width - margin * 2 - gap) / 2;
  const height = (resultView.height - margin * 2 - gap) / 2;
  return [
    { x: margin, y: margin, width, height },
    { x: margin + width + gap, y: margin, width, height },
    { x: margin, y: margin + height + gap, width, height },
    { x: margin + width + gap, y: margin + height + gap, width, height },
  ];
}

function drawResultDeformationPanel(panel, title, subtitle) {
  const data = calculationResultData;
  const factor = 1;
  let bounds = resultPanelBoundsCache.get(data);
  if (!bounds) {
    bounds = boundsForPoints([...data.nodes, ...data.nodes.map((node) => deformedResultNode(node, factor))]);
    resultPanelBoundsCache.set(data, bounds);
  }
  const projector = resultPanelProjector(panel, bounds);
  drawResultPanelFrame(panel, title, subtitle);
  drawResultPanelClipped(panel, () => {
    const originalOnGpu = drawGpuResultMesh("panel-original", () => [1, 1, 1, 0.12],
      { stroke: [83 / 255, 97 / 255, 113 / 255, 0.26], dashed: true, lineWidth: 0.9 }, projector);
    if (originalOnGpu) {
      if (drawGpuResultMesh("panel-displacement", (element) => gpuScalarColor(element.displacementMagnitude, data.ranges.displacementMagnitude, 0.72),
        { factor, stroke: [30 / 255, 41 / 255, 59 / 255, 0.42], lineWidth: 0.9 }, projector)) return;
    }
    resultCtx.save();
    resultCtx.strokeStyle = COLORS.resultOriginalMesh;
    resultCtx.lineWidth = 0.9;
    resultCtx.setLineDash([6, 5]);
    if (!originalOnGpu) for (const element of data.elements) {
      drawResultElement(element.nodes, "rgba(255, 255, 255, 0.12)", COLORS.resultOriginalMesh, projector);
    }
    resultCtx.restore();

    for (const element of data.elements) {
      const fill = resultColorForScalar(element.displacementMagnitude, data.ranges.displacementMagnitude);
      drawResultElement(
        element.nodes.map((node) => deformedResultNode(node, factor)),
        hexToRgba(fill, 0.72),
        "rgba(30, 41, 59, 0.42)",
        projector,
      );
    }
  });
}

function drawResultScalarPanel(panel, title, metricKey, range) {
  const projector = resultPanelProjector(panel, calculationResultData.baseBounds);
  drawResultPanelFrame(panel, title, `${formatNumber(range.min)} 至 ${formatNumber(range.max)}`);
  drawResultPanelClipped(panel, () => {
    if (drawGpuResultMesh(metricKey, (element) => gpuScalarColor(element[metricKey], range, 0.78),
      { stroke: [30 / 255, 41 / 255, 59 / 255, 0.34], lineWidth: 0.9 }, projector)) return;
    for (const element of calculationResultData.elements) {
      const fill = resultColorForScalar(element[metricKey], range);
      drawResultElement(element.nodes, hexToRgba(fill, 0.78), "rgba(30, 41, 59, 0.34)", projector);
    }
  });
}

function drawResultPanelFrame(panel, title, subtitle = "") {
  resultCtx.save();
  resultCtx.fillStyle = "#ffffff";
  resultCtx.strokeStyle = "#cfd8e3";
  resultCtx.lineWidth = 1;
  resultCtx.beginPath();
  if (resultCtx.roundRect) {
    resultCtx.roundRect(panel.x, panel.y, panel.width, panel.height, 7);
  } else {
    resultCtx.rect(panel.x, panel.y, panel.width, panel.height);
  }
  resultCtx.fill();
  resultCtx.stroke();
  resultCtx.fillStyle = "#263442";
  resultCtx.font = "700 13px Segoe UI, Arial, sans-serif";
  resultCtx.textAlign = "left";
  resultCtx.textBaseline = "middle";
  resultCtx.fillText(title, panel.x + 12, panel.y + 17, panel.width - 24);
  if (subtitle) {
    resultCtx.fillStyle = "#657080";
    resultCtx.font = "600 11px Segoe UI, Arial, sans-serif";
    resultCtx.textAlign = "right";
    resultCtx.fillText(subtitle, panel.x + panel.width - 12, panel.y + 17, Math.max(panel.width * 0.42, 120));
  }
  resultCtx.strokeStyle = "#e1e7ee";
  drawResultLineScreen({ x: panel.x, y: panel.y + 34 }, { x: panel.x + panel.width, y: panel.y + 34 });
  resultCtx.restore();
}

function drawResultPanelClipped(panel, draw) {
  resultCtx.save();
  resultCtx.beginPath();
  resultCtx.rect(panel.x + 1, panel.y + 35, panel.width - 2, panel.height - 36);
  resultCtx.clip();
  draw();
  resultCtx.restore();
}

function resultPanelInner(panel) {
  return {
    x: panel.x + 12,
    y: panel.y + 44,
    width: Math.max(panel.width - 24, 1),
    height: Math.max(panel.height - 56, 1),
  };
}

function resultPanelProjector(panel, bounds) {
  const inner = resultPanelInner(panel);
  const width = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const height = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const scale = Math.min(inner.width / width, inner.height / height) * 0.9 * resultDashboardView.zoom;
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  return (point) => ({
    x: inner.x + inner.width * (0.5 + resultDashboardView.panX) + (point.x - center.x) * scale,
    y: inner.y + inner.height * (0.5 + resultDashboardView.panY) - (point.y - center.y) * scale,
  });
}

function drawResultSafety() {
  if (calculationResultData.runInfo?.blastFrame) {
    resultCtx.fillStyle = "#334155";
    resultCtx.fillText("爆破帧请查看应力和损伤；静力安全校核不适用。", 24, 36);
    return;
  }
  if (drawGpuResultMesh("safety", (element) => gpuColor(RESULT_SAFETY_COLORS[element.safetyCode] || "#64748b", 0.78),
    { stroke: [30 / 255, 41 / 255, 59 / 255, 0.38], lineWidth: 0.9 })) return;
  for (const element of calculationResultData.elements) {
    const color = RESULT_SAFETY_COLORS[element.safetyCode] || "#64748b";
    drawResultElement(element.nodes, hexToRgba(color, 0.78), "rgba(30, 41, 59, 0.38)");
  }
}

function drawResultElement(points, fillStyle, strokeStyle, projector = resultWorldToScreen) {
  if (!points?.length) return;
  resultCtx.save();
  resultCtx.beginPath();
  points.forEach((point, index) => {
    const screen = projector(point);
    if (index === 0) resultCtx.moveTo(screen.x, screen.y);
    else resultCtx.lineTo(screen.x, screen.y);
  });
  resultCtx.closePath();
  resultCtx.fillStyle = fillStyle;
  resultCtx.fill();
  resultCtx.strokeStyle = strokeStyle;
  resultCtx.lineWidth = 0.9;
  resultCtx.stroke();
  resultCtx.restore();
}

function deformedResultNode(node, factor) {
  return {
    x: node.x + (Number(node.ux) || 0) * factor,
    y: node.y + (Number(node.uy) || 0) * factor,
  };
}

// 结果默认保持一倍真实位移，只有用户拖动滑块时才改变显示倍数。
function resultDisplacementFactor(data = calculationResultData) {
  if (!data) return 1;
  return clamp(readNumber(resultDeformationScale, 1), 1, suggestedResultDeformationScale(data));
}

function resetResultDeformationScale(data = calculationResultData) {
  if (!resultDeformationScale) return;
  const maximum = suggestedResultDeformationScale(data);
  resultDeformationScale.min = "1";
  resultDeformationScale.max = String(maximum);
  resultDeformationScale.disabled = !data || maximum <= 1;
  if (typeof resultDeformationScaleRecommended !== "undefined" && resultDeformationScaleRecommended) {
    resultDeformationScaleRecommended.textContent = resultScaleInputText(maximum) + "×";
  }
  setResultDeformationScale(1);
}

function handleResultDeformationScaleInput() {
  setResultDeformationScale(readNumber(resultDeformationScale, 1));
  renderResultView();
}

function setResultDeformationScale(scale) {
  if (!resultDeformationScale) return;
  const nextScale = Number(scale);
  const safeScale = clamp(Number.isFinite(nextScale) ? nextScale : 1, 1,
    suggestedResultDeformationScale(calculationResultData));
  resultDeformationScale.value = String(safeScale);
  resultDeformationScale.title = `当前显示为真实位移的 ${formatNumber(safeScale)} 倍`;
  resultDeformationScale.setAttribute("aria-valuetext", resultScaleInputText(safeScale) + "×");
  if (typeof resultDeformationScaleValue !== "undefined" && resultDeformationScaleValue) {
    resultDeformationScaleValue.textContent = resultScaleInputText(safeScale) + "×";
  }
}

function suggestedResultDeformationScale(data) {
  if (!data?.maxDisplacement || data.maxDisplacement <= 0) return 1;
  const suggested = (data.modelSize * 0.16) / data.maxDisplacement;
  return Number.isFinite(suggested) ? clamp(suggested, 1, 1e9) : 1;
}

function resultScaleInputText(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "1";
  if (number >= 1000) return String(Math.round(number));
  if (number >= 100) return String(Math.round(number * 10) / 10);
  return String(Math.round(number * 100) / 100);
}


function resultColorForScalar(value, range) {
  const min = Number(range?.min) || 0;
  const max = Number(range?.max) || 0;
  const t = max > min ? clamp((Number(value) - min) / (max - min), 0, 1) : 0.5;
  const scaled = t * (RESULT_RAMP_COLORS.length - 1);
  const index = Math.floor(scaled);
  const nextIndex = Math.min(index + 1, RESULT_RAMP_COLORS.length - 1);
  return mixHexColors(RESULT_RAMP_COLORS[index], RESULT_RAMP_COLORS[nextIndex], scaled - index);
}

function mixHexColors(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const mix = (x, y) => Math.round(x + (y - x) * clamp(t, 0, 1));
  return `#${[mix(ca.r, cb.r), mix(ca.g, cb.g), mix(ca.b, cb.b)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToRgb(color) {
  const value = normalizeColor(color).slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function fitResultViewToData(shouldRender = true) {
  if (!resultCtx) return;
  resultDashboardView = { zoom: 1, panX: 0, panY: 0 };
  const bounds = calculationResultData ? resultDataBounds(calculationResultData) : { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  const padding = 90;
  const width = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const height = Math.max(bounds.maxY - bounds.minY, 1e-9);
  resultView.scale = clamp(Math.min((resultView.width - padding * 2) / width, (resultView.height - padding * 2) / height), 1e-4, 1e7);
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  resultView.offsetX = resultView.width / 2 - center.x * resultView.scale;
  resultView.offsetY = resultView.height / 2 + center.y * resultView.scale;
  updateResultPanel();
  if (shouldRender) renderResultView();
}

function resultDataBounds(data) {
  if (activeResultView === "deformation") {
    const factor = resultBoundsDeformationFactor(data);
    return boundsForPoints([...data.nodes, ...data.nodes.map((node) => deformedResultNode(node, factor))]);
  }
  return data.baseBounds || boundsForPoints(data.nodes);
}

function resultBoundsDeformationFactor(data) {
  return resultDisplacementFactor(data);
}

function setResultView(viewKey) {
  let nextView = Object.prototype.hasOwnProperty.call(RESULT_VIEW_LABELS, viewKey) ? viewKey : "deformation";
  if (typeof activeResultChannel !== "undefined" &&
      ((activeResultChannel === "static" && ["damage", "tnt"].includes(nextView)) ||
       (activeResultChannel === "blast" && nextView === "safety"))) nextView = "deformation";
  activeResultView = nextView;
  resultViewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.resultView === activeResultView);
  });
  updateResultPanel();
  renderResultView();
}

function updateResultPanel() {
  const zoom = Math.round((isResultTensorDashboard() ? resultDashboardView.zoom : resultView.scale / 48) * 100);
  if (resultPanelCache.data === calculationResultData && resultPanelCache.view === activeResultView && resultPanelCache.zoom === zoom) return;
  resultPanelCache = { data: calculationResultData, view: activeResultView, zoom };
  if (resultModeName) {
    resultModeName.textContent = RESULT_VIEW_LABELS[activeResultView] || "计算结果";
  }
  if (resultZoomReadout) {
    resultZoomReadout.textContent = `${zoom}%`;
  }
  const data = calculationResultData;
  if (resultModelName) {
    resultModelName.value = uiText(data?.modelName || "未读取结果");
  }
  if (resultUi.nodes) resultUi.nodes.textContent = data?.nodes.length || 0;
  if (resultUi.elements) resultUi.elements.textContent = data?.elements.length || 0;
  if (resultUi.maxDisplacement) resultUi.maxDisplacement.textContent = formatNumber(data?.maxDisplacement || 0);
  if (resultUi.unsafeCount) resultUi.unsafeCount.textContent = data?.runInfo?.blastFrame ? "-" : data?.unsafeCount || 0;
  if (resultUi.maxStress) resultUi.maxStress.textContent = formatNumber(data?.maxStress || 0);
  if (resultUi.maxStrain) resultUi.maxStrain.textContent = formatNumber(data?.maxStrain || 0);
  if (resultUi.generatedAt) resultUi.generatedAt.textContent = data?.generatedAt || "-";
  updateResultLegend(data);
}

function updateResultLegend(data) {
  if (!resultUi.legend) return;
  if (resultLegendCache.data === data && resultLegendCache.view === activeResultView) return;
  resultLegendCache = { data, view: activeResultView };
  if (!data) {
    resultUi.legend.textContent = typeof activeResultChannel !== "undefined" && activeResultChannel === "blast"
      ? "请在爆破设置页运行模拟。" : "等待读取 calculation-data 中的结果文件。";
    return;
  }
  if (activeResultView === "damage") {
    if (!data.runInfo?.blastFrame) {resultUi.legend.textContent = "暂无爆破损伤结果。";return;}
    resultUi.legend.innerHTML = '<div class="legend-title">损伤 d（0–1）</div><div class="legend-ramp"></div><div>0 → 1</div>';
    return;
  }
  if (activeResultView === "tnt") {
    if (!data.runInfo?.blastFrame || typeof blastHistory === "undefined" || !blastHistory) {resultUi.legend.textContent = "暂无爆破损伤结果。";return;}
    const metrics = tntHistoryMetrics(blastHistory);
    resultUi.legend.innerHTML = `<div class="legend-title">爆破扰动等效应力（统一色标）</div><div class="legend-ramp"></div><div>0 → ${formatNumber(metrics.peak)} Pa</div><p>青色线：应力响应边界；深色网格：高损伤单元。</p>`;
    return;
  }
  if (activeResultView === "safety") {
    if (data.runInfo?.blastFrame) {
      resultUi.legend.textContent = "爆破帧请查看应力和损伤；静力安全校核不适用。";
      return;
    }
    resultUi.legend.innerHTML = Object.entries(RESULT_SAFETY_LABELS)
      .map(([code, label]) => `<div class="legend-row"><span style="background:${RESULT_SAFETY_COLORS[code]}"></span><strong>${escapeHtml(label)}</strong></div>`)
      .join("");
    return;
  }
  if (activeResultView === "stress" || activeResultView === "strain") {
    const isStress = activeResultView === "stress";
    const metrics = [
      { label: isStress ? "σxx / xx 方向" : "εxx / xx 方向", key: isStress ? "stressXx" : "strainXx" },
      { label: isStress ? "σxy / xy 方向" : "εxy / xy 方向", key: isStress ? "stressXy" : "strainXy" },
      { label: isStress ? "σyy / yy 方向" : "εyy / yy 方向", key: isStress ? "stressYy" : "strainYy" },
    ];
    const rows = metrics
      .map((metric) => {
        const range = data.ranges[metric.key];
        return `<div class="legend-range"><strong>${escapeHtml(metric.label)}</strong><span>${formatNumber(range.min)} 至 ${formatNumber(range.max)}</span></div>`;
      })
      .join("");
    resultUi.legend.innerHTML = [
      `<div class="legend-title">${isStress ? "应力四分窗" : "应变四分窗"}</div>`,
      `<div>左上为变形图；其余窗口按各自分量范围着色。</div>`,
      `<div class="legend-ramp"></div>`,
      rows,
    ].join("");
    return;
  }
  const rangeKey =
    activeResultView === "stress" ? "equivalentStress" : activeResultView === "strain" ? "equivalentStrain" : "displacementMagnitude";
  const range = data.ranges[rangeKey] || { min: 0, max: 0 };
  const title = activeResultView === "stress" ? "等效应力" : activeResultView === "strain" ? "等效应变" : "位移幅值";
  resultUi.legend.innerHTML = [
    `<div class="legend-title">${escapeHtml(title)}</div>`,
    `<div class="legend-ramp"></div>`,
    `<div class="legend-range"><span>${formatNumber(range.min)}</span><span>${formatNumber(range.max)}</span></div>`,
  ].join("");
}

function setResultStatus(message) {
  if (resultUi.status) {
    resultUi.status.textContent = message || "";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function onResultWheel(event) {
  event.preventDefault();
  const screen = resultPointerPoint(event);
  const factor = Math.exp(-event.deltaY * 0.0012);
  if (isResultTensorDashboard()) {
    const panel = resultDashboardPanelAt(screen);
    if (!panel || !calculationResultData) return;
    const inner = resultPanelInner(panel);
    const zoom = clamp(resultDashboardView.zoom * factor, 0.25, 32);
    const ratio = zoom / resultDashboardView.zoom;
    const x = (screen.x - inner.x) / inner.width - 0.5;
    const y = (screen.y - inner.y) / inner.height - 0.5;
    resultDashboardView.panX = x - (x - resultDashboardView.panX) * ratio;
    resultDashboardView.panY = y - (y - resultDashboardView.panY) * ratio;
    resultDashboardView.zoom = zoom;
    gpuMeshRenderer.requestFrame("result-interaction", renderResultView);
    return;
  }
  const before = resultScreenToWorld(screen);
  // CSS pixels per metre: allow close inspection of millimetre-scale cavities.
  resultView.scale = clamp(resultView.scale * factor, 1e-4, 1e7);
  resultView.offsetX = screen.x - before.x * resultView.scale;
  resultView.offsetY = screen.y + before.y * resultView.scale;
  gpuMeshRenderer.requestFrame("result-interaction", renderResultView);
}

function onResultPointerDown(event) {
  if (!resultCanvas) return;
  const screen = resultPointerPoint(event);
  const panel = isResultTensorDashboard() ? resultDashboardPanelAt(screen) : null;
  if (isResultTensorDashboard() && (!panel || !calculationResultData)) return;
  resultCanvas.setPointerCapture(event.pointerId);
  resultInteraction = {
    mode: "pan",
    lastScreen: screen,
    panel,
  };
  resultCanvas.classList.add("panning");
  event.preventDefault();
}

function onResultPointerMove(event) {
  const screen = resultPointerPoint(event);
  const world = resultInteractionWorldPoint(screen);
  if (resultCoordReadout && world) {
    resultCoordReadout.textContent = `x ${formatNumber(world.x)}, y ${formatNumber(world.y)}`;
  }
  if (resultInteraction?.mode !== "pan") return;
  const dx = screen.x - resultInteraction.lastScreen.x;
  const dy = screen.y - resultInteraction.lastScreen.y;
  if (isResultTensorDashboard() && resultInteraction.panel) {
    const inner = resultPanelInner(resultInteraction.panel);
    resultDashboardView.panX += dx / inner.width;
    resultDashboardView.panY += dy / inner.height;
  } else {
    resultView.offsetX += dx;
    resultView.offsetY += dy;
  }
  resultInteraction.lastScreen = screen;
  gpuMeshRenderer.requestFrame("result-interaction", renderResultView);
}

function onResultPointerUp() {
  if (resultInteraction?.mode === "pan") {
    resultCanvas.classList.remove("panning");
  }
  resultInteraction = null;
}

function onResultContextMenu(event) {
  event.preventDefault();
}

function resultDashboardPanelAt(screen) {
  return resultDashboardPanels().find((panel) => screen.x >= panel.x + 1 &&
    screen.x < panel.x + panel.width - 1 && screen.y >= panel.y + 35 &&
    screen.y < panel.y + panel.height - 1);
}

function resultInteractionWorldPoint(screen) {
  if (!isResultTensorDashboard()) return resultScreenToWorld(screen);
  const panel = resultDashboardPanelAt(screen);
  if (!panel || !calculationResultData) return null;
  const bounds = calculationResultData.baseBounds;
  // 第一幅为真实变形，使用与绘制相同的包围盒。
  const firstPanel = resultDashboardPanels()[0];
  const panelBounds = panel.x === firstPanel.x && panel.y === firstPanel.y
    ? resultPanelBoundsCache.get(calculationResultData) || bounds : bounds;
  const projector = resultPanelProjector(panel, panelBounds);
  const origin = projector({ x: 0, y: 0 });
  const scale = projector({ x: 1, y: 0 }).x - origin.x;
  return { x: (screen.x - origin.x) / scale, y: (origin.y - screen.y) / scale };
}

function drawResultLineScreen(a, b) {
  resultCtx.beginPath();
  resultCtx.moveTo(a.x, a.y);
  resultCtx.lineTo(b.x, b.y);
  resultCtx.stroke();
}
