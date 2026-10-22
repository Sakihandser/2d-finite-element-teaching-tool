'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { initializeTriangle } = require('./generation-core.cjs');
const { refineAdaptiveWithTriangle } = require('../src/core/adaptive-mesh');
(async () => {
  const api = await initializeTriangle();
  const result = refineAdaptiveWithTriangle(api, workerData.nodes, workerData.elements, new Set(workerData.marked), { maxNodes: workerData.maxNodes });
  parentPort.postMessage({ result });
})().catch(error => { parentPort.postMessage({ error: error.message || String(error) }); });
