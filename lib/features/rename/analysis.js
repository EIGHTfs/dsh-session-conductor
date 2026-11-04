// dsh-session-conductor — 自动重命名分析引擎
//
// 【职责】判断会话主题是否偏离标题，必要时调用 LLM 生成新标题并重命名。
// 含：调度防抖、并发闸、模型路由三级优先级、单次模型覆盖、LLM 输出解析。

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { summarizeStream } from "../../shared/llm-stream-summary.js";
import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { log } from "../../shared/log.js";
import { pickParseSource, extractTitleOnly, parseDriftJson, resolveAnalysisMaxTokens } from "./parse.js";
import { pluginState } from "../../core/domain.js";
import { cfg, autoRenameEnabled, readSwitch, patchSwitch } from "../../core/config.js";
import { sessionEventList } from "../../sessions/events.js";
import {
  collectSessionTitleMessages, titleString, stateSuffixOf, stripTitleStateSuffix,
} from "./title.js";

/** 自动重命名的门槛与限流参数。 */
const AUTO_RENAME_MIN_TOTAL_MESSAGES = 3; // 至少多少条用户消息才开始分析
const AUTO_RENAME_MIN_NEW_MESSAGES = 3; // 距上次分析至少新增多少条才再分析
const AUTO_RENAME_MIN_INTERVAL_MS = 5 * 60 * 1000; // 同会话分析最小间隔
const AUTO_RENAME_DEBOUNCE_MS = 8000; // 回合结束后延迟，等日志落定
const AUTO_RENAME_RECENT = 12; // 参与判断的最近用户消息数
const AUTO_RENAME_TIMEOUT_MS = 45 * 1000; // 单次 LLM 分析超时
export { AUTO_RENAME_TIMEOUT_MS };
const AUTO_RENAME_MAX_CONCURRENT = 2; // 全局并发分析上限
const AUTO_RENAME_TITLE_MAX_BYTES = 80; // 新标题字节上限

/** 待执行的分析定时器（会话级防抖；取消/删除会话时要清理）。 */
export const pendingTimers = new Map();
let activeAnalyses = 0;

/** 回合结束后延迟调度一次分析（同会话防抖）。 */
export function scheduleAnalysis(ctx, sessionId) {
  const existing = pendingTimers.get(sessionId);
  if (existing !== void 0) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(sessionId);
    runAnalysis(ctx, sessionId).catch((error) => {
      log(ctx, `自动重命名分析失败 ${sessionId}: ${String(error?.message ?? error)}`);
    });
  }, AUTO_RENAME_DEBOUNCE_MS);
  timer.unref?.();
  pendingTimers.set(sessionId, timer);
}

/** 分析并发闸轮询间隔（毫秒）：与核心续跑闸同节奏。 */
const ANALYSIS_GATE_POLL_MS = 250;

/** 带并发闸的分析入口。opts.model 给定 → 本次分析临时用该模型（不持久化）。 */
export async function runAnalysis(ctx, sessionId, opts = {}) {
  while (activeAnalyses >= AUTO_RENAME_MAX_CONCURRENT) {
    await new Promise((resolve) => setTimeout(resolve, ANALYSIS_GATE_POLL_MS));
  }
  activeAnalyses += 1;
  try {
    return await analyzeSession(ctx, sessionId, opts);
  } finally {
    activeAnalyses -= 1;
  }
}

/**
 * 解析单次模型覆盖参数：支持 "provider/model" 或纯模型名（自动从官方
 * modelCatalog 匹配 provider；匹配不到则借用当前路由的 provider）。
 * @returns {provider, model} 或 null（无法解析）
 */
/** 拆 "provider/model" 形式；不是该形式返回 null（含纯模型名）。 */
function splitExplicitModel(raw) {
  const matched = /^([^/]+)\/(.+)$/.exec(raw);
  if (!matched) return null;
  const provider = matched[1].trim();
  const model = matched[2].trim();
  return provider && model ? { provider, model } : null;
}

/** 纯模型名：在 modelCatalog 里找第一个包含该模型的分组；catalog 不可用返回 null。 */
async function providerOfModelName(ctx, raw) {
  try {
    const sc = ctx.get("sessionController");
    const catalog = sc?.modelCatalog ? await sc.modelCatalog() : null;
    for (const group of catalog?.groups ?? []) {
      if ((group.models ?? []).some((m) => m.id === raw || m.name === raw)) {
        return { provider: group.id, model: raw };
      }
    }
  } catch {
    // catalog 不可用 → 交给 fallback provider
  }
  return null;
}

export async function resolveModelOverride(ctx, modelArg, fallbackRoute) {
  const raw = String(modelArg ?? "").trim();
  if (!raw) return null;
  const explicit = splitExplicitModel(raw);
  if (explicit) return explicit;
  const byCatalog = await providerOfModelName(ctx, raw);
  if (byCatalog) return byCatalog;
  if (fallbackRoute?.provider) return { provider: fallbackRoute.provider, model: raw };
  return null;
}

/**
 * 分析一个会话：若已开启自动重命名，判断主题是否偏离当前标题，必要时重命名。
 * opts.model 给定 → 本次分析临时用该模型（不持久化，优先级最高）。
 * opts.manual 给定（手动 API）→ 跳过限频/新消息数/总消息数门槛（显式意图即执行）；
 *   自动触发（user/message、turn/end）不传 manual，仍受门槛保护。
 * 返回 {ok, renamed, title?, before, after, reason?} 供 API 与自动触发共用。
 */
export async function analyzeSession(ctx, sessionId, opts = {}) {
  const sessions = ctx.get("sessions");
  const titleService = ctx.get("sessionTitle");
  const llm = ctx.get("llm");
  // 三件缺哪个说哪个：此前一律报「sessions / sessionTitle / llm 服务不可用」，
  // 而最常见的成因只是**目标会话没挂载在内存**（归档/冷会话），被误报成宿主服务坏了。
  if (!titleService || !llm) {
    return { ok: false, error: { code: "unavailable", message: "宿主 sessionTitle / llm 服务不可用" } };
  }
  const session = sessions?.get(sessionId);
  if (!session) {
    return { ok: false, error: { code: "not-live", message: "该会话未挂载在内存（归档或冷会话）：在界面打开一次后再分析即可" } };
  }

  const state = await pluginState(ctx);
  if (!autoRenameEnabled(ctx, state, sessionId)) {
    return { ok: false, error: { code: "not-enabled", message: "该会话未开启自动重命名" } };
  }

  const setting = readSwitch("autoRename", sessionId) ?? {};
  const now = Date.now();
  // 手动 API（opts.manual）跳过自动门槛；自动触发受限频 + 消息数门槛保护（防每条消息都烧 LLM）
  if (!opts?.manual) {
    if (setting.lastAnalysisAt !== void 0 && now - setting.lastAnalysisAt < AUTO_RENAME_MIN_INTERVAL_MS) {
      return { ok: false, error: { code: "rate-limited", message: "距上次分析不足最小间隔，稍后再试" } };
    }
  }

  // ⚠️ v3 会话无 events 属性：用 sessionEventList()（snapshotEvents fallback）取事件
  const messages = collectSessionTitleMessages(sessionEventList(session));
  if (!opts?.manual) {
    if (messages.length < AUTO_RENAME_MIN_TOTAL_MESSAGES) {
      return { ok: false, error: { code: "too-few-messages", message: "对话消息太少，暂不分析" } };
    }
    const newMessages = setting.lastAnalysisSeq === void 0 ? messages : messages.filter((m) => m.seq > setting.lastAnalysisSeq);
    if (newMessages.length < AUTO_RENAME_MIN_NEW_MESSAGES) {
      return { ok: false, error: { code: "too-few-new", message: `距上次分析仅 ${newMessages.length} 条新消息，暂不分析` } };
    }
  }
  const lastSeq = messages.at(-1)?.seq;

  // 当前标题快照：fallback（首句截断兜底）质量差 → 强制 LLM 生成精炼标题替换；
  // user/provider 标题尊重（不强制）
  const snapshot = titleService.get(session);
  const currentTitle = titleString(snapshot) ?? null;
  const isFallbackTitle = snapshot?.source?.kind === "fallback";
  const recent = messages.slice(-AUTO_RENAME_RECENT);
  let route = resolveRoute(session, llm, state);
  // 单次模型覆盖（手动 API 传入 model）：优先级最高，不持久化
  if (opts?.model) {
    const override = await resolveModelOverride(ctx, opts.model, route);
    if (override?.provider && override?.model) route = override;
  }
  if (!route) {
    return { ok: false, before: currentTitle, after: currentTitle, error: { code: "no-route", message: "无法确定模型路由（会话无 request/header 且无可用模型）" } };
  }

  // 提示词素材与「记忆取回」同源（readRecentUserTurns：每轮 = 用户消息 + 该轮 AI 首反应）：
  // 带 AI 反应后模型判断偏离时能看到自己当时怎么答的，减少把「已在处理的请求」误判成新主题。
  // 门槛/游标仍用上面的 live 事件计数——素材是尽力而为，读不到就退回纯用户消息。
  let promptTurns = null;
  try {
    const { readRecentUserTurns } = await import("../../sessions/events.js");
    promptTurns = await readRecentUserTurns(ctx, sessionId, { rounds: AUTO_RENAME_RECENT, maxCharsPerItem: 1200 });
  } catch {
    promptTurns = null;
  }
  const recentForPrompt = (promptTurns && promptTurns.length > 0)
    ? promptTurns
    : recent.map((message) => ({ userText: message.text, agentText: "" }));

  // 记账先行：无论结果如何都推进游标，避免反复分析同一批消息
  await patchSwitch(ctx, "autoRename", sessionId, { lastAnalysisSeq: lastSeq, lastAnalysisAt: now }, { enabled: false });

  const decision = await driftAnalysisLlm(llm, session, route, currentTitle, recentForPrompt, (message) => log(ctx, message), isFallbackTitle);
  if (decision.kind === "error") {
    return { ok: false, before: currentTitle, after: currentTitle, error: { code: "llm-failed", message: decision.message } };
  }
  if (decision.kind === "unchanged") {
    return { ok: true, renamed: false, before: currentTitle, after: currentTitle, reason: "LLM 判断对话主题未明显偏离当前标题" };
  }

  const title = normalizeSessionTitle(decision.title.trim(), AUTO_RENAME_TITLE_MAX_BYTES);
  if (title === "" || title === stripTitleStateSuffix(currentTitle)) {
    return { ok: true, renamed: false, before: currentTitle, after: currentTitle, reason: "LLM 判断对话主题未明显偏离当前标题" };
  }

  // 主题标题由 LLM 生成；状态后缀由状态机维护（随回合开始/结束实时刷新）
  const suffix = cfg.titleStateSuffix === false ? "" : stateSuffixOf(session.events);
  const finalTitle = `${title}${suffix}`;
  try {
    titleService.rename(session, finalTitle);
  } catch (error) {
    return { ok: false, before: currentTitle, after: currentTitle, error: { code: "rename-failed", message: String(error?.message ?? error) } };
  }
  // 改完标题立刻让列表缓存作废：冷会话的标题来自落盘索引（revision 没变就不重算），
  // 不作废就会出现「后端已改名、面板还显示旧标题」。
  try {
    const { markSessionListStale } = await import("../../sessions/list-cache.js");
    markSessionListStale(ctx, session.id);
  } catch { /* 缓存作废失败不影响重命名本身 */ }
  log(ctx, `自动重命名 ${sessionId}: "${currentTitle ?? "（无标题）"}" → "${finalTitle}"`);
  return { ok: true, renamed: true, before: currentTitle, after: finalTitle, title: finalTitle, reason: "对话主题明显偏移，已自动重命名" };
}

/** 自动重命名/价值分析的模型路由，三级优先级（高→低）：
 *  ① 设置页选择的模型（state.autoRenameModel，传 state 时生效）
 *  ② patch 配置 autoRenameProvider+Model（成对）
 *  ③ 会话 request/header 的对话模型 */
export function resolveRoute(session, llm, state) {
  const picked = state?.autoRenameModel ?? null;
  if (picked?.provider && picked?.model) {
    return { provider: picked.provider, model: picked.model };
  }
  if (cfg.autoRenameProvider && cfg.autoRenameModel) {
    return { provider: cfg.autoRenameProvider, model: cfg.autoRenameModel };
  }
  const config = session.requestHeader?.()?.config;
  if (config?.provider && config?.model) return { provider: config.provider, model: config.model };
  return null;
}

/**
 * 用 LLM 判断主题是否偏移 / 强制生成标题。返回判别结果：
 *   {kind:"changed", title} | {kind:"unchanged"} | {kind:"error", message}
 * forceTitle=true（当前标题是 fallback 截断兜底）：不判断偏离，直接要求 LLM
 * 生成精炼好标题（{title} JSON），替换质量差的截断标题。
 * ⚠️ LLM 输出无法解析 / 无有效标题 → {kind:"error"}（不再静默当 unchanged，
 *   让调用方/用户看到「模型不可用或输出异常」，而不是误以为主题未偏离）。
 * onError 可选日志。
 */
/**
 * 描述「流成功结束但内容解析不出来」的具体形态，供错误文案区分三种成因：
 * 完全没有文本、只有思考没有正文、有正文但不是 JSON——三者的处置方式不同。
 * @param {{text:string,reasoning:string}} outcome summarizeStream 的成功分支
 * @returns {string}
 */
function describeOutcome(outcome) {
  const text = String(outcome?.text ?? "");
  const reasoning = String(outcome?.reasoning ?? "");
  if (text.trim() === "" && reasoning.trim() === "") return "返回内容为空，可能是模型未产出或被上游截流";
  if (text.trim() === "") return `只有思考内容没有正文（思考 ${reasoning.length} 字，正文为空；建议调大 maxTokens 或换不思考的模型）`;
  return `正文不是预期 JSON（前 60 字：${text.slice(0, 60).replace(/\s+/g, " ")}）`;
}

export async function driftAnalysisLlm(llm, session, route, currentTitle, recent, onError, forceTitle = false) {
  const system = forceTitle ? [
    "你是 DSH（DeepSeek Harness）会话标题分析师。",
    "当前标题是系统从首条消息截断生成的临时标题（不完整、质量差）。",
    "请直接根据最近消息内容给出一个简洁精炼的好标题，使用对话的语言（中文约 10 字 / 英文约 5 词），简洁不解释。",
    "输出严格 JSON，不要任何其他文字、解释、Markdown 或代码块标记：",
    '{"title": "新标题"}'
  ].join("\n") : [
    "你是 DSH（DeepSeek Harness）会话标题分析师。",
    "会话有一个标题；当对话的主题或方向已明显偏离该标题时，应提出一个更贴切的新标题。",
    "判断依据是最近的消息内容；只有明显偏离时才改名，否则保持原样。",
    "标题使用对话的语言（中文约 10 字 / 英文约 5 词），简洁不解释。",
    "输出严格 JSON，不要任何其他文字、解释、Markdown 或代码块标记：",
    '{"changed": true, "title": "新标题"}  或  {"changed": false}'
  ].join("\n");
  // 兼容两种素材形态：记忆取回同源轮次（userText + agentText，优先）与纯用户消息（回退）
  const dialogLines = (Array.isArray(recent) ? recent : []).map((item, index) => {
    const userText = item?.userText ?? item?.text ?? "";
    const agentText = item?.agentText ?? "";
    return agentText
      ? `[${index + 1}] 说话人=人 | ${userText}\n    说话人=AI 当时回应 | ${agentText}`
      : `[${index + 1}] 说话人=人 | ${userText}`;
  });
  const text = [
    `当前标题：${currentTitle ?? "（无标题）"}`,
    "最近对话（按时间顺序；含每轮用户消息与该轮 AI 的第一条回应）：",
    dialogLines.join("\n")
  ].join("\n");

  const options = {
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor" }
    })],
    system,
    // 预算给思考型模型留足空间：实测 512 时 sa6400/cn:hy3 一类模型思考没写完就被截断
    // （正文为空），整条自动重命名失效。默认 2048；配置 autoRenameMaxTokens=0 表示不限制
    // （不传该字段，宿主按模型 defaultMaxTokens 兜底）。
    ...(() => {
      const budget = resolveAnalysisMaxTokens(cfg.autoRenameMaxTokens);
      return budget === undefined ? {} : { maxTokens: budget };
    })(),
    sessionId: session.id,
    purpose: "session-conductor-auto-rename",
    signal: AbortSignal.timeout(AUTO_RENAME_TIMEOUT_MS)
  };

  // 流不抛错、失败藏在 finish chunk 里——统一交给 llm-stream-summary 分类：
  // 429/配额/超时/截断必须如实上报，不能塌缩成「输出无法解析」误导排查。
  const outcome = await summarizeStream(llm.stream(options));
  let raw = "";
  if (outcome.ok) {
    // collectStream 已从 block-end chunk 折叠出成品 blocks（Assembler 只接受原始流，
    // 这里没有原始流可喂，直接用折叠结果，语义一致）
    raw = pickParseSource(outcome.blocks);
  } else if (outcome.kind === "truncated") {
    // 截断不直接判死：思考型经常把 JSON 写在思考里、正文未来得及写就被切——
    // 先在已有思考/正文里按规范找 JSON，找到了照常用；找不到再报截断。
    raw = pickParseSource([
      ...outcome.blocks,
      ...(outcome.reasoning ? [{ type: "reasoning", text: outcome.reasoning }] : []),
      ...(outcome.text ? [{ type: "text", text: outcome.text }] : []),
    ]);
    if (forceTitle ? extractTitleOnly(raw) === null : parseDriftJson(raw) === null) {
      const message = `模型输出被 maxTokens 截断且截断内容里没有找到规范 JSON（${route.provider}/${route.model}）`;
      if (typeof onError === "function") onError(`自动重命名 LLM 调用失败 ${session.id}: ${message}`);
      return { kind: "error", message };
    }
  } else {
    const statusHint = outcome.status ? ` HTTP ${outcome.status}` : "";
    const waitHint = outcome.retryAfterMs ? `，建议 ${Math.ceil(outcome.retryAfterMs / 1000)}s 后再试` : "";
    const message = `模型调用失败（${route.provider}/${route.model}）：${outcome.code}${statusHint} ${outcome.message}${waitHint}`;
    if (typeof onError === "function") onError(`自动重命名 LLM 调用失败 ${session.id}: ${message}`);
    return { kind: "error", message };
  }
  if (forceTitle) {
    // 强制生成模式：只要 {title: "..."}，不判断偏离
    const t = extractTitleOnly(raw);
    if (t === null) return { kind: "error", message: `LLM 未给出有效标题（${route.provider}/${route.model}：${describeOutcome(outcome)}）` };
    return { kind: "changed", title: t };
  }
  const parsed = parseDriftJson(raw);
  if (parsed === null) return { kind: "error", message: `LLM 输出无法解析为 JSON（${route.provider}/${route.model}：${describeOutcome(outcome)}）` };
  if (parsed.changed && typeof parsed.title === "string" && parsed.title.trim() !== "") {
    return { kind: "changed", title: parsed.title };
  }
  return { kind: "unchanged" };
}

/** 提取 `{"title": "..."}` 中的标题（forceTitle 模式专用；无 title 返回 null）。 */
// 解析函数已抽到 ./parse.js；这里再导出，保持既有引用路径不变。
export { pickParseSource, extractTitleOnly, parseDriftJson };

/** 测试钩子：清空待执行分析定时器并复位并发计数。 */
export function resetAnalysisForTest() {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  activeAnalyses = 0;
}
