// ============================================================
// 上下文预算 / 触发判定（方案 010）
// 目的：把“窗口 → 可用输入 → 高压线/低压线”收成纯函数，
// 供 agent 与设置页共用，避免两处各写一套阈值。
// ============================================================
import { estimateTokensV2 } from "./llm.js";

const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_OUTPUT_RESERVE = 8192;
const MIN_CONTEXT_WINDOW = 4096;
const MAX_CONTEXT_WINDOW = 1024 * 1024 * 2;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function clampContextWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(clamp(n, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW));
}

// 模型窗口优先；全局设置只兜底；未知模型用保守 32768，不默认 131072。
// windowMode：shared=输入输出共享总窗口；separate=输入上限/输出上限分开。
export function resolveContextWindow({ model = null, globalWindow = 0 } = {}) {
  const mode = model && model.windowMode === "separate" ? "separate" : "shared";
  const mw = clampContextWindow(model && model.contextWindow);
  const mi = clampContextWindow(model && model.maxInputTokens);
  if (mw || mi) {
    const source = model && model.windowSource === "detected" ? "detected" : "model";
    // separate 且没有总窗口时，window=0 表示“总窗口未知”，预算只按 maxInputTokens 算；
    // shared 只有输入上限时，把它当总窗口（保守）。
    const window = mw || (mode === "shared" ? mi : 0);
    return { window, maxInputTokens: mi, windowMode: mode, source };
  }
  const gw = clampContextWindow(globalWindow);
  if (gw) return { window: gw, maxInputTokens: 0, windowMode: "shared", source: "global" };
  return { window: DEFAULT_CONTEXT_WINDOW, maxInputTokens: 0, windowMode: "shared", source: "default" };
}

// 统一预算：
// - shared：U = W - O - S（输入与输出共享总窗口）
// - separate：U = Win - S（输入上限独立；输出只受 maxOutput 约束，不占输入预算）
export function computeContextBudget({
  window: win = DEFAULT_CONTEXT_WINDOW,
  inputWindow = 0,
  windowMode = "shared",
  outputReserve = DEFAULT_OUTPUT_RESERVE,
  safety = 0,
  highWater = 0.85,
  lowWater = 0.55,
  retainRatio = 0.25,
} = {}) {
  const rawW = clampContextWindow(win);
  const W = rawW || DEFAULT_CONTEXT_WINDOW;
  const mode = windowMode === "separate" ? "separate" : "shared";
  const O = Math.round(clamp(Number(outputReserve) || DEFAULT_OUTPUT_RESERVE, 256, Math.max(512, Math.floor(W * 0.4))));
  let inputLimit;
  if (mode === "separate") {
    inputLimit = clampContextWindow(inputWindow) || W;
    // 如果同时给了总窗口，输入仍不能超过“总窗口 - 输出预留”
    if (rawW > 0 && rawW > O) inputLimit = Math.min(inputLimit, Math.max(1024, rawW - O));
  } else {
    inputLimit = Math.max(1024, W - O);
  }
  const defaultSafety = Math.max(2048, Math.floor(inputLimit * 0.05));
  const S = Math.round(clamp(Number(safety) || defaultSafety, 512, Math.max(512, Math.floor(inputLimit * 0.25))));
  const U = Math.max(1024, inputLimit - S);
  const hi = clamp(Number(highWater) || 0.85, 0.5, 0.95);
  const lo = clamp(Number(lowWater) || 0.55, 0.2, hi - 0.05);
  const rr = clamp(Number(retainRatio) || 0.25, 0.1, 0.6);
  const H = Math.floor(U * hi);
  const L = Math.floor(U * lo);
  const R = Math.min(Math.max(2048, Math.floor(U * rr)), Math.max(512, L - 512));
  return {
    window: rawW || inputLimit,
    windowMode: mode,
    inputLimit,
    outputReserve: O,
    safety: S,
    usable: U,
    highWater: hi,
    lowWater: lo,
    retainRatio: rr,
    high: H,
    low: L,
    retain: R,
  };
}

// 估算前的清洗：去掉只服务 UI/审计的本地元数据，避免把 _seq/_sys 也算进上下文。
function estimateMessage(m) {
  if (!m || typeof m !== "object") return "";
  const clean = {};
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith("_")) continue;
    clean[k] = v;
  }
  return JSON.stringify(clean);
}

export function estimateRequestTokens({ messages = [], toolDefs = [], bias = 1 } = {}) {
  let total = 0;
  for (const m of messages) total += estimateTokensV2(estimateMessage(m)) + 4;
  if (Array.isArray(toolDefs) && toolDefs.length) {
    total += estimateTokensV2(JSON.stringify(toolDefs.map((t) => ({ type: "function", function: t }))));
  }
  const b = clamp(Number(bias) || 1, 0.8, 1.25);
  return Math.ceil(total * b);
}

// 用 provider 实际 usage 校准估算；缓存命中不影响“总 prompt token”口径。
export function updateEstimateBias(prevBias, actualTotal, estimated) {
  const prev = clamp(Number(prevBias) || 1, 0.8, 1.25);
  const a = Number(actualTotal) || 0;
  const e = Number(estimated) || 0;
  if (a <= 0 || e <= 0) return prev;
  const ratio = clamp(a / e, 0.8, 1.25);
  return Number((prev * 0.7 + ratio * 0.3).toFixed(3));
}

export function contextPercent(projected, budget) {
  const u = Math.max(1, Number(budget && budget.usable) || 1);
  return Math.round((Math.max(0, Number(projected) || 0) / u) * 100);
}

// 摘要请求自身也必须留出输出与安全余量。
export function summaryInputBudget(budget, summaryMaxTokens = 8192) {
  const u = Math.max(1024, Number(budget && budget.usable) || 1024);
  return Math.max(2048, u - Math.max(1024, Number(summaryMaxTokens) || 8192));
}

// 预判：只返回“是否需要压/是否连压缩都放不下”，真正的 prune/摘要由 agent 执行。
export function decideContextAction({ projected = 0, budget } = {}) {
  const b = budget || computeContextBudget();
  const p = Number(projected) || 0;
  if (p <= b.high) return { action: "none", level: "ok" };
  if (p <= b.usable) return { action: "compact", level: "high" };
  return { action: "compact", level: "overflow" };
}

// 滞回：刚压缩过且没有明显新增时，不因估算抖动再次压缩；超过硬上限必须压。
export function shouldCompactNow({
  projected = 0, budget, round = 0, lastRound = -1,
  lastProjected = 0, minGrowth = 2048, cooldownRounds = 2,
} = {}) {
  const b = budget || computeContextBudget();
  const p = Number(projected) || 0;
  if (p <= b.high) return false;
  if (p > b.usable) return true;
  if (lastRound >= 0 && round - lastRound < Math.max(1, cooldownRounds) && (p - Number(lastProjected || 0)) < Math.max(0, minGrowth)) return false;
  return true;
}
