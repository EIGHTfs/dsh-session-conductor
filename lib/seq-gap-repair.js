// dsh-session-conductor — 会话日志 seq-gap 与 token-surface 修复（模块化）
//
// 三层叠加根因（2026-08-24 实测修复 272 万事件会话）：
//   1) agent/inbox/spliced 拼接片段未重编号 seq → 受影响区事件 seq 整体偏移（seq ≠ 位置）
//   2) 受影响区 replace 的 sourceEventSeqs 缺失被 shadow 的 surface 节点
//   3) compaction/summary|prune 的 shadowedRange 未映射 → token-surface 协议断裂
// 修复：动态定位 GAP/offset → 3 类引用映射（值 ≥ GAP 则 +offset）→ seq 重编号 → 自愈补全缺失引用
//   → 官方 foldSurface 校验 → token-surface 协议校验 → packChunkRuns → 多帧 zstd 原子写回。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { zstdCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';
import { foldSurface, isSurfaceEvent, deriveEventMessage } from '@deepseek-ai/dsh-session';
import { decodeStorageRecord, packChunkRuns } from './session-codec.js';
import { decodeAllFrames } from './zstd-frames.js';

const zstdCompressAsync = promisify(zstdCompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/** 解码会话文件 → { header, events }。返回 null 表示无法解析（非 seq-gap 损坏）。 */
async function loadSessionFile(path) {
  const orig = readFileSync(path);
  const text = await decodeAllFrames(orig);
  const lines = text.split('\n');
  const header = JSON.parse(lines[0]);
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    let r;
    try { r = JSON.parse(l); } catch { break; }
    let d;
    try { d = decodeStorageRecord(r); } catch { break; }
    events.push(...d);
  }
  return { orig, header, events };
}

/** 动态定位 seq 错位起点。返回 { gapAt, offset } 或 null（无错位，seq 已连续）。 */
export function detectSeqGap(events) {
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i) {
      return { gapAt: i, offset: events[i].seq - i }; // offset 为负（如 -4183）
    }
  }
  return null;
}

/** 自愈 surface fold：对 replace 补全缺失的 shadowed 引用，可多轮收敛。 */
function foldFix(events, patch) {
  const nodes = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!SURFACE_TYPES.has(e.type)) continue;
    const op = e.surfaceOp;
    if (op === 'append') { nodes.push(i); continue; }
    if (typeof op === 'object' && op && op.op === 'replace') {
      const si = nodes.indexOf(op.start), ei = nodes.indexOf(op.end);
      if (si === -1) throw new Error(`surface replace: start seq ${op.start} not found in surface @seq=${i}`);
      if (ei === -1) throw new Error(`surface replace: end seq ${op.end} not found in surface @seq=${i}`);
      if (si > ei) throw new Error(`surface replace: start seq ${op.start} is after end seq ${op.end} @seq=${i}`);
      const shadowed = nodes.slice(si, ei + 1);
      const have = new Set(e.sourceEventSeqs || []);
      const missing = shadowed.filter((s) => !have.has(s));
      if (missing.length && patch) {
        e.sourceEventSeqs = [...(e.sourceEventSeqs || []), ...missing].sort((a, b) => a - b);
      } else if (missing.length) {
        throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')} @seq=${i}`);
      }
      if (e.sourceEventSeqs && e.sourceEventSeqs.some((s) => s >= i)) {
        throw new Error(`sourceEventSeqs must reference earlier events @seq=${i}`);
      }
      nodes.splice(si, ei - si + 1, i);
    }
  }
  return { nodes };
}

/** token-surface 协议校验（与 dsh-token-meter foldSurfaceProjection 一致）。 */
function verifyTokenSurface(events) {
  let claim = undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'compaction/summary' || e.type === 'compaction/prune') {
      const r = e.data?.shadowedRange;
      if (r) claim = { start: r.start, end: r.end, tokens: 0 };
      continue;
    }
    if (!SURFACE_TYPES.has(e.type)) { claim = undefined; continue; }
    const op = e.surfaceOp;
    if (op === 'append') { claim = undefined; continue; }
    if (typeof op === 'object' && op && op.op === 'replace') {
      if (!claim) { claim = undefined; continue; }
      if (claim.start !== op.start || claim.end !== op.end) {
        throw new Error(`token surface: replace at seq ${i} over range ${op.start}-${op.end} has no adjacent shadow price (armed claim covers ${claim.start}-${claim.end})`);
      }
      claim = undefined;
    }
  }
}

/**
 * 修复 seq-gap 会话日志。
 * @param {string} path 会话 session.jsonl.zstd 路径
 * @param {{dryRun?: boolean, backupDir?: string}} opts
 * @returns {{ok:boolean, eventCount:number, gapAt?:number, offset?:number, patchedRefs?:number, sizeBefore?:number, sizeAfter?:number, backupPath?:string, error?:string}}
 */
export async function repairSeqGap(path, { dryRun = false, backupDir } = {}) {
  const report = { ok: false };
  const { orig, header, events } = await loadSessionFile(path);
  report.eventCount = events.length;
  report.sizeBefore = orig.length;

  const gap = detectSeqGap(events);
  if (gap === null) {
    report.ok = true;
    report.error = 'no-seq-gap'; // seq 已连续，无需修复
    return report;
  }
  report.gapAt = gap.gapAt;
  report.offset = gap.offset;

  // 1) 3 类引用映射（值 ≥ GAP 则 +offset，offset 为负）
  // offset 为负（seq = pos + offset），受影响区引用映射到重编号后 seq = 旧seq - offset
  const mapSeq = (n) => { n = Number(n); return n >= gap.gapAt ? n - gap.offset : n; };
  let mappedCompaction = 0, patchedRefs = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (Array.isArray(e.sourceEventSeqs)) { e.sourceEventSeqs = e.sourceEventSeqs.map(mapSeq); patchedRefs += e.sourceEventSeqs.length; }
    if (typeof e.surfaceOp === 'object' && e.surfaceOp && e.surfaceOp.op === 'replace') {
      e.surfaceOp.start = mapSeq(e.surfaceOp.start);
      e.surfaceOp.end = mapSeq(e.surfaceOp.end);
    }
    if ((e.type === 'compaction/summary' || e.type === 'compaction/prune') && e.data?.shadowedRange) {
      e.data.shadowedRange.start = mapSeq(e.data.shadowedRange.start);
      e.data.shadowedRange.end = mapSeq(e.data.shadowedRange.end);
      mappedCompaction++;
    }
  }
  report.mappedCompaction = mappedCompaction;
  report.patchedRefs = patchedRefs;

  // 2) seq 重编号为位置
  for (let i = 0; i < events.length; i++) events[i].seq = i;

  // 3) 自愈补全（多轮收敛）
  let addedRefs = 0;
  for (let round = 0; round < 15; round++) {
    try { foldFix(events, false); break; }
    catch (e) {
      if (round === 14) { report.error = `fold 未收敛: ${e.message}`; return report; }
      foldFix(events, true);
      addedRefs += 1;
    }
  }
  report.addedRefs = addedRefs;

  // 4) 官方校验
  try { foldSurface(events); } catch (e) { report.error = `foldSurface 失败: ${e.message}`; return report; }
  try { verifyTokenSurface(events); } catch (e) { report.error = `token-surface 失败: ${e.message}`; return report; }

  // 5) 打包 + 重解码校验（零丢失）
  const packed = packChunkRuns(events);
  const reEv = [];
  for (const l of packed) reEv.push(...decodeStorageRecord(l));
  let seqMismatch = 0;
  for (let i = 0; i < reEv.length; i++) if (reEv[i].seq !== i) seqMismatch++;
  if (reEv.length !== events.length) { report.error = `事件数不一致: ${events.length} → ${reEv.length}`; return report; }
  if (seqMismatch > 0) { report.error = `重打包后 seq 错位 ${seqMismatch}`; return report; }

  const bodyText = packed.map((r) => JSON.stringify(r)).join('\n') + '\n';
  if (dryRun) {
    report.ok = true;
    report.dryRun = true;
    report.sizeAfter = orig.length;
    return report;
  }

  // 6) 备份 + 原子写回（多帧）
  const bakDir = backupDir || join(dirname(path), '.seq-gap-backup');
  mkdirSync(bakDir, { recursive: true });
  const bakPath = join(bakDir, `session-seqgap-${Date.now()}.zstd`);
  writeFileSync(bakPath, orig);
  report.backupPath = bakPath;

  const headerFrame = await zstdCompressAsync(Buffer.from(header + '\n', 'utf8'), CHECKSUM_OPTIONS);
  const bodyFrame = await zstdCompressAsync(Buffer.from(bodyText, 'utf8'), CHECKSUM_OPTIONS);
  const newBuf = Buffer.concat([headerFrame, bodyFrame]);
  report.sizeAfter = newBuf.length;
  const tmp = path + '.fixing';
  writeFileSync(tmp, newBuf);
  renameSync(tmp, path);
  report.ok = true;
  return report;
}

/** 扫描 DSH_HOME 全部会话，返回疑似 seq-gap 损坏的列表（只检测不修复）。 */
export async function scanSeqGapSessions(sessionsRoot) {
  const { readdirSync, existsSync } = await import('node:fs');
  const results = [];
  const projects = readdirSync(sessionsRoot, { withFileTypes: true });
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projPath = join(sessionsRoot, proj.name);
    const sessDirs = readdirSync(projPath, { withFileTypes: true });
    for (const sdir of sessDirs) {
      if (!sdir.isDirectory()) continue;
      const logPath = join(projPath, sdir.name, 'session.jsonl.zstd');
      if (existsSync(logPath)) {
        try {
          const { events } = await loadSessionFile(logPath);
          const gap = detectSeqGap(events);
          if (gap) results.push({ session: sdir.name, path: logPath, gapAt: gap.gapAt, offset: gap.offset, eventCount: events.length });
        } catch { /* 非 seq-gap 损坏（如帧损坏），跳过 */ }
      }
    }
  }
  return results;
}
