// dsh-session-conductor 会话日志修复模块。
// 背景：task_completion_* 工具的旧版 output.render 返回纯字符串，导致
// tool/result 事件的 tool-result 块 content 落盘为 string，而 DSH 持久化
// 校验器要求其为块数组 → 会话 history unavailable（SessionPersistenceCorruptionError）。
// 本模块：扫描全部冷会话 → 离线复刻 DSH 校验器 → 修复字符串 content →
// 用与 jsonl 后端完全一致的 zstd 多帧格式原子写回（带 .bak-corrupt 备份）。

import { readdirSync, existsSync, statSync, mkdirSync, renameSync, readFileSync, promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import { zstdCompress, constants } from "node:zlib";
import { promisify } from "node:util";
import { decodeStorageRecord } from "./session-codec.js";
import { fixZstdFile, scanAllCorruptFrames } from "./zstd-frames.js";
import { findSessionLog } from "./session-log.js";

const zstdCompressAsync = promisify(zstdCompress);
/** 与 dsh-session-persistence-jsonl 后端完全一致的 zstd 压缩参数（带校验和）。 */
const ZSTD_CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/** 一行 JSONL → 事件数组（v3 会话格式：一行一个事件，直接返回）。 */
export function parseLineEvents(line) {
  try {
    const record = JSON.parse(line);
    return decodeStorageRecord(record);
  } catch {
    return null;
  }
}

/**
 * 校验一段会话日志文本（header + 事件行）。复刻 DSH assertMessageEventShape
 * 对 tool/result 的关键约束 + header/seq 连续性。
 * @returns {{ok:boolean, problems:string[], eventCount:number, lineCount:number}}
 */
export function validateSessionText(text) {
  const lines = String(text).split("\n");
  const problems = [];
  let eventCount = 0;
  let expectedSeq = 0;
  // 只弹一个 split 结尾换行的产物；若再出现空行 = 扫描器眼里的真实 torn 记录
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return { ok: false, problems: ["空日志"], eventCount: 0, lineCount: 0 };
  try {
    const header = JSON.parse(lines[0]);
    if (header?.type !== "session") problems.push("首行不是 session header");
  } catch {
    problems.push("首行 JSON 解析失败");
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      problems.push(`第 ${i + 1} 行是空行（torn 记录）`);
      continue;
    }
    const events = parseLineEvents(lines[i]);
    if (events === null) {
      problems.push(`第 ${i + 1} 行解析失败`);
      continue;
    }
    for (const ev of events) {
      eventCount += 1;
      if (typeof ev?.seq !== "number") continue;
      if (ev.seq !== expectedSeq) problems.push(`seq 不连续：期望 ${expectedSeq}，实际 ${ev.seq}`);
      expectedSeq = ev.seq + 1;
      if (ev.type !== "tool/result") continue;
      const message = ev.data?.message;
      if (typeof message !== "object" || message === null || typeof message.id !== "string" || message.id === "") {
        problems.push(`seq ${ev.seq} tool/result 缺 message.id`);
        continue;
      }
      if (message.role !== "user") problems.push(`seq ${ev.seq} tool/result role 应为 user`);
      const source = message.source;
      if (typeof source !== "object" || source === null || source.kind !== "tool" || typeof source.callId !== "string" || source.callId === "") {
        problems.push(`seq ${ev.seq} tool/result source 非法`);
        continue;
      }
      if (!Array.isArray(message.content)) {
        problems.push(`seq ${ev.seq} tool/result content 非数组`);
        continue;
      }
      const block = message.content[0];
      if (message.content.length !== 1 || typeof block !== "object" || block === null || block.type !== "tool-result") {
        problems.push(`seq ${ev.seq} 必须恰好一个 tool-result 块`);
        continue;
      }
      if (!Array.isArray(block.content)) {
        problems.push(`seq ${ev.seq} tool-result 块 content 必须是数组（当前 ${typeof block.content}）`);
        continue;
      }
      if (block.toolCallId !== source.callId) problems.push(`seq ${ev.seq} toolCallId 不匹配`);
    }
  }
  return { ok: problems.length === 0, problems, eventCount, lineCount: lines.length };
}

/**
 * 修复 tool-result 块 content 为字符串的问题：包成 [{type:"text",text}]。
 * 只重序列化发生变化的行，其余行原样保留。
 * @returns {{fixed:string, fixedCount:number}}
 */
export function fixToolResultStringContent(text) {
  const lines = String(text).split("\n");
  let fixedCount = 0;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || i === 0) {
      out.push(line);
      continue;
    }
    const events = parseLineEvents(line);
    if (events === null) {
      out.push(line);
      continue;
    }
    let changed = false;
    for (const ev of events) {
      if (ev?.type !== "tool/result") continue;
      const message = ev.data?.message;
      if (typeof message !== "object" || message === null) continue;
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block === "object" && block !== null && block.type === "tool-result" && typeof block.content === "string") {
          block.content = [{ type: "text", text: block.content }];
          changed = true;
          fixedCount += 1;
        }
      }
    }
    out.push(changed ? JSON.stringify(events.length === 1 ? events[0] : events) : line);
  }
  // 清掉末尾空行（含 split 产物与历史损坏留下的空行），保证 encode 后无 torn 记录
  while (out.length > 0 && out.at(-1).trim() === "") out.pop();
  return { fixed: out.join("\n"), fixedCount };
}

/** 按 jsonl 后端格式重编码：header 帧（恰好首行）+ 事件帧。 */
export async function encodeSessionText(text) {
  const lines = String(text).split("\n");
  const header = lines[0] + "\n";
  // 去掉末尾空行（split 会把结尾换行切成空串），事件帧以恰好一个换行收尾，
  // 避免扫描器把空行当作 torn 记录
  let bodyLines = lines.slice(1);
  while (bodyLines.length > 0 && bodyLines.at(-1) === "") bodyLines.pop();
  const body = bodyLines.join("\n") + "\n";
  const headerFrame = await zstdCompressAsync(Buffer.from(header, "utf8"), ZSTD_CHECKSUM_OPTIONS);
  const eventFrame = await zstdCompressAsync(Buffer.from(body, "utf8"), ZSTD_CHECKSUM_OPTIONS);
  return Buffer.concat([headerFrame, eventFrame]);
}

/**
 * 扫描并修复全部损坏的冷会话日志。
 * @param ctx - 插件上下文（需 sessionPersistence / sessions 服务）。
 * @param options.dryRun - 只扫描不写盘。
 * @returns {scanned, corrupt, fixed, backups, skippedLive, errors, sessions: [{id, problems, fixed, backup?}]}
 */
export async function repairCorruptSessions(ctx, { dryRun = false } = {}) {
  const persistence = ctx.get("sessionPersistence");
  if (!persistence?.listArtifacts || !persistence?.readRaw) {
    return { error: "sessionPersistence 服务不可用（无 listArtifacts/readRaw）" };
  }
  const sessionsSvc = ctx.get("sessions");
  const liveIds = new Set((sessionsSvc?.list() ?? []).map((s) => s.id));

  let artifacts = [];
  try {
    artifacts = await persistence.listArtifacts();
  } catch (error) {
    return { error: `读取会话清单失败: ${String(error?.message ?? error)}` };
  }

  const report = { scanned: artifacts.length, corrupt: 0, fixed: 0, backups: [], skippedLive: 0, errors: [], sessions: [] };

  for (const artifact of artifacts) {
    const id = artifact.header?.id;
    if (typeof id !== "string") continue;
    if (liveIds.has(id)) {
      report.skippedLive += 1;
      continue; // live 会话正在被写入，跳过（也不该在扫描时改）
    }
    let raw;
    try {
      raw = await persistence.readRaw(id);
    } catch (error) {
      report.errors.push({ id, error: String(error?.message ?? error) });
      continue;
    }
    if (raw === void 0 || typeof raw.content !== "string") continue;
    const validated = validateSessionText(raw.content);
    if (validated.ok) continue; // 健康会话

    report.corrupt += 1;
    const entry = { id, problems: validated.problems.slice(0, 5) };
    if (dryRun || artifact.path === void 0) {
      report.sessions.push(entry);
      continue;
    }

    try {
      const { fixed, fixedCount } = fixToolResultStringContent(raw.content);
      const revalidated = validateSessionText(fixed);
      if (!revalidated.ok) {
        entry.error = `修复后仍不通过：${revalidated.problems.slice(0, 3).join("；")}`;
        report.errors.push(entry);
        report.sessions.push(entry);
        continue;
      }
      const encoded = await encodeSessionText(fixed);
      // 原子写回：备份 → tmp → rename → fsync 目录
      const dir = dirname(artifact.path);
      const backupPath = join(dir, `session.jsonl.zstd.bak-corrupt`);
      try {
        await fsp.copyFile(artifact.path, backupPath);
      } catch {
        // 备份失败不阻断（尽力而为）
      }
      const tmpPath = join(dir, `session.jsonl.zstd.${Date.now()}.repair.tmp`);
      const handle = await fsp.open(tmpPath, "wx", 0o600);
      try {
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmpPath, artifact.path);
      try {
        const dhandle = await fsp.open(dir, "r");
        try { await dhandle.sync(); } finally { await dhandle.close(); }
      } catch {
        // 目录 fsync 尽力而为
      }
      report.fixed += 1;
      report.backups.push(backupPath);
      report.sessions.push({ ...entry, fixedBlocks: fixedCount, backup: backupPath });
      try { ctx.logger?.info?.(`dsh-session-conductor: 已修复会话 ${id}（${fixedCount} 个块）`); } catch {}
    } catch (error) {
      report.errors.push({ id, error: `修复失败: ${String(error?.message ?? error)}` });
      report.sessions.push(entry);
    }
  }
  return report;
}

/** 列出损坏会话（不修复，供扫描预览）。 */
export async function scanCorruptSessions(ctx) {
  return repairCorruptSessions(ctx, { dryRun: true });
}

/** 当前文件是否为 jsonl 后端（支持 listArtifacts/readRaw）。 */
export function supportsRepair(ctx) {
  const persistence = ctx.get("sessionPersistence");
  return persistence !== void 0 && typeof persistence?.listArtifacts === "function" && typeof persistence?.readRaw === "function";
}

// ==================== zstd 帧修复（救援恢复完善，2026-08-19） ====================
// 场景：会话日志被单帧压缩/坏帧 → "corrupt Zstandard session log" → 会话列表消失。
// 与上面的 tool-result 修复互补：那个修 content 结构，这个修 zstd 帧格式。

/** 会话根目录（DSH_HOME 感知，主/测试实例通用）。 */
function sessionsRootOf() {
  const dshHome = process.env.DSH_HOME || join(process.env.HOME ?? "", ".dsh");
  return join(dshHome, "sessions");
}

/**
 * 扫描全部会话的 zstd 帧损坏（不修复）。
 * @returns {Promise<{ok, corrupt:[{path,id,error}], healthy, total}>}
 */
export async function scanCorruptFrames() {
  return scanAllCorruptFrames(sessionsRootOf());
}

/**
 * 修复全部帧损坏的会话（自动备份到各会话目录 .zstd-fix-backup/）。
 * @param options.dryRun 只扫描不写盘
 * @returns {Promise<{scanned, corrupt, fixed, failed, fixedIds, errors}>}
 */
export async function repairCorruptFrames({ dryRun = false } = {}) {
  const root = sessionsRootOf();
  const scan = await scanAllCorruptFrames(root);
  const report = {
    root,
    scanned: scan.total,
    healthy: scan.healthy,
    corrupt: scan.corrupt.length,
    fixed: 0,
    failed: 0,
    fixedIds: [],
    errors: [],
    corruptList: scan.corrupt.map((c) => ({ id: c.id, error: c.error })),
  };
  if (dryRun) return report;
  for (const c of scan.corrupt) {
    try {
      const r = await fixZstdFile(c.path);
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

// ==================== 双格式会话修复 ====================
// 场景：同一会话目录同时存在 session.jsonl（明文）+ session.jsonl.zstd（压缩）——
// 官方 session-persistence-jsonl 的 listArtifacts() 对每个会话目录检查 opposite 压缩
// 文件，并存即抛 encodingMismatch → 整个会话列表失败 → 侧边栏会话全消失。
// 此时所有依赖 listArtifacts 的 repair-*（repair-sessions/frames/seq-gap/eio）都无法
// 运行（连列表都列不出），必须**旁路 persistence、直接遍历磁盘目录**才能发现并修复。
// 修复策略：把多余的明文 session.jsonl 移入同目录 .dual-format-backup/（保留 zstd 官方
// 格式，不删数据，与既有 .bak-corrupt / .eio-backup 风格一致），幂等可重复执行。

/** 扫描出「双格式」会话目录（encodingMismatch 风险项）。
 *  纯磁盘遍历，不依赖 sessionPersistence（后者自身会被 encodingMismatch 阻断）。
 *  @returns {Promise<{root, scanned, dual:[{id, dir, plainBytes, zstdBytes}], errors}>}
 */
export async function scanDualFormatSessions() {
  const root = sessionsRootOf();
  const report = { root, scanned: 0, dual: [], errors: [] };
  if (!root || !existsSync(root)) return { ...report, error: `sessions 目录不存在: ${root}` };
  for (const proj of readdirSync(root)) {
    const projectDir = join(root, proj);
    let st;
    try { st = statSync(projectDir); } catch { continue; }
    if (!st.isDirectory()) continue; // 跳过顶层符号链接/普通文件
    let sessions;
    try { sessions = readdirSync(projectDir); } catch { continue; }
    for (const sess of sessions) {
      const sessionDir = join(projectDir, sess);
      let sst;
      try { sst = statSync(sessionDir); } catch { continue; }
      if (!sst.isDirectory()) continue;
      report.scanned += 1;
      // 兼容 v3/v4 命名：明文 session.jsonl / session.v4.jsonl；压缩日志由 findSessionLog 定位
      const plain = ["session.jsonl", "session.v4.jsonl"]
        .map((n) => join(sessionDir, n))
        .find((p) => existsSync(p)) ?? null;
      const zstd = findSessionLog(sessionDir);
      if (!plain || !zstd) continue;
      let plainBytes = 0, zstdBytes = 0;
      try { plainBytes = statSync(plain).size; } catch {}
      try { zstdBytes = statSync(zstd).size; } catch {}
      report.dual.push({ id: sess, dir: sessionDir, plainBytes, zstdBytes });
    }
  }
  return report;
}

/**
 * 修复双格式会话：把多余的明文 session.jsonl 移入 .dual-format-backup/，保留 zstd。
 * @param options.dryRun 只扫描不写盘
 * @param options.skipIds 要跳过的会话 id（live 会话，避免边写边移）
 * @returns {Promise<{root, scanned, dual, fixed, skipped, backups, errors}>}
 */
export async function repairDualFormatSessions({ dryRun = false, skipIds = [] } = {}) {
  const root = sessionsRootOf();
  const report = { root, scanned: 0, dual: 0, fixed: 0, skipped: 0, backups: [], errors: [] };
  const scan = await scanDualFormatSessions();
  if (scan.error) return { ...report, error: scan.error };
  report.scanned = scan.scanned;
  report.dual = scan.dual.length;
  for (const entry of scan.dual) {
    const id = entry.id;
    if (skipIds.includes(id)) {
      report.skipped += 1;
      continue;
    }
    if (dryRun) continue;
    try {
      const backupDir = join(entry.dir, ".dual-format-backup");
      mkdirSync(backupDir, { recursive: true });
      const target = join(backupDir, "session.jsonl");
      if (existsSync(target)) {
        // 备份已存在（上次修复残留）：覆盖前先校验两者内容一致，绝不损坏原数据
        try {
          const existing = readFileSync(target, "utf8");
          const incoming = readFileSync(join(entry.dir, "session.jsonl"), "utf8");
          if (existing !== incoming) {
            report.errors.push({ id, error: `备份目录已存在不同内容的 session.jsonl（${target}），跳过以免覆盖` });
            continue;
          }
        } catch (e) {
          report.errors.push({ id, error: `备份校验失败: ${String(e?.message ?? e)}，跳过` });
          continue;
        }
      }
      renameSync(join(entry.dir, "session.jsonl"), target);
      report.fixed += 1;
      report.backups.push(target);
    } catch (e) {
      report.errors.push({ id, error: `修复失败: ${String(e?.message ?? e)}` });
    }
  }
  return report;
}
