// ============================================================
// F12x expert_round 模块（方案_v3：Expert Round 回合引擎）
// 把专家从"单次 JSON 分析"升级为"有界只读回合"：
//   建上下文 -> 模型自主选只读工具查证 <=maxSteps 步 -> 收敛 JSON 结论
// 护栏：只读白名单（allowedTools 注入）、步数上限、signal 直通、
//       单 debugger 串行（主代理轮内同步执行）；失败/中止返回 null，调用方降级旧单次分析
// ============================================================
import { llmCallWithRetry, streamChatCompletion, extractJsonObject, normalizeEndpoint } from "./llm.js";
import { TOOL_DEFINITIONS } from "./prompts.js";
import { dispatchTool } from "./executor.js";
import { pushStatus } from "./state.js";

export const EXPERT_ROUND_MAXSTEPS = 3; // 复核默认 ≤3 步（收敛版 A：比 6 角色回合更轻）
const STEP_RESULT_MAX = 6000;           // 单步工具结果回传模型的上限

function toolDefs(allowed) {
  const set = new Set(allowed || []);
  return TOOL_DEFINITIONS.filter(t => set.has(t.name)).map(t => ({ type: "function", function: t }));
}
function briefArgs(a) {
  const s = JSON.stringify(a || {});
  return s && s.length > 90 ? s.substring(0, 90) + "…" : (s || "");
}
function collectToolCalls(streamed) {
  const calls = [];
  for (const tc of streamed) {
    if (!tc) continue;
    const idx = tc.index || 0;
    if (!calls[idx]) calls[idx] = { id: "", name: "", arguments: "" };
    if (tc.id) calls[idx].id = tc.id;
    if (tc.function?.name) calls[idx].name += tc.function.name;
    if (tc.function?.arguments) calls[idx].arguments += tc.function.arguments;
  }
  return calls.filter(Boolean);
}

export async function runExpertRound(opts) {
  const { expertId, rolePrompt, allowedTools, focus, config, signal, zhName } = opts;
  if (!config?.apiKey || !focus || !expertId) return null;
  const endpoint = normalizeEndpoint(config.baseUrl);
  const maxSteps = Math.min(Math.max(1, opts.maxSteps || EXPERT_ROUND_MAXSTEPS), 8);
  const zh = zhName || expertId;
  const seed = String(opts.seedData || "").substring(0, 8000);

  const system = (rolePrompt ? rolePrompt + "\n\n" : "")
    + "【中文身份】你是「" + zh + "」，主代理的只读侦察助手。\n"
    + "【本回合纪律】\n"
    + "1. 你可以自主调用只读工具查证，每调用一步都会实时呈现给用户。\n"
    + "2. 每步先极简说明你要查什么，然后只调一次工具；禁止连续调多个相同工具。\n"
    + "3. 你只能使用下列只读工具：" + (allowedTools || []).join("、") + "。\n"
    + "4. 只读意味着：不导航、不改包、不爆破、不写入、不调其他专家；需要写操作验证时写进 question_for_main 交给主代理。\n"
    + "5. 信息足够就收敛：结论必须由你本回合真实工具返回支撑，禁止臆造证据。\n"
    + "6. 思考精炼（你是专精辅助，不是主模型）：推理只用于决定下一步，每步 ≤2 句；持续长考/空转而无工具行动视为低效，将被强制收敛并计入降级。\n"
    + "7. 最后只输出一个 JSON 对象（无解释、无 markdown 围栏）。\n"
    + (opts.goal ? "【主代理任务目标】" + String(opts.goal).substring(0, 800) + "\n" : "")
    + "【本轮要回答的问题】" + String(focus).substring(0, 1500) + "\n"
    + (seed ? "【待分析数据（主代理喂入的种子）】\n" + seed : "");

  const messages = [{ role: "system", content: system }, { role: "user", content: "请开始：先按需查证（至多 " + maxSteps + " 步），再输出 JSON。字段：findings/evidence/next_action/confidence/question_for_main/verified(仅当结论被本回合工具返回直接支撑才 true)/tool_trail(本次实际调用的工具名数组)。" }];

  let reasoningAll = "";
  const toolTrail = [];
  let toolOkCount = 0;
  let synthesis = null;
  let stepIdx = 0;
  let reasoningBudgetHit = false; // 防空想：推理超限标记（随后强制要求直接收敛 JSON）

  const sendReasonSafe = (delta) => { if (delta) { reasoningAll = (reasoningAll + delta).slice(-12000); if (opts.onReasoning) opts.onReasoning(delta); } };
  const sendReason = (delta) => {
    if (!delta) return;
    reasoningAll = (reasoningAll + delta).slice(-12000);
    if (opts.onReasoning) opts.onReasoning(delta);
    // 防空想（专家层）：整回合推理超限且尚无一笔产出时，掐断本轮并标记强制收敛
    if (reasoningAll.length > 6000 && toolTrail.length === 0 && !synthesis) {
      reasoningBudgetHit = true;
      throw new Error("expert_reasoning_budget");
    }
  };

  try {
    while (stepIdx < maxSteps) {
      const body = {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.apiKey },
        body: JSON.stringify({
          model: config.expertModel || config.model,
          messages,
          tools: toolDefs(allowedTools),
          tool_choice: "auto",
          temperature: 0.2,
          max_tokens: 4096, // 专家轻思考：预算低于主模型，防"专家≈主模型"的同质化开销
          stream: true,
          stream_options: { include_usage: true }
        })
      };
      let contentBuf = "";
      const streamedCalls = [];
      await llmCallWithRetry(() => streamChatCompletion(endpoint, body, ({ json, done }) => {
        if (done || signal?.aborted) return;
        const delta = json.choices?.[0]?.delta || {};
        if (delta.reasoning_content || delta.reasoning) sendReason(delta.reasoning_content || delta.reasoning);
        if (delta.content) contentBuf += delta.content;
        if (delta.tool_calls) { for (const tc of delta.tool_calls) streamedCalls.push(tc); }
      }, { signal }), { signal, retries: 1 });

      const toolCalls = collectToolCalls(streamedCalls);
      if (toolCalls.length) {
        messages.push({ role: "assistant", content: contentBuf || "", tool_calls: toolCalls.map(tc => ({ id: tc.id || ("ec_" + stepIdx + "_" + Math.random().toString(36).slice(2, 6)), type: "function", function: { name: tc.name, arguments: tc.arguments } })) });
        for (const tc of toolCalls) {
          if (signal?.aborted) throw new Error("aborted");
          const name = tc.name;
          const callId = tc.id || ("ec_" + stepIdx + "_" + Math.random().toString(36).slice(2, 6));
          let args = {};
          try { args = JSON.parse(tc.arguments || "{}"); } catch (_) {}
          stepIdx++;
          if (!(allowedTools || []).includes(name)) {
            messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify({ error: "该工具不在本专家只读白名单中：" + name }) });
            continue;
          }
          pushStatus({ type: "expert_step", expert: zh, tool: name, args: briefArgs(args), step: stepIdx, round: 0 });
          let result;
          try { result = await dispatchTool(name, args, { mode: "ai", signal, expert: true }); }
          catch (e) { result = { ok: false, error: String((e && e.message) || e) }; }
          const text = JSON.stringify(result);
          const capped = text && text.length > STEP_RESULT_MAX ? text.substring(0, STEP_RESULT_MAX) + "…" : (text || "");
          messages.push({ role: "tool", tool_call_id: callId, content: capped });
          const ok = !(result && (result.ok === false || result.error));
          if (ok) toolOkCount++;
          toolTrail.push({ step: stepIdx, tool: name, args: briefArgs(args), ok });
          pushStatus({ type: "expert_tool_done", expert: zh, tool: name, step: stepIdx, ok });
        }
        continue;
      }

      const parsed = extractJsonObject(contentBuf);
      if (parsed && parsed.findings !== undefined) { synthesis = parsed; break; }
      stepIdx++;
      messages.push({ role: "user", content: "请停止叙述，直接输出最终 JSON 对象（字段：findings/evidence/next_action/confidence/question_for_main/verified/tool_trail）。" });
    }

    if (!synthesis) return null;
    const evidence = String(synthesis.evidence || "");
    // M1 防伪：verified 仅在 本回合确有成功只读工具调用 + evidence 非空 + 模型声明 时成立
    const verified = !!(synthesis.verified === true && toolOkCount > 0 && evidence.trim().length > 2);
    return {
      expert: expertId,
      zh,
      reasoning: reasoningAll.substring(0, 6000),
      findings: String(synthesis.findings || "").substring(0, 500),
      evidence: evidence.substring(0, 500),
      nextAction: String(synthesis.next_action || "").substring(0, 500),
      confidence: ["high", "medium", "low"].includes(synthesis.confidence) ? synthesis.confidence : "medium",
      questionForMain: String(synthesis.question_for_main || "").substring(0, 300),
      verified,
      toolTrail,
      steps: stepIdx
    };
  } catch (e) {
    if (signal?.aborted || /abort/i.test(String((e && e.message) || ""))) return null;
    if (String((e && e.message) || "").includes("expert_reasoning_budget")) {
      // 防空想（专家层）：推理超限——不再空耗，强制一步收敛；失败再降级
      try {
        const last = await (async () => {
          const budgetBody = {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.apiKey },
            body: JSON.stringify({ model: config.expertModel || config.model, messages, temperature: 0.1, max_tokens: 2048, stream: true })
          };
          let buf = "";
          await llmCallWithRetry(() => streamChatCompletion(endpoint, budgetBody, ({ json, done }) => {
            if (done) return;
            const d = json.choices?.[0]?.delta || {};
            if (d.reasoning_content || d.reasoning) sendReasonSafe(d.reasoning_content || d.reasoning);
            if (d.content) buf += d.content;
          }, { signal }), { signal, retries: 0 });
          return buf;
        })();
        const forced = extractJsonObject(last);
        if (forced && forced.findings !== undefined) {
          const evidence = String(forced.evidence || "");
          return {
            expert: expertId, zh, reasoning: reasoningAll.substring(0, 6000),
            findings: String(forced.findings || "").substring(0, 500), evidence: evidence.substring(0, 500),
            nextAction: String(forced.next_action || "").substring(0, 500),
            confidence: ["high", "medium", "low"].includes(forced.confidence) ? forced.confidence : "medium",
            questionForMain: String(forced.question_for_main || "").substring(0, 300),
            verified: false, toolTrail, steps: stepIdx
          };
        }
      } catch (e2) { /* 收敛失败 → 降级 */ }
      console.warn("[ExpertRound] 专家推理超限，已强制收敛或降级");
      return null;
    }
    console.warn("[ExpertRound] 回合异常，降级：", e && e.message);
    return null;
  }
}
