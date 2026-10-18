// dsh-session-conductor — 成员模型切换：执行切换
//
// 【职责】把一次「切模型」落到实处：持久化 override、必要时等回合暂停、
// 写 `model/selection` 事件（可观测 + 官方投影），未挂载时直接改会话日志文件。

import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { replaceFileSync } from "../../shared/atomic-file.js";
import path from "node:path";
import { log } from "../../shared/log.js";
import { hasOpenTurn } from "../../sessions/turn.js";
import { foldLastModelSelection } from "../../sessions/route.js";
import { lazyZstd, lazyRepair } from "../../core/lazy.js";
import { setMemberModelOverride } from "./override.js";

/**
 * 等待一个成员进入空闲（当前回合结束/暂停）。
 * 优先用官方 Agent.whenIdle()；不可用或超时后按状态轮询兜底。
 * @param {object} agent live agent
 * @param {number} timeoutMs 最长等待（默认 60s）
 * @returns {Promise<boolean>} 空闲返回 true；超时仍忙返回 false
 */
export async function waitForIdle(agent, timeoutMs = 60000) {
  const isIdle = () => agent?.status !== "running" && !hasOpenTurn(agent?.session?.events);
  if (isIdle()) return true;
  if (typeof agent?.whenIdle === "function") {
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {
      // whenIdle 抛错 → 走下面的状态轮询兜底
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (!isIdle() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return isIdle();
}

/**
 * 未挂载成员：直接把 `model/selection` 事件追加进会话日志。
 *
 * 【为什么必须直接写文件】官方 selectionFor 只认「会话投影里的 model/selection」；
 * Team 成员的唤醒走 sendMessage → followup，**不经过插件的 resumeSetupFor**——
 * 只把「切换意图」记在插件 domain 里没有任何地方会应用它（事件未新增、模型未变化）。
 * 未挂载时没有并发写入，可安全改文件：解码 → 追加事件 → 校验 → 原子写回（带备份）。
 *
 * @returns {Promise<{ok: true, note?: string} | {error: string}>}
 */
export async function appendSelectionEventToLog(ctx, sessionId, provider, model) {
  // 0.2.x 已移除 persistence.listArtifacts（原实现因此恒报「服务不可用」，整条写日志路径是死的），
  // 改为按 id 直接定位日志文件 —— 与删除链路用同一套定位（findSessionLogById）。
  const { findSessionLogById, sessionsRootOf } = await import("../../sessions/events.js");
  const filePath = findSessionLogById(sessionId, sessionsRootOf());
  if (!filePath) return { error: `会话日志不存在（sessionId=${sessionId}）` };
  const { decodeAllFrames } = await lazyZstd();
  let text;
  try {
    text = await decodeAllFrames(await readFile(filePath));
  } catch (error) {
    return { error: `会话日志解码失败：${String(error?.message ?? error)}` };
  }
  const lines = String(text).split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { error: "会话日志为空" };
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]));
    } catch {
      // 跳过坏行（校验阶段会兜底）
    }
  }
  const last = foldLastModelSelection(events);
  if (last && last.provider === provider && last.model === model) {
    return { ok: true, note: "日志里已是该模型，无需重复写入" };
  }
  let maxSeq = -1;
  for (const e of events) if (typeof e?.seq === "number" && e.seq > maxSeq) maxSeq = e.seq;
  const event = { type: "model/selection", seq: maxSeq + 1, time: Date.now(), data: { provider, model } };
  const newText = [...lines, JSON.stringify(event)].join("\n") + "\n";
  const { validateSessionText, encodeSessionText } = await lazyRepair();
  const check = validateSessionText(newText);
  if (!check.ok) return { error: `写入后校验失败：${check.problems?.[0] ?? "未知"}` };
  // 备份 + 原子写回（与 undo 同款做法）
  const backupDir = path.join(path.dirname(filePath), ".model-switch-backup");
  try {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(filePath, path.join(backupDir, `${Date.now()}-${sessionId}.zstd`));
  } catch (error) {
    return { error: `备份失败（未写入）：${String(error?.message ?? error)}` };
  }
  const newBuf = await encodeSessionText(newText);
  replaceFileSync(filePath, newBuf, { tmpSuffix: ".modelswitchtmp" }); // 统一原子替换（继承权限）
  return { ok: true, note: "已直接写入会话日志" };
}

/**
 * 给成员会话切模型（只动该成员的会话）。
 *
 * 实现只做两件事：
 *   ① 把切换意图持久化到插件 domain（memberModelOverrides）——成员未挂载时也能切；
 *   ② 若有 live agent，向会话追加 `model/selection` 事件——官方 session-controller 的
 *      selectionFor 读该事件（投影 pending）当轮生效，并沿请求头链跨轮持久。
 * **插件不再自己 installModelSelection**：与官方 selectionFor 形成双 hook 竞争时，
 * 表现为「切换当轮生效、下一轮回落」（request/header 序列出现新模型与默认模型交替）。
 * 若官方 sessionController.selectModel 可直调，则顺带用它（额外做模型归一化与默认值保存）。
 *
 * live agent 不是前提（未挂载时只记意图，下次 resume 由 resumeSetupFor 补写事件）。
 * 目标**正在执行回合时先等它暂停**（whenIdle，最长 60s）再切。
 * @param {string} sessionId 目标会话 id（来自 findTargetAgent）
 * @param {object|null} agent 可选 live agent（不传则内部按 sessionId 查）
 * @returns {{via: string} | {error: string}}
 */
export async function switchAgentModel(ctx, sessionId, provider, model, agent = null) {
  if (!sessionId) return { error: "缺少 sessionId（无法定位目标会话）" };
  // ① 持久化切换意图（不依赖 live agent——成员 inactive/未挂载时也能切，下次运行生效）
  let overrideNote = "";
  try {
    await setMemberModelOverride(ctx, sessionId, provider, model);
    overrideNote = "，已记录切换意图";
  } catch (error) {
    overrideNote = `，意图持久化失败：${String(error?.message ?? error)}`;
  }
  const live = agent ?? ctx.get("agents")?.get?.(sessionId) ?? null;
  // ② 成员当前未挂载（inactive）：直接把事件写进会话日志——官方 selectionFor 读投影即生效。
  //    （Team 成员唤醒走 sendMessage → followup，不经过 resumeSetupFor，只记意图不会被应用。）
  if (typeof live?.ctx?.on !== "function" || !live?.session) {
    const written = await appendSelectionEventToLog(ctx, sessionId, provider, model);
    if (written.error) {
      return { error: `成员未挂载，且写入会话日志失败：${written.error}（切换意图已记录，可稍后重试）` };
    }
    return { via: `已写入会话日志的 model/selection 事件（成员未挂载）${written.note ? "，" + written.note : ""}${overrideNote}，该成员下次运行时生效` };
  }
  // ③ 正在执行回合：等它暂停再切（当前回合已用旧模型发出请求，直接切会「只生效一回合」）
  const IDLE_WAIT_MS = 60_000;
  if (live.status === "running" || hasOpenTurn(live.session?.events)) {
    const idle = await waitForIdle(live, IDLE_WAIT_MS);
    if (!idle) {
      return { error: `成员正在执行回合（status=${live.status ?? "?"}），已等待 60s 仍未结束——请稍后重试，或先用 interrupt_agent 中断该成员` };
    }
  }
  // ④ 只写会话事件：官方 selectionFor 读投影 pending（当轮生效）→ 请求头链（跨轮持久）。
  //    插件不再自己 installModelSelection（会与官方形成双 hook 竞争，导致「下一轮回落」）。
  let eventNote = "";
  try {
    live.session.append("model/selection", { provider, model });
    eventNote = "，已写入 model/selection 事件";
  } catch (error) {
    eventNote = `，事件写入失败：${String(error?.message ?? error)}`;
  }
  let via = `model/selection 事件（官方投影接管）${eventNote}${overrideNote}，下一回合生效`;
  // ⑤ 官方接口优先（若该部署暴露）：
  //    · 新版：ctx.apiProxy.sessions.selectModel（会话级模型选择，持久化到会话）
  //    · 旧版：ctx.get("sessionController").selectModel（Typert @Remote，服务端直调可能不可用）
  //    两者任一成功都直接返回——它们比「只写事件」更权威（含模型归一化等官方处理）。
  const apiProxy = ctx.apiProxy ?? (typeof ctx.get === "function" ? ctx.get("apiProxy") : null);
  const proxySessions = apiProxy?.sessions;
  if (typeof proxySessions?.selectModel === "function") {
    try {
      await proxySessions.selectModel({ sessionId, provider, model });
      return { via: `ctx.apiProxy.sessions.selectModel（官方，会话级持久）${overrideNote}` };
    } catch (error) {
      log(ctx, `apiProxy.sessions.selectModel 失败（回退事件机制）: ${String(error?.message ?? error)}`);
    }
  }
  const sc = ctx.get("sessionController");
  if (typeof sc?.selectModel === "function") {
    try {
      await sc.selectModel({ sessionId, provider, model });
      via = `sessionController.selectModel（官方，立即生效）${overrideNote}`;
    } catch (error) {
      // 服务端直调 @Remote 可能不被支持——已走上面的「写事件」机制，这里只留日志
      log(ctx, `selectModel 直调不可用（已用 model/selection 事件机制）: ${String(error?.message ?? error)}`);
    }
  }
  return { via };
}

// ── 切换查证：按「事件」判定是否真的换成了新模型（注册 job，不轮询、不阻塞）──────────
//
// 【为什么按事件而不是等待】切换「下一回合才生效」，等待就等于阻塞调用方；而插件本来就拦着
// `agent/request`（每轮改写模型那处）—— 那里拿到的 provider/model 就是**本次请求真实使用**的值，
// 即「请求级权威记录」。于是：切换时登记一条待查证项，下次请求到达时按事件判定，结果入队回报。
//
// 【为什么不信提示语】上下文里注入的 `[model changed: …]` 与 `model/selection` 事件都只表达「意图」，
// 实测出现过「提示是 agnes、请求头仍是 wb」的不一致 —— 判定只认请求时实际使用的值。
const switchWatches = new Map(); // sessionId(目标) → { provider, model, at, requesterSessionId }
const lastRequestModels = new Map(); // sessionId → { provider, model, at }（进程内最近一次请求）
const pendingOutcomes = new Map(); // sessionId(回报对象) → [ { ok, provider, model, actual, at } ]

/** 登记一条待查证项（切换时调用）。requesterSessionId = 切换发起方，结果回报给它。 */
export function registerSwitchWatch(sessionId, provider, model, requesterSessionId = null) {
  if (!sessionId) return false;
  switchWatches.set(sessionId, { provider, model, at: Date.now(), requesterSessionId });
  return true;
}

/** 查看待查证项（诊断用；无则 null）。 */
export function peekSwitchWatch(sessionId) {
  return switchWatches.get(sessionId) ?? null;
}

/** 记录本次请求实际使用的模型，并在有待查证项时按事件判定结果。 */
export function noteRequestModel(sessionId, config) {
  const provider = config?.provider;
  const model = config?.model;
  if (!sessionId || !provider || !model) return null;
  const at = Date.now();
  lastRequestModels.set(sessionId, { provider, model, at });
  const watch = switchWatches.get(sessionId);
  if (!watch) return null;
  const ok = provider === watch.provider && model === watch.model;
  const outcome = { ok, expected: `${watch.provider}/${watch.model}`, actual: `${provider}/${model}`, at };
  switchWatches.delete(sessionId);
  const to = watch.requesterSessionId;
  if (to) {
    const list = pendingOutcomes.get(to) ?? [];
    list.push(outcome);
    pendingOutcomes.set(to, list);
  }
  return outcome;
}

/** 取走某会话待回报的查证结果（回报方调用一次即清空）。 */
export function takeSwitchOutcomes(sessionId) {
  if (!sessionId) return [];
  const list = pendingOutcomes.get(sessionId) ?? [];
  pendingOutcomes.delete(sessionId);
  return list;
}

/** 进程内最近一次请求使用的模型（无则 null；跨进程看 readLastRequestModel）。 */
export function peekLastRequestModel(sessionId) {
  return sessionId ? lastRequestModels.get(sessionId) ?? null : null;
}

/** 测试钩子：清空查证状态。 */
export function resetSwitchWatchForTest() {
  switchWatches.clear();
  lastRequestModels.clear();
  pendingOutcomes.clear();
}

/**
 * 读会话日志里「最近一次实际请求使用的模型」与「最近一次切换意图」。
 *
 * 数据来源（按可靠性排序）：
 *   · `request/header` 的 `data.header.config.{provider,model}` —— **请求级权威记录**（判定只看它）；
 *   · `model/selection` 的 `data.{provider,model}` —— 切换意图（有则一并返回，便于对照）。
 * 用按 zstd 帧流式读（常量内存），大日志也不会把整份文本读进内存。
 *
 * @returns {Promise<{lastRequest: {provider,model,time}|null, lastSelection: {provider,model,time}|null, scanned: number}>}
 */
export async function readLastRequestModel(sessionId, root = null) {
  const { sessionsRootOf, findSessionLogById } = await import("../../sessions/events.js");
  const file = findSessionLogById(sessionId, root ?? sessionsRootOf());
  if (!file) return { lastRequest: null, lastSelection: null, scanned: 0 };
  const { streamDecodedFrames } = await import("../../zstd-frames.js");
  const { StringDecoder } = await import("node:string_decoder");
  const buf = readFileSync(file);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let scanned = 0;
  let lastRequest = null;
  let lastSelection = null;
  const consume = (line) => {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === "request/header") {
      const cfg = event?.data?.header?.config;
      if (cfg?.provider && cfg?.model) { lastRequest = { provider: cfg.provider, model: cfg.model, time: event.time ?? null }; scanned += 1; }
      return;
    }
    if (event?.type === "model/selection" && event?.data?.provider) {
      lastSelection = { provider: event.data.provider, model: event.data.model, time: event.time ?? null };
    }
  };
  await streamDecodedFrames(buf, (chunk) => {
    pending += decoder.write(chunk);
    let idx;
    while ((idx = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      consume(line);
    }
  });
  pending += decoder.end();
  consume(pending);
  return { lastRequest, lastSelection, scanned };
}
