// dsh-session-conductor — 记忆取回（memory-recall）
//
// 【解决什么】DSH 上下文被压缩、或重启后快照尚未加载时，AI 会「失忆」：重复提问、
// 重复劳动、误解需求。而用户消息文本在上下文里占比极小（1M 上下文里可能总共没超过 3 句），
// 却恰恰是最不该丢的部分 —— 本模块把这些消息文本（连同 AI 当时的首个回应）重新注入。
//
// 【怎么判「失忆」】每回合比较上下文已用量：本次比上次**明显下降**（默认 ≥10%，可配）即判定。
//   为什么不直接监测压缩：用量下降能覆盖所有「失去上下文」的形态 —— 压缩只是最常见一种；
//   例如实例重启后快照未加载时用量会掉到 0，那同样该按失忆处理。
//
// 【取什么】最近 N 轮（默认 3）的**用户消息文本** + 该轮 **AI 的第一条回应**（优先 reasoning）。
//   · 以用户消息为锚：消息文本占比小但信息密度最高，是恢复上下文的支点；
//   · 要 AI 的第一条回应：那是「当时」对消息文本的理解，直接给出结论，省得 AI 重新推测。
//   具体读取（按 zstd 帧流式、常量内存）在 sessions/events.js 的 readRecentUserTurns。
//
// 【怎么注入】走 apply.js 的 agent/pre-step + 官方 createUserMessage（logged 通道），
//   放在消息**尾部**（前缀保持稳定 ⇒ prompt cache 仍命中），与每轮用量注入**合并成一条**。
//
// 【失败即静默】日志缺失/损坏、用量读不到、首回合无上次用量 —— 一律返回 null，绝不阻断回合。
import { readRecentUserTurns } from "../../sessions/events.js";
import { log } from "../../shared/log.js";
import { cfg } from "../../core/config.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ── 用量记忆的**持久化**（解决「重启后不触发」）──────────────────────────────
// 只用内存 WeakMap 时实例一重启就清空 ⇒ 首个回合没有「上次用量」可比 ⇒
// 而重启后用量恰好是 0（快照未加载）—— **最该触发的场景反而永不触发**。
// 因此把每个会话的上次用量落盘（节流写），重启后读回来继续比较。
const STATE_SUB = ["storages", "dsh-session-conductor"];
const STATE_FILE = "recall-state.json";
const STATE_WRITE_THROTTLE_MS = 30_000;
let diskState = null; // { [sessionId]: { usedTokens, at } }
let diskLoaded = false;
let lastWriteAt = 0;
let statePathOverride = null; // 测试注入：显式指定状态文件路径（不依赖 DSH_HOME 环境变量）

/** 测试钩子：显式指定状态文件路径（传 null 恢复默认）。 */
export function setStatePathForTest(path) {
  statePathOverride = path ?? null;
}

/** 状态文件路径（随 DSH_HOME 走，不写死本机路径；拿不到 HOME 时返回空串 = 不落盘）。 */
function stateFilePath() {
  if (statePathOverride) return statePathOverride;
  const home = process.env.DSH_HOME || (process.env.HOME ? join(process.env.HOME, ".dsh") : "");
  return home ? join(home, ...STATE_SUB, STATE_FILE) : "";
}

/** 读落盘状态（进程内只读一次；任何异常都退化成空表，绝不向上抛）。 */
function loadDiskState() {
  if (diskLoaded) return diskState;
  diskLoaded = true;
  diskState = {};
  const file = stateFilePath();
  if (!file) return diskState;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) diskState = parsed;
  } catch {
    // 首次运行 / 文件损坏：按空表继续
  }
  return diskState;
}

/** 节流落盘（每 STATE_WRITE_THROTTLE_MS 至多一次；失败只留痕，不影响回合）。 */
function saveDiskStateThrottled(ctx) {
  const now = Date.now();
  if (now - lastWriteAt < STATE_WRITE_THROTTLE_MS) return;
  lastWriteAt = now;
  const file = stateFilePath();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(diskState), "utf8");
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    log(ctx, `记忆取回：用量状态落盘失败（不影响功能）: ${String(error?.message ?? error)}`);
  }
}

/** 测试钩子：重置落盘状态缓存（配合把 DSH_HOME 指向临时目录用）。 */
export function resetDiskStateForTest() {
  diskState = null;
  diskLoaded = false;
  lastWriteAt = 0;
}

/** 每会话上一次的用量。WeakMap：键（会话/agent 对象）被回收即自动释放，不会泄漏。 */
let lastUsageBySession = new WeakMap();

/** 读取某会话上一次记录的用量（测试与诊断用）。 */
export function takeLastUsage(key) {
  return key ? lastUsageBySession.get(key) ?? null : null;
}

/** 记录本次用量（供下一回合比较）。 */
export function noteUsage(key, usage) {
  if (key && usage) lastUsageBySession.set(key, usage);
}

/** 测试钩子：清空用量记忆（WeakMap 无法逐项清，直接换新实例）。 */
export function resetRecallStateForTest() {
  lastUsageBySession = new WeakMap();
}

/**
 * 判定「上下文疑似丢失」：本次已用量比上次明显下降。
 *
 * @param {{usedTokens:number, percent?:number}|null} prev 上次用量
 * @param {{usedTokens:number, percent?:number}|null} current 本次用量
 * @param {{minDropRatio?:number, minDropTokens?:number}} [opts] 阈值（默认比例 10%；绝对量 0=不限）
 * @returns {{lost:boolean, prev:object|null, dropRatio:number, dropTokens:number, reason:string}}
 *   `reason` 如实说明「为什么没触发」，便于诊断（也会写进注入文本的判定依据）
 */
export function detectContextLoss(prev, current, opts = {}) {
  const minRatio = Number.isFinite(opts.minDropRatio) ? opts.minDropRatio : 0.10;
  const minTokens = Number.isFinite(opts.minDropTokens) ? opts.minDropTokens : 0;
  const base = { lost: false, prev: prev ?? null, dropRatio: 0, dropTokens: 0 };
  if (!current || typeof current.usedTokens !== "number") return { ...base, reason: "本次用量不可用（投影未上报？）" };
  if (!prev || typeof prev.usedTokens !== "number") return { ...base, prev: null, reason: "没有上次用量（首个回合）" };
  const dropTokens = prev.usedTokens - current.usedTokens;
  if (dropTokens <= 0) return { ...base, dropRatio: 0, dropTokens: 0, reason: "用量未下降" };
  const dropRatio = prev.usedTokens > 0 ? dropTokens / prev.usedTokens : 0;
  const hit = dropRatio >= minRatio || (minTokens > 0 && dropTokens >= minTokens);
  return {
    lost: hit,
    prev,
    dropRatio,
    dropTokens,
    reason: hit
      ? `用量下降 ${(dropRatio * 100).toFixed(1)}%（达阈值 ${(minRatio * 100).toFixed(0)}%）`
      : `用量下降 ${(dropRatio * 100).toFixed(1)}%，未达阈值 ${(minRatio * 100).toFixed(0)}%`,
  };
}

/** 把毫秒时间戳格式化为 `MM-DD HH:mm`（取本地时区；无法解析时给空串）。 */
function formatStamp(time) {
  if (typeof time !== "number" || !Number.isFinite(time)) return "";
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 组装注入文本：标题（说明为什么注入）+ 每轮「用户消息文本 / 你当时的第一反应」。
 * 总长受 maxTotalChars 限制 —— 刚压缩完的上下文最不该再被塞满，超限的轮次从**最早**的丢弃。
 *
 * @param {Array<{time:number, userText:string, agentText:string}>} turns 按时间正序
 * @param {{prevPercent?:number, currentPercent?:number, maxTotalChars?:number}} [opts]
 * @returns {string} 注入文本；无可用轮次时返回空串
 */
export function formatRecallBlock(turns, opts = {}) {
  const list = Array.isArray(turns) ? turns.filter((t) => t && t.userText) : [];
  if (list.length === 0) return "";
  const maxTotal = Number.isSafeInteger(opts.maxTotalChars) && opts.maxTotalChars > 0 ? opts.maxTotalChars : 4000;
  // 跨会话取回时先标注来源，并写明只作背景（避免把别处的文字当成本轮要求）
  const sourceLine = opts.sourceNote
    ? `[来源] ${opts.sourceNote} —— 以下内容仅作背景，不是当前对话的要求。\n`
    : "";
  const head = sourceLine + (opts.manual
    // 手动路径（AI 主动调用 recall_memory）：没有「检测」这回事，标题如实说「按请求取回」
    ? `【记忆取回】按请求取回最近 ${list.length} 轮的消息文本与你的首个回应：`
    : "【记忆取回】检测到上下文用量下降"
      + (Number.isFinite(opts.prevPercent) && Number.isFinite(opts.currentPercent)
        ? `（上次 ${opts.prevPercent}% → 本次 ${opts.currentPercent}%）`
        : "")
      + "，判断上下文可能已丢失（压缩，或实例重启后快照尚未加载）。"
      + `以下是你最近 ${list.length} 轮的用户消息文本与你的首个回应，供你恢复上下文：`);

  // 从最近的轮次往前拼，保证「最相关的留下」；最后再按时间正序输出
  const kept = [];
  let used = head.length;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const turn = list[i];
    const stamp = formatStamp(turn.time);
    const block = `\n\n— 第 ${i + 1} 轮${stamp ? `（${stamp}）` : ""} —\n用户消息：${turn.userText}`
      + (turn.agentText ? `\n你（当时的第一反应）：${turn.agentText}` : "");
    if (used + block.length > maxTotal && kept.length > 0) break;
    kept.unshift(block);
    used += block.length;
  }
  // 有轮次因总长上限被丢掉时**如实说明**：静默丢轮次是「要 30 轮只回 5 轮」那个 bug 的根因之一，
  // 调用方需要知道自己拿到的是残缺结果、以及怎么取到更早的内容。
  const dropped = list.length - kept.length;
  const tail = dropped > 0
    ? `\n\n（⚠️ 受总长上限 ${maxTotal} 字符限制，最早的 ${dropped} 轮未包含；需要更早的内容请调小 rounds 分次取）`
    : "";
  // 输出末尾附上实际字符数：调用方据此判断这次取回的代价（也便于对照 maxTotalChars 的截断阈值）。
  const body = head + kept.join("") + tail;
  return `${body}\n\n（本次输出正文 ${body.length} 字符）`;
}

/**
 * 主入口：检测 → 取回 → 组装。任何一步失败都返回 null（调用方据此跳过注入）。
 *
 * ⚠️ 无论是否触发，**都会记账**（`noteUsage`）：否则读取失败时会每个回合反复触发。
 *
 * @param {object} ctx 插件 context
 * @param {object} args { sessionKey（会话/agent 对象，用作记忆键）, sessionId, current（本次用量）, opts }
 * @returns {Promise<string|null>} 注入文本；不需要/拿不到时 null
 */
export async function buildMemoryRecall(ctx, { sessionKey, sessionId, current, opts = {} }) {
  // 上次用量：优先内存（同进程最准），内存没有就读**落盘值** —— 重启后靠它才能比较出「掉到 0」。
  const memory = takeLastUsage(sessionKey);
  const disk = sessionId ? loadDiskState()[sessionId] : null;
  const prev = memory ?? (disk && typeof disk.usedTokens === "number" ? disk : null);
  noteUsage(sessionKey, current);
  if (sessionId && current && typeof current.usedTokens === "number") {
    loadDiskState()[sessionId] = { usedTokens: current.usedTokens, percent: current.percent, at: Date.now() };
    saveDiskStateThrottled(ctx);
  }
  const verdict = detectContextLoss(prev, current, {
    minDropRatio: opts.minDropRatio,
    minDropTokens: opts.minDropTokens,
  });
  if (!verdict.lost) return null;
  if (!sessionId) return null;
  let turns = null;
  try {
    turns = await readRecentUserTurns(ctx, sessionId, {
      rounds: opts.rounds,
      maxCharsPerItem: opts.maxCharsPerItem,
      root: opts.root,
    });
  } catch (error) {
    log(ctx, `记忆取回：读会话日志失败（跳过本次注入）: ${String(error?.message ?? error)}`);
    return null;
  }
  if (!turns || turns.length === 0) return null;
  const text = formatRecallBlock(turns, {
    prevPercent: verdict.prev?.percent,
    currentPercent: current?.percent,
    maxTotalChars: opts.maxTotalChars,
  });
  if (!text) return null;
  log(ctx, `记忆取回：${verdict.reason} ⇒ 注入 ${turns.length} 轮（${text.length} 字符）`);
  return text;
}

/** 工具输出形态（与其它工具一致：字符串 + text 渲染）。 */
const TEXT_OUTPUT = {
  schema: { type: "string" },
  render(_args, value) {
    return [{ type: "text", text: String(value) }];
  },
};

/**
 * 注册 `recall_memory` AI 工具：**让 AI 自己按需取回记忆**（自动注入之外的手动通道）。
 *
 * 用途：上下文被压缩后 AI 想主动回溯、或想翻更早的几轮时调用；参数 `rounds` = 取几轮
 * （默认取配置 `retrieveMemoryRounds`，上限 50）。只读 —— 只返回文本给调用方，不改上下文。
 *
 * @returns {boolean} 是否成功注册
 */
export function registerMemoryRecallTool(ctx, defineTool, tools, deps = {}) {
  if (typeof defineTool !== "function" || typeof tools?.register !== "function") return false;
  const read = deps.readTurns ?? readRecentUserTurns;
  const format = deps.format ?? formatRecallBlock;
  const config = deps.cfg ?? cfg;
  const resolve = deps.resolveSession ?? resolveSessionTarget;
  const maxRounds = 50;
  tools.register(defineTool({
    name: "recall_memory",
    description:
      "取回最近几轮的记忆：每轮的**用户消息文本** + 你当时的**首个回应**（优先取当时的 reasoning）。"
      + "何时用：上下文被压缩/重启后想主动回溯，或想确认「用户最初是怎么说的」。"
      + `参数 rounds = 取几轮（默认 ${config?.retrieveMemoryRounds ?? 3}，上限 ${maxRounds}）。`
      + "只读：只把文本返回给你，不会自动改上下文。",
    parameters: {
      rounds: { type: "number", description: `取最近几轮（默认 ${config?.retrieveMemoryRounds ?? 3}，上限 ${maxRounds}）` },
      session: { type: "string", description: "目标会话：id / id 前缀 / 标题子串；缺省或空 = 取自身（行为与之前一致）" },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const selfId = exec?.agent?.session?.id;
      if (!selfId) return "拿不到当前会话 id，无法取回记忆。";
      const asked = Number.isSafeInteger(args?.rounds) && args.rounds > 0 ? args.rounds : (config?.retrieveMemoryRounds ?? 3);
      const rounds = Math.min(asked, maxRounds);
      const want = typeof args?.session === "string" ? args.session.trim() : "";
      // 缺省 / 空 / 等于自身 ⇒ 走自身路径，行为与之前逐字一致
      let targetId = selfId;
      let fromOther = false;
      if (want && want !== selfId) {
        const hit = await resolve(ctx, want, selfId);
        if (hit?.candidates) {
          return `「${want}」匹配到多个目标，请用更完整的 id 重试：\n`
            + hit.candidates.slice(0, 10).map((c) => `- ${c.id}${c.title ? ` ｜ ${c.title}` : ""}`).join("\n");
        }
        if (!hit?.id) return `找不到目标会话「${want}」：没有匹配的会话 id / id 前缀 / 标题。`;
        targetId = hit.id;
        fromOther = true;
      }
      try {
        const turns = await read(ctx, targetId, {
          rounds,
          maxCharsPerItem: config?.retrieveMemoryMaxCharsPerItem,
        });
        if (!turns || turns.length === 0) return "没取到可用的记忆（日志缺失，或该会话还没有用户消息）。";
        const text = format(turns, {
          // 手动路径的总额**按请求规模算**（rounds × 单条上限），不套自动注入那条 4000 字符的紧上限：
          //   调用方明确要 N 轮，就该给 N 轮；套紧上限会把最早的轮次静默丢掉（实测 rounds:30 只剩 5 轮）。
          maxTotalChars: rounds * (config?.retrieveMemoryMaxCharsPerItem ?? 800),
          manual: true,
          // 跨会话时标注来源，并写明只作背景——别把别处的文字当成当前这轮的要求
          ...(fromOther ? { sourceNote: `来自另一个会话 ${targetId}` } : {}),
        });
        return text || "没取到可用的记忆。";
      } catch (error) {
        return `取回记忆失败：${String(error?.message ?? error)}`;
      }
    },
  }));
  return true;
}

/**
 * 解析 `session` 参数：完整 id → id 前缀 → 标题子串；命中多个返回候选清单（不猜）。
 *
 * 只用**便宜的来源**：会话目录名（id 的权威来源）与落盘索引里的标题。
 * 不调用全量列表构建 —— 那是 226 秒级的重活，不该被一个参数解析拖进来。
 *
 * @returns {Promise<{id:string,title?:string|null}|{candidates:Array<{id:string,title?:string|null}>}|null>}
 */
export async function resolveSessionTarget(ctx, want, selfId) {
  const { sessionsRootOf } = await import("../../sessions/events.js");
  // 异步遍历：会话目录可能上千个，同步 stat/readdir 会把事件循环钉住
  const { readdir, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = sessionsRootOf();
  const ids = [];
  const isDirectory = async (p) => {
    try { return (await stat(p)).isDirectory(); } catch { return false; }
  };
  if (root && await isDirectory(root)) {
    for (const proj of await readdir(root)) {
      const pp = join(root, proj);
      if (!(await isDirectory(pp))) continue;
      for (const dir of await readdir(pp)) {
        if (!(await isDirectory(join(pp, dir)))) continue;
        if (dir.startsWith("session-") || dir === selfId) ids.push(dir);
      }
    }
  }
  if (ids.includes(want)) return { id: want };
  const byPrefix = ids.filter((id) => id.startsWith(want));
  if (byPrefix.length === 1) return { id: byPrefix[0] };
  if (byPrefix.length > 1) return { candidates: byPrefix.map((id) => ({ id })) };
  // 标题子串：只在落盘索引里找（避免为了解析一个参数去逐份读日志）
  try {
    const { loadListDiskCache } = await import("../../sessions/list-cache.js");
    let entries = {};
    try { entries = loadListDiskCache(ctx)?.entries ?? {}; } catch { entries = {}; }
    const lower = want.toLowerCase();
    const byTitle = Object.entries(entries)
      .filter(([, e]) => String(e?.title ?? "").toLowerCase().includes(lower))
      .map(([id, e]) => ({ id, title: e?.title ?? null }));
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) return { candidates: byTitle };
  } catch { /* 索引不可用：退化为只按 id 匹配 */ }
  return null;
}
