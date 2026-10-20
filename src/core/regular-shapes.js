// 规则图形以质心为原点构造，再统一旋转和平移。尺寸单位与模型一致（m）。
function buildRegularShape(parameters) {
  const { type, x, y, angle, width, height, radius } = parameters;
  if (!["rectangle", "triangle", "circle", "ellipse"].includes(type) ||
      ![x, y, angle].every(Number.isFinite)) throw new Error("请输入有效的几何参数。");
  const dimensions = type === "circle" ? [radius] : [width, height];
  if (!dimensions.every((value) => Number.isFinite(value) && value >= 0.000001)) {
    throw new Error("尺寸必须大于或等于 0.000001 m。");
  }
  const radians = (angle % 360) * Math.PI / 180;
  const transform = (point) => ({
    x: x + point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: y + point.x * Math.sin(radians) + point.y * Math.cos(radians),
  });
  let vertices;
  let boundaries;
  if (type === "rectangle" || type === "triangle") {
    vertices = type === "rectangle"
      ? [{ x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 },
         { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }]
      : [{ x: -width / 2, y: -height / 3 }, { x: width / 2, y: -height / 3 },
         { x: 0, y: 2 * height / 3 }];
    boundaries = vertices.map((_, index) => ({ type: "line", start: index,
      end: (index + 1) % vertices.length, controls: [] }));
  } else {
    const a = type === "circle" ? radius : width / 2;
    const b = type === "circle" ? radius : height / 2;
    vertices = [{ x: a, y: 0 }, { x: 0, y: b }, { x: -a, y: 0 }, { x: 0, y: -b }];
    boundaries = vertices.map((point, index) => {
      const next = vertices[(index + 1) % 4];
      // 椭圆采用有理二次曲线，权重 √(1/2)，精确表示四分之一椭圆。
      const control = type === "circle"
        ? { x: (point.x + next.x) * Math.SQRT1_2, y: (point.y + next.y) * Math.SQRT1_2 }
        : { x: point.x + next.x, y: point.y + next.y };
      return { type: type === "circle" ? "arc" : "ellipse", start: index,
        end: (index + 1) % 4, controls: [transform(control)] };
    });
  }
  return { vertices: vertices.map(transform), boundaries, centroid: { x, y } };
}

function rationalQuadraticPoint(start, control, end, t) {
  const u = 1 - t;
  const w = Math.SQRT1_2;
  const denominator = u * u + 2 * w * u * t + t * t;
  return {
    x: (u * u * start.x + 2 * w * u * t * control.x + t * t * end.x) / denominator,
    y: (u * u * start.y + 2 * w * u * t * control.y + t * t * end.y) / denominator,
  };
}

// 批量提交后只重建一次区域，预览期间不修改 scene。
function createRegularShape(parameters) {
  const geometry = buildRegularShape(parameters);
  const nodes = geometry.vertices.map((point) => createGeometryNode(point, { select: false, update: false }));
  const curves = geometry.boundaries.map((boundary) => {
    const curve = { id: nextId("curve"), type: boundary.type, mechanicalState: "free",
      construction: typeof constructionMode !== "undefined" && constructionMode,
      geometryNodeIds: [nodes[boundary.start].id, nodes[boundary.end].id],
      controls: boundary.controls.map((point) => ({ x: roundCoord(point.x), y: roundCoord(point.y) })) };
    scene.curves.push(curve);
    return curve;
  });
  rebuildDerivedRegions();
  const region = getStructureRegionAtPoint(geometry.centroid);
  selectObject(region ? "region" : "curve", region?.id || curves[0].id);
  updatePanel();
  render();
  return curves;
}
