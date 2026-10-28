// 列表 job 化 / 索引直读 / 跨会话取回 —— 三条新能力的回归。
//
// 【为什么钉这些】
//   ① 冷缓存全量构建实测 226 秒（201 会话 / 1.5 GB 日志）⇒ 慢路径必须能转后台 job，
//      且**无 jobs 服务时必须退回同步并说明原因**（不能静默失败，否则工具直接报错）；
//   ② `fromIndex=true` 是「先拿 id」的快路径 ⇒ 必须真的不触发重建、且索引为空时要如实说明；
//   ③ `recall_memory` 的 `session` 参数**缺省必须等价于之前**（取自身），跨会话要能按
//      完整 id / 前缀 / 标题三种写法命中，命中多个要返回候选而不是猜。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerMemoryRecallTool, resolveSessionTarget } from '../../lib/features/memory-recall/index.js';

/** 造一个假的 sessions 根：<root>/<分组>/<会话id>/session.v4.jsonl.zstd（空文件即可，解析只用目录名）。 */
function makeSessionsRoot(ids, { groups = ['--g--'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sid-'));
  for (const [i, id] of ids.entries()) {
    const dir = join(root, groups[i % groups.length], id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), '');
  }
  return root;
}

// ---------- ① 跨会话解析 ----------

test('resolveSessionTarget：完整 id 直接命中', async () => {
  const root = makeSessionsRoot(['session-aaaa1111-0000', 'session-bbbb2222-0000']);
  process.env.DSH_HOME = join(root, '..'); // 造一个假的 DSH_HOME（root 位于其 sessions/ 下）
  // 直接把 root 当作 sessions 根用：把假 DSH_HOME 指到 root 的父级
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const id = 'session-aaaa1111-0000';
  // 判据是「目录里有会话日志文件」，不是「目录名以 session- 开头」⇒ 必须真写一个日志文件
  const dir = join(home, 'sessions', '--g--', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), '');
  process.env.DSH_HOME = home;
  const hit = await resolveSessionTarget({}, id, 'session-self');
  assert.equal(hit?.id, id);
});

test('resolveSessionTarget：id 前缀唯一时命中，多个候选时返回候选清单（不猜）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const mk = (id) => {
    const dir = join(home, 'sessions', '--g--', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), '');
  };
  mk('session-aaaa1111-0000');
  mk('session-aaaa2222-0000');
  process.env.DSH_HOME = home;
  const one = await resolveSessionTarget({}, 'session-aaaa1', 'session-self');
  assert.equal(one?.id, 'session-aaaa1111-0000', '前缀唯一应直接命中');
  const many = await resolveSessionTarget({}, 'session-aaaa', 'session-self');
  assert.ok(Array.isArray(many?.candidates) && many.candidates.length === 2, '前缀不唯一应返回候选清单');
});

test('resolveSessionTarget：裸 UUID 目录（子代理/成员会话）也要能解析', async () => {
  // 回归钉死：旧实现用 dir.startsWith("session-") 判断会话目录，而成员会话目录名是裸 UUID，
  // 于是完整 id 与前缀都解析不出来（工具报「找不到目标会话」）。判据必须是「有日志文件」。
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const bare = 'c9a6a72c-908e-4040-b88c-2e6ce5014378';
  const dir = join(home, 'sessions', '--g--', bare);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), '');
  process.env.DSH_HOME = home;

  const full = await resolveSessionTarget({}, bare, 'session-self');
  assert.equal(full?.id, bare, '完整裸 UUID 应直接命中');

  const prefix = await resolveSessionTarget({}, 'c9a6a72c', 'session-self');
  assert.equal(prefix?.id, bare, '裸 UUID 前缀也应命中');
});

test('resolveSessionTarget：找不到就返回 null（调用方据此如实报错）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  process.env.DSH_HOME = home;
  assert.equal(await resolveSessionTarget({}, 'session-nothing-here', 'session-self'), null);
});

// ---------- ② recall_memory 的 session 参数 ----------

/** 注册工具并取出它的 spec（用假 defineTool/tools）。 */
function takeRecallTool(deps) {
  const registered = [];
  const ok = registerMemoryRecallTool({}, (spec) => spec, { register: (s) => registered.push(s) }, deps);
  return { ok, spec: registered[0] };
}

test('recall_memory：不传 session ⇒ 取自身（与之前行为一致），输出不含来源标注', async () => {
  const seen = [];
  const { ok, spec } = takeRecallTool({
    cfg: { retrieveMemoryRounds: 3, retrieveMemoryMaxChars: 4000, retrieveMemoryMaxCharsPerItem: 800 },
    readTurns: async (_ctx, id) => { seen.push(id); return [{ time: 1, userText: '甲', agentText: 'A' }]; },
    format: (turns, opts) => `轮数=${turns.length};manual=${opts.manual};note=${opts.sourceNote ?? '无'}`,
  });
  assert.equal(ok, true);
  const out = await spec.execute({ rounds: 2 }, { agent: { session: { id: 'session-self' } } });
  assert.deepEqual(seen, ['session-self'], '缺省必须读自身');
  assert.match(String(out), /note=无/, '自身路径不得带来源标注');
});

test('recall_memory：传 session ⇒ 读目标会话并带上「仅作背景」的来源标注', async () => {
  const seen = [];
  const { spec } = takeRecallTool({
    cfg: { retrieveMemoryRounds: 3, retrieveMemoryMaxChars: 4000, retrieveMemoryMaxCharsPerItem: 800 },
    readTurns: async (_ctx, id) => { seen.push(id); return [{ time: 1, userText: '乙', agentText: 'B' }]; },
    format: (turns, opts) => `note=${opts.sourceNote ?? '无'}`,
    resolveSession: async () => ({ id: 'session-other-1' }),
  });
  const out = await spec.execute({ session: 'other' }, { agent: { session: { id: 'session-self' } } });
  assert.deepEqual(seen, ['session-other-1']);
  assert.match(String(out), /来自另一个会话 session-other-1/);
});

test('recall_memory：目标歧义返回候选清单；找不到如实报错；都不读日志', async () => {
  let readCalls = 0;
  const deps = {
    cfg: { retrieveMemoryRounds: 3 },
    readTurns: async () => { readCalls += 1; return []; },
    format: () => '不应走到这里',
    resolveSession: async (_ctx, want) => (want === 'dup'
      ? { candidates: [{ id: 'session-a' }, { id: 'session-b', title: 'T' }] }
      : null),
  };
  const { spec } = takeRecallTool(deps);
  const ambiguous = await spec.execute({ session: 'dup' }, { agent: { session: { id: 'session-self' } } });
  assert.match(String(ambiguous), /session-a[\s\S]*session-b/);
  const missing = await spec.execute({ session: 'nope' }, { agent: { session: { id: 'session-self' } } });
  assert.match(String(missing), /找不到目标会话/);
  assert.equal(readCalls, 0, '歧义/找不到都不应去读日志');
});
