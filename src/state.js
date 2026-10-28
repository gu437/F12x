// ============================================================
// F12x state 模块（重构 v0.2）：工具台状态 + AI 任务运行态
// 设计原则（方案）：单数据源在 background；sidePanel 为纯视图
// ============================================================

// --- 工具台状态（手动操作层） ---
export const appState = {
  attached: false,        // debugger 已附加
  debuggeeUrl: "",        // 当前调试页面 URL
  inspectMode: false,     // Inspect 点选模式开关
  interceptMode: "off",   // 拦截模式：off / manual_next / all
  interceptQueue: [],     // 待处理拦截队列（v1）
  activeSiteId: null,     // 当前站点工作区
  llmConfigured: false,   // LLM 是否已配置
  version: "0.6.0"
};

// --- AI 任务运行态（原 3.2 taskState 保留，agent 引擎兼容） ---
export const taskState = {
  config: null,
  conv: null,
  abort: null,
  paused: false,
  expertCalls: 0,
  taskRunning: false,
  pendingTask: null,
  lastTaskReply: "",
  lastTaskRounds: 0,
  port: null,              // agent-stream port（AI 状态推送）
  approvalDeferred: null,  // 批准等待闸门（v1 批准阻塞设计）
  pendingApproval: null,   // 持久化未决批准（SW 生命周期防护）
  _approvalTimer: null     // 批准等待 120s 超时定时器
};

// 批准闸门接管放行（方案 5.1 / 14.1 / 14.7①）：
// 用户接管（暂停/开拦截）→ 立即按"拒绝"放行正在等待的批准，写操作绝不自动批准
export function abortPendingApproval(reason) {
  const d = taskState.approvalDeferred;
  if (!d) return false;
  taskState.approvalDeferred = null;
  if (taskState._approvalTimer) { clearTimeout(taskState._approvalTimer); taskState._approvalTimer = null; }
  taskState.pendingApproval = null;
  try { chrome.storage.local.remove("f12x_pending_approval_v1"); } catch (e) {}
  d({ decision: "rejected", approvedCalls: [], reason: reason || "用户接管" });
  return true;
}

// 所有已连接的 sidePanel port（多个面板窗口场景）
const panelPorts = new Set();

export function registerPanelPort(port) {
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
}

// 广播任意消息到所有已连接 panel（stream 通道：bg → sidepanel）
export function broadcastToPanels(msg) {
  for (const port of panelPorts) {
    try { port.postMessage(msg); } catch (e) { panelPorts.delete(port); }
  }
  if (!panelPorts.size) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
  }
}

// AI 状态推送：优先 port 长连接（顺序保证），无 port 时 sendMessage 兜底
export function pushStatus(status) {
  // 修复（审读高）：为状态事件附加归属会话 convId——面板据此过滤"别的会话任务"的终态事件，
  // 杜绝 A 会话运行中切到 B 时被 A 的终态误结束
  if (status && typeof status === "object" && status.convId === undefined && taskState.conv?.convId) {
    status.convId = taskState.conv.convId;
  }
  const msg = { type: "status", status };
  for (const port of panelPorts) {
    try { port.postMessage(msg); } catch (e) { panelPorts.delete(port); }
  }
  if (!panelPorts.size) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
  }
}

// 最终回答打字机重放
export async function typewriterPush(text, onStatus) {
  if (!text) return;
  const CHUNK = 16;
  const DELAY = 12;
  for (let i = 0; i < text.length; i += CHUNK) {
    onStatus({ type: "answer_delta", text: text.substring(i, i + CHUNK), round: 0 });
    await new Promise(r => setTimeout(r, DELAY));
  }
}
