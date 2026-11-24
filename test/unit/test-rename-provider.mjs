// provider 模式的契约与节流边界。
//
// 为什么这些必须先钉住：
//   ① 官方 validateProvider 只认 id / automatic / generate 三个字段，形状错了注册直接抛错；
//   ② `automatic: "all-prompts"` 意味着**每条真人消息**都会调一次 generate —— 节流若失效，
//      就是每条消息烧一次 LLM（官方原版正是这个成本短板，我们注册时不能把它继承过来）；
//   ③ generate 必须返回非空 title，所以「不该改」只能原样回传 currentTitle。
// 这三条都不依赖网络与真实模型，纯逻辑即可验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { depsReady, skipReason } from './helpers/host-deps.mjs';

const providerMod = depsReady ? await import('../../lib/features/rename/provider.js') : null;
const createRenameProvider = providerMod?.createRenameProvider;

/** 造一个只有 get() 的 ctx：provider 里只用到 ctx.get('llm')。 */
function makeCtx({ llm = null } = {}) {
  return { get: (key) => (key === 'llm' ? llm : undefined) };
}

/** 造一个最小 session：provider 只读 id 与 requestHeader。 */
function makeSession(id = 's-1') {
  return { id, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) };
}

/** 造 N 条官方形状的合格消息（{seq, text}）。 */
function makeMessages(count) {
  return Array.from({ length: count }, (_, index) => ({ seq: index + 1, text: `消息 ${index + 1}` }));
}

test('provider 契约：只有 id / automatic / generate 三个必需字段', { skip: skipReason }, () => {
  const provider = createRenameProvider(makeCtx());
  assert.equal(typeof provider.id, 'string');
  assert.ok(provider.id.length > 0, 'id 必须是非空字符串');
  assert.equal(provider.automatic, 'all-prompts', '按选择走每条消息参与的 cadence');
  assert.equal(typeof provider.generate, 'function');
});

test('signal 已 abort 时直接回传当前标题，不发起任何调用', { skip: skipReason }, async () => {
  const provider = createRenameProvider(makeCtx());
  const controller = new AbortController();
  controller.abort();
  const result = await provider.generate({
    session: makeSession(),
    messages: makeMessages(10),
    currentTitle: '旧标题',
    signal: controller.signal,
  });
  assert.deepEqual(result, { title: '旧标题' });
});

test('消息数不足门槛时回传当前标题（保住「每条消息不烧 LLM」）', { skip: skipReason }, async () => {
  const provider = createRenameProvider(makeCtx());
  const result = await provider.generate({
    session: makeSession(),
    messages: makeMessages(2), // 门槛是 3
    currentTitle: '旧标题',
  });
  assert.deepEqual(result, { title: '旧标题' });
});

test('没有 llm 服务时回传当前标题，不抛错', { skip: skipReason }, async () => {
  const provider = createRenameProvider(makeCtx({ llm: null }));
  const result = await provider.generate({
    session: makeSession(),
    messages: makeMessages(10),
    currentTitle: '旧标题',
  });
  assert.deepEqual(result, { title: '旧标题' });
});

test('同一会话连续调用受最小间隔保护：第二次立即回传当前标题', { skip: skipReason }, async () => {
  // 用一个假 llm：只要被真的调用就记录，用来证明第二次压根没走到模型
  let llmCalls = 0;
  const fakeLlm = {
    chat: async () => {
      llmCalls += 1;
      throw new Error('不应被调用');
    },
  };
  const provider = createRenameProvider(makeCtx({ llm: fakeLlm }));
  const session = makeSession();

  // 第一次：消息够，会往下走到 resolveRoute；此处 route 可解析，随后调用 llm 会抛错
  await provider.generate({ session, messages: makeMessages(10), currentTitle: '旧标题' });
  const callsAfterFirst = llmCalls;

  // 第二次：距第一次不足 5 分钟，必须在节流处直接返回
  const second = await provider.generate({ session, messages: makeMessages(10), currentTitle: '旧标题' });
  assert.deepEqual(second, { title: '旧标题' });
  assert.equal(llmCalls, callsAfterFirst, '节流生效时不应再触达模型');
});

test('新增消息不足 3 条时不再分析（即便已过最小间隔）', { skip: skipReason }, async () => {
  let llmCalls = 0;
  const fakeLlm = { chat: async () => { llmCalls += 1; throw new Error('不应被调用'); } };
  const provider = createRenameProvider(makeCtx({ llm: fakeLlm }));
  const session = makeSession();

  await provider.generate({ session, messages: makeMessages(10), currentTitle: '旧标题' });
  const callsAfterFirst = llmCalls;

  // 只多 1 条（10 → 11），未达「新增 3 条」门槛
  const second = await provider.generate({ session, messages: makeMessages(11), currentTitle: '旧标题' });
  assert.deepEqual(second, { title: '旧标题' });
  assert.equal(llmCalls, callsAfterFirst, '新增消息不足时不应再触达模型');
});

// ── 两模式互斥：provider 模式下 consumer 的自建调度必须让路 ──
// 若两边都跑，就在写同一份 sessionTitle，标题会互相覆盖 —— 这是「二选一」的技术保证。

test('provider 模式下 consumer 调度直接让路（不建 timer）', { skip: skipReason }, async () => {
  const analysisMod = await import('../../lib/features/rename/analysis.js');
  const configMod = await import('../../lib/core/config.js');
  const hooksMod = await import('../../lib/shared/test-hooks.js');

  const { pendingTimers } = hooksMod.__timersForTest();

  configMod.setConfig({ renameMode: 'provider' });
  configMod.setRenameModeInUse('provider');
  pendingTimers.clear();

  analysisMod.scheduleAnalysis(makeCtx(), 'session-should-not-schedule');
  assert.equal(pendingTimers.size, 0, 'provider 模式下不应创建 consumer 定时器');

  // 切回 consumer：同一调用必须重新建立 timer，证明确实是模式在起作用而不是函数失效
  configMod.setRenameModeInUse('consumer');
  analysisMod.scheduleAnalysis(makeCtx(), 'session-should-schedule');
  assert.equal(pendingTimers.size, 1, 'consumer 模式下应正常调度');
  pendingTimers.clear();
  configMod.resetRenameModeForTest();
});
