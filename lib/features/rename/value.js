// dsh-session-conductor — 会话价值 LLM 判断
//
// 【职责】批量判定会话的「高/中/低价值」，供按规则删除（低价值）等功能使用。
// fail-soft：LLM 不可用 / 无模型路由 / 超时 / 非法 JSON 的会话跳过（规则判定兜底），不阻塞。

import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveRoute, AUTO_RENAME_TIMEOUT_MS } from "./analysis.js";

/**
 * 会话价值 LLM 判断：
 * 批量对会话用 LLM 判定「高/低价值」，返回 会话id → {value, reason}。
 * 价值定义：高价值（有独有信息/未完成任务/学习/资产）+ 低价值（灰尘/重复/可丢弃）。
 * @param {object} ctx 插件上下文（ctx.get("llm") 拿 LLM 服务）
 * @param {Array} sessions 会话对象数组（含 id/title/cwd）
 * @param {object} texts 会话 id → 最后 assistant 文本
 * @param {Function} [onError] 日志回调
 * @returns {Promise<object>} 会话 id → {value:"high"|"medium"|"low", reason}
 */
export async function analyzeValueWithLlm(ctx, sessions, texts, onError) {
  const out = {};
  let llm;
  try {
    llm = ctx.get("llm");
  } catch { llm = null; }
  if (!llm) {
    if (typeof onError === "function") onError("会话价值 LLM 判断跳过：llm 服务不可用");
    return out;
  }
  for (const s of sessions ?? []) {
    try {
      const route = resolveRoute(s, llm);
      if (!route?.provider || !route.model) continue; // 无模型路由 → 跳过，规则兜底
      const title = s.title || s.cwd || s.id || "（无标题）";
      const last = (texts?.[s.id] || "").slice(0, 800);
      const system = "你是 DSH（DeepSeek Harness）会话价值分析师。给定一个会话的标题与最后回复片段，判断它在长期保留意义上的价值。高价值=含独有信息/未完成任务/学习成果/资产/待继续工作；低价值=灰尘/重复/过时空壳/可安全丢弃。输出严格 JSON，无 Markdown：{\"value\":\"high\"|\"medium\"|\"low\",\"reason\":\"一句话中文理由\"}";
      const text = [`会话标题：${title}`, "最后回复片段：", last].join("\n");
      const assembler = new BlockAssembler();
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [createUserMessage({ content: [{ type: "text", text }], source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor" } })],
        system,
        maxTokens: 120,
        sessionId: s.id,
        purpose: "session-conductor-value-analysis",
        signal: AbortSignal.timeout(AUTO_RENAME_TIMEOUT_MS),
      })) assembler.push(chunk);
      const blocks = assembler.blocks();
      const raw = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      const parsed = parseValueJson(raw);
      if (parsed) out[s.id] = { value: parsed.value, reason: parsed.reason || "" };
    } catch (error) {
      if (typeof onError === "function") onError(`会话价值 LLM 判断失败 ${s.id}: ${String(error?.message ?? error)}`);
      /* 单个会话失败跳过，规则兜底 */
    }
  }
  return out;
}

/** 解析会话价值 LLM 输出的严格 JSON（容忍代码块围栏）。 */
export function parseValueJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || !["high", "medium", "low"].includes(parsed.value)) return null;
    return { value: parsed.value, ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) };
  } catch {
    return null;
  }
}
