// dsh-session-conductor undoLastMessage 单测（mock ctx：sessions/persistence）。
// 验证「撤回最后一条用户消息 = 截断最后一条用户消息及以后所有消息」：
//   · 冷会话：还原为最后一条用户消息之前的内容，原文件备份 .undo-backup/
//   · 运行中（open turn）：拒绝撤回
//   · dryRun：只预览不写文件
//   · 无用户消息：报 no-user-message
// 运行：node test-undo.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAllFrames } from "../../lib/zstd-frames.js";
import { undoLastMessage } from "../../lib/index.js";
import { encodeSessionText } from "../../lib/repair.js";

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };
const fail = (name, extra) => { console.log("FAIL:", name, extra ?? ""); process.exitCode = 1; };

// ---------- 构造 v3 会话文本 ----------
const evLine = (type, data, seq) => JSON.stringify({ type, seq, time: 1, data });
const headerLine = JSON.stringify({ type: "session", version: 0, id: "session-u", createdAt: 1, cwd: "/w", delegationDepth: 0 });
const userMsg = (text, id) => ({
  id, role: "user", source: { kind: "user" }, content: [{ type: "text", text }],
});
const asstMsg = (text, id) => ({
  id, role: "assistant", content: [{ type: "text", text }],
});
// 事件行序列：m1(用户) → r1(回复) → m2(最后用户) → r2(回复) → m3(最后用户之后又一轮)；v3 规范 seq 从 0 起
const lines = [
  headerLine,
  evLine("user/message", userMsg("第一问", "u1"), 0),
  evLine("assistant", asstMsg("回答一", "a1"), 1),
  evLine("user/message", userMsg("第二问（最后）", "u2"), 2),
  evLine("assistant", asstMsg("回答二", "a2"), 3),
  evLine("user/message", userMsg("后续又问", "u3"), 4),
  evLine("assistant", asstMsg("回答三", "a3"), 5),
];
const srcText = lines.join("\n") + "\n";
const keptText = [headerLine, evLine("user/message", userMsg("第一问", "u1"), 0), evLine("assistant", asstMsg("回答一", "a1"), 1), evLine("user/message", userMsg("第二问（最后）", "u2"), 2), evLine("assistant", asstMsg("回答二", "a2"), 3)].join("\n") + "\n";

function makeCtx({ openTurn = false, artifacts = [] } = {}) {
  const sessionsSvc = {
    get: () => (openTurn
      ? { events: [{ type: "turn/start", seq: 1, data: { turn: 1 } }] }  // open turn：turn/start 无配对的 turn/end
      : null),
  };
  const persistence = {
    listArtifacts: async () => artifacts,
  };
  return { get: (k) => (k === "sessions" ? sessionsSvc : k === "sessionPersistence" ? persistence : undefined) };
}

// ---------- 用例 ----------
const dir = mkdtempSync(join(tmpdir(), "undo-"));
const filePath = join(dir, "session.jsonl.zstd");

// 用例 1：冷会话 → 截断最后一条用户消息及以后所有消息
{
  const encoded = await encodeSessionText(srcText);
  writeFileSync(filePath, encoded);
  const artifacts = [{ header: { id: "session-u" }, path: filePath }];
  const ctx = makeCtx({ artifacts });
  const res = await undoLastMessage(ctx, "session-u");
  assert.equal(res.ok, true, "撤回成功");
  assert.equal(res.preview, "后续又问", "撤回的是会话最后一条用户消息");
  assert.equal(res.removedLineCount, 2, "截断 2 行（最后用户消息 m3 及以后消息 r3）");
  assert.equal(res.removedEventCount, 2, "截断 2 个事件");
  const after = await decodeAllFrames(readFileSync(filePath));
  assert.equal(after.trimEnd(), keptText.trimEnd(), "文件=最后一条用户消息之前的内容");
  // 备份存在
  const baks = readdirSync(join(dir, ".undo-backup"));
  assert.equal(baks.length, 1, "原文件已备份到 .undo-backup/");
  assert.equal((await decodeAllFrames(readFileSync(join(dir, ".undo-backup", baks[0])))).trimEnd(), srcText.trimEnd(), "备份=撤回前原文");
  ok("冷会话：截断最后一条用户消息及以后所有消息，原文件备份");
}

// 用例 2：dryRun 不写文件
{
  writeFileSync(filePath, await encodeSessionText(srcText));
  const artifacts = [{ header: { id: "session-u" }, path: filePath }];
  const ctx = makeCtx({ artifacts });
  const res = await undoLastMessage(ctx, "session-u", { dryRun: true });
  assert.equal(res.ok && res.dryRun, true, "dryRun 返回预览");
  assert.equal(res.preview, "后续又问", "preview = 最后一条用户消息文本");
  assert.equal(res.removedLineCount, 2, "dryRun 也报告截断行数");
  const after = await decodeAllFrames(readFileSync(filePath));
  assert.equal(after.trimEnd(), srcText.trimEnd(), "dryRun 文件未变");
  ok("dryRun：只预览不写文件，preview 正确");
}

// 用例 3：运行中（open turn）拒绝
{
  writeFileSync(filePath, await encodeSessionText(srcText));
  const artifacts = [{ header: { id: "session-u" }, path: filePath }];
  const ctx = makeCtx({ openTurn: true, artifacts });
  const res = await undoLastMessage(ctx, "session-u");
  assert.equal(res.ok, false, "运行中拒绝");
  assert.equal(res.error?.code, "running", "错误码 running");
  const after = await decodeAllFrames(readFileSync(filePath));
  assert.equal(after.trimEnd(), srcText.trimEnd(), "运行中拒绝不改文件");
  ok("运行中（open turn）：拒绝撤回，文件不动");
}

// 用例 4：无用户消息
{
  const onlyAsst = [headerLine, evLine("assistant", asstMsg("只有回复", "a9"), 0)].join("\n") + "\n";
  writeFileSync(filePath, await encodeSessionText(onlyAsst));
  const artifacts = [{ header: { id: "session-u" }, path: filePath }];
  const ctx = makeCtx({ artifacts });
  const res = await undoLastMessage(ctx, "session-u");
  assert.equal(res.ok, false, "无用户消息返回失败");
  assert.equal(res.error?.code, "no-user-message", "错误码 no-user-message");
  ok("无真实用户消息：拒绝并报 no-user-message");
}

// 用例 5：注入内容不算用户消息（source.kind 非 user 不撤回）
{
  const injected = [
    headerLine,
    evLine("user/message", userMsg("真实提问", "ui1"), 0),
    evLine("user/message", { id: "x1", role: "user", source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }, content: [{ type: "text", text: "注入内容" }] }, 1),
  ].join("\n") + "\n";
  writeFileSync(filePath, await encodeSessionText(injected));
  const artifacts = [{ header: { id: "session-u" }, path: filePath }];
  const ctx = makeCtx({ artifacts });
  const res = await undoLastMessage(ctx, "session-u");
  assert.equal(res.ok, true, "撤回成功");
  assert.equal(res.preview, "真实提问", "撤回的是真实用户消息（注入被跳过）");
  const after = await decodeAllFrames(readFileSync(filePath));
  assert.equal(after.trimEnd(), headerLine, "注入行被截断（它位于最后真实用户之后），真实用户消息已撤");
  ok("注入内容（source.kind=plugin）不被当作可撤回的用户消息");
}

// 用例 6：活跃（空闲 live，无 open turn）会话 → detach 后截断，agent 注册表清理
{
  writeFileSync(filePath, await encodeSessionText(srcText));
  const artifacts = [{ header: { id: "session-u" }, path: filePath }];
  const agentStore = new Map([["session-u", { announced: false }]]);
  let detached = false;
  const agentsSvc = {
    get: () => ({ status: "idle", cancel: () => {}, whenIdle: async () => {}, scope: { dispose: async () => { detached = true; } } }),
    store: agentStore,
    emitDisposed: async () => {},
  };
  const sessionsSvc = {
    // 空闲活跃：事件流尾部是 turn/end（hasOpenTurn=false）
    get: () => ({ events: [{ type: "turn/start", seq: 0, data: { turn: 1 } }, { type: "user/message", seq: 1, data: {} }, { type: "turn/end", seq: 2, data: { turn: 1 } }] }),
    flush: async () => {},
    store: new Map(),
  };
  const ctx = {
    get: (k) => (k === "sessions" ? sessionsSvc
      : k === "sessionPersistence" ? { listArtifacts: async () => artifacts }
        : k === "agents" ? agentsSvc : undefined),
  };
  const res = await undoLastMessage(ctx, "session-u");
  assert.equal(res.ok, true, "活跃（空闲）会话撤回成功");
  assert.equal(res.preview, "后续又问", "截断的是最后一条用户消息");
  assert.equal(detached, true, "detach 链路执行（agent scope dispose 被调）");
  assert.equal(agentStore.has("session-u"), false, "agent 已从注册表移除（防 flush 覆盖）");
  const after = await decodeAllFrames(readFileSync(filePath));
  assert.equal(after.trimEnd(), keptText.trimEnd(), "文件=截断后内容");
  ok("活跃（空闲 live）会话：detach 后截断，注册表清理，文件正确");
}

rmSync(dir, { recursive: true, force: true });
console.log(`TEST PASS: ${pass}`);