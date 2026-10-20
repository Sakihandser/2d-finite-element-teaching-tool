// 计算页主渲染函数：只显示计算前处理需要的简洁结构视图。
function renderCalculationView(timestamp = 0) {
  if (!calculationCtx || calculationView.width <= 0 || calculationView.height <= 0) return;
  if (timestamp) {
    calculationAnimation.time = timestamp / 1000;
  }
  calculationCtx.setTransform(calculationDpr, 0, 0, calculationDpr, 0, 0);
  calculationCtx.clearRect(0, 0, calculationView.width, calculationView.height);
  drawCalculationGrid();
  if (calculationLayers.structure) {
    drawCalculationRegions();
    drawCalculationAirRegions();
    drawCalculationBoundaries();
  }
  if (calculationLayers.mesh) {
    drawCalculationMesh(false);
  }
  if (calculationAnimation.running && calculationLayers.deformation) {
    drawCalculationDeformationLayer();
  }
  if (calculationLayers.analysisNodes) {
    drawCalculationAnalysisNodes();
  }
  if (calculationLayers.loads) {
    drawCalculationLoads();
  }
  updateCalculationPanel();
  scheduleCalculationAnimationFrame();
}

// 安排计算页下一帧动画，使用 frame 空值防止重复挂多个 requestAnimationFrame。
function scheduleCalculationAnimationFrame() {
  if (!calculationAnimation.running || calculationAnimation.frame || currentPageKey() !== "calculation") return;
  calculationAnimation.frame = requestAnimationFrame((timestamp) => {
    calculationAnimation.frame = null;
    renderCalculationView(timestamp);
  });
}

// 取消计算页动画帧；离开计算页或关闭动画时调用。
function cancelCalculationAnimationFrame() {
  if (calculationAnimation.frame) {
    cancelAnimationFrame(calculationAnimation.frame);
    calculationAnimation.frame = null;
  }
}

// 计算页背景网格和坐标轴，使用 calculationView 的独立缩放/平移。
function drawCalculationGrid() {
  calculationCtx.save();
  calculationCtx.fillStyle = COLORS.canvasBackground;
  calculationCtx.fillRect(0, 0, calculationView.width, calculationView.height);

  const step = gridStepForScale(calculationView.scale);
  const startWorld = calculationScreenToWorld({ x: 0, y: calculationView.height });
  const endWorld = calculationScreenToWorld({ x: calculationView.width, y: 0 });
  const x0 = Math.floor(startWorld.x / step) * step;
  const x1 = Math.ceil(endWorld.x / step) * step;
  const y0 = Math.floor(startWorld.y / step) * step;
  const y1 = Math.ceil(endWorld.y / step) * step;

  calculationCtx.lineWidth = 1;
  calculationCtx.font = "11px Segoe UI, Arial, sans-serif";
  calculationCtx.fillStyle = "#6a7683";

  for (let x = x0; x <= x1; x += step) {
    const p = calculationWorldToScreen({ x, y: 0 });
    const major = isMajorGridLine(x, step);
    calculationCtx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid;
    drawCalculationLineScreen({ x: p.x, y: 0 }, { x: p.x, y: calculationView.height });
    if (major && Math.abs(x) > 1e-9 && p.x > 4 && p.x < calculationView.width - 28) {
      calculationCtx.fillText(formatNumber(x), p.x + 3, clamp(calculationView.offsetY + 13, 16, calculationView.height - 8));
    }
  }

  for (let y = y0; y <= y1; y += step) {
    const p = calculationWorldToScreen({ x: 0, y });
    const major = isMajorGridLine(y, step);
    calculationCtx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid;
    drawCalculationLineScreen({ x: 0, y: p.y }, { x: calculationView.width, y: p.y });
    if (major && Math.abs(y) > 1e-9 && p.y > 12 && p.y < calculationView.height - 4) {
      calculationCtx.fillText(formatNumber(y), clamp(calculationView.offsetX + 6, 6, calculationView.width - 40), p.y - 4);
    }
  }

  calculationCtx.strokeStyle = COLORS.axis;
  calculationCtx.lineWidth = 1.5;
  const origin = calculationWorldToScreen({ x: 0, y: 0 });
  drawCalculationLineScreen({ x: 0, y: origin.y }, { x: calculationView.width, y: origin.y });
  drawCalculationLineScreen({ x: origin.x, y: 0 }, { x: origin.x, y: calculationView.height });
  drawCalculationArrowHeadScreen({ x: calculationView.width - 15, y: origin.y }, { x: calculationView.width - 3, y: origin.y }, COLORS.axis);
  drawCalculationArrowHeadScreen({ x: origin.x, y: 15 }, { x: origin.x, y: 3 }, COLORS.axis);
  calculationCtx.fillStyle = COLORS.axis;
  calculationCtx.font = "600 12px Segoe UI, Arial, sans-serif";
  calculationCtx.fillText("x", calculationView.width - 18, clamp(origin.y - 8, 14, calculationView.height - 8));
  calculationCtx.fillText("y", clamp(origin.x + 8, 8, calculationView.width - 18), 18);
  calculationCtx.restore();
}

// 计算页结构区域只画材料颜色，不画区域编号、材料文字和几何节点。
function drawCalculationRegions() {
  const regions = (scene.regions || [])
    .filter((region) => !isAirRegion(region) && Array.isArray(region.polygon) && region.polygon.length >= 3)
    .sort((a, b) => b.area - a.area);
  for (const region of regions) {
    drawCalculationRegion(region);
  }
}

// 计算页也要绘制空气区域遮罩，否则嵌在结构内部的空气会被外层材料色覆盖。
function drawCalculationAirRegions() {
  const regions = (scene.regions || [])
    .filter((region) => isAirRegion(region) && Array.isArray(region.polygon) && region.polygon.length >= 3)
    .sort((a, b) => b.area - a.area);
  for (const region of regions) {
    drawCalculationAirRegion(region);
  }
}

// 空气区域只作为留白遮罩，不显示材料文字和区域编号；边界线仍由后续边界骨架统一绘制。
function drawCalculationAirRegion(region) {
  calculationCtx.save();
  drawCalculationRegionPath(region.polygon);
  calculationCtx.fillStyle = COLORS.airRegion;
  calculationCtx.fill();
  calculationCtx.restore();
}

// 绘制计算页单个结构区域；材料色来自材料库或区域快照。
function drawCalculationRegion(region) {
  const material = materialSnapshotForRegion(region);
  const color = material?.color || region.fillColor || regionDefaultColor(region.id);
  calculationCtx.save();
  drawCalculationRegionPath(region.polygon);
  calculationCtx.fillStyle = hexToRgba(color, material ? 0.42 : 0.2);
  calculationCtx.fill();
  calculationCtx.strokeStyle = hexToRgba(color, 0.72);
  calculationCtx.lineWidth = 1.2;
  calculationCtx.stroke();
  calculationCtx.restore();
}

// 把计算页区域多边形转换成 canvas 路径。
function drawCalculationRegionPath(points) {
  calculationCtx.beginPath();
  points.forEach((point, index) => {
    const screen = calculationWorldToScreen(point);
    if (index === 0) calculationCtx.moveTo(screen.x, screen.y);
    else calculationCtx.lineTo(screen.x, screen.y);
  });
  calculationCtx.closePath();
}

// 绘制计算页边界骨架：保留边界形状，不显示几何端点、控制点和编号。
function drawCalculationBoundaries() {
  for (const curve of scene.curves || []) {
    if (curve.construction) continue;
    const isStatic = normalizeMechanicalState(curve.mechanicalState) === "static";
    drawCalculationCurve(curve, {
      color: calculationBoundaryColor(curve, isStatic),
      width: isStatic ? 2.4 : 2,
    });
  }
}

// 计算页边界颜色优先跟随相邻结构区域的材料色，没有材料时再回退到边界状态色。
function calculationBoundaryColor(curve, isStatic) {
  const adjacentRegions = (scene.regions || [])
    .filter((region) => !isAirRegion(region) && (region.boundaryCurveIds || []).includes(curve.id))
    .sort((a, b) => a.area - b.area);
  const region = adjacentRegions[0];
  const material = materialSnapshotForRegion(region);
  return material?.color || region?.fillColor || (isStatic ? COLORS.static : COLORS.curve);
}

// 计算页曲线绘制，复用几何曲线采样但使用 calculationView 转换坐标。
function drawCalculationCurve(curve, options = {}) {
  const points = sampleCurve(curve, curve.type === "line" ? 1 : 64);
  calculationCtx.save();
  calculationCtx.strokeStyle = options.color || COLORS.curve;
  calculationCtx.lineWidth = options.width || 2;
  calculationCtx.lineCap = "round";
  calculationCtx.lineJoin = "round";
  calculationCtx.beginPath();
  points.forEach((point, index) => {
    const screen = calculationWorldToScreen(point);
    if (index === 0) calculationCtx.moveTo(screen.x, screen.y);
    else calculationCtx.lineTo(screen.x, screen.y);
  });
  calculationCtx.stroke();
  calculationCtx.restore();
}

// 绘制计算网格。自动网格和外部网格器都通过 analysisNodes/mesh 这条通道显示。
function drawCalculationMesh(deformed = false) {
  if (!scene.analysisNodes?.length || !scene.mesh?.elements?.length) return;
  const factor = deformed ? readNumber(calculationDeformationScale, 1) * (0.5 + 0.5 * Math.sin(calculationAnimation.time * 2)) : 0;
  if (drawGpuSceneMesh(calculationCtx, calculationView, calculationDpr, {
    factor, stroke: deformed ? [0, 124 / 255, 137 / 255, 0.35 * 0.78] : gpuColor(COLORS.mesh, 0.5),
    lineWidth: deformed ? 1.6 : 1, dashed: deformed,
  })) return;
  calculationCtx.save();
  calculationCtx.strokeStyle = deformed ? COLORS.ghost : COLORS.mesh;
  calculationCtx.globalAlpha = deformed ? 0.78 : 0.5;
  calculationCtx.lineWidth = deformed ? 1.6 : 1;
  calculationCtx.setLineDash(deformed ? [7, 6] : []);
  for (const element of scene.mesh.elements) {
    const analysisNodes = elementNodeRefs(element).map((ref) => analysisNodeByRef(ref)).filter(Boolean);
    if (analysisNodes.length < 2) continue;
    calculationCtx.beginPath();
    analysisNodes.forEach((node, index) => {
      const point = calculationAnalysisNodePosition(node, deformed);
      const screen = calculationWorldToScreen(point);
      if (index === 0) calculationCtx.moveTo(screen.x, screen.y);
      else calculationCtx.lineTo(screen.x, screen.y);
    });
    if (analysisNodes.length > 2) {
      calculationCtx.closePath();
    }
    calculationCtx.stroke();
  }
  calculationCtx.restore();
}

// 计算节点只显示小点不显示编号，避免和几何建模节点混淆。
function drawCalculationAnalysisNodes() {
  if (!scene.analysisNodes?.length) return;
  if (drawGpuAnalysisNodes()) return;
  calculationCtx.save();
  for (const node of scene.analysisNodes) {
    const point = calculationAnalysisNodePosition(node, false);
    const screen = calculationWorldToScreen(point);
    calculationCtx.fillStyle = normalizeMechanicalState(node.mechanicalState) === "static" ? COLORS.static : COLORS.selected;
    calculationCtx.beginPath();
    calculationCtx.arc(screen.x, screen.y, 3, 0, Math.PI * 2);
    calculationCtx.fill();
  }
  calculationCtx.restore();
}

// 计算页载荷层：显示求解输入中的点载荷和分布力，但不显示绘图页的选择状态。
function drawCalculationLoads() {
  for (const load of scene.pointLoads || []) {
    drawCalculationPointLoad(load);
  }
  for (const load of scene.distributedLoads || []) {
    drawCalculationDistributedLoad(load);
  }
  for (const load of scene.bodyLoads || []) {
    drawCalculationBodyForceLoad(load);
  }
}

// 计算页点载荷锚点读取；绑定几何节点的载荷会跟随最新节点位置。
function calculationPointLoadAnchor(load) {
  if (load?.geometryNodeId) {
    const node = geometryNodeById(load.geometryNodeId);
    if (node) {
      return { x: node.x, y: node.y };
    }
  }
  return isFinitePoint(load?.anchor) ? load.anchor : null;
}

// 绘制计算页点载荷箭头和大小标签。
function drawCalculationPointLoad(load) {
  const anchor = calculationPointLoadAnchor(load);
  if (!anchor) return;
  const start = calculationWorldToScreen(anchor);
  const unit = normalize({ x: load.fx, y: load.fy }, { x: 0, y: -1 });
  const screenDir = normalize({ x: unit.x, y: -unit.y });
  const magnitude = Math.hypot(Number(load.fx) || 0, Number(load.fy) || 0);
  const length = clamp(magnitude * 4, 34, 84);
  const end = {
    x: start.x + screenDir.x * length,
    y: start.y + screenDir.y * length,
  };
  drawCalculationArrowScreen(start, end, COLORS.force, 2.2);
  calculationCtx.save();
  calculationCtx.fillStyle = COLORS.force;
  calculationCtx.font = "600 12px Segoe UI, Arial, sans-serif";
  calculationCtx.fillText(`${load.label || "F"}=${formatNumber(magnitude)}`, end.x + 6, end.y - 6);
  calculationCtx.restore();
}

// 绘制计算页分布力；箭头沿几何边界均匀布置，后续等效节点载荷可复用这个入口扩展。
function drawCalculationDistributedLoad(load) {
  const curve = curveById(load.curveId);
  if (!curve) return;
  const direction = normalize(load.direction, { x: 0, y: -1 });
  const screenDir = normalize({ x: direction.x, y: -direction.y });
  const startT = clamp(Number(load.start ?? 0), 0, 1);
  const endT = clamp(Number(load.end ?? 1), 0, 1);
  const maxDisplayLength = distributedLoadMaxDisplayLength(load);
  const count = 7;
  calculationCtx.save();
  calculationCtx.fillStyle = COLORS.load;
  calculationCtx.strokeStyle = COLORS.load;
  calculationCtx.lineWidth = 1.9;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const curveT = lerp(startT, endT, t);
    const point = pointOnCurve(curve, curveT);
    const start = calculationWorldToScreen(point);
    const length = distributedLoadDisplayLengthAt(load, curveT);
    if (length < 1) continue;
    const end = {
      x: start.x + screenDir.x * length,
      y: start.y + screenDir.y * length,
    };
    drawCalculationArrowScreen(start, end, COLORS.load, 1.9);
  }
  const mid = calculationWorldToScreen(pointOnCurve(curve, lerp(startT, endT, 0.5)));
  const labelOffset = maxDisplayLength + 8;
  calculationCtx.font = "600 12px Segoe UI, Arial, sans-serif";
  calculationCtx.fillText(
    `${load.label || "q"}=${formatNumber(distributedLoadStartMagnitude(load))}→${formatNumber(distributedLoadEndMagnitude(load))}`,
    mid.x + screenDir.x * labelOffset,
    mid.y + screenDir.y * labelOffset,
  );
  calculationCtx.restore();
}

// 绘制计算页体力；等效节点载荷会在导出阶段按单元面积和材料密度折算。
function drawCalculationBodyForceLoad(load) {
  const anchors = bodyForceDisplayAnchors(load);
  if (!anchors.length) return;
  const direction = normalize(load.direction, { x: 0, y: -1 });
  const screenDir = normalize({ x: direction.x, y: -direction.y });
  const length = clamp(bodyLoadMagnitude(load) * 5, 32, 74);
  calculationCtx.save();
  calculationCtx.fillStyle = COLORS.bodyLoad;
  calculationCtx.strokeStyle = COLORS.bodyLoad;
  calculationCtx.lineWidth = 1.9;
  anchors.forEach((anchor, index) => {
    const start = calculationWorldToScreen(anchor);
    const end = {
      x: start.x + screenDir.x * length,
      y: start.y + screenDir.y * length,
    };
    drawCalculationArrowScreen(start, end, COLORS.bodyLoad, 1.9);
    if (index === 0) {
      calculationCtx.font = "600 12px Segoe UI, Arial, sans-serif";
      calculationCtx.fillText(`${load.label || "g"}=${formatNumber(bodyLoadMagnitude(load))}`, end.x + 6, end.y - 6);
    }
  });
  calculationCtx.restore();
}

// 计算页变形层入口：已有 ux/uy 时绘制变形后的网格幽影，未来也可扩展为结构云图。
function drawCalculationDeformationLayer() {
  if (!hasCalculationDisplacement()) return;
  drawCalculationMesh(true);
}

// 根据计算节点位移得到显示位置；动画时用正弦系数表现往复变形。
function calculationAnalysisNodePosition(node, deformed = false) {
  if (!deformed) {
    return { x: node.x, y: node.y };
  }
  const scale = readNumber(calculationDeformationScale, 1);
  const ux = Number(node.ux) || 0;
  const uy = Number(node.uy) || 0;
  const phase = 0.5 + 0.5 * Math.sin(calculationAnimation.time * 2);
  return {
    x: node.x + ux * scale * phase,
    y: node.y + uy * scale * phase,
  };
}

// 判断当前计算节点是否已经带有位移结果。
function hasCalculationDisplacement() {
  return scene.analysisNodes.some((node) => Math.hypot(Number(node.ux) || 0, Number(node.uy) || 0) > 0);
}

// 计算页线段绘制工具。
function drawCalculationLineScreen(a, b) {
  calculationCtx.beginPath();
  calculationCtx.moveTo(a.x, a.y);
  calculationCtx.lineTo(b.x, b.y);
  calculationCtx.stroke();
}

// 计算页通用箭头绘制工具，坐标轴和载荷层都复用它。
function drawCalculationArrowScreen(start, end, color, width = 2) {
  calculationCtx.save();
  calculationCtx.strokeStyle = color;
  calculationCtx.fillStyle = color;
  calculationCtx.lineWidth = width;
  calculationCtx.lineCap = "round";
  drawCalculationLineScreen(start, end);
  drawCalculationArrowHeadScreen(start, end, color);
  calculationCtx.restore();
}

// 计算页箭头头部绘制工具，用于坐标轴和载荷箭头。
function drawCalculationArrowHeadScreen(start, end, color) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const size = 9;
  calculationCtx.save();
  calculationCtx.fillStyle = color;
  calculationCtx.beginPath();
  calculationCtx.moveTo(end.x, end.y);
  calculationCtx.lineTo(end.x - Math.cos(angle - Math.PI / 6) * size, end.y - Math.sin(angle - Math.PI / 6) * size);
  calculationCtx.lineTo(end.x - Math.cos(angle + Math.PI / 6) * size, end.y - Math.sin(angle + Math.PI / 6) * size);
  calculationCtx.closePath();
  calculationCtx.fill();
  calculationCtx.restore();
}
