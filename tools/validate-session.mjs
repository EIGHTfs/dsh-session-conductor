#!/usr/bin/env node
// 离线校验会话日志是否通过 DSH 持久化校验器（assertMessageEventShape 等价复刻）。
// 用法: node validate-session.mjs <session.jsonl.zstd>
// 退出码: 0 = 校验通过, 1 = 校验失败
import { readFileSync } from "node:fs";
import { decodeStorageRecord } from "../lib/session-codec.js";
import { decodeAllFrames } from "../lib/zstd-frames.js";

const file = process.argv[2];
if (!file) { console.error("用法: node validate-session.mjs <session.jsonl.zstd>"); process.exit(2); }

// 多帧 zstd 解码走 Node 自带 node:zlib（lib/zstd-frames.js 的 decodeAllFrames），
// 不依赖系统 zstd 命令（无 zstd CLI 的环境同样可用）。
const plaintext = await decodeAllFrames(readFileSync(file));

const lines = plaintext.split("\n").filter((l) => l.trim() !== "");
const problems = [];

// 1. 首行必须是 header
let header;
try { header = JSON.parse(lines[0]); } catch { problems.push("首行不是合法 JSON"); }
if (header?.type !== "session") problems.push("首行不是 session header");
if (lines.length < 2) problems.push("日志为空（只有 header）");

// 2. 逐事件解析 + seq 连续性 + tool/result 消息形状
let seq = 0;
const seen = new Set();
for (let i = 1; i < lines.length; i++) {
  let e;
  try { e = JSON.parse(lines[i]); } catch { problems.push(`第 ${i + 1} 行 JSON 解析失败`); continue; }
  // v3 会话格式：一行一个事件，decodeStorageRecord 直接返回单事件（兼容旧格式容器）
  const events = decodeStorageRecord(e);
  for (const ev of events) {
    if (typeof ev?.seq !== "number") { problems.push(`事件缺 seq（${ev?.type ?? "?"}）`); continue; }
    if (ev.seq !== seq) { problems.push(`seq 不连续：期望 ${seq}，实际 ${ev.seq}`); }
    if (seen.has(ev.seq)) problems.push(`seq ${ev.seq} 重复`);
    seen.add(ev.seq);
    seq++;
    if (ev.type !== "tool/result") continue;
    // tool/result 消息形状校验（复刻 assertMessageEventShape）
    const eventData = ev.data;
    const message = eventData?.message;
    if (typeof message !== "object" || message === null || typeof message.id !== "string" || message.id === "") { problems.push(`seq ${ev.seq} tool/result 缺 message.id`); continue; }
    if (message.role !== "user") problems.push(`seq ${ev.seq} tool/result role 应为 user`);
    const source = message.source;
    if (typeof source !== "object" || source === null || source.kind !== "tool" || typeof source.callId !== "string" || source.callId === "") { problems.push(`seq ${ev.seq} tool/result source 非法`); continue; }
    if (!Array.isArray(message.content)) { problems.push(`seq ${ev.seq} tool/result content 非数组`); continue; }
    const block = message.content[0];
    if (message.content.length !== 1 || typeof block !== "object" || block === null || block.type !== "tool-result") { problems.push(`seq ${ev.seq} 必须恰好一个 tool-result 块`); continue; }
    if (!Array.isArray(block.content)) { problems.push(`seq ${ev.seq} tool-result 块 content 必须是数组（当前 ${typeof block.content}）`); continue; }
    if (block.toolCallId !== source.callId) problems.push(`seq ${ev.seq} toolCallId 不匹配`);
  }
}

if (problems.length === 0) {
  console.log(`✅ 校验通过：${seq} 个事件，header OK，seq 连续，tool/result 消息形状合规`);
  process.exit(0);
} else {
  console.log(`❌ 校验失败：${problems.length} 个问题（前 10 个）：`);
  for (const p of problems.slice(0, 10)) console.log("  -", p);
  process.exit(1);
}
