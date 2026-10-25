// F12x 多模型管理（模型条目 = 名称 + API Key + Base URL + 模型名）
// 引擎唯一读取点仍是 llmConfig（getLLMConfig 不变）：每次运行前把“会话选定/默认”的模型合并写入 llmConfig。
// 用户主导：列表与默认模型由人在设置中维护；会话可各自记忆所用模型（conv.modelId，null=跟随默认）。
const MODELS_KEY = "f12x_models_v1";
const ACTIVE_KEY = "f12x_model_active";

export async function listModels() {
  const r = await chrome.storage.local.get(MODELS_KEY);
  return Array.isArray(r[MODELS_KEY]) ? r[MODELS_KEY] : [];
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

export function modelToConfig(m) {
  return {
    apiKey: String(m?.apiKey || "").trim(),
    baseUrl: String(m?.baseUrl || "").trim(),
    model: String(m?.model || "").trim()
  };
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
