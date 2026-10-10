// 设置当前选中对象，并刷新右侧信息面板。
function selectObject(type, id, extra = null) {
  selected = { type, id, extra };
  updatePanel();
}

// 删除指定对象；删除几何节点/曲线时会同步清理依赖的曲线和载荷。
function deleteObject(type, id) {
  const targetType = type === "control" ? "curve" : type;
  let changed = false;
  if (targetType === "geometryNode") {
    // 几何节点被删除后，与它相连的曲线以及曲线上的分布力都不能继续存在。
    const curveIds = scene.curves.filter((curve) => curve.geometryNodeIds.includes(id)).map((curve) => curve.id);
    scene.distributedLoads = scene.distributedLoads.filter((load) => !curveIds.includes(load.curveId));
    scene.curves = scene.curves.filter((curve) => !curve.geometryNodeIds.includes(id));
    scene.pointLoads = scene.pointLoads.filter((load) => load.geometryNodeId !== id);
    scene.geometryNodes = scene.geometryNodes.filter((node) => node.id !== id);
    changed = true;
  }
  if (targetType === "curve") {
    // 曲线被删除后，其上的分布力同步删除。
    scene.distributedLoads = scene.distributedLoads.filter((load) => load.curveId !== id);
    scene.curves = scene.curves.filter((curve) => curve.id !== id);
    changed = true;
  }
  if (targetType === "region") {
    const region = regionById(id);
    if (region) {
      setRegionKindData(region, REGION_KIND_STRUCTURE);
      setRegionMaterialData(region, null);
      changed = true;
    }
  }
  if (targetType === "pointLoad") {
    scene.pointLoads = scene.pointLoads.filter((load) => load.id !== id);
    changed = true;
  }
  if (targetType === "distributedLoad") {
    scene.distributedLoads = scene.distributedLoads.filter((load) => load.id !== id);
    changed = true;
  }
  if (targetType === "bodyLoad") {
    scene.bodyLoads = (scene.bodyLoads || []).filter((load) => load.id !== id);
    changed = true;
  }
  if (changed) {
    selected = null;
    draft = null;
    hideRegionMaterialMenu();
    if (["geometryNode", "curve"].includes(targetType)) {
      rebuildDerivedRegions();
    } else if (targetType === "region") {
      for (const node of scene.analysisNodes || []) {
        classifyAnalysisNode(node);
      }
      classifyAnalysisElements();
    }
    updatePanel();
  }
  return changed;
}

// 删除当前选中对象，供 Delete/Backspace 快捷键复用。
function deleteSelected() {
  if (!selected) return;
  deleteObject(selected.type, selected.id);
  render();
}
