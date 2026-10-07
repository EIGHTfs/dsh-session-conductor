// 逐 API 具体测试：只读端点（GET），不 import 宿主包、只打 HTTP。
//
// 覆盖服务端 webServer.register 注册的只读路由：
//   /i18n、/list、/fts-status、/templates、/compaction-model、/auto-rename-model、/auto-continue-gate
// 只读端点可安全反复调用，作为「固定基准」下的回归面。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, requireHost } from './helpers/host-api.mjs';

const hostUp = await requireHost();
const skip = hostUp ? false : '宿主不可用（未启动或端口不同；可用 SC_HOST 覆盖）';

test('GET /i18n：返回双语字典（zh 与 en 都在）', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/i18n');
  assert.equal(r.status, 200, `应 200（实得 ${r.status}）`);
  assert.ok(r.json && typeof r.json === 'object', '应返回对象');
  assert.ok('zh' in r.json, '应含 zh');
  assert.ok('en' in r.json, '应含 en');
});

test('GET /list：返回会话列表（ndjson 或 JSON 均可解析出内容）', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/list');
  assert.equal(r.status, 200, `应 200（实得 ${r.status}）`);
  assert.ok(String(r.text).length > 0, '响应不应为空');
});

test('GET /fts-status：返回检索索引状态', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/fts-status');
  assert.equal(r.status, 200, `应 200（实得 ${r.status}）`);
  assert.ok(r.json !== null, '应为 JSON');
});

test('GET /templates：返回模板槽位（方案 / 收尾）', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/templates');
  assert.equal(r.status, 200, `应 200（实得 ${r.status}）`);
  assert.ok(r.json !== null, '应为 JSON');
});

test('GET /compaction-model 与 /auto-rename-model：都返回模型配置（不得 500）', { skip }, async () => {
  for (const p of ['/api/session-conductor/compaction-model', '/api/session-conductor/auto-rename-model']) {
    const r = await api('GET', p);
    assert.equal(r.status, 200, `${p} 应 200（实得 ${r.status}）`);
  }
});

test('GET /auto-continue-gate：返回门禁状态（不得 500）', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/auto-continue-gate');
  assert.notEqual(r.status, 500, `不该 500（实得 ${r.status}）`);
  assert.ok([200, 400, 404].includes(r.status), `可接受的形态：200/400/404，实得 ${r.status}`);
});
