const shapeDialog = document.getElementById("shapeDialog");
const shapeForm = document.getElementById("shapeForm");
let shapePreview = null;
let shapeDrag = null;

function readShapeParameters() {
  const values = { type: document.getElementById("shapeType").value };
  for (const key of ["width", "height", "radius", "x", "y", "angle"]) {
    const input = shapeForm.elements.namedItem(key);
    values[key] = input.value.trim() === "" ? NaN : Number(input.value);
  }
  return values;
}

function updateShapePreview() {
  const parameters = readShapeParameters();
  const circle = parameters.type === "circle";
  document.getElementById("shapeRadiusRow").hidden = !circle;
  document.getElementById("shapeWidthRow").hidden = circle;
  document.getElementById("shapeHeightRow").hidden = circle;
  document.getElementById("shapeWidthLabel").textContent = parameters.type === "triangle" ? "底边 (m)" : "宽度 / 横轴全长 (m)";
  document.getElementById("shapeHeightLabel").textContent = parameters.type === "triangle" ? "高度 (m)" : "高度 / 纵轴全长 (m)";
  const error = document.getElementById("shapeError");
  try {
    shapePreview = { parameters, geometry: buildRegularShape(parameters) };
    error.textContent = "";
  } catch (failure) {
    shapePreview = null;
    error.textContent = uiText(failure.message);
  }
  document.getElementById("createShape").disabled = !shapePreview;
  render();
}

function openShapeEditor(type = "rectangle") {
  setTool("select");
  hideRegionMaterialMenu();
  document.getElementById("shapeType").value = type;
  const center = screenToWorld({ x: view.width / 2, y: view.height / 2 });
  shapeForm.elements.namedItem("x").value = roundCoord(center.x);
  shapeForm.elements.namedItem("y").value = roundCoord(center.y);
  if (!shapeDialog.open) shapeDialog.show();
  updateShapePreview();
}

function closeShapeEditor() {
  endShapeDrag();
  shapePreview = null;
  shapeDrag = null;
  if (shapeDialog.open) shapeDialog.close();
  render();
}

function drawShapePreview() {
  if (!shapePreview || !shapeDialog.open) return;
  const { geometry } = shapePreview;
  ctx.save();
  ctx.strokeStyle = "#007c89";
  ctx.fillStyle = "rgba(0, 124, 137, 0.12)";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 4]);
  ctx.beginPath();
  for (const boundary of geometry.boundaries) {
    const start = geometry.vertices[boundary.start];
    const end = geometry.vertices[boundary.end];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const point = boundary.type === "line" ? lerpPoint(start, end, t)
        : boundary.type === "arc" ? arcPoint(start, boundary.controls[0], end, t)
        : rationalQuadraticPoint(start, boundary.controls[0], end, t);
      const screen = worldToScreen(point);
      if (boundary.start === 0 && i === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  const center = worldToScreen(geometry.centroid);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(center.x, center.y, 10, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(center.x - 15, center.y); ctx.lineTo(center.x + 15, center.y);
  ctx.moveTo(center.x, center.y - 15); ctx.lineTo(center.x, center.y + 15);
  ctx.stroke();
  ctx.fillStyle = "#007c89";
  ctx.font = "12px Segoe UI, Microsoft YaHei, sans-serif";
  ctx.fillText("拖动质心放置", center.x + 18, center.y - 14);
  ctx.restore();
}

function beginShapeDrag(event, screen) {
  if (!shapeDialog.open || event.button !== 0) return false;
  if (shapePreview && distance(screen, worldToScreen(shapePreview.geometry.centroid)) <= 18) {
    const point = screenToWorld(screen);
    shapeDrag = { pointerId: event.pointerId,
      offsetX: point.x - shapePreview.parameters.x, offsetY: point.y - shapePreview.parameters.y };
    canvas.classList.add("shape-dragging");
  }
  // 参数窗口打开期间，左键只操作预览，避免修改已有模型。
  return true;
}

function moveShapeDrag(event, screen) {
  if (!shapeDrag || shapeDrag.pointerId !== event.pointerId) return false;
  const raw = screenToWorld(screen);
  const point = snapWorld({ x: raw.x - shapeDrag.offsetX, y: raw.y - shapeDrag.offsetY });
  shapeForm.elements.namedItem("x").value = roundCoord(point.x);
  shapeForm.elements.namedItem("y").value = roundCoord(point.y);
  updateShapePreview();
  return true;
}

function endShapeDrag() {
  shapeDrag = null;
  canvas.classList.remove("shape-dragging");
}

function wireShapeEditor() {
  document.querySelectorAll("[data-shape]").forEach((button) => {
    button.addEventListener("click", () => openShapeEditor(button.dataset.shape));
  });
  shapeForm.addEventListener("input", updateShapePreview);
  shapeForm.addEventListener("change", updateShapePreview);
  shapeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    updateShapePreview();
    if (!shapePreview) return;
    createRegularShape(shapePreview.parameters);
    closeShapeEditor();
  });
  document.getElementById("cancelShape").addEventListener("click", closeShapeEditor);
  shapeDialog.addEventListener("close", () => {
    // close 事件异步派发；快速切换图形时不能清除已经重新打开的预览。
    if (!shapeDialog.open) { endShapeDrag(); shapePreview = null; render(); }
  });
}
