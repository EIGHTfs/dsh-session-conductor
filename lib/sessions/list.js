// dsh-session-conductor — 会话列表：构建（live + 冷会话）与带缓存入口
//
// 【职责】组装面板的会话列表：live 会话直读，冷会话按 revision 命中缓存或用官方
// handle 读法解析（分片并发，避免一次性把全部日志解压进内存）；结果按最后活动时间倒序。
// 落盘缓存与列表项组装在 list-cache.js。

import { log } from "../shared/log.js";
import { cfg, DEFAULTS, autoRenameEnabled, effectiveAutoContinue } from "../core/config.js";
import { pluginState } from "../core/domain.js";
import { continueJobs } from "../core/state.js";
import { sessionEventList, readColdSessionEvents } from "./events.js";
import { hasOpenTurn, lastEventTime } from "./turn.js";
import { interruptionInfo } from "./interruption.js";
import { resolveSessionTitle, foldTitle, stripArchiveWsPrefix } from "../features/rename/title.js";
import {
  loadListDiskCache, scheduleSaveListDiskCache, saveListDiskCacheNow, buildColdSessionItem,
  peekListCache, peekListBuildInflight, registerListBuild, settleListBuild,
  markListDiskCacheDirty, isListDiskCacheDirty,
} from "./list-cache.js";

/**
 * 组装全部会话（live + 已持久化），按最后活动时间倒序。
 * opts.onItem：流式输出钩子（每构建好一条立即回调，前端逐行追加）；不传则完整返回数组。
 * opts.serial：true = 冷会话严格串行逐个解析（list 流式场景）。
 */
export async function buildSessionList(ctx, opts = {}) { // dsh-skip-func-length
  const sessions = ctx.get("sessions");
  const workspaceRegistry = ctx.get("workspaceRegistry");
  const persistence = ctx.get("sessionPersistence");
  const sessionTitle = ctx.get("sessionTitle");
  const storeState = await pluginState(ctx);

  const archived = new Set(workspaceRegistry?.archivedSessionIds ?? []);
  const items = [];
  const emit = (item) => { items.push(item); if (opts?.onItem) opts.onItem(item); };

  // live 会话
  for (const session of sessions?.list() ?? []) {
    const events = sessionEventList(session);
    const running = hasOpenTurn(events);
    const title = resolveSessionTitle(sessionTitle, session, events);
    emit({
      id: session.id,
      // 已归档会话：标题保持带前缀的原值（client 剥离显示、按前缀分组），并带 archiveWs 供分组
      title,
      archiveWs: archived.has(session.id) ? stripArchiveWsPrefix(title ?? "").ws : "",
      cwd: session.header?.cwd ?? null,
      createdAt: session.header?.createdAt,
      updatedAt: lastEventTime(events) ?? session.header?.createdAt,
      live: true,
      archived: archived.has(session.id),
      running,
      interruption: running ? null : interruptionInfo(events),
      parentSession: session.header?.parentSession ?? null,
      autoRename: autoRenameEnabled(ctx, storeState, session.id),
      autoContinue: effectiveAutoContinue(cfg, storeState, session.id),
      continueRunning: continueJobs.has(session.id)
    });
  }

  // 已持久化（未 live）会话。sessionTitle.get() 不能喂 {events} 假对象（会抛，allSettled 把整条冷会话丢掉）。
  const liveIds = new Set(items.map((item) => item.id));
  const coldById = new Map(); // id -> { meta: header, revision: string|null }
  if (persistence?.list) {
    try {
      // 优先 listSnapshots()——只读 header 行 + 一次 stat，**不解析日志**，
      // 顺带给出 revision（日志变更令牌），这是「懒加载」的判据。
      if (typeof persistence.listSnapshots === "function") {
        for (const snapshot of await persistence.listSnapshots()) {
          const header = snapshot?.header;
          if (header?.id && !liveIds.has(header.id)) {
            coldById.set(header.id, { meta: header, revision: snapshot.revision == null ? null : String(snapshot.revision) });
          }
        }
      } else {
        for (const meta of await persistence.list()) {
          if (!liveIds.has(meta.id)) coldById.set(meta.id, { meta, revision: null });
        }
      }
    } catch (error) {
      log(ctx, `sessionPersistence.list 失败（改走归档补全）: ${String(error?.message ?? error)}`);
    }
  }
  // 归档集合是权威隐藏名单：即使 persistence.list 漏扫，也按 id inspect 补进列表。
  for (const id of archived) {
    if (!liveIds.has(id) && !coldById.has(id)) coldById.set(id, { meta: { id }, revision: null });
  }
  if (coldById.size > 0) {
    const disk = loadListDiskCache(ctx);
    const needInspect = [];
    // ① 先吃缓存：revision 一致 → 直接用落盘结果，零解析零内存（懒加载核心）
    for (const [id, entry] of coldById) {
      const cached = disk.entries[id];
      if (cached && entry.revision !== null && cached.rev === entry.revision) {
        // inspected 用缓存里存的 header 派生字段（原来由 inspect 回读提供，现随缓存落盘复用）
        emit(buildColdSessionItem(entry.meta, cached, cached, ctx, storeState, archived));
        continue;
      }
      needInspect.push(entry);
    }
    // ② 只对「新会话 / 日志变过 / 无 revision」的会话解析，且按 cfg.listInspectBatch 分片：
    //    【原代码·根因】曾把全部冷会话一次性并发 inspect —— 每份日志整解压进内存，
    //    N 个会话 = N 份事件流同时驻留，实测 88 秒把 2GB 堆打满（FATAL ERROR）。
    //    现在片内并发、片间串行，每片解析完即写缓存，事件数组随片结束回收。
    const batchSize = Math.max(1, opts?.serial === true ? 1 : (cfg.listInspectBatch ?? DEFAULTS.listInspectBatch));
    for (let start = 0; start < needInspect.length; start += batchSize) {
      const batch = needInspect.slice(start, start + batchSize);
      const settled = await Promise.allSettled(batch.map(async (entry) => {
        let events = [];
        let inspectError = null;
        let inspected = entry.meta;
        try {
          // ⚠️ 0.1.6-alpha.1 起 persistence.inspect 已失效（返回空）→ 改用官方 handle 读法
          //    （open('read') → read(0) → close），与 session-query 一致。
          const loaded = persistence?.open ? await readColdSessionEvents(ctx, entry.meta.id) : null;
          events = loaded?.events ?? [];
          if (loaded?.meta) inspected = loaded.meta;
        } catch (cause) {
          // 损坏/不可读的 artifact 以无标题呈现，不影响列表；错误信息带出便于诊断
          inspectError = cause instanceof Error ? cause.message : String(cause);
        }
        const derived = {
          title: foldTitle(events) ?? null,
          updatedAt: lastEventTime(events) ?? inspected.createdAt ?? entry.meta.createdAt,
          interruption: interruptionInfo(events),
          inspectError,
        };
        // 解析结果连同 revision 落盘：下次这条会话只要没被追加过就不再解析。
        // cwd/createdAt/parentSession 一并存——缓存命中路径没有 inspect，靠这三项才能产出一致结构。
        if (entry.revision !== null) {
          disk.entries[entry.meta.id] = {
            rev: entry.revision,
            ...derived,
            cwd: inspected.cwd ?? entry.meta.cwd ?? null,
            createdAt: inspected.createdAt ?? entry.meta.createdAt,
            parentSession: inspected.parentSession ?? entry.meta.parentSession ?? null,
          };
          scheduleSaveListDiskCache(ctx);
        }
        return buildColdSessionItem(entry.meta, inspected, derived, ctx, storeState, archived);
      }));
      for (const settledEntry of settled) {
        if (settledEntry.status === "fulfilled") emit(settledEntry.value);
        else log(ctx, `冷会话列表项失败: ${String(settledEntry.reason?.message ?? settledEntry.reason)}`);
      }
    }
    // ③ 清理已消失会话的缓存条目（删除/移走的会话不该永远占着缓存文件）
    let pruned = 0;
    for (const id of Object.keys(disk.entries)) {
      if (!coldById.has(id) && !liveIds.has(id)) {
        delete disk.entries[id];
        pruned += 1;
      }
    }
    if (pruned > 0 || isListDiskCacheDirty()) {
      markListDiskCacheDirty();
      saveListDiskCacheNow(ctx);
    }
  }

  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return items;
}

/**
 * 带缓存/并发合并的会话列表。
 * @param ctx 插件上下文
 * @param opts.force true=绕过缓存与合并，强制重新构建（搜索/按规则删除等需要绝对新鲜的场景）
 */
export async function buildSessionListCached(ctx, { force = false, onItem = null, serial = false } = {}) {
  // onItem：list 流式输出用（每构建好一个会话回调一次，前端逐行追加）；null = 完整返回
  const emitAll = (items) => { if (onItem) for (const sessionItem of items ?? []) onItem(sessionItem); };
  if (!force) {
    const cached = peekListCache();
    if (cached !== null) { emitAll(cached); return cached; }
    // 已有构建在跑：直接复用，避免同一瞬间多个组件刷新时重复全量扫描（内存放大器）
    const inflight = peekListBuildInflight();
    if (inflight !== null) return inflight.then((items) => { emitAll(items); return items; });
  }
  const build = buildSessionList(ctx, { onItem, serial }).then((items) => {
    return settleListBuild(build, items);
  }).finally(() => {
    // settleListBuild 已清理 inflight；此处仅兜底
  });
  registerListBuild(build);
  return build;
}
