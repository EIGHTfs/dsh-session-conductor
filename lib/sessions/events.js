// dsh-session-conductor — 会话事件流读取
//
// 【为什么单独成文件】「拿到一个会话的事件流」是列表、续跑、重命名、搜索、撤回的共同前置：
// live 会话走内存快照，冷会话走官方 persistence.open(id,"read") 读法。
// 集中在此避免各域各写一份（历史上冷会话读法变更过多次：inspect 失效 → open/read）。

import { interruptedTurnClosers } from "@deepseek-ai/dsh-session";

/**
 * 该子会话是否归属 API remote（不该被插件当普通会话处理）。
 * 等价判定：header.origin==="subagent"，或 parent live agent 拥有该 child（agents.isOwnedBy）。
 */
export function hasApiRemoteSubagentOwner(ctx, session, agent) {
  const header = session?.header ?? session;
  if (header?.origin === "subagent") return true;
  const parentId = header?.parentSession;
  if (!parentId || !agent) return false;
  try {
    const agents = ctx.get?.("agents") ?? ctx.agents;
    const parent = agents?.get?.(parentId);
    return Boolean(parent && agents?.isOwnedBy?.(agent.id, parent));
  } catch {
    return false;
  }
}

/** live Session 的 events 可能不是数组，优先 snapshotEvents()。 */
export function sessionEventList(session) {
  if (Array.isArray(session?.events)) return session.events;
  try {
    const snap = session?.snapshotEvents?.();
    if (Array.isArray(snap)) return snap;
  } catch {
    // 非 Session 对象
  }
  return [];
}

/** 读取一个会话的事件流（live 用内存快照，cold 用官方 handle 读法）。 */
export async function sessionEventsOf(ctx, sessionId) {
  const sessions = ctx.get("sessions");
  const live = sessions?.get(sessionId);
  if (live) return { live, events: sessionEventList(live), meta: live.header };
  try {
    return await readColdSessionEvents(ctx, sessionId);
  } catch {
    // 损坏/不可读 → 返回 null，调用方跳过不中断整体
    return null;
  }
}

/**
 * 读一个冷（已持久化）会话的完整事件流（官方 0.1.6 标准读法）：
 * persistence.open(id, "read") → handle.read(0) → close。
 * ⚠️ 0.1.6-alpha.1 起 persistence.inspect 已失效（返回空），冷会话标题/搜索内容
 *    全靠本函数；与 session-query 的 readColdSessionLog 同一姿势，并补中断闭合器。
 * 读取失败**向上抛**（buildSessionList 用它带出 inspectError）；仅「无 open 能力」返回 null。
 * @returns {{events:Array, meta:object|null}}
 */
export async function readColdSessionEvents(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  if (!persistence?.open) return null;
  const handle = await persistence.open(sessionId, "read");
  let events = [];
  try {
    const read = await handle.read(0, undefined);
    events = read?.events ?? [];
  } finally {
    try { await handle.close(); } catch { /* 读失败时 close 失败无妨 */ }
  }
  // 崩溃残留的开放回合补合成闭合器（与官方 cold-read 一致，列表中断判定需要）
  return { events: [...events, ...interruptedTurnClosers(events)], meta: handle?.header ?? null };
}
