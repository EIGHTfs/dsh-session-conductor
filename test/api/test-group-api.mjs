// 逐 API 具体测试：/api/session-conductor/group/*
//
// 设计：测试**只打 HTTP**、不 import 任何宿主包；基准固定为「运行中的宿主」。
// 宿主不可用时**明确跳过**并说明（不伪装通过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, requireHost } from './helpers/host-api.mjs';

const hostUp = await requireHost();
const skip = hostUp ? false : '宿主不可用（未启动或端口不同；可用 SC_HOST 覆盖）';

test('GET /group/status：含 workspaceCount/groupRoot/profile/dshHome', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/group/status');
  assert.equal(r.status, 200, `应 200（实得 ${r.status}）`);
  assert.equal(r.json.ok, true);
  for (const k of ['workspaceCount', 'groupRoot', 'profile', 'dshHome']) {
    assert.ok(k in r.json, `响应应含字段 ${k}`);
  }
  assert.equal(typeof r.json.workspaceCount, 'number', 'workspaceCount 应为数字');
});

test('GET /group/list：workspaces 数组，每项含 workspaceId 与 path', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/group/list');
  assert.equal(r.status, 200, `应 200（实得 ${r.status}）`);
  assert.ok(Array.isArray(r.json.workspaces), 'workspaces 应为数组');
  if (r.json.workspaces.length) {
    const w = r.json.workspaces[0];
    assert.ok('workspaceId' in w, '每项应含 workspaceId');
    assert.ok('path' in w, '每项应含 path');
  }
});

test('POST /group/new-session：非法 workspaceId 必须是 404（不得 500，也不得误建）', { skip }, async () => {
  // 注意：**不要用空 body 测**——空 body 是合法路径（缺省用上次会话工作区），会真的建会话（有副作用）。
  // 这里用必然不存在的 workspaceId：应在「分组不存在」处 404 返回，且不产生任何创建行为。
  const r = await api('POST', '/api/session-conductor/group/new-session', { workspaceId: '__no_such_ws__' });
  assert.notEqual(r.status, 500, `非法 workspaceId 不该 500（实得 ${r.status}：${String(r.text).slice(0, 160)}）`);
  assert.equal(r.status, 404, `应回 404 分组不存在（实得 ${r.status}）`);
  assert.equal(r.json?.ok, false);
});

test('GET /group（缺 workspaceId）：不因缺参 500', { skip }, async () => {
  // 历史坑（2026-10-07 前）：这条路径曾**永不响应** —— /api/session-conductor/group 是
  //   kind:'prefix' 路由，旧 handler 走到末尾直接 return（无响应），框架不会继续找别的路由，
  //   请求就一直挂着 ⇒ 本文件 timeout 124、表现为「看不见的失败」。
  //   修复在 lib/group.js 末尾的兜底（未匹配一律 404）。两道护栏：
  //     ① test/unit/test-group-route-fallthrough.mjs —— 直接调 handler，断言必回 404（免宿主）；
  //     ② 本文件基座 host-api.mjs 加了 SC_TIMEOUT_MS 超时 —— 真挂了也会在 20s 内**明确报错**
  //        （「<method> <path> 无响应」），不再无限卡死。
  const r = await api('GET', '/api/session-conductor/group');
  assert.notEqual(r.status, 500, `缺参不该 500（实得 ${r.status}）`);
  assert.equal(r.status, 404, `应回 404（未匹配的 group 接口），实得 ${r.status}`);
});
