// 未读标记单测（unread）：公式、容错、落盘往返、路由。
//
// 【为什么这些断言重要】未读是「时间戳比较」而不是布尔位 —— 一旦比较方向写反，
// 或者读盘时把坏值当成 0 以外的值，表现就是「永远有一个消不掉的红点」或
// 「永远看不到红点」，都属于用户能立刻感觉到、但看代码很难看出来的错误。
// 另一条关键断言是**重启后仍然生效**：index.json 的 normalizeStore 是白名单重建，
// 漏列 section 会让数据在下次启动时静默消失（读的时候还以为从来没有过）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// DSH_HOME 必须在本模块 import 之前定好：index-store 首次解析路径后会缓存。
const HOME = mkdtempSync(join(tmpdir(), 'sc-unread-'));
process.env.DSH_HOME = HOME;

const {
  isUnread, markRead, markUnread, markAllRead, readAtOf, unreadSnapshot, resetUnreadForTest,
} = await import('../../lib/features/unread.js');
const { resetStoreForTest } = await import('../../lib/core/index-store.js');
const { registerUnreadRoutes } = await import('../../lib/features/unread-routes.js');

/** 空 ctx：未读模块只走 index-store，不需要任何宿主服务。 */
const ctx = {};

/** 索引文件路径（与 index-store 的落盘位置一致）。 */
const INDEX_FILE = join(HOME, 'storages', 'dsh-session-conductor', 'index.json');

/** 清空内存缓存，模拟一次进程重启（磁盘文件保留）。 */
function simulateRestart() {
  resetUnreadForTest();
  resetStoreForTest();
}

test('初始状态：任何有过活动的会话都算未读', () => {
  resetUnreadForTest();
  resetStoreForTest();
  assert.equal(isUnread(ctx, 's1', 1000), true);
  assert.equal(readAtOf(ctx, 's1'), 0);
});

test('标记已读后：早于该时刻不算未读，晚于该时刻仍算未读', () => {
  markRead(ctx, 's1', 1500);
  assert.equal(isUnread(ctx, 's1', 1000), false, '更早的活动已被读过');
  assert.equal(isUnread(ctx, 's1', 2000), true, '更晚的活动应重新变未读');
  assert.equal(readAtOf(ctx, 's1'), 1500);
});

test('标记已读不会倒退（重复/更早的 at 被忽略）', () => {
  const changed = markRead(ctx, 's1', 1200);
  assert.equal(changed, false, 'at 更早应判为「无需改动」');
  assert.equal(readAtOf(ctx, 's1'), 1500);
});

test('手动标未读：删掉该会话的已读时刻', () => {
  assert.equal(markUnread(ctx, 's1'), true);
  assert.equal(isUnread(ctx, 's1', 1000), true);
  assert.equal(markUnread(ctx, 's1'), false, '重复标记应判为「无改动」');
});

test('全部已读：一个时间戳覆盖所有会话，但之后的新活动仍算未读', () => {
  markAllRead(ctx, 3000);
  assert.equal(isUnread(ctx, 's2', 2000), false);
  assert.equal(isUnread(ctx, 's3', 2500), false);
  assert.equal(isUnread(ctx, 's2', 3500), true, 'allReadAt 之后的活动必须重新变未读');
  assert.equal(unreadSnapshot(ctx).allReadAt, 3000);
});

test('落盘 + 重启后状态不丢（防 normalizeStore 白名单漏 section）', () => {
  const before = unreadSnapshot(ctx);
  assert.ok(before.allReadAt > 0, '前置条件：本轮确实写过');
  simulateRestart();
  const after = unreadSnapshot(ctx);
  assert.equal(after.allReadAt, before.allReadAt);
  assert.deepEqual(after.entries, before.entries);
});

test('坏数据不放大：非数字时间戳按「没记过」处理', () => {
  mkdirSync(dirname(INDEX_FILE), { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify({
    version: 1,
    unread: { entries: { good: 4000, bad: 'abc', zero: 0 }, allReadAt: 'x' },
  }), 'utf8');
  simulateRestart();
  assert.equal(readAtOf(ctx, 'good'), 4000);
  assert.equal(readAtOf(ctx, 'bad'), 0, '坏值应退化成未读，而不是随机数');
  assert.equal(readAtOf(ctx, 'zero'), 0, '0 不是有效的已读时刻');
  assert.equal(unreadSnapshot(ctx).allReadAt, 0);
});

test('极端值不抛：缺 sessionId / 非法时间', () => {
  assert.equal(markRead(ctx, '', 1000), false);
  assert.equal(markRead(ctx, 's9', Number.NaN), false);
  assert.equal(markUnread(ctx, ''), false);
  assert.equal(isUnread(ctx, '', 1000), false);
  assert.equal(isUnread(ctx, 's9', Number.NaN), false);
});

// ---------- 路由 ----------

/** 收集注册到的 handler（路由是闭包，只能这样测参数校验）。 */
function mountRoutes() {
  const handlers = new Map();
  const webServer = { register: ({ path, handler }) => handlers.set(path, handler) };
  registerUnreadRoutes({ webServer, ctx });
  return handlers;
}

/** 造一个只够 readJson 用的请求对象（async iterable of Buffer）。 */
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

/** 造一个收集应答的响应对象。 */
function makeRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(text) { this.body = JSON.parse(text); },
  };
}

test('路由：GET /unread 回快照；POST 缺 sessionId 回 400', async () => {
  const handlers = mountRoutes();
  const handler = handlers.get('/api/session-conductor/unread');
  assert.ok(handler, '应注册 /api/session-conductor/unread');

  const getRes = makeRes();
  await handler(makeReq('GET'), getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.ok, true);
  assert.equal(typeof getRes.body.entries, 'object');

  const badRes = makeRes();
  await handler(makeReq('POST', {}), badRes);
  assert.equal(badRes.statusCode, 400);
  assert.equal(badRes.body.error.code, 'NO_SESSION_ID');
});

test('路由：POST /unread 标记已读 / 标未读都可回写', async () => {
  const handlers = mountRoutes();
  const handler = handlers.get('/api/session-conductor/unread');

  const readRes = makeRes();
  await handler(makeReq('POST', { sessionId: 'route-1', at: 5000 }), readRes);
  assert.equal(readRes.statusCode, 200);
  assert.equal(readRes.body.entries['route-1'], 5000);

  const unreadRes = makeRes();
  await handler(makeReq('POST', { sessionId: 'route-1', read: false }), unreadRes);
  assert.equal(unreadRes.statusCode, 200);
  assert.equal(unreadRes.body.entries['route-1'], undefined);
});

test('路由：/unread/all 只接受 POST', async () => {
  const handlers = mountRoutes();
  const handler = handlers.get('/api/session-conductor/unread/all');
  assert.ok(handler);

  const getRes = makeRes();
  await handler(makeReq('GET'), getRes);
  assert.equal(getRes.statusCode, 405);

  const postRes = makeRes();
  await handler(makeReq('POST', { at: 7000 }), postRes);
  assert.equal(postRes.statusCode, 200);
  assert.equal(postRes.body.allReadAt, 7000);
});

test('清理临时 DSH_HOME', () => {
  rmSync(HOME, { recursive: true, force: true });
});
