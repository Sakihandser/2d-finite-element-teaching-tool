// 绘制自动识别出的结构区域和材料填充色。
function drawRegions() {
  if (!scene.regions?.length) return;
  const regions = [...scene.regions].sort((a, b) => b.area - a.area);
  for (const region of regions) {
    drawRegion(region);
  }
}

// 绘制单个区域：结构区域使用材料色透明填充，空气区域使用虚线浅色填充。
function drawRegion(region) {
  const polygon = Array.isArray(region.polygon) ? region.polygon : [];
  if (polygon.length < 3) return;
  const air = isAirRegion(region);
  const material = materialSnapshotForRegion(region);
  const color = air ? "#64748b" : material?.color || region.fillColor || regionDefaultColor(region.id);
  const isSelected = selected?.type === "region" && selected.id === region.id;
  const isHovered = hovered?.type === "region" && hovered.id === region.id;
  ctx.save();
  drawRegionPath(polygon);
  ctx.fillStyle = air ? COLORS.airRegion : hexToRgba(color, material ? 0.34 : 0.14);
  ctx.fill();
  ctx.lineWidth = isSelected ? 2.4 : isHovered ? 1.8 : 1.1;
  ctx.strokeStyle = isSelected ? COLORS.selected : isHovered ? COLORS.regionStroke : hexToRgba(color, 0.62);
  ctx.setLineDash(air || !material ? [8, 7] : []);
  ctx.stroke();
  ctx.restore();
  drawRegionLabel(region, material, color, isSelected);
}

// 把区域多边形顶点转换成 canvas 路径，供填充、描边和悬停高亮复用。
function drawRegionPath(points) {
  ctx.beginPath();
  points.forEach((point, index) => {
    const screen = worldToScreen(point);
    if (index === 0) ctx.moveTo(screen.x, screen.y);
    else ctx.lineTo(screen.x, screen.y);
  });
  ctx.closePath();
}

// 在区域质心绘制区域编号或材料名称，超出当前视窗时跳过以减少无效绘制。
function drawRegionLabel(region, material, color, isSelected) {
  const centroid = region.centroid;
  if (!centroid) return;
  const p = worldToScreen(centroid);
  if (p.x < -80 || p.x > view.width + 80 || p.y < -30 || p.y > view.height + 30) return;
  const label = isAirRegion(region) ? `${region.id} 空气` : material?.name ? `${region.id} ${uiText(material.name)}` : region.id;
  ctx.save();
  ctx.font = "700 12px Segoe UI, Arial, sans-serif";
  const width = Math.min(ctx.measureText(label).width + 16, 150);
  const height = 24;
  const x = p.x - width / 2;
  const y = p.y - height / 2;
  ctx.fillStyle = "rgba(255, 255, 255, 0.86)";
  ctx.strokeStyle = isSelected ? COLORS.selected : hexToRgba(color, 0.72);
  ctx.lineWidth = isSelected ? 1.6 : 1;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, width, height, 6);
  } else {
    ctx.rect(x, y, width, height);
  }
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COLORS.regionLabel;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, p.x, p.y, width - 10);
  ctx.restore();
}

// 十六进制颜色转 rgba 字符串，用于材料填充透明度。
function hexToRgba(color, alpha) {
  const value = normalizeColor(color).slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 绘制几何层；animated=true 时绘制变形后的虚线预览。
function drawGeometry(animated) {
  ctx.save();
  if (animated) {
    ctx.strokeStyle = COLORS.ghost;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 7]);
  }

  for (const curve of scene.curves) {
    const isSelected = isCurveSelection(curve.id);
    const isStatic = normalizeMechanicalState(curve.mechanicalState) === "static";
    drawCurve(curve, {
      animated,
      color: animated ? COLORS.ghost : isSelected ? COLORS.selected : isStatic ? COLORS.static : COLORS.curve,
      width: isSelected && !animated ? 3 : isStatic && !animated ? 2.6 : 2,
    });
    if (isStatic && !animated) {
      drawStaticBoundaryMarkers(curve, isSelected ? COLORS.selected : COLORS.static);
    }
  }

  if (!animated) {
    for (const node of scene.geometryNodes) {
      drawGeometryNode(node, selected?.type === "geometryNode" && selected.id === node.id);
    }
    drawSelectedControls();
  }

  ctx.restore();
}

// 根据曲线采样点绘制线段折线，适用于直线、贝塞尔和圆弧。
function drawCurve(curve, options = {}) {
  const points = sampleCurve(curve, curve.type === "line" ? 1 : 64, options.animated);
  ctx.save();
  ctx.strokeStyle = options.color || COLORS.curve;
  ctx.lineWidth = options.width || 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  points.forEach((point, index) => {
    const screen = worldToScreen(point);
    if (index === 0) ctx.moveTo(screen.x, screen.y);
    else ctx.lineTo(screen.x, screen.y);
  });
  ctx.stroke();
  ctx.restore();
}

// 绘制单个几何节点及其几何编号。
function drawGeometryNode(node, isSelected) {
  const p = worldToScreen(node);
  const isStatic = normalizeMechanicalState(node.mechanicalState) === "static";
  const strokeColor = isSelected ? COLORS.selected : isStatic ? COLORS.static : COLORS.node;
  ctx.save();
  if (isStatic) {
    drawStaticNodeSupport(p, strokeColor);
  }
  ctx.lineWidth = isSelected ? 2.5 : 1.8;
  ctx.fillStyle = COLORS.nodeFill;
  ctx.strokeStyle = strokeColor;
  ctx.beginPath();
  ctx.arc(p.x, p.y, NODE_R + (isSelected ? 1.5 : 0), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = strokeColor;
  ctx.font = "600 11px Segoe UI, Arial, sans-serif";
  ctx.fillText(node.id, p.x + 8, p.y - 8);
  ctx.restore();
}

// 绘制静态几何节点的小支座符号，表示该几何位置将作为固定/地面边界。
function drawStaticNodeSupport(screenPoint, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = "rgba(95, 111, 29, 0.1)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(screenPoint.x, screenPoint.y + 7);
  ctx.lineTo(screenPoint.x - 9, screenPoint.y + 22);
  ctx.lineTo(screenPoint.x + 9, screenPoint.y + 22);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  drawLineScreen({ x: screenPoint.x - 13, y: screenPoint.y + 22 }, { x: screenPoint.x + 13, y: screenPoint.y + 22 });
  for (let i = -10; i <= 10; i += 5) {
    drawLineScreen({ x: screenPoint.x + i - 3, y: screenPoint.y + 27 }, { x: screenPoint.x + i + 3, y: screenPoint.y + 22 });
  }
  ctx.restore();
}

// 绘制静态边界的短斜线标记，表达该边界是地面支撑/不可变形边界。
function drawStaticBoundaryMarkers(curve, color) {
  const count = curve.type === "line" ? 6 : 10;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  for (let i = 1; i < count; i++) {
    const t = i / count;
    const before = worldToScreen(pointOnCurve(curve, clamp(t - 0.02, 0, 1)));
    const after = worldToScreen(pointOnCurve(curve, clamp(t + 0.02, 0, 1)));
    const point = worldToScreen(pointOnCurve(curve, t));
    const tangent = normalize({ x: after.x - before.x, y: after.y - before.y }, { x: 1, y: 0 });
    const normal = { x: -tangent.y, y: tangent.x };
    drawLineScreen(
      { x: point.x - tangent.x * 4 + normal.x * 4, y: point.y - tangent.y * 4 + normal.y * 4 },
      { x: point.x + tangent.x * 4 + normal.x * 14, y: point.y + tangent.y * 4 + normal.y * 14 },
    );
  }
  ctx.restore();
}

// 选中曲线时绘制控制柄，便于像 Office 绘图一样调整曲线形状。
function drawSelectedControls() {
  if (!selected || !["curve", "control"].includes(selected.type)) return;
  const curve = curveById(selected.id);
  if (!curve || !curve.controls?.length) return;
  const anchors = getCurveAnchors(curve);
  ctx.save();
  ctx.strokeStyle = "rgba(123, 101, 178, 0.42)";
  ctx.setLineDash([4, 5]);
  ctx.lineWidth = 1;
  if (curve.type === "quadratic" || curve.type === "arc" || curve.type === "ellipse") {
    const c = curve.controls[0];
    drawPolylineWorld([anchors[0], c, anchors[1]]);
  } else if (curve.type === "cubic") {
    drawPolylineWorld([anchors[0], curve.controls[0]]);
    drawPolylineWorld([curve.controls[1], anchors[1]]);
  }
  ctx.setLineDash([]);
  for (let i = 0; i < curve.controls.length; i++) {
    drawControlPoint(curve.controls[i], i);
  }
  ctx.restore();
}

// 判断当前曲线是否被选中，控制点选中时也高亮所属曲线。
function isCurveSelection(curveId) {
  return selected && ["curve", "control"].includes(selected.type) && selected.id === curveId;
}

// 绘制曲线控制点。
function drawControlPoint(point) {
  const p = worldToScreen(point);
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = COLORS.control;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.rect(p.x - 5, p.y - 5, 10, 10);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// 绘制所有载荷，包括点载荷和分布力。
function drawLoads() {
  for (const load of scene.pointLoads) {
    drawPointLoad(load, selected?.type === "pointLoad" && selected.id === load.id);
  }
  for (const load of scene.distributedLoads) {
    drawDistributedLoad(load, selected?.type === "distributedLoad" && selected.id === load.id);
  }
  for (const load of scene.bodyLoads || []) {
    drawBodyForceLoad(load, selected?.type === "bodyLoad" && selected.id === load.id);
  }
}

// 取得点载荷锚点；几何节点载荷优先跟随绑定的几何节点。
function loadAnchor(load) {
  if (load.geometryNodeId) {
    const node = geometryNodeById(load.geometryNodeId);
    if (node) return { x: node.x, y: node.y };
  }
  return load.anchor;
}

// 绘制单个点载荷箭头和大小标签。
function drawPointLoad(load, isSelected) {
  const anchor = loadAnchor(load);
  const start = worldToScreen(anchor);
  const unit = normalize({ x: load.fx, y: load.fy }, { x: 0, y: -1 });
  const screenDir = normalize({ x: unit.x, y: -unit.y });
  const length = clamp(Math.abs(Math.hypot(load.fx, load.fy)) * 4, 34, 84);
  const end = {
    x: start.x + screenDir.x * length,
    y: start.y + screenDir.y * length,
  };
  drawArrowScreen(start, end, isSelected ? COLORS.selected : COLORS.force, isSelected ? 3 : 2.2);
  ctx.save();
  ctx.fillStyle = isSelected ? COLORS.selected : COLORS.force;
  ctx.font = "600 12px Segoe UI, Arial, sans-serif";
  ctx.fillText(`${load.label || "F"}=${formatNumber(Math.hypot(load.fx, load.fy))}`, end.x + 6, end.y - 6);
  ctx.restore();
}

// 绘制沿曲线分布的多个箭头和 q 标签。
function drawDistributedLoad(load, isSelected) {
  const curve = curveById(load.curveId);
  if (!curve) return;
  const color = isSelected ? COLORS.selected : COLORS.load;
  const direction = normalize(load.direction, { x: 0, y: -1 });
  const screenDir = normalize({ x: direction.x, y: -direction.y });
  const startT = clamp(Number(load.start ?? 0), 0, 1);
  const endT = clamp(Number(load.end ?? 1), 0, 1);
  const maxDisplayLength = distributedLoadMaxDisplayLength(load);
  const count = 7;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isSelected ? 2.4 : 1.9;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const curveT = lerp(startT, endT, t);
    const point = pointOnCurve(curve, curveT);
    const start = worldToScreen(point);
    const length = distributedLoadDisplayLengthAt(load, curveT);
    if (length < 1) continue;
    const end = {
      x: start.x + screenDir.x * length,
      y: start.y + screenDir.y * length,
    };
    drawArrowScreen(start, end, color, isSelected ? 2.4 : 1.9);
  }
  const mid = worldToScreen(pointOnCurve(curve, lerp(startT, endT, 0.5)));
  const labelOffset = maxDisplayLength + 8;
  ctx.font = "600 12px Segoe UI, Arial, sans-serif";
  ctx.fillText(
    `${load.label || "q"}=${formatNumber(distributedLoadStartMagnitude(load))}→${formatNumber(distributedLoadEndMagnitude(load))}`,
    mid.x + screenDir.x * labelOffset,
    mid.y + screenDir.y * labelOffset,
  );
  ctx.restore();
}

// 绘制体力方向箭头；全局体力会在每个结构区域质心处给出方向提示。
function drawBodyForceLoad(load, isSelected) {
  const anchors = bodyForceDisplayAnchors(load);
  if (!anchors.length) return;
  const color = isSelected ? COLORS.selected : COLORS.bodyLoad;
  const direction = normalize(load.direction, { x: 0, y: -1 });
  const screenDir = normalize({ x: direction.x, y: -direction.y });
  const length = clamp(bodyLoadMagnitude(load) * 5, 32, 74);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isSelected ? 2.4 : 1.9;
  anchors.forEach((anchor, index) => {
    const start = worldToScreen(anchor);
    const end = {
      x: start.x + screenDir.x * length,
      y: start.y + screenDir.y * length,
    };
    drawArrowScreen(start, end, color, isSelected ? 2.4 : 1.9);
    if (index === 0) {
      ctx.font = "600 12px Segoe UI, Arial, sans-serif";
      ctx.fillText(`${load.label || "g"}=${formatNumber(bodyLoadMagnitude(load))}`, end.x + 6, end.y - 6);
    }
  });
  ctx.restore();
}

// 体力显示锚点：区域体力取对应区域质心，全局体力取所有结构区域质心。
function bodyForceDisplayAnchors(load) {
  const regions = bodyForceTargetRegions(load);
  const anchors = regions
    .map((region) => region?.centroid || (region?.polygon?.length ? polygonCentroid(region.polygon) : null))
    .filter(isFinitePoint);
  if (anchors.length) return anchors;
  const fallback = bodyForceFallbackAnchor();
  return fallback ? [fallback] : [];
}

function bodyForceTargetRegions(load) {
  if (load?.targetType === "region" || load?.regionId) {
    const region = regionById(load.regionId);
    return region && !isAirRegion(region) ? [region] : [];
  }
  return (scene.regions || []).filter((region) => !isAirRegion(region));
}

function bodyForceFallbackAnchor() {
  const points = [...(scene.analysisNodes || []), ...(scene.geometryNodes || [])].filter(isFinitePoint);
  if (!points.length) return null;
  return {
    x: (Math.min(...points.map((point) => point.x)) + Math.max(...points.map((point) => point.x))) / 2,
    y: (Math.min(...points.map((point) => point.y)) + Math.max(...points.map((point) => point.y))) / 2,
  };
}

// 绘制正在创建但尚未提交的数据，例如半完成曲线或拖拽中的载荷方向。
function drawDraft() {
  if (!draft) return;
  ctx.save();
  ctx.strokeStyle = COLORS.selected;
  ctx.fillStyle = COLORS.selected;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  if (draft.kind === "curve") {
    const points = [...draft.points];
    if (draft.preview) points.push(draft.preview);
    drawDraftCurve(draft.type, points);
  }
  if (draft.kind === "force" && draft.preview) {
    drawArrowScreen(worldToScreen(draft.anchor), worldToScreen(draft.preview), COLORS.force, 2);
  }
  if (draft.kind === "distributed" && draft.curveId && draft.preview) {
    const curve = curveById(draft.curveId);
    if (curve) {
      drawCurve(curve, { color: COLORS.selected, width: 3 });
      const mid = pointOnCurve(curve, 0.5);
      drawArrowScreen(worldToScreen(mid), worldToScreen(draft.preview), COLORS.load, 2);
    }
  }
  ctx.restore();
}

// 根据草图点绘制直线、二次曲线、三次曲线或圆弧预览。
function drawDraftCurve(type, points) {
  if (points.length < 2) {
    points.forEach((point) => drawControlPoint(point));
    return;
  }
  const [p0, p1, p2, p3] = points;
  let sampled = [];
  if (type === "line") sampled = [p0, p1];
  if (type === "quadratic") {
    const end = p2 || p1;
    const control = p2 ? p1 : midpoint(p0, p1);
    for (let i = 0; i <= 48; i++) sampled.push(quadraticPoint(p0, control, end, i / 48));
  }
  if (type === "cubic") {
    const c1 = p1;
    const c2 = p2 || p1;
    const end = p3 || p2 || p1;
    for (let i = 0; i <= 56; i++) sampled.push(cubicPoint(p0, c1, c2, end, i / 56));
  }
  if (type === "arc") {
    const through = p1;
    const end = p2 || p1;
    for (let i = 0; i <= 56; i++) sampled.push(arcPoint(p0, through, end, i / 56));
  }
  drawPolylineWorld(sampled);
  ctx.setLineDash([4, 5]);
  drawPolylineWorld(points);
  ctx.setLineDash([]);
  points.forEach((point) => drawControlPoint(point));
}

// 鼠标悬停在对象上时绘制提示高亮。
function drawHover() {
  if (!hovered || interaction) return;
  ctx.save();
  ctx.strokeStyle = "rgba(0, 124, 137, 0.5)";
  ctx.lineWidth = 1.5;
  if (hovered.type === "geometryNode") {
    const node = geometryNodeById(hovered.id);
    if (node) {
      const p = worldToScreen(node);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (hovered.type === "curve") {
    const curve = curveById(hovered.id);
    if (curve) drawCurve(curve, { color: "rgba(0, 124, 137, 0.65)", width: 3 });
  }
  if (hovered.type === "region") {
    const region = regionById(hovered.id);
    if (region?.polygon?.length) {
      drawRegionPath(region.polygon);
      ctx.strokeStyle = "rgba(0, 124, 137, 0.75)";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 6]);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// 绘制世界坐标点组成的折线。
function drawPolylineWorld(points) {
  if (!points.length) return;
  ctx.beginPath();
  points.forEach((point, index) => {
    const p = worldToScreen(point);
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}

// 绘制屏幕坐标中的一条线段。
function drawLineScreen(a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

// 绘制屏幕坐标中的箭头主体和箭头头部。
function drawArrowScreen(start, end, color, width = 2) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  drawLineScreen(start, end);
  drawArrowHeadScreen(start, end, color);
  ctx.restore();
}

// 绘制箭头头部三角形。
function drawArrowHeadScreen(start, end, color) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const size = 9;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - Math.cos(angle - Math.PI / 6) * size, end.y - Math.sin(angle - Math.PI / 6) * size);
  ctx.lineTo(end.x - Math.cos(angle + Math.PI / 6) * size, end.y - Math.sin(angle + Math.PI / 6) * size);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
