// ============================================================
// F12x agent 模块：LLM 决策循环 + 任务执行入口 + 任务控制（原 background.js 的
// runAgentLoop / executeTask / live steering / pauseTask / resumeTask）
//
// 分解说明（原 800 行单函数 → 主循环 + 5 个单一职责函数，逻辑与顺序逐行保留）：
//   runAgentLoop        主循环编排：暂停检查 → 裁剪 → 单轮调用 → 守卫 → 三分支路由 → 收尾
//   streamOneRound      单轮 LLM 流式调用（累积思考/回答/工具增量）
//   applyThinkingGuards 思考质量检查（空想/乱猜检测与渐进降级）
//   handleTextAnswer    情况1：纯文本 → 候选最终回答（审查回应/首轮侦察/未验证结论/
//                       任务未完成确认/最终审查 五道拦截）
//   handleToolCalls     情况2：工具调用（执行 + 计划制定/推进/重估 + 专家分析 + 对抗性审查）
//   handleEmptyOutput   情况3：空输出（截断降级/追问/卡住专家救援）
//   fallbackSummary     兜底总结（有工具结果但无最终回答时）
//   finalizeTask        收尾：兜底 + 状态推送 + 持久化 + 工作区清理
//
// 三分支处理器返回指令（directive）：
//   { action: "continue" }              → 下一轮
//   { action: "finish", answer }        → 以 answer 作为最终回答结束
//   { action: "break" }                 → 结束（answer 由兜底逻辑产生，如中止）
// ============================================================
import {
  debuggee, debuggeeUrl, debuggerAttach, debuggerDetach, resetNetworkRequests, resetScriptList,
  resetConsoleLogs, interceptSetMode
} from "./debugger.js";
import {
  getLLMConfig, llmCallWithRetry, streamChatCompletion, classifyIntent, fallbackIntent, normalizeEndpoint,
  estimateTokensV2, runChat, llmCallCounter, resetLLMCallCounter, keepAliveForLocal
} from "./llm.js";
import {
  buildSkillsIndex, getProject, saveConversation, getActiveConversation, getConversation, setActiveConversation,
  getWorkspace,
  appendWorkspaceEntry, buildWorkspaceSummary, publishToBlackboard, AI_PROJECT_ID,
  buildCheckpoint, renderCheckpoint
} from "./memory.js";
import {
  detectOverthinking, detectGuessing, detectUnverifiedClaim, toolResultHasSubstance,
  buildSelfReviewQuestion, resetGuards
} from "./guards.js";
import { runReviewAudit, TOOL_NAMES_CN } from "./experts.js";
import { buildAnchorBlock, compactionWithSummary, isCheckpointMessage, sanitizeMessageSequence, pruneToolResults } from "./plan.js";
import { assembleSections, TOOL_DEFINITIONS } from "./prompts.js";
import { dispatchTool } from "./executor.js";
import { taskState, appState, pushStatus, typewriterPush, abortPendingApproval } from "./state.js";
import { normalizeError, isToolResultFailure } from "./errors.js";

// ============================================================
// 机制档位（为本地小模型减负）：云端的对抗性审查/专家复核等对 7B 是负担。
// full = 全部机制（云端默认）；lite = 精简（本地小模型默认，auto 按回环地址判定）；
// 存储键 f12x_guard_profile = auto|lite|full（auto 为缺省，按 baseUrl 自动判定）
// ============================================================
const GUARD_PROFILE = {
  full: { adversarial: true, probeGate: true, planGate: true, finalReview: true, stuckExpert: true, overthink: true, liteTools: false },
  lite: { adversarial: false, probeGate: false, planGate: false, finalReview: false, stuckExpert: false, overthink: false, liteTools: true }
};
export function isLocalBaseUrl(baseUrl) {
  const host = String(baseUrl || "").replace(/^https?:\/\//i, "").split("/")[0].split(":")[0].toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(host);
}
export async function resolveGuardProfile(baseUrl) {
  let mode = "auto";
  try { const r = await chrome.storage.local.get("f12x_guard_profile"); mode = r.f12x_guard_profile || "auto"; } catch (e) {}
  if (mode !== "lite" && mode !== "full") mode = isLocalBaseUrl(baseUrl) ? "lite" : "full";
  return { mode, ...GUARD_PROFILE[mode] };
}
export const LITE_EXCLUDED_TOOLS = new Set(["rebuttal_check", "call_expert"]); // 精简档从工具面剔除云端机制工具

export const LITE_CORE_TOOLS = new Set([
  "get_page_skeleton", "search_dom", "eval_js", "navigate",
  "get_network_requests", "get_network_request_detail", "get_cookies",
  "get_script_list", "get_script_content", "get_console_logs",
  "replay_request", "screenshot", "decode_text", "compare_responses",
  "upsert_fact", "get_fact", "workspace_note", "plan_write"
]);
// 精简档工具面：核心子集 + 描述截短（本地小模型 prefill 提速；full/云端不受影响）
export function toolDefsForMode(g, defs) {
  if (!g || !g.liteTools) return defs;
  return defs.filter(t => LITE_CORE_TOOLS.has(t.name))
    .map(t => (t && t.description && t.description.length > 160)
      ? { ...t, description: t.description.substring(0, 160) + "…" } : t);
}

// ============================================================
// 批准/审计/接管闭环（方案 5.1 / 14.1 / 14.3 / 14.7① / 3.2）
// G1 读自动 / G2 写批准 / G3 不可逆必批（默认未知工具按 G2——安全默认）
// 批准等待：Deferred + 120s 超时 + storage 快照（SW 复活重弹批准条，写操作绝不自动批准）
// ============================================================
const APPROVAL_G1 = new Set([
  "get_page_skeleton", "search_dom", "get_network_requests",
  "get_network_request_detail", "get_cookies", "get_script_list", "get_script_content",
  "get_console_logs", "screenshot", "highlight_element", "get_fact", "get_skill", "read_spilled",
  "decode_text", "compare_responses", "call_expert", "rebuttal_check"
]);
const APPROVAL_G3 = new Set([]); // v1 无不可逆工具，预留扩展
const APPROVAL_SNAP_KEY = "f12x_pending_approval_v1";
const APPROVAL_TIMEOUT = 120000; // 方案 13.2：批准超时 120s

export function classifyLevel(tool) {
  if (APPROVAL_G3.has(tool)) return "g3";
  if (APPROVAL_G1.has(tool)) return "g1";
  return "g2";
}

function callPreview(tool, args) {
  const a = args || {};
  switch (tool) {
    case "replay_request": return `${a.method || "GET"} ${a.url || ""}`;
    case "navigate": return `导航 → ${a.url || ""}`;
    case "eval_js": return `执行 JS：${String(a.code || "").substring(0, 80)}`;
    case "intruder": return `${a.method || "GET"} ${a.url || ""}（payloads ×${(a.payloads || []).length}）`;
    case "upsert_fact": return `记忆写入：${a.key}`;
    case "workspace_note": return `研讨：${String(a.content || "").substring(0, 60)}`;
    case "replan": return `重新规划：${String(a.reason || "").substring(0, 60)}`;
    case "plan_write": return `执行流程：${(a.reason ? String(a.reason).substring(0, 40) : ((a.steps || []).length ? (a.steps.length + " 步") : "声明简单任务"))}`;
    default: return JSON.stringify(a).substring(0, 120);
  }
}

// P1：参数哈希 canonicalize（方案 §9.2 重复工具提醒用）——键排序稳定 JSON，
// 键序不同的等价参数视为同参；数组保序（payloads 顺序有意义）
function canonicalKey(tool, args) {
  const walk = (v) => {
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    if (v && typeof v === "object") {
      return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${walk(v[k])}`).join(",")}}`;
    }
    return JSON.stringify(v);
  };
  return `${tool}|${walk(args || {})}`;
}

async function approvalLevelSetting() {
  const r = await chrome.storage.local.get({ approvalLevel: "read_auto_write_approve" });
  return r.approvalLevel;
}

function needsApproval(level, setting) {
  if (setting === "full_auto") return false;
  if (setting === "all_approve") return true;
  return level === "g2" || level === "g3"; // read_auto_write_approve
}

async function persistApprovalSnapshot(approval) {
  try { await chrome.storage.local.set({ [APPROVAL_SNAP_KEY]: approval }); } catch (e) {}
}
async function clearApprovalSnapshot() {
  try { await chrome.storage.local.remove(APPROVAL_SNAP_KEY); } catch (e) {}
}

// 批准等待（Deferred）：返回 { decision:'approved'|'rejected'|'timeout', approvedCalls:Set, reason }
function requestApproval(tool, level, calls) {
  return new Promise((resolve) => {
    const approval = {
      id: "ap_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
      tool, level, calls, ts: Date.now(), timeoutMs: APPROVAL_TIMEOUT
    };
    taskState.pendingApproval = approval;
    persistApprovalSnapshot(approval); // 14.1 ②：未决批准持久化（SW 复活重弹批准条）
    // 修复（审读高2/高3）：①批准等待订阅任务 abort signal——steering 打断/暂停时立即按拒绝放行，
    // 不再空等 120s 超时（原实现完全不感知 signal）；②不再重复创建 keepalive alarm
    // （background.js 已按 14.1 方案常驻 20s 保活，此处重建且从不清理会造成重复注册）
    const abSig = taskState.abort?.signal;
    const onAbort = () => {
      if (taskState.pendingApproval?.id === approval.id) {
        done("rejected", null, "任务被打断（暂停/新指令），批准按拒绝处理");
        pushStatus({ status: "stopped", text: "AI 操作已被打断，待批操作按拒绝处理（写操作绝不自动批准）" });
      }
    };
    if (abSig) {
      if (abSig.aborted) onAbort();
      else abSig.addEventListener("abort", onAbort, { once: true });
    }
    const done = (decision, approvedCalls, reason) => {
      if (abSig && !abSig.aborted) abSig.removeEventListener("abort", onAbort);
      if (taskState._approvalTimer) { clearTimeout(taskState._approvalTimer); taskState._approvalTimer = null; }
      taskState.approvalDeferred = null;
      taskState.pendingApproval = null;
      clearApprovalSnapshot();
      resolve({ decision, approvedCalls: approvedCalls || new Set(), reason: reason || "" });
    };
    taskState.approvalDeferred = (msg) => done(msg.decision, new Set(msg.approvedCalls || []), msg.reason || "");
    pushStatus({ type: "ai:approval_requested", approval });
    taskState._approvalTimer = setTimeout(() => {
      if (taskState.pendingApproval?.id === approval.id) {
        done("timeout", null, "批准超时（120s 未响应，安全默认按拒绝处理）");
        pushStatus({ status: "stopped", text: "AI 操作批准超时，已按拒绝处理（写操作绝不自动批准）" });
      }
    }, APPROVAL_TIMEOUT);
  });
}

// router 调用：panel 批准/拒绝结果回灌（5.1 第 3 步）
export function resolveApproval(message) {
  const d = taskState.approvalDeferred;
  if (!d) return { ok: false, error: "无未决批准（任务可能已中断或超时）" };
  d(message);
  return { ok: true };
}

// 14.1 ②：SW 复活时恢复未决批准 → 重新弹批准条（写操作绝不自动批准）
export async function recoverPendingApproval() {
  const r = await chrome.storage.local.get(APPROVAL_SNAP_KEY);
  const ap = r[APPROVAL_SNAP_KEY];
  if (!ap) return;
  await chrome.storage.local.remove(APPROVAL_SNAP_KEY);
  pushStatus({ type: "ai:approval_requested", approval: { ...ap, recovered: true } });
}

// 思考硬上限设置读取（storage f12x_thinking_limit，单位：字符；0/未设 = 不限制）
async function readThinkingLimit() {
  try {
    const r = await chrome.storage.local.get("f12x_thinking_limit");
    const v = Number(r.f12x_thinking_limit);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  } catch (e) { return 0; }
}

// 上下文窗口设置读取（storage f12x_context_window，单位 token；0/未设 = 131072）。
// DSH compaction-basic 同语义：窗口来自配置/路由模型，阈值=0.8×窗口、保留尾部=0.16×窗口
async function readContextWindow() {
  try {
    const r = await chrome.storage.local.get("f12x_context_window");
    const v = Number(r.f12x_context_window);
    if (Number.isFinite(v) && v > 0) return Math.max(32768, Math.min(v, 1024 * 1024));
  } catch (e) {}
  return 131072;
}

// ===== 暂停/中断后的"上下文关联"：把本会话已发生的任务进展浓缩成摘要，
// 供后续对话/追问直接引用（修复：暂停后再问进展，模型因看不到工具结果与原始目标而"失忆"）
function taskDigest(session) {
  if (!session) return "";
  const parts = [];
  if (session.goal) parts.push("【本会话任务目标】" + String(session.goal).substring(0, 800));
  const plan = Array.isArray(session.plan) ? session.plan : [];
  if (plan.length) {
    parts.push("【当前执行计划】" + plan.map(p => (p.status === "done" ? "[x] " : p.status === "doing" ? "[●] " : "[ ] ") + String(p.desc || "")).join("\n"));
  }
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  const tools = msgs.filter(m => m && m.role === "tool").slice(-6);
  if (tools.length) {
    parts.push("【本会话先前任务的最近工具实测结果】" + tools.map(m => { const s = String(m.content || ""); return s.length > 300 ? s.substring(0, 300) + "…" : s; }).join("\n---\n"));
  }
  const asst = msgs.filter(m => m && m.role === "assistant" && m.content && !(m.tool_calls && m.tool_calls.length)).slice(-2);
  if (asst.length) {
    parts.push("【最近助手文字】" + asst.map(m => String(m.content).substring(0, 500)).join("\n---\n"));
  }
  return parts.length ? parts.join("\n\n") : "";
}

// 审计留痕（方案 3.2⑤：一切动作留痕；审计随会话持久化，finalizeTask 收口保存）
export function addAudit(entry) {
  const session = taskState.conv;
  if (!session) return;
  if (!Array.isArray(session.audit)) session.audit = [];
  session.audit.push({ time: Date.now(), actor: "ai", approval: "none", ...entry });
  if (session.audit.length > 200) session.audit = session.audit.slice(-200);
  pushStatus({ type: "audit", entry: session.audit[session.audit.length - 1] });
}

// P1：会话增量审计域（方案 §8.2，为轨迹可视化铺路）
// 只追加 session.events[]，不动 messages/audit 结构；上限 500 + 裁剪策略：
// 超出时先把连续 state 事件合并为"最新一条 + count"，再截尾 500（approval/compaction 保留）
export function sessionEvent(session, evt) {
  if (!session) return;
  if (!Array.isArray(session.events)) session.events = [];
  session.events.push({ ts: Date.now(), ...evt });
  if (session.events.length > 500) {
    const merged = [];
    for (const ev of session.events) {
      const last = merged[merged.length - 1];
      if (ev.type === "state" && last && last.type === "state") {
        last.count = (last.count || 1) + 1;
        last.ts = ev.ts;
      } else merged.push(ev);
    }
    session.events = merged.slice(-500);
  }
}

// ============================================================
// 实时同步：执行中增量落库 + 广播 conversation:changed（会话记录/轨迹边跑边刷新，
// 不再等 finalizeTask 一次性收口）。_seq 是"运行上下文消息水位"：
// flushRunProgress 按高水位把本轮新增消息抄进 session.messages（拷贝解耦——
// 压缩替换 ctx.messages 时不影响已落库记录）。
// ============================================================
let msgSeqCounter = 0;
let _convFlushTs = 0, _convFlushTail = null;
let _lastRunConvId = null; // 最近一次 AI 运行归属会话（executeTask 收尾事件带 convId——面板防跨会话误结束）

// 节流写库（≥700ms 一次，尾部兜底一次），写成功即广播让面板刷新当前会话
export function flushSession(session, opts = {}) {
  if (!session) return;
  const doSave = () => {
    _convFlushTs = Date.now();
    saveConversation(session).then(() => {
      try { pushStatus({ type: "conversation:changed", convId: session.convId, ts: Date.now() }); } catch (e) {}
    }).catch((e) => console.warn("[Agent] 会话增量保存失败:", e && e.message));
  };
  if (opts.force) { if (_convFlushTail) { clearTimeout(_convFlushTail); _convFlushTail = null; } doSave(); return; }
  if (Date.now() - _convFlushTs > 700) { if (_convFlushTail) { clearTimeout(_convFlushTail); _convFlushTail = null; } doSave(); }
  else if (!_convFlushTail) { _convFlushTail = setTimeout(() => { _convFlushTail = null; doSave(); }, 700); }
}

// 把 ctx.messages 中水位以上（本轮已生成、尚未落库）的消息抄进 session.messages
export function flushRunProgress(ctx) {
  const { messages, session } = ctx;
  if (!session || !Array.isArray(session.messages)) return false;
  const high = ctx.seqHigh || 0;
  const pend = (messages || []).filter(m => m && m._seq && m._seq > high);
  if (!pend.length) return false;
  ctx.seqHigh = Math.max(high, ...pend.map(m => m._seq));
  session.messages.push(...pend.map(m => ({ ...m }))); // 拷贝入记录
  if (session.messages.length > 400) session.messages = session.messages.slice(-400);
  return true;
}

// 把"裁剪/压缩后"的旧消息内容同步回会话记录（按 _seq+role+tool_call_id 定位既有拷贝，只更新 content）——
// 对齐 DSH pruner 的持久替换语义：本轮生效后，后续轮/续跑不必重复裁剪同一批大结果
function persistSessionMessageContent(ctx, changedMessages) {
  const { session } = ctx;
  if (!session || !Array.isArray(session.messages)) return false;
  const map = new Map();
  for (const m of changedMessages || []) {
    if (m && m._seq) map.set(m._seq + "|" + (m.role || "") + "|" + (m.tool_call_id || ""), m);
  }
  let touched = false;
  for (let i = 0; i < session.messages.length; i++) {
    const sm = session.messages[i];
    if (!sm || !sm._seq) continue;
    const key = sm._seq + "|" + (sm.role || "") + "|" + (sm.tool_call_id || "");
    const newer = map.get(key);
    if (newer && newer.content !== sm.content) { session.messages[i] = { ...sm, content: newer.content }; touched = true; }
  }
  return touched;
}

// 回放标记（UI 持久化用，不进 LLM 上下文）：把"仅展示型"记录（思考轮 / 专家轮）追加到
// session.messages——renderChatHistory/会话记录据此回看；载入历史时按 _kind 排除（见 runAgentLoop）
function pushReplayMark(session, kind, obj) {
  if (!session || !Array.isArray(session.messages)) return;
  session.messages.push({ role: "user", _sys: true, _kind: kind, ts: Date.now(), content: JSON.stringify(obj) });
  if (session.messages.length > 400) session.messages = session.messages.slice(-400);
}

// 发送前清洗（§3.2 契约）：剔除本地元数据 _sys；历史存量数据中残留的 internal 角色归一化为 user
// （DeepSeek 只接受 system/user/assistant/tool，否则 HTTP 400 unknown variant）
function sanitizeMessagesForAPI(messages) {
  return messages.map((m) => {
    // 剔除本地元数据 _sys/_kind（review_reply 等仅渲染用标记不发给 API）
    const { _sys, _kind, ...rest } = m;
    if (rest.role === "internal") rest.role = "user";
    return rest;
  });
}

// ============================================================
// 单轮 LLM 流式调用：累积本轮思考/回答/工具增量，流结束后返回
// 瞬态错误由 llmCallWithRetry 内部重试（重试前重置累积状态防重复）
// ============================================================
async function streamOneRound({ endpoint, config, messagesForCall, forceDirectAnswer, session, signal, onStatus, round, thinkingLimit = 0, toolDefs = TOOL_DEFINITIONS }) {
  const llmBody = {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: sanitizeMessagesForAPI(messagesForCall),
      tools: toolDefs.map(t => ({ type: "function", function: t })),
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 8192, // v4-flash thinking 模式：reasoning 也计入（官方文档确认共享预算）；4096 会被思考吃光、content 被截断为空
      stream: true,
      stream_options: { include_usage: true }, // DeepSeek 契约：显式开启才能稳定收到 usage（否则 usage 时有时无，裁剪时机不准）
      // 两档直切（P0a 修复）：1=默认思考；2=禁用思考、预算全给 content。
      // 原 `reasoning_effort:"low"` 档在 DeepSeek 服务端会映射回 high（无效降级），已删除。
      ...(forceDirectAnswer === 2 ? { thinking: { type: "disabled" } } : {}),
      ...keepAliveForLocal(config.baseUrl)
    })
  };

  const out = { contentBuf: "", reasoningBuf: "", reasoningStarted: false, toolCalls: [], finishReason: null, lastReasoningTokens: 0, _lastLivePush: 0 };
  const buildBody = (disable) => ({
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: sanitizeMessagesForAPI(messagesForCall),
      tools: toolDefs.map(t => ({ type: "function", function: t })),
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true },
      ...(disable ? { thinking: { type: "disabled" } } : {}),
      ...keepAliveForLocal(config.baseUrl)
    })
  });
  const feed = ({ json, done, disabled }) => {
    if (done || signal.aborted) return;
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    // 思考字段兼容：DeepSeek 用 reasoning_content；Ollama/Qwen3 实测用 reasoning（delta.reasoning）
    const rText = delta.reasoning_content || delta.reasoning;
    if (rText) {
      if (thinkingLimit > 0 && !disabled && (out.reasoningBuf.length + rText.length) > thinkingLimit) {
        const err = new Error("thinking_budget_exceeded");
        err.thinkingBudget = true;
        throw err;
      }
      if (!out.reasoningStarted) { out.reasoningStarted = true; if (onStatus) onStatus({ type: "reasoning_start", round }); }
      out.reasoningBuf += rText;
      if (onStatus) onStatus({ type: "reasoning_delta", text: rText, round });
    }
    if (delta.content) out.contentBuf += delta.content;
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index || 0;
        if (!out.toolCalls[idx]) out.toolCalls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) out.toolCalls[idx].id = tc.id;
        if (tc.function?.name) out.toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) out.toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
    if (onStatus && (delta.content || delta.tool_calls || rText)) {
      const now = Date.now();
      if (now - out._lastLivePush > 1200) {
        out._lastLivePush = now;
        const toolName = out.toolCalls.find(t => t && t.function?.name)?.function?.name || "";
        const argLen = out.toolCalls.reduce((s, t) => s + (t?.function?.arguments || "").length, 0);
        onStatus({ type: "stream_progress", round, contentChars: out.contentBuf.length, argLen, toolName, reasoningChars: out.reasoningBuf.length });
      }
    }
    if (choice.finish_reason) {
      out.finishReason = choice.finish_reason;
      if (choice.finish_reason === "length") out.toolCalls.length = 0;
    }
    if (json.usage?.prompt_tokens) {
      const cached = json.usage.prompt_tokens_details?.cached_tokens || 0;
      session.lastPromptTokens = Math.max(json.usage.prompt_tokens - cached, 0);
    }
    if (json.usage?.completion_tokens_details?.reasoning_tokens) {
      out.lastReasoningTokens = json.usage.completion_tokens_details.reasoning_tokens;
    }
  };
  const resetOut = () => { out.contentBuf = ""; out.reasoningBuf = ""; out.reasoningStarted = false; out.toolCalls.length = 0; out.finishReason = null; };
  const retryHook = { signal, onRetry: (attempt, delay, code) => addAudit({ action: "LLM 重试", resultSummary: `${code}，${delay}ms 后重试（第 ${attempt + 1} 次）`, approval: "none" }) };
  let disabledRetried = false;
  try {
    // 禁思考(noThink/守卫降级 forceDirectAnswer===2)在首次请求即生效——修复重写时丢失的 thinking:disabled 透传
    const disableInit = forceDirectAnswer === 2;
    await llmCallWithRetry(() => { resetOut(); return streamChatCompletion(endpoint, buildBody(disableInit), ({ json, done }) => feed({ json, done, disabled: disableInit }), { signal }); }, retryHook);
  } catch (e) {
    if (e && e.thinkingBudget && !disabledRetried && thinkingLimit > 0) {
      disabledRetried = true;
      const keepReason = out.reasoningBuf.substring(0, thinkingLimit);
      await llmCallWithRetry(() => { resetOut(); out.reasoningStarted = !!keepReason; return streamChatCompletion(endpoint, buildBody(true), ({ json, done }) => feed({ json, done, disabled: true }), { signal }); }, retryHook);
      if (!out.reasoningBuf && keepReason) out.reasoningBuf = keepReason;
      if (onStatus) onStatus({ type: "thinking_text", text: "⚠ 思考已达上限，已自动切为直接作答", round });
    } else {
      throw e;
    }
  }
  return out;
}

// ============================================================
// 思考质量检查（效率铁律 v4）：只抓"空想"，不压制深度思考
// 空想（重复自我对话）与乱猜（猜测当数据）各自两档直切：提示 → 禁用思考（P0a：原中间档
// reasoning_effort:"low" 服务端映射回 high 无效，已删除，见 streamOneRound）
// 防空想（两档直切 + 三判据）：
//  1. 话术型空想（重复自我对话）2. 长时无产出空想（大段推理却既无正文也无工具调用——
//     修复：v4-flash 类模型空想常无触发话术，原检测完全漏检）3. 乱猜（猜测当数据）
// 任一判据触发：提示一次；仍犯则 thinking:disabled，绝不无限空耗
function applyThinkingGuards(ctx, out, onStatus, round) {
  const { messages } = ctx;
  const reasoningBuf = String(out?.reasoningBuf || "");
  const len = reasoningBuf.length;
  const textLen = String(out?.contentBuf || "").trim().length;
  const produced = !!(textLen > 0 || (out?.toolCalls || []).length);
  // 跨轮累计：只推理不产出的轮次计数（有产出即清零）
  if (produced) ctx.idleChain = 0;
  else ctx.idleChain = (ctx.idleChain || 0) + 1;
  // 方案 A（调研定稿）：防空想只管"行为/环路/纪律"——
  //   a) 单轮长空想：已由"思考硬上限"(thinkingLimit>0) 在底层掐流接管，防空想不再叠加；
  //      仅当未设上限(=0 不限)时，保留 ≥1500 字无产出作为隐式兜底
  //   b) 连续 ≥2 轮只推理无产出（每轮 >300 字即累计）——防"小段反复想、从不干活"
  //   c) 话术型重复自我对话
  const hasThinkCap = (ctx.thinkingLimit || 0) > 0;
  const longIdle = !hasThinkCap && len >= 1500 && !produced;
  const chainIdle = !produced && ctx.idleChain >= 2 && len > 300;
  const wordIdle = detectOverthinking(reasoningBuf) === 1;
  if (longIdle || chainIdle || wordIdle) {
    const cause = longIdle
      ? "本轮回推理 " + len + " 字却无任何产出（无正文、无工具调用）"
      : chainIdle
        ? "已连续 " + ctx.idleChain + " 轮只推理无产出（疑似在空想循环）"
        : "思考中存在大量重复自我对话";
    if (ctx.thinkRetry === 0) {
      ctx.thinkRetry = 1;
      if (onStatus) onStatus({ type: "thinking_text", text: "⚠ 检测到空想（" + cause + "）——立即行动", round });
      appendTurnMessages(messages, { channel: "internal", content: "检测到空想：" + cause + "。**立即行动**：要么调用只读工具验证，要么基于已有数据给出结论。思考只服务决策，禁止为思考而思考。" });
      console.warn("[Agent] 空想提示（" + cause + "，reasoning " + len + " 字符）");
    } else {
      ctx.thinkRetry = 2;
      ctx.forceDirectAnswer = 2;
      ctx.idleChain = 0;
      if (onStatus) onStatus({ type: "thinking_text", text: "⚠ 空想持续，已禁用思考，立即行动", round });
      console.warn("[Agent] 空想降级 thinking:disabled（第 " + ctx.thinkRetry + " 次，" + cause + "）");
    }
  }
  if (detectGuessing(reasoningBuf) === 1) {
    if (ctx.guessRetry === 0) {
      ctx.guessRetry = 1;
      if (onStatus) onStatus({ type: "thinking_text", text: "检测到大量猜测表述——猜测不是数据，请用工具验证...", round });
      appendTurnMessages(messages, { channel: "internal", content: "你最近的推理中出现大量猜测性表述（可能/也许/推测…）。**猜测不是数据**——渗透结论必须基于工具实测（URL/状态码/响应内容）。有疑问就直接调用工具验证，不要猜。" });
      console.warn("[Agent] 乱猜提示（reasoning " + len + " 字符）");
    } else {
      ctx.guessRetry = 2;
      ctx.forceDirectAnswer = 2;
      if (onStatus) onStatus({ type: "thinking_text", text: "猜测持续——已禁用思考，立即用工具验证...", round });
      console.warn("[Agent] 乱猜降级 disabled（第 " + ctx.guessRetry + " 次）");
    }
  }
}

// 收敛沉淀（黑板优化 A）：同一会话已存在内容完全一致的 finding → 不再重复沉淀（保首次 createdAt）；
// 空/占位文本不入黑板（兜底占位符不作为发现）
async function sinkFinalFact(session, text, keyBase) {
  const pid = session.projectId || AI_PROJECT_ID;
  const summary = String(text || "").trim().substring(0, 100);
  if (!summary) return null;
  try {
    const project = await getProject(pid);
    const dup = (project?.facts || []).find(f => f.category === "finding" && f.convId === session.convId && f.summary === summary);
    if (dup) return dup;
  } catch (e) {}
  return await publishToBlackboard(pid, { key: keyBase, category: "finding", summary, body: String(text || "").substring(0, 2000), confidence: "high", convId: session.convId });
}

// 情况1：纯文本无工具调用 → 候选最终回答
// 五道拦截（按顺序）：审查回应 → 首轮侦察强制 → 未验证结论 → 任务未完成确认 → 最终审查
// 全部通过才作为最终回答推送（唯一推送点）并沉淀工作区/黑板
// ============================================================
async function handleTextAnswer(ctx, textContent, out, round) {
  const { messages, session, onStatus, userMessage } = ctx;

  // === 审查回应检测（对抗性审查的回应识别，防止审查回应被当作最终回答） ===
  // 对抗性审查必须"内容可见"：触发时问题经 rebuttal 事件入 review 卡；回应到达时经 review_reply
  // 并入同一张卡，并整对落库为 _kind:"review" 回放标记（刷新/重开会话仍可见）
  if (ctx.reviewPending) {
    ctx.reviewPending = false;
    const reviewMeta = ctx.pendingReview || {};
    ctx.pendingReview = null;
    // 未按格式作答且次数未超限 → 保持待回应（防审查被绕过/空转），再次要求先回答
    if (!textContent.includes("自我审查回应") && ctx.reviewMiss < 2) {
      ctx.reviewMiss++;
      ctx.reviewPending = true;
      if (onStatus) onStatus({ type: "thinking_text", text: "自我审查未回应——强制要求先回答审查...", round });
      appendTurnMessages(messages, { channel: "internal", content: "你还没有回应上一条自我审查请求。请以「自我审查回应」开头，按格式给出：\n- 我的结论：\n- 风险点回应：（必须引用具体工具数据，禁止\"我觉得/可能\"）\n- 我如何验证：\n- 验证结果：\n回应后再继续任务。" });
      return { action: "continue" };
    }
    // 超限仍不按格式 → 仍按审查回应接收并注明，防无限空转
    if (!textContent.includes("自我审查回应")) textContent = "（模型未按「自我审查回应」格式作答，以下按审查回应处理）\n" + textContent;
    const appended = appendTurnMessages(messages, { channel: "assistant", content: textContent, reasoning_content: out.reasoningBuf ? out.reasoningBuf : undefined });
    appended._kind = "review_reply"; // 回应并入对抗性审查卡，渲染层不重复当正文段落
    const metaRound = reviewMeta.round != null ? reviewMeta.round : round;
    // 审查对（触发原因 + 问题 + 回应）整对落库：聊天刷新/重开会话仍以一张卡回看
    recordReviewAnswered(session, metaRound, reviewMeta.reason || "", reviewMeta.question || "", textContent, onStatus); // P5：整对落库 + replied 统计
    // 最终审查（selfReviewDone 置位）：内容即最终报告——已推送一次，标记避免下方重复打字机（该闸已移除，此路径仅兜底）
    if (ctx.selfReviewDone) {
      ctx.finalPushed = true;
      ctx.finalAnswer = textContent;
      if (onStatus) onStatus({ type: "answer_delta", text: textContent, round });
    }
    // 周期性审查：审查不是终点，强制任务继续（回应内容已在 review 卡可见）
    if (!ctx.selfReviewDone) {
      appendTurnMessages(messages, { channel: "internal", content: "已收到你的审查回应。请基于回应继续执行任务：验证未验证的风险点 / 继续推进计划 / 或基于数据输出最终结论。" });
      return { action: "continue" };
    }
  }
  // === 任务模式尚未用过工具 → 不能直接结束：强制先探测（不只首轮——任何"未探测就收尾"的正文都被拦下） ===
  // 机制约束：任务必须先对目标进行探测，依据探测到的事实推进，因此不存在"未触发探测"的情况
  if (ctx.g.probeGate && !ctx.hasToolUseThisTask && !ctx.reviewPending && !ctx.selfReviewDone && ctx.probeRefusal < 2) {
    ctx.probeRefusal++;
    if (onStatus) onStatus({ type: "thinking_text", text: "任务模式尚未调用工具——强制先探测目标（第 " + ctx.probeRefusal + " 次）...", round });
    appendTurnMessages(messages, { channel: "internal", content: "本任务还没有任何实测数据——任务机制要求先探测、后按探测结果执行。请调用只读工具获取页面/接口现状（get_page_skeleton / get_network_requests / search_dom / get_console_logs / get_network_request_detail 等），拿到实际数据后再继续。" });
    return { action: "continue" };
  }

  // === 执行流程收尾门（主代理自持，todo 语义）：已用工具但从未提交执行流程 → 不得直接收尾 ===
  // 例外：plan_write 传 steps:[] 已声明"简单任务无需多步流程"（planCommitted=true 且 plan=[]）
  if (ctx.g.planGate && ctx.hasToolUseThisTask && !session.planCommitted && !ctx.reviewPending && !ctx.selfReviewDone && ctx.planFinalWarn < 1 && !ctx.aborted) {
    ctx.planFinalWarn++;
    if (onStatus) onStatus({ type: "thinking_text", text: "任务已获取实测数据但未提交执行流程——请先调用 plan_write 再收尾...", round });
    appendTurnMessages(messages, { channel: "internal", content: "你已调用工具获取实测数据，但**尚未通过 plan_write 提交执行流程**。任务机制要求：多步任务先提交执行流程（每步含 desc + 可验证 criterion，首个步骤 doing，达成后再置 done）；确为单步/简单任务则调用 plan_write 传 steps:[] 明确声明。提交（或声明）之后再输出最终回答。" });
    return { action: "continue" };
  }

  // === 未验证结论检测（第二轮审查 P0-1：工具结果无实质时禁止宣称重大发现） ===
  // 只拦"重大发现宣称"（发现漏洞/拿到凭证/flag 等），不拦正常总结报告
  if (ctx.hasToolUseThisTask && ctx.unverifiedClaimWarnings < 1 && detectUnverifiedClaim(textContent)) {
    const allToolResults = messages.filter(m => m.role === "tool").map(m => String(m.content || ""));
    if (!toolResultHasSubstance(allToolResults)) {
      ctx.unverifiedClaimWarnings++;
      if (onStatus) onStatus({ type: "thinking_text", text: "检测到无实测支撑的结论声称——要求先验证...", round });
      appendTurnMessages(messages, { channel: "internal", content: "你宣称的结论在工具实测结果中没有支撑——**这是猜测**。请先调用工具验证（get_network_request_detail 查看响应 / eval_js 执行验证），拿到实际数据后再下结论。" });
      return { action: "continue" };
    }
  }

  // === 任务完成检查（第二轮审查 P1-7）：任务用了工具但计划未完成/工具报错 → 强制确认 ===
  // 只允许一次确认机会（finalConfirmRetry < 1），防止无限循环
  const planUnfinished = session.plan?.length && session.plan.some(p => p.status === "todo" || p.status === "doing");
  const recentToolError = messages.filter(m => m.role === "tool").slice(-2).some(m => {
    try {
      const j = JSON.parse(m.content);
      if (!j) return false;
      if (j.approval === "rejected") return false; // 修复（审读中2）：用户拒绝/超时是决策反馈，不是工具报错——不触发"未完成确认"白绕一轮
      return !!(j.error || j.needsConfirmation);
    } catch { return false; }
  });
  if (ctx.hasToolUseThisTask && !ctx.aborted && (planUnfinished || recentToolError) && ctx.finalConfirmRetry < 1) {
    ctx.finalConfirmRetry++;
    if (onStatus) onStatus({ type: "thinking_text", text: planUnfinished ? "执行计划仍有未完成步骤，正在确认任务是否继续..." : "最近工具调用返回了错误，正在确认任务是否继续...", round });
    appendTurnMessages(messages, { channel: "internal", content: "检测到你输出了正文，但任务可能尚未完成（" +
      (planUnfinished ? "执行计划仍有未完成步骤；" : "") +
      (recentToolError ? "最近工具调用返回了错误。" : "") +
      "）。如果任务确实尚未完成，请继续执行直到真正完成；如果任务已实际完成，请明确说明\"任务已完成\"并给出最终结论。" });
    return { action: "continue" };
  }

  // 收尾验证只保留一道：复核审计员独立复核（同模型"最终自我审查"闸已移除，避免重复开销；
  // 执行中段的周期性对抗审查仍保留——那是过程纠偏，不是收尾重复）

  // === 最终独立复核（收敛版 A）：即将宣布最终结论时，复核审计员只读查证一次 ===
  if (ctx.g.finalReview && !ctx.aborted && ctx.hasToolUseThisTask && ctx.finalReviewCount < 2) {
    const candidate = (textContent.length < 40 && ctx.pendingFinalAnswer ? ctx.pendingFinalAnswer : textContent) || "";
    if (String(candidate).trim().length > 10) {
      ctx.finalReviewCount++;
      const zh = "复核审计员";
      const recentTools = messages.filter(m => m.role === "tool").slice(-4).map(m => String(m.content || "").substring(0, 1500)).join("\n---\n");
      if (onStatus) onStatus({ type: "expert_start", expert: zh, tool: "最终复核", round });
      const audit = await runReviewAudit({
        goal: session.goal || userMessage,
        focus: "主代理即将宣布以下最终结论，请独立复核其是否成立（用只读工具查证关键证据；能当场验证请当场验证）：\n" + candidate.substring(0, 2500),
        seedData: recentTools,
        config: ctx.config, signal: ctx.abortController.signal,
        onReasoning: (delta) => { if (onStatus) onStatus({ type: "expert_reasoning", expert: zh, delta, round }); }
      }).catch(() => null);
      if (onStatus) onStatus({ type: "expert_done", expert: zh, conclusion: audit?.findings, confidence: audit?.confidence, followup: audit?.nextAction, verified: !!audit?.verified, toolTrail: audit?.toolTrail || [], round });
      if (audit) {
        pushReplayMark(session, "expert", { expert: zh, tool: "最终复核", reasoning: String(audit.reasoning || "").substring(0, 12000), findings: audit.findings, evidence: audit.evidence, nextAction: audit.nextAction, confidence: audit.confidence, verified: !!audit.verified, toolTrail: audit.toolTrail || [] });
        sessionEvent(session, { type: "expert_round", expert: zh, steps: audit.steps || 0, verified: !!audit.verified, tools: (audit.toolTrail || []).map(t => t.tool).join(",") });
        if (!audit.verified && ctx.finalReviewCount < 2) {
          appendTurnMessages(messages, { channel: "internal", content: "【复核审计员】你拟宣布的最终结论未能通过独立复核（结论：" + (audit.findings || "证据不足") + "）。若有未验证环节请调用只读工具当场补验后再次输出最终结论；若确实无法补验，请明确说明该点为推断而非实测。" });
          ctx.reviewPending = false;
          return { action: "continue" };
        }
      }
    }
  }

  // === 最终回答：唯一推送点（审查回应路径 finalPushed=true 已推送过，跳过重复打字机） ===
  if (!ctx.finalPushed) {
    let finalText = textContent;
    if (finalText.length < 40 && ctx.pendingFinalAnswer) finalText = ctx.pendingFinalAnswer; // 最终审查回应路径 contentBuf 可能为空（模型思考后无 content）——回退 pending
    ctx.finalAnswer = finalText;
    if (finalText) await typewriterPush(finalText, onStatus);
  }
  // 最终回答的思考随消息持久化（历史回看可见——问题1 根因修复）
  if (!ctx.finalReasoning && out?.reasoningBuf) ctx.finalReasoning = out.reasoningBuf;

  // === 最终回答自动记入工作区（主模型也参与研讨记录） ===
  if (ctx.hasToolUseThisTask) {
    appendWorkspaceEntry(session.convId, { type: "discovery", author: "main_model", content: ctx.finalAnswer.substring(0, 500), evidence: "任务最终结论（自动记录）", status: "confirmed" });
    await sinkFinalFact(session, ctx.finalAnswer, `finding|final-${String(session.convId || "").substring(0, 12)}`);
  }
  return { action: "finish", answer: ctx.finalAnswer };
}

// §3.2：轮次消息追加统一入口（用户消息 / 工具结果 / 内部注入三通道）
// channel 决定 _sys 标记：internal 注入自动带 _sys:true（为 compaction/审计打基础）；
// user/tool/assistant 为显式通道不标记。所有"每轮消息追加"必须走此入口。
export function appendTurnMessages(messages, { channel, role = channel, content, tool_call_id, tool_calls, reasoning_content } = {}) {
  // internal 通道：注入给模型的指令文本——API 层 role 必须为 user（DeepSeek 只接受 system/user/assistant/tool，
  // 否则 HTTP 400 unknown variant）；_sys:true 仅作本地元数据（过滤/审计），发送前剔除
  const m = { role: channel === "internal" ? "user" : role, content };
  m._seq = ++msgSeqCounter; // 实时同步水位（flushRunProgress 依赖），勿删
  if (tool_call_id !== undefined) m.tool_call_id = tool_call_id;
  if (tool_calls) m.tool_calls = tool_calls;
  if (reasoning_content !== undefined) m.reasoning_content = reasoning_content;
  if (channel === "internal") m._sys = true;
  messages.push(m);
  return m;
}

// 兜底：assistant 的每个 tool_call 都必须有 tool 响应（缺失 → 补"未执行"）。
// 任务中断/批准超时等异常路径提前 break 时会留下未配对序列，若被持久化，
// 后续所有 LLM 调用都会报 HTTP 400（insufficient tool messages）。
function ensureToolResponses(messages, toolCalls) {
  for (const tc of toolCalls) {
    if (tc && tc.id && !messages.some(m => m.role === "tool" && m.tool_call_id === tc.id)) {
      appendTurnMessages(messages, { channel: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "工具调用因任务中断/批准超时未执行" }) });
    }
  }
}

// 计划快照记录（问题3）：计划内容变化（制定/重估）时写入轨迹事件 + 会话记录 marker。
// marker 用 _sys/_kind:"plan" 标注——UI 回看渲染为可展开计划块；加载历史时排除，不进 LLM 上下文。
function recordPlanSnapshot(ctx, kind) {
  const { session } = ctx;
  if (!session.plan?.length) return;
  const steps = session.plan.map(p => ({ step: p.step, desc: p.desc, status: p.status }));
  sessionEvent(session, { type: "plan", kind, steps: steps.length, descs: steps.map(p => p.desc).join(" | ").substring(0, 200) });
  session.messages.push({ role: "user", _sys: true, _kind: "plan", content: JSON.stringify({ kind, steps }) });
  if (session.messages.length > 400) session.messages = session.messages.slice(-400);
}

// ============================================================
// 情况2：工具调用（executeToolCall 已封装所有工具 + 研讨注入）
// 流程：审查拦截 → 执行工具（计划偏离软约束）→ 执行流程提醒 → 对抗性审查；执行流程由主代理经 plan_write 自持（todo 语义，引擎不代规划/不自动推进）
// ============================================================
async function handleToolCalls(ctx, out, round) {
  const { messages, session, config, onStatus, userMessage, abortController } = ctx;
  const textContent = (out.contentBuf || "").trim();
  const toolCalls = out.toolCalls;

  // === 审查拦截（对抗性审查，P3 方案_v4）：回应与工具同轮不丢轮 ===
  // 本轮正文已含「自我审查回应」→ 先结算回应（落卡/清 pending），再放行本轮工具调用；
  // 无回应正文 → 维持拦截（防绕过）；多次仍不带回应 → 按回应接收防无限空转
  if (ctx.reviewPending) {
    const replyTxt = String(textContent || "").trim();
    if (replyTxt.includes("自我审查回应")) {
      settleReviewReplyForToolRound(ctx, replyTxt, out, round);
    } else if (ctx.reviewMiss < 2) {
      ctx.reviewMiss++;
      if (onStatus) onStatus({ type: "thinking_text", text: "自我审查待回应——先回答审查问题再调用工具...", round });
      appendTurnMessages(messages, { channel: "internal", content: "在你调用工具之前，请先回应上一条自我审查问题（以「自我审查回应」开头并引用实测数据，1-3 句即可）。回应可与工具调用放同一轮，不会丢你的工具调用。" });
      return { action: "continue" };
    } else {
      settleReviewReplyForToolRound(ctx, replyTxt, out, round); // 多次仍未按格式 → 按回应接收（防无限空转）
    }
  }

  // M1：assistant 消息 content 永不 null（P0a 修复：null 会触发 OpenAI 400"assistant content required"，污染会话）。
  // P0a 修复：reasoning_content 仅工具轮回传——纯文本轮回传思考内容纯属烧 token（DeepSeek 思考内容按 token 计费）。
  appendTurnMessages(messages, { channel: "assistant", content: textContent || "", tool_calls: toolCalls, reasoning_content: toolCalls.length ? (out.reasoningBuf || "") : "" });

  const reasoningText = textContent || "正在分析当前信息，决定下一步行动…";
  if (onStatus) onStatus({ type: "thinking_text", text: reasoningText, round });

  const thisRoundToolResults = [];
  const roundNotices = [];

  // ============================================================
  // === 批准闸门（方案 5.1 / 14.3）：LLM 调用完成后、工具执行前 ===
  // 同轮同工具多调用合并为一条批准条（"AI 将发送 5 个请求（URL 列表），全部批准/逐个审/拒绝"）；
  // 不同工具分开批准；拒绝/超时结果回灌 LLM 下一轮（5.1 第 3 步）
  // ============================================================
  const approvalSetting = await approvalLevelSetting();
  const approvalDecisions = new Map(); // ti -> { approved:boolean, reason:string, level:string }
  {
    const groups = new Map(); // toolName -> { level, calls:[{ti, tc, preview}] }
    for (let ti = 0; ti < toolCalls.length; ti++) {
      const fc = toolCalls[ti].function;
      let tArgs = {};
      try { tArgs = JSON.parse(fc.arguments || "{}"); } catch (_) {}
      const level = classifyLevel(fc.name);
      if (fc.name === PLAN_WRITE) continue; // 执行流程提交是元操作：不触发批准闸门
      if (!needsApproval(level, approvalSetting)) continue;
      if (!groups.has(fc.name)) groups.set(fc.name, { level, calls: [] });
      groups.get(fc.name).calls.push({ ti, tc: toolCalls[ti], preview: callPreview(fc.name, tArgs) });
    }
    for (const [toolName, group] of groups) {
      const decision = await requestApproval(toolName, group.level, group.calls.map(c => ({ ti: c.ti, preview: c.preview })));
      // P1：会话增量审计域——批准合并为一条事件（保留 decision，轨迹可视化用）
      sessionEvent(session, { type: "approval", tool: toolName, level: group.level, calls: group.calls.length, decision: decision.decision });
      if (decision.decision === "timeout" && taskState.paused) { ctx.aborted = true; break; }
      for (const c of group.calls) {
        const approved = decision.decision === "approved" && decision.approvedCalls.has(c.ti);
        approvalDecisions.set(c.ti, { approved, reason: decision.reason, decision: decision.decision, level: group.level });
        if (!approved) {
          // 拒绝/超时 → 结果回灌 LLM（"用户拒绝(原因)"），本轮跳过执行
          ctx.hasToolUseThisTask = true;
          appendTurnMessages(messages, { channel: "tool", tool_call_id: c.tc.id,
            content: JSON.stringify({ error: `用户拒绝该操作（${TOOL_NAMES_CN[toolName] || toolName}）：${decision.reason || "未批准"}`, approval: "rejected" })
          });
          if (onStatus) onStatus({ type: "tool_done", text: `${TOOL_NAMES_CN[toolName] || toolName} 被用户拒绝`, tool: toolName, result: decision.reason || "未批准", round });
        }
      }
    }
  }
  if (ctx.aborted) { ensureToolResponses(messages, toolCalls); return { action: "break" }; }

  for (let ti = 0; ti < toolCalls.length; ti++) {
    const tc = toolCalls[ti];
    if (taskState.paused || abortController.signal.aborted) {
      ctx.aborted = true;
      sessionEvent(session, { type: "state", state: "aborted", reason: taskState.paused ? "paused" : "aborted" }); // P1：会话增量审计域
      for (let ri = ti; ri < toolCalls.length; ri++) {
        appendTurnMessages(messages, { channel: "tool", tool_call_id: toolCalls[ri].id, content: '{"error":"任务被打断，工具未执行"}' });
      }
      break;
    }
    const fc = tc.function;
    let toolArgs = {};
    try { toolArgs = JSON.parse(fc.arguments || "{}"); } catch (_) {}

    // === 执行流程提交（plan_write）：主代理自持流程——不属"工具实测"，不走批准/浮层/审计计数 ===
    if (fc.name === PLAN_WRITE) {
      const planRes = await applyPlanWrite(ctx, tc.id, toolArgs, round);
      thisRoundToolResults.push(JSON.stringify(planRes));
      continue;
    }

    ctx.hasToolUseThisTask = true;
    ctx.lastToolName = fc.name; // 记录最近实际工具（卡住救援据此选专家）

    // === 批准结果检查：被拒绝/超时的调用已在批准闸门回灌 tool 结果，跳过执行 ===
    const apd = approvalDecisions.get(ti);
    if (apd && !apd.approved) continue;

    const argPreview = JSON.stringify(toolArgs).substring(0, 200);
    if (onStatus) onStatus({ type: "tool_start", text: `调用 ${fc.name}`, tool: fc.name, args: argPreview, round });

    // === 计划执行约束（软执行）：当前步骤预期工具与实际调用不符 → 提醒（每任务最多 2 次） ===
    // 步骤 desc/criterion 由主代理撰写，可能含工具名——含则比对，不含不触发
    if (session.plan?.length && ctx.planDriftWarnings < 2) {
      const doingStep = session.plan.find(p => p.status === "doing");
      if (doingStep) {
        const stepText = String(doingStep.desc || "") + " " + String(doingStep.criterion || "");
        const expectedTools = Object.keys(TOOL_NAMES_CN).filter(tn => stepText.includes(tn));
        if (expectedTools.length && !expectedTools.includes(fc.name)) {
          ctx.planDriftWarnings++;
          roundNotices.push(`你的当前计划步骤是「${doingStep.desc}」（预期工具：${expectedTools.join("、")}），你刚才调用的是 ${TOOL_NAMES_CN[fc.name] || fc.name}。若偏离有实际依据（新发现/数据变化），请调用 plan_write 修订该步骤并说明原因后继续；否则请回到计划步骤执行。`);
        }
      }
    }

    // === P1：重复工具提醒（方案 §9.2）——同工具同参连续调用 3/5/8 次注入提醒（防死循环/空转） ===
    const callKey = canonicalKey(fc.name, toolArgs);
    if (callKey === ctx.lastCallKey) {
      ctx.sameCallStreak++;
      if ([3, 5, 8].includes(ctx.sameCallStreak) && !ctx.duplicateRemindedAt.has(ctx.sameCallStreak)) {
        ctx.duplicateRemindedAt.add(ctx.sameCallStreak);
        roundNotices.push(`你已连续 ${ctx.sameCallStreak} 次以相同参数调用 ${TOOL_NAMES_CN[fc.name] || fc.name}（${callPreview(fc.name, toolArgs)}）。若结果一直相同，继续重复只会空转——请基于已有结果推进：换参数 / 换工具 / 或直接给出结论。`);
        if (onStatus) onStatus({ type: "ai:repeat_tool_notice", tool: fc.name, count: ctx.sameCallStreak }); // §十一：重复工具提醒（stream）
      }
    } else {
      ctx.lastCallKey = callKey;
      ctx.sameCallStreak = 1;
    }

    let toolResult;
    // P1：dispatchTool 统一入口（ai 路径：校验→超时→执行→审计；signal=用户中止信号，interruptible 工具可中途停止）
    try { toolResult = await dispatchTool(fc.name, toolArgs, { mode: "ai", signal: abortController.signal }); }
    catch (e) { toolResult = { error: `工具执行失败: ${e.message}` }; }

    // === 审计留痕（方案 3.2⑤：一切动作留痕——时间/工具/参数/结果/批准） ===
    addAudit({
      tool: fc.name,
      paramsSummary: callPreview(fc.name, toolArgs),
      resultSummary: String(toolResult?.error || (toolResult?.ok === false ? JSON.stringify(toolResult).substring(0, 120) : "ok")),
      approval: apd ? (apd.approved ? "approved" : "rejected") : "auto"
    });
    const toolResultStr = JSON.stringify(toolResult);
    const resultPreview = toolResultStr.length > 500 ? toolResultStr.substring(0, 500) + "..." : toolResultStr;
    if (onStatus) onStatus({ type: "tool_done", text: `${fc.name} 完成`, tool: fc.name, result: resultPreview, round });
    appendTurnMessages(messages, { channel: "tool", tool_call_id: tc.id, content: toolResultStr });
    thisRoundToolResults.push(toolResultStr);
  }

  for (const notice of roundNotices) appendTurnMessages(messages, { channel: "internal", content: notice });

  if (ctx.aborted) { ensureToolResponses(messages, toolCalls); return { action: "break" }; }

  // === 执行流程提醒（主代理自持，todo 语义）：引擎不旁路规划、不自动推进 ===
  // 探测轮（已有工具实测、流程未提交）→ 注入一次显式提醒，要求主代理用 plan_write 提交执行流程
  if (ctx.g.planGate && !session.planCommitted && ctx.hasToolUseThisTask && !ctx.planWriteHinted) {
    ctx.planWriteHinted = true;
    if (onStatus) onStatus({ type: "thinking_text", text: "实测数据已到位——等待主代理提交执行流程（plan_write）...", round });
    appendTurnMessages(messages, { channel: "internal", content: "你已获得实测数据。**若任务需要多步执行，请立即调用 plan_write 提交执行流程**：每步含 desc（要做什么）与 criterion（可验证的达成标准——写明用哪个工具/哪类数据可证明完成），首个步骤置 doing；之后每轮按实测证据自行改写步骤状态（达成 criterion 的步骤改 done），有新证据/方向变化就再次调用 plan_write 整体修订并写明 reason。**确为单步/无需多步流程的简单任务**：调用 plan_write 传 steps:[] 明确声明，然后直接给出最终回答。引擎不再代你规划、也不自动推进步骤。" });
  }

  return { action: "continue" };
}

// 对抗性审查调度（方案_v4 P1+P2）：信号驱动——主循环每轮开头检查一次。
// 触发信号（全部结构化判定，无信号不触发，废除固定节拍+泛问空转）：
//   连续工具失败：最近 2 条工具结果均为结构化失败（isToolResultFailure：ok:false/稳定错误码/error 字段）
//   同参空转：连续 ≥5 次同工具同参调用（sameCallStreak）
//   计划停滞：执行流程有待办/进行步且连续 ≥3 轮无状态推进
// 上限 4 次/任务；用过工具才注入；与最终审查(selfReviewDone)/待回应互斥

const PLAN_WRITE = "plan_write"; // 主代理自持执行流程工具（todo 语义）：整表替换，引擎不代规划/不自动推进
const PLAN_STATUS_MAP = { todo: "todo", pending: "todo", doing: "doing", in_progress: "doing", done: "done", completed: "done" };

// 规范化 plan_write 的 steps（desc/criterion/status 状态白名单映射；step 序号自动重排）
function normalizePlanSteps(rawSteps) {
  const steps = [];
  if (!Array.isArray(rawSteps)) return steps;
  for (const s of rawSteps) {
    if (!s || typeof s !== "object") continue;
    const desc = String(s.desc || s.content || "").trim().substring(0, 220);
    if (!desc) continue;
    const criterion = String(s.criterion || s.criteria || "").trim().substring(0, 300);
    const rawStatus = String(s.status || (typeof s.state === "string" ? s.state : "")).toLowerCase();
    const status = PLAN_STATUS_MAP[rawStatus] || "todo";
    steps.push({ step: steps.length + 1, desc, criterion, status });
  }
  // 至少一个正在做/已完成，否则首个置 doing（与 todo 语义一致）
  if (steps.length && !steps.some(x => x.status === "doing" || x.status === "done")) steps[0].status = "doing";
  return steps;
}

// plan_write 执行（引擎侧应用）：整体替换 session.plan + 置 planCommitted 标记；
// 提交(init)/修订(revise)均留痕（快照 marker + 事件 + 实时 plan 事件 + 审计 + tool 结果回灌模型）
async function applyPlanWrite(ctx, toolCallId, args, round) {
  const { messages, session, onStatus } = ctx;
  const reason = String((args && args.reason) || "").trim().substring(0, 200);
  const steps = normalizePlanSteps(args && args.steps);
  if (!steps.length && (args && args.steps !== undefined && Array.isArray(args.steps) && args.steps.length === 0)) {
    // steps:[] = 主代理明确声明"本任务无需多步执行流程"
    const hadPlanBefore = Array.isArray(session.plan) && session.plan.length > 0;
    session.plan = [];
    session.planCommitted = true;
    if (hadPlanBefore) {
      recordPlanSnapshot(ctx, "revise");
      sessionEvent(session, { type: "plan", kind: "revise", steps: 0, descs: "声明无需多步执行流程" });
    }
    try { if (onStatus) onStatus({ type: "plan", plan: [], round }); } catch (e) {}
    if (hadPlanBefore) { try { if (onStatus) onStatus({ type: "plan_cleared", round }); } catch (e) {} } // 显式降级为"无需流程"：清掉旧流程卡，防残留
    addAudit({ tool: PLAN_WRITE, paramsSummary: reason || "声明简单任务", resultSummary: "已声明无需多步流程", approval: "auto" });
    appendTurnMessages(messages, { channel: "tool", tool_call_id: toolCallId, content: JSON.stringify({ ok: true, message: "已声明：本任务无需多步执行流程", steps: [] }) });
    return { ok: true, plan: [], message: "已声明：本任务无需多步执行流程" };
  }
  if (!steps.length) {
    const errMsg = "plan_write 参数无效：steps 必须为非空数组（多步流程）或空数组（声明简单任务）；每步需含 desc。收到：" + String(JSON.stringify(args || {})).substring(0, 200);
    appendTurnMessages(messages, { channel: "tool", tool_call_id: toolCallId, content: JSON.stringify({ error: errMsg }) });
    return { error: errMsg };
  }
  const hadPlan = Array.isArray(session.plan) && session.plan.length > 0;
  const oldKey = JSON.stringify((session.plan || []).map(q => q.step + "|" + q.status + "|" + q.desc + "|" + (q.criterion || "")));
  const newKey = JSON.stringify(steps.map(q => q.step + "|" + q.status + "|" + q.desc + "|" + (q.criterion || "")));
  const changed = oldKey !== newKey;
  session.plan = steps;
  session.planCommitted = true;
  const kind = hadPlan ? "revise" : "init";
  if (changed) {
    recordPlanSnapshot(ctx, kind); // 内容可见：轨迹 marker + events
    sessionEvent(session, { type: "plan", kind, steps: steps.length, descs: steps.map(q => q.desc).join(" | ").substring(0, 200) });
    try { flushSession(session); } catch (e) {} // 流程变化实时入库广播
  }
  try { if (onStatus) onStatus({ type: "plan", plan: steps, round }); } catch (e) {}
  addAudit({
    tool: PLAN_WRITE,
    paramsSummary: reason || (steps.length ? "提交执行流程（" + steps.length + " 步）" : ""),
    resultSummary: steps.length ? (hadPlan ? "已整体修订执行流程（" + steps.length + " 步）" : "已提交执行流程（" + steps.length + " 步）") : "已声明无需多步流程",
    approval: "auto"
  });
  const toolMsg = { ok: true, steps: steps.map(q => ({ step: q.step, desc: q.desc, status: q.status })), message: (hadPlan ? "执行流程已整体修订（reason: " + (reason || "未说明") + "）" : "执行流程已提交") + "（" + steps.length + " 步）。规则：达成某步 criterion 的实测证据出现后，再把该步状态改 done。" };
  appendTurnMessages(messages, { channel: "tool", tool_call_id: toolCallId, content: JSON.stringify(toolMsg) });
  return { ok: true, plan: steps, changed, message: toolMsg.message };
}

// ============ 方案_v4（P3/P5）：审查回应结算共用件 ============
// 落库“问题+回应”整对（_kind:"review" 回放标记）+ 会话事件 + review_reply 实时事件 + P5 replied 统计
function recordReviewAnswered(session, metaRound, reason, question, replyText, onStatus) {
  if (!session) return;
  pushReplayMark(session, "review", { round: metaRound, reason: String(reason || ""), question: String(question || ""), reply: String(replyText || "") });
  sessionEvent(session, { type: "review", round: metaRound, answered: true });
  session.reviewStats = session.reviewStats || { triggers: 0, byReason: {}, replied: 0 };
  session.reviewStats.replied = (session.reviewStats.replied || 0) + 1;
  try { if (onStatus) onStatus({ type: "review_reply", text: String(replyText || ""), round: metaRound }); } catch (e) {}
}
// 工具轮内结算（P3）：回应与工具同轮不丢轮——不追加 assistant 消息
// （M1 已把回应正文随 tool_calls 写入该轮 assistant），仅结算 pending + 落卡/事件
function settleReviewReplyForToolRound(ctx, textContent, out, round) {
  const { session, onStatus } = ctx;
  const meta = ctx.pendingReview || {};
  ctx.pendingReview = null;
  ctx.reviewPending = false;
  ctx.reviewMiss = 0;
  const metaRound = meta.round != null ? meta.round : round;
  const replyText = String(textContent || "").trim() || "（本轮未附带回应正文，工具调用照常执行）";
  recordReviewAnswered(session, metaRound, meta.reason || "", meta.question || "", replyText, onStatus);
  return metaRound;
}

function maybeTriggerAdversarial(ctx, round) {
  if (ctx.reviewPending || ctx.selfReviewDone || ctx.aborted) return;
  if (ctx.rebuttalChecks >= 4) return;
  if (!ctx.hasToolUseThisTask) return;
  const { session, messages, onStatus, userMessage } = ctx;
  const toolMsgs = messages.filter(m => m.role === "tool");
  if (!toolMsgs.length) return;

  // ===== P1+P2（方案_v4）：信号驱动 + 结构化失败判定 =====
  // 失败判定：解析归一化结果看 ok:false/稳定错误码/error 字段（isToolResultFailure），
  // 不再对整段文本跑正则（页面正文含 error/timeout 不等于失败；拒绝反馈单独归类不计失败）
  const failFlags = toolMsgs.map(m => isToolResultFailure(m && m.content));
  const tail2 = failFlags.slice(-2);
  const consecutiveFails = tail2.length >= 2 && tail2[0] === true && tail2[1] === true;
  // 同参空转（真实空转：连续同工具同参调用，reminder 已 3/5 提醒仍未停）
  const spinCount = ctx.sameCallStreak || 0;
  // 计划停滞：执行流程有待办/进行步且连续 N 轮无任何状态推进
  const undone = (session.plan || []).some(q => q.status === "todo" || q.status === "doing");
  const progressKey = (session.plan || []).map(q => q.status + "|" + q.step).join(",");
  if (ctx.planProgressKey === undefined || ctx.planProgressKey === null) { ctx.planProgressKey = progressKey; ctx.planStaleRounds = 0; }
  else if (progressKey !== ctx.planProgressKey) { ctx.planProgressKey = progressKey; ctx.planStaleRounds = 0; }
  else ctx.planStaleRounds = (ctx.planStaleRounds || 0) + 1;

  let reason = "";
  if (consecutiveFails) reason = "连续工具失败";
  else if (spinCount >= 5) reason = "同参重复空转";
  else if (undone && (ctx.planStaleRounds || 0) >= 3) reason = "计划停滞";
  // 无任何风险信号 → 不触发（方案_v4：删除“固定节拍 + 无目标泛问”的空转审查）
  if (!reason) return;

  ctx.rebuttalChecks++;
  const recentToolsSummary = toolMsgs.slice(-2).map(m => String(m.content || "").substring(0, 1200)).join("\n---\n");
  const planProgress = (session.plan || []).map(q => `${q.status === "done" ? "[x]" : q.status === "doing" ? "[●]" : "[ ]"} ${q.desc}`).join("\n");

  // 出题：只出本次真实信号命中项，杜绝泛问
  const targets = [];
  if (consecutiveFails) targets.push({ type: "tool_failure", question: "最近连续 2 次工具调用都是执行失败（结构化 ok:false / 稳定错误码）——失败模式说明什么？是目标本身不可达/不存在，还是参数或方法不对？下一步应换参数、换工具，还是改走另一条验证路径？（回应须引用失败结果原文）" });
  if (spinCount >= 5) targets.push({ type: "spin", question: `你已连续 ${spinCount} 次以相同参数调用同一工具——同参空转本身说明当前路径无效。请停下来说明：你期待什么新信息、为何前 ${spinCount} 次没拿到？下一步换成什么？（可以先用 plan_write 修订流程再继续）` });
  if (undone && (ctx.planStaleRounds || 0) >= 3) {
    const undoneSteps = (session.plan || []).filter(q => q.status === "todo" || q.status === "doing").slice(0, 2).map(q => q.desc).join("；");
    targets.push({ type: "plan_gap", question: `执行流程已 ${ctx.planStaleRounds} 轮没有任何推进（未完成步骤如：${undoneSteps || "略"}）——卡在哪一步？该步 criterion 需要什么实测数据才能达成、用哪个工具能拿到？还是流程本身需要 plan_write 修订？` });
  }

  const q = buildSelfReviewQuestion(session.goal || userMessage, planProgress, recentToolsSummary, reason, { toolCount: toolMsgs.length, targets });
  appendTurnMessages(messages, { channel: "internal", content: q });
  ctx.reviewPending = true;
  ctx.reviewMiss = 0;
  ctx.pendingReview = { round, reason, question: q }; // 回应到达时整对落库可见审查卡

  // P5 可观测：触发统计 + 轨迹事件
  session.reviewStats = session.reviewStats || { triggers: 0, byReason: {}, replied: 0 };
  session.reviewStats.triggers++;
  session.reviewStats.byReason[reason] = (session.reviewStats.byReason[reason] || 0) + 1;
  sessionEvent(session, { type: "review_trigger", round, reason });
  appendWorkspaceEntry(session.convId, { type: "decision", author: "main_model", content: `对抗性审查触发（${reason}）：代码检测风险点，要求用工具验证`, evidence: "信号：结构化工具失败/同参空转/计划停滞", status: "executing" });
  const ev = { type: "rebuttal", conclusion: `${reason}对抗性审查触发`, reason, round, evidence: "信号：结构化工具失败/同参空转/计划停滞（isToolResultFailure 结构化判定）", alternative: "风险点可能不成立——由主代理用工具实测回应", action: "主代理下一轮以「自我审查回应」格式用实测数据回应", question: q };
  if (typeof onStatus === "function") { onStatus(ev); } else { try { pushStatus(ev); } catch (e) {} }
}

// ============================================================
// 情况3：空输出
// 有思考无内容：截断 → 渐进降级（最多 2 次）/ 否则追问（最多 2 次）
// 真空转：连续 2 次 → 专家卡住救援（注入线索续跑）；3 次 → 终止
// ============================================================

async function handleEmptyOutput(ctx, out, round) {
  const { messages, config, onStatus, userMessage, session, abortController } = ctx;
  const hasReasoning = !!(out.reasoningBuf && out.reasoningBuf.trim());
  if (hasReasoning) {
    if (out.finishReason === "length") {
      if (ctx.lengthRetry < 2) {
        ctx.lengthRetry++;
        ctx.forceDirectAnswer = 2; // P0a：两档直切——截断即禁用思考（原第 1 次降 low 无效）
        if (onStatus) onStatus({ type: "thinking_text", text: "思考过长导致输出截断，已禁用思考重试...", round });
        console.warn(`[Agent] 输出截断(finish_reason=length)，reasoning ${out.reasoningBuf.length} 字符 / ${out.lastReasoningTokens} tokens，降级=disabled（第 ${ctx.lengthRetry} 次）`);
        appendTurnMessages(messages, { channel: "internal", content: "你的思考过程过长导致最终回答被截断。请降低思考深度，直接输出简洁的最终回答。" });
        return { action: "continue" };
      }
      return { action: "finish", answer: "模型输出多次被思考长度截断，已终止。请重试或简化问题。" };
    }
    if (ctx.reasoningRetry < 2) {
      ctx.reasoningRetry++;
      ctx.forceDirectAnswer = 2; // P0a：思考后未输出 → 直接禁用思考（原设 1 无效）
      if (onStatus) onStatus({ type: "thinking_text", text: "正在整理最终回答...", round });
      console.warn(`[Agent] 模型思考后未输出 content（reasoning ${out.reasoningBuf.length} 字符 / ${out.lastReasoningTokens} tokens），追问+禁用思考（第 ${ctx.reasoningRetry} 次）`);
      appendTurnMessages(messages, { channel: "internal", content: "你上一轮只思考没有输出任何内容。**立即行动**：调用工具验证当前问题，或直接基于已有数据输出最终回答。禁止继续空想。" });
      return { action: "continue" };
    }
    return { action: "finish", answer: "模型完成了分析但未生成回复文本，已终止。请重试或换一种问法。" };
  }
  // 真·空转
  ctx.emptyRounds++;
  console.warn(`[Agent] LLM 返回了空消息（第 ${ctx.emptyRounds} 次）`);
  // === 卡住门：连续 2 轮空转且用过工具 → 复核审计员介入（用最近数据给下一步，防直接终止） ===
  if (ctx.g.stuckExpert && ctx.emptyRounds === 2 && ctx.hasToolUseThisTask) {
    const lastTool = messages.filter(m => m.role === "tool").slice(-1)[0];
    const stuckData = lastTool ? String(lastTool.content || "").substring(0, 4000) : "";
    if (stuckData && taskState.expertCalls < 20) {
      const zh = "复核审计员";
      try {
        if (onStatus) onStatus({ type: "expert_start", expert: zh, tool: "卡住介入", round });
        const stuckResult = await runReviewAudit({
          goal: session.goal || userMessage,
          focus: "任务卡住了（模型连续空转）。请基于最近的真实数据给出可执行的下一步：主代理下一步应调用哪个只读工具验证什么，或应基于哪些已有证据直接收尾。",
          seedData: stuckData,
          config, signal: abortController.signal,
          onReasoning: (delta) => { if (onStatus) onStatus({ type: "expert_reasoning", expert: zh, delta, round }); }
        });
        if (onStatus) onStatus({ type: "expert_done", expert: zh, conclusion: stuckResult?.findings, confidence: stuckResult?.confidence, followup: stuckResult?.nextAction, round });
        if (stuckResult) {
          taskState.expertCalls++;
          pushReplayMark(session, "expert", { expert: zh, tool: "卡住介入", reasoning: String(stuckResult.reasoning || "").substring(0, 12000), findings: stuckResult.findings, evidence: stuckResult.evidence, nextAction: stuckResult.nextAction, confidence: stuckResult.confidence, verified: !!stuckResult.verified, toolTrail: stuckResult.toolTrail || [] });
          sessionEvent(session, { type: "expert_round", expert: zh, steps: stuckResult.steps || 0, verified: !!stuckResult.verified, tools: (stuckResult.toolTrail || []).map(t => t.tool).join(",") });
          appendTurnMessages(messages, { channel: "internal", content: "【卡住介入·复核审计员】任务连续空转。审计结论：" + (stuckResult.findings || "") + "\n建议下一步：" + (stuckResult.nextAction || "无") + "\n\n请按此继续推进，或基于已有数据直接回答。" });
          ctx.emptyRounds = 0;
          return { action: "continue" };
        }
      } catch (e) {
        console.warn("[Agent] 卡住介入复核失败: " + (e && e.message));
      }
    }
  }

  // 精简模式（无复核审计员介入）：空转第 2 次给轻提示继续，避免专家回合的成本
  if (!ctx.g.stuckExpert && ctx.emptyRounds === 2 && ctx.hasToolUseThisTask) {
    if (onStatus) onStatus({ type: "thinking_text", text: "连续空转（精简模式已跳过复核审计员）：请基于已有数据继续或收尾...", round });
    appendTurnMessages(messages, { channel: "internal", content: "连续两次空输出（精简模式未启用复核审计员）。请直接基于已获得的实测数据继续执行下一步，或输出最终结论；禁止继续空转。" });
    return { action: "continue" };
  }
  if (ctx.emptyRounds >= 3) return { action: "finish", answer: "模型连续未产生有效输出，已终止。请重试或换一种问法。" };
  return { action: "continue" };
}

// ============================================================
// 兜底总结：任务用了工具但模型未产出最终回答 → 再调一次 LLM 生成摘要
// ============================================================
async function fallbackSummary(ctx, onStatus) {
  const { messages, session, config, endpoint, abortController } = ctx;
  if (onStatus) onStatus({ type: "thinking_text", text: "正在生成总结...", round: 99 });
  appendTurnMessages(messages, { channel: "internal", content: "请根据上述所有工具返回的结果，用简洁的格式（## 分析结论 / ## 关键发现）输出一份最终报告。不要重复输出原始JSON数据。必须输出完整的文本内容作为最终回复，禁止只输出思考过程。" });
  let finalAnswer = "";
  try {
    let summaryBuf = "";
    for (let summaryTry = 0; summaryTry < 2 && !finalAnswer; summaryTry++) {
      const llmBody = {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, temperature: 0.3, max_tokens: 4096, stream: true })
      };
      summaryBuf = "";
      await llmCallWithRetry(() => {
        summaryBuf = "";
        return streamChatCompletion(endpoint, llmBody, ({ json, done }) => {
          if (done) return;
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            summaryBuf += delta.content;
            if (onStatus) onStatus({ type: "answer_delta", text: delta.content, round: 99 });
          }
        }, { signal: abortController.signal });
      }, { signal: abortController.signal });
      finalAnswer = summaryBuf;
      if (!finalAnswer && summaryTry === 0) {
        if (onStatus) onStatus({ type: "thinking_text", text: "模型未输出文本，强制重试中...", round: 99 });
        appendTurnMessages(messages, { channel: "internal", content: "你上一轮只输出了思考过程，没有输出回复文本。请直接输出对用户问题的最终文本回复（## 分析结论 / ## 关键发现 格式），现在必须输出。" });
      }
    }
    if (!finalAnswer) finalAnswer = "任务已执行（工具结果见上方），但模型多次未生成文本回复。";
    // 兜底文本收敛（黑板优化 A）：占位符/过短文本不作 finding 沉淀（避免污染黑板）；真实兜底结论才收敛沉淀
    if (ctx.hasToolUseThisTask && finalAnswer.length > 40 && !finalAnswer.startsWith("任务已执行（工具结果见上方）")) {
      appendWorkspaceEntry(session.convId, { type: "discovery", author: "main_model", content: finalAnswer.substring(0, 500), evidence: "任务最终结论（兜底总结，自动记录）", status: "confirmed" });
      await sinkFinalFact(session, finalAnswer, `finding|final-${Date.now().toString(36)}`);
    }
  } catch (e) {
    finalAnswer = `分析完成但生成摘要失败: ${e.message}`;
  }
  return finalAnswer;
}

// ============================================================
// 收尾：兜底总结 → 状态推送 → 持久化 → 工作区清理
// ============================================================
async function finalizeTask(ctx, finalAnswer, onStatus, endReason = "completed") {
  const { messages, session, abortController } = ctx;
  if (!finalAnswer) {
    if (ctx.aborted) {
      finalAnswer = "任务已被用户中止。";
    } else if (messages.some(m => m.role === "tool")) {
      finalAnswer = await fallbackSummary(ctx, onStatus);
    } else {
      finalAnswer = "模型未产生输出，请重试或换一种问法。";
    }
  }
  // 修复#3：流结束信号——panel 借此重渲染 markdown（live steering 续跑任务无 sendResponse 兜底，此为其唯一触发点）
  if (onStatus) onStatus({ type: "stream_end" });
  if (onStatus) onStatus({ type: "done", text: "完成" });
  if (taskState.abort === abortController) taskState.abort = null;

  // 持久化（实时同步收口）：执行中各轮已由 flushRunProgress/flushSession 增量落库并广播
  // conversation:changed；这里只补最后几轮未同步消息 + 最终回答（含思考，供历史回看）
  flushRunProgress(ctx);
  const lastM = session.messages[session.messages.length - 1];
  if (finalAnswer) {
    const dupLast = lastM && lastM.role === "assistant" && !lastM.tool_calls && lastM.content === finalAnswer;
    if (dupLast) {
      if (ctx.finalReasoning && !lastM.reasoning_content) lastM.reasoning_content = ctx.finalReasoning; // 审查终稿已随运行落库：补挂思考
    } else {
      session.messages.push({ role: "assistant", content: finalAnswer, ...(ctx.finalReasoning ? { reasoning_content: ctx.finalReasoning } : {}) });
    }
  }
  if (session.messages.length > 400) session.messages = session.messages.slice(-400);
  // 兜底清洗：防止异常路径把"缺 tool 响应"的非法序列写入历史（否则后续所有调用 400）
  session.messages = sanitizeMessageSequence(session.messages);
  sessionEvent(session, { type: "state", state: ctx.aborted ? "aborted" : "done", answer: (finalAnswer || "").substring(0, 80), endReason }); // P1：会话增量审计域（exit）；§3.2：终止条件枚举化
  // P3：任务收尾写入 checkpoint（自包含快照，供同目标续跑恢复上下文——方案 §8.2 fork/resume）
  if (session.goal && (ctx.aborted || finalAnswer)) {
    try { session.checkpoint = await buildCheckpoint(session, session.projectId || AI_PROJECT_ID); } catch (e) { console.warn("[Checkpoint] 构建失败:", e.message); }
  }
  await saveConversation(session);
  if (taskState.conv === session) taskState.conv = null;

  // === 工作区清理：当次任务结束，研讨记录即删（结论已沉淀黑板，过程不持久化） ===
  try { await chrome.storage.local.remove(`workspace:${session.convId}`); } catch (e) {}

  addAudit({ action: "任务结束", resultSummary: (finalAnswer || "").substring(0, 120), approval: "none", endReason });

  return { answer: finalAnswer, rounds: messages.filter(m => m.role === "assistant").length };
}

// ============================================================
// Agent 决策循环（主循环编排，原 800 行单函数的顶层）
// 每轮：暂停检查 → 预算裁剪 → 单轮调用 → 思考守卫 → 三分支路由 → 收尾
// ============================================================
export async function runAgentLoop(userMessage, onStatus, opts = {}) {
  const config = await getLLMConfig();
  if (!config.apiKey) return { error: "请先在设置中配置 LLM API Key（当前默认模型：model=" + (config.model || "?") + " @ " + (config.baseUrl || "空") + "；本地模型请在设置中填入 127.0.0.1/localhost 并保存，Key 可留空）" };
  const forceReplan = !!opts.forceReplan;
  const noThink = !!opts.noThink; // 禁思考：整个任务每轮 thinking:disabled（直接行动/作答）
  const thinkingLimit = opts.thinkingLimit || 0; // 思考硬上限（字符；0=不限）

  const endpoint = normalizeEndpoint(config.baseUrl);

  // 重置每任务计数器（UI 统计用）
  resetLLMCallCounter();
  resetGuards(); // 修复：守卫指纹去重门不跨任务共享（原模块级数组：任务B会误判任务A的数据"已分析"跳过专家）
  taskState.expertCalls = 0;
  taskState.config = config; // 供 executeToolCall（call_expert 需要 config）

  const abortController = new AbortController();
  taskState.abort = abortController;

  let session = await getActiveConversation();
  if (opts.convId) {
    // 指定会话：绑定该会话（否则走活跃会话/自动创建）
    const conv = await getConversation(opts.convId);
    if (!conv) return { action: "finish", answer: "会话不存在或已被删除", error: "会话不存在" };
    await setActiveConversation(conv.convId);
    session = conv;
  }
  taskState.conv = session; // upsert_fact/get_fact 定位黑板：会话绑定项目 → 项目黑板（跨会话共享）；未绑定 → AI 全局黑板
  _lastRunConvId = session.convId; // 记录运行归属（executeTask 收尾事件用）
  session.lastPromptTokens = 0; // 修复：lastPromptTokens 仅本轮预算有效——跨任务残留会让新任务首轮误触发预压缩
  const isNewSession = !session.messages || session.messages.length === 0;
  if (isNewSession || forceReplan) {
    session.goal = userMessage;
    if (!session.title || session.title === "新对话") session.title = userMessage.substring(0, 20);
  }

  session.runCount = (session.runCount || 0) + 1;
  session.type = "task"; // 站点会话列表区分任务/聊天（方案 4.1）
  const taskRun = session.runCount;
  if (onStatus) onStatus({ type: "task_start", run: taskRun, text: userMessage, model: config.model, expertModel: config.expertModel || null });
  addAudit({ action: "任务启动", target: userMessage.substring(0, 80), approval: "none" });
  sessionEvent(session, { type: "state", state: "task_start", run: taskRun }); // P1：会话增量审计域（enter）

  // 计划初始化条件：新会话/无计划/旧计划全 done（已完成的任务重新问 → 新任务应重做计划）
  // 或工具用过但计划全 todo（旧会话数据残留——从未真正执行过）
  const project = await getProject(session.projectId || AI_PROJECT_ID);
  const facts = project?.facts || [];
  const maxRounds = 300; // 预算裁剪保证上下文恒定，长任务可迭代数百次
  // DSH compaction-basic 同语义：窗口来自设置（默认 131072），压力阈值=0.8×窗口，保留尾部=0.16×窗口
  const ctxWindow = await readContextWindow();
  const pressureThreshold = Math.max(8192, Math.floor(ctxWindow * 0.8));
  const retainTail = Math.max(4096, Math.floor(ctxWindow * 0.16));

  const anchor = buildAnchorBlock(session, facts, debuggeeUrl);
  const ws = await getWorkspace(session.convId);
  const wsSummary = buildWorkspaceSummary(ws);
  const systemContentBase = await assembleSections({ anchor, wsSummary, skillsIndex: (await buildSkillsIndex("main_model")).replace(/^\n+/, "") });
  const guardProfile = await resolveGuardProfile(config.baseUrl);
  // 精简档：工具先行指令（本地小模型避免先长篇说明再动手的空转轮次；参照 ReAct/agent 延迟实践）
  const systemContent = guardProfile.mode === "lite"
    ? systemContentBase + "\n\n【精简模式】可以按需调用工具获取页面/网络/脚本数据（get_page_skeleton / search_dom / eval_js / get_network_requests 等）；若暂时拿不到数据，也可基于已知信息直接简要作答。避免长篇大论，直接给出有用回答。"
    : systemContentBase;
  // 历史载入时清洗：清除残留未配对 tool_calls/tool（API 400 根因）；排除"计划快照"记录（_kind:plan 仅供 UI 回看，不进 LLM）
  let histRaw = sanitizeMessageSequence((session.messages || []).filter(m => m && !(m._kind === "plan" || m._kind === "thinking" || m._kind === "expert" || m._kind === "review"))); // 展示标记不进 LLM 上下文
  // 压缩 checkpoint 之前的历史已被摘要覆盖（DSH surface 语义）——只需最近 checkpoint 之后的消息，
  // 压缩真正"一次生效并长期持有"，续跑/后续轮次不再重读全量旧历史
  let cpIdx = -1;
  for (let i = histRaw.length - 1; i >= 0; i--) { if (isCheckpointMessage(histRaw[i])) { cpIdx = i; break; } }
  const history = cpIdx >= 0 ? sanitizeMessageSequence(histRaw.slice(cpIdx + 1)) : histRaw;
  // P3：续跑恢复——同目标重新发起任务时，注入上次中断的自包含快照（方案 §8.2 fork/resume）
  // 判定：本会话存在 checkpoint 且用户消息与 checkpoint.goal 一致 → 视为"从断点续跑"
  // （直接对比 checkpoint.goal 而非 session.goal——isNewSession 时 session.goal 已被覆盖为新消息，会误判恒真）
  // 注入方式：以 _sys:true user 消息置于历史之后（模型先看到快照再收到新指令，自行核对并继续推进——不强制修订执行流程，避免丢失已完成步骤标记）
  const resumeCP = session.checkpoint?.goal && userMessage.trim() === session.checkpoint.goal.trim() ? session.checkpoint : null;
  if (resumeCP) {
    appendTurnMessages(history, { channel: "internal", content: renderCheckpoint(resumeCP) }); // §3.2：内部注入统一入口（_sys 自动标记）
    sessionEvent(session, { type: "resume", goal: String(session.goal || "").substring(0, 80) });
  }
  const messages = [ {role:"system", content: systemContent}, ...history ];
  const userTurnMsg = appendTurnMessages(messages, { channel: "user", content: userMessage }); // §3.2：用户消息统一入口
  session.messages.push({ ...userTurnMsg }); // 记录即时可见（带 _seq——flush 水位据此去重，防双写）
  const historyStartIdx = messages.length;
  flushSession(session, { force: true }); // 新任务即刻入库 + 广播（会话列表/记录首屏不再等任务结束）

  if (onStatus) onStatus({ type: "thinking_text", text: "正在分析当前页面...", round: 0 });


  // 循环状态（决策循环的全部可变标记收口于此，替代原十几个散落布尔）
  const ctx = {
    session, config, endpoint, messages, onStatus, userMessage, facts,
    abortController,
    historyStartIdx,
    aborted: false,
    hasToolUseThisTask: false,
    lastToolName: null, // 最近实际使用的工具（卡住救援按此选专家）
    planDriftWarnings: 0,
    emptyRounds: 0,
    reasoningRetry: 0,
    rebuttalChecks: 0,
    finalConfirmRetry: 0,
    selfReviewDone: false,
    pendingFinalAnswer: "",
    forceDirectAnswer: noThink ? 2 : 0, // 禁思考时恒为 2（thinking:disabled）
    noThink,
    thinkingLimit,
    lengthRetry: 0,
    thinkRetry: 0,
    idleChain: 0, // 防空想：连续只推理不产出轮数（有产出即清零）
    guessRetry: 0,
    unverifiedClaimWarnings: 0,
    probeRefusal: 0, // 强制先探测：未用工具就收尾的正文最多拦 2 次（探测失败也允许收尾，防死循环）
    reviewMiss: 0,   // 对抗性审查回应未按格式次数（≤2 后按回应接收）
    pendingReview: null, // 当前待回应的对抗性审查元信息 {round, reason, question}——回应时用于落库可见审查对
    planWriteHinted: false, // 探测后是否已提示主代理提交执行流程（一次）
    planFinalWarn: 0,    // 收尾前未提交执行流程的拦截次数（≤1）
    planProgressKey: null,  // P2（方案_v4）：计划推进指纹——判定“计划停滞”
    planStaleRounds: 0,     // P2（方案_v4）：计划连续未推进轮数（≥3 且有待办/进行步 → 计划停滞信号）
    finalPushed: false,
    reviewPending: false,
    finalAnswer: "",
    finalReviewCount: 0, // 最终独立复核次数（≤1 次补验，防死循环）
    seqHigh: Math.max(0, ...(session.messages || []).map(m => m._seq || 0)), // 实时同步水位：从已持久化会话的最大 _seq 起算（修复：原每任务从 0 起算导致续跑整段历史重抄+user双写）
    finalReasoning: "", // 最终回答附带的思考（持久化 + 历史回看可见）
    // P1：重复工具提醒状态（方案 §9.2）
    sameCallStreak: 0,
    lastCallKey: null,
    duplicateRemindedAt: new Set(),
    textOnlyChain: 0, // 连续“仅文本无工具且被要求继续”的轮数（防正文被无限吞→收尾放行）
    g: guardProfile // 机制档位（lite 精简 / full 完整）
  };

  // 精简档提示一次（可见性：聊天流一行说明当前为何跳过云端机制）
  if (guardProfile.mode === "lite") {
    try { if (onStatus) onStatus({ type: "agent_mode", text: "精简模式（本地模型自动启用）：已关闭 对抗性审查/专家复核/强制探测/plan 硬门 等云端机制" }); } catch (e) {}
  }

  let finalAnswer = "";
  let overflowRetried = false; // P2b：溢出触发强制压缩上限 1 次（原 __retried 挂数组对象——压缩返回新数组会丢失标记）
  // §3.2：终止条件枚举化——散落 return/break 收口为单一 endReason（'completed'|'rejected'|'aborted'|'interrupted'|'max_rounds'|'error'）
  let endReason = "max_rounds";

  // P2b 压缩收口（DSH 完整形态）：①写回 ctx.messages→压缩一次生效、后续轮次真正使用压缩结果；
  // ②checkpoint 消息抄入会话记录落库（压缩摘要成为记录中的可折叠项）；③事件留痕；④UI 推送可展开压缩项
  const applyCompactionResult = (compactedArr, method, info, trigger, at) => {
    if (!method) return; // 未真正触发压缩（预算内）→ 不写事件
    if (compactedArr && compactedArr !== ctx.messages) ctx.messages = compactedArr;
    sessionEvent(session, { type: "compaction", method, trigger, at: at || 0, ...(info && info.compactionId ? { compactionId: info.compactionId } : {}) });
    if (method === "summary" && info) {
      sessionEvent(session, { type: "compaction_summary", compactionId: info.compactionId, droppedRounds: info.droppedRounds || 0, droppedItems: info.droppedItems || 0, droppedTokens: info.droppedTokens || 0, summaryTokens: info.summaryTokens || 0 });
      const cp = (compactedArr || []).find(m => isCheckpointMessage(m));
      if (cp && !cp._seq) cp._seq = ++msgSeqCounter; // 打水位标，供 flushRunProgress 抄入记录
      flushRunProgress(ctx); // checkpoint 落库
      try { if (onStatus) onStatus({ type: "ai:compaction_done", ...info }); } catch (e) {}
    }
    flushSession(session); // 广播 conversation:changed → 面板实时刷新记录/轨迹
  };

  for (let round = 0; round < maxRounds; round++) {
    if (taskState.paused) { finalAnswer = "任务已被用户暂停"; endReason = "aborted"; break; }
    // 实时同步：上一轮产生的消息/事件/计划抄入会话记录并落库广播（节流）——会话记录边跑边刷
    if (round > 0) {
      flushRunProgress(ctx); flushSession(session);
      if (ctx.g.adversarial) maybeTriggerAdversarial(ctx, round); // 方案_v4：信号驱动对抗审查（lite 关闭）
    }
    if (onStatus) onStatus({ type: "round", round: round + 1, max: maxRounds, toolUse: ctx.hasToolUseThisTask, llmCalls: llmCallCounter });

    // 第二层：预算裁剪（DSH compaction-basic 同语义）——
    // 触发=估算或上轮真实 prompt_tokens > 0.8×窗口；先确定性裁剪大工具结果（对齐 ToolResultPruner，
    // 可能无摘要即回落），仍超阈才走 LLM 摘要（保留尾部 0.16×窗口）；压后仍超阈可二次压缩（对齐 compactionRetries）
    let messagesForCall = ctx.messages;
    const estTokens = messagesForCall.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
    const realPromptTokens = session.lastPromptTokens || 0;
    if (estTokens > pressureThreshold || realPromptTokens > pressureThreshold) {
      const pruned = pruneToolResults(messagesForCall, { budgetChars: 4000, protectRecentTools: 3 });
      if (pruned.changed) {
        messagesForCall = pruned.messages;
        try { persistSessionMessageContent(ctx, messagesForCall); } catch (e) {}
        try { flushSession(session); } catch (e) {}
      }
      let curEst = messagesForCall.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
      let realCur = session.lastPromptTokens || 0;
      let everSummarized = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!(curEst > pressureThreshold || realCur > pressureThreshold)) break;
        if (attempt === 0 && onStatus) onStatus({ type: "ai:compaction", trigger: "pressure", at: Math.round(curEst) }); // §十一：压缩进度（stream）
        let compMethod = null, compInfo = null;
        messagesForCall = await compactionWithSummary(messagesForCall, {
          config, endpoint, systemContent,
          maxTokens: pressureThreshold, retainTokens: retainTail, summaryMaxTokens: 8192,
          force: realCur > pressureThreshold,
          signal: abortController.signal,
          onCompacted: (method, info) => { compMethod = method; compInfo = info || null; }
        });
        applyCompactionResult(messagesForCall, compMethod, compInfo, "pressure", Math.round(curEst));
        if (!compMethod) break; // 无可压区间（单轮超大等）→ 停止
        everSummarized = true;
        curEst = messagesForCall.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
        realCur = 0; // 本轮尚无新请求：真实 usage 下一轮才更新——二次压缩只看压缩后估算，防陈旧真实值重复压
        if (curEst > pressureThreshold) {
          // 一次压缩后仍超阈（罕见：超大单轮/保留尾部仍大）→ 更激进：放宽保护再裁（对齐 compactionRetries）
          messagesForCall = pruneToolResults(messagesForCall, { budgetChars: 2000, protectRecentTools: 1 }).messages;
          curEst = messagesForCall.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
        }
      }
      if (pruned.changed && !everSummarized) {
        console.warn(`[Agent] compaction 裁剪即回落（est ${Math.round(curEst)} ≤ ${pressureThreshold}，real ${realCur}）——无摘要推进（对齐 DSH ToolResultPruner）`);
      }
      if (messagesForCall !== ctx.messages) ctx.messages = messagesForCall; // 裁剪/压缩结果长期生效（含续跑）
    }

    if (onStatus) onStatus({ type: "thinking_text", text: ctx.noThink ? `第 ${round + 1} 轮执行（已禁思考）...` : `第 ${round + 1} 轮思考...`, round });

    let out;
    try {
      out = await streamOneRound({ endpoint, config, messagesForCall, forceDirectAnswer: ctx.forceDirectAnswer, session, signal: abortController.signal, onStatus, round, thinkingLimit, toolDefs: toolDefsForMode(ctx.g, TOOL_DEFINITIONS) });
    } catch (e) {
      if (e.name === "AbortError" || abortController.signal.aborted) { ctx.aborted = true; endReason = "aborted"; break; }
      // 上下文溢出（usage 校准未兜住的场景）→ P2b 溢出触发：强制压缩并重试一次（上限 1 次）
      if (e.contextOverflow && !overflowRetried) {
        overflowRetried = true;
        if (onStatus) onStatus({ type: "ai:compaction", trigger: "overflow" }); // §十一：压缩进度（stream）
        // DSH 同语义：provider 确认溢出可绕过常规阈值/保留策略（maxOverflowRetries）——强制、保留更少尾部
        let compMethod = null, compInfo = null;
        messagesForCall = await compactionWithSummary(messagesForCall, {
          config, endpoint, systemContent,
          maxTokens: Math.max(8192, Math.floor(pressureThreshold * 0.9)),
          retainTokens: Math.max(2048, Math.floor(retainTail * 0.5)),
          summaryMaxTokens: 8192, force: true,
          signal: abortController.signal,
          onCompacted: (method, info) => { compMethod = method; compInfo = info || null; }
        });
        applyCompactionResult(messagesForCall, compMethod, compInfo, "overflow", 0);
        console.warn(`[Agent] 上下文溢出——已强制裁剪（${messagesForCall.length} 条消息，保留尾部 ${Math.floor(retainTail * 0.5)}t）重试`);
        round--;
        continue;
      }
      endReason = "error";
      sessionEvent(session, { type: "state", state: "error", code: normalizeError(e).code }); // §3.2：终止条件枚举化（LLM 调用失败）
      // 修复（审读高4）：错误也走 finalizeTask 收口——原裸 return 绕过收尾：
      // 无终态审计/不落库/不清理 abort 与 conv/上层把 error 文本当成功 answer 上报
      await pushStatus({ type: "ai:error", code: normalizeError(e).code, error: e.message });
      finalAnswer = `LLM 调用失败：${e.message}`;
      break;
    }
    ctx.forceDirectAnswer = ctx.noThink ? 2 : 0; // 每轮重置；禁思考时恒为 2（thinking:disabled）

    if (ctx.g.overthink) applyThinkingGuards(ctx, out, onStatus, round); // 防空想/乱猜两档直切（lite 关闭）

    if (out.reasoningStarted && onStatus) onStatus({ type: "reasoning_end", round });
    // 修复：纯思考/纯文本轮（无工具调用）的思考过程落"thinking"回放标记——否则该轮思考只在内存、
    // 刷新/重开会话即丢失（工具轮的思考已随 assistant 消息的 reasoning_content 落库）
    if (out.reasoningBuf && out.reasoningBuf.trim() && !out.toolCalls.length && !(out.contentBuf && String(out.contentBuf).trim())) {
      // 仅纯思考轮（无正文无工具）落标记——有正文/工具的轮次其思考已随 assistant reasoning_content 持久化，避免重放重复
      pushReplayMark(session, "thinking", { round, reasoning: out.reasoningBuf.trim().substring(0, 12000) });
    }

    const textContent = (out.contentBuf || "").trim();
    if (opts.debug) console.log(`[F12xDiag] round=${round} finishReason=${out.finishReason} contentLen=${(out.contentBuf || "").length} reasoningLen=${(out.reasoningBuf || "").length} toolCalls=${out.toolCalls.length} forceDirectAnswer=${ctx.forceDirectAnswer}`);

    // 修复（审读中1）：finish_reason=length（输出被 max_tokens 截断）——禁止把半截内容当最终回答推送
    if (out.finishReason === "length" && out.toolCalls.length === 0) {
      if (ctx.lengthRetry < 2) {
        ctx.lengthRetry++;
        ctx.forceDirectAnswer = 2; // 截断即禁用思考重试
        if (onStatus) onStatus({ type: "thinking_text", text: "输出被截断，已禁用思考重试（防半截答案）...", round });
        appendTurnMessages(messages, { channel: "internal", content: "你上一轮的输出因超长被截断。请降低篇幅，把结论分段、精炼输出（可多次短回复），不要一次性输出超长文本。" });
        continue;
      }
      // 多次截断仍无完整输出 → 允许以现有内容收尾（有内容总比丢弃好）
      if (onStatus) onStatus({ type: "thinking_text", text: "输出多次被截断，已按现有内容收尾...", round });
    }
    // 情况1：纯文本无工具调用 → 候选最终回答（finish_reason=length 已被上面分支拦下）
    if (out.finishReason !== "length" && (out.finishReason === "stop" || (textContent && out.toolCalls.length === 0)) && textContent) {
      const directive = await handleTextAnswer(ctx, textContent, out, round);
      if (directive.action === "continue") {
        // 正文被拒放行兜底：本地小模型反复只给说明文字（无工具/不达收尾标准）时，
        // 文本轮会被 continue 吞掉、UI 只见“第 N 轮思考”——连续 ≥5 次后按当前内容收尾，防无限空转
        ctx.textOnlyChain = (ctx.textOnlyChain || 0) + 1;
        if (ctx.textOnlyChain >= 5) {
          if (onStatus) onStatus({ type: "thinking_text", text: "连续多轮仅输出说明文字，已按当前内容收尾…", round });
          if (onStatus) onStatus({ type: "answer_delta", text: textContent, round });
          ctx.finalAnswer = textContent;
          finalAnswer = textContent;
          endReason = "completed";
          break;
        }
        continue;
      }
      finalAnswer = directive.answer ?? ctx.finalAnswer;
      endReason = "completed";
      break;
    }

    // 情况2：工具调用（executeToolCall 已封装所有工具 + 研讨注入）
    if (out.toolCalls.length > 0) {
      // 工具轮的正文此前只入历史、从未上屏（"正在生成正文(190字)"却看不到）——按发生时刻就地推送为正文段
      if (textContent && onStatus) onStatus({ type: "answer_delta", text: textContent, round });
      const directive = await handleToolCalls(ctx, out, round);
      if (directive.action === "continue") continue;
      endReason = "interrupted"; // 被中止——最终回答由兜底逻辑产生
      break;
    }

    // 情况3：空输出（截断降级 / 追问 / 卡住救援 / 终止）
      const directive = await handleEmptyOutput(ctx, out, round);
    if (directive.action === "continue") continue;
    finalAnswer = directive.answer;
    endReason = "error"; // 多次截断/思考未输出/真空转终止
    break;
  }

  return finalizeTask(ctx, finalAnswer, onStatus, endReason);
}

// ============================================================
// 任务执行统一入口（意图分类 + 路由；live steering 排队续跑也走这里）
// ============================================================
export async function executeTask(text, isSteer = false, onStatus = null, convId = null, forcedMode = null, noThink = false) {
  taskState.paused = false; // 新指令重置暂停/中止状态
  const config = await getLLMConfig();
  if (!config.apiKey) {
    taskState.lastTaskReply = "请先在设置中配置 LLM API Key（当前默认模型：model=" + (config.model || "?") + " @ " + (config.baseUrl || "空") + "；本地模型请在设置中填入 127.0.0.1/localhost 并保存，Key 可留空）";
    taskState.lastTaskRounds = 0;
    return;
  }
  // 任务模式 / 对话模式（前端独立按钮自主选择）：forcedMode 直选，跳过 LLM 意图分类（省一次调用且意图确定）
  const thinkingLimit = await readThinkingLimit(); // 思考硬上限（storage 设置；0=不限）
  const fm = forcedMode === "task" || forcedMode === "chat" ? forcedMode : null;
  const intent = fm || (await classifyIntent(config, text)) || fallbackIntent(text);
  // 状态转发：pushStatus 广播到面板（stream 通道）；onStatus 兼容遗留 content 回调
  const emit = (st) => { pushStatus(st); if (typeof onStatus === "function") onStatus(st); };

  if (intent === "chat") {
    // 记录到会话：指定 convId → 写入该会话；否则活跃会话（先落用户消息，流式回答前即可见——实时同步）
    let session = null;
    if (convId) {
      session = await getConversation(convId);
      if (session) await setActiveConversation(convId);
    } else session = await getActiveConversation();
    // 上下文关联（修复：暂停/中断后追问进展，模型因看不到工具结果与原始目标而失忆）——
    // 若本会话已有过任务（工具历史），把"目标+计划+最近工具实测+最近结论"摘要随消息注入
    let progressNote = "";
    if (session && (session.messages || []).some(m => m && m.role === "tool")) {
      progressNote = taskDigest(session);
    }
    if (session) {
      session.messages.push({ role: "user", content: text });
      await saveConversation(session);
      _lastRunConvId = session.convId; // 记录运行归属（chat 路径收尾事件带 convId）
      try { pushStatus({ type: "conversation:changed", convId: session.convId, ts: Date.now() }); } catch (e) {}
    }
    // 捕获思考流，随 assistant 消息持久化（问题1：聊天回看同样可见思考）
    let chatReasoning = "";
    const chatEmit = (st) => {
      if (st && st.type === "reasoning_delta" && st.text) chatReasoning += st.text;
      emit(st);
    };
    const reply = await runChat(config, text, chatEmit, {
      setAbort: (c) => { taskState.abort = c; },
      setPaused: (v) => { taskState.paused = v; },
      noThink: !!noThink,
      thinkingLimit,
      progressNote
    });
    if (session) {
      session.messages.push({ role: "assistant", content: reply, ...(chatReasoning ? { reasoning_content: chatReasoning } : {}) });
      await saveConversation(session);
      try { pushStatus({ type: "conversation:changed", convId: session.convId, ts: Date.now() }); } catch (e) {}
    }
    emit({ type: "stream_end", convId: _lastRunConvId }); // 修复#3：流结束 → panel 重渲染 markdown（chat 路径）
    await emit({ status: "done", detail: "完成", convId: _lastRunConvId });
    taskState.lastTaskReply = reply;
    taskState.lastTaskRounds = 1;
    return;
  }

  // 任务路径：attach + 完整 Agent 引擎
  resetNetworkRequests();
  resetConsoleLogs();
  resetScriptList();
  await debuggerAttach();
  // 方案 3.2：AI 任务与拦截互斥——任务启动强制关闭拦截、结束恢复用户模式
  // （避免任务中同源 replay 被 Fetch 域拦截卡入待处理队列；任务中用户手动开拦截=接管由 14.7① 处理）
  if (appState.interceptMode !== "off") {
    taskState.interceptBefore = appState.interceptMode;
    try { await interceptSetMode("off"); } catch (e) {}
    pushStatus({ status: "running", text: `已强制关闭拦截（任务前用户模式：${taskState.interceptBefore}），任务结束恢复` });
  }
  const result = await runAgentLoop(text, emit, { forceReplan: isSteer, convId, noThink: !!noThink, thinkingLimit });
  await emit({ status: "done", detail: "完成", convId: _lastRunConvId });
  await debuggerDetach();
  await restoreIntercept();
  taskState.lastTaskReply = result.answer || result.error;
  taskState.lastTaskRounds = result.rounds || 0;
}

// 任务结束恢复用户拦截模式（方案 3.2：启动强制关、结束恢复）
async function restoreIntercept() {
  if (taskState.interceptBefore) {
    try { await interceptSetMode(taskState.interceptBefore); } catch (e) {}
    taskState.interceptBefore = null;
  }
}

// ============================================================
// "task" 消息处理（live steering：任务中新指令 → 中止当前 + 排队续跑）
// ============================================================
export function handleTaskMessage(message, sendResponse, onStatus = null) {
  // 前端模式按钮显式指定的执行模式（"task"=任务模式可自主调用工具，"chat"=对话模式仅问答），续跑沿用
  const runMode = message.mode === "task" || message.mode === "chat" ? message.mode : null;
  const noThink = !!message.noThink; // 禁思考开关：随本条消息下发，续跑沿用
  taskState.noThinkLast = noThink;
  if (taskState.taskRunning) {
    taskState.pendingTask = message.text;
    taskState.pendingNoThink = noThink;
    if (taskState.abort) taskState.abort.abort();
    taskState.paused = true;
    abortPendingApproval("用户已打断（新指令优先）"); // 修复：steering 立即放行批准闸门（原漏调，最长空等 120s）
    sendResponse({ ok: false, error: "steering", reply: "已打断，新指令将立即执行" });
    return;
  }
  taskState.taskRunning = true;
  (async () => {
    try {
      await executeTask(message.text, false, onStatus, message.convId || null, runMode, noThink);
      sendResponse({ ok: true, reply: taskState.lastTaskReply || "", rounds: taskState.lastTaskRounds });
    } catch (e) {
      await debuggerDetach().catch(() => {});
      await restoreIntercept();
      pushStatus({ type: "stream_end" }); // 修复#3：先渲染已流式内容再显示错误
      await pushStatus({ type: "ai:error", code: normalizeError(e).code, error: e.message, convId: _lastRunConvId }); // §十一：ai:error 统一带稳定码
      sendResponse({ ok: false, error: e.message, code: normalizeError(e).code });
    } finally {
      taskState.taskRunning = false;
      if (taskState.pendingTask) {
        const next = taskState.pendingTask;
        const nextNoThink = taskState.pendingNoThink || false;
        taskState.pendingTask = null;
        taskState.pendingNoThink = null;
        taskState.taskRunning = true;
        try {
          await executeTask(next, true, onStatus, null, runMode, nextNoThink);
        } catch (e) {
          await debuggerDetach().catch(() => {});
          await restoreIntercept();
          pushStatus({ type: "stream_end" }); // 修复#3：先渲染已流式内容再显示错误
          await pushStatus({ type: "ai:error", code: normalizeError(e).code, error: e.message, convId: _lastRunConvId }); // §十一：ai:error 统一带稳定码
        } finally {
          taskState.taskRunning = false;
        }
      }
      taskState.tabId = null; // 任务链完全结束（含续跑）→ 清除发起 tab 归属
    }
  })();
}

// --- 任务暂停 / 恢复 ---
export async function pauseTask() {
  if (debuggee) {
    if (taskState.abort) {
      try { taskState.abort.abort(); } catch (e) { /* 忽略 */ }
    }
    taskState.paused = true; // 修复#9：先置 paused 再 detach（onDetach 监听据此识别暂停的主动断开，不误判为意外断开）
    abortPendingApproval("用户已暂停/接管任务"); // 5.1：批准等待立即按拒绝放行（写操作绝不自动批准）
    resetNetworkRequests();
    resetConsoleLogs();
    resetScriptList();
    await debuggerDetach();
    await restoreIntercept(); // 暂停=用户接管：恢复用户拦截模式
    return { ok: true, status: "paused", warning: "已暂停。LLM 调用已中止，网络/日志/脚本收集器已清空（数据隔离），恢复后重新采集。" };
  }
  return { ok: false, error: "当前无活跃任务" };
}

export async function resumeTask() {
  if (!taskState.paused) return { ok: false, error: "当前未暂停" };
  taskState.paused = false;
  try {
    await debuggerAttach();
    // 接管后恢复（方案 3.2：ai:resume → 重新侦察页面 → 续跑原任务，steering 机制续跑）
    const goal = taskState.conv?.goal;
    if (goal) {
      const text = `（用户已接管并完成手动操作）请重新侦察当前页面状态（get_page_skeleton / get_network_requests / get_console_logs），基于最新状态继续完成原任务：${goal}`;
      taskState.taskRunning = true;
      (async () => {
        try {
          // resume = 续跑原任务 → 强制任务模式（自主调用工具继续侦察执行）；沿用当时的禁思考设置
          await executeTask(text, true, null, null, "task", !!taskState.noThinkLast);
        } catch (e) {
          await debuggerDetach().catch(() => {});
          pushStatus({ type: "stream_end" });
          await pushStatus({ status: "error", detail: e.message });
        } finally {
          taskState.taskRunning = false;
        }
      })();
      return { ok: true, status: "resumed", note: "已重新侦察页面并续跑原任务" };
    }
    return { ok: true, status: "resumed" };
  } catch (e) {
    taskState.paused = true;
    return { ok: false, error: `恢复失败: ${e.message}` };
  }
}
