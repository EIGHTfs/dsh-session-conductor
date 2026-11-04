// dsh-session-conductor — AI 工具「rename_session」：给指定会话改名
//
// 【为什么要这个工具】自动重命名依赖「分析调 LLM 判断偏离」，一旦上游截断/限流就整链失效，
// 而 AI（尤其是 lead/成员）本来就最常知道「这段对话现在在干什么」。工具把改名能力直接交给 AI：
// 不经过分析 LLM，不调模型、不看预算，走宿主 sessionTitle 服务一步落定，
// 与自动重命名共用同一套标题规范化与列表缓存作废，界面即时可见。
//
// 【注册约定】与 member-model/tools.js 一致：单独 try/catch 包住 register，
// defineTool/register 抛错只让本工具消失，不炸掉整个 inject 回调。

import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { log } from "../../shared/log.js";
import { canonicalSessionId } from "../../sessions/id.js";

/** 标题字节上限：与自动重命名同值，两条路径产出的标题长度口径一致。 */
const RENAME_TITLE_MAX_BYTES = 64;

/**
 * 执行改名：解析目标会话 → 规范化标题 → 宿主 rename → 作废列表缓存。
 * ctx.get("sessionTitle") 不可用（老宿主）时返回明确错误，不静默。
 *
 * @param {object} ctx 插件 context
 * @param {string} want 目标会话（id / 带或省略 session- 前缀 / id 前缀）
 * @param {string} title 新标题文本
 * @returns {Promise<{ok:boolean, sessionId?:string, before?:string, after?:string, error?:{code:string,message:string}}>}
 */
export async function renameSessionTo(ctx, want, title) {
  const sessionId = await canonicalSessionId(ctx, want);
  const sessions = ctx.get("sessions");
  const session = sessions?.get?.(sessionId) ?? sessions?.get?.(want) ?? null;
  if (!session) {
    return { ok: false, error: { code: "not-live", message: `目标会话不在活跃列表（${sessionId}）；冷会话请先在界面打开一次再改，或用面板改名` } };
  }
  const titleService = ctx.get("sessionTitle");
  if (!titleService?.rename) {
    return { ok: false, error: { code: "no-service", message: "宿主 sessionTitle 服务不可用" } };
  }
  const normalized = normalizeSessionTitle(String(title ?? "").trim(), RENAME_TITLE_MAX_BYTES);
  if (normalized === "") {
    return { ok: false, error: { code: "bad-title", message: "标题规范化后为空（全是空白或不可见字符）" } };
  }
  const snapshot = titleService.get?.(session);
  const before = typeof snapshot === "string" ? snapshot : snapshot?.title ?? null;
  try {
    titleService.rename(session, normalized);
  } catch (error) {
    return { ok: false, error: { code: "rename-failed", message: String(error?.message ?? error) } };
  }
  try {
    const { markSessionListStale } = await import("../../sessions/list-cache.js");
    markSessionListStale(ctx, session.id);
  } catch {
    // 列表缓存作废失败不影响改名本身
  }
  log(ctx, `手动改名（工具）${sessionId}: "${before ?? "（无标题）"}" → "${normalized}"`);
  return { ok: true, sessionId: session.id, before, after: normalized };
}

/**
 * 注册 rename_session 工具。
 * @param {object} deps { ctx, tools, defineTool }
 */
export function registerRenameSessionTool({ ctx, tools, defineTool }) {
  try {
    tools.register(defineTool({
      name: "rename_session",
      description:
        "给指定会话改标题（直接落定，不经过分析模型）。目标支持完整 id、带/省略 session- 前缀、id 前缀。"
        + "用于：自动重命名链路失败（上游截断/限流）时人工纠正，或 AI 明确知道更贴切的标题时直接改。"
        + "标题按宿主规范截断（中文约 10 字），带状态后缀的会话只改主体。",
      parameters: {
        sessionId: { type: "string", required: true, description: "目标会话（id / 前缀 / 省略 session- 前缀均可）" },
        title: { type: "string", required: true, description: "新标题文本" },
        analyze: { type: "boolean", description: "true = 不直接改名，改为跑一次自动重命名分析（诊断链路时用，返回真实失败原因）" },
      },
      async execute(args) {
        const target = String(args?.sessionId ?? "").trim();
        if (!target) return "改名失败：sessionId 必填";
        if (args?.analyze === true) {
          const { runAnalysis } = await import("./analysis.js");
          const analyzed = await runAnalysis(ctx, target, { manual: true });
          return JSON.stringify(analyzed, null, 1);
        }
        const title = String(args?.title ?? "").trim();
        if (!title) return "改名失败：title 必填（或传 analyze:true 走分析）";
        const result = await renameSessionTo(ctx, target, title);
        if (!result.ok) return `改名失败：${result.error.code} — ${result.error.message}`;
        return `已改名 ${result.sessionId}\n  ${result.before ?? "（无标题）"}\n→ ${result.after}`;
      },
    }));
  } catch (error) {
    log(ctx, `rename_session 工具注册失败: ${String(error?.message ?? error)}`);
  }
}
