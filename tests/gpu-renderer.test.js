"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../src/core/gpu-renderer.js"), "utf8");

function harness(available = true) {
  const calls = { uploads: 0, draws: 0, deleted: 0, attributes: null, uniforms: {} };
  let lost = false;
  const gl = new Proxy({
    getExtension: () => ({}), isContextLost: () => lost,
    getShaderParameter: () => true, getProgramParameter: () => true,
    createBuffer: () => ({}), createProgram: () => ({}), createShader: () => ({}),
    getAttribLocation: (_, name) => name, getUniformLocation: (_, name) => name,
    bufferData: (_, vertices) => { calls.uploads++; calls.vertices = vertices; },
    deleteBuffer: () => calls.deleted++, drawArrays: () => calls.draws++,
    uniform2f: (name, x, y) => { calls.uniforms[name] = [x, y]; },
    uniform1f: (name, value) => { calls.uniforms[name] = value; },
  }, { get: (target, key) => key in target ? target[key] : /^[A-Z_]+$/.test(key) ? key : () => {} });
  const canvas = { width: 0, height: 0, addEventListener() {}, getContext: (_, attributes) => { calls.attributes = attributes; return available ? gl : null; } };
  const frames = [];
  const context = vm.createContext({ document: { createElement: () => canvas }, requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; } });
  vm.runInContext(source, context);
  const api = vm.runInContext("gpuMeshRenderer", context);
  const ctx = { canvas: { dataset: {} }, drawImage: () => calls.composited = true };
  const view = { width: 640, height: 480, offsetX: 100, offsetY: 200, scale: 10 };
  return { api, context, ctx, view, calls, frames, lose: () => { lost = true; } };
}

test("GPU uploads once per dataset, changes uniforms for camera/deformation, and invalidates buffers", () => {
  const { api, ctx, view, calls } = harness();
  const owner = {};
  const build = () => ({ vertices: new Float32Array(33), origin: { x: 1e8, y: -1e8 } });
  assert.equal(api.draw(ctx, view, 2, owner, "mesh", 0, build), true);
  assert.equal(api.draw(ctx, { ...view, offsetX: 150 }, 2, owner, "mesh", 0, build, { factor: 7 }), true);
  assert.equal(calls.uploads, 1);
  assert.equal(calls.uniforms.uDeformation, 7);
  assert.equal(calls.uniforms.uOffset[0], 150 + 1e9);
  assert.equal(calls.attributes.powerPreference, "high-performance");
  assert.equal(calls.attributes.failIfMajorPerformanceCaveat, true);
  assert.equal(ctx.canvas.dataset.renderBackend, "webgl");
  api.draw(ctx, view, 1, owner, "mesh", 1, build);
  assert.equal(calls.uploads, 2);
  assert.equal(calls.deleted, 1);
});

test("GPU unavailable or lost returns control to Canvas fallback", () => {
  for (const available of [false, true]) {
    const { api, ctx, view, lose } = harness(available);
    if (available) {
      api.draw(ctx, view, 1, {}, "mesh", 0, () => ({ vertices: new Float32Array(33) }));
      lose();
    }
    assert.equal(api.draw(ctx, view, 1, {}, "mesh", 0, () => { throw new Error("must not build"); }), false);
    assert.equal(ctx.canvas.dataset.renderBackend, "canvas2d");
  }
});

test("repeated pointer events coalesce into one frame", () => {
  const { api, frames } = harness();
  let count = 0;
  for (let i = 0; i < 100; i++) api.requestFrame("result", () => count++);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(count, 1);
  api.requestFrame("result", () => count++);
  assert.equal(frames.length, 2);
});

test("triangle buffers retain displacement/color and use a local origin for large coordinates", () => {
  const { context } = harness();
  const nodes = [{ x: 1e8, y: 1e8, ux: 0.02, uy: -0.01 }, { x: 1e8 + 0.01, y: 1e8 }, { x: 1e8, y: 1e8 + 0.01 }];
  const packet = context.buildGpuTriangles([{ nodes }], (element) => element.nodes, () => [1, 0, 0, 0.7]);
  assert.equal(packet.vertices.length, 33);
  assert.ok(Math.abs(packet.vertices[11] - 0.01) < 1e-7);
  assert.ok(Math.abs(packet.vertices[2] - 0.02) < 1e-8);
  assert.deepEqual(Array.from(packet.vertices.slice(8, 11)), [1, 0, 0]);
});
