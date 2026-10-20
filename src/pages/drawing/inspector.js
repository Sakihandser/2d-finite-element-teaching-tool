// 根据当前选择对象取得几何属性编辑器需要的信息。
function selectedGeometryInfo(selection = selected) {
  if (selection?.type === "geometryNode") {
    const node = geometryNodeById(selection.id);
    if (!node) return null;
    return {
      kind: "geometryNode",
      object: node,
      title: `${node.id} 几何节点`,
      mechanicalState: normalizeMechanicalState(node.mechanicalState),
    };
  }
  if (selection?.type === "curve") {
    const curve = curveById(selection.id);
    if (!curve) return null;
    return {
      kind: "curve",
      object: curve,
      title: `${curve.id} 边界`,
      mechanicalState: normalizeMechanicalState(curve.mechanicalState),
    };
  }
  if (selection?.type === "control") {
    const curve = curveById(selection.id);
    if (!curve) return null;
    return {
      kind: "curve",
      object: curve,
      title: `${curve.id} 边界`,
      mechanicalState: normalizeMechanicalState(curve.mechanicalState),
    };
  }
  return null;
}

// 将当前选中几何对象同步到右侧编辑器；非几何对象会隐藏编辑器。
function syncGeometryEditor() {
  if (typeof syncDrawingEditControls === "function") syncDrawingEditControls();
  const info = selectedGeometryInfo();
  geometryEditor.classList.toggle("hidden", !info);
  if (!info) return;
  geometryEditorTitle.textContent = info.title + (info.object.construction ? "（草稿）" : "（真实）");
  geometryStateButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.geometryState === info.mechanicalState);
  });
}

// 应用右侧几何状态切换，修改几何节点或边界的 static/free 属性。
function applySelectedGeometryState(state) {
  const info = selectedGeometryInfo();
  if (!info) return;
  const nextState = normalizeMechanicalState(state);
  info.object.mechanicalState = nextState;
  if (info.kind === "curve") {
    if (nextState === "static" && !info.object.construction) {
      markCurveEndpointGeometryNodesStatic(info.object);
    }
    syncIntersectionGeometryNodes();
  }
  if (scene.analysisNodes.length) {
    classifyAnalysisNodes();
  } else {
    updatePanel();
    render();
  }
}

// 边界被设为静态支撑时，将两端几何节点也同步设为静态；节点状态不会反向修改边界。
function markCurveEndpointGeometryNodesStatic(curve) {
  markCurveEndpointGeometryNodesStaticInScene(curve, scene);
}

// 对指定场景应用“静态边界 -> 端点几何节点静态”的单向规则，导入 JSON 时也可复用。
function applyStaticBoundaryEndpointStates(targetScene = scene) {
  for (const curve of targetScene.curves || []) {
    if (!curve.construction && normalizeMechanicalState(curve.mechanicalState) === "static") {
      markCurveEndpointGeometryNodesStaticInScene(curve, targetScene);
    }
  }
}

// 在指定场景中把一条边界的端点几何节点设为静态。
function markCurveEndpointGeometryNodesStaticInScene(curve, targetScene) {
  for (const id of curve.geometryNodeIds || []) {
    const node = (targetScene.geometryNodes || []).find((item) => item.id === id);
    if (node) {
      node.mechanicalState = "static";
    }
  }
}

// 根据当前选择对象取得载荷编辑器需要的信息。
function selectedLoadInfo(selection = selected) {
  if (selection?.type === "pointLoad") {
    const load = pointLoadById(selection.id);
    if (!load) return null;
    return {
      kind: "pointLoad",
      load,
      title: `${load.id} 几何点载荷`,
      magnitude: Math.hypot(load.fx, load.fy),
      angle: angleFromVector({ x: load.fx, y: load.fy }),
      unit: "N",
    };
  }
  if (selection?.type === "distributedLoad") {
    const load = distributedLoadById(selection.id);
    if (!load) return null;
    return {
      kind: "distributedLoad",
      load,
      title: `${load.id} 分布力`,
      magnitude: distributedLoadStartMagnitude(load),
      endMagnitude: distributedLoadEndMagnitude(load),
      angle: angleFromVector(load.direction),
      unit: "N/m",
    };
  }
  if (selection?.type === "bodyLoad") {
    const load = bodyLoadById(selection.id);
    if (!load) return null;
    return {
      kind: "bodyLoad",
      load,
      title: `${load.id} 体力`,
      magnitude: bodyLoadMagnitude(load),
      angle: angleFromVector(load.direction),
      unit: "m/s²",
    };
  }
  return null;
}

// 将当前选中载荷同步到右侧编辑器；非载荷对象会隐藏编辑器。
function syncLoadEditor() {
  const info = selectedLoadInfo();
  loadEditor.classList.toggle("hidden", !info);
  if (!info) return;
  loadEditorTitle.textContent = info.title;
  selectedLoadUnit.textContent = info.unit;
  if (document.activeElement !== selectedLoadMagnitude) {
    selectedLoadMagnitude.value = inputNumber(info.magnitude);
  }
  selectedLoadEndRow?.classList.toggle("hidden", info.kind !== "distributedLoad");
  if (info.kind === "distributedLoad" && document.activeElement !== selectedLoadEndMagnitude) {
    selectedLoadEndMagnitude.value = inputNumber(info.endMagnitude);
  }
  if (document.activeElement !== selectedLoadAngle) {
    selectedLoadAngle.value = inputNumber(info.angle);
  }
}

// 应用右侧载荷编辑器输入，实时修改点载荷分量或分布力方向。
function applySelectedLoadEditor() {
  const info = selectedLoadInfo();
  if (!info) return;
  const magnitude = Math.abs(Number(selectedLoadMagnitude.value));
  const endMagnitude = Math.abs(Number(selectedLoadEndMagnitude?.value ?? magnitude));
  const angle = Number(selectedLoadAngle.value);
  if (!Number.isFinite(magnitude) || !Number.isFinite(endMagnitude) || !Number.isFinite(angle)) return;
  const direction = directionFromAngle(angle);
  if (info.kind === "pointLoad") {
    info.load.fx = roundCoord(direction.x * magnitude);
    info.load.fy = roundCoord(direction.y * magnitude);
  }
  if (info.kind === "distributedLoad") {
    info.load.q = roundCoord(magnitude);
    info.load.qStart = roundCoord(magnitude);
    info.load.qEnd = roundCoord(endMagnitude);
    info.load.direction = {
      x: roundCoord(direction.x),
      y: roundCoord(direction.y),
    };
  }
  if (info.kind === "bodyLoad") {
    info.load.magnitude = roundCoord(magnitude);
    info.load.direction = {
      x: roundCoord(direction.x),
      y: roundCoord(direction.y),
    };
  }
  updatePanel();
  render();
}

// 将数值整理成适合 input 显示的短字符串。
function inputNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 1000) / 1000);
}

// 刷新计算页顶部状态、右侧计数和阶段状态。
function updateCalculationPanel() {
  if (calculationModelName) {
    calculationModelName.value = uiText(modelName.value || scene.name || "未命名模型");
  }
  if (calculationCounts.analysisNodes) {
    calculationCounts.analysisNodes.textContent = scene.analysisNodes.length;
  }
  if (calculationCounts.elements) {
    calculationCounts.elements.textContent = scene.mesh?.elements?.length || 0;
  }
  if (calculationCounts.regions) {
    calculationCounts.regions.textContent = (scene.regions || []).filter((region) => !isAirRegion(region)).length;
  }
  if (calculationCounts.staticBoundaries) {
    calculationCounts.staticBoundaries.textContent = calculationConstraintNodeCount();
  }
  if (calculationCounts.loads) {
    calculationCounts.loads.textContent = scene.pointLoads.length + scene.distributedLoads.length + (scene.bodyLoads || []).length;
  }
  if (calculationZoomReadout) {
    calculationZoomReadout.textContent = `${Math.round((calculationView.scale / 48) * 100)}%`;
  }
  if (calculationStatuses.geometry) {
    calculationStatuses.geometry.textContent = scene.curves.length || scene.regions?.length ? "已同步" : "空模型";
  }
  if (calculationStatuses.mesh) {
    if (scene.mesh?.metadata?.stale) {
      calculationStatuses.mesh.textContent = "需重新划分";
      calculationStatuses.mesh.title = scene.mesh.metadata.staleReason || "";
    } else if (scene.mesh?.elements?.length) {
      calculationStatuses.mesh.textContent = `${scene.mesh.elements.length} 单元`;
      calculationStatuses.mesh.title = "";
    } else if (scene.mesh?.metadata?.warnings?.length) {
      calculationStatuses.mesh.textContent = "网格失败";
      calculationStatuses.mesh.title = scene.mesh.metadata.warnings[0];
    } else if (scene.analysisNodePlacement?.stale) {
      calculationStatuses.mesh.textContent = "需重新布点";
      calculationStatuses.mesh.title = "";
    } else if (scene.analysisNodes.length) {
      calculationStatuses.mesh.textContent = `已布点 ${scene.analysisNodes.length} 节点`;
      calculationStatuses.mesh.title = "";
    } else {
      calculationStatuses.mesh.textContent = "待生成";
      calculationStatuses.mesh.title = "";
    }
  }
  if (calculationStatuses.animation) {
    calculationStatuses.animation.textContent = calculationRunStatusMessage || (hasCalculationDisplacement() ? (calculationAnimation.running ? "播放中" : "已就绪") : "待结果");
  }
}

function calculationConstraintNodeCount() {
  const staticAnalysisNodes = scene.analysisNodes.filter((node) => normalizeMechanicalState(node.mechanicalState) === "static").length;
  if (staticAnalysisNodes) return staticAnalysisNodes;
  return scene.geometryNodes.filter((node) => !node.construction && normalizeMechanicalState(node.mechanicalState) === "static").length;
}

// 刷新右侧统计、缩放显示、选择详情和载荷编辑器。
function updatePanel(updateSelection = true) {
  counts.geometryNodes.textContent = scene.geometryNodes.length;
  counts.analysisNodes.textContent = scene.analysisNodes.length;
  counts.curves.textContent = scene.curves.length;
  counts.regions.textContent = (scene.regions || []).filter((region) => !isAirRegion(region)).length;
  counts.loads.textContent = scene.pointLoads.length + scene.distributedLoads.length + (scene.bodyLoads || []).length;
  counts.mesh.textContent = scene.mesh?.elements?.length || 0;
  zoomReadout.textContent = `${Math.round((view.scale / 48) * 100)}%`;
  updateCalculationPanel();
  syncGeometryEditor();
  syncLoadEditor();
  if (!updateSelection) return;
  selectionDetails.textContent = selected ? describeSelection(selected) : "无";
}

// 生成当前选择对象的文字说明，显示在右侧“选择”区域。
function describeSelection(selection) {
  if (selection.type === "geometryNode") {
    const node = geometryNodeById(selection.id);
    if (!node) return "无";
    const lines = [
      `${node.id} 几何节点`,
      `state: ${mechanicalStateLabel(node.mechanicalState)}`,
      `x: ${formatNumber(node.x)}`,
      `y: ${formatNumber(node.y)}`,
      `previewUx: ${formatNumber(node.previewUx)}`,
      `previewUy: ${formatNumber(node.previewUy)}`,
    ];
    if (isIntersectionGeometryNode(node)) {
      lines.push(`source: 边界交点 ${node.intersectionCurveIds.join(" × ")}`);
    }
    return lines.join("\n");
  }
  if (selection.type === "curve") {
    const curve = curveById(selection.id);
    if (!curve) return "无";
    const lines = [
      `${curve.id}`,
      `type: ${curve.type}`,
      `state: ${mechanicalStateLabel(curve.mechanicalState)}`,
      `geometryNodes: ${curve.geometryNodeIds.join(" -> ")}`,
    ];
    curve.controls.forEach((point, index) => lines.push(`control ${index + 1}: (${formatNumber(point.x)}, ${formatNumber(point.y)})`));
    return lines.join("\n");
  }
  if (selection.type === "region") {
    const region = regionById(selection.id);
    if (!region) return "无";
    const material = materialSnapshotForRegion(region);
    const lines = [
      `${region.id} ${regionKindLabel(region)}`,
      `kind: ${regionKindLabel(region)}`,
      `boundaryCurves: ${(region.boundaryCurveIds || []).join(" -> ")}`,
      `area: ${formatNumber(region.area)}`,
      `centroid: (${formatNumber(region.centroid?.x)}, ${formatNumber(region.centroid?.y)})`,
      `material: ${material?.name || "-"}`,
    ];
    if (material && !isAirRegion(region)) {
      lines.push(`E: ${formatMaterialNumber(material.elasticModulus)} GPa`);
      lines.push(`ν: ${formatMaterialNumber(material.poissonRatio)}`);
      lines.push(`ρ: ${formatMaterialNumber(material.density)} kg/m³`);
      lines.push(`yield: ${formatMaterialNumber(material.yieldStrength)} MPa`);
      lines.push(`tensile: ${formatMaterialNumber(material.tensileStrength)} MPa`);
      lines.push(`compressive: ${formatMaterialNumber(material.compressiveStrength)} MPa`);
    }
    return lines.join("\n");
  }
  if (selection.type === "pointLoad") {
    const load = pointLoadById(selection.id);
    if (!load) return "无";
    return [
      `${load.id}`,
      `geometryNode: ${load.geometryNodeId || "-"}`,
      `|F|: ${formatNumber(Math.hypot(load.fx, load.fy))}`,
      `θ: ${formatNumber(angleFromVector({ x: load.fx, y: load.fy }))} deg`,
      `Fx: ${formatNumber(load.fx)}`,
      `Fy: ${formatNumber(load.fy)}`,
    ].join("\n");
  }
  if (selection.type === "distributedLoad") {
    const load = distributedLoadById(selection.id);
    if (!load) return "无";
    return [
      `${load.id}`,
      `curve: ${load.curveId}`,
      `qStart: ${formatNumber(distributedLoadStartMagnitude(load))}`,
      `qEnd: ${formatNumber(distributedLoadEndMagnitude(load))}`,
      `θ: ${formatNumber(angleFromVector(load.direction))} deg`,
      `dir: (${formatNumber(load.direction.x)}, ${formatNumber(load.direction.y)})`,
    ].join("\n");
  }
  if (selection.type === "bodyLoad") {
    const load = bodyLoadById(selection.id);
    if (!load) return "无";
    return [
      `${load.id}`,
      `target: ${load.targetType === "region" ? load.regionId || "-" : "global"}`,
      `g: ${formatNumber(bodyLoadMagnitude(load))}`,
      `θ: ${formatNumber(angleFromVector(load.direction))} deg`,
      `dir: (${formatNumber(load.direction.x)}, ${formatNumber(load.direction.y)})`,
    ].join("\n");
  }
  if (selection.type === "control") {
    const curve = curveById(selection.id);
    const point = curve?.controls?.[selection.extra?.index];
    if (!point) return "无";
    return [`${curve.id}`, `control: ${(selection.extra.index || 0) + 1}`, `x: ${formatNumber(point.x)}`, `y: ${formatNumber(point.y)}`].join("\n");
  }
  return "无";
}
