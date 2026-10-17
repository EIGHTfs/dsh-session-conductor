// 会话回收站：删除只打标记，文件原样保留；到期或手动清空才真正删盘。
//
// 【为什么这么设计】删除是不可逆操作，而会话日志动辄几十 MB。把「删除」降级为
// 「在索引里打一个标记」，就同时得到三件事：
//   ① 还原是秒级且零风险（文件从没动过）；
//   ② 误删可撤销（按批次整批还原）；
//   ③ 真正删盘集中在两个可控时机 —— 到期（保留天数可配，默认 7 天）或一键清空。
//
// 【落盘】<DSH_HOME>/storages/dsh-session-conductor/trash.json，原子写（tmp + rename）。
//   条目：{ [sessionId]: { deletedAt, batchId, title, cwd, updatedAt, archived } }
//   不存在/损坏都按「空回收站」处理，绝不影响列表与删除本身。

import { cfg } from "../core/config.js";
import { getSection, setSection, saveStoreNow } from "../core/index-store.js";

const TRASH_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;
const DAY_MS = 24 * 3600 * 1000;

let trashCache = null;

/** 读回收站（进程内只读一次；索引不可用按空处理）。
 *  落盘统一走 <DSH_HOME>/storages/dsh-session-conductor/index.json 的 trash section。 */
export function loadTrash(ctx) {
  if (trashCache !== null) return trashCache;
  trashCache = { version: TRASH_VERSION, entries: {} };
  try {
    const section = getSection(ctx, "trash");
    if (section?.entries && typeof section.entries === "object") {
      trashCache = { version: TRASH_VERSION, entries: section.entries };
      if (Number.isFinite(section.retentionDays)) trashCache.retentionDays = section.retentionDays;
    }
  } catch {
    // 索引不可用：按空回收站继续
  }
  return trashCache;
}

/** 立即落盘（交给统一索引存储做原子写）。失败只丢内存态，不抛。 */
export function saveTrashNow(ctx) {
  if (trashCache === null) return;
  try {
    setSection(ctx, "trash", {
      entries: trashCache.entries,
      ...(Number.isFinite(trashCache.retentionDays) ? { retentionDays: trashCache.retentionDays } : {}),
    });
    saveStoreNow(ctx);
  } catch {
    // 写盘失败：下次再试，不影响「已标记」的内存态
  }
}

/**
 * 保留天数：**优先取回收站文件里存的值**（面板上改的就是它），
 * 没设置过才回落到配置 trashRetentionDays / 默认 7 天。范围 1~365。
 */
export function retentionDays(ctx) {
  const stored = ctx ? Number(loadTrash(ctx).retentionDays) : NaN;
  if (Number.isFinite(stored) && stored >= 1) return Math.min(MAX_RETENTION_DAYS, Math.round(stored));
  const days = Number(cfg?.trashRetentionDays);
  if (!Number.isFinite(days) || days < 1) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.round(days));
}

/** 设置保留天数（写回收站文件，立即生效）。 */
export function setRetentionDays(ctx, days) {
  const value = Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(Number(days) || DEFAULT_RETENTION_DAYS)));
  const trash = loadTrash(ctx);
  trash.retentionDays = value;
  saveTrashNow(ctx);
  return value;
}

/** 当前被标记删除的会话 id 集合（列表/搜索据此隐藏）。 */
export function trashedIds(ctx) {
  return new Set(Object.keys(loadTrash(ctx).entries));
}

/** 单个会话是否在回收站里。 */
export function isTrashed(ctx, sessionId) {
  return typeof sessionId === "string" && sessionId !== "" && sessionId in loadTrash(ctx).entries;
}

/**
 * 回收站列表（按删除时间倒序），附带到期时间与剩余天数。
 * @returns {Array<{sessionId,title,cwd,updatedAt,archived,deletedAt,batchId,expiresAt,remainingDays}>}
 */
export function listTrash(ctx) {
  const ttl = retentionDays(ctx) * DAY_MS;
  const now = Date.now();
  return Object.entries(loadTrash(ctx).entries)
    .map(([sessionId, entry]) => {
      const deletedAt = typeof entry?.deletedAt === "number" ? entry.deletedAt : 0;
      const expiresAt = deletedAt + ttl;
      return {
        sessionId,
        title: entry?.title ?? null,
        cwd: entry?.cwd ?? null,
        updatedAt: entry?.updatedAt ?? null,
        archived: entry?.archived === true,
        deletedAt,
        batchId: entry?.batchId ?? "",
        expiresAt,
        remainingDays: Math.max(0, Math.ceil((expiresAt - now) / DAY_MS)),
      };
    })
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

/** 生成一个批次号（一次删除操作 = 一个批次，撤销按批次整批还原）。 */
export function newBatchId() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 标记删除（不碰文件）。
 * @param {object} ctx
 * @param {Array<string>} sessionIds
 * @param {object} [metaById] 会话快照（title/cwd/updatedAt/archived），用于回收站列表展示
 * @param {string} [batchId] 指定批次（批量删除传同一个）
 * @returns {{batchId:string, marked:string[]}}
 */
export function markDeleted(ctx, sessionIds, metaById = {}, batchId = newBatchId()) {
  const trash = loadTrash(ctx);
  const marked = [];
  const now = Date.now();
  for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
    if (typeof id !== "string" || id === "") continue;
    const meta = metaById?.[id] ?? {};
    trash.entries[id] = {
      deletedAt: now,
      batchId,
      title: meta.title ?? null,
      cwd: meta.cwd ?? null,
      updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : null,
      archived: meta.archived === true,
    };
    marked.push(id);
  }
  if (marked.length > 0) saveTrashNow(ctx);
  return { batchId, marked };
}

/**
 * 还原指定会话（删标记，文件本来就在）。
 * @returns {{restored:string[], missing:string[]}}
 */
export function restoreSessions(ctx, sessionIds) {
  const trash = loadTrash(ctx);
  const restored = [];
  const missing = [];
  for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
    if (typeof id !== "string" || id === "") continue;
    if (id in trash.entries) {
      delete trash.entries[id];
      restored.push(id);
    } else {
      missing.push(id);
    }
  }
  if (restored.length > 0) saveTrashNow(ctx);
  return { restored, missing };
}

/** 最近一个批次（撤销用）。空回收站返回 null。 */
export function latestBatch(ctx) {
  const entries = Object.entries(loadTrash(ctx).entries);
  if (entries.length === 0) return null;
  let best = null;
  for (const [sessionId, entry] of entries) {
    const at = typeof entry?.deletedAt === "number" ? entry.deletedAt : 0;
    if (best === null || at > best.deletedAt) {
      best = { sessionId, deletedAt: at, batchId: entry?.batchId ?? "" };
    }
  }
  if (best === null) return null;
  const ids = entries.filter(([, e]) => (e?.batchId ?? "") === best.batchId).map(([id]) => id);
  return { batchId: best.batchId, deletedAt: best.deletedAt, ids };
}

/** 已到期（超过保留天数）的会话 id。 */
export function expiredIds(ctx, now = Date.now()) {
  const ttl = retentionDays(ctx) * DAY_MS;
  return Object.entries(loadTrash(ctx).entries)
    .filter(([, entry]) => {
      const at = typeof entry?.deletedAt === "number" ? entry.deletedAt : 0;
      return at > 0 && now - at >= ttl;
    })
    .map(([id]) => id);
}

/** 从回收站移除条目（真删完成后调用；不落盘，由调用方统一保存）。 */
export function forgetTrashed(ctx, sessionIds) {
  const trash = loadTrash(ctx);
  let removed = 0;
  for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
    if (id in trash.entries) { delete trash.entries[id]; removed += 1; }
  }
  return removed;
}

/** 测试钩子：清空内存态。 */
export function resetTrashForTest() {
  trashCache = null;
}
