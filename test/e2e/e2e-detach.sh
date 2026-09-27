#!/bin/bash
# e2e：手动释放（置为不活跃）—— 创建会话 → detach → 活跃数下降 → 会话仍在 → 重新挂载
# 路径纪律（test-design-norms）：禁止硬编码绝对路径——
#   APP_DIR（DSH 安装目录）用环境变量覆盖，缺省自动探测套件安装位置；
#   TEST_HOME / LOG / HOME 从脚本所在目录派生（相对）。
# 用法：APP_DIR=<dsh安装目录> bash e2e-detach.sh
set -u
PORT="${E2E_PORT:-3095}"

# DSH 套件安装目录：环境变量优先，其次自动探测（不写死绝对路径）
APP_DIR="${APP_DIR:-$(command -v dsh >/dev/null 2>&1 && dirname "$(dirname "$(dirname "$(command -v dsh)")")" || echo '')}"
if [ -z "$APP_DIR" ] || [ ! -x "$APP_DIR/bin/node" ]; then
  echo "[e2e] 找不到 DSH 安装目录：请用 APP_DIR=<dsh安装目录> 指定（当前: ${APP_DIR:-空}）"
  exit 2
fi
NODE=$APP_DIR/bin/node
DSH="${DSH:-$APP_DIR/apps/cli/lib/bin.js}"
if [ ! -f "$DSH" ]; then
  echo "[e2e] 找不到 DSH 入口 $DSH（可用 DSH 环境变量覆盖）"
  exit 2
fi

# 测试数据/日志目录：从脚本位置派生（相对）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_HOME="${E2E_TEST_HOME:-$SCRIPT_DIR/.tmp-e2e-$PORT}"
LOG="${E2E_LOG:-$SCRIPT_DIR/.tmp-e2e-$PORT.log}"
export DSH_HOME=$TEST_HOME
export HOME="${E2E_HOME:-$SCRIPT_DIR}"
export PATH=$APP_DIR/bin:$PATH

say() { echo "[e2e] $*"; }
rpc() { curl -s --max-time 10 -X POST "http://127.0.0.1:${PORT}/api/$1" -H 'Content-Type: application/json' -d "{\"type\":\"client-request\",\"rpcId\":\"$RANDOM\",\"method\":\"$1\",\"payload\":$2}"; echo; }
attached() { rpc host.describe "{}" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{console.log(JSON.parse(r).result.value.attachedSessions)}catch(e){console.log("?")}})'; }

mkdir -p "$TEST_HOME"
$NODE $DSH web --host 127.0.0.1 --port $PORT > "$LOG" 2>&1 &
DSH_PID=$!
for i in $(seq 1 80); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${PORT}/ 2>/dev/null)" = "200" ] && break
  sleep 0.5
done
say "booted pid=$DSH_PID  attached=$(attached)"

rpc session.create "{\"sessionId\":\"session-rel-a\",\"cwd\":\"$TEST_HOME\"}" > /dev/null
rpc session.create "{\"sessionId\":\"session-rel-b\",\"cwd\":\"$TEST_HOME\"}" > /dev/null
say "创建 2 个会话后 attached=$(attached)（期望 2）"

echo "== detach 单个:"
curl -s --max-time 8 -X POST "http://127.0.0.1:${PORT}/api/session-conductor/detach" -H 'Content-Type: application/json' -d '{"sessionId":"session-rel-a"}'; echo
say "detach 后 attached=$(attached)（期望 1）"
echo "== list 里 session-rel-a 状态:"
curl -s --max-time 8 "http://127.0.0.1:${PORT}/api/session-conductor/list" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{const b=JSON.parse(r);for(const s of b.sessions) if(s.id==="session-rel-a") console.log("  live:",s.live,"running:",s.running,"interruption:",JSON.stringify(s.interruption));})'

echo "== detach-all:"
curl -s --max-time 8 -X POST "http://127.0.0.1:${PORT}/api/session-conductor/detach-all" -H 'Content-Type: application/json' -d '{}'; echo
say "detach-all 后 attached=$(attached)（期望 0）"

echo "== 重新发消息（应自动重新挂载）:"
rpc session.prompt "{\"sessionId\":\"session-rel-a\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"只回复：重新挂载成功\"}]}"
sleep 8
say "prompt 后 attached=$(attached)（期望 1，已重新挂载）"
curl -s --max-time 8 "http://127.0.0.1:${PORT}/api/session-conductor/list" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{const b=JSON.parse(r);for(const s of b.sessions) if(s.id==="session-rel-a") console.log("  session-rel-a live:",s.live,"running:",s.running);})'

kill -TERM $DSH_PID 2>/dev/null
sleep 2
say "done"