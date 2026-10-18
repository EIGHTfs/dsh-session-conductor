// dsh-session-conductor — 会话日志 zstd 帧格式检测与修复（模块化）
//
// 经验来源：zstd-session-log-repair skill（事故实证）。
// 核心：DSH 会话日志是【多帧容器】，第一帧必须恰好一行 header；整体单帧压缩 = corrupt。
// 本模块提供：scanZstdFrames（定位帧边界）/ decodeAllFrames（逐帧解码，防流式丢帧）/
// fixZstdFile（多帧正确写回，原子+备份）/ scanAllCorruptFrames（全仓扫描损坏）。
// 与 fix-zstd-frames-v2.mjs 同逻辑，DSH_HOME 参数化，供插件 API 与 CLI 共用。

import fs, { readFileSync, mkdirSync, statSync, readdirSync, existsSync } from 'node:fs';
import { replaceFileSync, ensureBackupSync } from "./shared/atomic-file.js";
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
    const decompressor = createZstdDecompress(); const chunks = [];
    decompressor.on('data', x => chunks.push(x));
    decompressor.on('end', () => res(Buffer.concat(chunks)));
    decompressor.on('error', rej);
    decompressor.write(buf); decompressor.end();
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
 * 多帧**流式**解码：逐帧解压，把每帧的解压分片**直接交给 onChunk**，不拼接、不驻留。
 *
 * 【为什么需要它】`decodeAllFrames` 会把所有帧的解压结果 `Buffer.concat` 成一个大字符串 ——
 * 本机实测最大会话日志解压后 173 MB，逐帧拼接时内存峰值就是「整份文本 + 所有分片」；
 * 若再 `JSON.parse` 成事件对象数组，峰值会到数百 MB（列表构建反复调用 ⇒ 进程 OOM）。
 * 本函数把「解压」与「消费」解耦：调用方按分片增量处理（例如逐行 JSON.parse 后只留需要的字段），
 * 内存峰值 = 单个分片 + 调用方自己的增量状态，与日志总大小无关。
 *
 * ⚠️ 仍必须**逐帧**喂给解压器：DSH 会话日志是多帧容器，整体流式解码会丢后续帧（见 decodeAllFrames 注释）。
 *
 * @param {Buffer} buf 整份（压缩的）日志文件内容
 * @param {(chunk: Buffer) => void} onChunk 每个解压分片的消费者（同步；抛错会中止并向上传播）
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{frames:number, tornStart?:number}>} 帧数；`tornStart` 存在表示尾部有截断帧
 */
export async function streamDecodedFrames(buf, onChunk, opts = {}) {
  if (typeof onChunk !== "function") throw new TypeError("streamDecodedFrames 需要 onChunk 回调");
  const { frames, tornStart } = scanZstdFrames(buf);
  for (const fr of frames) {
    opts.signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const decompressor = createZstdDecompress();
      decompressor.on("data", (chunk) => {
        try { onChunk(chunk); } catch (error) { reject(error); }
      });
      decompressor.on("end", resolve);
      decompressor.on("error", reject);
      decompressor.write(buf.subarray(fr.start, fr.end));
      decompressor.end();
    });
  }
  return tornStart === undefined ? { frames: frames.length } : { frames: frames.length, tornStart };
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
      const chunks = [];
      plain.on('data', x => chunks.push(x));
      plain.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        // ⚠️ 用 indexOf("\n") 判断换行位置，别用 indexOf(10)（JS 会把数字转字符串 "10" 找子串，误判）
        const nl = text.indexOf('\n');
        if (text.length === 0 || nl !== text.length - 1) {
          res({ ok: false, error: 'corrupt: 第一帧不是恰好一行 header' });
          return;
        }
        const line = text.slice(0, -1);
        try {
          const headerRecord = JSON.parse(line);
          if (headerRecord?.type !== 'session' || !headerRecord?.id) res({ ok: false, error: '第一行非 session header' });
          else res({ ok: true, header: headerRecord });
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
  const origBuf = readFileSync(path);
  // 先校验：本身已合规则跳过（避免无谓重写）
  const check = await validateHeaderFrame(origBuf);
  if (check.ok) return { ok: true, id: check.header.id, eventCount: null, fixed: false, note: '已合规' };

  // ── 帧级损坏（bad magic / 末帧内容坏）⇒ 截断到「最长的可解码前缀」────────────
  // 为什么必须单独处理：本机最常见的两种损坏是「尾部垃圾」（进程在写入中途被杀，
  // 最后一次 append 留下半截数据）与「末帧内容坏」（帧头正常但 zstd 载荷校验失败），
  // 这两种情况下前面成百上千帧往往**完好**。原实现一遇 bad magic 就直接返回失败
  // ⇒ 等于修不了（线上实测：`fixZstdFile` 对一份 4798 帧、只有末帧坏 + 尾部 7KB 垃圾的
  // 日志报 `bad magic at 11649807` 后放弃）。
  if (!check.error?.includes('corrupt') && !check.error?.includes('header')) {
    const truncated = await truncateToDecodablePrefix(path, origBuf, check.error, backupDir);
    if (truncated) return truncated;
    return { ok: false, error: check.error };
  }

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
  ensureBackupSync(path, bak);
  replaceFileSync(path, newBuf, { tmpSuffix: '.fixtmp' });
  return { ok: true, id: header.id, eventCount: events.length, fixed: true, backup: bak, origSize: origBuf.length, newSize: newBuf.length };
}

/**
 * 把「帧级损坏」的日志截断到**最长的可解码前缀**（保留原始帧，不重编码）。
 *
 * 步骤：① 取帧表 —— `scanZstdFrames` 遇坏 magic 会抛错（错误信息含偏移），
 * 据此退回到该偏移之前的前缀再扫一次；② **逐帧解码**，停在第一帧解不开之前，
 * 那个位置就是安全截断点；③ 截断后首帧必须仍是「恰好一行 header」。
 *
 * 返回 null 表示「不是截断能解的损坏形态」，交给调用方按原错误返回。
 *
 * @param {string} path 日志文件绝对路径
 * @param {Buffer} buf 该文件当前内容
 * @param {string} [originalError] 触发修复的原始错误（写进返回值便于排查）
 * @param {string} backupDir 备份目录
 */
async function truncateToDecodablePrefix(path, buf, originalError, backupDir) {
  let frames = null;
  try {
    ({ frames } = scanZstdFrames(buf));
  } catch (error) {
    const at = /bad magic at (\d+)/.exec(String(error?.message ?? ''));
    const cut = at ? Number(at[1]) : 0;
    if (!(cut > 0)) return null; // 连开头都不是合法帧 ⇒ 截断无意义
    try { ({ frames } = scanZstdFrames(buf.subarray(0, cut))); } catch { return null; }
  }
  if (!frames || frames.length === 0) return null;

  let safeEnd = 0;
  let dropped = null;
  for (const [i, fr] of frames.entries()) {
    try {
      const plain = await decodeFrame(buf.subarray(fr.start, fr.end));
      if (!plain || plain.length === 0) throw new Error('解出空内容');
    } catch (error) {
      dropped = { index: i, reason: String(error?.message ?? error) };
      break;
    }
    safeEnd = fr.end;
  }
  if (!dropped || safeEnd < 4) return null; // 没找到坏帧 ⇒ 不是本函数负责的形态

  const head = await validateHeaderFrame(buf.subarray(0, safeEnd));
  if (!head.ok) return null;

  mkdirSync(backupDir, { recursive: true });
  const rel = path.replace(/^.*\/sessions\//, '').replace(/\//g, '__');
  const bak = join(backupDir, rel);
  ensureBackupSync(path, bak);
  replaceFileSync(path, buf.subarray(0, safeEnd), { tmpSuffix: '.fixtmp' });
  return {
    ok: true,
    id: head.header.id,
    fixed: true,
    mode: 'truncate',
    origSize: buf.length,
    newSize: safeEnd,
    droppedFrame: dropped.index,
    droppedBytes: buf.length - safeEnd,
    droppedReason: dropped.reason,
    originalError,
    backup: bak,
  };
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
