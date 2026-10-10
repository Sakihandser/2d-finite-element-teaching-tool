const ANALYSIS_NODE_PLACEMENT_VERSION = 2;
const DEFAULT_MAX_ANALYSIS_NODES = 2000;
const ANALYSIS_NODE_GRID_ROW_FACTOR = Math.sqrt(3) / 2;
const ANALYSIS_NODE_MIN_SPACING = 1e-6;
const ANALYSIS_NODE_MAX_ATTEMPTS = 8;
const ANALYSIS_NODE_MIN_AIR_BOUNDARY_DIVISIONS = 12;
const ANALYSIS_NODE_MIN_LIMIT_WITH_AIR = 240;

// 计算页入口：根据当前结构几何自动生成计算节点，并清空旧单元。
function autoPlaceAnalysisNodes(options = {}) {
  rebuildDerivedRegions();
  const placement = buildAutomaticAnalysisNodePlacement({
    maxNodes: options.maxNodes ?? readAnalysisNodeLimit(),
    spacing: options.spacing,
    tolerance: options.tolerance,
  });
  const result = setAnalysisMesh(
    {
      analysisNodes: placement.analysisNodes,
      elements: [],
      analysisNodePlacement: placement.metadata,
    },
    {
      tolerance: placement.classificationTolerance,
    },
  );
  scene.analysisNodePlacement = placement.metadata;
  setCalculationLayer("analysisNodes", true, false);
  updatePanel();
  render();
  renderCalculationView();
  return {
    analysisNodes: result.analysisNodes,
    elements: result.elements,
    placement: scene.analysisNodePlacement,
    warnings: [...placement.warnings],
  };
}

// 只构建布点结果，不写入 scene。后续自动网格划分器可先调用它取得节点云和边界种子。
function buildAutomaticAnalysisNodePlacement(options = {}) {
  const maxNodes = normalizeAnalysisNodeLimit(options.maxNodes);
  const topology = collectAnalysisPlacementTopology();
  const warnings = [];
  if (!topology.mandatoryGeometryNodes.length && !topology.curves.length && !topology.structureRegions.length) {
    const metadata = createAnalysisNodePlacementMetadata(topology, [], [], [], {
      maxNodes,
      effectiveMaxNodes: maxNodes,
      spacing: 0,
      classificationTolerance: DEFAULT_CLASSIFICATION_TOLERANCE,
      warnings: ["当前没有可布置计算节点的结构几何。"],
    });
    return {
      analysisNodes: [],
      boundarySegments: [],
      regionNodeSets: [],
      metadata,
      spacing: 0,
      classificationTolerance: DEFAULT_CLASSIFICATION_TOLERANCE,
      warnings: [...metadata.warnings],
    };
  }

  const mandatoryBoundaryKnotCount = [...topology.boundaryKnotsByCurve.values()].reduce((sum, knots) => sum + knots.length, 0);
  const mandatoryCount = topology.mandatoryGeometryNodes.length + topology.pointLoadAnchors.length + mandatoryBoundaryKnotCount;
  const safeMinimum = minimumAnalysisNodeLimitForTopology(topology);
  const effectiveMaxNodes = Math.max(maxNodes, mandatoryCount, safeMinimum);
  const requestedSpacing = finitePositiveNumber(options.spacing);
  let spacing = requestedSpacing || estimateAnalysisNodeSpacing(topology, effectiveMaxNodes);
  let generated = null;

  for (let attempt = 0; attempt < ANALYSIS_NODE_MAX_ATTEMPTS; attempt++) {
    generated = generateAnalysisNodeCandidates(topology, {
      spacing,
      effectiveMaxNodes,
    });
    if (requestedSpacing || generated.analysisNodes.length <= effectiveMaxNodes) {
      break;
    }
    const ratio = generated.analysisNodes.length / Math.max(effectiveMaxNodes, 1);
    spacing *= Math.max(1.12, Math.sqrt(ratio) * 1.08);
  }

  if (!generated) {
    generated = generateAnalysisNodeCandidates(topology, { spacing, effectiveMaxNodes });
  }

  if (!topology.structureRegions.length) {
    warnings.push("未识别到闭合结构区域，本次只沿现有几何边界和几何节点布置计算节点。");
  }
  if (mandatoryCount > maxNodes) {
    warnings.push(`几何特征点数量超过节点上限，已保留 ${effectiveMaxNodes} 个必要节点。`);
  } else if (safeMinimum > maxNodes) {
    warnings.push(`检测到内部空气孔洞，本次有效节点上限已提高到 ${effectiveMaxNodes}，避免粗网格穿过孔洞。`);
  }
  if (generated.skippedInteriorCount > 0) {
    warnings.push(`节点上限已达到，跳过 ${generated.skippedInteriorCount} 个内部候选点。`);
  }

  const classificationTolerance = finiteNonNegativeNumber(options.tolerance) ?? DEFAULT_CLASSIFICATION_TOLERANCE;
  generated.analysisNodes.forEach((node, index) => {
    node.id = `A${index + 1}`;
    classifyAnalysisNode(node, classificationTolerance);
  });
  finalizeAnalysisBoundarySegments(generated.boundarySegments);
  const regionNodeSets = buildAnalysisRegionNodeSets(topology, generated.analysisNodes, generated.boundarySegments);
  const allWarnings = [...warnings, ...generated.warnings];
  const metadata = createAnalysisNodePlacementMetadata(topology, generated.analysisNodes, generated.boundarySegments, regionNodeSets, {
    maxNodes,
    effectiveMaxNodes,
    spacing,
    classificationTolerance,
    warnings: allWarnings,
  });

  return {
    analysisNodes: generated.analysisNodes,
    boundarySegments: generated.boundarySegments,
    regionNodeSets,
    metadata,
    spacing,
    classificationTolerance,
    warnings: allWarnings,
  };
}

// 汇总当前几何拓扑：结构面域、应采样边界、必须保留的几何节点和点载荷锚点。
function collectAnalysisPlacementTopology() {
  const structureRegions = (scene.regions || [])
    .filter((region) => !isAirRegion(region) && Array.isArray(region.polygon) && region.polygon.length >= 3)
    .sort((a, b) => a.area - b.area || a.id.localeCompare(b.id));
  const airRegions = (scene.regions || [])
    .filter((region) => isAirRegion(region) && Array.isArray(region.polygon) && region.polygon.length >= 3)
    .filter((region) => airRegionTouchesStructureDomain(region, structureRegions));
  const boundaryRegionIds = new Set([...structureRegions, ...airRegions].map((region) => region.id));
  const boundaryCurveIds = new Set();
  for (const region of [...structureRegions, ...airRegions]) {
    for (const curveId of region.boundaryCurveIds || []) {
      boundaryCurveIds.add(curveId);
    }
  }
  if (!structureRegions.length) {
    for (const curve of scene.curves || []) {
      boundaryCurveIds.add(curve.id);
    }
  }

  const curves = [...boundaryCurveIds].map(curveById).filter(Boolean);
  const boundaryKnotsByCurve = collectAnalysisBoundaryKnots([...structureRegions, ...airRegions], boundaryCurveIds);
  const boundaryGeometryNodeIds = new Set();
  for (const curve of curves) {
    for (const nodeId of curve.geometryNodeIds || []) {
      boundaryGeometryNodeIds.add(nodeId);
    }
  }

  const mandatoryGeometryNodes = (scene.geometryNodes || []).filter((node) => {
    if (boundaryGeometryNodeIds.has(node.id)) return true;
    return pointBelongsToStructuralDomain(node, structureRegions, airRegions);
  });
  const pointLoadAnchors = collectPointLoadAnchors(structureRegions, airRegions);
  const bounds = analysisPlacementBounds(structureRegions, curves, mandatoryGeometryNodes, pointLoadAnchors);
  const totalStructureArea = structureRegions.reduce((sum, region) => sum + Math.max(Number(region.area) || 0, 0), 0);
  const totalBoundaryLength = curves.reduce((sum, curve) => sum + approximateCurveLength(curve), 0);

  return {
    structureRegions,
    airRegions,
    boundaryRegionIds,
    boundaryCurveIds,
    curves,
    boundaryKnotsByCurve,
    mandatoryGeometryNodes,
    pointLoadAnchors,
    bounds,
    totalStructureArea,
    totalBoundaryLength,
  };
}

// 内部空气区域也要贡献边界节点；只在它位于结构域内时才作为洞边界处理。
function airRegionTouchesStructureDomain(airRegion, structureRegions) {
  if (!structureRegions.length) return false;
  const samples = airRegionStructuralTouchSamples(airRegion);
  return samples.some((point) =>
    structureRegions.some((region) => region.id !== airRegion.id && pointInRegion(point, region, DEFAULT_CLASSIFICATION_TOLERANCE)),
  );
}

function airRegionStructuralTouchSamples(airRegion) {
  const samples = [];
  const addSample = (point) => {
    if (!isFinitePoint(point)) return;
    const rounded = roundPoint(point);
    if (samples.some((sample) => pointsClose(sample, rounded, DEFAULT_CLASSIFICATION_TOLERANCE))) return;
    samples.push(rounded);
  };

  addSample(airRegion?.centroid);
  const polygon = Array.isArray(airRegion?.polygon) ? airRegion.polygon : [];
  for (let i = 0; i < polygon.length; i++) {
    const point = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    addSample(point);
    if (isFinitePoint(point) && isFinitePoint(next)) {
      addSample(midpoint(point, next));
    }
  }
  for (const curveId of airRegion?.boundaryCurveIds || []) {
    const curve = curveById(curveId);
    if (!curve) continue;
    for (const point of sampleCurve(curve, curve.type === "line" ? 1 : 16)) {
      addSample(point);
    }
  }
  return samples;
}

function collectPointLoadAnchors(structureRegions, airRegions = []) {
  const anchors = [];
  for (const load of scene.pointLoads || []) {
    const anchor = loadAnchorPoint(load);
    if (!anchor || !pointBelongsToStructuralDomain(anchor, structureRegions, airRegions)) continue;
    anchors.push({
      id: load.id,
      x: anchor.x,
      y: anchor.y,
    });
  }
  return anchors;
}

function loadAnchorPoint(load) {
  if (load?.geometryNodeId) {
    const node = geometryNodeById(load.geometryNodeId);
    if (node) return { x: node.x, y: node.y };
  }
  if (isFinitePoint(load?.anchor)) {
    return { x: load.anchor.x, y: load.anchor.y };
  }
  return null;
}

function pointBelongsToStructuralDomain(point, structureRegions, airRegions = []) {
  if (!structureRegions.length) return true;
  if (pointInsideAnyPlacementAirRegion(point, airRegions, DEFAULT_CLASSIFICATION_TOLERANCE)) return false;
  const region = getStructureRegionAtPoint(point, DEFAULT_CLASSIFICATION_TOLERANCE);
  if (region && !isAirRegion(region)) return true;
  return structureRegions.some((candidate) => pointOnPolygonBoundary(point, candidate.polygon || [], DEFAULT_CLASSIFICATION_TOLERANCE));
}

function minimumAnalysisNodeLimitForTopology(topology) {
  return topology.airRegions?.length ? ANALYSIS_NODE_MIN_LIMIT_WITH_AIR : 0;
}

function analysisPlacementBounds(structureRegions, curves, geometryNodes, pointLoadAnchors) {
  const points = [];
  for (const region of structureRegions) {
    points.push(...(region.polygon || []));
  }
  for (const curve of curves) {
    points.push(...sampleCurve(curve, curve.type === "line" ? 1 : 24));
  }
  points.push(...geometryNodes, ...pointLoadAnchors);
  const finitePoints = points.filter(isFinitePoint);
  if (!finitePoints.length) {
    return null;
  }
  return {
    minX: Math.min(...finitePoints.map((point) => point.x)),
    maxX: Math.max(...finitePoints.map((point) => point.x)),
    minY: Math.min(...finitePoints.map((point) => point.y)),
    maxY: Math.max(...finitePoints.map((point) => point.y)),
  };
}

function estimateAnalysisNodeSpacing(topology, maxNodes) {
  const bounds = topology.bounds || { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  const width = Math.max(bounds.maxX - bounds.minX, ANALYSIS_NODE_MIN_SPACING);
  const height = Math.max(bounds.maxY - bounds.minY, ANALYSIS_NODE_MIN_SPACING);
  const diagonal = Math.max(Math.hypot(width, height), ANALYSIS_NODE_MIN_SPACING);
  const area = topology.totalStructureArea || width * height || diagonal * diagonal;
  const targetInterior = Math.max(1, Math.floor(maxNodes * 0.78));
  const targetBoundary = Math.max(1, Math.floor(maxNodes * 0.22));
  const areaSpacing = Math.sqrt((2 * area) / (Math.sqrt(3) * targetInterior));
  const boundarySpacing = topology.totalBoundaryLength > 0 ? topology.totalBoundaryLength / targetBoundary : 0;
  return Math.max(ANALYSIS_NODE_MIN_SPACING, diagonal / 800, areaSpacing, boundarySpacing);
}

function generateAnalysisNodeCandidates(topology, options) {
  const spacing = Math.max(finitePositiveNumber(options.spacing) || ANALYSIS_NODE_MIN_SPACING, ANALYSIS_NODE_MIN_SPACING);
  const effectiveMaxNodes = Math.max(1, Math.floor(options.effectiveMaxNodes || DEFAULT_MAX_ANALYSIS_NODES));
  const candidates = [];
  const warnings = [];
  const boundarySegments = [];
  const mergeTolerance = Math.max(1e-8, Math.min(spacing * 0.08, DEFAULT_CLASSIFICATION_TOLERANCE));
  let skippedInteriorCount = 0;

  const addCandidate = (point, source, force = false) => {
    if (!isFinitePoint(point)) return null;
    const rounded = roundPoint(point);
    const existing = findAnalysisCandidateNear(candidates, rounded, mergeTolerance);
    if (existing) {
      mergeAnalysisCandidateSource(existing, source);
      return existing;
    }
    if (!force && candidates.length >= effectiveMaxNodes) return null;
    const candidate = {
      id: "",
      x: rounded.x,
      y: rounded.y,
      placementSources: [],
      regionIds: new Set(),
      curveIds: new Set(),
    };
    mergeAnalysisCandidateSource(candidate, source);
    candidates.push(candidate);
    return candidate;
  };

  for (const node of topology.mandatoryGeometryNodes) {
    addCandidate(
      node,
      {
        sourceType: "geometryNode",
        sourceId: node.id,
        geometryNodeId: node.id,
        regionId: getStructureRegionAtPoint(node, DEFAULT_CLASSIFICATION_TOLERANCE)?.id || null,
      },
      true,
    );
  }

  for (const anchor of topology.pointLoadAnchors) {
    addCandidate(
      anchor,
      {
        sourceType: "pointLoad",
        sourceId: anchor.id,
        loadId: anchor.id,
        regionId: getStructureRegionAtPoint(anchor, DEFAULT_CLASSIFICATION_TOLERANCE)?.id || null,
      },
      true,
    );
  }

  for (const curve of topology.curves) {
    const length = approximateCurveLength(curve);
    const divisionCount = analysisBoundaryDivisionCount(curve, length, spacing, topology);
    const boundaryKnots = topology.boundaryKnotsByCurve.get(curve.id) || [];
    const sampleParameters = uniqueAnalysisBoundaryParameters([
      ...Array.from({ length: divisionCount + 1 }, (_, index) => index / divisionCount),
      ...boundaryKnots.map((knot) => knot.t),
    ]);
    const segment = {
      curveId: curve.id,
      curveType: curve.type,
      mechanicalState: normalizeMechanicalState(curve.mechanicalState),
      length: roundCoord(length),
      regionIds: curveAdjacentPlacementRegionIds(curve.id),
      nodeIds: [],
      samples: [],
    };
    for (const t of sampleParameters) {
      const knot = boundaryKnots.find((candidate) => Math.abs(candidate.t - t) <= 1e-9) || null;
      const point = knot?.point || pointOnCurve(curve, t);
      const region = getStructureRegionAtPoint(point, DEFAULT_CLASSIFICATION_TOLERANCE);
      const candidate = addCandidate(point, {
        sourceType: "curveBoundary",
        sourceId: curve.id,
        curveId: curve.id,
        curveT: roundCoord(t),
        regionId: knot?.regionIds?.[0] || region?.id || null,
      }, Boolean(knot));
      if (candidate) {
        for (const regionId of knot?.regionIds || []) {
          mergeAnalysisCandidateSource(candidate, {
            sourceType: "regionBoundaryIntersection",
            sourceId: `${curve.id}:${roundCoord(t)}:${regionId}`,
            curveId: curve.id,
            curveT: roundCoord(t),
            regionId,
          });
        }
        segment.samples.push({
          candidate,
          t: roundCoord(t),
        });
      }
    }
    boundarySegments.push(segment);
  }
  addAirBoundaryGuardCandidates(topology, boundarySegments, spacing, addCandidate);

  if (topology.structureRegions.length) {
    for (const region of topology.structureRegions) {
      addRegionInteriorCandidates(region, spacing, topology.curves, topology.airRegions, effectiveMaxNodes, candidates, addCandidate, (count) => {
        skippedInteriorCount += count;
      });
    }
  } else if (!topology.curves.length && candidates.length) {
    warnings.push("当前只有离散几何节点，未生成内部节点。");
  }

  const safeCandidates = candidates.filter((candidate) => analysisCandidateAllowedInStructuralDomain(candidate, topology));
  const removedAirCandidateCount = candidates.length - safeCandidates.length;
  if (removedAirCandidateCount > 0) {
    warnings.push(`已排除 ${removedAirCandidateCount} 个落入空气孔洞的自动候选节点。`);
  }

  safeCandidates.forEach((candidate, index) => {
    candidate.id = `A${index + 1}`;
  });
  const analysisNodes = safeCandidates.map(candidateToAnalysisNode);
  return {
    analysisNodes,
    boundarySegments,
    skippedInteriorCount,
    warnings,
  };
}

// 区域识别会在曲线交点处分割边界；这些分割点必须成为共享计算节点，否则各区域独立剖分时会用弦跨过交点并切掉材料。
function collectAnalysisBoundaryKnots(regions, boundaryCurveIds) {
  const knotsByCurve = new Map();
  for (const region of regions || []) {
    for (const span of region?.boundarySegments || []) {
      if (!boundaryCurveIds.has(span?.curveId)) continue;
      for (const [rawT, point] of [
        [span.t0, span.start],
        [span.t1, span.end],
      ]) {
        const t = Number(rawT);
        if (!Number.isFinite(t) || !isFinitePoint(point)) continue;
        if (!knotsByCurve.has(span.curveId)) knotsByCurve.set(span.curveId, []);
        const knots = knotsByCurve.get(span.curveId);
        let knot = knots.find((candidate) => Math.abs(candidate.t - t) <= 1e-9 || pointsClose(candidate.point, point, DEFAULT_CLASSIFICATION_TOLERANCE));
        if (!knot) {
          knot = {
            t: clamp(t, 0, 1),
            point: roundPoint(point),
            regionIds: [],
          };
          knots.push(knot);
        }
        if (region.id && !knot.regionIds.includes(region.id)) knot.regionIds.push(region.id);
      }
    }
  }
  for (const knots of knotsByCurve.values()) {
    knots.sort((a, b) => a.t - b.t);
  }
  return knotsByCurve;
}

function uniqueAnalysisBoundaryParameters(values) {
  return values
    .map((value) => clamp(Number(value), 0, 1))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .filter((value, index, sorted) => index === 0 || Math.abs(value - sorted[index - 1]) > 1e-9);
}

function addRegionInteriorCandidates(region, spacing, boundaryCurves, airRegions, effectiveMaxNodes, candidates, addCandidate, onSkipped) {
  const polygon = Array.isArray(region.polygon) ? region.polygon : [];
  if (polygon.length < 3) return;
  const bounds = polygonBounds(polygon);
  const rowHeight = spacing * ANALYSIS_NODE_GRID_ROW_FACTOR;
  const boundaryClearance = spacing * 0.45;
  let skipped = 0;
  addInteriorCandidate(region.centroid, {
    sourceType: "regionCentroid",
    sourceId: region.id,
    regionId: region.id,
  });
  let row = 0;
  for (let y = bounds.minY; y <= bounds.maxY + rowHeight * 0.5; y += rowHeight) {
    const offset = row % 2 ? spacing * 0.5 : 0;
    for (let x = bounds.minX + offset; x <= bounds.maxX + spacing * 0.5; x += spacing) {
      const point = { x, y };
      if (!pointAllowedForRegionInteriorCandidate(point, region, airRegions, DEFAULT_CLASSIFICATION_TOLERANCE)) continue;
      if (distanceToAnyPlacementBoundary(point, boundaryCurves) < boundaryClearance) continue;
      if (candidates.length >= effectiveMaxNodes) {
        skipped++;
        continue;
      }
      addInteriorCandidate(point, {
        sourceType: "regionInterior",
        sourceId: region.id,
        regionId: region.id,
      });
    }
    row++;
  }
  if (skipped > 0) {
    onSkipped(skipped);
  }

  function addInteriorCandidate(point, source) {
    if (!pointAllowedForRegionInteriorCandidate(point, region, airRegions, DEFAULT_CLASSIFICATION_TOLERANCE)) return null;
    return addCandidate(point, source);
  }
}

function analysisBoundaryDivisionCount(curve, length, spacing, topology) {
  const baseCount = Math.max(1, Math.ceil(length / spacing));
  if (curve.type === "line" || !curveBoundsAirRegion(curve.id, topology.airRegions)) {
    return baseCount;
  }
  return Math.max(baseCount, ANALYSIS_NODE_MIN_AIR_BOUNDARY_DIVISIONS);
}

function curveBoundsAirRegion(curveId, airRegions = []) {
  return airRegions.some((region) => (region.boundaryCurveIds || []).includes(curveId));
}

function addAirBoundaryGuardCandidates(topology, boundarySegments, spacing, addCandidate) {
  if (!topology.airRegions?.length || !topology.structureRegions?.length) return;
  const guardDistance = Math.max(spacing * 0.28, DEFAULT_CLASSIFICATION_TOLERANCE * 4);
  for (const airRegion of topology.airRegions) {
    for (const segment of boundarySegments.filter((item) => (airRegion.boundaryCurveIds || []).includes(item.curveId))) {
      const samples = segment.samples || [];
      for (let index = 1; index < samples.length; index++) {
        const first = samples[index - 1].candidate;
        const second = samples[index].candidate;
        if (!isFinitePoint(first) || !isFinitePoint(second)) continue;
        const sourcePoint = midpoint(first, second);
        const directions = airBoundaryEdgeGuardDirections(first, second, sourcePoint, airRegion);
        const guard = structureSideAirBoundaryGuardPoint(sourcePoint, directions, topology, guardDistance);
        if (!guard) continue;
        addCandidate(guard.point, {
          sourceType: "airBoundaryGuard",
          sourceId: `${segment.curveId}:${samples[index - 1].t}-${samples[index].t}`,
          regionId: guard.region.id,
        });
      }
    }
  }
}

function structureSideAirBoundaryGuardPoint(sourcePoint, directions, topology, guardDistance) {
  const distances = [guardDistance, guardDistance * 1.8, guardDistance * 2.8];
  for (const distanceValue of distances) {
    for (const direction of directions) {
      const point = {
        x: sourcePoint.x + direction.x * distanceValue,
        y: sourcePoint.y + direction.y * distanceValue,
      };
      const region = structureRegionForPlacementPoint(point, topology.structureRegions, topology.airRegions, DEFAULT_CLASSIFICATION_TOLERANCE);
      if (region) {
        return { point, region };
      }
    }
  }
  return null;
}

function airBoundaryEdgeGuardDirections(first, second, sourcePoint, airRegion) {
  const tangent = normalize(
    {
      x: second.x - first.x,
      y: second.y - first.y,
    },
    { x: 1, y: 0 },
  );
  const normalA = { x: -tangent.y, y: tangent.x };
  const normalB = { x: tangent.y, y: -tangent.x };
  const radial = normalize(
    {
      x: sourcePoint.x - (airRegion.centroid?.x ?? sourcePoint.x),
      y: sourcePoint.y - (airRegion.centroid?.y ?? sourcePoint.y),
    },
    normalA,
  );
  return uniqueDirectionVectors([normalA, normalB, radial, { x: -radial.x, y: -radial.y }]);
}

function uniqueDirectionVectors(vectors) {
  const unique = [];
  for (const vector of vectors) {
    const length = Math.hypot(vector?.x || 0, vector?.y || 0);
    if (length < 1e-9) continue;
    const unit = { x: vector.x / length, y: vector.y / length };
    if (unique.some((candidate) => Math.abs(candidate.x - unit.x) < 1e-6 && Math.abs(candidate.y - unit.y) < 1e-6)) continue;
    unique.push(unit);
  }
  return unique;
}

function pointAllowedForRegionInteriorCandidate(point, region, airRegions, tolerance) {
  if (!isFinitePoint(point)) return false;
  const ownerRegion = structureRegionForPlacementPoint(point, [region], airRegions, tolerance);
  return Boolean(ownerRegion && ownerRegion.id === region.id);
}

function analysisCandidateAllowedInStructuralDomain(candidate, topology) {
  if (candidate.curveIds?.size > 0) return true;
  return pointBelongsToStructuralDomain(candidate, topology.structureRegions, topology.airRegions);
}

function structureRegionForPlacementPoint(point, structureRegions, airRegions, tolerance) {
  if (!isFinitePoint(point) || pointInsideAnyPlacementAirRegion(point, airRegions, tolerance)) return null;
  const ownerRegion = getStructureRegionAtPoint(point, tolerance);
  if (ownerRegion && !isAirRegion(ownerRegion) && structureRegions.some((region) => region.id === ownerRegion.id)) {
    return regionById(ownerRegion.id) || ownerRegion;
  }
  return (
    structureRegions.find((region) => {
      const polygon = Array.isArray(region.polygon) ? region.polygon : [];
      return polygon.length >= 3 && pointInRegion(point, region, tolerance);
    }) || null
  );
}

function pointInsideAnyPlacementAirRegion(point, airRegions = [], tolerance = DEFAULT_CLASSIFICATION_TOLERANCE) {
  return airRegions.some((region) => pointStrictlyInsidePlacementRegion(point, region, tolerance));
}

function pointStrictlyInsidePlacementRegion(point, region, tolerance) {
  const polygon = Array.isArray(region?.polygon) ? region.polygon : [];
  if (polygon.length < 3 || !pointInPolygon(point, polygon)) return false;
  return !pointOnPolygonBoundary(point, polygon, tolerance);
}

function candidateToAnalysisNode(candidate) {
  const placement = placementForCandidate(candidate);
  return {
    id: candidate.id,
    x: candidate.x,
    y: candidate.y,
    ux: 0,
    uy: 0,
    mechanicalState: "free",
    placement,
  };
}

function placementForCandidate(candidate) {
  const sources = [...candidate.placementSources].sort(comparePlacementSources);
  const primary = sources[0] || { sourceType: "generated", sourceId: "" };
  return {
    sourceType: primary.sourceType,
    sourceId: primary.sourceId || null,
    geometryNodeId: primary.geometryNodeId || null,
    curveId: primary.curveId || null,
    curveT: finiteOrNull(primary.curveT),
    loadId: primary.loadId || null,
    regionId: primary.regionId || [...candidate.regionIds][0] || null,
    regionIds: [...candidate.regionIds],
    curveIds: [...candidate.curveIds],
    sources: sources.map((source) => ({
      sourceType: source.sourceType,
      sourceId: source.sourceId || null,
      geometryNodeId: source.geometryNodeId || null,
      curveId: source.curveId || null,
      curveT: finiteOrNull(source.curveT),
      loadId: source.loadId || null,
      regionId: source.regionId || null,
    })),
  };
}

function comparePlacementSources(a, b) {
  return placementSourcePriority(a.sourceType) - placementSourcePriority(b.sourceType) || String(a.sourceId || "").localeCompare(String(b.sourceId || ""), undefined, { numeric: true });
}

function placementSourcePriority(sourceType) {
  if (sourceType === "geometryNode") return 0;
  if (sourceType === "pointLoad") return 1;
  if (sourceType === "regionBoundaryIntersection") return 2;
  if (sourceType === "curveBoundary") return 3;
  if (sourceType === "regionCentroid") return 4;
  if (sourceType === "airBoundaryGuard") return 5;
  if (sourceType === "regionInterior") return 6;
  return 9;
}

function mergeAnalysisCandidateSource(candidate, source = {}) {
  const normalized = normalizeAnalysisPlacementSource(source);
  const key = analysisPlacementSourceKey(normalized);
  if (!candidate.placementSources.some((item) => analysisPlacementSourceKey(item) === key)) {
    candidate.placementSources.push(normalized);
  }
  if (normalized.regionId) {
    candidate.regionIds.add(normalized.regionId);
  }
  if (normalized.curveId) {
    candidate.curveIds.add(normalized.curveId);
  }
}

function normalizeAnalysisPlacementSource(source = {}) {
  return {
    sourceType: String(source.sourceType || source.type || "generated"),
    sourceId: source.sourceId !== undefined && source.sourceId !== null ? String(source.sourceId) : null,
    geometryNodeId: source.geometryNodeId ? String(source.geometryNodeId) : null,
    curveId: source.curveId ? String(source.curveId) : null,
    curveT: finiteOrNull(source.curveT),
    loadId: source.loadId ? String(source.loadId) : null,
    regionId: source.regionId ? String(source.regionId) : null,
  };
}

function analysisPlacementSourceKey(source) {
  return [source.sourceType, source.sourceId, source.geometryNodeId, source.curveId, source.curveT, source.loadId, source.regionId].join(":");
}

function findAnalysisCandidateNear(candidates, point, tolerance) {
  return candidates.find((candidate) => distance(candidate, point) <= tolerance) || null;
}

function finalizeAnalysisBoundarySegments(boundarySegments) {
  for (const segment of boundarySegments) {
    segment.samples = segment.samples
      .filter((sample) => sample.candidate?.id)
      .map((sample) => ({
        nodeId: sample.candidate.id,
        t: sample.t,
        x: sample.candidate.x,
        y: sample.candidate.y,
      }));
    segment.nodeIds = uniqueStrings(segment.samples.map((sample) => sample.nodeId));
  }
}

function buildAnalysisRegionNodeSets(topology, analysisNodes, boundarySegments) {
  const boundaryNodeIdsByRegion = new Map();
  for (const segment of boundarySegments) {
    for (const regionId of segment.regionIds || []) {
      if (!boundaryNodeIdsByRegion.has(regionId)) {
        boundaryNodeIdsByRegion.set(regionId, new Set());
      }
      const bucket = boundaryNodeIdsByRegion.get(regionId);
      for (const nodeId of segment.nodeIds || []) {
        bucket.add(nodeId);
      }
    }
  }

  return topology.structureRegions.map((region) => {
    const boundaryNodeIds = [...(boundaryNodeIdsByRegion.get(region.id) || new Set())];
    const nodeIds = analysisNodes
      .filter((node) => node.placement?.regionIds?.includes(region.id) || node.structureRegionId === region.id)
      .map((node) => node.id);
    const interiorNodeIds = nodeIds.filter((nodeId) => !boundaryNodeIds.includes(nodeId));
    return {
      regionId: region.id,
      regionKind: REGION_KIND_STRUCTURE,
      materialId: region.materialId || null,
      materialName: region.materialName || "",
      boundaryCurveIds: [...(region.boundaryCurveIds || [])],
      boundaryNodeIds,
      interiorNodeIds,
      nodeIds: uniqueStrings([...boundaryNodeIds, ...interiorNodeIds]),
    };
  });
}

function createAnalysisNodePlacementMetadata(topology, analysisNodes, boundarySegments, regionNodeSets, details) {
  return {
    version: ANALYSIS_NODE_PLACEMENT_VERSION,
    algorithm: "structure-boundary-triangular-grid-v2",
    generatedAt: new Date().toISOString(),
    maxNodes: details.maxNodes,
    effectiveMaxNodes: details.effectiveMaxNodes,
    spacing: roundCoord(details.spacing),
    classificationTolerance: details.classificationTolerance,
    stale: false,
    sourceGeometry: {
      geometryNodeCount: scene.geometryNodes.length,
      curveCount: scene.curves.length,
      structureRegionCount: topology.structureRegions.length,
      airRegionCount: topology.airRegions.length,
    },
    counts: {
      analysisNodes: analysisNodes.length,
      boundarySegments: boundarySegments.length,
      structureRegions: regionNodeSets.length,
      staticNodes: analysisNodes.filter((node) => normalizeMechanicalState(node.mechanicalState) === "static").length,
    },
    boundarySegments: boundarySegments.map((segment) => ({
      curveId: segment.curveId,
      curveType: segment.curveType,
      mechanicalState: segment.mechanicalState,
      length: segment.length,
      regionIds: [...(segment.regionIds || [])],
      nodeIds: [...(segment.nodeIds || [])],
      samples: (segment.samples || []).map((sample) => ({ ...sample })),
    })),
    regionNodeSets: regionNodeSets.map((item) => ({
      ...item,
      boundaryCurveIds: [...item.boundaryCurveIds],
      boundaryNodeIds: [...item.boundaryNodeIds],
      interiorNodeIds: [...item.interiorNodeIds],
      nodeIds: [...item.nodeIds],
    })),
    warnings: [...(details.warnings || [])],
  };
}

function normalizeAnalysisNodePlacementData(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    version: Number(raw.version) || ANALYSIS_NODE_PLACEMENT_VERSION,
    algorithm: String(raw.algorithm || "unknown"),
    generatedAt: String(raw.generatedAt || ""),
    maxNodes: normalizeAnalysisNodeLimit(raw.maxNodes),
    effectiveMaxNodes: normalizeAnalysisNodeLimit(raw.effectiveMaxNodes || raw.maxNodes),
    spacing: finiteNonNegativeNumber(raw.spacing) ?? 0,
    classificationTolerance: finiteNonNegativeNumber(raw.classificationTolerance) ?? DEFAULT_CLASSIFICATION_TOLERANCE,
    stale: Boolean(raw.stale),
    staleReason: raw.staleReason ? String(raw.staleReason) : "",
    sourceGeometry: raw.sourceGeometry && typeof raw.sourceGeometry === "object" ? { ...raw.sourceGeometry } : null,
    counts: raw.counts && typeof raw.counts === "object" ? { ...raw.counts } : null,
    boundarySegments: Array.isArray(raw.boundarySegments) ? raw.boundarySegments.map(normalizeAnalysisBoundarySegment) : [],
    regionNodeSets: Array.isArray(raw.regionNodeSets) ? raw.regionNodeSets.map(normalizeAnalysisRegionNodeSet) : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
  };
}

function normalizeAnalysisBoundarySegment(raw = {}) {
  return {
    curveId: String(raw.curveId || ""),
    curveType: String(raw.curveType || ""),
    mechanicalState: normalizeMechanicalState(raw.mechanicalState),
    length: finiteNonNegativeNumber(raw.length) ?? 0,
    regionIds: uniqueStrings(raw.regionIds || []),
    nodeIds: uniqueStrings(raw.nodeIds || []),
    samples: Array.isArray(raw.samples)
      ? raw.samples.map((sample) => ({
          nodeId: String(sample.nodeId || ""),
          t: finiteNonNegativeNumber(sample.t) ?? 0,
          x: finiteOrNull(sample.x),
          y: finiteOrNull(sample.y),
        }))
      : [],
  };
}

function normalizeAnalysisRegionNodeSet(raw = {}) {
  return {
    regionId: String(raw.regionId || ""),
    regionKind: normalizeRegionKind(raw.regionKind),
    materialId: raw.materialId ? String(raw.materialId) : null,
    materialName: String(raw.materialName || ""),
    boundaryCurveIds: uniqueStrings(raw.boundaryCurveIds || []),
    boundaryNodeIds: uniqueStrings(raw.boundaryNodeIds || []),
    interiorNodeIds: uniqueStrings(raw.interiorNodeIds || []),
    nodeIds: uniqueStrings(raw.nodeIds || []),
  };
}

function markAnalysisNodePlacementStale(reason = "geometryChanged") {
  if (!scene.analysisNodePlacement) return;
  scene.analysisNodePlacement.stale = true;
  scene.analysisNodePlacement.staleReason = reason;
}

function readAnalysisNodeLimit() {
  return normalizeAnalysisNodeLimit(maxAnalysisNodes?.value);
}

function normalizeAnalysisNodeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return DEFAULT_MAX_ANALYSIS_NODES;
  }
  return Math.max(1, Math.floor(number));
}

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function approximateCurveLength(curve, sampleCount = 80) {
  const points = sampleCurve(curve, curve.type === "line" ? 1 : sampleCount).filter(isFinitePoint);
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += distance(points[i - 1], points[i]);
  }
  return length;
}

function curveAdjacentPlacementRegionIds(curveId) {
  return (scene.regions || [])
    .filter((region) => (region.boundaryCurveIds || []).includes(curveId))
    .map((region) => region.id);
}

function polygonBounds(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function distanceToAnyPlacementBoundary(point, boundaryCurves = scene.curves || []) {
  let best = Infinity;
  for (const curve of boundaryCurves || []) {
    best = Math.min(best, distanceToCurveWorld(point, curve));
  }
  return best;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}
