// 存储域降级的自测（直接覆盖 lib/core/domain-fallback.js）。
//
// 背景：宿主 DomainImpl 关闭时先置 `disposing`，写链排空后才置 `closed`。若关闭卡住，
// 句柄会长期停在 disposing —— 此时 `closed` 仍是 false，但任何读写都抛「domain is closed」。
// 只看 closed 会把它当活域继续用，于是插件所有依赖持久化的功能一路 500，只能重启恢复。
//
// 降级策略：直接读写域自己的落盘 JSON（<DSH_HOME>/storages/dsh_session_conductor.json），
// 只接管 global 一节，unit / tables 原样保留（宿主下次启动要靠它们）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUsableDomain, fileFallbackDomain } from '../../lib/core/domain-fallback.js';

/** 造一个假的 DSH_HOME（含 storages/dsh_session_conductor.json），跑完恢复环境变量。 */
function withHome(t, global = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dom-'));
  const dir = join(home, 'storages');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'dsh_session_conductor.json');
  writeFileSync(file, JSON.stringify({ unit: { v: 1 }, global, tables: {} }));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  });
  return file;
}

test('活域判定：closed / disposing 都算不可用', () => {
  assert.equal(isUsableDomain(null), false, 'null 不可用');
  assert.equal(isUsableDomain(undefined), false, 'undefined 不可用');
  assert.equal(isUsableDomain({ closed: false }), true, '正常域可用');
  assert.equal(isUsableDomain({ closed: true }), false, '已关闭不可用');
  // 关键：关闭卡住时 closed 仍为 false，只看 closed 会误判为活域
  assert.equal(isUsableDomain({ closed: false, disposing: true }), false, '关闭中不可用');
});

test('后备域可读落盘值（global 一节）', (t) => {
  withHome(t, { autoContinueGate: 'closed', autoRename: { 's1': true } });
  const domain = fileFallbackDomain();
  assert.equal(domain.closed, false, '后备域应报告可用');
  const state = domain.global.get();
  assert.equal(state.autoContinueGate, 'closed');
  assert.deepEqual(state.autoRename, { s1: true });
});

test('后备域写入后 unit 与 tables 原样保留', async (t) => {
  const file = withHome(t, { autoContinueGate: 'closed' });
  const domain = fileFallbackDomain();
  await domain.global.set({ autoContinueGate: 'open' });

  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.global.autoContinueGate, 'open', '应写回新值');
  assert.deepEqual(after.unit, { v: 1 }, 'unit 段必须原样保留（宿主启动要用）');
  assert.deepEqual(after.tables, {}, 'tables 段必须原样保留');
});

test('后备域并发写不丢更新（内部串行）', async (t) => {
  const file = withHome(t, {});
  const domain = fileFallbackDomain();
  // 并发发起三次写：没有串行化时，读-改-写会互相覆盖，只剩最后一次
  await Promise.all([
    domain.global.set({ a: 1 }),
    domain.global.set({ b: 2 }),
    domain.global.set({ c: 3 }),
  ]);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after.global, { c: 3 }, '最后一次写生效，且文件仍可解析');
  assert.deepEqual(after.unit, { v: 1 }, 'unit 段仍保留');
});
