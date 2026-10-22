// Inspect the same solid TRI3 boundary used by the native blast solver. No mesh
// coordinates or solver settings are changed by detection or validation.
(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BlastCavity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";

  function boundaryLoops(model) {
    const nodes = new Map(model.nodes.map(node => [node.nodeNo, node]));
    const edges = new Map();
    for (const element of model.elements) {
      const ids = element.nodeNumbers || [element.node1, element.node2, element.node3];
      const points = ids.map(id => nodes.get(id));
      if (points.some(point => !point)) throw new Error("Invalid blast mesh node reference.");
      const [p, q, r] = points;
      const cross = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      if (!Number.isFinite(cross) || cross === 0) throw new Error("Invalid blast mesh triangle.");
      // Directed edges have solid on the left, even for reversed input triangles.
      const ccw = cross > 0 ? ids : [ids[0], ids[2], ids[1]];
      for (let i = 0; i < 3; i++) {
        const a = ccw[i], b = ccw[(i + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (edges.has(key)) edges.get(key).count++;
        else edges.set(key, { a, b, count: 1 });
      }
    }
    const exterior = [...edges.values()].filter(edge => edge.count === 1);
    const outgoing = new Map(), incoming = new Map();
    for (const edge of exterior) {
      if (!outgoing.has(edge.a)) outgoing.set(edge.a, []);
      outgoing.get(edge.a).push(edge);
      incoming.set(edge.b, (incoming.get(edge.b) || 0) + 1);
    }
    const visited = new Set(), loops = [];
    for (const first of exterior) {
      if (visited.has(first)) continue;
      const ids = []; let edge = first, closed = false;
      while (edge && !visited.has(edge)) {
        visited.add(edge); ids.push(edge.a);
        if (outgoing.get(edge.a)?.length !== 1 || incoming.get(edge.a) !== 1) break;
        if (edge.b === first.a) { closed = true; break; }
        edge = outgoing.get(edge.b)?.[0];
      }
      if (!closed || ids.length < 3) continue;
      const points = ids.map(id => nodes.get(id)), origin = points[0];
      let signedArea = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        signedArea += (a.x - origin.x) * (b.y - origin.y) - (b.x - origin.x) * (a.y - origin.y);
      }
      loops.push({ nodeNumbers: ids, points, edgeCount: ids.length, signedArea: signedArea / 2 });
    }
    return loops;
  }

  function solve3(matrix) {
    for (let j = 0; j < 3; j++) {
      let pivot = j;
      for (let i = j + 1; i < 3; i++) if (Math.abs(matrix[i][j]) > Math.abs(matrix[pivot][j])) pivot = i;
      if (Math.abs(matrix[pivot][j]) < 1e-12) return null;
      [matrix[j], matrix[pivot]] = [matrix[pivot], matrix[j]];
      const divisor = matrix[j][j];
      for (let k = j; k < 4; k++) matrix[j][k] /= divisor;
      for (let i = 0; i < 3; i++) if (i !== j) {
        const factor = matrix[i][j];
        for (let k = j; k < 4; k++) matrix[i][k] -= factor * matrix[j][k];
      }
    }
    return matrix.map(row => row[3]);
  }

  function fitCircle(loop) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of loop.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2, scale = Math.max(maxX - minX, maxY - minY);
    if (!(scale > 0) || !Number.isFinite(scale)) return null;
    // Local coordinates avoid loss of precision for models far from the origin.
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sr = 0, sxr = 0, syr = 0;
    for (const p of loop.points) {
      const x = (p.x - ox) / scale, y = (p.y - oy) / scale, r = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sr += r; sxr += x * r; syr += y * r;
    }
    const fit = solve3([[sxx, sxy, sx, sxr], [sxy, syy, sy, syr], [sx, sy, loop.points.length, sr]]);
    if (!fit) return null;
    const [a, b, c] = fit, radius = Math.sqrt(c + (a * a + b * b) / 4) * scale;
    const centerX = ox + a * scale / 2, centerY = oy + b * scale / 2;
    const x = Math.abs(centerX) < scale * 1e-12 ? 0 : centerX, y = Math.abs(centerY) < scale * 1e-12 ? 0 : centerY;
    if (!(radius > 0) || !Number.isFinite(radius)) return null;
    if (!loop.points.every(p => Math.abs(Math.hypot(p.x - x, p.y - y) - radius) <= Math.max(radius * .03, 1e-10))) return null;
    return { x, y, radius, edgeCount: loop.edgeCount, key: String(loop.nodeNumbers.reduce((minimum, value) => Math.min(minimum, value), Infinity)) };
  }

  function analyze(model, settings = null) {
    const holes = boundaryLoops(model).filter(loop => loop.signedArea < 0);
    const cavities = holes.map(fitCircle).filter(Boolean);
    // Matching uses the native solver's 3% radial tolerance and 6-edge minimum.
    // Do not infer a radius or silently choose another hole during a run.
    const tolerance = settings ? Math.max(settings.radius * .03, 1e-10) : 0;
    const match = settings && holes.find(loop => loop.edgeCount >= 6 && loop.points.every(p =>
      Math.abs(Math.hypot(p.x - settings.x, p.y - settings.y) - settings.radius) <= tolerance));
    return { cavities, match: match ? { edgeCount: match.edgeCount } : null, holeCount: holes.length };
  }

  return { analyze };
});
