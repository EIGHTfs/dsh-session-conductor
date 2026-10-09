---
name: dsh-session-conductor-functions
description: dsh-session-conductor 插件全部功能说明书（每个功能一份说明，面向 AI 与使用者）：会话列表/归档/恢复/删除/撤回消息/自动重命名/自动续跑/置为不活跃/释放全部/会话按工作区分组显示/价值分析/全文搜索/损坏修复（seq-gap/EIO/帧）/压缩模型选择/撤回消息 的用途、参数、返回、注意事项。经 systemPrompt.section 强制全文注入每个会话（与使用手册 skills/dsh-session-conductor.md 配合，排查/细节以本说明书为准）。处理"这个功能怎么用/参数是什么/返回什么/排查插件行为/会话打不开/会话价值"类请求时加载。
whenToUse: 需要了解 dsh-session-conductor 某个功能怎么用/参数是什么/返回什么；排查插件工具/API 行为；用户问「这个功能是干嘛的」时直接引用本说明书对应章节。
---

# dsh-session-conductor 功能说明书（强制全文注入）

> 版本：。源码：EIGHTfs/dsh-session-conductor。数据源：/api/session-conductor/*（webServer 注册）。

## 一、核心 API 总览

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/session-conductor/list` | GET | 全部会话（id/title/cwd/createdAt/updatedAt/live/running/archived/interruption/autoRename/autoContinue/continueRunning） |
| `/api/session-conductor/archive` | POST | 归档会话（原生 workspaceRegistry.archiveSession） |
| `/api/session-conductor/unarchive` | POST | 取消归档（注册表 setState 写回） |
| `/api/session-conductor/delete` | POST | 删除会话（per-session 串行锁；拒绝运行中/续跑中；detach + 清理 + 删磁盘日志） |
| `/api/session-conductor/undo-message` | POST | 撤回最后一条用户消息（dryRun 预览 + 二次确认 + .undo-backup 备份） |
| `/api/session-conductor/auto-rename` | POST | 开启/关闭某会话自动重命名 |
| `/api/session-conductor/analyze` | POST | 立即分析一次对话主题，必要时自动重命名 |
| `/api/session-conductor/continue` | POST | 手动续跑被中断的会话 |
| `/api/session-conductor/auto-continue` | POST | 开启/关闭某会话自动续跑 |
| `/api/session-conductor/scan` | POST | 立即扫描全部会话并自动续跑可续的 |
| `/api/session-conductor/detach` / `detach-all` | POST | 置为不活跃 / 释放全部空闲（拆回冷状态） |
| `/api/session-conductor/search` | POST | 全文搜索（官方 FTS5 优先 + 内置 zstd 扫描兜底） |
| `/api/session-conductor/delete-batch` / `delete-by-rule` | POST | 批量删除 / 按条件删除（可 dryRun） |
| `/api/session-conductor/value-analysis` | POST | 会话价值分析（五维规则 + 关键词置顶 + 孤儿保护） |
| `/api/session-conductor/repair-sessions` | POST | 扫描并修复损坏会话日志（工具结果格式） |
| `/api/session-conductor/repair-seq-gap` | POST | seq-gap + token-surface 双重损坏修复 |
| `/api/session-conductor/repair-eio` | POST | EIO 坏块会话修复（BTRFS csum 损坏） |
| `/api/session-conductor/repair-dual-format` | POST | 双格式会话修复（同目录并存 session.jsonl + session.jsonl.zstd，） |
| `/api/session-conductor/group/{list,status,new-session}` | GET/POST | 会话分组（Workspace）只读展示 + 分组下新建会话 |
| `/api/session-conductor/compaction-model` | GET/POST | 压缩模型选择（省 pro 成本） |
| `/api/session-conductor/auto-continue-gate` | GET/POST | 自动续跑全局闸门（open/closed） |
| `/api/task-completion/status` / `render` / `check` | GET/POST | 任务完成汇报管道 |
| AI 工具 `list_models` / `set_member_model` | — | 成员模型切换（列模型 / 给指定成员切模型，见第九章） |
| AI 工具 `context_usage` | — | 上下文用量自查（占用与构成，只读无参数，见第十章） |

## 二、会话生命周期操作

### 归档 / 恢复（session-archive-restorable）
- `archive`：归档会话 = 从侧边栏隐藏，数据保留。**用户说"归档会话"未指定对象时默认归档当前会话**。
- `unarchive`：恢复归档会话（内置菜单没有此入口，插件补上）。
- 归档会话标题数据层带 `[工作区名] ` 前缀（ 起），面板显示层剥离前缀、按 archiveWs 分组；取消归档时还原原标题。

### 删除（session-delete-self）
- `delete`：拒绝删除运行中/续跑中会话（先等回合结束）；二次确认；原目录保留策略见 delete-self.sh。
- **用户说"删除会话"未指定对象时默认删除当前会话**。删除前建议先做价值判断/提炼归档。
- 批量：`delete-batch` 逐条复用删除链路，运行中跳过不整体失败；`delete-by-rule` 按 归档状态/超期未活跃天数/cwd 前缀，dryRun 可预览。

### 撤回消息（session-undo-message，）
- `undo-message`：直接操作会话日志文件 session.jsonl.zstd，删除**最后一条真实用户消息**（source.kind==="user"）及其触发的整轮回复。
- ⚠️ 必须只匹配 `source.kind === "user"`：注入的 runtime context/plugin 与 system-reminder/skill-catalog 也是 user/message 类型，不能算真实用户消息。
- 流程：dryRun 预览 → 二次确认 → 执行 → .undo-backup 备份可找回。运行中会话不能撤回（等回合结束再试）。seq 无需重编号（删尾部）。

## 三、自动化能力

### 自动重命名（auto-rename）
- 每会话可勾选「自动重命名」：AI 分析最近对话，主题明显偏离标题时自动改标题（sessionTitle.rename 落盘，source=user 会 pin 住标题）。
- 触发时机：每次回合结束（turn/end）后延迟分析；带最小间隔与新增消息数门槛控制 LLM 成本。
- `analyze`：立即手动分析一次。

### 自动续跑（auto-continue）
- 读取会话记录识别「非人为中断」回合 → 自动让 AI 继续完成原任务。
- ⚠️  起**默认关闭**（`defaultAutoContinue` 缺省 false）：未显式开启的会话不再自动续跑；需在面板每条会话「⋯」菜单里逐条开启，或显式配置 `defaultAutoContinue: true` 全局开启。已显式开启的会话不受影响。
- 中断判定（只看会话最后一条回合边界）：
  - `turn/end reason.kind === "interrupted"`（崩溃修复写入的合成闭合）→ 续
  - `turn/end reason.kind === "error"`（**本轮运行失败**， 起任意 error code 都识别，不再限 {RATE_LIMIT, SERVER, TIMEOUT, EMPTY_RESPONSE}）→ 续；识别后等待 `failRetryDelayMs`（默认 **30 秒**）再自动续跑，避免失败立即重试
  - `turn/end reason.kind === "aborted"` → 一律不续（真实数据只有 user/disposed，都是主动取消）
  - 末尾是未闭合 turn/start（open turn）→ 冷会话视为崩溃残留可续；live 会话绝不续
- 机制：live 会话 → `agent.followup()`；cold 会话 → `ctx.agents.resume()` → followup → flush → dispose 释放。
- 防护：每会话串行锁 + 全局并发闸（maxConcurrent 默认 2）+ 活跃会话上限（maxAttached 默认 12，达到后暂停自动续跑）+ 同会话冷却（cooldownMs 默认 15 分钟）+ 每会话续跑次数上限（maxContinuesPerSession 默认 3）。
- `auto-continue-gate`：closed → 一切自动续跑跳过；DSH 刚启动 guardian 置 closed，用户第一次手动对话后自动置 open。
- ⚠️  稳定性修复：①**开开关立即续跑**——面板打开某会话自动续跑开关时立刻触发一次（跳过失败重试延迟），不再等最长 `scanIntervalMs`（默认 5 分钟）周期扫描；②**续跑链三层 try/catch + 进程级 `unhandledRejection` 兜底**——此前续跑链任一异步 rejection 逃逸，因宿主 bin.ts 未注册兜底 handler，会被 Node 默认 `throw` **杀死整个 DSH 进程**（现象：自动续跑能用、但过一会进程就没了）；现已保证插件异步链永不向外逃逸 rejection，兜底 handler 记日志不退出。排查「进程莫名退出」时优先看插件日志里的「捕获未处理的 Promise rejection」。

### 置为不活跃 / 释放全部（detach）
- DSH 会话一旦被打开就一直挂内存（活跃数只增不减）。`detach` 把空闲会话的 agent 拆下来回冷状态：对话记录完整保留、会话仍在列表、重新打开或发消息自动恢复挂载。运行中会话不释放。
- `detach-all`：释放全部空闲。

## 四、会话按工作区分组显示 + 分组下新建会话（ 合并 group / 2026-09-26 精简）

- **分组管理（创建/重命名/删除分组、移动会话）已移除**（回归 DSH 官方 workspace 机制）。
- **保留只读展示**：面板「全部会话」视图按会话 cwd 的最深祖先分组分节展示——分组标题带会话数、可折叠；0 会话分组不显示；未匹配归「未分组」。数据源 GET /api/session-conductor/group/list。
- **保留分组下新建会话**：POST /api/session-conductor/group/new-session {workspaceId?, prompt?, handoff?}——转发官方 session.create RPC（cwd 自动取分组 path，自动归属）；**workspaceId 缺省 = 上次会话的工作区**（最近活跃会话 cwd 归属的分组，找不到兜底 .dsh 上一层 /workspace 默认工作区）；可选 handoff 首条交接消息 + 承接会话默认开自动重命名；`blockGroupNewSession: true` 配置可 401 禁用。
- API：GET /api/session-conductor/group/status（分组数/groupRoot/profile）。
- 归档会话标题的「[工作区名] 」前缀用 index.js 的 workspaceNameOf（独立实现，不依赖本分组模块）。

## 五、价值分析

- `value-analysis`：会话价值五维规则（**用户细节补充 > 活跃 > 长度 > 完成数 > 未完成**）+ 关键词无条件置顶 + 孤儿/事件读取失败「宁高不丢」保护。
- 结果分类：已完成（最后回复含 ✅ 任务完成/已解答 + ═ 分隔线）、未完成任务（⚠️/❌ 标记或中断）、久未对话（>3 天无活动）、活跃中。
- 与 session-value-user-review：评估会话价值时顺带按用户成长评价结构（真实进步/客观短板/总体判断）评价用户本期表现，一次产出「会话价值清单 + 用户评价」。

## 六、损坏修复（repair 家族）

| 类型 | 症状 | 修复 | 模块 |
|---|---|---|---|
| 工具结果格式损坏 | history unavailable | `repair-sessions`（与 DSH 同校验规则扫描+重写，.bak-corrupt 备份） | lib/repair.js |
| seq-gap + token-surface | history unavailable / seq gap in committed region / token surface: no adjacent shadow price | `repair-seq-gap`（seq 偏移/replace 引用缺失/compaction shadowedRange 三类叠加） | lib/seq-gap-repair.js |
| EIO 坏块 | 网关报 EIO: i/o error, read（BTRFS csum / iSCSI LUN） | `repair-eio`（块级探测坏块边界 → 截断完好数据 COW 换新块，DSH 自动收尾 torn tail） | lib/eio-repair.js |
| 双格式（encodingMismatch） | 会话列表整体失败、侧边栏会话全消失（listArtifacts 抛 "uses .jsonl, but backend configured for zstd"） | `repair-dual-format`（纯磁盘级扫描旁路 persistence：同目录并存 session.jsonl + session.jsonl.zstd 时把明文移入 .dual-format-backup/ 保留 zstd 官方格式，live 会话跳过） | lib/repair.js |
| zstd 帧损坏 | 解码失败 | `repair-sessions` 兜底帧修复 | lib/zstd-frames.js |

## 七、模板注入（ 新增 /  强制门禁）

- 两个固定槽位：`plan`（方案模板——修改代码前先出提案）/ `closing`（收尾模板——任务完成汇报格式）。三种来源：上传本地 md、在线 md 网址（下载转存正文）、DSH 目录内浏览选用。开启后经 systemPrompt section「session-templates」（order 945）注入，AI 一开始就看见约定。设置 → 会话管理 → 模板注入。
- API：GET /api/session-conductor/templates；POST {slot, name, content} / {slot, url} / {slot, enabled} / {slot, action:"remove"} / {slot, action:"pickPath", path} / **{slot:'plan', enforce}**。
- ** 强制门禁**：`plan.enforce=true` 时，未按方案模板出提案并获用户「确认」前，代码修改类工具调用被 `tools/pre-execute` waterfall 直接拒绝（`{kind:'deny'}`），拒绝理由指导 AI 先出提案。
  - 拦的工具：edit / write / apply（全拦）+ bash 写操作启发式（`>`/`>>` 重定向、sed -i、rm、mv、cp、tee、mkdir、touch、chmod/chown、git commit/reset/checkout --、patch、truncate、dd）。只读工具（read/grep/glob）永不拦。
  - 门判定**无状态**：每次拦截从会话事件流现场推导——「提案」= 确认消息之前那一段 AI 输出同时含提案标题（修改方案提案）+ 确认段（八、是否执行）双标记；「确认」= 最后一条**真人**用户消息命中确认词（严格式：整条仅确认词如 确认/同意/OK；宽松式：含 确认/同意/按方案执行/执行吧/go ahead）。系统注入消息（Current runtime context / The user said / <system-reminder> / 【dsh- / 🔑）自动跳过。
  - 无状态的好处：重启零恢复问题，门状态永远由真实对话记录决定，不与内存缓存打架。
  - 子 agent 豁免：delegationDepth>0 的会话放行（子 agent 无法交互确认；主会话是强制执行点）。
  - 门禁故障 fail-open（catch 里 next() + 留痕日志），不阻断工具链。
  - 开关即时生效（`templateStateCache` 热更新），无需重启；注入文本同步声明拦截口径，AI 与拦截器同一约定。

## 八、压缩模型选择

- 会话模型旁单独选压缩用模型（省 pro 成本）：`compactionModel: {provider, model}` 或 null=跟随会话模型。
- API：GET/POST /api/session-conductor/compaction-model（POST {provider,model} 或 {follow:true} 重置）。

## 九、成员模型切换（AI 工具 list_models / set_member_model）

- 用途：给 Team 里的队友/子代理**单独切模型**（只动该成员会话，不影响其他成员）。
- `list_models`：列出可用模型（provider → models[]）。**切模型前先用它拿确切 model id，不要凭记忆猜模型名。**
- `set_member_model({target, provider, model})`：
  - `target` 传**成员名**、**sessionId** 或标题关键字。定位顺序：① `ctx.agentTeams.listMembers(caller)` 名册（覆盖 `spawn_teammate` 创建的队友——它们**不在** `ctx.agents.list()` 里）；② `ctx.agents.list()`（普通活跃 agent，sessionId 精确 / 标题子串）。名册里成员名与 sessionId 都支持精确匹配，成员名还支持唯一子串。
  - 切前**校验 provider/model 组合**（用 `modelCatalog`）——无效组合直接报错，避免切完回合失败；并**拒绝 provisioning / failed 状态**的成员（创建中切换会让 roster 持久化恢复校验失败，成员被标记 failed 并**长期占用 active child 名额**）。
  - **切模型机制（官方模式二：`agent/request` 瀑布流拦截）**：`set_member_model` 把 override 写进插件 domain（`memberModelOverrides`，内存镜像 `memberModelCache`）；插件在 `agent/request` 里按 sessionId **每轮强制改写** `LlmCallConfig` 的 provider/model——**每个请求都改，所以跨轮必然持久**。
  - **为什么不靠官方「投影 pending + 请求头链」**：写 `model/selection` 事件只让 pending 生效**一轮**，被 `request/header` 消费后新回合沿请求头链回落；而新回合的请求头本身是按 `agentDefaultModel`（部署默认）发出的 → 实测 `request/header` 序列 agnes → wb 交替回落（`session-controller/src/model-selection-projection.ts:39-56` 的消费语义 + `agent.ts:497` 的 `agentOptions()`）。
  - **同时仍写 `model/selection` 事件**：让官方 `agent/pre-step` 追加 `[model changed: …]` 通知（可观测痕迹）。
  - **成员状态**：未挂载（inactive）**也能切**——override 落 domain；若会话日志里还没有该选择，会把事件直接写进会话日志（`appendSelectionEventToLog`，解码 → 追加 → 校验 → 备份 → 原子写回）。正在执行回合时会**先等它暂停**（`whenIdle`，最长 60s）再切。
- **验收方式（重要）**：
  - ✅ **请求级权威记录**：`request/header` 的 `config.model`——**连续多轮都应是新模型**（这是「跨轮持久」的唯一可靠证据）。
  - ✅ 会话 `model/selection` 事件（切换意图落盘）。
  - ✅ projcache `modelSelection.lastUsed` / `pending`（官方投影状态）。
  - ⚠️ **不要**只用 `model/selection` 事件或会话内注入的 `[model changed: …]` 提示下结论——实测出现过「提示是 agnes、请求头仍是 wb」的不一致。
  - ⚠️ **不要**用 `list_agents` 的 `model` 字段验收——它读 `agent.options.model`（成员创建时的静态值；`agent-team/src/roster.ts:138`）。
- 注意：服务端插件代码改动需重启宿主才生效（ESM 模块缓存）。

## 十、上下文用量自查（AI 工具 context_usage）

- 用途：AI **按需**查自己这次会话的上下文占用与构成，不用等人转述界面上的圆环数字。
- 无参数、纯只读：不触发模型调用、不写会话事件。
- 输出示例：

```
上下文已用 8%
~82K / 1M tokens
（已用 = 下一个请求的预计提示词规模，含尚未发出的表面增量）

上下文构成（启发式估算，非计费值）：
  系统提示词  ~3.6K
  工具定义  ~8.5K
  对话消息  ~55.2K
```

- **数据来源**：官方 `contextPressure`（`contextWindow` / `pressureTokens` / `projectedTokens`）与 `contextBreakdown`（`systemTokens` / `toolsTokens` / `messageTokens`）两个会话投影，与界面「上下文已用」圆环**同源同口径**。
- **已用口径**：优先 `projectedTokens`（下一个请求的预计提示词规模），退回 `pressureTokens`（provider 最新报告值）；百分比换算与前端 `context-occupancy.ts` 一致（含 100% 上限裁剪）。
- 占用 **≥ 85%** 时输出附一条收敛建议（把大结果落盘、先小结已完成部分、或把剩余任务拆到新会话）。
- ⚠️ **是启发式估算，不是计费值**（容量按约 4 字节/token 折算）。适合做压缩/分片决策；要计费口径请用官方 `tokenUsage` 投影（四桶 `uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`）。
- **设计取舍（为什么是自查工具而不是每轮注入数值）**：每轮注入会让系统提示词前缀每轮变化 ⇒ prompt cache 失效 ⇒ 成本上升，且注入文本本身占 token（为知道用量反而多花）；工具定义固定不变，只在调用时才产生输出。DSH 官方 compaction 本就是**自动**触发（`agent/pre-step` + `thresholdRatio`），AI 不参与决策 —— 本工具面向的是「AI 需要主动决策」的场景（要不要先总结再继续、要不要分片、要不要把大结果落盘）。
- **失败语义**：拿不到数据时如实说明原因（`exec.agent` 缺失 / `sessionProjections` 服务不可用 / 该路由还没上报 `contextWindow`），不抛异常、不返回空。

## 十一、通用行为约定（浓缩自原全局 skill，约束所有 AI 所有会话）

### 任务开始与确认（analyze-then-confirm / ask-with-options / todo-ask-confirm）
- 收到任务先分析（理解需求/现状/风险/方案/影响面），**列出本次读取/加载的每个 skill 及其来源路径**，确认后才动手。修改/删除/重启/安装/移动/推送等有副作用操作必须先确认。
- 需要用户决策/确认/选择时**必须用 ask_user_question 弹选项**（每项 2+ 选项 + 推荐标注 + 允许自定义），禁止纯文本开放提问；多事项用提问列表一次性问清。
- 用户简短回复（"好/行/继续"）按 user-confirmation-style 复述理解。

### 实测与验证（verify-before-diagnose）
- 诊断故障必须先实测（mount/df/写测试/curl/ps/读日志）再下结论，禁止凭历史经验脑补；访问地址先 hostname -I 确认；查插件 GitHub 仓库地址用 dsh-repo-index。

### 会话 ID 必须带标题（session-id-title-rule）
- 任何涉及会话 ID（session-xxxx）的场合——文档/skill/任务清单/跨会话消息/日志/回复——必须同时给出对应会话标题，禁止只甩 ID。

### 移交 vs 派生（handover-vs-delegation）
- 会话交接（跨会话工作移交）与 subagent 派生任务本质相同（上下文不共享、靠外部载体传递状态），但权威源/确认机制/信任模型不同；互相借鉴结构化结果协议。

### skill 规则（skill-source-rule / skill-to-code-rule / plugin-dev-log-rule / plugin-feedback-to-skill）
- 写/改插件前**必读该插件的 skill**（先读后写）；查找 skill 时插件项目 skills/ 与 .dsh/skills 双处并查；同名冲突时**插件 skill 版本 100% 权威**；.dsh/skills 副本从插件 skill 复制、不手改。
- 每次实际使用 skill 按四维（高频/逻辑确定/有副作用风险/可自动化）评估是否应转成代码级工具，维护「已代码化/建议转码」清单。
- 改/开发插件项目后必须产出①工作留痕（docs/DEVELOPMENT-<日期>-<主题>.md）②经验 skill，并提交推送；插件问题/坑随时整理进插件 skill（现象/根因/处理/防再犯）。

### 凭据与 token（credentials-locator / token-create-approval）
- 所有敏感凭据统一存放于 data/sensitive/ 与私有归档 ai-work-archive；需要凭据先查位置索引，禁止脑补、禁止在公开位置另存明文。
- 创建 token/API key 前必须列候选名 + 候选存放位置，用户确认后才创建；明文只进私有位置。

### 节约模式（token-saving-mode）
- 用户表达节约 token 意愿（"省点""节约"）时启用：直达答案不客套、结构优先、默认 ≤200 字或 10 行代码、禁冗余、复杂问题先结论后理由、高峰价格用户自己留意勿主动提醒。

## 相关

- dsh-session-conductor（使用手册，与本文档配套）
- task-completion-report（任务完成汇报，与本文档配套）
