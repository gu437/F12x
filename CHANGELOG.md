# 变更记录（CHANGELOG）

项目：F12x（Chrome MV3 扩展）· 仓库：`D:\dsh会话\F12x\F12x`

本文件记录**每一次对项目的实质改动**（代码 / 文档 / 工程约定）。README 只描述"当前能力"，历史一律记在这里——回看"这个行为是什么时候改的、为什么改、怎么验的"只看这一份。

## 怎么写（条目模板，照抄）

```
### YYYY-MM-DD · 类型：一句话说清改了什么
- 改了什么：
- 为什么：
- 验证：
- 提交：<短 hash>（未提交时写「未发布」，提交后补真 hash）
```

约定：

- 类型沿用提交前缀：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `chore`。
- **新的在上**（同一天多条按时间倒序），不要往中间插。
- 「验证」必须写实：跑了什么自检、手动点了哪几步、结果如何；没验证就写"未验证 + 原因"，不许编。
- 一条改动对应一个提交；一次提交包含多个主题时拆成多条条目（同 hash 可重复）。
- 版本号变化单独记一条 `chore: 版本号 → x.y.z`，并列出所有需要同步的位置（manifest / README / state / router / background 日志）。
- 纯本地、永不入库的过程文档（`方案_v*`、`REGRESSION_*` 等）不进本表；只有**进了仓库**的改动才算。

---

## 未发布

### 2026-10-26 · refactor：下线站点工作区并迁入项目（方案 001 / P3）
- 改了什么：`memory.js` 删除全部站点 CRUD，新增 `migrateSitesToProjectsIfNeeded()`（每个站点 → 同名项目，重名加后缀；facts/templates 并入，留 `sites_backup_v1` 备份）；`router.js` 删 9 个 `site:*` 分支、新增 `project:fact_add`、`get_state` 去 `activeSiteId`；面板删站点视图/顶栏选择器/导航项/全部站点函数（约 110 处引用），「标记为发现」改「存到项目黑板」，Repeater「存到站点」改「存到黑板」；`index.html` / `styles.css` 删对应结构与样式（保留 AI 复用的 `.site-pane`）；README 去站点行与 `sites_v1`，手册删第 9 章并重编号。
- 为什么：站点工作区与「项目」概念重复、还要手工维护；用户决定持久化数据统一落到项目，站点整体下线。
- 验证：`dev/run.mjs` 57/57（新增站点迁移用例 + L2 站点下线检查）；Playwright 真实加载扩展重截界面：导航 6 项、顶栏无站点选择器、全流程 0 `pageerror`。
- 提交：`b9b12e0`
### 2026-10-26 · feat：项目容器分键存储 + Issue/模板 CRUD（方案 001 / P2）
- 改了什么：projects_v2（单键 map，每次保存重写全部项目）改为 projects_index_v2（元数据）+ project:<id>（项目全文）；项目内新增 issues / 	emplates 数组与 CRUD；黑板事实增加 source: user|ai；删除项目改为逐个解绑会话（适配分键会话布局）；启动时幂等迁移旧 projects_v2。
- 为什么：项目要成为唯一持久化容器（黑板/Issue/模板/会话），旧的单键 map 与站点工作区并存、且每次保存全量重写。
- 验证：dev/run.mjs 55/55（新增 4 条 L1：迁移幂等 / 分键与计数 / 删除解绑 / 来源标记）；Playwright 真实 UI 中项目黑板显示「演示项目 · 3 条事实」。
- 提交：a45a63

### 2026-10-26 · refactor：删除 Scope 及其约束（方案 001 / P1）
- 改了什么：按用户决定下线"功能没完善就先上的约束"——`panel.js` 删 `api()` 越界 `confirm`、Scope 模块整块（匹配/过滤/管理弹层/初始化）、网络 `onlyInScope` 过滤与行高亮；`index.html` 删 Scope 工具条；`styles.css` 删 14 条 Scope 规则；README 去掉 Scope 条目/存储键/已知边界；使用手册删除第 13 章并重编号（13 快捷键 / 14 工作流 / 15 限制 / 16 数据）；AGENTS 更新已知坑与"不做"。新增 L2 检查：产品代码不得再出现 9 个 Scope 标识。
- 为什么：Scope 的"AI 也受范围约束"从未接线，却已提供启用/过滤/越界确认等表面能力，属于**半成品约束**；用户明确要求先删干净，把注意力放回未完成的功能本身。
- 验证：`dev/run.mjs` **51/51**（新增 Scope 检查项）；Playwright 真实加载扩展重截 18 张界面图，网络视图已无 Scope 条、全流程 0 `pageerror`；`rg` 9 个标识 0 命中。旧的 `f12x_scope_v1` 键保留不读（迁移保险，P7 统一清理）。
- 提交：`2626035`

## 0.2.2 — 2026-10-25

### 2026-10-25 · docs：完整使用手册（逐控件说明 + 19 张界面截图）
- 改了什么：新增 `docs/USER_MANUAL.md`，覆盖安装、界面骨架、7 个视图、拦截/批准弹层、设置、Issue、Scope、快捷键、4 个典型工作流、已知限制、数据位置；每个控件用表格说明「作用 / 前提 / 坑」。`docs/images/` 新增 19 张截图（合计 ~947KB），README 首屏与目录结构补入口。
- 为什么：功能已经铺开，但"哪个按钮能干什么、有哪些前提"只散落在 README 与代码里；一份逐控件手册能显著降低上手与回归成本。
- 验证：截图由 Playwright Chromium **真实加载扩展**后逐屏生成（0 条 pageerror），数据为注入的演示数据；控件清单与 `index.html` / `panel.js` 逐项核对。截图过程中还暴露并修复了轨迹渲染 bug（见下一条）。
- 提交：`a8e8696`

### 2026-10-25 · fix：带批准事件的会话轨迹渲染失败（archify 回退边）
- 改了什么：`buildWorkflowSpec` 在有批准闸门时，把所有工具节点列钳制到闸门右侧（`minToolCol`），`final` 列取 `max(工具列, router 列, 闸门列)`。
- 为什么：`store` 工具列固定为 2，闸门列是 `routerCol+1`；有闸门时 mainPath 出现 `approval → tool/final` 的列回退，archify 布局校验直接抛 `moves backward`，整块轨迹渲染失败——**凡是触发过批准的真实任务都会中招**。
- 验证：真实 UI 中重新渲染同一会话，轨迹恢复为「4 节点 / 3 边」（截图 `docs/images/16-ai-trajectory.png`）；`dev/run.mjs` 50/50。
- 提交：`4a1aab7`

### 2026-10-25 · perf：长会话窗口化渲染（打开不再一次铺 400 条）
- 改了什么：`renderChatHistory` 默认只渲染最近 **60 条**消息，起点对齐到真实用户消息（不会从工具调用半截开始）；顶部提供「↑ 加载更早的 N 条」按需追加，加载时保持视口不跳；AI 执行中禁用该按钮（此时 `aiDetailConv` 不含流式消息，重渲染会清掉实时内容）。
- 为什么：单会话上限 400 条、含工具结果卡与思考块，一次性构建 DOM 在低配机器上打开历史会话明显卡；窗口化后首屏只构建 60 条。
- 验证：`dev/run.mjs` 50/50（新增结构检查：必须有窗口常量、按窗口切片、有「加载更早」入口）；手动：打开一条 400 条消息的旧会话，首屏应秒开并显示最近内容，点按钮可往上翻、位置不跳。
- 提交：`f013272`

### 2026-10-25 · perf：会话存储改为「索引 + 每会话一键」（写放大 −45×，列表读 −495×）
- 改了什么：`conversations_index_v2`（元数据索引，KB 级）+ `conv:<convId>`（单会话全文）。保存只写「一个会话 + 小索引」；列表只读索引；`deleteConversation` 按 `spill_index:<convId>` 精确清理；保存/删除用 Promise 链**串行**，避免索引读-改-写丢条目；旧 `conversations_v2` 启动时幂等迁移（`getConversation` 仍有懒迁移兜底）。顺带把 `executor` 的 spill 裁剪与 `debugger` 的截图清理从 `get(null)` 全库扫描改成索引（`spill_index:*` / `shots_index_v1`）。
- 为什么：旧实现是**单一大数组**——agent 每 700ms flush 一次，每次都重写全部会话；列表接口还逐会话再读一遍全数组（O(N²)）；`spill`/截图清理每次都扫全库。这才是"AI 会话多了就卡"的根因，与会话数量本身无关。
- 验证：`dev/run.mjs` 49/49（新增：`get(null)` 禁令、迁移/分键/级联删除/溢出索引用例）。基准（50 会话 × 200 条消息）：单次保存 **4.12MB → 93KB（45×）**，列表读取 **4.12MB → 9KB（495×）**。手动：重载后旧会话列表与详情正常、跑一轮任务看会话继续落库。
- 提交：`de46e47`（截图索引随 `23db301` 补提交）

### 2026-10-25 · fix：换标签页时的数据串页（单 tab 原则 + 先清后回填 + 事件按 tab 过滤）
- 改了什么：attach 新 tab 前先 `chrome.debugger.detach` 旧会话；清空缓冲挪到历史回填**之前**；切换时向面板发 `network:snapshot` / `console:snapshot` 空快照；网络与脚本两个 `onEvent` 监听都加 `source.tabId !== debuggee.tabId` 过滤（与 `onDetach` 一致）；顺带清空旧 tab 的拦截队列。
- 为什么：原来 `debuggee` 只换不 detach、事件不按 tab 过滤，A 站的后台请求会混进 B 站的列表；清缓冲写在回填之后，B 的历史刚回填就被清掉；面板不发 reset，旧行残留与新行混排。
- 验证：`dev/run.mjs` 45/45（新增「CDP 事件必须按 tab 过滤」结构检查）；手动需重载后 A 站抓包 → 切 B → 列表应立即清空、且 A 的轮询不出现。
- 提交：`2127121`

### 2026-10-25 · refactor：设置与模型 CRUD 收归后台（面板不再直接读写存储键）
- 改了什么：`router` 新增 `settings:get` / `settings:save` / `model:list`（设置键走白名单，后台是唯一写入方）；`models.js` 恢复 `saveModels` / `setActiveModel`（现在真的有调用方，`setActiveModel` 同步 `llmConfig`）；面板 `openSettings` / `saveSettings` / `modelsLoad` 改走消息，删除 `MODEL_KEY` / `MODEL_ACTIVE_KEY` 的直接读写。
- 为什么：面板与后台各有一套模型 CRUD（面板直接写 `f12x_models_v1`，引擎侧 `models.js` 读），是典型的前后端两份实现，迟早漂移。
- 验证：`dev/run.mjs` 45/45（新增结构检查：面板不得出现这两个存储键、必须走 `settings:get/save`）；手动打开设置改模型保存、重开设置确认值在。
- 提交：`ca05ab1`

### 2026-10-25 · refactor：清理死代码与重复实现（-91 行，零行为变化）
- 改了什么：删 `src/index.js`（汇总 barrel，全仓 0 引用）；删从未使用的导出 `LITE_EXCLUDED_TOOLS`、`busCounters`、`getInterceptQueue`、`renderWorkspaceMd`、`getActiveSite`；删 `models.js` 4 个死壳（`genModelId` / `saveModels` / `getActiveModel` / `setActiveModel`，面板有自己的模型 CRUD）；删写-only 的 `taskState.tabId`（字段 + agent/router 两处赋值，无读取方）；`agent.isLocalBaseUrl` 收敛到 `llm.isLoopbackBaseUrl`，消除两份回环地址列表。
- 为什么：这些代码没有调用方或只有赋值没有读取，属于纯噪音；模型 CRUD 与回环判定各有两套实现，留着迟早漂移。
- 验证：`dev/run.mjs` L0 **18/18** · 43/43 全绿（新增「导出必须有产品侧调用方」检查，测试专用导出走 `ALLOW_TEST_ONLY` 白名单）；被删符号的残留引用 grep **0**；无调用方，故行为不变。
- 提交：`0441a84`

### 2026-10-25 · feat：Intruder 支持请求头与注入头
- 改了什么：面板 Intruder 新增「请求头（key: value 每行一个）」与「注入头（形如 `X-Test: {payload}`）」；`intruderRun()` 解析后传 `headers` / `headerInject`（此前硬编码 `headers:{}`，后端早已支持）。
- 为什么：鉴权头 / Content-Type / WAF 特征头这类最常用的测试在面板上根本做不了，只能绕 AI 或 eval_js；README 也把这条列为已知边界。
- 验证：`dev/run.mjs` 42/42；新增结构检查「Intruder 面板必须把请求头传给后端（不得再硬编码 `headers:{}`）」，改坏会红。手动：填 `X-Token: 1` 跑一组 payload，结果表/抓包确认头已带上。
- 提交：`6b01d23`

### 2026-10-25 · fix：补两个被丢弃事件的消费者（workspace / conversation:changed）
- 改了什么：`workspace` → 聊天流出现「📝 研讨 发现/疑问/决策 …（已沉淀黑板）」行；`conversation:changed` → 列表态实时刷新会话列表，详情记录页按 2s 节流刷新黑板/审计/轨迹。L2 的 `ALLOW_UNCONSUMED` 允许清单清空。
- 为什么：两者都是 src 推送、面板无分支的静默丢弃（由新加的结构检查发现），表现是"研讨动作看不见、会话列表不实时"。
- 验证：`dev/run.mjs` 42/42；清空允许清单后「推送事件都有消费者」仍绿；手动：AI 任务里触发一次研讨记录，聊天流应出现 📝 行。
- 提交：`6b01d23`

### 2026-10-25 · chore：验证外挂 dev/（四层验证 + 红绿自证）
- 改了什么：在**产品目录之外**新增 `dev/`（`D:\dsh会话\F12x\dev`）：`run.mjs` 一条命令跑四层——L0 语法（19 文件）、L1 契约（5 个测试文件、36 条断言：错误码/消息配对/压缩/裁剪/空想乱猜/黑板去重/提示词顺序）、L2 结构一致性（推送事件是否有面板消费者、工具三处是否同步、错误码文案是否齐全、面板消息是否有路由、版本是否一致、busEmit 是否被消费）、L3 独立性审计（产品代码 0 引用测试、产品目录无 tests/、manifest 无测试入口）。
- 为什么：这轮 7 个问题全是"跑得起来但不对"的静默 bug，靠逐行读才发现，不可重复；需要一个 2 秒级、可重复的红绿信号，且**不能进入产品依赖链**（Chrome 看不到 `dev/`，删掉它产品照跑）。
- 验证：`node dev/run.mjs` → **40/40 通过，2.0s**；两次故意改坏自证——改 `plan.js` 的未配对清理分支 → L1 变红；删 `panel.js` 的 `expert_tool_done` 分支 → L2 精确报"以下事件被推送但面板无消费分支：expert_tool_done"；`git checkout --` 还原后复绿。
- 提交：不入仓库（`dev/` 在产品目录外，属开发期工具；产品代码零改动）
- 已知欠账（允许清单，需还）：`workspace`、`conversation:changed` 两个事件在 src 推送但面板无消费者。

### 2026-10-25 · chore：版本号对齐 0.2.2（五处同步）
- 改了什么：`manifest.json`（唯一权威）、README 标题、`src/state.js appState.version`、`src/router.js VERSION`、`background.js` 启动日志统一为 `0.2.2`。
- 为什么：0.2.1 之后已有 7 项行为修复，但代码侧三处仍是 0.2.0；新增的版本一致性检查直接把这条历史漂移抓成红灯。
- 验证：`node dev/run.mjs` 全绿（L0 19/19 · 40/40）；重载扩展后 `chrome://extensions` 卡片应显示 0.2.2，SW 日志应为 `启动完成 v0.2.2`。
- 提交：`82654fc`

## 2026-10-25（0.2.1 工作树）

### 2026-10-25 · docs：新增 CHANGELOG 与「每次改动必留痕」约定
- 改了什么：新增本文件；`AGENTS.md` §3 目录表补 `CHANGELOG.md`、§9 增加「变更台账」强制条款与提交检查；README 目录结构与开发验证补指向。
- 为什么：此前改动只散落在提交信息与 README 的"近期修复"里，跨会话回看成本高、容易漏记；需要一个稳定台账。
- 验证：模板与历史条目人工核对；纯文档改动不影响 `node --check`。
- 提交：`eb22abf`（本条随该提交引入；hash 于紧随的 docs 提交回填）

### 2026-10-25 · fix：前端接线（Intruder 停止 / 站点会话页签 / Issue 入口 / 事件补消费 / 分栏拖拽）
- 改了什么：
  - 面板「Intruder 停止」改发 `tool:intruder_stop`，结果摘要显示「已中断（发出 N/M）」。
  - 新增 `renderSiteSessions()`：站点「会话」页签按 scope 域名匹配会话标题 / 目标 / 消息正文（先廉价匹配，未命中再最多深读 30 个详情），点条目直接打开会话。
  - 顶栏新增 Issue 工作台按钮（`clipboard-list` 图标 + 数量徽标，无 Issue 时隐藏）。
  - 补消费两个此前被静默丢弃的事件：`expert_tool_done`（专家每步 ✓/✗）、`ai:compaction_done`（压缩落地回执）。
  - 补回脚本列表（宽度）与网络详情（高度）两处 `.resizer`——`initResizers()` / `openNetworkDetail()` 早已引用，元素缺失导致拖拽全程空转。
  - 专家卡 `aria-expanded` 与"默认折叠"实现对齐；README「已知边界」同步改真。
- 为什么：通读源码后确认这五处是"UI 有入口但没接线 / 元素缺失"，属于用户可见的功能缺口。
- 验证：`node --check` 19 个 JS 全通过；行为需重载扩展手动回归（Intruder 停止、站点会话页签、顶栏 Issue、专家步骤行、两处拖拽条）。
- 提交：`e2808e6`

### 2026-10-25 · fix：后端契约与超时（Intruder 中断入口 / 同源重放超时回退 / ok 标记）
- 改了什么：
  - `router.js`：新增 `tool:intruder_stop` + 模块级 `manualIntruderCtl`，`dispatchTool(manual)` 传入 signal，`intruder` 逐请求检查后提前返回 `interrupted`。
  - `debugger.js`：同源 `replay_request` 的 12s 超时移入**页面上下文**（外层定时器管不到页面里的 `fetch`）；失败时真正回退扩展 `fetch`，并在 `note` 写明原因（原注释声称回退、代码直接 return）。
  - `eval_js` 成功补 `ok:true`、异常补 `ok:false + TOOL_EXECUTION_ERROR`；`navigate` 空 URL 分支补 `ok:false`。
- 为什么：工具返回契约与真实超时语义不一致；"停止"只解 UI 不停后端；回退分支是假的。
- 验证：`node --check` 全通过；同源重放与中断行为需重载后手动回归。
- 提交：`b161a7e`

### 2026-10-25 · docs：README 按 0.2.1 实际实现重写
- 改了什么：通读全部源码后修正 6 处与代码不符的描述（站点模板来源、站点会话页签、控制台页签范围、Intruder 注入头、Issue 字段含标签、轨迹"等待/恢复/终态 lane"），补齐存储键全表、容量淘汰上限、运行限制表、开发验证与 git 约定、近期修复、路线图。
- 为什么：README 早于实现演进，多处"文档比代码乐观"，会误导后续改动。
- 验证：每条结论回查对应函数 / 行号；`node --check` 通过（纯文档）。
- 提交：`5d0f631`

### 2026-10-25 · docs：项目级工作约定 AGENTS.md（先入库、后移至工作区根）
- 改了什么：建立 10 节约定——项目定位、运行/验证、目录分层、硬契约（消息通道 / 工具三处同步 / 返回契约 / 消息序列 / CDP / 存储键 / MV3 限制 / 循环依赖 / 版本号）、引擎机制、代码风格、新增能力落地路径、已知坑、git 工作流、不做什么。
- 为什么：把"改哪里、什么不能碰、怎么验"固化，避免每次从源码重新推导。
- 验证：对着源码逐条核对。
- 提交：`ea08646`（先随基线入库，随即按要求移到工作区根 `D:\dsh会话\F12x\AGENTS.md`，仓库内不再保留副本；原文在 `a8a4eb1` 可查）

### 2026-10-25 · chore：建立版本库基线（F12x 0.2.1）
- 改了什么：`git init` + 全量入库（56 文件），设仓库级身份 `F12x Dev <dev@f12x.local>`，`.gitignore` 沿用（过程文档、构建产物、密钥不入库）。
- 为什么：项目需要可回溯的历史版本。
- 验证：`git log --stat` 核对文件清单；工作区干净。
- 提交：`a8a4eb1`
