#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# ac-confirm — analyze-then-confirm 确认块模板生成器（skill→代码 落地 #3）
# ═══════════════════════════════════════════════════════════════
# 用途：收到任务/有副作用操作前，自动产出标准「分析 + 已读 skill 列表 + 确认」块，
#       确保每次会话都符合 analyze-then-confirm 格式（不漏确认、可审计）。
# 用法：
#   bash ac-confirm.sh "需求描述" "方案一句话"   # 生成确认块文本
# 输出：标准确认块（复制进回复即可）
# 配套 skill：analyze-then-confirm / user-confirmation-style
# ═══════════════════════════════════════════════════════════════

set -u
REQ="${1:-}"
PLAN="${2:-}"

if [ -z "$REQ" ]; then
  echo "❌ 用法: bash ac-confirm.sh \"需求/任务描述\" \"方案一句话\""
  echo "   可选环境变量: RISK=改/删/重启/装/推  IMPACT=影响面描述"
  exit 1
fi

RISK="${RISK:-（未标注，默认只读/无副作用）}"
IMPACT="${IMPACT:-（未标注影响面）}"

# 收集当前会话已加载的 skill（从 .dsh/skills 读取，作为参考；SKILLS_DIR 可环境变量覆盖，缺省从 DSH_HOME 派生）
SKILL_LIST="无（未加载）"
SKILLS_DIR="${SKILLS_DIR:-${DSH_HOME:-$HOME/.dsh}/skills}"
if [ -d "$SKILLS_DIR" ]; then
  SKILL_LIST=$(ls "$SKILLS_DIR"/*.md 2>/dev/null | xargs -n1 basename | sed 's/.md$//' | tr '\n' ' ')
fi

cat << EOF
【分析】需求：$REQ
 ｜ 现状：（待补——先看相关文件/配置/环境）
 ｜ 方案：$PLAN
 ｜ 影响面：$IMPACT（$RISK）
读取的 skill：
  - （本会话实际加载的 skill 名 + 来源路径，如：dsh-xxx ← .dsh/skills/xxx.md）
  - （未加载写"无"；可用参考目录：$SKILL_LIST）
确认后我执行。要开始吗？
EOF
