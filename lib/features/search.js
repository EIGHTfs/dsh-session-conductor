/** 会话全文检索：可检索事件收集、文本匹配、按会话检索。 */

import { sessionEventsOf } from "../sessions/events.js";
import { buildSessionListCached } from "../sessions/list.js";

// ---------- 全文搜索 / 批量删除 / 按条件删除 ----------

export const SEARCH_MIN_QUERY = 2; // 关键词最短长度（低于不搜）

const SEARCH_MAX_SESSIONS = 200; // 单次扫描会话数上限（全文扫描保护）

const SEARCH_PER_SESSION_MAX = 5; // 单会话最多返回命中数

const SEARCH_PREVIEW_LEN = 140; // 命中上下文片段长度

/**
 * 从会话事件流提取可搜索的文本行（user 消息 / assistant 文本块）。
 * 工具调用与结果不参与搜索（正文噪音大）。
 * @param {Array} events 会话事件数组
 * @returns {Array<{seq:number, time:number, role:"user"|"assistant", text:string}>}
 */
export function collectSearchableEvents(events) {
  const out = [];
  for (const ev of events ?? []) {
    const t = ev?.type;
    let role = null;
    let text = null;
    if (t === "user/message" || t === "user") {
      // 只收真人消息：系统注入（runtime context / system-reminder / skill 目录等 source.kind=plugin）
      // 不算正文，否则搜「skill」「DSH」等词会被注入噪音淹没
      if (ev?.data?.source?.kind !== "user") continue;
      const content = ev.data?.content ?? ev.data?.message?.content;
      if (Array.isArray(content)) {
        const txt = content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        if (txt) { role = "user"; text = txt; }
      }
    } else if (t === "assistant/chunk") {
      const chunk = ev?.data?.chunk;
      if (chunk && typeof chunk.text === "string" && (chunk.blockType === "text" || chunk.blockType === "text-chunks")) {
        role = "assistant";
        text = chunk.text;
      }
    } else if (t === "assistant/message" || t === "message") {
      const content = ev?.data?.message?.content ?? ev?.data?.content;
      if (Array.isArray(content)) {
        const txt = content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        if (txt) { role = "assistant"; text = txt; }
      }
    }
    if (role && text) out.push({ seq: ev.seq ?? 0, time: ev.time ?? 0, role, text });
  }
  return out;
}

/**
 * 在事件文本里搜关键词（大小写不敏感），返回命中上下文片段。
 * @returns {Array<{seq:number, time:number, role:string, preview:string}>}
 */
export function searchEventsText(events, query, { perSessionMax = SEARCH_PER_SESSION_MAX, previewLen = SEARCH_PREVIEW_LEN } = {}) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  if (!normalizedQuery) return [];
  const hits = [];
  for (const searchEvent of collectSearchableEvents(events)) {
    if (hits.length >= perSessionMax) break;
    const idx = searchEvent.text.toLowerCase().indexOf(normalizedQuery);
    if (idx !== -1) {
      const half = Math.floor(previewLen / 2);
      const start = Math.max(0, idx - half);
      const end = Math.min(searchEvent.text.length, idx + normalizedQuery.length + half);
      const preview = (start > 0 ? "…" : "") + searchEvent.text.slice(start, end).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim() + (end < searchEvent.text.length ? "…" : "");
      hits.push({ seq: searchEvent.seq, time: searchEvent.time, role: searchEvent.role, preview });
    }
  }
  return hits;
}

/**
 * 全文搜索：跨所有会话的消息内容搜关键词。
 * scope：all（默认，含归档）/ active（仅未归档）/ archived（仅归档）。
 * 返回命中会话 + 上下文片段；损坏/不可读会话跳过；扫描会话数有上限保护。
 */
export async function searchSessions(ctx, query, { scope = "all", maxSessions = SEARCH_MAX_SESSIONS, perSessionMax = SEARCH_PER_SESSION_MAX } = {}) {
  const queryText = String(query ?? "").trim();
  if (queryText.length < SEARCH_MIN_QUERY) return { query: queryText, scanned: 0, hits: [] };
  const sessions = await buildSessionListCached(ctx, { force: true }); // 搜索需绝对新鲜，绕过缓存
  const hits = [];
  let scanned = 0;
  for (const s of sessions) {
    if (scope === "active" && s.archived) continue;
    if (scope === "archived" && !s.archived) continue;
    if (scanned >= maxSessions) break;
    scanned += 1;
    try {
      const found = await sessionEventsOf(ctx, s.id);
      if (!found) continue;
      const matches = searchEventsText(found.events, q, { perSessionMax });
      if (matches.length > 0) {
        hits.push({
          sessionId: s.id,
          title: s.title,
          cwd: s.cwd,
          archived: s.archived === true,
          running: s.running === true,
          updatedAt: s.updatedAt ?? null,
          matches,
        });
      }
    } catch {
      /* 单个会话失败跳过（损坏日志等），不中断整体搜索 */
    }
  }
  return { query: q, scanned, hits };
}
