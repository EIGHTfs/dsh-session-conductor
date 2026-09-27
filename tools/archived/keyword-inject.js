/** ⚠️ 留档文件（2026-09-26）：关键字/行为自动注入功能已移除，本模块**不再被引用**，
 *  保留仅供查阅原实现（功能说明见下方原头注释）。运行时代码（lib/index.js）已删除全部 import/调用。 */
/**
 * dsh-session-conductor — AI 思考/回复关键字自动注入子模块（v1.24.0 新增，）
 *
 * 作用：扫描 AI 思考（reasoning）与回复文本，命中配置的关键字时，把相关内容
 * 自动注入后续回合的系统提示词上下文（让 AI 记住/继续处理该内容）。
 *
 * 配置（插件 domain，设置 → 插件配置 → 「关键字自动注入」卡）：
 *   keywordInject: {
 *     enabled: boolean,          // 总开关
 *     keywords: string[],        // 关键字列表（命中任一即注入）
 *     todoEnabled: boolean,      // v1.25.0：命中时自动更新会话 todo 清单（追加一条 pending todo）
 *     lastInjectedAt,            // 最近注入时间（去重：同关键字 5 分钟内不重复注入）
 *     lastHit: {keyword, sessionId, at}   // 最近命中记录（面板展示）
 *   }
 *
 * 注入机制：systemPrompt.section「keyword-inject-context」（order 950）——
 *   text 用函数动态返回最近一次命中内容，未命中返回空串（section 空文本不占空间）。
 *
 * v1.25.0 todo 联动：命中关键字时，把命中内容摘要追加到当前会话的 todo 清单
 * （DSH 原生 todo 投影，写 'todo/write' 事件，与 todo_write 工具同通道）。
 * 去重：同一会话同一关键字已有 pending todo（content 前缀含「🔑 <关键字>」）时不重复追加。
 *
 * v1.34.0 行为检测（与关键字检测共用同一条管线）：规则条目可带 behavior 字段——
 *   规则 {keyword:'', behavior:'thinking', minChars:1500, action:'inject', context:'…'}
 *   → 回合末 AI 思考（reasoning 块）字符数 ≥ 阈值即命中（不看文本关键字）。
 *   关键字规则（behavior 为空）逻辑完全不变；行为规则与关键字规则混排、同冷却、同注入通道。
 */

import { lastAssistantText } from './value.js'

export const KEYWORD_ACTIONS = ['inject', 'tool'];

// v1.34.0：支持的行为类型（可扩展；每个行为在 matchBehavior 里判定）
export const BEHAVIOR_TYPES = ['thinking'];

// v1.34.0：行为展示名（注入文案与 UI 标签用）
export const BEHAVIOR_LABELS = { thinking: '思考过多' };

// v1.34.0：思考字符数默认阈值（规则未填 minChars 时生效）
export const DEFAULT_MIN_CHARS = 1500;

export const KEYWORD_DEFAULTS = {
  enabled: false,
  keywords: [],
  rules: [], // v1.31.0：[{keyword, action:'inject'|'tool', context, toolName}]
  todoEnabled: false, // v1.25.0 全局开关（兼容旧配置；新 UI 用 tool 动作 + todo_write 工具）
  lastHit: null,
};

/**
 * 把旧 keywords[] 或新 rules[] 收成规则列表。
 * 动作收敛为两种（v1.31.0）：inject（注入上下文）| tool（调用工具）。
 * 旧 action='todo' 兼容映射为 action='tool' + toolName='todo_write'（todo 本质 = 调用 todo_write 工具）。
 */
export function normalizeKeywordRules(conf = {}) {
  const raw = Array.isArray(conf.rules) ? conf.rules : [];
  const out = [];
  const seen = new Set();
  // v1.34.0：规则标识 = 行为规则用 behavior，关键字规则用 keyword（互斥，两者都空则丢弃）
  const add = (keyword, action, context, toolName, behavior, minChars) => {
    const k = String(keyword ?? '').trim();
    const b = BEHAVIOR_TYPES.includes(String(behavior ?? '').trim()) ? String(behavior).trim() : '';
    if (!k && !b) return;
    const key = b ? `behavior:${b}` : `kw:${k}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (action === 'tool') {
      out.push({
        keyword: b ? '' : k,
        behavior: b,
        minChars: b ? positiveInt(minChars, DEFAULT_MIN_CHARS) : 0,
        action: 'tool',
        toolName: toolName === 'todo' ? 'todo_write' : String(toolName ?? ''),
        context: String(context ?? ''),
      });
    } else if (action === 'todo') {
      // 旧 todo 动作 = 调用 todo_write 工具
      out.push({ keyword: b ? '' : k, behavior: b, minChars: b ? positiveInt(minChars, DEFAULT_MIN_CHARS) : 0, action: 'tool', toolName: 'todo_write', context: String(context ?? '') });
    } else {
      out.push({ keyword: b ? '' : k, behavior: b, minChars: b ? positiveInt(minChars, DEFAULT_MIN_CHARS) : 0, action: 'inject', context: String(context ?? '') });
    }
  };
  for (const rule of raw) {
    if (typeof rule === 'string') add(rule, 'inject', '');
    else if (rule && typeof rule === 'object') add(rule.keyword, rule.action, rule.context, rule.toolName, rule.behavior, rule.minChars);
  }
  if (!out.length && Array.isArray(conf.keywords)) {
    for (const k of conf.keywords) add(k, 'inject', '');
  }
  return out;
}

/** v1.34.0：正整数兜底（非法值回落默认）。 */
function positiveInt(v, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function keywordListFromConf(conf = {}) {
  return normalizeKeywordRules(conf).map((r) => r.keyword);
}

const COOLDOWN_MS = 5 * 60 * 1000; // 同关键字 5 分钟冷却

/**
 * 从 events 里提取最近一次 assistant 文本（回复 + 思考），供关键字匹配。
 * 与 lastAssistantText 不同：同时收集 reasoning 块（扫描 AI 思考关键字）。
 */
export function recentAssistantText(events) {
  const { reply, thinking } = extractAssistantTexts(events);
  return reply ? (thinking ? `${reply}\n${thinking}` : reply) : thinking;
}

/**
 * v1.34.0：从 events 提取 { reply, thinking } 两段文本。
 * thinking = 自上一条用户消息以来的 reasoning 块聚合（行为检测用：思考字符数判定）。
 */
export function extractAssistantTexts(events) {
  if (!Array.isArray(events) || events.length === 0) return { reply: '', thinking: '' };
  const reply = lastAssistantText(events) || '';
  let thinking = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const t = ev?.type;
    if (t === "user/message" || t === "user") break;
    if (t === "assistant/chunk") {
      const chunk = ev?.data?.chunk;
      if (chunk && typeof chunk.text === "string" && chunk.blockType === "reasoning") {
        thinking = chunk.text + (thinking ? "\n" + thinking : '');
      }
    }
  }
  return { reply, thinking };
}

/**
 * v1.34.0：判定行为规则是否命中（关键字之外的检测维度）。
 * behavior='thinking'：本回合思考文本字符数 ≥ minChars（默认 DEFAULT_MIN_CHARS）即命中。
 * @returns {{hit: boolean, detail?: string}}
 */
export function matchBehavior(rule, texts) {
  if (!rule || !rule.behavior) return { hit: false };
  if (rule.behavior === 'thinking') {
    const min = positiveInt(rule.minChars, DEFAULT_MIN_CHARS);
    const len = (texts?.thinking || '').length;
    return len >= min ? { hit: true, detail: `思考 ${len} 字符 ≥ 阈值 ${min}` } : { hit: false };
  }
  return { hit: false };
}

/** 匹配文本里的关键字，返回命中列表（去重、按出现顺序）。 */
export function matchKeywords(text, keywords) {
  if (!text || !Array.isArray(keywords) || keywords.length === 0) return [];
  const hits = [];
  const seen = new Set();
  for (const kw of keywords) {
    const k = String(kw ?? '').trim();
    if (!k || seen.has(k)) continue;
    if (text.includes(k)) {
      seen.add(k);
      hits.push(k);
    }
  }
  return hits;
}

/**
 * 生成 todo 条目文本：命中内容摘要（前缀 + 关键字 + 前 N 字）。
 * 与 keywordInjectText 同一套双花括号清洗（todo 文本可能进 systemPrompt？不，todo 只进会话视图，
 * 但清洗无副作用，统一做）。
 */
export function keywordTodoText(keyword, snippet) {
  const s = String(snippet ?? '').trim().replace(/\{\{/g, '{').replace(/\}\}/g, '}').replace(/\s+/g, ' ');
  const brief = s.slice(0, 120);
  return `🔑 关键字「${keyword}」命中：${brief}`;
}

/**
 * v1.25.0：追加 todo 到会话清单（有去重）。
 * @param {object} deps { keyword, snippet, getTodos: () => Array|null, appendTodos: (todos) => void|Promise }
 * @returns {Promise<{added: boolean, reason?: string}>}
 */
export async function appendKeywordTodo({ keyword, snippet, getTodos, appendTodos }) {
  if (!keyword || typeof getTodos !== 'function' || typeof appendTodos !== 'function') {
    return { added: false, reason: 'no-deps' };
  }
  const cur = await getTodos();
  const list = Array.isArray(cur) ? cur.filter((t) => t && typeof t.content === 'string') : [];
  const prefix = `🔑 关键字「${keyword}」`;
  // 去重：已有同关键字 pending/in_progress todo 不再追加
  if (list.some((t) => t.content.startsWith(prefix) && t.status !== 'completed')) {
    return { added: false, reason: 'dup' };
  }
  const next = [...list, { content: keywordTodoText(keyword, snippet), status: 'pending' }];
  await appendTodos(next);
  return { added: true };
}

/**
 * 回合结束后调用：扫描文本 → 命中 → 更新 domain 的 lastHit（供注入 section 读）。
 * @param {object} params { state, domain, sessionId, events, onHit?: (hit)=>void }
 * @returns {Promise<{injected: boolean, keyword?: string, reason?: string}>}
 */
export async function scanAndRecord({ state, domain, sessionId, events, onHit }) {
  const conf = state.keywordInject ?? KEYWORD_DEFAULTS;
  const rules = normalizeKeywordRules(conf);
  if (!conf.enabled || rules.length === 0) {
    return { injected: false, reason: 'disabled' };
  }
  const texts = extractAssistantTexts(events);
  const text = texts.reply ? (texts.thinking ? `${texts.reply}\n${texts.thinking}` : texts.reply) : texts.thinking;

  // v1.34.0：两类规则统一评估——行为规则按 matchBehavior，关键字规则按文本包含。
  // 行为规则优先（用户显式配置的检测维度）；同回合多个命中取第一个。
  let hitRule = null;
  let hitDetail = '';
  for (const r of rules) {
    if (r.behavior) {
      const m = matchBehavior(r, texts);
      if (m.hit) { hitRule = r; hitDetail = m.detail || ''; break; }
    } else if (r.keyword && text.includes(r.keyword)) {
      hitRule = r; break;
    }
  }
  if (!hitRule) return { injected: false, reason: 'no-hit' };

  // 命中标识：行为规则用 behavior:xxx，关键字规则用关键字本身（冷却去重沿用同键语义）
  const keyword = hitRule.behavior ? `behavior:${hitRule.behavior}` : hitRule.keyword;
  const rule = hitRule;
  const now = Date.now();
  const last = conf.lastHit;
  // 冷却：同命中键在冷却期内不重复注入
  if (last && last.keyword === keyword && last.sessionId === sessionId && now - (last.at ?? 0) < COOLDOWN_MS) {
    return { injected: false, reason: 'cooldown' };
  }

  const next = {
    ...state,
    keywordInject: {
      ...conf,
      rules,
      keywords: rules.map((r) => r.keyword),
      lastHit: {
        keyword,
        sessionId,
        at: now,
        snippet: (hitDetail || text).slice(0, 800),
        action: rule.action,
        context: rule.context || '',
        toolName: rule.toolName || '',
      },
    },
  };
  await domain.global.set(next);
  if (typeof onHit === 'function') {
    try { onHit({ keyword, action: rule.action, context: rule.context || '', toolName: rule.toolName || '' }); } catch { /* 回调失败不影响主流程 */ }
  }
  return { injected: true, keyword, action: rule.action, toolName: rule.toolName || '' };
}

/**
 * 生成注入 section 文本：
 *   action=inject → 注入规则里编辑的上下文；
 *   action=tool   → 注入「选中工具 + 备注」提醒（v1.33.0：工具可为空、仅靠备注也行；
 *                    工具与备注都不填则不注入）。
 * todo 旧动作已并入 tool（todo_write），不再单独占位。
 */
export function keywordInjectText(state, sessionId) {
  const conf = state?.keywordInject ?? KEYWORD_DEFAULTS;
  const hit = conf.lastHit;
  if (!conf.enabled || !hit) return '';
  // 只注入当前会话相关的命中（跨会话命中不注入，避免串场）
  if (hit.sessionId && sessionId && hit.sessionId !== sessionId) return '';
  // v1.34.0：行为命中（lastHit.keyword = 'behavior:thinking'）用行为名展示，关键字命中原样
  const isBehavior = typeof hit.keyword === 'string' && hit.keyword.startsWith('behavior:');
  const behaviorKey = isBehavior ? hit.keyword.slice('behavior:'.length) : '';
  const what = isBehavior
    ? `行为「${BEHAVIOR_LABELS[behaviorKey] || behaviorKey}」`
    : `关键字「${hit.keyword}」`;
  const action = hit.action === 'tool' ? 'tool' : 'inject';
  if (action === 'tool') {
    // v1.33.0：提醒完整内容 = 选中工具 + 备注（仅靠备注也行）；工具与备注都不填则不注入。
    // 注意：tool 动作不回退到 snippet（原文），避免「没填备注时把回复原文当注入内容」。
    const toolName = String(hit.toolName || '').trim();
    const note = String(hit.context || '').trim().replace(/\{\{/g, '{').replace(/\}\}/g, '}');
    if (!toolName && !note) return '';
    const parts = [];
    if (toolName) parts.push(`调用工具「${toolName}」`);
    if (note) parts.push(note);
    // v1.34.0：关键字命中保持原固定头「关键字命中提醒」（兼容既有断言），行为命中用「行为命中提醒」
    return `【dsh-session-conductor ${isBehavior ? "行为" : "关键字"}命中提醒】会话 ${hit.sessionId} 命中${what}：${parts.join('：')}。`;
  }
  const body = String(hit.context || hit.snippet || '').replace(/\{\{/g, '{').replace(/\}\}/g, '}');
  if (!body.trim()) return '';
  // 同上：关键字命中保持原固定头「关键字自动注入」
  return `【dsh-session-conductor ${isBehavior ? "行为" : "关键字"}自动注入】会话 ${hit.sessionId} 命中${what}（${new Date(hit.at).toLocaleTimeString()}）：\n\n${body}`;
}
