// dsh-session-conductor — 会话回合状态（只读事件流判定）
//
// 【为什么单独成文件】hasOpenTurn / lastEventTime 是「会话是否运行中」的判定基础，
// 被续跑、撤回、列表、成员模型切换等多个域共用——放在 sessions 域下作为底层能力。

/** 最后一个 turn 边界是 turn/start（未闭合）→ 视为会话运行中。 */
export function hasOpenTurn(events) {
  if (!Array.isArray(events)) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type;
    if (type === "turn/end") return false;
    if (type === "turn/start") return true;
  }
  return false;
}

/** 事件流的最后时间戳（ms），无则 undefined。 */
export function lastEventTime(events) {
  const last = events?.at(-1);
  return typeof last?.time === "number" ? last.time : undefined;
}
