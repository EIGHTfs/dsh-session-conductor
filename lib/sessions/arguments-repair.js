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
    if (event?.type !== "assistant/message") continue;
    const blocks = event?.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    blocks.forEach((block, blockIndex) => {
      if (block?.type !== "tool-call") return;
      const value = block.arguments;
      const shape = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (shape === VALID_SHAPE) return;
      issues.push({
        seq: event.seq,
        eventType: event.type,
        blockIndex,
        callId: String(block.id ?? ""),
        name: String(block.name ?? ""),
        shape,
        value,
      });
    });
  }
  return issues;
}

/**
 * 产出修好后的新事件数组（不改入参）。
 *
 * 每个坏块原地替换为「同样的 id / name + 序列化后的字符串 arguments」，
 * 其它字段与事件顺序、seq 全部保持原样——因此不需要重排 seq，也不影响压缩引用。
 *
 * @param {Array<object>} events 会话事件
 * @returns {{events: Array<object>, fixes: Array<{seq: number, callId: string, name: string, from: string, to: string}>, skipped: Array<{seq: number, callId: string, name: string, reason: string}>}}
 */
export function repairToolCallArguments(events) {
  const list = Array.isArray(events) ? events : [];
  const fixes = [];
  const skipped = [];
  const repaired = list.map((event) => {
    if (event?.type !== "assistant/message") return event;
    const blocks = event?.data?.message?.content;
    if (!Array.isArray(blocks)) return event;
    let changed = false;
    const nextBlocks = blocks.map((block) => {
      if (block?.type !== "tool-call") return block;
      const value = block.arguments;
      if (typeof value === "string") return block;
      const converted = toArgumentsString(value);
      if (!converted.ok) {
        skipped.push({ seq: event.seq, callId: String(block.id ?? ""), name: String(block.name ?? ""), reason: converted.reason });
        return block;
      }
      changed = true;
      fixes.push({
        seq: event.seq,
        callId: String(block.id ?? ""),
        name: String(block.name ?? ""),
        from: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        to: converted.text.length > 80 ? `${converted.text.slice(0, 80)}…` : converted.text,
      });
      return { ...block, arguments: converted.text };
    });
    if (!changed) return event;
    // 深拷贝到 message 这一层，避免污染调用方持有的事件对象
    return { ...event, data: { ...event.data, message: { ...event.data.message, content: nextBlocks } } };
  });
  return { events: repaired, fixes, skipped };
}
