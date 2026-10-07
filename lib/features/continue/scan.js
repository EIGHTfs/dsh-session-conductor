// dsh-session-conductor — 自动续跑：调度与周期扫描
//
// 【职责】「什么时候续」：
//   maybeScheduleContinue —— turn/end 事件后的防抖调度
//   runAutoContinueSession —— 单个会话的自动续跑（含失败重试延迟）
//   runAutoScan —— 周期扫描全部冷会话，按活跃上限预算排队
//   scheduleScan —— 常驻周期扫描定时器
// 实际执行在 session.js 的 continueSession。

import { log } from "../../shared/log.js";
import { hasOpenTurn } from "../../sessions/turn.js";
import { sessionEventsOf, readColdSessionEvents } from "../../sessions/events.js";
import { interruptionInfo, isAutoEligible } from "../../sessions/interruption.js";
import { pluginState } from "../../core/domain.js";
import { cfg } from "../../core/config.js";
import { continueTimers, getScanTimer, setScanTimer } from "../../core/state.js";
import { autoContinueEffectiveForRun, continueAllowed } from "./eligibility.js";
import { continueSession } from "./session.js";

/** turn/end 事件后的防抖（等日志落定再判定）。 */
const AUTO_CONTINUE_DEBOUNCE_MS = 5000;
/** 插件启动后首扫延迟（等持久化就绪）。 */
export const AUTO_CONTINUE_SCAN_DELAY_MS = 15000;

/** 回合结束事件 → 若符合自动续跑条件则延迟触发（与自动重命名共用监听入口）。 */
export function maybeScheduleContinue(ctx, sessionId) {
  if (!cfg.enabled) return;
  const existing = continueTimers.get(sessionId);
  if (existing !== void 0) clearTimeout(existing);
  const timer = setTimeout(() => {
    continueTimers.delete(sessionId);
    runAutoContinueSession(ctx, sessionId).catch((error) => {
      log(ctx, `自动续跑调度失败 ${sessionId}: ${String(error?.message ?? error)}`);
    });
  }, AUTO_CONTINUE_DEBOUNCE_MS);
  timer.unref?.();
  continueTimers.set(sessionId, timer);
}

/**
 * 自动续跑一个会话（内部：读事件 → 判定 → 门槛 → 执行）。
 * 整体包 try/catch——判定段任一 throw 不再向调用方逃逸（防 unhandledRejection 杀进程）。
 * force：面板刚打开自动续跑开关时立即续跑，跳过失败重试延迟（开开关即触发，
 * 不用等到下一个扫描周期）。
 */
export async function runAutoContinueSession(ctx, sessionId, { force = false } = {}) {
  try {
    if (!cfg.enabled) return;
    const state = await pluginState(ctx);
    if (!autoContinueEffectiveForRun(cfg, state, sessionId)) return;
    const found = await sessionEventsOf(ctx, sessionId);
    if (!found) return;
    if (found.live && hasOpenTurn(found.events)) return; // 正在运行
    const info = interruptionInfo(found.events);
    if (!info || !isAutoEligible(info, { live: !!found.live })) return;
    if (!continueAllowed(cfg, state, sessionId, info).ok) return;
    // 本轮运行失败（error）识别后延迟 failRetryDelayMs 再续跑（默认 30s），
    // 避免失败后立即重试；interrupted/open-turn（崩溃残留）不延迟。手动续跑不受影响。
    // force（用户刚打开开关触发的首次续跑）跳过延迟——用户主动开启不该再等 30s。
    if (!force && info.kind === "error" && cfg.failRetryDelayMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, cfg.failRetryDelayMs);
        timer.unref?.();
      });
    }
    await continueSession(ctx, sessionId, { auto: true });
  } catch (error) {
    log(ctx, `自动续跑 ${sessionId} 异常: ${String(error?.message ?? error)}`);
  }
}

/** 周期扫描：对所有开启自动续跑的会话检查中断并续跑（受活跃上限预算约束）。 */
export async function runAutoScan(ctx) {
  if (!cfg.enabled) return;
  const persistence = ctx.get("sessionPersistence");
  const sessionsSvc = ctx.get("sessions");
  if (!persistence?.list || !persistence?.open) return;

  const state = await pluginState(ctx);
  const archived = new Set(ctx.get("workspaceRegistry")?.archivedSessionIds ?? []);
  const liveIds = new Set((sessionsSvc?.list() ?? []).map((s) => s.id));
  const attached = ctx.get("agents")?.list?.().length ?? 0;
  let budget = Math.max(0, cfg.maxAttached - attached);
  if (budget <= 0) {
    log(ctx, `自动续跑扫描暂停：活跃会话已达 ${attached}/${cfg.maxAttached}`);
    return;
  }

  let metas = [];
  try {
    metas = await persistence.list();
  } catch (error) {
    log(ctx, `自动续跑扫描读会话列表失败: ${String(error?.message ?? error)}`);
    return;
  }

  let queued = 0;
  for (const meta of metas) {
    if (budget <= 0) break;
    if (liveIds.has(meta.id)) continue; // live 会话由 turn/end 事件触发
    if (archived.has(meta.id)) continue; // 归档会话不自动续跑
    if (!autoContinueEffectiveForRun(cfg, state, meta.id)) continue;
    let events = null;
    try {
      events = (await readColdSessionEvents(ctx, meta.id))?.events ?? null;
    } catch {
      continue; // 损坏/不可读，跳过
    }
    const info = interruptionInfo(events);
    if (!info || !isAutoEligible(info, { live: false })) continue; // 扫描只处理冷会话
    if (!continueAllowed(cfg, state, meta.id, info).ok) continue;
    budget -= 1;
    queued += 1;
    runAutoContinueSession(ctx, meta.id).catch((error) => {
      log(ctx, `自动续跑 ${meta.id} 失败: ${String(error?.message ?? error)}`);
    });
  }
  if (queued > 0) log(ctx, `自动续跑扫描：本轮排队 ${queued} 个会话`);
}

/** 常驻周期扫描（每次扫描结束后再次排期）。 */
export function scheduleScan(ctx) {
  const previous = getScanTimer();
  if (previous !== null) clearTimeout(previous);
  const timer = setTimeout(() => {
    setScanTimer(null);
    runAutoScan(ctx).catch((error) => {
      log(ctx, `自动续跑扫描失败: ${String(error?.message ?? error)}`);
    });
    scheduleScan(ctx); // 常驻周期扫描
  }, cfg.scanIntervalMs);
  timer.unref?.();
  setScanTimer(timer);
}
