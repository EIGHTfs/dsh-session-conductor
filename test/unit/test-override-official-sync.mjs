// 官方界面切换 → override 同步（adoptOfficialSelection / readOfficialPendingSelection）自测。
//
// 背景（实测事故）：本插件的 override 每轮强制改写请求配置，优先级高于官方链路。
// 于是有个致命副作用 —— override 一旦写入，用户在主会话界面用官方模型选择器切换**完全无效**：
// 界面显示新模型、请求一直走 override 里的旧模型，且不报错、不提示、无清除入口。
// 现场：批量「跟随主代理」把一批会话钉在某个已失效 provider 上，界面切三次、跨三个回合、
//       改会话日志、重启宿主全部无效（override 存在 domain 里且每轮覆盖）。
//
// 修法：官方切换会往 modelSelection 投影写 pending，而插件用 override 改写请求后
// consumeSelection 不匹配 → pending 会保留。每轮把它与 override 比对，不一致就把 override
// **同步**成 pending 的值（不是清除）—— 界面选择立刻生效，同时保留跨轮持久能力。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptOfficialSelection, readOfficialPendingSelection } from '../../lib/features/member-model/override.js';

test('官方切换了不同模型 → 应同步成官方值', () => {
  const got = adoptOfficialSelection({ provider: 'ccc', model: 'deepseek-v4.1-flash' }, { provider: 'sa6400', model: 'cn:deepseek-v4.1-flash' });
  assert.deepEqual(got, { provider: 'sa6400', model: 'cn:deepseek-v4.1-flash' });
});

test('两边一致 → 不同步（避免无意义写盘与日志噪音）', () => {
  assert.equal(adoptOfficialSelection({ provider: 'sa6400', model: 'm' }, { provider: 'sa6400', model: 'm' }), null);
});

test('没有 override → 不干预（交给官方链路自己跑）', () => {
  assert.equal(adoptOfficialSelection(null, { provider: 'sa6400', model: 'm' }), null);
});

test('没有 pending（用户没切过）→ 不同步', () => {
  assert.equal(adoptOfficialSelection({ provider: 'ccc', model: 'x' }, null), null);
  assert.equal(adoptOfficialSelection({ provider: 'ccc', model: 'x' }, undefined), null);
});

test('pending 字段残缺或为空串 → 不同步（不把脏值写进 override）', () => {
  assert.equal(adoptOfficialSelection({ provider: 'ccc', model: 'x' }, { provider: 'sa6400' }), null);
  assert.equal(adoptOfficialSelection({ provider: 'ccc', model: 'x' }, { provider: '', model: 'y' }), null);
  assert.equal(adoptOfficialSelection({ provider: 'ccc', model: 'x' }, { provider: 'sa6400', model: '' }), null);
});

test('readOfficialPendingSelection：投影可用时读到 pending', () => {
  const ctx = {
    sessionProjections: {
      stateOf: () => ({ lastUsed: { provider: 'ccc', model: 'x' }, pending: { provider: 'sa6400', model: 'cn:deepseek-v4.1-flash' } }),
    },
  };
  assert.deepEqual(readOfficialPendingSelection(ctx, { session: {} }), { provider: 'sa6400', model: 'cn:deepseek-v4.1-flash' });
});

test('readOfficialPendingSelection：投影缺失 / 无 pending / 抛错 一律返回 null（不打断请求）', () => {
  assert.equal(readOfficialPendingSelection({}, null), null);
  assert.equal(readOfficialPendingSelection({ sessionProjections: { stateOf: () => ({ pending: null }) } }, { session: {} }), null);
  assert.equal(readOfficialPendingSelection({ sessionProjections: { stateOf: () => { throw new Error('boom'); } } }, { session: {} }), null);
});

test('readOfficialPendingSelection：也支持从 ctx.get("sessionProjections") 取服务', () => {
  const ctx = { get: (name) => (name === 'sessionProjections'
    ? { stateOf: () => ({ pending: { provider: 'numlinka', model: 'deepseek-v4.1-flash' } }) }
    : null) };
  assert.deepEqual(readOfficialPendingSelection(ctx, { session: {} }), { provider: 'numlinka', model: 'deepseek-v4.1-flash' });
});
