// ============================================================
// F12x bus 模块（新增 v0.2）：background 内部数据总线
// 数据采集层（debugger 事件）→ bus → port 转发 → sidePanel 视图
// 单数据源原则：所有流式数据先经 bus，再统一分发
// ============================================================

const listeners = new Set();

// 订阅 bus 事件；返回取消订阅函数
export function busOn(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 广播事件：{ event: string, data: any }
export function busEmit(event, data) {
  for (const fn of listeners) {
    try { fn({ event, data }); } catch (e) { /* 单订阅者异常不影响其他 */ }
  }
}
