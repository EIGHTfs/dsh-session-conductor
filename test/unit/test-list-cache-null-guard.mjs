// readListCache 空值兜底 —— 无缓存 / 缓存损坏 / 非数组时必须回 **[]**，不能回 null。
//
// 为什么钉这条（2026-10-12 事故）：
//   readListCache() 原先在「无缓存」时 return null，SessionManagerPanel 的 sessions 初值
//   因此是 null；流式 /list 每读到一行就 `setSessions((cur) => insertSorted(cur, item))`，
//   insertSorted 里的 `cur.filter(...)` 直接抛
//   `TypeError: Cannot read properties of null (reading 'filter')`。
//   React 更新器抛错 ⇒ `sidebar.footer.action` 插槽整块崩溃 ⇒ 侧边栏「会话管理」入口
//   从界面消失（用户观感：插件没了），且每次加载两条控制台红字。
//   触发条件极易命中：**全新浏览器上下文 / 清过站点数据 / localStorage 不可用**（空缓存）。
//
// 复现与验证：
//   · 纯函数级：本文件（假 localStorage 执行分片，不依赖宿主）
//   · 浏览器级：新上下文加载 DSH 页面 → 0 控制台错误、入口在、面板能打开（人工/脚本实测）
//
// 纪律：分片是独立可解析的片段（build.cjs 保证），故可直接用 new Function 执行后取函数，
//       不需要起宿主、不需要浏览器，跑得快且确定性高。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PART = join(ROOT, 'lib', 'client-parts', 'foundation', 'list-cache.js');
const PANEL = join(ROOT, 'lib', 'client-parts', 'components', 'panel.js');

/** 在假 localStorage 上执行分片，取回 readListCache / writeListCache。 */
function loadListCache(store = {}) {
  const src = readFileSync(PART, 'utf8');
  const fake = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const factory = new Function('localStorage', `${src}\nreturn { readListCache, writeListCache, LIST_CACHE_KEY };`);
  return factory(fake);
}

test('readListCache：无缓存时回空数组（不是 null）——事故根因', () => {
  const { readListCache } = loadListCache({});
  const got = readListCache();
  assert.ok(Array.isArray(got), `无缓存必须回数组，实际拿到 ${got === null ? 'null' : typeof got}`);
  assert.deepEqual(got, []);
});

test('readListCache：缓存损坏（非 JSON）时回空数组', () => {
  const { LIST_CACHE_KEY } = loadListCache({}); // 先取常量，避免在解构前引用（TDZ）
  const { readListCache } = loadListCache({ [LIST_CACHE_KEY]: '{ 这不是 JSON' });
  assert.deepEqual(readListCache(), []);
});

test('readListCache：sessions 字段不是数组时回空数组', () => {
  const { LIST_CACHE_KEY } = loadListCache({});
  const { readListCache } = loadListCache({ [LIST_CACHE_KEY]: JSON.stringify({ at: 1, sessions: { a: 1 } }) });
  assert.deepEqual(readListCache(), []);
  const { readListCache: r2 } = loadListCache({ [LIST_CACHE_KEY]: JSON.stringify({ at: 1 }) });
  assert.deepEqual(r2(), []);
});

test('readListCache / writeListCache：正常往返仍是数组', () => {
  const store = {};
  const { readListCache, writeListCache } = loadListCache(store);
  const list = [{ id: 's1', updatedAt: 2 }, { id: 's2', updatedAt: 1 }];
  writeListCache(list);
  assert.deepEqual(readListCache(), list);
});

test('结构护栏：insertSorted 必须对 cur 做数组兜底', () => {
  const src = readFileSync(PANEL, 'utf8');
  const m = src.match(/const insertSorted = \(cur, item\) => \{[\s\S]*?\n {6}\};/);
  assert.ok(m, '未找到 insertSorted 定义（函数名/缩进变了要同步本测试）');
  assert.match(
    m[0],
    /Array\.isArray\(cur\)/,
    'insertSorted 必须写成 (Array.isArray(cur) ? cur : []) —— 否则 sessions 为 null 时 cur.filter 会炸掉整个插槽',
  );
});
