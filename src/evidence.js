// ==== 证据存储（方案 009 / P1） ====
// 索引只放元数据，正文分键；证据不可变；响应体超过 2MB 截断并标记。
// 与项目级联：deleteProjectEvidence(projectId) 由 memory.deleteProject 调用。

const EVIDENCE_INDEX_KEY = "evidence_index_v1";
const EVIDENCE_BODY_MAX = 2 * 1024 * 1024; // 2MB（字符近似）

const evidenceKey = (id) => `evidence:${id}`;

function rid() {
  return "ev_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

async function computeEvidenceHash(parts) {
  const text = [
    String(parts.method || "").toUpperCase(),
    String(parts.url || ""),
    String(parts.requestBody || ""),
    String(parts.status == null ? "" : parts.status),
    String(parts.responseBody || ""),
  ].join("\n");
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return "sha256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    // 极端环境无 SubtleCrypto：退化为长度+简单滚动哈希（仍可用于去重提示）
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return "fnv:" + (h >>> 0).toString(16) + ":" + text.length;
  }
}

function clipBody(body) {
  const s = String(body == null ? "" : body);
  if (s.length <= EVIDENCE_BODY_MAX) return { body: s, truncated: false, originalLength: s.length };
  return { body: s.slice(0, EVIDENCE_BODY_MAX), truncated: true, originalLength: s.length };
}

function normalizeHeaders(h) {
  if (!h || typeof h !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (k) out[String(k)] = String(v == null ? "" : v);
  }
  return out;
}

async function readIndex() {
  const r = await chrome.storage.local.get(EVIDENCE_INDEX_KEY);
  return Array.isArray(r[EVIDENCE_INDEX_KEY]) ? r[EVIDENCE_INDEX_KEY] : [];
}

async function writeIndex(list) {
  await chrome.storage.local.set({ [EVIDENCE_INDEX_KEY]: list });
}

export async function saveEvidence(input = {}) {
  const projectId = String(input.projectId || "");
  if (!projectId) return { error: "证据必须归属项目", code: "INVALID" };
  const id = rid();
  const req = input.request || {};
  const resp = input.response || {};
  const respClip = clipBody(resp.body);
  const hash = await computeEvidenceHash({
    method: req.method, url: req.url, requestBody: req.body,
    status: resp.status, responseBody: respClip.body,
  });
  const now = Date.now();
  const rec = {
    schema: 1,
    id,
    projectId,
    title: String(input.title || "").trim().substring(0, 200) || `${req.method || "GET"} ${req.url || ""}`.substring(0, 200),
    kind: String(input.kind || "request"),
    createdAt: now,
    source: String(input.source || "manual"),
    identityId: input.identityId || null,
    identityName: String(input.identityName || ""),
    request: {
      method: String(req.method || "GET").toUpperCase(),
      url: String(req.url || ""),
      headers: normalizeHeaders(req.headers),
      body: String(req.body == null ? "" : req.body),
      capturedAt: req.capturedAt || now,
    },
    response: {
      status: resp.status == null ? null : Number(resp.status),
      statusText: String(resp.statusText || ""),
      headers: normalizeHeaders(resp.headers),
      body: respClip.body,
      mimeType: String(resp.mimeType || ""),
      size: resp.size == null ? null : Number(resp.size),
      elapsedMs: resp.elapsedMs == null ? null : Number(resp.elapsedMs),
      truncated: respClip.truncated,
      originalLength: respClip.originalLength,
    },
    diff: input.diff || null,
    shots: Array.isArray(input.shots) ? input.shots.slice() : [],
    tags: Array.isArray(input.tags) ? input.tags.map((x) => String(x).substring(0, 30)).slice(0, 20) : [],
    notes: String(input.notes || "").substring(0, 5000),
    hash,
    derivedFrom: input.derivedFrom || null,
  };
  await chrome.storage.local.set({ [evidenceKey(id)]: rec });
  const idx = await readIndex();
  idx.unshift({
    id, projectId, title: rec.title, kind: rec.kind, createdAt: now, source: rec.source,
    identityId: rec.identityId, identityName: rec.identityName,
    status: rec.response.status, method: rec.request.method, url: rec.request.url,
    size: rec.response.size, hash, tags: rec.tags, issueIds: [],
  });
  await writeIndex(idx);
  return { ok: true, id, hash, truncated: rec.response.truncated, originalLength: rec.response.originalLength };
}

export async function listEvidence(projectId) {
  const idx = await readIndex();
  const rows = projectId ? idx.filter((x) => x.projectId === projectId) : idx;
  return { ok: true, evidences: rows, count: rows.length };
}

export async function getEvidence(id) {
  if (!id) return null;
  const r = await chrome.storage.local.get(evidenceKey(id));
  return r[evidenceKey(id)] || null;
}

async function updateMeta(id, patch) {
  const idx = await readIndex();
  const i = idx.findIndex((x) => x.id === id);
  if (i >= 0) { idx[i] = { ...idx[i], ...patch }; await writeIndex(idx); }
}

export async function markEvidenceIssue(id, issueId, attach = true) {
  const idx = await readIndex();
  const i = idx.findIndex((x) => x.id === id);
  if (i < 0) return;
  const set = new Set(idx[i].issueIds || []);
  if (attach) set.add(issueId); else set.delete(issueId);
  idx[i].issueIds = [...set];
  await writeIndex(idx);
}

export async function removeEvidence(id) {
  await chrome.storage.local.remove(evidenceKey(id));
  const idx = await readIndex();
  await writeIndex(idx.filter((x) => x.id !== id));
  return { ok: true };
}

// 项目删除级联：删索引 + 每个正文键
export async function deleteProjectEvidence(projectId) {
  const idx = await readIndex();
  const mine = idx.filter((x) => x.projectId === projectId);
  if (mine.length) {
    await chrome.storage.local.remove(mine.map((x) => evidenceKey(x.id)));
    await writeIndex(idx.filter((x) => x.projectId !== projectId));
  }
  return mine.length;
}
