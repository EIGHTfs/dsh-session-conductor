// dsh-session-conductor — 会话撤销的纯逻辑（零宿主依赖，可独立单测）
//
// 【为什么单独成文件】撤销＝「定位切点 + 重建日志文本」两步纯计算，与宿主服务无关。
// 放在 session-ops.js 里会被 pluginDomain（依赖宿主包）拉住，工作区连 import 都失败，
// 最关键的「切点选得对不对」反而无法验证。
//
// 【为什么不能直接切在目标事件】目标事件（通常是用户消息）往往落在回合中间：
// 宿主会在回合运行期间把新消息 spliced 进当前 step。若直接切在那里，日志会留下
// 「有 turn/start 没有 turn/end」的悬挂回合，宿主恢复时会补 crash-orphaned closer，
// 或者直接判不一致。所以一律向前回退到最近的 turn/end（完整回合边界）；
// 退不到时（会话首个回合）退到最近的 step/end，并补一条 turn/end——
// 宿主校验要求 turn/end 必须对应「已闭合 step 的 open turn」，因此只能补在 step/end 之后。

/** 从事件里取可读文本（user/assistant 消息的 text 块拼接）。 */
function textOf(event) {
  const content = event?.data?.content ?? event?.data?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 定位「从哪一刀切」。
 *
 * 定位方式三选一（优先级 atSeq > atTime > matchText；都不给 = 最后一条真实用户消息）：
 *   · atSeq     事件序号（精确匹配）
 *   · atTime    毫秒时间戳：第一条 time >= atTime 的事件
 *   · matchText 文本片段：第一条包含它的真实用户消息（source.kind === "user"）
 *
 * @param {Array<object>} events 按 seq 升序的会话事件（不含 header）
 * @param {{atSeq?: number, atTime?: number, matchText?: string}} [opts]
 * @returns {{ok: true, targetIdx: number, cutIdx: number, closer: object|null, target: object, cut: object, removedEventCount: number, preview: string}
 *          | {ok: false, error: {code: string, message: string}}}
 */
export function locateCutPoint(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return { ok: false, error: { code: "empty", message: "会话日志没有事件" } };
  const { atSeq, atTime, matchText } = opts;

  let targetIdx = -1;
  if (Number.isInteger(atSeq)) {
    targetIdx = list.findIndex((event) => event?.seq === atSeq);
    if (targetIdx < 0) {
      return { ok: false, error: { code: "seq-not-found", message: `日志里没有 seq=${atSeq} 的事件（末 seq=${list.at(-1)?.seq}）` } };
    }
  } else if (Number.isFinite(atTime)) {
    targetIdx = list.findIndex((event) => typeof event?.time === "number" && event.time >= atTime);
    if (targetIdx < 0) return { ok: false, error: { code: "time-not-found", message: "该时间之后没有事件（已经是更早的状态）" } };
  } else if (typeof matchText === "string" && matchText !== "") {
    targetIdx = list.findIndex((event) => event?.type === "user/message"
      && event?.data?.source?.kind === "user"
      && textOf(event).includes(matchText));
    if (targetIdx < 0) return { ok: false, error: { code: "text-not-found", message: `没有找到包含「${matchText}」的用户消息` } };
  } else {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.type === "user/message" && list[i]?.data?.source?.kind === "user") { targetIdx = i; break; }
    }
    if (targetIdx < 0) return { ok: false, error: { code: "no-user-message", message: "该会话没有可撤销的用户消息" } };
  }

  const target = list[targetIdx];

  // 向前找完整回合边界
  let cutIdx = -1;
  let closer = null;
  for (let i = targetIdx; i >= 0; i -= 1) {
    if (list[i]?.type === "turn/end") { cutIdx = i; break; }
  }
  if (cutIdx < 0) {
    for (let i = targetIdx; i >= 0; i -= 1) {
      if (list[i]?.type === "step/end") {
        cutIdx = i;
        closer = {
          type: "turn/end",
          seq: list[i].seq + 1,
          time: Date.now(),
          data: { turn: list[i]?.data?.turn ?? 1, reason: { kind: "aborted", reason: { kind: "user" } } },
        };
        break;
      }
    }
  }
  if (cutIdx < 0) {
    return { ok: false, error: { code: "no-boundary", message: "目标之前没有可用的回合/步骤边界，无法安全截断" } };
  }

  return {
    ok: true,
    targetIdx,
    cutIdx,
    closer,
    target,
    cut: list[cutIdx],
    removedEventCount: list.length - cutIdx - 1,
    preview: textOf(target).slice(0, 200),
  };
}

/**
 * 用切点重建日志文本（header 一行 + 每事件一行），必要时在末尾补 closer。
 *
 * @param {string} header 原始 header 行（原样保留，不改任何字段）
 * @param {Array<object>} events 事件列表
 * @param {number} cutIdx 保留到该下标（含）
 * @param {object|null} [closer] 需要补的收尾事件
 * @returns {string} 新日志文本（以换行结尾）
 */
export function buildTruncatedText(header, events, cutIdx, closer = null) {
  const kept = (Array.isArray(events) ? events : []).slice(0, cutIdx + 1);
  if (closer) kept.push(closer);
  return [header, ...kept.map((event) => JSON.stringify(event))].join("\n") + "\n";
}
