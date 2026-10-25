// dsh-session-conductor — 成员模型切换：执行切换
//
// 【职责】把一次「切模型」落到实处：持久化 override、必要时等回合暂停、
// 写 `model/selection` 事件（可观测 + 官方投影），未挂载时直接改会话日志文件。

import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createZstdDecompress } from "node:zlib";
import { replaceFileSync } from "../../shared/atomic-file.js";
import path from "node:path";
import { log } from "../../shared/log.js";
import { createStageTimer } from "../../shared/timing.js";
import { cfg } from "../../core/config.js";
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
/** 读出会话日志的文本行与事件（定位失败/解码失败/空日志返回 error）。 */
async function readSwitchLog(sessionId) {
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
  const lines = String(text).split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return { error: "会话日志为空" };
  const events = [];
  for (let i = 1; i < lines.length; i += 1) {
    try {
      events.push(JSON.parse(lines[i]));
    } catch {
      // 跳过坏行（写入前的 validateSessionText 会兜底）
    }
  }
  return { filePath, lines, events };
}

/** 写回前先备份（备份失败就不写，避免没有回滚点）。 */
function backupSwitchLog(filePath, sessionId) {
  const backupDir = path.join(path.dirname(filePath), ".model-switch-backup");
  try {
    mkdirSync(backupDir, { recursive: true });
    const file = path.join(backupDir, `${Date.now()}-${sessionId}.zstd`);
    copyFileSync(filePath, file);
    return { ok: true, file };
  } catch (error) {
    return { error: `备份失败（未写入）：${String(error?.message ?? error)}` };
  }
}

/** 写后自检不合格时把日志还原回备份（宁可不动日志，也不能留下 corrupt 的会话）。 */
function restoreSwitchLog(backup, filePath) {
  if (!backup?.file) return { error: "没有可用备份，无法回滚" };
  try {
    copyFileSync(backup.file, filePath);
    return { ok: true };
  } catch (error) {
    return { error: `回滚失败：${String(error?.message ?? error)}` };
  }
}

/**
 * 切换模型时同步修正「失效的 descriptor 路由」。
 *
 * 【为什么必须做】宿主 cold resume 子代理时，provider/model 取自会话日志里的
 * `subagent/descriptor`（manager.coldResume → materialize 的 agentOptions），
 * `model/selection` 不参与该路径。若 descriptor 仍指向一个已被删除的 provider
 * （例如配置里移除了某个渠道），materialize 必然失败并被统一包成
 * `subagent/not-resumable` —— 表现为「这个成员永远唤不醒，怎么切模型都没用」。
 * 因此这里在写入 selection 之后顺带校验 descriptor 的路由是否仍存在，失效就同步改掉。
 *
 * 保守原则：拿不到模型目录（服务不可用）或 descriptor 本就有效时，一律不动日志。
 *
 * @returns {Promise<{repaired?: boolean, skipped?: string, error?: string}>}
 */
async function repairDescriptorIfStale(ctx, filePath, sessionId, provider, model) {
  const { readDescriptorEvent } = await import("../../sessions/tail-io.js");
  const { readFile } = await import("node:fs/promises");
  let buf;
  try {
    buf = await readFile(filePath);
  } catch (error) {
    return { error: `读取会话日志失败：${String(error?.message ?? error)}` };
  }
  let found;
  try {
    found = await readDescriptorEvent(buf);
  } catch (error) {
    return { error: `读取 descriptor 失败：${String(error?.message ?? error)}` };
  }
  const descriptor = found.descriptor;
  if (!descriptor || typeof descriptor !== "object") return { skipped: "不是子代理会话（无 descriptor）" };

  // 取当前可用 provider 列表；拿不到就不猜、不动日志
  const sc = ctx.get("sessionController");
  if (typeof sc?.modelCatalog !== "function") return { skipped: "modelCatalog 不可用，跳过 descriptor 校验" };
  let groups;
  try {
    const catalog = await sc.modelCatalog();
    groups = catalog?.groups ?? [];
  } catch (error) {
    return { skipped: `modelCatalog 调用失败，跳过：${String(error?.message ?? error)}` };
  }
  if (groups.length === 0) return { skipped: "模型目录为空，跳过 descriptor 校验" };

  const providerIds = new Set(groups.map((g) => g.id));
  const staleProvider = descriptor.agentProvider !== undefined && !providerIds.has(descriptor.agentProvider);
  const staleModel = (() => {
    if (descriptor.agentProvider === undefined || descriptor.agentModel === undefined) return false;
    const group = groups.find((g) => g.id === descriptor.agentProvider);
    if (!group) return false;
    return !(group.models ?? []).some((m) => m.id === descriptor.agentModel);
  })();
  if (!staleProvider && !staleModel) return { skipped: "descriptor 路由有效" };

  // 整份重写（descriptor 在文件头部，追加帧改不了它）；这条路径只在路由失效时走一次，代价可接受
  const { encodeSessionText } = await lazyRepair();
  const { decodeAllFrames } = await import("../../zstd-frames.js");
  const fullText = buf.length > 0 ? await decodeAllFrames(buf) : "";
  const lines = fullText.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { error: "会话日志为空，无法修正 descriptor" };
  let patched = 0;
  for (let i = 1; i < lines.length; i += 1) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== "subagent/descriptor") continue;
    e.data.agentProvider = provider;
    e.data.agentModel = model;
    lines[i] = JSON.stringify(e);
    patched += 1;
    break;
  }
  if (patched === 0) return { skipped: "未找到可改写的 descriptor" };

  // 写前校验 seq 严格连续，避免把会话写成 corrupt
  let prev = -1, gaps = 0;
  for (let i = 1; i < lines.length; i += 1) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { error: "改写后存在坏行，放弃写盘" }; }
    if (typeof e.seq !== "number") continue;
    if (prev >= 0 && e.seq !== prev + 1) gaps += 1;
    prev = e.seq;
  }
  if (gaps > 0) return { error: `改写后 seq 不连续（${gaps} 处），放弃写盘` };

  const backup = backupSwitchLog(filePath, sessionId);
  if (backup.error) return { error: backup.error };
  replaceFileSync(filePath, await encodeSessionText(lines.join("\n") + "\n"), { tmpSuffix: ".descfixtmp" });
  log(ctx, `切换写日志：descriptor 路由失效（${staleProvider ? "provider 已不存在" : "model 不在目录"}），已改为 ${provider}/${model}`);
  return { repaired: true };
}

export async function appendSelectionEventToLog(ctx, sessionId, provider, model) {
  const startedAt = Date.now();
  // 这条路径会整份解码会话日志再整份写回，而宿主在同一会话上会并发追加事件
  // （turn/start、agent/inbox/spliced…）。若直接用「读到的 maxSeq+1」写回，就会写入过期序号，
  // 表现为 released v2 row N has seq gap（序号回退），整份会话随即被判 corrupt。
  // 因此这里做三件事：① 写前 CAS（对比快照是否已过期）② 过期就重读重试 ③ 写后自检 + 失败回滚。
  //
  // 【为什么改成「尾部读 + 追加帧」】原实现每次都整份解码（30MB 日志要 1~3s CPU 与数百 MB 内存），
  // 而追加一条事件只需要知道「尾部 seq」。这里只解码最后几帧拿尾部事件，写入也是「把新事件压缩成一个
  // 新帧追加到文件尾」——开销与日志总大小无关，且不回写已有帧（失败不会破坏历史）。
  const { readTailEvents, appendEventFrame } = await import("../../sessions/tail-io.js");
  let logInfo = await readSwitchLog(sessionId);
  if (logInfo.error) return { error: logInfo.error };
  const filePath = logInfo.filePath;
  log(ctx, `切换写日志：定位+首读 ${Date.now() - startedAt}ms（行数 ${logInfo.lines.length}）`);

  const tailOf = (events) => ({
    maxSeq: events.reduce((max, e) => (typeof e?.seq === "number" && e.seq > max ? e.seq : max), -1),
    count: events.length,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { events } = logInfo;
    const last = foldLastModelSelection(events);
    if (last && last.provider === provider && last.model === model) {
      return { ok: true, note: "日志里已是该模型，无需重复写入" };
    }
    const { maxSeq } = tailOf(events);
    const event = { type: "model/selection", seq: maxSeq + 1, time: Date.now(), data: { provider, model } };

    // ① CAS：写前再读一次尾部，确认快照期间宿主没有追加新事件（尾部 seq 未变才敢写）
    const { readFile } = await import("node:fs/promises");
    let freshTail;
    try {
      freshTail = await readTailEvents(await readFile(filePath), { tailFrames: 3 });
    } catch (error) {
      return { error: `写前重读失败：${String(error?.message ?? error)}` };
    }
    if (tailOf(freshTail.events).maxSeq !== maxSeq) {
      log(ctx, `切换写日志：快照已过期（第 ${attempt + 1} 次，尾部 seq ${maxSeq} → ${tailOf(freshTail.events).maxSeq}），重读重试`);
      logInfo = { ...logInfo, events: freshTail.events };
      continue;
    }

    // ② 追加帧（appendEventFrame 内部自证首帧契约 + 长度 CAS + fsync）
    const writeStartedAt = Date.now();
    const written = await appendEventFrame(filePath, event);
    log(ctx, `切换写日志：追加帧 ${Date.now() - writeStartedAt}ms（seq ${event.seq}）`);
    if (!written.ok) return { error: `写入会话日志失败：${written.error}` };
    // descriptor 路由失效会让成员永久唤不醒（宿主报 subagent/not-resumable），这里顺带修
    const descFix = await repairDescriptorIfStale(ctx, filePath, sessionId, provider, model);
    if (descFix.error) log(ctx, `切换写日志：descriptor 校验失败（不影响本次切换）：${descFix.error}`);

    // ③ 写后自检：只读尾部，确认新事件确实落在尾部且 seq 严格 +1 衔接
    try {
      const after = await readTailEvents(await readFile(filePath), { tailFrames: 3 });
      const seqs = after.events.map((e) => e?.seq).filter((n) => typeof n === "number");
      const tailOk = seqs.length > 0 && seqs.at(-1) === event.seq
        && seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1);
      if (tailOk) return { ok: true, note: "已直接写入会话日志" };
      log(ctx, `切换写日志：写后自检失败（尾部 ${JSON.stringify(seqs.slice(-3))}），回滚`);
    } catch (error) {
      log(ctx, `切换写日志：写后自检读取失败：${String(error?.message ?? error)}`);
    }
    // 追加帧写坏时只能整份回退：用备份整份恢复
    const backup = backupSwitchLog(filePath, sessionId);
    if (backup.error) return { error: `写后自检失败且无备份可回滚：${backup.error}` };
    restoreSwitchLog(backup, filePath);
    return { error: "写入后 seq 不连续，已回滚（不改日志，改用选择意图生效）" };
  }
  // 一直有并发写入：放弃写日志（不算失败，选择意图仍会生效）
  log(ctx, "切换写日志：并发写入持续存在，放弃写日志（不影响切换）");
  return { ok: true, note: "会话正在被并发写入，跳过日志写入（选择意图仍生效）" };
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
/**
 * ① 持久化切换意图：不依赖 live agent —— 成员 inactive/未挂载时也能切，下次运行生效。
 * @returns {Promise<{note: string}>} note 直接拼进回执
 */
async function persistSwitchIntent(ctx, sessionId, provider, model) {
  try {
    await setMemberModelOverride(ctx, sessionId, provider, model);
    return { note: "，已记录切换意图" };
  } catch (error) {
    return { note: `，意图持久化失败：${String(error?.message ?? error)}` };
  }
}

/**
 * ⑤ 官方接口优先（若该部署暴露）：
 *   · 新版 ctx.apiProxy.sessions.selectModel（会话级模型选择，持久化到会话）
 *   · 旧版 ctx.get("sessionController").selectModel（Typert @Remote，服务端直调可能不可用）
 * 任一成功返回 {via}；都不可用/失败返回 null（调用方回退到「写事件」机制）。
 */
async function tryOfficialSelectModel(ctx, sessionId, provider, model, overrideNote) {
  // 可关：某些部署上 selectModel（Typert @Remote）会长时间不返回，表现为「切模型卡住」。
  // 配置 modelSwitchOfficialApi=false 即只走「写 model/selection 事件」这条实测可用的路径。
  if (cfg.modelSwitchOfficialApi === false) {
    log(ctx, "已按配置跳过官方 selectModel（modelSwitchOfficialApi=false），仅写事件");
    return null;
  }
  const apiProxy = ctx.apiProxy ?? (typeof ctx.get === "function" ? ctx.get("apiProxy") : null);
  const proxySessions = apiProxy?.sessions;
  if (typeof proxySessions?.selectModel === "function") {
    const startedAt = Date.now();
    try {
      await proxySessions.selectModel({ sessionId, provider, model });
      log(ctx, `apiProxy.sessions.selectModel 成功，耗时 ${Date.now() - startedAt}ms`);
      return { via: `ctx.apiProxy.sessions.selectModel（官方，会话级持久）${overrideNote}` };
    } catch (error) {
      log(ctx, `apiProxy.sessions.selectModel 失败（耗时 ${Date.now() - startedAt}ms，回退事件机制）: ${String(error?.message ?? error)}`);
    }
  }
  const sc = ctx.get("sessionController");
  if (typeof sc?.selectModel !== "function") return null;
  const remoteStartedAt = Date.now();
  try {
    await sc.selectModel({ sessionId, provider, model });
    log(ctx, `sessionController.selectModel 成功，耗时 ${Date.now() - remoteStartedAt}ms`);
    return { via: `sessionController.selectModel（官方，立即生效）${overrideNote}` };
  } catch (error) {
    // 服务端直调 @Remote 可能不被支持——已走「写事件」机制，这里只留日志
    log(ctx, `selectModel 直调不可用（耗时 ${Date.now() - remoteStartedAt}ms，已用 model/selection 事件机制）: ${String(error?.message ?? error)}`);
    return null;
  }
}

export async function switchAgentModel(ctx, sessionId, provider, model, agent = null) {
  const timer = createStageTimer();
  try {
    return await applyModelSwitch(ctx, sessionId, provider, model, agent, timer);
  } finally {
    // 无论成功失败都留一行分阶段耗时：排查「切模型卡很久」时直接看慢在哪一段
    log(ctx, `模型切换耗时：${timer.summary()}（标记合计 ${timer.total()}ms）`);
  }
}

/** 切换主流程（逐段打点，计时器只观测、不改变行为）。 */
async function applyModelSwitch(ctx, sessionId, provider, model, agent, timer) {
  if (!sessionId) return { error: "缺少 sessionId（无法定位目标会话）" };
  // ① 持久化切换意图（不依赖 live agent——成员 inactive/未挂载时也能切，下次运行生效）
  const { note: overrideNote } = await persistSwitchIntent(ctx, sessionId, provider, model);
  timer.mark("写意图");
  const live = agent ?? ctx.get("agents")?.get?.(sessionId) ?? null;
  timer.mark("定位成员");
  // ② 成员当前未挂载（inactive）：直接把事件写进会话日志——官方 selectionFor 读投影即生效。
  //    （Team 成员唤醒走 sendMessage → followup，不经过 resumeSetupFor，只记意图不会被应用。）
  if (typeof live?.ctx?.on !== "function" || !live?.session) {
    const written = await appendSelectionEventToLog(ctx, sessionId, provider, model);
    timer.mark("写会话日志");
    if (written.error) {
      return { error: `成员未挂载，且写入会话日志失败：${written.error}（切换意图已记录，可稍后重试）` };
    }
    return { via: `已写入会话日志的 model/selection 事件（成员未挂载）${written.note ? "，" + written.note : ""}${overrideNote}，该成员下次运行时生效` };
  }
  // ③ 正在执行回合：等它暂停再切（当前回合已用旧模型发出请求，直接切会「只生效一回合」）
  const IDLE_WAIT_MS = 60_000;
  if (live.status === "running" || hasOpenTurn(live.session?.events)) {
    log(ctx, `目标成员在运行中（status=${live.status ?? "?"}），先等其空闲再切（最多 ${IDLE_WAIT_MS}ms）`);
    const idle = await waitForIdle(live, IDLE_WAIT_MS);
    timer.mark("等空闲");
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
    timer.mark("写事件");
  } catch (error) {
    eventNote = `，事件写入失败：${String(error?.message ?? error)}`;
  }
  let via = `model/selection 事件（官方投影接管）${eventNote}${overrideNote}，下一回合生效`;
  // ⑤ 官方接口优先（若该部署暴露）：
  //    · 新版：ctx.apiProxy.sessions.selectModel（会话级模型选择，持久化到会话）
  //    · 旧版：ctx.get("sessionController").selectModel（Typert @Remote，服务端直调可能不可用）
  //    两者任一成功都直接返回——它们比「只写事件」更权威（含模型归一化等官方处理）。
  const official = await tryOfficialSelectModel(ctx, sessionId, provider, model, overrideNote);
  timer.mark("官方接口");
  if (official) return official;
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
 * 把一个会话事件归类成「请求头」或「切换意图」，都不是则返回 null。
 * 抽出来是为了让 readLastRequestModel 的流式解析循环只负责「读一行 → 交给它判」。
 * @returns {{kind:'request'|'selection', value:{provider:string, model:string, time:number|null}}|null}
 */
function modelEventOf(event) {
  if (event?.type === "request/header") {
    const config = event?.data?.header?.config;
    if (!config?.provider || !config?.model) return null;
    return { kind: "request", value: { provider: config.provider, model: config.model, time: event.time ?? null } };
  }
  if (event?.type === "model/selection" && event?.data?.provider) {
    return {
      kind: "selection",
      value: { provider: event.data.provider, model: event.data.model, time: event.time ?? null },
    };
  }
  return null;
}

/**
 * 读会话日志里「最近一次实际请求使用的模型」与「最近一次切换意图」。
 *
 * 数据来源（按可靠性排序）：
 *   · `request/header` 的 `data.header.config.{provider,model}` —— **请求级权威记录**（判定只看它）；
 *   · `model/selection` 的 `data.{provider,model}` —— 切换意图（有则一并返回，便于对照）。
 * 用按 zstd 帧流式读（常量内存），大日志也不会把整份文本读进内存。
 *
 * 【内存纪律】① `pending` 加上限：只在「遇到换行才切走」的缓冲区，若某帧内长时间没有换行
 * （单行超大事件，例如几 MB 的工具结果）会无限增长；超过上限直接抛错，不再硬撑。
 * ② `readFile` 换成只读**最后若干帧**：查证只关心「最近一次请求」，没必要把整份文件读进内存
 * （30MB 日志时这一项就省掉一份整文件 Buffer）。
 *
 * @returns {Promise<{lastRequest: {provider,model,time}|null, lastSelection: {provider,model,time}|null, scanned: number}>}
 */
export async function readLastRequestModel(sessionId, root = null) {
  const { sessionsRootOf, findSessionLogById } = await import("../../sessions/events.js");
  const file = findSessionLogById(sessionId, root ?? sessionsRootOf());
  if (!file) return { lastRequest: null, lastSelection: null, scanned: 0 };
  const { streamDecodedFrames } = await import("../../zstd-frames.js");
  const { StringDecoder } = await import("node:string_decoder");
  const buf = await readFile(file); // 日志最大可达数十 MB，异步读避免阻塞事件循环
  const { scanZstdFrames } = await import("../../zstd-frames.js");
  // 只流式解码最后若干帧：请求头/选择意图判定只关心最近一次，够用且省内存
  const TAIL_FRAMES = 8;
  let tailFrames;
  try {
    const { frames } = scanZstdFrames(buf);
    tailFrames = frames.slice(Math.max(0, frames.length - TAIL_FRAMES));
  } catch {
    // 帧扫描失败（文件损坏）：退回整份流式解码，让上层按损坏处理，不在这里静默丢数据
    tailFrames = null;
  }
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let scanned = 0;
  let lastRequest = null;
  let lastSelection = null;
  const PENDING_LIMIT = 8 * 1024 * 1024; // 单行缓冲上限：超过即视为异常，避免无上限增长
  const consume = (line) => {
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const hit = modelEventOf(event);
    if (hit === null) return;
    if (hit.kind === "request") {
      lastRequest = hit.value;
      scanned += 1;
    } else {
      lastSelection = hit.value;
    }
  };
  const onChunk = (chunk) => {
    pending += decoder.write(chunk);
    if (pending.length > PENDING_LIMIT) {
      throw new Error(`readLastRequestModel 单行缓冲超过 ${PENDING_LIMIT} 字节仍无换行（疑似异常大事件）`);
    }
    let idx;
    while ((idx = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      consume(line);
    }
  };
  if (tailFrames === null) {
    await streamDecodedFrames(buf, onChunk);
  } else {
    for (const fr of tailFrames) {
      await new Promise((resolve, reject) => {
        const d = createZstdDecompress();
        d.on("data", (c) => { try { onChunk(c); } catch (error) { reject(error); } });
        d.on("end", resolve);
        d.on("error", reject);
        d.write(buf.subarray(fr.start, fr.end));
        d.end();
      });
    }
  }
  pending += decoder.end();
  consume(pending);
  return { lastRequest, lastSelection, scanned };
}
