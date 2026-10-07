// 逐 API 具体测试：批量/破坏性端点的**安全构造用例**（零删除）。
//
// 为什么不能像别的端点那样「空 body 探测」：
//   delete-by-rule 的 inactiveDays 走 Math.max(0, …)（允许 0），界面文案「0=不限」
//   ⇒ 空 body 很可能等于「不限条件」，有删掉全部会话的风险。
// 读 handler 校验分支后，改用**明确安全**的构造：
//   delete-batch：非数组 → 400（校验分支）；sessionIds: [] → 空批，什么都不删
//   delete-by-rule：dryRun: true 预演 + inactiveDays: 3650（十年内无匹配）⇒ 零删除
//   detach：空 body → 400（sessionId 必须非空字符串）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, requireHost } from './helpers/host-api.mjs';

/** 十年（天）：足够大的 inactiveDays，保证按规则删除只预演、零匹配。 */
const TEN_YEARS_DAYS = 3650;

const hostUp = await requireHost();
const skip = hostUp ? false : '宿主不可用（未启动或端口不同；可用 SC_HOST 覆盖）';

test('POST /delete-batch：sessionIds 非数组必须 400', { skip }, async () => {
  const r = await api('POST', '/api/session-conductor/delete-batch', { sessionIds: 'not-an-array' });
  assert.equal(r.status, 400, `应回 400（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
});

test('POST /delete-batch：空数组是空批（200，零删除）', { skip }, async () => {
  const r = await api('POST', '/api/session-conductor/delete-batch', { sessionIds: [] });
  assert.notEqual(r.status, 500, `不该 500（实得 ${r.status}）`);
  assert.ok([200, 409].includes(r.status), `应回 200（空批）或 409，实得 ${r.status}`);
});

test('POST /delete-by-rule：dryRun 预演（inactiveDays 3650 十年内无匹配）零删除', { skip }, async () => {
  // 用 dryRun + 极大的 inactiveDays 保证「只预演、不匹配任何会话」⇒ 绝不删数据
  const r = await api('POST', '/api/session-conductor/delete-by-rule', { dryRun: true, inactiveDays: TEN_YEARS_DAYS });
  assert.notEqual(r.status, 500, `不该 500（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
  assert.equal(r.status, 200, `应回 200 预演结果（实得 ${r.status}）`);
});

test('POST /detach：空 body 必须 400（sessionId 必须非空字符串）', { skip }, async () => {
  const r = await api('POST', '/api/session-conductor/detach', {});
  assert.equal(r.status, 400, `应回 400（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
  assert.equal(r.json?.ok, false);
});
