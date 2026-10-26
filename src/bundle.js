// ==== 项目备份包（方案 009 / P6） ====
// 导出：项目 + 证据 + 身份（可选）+ 序列 + 基线。
// 导入：校验 → 新建项目 → 逐项写入 → 失败回滚（删除新项目，级联清理）。

import { getProject, saveProject, createProject, deleteProject, listProjects } from "./memory.js";
import { listEvidence, getEvidence, saveEvidence } from "./evidence.js";
import { listIdentities, getIdentity, saveIdentity } from "./identity.js";
import { listSequences, getSequence, saveSequence } from "./sequence.js";
import { listBaselines, getBaseline, saveBaseline } from "./baseline.js";

export const BUNDLE_SCHEMA = 1;

export async function exportBundle({ projectId, includeIdentities = false } = {}) {
  const project = await getProject(projectId);
  if (!project) return { error: "项目不存在", code: "NOT_FOUND" };
  const evs = (await listEvidence(projectId)).evidences || [];
  const evidence = [];
  for (const m of evs) {
    const rec = await getEvidence(m.id);
    if (rec) evidence.push(rec);
  }
  const seqs = (await listSequences(projectId)).sequences || [];
  const sequences = [];
  for (const m of seqs) {
    const rec = await getSequence(m.id);
    if (rec) sequences.push(rec);
  }
  const bls = (await listBaselines(projectId)).baselines || [];
  const baselines = [];
  for (const m of bls) {
    const rec = await getBaseline(m.id);
    if (rec) baselines.push(rec);
  }
  const identities = [];
  if (includeIdentities) {
    const ids = (await listIdentities(projectId)).identities || [];
    for (const m of ids) {
      const rec = await getIdentity(m.id);
      if (rec) identities.push(rec);
    }
  }
  return {
    ok: true,
    bundle: {
      schema: BUNDLE_SCHEMA,
      app: "F12x",
      exportedAt: Date.now(),
      project: {
        name: project.name, desc: project.desc || "",
        variables: project.variables || {},
        facts: project.facts || [], issues: project.issues || [], templates: project.templates || [],
      },
      evidence, identities, sequences, baselines,
    },
  };
}

export async function importBundle(bundle, opts = {}) {
  if (!bundle || bundle.schema !== BUNDLE_SCHEMA || !bundle.project) {
    return { error: "不是有效的 F12x 备份包（schema 不匹配）", code: "INVALID" };
  }
  const baseName = String(bundle.project.name || "导入项目").trim().substring(0, 40) || "导入项目";
  const existing = await listProjects();
  const has = (n) => existing.some((p) => String(p.name || "").trim().toLowerCase() === String(n).trim().toLowerCase());
  let name = baseName;
  if (has(name)) name = (baseName + "（导入）").substring(0, 50);
  if (has(name)) name = (baseName + "（导入 " + Date.now().toString(36) + "）").substring(0, 50);

  const project = await createProject(name, bundle.project.desc || "");
  if (project?.error) return project;
  const pid = project.id;
  const counts = { evidence: 0, identities: 0, sequences: 0, baselines: 0 };
  try {
    // 1) 先写子实体（此时问题单还未关联证据）
    const evMap = {};
    for (const ev of (bundle.evidence || [])) {
      const r = await saveEvidence({ ...ev, id: undefined, projectId: pid, title: ev.title, kind: ev.kind, request: ev.request, response: ev.response, diff: ev.diff, tags: ev.tags, notes: ev.notes });
      if (r.error) throw new Error("证据导入失败: " + r.error);
      evMap[ev.id] = r.id;
      counts.evidence++;
    }
    const idMap = {};
    for (const idn of (bundle.identities || [])) {
      const r = await saveIdentity({ ...idn, id: undefined, projectId: pid });
      if (r.error) throw new Error("身份导入失败: " + r.error);
      idMap[idn.id] = r.id;
      counts.identities++;
    }
    for (const seq of (bundle.sequences || [])) {
      const steps = (seq.steps || []).map((s) => ({ ...s, identityId: s.identityId && idMap[s.identityId] ? idMap[s.identityId] : "" }));
      const r = await saveSequence({ projectId: pid, name: seq.name, description: seq.description, steps });
      if (r.error) throw new Error("序列导入失败: " + r.error);
      counts.sequences++;
    }
    for (const bl of (bundle.baselines || [])) {
      const r = await saveBaseline({ ...bl, id: undefined, projectId: pid });
      if (r.error) throw new Error("基线导入失败: " + r.error);
      counts.baselines++;
    }
    // 2) 项目正文（Issue 证据引用重映射）
    const issues = (bundle.project.issues || []).map((it) => ({
      ...it,
      evidenceIds: (it.evidenceIds || []).map((x) => evMap[x]).filter(Boolean),
    }));
    await saveProject({
      ...project,
      facts: bundle.project.facts || [],
      issues,
      templates: bundle.project.templates || [],
      variables: bundle.project.variables || {},
    });
    return { ok: true, projectId: pid, name, counts };
  } catch (e) {
    try { await deleteProject(pid); } catch (err) { /* 回滚失败保留错误 */ }
    return { error: e.message, code: "IMPORT_FAILED" };
  }
}
