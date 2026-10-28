// ============================================================
// F12x — Background Service Worker（瘦入口，v0.2 七层架构组装）
// 职责：sidePanel 入口 + stream 通道（port 长连接）+ ctrl 消息路由 + 数据总线桥 + 启动初始化
//
// 模块拆分（按职责下沉至 src/）：
//   src/state.js    工具台状态 + AI 任务运行态 + panel port 管理 + pushStatus/broadcastToPanels
//   src/bus.js      background 内部数据总线（debugger 事件 → bus → stream 转发）
//   src/router.js   ctrl 通道消息路由（手动工具层 + 站点 API + AI 懒加载）
//   src/debugger.js CDP 连接 + 底层工具（Inspect / 拦截 / 来源标记）
//   src/llm.js / src/memory.js / src/agent.js / src/executor.js（AI 引擎，懒加载隔离）
// ============================================================
import { taskState, registerPanelPort, broadcastToPanels } from "./src/state.js";
import { busOn } from "./src/bus.js";
import { handleMessage } from "./src/router.js";
import { loadEndpoints } from "./src/llm.js";
import { cleanupStaleDebugger, recoverInterceptSnapshot, networkSnapshot, consoleSnapshot, backfillFromPerformance } from "./src/debugger.js";
import { recoverPendingApproval } from "./src/agent.js";
import { migrateConversationsIfNeeded, migrateProjectsIfNeeded, migrateSitesToProjectsIfNeeded, migrateIssuesToProjectsIfNeeded, cleanupLegacyKeys } from "./src/memory.js";

// --- sidepanel 入口 ---
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// --- stream 通道：bg → sidepanel（顺序保证） ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "agent-stream") {
    taskState.port = port; // AI 状态推送主通道（agent 引擎兼容）
    registerPanelPort(port); // 统一 panel 集合（多面板窗口）
    // 面板重开回填（方案十二.2）：hello → 快照（SW 内存）+ performance 回填（SW 重启场景）
    port.onMessage.addListener(async (msg) => {
      if (msg && msg.type === "hello") {
        try {
          await backfillFromPerformance();
          port.postMessage({ type: "stream", event: "network:snapshot", data: { items: networkSnapshot() } });
          port.postMessage({ type: "stream", event: "console:snapshot", data: { items: consoleSnapshot() } });
        } catch (e) { console.warn("[F12x] 面板回填失败:", e.message); }
      }
    });
    port.onDisconnect.addListener(() => {
      if (taskState.port === port) taskState.port = null;
    });
  }
});

// --- 数据总线桥：bus（数据采集层）→ stream 转发 → panel 视图 ---
// 单数据源原则：debugger 事件先入 bus，再统一经此桥推给所有已连接面板
busOn(({ event, data }) => {
  broadcastToPanels({ type: "stream", event, data });
});

// --- ctrl 通道消息路由入口（type → handler 分发，详见 src/router.js） ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => handleMessage(message, sender, sendResponse));

// ============================================================
// SW 生命周期防护（方案 14.1 修复）：chrome.alarms 每 20s 保活 SW
// 批准等待 / 拦截等待等异步挂起期间，SW 被 kill 会导致等待丢失——
// 周期性 alarm 触发保持 SW 活跃；未决请求持久化见 src/agent.js
// ============================================================
chrome.alarms.create("f12x-keepalive", { periodInMinutes: 1 / 3 }); // 每 20s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "f12x-keepalive") {
    // 轻量自检：清理失效 port（触发后无操作也会重置 SW 空闲计时器）
    if (taskState.port && taskState.port.disconnected) taskState.port = null;
  }
});

// ============================================================
// 启动：加载配置 → 清理残留调试会话
// ============================================================
async function init() {
  await loadEndpoints();
  // 会话存储迁移（全量数组 → 索引 + 每会话一键；幂等）
  try { await migrateConversationsIfNeeded(); } catch (e) { console.warn("[F12x] 会话迁移失败:", e.message); }
  try { await migrateProjectsIfNeeded(); } catch (e) { console.warn("[F12x] 项目迁移失败:", e.message); }
  try { await migrateSitesToProjectsIfNeeded(); } catch (e) { console.warn("[F12x] 站点迁移失败:", e.message); }
  try { await migrateIssuesToProjectsIfNeeded(); } catch (e) { console.warn("[F12x] Issue 迁移失败:", e.message); }
  try { const c = await cleanupLegacyKeys(); if (c.removed) console.log("[F12x] 已清理旧存储键:", c.keys.join(", ")); } catch (e) { console.warn("[F12x] 旧键清理失败:", e.message); }
  await cleanupStaleDebugger(); // 清理残留调试会话，避免 "Another debugger is already attached"
  await recoverInterceptSnapshot(); // 14.1：SW 复活时拦截队列断线放行兜底
  // 14.1 ②：SW 复活时恢复未决批准 → 重新弹批准条（静态导入；AI 隔离由运行时 LLM 配置检查保证）
  try {
    await recoverPendingApproval();
  } catch (e) {
    console.warn("[F12x] AI 引擎恢复批准失败（隔离，不影响工具台）:", e.message);
  }
  console.log("[F12x] Service Worker 启动完成 v0.5.2");
}
init();
