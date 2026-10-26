// ==== AI 资产读取 / 测试计划（方案 009 / 6.6） ====
// 只读：AI 可读项目证据/身份/请求/序列/基线/端点；返回原文（不脱敏）。
// propose_tests 只生成计划，不发送请求。

import { listEvidence, getEvidence } from "./evidence.js";
import { listIdentities, getIdentity } from "./identity.js";
import { listRequests, getRequest } from "./assets.js";
import { listSequences, getSequence } from "./sequence.js";
import { listBaselines, getBaseline } from "./baseline.js";
import { getInventory } from "./assets.js";
import { extractRefs, candidatesFor } from "./mutate.js";

const KINDS = ["evidence", "identity", "request", "sequence", "baseline", "inventory"];

function kindOf(k) {
  const s = String(k || "").toLowerCase();
  return KINDS.includes(s) ? s : "";
}

export async function summarizeAssets(projectId) {
  if (!projectId) return { evidence: [], counts: {}, identities: [] };
  const [ev, idn, rq, sq, bl] = await Promise.all([
    listEvidence(projectId), listIdentities(projectId), listRequests(projectId),
    listSequences(projectId), listBaselines(projectId),
  ]);
  return {
    counts: {
      evidence: ev.count || 0, identity: idn.count || 0, request: rq.count || 0,
      sequence: sq.count || 0, baseline: bl.count || 0,
    },
    evidence: (ev.evidences || []).slice(0, 5).map((x) => ({ id: x.id, title: x.title, status: x.status, method: x.method, url: x.url, identityName: x.identityName })),
    identities: (idn.identities || []).slice(0, 8).map((x) => ({ id: x.id, name: x.name, cookieCount: x.cookieCount, headerKeys: x.headerKeys })),
  };
}

export async function listAssets(projectId, kind, limit = 50) {
  const k = kindOf(kind);
  if (!k) return { error: `kind 必须是 ${KINDS.join("/")}` };
  if (!projectId) return { error: "未绑定项目" };
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  if (k === "inventory") {
    const inv = await getInventory(projectId);
    return { ok: true, kind: k, count: (inv.endpoints || []).length, items: (inv.endpoints || []).slice(0, n) };
  }
  const map = {
    evidence: [listEvidence, "evidences"],
    identity: [listIdentities, "identities"],
    request: [listRequests, "requests"],
    sequence: [listSequences, "sequences"],
    baseline: [listBaselines, "baselines"],
  };
  const [fn, key] = map[k];
  const res = await fn(projectId);
  return { ok: true, kind: k, count: res.count || 0, items: (res[key] || []).slice(0, n) };
}

export async function getAsset(projectId, kind, id) {
  const k = kindOf(kind);
  if (!k) return { error: `kind 必须是 ${KINDS.join("/")}` };
  if (k === "inventory") {
    const inv = await getInventory(projectId);
    return { ok: true, kind: k, asset: inv };
  }
  if (!id) return { error: "id 必填" };
  const fn = { evidence: getEvidence, identity: getIdentity, request: getRequest, sequence: getSequence, baseline: getBaseline }[k];
  const rec = await fn(id);
  if (!rec) return { error: "不存在: " + id };
  if (projectId && rec.projectId && rec.projectId !== projectId) return { error: "该资产不属于当前项目" };
  return { ok: true, kind: k, asset: rec };
}

export async function proposeTests(projectId, request = {}, goal = "") {
  const refs = extractRefs(request).refs || [];
  const ids = projectId ? (await listIdentities(projectId)).identities || [] : [];
  const checks = [];
  if (refs.length) {
    const values = [];
    for (const r of refs.slice(0, 5)) for (const v of [r.value, ...(candidatesFor(r, "neighbors", 3) || [])]) if (!values.includes(v)) values.push(v);
    checks.push({
      type: "idor", priority: "high",
      refs: refs.map((r) => ({ id: r.id, label: r.label, value: r.value })),
      values: values.slice(0, 20),
      how: "选两个身份，对同一请求逐个替换对象引用；比较状态/长度/字段差异（ownerId/email/role）。",
      identities: ids.map((x) => x.name),
    });
  }
  checks.push({
    type: "bfla", priority: "high",
    how: "同一路径换方法/换角色身份重放；重点看 2xx vs 403 与响应字段。",
    identities: ids.map((x) => x.name),
  });
  checks.push({
    type: "csrf", priority: "medium",
    how: "去掉 Origin/Referer/CSRF token 后重放；看是否仍成功。",
  });
  if (refs.length) {
    checks.push({
      type: "injection", priority: "medium",
      values: ["'", "\"", "1' OR '1'='1", "<script>alert(1)</script>", "../../etc/passwd"],
      how: "对引用/参数注入 payload，比较响应差异/报错/时间；命中后到浏览器验证执行。",
    });
  }
  return {
    ok: true, goal: String(goal || ""),
    request: { method: request.method || "GET", url: request.url || "" },
    refs, identities: ids.map((x) => ({ id: x.id, name: x.name, cookieCount: x.cookieCount })),
    checks,
    note: "这是测试计划，不是结论；未发送任何请求。",
  };
}
