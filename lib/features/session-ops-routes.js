/**
 * 会话操作路由：归档 / 取消归档 / 删除（单个·批量·按规则）/ 撤回最后一条消息。
 *
 * 从 lib/apply.js 抽出（apply 单块 1483 行，路由注册与实现混在一起）——本模块只负责
 * 「注册这 6 条路由」，handler 体与原实现逐字一致，行为不变。
 * 依赖由调用方以 deps 传入（webServer / ctx / send / readJson / invalidateSessionListCache），
 * 其余（会话操作实现、标题工具、日志）在本模块内直接 import，不再依赖 apply 的作用域。
 */
import { log } from '../shared/log.js';
import { MSG_NEED_SESSION_ID } from '../shared/constants.js';
import { titleString, foldTitle, workspaceNameOf, archiveTitleWithWs, stripArchiveWsPrefix } from './rename/title.js';
import { unarchiveSession, deleteSession, undoLastMessage, deleteBatchSessions, deleteByRule, emptyTrash, purgeExpiredTrash } from './session-ops.js';
import { listTrash, latestBatch, restoreSessions, retentionDays, setRetentionDays, loadTrash } from './trash.js';

/** 按规则删除时「超期未活跃天数」入参上限（约 10 年）：防离谱值把全部会话一起圈进去。 */
const MAX_INACTIVE_DAYS = 3650;

/**
 * 该写请求是否需要失效会话列表缓存（导出供单测：纯函数、无副作用）。
 *
 * 为什么要单独判定：非 GET 请求会改动会话内容，失效缓存能让面板随后的 refresh 立刻看到
 *   最新（而不是 5s TTL 内的旧列表）；但 **dryRun 预览是只读请求**，不该打掉缓存 ——
 *   否则「预览一次 → 紧接着的 /list 必须全量重建」自伤：实测预览 48s，且 /list 由 7ms（缓存命中）
 *   掉到 ~49s（全量重建）。原先在 readJson 之前**无条件**失效，正是这个自伤的来源。
 * @param {string} method HTTP 方法
 * @param {object} body 已解析的请求体（可能为 undefined）
 * @returns {boolean} true = 失效缓存
 */
export function shouldInvalidateListCache(method, body) {
  if (method === "GET") return false;
  return body?.dryRun !== true;
}

/**
 * 注册会话操作相关的 HTTP 路由。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务（提供 register）
 * @param {object} deps.ctx 插件 ctx（用于 get 各服务）
 * @param {Function} deps.send 响应发送工具
 * @param {Function} deps.readJson 请求体解析工具
 * @param {Function} deps.invalidateSessionListCache 会话列表缓存失效
 */
export function registerSessionOpsRoutes({ webServer, ctx, send, readJson, invalidateSessionListCache }) {
  /**
   * 写请求才失效列表缓存（只读预览跳过）；判定见 shouldInvalidateListCache。
   * 必须在 readJson 之后调用 —— 要看到 body.dryRun 才能判定。
   */
  const invalidateUnlessDryRun = (req, body) => {
    if (shouldInvalidateListCache(req.method, body)) invalidateSessionListCache();
  };

  /** 读 body + 按需失效列表缓存：各路由共用的前置步骤。 */
  const prepareBody = async (req) => {
    const body = await readJson(req);
    invalidateUnlessDryRun(req, body);
    return body;
  };

  /**
   * 注册一条路由：统一 try/catch + 读 body + 失效缓存（可选校验 sessionId）。
   * 原先 6 条路由各抄一遍这段样板，既重复又让业务代码多两层缩进。
   * @param {string} path 路由路径
   * @param {string} failCode 失败时的错误码
   * @param {(body: object, res: object) => Promise<void>} run 业务体
   * @param {{requireSessionId?: boolean}} [opts] requireSessionId=false 用于批量/按规则接口
   */
  const route = (path, failCode, run, { requireSessionId = true } = {}) => webServer.register({
    kind: "exact",
    path,
    handler: async (req, res) => {
      try {
        const body = await prepareBody(req);
        if (requireSessionId && (typeof body?.sessionId !== "string" || body.sessionId === "")) {
          return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
        }
        await run(body, res);
      } catch (error) {
        send(res, 400, { ok: false, error: { code: failCode, message: String(error?.message ?? error) } });
      }
    },
  });

  /**
   * 归档 / 取消归档共用的标题改写：读原标题 → 变换 → rename → 作废列表缓存。
   * 失败只记日志、不阻断主流程（归档状态本身仍要落库）。
   * @param {(currentTitle: string, workspaceName: string) => string|null} transform 返回 null 表示不改
   */
  const rewriteTitleForArchive = async (sessionId, transform, label) => {
    try {
      const sessions = ctx.get("sessions");
      const titleService = ctx.get("sessionTitle");
      const session = sessions?.get(sessionId);
      const cwd = session?.header?.cwd ?? null;
      const currentTitle = titleString(titleService?.get(session)) ?? (session ? foldTitle(session.events) : null) ?? "";
      if (!titleService || currentTitle === "") return;
      const nextTitle = transform(currentTitle, workspaceNameOf(ctx, cwd));
      if (nextTitle === null || nextTitle === currentTitle) return;
      titleService.rename(session, nextTitle);
      // 标题是列表里可见的属性：改完必须让内存缓存与落盘索引一起作废
      try {
        const { markSessionListStale } = await import("../sessions/list-cache.js");
        markSessionListStale(ctx, sessionId);
      } catch { /* 作废失败不影响归档 */ }
      log(ctx, `${label} ${sessionId}: "${currentTitle}" → "${nextTitle}"`);
    } catch (titleError) {
      log(ctx, `${label}失败（不阻断）: ${String(titleError?.message ?? titleError)}`);
    }
  };

  // ---------- POST /api/session-conductor/archive ----------
  // 归档时给标题加「[工作区名] 」前缀（数据层带前缀，面板显示剥离，已归档视图按前缀分组）。
  route("/api/session-conductor/archive", "archive-failed", async (body, res) => {
    const registry = ctx.get("workspaceRegistry");
    if (!registry) throw new Error("workspaceRegistry 服务不可用");
    await rewriteTitleForArchive(
      body.sessionId,
      (currentTitle, workspaceName) => (workspaceName === "" ? null : archiveTitleWithWs(currentTitle, workspaceName).title),
      "归档加工作区前缀",
    );
    await registry.archiveSession(body.sessionId);
    send(res, 200, { ok: true });
  });

  // ---------- POST /api/session-conductor/unarchive ----------
  // 取消归档时去掉「[工作区名] 」前缀还原原标题（数据层带前缀，取消归档即还原）。
  route("/api/session-conductor/unarchive", "unarchive-failed", async (body, res) => {
    await rewriteTitleForArchive(
      body.sessionId,
      (currentTitle) => stripArchiveWsPrefix(currentTitle).title,
      "取消归档还原标题",
    );
    await unarchiveSession(ctx, body.sessionId);
    send(res, 200, { ok: true });
  });

  // ---------- POST /api/session-conductor/delete ----------
  // 删除 = 打回收站标记（文件不动），真删由回收站到期/清空执行
  route("/api/session-conductor/delete", "delete-failed", async (body, res) => {
    const deleteResult = await deleteSession(ctx, body.sessionId);
    if (!deleteResult.ok) return send(res, 409, deleteResult);
    send(res, 200, { ok: true });
  });

  // ---------- POST /api/session-conductor/undo-message ----------
  // 撤回最后一条用户消息：直接操作会话日志文件，删除最后一条 user/message 及其后的整轮回复；
  // dryRun=true 只返回预览（消息文本/将删事件数）不执行；二次确认由前端做。
  route("/api/session-conductor/undo-message", "undo-failed", async (body, res) => {
    const undoResult = await undoLastMessage(ctx, body.sessionId, { dryRun: body?.dryRun === true });
    if (!undoResult.ok) return send(res, 409, undoResult);
    send(res, 200, undoResult);
  });

  // ---------- POST /api/session-conductor/delete-batch ----------
  // 批量删除：一次操作 = 一个批次（回收站里可整批撤销），运行中的跳过不整体失败
  route("/api/session-conductor/delete-batch", "delete-batch-failed", async (body, res) => {
    // 空数组（[]）是合法幂等请求，应返回空结果而非报错；仅「未传/非数组」才视为参数缺失
    if (body?.sessionIds !== void 0 && !Array.isArray(body.sessionIds)) {
      return send(res, 400, { ok: false, error: { code: "bad-request", message: "sessionIds 必须是数组" } });
    }
    const batchResult = await deleteBatchSessions(ctx, body?.sessionIds ?? []);
    send(res, 200, { ok: true, ...batchResult });
  }, { requireSessionId: false });

  // ---------- POST /api/session-conductor/delete-by-rule ----------
  // 按条件筛选：归档状态 / 超期未活跃 / cwd 前缀 / 低价值；dryRun=true 只回命中不删
  route("/api/session-conductor/delete-by-rule", "delete-by-rule-failed", async (body, res) => {
    const ruleDeleteResult = await deleteByRule(ctx, {
      archivedOnly: body?.archivedOnly === true,
      inactiveDays: typeof body?.inactiveDays === "number" && Number.isFinite(body.inactiveDays)
        ? Math.min(MAX_INACTIVE_DAYS, Math.max(0, Math.round(body.inactiveDays)))
        : 0,
      cwdPrefix: typeof body?.cwdPrefix === "string" ? body.cwdPrefix : "",
      // 低价值条件必须**透传**：面板会发 lowValue，路由漏传过一次 ⇒ 该条件恒 false、勾了等于没勾
      lowValue: body?.lowValue === true,
      dryRun: body?.dryRun === true,
    });
    send(res, 200, ruleDeleteResult);
  }, { requireSessionId: false });
}

/**
 * 注册回收站相关路由。
 *
 * 设计要点：删除只是「打标记」，所以还原几乎零成本（文件从没动过）；
 * 真正删盘只发生在「到期清理」与「一键清空」，两者都要二次确认或由定时器触发。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @param {Function} deps.send 响应发送工具
 * @param {Function} deps.readJson 请求体解析工具
 * @param {Function} deps.invalidateSessionListCache 会话列表缓存失效（还原后要立刻重新出现）
 */
export function registerTrashRoutes({ webServer, ctx, send, readJson, invalidateSessionListCache }) {
  const touchList = () => {
    try { invalidateSessionListCache?.(); } catch { /* 失效失败不影响回收站操作 */ }
  };

  /**
   * 注册一条回收站路由：统一 try/catch + 读 body。
   * 与 session-ops 那组同款收敛——原先每条各抄一遍，重复且多一层缩进。
   * @param {string} path 路由路径
   * @param {string} failCode 失败错误码
   * @param {number} failStatus 失败 HTTP 状态码
   * @param {(body: object, res: object) => Promise<void>|void} run 业务体
   */
  const route = (path, failCode, failStatus, run) => webServer.register({
    kind: "exact",
    path,
    handler: async (req, res) => {
      try {
        const body = await readJson(req);
        await run(body, res);
      } catch (error) {
        send(res, failStatus, { ok: false, error: { code: failCode, message: String(error?.message ?? error) } });
      }
    },
  });

  // ---------- GET /api/session-conductor/trash ----------
  // 回收站列表 + 当前保留天数 + 最近批次（撤销用）
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/trash",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "GET") return send(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
        send(res, 200, {
          ok: true,
          retentionDays: retentionDays(ctx),
          items: listTrash(ctx),
          latestBatch: latestBatch(ctx),
        });
      } catch (error) {
        send(res, 500, { ok: false, error: { code: "trash-list-failed", message: String(error?.message ?? error) } });
      }
    },
  });

  // ---------- POST /api/session-conductor/trash/restore ----------
  // body: { sessionIds: string[] } → 还原指定会话（删标记，文件本来就在）
  route("/api/session-conductor/trash/restore", "restore-failed", 400, (body, res) => {
    const ids = Array.isArray(body?.sessionIds) ? body.sessionIds : [];
    if (ids.length === 0) return send(res, 400, { ok: false, error: { code: "bad-request", message: "sessionIds 不能为空" } });
    const restoreResult = restoreSessions(ctx, ids);
    if (restoreResult.restored.length > 0) touchList();
    send(res, 200, { ok: true, ...restoreResult });
  });

  // ---------- POST /api/session-conductor/trash/restore-last-batch ----------
  // 撤销：还原最近一个批次的全部删除（一次删除操作 = 一个 batchId）
  route("/api/session-conductor/trash/restore-last-batch", "restore-batch-failed", 400, (_body, res) => {
    const batch = latestBatch(ctx);
    if (!batch) return send(res, 200, { ok: true, batchId: null, restored: [], message: "回收站是空的" });
    const restoreResult = restoreSessions(ctx, batch.ids);
    if (restoreResult.restored.length > 0) touchList();
    send(res, 200, { ok: true, batchId: batch.batchId, restored: restoreResult.restored });
  });

  // ---------- POST /api/session-conductor/trash/empty ----------
  // 一键清空：立即真删（不可恢复），要求 body.confirm === true
  route("/api/session-conductor/trash/empty", "empty-failed", 400, async (body, res) => {
    if (body?.confirm !== true) {
      return send(res, 400, { ok: false, error: { code: "need-confirm", message: "清空回收站不可恢复，需传 confirm=true" } });
    }
    const emptyResult = await emptyTrash(ctx);
    touchList();
    send(res, 200, { ok: true, ...emptyResult });
  });

  // ---------- POST /api/session-conductor/trash/retention ----------
  // body: { days: number } → 设置保留天数（1~365）
  route("/api/session-conductor/trash/retention", "retention-failed", 400, (body, res) => {
    const days = Number(body?.days);
    if (!Number.isFinite(days) || days < 1) {
      return send(res, 400, { ok: false, error: { code: "bad-request", message: "days 必须是 ≥1 的数字" } });
    }
    send(res, 200, { ok: true, retentionDays: setRetentionDays(ctx, days) });
  });

  // ---------- POST /api/session-conductor/trash/purge ----------
  // 手动触发到期清理（面板打开时也会自动触发一次；这里供脚本/排查用）
  route("/api/session-conductor/trash/purge", "purge-failed", 400, async (_body, res) => {
    const purgeResult = await purgeExpiredTrash(ctx);
    if (purgeResult.deleted.length > 0) touchList();
    send(res, 200, { ok: true, ...purgeResult });
  });
}
