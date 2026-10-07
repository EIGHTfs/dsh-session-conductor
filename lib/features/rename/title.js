// dsh-session-conductor — 会话标题（折叠 / 工作区前缀 / 状态后缀）
//
// 【职责】与「标题」有关的一切：从事件流折叠持久化标题、sessionTitle 服务快照归一化、
// 归档工作区前缀的加减、标题状态后缀（运行中/已中断）的维护。

import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { log } from "../../shared/log.js";
import { hasOpenTurn } from "../../sessions/turn.js";
import { interruptionInfo } from "../../sessions/interruption.js";
import { pluginState } from "../../core/domain.js";
import { cfg, autoRenameEnabled } from "../../core/config.js";

/** 标题状态后缀常量与匹配式。 */
const TITLE_STATE_RUNNING = "（运行中）";
const TITLE_STATE_INTERRUPTED = "（已中断）";
const TITLE_STATE_SUFFIX_RE = /（(运行中|已中断)）$/;

/** 归档标题的工作区前缀：数据层真实带前缀，面板显示剥离，已归档视图按前缀分组。 */
const ARCHIVE_WS_PREFIX_RE = /^\[([^\]]+)\]\s*/;

/**
 * 收集用于标题分析的用户消息（user/message + source.kind==="user" 的 text 块拼接）。
 * 本地复刻官方 collectSessionTitleMessages 同等逻辑，避免 import 炸掉整个 plugin tree。
 */
export function collectSessionTitleMessages(events, throughSeq) {
  const messages = [];
  for (const event of events ?? []) {
    if (throughSeq !== undefined && event.seq > throughSeq) break;
    if (event?.type !== "user/message" || event?.data?.source?.kind !== "user") continue;
    const content = event.data?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    if (normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0) continue;
    messages.push({ seq: event.seq, text });
  }
  return messages;
}

/** 折叠出最近一次持久化标题（session/title 事件）。 */
export function foldTitle(events) {
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "session/title" && typeof event.data?.title === "string") {
      return event.data.title;
    }
  }
  return undefined;
}

/** 从会话 cwd 推导工作区名：优先匹配 workspaceRegistry 分组 title，否则取 cwd basename。 */
export function workspaceNameOf(ctx, cwd) {
  if (typeof cwd !== "string" || cwd === "") return "";
  const registry = ctx?.get?.("workspaceRegistry");
  if (registry) {
    try {
      for (const workspace of registry.list?.() ?? []) {
        const path = String(workspace?.path ?? "").replace(/\/+$/, "");
        const c = String(cwd).replace(/\/+$/, "");
        if (path !== "" && (c === path || c.startsWith(path + "/"))) {
          if (typeof workspace.title === "string" && workspace.title.trim() !== "") return workspace.title.trim();
        }
      }
    } catch {
      // 分组服务不可用时回退 basename
    }
  }
  return String(cwd).split(/[/\\]/).filter(Boolean).pop() ?? "";
}

/** 给标题加工作区前缀（幂等：已带前缀不叠加）。返回 {title, ws}。 */
export function archiveTitleWithWs(title, ws) {
  const t = String(title ?? "");
  const stripped = t.replace(ARCHIVE_WS_PREFIX_RE, "");
  const name = String(ws ?? "").trim();
  if (name === "" || stripped === "") return { title: t, ws: name };
  return { title: `[${name}] ${stripped}`, ws: name };
}

/** 剥离工作区前缀，返回 {title(无前缀), ws(前缀工作区名或空)}。 */
export function stripArchiveWsPrefix(title) {
  const t = String(title ?? "");
  const m = t.match(ARCHIVE_WS_PREFIX_RE);
  if (!m) return { title: t, ws: "" };
  return { title: t.slice(m[0].length), ws: m[1] };
}

/**
 * 归一化标题为字符串：sessionTitle 服务返回的是标题快照对象
 * （{title, source, eventSeq, ...}），面板只需要其中的 title 字符串。
 */
export function titleString(snapshot) {
  if (typeof snapshot === "string") return snapshot;
  if (snapshot !== null && typeof snapshot === "object" && typeof snapshot.title === "string") return snapshot.title;
  return undefined;
}

/**
 * 取会话标题：优先 sessionTitle 服务（只接受真正的 Session，cold 假对象会抛），
 * 回退从事件流折叠。
 */
export function resolveSessionTitle(sessionTitle, session, events) {
  if (sessionTitle && session && typeof session.snapshotEvents === "function") {
    try {
      const title = titleString(sessionTitle.get(session));
      if (title) return title;
    } catch {
      // 非 live Session 或 get() 签名变化
    }
  }
  return foldTitle(events) ?? null;
}

/**
 * 依据会话事件流判定标题应附加的状态后缀（live 视角）：
 *   open turn（未闭合回合）= 运行中；interrupted/error/冷 open-turn = 已中断；
 *   正常完成 / 用户取消 = 无后缀。
 */
export function stateSuffixOf(events) {
  if (hasOpenTurn(events)) return TITLE_STATE_RUNNING;
  const info = interruptionInfo(events);
  if (info && info.kind !== "aborted") return TITLE_STATE_INTERRUPTED;
  return "";
}

/** 去掉标题尾部的状态后缀（用于更新后缀或与 LLM 主题标题比较）。 */
export function stripTitleStateSuffix(title) {
  return String(title ?? "").replace(TITLE_STATE_SUFFIX_RE, "");
}

/**
 * 刷新标题的状态后缀（仅自动重命名会话，且 cfg.titleStateSuffix 开启）。
 * 状态变化（turn/start → 运行中；turn/end → 空闲/已中断）时把标题改成
 * 「主题 + 状态后缀」，后缀与主题分离，LLM 只负责主题、后缀由状态机维护。
 * @returns 新的完整标题；无需变化或失败返回 null。
 */
export async function refreshTitleState(ctx, session) {
  if (!session?.id || cfg.titleStateSuffix === false) return null;
  const state = await pluginState(ctx);
  if (!autoRenameEnabled(ctx, state, session.id)) return null;
  const titleService = ctx.get("sessionTitle");
  if (!titleService) return null;
  const current = titleString(titleService.get(session));
  if (!current) return null;
  const suffix = stateSuffixOf(session.events);
  const next = `${stripTitleStateSuffix(current)}${suffix}`;
  if (next === current) return null;
  try {
    titleService.rename(session, next);
    return next;
  } catch (error) {
    log(ctx, `标题状态刷新失败 ${session.id}: ${String(error?.message ?? error)}`);
    return null;
  }
}
