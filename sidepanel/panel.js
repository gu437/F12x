// ============================================================
// F12x panel.js v0.2 — 工具台主导 UI 逻辑（纯视图层）
// 通道：
//   ctrl   sidepanel → bg   手动工具调用（sendMessage 请求-响应）
//   stream bg → sidepanel   采集数据推送 + AI 状态（port 长连接 + sendMessage 兜底）
// 用户的操作作为最高驱动：本文件全部功能不依赖 LLM 配置
// ============================================================

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// --- ctrl 通道：请求-响应 ---
function api(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(resp || { ok: false, error: "无响应" });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

let aiPendingRef = null; // “→ AI”暂存的请求引用，选好会话后自动填入输入框
// ============ 手动 Issue 工作台（用户自主记录漏洞/发现；不依赖 AI；Markdown/HTML 导出） ============
let issues = [];
const ISSUE_SEV = { critical: "严重", high: "高", medium: "中", low: "低", info: "信息" };
const ISSUE_STATUS = { open: "待处理", confirmed: "已确认", fixed: "已修复", wontfix: "不修复" };
function issueRefreshChip() { const c = $("issue-count"); if (c) c.textContent = issues.length ? String(issues.length) : ""; }
// Issue 归属当前项目（方案 001 / P4）：不再有全局 Issue 库
async function issueRefresh() {
  const r = await api("issue:list");
  if (r.ok) { issues = r.issues || []; app.issueProject = r.project || null; }
  issueRefreshChip();
  return r;
}
function issueNew(defaults) {
  const now = Date.now();
  return Object.assign({ id: "iss_" + now.toString(36) + Math.random().toString(36).slice(2, 5), title: "", sev: "medium", status: "open", url: "", method: "", desc: "", evidence: "", createdAt: now, updatedAt: now }, defaults || {});
}
function issueRenderList(listEl, box) {
  if (!issues.length) { listEl.innerHTML = '<div class="placeholder">暂无 Issue：从请求详情“→ Issue”快速新建，或在此手填</div>'; return; }
  listEl.innerHTML = issues.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(it =>
    '<div class="issue-item" data-id="' + esc(it.id) + '">'
    + '<span class="issue-sev sev-' + esc(it.sev) + '">' + esc(ISSUE_SEV[it.sev] || it.sev) + '</span>'
    + '<span class="issue-title">' + esc(it.title || "（未命名）") + '</span>'
    + (it.url ? '<span class="issue-url">' + esc(it.url) + '</span>' : "")
    + '<button class="mini-btn" data-edit="1">编辑</button>'
    + '<button class="mini-btn danger" data-del="1">删除</button>'
    + '</div>').join("");
  listEl.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
    const it = issues.find(x => x.id === b.closest(".issue-item").dataset.id);
    if (it && box) issueFillForm(box, it);
  }));
  listEl.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    const id = b.closest(".issue-item").dataset.id;
    if (!confirm("删除该 Issue？删除后不可恢复")) return;
    const r = await api("issue:delete", { id });
    if (!r.ok) return toast("删除失败：" + (r.error || ""));
    await issueRefresh(); issueRenderList(listEl, box);
  }));
}
function issueGrow(el) { if (!el) return; el.style.height = "auto"; el.style.height = Math.max(42, el.scrollHeight) + "px"; }
function issueFillForm(box, it) {
  box.querySelector("#issue-title").value = it.title || "";
  box.querySelector("#issue-sev").value = it.sev || "medium";
  box.querySelector("#issue-status").value = it.status || "open";
  box.querySelector("#issue-url").value = it.url || "";
  issueGrow(box.querySelector("#issue-url"));
  box.querySelector("#issue-method").value = it.method || "";
  box.querySelector("#issue-desc").value = it.desc || "";
  box.querySelector("#issue-evidence").value = it.evidence || "";
  box._issueEditId = it.id;
}
function issueCurrentForm(box) {
  return {
    title: (box.querySelector("#issue-title").value || "").trim(),
    sev: box.querySelector("#issue-sev").value || "medium",
    status: box.querySelector("#issue-status").value || "open",
    url: (box.querySelector("#issue-url").value || "").trim(),
    method: (box.querySelector("#issue-method").value || "").trim(),
    desc: (box.querySelector("#issue-desc").value || "").trim(),
    evidence: (box.querySelector("#issue-evidence").value || "").trim()
  };
}
function issueDownload(name, text, mime) {
  try {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) { toast("导出失败：" + (e && e.message)); }
}
function issueEscapeHtml(t) { return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function issueExportMarkdown() {
  const rows = issues.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  let md = "# F12x 漏洞 / Issue 报告\n\n共 " + rows.length + " 条 · " + new Date().toLocaleString() + "\n\n";
  rows.forEach((it, i) => {
    md += "## " + (i + 1) + ". " + (it.title || "未命名") + "\n";
    md += "- 严重度：" + (ISSUE_SEV[it.sev] || it.sev) + " | 状态：" + (ISSUE_STATUS[it.status] || it.status) + "\n";
    if (it.method || it.url) md += "- 目标：" + (it.method ? it.method + " " : "") + (it.url || "—") + "\n";
    if (it.desc) md += "\n### 描述\n" + it.desc + "\n";
    if (it.evidence) md += "\n### 复现 / 证据\n" + it.evidence + "\n";
    md += "\n---\n";
  });
  issueDownload("f12x-issues.md", md, "text/markdown;charset=utf-8");
}
function issueExportHtml() {
  const rows = issues.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const rowHtml = (it, i) => '<section class="issue"><h2>' + issueEscapeHtml((i + 1) + ". " + (it.title || "未命名")) + '</h2>'
    + '<p class="meta"><span class="sev ' + esc(it.sev) + '">' + esc(ISSUE_SEV[it.sev] || it.sev) + '</span> · ' + esc(ISSUE_STATUS[it.status] || it.status)
    + (it.method || it.url ? ' · ' + esc((it.method ? it.method + " " : "") + (it.url || "")) : "") + '</p>'
    + (it.desc ? '<div class="desc">' + issueEscapeHtml(it.desc).replace(/\n/g, "<br/>") + '</div>' : "")
    + (it.evidence ? '<pre>' + issueEscapeHtml(it.evidence) + '</pre>' : "")
    + '</section>';
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>F12x Issue 报告</title><style>'
    + 'body{font:14px/1.6 system-ui,sans-serif;max-width:900px;margin:24px auto;color:#1f2328}.issue{border:1px solid #d0d7de;border-radius:8px;padding:12px 16px;margin:12px 0}.sev{font-weight:700;border-radius:4px;padding:1px 8px;color:#fff}.sev.critical,.sev.high{background:#d1242f}.sev.medium{background:#f59e0b;color:#111}.sev.low{background:#54aeff}.sev.info{background:#8b949e}pre{background:#f6f8fa;padding:8px;border-radius:6px;overflow:auto}h2{margin:0 0 6px}</style></head><body>'
    + '<h1>F12x 漏洞 / Issue 报告</h1><p>' + rows.length + " 条 · " + new Date().toLocaleString() + '</p>'
    + rows.map(rowHtml).join("") + '</body></html>';
  issueDownload("f12x-issues-report.html", html, "text/html;charset=utf-8");
}
async function openIssueManager(prefill) {
  await issueRefresh();
  openModal('<h3>漏洞 / Issue 工作台</h3>'
    + '<div class="issue-sub">当前项目：' + esc(app.issueProject && app.issueProject.name || "—") + ' · 用户不删除就不清空</div>'
    + '<div class="issue-form">'
    + '<label class="issue-lbl">标题（必填）<input id="issue-title" class="text-input flex" placeholder="如：登录接口存在越权（IDOR）" /></label>'
    + '<div class="issue-row issue-field">'
    + '<label>严重度<select id="issue-sev"><option value="critical">严重</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option><option value="info">信息</option></select></label>'
    + '<label>状态<select id="issue-status"><option value="open">待处理</option><option value="confirmed">已确认</option><option value="fixed">已修复</option><option value="wontfix">不修复</option></select></label>'
    + '</div>'
    + '<div class="issue-row issue-field"><label class="full">请求方法（选填）<select id="issue-method"><option value="">—</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>HEAD</option><option>OPTIONS</option></select></label></div>'
    + '<div class="issue-row issue-field"><label class="full">URL / 目标（必填）<textarea id="issue-url" class="text-input flex issue-areatext" rows="2" wrap="soft"></textarea></label></div>'
    + '<textarea id="issue-desc" class="text-input" rows="3" placeholder="描述：影响 / 根因 / 复现步骤"></textarea>'
    + '<textarea id="issue-evidence" class="text-input" rows="3" placeholder="证据：请求 / 响应 / POC / 截图说明（可选）"></textarea>'
    + '<div class="issue-row"><button id="issue-save" class="ctrl-btn">保存 Issue</button> <button id="issue-clear" class="mini-btn">清空表单</button></div>'
    + '</div>'
    + '<div id="issue-list" class="issue-list"></div>'
    + '<div class="issue-export"><button id="issue-export-md" class="mini-btn">导出 Markdown</button><button id="issue-export-html" class="mini-btn">导出 HTML 报告</button></div>'
    + '<div class="modal-actions"><button id="issue-close" class="ctrl-btn">完成</button></div>');
  const box = document.querySelector(".modal-box");
  if (!box) return;
  box._issueEditId = null;
  if (prefill) { issueFillForm(box, issueNew(prefill)); const t = box.querySelector("#issue-title"); if (t && t.focus) t.focus(); }
  const listEl = box.querySelector("#issue-list");
  issueRenderList(listEl, box);
  const urlEl = box.querySelector("#issue-url");
  if (urlEl) { urlEl.addEventListener("input", () => issueGrow(urlEl)); issueGrow(urlEl); }
  box.querySelector("#issue-save").addEventListener("click", async () => {
    const f = issueCurrentForm(box);
    if (!f.title || !f.url) { toast("标题与 URL 必填"); return; }
    const r = await api("issue:save", { id: box._issueEditId || "", fields: f });
    if (!r.ok) return toast("保存失败：" + (r.error || ""));
    box._issueEditId = null;
    await issueRefresh(); issueRenderList(listEl, box);
    toast("Issue 已保存到项目");
  });
  box.querySelector("#issue-clear").addEventListener("click", () => { box._issueEditId = null; issueFillForm(box, issueNew()); });
  box.querySelector("#issue-export-md").addEventListener("click", issueExportMarkdown);
  box.querySelector("#issue-export-html").addEventListener("click", issueExportHtml);
  box.querySelector("#issue-close").addEventListener("click", () => { try { closeModal(); } catch (e) {} });
}
function initIssueModule() {
  const chip = $("issue-chip");
  if (chip) chip.addEventListener("click", () => openIssueManager(null));
  issueRefresh().catch(() => {});
}

// --- 视图层状态 ---
const app = {
  state: { attached: false, llmConfigured: false, version: "" },
  intercept: { mode: "off", queue: [] },
  network: {
    items: [], selectedId: null, detail: null, detailTab: "reqh",
    filter: { url: "", method: "", status: "", domain: "", type: "" }, sort: null, sortDir: 1,
    searchIds: null, // 元数据搜索命中的 id 集（network:metadata_search 结果）
    page: 1, pageSize: 50, // 14.2 定稿：表格分页 50/页
    columns: ["method", "status", "url", "type", "size", "src"], // 列配置（默认集）
    consoleLogs: []
  },
  rep: { lastResponse: null, history: [], prevBody: "" },
  jsHistory: [],
  currentView: "page",
  aiRunning: false,
  issueProject: null, // 当前 Issue 归属项目（P4）
  projects: [], currentProject: null, projDetail: null, // 项目视图（P6）
  inspectOn: false,
  audit: [] // AI 动作审计日志（方案 3.2⑤ 一切动作留痕，状态条可展开）
};

// ============================================================
// 基础初始化
// ============================================================
function connectStream() {
  try {
    const port = chrome.runtime.connect({ name: "agent-stream" });
    port.onMessage.addListener(onStreamMessage);
    port.postMessage({ type: "hello" }); // 面板重开回填（方案十二.2）：拉取 SW 内存快照
    port.onDisconnect.addListener(() => setTimeout(connectStream, 800));
  } catch (e) { setTimeout(connectStream, 1500); }
}

function onStreamMessage(msg) {
  if (!msg) return;
  if (msg.type === "status") return handleStatus(msg.status);
  if (msg.type === "stream") return handleStream(msg.event, msg.data);
}

// ============================================================
// 导航切换
// ============================================================
function switchView(view) {
  app.currentView = view;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  const ps = $("project-selector");
  if (ps) ps.classList.toggle("hidden", view === "ai"); // AI 页不出现项目概念
  const doSwitch = () => {
    document.querySelectorAll(".view").forEach(v => {
      const active = v.id === "view-" + view;
      v.classList.toggle("active", active);
      if (active) {
        v.classList.remove("fx-view-enter");
        // 强制回流后重放入场动画（fade+slide，值见 styles.css 出处注释）
        void v.offsetWidth;
        v.classList.add("fx-view-enter");
        v.addEventListener("animationend", () => v.classList.remove("fx-view-enter"), { once: true });
      }
    });
  };
  // 首选浏览器原生 View Transitions（Chrome 推荐同文档过渡）；不支持时回退 CSS 入场动画
  try {
    if (document.startViewTransition) document.startViewTransition(doSwitch);
    else doSwitch();
  } catch (e) { doSwitch(); }
  if (view === "network" && !app.network.items.length) loadNetworkList();
  if (view === "cookie") loadCookies();
  if (view === "script") loadScriptList();
  if (view === "project") loadProjects();
  if (view === "ai") renderAISessions();
}

// ============================================================
// Header：状态点 + 站点选择器 + AI 徽章
// ============================================================
function setStatusDot(attached) {
  app.state.attached = attached;
  const dot = $("status");
  dot.className = "status-dot " + (attached ? "attached" : "detached");
  dot.title = attached ? "调试器已附加" : "调试器未附加（点击模块工具会自动附加）";
}

async function refreshState() {
  const r = await api("util:get_state");
  if (!r.ok) return;
  app.state = r.state;
  setStatusDot(r.state.attached);
  $("llm-badge").classList.toggle("hidden", !r.state.llmConfigured);
  if (r.state.interceptMode !== app.intercept.mode) {
    app.intercept.mode = r.state.interceptMode;
    renderInterceptMode();
  }
  renderInterceptBanner();
}


// ============================================================
function openModal(html) {
  const root = $("modal-root");
  root.innerHTML = `<div class="modal-overlay"><div class="modal-box">${html}</div></div>`;
  root.firstElementChild.addEventListener("click", (e) => { if (e.target === root.firstElementChild) root.innerHTML = ""; });
  return root.firstElementChild.firstElementChild;
}
function closeModal() { $("modal-root").innerHTML = ""; }

function toast(text) {
  const bar = $("ai-status-text");
  bar.textContent = text;
  setTimeout(() => { if (!app.aiRunning) bar.textContent = "AI 空闲"; }, 2600);
}

// P0b：错误码 → 文案映射（与 src/errors.js 同步，UI 侧内联——sidepanel 非 ES module 无法 import）
const F12X_ERR_TEXT = {
  INVALID_REQUEST: "请求无效", UNAUTHORIZED: "认证失败（API Key 无效或未配置）",
  RATE_LIMIT: "请求频率受限（429）", CONTEXT_WINDOW_EXCEEDED: "上下文长度超限",
  EMPTY_RESPONSE: "模型返回空响应", STREAM_CLOSED: "流式响应被截断",
  TIMEOUT: "请求超时", TRANSPORT: "网络传输错误", SERVER: "服务端错误（5xx）",
  TOOL_REJECTED: "操作被拒绝（未批准）", TOOL_TIMEOUT: "工具执行超时",
  TOOL_EXECUTION_ERROR: "工具执行失败", NOT_FOUND: "资源不存在", ABORTED: "已中止"
};
// 错误响应对象 → 用户可读文本（有码取映射文案；无码回退原始 error——存量数据兼容）
function errMsg(r) {
  const c = r && r.code;
  const m = c && F12X_ERR_TEXT[c];
  const raw = (r && (r.error || r.message)) || "";
  if (m && raw) return m + "：" + String(raw).substring(0, 120);
  return m || String(raw || "未知错误");
}

// ---- 聊天 Markdown 渲染（内联轻量实现，零依赖 / MV3 安全）----
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// 轻量 Markdown：标题 / 代码块 / 行内代码 / 粗体 / 斜体 / 链接 / 列表 / 引用 / HR / 表格 / 段落
function mdRender(src) {
  const raw = String(src || "");
  const lines = raw.split(/\r?\n/);
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, (m, c) => "<code>" + c + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, (m, t) => "<strong>" + t + "</strong>")
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (m, a, t) => a + "<em>" + t + "</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>");
  let html = "";
  let i = 0;
  let listOpen = null;
  const closeList = () => { if (listOpen) { html += listOpen === "ol" ? "</ol>" : "</ul>"; listOpen = null; } };
  const table = (start) => {
    const rows = [];
    while (start < lines.length && lines[start].trim().startsWith("|") && lines[start].includes("|")) rows.push(lines[start++]);
    if (rows.length < 2) return { start: start - 1, html: "" };
    if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(rows[1]) || !rows[1].includes("-")) return { start: start - 1, html: "" };
    const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
    let t = "<table><thead><tr>" + cells(rows[0]).map(c => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
    for (let k = 2; k < rows.length; k++) t += "<tr>" + cells(rows[k]).map(c => "<td>" + inline(c) + "</td>").join("") + "</tr>";
    return { start: start - 1, html: t + "</tbody></table>" };
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    if (/^```/.test(t)) {
      closeList();
      const lang = t.replace(/^```/, "").trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      i++;
      html += "<pre><code" + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") + ">" + escapeHtml(buf.join("\n")) + "</code></pre>";
      continue;
    }
    if (t.startsWith("|")) {
      closeList();
      const r = table(i);
      if (r.html) { html += r.html; i = r.start + 1; continue; }
    }
    const hm = t.match(/^(#{1,4})\s+(.+)$/);
    if (hm) { closeList(); html += "<h" + hm[1].length + ">" + inline(hm[2]) + "</h" + hm[1].length + ">"; i++; continue; }
    if (/^(-{3,}|\*{3,})$/.test(t)) { closeList(); html += "<hr>"; i++; continue; }
    if (/^>/.test(t)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
      html += "<blockquote>" + buf.map(b => inline(b)).join("<br>") + "</blockquote>";
      continue;
    }
    const um = t.match(/^[-*+]\s+(.+)$/);
    if (um) {
      if (listOpen !== "ul") { closeList(); html += "<ul>"; listOpen = "ul"; }
      html += "<li>" + inline(um[1]) + "</li>"; i++; continue;
    }
    const om = t.match(/^\d+\.\s+(.+)$/);
    if (om) {
      if (listOpen !== "ol") { closeList(); html += "<ol>"; listOpen = "ol"; }
      html += "<li>" + inline(om[1]) + "</li>"; i++; continue;
    }
    closeList();
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|[-*+]\s|\d+\.\s|\|)/.test(lines[i].trim())) buf.push(lines[i++]);
    html += "<p>" + buf.map(b => inline(b)).join("<br>") + "</p>";
  }
  closeList();
  return html || escapeHtml(raw);
}

// ============================================================
// ===== 页面模块 =====
// ============================================================
function initPageModule() {
  $("page-inspect-btn").addEventListener("click", toggleInspect);
  $("page-skeleton-btn").addEventListener("click", runSkeleton);
  $("page-forms-btn").addEventListener("click", runFormRecon);
  $("page-shot-btn").addEventListener("click", () => runShot(false));
  $("page-shot-full-btn").addEventListener("click", () => runShot(true));
  $("page-nav-btn").addEventListener("click", runNavigate);
  $("page-nav-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runNavigate(); });
  $("page-search-btn").addEventListener("click", runSearchDom);
  $("page-search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearchDom(); });
  $("js-run-btn").addEventListener("click", runJs);
  $("js-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runJs();
  });
  $("js-history-btn").addEventListener("click", () => {
    if (!app.jsHistory.length) return toast("暂无 JS 执行历史");
    openModal(`<h3>JS 执行历史</h3>
      ${app.jsHistory.slice(-10).reverse().map(c => `<label>${esc(c.substring(0, 60))}</label><textarea rows="3" readonly class="js-hist">${esc(c)}</textarea>`).join("")}
      <div class="modal-actions"><button id="js-hist-clear" class="primary">清空历史</button><button>关闭</button></div>`);
    const box = document.querySelector(".modal-box");
    box.querySelectorAll("textarea.js-hist").forEach(t => t.addEventListener("click", () => {
      $("js-code").value = t.value; closeModal();
    }));
    box.querySelector("#js-hist-clear").addEventListener("click", () => { app.jsHistory = []; closeModal(); });
    box.querySelector(".modal-actions button:last-child").addEventListener("click", closeModal);
  });
}

async function toggleInspect() {
  const next = !app.inspectOn;
  const r = await api("inspect:set_mode", { enabled: next });
  if (!r.ok) return toast("Inspect 失败：" + r.error);
  app.inspectOn = next;
  const btn = $("page-inspect-btn");
  btn.classList.toggle("active", next);
  btn.innerHTML = next ? `<span data-icon="search" data-size="13"></span> Inspect 中…` : `<span data-icon="search" data-size="13"></span> Inspect`;
  renderStaticIcons();
  if (next) toast("请在页面点击要检查的元素");
}

async function runSkeleton() {
  $("page-tree").innerHTML = '<div class="placeholder">采集中…</div>';
  const r = await api("tool:page_skeleton");
  if (!r.ok) { $("page-tree").innerHTML = `<div class="placeholder">骨架失败：${esc(r.error)}</div>`; return; }
  renderSkeleton(r.skeleton);
}

function renderSkeleton(node, container, depth = 0) {
  const box = $("page-tree");
  if (depth === 0) { box.innerHTML = ""; container = box; }
  if (!node) return;
  if (typeof node === "string") {
    const div = document.createElement("div");
    div.className = "tree-line";
    div.style.paddingLeft = depth * 14 + "px";
    div.innerHTML = `<span class="tk-text">${esc(node)}</span>`;
    container.appendChild(div);
    return;
  }
  const line = document.createElement("div");
  line.className = "tree-line";
  line.style.paddingLeft = depth * 14 + "px";
  let label = `<span class="tk-tag">&lt;${esc(node.tag)}&gt;</span>`;
  if (node.attrs && node.attrs.length) label += ` <span class="tk-attr">${node.attrs.slice(0, 4).map(a => esc(a)).join(" ")}${node.attrs.length > 4 ? " …" : ""}</span>`;
  if (node.text) label += ` <span class="tk-text">${esc(node.text.substring(0, 40))}</span>`;
  if (node.children && node.children.length) label += ` <span class="tk-text">(${node.children.length})</span>`;
  line.innerHTML = label;
  container.appendChild(line);
  if (node.children && node.children.length) {
    const childBox = document.createElement("div");
    childBox.className = "tree-node";
    container.appendChild(childBox);
    for (const c of node.children) renderSkeleton(c, childBox, depth + 1);
  }
}

async function runFormRecon() {
  const r = await api("tool:form_recon");
  if (!r.ok) return toast("表单侦察失败：" + r.error);
  const box = $("page-tree");
  box.innerHTML = "";
  if (!r.count) { box.innerHTML = '<div class="placeholder">未发现表单</div>'; return; }
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.className = "tree-line";
  head.style.fontWeight = "600";
  head.textContent = `共 ${r.count} 个表单${r.hint ? "（" + r.hint + "）" : ""}`;
  wrap.appendChild(head);
  for (const f of r.forms) {
    const div = document.createElement("div");
    div.className = "tree-node";
    const fHead = document.createElement("div");
    fHead.className = "tree-line";
    fHead.innerHTML = `<span class="tk-tag">&lt;form&gt;</span> <span class="tk-attr">${esc(f.method)} ${esc(f.action || "")}</span>`;
    div.appendChild(fHead);
    for (const fd of f.fields) {
      const fdLine = document.createElement("div");
      fdLine.className = "tree-line";
      fdLine.style.paddingLeft = "14px";
      const fdText = [fd.name && "name=" + fd.name, fd.type && "type=" + fd.type, fd.id && "id=" + fd.id].filter(Boolean).join(" ");
      fdLine.innerHTML = `<span class="tk-tag">&lt;${esc(fd.tag)}&gt;</span> <span class="tk-attr">${esc(fdText)}</span>`;
      div.appendChild(fdLine);
    }
    wrap.appendChild(div);
  }
  box.appendChild(wrap);
}

async function runShot(fullPage) {
  const r = await api("tool:screenshot", { fullPage });
  if (!r.ok) return toast("截图失败：" + r.error);
  if (!r.dataUrl) return toast("截图无数据");
  openModal(`<h3>截图（${esc(String(r.size || ""))}）</h3><img src="${r.dataUrl}" style="max-width:100%" alt="截图"/>`
    + '<div class="modal-actions"><button id="shot-download" class="mini-btn">导出 PNG</button><button>关闭</button></div>');
  const mb = document.querySelector(".modal-box");
  if (!mb) return;
  const dl = mb.querySelector("#shot-download");
  if (dl) dl.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = r.dataUrl; a.download = "f12x-shot-" + Date.now() + ".png";
    document.body.appendChild(a); a.click(); a.remove();
  });
  mb.querySelector(".modal-actions button:last-child").addEventListener("click", closeModal);
}

async function runNavigate() {
  const url = $("page-nav-input").value.trim();
  if (!url) return;
  const r = await api("tool:navigate", { url });
  toast(r.ok ? `已导航：${url}` : "导航失败：" + r.error);
  if (r.ok) loadNetworkList();
}

async function runSearchDom() {
  const sel = $("page-search-input").value.trim();
  if (!sel) return;
  const r = await api("tool:search_dom", { selector: sel });
  if (!r.ok) return toast("搜索失败：" + r.error);
  const box = $("page-tree");
  box.innerHTML = "";
  if (!r.count) { box.innerHTML = `<div class="placeholder">${esc(r.message || "无匹配")}</div>`; return; }
  const head = document.createElement("div");
  head.className = "tree-line";
  head.style.fontWeight = "600";
  head.textContent = `匹配 ${r.count} 个元素`;
  box.appendChild(head);
  for (const item of r.items) {
    const attrs = (item.attributes || []);
    const attrText = [];
    for (let i = 0; i + 1 < attrs.length; i += 2) attrText.push(`${attrs[i]}="${attrs[i + 1]}"`);
    const div = document.createElement("div");
    div.className = "tree-node";
    div.innerHTML = `<div class="tree-line"><span class="tk-tag">&lt;${esc(item.tag)}&gt;</span> <span class="tk-attr">${esc(attrText.slice(0, 6).join(" "))}</span></div>
      <div class="tree-line" style="padding-left:14px;color:var(--text-3)">${esc(item.html)}</div>`;
    box.appendChild(div);
  }
}

async function runJs() {
  const code = $("js-code").value;
  if (!code.trim()) return;
  app.jsHistory.push(code);
  $("js-result").textContent = "执行中…";
  const r = await api("tool:eval_js", { code });
  if (!r.ok) {
    $("js-result").innerHTML = `<span class="err">${esc(r.error)}</span>`;
    return;
  }
  let out = "";
  if (r.error) out = "❌ " + r.error + (r.details ? "\n" + r.details : "");
  else if (r.value !== undefined) out = JSON.stringify(r.value, null, 2);
  else out = `undefined（${r.type}）`;
  $("js-result").textContent = out;
}

// ============================================================
// ===== 网络模块 =====
// ============================================================
function initNetworkModule() {
  document.querySelectorAll("#intercept-mode-seg .seg-btn").forEach(b => {
    b.addEventListener("click", () => setInterceptMode(b.dataset.mode));
  });
  $("net-refresh-btn").addEventListener("click", loadNetworkList);
  $("net-filter").addEventListener("input", () => { app.network.filter.url = $("net-filter").value; app.network.page = 1; renderNetworkTable(); });
  $("net-filter-method").addEventListener("change", () => { app.network.filter.method = $("net-filter-method").value; app.network.page = 1; renderNetworkTable(); });
  $("net-filter-status").addEventListener("change", () => { app.network.filter.status = $("net-filter-status").value; app.network.page = 1; renderNetworkTable(); });
  $("net-filter-domain").addEventListener("change", () => { app.network.filter.domain = $("net-filter-domain").value; app.network.page = 1; renderNetworkTable(); });
  $("net-filter-type").addEventListener("change", () => { app.network.filter.type = $("net-filter-type").value; app.network.page = 1; renderNetworkTable(); });
  // 元数据搜索（方案九.4 v1：URL/请求头/响应头，SW 内存过滤，200ms 防抖）
  $("net-search").addEventListener("input", () => {
    clearTimeout(app.network._searchT);
    const q = $("net-search").value.trim();
    app.network._searchT = setTimeout(async () => {
      if (!q) { app.network.searchIds = null; app.network.page = 1; renderNetworkTable(); return; }
      const r = await api("network:metadata_search", { query: q });
      if (r.ok) { app.network.searchIds = new Set(r.ids || []); app.network.page = 1; renderNetworkTable(); }
      else toast("元数据搜索失败：" + (r.error || ""));
    }, 200);
  });
  $("intercept-release-all").addEventListener("click", async () => {
    const r = await api("intercept:release_all");
    if (r.ok) toast(`已全部放行 ${r.released || 0} 个请求`);
  });
  // 列配置（持久化 networkColumns）
  chrome.storage.local.get({ networkColumns: null }, (cfg) => {
    if (Array.isArray(cfg.networkColumns) && cfg.networkColumns.length) {
      app.network.columns = cfg.networkColumns;
      document.querySelectorAll("#net-cols-menu input[data-col]").forEach(c => { c.checked = app.network.columns.includes(c.dataset.col); });
    }
  });
  $("net-cols-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("net-cols-menu").classList.toggle("hidden");
  });
  document.querySelectorAll("#net-cols-menu input[data-col]").forEach(c => {
    c.addEventListener("change", () => {
      app.network.columns = [...document.querySelectorAll("#net-cols-menu input[data-col]")]
        .filter(x => x.checked).map(x => x.dataset.col);
      if (!app.network.columns.length) app.network.columns = ["url"];
      chrome.storage.local.set({ networkColumns: app.network.columns });
      renderNetworkTable();
    });
  });
  document.addEventListener("click", (e) => {
    if (!$("net-cols-menu").contains(e.target) && e.target !== $("net-cols-btn")) $("net-cols-menu").classList.add("hidden");
  });
  // 分页
  $("net-pager").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pg]");
    if (!btn) return;
    const total = Math.max(1, Math.ceil(filterNetwork().length / app.network.pageSize));
    const act = btn.dataset.pg;
    if (act === "prev") app.network.page = Math.max(1, app.network.page - 1);
    else if (act === "next") app.network.page = Math.min(total, app.network.page + 1);
    else app.network.page = Number(act) || 1;
    renderNetworkTable();
  });
  document.querySelectorAll("#net-detail-tabs .tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll("#net-detail-tabs .tab").forEach(x => x.classList.toggle("active", x === t));
      app.network.detailTab = t.dataset.tab;
      renderNetworkDetail();
    });
  });
}

async function loadNetworkList() {
  const r = await api("tool:network_list", { limit: 500 });
  if (!r.ok) return;
  app.network.items = r.items || [];
  renderNetworkTable();
}

function filterNetwork() {
  const f = app.network.filter;
  let items = app.network.items;
  if (f.url) {
    try {
      const re = new RegExp(f.url, "i");
      items = items.filter(i => re.test(i.url));
    } catch (e) { /* 非法正则忽略 */ }
  }
  if (f.method) items = items.filter(i => (i.method || "").toUpperCase() === f.method.toUpperCase());
  if (f.status) {
    const code = f.status[0] + "xx";
    items = items.filter(i => String(i.status || "")[0] + "xx" === code);
  }
  if (f.domain) items = items.filter(i => {
    try { return new URL(i.url).hostname.toLowerCase().includes(f.domain.toLowerCase()); } catch (e) { return false; }
  });
  if (f.type) {
    const t = f.type.toLowerCase();
    items = items.filter(i => {
      const it = (i.type || "").toLowerCase();
      if (t === "xhr/fetch") return it.includes("xhr") || it.includes("fetch");
      return it === t || it.includes(t);
    });
  }
  // 元数据搜索（方案九.4 v1）：URL/请求头/响应头 内存过滤（SW 端执行）
  if (app.network.searchIds) {
    const s = app.network.searchIds;
    items = items.filter(i => s.has(i.id));
  }
  if (app.network.sort) {
    const { key, dir } = app.network.sort;
    items = [...items].sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === "url") { va = va || ""; vb = vb || ""; return va.localeCompare(vb) * dir; }
      va = va == null ? -1 : va; vb = vb == null ? -1 : vb;
      return (va - vb) * dir;
    });
  }
  return items;
}

function renderNetworkTable() {
  let filtered = filterNetwork();
  // 域过滤选项动态更新（去重，按请求计数降序）
  const domainSel = $("net-filter-domain");
  const curDom = domainSel.value;
  const domCounts = new Map();
  app.network.items.forEach(i => { try { const h = new URL(i.url).hostname; domCounts.set(h, (domCounts.get(h) || 0) + 1); } catch (e) {} });
  const doms = [...domCounts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  domainSel.innerHTML = `<option value="">域</option>` + doms.map(d => `<option>${esc(d)}</option>`).join("");
  if (curDom && doms.includes(curDom)) domainSel.value = curDom; else if (curDom) app.network.filter.domain = "";
  // 14.2 分页：50/页
  const totalPages = Math.max(1, Math.ceil(filtered.length / app.network.pageSize));
  if (app.network.page > totalPages) app.network.page = totalPages;
  const pageItems = filtered.slice((app.network.page - 1) * app.network.pageSize, app.network.page * app.network.pageSize);
  const wrap = $("net-table-wrap");
  const cols = [["method", "方法"], ["status", "状态"], ["url", "URL"], ["type", "类型"], ["size", "大小"], ["src", "来源"]]
    .filter(([k]) => app.network.columns.includes(k));
  wrap.innerHTML = `<table class="net-table"><thead><tr>
    ${cols.map(([k, label]) => `<th data-key="${k}">${label}${app.network.sort?.key === k ? (app.network.sort.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}
    <th>操作</th></tr></thead><tbody>
    ${pageItems.map(it => `
      <tr data-id="${esc(it.id)}" class="${app.network.selectedId === it.id ? "selected" : ""}">
        ${cols.map(([k]) => k === "url"
          ? `<td title="${esc(it.url)}">${esc(it.url || "")}</td>`
          : k === "src"
            ? `<td class="src-${esc(it.source || "page")}">${esc(it.source || "page")}${it.intercepted ? " ⚡" : ""}</td>`
            : `<td>${esc(it[k] != null ? String(it[k]) : "-")}</td>`).join("")}
        <td>
          <button class="mini-btn" data-act="detail">详情</button>
          <button class="mini-btn" data-act="send">发送▾</button>
        </td>
      </tr>`).join("") || '<tr><td colspan="' + (cols.length + 1) + '"><div class="placeholder">暂无请求（刷新页面或切换标签触发采集）</div></td></tr>'}
  </tbody></table>`;
  // 分页控件
  const pager = $("net-pager");
  pager.innerHTML = filtered.length > app.network.pageSize
    ? `<button class="mini-btn" data-pg="prev" ${app.network.page <= 1 ? "disabled" : ""}>‹ 上一页</button>
       <span class="pg-info">${app.network.page} / ${totalPages}（共 ${filtered.length}）</span>
       <button class="mini-btn" data-pg="next" ${app.network.page >= totalPages ? "disabled" : ""}>下一页 ›</button>`
    : "";
  wrap.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (app.network.sort?.key === key) app.network.sort.dir *= -1;
    else app.network.sort = { key, dir: 1 };
    renderNetworkTable();
  }));
  wrap.querySelectorAll("tbody tr").forEach(tr => {
    const id = tr.dataset.id;
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return;
      app.network.selectedId = id;
      openNetworkDetail(id);
      renderNetworkTable();
    });
    const detailBtn = tr.querySelector('[data-act="detail"]');
    if (detailBtn) detailBtn.addEventListener("click", () => { app.network.selectedId = id; openNetworkDetail(id); renderNetworkTable(); });
    const sendBtn = tr.querySelector('[data-act="send"]');
    if (sendBtn) sendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = app.network.items.find(i => i.id === id);
      if (item) showSendToMenu(item);
    });
  });
}

function ensureDetailActions(item) {
  let actions = document.querySelector("#net-detail .net-detail-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "net-detail-actions";
    $("net-detail-tabs").parentNode.insertBefore(actions, $("net-detail-tabs"));
  }
  if (item) {
    actions.innerHTML = `
      <button class="mini-btn" data-st="repeater">→ Repeater</button>
      <button class="mini-btn" data-st="intruder">→ Intruder</button>
      <button class="mini-btn" data-st="decoder">→ Decoder</button>
      <button class="mini-btn" data-st="comparer">→ Comparer</button>
      <button class="mini-btn" data-st="ai">→ AI</button>
      <button class="mini-btn" data-st="mark">标记为发现</button>
      <button class="mini-btn" data-st="issue">→ Issue</button>`;
    actions.querySelector('[data-st="repeater"]').addEventListener("click", () => sendToRepeater(item));
    actions.querySelector('[data-st="intruder"]').addEventListener("click", () => sendToIntruder(item));
    actions.querySelector('[data-st="decoder"]').addEventListener("click", () => sendToDecoder(item));
    actions.querySelector('[data-st="comparer"]').addEventListener("click", () => sendToComparer(item));
    actions.querySelector('[data-st="ai"]').addEventListener("click", () => sendToAI(item));
    actions.querySelector('[data-st="mark"]').addEventListener("click", () => markAsFinding(item));
    actions.querySelector('[data-st="issue"]').addEventListener("click", () => openIssueManager({ url: item.url || '', method: item.method || '' }));
  } else {
    actions.innerHTML = "";
  }
}

async function openNetworkDetail(id) {
  const item = app.network.items.find(i => i.id === id);
  const r = await api("tool:network_detail", { id });
  app.network.detail = r.ok ? r : { error: r.error };
  $("net-detail").classList.remove("hidden");
  const dBar = document.querySelector('.resizer[data-resize-v="#net-detail"]');
  if (dBar) dBar.classList.remove("hidden");
  ensureDetailActions(item);
  renderNetworkDetail();
}

function renderNetworkDetail() {
  const d = app.network.detail;
  const body = $("net-detail-body");
  if (!d) { body.textContent = ""; return; }
  if (d.error) { body.innerHTML = `<span class="err">${esc(errMsg(d))}</span>`; return; }
  const tab = app.network.detailTab;
  if (tab === "reqh") {
    body.innerHTML = `<div class="kv">${formatHeaders(d.requestHeaders)}</div>`;
  } else if (tab === "reqb") {
    body.textContent = d.postData || "（无请求体）";
  } else if (tab === "resh") {
    body.innerHTML = `<div class="kv">${formatHeaders(d.responseHeaders)}</div>`;
  } else if (tab === "resb") {
    if (d.history) {
      body.textContent = d.historyNote || "历史请求无响应体";
    } else if (d.base64Encoded) {
      body.textContent = "[base64 编码响应体]";
    } else {
      const raw = d.body || "（空响应体）";
      // JSON 语法高亮 + 折叠（14.2 定稿：JSON 响应树形展示）
      let jsonTree = "";
      if (d.mimeType && /json|javascript/i.test(d.mimeType)) {
        try { jsonTree = renderJson(JSON.parse(raw)); } catch (e) { /* 非合法 JSON → 纯文本 */ }
      }
      if (jsonTree) {
        body.innerHTML = `<div class="json-view">${jsonTree}</div>`;
      } else {
        body.textContent = raw;
      }
      if (d.bodyTotal > (d.limit || 30000)) {
        const more = document.createElement("button");
        more.className = "mini-btn";
        more.style.margin = "6px 0";
        more.textContent = `响应体共 ${d.bodyTotal} 字符，仅显示前 ${d.limit} — 点击续读`;
        more.addEventListener("click", async () => {
          const r = await api("tool:network_detail", { id: app.network.selectedId, offset: d.limit || 30000, limit: 100000 });
          if (r.ok && r.body) {
            body.textContent += "\n" + r.body;
            try { const extra = renderJson(JSON.parse(r.body)); if (extra) body.innerHTML = `<div class="json-view">${extra}</div>`; } catch (e) {}
          }
        });
        body.appendChild(more);
      }
    }
  } else if (tab === "console") {
    // 控制台分级 + 过滤（方案 3.1：log/warn/error/exception）
    const levels = ["log", "warning", "error", "exception"];
    if (!app.network.consoleFilter) app.network.consoleFilter = new Set(levels);
    const f = app.network.consoleFilter;
    const all = app.network.consoleLogs.slice(-60);
    const filtered = f.size ? all.filter(l => f.has(l.level)) : all;
    body.innerHTML = `
      <div class="console-filter">${levels.map(lv => `<label><input type="checkbox" data-lv="${lv}" ${f.has(lv) ? "checked" : ""} /> ${lv}</label>`).join("")}</div>
      ${filtered.map(l => `<div class="cl ${esc(l.level)}"><b>${esc(l.level)}</b> | ${esc(l.text)}</div>`).join("") || "（无控制台日志）"}`;
    body.querySelectorAll("[data-lv]").forEach(cb => cb.addEventListener("change", () => {
      app.network.consoleFilter = new Set(levels.filter(lv => body.querySelector(`[data-lv="${lv}"]`).checked));
      renderNetworkDetail();
    }));
  }
}

function formatHeaders(headers) {
  if (!headers) return "（无）";
  if (Array.isArray(headers)) return headers.map(h => `<div><b>${esc(h.name)}</b>: ${esc(h.value)}</div>`).join("");
  return Object.entries(headers).map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v)}</div>`).join("");
}

// JSON 树形渲染（语法高亮 + 折叠）：<details> 递归，类型着色，XSS 安全
function renderJson(value, depth = 0) {
  if (value === null) return `<span class="jv-null">null</span>`;
  const t = typeof value;
  if (t === "string") return `<span class="jv-str">"${esc(value)}"</span>`;
  if (t === "number") return `<span class="jv-num">${esc(String(value))}</span>`;
  if (t === "boolean") return `<span class="jv-bool">${esc(String(value))}</span>`;
  if (Array.isArray(value)) {
    if (!value.length) return `<span class="jv-brace">[]</span>`;
    if (depth > 6) return `<span class="jv-brace">[Array(${value.length})]</span>`;
    const inner = value.map(v => `<div class="jv-line">${renderJson(v, depth + 1)}</div>`).join("");
    return `<details class="jv-open" ${depth < 2 ? "open" : ""}><summary class="jv-key">[${value.length}]</summary>${inner}</details>`;
  }
  if (t === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return `<span class="jv-brace">{}</span>`;
    if (depth > 6) return `<span class="jv-brace">{Object}</span>`;
    const inner = keys.map(k => `<div class="jv-line"><span class="jv-key">"${esc(k)}"</span>: ${renderJson(value[k], depth + 1)}</div>`).join("");
    return `<details class="jv-open" ${depth < 2 ? "open" : ""}><summary class="jv-key">{${keys.length}}</summary>${inner}</details>`;
  }
  return esc(String(value));
}

// --- 发送到菜单 ---
function showSendToMenu(item) {
  openModal(`<h3>发送到</h3>
    <div style="display:flex;flex-direction:column;gap:6px">
      <button class="mini-btn" data-send="repeater">Repeater（编辑重发）</button>
      <button class="mini-btn" data-send="intruder">Intruder（payload 注入）</button>
      <button class="mini-btn" data-send="decoder">Decoder（编解码）</button>
      <button class="mini-btn" data-send="comparer">Comparer（作为 A）</button>
      <button class="mini-btn" data-send="mark">标记为发现（写入站点笔记）</button>
    </div>`);
  document.querySelectorAll("[data-send]").forEach(b => b.addEventListener("click", () => {
    closeModal();
    const act = b.dataset.send;
    if (act === "repeater") sendToRepeater(item);
    if (act === "intruder") sendToIntruder(item);
    if (act === "decoder") sendToDecoder(item);
    if (act === "comparer") sendToComparer(item);
    if (act === "mark") markAsFinding(item);
  }));
}

function sendToRepeater(item) {
  switchView("request");
  document.querySelectorAll('#view-request .tabs .tab').forEach(t => t.classList.toggle("active", t.dataset.tab === "repeater"));
  document.querySelectorAll(".req-tab").forEach(t => t.classList.toggle("active", t.id === "req-repeater"));
  $("rep-method").value = item.method || "GET";
  $("rep-url").value = item.url || "";
  $("rep-headers").value = item.requestHeaders ? Object.entries(item.requestHeaders).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
  $("rep-body").value = item.postData || "";
  toast("已填充到 Repeater");
}

function sendToIntruder(item) {
  switchView("request");
  document.querySelectorAll('#view-request .tabs .tab').forEach(t => t.classList.toggle("active", t.dataset.tab === "intruder"));
  document.querySelectorAll(".req-tab").forEach(t => t.classList.toggle("active", t.id === "req-intruder"));
  $("int-method").value = item.method || "GET";
  $("int-url").value = item.url || "";
  toast("已填充到 Intruder（URL 中加 {payload} 占位）");
}

function sendToDecoder(item) {
  switchView("request");
  document.querySelectorAll('#view-request .tabs .tab').forEach(t => t.classList.toggle("active", t.dataset.tab === "decoder"));
  document.querySelectorAll(".req-tab").forEach(t => t.classList.toggle("active", t.id === "req-decoder"));
  $("dec-input").value = item.postData || item.url || "";
  toast("已填充到 Decoder");
}

function sendToComparer(item) {
  switchView("request");
  document.querySelectorAll('#view-request .tabs .tab').forEach(t => t.classList.toggle("active", t.dataset.tab === "comparer"));
  document.querySelectorAll(".req-tab").forEach(t => t.classList.toggle("active", t.id === "req-comparer"));
  if (app.network.detail?.body) $("cmp-a").value = app.network.detail.body;
  else $("cmp-a").value = item.url || "";
  toast("已作为 A 填充到 Comparer");
}

// 网络请求 → AI 分析（3.1 行操作：发送到 AI；回复流到底部 AI 状态条）
// “→ AI”：不自动开跑，只把请求作为引用塞进 AI 输入框，让用户选会话、补充措辞后再点发送
function aiInjectRefText() {
  const input = $("ai-input");
  if (!input) return;
  const cur = input.value.trim();
  input.value = cur ? ref_ + "\n\n" + cur : ref_;
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch (e) {}
  input.focus();
}
let ref_ = ""; // current staged reference text
async function sendToAI(item) {
  const body = app.network.detail?.body || item.postData || "";
  ref_ = "[来自网络请求] " + (item.method || "GET") + " " + (item.url || "")
    + (body ? "\n请求体：" + String(body).substring(0, 400) : "")
    + "\n当前页面域：" + (app.state.debuggeeUrl || "-");
  try { switchView("ai"); } catch (e) {}
  if (chatUI.open && chatUI.convId) { aiInjectRefText(); toast("请求已填入 AI 输入框，可补充说明后发送"); }
  else { aiPendingRef = ref_; toast("请求已暂存：请在 AI 会话列表选择/新建一个会话，将自动填入输入框"); }
}

async function markAsFinding(item) {
  let host = "";
  try { host = new URL(item.url).hostname; } catch (e) {}
  const pid = (app.currentProject && app.currentProject.id) || (aiDetailConv && aiDetailConv.projectId) || "";
  openModal(`<h3>存到项目黑板</h3>
    <label>备注（可选）</label><input id="fact-remark" placeholder="发现的接口/敏感信息…"/>
    <p class="issue-sub" style="margin:6px 0">写入当前项目黑板（未绑定项目时写 AI 全局黑板；Key 自动生成，无需手动填）</p>
    <div class="modal-actions"><button>取消</button><button id="fact-ok" class="primary">写入</button></div>`);
  const box = document.querySelector(".modal-box");
  box.querySelector(".modal-actions button").addEventListener("click", closeModal);
  box.querySelector("#fact-ok").addEventListener("click", async () => {
    const remark = $("fact-remark").value || item.url;
    const key = "endpoint|" + host + "|" + Date.now().toString(36);
    const r = await api("project:fact_add", { projectId: pid, key, category: "endpoint", value: `[${item.method}] ${item.url} — ${remark}` });
    closeModal();
    toast(r.ok ? "已写入项目黑板" : "写入失败：" + r.error);
  });
}

// --- 拦截 ---
async function setInterceptMode(mode) {
  const r = await api("intercept:set_mode", { mode });
  if (!r.ok) return toast("拦截切换失败：" + r.error);
  app.intercept.mode = mode;
  renderInterceptMode();
  renderInterceptBanner();
}

function renderInterceptMode() {
  document.querySelectorAll("#intercept-mode-seg .seg-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === app.intercept.mode);
  });
}

function renderInterceptBanner() {
  const n = app.intercept.queue.length;
  $("intercept-banner").classList.toggle("hidden", n === 0);
  $("intercept-count").textContent = n;
  const dot = $("network-dot");
  dot.classList.toggle("hidden", n === 0);
  dot.classList.toggle("on", n > 0);
}

// 拦截处置弹层
// 拦截弹窗 headers 行格式化：兼容 {k:v} 与 CDP [{name,value}] 两种形态；
// 值来自被调试页面可控的请求头——进 textarea 前必须 esc（防 </textarea> HTML 注入到扩展上下文）
function formatHeadersInline(headers) {
  try {
    if (Array.isArray(headers)) return headers.map(h => esc(h && h.name) + ": " + esc(h && h.value)).join("\n");
    if (headers && typeof headers === "object") return Object.entries(headers).map(([k, v]) => esc(k) + ": " + esc(v)).join("\n");
  } catch (e) { /* 忽略 */ }
  return "";
}

function showInterceptAction(item) {
  openModal(`<h3>拦截请求</h3>
    <div style="font-family:var(--mono);font-size:11px;margin-bottom:8px">${esc(item.method)} ${esc(item.url)}</div>
    <label>动作</label>
    <select id="ic-action">
      <option value="continue">放行（可改请求头）</option>
      <option value="fulfill">伪造响应</option>
      <option value="fail">丢弃请求</option>
    </select>
    <label>请求头（key: value 每行）</label><textarea id="ic-headers" rows="4" class="code-input">${formatHeadersInline(item.headers)}</textarea>
    <div id="ic-fulfill-box" style="display:none">
      <label>响应状态码</label><input id="ic-status" type="number" value="200"/>
      <label>响应体</label><textarea id="ic-body" rows="4" class="code-input" placeholder="伪造的响应内容…"></textarea>
    </div>
    <div class="modal-actions">
      <button id="ic-send-rep">发送到 Repeater</button>
      <button id="ic-cancel">取消</button>
      <button id="ic-do" class="primary">执行</button>
    </div>`);
  const box = document.querySelector(".modal-box");
  box.querySelector("#ic-action").addEventListener("change", (e) => {
    $("ic-fulfill-box").style.display = e.target.value === "fulfill" ? "block" : "none";
  });
  box.querySelector("#ic-cancel").addEventListener("click", closeModal);
  // 发送到 Repeater：放行该请求并填入 Repeater 编辑区（用户接手改包重放）
  box.querySelector("#ic-send-rep").addEventListener("click", async () => {
    sendToRepeater({ url: item.url, method: item.method, requestHeaders: item.headers, postData: item.postData });
    await api("intercept:action", { pausedId: item.pausedId, action: "continue" });
    closeModal();
    toast("已放行并填入 Repeater");
  });
  box.querySelector("#ic-do").addEventListener("click", async () => {
    const action = $("ic-action").value;
    const headers = {};
    $("ic-headers").value.split("\n").forEach(l => {
      const i = l.indexOf(":");
      if (i > 0) headers[l.substring(0, i).trim()] = l.substring(i + 1).trim();
    });
    const edits = { headers };
    if (action === "fulfill") { edits.status = Number($("ic-status").value) || 200; edits.body = $("ic-body").value; }
    if (action === "fail") edits.reason = "BlockedByClient";
    const r = await api("intercept:action", { pausedId: item.pausedId, action, edits });
    closeModal();
    toast(r.ok ? "已处置" : "处置失败：" + r.error);
  });
}

// ============================================================
// ===== 请求模块（Burp 四件套） =====
// ============================================================
function initRequestModule() {
  document.querySelectorAll('#view-request .tabs .tab').forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll('#view-request .tabs .tab').forEach(x => x.classList.toggle("active", x === t));
      document.querySelectorAll(".req-tab").forEach(x => x.classList.toggle("active", x.id === "req-" + t.dataset.tab));
    });
  });

  // Repeater
  $("rep-send").addEventListener("click", repSend);
  // Repeater 历史存到项目黑板
  $("rep-save-site").addEventListener("click", async () => {
    if (!app.rep.history.length) return toast("暂无 Repeater 历史可保存");
    const snap = app.rep.history.slice(-15).map(h => `[${h.method}] ${h.status ?? "-"} ${h.url}`).join("\n");
    const pid = (app.currentProject && app.currentProject.id) || (aiDetailConv && aiDetailConv.projectId) || "";
    const r = await api("project:fact_add", { projectId: pid, key: "repeater-history", category: "repeater", value: snap });
    if (r.ok) toast("已保存到项目黑板");
    else toast("保存失败：" + (r.error || ""));
  });
  // 内嵌"对比上次响应"（方案 3.1 Repeater）
  $("rep-cmp-last").addEventListener("click", async () => {
    const cur = $("rep-result").textContent;
    if (!app.rep.prevBody || !cur) return toast("暂无两次可对比的响应");
    const r = await api("tool:compare", { a: app.rep.prevBody, b: cur });
    if (!r.ok) return toast("对比失败：" + r.error);
    const lines = [
      `长度: 上次 ${r.lengthA} / 当前 ${r.lengthB}（差 ${r.lengthDiff}）`,
      `相似度: ${r.similarity} | 内容包含: ${r.containment}`,
      `相同: ${r.identical ? "是" : "否"} | 差异块: ${r.diffBlockCount}`,
      ""
    ];
    for (const d of (r.diffBlocks || []).slice(0, 10)) {
      lines.push(`差异块 ${d.startLine}-${d.endLine}:`);
      if (d.a[0]) lines.push(`  A: ${d.a[0]}`);
      if (d.b[0]) lines.push(`  B: ${d.b[0]}`);
    }
    $("rep-result").textContent = lines.join("\n");
  });
  $("rep-to-compare").addEventListener("click", () => {
    switchView("request");
    document.querySelectorAll('#view-request .tabs .tab').forEach(t => t.classList.toggle("active", t.dataset.tab === "comparer"));
    document.querySelectorAll(".req-tab").forEach(t => t.classList.toggle("active", t.id === "req-comparer"));
    if (app.rep.lastResponse) $("cmp-a").value = app.rep.lastResponse.body || "";
    toast("上次响应已作为 A 填入 Comparer");
  });
  $("rep-to-decoder").addEventListener("click", () => {
    switchView("request");
    document.querySelectorAll('#view-request .tabs .tab').forEach(t => t.classList.toggle("active", t.dataset.tab === "decoder"));
    document.querySelectorAll(".req-tab").forEach(t => t.classList.toggle("active", t.id === "req-decoder"));
    if (app.rep.lastResponse) $("dec-input").value = app.rep.lastResponse.body || "";
    toast("上次响应已填入 Decoder");
  });

  // Intruder
  $("int-run").addEventListener("click", intruderRun);
  $("int-stop").addEventListener("click", async () => {
    // 真正中断：路由层持有 AbortController，intruder 逐请求检查 signal 后提前返回
    const r = await api("tool:intruder_stop");
    toast(r.stopped ? "正在停止爆破…" : "当前没有进行中的爆破");
  });
  $("int-payloads-file").addEventListener("click", () => $("int-file-input").click());
  $("int-file-input").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      $("int-payloads").value = lines.join(",");
      toast(`已导入 ${lines.length} 个 payload`);
    };
    reader.readAsText(f);
  });

  // Comparer
  $("cmp-run").addEventListener("click", cmpRun);
  $("cmp-swap").addEventListener("click", () => {
    const a = $("cmp-a").value, b = $("cmp-b").value;
    $("cmp-a").value = b; $("cmp-b").value = a;
  });

  // Decoder
  $("dec-run").addEventListener("click", decRun);
  // 链式再编码（方案 3.1 Decoder：输出作为输入继续转换）
  $("dec-re-encode").addEventListener("click", () => {
    const out = $("dec-output").textContent;
    if (!out || out.startsWith("失败")) return;
    $("dec-input").value = out;
    decRun();
  });
  $("dec-to-cmp").addEventListener("click", () => {
    switchView("request");
    document.querySelectorAll('#view-request .tabs .tab').forEach(t => t.classList.toggle("active", t.dataset.tab === "comparer"));
    document.querySelectorAll(".req-tab").forEach(t => t.classList.toggle("active", t.id === "req-comparer"));
    $("cmp-a").value = $("dec-output").textContent;
    toast("解码结果已作为 A 填入 Comparer");
  });
}

async function repSend() {
  const method = $("rep-method").value;
  const url = $("rep-url").value.trim();
  if (!url) return toast("URL 必填");
  const headers = {};
  $("rep-headers").value.split("\n").forEach(l => {
    const i = l.indexOf(":");
    if (i > 0) headers[l.substring(0, i).trim()] = l.substring(i + 1).trim();
  });
  const body = $("rep-body").value || null;
  // 内嵌对比：发送前保存当前响应为"上次"
  const prevOut = $("rep-result").textContent.trim();
  if (prevOut) app.rep.prevBody = prevOut;
  $("rep-result-label").textContent = "响应（发送中…）";
  const r = await api("tool:replay", { url, method, headers, body });
  app.rep.lastResponse = r;
  $("rep-result-label").textContent = `响应（状态 ${r.status ?? "-"}）${r.viaPage ? " · 会话 Cookie" : " · 扩展 fetch"}`;
  if (!r.ok) {
    $("rep-result").innerHTML = `<span class="err">${esc(r.error)}</span>`;
    return;
  }
  let out = "";
  if (r.responseHeaders) out += Object.entries(r.responseHeaders).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\n";
  out += r.body || "";
  $("rep-result").textContent = out;
  const hist = { ts: Date.now(), method, url, status: r.status };
  app.rep.history.push(hist);
  persistRepHistory();
  renderRepHistory();
}

function renderRepHistory() {
  $("rep-history").innerHTML = app.rep.history.slice(-15).reverse().map(h =>
    `<div class="rep-history-item" data-i="${h.ts}">${esc(h.method)} ${h.status ?? "-"} ${esc(h.url)}</div>`).join("");
  $("rep-history").querySelectorAll(".rep-history-item").forEach(el => {
    el.addEventListener("click", () => {
      const h = app.rep.history.find(x => x.ts === Number(el.dataset.i));
      if (h) { $("rep-method").value = h.method; $("rep-url").value = h.url; }
    });
  });
}

// Repeater 历史会话级持久化（14.7②：自动保存最近 N 条到 storage，与拦截队列同一套策略）
const REP_HISTORY_KEY = "f12x_repeater_history_v1";
const REP_HISTORY_MAX = 50;
function persistRepHistory() {
  try { chrome.storage.local.set({ [REP_HISTORY_KEY]: app.rep.history.slice(-REP_HISTORY_MAX) }); } catch (e) {}
}
async function loadRepHistory() {
  try {
    const r = await chrome.storage.local.get(REP_HISTORY_KEY);
    app.rep.history = (r[REP_HISTORY_KEY] || []).slice(-REP_HISTORY_MAX);
  } catch (e) { app.rep.history = []; }
  renderRepHistory();
}

async function intruderRun() {
  const url = $("int-url").value.trim();
  const payloads = $("int-payloads").value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (!url) return toast("URL 必填");
  if (!payloads.length) return toast("payload 列表必填");
  const method = $("int-method").value;
  const concurrency = Math.min(20, Math.max(1, Number($("int-conc").value) || 3));
  const rateLimitMs = Math.max(0, Number($("int-rate").value) || 0);
  const includeBody = $("int-body-cb").checked;
  const body = $("int-body").value || null;
  // 请求头（key: value 每行一个）——工具层一直支持，面板此前硬编码 {}，导致鉴权头类测试做不了
  const headers = {};
  ($("int-headers").value || "").split("\n").forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) { const k = line.substring(0, i).trim(); if (k) headers[k] = line.substring(i + 1).trim(); }
  });
  // 注入头：值里的 {payload} 由每个 payload 替换（对应工具层 headerInject）
  const headerInject = ($("int-headerinject")?.value || "").trim() || null;
  $("int-run").classList.add("hidden");
  $("int-stop").classList.remove("hidden");
  $("int-summary").textContent = `正在发送 ${payloads.length} 个请求（并发 ${concurrency}）…`;
  $("int-results").innerHTML = "";
  const r = await api("tool:intruder", { url, method, headers, body, payloads, concurrency, includeBody, rateLimitMs, headerInject });
  $("int-run").classList.remove("hidden");
  $("int-stop").classList.add("hidden");
  if (!r.ok) { $("int-summary").textContent = "失败：" + r.error; return; }
  const head = r.interrupted ? `已中断（发出 ${r.returned}/${r.total}）` : `完成 ${r.returned}/${r.total}`;
  $("int-summary").textContent = `${head} · 状态分组：${JSON.stringify(r.statusGroups)} · 长度分组：${JSON.stringify(r.lenGroups)}`;
  const rows = r.results.map(x => {
    const anomaly = x.status === 500 || x.error ? " anomaly" : "";
    return `<tr class="${anomaly}"><td>${x.index}</td><td>${esc(x.payload)}</td><td>${x.status ?? "ERR"}</td><td>${x.length}</td><td>${esc(x.error || (x.body ? x.body.substring(0, 60) : ""))}</td></tr>`;
  }).join("");
  $("int-results").innerHTML = `<table class="int-table"><thead><tr><th>#</th><th>payload</th><th>状态</th><th>长度</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function cmpRun() {
  const a = $("cmp-a").value, b = $("cmp-b").value;
  if (!a && !b) return;
  const r = await api("tool:compare", { a, b });
  if (!r.ok) { $("cmp-result").textContent = "失败：" + r.error; return; }
  const lines = [
    `长度 A: ${r.lengthA} / B: ${r.lengthB}（差 ${r.lengthDiff}）`,
    `行数 A: ${r.linesA} / B: ${r.linesB}`,
    `相似度: ${r.similarity} | 内容包含: ${r.containment}`,
    `相同: ${r.identical ? "是" : "否"} | 差异块: ${r.diffBlockCount}`,
    ""
  ];
  for (const d of (r.diffBlocks || []).slice(0, 10)) {
    lines.push(`差异块 ${d.startLine}-${d.endLine}:`);
    if (d.a[0]) lines.push(`  A: ${d.a[0]}`);
    if (d.b[0]) lines.push(`  B: ${d.b[0]}`);
  }
  $("cmp-result").textContent = lines.join("\n");
}

async function decRun() {
  const text = $("dec-input").value;
  if (!text) return;
  const r = await api("tool:decode", { text, mode: $("dec-mode").value });
  $("dec-output").textContent = r.ok ? r.result : ("失败：" + r.error);
}

// ============================================================
// ===== Cookie 模块 =====
// ============================================================
function initCookieModule() {
  $("cookie-refresh").addEventListener("click", loadCookies);
  $("cookie-filter").addEventListener("input", renderCookies);
  $("cookie-show-values").addEventListener("change", () => { loadCookies(); });
}

let cookieData = [];
async function loadCookies() {
  const includeValues = $("cookie-show-values").checked;
  const r = await api("tool:cookies", { includeValues });
  if (!r.ok) { $("cookie-table-wrap").innerHTML = `<div class="placeholder">Cookie 读取失败：${esc(r.error)}</div>`; return; }
  cookieData = r.cookies || [];
  renderCookies();
}

function maskVal(v) {
  if (!v) return "…";
  if (v.length <= 4) return "****";
  return v.substring(0, 4) + "****";
}

function renderCookies() {
  const f = $("cookie-filter").value.toLowerCase();
  const items = cookieData.filter(c => !f || (c.name + c.domain).toLowerCase().includes(f));
  const wrap = $("cookie-table-wrap");
  wrap.innerHTML = `<table class="cookie-table"><thead><tr><th>名称</th><th>值</th><th>域</th><th>路径</th><th>标志</th><th>操作</th></tr></thead><tbody>
    ${items.map(c => `<tr>
      <td>${esc(c.name)}</td>
      <td class="val cookie-val" data-full="${esc(c.value ?? "")}">${esc(maskVal(c.value))}</td>
      <td>${esc(c.domain)}</td>
      <td>${esc(c.path)}</td>
      <td>${c.httpOnly ? "H" : ""}${c.secure ? "S" : ""}${c.sameSite ? "·" + esc(c.sameSite) : ""}</td>
      <td>
        <button class="mini-btn" data-edit="${esc(c.name)}">编辑</button>
        <button class="mini-btn" data-del="${esc(c.name)}">删除</button>
      </td>
    </tr>`).join("") || '<tr><td colspan="6"><div class="placeholder">无 Cookie</div></td></tr>'}
  </tbody></table>`;
  wrap.querySelectorAll('[data-edit]').forEach(b => b.addEventListener("click", () => {
    const c = cookieData.find(x => x.name === b.dataset.edit);
    if (c) editCookie(c);
  }));
  // 值脱敏（方案 3.1：默认掩码显示，点击切换完整值）
  wrap.querySelectorAll(".cookie-val").forEach(el => {
    el.title = "点击查看完整值";
    el.addEventListener("click", () => {
      const full = el.dataset.full || "";
      if (el.dataset.masked !== "1") { el.dataset.masked = "1"; el.textContent = full || "…"; el.title = "点击隐藏"; }
      else { delete el.dataset.masked; el.textContent = maskVal(full); el.title = "点击查看完整值"; }
    });
  });
  wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener("click", async () => {
    const c = cookieData.find(x => x.name === b.dataset.del);
    if (!c) return;
    const url = "https://" + c.domain.replace(/^\./, "") + c.path;
    const r = await api("cookie:remove", { cookie: { name: c.name, url } });
    toast(r.ok ? "已删除" : "删除失败：" + r.error);
    if (r.ok) loadCookies();
  }));
}

function editCookie(c) {
  openModal(`<h3>编辑 Cookie</h3>
    <label>名称</label><input id="c-name" value="${esc(c.name)}" />
    <label>值</label><textarea id="c-value" rows="2" class="code-input">${esc(c.value || "")}</textarea>
    <label>域</label><input id="c-domain" value="${esc(c.domain)}" />
    <label>路径</label><input id="c-path" value="${esc(c.path)}" />
    <div class="modal-actions"><button>取消</button><button id="c-ok" class="primary">保存</button></div>`);
  const box = document.querySelector(".modal-box");
  box.querySelector(".modal-actions button").addEventListener("click", closeModal);
  box.querySelector("#c-ok").addEventListener("click", async () => {
    const url = "https://" + $("c-domain").value.replace(/^\./, "") + $("c-path").value;
    const r = await api("cookie:set", {
      cookie: { name: $("c-name").value, value: $("c-value").value, url, domain: $("c-domain").value, path: $("c-path").value }
    });
    closeModal();
    toast(r.ok ? "已保存（刷新页面生效）" : "保存失败：" + r.error);
    loadCookies();
  });
}

// ============================================================
// ===== 脚本模块 =====
// ============================================================
function initScriptModule() {
  $("script-refresh").addEventListener("click", loadScriptList);
  $("script-grep").addEventListener("keydown", (e) => { if (e.key === "Enter") loadScriptList(); });
}

async function loadScriptList() {
  const r = await api("tool:script_list");
  if (!r.ok) return;
  const list = $("script-list");
  const grep = $("script-grep").value.trim();
  const scripts = (r.scripts || []).filter(s => !grep || s.url.toLowerCase().includes(grep.toLowerCase()));
  list.innerHTML = scripts.map(s =>
    `<div class="script-item" data-url="${esc(s.url)}" title="${esc(s.url)}">${esc(s.url || "(inline)")} <span style="color:var(--text-4)">${s.lines} 行</span></div>`).join("")
    || '<div class="placeholder">无脚本（刷新页面后自动采集）</div>';
  list.querySelectorAll(".script-item").forEach(el => el.addEventListener("click", () => {
    list.querySelectorAll(".script-item").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
    loadScriptContent(el.dataset.url);
  }));
}

async function loadScriptContent(url) {
  const content = $("script-content");
  content.innerHTML = '<div class="placeholder">加载中…</div>';
  const r = await api("tool:script_content", { url, limit: 200000 });
  if (!r.ok) { content.innerHTML = `<div class="placeholder">${esc(r.error)}</div>`; return; }
  const lines = (r.content || "").split("\n");
  // grep 高亮（方案 3.1：源码行号 + grep 高亮）
  const grepQ = $("script-grep").value.trim().toLowerCase();
  content.innerHTML = `
    <div class="script-actions"><button class="mini-btn" id="script-send-ai">送片段给 AI</button></div>
    <pre class="script-pre">${lines.map((l, i) => `<span class="${grepQ && l.toLowerCase().includes(grepQ) ? "hl" : ""}"><span class="ln">${i + 1}</span>${esc(l) || " "}</span>`).join("\n")}</pre>`;
  // 送片段给 AI（选中文本优先，否则前 60 行）
  $("script-send-ai").addEventListener("click", async () => {
    const sel = window.getSelection() ? window.getSelection().toString().trim() : "";
    const frag = sel || lines.slice(0, 60).join("\n");
    await aiSendFromPage(`分析以下代码片段（来源 ${url}），关注安全缺陷（XSS/SQLi/注入/敏感信息泄漏）：\n${frag.substring(0, 4000)}`, "代码片段分析", true);
  });
}

// ============================================================
// ===== 项目模块（P6+：唯一持久化容器；列表 / 详情 / 跨模块联动） =====
// ============================================================
async function loadProjects(focusId) {
  const r = await api("project:active");
  if (r.ok) { app.projects = r.projects || []; app.currentProject = r.project || null; }
  renderProjectSelector();
  renderProjectList();
  // 默认停在项目列表；只有显式传入 focusId 才打开详情
  if (focusId) await openProjectDetail(focusId);
  else { showProjectBrowser(); renderProjectList(); }
}
function renderProjectSelector() {
  const sel = $("project-selector");
  if (!sel) return;
  sel.innerHTML = (app.projects.length ? "" : '<option value="">未选项目</option>')
    + app.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  sel.value = (app.currentProject && app.currentProject.id) || "";
  const pill = $("project-pill");
  if (pill) {
    pill.classList.toggle("empty", !(app.currentProject && app.currentProject.id));
    pill.title = app.currentProject ? "当前项目：" + app.currentProject.name : "未选项目（在「项目」页创建或选择）";
  }
}
function renderProjectList() {
  const box = $("project-list");
  if (!box) return;
  const q = (($("project-search") && $("project-search").value) || "").trim().toLowerCase();
  const rows = app.projects.filter((p) => !q || String(p.name || "").toLowerCase().includes(q) || String(p.desc || "").toLowerCase().includes(q));
  if (!rows.length) {
    box.innerHTML = '<div class="placeholder">' + (app.projects.length ? "没有匹配的项目" : "还没有项目：点右上角「新建」，黑板 / Issue / 模板 / 会话都会归入项目") + "</div>";
    return;
  }
  box.innerHTML = rows.map((p) => `
    <div class="project-item ${app.currentProject && app.currentProject.id === p.id ? "active" : ""}" data-id="${esc(p.id)}">
      <div class="pj-name">${esc(p.name)}${app.currentProject && app.currentProject.id === p.id ? ' <span class="pj-cur">当前</span>' : ""}</div>
      ${p.desc ? '<div class="pj-desc">' + esc(p.desc) + "</div>" : ""}
      <div class="pj-meta">会话 ${p.convCount || 0} · 事实 ${p.factsCount || 0} · Issue ${p.issueCount || 0} · 模板 ${p.templateCount || 0}</div>
    </div>`).join("");
  box.querySelectorAll(".project-item").forEach((el) => el.addEventListener("click", () => openProjectDetail(el.dataset.id)));
}
function showProjectBrowser() {
  const b = $("project-browser"); const d = $("project-detail");
  if (b) b.classList.remove("hidden");
  if (d) d.classList.add("hidden");
}
function showProjectDetailView() {
  const b = $("project-browser"); const d = $("project-detail");
  if (b) b.classList.add("hidden");
  if (d) d.classList.remove("hidden");
}
async function openProjectDetail(id) {
  const r = await api("project:get", { projectId: id });
  if (!r.ok) { showProjectBrowser(); return toast("读取项目失败：" + (r.error || "")); }
  app.projDetail = r;
  app.projEditIssueId = null;
  showProjectDetailView();
  const p = r.project;
  $("project-title").textContent = p.name;
  $("project-counts").textContent = `会话 ${r.conversations.length} · 事实 ${(p.facts || []).length} · Issue ${(p.issues || []).length} · 模板 ${(p.templates || []).length}` + (p.desc ? " · " + p.desc : "");
  $("proj-set-active").disabled = !!(app.currentProject && app.currentProject.id === p.id);
  renderProjFacts(p);
  renderProjIssues(p);
  renderProjTemplates(p);
  renderProjConvs(r.conversations);
  renderProjectList();
}
function projPane(id, html) { const box = $(id); if (box) box.innerHTML = html; }
function projRefresh() { if (app.projDetail) return openProjectDetail(app.projDetail.project.id); }

// —— 黑板：新增 / 送入 AI / 删除 ——
function renderProjFacts(p) {
  const rows = (p.facts || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  projPane("proj-facts-list", rows.length ? rows.map((f) => `
    <div class="fact-item">
      <div class="fact-key">${esc(f.key)} <span class="fact-tag">${esc(f.category || "misc")}</span><span class="fact-src">${esc(f.source || (f.auto ? "ai" : "user"))}</span></div>
      <div class="fact-sum">${esc(f.summary || "")}</div>
      <div class="proj-actions">
        <button class="mini-btn" data-fact-ai="${esc(f.key)}">送入 AI</button>
        <button class="mini-btn danger" data-del-fact="${esc(f.key)}">删除</button>
      </div>
    </div>`).join("") : '<div class="placeholder">黑板为空：上方添加，或在网络详情「存到项目黑板」，或让 AI 用 upsert_fact 沉淀</div>');
  const box = $("proj-facts");
  if (box) box.querySelectorAll("[data-del-fact]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("删除该条黑板事实？")) return;
    const r = await api("project:fact_remove", { projectId: p.id, key: b.dataset.delFact });
    if (!r.ok) return toast("删除失败：" + (r.error || ""));
    await projRefresh(); renderProjectList();
  }));
  if (box) box.querySelectorAll("[data-fact-ai]").forEach((b) => b.addEventListener("click", async () => {
    const f = rows.find((x) => x.key === b.dataset.factAi);
    if (!f) return;
    const text = "[项目黑板] " + f.key + "（" + (f.category || "misc") + "）：" + (f.summary || "");
    await aiSendFromPage(text, "项目黑板：" + f.key, true, p.id);
  }));
}

// —— Issue：内联编辑（持久，只有用户删除才消失） ——
function renderProjIssues(p) {
  const rows = (p.issues || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  projPane("proj-issues-list", (rows.length ? rows.map((it) => `
    <div class="issue-item">
      <span class="issue-sev sev-${esc(it.sev)}">${esc(ISSUE_SEV[it.sev] || it.sev)}</span>
      <span class="issue-title">${esc(it.title || "（未命名）")}</span>
      ${it.url ? '<span class="issue-url">' + esc(it.url) + "</span>" : ""}
      <button class="mini-btn" data-edit-issue="${esc(it.id)}">编辑</button>
      <button class="mini-btn danger" data-del-issue="${esc(it.id)}">删除</button>
    </div>`).join("") : '<div class="placeholder">暂无 Issue：用上方表单新建，或从网络详情「→ Issue」</div>'));
  const box = $("proj-issues");
  if (box) box.querySelectorAll("[data-edit-issue]").forEach((b) => b.addEventListener("click", () => {
    const it = rows.find((x) => x.id === b.dataset.editIssue);
    if (!it) return;
    app.projEditIssueId = it.id;
    piFill(it);
  }));
  if (box) box.querySelectorAll("[data-del-issue]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("删除该 Issue？删除后不可恢复")) return;
    const r = await api("issue:delete", { id: b.dataset.delIssue, projectId: p.id });
    if (!r.ok) return toast("删除失败：" + (r.error || ""));
    await projRefresh(); renderProjectList();
  }));
}
function piFill(it) {
  const set = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
  set("pi-title", it.title); set("pi-sev", it.sev || "medium"); set("pi-status", it.status || "open");
  set("pi-method", it.method); set("pi-url", it.url); set("pi-desc", it.desc); set("pi-evidence", it.evidence);
  const btn = $("pi-save"); if (btn) btn.textContent = it.id ? "更新 Issue" : "保存 Issue";
}
function piRead() {
  return {
    title: (($("pi-title") && $("pi-title").value) || "").trim(),
    sev: ($("pi-sev") && $("pi-sev").value) || "medium",
    status: ($("pi-status") && $("pi-status").value) || "open",
    method: (($("pi-method") && $("pi-method").value) || "").trim(),
    url: (($("pi-url") && $("pi-url").value) || "").trim(),
    desc: (($("pi-desc") && $("pi-desc").value) || "").trim(),
    evidence: (($("pi-evidence") && $("pi-evidence").value) || "").trim(),
  };
}

// —— 模板：新增 / 运行（建会话并下发） / 删除 ——
function renderProjTemplates(p) {
  const rows = p.templates || [];
  projPane("proj-templates-list", (rows.length ? rows.map((t) => `
    <div class="fact-item">
      <div class="fact-key">${esc(t.name)} <span class="fact-tag">${esc(t.kind || "custom")}</span></div>
      <div class="fact-sum">${esc(t.instructions || t.desc || "")}</div>
      <div class="proj-actions">
        <button class="mini-btn" data-run-tpl="${esc(t.id)}">运行</button>
        <button class="mini-btn danger" data-del-tpl="${esc(t.id)}">删除</button>
      </div>
    </div>`).join("") : '<div class="placeholder">暂无模板：把常用打法存成模板，下次一键下发 AI 任务</div>'));
  const box = $("proj-templates");
  if (box) box.querySelectorAll("[data-del-tpl]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("删除该模板？")) return;
    const r = await api("project:template_remove", { projectId: p.id, templateId: b.dataset.delTpl });
    if (!r.ok) return toast("删除失败：" + (r.error || ""));
    await projRefresh(); renderProjectList();
  }));
  if (box) box.querySelectorAll("[data-run-tpl]").forEach((b) => b.addEventListener("click", async () => {
    const t = rows.find((x) => x.id === b.dataset.runTpl);
    if (!t) return;
    const text = "按项目模板「" + t.name + "」执行：" + (t.instructions || t.desc || "")
      + (t.params && t.params.url ? "\n目标：" + t.params.url : "");
    await runProjectTask(text, "模板：" + t.name);
  }));
}

// —— 会话：新建 / 打开 / 解绑 ——
function renderProjConvs(convs) {
  projPane("proj-convs-list", convs.length ? convs.map((c) => `
    <div class="proj-conv">
      <div class="pj-name">${esc(c.title || "未命名会话")}</div>
      <div class="pj-meta">消息 ${c.msgCount || 0} · ${new Date(c.updatedAt || Date.now()).toLocaleString()}</div>
      <div class="proj-actions">
        <button class="mini-btn" data-conv-open="${esc(c.convId)}">打开</button>
        <button class="mini-btn" data-conv-unbind="${esc(c.convId)}">解绑</button>
      </div>
    </div>`).join("") : '<div class="placeholder">该项目还没有会话：点「新建会话」，或在 AI 里绑定</div>');
  const box = $("proj-convs");
  if (box) box.querySelectorAll("[data-conv-open]").forEach((el) => el.addEventListener("click", () => {
    const c = convs.find((x) => x.convId === el.dataset.convOpen);
    if (!c) return;
    switchView("ai");
    openAIDetail({ convId: c.convId, title: c.title, msgCount: c.msgCount, updatedAt: c.updatedAt, type: c.type, projectId: c.projectId });
  }));
  if (box) box.querySelectorAll("[data-conv-unbind]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("解绑该会话？会话保留，改为独立会话（AI 全局黑板）。")) return;
    const r = await api("ai:conversation_set_project", { convId: el.dataset.convUnbind, projectId: "" });
    if (!r.ok) return toast("解绑失败：" + (r.error || ""));
    await projRefresh(); renderProjectList();
  }));
}

// —— 联动：在项目下发起 AI 任务（新建会话 → 打开 → 发送） ——
// 模板运行：与其他「送 AI」一致，先让用户选会话（新建会绑定当前查看的项目）
async function runProjectTask(text, title) {
  const p = app.projDetail && app.projDetail.project;
  if (!p) return toast("请先打开一个项目");
  return pickConversationForAI({ text, titleHint: title || "项目任务", autoSend: true, projectId: p.id });
}

// —— 项目操作 ——
async function projectExport(id) {
  const r = await api("project:get", { projectId: id });
  if (!r.ok) return toast("导出失败：" + (r.error || ""));
  const data = { exportedAt: new Date().toISOString(), version: 1, project: r.project, conversations: r.conversations };
  const name = String(r.project.name || "project").replace(/[\\/:*?"<>|]/g, "_");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "f12x-project-" + name + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function initProjectModule() {
  const toggle = $("project-new-toggle");
  if (toggle) toggle.addEventListener("click", () => {
    const bar = $("project-create-bar");
    if (bar) bar.classList.toggle("hidden");
  });
  const cancel = $("project-create-cancel");
  if (cancel) cancel.addEventListener("click", () => { const bar = $("project-create-bar"); if (bar) bar.classList.add("hidden"); });
  const create = $("project-create-btn");
  if (create) create.addEventListener("click", async () => {
    const name = (($("project-name-input") && $("project-name-input").value) || "").trim();
    if (!name) return toast("请输入项目名称");
    const desc = (($("project-desc-input") && $("project-desc-input").value) || "").trim();
    const r = await api("project:create", { name, desc });
    if (!r.ok) return toast("创建失败：" + (r.error || ""));
    if ($("project-name-input")) $("project-name-input").value = "";
    if ($("project-desc-input")) $("project-desc-input").value = "";
    $("project-create-bar") && $("project-create-bar").classList.add("hidden");
    await api("project:set_active", { projectId: r.project.id });
    await issueRefresh();
    await loadProjects(r.project.id);
    toast("项目已创建并设为当前");
  });
  const search = $("project-search");
  if (search) search.addEventListener("input", renderProjectList);
  const back = $("proj-back");
  if (back) back.addEventListener("click", () => { showProjectBrowser(); renderProjectList(); });
  const sel = $("project-selector");
  if (sel) sel.addEventListener("change", async () => {
    const id = sel.value;
    if (!id) return;
    await api("project:set_active", { projectId: id });
    await issueRefresh();
    await loadProjects(id);
  });
  document.querySelectorAll("#view-project .tabs .tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll("#view-project .tabs .tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll("#view-project .proj-pane").forEach((p) => p.classList.toggle("active", p.id === "proj-" + t.dataset.ptab));
  }));
  const setActive = $("proj-set-active");
  if (setActive) setActive.addEventListener("click", async () => {
    if (!app.projDetail) return;
    await api("project:set_active", { projectId: app.projDetail.project.id });
    await issueRefresh();
    await loadProjects(app.projDetail.project.id);
    toast("已设为当前项目");
  });
  const exp = $("proj-export");
  if (exp) exp.addEventListener("click", () => { if (app.projDetail) projectExport(app.projDetail.project.id); });
  const rename = $("proj-rename");
  if (rename) rename.addEventListener("click", async () => {
    if (!app.projDetail) return;
    const name = prompt("项目名称", app.projDetail.project.name);
    if (!name) return;
    const r = await api("project:rename", { projectId: app.projDetail.project.id, name });
    if (!r.ok) return toast("重命名失败：" + (r.error || ""));
    await loadProjects(app.projDetail.project.id);
    renderProjectList();
  });
  const del = $("proj-delete");
  if (del) del.addEventListener("click", async () => {
    if (!app.projDetail) return;
    if (!confirm("删除项目「" + app.projDetail.project.name + "」？\n黑板 / Issue / 模板会一起删除；会话会解绑保留。")) return;
    const r = await api("project:delete", { projectId: app.projDetail.project.id });
    if (!r.ok) return toast("删除失败：" + (r.error || ""));
    toast("项目已删除（会话已解绑）");
    app.projDetail = null;
    showProjectBrowser();
    await loadProjects();
  });
  // 黑板新增
  const factAdd = $("pf-add");
  if (factAdd) factAdd.addEventListener("click", async () => {
    const p = app.projDetail && app.projDetail.project;
    if (!p) return;
    const key = (($("pf-key") && $("pf-key").value) || "").trim();
    const sum = (($("pf-sum") && $("pf-sum").value) || "").trim();
    if (!key || !sum) return toast("key 与内容必填");
    const r = await api("project:fact_add", { projectId: p.id, key, category: ($("pf-cat") && $("pf-cat").value) || "misc", value: sum });
    if (!r.ok) return toast("添加失败：" + (r.error || ""));
    $("pf-key").value = ""; $("pf-sum").value = "";
    await projRefresh(); renderProjectList();
    toast("事实已添加");
  });
  // Issue 保存 / 清空
  const piSave = $("pi-save");
  if (piSave) piSave.addEventListener("click", async () => {
    const p = app.projDetail && app.projDetail.project;
    if (!p) return;
    const f = piRead();
    if (!f.title || !f.url) return toast("标题与 URL 必填");
    const r = await api("issue:save", { id: app.projEditIssueId || "", fields: f, projectId: p.id });
    if (!r.ok) return toast("保存失败：" + (r.error || ""));
    app.projEditIssueId = null;
    piFill({ id: "", title: "", sev: "medium", status: "open", method: "", url: "", desc: "", evidence: "" });
    await projRefresh(); renderProjectList();
    toast("Issue 已保存到项目");
  });
  const piClear = $("pi-clear");
  if (piClear) piClear.addEventListener("click", () => {
    app.projEditIssueId = null;
    piFill({ id: "", title: "", sev: "medium", status: "open", method: "", url: "", desc: "", evidence: "" });
  });
  // 模板新增
  const tplAdd = $("pt-add");
  if (tplAdd) tplAdd.addEventListener("click", async () => {
    const p = app.projDetail && app.projDetail.project;
    if (!p) return;
    const name = (($("pt-name") && $("pt-name").value) || "").trim();
    if (!name) return toast("模板名称必填");
    const url = (($("pt-url") && $("pt-url").value) || "").trim();
    const r = await api("project:template_add", { projectId: p.id, template: {
      name, kind: ($("pt-kind") && $("pt-kind").value) || "custom",
      desc: (($("pt-ins") && $("pt-ins").value) || "").trim(),
      instructions: (($("pt-ins") && $("pt-ins").value) || "").trim(),
      params: url ? { url } : {},
    } });
    if (!r.ok) return toast("添加失败：" + (r.error || ""));
    ["pt-name", "pt-url", "pt-ins"].forEach((id) => { if ($(id)) $(id).value = ""; });
    await projRefresh(); renderProjectList();
    toast("模板已添加");
  });
  const newConv = $("proj-new-conv");
  // 新建项目会话：先让用户输入会话名称
  if (newConv) newConv.addEventListener("click", () => {
    const p = app.projDetail && app.projDetail.project;
    if (!p) return;
    openModal(`<h3>新建会话</h3>
      <label>会话名称</label>
      <input id="pnc-title" class="text-input" placeholder="例如：登录接口分析" />
      <div class="modal-actions"><button id="pnc-cancel">取消</button><button id="pnc-ok" class="primary">创建</button></div>`);
    const box = document.querySelector(".modal-box");
    if (!box) return;
    const input = box.querySelector("#pnc-title");
    if (input) input.focus();
    box.querySelector("#pnc-cancel").addEventListener("click", closeModal);
    box.querySelector("#pnc-ok").addEventListener("click", async () => {
      const title = (($("pnc-title") && $("pnc-title").value) || "").trim();
      if (!title) return toast("请输入会话名称");
      const r = await api("ai:conversation_create", { projectId: p.id, title: title.substring(0, 60) });
      if (!r.ok) return toast("新建会话失败：" + (r.error || ""));
      closeModal();
      switchView("ai");
      await openAIDetail({ convId: r.conv.convId, title: r.conv.title, msgCount: 0, updatedAt: Date.now(), type: "task", projectId: p.id });
    });
  });
  loadProjects().catch(() => {});
}

// ============================================================
// ===== AI 模块（AI 数据区：会话 / 发现 / 审计，独立于用户工作区） =====
// ============================================================
function initAIModule() {
  // 会话记录区子 tab（该会话的黑板 / 审计 / 轨迹 / 消息）
  document.querySelectorAll("#ai-records .tabs .tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll("#ai-records .tabs .tab").forEach(x => x.classList.toggle("active", x === t));
    document.querySelectorAll("#ai-records .site-pane").forEach(p => p.classList.toggle("active", p.id === "ai-d-" + t.dataset.dtab));
  }));
  // 详情内两个独立页签：聊天 / 会话记录（一次只显示一个）
  document.querySelectorAll("#ai-detail .ai-detail-tabs .tab").forEach(t => t.addEventListener("click", () => setAIDetailTab(t.dataset.aiTab)));
  $("ai-back").addEventListener("click", closeAIDetail);
  $("ai-new-conv").addEventListener("click", newConversationFlow);
      $("ai-rename-btn").addEventListener("click", () => aiDetailConv && renameConversationFlow(aiDetailConv));
  $("ai-del-btn").addEventListener("click", () => aiDetailConv && deleteConversationFlow(aiDetailConv));
  // 聊天：发送 / 停止 / 快捷键改为 init() 开头的 document 级委托绑定（见 bindChatDelegates）。
  // 原因：委托不依赖本模块前序 init* 全部成功，即使任何初始化抛错，发送入口也一定可用。
  // 本轮执行模式：任务模式（自主调用工具）/ 对话模式（仅问答）——用户每次发送前可自主切换
  const modeSeg = $("ai-mode-seg");
  const applyModeUI = () => modeSeg.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === chatUI.mode));
  try { chatUI.mode = localStorage.getItem("f12x_ai_mode") === "chat" ? "chat" : "task"; } catch (e) { chatUI.mode = "task"; }
  applyModeUI();
  modeSeg.querySelectorAll(".mode-btn").forEach(b => b.addEventListener("click", () => {
    if (chatUI.busy) return toast("AI 执行中，结束后才能切换模式");
    chatUI.mode = b.dataset.mode;
    try { localStorage.setItem("f12x_ai_mode", chatUI.mode); } catch (e) {}
    applyModeUI();
    chatModeHint();
  }));
  // 禁思考开关（滑动按钮，本会话 UI 记忆）：开启后主模型不输出思考，直接作答/行动
  const ntChk = $("ai-nothink-chk");
  const applyNoThinkUI = () => { if (ntChk) ntChk.checked = !!chatUI.noThink; };
  try { chatUI.noThink = localStorage.getItem("f12x_ai_nothink") === "1"; } catch (e) { chatUI.noThink = false; }
  applyNoThinkUI();
  if (ntChk) ntChk.addEventListener("change", () => {
    if (chatUI.busy) { ntChk.checked = chatUI.noThink; return toast("AI 执行中，结束后再切换禁思考"); }
    chatUI.noThink = ntChk.checked;
    try { localStorage.setItem("f12x_ai_nothink", chatUI.noThink ? "1" : "0"); } catch (e) {}
    chatModeHint();
  });
  renderAISessions();
}

// ============================================================
// ===== AI 会话聊天（AI 页签：列表 ↔ 聊天工作台） =====
// 聊天气泡显示该会话的历史与实时执行流；任务/问答统一走 ai:task（携带 convId），
// 会话消息落库由后端负责，前端只做展示。
// ============================================================
const chatUI = { open: false, convId: null, busy: false, waitingResume: false, runConvId: null, typing: null, proc: null, ansBlock: null, ansEl: null, ansBuf: "", lastAsk: "", renderTimer: 0, mode: "task", noThink: false, reasonBlock: null, reasonEl: null, reasonBuf: "", reasonTimer: 0, reasonBusy: false, evN: 0, evDelta: 0, wdog: null, wdogNote: false, wdogStart: 0, sentTick: 0, expertBlock: null, expertName: "", expertTag: "", expertBuf: "", expertTimer: 0, expertBusy: false };

function chatScroll() {
  const box = $("ai-chat-msgs");
  if (box) box.scrollTop = box.scrollHeight;
}
// —— 展示层 = DSH（deepseek-harness）聊天设计 1:1 照抄，仅保留 F12x 业务/事件逻辑 ——
// DSH 结构：用户 → dshUserRow > dshUserStack > dshBubble（右对齐大圆角气泡）
//           思考 → dshReason（24px 折叠“思考”行，运行中摘要 = 实时尾部行 + 扫光，点击展开正文）
//           回答 → dshAnswer（无框 markdown 正文直接排版在流中）
//           过程/工具 → dshFlowLine（弱化小字行）
function chatScrollSoft() {
  const box = $("ai-chat-msgs");
  if (!box) return;
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
}
// 追加一条消息行（历史回看 / 用户提问 / 助手正文）

// ============ 工具执行卡片（zerofall 风格：独立框、默认折叠、标题行=预览+状态） ============
function chatToolStart(name, argsBrief) {
  const box = $("ai-chat-msgs");
  if (!box) return null;
  const card = document.createElement("div");
  card.className = "tool-card";
  const hdr = document.createElement("button");
  hdr.type = "button";
  hdr.className = "tool-card-header";
  hdr.setAttribute("aria-expanded", "false");
  const chev = document.createElement("span"); chev.className = "tool-chev"; chev.textContent = "›";
  const title = document.createElement("span"); title.className = "tool-card-title"; title.textContent = "🔧 " + String(name || "工具");
  const prev = document.createElement("span"); prev.className = "tool-card-preview"; prev.textContent = argsBrief || "";
  const st = document.createElement("span"); st.className = "tool-card-status status-running"; st.textContent = "执行中";
  hdr.append(chev, title, prev, st);
  hdr.addEventListener("click", () => {
    const open = card.classList.toggle("open");
    hdr.setAttribute("aria-expanded", open ? "true" : "false");
    chatScrollSoft();
  });
  const body = document.createElement("div");
  body.className = "tool-card-body";
  body.textContent = "";
  card.appendChild(hdr);
  card.appendChild(body);
  box.appendChild(card);
  chatScrollSoft();
  chatUI._toolCard = { card, hdr, body, name };
  return chatUI._toolCard;
}
function chatToolFill(text, ok, t) {
  if (!t) { t = chatUI._toolCard; chatUI._toolCard = null; }
  if (!t || !t.card.isConnected) return;
  const stEl = t.card.querySelector(".tool-card-status");
  if (stEl) { stEl.className = "tool-card-status " + (ok ? "status-success" : "status-error"); stEl.textContent = ok ? "完成" : "失败"; }
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  const prev = t.card.querySelector(".tool-card-preview");
  if (prev) prev.textContent = flat.substring(0, 140);
  t.body.textContent = flat ? (flat.length > 2000 ? flat.substring(0, 2000) + "\n…（超出部分见会话记录）" : flat) : "（无返回内容）";
}
function chatToolCard(name, argsBrief, bodyText, ok) {
  chatToolStart(name, argsBrief);
  chatToolFill(bodyText, ok);
}

function chatAppendMsg(kind, html, cls) {
  const box = $("ai-chat-msgs");
  if (!box) return null;
  box.querySelector(".placeholder")?.remove();
  if (kind === "user") {
    const row = document.createElement("div");
    row.className = "dshUserRow";
    const stack = document.createElement("div");
    stack.className = "dshUserStack";
    const bub = document.createElement("div");
    bub.className = "dshBubble";
    bub.innerHTML = html;
    stack.appendChild(bub);
    row.appendChild(stack);
    box.appendChild(row);
    chatScrollSoft();
    return bub;
  }
  // assistant / error：直接以 markdown 正文排版流入（dshAnswer）
  const root = document.createElement("div");
  root.className = "dshAnswer" + (cls ? " " + cls : "");
  root.innerHTML = html || "";
  box.appendChild(root);
  chatScrollSoft();
  return root;
}
// 折叠行图标：给 svg 打上 CSS 类（尺寸/显隐由 DSH 样式控制）
function dshSvg(name, cls) {
  const src = F12X_ICONS[name] || "";
  return src ? src.replace("<svg ", '<svg class="' + cls + '" ') : "";
}
// 摘要策略（ReasoningRow.tsx 照抄）：运行中展示“最新一行”（跟随尾部），停止后展示“首行”
function dshLineFirst(t) {
  const lines = String(t || "").split("\n");
  for (const l of lines) if (l.trim()) return l;
  return "";
}
function dshLineLast(t) {
  const lines = String(t || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i];
  return "";
}
// —— DSH 思考折叠行（ReasoningRow）：运行态 = 24px 摘要行 + 扫光动画；点击行展开完整正文 ——
function chatReasonStart() {
  chatReasonSeal();
  chatClearTyping();
  chatUI.reasonBuf = "";
  chatUI.reasonBusy = true;
  try {
    const box = $("ai-chat-msgs");
    const root = document.createElement("div");
    root.className = "dshReason";
    root.dataset.variant = "think";
    root.dataset.state = "running";
    const row = document.createElement("div");
    row.className = "dshReasonRow";
    row.dataset.disclosureRow = "";
    row.dataset.expandable = "";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute("aria-expanded", "false");
    const lead = document.createElement("span");
    lead.className = "dshReasonLead";
    lead.innerHTML = dshSvg("brain", "dshReasonIconIdle") + dshSvg("chevron-down", "dshReasonChevHover");
    const title = document.createElement("span");
    title.className = "dshReasonTitle";
    title.textContent = "思考";
    const sep = document.createElement("span");
    sep.className = "dshReasonSep";
    sep.setAttribute("aria-hidden", "true");
    const summary = document.createElement("span");
    summary.className = "dshReasonSummary";
    const summaryText = document.createElement("span");
    summaryText.className = "dshReasonSummaryText";
    summary.appendChild(summaryText);
    row.append(lead, title, sep, summary);
    const toggle = () => {
      const open = root.hasAttribute("data-expanded");
      if (open) {
        root.removeAttribute("data-expanded");
        row.setAttribute("aria-expanded", "false");
        const bd = root.querySelector(".dshReasonBody");
        if (bd) bd.remove();
      } else {
        root.setAttribute("data-expanded", "");
        row.setAttribute("aria-expanded", "true");
        const body = document.createElement("div");
        body.className = "dshReasonBody";
        body.textContent = chatUI.reasonBuf || "";
        root.appendChild(body);
      }
      chatScrollSoft();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    root.appendChild(row);
    box.appendChild(root);
    // 默认折叠（zerofall 风格）：点击标题行展开正文；折叠时标题行即预览
    chatUI.reasonBlock = root;
    chatUI.reasonEl = null;
  } catch (e) {
    console.error("[F12x] 思考块创建失败：", e);
    chatUI.reasonBlock = null; chatUI.reasonEl = null; chatUI.reasonBusy = false;
  }
}
// 同步摘要行 + 展开正文（运行态摘要 = 最新行跟随尾部，停止态 = 首行）
function chatReasonRefresh() {
  const root = chatUI.reasonBlock;
  if (!root || !root.isConnected) return;
  const running = !!chatUI.reasonBusy;
  root.dataset.state = running ? "running" : "ok";
  const summary = root.querySelector(".dshReasonSummary");
  if (summary) {
    if (running) summary.setAttribute("data-follow-end", "");
    else summary.removeAttribute("data-follow-end");
  }
  const txt = root.querySelector(".dshReasonSummaryText");
  if (txt) txt.textContent = chatUI.reasonBuf ? (running ? dshLineLast(chatUI.reasonBuf) : dshLineFirst(chatUI.reasonBuf)) : "";
  const body = root.querySelector(".dshReasonBody");
  if (body) body.textContent = chatUI.reasonBuf || "";
}
function chatReasonAppend(text) {
  if (!chatUI.reasonBlock) chatReasonStart();
  if (!text) return;
  chatUI.reasonBuf += text;
  if (!chatUI.reasonBusy) { chatReasonRefresh(); return; } // 已封口后的迟到增量：仅同步内容，不复活运行态
  clearTimeout(chatUI.reasonTimer);
  chatUI.reasonTimer = setTimeout(() => { chatReasonRefresh(); chatScrollSoft(); }, 30);
}
function chatReasonSeal(finalText) {
  if (!chatUI.reasonBusy) return;
  chatUI.reasonBusy = false;
  clearTimeout(chatUI.reasonTimer);
  const root = chatUI.reasonBlock;
  if (root && root.isConnected) {
    if (!String(chatUI.reasonBuf || "").trim()) root.remove(); // 无实质思考内容 → 不留空行
    else chatReasonRefresh();
  }
  chatScrollSoft();
}
// ============================================================
// 专家可见块（与"思考"块同构，variant=expert）：专家思考实时可见、默认展开、结束带结论
// 修复：原 expert_reasoning 事件在 chatOnStatus 无处理分支 → 专家思考全程不可见
// ============================================================
function chatExpertStart(name, tool) {
  chatExpertSeal(); // 前一个专家块先封口
  chatUI.expertName = String(name || "专家");
  chatUI.expertTag = String(tool || "");
  chatUI.expertBuf = "";
  chatUI.expertBusy = true;
  try {
    const box = $("ai-chat-msgs");
    const root = document.createElement("div");
    root.className = "dshReason";
    root.dataset.variant = "expert";
    root.dataset.state = "running";
    const row = document.createElement("div");
    row.className = "dshReasonRow";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute("aria-expanded", "false"); // 与"默认折叠"实现保持一致（原写 true，读屏会误报展开态）
    const lead = document.createElement("span");
    lead.className = "dshReasonLead";
    lead.innerHTML = dshSvg("bot", "dshReasonIconIdle") + dshSvg("chevron-down", "dshReasonChevHover");
    const title = document.createElement("span");
    title.className = "dshReasonTitle";
    title.textContent = (chatUI.expertName === "复核审计员" ? "🧭 " : "专家 · ") + chatUI.expertName + (chatUI.expertTag ? "（" + chatUI.expertTag + "）" : "");
    const sep = document.createElement("span"); sep.className = "dshReasonSep"; sep.setAttribute("aria-hidden", "true");
    const summary = document.createElement("span"); summary.className = "dshReasonSummary";
    const summaryText = document.createElement("span"); summaryText.className = "dshReasonSummaryText";
    summary.appendChild(summaryText);
    row.append(lead, title, sep, summary);
    const toggle = () => {
      const open = root.hasAttribute("data-expanded");
      if (open) {
        root.removeAttribute("data-expanded");
        row.setAttribute("aria-expanded", "false");
        const bd = root.querySelector(".dshReasonBody");
        if (bd) bd.remove();
      } else {
        root.setAttribute("data-expanded", "");
        row.setAttribute("aria-expanded", "true");
        const body = document.createElement("div");
        body.className = "dshReasonBody";
        body.textContent = chatUI.expertBuf || "";
        root.appendChild(body);
      }
      chatScrollSoft();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    root.appendChild(row);
    box.appendChild(root);
    // 默认折叠（zerofall 风格）
    chatUI.expertBlock = root;
  } catch (e) {
    console.error("[F12x] 专家块创建失败：", e);
    chatUI.expertBlock = null; chatUI.expertBusy = false;
  }
}
function chatExpertRefresh() {
  const root = chatUI.expertBlock;
  if (!root || !root.isConnected) return;
  const running = !!chatUI.expertBusy;
  root.dataset.state = running ? "running" : "ok";
  const summary = root.querySelector(".dshReasonSummary");
  if (summary) { if (running) summary.setAttribute("data-follow-end", ""); else summary.removeAttribute("data-follow-end"); }
  const txt = root.querySelector(".dshReasonSummaryText");
  if (txt) txt.textContent = chatUI.expertBuf ? (running ? dshLineLast(chatUI.expertBuf) : dshLineFirst(chatUI.expertBuf)) : "";
  const body = root.querySelector(".dshReasonBody");
  if (body) body.textContent = chatUI.expertBuf || "";
}
function chatExpertAppend(text) {
  if (!chatUI.expertBlock) chatExpertStart(chatUI.expertName || "专家");
  if (!text) return;
  chatUI.expertBuf += text;
  if (!chatUI.expertBusy) { chatExpertRefresh(); return; }
  clearTimeout(chatUI.expertTimer);
  chatUI.expertTimer = setTimeout(() => { chatExpertRefresh(); chatScrollSoft(); }, 30);
}
// 专家回合每步实时呈现（步骤行与思考同一块，用户可见查证推进）
function chatExpertStepMark(step, tool, args) {
  if (!chatUI.expertBlock) chatExpertStart(chatUI.expertName || "专家");
  const mark = "\n→ 第 " + String(step || "?") + " 步：" + String(tool || "") + (args ? "（" + String(args).substring(0, 90) + "）" : "");
  chatUI.expertBuf = (String(chatUI.expertBuf || "").trim() ? String(chatUI.expertBuf).trim() + mark : mark);
  chatExpertRefresh();
  chatScrollSoft();
}
// 专家回合每步查证结果（expert_tool_done）：在块内补一行 ✓/✗，避免"调了什么、成不成功"只有思考没结论
function chatExpertStepDone(step, tool, ok) {
  if (!chatUI.expertBlock) return;
  const mark = "\n" + (ok ? "  ✓ 第 " + String(step || "?") + " 步 " + String(tool || "") + " 完成" : "  ✗ 第 " + String(step || "?") + " 步 " + String(tool || "") + " 失败");
  chatUI.expertBuf = String(chatUI.expertBuf || "") + mark;
  chatExpertRefresh();
  chatScrollSoft();
}
// 封口：把结论/错误并入正文（思考 + 结论同一块可见、可折叠）
function chatExpertSeal(st) {
  if (!chatUI.expertBusy && !chatUI.expertBlock) return;
  chatUI.expertBusy = false;
  clearTimeout(chatUI.expertTimer);
  const root = chatUI.expertBlock;
  if (root && root.isConnected) {
    if (st) {
      const parts = [];
      if (st.verified) parts.push("✅ 结论已由本回合工具实测验证");
      if (Array.isArray(st.toolTrail) && st.toolTrail.length) parts.push("【查证步骤】" + st.toolTrail.map((t, i) => (i + 1) + ". " + String(t.tool || "") + (t.args ? "（" + String(t.args).substring(0, 80) + "）" : "") + (t.ok ? "" : " ✗")).join("\n"));
      if (st.conclusion) parts.push("【结论】" + String(st.conclusion));
      if (st.followup) parts.push("【建议】" + String(st.followup));
      if (st.error) parts.push("【出错】" + String(st.error));
      if (parts.length) chatUI.expertBuf = (String(chatUI.expertBuf || "").trim() ? String(chatUI.expertBuf).trim() + "\n\n" : "") + parts.join("\n");
    }
    if (!String(chatUI.expertBuf || "").trim()) root.remove();
    else chatExpertRefresh();
  }
  chatUI.expertBlock = null;
  chatScrollSoft();
}

// ============================================================
// 对抗性审查可见卡（variant=review）：触发即建卡并默认展开（内容可见），
// 问题全文/依据/要求写入卡内；主代理回应（review_reply）并入同一张卡后封口。
// 历史回放：_kind:"review" 回放标记整对（问题+回应）渲染成同一张卡。
// ============================================================
function chatReviewToggle() {
  const root = chatUI.reviewBlock;
  if (!root || !root.isConnected) return;
  const row = root.querySelector('.dshReasonRow');
  if (root.hasAttribute('data-expanded')) {
    root.removeAttribute('data-expanded');
    if (row) row.setAttribute('aria-expanded', 'false');
    const bd = root.querySelector('.dshReasonBody');
    if (bd) bd.remove();
  } else {
    root.setAttribute('data-expanded', '');
    if (row) row.setAttribute('aria-expanded', 'true');
    const bd = document.createElement('div');
    bd.className = 'dshReasonBody';
    bd.textContent = chatUI.reviewBuf || '';
    root.appendChild(bd);
  }
  chatScrollSoft();
}
// 建卡前把上一张仍在"待回应"的卡封口（不让运行态扫光挂在旧卡上）
function chatReviewSealPending() {
  if (!chatUI.reviewBlock) return;
  if (chatUI.reviewBusy) {
    chatUI.reviewBusy = false;
    clearTimeout(chatUI.reviewTimer);
    if (chatUI.reviewBlock.isConnected) chatUI.reviewBlock.dataset.state = 'ok';
  }
}
function chatReviewStart(st) {
  chatReviewSealPending();
  chatClearTyping();
  const round = st && st.round != null ? st.round : null;
  const reason = String((st && (st.reason || st.conclusion)) || '对抗性审查');
  const q = String((st && st.question) || '');
  chatUI.reviewBuf = '【审查触发】' + reason
    + (st && st.evidence ? '\n【审查依据】' + String(st.evidence) : '')
    + (st && st.alternative ? '\n【替代解释】' + String(st.alternative) : '')
    + (q ? '\n【审查问题】\n' + q : '')
    + (st && st.action ? '\n【要求】' + String(st.action) : '')
    + '\n【主代理回应】（模型须以「自我审查回应」并引用实测数据回应，回应内容将并入本卡）';
  chatUI.reviewBusy = true;
  clearTimeout(chatUI.reviewTimer);
  try {
    const box = $('ai-chat-msgs');
    if (!box) { chatUI.reviewBusy = false; return; }
    const root = document.createElement('div');
    root.className = 'dshReason';
    root.dataset.variant = 'review';
    root.dataset.state = 'running';
    // 与 zerofall 其它类别卡一致：默认折叠，点击标题行展开（摘要行显示审查问题摘要）
    const row = document.createElement('div');
    row.className = 'dshReasonRow';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-expanded', 'false');
    const lead = document.createElement('span'); lead.className = 'dshReasonLead';
    lead.innerHTML = dshSvg('bot', 'dshReasonIconIdle') + dshSvg('chevron-down', 'dshReasonChevHover');
    const ti = document.createElement('span'); ti.className = 'dshReasonTitle';
    ti.textContent = '⚠ 对抗性审查' + (round != null ? '（第 ' + round + ' 轮）' : '');
    const sep = document.createElement('span'); sep.className = 'dshReasonSep'; sep.setAttribute('aria-hidden', 'true');
    const summary = document.createElement('span'); summary.className = 'dshReasonSummary';
    const stx = document.createElement('span'); stx.className = 'dshReasonSummaryText';
    stx.textContent = q ? q.replace(/\s+/g, ' ').substring(0, 90) : reason;
    summary.appendChild(stx);
    row.append(lead, ti, sep, summary);
    row.addEventListener('click', chatReviewToggle);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chatReviewToggle(); } });
    root.appendChild(row);
    box.appendChild(root); // 默认折叠：正文在展开时按 chatUI.reviewBuf 实时构建（含后续回应）
    chatUI.reviewBlock = root;
  } catch (e) {
    console.error('[F12x] 对抗性审查卡创建失败：', e);
    chatUI.reviewBlock = null; chatUI.reviewBusy = false;
  }
  chatScrollSoft();
}
// 主代理回应到达：并入审查卡同一块（问题+回应同卡可见），封口为 ok
function chatReviewReply(text) {
  const t = String(text || '').trim();
  const root = chatUI.reviewBlock;
  if (!root || !root.isConnected) {
    // 卡片缺失的迟到事件（如重开会话后才到）→ 以普通正文呈现，内容仍可见
    if (t) chatAppendMsg('assistant', mdRender(t), '');
    return;
  }
  chatUI.reviewBusy = false;
  clearTimeout(chatUI.reviewTimer);
  const base = String(chatUI.reviewBuf || '').replace(/\n*【主代理回应】[\s\S]*$/, '');
  chatUI.reviewBuf = (base ? base + '\n' : '') + '【主代理回应】' + (t ? '\n' + t : '（模型未给出文本回应）');
  root.dataset.state = 'ok';
  const bd = root.querySelector('.dshReasonBody');
  if (bd) bd.textContent = chatUI.reviewBuf;
  chatScrollSoft();
}
// 本轮收尾兜底：审查卡仍在"待回应" → 标记为未回应并封口（不静默消失）
function chatReviewAbort() {
  if (!chatUI.reviewBusy) return;
  chatUI.reviewBusy = false;
  clearTimeout(chatUI.reviewTimer);
  const root = chatUI.reviewBlock;
  if (root && root.isConnected) {
    root.dataset.state = 'ok';
    const t = String(chatUI.reviewBuf || '');
    if (!/【主代理回应】/.test(t)) chatUI.reviewBuf = t + '\n【主代理回应】（本轮未收到回应——任务中止/结束）';
    else chatUI.reviewBuf = t + '\n（本轮未收到模型回应，任务中止/结束）';
    const bd = root.querySelector('.dshReasonBody');
    if (bd) bd.textContent = chatUI.reviewBuf;
  }
  chatScrollSoft();
}

// 丢弃当前回答正文（无内容可留 / 出错重开）
function chatDiscardAns() {
  clearTimeout(chatUI.renderTimer);
  if (chatUI.ansEl && chatUI.ansEl.isConnected) chatUI.ansEl.remove();
  chatUI.ansBlock = null;
  chatUI.ansEl = null;
  chatUI.ansBuf = "";
}
// 回答段封口（顺序修复）：把"当前进行中的回答段"定稿留在原位，并解除活动指针。
// 之后新的 answer_delta 会从聊天流底部另起一段——保证每段正文停留在它真实发生的时间位置，
// 不会出现"过程行插在旧回答段下方后，新正文仍写回上方旧段"的乱序。
function chatSealAns() {
  clearTimeout(chatUI.renderTimer);
  if (chatUI.ansEl && chatUI.ansEl.isConnected) {
    if (chatUI.ansBuf.trim()) {
      chatUI.ansEl.innerHTML = mdRender(chatUI.ansBuf);
    } else {
      try { chatUI.ansEl.remove(); } catch (e) {}
    }
  }
  chatUI.ansBlock = null;
  chatUI.ansEl = null;
  chatUI.ansBuf = "";
}
// 追加一条过程行（工具 / 专家 / 计划 / 提示等弱化小字行，DSH 无框样式）
function chatFlowLine(cls, html) {
  const box = $("ai-chat-msgs");
  if (!box) return null;
  const d = document.createElement("div");
  d.className = "dshFlowLine" + (cls ? " " + cls : "");
  d.innerHTML = html;
  box.appendChild(d);
  chatScrollSoft();
  return d;
}
// 截图引用（方案 001 / P5）：会话里只显示引用标记，点击弹层看原图；不限制数量
function chatShotRef(key, convId, size) {
  const k = String(key || "");
  if (!k) return null;
  const cid = String(convId || (chatUI && chatUI.convId) || "");
  const el = chatFlowLine("ok", '📎 截图引用 <code>' + esc(k) + '</code>'
    + (size ? ' <span class="shot-size">' + esc(String(size)) + '</span>' : '')
    + ' <button class="mini-btn shot-open">查看</button>');
  if (!el) return null;
  const btn = el.querySelector(".shot-open");
  if (btn) btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const storageKey = "shot:" + cid + ":" + k;
    const got = await chrome.storage.local.get(storageKey);
    const dataUrl = got[storageKey];
    if (!dataUrl) return toast("截图引用已失效（会话可能已删除）");
    openModal(`<h3>截图引用 <code>${esc(k)}</code></h3><img src="${dataUrl}" style="max-width:100%" alt="截图"/>`
      + '<div class="modal-actions"><button id="shot-download" class="mini-btn">导出 PNG</button><button>关闭</button></div>');
    const mb = document.querySelector(".modal-box");
    if (!mb) return;
    const dl = mb.querySelector("#shot-download");
    if (dl) dl.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = dataUrl; a.download = "f12x-" + k + ".png";
      document.body.appendChild(a); a.click(); a.remove();
    });
    mb.querySelector(".modal-actions button:last-child").addEventListener("click", closeModal);
  });
  return el;
}
// 研讨条目实时可见：executor 的 workspace_note → pushStatus({type:"workspace"})，原先无消费者
function chatWorkspaceNote(entry) {
  if (!entry) return;
  const kind = entry.type === "question" ? "疑问" : entry.type === "decision" ? "决策" : "发现";
  const raw = String(entry.content || "").replace(/\s+/g, " ").trim();
  const brief = raw.length > 120 ? raw.substring(0, 120) + "…" : raw;
  const id = entry.id ? " " + escapeHtml(String(entry.id)) : "";
  const to = entry.to ? " → " + escapeHtml(String(entry.to)) : "";
  const promoted = entry.status === "promoted" ? " · 已沉淀黑板" : "";
  chatFlowLine("", "📝 研讨" + kind + id + to + "：" + escapeHtml(brief) + promoted);
}
// 会话增量落库回执（agent.flushSession → conversation:changed）：
// 列表页实时刷新；详情记录页按 2s 节流刷新（轨迹走 archify 渲染，不能每次 flush 都跑）
let _ccRefreshAt = 0, _ccTimer = null;
function chatOnConversationChanged(convId) {
  if (!convId) return;
  const list = $("ai-list");
  if (list && !list.classList.contains("hidden")) { renderAISessions().catch(() => {}); return; }
  if (!chatUI.open || chatUI.convId !== convId) return;
  const rec = $("ai-records");
  if (!rec || rec.classList.contains("hidden") || !rec.classList.contains("active")) return;
  const now = Date.now();
  const wait = 2000 - (now - _ccRefreshAt);
  if (wait <= 0) { _ccRefreshAt = now; chatRefreshRecords().catch(() => {}); }
  else if (!_ccTimer) {
    _ccTimer = setTimeout(() => { _ccTimer = null; _ccRefreshAt = Date.now(); chatRefreshRecords().catch(() => {}); }, wait);
  }
}
function chatClearTyping() {
  if (chatUI.typing) { chatUI.typing.remove(); chatUI.typing = null; }
}
function chatShowTyping(text) {
  chatClearTyping();
  const d = chatFlowLine("", '<span class="cf-tag">⟳</span> ' + escapeHtml(text || "思考中…"));
  chatUI.typing = d;
}
// 看门狗单行（持续刷新，不刷屏）：模型长时间无新输出时，周期性就地更新这一行
function wdShow(html) {
  chatClearTyping();
  let el = chatUI.wdogEl;
  if (el && el.isConnected) { el.innerHTML = html; return el; }
  el = chatFlowLine("", html);
  chatUI.wdogEl = el;
  return el;
}
function wdHide() {
  if (chatUI.wdogEl) { try { chatUI.wdogEl.remove(); } catch (e) {} chatUI.wdogEl = null; }
}
// 按需创建最终“回答”正文（DSH：无框 markdown 直接流入聊天，随流随写，最终必可见）
// 顺序修复核心：当前回答段已不在消息流底部（思考/工具/过程行插到它下方）时，
// 说明这次 answer_delta 属于“之后的新正文” → 旧段就地封口定稿，从流底另起新段，
// 保证每段正文停留在它真实发生的时间位置，不再把新文字写回上方的旧段。
function chatEnsureAns() {
  chatReasonSeal(); // 回答开始前，若有进行中的思考行先封口
  chatClearTyping(); // 先移走临时状态行，避免干扰“是否仍在流底”判断
  if (chatUI.ansEl && chatUI.ansEl.isConnected) {
    const box = $("ai-chat-msgs");
    const atTail = box && box.lastElementChild === chatUI.ansEl;
    if (atTail) return chatUI.ansEl; // 仍是流底 → 同一段连续续写
    chatSealAns(); // 已被过程行隔开 → 旧段就地定稿，另起新段
  }
  chatUI.ansBuf = "";
  try {
    chatUI.ansBlock = null;
    chatUI.ansEl = chatAppendMsg("assistant", "", "");
  } catch (e) {
    console.error("[F12x] 回答正文创建失败：", e);
    chatUI.ansBlock = null;
    chatUI.ansEl = null;
  }
  return chatUI.ansEl;
}
function chatRenderAns() {
  if (!chatUI.ansEl || !chatUI.ansEl.isConnected) return;
  chatUI.ansEl.innerHTML = mdRender(chatUI.ansBuf);
  chatScrollSoft();
}
// 答案增量（节流渲染 markdown）
function chatAppendAns(text) {
  chatEnsureAns();
  chatUI.ansBuf += text;
  clearTimeout(chatUI.renderTimer);
  chatUI.renderTimer = setTimeout(chatRenderAns, 60);
}
function chatFinalizeAns(stateText) {
  clearTimeout(chatUI.renderTimer);
  chatRenderAns();
}
// 兜底（关键）：若事件流因任何原因没有把最终回复推进聊天区（块未建立 / 内容为空 / 半途被截），
// 在 ai:task 的 sendResponse 返回后，用其携带的完整回复(reply)补齐，保证"最终回复必显示"。
function chatSealFallback(reply) {
  const txt = String(reply || "").trim();
  if (!txt) {
    diagLine("诊断：ai:task 返回成功但 reply 为空（事件 " + (chatUI.evN || 0) + " / answer_delta " + (chatUI.evDelta || 0) + "）");
    return;
  }
  console.debug("[F12x] chatSealFallback len=" + txt.length, { hasEl: !!chatUI.ansEl, buf: chatUI.ansBuf.length });
  // 顺序一致：若当前回答段已不在流底（中途段落），先就地定稿它，完整回复落到新的底部段
  if (chatUI.ansEl && chatUI.ansEl.isConnected) {
    const box = $("ai-chat-msgs");
    if (box && box.lastElementChild !== chatUI.ansEl) chatSealAns();
  }
  if (chatUI.ansEl && chatUI.ansEl.isConnected) {
    // 已有回答正文：若流式内容已包含完整回复则仅收尾；否则用返回的完整回复覆盖（可能是空转/半截）
    if (chatUI.ansBuf.trim()) {
      const cur = chatUI.ansBuf.replace(/\s+$/g, "");
      if (!cur.endsWith(txt)) {
        diagLine("诊断：流式内容与最终回复不一致（收到 " + (chatUI.evDelta || 0) + " 个 answer_delta），已用完整回复覆盖");
        chatUI.ansBuf = txt;
      }
      chatFinalizeAns();
    } else {
      chatUI.ansBuf = txt;
      chatFinalizeAns();
    }
    return;
  }
  // 一个正文都未建立（事件完全没送达）→ 直接补一段 markdown 正文并填入最终回复
  chatUI.ansBuf = txt;
  try {
    chatUI.ansBlock = null;
    chatUI.ansEl = chatAppendMsg("assistant", "", "");
    chatFinalizeAns();
    diagLine("诊断：事件流未送达聊天区（收到 " + (chatUI.evN || 0) + " 个事件 / answer_delta " + (chatUI.evDelta || 0) + "），已由响应回复补全正文");
  } catch (e) {
    console.error("[F12x] 兜底正文创建失败，降级气泡：", e);
    chatUI.ansEl = chatAppendMsg("assistant", mdRender(txt), "");
    diagLine("诊断：兜底正文创建失败，已降级气泡：" + (e && e.message || e));
  }
}
function chatSetBusy(v) {
  chatUI.busy = v;
  const stop = $("ai-chat-stop");
  const send = $("ai-chat-send");
  const hint = $("ai-composer-hint");
  const msel = $("ai-model-sel");
  if (stop) stop.classList.toggle("hidden", !v);
  if (send) send.disabled = v;
  if (msel) msel.disabled = v || !chatUI.open;
  if (hint) hint.textContent = v ? (chatUI.waitingResume ? "已接管，等待继续…" : "AI 执行中，可停止…") : "";
  if (!v) chatModeHint();
}
// 输入区模式提示文案（任务模式可自主调工具 / 对话模式仅问答）
function chatModeHint() {
  const hint = $("ai-composer-hint");
  if (!hint || chatUI.busy) return;
  hint.textContent = (chatUI.mode === "chat" ? "对话模式：仅问答，不调用页面工具" : "任务模式：AI 可自主调用工具执行") + " · Enter 发送，Shift+Enter 换行";
}

// 渲染历史消息为聊天气泡（打开会话时）
// ============================================================
// Prompt 导航（右侧悬浮，不动主布局）：
// 记录仅用户消息；每条带唯一 id（DOM data-message-id 与导航 data-message-id 对应）；
// 点击平滑滚动+短暂高亮；当前视口消息 active 自动同步（IntersectionObserver + rAF 滚动兜底）；
// 新会话/切会话自动清空并可从历史重建。不触碰发送/流式/Markdown/历史逻辑。
// ============================================================
const pnState = {
  convId: null,
  records: [],      // [{ id, role:'user', content, summary, timestamp }]
  byId: {},
  counter: 0,
  io: null,
  observed: new Set(),
  activeId: null,
  bulk: false,
  _raf: null
};
function pnSummary(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  const MAX = 46;
  return flat.length > MAX ? flat.slice(0, MAX) + "…" : flat;
}
function pnConvKey(convId) {
  return String(convId || "x").replace(/[^a-zA-Z0-9_-]/g, "").slice(-10) || "c";
}
function pnReset() {
  if (pnState.io) { try { pnState.io.disconnect(); } catch (e) {} pnState.io = null; }
  pnState.observed = new Set();
  pnState.convId = null;
  pnState.records = [];
  pnState.byId = {};
  pnState.counter = 0;
  pnState.activeId = null;
  if (pnState._raf) { cancelAnimationFrame(pnState._raf); pnState._raf = null; }
}
function pnNavEl() { return $("pn-nav"); }
function pnListEl() { return $("pn-list"); }
// 会话绑定：pnState 只服务当前打开的会话；换会话/关会话/首次发送前调用，
// 保证不同会话的 Prompt 记录互不串扰
function pnBindConv() {
  const convId = chatUI.convId || null;
  if (!convId) { pnReset(); pnRenderEmpty(); return false; }
  if (pnState.convId !== convId) {
    pnReset();
    pnState.convId = convId;
    pnRenderEmpty();
  }
  return true;
}
function pnEnsureObserver() {
  if (pnState.io) return;
  const box = $("ai-chat-msgs");
  if (!box) return;
  pnState.io = new IntersectionObserver(() => { pnScheduleActive(); }, { root: box, threshold: [0, 0.1, 0.3, 0.7, 1] });
}
function pnObserve(row) {
  if (!row || pnState.observed.has(row)) return;
  pnState.observed.add(row);
  pnEnsureObserver();
  if (pnState.io) pnState.io.observe(row);
}
function pnRegisterRow(row, text) {
  if (!row || !row.isConnected) return null;
  if (!row.dataset.messageId) {
    const convId = chatUI.convId || "";
    const id = "pn-" + pnConvKey(convId) + "-" + (pnState.counter + 1);
    row.dataset.messageId = id;
  }
  const id = row.dataset.messageId;
  if (!pnState.byId[id]) {
    const content = String(text || "").trim();
    const rec = { id, role: "user", content, summary: pnSummary(content), timestamp: Date.now() };
    pnState.records.push(rec);
    pnState.byId[id] = rec;
    pnState.counter++;
    if (!pnState.bulk) { pnRenderList(); pnScheduleActive(); } // 重建时批量攒一次，发送时即时
  }
  pnObserve(row);
  return pnState.byId[id];
}
function pnRenderEmpty() {
  const list = pnListEl();
  if (list) list.innerHTML = '<div class="pn-empty">暂无用户输入</div>';
  const cnt = $("pn-count"); if (cnt) cnt.textContent = "";
}
function pnRenderList() {
  const list = pnListEl();
  const cnt = $("pn-count");
  if (!list) return;
  if (!pnState.records.length) { pnRenderEmpty(); return; }
  if (cnt) cnt.textContent = String(pnState.records.length);
  list.innerHTML = pnState.records.map(r => {
    const active = pnState.activeId === r.id;
    return '<button type="button" class="pn-item' + (active ? " active" : "") + '" data-message-id="' + esc(r.id) + '" title="' + esc(r.content || "") + '">' + esc(r.summary || r.content || "用户输入") + "</button>";
  }).join("");
  list.querySelectorAll(".pn-item").forEach(item => item.addEventListener("click", () => pnJumpTo(item.dataset.messageId)));
}
function pnJumpTo(id) {
  if (!id) return;
  const box = $("ai-chat-msgs");
  const target = box ? box.querySelector('[data-message-id="' + id + '"]') : null;
  if (!target) return;
  try { target.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { try { target.scrollIntoView(); } catch (e2) {} }
  pnSetActive(id);
  target.classList.add("pn-pulse");
  setTimeout(() => { if (target.isConnected) target.classList.remove("pn-pulse"); }, 1600);
}
function pnSetActive(id) {
  if (pnState.activeId === id) { return; }
  pnState.activeId = id;
  const list = pnListEl();
  if (!list) return;
  list.querySelectorAll(".pn-item").forEach(it => it.classList.toggle("active", it.dataset.messageId === id));
}
function pnScheduleActive() {
  if (pnState._raf) return;
  pnState._raf = requestAnimationFrame(() => { pnState._raf = null; pnComputeActive(); });
}
// 取“距视口顶部最近”的用户消息：顶部第一条可见者；若整段在视口上方（长消息中段），取最后一条在上方的
function pnComputeActive() {
  const box = $("ai-chat-msgs");
  const list = pnListEl();
  if (!box || !list) return;
  const rows = Array.from(box.querySelectorAll(".dshUserRow[data-message-id]"));
  if (!rows.length) { pnSetActive(null); return; }
  const top = box.getBoundingClientRect().top;
  let under = null, chosen = null;
  for (const r of rows) {
    const d = r.getBoundingClientRect().top - top;
    if (d >= -8) { chosen = r; break; }
    under = r;
  }
  const row = chosen || under || rows[rows.length - 1];
  pnSetActive(row ? row.dataset.messageId : null);
}
function pnRebuildFromDom() {
  const box = $("ai-chat-msgs");
  const list = pnListEl();
  if (!box || !list) return;
  if (!pnBindConv()) return; // 绑定当前会话；换会话先清空旧记录
  const rows = Array.from(box.querySelectorAll(":scope > .dshUserRow"));
  if (!rows.length) { pnRenderEmpty(); return; }
  pnState.bulk = true;
  rows.forEach(row => { const bub = row.querySelector(".dshBubble"); pnRegisterRow(row, bub ? bub.textContent : ""); });
  pnState.bulk = false;
  pnRenderList();
  pnComputeActive();
}
function pnSyncContainer() {
  const chat = $("ai-chat");
  const nav = pnNavEl();
  if (chat && nav) chat.classList.toggle("pn-open", !nav.classList.contains("collapsed"));
}
function pnToggle() {
  const nav = pnNavEl();
  if (!nav) return;
  nav.classList.toggle("collapsed");
  pnSyncContainer();
}
function pnApplyResponsive() {
  const nav = pnNavEl();
  if (!nav) return;
  const wide = window.matchMedia("(min-width: 620px)").matches;
  nav.classList.toggle("collapsed", !wide);
  pnSyncContainer();
}
function pnInit() {
  const nav = pnNavEl();
  if (!nav) return;
  const box = $("ai-chat-msgs");
  if (box) box.addEventListener("scroll", () => pnScheduleActive(), { passive: true });
  const t = $("pn-toggle");
  if (t) t.addEventListener("click", pnToggle);
  pnApplyResponsive();
  window.addEventListener("resize", pnApplyResponsive);
}
// 每帧一次的滚动监听：用户快速滚动/消息变高/新消息插入都基于真实几何重算（不轮询）

// 长会话窗口化：默认只渲染最近 N 条，旧消息按需加载（400 条全量渲染在低配上明显卡顿）
const CHAT_HISTORY_WINDOW = 60;
let _chatShown = 0;
let _chatShownConv = null;

function renderChatHistory() {
  const box = $("ai-chat-msgs");
  box.innerHTML = "";
  chatPlanClear(); // 先清上一会话的残留计划条，再按本会话 plan 置顶（防跨会话串计划）
  chatUI.proc = null; chatUI.ansBlock = null; chatUI.ansEl = null; chatUI.typing = null; chatUI.ansBuf = "";
  chatUI.reasonBlock = null; chatUI.reasonEl = null; chatUI.reasonBuf = ""; chatUI.reasonBusy = false; clearTimeout(chatUI.reasonTimer);
  chatUI.expertBlock = null; chatUI.expertName = ""; chatUI.expertTag = ""; chatUI.expertBuf = ""; chatUI.expertBusy = false; clearTimeout(chatUI.expertTimer);
  chatUI.reviewBlock = null; chatUI.reviewBuf = ""; chatUI.reviewBusy = false; clearTimeout(chatUI.reviewTimer);
  // 修复：重放保留 thinking/expert 回放标记（供思考/专家块持久回看）；剔除 system、内部注入(无 kind)、计划标记
  const msgs = (aiDetailConv?.messages || []).filter(m => m && m.role !== "system" && !(m.role === "user" && m._sys && !(m._kind === "thinking" || m._kind === "expert" || m._kind === "review"))).slice(-400);
  if (!msgs.length) {
    box.innerHTML = '<div class="placeholder">空会话：在下方输入开始对话（任务/提问将记录到此会话）</div>';
    chatUpsertPlan(aiDetailConv?.plan); // 空消息但会话有计划（如任务刚结束）也展示
    pnRenderEmpty();
    return;
  }
  chatUpsertPlan(aiDetailConv?.plan); // 修复：计划置顶可见
  // 回放一行可折叠"思考/专家"块（默认展开正文）
  const replayRow = (kind, title, bodyText, summaryText) => {
    try {
      const root = document.createElement("div");
      root.className = "dshReason";
      root.dataset.variant = kind === "expert" ? "expert" : kind === "review" ? "review" : "think";
      root.dataset.state = "ok";
      // 默认折叠（zerofall 风格）：正文在展开时由 toggle 重建
      const row = document.createElement("div");
      row.className = "dshReasonRow";
      row.setAttribute("role", "button"); row.tabIndex = 0; row.setAttribute("aria-expanded", "false");
      const lead = document.createElement("span"); lead.className = "dshReasonLead";
      lead.innerHTML = dshSvg((kind === "expert" || kind === "review") ? "bot" : "brain", "dshReasonIconIdle") + dshSvg("chevron-down", "dshReasonChevHover");
      const ti = document.createElement("span"); ti.className = "dshReasonTitle"; ti.textContent = title;
      const sep = document.createElement("span"); sep.className = "dshReasonSep"; sep.setAttribute("aria-hidden", "true");
      const summary = document.createElement("span"); summary.className = "dshReasonSummary";
      const stx = document.createElement("span"); stx.className = "dshReasonSummaryText"; stx.textContent = summaryText || "";
      summary.appendChild(stx);
      row.append(lead, ti, sep, summary);
      const toggle = () => {
        const open = root.hasAttribute("data-expanded");
        if (open) { root.removeAttribute("data-expanded"); row.setAttribute("aria-expanded", "false"); const bd = root.querySelector(".dshReasonBody"); if (bd) bd.remove(); }
        else { root.setAttribute("data-expanded", ""); row.setAttribute("aria-expanded", "true"); const body = document.createElement("div"); body.className = "dshReasonBody"; body.textContent = bodyText; root.appendChild(body); }
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      root.appendChild(row);
      box.appendChild(root);
      return root;
    } catch (e) { return null; }
  };
  const textOf = (m) => {
    if (m.content == null) return "";
    if (typeof m.content === "string") return m.content;
    try { return JSON.stringify(m.content); } catch (e) { return ""; }
  };
  // —— 相邻去重（修复：早期水位修复前可能整段历史重抄；同内容连续重复只留一条） ——
  const msgsDedup = [];
  let prevKey = null;
  for (const m of msgs) {
    const key = (m.role || "") + "|" + (m._kind || "") + "|" + textOf(m);
    if (key === prevKey) continue;
    prevKey = key;
    msgsDedup.push(m);
  }
  // —— 窗口化：只渲染最近 _chatShown 条；起点对齐到真实用户消息，避免从工具调用半截开始 ——
  const convId = aiDetailConv?.convId || "";
  if (_chatShownConv !== convId) { _chatShownConv = convId; _chatShown = CHAT_HISTORY_WINDOW; }
  if (!_chatShown) _chatShown = CHAT_HISTORY_WINDOW;
  let startIdx = Math.max(0, msgsDedup.length - _chatShown);
  if (startIdx > 0) {
    let cut = startIdx;
    while (cut < msgsDedup.length && !(msgsDedup[cut].role === "user" && !msgsDedup[cut]._kind && !msgsDedup[cut]._sys)) cut++;
    if (cut < msgsDedup.length) startIdx = cut;
  }
  const visible = msgsDedup.slice(startIdx);
  const hidden = startIdx;
  if (hidden > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "mini-btn chat-load-earlier";
    more.textContent = "↑ 加载更早的 " + hidden + " 条";
    more.addEventListener("click", () => {
      // 执行中禁止重渲染：aiDetailConv 此时不含本轮流式消息，重渲染会把实时内容清掉
      if (chatUI.busy) { toast("AI 执行中：结束后再加载更早消息"); return; }
      const b = $("ai-chat-msgs");
      const h = b.scrollHeight, top = b.scrollTop;
      _chatShown += CHAT_HISTORY_WINDOW;
      renderChatHistory();
      b.scrollTop = b.scrollHeight - h + top; // 保持视口不跳（renderChatHistory 末尾会归底）
    });
    box.appendChild(more);
  }
  const flowForTool = (name, args) => {
    const argPreview = (() => { try { const a = JSON.parse(args || "{}"); return Object.entries(a).map(([k, v]) => k + "=" + String(v).substring(0, 40)).join(" ").substring(0, 140); } catch (e) { return String(args || "").substring(0, 140); } })();
    return "🔧 调用 <b>" + escapeHtml(name || "工具") + "</b>" + (argPreview ? "：<span class='cf-tag'>" + escapeHtml(argPreview) + "</span>" : "");
  };
  // 工具结果行：与实时 tool_done 同款——短文本内联，长文本折叠展开
  const flowForResult = (m) => {
    const s = textOf(m);
    const flat = s.replace(/\s+/g, " ").trim();
    if (!flat) return "📥 工具结果（空）";
    const short = flat.substring(0, 200);
    return "📥 工具结果" + (flat.length > 200
      ? "：" + escapeHtml(short) + "…<details class='flow-details'><summary>完整结果（" + s.length + " 字符）</summary><pre>" + escapeHtml(s) + "</pre></details>"
      : "：" + escapeHtml(short));
  };
  const histToolPending = []; // 历史工具卡配对队列
  for (const m of visible) {
    // 思考回放标记（纯思考轮）
    if (m._kind === "thinking" && m.role === "user") {
      const t2 = textOf(m);
      if (t2 && t2.trim()) replayRow("think", "思考", t2);
      continue;
    }
    // 专家回放标记
    if (m._kind === "expert" && m.role === "user") {
      try {
        const o = JSON.parse(textOf(m) || "{}");
        const body = [];
        if (o.reasoning && String(o.reasoning).trim()) body.push(String(o.reasoning));
        if (o.verified) body.push("✅ 结论已由本回合工具实测验证");
        if (Array.isArray(o.toolTrail) && o.toolTrail.length) body.push("【查证步骤】" + o.toolTrail.map((t, i) => (i + 1) + ". " + String(t.tool || "") + (t.args ? "（" + String(t.args).substring(0, 80) + "）" : "") + (t.ok === false ? " ✗" : "")).join("\n"));
        if (o.findings) body.push("【结论】" + String(o.findings));
        if (o.nextAction) body.push("【建议】" + String(o.nextAction));
        const tName = o.expert === "复核审计员" ? "复核审计员" : ("专家 · " + String(o.expert || "专家"));
        replayRow("expert", tName, body.join("\n\n"));
      } catch (e) { const t3 = textOf(m); if (t3) replayRow("expert", "专家", t3); }
      continue;
    }
    // 对抗性审查回放：问题+回应整对一张卡（与实时同构，刷新/重开仍可见）
    if (m._kind === "review" && m.role === "user") {
      try {
        const o = JSON.parse(textOf(m) || "{}");
        const body = [];
        if (o.reason) body.push("【审查触发】" + String(o.reason));
        if (o.question) body.push("【审查问题】" + String(o.question));
        if (o.reply && String(o.reply).trim()) body.push("【主代理回应】" + String(o.reply));
        else body.push("【主代理回应】（未收到模型回应）");
        const roundTxt = o.round != null ? "（第 " + o.round + " 轮）" : "";
        const qsum = String(o.question || "").replace(/\s+/g, " ").substring(0, 90);
        replayRow("review", "⚠ 对抗性审查" + roundTxt, body.join("\n\n"), qsum);
      } catch (e) { const t4 = textOf(m); if (t4) replayRow("review", "⚠ 对抗性审查", t4); }
      continue;
    }
    // 审查回应已并入 review 卡（实时与回放均不重复当正文段落）
    if (m.role === "assistant" && m._kind === "review_reply") continue;
    if (m.role === "user") {
      const txt = textOf(m);
      if (!txt.trim()) continue;
      chatAppendMsg("user", escapeHtml(txt), "pre");
    } else if (m.role === "assistant") {
      const txt = textOf(m);
      const rz = (typeof m.reasoning_content === "string" && m.reasoning_content.trim()) ? m.reasoning_content : null;
      if (rz) replayRow("think", "思考", rz);
      const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length;
      // 工具轮 assistant 的说明正文与实时流一致：先渲染为正文段，再渲染工具卡。
      // （此前被跳过 → 开关扩展/重开面板后正文消失、只剩工具执行结果）
      if (txt && txt.trim()) chatAppendMsg("assistant", mdRender(txt), "");
      // 工具调用 → 独立卡片（默认折叠），后续 tool 消息按顺序填入结果
      if (hasTools) for (const tc of m.tool_calls) {
        const f = tc.function || tc || {};
        const argBrief = (() => { try { const a = JSON.parse(f.arguments || "{}"); return Object.entries(a).map(([k, v]) => k + "=" + String(v).substring(0, 40)).join(" ").substring(0, 120); } catch (e) { return String(f.arguments || "").substring(0, 120); } })();
        histToolPending.push({ name: f.name || tc.name, args: argBrief, card: null, done: false });
      }
    } else if (m.role === "tool") {
      const pend = histToolPending.find(p => !p.done);
      if (pend) {
        pend.done = true;
        if (!pend.card) pend.card = chatToolStart(pend.name, pend.args);
        chatToolFill(textOf(m), !/^\{?"?error|失败|拒绝|超时/i.test(textOf(m).trim()), pend.card);
      } else {
        chatFlowLine("ok", flowForResult(m));
      }
    }
    // 其他 role 忽略（system/内部注入已在过滤器剔除）
  }
  // 截图引用（方案 001 / P5）：历史会话按 refs 渲染，图片本体在 shot:<convId>:<key>
  const shotRefs = Array.isArray(aiDetailConv && aiDetailConv.shots) ? aiDetailConv.shots : [];
  for (const s of shotRefs) if (s && s.key) chatShotRef(s.key, aiDetailConv.convId, s.size);
  pnRebuildFromDom(); // 按当前消息流重建右侧 Prompt 导航（历史会话可重建）
  chatScroll();
}

// 发送兜底异常处理：任何同步/异步异常都必须在聊天区可见，绝不静默
async function chatSendGuard() {
  try {
    await chatSend();
  } catch (err) {
    console.error("[F12x] chatSend 异常：", err);
    try { chatUI.busy = false; chatUI.runConvId = null; chatSetBusy(false); } catch (e) {}
    try { chatClearTyping(); } catch (e) {}
    diagLine("诊断：发送处理抛出异常——" + ((err && err.message) || err));
    toast("发送异常：" + ((err && err.message) || err));
  }
}

// 页面 / 脚本 / 项目事实 → AI：先让用户选会话（或新建），再投递
// （不再自动决定会话；旧实现走一次性 ai:chat，回复只进底部状态条）
async function aiSendFromPage(text, titleHint = "页面分析", autoSend = true, projectId = "") {
  const body = String(text || "").trim();
  if (!body) return;
  return pickConversationForAI({ text: body, titleHint, autoSend, projectId });
}

async function pickConversationForAI({ text, titleHint = "页面分析", autoSend = true, projectId = "" }) {
  const r = await api("ai:conversations");
  const all = r.ok ? (r.conversations || []) : [];
  const curPid = (app.currentProject && app.currentProject.id) || "";
  const list = projectId
    ? all.filter((c) => (c.projectId || null) === projectId)
    : (curPid ? all.filter((c) => !c.projectId || c.projectId === curPid) : all);
  const pid = projectId || "";
  const bindId = projectId || curPid || "";
  const pname = pid ? ((app.projects.find((x) => x.id === pid) || {}).name || "所选项目") : "";
  const opts = list.map((c) => `<option value="${esc(c.convId)}">${esc(c.title || "未命名")} · ${c.msgCount || 0} 条</option>`).join("");
  openModal(`<h3>送到哪个会话？</h3>
    <div class="ai-pick-hint">${pid ? "该项目下" + list.length + " 个会话；也可新建（会绑定该项目）" : "选已有会话，或新建一条会话"}</div>
    <select id="ap-conv">
      <option value="__new__">${pid ? "＋ 新建会话（绑定：" + esc(pname) + "）" : "＋ 新建会话"}</option>
      ${opts}
    </select>
    <input id="ap-title" class="text-input hidden" placeholder="新会话标题（可选）" value="${esc(titleHint)}" />
    <label class="mini-inline"><input type="checkbox" id="ap-send" ${autoSend ? "checked" : ""}/> 立即发送（不勾则只填入输入框）</label>
    <div class="modal-actions"><button id="ap-cancel">取消</button><button id="ap-ok" class="primary">确定</button></div>`);
  const sel = $("ap-conv");
  const titleEl = $("ap-title");
  const sync = () => { if (titleEl) titleEl.classList.toggle("hidden", sel.value !== "__new__"); };
  sel.addEventListener("change", sync);
  sync();
  $("ap-cancel").addEventListener("click", closeModal);
  $("ap-ok").addEventListener("click", async () => {
    const send = !!($("ap-send") && $("ap-send").checked);
    const val = sel.value;
    const title = ((titleEl && titleEl.value) || "").trim() || titleHint;
    closeModal();
    if (val === "__new__") {
      const cr = await api("ai:conversation_create", { projectId: bindId || null, title: title.substring(0, 40) });
      if (!cr.ok) return toast("新建会话失败：" + (cr.error || ""));
      await deliverToConversation({ convId: cr.conv.convId, title: cr.conv.title, projectId: bindId || null, msgCount: 0, updatedAt: Date.now(), type: "task" }, text, send);
    } else {
      const c = list.find((x) => x.convId === val);
      if (!c) return toast("会话不存在");
      await deliverToConversation(c, text, send);
    }
  });
}

async function deliverToConversation(c, text, autoSend) {
  switchView("ai");
  if (!(chatUI.open && chatUI.convId === c.convId)) {
    await openAIDetail({ convId: c.convId, title: c.title, msgCount: c.msgCount, updatedAt: c.updatedAt, type: c.type, projectId: c.projectId });
  }
  const input = $("ai-input");
  if (input) { input.value = text; input.focus(); }
  const st = await api("util:get_state");
  if (!(st.ok && st.state && st.state.llmConfigured)) {
    toast("未配置模型：内容已填入所选会话输入框");
    return;
  }
  if (autoSend) await chatSend();
  else toast("已填入所选会话输入框");
}

// 发送：进入 busy，等后端实时事件把气泡补齐
async function chatSend() {
  const input = $("ai-input");
  const text = input.value.trim();
  if (!text) return;
  if (!chatUI.open || !chatUI.convId) return toast("请先打开一个会话");
  if (chatUI.busy) {
    // 防静默：busy 时明确提示（正常时发送按钮已禁用，此分支主要为 Enter/重复点击兜底）
    toast("AI 执行中（可点“停止”结束本轮）");
    return;
  }
  const isChatMode = chatUI.mode === "chat";
  input.value = "";
  chatUI.lastAsk = text;
  chatPlanClear(); // 新一轮：先收起旧计划，等本任务的 plan 事件到达后再置顶展示
  chatUI.proc = null; chatUI.ansBlock = null; chatUI.ansEl = null; chatUI.ansBuf = ""; chatUI.typing = null;
  chatUI.reasonBlock = null; chatUI.reasonEl = null; chatUI.reasonBuf = ""; chatUI.reasonBusy = false; clearTimeout(chatUI.reasonTimer);
  chatUI.expertBlock = null; chatUI.expertName = ""; chatUI.expertTag = ""; chatUI.expertBuf = ""; chatUI.expertBusy = false; clearTimeout(chatUI.expertTimer);
  chatUI.reviewBlock = null; chatUI.reviewBuf = ""; chatUI.reviewBusy = false; clearTimeout(chatUI.reviewTimer);
  chatUI.evN = 0; chatUI.evDelta = 0; chatUI.wdogNote = false; chatUI.wdogStart = Date.now(); chatUI.lastContentAt = Date.now(); chatUI.wdogEl = null; chatUI.sentTick++;
  // 用户气泡即时入流（恢复原有逻辑）并登记 Prompt 导航
  const uBubble = chatAppendMsg("user", escapeHtml(text), "pre"); // pre 保留换行
  pnBindConv(); // 绑定当前会话（防上次会话残留记录串入）
  pnRegisterRow((uBubble && uBubble.closest ? uBubble.closest(".dshUserRow") : null) || uBubble, text);
  chatScroll(); // 用户主动发送：显式归底跟随
  chatShowTyping(isChatMode ? "对话中…" : "思考中…");
  chatUI.busy = true; chatUI.waitingResume = false; chatUI.runConvId = chatUI.convId;
  chatSetBusy(true);
  // 看门狗：链路活着但长时间无产出 → 周期刷新“仍在生成中”；完全静默 → 报活并超时解锁（不阻塞下一次发送）
  const tick = chatUI.sentTick;
  clearTimeout(chatUI.wdog);
  const wdLoop = () => {
    if (chatUI.sentTick !== tick || !chatUI.busy) return; // 已被新一轮覆盖/已结束
    const now = Date.now();
    const secs = Math.round((now - chatUI.wdogStart) / 1000);
    const silent = !(chatUI.evN || 0);
    if (silent) {
      // 事件完全静默：每 2s 就地刷新“仍活着”的秒数；超时仍无任何事件 → 判定链路假死并解锁
      if (secs >= 8) wdShow("⏳ 已等待 " + secs + "s，尚未收到任何 AI 输出…（本地慢推理/冷加载属正常，可点“停止”）");
      if (secs >= (isChatMode ? 45 : 90)) {
        chatUI.busy = false; chatUI.runConvId = null; chatSetBusy(false);
        chatClearTyping(); wdHide();
        chatFlowLine("warn", "⚠ " + secs + "s 未收到任何 AI 事件（后台可能未启动/已休眠/链路中断），已解锁输入——可点“停止”清理后重发。");
        return;
      }
      chatUI.wdog = setTimeout(wdLoop, 1000);
      return;
    }
    // 事件流活着（链路未断）：以“最后输出”间隔为准，周期刷新状态行；内容恢复即撤掉
    const idle = Math.round((now - (chatUI.lastContentAt || chatUI.wdogStart)) / 1000);
    if (idle >= 10) wdShow("⏳ 仍在生成中…（已 " + secs + "s · 最后输出 " + idle + "s 前；本地慢推理属正常，可点“停止”）");
    else if (chatUI.wdogEl && chatUI.wdogEl.isConnected) wdHide();
    chatUI.wdog = setTimeout(wdLoop, 1000);
  };
  chatUI.wdog = setTimeout(wdLoop, 4000);
  try {
    const resp = await api("ai:task", { text, convId: chatUI.convId, mode: isChatMode ? "chat" : "task", noThink: !!chatUI.noThink });
    clearTimeout(chatUI.wdog);
    if (chatUI.sentTick !== tick) return; // 已被新一轮发送接管（旧轮 response 迟到）
    if (resp && resp.error === "steering") return; // 被其他指令打断续跑：任务仍在执行，事件流继续
    if (!resp || !resp.ok) {
      // 未走到事件流即失败（如未配置 LLM）→ 直接结束本轮并提示
      // 修复（审读低）：NOT_CONFIGURED 不在稳定码集（后端无生产者）→ 死分支删除；
      // 未配置 LLM 时后端返回 {error:"请先在设置中配置 LLM API Key"}，errMsg 直接呈现
      const msg = "⚠ " + escapeHtml(errMsg(resp || { error: "AI 调用失败" }));
      chatFinishRun('<span style="color:#c62828">' + msg + "</span>");
    } else {
      chatFinishRun();
      // 兜底（必须无条件执行）：事件流若未把最终回复送进聊天区（空块被丢弃/事件未送达/半途被截），
      // 用响应携带的完整回复补齐，保证"最终回复必显示"（chatSealFallback 已做去重，不会重复渲染）
      chatSealFallback(resp && (resp.reply || resp.answer) || "");
    }
  } catch (e) {
    clearTimeout(chatUI.wdog);
    console.error("[F12x] ai:task 调用异常：", e);
    if (chatUI.sentTick !== tick) return;
    chatFinishRun('<span style="color:#c62828">⚠ 请求失败：' + escapeHtml((e && e.message) || e) + "</span>");
  }
}

// 本轮执行结束（幂等）：补全气泡/错误提示并复位 UI
function chatFinishRun(extraText, finalState) {
  if (!chatUI.busy) return;
  chatReasonSeal(); // 结束本轮前：封口仍在流式的思考行（停止扫光 / 空思考不留行）
  chatExpertSeal(null); // 收尾：封口/清理仍在流式的专家块
  chatReviewAbort(); // 收尾：待回应的对抗性审查卡标记"未回应"后封口（内容不静默消失）
  chatUI.busy = false;
  // 修复（审读低）：停止态保留 waitingResume（继续按钮/提示依赖它）——原无条件清空=死写；
  // 正常完成/错误则复位；下一次发送时也会在 chatSend 里复位
  if (finalState !== "⏹ 已停止") chatUI.waitingResume = false;
  chatUI.runConvId = null;
  clearTimeout(chatUI.wdog);
  chatClearTyping();
  wdHide();
  if (chatUI.ansEl) {
    if (chatUI.ansBuf.trim()) chatFinalizeAns(finalState);
    else chatDiscardAns();
  }
  chatSetBusy(false);
  if (extraText) chatFlowLine("ok", extraText);
  // 会话记录可能刚更新（消息数/黑板/审计）→ 静默刷新详情缓存
  chatRefreshRecords();
}

// 执行计划面板（修复：计划不可见）
// 实时：plan 事件驱动 upsert，置顶展示当前计划，随推进更新（✓ 完成/● 进行/○ 待办）
// 历史：打开会话时以 aiDetailConv.plan 快照置顶回显
// ============================================================
function planHtml(plan) {
  if (!Array.isArray(plan) || !plan.length) return "";
  const mark = (s) => s === "done" ? "✓" : s === "doing" ? "●" : "○";
  const cls = (s) => s === "done" ? "done" : s === "doing" ? "doing" : "todo";
  return '<div class="plan-steps">' + plan.map(p => {
    const st = (p && p.status) || "todo";
    const crit = (p && p.criterion && String(p.criterion).trim()) ? String(p.criterion).trim().substring(0, 160) : "";
    return '<div class="plan-step ' + cls(st) + '"' + (crit ? ' title="达标标准：' + escapeHtml(crit) + '"' : "") + '><span class="plan-mark">' + mark(st) + '</span><span class="plan-desc">' + escapeHtml((p && p.desc) || '') + '</span>' + (crit && st === "doing" ? '<div class="plan-criterion">达标：' + escapeHtml(crit) + '</div>' : "") + '</div>';
  }).join('') + '</div>';
}

// 执行计划条（实时）：渲染到输入框上方 #ai-plan-bar，不随消息滚动；plan 事件驱动更新。
// 样式与其他输出一致：独立卡片、默认折叠、点击标题行展开
function chatUpsertPlan(plan) {
  const bar = $("ai-plan-bar");
  if (!bar) return;
  if (!Array.isArray(plan) || !plan.length) return; // 空事件不隐藏既有计划（防闪烁/误隐）
  // 无既有卡（新一轮 / 新打开会话）默认展开——执行流程从一开始就可见；之后保留用户开合状态
  const prev = bar.querySelector("details.ai-plan-details");
  const wasOpen = prev ? prev.open : true;
  bar.classList.remove("hidden");
  const doing = plan.find(p => p && p.status === "doing");
  const doneN = plan.filter(p => p && p.status === "done").length;
  const steps = planHtml(plan);
  const head = '<span class="pl-chev">›</span><span class="pl-title">🗺 执行计划</span>'
    + (doing ? '<span class="pl-cur">当前：' + escapeHtml(String(doing.desc || "").substring(0, 60)) + "</span>" : "")
    + (doneN ? '<span class="pl-done">已完成 ' + doneN + "/" + plan.length + "</span>" : "");
  bar.innerHTML = "<details class='ai-plan-details'" + (wasOpen ? " open" : "") + "><summary>" + head + "</summary>" + steps + "</details>";
}
function chatPlanClear() {
  const bar = $("ai-plan-bar");
  if (bar) { bar.classList.add("hidden"); bar.innerHTML = ""; }
}

async function chatRefreshRecords() {
  if (!chatUI.open || !chatUI.convId) return;
  const r = await api("ai:conversation_detail", { convId: chatUI.convId });
  if (!r.ok || !r.conversation) return;
  aiDetailConv = r.conversation;
  const c = r.conversation;
  $("ai-detail-meta").textContent = `${c.type === "task" ? "任务" : "聊天"} · 消息 ${(c.messages || []).length} · ${new Date(c.updatedAt || 0).toLocaleString()}`;
  renderConvFindings();
  renderConvAudit();
  renderConvTrajectory();
}

// 实时状态 → 追加到当前聊天（仅渲染"本会话发起的那一轮"）
// F12x 诊断计数器：统计本面板收到的状态事件，用于定位"最终回复不可见"
function diagLine(msg) {
  try {
    chatFlowLine("warn", "🧾 " + escapeHtml(String(msg || "")));
  } catch (e) {}
}
function chatOnStatus(st) {
  chatUI.evN = (chatUI.evN || 0) + 1;
  if (st && st.type === "answer_delta") chatUI.evDelta = (chatUI.evDelta || 0) + 1;
  // 内容活跃事件 → 刷新“最后产出”时刻（看门狗据此计算静默秒数并周期报活）
  if (st && typeof st === "object") {
    const tt = st.type || (typeof st.status === "string" ? st.status : "");
    if (["reasoning_start", "reasoning_delta", "reasoning_end", "answer_delta", "thinking_text", "stream_progress",
         "tool_start", "tool_done", "expert_start", "expert_step", "expert_reasoning", "rebuttal", "review_reply",
         "plan", "plan_cleared", "ai:compaction", "running", "thinking", "shot_captured", "ai:tool_timeout", "ai:repeat_tool_notice"].includes(tt)) {
      chatUI.lastContentAt = Date.now();
    }
  }
  // 会话增量回执：即使详情未打开（列表态）也要处理，所以放在 open 早退之前
  if (st && st.type === "conversation:changed") { chatOnConversationChanged(st.convId); return; }
  if (!chatUI.open || !chatUI.convId || !st || typeof st !== "object") return;
  const t = st.type || (typeof st.status === "string" ? st.status : "");
  if (t === "audit") return; // 审计已有专门 tab，聊天里不重复刷
  const bound = chatUI.busy && chatUI.runConvId === chatUI.convId;
  const trunc = (s, n) => { const s2 = String(s || "").replace(/\s+/g, " ").trim(); return s2.length > (n || 150) ? s2.substring(0, (n || 150)) + "…" : s2; };
  const evConv = st.convId; // 事件归属会话（bg pushStatus 附加）——修复（审读高）跨会话误结束
  // 结束信号（仅本会话/无归属的全局事件才复位当前 UI）
  if (t === "stream_end") {
    if (evConv && chatUI.runConvId && evConv !== chatUI.runConvId) return;
    chatReasonSeal(); if (chatUI.busy && chatUI.ansEl && chatUI.ansBuf.trim()) chatFinalizeAns(); return;
  }
  if (t === "done" || t === "stopped") {
    if (!chatUI.busy) return;
    // 归属校验：带 convId 的事件必须属于当前运行会话（防 A 会话任务的终态误结束 B）
    if (evConv && evConv !== chatUI.runConvId) return;
    const stopped = t === "stopped";
    const msg = stopped ? (st.text ? "⏹ " + trunc(st.text, 120) : "⏹ AI 已停止/接管") : null;
    chatUI.waitingResume = stopped;
    chatFinishRun(msg || (st.text && st.text !== "完成" ? "✓ " + trunc(st.text, 200) : null), stopped ? "⏹ 已停止" : null);
    return;
  }
  if (t === "error" || t === "ai:error") {
    if (!chatUI.busy) return;
    if (evConv && evConv !== chatUI.runConvId) return;
    // 错误不清空已流出的部分内容（chatFinishRun 对空块才丢弃）
    chatFinishRun('<span style="color:#c62828">⚠ ' + escapeHtml(errMsg(st)) + "</span>", "⚠ 出错");
    return;
  }
  if (!bound) return;
  // —— 进行中的过程事件 ——
  if (t === "agent_mode") { chatFlowLine("", "ℹ️ " + escapeHtml(String(st.text || ""))); return; }
  if (t === "task_start") { chatShowTyping("任务启动，准备中…"); return; }
  if (t === "round") return; // 轮次信息跟随 thinking 行，不必重复
  if (t === "thinking_text") { chatShowTyping(trunc(st.text, 80)); return; }
  // 流式实时进度：告诉用户此刻在"生成正文/构造工具参数/思考"（禁思考时也可见，不再像卡死）
  if (t === "stream_progress") {
    const rn = (st.round || 0) + 1;
    let d = "第 " + rn + " 轮";
    if (st.toolName) d += "：构造工具 " + st.toolName + "（参数 " + (st.argLen || 0) + " 字）";
    else if (st.contentChars > 0) d += "：正在生成正文（" + st.contentChars + " 字）";
    else if (st.reasoningChars > 0) d += "：思考中（" + st.reasoningChars + " 字）";
    else d += "：等待模型输出…";
    chatShowTyping(d);
    return;
  }
  if (t === "reasoning_start") { chatReasonStart(); return; }
  if (t === "reasoning_delta") { chatReasonAppend(st.text || ""); return; }
  if (t === "reasoning_end") { chatReasonSeal(); return; }
  if (t === "plan") { chatUpsertPlan(st.plan); if (Array.isArray(st.plan) && st.plan.length) chatShowTyping("执行计划中…"); return; }
  if (t === "plan_cleared") { chatPlanClear(); return; } // 主代理显式降级"无需多步流程"：收起旧流程卡
  if (t === "workspace") { chatWorkspaceNote(st.entry); return; } // 研讨条目实时可见（原先事件被丢弃）
  if (t === "answer_delta") { chatAppendAns(st.text || ""); return; }
  if (t === "tool_start") {
    // 工具执行 → 独立卡片（默认折叠，标题行实时预览参数）
    const name = st.tool || "";
    const args = (() => { try { const a = JSON.parse(st.args || "{}"); return Object.entries(a).map(([k, v]) => `${k}=${String(v).substring(0, 50)}`).join(" ").substring(0, 140); } catch (e) { return ""; } })();
    chatToolStart(name, args);
    return;
  }
  if (t === "tool_done") {
    // 工具完成/失败 → 填入卡片（状态 + 结果预览；点开看详情）
    const failed = !!(st.error || (st.result && /错误|失败|拒绝|超时|exception/i.test(String(st.result))));
    chatToolFill(st.result || st.text || st.error || "", !failed);
    return;
  }
  if (t === "expert_start") { chatExpertStart(String(st.expert || ""), String(st.tool || "")); return; }
  if (t === "expert_step") { chatExpertStepMark(st.step, st.tool, st.args); return; } // E1：专家回合步骤实时呈现
  if (t === "expert_tool_done") { chatExpertStepDone(st.step, st.tool, st.ok); return; } // 每步查证结果（原无分支被静默丢弃）
  if (t === "expert_reasoning") { chatExpertAppend(String(st.delta || "")); return; } // 修复：专家思考实时可见（原事件无分支被丢弃）
  if (t === "expert_done") {
    chatExpertSeal(st); // 结论/verified/轨迹已并入专家卡正文（不再输出重复小字行）
    return;
  }
  if (t === "rebuttal") { chatReviewStart(st); return; } // 对抗性审查内容可见：问题/依据/要求全文入卡（默认展开）
  if (t === "review_reply") { chatReviewReply(st.text || ""); return; } // 主代理回应并入同一张审查卡
  if (t === "ai:approval_requested") { wdHide(); chatFlowLine("warn", "⏸ 等待批准：<b>" + escapeHtml(String((st.approval && (st.approval.tool || st.approval.toolName)) || "AI 操作")) + "</b> — 在批准弹层中处理"); return; }
  if (t === "ai:compaction") { chatFlowLine("", "🧩 上下文压缩中（" + (st.trigger === "overflow" ? "溢出触发" : "预算压力 @ " + (st.at || "") + " tokens") + "）"); return; }
  if (t === "ai:compaction_done") {
    // 压缩落地回执（原无分支被静默丢弃）：丢多少轮 / 多少 token → 摘要多少 token
    const bits = [];
    if (st.droppedRounds) bits.push("丢 " + st.droppedRounds + " 轮");
    if (st.droppedTokens) bits.push(st.droppedTokens + "t");
    if (st.summaryTokens) bits.push("摘要 " + st.summaryTokens + "t");
    const kept = st.compactionId ? "（" + escapeHtml(String(st.compactionId)) + "）" : "";
    chatFlowLine("ok", "🗜 上下文已压缩" + (bits.length ? "：" + bits.join(" → ") : "") + kept);
    return;
  }
  if (t === "ai:tool_timeout") { chatFlowLine("warn", "⏱ 工具 " + escapeHtml(String(st.tool || "")) + " 超时"); return; }
  if (t === "ai:repeat_tool_notice") { chatFlowLine("warn", "⚠ 已连续 " + (st.count || 3) + " 次重复调用 " + escapeHtml(String(st.tool || "")) + "（已提醒模型）"); return; }
  if (t === "shot_captured") {
    chatShotRef(st.key, st.convId, st.size);
    return;
  }
  if (t === "running" || t === "thinking") {
    const txt = trunc(st.text || "", 80);
    if (txt) chatShowTyping(txt); else chatShowTyping("AI 执行中…");
    return;
  }
}


// ============================================================
function initSettings() {
  $("settings-toggle").addEventListener("click", openSettings);
  $("settings-cancel").addEventListener("click", () => $("settings-panel").classList.add("hidden"));
  $("settings-save").addEventListener("click", saveSettings);
  $("settings-panel").addEventListener("click", (e) => {
    if (e.target === $("settings-panel")) $("settings-panel").classList.add("hidden");
  });
  // 悬浮球功能已移除：AI 全部迁入 AI 页签聊天工作台
  // 模型：添加按钮（缓存必先经 openSettings/modelsLoad 载入，否则视为空列表起加）
  const addBtn = $("settings-model-add");
  if (addBtn) addBtn.addEventListener("click", () => {
    modelsCache.push({ id: modelGid(), name: "", apiKey: "", baseUrl: "", model: "" });
    settingsModelsRender();
    const first = $("settings-models")?.querySelector(".smr-name");
    if (first) first.focus();
    const curDef = modelFind(modelActiveId);
    toast("已添加模型；当前默认仍是 " + (curDef ? (modelName(curDef) || "旧配置") : "—") + "，如需切换请点该行行首「默认」，或在聊天框模型下拉里选择");
  });
}

async function openSettings() {
  // 设置一律走后台（后台是唯一读写方）：settings:get 返回白名单键 + 模型列表 + activeId
  const r = await api("settings:get");
  const cfg = (r && r.ok && r.settings) ? r.settings : {};
  if (r && r.ok) {
    modelsCache = Array.isArray(r.models) ? r.models : [];
    modelActiveId = r.activeId || "";
  } else {
    await modelsLoad();
  }
  // 旧版单配置迁移：仅有 llmConfig 而无模型列表 → 生成一条“默认”，避免升级后配置丢失
  const c = cfg.llmConfig || {};
  if (!modelsCache.length && (c.baseUrl || c.model || c.apiKey)) {
    modelsCache = [{ id: modelGid(), name: "默认", apiKey: c.apiKey || "", baseUrl: c.baseUrl || "", model: c.model || "" }];
  }
  if (!modelsCache.some(m => m.id === modelActiveId)) modelActiveId = modelsCache[0]?.id || "";
  $("settings-thinklimit").value = Number(cfg.f12x_thinking_limit) > 0 ? Number(cfg.f12x_thinking_limit) : "";
  // 修复（审读中）：LLM 端点列表框回填（原 open 不读取——用户上次保存的列表永不显示）
  $("settings-llm").value = (Array.isArray(cfg.llm_endpoints) && cfg.llm_endpoints.length ? cfg.llm_endpoints : ["https://api.deepseek.com", "https://api.openai.com", "https://api.anthropic.com", "http://localhost:11434"]).join("\n");
  $("settings-approval").value = cfg.approvalLevel || "read_auto_write_approve";
  $("settings-guard").value = ["auto", "lite", "full"].includes(cfg.f12x_guard_profile) ? cfg.f12x_guard_profile : "auto";
  $("settings-localwarm").checked = cfg.f12x_local_warm !== false;
  settingsModelsRender();
  $("settings-panel").classList.remove("hidden");
}

async function saveSettings() {
  // 模型：先做轻校验再持久化（用户即批准人——保存即生效）
  const trimmed = modelsCache.map(m => ({
    id: m.id, name: String(m.name || "").trim(),
    apiKey: String(m.apiKey || "").trim(), baseUrl: String(m.baseUrl || "").trim(), model: String(m.model || "").trim()
  }));
  if (!trimmed.some(m => m.id === modelActiveId)) modelActiveId = trimmed.length ? trimmed[0].id : "";
  const active = trimmed.find(m => m.id === modelActiveId) || null;
  // 本地回环服务（localhost/127.0.0.1）不校验 Key：可留空，保存时自动填占位以满足引擎非空守卫
  const loopback = (u) => { const h = String(u || "").replace(/^[a-z]+:\/\//i, "").split("/")[0].split(":")[0].toLowerCase(); return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "0.0.0.0"; };
  if (active && !active.apiKey) {
    if (active.baseUrl && loopback(active.baseUrl)) active.apiKey = "local"; // 占位，实际本地服务忽略
    else return toast("API Key 不能为空（本地回环服务可留空）");
  }
  if (active && (!active.baseUrl || !active.model)) return toast("默认模型需填写 Base URL 与模型名");
  modelsCache = trimmed;
  const cfg = { approvalLevel: $("settings-approval").value, f12x_guard_profile: ["auto", "lite", "full"].includes($("settings-guard").value) ? $("settings-guard").value : "auto", f12x_local_warm: !!$("settings-localwarm").checked };
  cfg.llm_endpoints = $("settings-llm").value.split("\n").map(s => s.trim()).filter(Boolean);
  const tl = parseInt($("settings-thinklimit").value, 10);
  cfg.f12x_thinking_limit = Number.isFinite(tl) && tl > 0 ? tl : 0;
  // 运行引擎读取的仍是 llmConfig：用“默认模型”同步（会话覆盖在运行前单独解析）
  cfg.llmConfig = active ? { apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model } : { apiKey: "", baseUrl: "", model: "" };
  // 统一交给后台落库（模型 CRUD + 设置键的唯一入口）；面板不再直接写这些键
  const saved = await api("settings:save", {
    settings: {
      approvalLevel: cfg.approvalLevel,
      f12x_guard_profile: cfg.f12x_guard_profile,
      f12x_local_warm: cfg.f12x_local_warm,
      f12x_thinking_limit: cfg.f12x_thinking_limit,
      llm_endpoints: cfg.llm_endpoints,
      llmConfig: cfg.llmConfig
    },
    models: modelsCache,
    activeId: active ? active.id : ""
  });
  if (!saved || !saved.ok) return toast("保存失败：" + ((saved && saved.error) || "后台无响应"));
  $("settings-panel").classList.add("hidden");
  const who = active ? (modelName(active) || active.model || active.baseUrl) : "（无）";
  toast(active ? ("设置已保存｜默认模型：" + who) : "设置已保存（未配置任何模型）");
  await refreshState();
  await chatModelRefresh();
}

// ============================================================
// ===== 多模型：设置列表 + 聊天切换（同一份缓存） =====
// ============================================================
let modelsCache = [];
let modelActiveId = "";
function modelGid() { return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function modelsLoad() {
  // 模型列表由后台（models.js）统一持有；面板只缓存用于渲染
  return api("model:list").then((r) => {
    modelsCache = (r && r.ok && Array.isArray(r.models)) ? r.models : [];
    modelActiveId = (r && r.ok && r.activeId) || "";
    if (modelActiveId && !modelsCache.some(m => m.id === modelActiveId)) modelActiveId = "";
  }).catch(() => { modelsCache = []; modelActiveId = ""; });
}
function modelName(m) { if (!m) return ""; return (String(m.name || "").trim() || String(m.model || "").trim() || "未命名"); }
function modelFind(id) { return modelsCache.find(m => m.id === id) || null; }

function settingsModelsRender() {
  const wrap = $("settings-models");
  if (!wrap) return;
  if (!modelsCache.length) modelsCache.push({ id: modelGid(), name: "默认", apiKey: "", baseUrl: "", model: "" });
  if (!modelsCache.some(m => m.id === modelActiveId)) modelActiveId = modelsCache[0].id;
  wrap.innerHTML = modelsCache.map((m, idx) => `
    <div class="settings-model-row">
      <div class="settings-model-top">
        <label class="smr-def ${m.id === modelActiveId ? "active" : ""}" title="设为默认（新会话跟随；本设置页内即改即生效）"><input type="radio" name="smr-default" value="${esc(m.id)}" ${m.id === modelActiveId ? "checked" : ""} />默认</label>
        <input class="text-input smr-name" type="text" placeholder="名称（如 DeepSeek / 本地 Qwen）" value="${esc(m.name || "")}" data-idx="${idx}" data-f="name" />
        <button type="button" class="mini-btn danger" data-del="${idx}" title="删除该模型">删除</button>
      </div>
      <div class="settings-model-fields">
        <input class="text-input" type="text" placeholder="Base URL（如 http://127.0.0.1:11434）" value="${esc(m.baseUrl || "")}" data-idx="${idx}" data-f="baseUrl" />
        <input class="text-input" type="password" placeholder="API Key（本地回环可留空）" value="${esc(m.apiKey || "")}" data-idx="${idx}" data-f="apiKey" />
        <input class="text-input smr-model" type="text" placeholder="模型名（如 qwen2.5:7b / deepseek-chat）" value="${esc(m.model || "")}" data-idx="${idx}" data-f="model" />
      </div>
    </div>`).join("");
  wrap.querySelectorAll("input").forEach((inp) => {
    if (inp.type === "radio") {
      inp.addEventListener("change", () => { if (inp.checked) { modelActiveId = inp.value; settingsModelsRender(); } });
    } else {
      inp.addEventListener("input", () => { const m = modelsCache[+inp.dataset.idx]; if (m) m[inp.dataset.f] = inp.value; });
    }
  });
  wrap.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    modelsCache.splice(+b.dataset.del, 1);
    if (modelsCache.length && !modelsCache.some(m => m.id === modelActiveId)) modelActiveId = modelsCache[0].id;
    settingsModelsRender();
  }));
}

// 聊天输入框上方的模型选择器（值 = 模型 id；空 = 默认模型）
async function chatModelRefresh() {
  await modelsLoad();
  const sel = $("ai-model-sel");
  if (!sel) return;
  const cur = aiDetailConv?.modelId || "";
  if (!modelsCache.length) {
    // 兼容旧版：仅 llmConfig、尚无模型列表时，显示为“当前配置”（不可切换；去设置保存一次即迁移为列表）
    const legacy = await new Promise((res) => chrome.storage.local.get("llmConfig", (r) => res(r.llmConfig || null)));
    if (legacy && (legacy.baseUrl || legacy.model)) {
      const host = String(legacy.baseUrl || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      sel.innerHTML = '<option value="">' + esc(String(legacy.model || "模型") + (host ? " · " + host : "") + "（旧版单配置）") + '</option>';
    } else {
      sel.innerHTML = '<option value="">未配置模型</option>';
    }
  } else {
    const def = modelsCache.find(m => m.id === modelActiveId) || null;
    const others = modelsCache.filter(m => !def || m.id !== def.id);
    const defLabel = def ? ("默认 · " + modelName(def)) : "默认模型";
    const parts = [`<option value="">${esc(defLabel)}</option>`];
    for (const m of others) {
      parts.push(`<option value="${esc(m.id)}" ${m.id === cur ? "selected" : ""}>${esc(modelName(m))}</option>`);
    }
    sel.innerHTML = parts.join("");
  }
  sel.disabled = !!chatUI.busy || !chatUI.open;
  sel.title = !modelsCache.length ? "设置中尚未添加模型" : "本会话使用的模型：切换只对本会话生效";
}
async function chatModelChanged() {
  const sel = $("ai-model-sel");
  if (!sel || !chatUI.open || !chatUI.convId) return;
  if (chatUI.busy) { toast("AI 执行中，结束本轮后再切换"); await chatModelRefresh(); return; }
  const modelId = sel.value || null;
  const prev = (aiDetailConv && aiDetailConv.modelId) || null;
  if ((prev || "") === (modelId || "")) return; // 选择未变化（含“默认模型”本就未记忆）
  if (aiDetailConv) aiDetailConv.modelId = modelId;
  const r = await api("ai:conversation_set_model", { convId: chatUI.convId, modelId });
  if (!r.ok) { if (aiDetailConv) aiDetailConv.modelId = prev; toast("切换失败：" + (r.error || "")); await chatModelRefresh(); return; }
  const m = modelFind(modelId || "");
  toast(modelId ? "本会话模型 → " + (m ? modelName(m) : String(modelId)) : "本会话模型 → 默认（跟随设置）");
}
// 本地空闲保活定时器：40s 一次 1-token 请求（设置默认开；页面隐藏或任务运行中跳过）
function initLocalWarm() {
  setInterval(() => {
    if (document.hidden || chatUI.busy) return;
    chrome.storage.local.get("f12x_local_warm", (r) => {
      if (r.f12x_local_warm !== false) { try { api("ai:warm"); } catch (e) {} }
    });
  }, 40000);
}
function initChatModelSwitch() {
  const sel = $("ai-model-sel");
  if (!sel) return;
  sel.addEventListener("change", chatModelChanged);
}

// ============================================================
// ===== AI 状态条 + stream 事件处理 =====
// ============================================================
function handleStatus(st) {
  if (!st) return;
  chatOnStatus(st); // 聊天工作台实时流（仅当打开会话且属本会话发起的一轮才追加）
  const bar = $("ai-bar");
  const text = $("ai-status-text");
  const stopBtn = $("ai-stop-btn");
  const takeoverBtn = $("ai-takeover-btn");
  const resumeBtn = $("ai-resume-btn");
  // 审计事件（方案 3.2⑤：AI 动作实时留痕，状态条可展开查看）
  if (st.type === "audit" && st.entry) {
    app.audit.push(st.entry);
    if (app.audit.length > 100) app.audit.shift();
    if (!$("ai-audit").classList.contains("hidden")) renderAudit();
    return;
  }
  // 批准请求（方案 5.1 / 14.3）：状态条待批准 + 弹批准条（批量列表：全部批准/逐个审/拒绝）
  if (st.type === "ai:approval_requested") {
    app.aiRunning = true;
    bar.classList.add("running");
    stopBtn.classList.remove("hidden");
    takeoverBtn.classList.remove("hidden");
    resumeBtn.classList.add("hidden");
    const calls = st.approval?.calls || [];
    text.textContent = `待批准：${st.approval?.tool || ""}${calls.length > 1 ? `（${calls.length} 个调用已合并）` : ""}`;
    showApprovalModal(st.approval);
    return;
  }
  // agent 引擎流式状态（方案 3.2/4.1：任务进行中实时反馈）
  if (st.type === "task_start") {
    app.aiRunning = true;
    bar.classList.add("running");
    stopBtn.classList.remove("hidden");
    takeoverBtn.classList.remove("hidden");
    resumeBtn.classList.add("hidden");
    text.textContent = "任务开始：" + ((st.text || "").substring(0, 40)) + "…";
    return;
  }
  if (st.type === "thinking_text") { text.textContent = st.text || "AI 思考中…"; return; }
  if (st.type === "plan") { text.textContent = "计划更新：" + ((st.plan || []).length) + " 步"; return; }
  if (st.type === "answer_delta") { text.textContent = "AI：" + ((st.text || "").substring(0, 80)); return; }
  if (st.type === "stream_end") { /* 无状态条动作 */ return; }
  // §十一：新增 stream 事件（压缩进度 / 工具超时 / 重复工具提醒）
  if (st.type === "ai:compaction") { text.textContent = `上下文压缩中（${st.trigger === "overflow" ? "上下文溢出触发" : "预算压力触发 @ " + (st.at || "") + " tokens"}）…`; return; }
  if (st.type === "ai:tool_timeout") { text.textContent = `工具 ${st.tool || ""} 超时（${Math.round((st.timeoutMs || 0) / 1000)}s）`; return; }
  if (st.type === "ai:repeat_tool_notice") { text.textContent = `⚠ 已连续 ${st.count || 3} 次重复调用 ${st.tool || ""}（已提醒模型）`; return; }
  if (st.status === "running" || st.status === "thinking" || st.status === "tool") {
    app.aiRunning = true;
    bar.classList.add("running");
    stopBtn.classList.remove("hidden");
    takeoverBtn.classList.remove("hidden");
    resumeBtn.classList.add("hidden");
    text.textContent = st.text || "AI 执行中…";
  } else if (st.status === "answer_delta") {
    text.textContent = st.text;
  } else if (st.status === "done") {
    app.aiRunning = false;
    bar.classList.remove("running");
    stopBtn.classList.add("hidden");
    takeoverBtn.classList.add("hidden");
    resumeBtn.classList.add("hidden");
    text.textContent = st.text ? "AI：" + st.text : "AI 空闲";
  } else if (st.status === "stopped") {
    app.aiRunning = false;
    bar.classList.remove("running");
    stopBtn.classList.add("hidden");
    takeoverBtn.classList.add("hidden");
    resumeBtn.classList.remove("hidden"); // 暂停/接管后可「继续」
    text.textContent = st.text ? "AI：" + st.text : "AI 已暂停";
  } else if (st.status === "error") {
    app.aiRunning = false;
    bar.classList.remove("running");
    stopBtn.classList.add("hidden");
    takeoverBtn.classList.add("hidden");
    resumeBtn.classList.add("hidden");
    text.textContent = "AI 错误：" + (st.text || st.detail || "");
  } else if (st.type === "ai:error") {
    // §十一：ai:error 统一带稳定码
    app.aiRunning = false;
    bar.classList.remove("running");
    stopBtn.classList.add("hidden");
    takeoverBtn.classList.add("hidden");
    resumeBtn.classList.add("hidden");
    text.textContent = `AI 错误 [${st.code || "UNKNOWN"}]：${st.error || ""}`;
  }
}

// 批准条弹层（方案 14.3：同轮同工具批量合并——全部批准 / 逐个审（勾选）/ 拒绝）
function showApprovalModal(approval) {
  if (!approval) return;
  const calls = approval.calls || [];
  const levelLabel = approval.level === "g3" ? "G3 不可逆（必批）" : approval.level === "g2" ? "G2 写操作" : "G1 读操作";
  const box = openModal(`
    <h3>AI 请求批准${approval.recovered ? "（后台重启后恢复）" : ""}</h3>
    <div class="ap-meta"><span class="ap-badge">${esc(levelLabel)}</span> 工具：<b>${esc(approval.tool)}</b>${calls.length > 1 ? `（${calls.length} 个调用已合并）` : ""}</div>
    <div class="ap-list">
      ${calls.map(c => `<label class="ap-item"><input type="checkbox" data-ti="${c.ti}" checked /> <span class="ap-preview">${esc(c.preview)}</span></label>`).join("") || '<div class="placeholder">（无调用明细）</div>'}
    </div>
    <input id="ap-reason" class="ap-reason" placeholder="拒绝原因（可选，将回灌 AI）" />
    <div class="modal-actions">
      <button id="ap-approve" class="primary">全部批准</button>
      <button id="ap-partial">批准勾选项</button>
      <button id="ap-reject" class="danger">拒绝</button>
    </div>`);
  const send = async (decision, approvedCalls, reason) => {
    const r = await api("ai:approval_result", { decision, approvedCalls, reason: reason || "" });
    if (!r.ok) toast(r.error || "批准结果提交失败"); // SW 复活后无未决批准 → 提示任务已中断
  };
  box.querySelector("#ap-approve").addEventListener("click", () => {
    send("approved", calls.map(c => c.ti), "");
    closeModal();
  });
  box.querySelector("#ap-partial").addEventListener("click", () => {
    const sel = [...box.querySelectorAll(".ap-item input:checked")].map(i => Number(i.dataset.ti));
    if (!sel.length) return toast("未勾选任何调用");
    send("approved", sel, "");
    closeModal();
  });
  box.querySelector("#ap-reject").addEventListener("click", () => {
    send("rejected", [], box.querySelector("#ap-reason").value);
    closeModal();
  });
}

// AI 审计日志渲染（方案 4.1：状态条可展开；审计随会话持久化，站点会话列表可回看）
function renderAudit() {
  const box = $("ai-audit");
  if (!app.audit.length) { box.innerHTML = '<div class="placeholder">暂无 AI 动作记录（任务执行时自动留痕）</div>'; return; }
  box.innerHTML = app.audit.slice().reverse().map(a => {
    const t = new Date(a.time).toLocaleTimeString();
    const ap = a.approval === "approved" ? '<span class="au-ap ok">✓批准</span>'
      : a.approval === "rejected" ? '<span class="au-ap no">✗拒绝</span>'
      : a.approval === "auto" ? '<span class="au-ap auto">自动</span>' : "";
    const head = a.tool ? `<b>${esc(a.tool)}</b>` : `<b>${esc(a.action || "")}</b>`;
    const body = esc(String(a.paramsSummary || a.resultSummary || a.target || ""));
    return `<div class="au-item"><span class="au-time">${esc(t)}</span> ${head} ${ap}<div class="au-params">${body}</div></div>`;
  }).join("");
}

// AI 会话列表（AI 数据区：任务/聊天记录 + 审计回看，独立于站点工作区）
async function renderAISessions() {
  const pane = $("ai-convs");
  pane.innerHTML = '<div class="placeholder">加载会话…</div>';
  const r = await api("ai:conversations");
  if (!r.ok) { pane.innerHTML = `<div class="placeholder">加载失败：${esc(r.error)}</div>`; return; }
  const all = (r.conversations || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // 只显示当前项目的会话 + 独立会话；切换项目后列表随之变化（项目本身不在 AI 页出现）
  const curPid = (app.currentProject && app.currentProject.id) || "";
  const convs = curPid ? all.filter((c) => !c.projectId || c.projectId === curPid) : all;
  if (!convs.length) { pane.innerHTML = `<div class="placeholder">${curPid ? "当前项目还没有会话（在下方输入即可新建）" : "暂无会话（AI 任务/聊天结束后自动记录在此）"}</div>`; return; }
  const itemHtml = (c) => `
    <div class="conv-item" data-id="${esc(c.convId)}">
      <div class="ci-head">
        <span class="ci-title">${esc(c.title || "未命名会话")}</span>
        <span class="ci-type ${c.type === "task" ? "task" : ""}">${c.type === "task" ? "任务" : "聊天"}</span>
        <span class="ci-time">${new Date(c.updatedAt || 0).toLocaleString()}</span>
        <span class="ci-ops">
          <button class="mini-btn" data-act="rename" title="重命名会话">重命名</button>
          <button class="mini-btn danger" data-act="del" title="删除会话（含其沉淀的黑板发现）">删除</button>
        </span>
      </div>
      <div class="ci-meta">消息 ${c.msgCount} · 审计 ${c.auditCount ?? (c.audit || []).length}</div>
    </div>`;
  pane.innerHTML = convs.map(itemHtml).join("");
  pane.querySelectorAll(".conv-item").forEach(el => el.addEventListener("click", (ev) => {
    const c = convs.find(x => x.convId === el.dataset.id);
    if (!c) return;
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (act === "rename") { ev.stopPropagation(); renameConversationFlow(c); return; }
    if (act === "del") { ev.stopPropagation(); deleteConversationFlow(c); return; }
    openAIDetail(c);
  }));
}

// 重命名会话（列表项 / 详情头共用）
async function renameConversationFlow(c) {
  openModal(`<h3>重命名会话</h3><label>标题</label><input id="rc-name" value="${esc(c.title || "")}" />
    <div class="modal-actions"><button>取消</button><button id="rc-ok" class="primary">保存</button></div>`);
  const box = document.querySelector(".modal-box");
  box.querySelector(".modal-actions button").addEventListener("click", closeModal);
  box.querySelector("#rc-ok").addEventListener("click", async () => {
    const name = $("rc-name").value.trim();
    if (!name) { toast("标题不能为空"); return; }
    const r = await api("ai:conversation_rename", { convId: c.convId, title: name });
    closeModal();
    if (r.ok) {
      toast("已重命名");
      if (aiDetailConv && aiDetailConv.convId === c.convId) {
        aiDetailConv.title = name;
        $("ai-detail-title").textContent = name;
      }
      renderAISessions();
    } else toast("重命名失败：" + (r.error || ""));
  });
}

// 删除会话（列表项 / 详情头共用）
async function deleteConversationFlow(c) {
  const r = await api("ai:conversation_delete", { convId: c.convId });
  if (r.ok) {
    toast("已删除会话");
    if (aiDetailConv && aiDetailConv.convId === c.convId) closeAIDetail();
    else renderAISessions();
  } else toast("删除失败：" + (r.error || ""));
}

// 新建会话（AI 页只创建独立会话；项目内会话由项目页新建）
async function newConversationFlow() {
  openModal(`<h3>新建会话</h3>
    <label>会话标题（可选，留空自动命名）</label><input id="nc-title" placeholder="例如：目标站点信息收集" />
    <div class="modal-actions"><button>取消</button><button id="nc-ok" class="primary">创建</button></div>`);
  const box = document.querySelector(".modal-box");
  box.querySelector(".modal-actions button").addEventListener("click", closeModal);
  box.querySelector("#nc-ok").addEventListener("click", async () => {
    // AI 页新建的会话归属当前项目（界面不暴露项目，但换项目时列表要正确）
    const pid = (app.currentProject && app.currentProject.id) || null;
    const r = await api("ai:conversation_create", { title: $("nc-title").value.trim() || undefined, projectId: pid });
    closeModal();
    if (r.ok) {
      toast("已创建会话");
      if (r.conv) openAIDetail({ type: "chat", msgCount: 0, updatedAt: Date.now(), ...r.conv });
      else await renderAISessions();
    } else toast("创建失败：" + (r.error || ""));
  });
}

// ===== AI 会话详情（先选会话 → 出现该会话相关的黑板栏/审计/消息） =====
let aiDetailConv = null;

// 详情内「聊天 / 会话记录」两个互斥页签切换（一次只显示一个）
function setAIDetailTab(name) {
  const pageId = name === "records" ? "ai-records" : "ai-chat";
  document.querySelectorAll("#ai-detail .ai-detail-tabs .tab").forEach(x => x.classList.toggle("active", x.dataset.aiTab === name));
  document.querySelectorAll("#ai-detail .ai-page").forEach(p => p.classList.toggle("active", p.id === pageId));
}

async function openAIDetail(c) {
  aiDetailConv = null;
  // 聊天态打开：隐藏列表/工具条，进入该会话的聊天工作台
  chatUI.open = true;
  chatUI.convId = c.convId;
  chatUI.busy = false;
  chatUI.waitingResume = false;
  chatUI.runConvId = null;
  $("ai-list-bar").classList.add("hidden");
  $("ai-list").classList.add("hidden");
  $("ai-detail").classList.remove("hidden");
  $("ai-detail-title").textContent = c.title || "未命名会话";
  $("ai-detail-meta").textContent = `${c.type === "task" ? "任务" : "聊天"} · 消息 ${c.msgCount} · ${new Date(c.updatedAt || 0).toLocaleString()}`;
  // 默认落在「聊天」页签（与会话记录互斥）；记录子页签复位到黑板
  setAIDetailTab("chat");
  chatSetBusy(false); // 复位输入区并刷新模式提示（任务模式/对话模式）
  document.querySelectorAll("#ai-records .tabs .tab").forEach((x, i) => x.classList.toggle("active", i === 0));
  document.querySelectorAll("#ai-records .site-pane").forEach((p, i) => p.classList.toggle("active", i === 0));
  ["findings", "audit", "trajectory"].forEach(k => $("ai-d-" + k).innerHTML = '<div class="placeholder">加载…</div>');
  renderChatHistory(); // 先给空态/加载占位
  const r = await api("ai:conversation_detail", { convId: c.convId });
  if (!r.ok || !r.conversation) {
    $("ai-d-findings").innerHTML = `<div class="placeholder">加载失败：${esc(r.error || "会话不存在")}</div>`;
    toast("会话加载失败：" + (r.error || "会话不存在"));
    closeAIDetail();
    return;
  }
  aiDetailConv = r.conversation;
  const conv = r.conversation;
  await chatModelRefresh(); // 按该会话记忆的模型（无则默认）刷新聊天框模型选择器
  $("ai-detail-meta").textContent = `${conv.type === "task" ? "任务" : "聊天"} · 消息 ${(conv.messages || []).length} · ${new Date(conv.updatedAt || 0).toLocaleString()}`;
  renderConvFindings();
  renderConvAudit();
  renderConvTrajectory();
  renderChatHistory(); // 历史气泡（复用实时渲染路径）
  if (aiPendingRef) { ref_ = aiPendingRef; aiPendingRef = null; aiInjectRefText(); toast("已填入来自请求的引用，可补充后发送"); }
}

function closeAIDetail() {
  // 关闭聊天态：复位 chat 状态，回到会话列表
  chatUI.open = false;
  chatUI.convId = null;
  chatUI.busy = false;
  chatUI.waitingResume = false;
  chatUI.runConvId = null;
  aiDetailConv = null;
  chatSetBusy(false);
  $("ai-chat-msgs").innerHTML = "";
  pnReset(); pnRenderEmpty(); // 关闭会话：Prompt 导航清空，与新会话彻底解绑
  $("ai-detail").classList.add("hidden");
  $("ai-list").classList.remove("hidden");
  $("ai-list-bar").classList.remove("hidden");
  renderAISessions();
}

// 该会话相关黑板（发现：任务中沉淀的线索/结论；绑定项目 → 项目黑板跨会话共享，否则 AI 全局黑板按会话过滤）
async function renderConvFindings() {
  const pane = $("ai-d-findings");
  if (!aiDetailConv) return;
  const scope = "🧠 会话黑板（本会话可见的事实）";
  const pid = aiDetailConv.projectId || null;
  // 读侧精选（黑板优化 A）：拉全类别（endpoint/credential/chain 也可见），按类别分组展示
  const r = await api("ai:findings", { convId: pid ? null : aiDetailConv.convId, projectId: pid, category: "all" });
  if (!r.ok) { pane.innerHTML = `<div class="placeholder">加载失败：${esc(r.error)}</div>`; return; }
  const findings = r.findings || [];
  if (!findings.length) { pane.innerHTML = `<div class="ai-scope-note">${scope}</div><div class="placeholder">该会话黑板为空（任务中的线索/结论会自动沉淀到此）</div>`; return; }
  const CAT_ZH = { credential: "凭据", endpoint: "接口/端点", finding: "发现", chain: "链路", misc: "其它" };
  const CAT_ORDER = ["credential", "endpoint", "finding", "chain"];
  const groups = new Map();
  for (const f of findings) {
    const c = CAT_ORDER.includes(f.category) ? f.category : "misc";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(f);
  }
  const catKeys = [...CAT_ORDER.filter(c => groups.has(c)), ...[...groups.keys()].filter(c => !CAT_ORDER.includes(c))];
  const html = catKeys.map(cat => {
    const list = groups.get(cat);
    return `<div class="fact-group"><div class="fg-head">🔖 ${esc(CAT_ZH[cat] || cat)} · ${list.length} 条</div>` + list.map(f => `
    <div class="fact-item">
      <div class="fi-head">
        <span class="fi-key">${esc(f.summary)}</span>
        <span class="fi-src ai">ai</span>
        <button class="mini-btn" style="margin-left:auto" data-del="${esc(f.key)}">删除</button>
      </div>
      <div class="fi-val md">${mdRender(f.body || "") || '<span style="color:var(--text-4)">（无正文）</span>'}</div>
      <div style="margin-top:4px;font-size:10px;color:var(--text-4)">${new Date(f.createdAt).toLocaleString()} · 置信 ${esc(f.confidence || "medium")}${f.convId ? "" : ' · <span style="color:var(--text-3)">未归属会话（全局沉淀）</span>'}</div>
    </div>`).join("") + "</div>";
  }).join("");
  pane.innerHTML = `<div class="ai-scope-note">${scope} · 共 ${findings.length} 条（全类别）</div>` + html;
  pane.querySelectorAll('[data-del]').forEach(b => b.addEventListener("click", async () => {
    const r2 = await api("ai:findings_remove", { key: b.dataset.del, projectId: pid });
    toast(r2.ok ? "已删除" : "删除失败：" + (r2.error || ""));
    renderConvFindings();
  }));
}

// 该会话审计日志
function renderConvAudit() {
  const pane = $("ai-d-audit");
  if (!aiDetailConv) return;
  const audit = aiDetailConv.audit || [];
  if (!audit.length) { pane.innerHTML = '<div class="placeholder">无审计记录</div>'; return; }
  pane.innerHTML = audit.slice().reverse().map(a => {
    const ap = a.approval === "approved" ? '<span class="au-ap ok">✓批准</span>'
      : a.approval === "rejected" ? '<span class="au-ap no">✗拒绝</span>'
      : a.approval === "auto" ? '<span class="au-ap auto">自动</span>' : "";
    const head = a.tool ? `<b>${esc(a.tool)}</b>` : `<b>${esc(a.action || "")}</b>`;
    const body = esc(String(a.paramsSummary || a.resultSummary || a.target || ""));
    return `<div class="au-item"><span class="au-time">${new Date(a.time).toLocaleString()}</span> ${head} ${ap}<div class="au-params">${body}</div></div>`;
  }).join("");
}

// 该会话轨迹（方案：直接套用 archify Agent Run Lifecycle 的视觉机制——主流程阶段轨道 + 等待/恢复/终态 lane；
// 数据仍来自现有 sessionEvent 记录；点击任意阶段/lane 区块在下方展开该分组的原始事件行）
let _trajFocus = "all"; // 焦点：all | wait | recovery | exit
function trIcon(type) {
  return ({ task_start: "▶", state: "●", approval: "✋", compaction: "🧩", tool: "🔧", expert_round: "👤", review: "⚠", review_trigger: "⚠", resume: "↻", error: "✗", plan: "🗺" })[type] || "·";
}
function trTime(ev) {
  try { return new Date(ev && ev.ts).toLocaleString(); } catch (e) { return ""; }
}
function trLabel(ev) {
  if (!ev) return "";
  switch (ev.type) {
    case "task_start": return `任务启动 run#${ev.run || 1}`;
    case "plan": return `执行流程 ${ev.kind === "revise" ? "修订" : "提交"}${ev.steps != null ? "（" + ev.steps + " 步）" : ""}`;
    case "state": return ev.state === "done" ? "任务完成" : ev.state === "aborted" ? (ev.reason === "paused" ? "暂停（用户接管）" : "任务中止") : `状态 → ${ev.state}`;
    case "approval": return `批准请求（${ev.mode || ""}）· ${ev.decision || ""}`;
    case "compaction": return `上下文压缩（${ev.method}${ev.trigger ? " · " + ev.trigger : ""} @${ev.at ? ev.at + " tokens" : ""}）`;
    case "compaction_summary": return "压缩摘要已落地";
    case "tool": return `工具调用 ${esc(ev.name || "")}`;
    case "resume": return `续跑恢复（目标：${esc(ev.goal || "")}）`;
    case "expert_round": return `复核审计 ${ev.steps || 0} 步${ev.verified ? " · ✅ 已验证" : ""}${ev.tools ? "（" + esc(ev.tools) + "）" : ""}`;
    case "review": return `对抗性审查（第 ${esc(String(ev.round ?? ""))} 轮）${ev.answered ? " · 已回应" : ""}`;
    case "review_trigger": return `对抗性审查触发（${esc(ev.reason || "")}）`;
    case "error": return `错误：${esc(ev.error || ev.code || "")}`;
    default: return esc(ev.type || "event");
  }
}
// 分桶：主流程/等待/恢复/终态
function trBucket(events) {
  const b = { start: [], plan: [], exec: [], review: [], wait: [], recovery: [], terminal: [] };
  for (const e of events || []) {
    const t = e && e.type;
    if (!t) continue;
    if (t === "task_start" || (t === "state" && e.state === "task_start")) b.start.push(e);
    else if (t === "plan") b.plan.push(e);
    else if (t === "tool") b.exec.push(e);
    else if (t === "review" || t === "expert_round") b.review.push(e);
    else if (t === "approval") b.wait.push(e);
    else if (t === "resume" || (t === "state" && e.state === "aborted" && e.reason === "paused")) b.wait.push(e);
    else if (t === "compaction" || t === "compaction_summary" || t === "review_trigger") b.recovery.push(e);
    else if (t === "state" && (e.state === "done" || e.state === "aborted" || e.state === "error")) b.terminal.push(e);
    else if (t === "error") b.terminal.push(e);
    else b.exec.push(e);
  }
  return b;
}
function trChipHtml(laneCls, title, sub, count, tone, grp) {
  const n = count || 0;
  return `<div class="ar-chip ${laneCls} ${tone || ""}${n ? "" : " ar-empty"}" role="button" tabindex="0" data-grp="${esc(grp || "")}">
    <div class="ar-chip-label">${esc(title)}${n ? ` <b class="ar-count">${n}</b>` : ""}</div>
    ${sub ? `<div class="ar-chip-sub">${esc(sub)}${n ? " · " + n + " 次" : ""}</div>` : ""}
  </div>`;
}
function trRawRows(events) {
  if (!events || !events.length) return "";
  const sorted = events.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return sorted.map(ev => `<div class="au-item"><span class="au-time">${trTime(ev)}</span> <span class="tr-icon">${trIcon(ev.type)}</span> ${trLabel(ev)}${ev.count > 1 ? ` <span class="tr-count">×${ev.count}</span>` : ""}</div>`).join("");
}
function renderTrajectoryLifecycle(pane, events, cp, focus) {
  const b = trBucket(events);
  const total = (events || []).length;
  const FOCUS_ZH = { all: "全部", wait: "等待 / 中断", recovery: "恢复", exit: "终态" };
  const buttons = ["all", "wait", "recovery", "exit"].map(f =>
    `<button class="archi-focus-btn${f === focus ? " active" : ""}" data-focus="${f}">${FOCUS_ZH[f]}</button>`).join("");
  // 主流程轨道（阶段顺序与 archify Agent Run Lifecycle 对齐）
  const mainPhases = [
    { key: "start", title: "启动", sub: "request accepted", tone: "t-start", grp: "start" },
    { key: "plan", title: "规划", sub: "build plan", tone: "t-plan", grp: "plan" },
    { key: "exec", title: "执行", sub: "tool calls", tone: "t-exec", grp: "exec" },
    { key: "review", title: "审查复核", sub: "quality gate", tone: "t-review", grp: "review" },
    { key: "terminal", title: "收尾", sub: "final state", tone: "t-done", grp: "terminal" }
  ];
  const mainRail = mainPhases.map((p, i) => {
    const list = b[p.key] || [];
    const doneCnt = p.key === "terminal" ? list.filter(e => e.state === "done").length : list.length;
    return `<span class="ar-stepno">0${i + 1}</span>` + trChipHtml("ar-main", p.title, p.sub, doneCnt, p.tone, p.grp);
  }).join(`<span class="ar-arrow">›</span>`);
  // 次 lane（按 focus 过滤显示）
  const waitGroups = trGroupWait(b.wait);
  const recoveryGroups = trGroupRecovery(b.recovery);
  const terminalGroups = trGroupTerminal(b.terminal);
  const lane = (visible, label, cls, groups, focusable) => visible ? `<div class="ar-lane ${cls}" data-focusable="${focusable}"><div class="ar-lane-label">${label}</div><div class="ar-track">${groups || `<div class="ar-chip ar-empty ar-fallback">（无）</div>`}</div></div>` : "";
  const waitVisible = focus === "all" || focus === "wait";
  const recoveryVisible = focus === "all" || focus === "recovery";
  const exitVisible = focus === "all" || focus === "exit";
  const html = `
  <div class="archi" data-focus="${focus}">
    <div class="archi-head">
      <div class="archi-title">Agent Run Lifecycle · 轨迹</div>
      <div class="archi-sub">${total} 个事件 · ${cp ? "含续跑检查点" : "基于 sessionEvent 记录"}</div>
      <div class="archi-focus">${buttons}</div>
    </div>
    ${cp ? `<div class="au-item tr-cp"><span class="au-time">${trTime({ ts: cp.at })}</span> <b>💾 续跑检查点</b><div class="au-params">已推进至：${esc(cp.lastStepDesc || "-")} · 目标：${esc(cp.goal || "-")}</div></div>` : ""}
    <div class="ar-lanes">
      <div class="ar-lane ar-main-lane"><div class="ar-lane-label">主流程 · Lifecycle phases</div><div class="ar-track ar-main-track">${mainRail}</div></div>
      ${lane(waitVisible, "等待 / 中断 · Human gates", "ar-wait-lane", waitGroups, "wait")}
      ${lane(recoveryVisible, "恢复 · Recovery loop", "ar-recovery-lane", recoveryGroups, "recovery")}
      ${lane(exitVisible, "终态 · Terminal exits", "ar-exit-lane", terminalGroups, "exit")}
    </div>
    <div class="archi-legend">
      <span class="lg t-start">启动</span><span class="lg t-plan">规划</span><span class="lg t-exec">执行</span><span class="lg t-review">审查复核</span><span class="lg t-done">完成/收尾</span>
      <span class="lg t-wait">等待</span><span class="lg t-recovery">恢复</span><span class="lg t-fail">中止/错误</span>
    </div>
    <div id="tr-details" class="archi-details"></div>
  </div>`;
  pane.innerHTML = html;
  // 焦点按钮
  pane.querySelectorAll(".archi-focus-btn").forEach(btn => btn.addEventListener("click", () => {
    _trajFocus = btn.dataset.focus;
    renderTrajectoryLifecycle(pane, events, cp, _trajFocus);
  }));
  // 点击区块 → 展开原始事件行
  pane.querySelectorAll("[data-grp]").forEach(chip => chip.addEventListener("click", () => {
    const grp = chip.dataset.grp;
    const list = trGroupEvents(grp, events);
    const det = pane.querySelector("#tr-details");
    if (!det) return;
    const open = det.dataset.grp === grp;
    if (open) { det.innerHTML = ""; delete det.dataset.grp; return; }
    det.dataset.grp = grp;
    det.innerHTML = `<div class="archi-det-head">🔍 ${esc(chip.querySelector(".ar-chip-label")?.textContent || grp)} · 原始事件行（${list.length}）</div>` + trRawRows(list);
  }));
}
function trGroupWait(list) {
  const m = new Map();
  for (const e of list) { const k = e.type === "approval" ? "approval" : (e.state === "aborted" && e.reason === "paused" ? "paused" : "resume"); m.set(k, (m.get(k) || 0) + 1); }
  let out = "";
  if (m.get("approval")) out += trChipHtml("ar-wait", "批准", "human gate", m.get("approval"), "t-wait", "approval");
  if (m.get("paused")) out += trChipHtml("ar-wait", "暂停", "user takeover", m.get("paused"), "t-wait", "paused");
  if (m.get("resume")) out += trChipHtml("ar-wait", "续跑", "resumed", m.get("resume"), "t-wait", "resume");
  return out;
}
function trGroupRecovery(list) {
  const m = { comp: 0, adversarial: 0 };
  for (const e of list) { if (e.type === "compaction" || e.type === "compaction_summary") m.comp++; else if (e.type === "review_trigger") m.adversarial++; }
  let out = "";
  if (m.comp) out += trChipHtml("ar-recovery", "上下文压缩", "budget recovery", m.comp, "t-recovery", "compaction");
  if (m.adversarial) out += trChipHtml("ar-recovery", "对抗审查", "recovery loop", m.adversarial, "t-recovery", "review_trigger");
  return out;
}
function trGroupTerminal(list) {
  const m = { done: 0, aborted: 0, error: 0 };
  for (const e of list) { const s = e.state; if (s === "done") m.done++; else if (s === "aborted") m.aborted++; else if (s === "error" || e.type === "error") m.error++; else m.error++; }
  let out = "";
  if (m.done) out += trChipHtml("ar-exit", "完成", "completed", m.done, "t-done", "done");
  if (m.aborted) out += trChipHtml("ar-exit", "中止", "aborted", m.aborted, "t-fail", "aborted");
  if (m.error) out += trChipHtml("ar-exit", "错误", "error", m.error, "t-fail", "error");
  return out;
}
function trGroupEvents(grp, events) {
  const all = events || [];
  const map = {
    start: e => e.type === "task_start" || (e.type === "state" && e.state === "task_start"),
    plan: e => e.type === "plan",
    exec: e => e.type === "tool",
    review: e => e.type === "review" || e.type === "expert_round",
    approval: e => e.type === "approval",
    paused: e => e.state === "aborted" && e.reason === "paused",
    resume: e => e.type === "resume",
    compaction: e => e.type === "compaction" || e.type === "compaction_summary",
    review_trigger: e => e.type === "review_trigger",
    done: e => e.state === "done",
    aborted: e => e.state === "aborted" && e.reason !== "paused",
    error: e => e.type === "error" || e.state === "error",
    terminal: e => e.state === "done" || e.state === "aborted" || e.state === "error" || e.type === "error"
  };
  const fn = map[grp] || (() => false);
  return all.filter(fn);
}
// ===== 轨迹（sequence 引擎 · 会话真实执行流，逐条有记录才出现） =====
let _archifyTemplatePromise = null;
function archifyTemplate() {
  if (!_archifyTemplatePromise) {
    _archifyTemplatePromise = fetch(chrome.runtime.getURL("vendor/archify/assets/template.html")).then(r => r.text()).catch(e => { _archifyTemplatePromise = null; throw e; });
  }
  return _archifyTemplatePromise;
}
let _archifySeqPromise = null;
function archifyWfRenderer() {
  if (!_archifySeqPromise) {
    _archifySeqPromise = import(chrome.runtime.getURL("vendor/archify/renderers/workflow/render-workflow-browser.mjs")).then(m => m.renderWorkflowHtml).catch(e => { _archifySeqPromise = null; throw e; });
  }
  return _archifySeqPromise;
}
function seqClip(s, n) {
  const flat = String(s || "").replace(/\s+/g, " ").trim();
  return flat.length > (n || 60) ? flat.slice(0, n || 60) + "…" : flat;
}
function seqResultSummary(content) {
  const raw = String(content || "");
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      if (o.approval === "rejected") return "✗ 用户拒绝：" + seqClip(o.error || o.reason || "未批准", 56);
      if (o.ok === false || o.error) return "✗ " + seqClip(o.error || o.message || "执行失败", 56);
      const pick = ["url", "status", "key", "value", "count", "total", "summary", "message", "cookie"];
      for (const k of pick) { if (o[k] != null && String(o[k]).trim()) return seqClip(String(k) + "=" + String(o[k]), 56); }
      if (o.data != null) { const d = typeof o.data === "string" ? o.data : JSON.stringify(o.data); if (d && d.length) return seqClip(d, 56); }
      return "✓ ok";
    }
  } catch (e) {}
  const one = raw.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return seqClip(one, 56);
}
// 会话记录 → archify sequence JSON（纯映射；只出现有记录的参与者与消息）
function buildSequenceSpec(conv) {
  const msgs = Array.isArray(conv && conv.messages) ? conv.messages : [];
  const events = Array.isArray(conv && conv.events) ? conv.events : [];
  const PARTICIPANTS = [
    { id: "user", type: "external", label: "用户", sublabel: "输入" },
    { id: "agent", type: "backend", label: "主代理", sublabel: "决策 / 执行" },
    { id: "tool", type: "messagebus", label: "工具", sublabel: "浏览器 / 请求 / 脚本" },
    { id: "audit", type: "security", label: "审计", sublabel: "复核 / 审查" }
  ];
  const used = { user: false, agent: false, tool: false, audit: false };
  const rows = []; // {y, from, to, label, variant}
  const pendingTool = []; // 等待结果的 tool_call（同轮多调用按序配对）
  let auditSeen = false;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      if (m._sys === true) {
        if (m._kind === "review" || m._kind === "expert") {
          // 复核/审查留痕（有记录才出现）
          used.audit = true; auditSeen = true;
          try { const o = JSON.parse(String(m.content || "{}"));
            rows.push({ from: "audit", to: "agent", label: (o.reason ? "对抗性审查：" + seqClip(o.reason, 20) : "复核审计员") + (o.verified ? " · 已验证" : ""), variant: "security" });
          } catch (e) { rows.push({ from: "audit", to: "agent", label: "复核 / 审查留痕", variant: "security" }); }
        }
        continue;
      }
      used.user = true;
      rows.push({ from: "user", to: "agent", label: seqClip(m.content, 72), variant: "default" });
      continue;
    }
    if (m.role === "assistant") {
      used.agent = true;
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (calls.length) {
        for (const tc of calls) {
          const fn = tc && tc.function ? tc.function : (tc || {});
          const name = fn.name || "tool";
          if (name === "call_expert" || name === "plan_write") { used.audit = true; auditSeen = true; }
          let args = {};
          try { args = JSON.parse(fn.arguments || "{}"); } catch (e) {}
          let brief = "";
          if (name === "replay_request" || name === "intruder") brief = ((args.method || (name === "intruder" ? "爆破" : "GET")) + " " + seqClip(args.url || "", 26)).trim();
          else if (name === "eval_js") brief = "执行 JS";
          else if (name === "navigate") brief = "导航 " + seqClip(args.url || "", 22);
          else if (name === "get_network_request_detail") brief = "id=" + seqClip(args.id || "", 16);
          else if (name === "search_dom") brief = seqClip(args.selector || "", 24);
          else if (name === "get_cookies") brief = args.urls ? seqClip(Array.isArray(args.urls) ? args.urls.join(",") : args.urls, 24) : "全部 Cookie";
          else if (name === "upsert_fact" || name === "get_fact") brief = seqClip(args.key || "", 26);
          else brief = seqClip(fn.arguments || "", 30);
          const isWrite = ["replay_request", "intruder", "eval_js", "navigate", "upsert_fact", "workspace_note"].includes(name);
          pendingTool.push(name);
          rows.push({ from: "agent", to: isWrite || name === "call_expert" ? "audit" : "tool", label: name + " " + brief, variant: isWrite ? "security" : "default" });
        }
        continue;
      }
      const txt = String(m.content || "").trim();
      if (txt) rows.push({ from: "agent", to: "user", label: seqClip(txt, 90), variant: "return" });
      continue;
    }
    if (m.role === "tool") {
      used.tool = true;
      const name = pendingTool.length ? pendingTool.shift() : "";
      rows.push({ from: "tool", to: "agent", label: seqResultSummary(m.content), variant: "return" });
    }
  }
  // 终态（events 留痕，仅在无回答消息时补一行，防误导）
  const hadAnswer = rows.some(r => r.to === "user");
  if (!hadAnswer) {
    const t = events.find(e => e.type === "state" && (e.state === "done" || e.state === "aborted" || e.state === "error")) || events.find(e => e.type === "error");
    if (t) { used.agent = true; rows.push({ from: "agent", to: "user", label: t.state === "done" ? "任务完成" : "任务中止/出错", variant: "security" }); }
  }
  if (!rows.length) { used.user = true; used.agent = true; rows.push({ from: "user", to: "agent", label: "（空会话）", variant: "default" }); }
  const participants = PARTICIPANTS.filter(p => used[p.id]).map(p => ({ id: p.id, type: p.type, label: p.label, sublabel: p.sublabel }));
  // 时间轴布局：行距 30，保证 ≥28；H 由行数推导（长会话自动长图）
  const ROW_GAP = 30;
  const startY = 190;
  const messages = rows.map((r, i) => ({ id: "m" + i, from: r.from, to: r.to, y: startY + i * ROW_GAP, label: r.label, variant: r.variant }));
  const lastY = messages.length ? startY + (messages.length - 1) * ROW_GAP : startY;
  const H = Math.max(760, lastY + 130);
  // 用户输入分段（有记录才建段）
  const segments = [];
  let segStart = -1, segLabel = "";
  messages.forEach((msg, i) => {
    const isUserIn = msg.from === "user" && msg.to === "agent";
    if (isUserIn) {
      if (segStart >= 0) segments.push({ from: segStart, to: messages[i - 1].y + 8, label: segLabel });
      segStart = msg.y - 10; segLabel = seqClip(msg.label, 40);
    }
  });
  if (segStart >= 0 && messages.length) segments.push({ from: segStart, to: messages[messages.length - 1].y + 8, label: segLabel });
  const title = "会话执行轨迹 · " + (conv && conv.title ? conv.title : "会话");
  const subtitle = messages.length + " 条执行记录（仅已发生） · run#" + ((events || []).filter(e => e.type === "task_start").length || 1);
  return { schema_version: 1, diagram_type: "sequence", meta: { title, subtitle, viewBox: [920, H], column_fit: "fixed" }, participants, segments, messages, activations: [], cards: [] };
}
function wfClip(s, n) { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > (n || 60) ? t.slice(0, n || 60) + "…" : t; }
function wfIsWrite(name) { return ["replay_request", "intruder", "eval_js", "navigate", "upsert_fact", "workspace_note"].includes(name); }
function wfSemantic(name) {
  if (["plan_write"].includes(name)) return "plan";
  if (["get_page_skeleton", "search_dom", "get_console_logs", "get_script_list", "decode_text"].includes(name)) return "recon";
  if (["get_network_requests", "get_network_request_detail", "get_script_content", "get_cookies"].includes(name)) return "surface";
  if (["replay_request", "intruder", "compare_responses", "eval_js"].includes(name)) return "attack";
  if (["upsert_fact", "get_fact", "workspace_note", "rebuttal_check", "call_expert"].includes(name)) return "store";
  return null;
}
function wfNodeBrief(name, args) {
  if (name === "replay_request" || name === "intruder") return ((args.method || (name === "intruder" ? "爆破" : "GET")) + " " + String(args.url || "")).trim();
  if (name === "get_network_request_detail") return "id=" + String(args.id || "");
  if (name === "search_dom") return String(args.selector || "");
  if (name === "navigate") return "→ " + String(args.url || "");
  if (name === "get_cookies") return args.urls ? String(Array.isArray(args.urls) ? args.urls.join(",") : args.urls) : "全部";
  if (name === "upsert_fact" || name === "get_fact") return String(args.key || "");
  if (name === "plan_write") return "steps ×" + (Array.isArray(args.steps) ? args.steps.length : 0);
  return "";
}
// 会话 → workflow 语义流：泳道/角色结构照官方 agent-tool-call 样例，节点只放真实发生项
function buildWorkflowSpec(conv) {
  const msgs = Array.isArray(conv && conv.messages) ? conv.messages : [];
  const events = Array.isArray(conv && conv.events) ? conv.events : [];
  const G = { plan: { c: 0, s: [] }, recon: { c: 0, s: [] }, surface: { c: 0, s: [] }, attack: { c: 0, s: [] }, store: { c: 0, s: [] } };
  let userFirst = "", finalText = "", approvals = 0, rejects = 0;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user" && m._sys !== true) { if (!userFirst) userFirst = wfClip(m.content, 14); continue; }
    if (m.role === "assistant") {
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc && tc.function ? tc.function : (tc || {});
          const name = fn.name || "";
          let args = {}; try { args = JSON.parse(fn.arguments || "{}"); } catch (e) {}
          const g = wfSemantic(name);
          if (g) { G[g].c++; if (G[g].s.length < 3) { const b = wfNodeBrief(name, args); G[g].s.push(name + (b ? " " + b : "")); } }
        }
      } else { const c = String(m.content || "").trim(); if (c) finalText = wfClip(c, 14); }
      continue;
    }
    if (m.role === "tool") { try { const o = JSON.parse(m.content); if (o && o.approval === "rejected") rejects++; } catch (e) {} }
  }
  for (const e of events || []) { if (e && e.type === "approval") approvals++; }
  const lanes = [
    { id: "ui", label: "User Interface" },
    { id: "agent", label: "Agent Runtime" },
    { id: "policy", label: "Policy & Recovery", variant: "exception" },
    { id: "tools", label: "Tool Execution & Evidence" }
  ];
  const nodes = [];
  nodes.push({ id: "user", lane: "ui", col: 0, type: "external", label: "用户输入", sublabel: userFirst || "会话", width: 132 });
  const hasPlan = G.plan.c > 0;
  const routerCol = hasPlan ? 2 : 1;
  if (hasPlan) nodes.push({ id: "planner", lane: "agent", col: 1, type: "backend", label: "规划", sublabel: "plan_write × " + G.plan.c, width: 132 });
  nodes.push({ id: "router", lane: "agent", col: routerCol, type: "backend", label: "决策 / 路由", sublabel: "工具调用 × " + (G.recon.c + G.surface.c + G.attack.c + G.store.c), width: 132 });
  let pol = routerCol + 1;
  if (approvals || rejects) { nodes.push({ id: "approval", lane: "policy", col: pol, type: "security", label: "批准闸门", sublabel: "gate × " + (approvals + rejects), width: 132 }); pol++; }
  if (rejects) nodes.push({ id: "blocked", lane: "policy", col: pol, type: "security", label: "被拒", sublabel: "用户拒绝 × " + rejects, width: 132 });
  const ORDER = ["recon", "surface", "attack"]; // 主列 3..5；store 单独放 col2（仿官方 store 在前列）
  const META = { recon: { zh: "页面 / 接口侦察", type: "messagebus" }, surface: { zh: "网络 / 脚本测绘", type: "cloud" }, attack: { zh: "重放 / 漏洞验证", type: "security" }, store: { zh: "黑板 / 记忆", type: "database" } };
  const COL = { recon: 3, surface: 4, attack: 5, store: 2 }; // tools lane 列（可与其它 lane 同 x，仅 lane 内互斥）
  const tools = [];
  // 有批准闸门时，工具节点必须排在闸门**右侧**（否则 mainPath 出现 approval→tool 的回退，
  // archify 校验直接报 "moves backward"——带批准的会话轨迹会整块渲染失败）。
  const minToolCol = (approvals || rejects) ? pol : 0;
  for (const key of ORDER) {
    if (!G[key].c) continue;
    tools.push({ id: "tool-" + key, lane: "tools", col: Math.max(COL[key], minToolCol), type: META[key].type, label: META[key].zh, sublabel: (G[key].s[0] ? wfClip(G[key].s[0], 12) + " " : "") + "× " + G[key].c, width: 132 });
  }
  if (G.store.c) tools.push({ id: "tool-store", lane: "tools", col: Math.max(COL.store, minToolCol), type: META.store.type, label: META.store.zh, sublabel: (G.store.s[0] ? wfClip(G.store.s[0], 12) + " " : "") + "× " + G.store.c, width: 132 });
  nodes.push(...tools);
  const lastCol = Math.max.apply(null, tools.map(t => t.col).concat(routerCol, (approvals || rejects) ? pol - 1 : 0));
  nodes.push({ id: "final", lane: "ui", col: lastCol, type: "backend", label: "最终结论", sublabel: finalText || "已输出回答", width: 132 });
  const edges = [];
  edges.push({ id: "e-user", from: "user", to: hasPlan ? "planner" : "router", variant: "default" });
  if (hasPlan) edges.push({ id: "e-plan", from: "planner", to: "router", variant: "emphasis" });
  const hasGate = nodes.some(n => n.id === "approval");
  if (hasGate) edges.push({ id: "e-gate", from: "router", to: "approval", label: "needs approval?", variant: "security" });
  if (rejects && nodes.some(n => n.id === "blocked")) edges.push({ id: "e-denied", from: "approval", to: "blocked", label: "denied", variant: "security", role: "error" });
  const source = hasGate ? "approval" : "router";
  tools.forEach((t, i) => { edges.push({ id: "e-to-" + i, from: source, to: t.id, variant: "emphasis" }); edges.push({ id: "e-out-" + i, from: t.id, to: "final", variant: "default" }); });
  if (!tools.length) edges.push({ id: "e-direct", from: (nodes.some(n => n.id === "approval") ? "approval" : "router"), to: "final", variant: "emphasis" }); // 无工具轮（纯问答）也要闭合 mainPath
  const cards = [];
  if (G.attack.c) cards.push({ dot: "rose", title: "漏洞验证", items: [G.attack.c + " 次重放/验证", G.attack.s[0] || ""] });
  if (approvals || rejects) cards.push({ dot: "amber", title: "人工闸门", items: [approvals + " 次批准" + (rejects ? "，" + rejects + " 次被拒" : "")] });
  const title = "会话执行流程 · " + (conv && conv.title ? conv.title : "会话");
  const mainPath = ["user"];
  if (hasPlan) mainPath.push("planner");
  mainPath.push("router");
  if (nodes.some(n => n.id === "approval")) mainPath.push("approval");
  const fwd = tools.find(t => t.col > routerCol) || tools[0];
  if (fwd) mainPath.push(fwd.id);
  if (nodes.some(n => n.id === "final")) mainPath.push("final");
  return { schema_version: 2, diagram_type: "workflow", meta: { title, subtitle: "workflow 语义视图（仅已发生项）" }, lanes, phases: [], groups: [], mainPath: [...new Set(mainPath)].slice(0, 12), nodes, edges, cards };
}

function archifyStyleOf(html) {
  const cs = html.indexOf("<style>");
  const ce = html.indexOf("</style>");
  return cs >= 0 && ce > cs ? html.slice(cs + 7, ce) : "";
}
function archifySvgOf(html) {
  const st = html.indexOf("<svg ");
  const en = html.lastIndexOf("</svg>");
  return st >= 0 && en > st ? html.slice(st, en + 6) : "";
}
function initTraceZoom(iframe) {
  if (!iframe || !iframe.contentDocument) return;
  const doc = iframe.contentDocument;
  const svg = doc.querySelector("svg");
  if (!svg) return;
  const vb = (svg.getAttribute("viewBox") || "0 0 920 600").split(/\s+|,/).filter(Boolean).map(Number);
  const natW = vb[2] || 920;
  svg.setAttribute("width", String(natW));
  let scale = 1, tx = 0, ty = 0, drag = null;
  const apply = () => { svg.style.transformOrigin = "0 0"; svg.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")"; svg.style.willChange = "transform"; };
  const clampScale = (s) => Math.min(6, Math.max(0.2, s));
  doc.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0016);
    const ns = clampScale(scale * factor);
    const r = svg.getBoundingClientRect();
    // 以光标为锚点（视口坐标直接对应变换后坐标）
    const px = (e.clientX - tx) / scale;
    const py = (e.clientY - ty) / scale;
    scale = ns; tx = e.clientX - px * scale; ty = e.clientY - py * scale;
    apply();
  }, { passive: false });
  doc.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, tx, ty }; doc.body.style.cursor = "grabbing"; svg.setPointerCapture && svg.setPointerCapture(e.pointerId); });
  doc.addEventListener("pointermove", (e) => { if (!drag) return; tx = drag.tx + (e.clientX - drag.x); ty = drag.ty + (e.clientY - drag.y); apply(); });
  doc.addEventListener("pointerup", () => { drag = null; doc.body.style.cursor = ""; });
  doc.addEventListener("dblclick", () => { scale = 1; tx = 0; ty = 0; apply(); });
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };
  svg.style.width = "920px"; // 自然宽；变换由 parent 控制
  apply();
  return { reset };
}
function renderConvTrajectory() {
  const pane = $("ai-d-trajectory");
  if (!aiDetailConv) return;
  const convId = aiDetailConv.convId;
  const hasAny = (aiDetailConv.messages || []).length || (aiDetailConv.events || []).length || aiDetailConv.checkpoint;
  if (!hasAny) { pane.innerHTML = '<div class="placeholder">暂无轨迹记录（任务执行时自动留痕）</div>'; return; }
  const gen = (pane._trGen = (pane._trGen || 0) + 1);
  pane.innerHTML = '<div class="placeholder">正在用 archify workflow 引擎渲染执行流程…</div>';
  (async () => {
    try {
      const [template, render] = await Promise.all([archifyTemplate(), archifyWfRenderer()]);
      const spec = buildWorkflowSpec(aiDetailConv);
      const html = await render(spec, template);
      if (gen !== pane._trGen || convId !== (aiDetailConv && aiDetailConv.convId)) return;
      const style = archifyStyleOf(html);
      const svg = archifySvgOf(html);
      if (!svg) { pane.innerHTML = '<div class="placeholder">archify 渲染无输出</div>'; return; }
      pane.innerHTML = '<div class="tr-toolbar"><span>🧭 会话执行流程（workflow · ' + spec.nodes.length + ' 节点 / ' + spec.edges.length + ' 边）</span><span class="tr-hint">滚轮缩放 · 拖拽平移 · 双击复位</span><button type="button" class="mini-btn" id="tr-reset">复位</button><button type="button" class="mini-btn" id="tr-open">打开完整工件</button></div>'
        + '<div class="tr-stage"><iframe id="tr-frame" class="archi-frame" title="archify 执行轨迹"></iframe></div>';
      const frame = pane.querySelector("#tr-frame");
      const doc = '<!doctype html><html><head><meta charset="utf-8"><style>' + style + ' html,body{margin:0;overflow:hidden;background:#020617;cursor:grab;}</style></head><body>' + svg + '</body></html>';
      frame.srcdoc = doc;
      frame.addEventListener("load", () => { initTraceZoom(frame); }, { once: true });
      const rst = pane.querySelector("#tr-reset");
      if (rst) rst.addEventListener("click", () => { const ifr = pane.querySelector("#tr-frame"); if (ifr) initTraceZoom(ifr); });
      const opn = pane.querySelector("#tr-open");
      if (opn) opn.addEventListener("click", () => {
        try { const blob = new Blob([html], { type: "text/html" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "f12x-trace.html"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }
        catch (e) { toast("导出失败：" + (e && e.message)); }
      });
    } catch (e) {
      if (gen === pane._trGen) pane.innerHTML = '<div class="placeholder">archify 渲染失败：' + esc(String((e && (e.stack || e.message)) || e)).substring(0, 900) + '</div>';
      console.error("[F12x] archify 轨迹渲染失败：", e);
    }
  })();
}

function scheduleNetRender() {
  if (_netRenderTimer) return;
  _netRenderTimer = setTimeout(() => { _netRenderTimer = null; try { renderNetworkTable(); } catch (e) { console.error("[F12x] renderNetworkTable 异常：", e && (e.stack || e.message)); } }, 120);
}

function handleStream(event, data) {
  switch (event) {
    case "network:request":
      if (!data || data.id == null) return; // 防御：畸形帧不崩溃
      // 若请求已在列表（拦截路径先入）则跳过
      if (!app.network.items.some(i => i.id === data.id)) {
        app.network.items.push({
          id: data.id, url: data.url, method: data.method, type: data.type,
          source: data.source || "page", intercepted: !!data.intercepted,
          size: data.size != null ? data.size : null
        });
        if (app.network.items.length > 500) app.network.items.shift();
      }
      scheduleNetRender();
      break;
    case "network:updated": {
      if (!data || data.id == null) return; // 防御
      const it = app.network.items.find(i => i.id === data.id);
      if (it) {
        // 修复（审读中）：updated 补丁整体合并（含 size/status/mimeType）——原只回填 status，size 列恒 "-"
        Object.assign(it, data);
        scheduleNetRender();
      }
      break;
    }
    case "console:log":
      app.network.consoleLogs.push(data);
      if (app.network.consoleLogs.length > 200) app.network.consoleLogs.shift();
      if (app.network.detailTab === "console") renderNetworkDetail();
      break;
    case "network:snapshot": // 面板重开回填（方案十二.2）：整体替换为 SW 内存最新态
      app.network.items = (data.items || []).slice(-500);
      renderNetworkTable();
      break;
    case "console:snapshot":
      app.network.consoleLogs = (data.items || []).slice(-200);
      if (app.network.detailTab === "console") renderNetworkDetail();
      break;
    case "script:parsed":
      // 脚本列表由手动刷新
      break;
    case "inspect:selected": {
      const card = $("page-inspect-card");
      card.classList.remove("hidden");
      const attrs = data.attributes || {};
      const code = data.code || {};
      const ls = code.listeners || [];
      const css = code.css || [];
      const html = String(data.html || code.html || "");
      card.innerHTML = `
        <div class="ic-row"><span class="ic-k">元素</span><span class="ic-v">&lt;${esc(data.tag)}&gt;</span></div>
        <div class="ic-row"><span class="ic-k">选择器</span><span class="ic-v">${esc(data.selector || code.selector || "")}</span></div>
        ${data.text ? `<div class="ic-row"><span class="ic-k">文本</span><span class="ic-v">${esc(data.text.substring(0, 200))}</span></div>` : ""}
        ${Object.entries(attrs).slice(0, 6).map(([k, v]) => `<div class="ic-row"><span class="ic-k">${esc(k)}</span><span class="ic-v">${esc(String(v).substring(0, 120))}</span></div>`).join("")}
        ${html ? `<details class="ic-detail"><summary>HTML 源码（${html.length} 字符）</summary><pre class="ic-code">${esc(html.substring(0, 2000))}</pre></details>` : ""}
        ${ls.length ? `<details class="ic-detail" open><summary>事件监听器 ${ls.length} 个（JS 底层代码）</summary>${ls.map(l => `<div class="ic-ls"><div class="ic-ls-tag">${esc(l.type)}${l.once ? " (once)" : ""}${l.scriptId ? " · " + esc(l.scriptId + ":" + (l.line || "?")) : ""}</div><pre class="ic-code">${esc(l.snippet)}</pre></div>`).join("")}</details>` : ""}
        ${css.length ? `<details class="ic-detail"><summary>匹配 CSS 规则 ${css.length} 条</summary>${css.map(c => `<pre class="ic-code">${esc(c)}</pre>`).join("")}</details>` : ""}
        <div class="ic-actions">
          <button class="mini-btn" data-ic="copy">复制选择器</button>
          <button class="mini-btn" data-ic="highlight">高亮</button>
          <button class="mini-btn" data-ic="ai">送 AI 分析</button>
          <button class="mini-btn primary" data-ic="ai-debug">精确调试</button>
        </div>`;
      card.querySelector('[data-ic="copy"]').addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(data.selector || code.selector || "");
          toast("选择器已复制");
        } catch (e) { toast("复制失败"); }
      });
      card.querySelector('[data-ic="highlight"]').addEventListener("click", async () => {
        const r = await api("tool:highlight", { selector: data.selector || code.selector || "" });
        toast(r.ok ? "已高亮" : "高亮失败：" + r.error);
      });
      card.querySelector('[data-ic="ai"]').addEventListener("click", async () => {
        // 轻量分析：元素描述走 ai:chat（回复流到 AI 状态条）
        const attrsTxt = Object.entries(attrs).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(" ");
        const text = `分析该页面元素的安全/功能含义：\n<${data.tag} ${attrsTxt}>\n选择器: ${data.selector || code.selector || ""}\n${data.text ? "文本: " + data.text.substring(0, 120) : ""}`;
        await aiSendFromPage(text, "元素分析：" + data.tag, true);
      });
      card.querySelector('[data-ic="ai-debug"]').addEventListener("click", async () => {
        // v0.3 精确调试：底层代码（HTML + 事件监听器 JS 源码 + CSS 规则）→ 完整 AI 引擎（ai:task）
        const L = [];
        L.push("[精确调试] 用户点击了页面元素，请基于以下底层代码快速定位并输出调试分析：");
        L.push("1) 该元素在前端中的角色与数据流 2) 绑定的逻辑与潜在安全/功能风险 3) 建议的调试点");
        if (data.pageUrl) L.push("页面 URL: " + data.pageUrl);
        L.push("元素选择器: " + (data.selector || code.selector || ""));
        if (html) L.push("\n── HTML 源码 ──\n" + html.substring(0, 1500));
        if (ls.length) {
          L.push("\n── 事件监听器（JS 底层代码）──");
          for (const l of ls) {
            L.push(`\n• ${l.type}${l.once ? " (once)" : ""}${l.scriptId ? "  [scriptId " + l.scriptId + ":" + (l.line || "?") + "]" : ""}`);
            if (l.snippet) L.push(String(l.snippet).substring(0, 1200));
          }
        }
        if (css.length) {
          L.push("\n── 匹配 CSS 规则 ──");
          for (const c of css) L.push("• " + String(c).substring(0, 300));
        }
        await aiSendFromPage(L.join("\n"), "精确调试：" + data.tag, true);
      });
      break;
    }
    case "intercept:paused": {
      app.intercept.queue.push(data);
      renderInterceptBanner();
      // 自动弹出处置窗口
      if (app.currentView !== "network") switchView("network");
      showInterceptAction(data);
      break;
    }
    case "intercept:mode":
      app.intercept.mode = data.mode;
      renderInterceptMode();
      break;
    case "intercept:resolved":
      app.intercept.queue = app.intercept.queue.filter(i => i.pausedId !== data.pausedId);
      renderInterceptBanner();
      // 仅当当前弹层是拦截处置窗口时才关闭，避免误关其他弹层
      if ($("modal-root").querySelector("#ic-action")) closeModal();
      break;
    case "intercept:released_all":
      app.intercept.queue = [];
      renderInterceptBanner();
      break;
    case "debugger:attached":
      setStatusDot(true);
      if (data.url) app.state.debuggeeUrl = data.url;
      toast("调试器已附加：" + (data.url || ""));
      break;
    case "debugger:detached":
      setStatusDot(false);
      toast("调试器已分离");
      break;
    default:
      break;
  }
}

// ============================================================
// 启动
// ============================================================
// ============================================================
// 分栏拖拽缩放（可拉伸的框）
// ============================================================
function initResizers() {
  document.querySelectorAll(".resizer").forEach((bar) => {
    const isV = bar.classList.contains("resizer-v");
    const sel = bar.dataset.resizeV || bar.dataset.resizeH;
    const target = document.querySelector(sel);
    if (!target) return;
    // 目标初始隐藏（如网络详情）时隐藏分隔条，打开后再显示
    if (target.classList.contains("hidden")) bar.classList.add("hidden");
    bar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const parent = target.parentElement;
      const startX = e.clientX, startY = e.clientY;
      const startSize = isV ? target.offsetHeight : target.offsetWidth;
      const minPx = parseFloat(bar.dataset.min || 60);
      const maxAttr = parseFloat(bar.dataset.max || 600);
      const maxIsRatio = !!bar.dataset.max && bar.dataset.max.startsWith("0.");
      bar.classList.add("dragging");
      document.body.classList.add(isV ? "resizing-v" : "resizing-h");
      const onMove = (ev) => {
        // 垂直分隔条位于目标区域上方：分隔条跟随鼠标需目标高度反向变化（否则分隔条被反向顶开）
        const delta = isV ? -(ev.clientY - startY) : (ev.clientX - startX);
        const parentSize = isV ? parent.clientHeight : parent.clientWidth;
        const maxPx = maxIsRatio ? parentSize * maxAttr : Math.min(maxAttr, parentSize * 0.85);
        const size = Math.max(minPx, Math.min(maxPx, startSize + delta));
        if (isV) target.style.height = size + "px";
        else target.style.width = size + "px";
      };
      const onUp = () => {
        bar.classList.remove("dragging");
        document.body.classList.remove("resizing-v", "resizing-h");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
}

// 聊天输入委托绑定 + 全局错误可见化（放在 init() 最前执行）。
// 之所以用 document 委托：若任一 init* 抛错，此前直接绑定到 #ai-chat-send/#ai-input
// 的监听会全部丢失 → 点发送/回车"没有任何反应"（静默）。委托 + 单独 try/catch 隔离每个模块，
// 保证发送入口与错误提示永不失效。
function initChatDelegates() {
  document.addEventListener("click", (e) => {
    const node = e.target && e.target.closest ? e.target.closest("#ai-chat-send") : null;
    if (!node) return;
    e.preventDefault();
    chatSendGuard();
  });
  document.addEventListener("click", (e) => {
    const node = e.target && e.target.closest ? e.target.closest("#ai-chat-stop") : null;
    if (!node) return;
    e.preventDefault();
    api("ai:stop");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (!e.target || e.target.id !== "ai-input") return;
    e.preventDefault();
    chatSendGuard();
  });
  // 全局异常浮出：脚本任何运行时错误都打到聊天区 + toast，杜绝"毫无反应"黑盒
  const surfErr = (where) => (ev) => {
    const msg = (ev && (ev.message || (ev.reason && ev.reason.message))) || "未知脚本错误";
    console.error("[F12x] " + where + "：", ev && (ev.reason || ev.error || ev));
    try {
      if (chatUI && chatUI.open) chatFlowLine("warn", "⚠ 面板脚本错误（" + where + "）：" + escapeHtml(String(msg).substring(0, 200)));
    } catch (e2) {}
    try { toast("脚本错误：" + String(msg).substring(0, 120)); } catch (e2) {}
  };
  window.addEventListener("error", surfErr("error"));
  window.addEventListener("unhandledrejection", surfErr("unhandledrejection"));
  // 兜底通道：后台在"无 port 长连接"时用 chrome.runtime.sendMessage 推送状态，
  // 面板必须监听 runtime.onMessage 才能收到（否则 port 掉线期间事件全丢）。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === "status" || msg.type === "stream")) onStreamMessage(msg);
  });
}

function init() {
  initChatDelegates(); // 最先绑定：发送/停止/回车 + 错误浮出 + 状态兜底通道
  renderStaticIcons();
  document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
  initResizers();
  // 逐模块隔离：单个模块初始化抛错不再拖垮后续（尤其是 AI 模块的绑定与渲染）
  const safeInit = (name, fn) => { try { fn(); } catch (e) { console.error("[F12x] init " + name + " 失败：", e); try { toast("初始化 " + name + " 失败：" + (e && e.message)); } catch (e2) {} } };
  safeInit("page", initPageModule);
  safeInit("network", initNetworkModule);
  safeInit("issue", initIssueModule);
  safeInit("request", initRequestModule);
  safeInit("cookie", initCookieModule);
  safeInit("script", initScriptModule);
  safeInit("project", initProjectModule);
  safeInit("ai", initAIModule);
  safeInit("pn", pnInit);
  safeInit("settings", initSettings);
  safeInit("chatModel", initChatModelSwitch);
  safeInit("localWarm", initLocalWarm);
  loadRepHistory(); // 14.7② Repeater 历史恢复（会话级 storage）
  $("ai-stop-btn").addEventListener("click", async () => { await api("ai:stop"); });
  // AI 审计日志展开/收起（方案 4.1）
  $("ai-audit-btn").addEventListener("click", () => {
    const box = $("ai-audit");
    const show = box.classList.toggle("hidden");
    if (!show) renderAudit();
  });
  // 接管 / 继续（方案 3.2：接管=暂停，继续=重新侦察续跑）
  $("ai-takeover-btn").addEventListener("click", async () => {
    const r = await api("ai:takeover");
    toast(r.ok ? "已接管，AI 已暂停（可手动操作）" : "接管失败：" + r.error);
  });
  $("ai-resume-btn").addEventListener("click", async () => {
    const r = await api("ai:resume");
    toast(r.ok ? "已继续：AI 重新侦察当前页面后续跑原任务" : "继续失败：" + r.error);
  });
  // 面板内快捷键（方案九.3：sidePanel 聚焦时生效）
  // Alt+I Inspect / Alt+P AI 暂停-继续 / Alt+R Repeater 发送 / Alt+X 拦截开关
  document.addEventListener("keydown", async (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) {
      if (!(e.altKey && e.key.toLowerCase() === "r")) return; // Repeater 发送允许在输入框触发
      e.preventDefault();
      repSend();
      return;
    }
    const key = e.key.toLowerCase();
    if (key === "i") { e.preventDefault(); toggleInspect(); }
    else if (key === "p") {
      e.preventDefault();
      const s = await api("ai:status");
      if (!s.ok) return toast("AI 未就绪");
      if (s.paused) { const r = await api("ai:resume"); toast(r.ok ? "AI 继续（重新侦察页面）" : "继续失败：" + r.error); }
      else if (s.running) { const r = await api("ai:takeover"); toast(r.ok ? "AI 已暂停（接管）" : "接管失败：" + r.error); }
      else toast("AI 空闲，无需暂停");
    }
    else if (key === "x") { e.preventDefault(); setInterceptMode(app.intercept.mode === "off" ? "all" : "off"); }
  });
  connectStream();
  refreshState();
  // 轮询刷新连接状态（SW 重启后同步）
  setInterval(() => {
    api("util:get_state").then(r => {
      if (r.ok) {
        setStatusDot(r.state.attached);
        $("llm-badge").classList.toggle("hidden", !r.state.llmConfigured);
        if (r.state.interceptMode !== app.intercept.mode) {
          app.intercept.mode = r.state.interceptMode;
          renderInterceptMode();
        }
        // 修复（审读中低）：轮询同时对齐拦截队列——SW 重启广播 released_all 时面板若断连会漏 → 横幅/计数残留
        if (Array.isArray(r.state.interceptQueue)) {
          const qids = app.intercept.queue.map(x => x.pausedId).join(",");
          const nids = r.state.interceptQueue.map(x => x.pausedId).join(",");
          if (qids !== nids) {
            app.intercept.queue = r.state.interceptQueue;
            renderInterceptBanner();
          }
        }
      }
    });
  }, 5000);
}

document.addEventListener("DOMContentLoaded", init);

