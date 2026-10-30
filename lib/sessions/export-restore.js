// dsh-session-conductor — 从「会话导出包」恢复/覆盖会话
//
// 【为什么需要】DSH 的会话导出包是**明文 jsonl** 目录结构（`session.v4.jsonl` +
// `subagents/<id>/session.v4.jsonl` + `media/`），而运行时读的是
// `session.v4.jsonl.zstd` —— 带校验和的**多帧** zstd 容器，首帧必须恰好一行 header。
// 因此「把备份覆盖回去」不是简单拷贝：必须按官方容器格式重新编码，否则宿主会报
// 「会话文件 总和检查码不匹配」或 `corrupt session log`（本机两种都踩过）。
//
// 【三种坑与本模块的对应做法】
//   ① 无校验和帧 ⇒ 宿主拒读：压缩时固定带 ZSTD_c_checksumFlag（复用 zstd-frames 的 CHECKSUM_OPTIONS）。
//   ② 单帧塞进整份日志 ⇒ 读取端一次性解压整帧、内存尖峰：按 eventsPerFrame 分帧（宿主自己也是分批 append）。
//   ③ 覆盖 seeded 会话时打乱 inherited 标记 ⇒ 宿主断言 "seeded session requires an inherited event count"：
//      只覆盖日志文件本身，不动 projcache 与目录内其它文件；报告里回显 inherited 标记位置供核对。
//
// 【安全】默认 dryRun：只扫描并报告「会覆盖哪些会话、事件多少、帧多少」，不写盘。
// 真正写盘时：先校验 header.id 与目标一致、事件 seq 严格连续，再写 tmp 后 rename 原子替换；
// 写完重新逐帧解码复核事件数与末事件，复核不通过即记为错误。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { scanZstdFrames, validateHeaderFrame, decodeAllFrames, CHECKSUM_OPTIONS } from '../zstd-frames.js';
import { sessionsRootOf, findSessionLogById } from './events.js';
import { log } from '../shared/log.js';

/** 每个 zstd 事件帧里装多少条事件（宿主自己也是分批 append，太大会让读取端内存尖峰）。 */
const DEFAULT_EVENTS_PER_FRAME = 1000;

/** 导出包里明文的固定文件名。 */
const PLAIN_NAME = 'session.v4.jsonl';

/**
 * 把一个明文 jsonl 编码成 DSH 官方 zstd 多帧容器（首帧恰好一行 header，每帧带校验和）。
 *
 * @param {string} plainText 明文 jsonl 全文
 * @param {{eventsPerFrame?: number}} [opts]
 * @returns {{ok: true, buffer: Buffer, header: object, eventCount: number, frames: number, inheritedAt: number|null}
 *          | {ok: false, error: string}}
 */
export function encodePlainToZstd(plainText, opts = {}) {
  const eventsPerFrame = Math.max(1, opts.eventsPerFrame ?? DEFAULT_EVENTS_PER_FRAME);
  const lines = String(plainText).split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return { ok: false, error: '明文事件不足（至少需要 header + 1 条事件）' };

  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    return { ok: false, error: `首行不是合法 JSON：${String(error?.message ?? error)}` };
  }
  if (header?.type !== 'session' || !header?.id) return { ok: false, error: '首行不是 session header' };

  // 事件必须 seq 严格连续：不连续的日志写出去宿主也会判 corrupt，这里直接拒绝
  const events = [];
  let prev = -1;
  let gaps = 0;
  let bad = 0;
  let inheritedAt = null;
  for (let i = 1; i < lines.length; i += 1) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      bad += 1;
      continue;
    }
    if (typeof e?.seq === 'number') {
      if (prev >= 0 && e.seq !== prev + 1) gaps += 1;
      prev = e.seq;
    }
    if (e?.type === 'session/end-seed' && e?.data?.inherited === true) inheritedAt = e.seq;
    events.push(e);
  }
  if (bad > 0) return { ok: false, error: `明文里有 ${bad} 行坏 JSON` };
  if (gaps > 0) return { ok: false, error: `明文事件 seq 不连续（${gaps} 处），拒绝编码` };

  const frames = [zlib.zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'), CHECKSUM_OPTIONS)];
  for (let i = 0; i < events.length; i += eventsPerFrame) {
    const chunk = events.slice(i, i + eventsPerFrame).map((e) => JSON.stringify(e)).join('\n') + '\n';
    frames.push(zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'), CHECKSUM_OPTIONS));
  }
  return { ok: true, buffer: Buffer.concat(frames), header, eventCount: events.length, frames: frames.length, inheritedAt };
}

/**
 * 扫描导出包目录，列出「里面有哪些会话、各自对应哪个目标目录」。
 *
 * 目标目录解析顺序：① 按会话 id 找现有会话目录（覆盖已有会话）② 找不到就用同族目录
 * （导出包里父会话所在的项目目录）新建 —— 同族会话必然同 cwd，避免自己实现路径编码。
 *
 * @param {string} exportDir 解压后的导出包目录
 * @param {{home?: string}} [opts]
 * @returns {{entries: Array<object>, error?: string}}
 */
export function scanExportDir(exportDir, opts = {}) {
  if (!existsSync(exportDir)) return { entries: [], error: `导出目录不存在：${exportDir}` };
  // 注意：sessionsRootOf() 不接受参数（它只读 process.env.DSH_HOME），
  // 所以要支持自定义 home 必须自己拼 <home>/sessions，不能把 home 当参数传进去。
  const root = opts.home ? join(opts.home, 'sessions') : sessionsRootOf();
  const entries = [];

  const readHeaderOf = (plainPath) => {
    try {
      const firstLine = readFileSync(plainPath, 'utf8').split('\n', 1)[0];
      return JSON.parse(firstLine);
    } catch {
      return null;
    }
  };

  // 父会话（导出包根下的 session.v4.jsonl）
  const parentPlain = join(exportDir, PLAIN_NAME);
  let familyDir = null;
  if (existsSync(parentPlain)) {
    const header = readHeaderOf(parentPlain);
    if (header?.id) {
      const existing = findSessionLogById(header.id, root);
      const targetDir = existing ? join(existing, '..') : null;
      if (targetDir) familyDir = join(targetDir, '..');
      entries.push({
        role: 'parent',
        id: header.id,
        plainPath: parentPlain,
        targetDir,
        action: targetDir ? 'overwrite' : 'skip',
        reason: targetDir ? '' : '找不到该会话的现有目录',
      });
    }
  }

  // 子代理（subagents/<id>/session.v4.jsonl）
  const subsDir = join(exportDir, 'subagents');
  if (existsSync(subsDir)) {
    for (const name of readdirSync(subsDir)) {
      const plainPath = join(subsDir, name, PLAIN_NAME);
      if (!existsSync(plainPath)) continue;
      const header = readHeaderOf(plainPath);
      const id = header?.id;
      if (!id) {
        entries.push({ role: 'subagent', id: name, plainPath, targetDir: null, action: 'skip', reason: '明文 header 无法解析' });
        continue;
      }
      const existing = findSessionLogById(id, root);
      if (existing) {
        entries.push({ role: 'subagent', id, plainPath, targetDir: join(existing, '..'), action: 'overwrite' });
      } else if (familyDir) {
        entries.push({ role: 'subagent', id, plainPath, targetDir: join(familyDir, id), action: 'create' });
      } else {
        entries.push({ role: 'subagent', id, plainPath, targetDir: null, action: 'skip', reason: '既无现有目录、又无同族目录可落' });
      }
      if (id !== name) {
        const last = entries[entries.length - 1];
        last.reason = `${last.reason ? last.reason + '；' : ''}目录名(${name})与 header.id 不一致`;
      }
    }
  }
  return { entries };
}

/**
 * 恢复后让「新日志」真正生效：清投影缓存 + 尝试把 live 会话卸载回冷状态。
 *
 * 【为什么必须做】DSH 有**三层状态**：会话日志（磁盘）/ projcache（投影缓存）/ 进程内存里的 agent。
 * 只覆盖磁盘日志时，界面仍显示旧内容——本机实测：日志 11:20 已覆盖，projcache 还停在 11:06，
 * 打开会话看到的就是替换前的内容。因此恢复后必须：
 *   ① 删掉该会话的 projcache 条目（否则冷读仍会拿旧投影）；
 *   ② 若会话还是 live 的（内存里有 agent），把它 detach 回冷状态，下次打开才会重新从磁盘读。
 *
 * detach 需要插件 ctx（要 agents/sessions 服务）；没有 ctx 时只清缓存并如实标注，
 * 由调用方提示「需重载/重启宿主」。
 *
 * @param {object} o
 * @param {string} o.home DSH_HOME
 * @param {string} o.sessionId 会话 id
 * @param {object} [o.ctx] 插件 ctx（有则尝试 detach）
 * @returns {Promise<{projcacheCleared: boolean, detached: boolean, note?: string}>}
 */
async function invalidateAfterRestore({ home, sessionId, ctx }) {
  const out = { projcacheCleared: false, detached: false };
  // ① 清投影缓存
  try {
    const cacheFile = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    if (existsSync(cacheFile)) {
      unlinkSync(cacheFile);
      out.projcacheCleared = true;
    }
  } catch (error) {
    out.note = `清投影缓存失败：${String(error?.message ?? error)}`;
  }
  // ② 尝试 detach（让内存态丢弃；非 live 幂等返回 ok）
  if (ctx) {
    try {
      const { detachSessionAgent } = await import('./detach.js');
      const r = await detachSessionAgent(ctx, sessionId);
      out.detached = r?.ok === true;
      if (!r?.ok && r?.error?.message && !out.note) out.note = `detach 未执行：${r.error.message}`;
    } catch (error) {
      if (!out.note) out.note = `detach 失败：${String(error?.message ?? error)}`;
    }
  } else if (!out.note) {
    out.note = '未传 ctx，未尝试 detach（若会话仍打开着，需重载/重启宿主才能看到新内容）';
  }
  return out;
}

/**
 * 按导出包恢复/覆盖会话。
 *
 * @param {object} o
 * @param {string} o.exportDir 解压后的导出包目录
 * @param {string} [o.home] DSH_HOME（缺省按宿主约定推导）
 * @param {string[]} [o.sessionIds] 只处理这些会话（缺省全部）
 * @param {boolean} [o.dryRun] true 只扫描报告（默认 true）
 * @param {number} [o.eventsPerFrame]
 * @param {object} [o.ctx] 可选：传插件 ctx 时顺带写日志，并尝试 detach（把 live 会话卸载回冷状态）
 * @param {boolean} [o.invalidate] 默认 true：恢复后清该会话 projcache，避免「覆盖了但界面还是旧内容」
 * @returns {Promise<{ok:boolean, dryRun:boolean, results:Array<object>, errors:Array<string>}>}
 */
export async function restoreSessionsFromExport(o) {
  const dryRun = o?.dryRun !== false;
  const { entries, error } = scanExportDir(o?.exportDir, { home: o?.home });
  if (error) return { ok: false, dryRun, results: [], errors: [error] };
  const only = Array.isArray(o?.sessionIds) && o.sessionIds.length > 0 ? new Set(o.sessionIds) : null;
  const results = [];
  const errors = [];

  for (const entry of entries) {
    if (only && !only.has(entry.id)) continue;
    if (entry.action === 'skip') {
      results.push({ ...entry, status: 'skipped' });
      continue;
    }
    let plain;
    try {
      plain = readFileSync(entry.plainPath, 'utf8');
    } catch (e) {
      errors.push(`${entry.id}：读明文失败 ${String(e?.message ?? e)}`);
      results.push({ ...entry, status: 'error' });
      continue;
    }
    const encoded = encodePlainToZstd(plain, { eventsPerFrame: o?.eventsPerFrame });
    if (!encoded.ok) {
      errors.push(`${entry.id}：${encoded.error}`);
      results.push({ ...entry, status: 'error' });
      continue;
    }
    if (encoded.header.id !== entry.id) {
      errors.push(`${entry.id}：明文 header.id=${encoded.header.id} 与目录不一致`);
      results.push({ ...entry, status: 'error' });
      continue;
    }
    const summary = {
      ...entry,
      status: dryRun ? 'would-restore' : 'restored',
      eventCount: encoded.eventCount,
      frames: encoded.frames,
      inheritedAt: encoded.inheritedAt,
      bytes: encoded.buffer.length,
    };
    if (dryRun) {
      results.push(summary);
      continue;
    }
    // 真正写盘：目录缺则建，写 tmp 后 rename 原子替换，再逐帧复核
    try {
      if (!existsSync(entry.targetDir)) {
        mkdirSync(entry.targetDir, { recursive: true, mode: 0o700 });
        summary.created = true;
      }
      const target = join(entry.targetDir, 'session.v4.jsonl.zstd');
      const tmp = join(entry.targetDir, '.session.restore.tmp');
      writeFileSync(tmp, encoded.buffer, { mode: 0o600 });
      renameSync(tmp, target);
      const after = readFileSync(target);
      const headerCheck = await validateHeaderFrame(after);
      const { frames } = scanZstdFrames(after);
      const checksums = frames.map((fr) => (after.readUInt8(fr.start + 4) & 0x04) !== 0);
      const backLines = (await decodeAllFrames(after)).split('\n').filter((l) => l.trim() !== '');
      const okVerify = headerCheck.ok && checksums.every(Boolean) && backLines.length - 1 === encoded.eventCount;
      summary.verified = okVerify;
      summary.sizeMB = Math.round((statSync(target).size / 1048576) * 10) / 10;
      if (!okVerify) {
        errors.push(
          `${entry.id}：写后复核未通过（首帧 ${headerCheck.ok}、校验和 ${checksums.every(Boolean)}、事件 ${backLines.length - 1}/${encoded.eventCount}）`,
        );
      } else if (o?.invalidate !== false) {
        // 复核通过才失效：顺序很重要——先确保磁盘是对的，再丢缓存/卸载
        const inv = await invalidateAfterRestore({ home: o?.home ?? '', sessionId: entry.id, ctx: o?.ctx });
        summary.projcacheCleared = inv.projcacheCleared;
        summary.detached = inv.detached;
        if (inv.note) summary.note = inv.note;
      }
      results.push(summary);
    } catch (e) {
      errors.push(`${entry.id}：写盘失败 ${String(e?.message ?? e)}`);
      results.push({ ...summary, status: 'error' });
    }
  }
  if (o?.ctx) log(o.ctx, `导出包恢复：${dryRun ? '预览' : '执行'} ${results.length} 项，错误 ${errors.length} 条`);
  return { ok: errors.length === 0, dryRun, results, errors };
}
