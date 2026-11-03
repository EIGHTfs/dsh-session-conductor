// `tool-call.arguments` 形态修复（sessions/arguments-repair.js）单测
//
// 【为什么这些断言值钱】这个修复是"把存错的形态改成契约要求的字符串"，
// 一旦改错（少改 / 改坏结构 / 动了不该动的字段），会话不是打不开就是内容被篡改。
// 所以逐条钉死：只动 arguments、只动 assistant/message、seq 不动、幂等。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toArgumentsString, findToolCallArgumentIssues, repairToolCallArguments,
} from '../../lib/sessions/arguments-repair.js';

/** 一条带 tool-call 的 assistant 消息。 */
function assistantWith(argumentsValue, extra = {}) {
  return {
    type: 'assistant/message',
    seq: 28,
    time: 1,
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool-call', id: 'call_1', name: 'bash', arguments: argumentsValue },
        ],
      },
      ...extra,
    },
  };
}

test('toArgumentsString：对象/数组/数字序列化成 JSON，字符串原样返回', () => {
  assert.deepEqual(toArgumentsString('{"a":1}'), { ok: true, text: '{"a":1}' });
  assert.deepEqual(toArgumentsString({ command: 'ls' }), { ok: true, text: '{"command":"ls"}' });
  assert.deepEqual(toArgumentsString({}), { ok: true, text: '{}' });
  assert.deepEqual(toArgumentsString([1, 2]), { ok: true, text: '[1,2]' });
  assert.deepEqual(toArgumentsString(123), { ok: true, text: '123' });
  assert.deepEqual(toArgumentsString(null), { ok: true, text: 'null' });
});

test('toArgumentsString：缺字段与 NaN 如实拒绝，不硬造内容', () => {
  assert.equal(toArgumentsString(undefined).ok, false);
  assert.equal(toArgumentsString(Number.NaN).ok, false);
});

test('findToolCallArgumentIssues：同时报助手侧与调用侧，且不误报 tool/result', () => {
  const events = [
    assistantWith({ command: 'ls' }),          // 坏：对象
    { type: 'assistant/message', seq: 29, data: { message: { role: 'assistant', content: [
      { type: 'text', text: '纯文本，不含 tool-call' },
    ] } } },
    { type: 'assistant/message', seq: 30, data: { message: { role: 'assistant', content: [
      { type: 'tool-call', id: 'call_2', name: 'glob', arguments: '{"pattern":"*"}' },   // 好：字符串
    ] } } },
    { type: 'tool/result', seq: 31, data: { message: { role: 'tool', content: [
      { type: 'tool-call', id: 'call_3', name: 'x', arguments: {} },                     // 不在 assistant 里，不算
    ] } } },
  ];
  const issues = findToolCallArgumentIssues(events);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].seq, 28);
  assert.equal(issues[0].name, 'bash');
  assert.equal(issues[0].shape, 'object');
  assert.equal(issues[0].callId, 'call_1');
  assert.equal(issues[0].where, 'assistant/message');
  // 追加一条调用侧坏块：必须一起被查出来，否则漏修会变成 corrupt
  const withCall = findToolCallArgumentIssues([
    { type: 'tool/call', seq: 32, data: { callId: 'call_9', name: 'bash', arguments: { a: 1 } } },
  ]);
  assert.equal(withCall.length, 1);
  assert.equal(withCall[0].where, 'tool/call');
  assert.equal(withCall[0].callId, 'call_9');
});

test('findToolCallArgumentIssues：null / 数组 也识别为坏形态并标明形状', () => {
  const issues = findToolCallArgumentIssues([assistantWith(null), assistantWith([1])]);
  assert.deepEqual(issues.map((issue) => issue.shape), ['null', 'array']);
});

test('repairToolCallArguments：把对象改成 JSON 字符串，且不动其它字段', () => {
  const original = assistantWith({ command: 'echo hi' });
  const { events, fixes, skipped } = repairToolCallArguments([original]);
  const block = events[0].data.message.content[1];
  assert.equal(block.arguments, '{"command":"echo hi"}', 'arguments 应被序列化');
  assert.equal(block.id, 'call_1', 'id 不能变');
  assert.equal(block.name, 'bash', 'name 不能变');
  assert.equal(events[0].seq, 28, 'seq 不能变');
  assert.equal(events[0].data.message.content[0].text, '好的', '其它块不能变');
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].from, 'object');
  assert.equal(skipped.length, 0);
  // 入参不得被就地修改
  assert.deepEqual(original.data.message.content[1].arguments, { command: 'echo hi' });
});

test('repairToolCallArguments：已经是字符串的会话原样返回（幂等）', () => {
  const clean = assistantWith('{"command":"ls"}');
  const { events, fixes } = repairToolCallArguments([clean]);
  assert.equal(fixes.length, 0);
  assert.equal(events[0], clean, '没有坏块时应返回同一引用，避免无谓重写');
});

test('repairToolCallArguments：缺字段的块跳过并如实记录原因', () => {
  const event = assistantWith(undefined);
  delete event.data.message.content[1].arguments;
  const { fixes, skipped } = repairToolCallArguments([event]);
  assert.equal(fixes.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /缺失/);
});

// ── 两侧一致性（宿主加载时严格比较 assistant 声明与 tool/call 事件）──────────
//
// 实测事故：只改助手侧会让日志变成 corrupt —— 宿主的 relationships 校验用
// `pending.arguments !== data.arguments` 严格比较，两侧必须逐字符相同。

/** 一条 tool/call 事件（实际发起的调用）。 */
function toolCallEvent(callId, name, argumentsValue, seq = 29) {
  return { type: 'tool/call', seq, time: 2, data: { turn: 1, step: 1, callId, name, arguments: argumentsValue } };
}

test('两侧都是对象时，一并改成同一个字符串', () => {
  const assistant = assistantWith({ command: 'ls' });          // seq=28, callId=call_1
  const call = toolCallEvent('call_1', 'bash', { command: 'ls' });
  const { events, fixes } = repairToolCallArguments([assistant, call]);
  const blockArgs = events[0].data.message.content[1].arguments;
  const callArgs = events[1].data.arguments;
  assert.equal(blockArgs, '{"command":"ls"}');
  assert.equal(callArgs, '{"command":"ls"}');
  assert.equal(blockArgs, callArgs, '两侧必须逐字符相同');
  assert.equal(fixes.filter((f) => f.where === 'assistant/message').length, 1);
  assert.equal(fixes.filter((f) => f.where === 'tool/call').length, 1);
});

test('助手侧已是字符串、调用侧仍是对象时，用助手侧的值对齐', () => {
  const assistant = assistantWith('{"command":"pwd"}');        // 已合规
  const call = toolCallEvent('call_1', 'bash', { command: 'pwd' });
  const { events, fixes } = repairToolCallArguments([assistant, call]);
  assert.equal(events[1].data.arguments, '{"command":"pwd"}', '应对齐到助手侧同一个字符串');
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].where, 'tool/call');
});

test('两侧都合规时不产生任何改动', () => {
  const assistant = assistantWith('{"a":1}');
  const call = toolCallEvent('call_1', 'bash', '{"a":1}');
  const { events, fixes } = repairToolCallArguments([assistant, call]);
  assert.equal(fixes.length, 0);
  assert.equal(events[0], assistant, '无坏块时保持原引用');
  assert.equal(events[1], call);
});
