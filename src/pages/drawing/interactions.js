// 鼠标按下入口：根据当前工具决定创建、拖拽、平移、删除或开始绘制载荷。
function onPointerDown(event) {
  canvas.setPointerCapture(event.pointerId);
  const screen = pointerPoint(event);
  const world = snapWorld(screenToWorld(screen));
  if (beginShapeDrag(event, screen)) return;
  if (event.button === 0) {
    hideRegionMaterialMenu();
  }
  if (event.button === 2) {
    const region = !draft ? nearestRegion(screen) : null;
    if (region) {
      selectObject("region", region.id);
      showRegionMaterialMenu(region.id, event.clientX, event.clientY);
      event.preventDefault();
      render();
      return;
    }
    hideRegionMaterialMenu();
    startPan(screen);
    event.preventDefault();
    return;
  }
  if (event.button === 1) {
    startPan(screen);
    event.preventDefault();
    return;
  }

  if (activeTool === "select") {
    const hit = hitTest(screen, true);
    if (hit) {
      // 命中节点或控制点时进入拖动；命中其他对象时仅选择。
      selectObject(hit.type, hit.id, hit.extra);
      if (hit.type === "geometryNode") {
        interaction = { mode: "drag-geometry-node", id: hit.id, lastWorld: world };
      } else if (hit.type === "control") {
        interaction = { mode: "drag-control", curveId: hit.id, index: hit.extra.index, lastWorld: world };
      } else {
        interaction = { mode: "select" };
      }
    } else {
      selected = null;
      startPan(screen);
    }
    updatePanel();
    render();
    return;
  }

  if (activeTool === "eraser") {
    const hit = hitTest(screen, true);
    if (hit) {
      // 擦到控制点时删除整条曲线，因为控制点不是独立有限元对象。
      deleteObject(hit.type === "control" ? "curve" : hit.type, hit.id);
    }
    hovered = null;
    render();
    return;
  }

  if (activeTool === "node") {
    const snappedNode = snapToggle.checked ? nearestGeometryNode(screen) : null;
    if (snappedNode) {
      selectObject("geometryNode", snappedNode.id);
      updatePanel();
    } else {
      createGeometryNode(world);
    }
    render();
    return;
  }

  if (["line", "quadratic", "cubic", "arc"].includes(activeTool)) {
    handleCurveClick(activeTool, world, screen);
    render();
    return;
  }

  if (activeTool === "force") {
    const node = nearestGeometryNode(screen);
    if (node?.construction) return;
    const anchor = node ? { x: node.x, y: node.y } : world;
    if (loadDirectionMode === "input") {
      // 角度模式不需要拖拽，点击后直接按预设方向创建载荷。
      createPointLoad(anchor, presetLoadDirection(), node?.id || null);
      render();
      return;
    }
    draft = {
      kind: "force",
      anchor,
      geometryNodeId: node?.id || null,
      preview: world,
    };
    interaction = { mode: "draw-force" };
    render();
    return;
  }

  if (activeTool === "distributed") {
    const curve = nearestCurve(screen);
    if (curve && !curve.construction) {
      const mid = pointOnCurve(curve, 0.5);
      if (loadDirectionMode === "input") {
        // 分布力角度模式：点击曲线后直接生成整段线性分布力。
        createDistributedLoad(curve.id, presetLoadDirection());
        render();
        return;
      }
      draft = {
        kind: "distributed",
        curveId: curve.id,
        anchor: mid,
        preview: world,
      };
      interaction = { mode: "draw-distributed" };
      selectObject("curve", curve.id);
      render();
    }
  }

  if (activeTool === "body") {
    if (bodyForceScope === "global") {
      createBodyForceLoad(null);
      render();
      return;
    }
    const region = nearestRegion(screen);
    if (region && !isAirRegion(region)) {
      createBodyForceLoad(region.id);
      render();
    }
  }
}

// 原生右键菜单被替换为区域材料填充菜单。
function onCanvasContextMenu(event) {
  event.preventDefault();
  const region = !draft ? nearestRegion(pointerPoint(event)) : null;
  if (!region) {
    hideRegionMaterialMenu();
    return;
  }
  selectObject("region", region.id);
  showRegionMaterialMenu(region.id, event.clientX, event.clientY);
  render();
}

// 开始平移视图，记录上一次鼠标屏幕坐标。
function startPan(screen) {
  interaction = {
    mode: "pan",
    lastScreen: screen,
  };
  canvas.classList.add("panning");
}

// 鼠标移动入口：更新坐标读数，并处理平移、拖节点、拖控制点和草图预览。
function onPointerMove(event) {
  const screen = pointerPoint(event);
  const worldRaw = screenToWorld(screen);
  const world = snapWorld(worldRaw, { excludeGeometryNodeId: interaction?.mode === "drag-geometry-node" ? interaction.id : null });
  coordReadout.textContent = `x ${formatNumber(worldRaw.x)}, y ${formatNumber(worldRaw.y)}`;
  if (moveShapeDrag(event, screen)) return;

  if (interaction?.mode === "pan") {
    const dx = screen.x - interaction.lastScreen.x;
    const dy = screen.y - interaction.lastScreen.y;
    view.offsetX += dx;
    view.offsetY += dy;
    interaction.lastScreen = screen;
    updatePanel(false);
    render();
    return;
  }

  if (interaction?.mode === "drag-geometry-node") {
    const node = geometryNodeById(interaction.id);
    if (node) {
      node.x = roundCoord(world.x);
      node.y = roundCoord(world.y);
      rebuildDerivedRegions();
      updatePanel(false);
      render();
    }
    return;
  }

  if (interaction?.mode === "drag-control") {
    const curve = curveById(interaction.curveId);
    if (curve?.controls?.[interaction.index]) {
      curve.controls[interaction.index].x = roundCoord(world.x);
      curve.controls[interaction.index].y = roundCoord(world.y);
      rebuildDerivedRegions();
      updatePanel(false);
      render();
    }
    return;
  }

  if (interaction?.mode === "draw-force" && draft) {
    draft.preview = worldRaw;
    render();
    return;
  }

  if (interaction?.mode === "draw-distributed" && draft) {
    draft.preview = worldRaw;
    render();
    return;
  }

  if (draft?.kind === "curve") {
    draft.preview = world;
    render();
    return;
  }

  hovered = hitTest(screen, false);
  render();
}

// 鼠标抬起入口：提交拖拽式载荷，或结束平移/拖动状态。
function onPointerUp(event) {
  if (shapeDrag) { endShapeDrag(); return; }
  const screen = pointerPoint(event);
  const world = screenToWorld(screen);

  if (interaction?.mode === "draw-force" && draft) {
    createPointLoad(draft.anchor, { x: world.x - draft.anchor.x, y: world.y - draft.anchor.y }, draft.geometryNodeId);
    draft = null;
    interaction = null;
    render();
    return;
  }

  if (interaction?.mode === "draw-distributed" && draft) {
    createDistributedLoad(draft.curveId, { x: world.x - draft.anchor.x, y: world.y - draft.anchor.y });
    draft = null;
    interaction = null;
    render();
    return;
  }

  if (interaction?.mode === "pan") {
    canvas.classList.remove("panning");
  }
  if (["drag-geometry-node", "drag-control"].includes(interaction?.mode)) {
    if (scene.analysisNodes.length) {
      classifyAnalysisNodes();
    } else {
      updatePanel();
    }
  }
  interaction = null;
}

// 曲线工具的多点点击逻辑：端点复用附近节点，控制点直接保存为坐标。
function handleCurveClick(type, world, screen) {
  const requiredPoints = {
    line: 2,
    quadratic: 3,
    cubic: 4,
    arc: 3,
  }[type];

  if (!draft || draft.kind !== "curve" || draft.type !== type) {
    draft = {
      kind: "curve",
      type,
      points: [],
      geometryNodeIds: [],
      preview: world,
    };
  }

  const pointIndex = draft.points.length;
  // 只有曲线端点对应有限元几何节点，控制点只影响曲线形状。
  const shouldUseNode =
    type === "line" ||
    (type === "quadratic" && (pointIndex === 0 || pointIndex === 2)) ||
    (type === "cubic" && (pointIndex === 0 || pointIndex === 3)) ||
    (type === "arc" && (pointIndex === 0 || pointIndex === 2));

  if (shouldUseNode) {
    const node = nearestGeometryNode(screen) || createGeometryNode(world);
    draft.points.push({ x: node.x, y: node.y });
    draft.geometryNodeIds.push(node.id);
  } else {
    draft.points.push(world);
  }

  if (draft.points.length === requiredPoints) {
    if (type === "line") {
      createCurve("line", draft.geometryNodeIds);
    }
    if (type === "quadratic") {
      createCurve("quadratic", draft.geometryNodeIds, [draft.points[1]]);
    }
    if (type === "cubic") {
      createCurve("cubic", draft.geometryNodeIds, [draft.points[1], draft.points[2]]);
    }
    if (type === "arc") {
      createCurve("arc", draft.geometryNodeIds, [draft.points[1]]);
    }
    draft = null;
  }
}

// 查找鼠标附近最近的几何节点，用于选择、连接和几何载荷锚定。
function nearestGeometryNode(screen) {
  let best = null;
  let bestDistance = HIT_PX;
  for (const node of scene.geometryNodes) {
    const p = worldToScreen(node);
    const d = Math.hypot(p.x - screen.x, p.y - screen.y);
    if (d < bestDistance) {
      best = node;
      bestDistance = d;
    }
  }
  return best;
}

// 查找鼠标附近最近的曲线，用于选择和添加分布力。
function nearestCurve(screen) {
  let best = null;
  let bestDistance = HIT_PX;
  for (const curve of scene.curves) {
    const points = sampleCurve(curve, curve.type === "line" ? 1 : 64);
    for (let i = 1; i < points.length; i++) {
      const a = worldToScreen(points[i - 1]);
      const b = worldToScreen(points[i]);
      const d = distanceToSegment(screen, a, b);
      if (d < bestDistance) {
        best = curve;
        bestDistance = d;
      }
    }
  }
  return best;
}

// 查找鼠标附近最近的曲线控制点，用于选择工具拖动曲线形状。
function nearestControl(screen) {
  let best = null;
  let bestDistance = HIT_PX;
  for (const curve of scene.curves) {
    for (let i = 0; i < (curve.controls?.length || 0); i++) {
      const p = worldToScreen(curve.controls[i]);
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (d < bestDistance) {
        best = { type: "control", id: curve.id, extra: { index: i } };
        bestDistance = d;
      }
    }
  }
  return best;
}

// 综合命中测试：按控制点、节点、载荷、曲线的优先级拾取对象。
function hitTest(screen, includeControls) {
  if (includeControls) {
    const control = nearestControl(screen);
    if (control) return control;
  }
  const node = nearestGeometryNode(screen);
  if (node) return { type: "geometryNode", id: node.id };
  const pointLoad = nearestPointLoad(screen);
  if (pointLoad) return { type: "pointLoad", id: pointLoad.id };
  const distributedLoad = nearestDistributedLoad(screen);
  if (distributedLoad) return { type: "distributedLoad", id: distributedLoad.id };
  const bodyLoad = nearestBodyLoad(screen);
  if (bodyLoad) return { type: "bodyLoad", id: bodyLoad.id };
  const curve = nearestCurve(screen);
  if (curve) return { type: "curve", id: curve.id };
  const region = nearestRegion(screen);
  if (region) return { type: "region", id: region.id };
  return null;
}

// 查找鼠标所在的结构区域，区域优先级低于节点/边界/载荷。
function nearestRegion(screen) {
  if (!layers.regions) return null;
  const world = screenToWorld(screen);
  const tolerance = Math.max(2 / view.scale, DEFAULT_CLASSIFICATION_TOLERANCE);
  const region = getStructureRegionAtPoint(world, tolerance);
  return region ? regionById(region.id) : null;
}
