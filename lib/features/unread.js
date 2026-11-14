// dsh-session-conductor — 未读标记
//
// 【为什么记「读到哪个时刻」而不是一个 unread 布尔位】
// 布尔位必须在「产生新活动」时置 true —— 那就要挂 session/event 钩子，还得判断用户此刻
// 打开的是哪条会话。流式输出、子代理、宿主后台续跑都会产生事件，判定源越多越容易漏，
// 而且必然出现「置了 true 却忘了复位」的经典漏点。
// 改成记一个已读时间点后，未读是纯比较：
//
//   未读(session) === session.updatedAt > max(entries[id] ?? 0, allReadAt ?? 0)
//
// 不需要事件钩子、不需要知道当前会话，面板拿到列表就能自己算。
//
// 【落盘位置】`<DSH_HOME>/storages/dsh-session-conductor/index.json` 的 unread section：
//   { entries: { [sessionId]: 已读到的 epoch ms }, allReadAt: 全部已读的水位 }
// 这属于插件私有派生数据（不是用户可见设置），因此进 index.json 而不进持久化域——
// 域里只放跨会话的设置项，派生数据进域会让「清空域」误伤用户配置。
//
// ⚠️ index-store 的 normalizeStore 是白名单重建：本 section 已在 emptyStore 与
// normalizeStore 两处登记（漏一处 = 写进去、重启就没了，且不报错）。

import { getSection, saveStoreNow, setSection } from "../core/index-store.js";

/** section 结构版本（将来形状变化时用于判断是否需要迁移）。 */
export const UNREAD_VERSION = 1;

const EMPTY_SNAPSHOT = Object.freeze({ version: UNREAD_VERSION, entries: {}, allReadAt: 0 });

/**
 * 把磁盘上读到的任意形状规整成合法快照。
 *
 * 坏值（null / "abc" / 负数 / 0）按「没记过」处理 —— 结果是这条会话显示成未读：
 * 宁可让用户多点掉一个圆点，也不要静默吞掉真实的新活动。
 *
 * @param {unknown} raw index.json 里的 unread section
 * @returns {{version: number, entries: Record<string, number>, allReadAt: number}}
 */
export function sanitizeUnread(raw) {
  const entries = {};
  const rawEntries = raw?.entries && typeof raw.entries === "object" ? raw.entries : {};
  for (const sessionId of Object.keys(rawEntries)) {
    const at = Number(rawEntries[sessionId]);
    if (!Number.isFinite(at) || at <= 0) continue;
    entries[sessionId] = Math.floor(at);
  }
  const rawAll = Number(raw?.allReadAt);
  const allReadAt = Number.isFinite(rawAll) && rawAll > 0 ? Math.floor(rawAll) : 0;
  return { version: UNREAD_VERSION, entries, allReadAt };
}

/**
 * 某条会话是否未读（纯比较，无副作用）。
 *
 * `updatedAt` 缺失或非正数时一律算「已读」：没有活动时间就谈不上"之后又动过"，
 * 宁可少显示一个圆点，也不要让整列表全是未读。
 *
 * @param {{id?: string, updatedAt?: number}} session 会话（列表项）
 * @param {{entries?: Record<string, number>, allReadAt?: number}} snapshot 未读快照
 * @returns {boolean}
 */
export function isUnread(session, snapshot) {
  const updatedAt = Number(session?.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  const id = String(session?.id ?? "");
  const readAt = Math.max(
    Number(snapshot?.entries?.[id] ?? 0) || 0,
    Number(snapshot?.allReadAt ?? 0) || 0,
  );
  return updatedAt > readAt;
}

/**
 * 读未读快照（每次从索引取，索引层自带进程内缓存）。
 * @param {object} ctx 插件 ctx
 * @returns {{version: number, entries: Record<string, number>, allReadAt: number}}
 */
export function unreadSnapshot(ctx) {
  try {
    return sanitizeUnread(getSection(ctx, "unread"));
  } catch {
    // 索引不可用时退回空快照：宁可全显示已读，也不要让面板因为装饰性圆点而白屏
    return { ...EMPTY_SNAPSHOT, entries: {} };
  }
}

/**
 * 标记单条会话「已读 / 未读」。
 *
 * 标为未读不是「置 TRUE」，而是**把已读时刻退到 0**：这样会话只要有活动就重新显示未读，
 * 且与公式语义一致（不需要第二套状态）。
 *
 * @param {object} ctx 插件 ctx
 * @param {string} sessionId 会话 id
 * @param {{read?: boolean, at?: number}} [options] read=false 表示标为未读
 * @returns {{version: number, entries: Record<string, number>, allReadAt: number}}
 */
export function markRead(ctx, sessionId, { read = true, at } = {}) {
  const id = String(sessionId ?? "").trim();
  if (id === "") return unreadSnapshot(ctx);
  const snapshot = unreadSnapshot(ctx);
  const when = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.floor(Number(at)) : Date.now();
  const entries = { ...snapshot.entries };
  if (read) entries[id] = when;
  else delete entries[id]; // 退回到「没记过」，未读状态由 updatedAt 比较自然得出
  const next = { version: UNREAD_VERSION, entries, allReadAt: snapshot.allReadAt };
  setSection(ctx, "unread", next);
  saveStoreNow(ctx);
  return next;
}

/**
 * 全部标记已读：把全局水位抬到指定时刻（默认现在）。
 * @param {object} ctx 插件 ctx
 * @param {number} [at] 水位时刻；缺省当前时间
 * @returns {{version: number, entries: Record<string, number>, allReadAt: number}}
 */
export function markAllRead(ctx, at) {
  const snapshot = unreadSnapshot(ctx);
  const when = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.floor(Number(at)) : Date.now();
  const next = { version: UNREAD_VERSION, entries: { ...snapshot.entries }, allReadAt: when };
  setSection(ctx, "unread", next);
  saveStoreNow(ctx);
  return next;
}
