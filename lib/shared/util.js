// dsh-session-conductor — 通用小工具（无状态、零依赖）

/** 数值钳制：非有限数用默认值，否则夹在 [min, max] 内取整。 */
export function num(v, min, max, dflt) {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt;
}
