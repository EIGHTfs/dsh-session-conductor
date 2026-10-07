// 列表缓存失效判定（纯函数）——非 GET 写请求失效；**dryRun 只读预览不失效**。
//
// 为什么钉这条：session-ops 的 6 条写路由原先在 readJson 之前**无条件**失效列表缓存，
//   于是「按条件删除」的 dryRun 预览也会打掉缓存 ⇒ 预览后紧接着的 /list 必须全量重建
//   （实测预览 48s、/list 由 7ms 缓存命中掉到 ~49s）。只读预览不该有这种副作用。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { depsReady, skipReason } from './helpers/host-deps.mjs';

// 该模块的依赖链里有宿主包（rename/title.js 静态 import 宿主包），用垫片解析后再动态导入。
const { shouldInvalidateListCache } = depsReady ? await import('../../lib/features/session-ops-routes.js') : {};

test('列表缓存失效判定：写请求失效、GET 与 dryRun 预览不失效', { skip: skipReason }, () => {
  // 写请求（真改动内容）→ 失效，让面板 refresh 立刻看到最新
  assert.equal(shouldInvalidateListCache('POST', {}), true, 'POST 空 body 应失效');
  assert.equal(shouldInvalidateListCache('POST', { sessionId: 'x' }), true);
  assert.equal(shouldInvalidateListCache('POST', { dryRun: false }), true);
  assert.equal(shouldInvalidateListCache('POST', undefined), true, 'body 缺失（如解析失败）仍按写请求处理');
  // 只读请求 → 不失效
  assert.equal(shouldInvalidateListCache('GET', {}), false, 'GET 不改内容');
  assert.equal(shouldInvalidateListCache('GET', { dryRun: true }), false);
  // dryRun 预览（按条件删除 / 撤回消息的预演）→ 不失效（本用例的核心回归点）
  assert.equal(shouldInvalidateListCache('POST', { dryRun: true }), false);
  assert.equal(shouldInvalidateListCache('POST', { dryRun: true, inactiveDays: 3650 }), false);
});
