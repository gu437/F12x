// F12x memory 模块（模块化拆分，纯搬移零逻辑变更）

export const PROJECTS_KEY = "projects_v2";
export const CONVERSATIONS_KEY = "conversations_v2";
export const ACTIVE_KEY = "active_conv_v2";
// AI 全局黑板：AI 引擎所有黑板操作（发现/结论/工具事实）的统一归属（AI 数据独立于用户工作区）
export const AI_PROJECT_ID = "__ai__";

// === 项目（一等实体，用户手动创建） ===
export async function listProjects() {
  const r = await chrome.storage.local.get(PROJECTS_KEY);
  const projects = r[PROJECTS_KEY] || {};
  return Object.values(projects).map(p => ({
    id: p.id, name: p.name, desc: p.desc || "",
    factsCount: (p.facts || []).length, createdAt: p.createdAt
  })).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getProject(projectId) {
  if (!projectId) return null;
  const r = await chrome.storage.local.get(PROJECTS_KEY);
  const projects = r[PROJECTS_KEY] || {};
  return projects[projectId] || null;
}

export async function saveProject(project) {
  if (!project?.id) return;
  const r = await chrome.storage.local.get(PROJECTS_KEY);
  const projects = r[PROJECTS_KEY] || {};
  projects[project.id] = project;
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
}

export async function createProject(name, desc) {
  const r = await chrome.storage.local.get(PROJECTS_KEY);
  const projects = r[PROJECTS_KEY] || {};
  const id = "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const project = {
    id, name: String(name || "未命名项目").substring(0, 50),
    desc: String(desc || "").substring(0, 200), facts: [], createdAt: Date.now()
  };
  projects[id] = project;
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  return project;
}

export async function deleteProject(projectId) {
  const r = await chrome.storage.local.get([PROJECTS_KEY, CONVERSATIONS_KEY]);
  const projects = r[PROJECTS_KEY] || {};
  delete projects[projectId];
  const conversations = r[CONVERSATIONS_KEY] || [];
  for (const c of conversations) if (c.projectId === projectId) c.projectId = null;
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects, [CONVERSATIONS_KEY]: conversations });
}

export async function renameProject(projectId, name) {
  const project = await getProject(projectId);
  if (!project) return null;
  project.name = String(name || "").substring(0, 50) || project.name;
  await saveProject(project);
  return { id: project.id, name: project.name };
}

// === 黑板（AI 全局事实库，跨会话共享） ===
export async function upsertFact(projectId, fact) {
  if (!projectId) projectId = AI_PROJECT_ID; // AI 数据统一归属 AI 全局黑板（不写用户工作区）
  if (!fact || !fact.key) return { error: "key 必填" };
  let project = await getProject(projectId);
  if (!project) {
    if (projectId !== AI_PROJECT_ID) return { error: `项目不存在: ${projectId}`, code: "NOT_FOUND" };
    project = { id: AI_PROJECT_ID, name: "AI 全局黑板", desc: "AI 引擎自动沉淀的发现/结论", facts: [], createdAt: Date.now() };
    await saveProject(project);
  }
  const facts = project.facts || [];
  const entry = {
    key: String(fact.key).substring(0, 120),
    category: String(fact.category || "misc").substring(0, 30),
    summary: String(fact.summary || "").substring(0, 2000), // 火力全开：500 → 2000
    confidence: String(fact.confidence || "medium").substring(0, 10),
    body: String(fact.body || "").substring(0, 500000), // 火力全开：50000 → 500000
    // 归属会话：AI 会话详情中"黑板栏"按会话过滤展示（历史条目无 convId 归入"未归属"）
    convId: fact.convId || "",
    // 审查者建议：auto 标记自动沉淀条目——人工删除统计成为可量化数据源（决策点 3 反馈）
    auto: fact.auto === true,
    createdAt: Date.now()
  };
  const idx = facts.findIndex(f => f.key === entry.key);
  if (idx >= 0) {
    const prev = facts[idx];
    // 收敛：内容未变的重复自动沉淀（同结论 steering/兜底）不再刷新时间戳、不重复写库
    if (prev.category === entry.category && prev.summary === entry.summary && prev.body === entry.body && prev.confidence === entry.confidence && prev.auto === entry.auto) {
      return { ok: true, key: entry.key, total: facts.length, updated: false };
    }
    facts[idx] = { ...entry, createdAt: prev.createdAt || entry.createdAt }; // 内容变化才更新（保留首次 createdAt 作稳定排序基准）
  } else facts.push(entry);
  if (facts.length > 500) facts.splice(0, facts.length - 500); // 火力全开：200 → 500
  project.facts = facts;
  await saveProject(project);
  return { ok: true, key: entry.key, total: facts.length, updated: true };
}

export async function getFact(projectId, key) {
  const project = await getProject(projectId);
  if (!project) return { error: `项目不存在: ${projectId}`, code: "NOT_FOUND" };
  const facts = project.facts || [];
  const f = facts.find(x => x.key === key);
  if (!f) return { error: `黑板中不存在: ${key}`, code: "NOT_FOUND", available: facts.map(x => x.key).slice(0, 20) };
  return { ...f };
}

// 高价值情报自动沉淀到 AI 全局黑板（跨会话共享）
// 任务执行中发现的线索/结论在此发布——后续会话通过黑板索引可见、get_fact 可取详情
// 火力全开：confidence 门槛已移除（low 猜测也沉淀——原 P1"≥ medium 防污染"门槛按开发者指示解除；
// 防污染改由模型质量机制（防空想）在源头控制）
export async function publishToBlackboard(projectId, { key, category = "finding", summary, body = "", confidence = "medium", convId }) {
  if (!projectId || !key || !summary) return null;
  try {
    // P1 修复：键归一化——自动沉淀的时间戳键（finding|xxx-{ts}）每次任务生成新条目
    // FIFO 挤爆 200 上限；同 finding 改为稳定键覆盖（按 summary 哈希）
    let finalKey = key;
    if (/finding\||endpoint\||chain\|/.test(key) && /-\w{6,}$/.test(key)) {
      let h = 0x811c9dc5;
      const base = key.replace(/-\w{6,}$/, "");
      const src = base + ":" + String(summary).substring(0, 50);
      for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
      finalKey = `${base}-${h.toString(16).substring(0, 8)}`;
    }
    const res = await upsertFact(projectId, { key: finalKey, category, summary, body, confidence, auto: true, convId });
    return res.ok ? res : null;
  } catch (e) {
    console.warn("[Blackboard] 自动沉淀失败:", e.message);
    return null;
  }
}

// === AI 数据区（独立于用户工作区） ===
// AI 发现列表（黑板）；category 默认 "finding"（向后兼容），传 "all"/undefined 返回全类别（endpoint/credential/chain 等）
// 会话绑定项目 → 查项目黑板（跨会话共享），否则 AI 全局黑板
// convId：仅对未绑定项目（AI 全局黑板）按会话过滤；项目黑板全量共享
// includeUnowned：会话详情"黑板"页展示历史未归属条目（convId 为空 → 全局沉淀），默认关闭（会话删除清理需精确匹配）
// category：指定类别过滤；'all'/undefined 返回全部（读侧精选——endpoint/credential/chain 等不再“写进去看不到”）
export async function listAIFindings(convId, projectId, includeUnowned = false, category = "finding") {
  const pid = projectId || AI_PROJECT_ID;
  const project = await getProject(pid);
  return (project?.facts || [])
    .filter(f => category && category !== "all" ? f.category === category : true)
    .filter(f => {
      if (!convId) return true;
      if (f.convId === convId) return true;
      return includeUnowned && !f.convId;
    })
    .map(f => ({ key: f.key, summary: f.summary, body: f.body, confidence: f.confidence, convId: f.convId || "", createdAt: f.createdAt }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// 读侧精选（锚点用）：手动(curated, auto=false)优先 + 类别加权 + 圆桌轮转防单一类别刷屏
// 优先级：credential > endpoint > finding > chain > 其它；同类内按 createdAt 新→旧
const BLACKBOARD_CAT_ORDER = ["credential", "endpoint", "finding", "chain"];
export function pickBlackboardFacts(facts, limit = 10) {
  if (!Array.isArray(facts) || !facts.length) return [];
  const groups = new Map();
  for (const f of facts) {
    if (!f) continue;
    const c = BLACKBOARD_CAT_ORDER.includes(f.category) ? f.category : "misc";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(f);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => (b.auto === true ? 0 : 1) - (a.auto === true ? 0 : 1) || ((b.createdAt || 0) - (a.createdAt || 0)));
  }
  const order = [...BLACKBOARD_CAT_ORDER.filter(c => groups.has(c)), ...[...groups.keys()].filter(c => !BLACKBOARD_CAT_ORDER.includes(c))];
  const picked = [];
  let ci = 0;
  while (picked.length < limit) {
    let advanced = false;
    for (let step = 0; step < order.length; step++) {
      const cat = order[(ci + step) % order.length];
      const arr = groups.get(cat);
      if (arr && arr.length) {
        picked.push(arr.shift());
        advanced = true;
        ci = (ci + step + 1) % order.length;
        break;
      }
    }
    if (!advanced) break; // 全部取完
  }
  return picked;
}

export async function removeAIFinding(key, projectId) {
  const pid = projectId || AI_PROJECT_ID;
  const project = await getProject(pid);
  if (!project) return { error: "黑板不存在", code: "NOT_FOUND" };
  project.facts = (project.facts || []).filter(f => !(f.key === key && f.category === "finding"));
  await saveProject(project);
  return { ok: true };
}

// === 会话（独立对话，可关联项目） ===
export async function listConversations() {
  const r = await chrome.storage.local.get([CONVERSATIONS_KEY, PROJECTS_KEY]);
  const conversations = r[CONVERSATIONS_KEY] || [];
  const projects = r[PROJECTS_KEY] || {};
  return conversations.map(c => ({
    convId: c.convId, title: c.title, projectId: c.projectId || null,
    projectName: c.projectId ? (projects[c.projectId]?.name || "已删除项目") : null,
    createdAt: c.createdAt, updatedAt: c.updatedAt
  })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getConversation(convId) {
  if (!convId) return null;
  const r = await chrome.storage.local.get(CONVERSATIONS_KEY);
  const conversations = r[CONVERSATIONS_KEY] || [];
  return conversations.find(c => c.convId === convId) || null;
}

export async function saveConversation(conv) {
  if (!conv?.convId) return;
  const r = await chrome.storage.local.get([CONVERSATIONS_KEY, ACTIVE_KEY]);
  let conversations = r[CONVERSATIONS_KEY] || [];
  const idx = conversations.findIndex(c => c.convId === conv.convId);
  conv.updatedAt = Date.now();
  if (idx >= 0) conversations[idx] = conv; else conversations.push(conv);
  if (conversations.length > 100) {
    // 第二轮审查 P2-10：slice(-100) 可能删掉 ACTIVE_KEY 指向的会话——
    // 淘汰时保留活跃会话（活跃会话被删会导致 getActiveConversation 查到旧键无引用）
    // 修复#1：setActiveConversation 存的是纯字符串 convId（原按 ?.convId 对象读取恒为 undefined → 保护永不生效）
    const activeId = r[ACTIVE_KEY];
    if (activeId && !conversations.slice(-100).some(c => c.convId === activeId)) {
      const active = conversations.find(c => c.convId === activeId);
      const rest = conversations.filter(c => c.convId !== activeId).slice(-99);
      conversations = active ? [...rest, active] : conversations.slice(-100);
    } else {
      conversations = conversations.slice(-100);
    }
  }
  await chrome.storage.local.set({ [CONVERSATIONS_KEY]: conversations });
}

export async function createConversation(projectId, title) {
  const conv = {
    convId: "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    title: title || "新对话",
    projectId: projectId || null,
    goal: "", plan: [], messages: [], lastPromptTokens: 0,
    events: [], // P1：会话增量审计域（只追加：task_start/done/aborted/approval…上限 500，见 agent.sessionEvent）
    createdAt: Date.now(), updatedAt: Date.now()
  };
  await saveConversation(conv);
  await setActiveConversation(conv.convId);
  return conv;
}

export async function deleteConversation(convId) {
  const r = await chrome.storage.local.get([CONVERSATIONS_KEY, ACTIVE_KEY]);
  let conversations = r[CONVERSATIONS_KEY] || [];
  conversations = conversations.filter(c => c.convId !== convId);
  await chrome.storage.local.set({ [CONVERSATIONS_KEY]: conversations });
  if (r[ACTIVE_KEY] === convId) await chrome.storage.local.remove(ACTIVE_KEY);
  // 修复：级联清理该会话的溢出区(spill:{id}:*) 与工作区(workspace:{id}) 独立键——
  // 原实现漏清理 → storage 永久泄漏（尤其 spill 大内容键）
  try {
    const all = await chrome.storage.local.get(null);
    const drop = Object.keys(all).filter(k => k.startsWith(`spill:${convId}:`) || k === `workspace:${convId}`);
    if (drop.length) await chrome.storage.local.remove(drop);
  } catch (e) { /* 清理失败不阻断删除 */ }
}

export async function getActiveConversation() {
  const r = await chrome.storage.local.get([ACTIVE_KEY, CONVERSATIONS_KEY]);
  const convId = r[ACTIVE_KEY];
  if (convId) {
    const conv = (r[CONVERSATIONS_KEY] || []).find(c => c.convId === convId);
    if (conv) return conv;
  }
  return await createConversation(null, "新对话"); // 无活跃会话：自动创建独立会话
}

export async function setActiveConversation(convId) {
  await chrome.storage.local.set({ [ACTIVE_KEY]: convId });
}

// === P3：checkpoint 自包含快照（方案 §8.2 fork/resume / §10 数据模型） ===
// 必须为自包含快照 {goal, plan完整快照, facts带内容, lastStepDesc, recentMessages}——
// 不用裸索引（跨会话续跑时旧数组不在内存，裸下标必失忆）；续跑时以 _sys:true user 消息注入快照
// 消息裁剪：单条 content 超过上限截断（正文 >5000 字符摘要保留前 400 + "…见全文"），
// 只保留 role/content/tool_calls 摘要/tool_call_id/name 轻量字段（防快照自身体积失控）
const CP_MSG_CONTENT_MAX = 5000;
const CP_MSG_SUMMARY_KEEP = 400;

function cpShrinkMessage(m) {
  if (!m || typeof m !== "object") return null;
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
  let content = c.length > CP_MSG_CONTENT_MAX ? c.substring(0, CP_MSG_SUMMARY_KEEP) + "…（正文过长已截断，续跑时用工具重新获取）" : c;
  const out = { role: m.role, content };
  if (m.tool_calls) {
    out.tool_calls = m.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      args: String(tc.function?.arguments || "").substring(0, CP_MSG_SUMMARY_KEEP)
    }));
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

// 取最近 N 轮（以 assistant 完整回答为轮边界，含其前后工具调用/结果）
function cpTakeRecentRounds(messages, n) {
  const out = [];
  let rounds = 0;
  for (let i = messages.length - 1; i >= 0 && rounds < n; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const shrunk = cpShrinkMessage(m);
    if (!shrunk) continue;
    out.unshift(shrunk);
    if (m.role === "assistant" && !m.tool_calls) rounds++;
  }
  return out;
}

export async function buildCheckpoint(conv, projectId) {
  if (!conv) return null;
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  const recentMessages = cpTakeRecentRounds(messages, 4); // 最近 3-5 轮
  const pid = projectId || AI_PROJECT_ID;
  let facts = [];
  try {
    const project = await getProject(pid);
    facts = (project?.facts || []).slice(-15).map(f => ({
      key: f.key, category: f.category || "misc",
      summary: String(f.summary || "").substring(0, 500),
      body: String(f.body || "").substring(0, 3000), // 带内容（非裸索引）
      confidence: f.confidence || "medium"
    }));
  } catch (e) { facts = []; }
  const plan = (Array.isArray(conv.plan) ? conv.plan : []).map(p => ({ step: p.step, desc: p.desc, status: p.status }));
  const doing = plan.find(p => p.status === "doing") || plan.find(p => p.status === "todo");
  const lastStepDesc = doing ? doing.desc : (plan.length ? plan[plan.length - 1].desc : "");
  return {
    goal: conv.goal || "",
    plan, facts, lastStepDesc, recentMessages,
    at: Date.now()
  };
}

// 续跑注入的 _sys:true user 消息正文（模型据此恢复上下文；forceReplan 后模型可调整计划）
export function renderCheckpoint(cp) {
  if (!cp) return "";
  const planTxt = (cp.plan || []).map(p => `- [${p.status === "done" ? "x" : " "}] ${p.desc}`).join("\n") || "- （无计划）";
  const factsTxt = (cp.facts || []).slice(0, 10).map(f => `- ${f.key}: ${f.summary}`).join("\n") || "- （无黑板事实）";
  const msgsTxt = (cp.recentMessages || []).slice(0, 10).map(m => {
    const c = String(m.content || "").substring(0, 400);
    if (m.tool_calls?.length) return `[调用工具 ${m.tool_calls.map(t => t.name).join(", ")}] ${c}`;
    return `[${m.role}] ${c}`;
  }).join("\n") || "- （无近期轮次）";
  return `【续跑快照】
任务目标：${cp.goal || "-"}
已推进至：${cp.lastStepDesc || "-"}
计划：\n${planTxt}
黑板事实：\n${factsTxt}
最近对话（节选）：\n${msgsTxt}
请从断点继续执行：先核对上述快照与当前页面实际状态，必要时用工具重新确认关键细节，再推进剩余步骤。`;
}

// === 会话工作区（JSON 结构化研讨平台，会话级隔离） ===
// 条目类型：discovery(D 发现) / question(Q 疑问) / decision(C 决策)
// 状态：discovery: open/confirmed/overruled；question: open/resolved；decision: executing/done/overruled
export async function getWorkspace(convId) {
  if (!convId) return { entries: [], seq: 0 };
  const r = await chrome.storage.local.get(`workspace:${convId}`);
  return r[`workspace:${convId}`] || { entries: [], seq: 0 };
}

export async function appendWorkspaceEntry(convId, entry) {
  if (!convId) return null;
  const ws = await getWorkspace(convId);
  ws.seq = (ws.seq || 0) + 1;
  const prefix = entry.type === "question" ? "Q" : entry.type === "decision" ? "C" : "D";
  const id = `${prefix}-${String(ws.seq).padStart(3, "0")}`;
  ws.entries.push({
    id, type: entry.type || "discovery", author: entry.author || "main_model",
    ts: Date.now(), content: String(entry.content || "").substring(0, 2000),
    evidence: String(entry.evidence || "").substring(0, 5000), status: entry.status || "open",
    to: entry.to || null, replies: entry.replies || []
  });
  // P2 修复：上限 500→2000（300 轮任务 + 专家沉淀 + 审查决策轻松触顶，
  // 早期研讨记录在任务结束前被静默丢弃）；淘汰时优先保留 decision（审查轨迹——审计性）
  // 第二轮审查 P2-11：原 decisions.slice(-300) 在 decision 超 300 时丢最早 decision——
  // 与"优先保留"相悖；decision 保留上限提至 500（审查轨迹是审计刚需）
  if (ws.entries.length > 2000) {
    const decisions = ws.entries.filter(e => e.type === "decision");
    const rest = ws.entries.filter(e => e.type !== "decision");
    const keepDec = Math.min(decisions.length, 500);
    ws.entries = [...rest.slice(-(2000 - keepDec)), ...decisions.slice(-keepDec)];
  }
  await chrome.storage.local.set({ [`workspace:${convId}`]: ws });
  return ws.entries[ws.entries.length - 1];
}

export async function updateWorkspaceEntry(convId, id, patch) {
  if (!convId) return null;
  const ws = await getWorkspace(convId);
  const e = ws.entries.find(x => x.id === id);
  if (!e) return null;
  Object.assign(e, patch);
  await chrome.storage.local.set({ [`workspace:${convId}`]: ws });
  return e;
}

export function filterWorkspaceEntries(entries, opts = {}) {
  let out = entries;
  if (opts.type) out = out.filter(e => e.type === opts.type);
  if (opts.status) out = out.filter(e => e.status === opts.status);
  if (opts.limit) out = out.slice(-opts.limit);
  return out;
}

// 工作区摘要（注入 system 锚点用）：最近 5 条发现 + 未解决疑问（跳过已沉淀黑板的条目）
export function buildWorkspaceSummary(ws) {
  if (!ws?.entries?.length) return "";
  const liveEntries = ws.entries.filter(e => e.status !== "promoted"); // 已沉淀黑板的条目不再注入（结论已在黑板）
  if (!liveEntries.length) return "";
  const parts = [];
  const discoveries = filterWorkspaceEntries(liveEntries, { type: "discovery", limit: 5 });
  if (discoveries.length) {
    parts.push("【会话研讨·发现】\n" + discoveries.map(e =>
      `- [${e.id}] ${e.author}: ${e.content.substring(0, 150)}`
    ).join("\n"));
  }
  const questions = filterWorkspaceEntries(liveEntries, { type: "question", status: "open", limit: 3 });
  if (questions.length) {
    parts.push("【会话研讨·待解决疑问】\n" + questions.map(e =>
      `- [${e.id}] ${e.author} → ${e.to || "全员"}: ${e.content.substring(0, 150)}${e.replies?.length ? "（已有回应）" : ""}`
    ).join("\n"));
  }
  return parts.join("\n\n");
}

// 渲染完整 md（导出/查看用）
export function renderWorkspaceMd(convId, ws, convTitle) {
  const lines = [];
  lines.push(`# 会话工作区：${convTitle || convId}`);
  lines.push(`> convId: ${convId} | 条目: ${ws?.entries?.length || 0}`);
  const byType = { discovery: [], question: [], decision: [] };
  for (const e of ws?.entries || []) (byType[e.type] || byType.discovery).push(e);
  if (byType.discovery.length) {
    lines.push("\n## 🧠 发现");
    for (const e of byType.discovery) {
      if (e.status === "promoted") {
        lines.push(`### [${e.id}] ${e.author} · 已沉淀`);
        lines.push(`- **${e.content}**`); // 已是 [已记入黑板 xxx] 标记
        continue;
      }
      lines.push(`### [${e.id}] ${e.author} · ${new Date(e.ts).toLocaleString("zh-CN")}`);
      lines.push(`- **内容**：${e.content}`);
      if (e.evidence) lines.push(`- **证据**：${e.evidence}`);
      lines.push(`- **状态**：${e.status}`);
    }
  }
  if (byType.question.length) {
    lines.push("\n## ❓ 疑问");
    for (const e of byType.question) {
      lines.push(`### [${e.id}] ${e.author} → ${e.to || "全员"} · ${new Date(e.ts).toLocaleString("zh-CN")}`);
      lines.push(`- **疑问**：${e.content}`);
      for (const r of e.replies || []) lines.push(`- **回复**（${r.author}）：${r.content}`);
      lines.push(`- **状态**：${e.status}`);
    }
  }
  if (byType.decision.length) {
    lines.push("\n## ⚖️ 决策记录");
    for (const e of byType.decision) {
      lines.push(`### [${e.id}] ${e.author} · ${new Date(e.ts).toLocaleString("zh-CN")}`);
      lines.push(`- **决策**：${e.content}`);
      if (e.evidence) lines.push(`- **反驳记录**：${e.evidence}`);
      lines.push(`- **状态**：${e.status}`);
    }
  }
  return lines.join("\n");
}

// --- 第 2 层：轮次划分 + 预算裁剪 ---
export const SKILLS_KEY = "skills_data";

export async function getRoleSkills(role) {
  const r = await chrome.storage.local.get(SKILLS_KEY);
  return (r[SKILLS_KEY] || {})[role] || [];
}
export async function setRoleSkills(role, items) {
  const r = await chrome.storage.local.get(SKILLS_KEY);
  const data = r[SKILLS_KEY] || {};
  data[role] = items;
  await chrome.storage.local.set({ [SKILLS_KEY]: data });
}
// 主模型技能索引（渐进式披露 Level 1：只注入 name+description，需要细节时 get_skill 读取全文）
// 参照 Agent Skills 规格（agentskills.io）：元数据常驻、指令按需加载——避免 skill 多时 token 爆炸
export async function buildSkillsIndex(role) {
  const skills = await getRoleSkills(role);
  if (!skills.length) return "";
  return "\n\n【技能索引】可用技能（需要具体内容时用 get_skill 工具读取全文）：\n"
    + skills.map(s => `- ${s.name}${s.desc ? "：" + s.desc : ""}`).join("\n");
}

// 解析 SKILL.md 格式的 YAML frontmatter（兼容业界 skill：--- name/description --- + markdown body）
export function parseSkillFrontmatter(content) {
  const text = String(content || "");
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { name: null, desc: null, body: text.trim() };
  const fm = m[1];
  const body = m[2].trim();
  const nameM = fm.match(/^name:\s*(.+)$/m);
  const descM = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameM ? nameM[1].trim() : null,
    desc: descM ? descM[1].trim() : null,
    body: body || text.trim()
  };
}

// 审查 2.3：buildSystemContent 死代码（引用 SYSTEM_PROMPT 但未导入——一旦被调用
// 立刻 ReferenceError；全项目无调用点）——删除


// 工具自然语言映射（动作确认/偏离检测共用）

// ============================================================
// v0.2 新增：站点工作区（Site 一等实体）——方案第六章数据模型
// Site { id, name, scope[], desc?, createdAt, updatedAt, facts[], templates[] }
// Fact { id, key, value, source:'user'|'ai', confidence?, tags[], createdAt }
// TaskTemplate { id, name, desc, kind, params, defaults?, instructions }
// ============================================================
export const SITES_KEY = "sites_v1";
export const ACTIVE_SITE_KEY = "active_site_v1";

export async function listSites() {
  const r = await chrome.storage.local.get(SITES_KEY);
  const sites = r[SITES_KEY] || {};
  return Object.values(sites).map(s => ({
    id: s.id, name: s.name, desc: s.desc || "", scope: s.scope || [],
    factsCount: (s.facts || []).length, templatesCount: (s.templates || []).length,
    createdAt: s.createdAt, updatedAt: s.updatedAt
  })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getSite(siteId) {
  if (!siteId) return null;
  const r = await chrome.storage.local.get(SITES_KEY);
  const sites = r[SITES_KEY] || {};
  return sites[siteId] || null;
}

export async function saveSite(site) {
  if (!site?.id) return;
  const r = await chrome.storage.local.get(SITES_KEY);
  const sites = r[SITES_KEY] || {};
  site.updatedAt = Date.now();
  sites[site.id] = site;
  await chrome.storage.local.set({ [SITES_KEY]: sites });
}

export async function createSite(name, desc, scope) {
  const r = await chrome.storage.local.get(SITES_KEY);
  const sites = r[SITES_KEY] || {};
  const id = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const site = {
    id,
    name: String(name || "未命名站点").substring(0, 50),
    desc: String(desc || "").substring(0, 200),
    scope: Array.isArray(scope) ? scope.filter(Boolean).slice(0, 20) : [],
    facts: [], templates: [],
    createdAt: Date.now(), updatedAt: Date.now()
  };
  sites[id] = site;
  await chrome.storage.local.set({ [SITES_KEY]: sites });
  return site;
}

export async function deleteSite(siteId) {
  const r = await chrome.storage.local.get([SITES_KEY, ACTIVE_SITE_KEY]);
  const sites = r[SITES_KEY] || {};
  delete sites[siteId];
  await chrome.storage.local.set({ [SITES_KEY]: sites });
  if (r[ACTIVE_SITE_KEY] === siteId) await chrome.storage.local.remove(ACTIVE_SITE_KEY);
}

export async function renameSite(siteId, { name, desc, scope } = {}) {
  const site = await getSite(siteId);
  if (!site) return { error: "站点不存在", code: "NOT_FOUND" };
  if (name !== undefined) site.name = String(name).substring(0, 50);
  if (desc !== undefined) site.desc = String(desc).substring(0, 200);
  if (scope !== undefined) site.scope = Array.isArray(scope) ? scope.filter(Boolean).slice(0, 20) : site.scope;
  await saveSite(site);
  return { ok: true, site };
}

export async function getActiveSiteId() {
  const r = await chrome.storage.local.get(ACTIVE_SITE_KEY);
  return r[ACTIVE_SITE_KEY] || null;
}

export async function setActiveSiteId(siteId) {
  await chrome.storage.local.set({ [ACTIVE_SITE_KEY]: siteId || null });
  return siteId;
}

export async function getActiveSite() {
  const id = await getActiveSiteId();
  return id ? getSite(id) : null;
}

// --- 站点笔记（用户手动标记的持久化事实，与 AI 黑板分离） ---
export async function addSiteFact(siteId, { key, value, tags = [], confidence = "medium" }) {
  const site = await getSite(siteId);
  if (!site) return { error: "站点不存在", code: "NOT_FOUND" };
  const fact = {
    id: "f_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    key: String(key || "").substring(0, 120) || `fact-${Date.now().toString(36)}`,
    value: String(value || "").substring(0, 2000),
    source: "user", // 手动标记发现（用户笔记，非 AI 黑板）
    confidence: String(confidence || "medium"),
    tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
    createdAt: Date.now()
  };
  site.facts = site.facts || [];
  site.facts.push(fact);
  if (site.facts.length > 500) site.facts = site.facts.slice(-500);
  await saveSite(site);
  return { ok: true, fact, total: site.facts.length };
}

export async function removeSiteFact(siteId, factId) {
  const site = await getSite(siteId);
  if (!site) return { error: "站点不存在", code: "NOT_FOUND" };
  site.facts = (site.facts || []).filter(f => f.id !== factId);
  await saveSite(site);
  return { ok: true };
}

// --- 任务模板（站点级，用户主导自动化入口） ---
export async function addSiteTemplate(siteId, tpl) {
  const site = await getSite(siteId);
  if (!site) return { error: "站点不存在", code: "NOT_FOUND" };
  const template = {
    id: "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    name: String(tpl.name || "未命名模板").substring(0, 50),
    desc: String(tpl.desc || "").substring(0, 200),
    kind: ["dir_scan", "api_enum", "inject_verify", "param_fuzz", "custom"].includes(tpl.kind) ? tpl.kind : "custom",
    params: tpl.params || { url: "", payload: "" },
    defaults: tpl.defaults || {},
    instructions: String(tpl.instructions || "").substring(0, 4000),
    createdAt: Date.now()
  };
  site.templates = site.templates || [];
  site.templates.push(template);
  await saveSite(site);
  return { ok: true, template };
}

export async function deleteSiteTemplate(siteId, templateId) {
  const site = await getSite(siteId);
  if (!site) return { error: "站点不存在", code: "NOT_FOUND" };
  site.templates = (site.templates || []).filter(t => t.id !== templateId);
  await saveSite(site);
  return { ok: true };
}

// 由当前 URL 推导建议的站点 scope（主域名）
export function deriveScopeFromUrl(url) {
  try {
    const u = new URL(url);
    return [u.origin];
  } catch (e) { return []; }
}