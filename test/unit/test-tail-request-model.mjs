// readLastRequestModel 的尾部窗口回归。
//
// 背景：判定「成员实际在用哪个模型」只认日志里的 `request/header`（请求级权威记录）。
// 旧实现只解码**最后 8 帧**，而一个回合常有上百个事件（step/tool/assistant 各占一帧），
// 请求头往往落在倒数几十帧之外 ⇒ 会把「跑过很多轮」的会话误报成「从未运行过」。
// 实测：某成员日志有 65 条 request/header，最后一次在 seq 8158、末尾 seq 8247，
// 旧实现返回 null，切换回执因此显示「会话日志里还没有 request/header 记录」。
//
// 现策略：尾部窗口提到 400 帧；仍无命中则退回全量流式扫描（复用 sessions/log-stream.js）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSessionText } from '../../lib/repair.js';
import { readLastRequestModel } from '../../lib/features/member-model/switch.js';

const SID = 'session-tail-window';

/** 造一个会话日志：header + 事件，返回 sessions 根目录。 */
async function makeSession(t, events) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tail-'));
  t.after(() => { /* 临时目录交给系统回收 */ });
  const dir = join(root, '--g--', SID);
  mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id: SID, cwd: '/tmp/demo', createdAt: 1 };
  const lines = [JSON.stringify(header)];
  events.forEach((e, i) => lines.push(JSON.stringify({ seq: i, time: 1000 + i, ...e })));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), await encodeSessionText(lines.join('\n') + '\n'));
  return root;
}

const hdr = (provider, model) => ({
  type: 'request/header',
  data: {
    header: {
      config: { provider, model },
      // 头部只需要 config 一节；其余字段读取方不依赖
      tools: [],
      availableToolNames: [],
      reasoningEffort: null,
      maxTokens: null,
    },
  },
});

test('请求头远在尾部窗口之外时仍能读到（旧实现只扫 8 帧会漏）', async (t) => {
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '干活' }] } },
    hdr('sa6400', 'cn:deepseek-v4.1-flash'),
  ];
  // 之后塞 600 个事件，把请求头挤到倒数 600+ 帧的位置
  for (let i = 0; i < 600; i += 1) {
    events.push({ type: 'step/start', data: { step: i + 1 } });
    events.push({ type: 'tool/result', data: { ok: true, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } } });
  }
  const root = await makeSession(t, events);

  const r = await readLastRequestModel(SID, root);
  assert.ok(r.lastRequest, '应读到 request/header，而不是 null');
  assert.equal(r.lastRequest.provider, 'sa6400');
  assert.equal(r.lastRequest.model, 'cn:deepseek-v4.1-flash');
});

test('取的是最后一条 request/header（多次切换后不返回旧的）', async (t) => {
  const events = [
    { type: 'turn/start', data: {} },
    hdr('ccc', 'deepseek-v4.1-flash'),
    { type: 'turn/end', data: {} },
    { type: 'turn/start', data: {} },
    hdr('sa6400', 'global:deepseek-v4.1-flash'),
  ];
  const root = await makeSession(t, events);
  const r = await readLastRequestModel(SID, root);
  assert.equal(r.lastRequest.provider, 'sa6400', '应取最后一条');
  assert.equal(r.lastRequest.model, 'global:deepseek-v4.1-flash');
});

test('日志里从没有请求头时如实返回 null（不编造）', async (t) => {
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '还没跑过' }] } },
  ];
  const root = await makeSession(t, events);
  const r = await readLastRequestModel(SID, root);
  assert.equal(r.lastRequest, null, '没有就返回 null');
});

test('找不到日志文件时返回空结果而不是抛错', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tail-empty-'));
  t.after(() => { /* 交给系统回收 */ });
  const r = await readLastRequestModel('session-not-exist', root);
  assert.equal(r.lastRequest, null);
  assert.equal(r.scanned, 0);
});
