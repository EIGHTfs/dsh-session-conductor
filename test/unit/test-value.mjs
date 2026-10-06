/**
 * dsh-session-conductor — 会话价值分析单测（纯函数）
 *
 * 覆盖：
 *   1. lastAssistantText / lastUserText：文本提取（含跳过系统注入）
 *   2. classifySessionValue：✅ 完成 → completed；⚠️ 未完成 → unfinished；
 *      中断 → unfinished；旧时间 → stale；近期 → active
 *   3. summarizeText：截断 / 空白压缩
 *   4. analyzeSessionValues：批量分类统计
 * 运行：node test-value.mjs
 */

import assert from "node:assert";
import { lastAssistantText, lastUserText, classifySessionValue, summarizeText, analyzeSessionValues, mapValuePriority, analyzeSessionValuesWithPriority } from "../../lib/value.js";

let passed = 0;
const fails = [];

function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { fails.push({ name, error: e }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const now = new Date("2026-08-19T00:00:00+08:00");
const day = 24 * 3600 * 1000;

console.log('\n[1] lastAssistantText');
ok('assistant/chunk text 提取（data.chunk 结构）', () => {
  const events = [
    { type: "user/message", data: { content: [] } },
    { type: "assistant/chunk", data: { chunk: { blockType: "reasoning", text: "推理" } } },
    { type: "assistant/chunk", data: { chunk: { blockType: "text", text: "最后回复内容" } } },
  ];
  assert.strictEqual(lastAssistantText(events), "最后回复内容");
});
ok('空事件 → 空串', () => { assert.strictEqual(lastAssistantText([]), ""); });
ok('非数组 → 空串', () => { assert.strictEqual(lastAssistantText(null), ""); });
ok('只有用户消息 → 空串（无 assistant 输出）', () => {
  const events = [{ type: "user/message", data: { content: [] } }];
  assert.strictEqual(lastAssistantText(events), "");
});
ok('assistant/message 数组内容提取（data.message.content）', () => {
  const events = [
    { type: "user/message", data: {} },
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "A" }, { type: "tool_call", name: "x" }, { type: "text", text: "B" }] } } },
  ];
  assert.strictEqual(lastAssistantText(events), "A\nB");
});

console.log('\n[1b] lastUserText');
ok('最后用户消息提取（跳过系统注入）', () => {
  const events = [
    { type: "user/message", data: { content: [{ type: "text", text: "Current runtime context. This snapshot supersedes..." }] } },
    { type: "assistant/message", data: { message: { content: [] } } },
    { type: "user/message", data: { content: [{ type: "text", text: "帮我分析一下会话" }] } },
  ];
  assert.strictEqual(lastUserText(events), "帮我分析一下会话");
});
ok('全是系统注入 → 空串', () => {
  const events = [
    { type: "user/message", data: { content: [{ type: "text", text: "Current runtime context. xxx" }] } },
  ];
  assert.strictEqual(lastUserText(events), "");
});
ok('无 user/message → 空串', () => {
  assert.strictEqual(lastUserText([]), "");
  assert.strictEqual(lastUserText(null), "");
});

console.log('\n[2] classifySessionValue');
ok('✅ 任务完成 + ═ → completed', () => {
  const s = { id: "s1", updatedAt: now.getTime() };
  const r = classifySessionValue(s, "做完了。\n══════════\n✅ 任务完成\n交付：xxx", now, 3);
  assert.strictEqual(r.status, "completed");
});
ok('✅ 已解答（无 ═）→ 非 completed（约定需分隔线）', () => {
  const s = { id: "s2", updatedAt: now.getTime() };
  const r = classifySessionValue(s, "✅ 已解答", now, 3);
  assert.notStrictEqual(r.status, "completed");
});
ok('⚠️ 未完成 → unfinished', () => {
  const s = { id: "s3", updatedAt: now.getTime() };
  const r = classifySessionValue(s, "⚠️ 未完成，还需继续", now, 3);
  assert.strictEqual(r.status, "unfinished");
});
ok('interruption 非空 → unfinished', () => {
  const s = { id: "s4", updatedAt: now.getTime(), interruption: { kind: "interrupted" } };
  const r = classifySessionValue(s, "正在处理…", now, 3);
  assert.strictEqual(r.status, "unfinished");
});
ok('很久未活动（>3 天）→ stale', () => {
  const s = { id: "s5", updatedAt: now.getTime() - 5 * day };
  const r = classifySessionValue(s, "一些历史内容", now, 3);
  assert.strictEqual(r.status, "stale");
});
ok('近期活动无标记 → active', () => {
  const s = { id: "s6", updatedAt: now.getTime() - 3600 * 1000 };
  const r = classifySessionValue(s, "正在进行中", now, 3);
  assert.strictEqual(r.status, "active");
});

console.log('\n[3] summarizeText');
ok('短文本原样返回', () => { assert.strictEqual(summarizeText("你好"), "你好"); });
ok('超长截断加省略号', () => {
  const r = summarizeText("x".repeat(200), 140);
  assert.strictEqual(r.length, 141);
  assert.ok(r.endsWith("…"));
});
ok('换行与连续空白压缩', () => {
  assert.strictEqual(summarizeText("a\n\nb   c"), "a b c");
});

console.log('\n[4] analyzeSessionValues');
ok('批量分类统计', () => {
  const sessions = [
    { id: "c1", title: "完成会话", updatedAt: now.getTime() },
    { id: "u1", title: "未完成会话", updatedAt: now.getTime() },
    { id: "s1", title: "旧会话", updatedAt: now.getTime() - 5 * day },
    { id: "a1", title: "活跃会话", updatedAt: now.getTime() - 1000 },
  ];
  const texts = {
    c1: "════\n✅ 任务完成\n交付：完成",
    u1: "⚠️ 未完成",
    s1: "旧内容",
    a1: "进行中",
  };
  const r = analyzeSessionValues(sessions, texts, {}, now, 3);
  assert.strictEqual(r.completed.length, 1);
  assert.strictEqual(r.unfinished.length, 1);
  assert.strictEqual(r.stale.length, 1);
  assert.strictEqual(r.active.length, 1);
  assert.strictEqual(r.completed[0].title, "完成会话");
});

// ---------- LLM 高/低价值合成（待办 #2） ----------
console.log('\n[5] mapValuePriority（LLM 打分 → 高/低价值）');
ok('LLM high → high', () => {
  const r = mapValuePriority("active", "high", "独特资产");
  assert.strictEqual(r.value, "high");
  assert.strictEqual(r.source, "llm");
  assert.strictEqual(r.reason, "独特资产");
});
ok('LLM low → low（即使 active）', () => {
  assert.strictEqual(mapValuePriority("active", "low").value, "low");
});
ok('LLM medium + unifinished → high（宁高不丢）', () => {
  assert.strictEqual(mapValuePriority("unfinished", "medium").value, "high");
});
ok('LLM medium + stale → low', () => {
  assert.strictEqual(mapValuePriority("stale", "medium").value, "low");
});
ok('无 LLM + active → high', () => {
  assert.strictEqual(mapValuePriority("active").value, "high");
});
ok('无 LLM + completed → low', () => {
  assert.strictEqual(mapValuePriority("completed").value, "low");
});
ok('映射器对非法 LLM 值返回对象且降级', () => {
  const r = mapValuePriority("active", null);
  assert.ok(r && typeof r.value === "string");
});

console.log('\n[6] analyzeSessionValuesWithPriority（聚合）');
ok('规则：活跃高价值 / 超期低价值', () => {
  const sessions = [
    { id: "a", title: "活跃", updatedAt: now.getTime() - 1000 },
    { id: "b", title: "超期", updatedAt: now.getTime() - 10 * day },
  ];
  const r = analyzeSessionValuesWithPriority(sessions, { a: "正在做", b: "旧内容" }, { a: "", b: "" }, {}, now, 3);
  assert.strictEqual(r.high[0].id, "a");
  assert.strictEqual(r.low[0].id, "b");
});
ok('LLM 打分覆盖规则 status', () => {
  const sessions = [{ id: "x", title: "旧", updatedAt: now.getTime() - 10 * day }]; // 规则 stale→low
  const r = analyzeSessionValuesWithPriority(sessions, { x: "旧" }, { x: "" }, { x: { value: "high", reason: "含珍贵笔记" } }, now, 3);
  assert.strictEqual(r.high[0].id, "x");
  assert.strictEqual(r.high[0].source, "llm");
  assert.strictEqual(r.low.length, 0);
});
ok('返回含全部键', () => {
  const sessions = [{ id: "a", title: "T", updatedAt: now.getTime() - 1000 }];
  const r = analyzeSessionValuesWithPriority(sessions, { a: "x" }, { a: "" }, {}, now, 3);
  for (const k of ["completed", "unfinished", "stale", "active", "high", "low"]) {
    assert.ok(k in r, `缺 ${k}`);
  }
});
ok('LLM 打分对缺失会话不影响规则统计', () => {
  const sessions = [
    { id: "c1", title: "完成", updatedAt: now.getTime() },
    { id: "a1", title: "活跃", updatedAt: now.getTime() - 1000 },
  ];
  const r = analyzeSessionValuesWithPriority(
    sessions, { c1: "══=\n✅ 任务完成", a1: "进行中" }, {},
    { c1: { value: "high", reason: "关键产出" } }, now, 3
  );
  assert.strictEqual(r.completed[0].title, "完成"); // 规则 completed 仍在
  assert.strictEqual(r.high[0].id, "c1"); // LLM 覆盖为 high
});

// ---------- 汇总 ----------
console.log(`\n结果: ${passed} 通过, ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.error(`\n[FAIL] ${f.name}\n  ${f.error.stack || f.error}`);
  process.exit(1);
}
