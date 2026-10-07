// 正常路径测试：在分组下新建会话（happy path）+ **自清理**。
//
// 覆盖缺口：此前只测了 new-session 的校验路径（非法 workspaceId → 404），正常路径没有测试。
//
// 副作用与安全设计：
//   · 会**真的创建一个会话**（这是该端点的正常行为），因此必须自清理：
//     测试结束（无论成败）都在 finally 里调用 POST /delete 删除刚创建的会话，并断言已删除。
//   · workspaceId 取「当前工作区列表里的第一个」——不新建工作区、不改动既有会话。
//
// ⚠️ 当前宿主跑的是**未安装本次修复的旧代码**（lib/group.js 的内部回环 RPC 四处全错）
//   ⇒ 该测试在重装前会**预期失败**；重装（收尾步骤）后应转为通过，正好作为「RPC 修复已生效」的证据。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, requireHost } from './helpers/host-api.mjs';

const hostUp = await requireHost();
const skip = hostUp ? false : '宿主不可用（未启动或端口不同；可用 SC_HOST 覆盖）';

test('POST /group/new-session：正常路径能建出会话，且随后可删除（自清理）', { skip }, async () => {
  // 取一个真实存在的分组（不新建工作区）
  const list = await api('GET', '/api/session-conductor/group/list');
  assert.equal(list.status, 200);
  const workspaceId = list.json?.workspaces?.[0]?.workspaceId;
  assert.ok(workspaceId, '列表里应有至少一个分组可供测试');

  let sessionId = null;
  try {
    const r = await api('POST', '/api/session-conductor/group/new-session', { workspaceId });
    assert.equal(r.status, 200, `正常路径应 200（实得 ${r.status}：${String(r.text).slice(0, 200)}）`);
    assert.equal(r.json?.ok, true, `应 ok:true（实得 ${String(r.text).slice(0, 200)}）`);
    sessionId = r.json?.sessionId;
    assert.ok(sessionId, '应返回 sessionId');
  } finally {
    // 自清理：无论上面断言是否失败，都要把测试建出来的会话删掉
    if (sessionId) {
      const del = await api('POST', '/api/session-conductor/delete', { sessionId });
      assert.equal(del.status, 200, `自清理应成功（实得 ${del.status}：${String(del.text).slice(0, 160)}）`);
    }
  }
});
