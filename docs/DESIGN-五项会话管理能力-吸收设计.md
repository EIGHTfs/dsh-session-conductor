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

### 4. 拖拽排序（第二批，探针已做）

- **目的**：拖分组标题改工作区顺序；组内拖会话改顺序；跨组拖动改归属。
- **接口**：`POST /reorder` `{ kind, id?, beforeId?, sessionId?, workspaceId? }`
  - 工作区排序 → 返回 `{ ok, order: [...] }`
  - 会话排序 / 移组 → 返回 `{ ok, sessionIds: [...] }`
- **设计取舍（沿用）**：**排序不自存**，直接转发 `workspaceRegistry.insertBefore` / `Workspace.insertSessionBefore`；插件自己存一份顺序必然与官方侧边栏打架。
- **宿主接口实测（静态读 `packages/workspace/workspace/lib/index.js`）**：
  - `registry.insertBefore(id, beforeId?)`：DOM insertBefore 语义，锚点缺省即追加末尾；两侧 id 都必须存在（否则 `WorkspaceOrderInvalidError`）；位置不变时幂等返回、不写盘；返回完整顺序并持久化。
  - `workspace.insertSessionBefore(sessionId, beforeSessionId?)`：**只允许同组内移动**——校验 session 必须在该组 `sessionIds` 里，否则 `WorkspaceMoveInvalidError`。
  - `workspace.attachSession(sessionId)`：**强制校验 `cwd === workspace.path`**（源码 `if (cwd !== this.record.path) throw`），且 cwd 必须可 realpath、必须是目录。
- **⚠️ 由此推翻一个设计假设**：PR 的「把会话拖进别组」靠 `源 detachSession + 目标 attachSession`，但 `attachSession` 要求会话 cwd 恰好等于目标组路径。会话 cwd 是创建时定死的，所以**跨组拖拽在多数场景会直接失败**（抛 cwd 不匹配），不是实现瑕疵，是宿主硬约束。
  - 结论：这一批只做「工作区排序 + 组内会话排序」；跨组拖拽暂不做。若将来要做，得先让宿主支持"显式归属覆盖"，属契约变更。
- **待验证**：以上为静态读源码结论，写后端前在隔离实例用真实 `workspaceRegistry` 跑一次确认（尤其失败时的错误对象结构）。
- **风险**：分组口径若改成「注册表优先」，需确认不会影响现有按 cwd 分组的面板视图。

### 5. 分支到新对话 fork（第二批，探针已做 → **不做**）

- **宿主语义**（`sessionController.fork({sessionId, atSeq?})`）：
  - 不给 `atSeq` → 取 `latestCompletedPrefixBoundary`（最近一个**完整回合**的边界）；给了则必须是已存在事件且落在完整回合边界，否则 `session/fork-unavailable`
  - 种子构造 `buildForkSeed(events, boundary)`：复制 `events[0..boundary]` + 追一条 `session/end-seed {inherited:true}` + 用 `persisted`→`forked` 原因闭合未完成回合（有副作用的工具调用会插入「先核实外部状态再决定是否重试」的提示）
  - 子会话：新 id、`isSeeded: true`、沿用源会话 `cwd` / `agentPreset` / 所在工作区，采用**当前默认模型**
- **DSH GUI 已有该能力**：侧边栏注入 `forkSession`（埋点 `click_position: "sidebar"`）、标题自动递增（`increaseTitle: true`）、`session/migration-required` 有引导提示。
- **结论：不做**。插件重复实现只会与官方入口争夺同一能力，没有增量价值。

### 6. 结论：五项里只有三项是真缺口

| 能力 | 判定 |
|---|---|
| 打开日志目录 | ✅ 真缺口，已做（1.4.24） |
| 未读标记 | ✅ 真缺口，已做（1.4.25） |
| 会话统计 | ✅ 真缺口，已做（1.4.26） |
| 拖拽排序 | ❌ 不做：组内顺序 GUI 用浏览器本地状态、跨组受 cwd 限制、仅剩工作区排序且 GUI 本就能拖 |
| 分支对话 fork | ❌ 不做：DSH GUI 自带 |

## 三、实施顺序（按依赖排，含注意事项）

> **中断后如何恢复**：先通读本文档，再看「状态」列确认做到哪一步，然后从下一个未完成项继续。每项的关键点与坑都写在这里，历史讨论不必回看。

| # | 任务 | 关键点 / 注意 | 前置 | 状态 |
|---|---|---|---|---|
| 1 | `open-log-dir` 后端 | 路径安全三层（只收 sessionId / 白名单 / realpath 前缀）；安全判定放零依赖叶子 `lib/shared/path-guard.js`，否则被宿主 peer 拉住无法单测 | — | ✅ 1.4.24 |
| 2 | `unread` 后端 | **只存 readAt 不存布尔位**；`index-store` 的 `normalizeStore` 是白名单重建，必须同步 `emptyStore()`，否则重启静默丢数据 | 1 | ✅ 1.4.25 |
| 3 | `unread` 实测 | 读 / 标记 / 全部已读 / **重启后数据仍在**（这条专门守第 2 项的坑） | 2 | ✅ 已验（重启后 entries + allReadAt 完好） |
| 4 | `stats` 后端 | 纯聚合拆成零依赖叶子；`sizeBytes` 拿不到时整体退化为 `null`，**不能写 0**（0 会被读成「日志是空的」） | 可并行 | ✅ 1.4.26 |
| 5 | `stats` 实测 | 有数据 / 无数据 / 接口失败三态都不能白屏 | 4 | ✅ 已验（结构+数值；宿主确实提供 sizeBytes） |
| 6 | 固化「测试环境安装三步」 | 见下方专节 | — | 待做 |
| 7 | `reorder` 探针 | 实测 `workspaceRegistry.insertBefore` 的语义与失败表现，**先探针再写** | — | ✅ 已探（见 2.4） |
| 8 | `reorder` 后端 | 探针结论：**不做**。组内会话顺序 GUI 读的是浏览器本地 `sessionOrderByAccount`，服务端 `insertSessionBefore` 不被读取（做了会「拖了没反应」）；跨组受 `attachSession` 强制 `cwd === workspace.path` 限制；仅剩「工作区排序」一项，而 GUI 侧边栏本来就能拖 | 7 | ❌ 不做 |
| 9 | `fork` 探针 | `sessions.fork({sessionId, atSeq?})`：复制到「完整回合边界」的历史 + `session/end-seed(inherited)` + 用 `forked` 原因闭合未完成回合；沿用源会话 cwd / agentPreset / 工作区，用当前默认模型；错误码 `session/not-found` / `session/fork-unavailable` | — | ✅ 已探 |
| 10 | `fork` 后端 | **不做**。DSH GUI 自带该能力：侧边栏注入 `forkSession`（`click_position: "sidebar"`）、标题递增、`session/migration-required` 引导；插件再做属重复实现 | 9 | ❌ 不做 |
| 11 | 前端挂载 | 五项 UI 一次性接入 `renderRow*` 现有结构 | 2/4/8/10 | 待做 |
| 12 | 收尾 | 主实例重启验证 + 是否发 npm | 全部 | 待做 |

### 每项的固定动作（缺一不可）

1. **单测**：纯逻辑必须能在工作区直接跑（零依赖叶子）；涉及索引/存储的必须带「落盘 + 模拟重启」用例
2. **隔离实例实测**：装进 `useful-tools` 测试环境，真跑一遍（步骤见第 6 项）
3. **全量回归**：`node test/run-all.mjs`
4. **审计**：`scope=diff` 必须 0 拦截
5. **提交推送**：精确 `paths`，不用 `git add -A`
6. **同步副本**：同步后**同时查「缺失文件」与「内容不一致」**——本机 `node_modules` 侧部分是独立副本，不会跟随同步

### 测试环境安装三步（第 6 项要固化的内容）

```bash
# ① 同步进测试环境并注册
sync_plugin({ dshHome: "<测试环境 DSH_HOME>", pluginName: "<插件>", write: true, register: true })

# ② 建 node_modules 解析入口（缺少这步宿主会 skipping profile bundle）
ln -s ../local-plugins/<插件> <测试环境>/profiles/web/node_modules/<插件>

# ③ 启动并实测
test_env({ action: "start" })   # 端口 3083
curl -X POST http://127.0.0.1:3083/api/session-conductor/<路由> -H "Cookie: dsh_session=<token>"
```

> 坑：`sync_plugin` 只写 `local-plugins/` 与 profile 的 `dependencies`（`file:local-plugins/...`），**不生成 `node_modules` 下的解析入口**；宿主按 bundle 从 `node_modules` 解析，缺链接直接 `skipping profile bundle`。该环境里已有插件用的也是相对符号链接，照建即可。
> 用完 `test_env({ action: "stop" })` 释放端口 3083。

### UI 验证方式（第 11 项用）

三级，按"越靠后越接近真实"：

| 级别 | 手段 | 能发现 | 不能发现 |
|---|---|---|---|
| 1 | 单测 + 分片语法 + `build.cjs --check` | 逻辑错、产物不同步 | 渲染问题 |
| 2 | `preview`（真实 client.js 垫片渲染，可接真实后端） | 结构错误、数据字段对不上 | 宿主真实环境差异 |
| 3 | **测试环境 + 浏览器插件实测** | 真实渲染、真实事件链路、主题/语言包差异 | — |

UI 改完至少走 2；涉及布局/交互/主题的走 3。

### 风险清单（每项开工前扫一眼）

| 风险 | 说明 |
|---|---|
| 面板行渲染冲突 | `panel.js` 已重构为多个小函数，PR 的原始 diff 不能直接套用，需按新结构重写 UI 部分 |
| 会话归属两套真相 | 若既存注册表顺序、又存插件侧顺序，必然打架——坚持注册表唯一真相 |
| 索引丢失 | `normalizeStore` 白名单重建，漏同步 `emptyStore()` 会导致重启后未读数据静默消失 |
| 大会话库性能 | 统计全量重建在大会话库上很慢，默认走索引，全量只做显式触发 |
| 部署副本不同步 | `node_modules` 侧部分是独立副本，同步后必须 `cmp` 比对，只看"文件存在"会漏 |

## 四、相关

- 面板行渲染结构：`lib/client-parts/components/panel.js` 的 `renderRow*` 系列
- 修复类型注册表（同类"登记式"扩展的参照）：`lib/features/repair-registry.js`
- 索引存储：`lib/core/index-store.js`（`normalizeStore` / `emptyStore`）
- 零依赖叶子范例（因宿主 peer 缺失而必须拆出来的）：`lib/shared/path-guard.js`
