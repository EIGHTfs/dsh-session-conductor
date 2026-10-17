# dsh-session-conductor

> DSH（DeepSeek Harness）会话管理增强插件：让会话列表可管理、可修复、可自动续跑。

侧边栏新增「会话管理」面板，归档会话可恢复、支持批量删除、AI 自动重命名、中断自动续跑、按工作区分组显示；设置页提供方案/收尾模板注入与自动重命名模型选择。

---

## 功能总览

| 功能 | 说明 | 入口 |
|---|---|---|
| 会话管理面板 | 全部/已归档/活跃/说明四视图；归档、恢复、删除（批量/按条件）、置为不活跃、释放全部空闲 | 侧边栏「会话管理」按钮 |
| 自动重命名 | 每个回合后 AI 分析会话内容，主题明显偏离时自动生成新标题（带运行状态后缀） | 面板逐会话开关 |
| 自动续跑 | 识别非人为中断（崩溃/限流/超时/错误），自动继续原任务；失败后 30s 重试 | 面板逐会话开关（临时设置，重启即默认关） |
| 会话分组 | 按工作区分组显示；「在分组下新建会话」 | 设置 → 插件 → 会话分组 |
| 撤回最后一条消息 | 删除最后一条用户消息及整轮回复（先预览 + 二次确认 + .undo-backup 备份） | 面板按钮 |
| 损坏修复 | 会话日志修复，四类判据：seq-gap / EIO 坏块 / 双格式（jsonl+zstd 并存）/ **zstd 帧级损坏**。最后这类原先修不了（尾部垃圾 + 末帧内容坏 ⇒ 整体放弃），现在支持**截断到最长可解码前缀**：逐帧解码定位安全点、保留原始帧不重编码、备份后原子写回（代价是丢掉不可解码的尾部帧，会如实报告丢了多少）。另：`supportsRepair` 的后端探测原先按 0.1.x 的接口判，0.2.x 已移除该接口 ⇒ 判据恒 false、面板扫描恒 501；现改用文件系统判据，内容修复不可用时**回退帧修复** | 面板「说明」页按钮 + 插件 HTTP `/repair` 系列 |
| 价值分析 | LLM 按规则给会话分类（已完成/未完成/久未活跃/活跃中） | 面板按钮 |
| 全文搜索 | 官方 FTS5 优先 + 内置 zstd 扫描兜底 | 面板搜索框 |
| 压缩模型选择 | 上下文自动压缩用模型独立选择（省成本） | 设置 → 插件 → 压缩模型 |
| 模板注入 | 方案模板 / 收尾模板：本地设备上传 / 在线网址 / DSH 目录浏览三种导入，内容可再编辑，注入系统提示词（方案/收尾各一条上下文注入） | 设置 → 会话管理 → 模板注入 |
| 自动重命名模型 | 指定便宜/专用模型做标题分析 | 设置 → 会话管理 |
| 成员模型切换 | 给队友/子代理单独切模型（只动该成员会话，不影响其他成员）：先用 `list_models` 拿确切模型 id，再 `set_member_model` 按成员名/sessionId 切换（写 `model/selection` 事件交给官方投影接管，跨轮持久；未挂载成员也能切，运行中会先等它暂停）。**返回值直接带「切没切成」的查证**：立刻给「最近一次实际请求的 provider/model（取自 `request/header`，请求级权威记录）+ 最近一次切换意图 + 一行判定」，并**注册查证任务（不阻塞）**——该成员下次发起请求时按 `agent/request` 事件判定，确认结果在下一次 step 注入给发起方（不轮询、不等待）；另附可复制的复核命令 `node scripts/check-member-model.mjs <sessionId>`。判定只认请求时真实使用的模型，不信注入的 `[model changed: …]` 提示。**另提供用户聊天框指令 `/model-switch`**（注册在宿主 `ctx.commands`）：无参 = 列成员与各自模型；`/model-switch <成员>` = 查该成员**实际**在用哪个模型（读请求级权威记录）；`/model-switch <成员> <provider>/<模型>` = 切换并回显查证快照 —— 与 AI 工具共用同一条切换 + 查证路径，用户自己就能操作，不必绕道求 AI | AI 工具 `list_models` / `set_member_model` + 聊天框指令 `/model-switch` + 脚本 `scripts/check-member-model.mjs` |
| 记忆取回 | 检测到上下文用量**明显下降**（默认 ≥10%，可配）即判定「上下文疑似丢失」——压缩、截断、实例重启后快照未加载**都算**（比只盯压缩更全）。此时自动把最近 **3 轮（可配）** 的**用户消息文本 + 该轮 AI 的第一条回应**（优先取当时的 reasoning）重新注入，让 AI 立刻恢复状态。实现要点：按 zstd 帧**流式**读日志（常量内存）、**只认真实用户消息**（排除插件自身注入，防反馈环）、同回合连发**合并成一轮**、注入总长与单条都有上限。配置项 `retrieveMemory*`（默认开）。**另提供 AI 工具 `recall_memory`**（参数 `rounds` = 取几轮，默认取配置、上限 50；参数 `session` = 目标会话：完整 id / 唯一前缀 / 标题子串，缺省或留空即取自身）让 AI 自己按需回溯，**也能取其它会话**（跨会话排查时在会话内直接看到对方上下文；命中多个候选会给出候选清单，不随便挑一个） | 每轮注入（`agent/pre-step`）+ AI 工具 `recall_memory` |
| 上下文用量自查 | AI 按需查自己会话的上下文占用（百分比、已用/容量 tokens）与构成（系统提示词/工具定义/消息文本），占用达 85% 时附收敛建议。数据与界面圆环同源（官方 `contextPressure` / `contextBreakdown` 投影），只读、无参数。**另：每轮把实时用量注入消息尾部**（AI 每轮都能直接看到数字；注入在尾部而非系统提示词前缀 ⇒ 前缀稳定、prompt cache 仍命中；按 turn 门控，一回合只注一次；配置 `injectContextUsage` 可关） | AI 工具 `context_usage` + 每轮注入 |
| 跨会话消息 | AI 直接给另一个会话发消息（不经过人转达）：先 `list_sessions` 挑目标，再 `send_to_session` 投递；目标空闲时**由本体自动唤醒**它跑一个回合，运行中则排到其下一回合边界（`mode:"steer"` 改为注入当前回合）。全部走本体官方 `prompt` API（幂等 `requestId`、不自己写会话日志）。**支持 `dryRun` 预览**（报告目标状态与限流余量，不投递、不消耗配额）。`list_sessions` 支持 **`query` 子串过滤 + `limit`/`offset` 分页**（默认只给 20 条，避免整表塞进调用方上下文）。**索引快路径 + 后台化**：`fromIndex=true` 直接读落盘索引（秒回、不重建，不含 live 状态与归档态），默认刷新路径先等 3 秒拿热缓存结果、超时就把**同一次在途构建**交给宿主后台 job 并立刻返回 jobId（冷缓存全量构建实测 226 秒 / 201 会话 / 1.5 GB 日志，热缓存 47 毫秒；job 注册失败会同步降级并带回原因）。硬约束：禁自投、协作链跳数 ≥3 拒绝、同一对会话 60s 内最多 5 条 | AI 工具 `list_sessions` / `send_to_session` |
| 指定模型新建会话 | AI 新建会话并可**直接指定 provider/model**（建完即切到该模型），可选带一条初始消息让它立刻开始干活。**缺省工作目录 = 调用方会话自己的 cwd**（不落在 DSH 安装目录里）。本体 `create` 本身不带模型，所以是 `create` → `selectModel` 两步；任一步失败会如实回执（如「会话已建，但模型未设置」），不谎报成功。**支持 `dryRun` 预览**（含模型是否存在于目录的核对），不建会话 | AI 工具 `create_session` |

## 界面预览

会话管理面板（侧边栏入口）：

![会话管理面板](assets/screenshots/panel.png)

设置页 · 模板注入（设置 → 会话管理）：

![模板注入设置](assets/screenshots/settings.png)

## 环境要求（支持的 DSH 版本）

| 项 | 要求 |
|---|---|
| **DSH 版本** | **0.2.1 及以上（推荐）**；0.2.x 早期版本功能可用，但**列表缓存不生效**（见下） |
| Node | 与宿主 DSH 自带的 Node 一致（无需额外安装） |
| 平台 | Linux（群晖 DSM / fnOS 等）；纯 Node 实现，无原生依赖 |

**为什么 0.2.1 是推荐下限**：本插件的会话列表缓存依赖 `sessionPersistence.list()` 返回的
**`SessionPersistenceSnapshot`**（`{ header, revision, eventCount?, sizeBytes? }`）里的 `revision`
作为「日志变过没有」的变更令牌。0.2.1 起该 API 稳定提供 `revision`；更早的版本里
`list()` 只给裸 header（没有 `revision`），插件会**优雅降级**：功能全部正常，
只是每次列表构建都要重新解析会话日志（会话多、日志大时会明显变慢、内存占用高）。

> 早期代码曾探测 `persistence.listSnapshots()` 并期望它返回 `{ header, revision }` ——
> 该 session 级方法**在任何 DSH 版本里都不存在**（0.1.6 里同名的 `listSnapshots(profileDir)`
> 是 profile 快照，另一套东西），所以那个探测永远失败、缓存从未生效过。
> 1.2.0 起统一改用 `list()` 并按快照解析。

## 安装

装到哪个 profile 由 `--profile` 指定。`dsh plugin` 会把后面的参数**转发给该 profile 目录下的 pnpm**，
因此第 2 步与「直接在该 profile 目录执行 pnpm」等价（该命令会初始化首次使用的 profile）。

1. **把插件源码放进 profile 的真实目录**（目录拷贝，不要软链）：
   ```
   <DSH_HOME>/profiles/<profile>/local-plugins/dsh-session-conductor/
   ```
2. **用 dsh 在该 profile 里装依赖**（写入 profile 的 `package.json` 与 `node_modules/`）：
   ```
   dsh plugin --profile <profile> add file:local-plugins/dsh-session-conductor
   dsh plugin --profile <profile> install
   ```
   装完 profile `package.json` 的 `dependencies` 里应出现
   `"dsh-session-conductor": "file:local-plugins/dsh-session-conductor"`。
3. **bundle 形态再补 loader 行**：把插件名加进 profile `package.json` 的 `dsh.profile.bundles`；
   插件自带的 `cordis.patch.yml` 必须用顶层 `- insert:` **新建** loader 行 —— 顶层 `- id:` 是"覆盖已有行"，
   基座没有该 id 时市场会报 `patch target not found`。
4. **装前预演、装后确认**：装前先 dry-run（确认插件入口能被 import、patch 能进组合树、不破坏现有插件组合）；
   装完重启宿主，并在实例日志里确认该插件 `loaded`。

> 为什么放在 profile 的 `local-plugins/` 而不是全局：插件与宿主版本强绑定，放在 profile 内可随实例
> 独立升级，也不会让多个 profile 互相污染。

### 从 GitHub 安装（可选）

本仓库是公开仓库，可直接用 GitHub 源安装。

⚠️ **`dsh plugin --profile <名> add …` 当前实测会挂死且零输出**（两次都以 timeout 结束、日志为空）⇒
安装请在**该 profile 目录里直跑 pnpm**（`dsh plugin` 的设计是把参数转发给 profile 的 pnpm，两者本应等价，
但转发这条路目前不可用）：

```bash
cd <DSH_HOME>/profiles/<profile>
pnpm add github:EIGHTfs/dsh-session-conductor#<commit>
# 等价写法：pnpm add git+https://github.com/EIGHTfs/dsh-session-conductor.git#<commit>
```

**前置条件**：

1. **本机要有 `npm`** —— pnpm 构建 git 来源的包时会在临时目录执行 `npm install`；
   缺 npm 时表现为 `ERR_PNPM_PREPARE_PACKAGE` + `spawn ENOENT: npm: command not found`。
2. **pnpm 11 默认禁止 git 源依赖执行构建脚本** —— 仅**带 `prepare`/`prepack` 的插件**需要放行
   （例：dsh-git-push 的 prepare 构建不入库的 `lib/client.js`）。**本仓库没有 prepare/prepack ⇒ 无需这一步**；
   若安装的是那类插件，先在 profile 的 `pnpm-workspace.yaml` 里加：

```yaml
allowBuilds:
  <包名>@https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>: true
```

   ⚠️ key 里带 commit 哈希 ⇒ 换版本/换提交要同步改这一行；否则报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。

- 用 `#<commit>` 固定版本（本仓库远端暂无 tag，写 `#v1.0.x` 会拉不到）；公开仓库匿名可装，私有仓库才需凭据。
- 装完同样要做上面的第 3、4 步（`dsh.profile.bundles` + `cordis.patch.yml` 的 `- insert:` + 重启确认 `loaded`）。

## 使用

### 会话管理面板

点击侧边栏底部「会话管理」按钮展开浮层面板：

- **全部**：列出每个会话（标题/目录/时间/状态），支持归档、删除、撤回、自动重命名/续跑开关、搜索、价值分析
- **已归档**：列出被归档的会话，可恢复（取消归档）、删除
- **活跃**：当前活跃（live/running）的会话
- **说明**：损坏修复（seq-gap / EIO / 双格式）+ 使用说明

### 设置页（设置 → 会话管理）

左侧栏「会话管理」独立页：

- **模板注入**：方案模板 / 收尾模板两个槽位。每个槽位下拉选导入方式：
  - **本地文件**：从设备选择上传（系统文件选择器）
  - **在线 md 网址**：输入网址，后端下载转存
  - **DSH 目录浏览**：路径选择悬浮窗（目录树 + 路径输入，点 .md 选中后导入）
  导入内容显示在编辑框（动态高度、自动换行），**可再次编辑并保存**；开启后注入系统提示词，AI 一开始就看见（方案/收尾各一条上下文注入）。
- **自动重命名模型**：选择标题分析用的模型（跟随会话模型或指定便宜/专用模型）

### 真实后端预览页

改 UI 后免重启查看效果 —— **预览能力已移出本插件**，统一用独立插件 `dsh-useful-tools` 的 `preview` / `minihost` 工具。

**最短三行（实测可用；本仓库没有 `assets/preview.spec.mjs` 也能出页面）**：

```
minihost { action: "start", plugin: "<插件根>", port: 31177 }   # ① 后端模拟
preview  { action: "gen",   plugin: "<插件根>" }                 # ② 前端预览页（无 spec 自动用默认垫片）
preview  { action: "serve", file: "<插件根>/assets/preview.html", backend: "http://127.0.0.1:31177" }  # ③ 前端接后端
```

**几个容易写错的点**：

- `gen` 默认产物是 `<插件根>/assets/preview.html`（会写进仓库）⇒ 不想入库就传 `out`（如 `out: "/tmp/sc-preview.html"`），并让 `serve` 的 `file` 指向同一路径。本仓库已把该产物加进 `.gitignore`。
- `serve` 默认端口 **31188**，显式传 `port` 才用你给的。
- `backend` 可指向 minihost 的端口（`/api/*` 反代到模拟后端），也可指向**真实 DSH 后端**。
- 显式传 `spec` 但文件不存在会**直接报错**（不静默降级）—— 故意的，避免指错文件还生成一个看不懂的页面。
- 停止：`minihost { action: "stop", port: 31177 }` + `preview { action: "stop", port: 31200 }`；状态：两者都用 `action: "status"`。
- **截图**（README 配图）改走 **browser 插件的 `browser_screenshot`**；「自包含快照」形态不做（理由见 `dsh-useful-tools` 的 `docs/NOT-DONE.md`）。

### 聊天框指令：`/model-switch`

在**用户聊天框**里直接看/切成员（子代理）的模型，不必求 AI。指令由插件注册到宿主的
`ctx.commands` 服务，**在插件加载时生效** —— 装好或更新后需重载一次实例，输入框里敲 `/model` 才有补全。

**① 看有哪些成员、各自在用什么**

```
/model-switch
```

```
成员模型（共 2 个）

· model-test(session-aaaa-1111) — 最近请求=wb/cn:deepseek-v4-flash
· writer(session-bbbb-2222) — 最近请求=n/deepseek-v4.1-flash

要查**实际**在用什么（含历史请求，不只本次进程）或切换：
  /model-switch <成员名或 sessionId>              ← 查实际模型
  /model-switch <成员名或 sessionId> <provider>/<模型>  ← 切换并回显查证
```

「最近请求」取自**进程内真实请求记录**（瞬时、不扫日志）；显示「未知」说明本进程还没见它请求过，用 ② 查历史。若同时显示目标与最近请求且不一致，会附 `⚠️ 与目标不一致（下一回合生效前属正常）`。

**② 查某个成员实际在用什么**

```
/model-switch writer
```

```
成员 writer(session-bbbb-2222)

实际请求使用：n/deepseek-v4.1-flash（2026/10/17 05:18:00）
最近切换意图：n/deepseek-v4.1-flash

切换：/model-switch writer <provider>/<模型>
```

判定只认**请求时真实使用**的模型（日志里 `request/header` 的 `data.header.config.{provider,model}`），不拿「切换意图」当结论 —— 实测出现过「提示是 agni、请求头仍是 wb」的不一致。日志尚无记录时会回退显示「本次进程内观察到的最近请求」，而不是武断地说没有。

**③ 切换，并回显查证结果**

```
/model-switch writer n/deepseek-v4.1-flash
```

```
已把成员 writer(session-bbbb-2222) 切到 n/deepseek-v4.1-flash
生效方式：model/selection 事件（官方投影接管）…
最近一次实际请求：wb/cn:deepseek-v4-flash（2026/10/17 05:18:00）
判定：⏳ 待下一回合生效（最近一次请求是切换前发出的，属正常）
确认结果会在该成员下次发起请求时注入回发起方（事件驱动，不阻塞）。
```

看到 **⏳ 不代表失败**：切换本就下一回合生效（当前那次请求早已发出）。该成员下次请求时插件按事件判定，并把 `【切换查证】✅ 已确认生效：…`（或 `❌ 未生效：期望 X，实际 Y` —— 不假装成功）注入回发起方。定位可用**成员名**或 **sessionId**（名字支持唯一子串，重名会要求写全）；模型必须写成 `provider/model`，写错会直接给正确格式。

## API

插件以 `/api/session-conductor/*` 前缀注册宿主路由：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/list` | GET | 会话列表（标题/目录/时间/状态，落盘缓存按 revision 增量）。**`?fromIndex=true`**：与工具 `list_sessions` 的 `fromIndex` 同义 —— 直接读落盘索引、**不做全量构建**，秒回精简列表（`{ok, fromIndex, sessions, hint}`，不含 live 状态与归档态）。加 `?job=1` 或请求头 `Accept: application/x-job` 改为注册宿主后台 job 并即刻返回 jobId（构建慢时不阻塞请求）；**HTTP 入口没有执行主体**，宿主 job 控制器可能拒绝无主注册（实测回 `no job controller serves this agent`）—— 此时**不再直接 501**，而是回退为落盘索引快照（`async:false` + `fromIndex:true` + `jobUnavailable` 原因），索引也没有才如实 501 |
| `/archive` / `/restore` | POST | 归档 / 恢复会话 |
| `/delete` | POST | 删除会话（拒绝运行中） |
| `/undo` | POST | 撤回最后一条消息 |
| `/auto-rename` | POST | 自动重命名开关 |
| `/auto-continue` | POST | 自动续跑开关 |
| `/auto-continue-gate` | GET/POST | 全局续跑闸门 |
| `/release` | POST | 释放空闲会话 |
| `/value-analysis` | POST | 价值分析 |
| `/repair` / `/repair-eio` / `/repair-dual` | POST | 三类损坏修复 |
| `/search` | GET | 全文搜索 |
| `/compaction-model` | GET/POST | 压缩模型 |
| `/templates` | GET/POST | 模板注入（slots 元信息 + 内容） |
| `/templates/dir` | GET | 目录浏览 |
| `/auto-rename-model` | GET | 自动重命名模型（透传官方 modelCatalog） |
| `/i18n` | GET | 语言包（zh/en 外置 JSON） |

示例：

```bash
curl http://<host>/api/session-conductor/list
# → { "ok": true, "sessions": [ { "id": "...", "title": "...", "cwd": "...", "updatedAt": 172... } ], "total": N }
```

```bash
curl -X POST http://<host>/api/session-conductor/archive \
  -H "Content-Type: application/json" -d '{"id":"<sessionId>"}'
# → { "ok": true, "archived": true }
```

## 文档索引

> 文件目录结构、版本列表、函数列表由 dsh-git-push 的 doc-tree / doc-version / doc-func 工具维护（独立 md，README 只引用）：

- [文件目录结构](docs/FILE-TREE.md) — 目录树与文件作用（doc-tree 维护，`tree-doc.json` 注释映射）
- [版本列表](docs/VERSIONS.md) — 按 git 提交聚合的版本记录表（doc-version 维护）
- [函数列表](docs/FUNCTIONS.md) — lib/ 全部导出函数的名称/位置/签名（doc-func 维护）