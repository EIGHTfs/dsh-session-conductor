// 会话撤销核心逻辑单测（undo-core）：切点选择是这功能的命门，必须钉死。
//
// 【为什么这些断言重要】目标事件（用户消息）经常落在回合中间——宿主会在回合运行中
// 把新消息 spliced 进当前 step。直接切会产生「有 turn/start 无 turn/end」的悬挂回合，
// 宿主恢复时要么补 crash-orphaned closer、要么直接判不一致。所以切点必须回退到回合边界。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateCutPoint, buildTruncatedText } from '../../lib/sessions/undo-core.js';

/** 造一段带回合结构的事件序列：turn1 完整闭合 → turn2 中途插入用户消息。 */
function fixture() {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1000, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: 1100, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 3, time: 1100, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 5, time: 2000, data: { turn: 2 } },
    { type: 'step/start', seq: 6, time: 2000, data: { turn: 2, step: 1 } },
    { type: 'user/message', seq: 7, time: 2100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把声明补上' }] } },
    { type: 'assistant/message', seq: 8, time: 2200, data: { turn: 2, step: 1 } },
    { type: 'step/end', seq: 9, time: 2200, data: { turn: 2, step: 1 } },
  ];
}

test('atSeq 精确命中；切点回退到该消息之前的 turn/end', () => {
  const r = locateCutPoint(fixture(), { atSeq: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.target.seq, 7);
  assert.equal(r.cut.seq, 4, '应回退到 turn 1 的 turn/end');
  assert.equal(r.closer, null, '落在回合边界上不需要补 closer');
  assert.equal(r.removedEventCount, 5, 'seq 5..9 共 5 条被删');
});

test('matchText 只认真实用户消息（注入内容不算）', () => {
  const events = fixture();
  // 注入消息也含同样的文本，但 source.kind 是 plugin —— 不能被当成用户消息撤销
  events.splice(5, 0, {
    type: 'user/message', seq: 5.5, time: 1900,
    data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '把声明补上' }] },
  });
  const r = locateCutPoint(events, { matchText: '把声明补上' });
  assert.equal(r.ok, true);
  assert.equal(r.target.seq, 7, '应命中真实用户消息而不是注入');
});

test('matchText 找不到时报错而不是乱切', () => {
  const r = locateCutPoint(fixture(), { matchText: '不存在的文本' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'text-not-found');
});

test('没有 turn/end 可退时，退到 step/end 并给一条 turn/end closer', () => {
  // 移除所有 turn/end：模拟「该会话首个回合尚未闭合」的极端情形
  const events = fixture().filter((e) => e.type !== 'turn/end');
  const r = locateCutPoint(events, { atSeq: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.cut.type, 'step/end', '应退到最近已闭合的 step/end');
  assert.equal(r.cut.seq, 3, '最近已闭合的 step/end 是 seq 3（turn 1 step 1）');
  assert.ok(r.closer, '必须补 closer');
  assert.equal(r.closer.type, 'turn/end');
  assert.equal(r.closer.data.turn, 1, 'turn 号取被截断 step 的 turn');
  assert.equal(r.closer.data.reason.kind, 'aborted');
  assert.equal(r.closer.seq, r.cut.seq + 1, 'closer 的 seq 必须紧接切点');
});

test('什么都不给 = 最后一条真实用户消息', () => {
  const r = locateCutPoint(fixture(), {});
  assert.equal(r.ok, true);
  assert.equal(r.target.seq, 7);
});

test('seq 不存在 / 空列表 都如实报错', () => {
  assert.equal(locateCutPoint(fixture(), { atSeq: 999 }).error.code, 'seq-not-found');
  assert.equal(locateCutPoint([], {}).error.code, 'empty');
});

test('buildTruncatedText：header 原样保留、截断到切点、closer 排在末尾', () => {
  const events = fixture();
  const header = '{"type":"session","id":"s1"}';
  // 无 closer
  const plain = buildTruncatedText(header, events, 4, null);
  const plainLines = plain.split('\n').filter((l) => l !== '');
  assert.equal(plainLines[0], header);
  assert.equal(plainLines.length, 6, 'header + seq 0..4');
  assert.equal(JSON.parse(plainLines.at(-1)).seq, 4);
  // 带 closer
  const withCloser = buildTruncatedText(header, events, 4, { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  const closerLines = withCloser.split('\n').filter((l) => l !== '');
  assert.equal(JSON.parse(closerLines.at(-1)).type, 'turn/end');
  assert.equal(JSON.parse(closerLines.at(-1)).seq, 5);
  assert.ok(withCloser.endsWith('\n'), '文本应以换行结尾');
});
