// dsh-session-conductor — 会话中断判定（自动续跑资格 + 标题状态后缀共用）
//
// 【为什么放在 sessions 域】「这个会话是不是中断了、能不能自动续」是会话自身的属性判定，
// 既被续跑域用（是否触发续跑），也被标题域用（是否加「已中断」后缀）——放在中立位置避免相互依赖。

/** 人工/系统主动取消的 abort 类型：这些不算「可续的中断」。 */
const AUTO_CONTINUE_HUMAN_ABORT_KINDS = new Set(["user", "goal", "parent", "disposed"]);

/**
 * 从事件流末尾判定会话的中断状态：
 *   interrupted（崩溃修复合成闭合）/ error（本轮运行失败）/ aborted（被取消）/ open-turn（未闭合回合）。
 * @param {Array} events 会话事件流
 * @returns {{kind: string, code?: string, seq: number, message: string} | null} 无需续跑/正常结束返回 null
 */
export function interruptionInfo(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "turn/end") {
      const reason = event.data?.reason;
      if (reason === null || typeof reason !== "object") return null;
      if (reason.kind === "interrupted") {
        return { kind: "interrupted", seq: event.seq, message: "回合因进程/会话中断而未完成（崩溃修复）" };
      }
      if (reason.kind === "error") {
        const code = typeof reason.error?.code === "string" ? reason.error.code : "UNKNOWN";
        // 识别「本轮运行失败」——任意 error 都视为可续跑的中断（不再限 4 个可重试码）。
        // 防死循环由 continueAllowed（冷却/次数/并发上限）兜底；不可重试错误仍可被识别，留给续跑尝试。
        return {
          kind: "error",
          code,
          seq: event.seq,
          message: `请求错误 ${code}${typeof reason.error?.message === "string" ? `：${reason.error.message}` : ""}`
        };
      }
      if (reason.kind === "aborted") {
        const abortKind = reason.reason?.kind;
        if (typeof abortKind === "string" && AUTO_CONTINUE_HUMAN_ABORT_KINDS.has(abortKind)) return null; // 用户/目标主动取消
        return {
          kind: "aborted",
          code: typeof abortKind === "string" ? abortKind : String(reason.reason),
          seq: event.seq,
          message: "回合被系统原因中断"
        };
      }
      return null; // completed / blocked / max-tokens / 其他
    }
    if (event?.type === "turn/start") {
      // 末尾是未闭合回合：live 会话 = 正在运行；cold 会话通常已被 DSH 修复成 interrupted
      return { kind: "open-turn", seq: event.seq, message: "回合未正常结束（open turn）" };
    }
  }
  return null;
}

/**
 * 自动续跑资格判定。
 * @param info - interruptionInfo 的结果。
 * @param options.live - 会话是否 live（内存中、可能正在运行）。
 *   只有冷会话的 open-turn 才视为崩溃残留可续跑；live 会话的 open-turn 是运行中，绝不续。
 * 规则：
 *   · interrupted（崩溃修复合成闭合）→ 可续
 *   · error（本轮运行失败，任意 code）→ 可续
 *   · open-turn：冷会话 → 可续（崩溃残留）；live → 不可续（运行中）
 *   · aborted → 一律不可续（主动取消/未知 kind 保守处理，留给手动）
 */
export function isAutoEligible(info, { live = false } = {}) {
  if (!info) return false;
  if (info.kind === "interrupted") return true;
  if (info.kind === "error") return true; // 本轮运行失败：任意 error 都可续（上限/冷却兜底）
  if (info.kind === "open-turn") return !live; // 冷会话 = 崩溃残留；live = 运行中
  return false; // aborted 及其他：不自动续（主动取消/未知），可手动续
}
