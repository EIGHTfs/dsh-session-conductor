# 版本列表（由 dsh-git-push doc-version 维护）

<!-- dshgp-version:start -->
## 版本列表

| 版本 | 内容 |
|------|------|
| 1.0.6 | dsh-session-conductor 1.0.6 —— 结构/审计低风险优化 + 移除冗余工具 + 分片可独立校验 |
| 1.0.5 | 测试体系改造为「打 HTTP API」+ 修「分组下新建会话」恒 500 |
| 1.0.4 | 拆分 lib/index.js（4348 → 2257 行）为按功能域分层的多目录结构 |
| 1.0.3 | 成员模型切换（list_models / set_member_model）+ 会话日志 v4 文件名兼容 + zstd 改 node:zlib + 版本号统一 |
| 1.0.1 | 撤回消息补测与全量审计优化——①test-undo.mjs 单测（冷会话截断最后一条用户消息及以后/活跃会话 detach 链路/dryRun/运行中拒绝/注入不误撤）②全量审计优化：tools/vendor 第三方豁免、全分片 fetch 30s 超时兜底（__scFetch）、有语义魔数提常量、test 目录 .test 豁免、空 catch 注释、docs 三兄弟独立 md（FILE-TREE/VERSIONS/FUNCTIONS）③评分 76.8→78.9、blocker 0 |
| 1.0.0 | dsh-session-conductor 初始版本——会话管理增强插件（面板四视图/归档恢复/批量与条件删除/AI 自动重命名/中断自动续跑/按工作区分组/撤回消息/三类损坏修复/价值分析/全文搜索/压缩模型/模板注入/自动重命名模型），中英双语 i18n 外置，真实后端预览页（快照免重启+同源路由），README 文件树/版本/函数列表由 git-push doc-* 工具维护，全部历史整理为一次提交 |

<!-- dshgp-version:end -->
