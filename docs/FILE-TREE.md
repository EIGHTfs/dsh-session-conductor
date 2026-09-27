# 文件目录结构（由 dsh-git-push doc-tree 维护）

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
│   │   ├── .test — e2e 测试目录审计豁免标记（0 字节）
│   │   ├── e2e-crash-continue.sh — 崩溃续跑 e2e
│   │   ├── e2e-detach.sh — detach e2e
│   ├── unit/ — 单元测试（真模块 import + 独立 DSH_HOME）
│   │   ├── .test — 单测目录审计豁免标记（0 字节）
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
│   │   ├── test-undo.mjs — 撤回消息 undoLastMessage 单测
│   │   ├── test-value-real.mjs — 价值分析（真实模型）单测
│   │   ├── test-value.mjs — 价值分析单测
│   │   ├── test-zstd-frames.mjs — zstd 帧单测
├── docs/ — 独立文档（由 git-push doc-* 工具维护）
│   ├── FILE-TREE.md — 文件目录结构（doc-tree 维护）
│   ├── FUNCTIONS.md — 函数列表（doc-func 维护）
│   ├── VERSIONS.md — 版本列表（doc-version 维护）
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
│   │   ├── frontend-real-render-preview.mjs — 真实后端预览生成器（自备副本）
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
