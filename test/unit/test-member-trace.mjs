// 成员轨迹读取（read_member_trace）与流式读日志底座（streamSessionEvents）自测。
//
// 背景：子代理只有「最后一条回复」会被宿主自动发回主代理；执行型子代理单轮可产生上百条
// assistant 消息（实测某会话单轮 115 条、全会话 1382 条，其中 939 条带 reasoning），
// 主代理只看得到最后一句结论。本模块按 turn → step 组织，把思考、正文、工具调用与结果一并取出。
//
// 本测试钉死六件事：
//   ① 公共底座：帧流式逐事件读、坏行跳过而不中断、空行忽略
//   ② 分轮与 step 分组正确（不同轮的思考不会串轮）
//   ③ reasoning 与 text **都要**（而不是像记忆取回那样二选一）
//   ④ tool/call 与 tool/result 正确配对成一条
//   ⑤ user/message 用**白名单**过滤注入（只认 user 与 agent-message）
//   ⑥ 格式化：summary / full、include 裁剪

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSessionText } from '../../lib/repair.js';
import { streamSessionEvents } from '../../lib/sessions/log-stream.js';
import { readMemberTrace, formatMemberTrace } from '../../lib/sessions/member-trace.js';

const SID = 'session-trace-test';

/** 造一个会话日志（header + 事件数组），返回文件路径。 */
async function makeSession(dir, events) {
  const home = join(dir, 'sessions');
  const sd = join(home, '--proj--', SID);
  mkdirSync(sd, { recursive: true });
  const header = { type: 'session', version: 4, id: SID, cwd: '/tmp/demo', createdAt: 1 };
  const lines = [JSON.stringify(header)];
  events.forEach((e, i) => lines.push(JSON.stringify({ seq: i, time: 1000 + i, ...e })));
  const file = join(sd, 'session.v4.jsonl.zstd');
  writeFileSync(file, await encodeSessionText(lines.join('\n') + '\n'));
  return { file, root: home };
}

/** 临时目录 + 自动清理。 */
function withTmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const userMsg = (text, kind = 'user') => ({
  type: 'user/message',
  data: { source: { kind }, content: [{ type: 'text', text }] },
});
const assistantMsg = (text, reasoning) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [
    ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
    ...(text ? [{ type: 'text', text }] : []),
  ] } },
});
const toolCall = (name, args) => ({ type: 'tool/call', data: { callId: 'c1', name, arguments: args } });
const toolResult = (ok = true) => ({ type: 'tool/result', data: { ok, message: { role: 'tool', content: [{ type: 'text', text: 'done' }] } } });

test('公共底座：逐事件流式读取，坏行跳过不中断', async () => {
  const buf = Buffer.from('');   // 占位，真实内容由下面构造
  void buf;
  const { encodeSessionText: enc } = await import('../../lib/repair.js');
  // 手造一份含坏行的文本：合法行、坏 JSON、空行、再合法行
  const text = [
    JSON.stringify({ type: 'session', version: 4, id: 'x' }),
    JSON.stringify({ type: 'turn/start', seq: 0 }),
    '{ 这不是 JSON',
    '',
    JSON.stringify({ type: 'turn/end', seq: 1 }),
    '',
  ].join('\n') + '\n';
  const events = [];
  const stat = await streamSessionEvents(await enc(text), (e) => events.push(e.type));
  assert.deepEqual(events, ['session', 'turn/start', 'turn/end'], '坏行与空行应被跳过，合法行全部到达');
  assert.equal(stat.events, 3);
  assert.equal(stat.bad, 1, '应统计出 1 个坏行');
});

test('轨迹：分轮分 step，不同轮的思考不串轮', async (t) => {
  const dir = withTmp(t);
  const { root } = await makeSession(dir, [
    { type: 'turn/start', data: {} },
    { type: 'step/start', data: { step: 1 } },
    userMsg('第一轮任务'),
    assistantMsg('第一轮正文', '第一轮思考'),
    { type: 'turn/end', data: {} },
    { type: 'turn/start', data: {} },
    { type: 'step/start', data: { step: 1 } },
    assistantMsg('第二轮正文A', '第二轮思考A'),
    { type: 'step/start', data: { step: 2 } },
    assistantMsg('第二轮正文B', '第二轮思考B'),
    { type: 'turn/end', data: {} },
  ]);
  const r = await readMemberTrace({}, SID, { rounds: 5, root });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.turns.length, 2, '应读出两轮');
  assert.equal(r.turns[0].task, '第一轮任务');
  assert.equal(r.turns[1].steps.length, 2, '第二轮应有两个 step');
  const t0Texts = JSON.stringify(r.turns[0]);
  assert.ok(t0Texts.includes('第一轮思考') && !t0Texts.includes('第二轮'), '第一轮不应混入第二轮内容');
});

test('轨迹：reasoning 与 text 都要（不二选一）', async (t) => {
  const dir = withTmp(t);
  const { root } = await makeSession(dir, [
    { type: 'turn/start', data: {} },
    { type: 'step/start', data: { step: 1 } },
    userMsg('任务'),
    assistantMsg('这是正文', '这是思考'),
    { type: 'turn/end', data: {} },
  ]);
  const r = await readMemberTrace({}, SID, { rounds: 1, root });
  const items = r.turns[0].steps[0].items;
  assert.ok(items.some((i) => i.kind === 'reasoning' && i.text.includes('这是思考')), '应保留 reasoning');
  assert.ok(items.some((i) => i.kind === 'text' && i.text.includes('这是正文')), '应保留正文');
});

test('轨迹：tool/call 与 tool/result 配对成一条', async (t) => {
  const dir = withTmp(t);
  const { root } = await makeSession(dir, [
    { type: 'turn/start', data: {} },
    { type: 'step/start', data: { step: 1 } },
    userMsg('任务'),
    toolCall('bash', { command: 'ls -la' }),
    toolResult(true),
    { type: 'turn/end', data: {} },
  ]);
  const r = await readMemberTrace({}, SID, { rounds: 1, root });
  const tools = r.turns[0].steps[0].items.filter((i) => i.kind === 'tool');
  assert.equal(tools.length, 1, '一次调用应只产生一条记录');
  assert.equal(tools[0].name, 'bash');
  assert.ok(tools[0].args.includes('ls -la'));
  assert.ok(tools[0].result.includes('成功'), `结果应回填：${tools[0].result}`);
});

test('轨迹：user/message 用白名单过滤注入（只认 user 与 agent-message）', async (t) => {
  const dir = withTmp(t);
  const { root } = await makeSession(dir, [
    { type: 'turn/start', data: {} },
    { type: 'step/start', data: { step: 1 } },
    userMsg('真实任务', 'user'),
    userMsg('主代理派单', 'agent-message'),
    // 以下全是注入，必须被滤掉
    userMsg('运行期上下文注入', 'runtime-context'),
    userMsg('skill 目录注入', 'skill-catalog'),
    userMsg('时间注入', 'time-context'),
    userMsg('插件注入', 'plugin:dsh-session-conductor'),
    assistantMsg('回复', ''),
    { type: 'turn/end', data: {} },
  ]);
  const r = await readMemberTrace({}, SID, { rounds: 1, root });
  const task = r.turns[0].task;
  assert.ok(task.includes('真实任务'), 'user 来源应保留');
  assert.ok(task.includes('主代理派单'), 'agent-message 来源应保留');
  for (const bad of ['运行期上下文注入', 'skill 目录注入', '时间注入', '插件注入']) {
    assert.ok(!task.includes(bad), `注入内容「${bad}」必须被滤掉`);
  }
});

test('轨迹：rounds 取最近 N 轮；空轮被丢弃', async (t) => {
  const dir = withTmp(t);
  const events = [];
  for (let i = 1; i <= 3; i += 1) {
    events.push({ type: 'turn/start', data: {} });
    events.push({ type: 'step/start', data: { step: 1 } });
    events.push(userMsg(`第${i}轮任务`));
    events.push(assistantMsg(`第${i}轮正文`));
    events.push({ type: 'turn/end', data: {} });
  }
  // 一个只有边界、没有内容的空轮
  events.push({ type: 'turn/start', data: {} }, { type: 'turn/end', data: {} });
  const { root } = await makeSession(dir, events);

  const one = await readMemberTrace({}, SID, { rounds: 1, root });
  assert.equal(one.turns.length, 1, 'rounds=1 只给最后一轮');
  assert.ok(JSON.stringify(one.turns).includes('第3轮任务'), '应是最近的一轮，且空轮不占名额');

  const two = await readMemberTrace({}, SID, { rounds: 2, root });
  assert.equal(two.turns.length, 2);
  assert.ok(JSON.stringify(two.turns).includes('第2轮任务'));
});

test('格式化：summary 压成一行、include 可裁剪、full 保留较长文本', async (t) => {
  const dir = withTmp(t);
  const long = 'A'.repeat(400);
  const { root } = await makeSession(dir, [
    { type: 'turn/start', data: {} },
    { type: 'step/start', data: { step: 1 } },
    userMsg('任务'),
    assistantMsg(long, '思考内容'),
    toolCall('bash', { command: 'echo 1' }),
    toolResult(true),
    { type: 'turn/end', data: {} },
  ]);
  const r = await readMemberTrace({}, SID, { rounds: 1, maxCharsPerItem: 2000, root });

  const all = formatMemberTrace(r.turns, { detail: 'summary' });
  assert.ok(all.includes('思考：'), 'summary 应含思考行');
  assert.ok(all.includes('调用 bash'), 'summary 应含工具行');
  assert.ok(all.includes('正文：'));

  const onlyTool = formatMemberTrace(r.turns, { detail: 'summary' }, new Set(['tool']));
  assert.ok(onlyTool.includes('调用 bash'), 'include=tool 应保留工具');
  assert.ok(!onlyTool.includes('思考：'), 'include=tool 不应含思考');
  assert.ok(!onlyTool.includes('正文：'), 'include=tool 不应含正文');

  const full = formatMemberTrace(r.turns, { detail: 'full' });
  assert.ok(full.includes('A'.repeat(200)), 'full 模式应保留长文本');
});

test('找不到会话日志时如实报错', async (t) => {
  const dir = withTmp(t);
  const r = await readMemberTrace({}, 'session-not-exist', { rounds: 1, root: join(dir, 'sessions') });
  assert.ok(r.error, '应返回 error');
  assert.match(r.error, /找不到会话日志/);
});
