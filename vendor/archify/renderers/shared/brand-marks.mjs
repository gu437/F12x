// archify seam（浏览器适配）：原 brand-marks.mjs 依赖 node:crypto/dns/http/net 联网取品牌资源。
// F12x 轨迹不使用品牌图——导出同签名纯函数：无品牌时不改变几何/标注（renderState 内 hasBrand=false 路径）。
export function brandLabelFitWidth(state, width) { return width; }
export function brandMarkFor() { return null; }
export function brandMetadataFor() { return {}; }
export function brandTopRailProblem() { return null; }
export function renderBrandMark() { return ""; }
export function prepareDiagramBrandMarks() { return null; }
