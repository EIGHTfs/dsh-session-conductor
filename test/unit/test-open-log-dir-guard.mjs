// 打开日志目录：路径安全判定的单元测试
//
// 【守的是什么】这个功能的输入会参与文件路径解析，判错等于把任意目录暴露给调用方。
// 三层防线各自独立可测：
//   ① sessionId 白名单（挡 `..` / 分隔符）
//   ② realpath 失败一律拒绝（不抛、不猜）
//   ③ 前缀比对必须带分隔符（否则 `/sessions-evil` 会被当成在 `/sessions` 之内）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { SAFE_SESSION_ID, insideRoot, safeRealpath } from '../../lib/shared/path-guard.js';

test('sessionId 白名单：接受正常 id，拒绝路径穿越与分隔符', () => {
  const ok = [
    'session-4625248d-8fdb-401b-af16-fe5fd90f4b43',
    'abc',
    'A_b.c-d',
    'x'.repeat(128),
  ];
  const bad = [
    '../etc/passwd',
    'a/b',
    'a\\b',
    '..',
    '',
    'x'.repeat(129),
    'a b',
    'a\nb',
  ];
  for (const id of ok) assert.ok(SAFE_SESSION_ID.test(id), `应接受：${id}`);
  for (const id of bad) assert.ok(!SAFE_SESSION_ID.test(id), `应拒绝：${JSON.stringify(id)}`);
});

test('insideRoot：根目录本身算在内，子目录算在内', () => {
  const root = `${sep}sessions`;
  assert.equal(insideRoot(root, root), true);
  assert.equal(insideRoot(`${root}${sep}ws-1${sep}session-a${sep}x.zstd`, root), true);
});

test('insideRoot：同前缀的兄弟目录不算在内（必须比对分隔符）', () => {
  // `/sessions-evil` 与 `/sessions` 同前缀，但不是子目录
  assert.equal(insideRoot(`${sep}sessions-evil${sep}x`, `${sep}sessions`), false);
  assert.equal(insideRoot(`${sep}sessions2`, `${sep}sessions`), false);
});

test('insideRoot：根本身带尾分隔符时也能正确判定', () => {
  const root = `${sep}sessions${sep}`;
  assert.equal(insideRoot(`${sep}sessions${sep}a`, root), true);
  assert.equal(insideRoot(`${sep}sessions-evil`, root), false);
});

test('insideRoot：完全无关的路径为 false', () => {
  assert.equal(insideRoot(`${sep}etc${sep}passwd`, `${sep}sessions`), false);
});

test('safeRealpath：存在的路径返回真实路径，不存在返回 null 且不抛', () => {
  assert.equal(safeRealpath(realpathSync, process.cwd()), realpathSync(process.cwd()));
  assert.equal(safeRealpath(realpathSync, `${process.cwd()}${sep}__definitely_missing__`), null);
});

test('safeRealpath：realpath 自身抛错时被吞成 null（不把异常抛给调用方）', () => {
  const boom = () => { throw new Error('boom'); };
  assert.equal(safeRealpath(boom, '/whatever'), null);
});
