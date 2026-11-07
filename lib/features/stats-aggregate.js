// 会话统计的**纯聚合**部分：不 import 任何宿主服务，因此可以在单测里直接跑。
//
// 【为什么单独一个文件】取数（读索引 / 调 persistence / 读工作区注册表）全都依赖宿主服务，
// 单测环境装不上 `@deepseek-ai/dsh-storage-domain`（可选 peer，宿主才提供）。
// 而「怎么数」恰恰是最容易错、最该被测的部分：口径错一位，用户看到的数字卡片就不对，
// 而且没人会去逐条复核。所以把它切成零依赖叶子模块，stats-routes.js 只负责取数 + 下发。

/** 直方图窗口：最近 N 天（含今天）。 */
const DAILY_WINDOW_DAYS = 14;
/** 「最占体积」榜单长度。 */
const LARGEST_TOP_N = 5;

/** 把任意时间（ms 数字 / ISO 字符串）归一成 epoch ms；拿不到就给 null。 */
function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 本地时区的 YYYY-MM-DD（统计按用户看到的「今天」算，不按 UTC）。 */
export function localDayKey(ms) {
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 最近 DAILY_WINDOW_DAYS 天的日期键（升序，含今天；没有活动的日子也占一行，图上不断档）。 */
export function recentDayKeys(now = Date.now()) {
  const keys = [];
  const today = new Date(now);
  for (let i = DAILY_WINDOW_DAYS - 1; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    keys.push(localDayKey(date.getTime()));
  }
  return keys;
}

/**
 * 纯聚合：不碰任何宿主服务，单测可直接喂假数据。
 * @param {object} input
 * @param {Array<object>} input.items 会话列表项（形状见 lib/sessions/list.js）
 * @param {Map<string, number>|null} input.sizes 会话 id → 日志字节数；null = 体积信息不可用
 * @param {Array<object>} input.workspaces 工作区列表（`{id, title, sessionIds}`）
 * @param {Set<string>} input.trashed 回收站里的会话 id
 * @param {number} [input.now] 基准时刻（单测固定「今天」用）
 * @returns {object} 统计对象（不含 fromIndex）
 */
export function aggregateStats({ items, sizes, workspaces, trashed, now = Date.now() }) {
  const list = Array.isArray(items) ? items : [];
  const trashedSet = trashed instanceof Set ? trashed : new Set();
  const sizeMap = sizes instanceof Map ? sizes : null;
  const workspaceList = Array.isArray(workspaces) ? workspaces : [];

  let live = 0;
  let archived = 0;
  let running = 0;
  let interrupted = 0;

  const byId = new Map();
  for (const item of list) {
    const id = item?.id;
    if (typeof id !== "string" || id === "") continue;
    byId.set(id, item);
    if (item.live) live += 1;
    if (item.archived) archived += 1;
    // running 与 interruption 互斥：正在跑的会话不是「中断」，两者的口径不能叠加。
    if (item.running) running += 1;
    else if (item.interruption) interrupted += 1;
  }

  // 按工作区分桶：注册表是归属的权威，列表里没被任何工作区认领的会话进「未分组」桶。
  const byWorkspace = [];
  const claimed = new Set();
  for (const workspace of workspaceList) {
    const ids = (workspace?.sessionIds ?? []).filter((id) => byId.has(id));
    for (const id of ids) claimed.add(id);
    let bytes = 0;
    if (sizeMap) for (const id of ids) bytes += sizeMap.get(id) ?? 0;
    byWorkspace.push({
      workspaceId: String(workspace?.id ?? ""),
      title: String(workspace?.title ?? workspace?.path ?? ""),
      count: ids.length,
      bytes: sizeMap ? bytes : null,
    });
  }
  const ungrouped = [...byId.keys()].filter((id) => !claimed.has(id));
  if (ungrouped.length > 0) {
    let bytes = 0;
    if (sizeMap) for (const id of ungrouped) bytes += sizeMap.get(id) ?? 0;
    byWorkspace.push({ workspaceId: "", title: "", count: ungrouped.length, bytes: sizeMap ? bytes : null });
  }
  byWorkspace.sort((a, b) => b.count - a.count);

  // 体积总计与「最占体积」榜单：sizes 为 null 时整块退化为 null / 空数组。
  let totalBytes = null;
  const topLargest = [];
  if (sizeMap) {
    totalBytes = 0;
    for (const [id, bytes] of sizeMap) {
      if (byId.has(id)) totalBytes += bytes;
    }
    const ranked = [...sizeMap.entries()]
      .filter(([id]) => byId.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, LARGEST_TOP_N);
    for (const [id, bytes] of ranked) {
      topLargest.push({ sessionId: id, title: String(byId.get(id)?.title ?? id), bytes });
    }
  }

  // 活跃直方图：按 updatedAt 归日。窗口外的活动不进入直方图（数字卡片另有总量）。
  const dayKeys = recentDayKeys(now);
  const dayCount = new Map(dayKeys.map((key) => [key, 0]));
  for (const item of byId.values()) {
    const ms = toMs(item.updatedAt);
    if (ms === null) continue;
    const key = localDayKey(ms);
    if (dayCount.has(key)) dayCount.set(key, dayCount.get(key) + 1);
  }

  return {
    total: byId.size,
    live,
    archived,
    running,
    interrupted,
    trashed: trashedSet.size,
    totalBytes,
    byWorkspace,
    daily: dayKeys.map((date) => ({ date, count: dayCount.get(date) ?? 0 })),
    topLargest,
  };
}
