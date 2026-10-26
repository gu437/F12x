// ==== 对象引用提取与类型保持变形（方案 009 / P3） ====
// 纯函数：不依赖 chrome，便于 L1 单测。

const ID_NAME = /(^|[_-])(id|uid|user|userid|account|accountid|order|orderid|tenant|owner|no|num|role|org)([_-]|$)/i;
function idName(k) {
  const s = String(k || "");
  if (/^(id|uid|user|userid|account|accountid|order|orderid|tenant|owner|no|num|role|org)$/i.test(s)) return true;
  return ID_NAME.test(s.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64ISH = /^[A-Za-z0-9+/=_-]{12,}$/;

function refKind(value) {
  const s = String(value == null ? "" : value);
  if (/^\d+$/.test(s)) return "number";
  if (UUID.test(s)) return "uuid";
  if (B64ISH.test(s) && /\d/.test(s)) return "opaque";
  return "";
}

function addRef(out, ref) {
  if (!ref || ref.value == null || ref.value === "") return;
  if (out.some((x) => x.id === ref.id)) return;
  out.push(ref);
}

export function extractRefs(template = {}) {
  const out = [];
  let u;
  try { u = new URL(template.url || ""); } catch (e) { u = null; }
  const method = String(template.method || "GET").toUpperCase();

  if (u) {
    // path 段：数字 / UUID / 长 base64；以及紧邻 id 的段
    const segs = u.pathname.split("/");
    segs.forEach((seg, i) => {
      if (!seg) return;
      const kind = refKind(seg);
      const prev = segs[i - 1] || "";
      if (kind || idName(prev)) {
        addRef(out, { id: `path:${i}`, where: "path", index: i, label: `路径段 ${i}（${prev || "/"}）`, value: seg, kind: kind || "string" });
      }
    });
    // query：id 类参数或值本身像对象引用
    for (const [k, v] of u.searchParams.entries()) {
      const kind = refKind(v);
      if (kind || idName(k)) {
        addRef(out, { id: `query:${k}`, where: "query", key: k, label: `查询参数 ${k}`, value: v, kind: kind || "string" });
      }
    }
  }

  // JSON body：递归找 id 类键或对象引用值
  if (template.body && typeof template.body === "string" && /^\s*[\[{]/.test(template.body)) {
    try {
      const obj = JSON.parse(template.body);
      const walk = (node, path) => {
        if (Array.isArray(node)) { node.forEach((v, i) => walk(v, path.concat([i]))); return; }
        if (!node || typeof node !== "object") return;
        for (const [k, v] of Object.entries(node)) {
          const p = path.concat([k]);
          if (v && typeof v === "object") walk(v, p);
          else {
            const kind = refKind(v);
            if (kind || idName(k)) {
              const dot = p.map((x) => typeof x === "number" ? `[${x}]` : `.${x}`).join("").replace(/^\./, "");
              addRef(out, { id: `json:${dot}`, where: "json", path: p, label: `JSON ${dot}`, value: String(v), kind: kind || "string" });
            }
          }
        }
      };
      walk(obj, []);
    } catch (e) { /* 非 JSON 不提取 */ }
  }

  // 头：身份/租户/角色类
  for (const [k, v] of Object.entries(template.headers || {})) {
    if (idName(k)) addRef(out, { id: `header:${k}`, where: "header", key: k, label: `请求头 ${k}`, value: String(v), kind: refKind(v) || "string" });
  }

  return { ok: true, refs: out, method };
}

function castLike(original, value) {
  const s = String(value == null ? "" : value);
  if (typeof original === "number") {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (typeof original === "boolean") return s === "true";
  return s;
}

function setJsonPath(obj, path, value) {
  let node = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (node[k] == null) node[k] = typeof path[i + 1] === "number" ? [] : {};
    node = node[k];
  }
  const last = path[path.length - 1];
  node[last] = castLike(node[last], value);
}

export function applyRef(template = {}, ref, value) {
  const next = {
    method: template.method,
    url: String(template.url || ""),
    headers: { ...(template.headers || {}) },
    body: template.body == null ? null : String(template.body),
  };
  if (ref.where === "path") {
    const u = new URL(next.url);
    const segs = u.pathname.split("/");
    segs[ref.index] = String(value);
    u.pathname = segs.join("/");
    next.url = u.toString();
  } else if (ref.where === "query") {
    const u = new URL(next.url);
    u.searchParams.set(ref.key, String(value));
    next.url = u.toString();
  } else if (ref.where === "header") {
    next.headers[ref.key] = String(value);
  } else if (ref.where === "json") {
    const obj = JSON.parse(next.body || "{}");
    setJsonPath(obj, ref.path, value);
    next.body = JSON.stringify(obj);
  }
  return next;
}

export function valuesFromText(text, limit = 50) {
  const rows = String(text || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  return [...new Set(rows)].slice(0, limit);
}

export function candidatesFor(ref, mode = "neighbors", n = 5) {
  const v = String(ref.value);
  if (mode === "range" && /^\d+$/.test(v)) {
    const base = Number(v), out = [];
    for (let i = 1; i <= n; i++) out.push(String(base + i));
    return out;
  }
  if (mode === "neighbors" && /^\d+$/.test(v)) {
    const base = Number(v), out = [];
    for (let i = -2; i <= 2; i++) if (i !== 0) out.push(String(base + i));
    return out;
  }
  return [];
}
