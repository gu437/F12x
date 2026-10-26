// ============================================================
// F12x 复核审计员（方案_v3 收敛版 A）：
// 由"6 角色专家池"收敛为**单一复核审计员**——只在关键结论点/卡死救援/
// 显式请求时，用 ≤3 步只读工具对结论做独立复核，输出 verified 与质疑点。
// 主代理的纠偏/深查/防失控均已在主引擎闭环（对抗审查/防空想/计划），不再需要多角色副脑。
// ============================================================
import { runExpertRound } from "./expert_round.js";

export const TOOL_NAMES_CN = {
  get_page_skeleton: "获取页面骨架", search_dom: "搜索 DOM", get_network_requests: "获取网络请求",
  get_network_request_detail: "查看请求详情", get_cookies: "获取 Cookie", get_script_list: "获取脚本列表",
  get_script_content: "查看脚本源码", eval_js: "执行 JS", navigate: "导航",
  get_console_logs: "获取控制台日志", replay_request: "重放请求", highlight_element: "高亮元素", screenshot: "截图",
  decode_text: "编解码", compare_responses: "响应对比", intruder: "变体请求",
  upsert_fact: "记录黑板事实",
  get_fact: "读取黑板事实", rebuttal_check: "重大结论自检", workspace_note: "工作区记录",
  get_skill: "读取技能", call_expert: "请求复核", replan: "重新规划", plan_write: "提交/更新执行流程", read_spilled: "读取溢出区全文", list_assets: "查看项目资产", get_evidence: "读取证据原文", get_asset: "读取资产原文", propose_tests: "生成测试计划"
};

// 复核审计员的角色提示（唯一角色：独立复核，不越权行动）
export const REVIEW_EXPERT_ID = "review";
export const REVIEW_ZH = "复核审计员";
export const REVIEW_EXPERT_PROMPT = `你是主代理的复核审计员。你的唯一职责：对主代理给出的**关键结论**做独立复核——不执行任务、不接管行动、不做无工具支撑的猜测。
复核要求：
1. 用只读工具（允许清单见下）**实际查证**关键证据是否成立（响应/状态码/代码行/Cookie 等），不要凭主代理转述轻信。
2. 指出结论中的疑点（替代解释/未验证环节/证据薄弱处），能当场验证的当场验证。
3. 需要写操作才能定论的，写进 question_for_main 交回主代理，绝不越权。
4. 输出 JSON：findings/evidence/next_action/confidence/question_for_main/verified(仅当本回合确有成功只读调用且证据支撑结论才 true)/tool_trail。
5. 思考精炼：推理只用于决定查什么（每步 ≤2 句），不空想不猜测。`;

// 复核可用只读工具（主代理只读工具的子集，保证"复核不产生副作用"）
export function reviewAllowedTools() {
  return ["get_page_skeleton", "search_dom", "get_network_requests", "get_network_request_detail",
    "get_console_logs", "get_cookies", "get_script_list", "get_script_content",
    "read_spilled", "get_fact", "get_skill", "decode_text"];
}

// 执行一次复核（wrapper：拼装上下文 → 复用只读回合引擎 → 同形状返回；失败返 null 由调用方兜底）
// opts: { focus(必填), goal?, seedData?, config, signal?, onReasoning?, maxSteps? }
export async function runReviewAudit(opts) {
  if (!opts?.focus || !opts?.config?.apiKey) return null;
  return runExpertRound({
    expertId: REVIEW_EXPERT_ID,
    zhName: REVIEW_ZH,
    rolePrompt: REVIEW_EXPERT_PROMPT,
    allowedTools: reviewAllowedTools(),
    goal: opts.goal,
    focus: opts.focus,
    seedData: opts.seedData || "",
    config: opts.config,
    signal: opts.signal || null,
    onReasoning: opts.onReasoning || null,
    maxSteps: opts.maxSteps || 3
  });
}
