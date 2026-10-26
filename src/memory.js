// F12x memory 模块（模块化拆分，纯搬移零逻辑变更）

export const PROJECTS_KEY = "projects_v2"; // 旧：单键 map，仅用于迁移
export const PROJECTS_INDEX_KEY = "projects_index_v2";
export const CONVERSATIONS_KEY = "conversations_v2";
export const ACTIVE_KEY = "active_conv_v2";
// AI 全局黑板：AI 引擎所有黑板操作（发现/结论/工具事实）的统一归属（AI 数据独立于用户工作区）
export const AI_PROJECT_ID = "__ai__";

// === 项目（唯一持久化容器：黑板 / Issue / 模板 / 会话） ===
// 布局：projects_index_v2（元数据）+ project:<id>（项目全文），与会话一致——保存只写一个项目 + 小索引。
const projectKey = (id) => "project:" + id;

function projMeta(p) {
  return {
    id: p.id, name: p.name || "未命名项目", desc: String(p.desc || "").substring(0, 200),
    createdAt: p.createdAt || Date.now(), updatedAt: p.updatedAt || p.createdAt || Date.now(),
    factsCount: (p.facts || []).length,
    issueCount: (p.issues || []).length,
    templateCount: (p.templates || []).length,
  };
}

async function readProjectIndex() {
  const r = await chrome.storage.local.get(PROJECTS_INDEX_KEY);
  return Array.isArray(r[PROJECTS_INDEX_KEY]) ? r[PROJECTS_INDEX_KEY] : [];
}

let _projChain = Promise.resolve();
function serialProj(fn) {
  const next = _projChain.then(fn, fn);
  _projChain = next.catch(() => {});
  return next;
}

// 旧 projects_v2（单键 map）→ 索引 + 每项目一键；幂等
export async function migrateProjectsIfNeeded() {
  const r = await chrome.storage.local.get([PROJECTS_KEY, PROJECTS_INDEX_KEY]);
  const legacy = r[PROJECTS_KEY];
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
    if (r[PROJECTS_KEY] !== undefined) await chrome.storage.local.remove(PROJECTS_KEY);
    return { migrated: 0 };
  }
  if (Array.isArray(r[PROJECTS_INDEX_KEY]) && r[PROJECTS_INDEX_KEY].length) {
    await chrome.storage.local.remove(PROJECTS_KEY);
    return { migrated: 0 };
  }
  const list = Object.values(legacy).filter((p) => p && p.id);
  const patch = {};
  const index = [];
  for (const p of list) {
    const full = { facts: [], issues: [], templates: [], ...p };
    patch[projectKey(p.id)] = full;
    index.push(projMeta(full));
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (index.length) await chrome.storage.local.set({ [PROJECTS_INDEX_KEY]: index });
  await chrome.storage.local.remove(PROJECTS_KEY);
  return { migrated: index.length };
}

export async function listProjects() {
  const [idxR, convR] = await Promise.all([
    chrome.storage.local.get(PROJECTS_INDEX_KEY),
    chrome.storage.local.get("conversations_index_v2"),
  ]);
  const index = Array.isArray(idxR[PROJECTS_INDEX_KEY]) ? idxR[PROJECTS_INDEX_KEY] : [];
  const convs = Array.isArray(convR["conversations_index_v2"]) ? convR["conversations_index_v2"] : [];
  const convCount = {};
  for (const c of convs) if (c.projectId) convCount[c.projectId] = (convCount[c.projectId] || 0) + 1;
  return index
    .map((m) => ({ ...m, convCount: convCount[m.id] || 0 }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getProject(projectId) {
  if (!projectId) return null;
  const r = await chrome.storage.local.get(projectKey(projectId));
  const p = r[projectKey(projectId)] || null;
  if (p) return p;
  try {
    const m = await migrateProjectsIfNeeded();
    if (m.migrated) {
      const r2 = await chrome.storage.local.get(projectKey(projectId));
      return r2[projectKey(projectId)] || null;
    }
  } catch (e) { /* 迁移失败按不存在处理 */ }
  return null;
}

export function saveProject(project) {
  if (!project?.id) return Promise.resolve();
  return serialProj(() => saveProjectInner(project));
}

async function saveProjectInner(project) {
  project.updatedAt = Date.now();
  const index = await readProjectIndex();
  const meta = projMeta(project);
  const i = index.findIndex((m) => m.id === project.id);
  if (i >= 0) index[i] = meta; else index.push(meta);
  await chrome.storage.local.set({ [projectKey(project.id)]: project });
  await chrome.storage.local.set({ [PROJECTS_INDEX_KEY]: index });
}

export async function createProject(name, desc) {
  const id = "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const project = {
    id, name: String(name || "未命名项目").substring(0, 50),
    desc: String(desc || "").substring(0, 200),
    facts: [], issues: [], templates: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  await saveProject(project);
  return project;
}

export function deleteProject(projectId) {
  return serialProj(() => deleteProjectInner(projectId));
}

async function deleteProjectInner(projectId) {
  const index = (await readProjectIndex()).filter((m) => m.id !== projectId);
  await chrome.storage.local.set({ [PROJECTS_INDEX_KEY]: index });
  await chrome.storage.local.remove(projectKey(projectId));
  // 解绑会话（分键布局：逐个改 projectId，不再依赖旧的全量数组）
  try {
    const convs = await listConversations();
    for (const m of convs) {
      if (m.projectId !== projectId) continue;
      const c = await getConversation(m.convId);
      if (c) { c.projectId = null; await saveConversation(c); }
    }
  } catch (e) { /* 解绑失败不阻断删除 */ }
}

export async function renameProject(projectId, name) {
  const project = await getProject(projectId);
  if (!project) return null;
  project.name = String(name || "").substring(0, 50) || project.name;
  await saveProject(project);
  return { id: project.id, name: project.name };
}

// 项目内实体（Issue / 模板）——用户不主动删除就不清空
async function mutateProject(projectId, fn) {
  return serialProj(async () => {
    const project = await getProject(projectId);
    if (!project) return { error: `项目不存在: ${projectId}`, code: "NOT_FOUND" };
    const out = fn(project) || {};
    await saveProjectInner(project);
    return { ok: true, ...out };
  });
}

export async function removeProjectFact(projectId, key) {
  return mutateProject(projectId, (p) => {
    const before = (p.facts || []).length;
    p.facts = (p.facts || []).filter((f) => f.key !== key);
    return { removed: before - p.facts.length };
  });
}

export async function addProjectIssue(projectId, issue = {}) {
  return mutateProject(projectId, (p) => {
    p.issues = Array.isArray(p.issues) ? p.issues : [];
    const it = {
      id: "iss_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
      title: String(issue.title || "未命名").substring(0, 200),
      sev: String(issue.sev || "medium").substring(0, 20),
      status: String(issue.status || "open").substring(0, 20),
      method: String(issue.method || "").substring(0, 12),
      url: String(issue.url || "").substring(0, 2000),
      desc: String(issue.desc || "").substring(0, 20000),
      evidence: String(issue.evidence || "").substring(0, 50000),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    p.issues.push(it);
    return { issue: it };
  });
}

export async function updateProjectIssue(projectId, issueId, patch = {}) {
  return mutateProject(projectId, (p) => {
    const it = (p.issues || []).find((x) => x.id === issueId);
    if (!it) return { error: "Issue 不存在", code: "NOT_FOUND" };
    for (const k of ["title", "sev", "status", "method", "url", "desc", "evidence"]) {
      if (patch[k] !== undefined) it[k] = String(patch[k]).substring(0, k === "evidence" ? 50000 : 20000);
    }
    it.updatedAt = Date.now();
    return { issue: it };
  });
}

export async function removeProjectIssue(projectId, issueId) {
  return mutateProject(projectId, (p) => {
    const before = (p.issues || []).length;
    p.issues = (p.issues || []).filter((x) => x.id !== issueId);
    return { removed: before - p.issues.length };
  });
}

export async function addProjectTemplate(projectId, tpl = {}) {
  return mutateProject(projectId, (p) => {
    p.templates = Array.isArray(p.templates) ? p.templates : [];
    const it = {
      id: "tpl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
      name: String(tpl.name || "未命名模板").substring(0, 80),
      kind: String(tpl.kind || "custom").substring(0, 30),
      desc: String(tpl.desc || "").substring(0, 500),
      params: tpl.params && typeof tpl.params === "object" ? tpl.params : {},
      instructions: String(tpl.instructions || "").substring(0, 5000),
      createdAt: Date.now(),
    };
    p.templates.push(it);
    return { template: it };
  });
}

export async function removeProjectTemplate(projectId, templateId) {
  return mutateProject(projectId, (p) => {
    const before = (p.templates || []).length;
    p.templates = (p.templates || []).filter((x) => x.id !== templateId);
    return { removed: before - p.templates.length };
  });
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
    // 来源：user=人工录入/标记为发现；ai=模型自动沉淀（并进站点黑板后靠它区分）
    source: fact.source === "user" || fact.source === "ai" ? fact.source : (fact.auto === true ? "ai" : "user"),
    createdAt: Date.now()
  };
  const idx = facts.findIndex(f => f.key === entry.key);
  if (idx >= 0) {
    const prev = facts[idx];
    // 收敛：内容未变的重复自动沉淀（同结论 steering/兜底）不再刷新时间戳、不重复写库
    if (prev.category === entry.category && prev.summary === entry.summary && prev.body === entry.body && prev.confidence === entry.confidence && prev.auto === entry.auto && prev.source === entry.source) {
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
    .map(f => ({ key: f.key, summary: f.summary, body: f.body, confidence: f.confidence, convId: f.convId || "", source: f.source || (f.auto ? "ai" : "user"), createdAt: f.createdAt }))
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

// === 会话截图（方案 001 / P5）：按会话存储、无数量上限、删会话级联 ===
const shotKey = (convId, key) => `shot:${convId}:${key}`;
const shotIndexKey = (convId) => `shot_index:${convId}`;

export async function saveShot(convId, key, dataUrl) {
  if (!convId || !key || !dataUrl) return;
  await chrome.storage.local.set({ [shotKey(convId, key)]: dataUrl });
  const r = await chrome.storage.local.get(shotIndexKey(convId));
  const list = Array.isArray(r[shotIndexKey(convId)]) ? r[shotIndexKey(convId)] : [];
  if (!list.includes(key)) list.push(key);
  await chrome.storage.local.set({ [shotIndexKey(convId)]: list });
}

export async function deleteShots(convId) {
  const r = await chrome.storage.local.get(shotIndexKey(convId));
  const list = Array.isArray(r[shotIndexKey(convId)]) ? r[shotIndexKey(convId)] : [];
  const drop = list.map((k) => shotKey(convId, k)).concat([shotIndexKey(convId)]);
  if (drop.length) await chrome.storage.local.remove(drop);
}

// === 会话（独立对话，可关联项目） ===
// 存储布局（性能修复）：索引 + 每会话一键。
//   旧：conversations_v2 = 全量数组 —— 每次保存重写所有会话（agent 每 700ms flush 一次），
//       列表接口还要逐会话再读一遍全数组（O(N²)），会话一多就卡。
//   新：conversations_index_v2 = 轻量元数据（KB 级）；conv:<id> = 单个会话全文。
//       保存只写"一个会话 + 小索引"，读取列表只读索引，与历史会话数无关。
const CONV_INDEX_KEY = "conversations_index_v2";
const CONV_KEY_PREFIX = "conv:";
const CONV_MAX = 100;
const convKey = (convId) => CONV_KEY_PREFIX + convId;

function convMeta(c) {
  return {
    convId: c.convId,
    title: c.title || "新对话",
    projectId: c.projectId || null,
    modelId: c.modelId || null,
    type: c.type === "task" ? "task" : "chat",
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now(),
    goal: String(c.goal || "").substring(0, 200),
    msgCount: Array.isArray(c.messages) ? c.messages.length : 0,
    auditCount: Array.isArray(c.audit) ? c.audit.length : 0,
    eventsCount: Array.isArray(c.events) ? c.events.length : 0
  };
}

async function readConvIndex() {
  const r = await chrome.storage.local.get(CONV_INDEX_KEY);
  return Array.isArray(r[CONV_INDEX_KEY]) ? r[CONV_INDEX_KEY] : [];
}

// 写索引：保持"新→旧"，超上限时优先淘汰非活跃会话（连会话正文一起删，避免泄漏）
async function writeConvIndex(index) {
  const r = await chrome.storage.local.get(ACTIVE_KEY);
  const activeId = r[ACTIVE_KEY];
  let list = index.slice().sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  const dropped = [];
  while (list.length > CONV_MAX) {
    const victim = list.find((m) => m.convId !== activeId) || list[0];
    list = list.filter((m) => m.convId !== victim.convId);
    dropped.push(victim.convId);
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  await chrome.storage.local.set({ [CONV_INDEX_KEY]: list });
  if (dropped.length) await chrome.storage.local.remove(dropped.map(convKey));
  return list;
}

// 旧数据迁移：conversations_v2（全量数组）→ 索引 + 每会话一键；幂等，可重复调用
export async function migrateConversationsIfNeeded() {
  const r = await chrome.storage.local.get([CONVERSATIONS_KEY, CONV_INDEX_KEY]);
  const legacy = r[CONVERSATIONS_KEY];
  if (!Array.isArray(legacy) || !legacy.length) {
    if (r[CONVERSATIONS_KEY] !== undefined) await chrome.storage.local.remove(CONVERSATIONS_KEY);
    return { migrated: 0 };
  }
  if (Array.isArray(r[CONV_INDEX_KEY]) && r[CONV_INDEX_KEY].length) {
    await chrome.storage.local.remove(CONVERSATIONS_KEY); // 已有新布局：旧数组丢弃，避免双份
    return { migrated: 0 };
  }
  const index = [];
  const items = [];
  for (const c of legacy) {
    if (!c?.convId) continue;
    items.push([convKey(c.convId), c]);
    index.push(convMeta(c));
  }
  for (let i = 0; i < items.length; i += 10) {
    await chrome.storage.local.set(Object.fromEntries(items.slice(i, i + 10)));
  }
  if (index.length) await chrome.storage.local.set({ [CONV_INDEX_KEY]: index });
  await chrome.storage.local.remove(CONVERSATIONS_KEY);
  return { migrated: index.length };
}

// 列表：只读索引（不再逐会话读全量）
export async function listConversations() {
  const [idxR, projR] = await Promise.all([
    chrome.storage.local.get(CONV_INDEX_KEY),
    chrome.storage.local.get(PROJECTS_KEY),
  ]);
  const index = Array.isArray(idxR[CONV_INDEX_KEY]) ? idxR[CONV_INDEX_KEY] : [];
  const projects = projR[PROJECTS_KEY] || {};
  return index
    .map((m) => ({ ...m, projectName: m.projectId ? (projects[m.projectId]?.name || "已删除项目") : null }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getConversation(convId) {
  if (!convId) return null;
  const r = await chrome.storage.local.get(convKey(convId));
  const conv = r[convKey(convId)] || null;
  if (conv) return conv;
  // 懒迁移兜底：老库未迁移时按需迁移一次再取
  try {
    const m = await migrateConversationsIfNeeded();
    if (m.migrated) {
      const r2 = await chrome.storage.local.get(convKey(convId));
      return r2[convKey(convId)] || null;
    }
  } catch (e) { /* 迁移失败按不存在处理 */ }
  return null;
}

// 写串行化：flush 与 finalize 可能并发保存不同会话——索引是读-改-写，必须串行避免丢条目
let _convChain = Promise.resolve();
function serialConv(fn) {
  const next = _convChain.then(fn, fn);
  _convChain = next.catch(() => {});
  return next;
}

// 保存：只写当前会话 + 小索引（与历史会话数无关）
export function saveConversation(conv) {
  if (!conv?.convId) return Promise.resolve();
  return serialConv(() => saveConversationInner(conv));
}

async function saveConversationInner(conv) {
  conv.updatedAt = Date.now();
  const index = await readConvIndex();
  const meta = convMeta(conv);
  const i = index.findIndex((m) => m.convId === conv.convId);
  if (i >= 0) index[i] = meta; else index.unshift(meta);
  await chrome.storage.local.set({ [convKey(conv.convId)]: conv });
  await writeConvIndex(index);
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

export function deleteConversation(convId) {
  return serialConv(() => deleteConversationInner(convId));
}

async function deleteConversationInner(convId) {
  const r = await chrome.storage.local.get([CONV_INDEX_KEY, ACTIVE_KEY]);
  const index = (Array.isArray(r[CONV_INDEX_KEY]) ? r[CONV_INDEX_KEY] : []).filter((m) => m.convId !== convId);
  await chrome.storage.local.set({ [CONV_INDEX_KEY]: index });
  if (r[ACTIVE_KEY] === convId) await chrome.storage.local.remove(ACTIVE_KEY);
  // 级联清理：会话正文 + 溢出区（按 spill 索引，不再全库 get(null)）+ 工作区
  const spillKeys = await listSpillKeys(convId);
  const drop = [convKey(convId), spillIndexKey(convId), `workspace:${convId}`]
    .concat(spillKeys.map((k) => spillKey(convId, k)));
  await chrome.storage.local.remove(drop);
  await deleteShots(convId); // 方案 001 / P5：会话截图级联删除
}

export async function getActiveConversation() {
  const r = await chrome.storage.local.get(ACTIVE_KEY);
  const convId = r[ACTIVE_KEY];
  if (convId) {
    const conv = await getConversation(convId);
    if (conv) return conv;
  }
  return await createConversation(null, "新对话"); // 无活跃会话：自动创建独立会话
}

export async function setActiveConversation(convId) {
  await chrome.storage.local.set({ [ACTIVE_KEY]: convId });
}

// === 溢出区（spill）索引：替代原来的 get(null) 全库扫描 ===
export const spillKey = (convId, key) => `spill:${convId}:${key}`;
const spillIndexKey = (convId) => `spill_index:${convId}`;

export async function listSpillKeys(convId) {
  const r = await chrome.storage.local.get(spillIndexKey(convId));
  return Array.isArray(r[spillIndexKey(convId)]) ? r[spillIndexKey(convId)] : [];
}

// 记录一条溢出数据；超出上限时按索引精确删除最旧的（不再 get(null) 全库）
export async function recordSpillKey(convId, key, limit = 30) {
  const cur = await listSpillKeys(convId);
  const next = cur.filter((k) => k !== key).concat(key);
  const removed = next.length > limit ? next.splice(0, next.length - limit) : [];
  await chrome.storage.local.set({ [spillIndexKey(convId)]: next });
  if (removed.length) await chrome.storage.local.remove(removed.map((k) => spillKey(convId, k)));
  return { kept: next, removed };
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
// 站点工作区已下线（方案 001 / P3）：数据一次性迁入项目
// 规则：每个站点 → 同名项目（重名加后缀）；facts/templates 并入；原数据留一份 sites_backup_v1
// ============================================================
export const SITES_BACKUP_KEY = "sites_backup_v1";

export async function migrateSitesToProjectsIfNeeded() {
  const r = await chrome.storage.local.get(["sites_v1", "active_site_v1"]);
  const sites = r.sites_v1;
  if (!sites || typeof sites !== "object" || Array.isArray(sites)) {
    if (r.sites_v1 !== undefined || r.active_site_v1 !== undefined) {
      await chrome.storage.local.remove(["sites_v1", "active_site_v1"]);
    }
    return { migrated: 0 };
  }
  const list = Object.values(sites).filter((x) => x && x.id);
  if (!list.length) {
    await chrome.storage.local.remove(["sites_v1", "active_site_v1"]);
    return { migrated: 0 };
  }
  const index = await readProjectIndex();
  const names = new Set(index.map((m) => m.name));
  let migrated = 0;
  for (const site of list) {
    let name = String(site.name || "站点").substring(0, 50).trim() || "站点";
    if (names.has(name)) {
      let k = 2;
      while (names.has(name + " (" + k + ")")) k++;
      name = name + " (" + k + ")";
    }
    names.add(name);
    const facts = (Array.isArray(site.facts) ? site.facts : []).map((x) => ({
      key: String(x.key || "").substring(0, 120),
      category: "site",
      summary: String(x.value || "").substring(0, 2000),
      confidence: String(x.confidence || "medium").substring(0, 10),
      body: Array.isArray(x.tags) && x.tags.length ? "tags: " + x.tags.join(", ") : "",
      convId: "", auto: false, source: "user",
      createdAt: x.createdAt || Date.now(),
    })).filter((x) => x.key);
    const templates = (Array.isArray(site.templates) ? site.templates : []).map((t) => ({
      id: t.id || "tpl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
      name: String(t.name || "模板").substring(0, 80),
      kind: String(t.kind || "custom").substring(0, 30),
      desc: String(t.desc || "").substring(0, 500),
      params: t.params && typeof t.params === "object" ? t.params : {},
      instructions: String(t.instructions || "").substring(0, 5000),
      createdAt: t.createdAt || Date.now(),
    }));
    const project = {
      id: "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      name,
      desc: (String(site.desc || "").substring(0, 180) + "（由站点工作区迁移）").trim(),
      facts, issues: [], templates,
      createdAt: site.createdAt || Date.now(), updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ [projectKey(project.id)]: project });
    index.push(projMeta(project));
    migrated++;
  }
  await chrome.storage.local.set({ [PROJECTS_INDEX_KEY]: index });
  await chrome.storage.local.set({ [SITES_BACKUP_KEY]: sites }); // 回滚保险（P7 再清理）
  await chrome.storage.local.remove(["sites_v1", "active_site_v1"]);
  return { migrated };
}

// === 当前项目（P4：Issue / 手动黑板等持久数据的归属） ===
export const ACTIVE_PROJECT_KEY = "active_project_v1";

export async function getActiveProjectId() {
  const r = await chrome.storage.local.get(ACTIVE_PROJECT_KEY);
  return r[ACTIVE_PROJECT_KEY] || null;
}

export async function setActiveProjectId(projectId) {
  if (projectId) await chrome.storage.local.set({ [ACTIVE_PROJECT_KEY]: projectId });
  else await chrome.storage.local.remove(ACTIVE_PROJECT_KEY);
}

// 取当前项目；没有就取第一个；一个都没有就建「默认项目」
export async function ensureActiveProject() {
  const activeId = await getActiveProjectId();
  if (activeId) {
    const p = await getProject(activeId);
    if (p) return p;
  }
  const list = await listProjects();
  if (list.length) {
    await setActiveProjectId(list[0].id);
    return await getProject(list[0].id);
  }
  const p = await createProject("默认项目", "自动创建：Issue / 手动黑板等持久数据的默认归属");
  await setActiveProjectId(p.id);
  return p;
}

const newIssueId = () => "iss_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);

// 旧全局 Issue 库（f12x_issues_v1）→「迁移项目（旧数据）」；留 issues_backup_v1 备份；幂等
export async function migrateIssuesToProjectsIfNeeded() {
  const r = await chrome.storage.local.get("f12x_issues_v1");
  const arr = r["f12x_issues_v1"];
  if (!Array.isArray(arr) || !arr.length) {
    if (r["f12x_issues_v1"] !== undefined) await chrome.storage.local.remove("f12x_issues_v1");
    return { migrated: 0 };
  }
  const list = await listProjects();
  const found = list.find((p) => p.name === "迁移项目（旧数据）");
  let pid = found && found.id;
  if (!pid) {
    const p = await createProject("迁移项目（旧数据）", "由旧版全局 Issue 库迁移，可自行改名");
    pid = p.id;
  }
  const project = await getProject(pid);
  project.issues = Array.isArray(project.issues) ? project.issues : [];
  for (const it of arr) {
    if (!it || (!it.title && !it.url)) continue;
    project.issues.push({
      id: it.id || newIssueId(),
      title: String(it.title || "未命名").substring(0, 200),
      sev: String(it.sev || "medium").substring(0, 20),
      status: String(it.status || "open").substring(0, 20),
      method: String(it.method || "").substring(0, 12),
      url: String(it.url || "").substring(0, 2000),
      desc: String(it.desc || "").substring(0, 20000),
      evidence: String(it.evidence || "").substring(0, 50000),
      createdAt: it.createdAt || Date.now(),
      updatedAt: it.updatedAt || it.createdAt || Date.now(),
    });
  }
  await saveProject(project);
  await chrome.storage.local.set({ issues_backup_v1: arr });
  await chrome.storage.local.remove("f12x_issues_v1");
  return { migrated: arr.length, projectId: pid };
}

// === P7 收口：清理已废弃的旧键（迁移备份 sites_backup_v1 / issues_backup_v1 保留一版） ===
export async function cleanupLegacyKeys() {
  const drop = new Set();
  const r = await chrome.storage.local.get(["f12x_scope_v1", "shots_index_v1"]);
  if (r.f12x_scope_v1 !== undefined) drop.add("f12x_scope_v1");
  const legacyShots = Array.isArray(r.shots_index_v1) ? r.shots_index_v1 : [];
  for (const k of legacyShots) if (typeof k === "string" && k.startsWith("shot_")) drop.add(k);
  if (r.shots_index_v1 !== undefined) drop.add("shots_index_v1");
  const legacyKeys = ["conversations_v2", "projects_v2", "sites_v1", "active_site_v1", "f12x_issues_v1"];
  const r2 = await chrome.storage.local.get(legacyKeys);
  for (const k of legacyKeys) if (r2[k] !== undefined) drop.add(k);
  const list = [...drop];
  if (list.length) await chrome.storage.local.remove(list);
  return { removed: list.length, keys: list };
}
