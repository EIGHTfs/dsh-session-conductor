// 委派策略快照提示自测：切换模型时应能识别「带 approval/policy 委派快照」的会话并给出排查提示。
//
// 背景（本机实测事故）：子代理会话开头有 `approval/policy {policy:"never", source:"delegation"}`，
// 它是创建时从父级快照的自动审查设置。部署侧关掉「自动审查」后，宿主恢复该快照失败，
// 异常被 manager.coldResume 统一包成 `subagent/not-resumable` —— 界面只看到
// 「subagent cannot be resumed」，会把人误导去查模型/描述符/文件（本次全查过，全部无效）。
//
// 本测试钉死：带委派快照的会话要能被识别；普通会话不能误报。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSessionText } from '../../lib/repair.js';
import { delegationPolicyHint } from '../../lib/features/member-model/switch.js';

/** 造一个子代理会话日志：header + 策略快照 + descriptor + 若干事件。 */
async function makeLog(dir, { withDelegation }) {
  const header = { type: 'session', version: 4, id: 'session-child-1', createdAt: 1, cwd: '/tmp/demo', origin: 'subagent', parentSession: 'session-parent-1' };
  const lines = [JSON.stringify(header)];
  let seq = 0;
  if (withDelegation) {
    lines.push(JSON.stringify({ type: 'sandbox/mode', seq: seq++, time: 1, data: { mode: 'danger-full-access', source: 'delegation' } }));
    lines.push(JSON.stringify({ type: 'approval/policy', seq: seq++, time: 1, data: { policy: 'never', source: 'delegation' } }));
    lines.push(JSON.stringify({ type: 'permission/preset', seq: seq++, time: 1, data: { preset: 'auto' } }));
  } else {
    lines.push(JSON.stringify({ type: 'approval/policy', seq: seq++, time: 1, data: { policy: 'never', source: 'manual' } }));
  }
  lines.push(JSON.stringify({ type: 'subagent/descriptor', seq: seq++, time: 1, data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'x', agentProvider: 'sa6400', agentModel: 'deepseek-v4.1-flash' } }));
  for (let i = 0; i < 3; i += 1) {
    lines.push(JSON.stringify({ type: 'step/end', seq: seq++, time: 100 + i, data: { turn: 1, step: i + 1 } }));
  }
  const file = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(file, await encodeSessionText(lines.join('\n') + '\n'));
  return file;
}

test('带委派策略快照的会话：返回排查提示', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hint-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = await makeLog(home, { withDelegation: true });
  const hint = await delegationPolicyHint(file);
  assert.ok(hint.length > 0, '应返回提示');
  assert.match(hint, /自动审查/);
  assert.match(hint, /not-resumable/);
});

test('普通会话（policy 非 delegation 来源）：不误报', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hint-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = await makeLog(home, { withDelegation: false });
  const hint = await delegationPolicyHint(file);
  assert.equal(hint, '', '不应返回提示');
});

test('文件不存在/不可读：返回空串，不抛错', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hint-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hint = await delegationPolicyHint(join(home, 'no-such-file.zstd'));
  assert.equal(hint, '');
});
