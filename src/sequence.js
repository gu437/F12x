// ==== 序列（方案 009 / P4） ====
// 项目级多步请求：变量替换、JSON/header/regex 提取、整链顺序执行。

export const SEQUENCE_INDEX_KEY = "sequences_index_v1";
const sequenceKey = (id) => `sequence:${id}`;

function rid() {
  return "seq_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

export function applyVars(text, vars = {}) {
  return String(text == null ? "" : text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

export function unresolvedVars(text) {
  const out = [];
  String(text == null ? "" : text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => { out.push(k); return m; });
  return [...new Set(out)];
}

function getPath(obj, path) {
  const parts = String(path || "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let node = obj;
  for (const p of parts) {
    if (node == null) return undefined;
    node = node[p];
  }
  return node;
}

export function extractVar(source, rule) {
  const text = source && typeof source === "object" ? JSON.stringify(source) : String(source == null ? "" : source);
  if (rule.regex) {
    try {
      const m = text.match(new RegExp(rule.regex));
      return m ? (m[1] != null ? m[1] : m[0]) : "";
    } catch (e) { return ""; }
  }
  if (rule.from === "header") {
    const h = source && typeof source === "object" ? source : {};
    const key = Object.keys(h).find((k) => k.toLowerCase() === String(rule.path || "").toLowerCase());
    const v = key ? h[key] : "";
    return v == null ? "" : String(v);
  }
  try {
    const obj = typeof source === "string" ? JSON.parse(source) : source;
    const v = getPath(obj, rule.path);
    return v == null ? "" : String(v);
  } catch (e) { return ""; }
}

async function readIndex() {
  const r = await chrome.storage.local.get(SEQUENCE_INDEX_KEY);
  return Array.isArray(r[SEQUENCE_INDEX_KEY]) ? r[SEQUENCE_INDEX_KEY] : [];
}
async function writeIndex(list) { await chrome.storage.local.set({ [SEQUENCE_INDEX_KEY]: list }); }

function normStep(s = {}) {
  return {
    id: s.id || "st_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    name: String(s.name || "").substring(0, 80),
    method: String(s.method || "GET").toUpperCase(),
    url: String(s.url || ""),
    headers: s.headers && typeof s.headers === "object" ? { ...s.headers } : {},
    body: s.body == null ? null : String(s.body),
    identityId: s.identityId || "",
    extract: Array.isArray(s.extract) ? s.extract.slice(0, 20).map((e) => ({
      name: String(e.name || "").substring(0, 40),
      from: e.from === "header" ? "header" : "body",
      path: String(e.path || "").substring(0, 200),
      regex: String(e.regex || "").substring(0, 300),
    })) : [],
  };
}

export async function saveSequence(input = {}) {
  const projectId = String(input.projectId || "");
  if (!projectId) return { error: "序列必须归属项目", code: "INVALID" };
  const name = String(input.name || "").trim().substring(0, 80);
  if (!name) return { error: "序列名称必填", code: "INVALID" };
  const steps = Array.isArray(input.steps) ? input.steps.slice(0, 50).map(normStep) : [];
  const id = input.id || rid();
  const now = Date.now();
  const rec = {
    schema: 1, id, projectId, name,
    description: String(input.description || "").substring(0, 300),
    steps, createdAt: input.createdAt || now, updatedAt: now,
  };
  await chrome.storage.local.set({ [sequenceKey(id)]: rec });
  const idx = await readIndex();
  const meta = { id, projectId, name, stepCount: steps.length, updatedAt: now };
  const i = idx.findIndex((x) => x.id === id);
  if (i >= 0) idx[i] = meta; else idx.unshift(meta);
  await writeIndex(idx);
  return { ok: true, id, meta };
}

export async function listSequences(projectId) {
  const idx = await readIndex();
  const rows = projectId ? idx.filter((x) => x.projectId === projectId) : idx;
  return { ok: true, sequences: rows, count: rows.length };
}

export async function getSequence(id) {
  if (!id) return null;
  const r = await chrome.storage.local.get(sequenceKey(id));
  return r[sequenceKey(id)] || null;
}

export async function removeSequence(id) {
  await chrome.storage.local.remove(sequenceKey(id));
  await writeIndex((await readIndex()).filter((x) => x.id !== id));
  return { ok: true };
}

export async function deleteProjectSequences(projectId) {
  const idx = await readIndex();
  const mine = idx.filter((x) => x.projectId === projectId);
  if (mine.length) {
    await chrome.storage.local.remove(mine.map((x) => sequenceKey(x.id)));
    await writeIndex(idx.filter((x) => x.projectId !== projectId));
  }
  return mine.length;
}
