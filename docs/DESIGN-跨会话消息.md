# 设计文档：跨会话直接发消息（send_to_session）

> 目的：让一个 DSH 会话能把消息**直接投递给另一个指定会话**（不经过人转达），用于 AI 之间的交接、
> 唤醒空闲会话、并行协作。本文给出可落地的设计、必须核实的事实、验收口径与坑。

## 一、目标与边界

**要做的能力**

```
list_sessions()                              列出可投递的会话（id/标题/工作区/状态/最后活动）
send_to_session(sessionId, text, opts?)      把一条消息投递到目标会话的收件箱；目标空闲时可唤醒它跑一个回合
```

**不做的事（本期边界）**

- 不做广播/群发（避免互相唤醒风暴）
- 不做附件/文件传输（消息只承载文本；文件走共享路径）
- 不做跨机器投递（本机 DSH_HOME 内的会话）

## 二、本体已有的机制（这是设计的地基，不要另造轮子）

会话收件箱在 DSH 里是**一等公民**，日志里能看到四类真实事件：

```
agent/inbox/inserted     消息被放入收件箱
agent/inbox/claimed      被该会话的回合取走
agent/inbox/spliced      被拼接进上下文
agent/inbox/discarded    被丢弃
```

**投递 = 往目标会话的日志追加一条 inbox 事件**，随后由目标会话的回合消费。
事件字段的确切定义在 DSH 源码树内：

```
packages/test-support/loader-smoke/src/agent-turn.ts     ← inbox 事件的类型定义（先读它，别猜字段名）
packages/test-support/loader-smoke/lib/types/agent-turn.js
packages/test-support/session-snapshot/lib/types/harness.js
```

会话发现相关的既有概念：`workspaceRegistry`、会话存储 `sessions`（都在本体源码树内可搜到）。

## 三、必须先核实的三件事（动手前用半天做完，避免返工）

1. **inbox 事件的精确 schema**：读 `packages/test-support/loader-smoke/src/agent-turn.ts`，
   确认 `agent/inbox/inserted` 的必填字段（消息 id、来源会话、时间戳、内容结构、是否带 turn 关联）。
2. **有没有官方 append API**：本体是否提供「向某会话追加事件」的公开接口（优先用它）；
   若没有，只能直接写会话日志文件 —— 那就必须遵守该日志的**帧格式与编码**（见第五节的风险）。
3. **唤醒语义**：目标会话处于 inactive 时，追加 inbox 事件**能否触发它起一个回合**；
   若不能，需要额外调用本体的会话运行入口（哪个接口/方法，要在源码里确认）。

## 四、接口设计

```
list_sessions() -> [{
  id, title, workspace, status: "idle"|"running"|"inactive",
  lastActivityAt, isSelf
}]

send_to_session({
  sessionId: string,          // 必填，来自 list_sessions
  text: string,               // 必填，纯文本，长度上限建议 8KB
  wake?: boolean,             // 默认 true：目标空闲时唤醒它跑一个回合
  replyTo?: string            // 可选：本会话 id，便于对方回投（形成协作链）
}) -> { ok: true, messageId, delivered: "inbox"|"woke", targetStatus }
```

**行为约定**

| 目标状态 | 行为 |
|---|---|
| idle / inactive | 追加 inbox 事件；`wake=true` 时触发其起一个回合；返回 `delivered:"woke"` |
| running | 只追加 inbox 事件（回合边界自然消费）；返回 `delivered:"inbox"` |
| 不存在 / 已归档 | 返回 `{ ok:false, error:"session-not-found" }`，不写任何日志 |

## 五、安全、限流与防风暴（必须做，否则很容易把系统搞坏）

1. **只允许本机同用户的会话**（会话 id 必须在当前 DSH_HOME 的注册表内；不接受任意路径）
2. **禁止自投**（`sessionId === 当前会话` ⇒ 拒绝），避免自我唤醒死循环
3. **跳数限制**：消息头携带 `hops`，AI 之间互相投递时 `hops+1`；`hops >= 3` 直接拒绝并提示「请用共享文件交接」
4. **限流**：同一对会话 60s 内最多 N 条（建议 N=5），超出返回 `rate-limited`
5. **审计留痕**：每次投递在发起方日志里留一条可查记录（谁发给谁、messageId、是否唤醒），便于事后追责
6. **不越权**：工具只做「投递」，不读取对方会话内容；不给 AI 提供「读别人会话」的能力
7. **日志安全**：写目标会话日志前必须先确认帧格式（见第六节），写坏日志 = 毁掉对方会话

## 六、必须避开的坑（都是本项目/相邻项目已经踩过的）

1. **`defineTool` 必须显式导入**：本项目历史上出现过「文件里直接用 `defineTool` 却从未导入」⇒
   `inject('tools')` 回调抛 `ReferenceError` ⇒ **四个工具全部注册不上**。新增工具照抄 `lib/apply.js` 的动态加载写法，
   并在 `test/api/helpers/fake-services.mjs` 同款假环境里跑一遍注册。
2. **会话日志是多帧编码（含 v0/v3 两种历史格式）**：直接写日志的路径必须复用 `lib/session-codec.js`，
   不要自己拼帧；截断/改写类操作的既有教训见相邻 skill（`session-jsonl-truncate-at-user-message`）：
   先停写、按帧切、校验整份可解码后再替换。
3. **并发写**：目标会话可能正在写自己的日志 ⇒ 投递必须走「追加 + 原子替换」或本体的写入锁；
   不要读改写整份文件（会丢对方的写入）。
4. **唤醒风暴**：两个会话互相 `send_to_session` 且都 `wake=true` ⇒ 无限回合。
   第五节的跳数 + 限流 + 禁止自投是硬要求，不是可选项。

## 七、实现落点（按本项目既有结构）

```
lib/features/session-messaging/index.js    新建 feature 模块，导出：
                                            registerSessionMessagingTools(ctx, defineTool, tools)
  · list_sessions 的实现：读注册表 + 会话存储，产出第三节约定的字段
  · send_to_session 的实现：校验 → 构造 inbox 事件 → 投递 → 审计
lib/apply.js                               在既有 inject('tools') 回调里注册新模块（照现有四个工具的写法）
skills/                                    补一段「跨会话发消息」的用法说明（何时该用、何时改用共享文件）
docs/VERSIONS.md                           记录本次功能
README.md                                  功能表补一行 + 用法示例（含 list_sessions 输出样例）
test/                                      两条用例：正常投递（假环境断言事件内容）、
                                           拒绝路径（自投/跳数/限流/不存在）
```

## 八、验收口径（做完必须自证）

```
1. 两个测试会话 A/B：A 调 send_to_session(B, "hello") ⇒ B 的日志里出现 agent/inbox/inserted，B 的回合读到它
2. B 处于 running 时投递 ⇒ 不打断当前回合，B 在下一回合边界消费
3. 拒绝路径逐条命中：自投 / 目标不存在 / hops 超限 / 60s 内超量 ⇒ 均返回明确错误且**不写任何日志**
4. 写完后目标会话日志**整份可解码**（用 lib/session-codec.js 自检），且 DSH 能正常加载该会话
5. 审计：发起方日志里有对应记录，可查出 messageId 与目标会话
```

## 九、与「共享文件 + git + 人转达」的关系

跨会话协作有三种载体，本能力只补第一种，选择顺序建议：

```
① 需要对方立刻行动、且是短消息           → send_to_session
② 需要交接上下文/长内容/可追溯           → 共享文件（如工作区下的交接 md）+ git 提交信息
③ 需要人做决策或跨机器                    → 人转达
```

不要让 `send_to_session` 承担 ② 的职责（长内容应落文件，消息里只放路径与要点）。
