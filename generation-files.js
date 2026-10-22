'use strict';
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function replaceFile(source, destination, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  let wait = 50;
  for (;;) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
      await delay(Math.min(wait, Math.max(0, deadline - Date.now())));
      wait = Math.min(wait * 2, 500);
    }
  }
}

async function atomicJson(file, data) {
  // Each writer owns its temporary file; preserve the previous complete JSON
  // until replacement succeeds, even if OneDrive/scanners briefly lock it.
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(data, null, 2));
    await replaceFile(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

module.exports = { atomicJson, replaceFile };
