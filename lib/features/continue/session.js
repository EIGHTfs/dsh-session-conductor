// dsh-session-conductor — 自动续跑：执行（resume / followup / 记账）与跨会话消息投递
//
// 【职责】真正把一个续跑跑起来：live 会话直接 followup，cold 会话
// agents.resume()（原模型路由 + 原 preset）→ followup → 等回合 → flush → dispose。
// 判定（该不该续）在 eligibility.js，本文件只管执行。

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { log } from "../../shared/log.js";
import { hasOpenTurn } from "../../sessions/turn.js";
import { sessionEventsOf } from "../../sessions/events.js";
import { interruptionInfo, isAutoEligible } from "../../sessions/interruption.js";
import { foldLastRoute, defaultModelSelection } from "../../sessions/route.js";
import { pluginState } from "../../core/domain.js";
import { cfg, readSwitch, patchSwitch } from "../../core/config.js";
import { continueJobs, withSessionLock, withConcurrencyGate } from "../../core/state.js";
import { resumeSetupFor } from "../member-model/index.js";
import { autoContinueEffectiveForRun, continueAllowed, buildContinuePrompt } from "./eligibility.js";

/** 插件消息来源标识：注入事件与消息都标这个 kind，便于宿主区分消息来自本插件。 */
const PLUGIN_SOURCE_KIND = "plugin:dsh-session-conductor";

/** 等待 agent 回合结束；超时则取消回合（结果按中断记录，不再自动续）。 */
export async function waitTurn(ctx, agent) {
  const idle = agent.whenIdle();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        agent.cancel({ kind: "timeout" }, { keepInbox: false });
      } catch {
        // 忽略：agent 可能已 idle
      }
      reject(new Error(`续跑回合超过 ${Math.round(cfg.turnTimeoutMs / 60000)} 分钟未结束，已取消`));
    }, cfg.turnTimeoutMs);
  });
  timer?.unref?.();
  try {
    await Promise.race([idle, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 续跑一个会话（手动与自动共用）。
 *   - 串行锁 → 读事件流 → 中断判定 → （自动）门槛/活跃上限 → 执行 → 记账
 *   - live 会话：直接 followup 现有 agent，不接管生命周期
 *   - cold 会话：agents.resume()（原模型路由 + 原 preset 组合）→ followup →
 *     等回合结束 → flush → dispose() 释放 agent，活跃数回落
 * 返回 {ok, accepted?} 或 {ok:false, error:{code,message}}。
 */
export async function continueSession(ctx, sessionId, { auto = false } = {}) {
  return withSessionLock(sessionId, async () => {
    // prepare 段永不 throw：所有校验失败都归入 {error}，保证 withSessionLock 的 run 不 reject
    const prepared = await prepareContinue({ ctx, sessionId, auto });
    if (prepared.error) return { ok: false, error: prepared.error };
    const { agents, sessions, found, info, liveAgent } = prepared;

    const prompt = buildContinuePrompt(info);
    continueJobs.set(sessionId, Date.now());
    try {
      await runContinueTurn({ ctx, agents, sessions, found, info, liveAgent, prompt, sessionId });
      // 记账：推进 lastContinuedSeq 等，防重复续跑（落盘 config.json，重启保留）
      await markContinued({ ctx, sessionId, info });
      log(ctx, `已续跑会话 ${sessionId}（${info.kind}${info.code ? `/${info.code}` : ""}）`);
      return { ok: true, accepted: true, info };
    } catch (error) {
      const message = String(error?.message ?? error);
      log(ctx, `续跑会话 ${sessionId} 失败: ${message}`);
      return { ok: false, error: { code: "continue-failed", message } };
    } finally {
      continueJobs.delete(sessionId);
    }
  });
}

/**
 * 续跑前的全部校验：会话存在 → 不在运行 → 确实是「非人为中断」→（自动）门槛与活跃上限。
 *
 * 抽出来的原因：这段有 8 个 return 分支，内联在 continueSession 里会把主流程淹掉。
 * 返回值语义：成功给 {agents, sessions, found, info, liveAgent}，失败给 {error}（不 throw）。
 *
 * @param {{ctx: object, sessionId: string, auto: boolean}} deps
 * @returns {Promise<{agents?: object, sessions?: object, found?: object, info?: object,
 *   liveAgent?: object|undefined, error?: {code: string, message: string}}>}
 */
async function prepareContinue({ ctx, sessionId, auto }) {
  try {
    const target = await resolveContinueTarget({ ctx, sessionId });
    if (target.error) return { error: target.error };
    if (auto) {
      const gate = await autoContinueGate({ ctx, sessionId, info: target.info, found: target.found, agents: target.agents });
      if (gate.error) return { error: gate.error };
    }
    return target;
  } catch (error) {
    // prepare 段异常统一兜底：不进执行段，直接返回失败
    return { error: { code: "continue-prepare-failed", message: String(error?.message ?? error) } };
  }
}

/**
 * 判定「这条会话能不能续」：存在性、运行中、中断类型、live 会话的 agent 状态。
 * @param {{ctx: object, sessionId: string}} deps
 * @returns {Promise<object>} 见 prepareContinue 的返回说明
 */
async function resolveContinueTarget({ ctx, sessionId }) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");

  const found = await sessionEventsOf(ctx, sessionId);
  if (!found) return { error: { code: "not-found", message: "会话不存在或不可读" } };

  // live 且末尾未闭合 → 正在运行，不能续
  if (found.live && hasOpenTurn(found.events)) {
    return { error: { code: "running", message: "会话正在运行中，无法续跑" } };
  }

  const info = interruptionInfo(found.events);
  if (!info) {
    return { error: { code: "not-interrupted", message: "会话最后一次回合已正常结束，无需续跑" } };
  }

  // live 会话必须有 agent 才能 followup
  const liveAgent = found.live ? agents?.get(sessionId) : void 0;
  if (found.live && !liveAgent) {
    return { error: { code: "no-agent", message: "会话已挂载但没有可用 agent，无法续跑" } };
  }
  if (liveAgent?.status === "running") {
    return { error: { code: "busy", message: "agent 正在运行中，无法续跑" } };
  }

  return { agents, sessions, found, info, liveAgent };
}

/**
 * 自动续跑的门槛与活跃上限（手动续跑不受限，由用户自己决定）。
 * @param {{ctx: object, sessionId: string, info: object, found: object, agents: object}} deps
 * @returns {Promise<{error?: {code: string, message: string}}>}
 */
async function autoContinueGate({ ctx, sessionId, info, found, agents }) {
  if (!isAutoEligible(info, { live: !!found.live })) {
    return { error: { code: "not-auto-eligible", message: "该中断类型不自动续跑（用户取消/目标暂停/生命周期拆除等），请手动续跑" } };
  }
  const state = await pluginState(ctx);
  if (!autoContinueEffectiveForRun(cfg, state, sessionId)) {
    return { error: { code: "disabled", message: "该会话未开启自动续跑" } };
  }
  const gate = continueAllowed(cfg, state, sessionId, info);
  if (!gate.ok) {
    return { error: { code: `continue-${gate.reason}`, message: `自动续跑被门槛拦下（${gate.reason}）` } };
  }
  const attached = agents?.list?.().length ?? 0;
  if (attached >= cfg.maxAttached) {
    return { error: { code: "attached-cap", message: `活跃会话已达上限 ${cfg.maxAttached}，暂停自动续跑（可手动续跑）` } };
  }
  return {};
}

/**
 * 执行续跑：live 会话直接 followup；cold 会话 resume → followup → flush → dispose。
 * 并发由 withConcurrencyGate 限制，避免自动续跑把活跃数堆爆。
 *
 * @param {{ctx: object, agents: object, sessions: object, found: object, info: object,
 *   liveAgent: object|undefined, prompt: string, sessionId: string}} deps
 * @returns {Promise<void>} 失败时 throw（由 continueSession 归入 continue-failed）
 */
async function runContinueTurn({ ctx, agents, sessions, found, info, liveAgent, prompt, sessionId }) {
  await withConcurrencyGate(async () => {
    if (liveAgent) {
      liveAgent.followup(createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: PLUGIN_SOURCE_KIND, plugin: "dsh-session-conductor" }
      }));
      await waitTurn(ctx, liveAgent);
      return;
    }

    // cold 会话 → resume + followup + flush + dispose
    const route = foldLastRoute(found.events) ?? defaultModelSelection(ctx);
    if (!route?.provider || !route.model) {
      throw new Error("无法确定模型路由（会话无 request/header 且无默认模型）");
    }
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: route.provider, model: route.model },
      setup: await resumeSetupFor(ctx, found.meta, found.events, route),
    });
    const agent = handle?.agent;
    if (!agent) throw new Error("agents.resume 未返回 agent 句柄");
    try {
      await agent.whenIdle();
      agent.followup(createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: PLUGIN_SOURCE_KIND, plugin: "dsh-session-conductor" }
      }));
      await waitTurn(ctx, agent);
      await sessions.flush?.(agent.session);
    } finally {
      // 释放 agent，活跃会话数回到基线（避免自动续跑堆积）
      await handle.dispose();
    }
  });
}

/**
 * 续跑记账：推进 lastContinuedSeq / 计数，防止同一中断被反复续跑（落盘 config.json）。
 * @param {{ctx: object, sessionId: string, info: object}} deps
 */
async function markContinued({ ctx, sessionId, info }) {
  const entry = readSwitch("autoContinue", sessionId) ?? {};
  await patchSwitch(ctx, "autoContinue", sessionId, {
    lastContinuedSeq: info.seq,
    lastContinuedAt: Date.now(),
    continueCount: (entry.continueCount ?? 0) + 1,
  });
}

/**
 * 跨会话消息投递（权威实现）。
 * 向目标会话投递一条用户消息并唤起它——与 continue 同机制但**不受"中断"限制**：
 *   - live 会话：agent.followup(createUserMessage) 直接投递
 *   - cold 会话：agents.resume() → followup → 等回合 → flush → dispose
 * 适用于「会话A → 会话B 直接沟通」（协作/交接/评审），不依赖用户转发文件。
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 目标会话
 * @param {string} text 消息文本
 * @param {object} [opts] { fromSessionId? }
 * @returns {Promise<{ok:boolean, mode:'live'|'cold'|null, accepted?:boolean, error?:{code:string,message:string}}>}
 */
export async function sendMessageToSession(ctx, sessionId, text, { fromSessionId = "" } = {}) {
  if (!sessionId || !text) return { ok: false, error: { code: "bad-request", message: "缺少 sessionId 或 message" } };
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const found = await sessionEventsOf(ctx, sessionId);
  if (!found) return { ok: false, error: { code: "not-found", message: "会话不存在或不可读" } };

  const content = [{ type: "text", text: String(text) }];
  const source = {
    kind: PLUGIN_SOURCE_KIND,
    plugin: "dsh-session-conductor",
    ...(fromSessionId ? { fromSessionId } : {}),
  };
  const message = createUserMessage({ content, source });

  // live 会话：直接 followup（不接管生命周期）
  const liveAgent = found.live ? agents?.get(sessionId) : void 0;
  if (liveAgent) {
    if (liveAgent.status === "running") {
      return { ok: false, error: { code: "busy", message: "目标会话正在运行中，消息已排队，回合结束后送达" } };
    }
    liveAgent.followup(message);
    return { ok: true, mode: "live", accepted: true };
  }

  // cold 会话：resume → followup → 等回合 → flush → dispose
  const route = foldLastRoute(found.events) ?? defaultModelSelection(ctx);
  if (!route?.provider || !route.model) {
    return { ok: false, error: { code: "no-route", message: "无法确定目标会话模型路由" } };
  }
  try {
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: route.provider, model: route.model },
      setup: await resumeSetupFor(ctx, found.meta, found.events, route),
    });
    const agent = handle?.agent;
    if (!agent) throw new Error("agents.resume 未返回 agent 句柄");
    try {
      await agent.whenIdle();
      agent.followup(message);
      await waitTurn(ctx, agent);
      await sessions.flush?.(agent.session);
    } finally {
      await handle.dispose();
    }
    return { ok: true, mode: "cold", accepted: true };
  } catch (error) {
    const msg = String(error?.message ?? error);
    log(ctx, `跨会话消息投递失败 ${sessionId}: ${msg}`);
    return { ok: false, error: { code: "message-failed", message: msg } };
  }
}
