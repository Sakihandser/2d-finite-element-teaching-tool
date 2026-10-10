// 查找鼠标附近最近的点载荷箭头。
function nearestPointLoad(screen) {
  let best = null;
  let bestDistance = HIT_PX + 6;
  for (const load of scene.pointLoads) {
    const anchor = worldToScreen(loadAnchor(load));
    const unit = normalize({ x: load.fx, y: load.fy }, { x: 0, y: -1 });
    const screenDir = normalize({ x: unit.x, y: -unit.y });
    const length = clamp(Math.abs(Math.hypot(load.fx, load.fy)) * 4, 34, 84);
    const end = { x: anchor.x + screenDir.x * length, y: anchor.y + screenDir.y * length };
    const d = distanceToSegment(screen, anchor, end);
    if (d < bestDistance) {
      best = load;
      bestDistance = d;
    }
  }
  return best;
}

// 查找鼠标附近最近的分布力箭头。
function nearestDistributedLoad(screen) {
  let best = null;
  let bestDistance = HIT_PX + 8;
  for (const load of scene.distributedLoads) {
    const curve = curveById(load.curveId);
    if (!curve) continue;
    const direction = normalize(load.direction, { x: 0, y: -1 });
    const screenDir = normalize({ x: direction.x, y: -direction.y });
    for (let i = 0; i < 7; i++) {
      const curveT = lerp(load.start ?? 0, load.end ?? 1, i / 6);
      const point = worldToScreen(pointOnCurve(curve, curveT));
      const length = distributedLoadDisplayLengthAt(load, curveT);
      const end = { x: point.x + screenDir.x * length, y: point.y + screenDir.y * length };
      const d = distanceToSegment(screen, point, end);
      if (d < bestDistance) {
        best = load;
        bestDistance = d;
      }
    }
  }
  return best;
}

// 查找鼠标附近最近的体力箭头。
function nearestBodyLoad(screen) {
  let best = null;
  let bestDistance = HIT_PX + 8;
  for (const load of scene.bodyLoads || []) {
    const direction = normalize(load.direction, { x: 0, y: -1 });
    const screenDir = normalize({ x: direction.x, y: -direction.y });
    const length = clamp(bodyLoadMagnitude(load) * 5, 32, 74);
    for (const anchor of bodyForceDisplayAnchors(load)) {
      const start = worldToScreen(anchor);
      const end = { x: start.x + screenDir.x * length, y: start.y + screenDir.y * length };
      const d = distanceToSegment(screen, start, end);
      if (d < bestDistance) {
        best = load;
        bestDistance = d;
      }
    }
  }
  return best;
}

// 点到线段距离，用于曲线和箭头的屏幕命中测试。
function distanceToSegment(point, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSq = vx * vx + vy * vy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * vx + (point.y - a.y) * vy) / lengthSq, 0, 1);
  return Math.hypot(point.x - (a.x + vx * t), point.y - (a.y + vy * t));
}
