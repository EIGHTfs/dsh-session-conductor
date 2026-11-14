# 五项会话管理能力：吸收设计

> 来源：外部提交的 PR（作者 xielhz，标注 AI 生成），原提交基于 1.4.17，已关闭、未合并。
> 本文把该 PR 的设计与取舍固化成可执行的实施依据——**代码不直接沿用，设计沿用**。
> 关闭理由是工程现实（基线落后、`panel.js` 已重构、单次改动过大），不是代码质量。

## 一、总体原则

| 原则 | 说明 |
|---|---|
| 按能力分批吸收 | 每批独立可回归，不做一次性大合并 |
| 沿用设计取舍 | 未读公式、排序转发、聚合拆叶子、路径校验四条已验证合理 |
| 挂到现有结构 | `panel.js` 已把行渲染拆成 `renderRowTop/Main/Ops` 等小函数，新增 UI 挂这些函数，不重写整段 |
| 版本纪律 | 每次提交 patch+1，不跨大版本 |
| 归属 | 若落地，提交信息注明「设计来自 PR #1（xielhz）」 |

## 二、五项能力

### 1. 打开日志目录（建议第一批）

- **目的**：用户遇到"这条会话为什么显示异常"时，最想直接打开那个文件夹看一眼甚至备份一份。
- **接口**：`POST /api/session-conductor/open-log-dir` `{ sessionId }` → `{ ok, dir, opened }`
- **客户端**：会话行内按钮；同时展示目录路径与「复制路径」兜底。
- **设计取舍（沿用）**：
  - 客户端只能传 `sessionId`，不能传路径——传什么都不会被执行；
  - 定位到日志文件后做 `realpath` 前缀校验，必须落在 sessions 根内，否则 `403 OUTSIDE_ROOT`；
  - `sessionId` 先过 `^[A-Za-z0-9._-]{1,128}$` 白名单，挡住 `..` 与分隔符；
  - 拉起文件管理器用 `spawn(explorer.exe / open / xdg-open, detached + stdio:ignore)`，不等退出码（`explorer.exe` 成功也常返回 1）；`opened` 仅表示"拉起动作已发出"。
- **依赖**：`locateSessionLogFile`（本仓库已有）、`sessionsRootOf`（本仓库已有）。
- **验收**：越界 sessionId 返回 403；不存在的会话返回 404；`dir` 指向真实日志所在目录。

### 2. 未读标记（建议第一批）

- **目的**：告诉用户"这条对话在我上次看之后又动过"。
- **接口**：
  - `GET /unread` → `{ ok, version, entries: { [sessionId]: readAtMs }, allReadAt }`
  - `POST /unread` `{ sessionId, read?: boolean, at?: number }` → 同上快照
  - `POST /unread/all` `{ at?: number }` → 同上快照
- **客户端**：行首圆点 + 工具栏「全部已读」+ 触发按钮角标。
- **设计取舍（沿用，核心）**：**只记"读到哪个时刻"，不存布尔位**。
  ```
  unread(session) === (session.updatedAt ?? 0) > max(entries[id] ?? 0, allReadAt ?? 0)
  ```
  布尔位必须在"产生新活动"时置 true，那就得挂 `session/event` 钩子、还得判断用户当前打开哪条会话；流式输出、子代理、后台续跑都会产生事件，判定源越多越容易漏。改成时间点后，未读是纯比较，面板拿到列表即可自算，也不会出现"置了 true 忘复位"。
- **落盘**：`storages/dsh-session-conductor/index.json` 的 `unread` section（插件私有派生数据，不进持久化域——域是跨会话设置项，派生数据进域会让"清空域"误伤用户配置）。
- **必做配套**：`normalizeStore` 是白名单重建，**新增 section 必须同步 `emptyStore()`**，否则重启静默丢数据。验收要加"落盘 + 模拟重启"用例。
- **边界处理**：坏值（`null` / `"abc"` / 负数）按"没记过"处理，结果是显示未读——宁可多点一个点，也不要静默吞掉真实的新活动。
- **已知边界**：手动「标为未读」在"全局已读水位晚于该会话 updatedAt"时公式表达不出来，客户端用内存覆盖兜住；要严谨需让宿主侧水位参与比较，属契约变更。

### 3. 会话统计（建议第一批）

- **目的**：数字视角看会话库（总量、工作区分布、14 天活跃、体积榜）。
- **接口**：`GET /stats`（支持 `fromIndex` 决定是否走索引；全量重建在大会话库上很慢）。
- **客户端**：面板新增第 6 个 tab：数字卡片 + 工作区分布 + 14 天活跃 + 体积榜。
- **设计取舍（沿用）**：
  - 纯聚合拆成零依赖叶子 `lib/features/stats-aggregate.js`——取数链路会经 `sessions/list.js` 拉起 `core/domain.js`，而单测环境没有可选 peer `@deepseek-ai/dsh-storage-domain`，不拆就 import 不进来；
  - **体积拿不到时整体退化为 `null` 而不是 `0`**：`0` 会被读成"日志是空的"，而实际是"不知道"。
- **依赖**：`sessionPersistence.list()` 的 `sizeBytes`（已验证当前版本存在）。
- **验收**：无数据/接口失败/加载中三个态不白屏；`sizeBytes` 缺失时显示"未知"而非 0。

### 4. 拖拽排序（第二批，需先实测）

- **目的**：拖分组标题改工作区顺序；把会话拖进别组。
- **接口**：`POST /reorder` `{ kind, id?, beforeId?, sessionId?, workspaceId? }`
  - 工作区排序 → 返回 `{ ok, order: [...] }`
  - 会话排序 / 移组 → 返回 `{ ok, sessionIds: [...] }`
- **设计取舍（沿用）**：**排序不自存**，直接转发 `workspaceRegistry.insertBefore` / `Workspace.insertSessionBefore`；插件自己存一份顺序必然与官方侧边栏打架。
- **分组口径必须改**：改成「注册表 `sessionIds` 优先，cwd 最深祖先兜底」。会话 cwd 不可变，只按 cwd 分桶的话，"拖进别组"刷新一次就弹回原组。
- **待验证**：`workspace/workspace` 的 `insertBefore` 在当前主干的实际语义（返回结构、失败表现、是否持久化）。
- **风险**：改动会影响现有分组渲染（`group/list` 与面板分组视图），回归面较大。

### 5. 分支到新对话 fork（第二批，需先实测）

- **目的**：从某条会话分出分支继续探索，不污染原线。
- **接口**：
  - `GET /forked` → `{ ok, forkOf: { [childId]: sourceId } }`
  - `POST /forked` `{ childId, sourceId }` → 记录派生关系
  - fork 动作本身走宿主原生 `sessions.fork`
- **设计取舍（沿用）**：**派生关系记录失败不阻断 fork**（宿主 fork 已成功，回 200 + `ok:false` + `RECORD_FAILED`）。
- **域改动**：仅新增带默认值的 `forkOf` 字段，不升 domain version（纯加默认值，老数据照读）。
- **待验证**：`sessions.fork` 在当前主干的参数与返回结构；fork 后的会话落在哪个工作区、标题如何处理。

## 三、分批计划

| 批次 | 内容 | 理由 | 验收 |
|---|---|---|---|
| 第一批 | 打开日志目录 → 未读 → 统计 | 三块独立度高、与 `panel.js` 现有结构冲突小 | 每项独立提交、独立单测；`index-store` 改动必须带重启用例 |
| 第二批 | 拖拽排序 → fork | 依赖宿主接口行为，需先实测再动 | 先写探针脚本验证 `insertBefore` / `sessions.fork`，再改 UI |

每批都要求：
1. 新增路由走本仓库既有 `send()` / `readJson()` 与统一错误信封；
2. 新增修复/能力类型若属"可登记"性质，走 `lib/features/repair-registry.js` 那类注册表，不散落硬编码；
3. 前端分片改完必须 `node build.cjs` 重建并 `--check`；
4. 全量回归 + 审计 0 拦截。

## 四、风险清单

| 风险 | 说明 |
|---|---|
| 面板行渲染冲突 | `panel.js` 已重构为多个小函数，PR 的原始 diff 不能直接套用，需按新结构重写 UI 部分 |
| 会话归属两套真相 | 若既存注册表顺序、又存插件侧顺序，必然打架——坚持注册表唯一真相 |
| 索引丢失 | `normalizeStore` 白名单重建，漏同步 `emptyStore()` 会导致重启后未读数据静默消失 |
| 大会话库性能 | 统计全量重建在大会话库上很慢，默认走索引，全量只做显式触发 |

## 五、相关

- 面板行渲染结构：`lib/client-parts/components/panel.js` 的 `renderRow*` 系列
- 修复类型注册表（同类"登记式"扩展的参照）：`lib/features/repair-registry.js`
- 索引存储：`lib/core/index-store.js`（`normalizeStore` / `emptyStore`）
