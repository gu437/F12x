// ============================================================
// F12x 稳定错误码体系（方案_v2 §4.3 / P0b）
// 对齐 DeepSeek Harness retry-policy 契约：稳定错误码 + 白名单重试 + 指数退避 + jitter + Retry-After
// 兼容存量数据：历史工具返回 {ok:false, error} 无 code 时按 INVALID_REQUEST 兜底
// ============================================================

export const F12X_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  RATE_LIMIT: "RATE_LIMIT",
  CONTEXT_WINDOW_EXCEEDED: "CONTEXT_WINDOW_EXCEEDED",
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  STREAM_CLOSED: "STREAM_CLOSED",
  TIMEOUT: "TIMEOUT",
  TRANSPORT: "TRANSPORT",
  SERVER: "SERVER",
  TOOL_REJECTED: "TOOL_REJECTED",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  TOOL_EXECUTION_ERROR: "TOOL_EXECUTION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  ABORTED: "ABORTED"
});

// 错误码 → 用户可读中文文案（UI 渲染映射用，sidepanel 引用）
export const F12X_ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: "请求无效（参数错误或格式不合法）",
  UNAUTHORIZED: "认证失败（API Key 无效或未配置）",
  RATE_LIMIT: "请求频率受限（429）",
  CONTEXT_WINDOW_EXCEEDED: "上下文长度超限",
  EMPTY_RESPONSE: "模型返回空响应",
  STREAM_CLOSED: "流式响应被截断",
  TIMEOUT: "请求超时",
  TRANSPORT: "网络传输错误",
  SERVER: "服务端错误（5xx）",
  TOOL_REJECTED: "操作被拒绝（未批准）",
  TOOL_TIMEOUT: "工具执行超时",
  TOOL_EXECUTION_ERROR: "工具执行失败",
  NOT_FOUND: "资源不存在",
  ABORTED: "已中止"
});

// 瞬时类错误码白名单（可自动重试）
const RETRIABLE = new Set([
  F12X_ERROR_CODES.RATE_LIMIT, F12X_ERROR_CODES.TIMEOUT,
  F12X_ERROR_CODES.TRANSPORT, F12X_ERROR_CODES.SERVER,
  F12X_ERROR_CODES.STREAM_CLOSED, F12X_ERROR_CODES.EMPTY_RESPONSE
]);
export function isRetriable(code) { return RETRIABLE.has(code); }

const KNOWN = new Set(Object.values(F12X_ERROR_CODES));

// 归一化任意抛出对象 → { ok:false, code, message, retriable, retryAfter? }
// 单入口：所有 throw / 工具失败统一走这里，保证错误码契约一致
export function normalizeError(e) {
  if (e == null) return { ok: false, code: F12X_ERROR_CODES.INVALID_REQUEST, message: "未知错误", retriable: false };
  // 存量对象形态（工具返回 {error} / {ok:false, error}）：补 code 兜底（存量数据兼容）
  if (typeof e === "object" && !(e instanceof Error)) {
    const code = KNOWN.has(e.code) ? e.code : F12X_ERROR_CODES.INVALID_REQUEST;
    return { ok: false, code, message: String(e.error || e.message || "未知错误"), retriable: isRetriable(code), retryAfter: e.retryAfter };
  }
  // 显式标记的稳定码（业务代码主动抛 {code, message}）
  if (KNOWN.has(e.code)) {
    return { ok: false, code: e.code, message: e.message || F12X_ERROR_MESSAGES[e.code], retriable: isRetriable(e.code), retryAfter: e.retryAfter };
  }
  if (e.contextOverflow) {
    return { ok: false, code: F12X_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED, message: e.message || "上下文长度超限", retriable: false };
  }
  const name = (e.name || "").toLowerCase();
  const msg = String(e.message || e.status || "");
  const m3 = msg.match(/\b(\d{3})\b/);
  const status = typeof e.status === "number" ? e.status : (m3 ? Number(m3[1]) : 0);
  let code = F12X_ERROR_CODES.INVALID_REQUEST, retriable = false, retryAfter = e.retryAfter || null;
  if (name.includes("abort")) code = F12X_ERROR_CODES.ABORTED;
  else if (name === "streamclosederror") { code = F12X_ERROR_CODES.STREAM_CLOSED; retriable = true; }
  else if (name === "timeouterror" || /超时|timeout/i.test(msg)) { code = F12X_ERROR_CODES.TIMEOUT; retriable = true; }
  else if (status === 401 || status === 403 || /invalid api key|unauthorized|认证失败/i.test(msg)) code = F12X_ERROR_CODES.UNAUTHORIZED;
  else if (status === 429 || /rate limit|overloaded|频率受限/i.test(msg)) { code = F12X_ERROR_CODES.RATE_LIMIT; retriable = true; }
  else if (status === 400 && /context|token|too (long|large)|length/i.test(msg)) code = F12X_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED;
  else if (status === 400) code = F12X_ERROR_CODES.INVALID_REQUEST;
  else if (status === 404 || /not found|不存在/i.test(msg)) code = F12X_ERROR_CODES.NOT_FOUND;
  else if (status >= 500) { code = F12X_ERROR_CODES.SERVER; retriable = true; }
  else if (/(network|fetch failed|econn|transport|截断)/i.test(msg)) { code = F12X_ERROR_CODES.TRANSPORT; retriable = true; }
  else if (/empty|空响应/i.test(msg)) { code = F12X_ERROR_CODES.EMPTY_RESPONSE; retriable = true; }
  return { ok: false, code, message: e.message || F12X_ERROR_MESSAGES[code], retriable, retryAfter };
}

// 工具结果规范化：存量 {ok:false, error} 无 code → INVALID_REQUEST 兜底；成功态 code 恒为 'OK'（§10 微小项1）
export function normalizeToolResult(r) {
  if (r == null) return { ok: false, code: F12X_ERROR_CODES.INVALID_REQUEST, error: "空结果" };
  if (typeof r !== "object") return r;
  const hasError = r.error !== undefined || r.ok === false;
  if (!hasError) return { ok: true, code: "OK", ...r }; // code 放前，r 自带 code 不覆盖 'OK'（成功态显式化）
  if (KNOWN.has(r.code)) return { ok: false, code: r.code, ...r };
  return { ok: false, code: F12X_ERROR_CODES.INVALID_REQUEST, ...r };
}

// ============================================================
// 工具结果语义判定（供守卫/对抗性审查/审计共用）：
// 与归一化结果契约一致（normalizeToolResult / F12X_ERROR_CODES），
// 杜绝"对整段文本跑正则"式误判（页面/响应正文含 error/timeout 文案不等于失败）。
// 输入可以是任意对象或 tool 消息文本（JSON）；非对象/非 JSON 一律视为"数据"，不判失败。
// ============================================================
export function parseToolResultContent(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { const o = JSON.parse(v); return (o && typeof o === "object") ? o : null; }
    catch (e) { return null; }
  }
  return null;
}
// 用户拒绝/超时批准 = 决策反馈，不是工具失败（agent 批准闸门回灌时带 approval:'rejected'）
export function isUserRejectionResult(v) {
  const o = parseToolResultContent(v);
  return !!(o && o.approval === "rejected");
}
// 结构化失败判定：ok:false | error 字段非空 | 稳定错误码；拒绝反馈排除
export function isToolResultFailure(v) {
  const o = parseToolResultContent(v);
  if (!o || typeof o !== "object") return false;
  if (o.approval === "rejected") return false; // 决策反馈不算失败
  if (o.ok === false) return true;
  if (typeof o.error === "string" && String(o.error).trim().length > 0) return true;
  if (o.code && KNOWN.has(o.code)) return true;
  return false;
}

// 指数退避 + jitter + Retry-After 优先（上限 30s）
export function retryDelayMs(attempt, retryAfter = null) {
  if (retryAfter != null && retryAfter > 0) return Math.min(retryAfter * 1000, 30000);
  const base = 800 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * base * 0.3);
  return Math.min(base + jitter, 30000);
}
