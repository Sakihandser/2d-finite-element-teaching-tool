// 向量归一化；零向量时使用 fallback。
function normalize(vector, fallback = { x: 1, y: 0 }) {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-9) {
    return { ...fallback };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

// 角度转单位方向。角度遵循数学坐标系：0° 向右，90° 向上。
function directionFromAngle(degrees) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: Math.cos(radians),
    y: Math.sin(radians),
  };
}

// 向量转角度，用于把现有载荷方向显示到右侧编辑器。
function angleFromVector(vector, fallback = -90) {
  const unit = normalize(vector, directionFromAngle(fallback));
  return (Math.atan2(unit.y, unit.x) * 180) / Math.PI;
}

// 从左侧载荷角度输入框读取预设方向。
function presetLoadDirection() {
  return directionFromAngle(readNumber(loadAngle, -90));
}

// 将几何状态归一化为 free/static，兼容旧数据可能使用的 fixed/ground/布尔值。
function normalizeMechanicalState(value) {
  if (value === true) return "static";
  if (typeof value !== "string") return "free";
  const normalized = value.trim().toLowerCase();
  return ["static", "fixed", "ground", "support", "supported", "静态", "固定", "地面", "支撑"].includes(normalized) ? "static" : "free";
}

// 将内部状态转成中文，显示在右侧面板中。
function mechanicalStateLabel(state) {
  return normalizeMechanicalState(state) === "static" ? "静态支撑" : "自由结构";
}

// 判断世界坐标点落在静态还是自由几何上，供后续计算节点生成阶段直接调用。
function getGeometryStateAtPoint(point, tolerance = DEFAULT_CLASSIFICATION_TOLERANCE) {
  const safeTolerance = normalizeTolerance(tolerance);
  const region = getStructureRegionAtPoint(point, safeTolerance);
  const regionFields = regionClassificationFields(region);
  const candidates = [];
  for (const node of scene.geometryNodes) {
    const nodeDistance = distance(point, node);
    if (nodeDistance <= safeTolerance) {
      candidates.push({
        mechanicalState: normalizeMechanicalState(node.mechanicalState),
        sourceType: "geometryNode",
        sourceId: node.id,
        distance: nodeDistance,
      });
    }
  }
  for (const curve of scene.curves) {
    const curveDistance = distanceToCurveWorld(point, curve);
    if (curveDistance <= safeTolerance) {
      candidates.push({
        mechanicalState: normalizeMechanicalState(curve.mechanicalState),
        sourceType: "curve",
        sourceId: curve.id,
        distance: curveDistance,
      });
    }
  }
  if (!candidates.length) {
    return {
      mechanicalState: "free",
      isStatic: false,
      isFree: true,
      sourceType: null,
      sourceId: null,
      distance: null,
      ...regionFields,
    };
  }
  candidates.sort((a, b) => {
    if (a.mechanicalState !== b.mechanicalState) {
      return a.mechanicalState === "static" ? -1 : 1;
    }
    return a.distance - b.distance;
  });
  const chosen = candidates[0];
  return {
    ...chosen,
    isStatic: chosen.mechanicalState === "static",
    isFree: chosen.mechanicalState === "free",
    ...regionFields,
  };
}

// 容差参数归一化，避免外部模块传入非法值导致全部节点误分类。
function normalizeTolerance(tolerance) {
  if (tolerance && typeof tolerance === "object") {
    return normalizeTolerance(tolerance.tolerance);
  }
  const value = Number(tolerance);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CLASSIFICATION_TOLERANCE;
}

// 给单个计算节点写入当前位置继承到的几何状态。
function classifyAnalysisNode(node, tolerance = DEFAULT_CLASSIFICATION_TOLERANCE) {
  const info = getGeometryStateAtPoint(node, tolerance);
  // AMR boundary midpoints stay on the existing polygonal mesh. Their curve
  // provenance preserves fixed supports even on curved-boundary chords.
  if (node.placement?.sourceType === "adaptiveBoundary") {
    const curve = scene.curves.find((c) => c.id === node.placement.curveId);
    if (curve) {
      info.mechanicalState = normalizeMechanicalState(curve.mechanicalState);
      info.isStatic = info.mechanicalState === "static";
      info.isFree = !info.isStatic;
      info.sourceType = "curve";
      info.sourceId = curve.id;
    }
  }
  node.mechanicalState = info.mechanicalState;
  node.isStatic = info.isStatic;
  node.isFree = info.isFree;
  node.geometrySourceType = info.sourceType;
  node.geometrySourceId = info.sourceId;
  node.geometrySourceDistance = info.distance;
  node.structureRegionId = info.structureRegionId;
  node.regionId = info.regionId;
  node.structureName = info.structureName;
  node.regionKind = info.regionKind;
  node.isAir = info.isAir;
  node.isStructure = info.isStructure;
  node.materialId = info.materialId;
  node.materialName = info.materialName;
  node.materialColor = info.materialColor;
  node.materialProperties = info.materialProperties;
  return node;
}

// 创建计算节点；默认立即从几何节点/边界读取 static/free 状态。
function createAnalysisNode(point, options = {}) {
  const node = {
    id: String(options.id || nextId("analysisNode")),
    x: roundCoord(point.x),
    y: roundCoord(point.y),
    ux: Number(options.ux) || 0,
    uy: Number(options.uy) || 0,
    placement: normalizeAnalysisNodePlacementObject(options.placement),
    mechanicalState: normalizeMechanicalState(options.mechanicalState),
    isStatic: false,
    isFree: true,
    geometrySourceType: null,
    geometrySourceId: null,
    geometrySourceDistance: null,
    structureRegionId: null,
    regionId: null,
    structureName: "",
    regionKind: null,
    isAir: false,
    isStructure: false,
    materialId: null,
    materialName: "",
    materialColor: "",
    materialProperties: null,
  };
  if (options.classify !== false) {
    classifyAnalysisNode(node, options.tolerance ?? DEFAULT_CLASSIFICATION_TOLERANCE);
  }
  scene.analysisNodes.push(node);
  if (typeof gpuMeshRenderer !== "undefined") gpuMeshRenderer.invalidateScene();
  updatePanel();
  render();
  return node;
}

// 批量写入计算节点和网格单元，供后续网格生成器一次性提交结果。
function setAnalysisMesh(meshData = {}, options = {}) {
  const preserveCoordinates = Boolean((meshData.meshMetadata || meshData.metadata)?.adaptive);
  const rawAnalysisNodes = Array.isArray(meshData.analysisNodes) ? meshData.analysisNodes : Array.isArray(meshData.nodes) ? meshData.nodes : [];
  const rawElements = Array.isArray(meshData.elements) ? meshData.elements : [];
  scene.analysisNodes = rawAnalysisNodes.map((node, index) => ({
    id: String(node.id || `A${index + 1}`),
    x: preserveCoordinates ? Number(node.x) || 0 : roundCoord(Number(node.x) || 0),
    y: preserveCoordinates ? Number(node.y) || 0 : roundCoord(Number(node.y) || 0),
    ux: Number(node.ux) || 0,
    uy: Number(node.uy) || 0,
    placement: normalizeAnalysisNodePlacementObject(node.placement || node.analysisPlacement),
    mechanicalState: normalizeMechanicalState(node.mechanicalState),
    isStatic: normalizeMechanicalState(node.mechanicalState) === "static",
    isFree: normalizeMechanicalState(node.mechanicalState) === "free",
    geometrySourceType: node.geometrySourceType || null,
    geometrySourceId: node.geometrySourceId || null,
    geometrySourceDistance: Number.isFinite(Number(node.geometrySourceDistance)) ? Number(node.geometrySourceDistance) : null,
    structureRegionId: node.structureRegionId || node.regionId || null,
    regionId: node.regionId || node.structureRegionId || null,
    structureName: String(node.structureName || ""),
    regionKind: node.regionKind ? normalizeRegionKind(node.regionKind) : null,
    isAir: Boolean(node.isAir),
    isStructure: Boolean(node.isStructure),
    materialId: node.materialId || null,
    materialName: String(node.materialName || ""),
    materialColor: String(node.materialColor || ""),
    materialProperties: node.materialProperties || null,
  }));
  scene.mesh = {
    elements: rawElements.map(normalizeMeshElement),
    metadata: normalizeAnalysisMeshMetadata(meshData.meshMetadata || meshData.metadata),
  };
  if (meshData.analysisNodePlacement) {
    scene.analysisNodePlacement = normalizeAnalysisNodePlacementData(meshData.analysisNodePlacement);
  }
  scene.nextIds.analysisNode = maxNumericId(scene.analysisNodes, "A") + 1;
  if (options.classify !== false) {
    classifyAnalysisNodes(options.tolerance ?? DEFAULT_CLASSIFICATION_TOLERANCE);
  } else {
    classifyAnalysisElements(options.tolerance ?? DEFAULT_CLASSIFICATION_TOLERANCE);
    updatePanel();
    render();
  }
  return {
    analysisNodes: scene.analysisNodes,
    elements: scene.mesh.elements,
  };
}

// 计算节点来源信息由自动布点器写入；这里仅做宽松克隆，保持 setAnalysisMesh() 的通用性。
function normalizeAnalysisNodePlacementObject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const normalizeSource =
    typeof normalizeAnalysisPlacementSource === "function"
      ? normalizeAnalysisPlacementSource
      : (source = {}) => ({
          sourceType: String(source.sourceType || source.type || "generated"),
          sourceId: source.sourceId !== undefined && source.sourceId !== null ? String(source.sourceId) : null,
          geometryNodeId: source.geometryNodeId ? String(source.geometryNodeId) : null,
          curveId: source.curveId ? String(source.curveId) : null,
          curveT: Number.isFinite(Number(source.curveT)) ? Number(source.curveT) : null,
          loadId: source.loadId ? String(source.loadId) : null,
          regionId: source.regionId ? String(source.regionId) : null,
        });
  return {
    sourceType: String(raw.sourceType || raw.type || "generated"),
    sourceId: raw.sourceId !== undefined && raw.sourceId !== null ? String(raw.sourceId) : null,
    geometryNodeId: raw.geometryNodeId ? String(raw.geometryNodeId) : null,
    curveId: raw.curveId ? String(raw.curveId) : null,
    curveT: Number.isFinite(Number(raw.curveT)) ? Number(raw.curveT) : null,
    loadId: raw.loadId ? String(raw.loadId) : null,
    regionId: raw.regionId ? String(raw.regionId) : null,
    regionIds: Array.isArray(raw.regionIds) ? [...new Set(raw.regionIds.map(String).filter(Boolean))] : [],
    curveIds: Array.isArray(raw.curveIds) ? [...new Set(raw.curveIds.map(String).filter(Boolean))] : [],
    sources: Array.isArray(raw.sources) ? raw.sources.map(normalizeSource) : [],
  };
}

// 规整单元数据：兼容数组形式、analysisNodeIds 和旧字段 nodeIds。
function normalizeMeshElement(element, index) {
  if (Array.isArray(element)) {
    return {
      id: `E${index + 1}`,
      type: element.length === 3 ? "TRI3" : "POLY",
      analysisNodeIds: element,
      structureRegionId: null,
      regionId: null,
      regionKind: null,
      isAir: false,
      isStructure: false,
      materialId: null,
      materialName: "",
      materialColor: "",
      materialProperties: null,
    };
  }
  const refs = Array.isArray(element?.analysisNodeIds)
    ? element.analysisNodeIds
    : Array.isArray(element?.nodeIds)
      ? element.nodeIds
      : [];
  return {
    ...element,
    id: String(element?.id || `E${index + 1}`),
    type: String(element?.type || (refs.length === 3 ? "TRI3" : "POLY")),
    analysisNodeIds: refs,
    structureRegionId: element?.structureRegionId || element?.regionId || null,
    regionId: element?.regionId || element?.structureRegionId || null,
    regionKind: element?.regionKind ? normalizeRegionKind(element.regionKind) : null,
    isAir: Boolean(element?.isAir),
    isStructure: Boolean(element?.isStructure),
    materialId: element?.materialId || null,
    materialName: String(element?.materialName || ""),
    materialColor: String(element?.materialColor || ""),
    materialProperties: element?.materialProperties || null,
  };
}

// 批量给计算节点写入几何状态与区域材料，网格生成后可调用这个函数完成预分类。
function classifyAnalysisNodes(tolerance = DEFAULT_CLASSIFICATION_TOLERANCE) {
  for (const node of scene.analysisNodes) {
    classifyAnalysisNode(node, tolerance);
  }
  classifyAnalysisElements(tolerance);
  updatePanel();
  render();
  return scene.analysisNodes;
}

// Constrained Triangle elements retain their region attribute near curved
// holes and interfaces. A centroid tolerance must not turn solid elements
// into air or move them across a material boundary during refinement.
function classifyAnalysisElement(element, tolerance = DEFAULT_CLASSIFICATION_TOLERANCE) {
  if (!element || typeof element !== "object") return element;
  const algorithm = element.generation?.algorithm || "";
  const constrained = algorithm.startsWith("triangle-") || algorithm.startsWith("mfem-zz-");
  const assigned = constrained && !scene.mesh?.metadata?.stale
    ? regionById(element.structureRegionId || element.regionId) : null;
  let region;
  if (assigned && !isAirRegion(assigned)) {
    region = regionInfo(assigned);
  } else {
    const centroid = elementCentroid(element);
    region = centroid ? getStructureRegionAtPoint(centroid, tolerance) : null;
  }
  const fields = regionClassificationFields(region);
  element.structureRegionId = fields.structureRegionId;
  element.regionId = fields.regionId;
  element.structureName = fields.structureName;
  element.regionKind = fields.regionKind;
  element.isAir = fields.isAir;
  element.isStructure = fields.isStructure;
  element.materialId = fields.materialId;
  element.materialName = fields.materialName;
  element.materialColor = fields.materialColor;
  element.materialProperties = fields.materialProperties;
  return element;
}

// 批量给全部网格单元按质心写入区域、空气/结构和材料属性。
function classifyAnalysisElements(tolerance = DEFAULT_CLASSIFICATION_TOLERANCE) {
  if (typeof gpuMeshRenderer !== "undefined") gpuMeshRenderer.invalidateScene();
  for (const element of scene.mesh?.elements || []) {
    classifyAnalysisElement(element, tolerance);
  }
  return scene.mesh?.elements || [];
}

// 单元质心算法：取单元引用的计算节点坐标平均值，适用于三角形、四边形和一般多节点单元。
function elementCentroid(element) {
  const nodes = elementNodeRefs(element).map((ref) => analysisNodeByRef(ref)).filter(Boolean);
  if (!nodes.length) return null;
  const sum = nodes.reduce((acc, node) => ({ x: acc.x + node.x, y: acc.y + node.y }), { x: 0, y: 0 });
  return {
    x: sum.x / nodes.length,
    y: sum.y / nodes.length,
  };
}

// 读取单元节点引用，统一新旧网格字段。
function elementNodeRefs(element) {
  if (Array.isArray(element)) return element;
  if (Array.isArray(element?.analysisNodeIds)) return element.analysisNodeIds;
  if (Array.isArray(element?.nodeIds)) return element.nodeIds;
  return [];
}
