// dsh-session-conductor — 读取成员（子代理）会话的完整执行轨迹
//
// 【这个文件解决什么】子代理只有「最后一条回复」会被宿主自动发回主代理，中间的思考与工具调用
// 主代理完全看不到。一个执行型子代理单轮可以产生上百条 assistant 消息（实测某会话单轮 115 条、
// 全会话 1382 条、带 reasoning 的 939 条），主代理只拿到一句结论，等于丢了全部过程。
//
// 【为什么不复用 recall_memory】那套是「记忆取回」语义，有三条硬限制让它读不了轨迹：
//   ① 每轮只取第一条 assistant 消息（`if (!current || current.agentText) return`）；
//   ② reasoning 与 text 二选一（`pick("reasoning") || pick("text")`）；
//   ③ 完全不读 tool/call 与 tool/result。
// 本模块按 turn → step → 事件三层组织，把思考、正文、工具调用与结果一并取出。
//
// 【为什么按 zstd 帧流式读】单个会话日志可达数十 MB、上万事件；全量解码会一次性吃掉大块内存。
// 流式逐帧解析 + 边解析边丢弃旧轮次，内存只与「保留的轮数 × 每轮事件数」有关。
import { readFile } from "node:fs/promises";
import { findSessionLogById, sessionsRootOf } from "./events.js";
// 流式逐事件读取的公共底座（与记忆取回共用；本模块只负责「按 turn/step 怎么组织」）
import { streamSessionEvents } from "./log-stream.js";
// 目标解析的公共底座（id / 前缀 / 标题 / 成员名；与记忆取回共用）
import { resolveTargetSession } from "./resolve.js";

/** 单条文本默认截断长度（summary 模式下更短，见 SUMMARY_CLIP）。 */
const DEFAULT_MAX_ITEM = 800;
/** summary 模式下单条压成一行时的截断长度。 */
const SUMMARY_CLIP = 160;

/**
 * 把一段文本压成单行摘要（summary 模式用）。
 * @param {string} text 原始文本
 * @param {number} max 最大长度
 * @returns {string}
 */
function oneLine(text, max = SUMMARY_CLIP) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (max > 0 && flat.length > max) return `${flat.slice(0, max)}…`;
  return flat;
}

/**
 * 从 assistant/message 的 content 里分别取 reasoning 与正文。
 *
 * 与 recall 的 `firstAgentTextOf` 不同：这里**两者都要**（思考与正文是不同信息，
 * 只留一个会让「想了什么」或「说了什么」缺一半）。
 *
 * @param {object} data 事件 data
 * @returns {{reasoning: string, text: string}}
 */
function splitAssistantContent(data) {
  const content = data?.message?.content;
  if (!Array.isArray(content)) return { reasoning: "", text: "" };
  const join = (kind) => content
    .filter((p) => p?.type === kind && typeof p.text === "string" && p.text.trim())
    .map((p) => p.text)
    .join("\n");
  return { reasoning: join("reasoning"), text: join("text") };
}

/**
 * 把 tool/call 的参数压成一行摘要。
 *
 * 工具参数里常有整段文件内容或长命令；全量输出会把轨迹淹没。这里只保留键名与短值：
 * 字符串值超过 80 字符即截断，对象/数组只报类型与长度。
 *
 * @param {unknown} args 工具参数
 * @returns {string}
 */
function briefArgs(args) {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return oneLine(String(args), 80);
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") parts.push(`${key}=${value.length > 80 ? `${value.slice(0, 80)}…` : value}`);
    else if (Array.isArray(value)) parts.push(`${key}[${value.length}]`);
    else if (value !== null && typeof value === "object") parts.push(`${key}{…}`);
    else parts.push(`${key}=${String(value)}`);
    if (parts.join(", ").length > 200) break;
  }
  return oneLine(parts.join(", "), 200);
}

/**
 * 把 tool/result 压成一行摘要：成功/失败 + 内容长度或错误信息。
 * @param {object} data 事件 data
 * @returns {string}
 */
function briefResult(data) {
  const ok = data?.ok;
  const error = data?.error;
  if (error !== undefined) {
    const msg = typeof error === "string" ? error : JSON.stringify(error);
    return `失败：${oneLine(msg, 120)}`;
  }
  const content = data?.message?.content ?? data?.content;
  let size = 0;
  if (Array.isArray(content)) size = content.reduce((n, p) => n + (typeof p?.text === "string" ? p.text.length : 0), 0);
  else if (typeof content === "string") size = content.length;
  return `${ok === false ? "失败" : "成功"}（${size} 字符）`;
}

/**
 * 读取一个会话最近 N 轮的完整轨迹。
 *
 * @param {object} ctx 插件 context（保留给调用方传递，本函数不依赖具体服务）
 * @param {string} sessionId 目标会话 id
 * @param {{rounds?: number, maxCharsPerItem?: number, root?: string}} [opts]
 *        rounds 取最近几轮（默认 1）；maxCharsPerItem 单条截断（默认 800）
 * @returns {Promise<{turns: Array<object>} | {error: string}>}
 */
export async function readMemberTrace(ctx, sessionId, opts = {}) {
  const file = findSessionLogById(sessionId, opts.root ?? sessionsRootOf());
  if (!file) return { error: `找不到会话日志（sessionId=${sessionId}）` };
  const rounds = Number.isSafeInteger(opts.rounds) && opts.rounds > 0 ? opts.rounds : 1;
  const perItem = Number.isSafeInteger(opts.maxCharsPerItem) && opts.maxCharsPerItem > 0
    ? opts.maxCharsPerItem
    : DEFAULT_MAX_ITEM;

  const buf = await readFile(file);
  const turns = [];
  let turn = null;
  let step = null;

  /** 保证当前轮与当前 step 存在（事件可能不按期望顺序出现，缺失时兜底建一个）。 */
  const ensureTurn = () => {
    if (turn === null) {
      turn = { index: 0, task: "", steps: [] };
      turns.push(turn);
    }
    return turn;
  };
  const ensureStep = () => {
    const t = ensureTurn();
    if (step === null) {
      step = { step: 1, items: [] };
      t.steps.push(step);
    }
    return step;
  };

  const onEvent = (event) => {
    const type = event?.type;

    if (type === "turn/start") {
      // 新回合。注意**不要**在这里用 turns.shift() 裁剪：shift 会让下面 turn/step 两个引用
      // 指向已被移出数组的对象，之后的 assistant 消息会挂到那个孤儿对象上（表现为
      // 「某一轮的思考内容跑到了另一轮」）。改成读完之后统一 slice(-rounds)。
      turn = { index: (turns.length > 0 ? turns[turns.length - 1].index + 1 : 1), task: "", steps: [] };
      turns.push(turn);
      step = null;
      return;
    }
    if (type === "step/start") {
      const t = ensureTurn();
      step = { step: typeof event?.data?.step === "number" ? event.data.step : t.steps.length + 1, items: [] };
      t.steps.push(step);
      return;
    }
    if (type === "user/message") {
      // 用**白名单**而不是黑名单：user/message 的 source.kind 有十余种，除了真实任务以外
      // 全是宿主或插件的注入（实测同一份日志中：skill-catalog×5、runtime-context×7、time-context×62、
      // tool-jobs×17、plugin:dsh-session-conductor×131、plugin:dsh-git-push×61 等）。
      // 黑名单写法只要漏一种，任务文本就会被几百 KB 的注入内容淹没。
      // 真实任务只有两种来源：user（用户直接说）与 agent-message（主代理派给子代理的团队消息）。
      const kind = event?.data?.source?.kind;
      if (kind !== "user" && kind !== "agent-message") return;
      const content = event?.data?.content;
      const text = Array.isArray(content)
        ? content.filter((p) => typeof p?.text === "string").map((p) => p.text).join("\n")
        : "";
      if (!text.trim()) return;
      const t = ensureTurn();
      t.task = t.task ? `${t.task}\n\n${oneLine(text, perItem)}` : oneLine(text, perItem);
      return;
    }
    if (type === "assistant/message") {
      const { reasoning, text } = splitAssistantContent(event?.data);
      if (!reasoning && !text) return;
      const s = ensureStep();
      if (reasoning) s.items.push({ kind: "reasoning", text: oneLine(reasoning, perItem) });
      if (text) s.items.push({ kind: "text", text: oneLine(text, perItem) });
      return;
    }
    if (type === "tool/call") {
      const s = ensureStep();
      s.items.push({
        kind: "tool",
        name: String(event?.data?.name ?? "?"),
        args: briefArgs(event?.data?.arguments),
        result: "",
      });
      return;
    }
    if (type === "tool/result") {
      // 结果挂到同一 step 里最近一次尚未填结果的 tool 记录上
      const t = ensureTurn();
      for (let i = t.steps.length - 1; i >= 0; i -= 1) {
        const items = t.steps[i].items;
        for (let j = items.length - 1; j >= 0; j -= 1) {
          if (items[j].kind === "tool" && !items[j].result) {
            items[j].result = briefResult(event?.data);
            return;
          }
        }
      }
      return;
    }
  };

  await streamSessionEvents(buf, onEvent);

  // 丢掉没有任务的空轮（日志里可能存在只有 turn 边界、没有内容的情况），再取最近 rounds 轮。
  // 顺序很重要：先过滤空轮再裁剪，否则 rounds=2 时可能被一个空轮占掉一个名额。
  const useful = turns.filter((t) => t.task || t.steps.some((s) => s.items.length > 0));
  return { turns: useful.slice(-rounds), file };
}

/**
 * 把轨迹格式化成给 AI 读的文本。
 *
 * @param {Array<object>} turns readMemberTrace 的 turns
 * @param {{sessionLabel?: string, detail?: "summary"|"full", include?: string[]}} [opts]
 *        detail=summary 时每条压成一行；full 时保留 readMemberTrace 给出的文本长度
 * @param {Set<string>} [kinds] 要包含的内容种类（reasoning / text / tool）
 * @returns {string}
 */
export function formatMemberTrace(turns, opts = {}, kinds = new Set(["reasoning", "text", "tool"])) {
  const label = opts.sessionLabel ?? "目标会话";
  const full = opts.detail === "full";
  const lines = [];
  lines.push(`【${label}】最近 ${turns.length} 轮执行轨迹`);
  for (const t of turns) {
    lines.push("");
    lines.push(`── 第 ${t.index} 轮${t.task ? `｜任务：${full ? t.task : oneLine(t.task, 200)}` : ""}`);
    for (const s of t.steps) {
      for (const item of s.items) {
        if (item.kind === "reasoning" && !kinds.has("reasoning")) continue;
        if (item.kind === "text" && !kinds.has("text")) continue;
        if (item.kind === "tool" && !kinds.has("tool")) continue;
        if (item.kind === "reasoning") lines.push(`  [step ${s.step}] 思考：${item.text}`);
        else if (item.kind === "text") lines.push(`  [step ${s.step}] 正文：${item.text}`);
        else {
          const res = item.result ? ` → ${item.result}` : "";
          lines.push(`  [step ${s.step}] 调用 ${item.name}(${item.args})${res}`);
        }
      }
    }
  }
  return lines.join("\n");
}

/** 工具输出格式：一律纯文本（与其它工具一致，交给宿主渲染成一段 message）。 */
const TEXT_OUTPUT = {
  schema: { type: "string" },
  render(args, value) {
    return [{ type: "text", text: String(value) }];
  },
};

/**
 * 注册 `read_member_trace` AI 工具。
 *
 * 【解决什么】子代理只有「最后一条回复」会被宿主自动发回主代理；执行型子代理单轮可产生上百条
 * assistant 消息（思考 + 工具调用 + 逐步结论），主代理只看得到最后一句，等于丢失全部过程。
 * 本工具让主代理按需读取指定会话（通常是子代理）的完整轨迹。
 *
 * @param {object} ctx 插件 context
 * @param {Function} defineTool 宿主 defineTool
 * @param {object} tools 宿主 tools 服务
 * @param {{cfg?: object, resolveSession?: Function}} [deps] 测试注入点
 * @returns {boolean} 是否成功注册
 */
export function registerMemberTraceTool(ctx, defineTool, tools, deps = {}) {
  if (typeof defineTool !== "function" || typeof tools?.register !== "function") return false;
  const resolve = deps.resolveSession;
  const maxRounds = 20;

  tools.register(defineTool({
    name: "read_member_trace",
    description:
      "读取成员（子代理）或其他会话的**完整执行轨迹**：每轮的思考、正文、工具调用与结果摘要。"
      + "何时用：子代理只把最后一条回复发回来，想看它中间想了什么/调用了什么/为什么这么结论时；"
      + "或想核对某个成员到底做了哪些操作。"
      + `参数 rounds = 取最近几轮（默认 1，上限 ${maxRounds}；一轮可能上百条，别一次要太多）。`
      + "detail=summary（默认，每条压成一行）/ full（保留较长文本）。"
      + "include 可裁掉 reasoning / text / tool 中不需要的部分。只读，不改任何会话。",
    parameters: {
      session: { type: "string", description: "目标会话：成员名 / sessionId / id 前缀 / 标题子串；空 = 自己" },
      rounds: { type: "number", description: `取最近几轮（默认 1，上限 ${maxRounds}）` },
      detail: { type: "string", description: "summary（默认，每条一行）或 full（较长文本）" },
      include: { type: "string", description: "只看某些内容：传逗号分隔的 reasoning,text,tool；默认全含" },
      maxCharsPerItem: { type: "number", description: "单条截断字符数（默认 800）" },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const selfId = exec?.agent?.session?.id;
      if (!selfId) return "拿不到当前会话 id，无法读取轨迹。";

      // 目标解析走公共底座（sessions/resolve.js）：id / id 前缀 / 标题 / 成员名，命中多个给候选不猜。
      // 两个工具（本工具与记忆取回）共用同一套，避免各自一套解析各缺一块。
      const want = typeof args?.session === "string" ? args.session.trim() : "";
      const resolveFn = resolve ?? resolveTargetSession;
      const rounds = Math.min(
        Number.isSafeInteger(args?.rounds) && args.rounds > 0 ? args.rounds : 1,
        maxRounds,
      );
      const detail = args?.detail === "full" ? "full" : "summary";
      const kinds = new Set(
        (typeof args?.include === "string" && args.include.trim()
          ? args.include.split(",").map((s) => s.trim()).filter(Boolean)
          : ["reasoning", "text", "tool"]),
      );

      let targetId = selfId;
      if (want && want !== selfId) {
        const hit = await resolveFn(ctx, want, selfId, { agent: exec?.agent });
        if (hit?.candidates) {
          return `「${want}」匹配到多个目标，请用更完整的 id 重试：\n`
            + hit.candidates.slice(0, 10).map((c) => `- ${c.id}${c.title ? ` ｜ ${c.title}` : ""}`).join("\n");
        }
        if (!hit?.id) {
          return `找不到目标会话「${want}」：没有匹配的成员名 / 会话 id / id 前缀 / 标题。`;
        }
        targetId = hit.id;
      }

      const read = await readMemberTrace(ctx, targetId, {
        rounds,
        maxCharsPerItem: Number.isSafeInteger(args?.maxCharsPerItem) && args.maxCharsPerItem > 0
          ? args.maxCharsPerItem
          : undefined,
      });
      if (read.error) return `读取轨迹失败：${read.error}`;
      if (!read.turns || read.turns.length === 0) {
        return `该会话最近 ${rounds} 轮没有可读内容（可能还没跑过回合，或日志里只有注入事件）。`;
      }
      const text = formatMemberTrace(read.turns, {
        sessionLabel: targetId === selfId ? "自身" : `目标 ${targetId}`,
        detail,
      }, kinds);
      return text || "没有符合 include 过滤条件的内容。";
    },
  }));
  return true;
}
