// F12x plan 模块（模块化拆分，纯搬移零逻辑变更）
import { buildSkillsIndex, pickBlackboardFacts } from "./memory.js";
import { fetchLLM, llmCallWithRetry, estimateTokensV2, streamChatCompletion } from "./llm.js";

// 发送前清洗：剔除本地元数据 _sys、internal 角色归一化为 user（与 agent.js 的 sanitizeMessagesForAPI 同契约）
function sanitizeMessagesForAPI(messages) {
  return messages.map((m) => {
    const { _sys, _kind, ...rest } = m;
    if (rest.role === "internal") rest.role = "user";
    return rest;
  });
}

// KV 缓存友好前缀（§7.2）：与主请求同源的 system + 最早消息。修复（审读高）：
// 原实现 messages.slice(0,3) 会把首轮 assistant(tool_calls) 与其 tool 响应切断 →
// 压缩请求 HTTP 400 → 摘要压缩在典型会话静默降级为丢轮次。此处保证前缀结尾
// 必须是合法配对边界（不以未配对的 tool_calls assistant 结尾）
function buildCompactionPrefix(messages, systemContent) {
  const prefix = sanitizeMessagesForAPI(messages.slice(0, 3));
  const sysMsgs = systemContent
    ? [{ role: "system", content: systemContent }]
    : prefix.filter(m => m.role === "system");
  const rest = prefix.filter(m => m.role !== "system");
  while (rest.length) {
    const last = rest[rest.length - 1];
    if (last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length) rest.pop();
    else break;
  }
  return [...sysMsgs, ...rest];
}

export function splitRounds(messages) {
  // 第二轮审查 P1-1：system 消息（SYSTEM_PROMPT/锚点/技能索引——行为约束）
  // 属于所有轮次——splitRounds 必须保留，压缩时始终放回开头
  const systemMsgs = messages.filter(m => m.role === "system");
  const rounds = [];
  let current = null;
  for (const m of messages) {
    if (m.role === "system") continue; // 已提取——不参与轮次分组
    if (m.role === "user") {
      current = { msgs: [m] };
      rounds.push(current);
    } else if (m.role === "assistant") {
      current = { msgs: [m] };
      rounds.push(current);
    } else if (m.role === "tool") {
      // tool 结果并入最近的 assistant 轮（配对）
      if (current && current.msgs.length && current.msgs[current.msgs.length - 1].role === "assistant") {
        current.msgs.push(m);
      } else if (rounds.length) {
        rounds[rounds.length - 1].msgs.push(m);
      } else {
        rounds.push({ msgs: [m] });
      }
    }
  }
  return { systemMsgs, rounds };
}

export function truncateLatestTool(messages, toolMaxChars, maxTokens = 0) {
  const out = messages.slice();
  const marker = "\n...[truncated]";
  const totalTokens = (arr) => arr.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
  let total = maxTokens ? totalTokens(out) : 0;
  // 修复（审读中）：截断后重算预算——若仍超限则继续截断其他超限工具（最坏 O(n²)，仅在溢出兜底路径触发）
  for (let iter = 0; iter < out.length; iter++) {
    let best = -1, bestLen = toolMaxChars;
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (m.role === "tool" && m.content && m.content.length > bestLen) { best = i; bestLen = m.content.length; }
    }
    if (best === -1) break;
    const keep = Math.max(200, Math.floor(bestLen * 0.6)); // 每次压缩到 60%（保留 200 字符保底语义）
    out[best] = { ...out[best], content: out[best].content.substring(0, Math.max(0, keep - marker.length)) + marker };
    if (!maxTokens) break; // 原语义：只截最新一条最长的（无预算模式）
    total = totalTokens(out);
    if (total <= maxTokens) break;
  }
  return out;
}

// === 消息序列清洗：保证 assistant(tool_calls) 与其 tool 响应严格配对 ===
// OpenAI 兼容 API 硬性要求：assistant 带 tool_calls 的消息后面必须紧跟覆盖每个
// tool_call_id 的 tool 消息，否则 HTTP 400（"insufficient tool messages following
// tool_calls message"）。任务被打断/暂停/批准超时等异常路径可能产生未配对序列，
// 若被持久化进会话历史，后续所有 LLM 调用都会 400。
// 规则：完整配对保留；缺失响应/被打断 → 该 assistant 退化为纯文本（删 tool_calls）、
// 孤儿 tool 消息丢弃。
export function sanitizeMessageSequence(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  let pendingIds = null; // 当前 assistant 待配对的 tool_call_id 集合
  let pendingIdx = -1;   // 该 assistant 在 out 中的下标
  const strip = (idx) => {
    if (idx < 0) return;
    const { tool_calls, ...rest } = out[idx];
    out[idx] = rest; // 退化纯文本
    out.length = idx + 1; // 其后已配对的 tool 消息随之丢弃（缺响应=数据已损坏）
  };
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      if (pendingIds) { strip(pendingIdx); pendingIds = null; pendingIdx = -1; } // 上一轮未配对 → 退化
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        pendingIds = new Set(m.tool_calls.map(tc => tc && tc.id).filter(Boolean));
        pendingIdx = out.length;
      }
      out.push(m);
    } else if (m.role === "tool") {
      if (pendingIds && m.tool_call_id && pendingIds.has(m.tool_call_id)) {
        pendingIds.delete(m.tool_call_id);
        out.push(m);
        if (!pendingIds.size) { pendingIds = null; pendingIdx = -1; }
      }
      // 孤儿 tool 消息（无对应 assistant tool_calls）→ 丢弃
    } else {
      if (pendingIds) { strip(pendingIdx); pendingIds = null; pendingIdx = -1; }
      out.push(m);
    }
  }
  if (pendingIds) strip(pendingIdx); // 末尾未配对的 assistant → 退化
  return out;
}

export function compactMessages(messages, opts = {}) {
  // P0-2：默认目标 120k（与 128k 触发阈值同量级）——原 200k 压缩后仍超 deepseek 窗口
  const maxTokens = opts.maxTokens || 104857; // 对齐 DSH compaction-basic：默认 0.8 × 131072 窗口
  const toolMaxChars = opts.toolMaxChars || 12000;
  if (!messages || !messages.length) return messages;
  // 旧数据兼容：残留 internal 角色归一化为 user（API 合法值；_sys 保留供过滤/审计）——
  // splitRounds 会静默丢弃 internal，此处统一在入口规范化，保证产物角色永远合法
  const norm = messages.map(m => m.role === "internal" ? { ...m, role: "user" } : m);
  const total = norm.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
  if (total <= maxTokens) return norm;

  const { systemMsgs, rounds } = splitRounds(norm);
  if (rounds.length <= 1) return [...systemMsgs, ...truncateLatestTool(norm.filter(m => m.role !== "system"), toolMaxChars, maxTokens)];

  // 从最老轮次开始丢，每丢一轮重算——system 约束始终保留在结果开头
  let kept = rounds;
  while (kept.length > 1) {
    const candidate = kept.slice(1).flatMap(r => r.msgs);
    const t = candidate.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
    if (t <= maxTokens) return [...systemMsgs, ...candidate];
    kept = kept.slice(1);
  }
  // P0-2：maxTokens 由调用方传入（同源）——默认目标降为 120k（与 128k 触发阈值同量级）
  return [...systemMsgs, ...truncateLatestTool(kept.flatMap(r => r.msgs), toolMaxChars, maxTokens)];
}

// ============================================================
// P2b：结构化 LLM 摘要压缩（方案 §7.2，对齐 Harness summarizer COMPACTION_INSTRUCTION）
//  - 主模型、max_tokens 4096、流式 idle 复用 streamChatCompletion 的 120s
//  - KV 缓存友好：压缩请求复用正常请求的 system 前缀（与主请求同源）
//  - 产物 = 一条 _sys:true user 消息（checkpoint 结构），surface 替换被压缩区间
//  - 前置校验：摘要 token < 被压缩内容 token，否则不采用
//  - 边界安全：压缩区间按轮次整轮裁剪（splitRounds 保证不切 tool/result 对）
//  - 降级（D3）：失败 / 无 LLM 配置 → 回退 compactMessages 丢轮次，不阻断任务
// ============================================================
// ============================================================
// 工具结果确定性裁剪（对齐 DSH ToolResultPruner 语义）：
// 压力/溢出处理时先裁剪"较早轮次"的超大工具结果（保留头尾 + 显式裁剪标记），
// 可能无需 LLM 摘要即回落到阈值以下（无摘要推进）；最近 protectRecentTools 条
// 结果不裁剪（保护正在使用的证据）。返回新数组；未裁剪时返回原引用。
// ============================================================
export function pruneToolResults(messages, opts = {}) {
  if (!Array.isArray(messages) || !messages.length) return { messages, changed: false, prunedCount: 0 };
  const budgetChars = opts.budgetChars || 4000;
  const protectRecentTools = opts.protectRecentTools || 3;
  const out = messages.slice();
  const toolIdx = [];
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m && m.role === "tool" && typeof m.content === "string") toolIdx.push(i);
  }
  if (!toolIdx.length) return { messages, changed: false, prunedCount: 0 };
  const protect = new Set(toolIdx.slice(Math.max(0, toolIdx.length - protectRecentTools)));
  let changed = false, prunedCount = 0;
  for (const i of toolIdx) {
    if (protect.has(i)) continue;
    const content = out[i].content;
    if (content.length <= Math.floor(budgetChars * 1.5)) continue; // 只动明显超预算的
    const headLen = Math.floor(budgetChars * 0.6);
    const tailLen = budgetChars - headLen;
    const marker = "\n…[上下文裁剪：该工具结果过长，已保留头尾（" + budgetChars + " 字符）；需要完整数据请用相应工具/read_spilled 重新获取]…\n";
    const pruned = content.slice(0, headLen) + marker + content.slice(content.length - tailLen);
    if (pruned.length >= content.length) continue;
    out[i] = { ...out[i], content: pruned };
    changed = true; prunedCount++;
  }
  return { messages: changed ? out : messages, changed, prunedCount };
}

const COMPACT_INSTRUCTION = `你是对话压缩器。请将 <history> 中的历史对话压缩为结构化 checkpoint 摘要，**保留所有关键细节**（已确认的目标/接口/路径/凭证线索、错误与修复、当前进度、下一步），去除重复与噪音。

严格按以下 Markdown 标题输出：
## Primary Request and Intent
（原始任务目标与意图）
## Key Technical Concepts
## Files and Code
（已确认目标/接口/路径/代码位置）
## Errors and Fixes
## Pending Jobs
（计划中未完成步骤）
## Current Work
（当前进度）
## Next Step
（下一步建议）

只输出摘要本身，不要解释。`;

// 压缩 checkpoint 消息识别（agent 持久化 / UI 折叠渲染 / 下一次压缩替换共用同一前缀）
export const COMPACT_CP_PREFIX = "【上下文压缩 checkpoint】";
export function isCheckpointMessage(m) {
  return !!(m && m.role === "user" && m._sys === true && typeof m.content === "string" && m.content.startsWith(COMPACT_CP_PREFIX));
}
// 从 checkpoint 消息提取可渲染的 markdown 摘要正文（去掉引导行）
export function checkpointSummaryText(m) {
  if (!isCheckpointMessage(m)) return "";
  const s = String(m.content || "");
  const idx = s.indexOf("\n\n");
  return idx >= 0 ? s.slice(idx + 2) : s.replace(COMPACT_CP_PREFIX, "").trim();
}

export async function compactionWithSummary(messages, opts = {}) {
  // DSH compaction-basic 同语义：maxTokens=压力阈值（0.8×窗口），retainTokens=保留尾部（0.16×窗口），
  // summaryMaxTokens=摘要生成上限（默认 8192）；force=true 时忽略 early-return（provider 已确认溢出场景）
  const maxTokens = opts.maxTokens || 104857;
  const toolMaxChars = opts.toolMaxChars || 12000;
  const summaryMaxTokens = opts.summaryMaxTokens || 8192;
  if (!messages || !messages.length) return messages;
  // 修复（审读中）：与 compactMessages 同契约——internal 残留归一为 user，防 splitRounds 静默丢消息
  messages = messages.map(m => (m && m.role === "internal") ? { ...m, role: "user" } : m);

  const total = messages.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
  if (!opts.force && total <= maxTokens) return messages; // force：provider 确认溢出，低于阈值也尝试压（无可压区间仍原样返回）

  const { systemMsgs, rounds } = splitRounds(messages);
  if (rounds.length <= 1) return [...systemMsgs, ...truncateLatestTool(messages.filter(m => m.role !== "system"), toolMaxChars, maxTokens)];

  // 保留区间：从尾部整轮累计到 retainTokens（默认 maxTokens 的 55%）——保证至少保留 1 轮
  const retainTokens = opts.retainTokens || Math.floor(maxTokens * 0.55);
  let keepCount = 0, keptTokens = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i].msgs.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
    if (keepCount > 0 && keptTokens + r > retainTokens) break;
    keepCount++; keptTokens += r;
  }
  const keep = rounds.slice(rounds.length - keepCount);
  const drop = rounds.slice(0, rounds.length - keepCount);
  if (!drop.length) return messages; // 无可压缩区间

  // 本次压缩标识：checkpoint 落库 / 事件 / UI 折叠渲染共用，可跨会话追溯（DSH compactionId 语义）
  const compactionId = "cp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);

  // 降级（D3）：无 LLM 配置 → 丢轮次
  if (!opts.config?.apiKey) {
    console.warn("[Agent] 无 LLM 配置——compaction 降级为丢轮次");
    opts.onCompacted?.("drop", { compactionId });
    return compactMessages(messages, opts);
  }

  const droppedMsgs = drop.flatMap(r => r.msgs);
  const droppedTokens = droppedMsgs.reduce((s, m) => s + estimateTokensV2(JSON.stringify(m)), 0);
  const historyText = droppedMsgs.map(m => {
    const c = m.content || (m.tool_calls ? JSON.stringify(m.tool_calls) : "") || "";
    return `[${m.role}] ${String(c).substring(0, 8000)}`;
  }).join("\n\n");

  let summary = "";
  try {
    const body = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${opts.config.apiKey}` },
      body: JSON.stringify({
        model: opts.config.model,
        messages: [
          // KV 缓存友好（§7.2）：前缀与主请求同源且配对安全（buildCompactionPrefix）；
          // 修复（审读高）：原 slice(0,3) 切断 tool 配对致 400；opts.systemContent 现在真正生效
          ...buildCompactionPrefix(messages, opts.systemContent),
          { role: "user", content: COMPACT_INSTRUCTION + "\n\n<history>\n" + historyText + "\n</history>" }
        ],
        max_tokens: summaryMaxTokens,
        stream: true,
        stream_options: { include_usage: true }
      }),
      signal: opts.signal || null
    };
    await llmCallWithRetry(() => {
      summary = ""; // 重试时重置，防累积
      return streamChatCompletion(opts.endpoint, body, ({ json, done }) => {
        if (done) return;
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) summary += delta.content;
      }, { idleMs: 120000, timeoutMs: 180000, signal: opts.signal || null });
    }, { retries: 1, signal: opts.signal || null });
  } catch (e) {
    // 修复（审读中）：用户中止时不做"降级丢轮"（会丢弃区间 + 与中止语义冲突）——上抛由上层按中止处理
    if (opts.signal?.aborted || e?.name === "AbortError" || /abort/i.test(String(e?.message || ""))) throw e;
    console.warn(`[Agent] compaction 摘要调用失败（${e.message}）——降级为丢轮次`);
    opts.onCompacted?.("drop", { compactionId });
    return compactMessages(messages, opts);
  }

  // 前置校验（对齐 region.ts：摘要必须比被压缩内容小）
  const summaryTokens = estimateTokensV2(summary);
  if (!summary.trim() || summaryTokens >= droppedTokens) {
    console.warn(`[Agent] compaction 摘要无效（${summaryTokens} tokens ≥ 被压缩 ${droppedTokens} tokens）——不采用，降级为丢轮次`);
    opts.onCompacted?.("drop", { compactionId });
    return compactMessages(messages, opts);
  }

  // 产物 = 一条 _sys:true user 消息（自包含 checkpoint），surface 替换被压缩区间
  const checkpointMsg = {
    role: "user",
    _sys: true,
    _kind: "checkpoint",
    content: `【上下文压缩 checkpoint】以下为已压缩历史的摘要。基于它继续任务，无需回忆被压缩的细节；需要具体数据时用工具重新获取：\n\n${summary}`
  };
  const keptMsgs = keep.flatMap(r => r.msgs);
  const result = [...systemMsgs, checkpointMsg, ...keptMsgs];
  const summaryInfo = {
    compactionId,
    checkpointMsg,
    summary,
    droppedRounds: drop.length,
    droppedItems: droppedMsgs.length,
    droppedTokens,
    keptItems: keptMsgs.length,
    keptTokens,
    summaryTokens
  };
  opts.onCompacted?.("summary", summaryInfo);
  console.log(`[Agent] compaction 摘要完成：丢 ${drop.length} 轮（${droppedTokens}t）→ 摘要 ${summaryTokens}t + 保留 ${keep.length} 轮（${keptTokens}t）`);
  // 兜底：压缩后仍跑清洗（防止区间拼接产生未配对 tool_calls/tool）
  return sanitizeMessageSequence(result);
}

// --- 锚点块（第 1/3 层注入，每次调用动态拼进 system） ---
export function buildAnchorBlock(session, facts, tabUrl) {
  const parts = [];
  if (session?.goal) parts.push(`【任务目标】${session.goal}`);
  if (session?.plan?.length) {
    // 主代理自持执行流程（todo 语义）：status 由主代理按实测证据改写；doing 步附达标标准（criterion）
    const planLines = session.plan.map(p => {
      const icon = p.status === "done" ? "完成" : p.status === "doing" ? "进行中" : "待办";
      let line = `${p.step}. [${icon}] ${p.desc}`;
      if (p.status === "doing" && p.criterion) line += `（达标：${p.criterion}）`;
      return line;
    }).join("\n");
    parts.push(`【执行流程】（主代理自持——按实测证据推进/修订，以最新流程为准）\n${planLines}`);
  }
  if (facts?.length) {
    // 读侧精选（方案：黑板优化 A）：不再简单按 createdAt 降序——手动(curated)优先 + 类别加权 +
    // 类别轮转防“finding/review 自动沉淀刷屏挤掉 endpoint/credential”；同类别内新→旧
    const picked = pickBlackboardFacts(facts, 10);
    const idx = picked.map(f => `- [${f.key}] ${f.summary} (${f.confidence})`).join("\n");
    const omitted = facts.length > picked.length ? `\n（另有 ${facts.length - picked.length} 条，用 get_fact 查询）` : "";
    parts.push(`【黑板索引】（发现共享，跨任务可用）\n${idx}${omitted}\n需要详情请调用 get_fact(key)；新发现请调用 upsert_fact(key, category, summary, body)——禁止凭摘要臆造细节。`);
  }
  if (tabUrl) parts.push(`【当前页面】${tabUrl}`);
  return parts.join("\n\n");
}
