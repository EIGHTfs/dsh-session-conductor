// context-window 单测：三级回退、缓存、异常兜底、prefer 开关
//
// 【为什么这些断言值钱】这个模块的核心价值就是「拿不到也别炸」——
// 它在撤销会话、修复日志这类不能失败的路径上被调用，一旦抛错会连累整条能力。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextWindowOfSession, routeOfSession, createContextWindowResolver, contextWindowOf,
} from '../../lib/shared/context-window.js';

/** 造一个最小的 session 替身。 */
function fakeSession({ contextWindow, provider, model } = {}) {
  return {
    requestContext: () => (contextWindow === undefined ? undefined : { contextWindow }),
    requestHeader: () => (provider === undefined
      ? undefined
      : { config: { provider, model } }),
  };
}

/** 造一个最小的 ctx + llm 替身。 */
function fakeCtx(windows = {}, { throws = false } = {}) {
  return {
    get: (name) => (name !== 'llm' ? undefined : {
      resolveModelInfo: async (provider, model) => {
        if (throws) throw new Error('catalog unavailable');
        const value = windows[`${provider}/${model}`];
        return value === undefined ? {} : { context: { contextWindow: value } };
      },
    }),
  };
}

test('同步取值：有 requestContext 时直接返回', () => {
  assert.equal(contextWindowOfSession(fakeSession({ contextWindow: 1200000 })), 1200000);
});

test('同步取值：缺字段、非正数、抛错一律返回 undefined', () => {
  assert.equal(contextWindowOfSession(fakeSession({})), undefined);
  assert.equal(contextWindowOfSession(fakeSession({ contextWindow: 0 })), undefined);
  assert.equal(contextWindowOfSession(fakeSession({ contextWindow: Number.NaN })), undefined);
  assert.equal(contextWindowOfSession({ requestContext: () => { throw new Error('boom'); } }), undefined);
  assert.equal(contextWindowOfSession(undefined), undefined);
});

test('routeOfSession：从请求头取 provider/model，缺一不可', () => {
  assert.deepEqual(routeOfSession(fakeSession({ provider: 'sa6400', model: 'cn:flash' })), { provider: 'sa6400', model: 'cn:flash' });
  assert.equal(routeOfSession(fakeSession({ provider: 'sa6400' })), undefined);
  assert.equal(routeOfSession(fakeSession({})), undefined);
});

test('异步解析：按 provider/model 命中目录值', async () => {
  const resolve = createContextWindowResolver({ ctx: fakeCtx({ 'sa6400/cn:flash': 1200000 }) });
  assert.equal(await resolve({ provider: 'sa6400', model: 'cn:flash' }), 1200000);
});

test('异步解析：目录抛错或没有值时返回 undefined，不抛给调用方', async () => {
  const broken = createContextWindowResolver({ ctx: fakeCtx({}, { throws: true }) });
  assert.equal(await broken({ provider: 'x', model: 'y' }), undefined);
  const empty = createContextWindowResolver({ ctx: fakeCtx({}) });
  assert.equal(await empty({ provider: 'x', model: 'y' }), undefined);
});

test('缓存：TTL 内不重复查目录，过期后重查', async () => {
  let calls = 0;
  let clock = 1000;
  const ctx = {
    get: () => ({
      resolveModelInfo: async () => { calls += 1; return { context: { contextWindow: 999 } }; },
    }),
  };
  const resolve = createContextWindowResolver({ ctx, ttlMs: 100, now: () => clock });
  await resolve({ provider: 'p', model: 'm' });
  await resolve({ provider: 'p', model: 'm' });
  assert.equal(calls, 1, 'TTL 内应命中缓存');
  clock += 200;
  await resolve({ provider: 'p', model: 'm' });
  assert.equal(calls, 2, '过期后应重查');
});

test('缓存键是 provider/model：不同模型不串味', async () => {
  const resolve = createContextWindowResolver({ ctx: fakeCtx({ 'p/a': 100, 'p/b': 200 }) });
  assert.equal(await resolve({ provider: 'p', model: 'a' }), 100);
  assert.equal(await resolve({ provider: 'p', model: 'b' }), 200);
});

test('组合取值：默认同步优先（请求之后以实际发出的那次为准）', async () => {
  const value = await contextWindowOf({
    ctx: fakeCtx({ 'p/m': 999999 }),
    session: fakeSession({ contextWindow: 1200000, provider: 'p', model: 'm' }),
  });
  assert.equal(value, 1200000);
});

test('组合取值：prefer=resolve 时以目录为准（切模型后还没发请求的场景）', async () => {
  const value = await contextWindowOf({
    ctx: fakeCtx({ 'p/m': 64000 }),
    session: fakeSession({ contextWindow: 1200000, provider: 'p', model: 'm' }),
    prefer: 'resolve',
  });
  assert.equal(value, 64000);
});

test('组合取值：同步为空时自动走异步；两路都空才用 fallback', async () => {
  const viaResolve = await contextWindowOf({
    ctx: fakeCtx({ 'p/m': 32000 }),
    session: fakeSession({ provider: 'p', model: 'm' }),
  });
  assert.equal(viaResolve, 32000);

  const viaFallback = await contextWindowOf({
    ctx: fakeCtx({}),
    session: fakeSession({}),
    fallback: 262144,
  });
  assert.equal(viaFallback, 262144);

  const nothing = await contextWindowOf({ session: fakeSession({}) });
  assert.equal(nothing, undefined, '本模块不猜默认值');
});
