/**
 * dsh-session-conductor — 会话价值分析（纯函数）
 *
 * 对会话做三类价值判定 + 最后回复摘要：
 *   completed   已完成：最后回复含任务收尾约定（✅ 任务完成 / ✅ 已解答 + ═ 分隔线）
 *   unfinished  未完成：最后回复含未完成标记（⚠️ 未完成 / ❌ 失败），或会话有中断（interruption/open turn）
 *   stale       久未对话：最后活动距今超过 staleDays（默认 3 天）且不属于前两类
 *   active      活跃中：其余（近期有活动且无明确完成/未完成标记）
 *
 * 判定逻辑纯函数化，可独立单测（node test-value.mjs）。
 */

/** 收尾约定（task-completion-report）：已完成标记 */
const COMPLETED_MARK = /✅\s*(任务完成|已解答)/;
/** 未完成标记 */
const UNFINISHED_MARK = /⚠️\s*(未完成|待继续)|❌\s*(失败|未完成)/;
const SEPARATOR = /═/;

/** 用户消息事件类型（DSH 会话事件契约）：多处判定「这条是否真人输入」都用它。 */
const EVENT_TYPE_USER_MESSAGE = "user/message";

/** 摘要截断长度：列表里展示的最后消息摘要上限（字符）。 */
const SUMMARY_MAX_CHARS = 140;
/** 关键词命中分：命中即无条件判高（高于一切权重累加）。 */
const SCORE_KEYWORD_HIT = 100_000;
/** LLM 判高 / 判低对应的分数（覆盖规则分，但低于关键词命中）。 */
const SCORE_LLM_HIGH = 80;
const SCORE_LLM_LOW = 20;
/** 价值打分权重：改权重只动这里，避免数字散落在各分支里看不出关系。 */
const VALUE_SCORE = {
  hasDetail: 40,       // 用户有细节补充（最高权重）
  activeWithin1h: 20,  // 1 小时内活动
  activeWithin24h: 15, // 24 小时内活动
  activeWithin72h: 10, // 3 天内活动
  eventsVeryLong: 18,  // 事件数 ≥ veryLong
  eventsLong: 14,      // 事件数 ≥ long
  eventsMedium: 8,     // 事件数 ≥ medium
  eventsFew: 2,        // 事件数更少的保底分
  perCompleted: 3,     // 每完成 1 项
  unfinished: 6,       // 有未完成（需出任务清单，承接价值）
  keywordHit: SCORE_KEYWORD_HIT, // 关键词命中：无条件最高
  llmHigh: SCORE_LLM_HIGH,       // LLM 判高
  llmLow: SCORE_LLM_LOW,         // LLM 判低
  artifactSafe: 60,    // 事件不可读（孤儿/未登记）时保守保留
};
/** 事件条数分档阈值（会话长度）。 */
const EVENT_COUNT = { veryLong: 2000, long: 500, medium: 100 };
/** 完成事项计分上限：完成再多也不无限加分。 */
const COMPLETED_COUNT_CAP = 5;
/** 高/低价值分界（≥high 判高、≤low 判低，中间看有无细节补充）。 */
const VALUE_CUTOFF = { high: 30, low: 15 };
/** 毫秒 → 小时。 */
const MS_PER_HOUR = 3_600_000;
/** 「长期未动」判据：超过 30 天（事件不可读时的例外判断用）。 */
const LONG_STALE_HOURS = 30 * 24;

/**
 * 从会话事件流提取最后一条 assistant 文本（assistant/chunk 的 data.chunk.text，或
 * assistant/message 的 data.message.content）。
 * @param {Array} events 会话事件数组
 * @returns {string} 最后文本（可能为空字符串）
 */
export function lastAssistantText(events) {
  if (!Array.isArray(events)) return "";
  let text = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const t = ev?.type;
    if (t === "assistant/chunk") {
      const chunk = ev?.data?.chunk;
      if (chunk && typeof chunk.text === "string" && (chunk.blockType === "text" || chunk.blockType === "text-chunks")) {
        text = chunk.text;
        break;
      }
      continue;
    }
    if (t === "assistant/message" || t === "message") {
      const content = ev?.data?.message?.content ?? ev?.data?.content;
      if (Array.isArray(content)) {
        const parts = content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text);
        if (parts.length > 0) {
          text = parts.join("\n");
          break;
        }
      }
      continue;
    }
    if (t === EVENT_TYPE_USER_MESSAGE || t === "user") {
      // 已到用户消息仍未找到 assistant 文本 → 结束
      break;
    }
  }
  return text;
}

/**
 * 判定会话价值分类。
 * @param {object} s 会话对象 {id, title, updatedAt, interruption, running, archived}
 * @param {string} lastText 最后 assistant 文本
 * @param {Date} now 当前时间
 * @param {number} staleDays 久未对话阈值（天）
 * @returns {{status: "completed"|"unfinished"|"stale"|"active", summary: string}}
 */
export function classifySessionValue(s, lastText, now = new Date(), staleDays = 3) {
  const text = String(lastText ?? "");
  const summary = summarizeText(text, SUMMARY_MAX_CHARS);
  const hasCompleted = COMPLETED_MARK.test(text) && SEPARATOR.test(text);
  const hasUnfinished = UNFINISHED_MARK.test(text);
  const interrupted = s?.interruption != null; // null/undefined 都不算中断
  // 中断判定：interruption 字段非空；或 archived 之外 open turn（running 且无 completed）
  if (hasCompleted) return { status: "completed", summary };
  if (hasUnfinished || interrupted) return { status: "unfinished", summary };
  const updated = typeof s?.updatedAt === "number" ? s.updatedAt : NaN;
  const staleMs = staleDays * 24 * 3600 * 1000;
  if (Number.isFinite(updated) && now.getTime() - updated > staleMs) return { status: "stale", summary };
  return { status: "active", summary };
}

/**
 * 从会话事件流提取最后一条「用户消息」文本（user/message 的 data.content text；
 * 跳过系统注入的消息——以 "Current runtime context" 开头等运行时上下文）。
 * @param {Array} events 会话事件数组
 * @returns {string} 最后用户消息文本（可能为空字符串）
 */
export function lastUserText(events) {
  if (!Array.isArray(events)) return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type !== EVENT_TYPE_USER_MESSAGE) continue;
    const eventData = ev.data ?? {};
    const content = Array.isArray(eventData.content) ? eventData.content : Array.isArray(eventData.message?.content) ? eventData.message.content : [];
    const text = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    if (!text) continue;
    // 跳过系统注入（运行时上下文等）
    if (/^\s*Current runtime context/.test(text) || /^\s*The user (said|requested)/.test(text)
        || /^\s*<system-reminder>/.test(text)) continue;
    return text;
  }
  return "";
}

/** 清理并截断文本为摘要（去首尾空白、压缩换行、限长）。 */
export function summarizeText(text, maxLen = 140) {
  if (typeof text !== "string" || text === "") return "";
  const cleaned = text
    .replace(/\s*\n\s*/g, " ") // 换行折叠为空格
    .replace(/\s{2,}/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + "…";
}

/** 对一组会话批量分析，返回分类结果。 */
export function analyzeSessionValues(sessions, textsById, userTextsById, now = new Date(), staleDays = 3) {
  const buckets = { completed: [], unfinished: [], stale: [], active: [] };
  for (const s of sessions ?? []) {
    const lastText = textsById?.[s.id] ?? "";
    const { status, summary } = classifySessionValue(s, lastText, now, staleDays);
    const entry = {
      id: s.id,
      title: s.title ?? null,
      cwd: s.cwd ?? null,
      updatedAt: s.updatedAt ?? null,
      archived: s.archived === true,
      summary,
      userSummary: summarizeText(userTextsById?.[s.id] ?? "", SUMMARY_MAX_CHARS), // 最后一条用户消息摘要（ 补充）
    };
    buckets[status].push(entry);
  }
  // 每个分类按最后活动时间倒序
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  return buckets;
}

/**
 * 把规则判定 status + 可选 LLM 打分合成「高/低价值」决定（纯函数，无 IO）。
 * 设计（待办 #2 会话价值 LLM 判断）：LLM 打分优先；LLM 未给出 high/low 时用规则 status 兜底，
 * 且「宁高不丢」——只有明确 stale/completed 才判低价值，unfinished/active 一律高价值保数据。
 *
 * @param {string} status 规则判定：completed|unfinished|stale|active
 * @param {string} [llmValue] 可选 LLM 打分：high|medium|low
 * @param {string} [llmReason] 可选 LLM 理由
 * @returns {{value:"high"|"low", reason:string, source:"llm"|"rule"}}
 */
export function mapValuePriority(status, llmValue = null, llmReason = "") {
  if (llmValue === "high") return { value: "high", reason: llmReason || "LLM 判定为高价值会话", source: "llm" };
  if (llmValue === "low") return { value: "low", reason: llmReason || "LLM 判定为低价值会话", source: "llm" };
  if (llmValue === "medium") {
    const low = status === "stale" || status === "completed";
    return { value: low ? "low" : "high", reason: llmReason || "LLM 判定 medium，按规则推断价值", source: "rule" };
  }
  const low = status === "stale" || status === "completed";
  const reason =
    status === "stale" ? "久未对话，按规则判为低价值"
    : status === "completed" ? "已完成，低价值但可保留"
    : status === "unfinished" ? "未完成，高价值（待继续）"
    : "活跃中，高价值";
  return { value: low ? "low" : "high", reason, source: "rule" };
}

/**
 * 在 analyzeSessionValues 结果基础上追加高/低价值清单（LLM 可选）。
 * @param {Array} sessions 会话对象数组
 * @param {object} textsById 会话 id → 最后 assistant 文本
 * @param {object} userTextsById 会话 id → 最后用户消息文本
 * @param {object} [llmById] 可选 会话 id → {value:"high"|"medium"|"low", reason}（LLM 打分结果，无则纯规则）
 * @param {Date} now 当前时间
 * @param {number} staleDays 久未对话阈值（天）
 * @returns {{completed,unfinished,stale,active, high:[], low:[]}}
 */
export function analyzeSessionValuesWithPriority(sessions, textsById, userTextsById, llmById = {}, now = new Date(), staleDays = 3) {
  const base = analyzeSessionValues(sessions, textsById, userTextsById, now, staleDays);
  const high = [];
  const low = [];
  for (const s of sessions ?? []) {
    // 先算规则 status（复用 classifySessionValue，但这里直接对每个会话解析）
    const lastText = textsById?.[s.id] ?? "";
    const { status } = (() => {
      const r = classifySessionValue(s, lastText, now, staleDays);
      return { status: r.status };
    })();
    const llmHit = llmById?.[s.id] || null;
    const { value, reason, source } = mapValuePriority(status, llmHit ? llmHit.value : null, llmHit ? llmHit.reason : "");
    const entry = { id: s.id, title: s.title ?? null, cwd: s.cwd ?? null, updatedAt: s.updatedAt ?? null, archived: s.archived === true, value, reason, source };
    (value === "high" ? high : low).push(entry);
  }
  high.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  low.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { ...base, high, low };
}

/**
 * 会话价值五维评分（用户确定的价值判断规则，纯函数）：
 *   ① 用户细节补充（hasDetail）  最高权重：用户主动细化/补充 = 会话最有价值
 *   ② 活跃度（activeHours）     越近/越频繁（activeHours 越小越活跃）→ 越高
 *   ③ 长度（eventCount）        会话越长 → 越高
 *   ④ 完成度（completedCount）  完成的事越多 → 越高
 *   ⑤ 未完成（hasUnfinished）   有未完成 → 需总结任务清单（承接价值，中等权重）
 *
 * 价值 = ① > ② > ③ > ④ > ⑤（用户投入 > 活跃 > 长度 > 产出 > 待办承接）。
 *
 * @param {object} f 特征
 *  f.hasDetail         是否有用户细节补充（bool）
 *  f.activeHours       距上次活动小时数（越小越活跃）
 *  f.eventCount        会话事件条数（长度）
 *  f.completedCount    完成事项数量
 *  f.hasUnfinished     是否有未完成待续（bool）
 * @returns {{score:number, value:"high"|"low", reason:string}}
 */
export function assessValue(f = {}) {
  let score = 0;
  const tags = [];
  // ① 用户细节补充（最高）
  if (f.hasDetail) { score += VALUE_SCORE.hasDetail; tags.push("用户有细节补充"); }
  // ② 活跃度：越小越活跃（超过 3 天显著低）
  const activeHours = typeof f.activeHours === "number" ? f.activeHours : 24;
  if (Number.isFinite(activeHours)) {
    if (activeHours <= 1) { score += VALUE_SCORE.activeWithin1h; tags.push("非常活跃"); }
    else if (activeHours <= 24) { score += VALUE_SCORE.activeWithin24h; tags.push("近期活跃"); }
    else if (activeHours <= 72) { score += VALUE_SCORE.activeWithin72h; tags.push("数日内活动"); }
    // >72h：活跃度贡献 0
  }
  // ③ 长度（eventCount，对数平滑）
  const eventCount = typeof f.eventCount === "number" ? f.eventCount : 0;
  if (eventCount >= EVENT_COUNT.veryLong) { score += VALUE_SCORE.eventsVeryLong; tags.push("会话很长"); }
  else if (eventCount >= EVENT_COUNT.long) { score += VALUE_SCORE.eventsLong; tags.push("会话较长"); }
  else if (eventCount >= EVENT_COUNT.medium) { score += VALUE_SCORE.eventsMedium; tags.push("中等长度"); }
  else { score += VALUE_SCORE.eventsFew; }
  // ④ 完成度
  const completedCount = typeof f.completedCount === "number" ? Math.min(f.completedCount, COMPLETED_COUNT_CAP) : 0;
  score += completedCount * VALUE_SCORE.perCompleted; // 每完成 1 项加分
  if (completedCount > 0) tags.push(`完成 ${completedCount} 项`);
  // ⑤ 未完成 → 任务清单（承接价值）
  if (f.hasUnfinished) { score += VALUE_SCORE.unfinished; tags.push("有未完成需出任务清单"); }

  const valueLevel = score >= VALUE_CUTOFF.high ? "high" : score <= VALUE_CUTOFF.low ? "low" : (f.hasDetail ? "high" : "low");
  const reason = tags.length ? tags.join("、") : "无显著价值的灰尘会话";
  return { score, value: valueLevel, reason };
}

/**
 * 从会话事件流统计价值特征（纯函数，供 assessValue 输入）。
 * @param {Array} events 会话事件数组（sessionEventsOf(...).events）
 * @param {object} session 会话对象 {id, updatedAt, interruption...}
 * @param {Date} [now] 当前时间
 * @returns {{hasDetail:boolean, activeHours:number, eventCount:number, completedCount:number, hasUnfinished:boolean, updatedAt:number}}
 */
export function buildValueFeatures(events, session, now = new Date()) {
  const evs = Array.isArray(events) ? events : [];
  const eventCount = evs.length;
  // 用户细节补充：用户消息里出现要求细化/补充/改进的字眼
  const detailPat = /补充|细化|加深|更详细|更精确|按.*改|改成|优化|加上|添加|需要.*(步骤|细节)|具体(说|写|列)/;
  let hasDetail = false;
  let hasCompleted = false;
  let hasUnfinished = false;
  const completedAt = [];
  for (let i = evs.length - 1; i >= 0 && (!hasDetail || !hasUnfinished); i--) {
    const ev = evs[i];
    const t = ev?.type;
    const eventData = ev?.data ?? {};
    if (t === EVENT_TYPE_USER_MESSAGE) {
      const text = (Array.isArray(eventData.content) ? eventData.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ") : "") || String(eventData.text || "");
      if (text && detailPat.test(text)) hasDetail = true;
    } else if (t === "assistant/message") {
      const text = (Array.isArray(eventData.message?.content) ? eventData.message.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ") : "") || String(eventData.text || "");
      if (/✅\s*任务完成/.test(text) && /═/.test(text)) hasCompleted = true;
      if (/⚠️\s*未完成|❌\s*未完成/.test(text)) hasUnfinished = true;
      // 统计完成标记数量（多条 completed）
      const matches = text.match(/✅\s*(任务完成|已解答)/g);
      if (matches) completedAt.push(...matches);
    }
  }
  // 未完成：assistant 标记 或 会话 interruption
  if (session?.interruption != null) hasUnfinished = true;
  const updated = typeof session?.updatedAt === "number" ? session.updatedAt : now.getTime();
  const activeHours = Math.max(0, (now.getTime() - updated) / MS_PER_HOUR);
  return {
    hasDetail,
    activeHours,
    eventCount,
    completedCount: completedAt.length,
    hasUnfinished,
    updatedAt: updated,
  };
}

/**
 * 关键词命中判定（用户补充规则）：会话最后用户文本 / 标题 命中任一关键词 → 无条件最高价值。
 * @param {string} title 会话标题
 * @param {string} lastUserText 最后用户消息文本
 * @param {Array<string>} keywords 关键词数组
 * @returns {{hit:boolean, matched:string[]}}
 */
export function keywordMatch(title, lastUserText, keywords) {
  const kws = Array.isArray(keywords) ? keywords.filter((k) => typeof k === "string" && k.trim() !== "") : [];
  if (!kws.length) return { hit: false, matched: [] };
  const hay = `${String(title ?? "")}\n${String(lastUserText ?? "")}`.toLowerCase();
  const matched = kws.filter((k) => hay.includes(k.trim().toLowerCase()));
  return { hit: matched.length > 0, matched };
}

/**
 * 关键词命中 → 高/低价值聚合（关键词命中即无条件 high，其余走 assessValue 特征评分）。
 * @param {Array} sessions 会话对象数组
 * @param {object} textsById 会话 id → 最后 assistant 文本
 * @param {object} userTextsById 会话 id → 最后用户消息文本
 * @param {object} featuresById 会话 id → buildValueFeatures 输出
 * @param {Array} keywords 关键词数组（命中即最高价值）
 * @param {object} [llmById] 可选 LLM 打分
 * @param {Date} now
 * @param {number} staleDays
 * @returns {{completed,unfinished,stale,active, high:[], low:[]}}
 */
export function analyzeValuesWithKeywords(sessions, textsById, userTextsById, featuresById = {}, keywords = [], llmById = {}, now = new Date(), staleDays = 3) {
  const base = analyzeSessionValues(sessions, textsById, userTextsById, now, staleDays);
  const high = [];
  const low = [];
  for (const s of sessions ?? []) {
    const feats = featuresById?.[s.id] || buildValueFeatures(null, s, now);
    const lastText = textsById?.[s.id] ?? "";
    const lastUser = userTextsById?.[s.id] ?? "";
    const { status } = classifySessionValue(s, lastText, now, staleDays);
    // ① 关键词命中 → 无条件最高
    const kw = keywordMatch(s.title, lastUser, keywords);
    let scored;
    if (kw.hit) {
      scored = { value: "high", score: VALUE_SCORE.keywordHit, reason: `命中关键词:${kw.matched.join("、")}`, source: "keyword" };
    } else {
      const llmHit = llmById?.[s.id] || null;
      if (llmHit && llmHit.value) {
        scored = mapValuePriority(status, llmHit.value, llmHit.reason || "");
        scored.score = scored.value === "high" ? VALUE_SCORE.llmHigh : VALUE_SCORE.llmLow;
      } else {
        scored = assessValue(feats);
        // 事件读取失败保护（测试发现）：孤儿/未登记会话在 sessionEventsOf 读不到事件 → eventCount=0，
        // 不能把"读不到事件"误判为"没价值"而误删——宁高不丢，保守保留为 high。
        if (feats && feats.eventCount === 0 && !(feats.activeHours > LONG_STALE_HOURS)) {
          scored = { value: "high", score: VALUE_SCORE.artifactSafe, reason: "事件不可读（孤儿/未登记），保守保留", source: "artifact-safe" };
        }
      }
    }
    const entry = {
      id: s.id, title: s.title ?? null, cwd: s.cwd ?? null,
      updatedAt: s.updatedAt ?? null, archived: s.archived === true,
      value: scored.value, score: scored.score ?? 0, reason: scored.reason || "", source: scored.source || "rule",
    };
    (scored.value === "high" ? high : low).push(entry);
  }
  high.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  low.sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { ...base, high, low };
}

/**
 * 筛选命中关键词的会话（独立筛选，需求"筛选出命中关键词的会话"）。
 * 只看会话标题 + 最后用户消息文本；返回每个命中会话及其命中了哪些关键词。
 * @param {Array} sessions 会话对象数组
 * @param {object} textsById 会话 id → 最后 assistant 文本（用于取标题兜底）
 * @param {object} userTextsById 会话 id → 最后用户消息文本
 * @param {Array<string>} keywords 关键词数组
 * @param {Date} [now]
 * @returns {Array<{id,title,cwd,updatedAt,archived, matchedKeywords:string[]}>}
 */
export function filterSessionsByKeywords(sessions, textsById, userTextsById, keywords, now = new Date()) {
  const kws = Array.isArray(keywords) ? keywords.filter((k) => typeof k === "string" && k.trim() !== "") : [];
  if (!kws.length) return [];
  const out = [];
  for (const s of sessions ?? []) {
    const lastUser = userTextsById?.[s.id] ?? "";
    const kw = keywordMatch(s.title, lastUser, kws);
    if (!kw.hit) continue;
    out.push({
      id: s.id,
      title: s.title ?? null,
      cwd: s.cwd ?? null,
      updatedAt: s.updatedAt ?? null,
      archived: s.archived === true,
      matchedKeywords: kw.matched,
    });
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out;
}
