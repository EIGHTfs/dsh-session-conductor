// 成员权限预设（查看/切换）自测。
//
// 背景（实测事故）：子代理会话在界面上无法手动切权限预设，而 preset 一旦指向当前不可用的值
// （典型：auto 在「自动审查」关闭后悬空），该成员就永久唤不醒 —— 宿主 permission-presets 在
// 会话发布前抛错，再被 subagent 的 coldResume 统一包成 `subagent/not-resumable`，
// 报错文本完全指不到权限层。本模块提供不经界面的修正通道：追加一条 permission/preset 事件。
//
// 本测试钉死四件事：
//   ① 折叠读：多条 preset 事件取最后一条
//   ② 宿主目录校验：不在可选列表里的预设名必须拒绝（写进去会让会话恢复失败）
//   ③ 切换：追加事件生效、帧带 checksum、seq 连续、写后复核一致
//   ④ 已经相同：不重复写入

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSessionText } from '../../lib/repair.js';
import { scanZstdFrames, decodeAllFrames } from '../../lib/zstd-frames.js';
import { readMemberPermission, readPresetCatalog, switchMemberPermission } from '../../lib/features/member-model/permission.js';

const SID = 'session-perm-test';

/** 造一个带权限事件的会话日志，并让它在临时 DSH_HOME 里可被 findSessionLogById 找到。 */
async function makeSession(home, events) {
  const dir = join(home, 'sessions', '--proj--', SID);
  mkdirSync(dir, { recursive: true });
  const header = { type: 'session', version: 4, id: SID, createdAt: 1, cwd: '/tmp/demo' };
  const lines = [JSON.stringify(header)];
  let seq = 0;
  for (const e of events) lines.push(JSON.stringify({ seq: seq++, time: 1000 + seq, ...e }));
  const file = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(file, await encodeSessionText(lines.join('\n') + '\n'));
  return file;
}

/** 最小 ctx：只提供 permissionPresets 服务；log 走可选 logger。 */
function makeCtx(catalog) {
  return {
    get(name) {
      if (name === 'permissionPresets' && catalog !== undefined) {
        return { catalog: async () => catalog };
      }
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

const FULL_ACCESS = { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
const WS_WRITE = { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' };

function withHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-perm-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('折叠读：多条 preset 取最后一条', async (t) => {
  const home = withHome(t);
  await makeSession(home, [
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', data: { policy: 'never' } },
    { type: 'permission/preset', data: { preset: 'auto' } },
    { type: 'permission/preset', data: { preset: 'danger-full-access' } },
  ]);
  const state = await readMemberPermission(SID);
  assert.equal(state.error, undefined);
  assert.equal(state.preset, 'danger-full-access', '应取最后一条');
  assert.equal(state.sandbox, 'danger-full-access');
  assert.equal(state.approval, 'never');
  assert.equal(state.lastSeq, 3);
});

test('readPresetCatalog：服务不可用时如实报错', async () => {
  const result = await readPresetCatalog(makeCtx(undefined));
  assert.ok(result.error, '应返回 error');
  assert.match(result.error, /permissionPresets/);
});

test('readPresetCatalog：解析选项名与 spec', async () => {
  const ctx = makeCtx({ options: [FULL_ACCESS, WS_WRITE], defaultOptions: [FULL_ACCESS], defaultPreset: 'workspace-write' });
  const catalog = await readPresetCatalog(ctx);
  assert.deepEqual(catalog.names, ['danger-full-access', 'workspace-write']);
  assert.equal(catalog.defaultPreset, 'workspace-write');
  assert.deepEqual(catalog.specs.get('danger-full-access'), { sandbox: 'danger-full-access', approval: 'never' });
});

test('切换：不在可选列表里的预设被拒绝（且不写盘）', async (t) => {
  const home = withHome(t);
  const file = await makeSession(home, [
    { type: 'approval/policy', data: { policy: 'never' } },
    { type: 'permission/preset', data: { preset: 'auto' } },
  ]);
  const before = readFileSync(file);
  const ctx = makeCtx({ options: [FULL_ACCESS, WS_WRITE], defaultPreset: 'workspace-write' });
  const result = await switchMemberPermission(ctx, SID, 'not-a-preset');
  assert.ok(result.error);
  assert.match(result.error, /不在当前可选列表/);
  assert.deepEqual(readFileSync(file), before, '被拒绝时文件必须保持原样');
});

test('切换：auto 不在列表时给出针对性提示', async (t) => {
  const home = withHome(t);
  await makeSession(home, [{ type: 'permission/preset', data: { preset: 'danger-full-access' } }]);
  const ctx = makeCtx({ options: [FULL_ACCESS], defaultPreset: 'danger-full-access' });
  const result = await switchMemberPermission(ctx, SID, 'auto');
  assert.ok(result.error);
  assert.match(result.error, /自动审查/, '应点明 auto 依赖自动审查集成');
});

test('切换：追加事件生效、帧带 checksum、seq 连续', async (t) => {
  const home = withHome(t);
  const file = await makeSession(home, [
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', data: { policy: 'never' } },
    { type: 'permission/preset', data: { preset: 'auto' } },
  ]);
  const framesBefore = scanZstdFrames(readFileSync(file)).frames.length;
  const ctx = makeCtx({ options: [FULL_ACCESS, WS_WRITE], defaultPreset: 'danger-full-access' });
  const result = await switchMemberPermission(ctx, SID, 'danger-full-access');
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.from, 'auto');
  assert.equal(result.to, 'danger-full-access');

  const buf = readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  assert.equal(frames.length, framesBefore + 1, '应只追加一个新帧，不动已有帧');
  const ck = frames.map((fr) => (buf.readUInt8(fr.start + 4) & 0x04) !== 0);
  assert.ok(ck.every((b) => b), '每帧都必须带 checksum（否则宿主判「总和检查码不匹配」）');

  const lines = (await decodeAllFrames(buf)).split('\n').filter((l) => l.trim() !== '');
  let prev = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const e = JSON.parse(lines[i]);
    if (typeof e.seq !== 'number') continue;
    assert.equal(e.seq, prev + 1, `seq 必须严格连续（期望 ${prev + 1}）`);
    prev = e.seq;
  }
  const state = await readMemberPermission(SID);
  assert.equal(state.preset, 'danger-full-access', '折叠读应看到新值');
  assert.equal(state.sandbox, 'danger-full-access', '已有 knob 不被改动');
  assert.equal(state.approval, 'never', '已有 knob 不被改动');
});

test('切换：已经相同则不重复写入', async (t) => {
  const home = withHome(t);
  const file = await makeSession(home, [{ type: 'permission/preset', data: { preset: 'danger-full-access' } }]);
  const before = readFileSync(file);
  const ctx = makeCtx({ options: [FULL_ACCESS], defaultPreset: 'danger-full-access' });
  const result = await switchMemberPermission(ctx, SID, 'danger-full-access');
  assert.equal(result.error, undefined);
  assert.match(String(result.note), /已经是该预设/);
  assert.deepEqual(readFileSync(file), before, '不应重复写盘');
});

test('指令入口：找不到成员时返回 error 回执而不是抛异常', async () => {
  const { handlePermSwitchCommand } = await import('../../lib/features/member-model/permission-command.js');
  const ctx = makeCtx({ options: [FULL_ACCESS], defaultPreset: 'danger-full-access' });
  // ctx 没有任何名册/agents 能力 → findTargetAgent 必然找不到，handler 必须把它转成回执
  const result = await handlePermSwitchCommand(ctx, { rawInput: 'no-such-member', agent: null });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /找不到成员/);
});

test('指令入口：空输入走列表形态，缺少名册时给出可读提示', async () => {
  const { handlePermSwitchCommand } = await import('../../lib/features/member-model/permission-command.js');
  const ctx = makeCtx({ options: [FULL_ACCESS], defaultPreset: 'danger-full-access' });
  const result = await handlePermSwitchCommand(ctx, { rawInput: '', agent: null });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /没读到任何成员/);
});
