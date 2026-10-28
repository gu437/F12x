// ============================================================
// 模型上下文窗口探测（方案 010 §3.0 / 011 P2）
// 只做 best-effort：不同 provider 的 /models 字段不统一，拿不到就明确失败，
// 由用户手填；不在产品里猜模型名，也不把 Key 写进 URL/日志。
// ============================================================

function trimBase(base) {
  return String(base || "").trim().replace(/\/+$/, "");
}

function numField(obj, keys) {
  for (const k of keys) {
    const n = Number(obj && obj[k]);
    if (Number.isFinite(n) && n >= 4096) return Math.round(n);
  }
  return 0;
}

function pickWindowInfo(obj) {
  if (!obj || typeof obj !== "object") return null;
  const total = numField(obj, ["context_length", "context_window", "max_context_length", "max_context_tokens"]);
  const input = numField(obj, ["max_input_tokens", "inputTokenLimit", "input_token_limit", "max_input_token"]);
  const output = numField(obj, ["max_output_tokens", "outputTokenLimit", "output_token_limit", "max_tokens"]);
  if (input) return { window: total, maxInputTokens: input, maxOutput: output, windowMode: "separate" };
  if (total) return { window: total, maxInputTokens: 0, maxOutput: output, windowMode: "shared" };
  return null;
}

function pickModelItem(list, modelName) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return null;
  const name = String(modelName || "").trim();
  return arr.find((x) => x && (x.id === name || x.name === name || x.model === name)) || (arr.length === 1 ? arr[0] : null);
}

async function getJson(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function detected(info, note) {
  return {
    ok: true,
    window: info.window || info.maxInputTokens || 0,
    maxInputTokens: info.maxInputTokens || 0,
    maxOutput: info.maxOutput || 0,
    windowMode: info.windowMode || "shared",
    source: "detected",
    note,
  };
}

export async function detectModelContext(model = {}) {
  const base = trimBase(model.baseUrl);
  const provider = String(model.provider || "openai").toLowerCase();
  const modelName = String(model.model || "").trim();
  const apiKey = String(model.apiKey || "").trim();
  if (!base) return { ok: false, error: "缺少 Base URL" };

  try {
    if (provider === "ollama") {
      const data = await getJson(`${base}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName }),
      });
      let win = 0;
      const info = data && data.model_info;
      if (info && typeof info === "object") {
        for (const [k, v] of Object.entries(info)) {
          if (/context_length$/i.test(k)) { win = Number(v) || win; break; }
        }
      }
      if (!win) {
        const params = String((data && data.parameters) || "");
        const m = params.match(/num_ctx\s+(\d+)/i);
        if (m) win = Number(m[1]) || 0;
      }
      if (win >= 4096) return { ok: true, window: Math.round(win), maxInputTokens: 0, maxOutput: 0, windowMode: "shared", source: "detected", note: "Ollama model_info" };
      return { ok: false, error: "Ollama 未返回 context_length（可在模型页手动填写）" };
    }

    if (provider === "lmstudio") {
      const data = await getJson(`${base}/api/v0/models`);
      const item = pickModelItem(data && data.data, modelName);
      const info = pickWindowInfo(item);
      if (info) return detected(info, "LM Studio /api/v0/models");
      return { ok: false, error: "LM Studio 未返回 max_context_length" };
    }

    if (provider === "gemini") {
      const data = await getJson(`${base}/v1beta/models`, {
        headers: apiKey ? { "x-goog-api-key": apiKey } : {},
      });
      const item = pickModelItem(data && data.models, modelName);
      const info = pickWindowInfo(item);
      if (info) return detected(info, "Gemini models.list");
      return { ok: false, error: "Gemini 未返回 inputTokenLimit" };
    }

    if (provider === "anthropic") {
      const data = await getJson(`${base}/v1/models`, {
        headers: {
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": "2023-06-01",
        },
      });
      const item = pickModelItem(data && data.data, modelName);
      const info = pickWindowInfo(item);
      if (info) return detected(info, "Anthropic models.list");
      return { ok: false, error: "Anthropic 未返回 max_input_tokens" };
    }

    // OpenAI 兼容：/v1/models；部分网关会附带 context_length 等字段
    const root = /\/v1$/i.test(base) ? base : `${base}/v1`;
    const data = await getJson(`${root}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const item = pickModelItem(data && data.data, modelName);
    const info = pickWindowInfo(item);
    if (info) return detected(info, "OpenAI-compatible /models");
    return { ok: false, error: "端点未暴露上下文窗口字段，请手动填写" };
  } catch (e) {
    const msg = e && e.status ? `探测失败：HTTP ${e.status}` : `探测失败：${String(e && e.message || e).slice(0, 120)}`;
    return { ok: false, error: msg };
  }
}
