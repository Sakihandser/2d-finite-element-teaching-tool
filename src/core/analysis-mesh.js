const ANALYSIS_MESH_VERSION = 7;
const ANALYSIS_MESH_ALGORITHM = "triangle-wasm-1.0.0-pslg";
const ANALYSIS_MESH_MIN_AREA = 1e-10;
const ANALYSIS_MESH_DEFAULT_MIN_ANGLE = 20;
const ANALYSIS_MESH_WASM_URL = "./src/vendor/triangle-wasm/triangle.out.wasm";
let triangleWasmInitialization = null;

// Triangle 是异步加载的 WASM 模块；整个页面生命周期只初始化一次。
function initializeTriangleWasm() {
  if (triangleWasmInitialization) return triangleWasmInitialization;
  const api =
    (typeof TriangleWasm !== "undefined" && TriangleWasm) ||
    (typeof window !== "undefined" && window.TriangleWasm) ||
    (typeof globalThis !== "undefined" && globalThis.TriangleWasm);
  if (!api?.init || !api?.makeIO || !api?.triangulate || !api?.freeIO) {
    return Promise.reject(new Error("triangle-wasm 运行时未加载，无法划分有限元网格。"));
  }
  triangleWasmInitialization = api
    .init(ANALYSIS_MESH_WASM_URL)
    .then(() => api)
    .catch((error) => {
      triangleWasmInitialization = null;
      throw new Error("triangle-wasm 初始化失败：" + (error?.message || String(error)));
    });
  return triangleWasmInitialization;
}

// 计算页入口：必要时重新布点，再用 Triangle 的 PSLG 约束三角剖分一次性提交完整网格。
async function autoGenerateAnalysisMesh(options = {}) {
  rebuildDerivedRegions({ markAnalysisNodePlacementStale: false });
  const tolerance = meshClassificationTolerance(options.tolerance);
  const placementWarnings = [];
  if (calculationStatuses.mesh) {
    calculationStatuses.mesh.textContent = "正在加载 Triangle…";
    calculationStatuses.mesh.title = "";
  }

  if (
    options.regenerateNodes ||
    !scene.analysisNodes.length ||
    scene.analysisNodePlacement?.stale ||
    Number(scene.analysisNodePlacement?.version) !== ANALYSIS_NODE_PLACEMENT_VERSION
  ) {
    const placement = autoPlaceAnalysisNodes({
      maxNodes: options.maxNodes ?? readAnalysisNodeLimit(),
      spacing: options.spacing,
      tolerance,
    });
    placementWarnings.push(...(placement.warnings || []));
  } else {
    classifyAnalysisNodes(tolerance);
  }

  const mesh = await buildAutomaticAnalysisMesh({
    tolerance,
    minAngle: options.minAngle,
    maxArea: options.maxArea,
    maxEdgeLength: options.maxEdgeLength,
  });
  const connectedNodeIds = meshConnectedAnalysisNodeIds(mesh.elements);
  const analysisNodes = mesh.elements.length
    ? mesh.analysisNodes.filter((node) => connectedNodeIds.has(String(node.id)))
    : mesh.analysisNodes;
  const removedNodeIds = mesh.elements.length
    ? mesh.analysisNodes.filter((node) => !connectedNodeIds.has(String(node.id))).map((node) => String(node.id))
    : [];
  const placement = updateAnalysisNodePlacementAfterMeshing(scene.analysisNodePlacement, analysisNodes, connectedNodeIds, mesh.elements.length > 0);
  const metadata = {
    ...mesh.metadata,
    warnings: [...placementWarnings, ...mesh.warnings],
  };
  metadata.counts = {
    ...(metadata.counts || {}),
    nodes: analysisNodes.length,
    unconnectedNodes: removedNodeIds.length,
  };
  metadata.recovery = {
    ...normalizeAnalysisMeshRecovery(metadata.recovery),
    unconnectedNodeIds: removedNodeIds,
  };
  if (removedNodeIds.length) {
    metadata.warnings.push("已排除 " + removedNodeIds.length + " 个未被任何 TRI3 单元引用的计算节点。");
  }

  const result = setAnalysisMesh(
    {
      analysisNodes,
      analysisNodePlacement: placement,
      elements: mesh.elements,
      meshMetadata: metadata,
    },
    { tolerance },
  );
  scene.mesh.metadata = normalizeAnalysisMeshMetadata(metadata);
  setCalculationLayer("analysisNodes", true, false);
  setCalculationLayer("mesh", true, false);
  updatePanel();
  render();
  renderCalculationView();
  return {
    analysisNodes: result.analysisNodes,
    elements: result.elements,
    mesh: scene.mesh.metadata,
    placement: scene.analysisNodePlacement,
    warnings: [...metadata.warnings],
  };
}

// 只构建网格，不修改 scene；任一区域失败时抛错，避免把半张网格写入求解模型。
async function buildAutomaticAnalysisMesh(options = {}) {
  const tolerance = meshClassificationTolerance(options.tolerance);
  const structureRegions = (scene.regions || [])
    .filter((region) => !isAirRegion(region) && Array.isArray(region.polygon) && region.polygon.length >= 3)
    .sort((a, b) => a.area - b.area || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  if (!structureRegions.length) {
    const warnings = ["未识别到闭合结构区域，无法自动划分 TRI3 单元。"];
    return {
      analysisNodes: scene.analysisNodes.map(cloneAnalysisMeshNode),
      elements: [],
      metadata: createAnalysisMeshMetadata([], scene.analysisNodes, {
        rawTriangleCount: 0,
        tolerance,
        warnings,
        coverage: emptyAnalysisMeshCoverage(),
        switches: "",
      }),
      warnings,
    };
  }
  if ((scene.analysisNodes || []).length < 3) {
    const warnings = ["计算节点少于 3 个，无法生成三角形单元。"];
    return {
      analysisNodes: scene.analysisNodes.map(cloneAnalysisMeshNode),
      elements: [],
      metadata: createAnalysisMeshMetadata([], scene.analysisNodes, {
        rawTriangleCount: 0,
        tolerance,
        warnings,
        coverage: emptyAnalysisMeshCoverage(),
        switches: "",
      }),
      warnings,
    };
  }

  const triangleApi = await initializeTriangleWasm();
  const analysisNodes = scene.analysisNodes.map(cloneAnalysisMeshNode);
  const registry = createTriangleNodeRegistry(analysisNodes, tolerance);
  const placementBoundaryEdges = buildPlacementBoundaryEdgeMap(scene.analysisNodePlacement);
  const elements = [];
  const coverageRegions = [];
  const switches = analysisTriangleSwitches(options);
  let rawTriangleCount = 0;

  for (const region of structureRegions) {
    const input = buildTriangleRegionInput(region, registry, placementBoundaryEdges, tolerance);
    const output = runTriangleRegion(triangleApi, input, switches);
    const parsed = parseTriangleRegionOutput(region, input, output, registry, tolerance);
    rawTriangleCount += parsed.rawTriangleCount;
    coverageRegions.push(parsed.coverage);
    for (const triangle of parsed.triangles) {
      elements.push(
        createAutomaticMeshElement(
          triangle,
          elements.length,
          registry.nodeById,
          parsed.boundaryEdgeMap,
          tolerance,
        ),
      );
    }
  }

  const finalElements = removeDuplicateMeshElements(elements);
  finalElements.forEach((element, index) => {
    element.id = "E" + (index + 1);
    element.number = index + 1;
    element.index = index + 1;
  });
  const warnings = [];
  const coverage = summarizeAnalysisMeshCoverage(coverageRegions);
  if (!finalElements.length) {
    warnings.push("Triangle 已运行，但没有生成可用的 TRI3 单元。");
  }
  const metadata = createAnalysisMeshMetadata(finalElements, analysisNodes, {
    rawTriangleCount,
    tolerance,
    warnings,
    coverage,
    switches,
  });
  return {
    analysisNodes,
    elements: finalElements,
    metadata,
    warnings,
  };
}

function cloneAnalysisMeshNode(node) {
  return {
    ...node,
    placement: node?.placement
      ? {
          ...node.placement,
          regionIds: [...(node.placement.regionIds || [])],
          curveIds: [...(node.placement.curveIds || [])],
          sources: (node.placement.sources || []).map((source) => ({ ...source })),
        }
      : null,
  };
}

function analysisTriangleSwitches(options = {}) {
  let switches = "pzQY";
  const minAngle =
    options.minAngle === false
      ? null
      : Math.min(meshFinitePositive(options.minAngle) || ANALYSIS_MESH_DEFAULT_MIN_ANGLE, 28.6);
  if (minAngle) switches += "q" + minAngle;
  const explicitArea = meshFinitePositive(options.maxArea);
  const maxEdgeLength = meshFinitePositive(options.maxEdgeLength);
  const maxArea = explicitArea || (maxEdgeLength ? (Math.sqrt(3) / 4) * maxEdgeLength * maxEdgeLength : null);
  if (maxArea) switches += "a" + maxArea;
  return switches;
}

function buildTriangleRegionInput(region, registry, placementBoundaryEdges, tolerance) {
  const contour = mapMeshBoundaryLoopToNodes(meshRegionBoundaryPolygon(region), registry, region, tolerance);
  if (contour.length < 3) {
    throw new Error(region.id + " 缺少有效的闭合外轮廓计算节点。");
  }
  const nestedHoles = meshNestedHoleRegions(region);
  const holes = nestedHoles.map((holeRegion) => {
    const loop = mapMeshBoundaryLoopToNodes(meshRegionBoundaryPolygon(holeRegion), registry, holeRegion, tolerance);
    if (loop.length < 3) {
      throw new Error(region.id + " 内部区域 " + holeRegion.id + " 缺少有效孔洞边界节点。");
    }
    return {
      region: holeRegion,
      loop,
      seed: polygonInteriorPoint(loop),
    };
  });
  const loops = [{ region, loop: contour, kind: "contour" }, ...holes.map((hole) => ({ ...hole, kind: "hole" }))];
  const nodeIds = [];
  const pointlist = [];
  const nodeIndexById = new Map();
  const addNode = (node) => {
    const id = String(node.id);
    if (nodeIndexById.has(id)) return nodeIndexById.get(id);
    const index = nodeIds.length;
    nodeIds.push(id);
    nodeIndexById.set(id, index);
    pointlist.push(Number(node.x), Number(node.y));
    return index;
  };
  loops.forEach((item) => item.loop.forEach((point) => addNode(point.node)));

  const contourPolygon = contour.map((point) => point.node);
  const holePolygons = holes.map((hole) => hole.loop.map((point) => point.node));
  const boundaryNodeIds = new Set(nodeIds);
  for (const node of registry.nodes) {
    if (boundaryNodeIds.has(String(node.id))) continue;
    if (!pointStrictlyInsidePolygon(node, contourPolygon, tolerance)) continue;
    if (holePolygons.some((polygon) => pointInPolygon(node, polygon) || pointOnPolygonBoundary(node, polygon, tolerance))) continue;
    addNode(node);
  }

  const segmentlist = [];
  const segmentmarkerlist = [];
  const markerDetails = new Map();
  let nextMarker = 1;
  for (const item of loops) {
    for (let index = 0; index < item.loop.length; index++) {
      const first = item.loop[index];
      const second = item.loop[(index + 1) % item.loop.length];
      const firstIndex = nodeIndexById.get(String(first.node.id));
      const secondIndex = nodeIndexById.get(String(second.node.id));
      if (firstIndex === secondIndex) continue;
      const marker = nextMarker++;
      segmentlist.push(firstIndex, secondIndex);
      segmentmarkerlist.push(marker);
      markerDetails.set(
        marker,
        triangleBoundaryDescriptor(first, second, item.region, placementBoundaryEdges),
      );
    }
  }

  const holelist = [];
  for (const hole of holes) {
    if (!hole.seed) {
      throw new Error(region.id + " 内部区域 " + hole.region.id + " 无法确定孔洞种子点。");
    }
    holelist.push(hole.seed.x, hole.seed.y);
  }
  const expectedArea =
    Math.abs(polygonSignedArea(contourPolygon)) -
    holePolygons.reduce((sum, polygon) => sum + Math.abs(polygonSignedArea(polygon)), 0);
  if (!(expectedArea > ANALYSIS_MESH_MIN_AREA)) {
    throw new Error(region.id + " 的有效结构面积为零或为负，请检查嵌套区域。");
  }

  return {
    pointlist,
    nodeIds,
    segmentlist,
    segmentmarkerlist,
    holelist,
    markerDetails,
    contourPolygon,
    holePolygons,
    expectedArea,
  };
}

function mapMeshBoundaryLoopToNodes(points, registry, region, tolerance) {
  const loop = [];
  const seen = new Set();
  for (const point of points || []) {
    if (!isFinitePoint(point)) continue;
    let node = point.nodeId ? registry.nodeById.get(String(point.nodeId)) : null;
    if (!node || distance(node, point) > registry.matchTolerance) {
      node = registry.find(point, registry.matchTolerance);
    }
    if (!node) {
      node = registry.create(point, {
        sourceType: "triangleBoundary",
        sourceId: point.curveId || region.id,
        curveId: point.curveId || null,
        regionId: region.id,
      });
    }
    const id = String(node.id);
    if (loop.length && String(loop[loop.length - 1].node.id) === id) continue;
    if (seen.has(id)) {
      throw new Error(region.id + " 的边界发生自交或重复经过计算节点 " + id + "。");
    }
    loop.push({
      node,
      curveId: point.curveId || node.placement?.curveId || null,
      t: Number.isFinite(Number(point.t)) ? Number(point.t) : null,
    });
    seen.add(id);
  }
  if (loop.length > 1 && String(loop[0].node.id) === String(loop[loop.length - 1].node.id)) {
    loop.pop();
  }
  if (loop.length >= 3 && Math.abs(polygonSignedArea(loop.map((point) => point.node))) <= ANALYSIS_MESH_MIN_AREA) {
    return [];
  }
  return loop;
}

function triangleBoundaryDescriptor(first, second, region, placementBoundaryEdges) {
  const key = meshNodeEdgeKey(first.node.id, second.node.id);
  const placement = placementBoundaryEdges.get(key);
  const curveId = placement?.curveId || (first.curveId === second.curveId ? first.curveId : first.curveId || second.curveId) || null;
  const curve = curveId ? curveById(curveId) : null;
  return {
    curveId,
    curveType: placement?.curveType || curve?.type || null,
    mechanicalState: normalizeMechanicalState(placement?.mechanicalState || curve?.mechanicalState),
    regionIds: uniqueStrings([...(placement?.regionIds || []), region.id]),
    tRange: placement?.tRange ? [...placement.tRange] : [first.t, second.t],
  };
}

function runTriangleRegion(api, data, switches) {
  const input = api.makeIO({
    pointlist: data.pointlist,
    segmentlist: data.segmentlist,
    segmentmarkerlist: data.segmentmarkerlist,
    holelist: data.holelist,
  });
  const output = api.makeIO();
  try {
    api.triangulate(switches, input, output);
    return {
      pointlist: Array.from(output.pointlist || []),
      trianglelist: Array.from(output.trianglelist || []),
      segmentlist: Array.from(output.segmentlist || []),
      segmentmarkerlist: Array.from(output.segmentmarkerlist || []),
      numberofpoints: Number(output.numberofpoints) || 0,
      numberoftriangles: Number(output.numberoftriangles) || 0,
      numberofcorners: Number(output.numberofcorners) || 0,
    };
  } catch (error) {
    throw new Error("Triangle 剖分失败：" + (error?.message || String(error)));
  } finally {
    api.freeIO(input, true);
    api.freeIO(output);
  }
}

function parseTriangleRegionOutput(region, input, output, registry, tolerance) {
  if (output.numberofcorners !== 3 || output.trianglelist.length !== output.numberoftriangles * 3) {
    throw new Error(region.id + " 返回了非 TRI3 或不完整的 Triangle 输出。");
  }
  const outputNodeIds = [];
  for (let index = 0; index < output.numberofpoints; index++) {
    const point = {
      x: output.pointlist[index * 2],
      y: output.pointlist[index * 2 + 1],
    };
    const preferredId = input.nodeIds[index];
    let node = preferredId ? registry.nodeById.get(String(preferredId)) : null;
    if (!node || distance(node, point) > registry.matchTolerance) {
      node = registry.find(point, registry.matchTolerance);
    }
    if (!node) {
      node = registry.create(point, {
        sourceType: "triangleSteiner",
        sourceId: region.id,
        regionId: region.id,
      });
    }
    outputNodeIds.push(String(node.id));
  }

  const boundaryEdgeMap = new Map();
  for (let index = 0; index < output.segmentlist.length; index += 2) {
    const firstId = outputNodeIds[output.segmentlist[index]];
    const secondId = outputNodeIds[output.segmentlist[index + 1]];
    if (!firstId || !secondId || firstId === secondId) continue;
    const marker = Number(output.segmentmarkerlist[index / 2]) || 0;
    const details = input.markerDetails.get(marker) || {
      curveId: null,
      curveType: null,
      mechanicalState: "free",
      regionIds: [region.id],
      tRange: null,
    };
    boundaryEdgeMap.set(meshNodeEdgeKey(firstId, secondId), {
      ...details,
      nodeIds: [firstId, secondId],
    });
  }

  const triangles = [];
  const triangleEdgeUsage = new Map();
  let meshedArea = 0;
  for (let index = 0; index < output.trianglelist.length; index += 3) {
    const nodeIds = [
      outputNodeIds[output.trianglelist[index]],
      outputNodeIds[output.trianglelist[index + 1]],
      outputNodeIds[output.trianglelist[index + 2]],
    ];
    const nodes = nodeIds.map((id) => registry.nodeById.get(id));
    if (new Set(nodeIds).size !== 3 || nodes.some((node) => !node)) {
      throw new Error(region.id + " 的 Triangle 输出引用了无效节点。");
    }
    const area = Math.abs(meshTriangleSignedArea(nodes));
    if (area <= ANALYSIS_MESH_MIN_AREA) {
      throw new Error(region.id + " 的 Triangle 输出含退化单元。");
    }
    const centroid = meshTriangleCentroid(nodes);
    if (!pointInPolygon(centroid, input.contourPolygon) || input.holePolygons.some((polygon) => pointInPolygon(centroid, polygon))) {
      throw new Error(region.id + " 的 Triangle 输出越过了结构边界或孔洞。");
    }
    const oriented = orientTriangleNodeIdsCounterClockwise(nodeIds, registry.nodeById);
    triangles.push({
      nodeIds: oriented,
      regionId: region.id,
      generationAlgorithm: ANALYSIS_MESH_ALGORITHM,
      generationSource: "triangle-wasm",
    });
    meshedArea += area;
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
      const key = meshNodeEdgeKey(oriented[edgeIndex], oriented[(edgeIndex + 1) % 3]);
      triangleEdgeUsage.set(key, (triangleEdgeUsage.get(key) || 0) + 1);
    }
  }

  const missingBoundaryEdges = [...boundaryEdgeMap.keys()].filter((key) => !triangleEdgeUsage.has(key));
  if (missingBoundaryEdges.length) {
    throw new Error(region.id + " 有 " + missingBoundaryEdges.length + " 条约束边未进入任何单元。");
  }
  const absoluteError = Math.abs(meshedArea - input.expectedArea);
  const relativeError = absoluteError / Math.max(input.expectedArea, ANALYSIS_MESH_MIN_AREA);
  if (relativeError > 1e-7 && absoluteError > Math.max(ANALYSIS_MESH_MIN_AREA * 10, tolerance * tolerance)) {
    throw new Error(
      region.id +
        " 网格覆盖校验失败：结构面积 " +
        input.expectedArea +
        "，单元面积 " +
        meshedArea +
        "。",
    );
  }
  return {
    triangles,
    rawTriangleCount: output.numberoftriangles,
    boundaryEdgeMap,
    coverage: {
      regionId: region.id,
      expectedArea: roundCoord(input.expectedArea),
      meshedArea: roundCoord(meshedArea),
      absoluteError,
      relativeError,
      boundarySegments: boundaryEdgeMap.size,
      missingBoundaryEdges: 0,
      passed: true,
    },
  };
}

function createTriangleNodeRegistry(nodes, tolerance) {
  const matchTolerance = Math.max(meshClassificationTolerance(tolerance) * 2, 1e-7);
  const bucketSize = matchTolerance;
  const buckets = new Map();
  const nodeById = new Map();
  let nextNumber = maxNumericId(nodes, "A") + 1;
  const bucketKey = (x, y) => x + ":" + y;
  const remember = (node) => {
    nodeById.set(String(node.id), node);
    const bx = Math.floor(Number(node.x) / bucketSize);
    const by = Math.floor(Number(node.y) / bucketSize);
    const key = bucketKey(bx, by);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(node);
  };
  nodes.forEach(remember);

  const registry = {
    nodes,
    nodeById,
    matchTolerance,
    find(point, limit = matchTolerance) {
      const bx = Math.floor(Number(point.x) / bucketSize);
      const by = Math.floor(Number(point.y) / bucketSize);
      const radius = Math.max(1, Math.ceil(limit / bucketSize));
      let best = null;
      let bestDistance = Infinity;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (const node of buckets.get(bucketKey(bx + dx, by + dy)) || []) {
            const value = distance(node, point);
            if (value <= limit && value < bestDistance) {
              best = node;
              bestDistance = value;
            }
          }
        }
      }
      return best;
    },
    create(point, source) {
      const node = {
        id: "A" + nextNumber++,
        x: roundCoord(Number(point.x)),
        y: roundCoord(Number(point.y)),
        ux: 0,
        uy: 0,
        mechanicalState: "free",
        placement: {
          sourceType: source.sourceType,
          sourceId: source.sourceId || null,
          geometryNodeId: null,
          curveId: source.curveId || null,
          curveT: null,
          loadId: null,
          regionId: source.regionId || null,
          regionIds: source.regionId ? [source.regionId] : [],
          curveIds: source.curveId ? [source.curveId] : [],
          sources: [{ ...source }],
        },
      };
      classifyAnalysisNode(node, tolerance);
      nodes.push(node);
      remember(node);
      return node;
    },
  };
  return registry;
}

function meshNestedHoleRegions(region) {
  const candidates = (scene.regions || []).filter((candidate) => {
    if (!candidate?.id || candidate.id === region?.id) return false;
    if (!Array.isArray(candidate.polygon) || candidate.polygon.length < 3) return false;
    if (Math.abs(Number(candidate.area) || polygonSignedArea(candidate.polygon)) >= Math.abs(Number(region.area) || polygonSignedArea(region.polygon))) {
      return false;
    }
    const seed = polygonInteriorPoint(candidate.polygon);
    return Boolean(seed && pointStrictlyInsidePolygon(seed, region.polygon, DEFAULT_CLASSIFICATION_TOLERANCE));
  });
  return candidates.filter(
    (candidate) =>
      !candidates.some((container) => {
        if (container.id === candidate.id) return false;
        const containerArea = Math.abs(Number(container.area) || polygonSignedArea(container.polygon));
        const candidateArea = Math.abs(Number(candidate.area) || polygonSignedArea(candidate.polygon));
        if (containerArea <= candidateArea) return false;
        const seed = polygonInteriorPoint(candidate.polygon);
        return Boolean(seed && pointStrictlyInsidePolygon(seed, container.polygon, DEFAULT_CLASSIFICATION_TOLERANCE));
      }),
  );
}

function polygonInteriorPoint(points) {
  const polygon = (points || []).map((point) => point.node || point).filter(isFinitePoint);
  if (polygon.length < 3) return null;
  const candidates = [];
  const signedArea = polygonSignedArea(polygon);
  const centroid = polygonCentroid(polygon, signedArea);
  if (isFinitePoint(centroid)) candidates.push(centroid);
  const average = polygon.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  candidates.push({ x: average.x / polygon.length, y: average.y / polygon.length });
  for (let index = 0; index < polygon.length; index++) {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    candidates.push({
      x: (previous.x + current.x + next.x) / 3,
      y: (previous.y + current.y + next.y) / 3,
    });
  }
  const bounds = meshPolygonBounds(polygon);
  for (let row = 1; row < 8; row++) {
    for (let column = 1; column < 8; column++) {
      candidates.push({
        x: bounds.minX + ((bounds.maxX - bounds.minX) * column) / 8,
        y: bounds.minY + ((bounds.maxY - bounds.minY) * row) / 8,
      });
    }
  }
  return (
    candidates.find(
      (point) =>
        pointInPolygon(point, polygon) &&
        !pointOnPolygonBoundary(point, polygon, DEFAULT_CLASSIFICATION_TOLERANCE),
    ) || null
  );
}

function pointStrictlyInsidePolygon(point, polygon, tolerance) {
  return pointInPolygon(point, polygon) && !pointOnPolygonBoundary(point, polygon, tolerance);
}

function meshRegionBoundaryPolygon(region) {
  const segmentsByCurveId = new Map(
    (scene.analysisNodePlacement?.boundarySegments || []).map((segment) => [segment.curveId, segment]),
  );
  const clippedBoundary = [];
  for (const span of region?.boundarySegments || []) {
    appendMeshBoundarySamples(clippedBoundary, meshRegionBoundarySpanSamples(span, segmentsByCurveId.get(span.curveId)));
  }
  if (
    clippedBoundary.length > 1 &&
    pointsClose(clippedBoundary[0], clippedBoundary[clippedBoundary.length - 1], DEFAULT_CLASSIFICATION_TOLERANCE)
  ) {
    clippedBoundary.pop();
  }
  if (clippedBoundary.length >= 3 && Math.abs(polygonSignedArea(clippedBoundary)) > ANALYSIS_MESH_MIN_AREA) {
    return clippedBoundary;
  }

  const polygon = [];
  for (const token of meshRegionBoundaryTokens(region)) {
    const segment = segmentsByCurveId.get(token.curveId);
    const samples = meshBoundarySamples(segment, token.forward);
    appendMeshBoundarySamples(polygon, samples);
  }
  if (polygon.length > 1 && pointsClose(polygon[0], polygon[polygon.length - 1], DEFAULT_CLASSIFICATION_TOLERANCE)) {
    polygon.pop();
  }
  return polygon.length >= 3 && Math.abs(polygonSignedArea(polygon)) > ANALYSIS_MESH_MIN_AREA
    ? polygon
    : Array.isArray(region?.polygon)
      ? region.polygon
      : [];
}

function meshRegionBoundarySpanSamples(span, placementSegment) {
  const t0 = Number(span?.t0);
  const t1 = Number(span?.t1);
  if (
    !span?.curveId ||
    !Number.isFinite(t0) ||
    !Number.isFinite(t1) ||
    !isFinitePoint(span.start) ||
    !isFinitePoint(span.end)
  ) {
    return [];
  }
  const lower = Math.min(t0, t1) - 1e-8;
  const upper = Math.max(t0, t1) + 1e-8;
  const interior = (placementSegment?.samples || [])
    .map((sample) => meshBoundarySamplePoint(sample, placementSegment))
    .filter(isFinitePoint)
    .filter((point) => Number.isFinite(point.t) && point.t >= lower && point.t <= upper)
    .sort((a, b) => (t1 >= t0 ? a.t - b.t : b.t - a.t));
  return [
    { ...roundPoint(span.start), curveId: span.curveId, t: t0 },
    ...interior,
    { ...roundPoint(span.end), curveId: span.curveId, t: t1 },
  ];
}

function meshRegionBoundaryTokens(region) {
  const tokens = String(region?.boundarySignature || "")
    .split("|")
    .map((token) => {
      const match = String(token || "").match(/^(.+)([+-])$/);
      return match ? { curveId: match[1], forward: match[2] !== "-" } : null;
    })
    .filter(Boolean);
  return tokens.length
    ? tokens
    : uniqueStrings(region?.boundaryCurveIds || []).map((curveId) => ({ curveId, forward: true }));
}

function meshBoundarySamples(segment, forward) {
  const samples = (segment?.samples || [])
    .map((sample) => meshBoundarySamplePoint(sample, segment))
    .filter(isFinitePoint);
  return forward ? samples : [...samples].reverse();
}

function meshBoundarySamplePoint(sample, segment = null) {
  if (Number.isFinite(Number(sample?.x)) && Number.isFinite(Number(sample?.y))) {
    return {
      x: Number(sample.x),
      y: Number(sample.y),
      nodeId: sample.nodeId ? String(sample.nodeId) : null,
      curveId: segment?.curveId || null,
      t: Number.isFinite(Number(sample.t)) ? Number(sample.t) : null,
    };
  }
  const node = analysisNodeByRef(sample?.nodeId);
  return node
    ? {
        x: node.x,
        y: node.y,
        nodeId: node.id,
        curveId: segment?.curveId || null,
        t: Number.isFinite(Number(sample?.t)) ? Number(sample.t) : null,
      }
    : null;
}

function appendMeshBoundarySamples(polygon, samples) {
  for (const point of samples || []) {
    const rounded = {
      ...roundPoint(point),
      nodeId: point.nodeId || null,
      curveId: point.curveId || null,
      t: Number.isFinite(Number(point.t)) ? Number(point.t) : null,
    };
    const previous = polygon[polygon.length - 1];
    if (!previous || !pointsClose(previous, rounded, DEFAULT_CLASSIFICATION_TOLERANCE)) {
      polygon.push(rounded);
    }
  }
}

function buildPlacementBoundaryEdgeMap(placement) {
  const edges = new Map();
  for (const segment of placement?.boundarySegments || []) {
    const samples = Array.isArray(segment.samples) ? segment.samples : [];
    for (let index = 1; index < samples.length; index++) {
      const first = samples[index - 1];
      const second = samples[index];
      if (!first.nodeId || !second.nodeId || first.nodeId === second.nodeId) continue;
      edges.set(meshNodeEdgeKey(first.nodeId, second.nodeId), {
        nodeIds: [String(first.nodeId), String(second.nodeId)],
        curveId: segment.curveId,
        curveType: segment.curveType,
        mechanicalState: normalizeMechanicalState(segment.mechanicalState),
        regionIds: uniqueStrings(segment.regionIds || []),
        tRange: [first.t, second.t],
      });
    }
  }
  return edges;
}

function createAutomaticMeshElement(triangle, index, nodeById, boundaryEdgeMap, tolerance) {
  const nodeIds = orientTriangleNodeIdsCounterClockwise(triangle.nodeIds, nodeById);
  const nodes = nodeIds.map((id) => nodeById.get(id));
  const signedArea = meshTriangleSignedArea(nodes);
  const centroid = meshTriangleCentroid(nodes);
  const explicitRegion = regionById(triangle.regionId);
  const classificationRegion =
    explicitRegion && !isAirRegion(explicitRegion) ? regionInfo(explicitRegion) : getStructureRegionAtPoint(centroid, tolerance);
  const fields = regionClassificationFields(classificationRegion);
  const edges = createMeshElementEdges(nodeIds, nodeById, boundaryEdgeMap);
  const boundaryCurveIds = uniqueStrings(edges.filter((edge) => edge.boundary).map((edge) => edge.curveId));
  const nodeStates = nodes.map((node) => normalizeMechanicalState(node.mechanicalState));
  return {
    id: "E" + (index + 1),
    number: index + 1,
    index: index + 1,
    type: "TRI3",
    analysisNodeIds: nodeIds,
    nodeIds,
    area: roundCoord(Math.abs(signedArea)),
    signedArea: roundCoord(signedArea),
    centroid: roundPoint(centroid),
    edgeLengths: edges.map((edge) => edge.length),
    edges,
    boundaryCurveIds,
    hasBoundaryEdge: boundaryCurveIds.length > 0,
    nodeStates,
    hasStaticNode: nodeStates.includes("static"),
    hasFreeNode: nodeStates.includes("free"),
    quality: meshTriangleQuality(nodes),
    generation: {
      algorithm: ANALYSIS_MESH_ALGORITHM,
      source: triangle.generationSource || "triangle-wasm",
    },
    ...fields,
  };
}

function createMeshElementEdges(nodeIds, nodeById, boundaryEdgeMap) {
  const edges = [];
  for (let index = 0; index < nodeIds.length; index++) {
    const firstId = nodeIds[index];
    const secondId = nodeIds[(index + 1) % nodeIds.length];
    const boundary = boundaryEdgeMap.get(meshNodeEdgeKey(firstId, secondId));
    edges.push({
      nodeIds: [firstId, secondId],
      length: roundCoord(distance(nodeById.get(firstId), nodeById.get(secondId))),
      boundary: Boolean(boundary),
      curveId: boundary?.curveId || null,
      curveType: boundary?.curveType || null,
      mechanicalState: boundary?.mechanicalState || null,
      regionIds: boundary ? [...boundary.regionIds] : [],
      tRange: boundary?.tRange ? [...boundary.tRange] : null,
    });
  }
  return edges;
}

function removeDuplicateMeshElements(elements) {
  const seen = new Set();
  return (elements || []).filter((element) => {
    const key =
      String(element.structureRegionId || element.regionId || "") +
      ":" +
      [...element.analysisNodeIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function meshConnectedAnalysisNodeIds(elements) {
  const nodeIds = new Set();
  for (const element of elements || []) {
    for (const nodeId of elementNodeRefs(element)) nodeIds.add(String(nodeId));
  }
  return nodeIds;
}

function updateAnalysisNodePlacementAfterMeshing(placement, nodes, connectedNodeIds, prune) {
  if (!placement) return placement;
  const keep = (nodeId) => !prune || connectedNodeIds.has(String(nodeId));
  const nodesByRegion = new Map();
  for (const node of nodes || []) {
    const regionId = node.structureRegionId || node.regionId || node.placement?.regionId;
    if (!regionId) continue;
    if (!nodesByRegion.has(regionId)) nodesByRegion.set(regionId, []);
    nodesByRegion.get(regionId).push(String(node.id));
  }
  return {
    ...placement,
    counts: placement.counts ? { ...placement.counts, analysisNodes: nodes.length } : placement.counts,
    boundarySegments: (placement.boundarySegments || []).map((segment) => ({
      ...segment,
      nodeIds: (segment.nodeIds || []).filter(keep),
      samples: (segment.samples || []).filter((sample) => sample?.nodeId && keep(sample.nodeId)),
    })),
    regionNodeSets: (placement.regionNodeSets || []).map((set) => {
      const boundaryNodeIds = (set.boundaryNodeIds || []).filter(keep);
      const boundarySet = new Set(boundaryNodeIds.map(String));
      const allNodeIds = uniqueStrings([
        ...(set.nodeIds || []).filter(keep),
        ...(nodesByRegion.get(set.regionId) || []),
      ]);
      return {
        ...set,
        boundaryNodeIds,
        interiorNodeIds: allNodeIds.filter((id) => !boundarySet.has(String(id))),
        nodeIds: allNodeIds,
      };
    }),
  };
}

function createAnalysisMeshMetadata(elements, nodes, details) {
  const regionElementSets = buildRegionElementSets(elements);
  return {
    version: ANALYSIS_MESH_VERSION,
    algorithm: ANALYSIS_MESH_ALGORITHM,
    library: {
      name: "triangle-wasm",
      version: "1.0.0",
      switches: details.switches || "",
    },
    generatedAt: new Date().toISOString(),
    stale: false,
    sourcePlacement: {
      algorithm: scene.analysisNodePlacement?.algorithm || null,
      generatedAt: scene.analysisNodePlacement?.generatedAt || null,
      spacing: scene.analysisNodePlacement?.spacing || null,
    },
    tolerance: details.tolerance,
    counts: {
      nodes: nodes.length,
      rawTriangles: details.rawTriangleCount,
      elements: elements.length,
      boundaryEdges: elements.reduce(
        (sum, element) => sum + (element.edges || []).filter((edge) => edge.boundary).length,
        0,
      ),
      structureRegions: regionElementSets.length,
      staticElements: elements.filter((element) => element.hasStaticNode).length,
      unconnectedNodes: 0,
    },
    rejected: emptyAnalysisMeshRejectedCounts(),
    recovery: normalizeAnalysisMeshRecovery(),
    coverage: details.coverage || emptyAnalysisMeshCoverage(),
    regionElementSets,
    warnings: [...(details.warnings || [])],
  };
}

function buildRegionElementSets(elements) {
  const byRegion = new Map();
  for (const element of elements || []) {
    const regionId = element.structureRegionId || element.regionId;
    if (!regionId) continue;
    if (!byRegion.has(regionId)) {
      byRegion.set(regionId, {
        regionId,
        regionKind: element.regionKind || REGION_KIND_STRUCTURE,
        materialId: element.materialId || null,
        materialName: element.materialName || "",
        elementIds: [],
        area: 0,
      });
    }
    const entry = byRegion.get(regionId);
    entry.elementIds.push(element.id);
    entry.area = roundCoord(entry.area + Math.abs(element.area || 0));
  }
  return [...byRegion.values()];
}

function emptyAnalysisMeshCoverage() {
  return {
    expectedArea: 0,
    meshedArea: 0,
    absoluteError: 0,
    relativeError: 0,
    missingBoundaryEdges: 0,
    passed: false,
    regions: [],
  };
}

function summarizeAnalysisMeshCoverage(regions) {
  const expectedArea = regions.reduce((sum, region) => sum + Number(region.expectedArea || 0), 0);
  const meshedArea = regions.reduce((sum, region) => sum + Number(region.meshedArea || 0), 0);
  const absoluteError = Math.abs(meshedArea - expectedArea);
  return {
    expectedArea: roundCoord(expectedArea),
    meshedArea: roundCoord(meshedArea),
    absoluteError,
    relativeError: absoluteError / Math.max(expectedArea, ANALYSIS_MESH_MIN_AREA),
    missingBoundaryEdges: regions.reduce((sum, region) => sum + Number(region.missingBoundaryEdges || 0), 0),
    passed: regions.length > 0 && regions.every((region) => region.passed),
    regions,
  };
}

function emptyAnalysisMeshRejectedCounts() {
  return {
    noRegion: 0,
    air: 0,
    airOverlap: 0,
    outside: 0,
    degenerate: 0,
    edgeCrossing: 0,
    longEdge: 0,
    duplicate: 0,
  };
}

function normalizeAnalysisMeshRecovery(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    recoveredBoundaryEdges: Math.max(0, Math.floor(Number(source.recoveredBoundaryEdges) || 0)),
    recoveredOrphanNodes: Math.max(0, Math.floor(Number(source.recoveredOrphanNodes) || 0)),
    recoveredCrackEdges: Math.max(0, Math.floor(Number(source.recoveredCrackEdges) || 0)),
    recoveredHoleRings: Math.max(0, Math.floor(Number(source.recoveredHoleRings) || 0)),
    recoveredHoleElements: Math.max(0, Math.floor(Number(source.recoveredHoleElements) || 0)),
    recoveredBoundaryIndentations: Math.max(0, Math.floor(Number(source.recoveredBoundaryIndentations) || 0)),
    unconnectedNodeIds: uniqueStrings(source.unconnectedNodeIds || []),
  };
}

function normalizeAnalysisMeshCoverage(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    expectedArea: meshFiniteNonNegative(raw.expectedArea) ?? 0,
    meshedArea: meshFiniteNonNegative(raw.meshedArea) ?? 0,
    absoluteError: meshFiniteNonNegative(raw.absoluteError) ?? 0,
    relativeError: meshFiniteNonNegative(raw.relativeError) ?? 0,
    missingBoundaryEdges: Math.max(0, Math.floor(Number(raw.missingBoundaryEdges) || 0)),
    passed: Boolean(raw.passed),
    regions: Array.isArray(raw.regions)
      ? raw.regions.map((region) => ({
          regionId: String(region.regionId || ""),
          expectedArea: meshFiniteNonNegative(region.expectedArea) ?? 0,
          meshedArea: meshFiniteNonNegative(region.meshedArea) ?? 0,
          absoluteError: meshFiniteNonNegative(region.absoluteError) ?? 0,
          relativeError: meshFiniteNonNegative(region.relativeError) ?? 0,
          boundarySegments: Math.max(0, Math.floor(Number(region.boundarySegments) || 0)),
          missingBoundaryEdges: Math.max(0, Math.floor(Number(region.missingBoundaryEdges) || 0)),
          passed: Boolean(region.passed),
        }))
      : [],
  };
}

function normalizeAnalysisMeshMetadata(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    version: Number(raw.version) || ANALYSIS_MESH_VERSION,
    algorithm: String(raw.algorithm || "unknown"),
    library: raw.library && typeof raw.library === "object" ? { ...raw.library } : null,
    generatedAt: String(raw.generatedAt || ""),
    stale: Boolean(raw.stale),
    staleReason: raw.staleReason ? String(raw.staleReason) : "",
    sourcePlacement: raw.sourcePlacement && typeof raw.sourcePlacement === "object" ? { ...raw.sourcePlacement } : null,
    tolerance: meshFiniteNonNegative(raw.tolerance) ?? DEFAULT_CLASSIFICATION_TOLERANCE,
    counts: raw.counts && typeof raw.counts === "object" ? { ...raw.counts } : null,
    rejected: raw.rejected && typeof raw.rejected === "object" ? { ...raw.rejected } : null,
    recovery: normalizeAnalysisMeshRecovery(raw.recovery),
    coverage: normalizeAnalysisMeshCoverage(raw.coverage),
    regionElementSets: Array.isArray(raw.regionElementSets)
      ? raw.regionElementSets.map((set) => ({
          regionId: String(set.regionId || ""),
          regionKind: normalizeRegionKind(set.regionKind),
          materialId: set.materialId ? String(set.materialId) : null,
          materialName: String(set.materialName || ""),
          elementIds: uniqueStrings(set.elementIds || []),
          area: meshFiniteNonNegative(set.area) ?? 0,
        }))
      : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
  };
}

function markAnalysisMeshStale(reason = "geometryChanged") {
  if (!scene.mesh?.metadata) return;
  scene.mesh.metadata.stale = true;
  scene.mesh.metadata.staleReason = reason;
}

function orientTriangleNodeIdsCounterClockwise(nodeIds, nodeById) {
  const nodes = nodeIds.map((id) => nodeById.get(String(id)));
  return meshTriangleSignedArea(nodes) >= 0 ? [...nodeIds] : [nodeIds[0], nodeIds[2], nodeIds[1]];
}

function meshTriangleSignedArea(nodes) {
  return polygonSignedArea(nodes.map((node) => ({ x: node.x, y: node.y })));
}

function meshTriangleCentroid(nodes) {
  return {
    x: (nodes[0].x + nodes[1].x + nodes[2].x) / 3,
    y: (nodes[0].y + nodes[1].y + nodes[2].y) / 3,
  };
}

function meshTriangleQuality(nodes) {
  const lengths = [
    distance(nodes[0], nodes[1]),
    distance(nodes[1], nodes[2]),
    distance(nodes[2], nodes[0]),
  ];
  const area = Math.abs(meshTriangleSignedArea(nodes));
  const lengthSquares = lengths.reduce((sum, length) => sum + length * length, 0);
  const sortedLengths = [...lengths].sort((a, b) => a - b);
  const angles = [
    meshAngleDegrees(nodes[0], nodes[1], nodes[2]),
    meshAngleDegrees(nodes[1], nodes[2], nodes[0]),
    meshAngleDegrees(nodes[2], nodes[0], nodes[1]),
  ];
  return {
    minAngle: roundCoord(Math.min(...angles)),
    maxAngle: roundCoord(Math.max(...angles)),
    aspectRatio: roundCoord(sortedLengths[2] / Math.max(sortedLengths[0], ANALYSIS_NODE_MIN_SPACING)),
    shapeQuality: roundCoord((4 * Math.sqrt(3) * area) / Math.max(lengthSquares, ANALYSIS_NODE_MIN_SPACING)),
  };
}

function meshAngleDegrees(origin, first, second) {
  const a = { x: first.x - origin.x, y: first.y - origin.y };
  const b = { x: second.x - origin.x, y: second.y - origin.y };
  const denominator = Math.max(Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y), ANALYSIS_NODE_MIN_SPACING);
  return (Math.acos(clamp((a.x * b.x + a.y * b.y) / denominator, -1, 1)) * 180) / Math.PI;
}

function meshPolygonBounds(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function meshNodeEdgeKey(first, second) {
  return [String(first), String(second)]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .join("|");
}

function meshClassificationTolerance(value) {
  return meshFiniteNonNegative(value) ?? DEFAULT_CLASSIFICATION_TOLERANCE;
}

function meshFinitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function meshFiniteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
