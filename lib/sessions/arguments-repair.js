// dsh-session-conductor — 会话日志里 `tool-call.arguments` 的形态修复（纯逻辑）
//
// 【为什么需要】`ToolCallBlock.arguments` 的契约是「模型产出的原始 JSON 字符串」
// （`@deepseek-ai/dsh-llm` 的 types：`arguments: string`）。第三方适配器如果把上游
// chunk 里的参数对象直接塞进 assistant/message，就会存成对象。后果不是「少几个 token」，
// 而是整条会话打不开：token-meter 的估算器对 `tool-call` 块取 `block.arguments.length`，
// 对象没有 length ⇒ `Math.ceil(undefined / 4)` = NaN ⇒ surfaceTokens NaN
// ⇒ projectedTokens NaN ⇒ 投影 schema（`.int().nonnegative()`）拒收。
//
// 【本模块只做纯计算】识别坏块、把值改成合法字符串、给出改动明细；不碰文件、不碰宿主。
// 写回、备份、清投影缓存由 features 层负责（与撤销/截断同一套流程）。
//
// 【为什么不是「删掉坏块」】删块会让工具调用与结果对不上（tool/result 仍在），
// 而且丢失模型原本的参数内容。序列化后内容等价，模型看到的仍是同一份参数。

/** 合法形态：契约要求的字符串。 */
const VALID_SHAPE = "string";

/**
 * 把一个 `arguments` 值转成契约要求的字符串。
 * @param {unknown} value 事件里存的值
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
export function toArgumentsString(value) {
  if (typeof value === "string") return { ok: true, text: value };
  if (value === undefined) return { ok: false, reason: "字段缺失（没有可序列化的值，需人工确认）" };
  if (typeof value === "number" && Number.isNaN(value)) return { ok: false, reason: "NaN（无法表示成 JSON 数字）" };
  if (typeof value === "function" || typeof value === "symbol") return { ok: false, reason: `不支持的类型 ${typeof value}` };
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return { ok: false, reason: "序列化结果不是字符串" };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, reason: `序列化失败：${String(error?.message ?? error)}` };
  }
}

/**
 * 列出所有 `tool-call` 块的 arguments 形态问题。
 *
 * 只检查 `assistant/message`（契约里 tool-call 只出现在助手消息中）；
 * 其它事件类型即使带同样字段也不属于本契约。
 *
 * @param {Array<object>} events 会话事件（已解析的 JSON 对象）
 * @returns {Array<{seq: number, eventType: string, blockIndex: number, callId: string, name: string, shape: string, value: unknown}>}
 */
export function findToolCallArgumentIssues(events) {
  const issues = [];
  for (const event of Array.isArray(events) ? events : []) {
    // 助手侧：模型声明的调用
    if (event?.type === 'assistant/message') {
      const blocks = event?.data?.message?.content;
      if (!Array.isArray(blocks)) continue;
      blocks.forEach((block, blockIndex) => {
        if (block?.type !== 'tool-call') return;
        const value = block.arguments;
        const shape = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        if (shape === VALID_SHAPE) return;
        issues.push({
          seq: event.seq, eventType: event.type, where: "assistant/message", blockIndex,
          callId: String(block.id ?? ""), name: String(block.name ?? ""), shape, value,
        });
      });
      continue;
    }
    // 调用侧：实际发起的调用。宿主加载时拿它的 name/arguments 与助手侧声明严格比较，
    // 所以这里必须一起查 —— 只查助手侧会让「助手已合规、调用侧还是对象」的日志漏修，
    // 而这种日志加载时直接报 corrupt（比原来的 NaN 更硬）。
    if (event?.type === "tool/call") {
      const value = event?.data?.arguments;
      const shape = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (shape === VALID_SHAPE) continue;
      issues.push({
        seq: event.seq, eventType: event.type, where: "tool/call", blockIndex: -1,
        callId: String(event?.data?.callId ?? ""), name: String(event?.data?.name ?? ""), shape, value,
      });
    }
  }
  return issues;
}
/**
 * 产出修好后的新事件数组（不改入参）。
 *
 * 【必须两侧一起改】同一次工具调用在日志里出现两次：
 *   · `assistant/message` 的 `tool-call` 块（模型声明的调用）
 *   · `tool/call` 事件（实际发起的调用）
 * 宿主加载时用严格相等比较两者的 name 与 arguments（`pending.arguments !== data.arguments`
 * 直接抛 `does not match one advertised tool call`）。只改一侧会让日志变成 corrupt ——
 * 比原来的 NaN 更严重（连加载都过不去）。所以这里先规范化助手侧，再用**同一个字符串**
 * 写回对应的 tool/call，保证两侧逐字符一致。
 *
 * @param {Array<object>} events 会话事件
 * @returns {{events: Array<object>, fixes: Array<object>, skipped: Array<object>}}
 */
export function repairToolCallArguments(events) {
  const list = Array.isArray(events) ? events : [];
  const fixes = [];
  const skipped = [];
  /** callId → 规范化后的 arguments 字符串（供 tool/call 对齐） */
  const canonical = new Map();

  // ① 助手侧：tool-call 块
  let repaired = list.map((event) => {
    if (event?.type !== 'assistant/message') return event;
    const blocks = event?.data?.message?.content;
    if (!Array.isArray(blocks)) return event;
    let changed = false;
    const nextBlocks = blocks.map((block) => {
      if (block?.type !== 'tool-call') return block;
      const value = block.arguments;
      const callId = String(block.id ?? '');
      if (typeof value === 'string') { canonical.set(callId, value); return block; }
      const converted = toArgumentsString(value);
      if (!converted.ok) {
        skipped.push({ seq: event.seq, callId, name: String(block.name ?? ''), where: 'assistant/message', reason: converted.reason });
        return block;
      }
      changed = true;
      canonical.set(callId, converted.text);
      fixes.push({
        seq: event.seq, callId, name: String(block.name ?? ''), where: 'assistant/message',
        from: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
        to: converted.text.length > 80 ? `${converted.text.slice(0, 80)}…` : converted.text,
      });
      return { ...block, arguments: converted.text };
    });
    if (!changed) return event;
    return { ...event, data: { ...event.data, message: { ...event.data.message, content: nextBlocks } } };
  });

  // ② 调用侧：tool/call 事件，与助手侧用同一个字符串
  repaired = repaired.map((event) => {
    if (event?.type !== 'tool/call') return event;
    const callId = String(event.data?.callId ?? '');
    const value = event.data?.arguments;
    const target = canonical.get(callId);
    if (typeof value === 'string' && (target === undefined || value === target)) return event;
    const converted = target !== undefined ? { ok: true, text: target } : toArgumentsString(value);
    if (!converted.ok) {
      skipped.push({ seq: event.seq, callId, name: String(event.data?.name ?? ''), where: 'tool/call', reason: converted.reason });
      return event;
    }
    fixes.push({
      seq: event.seq, callId, name: String(event.data?.name ?? ''), where: 'tool/call',
      from: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      to: converted.text.length > 80 ? `${converted.text.slice(0, 80)}…` : converted.text,
    });
    return { ...event, data: { ...event.data, arguments: converted.text } };
  });

  return { events: repaired, fixes, skipped };
}