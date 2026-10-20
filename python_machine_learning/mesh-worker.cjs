// Isolated geometry/meshing adapter shared by dataset preparation and inference.
// Only geometry and prescribed physics enter a fresh seed mesh; solution results
// and the reference adaptive mesh are never used as input features.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const triangle = require('../src/vendor/triangle-wasm/triangle-wasm');

function geometryOnly(source) {
  return Object.fromEntries(['version', 'name', 'geometryNodes', 'curves', 'regions',
    'pointLoads', 'distributedLoads', 'bodyLoads'].map(key => [key, source[key]]));
}

function harness(source) {
  const element = { getContext: () => ({}), value: '', checked: false, classList: { toggle() {} } };
  const context = vm.createContext({ console, Math, structuredClone,
    window: { devicePixelRatio: 1 }, document: { getElementById: () => element, querySelectorAll: () => [] },
    updatePanel() {}, render() {}, renderCalculationView() {}, setCalculationLayer() {},
    selectObject() {}, closeShapeEditor() {}, TriangleWasm: triangle,
  });
  for (const file of ['global/state', 'core/numbers', 'core/material-utils', 'core/scene-objects', 'core/regular-shapes',
    'core/regions', 'core/analysis-classification', 'core/analysis-node-placement', 'core/analysis-mesh',
    'pages/drawing/load-hit-testing', 'pages/drawing/inspector', 'core/scene-io', 'core/calculation-export', 'core/adaptive-mesh']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', file + '.js'), 'utf8'), context, { filename: file });
  }
  context.inputScene = source;
  vm.runInContext('updatePanel = () => {}; selectObject = () => {}; triangleWasmInitialization = Promise.resolve(TriangleWasm); scene = normalizeScene(inputScene); rebuildDerivedRegions();', context);
  return context;
}

function pack(scene) {
  const indices = new Map(scene.analysisNodes.map((n, i) => [String(n.id), i]));
  const boundaries = new Map();
  const cells = scene.mesh.elements.map(e => {
    const ids = e.analysisNodeIds || e.nodeIds;
    const p = e.materialProperties;
    if (!p || !(p.elasticModulus > 0) || !(p.poissonRatio > -1 && p.poissonRatio < 0.5)) {
      throw new Error('单元缺少有效的弹性模量或泊松比，请先为全部结构区域指定材料。');
    }
    for (const edge of e.edges || []) if (edge.boundary) {
      const refs = edge.nodeIds.map(id => indices.get(String(id)));
      boundaries.set([...refs].sort((a,b) => a-b).join(':'), { nodes: refs, curveId: edge.curveId,
        fixed: edge.mechanicalState === 'static', tRange: edge.tRange || [0,1] });
    }
    return { nodes: ids.map(id => indices.get(String(id))), region: String(e.regionId || e.structureRegionId),
      E: p.elasticModulus * 1e9, nu: p.poissonRatio, rho: p.density || 0 };
  });
  if (!cells.length || cells.some(e => e.nodes.some(i => !Number.isInteger(i)))) throw new Error('模型没有有效的三角形网格。');
  return { nodes: scene.analysisNodes.map(n => [n.x, n.y, n.mechanicalState === 'static' ? 1 : 0]),
    cells, boundaries: [...boundaries.values()] };
}

async function prepare(source, referenceRequired = true) {
  const geometry = geometryOnly(source);
  const reference = referenceRequired ? pack(source) : null;
  const context = harness(geometry);
  const meshes = [];
  // Independent geometry-only seeds at different resolutions provide intermediate
  // inputs without leaking the final adaptive coordinates into the network.
  for (const count of referenceRequired ? [400, 1000, 2000] : [1000]) {
    await vm.runInContext(`autoGenerateAnalysisMesh({ adaptive: false, maxNodes: ${count}, regenerateNodes: true })`, context);
    meshes.push(pack(vm.runInContext('scene', context)));
  }
  const scene = vm.runInContext('scene', context);
  const adaptive = source.mesh?.metadata?.adaptive || {};
  const last = adaptive.history?.at(-1) || {};
  const signature = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  // Ignore display state, node numbering, load magnitude, material and name for
  // grouping. Different load cases on the same geometry cannot cross splits.
  const group = signature([geometry.geometryNodes?.map(n => [n.x,n.y]),
    geometry.curves?.map(c => [c.type,c.geometryNodeIds,c.controls]), geometry.regions?.map(r => [r.boundaryCurveIds,r.isAir])]);
  return { version: 1, name: String(source.name || '未命名模型'), geometry: geometryOnly(scene),
    meshes, reference, group, fingerprint: signature([geometry, reference]),
    referenceError: Number.isFinite(last.relativeError) ? last.relativeError : null,
    requestedError: adaptive.config?.relativeTolerance ?? null, stopReason: last.stopReason || 'manual-reference',
    provenance: source.dataGeneration || null, scene };
}

async function main() {
  const [command, inputPath, outputPath] = process.argv.slice(2);
  const wasm = fs.readFileSync(path.join(ROOT, 'src/vendor/triangle-wasm/triangle.out.wasm'));
  const server = require('node:http').createServer((_request,response) => {
    response.writeHead(200, {'Content-Type':'application/wasm'}); response.end(wasm);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try { await triangle.init(`http://127.0.0.1:${server.address().port}/triangle.out.wasm`); }
  finally { await new Promise(resolve => server.close(resolve)); }
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
  let result;
  if (command === 'prepare' || command === 'seed') {
    result = await prepare(input, command === 'prepare');
    if (command === 'prepare') delete result.scene;
  } else if (command === 'refine') {
    const context = harness(input.scene);
    context.currentMesh = input.scene;
    vm.runInContext('setAnalysisMesh({analysisNodes: currentMesh.analysisNodes, elements: currentMesh.mesh.elements, meshMetadata: currentMesh.mesh.metadata, analysisNodePlacement: currentMesh.analysisNodePlacement})', context);
    context.marked = new Set(input.marked.map(String));
    const refined = vm.runInContext('refineAdaptiveWithTriangle(TriangleWasm, scene.analysisNodes, scene.mesh.elements, marked)', context);
    if (refined) {
      context.refined = refined;
      vm.runInContext(`
        const metadata = structuredClone(currentMesh.mesh.metadata || {});
        metadata.algorithm = 'gnn-size-field-triangle';
        metadata.prediction = { pending: true };
        metadata.stale = false;
        metadata.counts = { ...metadata.counts, nodes: refined.analysisNodes.length, elements: refined.elements.length };
        setAnalysisMesh({ ...refined, meshMetadata: metadata, analysisNodePlacement: currentMesh.analysisNodePlacement });
        scene.mesh.metadata.regionElementSets = buildRegionElementSets(scene.mesh.elements);
      `, context);
    }
    const scene = vm.runInContext('scene', context);
    result = { scene, mesh: pack(scene) };
  } else throw new Error('Unknown mesh command');
  fs.writeFileSync(outputPath, JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { geometryOnly, harness, pack, prepare };
