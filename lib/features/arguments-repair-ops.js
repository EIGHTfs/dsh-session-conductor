// dsh-session-conductor — 会话级「tool-call.arguments 形态修复」执行层
//
// 【职责分工】纯逻辑在 `sessions/arguments-repair.js`（识别 + 改值 + 明细）；
// 本文件负责读写落盘：定位日志 → 解码 → 修复 → 校验 → detach → 备份 → 原子写回 → 清投影缓存。
// 与撤销/截断共用同一套写回口径，避免出现「三种能力三种写法」。
//
// 【为什么必须清投影缓存】宿主启动时会用 projcache 里的投影结果；改了日志却不清缓存，
// 界面仍是旧投影（更糟的是旧投影里存着失败标记，会话照样打不开）。
//
// 【为什么先 detach】会话若还挂在内存里，协调器会把旧事件 flush 回文件，
// 把刚修好的内容盖掉。detach 之后写盘才是最终态。

import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { lazyRepair, lazyZstd } from "../core/lazy.js";
import { detachSessionAgent } from "../sessions/detach.js";
import { replaceFileSync } from "../shared/atomic-file.js";
import { findToolCallArgumentIssues, repairToolCallArguments } from "../sessions/arguments-repair.js";
import { clearProjcacheForSession, locateSessionLogFile } from "./session-ops.js";
import { sessionsRootOf } from "../sessions/events.js";
import { readdirSync, existsSync } from "node:fs";

/** 备份目录名：与撤销共用 `.undo-backup`，便于统一清理。 */
const BACKUP_DIR_NAME = ".undo-backup";

/**
 * 修一个会话的 `tool-call.arguments` 形态。
 *
 * @param {object} ctx 插件 context
 * @param {string} sessionId 会话 id（允许省略 `session-` 前缀由调用方归一）
 * @param {{session?: object, dryRun?: boolean}} [opts] session 传入宿主 live 会话对象可省一次解码
 * @returns {Promise<object>} 报告：{ok, sessionId, fixedCount, issues, fixes, skipped, backup?, dryRun?}
 */
export async function repairSessionArguments(ctx, sessionId, opts = {}) {
  const { dryRun = false } = opts;
  const filePath = await locateSessionLogFile(ctx, sessionId);
  if (!filePath) return { ok: false, sessionId, error: { code: "not-found", message: "会话日志不存在" } };

  let text;
  try {
    const { decodeAllFrames } = await lazyZstd();
    text = await decodeAllFrames(readFileSync(filePath));
  } catch (error) {
    return { ok: false, sessionId, error: { code: "decode-failed", message: `会话日志解码失败: ${String(error?.message ?? error)}` } };
  }

  const lines = String(text).split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) return { ok: false, sessionId, error: { code: "empty", message: "会话日志没有事件" } };
  const header = lines[0];
  const events = [];
  for (let i = 1; i < lines.length; i += 1) {
    try { events.push(JSON.parse(lines[i])); } catch { /* 坏行跳过：不属于本能力范围 */ }
  }

  // 先只读摸底：没有坏块就不再往下走（幂等，可重复调用）
  const issues = findToolCallArgumentIssues(events);
  if (issues.length === 0) {
    return { ok: true, sessionId, dryRun, fixedCount: 0, issues: [], fixes: [], skipped: [], note: "没有需要修复的 arguments" };
  }

  const { events: repaired, fixes, skipped } = repairToolCallArguments(events);
  if (fixes.length === 0) {
    return {
      ok: false, sessionId, dryRun, fixedCount: 0, issues: issues.length, fixes, skipped,
      error: { code: "unrepairable", message: "发现坏块但没有一处能自动序列化，需人工确认" },
    };
  }

  const newText = [header, ...repaired.map((event) => JSON.stringify(event))].join("\n") + "\n";
  const { validateSessionText } = await lazyRepair();
  const check = validateSessionText(newText);
  if (!check.ok) {
    return {
      ok: false, sessionId, dryRun, fixedCount: fixes.length, issues: issues.length, fixes, skipped,
      error: { code: "invalid-after-repair", message: `修复后日志校验失败: ${check.problems?.[0] ?? "未知"}` },
    };
  }

  const report = {
    ok: true, sessionId, dryRun,
    fixedCount: fixes.length,
    issues: issues.length,
    skipped,
    fixes: fixes.slice(0, 20),
    eventCount: check.eventCount,
    file: filePath,
  };
  if (dryRun) return report;

  // 落盘：detach → 备份 → 原子写 → 清投影缓存
  const live = ctx.get?.("sessions")?.get?.(sessionId);
  if (live) {
    const detached = await detachSessionAgent(ctx, sessionId);
    if (!detached?.ok) {
      return { ...report, ok: false, error: { code: "detach-failed", message: String(detached?.error?.message ?? "detach 失败") } };
    }
  }

  const backupDir = path.join(path.dirname(filePath), BACKUP_DIR_NAME);
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `${Date.now()}-arguments-${sessionId}.zstd`);
  copyFileSync(filePath, backup);

  const { encodeSessionText } = await lazyRepair();
  replaceFileSync(filePath, await encodeSessionText(newText), { tmpSuffix: ".argfixtmp" });
  const projcacheCleared = clearProjcacheForSession(sessionId);

  return { ...report, backup, projcacheCleared };
}

/**
 * 扫全部会话、只挑出有坏块的（**只读**，不写盘）。
 *
 * 【为什么单独给一个扫描】坏块通常来自某个适配器的写法，一次可能留下多条会话；
 * 先给一份「哪些会话、各几处」的清单，再决定批量修还是逐个修。
 *
 * @param {object} ctx 插件 context
 * @param {{limitBytes?: number}} [opts] limitBytes 超过该大小的文件跳过（默认 32 MB，避免拖住事件循环）
 * @returns {Promise<{scanned: number, skipped: number, dirty: Array<object>}>}
 */
export async function scanArgumentIssues(ctx, opts = {}) {
  const limitBytes = opts.limitBytes ?? 32 * 1024 * 1024;
  const root = sessionsRootOf();
  const { decodeAllFrames } = await lazyZstd();
  const dirty = [];
  let scanned = 0;
  let skipped = 0;
  const entries = [];
  for (const group of readdirSync(root)) {
    let names;
    try { names = readdirSync(path.join(root, group)); } catch { continue; }
    for (const name of names) {
      const file = path.join(root, group, name, "session.v4.jsonl.zstd");
      if (!existsSync(file)) continue;
      entries.push({ id: name, file });
    }
  }
  for (const entry of entries) {
    let events;
    try {
      const raw = readFileSync(entry.file);
      if (raw.length > limitBytes) { skipped += 1; continue; }
      const text = await decodeAllFrames(raw);
      events = text.split("\n").filter((line) => line.trim() !== "").slice(1)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch { skipped += 1; continue; }
    scanned += 1;
    const issues = findToolCallArgumentIssues(events);
    if (issues.length === 0) continue;
    const providers = [...new Set(events.filter((event) => event.type === "request/header")
      .map((event) => `${event.data?.header?.config?.provider}/${event.data?.header?.config?.model}`))];
    dirty.push({
      sessionId: entry.id,
      issueCount: issues.length,
      providers,
      firstSeqs: [...new Set(issues.map((issue) => issue.seq))].slice(0, 5),
      shapes: [...new Set(issues.map((issue) => issue.shape))],
    });
  }
  return { scanned, skipped, dirty };
}
