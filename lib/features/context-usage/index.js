/**
 * 上下文用量自查工具（context_usage）
 *
 * 让 AI 能主动查自己这次会话的上下文占用，而不是靠系统每轮把数值注入系统提示词。
 *
 * ── 为什么做成「自查工具」而不是「每轮注入数值」──────────────────────────
 * 1. **每轮注入会破坏 prompt caching**：占用数值每轮都在变 ⇒ 系统提示词前缀变化
 *    ⇒ KV 缓存命中率下降 ⇒ 成本上升。而且注入文本本身占 token
 *    —— 为了知道「用了多少」，反而多花 token，占用越高负担越大。
 * 2. **纯自查的短板用「工具定义常驻」补**：AI 可能想不起来查，
 *    但工具定义本身就在系统提示词里（无参数工具的 schema 极小，几十 token），
 *    且**内容固定不变**，不会破坏缓存。
 * 3. **DSH 官方先例**：官方 compaction 是**自动**触发的（`agent/pre-step` + thresholdRatio），
 *    AI 不参与决策 —— 官方哲学是「上下文治理由系统负责」。
 *    所以本工具面向的是「AI 需要主动决策」的场景：要不要先总结再继续、要不要把任务分片、
 *    要不要把大结果落盘而不是留在上下文里。
 *
 * ── 数据来源（只读，不新算）────────────────────────────────────────────
 * - `contextPressure` 投影：`contextWindow` / `pressureTokens` / `projectedTokens`
 * - `contextBreakdown` 投影：`systemTokens` / `toolsTokens` / `messageTokens`
 * 两者都由 `@deepseek-ai/dsh-token-meter` 注册，**回放持久会话日志**算出（确定性、不做模型调用），
 * 与界面上的「上下文已用」圆环共用同一份结果。
 *
 * ⚠️ 这两个投影是**启发式估算**，不是 provider 计费值：容量按「1 token ≈ 4 字节」折算，
 *    分项（尤其是对话消息）为估算。适合做压缩/分片决策，不适合当计费依据。
 */

/** 占用达到该百分比时，输出里附一条提醒（仅提示，不阻断任何操作）。 */
export const HIGH_USAGE_PERCENT = 85;

/** 上下文分项：投影字段 → 中文标签（顺序即输出顺序）。 */
const BREAKDOWN_LABELS = [
  ["systemTokens", "系统提示词"],
  ["toolsTokens", "工具定义"],
  ["messageTokens", "对话消息"],
];

/**
 * 紧凑数字格式化（与前端 `ContextMeter.formatTokens` 同口径）。
 * < 1000 直出；≥ 1000 用 K；≥ 1,000,000 用 M；≥ 100 取整，否则保留 1 位小数。
 * @param {number} value 原始数值
 * @returns {string} 形如 `82K` / `1M` / `3.6K`
 */
export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const scaled = (candidate) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (n < 1000) return String(n);
  if (n < 1000000) return `${scaled(n / 1000)}K`;
  return `${scaled(n / 1000000)}M`;
}

/**
 * 由 `contextPressure` 投影换算占用。
 *
 * 口径与前端 `context-occupancy.ts` 完全一致：
 * 已用优先取 `projectedTokens`（下一个请求的提示词将花多少），退回 `pressureTokens`（provider 最新报告值）。
 * 用「下一个请求」而非「上一个请求」，是为了回答「我还能不能再来一轮」。
 *
 * @param {{contextWindow?:number, pressureTokens?:number, projectedTokens?:number}|undefined} pressure 投影值
 * @returns {{percent:number, usedTokens:number, contextWindow:number, source:"projected"|"reported"}|null}
 *          数值不全时返回 null（与 UI 一样：拿不到容量就不显示）
 */
export function resolveOccupancy(pressure) {
  const projected = pressure?.projectedTokens;
  const reported = pressure?.pressureTokens;
  const usedTokens = projected ?? reported;
  const contextWindow = pressure?.contextWindow;
  if (usedTokens === undefined || contextWindow === undefined || !contextWindow) return null;
  return {
    // 上限 100：投影值可能略微超过容量（估算叠加），显示上不出现 >100%
    percent: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
    usedTokens,
    contextWindow,
    source: projected !== undefined ? "projected" : "reported",
  };
}

/**
 * 读取当前会话的上下文用量快照。全程只读，不产生副作用、不触发模型调用。
 *
 * @param {object} ctx 插件 context（用于 `get('sessionProjections')`）
 * @param {object|undefined} agent 当前执行所属 agent（工具 execute 的 `exec.agent`，由 agent loop 注入）
 * @returns {{ok:true, occupancy:object|null, breakdown:object|null, missing:string[]}
 *          |{ok:false, reason:string}}
 */
export function readContextUsage(ctx, agent) {
  const session = agent?.session;
  if (!session) {
    // 极少数情况 exec.agent 缺失（例如非 agent loop 来源的直接调用）
    return { ok: false, reason: "拿不到当前会话（exec.agent 缺失），无法读上下文用量" };
  }
  let projections = null;
  try {
    projections = ctx?.get?.("sessionProjections");
  } catch {
    projections = null;
  }
  if (!projections?.snapshot) {
    // token-meter 未挂载时该服务不存在（它是可选插件），此时如实说明而不是报错
    return { ok: false, reason: "sessionProjections 服务不可用（token-meter 未挂载？）" };
  }

  let values = null;
  try {
    values = projections.snapshot(session)?.values ?? null;
  } catch (error) {
    return { ok: false, reason: `读会话投影失败：${String(error?.message ?? error)}` };
  }

  const occupancy = resolveOccupancy(values?.contextPressure);
  const rawBreakdown = values?.contextBreakdown ?? null;

  // 记录缺了哪些键，方便区分「服务在但还没数据」与「服务不在」
  const missing = [];
  if (!occupancy) missing.push("contextPressure（该路由还没上报过 contextWindow 或用量）");
  if (!rawBreakdown) missing.push("contextBreakdown");

  return { ok: true, occupancy, breakdown: rawBreakdown, missing };
}

/**
 * 把快照格式化为模型可读的多行文本（工具输出）。
 *
 * 输出设计原则：
 * - 数字带 `~` 前缀，与界面一致，提示这是估算；
 * - 缺数据时说明**为什么**缺（未上报 / 未挂载），而不是只给一个空；
 * - 高占用时附一条行动建议（但明确不阻断）。
 *
 * @param {object} snapshot `readContextUsage` 的返回
 * @returns {string} 多行文本
 */
export function formatContextUsage(snapshot) {
  if (!snapshot?.ok) return `无法读取上下文用量：${snapshot?.reason ?? "未知原因"}`;

  const lines = [];
  const occ = snapshot.occupancy;
  if (occ) {
    lines.push(`上下文已用 ${occ.percent}%`);
    lines.push(`~${formatTokens(occ.usedTokens)} / ${formatTokens(occ.contextWindow)} tokens`);
    // 口径说明：projected 才是「下一个请求要花多少」，是 AI 真正该参考的数
    lines.push(
      occ.source === "projected"
        ? "（已用 = 下一个请求的预计提示词规模，含尚未发出的表面增量）"
        : "（已用 = provider 最新报告值；尚无表面增量可投影）",
    );
  }

  if (snapshot.breakdown) {
    lines.push("");
    lines.push("上下文构成（启发式估算，非计费值）：");
    for (const [key, label] of BREAKDOWN_LABELS) {
      const value = snapshot.breakdown[key];
      lines.push(`  ${label}  ~${formatTokens(value ?? 0)}`);
    }
  }

  if (snapshot.missing?.length) {
    lines.push("");
    lines.push(`缺：${snapshot.missing.join("；")}`);
  }

  if (occ && occ.percent >= HIGH_USAGE_PERCENT) {
    lines.push("");
    lines.push(
      `⚠️ 占用已达 ${occ.percent}%：建议在继续前收敛上下文`
      + "（把大结果落盘而非留在对话里、先小结已完成部分，或把剩余任务拆到新会话）。",
    );
  }

  lines.push("");
  lines.push("注：以上为启发式估算（容量按约 4 字节/token 折算），适合做压缩与分片决策，不等同于计费口径。");
  if (occ && snapshot.breakdown) {
    // 口径差异必须说清，否则容易误以为「分项加错了」：
    //   已用量取自 provider 报告的真实 prompt 规模（再叠加表面增量），
    //   而三个分项是逐条启发式累加 —— provider 计入但启发式未覆盖的部分
    //   （reasoning tokens、附件、注入的长文本等）就体现为两者的差额。
    lines.push("三项之和通常小于上面的已用量：已用量是 provider 报告的真实提示词规模，三分项是逐条估算，"
      + "不含 reasoning tokens、附件与部分注入内容。");
  }
  return lines.join("\n");
}

/**
 * 注册 `context_usage` AI 工具。
 *
 * 无参数，纯只读。工具描述里写明了「什么时候该用」，因为 AI 是否调用取决于描述。
 *
 * @param {object} ctx 插件 context
 * @param {Function|null} defineTool `@deepseek-ai/dsh-tools` 的 defineTool（缺失时不注册）
 * @param {object} tools `tools` 服务（`tools.register`）
 * @returns {boolean} 是否成功注册
 */
export function registerContextUsageTool(ctx, defineTool, tools) {
  if (typeof defineTool !== "function" || typeof tools?.register !== "function") return false;
  tools.register(defineTool({
    name: "context_usage",
    description:
      "查看当前会话的上下文占用（百分比、已用/容量 tokens）与构成（系统提示词/工具定义/对话消息）。"
      + "只读、无参数。适合在这些时机调用：感觉对话变长、准备开始一个会产生大量输出的大任务前、"
      + `怀疑快满、或想判断要不要先把中间结果落盘/分片。占用达到 ${HIGH_USAGE_PERCENT}% 时输出会附收敛建议。`,
    parameters: {},
    output: {
      schema: { type: "string" },
      render(args, value) {
        return [{ type: "text", text: String(value) }];
      },
    },
    async execute(_args, exec) {
      try {
        return formatContextUsage(readContextUsage(ctx, exec?.agent));
      } catch (error) {
        return `读取上下文用量失败：${String(error?.message ?? error)}`;
      }
    },
  }));
  return true;
}
