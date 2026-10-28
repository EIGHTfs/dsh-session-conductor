# dsh-session-conductor

DSH 会话管理增强插件：面板管理会话、批量删除与回收站、损坏修复、自动续跑、模板注入，以及成员（子代理）的模型/权限/换名管理。

## 功能

| 功能 | 做什么 | 入口 |
|---|---|---|
| 会话管理面板 | 五视图（全部/已归档/活跃/回收站/说明）；归档、删除、撤回、置不活跃、释放空闲 | 侧边栏「会话管理」 |
| 回收站 | 删除只打标记，可单条/多选/按批次还原；到期或一键清空才真删盘 | 面板「回收站」 |
| 自动重命名 | 回合后分析内容，主题偏离时生成新标题 | 面板逐会话开关 |
| 自动续跑 | 识别非人为中断并继续原任务，失败 30s 重试 | 面板逐会话开关 |
| 会话分组 | 按工作区分组显示；分组下新建会话 | 设置 → 插件 → 会话分组 |
| 撤回最后一条消息 | 删除最后一条用户消息及整轮回复（预览 + 二次确认 + 备份） | 面板按钮 |
| 损坏修复 | seq-gap / EIO 坏块 / 双格式 / zstd 帧级损坏 四类 | 面板「说明」页 + `/repair` 系列 |
| 价值分析 | LLM 给会话分类（已完成/未完成/久未活跃/活跃中） | 面板按钮 |
| 全文搜索 | FTS5 优先，内置 zstd 扫描兜底 | 面板搜索框 |
| 压缩模型 | 上下文自动压缩使用独立模型 | 设置 → 插件 → 压缩模型 |
| 模板注入 | 方案/收尾模板；本地文件、在线网址、目录浏览三种导入 | 设置 → 会话管理 |
| 自动重命名模型 | 指定标题分析用的模型 | 设置 → 会话管理 |
| 成员模型切换 | 切单个或全部成员的模型，可跟随主代理 | `/model-switch`、`set_member_model` |
| 成员权限预设 | 查看/切换成员权限预设，支持批量与跟随 | `/perm-switch`、`set_member_permission` |
| 成员换名 | 新建成员并把原会话内容搬进去 | `clone_member_as` |
| 创建成员并选模型 | 创建时即指定模型，首轮就用它 | `create_teammate_with_model` |
| 指定模型新建会话 | 新建会话并直接指定 provider/model | `create_session` |
| 记忆取回 | 上下文用量骤降时自动回注最近几轮对话 | 自动注入 + `recall_memory` |
| 上下文用量 | 查自己会话的占用与构成 | `context_usage` |
| 跨会话消息 | 给另一个会话发消息，空闲时自动唤醒 | `list_sessions`、`send_to_session` |

## 安装

1. 把插件源码放到 profile 的真实目录（目录拷贝，不要软链）：
   ```
   <DSH_HOME>/profiles/<profile>/local-plugins/dsh-session-conductor/
   ```
2. 在 profile 里装依赖：
   ```
   dsh plugin --profile <profile> add file:local-plugins/dsh-session-conductor
   dsh plugin --profile <profile> install
   ```
3. 把插件名加进 profile `package.json` 的 `dsh.profile.bundles`；插件自带的 `cordis.patch.yml`
   必须用顶层 `- insert:` 新建 loader 行。
4. 重启宿主，确认实例日志里该插件 `loaded`。

从 GitHub 安装（可选）：

```bash
cd <DSH_HOME>/profiles/<profile>
pnpm add github:EIGHTfs/dsh-session-conductor#<commit>
```

`dsh plugin add` 装 git 源当前不可用（会挂死且零输出），请在 profile 目录直跑 pnpm。pnpm 构建 git 源包时
会在临时目录执行 `npm install`，本机需有 `npm`。用 `#<commit>` 固定版本（仓库远端暂无 tag）。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | **0.2.1 及以上**（更早版本功能可用，但列表缓存不生效，会话多时列表构建变慢） |
| Node | 与宿主自带的 Node 一致，无需额外安装 |
| 平台 | Linux（群晖 DSM / fnOS 等）；纯 Node 实现，无原生依赖 |

## 用法

### 面板与设置页

- **面板**：侧边栏底部「会话管理」展开。五个视图分别是全部、已归档、活跃、回收站、说明。
  行内可归档、删除、撤回最后一条消息、开关自动重命名/自动续跑；顶部可搜索、价值分析、释放全部空闲。
- **设置页**：左侧栏「会话管理」独立页。模板注入（方案/收尾两个槽位，可上传本地 md、填在线网址、
  浏览 DSH 目录导入，导入后可再编辑）与自动重命名模型选择。

### 聊天框指令

`/model-switch` —— 查看/切换成员模型：

```
/model-switch                                      # 无参：列出成员与各自模型
/model-switch writer                               # 只给成员：查它实际在用的模型
/model-switch writer sa6400/deepseek-v4.1-flash    # 成员 + 模型：切换
/model-switch * auto                               # 成员写 * = 全部；模型写 auto = 跟随我
```

`/perm-switch` —— 查看/切换成员权限预设：

```
/perm-switch                        # 无参：列出成员与各自预设
/perm-switch writer                 # 只给成员：查 preset / sandbox / approval
/perm-switch writer danger-full-access   # 成员 + 预设：切换
/perm-switch * auto                 # 成员写 * = 全部；预设写 auto = 跟随我
```

两条指令都支持：成员位置可填成员名、唯一子串或 sessionId；`*` 表示全部成员（不含自己）；
`auto` 表示跟随主代理当前值。切换后回执会带上「实际生效」的查证结果。

### AI 工具

```js
list_models({})                                    // 列出可用 provider 与模型 id
set_member_model({ target, provider, model })      // 三者都可空：target 空=全部成员；provider/model 空=跟随我
set_member_permission({ target, preset })          // 两者都可空：target 空=全部成员；preset 空=跟随我
list_permission_presets({})                        // 列出可选权限预设
clone_member_as({ source, name, description, withHistory, provider, model, subagentProvider })
                                                   // source/name 必填；withHistory 默认 true（false=只建空成员）
create_teammate_with_model({ name, description, prompt, provider, model, subagentProvider, context })
                                                   // name/description/prompt/provider/model 必填
create_session({ cwd, workspaceId, provider, model, text, dryRun, sessionId })
                                                   // 全可空：cwd 缺省=调用方 cwd；dryRun=true 只预览
list_sessions({ query, limit, offset, fromIndex }) // 全可空：fromIndex=true 直接读索引（秒回）
send_to_session({ sessionId, text, mode, dryRun }) // sessionId/text 必填；mode=queue|steer
recall_memory({ rounds, session })                 // 都可空：rounds 默认取配置、上限 50；session 空=自己
context_usage({})                                  // 无参
```

典型调用：

```js
// 全部子代理都换成我现在用的模型
set_member_model({})

// 只把 writer 切到指定模型
set_member_model({ target: "writer", provider: "sa6400", model: "cn:deepseek-v4.1-flash" })

// 把 probe1 克隆成 rename1（换名用）
clone_member_as({ source: "probe1", name: "rename1" })

// 给另一个会话发消息（dryRun 先预览目标状态与限流余量）
send_to_session({ sessionId: "session-xxxx", text: "继续刚才的任务", dryRun: true })
```

## API

插件以 `/api/session-conductor/*` 前缀注册宿主路由：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/list` | GET | 会话列表；`?fromIndex=true` 读落盘索引秒回，`?job=1` 交给后台 job |
| `/archive` `/restore` | POST | 归档 / 恢复会话 |
| `/delete` | POST | 删除会话（拒绝运行中） |
| `/undo` | POST | 撤回最后一条消息 |
| `/auto-rename` `/auto-continue` | POST | 两个逐会话开关 |
| `/auto-continue-gate` | GET/POST | 全局续跑闸门 |
| `/release` | POST | 释放空闲会话 |
| `/value-analysis` | POST | 价值分析 |
| `/repair` `/repair-eio` `/repair-dual` | POST | 三类损坏修复 |
| `/search` | GET | 全文搜索 |
| `/compaction-model` `/auto-rename-model` | GET/POST | 两个模型设置 |
| `/templates` `/templates/dir` | GET/POST | 模板注入与目录浏览 |
| `/i18n` | GET | 语言包（zh/en） |

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

- [文件目录结构](docs/FILE-TREE.md) — 目录树与文件作用
- [版本列表](docs/VERSIONS.md) — 按 git 提交聚合的版本记录
- [函数列表](docs/FUNCTIONS.md) — lib/ 导出函数的名称/位置/签名
- [模型与权限切换机制](docs/模型与权限切换机制.MD) — 子代理切换的实现依据与内部机制
