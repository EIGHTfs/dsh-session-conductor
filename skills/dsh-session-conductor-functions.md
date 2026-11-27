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

#### ⚠️ 与官方标题插件二选一（同时开启会互相覆盖）

官方在 DSH 0.2.2-rc.4 内置实验性插件 `@deepseek-ai/dsh-session-title-all-prompts-llm`（商店名「随对话更新的标题」）。两者都在写同一份 `sessionTitle`，**同一个会话只能有一套在跑**，同时开启会互相覆盖标题。

| 维度 | 官方 all-prompts provider | 本插件 auto-rename |
|---|---|---|
| 角色 | `sessionTitle` 的 **provider**（注册进服务） | **consumer**（读写该服务） |
| 触发 | 每条合格用户消息（含子会话）各开一个新 revision | `turn/end` 后延迟，且有门槛 |
| 输入 | **全量历史**（第一条到现在） | **最近 12 条**用户消息（滑窗） |
| 超长 | 超 `maxInputBytes` **直接失败**、保留旧标题 | 天然不会超限 |
| 并发 | 新 revision abort 旧的，旧结果不提交 | 全局并发上限 2 |
| 节流 | **无** | 至少 3 条消息；距上次新增 ≥3 条；同会话 ≥5 分钟；回合结束 8 秒防抖 |
| 成本 | 每条消息 1 次，输入随历史累积增长 | 每约 3 条 1 次，输入恒定为 12 条窗口 |

选型判据：**在意 token 用本插件，在意标题质量用官方**——官方看全量历史，对「主要任务变化」的判断更准；本插件靠节流与滑窗把成本压成线性。

差异的成因：官方 provider 契约只要求 `id` / `automatic`（`first-prompt` 或 `all-prompts`）/ `generate()` 三个字段，调度、revision 取代、过期结果校验、`session/title` 写入都由 `sessionTitle` 服务代劳；本插件是自建调度，门槛与并发只能自己实现。

**改造成 provider 架构的成本**（暂不做）：约 2.5 人天、858 行降至约 550 行。收益是免费获得 revision 语义（防过期覆盖）与生态一致；代价是官方 cadence 没有「每 N 条」概念（节流只能藏进 `generate` 内部）、判断「主题没变」时只能回当前标题（会 append 一条同值事件）。当前官方插件已关闭、无冲突，故不改造。

#### 双模式切换（consumer / provider）

自动重命名有两套实现，由插件配置项 `renameMode` 二选一：

| 模式 | 实现 | 调度方 |
|---|---|---|
| `consumer`（默认） | 本插件自建 `turn/end` 调度，门槛与并发自己实现 | 本插件 |
| `provider` | 注册进官方 `sessionTitle.register()`，`automatic: all-prompts` | 宿主 |

切换方式：在插件的 profile 配置里加 `renameMode: "provider"`，重启后生效。未配置时按 `consumer` 走（旧行为不变）。

provider 模式的要点：

- **节流仍在 `generate()` 内部**：官方 cadence 每条真人消息都会调一次 `generate`，所以门槛（≥3 条消息、距上次 ≥3 条、间隔 ≥5 分钟、滑窗 12 条）必须自己拨住，否则退化成每条消息一次 LLM 调用。
- **「不需要改」= 原样返回 `currentTitle`**：官方要求返回非空标题，保留原标题会 append 一条同值事件（可接受的日志噪音）。
- **分析异常自己咽下**：`generate` 抛出的异常会落到官方调度里，因此内部 try/catch 兜底、保留原标题，不影响宿主链路。
- **注册失败自动降级 consumer**：最常见成因是官方已注册了别的 provider（服务只允许一个）。若此时不降级，自建调度会以为「已交给官方」而停手，自动重命名会**彻底静默失效**。
- **两模式互斥**：provider 生效时 `scheduleAnalysis()` 直接 return，不再建 consumer 定时器。

尚未做的部分：设置页目前没有模式下拉（切换需改配置文件），后续再补 UI。

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

## 七、模板注入（强制门禁）

- **单一槽位** `plan`（方案模板——修改代码前先出提案）。收尾格式不在这里：它由 `skills/task-completion-report.md` 经 systemPrompt section「task-completion-report」（order 1000）常驻注入，与模板槽位互不重复。三种来源：上传本地 md、在线 md 网址（下载转存正文）、DSH 目录内浏览选用。
- **默认模板**：未上传任何内容时，开启注入即用插件内置的 `skills/plan-template-compact.md`（精简版，保留全部约束与门禁锚点）；上传后以用户模板为准，清空则退回内置默认。
- **注入时机**：`agent/pre-step`，每个 agent 首次 step 注入一次，作为一条 user 消息（`source.form = "instructions"`）进上下文。不是每步都注入，也不写系统提示词。改动即时生效（`templateStateCache` 热更新），下一回合可见。
- API：GET /api/session-conductor/templates；POST {slot, name, content} / {slot, url} / {slot, enabled} / {slot, action:"remove"} / {slot, action:"pickPath", path} / **{slot:'plan', enforce}**。
- **强制门禁原理（无状态判定）**：`plan.enforce=true` 时，`tools/pre-execute` waterfall 在每次代码修改类工具调用前**现场从会话事件流推导**门状态，不存任何标志位（重启零恢复问题）：
  1. **真人消息判定看 `source.kind`**，不看文本前缀：`kind === "user"` 才是真人，`kind: "plugin:*"`（模板注入、上下文用量、记忆取回等）一律跳过。老日志没有 source 时退回前缀兜底，仍判断不出就**按真人处理**（宁可多要求一次确认，不静默放行）。
  2. 从末尾向前找**最近一条命中确认词的真人消息** → 这就是本次确认。严格式整条仅「确认/同意/OK」；宽松式含「确认/同意/按方案执行/执行吧/go ahead」。
  3. 从确认之后向后扫：出现**收尾汇报**（状态词 `✅ 任务完成`/`❌ 失败`/`⚠️ 未完成` **且**含 `═══` 分隔线，双标记才算）或**显式新任务词**（`新任务`/`另一个任务`/`重新提案` 等）⇒ 确认作废，必须重新提案。
  4. 从确认之前收集 AI 输出（最近 6 段），须含「标题锚点」（`修改方案提案` 或 `门禁表`）**且**含「确认段锚点」（`是否执行` / `请回复确认` / `确认或修改方案` / `等待…确认`）。
  5. 以上同时成立才放行，否则 `{kind:'deny'}`。
  - **确认有效期 = 一整条任务**：确认一次后，中途回答 AI 的追问、插件持续注入用量行，都不影响；直到收尾汇报或说「新任务」才作废。这样既不会一个任务反复要求确认，也不会让第二个任务继承上一个的确认。
  - 锚点**一律不锁章节号**（模板改版时章节号会漂移，锁死会导致「照模板写也过不了」的永久拒绝）。
  - 子 agent 会话（`delegationDepth > 0`）豁免：子 agent 无法与用户交互确认；主会话是强制点。
  - 门禁自身异常 fail-open（放行并留痕），不阻断工具链。
  - 拦的工具：edit / write / apply（全拦）+ bash 写操作启发式（`>`/`>>` 重定向、sed -i、rm、mv、cp、tee、mkdir、touch、chmod/chown、git commit/reset/checkout --、patch、truncate、dd）。只读工具（read/grep/glob）永不拦。
    - bash 判定**先剥掉引号内的内容再匹配**：`curl -d '{"a":">b"}'` 里那个 `>` 是 JSON 字符不是重定向，直接扫原文会把纯网络请求误判成写操作。
- ⚠️ **已知问题（强制门禁的「确认放行」未达预期，待重新设计）**：
  - **拦截侧正常工作**：隔离实例实测 5 次 `write` 调用全部被正确拒绝，AI 也按要求改出完整提案。
  - **放行侧未通过**：用户在隔离实例里先后回复「确认」4 次（含提问框点选、直接打字），`write` 仍被同一条 deny 拦住。
  - **矛盾点**：用**同一份会话事件流**离线复算 `planGateAllows` 是**放行**（单测 19 + 40 条、真实事件流复算均通过）；运行时却拦截。事件流里 `user/message` 的 `source.kind` 实测共有五种（`user` / `runtime-context` / `time-context` / `plugin:dsh-git-push` / `plugin:dsh-session-conductor`），新判据能正确只认 `user`。
  - **未定位的原因**：为定位加了拒绝时的诊断日志（`[plan-gate]`，打印 events 数量、尾部事件、最近 user-source），但实测拒绝发生时**该日志一条都没输出**，说明运行时可能并未走到该分支、或加载的仍是旧模块（磁盘上 local-plugins 与 node_modules 的 realpath 一致且都含新代码）。
  - **结论**：现有门禁把「任务边界」与「确认来源」设计得过于依赖事件流细节，真实环境里难以稳定命中。**建议重新设计**：改为显式状态（提案时写一个带提案指纹的标记，确认时消掉它），而不是每次从事件流反推。当前不建议开启 `plan.enforce`。
  - 子 agent 豁免：delegationDepth>0 的会话放行（子 agent 无法交互确认；主会话是强制执行点）。
  - 门禁故障 fail-open（catch 里 next() + 留痕日志），不阻断工具链。
  - **坑（2026-10-15 实测）**：
    - **现象**：模板把「是否执行」从第八节移到第十一节后，锚点（字面量 `八、是否执行`）与模板脱节；一旦 `plan.enforce=true`，**AI 照模板写方案也过不了锚点 ⇒ 所有 edit/write 被永久拒绝**，而 deny 文案只说「请先出提案」，不提示「锚点不匹配」。
    - **根因**：把**排版细节（章节号）**当成了语义锚点。章节号会随模板改版漂移，语义标题（「是否执行」）不会。
    - **解决**：锚点改为语义匹配——`PLAN_ENFORCE_PROPOSE_TITLES`（标题）+ `PLAN_ENFORCE_PROPOSE_CONFIRM_ANCHORS`（确认段），各任一命中即成立；同步修掉 deny 文案里的同一处写死。
    - **防再犯**：① 门禁/校验类锚点**一律不锁章节号、序号、行号**，只匹配语义文本；② 改模板章节号时，同步 grep 锚点常量与 deny 文案；③ 单测固定留一条「章节号变了仍认提案」的回归护栏（`test/unit/test-template-inject.mjs`）。
  - 开关即时生效（`templateStateCache` 热更新），无需重启；注入文本同步声明拦截口径，AI 与拦截器同一约定。

## 八、压缩模型选择

- 会话模型旁单独选压缩用模型（省 pro 成本）：`compactionModel: {provider, model}` 或 null=跟随会话模型。
- API：GET/POST /api/session-conductor/compaction-model（POST {provider,model} 或 {follow:true} 重置）。

## 九、成员模型切换（AI 工具 list_models / set_member_model）

- ⚠️ **创建成员请直接用官方 `subagent` 工具**：它已原生支持 `provider` / `model` / `reasoning_effort`（底层走 `subagents.startLocal*` 的 `agentOptions`）。本插件自研的 `create_teammate_with_model` **不再推荐**——它当初存在的唯一理由是给官方接口补齐模型参数，而该理由已消失；旧版 DSH（仍暴露 `agentTeams.spawnTeammate`）继续可用，新版调用会直接返回官方用法说明而不是报错。
- 用途：给 Team 里的队友/子代理**单独切模型**（只动该成员会话，不影响其他成员）。
- **用户聊天框指令 `/model-switch`**（用户视角入口）：宿主把斜杠指令收在 `ctx.commands` 服务里，
  注册形态照官方范例 `@deepseek-ai/dsh-command-goal` 抄 —— `ctx.commands.register({definitionId, name, description, input:{hint}, recordInput, handler})`；`definitionId` 必须用 `@deepseek-ai/dsh-commands/brand` 的 `CommandDefinitionId("…")` 包一层。handler 收 `invocation`：文本从 `invocation.rawInput`（命令后原文）取、发起会话从 `invocation.agent` 取，返回 `{kind:"success"|"error", text}` 由聊天框渲染。三条形态：**无参**列成员与各自模型（便宜来源：本插件 override + 名册记录值）、**一参**查该成员**实际**在用哪个模型（读 `request/header`）、**两参**切换并回显查证快照。实现 `lib/features/member-model/command.js`（经域出口导出、由 `apply.js` 注册）。⚠️ 两个宿主能力（`ctx.commands`、`.../brand`）一律**动态导入 + 守卫**：拿不到就跳过注册并如实留痕 —— 静态引用宿主包会在导入期炸掉整个插件（本项目在 defineTool / createUserMessage 上踩过同类坑）。
- `list_models`：列出可用模型（provider → models[]）。**切模型前先用它拿确切 model id，不要凭记忆猜模型名。**
- `set_member_model({target, provider, model})`：
  - `target` 传**成员名**、**sessionId** 或标题关键字。定位顺序：① `ctx.agentTeams.listMembers(caller)` 名册（覆盖 `spawn_teammate` 创建的队友——它们**不在** `ctx.agents.list()` 里）；② `ctx.agents.list()`（普通活跃 agent，sessionId 精确 / 标题子串）。名册里成员名与 sessionId 都支持精确匹配，成员名还支持唯一子串。
  - 切前**校验 provider/model 组合**（用 `modelCatalog`）——无效组合直接报错，避免切完回合失败；并**拒绝 provisioning / failed 状态**的成员（创建中切换会让 roster 持久化恢复校验失败，成员被标记 failed 并**长期占用 active child 名额**）。
  - **切模型机制（官方模式二：`agent/request` 瀑布流拦截）**：`set_member_model` 把 override 写进插件 domain（`memberModelOverrides`，内存镜像 `memberModelCache`）；插件在 `agent/request` 里按 sessionId **每轮强制改写** `LlmCallConfig` 的 provider/model——**每个请求都改，所以跨轮必然持久**。
  - **为什么不靠官方「投影 pending + 请求头链」**：写 `model/selection` 事件只让 pending 生效**一轮**，被 `request/header` 消费后新回合沿请求头链回落；而新回合的请求头本身是按 `agentDefaultModel`（部署默认）发出的 → 实测 `request/header` 序列 agnes → wb 交替回落（`session-controller/src/model-selection-projection.ts:39-56` 的消费语义 + `agent.ts:497` 的 `agentOptions()`）。
  - **同时仍写 `model/selection` 事件**：让官方 `agent/pre-step` 追加 `[model changed: …]` 通知（可观测痕迹）。
  - **成员状态**：未挂载（inactive）**也能切**——override 落 domain；若会话日志里还没有该选择，会把事件直接写进会话日志（`appendSelectionEventToLog`，解码 → 追加 → 校验 → 备份 → 原子写回）。正在执行回合时会**先等它暂停**（`whenIdle`，最长 60s）再切。
- **验收方式（重要）**：
  - ✅ **现在不用自己查了**：`set_member_model` 的返回值**直接带查证**——立刻给「最近一次实际请求的 provider/model + 最近一次切换意图 + 一行判定」，并**注册查证任务（不阻塞）**：该成员下次发起请求时由 `agent/request` 事件判定（插件本来就拦这个事件改模型），确认结果在下一次 step 注入给发起方。想要更细的自查，用返回值里附的复核命令 `node scripts/check-member-model.mjs <sessionId>`。
  - ✅ **请求级权威记录**：`request/header` 的 `data.header.config.{provider,model}` —— 注意是**两层**（`data.header.config`，不是 `data.config`）；**连续多轮都应是新模型**（这是「跨轮持久」的唯一可靠证据）。
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
- **三项之和通常小于已用量**（实测 390K vs 243K）：已用量取自 `projectedTokens`，底座是 **provider 报告的真实提示词规模**；三个分项是**逐条启发式累加**，不含 reasoning tokens、附件与部分注入内容。所以「分项加起来对不上总数」是口径差异，不是算错。
- **每轮注入（默认开）与按需自查并行**：除了 `context_usage` 工具，插件还会**每轮**把实时用量注入上下文 —— 走 `agent/pre-step`，把用量作为**一条 user 消息追加到该步消息批次尾部**（**不是**系统提示词前缀）。放尾部的原因：前缀保持稳定 ⇒ prompt cache 仍命中，而 AI 每轮都能直接看到数字。注入按 **turn** 门控（`agent/pre-step` 每步都触发，每步注入会在一回合里刷出多条重复行）；注入文本是**单行紧凑格式**（`formatContextUsageCompact`），拿不到投影时静默跳过、绝不影响回合。配置项 `injectContextUsage`（`lib/core/config.js` 的 DEFAULTS，默认 `true`）可关；关掉即退化为「按需调用工具」。**历史口径修正**：早期结论是「只做自查工具、不注入」，理由是「每轮注入会让系统提示词前缀每轮变化 ⇒ prompt cache 失效」——该代价只存在于「注入到前缀」这一种做法；改为注入到消息尾部即规避。
- **注入可见性**：注入走官方 logged 通道（`createUserMessage` + 返回 `{...decision, messages:[...]}`），因此**进模型输入、也落进会话日志** —— AI 确实看得见，不是只在内存里飘。
- **失败语义**：拿不到数据时如实说明原因（`exec.agent` 缺失 / `sessionProjections` 服务不可用 / 该路由还没上报 `contextWindow`），不抛异常、不返回空。

## 十一、跨会话消息与指定模型新建会话（AI 工具 list_sessions / send_to_session / create_session）

三个工具都在 `lib/features/session-messaging/`（`logic.js` 常量/纯函数/本体调用封装 + `tools.js` 工具注册 + `index.js` 域出口），由 `apply.js` 在 `inject('tools')` 回调里注册（注册整体包 try/catch，失败只留痕、不连累同批工具）。

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `list_sessions` | 列出本机会话（id / 标题 / 工作区 / 状态 / 最后活动 / 是否当前会话）；支持 `query` 子串过滤 + `limit`/`offset` 分页（**默认只给 20 条**，回执会给出下一页的 offset）。**冷缓存慢路径不阻塞**：全量构建本机实测 **226 秒**（201 份日志 / 1.5 GB），故「**先等 3 秒，超时转宿主后台 job 并复用同一份在途 Promise**（不重启构建）」⇒ 前台立刻拿 `jobId`，用宿主 `job_output` 取结果；热缓存 ~47 ms 仍直接返回。`fromIndex=true` 直读落盘索引秒回精简列表（id/标题/工作区，**不含 live 状态**）。宿主 job 契约（照 `dsh-git-push` 实测）：**owner 必须是有活 agent 的会话 id 字符串**（`exec.agent.id`）；带 owner 注册失败 ⇒ 退无主注册再试，两步都失败才同步降级并**把原因带回**（不静默） | `query` / `limit` / `offset` / `fromIndex` |
| `send_to_session` | 给另一个会话投递消息（不经过人转达） | `sessionId`、`text`、`mode`(queue/steer)、`requestId`、`hops`、`dryRun` |
| `create_session` | 新建会话并可指定模型，可选带初始消息 | `provider`+`model`、`cwd`/`workspaceId`、`sessionId`、`text`、`dryRun` |

**标准用法（按此顺序）**

1. `list_sessions()` → 拿目标会话 id（**不要凭标题或记忆猜 id**）
2. 建新会话：`list_models()` 查确切 provider/model → `create_session({provider, model, dryRun:true})` 预览 → 确认后去掉 dryRun 真建
3. 给已有会话发消息：`send_to_session({sessionId, text, dryRun:true})` 预览 → 确认后真投

- **`create_session` 缺省工作目录 = 调用方会话自己的 cwd**（发起它的那个 AI 在哪干活，新会话就落在哪）。**不要**依赖本体默认：那是 DSH 安装目录（实测 `<DSH 安装目录>`），新会话落在程序目录里对干活毫无意义。显式给 `cwd` 或 `workspaceId` 可覆盖（二者互斥）。
- **dryRun（两个写操作工具都支持）**：只做校验与预览、**不产生任何副作用**。`create_session` 的 dryRun 还会**核对 provider/model 是否真在模型目录里**；`send_to_session` 的 dryRun 会**报告目标状态与限流余量**，且**不消耗限流配额**（可以先 dryRun 多次再真投）。dryRun 同样执行全部本地校验（自投/超长/跳数等照常被拒）。
- **状态含义**（`list_sessions` 输出）：`running` = 正在跑回合；`idle` = 已挂载但空闲；`inactive` = 冷会话（未挂载，投递时会被唤醒）。缺 id 的脏条目会被跳过并如实标注（不会渲染成 `undefined`）。
- **会话列表的内存边界（实测，别再踩）**：宿主的 `handle.read(offset, length)` **不能流式读** —— offset/length 只是**内存数组切片**，后端每次调用都会把整份日志读进来解压（`session-persistence-jsonl/src/storage.ts` 的 `readCurrent`）。实测单份日志 49.2 MB 压缩 → **173.3 MB 解压**（3.2~5.0×）。
  - ⛔ **不要为了省内存改成分块 read**：内存峰值不变（每次都全量物化），耗时变 O(n²)（曾导致 `/list` >120s 超时，已撤回）。
  - ✅ **1.2.2 起的做法：绕开 handle，按 zstd 帧流式读日志文件** —— `lib/sessions/events.js` 的 `readColdSessionSummary()`：`findSessionLogById` 定位文件 → `streamDecodedFrames()`（`lib/zstd-frames.js`，逐帧解压、分片直接交给消费者不拼接）→ `StringDecoder` 增量切行 → 逐行 `JSON.parse`，只累加 `title`/`updatedAt`/`openTurn` 并保留有界尾部。**实测 heap 增量 24 MB、峰值 29 MB**（原路径数百 MB），且与「全量解码 + `lastEventTime`/`hasOpenTurn`/`interruptionInfo`」逐项对拍一致。
  - 另靠列表磁盘缓存的 `revision` 命中跳过重复解析（1.2.0 修掉了「`list()` 返回快照却被当裸 header 用、`revision` 恒 null ⇒ 缓存永不生效」）。
- **投递语义**：默认 `mode:"queue"` —— 目标空闲时**由本体自动唤醒**它跑一个回合；目标运行中则排到其下一回合边界。`mode:"steer"` 改为注入目标**正在跑**的那个回合。
- **实现口径（重要）**：全部走本体官方 `sessionController` 的 `@Remote` 方法 —— `create` / `selectModel` / `prompt`。**不自己写会话日志**：inbox 家族只有 `agent/inbox/spliced` 落盘，其 fold 对非法 splice（id 重复、start 越界）**直接抛错**，自己写等于拿对方会话的完整性冒险。`prompt` 的受理流程会先 resume 目标会话，唤醒语义由本体保证；`requestId` 是幂等键（本体持久化在那条被接受的消息上），重试传同键不会重复投递。
- **`create_session` 为什么是两步**：本体 `SessionCreateRequest` 只有 `workspaceId? / cwd? / sessionId? / agentPreset?`，**没有 model 字段**，所以必须 `create` → `selectModel`。任一步失败都如实回执（如「⚠️ 会话已建，但模型未设置」），**不谎报成功**。
- **安全硬约束**（防唤醒风暴，缺一不可）：① 禁自投；② 协作链 `hops ≥ 3` 拒绝并提示改用共享文件；③ 同一对会话 60s 内最多 5 条；④ `requestId` 幂等 + 在途去重；⑤ 只投递、**不读对方会话内容**。
- **何时不该用它**：需要交接上下文 / 长内容 / 可追溯 —— 落共享文件（如工作区下的交接 md）+ git 提交信息，消息里只放路径与要点；需要人做决策或跨机器 —— 人转达。
- **部署提醒**：本插件在 profile 里是**双副本**（`node_modules/<插件>` 是宿主加载源、`local-plugins/<插件>` 是 hmr 观察点）。同步**新增文件/目录**时必须**两个 target 都打**，否则宿主加载源缺文件 → 插件整个加载失败。

## 十二、通用行为约定（浓缩自原全局 skill，约束所有 AI 所有会话）

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

## 十三、记忆取回（memory-recall，1.3.0 起）

**解决什么**：上下文被压缩、截断，或实例重启后快照未加载时，AI 会「失忆」——重复提问、重复劳动、
误解需求。而用户消息在上下文里占比极小（1M 上下文可能总共没超过 3 句），却最不该丢。

**两条通道**：

| 通道 | 触发 | 参数 |
|---|---|---|
| **自动注入** | 每回合比较上下文已用量：本次比上次下降 ≥ `retrieveMemoryMinDropRatio`（默认 0.10）⇒ 判定「疑似丢失」，取回后与用量行**合并成一条**注入（消息尾部） | 无（走配置） |
| **AI 工具 `recall_memory`** | AI 自己想回溯时主动调用 | `rounds` = 取几轮（默认取配置，上限 50） |

**取什么**：最近 N 轮（默认 3）的**用户消息文本** + 该轮 **AI 的第一条回应**（优先 reasoning，缺失取正文）。

- 以用户消息为锚：占比小但信息密度最高，是恢复上下文的支点；
- 要 AI 的第一条回应：那是「当时」对消息的理解，直接给结论，省得重新推测。

**实现要点（改这里前先读）**：

- 读取走 `readRecentUserTurns`（`lib/sessions/events.js`）：按 zstd 帧**流式**读日志文件，
  常量内存（实测 3 轮 27 ms / heap 6.1 MB）；
- 锚点只认 `user/message` 且 `data.source.kind === "user"` —— **必须排除插件自身注入**
  （`plugin:dsh-session-conductor`）与 `runtime-context`，否则注入块会被下一轮取回形成反馈环；
- `agent/inbox/spliced` 是同一句话的投递副本，**忽略**（否则一轮会数成两条）；
- 同回合内（其间无 `turn/end`）连续多条用户消息**合并成一轮**；
- 无论是否触发都记账（`noteUsage`），否则读取失败会每回合反复触发；
- 任何一步失败（日志缺失/损坏、用量读不到、首回合无上次用量）都静默返回 null，绝不阻断回合。

**配置**：`retrieveMemory`（默认开）/ `retrieveMemoryRounds`(3) / `retrieveMemoryMinDropRatio`(0.10) /
`retrieveMemoryMinDropTokens`(0) / `retrieveMemoryMaxChars`(4000) / `retrieveMemoryMaxCharsPerItem`(800)。

## 十四、未读状态（改用宿主 session-status）

会话面板的未读标记**不再自己算**，改为读宿主 `uiSession.sessionStatus`：

| 状态 | 来源字段 |
|---|---|
| 未读 | `completionUnread`（宿主判据：`completedTurn > readTurn` 且非当前查看的会话） |
| 运行中 | `running` |
| 待交互 | `pendingInteraction` |
| 上次完成失败 | `completionFailed` |

取法：`ctx.get("uiSession")?.sessionStatus`（本插件未在 `inject` 声明 `uiSession`，写 `ctx.uiSession` 会一直是 undefined）。订阅用它的 `getSnapshot()` + `subscribe()`；标记已读用 `sessionStatus.reading.mark(sessionId, false)`。

「全部已读」宿主没有批量接口，前端遍历当前列表逐个 `mark`。

**为什么废弃自研的时间戳方案**（原 `updatedAt > readAt`）：

1. 会话流式输出时 `updatedAt` 持续变化 → 刚标已读又变未读，即使正盯着那个会话
2. 后台任务写日志、插件注入、索引重建都会推高 `updatedAt`，但这些不是「有新回复待看」
3. 分不出「跑完没看」与「跑挂没看」

宿主用回合作为语义单位，且显式排除正在查看的会话，这才是「有没有新东西给你看」的正确判据。

**宿主没装或关闭该插件时不显示未读点，不报错** —— 不保留第二套算法。相关自研代码（`features/unread.js` / `features/unread-routes.js`）及索引里的 `unread` 存储字段已移除。

## 十五、前端改动注意事项（踩过的坑）

**给组件新增 prop 时，必须同步改组件的解构签名。**

面板组件是这种写法：

```js
function SessionManagerPanel({ wide, t, onOpenSession, sessionStatus: hostSessionStatus = null }) {
```

如果只往 `inject` 的返回值里加 `sessionStatus`，却忘了在解构里加上，组件内部就**没有 `props` 这个标识符**。此时写 `props?.sessionStatus` 不会得到 `undefined`，而是抛 `ReferenceError: props is not defined`：可选链只处理「已声明但为 null/undefined」的情况，救不了未声明的标识符。

后果不是「未读点不显示」，而是**整个组件渲染失败、侧边栏入口一起消失**。

**改前端必须实际渲染验证。** 构建成功 + `node --check` 通过，都只能证明语法没问题，证明不了组件能渲染。判断依据只有一条：打开页面，确认入口在、面板能打开、按钮齐全、无 JS 报错。

## 相关

- dsh-session-conductor（使用手册，与本文档配套）
- task-completion-report（任务完成汇报，与本文档配套）
