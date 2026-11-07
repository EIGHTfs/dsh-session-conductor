// 拖拽排序/归组：把面板里的「拖一下」翻译成宿主注册表的持久化操作。
//
// 【为什么不用插件自己存一份顺序】0.2.2 的 workspaceRegistry 已经是**持久化顺序的权威**：
//   工作区顺序 = `insertBefore(id, beforeId?)`（DOM insertBefore 语义，省略锚点即追加末尾），
//   工作区内的会话顺序 = `Workspace.insertSessionBefore(sessionId, beforeSessionId?)`，
//   跨工作区归组 = 源 `detachSession` + 目标 `attachSession`。
//   插件再存一份数组就成了「两套真相」：宿主侧（GUI 自己的侧边栏）与面板侧顺序会不一致，
//   用户在官方界面拖一次，面板显示就错了。所以这里只做**转发 + 参数校验**，不落自己的状态。
//
// 【为什么分 kind 而不是两条路由】两种拖拽共享同一套错误信封与参数校验骨架，
//   合并成一条 `POST /reorder` 让客户端只维护一个调用点（回滚逻辑也只有一处）。

import { readJson, send } from "../http.js";

/** 统一的错误信封。 */
function fail(res, status, code, message) {
  return send(res, status, { ok: false, error: { code, message } });
}

/** 取工作区注册表；宿主没挂载时返回 null（由调用方回 501，而不是抛 500）。 */
function registryOf(ctx) {
  const registry = ctx?.get?.("workspaceRegistry");
  return registry && typeof registry.insertBefore === "function" ? registry : null;
}

/** 找出某个会话当前归属的工作区（会话可能不属于任何工作区，返回 undefined）。 */
function workspaceOfSession(registry, sessionId) {
  for (const workspace of registry.list() ?? []) {
    if ((workspace?.sessionIds ?? []).includes(sessionId)) return workspace;
  }
  return undefined;
}

/** 工作区排序：`{kind:"workspace", id, beforeId?}`。 */
async function reorderWorkspace({ ctx, registry, body, res }) {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return fail(res, 400, "NO_ID", "缺少 id");
  const beforeId = typeof body?.beforeId === "string" && body.beforeId.trim() !== "" ? body.beforeId.trim() : undefined;
  if (beforeId === id) return fail(res, 400, "SELF_ANCHOR", "beforeId 不能等于 id");
  if (!registry.get(id)) return fail(res, 404, "NO_WORKSPACE", `工作区不存在: ${id}`);
  if (beforeId !== undefined && !registry.get(beforeId)) {
    return fail(res, 404, "NO_ANCHOR", `锚点工作区不存在: ${beforeId}`);
  }
  const order = await registry.insertBefore(id, beforeId);
  return send(res, 200, { ok: true, order: Array.isArray(order) ? [...order] : [] });
}

/** 会话排序/归组：`{kind:"session", sessionId, beforeId?, workspaceId?}`。 */
async function reorderSession({ ctx, registry, body, res }) {
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) return fail(res, 400, "NO_SESSION_ID", "缺少 sessionId");
  const beforeId = typeof body?.beforeId === "string" && body.beforeId.trim() !== "" ? body.beforeId.trim() : undefined;
  if (beforeId === sessionId) return fail(res, 400, "SELF_ANCHOR", "beforeId 不能等于 sessionId");

  const current = workspaceOfSession(registry, sessionId);
  const wantedId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const target = wantedId !== "" ? registry.get(wantedId) : current;
  if (!target) {
    return fail(res, 404, "NO_WORKSPACE", wantedId !== "" ? `目标工作区不存在: ${wantedId}` : "该会话不属于任何工作区");
  }
  // 锚点必须已经在目标工作区里：否则宿主的 insertSessionBefore 行为未定义（可能静默追加，
  // 让用户看到「拖了没反应」或「跳到别处」），这里提前拒掉并给出可读原因。
  if (beforeId !== undefined && !(target.sessionIds ?? []).includes(beforeId)) {
    return fail(res, 400, "ANCHOR_NOT_IN_WORKSPACE", "锚点会话不在目标工作区里");
  }

  // 跨工作区：先脱离源工作区再挂到目标。两次写之间失败会留下「两边都没有」的中间态，
  // 概率极低（都是同一个注册表的排队写），失败时把会话挂回源工作区兜底。
  const movingWorkspace = current !== undefined && current.id !== target.id;
  if (movingWorkspace) {
    try {
      await current.detachSession(sessionId);
    } catch {
      // 源工作区里本来就没有它（并发场景）：继续挂目标即可
    }
    try {
      await target.attachSession(sessionId);
    } catch (error) {
      await current.attachSession(sessionId).catch(() => {});
      return fail(res, 500, "ATTACH_FAILED", String(error?.message ?? error));
    }
  }

  if (beforeId !== undefined) {
    await target.insertSessionBefore(sessionId, beforeId);
  } else if (!movingWorkspace) {
    // 同组内拖到末尾：锚点省略 = 追加。attach 已经把它放到末尾，这里无需再写。
    await target.insertSessionBefore(sessionId).catch(() => {});
  }

  return send(res, 200, { ok: true, sessionIds: [...(target.sessionIds ?? [])] });
}

/**
 * 注册拖拽排序路由。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @returns {void}
 */
export function registerReorderRoutes({ webServer, ctx }) {
  // ---------- POST /api/session-conductor/reorder ----------
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/reorder",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "POST") return fail(res, 405, "METHOD", "Method Not Allowed");
        const registry = registryOf(ctx);
        if (!registry) return fail(res, 501, "NO_REGISTRY", "宿主未挂载 workspaceRegistry 服务");

        const body = await readJson(req).catch(() => ({}));
        const kind = typeof body?.kind === "string" ? body.kind : "";
        if (kind === "workspace") return await reorderWorkspace({ ctx, registry, body, res });
        if (kind === "session") return await reorderSession({ ctx, registry, body, res });
        return fail(res, 400, "BAD_KIND", 'kind 必须是 "workspace" 或 "session"');
      } catch (error) {
        return fail(res, 500, "INTERNAL", String(error?.message ?? error));
      }
    },
  });
}
