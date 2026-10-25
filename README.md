# F12x 4.2（当前版本 0.2.1）

用户主导的浏览器工具台（F12 全能力 + Burp 精简版），内建可选的 AI 聊天工作台。
Chrome MV3 扩展，模块化源码，**无构建步骤**，可直接以「加载已解压的扩展程序」安装。

**核心理念：用户是最高驱动者。** 全部手动功能不依赖 AI、不依赖网络与后端；AI 只是辅助工作台。
任何 AI 产出都应落到可核对、可留痕的本地记录（黑板 / 审计 / 轨迹 / Issue）里，由人最终裁决。

## 快速开始

1. 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」，选择本目录。
2. 任意页面按 **Ctrl+Shift+F** 呼出 / 聚焦工具台（也支持固定侧边栏）。
3. 工具台默认全部可用，无需任何配置。
4. 若要用 AI 会话：在扩展设置中点「+ 添加模型」建立模型条目（名称 / API Key / Base URL / 模型名，可并存多条并任选默认；默认端点参考 `src/llm.js` 的 `DEFAULT_LLM_ENDPOINTS`：DeepSeek / OpenAI / Anthropic / Ollama(localhost:11434)）。仅填过旧版单组 Key / URL 的配置会在首次打开设置时自动迁移成一条「默认」模型。
   - **本地模型接入**（Ollama / LM Studio）：Base URL 填 `http://127.0.0.1:11434`（或 LM Studio 端口），模型名如 `qwen2.5:7b`，Key 可留空（本地回环自动填占位）。**Ollama 需设置环境变量 `OLLAMA_ORIGINS=*` 后重启**（否则浏览器扩展请求会因 Origin 校验被 403）。扩展对本地回环模型请求自动带 `keep_alive:-1` 常驻，并在空闲期默认开启“本地空闲保活”（`f12x_local_warm`，设置可关）。

隐私：无自有后端、无遥测；LLM API Key 仅保存在浏览器本地 `chrome.storage.local`，代码内无硬编码密钥。
所有记录（Scope、Issue、Repeater 历史、待批准、黑板事实、会话审计）同样只存本地。

## 模块总览

### 工具台（手动，全部已实现）

| 视图 | 内容 |
| --- | --- |
| 页面 | Inspect 点选生成选择器卡、采集页面骨架、表单枚举、视口 / 整页截图、URL 导航、CSS 选择器搜索 DOM、JS 执行台（支持顶层 await + 历史） |
| 网络 | 实时请求表（拦截：关 / 拦下一个 / 全量，可全部放行）；过滤（URL 正则、元数据搜索、方法 / 状态 / 域 / 类型）；列配置、分页；请求详情页签（请求头 / 请求体 / 响应头 / 响应体 / 该请求控制台） |
| 请求 | **Repeater**：自定义方法 / URL / 头 / 体发送、与上次响应对比、→ Comparer / Decoder、历史（可“存到站点”）；**Intruder**：`{payload}` 占位注入 URL / 头 / 体、payload 文本或文件导入、并发 / 限速 / 停止、摘要与逐条结果；**Comparer**：A/B 文本对比、一键交换；**Decoder**：Base64 / URL / Hex 编解码，输出“→ 再编码”链式转换 |
| Cookie | 域名 / 名称过滤、显示值开关、刷新；值默认掩码、点击切换完整值 |
| 脚本 | 页面脚本列表、grep 关键字高亮、源码行号查看 |
| 站点 | 手工维护的站点工作区：创建站点后以页签组织 **黑板**（该站点事实卡）、**模板**（由 Repeater 历史“存到站点”沉淀，可回放）、**会话**（与该站点相关的 AI 会话回看） |
| AI | 见下节 |

各视图请求行的上下文操作：发送到 Repeater / Intruder / Decoder / Comparer / AI、**标记为发现**（写入当前站点黑板事实，自动生成键）、**→ Issue**（快速建单）。

### 工作区与记录（人工数据，均可增删改查）

- **Scope（目标范围）**：存储键 `f12x_scope_v1`。手动添加当前页面 / 选中请求 / 自定义规则，chip 显示数量；网络行按 范围内 / 范围外 高亮，可勾选“仅显示范围内”；越界手动请求会提示确认。另有一个“AI 也受范围约束”开关（已持久化，AI 执行端拦截尚未接线，见文末「已知边界」）。
- **Issue（问题单工作台）**：存储键 `f12x_issues_v1`。支持从请求行一键新建；字段含 标题 / 严重度 / 状态 / 请求方法（选填）/ URL（自动增高文本域）/ 标签 / 备注；标题不会自动填 URL；可导出 **Markdown / HTML** 报告。
- **AI 黑板**：AI 会话的事实沉淀（`upsert_fact` 等写入）。会话绑定项目后显示该**项目黑板**（跨会话共享），未绑定则显示 AI 全局黑板；会话列表按项目分组，可在「会话记录 → 黑板」回看与删除。
- **审计**：AI 的动作逐条留痕（工具调用 / 结果 / 审查事件），状态条可展开查看实时动作审计日志；会话审计随会话持久化，可在站点会话里回看。
- **轨迹**：把一次 AI 执行渲染为 archify 语义的 **workflow 可视化图**（阶段轨道 + 等待 / 恢复 / 终态 lane），非逐条会话照抄；CSP 下以 iframe srcdoc 展示引擎 SVG，支持缩放与拖拽，另有「打开完整工件」下载官方 HTML 查看器获得完整交互视图。

### AI 会话工作台（辅助）

会话列表 → 聊天页 / 会话记录页两个互斥页签（聊天、记录互不遮挡）：

- 模式切换：**任务模式**（可自主调用页面 / 网络等工具）与**对话模式**（纯问答、不执行工具）。
- **禁思考** 开关：开启后主模型不输出思考直接作答 / 行动（任务模式仍可调工具），UI 按会话记忆。
- **模型切换**：聊天输入框上方的选择器按会话切换模型（只对本会话生效并记忆；新会话默认跟随设置中的默认模型；AI 运行中锁定）。
- 思考过程实时可见：折叠的「思考」行（运行中 = 摘要行 + 扫光动画，点击展开正文）；审查专家同样实时可见。
- **计划条**：固定在输入框上方，随推进更新（✓ 完成 / ● 进行 / ○ 待办），由 `plan_write` 事件驱动，不会随消息滚动丢失。
- 任务模式下的工具调用先进入**待批准**队列（`f12x_pending_approval_v1`）：同轮同工具批量合并 → 全部批准 / 逐个审（勾选）/ 拒绝。
- **机制档位**：设置里可选 auto / 精简 / 完整（存储键 `f12x_guard_profile`）。精简档还启用**精简工具面**：仅注入 18 个核心工具且工具描述截短（大 schema 会让本地小模型 prefill 显著变慢）。auto 下本地模型（127.0.0.1 / localhost）自动精简（任务开始时聊天流会提示“精简模式…已关闭 对抗性审查/专家复核…”），云端模型自动恢复全部机制；也可在设置中手动固定。
- 中途可「停止」当前任务；「新项目 / 绑定项目 / 重命名 / 删除」管理会话与项目归属。

## 核心机制（src/）

| 模块 | 职责 |
| --- | --- |
| `agent.js` | 主决策循环：消息 → 工具调用 / 文本作答 / 计划维护 / 审查触发 / 压缩压力处理 |
| `plan.js` | 执行计划：锚点块（黑板事实）、工具结果修剪、上下文压缩摘要 |
| `executor.js` | 工具注册表 `TOOL_REGISTRY` + 校验 / 超时 / 中断 / 模式分发（manual / task / chat） |
| `llm.js` | LLM 调用与流式接收、端点归一化、token 估算（CJK 字符 ≈ 1 token 的启发式） |
| `memory.js` | 事实黑板：upsert 去重（相同键值重写保留 createdAt）、查询、按优先级挑选计划锚点 |
| `guards.js` | 自审问题生成与审查目标识别 |
| `errors.js` | 稳定错误码、工具失败 / 用户拒绝 / 结果解析判定 |
| `expert_round.js` `experts.js` | 对抗性审查的专家回合编排与专家定义 |
| `state.js` `bus.js` `router.js` `debugger.js` | 状态广播（带 convId）、事件总线、后台消息路由、CDP 调试封装 |

**执行流程**：主模型按用户目标推进，用 `plan_write`（引擎级工具，不在 executor 注册表，由 `agent.js` 拦截处理）声明 / 更新计划；执行工具 `dispatchTool` 统一派发。对抗性审查按**信号驱动**触发（方案_v4：连续结构化失败、同调用连打 ≥5 次、计划停滞 ≥3 轮等），通过 `rebuttal_check` 自检（每轮封顶 4 次）或 `call_expert` 请复核审计员；`call_expert` 对低价值 / 琐碎断言会按设计拒绝（返回 INVALID_REQUEST 风格错误，属正常行为）。**上下文压缩**对齐 deepseek-harness compaction-basic 语义：达到 0.8 × 窗口阈值 → 修剪工具结果 → 摘要压缩（保留尾部 0.16 × 窗口），压缩失败可重试。

## 工具清单

executor 注册 23 项，其中 17 项**手动可用**（manualAllowed，手动调用 = 用户即批准人：跳过批准，但保留校验 + 超时 + 审计）：

`get_page_skeleton` `search_dom` `get_network_requests` `get_network_request_detail` `get_cookies` `eval_js` `get_script_list` `get_script_content` `navigate` `get_console_logs` `replay_request` `highlight_element` `screenshot` `decode_text` `compare_responses` `intruder` `read_spilled`

AI 任务专用（不可手动直调）：`upsert_fact` `get_fact` `rebuttal_check` `workspace_note` `call_expert` `get_skill`；另有引擎级 `plan_write`。

## 配置与存储

- LLM：设置页保存为 `llmConfig`（兼容旧独立键 `llm_api_key` / `llm_base_url` / `llm_model` 等），端点列表 `llm_endpoints`，全部在 `chrome.storage.local`。
- 行为键：`f12x_thinking_limit`（思考上限，空 / 非法视为不限）、`f12x_context_window`（压缩窗口，默认 131072）、`f12x_ai_nothink`（会话 UI 记忆的禁思考开关）、`f12x_ai_mode`、`f12x_local_warm`（本地空闲保活：空闲期每 40s 一次 1-token 请求，缓解 Arc iGPU+Vulkan 空闲唤醒延迟；默认开）。
- 模型管理：`f12x_models_v1`（多条模型条目：id / name / apiKey / baseUrl / model）、`f12x_model_active`（默认模型 id）；`llmConfig` 始终与「会话所选 / 默认」模型同步（引擎唯一读取点不变），会话级记忆存于会话字段 `modelId`（空 = 跟随默认）。
- 机制档位：`f12x_guard_profile`（auto / lite / full）。为本地小模型减负：auto 按 baseUrl 自动判定（127.0.0.1 / localhost → 精简，云端 → 完整）；lite 关闭 对抗性审查 / 专家复核介入 / 防空想两档直切 / 强制先探测 / plan_write 收尾硬门，并从工具面剔除 `call_expert` `rebuttal_check`（保留：工具批准闸、上下文压缩、重复工具提醒、未验证结论拦截）；full 恢复全部云端机制。
- 数据键：`f12x_scope_v1`、`f12x_issues_v1`、`f12x_repeater_history_v1`、`f12x_pending_approval_v1`。

## 运行态实测修复与新增（0.2.1）

- `navigate` 工具全量修复（`normalizeNavUrl` 成功分支补 `ok:true`，此前所有合法导航被提前判失败）
- 手动工具统一错误契约（toolRun：底层 `{error}` 不再被包装成 `ok:true`，坏 id 等假成功消除）
- Scope：host/domain 条目匹配前剥离端口（本地 `localhost:8080` 类条目此前永不命中）
- `cookie:set` 校验 CDP `Network.setCookie` 的 `success`（失败不再假成功）
- AI 引擎：lite 档精简工具面（18 工具+描述截断）、机制档位、文本轮被拒 ≥5 次自动放行收尾、空转/截断提示更清晰
- 页面浮条（执行/导航指示器）改 F12x 黑白样式 + 动作化可读摘要（`eval_js` 显示“操作目标/请求地址”而非整段代码）；导航“已到达”提示跟随目标页并延长展示
- 网络表渲染链路加防御与诊断（`[F12x] renderNetworkTable 异常：…` 可见可定位）
- 主题 skin 数值抄自 DeepSeek Harness/Open Props（灰阶/发丝边框/圆角/字体栈），图标改为透明底（RGBA）


## 目录结构

- `manifest.json` `background.js` — MV3 声明与 Service Worker（消息路由、会话管理）
- `src/` — 核心模块（上表）
- `sidepanel/` — 工具台 UI：`index.html` + `panel.js`（视图 / 会话 / 渲染逻辑）+ `styles.css` `components.css`（视图切换含 View Transition 动效、行点击缩放等；偏好减弱动效时自动关闭）+ `icons.js`（内联 SVG 图标）
- `vendor/open-props` `vendor/open-props-theme.css` — 第三方 CSS 变量
- `vendor/archify/` — archify 引擎的浏览器适配移植（`renderers/` + `seam/` + `assets/`）：workflow / sequence / lifecycle 渲染器改为浏览器可运行并接入轨迹面板；Node 下与官方 CLI 输出做过字节级对照验证
- 根目录 `*.md` — 设计 / 调研 / 回归记录：本地工作副本（含 `REGRESSION_*` 回归报告）不入库，见 `.gitignore`

## 已知边界（如实说明）

- 轨迹面板是 archify 引擎渲染的**静态 SVG + 自定义缩放 / 拖拽**：扩展 CSP 禁止内联查看器脚本，故不内嵌官方交互查看器；需要完整交互时用「打开完整工件」下载官方 HTML。
- Scope 的「AI 也受范围约束」开关仅持久化，AI 执行端尚未接线拦截（人工操作过滤 / 确认已生效）。
- `get_skill` 只读取存储中已安装的技能内容，未安装时返回 NOT_FOUND，属预期。
- `call_expert` 拒绝低价值复核是设计行为；「反过度思考」的 Plan 触发阈值待积累真实统计数据后再校准。
- 本地小模型（如 qwen2.5:7b，CPU）**任务模式每轮耗时 20–30s**（prefill+生成固有）；已加入 lite 精简工具面、宽松引导提示与“文本轮被无限吞≥5 次自动放行”兜底；在 CDP 自动化驱动下任务全链路不稳定，建议在真实面板人工验证。
- 页面浮条（执行/导航指示器）为 **F12x 黑白样式**（白底黑字细黑边框 + F12x 标签），注入目标页面；`screenshot` 定位为**取证**（图片不进 LLM 上下文，仅供人查看，保留最近 5 张）。
- Ollama + Intel Arc（iGPU/Vulkan）在空闲后首个请求有数秒~数十秒唤醒延迟（本地保活默认开启缓解；仍明显则更新显卡驱动或改用 CPU/LM Studio）。
- token 估算为字符启发式（CJK 偏保守），不是精确 tokenizer。
- 尚未实现（规划中）：宏录制 / 回放（把 Repeater / Intruder / navigate 序列 + 变量注入固化为工具链宏）——手动主线下一项；方案_v4 的 P4 重大结论升级为独立外部审计员、`call_expert` 同焦点去重。

