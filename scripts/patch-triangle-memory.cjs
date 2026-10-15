// Local adaptation of the bundled Triangle Emscripten build. Run with Node.
// Only relax the imported memory maximum; no Triangle machine code is changed.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../src/vendor/triangle-wasm');
const wasmPath = path.join(root, 'triangle.out.wasm');
const bytes = fs.readFileSync(wasmPath);
let pos = 8;
function read() { let n = 0, shift = 0, b; do { b = bytes[pos++]; n |= (b & 127) << shift; shift += 7; } while (b & 128); return n; }
function write(n) { const out = []; do { const b = n & 127; n >>>= 7; out.push(b | (n ? 128 : 0)); } while (n); return Buffer.from(out); }
function skipString() { const size = read(); pos += size; }
while (pos < bytes.length) {
  const sectionStart = pos, id = bytes[pos++], size = read(), start = pos, end = pos + size;
  if (id === 2) {
    const count = read();
    for (let i = 0; i < count; i++) {
      skipString(); skipString(); const kind = bytes[pos++];
      if (kind === 0) read();
      else if (kind === 2) {
        const limitsStart = pos, flags = read(), min = read(), max = flags & 1 ? read() : null;
        if (flags === 0 && min === 256) break; // already patched
        if (flags !== 1 || min !== 256 || max !== 256) throw new Error('Unexpected Triangle memory import');
        const payload = Buffer.concat([bytes.subarray(start, limitsStart), write(0), write(min), bytes.subarray(pos, end)]);
        fs.writeFileSync(wasmPath, Buffer.concat([bytes.subarray(0, sectionStart), Buffer.from([id]), write(payload.length), payload, bytes.subarray(end)]));
        break;
      } else throw new Error('Unexpected Triangle import kind');
    }
    break;
  }
  pos = end;
}
const jsPath = path.join(root, 'triangle-wasm.js');
let source = fs.readFileSync(jsPath, 'utf8').replace(/\r\n/g, '\n');
function replace(old, next) {
  if (source.includes(next)) return;
  if (!source.includes(old)) throw new Error('Unexpected Triangle runtime: ' + old.slice(0, 70));
  source = source.replace(old, next);
}
replace('"maximum":INITIAL_INITIAL_MEMORY/WASM_PAGE_SIZE', '"maximum":32768');
replace('function _emscripten_resize_heap(requestedSize){requestedSize=requestedSize>>>0;abortOnCannotGrowMemory(requestedSize)}',
  'function _emscripten_resize_heap(requestedSize){requestedSize=requestedSize>>>0;var oldSize=wasmMemory.buffer.byteLength;for(var factor of [1.25,1]){var newSize=Math.min(2147483648,Math.ceil(Math.max(requestedSize,oldSize*factor)/65536)*65536);if(newSize<requestedSize)continue;try{wasmMemory.grow((newSize-oldSize)/65536);buffer=wasmMemory.buffer;updateGlobalBufferAndViews(buffer);return true}catch(e){}}return false}');
replace('\t\tthis.arr = heapToArray(this.ptr, TriangulateIO.LENGTH);', '\t\t// Heap views are refreshed by the arr getter after WebAssembly memory growth.');
replace('\tstatic get LENGTH() { return 23; }', '\tstatic get LENGTH() { return 23; }\n\n\tget arr() { return heapToArray(this.ptr, TriangulateIO.LENGTH); }');
replace('\tconst ptr = Module._malloc(length);', '\tconst ptr = Module._malloc(length);\n\tif (!ptr) throw new Error("Triangle memory allocation failed");');
replace('\tconst ptr = Module._malloc(typedArray.length * typedArray.BYTES_PER_ELEMENT);', '\tconst ptr = Module._malloc(typedArray.length * typedArray.BYTES_PER_ELEMENT);\n\tif (!ptr) throw new Error("Triangle memory allocation failed");');
replace('\t\tthis.ptr = Module._malloc(TriangulateIO.LENGTH * Int32Array.BYTES_PER_ELEMENT);', '\t\tthis.ptr = Module._malloc(TriangulateIO.LENGTH * Int32Array.BYTES_PER_ELEMENT);\n\t\tif (!this.ptr) throw new Error("Triangle memory allocation failed");');
replace('\t\tfor (const prop in props) {\n\t\t\tif (prop in this) this[prop] = props[prop];\n\t\t}', '\t\ttry {\n\t\t\tfor (const prop in props) if (prop in this) this[prop] = props[prop];\n\t\t} catch (error) { this.destroy(true); throw error; }');
// Evaluate malloc before obtaining the view used for assigning the pointer.
source = source.replace(/this\.arr\[(\d+)\] = arrayToHeap\(([^;]+)\);/g, 'const ptr = arrayToHeap($2);\n\t\tthis.arr[$1] = ptr;');
replace('\t\tModule._free(this.ptr);', '\t\t// Free the IO structure after reading its shared-pointer fields.');
replace('\t\t\tModule._free(this.arr[17]);\n\t\t}', '\t\t\tModule._free(this.arr[17]);\n\t\t}\n\t\tModule._free(this.ptr);');
replace('\tModule._triangulate(s_ptr, input.ptr, output.ptr, v_ptr);\n\n\tModule._free(s_ptr);', '\ttry { Module._triangulate(s_ptr, input.ptr, output.ptr, v_ptr); }\n\tfinally { Module._free(s_ptr); }');
replace('\tgetSwitchesStr,\n};', '\tgetSwitchesStr,\n\tgetMemorySize: () => Module.HEAPU8.buffer.byteLength,\n};');
fs.writeFileSync(jsPath, source.replace(/[\t ]+$/gm, ''));
console.log('Triangle supports growing memory and refreshed IO views.');
