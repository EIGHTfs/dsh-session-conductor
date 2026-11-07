// 派生关系记录：记住「这条会话是从哪条会话 fork 出来的」。
//
// 【为什么需要落盘】fork 本身由宿主客户端服务 `sessions.fork()` 完成（见 merge-contract.md §2），
//   它只建出一条新会话，**不留下父子关系**：新会话的标题是继承来的，`parentSession` 也还是源会话
//   原本的父级（子代理语义），也就是说只看宿主数据根本分不清「这是 fork 出来的」还是「我自己新建的」。
//   面板要给用户看「派生自 X」并支持点回源会话，就得自己记一笔。
//
// 【为什么记在持久化域而不是 index.json】它是用户可感知、可跨设备复现的关系数据，
//   不是「重建一遍就有的缓存」；域是插件的正式持久化通道，清索引不该把它一起清掉。
//
// 【容错】源会话被删是常态（fork 完就不需要源了），所以读取侧一律「查不到就忽略」，
//   这里也不做「源必须存在」的强校验 —— fork 完立刻删源是完全合法的用法。

import { readJson, send } from "../http.js";
import { log } from "../shared/log.js";
import { pluginDomain } from "../core/domain.js";

/** 上限：一张表里最多记这么多条派生关系，超出按最旧丢弃（防域文档无限膨胀）。 */
const MAX_FORK_RECORDS = 2000;

/** 统一的错误信封。 */
function fail(res, status, code, message) {
  return send(res, status, { ok: false, error: { code, message } });
}

/** sessionId 只允许安全字符（会作为 JSON 键与 URL 参数使用）。 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** 读派生关系表（读不到就返回空表，绝不抛）。 */
async function readForkMap(ctx) {
  try {
    const domain = await pluginDomain(ctx);
    const state = domain.global.get();
    const map = state?.forkOf;
    return map && typeof map === "object" ? { ...map } : {};
  } catch (error) {
    log(ctx, `forked: 读派生关系失败（${String(error?.message ?? error)}）`);
    return {};
  }
}

/** 写派生关系表（整表回写，域是文档型存储）。 */
async function writeForkMap(ctx, map) {
  const domain = await pluginDomain(ctx);
  const state = domain.global.get();
  const keys = Object.keys(map);
  // 超出上限时丢掉最早的记录：对象键顺序即插入顺序，取尾部 MAX 条即可
  const trimmed = keys.length > MAX_FORK_RECORDS
    ? Object.fromEntries(keys.slice(keys.length - MAX_FORK_RECORDS).map((key) => [key, map[key]]))
    : map;
  await domain.global.set({ ...state, forkOf: trimmed });
  return trimmed;
}

/**
 * 注册派生关系路由。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @returns {void}
 */
export function registerForkedRoutes({ webServer, ctx }) {
  // ---------- GET /api/session-conductor/forked ----------
  // 面板一次拿全表（条数有上限，几十 KB 以内），避免每行一次请求。
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/forked",
    handler: async (req, res) => {
      try {
        const method = req.method ?? "GET";
        if (method === "GET") {
          return send(res, 200, { ok: true, forkOf: await readForkMap(ctx) });
        }
        if (method !== "POST") return fail(res, 405, "METHOD", "Method Not Allowed");

        const body = await readJson(req).catch(() => ({}));
        const childId = typeof body?.childId === "string" ? body.childId.trim() : "";
        const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
        if (!childId) return fail(res, 400, "NO_CHILD_ID", "缺少 childId");
        if (!sourceId) return fail(res, 400, "NO_SOURCE_ID", "缺少 sourceId");
        if (!SAFE_ID.test(childId) || !SAFE_ID.test(sourceId)) {
          return fail(res, 400, "BAD_ID", "id 含非法字符");
        }
        if (childId === sourceId) return fail(res, 400, "SELF_PARENT", "childId 不能等于 sourceId");

        const map = await readForkMap(ctx);
        map[childId] = sourceId;
        const saved = await writeForkMap(ctx, map);
        return send(res, 200, { ok: true, forkOf: saved });
      } catch (error) {
        // 记录失败不该让前端的 fork 流程报错（会话已经建好了），只回软失败让面板忽略
        return send(res, 200, { ok: false, forkOf: {}, error: { code: "RECORD_FAILED", message: String(error?.message ?? error) } });
      }
    },
  });
}
