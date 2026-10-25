// archify seam（浏览器适配）：同名纯函数，输出带 message 的诊断（与官方一致）
export function recordDiagnostic() {}
export function withDiagnosticRecordingSuppressed(fn) { return typeof fn === "function" ? fn() : undefined; }
function fmt(list) {
  return (Array.isArray(list) ? list : []).map((d) => {
    if (d && typeof d === "object") return d.message || JSON.stringify(d);
    return String(d);
  });
}
export function throwDiagnosticError(header, list = []) { const a = fmt(list); if (a.length) throw new Error(header + "\n" + a.join("\n")); }
export function throwDiagnosticProblems(header, list = [], opts = {}) { const a = fmt(list); if (a.length) throw new Error(header + "\n" + a.join("\n") + (opts.code ? " [" + opts.code + "]" : "")); }
export function installRendererDiagnosticBoundary() {}
