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
  const head = "【记忆取回】检测到上下文用量下降"
    + (Number.isFinite(opts.prevPercent) && Number.isFinite(opts.currentPercent)
      ? `（上次 ${opts.prevPercent}% → 本次 ${opts.currentPercent}%）`
      : "")
    + "，判断上下文可能已丢失（压缩，或实例重启后快照尚未加载）。"
    + `以下是你最近 ${list.length} 轮的用户消息文本与你的首个回应，供你恢复上下文：`;

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
  return head + kept.join("");
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
  const prev = takeLastUsage(sessionKey);
  noteUsage(sessionKey, current);
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
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId) return "拿不到当前会话 id，无法取回记忆。";
      const asked = Number.isSafeInteger(args?.rounds) && args.rounds > 0 ? args.rounds : (config?.retrieveMemoryRounds ?? 3);
      const rounds = Math.min(asked, maxRounds);
      try {
        const turns = await read(ctx, sessionId, {
          rounds,
          maxCharsPerItem: config?.retrieveMemoryMaxCharsPerItem,
        });
        if (!turns || turns.length === 0) return "没取到可用的记忆（日志缺失，或还没有用户消息）。";
        const text = format(turns, { maxTotalChars: config?.retrieveMemoryMaxChars });
        return text || "没取到可用的记忆。";
      } catch (error) {
        return `取回记忆失败：${String(error?.message ?? error)}`;
      }
    },
  }));
  return true;
}
