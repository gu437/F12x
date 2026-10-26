// ==== 语义差异（方案 009 / P5） ====
// JSON 路径级 added/removed/changed；易变字段可忽略；非 JSON 退化为行级摘要。
// 纯函数，不依赖 chrome。

const DEFAULT_IGNORE = /^(timestamp|time|date|requestId|traceId|csrf|csrfToken|nonce|serverTime|expiresAt)$/i;

function parseMaybe(text) {
  if (text && typeof text === "object") return { ok: true, value: text };
  try { return { ok: true, value: JSON.parse(String(text == null ? "" : text)) }; }
  catch (e) { return { ok: false }; }
}

function joinPath(base, key) {
  return typeof key === "number" ? `${base}[${key}]` : `${base}.${key}`;
}

function walk(a, b, path, out, ignore, depth) {
  if (out.added.length + out.removed.length + out.changed.length > 200 || depth > 20) return;
  if (a === b) return;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) { out.changed.push({ path, from: a, to: b, type: `${ta}→${tb}` }); return; }
  if (ta === "array") {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.added.push({ path: joinPath(path, i), value: b[i] });
      else if (i >= b.length) out.removed.push({ path: joinPath(path, i), value: a[i] });
      else walk(a[i], b[i], joinPath(path, i), out, ignore, depth + 1);
    }
    return;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (ignore && ignore.test(k)) continue;
      const p = joinPath(path, k);
      if (!(k in a)) out.added.push({ path: p, value: b[k] });
      else if (!(k in b)) out.removed.push({ path: p, value: a[k] });
      else walk(a[k], b[k], p, out, ignore, depth + 1);
    }
    return;
  }
  out.changed.push({ path, from: a, to: b });
}

export function diffJson(aText, bText, opts = {}) {
  const a = parseMaybe(aText), b = parseMaybe(bText);
  if (!a.ok || !b.ok) {
    const la = String(aText == null ? "" : aText).split("\n");
    const lb = String(bText == null ? "" : bText).split("\n");
    const setA = new Set(la), setB = new Set(lb);
    return {
      json: false,
      addedLines: lb.filter((l) => !setA.has(l)).slice(0, 100),
      removedLines: la.filter((l) => !setB.has(l)).slice(0, 100),
      added: [], removed: [], changed: [],
    };
  }
  const out = { json: true, added: [], removed: [], changed: [] };
  const ignore = opts.ignore === false ? null : (opts.ignore instanceof RegExp ? opts.ignore : DEFAULT_IGNORE);
  walk(a.value, b.value, "$", out, ignore, 0);
  return out;
}

export function diffSummary(d) {
  if (!d) return "";
  if (!d.json) return `文本：+${d.addedLines.length} / -${d.removedLines.length} 行`;
  const parts = [];
  if (d.added.length) parts.push(`新增 ${d.added.length}`);
  if (d.removed.length) parts.push(`删除 ${d.removed.length}`);
  if (d.changed.length) parts.push(`变化 ${d.changed.length}`);
  return parts.length ? parts.join(" · ") : "无字段差异";
}

export function hasFieldDiff(d) {
  return !!(d && (d.added.length || d.removed.length || d.changed.length));
}
