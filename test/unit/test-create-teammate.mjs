// create_teammate_with_model —— 包装工具的单测（fake 团队服务 + 真实临时 DSH_HOME）。
//
// 覆盖：参数校验 / 无 spawnTeammate / 无调用方 agent / 正常路径（创建后立刻写 model/selection）。
// 说明：这里不碰真实 Team，只验证包装逻辑与「创建后立即设模型」这一步的接线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'sc-create-teammate-'));
process.env.DSH_HOME = home;

const { createTeammateWithModel, renderCreateTeammateResult } = await import('../../lib/features/member-model/create-teammate.js');
const { encodeSessionText } = await import('../../lib/repair.js');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 为新成员造一份真实的多帧会话日志（切换模型要能找到并写回它）。 */
async function makeMemberSession(sessionId) {
  const dir = join(home, 'sessions', 'grp-test', sessionId);
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 4, id: sessionId, cwd: '/tmp/demo' });
  const first = JSON.stringify({ type: 'user/message', seq: 0, time: Date.now(), data: { text: 'hi' } });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), await encodeSessionText(`${header}\n${first}\n`));
  return dir;
}

/** 造 fake ctx：agentTeams.spawnTeammate 记录入参并返回成员视图。 */
function makeCtx({ spawnTeammate } = {}) {
  return {
    logger,
    get: (name) => (name === 'agentTeams' ? { spawnTeammate } : null),
  };
}

const baseArgs = {
  name: 'test-member',
  description: '测试成员',
  prompt: '只回复 OK 即可',
  provider: 'agnes',
  model: 'agnes-3.0-flash',
};

test('缺参数时拒绝（name/description/prompt/provider/model 必填）', async () => {
  const ctx = makeCtx({ spawnTeammate: async () => ({ member: { id: 's-1' } }) });
  const exec = { agent: { id: 'lead' } };
  for (const missing of ['name', 'description', 'prompt', 'provider', 'model']) {
    const args = { ...baseArgs };
    delete args[missing];
    const result = await createTeammateWithModel(ctx, exec, args);
    assert.ok(result.error, `${missing} 缺失时应返回 error`);
  }
});

test('服务不暴露 spawnTeammate 时如实报错', async () => {
  const ctx = makeCtx({});
  const result = await createTeammateWithModel(ctx, { agent: { id: 'lead' } }, baseArgs);
  assert.match(result.error, /spawnTeammate/);
});

test('拿不到调用方 agent 时拒绝', async () => {
  const ctx = makeCtx({ spawnTeammate: async () => ({ member: { id: 's-1' } }) });
  const result = await createTeammateWithModel(ctx, {}, baseArgs);
  assert.match(result.error, /调用方 agent/);
});

test('正常路径：按入参创建，创建后立刻写 model/selection', async () => {
  const sessionId = 'session-created-1';
  const dir = await makeMemberSession(sessionId);
  const calls = [];
  const ctx = makeCtx({
    spawnTeammate: async (caller, request) => {
      calls.push({ caller, request });
      return { member: { id: sessionId, name: request.name, provider: request.provider, model: 'default-model' } };
    },
  });
  const exec = { agent: { id: 'lead-agent' } };

  const result = await createTeammateWithModel(ctx, exec, baseArgs);
  assert.ok(result.ok, `应成功：${JSON.stringify(result)}`);

  // 创建入参：prompt 转成 content block 数组、context 缺省 fresh、provider 透传
  assert.equal(calls.length, 1);
  assert.equal(calls[0].caller, exec.agent);
  assert.equal(calls[0].request.name, 'test-member');
  assert.equal(calls[0].request.provider, 'agnes');
  assert.equal(calls[0].request.context, 'fresh');
  assert.deepEqual(calls[0].request.prompt, [{ type: 'text', text: '只回复 OK 即可' }]);
  assert.ok(calls[0].request.signal, '必须传 AbortSignal');

  // 切换结果：应当已经写进该成员的会话日志（模型设置这一步不能静默失败）
  assert.ok(!result.switchResult.error, `设模型不应失败：${JSON.stringify(result.switchResult)}`);
  assert.match(String(result.switchResult.via), /model\/selection/);

  // 渲染文本要带上 sessionId 与那条「第一轮可能仍是默认模型」的边界说明
  const text = renderCreateTeammateResult(baseArgs, result);
  assert.match(text, new RegExp(sessionId));
  assert.match(text, /第一轮/);

  rmSync(dir, { recursive: true, force: true });
});

test('切换失败时仍然如实返回成员已创建（不谎报成功）', async () => {
  const ctx = makeCtx({
    spawnTeammate: async (caller, request) => ({ member: { id: 'session-no-log-xyz', name: request.name } }),
  });
  const result = await createTeammateWithModel(ctx, { agent: { id: 'lead' } }, baseArgs);
  assert.ok(result.ok);
  assert.ok(result.switchResult.error, '没有日志文件时应报切换失败');
  const text = renderCreateTeammateResult(baseArgs, result);
  assert.match(text, /模型设置失败/);
  assert.match(text, /set_member_model/, '应提示可稍后用 set_member_model 重试');
});

test.after(() => rmSync(home, { recursive: true, force: true }));
