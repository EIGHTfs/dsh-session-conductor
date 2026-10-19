// create_teammate_with_model —— 包装工具的单测（fake 团队服务 + 真实临时 DSH_HOME）。
//
// 覆盖：参数校验 / 服务能力缺失 / 无调用方 / 正常四步流程（占位创建 → 中断 → 设模型 → 投递真实任务）
//       / 设模型失败时不投递（避免真实任务用默认模型跑掉）。
// 说明：不碰真实 Team，只验证接线与顺序。
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

/**
 * 造 fake ctx：三个团队能力都记录调用，用共享 order 数组证明顺序。
 */
function makeCtx({ memberId = '', sessionId = '', withSend = true } = {}) {
  const order = [];
  const calls = { spawn: [], interrupt: [], send: [] };
  const teams = {
    async spawnTeammate(caller, request) {
      order.push('spawn');
      calls.spawn.push({ caller, request });
      return { member: { id: sessionId || memberId, name: request.name, provider: request.provider, model: 'default-model' } };
    },
    interrupt(caller, target) {
      order.push('interrupt');
      calls.interrupt.push({ caller, target });
      return { previousStatus: 'running' };
    },
  };
  if (withSend) {
    teams.sendMessage = async (caller, request) => {
      order.push('send');
      calls.send.push({ caller, request });
      return { messageId: 'msg-1' };
    };
  }
  const subagents = { list: () => ['spawn', 'other-sub'] };
  return {
    ctx: {
      logger,
      get: (name) => {
        if (name === 'agentTeams') return teams;
        if (name === 'subagents') return subagents;
        return null;
      },
    },
    order,
    calls,
  };
}

const baseArgs = {
  name: 'test-member',
  description: '测试成员',
  prompt: '把 /tmp/a.txt 的内容读出来并汇报',
  provider: 'agnes',
  model: 'agnes-3.0-flash',
};

test('缺参数时拒绝（name/description/prompt/provider/model 必填）', async () => {
  const { ctx } = makeCtx({ sessionId: 's-1' });
  for (const missing of ['name', 'description', 'prompt', 'provider', 'model']) {
    const args = { ...baseArgs };
    delete args[missing];
    const result = await createTeammateWithModel(ctx, { agent: { id: 'lead' } }, args);
    assert.ok(result.error, `${missing} 缺失时应返回 error`);
  }
});

test('服务缺 spawnTeammate / sendMessage 时如实报错', async () => {
  const noSpawn = { logger, get: () => ({}) };
  assert.match((await createTeammateWithModel(noSpawn, { agent: {} }, baseArgs)).error, /spawnTeammate/);

  const { ctx: noSend } = makeCtx({ sessionId: 's-1', withSend: false });
  assert.match((await createTeammateWithModel(noSend, { agent: {} }, baseArgs)).error, /sendMessage/);
});

test('拿不到调用方 agent 时拒绝', async () => {
  const { ctx } = makeCtx({ sessionId: 's-1' });
  const result = await createTeammateWithModel(ctx, {}, baseArgs);
  assert.match(result.error, /调用方 agent/);
});

test('正常路径：占位创建 → 中断 → 设模型 → 投递真实任务（顺序与载荷都要对）', async () => {
  const sessionId = 'session-created-2';
  const dir = await makeMemberSession(sessionId);
  const { ctx, order, calls } = makeCtx({ sessionId });
  const exec = { agent: { id: 'lead-agent' } };

  const result = await createTeammateWithModel(ctx, exec, baseArgs);
  assert.ok(result.ok, `应成功：${JSON.stringify(result)}`);

  // 顺序：先创建、立刻中断、再投递（设模型夹在中断与投递之间，由日志体现，不在 order 里）
  assert.deepEqual(order, ['spawn', 'interrupt', 'send']);

  // ① 创建用的是占位任务，绝不能把真实任务带进首轮
  const spawnPrompt = calls.spawn[0].request.prompt;
  assert.equal(spawnPrompt.length, 1);
  assert.match(spawnPrompt[0].text, /待命/);
  assert.ok(!spawnPrompt[0].text.includes(baseArgs.prompt), '首轮不能带真实任务');
  assert.equal(calls.spawn[0].request.provider, 'spawn', '创建用的是子代理 provider，不是模型 provider');
  assert.equal(calls.spawn[0].request.context, 'fresh');
  assert.equal(calls.spawn[0].caller, exec.agent);

  // ② 中断传的是成员名
  assert.equal(calls.interrupt[0].target, 'test-member');

  // ③ ④ 真实任务在设模型之后投递，内容就是入参 prompt
  assert.equal(calls.send[0].request.target, 'test-member');
  assert.deepEqual(calls.send[0].request.content, [{ type: 'text', text: baseArgs.prompt }]);
  assert.ok(calls.send[0].request.signal, '投递必须带 AbortSignal');

  // 模型设置真的写进了该成员日志
  assert.ok(!result.switchResult.error, `设模型不应失败：${JSON.stringify(result.switchResult)}`);
  assert.match(String(result.switchResult.via), /model\/selection/);

  const text = renderCreateTeammateResult(baseArgs, result);
  assert.match(text, new RegExp(sessionId));
  assert.match(text, /真实任务已投递/);

  rmSync(dir, { recursive: true, force: true });
});

test('设模型失败时不投递真实任务（避免用默认模型白跑）', async () => {
  const { ctx, order } = makeCtx({ sessionId: 'session-no-log-xyz' });
  const result = await createTeammateWithModel(ctx, { agent: { id: 'lead' } }, baseArgs);
  assert.ok(result.ok);
  assert.ok(result.switchResult.error, '没有日志文件时应报切换失败');
  assert.equal(result.delivery, null, '不应投递');
  assert.deepEqual(order, ['spawn', 'interrupt'], '只应发生创建与中断，不该有 send');
  const text = renderCreateTeammateResult(baseArgs, result);
  assert.match(text, /放弃投递/);
  assert.match(text, /set_member_model/);
});

test('投递失败时如实回执（模型已设置）', async () => {
  const sessionId = 'session-created-3';
  const dir = await makeMemberSession(sessionId);
  const teams = {
    async spawnTeammate(caller, request) {
      return { member: { id: sessionId, name: request.name } };
    },
    interrupt: () => ({ previousStatus: 'running' }),
    sendMessage: async () => {
      throw new Error('inbox 已关闭');
    },
  };
  const ctx = {
    logger,
    get: (name) => (name === 'agentTeams' ? teams : name === 'subagents' ? { list: () => ['spawn'] } : null),
  };
  const result = await createTeammateWithModel(ctx, { agent: { id: 'lead' } }, baseArgs);
  assert.ok(result.ok);
  assert.ok(!result.switchResult.error, '模型应当已设置成功');
  assert.match(result.error, /投递真实任务失败/);
  assert.match(renderCreateTeammateResult(baseArgs, result), /inbox 已关闭/);
  rmSync(dir, { recursive: true, force: true });
});

test('显式 subagentProvider 优先；缺失且注册表为空时如实报错', async () => {
  const sessionId = 'session-created-4';
  const dir = await makeMemberSession(sessionId);
  const { ctx, calls } = makeCtx({ sessionId });
  await createTeammateWithModel(ctx, { agent: { id: 'lead' } }, { ...baseArgs, subagentProvider: 'other-sub' });
  assert.equal(calls.spawn[0].request.provider, 'other-sub');

  // 注册表为空 → 明确报错（避免再犯「拿模型 provider 去创建」的错）
  const noSub = {
    logger,
    get: (name) => (name === 'agentTeams'
      ? { spawnTeammate: async () => ({ member: { id: sessionId } }), interrupt: () => ({ previousStatus: 'running' }), sendMessage: async () => ({ messageId: 'm' }) }
      : name === 'subagents' ? { list: () => [] } : null),
  };
  const result = await createTeammateWithModel(noSub, { agent: { id: 'lead' } }, baseArgs);
  assert.match(result.error, /子代理 provider/);
  rmSync(dir, { recursive: true, force: true });
});

test.after(() => rmSync(home, { recursive: true, force: true }));
