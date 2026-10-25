// F12x guards 模块（模块化拆分，纯搬移零逻辑变更）
let analyzedFingerprints = []; // 已分析的数据指纹（去重门：同一数据不重复分析）

export function detectReviewTargets(planProgress, recentToolsSummary, toolCount) {
  const targets = [];
  const summary = String(recentToolsSummary || "");
  // a. 工具失败追踪：结果中出现错误/异常标记
  // 注意：null/undefined 是正常 JSON 数据（非失败）——只抓真实错误标记（与 failStreak 正则对齐）
  const errMatches = summary.match(/(error|失败|错误|exception|拒绝|拒绝访问|timeout|超时)/gi);
  if (errMatches && errMatches.length >= 2) {
    targets.push({
      type: "tool_failure",
      question: `最近工具结果中出现 ${errMatches.length} 处错误/异常标记——这些失败本身说明什么？你重试了还是绕过了？绕过是否掩盖了真实问题？`
    });
  }
  // b. 计划缺口：有未完成步骤
  const undoneCount = (planProgress || "").match(/\[ \]/g)?.length || 0;
  if (undoneCount > 0) {
    const undoneSteps = (planProgress || "").split("\n").filter(l => l.includes("[ ]")).slice(0, 2).map(l => l.replace(/^\s*\[ \]\s*/, "")).join("；");
    targets.push({
      type: "plan_gap",
      question: `执行计划还有 ${undoneCount} 个步骤未完成（如：${undoneSteps || "略"}）——为什么跳过？这些步骤对最终结论有影响吗？`
    });
  }
  // c. 数据充分性：工具调用很少却要宣布结论
  if ((toolCount || 0) < 3) {
    targets.push({
      type: "data_sufficiency",
      question: `当前只执行了 ${toolCount || 0} 次工具调用——你的关键结论有足够的实测数据支撑吗？哪些环节还是推测？`
    });
  }
  return targets;
}

// 对抗性审查问题：代码从实际任务数据中检测风险点并注入（外部视角，非模型自问自答）
export function buildSelfReviewQuestion(goal, planProgress, recentToolsSummary, phase, opts = {}) {
  const targets = opts.targets || detectReviewTargets(planProgress, recentToolsSummary, opts.toolCount);
  const lines = [];
  lines.push(`【对抗性审查·${phase}】以下是代码从当前任务数据中检测到的**风险点**——不是通用话术，是对你实际执行情况的核查：`);
  if (!targets.length) {
    // 无检测命中 → 动态引导（引用实际数据，不用固定话术）：让模型说清结论与数据的支撑关系
    const lastTool = String(recentToolsSummary || "").substring(0, 250).replace(/\n/g, " ");
    const doneSteps = (planProgress || "").split("\n").filter(l => l.includes("[x]")).length;
    lines.push(`- 你最近的工具结果${lastTool ? `（${lastTool}${lastTool.length >= 250 ? "…" : ""}）` : "（暂无）"}直接支撑了哪个关键结论？`);
    if (doneSteps > 0) lines.push(`- 已完成的 ${doneSteps} 个计划步骤中，哪一步的结论是推断而非实测？`);
    else lines.push("- 当前结论中，哪一步还是推断而非实测？");
  } else {
    targets.forEach((t, i) => lines.push(`${i + 1}. ${t.question}`));
  }
  lines.push(`
请以「自我审查回应」开头按此格式回答（**用工具验证，不要凭记忆自证**）：
自我审查回应：
- 我的结论：（一句话）
- 风险点回应：（针对上面的每个风险点用实测数据回答；未验证的明确承认"未验证"）
- 我如何验证：（需要验证的列出具体工具调用计划，如"用 get_network_request_detail 查看 /api/xxx 响应体"；无需验证的说明理由）
- 验证结果：（已执行验证的实测结果）

若发现方向有问题，调用 plan_write 整体修订执行流程后再继续；若质疑不成立，说明数据依据后继续执行。`);
  return lines.join("\n");
}

// 当前任务的 LLM 调用计数器（含主模型/专家/反驳/重试，runAgentLoop 开始时重置）
export function detectOverthinking(reasoningText) {
  if (!reasoningText) return 0;
  const len = reasoningText.length;
  const words = reasoningText.match(/(等等|等一下|让我想|让我想想|回忆|再想想|再想一下|嗯{2,}|我想想|思考一下|推测一下)/g);
  const count = words ? words.length : 0;
  // 密集自我对话 = 废话循环（深度思考不会反复"让我想想"）
  if (count >= 10 && len > 500) return 1;
  if (count >= 16) return 1;
  return 0;
}

// 乱猜检测（②模型乱猜不验证）：reasoning 中猜测性语言密集（可能/也许/大概/推测…）
// 一本正经的"分析"全是猜测（不用空想词）——v4 空想检测抓不到，这是补漏
// 渗透分析中"可能是"偶尔合理——只抓密集猜测（≥4 次），此时应提示用工具验证
// 返回 0=正常 1=乱猜需干预
export function detectGuessing(reasoningText) {
  if (!reasoningText) return 0;
  // P2 修复：阈值 4→6（DeepSeek 正常深度思考出现 4 个推测词是家常便饭——误报降级
  // 惩罚正常分析；触发后只是提示/渐进降级，误报成本 = 一轮提示，漏报成本 = 乱猜结论）
  const words = reasoningText.match(/(可能是|大概是|或许是|说不定|可能|也许|大概|或许|应该|推测|猜测|估计)/g);
  const count = words ? words.length : 0;
  if (count >= 6 && reasoningText.length > 300) return 1;
  return 0;
}

// 结论声称检测（通用结构，不固化领域词——任何场景的"我做到了 X"都检测，换说法绕不过）：
// 完成式结论动词（发现/找到/确认/成功/完成/解决/搞定/获取/拿到/读取/捕获/得到/实现/定位/识别）
// 后跟完成助词或宾语（了/到/出/下/成功…）→ "发现了 X" "成功获取 X" "完成了 X" "定位到了问题"
// 支撑判定在调用方：工具结果有实质数据（非 error/非空）→ 放行；无支撑 → 拦截
export function detectUnverifiedClaim(text) {
  if (!text) return false;
  // P2 修复（2.8 阈值调优）：动词后需 10-30 字符的实质宾语且句内无标点中断——
  // "完成了。"这类短句/已完结句不再误触发（原 0-30 字符任意内容都触发——
  // 正常报告总结句几乎必中）；"成功获取了管理接口的返回数据并确认无鉴权"这类
  // 实质性宣称仍拦截
  return /(发现|找到|确认|成功|完成|解决|搞定|获取|拿到|读取|捕获|得到|实现|定位|识别)(了|到|出|下|成功|完成)?[^。！？\n]{10,30}/i.test(text);
}

// 工具支撑判定（结构性，不固化领域词）：工具结果有实质数据（非空且非纯 error）即视为有实测支撑
export function toolResultHasSubstance(toolResults) {
  return toolResults.some(c => {
    const s = String(c || "").trim();
    return s.length > 30 && !/^\{?"?error/i.test(s);
  });
}

// 审查 2.3：handleGuessingIntervention 死代码（background 内联实现了同逻辑——
// 此导出无人接线，守卫库职责边界脱节）——删除。检测器 detectGuessing 保留
// （background 内联逻辑直接调用 detectGuessing）

// 数据指纹（去重门）：工具名 + 结果哈希 → 判断该数据是否已分析过
// P1 修复：FNV-1a 哈希替代"前 200 字符截断"——get_network_requests 列表
// 前缀相同导致不同数据误判已分析（漏分析）或时间戳导致重复分析（烧钱）
export function makeFingerprint(toolName, resultStr) {
  const s = String(resultStr || "");
  let hash = 0x811c9dc5;
  const input = toolName + ":" + s;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return toolName + ":" + hash.toString(16);
}
// 任务级守卫状态重置（runAgentLoop 开始调用）：指纹去重门不跨任务共享
// （修复：原模块级数组跨任务误判"已分析"跳过专家分析；SW 回收清零导致任务中途失忆）
export function resetGuards() {
  analyzedFingerprints = [];
}

export function isAlreadyAnalyzed(fp) {
  return analyzedFingerprints.includes(fp);
}
export function markAnalyzed(fp) {
  analyzedFingerprints.push(fp);
  if (analyzedFingerprints.length > 50) analyzedFingerprints.shift(); // 只保留最近 50 个指纹
}

// LLM 调用重试包装：瞬时错误（网络/5xx/429/超时）指数退避重试
// 用户中止（AbortError/signal.aborted）不重试
// 重试时通过 resetFn 重置流式累积状态，防止内容重复