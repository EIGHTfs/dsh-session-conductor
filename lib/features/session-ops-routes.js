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
import { unarchiveSession, deleteSession, undoLastMessage, deleteBatchSessions, deleteByRule } from './session-ops.js';

/** 按规则删除时「超期未活跃天数」入参上限（约 10 年）：防离谱值把全部会话一起圈进去。 */
const MAX_INACTIVE_DAYS = 3650;

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
    // ---------- POST /api/session-conductor/archive ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/archive",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
          }
          const registry = ctx.get("workspaceRegistry");
          if (!registry) throw new Error("workspaceRegistry 服务不可用");
          // 归档时给标题加「[工作区名] 」前缀（数据层带前缀，面板显示剥离，已归档视图按前缀分组）。
          // 读会话 → 取原标题 → 加前缀 → rename（幂等：已带前缀不叠加）。失败不阻断归档。
          try {
            const sessions = ctx.get("sessions");
            const titleService = ctx.get("sessionTitle");
            const session = sessions?.get(body.sessionId);
            const cwd = session?.header?.cwd ?? null;
            const ws = workspaceNameOf(ctx, cwd);
            const currentTitle = titleString(titleService?.get(session)) ?? (session ? foldTitle(session.events) : null) ?? "";
            if (titleService && ws !== "" && currentTitle !== "") {
              const { title: newTitle } = archiveTitleWithWs(currentTitle, ws);
              if (newTitle !== currentTitle) {
                titleService.rename(session, newTitle);
                log(ctx, `归档加工作区前缀 ${body.sessionId}: "${currentTitle}" → "${newTitle}"`);
              }
            }
          } catch (titleError) {
            log(ctx, `归档标题加前缀失败（不阻断归档）: ${String(titleError?.message ?? titleError)}`);
          }
          await registry.archiveSession(body.sessionId);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "archive-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/unarchive ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/unarchive",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
          }
          // 取消归档时去掉「[工作区名] 」前缀还原原标题（数据层带前缀，取消归档即还原）。
          try {
            const sessions = ctx.get("sessions");
            const titleService = ctx.get("sessionTitle");
            const session = sessions?.get(body.sessionId);
            const currentTitle = titleString(titleService?.get(session)) ?? (session ? foldTitle(session.events) : null) ?? "";
            if (titleService && currentTitle !== "") {
              const { title: stripped } = stripArchiveWsPrefix(currentTitle);
              if (stripped !== currentTitle) {
                titleService.rename(session, stripped);
                log(ctx, `取消归档还原标题 ${body.sessionId}: "${currentTitle}" → "${stripped}"`);
              }
            }
          } catch (titleError) {
            log(ctx, `取消归档还原标题失败（不阻断）: ${String(titleError?.message ?? titleError)}`);
          }
          await unarchiveSession(ctx, body.sessionId);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "unarchive-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
          }
          const deleteResult = await deleteSession(ctx, body.sessionId);
          if (!deleteResult.ok) return send(res, 409, deleteResult);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/undo-message ----------
    // 撤回最后一条用户消息：直接操作会话日志文件，删除最后一条 user/message
    // 及其后的整轮回复；dryRun=true 只返回预览（消息文本/将删事件数）不执行；二次确认由前端做。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/undo-message",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
          }
          const undoResult = await undoLastMessage(ctx, body.sessionId, { dryRun: body?.dryRun === true });
          if (!undoResult.ok) return send(res, 409, undoResult);
          send(res, 200, undoResult);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "undo-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete-batch ----------
    // 批量删除：逐条复用删除链路（per-session 串行锁/幂等），运行中跳过不整体失败
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete-batch",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          // 空数组（[]）是合法幂等请求，应返回空结果而非报错；仅「未传/非数组」才视为参数缺失
          if (body?.sessionIds !== void 0 && !Array.isArray(body.sessionIds)) {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "sessionIds 必须是数组" } });
          }
          const batchResult = await deleteBatchSessions(ctx, body?.sessionIds ?? []);
          send(res, 200, { ok: true, ...batchResult });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-batch-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete-by-rule ----------
    // 按条件删除：归档状态/超期未活跃/cwd 前缀；dryRun=true 预览不执行
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete-by-rule",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const ruleDeleteResult = await deleteByRule(ctx, {
            archivedOnly: body?.archivedOnly === true,
            inactiveDays: typeof body?.inactiveDays === "number" && Number.isFinite(body.inactiveDays)
              ? Math.min(MAX_INACTIVE_DAYS, Math.max(0, Math.round(body.inactiveDays)))
              : 0,
            cwdPrefix: typeof body?.cwdPrefix === "string" ? body.cwdPrefix : "",
            dryRun: body?.dryRun === true,
          });
          send(res, 200, ruleDeleteResult);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-by-rule-failed", message: String(error?.message ?? error) } });
        }
      },
    });
}
