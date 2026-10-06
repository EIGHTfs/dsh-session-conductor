---
name: dsh-session-official-doc
description: DSH 官方「会话系统」原理文档整理（来源 https://deepseekdocs.com/docs/learn/core/session，审计基线 0.1.5-alpha.1 @ 5dda764ed3，包名/ctx key/事件名/配置键/磁盘布局与官方源码逐点核对）：事件溯源（日志唯一真源）、surface 派生层、SessionStore(ctx.sessions)/Session 类、request/header 重建、事件信封字段、崩溃恢复与 turn 结束原因、JSONL 持久化与磁盘布局、格式迁移 v0→v3、checkpoint-policy、projection-cache、标题三件套、遥测、损坏与格式策略、验证命令。面向 AI：理解会话怎么被记录/恢复/展示、排查会话打不开/崩溃恢复/磁盘格式问题、开发会话相关插件时加载。⚠️ 官方基线为 -alpha.1；本机 -alpha.4 无 v3 世代后缀，差异见文末。
whenToUse: 需要理解 DSH 会话系统底层原理（事件溯源/日志格式/surface/持久化/崩溃恢复/迁移）时；排查会话日志打不开、格式版本不识别、崩溃后会话异常时；写会话相关插件或改会话代码时。
---

# DSH 官方文档整理：会话系统

> 来源：https://deepseekdocs.com/docs/learn/core/session（DeepSeek Harness 官方原理课程「核心机制-会话系统」）。
> 一句话版：会话是**事件溯源**的：`Session` 是 append-only 的对话历史**唯一真源**，模型的 LLM 消息历史是从它**派生**的；持久化、投影、遥测都围绕同一串 `SessionEvent` 构建。不存在并行的"持久消息"类型。

## 一、事件溯源：日志是唯一真源

一个 `Session` 存的是一个**不可变事件流**，不是"消息列表"。

```
SessionEvent(append-only 事件流)
  ├── session-persistence   存储 / 重载 / 列出(JSONL 后端)
  ├── session-format-*      历史格式迁移(v0→v1→v2→v3)
  ├── session-projection    派生视图(缓存)
  ├── session-telemetry     遥测导出(OTel)
  └── session-title         标题生成
模型看到的"LLM 消息历史" = 从这个事件流**派生**的(surface 层)
```

边界：你想给会话"加什么信息"，要么是**新事件类型**(append)，要么是**派生视图**(surface/projection)，而不是另开一个消息表。

## 二、surface：消息的派生层

原始日志里不只有"消息"，还有边界、attempt、usage、错误等生命周期事件。模型需要的是一段**有序消息投影** = **surface**（在原始日志之上的有序投影层）。

- **surface 只投影"产消息"的事件**：`system/message`、`user/message`、`assistant/message`、`tool/result` 四种（`SurfaceEventType`）
- `assistant/attempt`、生命周期边界、错误等被排除在 surface 之外（保留在日志里）
- `surfaceOp` 只允许出现在上面四种事件上：`'append'`，或 `{ op:'replace', startSeq, endSeq }`（闭区间、两端都必须是当前 surface 节点，且 `sourceEventSeqs` 必须覆盖全部被遮蔽节点）

两个读取口径（别混）：

|  | 谁读 | 用哪个 |
|---|---|---|
| 模型(请求上下文) | deriveMessages() | **surface**(看到替换后的面) |
| 人类转录(debug/回放) | append-origin 事件 | **原始事件**(landed 替换已遮蔽旧历史) |

经验：想让"模型看到摘要版"就落 surface 替换；想看"到底发生过什么"就看日志原事件。

## 三、SessionStore：`ctx.sessions`

`ctx.sessions` 创建并持有事件溯源的 `Session` 实例。**持久化不是它实现的**：插件订阅 `session/event`、在 `session/flush` 时 flush，并可镜像 `session/created`/`session/disposed` 生命周期。

| API | 约定 |
|---|---|
| `create(id?, { seed?, meta? }?)` | 校验并 detach 持久 seed/header，填 version/id，`createdAt` 默认 now，发布并绑定到调用 fiber |
| `flush(session)` | 发布 awaited 并行持久化检查点；没发布/已 detach/stale 的对象拒绝 |
| `fork(source, boundary?, childSessionId?)` | 解析会话，选 seed（默认当前最后事件 seq），要求前缀**结束在 turn 外**，创建带血缘元数据的 live 子会话 |
| `get(id)` | 取或 `undefined` |
| `list()` | 列出 |

### split 生命周期（仅当 teardown 需与其他资源排序时）

多数情况用 `create()` 够；teardown 必须跟其它资源**排序**时用三段式：

```
prepare(id?, opts?)   // 校验并构造,不发布
enter(session)        // 碰撞检查 + 发布(不 announce),返回 entry-bound 幂等
                      // 并发同 id 可同时 prepare,但只有一个 enter 成功;陈旧 detach 无法删替换者
announce(session)     // emit 唯一创建边;重复/重入 announce 拒绝
```

`dsh-agent-loop` 就用这个 split，让**最后一次 loop flush** 在 session detach **之前**。

## 四、Session 类

`Session` 是**普通类，不是 Cordis Service**。live 会话经 `ctx.sessions.create()`，`detached` 回放/检查会话用 `Session.create()`（后者不发生命周期事件、不绑 fiber）。

| 方法 | 约定 |
|---|---|
| `session.append(type, data, opts?)` | 快照并冻结持久数据与 surface 元数据，校验 marker 形状、引用的 source-event seq、complete 替换覆盖、单结果 `tool/result` 改写；同步提交后通知 observer。**reentrant 附加会话 append 拒绝** |
| `session.deriveMessages()` | 增量投影每个新 surface 条目，返回冻结消息数组 |
| `session.snapshotEvents(fromSeq?, toSeqExclusive?)` | 物化半开区间的冻结快照；整段当前快照会被缓存到下次 append |
| `session.eventAt(seq)` | 按 seq 读取单个已接受、深冻结的事件 |
| `session.seq` / `session.id` | 当前日志长度(下一条事件的 seq) / 只读标识 |
| `session.header` | detach、深冻结的创建元数据 |
| `session.surface` | 只读 surface 视图 |
| `session.inheritedEventCount` / `ownEvents()` / `isOwnSeq(seq)` | fork 继承前缀长度 / 子会话自有事件 / 是否自有位置 |
| `session.firstLiveSeq` | 本进程首次 append 的 seq(构造 seed 长度) |

### 头信息与事件分离

|  | 内容 | 是否可回放 |
|---|---|---|
| `SessionHeader` | 版本、id、createdAt、可选 cwd/parentSession、`isSeeded`、可选 origin/delegationDepth/agentPreset | 创建元数据，写入时 detach + 深冻结，运行时不可变；精确的继承前缀长度是 Session 状态(`inheritedEventCount`)，不是 header 字段 |
| `SessionEvent` | 可回放的对话状态 | 可回放 |

## 五、请求头重建（request/header）

`request/header` 记录一次请求的**完整规范快照**（非历史请求信封），`reason` 四值：`initial` / `resume` / `change` / `series`（`series` = 信封未变但显式开启新的消息序列，或紧跟在 surface 替换之后）。

- 可选 `adapterDefaults` map：标记 effective `reasoningEffort`/`maxTokens` 是**精确模型解析物化**的值，让下一次请求提案能区分它们与显式会话设置
- `foldRequestHeader()` 选最近快照；legacy delta 事件与已移除的 `fallback` reason 由迁移包 `session-format-v0-to-v1` 在读取时拒绝
- `user/message` 存完整 `UserMessage`（在 inbox 路由 / step 进入前就已创建身份）；`content` 原样渲染，`source` 是区分"人工 prompt / 合成注入 / 进入的 goal round"的唯一通道

## 六、事件信封字段（按事件类型可选）

| 字段 | 含义 |
|---|---|
| `seq` | 单调递增的持久化排序键 |
| `time` | Unix epoch 毫秒 |
| `sourceEventSeqs?: SessionSeq[]` | 引用的源事件 seq（如压缩替换背后的被遮蔽条目）。**只存在于 surface 事件上**；`assistant/message` 禁止该字段 |
| `surfaceOp?: SurfaceOp` | 事件如何进入 surface；非 surface 事件(边界/attempt/错误)不带 |
| `ignorable?: true` | 读到不认识的类型可以安全跳过；**缺失 = 必选**，未知类型会拒绝会话重建 |

### 事件词汇与扩展

- 完整目录见 `known-event-types.ts` 与生成的 persistence catalog
- `SessionEventMap` 可声明合并：插件用 `declare module` 加自己的类型（`compaction/*`、hook 桥的 `hook/*` 等），合并成员进同一 catalog
- 插件要自己的持久事实：`session.append` 后 `await ctx.sessions.flush(session)`，不要伪造执行 turn

## 七、崩溃恢复与 turn 结束原因

`turn/start` 只带轮次号；之后进入的 `user/message` 批次记输入，`llm/retry` 记请求恢复。`turn/end` 的 `TurnEndReasonMap` 是 `kind`-标签联合：

| kind | 时机 |
|---|---|
| `completed` | 正常完成 |
| `aborted` | 活 turn 被打断，`reason: AgentCancelCause`。旧格式导入成 `{ kind:'aborted', reason:{ kind:'legacy' } }` |
| `blocked` | 被策略/守卫阻断 |
| `error` | turn 失败，`{ kind:'error', error }` |
| `max-tokens` | 至少一个 step 撞到输出 token 上限 |
| `interrupted` | **仅崩溃恢复**合成(找不到别的证据) |

**崩溃恢复**：冷 load 用 `interruptedTurnClosers()` 合成收尾事件——未配对的 tool call 先补 `tool/result` 错误（`TOOL_NOT_STARTED`/`TOOL_OUTCOME_UNKNOWN`），再补 `step/end`，最后补 `turn/end { kind:'interrupted' }`；所以恢复出的会话不会有"悬空 turn"。

## 八、事件溯源的校验：snapshot 与不可变

- `isJsonValue(value)`：布尔谓词
- `snapshotJsonValue(value)`：一趟迭代校验并复制；拒绝环、不支持标量、exotic prototype、非有限数与 `-0`；不设调用栈深度上限(迭代实现)
- `snapshotSessionEvent(event)` / `adoptSessionEvent(event)`：克隆 borrowed / 原地持有独占所有权的修改(request-header)

## 九、持久化后端：JSONL

`session-persistence-jsonl` 是唯一官方 `SessionPersistence` provider：

| 配置 | 默认 | 作用 |
|---|---|---|
| `root` | 无(**必填无默认**) | 会话日志根目录，通常 `$DSH_HOME/sessions` |
| `compression` | `zstd` | `zstd`(校验帧压缩)或 `none`(纯文本 JSONL) |

### 磁盘布局（官方  逻辑格式 V3 → 文件名带 `v3`）

```
~/.dsh/sessions/--<归一化cwd>--/<encoded-id>/session.v3.jsonl.zstd   # 当前世代
~/.dsh/sessions/_no-cwd/<encoded-id>/session.v3.jsonl.zstd           # 无 cwd 的会话
```

- 每个会话目录保留不可变的历史世代：`session.jsonl[.zstd]` = released v0，`session.v1.jsonl[.zstd]` = v1，`session.v2.jsonl[.zstd]` = v2，当前 `session.v3.jsonl[.zstd]`；运行时选数字最高的世代
- 默认 zstd 压缩；要直接 `head`/`jq` 就配 `compression: 'none'` 或先 `zstdcat`
- 两级目录：`--<cwd>--`(工作区,缺失时 `_no-cwd`) + `<encoded-id>`(会话 id 注入式转义成单个安全路径段)
- 每个会话同时只能有一个写者：in-process 认领 + `session.lock` 上的非阻塞 `flock(2)`(Windows 命名内核信号量)；首个 append 用 `link()` 无覆盖发布

## 十、持久化格式与迁移

逻辑格式版本（当前 `SESSION_FORMAT_VERSION = 3`）+ 按版本命名的物理世代。历史日志由纯库迁移到当前格式：

| 包 | 角色 |
|---|---|
| `session-format` | 相邻格式规划、无损 JSON 校验、header-only 迁移与物理编解码调度 |
| `session-format-v0-to-v1` | 冻结的 released-v0 解码器 + 到 v1 的恒等迁移(拒绝 legacy delta 事件与已移除的 `fallback` reason) |
| `session-format-v1-to-v2` | 把顶层 `assistant/chunk` 嵌进 `assistant/message`，为失败/重试/取消的尝试补 `assistant/attempt` |
| `session-format-v2-to-v3` | 把系统提示提升为 `system/message`、重映射本地事件引用、翻译 PTC 与 preset 名、规范化事件信封 |
| `session-format-catalog` | 模块初始化时校验 v0→v3 无缺口链，暴露物理分发与当前编码器 |

迁移触发点：`open(id,'read')` 只在内存里解码迁移、不发布后继文件；`open(id,'write')` 校验后把当前世代发布到同目录，源文件逐字节不变。无法忠实解释的日志以 `SessionFormatUnsupportedError` 拒绝且源文件不动。

## 十一、持久化时机：checkpoint-policy

`session-checkpoint-policy` 零配置语义持久化策略，消费 `ctx.sessions`/`ctx.llm`/`ctx.tools`，在 `ctx.sessionPersistence` 存在时生效。三个边界做 checkpoint：

| 边界 | 保证 |
|---|---|
| model adapter 收到请求之前 | 该请求对应的 buffered 事件已 durable |
| 顶层 tool body 可能产生外部副作用之前 | 记录的调用已 durable 才进 body |
| 每个 `agent/pre-step` | 前一个 response 与有序 tool 结果在下一个请求前 durable |

checkpoint 拒绝是 **fail-closed**：model 与 tool 边界拒绝则不跑 adapter / tool body；step 边界拒绝让 turn 失败。

## 十二、投影持久化缓存：projection-cache

`session-projection-cache` 提供 `ctx.sessionProjectionCache`：每会话一条 durable checkpoint，落在 `session_projcache` domain（`per-record` 布局，`<root>/session_projcache/sessions/<id>.json`）。

- 存储行 `(key → {ver, seq, val})` 是 **fold 捷径，不是权威**：可能 stale(`seq` 精确说明 stale 到哪)，但绝不错
- 后台写 **fail-soft**：失败记 warning、保持 stale，下次写或冷读自愈
- `ver` 与 live 单元 `stateVersion` 不匹配 → 读时丢弃、不迁移，key 从日志重新 fold
- **log 在前、cache 跟随**：live checkpoint 先 durable flush buffered events 再落 cache row

写策略：会话创建(seed 派生的 cut) 强制 / `turn/end` 强制 / 会话 disposal(detach) 强制 / `writeEveryEvents` 个事件节流 / 首个 dirty event 起 `writeIntervalMs` 间隔节流。Web 组合默认 `writeEveryEvents: 200`、`writeIntervalMs: 5000`。

## 十三、会话标题：三件套

`ctx.sessionTitle` seam + 模型支撑标题 provider（库 `session-title-llm` 共享实现策略）：

| 包 | 形态 | cadence | 挂载 |
|---|---|---|---|
| `session-title-llm` | 库(非 cordis 插件) | 共享实现策略，provider 调 `registerSessionTitleLlmProvider()` 注册 | — |
| `session-title-first-prompt-llm` | 插件 | `first-prompt`:总结第一条合格用户 prompt，仅 fresh 非 fork 会话首次创建 fallback 时自动跑一次 | 默认挂载 |
| `session-title-all-prompts-llm` | 插件 | `all-prompts`:每个新 human prompt 后起新 revision | opt-in |

共享配置：`targetWords`/`targetCjkCharacters`/`maxInputBytes`/`maxOutputTokens`/`timeoutMs` 全必填无默认；`provider`/`model` 可选显式 route（**两者都填或都不填**）。标题请求与主对话完全分离：主 agent 请求**零额外 token**；标题 purpose 映射为 thinking-disabled。

## 十四、遥测：session-telemetry-otel

`mode` 只有两值，`FULL` 被**拒绝**：`FEEDBACK_ONLY`(默认) / `DISABLED`。按原样组合 OTel JS SDK，Resource identity 含 `service.name`/`service.version` + 匿名 `user.id`(`$DSH_HOME/.anonymous-user-id`)。上传授权 fail-closed；`ctx.sessionTelemetry.emit()` 在**任何** mode 下都是 no-op。上传模式下 record 携带完整 `event.data`（用户/助手消息全文、工具参数与结果、system prompt、tool schema 等），seam 无 redaction 规则。出厂缺省 endpoint `https://harness-telemetry.deepseeksvc.com/v1/logs`，可用 `DSH_TELEMETRY_OTLP_URL` 覆盖、`DSH_TELEMETRY_MODE` 改 mode、`DSH_TELEMETRY_DISABLED` 关闭。

## 十五、损坏与格式策略

| 场景 | 策略 |
|---|---|
| 撕裂尾部碎片 | 丢弃 |
| 已提交损坏 / 格式错误 | `SessionPersistenceCorruptionError` 拒绝 |
| 已发布历史格式(v0/v1/v2) | 由格式目录迁移到当前 v3 |
| 比当前更新的格式版本 | `SessionFormatUnsupportedError` 拒绝，提示升级 harness |
| 未知事件类型(非 ignorable) | `SessionFormatUnsupportedError` 拒绝 |
| 未知事件类型(ignorable) | 跳过 |

## 十六、验证命令（官方）

```
# 看 session 相关插件装载
dsh web --dump-config | grep -iE "persistence|checkpoint|projection-cache|session-title|telemetry-otel"
# 会话日志是压缩 JSONL(zstd)，先解压再读，一行一事件
zstdcat ~/.dsh/sessions/*/*/session*.jsonl.zstd | head -3
# 类型分布
zstdcat ~/.dsh/sessions/*/*/session*.jsonl.zstd | jq -r .type | sort | uniq -c
# 看请求头重建来源
zstdcat ~/.dsh/sessions/*/*/session*.jsonl.zstd | grep "request/header" | head -1
# 看 turn 结束原因
zstdcat ~/.dsh/sessions/*/*/session*.jsonl.zstd | grep "turn/end" | tail
```

## ⚠️ 本机版本差异（-alpha.4）

官方基线为 **-alpha.1**，本机安装 **-alpha.4**，以下以本机实际为准：

1. **磁盘布局无世代后缀**：本机会话目录文件是 `session.jsonl.zstd`（官方 V3 为 `session.v3.jsonl.zstd`）；`projectKey(cwd)` 生成 `--<slug>--` 目录（`工作区` → `~5DE5~4F5C~533A` 转义），会话 id 经 `encodeSegment` 转义为 `~<4-hex>` 形式
2. **无 v0→v3 世代迁移**：本机无 `session.v1/v2/v3` 世代文件与对应迁移包；格式仍是 released v0（`SESSION_FORMAT_VERSION = 0`）
3. **`list()` 的 encodingMismatch 门禁**：本机 `session-persistence-jsonl` 的 `listArtifacts()` 对每个会话目录检查 opposite 压缩文件（默认 zstd 时查 `session.jsonl`），存在即 `throw encodingMismatch` → **整个列表失败 → 侧边栏无任何会话**。排查"侧边栏会话全消失"先查是否有会话目录同时含 `session.jsonl` + `session.jsonl.zstd`（双格式），把多余的明文文件移出或删除即可恢复
4. 其余事件模型/surface/checkpoint/投影缓存/标题/遥测机制与官方文档一致
