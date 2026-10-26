// Professional modules are optional. Geometry, materials and meshes remain shared;
// the two result workspaces retain independent data and view state.
const PROFESSIONAL_PREFERENCE_KEY = "fem.professional-calculations.v1";
let blastModuleEnabled = false;
let activeResultChannel = "static";
const resultChannels = { static: null, blast: null };

function isProfessionalCalculationEnabled(key) {
  return key === "blast" && blastModuleEnabled;
}

function setBlastModuleEnabled(enabled, persist = true) {
  blastModuleEnabled = Boolean(enabled);
  document.getElementById("enableBlastModule").checked = blastModuleEnabled;
  document.getElementById("professionalSummary").textContent = blastModuleEnabled ? "基础 + 爆破" : "基础";
  document.querySelectorAll('[data-professional="blast"]').forEach(element => { element.hidden = !blastModuleEnabled; });
  if (!blastModuleEnabled) {
    blastRunController?.abort();
    if (blastPlayback !== null) cancelAnimationFrame(blastPlayback);
    blastPlayback = null;
    if (["blast-library", "blast", "blast-results"].includes(currentPageKey())) setPage("calculation");
  }
  if (persist) {
    try { localStorage.setItem(PROFESSIONAL_PREFERENCE_KEY, JSON.stringify({ blast: blastModuleEnabled })); } catch { /* Private/file browsing may disable storage. */ }
  }
  render();
}

function captureResultChannel() {
  resultChannels[activeResultChannel] = {
    data: calculationResultData, mode: activeResultView, view: { ...resultView },
    dashboard: { ...resultDashboardView }, scale: resultDeformationScale?.value,
    status: document.getElementById("resultLoadStatus").textContent,
  };
}

function activateResultWorkspace(channel) {
  if (channel !== activeResultChannel) {
    captureResultChannel();
    activeResultChannel = channel;
    const saved = resultChannels[channel];
    calculationResultData = saved?.data || null;
    activeResultView = saved?.mode || (channel === "blast" ? "tnt" : "deformation");
    if (saved) Object.assign(resultView, saved.view);
    resultDashboardView = saved?.dashboard ? { ...saved.dashboard } : { zoom: 1, panX: 0, panY: 0 };
    resetResultDeformationScale(calculationResultData);
    if (saved?.scale) setResultDeformationScale(Number(saved.scale));
    setResultStatus(saved?.status || (channel === "blast" ? "请在爆破设置页运行模拟。" : "未读取静力学结果"));
    resultPanelCache = { data: undefined, view: undefined, zoom: undefined };
    resultLegendCache = { data: undefined, view: undefined };
  }
  const host = document.getElementById(channel === "blast" ? "blastResultsPage" : "resultsPage");
  host.append(document.getElementById("resultWorkspace"));
  document.querySelectorAll("[data-result-channel]").forEach(element => {
    element.hidden = element.dataset.resultChannel !== channel || (element.id === "blastTimeline" && !blastHistory);
  });
  resultViewButtons.forEach(button => button.classList.toggle("active", button.dataset.resultView === activeResultView));
}

function resetBlastResultWorkspace() {
  const cached = resultChannels.blast?.data;
  if (cached && cached !== calculationResultData && typeof gpuMeshRenderer !== "undefined") gpuMeshRenderer.release?.(cached);
  resultChannels.blast = null;
  if (activeResultChannel === "blast") {
    if (typeof gpuMeshRenderer !== "undefined") gpuMeshRenderer.release?.(calculationResultData);
    calculationResultData = null;
    resetResultDeformationScale(null);
    setResultStatus("请在爆破设置页运行模拟。");
    renderResultView();
  }
}

function initializeProfessionalCalculations() {
  let enabled = false;
  try { enabled = JSON.parse(localStorage.getItem(PROFESSIONAL_PREFERENCE_KEY) || "{}").blast === true; } catch { /* Default to the basic workspace. */ }
  setBlastModuleEnabled(enabled, false);
  const menu = document.getElementById("professionalMenu");
  document.getElementById("enableBlastModule").addEventListener("change", event => setBlastModuleEnabled(event.target.checked));
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target)) menu.open = false; });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary").focus(); }
  });
  document.querySelectorAll("[data-open-page]").forEach(button => button.addEventListener("click", () => setPage(button.dataset.openPage)));
  const meshLimit = document.getElementById("blastMaxAnalysisNodes");
  meshLimit.value = maxAnalysisNodes.value;
  meshLimit.addEventListener("change", () => { maxAnalysisNodes.value = meshLimit.value; });
  maxAnalysisNodes.addEventListener("change", () => { meshLimit.value = maxAnalysisNodes.value; });
  document.getElementById("generateBlastMesh").addEventListener("click", async event => {
    if (calculationWorkflowRunning) return;
    const status = document.getElementById("blastMeshStatus"), count = Number(meshLimit.value);
    if (!Number.isSafeInteger(count) || count < 1) { status.textContent = "节点上限须为正整数。"; return; }
    calculationWorkflowRunning = true; event.target.disabled = true;
    status.textContent = "正在生成网格…";
    try {
      maxAnalysisNodes.value = String(count);
      await autoGenerateAnalysisMesh({ regenerateNodes: true, adaptive: false, maxNodes: count });
      status.textContent = "网格已更新。";
      render(); renderBlastSetup();
    } catch (error) { status.textContent = blastErrorText(error.message); }
    finally { calculationWorkflowRunning = false; event.target.disabled = false; }
  });
}

function renderBlastSetup() {
  if (currentPageKey() !== "blast") return;
  syncBlastBoundaryControls();
  syncBlastFractureControls();
  if(typeof syncBlastCompatibility==='function')syncBlastCompatibility();
  document.getElementById("blastModelName").textContent = scene.name || "未命名模型";
  document.getElementById("blastNodeCount").textContent = scene.analysisNodes.length.toLocaleString();
  document.getElementById("blastElementCount").textContent = (scene.mesh?.elements?.length || 0).toLocaleString();
  document.getElementById("blastMeshReuseStatus").textContent = blastMeshReuseMessage();
  const wallRadius=Number(document.getElementById("blastCavityRadius").value), chargeRadius=Number(document.getElementById("blastRadius").value);
  document.getElementById("blastAirGap").textContent=wallRadius>0 && chargeRadius>wallRadius*(1+1e-8)
    ? blastCavityText("装药半径大于实际炮孔半径，请减小装药半径。") : wallRadius>0 && chargeRadius>0
    ? `${blastCavityText("径向空气间隙：")}${blastCavityNumber(Math.max(0,wallRadius-chargeRadius))} m`
    : blastCavityText("实际孔壁将在识别或运行时读取；装药半径可小于炮孔半径。");
  const canvas = document.getElementById("blastPreview"), rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1, w = rect.width, h = rect.height;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const context = canvas.getContext("2d"); context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = "#f2f7f9"; context.fillRect(0, 0, w, h);
  const curves = scene.curves.filter(curve => !curve.construction).map(curve => ({ curve, points: sampleCurve(curve) }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { points } of curves) for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  if (!Number.isFinite(minX)) {
    context.fillStyle = "#718494"; context.font = "13px Microsoft YaHei"; context.textAlign = "center";
    context.fillText("请先在结构绘制页创建或导入模型", w / 2, h / 2); return;
  }
  const scale = Math.min((w - 60) / Math.max(maxX - minX, .001), (h - 60) / Math.max(maxY - minY, .001));
  const project = p => ({ x: w / 2 + (p.x - (minX + maxX) / 2) * scale, y: h / 2 - (p.y - (minY + maxY) / 2) * scale });
  for (const region of [...scene.regions].sort((a, b) => b.area - a.area)) {
    if (!region.polygon?.length) continue;
    context.beginPath();
    region.polygon.forEach((p, i) => { const q = project(p); if (i) context.lineTo(q.x, q.y); else context.moveTo(q.x, q.y); });
    context.closePath();
    context.fillStyle = isAirRegion(region) ? "#f2f7f9" : region.materialColor || region.fillColor || "#e1eef0"; context.fill();
  }
  for (const { curve, points } of curves) {
    context.strokeStyle = "#407784"; context.lineWidth = 1.7; context.beginPath();
    points.forEach((p, i) => { const q = project(p); if (i) context.lineTo(q.x, q.y); else context.moveTo(q.x, q.y); }); context.stroke();
    const middle = points[Math.floor(points.length / 2)];
    const first = points[0], last = points[points.length - 1];
    if (middle && first && last && Math.hypot(last.x - first.x, last.y - first.y) * scale > 35) {
      const q = project(middle); context.fillStyle = "#57707a"; context.font = "11px Segoe UI"; context.fillText(curve.id, q.x + 5, q.y - 5);
    }
  }
  try { drawTntSource(context, project, readBlastControls()); } catch { /* Keep the geometry visible while editing an incomplete value. */ }
}
