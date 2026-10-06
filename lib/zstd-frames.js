// dsh-session-conductor — 会话日志 zstd 帧格式检测与修复（模块化）
//
// 经验来源：zstd-session-log-repair skill（2026-08-19 事故实证）。
// 核心：DSH 会话日志是【多帧容器】，第一帧必须恰好一行 header；整体单帧压缩 = corrupt。
// 本模块提供：scanZstdFrames（定位帧边界）/ decodeAllFrames（逐帧解码，防流式丢帧）/
// fixZstdFile（多帧正确写回，原子+备份）/ scanAllCorruptFrames（全仓扫描损坏）。
// 与 fix-zstd-frames-v2.mjs 同逻辑，DSH_HOME 参数化，供插件 API 与 CLI 共用。

import fs, { readFileSync, writeFileSync, mkdirSync, statSync, renameSync, copyFileSync, chmodSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { findSessionLog } from './session-log.js';
import { createZstdDecompress, zstdCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';

const zstdCompressAsync = promisify(zstdCompress);
export const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
export const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

/** 扫描 zstd 帧边界。返回 { frames:[{start,end}], tornStart? }（对齐 fix-zstd-frames-v2）。 */
export function scanZstdFrames(buffer) {
  const frames = []; let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('bad magic at ' + offset);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset); offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit');
    const csf = descriptor >>> 6, ss = (descriptor & 32) !== 0, ck = (descriptor & 4) !== 0, df = descriptor & 3;
    const db = df === 3 ? 4 : df;
    const csb = csf === 0 ? (ss ? 1 : 0) : (1 << csf);
    const rhb = (ss ? 0 : 1) + db + csb;
    if (buffer.length - offset < rhb) return { frames, tornStart: start };
    offset += rhb;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const bh = buffer.readUIntLE(offset, 3); offset += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) throw new Error('reserved block type');
      const pb = bt === 1 ? 1 : bs;
      if (buffer.length - offset < pb) return { frames, tornStart: start };
      offset += pb;
      if (last) break;
    }
    if (ck) { if (buffer.length - offset < 4) return { frames, tornStart: start }; offset += 4; }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** 单帧解码。 */
export function decodeFrame(buf) {
  return new Promise((res, rej) => {
    const d = createZstdDecompress(); const c = [];
    d.on('data', x => c.push(x));
    d.on('end', () => res(Buffer.concat(c)));
    d.on('error', rej);
    d.write(buf); d.end();
  });
}

/** 多帧逐帧解码拼接 → 完整 JSONL 文本（⚠️ 禁止整体流式解码，会丢后续帧）。 */
export async function decodeAllFrames(buf) {
  const { frames } = scanZstdFrames(buf);
  const parts = [];
  for (const fr of frames) parts.push(await decodeFrame(buf.subarray(fr.start, fr.end)));
  return Buffer.concat(parts).toString('utf8');
}

/**
 * 校验第一帧是否恰好一行 header（DSH assertZstdHeaderFrame 语义）。
 * @returns {{ok:boolean, error?:string}}
 */
export function validateHeaderFrame(buf) {
  try {
    const { frames } = scanZstdFrames(buf);
    if (frames.length === 0) return { ok: false, error: '无 zstd 帧' };
    const first = buf.subarray(frames[0].start, frames[0].end);
    const plain = createZstdDecompress();
    return new Promise((res) => {
      const c = [];
      plain.on('data', x => c.push(x));
      plain.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        // ⚠️ 用 indexOf("\n") 判断换行位置，别用 indexOf(10)（JS 会把数字转字符串 "10" 找子串，误判）
        const nl = text.indexOf('\n');
        if (text.length === 0 || nl !== text.length - 1) {
          res({ ok: false, error: 'corrupt: 第一帧不是恰好一行 header' });
          return;
        }
        const line = text.slice(0, -1);
        try {
          const h = JSON.parse(line);
          if (h?.type !== 'session' || !h?.id) res({ ok: false, error: '第一行非 session header' });
          else res({ ok: true, header: h });
        } catch (e) {
          res({ ok: false, error: 'header JSON 解析失败: ' + e.message });
        }
      });
      plain.on('error', (e) => res({ ok: false, error: 'header 帧解码失败: ' + e.message }));
      plain.write(first); plain.end();
    });
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 修复单个会话文件：逐帧解码 → 多帧正确写回（header 一帧 + events 一帧，带 checksum）。
 * @param path 会话文件绝对路径
 * @param backupDir 备份目录（默认 <path 同目录>/.zstd-fix-backup）
 * @returns {{ok:boolean, id?:string, eventCount?:number, fixed?:boolean, error?:string}}
 */
export async function fixZstdFile(path, backupDir = join(dirname(path), '.zstd-fix-backup')) {
  // 先校验：本身已合规则跳过（避免无谓重写）
  const check = await validateHeaderFrame(readFileSync(path));
  if (check.ok) return { ok: true, id: check.header.id, eventCount: null, fixed: false, note: '已合规' };
  if (!check.error?.includes('corrupt') && !check.error?.includes('header')) {
    return { ok: false, error: check.error };
  }

  const origBuf = readFileSync(path);
  let text;
  try { text = await decodeAllFrames(origBuf); } catch (e) {
    return { ok: false, error: '帧解码失败: ' + e.message };
  }
  let lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return { ok: false, error: '空文件' };
  let header;
  try { header = JSON.parse(lines[0]); } catch (e) { return { ok: false, error: 'header 非 JSON: ' + e.message }; }
  if (header.type !== 'session' || !header.id) return { ok: false, error: '第一行非 session header' };
  const events = lines.slice(1);
  const headerFrame = await zstdCompressAsync(Buffer.from(lines[0] + '\n', 'utf8'), CHECKSUM_OPTIONS);
  const bodyText = events.length > 0 ? events.join('\n') + '\n' : '\n';
  const bodyFrame = await zstdCompressAsync(Buffer.from(bodyText, 'utf8'), CHECKSUM_OPTIONS);
  const newBuf = Buffer.concat([headerFrame, bodyFrame]);

  mkdirSync(backupDir, { recursive: true });
  const rel = path.replace(/^.*\/sessions\//, '').replace(/\//g, '__');
  const bak = join(backupDir, rel);
  if (!existsSync(bak)) copyFileSync(path, bak);
  const tmp = path + '.fixtmp';
  writeFileSync(tmp, newBuf);
  try { chmodSync(tmp, statSync(path).mode); } catch { /* 尽力 */ }
  renameSync(tmp, path);
  return { ok: true, id: header.id, eventCount: events.length, fixed: true, backup: bak, origSize: origBuf.length, newSize: newBuf.length };
}

/**
 * 扫描会话目录下全部 session.jsonl.zstd，找出帧损坏的文件。
 * @param sessionsRoot 会话根目录（如 <dshHome>/sessions）
 * @returns {Promise<{ok:boolean, corrupt:Array<{path,id?,error}>, healthy:number, total:number, error?:string}>}
 */
export async function scanAllCorruptFrames(sessionsRoot) {
  if (!sessionsRoot || !existsSync(sessionsRoot)) return { ok: true, corrupt: [], healthy: 0, total: 0, error: 'sessions 目录不存在' };
  const corrupt = [];
  let healthy = 0, total = 0;
  for (const proj of readdirSync(sessionsRoot)) {
    const pp = join(sessionsRoot, proj);
    if (!statSync(pp).isDirectory()) continue;
    for (const sess of readdirSync(pp)) {
      const f = findSessionLog(join(pp, sess));
      if (!f) continue;
      total += 1;
      try {
        const r = await validateHeaderFrame(readFileSync(f));
        if (r.ok) { healthy += 1; }
        else { corrupt.push({ path: f, id: sess, error: r.error }); }
      } catch (e) {
        corrupt.push({ path: f, id: sess, error: String(e?.message ?? e) });
      }
    }
  }
  return { ok: true, corrupt, healthy, total };
}
