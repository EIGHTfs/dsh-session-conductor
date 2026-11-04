// 会话的上下文窗口（context window）—— 单文件、零依赖、可整段复制到别的插件。
//
// 【为什么需要】DSH 里「这条会话能装多少 token」有两个来源，各自都有坑：
//   ① `session.requestContext()?.contextWindow` —— 同步、最贴当前请求，
//      但它是 `request/context` 事件 fold 出来的，**会话还没发过请求时是空的**；
//   ② `llm.resolveModelInfo(provider, model)` → `info.context.contextWindow` ——
//      权威，但要 provider/model，而且是异步的。
// 只写 ①，冷会话/新会话拿不到；只写 ②，同步调用点（比如压缩前的门禁判定）用不了。
// 所以这里做成「① → ② → 调用方兜底」的三级回退，并且把异步结果按 provider/model 缓存。
//
// 【设计约束】（想被别的插件直接抄走，就必须守住）
//   · 不 import 本仓库任何模块，只用 `ctx.get(...)` 这类 cordis 通用约定
//   · 不写死任何路径、URL、模型名；默认值一律具名常量，且可由参数覆盖
//   · 任何异常都不外抛：拿不到就返回 undefined，由调用方决定怎么兜底
//     （窗口缺失不该让「撤销会话」「修复日志」这类能力整体失败）
//   · 缓存键是 provider/model 而不是 sessionId —— 同一模型窗口相同，
//     而会话切模型后窗口会变，按会话缓存会串味
//
// 【复制到别的插件时】整份文件拷走即可；只有 `ctx` 一个外部依赖，
// 传 `undefined` 也能工作（自动退化成「只用同步值」）。

/** 异步解析结果的缓存时长：窗口随模型切换变化，不宜长缓存。 */
const DEFAULT_CACHE_TTL_MS = 60_000;

/** 缓存条目上限：避免长时间运行时无界增长（模型数量有限，正常远达不到）。 */
const DEFAULT_CACHE_MAX_ENTRIES = 64;

/**
 * 只读同步窗口：来自最近一次 `request/context` 事件。
 *
 * @param {object} session 宿主 Session（含 `requestContext()`）
 * @returns {number|undefined} 正数窗口；未声明或异常时为 undefined
 */
export function contextWindowOfSession(session) {
  try {
    const value = session?.requestContext?.()?.contextWindow;
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从请求头里取当前路由（provider/model）。窗口的权威值需要它。
 *
 * @param {object} session 宿主 Session（含 `requestHeader()`）
 * @returns {{provider: string, model: string}|undefined}
 */
export function routeOfSession(session) {
  try {
    const config = session?.requestHeader?.()?.config;
    const provider = config?.provider;
    const model = config?.model;
    if (typeof provider !== 'string' || provider === '') return undefined;
    if (typeof model !== 'string' || model === '') return undefined;
    return { provider, model };
  } catch {
    return undefined;
  }
}

/**
 * 创建一个「按 provider/model 缓存」的异步窗口解析器。
 *
 * @param {object} [options]
 * @param {object} [options.ctx] cordis 上下文（用来 `ctx.get('llm')`；缺省则只走同步值）
 * @param {number} [options.ttlMs] 缓存时长
 * @param {number} [options.maxEntries] 缓存条目上限
 * @param {() => number} [options.now] 时钟注入（测试用）
 * @returns {(route: {provider: string, model: string}) => Promise<number|undefined>}
 */
export function createContextWindowResolver(options = {}) {
  const ctx = options.ctx;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_CACHE_TTL_MS;
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
    ? Math.floor(options.maxEntries)
    : DEFAULT_CACHE_MAX_ENTRIES;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  /** @type {Map<string, {value: number|undefined, at: number}>} */
  const cache = new Map();

  return async function resolveContextWindow(route) {
    const provider = route?.provider;
    const model = route?.model;
    if (typeof provider !== 'string' || provider === '') return undefined;
    if (typeof model !== 'string' || model === '') return undefined;

    const key = `${provider}/${model}`;
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < ttlMs) return hit.value;

    let value;
    try {
      const llm = ctx?.get?.('llm');
      if (llm && typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(provider, model);
        const candidate = info?.context?.contextWindow;
        if (Number.isFinite(candidate) && candidate > 0) value = candidate;
      }
    } catch {
      // 目录不可用 / 模型不存在 / 版本不支持：按「未声明」处理，交给调用方兜底
      value = undefined;
    }

    if (cache.size >= maxEntries) cache.clear();
    cache.set(key, { value, at: now() });
    return value;
  };
}

/**
 * 组合取值：同步值 → 异步权威值 → 调用方兜底。
 *
 * 顺序说明：**先同步**。`requestContext()` 反映的是「刚刚实际发出去的那次请求」，
 * 而 `resolveModelInfo(route)` 是按当前路由查目录；会话刚切模型、还没发请求时，
 * 同步值仍是旧模型的窗口，而目录已经是新模型 —— 那种情况下异步值更可信。
 * 所以这里给一个开关 `prefer`，默认 `'sync'`（多数调用点在请求之后），
 * 明确知道要按目录取值时传 `'resolve'`。
 *
 * @param {object} options
 * @param {object} [options.ctx] cordis 上下文
 * @param {object} [options.session] 宿主 Session
 * @param {number} [options.fallback] 都拿不到时的兜底值（调用方自己给，本模块不猜）
 * @param {'sync'|'resolve'} [options.prefer='sync'] 优先用哪一路
 * @param {(route: object) => Promise<number|undefined>} [options.resolve] 复用的解析器（省一次建缓存）
 * @returns {Promise<number|undefined>}
 */
export async function contextWindowOf(options = {}) {
  const { ctx, session, fallback } = options;
  const prefer = options.prefer === 'resolve' ? 'resolve' : 'sync';
  const syncValue = contextWindowOfSession(session);
  const route = routeOfSession(session);
  const resolver = typeof options.resolve === 'function'
    ? options.resolve
    : createContextWindowResolver({ ctx });

  let resolved;
  if (route !== undefined) resolved = await resolver(route);

  const picked = prefer === 'resolve'
    ? (resolved ?? syncValue)
    : (syncValue ?? resolved);

  if (Number.isFinite(picked) && picked > 0) return picked;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : undefined;
}
