// dsh-session-conductor — 会话事件流读取
//
// 【为什么单独成文件】「拿到一个会话的事件流」是列表、续跑、重命名、搜索、撤回的共同前置：
// live 会话走内存快照，冷会话走官方 persistence.open(id,"read") 读法。
// 集中在此避免各域各写一份（历史上冷会话读法变更过多次：inspect 失效 → open/read）。
//
// 【已知限制·宿主 API 不能流式读】官方 `handle.read(offset, length)` 的 offset/length 只是
// **内存数组切片**：后端每次调用都会 `readStoredLog(path)` 把**整份日志读进来解压**
// （见 packages/session/session-persistence-jsonl/src/storage.ts 的 readCurrent）。因此：
//   · 分块调用**不会**降低内存峰值，反而变成「N 次全量解压」（O(n²) 耗时）——**不要分块读**；
//   · 想真正把单会话内存压到 KB 级，只能绕过 handle：直接按 zstd 帧解码日志文件
//     （多帧格式每帧可独立解压，本仓库 lib/zstd-frames.js 已具备该能力）。
// 当前策略是「**读一次就别再读**」：靠列表磁盘缓存（revision 命中即跳过解析）把
// 重复解析降到 0，从而把 OOM 风险压掉。

// 宿主包**懒加载**：顶层 `import` 会让本文件在「工作区自测」环境直接解析失败
// （仓库里踩过同类坑），而 events.js 是最需要被单测覆盖的模块之一（冷会话读法）。
// 这里改成顶层 await import + 兜底：没有宿主依赖时退化为「不加闭合器」，其余逻辑照常可测。
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { streamDecodedFrames } from "../zstd-frames.js";
import { findSessionLog } from "../session-log.js";

let interruptedTurnClosers = null;
try {
  const hostSession = await import("@deepseek-ai/dsh-session");
  if (typeof hostSession?.interruptedTurnClosers === "function") {
    interruptedTurnClosers = hostSession.interruptedTurnClosers;
  }
} catch {
  // 无宿主依赖（工作区自测）：保持 null，调用点会跳过「补闭合器」这一步
}

/** 需要时补官方中断闭合器；宿主包不可用时原样返回（不阻断列表）。 */
function withInterruptedClosers(events) {
  if (typeof interruptedTurnClosers !== "function" || events.length === 0) return events;
  try {
    return [...events, ...interruptedTurnClosers(events)];
  } catch {
    return events;
  }
}

/** 只读尾部时默认保留的事件行数（提出来是为了让 2000 这个数字有名字）。 */
const DEFAULT_TAIL_KEEP = 2000;
/** 单条消息默认截断字符数。 */
const DEFAULT_MAX_CHARS_PER_ITEM = 800;

/**
 * 该子会话是否归属 API remote（不该被插件当普通会话处理）。
 * 等价判定：header.origin==="subagent"，或 parent live agent 拥有该 child（agents.isOwnedBy）。
 */
export function hasApiRemoteSubagentOwner(ctx, session, agent) {
  const header = session?.header ?? session;
  if (header?.origin === "subagent") return true;
  const parentId = header?.parentSession;
  if (!parentId || !agent) return false;
  try {
    const agents = ctx.get?.("agents") ?? ctx.agents;
    const parent = agents?.get?.(parentId);
    return Boolean(parent && agents?.isOwnedBy?.(agent.id, parent));
  } catch {
    return false;
  }
}

/** live Session 的 events 可能不是数组，优先 snapshotEvents()。 */
export function sessionEventList(session) {
  if (Array.isArray(session?.events)) return session.events;
  try {
    const snap = session?.snapshotEvents?.();
    if (Array.isArray(snap)) return snap;
  } catch {
    // 非 Session 对象
  }
  return [];
}

/** 读取一个会话的事件流（live 用内存快照，cold 用官方 handle 读法）。 */
export async function sessionEventsOf(ctx, sessionId) {
  const sessions = ctx.get("sessions");
  const live = sessions?.get(sessionId);
  if (live) return { live, events: sessionEventList(live), meta: live.header };
  try {
    return await readColdSessionEvents(ctx, sessionId);
  } catch {
    // 损坏/不可读 → 返回 null，调用方跳过不中断整体
    return null;
  }
}

/**
 * 读一个冷（已持久化）会话的完整事件流（官方标准读法）：
 * `persistence.open(id,"read")` → `handle.read(0)` → `close`，并补官方中断闭合器。
 *
 * ⚠️ **这是全量读**，也是宿主 API 目前唯一能给的读法（见文件头「宿主 API 不能流式读」）：
 * 整份日志会变成 events 数组驻留内存 —— 本机实测最大会话 49.2 MB 压缩 → 173.3 MB 解压
 * （另一份 39.9 → 197.9 MB，膨胀 3.2~5.0×）。因此**必须避免重复解析**：
 * 列表侧靠磁盘缓存（revision 命中即跳过）；不要为了「省内存」改成多次 read
 * （那只会变成 N 次全量解压，内存峰值不变、耗时变 O(n²)）。
 *
 * 列表构建请优先用 `readColdSessionSummary`（按 zstd 帧流式读，常量内存）。
 *
 * 读取失败**向上抛**（buildSessionList 用它带出 inspectError）；仅「无 open 能力」返回 null。
 * @returns {Promise<{events:Array, meta:object|null}|null>}
 */
export async function readColdSessionEvents(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  if (!persistence?.open) return null;
  const handle = await persistence.open(sessionId, "read");
  let events = [];
  try {
    const read = await handle.read(0, undefined);
    events = read?.events ?? [];
  } finally {
    try { await handle.close(); } catch { /* 读失败时 close 失败无妨 */ }
  }
  // 崩溃残留的开放回合补合成闭合器（与官方 cold-read 一致，列表中断判定需要）
  return { events: withInterruptedClosers(events), meta: handle?.header ?? null };
}

// ---------- 按 zstd 帧流式读（列表专用，常量内存）----------

/** 会话日志根目录：`<DSH_HOME>/sessions`。 */
export function sessionsRootOf() {
  const dshHome = process.env.DSH_HOME || join(process.env.HOME ?? "", ".dsh");
  return join(dshHome, "sessions");
}

/**
 * 由会话 id 定位其日志文件。布局：`<sessionsRoot>/<工作区编码目录>/<会话id>/session.v*.jsonl.zstd`。
 * 只做两层 readdir（根目录下的工作区分组通常只有个位数），命中即返回。
 * @returns {string|null} 日志文件绝对路径；找不到返回 null（调用方回退到 handle 读法）
 */
export function findSessionLogById(sessionId, root = sessionsRootOf()) {
  if (!sessionId) return null;
  try {
    for (const group of readdirSync(root)) {
      const dir = join(root, group, sessionId);
      if (!existsSync(dir)) continue;
      const file = findSessionLog(dir);
      if (file) return file;
    }
  } catch {
    // 根目录不可读 → 交给调用方回退
  }
  return null;
}

/**
 * 冷会话「摘要读」：**直接按 zstd 帧读日志文件**，流式解压 + 逐行增量解析 ⇒ 常量内存。
 *
 * 【为什么需要它】宿主的 `handle.read()` 无法流式读（见文件头）：它每次都会把整份日志
 * 解压成 events 数组，本机实测最大会话 49.2 MB 压缩 → **173.3 MB 解压**，再变成对象数组后
 * 单会话峰值数百 MB；列表要遍历上百个冷会话 ⇒ 进程 OOM。
 * 而列表真正需要的只有三个值，都能在「逐行流过」时用 O(1) 状态累加：
 *   · title        —— 全日志**最后一条** `session/title`（`foldTitle` 是倒序找，等价）
 *   · updatedAt    —— 全日志**最后一条**事件的 `time`（`lastEventTime` 只取末条）
 *   · interruption —— 全日志**最后一个** `turn/end` 的 reason（`interruptionInfo` 倒序找）
 * 因此：读压缩文件（≤ ~50 MB）→ 逐帧流式解压（`streamDecodedFrames`）→ 逐行 JSON.parse
 * → 只更新上述标量 + 保留尾部若干条（供官方闭合器判定开放回合）→ 其余立即丢弃。
 *
 * @param {object} ctx 插件 context（本函数不用 ctx 的服务，保留是为了与其它读法同签名）
 * @param {string} sessionId 会话 id
 * @param {object} [opts] tailKeep（尾部保留条数，默认 2000）/ signal / root（测试用）
 * @returns {Promise<{meta:object|null, events:Array, derived:object, scanned:number, frames:number}|null>}
 *   返回 null 表示「文件没找到」——调用方应回退到 `readColdSessionEvents`
 */
export async function readColdSessionSummary(ctx, sessionId, opts = {}) {
  const file = findSessionLogById(sessionId, opts.root ?? sessionsRootOf());
  if (!file) return null;
  const tailKeep = Number.isSafeInteger(opts.tailKeep) && opts.tailKeep >= 0 ? opts.tailKeep : DEFAULT_TAIL_KEEP;
  const buf = await readFile(file); // 压缩态（最大 ~50 MB），不是解压态
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let meta = null;
  let title;
  let updatedAt;
  let openTurn = false;
  let lastSeq;
  let lastTurnEnd = null;
  let tail = [];
  let scanned = 0;

  const consumeLine = (line) => {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; } // 截断/损坏行跳过，不影响其余
    if (event?.type === "session") { meta = meta ?? event; return; } // 首行是会话 header（含 cwd/createdAt）
    scanned += 1;
    if (event?.type === "session/title" && typeof event.data?.title === "string") title = event.data.title;
    if (typeof event?.time === "number") updatedAt = event.time;
    if (event?.type === "turn/end") { lastTurnEnd = event; openTurn = false; }
    else if (event?.type === "turn/start") openTurn = true;
    if (typeof event?.seq === "number") lastSeq = event.seq;
    if (tailKeep > 0) {
      tail.push(event);
      if (tail.length > tailKeep) tail.splice(0, tail.length - tailKeep);
    }
  };

  const stats = await streamDecodedFrames(buf, (chunk) => {
    pending += decoder.write(chunk);
    let idx;
    while ((idx = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      consumeLine(line);
    }
  }, { signal: opts.signal });
  pending += decoder.end();
  consumeLine(pending);

  return {
    meta,
    // 尾部 + 官方闭合器：列表沿用既有 interruptionInfo(events) 语义，行为不变
    events: withInterruptedClosers(tail),
    derived: { title, updatedAt, openTurn, lastSeq, lastTurnEnd },
    scanned,
    frames: stats.frames,
  };
}

// ---------- 记忆取回：取最近 N 轮「用户消息文本 + AI 首条回应」----------

/** 从 content 分块里取纯文本（跳过 reasoning 等非文本块）。 */
function textPartsOf(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part?.text === "string" && part.text) parts.push(part.text);
  }
  return parts.join("\n");
}

/**
 * 从 `assistant/message` 里取「该轮 AI 的第一条回应」文本。
 * 优先 `reasoning`（当时的推理最能体现「我那时怎么理解你的话」），没有则取正文 `text`。
 */
function firstAgentTextOf(data) {
  const content = data?.message?.content;
  if (!Array.isArray(content)) return "";
  const pick = (kind) => content.find((p) => p?.type === kind && typeof p.text === "string" && p.text)?.text ?? "";
  return pick("reasoning") || pick("text") || "";
}

/** 截断到 maxChars（超出加省略号），并压缩连续空白行。 */
function clipText(text, maxChars) {
  const normalized = String(text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (maxChars > 0 && normalized.length > maxChars) return `${normalized.slice(0, maxChars)}…`;
  return normalized;
}

/**
 * 取最近 N 轮「用户消息文本 + 该轮 AI 的第一条回应」（**按 zstd 帧流式读，常量内存**）。
 *
 * 【锚点为什么是 user/message 而不是 agent/inbox/spliced】前者是「真正成为用户输入」的那条，
 * 后者是同一句话的**投递副本**（实测同一句话会先出现在 spliced、后出现在 user/message），
 * 用后者会把一轮数成两条。
 * 【为什么只认 source.kind === "user"】插件自己注入的消息（`plugin:dsh-session-conductor`）
 * 以及 runtime-context / user-approval / model-selection 都不是用户消息文本；若不排除，
 * 「记忆取回」注入的块本身会被下一轮取回，形成越注越多的反馈环。
 * 【连续多条用户消息算一轮】同一回合内（其间没有 turn/end）到达的多条用户消息合并成一条。
 *
 * @param {object} ctx 插件 context（本函数不取服务，保留同签名）
 * @param {string} sessionId 会话 id
 * @param {object} [opts] rounds（默认 3）/ maxCharsPerItem（默认 800）/ root（测试用）
 * @returns {Promise<Array<{time:number, userText:string, agentText:string}>|null>} 按时间正序；null = 日志没找到
 */
export async function readRecentUserTurns(ctx, sessionId, opts = {}) {
  const file = findSessionLogById(sessionId, opts.root ?? sessionsRootOf());
  if (!file) return null;
  const rounds = Number.isSafeInteger(opts.rounds) && opts.rounds > 0 ? opts.rounds : 3;
  const perItem = Number.isSafeInteger(opts.maxCharsPerItem) && opts.maxCharsPerItem > 0 ? opts.maxCharsPerItem : DEFAULT_MAX_CHARS_PER_ITEM;
  const buf = await readFile(file);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const turns = [];
  let current = null;

  const consumeLine = (line) => {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const type = event?.type;
    if (type === "turn/end") {
      // 回合结束：此后到来的用户消息算新的一轮
      if (current) current.closed = true;
      return;
    }
    if (type === "user/message") {
      if (event?.data?.source?.kind !== "user") return; // 排除注入与运行期上下文
      const text = clipText(textPartsOf(event?.data?.content), perItem);
      if (!text) return;
      if (current && !current.closed) {
        // 同回合内的连续用户消息：合并（用空行分隔，保持消息文本可辨）
        current.userText = current.userText ? `${current.userText}\n\n${text}` : text;
        return;
      }
      current = { time: typeof event?.time === "number" ? event.time : null, userText: text, agentText: "", closed: false };
      turns.push(current);
      if (turns.length > rounds) turns.shift(); // 只留最近 rounds 轮（常量内存）
      return;
    }
    if (type === "assistant/message") {
      if (!current || current.agentText) return; // 只要该轮的第一条
      const text = clipText(firstAgentTextOf(event?.data), perItem);
      if (text) current.agentText = text;
    }
  };

  await streamDecodedFrames(buf, (chunk) => {
    pending += decoder.write(chunk);
    let idx;
    while ((idx = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      consumeLine(line);
    }
  });
  pending += decoder.end();
  consumeLine(pending);

  return turns.map((t) => ({ time: t.time, userText: t.userText, agentText: t.agentText }));
}
