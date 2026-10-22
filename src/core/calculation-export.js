const CALCULATION_EXPORT_FORMAT_VERSION = 1;
const CALCULATION_MODEL_DATA_VERSION = 1;
const CALCULATION_DATA_API_URL = "./api/calculation-models";
const CALCULATION_RUN_API_URL = "./api/calculation-runs";
const CALCULATION_DATA_DIRECTORY_NAME = "calculation-data";
const CALCULATION_INPUT_FILENAME = "calculation-input.txt";
const LOCAL_CALCULATION_SERVER_PORT_START = 5173;
const LOCAL_CALCULATION_SERVER_PORT_COUNT = 21;
const CALCULATION_DIRECTORY_PICKER_ID = "fem-calculation-data";
const CALCULATION_DIRECTORY_HANDLE_DB = "fem-calculation-data-handles";
const CALCULATION_DIRECTORY_HANDLE_STORE = "directory-handles";
const CALCULATION_DIRECTORY_HANDLE_KEY = "calculation-data";
let rememberedCalculationDataDirectoryHandle = null;
let rememberedCalculationDataDirectoryPermission = "";

if (typeof window !== "undefined") {
  loadRememberedCalculationDataDirectoryHandle();
}

// 生成给 C++ 计算核心读取的紧凑 JSON。该格式只描述求解输入，不包含视图和编辑器状态。
function buildCalculationInputExport(options = {}) {
  return prepareCalculationModelData(options).payload;
}

// 生成给 C++ 求解核心直接读取的纯文本输入。
function buildCalculationInputText(options = {}) {
  return calculationInputPayloadToText(buildCalculationInputExport(options));
}

// 整理一次完整的计算模型输入：连续编号、材料参数、节点载荷和单元等效节点载荷都在这里完成。
function prepareCalculationModelData(options = {}) {
  scene.name = modelName.value.trim() || scene.name || "未命名模型";
  syncRegionMaterialSnapshots();
  refreshCalculationExportClassifications(options.tolerance ?? DEFAULT_CLASSIFICATION_TOLERANCE);
  const warnings = [];
  const referencedNodeIds = calculationReferencedNodeIds(scene.mesh?.elements || []);
  const solverNodes = scene.analysisNodes.filter((node) => referencedNodeIds.has(String(node.id)));
  const omittedNodeCount = scene.analysisNodes.length - solverNodes.length;
  if (omittedNodeCount > 0) {
    warnings.push(`已从求解输入中排除 ${omittedNodeCount} 个未被 TRI3 单元引用的计算节点，避免总体刚度矩阵出现零行列。`);
  }
  const numbering = renumberCalculationModelForExport(solverNodes);

  const nodeById = new Map(solverNodes.map((node) => [String(node.id), node]));
  const nodeIndexById = new Map(solverNodes.map((node, index) => [String(node.id), index + 1]));
  const rawElements = [];

  (scene.mesh?.elements || []).forEach((element, index) => {
    const serialized = serializeCalculationElement(element, index, nodeById, nodeIndexById, warnings);
    if (serialized) {
      rawElements.push(serialized);
    }
  });

  const loadModel = calculationLoadModel(rawElements, nodeById, nodeIndexById, warnings);
  const nodes = solverNodes.map((node, index) => serializeCalculationNode(node, index, loadModel.nodeLoadById.get(String(node.id))));
  const elements = rawElements.map((element) => ({
    ...element,
    loads: loadModel.elementLoadById.get(element.id) || emptyElementLoadRecord(element),
  }));

  if (!nodes.length) {
    warnings.push("当前模型还没有计算节点；请先在计算页执行自动划分网格，或通过 setAnalysisMesh() 写入 analysisNodes。");
  }
  if (!elements.length) {
    warnings.push("当前模型还没有可导出的 TRI3 单元；请先在计算页执行自动划分网格，或通过 setAnalysisMesh() 写入 TRI3 单元。");
  }

  const materials = calculationMaterials(nodes, elements);
  const payload = {
    format: "fem-sketch-calculation-input",
    version: CALCULATION_EXPORT_FORMAT_VERSION,
    calculationModelDataVersion: CALCULATION_MODEL_DATA_VERSION,
    generatedAt: new Date().toISOString(),
    model: {
      name: scene.name,
      sourceSceneVersion: scene.version,
    },
    units: calculationExportUnits(),
    numbering,
    counts: {
      nodes: nodes.length,
      elements: elements.length,
      materials: materials.length,
      pointLoads: loadModel.payload.point.length,
      distributedLoads: loadModel.payload.distributed.length,
      bodyLoads: (scene.bodyLoads || []).length,
      staticNodes: nodes.filter((node) => node.mechanicalState === "static").length,
      loadedNodes: loadModel.payload.nodal.filter((load) => Math.hypot(load.fx, load.fy) > 0).length,
      elementLoadRecords: loadModel.payload.elementEquivalent.length,
    },
    meshMetadata: serializeCalculationMeshMetadata(),
    materials,
    nodes,
    elements,
    boundaryConditions: calculationBoundaryConditions(nodes),
    loads: loadModel.payload,
    geometryReferences: calculationGeometryReferences(),
    warnings,
  };
  return {
    payload,
    nodeById,
    nodeIndexById,
    loadModel,
  };
}

function calculationReferencedNodeIds(elements) {
  const nodeIds = new Set();
  for (const element of elements || []) {
    const refs = elementNodeRefs(element);
    if (refs.length !== 3) continue;
    for (const nodeId of refs) {
      nodeIds.add(String(nodeId));
    }
  }
  return nodeIds;
}

// 触发计算输入文件导出：只覆盖写入项目内 calculation-data/calculation-input.txt。
async function exportCalculationInputFile(options = {}) {
  const actionOptions = normalizeCalculationActionOptions(options);
  await ensureCalculationMeshReadyForExport(actionOptions);
  const payload = buildCalculationInputExport(actionOptions);
  const text = calculationInputPayloadToText(payload);
  const saveResult = await saveCalculationInputToProjectFolder(text, { action: "export" });
  updateCalculationExportStatus(saveResult, payload);
  return { payload, text, saveResult };
}

// 开始计算时把紧凑结构化模型直接交给本地服务；Node.js 与 C++ 之间使用二进制管道。
function onGpuAccelerationChange(event) {
  if (event.target.checked) {
    alert("建议单元数量超过 200 万个时再开启 GPU 加速。开启后不保证提速，无可用 GPU 时自动使用 CPU。");
  }
}

async function startCalculationWorkflow(options = {}) {
  if (calculationWorkflowRunning) return;
  const actionOptions = { ...normalizeCalculationActionOptions(options) };
  // Keep the selected backend consistent throughout all adaptive rounds.
  actionOptions.useGpuAcceleration = actionOptions.useGpuAcceleration ?? Boolean(document.getElementById("useGpuAcceleration")?.checked);
  calculationWorkflowRunning = true;
  try {
    const adaptive = actionOptions.adaptive ?? document.getElementById("adaptiveMeshEnabled")?.checked;
    return await (adaptive ? startAdaptiveCalculationWorkflow(actionOptions) : startSingleCalculationWorkflow(actionOptions));
  } finally {
    calculationWorkflowRunning = false;
  }
}

async function startSingleCalculationWorkflow(options = {}) {
  const actionOptions = normalizeCalculationActionOptions(options);
  await ensureCalculationMeshReadyForExport(actionOptions);
  const payload = buildCalculationInputExport(actionOptions);
  if (actionOptions.adaptive) validateAdaptiveElementData(payload);
  const model = calculationInputPayloadToDirectModel(payload);
  const shouldGenerateTextFiles = Boolean(generateCalculationTextFiles?.checked);
  const text = shouldGenerateTextFiles ? calculationInputPayloadToText(payload) : "";
  if (calculationStatuses.mesh && payload?.counts?.elements) {
    calculationStatuses.mesh.textContent = `${payload.counts.elements} 单元 / 二进制就绪`;
  }
  calculationRunStatusMessage = actionOptions.progressLabel || "正在运行 C++ 核心...";
  if (calculationStatuses.animation) {
    calculationStatuses.animation.textContent = calculationRunStatusMessage;
  }
  const runResult = await runCalculationCoreDirect(model, {
    adaptive: actionOptions.adaptive === true,
    timeLimitMs: actionOptions.timeLimitMs,
    useGpuAcceleration: actionOptions.useGpuAcceleration ?? Boolean(document.getElementById("useGpuAcceleration")?.checked),
    generateTextFiles: shouldGenerateTextFiles,
    inputText: text,
  });
  if (actionOptions.isModelCurrent && !actionOptions.isModelCurrent()) {
    throw new Error("模型在自适应计算期间发生变化，请重新计算。");
  }
  updateCalculationRunStatus(runResult);
  if (runResult?.ok && typeof loadCalculationResultsFromData === "function") {
    const resultData = loadCalculationResultsFromData(model, runResult.resultData, runResult);
    if (!resultData) {
      calculationRunStatusMessage = "结果解析失败";
      updateCalculationPanel();
    }
  }
  return { payload, model, text, runResult };
}

function normalizeCalculationActionOptions(options) {
  if (!options || typeof options !== "object" || typeof options.preventDefault === "function") {
    return {};
  }
  return options;
}

async function ensureCalculationMeshReadyForExport(options = {}) {
  const adaptive = Boolean(options.adaptive ?? document.getElementById("adaptiveMeshEnabled")?.checked);
  const needsAdaptiveSeed = adaptive && (
    scene.mesh?.metadata?.adaptive?.config?.maxNodes !== undefined ||
    (scene.mesh?.metadata?.adaptive && scene.mesh.metadata.adaptive.config?.connectionVersion !==
      (typeof ADAPTIVE_CONNECTION_VERSION !== 'undefined' ? ADAPTIVE_CONNECTION_VERSION : 5))
  );
  const meshVersionOutdated = Number(scene.mesh?.metadata?.version) !== ANALYSIS_MESH_VERSION;
  const placementVersionOutdated = Number(scene.analysisNodePlacement?.version) !== ANALYSIS_NODE_PLACEMENT_VERSION;
  const needsMesh =
    needsAdaptiveSeed ||
    !scene.mesh?.elements?.length ||
    scene.mesh?.metadata?.stale ||
    scene.analysisNodePlacement?.stale ||
    !scene.analysisNodes.length ||
    meshVersionOutdated ||
    placementVersionOutdated;
  if (options.refineOnce && needsMesh) {
    throw new Error("请先生成有效网格，再进行迭代加密。");
  }
  if (!needsMesh) {
    if (adaptive) scene.mesh.metadata.adaptiveInitialMesh = true;
    return;
  }
  if (typeof autoGenerateAnalysisMesh !== "function") return;
  await autoGenerateAnalysisMesh({
    adaptive,
    maxNodes: adaptive ? undefined : (options.maxNodes ?? readAnalysisNodeLimit()),
    spacing: options.spacing,
    tolerance: options.tolerance,
    regenerateNodes: needsAdaptiveSeed || meshVersionOutdated || placementVersionOutdated,
  });
}

async function saveCalculationInputToProjectFolder(text, options = {}) {
  const content = String(text || "");
  const shouldStartCalculation = options.action === "start-calculation";
  if (typeof fetch === "function" && (!shouldUseBrowserFolderWriter() || shouldStartCalculation)) {
    const serverResult = await saveCalculationInputWithServerApi(content, options);
    if (serverResult.ok) {
      return serverResult;
    }
    if (!shouldUseBrowserFolderWriter()) {
      if (canUseBrowserFolderWriter()) {
        return saveCalculationInputWithBrowserFolderPicker(content, options);
      }
      return serverResult;
    }
  }
  if (shouldUseBrowserFolderWriter()) {
    return saveCalculationInputWithBrowserFolderPicker(content, options);
  }
  if (typeof fetch !== "function") {
    return saveCalculationInputWithBrowserFolderPicker(content, options);
  }
  try {
    const response = await fetch(CALCULATION_DATA_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: content,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `保存计算输入失败：HTTP ${response.status}`);
    }
    return { ...result, action: options.action || "" };
  } catch (error) {
    console.warn(error);
    if (canUseBrowserFolderWriter()) {
      return saveCalculationInputWithBrowserFolderPicker(content, options);
    }
    return { ok: false, action: options.action || "", error: error.message };
  }
}

async function saveCalculationInputWithServerApi(content, options = {}) {
  let lastError = null;
  for (const target of calculationApiTargets(CALCULATION_DATA_API_URL)) {
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: content,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || `保存计算输入失败：HTTP ${response.status}`);
      }
      return { ...result, action: options.action || "", serverBaseUrl: target.baseUrl };
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(lastError);
  return {
    ok: false,
    action: options.action || "",
    error: lastError?.message || "未连接到本地计算服务。",
  };
}

async function runCalculationCoreDirect(model, options = {}) {
  if (typeof fetch !== "function") {
    return {
      ok: false,
      skipped: true,
      error: "当前浏览器不支持调用本地计算服务；请通过 start.bat 或 node server.js 启动本地服务。",
    };
  }
  let lastError = null;
  for (const target of calculationApiTargets(CALCULATION_RUN_API_URL)) {
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          model,
          useGpuAcceleration: options.useGpuAcceleration === true,
          adaptive: options.adaptive === true,
          timeLimitMs: options.timeLimitMs,
          generateTextFiles: options.generateTextFiles === true,
          inputText: options.generateTextFiles === true ? String(options.inputText || "") : "",
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.ok) {
        return { ...result, serverBaseUrl: target.baseUrl };
      }
      const message = result.stderr || result.error || `C++ 计算失败：HTTP ${response.status}`;
      if (result.executable || result.stdout || result.stderr) {
        return { ...result, ok: false, error: message, serverBaseUrl: target.baseUrl };
      }
      throw new Error(message);
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(lastError);
  return {
    ok: false,
    skipped: shouldUseBrowserFolderWriter(),
    error: lastError?.message || "未连接到本地计算服务。",
  };
}

function calculationApiTargets(apiUrl, preferredBaseUrl = "") {
  const path = apiUrl.replace(/^\./, "");
  const targets = [];
  if (preferredBaseUrl) {
    targets.push({ url: `${preferredBaseUrl}${path}`, baseUrl: preferredBaseUrl });
  }
  if (!shouldUseBrowserFolderWriter()) {
    targets.push({ url: apiUrl, baseUrl: "" });
  }
  if (shouldUseBrowserFolderWriter()) {
    localCalculationServerBaseUrls().forEach((baseUrl) => {
      targets.push({ url: `${baseUrl}${path}`, baseUrl });
    });
  }
  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.url)) return false;
    seen.add(target.url);
    return true;
  });
}

function localCalculationServerBaseUrls() {
  return Array.from({ length: LOCAL_CALCULATION_SERVER_PORT_COUNT }, (_, index) => `http://localhost:${LOCAL_CALCULATION_SERVER_PORT_START + index}`);
}

function shouldUseBrowserFolderWriter() {
  return typeof window !== "undefined" && window.location?.protocol === "file:";
}

function canUseBrowserFolderWriter() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

async function saveCalculationInputWithBrowserFolderPicker(text, options = {}) {
  if (!canUseBrowserFolderWriter()) {
    return {
      ok: false,
      skipped: true,
      action: options.action || "",
      error: "当前浏览器不支持直接写入文件夹，请使用 Chrome/Edge 或通过 start.bat 启动本地服务。",
    };
  }
  try {
    if (rememberedCalculationDataDirectoryHandle && rememberedCalculationDataDirectoryPermission === "granted") {
      return writeCalculationInputToBrowserDirectory(rememberedCalculationDataDirectoryHandle, text, options, "browser-folder-handle");
    }

    const selectedDirectory = await showCalculationDirectoryPicker(rememberedCalculationDataDirectoryHandle);
    await ensureDirectoryWritePermission(selectedDirectory);
    const targetDirectory = await calculationDataTargetDirectory(selectedDirectory);
    await ensureDirectoryWritePermission(targetDirectory);
    await storeCalculationDataDirectoryHandle(targetDirectory);
    return writeCalculationInputToBrowserDirectory(targetDirectory, text, options, "browser-folder-picker");
  } catch (error) {
    console.warn(error);
    return {
      ok: false,
      action: options.action || "",
      error: error.name === "AbortError" ? "已取消选择文件夹，未写入计算输入文件。" : error.message,
    };
  }
}

async function calculationDataTargetDirectory(selectedDirectory) {
  if (selectedDirectory.name === CALCULATION_DATA_DIRECTORY_NAME) {
    return selectedDirectory;
  }
  return selectedDirectory.getDirectoryHandle(CALCULATION_DATA_DIRECTORY_NAME, { create: true });
}

async function loadRememberedCalculationDataDirectoryHandle() {
  const directoryHandle = await readStoredCalculationDataDirectoryHandle();
  rememberedCalculationDataDirectoryHandle = directoryHandle;
  rememberedCalculationDataDirectoryPermission = directoryHandle ? await queryDirectoryWritePermission(directoryHandle) : "";
}

async function queryDirectoryWritePermission(directoryHandle) {
  if (!directoryHandle || typeof directoryHandle.queryPermission !== "function") return "";
  try {
    return await directoryHandle.queryPermission({ mode: "readwrite" });
  } catch (error) {
    console.warn(error);
    return "";
  }
}

async function showCalculationDirectoryPicker(startDirectoryHandle = null) {
  const options = {
    id: CALCULATION_DIRECTORY_PICKER_ID,
    mode: "readwrite",
    startIn: startDirectoryHandle || "documents",
  };
  try {
    return await window.showDirectoryPicker(options);
  } catch (error) {
    if (!startDirectoryHandle || error.name === "AbortError") {
      throw error;
    }
    console.warn(error);
    return window.showDirectoryPicker({
      id: CALCULATION_DIRECTORY_PICKER_ID,
      mode: "readwrite",
      startIn: "documents",
    });
  }
}

async function writeCalculationInputToBrowserDirectory(targetDirectory, text, options = {}, writer = "browser-folder-picker") {
  const fileHandle = await targetDirectory.getFileHandle(CALCULATION_INPUT_FILENAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
  return {
    ok: true,
    action: options.action || "",
    savedAt: new Date().toISOString(),
    directory: targetDirectory.name || CALCULATION_DATA_DIRECTORY_NAME,
    filename: CALCULATION_INPUT_FILENAME,
    path: `${CALCULATION_DATA_DIRECTORY_NAME}/${CALCULATION_INPUT_FILENAME}`,
    bytes: new Blob([text]).size,
    writer,
  };
}

async function ensureDirectoryWritePermission(directoryHandle) {
  if (!directoryHandle) {
    throw new Error("没有可写入的文件夹句柄。");
  }
  const permission = { mode: "readwrite" };
  if (typeof directoryHandle.queryPermission === "function" && (await directoryHandle.queryPermission(permission)) === "granted") {
    return true;
  }
  if (typeof directoryHandle.requestPermission === "function" && (await directoryHandle.requestPermission(permission)) === "granted") {
    return true;
  }
  throw new Error("没有获得写入文件夹的权限。");
}

async function readStoredCalculationDataDirectoryHandle() {
  return calculationDirectoryHandleStoreAction("readonly", (store) => store.get(CALCULATION_DIRECTORY_HANDLE_KEY), null);
}

async function storeCalculationDataDirectoryHandle(directoryHandle) {
  if (!directoryHandle) return null;
  rememberedCalculationDataDirectoryHandle = directoryHandle;
  rememberedCalculationDataDirectoryPermission = await queryDirectoryWritePermission(directoryHandle);
  return calculationDirectoryHandleStoreAction("readwrite", (store) => store.put(directoryHandle, CALCULATION_DIRECTORY_HANDLE_KEY), null);
}

async function clearStoredCalculationDataDirectoryHandle() {
  rememberedCalculationDataDirectoryHandle = null;
  rememberedCalculationDataDirectoryPermission = "";
  return calculationDirectoryHandleStoreAction("readwrite", (store) => store.delete(CALCULATION_DIRECTORY_HANDLE_KEY), null);
}

async function calculationDirectoryHandleStoreAction(mode, action, fallback = null) {
  if (typeof indexedDB === "undefined") return fallback;
  try {
    const db = await openCalculationDirectoryHandleDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(CALCULATION_DIRECTORY_HANDLE_STORE, mode);
      const store = transaction.objectStore(CALCULATION_DIRECTORY_HANDLE_STORE);
      const request = action(store);
      let result = fallback;

      request.onsuccess = () => {
        result = request.result ?? fallback;
      };
      request.onerror = () => reject(request.error || new Error("读写计算数据文件夹缓存失败。"));
      transaction.oncomplete = () => {
        db.close();
        resolve(result);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("计算数据文件夹缓存事务失败。"));
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error || new Error("计算数据文件夹缓存事务已中止。"));
      };
    });
  } catch (error) {
    console.warn(error);
    return fallback;
  }
}

function openCalculationDirectoryHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CALCULATION_DIRECTORY_HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CALCULATION_DIRECTORY_HANDLE_STORE)) {
        db.createObjectStore(CALCULATION_DIRECTORY_HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开计算数据文件夹缓存。"));
  });
}

function updateCalculationExportStatus(saveResult, payload) {
  if (calculationStatuses.mesh && payload?.counts?.elements) {
    calculationStatuses.mesh.textContent = `${payload.counts.elements} 单元 / TXT已生成`;
  }
  calculationRunStatusMessage = saveResult?.ok ? `已覆盖 ${saveResult.filename}` : saveResult?.error || "请从本地服务器打开";
  if (!calculationStatuses.animation) return;
  calculationStatuses.animation.textContent = calculationRunStatusMessage;
}

function updateCalculationRunStatus(runResult) {
  calculationRunStatusMessage = runResult?.ok
    ? runResult.textFilesGenerated
      ? "二进制计算完成，TXT 已生成"
      : "二进制计算完成（未生成 TXT）"
    : runResult?.skipped
      ? runResult.error || "未连接本地服务"
      : calculationRunErrorMessage(runResult);
  if (!calculationStatuses.animation) return;
  calculationStatuses.animation.textContent = calculationRunStatusMessage;
}

function calculationRunErrorMessage(runResult) {
  const details = String(runResult?.stderr || runResult?.error || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return details ? `计算失败：${details}` : "C++ 计算失败";
}

function handleCalculationExportError(error) {
  console.error(error);
  calculationRunStatusMessage = error?.message || "输入生成失败";
  if (
    calculationStatuses.mesh &&
    (activeCalculationTool === "auto-mesh" || /triangle|网格|剖分|轮廓|约束边/i.test(calculationRunStatusMessage))
  ) {
    calculationStatuses.mesh.textContent = "网格失败";
    calculationStatuses.mesh.title = calculationRunStatusMessage;
  }
  if (calculationStatuses.animation) {
    calculationStatuses.animation.textContent = calculationRunStatusMessage;
  }
}

function renumberCalculationModelForExport(solverNodes = scene.analysisNodes) {
  const nodes = [];
  solverNodes.forEach((node, index) => {
    const number = index + 1;
    node.number = number;
    node.index = number;
    node.sourceNumber = numericId(node.id, number);
    node.dof = {
      ux: index * 2 + 1,
      uy: index * 2 + 2,
    };
    nodes.push({ id: node.id, number, sourceNumber: node.sourceNumber, dof: { ...node.dof } });
  });

  const elements = [];
  (scene.mesh?.elements || []).forEach((element, index) => {
    const number = index + 1;
    element.id = String(element.id || `E${number}`);
    element.number = number;
    element.index = number;
    element.sourceNumber = numericId(element.id, number);
    elements.push({ id: element.id, number, sourceNumber: element.sourceNumber });
  });

  return {
    nodeNumbering: "TRI3-referenced analysis node order, 1-based",
    elementNumbering: "scene.mesh.elements array order, 1-based",
    dofPerNode: 2,
    nodes,
    elements,
  };
}

function calculationInputPayloadToText(payload) {
  const materialNumberById = new Map((payload.materials || []).map((material, index) => [material.id, index + 1]));
  const regionNumberById = new Map((payload.geometryReferences?.structureRegions || []).map((region, index) => [region.id, index + 1]));
  const lines = [
    "FEM_CALCULATION_INPUT_TXT_V1",
    `MODEL ${solverTextToken(payload.model?.name || "unnamed_model")}`,
    `GENERATED_AT ${solverTextToken(payload.generatedAt || "")}`,
    "UNITS LENGTH=model FORCE=N ELASTIC_MODULUS=Pa DENSITY=kg/m3 STRENGTH=Pa",
    [
      "COUNTS",
      `NODES=${payload.counts?.nodes || 0}`,
      `ELEMENTS=${payload.counts?.elements || 0}`,
      `MATERIALS=${payload.counts?.materials || 0}`,
      `POINT_LOADS=${payload.counts?.pointLoads || 0}`,
      `DISTRIBUTED_LOADS=${payload.counts?.distributedLoads || 0}`,
      `BODY_LOADS=${payload.counts?.bodyLoads || 0}`,
    ].join(" "),
    "",
    "MATERIALS",
    "# matNo E nu rho yield tensile compressive",
  ];

  for (const material of payload.materials || []) {
    const props = material.properties || emptyMaterialProperties();
    lines.push(
      [
        materialNumberById.get(material.id) || 0,
        solverTextNumber(props.elasticModulus),
        solverTextNumber(props.poissonRatio),
        solverTextNumber(props.density),
        solverTextNumber(props.yieldStrength),
        solverTextNumber(props.tensileStrength),
        solverTextNumber(props.compressiveStrength),
      ].join(" "),
    );
  }

  lines.push("", "NODES", "# nodeNo x y fixUx fixUy dofUx dofUy Fx Fy matNo regionNo");
  for (const node of payload.nodes || []) {
    const load = node.loads || emptyNodeLoadRecord(node.id, node.number);
    lines.push(
      [
        node.number,
        solverTextNumber(node.x),
        solverTextNumber(node.y),
        node.constraints?.ux ? 1 : 0,
        node.constraints?.uy ? 1 : 0,
        node.dof?.ux || 0,
        node.dof?.uy || 0,
        solverTextNumber(load.fx),
        solverTextNumber(load.fy),
        materialNumberById.get(node.materialId || node.material?.id) || 0,
        regionNumberById.get(node.region?.id) || 0,
      ].join(" "),
    );
  }

  lines.push("", "ELEMENTS", "# elemNo n1 n2 n3 area cx cy matNo E nu rho yield tensile compressive");
  for (const element of payload.elements || []) {
    const props = element.mechanicalProperties || emptyMaterialProperties();
    lines.push(
      [
        element.number,
        ...(element.nodeNumbers || [0, 0, 0]),
        solverTextNumber(element.area),
        solverTextNumber(element.centroid?.x),
        solverTextNumber(element.centroid?.y),
        materialNumberById.get(element.materialId || element.material?.id) || 0,
        solverTextNumber(props.elasticModulus),
        solverTextNumber(props.poissonRatio),
        solverTextNumber(props.density),
        solverTextNumber(props.yieldStrength),
        solverTextNumber(props.tensileStrength),
        solverTextNumber(props.compressiveStrength),
      ].join(" "),
    );
  }

  lines.push("", "ELEMENT_NODE_LOADS", "# elemNo Fx1 Fy1 Fx2 Fy2 Fx3 Fy3");
  for (const element of payload.elements || []) {
    const vector = normalizedElementLoadVector(element.loads?.vector);
    lines.push([element.number, ...vector.map(solverTextNumber)].join(" "));
  }

  lines.push("", "WARNINGS", `# count=${payload.warnings?.length || 0}`);
  for (const warning of payload.warnings || []) {
    lines.push(`# ${warning}`);
  }
  lines.push("END");
  return `${lines.join("\n")}\n`;
}

// 只保留求解器需要的字段，避免把视图、边界来源和网格质量元数据发送给 Node.js。
function calculationInputPayloadToDirectModel(payload) {
  const materials = payload.materials || [];
  const materialNumberById = new Map(materials.map((material, index) => [material.id, index + 1]));
  const regionNumberById = new Map((payload.geometryReferences?.structureRegions || []).map((region, index) => [region.id, index + 1]));
  const directMaterials = materials.map((material, index) => {
    const props = material.properties || emptyMaterialProperties();
    return {
      materialNo: index + 1,
      name: material.name || material.id || "",
      elasticModulus: Number(props.elasticModulus) || 0,
      poissonRatio: Number(props.poissonRatio) || 0,
      density: Number(props.density) || 0,
      yieldStrength: Number(props.yieldStrength) || 0,
      tensileStrength: Number(props.tensileStrength) || 0,
      compressiveStrength: Number(props.compressiveStrength) || 0,
    };
  });
  const directNodes = (payload.nodes || []).map((node) => {
    const load = node.loads || emptyNodeLoadRecord(node.id, node.number);
    return {
      nodeNo: Number(node.number) || 0,
      x: Number(node.x) || 0,
      y: Number(node.y) || 0,
      fixUx: Boolean(node.constraints?.ux),
      fixUy: Boolean(node.constraints?.uy),
      dofUx: Number(node.dof?.ux) || 0,
      dofUy: Number(node.dof?.uy) || 0,
      forceX: Number(load.fx) || 0,
      forceY: Number(load.fy) || 0,
      materialNo: materialNumberById.get(node.materialId || node.material?.id) || 0,
      regionNo: regionNumberById.get(node.region?.id) || 0,
    };
  });
  const directElements = [];
  const elementNodeLoads = [];
  for (const element of payload.elements || []) {
    const props = element.mechanicalProperties || emptyMaterialProperties();
    const nodeNumbers = Array.isArray(element.nodeNumbers) ? element.nodeNumbers : [0, 0, 0];
    directElements.push({
      elementNo: Number(element.number) || 0,
      node1: Number(nodeNumbers[0]) || 0,
      node2: Number(nodeNumbers[1]) || 0,
      node3: Number(nodeNumbers[2]) || 0,
      nodeNumbers: nodeNumbers.map((value) => Number(value) || 0),
      area: Number(element.area) || 0,
      centroidX: Number(element.centroid?.x) || 0,
      centroidY: Number(element.centroid?.y) || 0,
      centroid: { x: Number(element.centroid?.x) || 0, y: Number(element.centroid?.y) || 0 },
      materialNo: materialNumberById.get(element.materialId || element.material?.id) || 0,
      elasticModulus: Number(props.elasticModulus) || 0,
      poissonRatio: Number(props.poissonRatio) || 0,
      density: Number(props.density) || 0,
      yieldStrength: Number(props.yieldStrength) || 0,
      tensileStrength: Number(props.tensileStrength) || 0,
      compressiveStrength: Number(props.compressiveStrength) || 0,
    });
    const load = normalizedElementLoadVector(element.loads?.vector);
    elementNodeLoads.push({
      elementNo: Number(element.number) || 0,
      forceX1: load[0],
      forceY1: load[1],
      forceX2: load[2],
      forceY2: load[3],
      forceX3: load[4],
      forceY3: load[5],
    });
  }
  return {
    header: "FEM_CALCULATION_BINARY_V1",
    modelName: String(payload.model?.name || "未命名模型"),
    generatedAt: String(payload.generatedAt || new Date().toISOString()),
    units: { length: "model", force: "N", elasticModulus: "Pa", density: "kg/m3", strength: "Pa" },
    counts: {
      nodes: directNodes.length,
      elements: directElements.length,
      materials: directMaterials.length,
      pointLoads: Number(payload.counts?.pointLoads) || 0,
      distributedLoads: Number(payload.counts?.distributedLoads) || 0,
      bodyLoads: Number(payload.counts?.bodyLoads) || 0,
    },
    materials: directMaterials,
    nodes: directNodes,
    elements: directElements,
    elementNodeLoads,
    warnings: Array.isArray(payload.warnings) ? [...payload.warnings] : [],
  };
}

function normalizedElementLoadVector(vector) {
  const values = Array.isArray(vector) ? vector.map((value) => Number(value) || 0) : [];
  while (values.length < 6) {
    values.push(0);
  }
  return values.slice(0, 6);
}

function solverTextNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) < 1e-14) return "0";
  const rounded = Math.round(number * 1000000000) / 1000000000;
  if (Math.abs(rounded) >= 1000000 || Math.abs(rounded) < 0.000001) {
    return rounded.toExponential(10).replace(/\.?0+e/, "e");
  }
  return String(rounded);
}

function solverTextToken(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[\\/:*?"<>|]+/g, "-");
}

function calculationExportUnits() {
  return {
    length: "m 或当前模型坐标单位",
    force: "N",
    distributedLoad: "N/m",
    bodyAcceleration: "m/s^2",
    elasticModulus: "Pa",
    density: "kg/m^3",
    strength: "Pa",
    poissonRatio: "1",
  };
}

function refreshCalculationExportClassifications(tolerance) {
  if(typeof classifyAnalysisNodeBatch==='function')classifyAnalysisNodeBatch(scene.analysisNodes || [],tolerance);
  else for(const node of scene.analysisNodes || [])classifyAnalysisNode(node,tolerance);
  classifyAnalysisElements(tolerance);
}

function serializeCalculationNode(node, index, load = null) {
  const mechanicalState = normalizeMechanicalState(node.mechanicalState);
  const number = index + 1;
  return {
    id: node.id,
    number,
    sourceNumber: numericId(node.id, number),
    index: index + 1,
    x: Number(node.x),
    y: Number(node.y),
    coordinates: [Number(node.x), Number(node.y)],
    mechanicalState,
    isStatic: mechanicalState === "static",
    isFree: mechanicalState === "free",
    constraints: {
      ux: mechanicalState === "static",
      uy: mechanicalState === "static",
    },
    dof: {
      ux: index * 2 + 1,
      uy: index * 2 + 2,
    },
    loads: load || emptyNodeLoadRecord(node, number),
    region: serializeRegionReference(node),
    materialId: node.materialId || null,
    materialName: node.materialName || "",
    material: calculationMaterialRecord(node.materialId, node.materialName, node.materialProperties),
    placement: serializeAnalysisNodePlacement(node.placement),
    geometrySource: {
      type: node.geometrySourceType || null,
      id: node.geometrySourceId || null,
      distance: finiteOrNull(node.geometrySourceDistance),
    },
  };
}

function serializeAnalysisNodePlacement(placement) {
  if (!placement || typeof placement !== "object") return null;
  return {
    sourceType: placement.sourceType || null,
    sourceId: placement.sourceId || null,
    geometryNodeId: placement.geometryNodeId || null,
    curveId: placement.curveId || null,
    curveT: finiteOrNull(placement.curveT),
    loadId: placement.loadId || null,
    regionId: placement.regionId || null,
    regionIds: Array.isArray(placement.regionIds) ? [...placement.regionIds] : [],
    curveIds: Array.isArray(placement.curveIds) ? [...placement.curveIds] : [],
  };
}

function serializeCalculationElement(element, index, nodeById, nodeIndexById, warnings) {
  const refs = elementNodeRefs(element);
  if (refs.length !== 3) {
    warnings.push(`${element?.id || `E${index + 1}`} 被跳过：C++ 输入口当前只导出三节点 TRI3 单元。`);
    return null;
  }

  const nodes = refs.map((ref) => analysisNodeByElementRef(ref, nodeById)).filter(Boolean);
  if (nodes.length !== 3) {
    warnings.push(`${element?.id || `E${index + 1}`} 被跳过：存在找不到的计算节点引用。`);
    return null;
  }

  const ccwNodes = orderTriangleNodesCounterClockwise(nodes);
  const signedArea = triangleSignedArea(ccwNodes);
  if (Math.abs(signedArea) < 1e-12) {
    warnings.push(`${element?.id || `E${index + 1}`} 面积接近 0，请检查网格节点是否共线。`);
  }

  const material = calculationMaterialRecord(element.materialId, element.materialName, element.materialProperties);
  const mechanicalProperties = material?.properties || emptyMaterialProperties();
  return {
    id: String(element?.id || `E${index + 1}`),
    number: index + 1,
    sourceNumber: numericId(element?.id, index + 1),
    index: index + 1,
    type: "TRI3",
    nodeIds: ccwNodes.map((node) => node.id),
    nodeNumbers: ccwNodes.map((node) => nodeIndexById.get(String(node.id))),
    nodes: ccwNodes.map((node) => serializeElementNode(node, nodeIndexById)),
    area: Math.abs(signedArea),
    signedArea,
    centroid: elementCentroidFromNodes(ccwNodes),
    edgeLengths: Array.isArray(element.edgeLengths) ? element.edgeLengths.map(roundCoord) : triangleEdgeLengths(ccwNodes),
    edges: serializeElementEdges(element),
    boundaryCurveIds: Array.isArray(element.boundaryCurveIds) ? [...element.boundaryCurveIds] : [],
    quality: serializeElementQuality(element.quality),
    generation: serializeElementGeneration(element.generation),
    region: serializeRegionReference(element),
    materialId: material?.id || null,
    materialName: material?.name || "",
    material,
    mechanicalProperties,
    nodeStates: ccwNodes.map((node) => normalizeMechanicalState(node.mechanicalState)),
    hasStaticNode: ccwNodes.some((node) => normalizeMechanicalState(node.mechanicalState) === "static"),
    hasFreeNode: ccwNodes.some((node) => normalizeMechanicalState(node.mechanicalState) === "free"),
  };
}

function triangleEdgeLengths(nodes) {
  return [
    roundCoord(distance(nodes[0], nodes[1])),
    roundCoord(distance(nodes[1], nodes[2])),
    roundCoord(distance(nodes[2], nodes[0])),
  ];
}

function serializeElementEdges(element) {
  if (!Array.isArray(element.edges)) return [];
  return element.edges.map((edge) => ({
    nodeIds: Array.isArray(edge.nodeIds) ? edge.nodeIds.map(String) : [],
    length: finiteOrNull(edge.length),
    boundary: Boolean(edge.boundary),
    curveId: edge.curveId || null,
    curveType: edge.curveType || null,
    mechanicalState: edge.mechanicalState || null,
    regionIds: Array.isArray(edge.regionIds) ? edge.regionIds.map(String) : [],
    tRange: Array.isArray(edge.tRange) ? edge.tRange.map(finiteOrNull) : null,
  }));
}

function serializeElementQuality(quality) {
  if (!quality || typeof quality !== "object") return null;
  return {
    minAngle: finiteOrNull(quality.minAngle),
    maxAngle: finiteOrNull(quality.maxAngle),
    aspectRatio: finiteOrNull(quality.aspectRatio),
    shapeQuality: finiteOrNull(quality.shapeQuality),
  };
}

function serializeElementGeneration(generation) {
  if (!generation || typeof generation !== "object") return null;
  return {
    algorithm: String(generation.algorithm || ""),
    source: String(generation.source || ""),
  };
}

function serializeCalculationMeshMetadata() {
  const metadata = scene.mesh?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  return {
    version: Number(metadata.version) || null,
    algorithm: metadata.algorithm || "",
    generatedAt: metadata.generatedAt || "",
    stale: Boolean(metadata.stale),
    sourcePlacement: metadata.sourcePlacement || null,
    tolerance: finiteOrNull(metadata.tolerance),
    counts: metadata.counts || null,
    rejected: metadata.rejected || null,
    recovery: metadata.recovery || null,
    library: metadata.library || null,
    coverage: metadata.coverage || null,
    adaptive: metadata.adaptive || null,
    adaptiveInitialMesh: Boolean(metadata.adaptiveInitialMesh),
    regionElementSets: Array.isArray(metadata.regionElementSets)
      ? metadata.regionElementSets.map((set) => ({
          regionId: set.regionId,
          regionKind: set.regionKind,
          materialId: set.materialId || null,
          materialName: set.materialName || "",
          elementIds: Array.isArray(set.elementIds) ? [...set.elementIds] : [],
          area: finiteOrNull(set.area),
        }))
      : [],
    warnings: Array.isArray(metadata.warnings) ? [...metadata.warnings] : [],
  };
}

function serializeElementNode(node, nodeIndexById) {
  const mechanicalState = normalizeMechanicalState(node.mechanicalState);
  const number = nodeIndexById.get(String(node.id));
  return {
    id: node.id,
    number,
    x: Number(node.x),
    y: Number(node.y),
    coordinates: [Number(node.x), Number(node.y)],
    mechanicalState,
    isStatic: mechanicalState === "static",
    isFree: mechanicalState === "free",
    constraints: {
      ux: mechanicalState === "static",
      uy: mechanicalState === "static",
    },
    dof: {
      ux: number ? (number - 1) * 2 + 1 : null,
      uy: number ? (number - 1) * 2 + 2 : null,
    },
  };
}

function analysisNodeByElementRef(ref, nodeById) {
  const directMatch = nodeById.get(String(ref));
  if (directMatch) return directMatch;
  if (typeof ref !== "number") return null;
  const solverNodes = [...nodeById.values()];
  return solverNodes[ref] || solverNodes[ref - 1] || null;
}

function orderTriangleNodesCounterClockwise(nodes) {
  return triangleSignedArea(nodes) < 0 ? [nodes[0], nodes[2], nodes[1]] : [...nodes];
}

function triangleSignedArea(nodes) {
  return polygonSignedArea(nodes.map((node) => ({ x: node.x, y: node.y })));
}

function elementCentroidFromNodes(nodes) {
  const sum = nodes.reduce((acc, node) => ({ x: acc.x + node.x, y: acc.y + node.y }), { x: 0, y: 0 });
  return {
    x: roundCoord(sum.x / nodes.length),
    y: roundCoord(sum.y / nodes.length),
  };
}

function serializeRegionReference(source) {
  return {
    id: source.structureRegionId || source.regionId || null,
    name: source.structureName || "",
    kind: source.regionKind || null,
    isAir: Boolean(source.isAir),
    isStructure: Boolean(source.isStructure),
  };
}

function calculationMaterialRecord(materialId, materialName, properties) {
  const snapshot = createMaterialSnapshot({
    id: materialId,
    name: materialName,
    ...(properties || {}),
  });
  if (!snapshot) return null;
  return {
    id: snapshot.id || null,
    name: snapshot.name || "",
    properties: materialPropertiesForSolver(snapshot),
  };
}

function materialPropertiesForSolver(material) {
  return {
    elasticModulus: gpaToPa(material.elasticModulus),
    poissonRatio: finiteOrNull(material.poissonRatio),
    density: finiteOrNull(material.density),
    yieldStrength: mpaToPa(material.yieldStrength),
    tensileStrength: mpaToPa(material.tensileStrength),
    compressiveStrength: mpaToPa(material.compressiveStrength),
  };
}

function emptyMaterialProperties() {
  return {
    elasticModulus: null,
    poissonRatio: null,
    density: null,
    yieldStrength: null,
    tensileStrength: null,
    compressiveStrength: null,
  };
}

function calculationMaterials(nodes, elements) {
  const byId = new Map();
  for (const region of scene.regions || []) {
    const material = calculationMaterialRecord(region.materialId, region.materialName, region.materialProperties);
    if (material?.id && !byId.has(material.id)) {
      byId.set(material.id, material);
    }
  }
  for (const node of nodes) {
    if (node.material?.id && !byId.has(node.material.id)) {
      byId.set(node.material.id, node.material);
    }
  }
  for (const element of elements) {
    if (element.material?.id && !byId.has(element.material.id)) {
      byId.set(element.material.id, element.material);
    }
  }
  return [...byId.values()];
}

function calculationBoundaryConditions(nodes) {
  return nodes
    .filter((node) => node.mechanicalState === "static")
    .map((node) => ({
      nodeId: node.id,
      nodeNumber: node.number,
      ux: 0,
      uy: 0,
      fixed: ["ux", "uy"],
    }));
}

function calculationLoadModel(elements, nodeById, nodeIndexById, warnings) {
  const solverNodes = [...nodeById.values()];
  const nodeLoadAccumulators = new Map(solverNodes.map((node, index) => [String(node.id), createNodeLoadAccumulator(node, index + 1)]));
  const pointLoads = scene.pointLoads.filter((load) => !geometryNodeById(load.geometryNodeId)?.construction).map((load) => {
    const serialized = serializePointLoad(load, nodeIndexById, solverNodes);
    if (serialized.targetAnalysisNodeId) {
      addNodeLoadComponent(nodeLoadAccumulators.get(String(serialized.targetAnalysisNodeId)), "point", serialized.fx, serialized.fy, {
        type: "pointLoad",
        loadId: serialized.id,
      });
    } else {
      warnings.push(`${load.id} 点载荷未匹配到计算节点，未写入全局节点载荷。`);
    }
    return serialized;
  });
  const distributedLoads = scene.distributedLoads.filter((load) => !curveById(load.curveId)?.construction).map(serializeDistributedLoad);
  const distributedLoadsByCurve = groupDistributedLoadsByCurve(distributedLoads);
  const bodyLoads = (scene.bodyLoads || []).map(serializeBodyLoad);
  const elementLoadById = new Map();

  for (const element of elements) {
    const elementLoad = createElementLoadAccumulator(element, nodeIndexById);
    for (const edge of element.edges || []) {
      if (!edge.boundary || !edge.curveId) continue;
      for (const load of distributedLoadsByCurve.get(edge.curveId) || []) {
        const contribution = distributedLoadContributionForElementEdge(edge, load, nodeById);
        if (!contribution) continue;
        elementLoad.distributedContributions.push(contribution);
        for (const nodalLoad of contribution.nodeLoads) {
          addElementNodeLoadComponent(elementLoad, nodalLoad.nodeId, nodalLoad.fx, nodalLoad.fy, contribution);
          addNodeLoadComponent(nodeLoadAccumulators.get(String(nodalLoad.nodeId)), "distributed", nodalLoad.fx, nodalLoad.fy, {
            type: "distributedLoad",
            loadId: contribution.loadId,
            elementId: element.id,
            elementNumber: element.number,
            curveId: contribution.curveId,
            loadedLength: contribution.loadedLength,
          });
        }
      }
    }
    for (const load of bodyLoads) {
      const contribution = bodyLoadContributionForElement(element, load);
      if (!contribution) continue;
      elementLoad.bodyContributions.push(contribution);
      for (const nodalLoad of contribution.nodeLoads) {
        addElementNodeLoadComponent(elementLoad, nodalLoad.nodeId, nodalLoad.fx, nodalLoad.fy, contribution);
        addNodeLoadComponent(nodeLoadAccumulators.get(String(nodalLoad.nodeId)), "body", nodalLoad.fx, nodalLoad.fy, {
          type: "bodyLoad",
          loadId: contribution.loadId,
          elementId: element.id,
          elementNumber: element.number,
          regionId: contribution.regionId,
          area: contribution.area,
          density: contribution.density,
        });
      }
    }
    elementLoadById.set(element.id, serializeElementLoadAccumulator(elementLoad));
  }

  const nodeLoadById = new Map([...nodeLoadAccumulators.entries()].map(([nodeId, accumulator]) => [nodeId, serializeNodeLoadAccumulator(accumulator)]));
  return {
    nodeLoadById,
    elementLoadById,
    payload: {
      point: pointLoads,
      distributed: distributedLoads,
      body: bodyLoads,
      nodal: [...nodeLoadById.values()],
      elementEquivalent: [...elementLoadById.values()].filter(
        (load) => load.distributedContributions.length || load.bodyContributions.length || Math.hypot(...load.vector) > 0,
      ),
    },
  };
}

function serializePointLoad(load, nodeIndexById, solverNodes) {
  const anchor = loadAnchorPoint(load) || load.anchor || { x: 0, y: 0 };
  const target = nearestAnalysisNode(anchor, solverNodes);
  return {
    id: load.id,
    geometryNodeId: load.geometryNodeId || null,
    targetAnalysisNodeId: target?.id || null,
    targetAnalysisNodeNumber: target ? nodeIndexById.get(String(target.id)) : null,
    anchor: {
      x: roundCoord(anchor.x || 0),
      y: roundCoord(anchor.y || 0),
    },
    fx: roundCoord(load.fx),
    fy: roundCoord(load.fy),
    vector: [roundCoord(load.fx), roundCoord(load.fy)],
  };
}

function serializeDistributedLoad(load) {
  const direction = normalize(load.direction || { x: 0, y: -1 }, { x: 0, y: -1 });
  const qStart = distributedLoadStartMagnitude(load);
  const qEnd = distributedLoadEndMagnitude(load);
  return {
    id: load.id,
    curveId: load.curveId,
    q: roundCoord(qStart),
    qStart: roundCoord(qStart),
    qEnd: roundCoord(qEnd),
    direction: {
      x: roundCoord(direction.x),
      y: roundCoord(direction.y),
    },
    directionVector: [roundCoord(direction.x), roundCoord(direction.y)],
    start: clamp(Number(load.start) || 0, 0, 1),
    end: clamp(Number(load.end ?? 1), 0, 1),
  };
}

function serializeBodyLoad(load) {
  const direction = normalize(load.direction || { x: 0, y: -1 }, { x: 0, y: -1 });
  const targetType = load.targetType === "region" || load.regionId ? "region" : "global";
  return {
    id: load.id,
    targetType,
    regionId: targetType === "region" ? load.regionId || null : null,
    magnitude: roundCoord(bodyLoadMagnitude(load)),
    direction: {
      x: roundCoord(direction.x),
      y: roundCoord(direction.y),
    },
    directionVector: [roundCoord(direction.x), roundCoord(direction.y)],
  };
}

function groupDistributedLoadsByCurve(loads) {
  const byCurve = new Map();
  for (const load of loads) {
    if (!load.curveId) continue;
    if (!byCurve.has(load.curveId)) {
      byCurve.set(load.curveId, []);
    }
    byCurve.get(load.curveId).push(load);
  }
  return byCurve;
}

function createNodeLoadAccumulator(node, number) {
  return {
    nodeId: node.id,
    nodeNumber: number,
    point: { fx: 0, fy: 0 },
    distributed: { fx: 0, fy: 0 },
    body: { fx: 0, fy: 0 },
    contributions: [],
  };
}

function addNodeLoadComponent(accumulator, category, fx, fy, contribution = {}) {
  if (!accumulator || !Number.isFinite(Number(fx)) || !Number.isFinite(Number(fy))) return;
  const target = category === "distributed" ? accumulator.distributed : category === "body" ? accumulator.body : accumulator.point;
  target.fx += Number(fx);
  target.fy += Number(fy);
  accumulator.contributions.push({
    ...contribution,
    category: category === "distributed" ? "distributed" : category === "body" ? "body" : "point",
    fx: roundCoord(fx),
    fy: roundCoord(fy),
    vector: [roundCoord(fx), roundCoord(fy)],
  });
}

function serializeNodeLoadAccumulator(accumulator) {
  const point = roundedLoadVector(accumulator.point.fx, accumulator.point.fy);
  const distributed = roundedLoadVector(accumulator.distributed.fx, accumulator.distributed.fy);
  const body = roundedLoadVector(accumulator.body.fx, accumulator.body.fy);
  const total = roundedLoadVector(point.fx + distributed.fx + body.fx, point.fy + distributed.fy + body.fy);
  return {
    nodeId: accumulator.nodeId,
    nodeNumber: accumulator.nodeNumber,
    fx: total.fx,
    fy: total.fy,
    vector: total.vector,
    point,
    distributed,
    body,
    contributions: accumulator.contributions,
  };
}

function emptyNodeLoadRecord(node, number) {
  const nodeId = typeof node === "string" ? node : node?.id || "";
  const nodeNumber = Number.isFinite(Number(number)) ? Number(number) : null;
  return {
    nodeId,
    nodeNumber,
    fx: 0,
    fy: 0,
    vector: [0, 0],
    point: roundedLoadVector(0, 0),
    distributed: roundedLoadVector(0, 0),
    body: roundedLoadVector(0, 0),
    contributions: [],
  };
}

function createElementLoadAccumulator(element, nodeIndexById) {
  return {
    elementId: element.id,
    elementNumber: element.number,
    nodeLoads: element.nodeIds.map((nodeId) => ({
      nodeId,
      nodeNumber: nodeIndexById.get(String(nodeId)) || null,
      fx: 0,
      fy: 0,
      contributions: [],
    })),
    distributedContributions: [],
    bodyContributions: [],
  };
}

function addElementNodeLoadComponent(accumulator, nodeId, fx, fy, contribution) {
  const target = accumulator.nodeLoads.find((load) => load.nodeId === nodeId);
  if (!target) return;
  target.fx += Number(fx) || 0;
  target.fy += Number(fy) || 0;
  target.contributions.push({
    type: contribution.type || "distributedLoad",
    loadId: contribution.loadId,
    curveId: contribution.curveId,
    regionId: contribution.regionId,
    loadedLength: contribution.loadedLength,
    area: contribution.area,
    density: contribution.density,
    fx: roundCoord(fx),
    fy: roundCoord(fy),
    vector: [roundCoord(fx), roundCoord(fy)],
  });
}

function serializeElementLoadAccumulator(accumulator) {
  const nodeLoads = accumulator.nodeLoads.map((load) => {
    const rounded = roundedLoadVector(load.fx, load.fy);
    return {
      nodeId: load.nodeId,
      nodeNumber: load.nodeNumber,
      fx: rounded.fx,
      fy: rounded.fy,
      vector: rounded.vector,
      contributions: load.contributions,
    };
  });
  return {
    elementId: accumulator.elementId,
    elementNumber: accumulator.elementNumber,
    type: "element-equivalent-nodal-loads",
    nodeLoads,
    vector: nodeLoads.flatMap((load) => load.vector),
    distributedContributions: accumulator.distributedContributions,
    bodyContributions: accumulator.bodyContributions,
  };
}

function emptyElementLoadRecord(element) {
  const nodeIds = Array.isArray(element?.nodeIds) ? element.nodeIds : [];
  const nodeNumbers = Array.isArray(element?.nodeNumbers) ? element.nodeNumbers : [];
  const nodeLoads = nodeIds.map((nodeId, index) => ({
    nodeId,
    nodeNumber: nodeNumbers[index] || null,
    fx: 0,
    fy: 0,
    vector: [0, 0],
    contributions: [],
  }));
  return {
    elementId: element?.id || null,
    elementNumber: element?.number || null,
    type: "element-equivalent-nodal-loads",
    nodeLoads,
    vector: nodeLoads.flatMap((load) => load.vector),
    distributedContributions: [],
    bodyContributions: [],
  };
}

function distributedLoadContributionForElementEdge(edge, load, nodeById) {
  const edgeRange = normalizedParameterRange(edge.tRange);
  const loadRange = normalizedParameterRange([load.start, load.end]);
  const overlap = parameterRangeOverlap(edgeRange, loadRange);
  if (!overlap) return null;

  const edgeLength = Number(edge.length) || 0;
  const edgeNodes = edgeNodeParameters(edge, nodeById);
  if (edgeNodes.length !== 2) return null;
  const t0 = edgeNodes[0].t;
  const t1 = edgeNodes[1].t;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || Math.abs(t1 - t0) <= 1e-12) return null;

  const u0 = clamp((overlap.min - t0) / (t1 - t0), 0, 1);
  const u1 = clamp((overlap.max - t0) / (t1 - t0), 0, 1);
  const uMin = Math.min(u0, u1);
  const uMax = Math.max(u0, u1);
  const loadedLength = edgeLength * (uMax - uMin);
  if (loadedLength <= 1e-9) return null;

  const qAtNode0 = distributedLoadMagnitudeAt(load, t0);
  const qAtNode1 = distributedLoadMagnitudeAt(load, t1);
  const qSlope = qAtNode1 - qAtNode0;
  const node0Scalar = edgeLength * integrateLinearEdgeShapeLoad(0, uMin, uMax, qAtNode0, qSlope);
  const node1Scalar = edgeLength * integrateLinearEdgeShapeLoad(1, uMin, uMax, qAtNode0, qSlope);
  const directionX = Number(load.direction?.x) || 0;
  const directionY = Number(load.direction?.y) || 0;
  const nodeLoads = [
    {
      nodeId: edgeNodes[0].nodeId,
      fx: roundCoord(node0Scalar * directionX),
      fy: roundCoord(node0Scalar * directionY),
    },
    {
      nodeId: edgeNodes[1].nodeId,
      fx: roundCoord(node1Scalar * directionX),
      fy: roundCoord(node1Scalar * directionY),
    },
  ].map((nodeLoad) => ({
    ...nodeLoad,
    vector: [nodeLoad.fx, nodeLoad.fy],
  }));
  return {
    type: "distributedLoad",
    loadId: load.id,
    curveId: load.curveId,
    edgeNodeIds: edgeNodes.map((node) => node.nodeId),
    edgeLength: roundCoord(edgeLength),
    loadedLength: roundCoord(loadedLength),
    edgeTRange: [roundCoord(edgeRange.min), roundCoord(edgeRange.max)],
    loadTRange: [roundCoord(loadRange.min), roundCoord(loadRange.max)],
    overlapTRange: [roundCoord(overlap.min), roundCoord(overlap.max)],
    overlapURange: [roundCoord(uMin), roundCoord(uMax)],
    qStart: roundCoord(load.qStart),
    qEnd: roundCoord(load.qEnd),
    qAtEdgeNodes: [roundCoord(qAtNode0), roundCoord(qAtNode1)],
    direction: {
      x: roundCoord(load.direction?.x || 0),
      y: roundCoord(load.direction?.y || 0),
    },
    nodeLoads,
  };
}

function edgeNodeParameters(edge, nodeById) {
  const nodeIds = Array.isArray(edge.nodeIds) ? edge.nodeIds.map(String) : [];
  if (nodeIds.length !== 2) return [];
  const fallback = Array.isArray(edge.tRange) ? edge.tRange : [0, 1];
  return nodeIds.map((nodeId, index) => ({
    nodeId,
    t: analysisNodeCurveParameter(nodeById.get(nodeId), edge.curveId) ?? finiteOrNull(fallback[index]) ?? (index === 0 ? 0 : 1),
  }));
}

function analysisNodeCurveParameter(node, curveId) {
  if (!node || !curveId) return null;
  if (node.placement?.curveId === curveId && Number.isFinite(Number(node.placement.curveT))) {
    return clamp(Number(node.placement.curveT), 0, 1);
  }
  for (const source of node.placement?.sources || []) {
    if (source?.curveId === curveId && Number.isFinite(Number(source.curveT))) {
      return clamp(Number(source.curveT), 0, 1);
    }
  }
  return null;
}

function integrateLinearEdgeShapeLoad(nodeIndex, u0, u1, q0, qSlope) {
  const integralAt = (u) => {
    if (nodeIndex === 0) {
      return q0 * (u - (u * u) / 2) + qSlope * ((u * u) / 2 - (u * u * u) / 3);
    }
    return q0 * (u * u) / 2 + qSlope * (u * u * u) / 3;
  };
  return integralAt(u1) - integralAt(u0);
}

function bodyLoadContributionForElement(element, load) {
  if (!bodyLoadAppliesToElement(load, element)) return null;
  const area = Number(element.area) || 0;
  const density = Number(element.mechanicalProperties?.density);
  const magnitude = Number(load.magnitude) || 0;
  if (area <= 1e-12 || !Number.isFinite(density) || Math.abs(density) <= 1e-12 || magnitude <= 1e-12) return null;
  const scalarPerNode = (density * magnitude * area) / 3;
  const directionX = Number(load.direction?.x) || 0;
  const directionY = Number(load.direction?.y) || 0;
  const nodeLoads = (element.nodeIds || []).map((nodeId) => {
    const fx = roundCoord(scalarPerNode * directionX);
    const fy = roundCoord(scalarPerNode * directionY);
    return {
      nodeId,
      fx,
      fy,
      vector: [fx, fy],
    };
  });
  return {
    type: "bodyLoad",
    loadId: load.id,
    targetType: load.targetType,
    regionId: element.region?.id || element.regionId || null,
    area: roundCoord(area),
    density: roundCoord(density),
    acceleration: roundCoord(magnitude),
    direction: {
      x: roundCoord(load.direction?.x || 0),
      y: roundCoord(load.direction?.y || 0),
    },
    equivalentPerNode: {
      fx: roundCoord(scalarPerNode * directionX),
      fy: roundCoord(scalarPerNode * directionY),
      vector: [roundCoord(scalarPerNode * directionX), roundCoord(scalarPerNode * directionY)],
    },
    nodeLoads,
  };
}

function bodyLoadAppliesToElement(load, element) {
  if (!load || !element) return false;
  const regionId = element.region?.id || element.regionId || null;
  if (load.targetType === "region") {
    return Boolean(load.regionId && regionId === load.regionId);
  }
  return element.region?.isStructure || element.isStructure || !element.region?.isAir;
}

function normalizedParameterRange(values) {
  const rawStart = Array.isArray(values) ? values[0] : 0;
  const rawEnd = Array.isArray(values) ? values[1] : 1;
  const start = clamp(Number(rawStart) || 0, 0, 1);
  const end = clamp(Number(rawEnd ?? 1), 0, 1);
  return {
    min: Math.min(start, end),
    max: Math.max(start, end),
  };
}

function parameterRangeOverlap(a, b) {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return max > min + 1e-9 ? { min, max } : null;
}

function roundedLoadVector(fx, fy) {
  const roundedFx = roundCoord(Number(fx) || 0);
  const roundedFy = roundCoord(Number(fy) || 0);
  return {
    fx: roundedFx,
    fy: roundedFy,
    vector: [roundedFx, roundedFy],
  };
}

function nearestAnalysisNode(point, candidates = scene.analysisNodes) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of candidates) {
    const currentDistance = distance(point, node);
    if (currentDistance < bestDistance) {
      best = node;
      bestDistance = currentDistance;
    }
  }
  return bestDistance <= DEFAULT_CLASSIFICATION_TOLERANCE ? best : null;
}

function calculationGeometryReferences() {
  return {
    staticGeometryNodes: scene.geometryNodes
      .filter((node) => !node.construction && normalizeMechanicalState(node.mechanicalState) === "static")
      .map((node) => ({ id: node.id, x: roundCoord(node.x), y: roundCoord(node.y) })),
    staticCurves: scene.curves
      .filter((curve) => !curve.construction && normalizeMechanicalState(curve.mechanicalState) === "static")
      .map((curve) => ({ id: curve.id, type: curve.type, geometryNodeIds: [...(curve.geometryNodeIds || [])] })),
    structureRegions: (scene.regions || [])
      .filter((region) => !isAirRegion(region))
      .map((region) => ({
        id: region.id,
        name: region.name,
        materialId: region.materialId || null,
        materialName: region.materialName || "",
        area: region.area,
        centroid: region.centroid ? { x: roundCoord(region.centroid.x), y: roundCoord(region.centroid.y) } : null,
      })),
  };
}

function gpaToPa(value) {
  const number = finiteOrNull(value);
  return number === null ? null : roundCoord(number * 1000000000);
}

function mpaToPa(value) {
  const number = finiteOrNull(value);
  return number === null ? null : roundCoord(number * 1000000);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numericId(id, fallback) {
  const match = String(id || "").match(/\d+/);
  return match ? Number(match[0]) : fallback;
}
