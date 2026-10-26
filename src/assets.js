// ==== 项目请求资产 / 端点清单（方案 009 / P7） ====
// 请求：可复用、可带 {{变量}}；端点：从当前网络缓冲聚合（只记录观察到的）。

export const REQUEST_INDEX_KEY = "requests_index_v1";
const requestKey = (id) => `request:${id}`;
const inventoryKey = (projectId) => `inventory:${projectId}`;

function rid() {
  return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function normHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (k) out[String(k)] = String(v == null ? "" : v);
  return out;
}

export function requestVars(text) {
  const out = [];
  String(text == null ? "" : text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => { if (!out.includes(k)) out.push(k); return m; });
  return out;
}

export async function saveRequest(input = {}) {
  const projectId = String(input.projectId || "");
  if (!projectId) return { error: "请求必须归属项目", code: "INVALID" };
  const url = String(input.url || "").trim();
  if (!url) return { error: "URL 必填", code: "INVALID" };
  const id = input.id || rid();
  const now = Date.now();
  const rec = {
    schema: 1, id, projectId,
    name: String(input.name || "").trim().substring(0, 120) || `${input.method || "GET"} ${url}`.substring(0, 120),
    method: String(input.method || "GET").toUpperCase(),
    url,
    headers: normHeaders(input.headers),
    body: input.body == null ? "" : String(input.body),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 20) : [],
    notes: String(input.notes || "").substring(0, 2000),
    createdAt: input.createdAt || now, updatedAt: now,
  };
  await chrome.storage.local.set({ [requestKey(id)]: rec });
  const idx = ((await chrome.storage.local.get(REQUEST_INDEX_KEY))[REQUEST_INDEX_KEY] || []);
  const list = Array.isArray(idx) ? idx : [];
  const meta = { id, projectId, name: rec.name, method: rec.method, url, updatedAt: now };
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = meta; else list.unshift(meta);
  await chrome.storage.local.set({ [REQUEST_INDEX_KEY]: list });
  return { ok: true, id, meta };
}

export async function listRequests(projectId) {
  const r = await chrome.storage.local.get(REQUEST_INDEX_KEY);
  const list = Array.isArray(r[REQUEST_INDEX_KEY]) ? r[REQUEST_INDEX_KEY] : [];
  const rows = projectId ? list.filter((x) => x.projectId === projectId) : list;
  return { ok: true, requests: rows, count: rows.length };
}

export async function getRequest(id) {
  if (!id) return null;
  const r = await chrome.storage.local.get(requestKey(id));
  return r[requestKey(id)] || null;
}

export async function removeRequest(id) {
  await chrome.storage.local.remove(requestKey(id));
  const r = await chrome.storage.local.get(REQUEST_INDEX_KEY);
  const list = Array.isArray(r[REQUEST_INDEX_KEY]) ? r[REQUEST_INDEX_KEY] : [];
  await chrome.storage.local.set({ [REQUEST_INDEX_KEY]: list.filter((x) => x.id !== id) });
  return { ok: true };
}

export async function deleteProjectRequests(projectId) {
  const r = await chrome.storage.local.get(REQUEST_INDEX_KEY);
  const list = Array.isArray(r[REQUEST_INDEX_KEY]) ? r[REQUEST_INDEX_KEY] : [];
  const mine = list.filter((x) => x.projectId === projectId);
  if (mine.length) {
    await chrome.storage.local.remove(mine.map((x) => requestKey(x.id)));
    await chrome.storage.local.set({ [REQUEST_INDEX_KEY]: list.filter((x) => x.projectId !== projectId) });
  }
  await chrome.storage.local.remove(inventoryKey(projectId));
  return mine.length;
}

// —— 端点清单 ——
export function buildInventory(items = []) {
  const map = new Map();
  for (const it of items) {
    let u;
    try { u = new URL(it.url || ""); } catch (e) { continue; }
    const pathKey = u.pathname.replace(/\/\d+(?=\/|$)/g, "/{id}")
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi, "/{id}")
      .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/{id}");
    const key = (it.method || "GET").toUpperCase() + " " + u.origin + pathKey;
    const cur = map.get(key) || {
      method: (it.method || "GET").toUpperCase(), pathKey: u.origin + pathKey,
      sampleUrl: it.url, count: 0, params: [], lastSeen: 0,
    };
    cur.count++;
    cur.lastSeen = Math.max(cur.lastSeen, it.ts || Date.now());
    for (const k of u.searchParams.keys()) if (!cur.params.includes(k)) cur.params.push(k);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 1000);
}

export async function saveInventory(projectId, items) {
  const endpoints = buildInventory(items);
  await chrome.storage.local.set({ [inventoryKey(projectId)]: { schema: 1, projectId, updatedAt: Date.now(), endpoints } });
  return { ok: true, count: endpoints.length, endpoints };
}

export async function getInventory(projectId) {
  const r = await chrome.storage.local.get(inventoryKey(projectId));
  return r[inventoryKey(projectId)] || { schema: 1, projectId, updatedAt: 0, endpoints: [] };
}
