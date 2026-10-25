// descriptor 路由校验自测：切换模型时必须能发现「descriptor 指向已下线 provider」并修正。
//
// 背景（实测故障）：子代理 cold resume 的 provider/model 取自会话日志里的 subagent/descriptor，
// model/selection 不参与该路径。descriptor 若指向已被删除的 provider（如配置里移除的 wb），
// 宿主 materialize 失败并统一报 subagent/not-resumable —— 成员永久唤不醒，切模型也没用。
//
// 本测试钉死两件事：
//   ① readDescriptorEvent 能从头部帧里读到 descriptor
//   ② 修正后 descriptor 指向目标路由，且整份日志 seq 仍严格连续（不把会话写坏）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAllFrames } from '../../lib/zstd-frames.js';
import { encodeSessionText } from '../../lib/repair.js';
import { readDescriptorEvent } from '../../lib/sessions/tail-io.js';

/** 造一个「带 descriptor 的子代理会话日志」。 */
async function makeChildLog(dir, descriptor) {
  const header = { type: 'session', version: 4, id: 'session-child-1', createdAt: 1, cwd: '/tmp/demo', origin: 'subagent', parentSession: 'session-parent-1' };
  const lines = [JSON.stringify(header)];
  let seq = 0;
  lines.push(JSON.stringify({ type: 'subagent/descriptor', seq: seq++, time: 1, data: descriptor }));
  for (let i = 0; i < 5; i += 1) {
    lines.push(JSON.stringify({ type: 'step/end', seq: seq++, time: 1000 + i, data: { turn: 1, step: i + 1 } }));
  }
  lines.push(JSON.stringify({ type: 'turn/end', seq: seq++, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } }));
  const file = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(file, await encodeSessionText(lines.join('\n') + '\n'));
  return file;
}

test('readDescriptorEvent：能从头部帧读到 descriptor', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desc-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = await makeChildLog(home, {
    version: 3, mode: 'continuable', provider: 'spawn',
    label: 'M0 契约', agentProvider: 'wb', agentModel: 'cn:deepseek-v4-flash',
  });
  const { descriptor, index } = await readDescriptorEvent(readFileSync(file));
  assert.ok(descriptor, '应读到 descriptor');
  assert.equal(descriptor.agentProvider, 'wb');
  assert.equal(descriptor.agentModel, 'cn:deepseek-v4-flash');
  assert.equal(descriptor.mode, 'continuable');
  assert.equal(index, 2, 'index 是含 header 的行序号：header=1，descriptor=2');
});

test('readDescriptorEvent：普通会话（无 descriptor）返回 null，不报错', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desc-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const header = { type: 'session', version: 4, id: 'session-plain', createdAt: 1, cwd: '/tmp/demo' };
  const lines = [JSON.stringify(header), JSON.stringify({ type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: { kind: 'completed' } } })];
  const file = join(home, 'session.v4.jsonl.zstd');
  writeFileSync(file, await encodeSessionText(lines.join('\n') + '\n'));
  const { descriptor, index } = await readDescriptorEvent(readFileSync(file));
  assert.equal(descriptor, null);
  assert.equal(index, null);
});

test('修正 descriptor 后：路由指向目标值，且 seq 仍严格连续', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desc-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = await makeChildLog(home, {
    version: 3, mode: 'continuable', provider: 'spawn',
    label: 'M0 契约', agentProvider: 'wb', agentModel: 'cn:deepseek-v4-flash',
  });

  // 复刻 repairDescriptorIfStale 的改写与校验逻辑（该函数依赖插件 ctx，这里只验数据层）
  const lines = (await decodeAllFrames(readFileSync(file))).split('\n').filter((l) => l.trim() !== '');
  let patched = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const e = JSON.parse(lines[i]);
    if (e.type !== 'subagent/descriptor') continue;
    e.data.agentProvider = 'sa6400';
    e.data.agentModel = 'global:deepseek-v4.1-flash';
    lines[i] = JSON.stringify(e);
    patched += 1;
    break;
  }
  assert.equal(patched, 1);
  writeFileSync(file, await encodeSessionText(lines.join('\n') + '\n'));

  const after = (await decodeAllFrames(readFileSync(file))).split('\n').filter((l) => l.trim() !== '');
  const desc = JSON.parse(after[1]);
  assert.equal(desc.type, 'subagent/descriptor');
  assert.equal(desc.data.agentProvider, 'sa6400');
  assert.equal(desc.data.agentModel, 'global:deepseek-v4.1-flash');
  assert.equal(desc.data.mode, 'continuable', 'mode 不能被改坏');
  assert.equal(desc.data.version, 3, 'version 不能被改坏');

  let prev = -1;
  for (const line of after.slice(1)) {
    const e = JSON.parse(line);
    if (typeof e.seq !== 'number') continue;
    assert.equal(e.seq, prev + 1, `seq 必须严格连续，期望 ${prev + 1} 实际 ${e.seq}`);
    prev = e.seq;
  }
});
