"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "core", "scene-objects.js"), "utf8");

function createLoadMath() {
  const context = {
    Math,
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    lerp: (start, end, t) => start + (end - start) * t,
  };
  vm.runInNewContext(SOURCE, context, { filename: "scene-objects.js" });
  return context;
}

test("线性分布载荷使用整组统一比例显示", () => {
  const api = createLoadMath();
  const load = { qStart: 0, qEnd: 3000, start: 0, end: 1 };
  const lengths = Array.from({ length: 7 }, (_, index) => api.distributedLoadDisplayLengthAt(load, index / 6));

  assert.equal(lengths[0], 0);
  assert.equal(lengths[6], 72);
  for (let index = 1; index < lengths.length; index++) {
    assert.ok(Math.abs(lengths[index] - lengths[index - 1] - 12) < 1e-9);
  }
});

test("小数值均布载荷仍清晰可见且不会破坏均布", () => {
  const api = createLoadMath();
  const load = { qStart: 5, qEnd: 5, start: 0, end: 1 };
  const lengths = Array.from({ length: 7 }, (_, index) => api.distributedLoadDisplayLengthAt(load, index / 6));

  assert.deepEqual(lengths, [35, 35, 35, 35, 35, 35, 35]);
});

test("反向线性分布载荷按同一比例递减", () => {
  const api = createLoadMath();
  const load = { qStart: 3000, qEnd: 0, start: 0, end: 1 };
  const lengths = Array.from({ length: 7 }, (_, index) => api.distributedLoadDisplayLengthAt(load, index / 6));

  assert.equal(lengths[0], 72);
  assert.equal(lengths[6], 0);
  for (let index = 1; index < lengths.length; index++) {
    assert.ok(Math.abs(lengths[index - 1] - lengths[index] - 12) < 1e-9);
  }
});
