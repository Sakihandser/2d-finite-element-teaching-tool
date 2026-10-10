// 根据容器尺寸和设备像素比调整 canvas，保持绘制清晰。
function resizeCanvas() {
  const rect = wrap.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  // 先记录旧视图中心对应的世界坐标，窗口变化后尽量保持观察位置不跳动。
  const previousCenter = screenToWorld({ x: view.width / 2, y: view.height / 2 });
  dpr = window.devicePixelRatio || 1;
  view.width = Math.max(320, rect.width);
  view.height = Math.max(240, rect.height);
  canvas.width = Math.floor(view.width * dpr);
  canvas.height = Math.floor(view.height * dpr);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  view.offsetX = view.width / 2 - previousCenter.x * view.scale;
  view.offsetY = view.height / 2 + previousCenter.y * view.scale;
  render();
}

// 根据计算页容器尺寸调整计算 canvas；它使用独立视图，和绘图页互不抢状态。
function resizeCalculationCanvas() {
  if (!calculationCanvas || !calculationWrap || !calculationCtx) return;
  const rect = calculationWrap.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  const previousCenter = calculationScreenToWorld({
    x: calculationView.width / 2,
    y: calculationView.height / 2,
  });
  calculationDpr = window.devicePixelRatio || 1;
  calculationView.width = Math.max(320, rect.width);
  calculationView.height = Math.max(240, rect.height);
  calculationCanvas.width = Math.floor(calculationView.width * calculationDpr);
  calculationCanvas.height = Math.floor(calculationView.height * calculationDpr);
  calculationCanvas.style.width = `${calculationView.width}px`;
  calculationCanvas.style.height = `${calculationView.height}px`;
  calculationView.offsetX = calculationView.width / 2 - previousCenter.x * calculationView.scale;
  calculationView.offsetY = calculationView.height / 2 + previousCenter.y * calculationView.scale;
  updateCalculationPanel();
  renderCalculationView();
}

// 根据结果页容器尺寸调整结果 canvas。结果页使用第三套独立视图变换。
function resizeResultCanvas() {
  if (!resultCanvas || !resultWrap || !resultCtx) return;
  const rect = resultWrap.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  const previousCenter = resultScreenToWorld({
    x: resultView.width / 2,
    y: resultView.height / 2,
  });
  resultDpr = window.devicePixelRatio || 1;
  resultView.width = Math.max(320, rect.width);
  resultView.height = Math.max(240, rect.height);
  resultCanvas.width = Math.floor(resultView.width * resultDpr);
  resultCanvas.height = Math.floor(resultView.height * resultDpr);
  resultCanvas.style.width = `${resultView.width}px`;
  resultCanvas.style.height = `${resultView.height}px`;
  resultView.offsetX = resultView.width / 2 - previousCenter.x * resultView.scale;
  resultView.offsetY = resultView.height / 2 + previousCenter.y * resultView.scale;
  updateResultPanel();
  renderResultView();
}

// 屏幕坐标转世界坐标，世界坐标采用普通数学坐标系，y 轴向上。
function screenToWorld(point) {
  return {
    x: (point.x - view.offsetX) / view.scale,
    y: (view.offsetY - point.y) / view.scale,
  };
}

// 世界坐标转屏幕坐标，屏幕坐标 y 轴向下，因此这里要反向。
function worldToScreen(point) {
  return {
    x: view.offsetX + point.x * view.scale,
    y: view.offsetY - point.y * view.scale,
  };
}

// 计算页屏幕坐标转世界坐标，供后续计算节点布置和网格交互复用。
function calculationScreenToWorld(point) {
  return {
    x: (point.x - calculationView.offsetX) / calculationView.scale,
    y: (calculationView.offsetY - point.y) / calculationView.scale,
  };
}

// 计算页世界坐标转屏幕坐标；目前用于只读结构预览，后续也用于计算节点/变形显示。
function calculationWorldToScreen(point) {
  return {
    x: calculationView.offsetX + point.x * calculationView.scale,
    y: calculationView.offsetY - point.y * calculationView.scale,
  };
}

// 结果页屏幕坐标转世界坐标。
function resultScreenToWorld(point) {
  return {
    x: (point.x - resultView.offsetX) / resultView.scale,
    y: (resultView.offsetY - point.y) / resultView.scale,
  };
}

// 结果页世界坐标转屏幕坐标。
function resultWorldToScreen(point) {
  return {
    x: resultView.offsetX + point.x * resultView.scale,
    y: resultView.offsetY - point.y * resultView.scale,
  };
}

// 从鼠标/触控事件中取得相对 canvas 左上角的屏幕坐标。
function pointerPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

// 取得鼠标在计算 canvas 内的屏幕坐标。
function calculationPointerPoint(event) {
  const rect = calculationCanvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

// 取得鼠标在结果 canvas 内的屏幕坐标。
function resultPointerPoint(event) {
  const rect = resultCanvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

// 启用吸附网格时，优先吸附附近已有几何节点；没有节点命中时再吸附到当前网格步长的一半。
function snapWorld(point, options = {}) {
  if (!snapToggle.checked) {
    return point;
  }
  const node = nearestGeometryNodeForSnap(point, options);
  if (node) {
    return {
      x: node.x,
      y: node.y,
    };
  }
  const step = gridStepForScale(view.scale) / 2;
  return {
    x: Math.round(point.x / step) * step,
    y: Math.round(point.y / step) * step,
  };
}

// 按屏幕像素距离查找可吸附的几何节点；拖动节点时可排除自身，避免一开始就被自己粘住。
function nearestGeometryNodeForSnap(point, options = {}) {
  const screen = worldToScreen(point);
  let best = null;
  let bestDistance = options.snapPx ?? GEOMETRY_NODE_SNAP_PX;
  for (const node of scene.geometryNodes || []) {
    if (node.id === options.excludeGeometryNodeId) continue;
    const nodeScreen = worldToScreen(node);
    const distancePx = Math.hypot(nodeScreen.x - screen.x, nodeScreen.y - screen.y);
    if (distancePx < bestDistance) {
      best = node;
      bestDistance = distancePx;
    }
  }
  return best;
}

// 把任意步长规整成 1/2/5/10 这样的工程绘图常用刻度。
function niceStep(raw) {
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

// 根据当前缩放比例计算合适的网格间距。
function gridStepForScale(scale) {
  return niceStep(56 / scale);
}
