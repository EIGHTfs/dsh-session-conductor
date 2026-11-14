// dsh-session-conductor — 未读标记路由
//
// 三条路由，全部走本仓库既有的 send() / readJson() 与统一错误信封：
//   GET  /api/session-conductor/unread         读快照（面板据此算圆点）
//   POST /api/session-conductor/unread         标记单条已读/未读 {sessionId, read?, at?}
//   POST /api/session-conductor/unread/all     全部已读 {at?}
//
// 【为什么快照里不带"未读布尔"】未读是客户端拿 updatedAt 与快照比较得出的，
// 服务端只提供事实（读到哪个时刻），不提供结论 —— 这样列表刷新与会话更新不会出现
// 「状态没翻」的两套真相。

import { readJson, send } from "../http.js";
import { MSG_METHOD_ONLY_GET_POST } from "../shared/constants.js";
import { markAllRead, markRead, unreadSnapshot } from "./unread.js";

/**
 * 注册未读相关路由。
 * @param {{webServer: object, ctx: object}} deps
 */
export function registerUnreadRoutes({ webServer, ctx }) {
  // ---------- GET/POST /api/session-conductor/unread ----------
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/unread",
    handler: async (req, res) => {
      try {
        const method = req.method ?? "GET";
        if (method === "GET") {
          send(res, 200, { ok: true, ...unreadSnapshot(ctx) });
          return;
        }
        if (method === "POST") {
          const body = await readJson(req);
          const sessionId = String(body?.sessionId ?? "").trim();
          if (sessionId === "") {
            send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 sessionId" } });
            return;
          }
          // read 缺省 true：调用方只想"标记已读"时不必显式传
          const snapshot = markRead(ctx, sessionId, { read: body?.read !== false, at: body?.at });
          send(res, 200, { ok: true, ...snapshot });
          return;
        }
        send(res, 405, { ok: false, error: { code: "method", message: MSG_METHOD_ONLY_GET_POST } });
      } catch (error) {
        send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
      }
    },
  });

  // ---------- POST /api/session-conductor/unread/all ----------
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/unread/all",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "POST") {
          send(res, 405, { ok: false, error: { code: "method", message: MSG_METHOD_ONLY_GET_POST } });
          return;
        }
        const body = await readJson(req);
        const snapshot = markAllRead(ctx, body?.at);
        send(res, 200, { ok: true, ...snapshot });
      } catch (error) {
        send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
      }
    },
  });
}
