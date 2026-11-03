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

test('findToolCallArgumentIssues：只挑出非字符串的 tool-call 块', () => {
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
