// 跨会话消息 + 指定模型新建会话 —— 单测（直接 import 真模块，用假 sessionController 驱动）。
//
// 覆盖口径：参数校验链 / 禁自投 / 跳数 / 限流 / 幂等键透传 / 错误码映射 /
//          create → selectModel → prompt 的三步编排与「部分失败如实回执」。
// 真实投递链路的端到端验证不在这里（需要真实宿主），由会话内 toolcall 实测覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerSessionMessagingTools,
  formatSessionList,
  resetMessagingStateForTest,
} from '../../lib/features/session-messaging/index.js';

// ── 测试脚手架 ────────────────────────────────────────────────────────────

/** 捕获注册的工具定义：defineTool 是恒等函数，tools.register 收集到 Map。 */
function capture() {
  const defs = new Map();
  const defineTool = (def) => def;
  const tools = { register: (def) => { defs.set(def.name, def); } };
  return { defs, defineTool, tools };
}

/** 假 sessionController：记录每次调用的参数，行为可被 overrides 改写。 */
function makeSc(overrides = {}) {
  const calls = [];
  const sc = {
    calls,
    create: async (req) => { calls.push({ op: 'create', req }); return { sessionId: 'new-1' }; },
    selectModel: async (req) => { calls.push({ op: 'selectModel', req }); return { selected: { provider: req.provider, model: req.model } }; },
    prompt: async (req, signal) => { calls.push({ op: 'prompt', req, hasSignal: Boolean(signal) }); return { accepted: true }; },
    ...overrides,
  };
  return sc;
}

function makeCtx(sc) {
  return { get: (name) => (name === 'sessionController' ? sc : undefined) };
}

const SELF = { agent: { session: { id: 'self-1' } } };
const OTHER = 'other-9';

/** 注册并取回三个工具（每次都重置限流，避免用例互相污染）。 */
function setup(sc = makeSc()) {
  resetMessagingStateForTest();
  const { defs, defineTool, tools } = capture();
  const okRegistered = registerSessionMessagingTools(makeCtx(sc), defineTool, tools);
  return { sc, defs, okRegistered };
}

// ── 注册入口 ──────────────────────────────────────────────────────────────

test('注册：三个工具都注册上，且返回 true', () => {
  const { defs, okRegistered } = setup();
  assert.equal(okRegistered, true);
  assert.deepEqual([...defs.keys()].sort(), ['create_session', 'list_sessions', 'send_to_session']);
});

test('注册：defineTool 不是函数 → 返回 false（不抛错，避免连累同批工具）', () => {
  const tools = { register() {} };
  assert.equal(registerSessionMessagingTools(makeCtx(makeSc()), null, tools), false);
  assert.equal(registerSessionMessagingTools(makeCtx(makeSc()), () => {}, null), false);
});

// ── list_sessions 的纯格式化 ──────────────────────────────────────────────

test('formatSessionList：空列表给固定提示', () => {
  assert.equal(formatSessionList([], 'self-1'), '没有可见会话。');
  assert.equal(formatSessionList(null, 'self-1'), '没有可见会话。');
});

test('formatSessionList：状态词 / 当前会话 / 已归档 都标出来', () => {
  const text = formatSessionList([
    { id: 'self-1', title: 'A', cwd: '/w/a', running: true, live: true },
    { id: 'b-2', title: 'B', cwd: '/w/b', running: false, live: true },
    { id: 'c-3', title: 'C', cwd: '/w/c', live: false, archived: true },
  ], 'self-1');
  assert.match(text, /共 3 个会话/);
  assert.match(text, /self-1 ｜ A ｜ \/w\/a ｜ running \/ ← 当前会话/);
  assert.match(text, /b-2 ｜ B ｜ \/w\/b ｜ idle/);
  assert.match(text, /c-3 ｜ C ｜ \/w\/c ｜ inactive \/ 已归档/);
});

// ── send_to_session：校验链 ───────────────────────────────────────────────

test('send：sessionId 空 → 拒绝', async () => {
  const { defs } = setup();
  assert.match(await defs.get('send_to_session').execute({ text: 'hi' }, SELF), /sessionId 必填/);
});

test('send：禁止自投 → 拒绝，且不调用本体', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('send_to_session').execute({ sessionId: 'self-1', text: 'hi' }, SELF);
  assert.match(out, /不能投给自己/);
  assert.equal(sc.calls.length, 0);
});

test('send：text 为空 → 拒绝', async () => {
  const { defs } = setup();
  assert.match(await defs.get('send_to_session').execute({ sessionId: OTHER, text: '   ' }, SELF), /text 不能为空/);
});

test('send：text 超长 → 拒绝并提示落共享文件', async () => {
  const { defs } = setup();
  const out = await defs.get('send_to_session').execute({ sessionId: OTHER, text: 'x'.repeat(8 * 1024 + 1) }, SELF);
  assert.match(out, /超长/);
  assert.match(out, /共享文件/);
});

test('send：hops 达上限 → 拒绝并提示改用共享文件', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('send_to_session').execute({ sessionId: OTHER, text: 'hi', hops: 3 }, SELF);
  assert.match(out, /协作链跳数已达上限/);
  assert.equal(sc.calls.length, 0);
});

test('send：sessionController 不可用 → 明确失败（不假装成功）', async () => {
  resetMessagingStateForTest();
  const { defs, defineTool, tools } = capture();
  registerSessionMessagingTools({ get: () => undefined }, defineTool, tools);
  const out = await defs.get('send_to_session').execute({ sessionId: OTHER, text: 'hi' }, SELF);
  assert.match(out, /sessionController\.prompt 不可用/);
});

// ── send_to_session：正常路径与回执 ───────────────────────────────────────

test('send：默认 queue → 调本体 prompt，参数与 signal 都齐', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('send_to_session').execute({ sessionId: OTHER, text: 'hello' }, SELF);
  assert.match(out, /已投递到 other-9/);
  assert.equal(sc.calls.length, 1);
  const call = sc.calls[0];
  assert.equal(call.op, 'prompt');
  assert.equal(call.hasSignal, true, 'signal 必传（本体内部会 throwIfAborted）');
  assert.equal(call.req.sessionId, OTHER);
  assert.equal(call.req.mode, 'queue');
  assert.deepEqual(call.req.content, [{ type: 'text', text: 'hello' }]);
  assert.match(call.req.requestId, /^sc-/);
});

test('send：mode=steer 透传，回执说明注入当前回合', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('send_to_session').execute({ sessionId: OTHER, text: 'hi', mode: 'steer' }, SELF);
  assert.equal(sc.calls[0].req.mode, 'steer');
  assert.match(out, /注入其当前回合/);
});

test('send：调用方自带 requestId → 原样透传（幂等重试靠它）', async () => {
  const { sc, defs } = setup();
  await defs.get('send_to_session').execute({ sessionId: OTHER, text: 'hi', requestId: 'rid-fixed' }, SELF);
  assert.equal(sc.calls[0].req.requestId, 'rid-fixed');
});

test('send：本体错误码映射（agent-busy → target-busy，并带原文）', async () => {
  const err = Object.assign(new Error('prompt rejected'), { code: 'session/agent-busy' });
  const { defs } = setup(makeSc({ prompt: async () => { throw err; } }));
  const out = await defs.get('send_to_session').execute({ sessionId: OTHER, text: 'hi' }, SELF);
  assert.match(out, /投递失败（target-busy）/);
  assert.match(out, /prompt rejected/);
});

test('send：限流 —— 同对会话 60s 内第 6 条被拒', async () => {
  const { sc, defs } = setup();
  const tool = defs.get('send_to_session');
  for (let i = 0; i < 5; i++) {
    assert.match(await tool.execute({ sessionId: OTHER, text: `m${i}` }, SELF), /已投递到/);
  }
  const sixth = await tool.execute({ sessionId: OTHER, text: 'm5' }, SELF);
  assert.match(sixth, /限流/);
  assert.equal(sc.calls.length, 5, '第 6 条不应到达本体');
});

// ── create_session ────────────────────────────────────────────────────────

test('create：provider/model 必须成对', async () => {
  const { defs } = setup();
  assert.match(await defs.get('create_session').execute({ provider: 'wb' }), /必须成对/);
  assert.match(await defs.get('create_session').execute({ model: 'x' }), /必须成对/);
});

test('create：cwd 与 workspaceId 互斥', async () => {
  const { defs } = setup();
  assert.match(await defs.get('create_session').execute({ cwd: '/a', workspaceId: 'w1' }), /只能给一个/);
});

test('create：指定模型 → create + selectModel 两步，参数正确', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('create_session').execute({ provider: 'wb', model: 'global:x', cwd: '/w' });
  assert.deepEqual(sc.calls.map((c) => c.op), ['create', 'selectModel']);
  assert.deepEqual(sc.calls[0].req, { cwd: '/w' });
  assert.deepEqual(sc.calls[1].req, { sessionId: 'new-1', provider: 'wb', model: 'global:x' });
  assert.match(out, /已新建会话 new-1（模型 wb\/global:x）/);
});

test('create：带初始消息 → 第三步 prompt（queue）', async () => {
  const { sc, defs } = setup();
  await defs.get('create_session').execute({ provider: 'wb', model: 'global:x', text: '开始干活' });
  assert.deepEqual(sc.calls.map((c) => c.op), ['create', 'selectModel', 'prompt']);
  const promptCall = sc.calls[2];
  assert.equal(promptCall.req.sessionId, 'new-1');
  assert.equal(promptCall.req.mode, 'queue');
  assert.deepEqual(promptCall.req.content, [{ type: 'text', text: '开始干活' }]);
});

test('create：selectModel 失败 → 如实回执「会话已建，但模型未设置」', async () => {
  const err = Object.assign(new Error('no such model'), { code: 'session/model-unavailable' });
  const { defs } = setup(makeSc({ selectModel: async () => { throw err; } }));
  const out = await defs.get('create_session').execute({ provider: 'wb', model: 'bad' });
  assert.match(out, /已新建会话 new-1/);
  assert.match(out, /会话已建，但模型未设置/);
  assert.match(out, /no such model/);
});

test('create：create 抛错 → 直接失败，不做后续步骤', async () => {
  const err = Object.assign(new Error('workspace not found'), { code: 'workspace/not-found' });
  const calls = [];
  const { defs } = setup(makeSc({
    create: async (req) => { calls.push({ op: 'create', req }); throw err; },
  }));
  const out = await defs.get('create_session').execute({ workspaceId: 'nope' });
  assert.match(out, /新建失败/);
  assert.match(out, /workspace not found/);
  assert.deepEqual(calls.map((c) => c.op), ['create'], '只应尝试 create，不做 selectModel / prompt');
});

test('create：本体不返回 sessionId → 明确失败（不假装成功）', async () => {
  const { defs } = setup(makeSc({ create: async () => ({}) }));
  assert.match(await defs.get('create_session').execute({ cwd: '/w' }), /未返回 sessionId/);
});

test('create：不指定模型时不调 selectModel', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('create_session').execute({ cwd: '/w' });
  assert.deepEqual(sc.calls.map((c) => c.op), ['create']);
  assert.match(out, /未指定，跟随默认/);
});
