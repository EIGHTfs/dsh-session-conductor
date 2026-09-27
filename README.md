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

## 安装（三步曲）

1. **源码进 profile 真实目录**（禁止软链）：
   - `profiles/web/local-plugins/<name>/`
   - `profiles/web/node_modules/<name>/`
2. **profile `package.json` 声明** `"dsh-session-conductor": "file:node_modules/dsh-session-conductor"`，必要时 `dsh.profile.bundles`。
3. **bundle `cordis.patch.yml` 顶层 `- insert:`** 新建 loader 行（`dsh-bundle-patch-must-insert`）。

安装前先 dryrun 模拟（`install-plugin-dryrun-first`），安装后重启 DSH 生效。

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

## 文件目录结构（由 dsh-git-push doc-tree 维护）

<!-- dshgp-tree:start -->
```text
dsh-session-conductor/
├── lib/ — 宿主侧实现
│   ├── core.js — 会话核心逻辑（列表/归档/删除/撤回/续跑等）
│   ├── eio-repair.js — EIO 坏块会话修复
│   ├── group.js — 会话分组（workspace 映射）
│   ├── index.js — 宿主入口（API / 注入 / 设置命名空间）
│   ├── repair.js — 损坏会话修复（seq-gap 主流程）
│   ├── seq-gap-repair.js — seq-gap 损坏修复
│   ├── session-codec.js — 会话 v3 格式编解码
│   ├── template-inject.js — 模板注入（方案/收尾槽位读写、注入文本拼接）
│   ├── value.js — 价值分析（LLM 分类）
│   ├── zstd-frames.js — zstd 帧解析/校验
│   ├── client-parts/ — 浏览器侧分片源（build.cjs 拼接）
│   │   ├── apply.js — 主插件 apply 收尾（settings.section / sidebar.footer.action 注册）
│   │   └── …（11 个更深文件）
│   ├── i18n/ — 语言包（zh/en 外置）
│   │   ├── en.json — 英文语言包
│   │   ├── zh.json — 中文语言包
├── assets/ — 预览页与界面产物
│   ├── preview-panel.html — 真实后端预览页（面板区块，preview-snapshot.sh 生成）
│   ├── preview-settings.html — 真实后端预览页（设置区块，preview-snapshot.sh 生成）
├── test/ — 测试
│   ├── e2e/ — 端到端测试脚本
│   │   ├── e2e-crash-continue.sh — 崩溃续跑 e2e
│   │   ├── e2e-detach.sh — detach e2e
│   ├── unit/ — 单元测试（真模块 import + 独立 DSH_HOME）
│   │   ├── test-archive-ws-prefix.mjs — 归档工作区前缀单测
│   │   ├── test-auto-continue.mjs — 自动续跑单测
│   │   ├── test-auto-rename.mjs — 自动重命名单测
│   │   ├── test-delete-session.mjs — 删除会话单测
│   │   ├── test-detach.mjs — detach 单测
│   │   ├── test-group.mjs — 分组单测
│   │   ├── test-interruption.mjs — 中断检测单测
│   │   ├── test-list-cache.mjs — 列表缓存单测
│   │   ├── test-repair.mjs — 修复单测
│   │   ├── test-search-delete.mjs — 搜索删除单测
│   │   ├── test-template-inject.mjs — 模板注入单测
│   │   ├── test-value-real.mjs — 价值分析（真实模型）单测
│   │   ├── test-value.mjs — 价值分析单测
│   │   ├── test-zstd-frames.mjs — zstd 帧单测
├── skills/ — 插件技能文档（权威 skill）
│   ├── dsh-session-conductor-functions.md — 功能说明书（每个功能用途/参数/返回）
│   ├── dsh-session-conductor.md — 使用手册
│   ├── dsh-session-official-doc.md — DSH 官方会话机制对照
│   ├── task-completion-report.md — 任务收尾汇报约定
├── tools/ — 开发/维护工具
│   ├── ac-confirm.sh — 自动续跑确认脚本
│   ├── check-import-refs.mjs — import/导出引用检查
│   ├── classify.mjs — 价值分析分类脚本
│   ├── detect-registered-tools.mjs — 检测插件注册的 agent 工具
│   ├── fix-tool-result-content.py — 修复 tool-result 内容格式
│   ├── gen-fallback.mjs — fallback 内嵌行生成（i18n.js）
│   ├── preview-snapshot.sh — 快照版预览生成（自包含，抓真实后端内嵌）
│   ├── validate-session.mjs — 会话文件校验
│   ├── archived/ — 已删功能的归档脚本
│   │   ├── keyword-inject.js — 已删关键字注入功能归档
│   ├── vendor/ — 自备工具副本（预览生成器 + react-umd）
│   │   ├── frontend-real-render-preview.mjs — （待注释）
│   │   └── …（2 个更深文件）
├── .auditignore — 审计豁免清单
├── .gitignore — 忽略列表（生成物 client.js/tmp-snapshot/截图 不入库）
├── README.md — 项目说明（文件树/版本/函数列表由 git-push doc-* 工具维护）
├── build.cjs — 浏览器侧分片拼接构建（--check 一致性比对）
├── cordis.patch.yml — bundle patch（顶层 insert loader 行）
├── package.json — npm 规范清单（1.0.0）
├── tree-doc.json — 文件树注释映射（doc-tree 维护）
```
<!-- dshgp-tree:end -->

> `lib/client.js` 与 `tmp-snapshot/` 为构建/生成产物，不入库（见 .gitignore）；部署副本由实例同步或 build.cjs 生成。

## 版本列表（由 dsh-git-push doc-version 维护）

<!-- dshgp-version:start -->
## 版本列表

| 版本 | 内容 |
|------|------|
| 1.0.0 | dsh-session-conductor 初始版本——会话管理增强插件（面板四视图/归档恢复/批量与条件删除/AI 自动重命名/中断自动续跑/按工作区分组/撤回消息/三类损坏修复/价值分析/全文搜索/压缩模型/模板注入/自动重命名模型），中英双语 i18n 外置，真实后端预览页（快照免重启+同源路由），全部历史整理为一次提交 |

<!-- dshgp-version:end -->

## 函数列表（由 dsh-git-push doc-func 维护）

<!-- dshgp-functions:start -->
## 函数列表

### lib/client-parts/apply.js（44 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `apply` | 1-25 | 25 | `function apply(ctx) {` |

### lib/client-parts/components/compaction.js（121 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `CompactionModelCard` | 32-90 | 59 | `function CompactionModelCard({ t }) {` |
| `save` | 53-68 | 16 | `const save = async () => {` |
| `apply` | 92-105 | 14 | `function apply(ctx) {` |

### lib/client-parts/components/conductor-settings.js（63 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `ScsPage` | 37-49 | 13 | `function ScsPage({ t }) {` |
| `apply` | 51-55 | 5 | `function apply(ctx) {` |

### lib/client-parts/components/group.js（116 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `SessionGroupCard` | 39-82 | 44 | `function SessionGroupCard({ t }) {` |
| `load` | 43-47 | 5 | `const load = () => {` |
| `createIn` | 49-65 | 17 | `const createIn = async (workspaceId) => {` |
| `apply` | 84-97 | 14 | `function apply(ctx) {` |

### lib/client-parts/components/panel.js（1247 行 · 25 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `SessionManagerPanel` | 1-1245 | 1245 | `function SessionManagerPanel({ wide, t, onOpenSession }) {` |
| `insertSorted` | 24-30 | 7 | `const insertSorted = (cur, item) => {` |
| `act` | 88-118 | 31 | `const act = async (sessionId, action) => {` |
| `confirmDelete` | 120-124 | 5 | `const confirmDelete = (session) => {` |
| `undoLast` | 127-155 | 29 | `const undoLast = async (session) => {` |
| `toggleAutoRename` | 158-179 | 22 | `const toggleAutoRename = async (sessionId, enabled) => {` |
| `analyzeNow` | 181-203 | 23 | `const analyzeNow = async (sessionId) => {` |
| `scanAndRepair` | 206-238 | 33 | `const scanAndRepair = async () => {` |
| `scanAndRepairEio` | 245-277 | 33 | `const scanAndRepairEio = async () => {` |
| `scanAndRepairDual` | 284-316 | 33 | `const scanAndRepairDual = async () => {` |
| `toggleAutoContinue` | 319-335 | 17 | `const toggleAutoContinue = async (sessionId, enabled) => {` |
| `releaseNow` | 337-356 | 20 | `const releaseNow = async (sessionId) => {` |
| `releaseAll` | 358-383 | 26 | `const releaseAll = async () => {` |
| `continueNow` | 385-409 | 25 | `const continueNow = async (sessionId) => {` |
| `runFullSearch` | 412-452 | 41 | `const runFullSearch = async (keyword) => {` |
| `deleteSelected` | 455-479 | 25 | `const deleteSelected = async () => {` |
| `previewLocally` | 484-513 | 30 | `const previewLocally = () => {` |
| `previewRuleDelete` | 515-553 | 39 | `const previewRuleDelete = async () => {` |
| `runRuleDelete` | 555-592 | 38 | `const runRuleDelete = async () => {` |
| `matchesQuery` | 597-606 | 10 | `const matchesQuery = (row) => {` |
| `groupByWorkspace` | 617-638 | 22 | `const groupByWorkspace = (list) => {` |
| `norm` | 619-619 | 1 | `const norm = (p) => String(p ?? "").replace(/\/+$/, "");` |
| `groupByArchiveWs` | 642-657 | 16 | `const groupByArchiveWs = (list) => {` |
| `toggleCollapse` | 661-668 | 8 | `const toggleCollapse = (key) => {` |
| `renderRow` | 670-850 | 181 | `const renderRow = (session) => {` |

### lib/client-parts/components/processing.js（94 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `activeUserText` | 34-49 | 16 | `function activeUserText(nodes) {` |
| `ProcessingBar` | 51-70 | 20 | `function ProcessingBar({ useSession, t }) {` |
| `apply` | 72-80 | 9 | `function apply(ctx) {` |

### lib/client-parts/components/session-icon.js（14 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `SessionIcon` | 1-12 | 12 | `function SessionIcon(props) {` |

### lib/client-parts/components/settings.js（416 行 · 21 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `ensureSettingsCss` | 45-53 | 9 | `function ensureSettingsCss() {` |
| `trSettings` | 55-58 | 4 | `function trSettings(key) {` |
| `TemplateSlotCard` | 61-94 | 34 | `function TemplateSlotCard(props) {` |
| `TemplatePickerModal` | 97-128 | 32 | `function TemplatePickerModal(props) {` |
| `useTemplateFetch` | 136-158 | 23 | `function useTemplateFetch(st) {` |
| `useTemplateImports` | 161-210 | 50 | `function useTemplateImports(st, post) {` |
| `slotLabel` | 162-162 | 1 | `const slotLabel = (slot) => (slot === "plan" ? __SC_TR__("tpl.planShort") : __SC_TR__("tpl.closingShort"));` |
| `onPickFile` | 163-173 | 11 | `const onPickFile = (slot, event) => {` |
| `openImport` | 174-192 | 19 | `const openImport = (slot) => {` |
| `browseDir` | 193-201 | 9 | `const browseDir = (path) => {` |
| `importTemplate` | 202-208 | 7 | `const importTemplate = (slot, mode, value) => {` |
| `useTemplateMutations` | 213-251 | 39 | `function useTemplateMutations(st, post, slotLabel) {` |
| `toggle` | 214-220 | 7 | `const toggle = (slot, enabled) => {` |
| `toggleEnforce` | 221-227 | 7 | `const toggleEnforce = (enforce) => {` |
| `onEdit` | 228-233 | 6 | `const onEdit = (slot, el) => {` |
| `saveEdit` | 234-242 | 9 | `const saveEdit = (slot) => {` |
| `onRemove` | 243-249 | 7 | `const onRemove = (slot) => {` |
| `MainTemplateSection` | 253-294 | 42 | `function MainTemplateSection() {` |
| `AutoRenameModelSection` | 301-379 | 79 | `function AutoRenameModelSection() {` |
| `save` | 326-346 | 21 | `const save = async (next) => {` |
| `ConductorSettingsPage` | 400-414 | 15 | `function ConductorSettingsPage() {` |

### lib/client-parts/foundation/bootstrap.js（41 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `basenameOf` | 18-23 | 6 | `function basenameOf(p) {` |
| `timeAgo` | 25-39 | 15 | `function timeAgo(ms, t) {` |

### lib/client-parts/foundation/i18n.js（75 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `fill` | 40-43 | 4 | `const fill = () => {` |

### lib/client-parts/foundation/list-cache.js（21 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `readListCache` | 2-11 | 10 | `function readListCache() {` |
| `writeListCache` | 12-18 | 7 | `function writeListCache(sessions) {` |

### lib/client.js（2425 行 · 65 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `fill` | 40-43 | 4 | `const fill = () => {` |
| `basenameOf` | 92-97 | 6 | `function basenameOf(p) {` |
| `timeAgo` | 99-113 | 15 | `function timeAgo(ms, t) {` |
| `readListCache` | 299-308 | 10 | `function readListCache() {` |
| `writeListCache` | 309-315 | 7 | `function writeListCache(sessions) {` |
| `SessionIcon` | 318-329 | 12 | `function SessionIcon(props) {` |
| `SessionManagerPanel` | 331-1575 | 1245 | `function SessionManagerPanel({ wide, t, onOpenSession }) {` |
| `insertSorted` | 354-360 | 7 | `const insertSorted = (cur, item) => {` |
| `act` | 418-448 | 31 | `const act = async (sessionId, action) => {` |
| `confirmDelete` | 450-454 | 5 | `const confirmDelete = (session) => {` |
| `undoLast` | 457-485 | 29 | `const undoLast = async (session) => {` |
| `toggleAutoRename` | 488-509 | 22 | `const toggleAutoRename = async (sessionId, enabled) => {` |
| `analyzeNow` | 511-533 | 23 | `const analyzeNow = async (sessionId) => {` |
| `scanAndRepair` | 536-568 | 33 | `const scanAndRepair = async () => {` |
| `scanAndRepairEio` | 575-607 | 33 | `const scanAndRepairEio = async () => {` |
| `scanAndRepairDual` | 614-646 | 33 | `const scanAndRepairDual = async () => {` |
| `toggleAutoContinue` | 649-665 | 17 | `const toggleAutoContinue = async (sessionId, enabled) => {` |
| `releaseNow` | 667-686 | 20 | `const releaseNow = async (sessionId) => {` |
| `releaseAll` | 688-713 | 26 | `const releaseAll = async () => {` |
| `continueNow` | 715-739 | 25 | `const continueNow = async (sessionId) => {` |
| `runFullSearch` | 742-782 | 41 | `const runFullSearch = async (keyword) => {` |
| `deleteSelected` | 785-809 | 25 | `const deleteSelected = async () => {` |
| `previewLocally` | 814-843 | 30 | `const previewLocally = () => {` |
| `previewRuleDelete` | 845-883 | 39 | `const previewRuleDelete = async () => {` |
| `runRuleDelete` | 885-922 | 38 | `const runRuleDelete = async () => {` |
| `matchesQuery` | 927-936 | 10 | `const matchesQuery = (row) => {` |
| `groupByWorkspace` | 947-968 | 22 | `const groupByWorkspace = (list) => {` |
| `norm` | 949-949 | 1 | `const norm = (p) => String(p ?? "").replace(/\/+$/, "");` |
| `groupByArchiveWs` | 972-987 | 16 | `const groupByArchiveWs = (list) => {` |
| `toggleCollapse` | 991-998 | 8 | `const toggleCollapse = (key) => {` |
| `renderRow` | 1000-1180 | 181 | `const renderRow = (session) => {` |
| `ensureSettingsCss` | 1621-1629 | 9 | `function ensureSettingsCss() {` |
| `trSettings` | 1631-1634 | 4 | `function trSettings(key) {` |
| `TemplateSlotCard` | 1637-1670 | 34 | `function TemplateSlotCard(props) {` |
| `TemplatePickerModal` | 1673-1704 | 32 | `function TemplatePickerModal(props) {` |
| `useTemplateFetch` | 1712-1734 | 23 | `function useTemplateFetch(st) {` |
| `useTemplateImports` | 1737-1786 | 50 | `function useTemplateImports(st, post) {` |
| `slotLabel` | 1738-1738 | 1 | `const slotLabel = (slot) => (slot === "plan" ? __SC_TR__("tpl.planShort") : __SC_TR__("tpl.closingShort"));` |
| `onPickFile` | 1739-1749 | 11 | `const onPickFile = (slot, event) => {` |
| `openImport` | 1750-1768 | 19 | `const openImport = (slot) => {` |
| `browseDir` | 1769-1777 | 9 | `const browseDir = (path) => {` |
| `importTemplate` | 1778-1784 | 7 | `const importTemplate = (slot, mode, value) => {` |
| `useTemplateMutations` | 1789-1827 | 39 | `function useTemplateMutations(st, post, slotLabel) {` |
| `toggle` | 1790-1796 | 7 | `const toggle = (slot, enabled) => {` |
| `toggleEnforce` | 1797-1803 | 7 | `const toggleEnforce = (enforce) => {` |
| `onEdit` | 1804-1809 | 6 | `const onEdit = (slot, el) => {` |
| `saveEdit` | 1810-1818 | 9 | `const saveEdit = (slot) => {` |
| `onRemove` | 1819-1825 | 7 | `const onRemove = (slot) => {` |
| `MainTemplateSection` | 1829-1870 | 42 | `function MainTemplateSection() {` |
| `AutoRenameModelSection` | 1877-1955 | 79 | `function AutoRenameModelSection() {` |
| `save` | 1902-1922 | 21 | `const save = async (next) => {` |
| `ConductorSettingsPage` | 1976-1990 | 15 | `function ConductorSettingsPage() {` |
| `apply` | 1992-2016 | 25 | `function apply(ctx) {` |
| `SessionGroupCard` | 2073-2116 | 44 | `function SessionGroupCard({ t }) {` |
| `load` | 2077-2081 | 5 | `const load = () => {` |
| `createIn` | 2083-2099 | 17 | `const createIn = async (workspaceId) => {` |
| `apply` | 2118-2131 | 14 | `function apply(ctx) {` |
| `activeUserText` | 2183-2198 | 16 | `function activeUserText(nodes) {` |
| `ProcessingBar` | 2200-2219 | 20 | `function ProcessingBar({ useSession, t }) {` |
| `apply` | 2221-2229 | 9 | `function apply(ctx) {` |
| `CompactionModelCard` | 2274-2332 | 59 | `function CompactionModelCard({ t }) {` |
| `save` | 2295-2310 | 16 | `const save = async () => {` |
| `apply` | 2334-2347 | 14 | `function apply(ctx) {` |
| `ScsPage` | 2399-2411 | 13 | `function ScsPage({ t }) {` |
| `apply` | 2413-2417 | 5 | `function apply(ctx) {` |

### lib/core.js（83 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `renderCompletionBlock` | 24-48 | 25 | `export function renderCompletionBlock(options = {}) {` |
| `checkCompletionText` | 56-78 | 23 | `export function checkCompletionText(text) {` |
| `hasText` | 80-82 | 3 | `function hasText(value) {` |

### lib/eio-repair.js（203 行 · 6 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `probeEioBoundary` | 38-61 | 24 | `export async function probeEioBoundary(filePath) {` |
| `scanEioSessions` | 69-98 | 30 | `export async function scanEioSessions(sessionsRoot, { fast = false } = {}) {` |
| `repairEioFile` | 107-157 | 51 | `export async function repairEioFile(filePath, { dryRun = false, backupDir } = {}) {` |
| `repairEioSessions` | 160-188 | 29 | `export async function repairEioSessions({ dryRun = false, fast = false } = {}) {` |
| `writeAll` | 191-198 | 8 | `function writeAll(fd, buffer) {` |
| `sessionsRootOf` | 201-203 | 3 | `export function sessionsRootOf() {` |

### lib/group.js（277 行 · 9 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `tryEnableAutoRename` | 40-45 | 6 | `function tryEnableAutoRename(hooks, sessionId) {` |
| `detectProfileName` | 47-55 | 9 | `function detectProfileName() {` |
| `detectHostPort` | 59-66 | 8 | `function detectHostPort() {` |
| `send` | 70-73 | 4 | `function send(res, code, obj) {` |
| `readJsonBody` | 75-86 | 12 | `async function readJsonBody(req, maxBytes = 1 << 20) {` |
| `wsView` | 88-97 | 10 | `function wsView(w) {` |
| `workspaceIdOfCwd` | 100-109 | 10 | `function workspaceIdOfCwd(registry, cwd) {` |
| `lastSessionCwd` | 112-136 | 25 | `async function lastSessionCwd(ctx) {` |
| `registerGroupRoutes` | 148-273 | 126 | `export async function registerGroupRoutes(ctx, config = {}, hooks = {}) {` |

### lib/index.js（3850 行 · 93 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `collectSessionTitleMessages` | 77-92 | 16 | `function collectSessionTitleMessages(events, throughSeq) {` |
| `hasApiRemoteSubagentOwner` | 96-108 | 13 | `function hasApiRemoteSubagentOwner(ctx, session, agent) {` |
| `resolveSessionPreset` | 112-120 | 9 | `function resolveSessionPreset({ header, events } = {}) {` |
| `lazyRepair` | 127-127 | 1 | `const lazyRepair = () => (_lazyRepair ??= import("./repair.js"));` |
| `lazyZstd` | 128-128 | 1 | `const lazyZstd = () => (_lazyZstd ??= import("./zstd-frames.js"));` |
| `lazySeqGap` | 129-129 | 1 | `const lazySeqGap = () => (_lazySeqGap ??= import("./seq-gap-repair.js"));` |
| `lazyEio` | 130-130 | 1 | `const lazyEio = () => (_lazyEio ??= import("./eio-repair.js"));` |
| `lazyValue` | 131-131 | 1 | `const lazyValue = () => (_lazyValue ??= import("./value.js"));` |
| `num` | 172-174 | 3 | `function num(v, min, max, dflt) {` |
| `send` | 261-264 | 4 | `function send(res, status, body) {` |
| `readJson` | 267-272 | 6 | `async function readJson(req) {` |
| `foldTitle` | 276-285 | 10 | `function foldTitle(events) {` |
| `workspaceNameOf` | 292-309 | 18 | `function workspaceNameOf(ctx, cwd) {` |
| `archiveTitleWithWs` | 312-318 | 7 | `function archiveTitleWithWs(title, ws) {` |
| `stripArchiveWsPrefix` | 321-326 | 6 | `function stripArchiveWsPrefix(title) {` |
| `hasOpenTurn` | 329-337 | 9 | `function hasOpenTurn(events) {` |
| `lastEventTime` | 340-343 | 4 | `function lastEventTime(events) {` |
| `titleString` | 349-353 | 5 | `function titleString(snapshot) {` |
| `sessionEventList` | 356-365 | 10 | `function sessionEventList(session) {` |
| `resolveSessionTitle` | 368-378 | 11 | `function resolveSessionTitle(sessionTitle, session, events) {` |
| `pluginDomain` | 388-416 | 29 | `function pluginDomain(ctx) {` |
| `pluginState` | 418-421 | 4 | `async function pluginState(ctx) {` |
| `installProcessGuards` | 431-445 | 15 | `function installProcessGuards(ctx) {` |
| `pluginConfigPath` | 457-460 | 4 | `function pluginConfigPath(ctx) {` |
| `readSwitch` | 463-466 | 4 | `function readSwitch(group, sessionId) {` |
| `patchSwitch` | 470-478 | 9 | `export async function patchSwitch(ctx, group, sessionId, patch, defaultEntry = {}) {` |
| `loadPluginConfig` | 481-495 | 15 | `export async function loadPluginConfig(ctx) {` |
| `savePluginConfig` | 498-514 | 17 | `export async function savePluginConfig(ctx) {` |
| `resetAutoContinueOnStart` | 517-525 | 9 | `export async function resetAutoContinueOnStart(ctx) {` |
| `autoRenameEnabled` | 528-530 | 3 | `function autoRenameEnabled(ctx, state, sessionId) {` |
| `effectiveAutoContinue` | 533-536 | 4 | `function effectiveAutoContinue(cfg, state, sessionId) {` |
| `scheduleAnalysis` | 544-555 | 12 | `function scheduleAnalysis(ctx, sessionId) {` |
| `runAnalysis` | 558-568 | 11 | `async function runAnalysis(ctx, sessionId, opts = {}) {` |
| `resolveModelOverride` | 575-600 | 26 | `export async function resolveModelOverride(ctx, modelArg, fallbackRoute) {` |
| `analyzeSession` | 609-687 | 79 | `async function analyzeSession(ctx, sessionId, opts = {}) {` |
| `resolveRoute` | 694-705 | 12 | `export function resolveRoute(session, llm, state) {` |
| `driftAnalysisLlm` | 721-778 | 58 | `export async function driftAnalysisLlm(llm, session, route, currentTitle, recent, onError, forceTitle = false) {` |
| `extractTitleOnly` | 781-794 | 14 | `function extractTitleOnly(raw) {` |
| `analyzeValueWithLlm` | 807-846 | 40 | `export async function analyzeValueWithLlm(ctx, sessions, texts, onError) {` |
| `parseValueJson` | 849-860 | 12 | `export function parseValueJson(raw) {` |
| `parseDriftJson` | 864-878 | 15 | `export function parseDriftJson(raw) {` |
| `interruptionInfo` | 887-926 | 40 | `export function interruptionInfo(events) {` |
| `isAutoEligible` | 940-946 | 7 | `export function isAutoEligible(info, { live = false } = {}) {` |
| `stateSuffixOf` | 953-958 | 6 | `export function stateSuffixOf(events) {` |
| `stripTitleStateSuffix` | 961-963 | 3 | `export function stripTitleStateSuffix(title) {` |
| `refreshTitleState` | 971-989 | 19 | `export async function refreshTitleState(ctx, session) {` |
| `autoContinueEffectiveForRun` | 1002-1005 | 4 | `export function autoContinueEffectiveForRun(cfg, state, sessionId) {` |
| `continueAllowed` | 1008-1021 | 14 | `function continueAllowed(cfg, state, sessionId, info) {` |
| `sessionEventsOf` | 1024-1034 | 11 | `async function sessionEventsOf(ctx, sessionId) {` |
| `readColdSessionEvents` | 1044-1057 | 14 | `async function readColdSessionEvents(ctx, sessionId) {` |
| `foldLastRoute` | 1060-1078 | 19 | `export function foldLastRoute(events) {` |
| `buildContinuePrompt` | 1081-1095 | 15 | `export function buildContinuePrompt(info) {` |
| `withDeleteLock` | 1106-1116 | 11 | `function withDeleteLock(sessionId, fn) {` |
| `cancelSessionTimers` | 1119-1131 | 13 | `function cancelSessionTimers(sessionId) {` |
| `withSessionLock` | 1134-1144 | 11 | `function withSessionLock(sessionId, fn) {` |
| `withConcurrencyGate` | 1147-1157 | 11 | `async function withConcurrencyGate(fn) {` |
| `continueSession` | 1166-1283 | 118 | `export async function continueSession(ctx, sessionId, { auto = false } = {}) {` |
| `waitTurn` | 1286-1305 | 20 | `async function waitTurn(ctx, agent) {` |
| `sendMessageToSession` | 1319-1371 | 53 | `export async function sendMessageToSession(ctx, sessionId, text, { fromSessionId = "" } = {}) {` |
| `defaultModelSelection` | 1374-1382 | 9 | `function defaultModelSelection(ctx) {` |
| `resumeSetupFor` | 1385-1413 | 29 | `async function resumeSetupFor(ctx, meta, events, route) {` |
| `maybeScheduleContinue` | 1416-1428 | 13 | `function maybeScheduleContinue(ctx, sessionId) {` |
| `runAutoContinueSession` | 1435-1459 | 25 | `async function runAutoContinueSession(ctx, sessionId, { force = false } = {}) {` |
| `runAutoScan` | 1462-1508 | 47 | `async function runAutoScan(ctx) {` |
| `scheduleScan` | 1510-1520 | 11 | `function scheduleScan(ctx) {` |
| `detachSessionAgent` | 1532-1598 | 67 | `export async function detachSessionAgent(ctx, sessionId) {` |
| `detachAllIdleSessions` | 1601-1626 | 26 | `export async function detachAllIdleSessions(ctx) {` |
| `listCacheFilePath` | 1656-1661 | 6 | `function listCacheFilePath(ctx) {` |
| `loadListDiskCache` | 1664-1678 | 15 | `function loadListDiskCache(ctx) {` |
| `scheduleSaveListDiskCache` | 1681-1689 | 9 | `function scheduleSaveListDiskCache(ctx) {` |
| `saveListDiskCacheNow` | 1692-1706 | 15 | `function saveListDiskCacheNow(ctx) {` |
| `buildColdSessionItem` | 1710-1733 | 24 | `function buildColdSessionItem(header, inspected, derived, ctx, storeState, archived) {` |
| `invalidateSessionListCache` | 1750-1753 | 4 | `function invalidateSessionListCache() {` |
| `buildSessionListCached` | 1760-1778 | 19 | `async function buildSessionListCached(ctx, { force = false, onItem = null, serial = false } = {}) {` |
| `buildSessionList` | 1784-1928 | 145 | `async function buildSessionList(ctx, opts = {}) { // dsh-skip-func-length` |
| `unarchiveSession` | 1937-1946 | 10 | `async function unarchiveSession(ctx, sessionId) {` |
| `deleteSession` | 1950-2018 | 69 | `export async function deleteSession(ctx, sessionId) {` |
| `undoLastMessage` | 2035-2143 | 109 | `export async function undoLastMessage(ctx, sessionId, { dryRun = false } = {}) {` |
| `collectSearchableEvents` | 2158-2195 | 38 | `export function collectSearchableEvents(events) {` |
| `searchEventsText` | 2201-2217 | 17 | `export function searchEventsText(events, query, { perSessionMax = SEARCH_PER_SESSION_MAX, previewLen = SEARCH_PREVIEW_LEN } = {}) {` |
| `searchSessions` | 2224-2255 | 32 | `export async function searchSessions(ctx, query, { scope = "all", maxSessions = SEARCH_MAX_SESSIONS, perSessionMax = SEARCH_PER_SESSION_MAX } = {}) {` |
| `deleteBatchSessions` | 2262-2303 | 42 | `export async function deleteBatchSessions(ctx, sessionIds) {` |
| `deleteByRule` | 2311-2367 | 57 | `export async function deleteByRule(ctx, { archivedOnly = false, inactiveDays = 0, cwdPrefix = "", lowValue = false, dryRun = false } = {}) {` |
| `resolveDshHome` | 2378-2382 | 5 | `function resolveDshHome(ctx, c) {` |
| `resolveBrowseRoot` | 2390-2397 | 8 | `function resolveBrowseRoot(ctx, c) {` |
| `__setConfigForTest` | 2400-2421 | 22 | `export function __setConfigForTest(partial = {}) {` |
| `__timersForTest` | 2424-2425 | 2 | `export function __timersForTest() {` |
| `__switchConfigForTest` | 2429-2431 | 3 | `export function __switchConfigForTest() {` |
| `__resetForTest` | 2434-2458 | 25 | `export function __resetForTest() {` |
| `apply` | 2471-3841 | 1371 | `export async function apply(ctx, config = {}) {` |
| `servePreview` | 2649-2662 | 14 | `const servePreview = async (req, res, name) => {` |
| `buildSlotsWithContent` | 2734-2746 | 13 | `const buildSlotsWithContent = (meta2) => {` |
| `log` | 3843-3849 | 7 | `function log(ctx, message) {` |

### lib/repair.js（397 行 · 12 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `parseLineEvents` | 20-27 | 8 | `export function parseLineEvents(line) {` |
| `validateSessionText` | 34-92 | 59 | `export function validateSessionText(text) {` |
| `fixToolResultStringContent` | 99-134 | 36 | `export function fixToolResultStringContent(text) {` |
| `encodeSessionText` | 137-148 | 12 | `export async function encodeSessionText(text) {` |
| `repairCorruptSessions` | 156-241 | 86 | `export async function repairCorruptSessions(ctx, { dryRun = false } = {}) {` |
| `scanCorruptSessions` | 244-246 | 3 | `export async function scanCorruptSessions(ctx) {` |
| `supportsRepair` | 249-252 | 4 | `export function supportsRepair(ctx) {` |
| `sessionsRootOf` | 259-262 | 4 | `function sessionsRootOf() {` |
| `scanCorruptFrames` | 268-270 | 3 | `export async function scanCorruptFrames() {` |
| `repairCorruptFrames` | 277-304 | 28 | `export async function repairCorruptFrames({ dryRun = false } = {}) {` |
| `scanDualFormatSessions` | 319-348 | 30 | `export async function scanDualFormatSessions() {` |
| `repairDualFormatSessions` | 356-396 | 41 | `export async function repairDualFormatSessions({ dryRun = false, skipIds = [] } = {}) {` |

### lib/seq-gap-repair.js（222 行 · 6 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `loadSessionFile` | 23-39 | 17 | `async function loadSessionFile(path) {` |
| `detectSeqGap` | 42-49 | 8 | `export function detectSeqGap(events) {` |
| `foldFix` | 52-79 | 28 | `function foldFix(events, patch) {` |
| `verifyTokenSurface` | 82-102 | 21 | `function verifyTokenSurface(events) {` |
| `repairSeqGap` | 110-197 | 88 | `export async function repairSeqGap(path, { dryRun = false, backupDir } = {}) {` |
| `scanSeqGapSessions` | 200-221 | 22 | `export async function scanSeqGapSessions(sessionsRoot) {` |

### lib/session-codec.js（38 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `decodeStorageRecord` | 19-28 | 10 | `export function decodeStorageRecord(record) {` |
| `packChunkRuns` | 35-37 | 3 | `export function packChunkRuns(events) {` |

### lib/template-inject.js（268 行 · 16 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `sanitizeForPrompt` | 42-44 | 3 | `function sanitizeForPrompt(text) {` |
| `templateRoot` | 47-49 | 3 | `export function templateRoot(dshHome) {` |
| `templateFile` | 51-53 | 3 | `function templateFile(dshHome, slot) {` |
| `validSlot` | 55-57 | 3 | `function validSlot(slot) {` |
| `saveTemplate` | 60-72 | 13 | `export async function saveTemplate(dshHome, slot, { name, content }) {` |
| `saveTemplateFromUrl` | 79-108 | 30 | `export async function saveTemplateFromUrl(dshHome, slot, url) {` |
| `removeTemplate` | 111-117 | 7 | `export async function removeTemplate(dshHome, slot) {` |
| `readTemplateSync` | 120-129 | 10 | `export function readTemplateSync(dshHome, slot) {` |
| `collectTemplateSlotText` | 135-148 | 14 | `export function collectTemplateSlotText(dshHome, slot, meta = TEMPLATE_DEFAULTS) {` |
| `collectTemplatesTextSync` | 150-159 | 10 | `export function collectTemplatesTextSync(dshHome, meta = TEMPLATE_DEFAULTS) {` |
| `listTemplateDir` | 166-189 | 24 | `export async function listTemplateDir(root, path) {` |
| `saveTemplateFromPath` | 198-216 | 19 | `export async function saveTemplateFromPath(browseRoot, slot, path, saveRoot) {` |
| `planEnforceDenyMessage` | 224-224 | 1 | `export const planEnforceDenyMessage = (toolName) =>` |
| `planGateMessageText` | 230-234 | 5 | `function planGateMessageText(ev) {` |
| `planGateIsInjectedUserText` | 237-239 | 3 | `function planGateIsInjectedUserText(text) {` |
| `planGateAllows` | 242-267 | 26 | `export function planGateAllows(events) {` |

### lib/value.js（393 行 · 12 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `lastAssistantText` | 25-58 | 34 | `export function lastAssistantText(events) {` |
| `classifySessionValue` | 68-81 | 14 | `export function classifySessionValue(s, lastText, now = new Date(), staleDays = 3) {` |
| `lastUserText` | 89-107 | 19 | `export function lastUserText(events) {` |
| `summarizeText` | 110-118 | 9 | `export function summarizeText(text, maxLen = 140) {` |
| `analyzeSessionValues` | 121-142 | 22 | `export function analyzeSessionValues(sessions, textsById, userTextsById, now = new Date(), staleDays = 3) {` |
| `mapValuePriority` | 154-168 | 15 | `export function mapValuePriority(status, llmValue = null, llmReason = "") {` |
| `analyzeSessionValuesWithPriority` | 180-199 | 20 | `export function analyzeSessionValuesWithPriority(sessions, textsById, userTextsById, llmById = {}, now = new Date(), staleDays = 3) {` |
| `assessValue` | 219-248 | 30 | `export function assessValue(f = {}) {` |
| `buildValueFeatures` | 257-294 | 38 | `export function buildValueFeatures(events, session, now = new Date()) {` |
| `keywordMatch` | 303-309 | 7 | `export function keywordMatch(title, lastUserText, keywords) {` |
| `analyzeValuesWithKeywords` | 323-361 | 39 | `export function analyzeValuesWithKeywords(sessions, textsById, userTextsById, featuresById = {}, keywords = [], llmById = {}, now = new Date(), staleDays = 3) {` |
| `filterSessionsByKeywords` | 373-392 | 20 | `export function filterSessionsByKeywords(sessions, textsById, userTextsById, keywords, now = new Date()) {` |

### lib/zstd-frames.js（177 行 · 6 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `scanZstdFrames` | 19-49 | 31 | `export function scanZstdFrames(buffer) {` |
| `decodeFrame` | 52-60 | 9 | `export function decodeFrame(buf) {` |
| `decodeAllFrames` | 63-68 | 6 | `export async function decodeAllFrames(buf) {` |
| `validateHeaderFrame` | 74-106 | 33 | `export function validateHeaderFrame(buf) {` |
| `fixZstdFile` | 114-148 | 35 | `export async function fixZstdFile(path, backupDir = join(dirname(path), '.zstd-fix-backup')) {` |
| `scanAllCorruptFrames` | 155-176 | 22 | `export async function scanAllCorruptFrames(sessionsRoot) {` |

### test/unit/test-archive-ws-prefix.mjs（39 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `archiveTitleWithWs` | 6-12 | 7 | `function archiveTitleWithWs(title, ws) {` |
| `stripArchiveWsPrefix` | 13-18 | 6 | `function stripArchiveWsPrefix(title) {` |
| `check` | 21-25 | 5 | `function check(desc, actual, expected) {` |

### test/unit/test-auto-continue.mjs（346 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `interruptedEvents` | 35-35 | 1 | `const interruptedEvents = () => [` |
| `completedEvents` | 41-41 | 1 | `const completedEvents = () => [` |
| `makeDomain` | 47-56 | 10 | `function makeDomain() {` |
| `makeCtx` | 58-106 | 49 | `function makeCtx({ events = interruptedEvents(), live = null, agent = null, agentsList = [], resumeHandler, domain = null, settings = {} } = {}) {` |

### test/unit/test-auto-rename.mjs（256 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `fakeLlm` | 46-52 | 7 | `function fakeLlm(chunks) {` |
| `textChunks` | 54-62 | 9 | `function textChunks(fullText) {` |
| `onError` | 68-68 | 1 | `const onError = (message) => errors.push(message);` |

### test/unit/test-delete-session.mjs（177 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `tick` | 15-15 | 1 | `const tick = () => new Promise((r) => setTimeout(r, 5));` |
| `interruptedEvents` | 19-19 | 1 | `const interruptedEvents = () => [` |
| `makeDomain` | 27-34 | 8 | `function makeDomain(seed = {}) {` |
| `makeCtx` | 36-92 | 57 | `function makeCtx({ events = interruptedEvents(), live = null, domain = null, persistenceOverrides = {}, agentsOverrides = {} } = {}) {` |

### test/unit/test-detach.mjs（151 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeAgent` | 14-23 | 10 | `function makeAgent({ running = false, scopeDispose = async () => {} } = {}) {` |
| `makeCtx` | 25-60 | 36 | `function makeCtx({ sessions = [], agentsById = {}, subagentOrigin = false } = {}) {` |

### test/unit/test-group.mjs（179 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeCtx` | 33-47 | 15 | `function makeCtx({ sessions = [], cold = [] } = {}) {` |
| `makeApp` | 50-75 | 26 | `async function makeApp(extraCtx = {}, hooks = {}) {` |
| `callApi` | 78-100 | 23 | `async function callApi(handler, method, path, body, mockFetch) {` |
| `check` | 103-106 | 4 | `function check(name, cond, detail = "") {` |

### test/unit/test-interruption.mjs（53 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `check` | 7-8 | 2 | `function check(name, cond) { if (cond) pass++; else { fail++; console.log("FAIL:", name); } }` |

### test/unit/test-list-cache.mjs（259 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeTmpHome` | 22-27 | 6 | `function makeTmpHome() {` |
| `interruptedEvents` | 30-36 | 7 | `function interruptedEvents() {` |
| `titledEvents` | 39-45 | 7 | `function titledEvents(title) {` |
| `makeCtx` | 51-87 | 37 | `function makeCtx({ snapshots, eventsById = {}, inspectFails = new Set() }) {` |

### test/unit/test-search-delete.mjs（272 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeCtx` | 24-83 | 60 | `function makeCtx({ sessions = [] } = {}) {` |

### test/unit/test-template-inject.mjs（260 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `ok` | 38-41 | 4 | `async function ok(name, fn) {` |

### test/unit/test-value.mjs（206 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `ok` | 19-22 | 4 | `function ok(name, fn) {` |

<!-- dshgp-functions:end -->