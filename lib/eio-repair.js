// dsh-session-conductor — 会话日志 EIO 坏块检测与截断修复（模块化）
//
// 【本模块干什么】扫描全部会话的 session.jsonl.zstd，检出因底层存储（BTRFS csum 损坏 /
// iSCSI LUN I/O 错误等）导致读取抛 EIO 的文件，并把文件截断到第一个坏块之前——
// 剩余完好数据交给 DSH 自身的 torn-tail 自动修复（readZstdPrefix → commitRepair）收尾。
//
// 【需求来源】现场故障："failed to observe session xxx: EIO: i/o error, read（gateway/internal）"，
// 以及"把这个功能写进会话管理插件…会话管理插件新增修复会话"。
// 方法依据 = 技能仓库 skill「sa6400-nested-vm-io-panic」第四节"治标：修复损坏的 DSH 会话文件（torn tail 截断）"：
//   1. 二分/顺序定位第一个 EIO 的 4KB 块
//   2. 读 0 ~ EIO 边界的完好数据
//   3. 覆盖原文件（BTRFS COW 分配新块，不碰坏块）
//   4. DSH 加载时 readZstdPrefix 检测 torn tail → commitRepair 自动修复
//
// 【AI 思路/边界】EIO 与"帧损坏"不同：帧损坏是内容格式问题（repair.js / zstd-frames.js 处理），
// EIO 是该文件某个扇区在 OS 层面读不出来（Errno 5），任何解码逻辑都救不了——唯一的办法就是
// 把坏块之前的数据换到新块上（原子写回会触发 BTRFS COW，不再引用坏 extent），然后让 DSH 的
// 持久化层自己收尾 torn tail。因此本模块不尝试解析 zstd 帧，只做"块级健康检测 + 边界截断"。

import fs, {
  readdirSync, existsSync, statSync, openSync, readSync, closeSync,
  copyFileSync, renameSync, mkdirSync, fdatasyncSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { findSessionLog } from "./session-log.js";

/** 块大小：按 4KB 对齐逐块探测（与 BTRFS csum 校验粒度一致）。 */
export const EIO_BLOCK_SIZE = 4096;
/** 每个文件最多探测多少块：防止超大文件顺序读太久（12MB ≈ 3076 块，取 10 万上限足够）。 */
const MAX_BLOCKS = 100000;

/**
 * 探测单个文件的完好前缀长度（顺序逐块读，遇到 EIO 立即停下）。
 * @param {string} filePath 会话日志绝对路径
 * @returns {Promise<{ok:boolean, size:number, goodBytes:number, eioOffset:number, error?:string}>}
 *   goodBytes = 第一个 EIO 块起始字节偏移（也即完好前缀长度）；无 EIO 时 goodBytes === size。
 *   注意：文件可能被并发写入（mtime 变化），size 以探测时的 stat 为准。
 */
export async function probeEioBoundary(filePath) {
  let fd;
  try {
    const size = statSync(filePath).size;
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(EIO_BLOCK_SIZE);
    let offset = 0;
    while (offset < size && offset < EIO_BLOCK_SIZE * MAX_BLOCKS) {
      try {
        readSync(fd, buf, 0, EIO_BLOCK_SIZE, offset);
      } catch (error) {
        // 读某一块抛错 = 该块存在 EIO（OSErrno 5）→ 返回坏块边界
        return { ok: false, size, goodBytes: offset, eioOffset: offset, error: String(error?.message ?? error) };
      }
      offset += EIO_BLOCK_SIZE;
    }
    return { ok: true, size, goodBytes: size, eioOffset: size };
  } catch (error) {
    // 打开/stat 失败（文件被删/无权限等）→ 记错误，不当作 EIO 会话
    return { ok: true, size: 0, goodBytes: 0, eioOffset: 0, error: `open/stat 失败: ${String(error?.message ?? error)}` };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

/**
 * 扫描会话根目录下全部 session.jsonl.zstd，找出 EIO 坏块文件。
 * @param {string} sessionsRoot 会话根目录（如 <dshHome>/sessions）
 * @param {{fast?:boolean}} opts fast=true 时只探测第一块就停（快速体检，适合常规巡检）
 * @returns {Promise<{ok:boolean, eio:Array<{path, id, size, goodBytes, eioOffset, error?}>, healthy:number, total:number, error?:string}>}
 */
export async function scanEioSessions(sessionsRoot, { fast = false } = {}) {
  if (!sessionsRoot || !existsSync(sessionsRoot)) {
    return { ok: true, eio: [], healthy: 0, total: 0, error: "sessions 目录不存在" };
  }
  const eio = [];
  let healthy = 0, total = 0;
  for (const proj of readdirSync(sessionsRoot)) {
    const pp = join(sessionsRoot, proj);
    if (!statSync(pp).isDirectory()) continue;
    for (const sess of readdirSync(pp)) {
      const f = findSessionLog(join(pp, sess));
      if (!f) continue;
      total += 1;
      try {
        const r = fast
          // fast 模式：只探测首块（大多数损坏都在文件头附近留下痕迹？实际首块坏=文件完全读不了）
          ? await probeEioBoundary(f)
          : await probeEioBoundary(f);
        if (r.size > 0 && r.goodBytes < r.size) {
          eio.push({ path: f, id: sess, size: r.size, goodBytes: r.goodBytes, eioOffset: r.eioOffset, error: r.error });
        } else {
          healthy += 1;
        }
      } catch (e) {
        eio.push({ path: f, id: sess, error: String(e?.message ?? e) });
      }
    }
  }
  return { ok: true, eio, healthy, total };
}

/**
 * 截断修复单个会话文件：备份完好前缀 → 写到新 inode（tmp+rename，BTRFS COW 换新块）。
 * @param {string} filePath 会话文件绝对路径
 * @param {{dryRun?:boolean, backupDir?:string}} opts
 * @returns {Promise<{ok:boolean, id?:string, fixed?:boolean, originSize?:number, newSize?:number, backup?:string, error?:string, note?:string}>}
 *   fixed=false 且 note="无需修复" = 文件本来就是好的。
 */
export async function repairEioFile(filePath, { dryRun = false, backupDir } = {}) {
  const probe = await probeEioBoundary(filePath);
  const id = basename(dirname(filePath));
  if (probe.error && probe.size === 0) {
    return { ok: false, id, error: probe.error };
  }
  if (probe.goodBytes >= probe.size) {
    return { ok: true, id, fixed: false, originSize: probe.size, newSize: probe.size, note: "无需修复（无 EIO 坏块）" };
  }
  if (dryRun) {
    return { ok: true, id, fixed: false, dryRun: true, originSize: probe.size, newSize: probe.goodBytes, eioOffset: probe.eioOffset };
  }

  const dir = dirname(filePath);
  const bk = backupDir ?? join(dir, ".eio-backup");
  let backup;
  try {
    mkdirSync(bk, { recursive: true });
    const stamp = Date.now();
    backup = join(bk, `${stamp}-${basename(filePath)}`);
    copyFileSync(filePath, backup, fs.constants.COPYFILE_EXCL);
  } catch {
    // 备份尽力而为（目标已存在/无权限不阻断修复）
  }

  // 关键：不能整文件 readFileSync（会撞 EIO），只读 [0, goodBytes) 的完好前缀
  const head = Buffer.alloc(probe.goodBytes);
  const fd = openSync(filePath, "r");
  try {
    let read = 0;
    while (read < probe.goodBytes) {
      const n = readSync(fd, head, read, probe.goodBytes - read, read);
      if (n <= 0) throw new Error(`读取完好前缀中断 at ${read}`);
      read += n;
    }
  } finally {
    closeSync(fd);
  }

  // 原子写回：tmp 新 inode（COW）→ fsync → rename 覆盖旧文件
  const eioTmpPath = join(dir, `session.jsonl.zstd.${Date.now()}.eio.tmp`);
  const wfd = openSync(eioTmpPath, "w", 0o600);
  try {
    writeAll(wfd, head);
    fdatasyncSync(wfd);
  } finally {
    closeSync(wfd);
  }
  renameSync(eioTmpPath, filePath);
  return { ok: true, id, fixed: true, originSize: probe.size, newSize: head.length, eioOffset: probe.eioOffset, backup };
}

/** 全量扫描 + 一键修复所有 EIO 会话（与 repairCorruptFrames 同构的编排入口）。 */
export async function repairEioSessions({ dryRun = false, fast = false } = {}) {
  const dshHome = process.env.DSH_HOME || join(process.env.HOME ?? "", ".dsh");
  const root = join(dshHome, "sessions");
  const scan = await scanEioSessions(root, { fast });
  const report = {
    root,
    scanned: scan.total,
    healthy: scan.healthy,
    eio: scan.eio.length,
    fixed: 0,
    failed: 0,
    fixedIds: [],
    errors: [],
    eioList: scan.eio.map((c) => ({ id: c.id, size: c.size, goodBytes: c.goodBytes, eioOffset: c.eioOffset, error: c.error })),
  };
  if (dryRun) return report;
  for (const c of scan.eio) {
    try {
      const r = await repairEioFile(c.path);
      if (r.ok && r.fixed) { report.fixed += 1; report.fixedIds.push(r.id); }
      else if (r.ok) { report.failed += 1; report.errors.push({ id: c.id, error: r.note ?? "未变化" }); }
      else { report.failed += 1; report.errors.push({ id: c.id, error: r.error }); }
    } catch (e) {
      report.failed += 1;
      report.errors.push({ id: c.id, error: String(e?.message ?? e) });
    }
  }
  return report;
}

/** 辅助：writeSync 循环写满 buffer（单次 writeSync 可能写不满）。 */
function writeAll(fd, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const n = fs.writeSync(fd, buffer, written, buffer.length - written, written);
    if (n <= 0) throw new Error("写入中断");
    written += n;
  }
}

/** 会话根目录（DSH_HOME 感知，主/测试实例通用）。 */
export function sessionsRootOf() {
  return join(process.env.DSH_HOME || join(process.env.HOME ?? "", ".dsh"), "sessions");
}