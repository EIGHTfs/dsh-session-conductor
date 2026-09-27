#!/usr/bin/env python3
# 修复 dsh-session-conductor task_completion_* 工具造成的日志损坏：
# tool/result 事件的 tool-result 块 content 是纯字符串（旧版 render 返回字符串），
# DSH 持久化校验器要求其为块数组 → 会话 history unavailable。
# 修复 = 把字符串 content 包成 [{type:"text", text}]。
# 用法: zstd -d -c <in.zstd> | python3 fix-tool-result-content.py > fixed.jsonl
import sys, json

fixed = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        print()
        continue
    try:
        r = json.loads(line)
    except Exception:
        print(line)
        continue
    records = r if isinstance(r, list) else [r]
    changed = False
    for e in records:
        if not isinstance(e, dict) or e.get("type") != "tool/result":
            continue
        data = e.get("data")
        message = (data or {}).get("message") if isinstance(data, dict) else None
        content = (message or {}).get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool-result" and isinstance(b.get("content"), str):
                b["content"] = [{"type": "text", "text": b["content"]}]
                changed = True
                fixed += 1
    if isinstance(r, list):
        print(json.dumps(records, ensure_ascii=False))
    else:
        print(json.dumps(records[0], ensure_ascii=False))
print(f"# fixed {fixed} tool-result block(s)", file=sys.stderr)
