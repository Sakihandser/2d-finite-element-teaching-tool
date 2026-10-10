// 数字格式化：普通工程数值保留三位小数，极大/极小值用科学计数法。
function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1000 || (Math.abs(n) < 0.001 && n !== 0)) return n.toExponential(2);
  return String(Math.round(n * 1000) / 1000);
}

// 限制数值范围，常用于缩放比例、插值参数和视图适配。
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
