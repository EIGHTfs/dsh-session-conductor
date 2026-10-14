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
| 损坏修复 | seq-gap / EIO 坏块 / 双格式（jsonl+zstd 并存）三类会话日志修复 | 面板「说明」页按钮 |
| 价值分析 | LLM 按规则给会话分类（已完成/未完成/久未活跃/活跃中） | 面板按钮 |
| 全文搜索 | 官方 FTS5 优先 + 内置 zstd 扫描兜底 | 面板搜索框 |
| 压缩模型选择 | 上下文自动压缩用模型独立选择（省成本） | 设置 → 插件 → 压缩模型 |
| 模板注入 | 方案模板 / 收尾模板：本地设备上传 / 在线网址 / DSH 目录浏览三种导入，内容可再编辑，注入系统提示词（方案/收尾各一条上下文注入） | 设置 → 会话管理 → 模板注入 |
| 自动重命名模型 | 指定便宜/专用模型做标题分析 | 设置 → 会话管理 |
| 成员模型切换 | 给队友/子代理单独切模型（只动该成员会话，不影响其他成员）：先用 `list_models` 拿确切模型 id，再 `set_member_model` 按成员名/sessionId 切换（写 `model/selection` 事件交给官方投影接管，跨轮持久；未挂载成员也能切，运行中会先等它暂停） | AI 工具 `list_models` / `set_member_model` |
| 上下文用量自查 | AI 按需查自己会话的上下文占用（百分比、已用/容量 tokens）与构成（系统提示词/工具定义/对话消息），占用达 85% 时附收敛建议。数据与界面圆环同源（官方 `contextPressure` / `contextBreakdown` 投影），只读、无参数 | AI 工具 `context_usage` |
| 跨会话消息 | AI 直接给另一个会话发消息（不经过人转达）：先 `list_sessions` 挑目标，再 `send_to_session` 投递；目标空闲时**由本体自动唤醒**它跑一个回合，运行中则排到其下一回合边界（`mode:"steer"` 改为注入当前回合）。全部走本体官方 `prompt` API（幂等 `requestId`、不自己写会话日志）。硬约束：禁自投、协作链跳数 ≥3 拒绝、同一对会话 60s 内最多 5 条 | AI 工具 `list_sessions` / `send_to_session` |
| 指定模型新建会话 | AI 新建会话并可**直接指定 provider/model**（建完即切到该模型），可选带一条初始消息让它立刻开始干活。本体 `create` 本身不带模型，所以是 `create` → `selectModel` 两步；任一步失败会如实回执（如「会话已建，但模型未设置」），不谎报成功 | AI 工具 `create_session` |

## 界面预览

会话管理面板（侧边栏入口）：

![会话管理面板](assets/screenshots/panel.png)

设置页 · 模板注入（设置 → 会话管理）：

![模板注入设置](assets/screenshots/settings.png)

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

改 UI 后免重启查看效果：

- **快照模式（推荐，免重启）**：`bash tools/preview-snapshot.sh` → 生成 `assets/preview-*.html`（内嵌生成时真实后端响应），file:// 打开即可查看，无 CORS、无假数据
- **DSH 同源路由**：重启后访问 `/api/session-conductor/preview/settings`（或 `/panel`），同源实时 fetch

## API

插件以 `/api/session-conductor/*` 前缀注册宿主路由：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/list` | GET | 会话列表（标题/目录/时间/状态，落盘缓存按 revision 增量） |
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
| `/preview/settings` `/preview/panel` | GET | 真实后端预览页（同源服务） |

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