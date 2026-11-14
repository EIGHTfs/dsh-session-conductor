// 会话统计聚合：体积缺失语义 / 工作区分桶 / 活跃度窗口
//
// 【守的是什么】
//   ① 体积拿不到必须是 null，不能是 0 —— 0 会被读成「日志是空的」，而实际是「不知道」；
//   ② 分桶必须「注册表 sessionIds 优先」，否则被拖进别组的会话刷新后弹回原组；
//   ③ 活跃度窗口只统计最近 N 天，且不因为会话 updatedAt 非法就整表崩。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateStats,
  bucketByWorkspace,
  dayKey,
  sumBytes,
} from '../../lib/features/stats-aggregate.js';

const NOW = new Date('2026-11-14T12:00:00+08:00').getTime();
const DAY = 24 * 60 * 60 * 1000;

test('sumBytes：全有值 → 求和且完整', () => {
  assert.deepEqual(sumBytes(['a', 'b'], { a: 10, b: 5 }), { bytes: 15, bytesComplete: true });
});

test('sumBytes：一个都拿不到 → null（不是 0）', () => {
  assert.deepEqual(sumBytes(['a', 'b'], {}), { bytes: null, bytesComplete: false });
  assert.deepEqual(sumBytes(['a'], { a: 'oops' }), { bytes: null, bytesComplete: false });
});

test('sumBytes：部分拿到 → 求和但标明不完整', () => {
  assert.deepEqual(sumBytes(['a', 'b'], { a: 10 }), { bytes: 10, bytesComplete: false });
});

test('sumBytes：空列表 → 0 且完整（没有会话就是真的 0）', () => {
  assert.deepEqual(sumBytes([], {}), { bytes: 0, bytesComplete: true });
});

test('bucketByWorkspace：注册表 sessionIds 优先，未被登记的按 cwd 兜底', () => {
  const workspaces = [
    { id: 'w1', title: 'W1', path: '/a', sessionIds: ['s1'] },
    { id: 'w2', title: 'W2', path: '/a/b', sessionIds: [] },
  ];
  const sessions = [
    { id: 's1', cwd: '/a/b' },   // 注册表登记在 w1：即便 cwd 更贴近 w2 也归 w1
    { id: 's2', cwd: '/a/b/c' }, // 未登记：按最长前缀归 w2
    { id: 's3', cwd: '/zzz' },   // 谁都不匹配：未分组
  ];
  const buckets = bucketByWorkspace(sessions, workspaces);
  const byId = Object.fromEntries(buckets.map((b) => [b.id, b.sessionIds]));
  assert.deepEqual(byId.w1, ['s1']);
  assert.deepEqual(byId.w2, ['s2']);
  assert.deepEqual(byId[''], ['s3']);
});

test('bucketByWorkspace：宿主无分组能力（workspaces=null）→ 全部进未分组', () => {
  const buckets = bucketByWorkspace([{ id: 's1', cwd: '/a' }], null);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].id, '');
  assert.deepEqual(buckets[0].sessionIds, ['s1']);
});

test('dayKey：按本地时区产出 YYYY-MM-DD', () => {
  assert.match(dayKey(NOW), /^\d{4}-\d{2}-\d{2}$/);
});

test('aggregateStats：总数为 0 时体积是 0（空库是真的空），不是 null', () => {
  const stats = aggregateStats({ sessions: [], workspaces: null, sizes: {}, now: NOW });
  assert.equal(stats.totals.sessions, 0);
  assert.equal(stats.totals.bytes, 0);
  assert.equal(stats.totals.bytesComplete, true);
  assert.deepEqual(stats.largest, []);
});

test('aggregateStats：有会话但拿不到体积 → bytes 为 null', () => {
  const stats = aggregateStats({
    sessions: [{ id: 's1', updatedAt: NOW }],
    sizes: {},
    now: NOW,
  });
  assert.equal(stats.totals.bytes, null);
  assert.equal(stats.totals.bytesComplete, false);
});

test('aggregateStats：活跃/归档/在线分别计数', () => {
  const stats = aggregateStats({
    sessions: [
      { id: 's1', updatedAt: NOW, archived: false, live: true },
      { id: 's2', updatedAt: NOW, archived: true },
      { id: 's3', updatedAt: NOW, archived: false },
    ],
    sizes: { s1: 1, s2: 2, s3: 3 },
    now: NOW,
  });
  assert.equal(stats.totals.sessions, 3);
  assert.equal(stats.totals.active, 2);
  assert.equal(stats.totals.archived, 1);
  assert.equal(stats.totals.live, 1);
  assert.equal(stats.totals.bytes, 6);
});

test('aggregateStats：活跃度窗口是最近 N 天，窗口外的不计', () => {
  const stats = aggregateStats({
    sessions: [
      { id: 'today', updatedAt: NOW },
      { id: 'yesterday', updatedAt: NOW - DAY },
      { id: 'toolOld', updatedAt: NOW - 30 * DAY },
      { id: 'bad', updatedAt: Number.NaN },
    ],
    now: NOW,
    activityDays: 3,
  });
  assert.equal(stats.activity.length, 3);
  assert.equal(stats.activity[2].day, dayKey(NOW));
  assert.equal(stats.activity[2].count, 1);
  assert.equal(stats.activity[1].count, 1);
  assert.equal(stats.activity.reduce((sum, item) => sum + item.count, 0), 2, '窗口外与非法时间都不计');
});

test('aggregateStats：体积榜只收真正拿到大小的会话，按大小降序', () => {
  const stats = aggregateStats({
    sessions: [
      { id: 'big', title: '大', updatedAt: NOW },
      { id: 'small', title: '小', updatedAt: NOW },
      { id: 'unknown', title: '未知', updatedAt: NOW },
    ],
    sizes: { big: 900, small: 100 },
    now: NOW,
    largestLimit: 2,
  });
  assert.deepEqual(stats.largest.map((item) => item.id), ['big', 'small']);
  assert.equal(stats.largest[0].bytes, 900);
});
