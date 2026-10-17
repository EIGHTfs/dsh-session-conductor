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
  // 正文头部会自动带一行「【来自会话 <发送方 id>】」——接收方据此知道这条是谁发的
  // （此前裸投递，实测出现过「A 发的消息被 B 当成当前这一方发的」）。这里把该契约钉住。
  assert.equal(call.req.content.length, 1);
  assert.equal(call.req.content[0].type, 'text');
  assert.match(call.req.content[0].text, /^【来自会话 [\w-]+】\nhello$/);
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
  assert.match(out, /已新建会话 new-1（模型 wb\/global:x，工作目录 \/w）/);
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

// ── 缺省 cwd = 调用方会话的 cwd（2026-10-15 新增）──────────────────────────

const SELF_WITH_CWD = { agent: { session: { id: 'self-1', header: { cwd: '/w/mine' } } } };

test('create：不给 cwd → 缺省用调用方会话的 cwd（不是本体默认）', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('create_session').execute({}, SELF_WITH_CWD);
  assert.deepEqual(sc.calls[0].req, { cwd: '/w/mine' }, '应把调用方 cwd 传给本体');
  assert.match(out, /工作目录 \/w\/mine/);
});

test('create：显式 cwd 优先于调用方 cwd', async () => {
  const { sc, defs } = setup();
  await defs.get('create_session').execute({ cwd: '/w/explicit' }, SELF_WITH_CWD);
  assert.deepEqual(sc.calls[0].req, { cwd: '/w/explicit' });
});

test('create：给了 workspaceId 时不传 cwd（二者互斥）', async () => {
  const { sc, defs } = setup();
  await defs.get('create_session').execute({ workspaceId: 'ws-1' }, SELF_WITH_CWD);
  assert.deepEqual(sc.calls[0].req, { workspaceId: 'ws-1' });
});

test('create：取不到调用方 cwd 时不硬塞（交给本体默认）', async () => {
  const { sc, defs } = setup();
  await defs.get('create_session').execute({}, { agent: { session: { id: 'self-1' } } });
  assert.deepEqual(sc.calls[0].req, {});
});

// ── dryRun（2026-10-15 新增）──────────────────────────────────────────────

test('create dryRun：不建会话，但报告 cwd / 模型 / 初始消息', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('create_session').execute(
    { provider: 'agnes', model: 'agnes-3.0-flash', text: '开始干活', dryRun: true }, SELF_WITH_CWD,
  );
  assert.match(out, /【dryRun】未创建任何会话/);
  assert.match(out, /工作目录：\/w\/mine（缺省 = 调用方会话的 cwd）/);
  assert.match(out, /模型：agnes\/agnes-3\.0-flash/);
  assert.match(out, /初始消息：4 字符/);
  assert.equal(sc.calls.length, 0, 'dryRun 不得调用本体 create/selectModel/prompt');
});

test('create dryRun：模型不在目录里 → 明确告警（仍不建会话）', async () => {
  const sc = makeSc({
    modelCatalog: async () => ({ groups: [{ id: 'agnes', models: [{ id: 'agnes-3.0-flash' }] }] }),
  });
  const { defs } = setup(sc);
  const out = await defs.get('create_session').execute({ provider: 'agnes', model: '不存在的模型', dryRun: true });
  assert.match(out, /⚠️ model「不存在的模型」不在 provider「agnes」下/);
  assert.equal(sc.calls.length, 0);
});

test('create dryRun：模型在目录里 → 标核对通过', async () => {
  const sc = makeSc({
    modelCatalog: async () => ({ groups: [{ id: 'agnes', models: [{ id: 'agnes-3.0-flash' }] }] }),
  });
  const { defs } = setup(sc);
  const out = await defs.get('create_session').execute({ provider: 'agnes', model: 'agnes-3.0-flash', dryRun: true });
  assert.match(out, /✓ 已在模型目录里核对通过/);
});

test('send dryRun：不投递、不消耗限流配额，并报告目标与限流余量', async () => {
  const { sc, defs } = setup();
  const out = await defs.get('send_to_session').execute(
    { sessionId: OTHER, text: 'hello', dryRun: true }, SELF,
  );
  assert.match(out, /【dryRun】未投递任何消息/);
  assert.match(out, /限流：本窗口已用 0\/5/);
  assert.equal(sc.calls.length, 0, 'dryRun 不得调用本体 prompt');
  // 关键：dryRun 不能吃掉配额 —— 之后连投 5 条都应成功
  for (let i = 0; i < 5; i++) {
    assert.match(await defs.get('send_to_session').execute({ sessionId: OTHER, text: `m${i}` }, SELF), /已投递到/);
  }
});

test('send dryRun：dryRun 也照样执行本地校验（自投/超长等仍被拒）', async () => {
  const { defs } = setup();
  assert.match(
    await defs.get('send_to_session').execute({ sessionId: 'self-1', text: 'hi', dryRun: true }, SELF),
    /不能投给自己/,
  );
  assert.match(
    await defs.get('send_to_session').execute({ sessionId: OTHER, text: 'x'.repeat(8 * 1024 + 1), dryRun: true }, SELF),
    /超长/,
  );
});

// ── 会话列表脏数据防御（2026-10-15 新增）─────────────────────────────────

test('formatSessionList：缺 id 的脏条目被跳过并如实标注', () => {
  const text = formatSessionList([
    { id: 'a-1', title: 'A', cwd: '/w/a', live: true, running: false },
    { title: '(无标题)', cwd: null },            // 脏数据：没有 id
    undefined,                                    // 脏数据：整个条目缺失
    { id: 'b-2', title: 'B', cwd: '/w/b', live: false },
  ], null);
  assert.match(text, /共 2 个会话/);
  assert.match(text, /另有 2 条缺 id 的脏数据已跳过/);
  assert.ok(!/undefined/.test(text), '不得把 undefined 渲染进输出');
  assert.ok(!text.includes('- undefined'), '不得出现无 id 的条目行');
});

test('formatSessionList：全是脏数据时给出明确说明', () => {
  assert.match(formatSessionList([{ title: 'x' }], null), /没有可用会话（1 条缺 id 的脏数据已跳过）/);
});

// ── 分页与过滤（会话一多，整表输出会白烧调用方上下文）─────────────────────

/** 造 n 个会话条目，标题/工作区可辨识。 */
function manySessions(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `session-${String(i).padStart(3, '0')}`,
    title: i % 2 === 0 ? `偶数组-${i}` : `奇数组-${i}`,
    cwd: `/w/${i % 3}`,
    live: i < 2,
    updatedAt: 1_700_000_000_000 + i,
  }));
}

test('formatSessionList：limit 只给一页，并提示下一页的 offset', () => {
  const text = formatSessionList(manySessions(50), null, { limit: 10 });
  assert.match(text, /共 50 个会话/);
  assert.match(text, /本页 10 条（offset 0）/);
  assert.match(text, /还有 40 条，用 offset=10 取下一页/);
  assert.equal((text.match(/^- session-/gm) ?? []).length, 10, '只应渲染 10 行');
});

test('formatSessionList：offset 翻页且末页不再提示', () => {
  const text = formatSessionList(manySessions(25), null, { limit: 10, offset: 20 });
  assert.match(text, /本页 5 条（offset 20）/);
  assert.ok(!/取下一页/.test(text), '末页不该再提示下一页');
  assert.equal((text.match(/^- session-/gm) ?? []).length, 5);
});

test('formatSessionList：offset 越界给明确提示而不是报错/空输出', () => {
  const text = formatSessionList(manySessions(5), null, { limit: 10, offset: 99 });
  assert.match(text, /offset 99 超出范围（共 5 个会话，本页 0 条）/);
});

test('formatSessionList：query 按 id/标题/工作区子串过滤（不区分大小写）', () => {
  const byTitle = formatSessionList(manySessions(20), null, { query: '偶数组', limit: 100 });
  assert.match(byTitle, /（匹配「偶数组」）/);
  assert.equal((byTitle.match(/^- session-/gm) ?? []).length, 10, '20 条里偶数标题应命中 10 条');
  const byId = formatSessionList(manySessions(20), null, { query: 'SESSION-00' });
  assert.equal((byId.match(/^- session-/gm) ?? []).length, 10, 'id 匹配也要支持且大小写无关');
  const byCwd = formatSessionList(manySessions(9), null, { query: '/w/2' });
  assert.equal((byCwd.match(/^- session-/gm) ?? []).length, 3, '按工作区子串过滤');
});

test('formatSessionList：query 无命中时说明清楚（不是「没有可见会话」）', () => {
  const text = formatSessionList(manySessions(7), null, { query: '不存在的关键词' });
  assert.match(text, /没有匹配「不存在的关键词」的会话（共 7 个）/);
});

test('formatSessionList：不传 limit 仍返回全部（保持既有调用方语义）', () => {
  const text = formatSessionList(manySessions(30), null);
  assert.equal((text.match(/^- session-/gm) ?? []).length, 30);
  assert.ok(!/取下一页/.test(text));
});
