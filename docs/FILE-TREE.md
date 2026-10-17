# 文件目录结构（由 dsh-git-push doc-tree 维护）

<!-- dshgp-tree:start -->
```text
dsh-session-conductor/
├── lib/ — 宿主侧实现
│   ├── apply.js — （待注释）
│   ├── core.js — 会话核心逻辑（列表/归档/删除/撤回/续跑等）
│   ├── eio-repair.js — EIO 坏块会话修复
│   ├── group.js — 会话分组（workspace 映射）
│   ├── guards.js — （待注释）
│   ├── http.js — （待注释）
│   ├── index.js — 宿主入口（API / 注入 / 设置命名空间）
│   ├── repair.js — 损坏会话修复（seq-gap 主流程）
│   ├── seq-gap-repair.js — seq-gap 损坏修复
│   ├── session-codec.js — 会话 v3 格式编解码
│   ├── session-log.js — 会话日志文件定位（v3/v4 文件名兼容：session.jsonl.zstd / session.v4.jsonl.zstd）
│   ├── template-inject.js — 模板注入（方案/收尾槽位读写、注入文本拼接）
│   ├── value.js — 价值分析（LLM 分类）
│   ├── zstd-frames.js — zstd 帧解析/校验
│   ├── client-parts/ — 浏览器侧分片源（build.cjs 拼接）
│   │   ├── apply.js — 主插件 apply 收尾（settings.section / sidebar.footer.action 注册）
│   │   └── …（11 个更深文件）
│   ├── core/ — （待注释）
│   │   ├── config.js — （待注释）
│   │   ├── domain.js — （待注释）
│   │   ├── lazy.js — （待注释）
│   │   ├── state.js — （待注释）
│   ├── features/ — （待注释）
│   │   ├── search.js — （待注释）
│   │   ├── session-ops-routes.js — （待注释）
│   │   ├── session-ops.js — （待注释）
│   │   └── …（18 个更深文件）
│   ├── i18n/ — 语言包（zh/en 外置）
│   │   ├── en.json — 英文语言包
│   │   ├── zh.json — 中文语言包
│   ├── sessions/ — （待注释）
│   │   ├── detach.js — （待注释）
│   │   ├── events.js — （待注释）
│   │   ├── interruption.js — （待注释）
│   │   ├── list-cache.js — （待注释）
│   │   ├── list.js — （待注释）
│   │   ├── route.js — （待注释）
│   │   ├── session-id.js — （待注释）
│   │   ├── turn.js — （待注释）
│   ├── shared/ — （待注释）
│   │   ├── constants.js — （待注释）
│   │   ├── log.js — （待注释）
│   │   ├── settings.js — （待注释）
│   │   ├── test-hooks.js — （待注释）
│   │   ├── util.js — （待注释）
├── scripts/ — （待注释）
│   ├── check-member-model.mjs — （待注释）
├── assets/ — 预览页与界面产物
│   ├── screenshots/ — README/市场配图（playwright 自动截图产物）
│   │   ├── panel.png — 会话管理面板截图
│   │   ├── settings.png — 模板注入设置页截图
├── test/ — 测试
│   ├── run-all.mjs — （待注释）
│   ├── .trash/ — （待注释）
│   │   └── …（1 个更深文件）
│   ├── api/ — （待注释）
│   │   ├── test-destructive-api-safe.mjs — （待注释）
│   │   ├── test-group-api.mjs — （待注释）
│   │   ├── test-misc-api.mjs — （待注释）
│   │   ├── test-mutating-api-validation.mjs — （待注释）
│   │   ├── test-new-session-happy.mjs — （待注释）
│   │   ├── test-readonly-api.mjs — （待注释）
│   │   └── …（2 个更深文件）
│   ├── e2e/ — 端到端测试脚本
│   │   ├── .test — e2e 测试目录审计豁免标记（0 字节）
│   │   ├── e2e-crash-continue.sh — 崩溃续跑 e2e
│   │   ├── e2e-detach.sh — detach e2e
│   ├── unit/ — 单元测试（真模块 import + 独立 DSH_HOME）
│   │   ├── .test — 单测目录审计豁免标记（0 字节）
│   │   ├── test-archive-ws-prefix.mjs — 归档工作区前缀单测
│   │   ├── test-client-build-in-sync.mjs — （待注释）
│   │   ├── test-client-parts-syntax.mjs — （待注释）
│   │   ├── test-cold-session-read.mjs — （待注释）
│   │   ├── test-completion-convention-inject.mjs — （待注释）
│   │   ├── test-context-usage.mjs — （待注释）
│   │   ├── test-domain-reuse.mjs — （待注释）
│   │   ├── test-group-route-fallthrough.mjs — （待注释）
│   │   ├── test-interruption.mjs — 中断检测单测
│   │   ├── test-list-cache-invalidation.mjs — （待注释）
│   │   ├── test-list-cache-null-guard.mjs — （待注释）
│   │   ├── test-list-id-invariant.mjs — （待注释）
│   │   ├── test-list-job-and-cross-recall.mjs — （待注释）
│   │   ├── test-member-locate.mjs — （待注释）
│   │   ├── test-member-model-verify.mjs — （待注释）
│   │   ├── test-memory-recall.mjs — （待注释）
│   │   ├── test-model-switch-command.mjs — （待注释）
│   │   ├── test-repair.mjs — 修复单测
│   │   ├── test-session-format-v4.mjs — （待注释）
│   │   ├── test-session-log.mjs — 会话日志定位单测（v3/v4/未来命名兼容）
│   │   ├── test-session-messaging.mjs — （待注释）
│   │   ├── test-template-inject.mjs — 模板注入单测
│   │   ├── test-value-real.mjs — 价值分析（真实模型）单测
│   │   ├── test-value.mjs — 价值分析单测
│   │   ├── test-versions-table-complete.mjs — （待注释）
│   │   ├── test-zstd-frames.mjs — zstd 帧单测
│   │   └── …（1 个更深文件）
├── docs/ — 独立文档（由 git-push doc-* 工具维护）
│   ├── 2026-10-15-记忆取回.MD — （待注释）
│   ├── 2026-10-15-跨会话消息与指定模型新建会话工具.MD — （待注释）
│   ├── 2026-10-16-列表job化与跨会话取回.MD — （待注释）
│   ├── DESIGN-跨会话消息.md — （待注释）
│   ├── FILE-TREE.md — 文件目录结构（doc-tree 维护）
│   ├── FUNCTIONS.md — 函数列表（doc-func 维护）
│   ├── VERSIONS.md — 版本列表（doc-version 维护）
│   ├── split-plan-index.json — （待注释）
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
│   ├── ensure-cwd-folders.mjs — 一键补齐会话指向的 cwd 文件夹（扫 .dsh/sessions 分组，读会话日志首帧 header.cwd，缺失则 mkdir）
│   ├── fix-tool-result-content.py — 修复 tool-result 内容格式
│   ├── gen-fallback.mjs — fallback 内嵌行生成（i18n.js）
│   ├── validate-session.mjs — 会话文件校验
│   ├── archived/ — 已删功能的归档脚本
│   │   ├── keyword-inject.js — 已删关键字注入功能归档
│   ├── vendor/ — 自备工具副本（预览生成器 + react-umd）
│   │   └── …（2 个更深文件）
├── .auditignore — 审计豁免清单
├── .gitignore — 忽略列表（生成物 client.js/tmp-snapshot/截图 不入库）
├── README.md — 项目说明（文件树/版本/函数列表由 git-push doc-* 工具维护）
├── build.cjs — 浏览器侧分片拼接构建（--check 一致性比对）
├── cordis.patch.yml — bundle patch（顶层 insert loader 行）
├── package.json — npm 规范清单（版本号权威源）
├── screenshots.json — 市场截图声明（dsh-market 详情页展示 1-8 张）
├── tree-doc.json — 文件树注释映射（doc-tree 维护）
```
<!-- dshgp-tree:end -->
