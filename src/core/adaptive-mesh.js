// Adapted from MFEM 4.10 ex21.cpp, GridFunction::ComputeFlux/ZZErrorEstimator,
// ElasticityIntegrator::ComputeFluxEnergy and ThresholdRefiner.
// Copyright (c) 2010-2026, Lawrence Livermore National Security, LLC.
// BSD-3-Clause: see mfem-4.10/LICENSE and NOTICE.
// This port uses the application's plane-stress TRI3 solver (unit thickness).
let calculationWorkflowRunning = false;

function adaptiveEdgeKey(a, b) {
  return JSON.stringify([String(a), String(b)].sort());
}

const ADAPTIVE_CONNECTION_VERSION = 5;
const ADAPTIVE_TIME_LIMIT_MS = 10_000;

function adaptiveNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Triangle and connection optimization run off the UI thread, allowing a
// runaway refinement to be terminated without waiting for synchronous WASM.
function refineAdaptiveSafely(api, nodes, elements, marked, timeLimitMs = ADAPTIVE_TIME_LIMIT_MS, options = {}) {
  if (typeof Worker === "undefined") return Promise.resolve(refineAdaptiveWithTriangle(api, nodes, elements, marked, options));
  return new Promise((resolve, reject) => {
    const worker = new Worker("./src/core/adaptive-refinement-worker.js");
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`自适应加密超过 ${timeLimitMs / 1000} 秒，已停止。`);
      error.timedOut = true;
      finish(error);
    }, timeLimitMs);
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
    worker.onerror = (event) => finish(new Error(event.message || "自适应后台加密失败。"));
    try { worker.postMessage({ nodes, elements, marked: [...marked], options }); }
    catch (error) { finish(error); }
  });
}

async function refineAdaptiveWithinBudget(api, nodes, elements, marked, maxNodes, timeLimitMs) {
  const deadline = adaptiveNow()+timeLimitMs;
  let selected = planAdaptiveRefinement(nodes,elements,marked,maxNodes).marked;
  const attempts = [];
  for (let retry=0; retry<4 && selected.size; retry++) {
    const remaining = deadline-adaptiveNow();
    if (remaining<=0) return { attempts, stopReason:'time-limit' };
    let mesh;
    try { mesh = await refineAdaptiveSafely(api,nodes,elements,selected,remaining,{maxNodes}); }
    catch (error) { return { attempts, stopReason:error.timedOut?'time-limit':'refinement-failure', error:error.message }; }
    attempts.push({marked:selected.size,candidateNodes:mesh?.analysisNodes.length||nodes.length});
    if (adaptiveNow()>=deadline) return { attempts, stopReason:'time-limit' };
    if (!mesh) return { attempts, stopReason:'local-size-limit' };
    if (mesh.analysisNodes.length<=maxNodes) return { mesh, attempts };
    selected=new Set([...selected].slice(0,Math.floor(selected.size/2)));
  }
  return { attempts, stopReason:'node-budget' };
}

function createAdaptiveRefinementPolicy(nodes, elements) {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const areas = elements.map((e) => {
    const [a, b, c] = (e.analysisNodeIds || e.nodeIds).map((id) => byId.get(String(id)));
    return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }).sort((a, b) => a - b);
  const baseArea = areas[Math.floor(areas.length / 2)] || 1;
  return { baseArea, minArea: Math.max(1e-10, baseArea / 4096), pointLoadCenterArea: Math.max(1e-10, baseArea / 1024), pointLoadMinArea: Math.max(1e-10, baseArea / 64), pointLoadRadius: Math.sqrt(baseArea) * 2, backgroundArea: baseArea / 2 };
}

// A continuous size field: finest at the force anchor, increasing outwards.
// Beyond the patch, taper its protection smoothly so distant geometric stress
// concentrations can still refine to the ordinary local floor.
function adaptivePointLoadSize(distance, policy) {
  const r = distance / policy.pointLoadRadius;
  const target = Math.min(policy.pointLoadMinArea, policy.pointLoadCenterArea * (1 + 3 * r) ** 2);
  return { target, floor: Math.max(policy.minArea, target / 4 * Math.exp(-(Math.max(0, r - 1) ** 2))) };
}

// Bulk marking uses accumulated error instead of a fraction of the largest
// singular indicator. Limit only the selection weight of extreme outliers;
// the reported ZZ error is untouched. Saturated point-load patches are skipped.
function markAdaptiveElements(payload, estimate, policy) {
  const indicators = new Map(estimate.indicators.map((e) => [String(e.id), e.value ** 2]));
  const anchors = (payload.loads?.point || []).filter((p) => Math.hypot(p.fx, p.fy) > 0 && p.anchor).map((p) => p.anchor);
  const distance = (e) => Math.min(...anchors.map((p) => Math.hypot(e.centroid.x - p.x, e.centroid.y - p.y)));
  let saturated = 0;
  const eligible = payload.elements.filter((e) => {
    const floor = anchors.length ? adaptivePointLoadSize(distance(e), policy).floor : policy.minArea;
    const allowed = e.area / 4 > floor;
    if (!allowed) saturated++;
    return allowed;
  });
  const positive = eligible.map((e) => indicators.get(String(e.id)) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const cap = positive.length ? positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.9))] * 4 : 0;
  const ranked = eligible.map((e) => ({ e, weight: Math.min(indicators.get(String(e.id)) || 0, cap) })).sort((a, b) => b.weight - a.weight);
  const total = ranked.reduce((sum, r) => sum + r.weight, 0);
  const marked = new Set();
  // Recovery indicators can be small on elements sharing the force vertex.
  // Explicitly resolve the whole patch, including its center, independently of ZZ.
  for (const e of eligible) {
    const d = distance(e);
    if (d < policy.pointLoadRadius && e.area > adaptivePointLoadSize(d, policy).target) marked.add(String(e.id));
  }
  let accumulated = 0;
  for (const r of ranked) {
    if (accumulated >= 0.5 * total || r.weight <= 0) break;
    marked.add(String(r.e.id)); accumulated += r.weight;
  }
  // Give the coarse background a limited share of each round, even when a
  // point singularity dominates, and prioritize the largest cells in each region.
  const regions = new Map();
  for (const e of eligible) {
    const key = e.region?.id || e.regionId || "";
    if (!regions.has(key)) regions.set(key, []);
    regions.get(key).push(e);
  }
  for (const list of regions.values()) {
    const coarse = list.filter((e) => e.area > policy.backgroundArea).sort((a, b) => b.area - a.area);
    for (const e of coarse.slice(0, Math.ceil(list.length * 0.05))) marked.add(String(e.id));
  }
  return { marked, saturated, strategy: "bulk-error-with-graded-point-patch-and-background" };
}

// Prioritize raw ZZ error with a finite budget. Only ordinary hotspots relax;
// point-force cores keep their original protection.
function markAdaptiveHotspots(payload, estimate, policy, rescueLevel = 0) {
  const level = Math.max(0, Math.min(3, Math.floor(rescueLevel)));
  const ordinaryFloor = Math.max(1e-10, policy.minArea / (4 ** level));
  const anchors = (payload.loads?.point || []).filter(p => Math.hypot(p.fx, p.fy) > 0 && p.anchor).map(p => p.anchor);
  const indicators = new Map(estimate.indicators.map(e => [String(e.id), e.value ** 2]));
  let errorEnergy = 0, frozenEnergy = 0, ordinaryFrozenEnergy = 0, pointFrozenEnergy = 0, saturated = 0;
  const eligible = [];
  for (const e of payload.elements) {
    const energy = indicators.get(String(e.id)) || 0;
    errorEnergy += energy;
    const d = anchors.reduce((v, p) => Math.min(v, Math.hypot(e.centroid.x-p.x, e.centroid.y-p.y)), Infinity);
    const r = d / policy.pointLoadRadius;
    // Compact support: no point-force protection leaks beyond this patch.
    // Smoothly taper the outer half; retain a fixed floor in the core.
    const t = Math.max(0, Math.min(1, (r - 0.5) * 2));
    const taper = (1-t) ** 2 * (1+2*t);
    const pointFloor = r < 1 ? Math.max(policy.minArea, adaptivePointLoadSize(d, policy).target / 4) * taper : 0;
    if (!(e.area / 4 > Math.max(ordinaryFloor, pointFloor))) {
      saturated++; frozenEnergy += energy;
      if (e.area / 4 <= pointFloor) pointFrozenEnergy += energy;
      else ordinaryFrozenEnergy += energy;
    } else eligible.push({ e, energy, d });
  }
  eligible.sort((a,b) => b.energy-a.energy || String(a.e.id).localeCompare(String(b.e.id)));
  const limit = Math.min(1600, Math.max(96, Math.ceil((payload.nodes?.length || 400) * 0.12)));
  const marked = new Set();
  const eligibleEnergy = eligible.reduce((s,r) => s+r.energy, 0);
  let accumulated = 0;
  for (const r of eligible) {
    if (marked.size >= limit || accumulated >= eligibleEnergy * 0.6 || !(r.energy > 0)) break;
    marked.add(String(r.e.id)); accumulated += r.energy;
  }
  // Resolve a force anchor even if recovery underestimates its central cells.
  // These additions share the same bounded selection budget and size floors.
  const patchLimit = Math.min(limit, marked.size + Math.ceil(limit * 0.2));
  for (const r of eligible) {
    if (marked.size >= patchLimit) break;
    if (r.d < policy.pointLoadRadius && r.e.area > adaptivePointLoadSize(r.d, policy).target) marked.add(String(r.e.id));
  }
  const regions = new Map();
  for (const r of eligible) {
    if (!(r.e.area > policy.backgroundArea)) continue;
    const key = r.e.region?.id || r.e.regionId || '';
    if (!regions.has(key)) regions.set(key, []);
    regions.get(key).push(r);
  }
  // Round-robin coarse regions to avoid starving a small material partition.
  const coarse = [...regions.values()].map(rows => rows.sort((a,b) => b.e.area-a.e.area).slice(0, 4));
  for (let i=0; i<4 && marked.size<limit; i++) for (const rows of coarse) {
    if (marked.size >= limit) break;
    if (rows[i]) marked.add(String(rows[i].e.id));
  }
  const fraction = n => errorEnergy > 0 ? n/errorEnergy : 0;
  return { marked, saturated, rescueLevel: level, ordinaryFloor,
    frozenErrorFraction: fraction(frozenEnergy), ordinaryFrozenErrorFraction: fraction(ordinaryFrozenEnergy),
    pointFrozenErrorFraction: fraction(pointFrozenEnergy),
    markedErrorFraction: fraction(payload.elements.reduce((sum,e) => sum+(marked.has(String(e.id)) ? indicators.get(String(e.id)) || 0 : 0),0)),
    strategy: 'bounded-raw-error-with-compact-point-protection-v1' };
}

// Red subdivision adds one midpoint per unique selected edge. Budget those
// points before allocating a candidate; Triangle quality points are checked
// again after meshing. Neither this planner nor refinement mutates the input.
function planAdaptiveRefinement(nodes, elements, marked, maxNodes) {
  const byId = new Map(elements.map(e => [String(e.id), e]));
  const edges = new Set(), selected = new Set();
  const available = Math.max(0, maxNodes - nodes.length);
  for (const id of marked) {
    const e = byId.get(String(id));
    if (!e) continue;
    const refs = e.analysisNodeIds || e.nodeIds;
    const keys = refs.map((a,i) => adaptiveEdgeKey(a,refs[(i+1)%3]));
    const added = keys.filter(key => !edges.has(key));
    if (edges.size+added.length > available) continue;
    selected.add(String(id)); added.forEach(key => edges.add(key));
  }
  return { marked: selected, predictedNodes: nodes.length+edges.size };
}

// Use the SAME Triangle WASM engine as ordinary meshing. The seed subdivision
// provides local density; rp/q rebuilds its connections and repairs quality.
// Fixed segments include exterior/hole boundaries and all material interfaces.
function refineAdaptiveWithTriangle(api, nodes, elements, marked, options = {}) {
  const seed = refineAdaptiveTriangles(nodes, elements, marked);
  if (!seed) return null;
  const capped = Number.isInteger(options.maxNodes);
  if (capped && seed.analysisNodes.length > options.maxNodes) throw new Error('自适应候选种子超过节点预算。');
  const index = new Map(seed.analysisNodes.map((n, i) => [String(n.id), i]));
  const groups = [], groupByKey = new Map(), attributes = [];
  const constraints = new Map(), edgeCounts = new Map();
  for (const e of seed.elements) {
    const key = JSON.stringify([e.regionId || e.structureRegionId || e.region?.id, e.materialId]);
    if (!groupByKey.has(key)) { groupByKey.set(key, groups.length + 1); groups.push(e); }
    attributes.push(groupByKey.get(key));
    for (const edge of e.edges) {
      const key = adaptiveEdgeKey(...edge.nodeIds);
      const entry = edgeCounts.get(key) || { count: 0, edge, group: groupByKey.get(JSON.stringify([e.regionId || e.structureRegionId || e.region?.id, e.materialId])) };
      entry.count++;
      if (edge.boundary || entry.group !== attributes.at(-1)) constraints.set(key, edge);
      edgeCounts.set(key, entry);
    }
  }
  for (const [key, entry] of edgeCounts) if (entry.count === 1) constraints.set(key, entry.edge);
  const segments = [], markers = [], details = [];
  for (const edge of constraints.values()) {
    segments.push(...edge.nodeIds.map((id) => index.get(String(id))));
    markers.push(details.length + 1); details.push(edge);
  }
  let input, output;
  try {
    input = api.makeIO({ pointlist: seed.analysisNodes.flatMap((n) => [n.x, n.y]), trianglelist: seed.elements.flatMap((e) => e.nodeIds.map((id) => index.get(String(id)))), numberofcorners: 3, triangleattributelist: attributes, segmentlist: segments, segmentmarkerlist: markers });
    output = api.makeIO();
    // Triangle's -S bounds optional quality Steiner points before allocation.
    // Intersections can override -S, so retain the post-mesh budget check too.
    // https://www.cs.cmu.edu/~quake/triangle.S.html
    const steiner = capped ? `S${options.maxNodes-seed.analysisNodes.length}` : '';
    api.triangulate(`rpzq20YY${steiner}Q`, input, output);
    const coordinates = Array.from(output.pointlist), triangles = Array.from(output.trianglelist), attrs = Array.from(output.triangleattributelist);
    if (output.numberofcorners !== 3 || attrs.length !== triangles.length / 3) throw new Error("Triangle 自适应输出不完整。");
    const newNodes = seed.analysisNodes.map((n) => ({ ...n }));
    let next = newNodes.reduce((max, n) => Math.max(max, Number(String(n.id).replace(/^A/, "")) || 0), 0) + 1;
    for (let i = 0; i < coordinates.length / 2; i++) {
      if (i < newNodes.length) {
        if (Math.hypot(newNodes[i].x - coordinates[2 * i], newNodes[i].y - coordinates[2 * i + 1]) > 1e-10) throw new Error("Triangle 改变了原有节点顺序。");
      } else newNodes.push({ id: "A" + next++, x: coordinates[2 * i], y: coordinates[2 * i + 1], placement: { sourceType: "triangleSteiner" } });
    }
    const boundary = new Map();
    const outSegments = Array.from(output.segmentlist), outMarkers = Array.from(output.segmentmarkerlist);
    for (let i = 0; i < outMarkers.length; i++) {
      const refs = [newNodes[outSegments[2 * i]].id, newNodes[outSegments[2 * i + 1]].id];
      const source = details[outMarkers[i] - 1];
      if (!source) throw new Error("Triangle 丢失了约束边标记。");
      boundary.set(adaptiveEdgeKey(...refs), { ...source, nodeIds: refs, tRange: source.tRange && (refs[0] === String(source.nodeIds[0]) ? [...source.tRange] : [...source.tRange].reverse()) });
    }
    const rebuilt = [];
    let inputArea = seed.elements.reduce((sum, e) => sum + e.area, 0), outputArea = 0;
    for (let i = 0; i < triangles.length / 3; i++) {
      const parent = groups[Math.round(attrs[i]) - 1];
      if (!parent) throw new Error("Triangle 丢失了区域或材料标记。");
      const refs = triangles.slice(3 * i, 3 * i + 3).map((j) => newNodes[j].id);
      const points = triangles.slice(3 * i, 3 * i + 3).map((j) => newNodes[j]);
      const area = Math.abs((points[1].x - points[0].x) * (points[2].y - points[0].y) - (points[2].x - points[0].x) * (points[1].y - points[0].y)) / 2;
      if (!(area > 1e-12)) throw new Error("Triangle 自适应输出含退化单元。");
      outputArea += area;
      const edges = refs.map((a, j) => {
        const b = refs[(j + 1) % 3], source = boundary.get(adaptiveEdgeKey(a, b));
        return { ...source, nodeIds: [a, b], boundary: Boolean(source?.boundary), tRange: source?.tRange && (a === source.nodeIds[0] ? [...source.tRange] : [...source.tRange].reverse()) };
      });
      rebuilt.push({ ...parent, id: "E" + (i + 1), number: i + 1, index: i + 1, nodeIds: refs, analysisNodeIds: refs, area, edges });
    }
    if (Math.abs(inputArea - outputArea) > Math.max(1e-10, inputArea * 1e-8)) throw new Error("Triangle 自适应网格面积校验失败。");
    const result = optimizeAdaptiveConnections(newNodes, rebuilt);
    result.elements.forEach((e) => { e.generation = { algorithm: "triangle-zz-hybrid-tri3", source: "adaptive" }; });
    result.quality.engine = "triangle-wasm-rpq20";
    result.quality.addedQualityNodes = newNodes.length - seed.analysisNodes.length;
    return result;
  } finally { if (output) api.freeIO(output); if (input) api.freeIO(input); }
}

function adaptiveTriangleQuality(points) {
  const angles = points.map((p, i) => {
    const a = points[(i + 1) % 3], b = points[(i + 2) % 3];
    return Math.atan2(Math.abs((a.x - p.x) * (b.y - p.y) - (a.y - p.y) * (b.x - p.x)), (a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) * 180 / Math.PI;
  });
  return Math.min(...angles);
}

// Lawson-style local reconnection: replace a diagonal only inside a convex
// two-triangle patch, with a strictly better minimum angle. Geometry, boundary
// segments and material interfaces are immutable constraints.
function optimizeAdaptiveConnections(nodes, elements) {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const boundary = new Map();
  const protectedEdges = new Set();
  const triangles = elements.map((e) => (e.analysisNodeIds || e.nodeIds).map(String));
  const adjacency = new Map();
  const queue = [];
  const edgeKeys = (v) => v.map((a, i) => adaptiveEdgeKey(a, v[(i + 1) % 3]));
  const add = (index) => {
    for (const key of edgeKeys(triangles[index])) {
      const incident = adjacency.get(key) || new Set();
      incident.add(index);
      adjacency.set(key, incident);
      queue.push(key);
    }
  };
  const remove = (index) => {
    for (const key of edgeKeys(triangles[index])) {
      const incident = adjacency.get(key);
      incident.delete(index);
      if (!incident.size) adjacency.delete(key);
    }
  };
  elements.forEach((e, index) => {
    for (const edge of e.edges || []) {
      const key = adaptiveEdgeKey(...edge.nodeIds);
      if (edge.boundary) { boundary.set(key, edge); protectedEdges.add(key); }
    }
    add(index);
  });
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const regionKey = (e) => JSON.stringify([e.structureRegionId || e.regionId || e.region?.id, e.materialId]);
  let flips = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const key = queue[cursor], incident = adjacency.get(key);
    if (protectedEdges.has(key) || incident?.size !== 2) continue;
    const [i, j] = [...incident];
    if (regionKey(elements[i]) !== regionKey(elements[j])) continue;
    const [u, v] = JSON.parse(key), a = triangles[i].find((id) => id !== u && id !== v), b = triangles[j].find((id) => id !== u && id !== v);
    if (!a || !b || a === b || adjacency.has(adaptiveEdgeKey(a, b))) continue;
    const pa = byId.get(a), pb = byId.get(b), pu = byId.get(u), pv = byId.get(v);
    const left = cross(pa, pb, pu), right = cross(pa, pb, pv);
    if (!(left * right < 0) || Math.min(Math.abs(left), Math.abs(right)) <= 2e-12) continue;
    const oldMin = Math.min(adaptiveTriangleQuality(triangles[i].map((id) => byId.get(id))), adaptiveTriangleQuality(triangles[j].map((id) => byId.get(id))));
    const newMin = Math.min(adaptiveTriangleQuality([pa, pb, pu]), adaptiveTriangleQuality([pb, pa, pv]));
    if (newMin <= oldMin + 1e-8) continue;
    remove(i); remove(j);
    triangles[i] = left > 0 ? [a, b, u] : [b, a, u];
    triangles[j] = right < 0 ? [b, a, v] : [a, b, v];
    add(i); add(j);
    flips++;
  }
  const output = elements.map((parent, index) => {
    const refs = triangles[index], points = refs.map((id) => byId.get(id));
    const area = Math.abs(cross(...points)) / 2;
    const edges = refs.map((a, i) => {
      const b = refs[(i + 1) % 3], source = boundary.get(adaptiveEdgeKey(a, b));
      const p = byId.get(a), q = byId.get(b);
      const range = source?.tRange && (String(source.nodeIds[0]) === a ? [...source.tRange] : [...source.tRange].reverse());
      return { ...source, nodeIds: [a, b], length: Math.hypot(q.x - p.x, q.y - p.y), boundary: Boolean(source), tRange: range || null };
    });
    const nodeStates = points.map((p) => p.mechanicalState || "free");
    return { ...parent, analysisNodeIds: refs, nodeIds: refs, area, signedArea: area, centroid: { x: points.reduce((s, p) => s + p.x, 0) / 3, y: points.reduce((s, p) => s + p.y, 0) / 3 }, edges, edgeLengths: edges.map((e) => e.length), quality: { minAngle: adaptiveTriangleQuality(points) }, boundaryCurveIds: [...new Set(edges.filter((e) => e.curveId).map((e) => e.curveId))], hasBoundaryEdge: edges.some((e) => e.boundary), nodeStates, hasStaticNode: nodeStates.includes("static"), hasFreeNode: nodeStates.includes("free"), generation: { algorithm: "mfem-zz-quality-tri3", source: "adaptive" }, stress: null, strain: null };
  });
  return { analysisNodes: nodes, elements: output, quality: { edgeFlips: flips, minAngle: output.reduce((min, e) => Math.min(min, e.quality.minAngle), 180), slenderElements: output.filter((e) => e.quality.minAngle < 10).length } };
}

function estimateZZError(payload, result) {
  validateAdaptiveElementData(payload);
  const results = new Map(result.elementResults.map((e) => [e.elementNo, e]));
  const patches = new Map();
  const records = payload.elements.map((element) => {
    const r = results.get(element.number);
    const stress = r && [r.stressXx, r.stressYy, r.stressXy];
    const { elasticModulus: E, poissonRatio: nu } = element.mechanicalProperties;
    if (!stress?.every(Number.isFinite)) {
      throw new Error(`单元 ${element.id} 的应力结果缺失或无效，无法进行 ZZ 误差估计。`);
    }
    // Separate material AND region patches: never average across an interface.
    const keys = element.nodeIds.map((id) => JSON.stringify([id, element.materialId, element.region?.id]));
    for (const key of keys) {
      const p = patches.get(key) || { sum: [0, 0, 0], count: 0 };
      stress.forEach((s, i) => p.sum[i] += s);
      p.count++;
      patches.set(key, p);
    }
    return { element, stress, keys, E, nu };
  });
  // Plane-stress complementary energy density, 1/2 sigma^T D^-1 sigma.
  const energy = (s, E, nu) => (s[0] ** 2 + s[1] ** 2 - 2 * nu * s[0] * s[1] + 2 * (1 + nu) * s[2] ** 2) / (2 * E);
  let errorEnergy = 0, solutionEnergy = 0, maxError = 0;
  // Degree-two triangle quadrature exactly integrates the P1 recovered stress.
  const quadrature = [[2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]];
  const indicators = records.map(({ element, stress, keys, E, nu }) => {
    const recovered = keys.map((key) => {
      const p = patches.get(key);
      return p.sum.map((s) => s / p.count);
    });
    let e2 = 0;
    for (const weights of quadrature) {
      const difference = stress.map((s, i) => recovered.reduce((sum, r, j) => sum + weights[j] * (r[i] - s), 0));
      e2 += element.area / 3 * energy(difference, E, nu);
    }
    const value = Math.sqrt(Math.max(0, e2));
    errorEnergy += e2;
    solutionEnergy += element.area * energy(stress, E, nu);
    maxError = Math.max(maxError, value);
    return { id: element.id, value };
  });
  if (![errorEnergy, solutionEnergy, maxError].every(Number.isFinite)) throw new Error("ZZ 误差估计发生数值溢出。");
  return { indicators, maxError, totalError: Math.sqrt(errorEnergy), relativeError: solutionEnergy > 0 ? Math.sqrt(errorEnergy / solutionEnergy) : (errorEnergy === 0 ? 0 : Infinity) };
}

function validateAdaptiveElementData(payload) {
  for (const element of payload.elements) {
    const { elasticModulus: E, poissonRatio: nu } = element.mechanicalProperties || {};
    if (!Number.isFinite(E) || !(E > 0) || !Number.isFinite(nu) || nu <= -1 || nu >= 0.5 || !Number.isFinite(element.area) || !(element.area > 0)) {
      throw new Error(`单元 ${element.id}（区域 ${element.region?.id || "?"}）的材料参数或面积无效，请检查区域材料和网格。`);
    }
  }
}

// Red refinement of marked triangles, green closure of all incident triangles.
// A shared edge has exactly one midpoint, including material interfaces.
function refineAdaptiveTriangles(nodes, elements, markedIds, options = {}) {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const split = new Map();
  const boundary = new Map();
  for (const element of elements) {
    for (const edge of element.edges || []) {
      if (edge.boundary) {
        // Ordinary meshing can store a curve's ascending range on a reversed
        // triangle edge. Split using parameters attached to the actual endpoints,
        // otherwise a refined varying traction can silently disappear or reverse.
        const parameters = edge.nodeIds.map(id => {
          const placement = byId.get(String(id))?.placement;
          if (edge.curveId && placement?.curveId === edge.curveId && Number.isFinite(placement?.curveT)) return placement.curveT;
          const source = edge.curveId && placement?.sources?.find(p => p.curveId === edge.curveId && Number.isFinite(p.curveT));
          return source?.curveT;
        });
        boundary.set(adaptiveEdgeKey(...edge.nodeIds), { ...edge,
          tRange: parameters.every(Number.isFinite) ? parameters : edge.tRange });
      }
    }
    if (!markedIds.has(String(element.id))) continue;
    const ids = (element.analysisNodeIds || element.nodeIds).map(String);
    for (let i = 0; i < 3; i++) split.set(adaptiveEdgeKey(ids[i], ids[(i + 1) % 3]), [ids[i], ids[(i + 1) % 3]]);
  }
  // A tiny neighbouring cell must not make conformity closure abort a whole
  // round. Freeze its incident edges; larger candidates elsewhere still split.
  for (const element of elements) {
    const ids = (element.analysisNodeIds || element.nodeIds).map(String);
    const [a, b, c] = ids.map((id) => byId.get(id));
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    if (area / 4 <= 1e-12) for (let i = 0; i < 3; i++) split.delete(adaptiveEdgeKey(ids[i], ids[(i + 1) % 3]));
  }
  if (!split.size) return null;
  const newNodes = nodes.map((n) => ({ ...n }));
  let next = nodes.reduce((max, n) => Math.max(max, Number(String(n.id).replace(/^A/, "")) || 0), 0) + 1;
  const midpointIds = new Map();
  for (const [key, ids] of split) {
    const [a, b] = ids.map((id) => byId.get(id));
    if (!a || !b) throw new Error("自适应网格存在无效节点引用。");
    const edge = boundary.get(key);
    const node = { id: "A" + next++, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ux: ((a.ux || 0) + (b.ux || 0)) / 2, uy: ((a.uy || 0) + (b.uy || 0)) / 2 };
    if (edge?.curveId) {
      const t = edge.tRange ? (edge.tRange[0] + edge.tRange[1]) / 2 : null;
      node.placement = { sourceType: "adaptiveBoundary", curveId: edge.curveId, curveT: t, sources: [] };
      const edgeIds = edge.nodeIds.map(String);
      const range = edge.tRange || [0, 1];
      boundary.set(adaptiveEdgeKey(edgeIds[0], node.id), { ...edge, nodeIds: [edgeIds[0], node.id], tRange: [range[0], t] });
      boundary.set(adaptiveEdgeKey(node.id, edgeIds[1]), { ...edge, nodeIds: [node.id, edgeIds[1]], tRange: [t, range[1]] });
    }
    byId.set(node.id, node);
    newNodes.push(node);
    midpointIds.set(key, node.id);
  }
  const output = [];
  for (const parent of elements) {
    const v = (parent.analysisNodeIds || parent.nodeIds).map(String);
    const m = v.map((id, i) => midpointIds.get(adaptiveEdgeKey(id, v[(i + 1) % 3])));
    const count = m.filter(Boolean).length;
    let triangles;
    if (count === 0) triangles = [v];
    else if (count === 3) triangles = [[v[0], m[0], m[2]], [m[0], v[1], m[1]], [m[2], m[1], v[2]], [m[0], m[1], m[2]]];
    else if (count === 1) {
      const i = m.findIndex(Boolean), j = (i + 1) % 3, k = (i + 2) % 3;
      triangles = [[v[i], m[i], v[k]], [m[i], v[j], v[k]]];
    } else {
      const k = m.findIndex((id) => !id), i = (k + 1) % 3, j = (k + 2) % 3;
      triangles = [[v[j], m[j], m[i]], [v[i], m[i], v[k]], [m[i], m[j], v[k]]];
    }
    for (const refs of triangles) {
      const points = refs.map((id) => byId.get(id));
      const area = ((points[1].x - points[0].x) * (points[2].y - points[0].y) - (points[2].x - points[0].x) * (points[1].y - points[0].y)) / 2;
      if (!(Math.abs(area) > 1e-12)) throw new Error("自适应细化产生过小单元，已停止细化。");
      if (area < 0) [refs[1], refs[2]] = [refs[2], refs[1]];
      const edges = refs.map((a, i) => {
        const b = refs[(i + 1) % 3], source = boundary.get(adaptiveEdgeKey(a, b));
        const p = byId.get(a), q = byId.get(b);
        const range = source?.tRange && (String(source.nodeIds[0]) === a ? [...source.tRange] : [...source.tRange].reverse());
        return { ...source, nodeIds: [a, b], length: Math.hypot(q.x - p.x, q.y - p.y), boundary: Boolean(source), tRange: range || null };
      });
      output.push({ ...parent, id: "E" + (output.length + 1), number: output.length + 1, index: output.length + 1, analysisNodeIds: refs, nodeIds: refs, area: Math.abs(area), signedArea: Math.abs(area), centroid: { x: points.reduce((s, p) => s + p.x, 0) / 3, y: points.reduce((s, p) => s + p.y, 0) / 3 }, edges, edgeLengths: edges.map((e) => e.length), quality: null, boundaryCurveIds: [...new Set(edges.filter((e) => e.curveId).map((e) => e.curveId))], generation: { algorithm: "mfem-zz-red-green-tri3", source: "adaptive" } });
    }
  }
  // Damage compatibility needs monotonically decreasing cell areas. Flipping
  // diagonals can enlarge a child again; retain the conforming subdivision.
  return options.optimize === false ? { analysisNodes: newNodes, elements: output } : optimizeAdaptiveConnections(newNodes, output);
}

function readAdaptiveMeshOptions(options = {}) {
  const value = (key, id, fallback) => Number(options[key] ?? (typeof document !== "undefined" ? document.getElementById(id)?.value : undefined) ?? fallback);
  const config = { maxIterations: value("maxIterations", "adaptiveIterations", 16), relativeTolerance: value("relativeTolerance", "adaptiveTolerance", 0.02), markingFraction: 0.6, connectionVersion: ADAPTIVE_CONNECTION_VERSION,
    maxAdaptiveNodes: value("maxAdaptiveNodes", "adaptiveMaxNodes", 100000), markingStrategy:'bounded-raw-error-with-compact-point-protection-v1' };
  if (!Number.isInteger(config.maxIterations) || config.maxIterations < 0 || config.maxIterations > 100 || !(config.relativeTolerance > 0 && config.relativeTolerance < 1)) throw new Error("自适应参数无效：细化轮数 0–100，目标相对误差 0–1。");
  if (!Number.isInteger(config.maxAdaptiveNodes) || config.maxAdaptiveNodes<100 || config.maxAdaptiveNodes>1000000) throw new Error('自适应安全节点上限必须是 100–1000000 的整数。');
  const seconds = value("timeLimitSeconds", "adaptiveTimeLimitSeconds", ADAPTIVE_TIME_LIMIT_MS / 1000);
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 2147483) throw new Error("自适应单轮最长耗时必须为 0.1–2147483 秒。");
  config.timeLimitMs = Math.round(seconds * 1000);
  return config;
}

function adaptiveModelSignature() {
  return JSON.stringify([scene.geometryNodes, scene.curves, scene.regions, scene.pointLoads, scene.distributedLoads, scene.bodyLoads, typeof materialLibrary === "undefined" ? null : materialLibrary]);
}

async function startAdaptiveCalculationWorkflow(options = {}) {
  const config = readAdaptiveMeshOptions(options.refineOnce ? { ...options, maxIterations: 1 } : options);
  if (!options.refineOnce) resetAdaptiveMesh();
  await ensureCalculationMeshReadyForExport({ ...options, adaptive: true });
  if (scene.analysisNodes.length>config.maxAdaptiveNodes) throw new Error('基础网格超过自适应安全节点上限，请提高该上限。');
  const triangleApi = await initializeTriangleWasm();
  const initial = optimizeAdaptiveConnections(scene.analysisNodes, scene.mesh.elements);
  const savedPolicy = scene.mesh.metadata?.adaptive?.config;
  const compatible = savedPolicy?.connectionVersion === ADAPTIVE_CONNECTION_VERSION && savedPolicy.refinementPolicy;
  const policy = compatible ? structuredClone(savedPolicy.refinementPolicy) : createAdaptiveRefinementPolicy(scene.analysisNodes, scene.mesh.elements);
  config.refinementPolicy = policy;
  let rescueLevel = compatible ? Math.max(0,Math.min(3,Math.floor(Number(savedPolicy?.refinementState?.rescueLevel)||0))) : 0, stalledRounds = 0;
  config.refinementState={rescueLevel};
  if (initial.quality.edgeFlips) {
    setAnalysisMesh({ ...initial, meshMetadata: { ...scene.mesh.metadata, adaptiveInitialMesh: true }, analysisNodePlacement: scene.analysisNodePlacement });
  }
  syncRegionMaterialSnapshots();
  const signature = adaptiveModelSignature();
  const history = [];
  let last, solvedMesh, expectedMesh;
  const meshSignature = () => JSON.stringify([scene.analysisNodes.map((n) => [n.id, n.x, n.y]), scene.mesh.elements.map((e) => [e.id, e.analysisNodeIds || e.nodeIds])]);
  try {
    for (let iteration = 0; iteration <= config.maxIterations; iteration++) {
      const iterationStartedAt = adaptiveNow();
      calculationRunStatusMessage = `自适应求解 ${iteration + 1} / ${config.maxIterations + 1}`;
      updateCalculationPanel();
      expectedMesh = meshSignature();
      const candidate = await startSingleCalculationWorkflow({ ...options, adaptive: true, timeLimitMs: config.timeLimitMs, progressLabel: calculationRunStatusMessage, isModelCurrent: () => signature === adaptiveModelSignature() && expectedMesh === meshSignature() });
      if (signature !== adaptiveModelSignature()) throw new Error("模型在自适应计算期间发生变化，请重新计算。");
      if (candidate.runResult?.timedOut) {
        if (!solvedMesh) throw new Error(`自适应首轮求解超过 ${config.timeLimitMs / 1000} 秒，已停止；请减小基础网格规模或使用普通网格计算。`);
        setAnalysisMesh(solvedMesh);
        history.at(-1).stopReason = "time-limit";
        history.at(-1).timedOutAttempt = { iteration, nodes: candidate.payload.nodes.length, elements: candidate.payload.elements.length };
        break;
      }
      if (!candidate.runResult?.ok) throw new Error(candidate.runResult?.error || "自适应求解失败。");
      const estimate = estimateZZError(candidate.payload, candidate.runResult.resultData);
      last = candidate;
      solvedMesh = { analysisNodes: structuredClone(scene.analysisNodes), elements: structuredClone(scene.mesh.elements), meshMetadata: structuredClone(scene.mesh.metadata), analysisNodePlacement: structuredClone(scene.analysisNodePlacement) };
      const step = { iteration, nodes: last.payload.nodes.length, elements: last.payload.elements.length, relativeError: estimate.relativeError, totalError: estimate.totalError, durationMs: adaptiveNow() - iterationStartedAt, meshQuality: iteration === 0 ? initial.quality : history.at(-1).refinedQuality };
      const previous=history.at(-1);
      stalledRounds=previous&&estimate.relativeError>=previous.relativeError*0.995 ? stalledRounds+1 : 0;
      history.push(step);
      if (step.durationMs >= config.timeLimitMs) { step.stopReason = "time-limit"; break; }
      if (!options.refineOnce && estimate.relativeError <= config.relativeTolerance) { step.stopReason = "target-error"; break; }
      if (iteration === config.maxIterations) { step.stopReason = "iteration-limit"; break; }
      let selection = markAdaptiveHotspots(last.payload, estimate, policy, rescueLevel);
      if (selection.ordinaryFrozenErrorFraction>0.25 && rescueLevel<3) {
        selection=markAdaptiveHotspots(last.payload,estimate,policy,++rescueLevel);
        stalledRounds=0;step.hotspotRescue=true;
      }
      const marked = selection.marked;
      step.saturatedElements = selection.saturated;
      step.markingStrategy = selection.strategy;
      Object.assign(step,{rescueLevel,frozenErrorFraction:selection.frozenErrorFraction,
        pointFrozenErrorFraction:selection.pointFrozenErrorFraction,ordinaryFrozenErrorFraction:selection.ordinaryFrozenErrorFraction,
        markedErrorFraction:selection.markedErrorFraction,ordinaryMinArea:selection.ordinaryFloor,markedElements:marked.size});
      config.refinementState={rescueLevel};
      if (!options.refineOnce && stalledRounds>=3) { step.stopReason=selection.pointFrozenErrorFraction>0.8?'singularity-limit':'stagnation';break; }
      const refinement=await refineAdaptiveWithinBudget(triangleApi,scene.analysisNodes,scene.mesh.elements,marked,
        config.maxAdaptiveNodes,config.timeLimitMs-(adaptiveNow()-iterationStartedAt));
      if (signature !== adaptiveModelSignature() || expectedMesh !== meshSignature()) throw new Error("模型在自适应计算期间发生变化，请重新计算。");
      const refined=refinement.mesh;
      step.refinementAttempts=refinement.attempts;
      if (refinement.stopReason==='time-limit') step.refinementTimedOut=true;
      step.durationMs = adaptiveNow() - iterationStartedAt;
      if (step.durationMs >= config.timeLimitMs) { step.stopReason = "time-limit"; break; }
      if (!refined) {
        step.stopReason=marked.size?refinement.stopReason:selection.pointFrozenErrorFraction>0.8?'singularity-limit':'local-size-limit';
        if (refinement.error) step.refinementError=refinement.error;
        if (refinement.stopReason==='time-limit') step.refinementTimedOut=true;
        break;
      }
      step.markedElements = marked.size;
      step.refinedQuality = refined.quality;
      const metadata = { ...scene.mesh.metadata, algorithm: "triangle-zz-hybrid-tri3", generatedAt: new Date().toISOString(), stale: false, counts: { ...scene.mesh.metadata?.counts, nodes: refined.analysisNodes.length, elements: refined.elements.length }, regionElementSets: [], adaptive: { config, history } };
      setAnalysisMesh({ ...refined, meshMetadata: metadata, analysisNodePlacement: scene.analysisNodePlacement });
      scene.mesh.metadata.regionElementSets = buildRegionElementSets(scene.mesh.elements);
      scene.mesh.metadata.counts.boundaryEdges = scene.mesh.elements.reduce((sum, e) => sum + e.edges.filter((edge) => edge.boundary).length, 0);
      scene.mesh.metadata.counts.staticElements = scene.mesh.elements.filter((e) => e.hasStaticNode).length;
      renderCalculationView();
      step.durationMs = adaptiveNow() - iterationStartedAt;
      if (step.durationMs >= config.timeLimitMs) {
        setAnalysisMesh(solvedMesh);
        step.stopReason = "time-limit";
        break;
      }
    }
  } catch (error) {
    if (solvedMesh && signature === adaptiveModelSignature() && expectedMesh === meshSignature()) setAnalysisMesh(solvedMesh);
    throw error;
  }
  const final = history.at(-1);
  scene.mesh.metadata.adaptive = { config, history };
  const reason = { "target-error": "达到目标误差", "iteration-limit": "达到细化轮数上限", "no-marked-elements": "无可细化单元", "local-size-limit": "局部已达到最小尺寸",
    'node-budget':'达到自适应安全节点上限','singularity-limit':'达到奇点保护限制','stagnation':'误差下降停滞，已保留最后成功结果',
    'refinement-failure':'加密失败，已保留最后成功结果', "time-limit": `达到 ${config.timeLimitMs / 1000} 秒耗时保护，已保留最后成功结果；可尝试均匀网格` }[final.stopReason];
  calculationRunStatusMessage = `自适应完成：${reason}；ZZ 估计误差 ${(final.relativeError * 100).toFixed(2)}%`;
  updateCalculationPanel();
  renderCalculationView();
  return { ...last, adaptive: { config, history } };
}

function syncAdaptiveMeshControls() {
  const enabled = Boolean(document.getElementById("adaptiveMeshEnabled")?.checked);
  const limit = document.getElementById("maxAnalysisNodes");
  if (limit) limit.disabled = enabled;
  const timeLimit = document.getElementById("adaptiveTimeLimitSeconds");
  if (timeLimit) timeLimit.disabled = !enabled;
  const adaptiveLimit = document.getElementById('adaptiveMaxNodes');
  if (adaptiveLimit) adaptiveLimit.disabled = !enabled;
}

function resetAdaptiveMesh() {
  setAnalysisMesh({ analysisNodes: [], elements: [], meshMetadata: {}, analysisNodePlacement: {} });
  renderCalculationView();
}

function onAdaptiveMeshChange(event) {
  if (calculationWorkflowRunning) {
    event.target.checked = !event.target.checked;
    syncAdaptiveMeshControls();
    return;
  }
  syncAdaptiveMeshControls();
  if (event.target.checked) {
    alert("自适应网格建议用于裂纹与应力集中研究。若非专门研究此类问题，不建议使用，建议优先采用均匀网格。");
    try {
      resetAdaptiveMesh();
      autoPlaceAnalysisNodes({ adaptive: true });
    } catch (error) {
      handleCalculationExportError(error);
    }
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { estimateZZError, refineAdaptiveTriangles, optimizeAdaptiveConnections, adaptiveTriangleQuality, createAdaptiveRefinementPolicy, markAdaptiveElements, markAdaptiveHotspots, planAdaptiveRefinement, refineAdaptiveWithTriangle };
