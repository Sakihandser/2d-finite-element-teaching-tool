/*
  应用入口脚本。
  只负责注册事件、启动各页初始化，并把稳定 API 暴露给后续网格和求解模块。
  具体功能按“全局 -> 核心 -> 标签页 -> 页面内功能”拆分在 src/ 目录中。
*/

// 统一注册所有 DOM 事件监听。
function wireEvents() {
  wireShapeEditor();
  pageTabs.forEach((button) => button.addEventListener("click", () => setPage(button.dataset.pageTab)));
  toolButtons.forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  loadDirectionButtons.forEach((button) => button.addEventListener("click", () => setLoadDirectionMode(button.dataset.loadMode)));
  bodyForceScopeButtons.forEach((button) => button.addEventListener("click", () => setBodyForceScope(button.dataset.bodyForceScope)));
  calculationToolButtons.forEach((button) => button.addEventListener("click", () => handleCalculationToolClick(button.dataset.calculationTool)));
  generateCalculationTextFiles?.addEventListener("change", saveCalculationTextFilePreference);
  document.getElementById("adaptiveMeshEnabled")?.addEventListener("change", onAdaptiveMeshChange);
  document.getElementById("useGpuAcceleration")?.addEventListener("change", onGpuAccelerationChange);
  syncAdaptiveMeshControls();
  resultViewButtons.forEach((button) => button.addEventListener("click", () => setResultView(button.dataset.resultView)));
  geometryStateButtons.forEach((button) => button.addEventListener("click", () => applySelectedGeometryState(button.dataset.geometryState)));
  selectedLoadMagnitude.addEventListener("input", applySelectedLoadEditor);
  selectedLoadEndMagnitude?.addEventListener("input", applySelectedLoadEditor);
  selectedLoadAngle.addEventListener("input", applySelectedLoadEditor);
  materialUi.form.addEventListener("submit", saveMaterialFromForm);
  materialUi.newButton.addEventListener("click", resetMaterialForm);
  materialUi.color.addEventListener("input", () => applyMaterialColor(materialUi.color.value));
  materialUi.searchEngine?.addEventListener("change", saveSearchEnginePreference);
  materialUi.openSearch.addEventListener("click", openMaterialBrowserSearch);
  materialUi.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      openMaterialBrowserSearch();
    }
  });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("contextmenu", onCanvasContextMenu);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  if (calculationCanvas) {
    calculationCanvas.addEventListener("pointerdown", onCalculationPointerDown);
    calculationCanvas.addEventListener("pointermove", onCalculationPointerMove);
    calculationCanvas.addEventListener("pointerup", onCalculationPointerUp);
    calculationCanvas.addEventListener("pointercancel", onCalculationPointerUp);
    calculationCanvas.addEventListener("contextmenu", onCalculationContextMenu);
    calculationCanvas.addEventListener("wheel", onCalculationWheel, { passive: false });
  }
  if (resultCanvas) {
    resultCanvas.addEventListener("pointerdown", onResultPointerDown);
    resultCanvas.addEventListener("pointermove", onResultPointerMove);
    resultCanvas.addEventListener("pointerup", onResultPointerUp);
    resultCanvas.addEventListener("pointercancel", onResultPointerUp);
    resultCanvas.addEventListener("contextmenu", onResultContextMenu);
    resultCanvas.addEventListener("wheel", onResultWheel, { passive: false });
  }
  regionMaterialMenu?.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.addEventListener("pointerdown", (event) => {
    if (!regionMaterialMenu?.hidden && !regionMaterialMenu.contains(event.target) && event.target !== canvas) {
      hideRegionMaterialMenu();
    }
  });
  window.addEventListener("resize", () => {
    if (currentPageKey() === "calculation") {
      resizeCalculationCanvas();
    } else if (currentPageKey() === "results") {
      resizeResultCanvas();
    } else if (currentPageKey() === "home") {
      resizeCanvas();
    }
  });
  document.getElementById("fitView").addEventListener("click", fitViewToScene);
  document.getElementById("fitCalculationView")?.addEventListener("click", fitCalculationViewToScene);
  fitResultView?.addEventListener("click", () => fitResultViewToData(true));
  reloadCalculationResult?.addEventListener("click", () => {
    loadCalculationResultsFromProjectFolder().catch((error) => {
      console.error(error);
      setResultStatus("读取结果失败");
    });
  });
  animationButton.addEventListener("click", toggleAnimation);
  calculationAnimationButton?.addEventListener("click", toggleCalculationAnimation);
  animationScale?.addEventListener("input", () => render());
  calculationDeformationScale?.addEventListener("input", () => renderCalculationView());
  resultDeformationScale?.addEventListener("input", handleResultDeformationScaleInput);
  document.getElementById("saveScene").addEventListener("click", exportScene);
  document.getElementById("exportCalculationInput")?.addEventListener("click", () => {
    exportCalculationInputFile().catch(handleCalculationExportError);
  });
  document.getElementById("openScene").addEventListener("click", () => fileInput.click());
  document.getElementById("clearScene").addEventListener("click", clearScene);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) importScene(file);
    fileInput.value = "";
  });
  modelName.addEventListener("input", () => {
    scene.name = modelName.value;
    updateCalculationPanel();
  });
  document.querySelectorAll(".layer-toggle").forEach((toggle) => {
    toggle.addEventListener("change", () => {
      layers[toggle.dataset.layer] = toggle.checked;
      render();
    });
  });
  calculationLayerToggles.forEach((toggle) => {
    toggle.addEventListener("change", () => {
      setCalculationLayer(toggle.dataset.calculationLayer, toggle.checked);
    });
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeShapeEditor();
      draft = null;
      interaction = null;
      calculationInteraction = null;
      resultInteraction = null;
      calculationCanvas?.classList.remove("panning");
      resultCanvas?.classList.remove("panning");
      hideRegionMaterialMenu();
      render();
      renderCalculationView();
      renderResultView();
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (currentPageKey() === "home" && !shapeDialog.open && tag !== "input" && tag !== "textarea" && tag !== "select") {
        deleteSelected();
      }
    }
  });
}

const CALCULATION_TEXT_FILE_PREFERENCE_KEY = "fem-generate-calculation-text-files";

function loadCalculationTextFilePreference() {
  if (!generateCalculationTextFiles) return;
  try {
    generateCalculationTextFiles.checked = window.localStorage.getItem(CALCULATION_TEXT_FILE_PREFERENCE_KEY) === "true";
  } catch (error) {
    generateCalculationTextFiles.checked = false;
  }
}

function saveCalculationTextFilePreference() {
  try {
    window.localStorage.setItem(CALCULATION_TEXT_FILE_PREFERENCE_KEY, generateCalculationTextFiles?.checked ? "true" : "false");
  } catch (error) {
    // localStorage 不可用时仍保留本次页面中的选择。
  }
}

// 页面启动流程：绑定事件、初始化画布尺寸、回到默认视图并刷新面板。
loadCalculationTextFilePreference();
wireEvents();
initializeMaterialLibrary();
resizeCanvas();
fitViewToScene();
updatePanel();

// 对后续网格/求解模块暴露最小 API，避免外部代码直接依赖内部变量名。
window.femSketchApi = {
  getScene: () => scene,
  buildRegularShape,
  createRegularShape,
  openShapeEditor,
  getRegionAtPoint: getStructureRegionAtPoint,
  getRegionsAtPoint: getStructureRegionsAtPoint,
  getGeometryStateAtPoint,
  getMechanicalStateAtPoint: getGeometryStateAtPoint,
  getStructureRegionAtPoint,
  getStructureRegionsAtPoint,
  getMaterialAtPoint,
  classifyAnalysisNode,
  classifyAnalysisNodes,
  classifyAnalysisElement,
  classifyAnalysisElements,
  prepareCalculationModelData,
  buildAutomaticAnalysisNodePlacement,
  autoPlaceAnalysisNodes,
  buildAutomaticAnalysisMesh,
  autoGenerateAnalysisMesh,
  buildCalculationInputExport,
  buildCalculationInputText,
  calculationInputPayloadToDirectModel,
  exportCalculationInputFile,
  saveCalculationInputToProjectFolder,
  startCalculationWorkflow,
  loadCalculationResultsFromProjectFolder,
  loadCalculationResultsFromText,
  loadCalculationResultsFromData,
  renderResultView,
  fitResultViewToData,
  setResultView,
  createAnalysisNode,
  setAnalysisMesh,
  renderCalculationView,
  fitCalculationViewToScene,
  getCalculationViewState,
  setCalculationViewState,
  setCalculationLayer,
  setCalculationTool,
  calculationWorldToScreen,
  calculationScreenToWorld,
  detectCurveIntersections,
  syncIntersectionGeometryNodes,
  rebuildClosedRegions: () => {
    rebuildDerivedRegions();
    updatePanel();
    render();
    return scene.regions;
  },
  assignMaterialToRegion,
  setRegionKind,
  normalizeRegionKind,
  normalizeMechanicalState,
  defaultClassificationTolerance: DEFAULT_CLASSIFICATION_TOLERANCE,
};

// Keep a direct link to the training dashboard useful across page refreshes.
if (window.location?.hash === "#training") setPage("training");
