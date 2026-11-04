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
 * 从 start（必须是 `{`）找平衡闭合的位置：按深度计数，且**跳过字符串字面量里的花括号**
 * （JSON 值里常有 `{`），转义符正确穿透。
 * @param {string} source 全文
 * @param {number} start `{` 的下标
 * @returns {number} 闭合 `}` 的下标；找不到返回 -1
 */
function balancedClose(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 扫出文本里所有「平衡的花括号片段」（按出现位置排序，去重）。
 * 思考型模型的输出常在 JSON 前后带推理文字，还可能夹未闭合的杂 `{`；
 * 因此从**每一个 `{` 起点**各找一次平衡闭合（外层、内层都进候选），
 * 由调用方逐个试解析——比贪婪 `\{[\s\S]*\}` 稳得多。
 * @param {string} text
 * @returns {string[]} 候选 JSON 片段（从先到后）
 */
export function braceCandidates(text) {
  const source = String(text ?? "");
  const out = [];
  const seen = new Set();
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "{") continue;
    const close = balancedClose(source, i);
    if (close < 0) continue;
    const slice = source.slice(i, close + 1);
    if (!seen.has(slice)) {
      seen.add(slice);
      out.push(slice);
    }
  }
  return out;
}

/**
 * 从输出里取「只含标题」的 JSON（强制标题模式用）。容忍代码块围栏与前后多余文字。
 * @param {string} raw LLM 文本
 * @returns {string|null} 标题；拿不到返回 null
 */
export function extractTitleOnly(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  // 与 parseDriftJson 同策略：逐平衡括号候选试解析，第一个带非空 title 的对象即命中
  for (const candidate of braceCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.title === "string" && parsed.title.trim() !== "") {
        return parsed.title;
      }
    } catch {
      // 该片段不是合法 JSON，试下一个
    }
  }
  return null;
}


/**
 * 解析主题偏移判定 JSON：`{changed:boolean, title?:string}`。
 * 容忍代码块围栏、前后解释文字、思考与正文混杂：逐个平衡括号片段试解析，
 * 第一个含合法 `changed:boolean` 的对象即命中。
 * @param {string} raw LLM 文本（正文或思考均可）
 * @returns {{changed: boolean, title?: string}|null} 解析失败返回 null
 */
export function parseDriftJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  for (const candidate of braceCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== "object" || typeof parsed.changed !== "boolean") continue;
      return {
        changed: parsed.changed,
        ...typeof parsed.title === "string" ? { title: parsed.title } : {}
      };
    } catch {
      // 该片段不是合法 JSON，试下一个
    }
  }
  return null;
}

/** 分析调用的默认输出预算：覆盖「思考 + 一小段 JSON」，仍远小于任何模型窗口。 */
export const AUTO_RENAME_DEFAULT_MAX_TOKENS = 2048;

/**
 * 解析分析预算：配置 `autoRenameMaxTokens` 覆盖默认；**0（或负数）= 不限制**
 * ——不传 maxTokens，由宿主按模型 defaultMaxTokens 兜底。
 * @param {unknown} configured 配置值（可缺省）
 * @returns {number|undefined} undefined = 不传（不限制）
 */
export function resolveAnalysisMaxTokens(configured) {
  if (configured === undefined || configured === null || configured === "") return AUTO_RENAME_DEFAULT_MAX_TOKENS;
  const num = Number(configured);
  if (!Number.isFinite(num)) return AUTO_RENAME_DEFAULT_MAX_TOKENS;
  return num <= 0 ? undefined : Math.floor(num);
}

