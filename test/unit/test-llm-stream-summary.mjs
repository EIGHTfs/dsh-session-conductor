// lib/shared/llm-stream-summary.js 单测（真实 chunk 序列构造，不依赖宿主）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStream, summarizeStream, classifyThrown } from "../../lib/shared/llm-stream-summary.js";

async function* fake(chunks) { for await (const c of chunks) yield c; }
const textChunks = (t) => ([
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: t },
  { type: 'block-end', index: 0, block: { type: 'text', text: t } },
  { type: 'finish', reason: { kind: 'stop' } },
]);

test('正常流：折叠出 text/blocks/finishKind', async () => {
  const r = await summarizeStream(fake(textChunks('{"changed":true}')));
  assert.equal(r.ok, true);
  assert.equal(r.text, '{"changed":true}');
  assert.equal(r.blocks.length, 1);
});

test('429 限流：finish.error 被分类为 failed，带 code/status/retryAfterMs，绝不表现为「解析失败」', async () => {
  const r = await summarizeStream(fake([
    { type: 'finish', reason: { kind: 'error', failure: { message: 'Too Many Requests', code: 'RATE_LIMITED', status: 429, providerRetryAfterMs: 30000 } } },
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'failed');
  assert.equal(r.code, 'RATE_LIMITED');
  assert.equal(r.status, 429);
  assert.equal(r.retryAfterMs, 30000);
});

test('max-tokens 截断单列一类（与 failed、解析失败区分）', async () => {
  const r = await summarizeStream(fake([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考思考…' } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'truncated');
  assert.equal(r.code, 'MAX_TOKENS');
  assert.equal(r.reasoning, '思考思考…');
});

test('aborted finish 归为 failed/ABORTED', async () => {
  const r = await summarizeStream(fake([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'user stop', code: 'ABORTED' } } }]));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'failed');
});

test('流抛 TimeoutError → classifyThrown 标 TIMEOUT', async () => {
  const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const r = await summarizeStream(fake((async function* () { throw err; })()));
  assert.equal(r.code, 'TIMEOUT');
  assert.equal(r.timeout, true);
});

test('classifyThrown 对 AbortError/普通错误给稳定 code', () => {
  assert.equal(classifyThrown(Object.assign(new Error('x'), { name: 'AbortError' })).code, 'ABORTED');
  assert.equal(classifyThrown(new Error('boom')).code, 'STREAM_THREW');
});

test('空流（只有 stop）：ok=true 且 text 为空，由调用方判定「内容为空」', async () => {
  const r = await summarizeStream(fake([{ type: 'finish', reason: { kind: 'stop' } }]));
  assert.equal(r.ok, true);
  assert.equal(r.text, '');
});
