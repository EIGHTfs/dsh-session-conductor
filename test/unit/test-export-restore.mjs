// 导出包恢复自测：明文 jsonl → DSH 官方多帧 zstd（带校验和），并安全覆盖会话。
//
// 背景（本机实测事故）：
//   ① 导出包是明文 session.v4.jsonl，而运行时读的是 session.v4.jsonl.zstd；
//   ② 曾用不带 ZSTD_c_checksumFlag 的压缩器重写，宿主报「会话文件 总和检查码不匹配」；
//   ③ 覆盖 seeded 会话时若打乱 inherited 标记，宿主断言 seeded session requires an inherited event count。
// 本测试把这三条钉死：编码后每帧必须带校验和、首帧必须恰好一行 header、inherited 标记位置要被回显。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encodePlainToZstd, scanExportDir, restoreSessionsFromExport, restoreExportMedia } from '../../lib/sessions/export-restore.js';
import { scanZstdFrames, validateHeaderFrame, decodeAllFrames } from '../../lib/zstd-frames.js';

/** 造明文 jsonl（header + events），可指定 inherited 标记位置。 */
function makePlain({ id, eventCount = 12, inheritedAt = null, gapAt = null }) {
  const header = { type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/demo', isSeeded: inheritedAt !== null };
  const lines = [JSON.stringify(header)];
  for (let i = 0; i < eventCount; i += 1) {
    const seq = gapAt !== null && i >= gapAt ? i + 3 : i; // 制造 seq 缺口
    const type = i === inheritedAt ? 'session/end-seed' : 'step/end';
    const data = i === inheritedAt ? { inherited: true } : { turn: 1, step: i + 1 };
    lines.push(JSON.stringify({ type, seq, time: 100 + i, data }));
  }
  return lines.join('\n') + '\n';
}

test('encodePlainToZstd：每帧带校验和、首帧恰好一行 header、事件数一致', async () => {
  const plain = makePlain({ id: 'session-a', eventCount: 2500 }); // 跨多帧（每帧 1000）
  const r = encodePlainToZstd(plain, { eventsPerFrame: 1000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.eventCount, 2500);
  assert.ok(r.frames >= 3, `应分多帧，实际 ${r.frames}`);

  const { frames } = scanZstdFrames(r.buffer);
  assert.equal(frames.length, r.frames);
  const ck = frames.map((fr) => (r.buffer.readUInt8(fr.start + 4) & 0x04) !== 0);
  assert.ok(ck.every(Boolean), '每一帧都必须带校验和（否则宿主判总和检查码不匹配）');

  const v = await validateHeaderFrame(r.buffer);
  assert.equal(v.ok, true, JSON.stringify(v));
  const back = (await decodeAllFrames(r.buffer)).split('\n').filter((l) => l.trim() !== '');
  assert.equal(back.length - 1, 2500);
});

test('encodePlainToZstd：回显 inherited 标记位置（seeded 会话续跑依赖它）', () => {
  const plain = makePlain({ id: 'session-b', eventCount: 20, inheritedAt: 8 });
  const r = encodePlainToZstd(plain);
  assert.equal(r.ok, true);
  assert.equal(r.inheritedAt, 8);
  assert.equal(r.header.isSeeded, true);
});

test('encodePlainToZstd：seq 不连续明文必须被拒绝（不能写出 corrupt 日志）', () => {
  const plain = makePlain({ id: 'session-c', eventCount: 10, gapAt: 5 });
  const r = encodePlainToZstd(plain);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /seq 不连续/);
});

test('encodePlainToZstd：首行不是 session header 时拒绝', () => {
  const r = encodePlainToZstd('{"type":"nope"}\n{"seq":0}\n');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /session header/);
});

test('scanExportDir + restoreSessionsFromExport：dryRun 不写盘，执行后产物合规', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-restore-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // 造 DSH_HOME 骨架：sessions/<项目目录>/<父会话 id>/session.v4.jsonl.zstd（已存在，用于定位项目目录）
  const proj = join(home, 'sessions', '--tmp-demo--');
  const parentId = 'session-parent-1';
  const parentDir = join(proj, parentId);
  mkdirSync(parentDir, { recursive: true });
  const seedPlain = makePlain({ id: parentId, eventCount: 5 });
  const seedEnc = encodePlainToZstd(seedPlain);
  writeFileSync(join(parentDir, 'session.v4.jsonl.zstd'), seedEnc.buffer);

  // 造导出包：根 session.v4.jsonl + subagents/<childId>/session.v4.jsonl（子代理目录尚不存在 → create）
  const exportDir = join(home, 'export');
  mkdirSync(join(exportDir, 'subagents', 'child-1'), { recursive: true });
  writeFileSync(join(exportDir, 'session.v4.jsonl'), makePlain({ id: parentId, eventCount: 30, inheritedAt: 10 }));
  writeFileSync(join(exportDir, 'subagents', 'child-1', 'session.v4.jsonl'), makePlain({ id: 'child-1', eventCount: 7 }));

  const plan = scanExportDir(exportDir, { home });
  assert.equal(plan.error, undefined);
  assert.equal(plan.entries.length, 2);
  const parentEntry = plan.entries.find((e) => e.role === 'parent');
  const childEntry = plan.entries.find((e) => e.role === 'subagent');
  assert.equal(parentEntry.action, 'overwrite');
  assert.equal(childEntry.action, 'create');

  // dryRun：不写盘
  const before = readFileSync(join(parentDir, 'session.v4.jsonl.zstd'));
  const dry = await restoreSessionsFromExport({ exportDir, home, dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry.errors));
  assert.ok(dry.results.every((x) => x.status === 'would-restore'));
  assert.deepEqual(readFileSync(join(parentDir, 'session.v4.jsonl.zstd')), before, 'dryRun 不得写盘');

  // 真执行
  const real = await restoreSessionsFromExport({ exportDir, home, dryRun: false });
  assert.equal(real.ok, true, JSON.stringify(real.errors));
  assert.ok(real.results.every((x) => x.verified === true), '每项都应通过写后复核');

  // 父会话：事件数变成 30、帧带校验和、inherited 在 10
  const afterParent = readFileSync(join(parentDir, 'session.v4.jsonl.zstd'));
  const pv = await validateHeaderFrame(afterParent);
  assert.equal(pv.ok, true);
  const { frames: pf } = scanZstdFrames(afterParent);
  const pck = pf.map((fr) => (afterParent.readUInt8(fr.start + 4) & 0x04) !== 0);
  assert.ok(pck.every(Boolean), '父会话每帧都要带校验和');
  const pLines = (await decodeAllFrames(afterParent)).split('\n').filter((l) => l.trim() !== '');
  assert.equal(pLines.length - 1, 30);

  // 子代理：目录被创建且日志合规
  const childLog = join(proj, 'child-1', 'session.v4.jsonl.zstd');
  assert.ok(existsSync(childLog), '不存在的子代理目录应被创建');
  const cv = await validateHeaderFrame(readFileSync(childLog));
  assert.equal(cv.ok, true);
  const cLines = (await decodeAllFrames(readFileSync(childLog))).split('\n').filter((l) => l.trim() !== '');
  assert.equal(cLines.length - 1, 7);
});

test('恢复后必须清掉该会话的 projcache（否则界面仍显示旧内容）', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-restore-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const proj = join(home, 'sessions', '--tmp-demo--');
  const parentId = 'session-parent-1';
  const parentDir = join(proj, parentId);
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(join(parentDir, 'session.v4.jsonl.zstd'), encodePlainToZstd(makePlain({ id: parentId, eventCount: 4 })).buffer);

  // 造一份旧投影缓存（模拟「宿主三层状态」里的缓存层）
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${parentId}.json`);
  writeFileSync(cacheFile, JSON.stringify({ version: 7, record: { identity: {}, rows: {} } }));
  assert.ok(existsSync(cacheFile), '前置：缓存文件应存在');

  const exportDir = join(home, 'export');
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, 'session.v4.jsonl'), makePlain({ id: parentId, eventCount: 9 }));

  const r = await restoreSessionsFromExport({ exportDir, home, dryRun: false });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const item = r.results.find((x) => x.id === parentId);
  assert.equal(item.projcacheCleared, true, '应清理 projcache');
  assert.equal(existsSync(cacheFile), false, 'projcache 文件必须被删掉');

  // 没传 ctx 时必须如实标注「未尝试 detach」，不能假装生效
  assert.equal(item.detached, false);
  assert.match(String(item.note ?? ''), /未传 ctx/);
});

test('restoreExportMedia：恢复附件对象并按内容寻址去重 / 拒绝内容不符的文件', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-media-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const exportDir = join(home, 'export');
  const mediaDir = join(exportDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  // 两个内容明确的文件：good 的哈希与文件名一致；bad 的名字是 good 的哈希但内容不同
  const goodBuf = Buffer.from('attachment-bytes-good');
  const goodHash = createHash('sha256').update(goodBuf).digest('hex');
  writeFileSync(join(mediaDir, `sha256:${goodHash}.jpg`), goodBuf);
  writeFileSync(join(mediaDir, `sha256:${goodHash}.jpg.bak`), Buffer.from('x')); // 命名不合规 → 拒绝
  const badBuf = Buffer.from('attachment-bytes-bad');
  const badHash = createHash('sha256').update(Buffer.from('something-else')).digest('hex');
  writeFileSync(join(mediaDir, `sha256:${badHash}.jpg`), badBuf); // 内容与名字不符 → 拒绝

  const objRoot = join(home, 'attachments', 'v1', 'objects');

  // dryRun：只统计不写盘
  const dry = await restoreExportMedia({ exportDir, home, dryRun: true });
  assert.equal(dry.placed, 1, `dryRun 应只统计 1 个合格附件，实际 ${dry.placed}`);
  assert.equal(dry.rejected, 2);
  assert.equal(existsSync(objRoot), false, 'dryRun 不得创建对象库');

  // 真执行
  const real = await restoreExportMedia({ exportDir, home, dryRun: false });
  assert.equal(real.placed, 1);
  assert.equal(real.rejected, 2);
  const target = join(objRoot, goodHash.slice(0, 2), goodHash);
  assert.ok(existsSync(target), '附件必须落到 <objects>/<前两位>/<hash>');
  assert.deepEqual(readFileSync(target), goodBuf, '内容必须逐字节一致');

  // 再跑一次：内容寻址天然幂等，全部计为「已存在」
  const again = await restoreExportMedia({ exportDir, home, dryRun: false });
  assert.equal(again.placed, 0);
  assert.equal(again.existed, 1);
});

test('restoreSessionsFromExport：exportDir 不存在时如实报错', async () => {
  const r = await restoreSessionsFromExport({ exportDir: '/tmp/definitely-not-exists-xyz', dryRun: true });
  assert.equal(r.ok, false);
  assert.match(String(r.errors[0]), /导出目录不存在/);
});
