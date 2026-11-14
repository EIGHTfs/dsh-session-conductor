// dsh-session-conductor — 会话统计聚合（纯函数，零依赖）
//
// 【为什么单独成文件】取数链路会经 `sessions/list.js` 拉起 `core/domain.js`，而单测环境
// 没有可选 peer `@deepseek-ai/dsh-storage-domain` —— 聚合逻辑留在路由里就根本 import 不进来。
// 拆成零依赖叶子后，聚合规则（分桶、日期窗口、缺失值语义）可以独立断言。
//
// 【体积缺失的语义】拿不到 `sizeBytes` 时**整体退化为 null，不写 0**：
// 0 会被读成「这些会话的日志是空的」，而实际是「不知道」。同理部分会话拿不到时
// 仍给总和，但用 `bytesComplete: false` 标明覆盖不全，避免把它当精确值引用。

/** 活跃度默认回看天数。 */
export const DEFAULT_ACTIVITY_DAYS = 14;
/** 体积榜默认条数。 */
export const DEFAULT_LARGEST_LIMIT = 10;

/**
 * 把时间戳格式化成 `YYYY-MM-DD`（本地时区）。
 *
 * 【为什么手写补零】宿主 Node 是 small-icu 构建，`toLocaleDateString('sv-SE')` 这类
 * 「靠 locale 天然产出 ISO 格式」的写法会退化成 `11/14/2026`（实测），跨机器不可靠。
 * 手写年月日拼装不依赖任何 locale 数据。
 *
 * @param {number} time 毫秒时间戳
 * @returns {string}
 */
export function dayKey(time) {
  const date = new Date(time);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 把 `{id: bytes}` 映射里的值汇总成总和 + 完整度。
 * @param {Array<string>} ids 需要汇总的会话 id
 * @param {Record<string, number>} sizes 会话 id → 字节数（缺失即 undefined）
 * @returns {{bytes: number|null, bytesComplete: boolean}}
 */
export function sumBytes(ids, sizes) {
  if (ids.length === 0) return { bytes: 0, bytesComplete: true };
  let total = 0;
  let known = 0;
  for (const id of ids) {
    const value = Number(sizes?.[id]);
    if (Number.isFinite(value) && value >= 0) {
      total += value;
      known += 1;
    }
  }
  // 一个都拿不到 → 不知道（null），不是 0
  if (known === 0) return { bytes: null, bytesComplete: false };
  return { bytes: total, bytesComplete: known === ids.length };
}

/**
 * 按工作区分桶：注册表 `sessionIds` 优先，`cwd` 最深祖先兜底。
 *
 * 【为什么注册表优先】会话 cwd 不可变；只按 cwd 分桶的话，「被拖进别组」的会话
 * 刷新一次就会弹回原组。注册表是会话归属的唯一真相，cwd 只用来兜住没登记的会话。
 *
 * @param {Array<object>} sessions 会话列表（{id, cwd}）
 * @param {Array<object>|null} workspaces 工作区列表（{id, title, path, sessionIds}）
 * @returns {Array<{id: string, title: string, paths: string[], sessionIds: string[]}>}
 */
export function bucketByWorkspace(sessions, workspaces) {
  const known = Array.isArray(workspaces) ? workspaces.filter((w) => w && w.id) : [];
  const byId = new Map(known.map((w) => [String(w.id), {
    id: String(w.id),
    title: String(w.title ?? w.path ?? w.id),
    paths: w.path ? [String(w.path)] : [],
    sessionIds: [],
  }]));

  // 注册表登记的归属优先
  for (const workspace of known) {
    const bucket = byId.get(String(workspace.id));
    for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
      if (!bucket.sessionIds.includes(String(id))) bucket.sessionIds.push(String(id));
    }
  }

  // 没登记的会话按 cwd 归到「路径前缀最长」的工作区
  const claimed = new Set(known.flatMap((w) => (Array.isArray(w.sessionIds) ? w.sessionIds.map(String) : [])));
  const ungrouped = { id: '', title: '未分组', paths: [], sessionIds: [] };
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const id = String(session?.id ?? '');
    if (id === '' || claimed.has(id)) continue;
    const cwd = session?.cwd ? String(session.cwd) : '';
    let best = null;
    let bestLength = -1;
    for (const workspace of known) {
      const base = workspace.path ? String(workspace.path) : '';
      if (base === '' || cwd === '') continue;
      const prefix = base.endsWith('/') ? base : `${base}/`;
      if (cwd === base || cwd.startsWith(prefix)) {
        if (base.length > bestLength) { best = workspace; bestLength = base.length; }
      }
    }
    if (best) byId.get(String(best.id)).sessionIds.push(id);
    else ungrouped.sessionIds.push(id);
  }

  const buckets = [...byId.values()];
  if (ungrouped.sessionIds.length > 0) buckets.push(ungrouped);
  return buckets;
}

/**
 * 生成统计快照。
 *
 * @param {object} input
 * @param {Array<object>} input.sessions 会话列表（{id, title, cwd, updatedAt, archived, live}）
 * @param {Array<object>|null} [input.workspaces] 工作区列表（null = 宿主无分组能力）
 * @param {Record<string, number>} [input.sizes] 会话 id → 日志字节数（缺失即未知）
 * @param {number} [input.now] 当前时间（默认取真实时间，测试可注入）
 * @param {number} [input.activityDays] 活跃度回看天数
 * @param {number} [input.largestLimit] 体积榜条数
 * @returns {{generatedAt: number, totals: object, byWorkspace: Array<object>, activity: Array<object>, largest: Array<object>}}
 */
export function aggregateStats({
  sessions,
  workspaces = null,
  sizes = {},
  now = Date.now(),
  activityDays = DEFAULT_ACTIVITY_DAYS,
  largestLimit = DEFAULT_LARGEST_LIMIT,
} = {}) {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.id);
  const ids = list.map((s) => String(s.id));
  const all = sumBytes(ids, sizes);

  const totals = {
    sessions: list.length,
    active: list.filter((s) => s.archived !== true).length,
    archived: list.filter((s) => s.archived === true).length,
    live: list.filter((s) => s.live === true).length,
    bytes: all.bytes,
    bytesComplete: all.bytesComplete,
  };

  const byWorkspace = bucketByWorkspace(list, workspaces).map((bucket) => {
    const bytes = sumBytes(bucket.sessionIds, sizes);
    return {
      id: bucket.id,
      title: bucket.title,
      sessions: bucket.sessionIds.length,
      bytes: bytes.bytes,
      bytesComplete: bytes.bytesComplete,
    };
  }).sort((a, b) => b.sessions - a.sessions);

  // 活跃度：最近 N 天每天有多少条会话有活动（按 updatedAt 落桶）
  const days = [];
  const dayMap = new Map();
  for (let offset = Math.max(0, activityDays) - 1; offset >= 0; offset -= 1) {
    const key = dayKey(now - offset * 24 * 60 * 60 * 1000);
    days.push(key);
    dayMap.set(key, 0);
  }
  for (const session of list) {
    const updatedAt = Number(session.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
    const key = dayKey(updatedAt);
    if (dayMap.has(key)) dayMap.set(key, dayMap.get(key) + 1);
  }
  const activity = days.map((day) => ({ day, count: dayMap.get(day) ?? 0 }));

  // 体积榜：只收真正拿到大小的会话（拿不到的进榜没有意义）
  const largest = list
    .map((session) => ({ id: String(session.id), title: String(session.title ?? session.id), bytes: Number(sizes?.[session.id]) }))
    .filter((item) => Number.isFinite(item.bytes) && item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, Math.max(1, largestLimit));

  return { generatedAt: now, totals, byWorkspace, activity, largest };
}
