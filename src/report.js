// ==== 报告与脱敏（方案 009 / P6） ====
// HTML 单文件 / Markdown；默认脱敏 Cookie/Authorization/JWT/邮箱/手机/内网 IP。

const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i;

function redactText(input) {
  let s = String(input == null ? "" : input);
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED:JWT]");
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [REDACTED]");
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{1,}\b/g, "[EMAIL]");
  s = s.replace(/\b1[3-9]\d{9}\b/g, "[PHONE]");
  s = s.replace(/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[INTERNAL-IP]");
  s = s.replace(/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "[INTERNAL-IP]");
  s = s.replace(/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, "[INTERNAL-IP]");
  s = s.replace(/([?&](?:token|access_token|key|secret|password|passwd|session|auth)=)[^&\s]+/gi, "$1[REDACTED]");
  s = s.replace(/\b[0-9a-f]{32,}\b/gi, "[REDACTED:HEX]");
  return s;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = SENSITIVE_HEADER.test(k) ? "[REDACTED]" : redactText(v);
  return out;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function headerText(h, redact) {
  const o = redact ? redactHeaders(h) : (h || {});
  return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\n");
}

function evidenceBlock(ev, redact, format) {
  const r = ev.request || {}, p = ev.response || {};
  const url = redact ? redactText(r.url) : r.url;
  const reqH = headerText(r.headers, redact);
  const resH = headerText(p.headers, redact);
  const reqB = redact ? redactText(r.body) : (r.body || "");
  const resB = redact ? redactText(p.body) : (p.body || "");
  const diffLines = [];
  if (ev.diff && ev.diff.json) {
    for (const x of (ev.diff.added || []).slice(0, 50)) diffLines.push(`+ ${x.path} = ${JSON.stringify(x.value)}`);
    for (const x of (ev.diff.removed || []).slice(0, 50)) diffLines.push(`- ${x.path} = ${JSON.stringify(x.value)}`);
    for (const x of (ev.diff.changed || []).slice(0, 50)) diffLines.push(`~ ${x.path}: ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`);
  }
  if (format === "md") {
    return [
      `#### 证据：${ev.title || ev.id}`,
      "", `\`${r.method || "GET"} ${url}\``,
      "```http", reqH, "", reqB, "```",
      `响应：${p.status == null ? "-" : p.status}`, "```http", resH, "", resB, "```",
      diffLines.length ? "差异：\n```diff\n" + diffLines.join("\n") + "\n```" : "",
      ev.hash ? `\`${ev.hash}\`` : "",
    ].filter(Boolean).join("\n");
  }
  return `<section class="ev">
    <h4>证据：${esc(ev.title || ev.id)}</h4>
    <div class="reqline">${esc(r.method || "GET")} ${esc(url)}</div>
    <h5>请求头</h5><pre>${esc(reqH)}</pre>
    <h5>请求体</h5><pre>${esc(reqB)}</pre>
    <h5>响应 ${esc(p.status == null ? "-" : String(p.status))}</h5>
    <pre>${esc(resH)}</pre>
    <h5>响应体</h5><pre>${esc(resB)}</pre>
    ${diffLines.length ? `<h5>差异</h5><pre class="diff">${esc(diffLines.join("\n"))}</pre>` : ""}
    ${ev.hash ? `<div class="hash">${esc(ev.hash)}</div>` : ""}
  </section>`;
}

export function buildReport({ project, issues, evidenceMap = {}, format = "html", redact = true } = {}) {
  const p = project || {};
  const list = issues || p.issues || [];
  const generated = new Date().toLocaleString();
  if (format === "md") {
    const lines = [`# F12x 报告 · ${p.name || "项目"}`, "", `生成时间：${generated}${redact ? "（已脱敏）" : ""}`, ""];
    for (const it of list) {
      lines.push(`## ${it.title || "未命名"}`, "", `- 严重度：${it.sev || "-"}`, `- 状态：${it.status || "-"}`, `- 目标：${redact ? redactText(it.url || "") : it.url || ""}`, "");
      if (it.desc) lines.push("### 描述", "", redact ? redactText(it.desc) : it.desc, "");
      if (it.evidence) lines.push("### 证据说明", "", redact ? redactText(it.evidence) : it.evidence, "");
      for (const eid of (it.evidenceIds || [])) {
        const ev = evidenceMap[eid];
        if (ev) lines.push(evidenceBlock(ev, redact, "md"), "");
      }
    }
    return lines.join("\n");
  }
  const body = list.map((it) => `<article class="issue">
    <h2>${esc(it.title || "未命名")} <span class="sev">${esc(it.sev || "-")}</span></h2>
    <div class="meta">状态：${esc(it.status || "-")} · 目标：${esc(redact ? redactText(it.url || "") : it.url || "")}</div>
    ${it.desc ? `<h3>描述</h3><p>${esc(redact ? redactText(it.desc) : it.desc)}</p>` : ""}
    ${it.evidence ? `<h3>证据说明</h3><p>${esc(redact ? redactText(it.evidence) : it.evidence)}</p>` : ""}
    ${(it.evidenceIds || []).map((eid) => evidenceMap[eid] ? evidenceBlock(evidenceMap[eid], redact, "html") : "").join("")}
  </article>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>F12x 报告 · ${esc(p.name || "项目")}</title>
<style>
body{font:14px/1.6 system-ui,"Segoe UI",sans-serif;max-width:980px;margin:32px auto;padding:0 20px;color:#111}
h1{margin:0 0 4px}h2{margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
h3{margin:16px 0 4px;font-size:14px}h4{margin:18px 0 4px}h5{margin:10px 0 2px;font-size:12px;color:#555}
.meta,.hash,.reqline{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#666;word-break:break-all}
pre{background:#f6f8fa;border:1px solid #e5e7eb;border-radius:6px;padding:8px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-all}
pre.diff{background:#fbf7ff}.sev{font-size:11px;background:#eee;border-radius:4px;padding:1px 6px;vertical-align:middle}
.ev{border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;margin:10px 0}
.note{color:#666;font-size:12px}
@media print{body{margin:0}.ev{break-inside:avoid}}
</style></head><body>
<h1>F12x 报告 · ${esc(p.name || "项目")}</h1>
<div class="meta">生成时间：${esc(generated)}${redact ? " · 已脱敏" : ""} · Issue ${list.length} 条</div>
${body || '<p class="note">暂无 Issue</p>'}
</body></html>`;
}
