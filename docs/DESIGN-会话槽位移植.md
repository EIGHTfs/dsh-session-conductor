# 设计方案：会话槽位移植（把一条主会话的内容搬进已有子代理）

| 项 | 内容 |
|---|---|
| 状态 | **设计完成，未实现** |
| 起因 | 需要让一条主会话（top-level）的完整对话历史，出现在某个已存在的子代理槽位里：从父会话的成员列表点进去，看得到它的历史，并且能在该身份的约束下继续跑 |
| 不做什么 | 不新增 UI 入口；不做通用的「任意会话互换」；不碰 compaction 算法 |

---

## 1. 目标与验收标准

**目标**：给定「源主会话 SRC」和「目标子代理槽位 DST（已属于某个父会话）」，把 SRC 的事件主体搬进 DST 的日志，DST 的身份字段（`origin` / `parentSession` / `delegationDepth` / `cwd` / `createdAt` / `agentPreset`）原样保留。

**验收标准**（全部满足才算完成）：

1. 从父会话的成员列表能打开 DST，看到的是 SRC 的对话历史（消息条数与末尾内容一致）
2. DST 在成员列表里的显示名仍是它原来的 label（标题不换）
3. DST 能正常接受一条新消息并跑完一个回合（证明日志闭合、模型与权限可用）
4. 写后自检通过：`header` 单行、`seq` 严格连续、每帧带 checksum、`validateSessionText` 无问题
5. 原 SRC 会话文件未被改动（可回滚点仍在）
6. 出问题时能在 3 步内回滚（还原备份 + 清投影缓存 + 重载）

---

## 2. 现状基线（实测）

样本数据：4362 条事件，`seq 0..4361` **严格连续**；`isSeeded: false`、`delegationDepth: 0`、header 无 `origin`（= 主会话）。

「主代理特有信息」实测清单：

| 类别 | 实测数量 | 特征 |
|---|---|---|
| `subagent/catalog` | 2 | 它自己的两个子代理，其 header `parent` 指向 SRC、`depth: 1` |
| `permission/preset` + `sandbox/mode` + `approval/policy` | 各 3 | **末态是 `danger-full-access` + `never`** |
| `model/selection` | 26 | provider 为 `q` / `workbuddy` / `sa6400`（前两个已下线） |
| `session/end-seed` | 7 | **全是 `{}`**（无 `inherited`）→ 不触发 `isSeeded` / `inheritedEventCount` 约束 |
| `compaction/prune` | 2 | `shadowedSeqs: [31]`、`[32]` —— **引用 seq 号** |
| `compaction/summary` | 2 | 压缩摘要，模型可见 |
| `session/title` | 多条 | 会被一起搬过去（本方案要求不覆盖显示名，见 §4.4） |

宿主侧的契约（源码位置见 §9）：

- 子代理身份 = header 的 `origin: "subagent"` + `parentSession` + `delegationDepth`
- 冷恢复要求子会话日志里有 `subagent/descriptor`，且 `mode: "continuable"`；缺了会判 not-resumable
- 父会话的成员列表来自 `subagent/catalog` 事件（parent-owned 投影，只能 append）
- 两者 schema 都是 **strict**，多一个字段就拒

---

## 3. 方案选型

### 路线 1：改 SRC 的 header，把它变成某父会话的子代理 —— 否决

否决理由（三条都是实测/源码事实）：

1. 它自己已有的子代理要连带调整 `delegationDepth`，否则出现「孙代理与子代理同层」
2. `client/ui-workspace/src/client/tree.ts:244` 对 `origin === 'subagent'` 直接返回 false —— 该会话会**从工作区树消失**，容易被误认为会话丢失
3. SRC 的 `cwd` 可能已失效（样本指向的目录早已不存在），改造后所有工具调用都会在坏目录上跑

### 路线 2：内容移植（选定）

保留 DST 的 header，搬 SRC 的事件主体。身份、`descriptor`、`catalog`、`cwd` 全部复用现成的，一次绕掉上面三个坑。

### 事件筛选策略：不筛（选定）

**不筛事件、seq 保持原样**，搬完用插件工具覆盖尾部状态：

- `model/selection` 与 `approval/policy` 都是「最后一条生效」，尾部状态正确后，中间那些失效历史不影响运行
- 不筛 → 不需要 seq 重映射 → 不需要重写 `compaction/prune` 的 `shadowedSeqs`，风险面最小

**可选分支（仅当要求彻底干净时）**：筛掉 `subagent/catalog`(2) + 权限三件套(9) + `model/selection`(26)，但**必须同步重写** `compaction/prune` 的 `shadowedSeqs` / `shadowedRange`，并做一次 seq 重映射自检。实测引用只有 2 条，工作量可控，但比主线多一层风险。

---

## 4. 数据操作规格

### 4.1 header

DST 的 header **整份保留**，不掺 SRC 的任何字段（`type` / `version` / `id` / `createdAt` / `cwd` / `isSeeded` / `delegationDepth` / `agentPreset` / `origin` / `parentSession` 全部取 DST 原值）。

### 4.2 事件主体

SRC 的事件按原顺序、原 `seq`、原 `time` 搬入。搬入后 DST 日志的 `seq` 从 0 连续到 `N-1`（`N` 为 SRC 事件数）。

### 4.3 结尾闭合

- 若 SRC 末尾是 `turn/end` → 直接可用，无需补事件
- 若 SRC 末尾停在 `step/end`（有未闭合回合）→ 补一条 `turn/end`（`turn` 取该 step 的 turn 号，`reason: {kind: "aborted", reason: {kind: "user"}}`），`seq` 接在末尾
- 宿主校验要求 `turn/end` 必须对应「已闭合 step 的 open turn」，所以只能补在 `step/end` 之后

### 4.4 标题

DST 日志里 SRC 带来的 `session/title` 事件**保留不动**（它们属于历史记录），但**不再追加新的 title 事件**，也不触发自动重命名 —— 成员列表显示名来自 `subagent/catalog.label`（父会话侧），不受日志内 title 影响。

### 4.5 descriptor 与 catalog

- DST 的 `subagent/descriptor` 保留原值；若其 `agentProvider` / `agentModel` 不可用，用插件的模型切换重设（不要手改 descriptor 里的模型字段，走已有工具）
- 父会话的 `subagent/catalog` 记录不动（`childId` 仍是 DST）
- SRC 带来的 2 条 `subagent/catalog` 会留在 DST 日志里 → DST 的成员视图会多出 2 条指向前身的记录（仅显示层面），本方案接受这个残留（见 §7）

### 4.6 孙代理

SRC 的 2 个子代理**原地不动**：它们 provider 已下线，改了也跑不起来；不动则零风险。

---

## 5. 开发步骤（里程碑）

### M1 · 只读勘察与备份

- 确认目标父会话、DST 槽位 id、SRC 导出包或会话文件路径
- 读三方数据：SRC 事件全量、DST 的 header + descriptor、父会话的 catalog 记录
- 输出勘察报告：事件数、seq 连续性、header 对照表、`end-seed` 是否带 `inherited`、`compaction` 引用 seq 列表
- **备份**：DST 原日志整份复制到 `.slot-migrate-backup/<时间戳>/`；记录原文件大小与 mtime
- 验收：报告里三方数据齐备，备份文件可读

### M2 · 纯函数层（可单测）

- 新增 `lib/sessions/slot-migrate-core.js`（零宿主依赖，与 `undo-core.js` 同族）
- 提供三个纯函数：`readSourceEvents(parsed)`、`buildTargetLog(targetHeader, sourceEvents, { closing })`、`assertMigratedLog(text, expectations)`
- 单测覆盖：header 取 DST、seq 原样、末尾闭合补 `turn/end`、末尾已闭合不补、事件数为 0 报错、header 混入 SRC 字段报错
- 验收：`node test/unit/test-slot-migrate-core.mjs` 全绿

### M3 · 写入与自检

- 用 `lib/repair.js` 的 `encodeSessionText` 多帧编码（首帧只放 header 一行 + 每帧 checksum）
- 原子写：写临时文件 → `rename` 覆盖
- 写完立即自检：解码全文、header 单行、`seq` 连续、事件数等于预期、每帧 checksum 齐全、`validateSessionText` 无问题
- 验收：自检全绿；失败时自动还原备份并报错

### M4 · 状态覆盖

- 清 DST 的投影缓存（改名留档，不删）
- 用插件工具设模型：`set_member_model`（目标 provider/model 必须真实可用）
- 用插件工具设权限：`set_member_permission`（不要沿用 SRC 的 `danger-full-access` + `never`）
- 验收：工具回执成功；`descriptor` 里不再残留 `agentReasoningEffort`（换模型必须丢旧档位）

### M5 · 端到端验证

- 父会话成员列表能看到 DST，label 未变
- 点开 DST，消息条数与末尾内容与 SRC 一致
- 向 DST 发一条短消息，确认跑完一个回合（模型与权限都生效）
- 查看 DST 轨迹（`read_member_trace`）确认事件正常追加
- 验收：四条全过；任一失败进入 §6 回滚

### M6 · 回滚演练与文档

- 演练回滚：还原备份 → 清缓存 → 确认成员列表恢复原样
- 把实际执行记录（用于备份的路径、校验输出）写进本文档附录
- 验收：回滚可在 3 步内完成并验证

---

## 6. 回滚

1. `rename` 备份文件覆盖回 DST 日志
2. 删（改名）DST 的投影缓存
3. 重载该会话（detach 后再次打开），确认成员列表与内容恢复

三者缺一都会「文件回了、界面还是新的」。

---

## 7. 风险与边界

| 风险 | 说明 | 处置 |
|---|---|---|
| 残留 2 条 catalog | DST 成员视图会显示 2 条指向前身的记录 | 接受（仅显示层面）；要清就走 §3 可选分支 |
| SRC 的失效 provider | 26 条 `model/selection` 里多个 provider 已下线 | 不筛，靠 M4 覆盖尾部状态 |
| 权限被带过去 | 末态 `danger-full-access` + `never` | M4 强制重设权限预设 |
| `cwd` 差异 | SRC 的 cwd 可能失效；DST 用自己的 | 本方案天然规避 |
| 写入期间有人在跑该会话 | 内存态可能回写覆盖 | 写入前 detach；`mtime` 静止再动手 |
| 并行写冲突 | 同一仓库/目录有其它会话在改 | 只操作目标会话目录，不碰仓库其它文件 |
| 日志体积 | SRC 明文可达 10 MB 级 | 编码后约 1/3；写完核对大小与事件数 |

---

## 8. 待定项

- **目标父会话 + 目标子代理槽位**未定（动手前必须补齐；候选清单要解码会话日志里的 `subagent/catalog` 事件来列，不要按投影缓存结构去猜）
- 是否需要保留 SRC 原会话（建议保留，等于天然回滚点）

---

## 9. 相关代码位置

| 用途 | 位置 |
|---|---|
| 多帧解码 / 编码 | `lib/zstd-frames.js`、`lib/repair.js`（`encodeSessionText` / `validateSessionText`） |
| 切点与边界处理（同族能力） | `lib/sessions/undo-core.js` |
| 成员模型 / 权限 | `lib/features/member-model/`（`switch.js`、`override.js`） |
| 会话目录与 id 解析 | `lib/sessions/events.js`、`lib/sessions/tail-io.js` |
| 宿主契约（只读参考） | `llm/llm/src/index.ts`、`core/agent-loop/src/agent.ts`、`subagent/subagent/src/descriptor.ts`、`subagent/subagent/src/catalog.ts`、`client/ui-workspace/src/client/tree.ts` |
