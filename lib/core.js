// dsh-task-completion 核心纯函数：渲染收尾块 + 校验收尾格式。
// 不依赖 ctx / DSH 服务，可独立单测（test-core.mjs）。
// 与 skill `task-completion-report` 的格式约定保持一致。

export const DIVIDER = "══════════════════════════";

const STATUS_MARKERS = {
  done: "✅ 任务完成",
  partial: "⚠️ 未完成",
  failed: "❌ 失败"
};

/** 合法状态集合（供 API/工具入参校验）。 */
export const VALID_STATUSES = Object.keys(STATUS_MARKERS);

/**
 * 渲染标准收尾块。
 * @param options.delivered - 交付了什么（可多行）
 * @param options.verified  - 验证状态（可多行）
 * @param options.remaining - 遗留事项（可多行）
 * @param options.status    - done | partial | failed
 * @returns 带分隔线与状态标记的完整收尾块文本。
 */
export function renderCompletionBlock(options = {}) {
  const status = VALID_STATUSES.includes(options.status) ? options.status : "done";
  const lines = [];
  lines.push(DIVIDER);
  lines.push(STATUS_MARKERS[status]);
  lines.push("");
  if (hasText(options.delivered)) {
    lines.push("交付：");
    lines.push(String(options.delivered));
    lines.push("");
  }
  if (hasText(options.verified)) {
    lines.push("验证：");
    lines.push(String(options.verified));
    lines.push("");
  }
  if (hasText(options.remaining)) {
    lines.push("遗留：");
    lines.push(String(options.remaining));
  }
  lines.push(DIVIDER);
  // 去掉结尾多余空行，保持结构紧凑
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/**
 * 校验一段文本是否符合任务完成收尾格式（启发式）。
 * @param text - 待校验文本
 * @returns {ok, hasDivider, hasMarker, hasDelivered, hasVerified, hasRemaining, missing}
 *   missing 为缺失项数组（divider / marker / delivered / verified / remaining）。
 */
export function checkCompletionText(text) {
  const t = typeof text === "string" ? text : "";
  const hasDivider = /^═{4,}$/m.test(t);
  const hasMarker = /(✅\s*任务完成|❌\s*失败|⚠️\s*未完成|✅\s*任务失败|✅\s*Done|✅\s*Task completed)/.test(t);
  const hasDelivered = /交付|delivered|deliver/i.test(t) && /[:：]/.test(t);
  const hasVerified = /验证|verified|verify/i.test(t);
  const hasRemaining = /遗留|remaining|left|todo|边界/i.test(t);
  const missing = [];
  if (!hasDivider) missing.push("divider");
  if (!hasMarker) missing.push("marker");
  if (!hasDelivered) missing.push("delivered");
  if (!hasVerified) missing.push("verified");
  if (!hasRemaining) missing.push("remaining");
  return {
    ok: missing.length === 0,
    hasDivider,
    hasMarker,
    hasDelivered,
    hasVerified,
    hasRemaining,
    missing
  };
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}
