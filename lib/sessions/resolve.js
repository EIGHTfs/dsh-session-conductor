// dsh-session-conductor — 会话目标解析（公共底座）
//
// 【为什么抽出来】「用户/AI 给一个模糊的目标（id / id 前缀 / 标题 / 成员名），解析成确切 sessionId」
// 这件事原先只写在记忆取回里（`resolveSessionTarget`），成员轨迹又自己接了一套，两边各有缺口。
//
// 【原先的缺陷】旧实现判断「这是不是一个会话目录」用的是 `dir.startsWith("session-")`。
// 主会话的目录名确实是 `session-<uuid>` 形式，**但子代理/成员会话的目录名是裸 UUID**
// （例如 `c9a6a72c-908e-4040-b88c-2e6ce5014378`）。于是成员会话永远进不了候选集，
// 完整 id 和 id 前缀都解析不出来，工具只好报「找不到目标会话」。
//
// 【现在的判据】不看目录名叫什么，只看**里面有没有会话日志文件**（`findSessionLog`）——
// 这是宿主自己也用的判据，且与目录命名规则解耦（v0/v3/v4 各格式都能识别）。
//
// 【为什么异步】会话目录可能上千个；同步 stat/readdir 会把事件循环钉住，拖慢整个宿主。
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { findSessionLog } from "../session-log.js";
import { sessionsRootOf } from "./events.js";

/**
 * 列出全部会话 id（按「目录里有会话日志」判断，不看目录名前缀）。
 *
 * @param {string} root 会话根目录
 * @returns {Promise<string[]>}
 */
async function listSessionIds(root) {
  const ids = [];
  const isDir = async (p) => {
    try { return (await stat(p)).isDirectory(); } catch { return false; }
  };
  if (!root || !(await isDir(root))) return ids;
  for (const group of await readdir(root)) {
    const groupPath = join(root, group);
    if (!(await isDir(groupPath))) continue;
    for (const dir of await readdir(groupPath)) {
      const dirPath = join(groupPath, dir);
      if (!(await isDir(dirPath))) continue;
      // 关键：用「有没有日志文件」而不是「目录名像不像 session-xxx」
      if (findSessionLog(dirPath)) ids.push(dir);
    }
  }
  return ids;
}

/**
 * 把一个模糊目标解析成会话 id。支持：完整 id → id 前缀 → 标题子串。
 *
 * 多个命中时**不猜**，返回候选清单交给调用方展示。
 *
 * @param {object} ctx 插件 context（用于落盘索引里的标题）
 * @param {string} want 用户给的目标
 * @param {string} [selfId] 当前会话 id（等于它时直接返回）
 * @param {{root?: string}} [opts]
 * @returns {Promise<{id: string, title?: string|null} | {candidates: Array<{id: string, title?: string|null}>} | null>}
 *          null = 三段都没命中
 */
export async function resolveSessionId(ctx, want, selfId, opts = {}) {
  const raw = String(want ?? "").trim();
  if (!raw) return null;
  if (selfId && raw === selfId) return { id: selfId };

  const root = opts.root ?? sessionsRootOf();
  const ids = await listSessionIds(root);

  if (ids.includes(raw)) return { id: raw };
  const byPrefix = ids.filter((id) => id.startsWith(raw));
  if (byPrefix.length === 1) return { id: byPrefix[0] };
  if (byPrefix.length > 1) return { candidates: byPrefix.map((id) => ({ id })) };

  // 标题子串：只查落盘索引（避免为了解析一个参数去逐份读日志）
  try {
    const { loadListDiskCache } = await import("./list-cache.js");
    let entries = {};
    try { entries = loadListDiskCache(ctx)?.entries ?? {}; } catch { entries = {}; }
    const lower = raw.toLowerCase();
    const byTitle = Object.entries(entries)
      .filter(([, e]) => String(e?.title ?? "").toLowerCase().includes(lower))
      .map(([id, e]) => ({ id, title: e?.title ?? null }));
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) return { candidates: byTitle };
  } catch {
    // 索引不可用：退化为只按 id 解析
  }
  return null;
}

/**
 * 解析目标会话，**额外支持 Team 成员名**。
 *
 * 成员名是日常最顺手的写法（`read_member_trace({ session: "writer" })`），但成员名既不是会话 id
 * 也不是会话标题，通用解析认不了。这里在通用解析未命中时补一层成员解析。
 *
 * 用动态 `import()` 引成员定位：`sessions/` 是本插件底层，`features/member-model/` 是上层，
 * 静态引用会形成层级倒置；且宿主没装 agent-team 时成员解析本就不可用，动态导入让那种情况自然降级。
 *
 * @param {object} ctx 插件 context
 * @param {string} want 用户给的目标
 * @param {string} [selfId] 当前会话 id
 * @param {{root?: string, agent?: object}} [opts] agent 用于成员名册的作用域（缺省按全局名册）
 * @returns {Promise<{id: string, title?: string|null, matched?: string} | {candidates: Array<{id: string, title?: string|null}>} | null>}
 */
export async function resolveTargetSession(ctx, want, selfId, opts = {}) {
  const direct = await resolveSessionId(ctx, want, selfId, opts);
  if (direct) return direct;

  try {
    const { findTargetAgent } = await import("../features/member-model/locate.js");
    const found = findTargetAgent(ctx, want, { caller: opts.agent ?? null });
    if (found?.sessionId) return { id: found.sessionId, matched: found.matched ?? "成员名" };
    if (found?.error && /匹配到 \d+ 个/.test(String(found.error))) {
      // 成员名模糊命中多个：把它转成候选清单，保持「不猜」的一致行为
      const ids = [...String(found.error).matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)]
        .map((m) => ({ id: m[1] }));
      if (ids.length > 1) return { candidates: ids };
    }
  } catch {
    // 成员解析不可用：按未命中处理，由调用方给出统一报错
  }
  return null;
}
