"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { estimateZZError, refineAdaptiveTriangles, optimizeAdaptiveConnections, adaptiveTriangleQuality, refineAdaptiveWithTriangle, createAdaptiveRefinementPolicy, markAdaptiveElements } = require("../src/core/adaptive-mesh");
const { encodeCalculationModelBinary, decodeCalculationResultBinary } = require("../calculation-ipc");
const triangle = require("../src/vendor/triangle-wasm/triangle-wasm");
const ROOT = path.resolve(__dirname, "..");

test("local diagonal optimization removes slivers and preserves constrained material interfaces", () => {
  const nodes = [{ id: "A1", x: 0, y: 0 }, { id: "A2", x: 4, y: 0 }, { id: "A3", x: 4, y: 1 }, { id: "A4", x: 0, y: 0.05 }];
  const elements = [{ id: "E1", nodeIds: ["A1", "A2", "A3"], regionId: "R1", materialId: "M1" }, { id: "E2", nodeIds: ["A1", "A3", "A4"], regionId: "R1", materialId: "M1" }];
  const before = Math.min(...elements.map((e) => adaptiveTriangleQuality(e.nodeIds.map((id) => nodes.find((n) => n.id === id)))));
  const improved = optimizeAdaptiveConnections(nodes, elements);
  assert.equal(improved.quality.edgeFlips, 1);
  assert.ok(improved.quality.minAngle > before);
  const protectedElements = structuredClone(elements);
  protectedElements[0].edges = [{ nodeIds: ["A1", "A3"], boundary: true, curveId: "interface", tRange: [0, 1] }];
  assert.equal(optimizeAdaptiveConnections(nodes, protectedElements).quality.edgeFlips, 0);
  protectedElements[0].edges = [];
  protectedElements[1].materialId = "M2";
  assert.equal(optimizeAdaptiveConnections(nodes, protectedElements).quality.edgeFlips, 0);
});

test("force center is refined even when recovery assigns all error to its ring", () => {
  const policy = createAdaptiveRefinementPolicy([{ id: "a", x: 0, y: 0 }, { id: "b", x: 1, y: 0 }, { id: "c", x: 0, y: 1 }], [{ nodeIds: ["a", "b", "c"] }]);
  const payload = {
    loads: { point: [{ fx: 1, fy: 0, anchor: { x: 0, y: 0 } }] },
    elements: [
      { id: "center", area: policy.baseArea / 100, centroid: { x: 0, y: 0 } },
      { id: "ring", area: policy.baseArea / 100, centroid: { x: policy.pointLoadRadius, y: 0 } },
      { id: "remote", area: policy.baseArea, centroid: { x: 10, y: 0 } }
    ]
  };
  const selected = markAdaptiveElements(payload, { indicators: [{ id: "center", value: 0 }, { id: "ring", value: 100 }, { id: "remote", value: 1 }] }, policy);
  assert.ok(selected.marked.has("center"), "zero recovery error must not leave a coarse center");
  assert.ok(selected.marked.has("remote"), "background continues to refine");
  assert.ok(!selected.marked.has("ring"), "a ring already finer than its graded floor is skipped");
});

function plateMesh(spacing) {
  const points = [], segments = [], markers = [], descriptors = new Map(), ids = new Map();
  const add = (x, y) => {
    const key = `${x.toFixed(10)},${y.toFixed(10)}`;
    if (!ids.has(key)) { ids.set(key, points.length / 2); points.push(x, y); }
    return ids.get(key);
  };
  const loop = (coordinates, prefix) => {
    const indices = coordinates.map(([x, y]) => add(x, y));
    for (let i = 0; i < indices.length; i++) {
      const marker = markers.length + 1;
      segments.push(indices[i], indices[(i + 1) % indices.length]);
      markers.push(marker);
      descriptors.set(marker, { curveId: `${prefix}-${i}`, mechanicalState: prefix === "outer" && i === 0 ? "static" : "free" });
    }
  };
  loop([[-5, -5], [5, -5], [5, 5], [-5, 5]], "outer");
  loop(Array.from({ length: 64 }, (_, i) => [3 * Math.cos(-i * 2 * Math.PI / 64), 0.15 * Math.sin(-i * 2 * Math.PI / 64)]), "hole");
  for (let y = -5 + spacing; y < 5; y += spacing) for (let x = -5 + spacing; x < 5; x += spacing) {
    if ((x / 3) ** 2 + (y / 0.15) ** 2 > 1.05) add(x, y);
  }
  const input = triangle.makeIO({ pointlist: points, segmentlist: segments, segmentmarkerlist: markers, holelist: [0, 0] });
  const output = triangle.makeIO();
  try {
    triangle.triangulate("pzq20Q", input, output);
    const coordinates = Array.from(output.pointlist), refs = Array.from(output.trianglelist);
    const boundarySegments = Array.from(output.segmentlist), boundaryMarkers = Array.from(output.segmentmarkerlist);
    const nodes = Array.from({ length: coordinates.length / 2 }, (_, i) => ({ id: `A${i + 1}`, x: coordinates[2 * i], y: coordinates[2 * i + 1] }));
    const boundary = new Map();
    for (let i = 0; i < boundaryMarkers.length; i++) {
      const a = nodes[boundarySegments[2 * i]], b = nodes[boundarySegments[2 * i + 1]];
      const descriptor = descriptors.get(boundaryMarkers[i]);
      boundary.set([a.id, b.id].sort().join("|"), { ...descriptor, nodeIds: [a.id, b.id], boundary: true, tRange: [0, 1] });
    }
    const elements = Array.from({ length: refs.length / 3 }, (_, i) => {
      const nodeIds = refs.slice(3 * i, 3 * i + 3).map((index) => nodes[index].id);
      const edges = nodeIds.map((a, j) => {
        const b = nodeIds[(j + 1) % 3], source = boundary.get([a, b].sort().join("|"));
        return { ...source, nodeIds: [a, b], boundary: Boolean(source) };
      });
      return { id: `E${i + 1}`, nodeIds, edges, regionId: "R1", materialId: "M1" };
    });
    return { analysisNodes: nodes, elements };
  } finally { triangle.freeIO(output); triangle.freeIO(input); }
}

function solvePlate(mesh, pointForce = false) {
  const byId = new Map(mesh.analysisNodes.map((n, i) => [n.id, { ...n, nodeNo: i + 1, forceY: 0 }]));
  // Unit vertical traction on the top; preserve its resultant at every level.
  for (const element of mesh.elements) for (const edge of element.edges || []) {
    if (!edge.boundary) continue;
    const [a, b] = edge.nodeIds.map((id) => byId.get(id));
    if (Math.abs(a.y - 5) < 1e-10 && Math.abs(b.y - 5) < 1e-10) {
      const force = Math.abs(a.x - b.x) / 2;
      a.forceY += force; b.forceY += force;
    }
  }
  const properties = { elasticModulus: 1000, poissonRatio: 0.3, density: 0 };
  const nodes = [...byId.values()].map((n, i) => ({ ...n, fixUx: Math.abs(n.y + 5) < 1e-10, fixUy: Math.abs(n.y + 5) < 1e-10, forceX: 0, dofUx: 2 * i + 1, dofUy: 2 * i + 2, materialNo: 1, regionNo: 1 }));
  assert.ok(Math.abs(nodes.reduce((sum, n) => sum + n.forceY, 0) - 10) < 1e-9);
  if (pointForce) {
    const anchor = nodes.find((n) => Math.abs(n.x - 2) < 1e-9 && Math.abs(n.y - 2) < 1e-9);
    assert.ok(anchor, "concentrated load anchor must remain in the mesh");
    anchor.forceY -= 5;
  }
  const payload = { elements: mesh.elements.map((e, i) => {
    const [a, b, c] = e.nodeIds.map((id) => byId.get(id));
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    return { ...e, number: i + 1, area, region: { id: "R1" }, centroid: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 }, mechanicalProperties: properties };
  }) };
  payload.loads = { point: pointForce ? [{ fx: 0, fy: -5, anchor: { x: 2, y: 2 } }] : [] };
  const model = { modelName: "elliptical slit regression", nodes, materials: [{ ...properties, materialNo: 1 }], elements: payload.elements.map((e) => ({ ...properties, elementNo: e.number, node1: byId.get(e.nodeIds[0]).nodeNo, node2: byId.get(e.nodeIds[1]).nodeNo, node3: byId.get(e.nodeIds[2]).nodeNo, area: e.area, centroidX: e.centroid.x, centroidY: e.centroid.y, materialNo: 1 })), elementNodeLoads: [] };
  const run = spawnSync(path.join(ROOT, "TensoraCore/x64/Release/TensoraCore.exe"), ["--binary-ipc"], { input: encodeCalculationModelBinary(model), timeout: 30000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr?.toString());
  const result = decodeCalculationResultBinary(run.stdout);
  const peak = result.elementResults.reduce((best, r) => r.stressYy > best.stressYy ? r : best, { stressYy: -Infinity });
  return { payload, estimate: estimateZZError(payload, result), peak: peak.stressYy, peakLocation: payload.elements[peak.elementNo - 1].centroid, area: payload.elements.reduce((s, e) => s + e.area, 0) };
}

test("elliptical slit maintains a conforming hole and resolves tip stress concentration", async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/wasm");
    fs.createReadStream(path.join(ROOT, "src/vendor/triangle-wasm/triangle.out.wasm")).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await triangle.init(`http://127.0.0.1:${server.address().port}/triangle.out.wasm`);
  await t.test("Triangle grows beyond 16 MB without losing existing IO pointers", () => {
    const input = triangle.makeIO({ pointlist: [0, 0, 1, 0, 0, 1] });
    const output = triangle.makeIO();
    const large = triangle.makeIO({ pointlist: new Float64Array(3 * 1024 * 1024) });
    try {
      assert.ok(triangle.getMemorySize() > 16 * 1024 * 1024);
      assert.equal(large.numberofpoints, 3 * 1024 * 1024 / 2);
      assert.equal(large.pointlist.length, 3 * 1024 * 1024);
      assert.deepEqual(Array.from(input.pointlist), [0, 0, 1, 0, 0, 1]);
      triangle.triangulate("zQ", input, output);
      assert.equal(output.numberoftriangles, 1);
      assert.deepEqual(Array.from(output.trianglelist).sort(), [0, 1, 2]);
      const points = [];
      for (let y = 0; y <= 400; y++) for (let x = 0; x <= 400; x++) points.push(x, y);
      const grid = triangle.makeIO({ pointlist: points }), gridOutput = triangle.makeIO();
      const before = triangle.getMemorySize();
      try {
        triangle.triangulate("zQ", grid, gridOutput);
        assert.equal(gridOutput.numberoftriangles, 320000);
        assert.ok(triangle.getMemorySize() > before, "Triangle's internal allocations must grow memory during meshing");
        assert.deepEqual(Array.from(input.pointlist), [0, 0, 1, 0, 0, 1]);
        assert.equal(gridOutput.trianglelist.length, 960000);
      } finally { triangle.freeIO(gridOutput); triangle.freeIO(grid); }
    } finally { triangle.freeIO(large); triangle.freeIO(output); triangle.freeIO(input); }
  });
  await t.test("Triangle refinement keeps a shared material interface conforming", () => {
    const nodes = [{ id: "A1", x: 0, y: 0 }, { id: "A2", x: 1, y: 0 }, { id: "A3", x: 1, y: 1 }, { id: "A4", x: 0, y: 1 }];
    const elements = [{ id: "E1", nodeIds: ["A1", "A2", "A3"], materialId: "M1", regionId: "R1" }, { id: "E2", nodeIds: ["A1", "A3", "A4"], materialId: "M2", regionId: "R2" }];
    const refined = refineAdaptiveWithTriangle(triangle, nodes, elements, new Set(["E1"]));
    for (const material of ["M1", "M2"]) assert.ok(Math.abs(refined.elements.filter((e) => e.materialId === material).reduce((sum, e) => sum + e.area, 0) - 0.5) < 1e-12);
    const byId = new Map(refined.analysisNodes.map((n) => [n.id, n]));
    for (const e of refined.elements) {
      const points = e.nodeIds.map((id) => byId.get(id));
      assert.ok(points.every((p) => e.materialId === "M1" ? p.y <= p.x + 1e-12 : p.y >= p.x - 1e-12));
    }
  });
  let mesh = plateMesh(1);
  let legacyMesh = structuredClone(mesh);
  // Retain the preceding fixed-diagonal subdivision as a regression baseline.
  const legacyRefine = (nodes,elements,marked)=>refineAdaptiveTriangles(nodes,elements,marked,{optimize:false});
  const initial = solvePlate(mesh);
  let solved = initial;
  let flips = 0;
  for (let i = 0; i < 5; i++) {
    const marked = new Set(solved.estimate.indicators.filter((e) => e.value > 0.7 * solved.estimate.maxError).map((e) => e.id));
    mesh = refineAdaptiveWithTriangle(triangle, mesh.analysisNodes, mesh.elements, marked);
    flips += mesh.quality.edgeFlips;
    solved = solvePlate(mesh);
    assert.ok(Math.abs(solved.area - initial.area) < 1e-8);
  }
  const dense = solvePlate(plateMesh(0.25));
  let legacySolved = initial;
  for (let i = 0; i < 5; i++) {
    const marked = new Set(legacySolved.estimate.indicators.filter((e) => e.value > 0.7 * legacySolved.estimate.maxError).map((e) => e.id));
    legacyMesh = legacyRefine(legacyMesh.analysisNodes, legacyMesh.elements, marked);
    legacySolved = solvePlate(legacyMesh);
  }
  const minAngle = (m) => {
    const byId = new Map(m.analysisNodes.map((n) => [n.id, n]));
    return Math.min(...m.elements.map((e) => adaptiveTriangleQuality(e.nodeIds.map((id) => byId.get(id)))));
  };
  const oldAngle = minAngle(legacyMesh);
  t.diagnostic(`slit peak sigma_yy: seed=${initial.peak.toFixed(3)}, adaptive=${solved.peak.toFixed(3)}, dense=${dense.peak.toFixed(3)}; edge flips=${flips}; elements=${mesh.elements.length}; min angle=${mesh.quality.minAngle.toFixed(2)}`);
  t.diagnostic(`previous fixed connections: peak=${legacySolved.peak.toFixed(3)}, elements=${legacyMesh.elements.length}, min angle=${oldAngle.toFixed(2)}`);
  assert.equal(mesh.quality.engine, "triangle-wasm-rpq20");
  assert.ok(solved.peak > 5, "tip stress exceeds unit far-field traction");
  assert.ok(Math.abs(solved.peakLocation.x) > 2.7 && Math.abs(solved.peakLocation.y) < 0.3, "maximum tensile stress remains at a slit tip");
  assert.ok(solved.estimate.relativeError < initial.estimate.relativeError);
  assert.ok(mesh.quality.minAngle > oldAngle * 2, "new connections materially improve the worst angle after repeated refinement");
  const edgeUse = new Map();
  for (const e of mesh.elements) for (const edge of e.edges) {
    const key = [...edge.nodeIds].sort().join("|");
    const uses = edgeUse.get(key) || { count: 0, boundary: false };
    uses.count++; uses.boundary ||= edge.boundary;
    edgeUse.set(key, uses);
  }
  assert.ok([...edgeUse.values()].every((e) => e.boundary ? e.count === 1 : e.count === 2), "hole and exterior boundaries remain closed; no hanging edges");
  assert.ok(solved.peak >= dense.peak * 0.8, "adaptive mesh must resolve the concentration visible on the dense ordinary mesh");
  await t.test("concentrated force cannot monopolize refinement or stop the other regions", () => {
    let hybrid = plateMesh(1);
    const policy = createAdaptiveRefinementPolicy(hybrid.analysisNodes, hybrid.elements);
    const originalNodeCount = hybrid.analysisNodes.filter((n) => Math.hypot(n.x - 2, n.y - 2) > 2).length;
    let state = solvePlate(hybrid, true), saturated = 0;
    for (let iteration = 0; iteration < 8; iteration++) {
      const selection = markAdaptiveElements(state.payload, state.estimate, policy);
      saturated += selection.saturated;
      assert.ok(selection.marked.size > 0, "other regions still have refinement candidates");
      hybrid = refineAdaptiveWithTriangle(triangle, hybrid.analysisNodes, hybrid.elements, selection.marked);
      state = solvePlate(hybrid, true);
      assert.ok(Math.abs(state.area - initial.area) < 1e-8);
    }
    const outside = hybrid.analysisNodes.filter((n) => Math.hypot(n.x - 2, n.y - 2) > 2).length;
    assert.ok(outside > originalNodeCount * 1.5, "refinement reaches well outside the point-force patch");
    assert.ok(saturated > 0, "minimum-size point-force cells are skipped without aborting the loop");
    const minArea = Math.min(...state.payload.elements.map((e) => e.area));
    assert.ok(minArea > 1e-10);
    const medianArea = (low, high) => {
      const areas = state.payload.elements.filter((e) => {
        const d = Math.hypot(e.centroid.x - 2, e.centroid.y - 2);
        return d >= low && d < high;
      }).map((e) => e.area).sort((a, b) => a - b);
      assert.ok(areas.length > 0);
      return areas[Math.floor(areas.length / 2)];
    };
    const center = medianArea(0, policy.pointLoadRadius * 0.15);
    const ring = medianArea(policy.pointLoadRadius * 0.7, policy.pointLoadRadius);
    t.diagnostic(`point patch median area: center=${center.toExponential(3)}, outer ring=${ring.toExponential(3)}`);
    assert.ok(center < ring, "force center must be finer than the surrounding ring");
    t.diagnostic(`point-force hybrid: 8 completed rounds; remote nodes=${originalNodeCount}->${outside}; min area=${minArea.toExponential(3)}; cells=${hybrid.elements.length}`);
  });
});
