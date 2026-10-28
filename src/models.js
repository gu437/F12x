// F12x 多模型管理（模型条目 = 名称 + API Key + Base URL + 模型名）
// 引擎唯一读取点仍是 llmConfig（getLLMConfig 不变）：每次运行前把“会话选定/默认”的模型合并写入 llmConfig。
// 用户主导：列表与默认模型由人在设置中维护；会话可各自记忆所用模型（conv.modelId，null=跟随默认）。
const MODELS_KEY = "f12x_models_v1";
const ACTIVE_KEY = "f12x_model_active";

export async function listModels() {
  const r = await chrome.storage.local.get(MODELS_KEY);
  return Array.isArray(r[MODELS_KEY]) ? r[MODELS_KEY].map(normalizeModel) : [];
}

// 写模型列表（唯一入口：router 的 model:save / settings:save）——面板不再直接触碰存储
export async function saveModels(list) {
  await chrome.storage.local.set({ [MODELS_KEY]: Array.isArray(list) ? list.map(normalizeModel) : [] });
}

export async function getModelById(id) {
  if (!id) return null;
  const list = await listModels();
  return list.find(m => m.id === id) || null;
}

export async function getActiveModelId() {
  const [r, list] = await Promise.all([chrome.storage.local.get(ACTIVE_KEY), listModels()]);
  const id = r[ACTIVE_KEY];
  return list.some(m => m.id === id) ? id : (list.length ? list[0].id : null);
}

// 模型条目规范化：旧条目缺字段时补默认值，不改 id/名称。
// contextWindow 是“模型自己的窗口”，不是全局默认；0 表示未填写。
function normalizeModel(m = {}) {
  const cw = Number(m.contextWindow);
  return {
    ...m,
    id: String(m.id || ""),
    name: String(m.name || "").trim(),
    provider: String(m.provider || "openai").trim() || "openai",
    apiKey: String(m.apiKey || "").trim(),
    baseUrl: String(m.baseUrl || "").trim(),
    model: String(m.model || "").trim(),
    contextWindow: Number.isFinite(cw) && cw > 0 ? Math.round(cw) : 0,
    maxInputTokens: Number(m.maxInputTokens) > 0 ? Math.round(Number(m.maxInputTokens)) : 0,
    maxOutput: Number(m.maxOutput) > 0 ? Math.round(Number(m.maxOutput)) : 8192,
    windowMode: m.windowMode === "separate" ? "separate" : "shared",
    windowSource: m.windowSource === "detected" ? "detected" : (Number.isFinite(cw) && cw > 0 ? "model" : ""),
    detectedAt: Number(m.detectedAt) || 0,
    detectNote: String(m.detectNote || ""),
  };
}

export function modelToConfig(m) {
  const n = normalizeModel(m);
  return {
    apiKey: n.apiKey,
    baseUrl: n.baseUrl,
    model: n.model,
    contextWindow: n.contextWindow,
    maxInputTokens: n.maxInputTokens,
    maxOutput: n.maxOutput,
    windowMode: n.windowMode,
    windowSource: n.windowSource,
    provider: n.provider,
  };
}

// 设为默认：持久化 active id 并同步 llmConfig（引擎唯一读取点）；模型不存在返回 false
export async function setActiveModel(id) {
  const list = await listModels();
  const m = list.find(x => x.id === id);
  if (!m) return false;
  await chrome.storage.local.set({ [ACTIVE_KEY]: id, llmConfig: modelToConfig(m) });
  return true;
}

// 解析“本次运行该用哪个模型”→ 写入 llmConfig；convOverrideId 为空 = 用全局默认。
// 无模型列表（旧版仅 llmConfig）→ 返回 null，调用方保持原配置不动。
export async function applyModelForRun(convOverrideId) {
  const list = await listModels();
  if (!list.length) return null;
  let m = null;
  if (convOverrideId) m = list.find(x => x.id === convOverrideId) || null;
  if (!m) {
    const id = await getActiveModelId();
    m = list.find(x => x.id === id) || list[0];
  }
  const cfg = modelToConfig(m);
  await chrome.storage.local.set({ llmConfig: cfg });
  return { id: m.id, cfg };
}
