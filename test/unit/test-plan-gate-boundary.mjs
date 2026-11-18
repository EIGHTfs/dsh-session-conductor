// 方案门禁的判定边界 —— 真人消息识别、确认有效期、bash 写操作启发式。
//
// 三条都是实测踩出来的：
//   ① 「上下文用量」注入行排在用户「确认」之后，被当成最后一条真人消息 ⇒ 确认被顶掉、
//      门禁永远认不出已确认（根因：靠文本前缀白名单识别注入，每加一条注入通道就要改正则）。
//   ② 确认后用户只要再说一句话（包括回答 AI 的追问）确认就失效 ⇒ 一个任务被反复要求确认。
//   ③ `curl -d '{"a":">b"}'` 里引号内的 `>` 被当成重定向 ⇒ 纯网络请求被判成写操作并拒绝。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_ENFORCE_BASH_WRITE_RE,
  planGateAllows,
  planGateAskAnswerText,
  planGateIsHumanMessage,
  stripQuotedForWriteHeuristic,
} from '../../lib/template-inject.js';

/** 造一条 user/message（可指定 source，模拟真人 / 插件注入）。 */
function userMsg(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], ...(source ? { source } : {}) } };
}

/** 造一条 assistant/message。 */
function assistantMsg(text) {
  return { type: 'assistant/message', data: { content: [{ type: 'text', text }] } };
}

/** 一份带双标记的提案（标题锚点 + 确认段锚点）。 */
const PROPOSAL = '# 修改方案提案\n\n## 门禁表\n| 任务 | x |\n\n## 八、是否执行\n请回复确认';

/** 插件注入消息（带 kind，不是 user）。 */
const INJECTED_SOURCE = { kind: 'plugin:dsh-session-conductor', plugin: 'dsh-session-conductor', form: 'instructions' };

test('真人判定：source.kind=user 是真人，plugin:* 不是', () => {
  assert.equal(planGateIsHumanMessage(userMsg('确认')), true);
  assert.equal(planGateIsHumanMessage(userMsg('【上下文用量】已用 50%', INJECTED_SOURCE)), false);
  assert.equal(planGateIsHumanMessage(userMsg('【dsh-session-conductor 模板注入】…', INJECTED_SOURCE)), false);
});

test('真人判定：源缺失时退回前缀兜底，认不出的按真人处理（保守）', () => {
  // 无 source 的老日志：已知注入前缀要被排除
  assert.equal(planGateIsHumanMessage(userMsg('【上下文用量】已用 50%', null)), false);
  assert.equal(planGateIsHumanMessage(userMsg('Current runtime context', null)), false);
  // 普通文本无 source → 当真人
  assert.equal(planGateIsHumanMessage(userMsg('把那个函数改一下', null)), true);
});

test('核心回归：注入行排在确认之后，确认仍然有效（旧逻辑在这里失败）', () => {
  const events = [
    assistantMsg(PROPOSAL),
    userMsg('确认'),
    userMsg('【上下文用量】已用 56% ｜ 构成：系统 ~4.4K', INJECTED_SOURCE), // 紧跟在确认之后
  ];
  assert.equal(planGateAllows(events), true, '注入消息不该顶掉真人确认');
});

test('确认后中途多轮追问仍有效（一个任务只确认一次）', () => {
  const events = [
    assistantMsg(PROPOSAL),
    userMsg('确认'),
    userMsg('【上下文用量】…', INJECTED_SOURCE),
    assistantMsg('请问这里选 A 还是 B？'),
    userMsg('选 A'),
    userMsg('【上下文用量】…', INJECTED_SOURCE),
    assistantMsg('好的，继续改。'),
    userMsg('继续'),
  ];
  assert.equal(planGateAllows(events), true, '同一任务内的追问不该作废确认');
});

test('收尾汇报之后确认作废（防第二个任务继承）', () => {
  const events = [
    assistantMsg(PROPOSAL),
    userMsg('确认'),
    assistantMsg('══════════════════════════\n✅ 任务完成\n\n交付：…\n══════════════════════════'),
    assistantMsg('接下来要改哪个？'),
  ];
  assert.equal(planGateAllows(events), false, '出过收尾汇报 ⇒ 必须重新提案');
});

test('只含 ✅ 但没有 ═ 分隔线 → 不算收尾（避免误判）', () => {
  const events = [
    assistantMsg(PROPOSAL),
    userMsg('确认'),
    assistantMsg('这个功能 ✅ 支持，继续改。'),
  ];
  assert.equal(planGateAllows(events), true, '单看 ✅ 不该作废确认');
});

test('显式「新任务」词作废确认（助手忘出汇报时的兜底）', () => {
  const events = [
    assistantMsg(PROPOSAL),
    userMsg('确认'),
    assistantMsg('改完了。'),
    userMsg('再做一个新任务：给列表加排序'),
  ];
  assert.equal(planGateAllows(events), false, '出现新任务信号 ⇒ 作废');
});

test('没有提案只有确认 → 拦', () => {
  assert.equal(planGateAllows([userMsg('确认')]), false);
});

test('有提案但用户没确认 → 拦', () => {
  assert.equal(planGateAllows([assistantMsg(PROPOSAL), userMsg('等一下我看看')]), false);
});

test('确认在提案之前 → 拦（顺序错乱）', () => {
  assert.equal(planGateAllows([userMsg('确认'), assistantMsg(PROPOSAL)]), false);
});

test('缺确认段锚点的半截提案 → 拦', () => {
  const events = [assistantMsg('# 门禁表\n| 任务 | x |'), userMsg('确认')];
  assert.equal(planGateAllows(events), false);
});

test('空事件流 / 非数组 → 拦（不抛）', () => {
  assert.equal(planGateAllows([]), false);
  assert.equal(planGateAllows(null), false);
  assert.equal(planGateAllows(undefined), false);
});

test('bash 写启发式：引号内的 > 不算重定向', () => {
  const cmd = `curl -s -X POST http://x -d '{"a":">b"}'`;
  assert.equal(PLAN_ENFORCE_BASH_WRITE_RE.test(stripQuotedForWriteHeuristic(cmd)), false, '纯网络请求不该被判成写');
});

test('bash 写启发式：真重定向 / rm / git commit 仍拦', () => {
  for (const cmd of ['echo hi > /tmp/x', 'echo hi >> /tmp/x', 'rm -rf /tmp/x', 'git commit -m "x"', 'sed -i s/a/b/ f.txt']) {
    assert.equal(PLAN_ENFORCE_BASH_WRITE_RE.test(stripQuotedForWriteHeuristic(cmd)), true, `应判为写：${cmd}`);
  }
});

test('bash 写启发式：只读命令不拦', () => {
  for (const cmd of ['git status', 'ls -la', 'cat a.txt', 'grep -n x f.js', 'node test/run-all.mjs']) {
    assert.equal(PLAN_ENFORCE_BASH_WRITE_RE.test(stripQuotedForWriteHeuristic(cmd)), false, `不该判为写：${cmd}`);
  }
});

// ── 提问框的确认（实测踩到：模板要求用 ask_user_question 提问，但答案落在 tool/result） ──

/** 造一条 ask_user_question 的答案事件。 */
function askAnswer(selected) {
  return {
    type: 'tool/result',
    data: { content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'x', selected }] }) }] },
  };
}

test('提问框选「确认执行」也算确认（否则按模板提问反而过不了门禁）', () => {
  const events = [
    assistantMsg(PROPOSAL),
    { type: 'tool/call', data: { name: 'ask_user_question' } },
    askAnswer(['确认执行（推荐）']),
  ];
  assert.equal(planGateAllows(events), true, '用户在提问框里点的确认必须生效');
});

test('提问框选「取消」不算确认', () => {
  const events = [
    assistantMsg(PROPOSAL),
    { type: 'tool/call', data: { name: 'ask_user_question' } },
    askAnswer(['取消']),
  ];
  assert.equal(planGateAllows(events), false, '取消不该被当成确认');
});

test('planGateAskAnswerText：只认提问答案形状，普通 tool/result 返回空', () => {
  assert.equal(planGateAskAnswerText(askAnswer(['确认'])), '确认');
  assert.equal(planGateAskAnswerText({ type: 'tool/result', data: { content: [{ type: 'text', text: 'Error: boom' }] } }), '');
  assert.equal(planGateAskAnswerText({ type: 'tool/result', data: {} }), '');
});

test('提问框确认后同样受任务边界约束（收尾汇报后作废）', () => {
  const events = [
    assistantMsg(PROPOSAL),
    askAnswer(['确认执行']),
    assistantMsg('══════════════════════════\n✅ 任务完成\n══════════════════════════'),
  ];
  assert.equal(planGateAllows(events), false, '收尾后提问框的确认也要作废');
});
