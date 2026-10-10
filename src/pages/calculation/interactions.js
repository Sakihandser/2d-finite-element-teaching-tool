// 计算页滚轮缩放，缩放中心固定在鼠标所在世界坐标。
function onCalculationWheel(event) {
  event.preventDefault();
  const screen = calculationPointerPoint(event);
  const before = calculationScreenToWorld(screen);
  const factor = Math.exp(-event.deltaY * 0.0012);
  calculationView.scale = clamp(calculationView.scale * factor, 8, 500);
  calculationView.offsetX = screen.x - before.x * calculationView.scale;
  calculationView.offsetY = screen.y + before.y * calculationView.scale;
  updateCalculationPanel();
  renderCalculationView();
}

// 开始计算页平移，未来计算节点布置工具可在这里分支接入。
function startCalculationPan(screen) {
  calculationInteraction = {
    mode: "pan",
    lastScreen: screen,
  };
  calculationCanvas.classList.add("panning");
}

// 计算页鼠标按下；当前阶段只做视图平移，不创建计算对象。
function onCalculationPointerDown(event) {
  if (!calculationCanvas) return;
  calculationCanvas.setPointerCapture(event.pointerId);
  const screen = calculationPointerPoint(event);
  if (event.button === 0 || event.button === 1 || event.button === 2) {
    startCalculationPan(screen);
    event.preventDefault();
  }
}

// 计算页鼠标移动：更新坐标读数，并在平移时移动独立视窗。
function onCalculationPointerMove(event) {
  const screen = calculationPointerPoint(event);
  const world = calculationScreenToWorld(screen);
  if (calculationCoordReadout) {
    calculationCoordReadout.textContent = `x ${formatNumber(world.x)}, y ${formatNumber(world.y)}`;
  }
  if (calculationInteraction?.mode !== "pan") return;
  const dx = screen.x - calculationInteraction.lastScreen.x;
  const dy = screen.y - calculationInteraction.lastScreen.y;
  calculationView.offsetX += dx;
  calculationView.offsetY += dy;
  calculationInteraction.lastScreen = screen;
  updateCalculationPanel();
  renderCalculationView();
}

// 计算页鼠标抬起，结束平移状态。
function onCalculationPointerUp() {
  if (calculationInteraction?.mode === "pan") {
    calculationCanvas.classList.remove("panning");
  }
  calculationInteraction = null;
}

// 计算页不弹出浏览器右键菜单，右键拖动会和绘图页一样用于平移。
function onCalculationContextMenu(event) {
  event.preventDefault();
}

// 开关计算页动画层；没有位移数据时仍保留按钮状态，后续结果进入后会直接播放。
function toggleCalculationAnimation() {
  calculationAnimation.running = !calculationAnimation.running;
  if (calculationAnimationIcon) {
    calculationAnimationIcon.innerHTML = `<use href="${calculationAnimation.running ? "#icon-pause" : "#icon-play"}"></use>`;
  }
  if (calculationAnimation.running) {
    renderCalculationView();
  } else {
    cancelCalculationAnimationFrame();
    renderCalculationView();
  }
}
