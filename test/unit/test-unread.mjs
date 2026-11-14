// 未读标记：坏值过滤 / 未读公式 / 落盘与重启后仍在
//
// 【守的是什么】
//   ① index-store 的 normalizeStore 是白名单重建 —— 新增 section 若没同时登记进
//      emptyStore 与 normalizeStore，会「写进去、重启就没了」且不报错。这条只能靠
//      「落盘 → 清内存态 → 重新读」的用例钉住，接口测试测不出来。
//   ② 未读公式必须容忍坏值：updatedAt 缺失不能整列表全未读，readAt 坏值不能吞掉新活动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resetStoreForTest, storeFilePath } from '../../lib/core/index-store.js';
import {
  UNREAD_VERSION,
  isUnread,
  markAllRead,
  markRead,
  sanitizeUnread,
  unreadSnapshot,
} from '../../lib/features/unread.js';

/** 每个用例用独立 DSH_HOME，互不影响。 */
function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-unread-'));
  const original = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  resetStoreForTest();
  try {
    return fn(home);
  } finally {
    process.env.DSH_HOME = original;
    resetStoreForTest();
    rmSync(home, { recursive: true, force: true });
  }
}

/** 插件 ctx 的最小子集：索引层只从 env 取 home，不真的用 ctx。 */
const fakeCtx = {};

test('sanitizeUnread：坏值一律当「没记过」，不静默吞掉', () => {
  const snap = sanitizeUnread({
    entries: {
      good: 1700000000000,
      zero: 0,
      negative: -5,
      nan: 'abc',
      nil: null,
      float: 1700000000000.9,
    },
    allReadAt: 'oops',
  });
  assert.equal(snap.version, UNREAD_VERSION);
  assert.deepEqual(Object.keys(snap.entries).sort(), ['float', 'good']);
  assert.equal(snap.entries.good, 1700000000000);
  assert.equal(snap.entries.float, 1700000000000, '小数向下取整');
  assert.equal(snap.allReadAt, 0, 'allReadAt 坏值 → 0');
});

test('isUnread：updatedAt 晚于已读时刻才算未读', () => {
  const snapshot = { entries: { s1: 1000 }, allReadAt: 0 };
  assert.equal(isUnread({ id: 's1', updatedAt: 1001 }, snapshot), true);
  assert.equal(isUnread({ id: 's1', updatedAt: 1000 }, snapshot), false, '相等算已读');
  assert.equal(isUnread({ id: 's2', updatedAt: 500 }, snapshot), true, '没记过的会话有新活动即未读');
});

test('isUnread：allReadAt 水位对没单独记过的会话生效', () => {
  const snapshot = { entries: {}, allReadAt: 2000 };
  assert.equal(isUnread({ id: 's9', updatedAt: 2000 }, snapshot), false);
  assert.equal(isUnread({ id: 's9', updatedAt: 2001 }, snapshot), true);
});

test('isUnread：updatedAt 缺失/非法 → 判为已读（不让整列表全红）', () => {
  const snapshot = { entries: {}, allReadAt: 0 };
  assert.equal(isUnread({ id: 's1' }, snapshot), false);
  assert.equal(isUnread({ id: 's1', updatedAt: NaN }, snapshot), false);
  assert.equal(isUnread({ id: 's1', updatedAt: 0 }, snapshot), false);
  assert.equal(isUnread(null, snapshot), false);
});

test('落盘 + 模拟重启：标记的已读时刻仍在（守 normalizeStore 白名单这个坑）', () => {
  withTempHome(() => {
    markRead(fakeCtx, 'session-a', { at: 1700000000000 });
    markAllRead(fakeCtx, 1700000001000);

    // 落盘文件确实写了 unread section
    const file = storeFilePath(fakeCtx);
    assert.ok(existsSync(file), '索引文件应已生成');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.unread?.entries?.['session-a'], 1700000000000);
    assert.equal(onDisk.unread?.allReadAt, 1700000001000);

    // 模拟重启：清掉进程内缓存，重新从磁盘读
    resetStoreForTest();
    const afterRestart = unreadSnapshot(fakeCtx);
    assert.equal(afterRestart.entries['session-a'], 1700000000000, '重启后已读时刻不能丢');
    assert.equal(afterRestart.allReadAt, 1700000001000, '重启后全局水位不能丢');
  });
});

test('标为未读：删掉该条已读时刻，未读状态由公式自然得出', () => {
  withTempHome(() => {
    // 已读时刻晚于会话最后活动 → 已读
    markRead(fakeCtx, 'session-b', { at: 1700000001000 });
    assert.equal(isUnread({ id: 'session-b', updatedAt: 1700000000500 }, unreadSnapshot(fakeCtx)), false);

    // 标为未读 = 删掉该条记录 → 只要有活动就重新显示未读
    markRead(fakeCtx, 'session-b', { read: false });
    assert.equal('session-b' in unreadSnapshot(fakeCtx).entries, false, '标未读 = 删掉该条记录');
    assert.equal(isUnread({ id: 'session-b', updatedAt: 1700000000500 }, unreadSnapshot(fakeCtx)), true);

    // 再重启一次，删除也要持久化（不能只在内存里删）
    resetStoreForTest();
    assert.equal('session-b' in unreadSnapshot(fakeCtx).entries, false);
  });
});

test('标记不传 at 时用当前时间；空 sessionId 不改动任何数据', () => {
  withTempHome(() => {
    const before = Date.now();
    const snap = markRead(fakeCtx, 'session-c');
    assert.ok(snap.entries['session-c'] >= before, '应记当前时间');

    const untouched = markRead(fakeCtx, '   ', { at: 1 });
    assert.equal('   ' in untouched.entries, false, '空 id 不应写入');
  });
});

test('索引不可用（无 DSH_HOME）时退回空快照，不抛', () => {
  const original = process.env.DSH_HOME;
  process.env.DSH_HOME = '';
  resetStoreForTest();
  try {
    const snap = unreadSnapshot(fakeCtx);
    assert.deepEqual(snap.entries, {});
    assert.equal(snap.allReadAt, 0);
  } finally {
    process.env.DSH_HOME = original;
    resetStoreForTest();
  }
});
