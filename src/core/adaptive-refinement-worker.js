// Dedicated worker: importing adaptive-mesh only defines pure refinement
// functions; it does not access the DOM or modify the current scene.
importScripts("../vendor/triangle-wasm/triangle-wasm.js", "./adaptive-mesh.js");
self.onmessage = async ({ data }) => {
  try {
    await TriangleWasm.init("../vendor/triangle-wasm/triangle.out.wasm");
    const result = refineAdaptiveWithTriangle(TriangleWasm, data.nodes, data.elements, new Set(data.marked), data.options || {});
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
