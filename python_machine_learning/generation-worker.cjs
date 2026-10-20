'use strict';
// Each reference case runs in its own process, bounding WASM/solver failures
// and keeping the HTTP server and the drawing scene responsive and independent.
const fs = require('node:fs/promises');
const { initializeTriangle, normalizeGenerated, buildReference } = require('./generation-core.cjs');

process.once('message', async request => {
  try {
    const source = JSON.parse(await fs.readFile(request.input, 'utf8'));
    if (request.preview) {
      await fs.writeFile(request.output, JSON.stringify(normalizeGenerated(source).scene));
    } else {
      await initializeTriangle();
      const { runCalculationCore } = require('../server');
      const reference = await buildReference(source, request.config, runCalculationCore,
        detail => process.send?.({ type: 'progress', ...detail }));
      await fs.writeFile(request.output, JSON.stringify(reference.scene));
      await fs.writeFile(request.result, JSON.stringify(reference.result));
    }
    process.send?.({ type: 'done' });
    process.disconnect();
  } catch (error) {
    process.send?.({ type: 'error', error: error.stack || error.message });
    process.disconnect(); process.exitCode = 1;
  }
});
