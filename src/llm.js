// F12x llm 模块（模块化拆分，纯搬移零逻辑变更）
import { getActiveConversation, buildSkillsIndex } from "./memory.js";
import { normalizeError, isRetriable, retryDelayMs } from "./errors.js";

// LLM 调用计数（原 background 全局——模块作用域隔离，语义归属 LLM 层）
export let llmCallCounter = 0; // 每次真实请求 +1（含重试）
export function resetLLMCallCounter() { llmCallCounter = 0; }

// 默认 LLM 端点列表：仅作 baseUrl 缺省来源。
// 注：端点校验已移除（火力全开——任意 LLM 端点可连，见 fetchLLM），此列表非安全闸门
export const DEFAULT_LLM_ENDPOINTS = Object.freeze([
  "https://api.deepseek.com",
  "https://api.openai.com",
  "https://api.anthropic.com",
  "http://localhost:11434"
]);

export let allowedLLMEndpoints = [...DEFAULT_LLM_ENDPOINTS];

export async function loadEndpoints() {
  const result = await chrome.storage.local.get("llm_endpoints");
  const v = result.llm_endpoints;
  allowedLLMEndpoints = Array.isArray(v) && v.length ? v : [...DEFAULT_LLM_ENDPOINTS];
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.llm_endpoints) {
    const v = changes.llm_endpoints.newValue;
    allowedLLMEndpoints = Array.isArray(v) && v.length ? v : [...DEFAULT_LLM_ENDPOINTS];
  }
});

export async function fetchLLM(url, body) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`非法 URL: ${url}`);
  }
  // 端点白名单校验已移除（火力全开：任意 LLM 端点可连）
  // 超时保护：非流式调用 60s 无响应即中断（防卡死）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    return await fetch(url, { ...body, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("LLM 请求超时（60s 无响应）");
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// LLM Agent 决策循环
// ============================================================

// P1 修复（2.1 连带）：字符加权估算——中文 1 字符 ≈ 1 token、英文 ~4 字符 ≈ 1 token
// （原 length/2 对中文混排误差大——裁剪触发边界不准）
export function estimateTokensV2(str) {
  const s = String(str || "");
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

// --- storage 键 ---
export async function getLLMConfig() {
  const result = await chrome.storage.local.get(["llmConfig", "llm_api_key", "llm_model", "llm_base_url", "llm_model_mode", "llm_expert_model"]);
  // 统一配置来源：设置页保存为 llmConfig 对象；兼容旧版独立键（llm_api_key 等）
  const c = result.llmConfig || {};
  // 默认使用第一个白名单域名作为 base URL
  const baseUrl = c.baseUrl || result.llm_base_url || (allowedLLMEndpoints[0] || "https://api.deepseek.com");
  const model = c.model || result.llm_model || "deepseek-chat";
  // 双模型模式：主代理用 llm_model，复核审计员用 llm_expert_model（未配置则回退主模型）
  const dual = result.llm_model_mode === "dual" && result.llm_expert_model;
  return {
    apiKey: c.apiKey || result.llm_api_key || "",
    model: model,
    expertModel: dual ? result.llm_expert_model : null,
    baseUrl: baseUrl,
    contextWindow: Number(c.contextWindow) || 0,
    maxOutput: Number(c.maxOutput) || 8192,
    windowSource: c.windowSource || "",
    provider: c.provider || "openai"
  };
}

// === Skill 系统（技能面仅服务主模型 main_model） ===
// skills_data: { [role]: [{id, name, desc, content, updatedAt}] }
// role = "main_model"——技能按主模型存储/注入
// === v4-flash 型推理模型补偿（pullFinalContent） ===
// DeepSeek v4-flash 等：SSE 中思考全走 reasoning_content、delta.content 恒空，
// message.content 只在非流式响应返回 → 流式结束后以同一请求体非流式重取最终回答。
// 返回 null 表示无需/无法补拉（工具轮 / HTTP 失败 / content 本身为空），调用方按原样兜底。
async function pullFinalContent(endpoint, body, external) {
  let payload;
  try { payload = JSON.parse(body.body || "{}"); } catch { return null; }
  if (payload.stream !== true) return null; // 本就非流式，无需补拉
  payload.stream = false;
  delete payload.stream_options; // 非流式不允许 include_usage（DeepSeek 400 invalid_request_error）
  const controller = new AbortController();
  if (external?.aborted) return null;
  const onAbort = () => controller.abort();
  if (external) external.addEventListener("abort", onAbort);
  // 修复（审读高2）：补拉自建 fetch 不受主链路 total/idle 定时器约束——
  // 网络半开时若无独立超时会无限挂起。45s 无响应即放弃，补偿失败调用方按原样兜底
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(endpoint, { method: body.method, headers: body.headers, body: JSON.stringify(payload), signal: controller.signal });
    if (!resp.ok) return null;
    const j = await resp.json().catch(() => null);
    return j?.choices?.[0]?.message?.content || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onAbort);
  }
}

// === 基础 LLM 流式调用：SSE 解析 + 超时保护 + [DONE] 完整性校验 + v4-flash 非流式补拉 ===
// 调用方通过 onChunk({json}) 逐块接收；onChunk({done:true}) 表示流结束
export async function streamChatCompletion(endpoint, body, onChunk, opts = {}) {
  // === 超时保护（底层卡死的根因修复） ===
  // DeepSeek 偶发不响应/网络半开连接时，裸 fetch/reader.read() 会永远 pending → 任务卡死
  // 整体超时（120s）+ chunk idle 超时（30s 无新数据即中断）——超时后抛错，llmCallWithRetry 自动重试
  const totalTimeout = opts.timeoutMs || 120000;
  // P0a 修复：idle 30s → 120s——DeepSeek 深度思考时可能长时间无 content 增量（reasoning 只走 thinking 通道或思考中），
  // 30s 会误杀正常深度思考；官方建议 300s，取 120s 平衡误杀与卡死检测
  const idleTimeout = opts.idleMs || 120000;
  const controller = new AbortController();
  const external = opts.signal;
  let onExternalAbort = null;
  if (external?.aborted) controller.abort();
  else if (external) {
    onExternalAbort = () => controller.abort();
    external.addEventListener("abort", onExternalAbort);
  }
  let timedOut = false;
  const totalTimer = setTimeout(() => { timedOut = true; controller.abort(); }, totalTimeout);
  let lastChunkAt = Date.now();
  const idleTimer = setInterval(() => {
    if (!timedOut && Date.now() - lastChunkAt > idleTimeout) {
      timedOut = true;
      controller.abort();
    }
  }, 5000);

  try {
    const resp = await fetch(endpoint, { ...body, signal: controller.signal });
    if (!resp.ok) {
      const errText = await resp.text();
      const hostShown = String(endpoint || "").replace(/^https?:\/\//i, "");
      let errMsg = `HTTP ${resp.status} @ ${hostShown}`;
      try {
        const j = JSON.parse(errText);
        errMsg += `: ${j.error?.message || JSON.stringify(j.error).substring(0, 200)}`;
      } catch { errMsg += `: ${errText.substring(0, 200)}`; }
      // 403 + 本地回环：通常是本地服务的跨源(Origin)校验拒绝扩展来源（如 Ollama 默认只放行
      // localhost/ollama.com 等；扩展请求带 Origin: chrome-extension://… → 403 空体）。给出可直接照做的修复提示
      if (resp.status === 403 && /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?|0\.0\.0\.0)/i.test(String(endpoint || ""))) {
        errMsg += "（本地服务拒绝扩展来源：Ollama 请在系统环境变量添加 OLLAMA_ORIGINS=* 后完全退出并重启；LM Studio 请在 Server 设置里开启浏览器/跨源访问）";
      }
      // 审查 1.3：400 context overflow → 抛标记错误——调用方检测后二次裁剪重试
      // （否则长任务直接失败；错误被 llmCallWithRetry 的 retriable 排除是正确——
      // 确定性问题重试无意义，必须裁剪后重发）
      if (resp.status === 400 && /context|token|too (long|large)|length/i.test(errMsg)) {
        const err = new Error(`CONTEXT_OVERFLOW: ${errMsg}`);
        err.contextOverflow = true;
        throw err;
      }
      const err = new Error(errMsg);
      err.status = resp.status;
      // P0b：429 时携带服务端 Retry-After，重试退避优先尊重它
      if (resp.status === 429) {
        const ra = parseInt(resp.headers.get("retry-after"), 10);
        if (!isNaN(ra)) err.retryAfter = ra;
      }
      throw err;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // P0a 修复：SSE 完整性——EOF 前必须见过 [DONE]，否则视为流被截断（网络层静默掐断/代理掐断），
    // 抛 STREAM_CLOSED 走重试，杜绝"残缺答案当成功"（截断时内容可能只有半截 JSON/半句话）
    let sawDone = false;
    // v4-flash 型推理模型检测：整流是否出现过 content / tool_calls
    // （DeepSeek v4-flash：思考全走 reasoning_content、delta.content 恒空，最终回答仅在非流式 message.content 返回）
    let gotContent = false;
    let gotToolCall = false;

    let eof = false;
    while (!eof) {
      const { done, value } = await reader.read();
      if (done) break;
      lastChunkAt = Date.now();
      buffer += decoder.decode(value, { stream: true });

      // 按行解析 SSE（事件以 \n 分隔，空行分隔事件）
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(":")) continue; // 空行/注释行
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") { sawDone = true; eof = true; break; }
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { continue; }
          const d0 = parsed.choices?.[0]?.delta || {};
          if (d0.content) gotContent = true;
          if (Array.isArray(d0.tool_calls) && d0.tool_calls.length) gotToolCall = true;
          // onChunk 抛错会中断读取循环并冒泡（思考预算控制依赖此行为——超预算立即掐断本轮）
          onChunk({ json: parsed });
        }
      }
    }
    // EOF 到达但从未见 [DONE]：非中止场景即截断（外部中止时 reader.read() 会先抛 AbortError，不会走到这里）
    if (!sawDone) {
      const err = new Error("LLM 流式响应被截断（EOF 前未见 [DONE]）");
      err.name = "StreamClosedError";
      throw err;
    }
    // v4-flash 补偿：流中 content/tool 均未出现（只有 reasoning）→ 同请求体非流式重取最终回答
    // 作为最后一次增量交给调用方；补拉失败保持原样（调用方各自兜底），不破坏已正常结束的流
    if (!gotContent && !gotToolCall && !opts.noContentFallback) {
      const pulled = await pullFinalContent(endpoint, body, external);
      if (pulled) onChunk({ json: { choices: [{ index: 0, delta: { content: pulled }, finish_reason: "stop" }] } });
    }
    onChunk({ done: true });
  } catch (e) {
    if (timedOut) {
      const err = new Error("LLM 流式响应超时（无响应或中断）");
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(totalTimer);
    clearInterval(idleTimer);
    if (external && onExternalAbort) external.removeEventListener("abort", onExternalAbort);
  }
}

// ============================================================
// 复核审计员输出解析辅助
// 触发：分析型工具结果自动分析 + call_expert 主代理自主召唤 + 卡住自动介入
// ============================================================
export function extractJsonObject(text) {
  if (!text) return null;
  // 1. 直接解析
  try { return JSON.parse(text); } catch { /* 继续 */ }
  // 2. markdown 围栏内提取
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* 继续 */ }
  }
  // 3. 提取第一个 { 到最后一个 } 的片段（容忍前后解释文本）
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.substring(start, end + 1)); } catch { /* 继续 */ }
  }
  return null;
}

// 复核（流式调用，reasoning 实时推送前端）
export async function llmCallWithRetry(callFn, { retries = 2, signal = null, onRetry = null } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) throw lastErr || new Error("aborted");
    try {
      llmCallCounter++; // 每次真实请求 +1（含重试）
      return await callFn();
    } catch (e) {
      lastErr = e;
      if (i >= retries) throw e;
      // P0b：稳定错误码白名单重试（替换原正则猜错误）——只有瞬时类错误码才重试，
      // 参数错/认证错/上下文超限等确定性问题直接抛，避免无效重试烧钱
      const ne = normalizeError(e);
      if (!isRetriable(ne.code)) throw e;
      const delay = retryDelayMs(i, lastErr.retryAfter || ne.retryAfter);
      console.warn(`[Agent] LLM 调用失败（${ne.code}: ${ne.message.substring(0, 80)}），${delay}ms 后重试 ${i + 1}/${retries}`);
      onRetry?.(i, delay, ne.code); // §4.3：重试写入审计（由调用方注入 hook，llm.js 保持解耦）
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// === 意图分类（NVIDIA Intent Classifier 模式）：对话 vs 任务 ===
// 自动化前提 = 得到具体执行指令；对话型输入走轻量路径，不启动任务引擎
export async function classifyIntent(config, text) {
  try {
    const endpoint = normalizeEndpoint(config.baseUrl);
    const body = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: "判断用户输入是否需要操作浏览器或执行渗透测试任务。仅输出 JSON：{\"intent\":\"chat\"|\"task\"}。chat=问候/闲聊/纯知识问答/与浏览器操作无关；task=涉及页面操作/渗透测试/获取站点信息/执行脚本/分析网站/验证漏洞等。当输入可能涉及浏览器或页面时归为 task。" },
          { role: "user", content: String(text || "").substring(0, 500) }
        ],
        temperature: 0,
        max_tokens: 20,
        response_format: { type: "json_object" }
      })
    };
    const resp = await llmCallWithRetry(() => fetchLLM(endpoint, body), { retries: 1 });
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(content);
    if (parsed?.intent === "chat") return "chat";
    if (parsed?.intent === "task") return "task";
    return null;
  } catch (e) {
    return null;
  }
}

// 分类失败/超时时的规则兜底
export function fallbackIntent(text) {
  const t = String(text || "").trim();
  // P1 修复：启发式判断（替代"默认 task"——闲聊会启动完整任务引擎浪费）
  if (!t) return "chat";
  if (/^(你好|您好|嗨|hi|hello|hey|谢谢|感谢|再见|拜拜|在吗|哈哈|嗯|哦|好的|ok|okay|早上好|晚上好|下午好)[!！。.～~]*$/i.test(t)) return "chat";
  // 功能修复（用户实测"下达指令只回复一下就结束"）：
  // 任务动作词 + 目标对象 → task【优先于问句判定】——
  // 原问句判定在前，"怎么测试这个网站？/能分析这个页面吗"这类带问号的
  // 任务指令被归 chat → 只回复一次就结束（runChat 一次问答）
  // classifyIntent（LLM）失败时 fallback 必须接住任务指令
  if (/(测试|分析|检查|扫描|爆破|注入|重放|绕过|探测|枚举|破解|验证|查看|获取|读取|执行|访问|搜索|导航|对比|解码|登录|抓包|逆向|审查|评估).{0,20}(网站|页面|站点|接口|系统|应用|目标|这个|该|他|它)/.test(t)) return "task";
  if (/(网站|页面|站点|接口|系统|应用).{0,20}(测试|分析|检查|扫描|漏洞|渗透|爆破|注入|安全|审计)/.test(t)) return "task";
  // 问句/对话特征（问号、主观询问、无动作动词）→ 对话
  if (/[?？]|^怎么|^为什么|^什么是|^介绍一下|^帮我解释|^说说|^聊聊|^你认为|^你觉得|^能不能|^可以吗|^你会/.test(t)) return "chat";
  // 无浏览器操作动词的陈述 → 保守归 chat（任务指令通常含动作词）
  // 审查 4.1："什么是 SQL 注入"这类知识问题含"注入"被误判 task——
  // 排除"什么是/介绍一下/讲解"等知识前缀
  if (/^(什么是|什么是|介绍一下|讲解|解释|科普|说说|聊聊|怎么看|如何看待)/.test(t)) return "chat";
  if (!/(分析|测试|查看|获取|检查|扫描|注入|爆破|重放|导航|搜索|读取|执行|打开|访问|探测|验证|登录|绕过|破解|枚举|对比|解码)/.test(t)) return "chat";
  return "task";
}

// 审查 6.2：端点归一化——用户按 OpenAI 习惯填 https://api.deepseek.com/v1
// 会拼出 /v1/v1/chat/completions 404。统一去掉尾部 / 和 /v1
export function normalizeEndpoint(baseUrl) {
  let b = String(baseUrl || "").trim().replace(/\/+$/, "");
  b = b.replace(/\/v1$/, "");
  return b ? b + "/v1/chat/completions" : "";
}


// 本地服务（Ollama/LM Studio 等回环地址）：请求级 keep_alive=-1 让模型常驻，消除轮间重载延迟
export function isLoopbackBaseUrl(baseUrl) {
  const host = String(baseUrl || "").replace(/^https?:\/\//i, "").split("/")[0].split(":")[0].toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(host);
}
export function keepAliveForLocal(baseUrl) {
  return isLoopbackBaseUrl(baseUrl) ? { keep_alive: -1 } : {};
}

// 本地空闲保活：Arc iGPU+Vulkan 空闲后首个请求有数秒~数十秒唤醒延迟（实测 0.99s→6.5s→30.6s 随空闲增长）。
// 定期发一个 1-token 极小请求保持 GPU/驱动活跃，把“第一问”延迟压回 ~1s。
export async function warmLocalModel(config) {
  if (!config || !isLoopbackBaseUrl(config.baseUrl)) return false;
  try {
    const endpoint = normalizeEndpoint(config.baseUrl);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (config.apiKey || "local") },
      body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false, keep_alive: -1 }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    return !!resp && resp.ok;
  } catch (e) { return false; }
}

// === 轻量对话路径（意图分类为 chat 时）：不带 tools，直接问答，零机制干扰 ===
// P2 修复（5.6 注释错位）：此文件为 LLM 层——调用编排/重试/流式/分类；
// 专家池（复核审计员（call_expert））在 src/experts.js——此前注释误写在此处
// taskCtl: { setAbort, setPaused }——任务控制状态注入（原为 background 全局，跨模块必须显式传递）
export async function runChat(config, text, onStatus, taskCtl) {
  const endpoint = normalizeEndpoint(config.baseUrl);
  const abortController = new AbortController();
  if (taskCtl?.setAbort) taskCtl.setAbort(abortController);
  if (taskCtl?.setPaused) taskCtl.setPaused(false);
  // P2 修复：会话历史共享（对话模式也读任务消息——原只取 6 条纯文本，任务上下文断层；
  // 改为过滤 tool 消息后取最近 12 条文本/任务推理，对话可引用任务发现）
  let history = [];
  try {
    const session = await getActiveConversation();
    if (session?.messages) {
      history = session.messages.filter(m => {
        if (m.role === "user" && m._sys) return false; // 系统注入（审查追问）不进对话历史
        if (m.role === "user") return true;
        if (m.role === "assistant" && !m.tool_calls) return true; // AI 文本（含任务推理）
        return false;
      }).slice(-12); // 最近 12 条文本消息（含任务推理）
    }
  } catch (e) { /* 忽略历史读取失败 */ }
  const llmBody = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: `你是 F12x——浏览器内置的渗透测试 AI 助手（CDP 直连浏览器内核，与 F12 DevTools 同一套底层协议）。当前是对话模式：纯对话时直接回答，不调用工具；用户询问你的能力时，按下面的能力清单如实回答，不要因为当前是对话模式就否认任务模式下的能力。`
          + (taskCtl && taskCtl.capabilityNote ? "\n\n" + taskCtl.capabilityNote : "") + await buildSkillsIndex("main_model") },
        ...history,
        { role: "user", content: (taskCtl?.progressNote ? taskCtl.progressNote + "\n\n【当前提问】" + text : text) }
      ],
      temperature: 0.7,
      max_tokens: 4096, // 审查 3.11：1024 → 4096（纯对话长知识点不再中途截断）
      ...(taskCtl?.noThink ? { thinking: { type: "disabled" } } : {}), // 禁思考：直接作答
      ...keepAliveForLocal(config.baseUrl),
      stream: true
    })
  };
  let buf = "";
  let sawReasoning = false; // 推理曾出现 → 结束后补 reasoning_end（面板据此把思考块封口为"思考完成"）
  const thinkCap = taskCtl?.thinkingLimit > 0 ? taskCtl.thinkingLimit : 0; // 思考硬上限（对话模式）
  await llmCallWithRetry(() => {
    buf = "";
    let reasoningStarted = false; // 每轮（重试）独立的 start 标记，防止多次推送 reasoning_start
    let reasoningLen = 0; // 思考硬收口计数
    return streamChatCompletion(endpoint, llmBody, ({ json, done }) => {
      if (done) return;
      const delta = json.choices?.[0]?.delta;
      const rText = (delta && (delta.reasoning_content || delta.reasoning)) || ""; // 兼容 Ollama/Qwen3 delta.reasoning
      if (rText) {
        if (thinkCap > 0 && reasoningLen >= thinkCap) return; // 硬上限：后续思考不再下发/入史
        const room = thinkCap > 0 ? thinkCap - reasoningLen : rText.length;
        const part = thinkCap > 0 ? rText.substring(0, room) : rText;
        if (!part) return;
        sawReasoning = true;
        reasoningLen += part.length;
        if (!reasoningStarted) {
          reasoningStarted = true;
          if (onStatus) onStatus({ type: "reasoning_start", round: 0 });
        }
        if (onStatus) onStatus({ type: "reasoning_delta", text: part, round: 0 });
      }
      if (delta?.content) {
        buf += delta.content;
        if (onStatus) onStatus({ type: "answer_delta", text: delta.content, round: 0 });
      }
    }, { signal: abortController.signal });
  }, { signal: abortController.signal });
  if (sawReasoning && onStatus) onStatus({ type: "reasoning_end", round: 0 });
  return buf;
}
