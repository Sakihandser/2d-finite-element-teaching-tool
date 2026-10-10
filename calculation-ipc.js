"use strict";

const INPUT_MAGIC = Buffer.from("FEMBIN01", "ascii");
const RESULT_MAGIC = Buffer.from([0x46, 0x45, 0x4d, 0x52, 0x45, 0x53, 0x31, 0x00]);
const PROTOCOL_VERSION = 1;
const MAX_RECORD_COUNT = 20_000_000;

class BinaryWriter {
  constructor(initialCapacity = 1024 * 1024) {
    this.buffer = Buffer.allocUnsafe(initialCapacity);
    this.offset = 0;
  }

  ensure(byteCount) {
    const required = this.offset + byteCount;
    if (required <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < required) capacity *= 2;
    const next = Buffer.allocUnsafe(capacity);
    this.buffer.copy(next, 0, 0, this.offset);
    this.buffer = next;
  }

  bytes(value) {
    this.ensure(value.length);
    value.copy(this.buffer, this.offset);
    this.offset += value.length;
  }

  uint8(value) {
    this.ensure(1);
    this.buffer.writeUInt8(value ? 1 : 0, this.offset);
    this.offset += 1;
  }

  uint32(value) {
    this.ensure(4);
    this.buffer.writeUInt32LE(checkedCount(value, "count"), this.offset);
    this.offset += 4;
  }

  int32(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff) {
      throw new Error(`二进制计算协议需要 32 位整数，收到：${value}`);
    }
    this.ensure(4);
    this.buffer.writeInt32LE(number, this.offset);
    this.offset += 4;
  }

  double(value) {
    this.ensure(8);
    this.buffer.writeDoubleLE(finiteNumber(value), this.offset);
    this.offset += 8;
  }

  string(value) {
    const encoded = Buffer.from(String(value || ""), "utf8");
    this.uint32(encoded.length);
    this.bytes(encoded);
  }

  finish() {
    return this.buffer.subarray(0, this.offset);
  }
}

class BinaryReader {
  constructor(buffer) {
    this.buffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    this.offset = 0;
  }

  require(byteCount) {
    if (this.offset + byteCount > this.buffer.length) {
      throw new Error("C++ 返回的二进制计算结果不完整。");
    }
  }

  bytes(byteCount) {
    this.require(byteCount);
    const value = this.buffer.subarray(this.offset, this.offset + byteCount);
    this.offset += byteCount;
    return value;
  }

  uint32() {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  int32() {
    this.require(4);
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  double() {
    this.require(8);
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }
}

function encodeCalculationModelBinary(model = {}) {
  const materials = arrayOf(model.materials);
  const nodes = arrayOf(model.nodes);
  const elements = arrayOf(model.elements);
  const elementNodeLoads = arrayOf(model.elementNodeLoads);
  const warnings = arrayOf(model.warnings);
  [materials.length, nodes.length, elements.length, elementNodeLoads.length, warnings.length].forEach((count) =>
    checkedCount(count, "record"),
  );

  const writer = new BinaryWriter();
  writer.bytes(INPUT_MAGIC);
  writer.uint32(PROTOCOL_VERSION);
  writer.string(model.modelName);
  writer.string(model.generatedAt);
  writer.string(model.units?.length);
  writer.string(model.units?.force);
  writer.string(model.units?.elasticModulus);
  writer.string(model.units?.density);
  writer.string(model.units?.strength);

  writer.int32(integerOrZero(model.counts?.nodes ?? nodes.length));
  writer.int32(integerOrZero(model.counts?.elements ?? elements.length));
  writer.int32(integerOrZero(model.counts?.materials ?? materials.length));
  writer.int32(integerOrZero(model.counts?.pointLoads));
  writer.int32(integerOrZero(model.counts?.distributedLoads));
  writer.int32(integerOrZero(model.counts?.bodyLoads));
  writer.uint32(materials.length);
  writer.uint32(nodes.length);
  writer.uint32(elements.length);
  writer.uint32(elementNodeLoads.length);

  for (const material of materials) {
    writer.int32(material.materialNo);
    writer.double(material.elasticModulus);
    writer.double(material.poissonRatio);
    writer.double(material.density);
    writer.double(material.yieldStrength);
    writer.double(material.tensileStrength);
    writer.double(material.compressiveStrength);
  }

  for (const node of nodes) {
    writer.int32(node.nodeNo);
    writer.double(node.x);
    writer.double(node.y);
    writer.uint8(node.fixUx);
    writer.uint8(node.fixUy);
    writer.int32(node.dofUx);
    writer.int32(node.dofUy);
    writer.double(node.forceX);
    writer.double(node.forceY);
    writer.int32(node.materialNo);
    writer.int32(node.regionNo);
  }

  for (const element of elements) {
    writer.int32(element.elementNo);
    writer.int32(element.node1);
    writer.int32(element.node2);
    writer.int32(element.node3);
    writer.double(element.area);
    writer.double(element.centroidX);
    writer.double(element.centroidY);
    writer.int32(element.materialNo);
    writer.double(element.elasticModulus);
    writer.double(element.poissonRatio);
    writer.double(element.density);
    writer.double(element.yieldStrength);
    writer.double(element.tensileStrength);
    writer.double(element.compressiveStrength);
  }

  for (const load of elementNodeLoads) {
    writer.int32(load.elementNo);
    writer.double(load.forceX1);
    writer.double(load.forceY1);
    writer.double(load.forceX2);
    writer.double(load.forceY2);
    writer.double(load.forceX3);
    writer.double(load.forceY3);
  }

  writer.uint32(warnings.length);
  warnings.forEach((warning) => writer.string(warning));
  return writer.finish();
}

function decodeCalculationResultBinary(buffer, metadata = {}) {
  const reader = new BinaryReader(buffer);
  if (!reader.bytes(RESULT_MAGIC.length).equals(RESULT_MAGIC)) {
    throw new Error("C++ 返回了不受支持的二进制计算结果头。");
  }
  if (reader.uint32() !== PROTOCOL_VERSION) {
    throw new Error("C++ 返回了不受支持的二进制计算协议版本。");
  }
  const nodeCount = checkedCount(reader.uint32(), "node");
  const elementCount = checkedCount(reader.uint32(), "element");
  const nodeDisplacements = new Array(nodeCount);
  const elementResults = new Array(elementCount);

  for (let index = 0; index < nodeCount; index += 1) {
    nodeDisplacements[index] = {
      nodeNo: reader.int32(),
      ux: reader.double(),
      uy: reader.double(),
      magnitude: reader.double(),
    };
  }

  for (let index = 0; index < elementCount; index += 1) {
    const result = {
      elementNo: reader.int32(),
      strainXx: reader.double(),
      strainXy: reader.double(),
      strainYx: reader.double(),
      strainYy: reader.double(),
      stressXx: reader.double(),
      stressXy: reader.double(),
      stressYx: reader.double(),
      stressYy: reader.double(),
      safetyCode: reader.int32(),
    };
    result.safetyText = safetyText(result.safetyCode);
    result.equivalentStress = equivalentTensorValue(result.stressXx, result.stressXy, result.stressYx, result.stressYy);
    result.equivalentStrain = equivalentTensorValue(result.strainXx, result.strainXy, result.strainYx, result.strainYy);
    elementResults[index] = result;
  }
  if (reader.offset !== reader.buffer.length) {
    throw new Error("C++ 二进制计算结果包含未识别的尾部数据。");
  }

  return {
    header: "FEM_CALCULATION_RESULT_BINARY_V1",
    modelName: String(metadata.modelName || ""),
    generatedAt: String(metadata.generatedAt || new Date().toISOString()),
    sourceInput: "Node.js/C++ binary pipe",
    units: metadata.units || { displacement: "model", strain: "1", stress: "Pa" },
    counts: { nodes: nodeCount, elements: elementCount },
    nodeDisplacements,
    elementResults,
  };
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integerOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function checkedCount(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > MAX_RECORD_COUNT) {
    throw new Error(`二进制计算协议中的 ${name} 数量无效：${value}`);
  }
  return number;
}

function safetyText(code) {
  return ["OK", "COMPRESSION_LIMIT", "TENSILE_LIMIT", "YIELD_LIMIT"][code] || "UNKNOWN";
}

function equivalentTensorValue(xx, xy, yx, yy) {
  const shear = (finiteNumber(xy) + finiteNumber(yx)) * 0.5;
  const sx = finiteNumber(xx);
  const sy = finiteNumber(yy);
  return Math.sqrt(Math.max(0, sx * sx - sx * sy + sy * sy + 3 * shear * shear));
}

module.exports = {
  PROTOCOL_VERSION,
  encodeCalculationModelBinary,
  decodeCalculationResultBinary,
};
