// 【职责】把自动重命名注册成官方 `sessionTitle` 的 provider（provider 模式）。
//
// 为什么不自己做调度：官方把「消息收集 / revision 取代 / 过期结果校验 / 写 session/title
// 事件 / 手动改过标题后不再覆盖」全部做在 sessionTitle 服务里，注册一个 provider 就免费
// 得到这些语义；自建调度则每样都得自己实现（本插件的 consumer 模式就是那种做法）。
//
// 两模式互斥：provider 模式不启动 consumer 的自建 turn/end 调度，否则两边都写同一份
// sessionTitle，标题会互相覆盖。切换见 core/config.js 的 renameMode。

import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { driftAnalysisLlm, resolveRoute } from "./analysis.js";
import { log } from "../../shared/log.js";

/** provider 注册 id：会落进 session/title 事件的 source.provider，便于区分标题由谁生成。 */
export const RENAME_PROVIDER_ID = "session-conductor-rename";

// 与 consumer 模式同口径的节流参数。
// 为什么必须在 generate 内部拨住：`automatic: "all-prompts"` 意味着**每条真人消息**都会
// 调一次 generate；不拦就会每条消息烧一次 LLM（官方原版没有节流，这正是它的成本短板）。
const PROVIDER_MIN_TOTAL_MESSAGES = 3; // 会话攒够 3 条用户消息才开始分析
const PROVIDER_MIN_NEW_MESSAGES = 3; // 距上次分析至少新增 3 条才再分析
const PROVIDER_MIN_INTERVAL_MS = 5 * 60 * 1000; // 同会话最小间隔 5 分钟
const PROVIDER_RECENT_MESSAGES = 12; // 参与判断的最近用户消息数（滑窗，避免超长请求）
const PROVIDER_TITLE_MAX_BYTES = 80; // 标题字节上限，与 consumer 模式一致

/**
 * 造一个官方要求的 provider 对象。
 *
 * 契约（官方 validateProvider 实测）：只需 `id`（非空串）、`automatic`
 * （`first-prompt` 或 `all-prompts`）、`generate()` 三个字段。
 * `generate()` 必须返回 `{ title: string }` 且 title 非空 —— 所以「判断为不需要改」
 * 只能原样返回 currentTitle（官方随后会 append 一条同值事件，属可接受的日志噪音）。
 *
 * @param {object} ctx 插件上下文
 * @returns {{id: string, automatic: string, generate: Function}}
 */
export function createRenameProvider(ctx) {
  // 每会话的上次分析轨迹。provider 生命周期由官方服务持有，这里只需守住节流状态。
  const lastRunBySession = new Map();

  return {
    id: RENAME_PROVIDER_ID,
    automatic: "all-prompts",
    async generate({ session, messages, currentTitle, signal }) {
      // 官方在 abort 时不会等我们收尾，先看一眼信号，省掉无谓的 LLM 调用
      if (signal?.aborted) return { title: currentTitle };

      const eligible = Array.isArray(messages) ? messages : [];
      const totalMessages = eligible.length;

      const previous = lastRunBySession.get(session.id);
      const now = Date.now();
      if (totalMessages < PROVIDER_MIN_TOTAL_MESSAGES) return { title: currentTitle };
      if (previous !== undefined && now - previous.runAt < PROVIDER_MIN_INTERVAL_MS) {
        return { title: currentTitle };
      }
      if (previous !== undefined && totalMessages - previous.messageCount < PROVIDER_MIN_NEW_MESSAGES) {
        return { title: currentTitle };
      }

      // 记账先行：即便下面失败，也要推进游标，否则下次仍会立刻重试同一批消息
      lastRunBySession.set(session.id, { runAt: now, messageCount: totalMessages });

      const llm = ctx.get("llm");
      if (!llm) return { title: currentTitle };
      const route = resolveRoute(session, llm, {});
      if (!route) return { title: currentTitle };

      // 官方只给「真人用户消息」（{seq, text}），不含 AI 回复；转成分析器要的形状。
      // 少了 AI 首反应会略微降低「主题是否真的偏了」的判断力，换来的是不重复读会话日志。
      const recentTurns = eligible
        .slice(-PROVIDER_RECENT_MESSAGES)
        .map((one) => ({ userText: String(one?.text ?? ""), agentText: "" }));

      // 分析失败必须自己咽下：这里抛出去的异常会落到官方 sessionTitle 的调度里，
      // 轻则该次标题更新失败，重则影响主请求链路。保留原标题是最安全的降级。
      let decision;
      try {
        decision = await driftAnalysisLlm(
          llm,
          session,
          route,
          currentTitle,
          recentTurns,
          (message) => log(ctx, message),
        );
      } catch (error) {
        log(ctx, `provider 模式标题分析异常（保留原标题）${session.id}: ${String(error?.message ?? error)}`);
        return { title: currentTitle };
      }
      if (!decision || decision.kind === "error" || decision.kind === "unchanged") {
        return { title: currentTitle };
      }

      const nextTitle = normalizeSessionTitle(String(decision.title ?? "").trim(), PROVIDER_TITLE_MAX_BYTES);
      if (nextTitle === "" || nextTitle === currentTitle) return { title: currentTitle };

      log(ctx, `provider 模式自动重命名 ${session.id}: "${currentTitle ?? "（无标题）"}" → "${nextTitle}"`);
      return { title: nextTitle };
    },
  };
}
