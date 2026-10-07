// dsh-session-conductor — 自动重命名分析引擎
//
// 【职责】判断会话主题是否偏离标题，必要时调用 LLM 生成新标题并重命名。
// 含：调度防抖、并发闸、模型路由三级优先级、单次模型覆盖、LLM 输出解析。

import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { log } from "../../shared/log.js";
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

/** 带并发闸的分析入口。opts.model 给定 → 本次分析临时用该模型（不持久化）。 */
export async function runAnalysis(ctx, sessionId, opts = {}) {
  while (activeAnalyses >= AUTO_RENAME_MAX_CONCURRENT) {
    await new Promise((resolve) => setTimeout(resolve, 250));
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
export async function resolveModelOverride(ctx, modelArg, fallbackRoute) {
  const raw = String(modelArg ?? "").trim();
  if (!raw) return null;
  // "provider/model" 显式拆分；不匹配（含纯模型名）→ 走 catalog 匹配/fallback
  const explicit = /^([^/]+)\/(.+)$/.exec(raw);
  if (explicit) {
    const provider = explicit[1].trim();
    const model = explicit[2].trim();
    if (provider && model) return { provider, model };
  }
  // 纯模型名：modelCatalog 里找第一个含该 model 的分组
  try {
    const sc = ctx.get("sessionController");
    const catalog = sc?.modelCatalog ? await sc.modelCatalog() : null;
    const groups = catalog?.groups ?? [];
    for (const g of groups) {
      if ((g.models ?? []).some((m) => m.id === raw || m.name === raw)) {
        return { provider: g.id, model: raw };
      }
    }
  } catch {
    // catalog 不可用 → 落到 fallback provider
  }
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
  const session = sessions?.get(sessionId);
  if (!session || !titleService || !llm) {
    return { ok: false, error: { code: "unavailable", message: "sessions / sessionTitle / llm 服务不可用" } };
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

  // 记账先行：无论结果如何都推进游标，避免反复分析同一批消息
  await patchSwitch(ctx, "autoRename", sessionId, { lastAnalysisSeq: lastSeq, lastAnalysisAt: now }, { enabled: false });

  const decision = await driftAnalysisLlm(llm, session, route, currentTitle, recent, (message) => log(ctx, message), isFallbackTitle);
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
  const text = [
    `当前标题：${currentTitle ?? "（无标题）"}`,
    "最近对话（用户消息数组，按时间顺序）：",
    JSON.stringify(recent.map((message) => message.text))
  ].join("\n");

  const options = {
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor" }
    })],
    system,
    maxTokens: 200,
    sessionId: session.id,
    purpose: "session-conductor-auto-rename",
    signal: AbortSignal.timeout(AUTO_RENAME_TIMEOUT_MS)
  };

  try {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream(options)) assembler.push(chunk);
    const blocks = assembler.blocks();
    const raw = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
    if (forceTitle) {
      // 强制生成模式：只要 {title: "..."}，不判断偏离
      const t = extractTitleOnly(raw);
      if (t === null) return { kind: "error", message: "LLM 未给出有效标题（模型不可用或输出异常）" };
      return { kind: "changed", title: t };
    }
    const parsed = parseDriftJson(raw);
    if (parsed === null) return { kind: "error", message: "LLM 输出无法解析为 JSON（模型不可用或输出异常）" };
    if (parsed.changed && typeof parsed.title === "string" && parsed.title.trim() !== "") {
      return { kind: "changed", title: parsed.title };
    }
    return { kind: "unchanged" };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (typeof onError === "function") onError(`自动重命名 LLM 调用失败 ${session.id}: ${message}`);
    return { kind: "error", message };
  }
}

/** 提取 `{"title": "..."}` 中的标题（forceTitle 模式专用；无 title 返回 null）。 */
export function extractTitleOnly(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === "object" && typeof parsed.title === "string" && parsed.title.trim() !== "") {
      return parsed.title;
    }
    return null;
  } catch {
    return null;
  }
}

/** 解析 LLM 输出的严格 JSON（容忍代码块围栏）。 */
export function parseDriftJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed === null || typeof parsed !== "object" || typeof parsed.changed !== "boolean") return null;
    return {
      changed: parsed.changed,
      ...typeof parsed.title === "string" ? { title: parsed.title } : {}
    };
  } catch {
    return null;
  }
}

/** 测试钩子：清空待执行分析定时器并复位并发计数。 */
export function resetAnalysisForTest() {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  activeAnalyses = 0;
}
