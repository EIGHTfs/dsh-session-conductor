// 未读标记的路由：读快照 / 标记单条 / 全部标已读。
//
// 【为什么分开三条路由而不是一条 prefix】
// 三条都是固定子路径且语义互不相同（读、写单条、写全部），用 exact 路由能让宿主
// 直接 404 掉拼错的路径；prefix 路由得自己兜底，反而多一层「忘了兜 404 就挂死」的坑。
//
// 【客户端怎么用】GET 拿 { entries, allReadAt }，再按
//   unread === session.updatedAt > max(entries[id] ?? 0, allReadAt ?? 0)
// 自己算每条会话的未读状态 —— 宿主不透出布尔值，避免「同一份事实两处判定」而漂移。

import { readJson, send } from "../http.js";
import { markAllRead, markRead, markUnread, unreadSnapshot } from "./unread.js";

/** 统一的错误信封。 */
function fail(res, status, code, message) {
  return send(res, status, { ok: false, error: { code, message } });
}

/**
 * 注册未读路由。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @returns {void}
 */
export function registerUnreadRoutes({ webServer, ctx }) {
  // ---------- GET /api/session-conductor/unread ----------
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/unread",
    handler: async (req, res) => {
      try {
        const method = req.method ?? "GET";
        if (method === "GET") {
          return send(res, 200, { ok: true, ...unreadSnapshot(ctx) });
        }
        if (method !== "POST") return fail(res, 405, "METHOD", "Method Not Allowed");

        const body = await readJson(req).catch(() => ({}));
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId) return fail(res, 400, "NO_SESSION_ID", "缺少 sessionId");

        // read=false：手动标未读（删掉这一条的已读时刻）。
        // at 允许客户端传「它看到的那个 updatedAt」——否则用户点开一条正在流式输出的会话，
        // 用「此刻」当已读时刻会把这之后刚到的内容也一并算成已读，圆点就永远不回来。
        if (body?.read === false) {
          markUnread(ctx, sessionId);
        } else {
          const at = Number(body?.at);
          markRead(ctx, sessionId, Number.isFinite(at) && at > 0 ? at : Date.now());
        }
        return send(res, 200, { ok: true, ...unreadSnapshot(ctx) });
      } catch (error) {
        return fail(res, 500, "INTERNAL", String(error?.message ?? error));
      }
    },
  });

  // ---------- POST /api/session-conductor/unread/all ----------
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/unread/all",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "POST") return fail(res, 405, "METHOD", "Method Not Allowed");
        const body = await readJson(req).catch(() => ({}));
        const at = Number(body?.at);
        markAllRead(ctx, Number.isFinite(at) && at > 0 ? at : Date.now());
        return send(res, 200, { ok: true, ...unreadSnapshot(ctx) });
      } catch (error) {
        return fail(res, 500, "INTERNAL", String(error?.message ?? error));
      }
    },
  });
}
