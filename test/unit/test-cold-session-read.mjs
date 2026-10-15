// 冷会话读取回归 —— 全量读的真实行为 + 「禁止改回分块读」的护栏。
//
// 【背景·为什么不做分块读】曾尝试把 `handle.read(0, undefined)` 改成分块 `read(offset, chunk)`
// 以「降低内存峰值」，实测证明是**错的优化**：宿主 `readCurrent` 每次调用都会
// `readStoredLog(path)` 把整份日志读进来解压，offset/length 只是在内存数组上 `slice`
// （见 packages/session/session-persistence-jsonl/src/storage.ts）。于是分块读
//   · 内存峰值**不变**（每次仍物化全部事件）
//   · 耗时变成 N 次全量解压 ⇒ O(n²)（api 门禁里 /list 直接 >120s 超时）
// 结论：宿主 API 不能流式读；内存控制只能靠「别重复解析」＝列表磁盘缓存（revision 命中跳过）。
// 本文件用假 handle 钉住「全量读」这一既定契约，并断言 list.js 走的就是它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readColdSessionEvents } from '../../lib/sessions/events.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVENTS_SRC = readFileSync(join(ROOT, 'lib', 'sessions', 'events.js'), 'utf8');
const LIST_SRC = readFileSync(join(ROOT, 'lib', 'sessions', 'list.js'), 'utf8');

/** 假 handle：记录调用参数；read 返回给定事件（模拟「每次都全量」的后端）。 */
function makeHandle(events, header = { id: 'sess-1' }) {
  const calls = [];
  return {
    header,
    calls,
    async read(offset, length) { calls.push({ offset, length }); return { events }; },
    async close() { calls.push({ close: true }); },
  };
}
const makeCtx = (handle) => ({ get: (n) => (n === "sessionPersistence" ? { open: async () => handle } : undefined) });
const makeEvents = (n) => Array.from({ length: n }, (_, i) => ({ seq: i, type: "step/start", time: 1000 + i }));

test('全量读：一次 read(0, undefined) 拿回全部事件（宿主 API 的既定契约）', async () => {
  const handle = makeHandle(makeEvents(300));
  const result = await readColdSessionEvents(makeCtx(handle), 'sess-1');
  assert.equal(result.events.length, 300, '必须返回全部事件（续跑扫描等调用方依赖它）');
  const reads = handle.calls.filter((c) => !c.close);
  assert.equal(reads.length, 1, '只应调用一次 read（分块读会变成 N 次全量解压）');
  assert.equal(reads[0].offset, 0);
  assert.equal(reads[0].length, undefined, '契约是 read(0, undefined) —— 传有限 length 也仍是全量解压，别被误导');
});

test('全量读：meta 取 handle.header，且读取后必须 close', async () => {
  const handle = makeHandle(makeEvents(3), { id: 'abc', cwd: '/w' });
  const result = await readColdSessionEvents(makeCtx(handle), 'abc');
  assert.equal(result.meta?.id, 'abc');
  assert.ok(handle.calls.some((c) => c.close), '必须 close（否则句柄泄漏）');
});

test('全量读：宿主无 open 能力 → 返回 null（不抛）', async () => {
  assert.equal(await readColdSessionEvents({ get: () => ({}) }, 's'), null);
  assert.equal(await readColdSessionEvents({ get: () => undefined }, 's'), null);
});

test('全量读：读取失败向上抛（列表据此带出 inspectError），且仍会 close', async () => {
  const boom = {
    header: { id: 's' },
    async read() { throw new Error('损坏的日志'); },
    async close() { this.closed = true; },
  };
  await assert.rejects(() => readColdSessionEvents(makeCtx(boom), 's'), /损坏的日志/);
  assert.equal(boom.closed, true, '读失败也必须 close（finally 保证）');
});

test('宿主包缺失时（自测环境）补闭合器优雅降级，不影响事件返回', async () => {
  const events = makeEvents(5);
  const result = await readColdSessionEvents(makeCtx(makeHandle(events)), 'sess-1');
  assert.ok(Array.isArray(result.events) && result.events.length >= events.length, '事件必须原样返回');
});

// ── 护栏：防止有人再改回「分块读」这个错误优化 ──────────────────────────

test('护栏：events.js 不得出现分块读循环（offset += / 多次 read 推进）', () => {
  // 允许注释里讨论，因此只看去掉注释行后的代码
  const code = EVENTS_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(
    /handle\.read\(0, undefined\)/.test(code),
    '冷会话读法必须是单次 read(0, undefined)：分块读在宿主 API 下内存峰值不变、耗时变 O(n²)',
  );
  assert.ok(
    !/for\s*\(\s*;;\s*\)/.test(code) && !/offset \+= chunk/.test(code),
    '不得引入分块读循环（readCurrent 每次都会全量解压）',
  );
});

test('护栏：list.js 必须用全量读函数（并说明内存靠缓存而非分块）', () => {
  assert.match(LIST_SRC, /await readColdSessionEvents\(ctx, entry\.meta\.id\)/, 'list.js 必须调用 readColdSessionEvents');
  assert.ok(
    !/readColdSessionSummary/.test(LIST_SRC),
    '不得再引用已删除的分块读函数（它只会让内存峰值不变、耗时变 O(n²)）',
  );
});
