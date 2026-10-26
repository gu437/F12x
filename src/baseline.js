// ==== 基线（方案 009 / P5） ====
// 项目级接口基线：保存一次响应，用于后续同请求/矩阵对比。

export const BASELINE_INDEX_KEY = "baselines_index_v1";
const baselineKey = (id) => `baseline:${id}`;
const BODY_MAX = 2 * 1024 * 1024;

function rid() {
  return "bl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function pathKey(url) {
  let u;
  try { u = new URL(String(url || "")); } catch (e) { return String(url || ""); }
  const path = u.pathname.replace(/\/\d+(?=\/|$)/g, "/{id}")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi, "/{id}")
    .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/{id}");
  return u.origin + path;
}

async function readIndex() {
  const r = await chrome.storage.local.get(BASELINE_INDEX_KEY);
  return Array.isArray(r[BASELINE_INDEX_KEY]) ? r[BASELINE_INDEX_KEY] : [];
}
async function writeIndex(list) { await chrome.storage.local.set({ [BASELINE_INDEX_KEY]: list }); }

export async function saveBaseline(input = {}) {
  const projectId = String(input.projectId || "");
  if (!projectId) return { error: "基线必须归属项目", code: "INVALID" };
  const url = String(input.url || "");
  if (!url) return { error: "URL 必填", code: "INVALID" };
  const body = String(input.body == null ? "" : input.body);
  const id = rid();
  const rec = {
    schema: 1, id, projectId,
    name: String(input.name || "").trim().substring(0, 120) || `${input.method || "GET"} ${pathKey(url)}`,
    method: String(input.method || "GET").toUpperCase(),
    url, pathKey: pathKey(url),
    identityId: input.identityId || "",
    identityName: String(input.identityName || ""),
    status: input.status == null ? null : Number(input.status),
    headers: input.headers && typeof input.headers === "object" ? { ...input.headers } : {},
    body: body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body,
    truncated: body.length > BODY_MAX,
    createdAt: Date.now(),
  };
  await chrome.storage.local.set({ [baselineKey(id)]: rec });
  const idx = await readIndex();
  idx.unshift({
    id, projectId, name: rec.name, method: rec.method, url, pathKey: rec.pathKey,
    status: rec.status, identityId: rec.identityId, createdAt: rec.createdAt,
  });
  await writeIndex(idx);
  return { ok: true, id, name: rec.name };
}

export async function listBaselines(projectId) {
  const idx = await readIndex();
  const rows = projectId ? idx.filter((x) => x.projectId === projectId) : idx;
  return { ok: true, baselines: rows, count: rows.length };
}

export async function getBaseline(id) {
  if (!id) return null;
  const r = await chrome.storage.local.get(baselineKey(id));
  return r[baselineKey(id)] || null;
}

export async function removeBaseline(id) {
  await chrome.storage.local.remove(baselineKey(id));
  await writeIndex((await readIndex()).filter((x) => x.id !== id));
  return { ok: true };
}

export async function deleteProjectBaselines(projectId) {
  const idx = await readIndex();
  const mine = idx.filter((x) => x.projectId === projectId);
  if (mine.length) {
    await chrome.storage.local.remove(mine.map((x) => baselineKey(x.id)));
    await writeIndex(idx.filter((x) => x.projectId !== projectId));
  }
  return mine.length;
}
