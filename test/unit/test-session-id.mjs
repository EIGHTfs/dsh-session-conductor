// 会话 id 写法归一（lib/sessions/id.js）单测
//
// 【为什么钉这些断言】同一个会话在磁盘上有两种写法（主会话目录带 `session-` 前缀、
// 子代理会话是裸 uuid），而工具/路由的入参由人（或另一个 AI）给，写法不受控。
// 一旦比较口径不统一，症状就是「同一个会话换个写法就报找不到」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bareSessionId, sessionIdVariants, sameSessionId, matchSessionId, canonicalSessionId,
} from '../../lib/sessions/id.js';

const BARE = '62d12e76-6534-4d51-a5a9-6533f037eae0';
const PREFIXED = 'session-62d12e76-6534-4d51-a5a9-6533f037eae0';
const OTHER = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('bareSessionId 去掉前缀，且幂等', () => {
  assert.equal(bareSessionId(PREFIXED), BARE);
  assert.equal(bareSessionId(BARE), BARE);
  assert.equal(bareSessionId(`  ${PREFIXED}  `), BARE, '两端空白应被裁掉');
  assert.equal(bareSessionId(''), '');
  assert.equal(bareSessionId(undefined), '');
  assert.equal(bareSessionId(null), '');
});

test('sessionIdVariants 给出两种写法且去重保序', () => {
  assert.deepEqual(sessionIdVariants(BARE), [BARE, PREFIXED]);
  assert.deepEqual(sessionIdVariants(PREFIXED), [PREFIXED, BARE]);
  assert.deepEqual(sessionIdVariants(''), []);
});

test('sameSessionId 忽略前缀差异', () => {
  assert.equal(sameSessionId(BARE, PREFIXED), true);
  assert.equal(sameSessionId(PREFIXED, BARE), true);
  assert.equal(sameSessionId(BARE, OTHER), false);
  assert.equal(sameSessionId('', ''), false, '空值不算同一个会话');
});

test('matchSessionId：完整匹配时两种写法都能命中真实形式', () => {
  const ids = [PREFIXED, OTHER];
  // 用户给带前缀 → 命中带前缀那条
  assert.deepEqual(matchSessionId(ids, PREFIXED), { id: PREFIXED });
  // 用户给裸 id → 仍命中带前缀那条（返回磁盘真实形式，不改写）
  assert.deepEqual(matchSessionId(ids, BARE), { id: PREFIXED });
  // 反过来：磁盘是裸 uuid，用户给带前缀 → 命中裸 uuid
  assert.deepEqual(matchSessionId([BARE], PREFIXED), { id: BARE });
});

test('matchSessionId：前缀片段按裸形式匹配', () => {
  const ids = [PREFIXED, OTHER];
  // 不带 session- 的片段也要能命中带前缀的 id
  assert.deepEqual(matchSessionId(ids, '62d12e76'), { id: PREFIXED });
  assert.deepEqual(matchSessionId(ids, 'session-62d12e76'), { id: PREFIXED });
});

test('matchSessionId：多命中返回候选而不是猜', () => {
  const ids = ['session-aaaabbbb', 'session-aaaacccc'];
  const got = matchSessionId(ids, 'aaaa');
  assert.ok(Array.isArray(got?.candidates), '应返回候选清单');
  assert.equal(got.candidates.length, 2);
});

test('matchSessionId：未命中与空集合返回 null', () => {
  assert.equal(matchSessionId(['session-aaaabbbb'], 'zzz'), null);
  assert.equal(matchSessionId([], 'aaaa'), null);
  assert.equal(matchSessionId(['session-aaaabbbb'], '  '), null);
});

test('canonicalSessionId：优先命中内存里的活跃会话', async () => {
  const ctx = {
    get: (name) => (name === 'sessions' ? { get: (id) => (id === PREFIXED ? { header: {} } : undefined) } : undefined),
  };
  assert.equal(await canonicalSessionId(ctx, BARE), PREFIXED, '裸 id 应归一到活跃会话的真实写法');
  assert.equal(await canonicalSessionId(ctx, PREFIXED), PREFIXED);
});

test('canonicalSessionId：查不到时原样返回，不臆造 id', async () => {
  const ctx = { get: () => undefined };
  assert.equal(await canonicalSessionId(ctx, 'no-such-session'), 'no-such-session');
  assert.equal(await canonicalSessionId(ctx, ''), '');
});
