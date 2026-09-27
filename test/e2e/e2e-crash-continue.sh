#!/bin/bash
# dsh-session-conductor 自动续跑 e2e：崩溃中断 → 重启 → 插件自动续跑 → 验证
# 全程在单个进程树内运行（沙箱会回收脱离的后台进程），自启动/自清理。
# 路径纪律（test-design-norms）：禁止硬编码绝对路径——
#   APP_DIR（DSH 安装目录）用环境变量覆盖，缺省自动探测套件安装位置；
#   TEST_HOME / LOG / HOME 从脚本所在目录派生（相对）。
# 用法：APP_DIR=<dsh安装目录> bash e2e-crash-continue.sh
set -u
PORT="${E2E_PORT:-3092}"

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
SID="session-ac-e2e-d"
export DSH_HOME=$TEST_HOME
export HOME="${E2E_HOME:-$SCRIPT_DIR}"
export PATH=$APP_DIR/bin:$PATH

say() { echo "[e2e] $*"; }

rpc() { # rpc <method> <json>
  curl -s --max-time 8 -X POST "http://127.0.0.1:${PORT}/api/$1" -H 'Content-Type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"$(date +%s%N)\",\"method\":\"$1\",\"payload\":$2}"
}

wait_http() { # wait_http <timeout_s>
  local t=$1
  for i in $(seq 1 $((t * 2))); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${PORT}/ 2>/dev/null)" = "200" ] && return 0
    sleep 0.5
  done
  return 1
}

start_dsh() {
  $NODE $DSH web --host 127.0.0.1 --port $PORT > "$LOG" 2>&1 &
  DSH_PID=$!
  say "DSH 启动 pid=$DSH_PID"
}

stop_dsh() { # stop_dsh [signal]
  local sig=${1:-TERM}
  [ -n "${DSH_PID:-}" ] && kill -$sig "$DSH_PID" 2>/dev/null
}

# ---------- 阶段 0：启动 + 冒烟（确认模型可用） ----------
start_dsh
wait_http 60 || { say "FAIL: 启动超时"; tail -5 "$LOG"; exit 1; }
say "启动成功"

rpc session.create "{\"sessionId\":\"$SID\",\"cwd\":\"$TEST_HOME\"}"
rpc session.prompt "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"只回复三个字：模型可用\"}]}" > /dev/null
say "冒烟 prompt 已发"
sleep 25
SMOKE=$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/api/session-conductor/list")
SMOKE_STATE=$(echo "$SMOKE" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{const b=JSON.parse(r);const s=(b.sessions||[]).find(x=>x.id===process.argv[1]);console.log(JSON.stringify(s&&{running:s.running,interruption:s.interruption}));})' "$SID")
say "冒烟后状态: $SMOKE_STATE"
case "$SMOKE_STATE" in
  *'"interruption":null'*|*'"interruption":null'*) say "冒烟通过：会话回合正常结束（模型可用）";;
  *) say "WARN: 冒烟状态异常（$SMOKE_STATE），继续尝试长任务…";;
esac

# ---------- 阶段 1：长任务回合进行中 → 崩溃（SIGKILL 模拟断电） ----------
rpc session.prompt "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"请写一篇大约 3000 字的中文长文，主题是人工智能的发展。请缓慢、逐段、详细地输出，不要用工具，只输出正文。\"}]}" > /dev/null
say "长任务 prompt 已发，等待回合进入运行态…"
RUNNING=0
for i in $(seq 1 40); do
  ST=$(curl -s --max-time 5 "http://127.0.0.1:${PORT}/api/session-conductor/list" 2>/dev/null | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{const b=JSON.parse(r);const s=(b.sessions||[]).find(x=>x.id===process.argv[1]);console.log(s?.running?"RUNNING":(s?.interruption?"DONE-ERR":"IDLE"));}catch(e){console.log("ERR");}})' "$SID")
  if [ "$ST" = "RUNNING" ]; then RUNNING=1; say "回合运行中（第 ${i} 次轮询）"; break; fi
  if [ "$ST" = "DONE-ERR" ]; then say "回合已异常结束（模型或 prompt 问题），无法做崩溃测试"; break; fi
  sleep 0.5
done
[ "$RUNNING" = "1" ] || { say "FAIL: 未等到回合运行（最后状态 $ST）"; stop_dsh; sleep 3; tail -5 "$LOG"; exit 1; }

say "SIGKILL 模拟崩溃…"
stop_dsh KILL
sleep 2
say "崩溃前 DSH pid=$DSH_PID"

# ---------- 阶段 2：重启，等待插件首扫自动续跑 ----------
start_dsh
wait_http 60 || { say "FAIL: 重启超时"; tail -5 "$LOG"; exit 1; }
say "重启成功（插件首扫延迟 15s + 续跑回合）…"
BOOT_SID="session-ac-e2e-d"

# 等待自动续跑完成：中断标记消失（最后回合正常完成）或超时
CONTINUED=0
for i in $(seq 1 120); do
  sleep 5
  ST=$(curl -s --max-time 8 "http://127.0.0.1:${PORT}/api/session-conductor/list" 2>/dev/null | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{const b=JSON.parse(r);const s=(b.sessions||[]).find(x=>x.id===process.argv[1]);console.log(JSON.stringify(s&&{running:s.running,interruption:s.interruption,continueRunning:s.continueRunning}));}catch(e){console.log("LIST-ERR");}})' "$BOOT_SID")
  case "$ST" in
*'"running":false,"interruption":null'*|*'"interruption":null,continueRunning":false'*)
      CONTINUED=1; say "自动续跑完成：interruption 已清除（第 $((i*5))s）"; break;;
    LIST-ERR) say "列表暂不可读（$ST）";;
    *) say "等待中… $ST";;
  esac
done

# ---------- 阶段 3：验证 ----------
ATTACHED=$(rpc host.describe "{}" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{console.log(JSON.parse(r).result.value.attachedSessions);}catch(e){console.log("?");}})')
say "重启后 attachedSessions=$ATTACHED"
DOMAIN_FILE="$TEST_HOME/storages/dsh-session-conductor.json"
say "插件记账文件:"
cat "$DOMAIN_FILE" 2>/dev/null | head -40
say "会话日志尾部（续跑后）:"
F=$(find "$TEST_HOME/sessions" -name "session.jsonl.zstd" -path "*$BOOT_SID*" 2>/dev/null | head -1)
say "log file: $F"

if [ "$CONTINUED" = "1" ]; then
  say "✅ E2E PASS：崩溃 → 重启 → 自动续跑完成"
else
  say "❌ E2E FAIL：未见自动续跑完成"
  tail -30 "$LOG"
fi

# 清理：把实例停掉（沙箱也会回收，这里显式停）
stop_dsh TERM
sleep 2
say "done"
