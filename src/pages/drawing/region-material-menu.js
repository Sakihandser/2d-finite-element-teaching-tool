// 打开区域材料菜单，先根据区域 ID 刷新菜单内容，再把菜单定位到鼠标附近。
function showRegionMaterialMenu(regionId, clientX, clientY) {
  const region = regionById(regionId);
  if (!region || !regionMaterialMenu) return;
  activeRegionMenuId = regionId;
  renderRegionMaterialMenu(region);
  regionMaterialMenu.hidden = false;
  positionRegionMaterialMenu(clientX, clientY);
}

// 关闭区域材料菜单并清除当前菜单关联的区域。
function hideRegionMaterialMenu() {
  activeRegionMenuId = null;
  if (regionMaterialMenu) {
    regionMaterialMenu.hidden = true;
  }
}

// 菜单定位算法：把鼠标位置限制在浏览器可见范围内，避免右键菜单超出屏幕。
function positionRegionMaterialMenu(clientX, clientY) {
  if (!regionMaterialMenu) return;
  const margin = 8;
  const rect = regionMaterialMenu.getBoundingClientRect();
  const left = clamp(clientX, margin, Math.max(margin, window.innerWidth - rect.width - margin));
  const top = clamp(clientY, margin, Math.max(margin, window.innerHeight - rect.height - margin));
  regionMaterialMenu.style.left = `${left}px`;
  regionMaterialMenu.style.top = `${top}px`;
}

// 渲染区域材料菜单：第一项切换结构/空气，后续项用于清除或选择材料。
function renderRegionMaterialMenu(region) {
  if (!regionMaterialMenuList) return;
  const air = isAirRegion(region);
  const material = materialSnapshotForRegion(region);
  regionMaterialMenuRegion.textContent = air
    ? `${region.id}：外部空气`
    : material?.name
      ? `${region.id}：${uiText(material.name)}`
      : `${region.id}：未填充材料`;
  regionMaterialMenuList.replaceChildren();
  regionMaterialMenuList.appendChild(createRegionKindMenuItem(region, air));
  regionMaterialMenuList.appendChild(createRegionMaterialMenuItem(null, "清除填充", !material && !air));
  if (!materialLibrary.length) {
    const empty = document.createElement("div");
    empty.className = "context-menu-empty";
    empty.textContent = "材料库暂无材料。";
    regionMaterialMenuList.appendChild(empty);
    return;
  }
  for (const item of materialLibrary) {
    regionMaterialMenuList.appendChild(createRegionMaterialMenuItem(item, uiText(item.name), material?.id === item.id));
  }
}

// 创建“结构区域/外部空气”切换菜单项；空气区域会从材料和结构分类中排除。
function createRegionKindMenuItem(region, air) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `context-menu-item${air ? " active" : ""}`;
  button.setAttribute("role", "menuitem");
  const chip = document.createElement("span");
  chip.className = "material-menu-chip";
  chip.style.background = air ? "#f8fafc" : hexToRgba(region.fillColor || regionDefaultColor(region.id), 0.32);
  const text = document.createElement("span");
  text.textContent = air ? "改为结构区域" : "设为外部空气";
  button.append(chip, text);
  button.addEventListener("click", () => {
    setRegionKind(activeRegionMenuId, air ? REGION_KIND_STRUCTURE : REGION_KIND_AIR);
  });
  return button;
}

// 创建材料选择项；material 为 null 时表示清除当前区域填充。
function createRegionMaterialMenuItem(material, label, active = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `context-menu-item${active ? " active" : ""}${material ? "" : " danger"}`;
  button.setAttribute("role", "menuitem");
  const chip = document.createElement("span");
  chip.className = "material-menu-chip";
  if (material) {
    chip.style.background = normalizeColor(material.color);
  } else {
    chip.style.background = "linear-gradient(135deg, transparent 44%, #9c2f26 45% 55%, transparent 56%)";
  }
  const text = document.createElement("span");
  text.textContent = label;
  button.append(chip, text);
  button.addEventListener("click", () => {
    assignMaterialToRegion(activeRegionMenuId, material?.id || null);
  });
  return button;
}

// 给区域分配材料，并同步刷新计算节点/单元的区域材料分类。
function assignMaterialToRegion(regionId, materialId) {
  const region = regionById(regionId);
  if (!region) return;
  const material = materialId ? materialById(materialId) : null;
  if (materialId && !material) {
    window.alert("材料库中没有找到该材料。");
    return;
  }
  if (material) {
    setRegionKindData(region, REGION_KIND_STRUCTURE);
  }
  setRegionMaterialData(region, material);
  selectObject("region", region.id);
  for (const node of scene.analysisNodes || []) {
    classifyAnalysisNode(node);
  }
  classifyAnalysisElements();
  hideRegionMaterialMenu();
  updatePanel();
  render();
}

// 设置区域是结构还是空气，并同步更新后续分类结果。
function setRegionKind(regionId, kind) {
  const region = regionById(regionId);
  if (!region) return;
  setRegionKindData(region, kind);
  selectObject("region", region.id);
  for (const node of scene.analysisNodes || []) {
    classifyAnalysisNode(node);
  }
  classifyAnalysisElements();
  hideRegionMaterialMenu();
  updatePanel();
  render();
}
