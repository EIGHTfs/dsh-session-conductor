// 会话「便宜元信息」的唯一查找入口。
//
// 【为什么抽出来】同一件事在两个地方各写了一遍：
//   · send_to_session 的 dryRun 预检（要报「目标是否活跃/在哪个目录」）
//   · 回收站标记删除（要存一份标题/目录快照供回收站列表展示）
// 两处都是「先看内存里的 live 会话，再看落盘索引」，逻辑重复且口径容易漂。
//
// 【铁律】只查这两个来源，**绝不**为了一个标题或目录去跑全量列表构建
//   （冷缓存实测 41~226 秒，曾把 dryRun 预检拖成「发消息前卡死」）。
//   查不到就返回 null，由调用方如实说「查不到」，不升级成昂贵查询。

/**
 * 取会话元信息：live 优先，其次落盘索引。
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 会话 id
 * @returns {Promise<{live:boolean,title:string|null,cwd:string|null,updatedAt:number|null,archived:boolean}|null>}
 */
export async function sessionMetaOf(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  try {
    const live = ctx.get?.("sessions")?.get?.(sessionId);
    if (live) {
      return {
        live: true,
        title: live.title ?? null,
        cwd: live.header?.cwd ?? null,
        updatedAt: null,
        archived: false,
      };
    }
  } catch {
    // live 查询不可用：退回落盘索引
  }
  try {
    const { loadListDiskCache } = await import("./list-cache.js");
    const entry = loadListDiskCache(ctx)?.entries?.[sessionId];
    if (entry) {
      return {
        live: false,
        title: entry.title ?? null,
        cwd: entry.cwd ?? null,
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
        archived: false,
      };
    }
  } catch {
    // 索引不可用：按「查不到」处理
  }
  return null;
}
