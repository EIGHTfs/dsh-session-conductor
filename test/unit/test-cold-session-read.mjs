// 冷会话读取回归 —— 按 zstd 帧**流式**读（常量内存）的正确性 + 回退路径。
//
// 【背景】宿主的 `handle.read()` 无法流式读：`readCurrent` 每次都会 `readStoredLog(path)`
// 把整份日志解压成事件数组（`offset/length` 只是内存数组切片）。本机实测最大会话
// 49.2 MB 压缩 → **173.3 MB 解压**（3.2~5.0×），列表遍历上百个冷会话 ⇒ 进程 OOM
// （线上 RSS 2.33 GB、`/list` >120s）。
// 因此列表改走「按 zstd 帧流式读」：直接读日志文件 → 逐帧流式解压（`streamDecodedFrames`）
// → 逐行增量解析 → 只累加 title/updatedAt/openTurn 并保留有界尾部。
//
// 覆盖方式：用 `zstdCompress` 造**真实多帧**夹具（不 mock 解压），端到端验证派生字段
// 与「全量解码 + lastEventTime/hasOpenTurn/interruptionInfo」等价。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';

import { streamDecodedFrames, decodeAllFrames, scanZstdFrames } from '../../lib/zstd-frames.js';
import { readColdSessionSummary, findSessionLogById } from '../../lib/sessions/events.js';
import { lastEventTime, hasOpenTurn } from '../../lib/sessions/turn.js';
import { interruptionInfo } from '../../lib/sessions/interruption.js';

const zstdCompressAsync = promisify(zstdCompress);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIST_SRC = readFileSync(join(ROOT, 'lib', 'sessions', 'list.js'), 'utf8');

/** 把若干段文本各自压成一个 zstd 帧 → 拼成多帧缓冲（模拟 DSH 会话日志容器）。 */
async function makeMultiFrame(segments) {
  const frames = [];
  for (const seg of segments) frames.push(await zstdCompressAsync(Buffer.from(seg, 'utf8')));
  return Buffer.concat(frames);
}

/** 造一份会话日志文本：header 行 + 事件行（可指定是否停在开放回合）。 */
function makeLogLines({ count = 40, title = '标题', openTurn = false } = {}) {
  const lines = [JSON.stringify({ type: 'session', version: 4, id: 'sess-1', cwd: '/w/x', createdAt: 1000 })];
  lines.push(JSON.stringify({ seq: 0, type: 'turn/start', time: 1000 }));
  for (let i = 1; i <= count; i++) {
    lines.push(JSON.stringify({ seq: i, type: 'step/start', time: 1000 + i }));
    if (i === 5) lines.push(JSON.stringify({ seq: 100, type: 'session/title', data: { title }, time: 1005 }));
  }
  if (!openTurn) lines.push(JSON.stringify({ seq: count + 1, type: 'turn/end', data: { reason: null }, time: 1000 + count + 1 }));
  return lines.join('\n') + '\n';
}

/** 在临时目录里放一份多帧会话日志，返回 sessions root。 */
async function makeFixtureRoot(logText, { frames = 3, sessionId = 'sess-1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-logframes-'));
  const dir = join(root, '--group--', sessionId);
  mkdirSync(dir, { recursive: true });
  const per = Math.max(1, Math.ceil(logText.length / frames));
  const segments = [];
  for (let i = 0; i < logText.length; i += per) segments.push(logText.slice(i, i + per));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), await makeMultiFrame(segments));
  return { root, dir };
}

// ---------- ① streamDecodedFrames：流式消费与全量解码等价 ----------

test('streamDecodedFrames：逐帧流式分片拼起来 == 原始文本（多帧不丢）', async () => {
  const text = makeLogLines({ count: 200 });
  const buf = await makeMultiFrame([text.slice(0, 1000), text.slice(1000, 3000), text.slice(3000)]);
  const { frames } = scanZstdFrames(buf);
  assert.equal(frames.length, 3, `夹具应为 3 帧，实际 ${frames.length}`);

  const chunks = [];
  const stats = await streamDecodedFrames(buf, (c) => chunks.push(c));
  assert.equal(stats.frames, 3);
  assert.equal(Buffer.concat(chunks).toString('utf8'), text, '流式消费结果必须与原文完全一致');
});

test('streamDecodedFrames：onChunk 抛错会向上传播（不静默吞掉）', async () => {
  const buf = await makeMultiFrame(['{"a":1}\n', '{"b":2}\n']);
  await assert.rejects(
    () => streamDecodedFrames(buf, () => { throw new Error('消费者炸了'); }),
    /消费者炸了/,
  );
});

test('streamDecodedFrames：空缓冲不炸（0 帧）', async () => {
  const stats = await streamDecodedFrames(Buffer.alloc(0), () => {});
  assert.equal(stats.frames, 0);
});

// ---------- ② readColdSessionSummary：派生字段与「全量解码」等价 ----------

test('按帧摘要读：title/updatedAt/openTurn/事件数 与全量解码朴素计算一致', async () => {
  const logText = makeLogLines({ count: 120, title: '真实标题' });
  const { root } = await makeFixtureRoot(logText, { frames: 4 });

  const summary = await readColdSessionSummary({}, 'sess-1', { root });
  assert.ok(summary, '应能定位并读取夹具日志');
  assert.equal(summary.frames, 4, '应逐帧读满 4 帧');

  // 朴素全量：整份解码后逐行算（等价性标尺）
  const buf = readFileSync(join(root, '--group--', 'sess-1', 'session.v4.jsonl.zstd'));
  const events = (await decodeAllFrames(buf)).split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.type !== 'session');

  assert.equal(summary.derived.title, '真实标题');
  assert.equal(summary.derived.updatedAt, lastEventTime(events), 'updatedAt 必须等于末条事件时间');
  assert.equal(summary.derived.openTurn, hasOpenTurn(events));
  assert.equal(summary.scanned, events.length, 'scanned 必须等于事件总数');
  assert.equal(summary.meta?.cwd, '/w/x', 'meta 取首行会话 header（含 cwd）');
  assert.deepEqual(interruptionInfo(summary.events), interruptionInfo(events), 'interruption 语义一致');
});

test('按帧摘要读：尾部有界（tailKeep 之外不驻留）', async () => {
  const { root } = await makeFixtureRoot(makeLogLines({ count: 300 }), { frames: 2 });
  const summary = await readColdSessionSummary({}, 'sess-1', { root, tailKeep: 50 });
  assert.ok(summary.events.length <= 50, `尾部应被截到 50 条以内，实际 ${summary.events.length}`);
  assert.ok(summary.scanned > 250, '仍然要扫完全部事件（保证 title/updatedAt 语义不变）');
});

test('按帧摘要读：日志停在开放回合 → openTurn 为 true', async () => {
  const { root } = await makeFixtureRoot(makeLogLines({ count: 20, openTurn: true }));
  const summary = await readColdSessionSummary({}, 'sess-1', { root });
  assert.equal(summary.derived.openTurn, true);
});

test('按帧摘要读：文件不存在 → 返回 null（调用方回退 handle 读法）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-logframes-empty-'));
  assert.equal(await readColdSessionSummary({}, 'sess-not-here', { root }), null);
});

test('findSessionLogById：能按 id 在工作区分组下定位，找不到/空 id 返回 null', async () => {
  const { root } = await makeFixtureRoot(makeLogLines({ count: 3 }));
  assert.ok(findSessionLogById('sess-1', root)?.endsWith('session.v4.jsonl.zstd'));
  assert.equal(findSessionLogById('sess-missing', root), null);
  assert.equal(findSessionLogById('', root), null);
});

test('按帧摘要读：损坏行被跳过，不影响其余统计', async () => {
  const lines = makeLogLines({ count: 10 }).split('\n').filter(Boolean);
  lines.splice(3, 0, '{ 这不是 JSON');
  const { root } = await makeFixtureRoot(lines.join('\n') + '\n', { frames: 2 });
  const summary = await readColdSessionSummary({}, 'sess-1', { root });
  assert.ok(summary.scanned >= 10, `损坏行应被跳过、其余照常统计，实际 ${summary.scanned}`);
});

// ---------- ③ 护栏：列表优先按帧读，且保留回退 ----------

test('护栏：list.js 必须优先按帧摘要读，并保留 handle 全量读作为回退', () => {
  assert.match(LIST_SRC, /await readColdSessionSummary\(ctx, entry\.meta\.id\)/, '列表必须优先走按帧摘要读');
  assert.match(LIST_SRC, /await readColdSessionEvents\(ctx, entry\.meta\.id\)/, '必须保留 handle 读法作为回退');
  assert.match(LIST_SRC, /if \(summary\) \{/, '必须先判断摘要读是否命中');
});
