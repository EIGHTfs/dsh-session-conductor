// clone_member_as 的内容搬运自测（transplantSessionLog）。
//
// 背景：宿主的 Team 成员名是不可变身份字段（`team/member` 投影里 name 一变就抛
// `changed immutable identity fields`，且只允许 provisioning → active 一次写入），
// 也没有 rename 接口。所以「给成员换名」只能：新建一个成员，再把旧成员的会话内容搬过去。
//
// 【核心判据：搬运必须等于复制】会话事件之间有大量跨事件引用（顶层 sourceEventSeqs、
// surfaceOp 端点、data.messageSeqs、data.shadowedSeqs、data.headerSeq，以及 compaction 的
// start→summary→end 配对）。任何 seq 重排或事件增删都会打断这些关系，宿主加载时报
// `stored log is corrupt`（真实事故连续撞过三种校验）。因此本测试的主判据是：
//   **搬出来的事件必须与源逐一完全相同（除 descriptor 的人类可读字段），seq 也完全相同。**
// 只要这条成立，且源本来能被宿主加载，目标就一定能加载。
//
// 另两条硬约束也一并钉死：每帧带 checksum（否则「总和检查码不匹配」）、header 用目标身份。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSessionText } from '../../lib/repair.js';
import { scanZstdFrames, decodeAllFrames } from '../../lib/zstd-frames.js';
import { transplantSessionLog } from '../../lib/features/member-model/clone-member.js';

/**
 * 造一个会话日志文件。
 *
 * @param {string} file 目标路径
 * @param {object} header 会话 header
 * @param {Array<object>} events 事件（自动补 seq/time）
 * @returns {Promise<void>}
 */
async function writeSession(file, header, events) {
  const lines = [JSON.stringify(header)];
  events.forEach((e, i) => lines.push(JSON.stringify({ seq: i, time: 1000 + i, ...e })));
  writeFileSync(file, await encodeSessionText(lines.join('\n') + '\n'));
}

/** 用临时目录，并在结束时清理。 */
function withTmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-clone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 读一个会话文件的【事件】数组（不含 header）。 */
async function readEvents(file) {
  const text = await decodeAllFrames(readFileSync(file));
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return { header: JSON.parse(lines[0]), events: lines.slice(1).map((l) => JSON.parse(l)) };
}

test('搬运 = 原样复制：事件一条不丢、seq 不变、只换 header', async (t) => {
  const dir = withTmp(t);
  const sourceFile = join(dir, 'source.zstd');
  const targetFile = join(dir, 'target.zstd');

  // 源：覆盖各类带跨事件引用的事件形态（这些正是重排会打断的地方）
  await writeSession(sourceFile, { type: 'session', version: 4, id: 'source-id', cwd: '/src', createdAt: 1 }, [
    { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: '源成员' } },
    { role: 'user', type: 'user/message', data: { content: [{ type: 'text', text: '历史问题一' }] }, surfaceOp: 'append' },
    { role: 'assistant', type: 'assistant/message', data: { content: [{ type: 'text', text: '历史回答一' }] }, surfaceOp: 'append' },
    { role: 'assistant', type: 'tool/call', data: { callId: 'c1', name: 'x', arguments: {} }, surfaceOp: 'append' },
    { role: 'tool', type: 'tool/result', toolCallId: 'c1', data: { ok: true }, sourceEventSeqs: [3], surfaceOp: 'append' },
    { type: 'request/header', data: { header: { config: { provider: 'sa6400', model: 'm1' } } }, surfaceOp: 'append' },
    { type: 'developer/message', data: { content: [], headerSeq: 5 }, surfaceOp: 'append' },
    { type: 'session/title', data: { title: '源标题', messageSeqs: [1] }, surfaceOp: 'append' },
    { type: 'compaction/start', data: {}, surfaceOp: 'append' },
    { type: 'compaction/summary', data: { shadowedSeqs: [1, 2] }, surfaceOp: 'append' },
    { type: 'compaction/end', data: {}, surfaceOp: 'append' },
  ]);
  await writeSession(targetFile, { type: 'session', version: 4, id: 'target-id', cwd: '/dst', createdAt: 9, parentSession: 'lead-id' }, [
    { role: 'user', type: 'user/message', data: { content: [{ type: 'text', text: '占位任务' }] } },
  ]);

  const sourceBefore = readFileSync(sourceFile);
  const { events: sourceEvents } = await readEvents(sourceFile);

  const result = await transplantSessionLog(sourceFile, targetFile, { seedProvider: 'sa6400', seedModel: 'deepseek-v4.1-flash' });
  assert.equal(result.ok, true, JSON.stringify(result));

  const buf = readFileSync(targetFile);
  const { frames } = scanZstdFrames(buf);
  const ck = frames.map((f) => (buf.readUInt8(f.start + 4) & 0x04) !== 0);
  assert.ok(ck.every((b) => b), '每帧必须带 checksum，否则宿主判「总和检查码不匹配」');

  const { header, events } = await readEvents(targetFile);
  assert.equal(header.id, 'target-id', 'header 必须用目标身份（否则新成员变成旧成员）');
  assert.equal(header.cwd, '/dst');
  assert.equal(header.parentSession, 'lead-id');

  // 【主判据】事件数一致 + seq 逐一相同 + 除 descriptor 的 label/模型外逐字段相等
  assert.equal(events.length, sourceEvents.length, '事件必须一条不丢（丢一条就断引用/断 compaction 配对）');
  for (let i = 0; i < sourceEvents.length; i += 1) {
    const want = sourceEvents[i];
    const got = events[i];
    assert.equal(got.seq, want.seq, `第 ${i + 1} 条事件 seq 必须与源相同`);
    assert.equal(got.type, want.type, `第 ${i + 1} 条事件类型必须与源相同`);
    if (want.type === 'subagent/descriptor') {
      // descriptor 允许改人类可读字段，其余（version/mode/provider）必须一致
      assert.equal(got.data.version, want.data.version);
      assert.equal(got.data.mode, want.data.mode);
      assert.equal(got.data.provider, want.data.provider);
      assert.equal(got.data.agentProvider, 'sa6400');
      assert.equal(got.data.agentModel, 'deepseek-v4.1-flash');
      continue;
    }
    assert.deepEqual(got, want, `第 ${i + 1} 条事件（${want.type}）必须与源完全一致`);
  }

  // 关键引用结构原样保留（这正是「不重排」的意义）
  const title = events.find((e) => e.type === 'session/title');
  assert.deepEqual(title.data.messageSeqs, [1], 'messageSeqs 必须原样保留');
  const dev = events.find((e) => e.type === 'developer/message');
  assert.equal(dev.data.headerSeq, 5, 'headerSeq 必须原样保留');
  const toolRes = events.find((e) => e.type === 'tool/result');
  assert.deepEqual(toolRes.sourceEventSeqs, [3], 'sourceEventSeqs 必须原样保留');
  assert.equal(events.filter((e) => e.type.startsWith('compaction/')).length, 3, 'compaction 组必须完整保留（否则 end 缺 summary 报错）');

  // 目标原有内容被整份替换、源文件不动、备份存在
  assert.ok(!JSON.stringify(events).includes('占位任务'), '目标原有内容应被整份替换');
  assert.deepEqual(readFileSync(sourceFile), sourceBefore, '源会话不能被改动');
  assert.ok(existsSync(result.backup), '必须生成回滚备份');
  assert.ok(readdirSync(dir).some((f) => f.includes('before-clone')), '备份文件名应可辨识');
});

test('搬内容：源只有 header（无事件）时明确报错且不写目标', async (t) => {
  const dir = withTmp(t);
  const sourceFile = join(dir, 'empty-source.zstd');
  const targetFile = join(dir, 'target2.zstd');
  await writeSession(sourceFile, { type: 'session', version: 4, id: 'src2', cwd: '/s', createdAt: 1 }, []);
  await writeSession(targetFile, { type: 'session', version: 4, id: 'tgt2', cwd: '/t', createdAt: 1 }, [
    { role: 'user', type: 'user/message', data: { content: [] } },
  ]);
  const before = readFileSync(targetFile);
  const result = await transplantSessionLog(sourceFile, targetFile, {});
  assert.equal(result.ok, false);
  assert.match(String(result.error), /没有可搬运的事件/);
  assert.deepEqual(readFileSync(targetFile), before, '失败时目标文件必须保持原样');
});

test('搬内容：目标文件不可读时如实报错', async (t) => {
  const dir = withTmp(t);
  const sourceFile = join(dir, 'src3.zstd');
  await writeSession(sourceFile, { type: 'session', version: 4, id: 'src3', cwd: '/s', createdAt: 1 }, [
    { role: 'user', type: 'user/message', data: { content: [] } },
  ]);
  const result = await transplantSessionLog(sourceFile, join(dir, 'not-exist.zstd'), {});
  assert.equal(result.ok, false);
  assert.match(String(result.error), /读取目标会话 header 失败/);
});

test('搬内容：跨事件引用原样保留（不重排就不会破坏引用）', async (t) => {
  // 这条是真实事故的回归：早先的实现会重排 seq 并丢弃 compaction 事件，
  // 导致宿主连续报三种 corrupt（sourceEventSeqs 非更早 / messageSeqs 非更早-user /
  // compaction/end 缺 summary）。判据改成「原样复制」后这些引用天然成立。
  const dir = withTmp(t);
  const sourceFile = join(dir, 'refs-src.zstd');
  const targetFile = join(dir, 'refs-tgt.zstd');
  await writeSession(sourceFile, { type: 'session', version: 4, id: 'refs-src', cwd: '/s', createdAt: 1 }, [
    { role: 'user', type: 'user/message', data: { content: [] }, surfaceOp: 'append' },
    { role: 'user', type: 'user/message', data: { content: [] }, surfaceOp: 'append' },
    { type: 'session/title', data: { title: 'x', messageSeqs: [0, 1] }, surfaceOp: 'append' },
    { role: 'tool', type: 'tool/result', data: {}, sourceEventSeqs: [0], surfaceOp: 'append' },
    { role: 'user', type: 'user/message', data: { content: [] }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } },
  ]);
  await writeSession(targetFile, { type: 'session', version: 4, id: 'refs-tgt', cwd: '/t', createdAt: 9 }, [
    { role: 'user', type: 'user/message', data: { content: [] } },
  ]);

  const result = await transplantSessionLog(sourceFile, targetFile, {});
  assert.equal(result.ok, true, `不应因引用失败：${result.error}`);

  const { events } = await readEvents(targetFile);
  const typeAt = new Map(events.map((e) => [e.seq, e.type]));
  for (const e of events) {
    if (e.sourceEventSeqs !== undefined) {
      const seen = new Set();
      for (const s of e.sourceEventSeqs) {
        assert.ok(s < e.seq, `sourceEventSeqs 引用 ${s} 必须更早`);
        assert.ok(!seen.has(s), 'sourceEventSeqs 不得重复');
        seen.add(s);
      }
    }
    if (Array.isArray(e.data?.messageSeqs)) {
      const seen = new Set();
      for (const s of e.data.messageSeqs) {
        assert.ok(s < e.seq, `messageSeqs 引用 ${s} 必须更早`);
        assert.equal(typeAt.get(s), 'user/message', 'messageSeqs 必须指向 user/message');
        assert.ok(!seen.has(s), 'messageSeqs 不得重复');
        seen.add(s);
      }
    }
    if (e.surfaceOp !== undefined && e.surfaceOp !== 'append') {
      assert.ok(e.surfaceOp.startSeq < e.seq, 'surfaceOp.startSeq 必须更早');
      assert.ok(e.surfaceOp.endSeq < e.seq, 'surfaceOp.endSeq 必须更早');
    }
  }
  // replace 语义也要原样保留（不是降级成 append）
  const replaced = events.find((e) => e.surfaceOp !== undefined && e.surfaceOp !== 'append');
  assert.deepEqual(replaced.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 1 });
});
