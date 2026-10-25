// ============================================================
// F12x router 模块（重构 v0.2）：手动工具层消息路由
// 用户主导：sidePanel → ctrl 通道（sendMessage 请求-响应）
// 手动工具直接调 debugger 工具（不经 LLM）；AI 消息转发 ai 引擎
// ============================================================
import { taskState, appState, pushStatus } from "./state.js";
import { busEmit } from "./bus.js";
import { getLLMConfig, runChat, warmLocalModel } from "./llm.js";
import { applyModelForRun, getModelById, listModels, saveModels, getActiveModelId, setActiveModel } from "./models.js";
import { normalizeError } from "./errors.js";
// AI 引擎静态导入（MV3 Service Worker 禁止动态 import()——HTML 规范限制；
// "AI 隔离"由运行时 LLM 配置检查保证：未配置时工具台 100% 可用，不依赖 AI 模块加载隔离）
import { handleTaskMessage, resolveApproval, pauseTask, resumeTask } from "./agent.js";
// P1：手动工具统一入口（M3 双路径——manual 跳过批准，保留 校验+超时+审计）
import { dispatchTool } from "./executor.js";
import {
  debuggerAttach, debuggerDetach, get_page_skeleton, eval_js, search_dom,
  get_network_requests, get_network_request_detail, get_console_logs,
  get_cookies, get_script_list, get_script_content, sendCDP,
  navigate, highlight_element, screenshot, formRecon,
  inspectEnable, inspectDisable, interceptSetMode, interceptAction, interceptReleaseAll,
  metadataSearch, collectElementCodeBySelector
} from "./debugger.js";
import {
  listSites, createSite, getSite, deleteSite, renameSite,
  getActiveSiteId, setActiveSiteId, addSiteFact, removeSiteFact,
  addSiteTemplate, deleteSiteTemplate, deriveScopeFromUrl,
  listConversations, getConversation, saveConversation,
  createConversation, deleteConversation,
  listProjects, createProject, renameProject, deleteProject,
  listAIFindings, removeAIFinding
} from "./memory.js";

const VERSION = "0.2.2";
// 手动 Intruder 的中断控制器（面板「停止」→ tool:intruder_stop 中止当前爆破）
let manualIntruderCtl = null;

// 工具调用包装：统一 try/catch + 来源记录
async function toolRun(fn, source, auditBrief, sendResponse) {
  try {
    const result = await fn();
    // 统一错误契约：显式 ok:true=成功；带 error 且未显式 ok:true=失败；纯数据(无 ok/无 error)=成功
    const failed = result && result.ok === undefined && result.error != null ? true : result && result.ok === false;
    busEmit("audit", { ts: Date.now(), actor: source, action: auditBrief, result: failed ? String((result && result.error) || "").substring(0, 120) : "ok" });
    sendResponse({ ok: !failed, ...result });
  } catch (e) {
    // P0b：手动工具路径同样走稳定错误码（normalizeError 单入口）
    sendResponse(normalizeError(e));
  }
}

export function handleMessage(message, sender, sendResponse) {
  const type = message.type;

  // === 基础 ===
  if (type === "util:ping") {
    sendResponse({ ok: true, version: VERSION });
    return true;
  }
  if (type === "util:get_state") {
    (async () => {
      const llmConfig = await getLLMConfig().catch(() => null);
      const activeSiteId = await getActiveSiteId();
      sendResponse({
        ok: true,
        state: {
          attached: appState.attached,
          debuggeeUrl: appState.debuggeeUrl,
          inspectMode: appState.inspectMode,
          interceptMode: appState.interceptMode,
          interceptQueueCount: appState.interceptQueue.length,
          // 队列摘要（面板轮询对齐用——防 SW 重启 released_all 广播期间断连导致横幅/计数残留）
          interceptQueue: appState.interceptQueue.map(i => ({ pausedId: i.pausedId, url: i.url, method: i.method })),
          activeSiteId,
          llmConfigured: !!(llmConfig && llmConfig.baseUrl && llmConfig.apiKey),
          version: VERSION
        }
      });
    })();
    return true;
  }
  // === 设置 / 模型（后台是唯一读写方；面板只发消息）===
  if (type === "settings:get") {
    (async () => {
      try {
        const keys = ["llmConfig", "approvalLevel", "llm_endpoints", "f12x_thinking_limit", "f12x_guard_profile", "f12x_local_warm"];
        const settings = await chrome.storage.local.get(keys);
        const [models, activeId] = await Promise.all([listModels(), getActiveModelId()]);
        sendResponse({ ok: true, settings, models, activeId: activeId || "" });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "settings:save") {
    (async () => {
      try {
        const ALLOW = ["approvalLevel", "llm_endpoints", "f12x_thinking_limit", "f12x_guard_profile", "f12x_local_warm", "llmConfig"];
        const src = message.settings || {};
        const patch = {};
        for (const k of ALLOW) if (src[k] !== undefined) patch[k] = src[k];
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
        if (Array.isArray(message.models)) await saveModels(message.models);
        if (message.activeId) await setActiveModel(message.activeId);
        sendResponse({ ok: true, activeId: message.activeId || "" });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "model:list") {
    (async () => {
      try {
        const [models, activeId] = await Promise.all([listModels(), getActiveModelId()]);
        sendResponse({ ok: true, models, activeId: activeId || "" });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "util:open_panel") {
    // 悬浮球 ⚙ → 打开工具台侧栏（用 sender.tab 定位发起页面——SW 中 query currentWindow 不可靠）
    (async () => {
      try {
        const tab = sender && sender.tab;
        if (tab) await chrome.sidePanel.open({ windowId: tab.windowId, tabId: tab.id });
        else {
          const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          const t = tabs && tabs[0];
          if (t) await chrome.sidePanel.open({ windowId: t.windowId, tabId: t.id });
          else await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
        }
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "util:attach") {
    (async () => {
      try { await debuggerAttach(); sendResponse({ ok: true, url: appState.debuggeeUrl }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "util:detach") {
    (async () => {
      try { await debuggerDetach(); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // === 页面模块 ===
  if (type === "tool:page_skeleton") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => get_page_skeleton(), "user", "页面骨架", sendResponse);
    })();
    return true;
  }
  if (type === "tool:search_dom") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => search_dom(String(message.selector || "")), "user", `DOM 搜索 ${message.selector}`, sendResponse);
    })();
    return true;
  }
  if (type === "tool:form_recon") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => formRecon(), "user", "表单侦察", sendResponse);
    })();
    return true;
  }
  if (type === "tool:eval_js") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => eval_js(String(message.code || ""), "readonly"), "user", "执行 JS", sendResponse);
    })();
    return true;
  }
  if (type === "tool:navigate") {
    (async () => {
      try {
        const r = await navigate(String(message.url || ""));
        sendResponse(r.ok
          ? { ok: true, url: r.url, status: r.internal ? "opened" : "navigated", note: r.note }
          : { ok: false, error: ("navigate 后端返回: " + JSON.stringify(r)).substring(0, 400) });
      } catch (e) { sendResponse({ ok: false, error: String((e && (e.message || e)) || "导航异常（无详情）").substring(0, 300) }); }
    })();
    return true;
  }
  if (type === "tool:screenshot") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => screenshot({ fullPage: message.fullPage === true }), "user", "截图", sendResponse);
    })();
    return true;
  }
  if (type === "tool:highlight") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => highlight_element({ selector: String(message.selector || "") }), "user", `高亮 ${message.selector}`, sendResponse);
    })();
    return true;
  }
  // P2c（方案 §9.1 / V2）：读取溢出区全文（G1，手动可用）
  if (type === "tool:read_spilled") {
    (async () => {
      toolRun(() => dispatchTool("read_spilled", { key: String(message.key || "") }, { mode: "manual" }), "user", `读取溢出数据 ${message.key}`, sendResponse);
    })();
    return true;
  }

  // === 网络模块 ===
  if (type === "network:metadata_search") {
    // 方案九.4 v1：元数据搜索（URL/请求头/响应头，内存过滤）
    (async () => {
      try { sendResponse({ ok: true, ids: metadataSearch(message.query || "") }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "tool:network_list") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => get_network_requests(message.filter || null, message.limit || 100), "user", "网络列表", sendResponse);
    })();
    return true;
  }
  if (type === "tool:network_detail") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => get_network_request_detail(message.id, { offset: message.offset || 0, limit: message.limit || 30000 }), "user", `请求详情 ${message.id}`, sendResponse);
    })();
    return true;
  }
  if (type === "tool:console_logs") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => get_console_logs(message.level || null, message.limit || 100), "user", "控制台日志", sendResponse);
    })();
    return true;
  }

  // === Cookie 模块 ===
  if (type === "tool:cookies") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => get_cookies(message.includeValues !== false, null), "user", "Cookie 查看", sendResponse);
    })();
    return true;
  }
  if (type === "cookie:set") {
    // v1：Cookie 编辑（Network.setCookie）
    (async () => {
      try {
        await debuggerAttach();
        const c = message.cookie || {};
        if (!c.name || !c.url) return sendResponse({ ok: false, error: "name 与 url 必填" });
        const cdp = await sendCDP("Network.setCookie", {
          name: c.name, value: String(c.value || ""), url: c.url,
          domain: c.domain, path: c.path || "/", httpOnly: !!c.httpOnly,
          secure: !!c.secure, sameSite: c.sameSite || "Lax",
          expires: c.expires && c.expires > 0 ? c.expires : -1
        });
        // 防假成功：CDP 拒绝时返回 {success:false} 而非抛异常（成熟实现均检查该字段）
        if (cdp && cdp.success === false) {
          return sendResponse({
            ok: false,
            error: "浏览器拒绝写入该 Cookie（CDP success:false）。常见原因：url 与 domain 不匹配 / http 页写 secure / SameSite 约束 / host-only 域。可改用 域名根 URL（如 http://localhost:18081/）+ path 组合后重试；查看请刷新页面后读取。"
          });
        }
        sendResponse({ ok: true, note: "已写入浏览器 Cookie 存储；页面内已存在的 JS 会话不更新，刷新页面后生效" });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "cookie:remove") {
    (async () => {
      try {
        await debuggerAttach();
        const c = message.cookie || {};
        if (!c.name || !c.url) return sendResponse({ ok: false, error: "name 与 url 必填" });
        await sendCDP("Network.deleteCookies", { name: c.name, url: c.url });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // === 脚本模块 ===
  if (type === "tool:script_list") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => get_script_list(), "user", "脚本列表", sendResponse);
    })();
    return true;
  }
  if (type === "tool:script_content") {
    (async () => {
      await debuggerAttach().catch(() => {});
      toolRun(() => get_script_content(message.url, message.startLine, message.endLine, message.grep, message.limit), "user", `脚本源码 ${message.url}`, sendResponse);
    })();
    return true;
  }

  // === 请求模块（Burp 四件套）——P1：统一走 dispatchTool(manual)（校验+超时+审计） ===
  if (type === "tool:replay") {
    (async () => {
      await debuggerAttach().catch(() => {});
      const r = await dispatchTool("replay_request", { url: message.url, method: message.method || "GET", headers: message.headers || {}, body: message.body || null }, { mode: "manual" });
      busEmit("audit", { ts: Date.now(), actor: "user", action: `Repeater 发送 ${message.url}`, result: r?.error ? String(r.error).substring(0, 120) : `状态 ${r.status}` });
      sendResponse({ ok: !r.error, ...r });
    })();
    return true;
  }
  if (type === "tool:intruder") {
    (async () => {
      await debuggerAttach().catch(() => {});
      // P1：interruptible——面板「停止」经 tool:intruder_stop 触发本控制器，
      // 由 intruder 内部逐请求检查 signal 并提前返回 interrupted（真正停下，不是只解 UI）
      manualIntruderCtl = new AbortController();
      const ctl = manualIntruderCtl;
      try {
        const r = await dispatchTool("intruder", { url: message.url, method: message.method || "GET", headers: message.headers || {}, body: message.body || null, payloads: message.payloads || [], concurrency: message.concurrency || 3, includeBody: message.includeBody || false, rateLimitMs: message.rateLimitMs || 0 }, { mode: "manual", signal: ctl.signal });
        sendResponse({ ok: !r.error, ...r });
      } finally {
        if (manualIntruderCtl === ctl) manualIntruderCtl = null;
      }
    })();
    return true;
  }
  if (type === "tool:intruder_stop") {
    // 手动 Intruder 中断入口：中止在跑的爆破（无在跑任务时 stopped=false，幂等）
    const hit = !!manualIntruderCtl;
    try { if (manualIntruderCtl) manualIntruderCtl.abort(); } catch (e) {}
    sendResponse({ ok: true, stopped: hit });
    return true;
  }
  if (type === "tool:compare") {
    (async () => {
      const r = await dispatchTool("compare_responses", { a: String(message.a || ""), b: String(message.b || "") }, { mode: "manual" });
      sendResponse({ ok: !r.error, ...r });
    })();
    return true;
  }
  if (type === "tool:decode") {
    (async () => {
      // mode 默认 base64_decode（原 "base64" 非合法枚举——修掉）
      const r = await dispatchTool("decode_text", { text: String(message.text || ""), mode: message.mode || "base64_decode", encoding: message.encoding || "utf-8" }, { mode: "manual" });
      sendResponse({ ok: !r.error, ...r });
    })();
    return true;
  }

  // === Inspect 点选 ===
  if (type === "inspect:set_mode") {
    (async () => {
      try {
        await debuggerAttach();
        if (message.enabled) { await inspectEnable(); sendResponse({ ok: true, mode: "on", hint: "点击页面元素完成选择，再次点击面板按钮关闭" }); }
        else { await inspectDisable(); sendResponse({ ok: true, mode: "off" }); }
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "inspect:pick_element") {
    // v0.3 内容脚本拾取：content 点击元素（唯一选择器 + HTML）→ 收集底层代码 → 返回给 content 作为上下文
    // 用户主导：拾取仅作为"输入内容的一部分"（上下文），不再自动送 AI；由用户输入指令后回车才执行
    (async () => {
      try {
        await debuggerAttach();
        const code = await collectElementCodeBySelector(String(message.selector || ""), String(message.html || ""));
        // 面板侧收到 inspect:selected 卡片，由用户手动触发"精确调试"
        busEmit("inspect:selected", {
          tag: String(message.tag || ""), nodeName: "element", attributes: {},
          selector: code.selector || message.selector || "",
          html: code.html || message.html || "",
          text: "",
          code,
          pageUrl: appState.debuggeeUrl || ""
        });
        sendResponse({ ok: true, selector: code.selector || message.selector || "", code, html: code.html || message.html || "" });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // === 拦截（v1） ===
  if (type === "intercept:set_mode") {
    (async () => {
      try {
        await debuggerAttach();
        const r = await interceptSetMode(message.mode);
        sendResponse({ ok: r.ok !== false, ...r });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "intercept:action") {
    (async () => {
      const r = await interceptAction(message);
      sendResponse({ ok: r.ok !== false, ...r });
    })();
    return true;
  }
  if (type === "intercept:release_all") {
    (async () => {
      const r = await interceptReleaseAll();
      sendResponse({ ok: true, ...r });
    })();
    return true;
  }

  // === 站点工作区 ===
  if (type === "site:list") {
    (async () => {
      try {
        const sites = await listSites();
        const activeId = await getActiveSiteId();
        sendResponse({ ok: true, sites, activeId });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:create") {
    (async () => {
      try {
        const scope = message.scope || deriveScopeFromUrl(appState.debuggeeUrl);
        const site = await createSite(message.name, message.desc, scope);
        sendResponse({ ok: true, site });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:get") {
    (async () => {
      try { sendResponse({ ok: true, site: await getSite(message.siteId) }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:rename") {
    (async () => {
      try {
        const r = await renameSite(message.siteId, { name: message.name, desc: message.desc, scope: message.scope });
        sendResponse({ ok: r.ok !== false, ...r });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:delete") {
    (async () => {
      try { await deleteSite(message.siteId); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:set_active") {
    (async () => {
      try {
        await setActiveSiteId(message.siteId || null);
        busEmit("site:active", { siteId: message.siteId || null });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:fact_add") {
    (async () => {
      try {
        const r = await addSiteFact(message.siteId, { key: message.key, value: message.value, tags: message.tags });
        sendResponse({ ok: r.ok !== false, ...r });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:fact_remove") {
    (async () => {
      try { await removeSiteFact(message.siteId, message.factId); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:template_add") {
    (async () => {
      try {
        const r = await addSiteTemplate(message.siteId, message.template || {});
        sendResponse({ ok: r.ok !== false, ...r });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "site:template_delete") {
    (async () => {
      try { await deleteSiteTemplate(message.siteId, message.templateId); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // === AI 数据区（侧边栏 AI 模块：会话 / 发现，独立于用户工作区） ===
  if (type === "project:list") {
    (async () => {
      try { sendResponse({ ok: true, projects: await listProjects() }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "project:create") {
    (async () => {
      try { sendResponse({ ok: true, project: await createProject(message.name, message.desc) }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "project:rename") {
    (async () => {
      try {
        const p = await renameProject(message.projectId, message.name);
        sendResponse(p ? { ok: true, project: p } : { ok: false, error: "项目不存在" });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "project:delete") {
    (async () => {
      try { await deleteProject(message.projectId); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:conversation_create") {
    // 新建会话：可绑定项目（绑定后黑板走项目黑板，跨会话共享）
    (async () => {
      try {
        const conv = await createConversation(message.projectId || null, message.title || "新对话");
        sendResponse({ ok: true, conv: { convId: conv.convId, title: conv.title, projectId: conv.projectId } });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:conversation_set_project") {
    // 会话绑定/解绑项目：null = 独立会话（黑板走 AI 全局黑板）
    (async () => {
      try {
        const conv = await getConversation(message.convId);
        if (!conv) return sendResponse({ ok: false, error: "会话不存在" });
        conv.projectId = message.projectId || null;
        conv.updatedAt = Date.now();
        await saveConversation(conv);
        sendResponse({ ok: true, projectId: conv.projectId });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:conversation_set_model") {
    // 会话记忆所用模型（modelId=null → 跟随设置中的默认模型）；下次运行该会话即按此模型调用
    (async () => {
      try {
        const conv = await getConversation(message.convId);
        if (!conv) return sendResponse({ ok: false, error: "会话不存在" });
        const modelId = message.modelId || null;
        if (modelId) {
          const m = await getModelById(modelId);
          if (!m) return sendResponse({ ok: false, error: "模型不存在（请先在设置中添加）" });
        }
        conv.modelId = modelId;
        conv.updatedAt = Date.now();
        await saveConversation(conv);
        sendResponse({ ok: true, modelId });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:conversation_rename") {
    // 重命名会话
    (async () => {
      try {
        const conv = await getConversation(message.convId);
        if (!conv) return sendResponse({ ok: false, error: "会话不存在" });
        const title = String(message.title || "").trim();
        if (!title) return sendResponse({ ok: false, error: "标题不能为空" });
        conv.title = title;
        await saveConversation(conv);
        sendResponse({ ok: true, conv: { convId: conv.convId, title: conv.title, projectId: conv.projectId } });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:conversation_delete") {
    // 删除会话：同时清理该会话沉淀的 AI 发现（AI 全局黑板 + 绑定项目黑板）
    (async () => {
      try {
        const conv = await getConversation(message.convId);
        if (!conv) return sendResponse({ ok: false, error: "会话不存在" });
        await deleteConversation(conv.convId);
        for (const pid of [...new Set([null, conv.projectId || null])]) {
          const list = await listAIFindings(conv.convId, pid);
          for (const f of list) await removeAIFinding(f.key, pid);
        }
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:conversations") {
    // AI 会话列表（任务/聊天，含审计回看）
    (async () => {
      try {
        const convs = await listConversations();
        const detailed = [];
        for (const c of convs) {
          const full = await getConversation(c.convId);
          if (!full) continue;
          detailed.push({
            convId: full.convId, title: full.title,
            type: full.type === "task" ? "task" : "chat",
            projectId: full.projectId || null,
            modelId: full.modelId || null,
            createdAt: full.createdAt, updatedAt: full.updatedAt,
            goal: full.goal || "", msgCount: (full.messages || []).length,
            audit: Array.isArray(full.audit) ? full.audit.slice(-50) : []
          });
        }
        sendResponse({ ok: true, conversations: detailed });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:conversation_detail") {
    // AI 会话详情（选中会话后：黑板/审计/消息回看）
    (async () => {
      try {
        const full = await getConversation(message.convId);
        if (!full) return sendResponse({ ok: false, error: "会话不存在" });
        sendResponse({
          ok: true,
          conversation: {
            convId: full.convId, title: full.title,
            type: full.type === "task" ? "task" : "chat",
            // P1 修复：返回 projectId——前端"黑板"页需据此决定读项目黑板还是 AI 全局黑板（此前缺失 → 绑定项目的会话永远查全局黑板 → 查空）
            projectId: full.projectId || null,
            modelId: full.modelId || null,
            createdAt: full.createdAt, updatedAt: full.updatedAt,
            goal: full.goal || "",
            plan: Array.isArray(full.plan) ? full.plan : [],
            audit: Array.isArray(full.audit) ? full.audit : [],
            events: Array.isArray(full.events) ? full.events : [],
            checkpoint: full.checkpoint ? {
              at: full.checkpoint.at, lastStepDesc: full.checkpoint.lastStepDesc || "",
              goal: full.checkpoint.goal || ""
            } : null,
            messages: Array.isArray(full.messages) ? full.messages : []
          }
        });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:findings") {
    (async () => {
      try { sendResponse({ ok: true, findings: await listAIFindings(message.convId, message.projectId, true, message.category || "all") }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:findings_remove") {
    (async () => {
      try { sendResponse({ ok: true, ...(await removeAIFinding(message.key, message.projectId)) }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // === AI 状态（懒加载隔离 14.5） ===
  if (type === "ai:warm") {
    // 本地空闲保活：1-token 极小请求（面板空闲期定时触发，防 Arc iGPU+Vulkan 空闲唤醒延迟）
    (async () => {
      try { const config = await getLLMConfig(); const ok = await warmLocalModel(config); sendResponse({ ok: !!ok }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:status") {
    (async () => {
      const llmConfig = await getLLMConfig().catch(() => null);
      appState.llmConfigured = !!(llmConfig && llmConfig.baseUrl && llmConfig.apiKey);
      sendResponse({
        ok: true,
        configured: appState.llmConfigured,
        running: taskState.taskRunning,
        paused: taskState.paused,
        lastReply: taskState.lastTaskReply || ""
      });
    })();
    return true;
  }
  if (type === "ai:chat") {
    // 面板 → 流式单轮问答（MVP）
    (async () => {
      try {
        // 会话模型解析：ai:chat 无会话归属 → 按设置中的默认模型（无模型列表时保持原 llmConfig）
        await applyModelForRun(null);
        const config = await getLLMConfig();
        if (!config || !config.baseUrl || !config.apiKey) {
          return sendResponse({ ok: false, error: "未配置 LLM（设置中添加模型并填入 Key 后可用）" });
        }
        taskState.taskRunning = true;
        pushStatus({ status: "running", text: "AI 思考中…" });
        const answer = await runChat(config, String(message.text || ""), (st) => {
          if (st.type === "answer_delta") pushStatus({ status: "answer_delta", text: st.text, round: 0 });
        }, { setAbort: (c) => { taskState.abort = c; }, setPaused: (v) => { taskState.paused = v; } });
        taskState.taskRunning = false;
        taskState.lastTaskReply = answer;
        pushStatus({ status: "done", text: answer });
        sendResponse({ ok: true, answer, configured: true });
      } catch (e) {
        taskState.taskRunning = false;
        pushStatus({ status: "error", text: e.message });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (type === "ai:task") {
    // 面板 → 完整 Agent 引擎（executeTask 内部意图分类：chat 走 runChat，task 走 runAgentLoop）
    // live steering：任务运行中收到新指令 → handleTaskMessage 打断当前 + 排队续跑
    (async () => {
      try {
        // 会话模型解析：该会话记忆的模型（无则默认模型）→ 写入 llmConfig，本次运行全链路（含续跑内轮）生效
        const conv = message.convId ? await getConversation(message.convId).catch(() => null) : null;
        await applyModelForRun(conv ? (conv.modelId || null) : null);
        // 流程事件（思考/工具调用/计划/专家/批准等）与完成信号统一由 pushStatus 广播到面板
        handleTaskMessage(message, sendResponse, null);
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (type === "ai:stop") {
    // 中止当前 AI 调用
    if (taskState.abort) { try { taskState.abort.abort(); } catch (e) {} taskState.abort = null; }
    taskState.paused = true;
    taskState.taskRunning = false;
    pushStatus({ status: "stopped", text: "已停止" });
    sendResponse({ ok: true });
    return true;
  }
  // === AI 批准 / 接管 / 恢复（方案 5.1 / 3.2；静态导入 + 运行时 LLM 配置检查保证工具台隔离可用） ===
  if (type === "ai:approval_result") {
    // 面板批准条 → 批准/拒绝结果回灌 agent（等待闸门）
    (async () => {
      try {
        const r = resolveApproval({ decision: message.decision, approvedCalls: message.approvedCalls || [], reason: message.reason || "" });
        sendResponse(r);
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:takeover") {
    // 接管：abort 当前 AI + paused（用户手动操作；继续后重新侦察续跑）
    (async () => {
      try {
        const r = await pauseTask();
        pushStatus({ status: "stopped", text: "用户已接管（AI 暂停，可手动操作；点「继续」重新侦察后续跑）" });
        sendResponse({ ok: r.ok !== false, ...r });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (type === "ai:resume") {
    // 恢复：重新附加 + 重新侦察页面 → 续跑原任务
    (async () => {
      try {
        const r = await resumeTask();
        sendResponse({ ok: r.ok !== false, ...r });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  sendResponse({ ok: false, error: `未知消息类型: ${type}` });
  return true;
}
