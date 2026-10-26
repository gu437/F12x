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

### 2026-10-27 · feat：参数级变形与授权矩阵（方案 009 / P3）
- 改了什么：新增 `src/mutate.js`（URL path/query、JSON body、请求头的对象引用提取；类型保持；候选值）与 `src/matrix.js`（差异分类）；debugger 增加 `replay_batch_with_identity`（同一身份一次 Cookie/storage 事务批量重放）；router 增加 `mutate:extract`、`matrix:run`；Repeater 增加「矩阵」：身份多选/基线/值编辑/结果着色/单元格预览与存证据/CSV。
- 为什么：身份档案只解决"能切身份"，还缺"改哪个对象、批量跑、怎么判差异"；这是 OWASP A01/API1/API5 的核心验证动作。
- 验证：`dev/run.mjs` 92/92；真实服务 A/B × 订单 1001/1002：A=200/403；B/1001=403（status-diff）、B/1002=200（exposure）；UI 6 单元格、存证据 count=1；0 `pageerror`。
- 提交：`5da0b2c`

### 2026-10-27 · feat：身份档案与身份重放（方案 009 / P2）
- 改了什么：新增 `src/identity.js`（项目级 Cookie + localStorage/sessionStorage + 认证头、CRUD、项目删除级联）；debugger 增加 `capture_identity_state` 与 `withIdentityState` 事务（快照→应用→finally 恢复，失败保留 `identity_txn_v1`）；`replay_request` 支持 `identity`（同源校验、合并认证头）；router 增加 `identity:list/get/save/remove/capture`，`tool:replay` 接受 `identityId`；Repeater 增加身份选择器与「管理身份」（抓取/编辑头/删除）。
- 为什么：访问控制测试必须先能控制身份；只读 Cookie 无法覆盖 SPA 的 localStorage Bearer token，且切身份不能污染用户当前会话。
- 验证：`dev/run.mjs` 88/88；真实浏览器：抓用户 A（Cookie `sid=A` + localStorage `tok-A`）→ 当前会话切 B → 以 A 重放返回 `{"sid":"A","auth":"Bearer A"}` → 结束后 Cookie `sid=B`、token `tok-B`（已恢复）；0 `pageerror`。
- 提交：`9b683b2`

### 2026-10-27 · feat：证据底座（方案 009 / P1）
- 改了什么：新增 `src/evidence.js`（项目级证据、SHA-256、2MB 截断标记、列表/读取/删除、项目删除级联）；router 新增 `evidence:list/get/save/remove/attach/detach`，Issue 增加 `evidenceIds`；项目页新增「证据」页签（卡片/查看/复制 curl/关联 Issue/删除），网络详情与 Repeater 增加「存证据」；证据不可变、索引与正文分键。
- 为什么：Issue 证据原来只是自由文本，网络缓冲会轮转；没有不可变证据对象，项目容器无法交付可复现结果。
- 验证：`dev/run.mjs` 84/84（新增证据单测 + L2）；真实 UI：存证据→卡片→预览→复制 curl→关联 Issue（`evidenceIds=1`）；Repeater 存证据成功；0 `pageerror`。
- 提交：`d6fe2b4`

### 2026-10-27 · refactor：下线轨迹与 archify（方案 008）
- 改了什么：删除 AI 会话「记录 → 轨迹」子页签、生命周期/archify workflow 渲染、`buildWorkflowSpec`、缩放拖拽与「打开完整工件」；删除 `vendor/archify`（20 个文件，约 1.5MB）与对应 CSS；清理 `agent/executor/memory` 中“轨迹”措辞（`session.events` 保留，审计/压缩/批准仍依赖）；手册/README/15 截图/抓图脚本同步，新增 L2「轨迹已下线」。
- 为什么：轨迹是展示层功能，依赖第三方 archify 引擎与大量专用代码；用户明确要求全面删除，减少维护面与体积，保留审计与黑板即可满足回看需求。
- 验证：`dev/run.mjs` 79/79；真实 UI 会话记录只剩「黑板 / 审计」，0 `pageerror`；产品代码/文档 `rg` 0 命中 `trajectory|archify|轨迹`；`vendor/archify` 不存在。
- 提交：`89e4b19`

### 2026-10-27 · fix：网络页历史回填状态/详情与过滤逻辑
- 根因：面板通常晚于页面加载才附加调试器，列表里大多是 `performance` 回填的 `hist_*` 条目——`status=null`、`method=null`、无响应头/体；同时 `networkSnapshot()` 只映射 8 个字段，把 `size/history/intercepted` 丢掉；`Network.loadingFinished` 未处理，实时请求的 size 永远为空。
- 改了什么：回填读取 `responseStatus` / `transferSize`；`loadingFinished` 回填 `encodedDataLength`；snapshot 保留 `size/history/intercepted`；历史条目加「历史」标签与顶部横幅，详情直接给出“无响应体”说明；附带修复非法 URL 正则静默显示全部、表头排序误绑「操作」列、元数据搜索过期结果覆盖。
- 验证：`dev/run.mjs` 78/78；真实历史回填 72 条 `status={200:1,404:71}`（修复前全 null）；先 attach 后导航 73 条实时请求 `size` 全有、`history=0`、无重复；UI 横幅/标签/详情说明正常、非法正则显示报错占位；p52/p55/p57 均 0 `pageerror`。
- 提交：`43e7ee6`

### 2026-10-27 · feat：脚本视图重做 + 跨脚本源码搜索（方案 004）
- 改了什么：`debugger` 按 `scriptId` 缓存源码、`get_script_content` 支持 `id`，新增 `search_scripts`（并发 6 / 最多 300 脚本 / 每脚本 20 处命中）；`router` 新增 `tool:script_search`。视图改为主从结构：列表显示外链/内联标签、文件名/域/行数；搜索框回车**跨脚本搜源码**并显示命中数与首行；源码区行号 + 命中行标记 + 关键字 `<mark>` + `‹ x/y ›` 跳转，新增复制/下载；≤560px 时列表在上、源码在下；inline 脚本用 `scriptId` 区分。
- 为什么：原 grep 只过滤脚本 URL，关键字不在 URL 时列表直接清空、根本搜不到源码；inline 脚本共用空 URL 只能命中第一条；并排布局把源码挤成一条缝。
- 验证：`dev/run.mjs` 77/77；真实页面（inline + 外链）`matched=2 scanned=5`、按 id 读取含 token；UI stub 验证搜索列表 2 行、命中徽标 2/1 处、`mark`、`1/2→2/2`、inline 头 `#2`、复制成功；p45/p46 均 0 `pageerror`；手册与 11-script 截图同步。
- 提交：`0ac4e9b`

### 2026-10-27 · feat：网络 / Cookie 改为主从视图
- 改了什么：网络默认列收敛为方法/状态/URL（旧默认列自动迁移，仍可从「列」菜单加回），详情顶部新增「常规」块（完整 URL + 复制、方法、状态码、类型、大小、来源），与 DevTools Headers 的信息结构对齐。Cookie 从宽表格改为「标识列表 + 下方详情」：列表只显示名称/域/标志，点击行选中；详情显示完整值（自动换行、点击复制）、域、路径、标志，以及复制值 / 复制 name=value / 编辑 / 删除。保留 URL 单元格 `⧉` 复制、详情「复制 URL」、Cookie「复制全部」。
- 为什么：窄侧栏里宽表只能靠横向滚动，列被压缩、值看不全；按 DevTools 的「唯一标识列表 + 选中详情」组织后，列表可扫、详情可读可复制。
- 验证：`dev/run.mjs` 76/76；真实 UI：常规块 6 行、167 字符 URL 复制成功；Cookie 列表 1 行、详情完整值可复制、掩码状态仍可复制、复制全部成功；p6/p8 回归通过，0 `pageerror`；手册与 02/03/10 截图同步。
- 提交：`e2d2e8e`

### 2026-10-27 · fix：网络 URL 与 Cookie 值可看全、可复制
- 改了什么：新增通用 `copyText`（Clipboard API + execCommand 降级 + toast）。网络：URL 单元格内嵌 `⧉` 复制完整 URL，详情顶部固定显示完整 URL 条并提供「复制 URL」，操作列吸附右侧。Cookie：始终取回真实值（是否明文由「显示值」控制，复制不受开关影响）；勾选时完整值显示并自动换行；点击值复制；行内「复制」；工具栏新增「复制全部」（`name=value; domain=…; path=…`）。Cookie 表改为 `width:max-content`，避免宽表把列压成单字。
- 为什么：网络 URL 被省略号截断且无复制入口；Cookie 值既掩码又被列宽截断，用户既看不全也拿不到。
- 验证：`dev/run.mjs` 76/76；真实 UI：167 字符 URL 复制成功、47 字符 Cookie 值复制成功、掩码状态下仍可复制、复制全部包含 `sid=…; domain=…`，0 `pageerror`；手册与 02/10 截图同步。
- 提交：`ab1782a`

### 2026-10-27 · style：统一全站输入控件与关键布局
- 改了什么：输入/下拉/数字/代码框统一 34px 高、8px 圆角、白底、品牌蓝焦点环；textarea 最小 62px、代码框 68px；`ctrl-btn` 34px、`mini-btn` 28px 与输入同基线。网络筛选条改为两行栅格（URL / 元数据搜索各占一行，方法/状态/域/类型/列固定列宽），列配置菜单锚定筛选条，占位文案缩短。AI 输入区顶部可换行、模式分段 30px 与模型下拉同高、模型下拉弹性占满、提示独占一行，清理输入框重复声明。项目/Issue/模板的裸 `select` 统一为 `select-mini`，添加事实/添加模板/保存 Issue 改为主操作按钮，表单间距与 Issue 标签字号调大。
- 为什么：全站输入高度/圆角/焦点样式不一致，网络筛选在窄侧栏被挤成一条缝甚至裁切，AI 输入区顶部控件互相挤压；需要一套统一控件层而不是逐处补丁。
- 验证：`dev/run.mjs` 76/76；真实 UI：网络控件高度均 34px、焦点边框/光环 `rgb(65,118,230)`、AI 模式与模型同高 30px、Issue 下拉 34px；`p4/p5/p6/p8/ai_pick` 全部通过，0 `pageerror`；手册 18 张截图全部重生成。另修复 `p6` 检查未处理会话命名弹层的问题（dev）。
- 提交：`2236920`

### 2026-10-26 · feat：骨架改为全量源码式视图
- 改了什么：`get_page_skeleton` 改取完整 DOM（`depth=-1`），删除 token 预算 / 深度降级 / JSON 截断 / 文本截断，保留全部属性；`script`/`style` 保留标签（内容仍走「脚本」页）；面板渲染改为源码式——行号、闭合标签、空标签补齐、标签/属性名/属性值/文本四类高亮，深度改为 CSS 步进（上限 14 级），新增「自动换行」开关，并修复混合内容文本重复。
- 为什么：原骨架有三重生成上限（深度、10000 token、文本 200/100/50 字符），用户看到的不是完整前端结构；且只有颜色区分，没有行号/闭合标签/换行控制，读起来不像源码。
- 验证：`dev/run.mjs` 76/76（新增 L2 骨架全量检查）；真实页面（18 层 DOM / 300 字符属性 / 400 字文本）：`truncated=false`、`lv17` 存在、属性与文本完整、面板 50 行、闭合标签正确、0 `pageerror`；合成树验证高亮、行号、换行开关与 42 行渲染。
- 提交：`3c8504e`

### 2026-10-26 · style：重做设置页布局与文案
- 改了什么：设置弹层改为仪表式布局（404px、标题/副标题、模型·生成·行为三段分组、左侧强调线、底部固定操作栏）；字段统一常驻标签、36px 输入框与焦点环，说明文字独立成行；模型行改为默认胶囊 + 名称 + 删除 + 三个带标签的输入；操作栏加滚动渐隐，按钮改为「取消 / 保存」；尊重 `prefers-reduced-motion`。同时修正文案：LLM 地址列表实际是「默认 API 地址」回退（首个），不是白名单。
- 为什么：原设置页所有字段挤在 360px 单列里，标签与说明混排、模型四格网格过密，阅读与填写都显得局促。
- 验证：`dev/run.mjs` 75/75；真实 UI：弹层宽 395px、页脚完整可见、无横向溢出、批准下拉高 36px、三段标题与五个字段标签齐全；添加模型→填写→保存→重开名称保留；0 `pageerror`；`17-settings.png` 已重生成。
- 提交：`87803d7`

### 2026-10-26 · feat：会话顶部上下文面板（方案 003）
- 改了什么：任务开始时把本轮注入的项目事实（key/摘要/置信度/类别、N/总数）与预算（窗口/压力阈值/保留尾部）写入 `conv:<id>.contextFacts/contextBudget` 并推 `context:snapshot`；`ai:conversation_detail` 返回这两个字段；AI 会话聊天区顶部新增可展开面板（摘要 + 事实列表 + 最近压缩 method/trigger/tokens/时间），打开详情、记录刷新、实时快照、压缩完成都会更新；样式限高 220px 可滚动。
- 为什么：此前用户与模型都看不到“本轮到底注入了哪些 facts、什么时候压缩过”，上下文治理只能靠猜；这是上下文可观察性的最后一块。
- 验证：`dev/run.mjs` 75/75（新增 L2 面板/快照检查）；真实 UI：摘要「事实 2/35 · 压缩 2 次」、展开 2 条事实、元信息含窗口/阈值/尾部与最近压缩详情、实时 `context:snapshot` 更新为 `3/40`、0 `pageerror`。
- 提交：`2f6d205`

### 2026-10-26 · feat：让 AI 知道自己能做什么（方案 002）
- 改了什么：`prompts.js` 删除 IDENTITY 手写工具目录与审计员段，新增 `BOUNDARY_SECTION` / `buildCapabilityManifest()` / `buildEnvSection()`，`assembleSections` 支持 `capability` / `env` 动态段；`agent.js` 任务模式按「工具注册表 + 档位 + 批准级别」生成能力清单（lite 档标注不可用工具）与当前环境（项目名、事实/Issue/模板计数、模式、档位、批准级别），对话模式生成能力说明传给 `runChat`；`llm.js` 不再硬编码工具清单。
- 为什么：模型只拿到工具 schema，不知道自己的批准规则、所属项目、档位与边界；IDENTITY 里的手写清单已与 lite 档漂移（列了 `call_expert` 却不可用）。
- 验证：`dev/run.mjs` 74/74（新增 5 条 L1：lite 隐藏工具、批准分组、环境段、段落顺序、边界不含 Cookie；1 条 L2）；真实模型回复未测（无可用的已配置端点），验证的是注入内容本身。
- 提交：`dde9a22`

### 2026-10-26 · style：项目卡片统一高度
- 改了什么：项目卡片改为 `min-height: 70px` + flex 纵向居中；名称与描述都做单行省略号（`text-overflow: ellipsis`），长描述不再换行撑高卡片。
- 为什么：有描述 / 描述换行的卡片会比无描述卡片高，列表看起来参差不齐。
- 验证：`dev/run.mjs` 69/69；真实 UI 测量两张卡片高度均为 70px（修复前 62px / 70px），长描述显示省略号；截图已重生成。
- 提交：`76ebd87`

### 2026-10-26 · style：顶栏当前项目改为醒目胶囊
- 改了什么：顶栏项目选择器改为深色胶囊 + 绿色状态点 + 自绘下拉箭头；未选项目时灰点并显示「未选项目」；提高选择器 CSS 特异性，修复被 `#app select` 通用样式覆盖导致仍是白底小下拉的问题；鼠标悬停 / 聚焦有明确反馈。
- 为什么：原选择器字号小、白底，和普通表单控件无差别，很难一眼看出当前处于哪个项目；项目是持久数据的归属，状态必须醒目。
- 验证：`dev/run.mjs` 69/69；真实 UI 截图（20-project / 01-page）确认深色胶囊显示「演示项目」，空项目状态显示「未选项目」+ 灰点。
- 提交：`9e22bf9`

### 2026-10-26 · feat：项目页新建会话先输入名称
- 改了什么：项目详情「会话」页签的 `新建会话` 改为先弹层输入**会话名称**（必填、自动聚焦），空名提示且不创建；创建后绑定当前查看的项目并直接打开。顺带修复上一提交引入的 `newConv` 未定义——它会让 `initProjectModule` 整体抛错，导致项目页按钮全部失效。
- 为什么：直接生成“项目会话”这种默认名没有辨识度；项目页创建会话应先命名。
- 验证：`dev/run.mjs` 69/69；真实 UI：弹层出现、输入框聚焦、空名不创建（0 会话）、输入「登录接口分析」后创建并绑定 p1、AI 详情打开，0 `pageerror`；p8 项目页回归全过。
- 提交：`1dc4f22`

### 2026-10-26 · fix：换项目后 AI 会话列表不跟随
- 改了什么：AI 会话列表只显示**当前项目的会话 + 独立会话**，切换项目后随之变化；AI 页「新建会话」自动归属当前项目（界面不显示项目）；页面/脚本送 AI 的选择层默认也只列当前项目 + 独立会话，新建同样归属当前项目。
- 为什么：上一版为了"AI 页不出现项目概念"把列表做成了全局平铺，导致换项目后列表毫无变化，与"项目即数据容器"的心智冲突；正确做法是**界面不暴露项目，但列表跟随当前项目**。
- 验证：`dev/run.mjs` 69/69（新增"列表按当前项目过滤"检查）；真实 UI：项目 A→B 后 AI 列表从「A 的会话」变为「B 的会话」；项目页会话页签仍随项目正确切换。
- 提交：`7cbf730`

### 2026-10-26 · feat：AI 页只谈会话；项目内送 AI 只列本项目会话
- 改了什么：AI 页会话列表改为平铺（不再按项目分组），移除「项目」按钮与「绑定项目」入口，AI 新建会话为独立会话，切到 AI 视图隐藏顶栏项目选择器；项目页的「送入 AI / 模板运行」选择层只列**本项目**会话（没有则只有新建，且新建绑定本项目），选择层不提供创建项目；项目黑板「送入 AI」同样只列本项目会话。
- 为什么：项目与项目内会话是「项目」页的职责；AI 页只应处理会话，混入项目概念会造成两套心智。项目内投递 AI 也只应看到该项目会话，避免串到别的项目。
- 验证：`dev/run.mjs` 68/68；真实 UI：模板运行选择层 = 新建 + 本项目 1 条、AI 视图无项目按钮且项目选择器隐藏、页面 Inspect 选择层列全部会话且新建为独立会话，0 `pageerror`。
- 提交：`2de593e`

### 2026-10-26 · feat：模板「运行」改为先选会话
- 改了什么：`runProjectTask` 不再自动新建会话，改为调用会话选择层，新建时绑定「当前查看的项目」；`pickConversationForAI` 支持传入目标项目，弹层提示与「新建会话」选项会显示该项目名；项目黑板「送入 AI」同样带上项目 id。
- 为什么：模板「运行」与「送 AI 分析 / 精确调试 / 送入 AI」是同一类动作，不应该有的让用户选会话、有的替用户决定；项目页里还可能查看的不是当前项目，新建会话必须绑到正在看的项目。
- 验证：`dev/run.mjs` 67/67；真实 UI：模板运行弹出 3 个选项、选已有会话后输入框带入模板内容、会话数保持 2（未新建）、0 `pageerror`。
- 提交：`92a0f75`

### 2026-10-26 · feat：项目页默认列表 + 项目名唯一
- 改了什么：`createProject` / `renameProject` 拒绝重名（忽略首尾空格与大小写）与空名，分别返回 `CONFLICT` / `INVALID`；`project:create` / `project:rename` 透传错误；`loadProjects` 只有显式 `focusId` 才打开详情，进入「项目」页默认停在列表。
- 为什么：进入项目页直接跳详情不符合"先看全局"的预期；同名项目会在选择器 / 绑定项目弹层里无法区分，必须从数据层禁止。
- 验证：`dev/run.mjs` 67/67（新增重名/空名用例）；真实 UI：项目页默认列表、重名创建返回「项目名称已存在」`CONFLICT`、删除后空列表不复活、完整项目页链路 0 `pageerror`；截图 `docs/images/20-project.png` 更新为列表态。
- 提交：`ff774da`

### 2026-10-26 · fix：项目统一到项目页（修复 AI 页/项目页列表不一致）
- 改了什么：`ensureActiveProject()` 在没有任何项目时返回 `null`，不再自动创建「默认项目」；`listProjects()` 过滤 AI 内部全局黑板；无项目时 Issue / 黑板 / 模板写入返回明确错误；删除 AI 页的「新建/重命名/删除项目」弹层，AI 页按钮改为「项目」并跳转项目页。
- 为什么：两个界面都在管理同一份项目数据，AI 页也能新建/删除项目，加上"无项目自动造默认项目"，导致删除后项目页仍出现项目（默认项目复活），两边看起来各有一套。
- 验证：`dev/run.mjs` 66/66（新增：AI 页不得再有项目管理弹层、无项目不得自动创建、列表过滤 AI 项目）；真实 UI：初始 0 项目 → 创建 1 → AI「项目」跳转 → 删除后 0 且不复活 → 无项目时 Issue 保存返回「请先在「项目」页创建项目」，0 `pageerror`。
- 提交：`ab1ad4f`

### 2026-10-26 · feat：送 AI 前由用户选择会话（送 AI 分析 / 精确调试 / 项目事实）
- 改了什么：新增会话选择弹层：列出已有会话（项目/独立 + 消息数）或新建（标题可改、自动绑定当前项目），带「立即发送」勾选；「送 AI 分析」「精确调试」「项目事实 → 送入 AI」全部改为先选会话再投递。
- 为什么：上一版"自动复用/新建会话"仍替用户做了决定——不知道会进哪个会话、也容易混进不相关的上下文；应当由用户明确选择目标会话或新建。
- 验证：`dev/run.mjs` 64/64；真实 UI：弹层 3 个选项（新建 + 2 条会话），选已有会话后内容进入该会话；选新建后会话数 2→3 且「精确调试」内容就位，0 `pageerror`。
- 提交：`b9b15b1`

### 2026-10-26 · fix：Inspect「送 AI 分析 / 精确调试」找不到输出（修复）
- 改了什么：新增 `aiSendFromPage()`：先在当前项目下新建或复用一条会话 → 切到 AI 页并打开 → 填输入框（已配置模型则直接发送）；「送 AI 分析」与脚本「送片段给 AI」不再走一次性 `ai:chat`；「精确调试」不再裸调 `ai:task`（缺 convId、无页面跳转）。
- 为什么：`ai:chat` 的回复只推到底部状态条、不落任何会话，用户"找不到"；`ai:task` 没传 convId 也没切页，点击后表现为无反应。
- 验证：`dev/run.mjs` 64/64（新增"面板不得再直接调用 ai:chat"检查）；真实 UI：点击后 AI 页打开、会话自动创建 1 条、输入框分别出现元素分析与精确调试内容，第二次点击复用同一会话，0 `pageerror`。
- 提交：`71f46b7`

## 0.3.0 — 2026-10-26

### 2026-10-26 · chore：0.3.0 发布收口（方案 001 / P7）
- 改了什么：版本 `0.3.0` 五处同步（manifest / README 标题 / `state.js` / `router.js VERSION` / background 启动日志）；新增 `cleanupLegacyKeys()`，启动时清理 `f12x_scope_v1`、旧 `shot_*` 池 + `shots_index_v1`、已迁移的 `conversations_v2` / `projects_v2` / `sites_v1` / `active_site_v1` / `f12x_issues_v1`；迁移备份 `sites_backup_v1` / `issues_backup_v1` 各保留一版；手册版本与页脚同步。
- 为什么：0.3.0 的"项目即唯一持久化容器"重构（P1–P6）已全部完成，需要一次干净发布：版本一致、旧键不残留、文档与代码对齐。
- 验证：`dev/run.mjs` 63/63（含版本五处一致检查）；清理只读索引键，不做全库扫描；真实 UI 冒烟覆盖项目页 / Issue / 截图 / AI 会话。
- 提交：`6ec714f`

### 2026-10-26 · feat：项目页完整布局与跨模块联动（方案 001 / P6+）
- 改了什么：项目列表加搜索与新建栏（名称 + 描述）；详情页四页签全部改成内联编辑器（黑板新增/送入 AI、Issue 新建编辑、模板新增/运行、会话新建/打开/解绑），并加 `导出 JSON`；模板`运行`会新建绑定该项目的会话并直接下发任务；事实`送入 AI` 自动切页填输入框。
- 为什么：P6 第一版只是最小可用（只读列表 + 打开 Issue 工作台），项目页与网络 / Issue / AI / 模板之间还缺闭环；补完后"一个项目"能独立完成 收集 → 记录 → 验证 → 下发。
- 验证：`dev/run.mjs` 63/63；真实 UI 全链路：新增事实 2→3、Issue 1→2、模板 1→2、新建会话跳 AI 并打开、导出 `f12x-project-客户 A 评估.json`、新建项目 2→3，0 `pageerror`；截图 `docs/images/20-project.png` 已更新。
- 提交：`7ca6d5a`

### 2026-10-26 · feat：项目视图与当前项目切换（方案 001 / P6）
- 改了什么：新增「项目」视图（列表 + 页签详情：黑板 / Issue / 模板 / 会话）+ 顶栏项目选择器；后台补 `project:get` / `project:set_active` / `project:fact_remove` / `project:template_add` / `project:template_remove`，`issue:save/delete` 支持显式 `projectId`；删除项目只删黑板 / Issue / 模板，会话解绑保留。
- 为什么：项目已是唯一持久化容器，但没有界面入口；用户需要一个地方统一看/管黑板、Issue、模板、会话，并切换当前项目。
- 验证：`dev/run.mjs` 63/63（新增项目视图检查）；真实 UI：列表 2 项、详情四页签计数正确、新建后 3 项、0 `pageerror`；截图 `docs/images/20-project.png`。
- 提交：`c4cf11f`

### 2026-10-26 · feat：AI 会话截图引用化（方案 001 / P5）
- 改了什么：`screenshot` 不再写全局 5 张池，改为按会话 `shot:<convId>:<key>` + `shot_index:<convId>`（无数量上限）；AI 截图写入会话并记 `conv.shots`，模型只拿到引用 key；会话里渲染「📎 截图引用」，点击弹层看原图并可导出 PNG；删除会话级联删图。
- 为什么：全局 5 张池既限制数量、又和会话无归属；按会话存引用后，图片不占对话上下文、可以无限留存、删会话即彻底清理。
- 验证：`dev/run.mjs` 62/62（截图存储 / 无上限 / 级联删除用例 + L2 检查）；真实 UI：引用行可见、点击弹层出现图片、0 `pageerror`。手动截图路径未在真实页面手测（dataUrl 直出）。
- 提交：`bb493b0`

### 2026-10-26 · feat：Issue 归入项目持久化（方案 001 / P4）
- 改了什么：新增 `active_project_v1` 与 `ensureActiveProject()`（没有项目时自动建「默认项目」）；Issue 读写改走当前项目的 `project.issues`（`project:active` / `issue:list` / `issue:save` / `issue:delete`），面板不再直接读写 `f12x_issues_v1`；旧全局库一次性迁入「迁移项目（旧数据）」并留 `issues_backup_v1` 备份。
- 为什么：Issue 是用户手工产出的结论，属于持久数据；按"持久数据全部落项目"的决策，不应再有独立的全局 Issue 库。
- 验证：`dev/run.mjs` 60/60；真实 UI 走通「保存到演示项目 → 刷新仍在 → 导出 f12x-issues.md → 删除后清空」，0 `pageerror`。
- 提交：`a03cc35`

### 2026-10-26 · refactor：下线站点工作区并迁入项目（方案 001 / P3）
- 改了什么：`memory.js` 删除全部站点 CRUD，新增 `migrateSitesToProjectsIfNeeded()`（每个站点 → 同名项目，重名加后缀；facts/templates 并入，留 `sites_backup_v1` 备份）；`router.js` 删 9 个 `site:*` 分支、新增 `project:fact_add`、`get_state` 去 `activeSiteId`；面板删站点视图/顶栏选择器/导航项/全部站点函数（约 110 处引用），「标记为发现」改「存到项目黑板」，Repeater「存到站点」改「存到黑板」；`index.html` / `styles.css` 删对应结构与样式（保留 AI 复用的 `.site-pane`）；README 去站点行与 `sites_v1`，手册删第 9 章并重编号。
- 为什么：站点工作区与「项目」概念重复、还要手工维护；用户决定持久化数据统一落到项目，站点整体下线。
- 验证：`dev/run.mjs` 57/57（新增站点迁移用例 + L2 站点下线检查）；Playwright 真实加载扩展重截界面：导航 6 项、顶栏无站点选择器、全流程 0 `pageerror`。
- 提交：`b9b12e0`

### 2026-10-26 · feat：项目容器分键存储 + Issue/模板 CRUD（方案 001 / P2）
- 改了什么：`projects_v2`（单键 map，每次保存重写全部项目）改为 `projects_index_v2`（元数据）+ `project:<id>`（项目全文）；项目内新增 `issues` / `templates` 数组与 CRUD；黑板事实增加 `source: user|ai`；删除项目改为逐个解绑会话（适配分键会话布局）；启动时幂等迁移旧 `projects_v2`。
- 为什么：项目要成为唯一持久化容器（黑板/Issue/模板/会话），旧的单键 map 与站点工作区并存、且每次保存全量重写。
- 验证：`dev/run.mjs` 55/55（新增 4 条 L1：迁移幂等 / 分键与计数 / 删除解绑 / 来源标记）；Playwright 真实 UI 中项目黑板显示「演示项目 · 3 条事实」。
- 提交：`ba45a63`

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
