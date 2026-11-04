// llm-stream-summary — 把一次 LLM 流式调用的 chunk 流折叠成「成功文本 或 真实失败」。
//
// 【为什么单独成文件、为什么放 lib/shared】
// 宿主 `llm.stream()` 在上游出错时**不抛异常**：它把失败折叠进最后一个
// `finish` chunk（`reason.kind === 'error' | 'aborted'`，带 `failure{message,code,status}`），
// 流正常结束。调用方若只把 text/reasoning 喂给拼装器、流结束后去解析内容，
// 限流（429）、配额、网络失败就会统统表现为「空输出 → 解析失败」——把上游故障
// 误报成本地解析故障（把上游故障显示成「输出无法解析」），排查方向被整体带偏。
//
// 本模块把「分类」这件事做对且只做一次：错误优先于空文本、限流带重试提示、
// max-tokens 截断单独识别（推理模型预算被思考吃光是高频场景）。
// 零本项目依赖、零外部 import，**整份文件拷到任何 DSH 插件即可用**。
//
// 【用法】
//   const outcome = await summarizeStream(llm.stream(options));
//   if (!outcome.ok) → outcome.failure 里有 code/status/retryAfterMs，直接如实报给用户
//   if (outcome.ok)  → outcome.text / outcome.reasoning / outcome.blocks

/** 把字符串安全转成数字；无效返回 undefined。 */
function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** 从错误对象/失败结构里尽力提取 HTTP 状态码与 retry-after。 */
function extractFailureHints(error) {
  const status = toFiniteNumber(error?.status ?? error?.cause?.status);
  const retryHeader = error?.headers?.["retry-after"] ?? error?.cause?.headers?.["retry-after"];
  const retryAfterSec = toFiniteNumber(retryHeader);
  return {
    status,
    retryAfterMs: retryAfterSec !== undefined ? retryAfterSec * 1000 : toFiniteNumber(error?.providerRetryAfterMs ?? error?.cause?.providerRetryAfterMs),
  };
}

/**
 * 把一个未知错误对象分类成 failure 描述（抛错路径：超时、signal abort、参数错误等）。
 * @param {unknown} error
 * @returns {{kind:"failed", code:string, message:string, status?:number, retryAfterMs?:number, aborted?:boolean, timeout?:boolean}}
 */
export function classifyThrown(error) {
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? error ?? "未知错误");
  const hints = extractFailureHints(error);
  if (name === "TimeoutError" || /timeout/i.test(message)) {
    return { kind: "failed", code: "TIMEOUT", message, ...hints, timeout: true };
  }
  if (name === "AbortError" || /abort/i.test(message)) {
    return { kind: "failed", code: "ABORTED", message, ...hints, aborted: true };
  }
  return { kind: "failed", code: String(error?.code ?? "STREAM_THREW"), message, ...hints };
}

/**
 * 折叠一个 chunk 流：收集 block/usage，识别 finish 的失败与截断语义。
 * 不抛业务异常——流本身抛错（超时/取消）由调用方 catch 后交给 classifyThrown。
 *
 * @param {AsyncIterable<object>} chunks llm.stream() 的返回值
 * @returns {Promise<{ok:true,text:string,reasoning:string,blocks:object[],usage?:object,finishKind?:string,truncated?:boolean}
 *                |{ok:false,kind:"failed",code:string,message:string,status?:number,retryAfterMs?:number,raw?:object}
 *                |{ok:false,kind:"truncated",code:"MAX_TOKENS",message:string,text:string,reasoning:string}>}
 */
export async function collectStream(chunks) {
  const blocks = [];
  const reasoningParts = [];
  const textParts = [];
  let usage;
  let finish = null;
  for await (const chunk of chunks) {
    if (chunk?.type === "block-end" && chunk.block) {
      blocks.push(chunk.block);
      if (chunk.block.type === "text" && typeof chunk.block.text === "string") textParts.push(chunk.block.text);
      if (chunk.block.type === "reasoning" && typeof chunk.block.text === "string") reasoningParts.push(chunk.block.text);
    } else if (chunk?.type === "usage") {
      usage = chunk.usage;
    } else if (chunk?.type === "finish") {
      finish = chunk.reason ?? null;
    }
  }
  const kind = finish?.kind;
  // ① 失败优先于空文本：上游 4xx/5xx、配额、取消都走 error/aborted finish
  if (kind === "error" || kind === "aborted") {
    const failure = finish?.failure ?? {};
    const message = String(failure.message ?? (kind === "aborted" ? "请求被取消" : "上游返回失败"));
    const retryAfterMs = toFiniteNumber(failure.providerRetryAfterMs);
    return {
      ok: false,
      kind: "failed",
      code: String(failure.code ?? (kind === "aborted" ? "ABORTED" : "UPSTREAM_ERROR")),
      message,
      ...(toFiniteNumber(failure.status) !== undefined ? { status: toFiniteNumber(failure.status) } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  const text = textParts.join("");
  const reasoning = reasoningParts.join("");
  // ② 截断：max-tokens 时正文可能为空或半截，单列一类，别和「解析失败」混
  if (kind === "max-tokens") {
    return { ok: false, kind: "truncated", code: "MAX_TOKENS", message: "输出达到 maxTokens 被截断（推理型模型可能把预算耗在思考上）", text, reasoning };
  }
  return { ok: true, text, reasoning, blocks, ...(usage ? { usage } : {}), ...(kind ? { finishKind: kind } : {}) };
}

/**
 * 首选入口：消费 llm.stream() 的返回并给出「成功文本 / 真实失败」二元结果。
 * 流抛错（AbortSignal.timeout、参数错误）也会被收进 failure，绝不冒泡成「解析失败」。
 *
 * @param {AsyncIterable<object>} streamOrPromise llm.stream(...) 的返回（或其 Promise）
 * @returns 同 collectStream，外加抛错路径经 classifyThrown 的分类结果
 */
export async function summarizeStream(streamOrPromise) {
  try {
    const stream = await streamOrPromise;
    return await collectStream(stream);
  } catch (error) {
    return classifyThrown(error);
  }
}
