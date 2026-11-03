// dsh-session-conductor — 会话 id 的写法归一（公共底座）
//
// 【为什么需要】同一个会话有两种合法写法：`session-<uuid>` 和裸 `<uuid>`。
// 磁盘上两种都存在——主会话目录名带前缀，子代理/成员会话目录名是裸 uuid——
// 所以既不能强制统一成一种，也不能只认一种。调用方（工具、路由、成员定位）
// 各自手写过 `slice(8)` / `replace(/^session-/, "")`，行为还不一致：
// 有的入口给裸 id 能通、给带前缀的就找不到，反之亦然。
//
// 【本模块的约定】
//   · 比较一律按「裸形式」（bare）进行，不受前缀影响
//   · 返回给调用方的 id 永远是**磁盘/索引里真实存在的那一种**，不做改写
//   · 前缀匹配（用户只给 id 开头一截）同样按 bare 比较，避免
//     `62d1…` 匹配不到 `session-62d1…`
//
// 【不做的事】这里不猜、不纠错：匹配不到就返回 null，由调用方按原样报错。

/** 会话 id 的可选前缀（主会话目录名用它，子代理会话不用）。 */
export const SESSION_ID_PREFIX = "session-";

/**
 * 去掉前缀，用于比较。
 * @param {unknown} id 任意输入
 * @returns {string} 裸形式（无前缀）；输入无效返回空串
 */
export function bareSessionId(id) {
  const text = String(id ?? "").trim();
  if (text === "") return "";
  return text.startsWith(SESSION_ID_PREFIX) ? text.slice(SESSION_ID_PREFIX.length) : text;
}

/**
 * 同一会话的两种合法写法（去重、保序）。
 * @param {unknown} id 任意输入
 * @returns {string[]} `[原样, 另一种]`；输入无效返回空数组
 */
export function sessionIdVariants(id) {
  const text = String(id ?? "").trim();
  if (text === "") return [];
  const bare = bareSessionId(text);
  if (bare === "") return [];
  const prefixed = SESSION_ID_PREFIX + bare;
  return text.startsWith(SESSION_ID_PREFIX) ? [prefixed, bare] : [bare, prefixed];
}

/**
 * 两个 id 是否指同一个会话（忽略前缀差异）。
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameSessionId(left, right) {
  const a = bareSessionId(left);
  const b = bareSessionId(right);
  return a !== "" && a === b;
}

/**
 * 在一个已知 id 集合里匹配用户给的目标（完整匹配优先，其次前缀匹配）。
 *
 * @param {Iterable<string>} knownIds 真实存在的 id 集合
 * @param {unknown} want 用户给的目标（可带前缀、可以是前缀片段、可以带空格）
 * @returns {{id: string} | {candidates: string[]} | null}
 *          `{id}` 唯一命中；`{candidates}` 多个命中（交给调用方展示，不猜）；`null` 未命中
 */
export function matchSessionId(knownIds, want) {
  const raw = String(want ?? "").trim();
  if (raw === "") return null;
  const list = [...knownIds].filter((id) => typeof id === "string" && id !== "");
  if (list.length === 0) return null;

  const wanted = bareSessionId(raw);
  if (wanted === "") return null;

  // ① 完整匹配（按裸形式比较，两种写法都算命中）
  const exact = list.filter((id) => bareSessionId(id) === wanted);
  if (exact.length === 1) return { id: exact[0] };
  if (exact.length > 1) return { candidates: exact };

  // ② 前缀匹配（同样按裸形式，这样 `62d1` 能命中 `session-62d1…`）
  const byPrefix = list.filter((id) => bareSessionId(id).startsWith(wanted));
  if (byPrefix.length === 1) return { id: byPrefix[0] };
  if (byPrefix.length > 1) return { candidates: byPrefix };
  return null;
}

/**
 * 把用户给的目标归一成**真实存在**的那一种写法（找不到就原样返回）。
 *
 * 查询顺序：内存里的活跃会话 → 落盘列表索引。两者都是 O(1) 量级的查找，
 * 不像全目录扫描那样会把事件循环钉住，因此可以直接放在路由/工具入口。
 *
 * @param {object} ctx 插件 context
 * @param {unknown} want 用户给的目标
 * @returns {Promise<string>} 真实的 id；找不到时返回去空格后的原输入（交由业务层报错）
 */
export async function canonicalSessionId(ctx, want) {
  const raw = String(want ?? "").trim();
  if (raw === "") return raw;

  // ① 内存里的活跃会话（最快，且能覆盖「刚建还没落盘」的会话）
  try {
    const sessions = ctx?.get?.("sessions");
    for (const variant of sessionIdVariants(raw)) {
      if (sessions?.get?.(variant)) return variant;
    }
  } catch {
    // 服务不可用：继续查落盘索引
  }

  // ② 落盘列表索引（覆盖已归档/未挂载的会话）
  try {
    const { loadListDiskCache } = await import("./list-cache.js");
    const entries = loadListDiskCache(ctx)?.entries ?? {};
    for (const variant of sessionIdVariants(raw)) {
      if (entries[variant]) return variant;
    }
  } catch {
    // 索引不可用：按原值继续
  }

  return raw;
}
