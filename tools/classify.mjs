// 诊断：用插件自己的 interruptionInfo/isAutoEligible 分类真实会话。
// 用法: zstd -dc <session.jsonl.zstd> | node classify.mjs <sessionId>
import { interruptionInfo, isAutoEligible } from "./lib/index.js";

const sessionId = process.argv[2] ?? "?";
let raw = "";
for await (const chunk of process.stdin) raw += chunk.toString("utf8");
const events = [];
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t) continue;
  try {
    const record = JSON.parse(t);
    if (Array.isArray(record)) events.push(...record);
    else events.push(record);
  } catch {}
}
const info = interruptionInfo(events);
const eligible = isAutoEligible(info);
const last = events.filter((e) => e?.type === "turn/end" || e?.type === "turn/start").at(-1);
console.log(JSON.stringify({
  sessionId,
  eventCount: events.length,
  lastBoundary: last ? { type: last.type, seq: last.seq, reason: last.type === "turn/end" ? last.data?.reason : null } : null,
  info,
  autoEligible: eligible
}, null, 1));
