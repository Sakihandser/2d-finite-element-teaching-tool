const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const MESH_SOURCE = fs.readFileSync(path.join(ROOT, "src", "core", "analysis-mesh.js"), "utf8");
const WASM_PATH = path.join(ROOT, "src", "vendor", "triangle-wasm", "triangle.out.wasm");
const triangleWasm = require(path.join(ROOT, "src", "vendor", "triangle-wasm", "triangle-wasm.js"));

test("triangle-wasm PSLG 网格完整覆盖凹角、孔洞和共享边界", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url !== "/triangle.out.wasm") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/wasm" });
    fs.createReadStream(WASM_PATH).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  let ready = null;
  const api = {
    ...triangleWasm,
    init() {
      ready ||= triangleWasm.init("http://127.0.0.1:" + port + "/triangle.out.wasm");
      return ready;
    },
  };

  await t.test("梁柱凹角区域没有漏域", async () => {
    const fixture = makeFixture([
      {
        id: "R1",
        regionKind: "structure",
        polygon: [
          { x: 0, y: 0 },
          { x: 8, y: 0 },
          { x: 8, y: 2 },
          { x: 5, y: 2 },
          { x: 5, y: 8 },
          { x: 3, y: 8 },
          { x: 3, y: 2 },
          { x: 0, y: 2 },
        ],
      },
    ]);
    const result = await runMesh(fixture, api);
    assert.ok(result.elements.length > 0);
    assert.equal(result.metadata.algorithm, "triangle-wasm-1.0.0-pslg");
    assert.equal(result.metadata.coverage.passed, true);
    assert.equal(result.metadata.coverage.missingBoundaryEdges, 0);
    assert.ok(result.metadata.coverage.relativeError < 1e-7);
  });

  await t.test("内部空气孔洞不生成单元", async () => {
    const hole = [
      { x: 3, y: 2 },
      { x: 7, y: 2 },
      { x: 7, y: 5 },
      { x: 6.5, y: 6 },
      { x: 5, y: 6.5 },
      { x: 3.5, y: 6 },
      { x: 3, y: 5 },
    ];
    const fixture = makeFixture([
      {
        id: "R1",
        regionKind: "structure",
        polygon: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 8 },
          { x: 0, y: 8 },
        ],
      },
      { id: "R2", regionKind: "air", polygon: hole },
    ]);
    const result = await runMesh(fixture, api);
    assert.equal(result.metadata.coverage.passed, true);
    assert.equal(result.metadata.coverage.regions.length, 1);
    for (const element of result.elements) {
      assert.equal(pointInPolygon(element.centroid, hole), false);
    }
  });

  await t.test("相邻材料区域共享约束边且各自覆盖完整", async () => {
    const fixture = makeFixture([
      {
        id: "R1",
        regionKind: "structure",
        polygon: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 4 },
          { x: 0, y: 4 },
        ],
      },
      {
        id: "R2",
        regionKind: "structure",
        polygon: [
          { x: 4, y: 0 },
          { x: 8, y: 0 },
          { x: 8, y: 4 },
          { x: 4, y: 4 },
        ],
      },
    ]);
    const result = await runMesh(fixture, api);
    assert.equal(result.metadata.coverage.passed, true);
    assert.equal(result.metadata.coverage.regions.length, 2);
    const sharedNodes = result.analysisNodes.filter((node) => Math.abs(node.x - 4) < 1e-8);
    assert.ok(sharedNodes.length >= 2);
    const regionIds = new Set(result.elements.map((element) => element.regionId));
    assert.deepEqual([...regionIds].sort(), ["R1", "R2"]);
  });

  await t.test("接近界面上限的稠密节点仍可稳定剖分", async () => {
    const interiorPoints = [];
    for (let y = 1; y < 40; y += 0.65) {
      for (let x = 1; x < 40; x += 0.65) {
        interiorPoints.push({ x: x + (y % 1) * 0.03, y });
      }
    }
    const fixture = makeFixture([
      {
        id: "R1",
        regionKind: "structure",
        polygon: [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 40 },
          { x: 0, y: 40 },
        ],
        interiorPoints,
      },
    ]);
    const result = await runMesh(fixture, api);
    assert.ok(result.analysisNodes.length >= 3700);
    assert.ok(result.elements.length >= 7000);
    assert.equal(result.metadata.coverage.passed, true);
    assert.equal(result.metadata.coverage.missingBoundaryEdges, 0);
  });
});

async function runMesh(fixture, api) {
  const context = vm.createContext({
    ...fixture.globals,
    scene: fixture.scene,
    TriangleWasm: api,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(MESH_SOURCE, context, { filename: "analysis-mesh.js" });
  return vm.runInContext("buildAutomaticAnalysisMesh({ tolerance: 1e-7 })", context);
}

function makeFixture(regionSpecs) {
  const nodes = [];
  const nodeByCoordinate = new Map();
  const curves = [];
  const curveByEdge = new Map();
  const boundarySegments = [];
  const segmentByCurveId = new Map();
  let nextNode = 1;
  let nextCurve = 1;

  const getNode = (point) => {
    const key = point.x + "," + point.y;
    if (!nodeByCoordinate.has(key)) {
      const node = {
        id: "A" + nextNode++,
        x: point.x,
        y: point.y,
        ux: 0,
        uy: 0,
        mechanicalState: "free",
        placement: { regionIds: [], curveIds: [], sources: [] },
      };
      nodes.push(node);
      nodeByCoordinate.set(key, node);
    }
    return nodeByCoordinate.get(key);
  };
  const edgeKey = (a, b) => [a.x + "," + a.y, b.x + "," + b.y].sort().join("|");
  const regions = regionSpecs.map((spec) => {
    const polygon = spec.polygon.map((point) => ({ ...point }));
    const boundary = [];
    const boundaryCurveIds = [];
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const first = getNode(start);
      const second = getNode(end);
      const key = edgeKey(start, end);
      let curveId = curveByEdge.get(key);
      if (!curveId) {
        curveId = "C" + nextCurve++;
        curveByEdge.set(key, curveId);
        curves.push({ id: curveId, type: "line", mechanicalState: "free" });
        const segment = {
          curveId,
          curveType: "line",
          mechanicalState: "free",
          regionIds: [],
          nodeIds: [first.id, second.id],
          samples: [
            { nodeId: first.id, t: 0, x: first.x, y: first.y },
            { nodeId: second.id, t: 1, x: second.x, y: second.y },
          ],
        };
        boundarySegments.push(segment);
        segmentByCurveId.set(curveId, segment);
      }
      const segment = segmentByCurveId.get(curveId);
      if (!segment.regionIds.includes(spec.id)) segment.regionIds.push(spec.id);
      for (const node of [first, second]) {
        if (!node.placement.regionIds.includes(spec.id)) node.placement.regionIds.push(spec.id);
        if (!node.placement.curveIds.includes(curveId)) node.placement.curveIds.push(curveId);
      }
      boundaryCurveIds.push(curveId);
      boundary.push({
        curveId,
        t0: segment.samples[0].nodeId === first.id ? 0 : 1,
        t1: segment.samples[1].nodeId === second.id ? 1 : 0,
        start: { ...start },
        end: { ...end },
      });
    }
    return {
      id: spec.id,
      regionKind: spec.regionKind,
      isAir: spec.regionKind === "air",
      polygon,
      boundarySegments: boundary,
      boundaryCurveIds,
      area: Math.abs(polygonSignedArea(polygon)),
      centroid: polygonCentroid(polygon, polygonSignedArea(polygon)),
      materialId: spec.regionKind === "air" ? null : "M1",
      materialName: spec.regionKind === "air" ? "" : "test",
    };
  });
  for (const spec of regionSpecs) {
    for (const point of spec.interiorPoints || []) {
      const node = getNode(point);
      if (!node.placement.regionIds.includes(spec.id)) node.placement.regionIds.push(spec.id);
    }
  }
  const scene = {
    regions,
    curves,
    analysisNodes: nodes,
    analysisNodePlacement: {
      algorithm: "test-placement",
      generatedAt: "",
      spacing: 1,
      boundarySegments,
      regionNodeSets: regions
        .filter((region) => region.regionKind !== "air")
        .map((region) => ({
          regionId: region.id,
          boundaryNodeIds: [],
          interiorNodeIds: [],
          nodeIds: [],
        })),
    },
  };

  const globals = {
    DEFAULT_CLASSIFICATION_TOLERANCE: 1e-7,
    ANALYSIS_NODE_MIN_SPACING: 1e-9,
    REGION_KIND_STRUCTURE: "structure",
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    roundCoord: (value) => Math.round(Number(value) * 1e9) / 1e9,
    roundPoint: (point) => ({
      x: Math.round(Number(point.x) * 1e9) / 1e9,
      y: Math.round(Number(point.y) * 1e9) / 1e9,
    }),
    isFinitePoint: (point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)),
    distance: (a, b) => Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y)),
    pointsClose: (a, b, tolerance = 1e-7) =>
      Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y)) <= tolerance,
    polygonSignedArea,
    polygonCentroid,
    pointInPolygon,
    pointOnPolygonBoundary,
    maxNumericId: (items, prefix) =>
      Math.max(0, ...(items || []).map((item) => Number(String(item.id).replace(prefix, "")) || 0)),
    uniqueStrings: (values) => [...new Set((values || []).map(String).filter(Boolean))],
    normalizeMechanicalState: (value) => (value === "static" ? "static" : "free"),
    normalizeRegionKind: (value) => (value === "air" ? "air" : "structure"),
    isAirRegion: (region) => region?.regionKind === "air",
    curveById: (id) => curves.find((curve) => curve.id === id) || null,
    regionById: (id) => regions.find((region) => region.id === id) || null,
    regionInfo: (region) => region,
    getStructureRegionAtPoint: (point) =>
      regions
        .filter((region) => region.regionKind !== "air" && pointInPolygon(point, region.polygon))
        .sort((a, b) => a.area - b.area)[0] || null,
    regionClassificationFields: (region) => ({
      structureRegionId: region?.id || null,
      regionId: region?.id || null,
      structureName: region?.id || "",
      regionKind: region?.regionKind || null,
      isAir: region?.regionKind === "air",
      isStructure: region?.regionKind === "structure",
      materialId: region?.materialId || null,
      materialName: region?.materialName || "",
      materialColor: "",
      materialProperties: null,
    }),
    classifyAnalysisNode: (node) => {
      const region =
        regions
          .filter((item) => item.regionKind !== "air" && pointInPolygon(node, item.polygon))
          .sort((a, b) => a.area - b.area)[0] || null;
      Object.assign(node, {
        structureRegionId: region?.id || null,
        regionId: region?.id || null,
        regionKind: region?.regionKind || null,
        isAir: false,
        isStructure: Boolean(region),
        materialId: region?.materialId || null,
        materialName: region?.materialName || "",
      });
      return node;
    },
    analysisNodeByRef: (id) => nodes.find((node) => node.id === String(id)) || null,
    elementNodeRefs: (element) => element.analysisNodeIds || element.nodeIds || [],
  };
  return { scene, globals };
}

function polygonSignedArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

function polygonCentroid(points, signedArea = polygonSignedArea(points)) {
  if (Math.abs(signedArea) < 1e-12) {
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
  }
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }
  return { x: x / (6 * signedArea), y: y / (6 * signedArea) };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnPolygonBoundary(point, polygon, tolerance) {
  for (let index = 0; index < polygon.length; index++) {
    if (distanceToSegment(point, polygon[index], polygon[(index + 1) % polygon.length]) <= tolerance) return true;
  }
  return false;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}
