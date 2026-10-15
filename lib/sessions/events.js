// dsh-session-conductor — 会话事件流读取
//
// 【为什么单独成文件】「拿到一个会话的事件流」是列表、续跑、重命名、搜索、撤回的共同前置：
// live 会话走内存快照，冷会话走官方 persistence.open(id,"read") 读法。
// 集中在此避免各域各写一份（历史上冷会话读法变更过多次：inspect 失效 → open/read）。
//
// 【已知限制·宿主 API 不能流式读】官方 `handle.read(offset, length)` 的 offset/length 只是
// **内存数组切片**：后端每次调用都会 `readStoredLog(path)` 把**整份日志读进来解压**
// （见 packages/session/session-persistence-jsonl/src/storage.ts 的 readCurrent）。因此：
//   · 分块调用**不会**降低内存峰值，反而变成「N 次全量解压」（O(n²) 耗时）——**不要分块读**；
//   · 想真正把单会话内存压到 KB 级，只能绕过 handle：直接按 zstd 帧解码日志文件
//     （多帧格式每帧可独立解压，本仓库 lib/zstd-frames.js 已具备该能力）。
// 当前策略是「**读一次就别再读**」：靠列表磁盘缓存（revision 命中即跳过解析）把
// 重复解析降到 0，从而把 OOM 风险压掉。

// 宿主包**懒加载**：顶层 `import` 会让本文件在「工作区自测」环境直接解析失败
// （仓库里踩过同类坑），而 events.js 是最需要被单测覆盖的模块之一（冷会话读法）。
// 这里改成顶层 await import + 兜底：没有宿主依赖时退化为「不加闭合器」，其余逻辑照常可测。
let interruptedTurnClosers = null;
try {
  const hostSession = await import("@deepseek-ai/dsh-session");
  if (typeof hostSession?.interruptedTurnClosers === "function") {
    interruptedTurnClosers = hostSession.interruptedTurnClosers;
  }
} catch {
  // 无宿主依赖（工作区自测）：保持 null，调用点会跳过「补闭合器」这一步
}

/** 需要时补官方中断闭合器；宿主包不可用时原样返回（不阻断列表）。 */
function withInterruptedClosers(events) {
  if (typeof interruptedTurnClosers !== "function" || events.length === 0) return events;
  try {
    return [...events, ...interruptedTurnClosers(events)];
  } catch {
    return events;
  }
}

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
 * 读一个冷（已持久化）会话的完整事件流（官方标准读法）：
 * `persistence.open(id,"read")` → `handle.read(0)` → `close`，并补官方中断闭合器。
 *
 * ⚠️ **这是全量读**，也是宿主 API 目前唯一能给的读法（见文件头「宿主 API 不能流式读」）：
 * 整份日志会变成 events 数组驻留内存 —— 本机实测最大会话 49.2 MB 压缩 → 173.3 MB 解压
 * （另一份 39.9 → 197.9 MB，膨胀 3.2~5.0×）。因此**必须避免重复解析**：
 * 列表侧靠磁盘缓存（revision 命中即跳过）；不要为了「省内存」改成多次 read
 * （那只会变成 N 次全量解压，内存峰值不变、耗时变 O(n²)）。
 *
 * 读取失败**向上抛**（buildSessionList 用它带出 inspectError）；仅「无 open 能力」返回 null。
 * @returns {Promise<{events:Array, meta:object|null}|null>}
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
  return { events: withInterruptedClosers(events), meta: handle?.header ?? null };
}
