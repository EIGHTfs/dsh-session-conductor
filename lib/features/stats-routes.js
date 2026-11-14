// dsh-session-conductor — 会话统计路由
//
//   GET /api/session-conductor/stats
//     → { ok, generatedAt, totals, byWorkspace, activity, largest }
//
// 聚合规则全在零依赖叶子 `stats-aggregate.js`（可单测）；本文件只负责取数：
//   · 会话列表走 `buildSessionListCached`（有缓存，冷会话只解析一次）
//   · 体积走 `sessionPersistence.list()` 的 `sizeBytes`，拿不到就整体标 null
//   · 工作区归属走 `workspaceRegistry.list()`（宿主没有分组能力时传 null）

import { send } from "../http.js";
import { buildSessionListCached } from "../sessions/list.js";
import { aggregateStats } from "./stats-aggregate.js";

/**
 * 收集每个会话的日志字节数。
 *
 * 宿主的 `list()` 返回 SessionPersistenceSnapshot（可能带 `sizeBytes`）；旧版本或
 * 某些后端不带这个字段——拿不到就返回空对象，聚合层据此把体积标成 null（不是 0）。
 *
 * @param {object} ctx 插件 ctx
 * @returns {Promise<Record<string, number>>}
 */
async function collectSizes(ctx) {
  try {
    const persistence = ctx.get("sessionPersistence");
    if (typeof persistence?.list !== "function") return {};
    const snapshots = await persistence.list();
    const sizes = {};
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      const id = snapshot?.header?.id;
      const bytes = Number(snapshot?.sizeBytes);
      if (typeof id === "string" && id !== "" && Number.isFinite(bytes) && bytes >= 0) {
        sizes[id] = bytes;
      }
    }
    return sizes;
  } catch {
    // 取体积失败不影响其它统计项：整块退化为「未知」
    return {};
  }
}

/**
 * 注册统计路由。
 * @param {{webServer: object, ctx: object}} deps
 */
export function registerStatsRoutes({ webServer, ctx }) {
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/stats",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "GET") {
          send(res, 405, { ok: false, error: { code: "method", message: "只支持 GET" } });
          return;
        }
        const sessions = await buildSessionListCached(ctx);
        const sizes = await collectSizes(ctx);
        let workspaces = null;
        try {
          workspaces = ctx.get("workspaceRegistry")?.list?.() ?? null;
        } catch {
          workspaces = null; // 宿主无分组能力：退化为「未分组」单一桶
        }
        const stats = aggregateStats({ sessions, workspaces, sizes });
        send(res, 200, { ok: true, ...stats });
      } catch (error) {
        send(res, 500, { ok: false, error: { code: "stats-failed", message: String(error?.message ?? error) } });
      }
    },
  });
}
