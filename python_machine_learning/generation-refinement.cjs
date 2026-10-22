'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { planAdaptiveRefinement } = require('../src/core/adaptive-mesh');

function refineInWorker(nodes, elements, marked, timeLimitMs, maxNodes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'generation-refinement-worker.cjs'), {
      workerData: { nodes, elements, marked: [...marked], maxNodes },
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // Await actual termination before retrying, avoiding overlapping WASM heaps.
      worker.terminate().then(() => error ? reject(error) : resolve(result), reject);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('参考网格加密达到耗时上限。'), { timedOut: true })), Math.max(1, timeLimitMs));
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`参考网格加密线程退出（${code}）。`)); });
  });
}

async function refineWithinBudget(nodes, elements, marked, maxNodes, timeLimitMs, refine = refineInWorker) {
  const deadline = Date.now()+timeLimitMs;
  let selected = planAdaptiveRefinement(nodes, elements, marked, maxNodes).marked;
  const attempts = [];
  for (let retry=0; retry<4 && selected.size; retry++) {
    const remaining = deadline-Date.now();
    if (remaining<=0) return { attempts, stopReason: 'time-limit' };
    let mesh;
    try { mesh = await refine(nodes,elements,selected,remaining,maxNodes); }
    catch (error) { return { attempts, stopReason: error.timedOut ? 'time-limit' : 'refinement-failure', error: error.message }; }
    attempts.push({ marked: selected.size, candidateNodes: mesh?.analysisNodes.length || nodes.length });
    if (Date.now()>=deadline) return { attempts, stopReason: 'time-limit' };
    if (!mesh) return { attempts, stopReason: 'local-size-limit' };
    if (mesh.analysisNodes.length<=maxNodes) return { mesh, attempts };
    selected = new Set([...selected].slice(0,Math.floor(selected.size/2)));
  }
  return { attempts, stopReason: 'node-budget' };
}

module.exports = { refineInWorker, refineWithinBudget };
