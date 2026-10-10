// 鼠标滚轮缩放，缩放中心固定在鼠标所在世界坐标。
function onWheel(event) {
  event.preventDefault();
  hideRegionMaterialMenu();
  const screen = pointerPoint(event);
  const before = screenToWorld(screen);
  const factor = Math.exp(-event.deltaY * 0.0012);
  view.scale = clamp(view.scale * factor, 8, 500);
  view.offsetX = screen.x - before.x * view.scale;
  view.offsetY = screen.y + before.y * view.scale;
  updatePanel(false);
  render();
}

// 开关动画预览层；后续接入真实位移后仍可复用这一帧循环。
function toggleAnimation() {
  animation.running = !animation.running;
  animationIcon.innerHTML = `<use href="${animation.running ? "#icon-pause" : "#icon-play"}"></use>`;
  if (animation.running) {
    animation.frame = requestAnimationFrame(render);
  } else {
    cancelAnimationFrame(animation.frame);
    render();
  }
}
