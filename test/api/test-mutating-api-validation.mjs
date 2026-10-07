// 逐 API 具体测试：有副作用端点的**参数校验路径**（零副作用，可安全反复跑）。
//
// 为什么先测校验路径：这些端点（delete / delete-batch / delete-by-rule / archive / unarchive /
// undo-message / detach / repair-*）正常路径会改动真实会话数据，需要夹具 + 自清理；
// 而它们的**入参校验**分支同样容易坏（参数名拼错、错误码不对、缺参抛 500），
// 且完全无副作用——先把这一层钉死，正常路径的夹具测试随后补。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, requireHost } from './helpers/host-api.mjs';

/** 非字符串 sessionId（校验路径专用）：数字是合法 JSON，但不是合法 sessionId 类型。 */
const NON_STRING_SESSION_ID = 12345;

const hostUp = await requireHost();
const skip = hostUp ? false : '宿主不可用（未启动或端口不同；可用 SC_HOST 覆盖）';

// 每个端点：空 body 必须回「参数类错误」（4xx），不得 500、不得成功
const MUST_REJECT_EMPTY = [
  '/api/session-conductor/delete',
  '/api/session-conductor/undo-message',
  '/api/session-conductor/archive',
  '/api/session-conductor/unarchive',
];

for (const path of MUST_REJECT_EMPTY) {
  test(`POST ${path.replace('/api/session-conductor/', '')}：空 body 必须 4xx（不得 500、不得成功）`, { skip }, async () => {
    const r = await api('POST', path, {});
    assert.notEqual(r.status, 500, `不该 500（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
    assert.ok(r.status >= 400 && r.status < 500, `应是 4xx 参数/权限类错误，实得 ${r.status}`);
    assert.notEqual(r.json?.ok, true, '不得返回成功');
  });
}

test('POST /delete：不存在的 sessionId 走幂等语义（200）或明确拒绝（409），不得 500', { skip }, async () => {
  // 实测语义：删一个已经不存在的会话返回 200（幂等：已经没了 = 目标达成）；
  // 代码里的 409 留给「会话运行中不能删」这类拒绝。两种都算正确，唯独不能 500。
  const r = await api('POST', '/api/session-conductor/delete', { sessionId: 'session-__no_such__' });
  assert.notEqual(r.status, 500, `不该 500（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
  assert.ok([200, 409].includes(r.status), `应回 200（幂等）或 409（拒绝），实得 ${r.status}`);
});

test('POST /delete：sessionId 非字符串必须 400', { skip }, async () => {
  const r = await api('POST', '/api/session-conductor/delete', { sessionId: NON_STRING_SESSION_ID });
  assert.equal(r.status, 400, `应回 400 参数错误（实得 ${r.status}）`);
});
