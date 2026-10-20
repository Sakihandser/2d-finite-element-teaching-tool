'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { harness, pack } = require('./mesh-worker.cjs');
const ROOT = path.resolve(__dirname, '..');

function validateConfig(input = {}) {
  const number = (key, fallback, min, max, integer = false) => {
    const value = Number(input[key] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new Error(`生成参数 ${key} 必须在 ${min}–${max} 范围内${integer ? '且为整数' : ''}。`);
    return value;
  };
  const now=new Date();
  const timestamp=[now.getFullYear(),now.getMonth()+1,now.getDate(),now.getHours(),now.getMinutes(),now.getSeconds()]
    .map((value,index)=>String(value).padStart(index===0?4:2,'0')).join('');
  const seed = String(input.seed ?? timestamp).trim();
  if (!seed || seed.length > 100) throw new Error('随机种子需为 1–100 个字符。');
  const list = (key, fallback, allowed) => {
    const values = input[key] ?? fallback;
    if (!Array.isArray(values) || !values.length || values.some(v => !allowed.includes(v)))
      throw new Error(`请为 ${key} 选择至少一种有效类型。`);
    return [...new Set(values)];
  };
  const config = { seed, geometries: number('geometries', 5, 1, 200, true),
    conditions: number('conditions', 2, 1, 20, true), maxPrimitives: number('maxPrimitives', 4, 1, 8, true),
    maxRegions: number('maxRegions', 4, 1, 8, true), maxHoles: number('maxHoles', 2, 0, 4, true),
    minSize: number('minSize', 2, .1, 100), maxSize: number('maxSize', 8, .1, 100),
    minForce: number('minForce', 100, .01, 1e8), maxForce: number('maxForce', 10000, .01, 1e8),
    seedNodes: number('seedNodes', 400, 100, 5000, true), maxNodes: number('maxNodes', 30000, 100, 100000, true),
    maxIterations: number('maxIterations', 7, 0, 100, true), targetError: number('targetError', .05, .000001, .95),
    timeLimitSeconds: number('timeLimitSeconds', 30, 1, 3600), caseTimeLimitSeconds: number('caseTimeLimitSeconds', 600, 1, 86400),
    validationFraction: number('validationFraction', .2, 0, 1), importSplit: input.importSplit ?? 'auto',
    shapes: list('shapes', ['rectangle','triangle','circle','ellipse','polygon'], ['rectangle','triangle','circle','ellipse','polygon']),
    loadTypes: list('loadTypes', ['point','distributed','body'], ['point','distributed','body']),
    autoImport: input.autoImport !== false, targetOnly: true,
    useGpuAcceleration: input.useGpuAcceleration === true };
  if (config.minSize > config.maxSize || config.minForce > config.maxForce || config.seedNodes > config.maxNodes)
    throw new Error('尺寸/载荷的最小值不能大于最大值，基础节点预算不能超过参考节点预算。');
  if (config.geometries * config.conditions > 1000) throw new Error('每批最多生成 1000 个工况。');
  if (!['auto','train','validation'].includes(config.importSplit)) throw new Error('自动加入用途必须是按比例划分、训练集或验证集。');
  if (input.materialIds != null) {
    if (!Array.isArray(input.materialIds) || input.materialIds.some(v => typeof v !== 'string')) throw new Error('材料 ID 列表无效。');
    config.materialIds = input.materialIds;
  }
  return config;
}

async function generateGeometry(config, index = 0) {
  const python = path.join(__dirname, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(__dirname, 'random_geometry.py')], {
      cwd: ROOT, windowsHide: true, stdio: ['pipe','pipe','pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 10000000) child.kill(); });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || '随机几何生成超时或失败，请检查 requirements-generator.txt。'));
      try { resolve(JSON.parse(output)); } catch (err) { reject(err); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ config, index }));
  });
}

async function initializeTriangle() {
  const triangle = require('../src/vendor/triangle-wasm/triangle-wasm');
  const wasm = await fs.readFile(path.join(ROOT, 'src/vendor/triangle-wasm/triangle.out.wasm'));
  const server = require('node:http').createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/wasm' }); response.end(wasm);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await triangle.init(`http://127.0.0.1:${server.address().port}/triangle.out.wasm`); }
  finally { await new Promise(resolve => server.close(resolve)); }
  return triangle;
}

function normalizeGenerated(source) {
  const context = harness(source);
  const scene = vm.runInContext('scene', context);
  const expected = source.regions.filter(r => !r.isAir).length;
  if (scene.regions.filter(r => !r.isAir).length !== expected ||
      scene.regions.filter(r => r.isAir).length !== source.regions.filter(r => r.isAir).length)
    throw new Error('导入后区域拓扑与生成器不一致，工况已拒绝。');
  if (scene.regions.some(r => !r.isAir && !r.materialProperties?.elasticModulus))
    throw new Error('导入后区域材料丢失，工况已拒绝。');
  scene.dataGeneration = structuredClone(source.dataGeneration);
  return { context, scene };
}

async function buildReference(source, config, solve, progress = () => {}, stopped = () => false) {
  const started = Date.now(),caseLimitMs=(config.caseTimeLimitSeconds??600)*1000;
  const remaining = () => caseLimitMs-(Date.now()-started);
  const { context } = normalizeGenerated(source);
  const run = code => vm.runInContext(code, context);
  await run(`autoGenerateAnalysisMesh({adaptive:false,maxNodes:${config.seedNodes},regenerateNodes:true})`);
  let scene = run('scene');
  if (scene.analysisNodes.length > config.maxNodes) throw new Error('基础网格已超过参考节点预算。');
  const policy = context.createAdaptiveRefinementPolicy(scene.analysisNodes, scene.mesh.elements);
  const history = [];
  let lastResult;
  for (let iteration = 0; iteration <= config.maxIterations; iteration++) {
    if (stopped()) throw new Error('用户已请求停止；当前未完成工况未导入。');
    if(remaining()<=0){
      if(history.length){history.at(-1).stopReason='case-time-limit';break;}
      throw new Error('工况总耗时已达到上限，尚无成功求解的参考网格。');
    }
    progress({ stage: 'solve', iteration, nodes: scene.analysisNodes.length, elements: scene.mesh.elements.length });
    const iterationStarted = Date.now();
    const { payload } = context.prepareCalculationModelData();
    const model = context.calculationInputPayloadToDirectModel(payload);
    const fixed = model.nodes.filter(n => n.fixUx && n.fixUy);
    if (fixed.length < 2 || Math.max(...fixed.map(n => Math.hypot(n.x-fixed[0].x,n.y-fixed[0].y))) < 1e-7)
      throw new Error('支撑不足以消除刚体运动。');
    if (!model.nodes.some(n => !n.fixUx && Math.hypot(n.forceX,n.forceY) > 1e-12))
      throw new Error('自由节点没有有效外载荷。');
    const solveBudget=Math.min(config.timeLimitSeconds*1000,remaining());
    if(solveBudget<=0){
      if(history.length){history.at(-1).stopReason='case-time-limit';break;}
      throw new Error('工况总耗时已达到上限，尚无成功求解的参考网格。');
    }
    const caseBounded=solveBudget<config.timeLimitSeconds*1000;
    const result = await solve(model, { adaptive: true, timeLimitMs: Math.max(1,Math.floor(solveBudget)),
      useGpuAcceleration: config.useGpuAcceleration });
    if (!result.ok) {
      if (result.timedOut && history.length) { history.at(-1).stopReason = caseBounded?'case-time-limit':'time-limit'; break; }
      if(result.timedOut)throw new Error(caseBounded?'工况总耗时已达到上限，首次求解未完成。':'首次求解达到每轮耗时上限，尚无有效参考网格。');
      throw new Error(result.stderr || result.error || '有限元求解失败。');
    }
    if (!Array.isArray(result.resultData.nodeDisplacements) || result.resultData.nodeDisplacements.length !== model.nodes.length ||
        result.resultData.nodeDisplacements.some(n => !Number.isFinite(n.ux) || !Number.isFinite(n.uy)))
      throw new Error('有限元位移结果含非有限值。');
    const estimate = context.estimateZZError(payload, result.resultData);
    if (!(estimate.relativeError > 0 && estimate.relativeError < 1))
      throw new Error('实际 ZZ 误差不在当前训练器支持的 (0,1) 范围内。');
    lastResult = result.resultData;
    const displacements = new Map(lastResult.nodeDisplacements.map(n => [n.nodeNo,n]));
    for (const node of scene.analysisNodes) {
      const value = displacements.get(node.number);
      if (value) { node.ux = value.ux; node.uy = value.uy; }
    }
    const step = { iteration, nodes: scene.analysisNodes.length, elements: scene.mesh.elements.length,
      relativeError: estimate.relativeError, totalError: estimate.totalError, durationMs: Date.now()-iterationStarted };
    history.push(step);
    if (estimate.relativeError <= config.targetError) { step.stopReason = 'target-error'; break; }
    if(remaining()<=0){step.stopReason='case-time-limit';break;}
    if (iteration === config.maxIterations) { step.stopReason = 'iteration-limit'; break; }
    if (Date.now()-iterationStarted >= config.timeLimitSeconds*1000) { step.stopReason = 'time-limit'; break; }
    const selection = context.markAdaptiveElements(payload, estimate, policy);
    progress({ stage: 'refine', iteration, nodes: scene.analysisNodes.length });
    const refined = context.refineAdaptiveWithTriangle(context.TriangleWasm, scene.analysisNodes, scene.mesh.elements, selection.marked);
    if(remaining()<=0){step.stopReason='case-time-limit';break;}
    if (!refined) { step.stopReason = selection.saturated ? 'local-size-limit' : 'no-marked-elements'; break; }
    if (refined.analysisNodes.length > config.maxNodes) { step.stopReason = 'node-budget'; break; }
    if (Date.now()-iterationStarted >= config.timeLimitSeconds*1000) { step.stopReason = 'time-limit'; break; }
    // Save the solved state before committing a candidate. A later timeout
    // restores this snapshot rather than exporting new cells with older labels.
    const saved = { analysisNodes: structuredClone(scene.analysisNodes), elements: structuredClone(scene.mesh.elements),
      meshMetadata: structuredClone(scene.mesh.metadata), analysisNodePlacement: structuredClone(scene.analysisNodePlacement) };
    context.setAnalysisMesh({ ...refined, meshMetadata: { ...scene.mesh.metadata, stale: false }, analysisNodePlacement: scene.analysisNodePlacement });
    scene = run('scene');
    scene._generationLastSolved = saved;
  }
  if (scene._generationLastSolved && scene.analysisNodes.length !== history.at(-1)?.nodes) {
    context.setAnalysisMesh(scene._generationLastSolved); scene = run('scene');
  }
  delete scene._generationLastSolved;
  pack(scene); // Validate material and connectivity before any training import.
  scene.mesh.metadata.adaptive = { config: { relativeTolerance: config.targetError,
    maxIterations: config.maxIterations, timeLimitMs: config.timeLimitSeconds*1000,caseTimeLimitMs:caseLimitMs }, history };
  scene.mesh.metadata.counts = { ...scene.mesh.metadata.counts, nodes: scene.analysisNodes.length, elements: scene.mesh.elements.length };
  scene.mesh.metadata.regionElementSets = context.buildRegionElementSets(scene.mesh.elements);
  scene.dataGeneration = { ...source.dataGeneration, durationMs: Date.now()-started,
    achievedError: history.at(-1).relativeError, stopReason: history.at(-1).stopReason };
  return { scene: JSON.parse(JSON.stringify(scene)), result: lastResult };
}

module.exports = { ROOT, validateConfig, generateGeometry, initializeTriangle, normalizeGenerated, buildReference };
