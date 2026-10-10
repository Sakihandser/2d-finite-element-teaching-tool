// 将视图缩放/平移到包住当前模型；空场景时回到默认坐标系。
function fitViewToScene() {
  const points = [];
  for (const node of scene.geometryNodes) points.push(node);
  for (const node of scene.analysisNodes) points.push(node);
  for (const curve of scene.curves) {
    points.push(...curve.controls);
    points.push(...sampleCurve(curve, 20));
  }
  for (const region of scene.regions || []) {
    points.push(...(region.polygon || []));
  }
  for (const load of scene.pointLoads) points.push(loadAnchor(load));
  for (const load of scene.bodyLoads || []) points.push(...bodyForceDisplayAnchors(load));
  if (!points.length) {
    view.scale = 48;
    view.offsetX = view.width / 2;
    view.offsetY = view.height / 2;
    updatePanel(false);
    render();
    return;
  }
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const padding = 80;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  view.scale = clamp(Math.min((view.width - padding * 2) / width, (view.height - padding * 2) / height), 16, 220);
  const center = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
  view.offsetX = view.width / 2 - center.x * view.scale;
  view.offsetY = view.height / 2 + center.y * view.scale;
  updatePanel(false);
  render();
}
