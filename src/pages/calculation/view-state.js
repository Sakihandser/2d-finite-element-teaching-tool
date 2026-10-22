// 将计算页视窗适配到当前结构和已有计算数据。
function fitCalculationViewToScene() {
  if (!calculationCtx) return;
  const points = calculationSceneBoundsPoints();
  if (!points.length) {
    calculationView.scale = 48;
    calculationView.offsetX = calculationView.width / 2;
    calculationView.offsetY = calculationView.height / 2;
    updateCalculationPanel();
    renderCalculationView();
    return;
  }
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const padding = 90;
  const width = Math.max(maxX - minX, 1e-9);
  const height = Math.max(maxY - minY, 1e-9);
  calculationView.scale = clamp(Math.min((calculationView.width - padding * 2) / width, (calculationView.height - padding * 2) / height), 1e-4, 1e7);
  const center = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
  calculationView.offsetX = calculationView.width / 2 - center.x * calculationView.scale;
  calculationView.offsetY = calculationView.height / 2 + center.y * calculationView.scale;
  updateCalculationPanel();
  renderCalculationView();
}

// 计算视图的包围盒点集。显示上不画几何节点，但视窗适配可以用它们兜底定位结构。
function calculationSceneBoundsPoints() {
  const points = [];
  for (const region of scene.regions || []) {
    if (!isAirRegion(region)) {
      points.push(...(region.polygon || []));
    }
  }
  for (const curve of scene.curves || []) {
    points.push(...sampleCurve(curve, curve.type === "line" ? 1 : 20));
  }
  for (const node of scene.analysisNodes || []) {
    points.push(node);
  }
  for (const load of scene.pointLoads || []) {
    const anchor = calculationPointLoadAnchor(load);
    if (anchor) {
      points.push(anchor);
    }
  }
  for (const load of scene.bodyLoads || []) {
    points.push(...bodyForceDisplayAnchors(load));
  }
  if (!points.length) {
    for (const node of scene.geometryNodes || []) {
      points.push(node);
    }
  }
  return points.filter(isFinitePoint);
}

// 对外暴露计算视图状态，方便后续网格模块记住缩放、平移和图层。
function getCalculationViewState() {
  return {
    ...calculationView,
    activeTool: activeCalculationTool,
    layers: { ...calculationLayers },
    animationRunning: calculationAnimation.running,
  };
}

// 从外部恢复计算视图状态；无效值会被忽略，避免破坏当前视图。
function setCalculationViewState(next = {}) {
  if (Number.isFinite(Number(next.scale))) {
    calculationView.scale = clamp(Number(next.scale), 1e-4, 1e7);
  }
  if (Number.isFinite(Number(next.offsetX))) {
    calculationView.offsetX = Number(next.offsetX);
  }
  if (Number.isFinite(Number(next.offsetY))) {
    calculationView.offsetY = Number(next.offsetY);
  }
  if (next.layers && typeof next.layers === "object") {
    for (const [layer, visible] of Object.entries(next.layers)) {
      setCalculationLayer(layer, visible, false);
    }
  }
  updateCalculationPanel();
  renderCalculationView();
  return getCalculationViewState();
}

// 切换计算页图层显示，供复选框和未来外部模块共同使用。
function setCalculationLayer(layer, visible, shouldRender = true) {
  if (!Object.prototype.hasOwnProperty.call(calculationLayers, layer)) {
    return false;
  }
  calculationLayers[layer] = Boolean(visible);
  calculationLayerToggles.forEach((toggle) => {
    if (toggle.dataset.calculationLayer === layer) {
      toggle.checked = calculationLayers[layer];
    }
  });
  if (shouldRender) {
    renderCalculationView();
  }
  return true;
}
