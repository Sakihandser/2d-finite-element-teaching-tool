// 初始化材料库，包括调色盘、项目文件数据和空白表单。
async function initializeMaterialLibrary() {
  renderMaterialSwatches();
  initializeMaterialSearchEngine();
  await loadMaterialLibrary();
  syncRegionMaterialSnapshots();
  resetMaterialForm();
  renderMaterialLibrary();
  updatePanel();
  render();
}

// 初始化材料搜索引擎选择，并读取本机偏好。
function initializeMaterialSearchEngine() {
  if (!materialUi.searchEngine) return;
  const savedEngine = readSearchEnginePreference();
  materialUi.searchEngine.value = savedEngine;
  setMaterialSearchStatus(`当前搜索引擎：${MATERIAL_SEARCH_ENGINES[savedEngine].label}`);
}

// 从项目材料文件读取材料库。
async function loadMaterialLibrary() {
  clearLegacyMaterialStorage();
  materialStorageConnected = false;
  try {
    const payload = await fetchMaterialPayload(MATERIAL_API_URL);
    materialLibrary = normalizeMaterialPayload(payload);
    materialStorageConnected = true;
    setMaterialStorageStatus(`已连接项目材料文件：materials/materials.json`, "success");
    return;
  } catch (error) {
    // 直接双击 HTML 或使用普通静态服务时没有保存 API，继续读取可分享的项目数据文件。
  }
  try {
    const payload = await fetchMaterialPayload(MATERIAL_FILE_URL);
    materialLibrary = normalizeMaterialPayload(payload);
    setMaterialStorageStatus("已读取项目材料文件；保存到项目文件夹需要通过 server.js 打开。", "warn");
    return;
  } catch (error) {
    const embedded = window.PROJECT_MATERIAL_LIBRARY;
    materialLibrary = normalizeMaterialPayload(embedded);
    setMaterialStorageStatus("已读取内嵌材料库；保存到项目文件夹需要通过 server.js 打开。", "warn");
  }
}

// 读取项目材料数据。
async function fetchMaterialPayload(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}

// 规整项目材料数据。
function normalizeMaterialPayload(payload) {
  const records = Array.isArray(payload) ? payload : Array.isArray(payload?.materials) ? payload.materials : [];
  return records.map(normalizeMaterial).filter((material) => material.name);
}

// 清理旧版浏览器内部材料缓存。
function clearLegacyMaterialStorage() {
  try {
    window.localStorage.removeItem(LEGACY_MATERIAL_STORAGE_KEY);
  } catch (error) {
    // localStorage 不可用时不影响项目文件材料库。
  }
}

// 将材料库写入项目 materials/materials.json。
async function saveMaterialLibrary() {
  if (!materialStorageConnected) {
    throw new Error("未连接项目材料文件。请通过 node server.js 打开程序后再保存。");
  }
  const response = await fetch(MATERIAL_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      materials: materialLibrary,
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json();
  materialLibrary = normalizeMaterialPayload(payload);
  setMaterialStorageStatus(`已保存到项目材料文件：materials/materials.json`, "success");
}

// 规整材料对象，避免旧数据或手改材料 JSON 造成界面异常。
function normalizeMaterial(raw = {}, index = 0) {
  return {
    id: String(raw.id || `M${index + 1}`),
    name: String(raw.name || "").trim(),
    elasticModulus: nullableNumber(raw.elasticModulus),
    poissonRatio: nullableNumber(raw.poissonRatio),
    density: nullableNumber(raw.density),
    yieldStrength: nullableNumber(raw.yieldStrength),
    tensileStrength: nullableNumber(raw.tensileStrength),
    compressiveStrength: nullableNumber(raw.compressiveStrength),
    color: normalizeColor(raw.color),
    sourceUrl: String(raw.sourceUrl || "").trim(),
    sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls.map((url) => String(url).trim()).filter(Boolean) : [],
    notes: String(raw.notes || "").trim(),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
  };
}

// 绘制材料调色盘。
function renderMaterialSwatches() {
  if (!materialUi.swatches) return;
  materialUi.swatches.replaceChildren();
  MATERIAL_SWATCHES.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch-button";
    button.title = color;
    button.dataset.color = color;
    button.style.background = color;
    button.addEventListener("click", () => applyMaterialColor(color));
    materialUi.swatches.appendChild(button);
  });
  syncMaterialSwatches();
}

// 应用材料颜色，并同步预览和调色盘选中态。
function applyMaterialColor(color) {
  const nextColor = normalizeColor(color);
  materialUi.color.value = nextColor;
  materialUi.preview.style.background = nextColor;
  syncMaterialSwatches();
}

// 同步调色盘按钮选中态。
function syncMaterialSwatches() {
  if (!materialUi.swatches) return;
  const currentColor = normalizeColor(materialUi.color.value);
  materialUi.swatches.querySelectorAll(".swatch-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.color?.toLowerCase() === currentColor.toLowerCase());
  });
}

// 清空材料表单，进入新建状态。
function resetMaterialForm() {
  materialUi.id.value = "";
  materialUi.name.value = "";
  materialUi.elasticModulus.value = "";
  materialUi.poissonRatio.value = "";
  materialUi.density.value = "";
  materialUi.yieldStrength.value = "";
  materialUi.tensileStrength.value = "";
  materialUi.compressiveStrength.value = "";
  materialUi.sourceUrl.value = "";
  materialUi.notes.value = "";
  materialUi.formTitle.textContent = "新建材料";
  applyMaterialColor(MATERIAL_SWATCHES[0]);
  renderMaterialLibrary();
}

// 将一个材料写入右侧编辑表单。
function writeMaterialForm(material, title = "编辑材料") {
  const normalized = normalizeMaterial(material);
  materialUi.id.value = normalized.id;
  materialUi.name.value = normalized.name;
  materialUi.elasticModulus.value = formNumber(normalized.elasticModulus);
  materialUi.poissonRatio.value = formNumber(normalized.poissonRatio);
  materialUi.density.value = formNumber(normalized.density);
  materialUi.yieldStrength.value = formNumber(normalized.yieldStrength);
  materialUi.tensileStrength.value = formNumber(normalized.tensileStrength);
  materialUi.compressiveStrength.value = formNumber(normalized.compressiveStrength);
  materialUi.sourceUrl.value = normalized.sourceUrl;
  materialUi.notes.value = normalized.notes;
  materialUi.formTitle.textContent = title;
  applyMaterialColor(normalized.color);
}

// 表单数值显示。
function formNumber(value) {
  return value === null || value === undefined ? "" : String(value);
}

// 读取材料表单并生成可保存对象。
function readMaterialForm() {
  const name = materialUi.name.value.trim();
  if (!name) {
    window.alert("请输入材料名称。");
    materialUi.name.focus();
    return null;
  }
  const existing = materialLibrary.find((material) => material.id === materialUi.id.value);
  const now = new Date().toISOString();
  return normalizeMaterial({
    id: materialUi.id.value || createMaterialId(),
    name,
    elasticModulus: nullableNumber(materialUi.elasticModulus.value),
    poissonRatio: nullableNumber(materialUi.poissonRatio.value),
    density: nullableNumber(materialUi.density.value),
    yieldStrength: nullableNumber(materialUi.yieldStrength.value),
    tensileStrength: nullableNumber(materialUi.tensileStrength.value),
    compressiveStrength: nullableNumber(materialUi.compressiveStrength.value),
    color: materialUi.color.value,
    sourceUrl: materialUi.sourceUrl.value,
    sourceUrls: existing?.sourceUrls || [],
    notes: materialUi.notes.value,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
}

// 生成材料 ID。
function createMaterialId() {
  return `M${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// 保存或更新当前表单中的材料。
async function saveMaterialFromForm(event) {
  event.preventDefault();
  const material = readMaterialForm();
  if (!material) return;
  const previousLibrary = [...materialLibrary];
  const existingIndex = materialLibrary.findIndex((item) => item.id === material.id);
  if (existingIndex >= 0) {
    materialLibrary.splice(existingIndex, 1, material);
  } else {
    materialLibrary.unshift(material);
  }
  try {
    await saveMaterialLibrary();
    syncRegionMaterialSnapshots();
    rebuildDerivedRegions();
    writeMaterialForm(material);
    renderMaterialLibrary(material.id);
    updatePanel();
    render();
  } catch (error) {
    materialLibrary = previousLibrary;
    window.alert(`材料库保存失败：${error.message}`);
    renderMaterialLibrary(materialUi.id.value);
  }
}

// 渲染左侧本地材料列表。
function renderMaterialLibrary(activeId = materialUi.id?.value) {
  if (!materialUi.list) return;
  materialUi.count.textContent = String(materialLibrary.length);
  materialUi.list.replaceChildren();
  if (!materialLibrary.length) {
    const empty = document.createElement("div");
    empty.className = "empty-materials";
    empty.textContent = "暂无材料。创建后会保存在本地，下次打开仍可直接使用。";
    materialUi.list.appendChild(empty);
    return;
  }
  materialLibrary.forEach((material) => {
    materialUi.list.appendChild(createMaterialListItem(material, activeId));
  });
}

// 创建材料列表项。
function createMaterialListItem(material, activeId) {
  const item = document.createElement("article");
  item.className = "material-item";
  item.classList.toggle("active", material.id === activeId);

  const chip = document.createElement("span");
  chip.className = "material-chip";
  chip.style.background = material.color;

  const summary = document.createElement("div");
  summary.className = "material-summary";
  const name = document.createElement("strong");
  name.textContent = material.name;
  const detail = document.createElement("span");
  detail.textContent = materialPropertyLine(material);
  summary.append(name, detail);

  const actions = document.createElement("div");
  actions.className = "material-actions";
  const editButton = document.createElement("button");
  editButton.className = "icon-action";
  editButton.type = "button";
  editButton.title = "编辑材料";
  editButton.innerHTML = `<svg><use href="#icon-edit"></use></svg>`;
  editButton.addEventListener("click", () => {
    writeMaterialForm(material);
    renderMaterialLibrary(material.id);
  });
  const deleteButton = document.createElement("button");
  deleteButton.className = "icon-action danger";
  deleteButton.type = "button";
  deleteButton.title = "删除材料";
  deleteButton.innerHTML = `<svg><use href="#icon-clear"></use></svg>`;
  deleteButton.addEventListener("click", () => deleteMaterial(material.id));
  actions.append(editButton, deleteButton);

  item.append(chip, summary, actions);
  return item;
}

// 材料列表摘要。
function materialPropertyLine(material) {
  const parts = [];
  if (material.elasticModulus !== null) parts.push(`E ${formatMaterialNumber(material.elasticModulus)} GPa`);
  if (material.poissonRatio !== null) parts.push(`ν ${formatMaterialNumber(material.poissonRatio)}`);
  if (material.density !== null) parts.push(`ρ ${formatMaterialNumber(material.density)} kg/m³`);
  return parts.length ? parts.join(" · ") : "属性待补充";
}

// 删除指定材料。
async function deleteMaterial(id) {
  const material = materialLibrary.find((item) => item.id === id);
  if (!material) return;
  const confirmed = window.confirm(`删除材料“${material.name}”？`);
  if (!confirmed) return;
  const previousLibrary = [...materialLibrary];
  materialLibrary = materialLibrary.filter((item) => item.id !== id);
  try {
    await saveMaterialLibrary();
    syncRegionMaterialSnapshots();
    rebuildDerivedRegions();
    if (materialUi.id.value === id) {
      resetMaterialForm();
    }
    renderMaterialLibrary();
    updatePanel();
    render();
  } catch (error) {
    materialLibrary = previousLibrary;
    window.alert(`材料库删除失败：${error.message}`);
    renderMaterialLibrary(id);
  }
}

// 打开浏览器搜索材料属性。
function openMaterialBrowserSearch() {
  const keyword = materialSearchKeyword();
  if (!keyword) return;
  const query = `${keyword} ${MATERIAL_SEARCH_HINT}`;
  const engineKey = selectedMaterialSearchEngine();
  const engine = MATERIAL_SEARCH_ENGINES[engineKey];
  window.open(engine.makeUrl(query), "_blank", "noopener");
  setMaterialSearchStatus(`已用 ${engine.label} 搜索：${keyword}`, "success");
}

// 取得检索关键词。
function materialSearchKeyword() {
  const keyword = (materialUi.searchInput.value || materialUi.name.value || "").trim();
  if (!keyword) {
    window.alert("请输入要检索的材料名称。");
    materialUi.searchInput.focus();
    return "";
  }
  return keyword;
}

// 当前选中的搜索引擎。
function selectedMaterialSearchEngine() {
  const engineKey = materialUi.searchEngine?.value || "google";
  return MATERIAL_SEARCH_ENGINES[engineKey] ? engineKey : "google";
}

// 保存搜索引擎偏好；这是本机界面偏好，不影响项目材料文件。
function saveSearchEnginePreference() {
  const engineKey = selectedMaterialSearchEngine();
  try {
    window.localStorage.setItem(SEARCH_ENGINE_PREFERENCE_KEY, engineKey);
  } catch (error) {
    // 偏好保存失败不影响搜索功能。
  }
  setMaterialSearchStatus(`当前搜索引擎：${MATERIAL_SEARCH_ENGINES[engineKey].label}`);
}

// 读取搜索引擎偏好。
function readSearchEnginePreference() {
  try {
    const engineKey = window.localStorage.getItem(SEARCH_ENGINE_PREFERENCE_KEY);
    return MATERIAL_SEARCH_ENGINES[engineKey] ? engineKey : "google";
  } catch (error) {
    return "google";
  }
}

// 设置检索状态文字。
function setMaterialSearchStatus(text, kind = "") {
  if (!materialUi.searchStatus) return;
  materialUi.searchStatus.textContent = text;
  materialUi.searchStatus.classList.toggle("error", kind === "error");
  materialUi.searchStatus.classList.toggle("success", kind === "success");
}

// 设置项目材料文件连接状态。
function setMaterialStorageStatus(text, kind = "") {
  if (!materialUi.storageStatus) return;
  materialUi.storageStatus.textContent = text;
  materialUi.storageStatus.classList.toggle("success", kind === "success");
  materialUi.storageStatus.classList.toggle("warn", kind === "warn");
  materialUi.storageStatus.classList.toggle("error", kind === "error");
}
