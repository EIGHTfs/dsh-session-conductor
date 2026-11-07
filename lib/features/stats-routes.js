// 会话统计：把「我这台机器上一共有多少对话、都在哪、什么时候活跃、占多大」一次算清。
//
// 【为什么放在宿主侧算】统计需要同时看三样东西：会话列表（含 live 状态与中断判定）、
// 工作区注册表（会话归属哪个分组）、宿主 persistence 的快照体积（sizeBytes）。
// 这三样客户端都拿不全 —— 客户端只有一屏列表，拿不到「按工作区分桶」也拿不到体积。
// 宿主侧算完一次性下发给面板，客户端只负责画，避免把聚合逻辑抄进 UI。
//
// 【数据源优先级】落盘索引（readListIndex，秒回）→ 全量构建（buildSessionListCached，慢但准）。
// 面板点开统计是低频操作，但也不该把用户钉在 200 秒的全量扫描上，所以默认走索引。
//
// 【本文件只做取数 + 下发】纯聚合在 ./stats-aggregate.js（零依赖叶子模块，单测直接喂假数据）。
// 之所以切出去：这里的 import 会拉起源码树里的 core/domain.js，而单测环境没有
// `@deepseek-ai/dsh-storage-domain`（可选 peer，只有宿主提供），整个模块根本 import 不进来。

import { send } from "../http.js";
import { log } from "../shared/log.js";
import { readListIndex } from "./session-messaging/index.js";
import { buildSessionListCached } from "../sessions/list.js";
import { trashedIds } from "./trash.js";
import { aggregateStats } from "./stats-aggregate.js";

// 兼容既有引用（契约文档与测试都按这个名字找）：聚合实现已搬到 stats-aggregate.js。
export { aggregateStats } from "./stats-aggregate.js";

/**
 * 取体积快照（会话 id → 字节数）。宿主 persistence 不提供或调用失败时返回 null，
 * 统计里所有与体积相关的字段随之退化成 null / 空数组（客户端要能接受假值）。
 */
async function sizeSnapshot(ctx) {
  try {
    const persistence = ctx?.get?.("sessionPersistence");
    if (!persistence || typeof persistence.list !== "function") return null;
    const snapshots = await persistence.list();
    const map = new Map();
    for (const entry of snapshots ?? []) {
      // 0.2.2 起 list() 返回快照信封（id/cwd 在 header 里，体积在 sizeBytes 上），
      // 这里两种形状都认，免得跟着宿主小版本再改一次。
      const header = entry?.header ?? entry;
      const id = header?.id;
      const bytes = Number(entry?.sizeBytes);
      if (typeof id === "string" && id !== "" && Number.isFinite(bytes) && bytes >= 0) map.set(id, bytes);
    }
    return map;
  } catch (error) {
    log(ctx, `stats: 体积快照不可用（${String(error?.message ?? error)}）`);
    return null;
  }
}

/** 取会话列表：先落盘索引，拿不到再全量构建。 */
async function listItems(ctx) {
  try {
    const indexed = await readListIndex(ctx);
    if (Array.isArray(indexed) && indexed.length > 0) return { items: indexed, fromIndex: true };
  } catch {
    // 索引不可用：走全量构建
  }
  try {
    const built = await buildSessionListCached(ctx);
    return { items: Array.isArray(built) ? built : [], fromIndex: false };
  } catch (error) {
    log(ctx, `stats: 列表构建失败（${String(error?.message ?? error)}）`);
    return { items: [], fromIndex: false };
  }
}

/** 取工作区列表；注册表不可用时返回空数组（会话全进「未分组」桶）。 */
function workspacesOf(ctx) {
  try {
    const registry = ctx?.get?.("workspaceRegistry");
    const list = typeof registry?.list === "function" ? registry.list() : [];
    return Array.isArray(list) ? list : [];
  } catch (error) {
    log(ctx, `stats: 工作区注册表不可用（${String(error?.message ?? error)}）`);
    return [];
  }
}

/**
 * 汇总统计（取数 + 聚合）。
 * @param {object} ctx 插件 ctx
 * @returns {Promise<object>} 统计对象（见 merge-contract.md §3.1）
 */
export async function buildStats(ctx) {
  const { items, fromIndex } = await listItems(ctx);
  const sizes = await sizeSnapshot(ctx);
  const workspaces = workspacesOf(ctx);
  const trashed = trashedIds(ctx);
  return { fromIndex, ...aggregateStats({ items, sizes, workspaces, trashed }) };
}

/**
 * 注册统计路由：`GET /api/session-conductor/stats`。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @returns {void}
 */
export function registerStatsRoutes({ webServer, ctx }) {
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/stats",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "GET") {
          return send(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
        }
        const stats = await buildStats(ctx);
        return send(res, 200, { ok: true, ...stats });
      } catch (error) {
        return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(error?.message ?? error) } });
      }
    },
  });
}
