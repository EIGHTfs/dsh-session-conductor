# 设计文档：跨会话直接发消息（send_to_session）

> 目的：让一个 DSH 会话能把消息**直接投递给另一个指定会话**（不经过人转达），用于 AI 之间的交接、
> 唤醒空闲会话、并行协作。本文给出可落地的设计、**已核实的事实**、验收口径与坑。
>
> **2026-10-15 修订**：初版把投递机制设计成「直接往目标会话日志追加 inbox 事件」。经读 DSH 源码
> 并实证真实会话日志，该前提不成立（三处不实见第十节）。正文已改为走**官方 prompt API**——
> 这条路径由本体保证唤醒、幂等与并发安全，**不再需要自己写日志**。

## 一、设计目标与边界

**要做的能力**

```
list_sessions()                              列出可投递的会话（id/标题/工作区/状态/最后活动）
send_to_session(sessionId, text, opts?)      把一条消息投递给目标会话；目标空闲时由本体唤醒它跑一个回合
```

**不做的事（本期边界）**

- 不做广播/群发（避免互相唤醒风暴）
- 不做附件/文件传输（消息只承载文本；文件走共享路径）
- 不做跨机器投递（限本机 DSH_HOME 内的会话）

## 二、机制事实（已核实，以代码与实测为准）

### 2.1 投递 = 官方 prompt 命令（唯一推荐路径）

本体的会话控制器把「投递一条消息给某个会话」做成了一等公民，并且**已通过 `@Remote` 暴露给插件**：

```
packages/api/session-controller/src/index.ts:441    @Remote('prompt')
packages/api/session-controller/src/commands.ts:311  async prompt(request) { ... }
packages/api/session-controller/src/types.ts:338-351 请求/回执类型
```

`index.ts:435-445` 的文档注释是关键事实，原文：

> Admit one prompt **after explicitly resuming its Session**.

即 **「唤醒」由本体保证**——不需要自己去查会话运行入口。契约：

```ts
interface SessionPromptRequest {
  requestId: SessionRequestId            // 幂等键：持久化在那条被接受的消息上
  sessionId: SessionId
  mode: 'queue' | 'steer'
  content: readonly PromptContentPart[]  // 至少一个非空白 text part（或附件）
  clientTimeZone?: string
}
interface SessionPromptValue { accepted: true }
```

投递语义（`commands.ts:364-365`）：

```ts
if (request.mode === 'steer') agent.steer(message)   // 注入「正在跑」的那个回合
else                          agent.followup(message) // 排队，等回合边界消费（空闲会话由此被唤醒）
```

**幂等**（`commands.ts:330`）：`hasPromptRequest(agent, requestId)` 命中时直接返回 `{accepted:true}`，
不重复投递 —— 所以调用方可以安全重试。

**错误码**（`commands.ts:312-372`）：`gateway/bad-request`（内容为空）、`session/not-found`、
`session/agent-busy`、`session/model-unavailable`、`session/attachment-invalid`、`session/invalid-time-zone`。

### 2.2 会话日志里的 inbox 事件：**只有一条**是落盘事件

初版称「日志里能看到 `inserted`/`claimed`/`spliced`/`discarded` 四类真实事件」。**实测证伪**：

```
扫 60 个真实会话日志（58 个含 agent/inbox/*），实际只出现：
  agent/inbox/spliced   22656 条
  inserted / claimed / discarded   0 条
```

对照官方「本 build 理解的持久化事件词汇」`packages/core/session/src/known-event-types.ts:24`，
inbox 家族里**只有 `agent/inbox/spliced`**；其余三个是 **agent 作用域的运行时广播**
（`packages/core/agent-loop/src/inbox.ts:237,240` 的 `dispatch.emit(...)`），**不落盘**。

`agent/inbox/spliced` 的字段（`inbox.ts:227-233`）：

```ts
{ target: 'next-turn' | 'next-step', start, removedCount?, inserted: UserMessage[], outcome?: 'canceled' }
```

官方写入口是 `this.session.append('agent/inbox/spliced', splice)`（`inbox.ts:235`）。

**为什么仍然不要自己写它**：`inbox.ts:31-56` 的 fold 对非法 splice **直接抛错**——
`message.id` 在两个 pending 列表里重复、`start` 越界、`start+removedCount` 越界都会让**整个会话读不出来**。
自己写 = 拿对方会话的完整性冒险，且要自己处理帧编码与并发写。**这条路是兜底，不是首选。**

### 2.3 会话发现

复用插件现成能力，不要另造：`lib/sessions/list.js`（会话列举 + 归档补全）。
本体的相关概念是 `workspaceRegistry` 与会话存储（源码树内可搜）。

## 三、接口

```
list_sessions() -> [{
  id, title, workspace,
  status: "idle" | "running" | "inactive",
  lastActivityAt, isSelf
}]

send_to_session({
  sessionId: string,      // 必填，来自 list_sessions
  text: string,           // 必填，纯文本，长度上限建议 8KB
  mode?: "queue" | "steer",  // 默认 "queue"
  requestId?: string,     // 可选：调用方自带幂等键；缺省由插件生成并在回执里回传
  hops?: number           // 可选：协作链跳数（见第五节）
}) -> {
  ok: true,
  requestId,              // 回执带回，便于调用方重试同一 requestId
  delivered: "woke" | "inbox" | "steered",
  targetStatus
}
```

## 四、状态行为

| 目标状态 | 做法 | 回执 |
|---|---|---|
| idle / inactive | `mode:"queue"` → `followup`；Remote 层会**先 resume 该会话**再受理 | `delivered:"woke"` |
| running（希望立刻影响当前回合） | `mode:"steer"` → `agent.steer(message)` | `delivered:"steered"` |
| running（不打扰，等回合边界） | `mode:"queue"` → `followup` | `delivered:"inbox"` |
| 不存在 / 已归档 | **不调用**，直接拒绝，不产生任何副作用 | `{ok:false, error:"session-not-found"}` |

本体错误码到本工具回执的映射：

| 本体错误 | 含义 | 建议回执 |
|---|---|---|
| `session/not-found` | 会话不存在或已被释放 | `error:"session-not-found"` |
| `session/agent-busy` | 受理时被拒（多为竞争） | `error:"target-busy"`，可提示重试（同 requestId 幂等） |
| `session/model-unavailable` | 目标未选模型 | `error:"target-no-model"`，提示对方先选模型 |
| `gateway/bad-request` | 内容为空 | 本地就该拦住，不应到达本体 |

## 五、安全、限流与防风暴（必须做）

1. **只允许本机同用户的会话**：sessionId 必须在当前 DSH_HOME 的注册表内；不接受任意路径
2. **禁止自投**（`sessionId === 当前会话` ⇒ 拒绝），避免自我唤醒死循环
3. **跳数限制**：消息头携带 `hops`，AI 之间互相投递时 `hops+1`；`hops >= 3` 拒绝并提示「请用共享文件交接」
4. **限流**：同一对会话 60s 内最多 N 条（建议 N=5），超出返回 `rate-limited`
5. **幂等去重**：同一 `requestId` 只投一次（本体已保证；插件侧再做一层，防重试风暴）
6. **审计留痕**：每次投递在**发起方**日志里留一条可查记录（谁发给谁、requestId、是否唤醒）
7. **不越权**：工具只做投递，**不读取对方会话内容**；不给 AI 提供「读别人会话」的能力
8. **不直接写会话日志**：理由见 2.2（fold 会因非法 splice 抛错，写坏 = 毁掉对方会话）

> 注意：本体的 `session/agent-busy` **只能反映单次受理结果，不能防风暴**。
> 防风暴必须靠第 3、4、5 条（跳数 + 限流 + 幂等）与第 2 条（禁自投）。

## 六、已知坑

1. **`defineTool` 必须显式导入**：本项目历史上出现过「文件里直接用 `defineTool` 却从未导入」⇒
   `inject('tools')` 回调抛 `ReferenceError` ⇒ **四个工具全部注册不上**。新增工具照抄 `lib/apply.js`
   的动态加载写法，并在 `test/api/helpers/fake-services.mjs` 同款假环境里跑一遍注册。
2. **不要自己写会话日志**（初版设计的主要风险，已废弃该路径）：帧编码、并发写、fold 校验三关都在本体手里，
   绕过去等于把「对方会话读不出来」的风险揽到自己身上。
3. **`signal` 必传**：Remote 层签名是 `prompt(request, signal: AbortSignal)`，调用时要给一个 `AbortSignal`
   （可用 `AbortSignal.timeout(...)` 兜底）。
4. **内容不能为空**：`content` 必须含至少一个**非空白** text part，否则本体回 `gateway/bad-request`。
5. **`mode:"steer"` 只对 running 目标有意义**：对空闲会话用 steer 没有「正在跑的回合」可注入。
6. **唤醒风暴**：两个会话互相 `send_to_session` 且都可唤醒 ⇒ 无限回合。第五节的跳数 + 限流 + 禁自投是硬要求。
7. **目标可能是冷会话**：`list_sessions` 的状态与投递瞬间的状态可能不一致（TOCTOU），
   以**本体返回的错误码**为准，不要以本地状态判断代替。

## 七、实现落点（按本项目既有结构）

```
lib/features/session-messaging/index.js   新建 feature 模块，导出：
                                          registerSessionMessagingTools(ctx, defineTool, tools)
  · list_sessions：复用 lib/sessions/list.js 的列举能力，产出第三节字段
  · send_to_session：校验（自投/hops/限流/长度）→ 取 apiProxy → sessions.prompt(...) → 审计
  · apiProxy 取法照抄 lib/features/member-model/switch.js:165：
      const apiProxy = ctx.apiProxy ?? (typeof ctx.get === "function" ? ctx.get("apiProxy") : null)
      const proxySessions = apiProxy?.sessions
    （同一 Remote 命名空间下的 sessions.selectModel 已被本插件成功调用，故 sessions.prompt 可达）
lib/apply.js                              在既有 inject('tools') 回调里注册新模块（照现有工具的写法）
skills/                                   补一段「跨会话发消息」用法（何时该用、何时改用共享文件）
docs/VERSIONS.md                          记录本次功能
README.md                                 功能表补一行 + 用法示例（含 list_sessions 输出样例）
test/                                     两条用例：正常投递（假环境断言 prompt 请求参数）、
                                          拒绝路径（自投/跳数/限流/不存在）
```

## 八、验收口径（做完必须自证，5 条）

```
1. 两个测试会话 A/B：A 调 send_to_session(B, "hello") ⇒ B 的日志里出现 agent/inbox/spliced，
   且 B 的回合确实消费到该消息（followup 路径）
2. B 处于 running 时：mode="steer" ⇒ 注入当前回合；mode="queue" ⇒ 不打断，下一回合边界消费
3. 拒绝路径逐条命中：自投 / 目标不存在 / hops 超限 / 60s 内超量 ⇒ 均返回明确错误且**不产生任何副作用**
4. 幂等：同一 requestId 重复投递 ⇒ 目标侧只出现一条消息（本体 accepted:true 短路）
5. 审计：发起方日志里有对应记录，可查出 requestId 与目标会话
```

## 九、选用顺序

跨会话协作有三种载体，本能力只补第一种：

```
① 需要对方立刻行动、且是短消息           → send_to_session
② 需要交接上下文/长内容/可追溯           → 共享文件（如工作区下的交接 md）+ git 提交信息
③ 需要人做决策或跨机器                    → 人转达
```

不要让 `send_to_session` 承担 ② 的职责（长内容应落文件，消息里只放路径与要点）。

## 十、修订记录（2026-10-15，依据源码 + 实测）

| # | 初版说法 | 核实结果 | 依据 |
|---|---|---|---|
| 1 | 投递 = 往目标会话日志追加 inbox 事件 | **改为官方 `prompt` 命令**；本体已 `@Remote('prompt')` 暴露，且受理前会 resume 会话（唤醒由本体保证） | `session-controller/src/index.ts:441`；`commands.ts:311-377` |
| 2 | 日志里能看到 `inserted`/`claimed`/`spliced`/`discarded` 四类真实事件 | **只有 `agent/inbox/spliced` 落盘**；其余三个是运行时广播。实测 60 个日志：spliced 22656 条，其余 0 条 | `known-event-types.ts:24`；`agent-loop/src/inbox.ts:237,240`；真实日志扫描 |
| 3 | 引用 `loader-smoke/lib/types/agent-turn.js`、`session-snapshot/lib/types/harness.js` | **这两个路径不存在**；正确位置是 `agent-loop/src/inbox.ts` 与 `session-controller/src/types.ts` | 文件系统实测 |

初版中**保留不变**的部分：边界（不广播/不附件/不跨机器）、防风暴的六条思路、`defineTool` 必须显式导入的坑、
「与共享文件的关系」与选用顺序。
