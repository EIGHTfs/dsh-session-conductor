// dsh-session-conductor — 跨会话消息域：常量、纯函数与本体调用辅助
//
// 【本文件职责】只放「不注册工具」的部分：限额常量、会话列表渲染、限流状态机、
// 以及所有对本体 `sessionController` 的调用封装。工具定义在 tools.js，域出口在 index.js。
//
// 【为什么全部走本体官方 API，而不是自己写会话日志】
//   本体把「投递一条消息给某个会话」做成一等公民：session-controller 的
//   `@Remote('prompt')`，其受理流程**会先 resume 目标会话**（唤醒语义由本体保证），
//   且请求带 `requestId` 幂等键（本体把它持久化在那条被接受的消息上）。
//   反面：会话日志里 inbox 家族**只有 `agent/inbox/spliced` 落盘**，而它的 fold
//   对非法 splice **直接抛错**（message.id 重复、start 越界都会让整份会话读不出来）
//   —— 自己写日志等于拿对方会话的完整性冒险。因此本域**不碰任何日志文件**。

import { log } from "../../shared/log.js";
import { sessionMetaOf } from "../../sessions/lookup.js";

/** 单条消息长度上限（字符）：够写交接要点，不够塞长文档（长内容应落共享文件）。 */
export const TEXT_LIMIT = 8 * 1024;
/** 协作链跳数上限：到了就说明该改用共享文件交接，而不是继续互相投递。 */
export const HOPS_LIMIT = 3;
/** 限流窗口与条数：同一对会话在该窗口内最多投这么多条，防互相唤醒风暴。 */
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX = 5;
/** 本体 prompt 受理是本地操作，给足超时但别无限等。 */
export const PROMPT_TIMEOUT_MS = 60_000;

// list_sessions 的分页默认值：会话多时整表输出会白烧调用方上下文，
// 所以默认只给一页（20 条），需要更多用 offset 翻页、或先用 query 收窄。
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;

// ── 纯函数 ────────────────────────────────────────────────────────────────

/** 会话条目 → 状态词（running=正在跑回合 / idle=已挂载空闲 / inactive=冷会话）。 */
export function statusOf(item) {
  if (item?.running) return "running";
  return item?.live ? "idle" : "inactive";
}

/** 时间戳 → 本地可读时间（无值时不假装有值）。 */
export function formatTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "(未知)";
  try {
    return new Date(n).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(n);
  }
}

/**
 * 把会话列表渲染成给 AI 看的文本（纯函数，便于单测）。
 * @param items buildSessionListCached 的产出
 * @param selfId 当前会话 id（用于标出「当前会话」，可为 null）
 * @returns {string} 多行文本；空列表时返回固定提示
 */
/**
 * 把会话列表格式化为工具输出（支持子串过滤 + 分页）。
 *
 * 【为什么要分页/过滤】会话多了以后整表输出会白烧 AI 上下文（本机实测 80+ 会话一次输出
 * 上百行）；调用方通常只需要「找目标」这一件事，因此默认由工具侧给一个小 limit，
 * 需要更多再用 offset 翻页，或先用 query 收窄。
 *
 * @param {Array} items buildSessionListCached 的产出
 * @param {string} selfId 当前会话 id（用于标注「← 当前会话」）
 * @param {object} [opts] limit（本页条数；不传=全部，保持既有调用方语义）/ offset / query（子串，不区分大小写）
 * @returns {string} 多行文本
 */
export function formatSessionList(items, selfId, opts = {}) {
  const all = Array.isArray(items) ? items : [];
  // 防御：会话列表构建偶尔会混入缺 id 的脏条目（实测见过一条），直接渲染会输出
  // 「undefined ｜ (无标题) …」误导调用方 —— 这里按 id 过滤，并如实报告跳过了几条。
  const usable = all.filter((item) => item && typeof item.id === "string" && item.id !== "");
  const skipped = all.length - usable.length;
  if (usable.length === 0) {
    return skipped > 0 ? `没有可用会话（${skipped} 条缺 id 的脏数据已跳过）。` : "没有可见会话。";
  }
  // 子串过滤：id / 标题 / 工作区 任一命中即可（会话一多，先收窄再翻页比整表更省）
  const rawQuery = typeof opts.query === "string" ? opts.query.trim() : "";
  const matched = rawQuery
    ? usable.filter((item) => `${item.id} ${item.title ?? ""} ${item.cwd ?? ""}`.toLowerCase().includes(rawQuery.toLowerCase()))
    : usable;
  if (matched.length === 0) {
    return `没有匹配「${rawQuery}」的会话（共 ${usable.length} 个）。`;
  }
  // 分页：不传 limit = 全部（保持既有调用方语义）；offset 越界时给空页提示而不是报错
  const total = matched.length;
  const limit = Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : total;
  const offset = Number.isSafeInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  const page = matched.slice(offset, offset + limit);
  if (page.length === 0) {
    return `offset ${offset} 超出范围（共 ${total} 个会话，本页 0 条）。`;
  }
  const lines = page.map((item) => {
    const flags = [statusOf(item)];
    if (item?.archived) flags.push("已归档");
    if (selfId && item?.id === selfId) flags.push("← 当前会话");
    return `- ${item.id} ｜ ${String(item?.title ?? "(无标题)")} ｜ ${String(item?.cwd ?? "(无工作区)")}`
      + ` ｜ ${flags.join(" / ")} ｜ 最后活动 ${formatTime(item?.updatedAt)}`;
  });
  const scope = rawQuery ? `（匹配「${rawQuery}」）` : "";
  const head = `共 ${total} 个会话${scope}，本页 ${page.length} 条（offset ${offset}）：`;
  const remaining = total - offset - page.length;
  const more = remaining > 0 ? `\n还有 ${remaining} 条，用 offset=${offset + page.length} 取下一页。` : "";
  const tail = skipped > 0 ? `\n（另有 ${skipped} 条缺 id 的脏数据已跳过）` : "";
  return `${head}\n${lines.join("\n")}${more}${tail}`;
}

/** 把远端错误压成「短码: 原文」一行，便于回执如实说明失败原因。 */
export function shortError(error) {
  const code = error?.code ?? error?.name ?? "";
  const msg = String(error?.message ?? error);
  return code ? `${code}: ${msg}` : msg;
}

/** 本体错误码 → 本工具回执的短码（认不出就标 unknown，不臆造）。 */
export function mapPromptError(error) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
  if (/session\/not-found/.test(text)) return "session-not-found";
  if (/session\/agent-busy/.test(text)) return "target-busy";
  if (/session\/model-unavailable/.test(text)) return "target-no-model";
  if (/gateway\/bad-request/.test(text)) return "bad-request";
  if (/session\/attachment-invalid/.test(text)) return "attachment-invalid";
  if (/session\/invalid-time-zone/.test(text)) return "bad-time-zone";
  return "unknown";
}

// ── 会话/调用方身份 ───────────────────────────────────────────────────────

/** 取本体 sessionController 服务（本插件既有取法，见 features/member-model/switch.js）。 */
export function sessionControllerOf(ctx) {
  try {
    return ctx.get?.("sessionController") ?? null;
  } catch {
    return null;
  }
}

/** 当前会话 id（用于禁自投与 isSelf 标记）。 */
export function currentSessionId(agent) {
  return agent?.session?.id ?? null;
}

/**
 * 调用方会话的工作目录。
 * 用途：`create_session` 不传 cwd/workspaceId 时的缺省值 —— 新会话落在**发起它的那个会话**
 * 的工作目录里，而不是本体的默认 cwd（实测是 DSH 安装目录（即本机程序目录），
 * 对干活毫无意义）。
 */
export function callerCwd(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : "";
}

/**
 * 懒加载会话列举。
 * 为什么不在顶层 import：`sessions/list.js` 会拉起 `core/domain.js` →
 * `@deepseek-ai/dsh-storage-domain`（宿主包），工作区里解析不到 ⇒ 本模块将无法被单测
 * 直接 import。改为用到时再加载，行为不变但模块可独立测试（同 apply.js 的懒加载思路）。
 */
export async function listSessions(ctx) {
  const { buildSessionListCached } = await import("../../sessions/list.js");
  return buildSessionListCached(ctx, {});
}

/**
 * best-effort 描述目标会话（dryRun 用）：报告状态与工作区。
 *
 * 【必须只查便宜来源】内存里的 live 会话 → 落盘索引（list-cache.json）。
 * 曾经这里调 listSessions()（= 全量列表构建），冷缓存时一次 dryRun 预检要 41~226 秒 ——
 * 「校验 + 预览」本该是毫秒级的事，却变成卡死。预检的正确成本上限是「读一次内存/索引」，
 * 不是「扫一遍所有会话日志」；查不到就如实说查不到，不为了补一个状态字段去付全量代价。
 * 列表不可用时如实说明原因，**不阻断**（dryRun 的价值在于「早知道」）。
 */
export async function describeTarget(ctx, sessionId) {
  try {
    const meta = await sessionMetaOf(ctx, sessionId);
    if (!meta) return "（⚠️ 内存与落盘索引里都没有这个 id —— 可能写错了，或它是刚建、尚未落盘的会话）";
    if (meta.live) return `（进行中 ｜ ${String(meta.cwd ?? "(无工作区)")}）`;
    const updated = meta.updatedAt ? new Date(meta.updatedAt).toISOString() : "未知";
    return `（已落盘 ｜ ${String(meta.cwd ?? "(无工作区)")} ｜ 最后活动 ${updated}）`;
  } catch (error) {
    return `（目标存在性无法核对：${shortError(error)}）`;
  }
}

/**
 * 在模型目录里核对 provider/model 是否存在（dryRun 用，best-effort）。
 * @returns {Promise<{checked:boolean, found:boolean, hint:string}>} 目录不可用时 checked=false，不阻断。
 */
export async function checkModelPair(sc, provider, model) {
  try {
    if (typeof sc?.modelCatalog !== "function") {
      return { checked: false, found: false, hint: "本体未提供 modelCatalog，无法预校验" };
    }
    const catalog = await sc.modelCatalog();
    const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
    if (!group) {
      return { checked: true, found: false, hint: `provider「${provider}」不在模型目录里（先用 list_models 查）` };
    }
    const hit = (group.models ?? []).some((m) => m?.id === model);
    return {
      checked: true,
      found: hit,
      hint: hit ? "" : `model「${model}」不在 provider「${provider}」下（先用 list_models 查）`,
    };
  } catch (error) {
    return { checked: false, found: false, hint: `模型目录查询失败：${shortError(error)}` };
  }
}

// ── 限流与在途去重（进程内；重启即清空，不落盘）────────────────────────────

/** `${from}->${to}` → 投递时间戳数组。 */
const rateBuckets = new Map();
/** 正在投递的 requestId（防同一请求并发重复）。 */
const inFlight = new Set();

/** 测试用：清空限流与在途状态。 */
export function resetMessagingStateForTest() {
  rateBuckets.clear();
  inFlight.clear();
}

/** 同一对会话是否已超限（未超则记一次）。 */
export function hitRateLimit(from, to, now = Date.now()) {
  const key = `${from ?? "?"}->${to}`;
  const hits = (rateBuckets.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return false;
}

/** 只读探测限流状态（dryRun 用：报告「会不会被限流」，但不消耗配额）。 */
export function peekRateLimit(from, to, now = Date.now()) {
  const key = `${from ?? "?"}->${to}`;
  const hits = (rateBuckets.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  return { limited: hits.length >= RATE_MAX, used: hits.length };
}

/** 在途表是否已有该 requestId（真投前查重用）。 */
export function isInFlight(requestId) {
  return inFlight.has(requestId);
}

/** 标记/解除在途（真投前后各一次）。 */
export function markInFlight(requestId) {
  inFlight.add(requestId);
}

export function clearInFlight(requestId) {
  inFlight.delete(requestId);
}

/** 生成幂等键：本体把它持久化在那条被接受的消息上，重试传同键不会重复投递。 */
export function newRequestId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `sc-${Date.now().toString(36)}-${rand}`;
}

// ── 本体调用封装 ──────────────────────────────────────────────────────────

/** 文本 → 本体要求的 content 块数组（字段名以 types.ts 的 PromptContentPart 为准）。 */
export function contentOf(text) {
  return [{ type: "text", text: String(text) }];
}

/**
 * 投递一条消息到目标会话（走本体官方 prompt；目标空闲时会被 resume 唤醒）。
 *
 * 【为什么自动加发送者标记】本体 prompt 只带正文，接收方看不到「这条是谁发的」——实测出现过
 * 「A 会话投递的消息，B 会话以为是当前这一方发的」。这里统一在正文头部加一行
 * `【来自会话 <sessionId>】`，id 由调用方从 `currentSessionId(exec.agent)` 取，**不需要 AI 自己写**。
 */
export function deliverPrompt(sc, { sessionId, text, mode, requestId, from }) {
  const body = from ? `【来自会话 ${from}】\n${String(text ?? "")}` : String(text ?? "");
  // 本体签名是 prompt(request, signal)：signal 必传（内部会 throwIfAborted）。
  return sc.prompt(
    { requestId, sessionId, mode, content: contentOf(body) },
    AbortSignal.timeout(PROMPT_TIMEOUT_MS),
  );
}

/** 记一行插件日志（工具执行路径用；薄封装便于以后统一改格式）。 */
export function logMessaging(ctx, message) {
  log(ctx, message);
}
