// F12x debugger 模块（重构 v0.2：复用 + 扩展）
// 扩展：来源标记 source / 事件推送（bus）/ Inspect 点选 / 表单侦察 / 拦截（v1）
import { taskState, pushStatus, appState, abortPendingApproval } from "./state.js";
import { busEmit } from "./bus.js";

export let debuggee = null;     // { tabId } → chrome.debugger target
export let debuggeeUrl = null;   // 当前调试页面的 URL
// background 无法给 import 绑定赋值 → 提供 setter（纯搬移附加的最小接口）
export function setDebuggeeUrl(url) { debuggeeUrl = url; }

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

let _attachInFlight = null; // 并发 attach 单飞互斥（审读中：双 attach 并发会让第二个 detach+attach 打断第一个的会话初始化）
export async function debuggerAttach() {
  if (_attachInFlight) return _attachInFlight;
  const run = (async () => {
  const tab = await getActiveTab();
  if (!tab) throw new Error("未找到活动标签页");
  // 幂等：已附加到同一活动 tab 时跳过（拾取→任务等链路会重复调用 attach，
  // 重复 attach 会抛 "Another debugger is already attached"）
  if (appState.attached && debuggee && debuggee.tabId === tab.id) return;
  const prevTabId = debuggee ? debuggee.tabId : null;
  const switching = prevTabId !== null && prevTabId !== tab.id;
  if (switching) {
    // 单 tab 原则（修）：先断开旧会话——否则旧 tab 的请求/日志会继续进同一个缓冲（且拦截队列混在一起）
    try { await chrome.debugger.detach({ tabId: prevTabId }); } catch (e) { /* 已断开则忽略 */ }
    debuggee = null;
    // 先清后回填（修）：原来清缓冲写在历史回填之后，换 tab 时刚回填的历史会被自己清掉
    resetNetworkRequests();
    resetScriptList();
    resetConsoleLogs();
    appState.interceptQueue = [];
    interceptManualPending = false;
    // 通知面板立即清表，避免旧页面请求残留在列表里与新页面混排
    busEmit("network:snapshot", { items: [] });
    busEmit("console:snapshot", { items: [] });
  }
  debuggee = { tabId: tab.id };
  debuggeeUrl = tab.url;
  try {
    await chrome.debugger.attach(debuggee, "1.3");
  } catch (e) {
    // 互斥错误：DevTools 占用 或 本扩展残留会话（SW 重启后 attach 记录残留）
    if (e.message && e.message.includes("Another debugger is already attached")) {
      // 尝试清理可能属于自己的残留会话后重试（DevTools 的会话 detach 会失败，不影响）
      try {
        await chrome.debugger.detach(debuggee);
        await chrome.debugger.attach(debuggee, "1.3");
        console.log("[CDP] 残留会话已清理并重新 attach", tab.id);
      } catch (e2) {
        debuggee = null;
        throw new Error(
          "调试器被占用：该标签页已有其他调试器附加（通常是浏览器 DevTools 已打开，或上次会话残留）。" +
          "请关闭 DevTools 面板后重试；若仍失败，在 chrome://extensions 重新加载扩展。"
        );
      }
    } else {
      debuggee = null;
      throw e;
    }
  }
  // 启用网络和脚本监控
  await sendCDP("Network.enable");
  await sendCDP("Debugger.enable");
  await sendCDP("Runtime.enable"); // console 日志流（Runtime.consoleAPICalled）需要
  try { await sendCDP("DOM.enable"); } catch (e) {} // Inspect 点选需要 DOM 域
  // 功能残缺 P0-2：安装 postData 钩子——页面上下文包装 fetch/XHR 记录请求体
  // （CDP getRequestPostData 对 attach 后请求理论可用但真机未验证——
  // 钩子是浏览器层记录，双保险；新文档经 addScriptToEvaluateOnNewDocument 自动安装）
  await installPostDataHook();
  // 回填历史资源（attach 前页面已加载的请求——Performance API 可见 URL/类型，标记 history）
  // 渗透场景页面初始加载的接口是关键分析对象——不因 attach 时机丢失可见性
  try {
    const r = await sendCDP("Runtime.evaluate", {
      expression: `JSON.stringify(performance.getEntriesByType("resource").slice(-150).map(e => ({ url: e.name, type: e.initiatorType || "resource", duration: Math.round(e.duration || 0), size: e.transferSize || 0 })))`,
      returnByValue: true
    });
    if (r?.result?.value) {
      const entries = JSON.parse(r.result.value);
      for (const e of entries) {
        if (networkRequests.length >= NETWORK_MAX) networkRequests.shift();
        networkRequests.push({
          id: `hist_${Date.now().toString(36)}_${networkRequests.length}`,
          url: e.url, method: null, // P0 修复：performance entry 无 method——不再硬编码 GET（误导过滤）
          type: e.type || "history", timestamp: 0,
          size: e.size || 0, // 功能残缺 P2-4：表达式取了 transferSize 但 push 没存——补上（网络列表显示请求大小）
          requestHeaders: null, postData: null,
          history: true, historyNote: "attach 前已加载的历史请求（无响应体——CDP 不缓存 attach 前响应）"
        });
      }
    }
  } catch (e) { /* 页面上下文不可用时忽略 */ }
  // 换 tab 的清缓冲已在 attach 前完成（见上方 switching 分支）
  console.log("[CDP] Attached to tab", tab.id, tab.url);
  appState.attached = true;
  appState.debuggeeUrl = tab.url;
  busEmit("debugger:attached", { url: tab.url });
  })();
  _attachInFlight = run;
  try { return await run; } finally { if (_attachInFlight === run) _attachInFlight = null; }
}

// 功能残缺 P0-2：页面上下文 postData 钩子——包装 fetch/XHR 记录请求体
// （含 body 的请求才记录——GET 无 body 不占日志；日志上限 200 条防膨胀）
// 新文档经 Page.addScriptToEvaluateOnNewDocument 自动安装（下次导航起）
const POST_HOOK_SOURCE = `(() => {
  if (window.__f12xReqLogInstalled) return;
  window.__f12xReqLogInstalled = true;
  window.__f12xReqLog = window.__f12xReqLog || [];
  const pushLog = (url, method, body) => {
    try {
      if (!body) return;
      window.__f12xReqLog.push({ url: String(url || ""), method: String(method || "GET").toUpperCase(), body: String(body).substring(0, 60000), ts: Date.now() });
      if (window.__f12xReqLog.length > 100) window.__f12xReqLog = window.__f12xReqLog.slice(-100);
    } catch (e) {}
  };
  try {
    const origFetch = window.fetch;
    window.fetch = function(...args) {
      try {
        const u = args[0], opts = args[1] || {};
        const body = opts.body;
        if (body) pushLog(typeof u === "string" ? u : (u && u.url), opts.method || "GET", typeof body === "string" ? body : "[非文本 body]");
      } catch (e) {}
      return origFetch.apply(this, args);
    };
  } catch (e) {}
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__f12xReq = { method, url };
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(body) {
      try {
        if (body && this.__f12xReq) pushLog(this.__f12xReq.url, this.__f12xReq.method, typeof body === "string" ? body : "[非文本 body]");
      } catch (e) {}
      return origSend.call(this, body);
    };
  } catch (e) {}
})();`;

export async function installPostDataHook() {
  if (!debuggee) return;
  try {
    // 当前页面立即安装（attach 时页面已加载——Runtime.evaluate 注入）
    await sendCDP("Runtime.evaluate", { expression: POST_HOOK_SOURCE, returnByValue: false });
  } catch (e) { /* 页面不可达时忽略 */ }
  try {
    // 新文档自动安装（下次导航/刷新起——覆盖导航后的请求）
    await sendCDP("Page.addScriptToEvaluateOnNewDocument", { source: POST_HOOK_SOURCE });
  } catch (e) { /* 已注册或页面不支持时忽略 */ }
}

// 回收页面钩子记录的 postData（get_network_request_detail 兜底 2——按 URL+method 匹配最近一条）
export async function recoverPostDataFromHook(url, method) {
  if (!debuggee) return null;
  try {
    const r = await sendCDP("Runtime.evaluate", {
      expression: `JSON.stringify((window.__f12xReqLog || []).filter(e => e.url === ${JSON.stringify(url)} && (!${JSON.stringify(method)} || e.method === ${JSON.stringify(method)})).slice(-1)[0] || null)`,
      returnByValue: true
    });
    if (r?.result?.value) {
      const hit = JSON.parse(r.result.value);
      return hit?.body || null;
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

export async function debuggerDetach() {
  if (debuggee) {
    const target = debuggee;
    debuggee = null; // 修复#9：先置空再 detach——onDetach 事件到达时 debuggee 已为 null，主动断开不会被误判为意外断开
    try {
      await chrome.debugger.detach(target);
      console.log("[CDP] Detached from tab", target.tabId);
      appState.attached = false;
      appState.inspectMode = false;
      busEmit("debugger:detached", {});
    } catch (e) {
      debuggee = target; // detach 失败恢复状态
      throw e;
    }
  }
}

// 修复#9：意外断开监测（原先无任何 onDetach 监听——目标 tab 被关闭/用户取消调试条后
// debuggee 悬空指向死 tabId，任务在 "No tab with given id" 报错循环中空转烧轮次）
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!debuggee || source.tabId !== debuggee.tabId) return;
  debuggee = null;
  if (taskState.paused) return; // 暂停流程主动 detach（resumeTask 会重新 attach）
  if (!taskState.abort) return; // 无运行中任务（任务结束收尾/手动测试按钮的 detach）
  // 运行中任务的意外断开：推送明确错误并终止任务
  pushStatus({ status: "error", detail: `调试连接断开（${reason || "目标标签页已关闭或调试被取消"}），任务已终止。请重新打开目标页面后重试。` });
  try { taskState.abort.abort(); } catch (e) { /* 忽略 */ }
});

// 启动时清理本扩展可能残留的 attach 会话（SW 重启后浏览器端记录仍在）
// 仅本扩展自己的会话 detach 会成功；DevTools 等外部调试器会失败并被忽略
export async function cleanupStaleDebugger() {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets || []) {
      if (t && t.attached && t.tabId) {
        try {
          await chrome.debugger.detach({ tabId: t.tabId });
          console.log("[CDP] 已清理残留调试会话 tab", t.tabId);
        } catch { /* 非本扩展会话（如 DevTools），忽略 */ }
      }
    }
  } catch { /* getTargets 不可用则跳过 */ }
}

export async function sendCDP(method, params = {}) {
  if (!debuggee) throw new Error("未连接调试器，请先 attach");
  return chrome.debugger.sendCommand(debuggee, method, params);
}

// === 操作可视化：页面内浮条（LLM 每次操作时实时显示"正在做什么"） ===
// 注入 fixed 定位临时元素（顶部居中黑底白字），N 毫秒后自动移除——不污染页面
export async function showPageIndicator(text, duration = 1200) {
  if (!debuggee) return;
  try {
    // F12x 黑白浮条：白底黑字 + 细黑边框（与工具台 UI 一致）；结构 = F12x 标签 + 可读正文
    const displayText = String(text || "").substring(0, 96);
    await sendCDP("Runtime.evaluate", {
      expression: `(() => {
        const old = document.getElementById("f12x-indicator");
        if (old) old.remove();
        const el = document.createElement("div");
        el.id = "f12x-indicator";
        Object.assign(el.style, {
          position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)",
          zIndex: "2147483647", background: "#ffffff", color: "#141414",
          border: "1px solid #141414", borderRadius: "8px",
          fontFamily: "system-ui, sans-serif",
          boxShadow: "0 2px 10px rgba(0,0,0,0.16)",
          pointerEvents: "none", display: "inline-flex", alignItems: "center", gap: "8px",
          maxWidth: "88vw", padding: "4px 6px 4px 4px", transition: "opacity 0.2s"
        });
        const tag = document.createElement("span");
        tag.textContent = "F12x";
        Object.assign(tag.style, { background: "#141414", color: "#fff", fontSize: "11px",
          fontWeight: "600", lineHeight: "1.5", padding: "2px 8px", borderRadius: "5px", flex: "none" });
        const msg = document.createElement("span");
        msg.textContent = ${JSON.stringify(displayText)};
        Object.assign(msg.style, { color: "#141414", fontSize: "12.5px", lineHeight: "1.5",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0" });
        el.append(tag, msg);
        document.documentElement.appendChild(el);
        setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 200); }, ${Math.max(400, duration)});
      })()`
      , returnByValue: false
    });
  } catch (e) { /* 页面不可用（正在导航/已关闭）时静默忽略 */ }
}

// 移除页面内浮条（截图前调用——避免 "F12x: …" 指示条被截进图片）
export async function hidePageIndicator() {
  if (!debuggee) return;
  try {
    await sendCDP("Runtime.evaluate", {
      expression: `(() => { const old = document.getElementById("f12x-indicator"); if (old) old.remove(); return true; })()`,
      returnByValue: false
    });
  } catch (e) { /* 静默忽略 */ }
}

// 审查 2.3：waitForPageLoad 死代码（navigate 已内联 readyState 轮询 + 加载中浮条——
// 此函数无人调用）——删除

// ============================================================
// 工具 1：get_page_skeleton()
// 自适应深度 DOM 骨架提取
// ============================================================

// 容器类元素 → 继续深挖
const CONTAINER_TAGS = new Set([
  "div", "section", "main", "article", "nav", "header",
  "footer", "ul", "ol", "li", "table", "tbody", "tr", "td",
  "form", "fieldset", "body", "html", "span", "p", "h1", "h2",
  "h3", "h4", "h5", "h6", "dl", "dt", "dd", "details", "summary"
]);

// 叶子类元素 → 截断，收集属性
const LEAF_TAGS = new Set([
  "input", "button", "a", "select", "textarea", "img", "link",
  "meta", "br", "hr", "option", "label", "iframe"
]);

// 跳过标签
const SKIP_TAGS = new Set(["noscript", "svg", "path"]); // script/style 保留标签（内容不进骨架）

// 估算 token 数（粗暴算法：1 token ≈ 4 字符）
function estimateTokens(str) {
  return Math.ceil(str.length / 4);
}

function buildSkeleton(node, depth, maxContainerDepth) {
  if (!node) return null;

  const tag = (node.localName || node.nodeName || "").toLowerCase();

  // Document 根节点（#document, nodeType 9）：跳过自身，直接递归子节点
  // （DOM.getDocument 的 root 永远是 #document——此前被"非元素节点"拦截 → 骨架永远为空）
  if (node.nodeType === 9) {
    const docChildren = node.children || node.childNodes;
    const docItems = [];
    for (const child of docChildren || []) {
      const r = buildSkeleton(child, depth, maxContainerDepth);
      if (r) docItems.push(r);
    }
    return docItems.length ? { tag: "#document", children: docItems } : null;
  }

  // 跳过不需要的标签
  if (SKIP_TAGS.has(tag)) return null;

  if (node.nodeType === 3) {
    // 文本节点
    const text = (node.nodeValue || "").trim();
    if (!text) return null;
    // 源码式全量骨架：文本节点不截断（这是用户要看的“前端源码”）
    return text;
  }

  if (node.nodeType !== 1) return null; // 非元素节点跳过

  const item = { tag };

  // 收集属性（CDP DOM.Node.attributes = 扁平数组 [name1, value1, name2, value2...]）
  // P1 修复：属性白名单扩展（渗透/分析关键属性：value/data-*/autocomplete/pattern/maxlength/aria-*）
  if (node.attributes && node.attributes.length) {
    const attrs = [];
    const attrArr = Array.isArray(node.attributes) ? node.attributes : [];
    // 源码式：保留全部属性（不再白名单过滤）
    for (let i = 0; i + 1 < attrArr.length; i += 2) {
      const name = String(attrArr[i] || "");
      const val = String(attrArr[i + 1] || "");
      if (!name) continue;
      attrs.push(`${name}="${val}"`);
    }
    if (attrs.length) item.attrs = attrs;
  }

  // script/style：只保留标签与属性（内容走「脚本」页，避免骨架被源码灌爆）
  if (tag === "script" || tag === "style") { item.text = ""; return item; }

  // 是否有子节点
  const children = node.children || node.childNodes;
  if (!children || !children.length) {
    if (LEAF_TAGS.has(tag)) return item;
    item.text = "";
    return item;
  }

  const isLeaf = LEAF_TAGS.has(tag);
  const isContainer = CONTAINER_TAGS.has(tag);

  if (isLeaf || (!isContainer && depth >= maxContainerDepth)) {
    // 叶子或达到最大深度 → 只收集子文本，不递归
    let text = "";
    for (const child of children) {
      if (child.nodeType === 3) text += (child.nodeValue || "");
    }
    text = text.trim();
    if (text) item.text = text; // 源码式：不截断
    if (children.length > 0) item.childCount = children.length;
    return item;
  }

  // 容器 → 递归子节点
  const childItems = [];
  for (const child of children) {
    if (child.nodeType === 1 && SKIP_TAGS.has((child.localName || child.nodeName || "").toLowerCase())) continue;
    const childResult = buildSkeleton(child, depth + 1, maxContainerDepth);
    if (childResult) childItems.push(childResult);
  }
  if (childItems.length) item.children = childItems;

  // 额外标记：子文本（混合内容）
  if (children.length) {
    let directText = "";
    for (const child of children) {
      if (child.nodeType === 3) directText += (child.nodeValue || "");
    }
    directText = directText.trim();
    if (directText) item.text = directText; // 源码式：不截断
  }

  return item;
}

export async function get_page_skeleton() {
  // 源码式全量骨架：取完整 DOM（depth=-1），不设深度/token/文本上限
  const result = await sendCDP("DOM.getDocument", { depth: -1, pierce: true });

  if (!result || !result.root) {
    return { error: "无法获取 DOM 树" };
  }

  const skeleton = buildSkeleton(result.root, 0, Infinity);
  if (!skeleton) return { error: "DOM 树为空" };

  const json = JSON.stringify(skeleton);
  const tokens = estimateTokens(json);
  // 仅报告体量，绝不截断（上限由用户/模型自行判断）
  return { skeleton, tokens, truncated: false };
}


// ============================================================
// 工具 2：eval_js(code, mode)
// 双模式 JavaScript 执行
// 边界说明：readonly 是行为层限制，防范 LLM 生成的常规代码，
// 不防恶意页面通过原型链恢复或 iframe 绕过。三层防护是组合拳。
// ============================================================

// 跨域外发白名单与静态扫描已按用户决策移除（2026-08-05）
// 守卫机制全部去除，eval_js 回归直接执行模式

// --- eval_js 工具 ---
// 守卫机制已移除（用户决策 2026-08-05）：代码直接执行，支持顶层 await（awaitPromise:true）
// 操作可视化：执行前自动定位代码中的 DOM 操作目标 → 滚动到可视区 + 高亮闪烁（用户实时看到操作位置）
// P2c（方案_v2 §6.2 run_code）：executionWorld 默认 'main'（保留读页面全局变量/调页面函数能力）；
//   'isolated' 可选（需要隔离的场景）；allow_tools 允许脚本内 await __f12x_tools.xxx() 调扩展侧子工具
//   （串行子调度器——binding 桥：页面脚本轮询结果，扩展侧 bindingCalled 事件驱动执行）
export async function eval_js(code, executionWorld = "main", allow_tools = []) {
  await visualizeDomTarget(code);
  const params = { expression: code, returnByValue: true, awaitPromise: true, timeout: 30000 };
  if (executionWorld === "isolated") {
    try {
      const tree = await sendCDP("Page.getFrameTree");
      const frameId = tree?.frameTree?.frame?.id;
      if (frameId) {
        const world = await sendCDP("Page.createIsolatedWorld", { frameId, worldName: "f12x_run_code", grantUniveralAccess: true });
        params.contextId = world?.executionContextId;
      }
    } catch (e) { /* isolated 创建失败 → 回退主 world */ }
  }
  // run_code 子工具桥：注入 __f12x_tools（幂等），脚本内可 await 调扩展侧工具
  let result;
  try {
    if (Array.isArray(allow_tools) && allow_tools.length) {
      await installToolBridge(allow_tools, params.contextId);
    }
    result = await sendCDP("Runtime.evaluate", params);
  } finally {
    deactivateToolBridge(); // 修复（审读高）：eval 结束立即关闭页面→扩展子工具入口，杜绝残留 SSRF 窗口
  }

  if (result.exceptionDetails) {
    return {
      ok: false,
      code: "TOOL_EXECUTION_ERROR",
      error: "JS 执行异常",
      details: result.exceptionDetails.text || result.exceptionDetails.exception?.description,
      result: result.result?.value
    };
  }

  return {
    ok: true,
    value: result.result?.value,
    type: result.result?.type
  };
}

// --- run_code 子工具桥（P2c / 方案 §6.2）---
// 允许名单：侦察/解码/重放类（无交互、无批准需求——eval_js 本身已过 G2 批准）
const RUN_CODE_ALLOWED = [
  "replay_request", "decode_text", "compare_responses", "highlight_element",
  "search_dom", "get_page_skeleton", "get_cookies", "get_console_logs",
  "get_network_requests", "get_network_request_detail", "get_script_list", "get_script_content"
];

const TOOL_BRIDGE_SOURCE = (names) => `(() => {
  if (window.__f12xToolsInstalled) return;
  window.__f12xToolsInstalled = true;
  window.__f12xToolsSeq = 0;
  window.__f12xToolsCall = null;
  window.__f12xToolsResult = null;
  // 页面侧轮询等待扩展写回 window.__f12xToolsResult（25s 上限）
  window.__f12xToolsInvoke = async (name, args) => {
    const id = ++window.__f12xToolsSeq;
    // 通过 binding 通知扩展执行（扩展执行后 evaluate 写回 window.__f12xToolsResult）
    try { window.__f12xTool(JSON.stringify({ id, name, args })); }
    catch (e) { return { ok: false, error: "子工具桥不可用: " + (e.message || e) }; }
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if (window.__f12xToolsResult && window.__f12xToolsResult.id === id) {
        const r = window.__f12xToolsResult;
        window.__f12xToolsResult = null;
        return r.result;
      }
      await new Promise(r => setTimeout(r, 25));
    }
    return { ok: false, error: "子工具调用超时（25s）" };
  };
  window.__f12xTools = {};
  for (const n of ${JSON.stringify(names)}) {
    if (!window.__f12xTools[n]) window.__f12xTools[n] = (a) => window.__f12xToolsInvoke(n, a || {});
  }
})();`;

// 安全门（审读高）：binding 常驻目标且跨导航有效——若不加门，页面任意脚本（导航新站/第三方JS）
// 都能驱动扩展发请求（内网 SSRF）。仅当 eval_js(allow_tools) 显式开启且在活动窗口内、
// 且工具在本次允许名单时才执行；eval 结束即关闭（deactivateToolBridge）
let _bridgeActiveNames = null;
let _bridgeExpiry = 0;
async function installToolBridge(allowed, contextId = null) {
  try { await sendCDP("Runtime.addBinding", { name: "__f12xTool" }); } catch (e) { /* 已存在——幂等忽略 */ }
  _bridgeActiveNames = new Set(allowed);
  _bridgeExpiry = Date.now() + 60000;
  try {
    const params = { expression: TOOL_BRIDGE_SOURCE(allowed), returnByValue: false };
    if (contextId) params.contextId = contextId;
    await sendCDP("Runtime.evaluate", params);
  } catch (e) { /* 注入失败不阻断执行 */ }
}
function deactivateToolBridge() {
  _bridgeActiveNames = null;
  _bridgeExpiry = 0;
}

// binding 事件处理：串行子调度器——在 debugger 内直接分发（允许名单全部是本模块工具，无环）
async function handleToolBinding(payload) {
  // 修复（审读低）：双 JSON.parse 外层恒抛错走 fallback——payload 为单层 JSON 字符串，删冗余
  let call = null;
  try { call = typeof payload === "string" ? JSON.parse(payload) : payload; } catch { return; }
  if (typeof call === "string") { try { call = JSON.parse(call); } catch { return; } }
  if (!call || !call.name) return;
  // 安全门（审读高）：桥未激活（eval 已结束/未开 allow_tools/超 60s 窗口）→ 拒绝
  if (!_bridgeActiveNames || Date.now() > _bridgeExpiry) return;
  if (!_bridgeActiveNames.has(call.name)) {
    try {
      await sendCDP("Runtime.evaluate", {
        expression: `window.__f12xToolsResult = ${JSON.stringify({ id: call.id, result: { ok: false, error: "run_code 不允许调用工具: " + call.name } })}`,
        returnByValue: true
      });
    } catch (e) { /* 忽略 */ }
    return;
  }
  const { name, args } = call;
  let result;
  try {
    switch (name) {
      case "replay_request": result = await replay_request(args || {}); break;
      case "decode_text": result = await decode_text(args || {}); break;
      case "compare_responses": result = await compare_responses(args || {}); break;
      case "highlight_element": result = await highlight_element({ selector: args?.selector }); break;
      case "search_dom": result = await search_dom(args?.selector); break;
      case "get_page_skeleton": result = await get_page_skeleton(); break;
      case "get_cookies": result = await get_cookies(args?.includeValues !== false, args?.urls); break;
      case "get_console_logs": result = await get_console_logs(args?.level, args?.limit); break;
      case "get_network_requests": result = await get_network_requests(args?.filter, args?.limit); break;
      case "get_network_request_detail": result = await get_network_request_detail(args?.id, { offset: args?.offset, limit: args?.limit }); break;
      case "get_script_list": result = await get_script_list(); break;
      case "get_script_content": result = await get_script_content(args?.url, args?.startLine, args?.endLine, args?.grep, args?.limit); break;
      default: result = { ok: false, error: `run_code 不允许调用工具: ${name}` };
    }
  } catch (e) {
    result = { ok: false, error: String(e?.message || e) };
  }
  try {
    await sendCDP("Runtime.evaluate", {
      expression: `window.__f12xToolsResult = ${JSON.stringify({ id: call.id, result })}`,
      returnByValue: true
    });
  } catch (e) { /* 写回失败——页面轮询将超时 */ }
}

// run_code 子工具桥事件入口（P2c）：页面脚本调用 window.__f12xTool(name, payloadJson) → 扩展执行并写回
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Runtime.bindingCalled" && params.name === "__f12xTool") {
    handleToolBinding(params.payload).catch(e => console.warn("[F12xTool] binding 处理失败", e));
  }
});

// 操作可视化：eval_js 执行前注入运行时操作捕获补丁（成熟方案——不依赖选择器正则）
// 包装 click/dispatchEvent(click)/submit/value 写入 → 任意获取方式、变量选择器、
// 多步操作全部自动高亮（运行时捕获元素本身，天然支持）
async function installDomVisualizer() {
  try {
    await sendCDP("Runtime.evaluate", {
      expression: `(() => {
        if (window.__f12xVis) return;
        window.__f12xVis = true;
        const flash = (el) => {
          if (!el || el.nodeType !== 1) return;
          try {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
            // 内联样式（iframe 内元素也生效——主文档 CSS 不穿透 iframe 文档）
            el.setAttribute("data-f12x-hl", "1");
            el.style.outline = "3px solid #ffaa00";
            el.style.outlineOffset = "2px";
            let st = document.getElementById("f12x-hl-style");
            if (!st) { st = document.createElement("style"); st.id = "f12x-hl-style"; document.head.appendChild(st); }
            st.textContent = "[data-f12x-hl]{animation:f12xPulse .8s ease 2!important}@keyframes f12xPulse{0%,100%{outline-color:#ffaa00}50%{outline-color:#ff5500}}";
            clearTimeout(el.__f12xT);
            el.__f12xT = setTimeout(() => {
              el.removeAttribute("data-f12x-hl");
              el.style.outline = "";
              el.style.outlineOffset = "";
              const s2 = document.getElementById("f12x-hl-style");
              if (s2 && !document.querySelector("[data-f12x-hl]")) s2.remove();
            }, 2400);
          } catch (e) {}
        };
        // 运行时捕获：任意 DOM 交互自动高亮（变量选择器/多步操作/任意获取方式）
        const origClick = Element.prototype.click;
        Element.prototype.click = function() { flash(this); return origClick.apply(this, arguments); };
        const origDispatch = Element.prototype.dispatchEvent;
        Element.prototype.dispatchEvent = function(ev) {
          if (ev && (ev.type === "click" || ev.type === "submit")) flash(this);
          return origDispatch.apply(this, arguments);
        };
        const origSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function() { flash(this); return origSubmit.apply(this, arguments); };
        for (const cls of [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement]) {
          const d = Object.getOwnPropertyDescriptor(cls.prototype, "value");
          if (d && d.set) {
            Object.defineProperty(cls.prototype, "value", {
              ...d,
              set: function(v) { flash(this); return d.set.call(this, v); }
            });
          }
        }
        // === 请求可视化：执行窗口内（LLM 的 eval_js 期间）fetch/XHR → 页面浮条 ===
        // 窗口 flag 由 visualizeDomTarget 设置（eval_js 前），3s 自动过期——
        // 页面自身异步请求不标记（零噪音），LLM 发起的请求实时可见
        const showReq = (method, url) => {
          try {
            const old = document.getElementById("f12x-req-indicator");
            if (old) old.remove();
            const el = document.createElement("div");
            el.id = "f12x-req-indicator";
            const u = String(url || "").length > 80 ? String(url).substring(0, 80) + "…" : String(url || "");
            el.textContent = "→ " + method + " " + u;
            Object.assign(el.style, {
              position: "fixed", bottom: "12px", left: "50%", transform: "translateX(-50%)",
              zIndex: "2147483647", background: "rgba(25,60,130,0.92)", color: "#fff",
              padding: "5px 12px", borderRadius: "6px", fontSize: "12px",
              fontFamily: "system-ui, sans-serif", pointerEvents: "none",
              maxWidth: "80vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
            });
            document.documentElement.appendChild(el);
          } catch (e) {}
        };
        const updateReq = (method, url, status) => {
          try {
            const el = document.getElementById("f12x-req-indicator");
            if (el) {
              const u = String(url || "").length > 60 ? String(url).substring(0, 60) + "…" : String(url || "");
              el.textContent = "→ " + method + " " + u + " (" + status + ")";
              setTimeout(() => { const e2 = document.getElementById("f12x-req-indicator"); if (e2) e2.remove(); }, 1500);
            }
          } catch (e) {}
        };
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
          if (window.__f12xReqWindow) {
            const url = typeof input === "string" ? input : (input && input.url) || "";
            const method = ((init && init.method) || (typeof input === "string" ? "GET" : (input && input.method)) || "GET").toUpperCase();
            showReq(method, url);
            return origFetch.apply(this, arguments).then((r) => {
              updateReq(method, url, r.status);
              return r;
            });
          }
          return origFetch.apply(this, arguments);
        };
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__f12xReq = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
          return origOpen.apply(this, arguments);
        };
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(body) {
          if (window.__f12xReqWindow && this.__f12xReq) {
            const req = this.__f12xReq;
            showReq(req.method, req.url);
            this.addEventListener("load", () => updateReq(req.method, req.url, this.status));
          }
          return origSend.apply(this, arguments);
        };
      })()`,
      returnByValue: false
    });
  } catch (e) { /* 注入失败不影响执行 */ }
}

// 操作可视化（v2）：双通道
// ① 运行时捕获补丁（installDomVisualizer）——主文档任意 DOM 操作自动高亮
// ② 正则提取选择器 + 递归查 iframe（同源）——iframe 内元素操作的可视化 fallback
async function visualizeDomTarget(code) {
  await installDomVisualizer();
  // 设置请求可视化窗口（每次 eval_js 前——3s 自动过期；窗口内 fetch/XHR 显示页面浮条）
  try {
    await sendCDP("Runtime.evaluate", {
      expression: "window.__f12xReqWindow = true; setTimeout(() => { window.__f12xReqWindow = false; }, 3000);",
      returnByValue: false
    });
  } catch (e) { /* 忽略 */ }
  try {
    const selectors = [...String(code || "").matchAll(/querySelector(?:All)?\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    if (!selectors.length) return;
    const sel = selectors[0];
    await sendCDP("Runtime.evaluate", {
      expression: `(() => {
        // 主文档 + 同源 iframe 递归查找（iframe 内元素操作的可视化）
        const find = (doc) => {
          try { return doc.querySelector(${JSON.stringify(sel)}); } catch (e) { return null; }
        };
        let el = find(document);
        if (!el) {
          for (const f of document.querySelectorAll("iframe")) {
            try { el = find(f.contentDocument) || el; } catch (e) { /* 跨域 iframe 不可访问 */ }
          }
        }
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        // 内联样式（iframe 内元素也生效）
        el.setAttribute("data-f12x-hl", "1");
        el.style.outline = "3px solid #ffaa00";
        el.style.outlineOffset = "2px";
        let st = document.getElementById("f12x-hl-style");
        if (!st) { st = document.createElement("style"); st.id = "f12x-hl-style"; document.head.appendChild(st); }
        st.textContent = "[data-f12x-hl]{animation:f12xPulse .8s ease 2!important}@keyframes f12xPulse{0%,100%{outline-color:#ffaa00}50%{outline-color:#ff5500}}";
        setTimeout(() => {
          el.removeAttribute("data-f12x-hl");
          el.style.outline = "";
          el.style.outlineOffset = "";
          const s2 = document.getElementById("f12x-hl-style"); if (s2 && !document.querySelector("[data-f12x-hl]")) s2.remove();
        }, 2400);
      })()`,
      returnByValue: false
    });
  } catch (e) { /* 可视化失败不影响执行 */ }
}

// ============================================================
// 工具 3：search_dom(selector)
// CSS 选择器查询，仅返回属性 + 截断文本
// ============================================================

export async function search_dom(selector) {
  if (!selector || typeof selector !== "string") {
    return { error: "selector 参数必填" };
  }

  const result = await sendCDP("DOM.getDocument", { depth: -1 });
  if (!result || !result.root) {
    return { error: "无法获取 DOM" };
  }

  const nodeId = result.root.nodeId;
  const queryResult = await sendCDP("DOM.querySelectorAll", { nodeId, selector });

  if (!queryResult || !queryResult.nodeIds || !queryResult.nodeIds.length) {
    return { items: [], count: 0, message: `选择器 "${selector}" 未匹配任何元素` };
  }

  const items = [];
  for (const nid of queryResult.nodeIds.slice(0, 20)) {
    try {
      const node = await sendCDP("DOM.describeNode", { nodeId: nid, depth: 2 });
      const outer = await sendCDP("DOM.getOuterHTML", { nodeId: nid });
      const html = outer.outerHTML || "";
      items.push({
        tag: node.node.localName,
        nodeName: node.node.nodeName,
        attributes: node.node.attributes || [],
        html: html.length > 500 ? html.substring(0, 500) + "..." : html
      });
    } catch (e) {
      items.push({ error: e.message });
    }
  }

  return { items, count: queryResult.nodeIds.length };
}

// ============================================================
// 工具 4 + 5：网络请求收集
// 精简记录存储，不缓存响应体
// ============================================================

let networkRequests = []; // { id, url, method, status, type, timestamp, requestHeaders, responseHeaders, postData }
const NETWORK_MAX = 2000; // 14.2 定稿：缓冲上限 2000 条 + FIFO 淘汰

// --- 14.2 推送去抖合并：事件先入缓冲，200ms 微批量推送（防表格抖动/闪烁） ---
const netPushNew = new Map();    // requestId -> 首次数据（network:request）
const netPushUpd = new Map();    // requestId -> 变更集合（network:updated）
let netPushTimer = null;

function scheduleNetPush() {
  if (netPushTimer) return;
  netPushTimer = setTimeout(() => {
    netPushTimer = null;
    if (netPushNew.size) {
      for (const data of netPushNew.values()) busEmit("network:request", data);
      netPushNew.clear();
    }
    if (netPushUpd.size) {
      for (const [id, patch] of netPushUpd) busEmit("network:updated", { id, ...patch });
      netPushUpd.clear();
    }
  }, 200);
}
function netPushRequest(data) { netPushNew.set(data.id, data); scheduleNetPush(); }
function netPushUpdate(id, patch) {
  const cur = netPushUpd.get(id) || {};
  netPushUpd.set(id, { ...cur, ...patch });
  scheduleNetPush();
}

// --- 来源标记：用户重放（Repeater/Intruder）发起的请求标记 source:"user" ---
// 页面上下文 fetch 触发的 debugger 事件无调用方信息，用"URL+时间窗"归因（8s 内命中）
const userReqMark = new Map();
function markUserRequest(url) { try { userReqMark.set(new URL(url).href, Date.now()); } catch (e) {} }
function isUserRequest(url) {
  if (!url) return false;
  try {
    const href = new URL(url).href;
    const ts = userReqMark.get(href);
    if (ts != null && Date.now() - ts < 8000) { userReqMark.delete(href); return true; }
  } catch (e) {}
  return false;
}

export function resetNetworkRequests() {
  networkRequests = [];
}

// --- 面板重开回填（方案十二.2 风险对策）：SW 内存快照 + performance 回填 ---
// sidePanel 关闭期间 SW 持续缓冲，重开时通过 hello 拉取快照，避免"数据丢失"假象
export function networkSnapshot() {
  return networkRequests.map(r => ({
    id: r.id, url: r.url, method: r.method, type: r.type || "unknown",
    timestamp: r.timestamp, status: r.status, mimeType: r.mimeType, source: r.source || "page"
  }));
}
export function consoleSnapshot() {
  return consoleLogs.map(c => ({ ...c }));
}
// performance 回填：SW 内存已清空（SW 重启）时，从页面 Performance API 恢复最近请求
export async function backfillFromPerformance() {
  try {
    if (networkRequests.length) return; // 内存有数据无需回填
    const r = await sendCDP("Runtime.evaluate", {
      expression: `(() => { try { return performance.getEntriesByType("resource").slice(-100).map(e => ({ url: e.name, initiatorType: e.initiatorType, startTime: e.startTime, duration: e.duration })); } catch (e) { return []; } })()`,
      returnByValue: true
    });
    const entries = (r?.result?.value) || [];
    const now = Date.now();
    for (const e of entries) {
      networkRequests.push({
        id: "perf_" + e.startTime, url: e.url, method: "GET", type: e.initiatorType || "resource",
        timestamp: Math.max(0, (now - e.duration - e.startTime) / 1000), source: "page",
        requestHeaders: null, postData: null, status: null, mimeType: null
      });
    }
    if (networkRequests.length > NETWORK_MAX) networkRequests = networkRequests.slice(-NETWORK_MAX);
  } catch (e) { /* 无 debugger 附加等场景静默 */ }
}

// 元数据搜索（方案九.4 v1：URL/请求头/响应头，内存过滤）
export function metadataSearch(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  const hit = (s) => s != null && String(s).toLowerCase().includes(q);
  const ids = [];
  for (const r of networkRequests) {
    let m = hit(r.url);
    if (!m && r.requestHeaders) m = Object.values(r.requestHeaders).some(hit);
    if (!m && r.responseHeaders) m = Object.values(r.responseHeaders).some(hit);
    if (!m && r.postData) m = hit(r.postData);
    if (m) ids.push(r.id);
  }
  return ids;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  // 只处理当前 debuggee 的事件：多 tab 会话并存时（历史残留/外部 attach）不得混入别人的流量
  if (!debuggee || source.tabId !== debuggee.tabId) return;
  if (method === "Network.requestWillBeSent") {
    // M6: 上限裁切
    if (networkRequests.length >= NETWORK_MAX) {
      networkRequests.shift();
    }
    const userSrc = isUserRequest(params.request.url);
    networkRequests.push({
      id: params.requestId,
      url: params.request.url,
      method: params.request.method,
      type: params.type || "unknown",
      timestamp: params.timestamp,
      // 请求详情补全（对标 F12 Network）：请求头 + POST payload 事件参数直接携带
      requestHeaders: params.request.headers || null,
      postData: params.request.postData || null,
      source: userSrc ? "user" : "page" // v0.2 来源标记：user(用户重放) / page(页面自然请求)
    });
    // 14.2 去抖合并推送（200ms 微批量）
    netPushRequest({
      id: params.requestId, url: params.request.url,
      method: params.request.method, type: params.type || "unknown",
      timestamp: params.timestamp, source: userSrc ? "user" : "page"
    });
  }

  if (method === "Network.responseReceived") {
    const req = networkRequests.find(r => r.id === params.requestId);
    if (req) {
      req.status = params.response.status;
      req.mimeType = params.response.mimeType;
      // 请求详情补全：响应头（Set-Cookie/Content-Type/Server 等）
      req.responseHeaders = params.response.headers || null;
      netPushUpdate(params.requestId, { status: params.response.status, mimeType: params.response.mimeType });
    }
  }

  // P0 修复：requestWillBeSentExtraInfo 携带完整请求头（含 Cookie 等 wire 头）
  // ——requestWillBeSent 的头可能不含完整 cookie；补全提升请求详情可信度
  if (method === "Network.requestWillBeSentExtraInfo") {
    const req = networkRequests.find(r => r.id === params.requestId);
    if (req && params.headers) {
      req.requestHeaders = req.requestHeaders
        ? { ...params.headers, ...req.requestHeaders } // ExtraInfo 更全——优先保留事件头，ExtraInfo 补齐
        : params.headers;
    }
  }

  // P0 修复：responseReceivedExtraInfo 携带完整响应头（Set-Cookie 常在此）
  // ——responseReceived 的头可能不含 set-cookie；补全会话分析所需
  if (method === "Network.responseReceivedExtraInfo") {
    const req = networkRequests.find(r => r.id === params.requestId);
    if (req && params.headers) {
      req.responseHeaders = req.responseHeaders
        ? { ...req.responseHeaders, ...params.headers }
        : params.headers;
    }
  }

  // === console 日志流（对标 F12 Console 面板）：Runtime.consoleAPICalled 事件收集 ===
  // 页面 console.log/warn/error/info 实时收集，模型用 get_console_logs 按需读取
  if (method === "Runtime.consoleAPICalled") {
    if (consoleLogs.length >= CONSOLE_MAX) consoleLogs.shift();
    const args = (params.args || []).map(a => {
      if (a.value !== undefined) return String(a.value);
      if (a.description) return a.description.substring(0, 200);
      return String(a.type || "");
    }).join(" ");
    consoleLogs.push({
      ts: Date.now(),
      level: params.type || "log", // log/warning/error/info/debug
      text: (args || "").substring(0, 2000) // 火力全开：500 → 2000
    });
    busEmit("console:log", { ts: Date.now(), level: params.type || "log", text: (args || "").substring(0, 2000) });
  }
  // 未捕获异常（console 之外的重要错误源）
  if (method === "Runtime.exceptionThrown") {
    if (consoleLogs.length >= CONSOLE_MAX) consoleLogs.shift();
    const d = params.exceptionDetails;
    const text = `Uncaught ${d?.exception?.description || d?.text || "error"}`.substring(0, 2000); // 火力全开：500 → 2000
    consoleLogs.push({ ts: Date.now(), level: "exception", text });
    busEmit("console:log", { ts: Date.now(), level: "exception", text });
  }
});

// console 日志存储（上限 200 条，F12 Console 面板的等价物）
let consoleLogs = [];
const CONSOLE_MAX = 200;
export function resetConsoleLogs() {
  consoleLogs = [];
}

// 工具：获取页面 console 日志（按级别过滤，最近 N 条）
export async function get_console_logs(level, limit = 50) {
  let results = [...consoleLogs];
  if (level) {
    results = results.filter(l => l.level === level || (level === "error" && (l.level === "error" || l.level === "exception")));
  }
  const total = results.length;
  return {
    total,
    returned: Math.min(results.length, limit),
    items: results.slice(-limit),
    hint: total > limit ? `共 ${total} 条，返回最近 ${limit} 条` : undefined
  };
}

export async function get_network_requests(filter, limit = 50) {
  let results = [...networkRequests];

  if (filter) {
    if (filter.url_pattern) {
      try {
        const pattern = new RegExp(filter.url_pattern, "i");
        results = results.filter(r => pattern.test(r.url));
      } catch (e) {
        return { error: `url_pattern 不是合法的正则表达式: ${e.message}` };
      }
    }
    if (filter.method) {
      // 审查 1.1：hist_ 条目 method 为 null（attach 前回填）——空值过滤必崩
      results = results.filter(r => (r.method || "").toUpperCase() === filter.method.toUpperCase());
    }
    if (filter.status !== undefined) {
      results = results.filter(r => r.status === filter.status);
    }
    if (filter.domain) {
      results = results.filter(r => {
        try { return new URL(r.url).hostname.includes(filter.domain); } catch { return false; }
      });
    }
    if (filter.resource_type) {
      results = results.filter(r => r.type === filter.resource_type);
    }
  }

  const total = results.length;
  // 第二轮审查 P2-4：取最新 N 条（原 slice(0,limit) 返回最旧——与 get_console_logs 的
  // slice(-limit) 语义不一致——模型想看"最近的请求"拿到的是最早的一批）
  const returned = results.slice(-limit);

  return {
    total,
    returned: returned.length,
    items: returned,
    hint: total > returned.length
      ? `共 ${total} 条匹配，已返回最近 ${returned.length} 条。请使用 filter 缩小范围或确认查看更多。`
      : undefined
  };
}

export async function get_network_request_detail(id, opts = {}) {
  // P1 修复：支持 offset/limit 分段读取响应体（大 JSON 响应——敏感字段可能在截断点后）
  const { offset = 0, limit = 3000 } = opts || {};
  const req = networkRequests.find(r => r.id === id);
  if (!req) return { error: "未找到该请求（id 可能已过期——列表刷新后请求记录会被清除）" };
  // P0 修复：历史请求（attach 前）——CDP 不缓存其响应体，明确标注而非假装有
  if (req.history) {
    return {
      url: req.url, method: req.method || null, status: null, history: true,
      historyNote: req.historyNote || "attach 前已加载的历史请求——CDP 不缓存 attach 前响应，无法获取响应体。如需响应，请刷新页面重新采集。",
      requestHeaders: req.requestHeaders || null, postData: req.postData || null
    };
  }
  try {
    const result = await sendCDP("Network.getResponseBody", { requestId: id });
    // P0 修复：postData 兜底——requestWillBeSent 的 postData 可能为空，
    // 用 Network.getRequestPostData 命令按 requestId 精确获取（CDP 官方方案）
    let postData = req?.postData || null;
    if (!postData) {
      try {
        const pd = await sendCDP("Network.getRequestPostData", { requestId: id });
        if (pd?.postData) postData = pd.postData;
      } catch (e) { /* 无 postData（GET 等）或不可用——保持 null */ }
    }
    // 功能残缺 P0-2：钩子回收兜底（attach 后请求的 body 由页面钩子记录——
    // getRequestPostData 真机未验证，钩子是浏览器层双保险）
    if (!postData) {
      postData = await recoverPostDataFromHook(req.url, req.method);
    }
    const body = result.body || "";
    const total = body.length;
    const sliced = offset > 0 || total > limit ? body.substring(offset, offset + limit) + (offset + limit < total ? "..." : "") : body;
    return {
      // 请求详情补全（对标 F12 Network 面板信息模型）：请求行/请求头/payload/响应头/响应体
      url: req?.url,
      method: req?.method,
      status: req?.status,
      mimeType: req?.mimeType,
      requestHeaders: req?.requestHeaders || null,
      postData,
      responseHeaders: req?.responseHeaders || null,
      body: sliced,
      bodyTotal: total, // P1：告知总长度（模型判断是否需 offset 续读）
      offset, limit,
      base64Encoded: result.base64Encoded || false
    };
  } catch (e) {
    // 响应体获取失败也返回已收集的头信息（不全丢）
    if (req) {
      return {
        url: req.url, method: req.method, status: req.status,
        requestHeaders: req.requestHeaders || null,
        postData: req.postData || null,
        responseHeaders: req.responseHeaders || null,
        error: `无法获取响应体: ${e.message}`
      };
    }
    return { error: `无法获取响应体: ${e.message}` };
  }
}

// ============================================================
// 工具 6：get_cookies(includeValues, urls)
// Cookie 信息（默认不含 value）
// ============================================================

export async function get_cookies(includeValues, urls) {
  // 第二轮审查 P2-3：urls 空数组是 truthy——原跳过 debuggeeUrl 回落返回"未提供 URL"
  let cookieUrls = urls && urls.length ? urls : null;
  if (!cookieUrls && debuggee && debuggeeUrl) {
    cookieUrls = [debuggeeUrl];
  }
  if (!cookieUrls || !cookieUrls.length) {
    return { error: "未提供 URL" };
  }

  const cookies = await sendCDP("Network.getCookies", { urls: cookieUrls });

  if (!cookies || !cookies.cookies) {
    return { cookies: [], count: 0 };
  }

  const items = cookies.cookies.map(c => {
    const item = {
      name: c.name,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly || false,
      secure: c.secure || false,
      sameSite: c.sameSite || "unspecified",
      expires: c.expires || 0
    };
    // 火力全开：默认返回明文 value（includeValues 显式传 false 才隐藏）
    if (includeValues !== false) {
      item.value = c.value;
    }
    return item;
  });

  return { cookies: items, count: items.length, hasValues: includeValues !== false };
}

// ============================================================
// 工具 7 + 8：脚本收集
// 实施验证点：实测 Debugger.enable 是否补发已加载脚本的 scriptParsed
// ============================================================

let scriptList = []; // { scriptId, url, startLine, endLine }

export function resetScriptList() {
  scriptList = [];
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!debuggee || source.tabId !== debuggee.tabId) return; // 同上：只认当前会话
  if (method === "Debugger.scriptParsed") {
    scriptList.push({
      scriptId: params.scriptId,
      url: params.url,
      startLine: params.startLine || 0,
      endLine: params.endLine || 0
    });
    busEmit("script:parsed", { url: params.url, lines: (params.endLine || 0) - (params.startLine || 0) + 1 });
  }

  // === v0.2 Inspect 点选：Overlay.inspectNodeRequested ===
  if (method === "Overlay.inspectNodeRequested") {
    handleInspectNode(params.backendNodeId).catch(() => {});
  }

  // === v0.2 拦截（v1）：Fetch.requestPaused ===
  if (method === "Fetch.requestPaused") {
    handleRequestPaused(params).catch(() => {});
  }
});

export async function get_script_list() {
  return {
    scripts: scriptList.map(s => ({
      scriptId: s.scriptId,
      url: s.url,
      lines: s.endLine - s.startLine + 1
    })),
    count: scriptList.length
  };
}

export async function get_script_content(url, startLine, endLine, grep, limit) {
  const script = scriptList.find(s => s.url === url);
  if (!script) {
    const matches = scriptList.filter(s => s.url && s.url.includes(url));
    if (matches.length === 0) {
      return { error: `未找到脚本: ${url}`, available: scriptList.map(s => s.url) };
    }
    if (matches.length > 1) {
      return { error: `找到 ${matches.length} 个匹配，请用完整 URL`, matches: matches.map(s => s.url) };
    }
    // 第二轮审查 P2-5：模糊匹配递归必须透传 limit（原丢第 5 参——grepLimit 回退 20）
    return get_script_content(matches[0].url, startLine, endLine, grep, limit);
  }

  try {
    const result = await sendCDP("Debugger.getScriptSource", { scriptId: script.scriptId });
    let source = result.scriptSource || "";

    if (startLine !== undefined && endLine !== undefined) {
      const lines = source.split("\n");
      source = lines.slice(startLine, endLine + 1).join("\n");
    } else if (startLine !== undefined) {
      const lines = source.split("\n");
      source = lines.slice(startLine).join("\n");
    }

    if (grep) {
      // P1 修复：grep 匹配上限（默认 20 处，每处 5 行上下文——防 token 失控）
      // 第二轮审查 P1-4：去掉 g 标志——带 g 的 RegExp.test() 跨行 lastIndex 残留，
      // 连续相同行 true/false 交替（漏报/错报）
      const grepLimit = arguments[4] !== undefined ? arguments[4] : 20;
      const pattern = new RegExp(grep, "i");
      const lines = source.split("\n");
      const matched = [];
      for (let i = 0; i < lines.length && matched.length < grepLimit; i++) {
        if (pattern.test(lines[i])) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length - 1, i + 2);
          matched.push({
            line: i + 1,
            context: lines.slice(start, end + 1).map((l, idx) => `${start + idx + 1}: ${l}`)
          });
        }
      }
      return {
        url: script.url,
        grep,
        matches: matched,
        totalLines: source.split("\n").length,
        truncated: matched.length >= grepLimit,
        note: `匹配上限 ${grepLimit} 处（可传 limit 提高）`
      };
    }

    // P1 修复：按行截断（不再切在字符中间）+ 内存守卫（超大脚本拒绝）
    if (source.length > 10 * 1024 * 1024) {
      return { error: `脚本过大（${(source.length / 1024 / 1024).toFixed(1)}MB）——拒绝加载，请用 grep 定向提取` };
    }
    // 火力全开：默认加载上限 5000 → 500000（完整源码优先，模型按需 grep/区间）
    if (source.length > 500000 && !startLine && !endLine && !grep) {
      const lines = source.split("\n");
      let cut = 0, charCount = 0;
      while (cut < lines.length && charCount + lines[cut].length + 1 <= 500000) {
        charCount += lines[cut].length + 1; cut++;
      }
      source = lines.slice(0, cut).join("\n") + `\n// ... 按行截断 (共 ${lines.length} 行 / ${source.length} 字符)，用 startLine/endLine 取区间`;
    }

    return {
      url: script.url,
      content: source,
      length: source.length,
      lines: source.split("\n").length
    };
  } catch (e) {
    return { error: `获取脚本内容失败: ${e.message}` };
  }
}

// ============================================================
// 工具 9：navigate(url)
// 统一导航入口：URL 规范化 → 内部页走 tabs / 普通页走 CDP（拒绝时降级 tabs）
// ============================================================

function isExternalUrl(url) {
  try {
    const target = new URL(url);
    if (!debuggee || !debuggeeUrl) return true;
    return target.origin !== new URL(debuggeeUrl).origin;
  } catch {
    return true;
  }
}

// 浏览器内部/特殊协议页：debugger 无法附加与导航（CDP 会报 "Cannot access a chrome:// URL"）
const INTERNAL_SCHEME_RE = /^(chrome|chrome-extension|edge|about|devtools|view-source|vivaldi|opera|file):/i;

// URL 规范化：去空白/包装引号；无协议时按域名/localhost/IP 自动补 https（模型常漏协议）
function normalizeNavUrl(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  if (!s) return { ok: false, error: "URL 为空" };
  if (/^(https?|chrome|chrome-extension|edge|about|devtools|view-source|file|data|blob):/i.test(s)) {
    return { ok: true, url: s };
  }
  if (/^(localhost|127\.0\.0\.1|\d{1,3}(\.\d{1,3}){3}|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(s)) {
    return { ok: true, url: "https://" + s };
  }
  return { ok: false, error: `无法识别的 URL：${raw}（请提供完整网址，如 https://example.com）` };
}


// 导航兜底壳：任何内部异常都回传真实原因，杜绝“{ok:false} 无 error”静默失败
export async function navigate(url) {
  try {
    const r = await navigateInner(url);
    if (r && r.ok === false && (r.error === undefined || r.error === "")) {
      return { ok: false, error: "navigate 返回失败但无原因（内部分支遗漏 error）" };
    }
    return r;
  } catch (e) {
    return { ok: false, error: "navigate 内部异常: " + String((e && e.stack) || e || "").substring(0, 400) };
  }
}

// 内部页导航：debugger 无法调试内部页——先 detach，再用 tabs API 在当前调试标签页直接打开
async function openInternalTab(url) {
  let targetTabId = null;
  try {
    if (debuggee) targetTabId = debuggee.tabId;
    else {
      const t = await getActiveTab();
      if (t) targetTabId = t.id;
    }
  } catch (e) { /* 忽略 */ }
  if (targetTabId == null) return { ok: false, error: "未找到可打开的标签页" };
  await debuggerDetach().catch(() => {});
  try {
    await chrome.tabs.update(targetTabId, { url });
  } catch (e) {
    return { ok: false, error: `无法打开浏览器内部页（${String((e && e.message) || e)}）` };
  }
  setDebuggeeUrl(url);
  return { ok: true, url, internal: true, note: "已用浏览器标签直接打开（内部页不支持调试）" };
}

async function navigateInner(url) {
  if (!url || typeof url !== "string") {
    return { ok: false, error: "URL 参数必填" };
  }
  // 修复（审读高）：navigate 显式拒绝 javascript: URL——CDP Page.navigate 可执行任意页面代码，
  // 原放行形成对 eval_js 包装/审批门的绕过
  if (/^\s*javascript:/i.test(url)) {
    return { ok: false, error: "导航不支持 javascript: URL——请使用受批准门约束的 eval_js 执行代码" };
  }

  const norm = normalizeNavUrl(url);
  if (!norm.ok) return norm; // {ok:false, error}
  url = norm.url;

  // 浏览器内部/特殊协议页 → 不走 CDP（否则报 Cannot access a chrome:// URL）
  if (INTERNAL_SCHEME_RE.test(url)) return openInternalTab(url);

  // 未附加调试器 → 自动附加当前活动标签页（手动导航/任务入口均依赖 CDP 导航）
  if (!debuggee) {
    try { await debuggerAttach(); }
    catch (e) {
      return { ok: false, error: `未连接调试器，无法导航（${String((e && e.message) || e)}）。请先切换到普通网页再让 AI 打开目标网站。` };
    }
  }

  const external = isExternalUrl(url);

  // 导航可视化（用户实时可见——探测新目录/跳转新站点页面即时反馈）：
  // 同站导航（目录探测 /admin /api 等）→ "→ 探测 /admin"
  // 跨站跳转 → "→ 跳转 https://other.com"
  await showNavIndicator(`→ ${external ? "跳转" : "探测"} ${url}`);
  resetNetworkRequests();
  resetScriptList();
  resetConsoleLogs();
  try {
    await sendCDP("Page.navigate", { url });
  } catch (e) {
    // CDP 导航被浏览器拒绝（安全限制 / 目标页面受保护）→ 降级：detach 后用 tabs API 直接打开
    const m = String((e && (e.message || e)) || "");
    clearNavIndicator();
    const tabId = debuggee ? debuggee.tabId : null;
    try {
      await debuggerDetach().catch(() => {});
      if (tabId == null) throw new Error("no tab");
      await chrome.tabs.update(tabId, { url });
      setDebuggeeUrl(url);
      return { ok: true, url, status: "navigated", viaTabs: true, note: `CDP 导航被拒（${m}），已改用浏览器标签直接打开` };
    } catch (e2) {
      return { ok: false, error: `页面导航被浏览器拒绝：${m}` };
    }
  }
  // 加载中可视化 + 加载等待（第二轮审查 P1-6 修复）：
  // ① 首次查询前延迟 400ms——Page.navigate 发出后立即查 readyState 极可能
  //    命中旧文档的 "complete"（竞态 → "✓ 已到达"提前显示）
  // ② 轮询带总超时 15s——超时返回 {ok:false}（原 10s 退出循环仍返回 ok:true——
  //    模型收到假成功信号继续分析）
  await new Promise(r => setTimeout(r, 400));
  const navStart = Date.now();
  let navOk = false;
  while (Date.now() - navStart < 15000) {
    try {
      const r = await sendCDP("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (r?.result?.value === "complete") { navOk = true; break; }
      await showNavIndicator(`→ 正在导航 ${url}`);
    } catch (e) { /* 页面未就绪——重试 */ }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!navOk) {
    clearNavIndicator();
    return { ok: false, error: `导航后 15s 内页面未加载完成（readyState 未达 complete）——可能死链/跳转环/仅 websocket 页面` };
  }
  setDebuggeeUrl(url);
  // 新页面加载完成：更新浮条为已到达（新文档上下文重新注入）——1.8s 后自动消失
  await showNavIndicator(`✓ 已到达 ${url}`);
  setTimeout(() => clearNavIndicator(), 2600);
  return { ok: true, url, external: false };
}

// ============================================================
// 导航可视化浮条（页面注入——持续显示直到加载完成）
// LLM 探测新目录 / 跳转新站点时，目标页面实时可见导航过程
// ============================================================
export async function showNavIndicator(text) {
  try {
    // F12x 黑白导航浮条（与工具台 UI 一致）：F12x 标签 + 可读动作正文，白底黑字细黑边框
    const displayText = String(text || "").substring(0, 170);
    await sendCDP("Runtime.evaluate", {
      expression: `(() => {
        let el = document.getElementById("f12x-nav-indicator");
        if (!el) {
          el = document.createElement("div");
          el.id = "f12x-nav-indicator";
          Object.assign(el.style, {
            position: "fixed", top: "8px", left: "50%", transform: "translateX(-50%)",
            zIndex: "2147483647", background: "#ffffff", color: "#141414",
            border: "1px solid #141414", borderRadius: "8px",
            fontFamily: "system-ui, sans-serif", pointerEvents: "none",
            display: "inline-flex", alignItems: "center", gap: "8px",
            maxWidth: "90vw", padding: "5px 8px 5px 5px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
            overflow: "hidden"
          });
          document.documentElement.appendChild(el);
        }
        el.innerHTML = "";
        const tag = document.createElement("span");
        tag.textContent = "F12x";
        Object.assign(tag.style, { background: "#141414", color: "#fff", fontSize: "11px",
          fontWeight: "600", lineHeight: "1.5", padding: "2px 8px", borderRadius: "5px", flex: "none" });
        const msg = document.createElement("span");
        msg.textContent = ${JSON.stringify(displayText)};
        Object.assign(msg.style, { color: "#141414", fontSize: "12.5px", lineHeight: "1.5",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0" });
        el.append(tag, msg);
      })()`
      , returnByValue: false
    });
  } catch (e) { /* 页面不可达时静默 */ }
}

export async function clearNavIndicator() {
  try {
    await sendCDP("Runtime.evaluate", {
      expression: `(() => { const el = document.getElementById("f12x-nav-indicator"); if (el) el.remove(); })()`,
      returnByValue: false
    });
  } catch (e) { /* 静默 */ }
}

// ============================================================
// 工具 9：replay_request（对标 F12"编辑重发"/Burp Repeater）
// 扩展级 fetch（host_permissions <all_urls>）→ 不受页面 CORS 限制，跨域可用
// ============================================================
export async function replay_request({ url, method = "GET", headers = {}, body = null }) {
  if (!url || typeof url !== "string") return { error: "url 必填" };
  markUserRequest(url); // 来源标记：本次重放产生的页面请求记为 source:"user"
  // 功能残缺 P0-1：Cookie 是 Fetch 规范 forbidden header name——
  // 扩展 fetch 手动设置的 Cookie 头被静默丢弃（原 cookies.getAll 拼头从未生效）。
  // 正解：同源重放在【页面上下文】执行 fetch（credentials:"include"）——
  // 浏览器网络栈自动带该域全部 Cookie（含 httpOnly），绕开 forbidden header。
  // 跨域/未 attach 时 fallback 扩展 fetch（无会话——诚实标注）。
  const sameOrigin = debuggee && debuggeeUrl
    ? (() => { try { return new URL(url).origin === new URL(debuggeeUrl).origin; } catch { return false; } })()
    : false;
  let pageError = ""; // 页面上下文失败原因（非空 → 已回退扩展 fetch，结果里如实标注）
  if (sameOrigin) {
    try {
      // 功能残缺 P1-4：Set-Cookie 是 forbidden response header（resp.headers 读不到）——
      // 替代：重放前后对比该域 Cookie（会话注入可见——登录成功/会话刷新可推断）
      let beforeCookies = {};
      try {
        const target = new URL(url);
        const cks = await chrome.cookies.getAll({ url: target.origin });
        for (const c of cks) beforeCookies[c.name] = c.value;
      } catch (e) { /* 忽略 */ }
      // 15s 超时必须写在【页面上下文内部】：外层 AbortController 管不到页面里的 fetch
      const expr = `(async () => {
        const ctl = new AbortController();
        // 12s：给外层 dispatchTool 的 30s 工具超时留出"超时→回退扩展 fetch"的余量
        const timer = setTimeout(() => ctl.abort(), 12000);
        try {
          const r = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(String(method).toUpperCase())},
            headers: ${JSON.stringify(headers || {})},
            body: ${body !== null ? JSON.stringify(String(body)) : "undefined"},
            credentials: "include",
            redirect: "follow",
            signal: ctl.signal
          });
          const t = await r.text();
          const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
          return JSON.stringify({ status: r.status, statusText: r.statusText, responseHeaders: h, body: t.substring(0, 500000), redirected: r.redirected, finalUrl: r.url, session: true });
        } catch (e) {
          const aborted = !!(e && (e.name === "AbortError" || /abort/i.test(String(e && e.message))));
          return JSON.stringify({ fetchError: aborted ? "页面上下文请求超时（12s）" : String(e && e.message || e) });
        } finally { clearTimeout(timer); }
      })()`;
      const res = await sendCDP("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (res?.result?.value) {
        const parsed = JSON.parse(res.result.value);
        if (parsed.fetchError) pageError = parsed.fetchError;
        else {
          if (parsed.body.length > 500000) parsed.body = parsed.body.substring(0, 500000) + "...";
          // 重放后对比 Cookie——Set-Cookie 盲区的替代证据（会话变化可推断）
          let cookieChanges = null;
          try {
            const target = new URL(url);
            const cks = await chrome.cookies.getAll({ url: target.origin });
            const after = {};
            for (const c of cks) after[c.name] = c.value;
            const changed = [];
            for (const name of new Set([...Object.keys(beforeCookies), ...Object.keys(after)])) {
              if (beforeCookies[name] !== after[name]) {
                changed.push(`${name}${after[name] !== undefined ? "=已更新" : "=已删除"}${beforeCookies[name] !== undefined && after[name] !== undefined ? `（${beforeCookies[name].substring(0, 8)}… → ${after[name].substring(0, 8)}…）` : ""}`);
              }
            }
            if (changed.length) cookieChanges = changed;
          } catch (e) { /* 忽略 */ }
          return { ok: true, status: parsed.status, statusText: parsed.statusText, responseHeaders: parsed.responseHeaders, body: parsed.body, viaPage: true, session: "同源会话 Cookie（含 httpOnly）", cookieChanges, note: cookieChanges ? `重放改变了 ${cookieChanges.length} 个 Cookie（会话注入可见——Set-Cookie 是 forbidden response header 读不到，此为替代证据）：${cookieChanges.join("；")}` : "重放未改变会话 Cookie（无新会话注入）" };
        }
      } else pageError = "页面上下文无返回（页面可能已导航/关闭）";
    } catch (e) {
      pageError = String((e && (e.message || e)) || e);
    }
  }
  // === fallback：扩展 fetch（跨域 / 页面不可达）——无 Cookie（如实标注） ===
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, {
      method: String(method).toUpperCase(),
      headers: { ...(headers || {}) },
      body: body !== null ? String(body) : undefined,
      redirect: "manual", // 跳转链本身是攻击面（开放重定向/SSRF 探测）——3xx 可见
      signal: controller.signal
    });
    clearTimeout(timer);
    let respBody = "";
    try {
      respBody = await resp.text();
      if (respBody.length > 500000) respBody = respBody.substring(0, 500000) + "...";
    } catch (e) { respBody = `[读取响应体失败: ${e.message}]`; }
    const respHeaders = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    const result = {
      ok: true,
      status: resp.status,
      statusText: resp.statusText,
      responseHeaders: respHeaders,
      body: respBody,
      viaPage: false,
      note: `扩展级 fetch（${pageError ? "页面上下文失败：" + pageError + "；已回退" : "跨域 / 页面不可达"}）——未带会话 Cookie（浏览器 forbidden header 限制；跨域会话在浏览器内不可实现）。同源重放请确认页面已 attach。`
    };
    if (resp.status >= 300 && resp.status < 400) {
      result.redirected = true;
      result.note += ` 检测到 ${resp.status} 跳转（manual 模式未跟随）——Location 头见 responseHeaders。`;
    }
    return result;
  } catch (e) {
    return { error: `请求失败: ${e.message}` };
  }
}

// ============================================================
// 工具 10：highlight_element（对标 F12 Elements 悬停高亮）
// Overlay.highlightNode——高亮页面元素（操作可视化）
// ============================================================
export async function highlight_element({ selector }) {
  if (!selector || typeof selector !== "string") return { error: "selector 必填" };
  try {
    await sendCDP("Overlay.enable");
    const doc = await sendCDP("DOM.getDocument", { depth: -1, pierce: true });
    if (!doc?.root?.nodeId) return { error: "无法获取 DOM 文档" };
    const q = await sendCDP("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!q?.nodeId || q.nodeId === 0) return { error: `选择器未匹配到元素: ${selector}` };
    await sendCDP("Overlay.highlightNode", {
      highlightConfig: { contentColor: { r: 255, g: 215, b: 0, a: 0.35 }, borderColor: { r: 255, g: 165, b: 0, a: 0.9 }, showInfo: true },
      nodeId: q.nodeId
    });
    // 6 秒后自动清除高亮（不永久污染页面）
    setTimeout(async () => {
      try { await sendCDP("Overlay.hideHighlight"); } catch (e) { /* 忽略 */ }
    }, 6000);
    return { ok: true, matched: selector, highlighted: true };
  } catch (e) {
    return { error: `高亮失败: ${e.message}` };
  }
}

// ============================================================
// 工具 11：screenshot（对标 F12 截图取证）
// 截图存 chrome.storage（panel 可显示），不把 base64 塞进 LLM 上下文
// ============================================================
export async function screenshot({ fullPage = false } = {}) {
  try {
    // 截图前先移除页面浮条（否则 "F12x：截图(…)" 指示条会被截进图片）
    await hidePageIndicator();
    let clip;
    if (fullPage) {
      const metrics = await sendCDP("Page.getLayoutMetrics");
      const cs = metrics?.cssContentSize;
      if (cs) clip = { x: 0, y: 0, width: Math.min(cs.width, 4000), height: Math.min(cs.height, 10000), scale: 1 };
    }
    const shot = await sendCDP("Page.captureScreenshot", clip ? { format: "png", captureBeyondViewport: true, clip } : { format: "png" });
    if (!shot?.data) return { error: "截图失败（无数据）" };
    // 功能残缺 P0-3：key 唯一化（时间戳+自增序号——原 shot_${Date.now()} 毫秒粒度同毫秒互覆）
    let seq = 0;
    try {
      const seqR = await sendCDP("Runtime.evaluate", { expression: "window.__f12xShotSeq = (window.__f12xShotSeq || 0) + 1; window.__f12xShotSeq", returnByValue: true });
      seq = Number(seqR?.result?.value) || 0;
    } catch (e) { seq = Math.floor(Math.random() * 1000); }
    const key = "shot_" + Date.now() + "_" + seq;
    // 方案 001 / P5：不再写全局 5 张池——图片交给调用方（AI 会话 / 手动弹层）
    return { ok: true, key, dataUrl: "data:image/png;base64," + shot.data, size: Math.round(shot.data.length / 1024) + "KB", note: "截图已生成（不进入 LLM 上下文）" };
  } catch (e) {
    return { error: `截图失败: ${e.message}` };
  }
}

// ============================================================
// 工具 12：decode_text（Burp Decoder——编解码）
// base64/url/hex 编解码（渗透高频：payload 编码/响应解码）
// ============================================================
export async function decode_text({ text, mode, encoding = "utf-8" }) {
  if (!text || typeof text !== "string") return { error: "text 必填" };
  if (!mode) return { error: "mode 必填：base64_encode/base64_decode/url_encode/url_decode/hex_encode/hex_decode" };
  try {
    // P1 修复：支持任意编码解码（GBK 页面响应/二进制数据）——TextDecoder 标签
    const decoder = new TextDecoder(encoding);
    switch (mode) {
      case "base64_encode": {
        const bin = new TextEncoder().encode(text);
        let s = "";
        for (const b of bin) s += String.fromCharCode(b);
        return { ok: true, result: btoa(s) };
      }
      case "base64_decode": {
        const bin = atob(text);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return { ok: true, result: decoder.decode(bytes) };
      }
      case "url_encode": return { ok: true, result: encodeURIComponent(text) };
      case "url_decode": return { ok: true, result: decodeURIComponent(text) };
      case "hex_encode":
        return { ok: true, result: [...new TextEncoder().encode(text)].map(b => b.toString(16).padStart(2, "0")).join("") };
      case "hex_decode": {
        const clean = String(text).replace(/\s+/g, "");
        if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) return { error: "无效 HEX 输入（需偶数位 16 进制字符）" };
        const bytes = new Uint8Array(clean.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
        return { ok: true, result: decoder.decode(bytes) }; // 第二轮审查 P2-6：hex_decode 用带 encoding 的 decoder（原固定 UTF-8）
      }
      default: return { error: `未知模式: ${mode}` };
    }
  } catch (e) { return { error: `编解码失败: ${e.message}` }; }
}

// ============================================================
// 工具 13：compare_responses（Burp Comparer——响应对比）
// 盲注/枚举判断核心：长度/行相似度/首处差异——两响应差异一眼可见
// ============================================================
export async function compare_responses({ a, b, ignoreSymbolLines = true }) {
  if (typeof a !== "string" || typeof b !== "string") return { error: "a/b 必填（两个响应文本）" };
  // P1 修复：行序敏感比对（替换原无序 includes 匹配——JSON 的 } 行重复会污染相似度）
  const isSymbolLine = (l) => /^[\s{}[\],:"']*$/.test(l); // 纯符号/空白行（JSON 结构行）
  const linesA = a.split("\n"), linesB = b.split("\n");
  // 相似度：按位置逐行比对，忽略纯符号行（结构噪音）
  let matched = 0, comparable = 0;
  for (let i = 0; i < Math.max(linesA.length, linesB.length); i++) {
    const la = linesA[i] || "", lb = linesB[i] || "";
    if (ignoreSymbolLines && isSymbolLine(la) && isSymbolLine(lb)) continue; // 双方都是结构行——跳过
    comparable++;
    if (la === lb) matched++;
  }
  const similarity = comparable ? Math.round((matched / comparable) * 100) : 100;
  // 审查 3.10：位置对齐对"插入/删除一行"敏感（后续全错位 → 相似度暴跌）。
  // 补充内容包含匹配率（集合级——对位移鲁棒）——模型可同时看两个指标判断
  // "真差异"（内容变了）vs"位移"（内容没变只是位置变了）
  const setB = new Set(linesB);
  let contained = 0, nonSymbol = 0;
  for (const la of linesA) {
    if (ignoreSymbolLines && isSymbolLine(la)) continue;
    nonSymbol++;
    if (setB.has(la)) contained++;
  }
  const containment = nonSymbol ? Math.round((contained / nonSymbol) * 100) : 100;
  // 差异块统计（连续不同行合并为一块——大响应可定位差异区域）
  // 功能残缺 P1-2：口径统一——similarity 忽略符号行，diffBlocks 也忽略
  //（ignoreSymbolLines=true 时双方都是结构行的位置不算差异）
  const diffBlocks = [];
  let cur = null;
  for (let i = 0; i < Math.max(linesA.length, linesB.length); i++) {
    const la = linesA[i] || "", lb = linesB[i] || "";
    if (ignoreSymbolLines && isSymbolLine(la) && isSymbolLine(lb)) {
      if (cur) { diffBlocks.push(cur); cur = null; }
      continue;
    }
    if (la !== lb) {
      if (!cur) cur = { startLine: i + 1, endLine: i + 1, a: [], b: [] };
      cur.endLine = i + 1;
      if (cur.a.length < 5) cur.a.push(la.substring(0, 200));
      if (cur.b.length < 5) cur.b.push(lb.substring(0, 200));
    } else if (cur) { diffBlocks.push(cur); cur = null; }
  }
  if (cur) diffBlocks.push(cur);
  const firstDiff = diffBlocks[0] ? {
    line: diffBlocks[0].startLine,
    a: diffBlocks[0].a[0] || "",
    b: diffBlocks[0].b[0] || ""
  } : null;
  return {
    ok: true,
    lengthA: a.length, lengthB: b.length, lengthDiff: b.length - a.length,
    linesA: linesA.length, linesB: linesB.length,
    similarity: similarity + "%",
    containment: containment + "%", // 审查 3.10：内容包含匹配率（对位移鲁棒）
    identical: a === b,
    diffBlockCount: diffBlocks.length,
    diffBlocks: diffBlocks.slice(0, 20), // 前 20 个差异块（防大响应刷爆）
    firstDiff
  };
}

// ============================================================
// 工具 14：intruder（Burp Intruder——payload 变体请求）
// url 或 body 中 {payload} 占位符被每个 payload 替换发送——爆破/注入/枚举
// P1 增强：响应体可选/状态分组统计/header 注入位/limit 返回
// ============================================================
export async function intruder({ url, method = "GET", headers = {}, body = null, payloads = [], concurrency = 3, headerInject = null, includeBody = false, limit = 500, rateLimitMs = 0 }, signal = null) {
  if (!url || typeof url !== "string") return { error: "url 必填" };
  if (!Array.isArray(payloads) || !payloads.length) return { error: "payloads 必填（数组）" };
  const hasUrlSlot = url.includes("{payload}");
  const hasBodySlot = body !== null && String(body).includes("{payload}");
  const hasHeaderSlot = headerInject && String(headerInject).includes("{payload}");
  if (!hasUrlSlot && !hasBodySlot && !hasHeaderSlot) {
    return { error: "url / body / headerInject 需含 {payload} 占位符（将被每个 payload 替换）" };
  }
  const cap = Math.min(limit, payloads.length);
  const results = [];
  let idx = 0;
  const worker = async () => {
    while (idx < cap) {
      // P1：interruptible——信号中止（超时 deadline / 用户中止）后不再发送新请求（禁止"放虎归山"）
      if (signal && signal.aborted) break;
      const i = idx++;
      const p = String(payloads[i]);
      // 三处注入位：URL（编码）/ body（原样）/ header 值（原样）
      const u = hasUrlSlot ? url.replaceAll("{payload}", encodeURIComponent(p)) : url;
      const b = hasBodySlot ? String(body).replaceAll("{payload}", p) : (body !== null ? String(body) : null);
      let h = { ...(headers || {}) };
      if (hasHeaderSlot) {
        // 第二轮审查 P2-7：split(":",2) 把含冒号的 header 值截断（如 Authorization: Basic xxx:yyy）
        // ——只按第一个冒号切分 key/value
        const hi = String(headerInject).indexOf(":");
        if (hi > 0) {
          const hk = String(headerInject).substring(0, hi).trim();
          const hv = String(headerInject).substring(hi + 1).trim();
          if (hk) h[hk] = hv.replaceAll("{payload}", p);
        }
      }
      try {
        const r = await replay_request({ url: u, method, headers: h, body: b });
        const item = {
          index: i, payload: p.substring(0, 80),
          status: r.status || null,
          length: (r.body || "").length,
          error: r.error || null
        };
        // P1：可选返回响应体（盲注看内容/枚举看回显）——火力全开：500 → 20000
        if (includeBody && r.body) item.body = String(r.body).substring(0, 20000);
        results.push(item);
      } catch (e) {
        results.push({ index: i, payload: p.substring(0, 80), error: e.message });
      }
      if (rateLimitMs > 0) await new Promise(r => setTimeout(r, rateLimitMs)); // P1：可选速率限制（防触发 WAF/限流）
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), cap) }, worker);
  await Promise.all(workers);
  results.sort((a, b) => a.index - b.index);
  // P1：状态/长度分组统计（Burp Intruder 的"一眼识别异常组"能力）
  const statusGroups = {}, lenGroups = {};
  for (const r of results) {
    const sk = String(r.status ?? "ERR");
    statusGroups[sk] = (statusGroups[sk] || 0) + 1;
    const lk = r.length != null ? String(r.length) : "-";
    lenGroups[lk] = (lenGroups[lk] || 0) + 1;
  }
  // P1：interruptible——报告是否被信号中断（部分结果 + interrupted 标记）
  const interrupted = !!(signal && signal.aborted);
  return { ok: true, total: payloads.length, returned: results.length, interrupted, statusGroups, lenGroups, results };
}

// ============================================================
// v0.2 新增：表单侦察（formRecon）
// 一键列出页面 form/input/select/textarea（含同源 iframe 递归，跨域降级提示）
// ============================================================
function attrsToObj(attrs) {
  const o = {};
  for (const a of attrs || []) { try { o[a.name] = a.value; } catch (e) {} }
  return o;
}

export async function formRecon() {
  if (!debuggee) throw new Error("未连接调试器");
  const doc = await sendCDP("DOM.getDocument", { depth: -1, pierce: true });
  const root = doc.root;
  const forms = [];
  let crossFrameSkipped = 0;

  const walk = (node, frameLabel) => {
    if (!node) return;
    const tag = (node.localName || "").toLowerCase();
    if (tag === "form") {
      const attrs = attrsToObj(node.attributes);
      const fields = [];
      const walkFields = (n) => {
        if (!n) return;
        const t = (n.localName || "").toLowerCase();
        if (["input", "select", "textarea", "button"].includes(t)) {
          const fa = attrsToObj(n.attributes);
          fields.push({
            tag: t, name: fa.name || null, id: fa.id || null, type: fa.type || null,
            value: fa.value != null ? fa.value : null, placeholder: fa.placeholder || null
          });
        }
        for (const c of n.children || []) walkFields(c);
      };
      walkFields(node);
      forms.push({
        frame: frameLabel,
        action: attrs.action || null, method: (attrs.method || "GET").toUpperCase(),
        id: attrs.id || null, name: attrs.name || null,
        fields
      });
    }
    // iframe 处理：同源可穿透（pierce:true 已给 children），跨域文档不可见 → 计数降级提示
    if (tag === "iframe") {
      const childDocs = node.contentDocument || null; // 仅描述信息，pierce 后 children 含 iframe document
      if (!node.children || !node.children.length) crossFrameSkipped++;
    }
    for (const c of node.children || []) walk(c, frameLabel);
  };
  walk(root, "top");

  return {
    ok: true, forms, count: forms.length,
    crossFrameSkipped,
    hint: crossFrameSkipped ? `跨域 iframe 内容无法读取（${crossFrameSkipped} 个）` : undefined
  };
}

// ============================================================
// v0.2 新增：Inspect 点选（对标 F12 Elements 选中）
// Overlay.setInspectMode(searchForNode) → 页面点击 → inspectNodeRequested
// ============================================================
export async function inspectEnable() {
  if (!debuggee) throw new Error("未连接调试器，请先附加");
  try { await sendCDP("DOM.enable"); } catch (e) {}
  try { await sendCDP("Overlay.enable"); } catch (e) {}
  await sendCDP("Overlay.setInspectMode", {
    mode: "searchForNode",
    highlightConfig: { showInfo: true, showStyles: true, contentColor: { r: 255, g: 80, b: 80, a: 0.35 } }
  });
  appState.inspectMode = true;
  return { ok: true };
}

export async function inspectDisable() {
  if (debuggee) {
    try { await sendCDP("Overlay.setInspectMode", { mode: "none" }); } catch (e) {}
    try { await sendCDP("Overlay.disable"); } catch (e) {}
  }
  appState.inspectMode = false;
  return { ok: true };
}

// 由 backendNodeId 生成元素信息 + CSS 选择器（优先 id → tag+关键属性 → 简单链）
function buildCssSelector(node, attrs) {
  if (attrs?.id) return `#${String(attrs.id).replace(/[^a-zA-Z0-9_-]/g, "\\$&")}`;
  const tag = (node?.localName || "").toLowerCase();
  if (attrs?.name) return `${tag}[name="${String(attrs.name).replace(/"/g, '\\"')}"]`;
  if (attrs?.class) {
    const cls = String(attrs.class).trim().split(/\s+/)[0];
    if (cls) return `${tag}.${cls.replace(/[^a-zA-Z0-9_-]/g, "\\$&")}`;
  }
  return tag;
}

async function handleInspectNode(backendNodeId) {
  const desc = await sendCDP("DOM.describeNode", { backendNodeId, depth: 2 });
  const n = desc.node;
  if (!n) return;
  const attrs = attrsToObj(n.attributes);
  // 防止 Overlay 拾取选中 F12x 扩展自身 UI（气泡 / 宿主等）：
  // 特征命中 → 忽略该次选择，重新开启拾取（保持模式，等下一次有效点击）
  if (/f12x/i.test(String(attrs.id || "") + " " + String(attrs.class || ""))) {
    try {
      await sendCDP("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: { showInfo: true, showStyles: true, contentColor: { r: 255, g: 80, b: 80, a: 0.35 } }
      });
    } catch (e) {}
    return;
  }
  const selector = buildCssSelector(n, attrs);
  // v0.3：收集"底层代码"（唯一选择器 / HTML / 事件监听器 JS 源码 / 匹配 CSS）
  const code = await collectElementCode(backendNodeId, selector);
  busEmit("inspect:selected", {
    tag: n.localName, nodeName: n.nodeName, attributes: attrs,
    selector: code.selector || selector,
    html: code.html,
    text: (attrs.value != null ? String(attrs.value) : n.nodeValue) || "",
    code,
    pageUrl: debuggeeUrl || ""
  });
}

// ============================================================
// v0.3 新增：元素"底层代码"收集（对标 IDE AI 助手"选中代码块同步"）
// 点选元素 → 唯一 CSS 路径 + HTML 源码 + 事件监听器 JS 源码 + 匹配 CSS 规则
// 结果随 inspect:selected 送出：面板展示 + 一键送 AI 精确调试（router 自动送 AI）
// ============================================================
async function collectElementListeners(backendNodeId) {
  const out = [];
  try {
    const { listeners } = await sendCDP("DOMDebugger.getEventListeners", { backendNodeId, depth: 3 });
    for (const l of listeners || []) {
      let snippet = "";
      const d = l.handler && l.handler.description;
      if (d && !/native code/i.test(d)) snippet = String(d);
      if (!snippet && l.scriptId != null && l.lineNumber != null) {
        try {
          const src = await sendCDP("Debugger.getScriptSource", { scriptId: l.scriptId });
          const lines = String(src.scriptSource || "").split("\n");
          const start = Math.max(0, l.lineNumber - 5);
          const end = Math.min(lines.length, l.lineNumber + 12);
          snippet = lines.slice(start, end).join("\n");
        } catch (e) {}
      }
      if (!snippet) continue; // native 监听器无源码可读，跳过
      out.push({
        type: l.type,
        once: !!l.once,
        scriptId: l.scriptId || "",
        line: l.lineNumber != null ? l.lineNumber + 1 : null,
        snippet: snippet.substring(0, 2000)
      });
    }
  } catch (e) {}
  return out;
}

async function collectElementCode(backendNodeId, initSelector) {
  const out = { selector: initSelector || "", html: "", listeners: [], css: [] };
  try {
    const o = await sendCDP("DOM.getOuterHTML", { backendNodeId });
    out.html = String(o.outerHTML || "").substring(0, 4000);
  } catch (e) { /* 忽略 */ }
  out.listeners = await collectElementListeners(backendNodeId);
  const u = await collectCssAndUniqueSelector(initSelector);
  if (u.sel) out.selector = u.sel;
  out.css = u.css;
  return out;
}

// v0.3 内容脚本拾取入口：按唯一选择器收集底层代码（HTML/监听器/CSS）
export async function collectElementCodeBySelector(selector, html) {
  const out = { selector: selector || "", html: html || "", listeners: [], css: [] };
  try {
    const doc = await sendCDP("DOM.getDocument", { depth: -1, pierce: true });
    const q = await sendCDP("DOM.querySelector", { nodeId: doc.root.nodeId, selector: out.selector });
    const node = q && q.node;
    if (node) {
      if (node.backendNodeId != null) out.listeners = await collectElementListeners(node.backendNodeId);
      if (node.nodeId != null) {
        try {
          const o = await sendCDP("DOM.getOuterHTML", { nodeId: node.nodeId });
          if (o.outerHTML) out.html = String(o.outerHTML).substring(0, 4000);
        } catch (e) {}
      }
    }
  } catch (e) { /* selector 在 DOM 中未命中（shadow/动态）时仅保留 content 侧 html */ }
  const u = await collectCssAndUniqueSelector(out.selector);
  if (u.sel) out.selector = u.sel;
  out.css = u.css;
  return out;
}

// 页面内一次计算：唯一 CSS 路径（含 nth-of-type 消歧）+ 匹配规则文本
async function collectCssAndUniqueSelector(initSelector) {
  const out = { sel: "", css: [] };
  try {
    const r = await sendCDP("Runtime.evaluate", {
      expression: `(() => {
        const cssEscape = (s) => { try { return CSS.escape(s); } catch (e) { return String(s).replace(/([^a-zA-Z0-9_-])/g, "\\\\$1"); } };
        const el = document.querySelector(${JSON.stringify(initSelector || "body")});
        if (!el) return JSON.stringify({ sel: "", css: [] });
        let sel = "";
        if (el.id && document.querySelectorAll("#" + cssEscape(el.id)).length === 1) {
          sel = "#" + cssEscape(el.id);
        } else {
          const parts = [];
          let cur = el;
          while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== "html") {
            let part = cur.tagName.toLowerCase();
            if (cur.id) part += "#" + cssEscape(cur.id);
            else if (cur.classList && cur.classList.length) part += "." + cssEscape(cur.classList[0]);
            const parent = cur.parentElement;
            if (parent && !cur.id) {
              const sameTag = [...parent.children].filter(c => c.tagName === cur.tagName);
              if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")";
            }
            parts.unshift(part);
            cur = parent;
          }
          sel = parts.join(" > ");
        }
        const rules = [];
        try {
          for (const sheet of document.styleSheets) {
            for (const rule of sheet.cssRules) {
              if (rule.selectorText && el.matches(rule.selectorText)) rules.push(rule.cssText);
              if (rule.cssRules) for (const rr of rule.cssRules) if (rr.selectorText && el.matches(rr.selectorText)) rules.push(rr.cssText);
            }
          }
        } catch (e) {}
        return JSON.stringify({ sel, css: rules.slice(0, 25) });
      })()`,
      returnByValue: true
    });
    const val = r && r.result && r.result.value;
    if (val) {
      const parsed = JSON.parse(val);
      if (parsed.sel) out.sel = parsed.sel;
      out.css = parsed.css || [];
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

// ============================================================
// v0.2 新增：请求拦截（v1，CDP Fetch 域）
// 三态：off / manual_next（拦下一个）/ all（全量拦截）
// 待处理队列 → 放行(可改) / 伪造响应 / 丢弃 / 转 Repeater
// ============================================================
let interceptManualPending = false; // 等待"拦下一个"的未触发标志

// --- 14.1 SW 生命周期防护（第二层）：拦截队列快照持久化 ---
// SW 意外死亡后 CDP 连接断开，页面被拦请求由浏览器自动恢复放行；
// 恢复时清空快照并提示"连接中断，已放行 N 个请求"（放行优于挂死）
const SNAP_KEY = "f12x_intercept_snapshot_v1";
let _snapTimer = null;
// 修复（审读高）：队列每次入队/处置都全量序列化写 storage（无去抖）→ 高频写放大。
// 快照写改为 250ms 尾部去抖；模式切换（setMode，低频关键态）仍即时写
function scheduleInterceptSnapshot() {
  if (_snapTimer) clearTimeout(_snapTimer);
  _snapTimer = setTimeout(() => { _snapTimer = null; persistInterceptSnapshot(); }, 250);
}
async function persistInterceptSnapshot() {
  try {
    await chrome.storage.local.set({
      [SNAP_KEY]: {
        mode: appState.interceptMode,
        queue: appState.interceptQueue.map(i => ({ pausedId: i.pausedId, url: i.url, method: i.method, ts: i.ts })),
        ts: Date.now()
      }
    });
  } catch (e) {}
}
export async function recoverInterceptSnapshot() {
  try {
    const snap = (await chrome.storage.local.get(SNAP_KEY))[SNAP_KEY];
    if (!snap) return;
    await chrome.storage.local.remove(SNAP_KEY);
    const n = (snap.queue || []).length;
    if (snap.mode !== "off" && n) {
      appState.interceptMode = "off"; // 会话内记忆：重启后回到默认 off（避免误拦）
      appState.interceptQueue = [];
      busEmit("intercept:released_all", { count: n, reason: "sw_restore" });
      busEmit("console:log", { ts: Date.now(), level: "warning", text: `连接中断，已放行 ${n} 个拦截请求（SW 重启恢复）` });
    }
  } catch (e) {}
}

export async function interceptSetMode(mode) {
  if (!["off", "manual_next", "all"].includes(mode)) return { error: `未知拦截模式: ${mode}` };
  // 14.7①：任务运行中用户手动开拦截 = 接管信号 → 立即 abort 当前 AI 工具执行（与接管同一步）
  if (mode !== "off" && taskState.taskRunning) {
    if (taskState.abort) { try { taskState.abort.abort(); } catch (e) {} }
    taskState.paused = true;
    abortPendingApproval("用户已接管（开启拦截）"); // 批准等待立即按拒绝放行
    pushStatus({ status: "stopped", text: "用户已接管（开启拦截），AI 任务已中止" });
  }
  appState.interceptMode = mode;
  if (mode === "off") {
    interceptManualPending = false;
    try { await sendCDP("Fetch.disable"); } catch (e) {}
    appState.interceptQueue = [];
    busEmit("intercept:mode", { mode });
    await persistInterceptSnapshot();
    return { ok: true, mode };
  }
  try { await sendCDP("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }); } catch (e) {
    return { error: `启用拦截失败: ${e.message}（需 debugger 已附加）` };
  }
  interceptManualPending = mode === "manual_next"; // 下一个请求将被拦截
  busEmit("intercept:mode", { mode });
  await persistInterceptSnapshot();
  return { ok: true, mode };
}

async function handleRequestPaused(params) {
  const { requestId, request } = params;
  const mode = appState.interceptMode;
  // 非拦截模式（或手动模式已放过下一个）：自动放行
  if (mode === "off") { try { await sendCDP("Fetch.continueRequest", { requestId }); } catch (e) {} return; }
  if (mode === "manual_next" && !interceptManualPending) {
    try { await sendCDP("Fetch.continueRequest", { requestId }); } catch (e) {}
    return;
  }
  if (mode === "manual_next") interceptManualPending = false; // 本请求被拦，等待用户处置
  const userSrc = isUserRequest(request.url);
  const item = {
    pausedId: requestId,
    url: request.url,
    method: request.method,
    headers: request.headers || {},
    postData: request.postData || null,
    ts: Date.now()
  };
  // 同源请求入网络表（来源标记：用户重放 → user，其余 page）
  // 修复（审读中）：与 requestWillBeSent 同 requestId 双记录 → 已存在则原位补 intercepted，不重复 push
  const netEntry = {
    id: requestId, url: request.url, method: request.method,
    type: params.resourceType || "fetch", timestamp: Date.now() / 1000,
    requestHeaders: request.headers || null, postData: request.postData || null,
    source: userSrc ? "user" : "page", intercepted: true
  };
  const existing = networkRequests.findIndex(r => r.id === requestId);
  if (existing >= 0) {
    networkRequests[existing] = { ...networkRequests[existing], ...netEntry };
    netPushUpdate(requestId, { intercepted: true, source: netEntry.source });
  } else {
    if (networkRequests.length >= NETWORK_MAX) networkRequests.shift();
    networkRequests.push(netEntry);
    netPushRequest({ id: requestId, url: request.url, method: request.method, type: params.resourceType || "fetch", source: userSrc ? "user" : "page", intercepted: true });
  }
  appState.interceptQueue.push(item);
  scheduleInterceptSnapshot();
  busEmit("intercept:paused", item);
}

function toCdpHeaders(headersObj) {
  return Object.entries(headersObj || {}).map(([name, value]) => ({ name, value: String(value) }));
}

// 拦截处置：continue(可改) / fulfill(伪造) / fail(丢弃) / send_to_repeater
export async function interceptAction({ pausedId, action = "continue", edits = null }) {
  const idx = appState.interceptQueue.findIndex(i => i.pausedId === pausedId);
  const item = idx >= 0 ? appState.interceptQueue[idx] : null;
  if (!item) return { error: "拦截项不存在（可能已超时/被放行）" };
  try {
    if (action === "continue") {
      const p = { requestId: pausedId };
      if (edits?.headers) p.headers = toCdpHeaders(edits.headers);
      await sendCDP("Fetch.continueRequest", p);
    } else if (action === "fulfill") {
      const status = edits?.status ? Number(edits.status) : 200;
      let bodyB64 = "";
      try { bodyB64 = btoa(unescape(encodeURIComponent(String(edits?.body || "")))); } catch (e) { bodyB64 = btoa(String(edits?.body || "")); }
      await sendCDP("Fetch.fulfillRequest", {
        requestId: pausedId, responseCode: status,
        responseHeaders: toCdpHeaders(edits?.headers),
        body: bodyB64
      });
    } else if (action === "fail") {
      await sendCDP("Fetch.failRequest", { requestId: pausedId, errorReason: edits?.reason || "BlockedByClient" });
    } else {
      return { error: `未知动作: ${action}` };
    }
    appState.interceptQueue.splice(idx, 1);
    scheduleInterceptSnapshot();
    busEmit("intercept:resolved", { pausedId, action });
    return { ok: true };
  } catch (e) {
    appState.interceptQueue.splice(idx, 1);
    scheduleInterceptSnapshot();
    // 修复（审读中）：处置失败也尝试放行——原直接 splice 让请求悬挂至浏览器超时
    try { await sendCDP("Fetch.continueRequest", { requestId: pausedId }); } catch (e2) { /* 放行失败则浏览器最终超时兜底 */ }
    return { error: `拦截处置失败: ${e.message}（已尝试放行）` };
  }
}

// 一键全部放行（拦截等待的断线兜底也复用此逻辑）
export async function interceptReleaseAll() {
  const queue = [...appState.interceptQueue];
  appState.interceptQueue = [];
  for (const item of queue) {
    try { await sendCDP("Fetch.continueRequest", { requestId: item.pausedId }); } catch (e) {}
  }
  scheduleInterceptSnapshot();
  if (queue.length) busEmit("intercept:released_all", { count: queue.length });
  return { ok: true, released: queue.length };
}

// SW 生命周期防护：SW 复活时若残留未决拦截（持久化恢复场景），放行兜底（见 recoverInterceptSnapshot）
