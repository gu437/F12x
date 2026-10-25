// ============================================================
// F12x executor 模块：Agent 工具调度器（原 background.js 的 executeToolCall，纯搬移）
// 职责：把 LLM 的 tool_call 路由到 debugger/memory/experts/plan 各模块的实际工具
// 重命名映射：agentConfig→taskState.config / currentConv→taskState.conv /
//            currentAbortController→taskState.abort / taskExpertCalls→taskState.expertCalls /
//            agentPort→taskState.port
// ============================================================
import {
  get_page_skeleton, eval_js, search_dom, get_network_requests, get_network_request_detail, get_cookies,
  get_script_list, get_script_content, navigate, get_console_logs, replay_request, highlight_element,
  screenshot, showPageIndicator, decode_text, compare_responses, intruder
} from "./debugger.js";
import { normalizeEndpoint } from "./llm.js";
import {
  upsertFact, getFact, publishToBlackboard, appendWorkspaceEntry, updateWorkspaceEntry, getWorkspace,
  getRoleSkills, saveConversation, AI_PROJECT_ID, spillKey, recordSpillKey
} from "./memory.js";
import { normalizeError, normalizeToolResult, F12X_ERROR_CODES } from "./errors.js";
import { runReviewAudit, TOOL_NAMES_CN } from "./experts.js";
import { taskState, pushStatus } from "./state.js";
// 循环引用注意：addAudit 为函数声明（模块实例化期即绑定），仅运行时调用，agent↔executor 环安全
import { addAudit, sessionEvent } from "./agent.js";

// ============================================================
// P1：工具注册表（方案_v2 §6.2）——元数据声明 + 统一入口 dispatchTool
// 每条目：timeoutMs（默认 30s，任务级工具 300s）| manualAllowed（手动可用性）
//         | interruptible（底层可中断性——超时可真停，非"放虎归山"）
//         | level（沿用 G1/G2/G3 批准分级，与 agent.js classifyLevel 一致）
//         | params（轻量校验：required / types / enums，不学全套 JSON Schema）
// 执行体仍是下方 switch（executeToolInner），本表只做闸门元数据。
// ============================================================
// P1 工具注册表（§6.2）：export 供可观测性/验证（dispatchTool 单入口分发）
export const TOOL_REGISTRY = new Map();
function registerTool(spec) { TOOL_REGISTRY.set(spec.name, spec); }
function T(over) { return { timeoutMs: 30000, manualAllowed: false, interruptible: false, level: "g2", params: { types: {} }, ...over }; }

registerTool(T({ name: "get_page_skeleton", manualAllowed: true, level: "g1" }));
registerTool(T({ name: "search_dom", manualAllowed: true, level: "g1", params: { required: ["selector"], types: { selector: "string" } } }));
registerTool(T({ name: "get_network_requests", manualAllowed: true, level: "g1", params: { types: { filter: "object", limit: "number" } } }));
registerTool(T({ name: "get_network_request_detail", manualAllowed: true, level: "g1", params: { required: ["id"], types: { id: "string", offset: "number", limit: "number" } } }));
registerTool(T({ name: "get_cookies", manualAllowed: true, level: "g1", params: { types: { includeValues: "boolean", urls: "array" } } }));
registerTool(T({ name: "eval_js", manualAllowed: true, params: { required: ["code"], types: { code: "string", allow_tools: "array", executionWorld: "string" }, enums: { executionWorld: ["main", "isolated"] } } }));
registerTool(T({ name: "get_script_list", manualAllowed: true, level: "g1" }));
registerTool(T({ name: "get_script_content", manualAllowed: true, level: "g1", timeoutMs: 60000, params: { required: ["url"], types: { url: "string", startLine: "number", endLine: "number", grep: "string", limit: "number" } } }));
registerTool(T({ name: "navigate", manualAllowed: true, timeoutMs: 60000, params: { required: ["url"], types: { url: "string" } } }));
registerTool(T({ name: "get_console_logs", manualAllowed: true, level: "g1", params: { types: { level: "string", limit: "number" }, enums: { level: ["log", "warning", "error", "info", "debug", "exception"] } } }));
registerTool(T({ name: "replay_request", manualAllowed: true, params: { required: ["url"], types: { url: "string", method: "string", headers: "object", body: "string" } } }));
registerTool(T({ name: "highlight_element", manualAllowed: true, level: "g1", params: { required: ["selector"], types: { selector: "string" } } }));
registerTool(T({ name: "screenshot", manualAllowed: true, level: "g1", params: { types: { fullPage: "boolean" } } }));
registerTool(T({ name: "decode_text", manualAllowed: true, level: "g1", params: { required: ["text", "mode"], types: { text: "string", mode: "string" }, enums: { mode: ["base64_encode", "base64_decode", "url_encode", "url_decode", "hex_encode", "hex_decode"] } } }));
registerTool(T({ name: "compare_responses", manualAllowed: true, level: "g1", params: { required: ["a", "b"], types: { a: "string", b: "string" } } }));
registerTool(T({ name: "intruder", manualAllowed: true, timeoutMs: 300000, interruptible: true, params: { required: ["url", "payloads"], types: { url: "string", method: "string", headers: "object", body: "string", payloads: "array", concurrency: "number", headerInject: "string", includeBody: "boolean", limit: "number", rateLimitMs: "number" } } }));
registerTool(T({ name: "upsert_fact", params: { required: ["key", "summary"], types: { key: "string", summary: "string", body: "string", confidence: "string" } } }));
registerTool(T({ name: "get_fact", level: "g1", params: { required: ["key"], types: { key: "string" } } }));
registerTool(T({ name: "rebuttal_check", level: "g1", params: { types: { conclusion: "string", evidence: "string", alternative: "string", action: "string" } } }));
registerTool(T({ name: "workspace_note", params: { required: ["content"], types: { type: "string", content: "string", evidence: "string", to: "string" } } }));
registerTool(T({ name: "call_expert", level: "g1", params: { required: ["focus"], types: { focus: "string", question: "string", data: "string" } } })); // 收敛版 A：call_expert=请求复核审计员
registerTool(T({ name: "get_skill", level: "g1", params: { required: ["name"], types: { name: "string" } } }));
// P2c（方案 §9.1 spill / V2）：读取溢出区全文（G1，手动/AI 均可用）
registerTool(T({ name: "read_spilled", manualAllowed: true, level: "g1", params: { required: ["key"], types: { key: "string" } } }));

// 轻量参数校验：required 缺失 / types 类型不符 / enums 越界 → INVALID_REQUEST
function validateToolArgs(name, args, meta) {
  const p = meta.params || {};
  const a = args || {};
  const missing = (p.required || []).filter(k => a[k] === undefined || a[k] === null);
  if (missing.length) return `${name} 缺少必填参数: ${missing.join(", ")}`;
  for (const [k, t] of Object.entries(p.types || {})) {
    if (a[k] === undefined || a[k] === null) continue;
    const actual = Array.isArray(a[k]) ? "array" : typeof a[k];
    if (actual !== t) return `${name} 参数 ${k} 类型应为 ${t}，实际 ${actual}`;
  }
  for (const [k, vals] of Object.entries(p.enums || {})) {
    if (a[k] !== undefined && a[k] !== null && !vals.includes(a[k])) return `${name} 参数 ${k} 取值非法（可选: ${vals.join(" / ")}）`;
  }
  return null;
}

function briefArgs(args) {
  const s = JSON.stringify(args || {});
  return s && s.length > 120 ? s.substring(0, 120) + "…" : (s || "");
}

// 合并外部信号（用户中止）+ 内部 deadline 信号 → 单一派生信号下发给工具
function combineSignals(...signals) {
  const c = new AbortController();
  const live = signals.filter(Boolean);
  if (!live.length) return c;
  for (const s of live) {
    if (s.aborted) { c.abort(s.reason); return c; }
  }
  if (typeof AbortSignal.any === "function") {
    // 修复（审读低）：原生派生信号——监听不落在长寿命源 signal 上（用户中止/任务级 signal），
    // 随临时 anySig 引用释放整体回收，数百次工具调用后不再堆积监听器
    const anySig = AbortSignal.any(live);
    if (anySig.aborted) c.abort(anySig.reason);
    else anySig.addEventListener("abort", () => c.abort(anySig.reason), { once: true });
    return c;
  }
  // 兼容回退（无 AbortSignal.any 的旧内核）：一次性转发
  for (const s of live) s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  return c;
}

// --- P2c：spill（方案 §9.1 / V2）---
// 单工具结果 > 8k 字符 → 写入 storage 会话级溢出区，消息中只留摘要 + 读取指引（read_spilled 读回全文）
// 写入失败 → 降级保留原文（方案 §13：不阻断任务）
const SPILL_THRESHOLD = 8000;
const SPILL_SUMMARY_LEN = 400;
const SPILL_LIMIT_PER_CONV = 30; // 每会话溢出区条数上限，超限清最旧（防 storage 膨胀）

async function maybeSpill(raw, toolName = "") {
  if (!raw || raw.ok === false || raw.code) return raw; // 失败结果不 spill
  if (toolName === "read_spilled") return raw; // 修复（审读高）：read_spilled 返回大内容——豁免再 spill，防"越读越胀/永远读不全"自馈环
  const text = JSON.stringify(raw.data !== undefined ? raw.data : raw);
  if (!text || text.length <= SPILL_THRESHOLD) return raw;
  const convId = taskState.conv?.convId || "global";
  const key = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const storageKey = spillKey(convId, key);
  try {
    await chrome.storage.local.set({ [storageKey]: { at: Date.now(), content: text, summary: text.substring(0, SPILL_SUMMARY_LEN) } });
    // 按每会话 spill 索引精确裁剪最旧（不再 get(null) 全库扫描）
    await recordSpillKey(convId, key, SPILL_LIMIT_PER_CONV);
  } catch (e) {
    return raw; // 写入失败 → 降级保留原文
  }
  return {
    ok: true,
    spilled: true,
    data: {
      spilled: true,
      notice: `结果过大（${text.length} 字符 > 8k），已存入溢出区。用 read_spilled("${key}") 读取全文；当前仅展示摘要：`,
      summary: text.substring(0, SPILL_SUMMARY_LEN) + (text.length > SPILL_SUMMARY_LEN ? "…" : "")
    }
  };
}

// --- 工具统一入口（方案_v2 §6.2 / M3 双路径显式区分） ---
// mode:'ai'     —— AI 调用（批准闸门在 agent.js 轮级处理；这里做 校验→超时→执行→审计）
// mode:'manual' —— 手动调用（跳过批准——用户即批准人；保留 校验+超时+审计）
// 超时实现：Promise.race + 派生 AbortSignal；超时结果丢弃、底层 promise 不遗弃
// （finally 中 work.catch 兜底），interruptible 工具收到 abort 真正停止。
export async function dispatchTool(name, args, { mode = "ai", signal = null, expert = false } = {}) {
  const meta = TOOL_REGISTRY.get(name);
  if (!meta) return { ...normalizeToolResult({ error: `未知工具: ${name}` }), code: F12X_ERROR_CODES.NOT_FOUND }; // §10：未知工具 → NOT_FOUND（精确语义）
  // E2（方案_v3）：专家回合只读硬约束——exec_expert 的 eval_js 强制剥离 allow_tools（防经子工具桥调用写工具），
  // 默认 main world（读页面全局）；复核审计员路径无 eval_js 白名单（只读断言见 experts.reviewAllowedTools）
  if (expert && name === "eval_js") {
    args = { ...(args || {}), allow_tools: [], executionWorld: args?.executionWorld === "isolated" ? "isolated" : "main" };
  }
  if (mode === "manual" && !meta.manualAllowed) {
    return { ...normalizeToolResult({ error: `工具 ${name} 不允许手动调用` }), code: F12X_ERROR_CODES.TOOL_REJECTED };
  }
  const vErr = validateToolArgs(name, args, meta);
  if (vErr) return { ...normalizeToolResult({ error: vErr }), code: F12X_ERROR_CODES.INVALID_REQUEST };

  const timeoutMs = meta.timeoutMs || 30000;
  // 修复（审读高）：工具超时用专码 TOOL_TIMEOUT 且不入重试白名单——
  // 原误发 TIMEOUT + retriable:true：UI 文案错（显示"请求超时"），且未来对工具结果自动重试会重放非幂等已弃结果
  const makeTimeoutErr = () => ({ ok: false, code: F12X_ERROR_CODES.TOOL_TIMEOUT, message: `工具 ${name} 超时（${Math.round(timeoutMs / 1000)}s）${meta.interruptible ? "——已通知底层停止" : "（底层可能仍在执行，结果已丢弃）"}`, retriable: false });
  const deadline = new AbortController();
  let timedOut = false;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
      reject(makeTimeoutErr());
    }, timeoutMs);
  });

  const work = executeToolInner(name, args, combineSignals(signal, deadline.signal).signal);
  try {
    // P2c：spill（方案 §9.1）——超阈值结果写溢出区，消息留摘要 + 读取指引（read_spilled）
    const result = maybeSpill(normalizeToolResult(await Promise.race([work, timeoutPromise])), name);
    // P3：轨迹事件（events 域）——工具分发统一留痕（AI/手动双路径全覆盖；taskState.conv 无会话时静默跳过）
    sessionEvent(taskState.conv, { type: "tool", name, ok: !(result?.error || result?.ok === false) });
    return result;
  } catch (e) {
    if (timedOut) {
      // V1 落实：超时审计记录（interruptible 已中断 / 非 interruptible 底层可能仍在执行）
      addAudit({ tool: name, paramsSummary: briefArgs(args), resultSummary: `超时（${Math.round(timeoutMs / 1000)}s）${meta.interruptible ? "已中断" : "底层可能仍在执行"}`, approval: "timeout" });
      pushStatus({ type: "ai:tool_timeout", tool: name, timeoutMs }); // §十一：工具超时（stream）
      // 修复：race 可能以工具的 AbortError 先结算（deadline.abort 的同步监听先入队）——
      // 一律返回归一化的 TOOL_TIMEOUT 对象，杜绝裸错上抛
      return makeTimeoutErr();
    }
    // 工具抛错统一转稳定错误码；用户中止不覆盖为工具错误
    const ne = normalizeError(e);
    if (ne.code === F12X_ERROR_CODES.ABORTED && taskState.abort?.signal?.aborted) return ne;
    return { ...ne, code: F12X_ERROR_CODES.TOOL_EXECUTION_ERROR, message: ne.message };
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // 不遗弃 promise：超时后底层继续执行时吞掉其后续错误（结果已丢弃）
  }
}

async function executeToolInner(name, args, signal = null) {
  const toolLabel = TOOL_NAMES_CN[name] || name;
  let argBrief = args ? JSON.stringify(args) : "";
  // eval_js 可视化增强：浮条显示“动作摘要”而非整段代码——可读优先（标签：操作目标/请求地址/读取属性…）
  if (name === "eval_js" && args?.code) {
    const s = String(args.code);
    const sel = s.match(/querySelector(?:All)?\(\s*['"]([^'"]+)['"]\s*\)/);
    if (sel) { argBrief = "操作 " + sel[1]; }
    else {
      const clean = s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\/\/[^\n]*\n/gm, "").replace(/\s+/g, " ").trim();
      const req = clean.match(/fetch\(\s*['"`]([^'"`]+)['"`]/);
      if (req) argBrief = "请求 " + req[1].slice(0, 64);
      else if (/document\.title/.test(clean)) argBrief = "读取页面标题";
      else if (/location\.(href|assign|replace)|window\.location/.test(clean)) argBrief = "读取/跳转 location";
      else if (/addEventListener/.test(clean)) argBrief = "绑定事件监听";
      else if (/innerHTML\s*=/.test(clean)) argBrief = "写入 innerHTML";
      else argBrief = (clean || s.trim()).slice(0, 56) + (clean.length > 56 ? "…" : "");
    }
  }
  const brief = argBrief && argBrief.length > 40 ? argBrief.substring(0, 40) + "…" : (argBrief || "");
  // screenshot 不显示浮条（避免指示条被截进图片；截图函数内部会先清理残留浮条）
  if (name !== "screenshot") showPageIndicator(`${toolLabel}${brief ? `（${brief}）` : ""}`, 1500);
  switch (name) {
    case "get_page_skeleton":
      return await get_page_skeleton();
    case "search_dom":
      return await search_dom(args.selector);
    case "get_network_requests":
      return await get_network_requests(args.filter, args.limit);
    case "get_network_request_detail":
      // P1：支持 offset/limit 分段读取响应体（大响应）
      return await get_network_request_detail(args.id, { offset: args.offset, limit: args.limit });
    case "get_cookies": {
      const includeValues = args.includeValues !== false; // 默认返回 value（火力全开）
      const urls = args.urls;

      // 跨域名读取校验已移除（火力全开：任意域名 Cookie 可读）

      return await get_cookies(includeValues, urls);
    }
    case "eval_js": {
      const code = args.code;
      // P2c（run_code）：executionWorld 默认 main 主 world；allow_tools 开启脚本内子工具桥
      return await eval_js(code, args.executionWorld || "main", args.allow_tools || []);
    }
    case "get_script_list":
      return await get_script_list();
    case "get_script_content":
      // P1：grep 匹配上限（limit 参数防 token 失控）
      return await get_script_content(args.url, args.startLine, args.endLine, args.grep, args.limit);
    case "navigate":
      // 统一入口（debugger.navigate：URL 规范化 + 内部页 tabs 打开 + CDP 导航 + 加载等待）
      return await navigate(args.url);
    case "get_console_logs":
      return await get_console_logs(args.level, args.limit);
    case "replay_request":
      return await replay_request(args);
    case "highlight_element":
      return await highlight_element(args);
    case "screenshot": {
      // 功能残缺 P0-3：截图保存后推送 shot_captured 事件——panel 对话流内联渲染
      const shotRes = await screenshot(args || {});
      if (shotRes?.ok && shotRes.key) {
        pushStatus({ type: "shot_captured", key: shotRes.key, size: shotRes.size, ts: Date.now() });
      }
      return shotRes;
    }
    case "decode_text":
      return await decode_text(args || {});
    case "compare_responses":
      return await compare_responses(args || {});
    case "intruder":
      // P1：interruptible——signal（用户中止/超时 deadline）下发给 intruder 真正停止爆破
      return await intruder(args || {}, signal);
    case "upsert_fact": {
      // 黑板归属：会话绑定项目 → 项目黑板（跨会话共享）；未绑定 → AI 全局黑板
      // P1 修复：模型手动记黑板必须带当前会话 convId——否则详情"黑板"页按会话过滤时该条永不可见
      const factArgs = { ...(args || {}), convId: taskState.conv?.convId || "" };
      return await upsertFact(taskState.conv?.projectId || AI_PROJECT_ID, factArgs);
    }
    case "get_fact":
      return await getFact(taskState.conv?.projectId || AI_PROJECT_ID, args.key);
    case "rebuttal_check":
      // 反驳审查：记录三问自检痕迹（不拦截行动——反驳≠否决）
      // 同时自动写入工作区决策条目（审计留痕）
      appendWorkspaceEntry(taskState.conv?.convId, {
        type: "decision",
        author: "main_model",
        content: args.conclusion || "",
        evidence: `三问自检：证据=${args.evidence || "无"} | 替代解释=${args.alternative || "无"} | 行动=${args.action || "无"}`,
        status: "executing"
      }).catch(() => {}); // 修复：工作区写入失败不产生 unhandled rejection
      pushStatus({
        type: "rebuttal",
        conclusion: args.conclusion || "",
        evidence: args.evidence || "",
        alternative: args.alternative || "无",
        action: args.action || ""
      });
      return {
        ok: true,
        instruction: "反驳审查已记录。基于你的三问自检：若结论有实测证据支撑、无更强替代解释、行动可逆——请继续行动；若证据不足或存在更可能的替代解释，请先补充验证再行动。"
      };
    case "workspace_note":
      // 会话工作区研讨条目（模型间实时研讨——讨论是过程，不长期保存）
      // discovery：带证据的高值发现 → 自动沉淀黑板 + 工作区条目替换为沉淀标记
      // question：记录疑问（收敛版 A：不再自动召多角色专家；主代理后续轮或 call_expert 复核时回应）
      {
        const convSnap = taskState.conv; // 会话快照：后续所有写入基于快照（防 await 期间会话切换跨写）
        if (!convSnap) return { error: "无活跃会话（工作区/黑板不可用）" };
        const isQ = args.type === "question";
        const entry = await appendWorkspaceEntry(convSnap.convId, {
          type: isQ ? "question" : "discovery",
          author: "main_model",
          content: args.content,
          evidence: args.evidence || "",
          status: "open",
          to: args.to || null
        });
        if (!entry) return { error: "工作区写入失败" };
        let replyText = null;
        // ① 高价值发现（带证据）→ 自动沉淀 AI 黑板；沉淀后工作区条目替换为标记（讨论文件不保留已沉淀内容）
        if (!isQ && args.evidence) {
          const content = String(args.content || "");
          const key = `finding|workshop-${Date.now().toString(36)}`;
          // 修复：await 沉淀结果——失败时保留原文不伪造"[已记入黑板]"，审计链保持真实
          const pb = await publishToBlackboard(convSnap.projectId || AI_PROJECT_ID, {
            key,
            category: "finding",
            summary: content.substring(0, 100),
            body: `## 讨论结论\n${content}\n\n## 证据\n${args.evidence}`,
            confidence: "medium",
            convId: convSnap.convId
          });
          if (pb?.ok) {
            await updateWorkspaceEntry(convSnap.convId, entry.id, {
              content: `[已记入黑板 ${key}] ${content.substring(0, 80)}`,
              status: "promoted",
              promotedKey: key
            }).catch(() => {});
          }
        }
        // ② 实时研讨 question：仅记录疑问（收敛版 A——不再自动召多角色专家）；
        //    主代理可在后续轮次/最终回答中回应，或调用 call_expert 请复核审计员协助
        if (isQ) {
          replyText = null;
        }

        pushStatus({ type: "workspace", entry });
        return {
          ok: true,
          entryId: entry?.id,
          total: (await getWorkspace(convSnap.convId)).entries.length,
          blackboard: (!isQ && args.evidence),
          expertReply: isQ ? "疑问已记录（主代理可在后续回答中回应；也可用 call_expert 请复核审计员协助）" : null
        };
      }
    case "call_expert":
      // 收敛版 A：唯一的"专家"=复核审计员——对关键结论/疑点做独立只读复核（≤3 步，可现场验证）
      {
        if (!taskState.config) return { error: "LLM 配置未就绪" };
        const convSnap = taskState.conv;
        const projectSnap = taskState.conv?.projectId || AI_PROJECT_ID;
        const zh = "复核审计员";
        const focus = String(args.focus || args.question || "").trim();
        if (focus.length < 4) return { error: "请说明要复核的结论或疑点（focus）——复核审计员需要明确对象" };
        const data = String(args.data || "").trim();
        taskState.expertCalls++;
        pushStatus({ type: "expert_start", expert: zh, tool: "复核", round: 0 });
        try {
          let seedData = data;
          if (!seedData && convSnap && Array.isArray(convSnap.messages)) {
            seedData = convSnap.messages.filter(m => m.role === "tool").slice(-3).map(m => String(m.content || "").substring(0, 2000)).join("\n---\n");
          }
          const expertResult = await runReviewAudit({
            goal: convSnap?.goal,
            focus,
            seedData,
            config: taskState.config,
            signal: taskState.abort?.signal,
            onReasoning: (delta) => pushStatus({ type: "expert_reasoning", expert: zh, delta, round: 0 })
          });
          if (expertResult) {
            if (convSnap && Array.isArray(convSnap.messages)) {
              convSnap.messages.push({ role: "user", _sys: true, _kind: "expert", ts: Date.now(),
                content: JSON.stringify({ expert: zh, tool: "复核", reasoning: String(expertResult.reasoning || "").substring(0, 12000), findings: expertResult.findings, evidence: expertResult.evidence, nextAction: expertResult.nextAction, confidence: expertResult.confidence, verified: !!expertResult.verified, toolTrail: expertResult.toolTrail || [] }) });
              if (convSnap.messages.length > 400) convSnap.messages = convSnap.messages.slice(-400);
            }
            if (convSnap) sessionEvent(convSnap, { type: "expert_round", expert: zh, steps: expertResult.steps || 0, verified: !!expertResult.verified, tools: (expertResult.toolTrail || []).map(t => t.tool).join(",") });
            publishToBlackboard(projectSnap, {
              key: `finding|review-${Date.now().toString(36)}`,
              category: "finding",
              summary: (expertResult.findings || "").substring(0, 100),
              body: `## 复核结论\n${expertResult.findings || ""}\n\n## 证据\n${expertResult.evidence || ""}\n\n## 建议\n${expertResult.nextAction || "无"}\n\n## 已实测验证：${expertResult.verified ? "是" : "否"}`,
              confidence: expertResult.confidence || "medium",
              convId: convSnap?.convId || ""
            }).catch(() => null);
            pushStatus({ type: "expert_done", expert: zh, conclusion: expertResult.findings, confidence: expertResult.confidence, followup: expertResult.nextAction, verified: !!expertResult.verified, toolTrail: expertResult.toolTrail || [], round: 0 });
            return { ok: true, expert: zh, findings: expertResult.findings, evidence: expertResult.evidence, nextAction: expertResult.nextAction, confidence: expertResult.confidence, verified: !!expertResult.verified, questionForMain: expertResult.questionForMain };
          }
          return { error: "复核未产出结论（证据可能不足）——请补充相关上下文后再试" };
        } catch (e) {
          pushStatus({ type: "expert_done", expert: zh, error: e.message, round: 0 });
          return { error: "复核失败: " + (e && e.message) };
        }
      }

    case "get_skill":
      // 渐进式披露 Level 2：按名称读取技能全文（主模型技能）
      {
        const name = String(args.name || "").trim();
        if (!name) return { error: "请指定技能名称（name）" };
        const skills = await getRoleSkills("main_model");
        const skill = skills.find(s => s.name === name);
        if (!skill) return { error: `技能不存在: ${name}（查看系统提示中的【技能索引】列表）` };
        return { ok: true, name: skill.name, content: String(skill.content).substring(0, 8000) };
      }
    case "read_spilled":
      // P2c（方案 §9.1 / V2）：读取溢出区全文（模型/手动均可——G1）
      {
        const convId = taskState.conv?.convId || "global";
        const r = await chrome.storage.local.get(`spill:${convId}:${args.key}`);
        const entry = r[`spill:${convId}:${args.key}`];
        if (!entry) return { error: `溢出数据不存在或已过期: ${args.key}`, code: "NOT_FOUND" };
        // 单次读取上限（修复：24k 字符/次；防超大内容直接进上下文；已豁免 spill 回环）
        const content = String(entry.content || "");
        const MAX = 24000;
        return { ok: true, key: args.key, content: content.substring(0, MAX), truncated: content.length > MAX, total: content.length };
      }
    default:
      return { error: `未知工具: ${name}` };
  }
}
