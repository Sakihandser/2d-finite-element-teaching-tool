'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { launcherPython } = require('../training-bridge');

test('CPU environment can bootstrap training without any CUDA installation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fem-cpu-launcher-'));
  const previous = process.env.FEM_ML_PYTHON;
  delete process.env.FEM_ML_PYTHON;
  try {
    const python = path.join(directory, '.venv-cpu', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
    assert.equal(launcherPython(directory), python);
  } finally {
    if (previous === undefined) delete process.env.FEM_ML_PYTHON; else process.env.FEM_ML_PYTHON = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('missing Python environments provide the actionable setup command', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fem-no-runtime-'));
  const previous = process.env.FEM_ML_PYTHON;
  delete process.env.FEM_ML_PYTHON;
  try {
    assert.throws(() => launcherPython(directory), /scripts\/setup-ml\.ps1/);
  } finally {
    if (previous === undefined) delete process.env.FEM_ML_PYTHON; else process.env.FEM_ML_PYTHON = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('portable distributions use the self-contained Python executable at the runtime root', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fem-portable-launcher-'));
  const previous = process.env.FEM_ML_PYTHON;
  delete process.env.FEM_ML_PYTHON;
  try {
    const runtime = path.join(directory, '.venv-cpu');
    fs.mkdirSync(runtime, { recursive: true });
    const python = path.join(runtime, process.platform === 'win32' ? 'python.exe' : 'bin/python');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
    assert.equal(launcherPython(directory), python);
  } finally {
    if (previous === undefined) delete process.env.FEM_ML_PYTHON; else process.env.FEM_ML_PYTHON = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
