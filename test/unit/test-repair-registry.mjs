// 修复注册表的防漂移护栏
//
// 【守的是什么】三类历史漂移，都是真实发生过的：
//   ① 后端登记了某项修复，但路由没注册 → 前端点了报 404；
//   ② 后端有路由，前端没入口 → 只能 curl 调（zstd 帧级 / seq 断裂 / 工具参数三类曾如此）；
//   ③ 前端自己硬编码 repair 路由 → 新增类型要改多处，漏一处就只剩半边。
// 现在单一真相是 lib/features/repair-registry.js，本测试把它钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPAIR_KINDS, repairKindById, repairKindsForClient } from '../../lib/features/repair-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 递归收集 lib/ 下所有 .js 源码（排除前端产物 client.js）。 */
function collectServerSources(dir = join(ROOT, 'lib'), out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { collectServerSources(full, out); continue; }
    if (!name.endsWith('.js')) continue;
    if (full.endsWith(join('lib', 'client.js'))) continue;
    out.push(full);
  }
  return out;
}

test('注册表每条 route 都真实注册在代码里（防「登记了没实现」）', () => {
  const sources = collectServerSources().map((file) => readFileSync(file, 'utf8'));
  for (const kind of REPAIR_KINDS) {
    const registered = sources.some((text) => text.includes(`"${kind.route}"`) || text.includes(`'${kind.route}'`));
    assert.ok(registered, `${kind.id} 登记的路由 ${kind.route} 在 lib/ 里找不到注册`);
  }
});

test('注册表每条 route 在 README 的 API 表里都有登记（防「代码有、文档没写」）', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  for (const kind of REPAIR_KINDS) {
    const short = kind.route.replace('/api/session-conductor', '');
    assert.ok(readme.includes(short), `README 缺 ${kind.id} 的路由 ${short}`);
  }
});

test('前端源码不出现任何 repair 路由字面量（防绕过注册表硬编码）', () => {
  const partsDir = join(ROOT, 'lib', 'client-parts');
  const offenders = [];
  for (const name of readdirSync(partsDir, { recursive: true })) {
    const rel = String(name);
    if (!rel.endsWith('.js')) continue;
    const text = readFileSync(join(partsDir, rel), 'utf8');
    // repair-kinds 是取清单的入口，允许出现；其余具体修复路由一律不许写死
    const hits = text.match(/\/api\/session-conductor\/repair-[a-z-]+/g) ?? [];
    for (const hit of hits) {
      if (hit === '/api/session-conductor/repair-kinds') continue;
      offenders.push(`${rel}: ${hit}`);
    }
  }
  assert.deepEqual(offenders, [], `前端出现了硬编码的修复路由：\n${offenders.join('\n')}`);
});

test('countPath 对空/异常响应都取到 0（前端不会显示 NaN）', () => {
  const countAtPath = (payload, path) => {
    const value = String(path ?? '').split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), payload);
    return Array.isArray(value) ? value.length : Number(value ?? 0);
  };
  const samples = [null, undefined, {}, { ok: true }, { report: {} }, { report: { corrupt: 3 } }, { eio: [1, 2] }];
  for (const kind of REPAIR_KINDS) {
    for (const payload of samples) {
      const count = countAtPath(payload, kind.countPath);
      assert.ok(Number.isFinite(count), `${kind.id} 在 ${JSON.stringify(payload)} 上取到非数字`);
      assert.ok(count >= 0, `${kind.id} 取到负数`);
    }
  }
});

test('id 唯一、i18nKey 有对应文案、按 id 能查回', () => {
  const ids = REPAIR_KINDS.map((kind) => kind.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');

  const zh = JSON.parse(readFileSync(join(ROOT, 'lib', 'i18n', 'zh.json'), 'utf8')).sessionConductor ?? {};
  for (const kind of REPAIR_KINDS) {
    for (const suffix of ['title', 'scanClean', 'confirm', 'done']) {
      assert.ok(`${kind.i18nKey}.${suffix}` in zh, `缺文案 ${kind.i18nKey}.${suffix}`);
    }
  }
  for (const kind of REPAIR_KINDS) {
    assert.equal(repairKindById(kind.id)?.route, kind.route);
  }
  assert.equal(repairKindById('nope'), null);
});

test('下发给前端的清单可序列化（不含函数）', () => {
  const client = repairKindsForClient();
  assert.equal(client.length, REPAIR_KINDS.length);
  for (const item of client) {
    for (const value of Object.values(item)) {
      assert.notEqual(typeof value, 'function', '清单里不能带函数');
    }
    assert.doesNotThrow(() => JSON.stringify(item));
  }
});
