// 记忆取回回归 —— 检测阈值、取回锚点与合并规则、注入上限、反馈环排除、降级路径。
//
// 【为什么钉这些】
//   · 阈值：用量估算有正常抖动，误判会白烧 token（默认 10%，配置化）；
//   · 锚点只认 source.kind==="user"：插件自己注入的块若不排除，会被下一轮取回 ⇒ 越注越多的反馈环；
//   · 同回合多条用户消息合并：否则一轮会被数成两轮，挤掉更早的记忆；
//   · 上限：刚压缩完的上下文最不该再被塞满。
// 夹具用真实多帧 zstd（`zstdCompress`），端到端跑真读取器，不 mock 解压。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';

import {
  detectContextLoss, formatRecallBlock, buildMemoryRecall, resetRecallStateForTest, takeLastUsage,
  registerMemoryRecallTool,
} from '../../lib/features/memory-recall/index.js';
import { readRecentUserTurns } from '../../lib/sessions/events.js';

const zstdCompressAsync = promisify(zstdCompress);

/** 造一份会话日志：每轮 = 用户消息 + 该轮 AI 首条回应（reasoning）+ 回合边界。 */
function makeLog({ rounds = 3, extraInjected = true, mergeSecondInSameTurn = false } = {}) {
  const lines = [JSON.stringify({ type: 'session', version: 4, id: 's1', cwd: '/w', createdAt: 1 })];
  let seq = 1;
  for (let i = 1; i <= rounds; i++) {
    lines.push(JSON.stringify({ seq: seq++, type: 'turn/start', time: 1000 + i * 100 }));
    lines.push(JSON.stringify({ seq: seq++, type: 'user/message', time: 1000 + i * 100, data: { content: [{ type: 'text', text: `用户原话${i}` }], source: { kind: 'user' } } }));
    if (mergeSecondInSameTurn && i === rounds) {
      lines.push(JSON.stringify({ seq: seq++, type: 'user/message', time: 1000 + i * 100 + 5, data: { content: [{ type: 'text', text: `连发补充${i}` }], source: { kind: 'user' } } }));
    }
    if (extraInjected) {
      // 插件注入的块：source 不是 user ⇒ 必须被排除（否则形成反馈环）
      lines.push(JSON.stringify({ seq: seq++, type: 'user/message', time: 1000 + i * 100 + 1, data: { content: [{ type: 'text', text: '【上下文用量】已用 50%' }], source: { kind: 'plugin:dsh-session-conductor' } } }));
      lines.push(JSON.stringify({ seq: seq++, type: 'user/message', time: 1000 + i * 100 + 2, data: { content: [{ type: 'text', text: 'runtime 上下文' }], source: { kind: 'runtime-context' } } }));
    }
    lines.push(JSON.stringify({ seq: seq++, type: 'assistant/message', time: 1000 + i * 100 + 10, data: { turn: i, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: `第${i}轮的思考` }, { type: 'text', text: `第${i}轮的回复` }] } } }));
    lines.push(JSON.stringify({ seq: seq++, type: 'turn/end', time: 1000 + i * 100 + 20, data: { reason: null } }));
  }
  return lines.join('\n') + '\n';
}

/** 把日志写成多帧 zstd 夹具，返回 sessions root。 */
async function makeFixture(logText, { sessionId = 's1', frames = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recall-'));
  const dir = join(root, '--group--', sessionId);
  mkdirSync(dir, { recursive: true });
  const per = Math.max(1, Math.ceil(logText.length / frames));
  const segs = [];
  for (let i = 0; i < logText.length; i += per) segs.push(logText.slice(i, i + per));
  const bufs = [];
  for (const s of segs) bufs.push(await zstdCompressAsync(Buffer.from(s, 'utf8')));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(bufs));
  return root;
}

// ---------- ① 检测 ----------

test('detectContextLoss：默认阈值 10%（刚好 10% 触发，9.9% 不触发）', () => {
  const prev = { usedTokens: 100_000, percent: 60 };
  assert.equal(detectContextLoss(prev, { usedTokens: 90_000, percent: 54 }).lost, true, '刚好降 10% 应触发');
  assert.equal(detectContextLoss(prev, { usedTokens: 90_100, percent: 54 }).lost, false, '降 9.9% 不应触发');
  assert.equal(detectContextLoss(prev, { usedTokens: 99_000, percent: 59 }).lost, false, '小抖动不触发');
  assert.equal(detectContextLoss(prev, { usedTokens: 120_000, percent: 72 }).lost, false, '增长不触发');
});

test('detectContextLoss：无上次用量 / 本次不可用 ⇒ 不触发（并给出原因）', () => {
  assert.equal(detectContextLoss(null, { usedTokens: 10 }).lost, false);
  assert.match(detectContextLoss(null, { usedTokens: 10 }).reason, /首个回合/);
  assert.equal(detectContextLoss({ usedTokens: 10 }, null).lost, false);
  assert.match(detectContextLoss({ usedTokens: 10 }, null).reason, /不可用/);
});

test('detectContextLoss：绝对量阈值可单独启用', () => {
  const prev = { usedTokens: 1_000_000, percent: 90 };
  assert.equal(detectContextLoss(prev, { usedTokens: 999_000 }, { minDropTokens: 500 }).lost, true);
  assert.equal(detectContextLoss(prev, { usedTokens: 999_900 }, { minDropTokens: 500 }).lost, false);
});

// ---------- ② 取回读取器 ----------

test('readRecentUserTurns：锚点只认 source.kind==="user"（插件注入与 runtime 上下文被排除）', async () => {
  const root = await makeFixture(makeLog({ rounds: 2 }));
  const turns = await readRecentUserTurns({}, 's1', { root, rounds: 5 });
  assert.equal(turns.length, 2, '只有 2 条真实用户消息（注入块与 runtime 上下文不算）');
  assert.equal(turns[0].userText, '用户原话1');
  assert.ok(!turns.some((t) => t.userText.includes('上下文用量')), '插件注入块不得被取回（否则反馈环）');
});

test('readRecentUserTurns：AI 首条回应优先取 reasoning，没有则取正文', async () => {
  const root = await makeFixture(makeLog({ rounds: 1 }));
  const [turn] = await readRecentUserTurns({}, 's1', { root });
  assert.equal(turn.agentText, '第1轮的思考', '有 reasoning 时必须取 reasoning');
});

test('readRecentUserTurns：同回合内连续多条用户消息合并成一轮', async () => {
  const root = await makeFixture(makeLog({ rounds: 2, mergeSecondInSameTurn: true }));
  const turns = await readRecentUserTurns({}, 's1', { root, rounds: 5 });
  assert.equal(turns.length, 2, '同回合连发应合并，不得算成 3 轮');
  assert.match(turns[1].userText, /用户原话2[\s\S]*连发补充2/, '合并后两条原话都要在');
});

test('readRecentUserTurns：只留最近 N 轮', async () => {
  const root = await makeFixture(makeLog({ rounds: 5 }));
  const turns = await readRecentUserTurns({}, 's1', { root, rounds: 2 });
  assert.equal(turns.length, 2);
  assert.equal(turns.at(-1).userText, '用户原话5', '最后一条必须是最新的');
});

test('readRecentUserTurns：日志不存在 ⇒ 返回 null（调用方跳过）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recall-empty-'));
  assert.equal(await readRecentUserTurns({}, 'nope', { root }), null);
});

// ---------- ③ 组装与上限 ----------

test('formatRecallBlock：标题说明原因，且按时间正序输出', () => {
  const text = formatRecallBlock(
    [{ time: 1, userText: '甲', agentText: 'A' }, { time: 2, userText: '乙', agentText: 'B' }],
    { prevPercent: 62, currentPercent: 18 },
  );
  assert.match(text, /【记忆取回】/);
  assert.match(text, /上次 62% → 本次 18%/);
  assert.ok(text.indexOf('甲') < text.indexOf('乙'), '必须按时间正序');
});

test('formatRecallBlock：总长超限时丢最早的轮次（最近的优先留下）', () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ time: i, userText: `第${i}轮原话`.repeat(50), agentText: 'x'.repeat(300) }));
  const text = formatRecallBlock(turns, { maxTotalChars: 1500 });
  assert.ok(text.length <= 1600, `总长应受控，实际 ${text.length}`);
  assert.ok(text.includes('第4轮原话'), '最近的轮次必须留下');
  assert.ok(!text.includes('第0轮原话'), '最早的轮次应被丢弃');
});

test('formatRecallBlock：无有效轮次 ⇒ 空串', () => {
  assert.equal(formatRecallBlock([], {}), '');
  assert.equal(formatRecallBlock([{ userText: '' }], {}), '');
});

// ---------- ④ 主入口 ----------

test('buildMemoryRecall：用量下降触发取回；无下降则不触发', async () => {
  resetRecallStateForTest();
  const root = await makeFixture(makeLog({ rounds: 3 }));
  const key = {}; // 会话键（真实场景是 agent 对象）
  const opts = { rounds: 3, minDropRatio: 0.10, root };
  // 第一次：只记账，不触发（无上次）
  assert.equal(await buildMemoryRecall({}, { sessionKey: key, sessionId: 's1', current: { usedTokens: 100_000, percent: 60 }, opts }), null);
  // 增长：不触发
  assert.equal(await buildMemoryRecall({}, { sessionKey: key, sessionId: 's1', current: { usedTokens: 120_000, percent: 72 }, opts }), null);
  // 骤降：触发
  const text = await buildMemoryRecall({}, { sessionKey: key, sessionId: 's1', current: { usedTokens: 20_000, percent: 12 }, opts });
  assert.ok(text && text.includes('【记忆取回】'), '明显下降必须触发注入');
  assert.match(text, /用户原话3/, '应包含最近的用户原话');
});

test('buildMemoryRecall：即使读取失败也会记账（避免每回合反复触发）', async () => {
  resetRecallStateForTest();
  const key = {};
  const emptyRoot = mkdtempSync(join(tmpdir(), 'dsh-recall-empty2-'));
  const args = { sessionKey: key, sessionId: 'missing', current: { usedTokens: 100_000 }, opts: { root: emptyRoot } };
  assert.equal(await buildMemoryRecall({}, args), null, '无上次用量 ⇒ 只记账');
  // 记账已发生：下次即便骤降，也只会尝试一次（读取失败 ⇒ null，但用量已被更新为本次）
  assert.equal(await buildMemoryRecall({}, { ...args, current: { usedTokens: 1_000 } }), null, '读取失败应静默返回 null');
  assert.deepEqual(takeLastUsage(key), { usedTokens: 1_000 }, '用量必须已更新为本次，避免反复触发');
});

test('buildMemoryRecall：开关关闭时调用方根本不调它（此处验证 sessionId 缺失即跳过）', async () => {
  resetRecallStateForTest();
  const key = {};
  assert.equal(await buildMemoryRecall({}, { sessionKey: key, sessionId: '', current: { usedTokens: 1 }, opts: {} }), null);
});

// ---------- ⑤ 手动工具 recall_memory ----------

test('recall_memory：注册与执行（参数=取几轮，上限 50；只读返回文本）', async () => {
  const registered = [];
  const defineTool = (spec) => spec;
  const tools = { register: (spec) => registered.push(spec) };
  const seen = {};
  const ok = registerMemoryRecallTool({}, defineTool, tools, {
    cfg: { retrieveMemoryRounds: 3, retrieveMemoryMaxChars: 4000, retrieveMemoryMaxCharsPerItem: 800 },
    readTurns: async (_ctx, _id, opts) => { seen.rounds = opts.rounds; return [{ time: 1, userText: '甲', agentText: 'A' }]; },
    format: (turns) => `格式化:${turns.length}`,
  });
  assert.equal(ok, true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'recall_memory');

  const out = await registered[0].execute({ rounds: 99 }, { agent: { session: { id: 's1' } } });
  assert.equal(out, '格式化:1');
  assert.equal(seen.rounds, 50, 'rounds 必须被夹到上限 50');

  const def = await registered[0].execute({}, { agent: { session: { id: 's1' } } });
  assert.equal(seen.rounds, 3, '不传参数时用配置默认值');

  const noSession = await registered[0].execute({}, { agent: {} });
  assert.match(String(noSession), /拿不到当前会话/);
});

test('recall_memory：defineTool/tools 不可用时不注册（返回 false，不抛）', () => {
  assert.equal(registerMemoryRecallTool({}, null, { register() {} }), false);
  assert.equal(registerMemoryRecallTool({}, () => ({}), {}), false);
});
