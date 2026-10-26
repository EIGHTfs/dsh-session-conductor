// dsh-session-conductor — 批量把模型/权限应用到多个成员
//
// 【为什么单独抽一层】「对全部子代理统一模型/权限」在指令和 AI 工具两边都要用，
// 而且批量写会话日志有几个必须统一的纪律：
//   ① **串行**执行：并发写多个会话日志容易互相干扰（每个都是一次读-改-写），串行最省心；
//   ② **逐个隔离失败**：某个成员失败（日志损坏、名册状态异常）不能中断其余成员；
//   ③ **回执必须带名单**：批量操作最怕「不知道改了谁」，所以结果逐条列出、并统计成功/失败数。
import { log } from "../../shared/log.js";
import { switchAgentModel } from "./switch.js";
import { switchMemberPermission } from "./permission.js";

/** 成员显示名（名字 + 短 id，便于人核对）。 */
export function memberDisplay(member, sessionId) {
  const name = member?.name ?? null;
  const shortId = sessionId ? `${sessionId.slice(0, 8)}…` : "?";
  return name ? `${name}(${shortId})` : String(sessionId ?? "?");
}

/**
 * 批量切换模型。
 *
 * @param {object} ctx 插件 context
 * @param {Array<{sessionId: string, member?: object, agent?: object|null}>} targets 目标列表（已解析）
 * @param {{provider: string, model: string}} route 目标路由
 * @returns {Promise<{rows: Array<{sessionId: string, label: string, ok: boolean, detail: string}>, okCount: number, failCount: number}>}
 */
export async function applyModelToMany(ctx, targets, { provider, model }) {
  const rows = [];
  for (const t of targets) {
    const label = memberDisplay(t.member, t.sessionId);
    try {
      const result = await switchAgentModel(ctx, t.sessionId, provider, model, t.agent ?? null);
      if (result?.error) {
        rows.push({ sessionId: t.sessionId, label, ok: false, detail: String(result.error) });
      } else {
        rows.push({ sessionId: t.sessionId, label, ok: true, detail: String(result.via ?? "") });
      }
    } catch (error) {
      rows.push({ sessionId: t.sessionId, label, ok: false, detail: String(error?.message ?? error) });
    }
  }
  const okCount = rows.filter((r) => r.ok).length;
  log(ctx, `批量切换模型：${okCount}/${rows.length} 成功（${provider}/${model}）`);
  return { rows, okCount, failCount: rows.length - okCount };
}

/**
 * 批量切换权限预设。
 *
 * @param {object} ctx 插件 context
 * @param {Array<{sessionId: string, member?: object}>} targets 目标列表（已解析）
 * @param {string} preset 目标预设名
 * @returns {Promise<{rows: Array<{sessionId: string, label: string, ok: boolean, detail: string}>, okCount: number, failCount: number}>}
 */
export async function applyPermissionToMany(ctx, targets, preset) {
  const rows = [];
  for (const t of targets) {
    const label = memberDisplay(t.member, t.sessionId);
    try {
      const result = await switchMemberPermission(ctx, t.sessionId, preset);
      if (result?.error) {
        rows.push({ sessionId: t.sessionId, label, ok: false, detail: String(result.error) });
      } else {
        const from = result.from ?? "(未记录)";
        const note = result.note ? `；${result.note}` : "";
        rows.push({ sessionId: t.sessionId, label, ok: true, detail: `${from} → ${result.to}${note}` });
      }
    } catch (error) {
      rows.push({ sessionId: t.sessionId, label, ok: false, detail: String(error?.message ?? error) });
    }
  }
  const okCount = rows.filter((r) => r.ok).length;
  log(ctx, `批量切换权限：${okCount}/${rows.length} 成功（${preset}）`);
  return { rows, okCount, failCount: rows.length - okCount };
}

/**
 * 渲染批量结果（先名单、后逐条结果、最后统计）。
 *
 * 批量操作的价值一半在「改了谁」的可核对性上，所以名单一定要完整列出，
 * 不能只给一句「已处理 N 个」。
 *
 * @param {string} title 标题行（如「批量切换模型 → sa6400/deepseek-v4.1-flash」）
 * @param {{rows: Array<{label: string, ok: boolean, detail: string}>, okCount: number, failCount: number}} report
 * @param {string[]} [extra] 额外说明行
 * @returns {string}
 */
export function renderBatchReport(title, report, extra = []) {
  const lines = [title, ""];
  lines.push(`受影响成员（共 ${report.rows.length} 个）：`);
  for (const r of report.rows) lines.push(`  ${r.ok ? "✅" : "❌"} ${r.label}`);
  lines.push("", "逐条结果：");
  for (const r of report.rows) lines.push(`  ${r.ok ? "✅" : "❌"} ${r.label}：${r.detail || (r.ok ? "成功" : "失败")}`);
  lines.push("", `统计：成功 ${report.okCount} 个 ｜ 失败 ${report.failCount} 个`);
  for (const line of extra) if (line) lines.push(line);
  return lines.join("\n");
}
