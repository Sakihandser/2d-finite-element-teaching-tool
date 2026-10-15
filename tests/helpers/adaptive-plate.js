// Shared benchmark fixture based on adaptive-crack.test.js; same slit, loads and material.
const assert = require("node:assert/strict");
function plateMesh(triangle, spacing) {
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

function buildPlateModel(mesh, pointForce = false) {
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
  return { model, payload };
}
module.exports = { plateMesh, buildPlateModel };
