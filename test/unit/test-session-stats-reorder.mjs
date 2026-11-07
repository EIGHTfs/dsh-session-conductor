// 会话统计与拖拽排序单测（stats / reorder）。
//
// 【为什么这些断言重要】
//   统计是「数字卡片」，口径错一位用户看着就不对劲，而且没人会去逐条复核 —— 只能靠单测钉住：
//     · running 与 interruption 必须互斥（正在跑的会话不算「中断」）；
//     · 体积信息拿不到时必须整体退化成 null，而不是显示 0（0 会被读成「日志是空的」）；
//     · 未被任何工作区认领的会话必须落到「未分组」桶里，否则总数对不上分桶之和。
//   拖拽排序的命门是**参数校验**：宿主 insertBefore 遇到不存在的锚点行为未定义，
//   前端一抖就可能把会话丢到别处，所以非法参数必须在校验层就拒掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 聚合实现从 stats-aggregate.js 取：stats-routes.js 会经 sessions/list.js 拉起 core/domain.js，
// 而单测环境没有 @deepseek-ai/dsh-storage-domain（可选 peer，只有宿主提供），import 不进来。
import { aggregateStats } from '../../lib/features/stats-aggregate.js';
import { registerReorderRoutes } from '../../lib/features/reorder-routes.js';

/** 固定「今天」，让 14 天窗口的断言与运行日期无关。 */
const NOW = new Date(2026, 10, 8, 12, 0, 0).getTime();
const DAY = 24 * 3600 * 1000;

/** 造一条列表项（只给统计用到的字段）。 */
function item(id, extra = {}) {
  return { id, title: `标题-${id}`, archived: false, live: false, running: false, interruption: null, updatedAt: NOW - DAY, ...extra };
}

// ---------- 统计聚合 ----------

test('计数口径：running 与 interruption 互斥，live/archived 各自独立', () => {
  const items = [
    item('s1', { live: true, running: true }),
    item('s2', { live: true, interruption: { kind: 'crash' } }),
    item('s3', { archived: true }),
    item('s4'),
    item('', {}), // 空 id 必须被丢掉，不能算进总数
  ];
  const stats = aggregateStats({ items, sizes: null, workspaces: [], trashed: new Set(), now: NOW });
  assert.equal(stats.total, 4, '空 id 不计入');
  assert.equal(stats.live, 2);
  assert.equal(stats.archived, 1);
  assert.equal(stats.running, 1);
  assert.equal(stats.interrupted, 1, '正在跑的那条不能同时算中断');
});

test('体积拿不到时整体退化为 null / 空数组（不能显示成 0）', () => {
  const stats = aggregateStats({ items: [item('s1')], sizes: null, workspaces: [], trashed: new Set(), now: NOW });
  assert.equal(stats.totalBytes, null);
  assert.deepEqual(stats.topLargest, []);
  assert.equal(stats.byWorkspace[0].bytes, null);
});

test('按工作区分桶 + 未分组桶兜底，且分桶之和等于总数', () => {
  const items = [item('s1'), item('s2'), item('s3')];
  const sizes = new Map([['s1', 100], ['s2', 200], ['s3', 300]]);
  const workspaces = [
    { id: 'ws_a', title: 'A 组', sessionIds: ['s1', 's2'] },
    { id: 'ws_b', title: 'B 组', sessionIds: [] },
  ];
  const stats = aggregateStats({ items, sizes, workspaces, trashed: new Set(), now: NOW });
  const total = stats.byWorkspace.reduce((sum, bucket) => sum + bucket.count, 0);
  assert.equal(total, stats.total, '分桶之和必须等于总数');
  const groupA = stats.byWorkspace.find((bucket) => bucket.workspaceId === 'ws_a');
  assert.equal(groupA.count, 2);
  assert.equal(groupA.bytes, 300, '分组体积 = 成员体积之和');
  const ungrouped = stats.byWorkspace.find((bucket) => bucket.workspaceId === '');
  assert.equal(ungrouped.count, 1, 's3 不属于任何工作区，应进未分组桶');
  assert.equal(ungrouped.bytes, 300);
});

test('体积榜：只统计存在的会话，按体积降序，最多 5 条', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id));
  const sizes = new Map(items.map((row, index) => [row.id, (index + 1) * 100]));
  sizes.set('ghost', 999999); // 索引里有、列表里没有：不应进榜，也不应算进总量
  const stats = aggregateStats({ items, sizes, workspaces: [], trashed: new Set(), now: NOW });
  assert.equal(stats.topLargest.length, 5);
  assert.equal(stats.topLargest[0].sessionId, 'f');
  assert.equal(stats.topLargest[0].bytes, 600);
  assert.equal(stats.totalBytes, 2100, '幽灵会话的 999999 不能混进总量');
});

test('活跃直方图：固定 14 天窗口，窗口内按 updatedAt 归日', () => {
  const items = [
    item('t0', { updatedAt: NOW }),
    item('t1', { updatedAt: NOW - DAY }),
    item('old', { updatedAt: NOW - 40 * DAY }), // 窗口外的活动不进直方图
    item('bad', { updatedAt: null }),
  ];
  const stats = aggregateStats({ items, sizes: null, workspaces: [], trashed: new Set(), now: NOW });
  assert.equal(stats.daily.length, 14, '窗口固定 14 行，空日子也占位');
  const sum = stats.daily.reduce((total, day) => total + day.count, 0);
  assert.equal(sum, 2, '只有窗口内的两条计入');
  assert.equal(stats.daily[13].count, 1, '最后一行是今天');
  assert.equal(stats.daily[12].count, 1, '倒数第二行是昨天');
});

// ---------- 拖拽排序路由 ----------

/** 造一个够用的假注册表（记录调用，便于断言）。 */
function makeRegistry({ failEnd = [] } = {}) {
  const calls = [];
  const makeWorkspace = (id, title, sessionIds) => ({
    id,
    title,
    sessionIds,
    detachSession: async (sid) => { calls.push(['detach', id, sid]); },
    attachSession: async (sid) => {
      if (failEnd.includes(id)) throw new Error('attach 失败');
      calls.push(['attach', id, sid]);
    },
    insertSessionBefore: async (sid, beforeId) => { calls.push(['insertBefore', id, sid, beforeId]); },
  });
  const wsA = makeWorkspace('ws_a', 'A', ['s1', 's2']);
  const wsB = makeWorkspace('ws_b', 'B', ['s3']);
  const registry = {
    list: () => [wsA, wsB],
    get: (id) => [wsA, wsB].find((workspace) => workspace.id === id),
    insertBefore: async (id, beforeId) => {
      calls.push(['wsInsertBefore', id, beforeId]);
      return ['ws_a', 'ws_b'];
    },
  };
  return { registry, calls };
}

/** 收集注册到的 handler。 */
function mount(registry) {
  const handlers = new Map();
  const webServer = { register: ({ path, handler }) => handlers.set(path, handler) };
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) };
  registerReorderRoutes({ webServer, ctx });
  return handlers.get('/api/session-conductor/reorder');
}

function makeReq(method, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload, 'utf8');
    },
  };
}

function makeRes() {
  return { statusCode: 0, body: null, writeHead(code) { this.statusCode = code; }, end(text) { this.body = JSON.parse(text); } };
}

test('路由：非 POST 回 405，宿主没注册表回 501', async () => {
  const { registry } = makeRegistry();
  const handler = mount(registry);

  const getRes = makeRes();
  await handler(makeReq('GET'), getRes);
  assert.equal(getRes.statusCode, 405);

  const noRegHandler = mount(undefined);
  const res = makeRes();
  await noRegHandler(makeReq('POST', { kind: 'workspace', id: 'ws_a' }), res);
  assert.equal(res.statusCode, 501);
});

test('路由：kind 必须是 workspace / session', async () => {
  const { registry } = makeRegistry();
  const handler = mount(registry);
  const res = makeRes();
  await handler(makeReq('POST', { kind: 'whatever' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'BAD_KIND');
});

test('路由：工作区自锚点 / 不存在的锚点都拒掉', async () => {
  const { registry } = makeRegistry();
  const handler = mount(registry);

  const selfRes = makeRes();
  await handler(makeReq('POST', { kind: 'workspace', id: 'ws_a', beforeId: 'ws_a' }), selfRes);
  assert.equal(selfRes.statusCode, 400);
  assert.equal(selfRes.body.error.code, 'SELF_ANCHOR');

  const ghostRes = makeRes();
  await handler(makeReq('POST', { kind: 'workspace', id: 'ws_a', beforeId: 'ws_ghost' }), ghostRes);
  assert.equal(ghostRes.statusCode, 404);
  assert.equal(ghostRes.body.error.code, 'NO_ANCHOR');
});

test('路由：工作区排序成功时回新顺序', async () => {
  const { registry, calls } = makeRegistry();
  const handler = mount(registry);
  const res = makeRes();
  await handler(makeReq('POST', { kind: 'workspace', id: 'ws_a', beforeId: 'ws_b' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.order, ['ws_a', 'ws_b']);
  assert.deepEqual(calls.at(-1), ['wsInsertBefore', 'ws_a', 'ws_b']);
});

test('路由：会话锚点不在目标工作区里 → 400（不让宿主按未定义行为处理）', async () => {
  const { registry } = makeRegistry();
  const handler = mount(registry);
  const res = makeRes();
  await handler(makeReq('POST', { kind: 'session', sessionId: 's1', beforeId: 's3' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'ANCHOR_NOT_IN_WORKSPACE', 's3 在 ws_b，不在 s1 所在的 ws_a');
});

test('路由：跨工作区拖动 = 先脱离源组再挂目标组，并按锚点插入', async () => {
  const { registry, calls } = makeRegistry();
  const handler = mount(registry);
  const res = makeRes();
  await handler(makeReq('POST', { kind: 'session', sessionId: 's1', workspaceId: 'ws_b', beforeId: 's3' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    ['detach', 'ws_a', 's1'],
    ['attach', 'ws_b', 's1'],
    ['insertBefore', 'ws_b', 's1', 's3'],
  ]);
});

test('路由：跨组失败要挂回源组（不留下两边都没有的中间态）', async () => {
  const { registry, calls } = makeRegistry({ failEnd: ['ws_b'] });
  const handler = mount(registry);
  const res = makeRes();
  await handler(makeReq('POST', { kind: 'session', sessionId: 's1', workspaceId: 'ws_b' }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'ATTACH_FAILED');
  assert.deepEqual(calls, [
    ['detach', 'ws_a', 's1'],
    ['attach', 'ws_a', 's1'], // 回挂
  ]);
});
