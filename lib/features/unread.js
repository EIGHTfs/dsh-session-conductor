// 未读标记：告诉用户「这条对话在我上次看之后又动过」。
//
// 【为什么记 readAt 时间戳，而不是一个 unread 布尔位】
//   布尔位必须有人负责在「产生新活动」时把它置 true —— 那就得挂 session/event 钩子，
//   还得判断「用户此刻打开的是哪一条会话」，判定源越多越容易漏（流式输出、子代理、
//   宿主后台续跑都会产生事件）。改成「记一个已读时间点」后，未读是一次纯比较：
//
//       unread(session) === (session.updatedAt ?? 0) > max(entries[id] ?? 0, allReadAt ?? 0)
//
//   不需要任何事件钩子、不需要知道当前会话，面板拿到列表就能自己算；也不会出现
//   「置了 true 却忘了复位」的经典漏点。
//
// 【落盘】<DSH_HOME>/storages/dsh-session-conductor/index.json 的 unread section：
//   { entries: { [sessionId]: <已读到的 epoch ms> }, allReadAt: <一次性全部已读的时刻> }
//   属于**插件私有派生数据**（不是用户可见设置），因此进 index.json 而不进持久化域 ——
//   域里只放跨会话的设置项，派生数据进域会让「清空域」误伤用户配置。

import { getSection, setSection, saveStoreNow } from "../core/index-store.js";

const UNREAD_VERSION = 1;

let unreadCache = null;

/**
 * 读未读标记（进程内只读一次；索引不可用时按「全部已读」处理）。
 * 索引坏掉时宁可静默退回全已读，也不要让面板因为一个装饰性小圆点而白屏。
 * @param {object} ctx 插件 ctx
 * @returns {{version:number, entries:Record<string,number>, allReadAt:number}}
 */
export function loadUnread(ctx) {
  if (unreadCache !== null) return unreadCache;
  unreadCache = { version: UNREAD_VERSION, entries: {}, allReadAt: 0 };
  try {
    const section = getSection(ctx, "unread");
    const rawEntries = section?.entries && typeof section.entries === "object" ? section.entries : {};
    // 只收「正整数时间戳」：坏值（null / "abc" / 负数）按「没记过」处理，
    // 结果是这条会话显示成未读 —— 宁可多点一个点，也不要静默吞掉真实的新活动。
    const entries = {};
    for (const id of Object.keys(rawEntries)) {
      const at = Number(rawEntries[id]);
      if (typeof id === "string" && id !== "" && Number.isFinite(at) && at > 0) entries[id] = at;
    }
    unreadCache.entries = entries;
    const allReadAt = Number(section?.allReadAt);
    if (Number.isFinite(allReadAt) && allReadAt > 0) unreadCache.allReadAt = allReadAt;
  } catch {
    // 索引不可用：按全已读继续（面板不显示任何未读点）
  }
  return unreadCache;
}

/** 立即落盘（交给统一索引存储做原子写）。失败只丢内存态，不抛。 */
export function saveUnreadNow(ctx) {
  if (unreadCache === null) return;
  try {
    // 空 section 不写盘，避免给从没用过未读的用户造出一个空对象
    const ids = Object.keys(unreadCache.entries);
    if (ids.length === 0 && !(unreadCache.allReadAt > 0)) return;
    setSection(ctx, "unread", { entries: unreadCache.entries, allReadAt: unreadCache.allReadAt });
    saveStoreNow(ctx);
  } catch {
    // 写盘失败：下次再试，不影响本次内存态（用户这一屏仍然对）
  }
}

/** 某个会话实际生效的「已读到」时间点（0 = 从没读过）。 */
export function readAtOf(ctx, sessionId) {
  const unread = loadUnread(ctx);
  const own = Number(unread.entries?.[sessionId]);
  const all = Number(unread.allReadAt);
  const ownOk = Number.isFinite(own) && own > 0 ? own : 0;
  const allOk = Number.isFinite(all) && all > 0 ? all : 0;
  return Math.max(ownOk, allOk);
}

/**
 * 会话当前是否未读。
 * @param {object} ctx 插件 ctx
 * @param {string} sessionId 会话 id
 * @param {number} updatedAt 会话最后活动时间（epoch ms，取自列表项的 updatedAt）
 * @returns {boolean}
 */
export function isUnread(ctx, sessionId, updatedAt) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const at = Number(updatedAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return at > readAtOf(ctx, sessionId);
}

/**
 * 标记「已读到现在」。
 * @param {object} ctx 插件 ctx
 * @param {string} sessionId 会话 id
 * @param {number} [at] 已读时刻，默认此刻；传会话的 updatedAt 可避免把「标记瞬间刚产生的新事件」也算已读
 * @returns {boolean} 是否真的改动了状态
 */
export function markRead(ctx, sessionId, at = Date.now()) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) return false;
  const unread = loadUnread(ctx);
  if ((unread.entries?.[sessionId] ?? 0) >= when) return false;
  unread.entries[sessionId] = when;
  saveUnreadNow(ctx);
  return true;
}

/** 手动标未读：删掉该会话的已读时间点（回落 allReadAt 仍算已读，这是刻意的）。 */
export function markUnread(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const unread = loadUnread(ctx);
  if (!(sessionId in unread.entries)) return false;
  delete unread.entries[sessionId];
  saveUnreadNow(ctx);
  return true;
}

/** 全部标为已读到此刻（一次性清空所有未读点）。 */
export function markAllRead(ctx, at = Date.now()) {
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) return false;
  const unread = loadUnread(ctx);
  unread.allReadAt = Math.max(Number(unread.allReadAt) || 0, when);
  unread.entries = {};
  saveUnreadNow(ctx);
  return true;
}

/** 给面板/路由用的快照（浅拷贝，调用方改不动缓存）。 */
export function unreadSnapshot(ctx) {
  const unread = loadUnread(ctx);
  return { entries: { ...unread.entries }, allReadAt: Number(unread.allReadAt) || 0 };
}

/** 测试钩子：清空内存态（单测场景之间调用）。 */
export function resetUnreadForTest() {
  unreadCache = null;
}
