// ==== 授权矩阵结果分类（方案 009 / P3） ====
// 只做差异提示，不自动判定漏洞。

export function classifyCell(cell, baseline) {
  if (!cell || cell.error) return "error";
  if (!baseline || baseline.error) return "unknown";
  if (cell.status !== baseline.status) {
    if (cell.status >= 200 && cell.status < 300 && baseline.status >= 400) return "exposure";
    return "status-diff";
  }
  if (cell.length !== baseline.length) return "length-diff";
  return "same";
}
