# AGENTS.md — F12x 项目级工作约定

本文件是本仓库（`D:\dsh会话\F12x\F12x`）的**项目级**约定。动手前先读本文件；与 `README.md` 冲突时以 README 的功能描述为准，与本文件的工程约束冲突时以本文件为准。

---

## 1. 这是什么项目

Chrome **MV3 扩展**：用户主导的浏览器工具台（F12 全能力 + Burp 精简版）+ 内建可选 AI 聊天工作台。

- 当前版本 `0.2.1`（`manifest.json`），无构建步骤、无 `package.json`、无 `node_modules`、无打包器：改源码 → 重新加载扩展 → 立即生效。
- **用户是最高驱动者**：所有手动功能不依赖 AI、不依赖网络、不依赖自有后端。AI 只是辅助工作台，任何 AI 产出必须落到可核对、可留痕的本地记录（黑板 / 审计 / 轨迹 / Issue）里，由人裁决。
- 数据全部在 `chrome.storage.local`（少量 UI 记忆在扩展页 `localStorage`）：无遥测、无后台服务、代码内无硬编码密钥。
- Chrome 里加载的目录就是本目录（`加载已解压的扩展程序` 选 `D:\dsh会话\F12x\F12x`），改动后刷新扩展即可看到。

## 2. 运行 / 验证（没有测试框架，靠这三件事）

```powershell
cd D:\dsh会话\F12x\F12x

# ① 语法自检（Node 24 的 --check 对 ESM 与经典脚本都可用）
Get-ChildItem src\*.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE) { "FAIL $($_.Name)" } }
node --check sidepanel\panel.js
node --check sidepanel\icons.js
node --check background.js

# ② manifest 合法性
node -e "const m=require('./manifest.json');console.log(m.name,m.version,m.manifest_version)"
```

③ **手动回归**（唯一的功能验证手段）：

1. `chrome://extensions` → F12x 卡片点「重新加载」。
   - 改 `background.js` / `src/**` → **必须重载扩展**（Service Worker 重新注册，否则跑的还是旧代码）。
   - 只改 `sidepanel/*.js|css|html` → 关掉侧边栏再打开（或重载扩展）即可。
2. 打开任意网页 → `Ctrl+Shift+F` 呼出侧边栏。
3. 冒烟：页面骨架 / 网络列表+详情 / Repeater 发送 / Intruder 开始+停止 / Decoder 转换 / Cookie 读取 / 脚本列表+源码。
4. 改了 AI 链路再补：设置里配好模型 → 对话模式一问 → 任务模式一轮（含工具调用与批准条）→ 停止 / 接管 / 继续。
5. 看 Service Worker 控制台（`chrome://extensions` →「Service Worker」）与页面控制台：日志前缀 `[F12x]` `[Agent]` `[CDP]` `[ExpertRound]` `[Blackboard]` `[Checkpoint]`。

## 3. 目录 / 分层（改哪里？）

| 位置 | 职责 | 注意 |
| --- | --- | --- |
| `manifest.json` | MV3 声明、权限、CSP、快捷键 | 加权限需说明理由；CSP 只允许 `script-src 'self'` |
| `background.js` | SW 瘦入口：port 注册、bus→panel 桥、ctrl 路由、启动初始化、20s 保活 alarm | 不在此堆业务逻辑 |
| `src/debugger.js` | CDP 连接 + 全部底层工具（骨架/网络/脚本/Cookie/导航/重放/爆破/截图/拦截/浮条） | 最大单文件（≈2.2k 行）；所有调试器调用走 `sendCDP` |
| `src/router.js` | ctrl 通道消息路由（手动工具层 + 站点/项目/会话 API + AI 转发） | 每个 `type` 一个分支；手写 if 链，顺序影响行为 |
| `src/state.js` / `src/bus.js` | 运行态（`appState`/`taskState`、panel port 集合、`pushStatus`/`broadcastToPanels`） / 内部事件总线 | 单数据源在 background，panel 是纯视图 |
| `src/agent.js` | 主决策循环、批准闸门、计划、审查、压缩、steering、暂停/恢复 | 引擎核心（≈1.7k 行）；改动风险最高 |
| `src/executor.js` | `TOOL_REGISTRY` + `dispatchTool`（校验/超时/中断/审计/spill）+ 工具执行 switch | 所有工具的**唯一**入口 |
| `src/llm.js` | LLM 端点归一化、SSE 流、超时、重试、意图分类、`runChat` | 不在这里放专家/工具逻辑 |
| `src/plan.js` | 消息序列清洗、裁剪、压缩（对齐 DSH compaction-basic）、锚点块 | 400 错误的高发区 |
| `src/memory.js` | 项目/黑板/会话/站点/工作区/技能/checkpoint 的存储层 | 所有 storage 键集中在此 |
| `src/prompts.js` | system 分段注册表 + `TOOL_DEFINITIONS`（给模型的工具 schema） | 提示词与工具增删只改这里 |
| `src/guards.js` / `src/experts.js` / `src/expert_round.js` | 空想/乱猜/未验证结论检测 / 复核审计员定义 / 只读回合引擎 | 专家只读白名单必须收紧 |
| `src/errors.js` | 稳定错误码 + 归一化 + 重试白名单 | 全项目唯一错误码来源 |
| `src/models.js` | 多模型条目（`f12x_models_v1`）→ 合并写入 `llmConfig` | 引擎只读 `llmConfig` |
| `sidepanel/` | 工具台 UI：`index.html` 骨架 + `panel.js` 纯视图（≈4.4k 行，经典脚本非 module）+ `styles.css`/`components.css` + 内联图标 | 面板不能 `import`，错误码文案另有一份副本 |
| `vendor/` | `open-props` 设计令牌、`archify` 引擎浏览器适配、`open-props-theme.css` | 第三方代码，勿格式化/改动除非必要 |

**数据流**（记住这两条即可）：

- 手动：`panel.js api(type)` → `chrome.runtime.sendMessage` → `router.handleMessage` → `debugger.*` / `dispatchTool(manual)` → `sendResponse`
- 采集与 AI 状态：`debugger` 事件 → `busEmit` → `background` 桥 → port `stream` → `panel.handleStream`；AI 状态走 `pushStatus` → port `status` → `panel.handleStatus`

`src/index.js` 只是部分模块的 barrel（debugger/llm/memory/guards/experts/plan）；`agent.js`、`executor.js` 等按需直接 import，不要为"整齐"把全部模块塞进 barrel。

## 4. 硬契约（违反会静默坏掉）

1. **ctrl 消息**：新增类型必须在 `router.js` 加分支；异步分支 `return true` 并 `sendResponse` **恰好一次**；同步分支末尾的兜底 `sendResponse({ok:false,error:"未知消息类型"})` 不能被提前 return 绕过。panel 侧统一用 `api(type, payload)`。
2. **stream/status 通道**：background 只通过 `broadcastToPanels` / `pushStatus` 向面板推送；`pushStatus` 自动补 `convId`，面板据此过滤"别的会话"的终态事件——**不要**用全局 `taskRunning` 判断归属。新增事件名必须在 `panel.js` 的 `handleStream` / `handleStatus` 里消费，否则事件静默丢失。
3. **工具三处同步**（少一处就是"模型能看见但调不动"或"能调但没 schema"）：
   `prompts.js TOOL_DEFINITIONS`（schema/描述） + `executor.js registerTool(...)` + `executeToolInner` switch；另按需补 `experts.js TOOL_NAMES_CN`（中文名/浮条/偏离检测）、`agent.js LITE_CORE_TOOLS`（精简档是否可见）、`agent.js APPROVAL_G1`（是否免批准）、`README.md` 工具清单。
   手动可直调 = `manualAllowed: true` **且** `router.js` 有对应 `tool:*` 分支。
4. **工具返回契约**：成功 `{ok:true, ...}`；失败 `{ok:false, code, error}`，`code` 只能取自 `errors.js F12X_ERROR_CODES`。禁止"假成功"（底层返回 `{error}` 不得被包成 `ok:true`，见 `router.toolRun`）。工具超时用 `TOOL_TIMEOUT`（**不是** `TIMEOUT`，后者在重试白名单里）。
5. **消息序列**：`assistant(tool_calls)` 后必须跟齐每个 `tool_call_id` 的 `tool` 消息；assistant 的 `content` 不能为 `null`；发请求前必须过 `sanitizeMessagesForAPI`（剔除 `_sys`/`_kind`、`internal`→`user`）；历史里 `_kind` 为 `plan`/`thinking`/`expert`/`review` 的仅展示记录不回灌 LLM。
6. **CDP**：一律 `sendCDP(method, params)`；attach 幂等（`debuggerAttach` 已做单飞+同 tab 跳过）；写操作必须检查 CDP 返回（如 `Network.setCookie` 的 `success === false` 要如实报错）。
7. **存储键**：行为/设置 `f12x_*`；数据集合 `*_v1`/`*_v2`（`projects_v2` / `conversations_v2` / `sites_v1` …）；会话级 `spill:{convId}:{key}`、`workspace:{convId}`。新增键要写进 `README.md` 的「配置与存储」章节，并在 `deleteConversation` 一类清理路径里考虑级联删除。
8. **MV3 限制**：Service Worker **禁止动态 `import()`**——AI 模块静态导入，"AI 未配置时工具台照常可用"由运行时配置检查保证；扩展页禁止内联脚本/`onclick=` 属性；面板 `innerHTML` 前必须 `esc()`/`escapeHtml()`（页面内容、模型输出一律不可信）。
9. **循环依赖**：`executor.js` 从 `agent.js` 取 `addAudit`/`sessionEvent`，靠的是**函数声明提升**。不要把这两个改成 `const` 箭头函数，否则模块实例化期即 `ReferenceError`。
10. **版本号**：`manifest.json` 是唯一权威（当前 `0.2.1`，README 标题已同步）；但 `src/state.js appState.version`、`src/router.js VERSION`、`background.js` 启动日志仍是 `0.2.0`——**bump 时一并核对**，别只改一处。

## 5. 引擎机制（改 AI 链路前必须知道的）

- **工具数量**：注册 23 项，其中 17 项手动可用；`plan_write` 是引擎级工具（不在注册表，`agent.js` 拦截处理）。
- **批准闸门**：G1 只读自动 / G2 写操作需批准 / G3 保留（当前为空）。未知工具默认 G2。等待 120s 超时**按拒绝**处理；等待期间订阅任务 `abort`，暂停/新指令立即放行；未决批准持久化到 `f12x_pending_approval_v1`，SW 复活重弹。
- **执行流程**：主代理通过 `plan_write` 自持 todo 语义，引擎**不代规划、不自动推进**；`steps:[]` = 明确声明简单任务；收尾前未提交流程会被拦一次（`planGate`）。
- **机制档位** `f12x_guard_profile = auto|lite|full`：lite（本地回环模型默认）关闭对抗性审查、专家复核、强制先探测、plan 收尾硬门、空想两档直切，并启用 18 工具精简面 + 工具描述截断；full 恢复全部机制。新增工具要明确"lite 档要不要"。
- **上下文预算**：窗口 `f12x_context_window`（默认 131072）→ 压力阈值 `0.8×窗口`、保留尾部 `0.16×窗口`；先确定性裁剪工具结果（保留最近 3 条），仍超阈才走 LLM 摘要；溢出（provider 确认）强制压缩最多重试 1 次。
- **大结果溢出**：单工具结果 > 8000 字符写 `spill:*`，给模型摘要 + `read_spilled` 指引（每会话上限 30 条，单次读取 24000 字符；`read_spilled` 自身豁免再 spill）。
- **只读白名单**：复核审计员只能调 `reviewAllowedTools()` 里的工具；专家回合内 `eval_js` 被强制剥离 `allow_tools` 且默认 main world。
- **实时同步**：执行中按 `_seq` 水位把新消息增量落库并广播 `conversation:changed`（节流 700ms），不要改成"任务结束一次性保存"。

## 6. 代码风格（跟随现状，不引入新范式）

- 原生 **ESM**，`export function`；`src/*.js` 顶部有 `// ====` 说明块解释职责与设计来源。
- 2 空格缩进、分号、以双引号为主；中文注释，**保留**历史修复标注（如"修复（审读高）""方案_v4 §9.2""对齐 DSH compaction-basic"）与出处，不要"顺手清理"。
- 新逻辑优先新建 `src/` 模块，不要在 `panel.js` / `agent.js` / `debugger.js` 里继续膨胀；面板新功能放在对应 `init*Module()` 区块内。
- 不引入 TypeScript、打包器、前端框架、CDN 依赖、lint/test 脚手架；确需第三方代码放 `vendor/` 并注明来源与许可证。
- 异常不得变成 unhandled rejection（`promise.catch(() => {})` 或明确 await）；日志用既有前缀，禁止 `console.log` 打印密钥/Cookie 值。
- UI 文案中文、面向"用户即操作者"（说明能做什么 / 为什么失败 / 下一步怎么办），错误优先展示 `errMsg(r)` 的可读文案而不是裸异常。

## 7. 新增能力的落地路径

- **新手动工具**：`debugger.js` 导出实现 → `executor.js` `registerTool({manualAllowed:true,...})` + switch 分支 → `router.js` 加 `tool:xxx`（含 `debuggerAttach()` 与 `toolRun`）→ `panel.js` `api("tool:xxx")` → README 工具清单。
- **新 AI 工具**：`prompts.js TOOL_DEFINITIONS` → `executor.js` 注册+执行 → `experts.js TOOL_NAMES_CN` → 决定 `LITE_CORE_TOOLS` 与 `APPROVAL_G1`（写操作不得进 G1）。
- **新面板视图**：`index.html` 加 `section#view-x` + `nav-item[data-view=x]` → `switchView` 懒加载 → 对应 `initXModule()`；样式先复用 `components.css`，令牌来自 `vendor/open-props`。
- **新存储实体**：`memory.js` 加常量与 CRUD → `router.js` 暴露消息类型 → README 记录键名与上限/淘汰策略。

## 8. 已知坑（都踩过，别再踩）

1. `navigate` 的返回值分支必须显式带 `ok:true`，否则合法导航会被判失败（0.2.1 修过）。
2. 手动工具包装 `toolRun` 必须保持"显式 `ok:true` 才算成功、有 `error` 无 `ok` 算失败"的判定，否则坏 id 之类会变成假成功。
3. Scope 的 host/domain 匹配前**先剥端口**（`localhost:8080` 曾永不命中）。
4. `finish_reason=length` 的半截正文不得当最终回答推送。
5. 压缩请求的前缀不能以"未配对的 `assistant(tool_calls)`"结尾，否则 400 且静默降级为丢轮次。
6. 批准等待必须订阅 `abort`（否则 steering/暂停要白等 120s）；用户拒绝/超时是"决策反馈"，不是工具失败（`isUserRejectionResult`），别混进失败计数触发审查。
7. `read_spilled` 的返回不得再次 spill（自馈环，会"越读越胀"）。
8. 面板侧 `F12X_ERR_TEXT` 是 `errors.js` 的手工副本——新增错误码要同步两处。
9. 同一 `pushStatus` 事件可能带 `status` 也可能是 `type`（历史双轨），新增消费逻辑两种都要容错。
10. 改 `panel.js` 后若按钮无反应，先确认是"扩展未重载"还是"事件名没在 `handleStream` 消费"。

## 9. git 工作流

- 仓库根 = 本项目目录；`*.zip` / `*.crx` / `*.pem` / `.env*` / `node_modules` / 本地过程文档（`压缩机制对齐_harness.md`、`方案_v3_专家回合.md`、`方案_v4_对抗性审查优化.md`、`轨迹可视化_调研.md`、`REGRESSION_*.md`）已在 `.gitignore`；新增同类过程文档要同步追加忽略项。
- 提交粒度：一个主题一次提交；信息用中文，前缀 `feat:` `fix:` `docs:` `refactor:` `perf:` `test:` `chore:`，正文说清"改了什么 + 为什么 + 怎么验的"。
- 提交前至少过：语法自检 + 手动冒烟（第 2 节）；碰 AI 链路再补任务模式回归。
- 不要在提交里夹带无关格式化（`vendor/`、整文件重排会让历史不可读）。

## 10. 不做什么（会破坏产品定位）

- 不加遥测、不加自有后端、不把 AI 设为必需、不把任何配置外传。
- 不删除审计 / 黑板 / 轨迹 / Issue 的留痕链路，不把"手动 = 用户即批准人"改成需要批准。
- 不静默放宽 Scope（越界确认、范围高亮保持手动可控）。
- 不为了"看起来现代"引入构建链、框架或远程资源——**加载即用**是产品承诺。
- 不伪造数据：工具结果、验证状态（`verified` 仅在真有成功只读调用且证据支撑时为 true）、黑板沉淀必须真实。
