// 可空材料数值字段读取。
function nullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? roundMaterialValue(number) : null;
}

// 材料库数值保留 1e-6，兼顾导出和显示。
function roundMaterialValue(value) {
  return Math.round(value * 1000000) / 1000000;
}

// 保证颜色字段是可用的十六进制颜色。
function normalizeColor(color) {
  const value = String(color || "").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : MATERIAL_SWATCHES[0];
}

// 材料数值显示，避免密度一类常用数值被转成科学计数法。
function formatMaterialNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("zh-CN", {
    maximumFractionDigits: 3,
  });
}
