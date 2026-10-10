// 主渲染函数：每次状态变化后重绘整个 canvas。
function render(timestamp = 0) {
  if (timestamp) {
    animation.time = timestamp / 1000;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  // 绘制顺序从背景到前景：网格、结构区域、网格单元、几何、变形预览、载荷、草图、高亮。
  drawGrid();
  if (layers.regions) drawRegions();
  if (layers.mesh) drawMesh();
  if (layers.geometry) drawGeometry(false);
  if (animation.running && layers.geometry) drawGeometry(true);
  if (layers.loads) drawLoads();
  drawDraft();
  drawHover();
  if (currentPageKey() === "calculation") {
    renderCalculationView();
  }
  if (animation.running) {
    animation.frame = requestAnimationFrame(render);
  }
}

// 绘制背景网格、坐标轴、刻度文字和 x/y 轴箭头。
function drawGrid() {
  ctx.save();
  ctx.fillStyle = COLORS.canvasBackground;
  ctx.fillRect(0, 0, view.width, view.height);

  const step = gridStepForScale(view.scale);
  const startWorld = screenToWorld({ x: 0, y: view.height });
  const endWorld = screenToWorld({ x: view.width, y: 0 });
  const x0 = Math.floor(startWorld.x / step) * step;
  const x1 = Math.ceil(endWorld.x / step) * step;
  const y0 = Math.floor(startWorld.y / step) * step;
  const y1 = Math.ceil(endWorld.y / step) * step;

  // 只遍历当前可见范围内的网格线，避免无意义绘制。
  ctx.lineWidth = 1;
  ctx.font = "11px Segoe UI, Arial, sans-serif";
  ctx.fillStyle = "#6a7683";

  for (let x = x0; x <= x1; x += step) {
    const p = worldToScreen({ x, y: 0 });
    const major = isMajorGridLine(x, step);
    ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid;
    drawLineScreen({ x: p.x, y: 0 }, { x: p.x, y: view.height });
    if (major && Math.abs(x) > 1e-9 && p.x > 4 && p.x < view.width - 28) {
      ctx.fillText(formatNumber(x), p.x + 3, clamp(view.offsetY + 13, 16, view.height - 8));
    }
  }

  for (let y = y0; y <= y1; y += step) {
    const p = worldToScreen({ x: 0, y });
    const major = isMajorGridLine(y, step);
    ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid;
    drawLineScreen({ x: 0, y: p.y }, { x: view.width, y: p.y });
    if (major && Math.abs(y) > 1e-9 && p.y > 12 && p.y < view.height - 4) {
      ctx.fillText(formatNumber(y), clamp(view.offsetX + 6, 6, view.width - 40), p.y - 4);
    }
  }

  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1.5;
  const origin = worldToScreen({ x: 0, y: 0 });
  drawLineScreen({ x: 0, y: origin.y }, { x: view.width, y: origin.y });
  drawLineScreen({ x: origin.x, y: 0 }, { x: origin.x, y: view.height });
  drawArrowHeadScreen({ x: view.width - 15, y: origin.y }, { x: view.width - 3, y: origin.y }, COLORS.axis);
  drawArrowHeadScreen({ x: origin.x, y: 15 }, { x: origin.x, y: 3 }, COLORS.axis);
  ctx.fillStyle = COLORS.axis;
  ctx.font = "600 12px Segoe UI, Arial, sans-serif";
  ctx.fillText("x", view.width - 18, clamp(origin.y - 8, 14, view.height - 8));
  ctx.fillText("y", clamp(origin.x + 8, 8, view.width - 18), 18);
  ctx.restore();
}

// 判断当前网格线是否为主刻度线，每 5 条显示为加深线。
function isMajorGridLine(value, step) {
  return Math.abs(Math.round(value / step) % 5) === 0;
}

// 绘制网格层；网格单元只读取 analysisNodes，不读取几何建模点。
function drawMesh() {
  if (!scene.analysisNodes?.length || !scene.mesh?.elements?.length) return;
  ctx.save();
  ctx.strokeStyle = COLORS.mesh;
  ctx.globalAlpha = 0.42;
  ctx.lineWidth = 1;
  for (const element of scene.mesh.elements) {
    // 新网格推荐使用 analysisNodeIds；nodeIds 只用于兼容早期导入文件。
    const refs = Array.isArray(element) ? element : element.analysisNodeIds || element.nodeIds || [];
    const analysisNodes = refs.map((ref) => analysisNodeByRef(ref)).filter(Boolean);
    if (analysisNodes.length < 2) continue;
    ctx.beginPath();
    analysisNodes.forEach((node, index) => {
      const p = worldToScreen(node);
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}
