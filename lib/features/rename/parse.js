// dsh-session-conductor — 自动重命名的 LLM 输出解析（纯函数，可独立单测）
//
// 【为什么单独成文件】这些函数是「文本 → 结构化结果」的纯逻辑，与宿主 llm 服务无关。
// 放在 analysis.js 里会被 `@deepseek-ai/dsh-llm` 等宿主包依赖拉住，工作区单测根本 import 不了，
// 于是最容易出错的解析环节反而没有测试。抽出来后可以直接跑断言。
//
// 【历史坑】推理型模型会先输出思考内容：`maxTokens` 稍小就会在思考阶段耗尽预算、
// 正文块为空。旧实现只读正文块，于是一律报「模型不可用或输出异常」——模型完全正常，
// 却表现为自动重命名整条链路失效。现在正文为空时回退思考块（见 pickParseSource）。

/**
 * 从一次流式返回里挑出用于解析的文本。
 *
 * 正文非空时优先正文：思考内容里往往夹着推理过程，噪声更大；
 * 正文为空（预算被思考吃掉 / 模型只吐思考）时回退思考块，JSON 通常就在里面。
 *
 * @param {Array<{type: string, text?: string}>} blocks BlockAssembler 产出的块
 * @returns {string} 用于解析的文本（可能为空串）
 */
export function pickParseSource(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const join = (type) => list
    .filter((block) => block?.type === type)
    .map((block) => String(block?.text ?? ""))
    .join(" ")
    .trim();
  const text = join("text");
  if (text !== "") return text;
  return join("reasoning");
}

/**
 * 从输出里取「只含标题」的 JSON（强制标题模式用）。容忍代码块围栏与前后多余文字。
 * @param {string} raw LLM 文本
 * @returns {string|null} 标题；拿不到返回 null
 */
export function extractTitleOnly(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === "object" && typeof parsed.title === "string" && parsed.title.trim() !== "") {
      return parsed.title;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 解析主题偏移判定 JSON：`{changed:boolean, title?:string}`（容忍代码块围栏）。
 * @param {string} raw LLM 文本
 * @returns {{changed: boolean, title?: string}|null} 解析失败返回 null
 */
export function parseDriftJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed === null || typeof parsed !== "object" || typeof parsed.changed !== "boolean") return null;
    return {
      changed: parsed.changed,
      ...typeof parsed.title === "string" ? { title: parsed.title } : {}
    };
  } catch {
    return null;
  }
}
