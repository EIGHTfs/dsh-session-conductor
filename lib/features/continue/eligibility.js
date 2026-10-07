// dsh-session-conductor — 自动续跑：资格与门槛判定、续跑提示词
//
// 【职责】决定「这个会话该不该续、能不能续」，以及续跑时发给模型的提示词。
// 不含任何执行动作（resume/followup/记账在 run.js）。

import { effectiveAutoContinue, readSwitch } from "../../core/config.js";

/**
 * 运行期自动续跑判定：跟随会话开关（与面板开关展示一致），仅用于「运行路径」（续跑/扫描）。
 * 全局闸门 autoContinueGate === "closed" 时**一切自动续跑跳过**
 * ——与 guardian 联动，防崩溃恢复后自动续跑批量建空壳。
 */
export function autoContinueEffectiveForRun(cfg, state, sessionId) {
  if (state?.autoContinueGate === "closed") return false;
  return effectiveAutoContinue(cfg, state, sessionId);
}

/** 自动续跑门槛：已续过 / 冷却中 / 总次数超限 → 拒绝。 */
export function continueAllowed(cfg, state, sessionId, info) {
  const entry = readSwitch("autoContinue", sessionId) ?? {};
  if (entry.lastContinuedSeq !== void 0 && entry.lastContinuedSeq >= info.seq) {
    return { ok: false, reason: "already-continued" };
  }
  const now = Date.now();
  if (entry.lastContinuedAt !== void 0 && now - entry.lastContinuedAt < cfg.cooldownMs) {
    return { ok: false, reason: "cooldown" };
  }
  if ((entry.continueCount ?? 0) >= cfg.maxContinuesPerSession) {
    return { ok: false, reason: "max-total" };
  }
  return { ok: true };
}

/** 续跑提示（不同中断原因给不同上下文提示）。 */
export function buildContinuePrompt(info) {
  const base = "这是一条由插件自动发出的「续跑」指令，不是用户的新问题。";
  switch (info?.kind) {
    case "interrupted":
      return `${base}\n检测到此会话此前的回合因进程/会话中断而未完成。请回顾你当时正在进行的任务，检查已完成与未完成的部分，然后继续完成它。若任务实际上已经完成，请直接说明完成情况，不要重复执行。`;
    case "error":
      return `${base}\n检测到此会话此前的回合因可重试的请求错误中断（${info.code ?? "未知"}）。请回顾你当时正在进行的任务，继续完成它。若任务实际上已经完成，请直接说明完成情况，不要重复执行。`;
    case "aborted":
      return `${base}\n检测到此会话此前的回合被系统原因中断（${info.code ?? "未知"}）。请回顾你当时正在进行的任务，继续完成它。若任务实际上已经完成，请直接说明完成情况，不要重复执行。`;
    case "open-turn":
      return `${base}\n检测到此会话此前的回合未正常结束。请回顾你当时正在进行的任务，继续完成它。若任务实际上已经完成，请直接说明完成情况，不要重复执行。`;
    default:
      return `${base}\n请回顾你正在进行的任务并继续完成它；若已全部完成，请直接说明完成情况。`;
  }
}
