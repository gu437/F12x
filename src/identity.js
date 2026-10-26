// ==== 身份档案（方案 009 / P2） ====
// 项目级身份：Cookie + localStorage/sessionStorage + 认证头。
// 只做存储；抓取/应用在 debugger（需要 CDP 与当前页上下文）。

export const IDENTITY_INDEX_KEY = "identity_index_v1";
const identityKey = (id) => `identity:${id}`;

function rid() {
  return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function normHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const kk = String(k).trim();
    if (!kk || /^cookie$/i.test(kk)) continue; // Cookie 由 CDP 注入，避免 forbidden header
    out[kk] = String(v == null ? "" : v);
  }
  return out;
}

function normStorage(s) {
  const out = { local: {}, session: {} };
  for (const which of ["local", "session"]) {
    const src = s && s[which];
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) out[which][String(k)] = String(v == null ? "" : v);
  }
  return out;
}

async function readIndex() {
  const r = await chrome.storage.local.get(IDENTITY_INDEX_KEY);
  return Array.isArray(r[IDENTITY_INDEX_KEY]) ? r[IDENTITY_INDEX_KEY] : [];
}
async function writeIndex(list) {
  await chrome.storage.local.set({ [IDENTITY_INDEX_KEY]: list });
}

export async function saveIdentity(input = {}) {
  const projectId = String(input.projectId || "");
  if (!projectId) return { error: "身份必须归属项目", code: "INVALID" };
  const name = String(input.name || "").trim().substring(0, 60);
  if (!name) return { error: "身份名称必填", code: "INVALID" };
  const id = input.id || rid();
  const now = Date.now();
  const rec = {
    schema: 1, id, projectId, name,
    description: String(input.description || "").substring(0, 300),
    sourceUrl: String(input.sourceUrl || ""),
    cookies: Array.isArray(input.cookies) ? input.cookies.slice(0, 300).map((c) => ({
      name: String(c.name || ""), value: String(c.value == null ? "" : c.value),
      domain: String(c.domain || ""), path: String(c.path || "/"),
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || "unspecified",
      expirationDate: c.expirationDate == null ? null : Number(c.expirationDate),
      session: !!c.session,
    })) : [],
    storage: normStorage(input.storage),
    headers: normHeaders(input.headers),
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
  await chrome.storage.local.set({ [identityKey(id)]: rec });
  const idx = await readIndex();
  const meta = {
    id, projectId, name, description: rec.description, sourceUrl: rec.sourceUrl,
    cookieCount: rec.cookies.length,
    storageKeys: Object.keys(rec.storage.local).length + Object.keys(rec.storage.session).length,
    headerKeys: Object.keys(rec.headers),
    updatedAt: now,
  };
  const i = idx.findIndex((x) => x.id === id);
  if (i >= 0) idx[i] = meta; else idx.unshift(meta);
  await writeIndex(idx);
  return { ok: true, id, meta };
}

export async function listIdentities(projectId) {
  const idx = await readIndex();
  const rows = projectId ? idx.filter((x) => x.projectId === projectId) : idx;
  return { ok: true, identities: rows, count: rows.length };
}

export async function getIdentity(id) {
  if (!id) return null;
  const r = await chrome.storage.local.get(identityKey(id));
  return r[identityKey(id)] || null;
}

export async function removeIdentity(id) {
  await chrome.storage.local.remove(identityKey(id));
  await writeIndex((await readIndex()).filter((x) => x.id !== id));
  return { ok: true };
}

export async function deleteProjectIdentities(projectId) {
  const idx = await readIndex();
  const mine = idx.filter((x) => x.projectId === projectId);
  if (mine.length) {
    await chrome.storage.local.remove(mine.map((x) => identityKey(x.id)));
    await writeIndex(idx.filter((x) => x.projectId !== projectId));
  }
  return mine.length;
}
