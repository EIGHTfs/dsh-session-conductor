// dsh-session-conductor 会话修复模块单测。
// 运行：node test-repair.mjs（需 workspace/node_modules 软链到 app node_modules）
import assert from "node:assert/strict";
import { validateSessionText, fixToolResultStringContent, encodeSessionText } from "../../lib/repair.js";
import { decodeAllFrames } from "../../lib/zstd-frames.js";

const ev = (type, data, seq) => JSON.stringify({ type, seq, time: 1, data });

// ---------- validateSessionText ----------
const goodHeader = JSON.stringify({ type: "session", version: 0, id: "session-x", createdAt: 1, cwd: "/tmp", delegationDepth: 0 });
const goodToolResult = ev("tool/result", {
  message: {
    id: "m1",
    role: "user",
    source: { kind: "tool", callId: "call-1" },
    content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "ok" }], isError: false }]
  }
}, 0);
const badToolResult = ev("tool/result", {
  message: {
    id: "m2",
    role: "user",
    source: { kind: "tool", callId: "call-2" },
    content: [{ type: "tool-result", toolCallId: "call-2", content: "字符串内容", isError: false }]
  }
}, 1);

{
  const ok = validateSessionText(`${goodHeader}\n${goodToolResult}\n`);
  assert.equal(ok.ok, true, "健康日志通过");
  assert.equal(ok.eventCount, 1);
}
{
  const bad = validateSessionText(`${goodHeader}\n${goodToolResult}\n${badToolResult}\n`);
  assert.equal(bad.ok, false, "字符串 content 被检出");
  assert.ok(bad.problems.some((p) => p.includes("必须是数组")), "问题描述准确");
}
{
  const empty = validateSessionText("");
  assert.equal(empty.ok, false, "空日志不通过");
}
{
  // 历史损坏：事件帧带尾随空行（旧编码器双换行）→ 扫描器视为 torn
  const torn = validateSessionText(`${goodHeader}\n${goodToolResult}\n\n`);
  assert.equal(torn.ok, false, "尾随空行被检出");
  assert.ok(torn.problems.some((p) => p.includes("空行")), "问题描述为 torn 空行");
  const { fixed, fixedCount } = fixToolResultStringContent(`${goodHeader}\n${goodToolResult}\n\n`);
  assert.equal(fixedCount, 0, "无字符串块可修");
  assert.equal(validateSessionText(fixed).ok, true, "空行被清掉后通过");
}
console.log("validateSessionText: 5 项断言通过");

// ---------- fixToolResultStringContent ----------
{
  const { fixed, fixedCount } = fixToolResultStringContent(`${goodHeader}\n${goodToolResult}\n${badToolResult}\n`);
  assert.equal(fixedCount, 1, "修复 1 个块");
  const revalidated = validateSessionText(fixed);
  assert.equal(revalidated.ok, true, "修复后通过校验");
  // 未变化行保持原样
  assert.ok(fixed.includes(JSON.stringify(JSON.parse(goodHeader))), "header 保持");
}
{
  const { fixedCount } = fixToolResultStringContent(`${goodHeader}\n${goodToolResult}\n`);
  assert.equal(fixedCount, 0, "健康日志零修复");
}
console.log("fixToolResultStringContent: 3 项断言通过");

// ---------- encodeSessionText 往返 ----------
{
  const text = `${goodHeader}\n${goodToolResult}\n${badToolResult}\n`;
  const encoded = await encodeSessionText(text);
  assert.ok(Buffer.isBuffer(encoded) && encoded.length > 0, "编码产出 Buffer");
  // 首帧可解出 header（用 node:zlib 单帧 API 验证首帧独立性）
  const { zstdDecompressSync } = await import("node:zlib");
  const firstFrameText = zstdDecompressSync(encoded).toString("utf8");
  assert.equal(firstFrameText.trim(), goodHeader, "首帧恰好是 header 行");
  // 整文件多帧解码走 node:zlib（lib/zstd-frames.js 的 decodeAllFrames），
  // 不依赖系统 zstd 命令，也不再需要临时文件。
  const decoded = await decodeAllFrames(encoded);
  assert.equal(decoded, `${goodHeader}\n${goodToolResult}\n${badToolResult}\n`, "整文件解码与原文一致");
}
console.log("encodeSessionText: 3 项断言通过");
console.log("ALL PASS");
