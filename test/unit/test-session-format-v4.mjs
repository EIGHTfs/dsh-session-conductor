// 会话格式 v3 / v4 双形态校验 —— 直接 import 纯模块的单测。
//
// 背景（2026-10-14 修的真实 bug）：插件按 v3 开发，校验写死 tool/result 的
//   message.role === "user"。DSH 升到 0.2.1 后引入 v4（first-class tool-role：
//   role = "tool"、toolCallId 提升到 message 层、content 不再有 tool-result wrapper），
//   导致所有 v4 会话被误判「role 应为 user」→ 依赖「写入前先校验」的功能必然失败
//   （如 set_member_model 对未挂载成员写 model/selection 事件）。
// 官方口径：packages/session/session-format-v3-to-v4/src/tool-role.ts 的 assertV4ToolResultMessage。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSessionText } from '../../lib/repair.js';

const HEADER = JSON.stringify({ type: 'session', version: 3, id: 'sess-test' });

/** v3 形态的 tool/result 事件（role="user" + content[0] 是 tool-result wrapper） */
function v3Event(seq, callId = 'call-1') {
  return JSON.stringify({
    type: 'tool/result',
    seq,
    time: 1,
    data: {
      message: {
        id: 'msg-' + seq,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }],
      },
    },
  });
}

/** v4 形态的 tool/result 事件（role="tool"、toolCallId 在 message 层、content 无 wrapper） */
function v4Event(seq, callId = 'call-1', extra = {}) {
  return JSON.stringify({
    type: 'tool/result',
    seq,
    time: 1,
    data: {
      message: {
        id: 'msg-' + seq,
        role: 'tool',
        toolCallId: callId,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: 'ok' }],
        ...extra,
      },
    },
  });
}

/** 组装一份最小合法日志（header + 事件行） */
function logWith(...lines) {
  return [HEADER, ...lines].join('\n') + '\n';
}

// ---------- v4（新格式，本次修复目标） ----------

test('v4：role="tool" 的 tool/result 校验通过', () => {
  const r = validateSessionText(logWith(v4Event(0)));
  assert.equal(r.ok, true, `应通过，实得问题：${JSON.stringify(r.problems)}`);
});

test('v4：真实会话样例（含 isError）通过', () => {
  const r = validateSessionText(logWith(v4Event(0, 'call-9', { isError: true })));
  assert.equal(r.ok, true, `应通过，实得：${JSON.stringify(r.problems)}`);
});

test('v4：toolCallId 与 source.callId 不匹配 → 报错', () => {
  const bad = JSON.parse(v4Event(0, 'call-1'));
  bad.data.message.toolCallId = 'call-OTHER';
  const r = validateSessionText(logWith(JSON.stringify(bad)));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /v4 toolCallId 与 source\.callId 不匹配/);
});

test('v4：content 里仍带 tool-result wrapper → 报错（v4 已提升为原生字段）', () => {
  const bad = JSON.parse(v4Event(0));
  bad.data.message.content = [{ type: 'tool-result', toolCallId: 'call-1', content: [] }];
  const r = validateSessionText(logWith(JSON.stringify(bad)));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /v4 content 不应再含 tool-result wrapper/);
});

test('v4：isError 非 boolean → 报错', () => {
  const bad = JSON.parse(v4Event(0));
  bad.data.message.isError = 'yes';
  const r = validateSessionText(logWith(JSON.stringify(bad)));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /v4 isError 必须是 boolean/);
});

test('v4：带 data.error 但 isError 不为 true → 报错', () => {
  const bad = JSON.parse(v4Event(0));
  bad.data.error = { code: 'boom' };
  const r = validateSessionText(logWith(JSON.stringify(bad)));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /v4 带 error 元数据但 isError 不为 true/);
});

// ---------- v3（旧格式，回归：不能被改坏） ----------

test('v3：role="user" + wrapper 仍校验通过（回归）', () => {
  const r = validateSessionText(logWith(v3Event(0)));
  assert.equal(r.ok, true, `回归失败，实得：${JSON.stringify(r.problems)}`);
});

test('v3：role 既非 user 也非 tool → 报错并提示两种合法值', () => {
  const bad = JSON.parse(v3Event(0));
  bad.data.message.role = 'assistant';
  const r = validateSessionText(logWith(JSON.stringify(bad)));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /role 应为 user（v3）或 tool（v4）/);
});

test('v3：content 非数组 → 报错', () => {
  const bad = JSON.parse(v3Event(0));
  bad.data.message.content = 'oops';
  const r = validateSessionText(logWith(JSON.stringify(bad)));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /content 非数组/);
});

// ---------- 共用结构校验（两形态都适用） ----------

test('两种形态都要求 message.id 非空', () => {
  for (const make of [v3Event, v4Event]) {
    const bad = JSON.parse(make(0));
    bad.data.message.id = '';
    const r = validateSessionText(logWith(JSON.stringify(bad)));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /缺 message\.id/);
  }
});

test('两种形态都要求 source.kind === "tool"', () => {
  for (const make of [v3Event, v4Event]) {
    const bad = JSON.parse(make(0));
    bad.data.message.source.kind = 'user';
    const r = validateSessionText(logWith(JSON.stringify(bad)));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /source 非法/);
  }
});
