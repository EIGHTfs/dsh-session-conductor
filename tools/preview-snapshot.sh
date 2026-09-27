#!/bin/bash
# 真实后端预览快照生成（免重启、免 CORS）
#
# 原理：预览页要跑真实数据，但 file:// 打开时 fetch 真实后端会被 CORS 拦；经 DSH 同源路由打开又
# 需要插件路由注册（重启才生效）。本脚本把「生成时 fetch 真实后端」的响应内嵌为快照垫片
# （--endpoints），预览 html 打开时垫片直接返回真实快照数据——改 UI 后重新生成即可立即看，
# 无需重启 DSH、无假数据（数据来自生成时真实 API 响应）。
#
# 用法：bash tools/preview-snapshot.sh [BASE] [OUT_DIR]
#   BASE    真实后端地址（必传，如 http://<host>:<port>；也可设环境变量 DSH_PREVIEW_TARGET，不硬编码本机地址）
#   OUT_DIR 预览输出目录（默认 assets/）
set -e
BASE="${1:-${DSH_PREVIEW_TARGET:-}}"
if [ -z "$BASE" ]; then
  echo "用法: bash tools/preview-snapshot.sh <BASE> [OUT_DIR]"
  echo "  BASE = 真实后端地址（必传，或设 DSH_PREVIEW_TARGET 环境变量），例 http://127.0.0.1:30801"
  exit 1
fi
OUT="${2:-$(cd "$(dirname "$0")/.." && pwd)/assets}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-node}"
TOOL="${TOOL:-$(dirname "$0")/vendor/frontend-real-render-preview.mjs}"
REACT="${REACT:-$(dirname "$0")/vendor/react-umd}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. 抓真实后端响应（快照）
python3 - "$BASE" "$TMP" <<'PYEOF'
import json, sys, urllib.request
base, tmp = sys.argv[1], sys.argv[2]
apis = [
    "/api/session-conductor/templates",
    "/api/session-conductor/i18n",
    "/api/session-conductor/list",
]
# ⚠️ 不再抓取 /api/session-conductor/value-analysis（重负载：逐会话全量解压事件，
# 生成快照时会把 DSH 卡死）——预览页「低价值」筛选在离线快照下无数据，
# 前端 localValue 分支会提示「低价值筛选需真实后端」；其余条件（归档/超期/前缀）
# 用 list 快照本地计算即可。
snap = {}
for api in apis:
    try:
        with urllib.request.urlopen(base + api, timeout=8) as r:
            snap[api] = json.load(r)
        print("快照:", api, "ok")
    except Exception as e:
        print("跳过:", api, e)
json.dump(snap, open(tmp + "/endpoints.json", "w", encoding="utf-8"), ensure_ascii=False)
PYEOF

# 2. 生成两个预览（快照垫片模式，无 --backend → file:// 打开无 CORS）
"$NODE" "$TOOL" --client "$ROOT/lib/client.js" --endpoints "$TMP/endpoints.json" \
  --section settings.section --react "$REACT" --out "$OUT/preview-settings.html" | grep 生成
"$NODE" "$TOOL" --client "$ROOT/lib/client.js" --endpoints "$TMP/endpoints.json" \
  --section sidebar.footer.action --react "$REACT" --out "$OUT/preview-panel.html" | grep 生成

# 3. 补丁：垫片 locale.bind 转发 __SC_TR__（内嵌 FALLBACK 中文兜底）——
#    frontend-real-render-preview.mjs 的 locale mock 直接 `(key) => key`，预览页 i18n 显示 key；
#    这里就地把 bind 改为查 __SC_TR__（client.js 内嵌完整 zh/en FALLBACK，不依赖真实 i18n fetch）。
#    并补灌快照 i18n 数据到 window.__SC_I18N__（client.js 的 i18n fetch 在 fetch 垫片定义前
#    执行会失败，需在渲染前把内嵌的 /api/session-conductor/i18n 快照直接注入字典）。
python3 - "$OUT" <<'PYEOF'
import sys
out = sys.argv[1]
old = "bind: function (_ns) { return function (key) { return key; }; }"
new = ("bind: function (_ns) { return window.__SC_TR__ ? function (key, vars) { return window.__SC_TR__(key, vars); }"
       " : function (key) { return key; }; }")
inject = (
    "<script>\n"
    "// [sc-preview i18n 补丁] 把快照 i18n 数据灌入 __SC_I18N__（client.js 原生 fetch 在垫片前执行会失败）\n"
    "(function () {\n"
    "  var ep = window.__ENDPOINTS__ || {};\n"
    "  var body = ep['/api/session-conductor/i18n'];\n"
    "  if (body && body.ok && body.zh) {\n"
    "    var i18n = window.__SC_I18N__ || (window.__SC_I18N__ = {});\n"
    "    i18n.zh = body.zh;\n"
    "    i18n.en = body.en || {};\n"
    "    i18n.loaded = true;\n"
    "    (i18n.waiters || []).forEach(function (fn) { try { fn(); } catch (e) {} });\n"
    "    i18n.waiters = [];\n"
    "  }\n"
    "})();\n"
    "</script>"
)
for name in ("preview-settings.html", "preview-panel.html"):
    p = out + "/" + name
    s = open(p, encoding="utf-8").read()
    changed = False
    if old in s:
        s = s.replace(old, new, 1)
        changed = True
    if "sc-preview i18n 补丁" not in s:
        # 注入到宿主渲染 script 之前（__SECTIONS__ 是宿主渲染入口标记）——渲染前字典就位
        anchor = "window.__SECTIONS__ = []"
        idx = s.find(anchor)
        if idx > 0:
            head = s.rfind("<script>", 0, idx)
            if head > 0:
                s = s[:head] + inject + "\n" + s[head:]
                changed = True
        if not changed:
            s = s.rstrip() + inject
            changed = True
    if "sc-preview open-panel 补丁" not in s:
        # 渲染后模拟点击 trigger 按钮展开面板（无头/用户打开即可见会话行布局）
        click = (
            "\n<script>\n"
            "// [sc-preview open-panel 补丁] 渲染完成后模拟点击「会话管理」入口展开面板\n"
            "setTimeout(function () {\n"
            "  var bs = Array.prototype.slice.call(document.querySelectorAll('button'));\n"
            "  for (var i = 0; i < bs.length; i++) {\n"
            "    var t = (bs[i].textContent || '').trim();\n"
            "    if (t.indexOf('会话管理') >= 0 || t.indexOf('Session Conductor') >= 0 || t === 'Sessions') {\n"
            "      try { bs[i].click(); } catch (e) {}\n"
            "      break;\n"
            "    }\n"
            "  }\n"
            "}, 400);\n"
            "</script>"
        )
        s = s.rstrip() + click
        changed = True
    if changed:
        open(p, "w", encoding="utf-8").write(s)
        print("i18n 补丁:", name)
    else:
        print("未找到补丁点:", name)
PYEOF

echo "✅ 快照版预览已生成（打开即看，无需重启 DSH）：$OUT/preview-settings.html / preview-panel.html"
