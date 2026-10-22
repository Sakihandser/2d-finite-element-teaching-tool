// 一个共享 WebGL 画布负责网格批量绘制；文字、坐标轴和交互仍由现有 2D 画布叠加。
// 几何/颜色只上传一次，缩放、平移和变形仅改变 uniform，不逐单元重建路径。
const gpuMeshRenderer = (() => {
  let canvas, gl, program, locations, failed = false, generation = 0;
  let cache = new WeakMap();
  let sceneRevision = 0;
  const pendingFrames = new Map();
  const meshEligibility = new WeakMap();
  const vertexSource = `
    attribute vec2 aPosition;
    attribute vec2 aDisplacement;
    attribute vec4 aColor;
    attribute vec3 aBarycentric;
    uniform vec2 uOrigin;
    uniform vec2 uOffset;
    uniform vec2 uSize;
    uniform float uScale;
    uniform float uDeformation;
    uniform float uPointSize;
    uniform mediump float uSegments;
    uniform mediump float uLineWidth;
    varying vec4 vColor;
    varying vec3 vBarycentric;
    void main() {
      vec2 world = aPosition + aDisplacement * uDeformation;
      vec2 screen = uOffset + (world + uOrigin) * vec2(uScale, -uScale);
      if (uSegments > 0.5) {
        vec2 direction = aDisplacement * vec2(uScale, -uScale);
        vec2 normal = vec2(-direction.y, direction.x) / max(length(direction), 0.000001);
        screen += normal * aBarycentric.x * uLineWidth * 0.5;
      }
      gl_Position = vec4(screen / uSize * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
      gl_PointSize = uPointSize;
      vColor = aColor;
      vBarycentric = aBarycentric;
    }`;
  const fragmentSource = `
    #extension GL_OES_standard_derivatives : enable
    precision mediump float;
    varying vec4 vColor;
    varying vec3 vBarycentric;
    uniform vec4 uStroke;
    uniform mediump float uLineWidth;
    uniform float uDashed;
    uniform float uPoints;
    uniform mediump float uSegments;
    void main() {
      float coverage = 1.0;
      vec4 color = vec4(vColor.rgb * vColor.a, vColor.a);
      if (uSegments > 0.5) {
        // Segments are screen-width quads, avoiding platform-dependent GL line widths.
      } else if (uPoints > 0.5) {
        float radius = length(gl_PointCoord - vec2(0.5));
        coverage = 1.0 - smoothstep(0.42, 0.5, radius);
      } else {
        vec3 pixels = vBarycentric / max(fwidth(vBarycentric), vec3(0.00001));
        float edge = min(min(pixels.x, pixels.y), pixels.z);
        float line = 1.0 - smoothstep(max(uLineWidth * 0.5 - 0.5, 0.0), uLineWidth * 0.5 + 0.5, edge);
        if (uDashed > 0.5) line *= step(mod(gl_FragCoord.x + gl_FragCoord.y, 13.0), 7.0);
        float alpha = uStroke.a * line;
        color = vec4(uStroke.rgb * alpha, alpha) + color * (1.0 - alpha);
      }
      gl_FragColor = color * coverage;
    }`;

  function initialize() {
    if (failed) return false;
    if (gl) return !gl.isContextLost();
    try {
      canvas = document.createElement("canvas");
      gl = canvas.getContext("webgl", { alpha: true, antialias: true, depth: false,
        stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
        powerPreference: "high-performance", failIfMajorPerformanceCaveat: true });
      if (!gl || !gl.getExtension("OES_standard_derivatives")) throw new Error("WebGL unavailable");
      canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        cache = new WeakMap();
        refreshVisibleViewport();
      });
      canvas.addEventListener("webglcontextrestored", () => {
        gl = null; failed = false; generation++;
        refreshVisibleViewport();
      });
      const shaders = [];
      try {
        program = gl.createProgram();
        for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
          const shader = gl.createShader(type);
          shaders.push(shader);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
          gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      } finally {
        for (const shader of shaders) gl.deleteShader(shader);
      }
      locations = {};
      for (const name of ["aPosition", "aDisplacement", "aColor", "aBarycentric"]) locations[name] = gl.getAttribLocation(program, name);
      for (const name of ["uOrigin", "uOffset", "uSize", "uScale", "uDeformation", "uPointSize", "uStroke", "uLineWidth", "uDashed", "uPoints", "uSegments"]) locations[name] = gl.getUniformLocation(program, name);
      return true;
    } catch (error) {
      if (gl && program) gl.deleteProgram(program);
      gl = null; failed = true;
      return false;
    }
  }

  function refreshVisibleViewport() {
    if (typeof currentPageKey !== "function") return;
    const page = currentPageKey();
    requestFrame("gpu-recovery", () => {
      if (["results", "blast-results"].includes(page)) renderResultView();
      else if (page === "calculation") renderCalculationView();
      else render();
    });
  }

  function requestFrame(key, draw) {
    if (pendingFrames.has(key)) return;
    pendingFrames.set(key, requestAnimationFrame(() => { pendingFrames.delete(key); draw(); }));
  }

  function draw(context, view, dpr, owner, key, revision, build, options = {}) {
    if (!initialize()) { context.canvas.dataset.renderBackend = "canvas2d"; return false; }
    try {
      let entry = cache.get(owner);
      if (!entry || (!options.dynamic && entry.revision !== revision) || entry.generation !== generation) {
        if (entry) for (const packet of entry.packets.values()) gl.deleteBuffer(packet.buffer);
        entry = { revision, generation, packets: new Map() };
        cache.set(owner, entry);
      }
      let packet = entry.packets.get(key);
      if (!packet || (options.dynamic && packet.revision !== revision)) {
        const built = build(packet?.vertices);
        const reuse=packet && packet.vertices?.length===built.vertices.length;
        packet = { buffer: packet?.buffer || gl.createBuffer(), count: built.count ?? built.vertices.length / 11, origin: built.origin || { x: 0, y: 0 },revision,
          vertices:options.dynamic ? built.vertices : undefined };
        gl.bindBuffer(gl.ARRAY_BUFFER, packet.buffer);
        if(reuse)gl.bufferSubData(gl.ARRAY_BUFFER,0,built.vertices);
        else gl.bufferData(gl.ARRAY_BUFFER, built.vertices, options.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
        entry.packets.set(key, packet);
        // 限制每份结果的常驻云图数量；切换很多分量时不会无限积累显存。
        if (entry.packets.size > 6) {
          const oldest = entry.packets.keys().next().value;
          gl.deleteBuffer(entry.packets.get(oldest).buffer);
          entry.packets.delete(oldest);
        }
      } else {
        entry.packets.delete(key);
        entry.packets.set(key, packet);
      }
      const width = Math.max(1, Math.round(view.width * dpr));
      const height = Math.max(1, Math.round(view.height * dpr));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, packet.buffer);
      for (const [name, size, offset] of [["aPosition", 2, 0], ["aDisplacement", 2, 2], ["aColor", 4, 4], ["aBarycentric", 3, 8]]) {
        gl.enableVertexAttribArray(locations[name]);
        gl.vertexAttribPointer(locations[name], size, gl.FLOAT, false, 44, offset * 4);
      }
      // 原点平移先在 JS 双精度中完成，避免大坐标在 GPU float 中损失精度。
      gl.uniform2f(locations.uOrigin, 0, 0);
      gl.uniform2f(locations.uOffset, view.offsetX + packet.origin.x * view.scale, view.offsetY - packet.origin.y * view.scale);
      gl.uniform2f(locations.uSize, view.width, view.height);
      gl.uniform1f(locations.uScale, view.scale);
      gl.uniform1f(locations.uDeformation, options.factor || 0);
      gl.uniform1f(locations.uPointSize, (options.pointSize || 6) * dpr);
      gl.uniform4fv(locations.uStroke, options.stroke || [0, 0, 0, 0]);
      gl.uniform1f(locations.uLineWidth, (options.lineWidth || 1) * (options.segments ? 1 : dpr));
      gl.uniform1f(locations.uDashed, options.dashed ? 1 : 0);
      gl.uniform1f(locations.uPoints, options.points ? 1 : 0);
      gl.uniform1f(locations.uSegments, options.segments ? 1 : 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(options.points ? gl.POINTS : gl.TRIANGLES, 0, packet.count);
      if (gl.isContextLost()) return false;
      context.drawImage(canvas, 0, 0, view.width, view.height);
      context.canvas.dataset.renderBackend = "webgl";
      return true;
    } catch (error) {
      failed = true;
      context.canvas.dataset.renderBackend = "canvas2d";
      return false;
    }
  }

  function supportsSceneMesh(mesh) {
    let record = meshEligibility.get(mesh);
    if (!record || record.revision !== sceneRevision || record.elements !== mesh.elements) {
      record = { revision: sceneRevision, elements: mesh.elements,
        supported: mesh.elements.every((element) => elementNodeRefs(element).length === 3) };
      meshEligibility.set(mesh, record);
    }
    return record.supported;
  }
  function release(owner) {
    const entry=cache.get(owner);if(!entry)return;
    if(gl && entry.generation===generation)for(const packet of entry.packets.values())gl.deleteBuffer(packet.buffer);
    cache.delete(owner);
  }
  return { draw, release, requestFrame, supportsSceneMesh, invalidateScene: () => { sceneRevision++; }, get sceneRevision() { return sceneRevision; } };
})();

function gpuColor(color, alpha = 1) {
  const value = String(color).replace("#", "");
  return [parseInt(value.slice(0, 2), 16) / 255, parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255, alpha];
}

let gpuRampCache;
function gpuScalarColor(value,range,alpha=1) {
  gpuRampCache ||= RESULT_RAMP_COLORS.map(color=>gpuColor(color));
  const min=Number(range?.min)||0,max=Number(range?.max)||0;
  const t=max>min ? Math.max(0,Math.min(1,((Number(value)||0)-min)/(max-min))) : .5;
  const scaled=t*(gpuRampCache.length-1),i=Math.floor(scaled),a=gpuRampCache[i],b=gpuRampCache[Math.min(i+1,gpuRampCache.length-1)],f=scaled-i;
  return [Math.round((a[0]+(b[0]-a[0])*f)*255)/255,Math.round((a[1]+(b[1]-a[1])*f)*255)/255,Math.round((a[2]+(b[2]-a[2])*f)*255)/255,alpha];
}

function buildGpuTriangles(elements, nodesForElement, colorForElement, reuse) {
  const first = elements.length ? nodesForElement(elements[0])[0] : null;
  const origin = { x: first?.x || 0, y: first?.y || 0 };
  const vertices = gpuVertexStorage(elements.length*33,reuse);
  let cursor = 0;
  for (const element of elements) {
    const nodes = nodesForElement(element);
    if (nodes.length !== 3) continue;
    const color = colorForElement(element);
    for(let index=0;index<3;index++) {
      const node=nodes[index];
      vertices[cursor]=node.x-origin.x;vertices[cursor+1]=node.y-origin.y;
      vertices[cursor+2]=Number(node.ux)||0;vertices[cursor+3]=Number(node.uy)||0;
      for(let c=0;c<4;c++)vertices[cursor+4+c]=color[c];
      vertices[cursor+8]=index===0 ? 1 : 0;vertices[cursor+9]=index===1 ? 1 : 0;vertices[cursor+10]=index===2 ? 1 : 0;
      cursor += 11;
    }
  }
  return { origin, vertices, count:cursor/11 };
}

// Keep capacity when the number of visible damage cells/front edges changes.
// count, rather than array length, controls drawing after the set shrinks.
function gpuVertexStorage(required,reuse) {
  if(reuse && reuse.length>=required)return reuse;
  return new Float32Array(Math.max(required,reuse ? Math.ceil(reuse.length*1.5/66)*66 : 0));
}

function buildGpuSegments(edges,nodeByNo,color,reuse) {
  const first=edges.length ? nodeByNo.get(edges[0].a) : null;
  const origin={x:first?.x || 0,y:first?.y || 0};
  const vertices=gpuVertexStorage(edges.length*66,reuse);
  let cursor=0;
  for(const edge of edges) {
    const a=nodeByNo.get(edge.a),b=nodeByNo.get(edge.b);if(!a || !b)continue;
    const dx=b.x-a.x,dy=b.y-a.y;if(dx===0 && dy===0)continue;
    // Two triangles form a constant CSS-pixel-width line at every camera scale.
    for(let i=0;i<6;i++) {
      const n=(i===2 || i===3 || i===5) ? b : a;
      vertices[cursor]=n.x-origin.x;vertices[cursor+1]=n.y-origin.y;
      vertices[cursor+2]=dx;vertices[cursor+3]=dy;
      for(let c=0;c<4;c++)vertices[cursor+4+c]=color[c];
      vertices[cursor+8]=(i===1 || i===4 || i===5) ? 1 : -1;
      vertices[cursor+9]=vertices[cursor+10]=0;cursor+=11;
    }
  }
  return {origin,vertices,count:cursor/11};
}

function drawGpuSceneMesh(context, viewport, dpr, options = {}) {
  const elements = scene.mesh?.elements;
  if (!elements?.length || !scene.analysisNodes?.length || !gpuMeshRenderer.supportsSceneMesh(scene.mesh)) return false;
  return gpuMeshRenderer.draw(context, viewport, dpr, scene.mesh, "mesh", gpuMeshRenderer.sceneRevision,
    () => buildGpuTriangles(elements, (element) => elementNodeRefs(element).map(analysisNodeByRef).filter(Boolean), () => [0, 0, 0, 0]), options);
}

function drawGpuAnalysisNodes() {
  return gpuMeshRenderer.draw(calculationCtx, calculationView, calculationDpr, scene.analysisNodes, "nodes", gpuMeshRenderer.sceneRevision, () => {
    const origin = { x: scene.analysisNodes[0]?.x || 0, y: scene.analysisNodes[0]?.y || 0 };
    const vertices = new Float32Array(scene.analysisNodes.length * 11);
    scene.analysisNodes.forEach((node, index) => {
      const color = gpuColor(normalizeMechanicalState(node.mechanicalState) === "static" ? COLORS.static : COLORS.selected);
      vertices.set([node.x - origin.x, node.y - origin.y, 0, 0, ...color, 0, 0, 0], index * 11);
    });
    return { origin, vertices };
  }, { points: true, pointSize: 6 });
}

function drawGpuResultMesh(key, colorForElement, options = {}, projector = resultWorldToScreen) {
  // 两种投影都是线性变换，只需三个点就能提取 view uniform。
  const origin = projector({ x: 0, y: 0 });
  const axis = projector({ x: 1, y: 0 });
  const viewport = { width: resultView.width, height: resultView.height,
    offsetX: origin.x, offsetY: origin.y, scale: axis.x - origin.x };
  const data=calculationResultData;
  return gpuMeshRenderer.draw(resultCtx, viewport, resultDpr, data.gpuOwner || data, key, data.frameRevision || 0,
    reuse => options.segments ? buildGpuSegments(options.edges,data.nodeByNo,options.color,reuse) :
      buildGpuTriangles(options.elements || data.elements, (element) => element.nodes, colorForElement,reuse), {...options,dynamic:!!data.gpuOwner});
}
