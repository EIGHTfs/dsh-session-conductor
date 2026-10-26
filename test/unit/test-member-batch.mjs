// 批量切换 + 「跟随主代理」自测。
//
// 约定（本次增强的语义）：
//   · target 空 / `*` / `all`  = 作用于全部成员（**排除 Lead 本人**，也排除 provisioning/failed）
//   · provider/model/preset 空 = 跟随主代理（Team Lead）当前值
//   · 批量执行串行、逐个隔离失败、回执带完整名单
//
// 本测试钉死：目标解析的过滤规则、Lead 定位的两条路径、跟随取值的来源与缺失报错、批量统计。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSessionText } from '../../lib/repair.js';
import { isAllTarget, resolveTargets, resolveLeader } from '../../lib/features/member-model/locate.js';
import { readLeaderRoute } from '../../lib/features/member-model/lead.js';
import { applyPermissionToMany } from '../../lib/features/member-model/batch.js';

const LEAD_ID = 'session-lead-test';
const M1 = 'session-m1-test';
const M2 = 'session-m2-test';

/** 在临时 DSH_HOME 里造一个会话日志。 */
async function makeSession(home, id, events) {
  const dir = join(home, 'sessions', '--proj--', id);
  mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/demo' };
  const lines = [JSON.stringify(header)];
  let seq = 0;
  for (const e of events) lines.push(JSON.stringify({ seq: seq++, time: 1000 + seq, ...e }));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), await encodeSessionText(lines.join('\n') + '\n'));
}

const FULL_ACCESS = { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
const WS_WRITE = { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' };

/** 名册：Lead + 2 个正常成员 + 1 个正在创建 + 1 个失败。 */
function roster() {
  return [
    { id: LEAD_ID, name: 'lead', role: 'lead', status: 'running' },
    { id: M1, name: 'm1', role: 'teammate', status: 'inactive' },
    { id: M2, name: 'm2', role: 'teammate', status: 'active' },
    { id: 'session-provisioning', name: 'p1', role: 'teammate', status: 'provisioning' },
    { id: 'session-failed', name: 'f1', role: 'teammate', status: 'failed' },
  ];
}

function makeCtx({ members = roster(), catalog = { options: [FULL_ACCESS, WS_WRITE], defaultPreset: 'workspace-write' } } = {}) {
  const agent = (id) => ({ session: { id } });
  const agentsMap = Object.fromEntries(members.map((m) => [m.id, agent(m.id)]));
  return {
    get(name) {
      if (name === 'agentTeams') return { listMembers: () => members };
      if (name === 'agents') return { list: () => Object.values(agentsMap), get: (id) => agentsMap[id] ?? null };
      if (name === 'permissionPresets') return catalog ? { catalog: async () => catalog } : undefined;
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

function withHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-batch-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('isAllTarget：空 / * / all 都算「全部」', () => {
  for (const v of ['', '  ', '*', 'all', 'ALL', 'All']) assert.equal(isAllTarget(v), true, `「${v}」应算全部`);
  for (const v of ['m1', 'session-x', 'all-members', 'aal']) assert.equal(isAllTarget(v), false, `「${v}」不应算全部`);
});

test('resolveTargets：全部时排除 Lead、provisioning、failed', () => {
  const ctx = makeCtx();
  for (const target of ['', '*', 'all']) {
    const resolved = resolveTargets(ctx, target, { caller: { session: { id: LEAD_ID } } });
    assert.equal(resolved.all, true);
    const ids = resolved.targets.map((t) => t.sessionId).sort();
    assert.deepEqual(ids, [M1, M2], '只应包含两个可操作的普通成员');
  }
});

test('resolveTargets：全是不可操作成员时如实报错', () => {
  const ctx = makeCtx({ members: [
    { id: LEAD_ID, name: 'lead', role: 'lead', status: 'running' },
    { id: 'session-provisioning', name: 'p1', role: 'teammate', status: 'provisioning' },
  ] });
  const resolved = resolveTargets(ctx, '*', { caller: { session: { id: LEAD_ID } } });
  assert.ok(resolved.error);
  assert.match(resolved.error, /没有可操作/);
});

test('resolveTargets：单个目标走精确匹配', () => {
  const ctx = makeCtx();
  const resolved = resolveTargets(ctx, 'm1', { caller: { session: { id: LEAD_ID } } });
  assert.equal(resolved.all, false);
  assert.equal(resolved.targets.length, 1);
  assert.equal(resolved.targets[0].sessionId, M1);
});

test('resolveLeader：发起方自己就是 Lead 时直接用它', () => {
  const ctx = makeCtx();
  const lead = resolveLeader(ctx, { caller: { session: { id: LEAD_ID } } });
  assert.equal(lead.sessionId, LEAD_ID);
  assert.match(String(lead.source), /发起方即 Lead/);
});

test('resolveLeader：发起方是普通成员时取名册的 Lead 行', () => {
  const ctx = makeCtx();
  const lead = resolveLeader(ctx, { caller: { session: { id: M1 } } });
  assert.equal(lead.sessionId, LEAD_ID, '应定位到 Lead 而不是发起方自己');
  assert.match(String(lead.source), /名册 Lead 行/);
});

test('readLeaderRoute：模型取请求级记录，权限取最后一条 preset', async (t) => {
  const home = withHome(t);
  await makeSession(home, LEAD_ID, [
    { type: 'permission/preset', data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
    { type: 'request/header', data: { header: { config: { provider: 'sa6400', model: 'deepseek-v4.1-flash' } } } },
    { type: 'permission/preset', data: { preset: 'danger-full-access' } },
  ]);
  const route = await readLeaderRoute(makeCtx(), { caller: { session: { id: LEAD_ID } } });
  assert.equal(route.error, undefined, JSON.stringify(route));
  assert.equal(route.provider, 'sa6400');
  assert.equal(route.model, 'deepseek-v4.1-flash');
  assert.match(String(route.modelSource), /请求级记录/);
  assert.equal(route.preset, 'danger-full-access', '应取最后一条 preset');
  assert.equal(route.sandbox, 'workspace-write');
  assert.equal(route.approval, 'ask');
});

test('readLeaderRoute：日志里没有 request/header 时如实报错（不拿名册静态值冒充）', async (t) => {
  const home = withHome(t);
  await makeSession(home, LEAD_ID, [{ type: 'permission/preset', data: { preset: 'danger-full-access' } }]);
  const route = await readLeaderRoute(makeCtx(), { caller: { session: { id: LEAD_ID } } });
  assert.ok(route.error, '应报错');
  assert.match(route.error, /读不到主代理|请显式指定/);
});

test('applyPermissionToMany：逐条串行、失败隔离、统计正确', async (t) => {
  const home = withHome(t);
  // M1、M2 都有日志；M3 故意不建 → 那一行应失败且不影响其它
  await makeSession(home, M1, [{ type: 'permission/preset', data: { preset: 'auto' } }]);
  await makeSession(home, M2, [{ type: 'permission/preset', data: { preset: 'auto' } }]);
  const targets = [
    { sessionId: M1, member: { name: 'm1' } },
    { sessionId: M2, member: { name: 'm2' } },
    { sessionId: 'session-missing', member: { name: 'gone' } },
  ];
  const report = await applyPermissionToMany(makeCtx(), targets, 'danger-full-access');
  assert.equal(report.rows.length, 3);
  assert.equal(report.okCount, 2);
  assert.equal(report.failCount, 1);
  assert.ok(report.rows[2].ok === false, '缺失会话应失败');
  assert.match(report.rows[2].detail, /日志不存在|失败/);
  // 成功的两行 detail 应体现 from → to
  assert.match(report.rows[0].detail, /auto → danger-full-access/);
});
