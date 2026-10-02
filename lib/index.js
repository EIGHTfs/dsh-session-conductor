// dsh-session-conductor —— 会话管理增强插件（宿主半边）。
//
// 提供 /api/session-conductor/* 路由：
//   GET  /api/session-conductor/list                列出全部会话（标题/运行状态/是否归档/是否自动重命名/中断状态/是否自动续跑）
//   POST /api/session-conductor/archive             归档会话（原生 workspaceRegistry.archiveSession）
//   POST /api/session-conductor/unarchive           取消归档（注册表 setState 写回，与原生同一持久化路径）
//   POST /api/session-conductor/delete              删除会话（per-session 串行锁；拒绝运行中/续跑中；
//                                                   detach + 记账清理 + 删磁盘日志 + 清理遗留定时器）
//   POST /api/session-conductor/auto-rename         开启/关闭某会话的「自动重命名」
//   POST /api/session-conductor/analyze             立即分析一次对话主题，必要时自动重命名
//   POST /api/session-conductor/continue            手动续跑一个被中断的会话
//   POST /api/session-conductor/auto-continue       开启/关闭某会话的「自动续跑」（覆盖全局默认）
//   POST /api/session-conductor/scan                立即扫描一遍所有会话并自动续跑可续的
//   POST /api/session-conductor/search               全文搜索（v1.19.0）：跨会话搜消息内容，返回命中会话+上下文片段
//   POST /api/session-conductor/delete-batch         批量删除（v1.19.0）：逐条复用删除链路，运行中跳过不整体失败
//   POST /api/session-conductor/undo-message           撤回最后一条用户消息（v1.22.0）：直接操作会话日志文件，\n//                                                    dryRun 预览 + 二次确认 + .undo-backup 备份
//   POST /api/session-conductor/delete-by-rule       按条件删除（v1.19.0）：归档状态/超期未活跃/cwd 前缀，可 dryRun 预览
//
// 自动重命名：对开启的会话，每次回合结束（turn/end）后延迟触发一次分析——
//   折叠出最近用户消息与当前标题，调用 LLM 判断「对话主题/方向是否已明显偏离标题」；
//   若偏离则生成新标题并通过 sessionTitle.rename() 落盘（source=user，会 pin 住标题，
//   内置的首条消息自动起名不会覆盖它）。带最小间隔与新增消息数门槛，控制 LLM 成本。
//
// 自动续跑：读取会话记录，识别「非人为中断」的回合，自动让 agent 继续执行——
//   中断判定（只看会话最后一条回合边界）：
//     · turn/end reason.kind === "interrupted"        —— DSH 崩溃修复写入的合成闭合（进程被杀/崩溃）
//     · turn/end reason.kind === "error" 且 code ∈ {RATE_LIMIT, SERVER, TIMEOUT, EMPTY_RESPONSE}
//                                                    —— 可重试的基础设施错误
//     · turn/end reason.kind === "aborted"            —— 一律不自动续：真实数据只有 user / disposed
//        （用户手动停止 / 生命周期拆除），都是主动取消；未知 kind 保守处理，留给手动
//     · 末尾是未闭合 turn/start（open turn）          —— 崩溃中断：冷会话视为崩溃残留可自动续；
//        live 会话的 open-turn 是运行中，绝不续（DSH 修复会把 cold 会话改写成 interrupted）
//   续跑机制：live 会话 → 直接 agent.followup(续跑提示)；
//   cold 会话 → ctx.agents.resume()（按会话最近 request/header 的 provider/model + 原 preset 组合）
//   → followup → 等回合结束 → sessions.flush() → handle.dispose() 释放 agent，
//   活跃会话数回到基线，不会堆积。
//   防护：每会话串行锁 + 全局并发闸（maxConcurrent）+ 活跃会话上限（maxAttached，
//   达到后自动续跑暂停、手动仍可用）+ 同会话冷却（cooldownMs）+ 每会话自动续跑总次数上限
//   （maxContinuesPerSession，防「报错→续跑→再报错」死循环）。
//
// 手动释放（置为不活跃）：DSH 没有「关闭/释放会话」的公开入口（会话一旦被 UI 打开
//   就常驻内存，active 数只增不减）——本插件提供 POST /api/session-conductor/detach：
//   把 live 空闲会话的 agent 从注册表拆除 + 释放作用域 + detach 会话，回到冷（持久化）
//   状态；对话日志完整保留，再次打开/发消息会自动重新挂载。顺序复刻 dsh-agent-loop
//   生命周期 dispose：cancel → whenIdle → scope.dispose → detachAgent(含 agent/disposed) →
//   detachSession(触发 session/disposed → 持久化协调器 retire/flush)。
//   守卫：运行中（open turn）拒绝；subagent 拥有的会话拒绝。
//
// ⚠️ 内部实现变通（DSH 0.1.0-rc.6 无公开 unarchive / session-delete / session-detach API）：
//   1. 取消归档：调用 dsh-workspace WorkspaceRegistry 的 state/setState（原型方法，
//      非 # 私有）。setState 与原生 archiveSession 走完全相同的
//      domain.global.set → domain/changed 持久化路径，host-apiproxy 监听到后
//      自动向所有客户端推送 host/archived-sessions-changed 帧，前端无需额外刷新。
//   2. 删除 live 会话：调用 dsh-session SessionStore 内部 store 条目的 detach()
//      （与 agent 拆卸会话同一路径），触发 session/disposed → 前端收 host/session-removed。
//   3. 自动续跑依赖 dsh-agent-loop 的 ctx.agents.resume() / agent.followup() /
//      handle.dispose()（公开 API，参考 dsh-headless 的直驱写法）。
//   4. 手动释放：agent.cancel()/whenIdle() 公开；agent.scope.dispose()、agents.store
//      条目删除 + agents.emitDisposed()、sessions.store 条目 detach() 为内部实现
//      （与 agent-loop 自身 dispose 同一路径，顺序一致）。
//   升级 DSH 版本后需复核这几处是否仍成立。

import { rm, readdir, readFile, mkdir } from "node:fs/promises";
import { readFileSync, copyFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { interruptedTurnClosers } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import Schema from "@deepseek-ai/schemastery";
// 30801 (dsh-v0.1.2-alpha.4)：collectSessionTitleMessages 已改为包内私有函数，不再导出。
// 本地复刻同等逻辑（user/message + source.kind==="user" 的 text 块拼接），避免 import 炸掉整个 plugin tree。
function collectSessionTitleMessages(events, throughSeq) {
  const messages = [];
  for (const event of events ?? []) {
    if (throughSeq !== undefined && event.seq > throughSeq) break;
    if (event?.type !== "user/message" || event?.data?.source?.kind !== "user") continue;
    const content = event.data?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    if (normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0) continue;
    messages.push({ seq: event.seq, text });
  }
  return messages;
}

// 30801：hasApiRemoteSubagentOwner 已从 @deepseek-ai/dsh-api-remotes 移除。
// 等价判定：header.origin==="subagent"，或 parent live agent 拥有该 child（agents.isOwnedBy）。
function hasApiRemoteSubagentOwner(ctx, session, agent) {
  const header = session?.header ?? session;
  if (header?.origin === "subagent") return true;
  const parentId = header?.parentSession;
  if (!parentId || !agent) return false;
  try {
    const agents = ctx.get?.("agents") ?? ctx.agents;
    const parent = agents?.get?.(parentId);
    return Boolean(parent && agents?.isOwnedBy?.(agent.id, parent));
  } catch {
    return false;
  }
}

// 30801：resolveSessionPreset 已从 @deepseek-ai/dsh-agent-presets 移除。
// 读 header.agentPreset，再被后续 agent-preset/selected 事件覆盖（与 agentPreset projection 一致）。
function resolveSessionPreset({ header, events } = {}) {
  let presetId = header?.agentPreset ?? null;
  for (const event of events ?? []) {
    if (event?.type === "agent-preset/selected" && event.data?.agentPreset != null) {
      presetId = event.data.agentPreset;
    }
  }
  return presetId;
}
import { renderCompletionBlock, checkCompletionText, VALID_STATUSES } from "./core.js";

// —— 懒加载（v1.38.0，加快 DSH 启动）：repair/价值分析等「非启动路径」模块改为动态 import——
//    首次实际调用（undo/repair/value-analysis/deleteByRule lowValue）才加载，启动只 import 轻依赖；
//    import() 结果缓存（??=），首次加载后复用，无重复加载成本。
let _lazyRepair = null, _lazyZstd = null, _lazySeqGap = null, _lazyEio = null, _lazyValue = null;
const lazyRepair = () => (_lazyRepair ??= import("./repair.js"));
const lazyZstd = () => (_lazyZstd ??= import("./zstd-frames.js"));
const lazySeqGap = () => (_lazySeqGap ??= import("./seq-gap-repair.js"));
const lazyEio = () => (_lazyEio ??= import("./eio-repair.js"));
const lazyValue = () => (_lazyValue ??= import("./value.js"));
import { registerGroupRoutes } from "./group.js";
import { saveTemplate, saveTemplateFromUrl, saveTemplateFromPath, listTemplateDir, removeTemplate, readTemplateSync, collectTemplateSlotText, TEMPLATE_DEFAULTS, TEMPLATE_SLOTS, TEMPLATE_MAX_BYTES, PLAN_ENFORCE_EDIT_TOOLS, PLAN_ENFORCE_BASH_WRITE_RE, planGateAllows, planEnforceDenyMessage } from "./template-inject.js";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "dsh-session-conductor";

// ---------- 自动重命名参数 ----------
const AUTO_RENAME_MIN_TOTAL_MESSAGES = 3; // 至少多少条用户消息才开始分析
const AUTO_RENAME_MIN_NEW_MESSAGES = 3; // 距上次分析至少新增多少条才再分析
const AUTO_RENAME_MIN_INTERVAL_MS = 5 * 60 * 1000; // 同会话分析最小间隔
const AUTO_RENAME_DEBOUNCE_MS = 8000; // 回合结束后延迟，等日志落定
const AUTO_RENAME_RECENT = 12; // 参与判断的最近用户消息数
const AUTO_RENAME_TIMEOUT_MS = 45 * 1000; // 单次 LLM 分析超时
const AUTO_RENAME_MAX_CONCURRENT = 2; // 全局并发分析上限
const AUTO_RENAME_TITLE_MAX_BYTES = 80; // 新标题字节上限

// 标题状态后缀（自动重命名把会话状态写进标题）
const TITLE_STATE_RUNNING = "（运行中）";
const TITLE_STATE_INTERRUPTED = "（已中断）";
const TITLE_STATE_SUFFIX_RE = /（(运行中|已中断)）$/;

// ---------- 自动续跑参数（可用 patch config 覆盖） ----------
const AUTO_CONTINUE_RETRYABLE_CODES = new Set(["RATE_LIMIT", "SERVER", "TIMEOUT", "EMPTY_RESPONSE"]);
const AUTO_CONTINUE_HUMAN_ABORT_KINDS = new Set(["user", "goal", "parent", "disposed"]);
const AUTO_CONTINUE_DEBOUNCE_MS = 5000; // turn/end 事件后的防抖
const AUTO_CONTINUE_SCAN_DELAY_MS = 15000; // 插件启动后首扫延迟（等持久化就绪）
const DEFAULTS = {
  enabled: true, // 自动续跑总开关
  defaultAutoContinue: false, // 单会话默认关闭（v1.35.3 起默认关，面板可逐会话显式开启）
  failRetryDelayMs: 30000, // 本轮运行失败识别后延迟续跑（默认 30s，避免立即重试）
  maxConcurrent: 2, // 全局同时续跑的会话数上限
  maxAttached: 12, // 活跃（attached）会话上限，达到后自动续跑暂停
  listInspectBatch: 2, // v1.35.10：会话列表「冷会话 inspect」并发上限（防一次性并发全量会话把内存打爆）
  listCacheMs: 5000, // v1.35.10：会话列表结果缓存时长（毫秒）——合并同一瞬间的多次 list 请求，避免重复全量扫描
  cooldownMs: 15 * 60 * 1000, // 同会话两次自动续跑最小间隔
  maxContinuesPerSession: 3, // 每会话自动续跑总次数上限（防死循环）
  turnTimeoutMs: 20 * 60 * 1000, // 单回合续跑最长等待，超时取消
  scanIntervalMs: 5 * 60 * 1000, // 周期扫描间隔
};

function num(v, min, max, dflt) {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt;
}

/** 插件自身的持久化域：自动重命名/自动续跑开关 + 记账，存于 <DSH_HOME>/storages/dsh-session-conductor.json。
 *  版本保持 1：autoContinue 是纯增量字段（带 default），旧域文件可无损加载。 */
const pluginDomainSpec = defineDomain({
  name: "dsh_session_conductor",
  version: 1,
  global: {
    schema: z.object({
      autoRename: z.record(z.string(), z.object({
        enabled: z.boolean(),
        lastAnalysisSeq: z.number().int().nonnegative().optional(),
        lastAnalysisAt: z.number().nonnegative().optional()
      })).default({}),
      autoContinue: z.record(z.string(), z.object({
        enabled: z.boolean().optional(), // 缺省 = 跟随全局默认 defaultAutoContinue
        lastContinuedSeq: z.number().int().nonnegative().optional(),
        lastContinuedAt: z.number().nonnegative().optional(),
        continueCount: z.number().int().nonnegative().optional()
      })).default({}),
      // ⚠️ 2026-09-27：自动续跑开关与记账已移至 <DSH_HOME>/session-conductor/config.json
      //   （用户流程：控制开关 → 写 config.json → 自动续跑读 config.json；启动时 apply 自动全关）。
      //   上方 autoContinue 字段保留仅为兼容旧域文件（旧数据不再读写，配置以 config.json 为准）。
      // 压缩模型选择（2026-08-20）：会话模型旁单独选压缩用模型。
      // 取值：{provider, model} 或 null=跟随会话模型。写入后由部署层注入 compaction-basic。
      compactionModel: z.object({
        provider: z.string(),
        model: z.string()
      }).nullable().optional(),
      // 自动重命名模型选择（v1.36.0）：设置页「DSH 同款解析选择器」选定的模型。
      // 取值：{provider, model} 或 null=跟随会话模型（默认）。优先级：
      //   UI 选择 > patch 配置（autoRenameProvider/Model）> 会话 request/header。
      autoRenameModel: z.object({
        provider: z.string(),
        model: z.string()
      }).nullable().optional(),
      // 自动续跑全局闸门（2026-08-20，与 guardian 联动）：
      //   closed → 一切自动续跑跳过（周期扫描/面板 scan 的自动续跑部分均不续）；
      //   open   → 恢复原有判定。DSH 刚启动 guardian 置 closed（防崩溃恢复后自动续跑
      //   批量建空壳会话）；用户手动开启（API/面板）或检测到「用户第一次手动对话」
      //   （turn/start 由 user 发起）后自动置 open。
      autoContinueGate: z.enum(["open", "closed"]).default("open"),
      // 额外 md 注入（v1.24.0）：设置卡上传的 md 清单（内容落盘 <DSH_HOME>/extra-inject-md/）
      extraMdFiles: z.array(z.object({
        id: z.string(),
        name: z.string(),
        addedAt: z.number().optional()
      })).default([]),
      // 会话模板注入（v1.31.0）：plan（方案模板）/ closing（收尾模板）两个固定槽位
      // 元信息存 domain，内容落盘 <DSH_HOME>/template-inject-md/<slot>.md
      sessionTemplates: z.object({
        plan: z.object({
          enabled: z.boolean().default(false),
          enforce: z.boolean().default(false), // v1.35.0 强制门禁：未出提案+未确认前拒绝改码工具
          name: z.string().default(""),
          url: z.string().default(""),
          bytes: z.number().default(0),
          updatedAt: z.number().default(0)
        }).default({ enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 }),
        closing: z.object({
          enabled: z.boolean().default(false),
          enforce: z.boolean().default(false),
          name: z.string().default(""),
          url: z.string().default(""),
          bytes: z.number().default(0),
          updatedAt: z.number().default(0)
        }).default({ enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 })
      }).default({ plan: { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 }, closing: { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 } })
    }),
    initial: {
      autoRename: {},
      autoContinue: {},
      compactionModel: null,
      autoRenameModel: null,
      autoContinueGate: "open",
      extraMdFiles: [],
      sessionTemplates: {
        plan: { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 },
        closing: { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 }
      }
    },
  },
  tables: {}
});

// ---------- 基础工具 ----------

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 读取 JSON 请求体（POST 必须带 Content-Type: application/json）。 */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}


/** 折叠出最近一次持久化标题（session/title 事件）。 */
function foldTitle(events) {
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "session/title" && typeof event.data?.title === "string") {
      return event.data.title;
    }
  }
  return undefined;
}

// ---------- 归档标题工作区前缀（v1.20.0 ） ----------
// 归档时给标题加「[工作区名] 」前缀（数据层真实带前缀），面板显示剥离，已归档视图按前缀分组。
const ARCHIVE_WS_PREFIX_RE = /^\[([^\]]+)\]\s*/;

/** 从会话 cwd 推导工作区名：优先匹配 workspaceRegistry 分组 title，否则取 cwd basename。 */
function workspaceNameOf(ctx, cwd) {
  if (typeof cwd !== "string" || cwd === "") return "";
  const registry = ctx?.get?.("workspaceRegistry");
  if (registry) {
    try {
      for (const workspace of registry.list?.() ?? []) {
        const path = String(workspace?.path ?? "").replace(/\/+$/, "");
        const c = String(cwd).replace(/\/+$/, "");
        if (path !== "" && (c === path || c.startsWith(path + "/"))) {
          if (typeof workspace.title === "string" && workspace.title.trim() !== "") return workspace.title.trim();
        }
      }
    } catch {
      // 分组服务不可用时回退 basename
    }
  }
  return String(cwd).split(/[/\\]/).filter(Boolean).pop() ?? "";
}

/** 给标题加工作区前缀（幂等：已带前缀不叠加）。返回 {title, ws}。 */
function archiveTitleWithWs(title, ws) {
  const t = String(title ?? "");
  const stripped = t.replace(ARCHIVE_WS_PREFIX_RE, "");
  const name = String(ws ?? "").trim();
  if (name === "" || stripped === "") return { title: t, ws: name };
  return { title: `[${name}] ${stripped}`, ws: name };
}

/** 剥离工作区前缀，返回 {title(无前缀), ws(前缀工作区名或空)}。 */
function stripArchiveWsPrefix(title) {
  const t = String(title ?? "");
  const m = t.match(ARCHIVE_WS_PREFIX_RE);
  if (!m) return { title: t, ws: "" };
  return { title: t.slice(m[0].length), ws: m[1] };
}

/** 最后一个 turn 边界是 turn/start（未闭合）→ 视为会话运行中。 */
function hasOpenTurn(events) {
  if (!Array.isArray(events)) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type;
    if (type === "turn/end") return false;
    if (type === "turn/start") return true;
  }
  return false;
}

/** 事件流的最后时间戳（ms），无则 undefined。 */
function lastEventTime(events) {
  const last = events?.at(-1);
  return typeof last?.time === "number" ? last.time : undefined;
}

/**
 * 归一化标题为字符串：sessionTitle 服务返回的是标题快照对象
 * （{title, source, eventSeq, ...}），面板只需要其中的 title 字符串。
 */
function titleString(snapshot) {
  if (typeof snapshot === "string") return snapshot;
  if (snapshot !== null && typeof snapshot === "object" && typeof snapshot.title === "string") return snapshot.title;
  return undefined;
}

/** 30801 live Session 的 events 可能不是数组，优先 snapshotEvents()。 */
function sessionEventList(session) {
  if (Array.isArray(session?.events)) return session.events;
  try {
    const snap = session?.snapshotEvents?.();
    if (Array.isArray(snap)) return snap;
  } catch {
    // 非 Session 对象
  }
  return [];
}

/** 30801 sessionTitle.get() 只接受真正的 Session（内部调 snapshotEvents）。cold 假对象会抛，不能用来取标题。 */
function resolveSessionTitle(sessionTitle, session, events) {
  if (sessionTitle && session && typeof session.snapshotEvents === "function") {
    try {
      const title = titleString(sessionTitle.get(session));
      if (title) return title;
    } catch {
      // 非 live Session 或 get() 签名变化
    }
  }
  return foldTitle(events) ?? null;
}

// ---------- 插件持久化域（自动重命名开关） ----------

let domainPromise = null;
/** 域当前是否「已打开且尚未关闭」。
 *  v1.35.9：用于判断重载时能否复用缓存——只凭 domainPromise 是否为 null 判断不了
 *  「域是活的还是已被关掉」，这正是「domain already open / domain is closed」两类 500 的根源。 */
let domainLive = false;

function pluginDomain(ctx) {
  if (domainPromise === null) {
    const storage = ctx.get("storageDomain");
    if (!storage) return Promise.reject(new Error("storageDomain 不可用"));
    domainPromise = storage.open(pluginDomainSpec).then((domain) => {
      domainLive = true;
      // 只在 apply 的活跃 fiber 上挂 close；HTTP handler / 事件回调 fiber 是 inactive，
      // ctx.effect 会抛 cannot create effect on inactive context，且 rejected Promise 被缓存后 list 一直 500。
      try {
        ctx.effect(() => () => {
          // v1.35.9：关闭的同时把缓存与存活标记一起清掉——下一次 apply 才会重新 open。
          // 【原代码】只 return domain.close()（缓存不清），靠 apply 开头无条件 domainPromise = null 兜，
          //   遇到「域还活着就重载」时会在旧的活域上再 open 一次 → storage 报 already open → list 500。
          domainLive = false;
          domainPromise = null;
          return domain.close();
        }, "session-conductor: domain close");
      } catch {
        /* 请求路径打开时不挂 effect；apply() 已预热并挂过 */
      }
      return domain;
    }).catch((err) => {
      domainPromise = null;
      domainLive = false;
      throw err;
    });
  }
  return domainPromise;
}

async function pluginState(ctx) {
  const domain = await pluginDomain(ctx);
  return domain.global.get();
}

/** 进程级异常兜底（v1.35.6，幂等）。
 *  背景：宿主 bin.ts 没有注册 unhandledRejection/uncaughtException，Node 15+ 对未处理的
 *  promise rejection 默认 `throw` → **整个 DSH 进程退出**。自动续跑是长链异步（resume 会话、
 *  等回合、写账），任何一处 rejection 逃逸都会表现为「续跑能用，但 DSH 跑一会就死」。
 *  这里注册兜底 handler：记录日志后**不退出进程**，让宿主与其它插件继续工作；同时把错误
 *  写进插件日志便于后续定位。重复 apply（热重载）不会重复注册。
 */
let processGuardsInstalled = false;
function installProcessGuards(ctx) {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  try {
    process.on("unhandledRejection", (reason) => {
      try {
        log(ctx, `⚠️ 捕获未处理的 Promise rejection（已阻止进程退出）: ${String(reason?.stack ?? reason?.message ?? reason)}`);
      } catch {
        /* 日志自身失败也不能再抛 */
      }
    });
  } catch {
    /* 某些宿主环境（沙箱/受限 worker）可能不允许注册，忽略 */
  }
}

// ---------- 插件开关配置（2026-09-27：落盘 <DSH_HOME>/session-conductor/config.json）----------
// 自动重命名（autoRename）与自动续跑（autoContinue）两组逐会话开关统一存放，
// 「改→写→读」走同一公共函数：
//   · 面板/API 控制 → patchSwitch(ctx, group, sessionId, patch) 改缓存 + 原子落盘 config.json
//   · 功能执行（重命名/续跑判定）→ readSwitch(group, sessionId) 读缓存
//   · 启动时 loadPluginConfig 载入文件；自动续跑额外规则：每次 DSH 启动（apply）
//     自动把所有 autoContinue 开关复位为关闭（resetAutoContinueOnStart），
//     之后用户面板逐会话决定；autoRename 不复位（保持用户设置）。
const switchGroups = { autoRename: new Map(), autoContinue: new Map() };

function pluginConfigPath(ctx) {
  const home = resolveDshHome(ctx, cfg);
  return home ? path.join(home, "session-conductor", "config.json") : "";
}

/** 读某组（autoRename/autoContinue）某会话的开关/记账（内存缓存；无记录返回 null）。 */
function readSwitch(group, sessionId) {
  const map = switchGroups[group];
  return map?.get(sessionId) ?? null;
}

/** 改→写：更新缓存并原子落盘 config.json，返回更新后 entry。
 *  group ∈ "autoRename" | "autoContinue"；defaultEntry 为该组无记录时的基线。 */
export async function patchSwitch(ctx, group, sessionId, patch, defaultEntry = {}) {
  const map = switchGroups[group];
  if (!map) throw new Error(`未知开关组 ${group}`);
  const cur = map.get(sessionId) ?? defaultEntry;
  const next = { ...cur, ...patch };
  map.set(sessionId, next);
  await savePluginConfig(ctx);
  return next;
}

/** 从 config.json 载入两组开关到内存缓存（启动时/测试）。文件缺失或损坏 → 空配置。 */
export async function loadPluginConfig(ctx) {
  const file = pluginConfigPath(ctx);
  const parsed = {};
  if (file) {
    try {
      const j = JSON.parse(await readFile(file, "utf8"));
      if (j && typeof j === "object") Object.assign(parsed, j);
    } catch { /* 文件不存在/损坏 → 空配置 */ }
  }
  for (const group of Object.keys(switchGroups)) {
    const src = parsed[group] && typeof parsed[group] === "object" ? parsed[group] : {};
    switchGroups[group].clear();
    for (const [sid, e] of Object.entries(src)) if (e && typeof e === "object") switchGroups[group].set(sid, { ...e });
  }
}

/** 原子落盘 config.json（临时文件 + rename；保留未知顶层字段）。 */
export async function savePluginConfig(ctx) {
  const file = pluginConfigPath(ctx);
  if (!file) return;
  let rest = {};
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    if (j && typeof j === "object") rest = j;
  } catch { /* 文件不存在/损坏 → 全量写 */ }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({
    ...rest,
    autoRename: Object.fromEntries(switchGroups.autoRename),
    autoContinue: Object.fromEntries(switchGroups.autoContinue),
  }, null, 2), "utf8");
  renameSync(tmp, file);
}

/** 启动复位：自动续跑开关全部置 false（每次 DSH 启动默认关闭；autoRename 不复位）。幂等。 */
export async function resetAutoContinueOnStart(ctx) {
  await loadPluginConfig(ctx);
  let anyOn = false;
  for (const e of switchGroups.autoContinue.values()) if (e?.enabled === true) { anyOn = true; break; }
  if (!anyOn) return;
  for (const [sid, e] of switchGroups.autoContinue) switchGroups.autoContinue.set(sid, { ...e, enabled: false });
  await savePluginConfig(ctx);
  log(ctx, "🔒 启动复位：自动续跑开关已全部关闭（面板可逐会话开启）");
}

/** 会话的自动重命名是否开启（读 config 缓存；兼容旧签名，state 忽略）。 */
function autoRenameEnabled(ctx, state, sessionId) {
  return readSwitch("autoRename", sessionId)?.enabled === true;
}

/** 自动续跑是否生效：面板显式开关优先（读 config），否则跟随全局默认 defaultAutoContinue。 */
function effectiveAutoContinue(cfg, state, sessionId) {
  const entry = readSwitch("autoContinue", sessionId);
  return entry?.enabled ?? cfg.defaultAutoContinue;
}

// ---------- 自动重命名分析引擎 ----------

const pendingTimers = new Map();
let activeAnalyses = 0;

/** 回合结束后延迟调度一次分析（同会话防抖）。 */
function scheduleAnalysis(ctx, sessionId) {
  const existing = pendingTimers.get(sessionId);
  if (existing !== void 0) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(sessionId);
    runAnalysis(ctx, sessionId).catch((error) => {
      log(ctx, `自动重命名分析失败 ${sessionId}: ${String(error?.message ?? error)}`);
    });
  }, AUTO_RENAME_DEBOUNCE_MS);
  timer.unref?.();
  pendingTimers.set(sessionId, timer);
}

/** 带并发闸的分析入口。opts.model 给定 → 本次分析临时用该模型（不持久化）。 */
async function runAnalysis(ctx, sessionId, opts = {}) {
  while (activeAnalyses >= AUTO_RENAME_MAX_CONCURRENT) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  activeAnalyses += 1;
  try {
    return await analyzeSession(ctx, sessionId, opts);
  } finally {
    activeAnalyses -= 1;
  }
}

/**
 * 解析单次模型覆盖参数：支持 "provider/model" 或纯模型名（自动从官方
 * modelCatalog 匹配 provider；匹配不到则借用当前路由的 provider）。
 * @returns {provider, model} 或 null（无法解析）
 */
export async function resolveModelOverride(ctx, modelArg, fallbackRoute) {
  const raw = String(modelArg ?? "").trim();
  if (!raw) return null;
  // "provider/model" 显式拆分；不匹配（含纯模型名）→ 走 catalog 匹配/fallback
  const explicit = /^([^/]+)\/(.+)$/.exec(raw);
  if (explicit) {
    const provider = explicit[1].trim();
    const model = explicit[2].trim();
    if (provider && model) return { provider, model };
  }
  // 纯模型名：modelCatalog 里找第一个含该 model 的分组
  try {
    const sc = ctx.get("sessionController");
    const catalog = sc?.modelCatalog ? await sc.modelCatalog() : null;
    const groups = catalog?.groups ?? [];
    for (const g of groups) {
      if ((g.models ?? []).some((m) => m.id === raw || m.name === raw)) {
        return { provider: g.id, model: raw };
      }
    }
  } catch {
    // catalog 不可用 → 落到 fallback provider
  }
  if (fallbackRoute?.provider) return { provider: fallbackRoute.provider, model: raw };
  return null;
}

/**
 * 分析一个会话：若已开启自动重命名，判断主题是否偏离当前标题，必要时重命名。
 * opts.model 给定 → 本次分析临时用该模型（不持久化，优先级最高）。
 * opts.manual 给定（手动 API）→ 跳过限频/新消息数/总消息数门槛（显式意图即执行）；
 *   自动触发（user/message、turn/end）不传 manual，仍受门槛保护。
 * 返回 {ok, renamed, title?, before, after, reason?} 供 API 与自动触发共用。
 */
async function analyzeSession(ctx, sessionId, opts = {}) {
  const sessions = ctx.get("sessions");
  const titleService = ctx.get("sessionTitle");
  const llm = ctx.get("llm");
  const session = sessions?.get(sessionId);
  if (!session || !titleService || !llm) {
    return { ok: false, error: { code: "unavailable", message: "sessions / sessionTitle / llm 服务不可用" } };
  }

  const state = await pluginState(ctx);
  if (!autoRenameEnabled(ctx, state, sessionId)) {
    return { ok: false, error: { code: "not-enabled", message: "该会话未开启自动重命名" } };
  }

  const setting = readSwitch("autoRename", sessionId) ?? {};
  const now = Date.now();
  // 手动 API（opts.manual）跳过自动门槛；自动触发受限频 + 消息数门槛保护（防每条消息都烧 LLM）
  if (!opts?.manual) {
    if (setting.lastAnalysisAt !== void 0 && now - setting.lastAnalysisAt < AUTO_RENAME_MIN_INTERVAL_MS) {
      return { ok: false, error: { code: "rate-limited", message: "距上次分析不足最小间隔，稍后再试" } };
    }
  }

  // ⚠️ v3 会话无 events 属性：用 sessionEventList()（snapshotEvents fallback）取事件
  const messages = collectSessionTitleMessages(sessionEventList(session));
  if (!opts?.manual) {
    if (messages.length < AUTO_RENAME_MIN_TOTAL_MESSAGES) {
      return { ok: false, error: { code: "too-few-messages", message: "对话消息太少，暂不分析" } };
    }
    const newMessages = setting.lastAnalysisSeq === void 0 ? messages : messages.filter((m) => m.seq > setting.lastAnalysisSeq);
    if (newMessages.length < AUTO_RENAME_MIN_NEW_MESSAGES) {
      return { ok: false, error: { code: "too-few-new", message: `距上次分析仅 ${newMessages.length} 条新消息，暂不分析` } };
    }
  }
  const lastSeq = messages.at(-1)?.seq;

  // 当前标题快照：fallback（首句截断兜底）质量差 → 强制 LLM 生成精炼标题替换；
  // user/provider 标题尊重（不强制）
  const snapshot = titleService.get(session);
  const currentTitle = titleString(snapshot) ?? null;
  const isFallbackTitle = snapshot?.source?.kind === "fallback";
  const recent = messages.slice(-AUTO_RENAME_RECENT);
  let route = resolveRoute(session, llm, state);
  // 单次模型覆盖（手动 API 传入 model）：优先级最高，不持久化
  if (opts?.model) {
    const override = await resolveModelOverride(ctx, opts.model, route);
    if (override?.provider && override?.model) route = override;
  }
  if (!route) {
    return { ok: false, before: currentTitle, after: currentTitle, error: { code: "no-route", message: "无法确定模型路由（会话无 request/header 且无可用模型）" } };
  }

  // 记账先行：无论结果如何都推进游标，避免反复分析同一批消息
  await patchSwitch(ctx, "autoRename", sessionId, { lastAnalysisSeq: lastSeq, lastAnalysisAt: now }, { enabled: false });

  const decision = await driftAnalysisLlm(llm, session, route, currentTitle, recent, (message) => log(ctx, message), isFallbackTitle);
  if (decision.kind === "error") {
    return { ok: false, before: currentTitle, after: currentTitle, error: { code: "llm-failed", message: decision.message } };
  }
  if (decision.kind === "unchanged") {
    return { ok: true, renamed: false, before: currentTitle, after: currentTitle, reason: "LLM 判断对话主题未明显偏离当前标题" };
  }

  const title = normalizeSessionTitle(decision.title.trim(), AUTO_RENAME_TITLE_MAX_BYTES);
  if (title === "" || title === stripTitleStateSuffix(currentTitle)) {
    return { ok: true, renamed: false, before: currentTitle, after: currentTitle, reason: "LLM 判断对话主题未明显偏离当前标题" };
  }

  // 主题标题由 LLM 生成；状态后缀由状态机维护（随回合开始/结束实时刷新）
  const suffix = cfg.titleStateSuffix === false ? "" : stateSuffixOf(session.events);
  const finalTitle = `${title}${suffix}`;
  try {
    titleService.rename(session, finalTitle);
  } catch (error) {
    return { ok: false, before: currentTitle, after: currentTitle, error: { code: "rename-failed", message: String(error?.message ?? error) } };
  }
  log(ctx, `自动重命名 ${sessionId}: "${currentTitle ?? "（无标题）"}" → "${finalTitle}"`);
  return { ok: true, renamed: true, before: currentTitle, after: finalTitle, title: finalTitle, reason: "对话主题明显偏移，已自动重命名" };
}

/** 会话最后 request/header 的模型路由；没有则退回可用模型列表。 */
/** 自动重命名/价值分析的模型路由，三级优先级（高→低）：
 *  ① 设置页选择的模型（state.autoRenameModel，传 state 时生效）
 *  ② patch 配置 autoRenameProvider+Model（成对）
 *  ③ 会话 request/header 的对话模型 */
export function resolveRoute(session, llm, state) {
  const picked = state?.autoRenameModel ?? null;
  if (picked?.provider && picked?.model) {
    return { provider: picked.provider, model: picked.model };
  }
  if (cfg.autoRenameProvider && cfg.autoRenameModel) {
    return { provider: cfg.autoRenameProvider, model: cfg.autoRenameModel };
  }
  const config = session.requestHeader?.()?.config;
  if (config?.provider && config?.model) return { provider: config.provider, model: config.model };
  return null;
}

/**
 * 用 LLM 判断主题是否偏移。返回判别结果：
 *   {kind:"changed", title} | {kind:"unchanged"} | {kind:"error", message}
 * onError 可选日志。
 */
/**
 * 用 LLM 判断主题是否偏移 / 强制生成标题。返回判别结果：
 *   {kind:"changed", title} | {kind:"unchanged"} | {kind:"error", message}
 * forceTitle=true（当前标题是 fallback 截断兜底）：不判断偏离，直接要求 LLM
 * 生成精炼好标题（{title} JSON），替换质量差的截断标题。
 * ⚠️ LLM 输出无法解析 / 无有效标题 → {kind:"error"}（不再静默当 unchanged，
 *   让调用方/用户看到「模型不可用或输出异常」，而不是误以为主题未偏离）。
 * onError 可选日志。
 */
export async function driftAnalysisLlm(llm, session, route, currentTitle, recent, onError, forceTitle = false) {
  const system = forceTitle ? [
    "你是 DSH（DeepSeek Harness）会话标题分析师。",
    "当前标题是系统从首条消息截断生成的临时标题（不完整、质量差）。",
    "请直接根据最近消息内容给出一个简洁精炼的好标题，使用对话的语言（中文约 10 字 / 英文约 5 词），简洁不解释。",
    "输出严格 JSON，不要任何其他文字、解释、Markdown 或代码块标记：",
    '{"title": "新标题"}'
  ].join("\n") : [
    "你是 DSH（DeepSeek Harness）会话标题分析师。",
    "会话有一个标题；当对话的主题或方向已明显偏离该标题时，应提出一个更贴切的新标题。",
    "判断依据是最近的消息内容；只有明显偏离时才改名，否则保持原样。",
    "标题使用对话的语言（中文约 10 字 / 英文约 5 词），简洁不解释。",
    "输出严格 JSON，不要任何其他文字、解释、Markdown 或代码块标记：",
    '{"changed": true, "title": "新标题"}  或  {"changed": false}'
  ].join("\n");
  const text = [
    `当前标题：${currentTitle ?? "（无标题）"}`,
    "最近对话（用户消息数组，按时间顺序）：",
    JSON.stringify(recent.map((message) => message.text))
  ].join("\n");

  const options = {
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor" }
    })],
    system,
    maxTokens: 200,
    sessionId: session.id,
    purpose: "session-conductor-auto-rename",
    signal: AbortSignal.timeout(AUTO_RENAME_TIMEOUT_MS)
  };

  try {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream(options)) assembler.push(chunk);
    const blocks = assembler.blocks();
    const raw = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
    if (forceTitle) {
      // 强制生成模式：只要 {title: "..."}，不判断偏离
      const t = extractTitleOnly(raw);
      if (t === null) return { kind: "error", message: "LLM 未给出有效标题（模型不可用或输出异常）" };
      return { kind: "changed", title: t };
    }
    const parsed = parseDriftJson(raw);
    if (parsed === null) return { kind: "error", message: "LLM 输出无法解析为 JSON（模型不可用或输出异常）" };
    if (parsed.changed && typeof parsed.title === "string" && parsed.title.trim() !== "") {
      return { kind: "changed", title: parsed.title };
    }
    return { kind: "unchanged" };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (typeof onError === "function") onError(`自动重命名 LLM 调用失败 ${session.id}: ${message}`);
    return { kind: "error", message };
  }
}

/** 提取 `{"title": "..."}` 中的标题（forceTitle 模式专用；无 title 返回 null）。 */
function extractTitleOnly(raw) {
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
 * 会话价值 LLM 判断（待办 #2，v1.20.0）：
 * 批量对会话用 LLM 判定「高/低价值」，返回 会话id → {value, reason}。
 * fail-soft：LLM 服务不可用 / 路由缺失 / 超时 / 非法 JSON 的会话跳过（规则判定兜底），不阻塞。
 * 价值定义：会话是否值得保留——高价值（有独有信息/未完成任务/学习/资产）+ 低价值（灰尘/重复/可丢弃）。
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


/** 解析 LLM 输出的严格 JSON（容忍代码块围栏）。 */
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

// ---------- 自动续跑引擎 ----------

/**
 * 分析一个会话的事件流，返回「非人为中断」判定（只看最后一条回合边界）：
 *   null —— 无需续跑（正常完成 / blocked / max-tokens / 非可重试错误 / 用户取消）
 *   {kind:"interrupted"|"error"|"aborted"|"open-turn", seq, code?, message?}
 */
export function interruptionInfo(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "turn/end") {
      const reason = event.data?.reason;
      if (reason === null || typeof reason !== "object") return null;
      if (reason.kind === "interrupted") {
        return { kind: "interrupted", seq: event.seq, message: "回合因进程/会话中断而未完成（崩溃修复）" };
      }
      if (reason.kind === "error") {
        const code = typeof reason.error?.code === "string" ? reason.error.code : "UNKNOWN";
        // v1.35.3：识别「本轮运行失败」——任意 error 都视为可续跑的中断（不再限 4 个可重试码）。
        // 防死循环由 continueAllowed（冷却/次数/并发上限）兜底；不可重试错误仍可被识别，留给续跑尝试。
        return {
          kind: "error",
          code,
          seq: event.seq,
          message: `请求错误 ${code}${typeof reason.error?.message === "string" ? `：${reason.error.message}` : ""}`
        };
      }
      if (reason.kind === "aborted") {
        const abortKind = reason.reason?.kind;
        if (typeof abortKind === "string" && AUTO_CONTINUE_HUMAN_ABORT_KINDS.has(abortKind)) return null; // 用户/目标主动取消
        return {
          kind: "aborted",
          code: typeof abortKind === "string" ? abortKind : String(reason.reason),
          seq: event.seq,
          message: "回合被系统原因中断"
        };
      }
      return null; // completed / blocked / max-tokens / 其他
    }
    if (event?.type === "turn/start") {
      // 末尾是未闭合回合：live 会话 = 正在运行；cold 会话通常已被 DSH 修复成 interrupted
      return { kind: "open-turn", seq: event.seq, message: "回合未正常结束（open turn）" };
    }
  }
  return null;
}

/**
 * 自动续跑资格判定。
 * @param info - interruptionInfo 的结果。
 * @param options.live - 会话是否 live（内存中、可能正在运行）。
 *   只有冷会话的 open-turn 才视为崩溃残留可续跑；live 会话的 open-turn 是运行中，绝不续。
 * 规则：
 *   · interrupted（崩溃修复合成闭合）→ 可续
 *   · error（本轮运行失败，任意 code；v1.35.3 起不再限可重试集）→ 可续
 *   · open-turn：冷会话 → 可续（崩溃残留）；live → 不可续（运行中）
 *   · aborted → 一律不可续（真实数据只有 user / disposed 两种：人为停止或生命周期
 *     拆除——都是"主动取消"，不该自动续跑；未知 kind 也按保守处理，留给手动）
 */
export function isAutoEligible(info, { live = false } = {}) {
  if (!info) return false;
  if (info.kind === "interrupted") return true;
  if (info.kind === "error") return true; // 本轮运行失败：任意 error 都可续（上限/冷却兜底）
  if (info.kind === "open-turn") return !live; // 冷会话 = 崩溃残留；live = 运行中
  return false; // aborted 及其他：不自动续（主动取消/未知），可手动续
}

/**
 * 依据会话事件流判定标题应附加的状态后缀（live 视角）：
 *   open turn（未闭合回合）= 运行中；interrupted/error/冷 open-turn = 已中断；
 *   正常完成 / 用户取消 = 无后缀。
 */
export function stateSuffixOf(events) {
  if (hasOpenTurn(events)) return TITLE_STATE_RUNNING;
  const info = interruptionInfo(events);
  if (info && info.kind !== "aborted") return TITLE_STATE_INTERRUPTED;
  return "";
}

/** 去掉标题尾部的状态后缀（用于更新后缀或与 LLM 主题标题比较）。 */
export function stripTitleStateSuffix(title) {
  return String(title ?? "").replace(TITLE_STATE_SUFFIX_RE, "");
}

/**
 * 刷新标题的状态后缀（仅自动重命名会话，且 cfg.titleStateSuffix 开启）。
 * 状态变化（turn/start → 运行中；turn/end → 空闲/已中断）时把标题改成
 * 「主题 + 状态后缀」，后缀与主题分离，LLM 只负责主题、后缀由状态机维护。
 * @returns 新的完整标题；无需变化或失败返回 null。
 */
export async function refreshTitleState(ctx, session) {
  if (!session?.id || cfg.titleStateSuffix === false) return null;
  const state = await pluginState(ctx);
  if (!autoRenameEnabled(ctx, state, session.id)) return null;
  const titleService = ctx.get("sessionTitle");
  if (!titleService) return null;
  const current = titleString(titleService.get(session));
  if (!current) return null;
  const suffix = stateSuffixOf(session.events);
  const next = `${stripTitleStateSuffix(current)}${suffix}`;
  if (next === current) return null;
  try {
    titleService.rename(session, next);
    return next;
  } catch (error) {
    log(ctx, `标题状态刷新失败 ${session.id}: ${String(error?.message ?? error)}`);
    return null;
  }
}

// （开关统一配置见上方 switchGroups 公共模块；effectiveAutoContinue 已在其中定义，
//   下方仅保留运行判定组合层。）

// ---------- 自动续跑运行判定 ----------

/**
 * 运行期自动续跑判定：跟随会话开关（与面板开关展示一致），仅用于「运行路径」（续跑/扫描）。
 * 2026-08-20 新增：全局闸门 autoContinueGate === "closed" 时**一切自动续跑跳过**
 * ——与 guardian 联动，防崩溃恢复后自动续跑批量建空壳。
 * （2026-09-26 错峰定时任务移除，原「窗口内强制开启」分支已删。）
 */
export function autoContinueEffectiveForRun(cfg, state, sessionId) {
  if (state?.autoContinueGate === "closed") return false;
  return effectiveAutoContinue(cfg, state, sessionId);
}

/** 自动续跑门槛：已续过 / 冷却中 / 总次数超限 → 拒绝。 */
function continueAllowed(cfg, state, sessionId, info) {
  const entry = readSwitch("autoContinue", sessionId) ?? {};
  if (entry.lastContinuedSeq !== void 0 && entry.lastContinuedSeq >= info.seq) {
    return { ok: false, reason: "already-continued" };
  }
  const now = Date.now();
  if (entry.lastContinuedAt !== void 0 && now - entry.lastContinuedAt < cfg.cooldownMs) {
    return { ok: false, reason: "cooldown" };
  }
  if ((entry.continueCount ?? 0) >= cfg.maxContinuesPerSession) {
    return { ok: false, reason: "max-total" };
  }
  return { ok: true };
}

/** 读取一个会话的事件流（live 用内存快照，cold 用官方 handle 读法）。 */
async function sessionEventsOf(ctx, sessionId) {
  const sessions = ctx.get("sessions");
  const live = sessions?.get(sessionId);
  if (live) return { live, events: sessionEventList(live), meta: live.header };
  try {
    return await readColdSessionEvents(ctx, sessionId);
  } catch {
    // 损坏/不可读 → 返回 null，调用方跳过不中断整体
    return null;
  }
}

/**
 * 读一个冷（已持久化）会话的完整事件流（官方 0.1.6 标准读法）：
 * persistence.open(id, "read") → handle.read(0) → close。
 * ⚠️ 0.1.6-alpha.1 起 persistence.inspect 已失效（返回空），冷会话标题/搜索内容
 *    全靠本函数；与 session-query 的 readColdSessionLog 同一姿势，并补中断闭合器。
 * 读取失败**向上抛**（buildSessionList 用它带出 inspectError）；仅「无 open 能力」返回 null。
 * @returns {{events:Array, meta:object|null}}
 */
async function readColdSessionEvents(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  if (!persistence?.open) return null;
  const handle = await persistence.open(sessionId, "read");
  let events = [];
  try {
    const read = await handle.read(0, undefined);
    events = read?.events ?? [];
  } finally {
    try { await handle.close(); } catch { /* 读失败时 close 失败无妨 */ }
  }
  // 崩溃残留的开放回合补合成闭合器（与官方 cold-read 一致，列表中断判定需要）
  return { events: [...events, ...interruptedTurnClosers(events)], meta: handle?.header ?? null };
}

/** 折叠会话最近一次 request/header 的模型路由（provider/model），无则 null。 */
export function foldLastRoute(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "request/header") {
      const config = event.data?.header?.config;
      if (config && typeof config.provider === "string" && typeof config.model === "string") {
        return { provider: config.provider, model: config.model };
      }
    }
    if (event?.type === "request/context") {
      const data = event.data;
      if (data && typeof data.provider === "string" && typeof data.model === "string") {
        return { provider: data.provider, model: data.model };
      }
    }
  }
  return null;
}

/** 续跑提示（不同中断原因给不同上下文提示）。 */
export function buildContinuePrompt(info) {
  const base = "这是一条由插件自动发出的「续跑」指令，不是用户的新问题。";
  switch (info?.kind) {
    case "interrupted":
      return `${base}\n检测到此会话此前的回合因进程/会话中断而未完成。请回顾你当时正在进行的任务，检查已完成与未完成的部分，然后继续完成它。若任务实际上已经完成，请直接说明完成情况，不要重复执行。`;
    case "error":
      return `${base}\n检测到此会话此前的回合因可重试的请求错误中断（${info.code ?? "未知"}）。请回顾你当时正在进行的任务，继续完成它。若任务实际上已经完成，请直接说明完成情况，不要重复执行。`;
    case "aborted":
      return `${base}\n检测到此会话此前的回合被系统原因中断（${info.code ?? "未知"}）。请回顾你当时正在进行的任务，继续完成它。若任务实际上已经完成，请直接说明完成情况，不要重复执行。`;
    case "open-turn":
      return `${base}\n检测到此会话此前的回合未正常结束。请回顾你当时正在进行的任务，继续完成它。若任务实际上已经完成，请直接说明完成情况，不要重复执行。`;
    default:
      return `${base}\n请回顾你正在进行的任务并继续完成它；若已全部完成，请直接说明完成情况。`;
  }
}

// 续跑调度状态
const continueTimers = new Map(); // 防抖定时器
const continueLocks = new Map(); // 每会话串行锁
const continueJobs = new Map(); // 进行中的续跑（UI 状态用）
const deleteLocks = new Map(); // 每会话删除锁（删除是破坏性操作，同会话删除请求排队串行）
let activeContinues = 0;
let scanTimer = null;

/** 每会话删除锁：同一会话的删除请求排队串行执行（并发删除不交错）。 */
function withDeleteLock(sessionId, fn) {
  const prev = deleteLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, () => fn());
  const guard = run
    .catch(() => void 0)
    .finally(() => {
      if (deleteLocks.get(sessionId) === guard) deleteLocks.delete(sessionId);
    });
  deleteLocks.set(sessionId, guard);
  return run;
}

/** 取消某会话遗留的防抖定时器与续跑记账（删除时调用，避免删除后定时器再触发）。 */
function cancelSessionTimers(sessionId) {
  const ct = continueTimers.get(sessionId);
  if (ct !== void 0) {
    clearTimeout(ct);
    continueTimers.delete(sessionId);
  }
  const pt = pendingTimers.get(sessionId);
  if (pt !== void 0) {
    clearTimeout(pt);
    pendingTimers.delete(sessionId);
  }
  if (continueJobs.has(sessionId)) continueJobs.delete(sessionId);
}

/** 每会话串行锁：同一会话的续跑排队执行。 */
function withSessionLock(sessionId, fn) {
  const prev = continueLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, () => fn());
  const guard = run
    .catch(() => void 0)
    .finally(() => {
      if (continueLocks.get(sessionId) === guard) continueLocks.delete(sessionId);
    });
  continueLocks.set(sessionId, guard);
  return run;
}

/** 全局并发闸。 */
async function withConcurrencyGate(fn) {
  while (activeContinues >= cfg.maxConcurrent) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  activeContinues += 1;
  try {
    return await fn();
  } finally {
    activeContinues -= 1;
  }
}

/** 续跑一个会话（手动与自动共用；导出供单测）。
 *   - 串行锁 → 读事件流 → 中断判定 → （自动）门槛/活跃上限 → 执行 → 记账
 *   - live 会话：直接 followup 现有 agent，不接管生命周期
 *   - cold 会话：agents.resume()（原模型路由 + 原 preset 组合）→ followup →
 *     等回合结束 → flush → dispose() 释放 agent，活跃数回落
 * 返回 {ok, accepted?} 或 {ok:false, error:{code,message}}。
 */
export async function continueSession(ctx, sessionId, { auto = false } = {}) {
  // v1.35.6：整个回调包 try——prepare 段（读事件/判定/门槛）原先在 try 外，
  // 任一 throw（事件流畸形/域读写异常）→ withSessionLock 的 run reject →
  // 手动续跑 .then() 无 catch → unhandledRejection → Node 15+ 默认直接杀整进程。
  // 现统一归入结果对象，永不 reject（进程级兜底见 apply 的 unhandledRejection 钩子）。
  return withSessionLock(sessionId, async () => {
    // 变量在 try 外声明：prepare 段用 try 兜异常，执行段仍要访问（块级作用域否则 ReferenceError）
    let agents;
    let sessions;
    let found;
    let info;
    let liveAgent;
    try {
      agents = ctx.get("agents");
      sessions = ctx.get("sessions");

      found = await sessionEventsOf(ctx, sessionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "会话不存在或不可读" } };

      // live 且末尾未闭合 → 正在运行，不能续
      if (found.live && hasOpenTurn(found.events)) {
        return { ok: false, error: { code: "running", message: "会话正在运行中，无法续跑" } };
      }

      info = interruptionInfo(found.events);
      if (!info) {
        return { ok: false, error: { code: "not-interrupted", message: "会话最后一次回合已正常结束，无需续跑" } };
      }
      if (auto && !isAutoEligible(info, { live: !!found.live })) {
        return { ok: false, error: { code: "not-auto-eligible", message: "该中断类型不自动续跑（用户取消/目标暂停/生命周期拆除等），请手动续跑" } };
      }

      // live 会话必须有 agent 才能 followup
      liveAgent = found.live ? agents?.get(sessionId) : void 0;
      if (found.live && !liveAgent) {
        return { ok: false, error: { code: "no-agent", message: "会话已挂载但没有可用 agent，无法续跑" } };
      }
      if (liveAgent?.status === "running") {
        return { ok: false, error: { code: "busy", message: "agent 正在运行中，无法续跑" } };
      }

      // 自动续跑的门槛与活跃上限（手动不受限，用户自己决定）
      if (auto) {
        const state = await pluginState(ctx);
        if (!autoContinueEffectiveForRun(cfg, state, sessionId)) {
          return { ok: false, error: { code: "disabled", message: "该会话未开启自动续跑" } };
        }
        const gate = continueAllowed(cfg, state, sessionId, info);
        if (!gate.ok) {
          return { ok: false, error: { code: `continue-${gate.reason}`, message: `自动续跑被门槛拦下（${gate.reason}）` } };
        }
        const attached = agents?.list?.().length ?? 0;
        if (attached >= cfg.maxAttached) {
          return { ok: false, error: { code: "attached-cap", message: `活跃会话已达上限 ${cfg.maxAttached}，暂停自动续跑（可手动续跑）` } };
        }
      }
    } catch (error) {
      // prepare 段异常统一兜底：不进执行段，直接返回失败（保证 withSessionLock 永不 reject）
      return { ok: false, error: { code: "continue-prepare-failed", message: String(error?.message ?? error) } };
    }

    const prompt = buildContinuePrompt(info);
    continueJobs.set(sessionId, Date.now());
    try {
      await withConcurrencyGate(async () => {
        if (liveAgent) {
          liveAgent.followup(createUserMessage({
            content: [{ type: "text", text: prompt }],
            source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor" }
          }));
          await waitTurn(ctx, liveAgent);
          return;
        }

        // cold 会话 → resume + followup + flush + dispose
        const route = foldLastRoute(found.events) ?? defaultModelSelection(ctx);
        if (!route?.provider || !route.model) {
          throw new Error("无法确定模型路由（会话无 request/header 且无默认模型）");
        }
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: route.provider, model: route.model },
          setup: await resumeSetupFor(ctx, found.meta, found.events, route),
        });
        const agent = handle?.agent;
        if (!agent) throw new Error("agents.resume 未返回 agent 句柄");
        try {
          await agent.whenIdle();
          agent.followup(createUserMessage({
            content: [{ type: "text", text: prompt }],
            source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor" }
          }));
          await waitTurn(ctx, agent);
          await sessions.flush?.(agent.session);
        } finally {
          // 释放 agent，活跃会话数回到基线（避免自动续跑堆积）
          await handle.dispose();
        }
      });

      // 记账：推进 lastContinuedSeq 等，防重复续跑（2026-09-27 起落盘 config.json，重启保留）
      const entry = readSwitch("autoContinue", sessionId) ?? {};
      await patchSwitch(ctx, "autoContinue", sessionId, {
        lastContinuedSeq: info.seq,
        lastContinuedAt: Date.now(),
        continueCount: (entry.continueCount ?? 0) + 1,
      });
      log(ctx, `已续跑会话 ${sessionId}（${info.kind}${info.code ? `/${info.code}` : ""}）`);
      return { ok: true, accepted: true, info };
    } catch (error) {
      const message = String(error?.message ?? error);
      log(ctx, `续跑会话 ${sessionId} 失败: ${message}`);
      return { ok: false, error: { code: "continue-failed", message } };
    } finally {
      continueJobs.delete(sessionId);
    }
  });
}

/** 等待 agent 回合结束；超时则取消回合（结果按中断记录，不再自动续）。 */
async function waitTurn(ctx, agent) {
  const idle = agent.whenIdle();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        agent.cancel({ kind: "timeout" }, { keepInbox: false });
      } catch {
        // 忽略：agent 可能已 idle
      }
      reject(new Error(`续跑回合超过 ${Math.round(cfg.turnTimeoutMs / 60000)} 分钟未结束，已取消`));
    }, cfg.turnTimeoutMs);
  });
  timer?.unref?.();
  try {
    await Promise.race([idle, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跨会话消息投递（2026-08-20 新增，权威实现）。
 * 向目标会话投递一条用户消息并唤起它——与 continue 同机制但**不受"中断"限制**：
 *   - live 会话：agent.followup(createUserMessage) 直接投递
 *   - cold 会话：agents.resume() → followup → 等回合 → flush → dispose
 * 适用于「会话A → 会话B 直接沟通」（协作/交接/评审），不依赖用户转发文件。
 * @param {object} ctx DSH 上下文
 * @param {string} sessionId 目标会话
 * @param {string} text 消息文本
 * @param {object} [opts] { fromSessionId? }
 * @returns {Promise<{ok:boolean, mode:'live'|'cold'|null, accepted?:boolean, error?:{code:string,message:string}}>}
 */
export async function sendMessageToSession(ctx, sessionId, text, { fromSessionId = "" } = {}) {
  if (!sessionId || !text) return { ok: false, error: { code: "bad-request", message: "缺少 sessionId 或 message" } };
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const found = await sessionEventsOf(ctx, sessionId);
  if (!found) return { ok: false, error: { code: "not-found", message: "会话不存在或不可读" } };

  const content = [{ type: "text", text: String(text) }];
  const source = {
    kind: "plugin:dsh-session-conductor",
    plugin: "dsh-session-conductor",
    ...(fromSessionId ? { fromSessionId } : {}),
  };
  const message = createUserMessage({ content, source });

  // live 会话：直接 followup（不接管生命周期）
  const liveAgent = found.live ? agents?.get(sessionId) : void 0;
  if (liveAgent) {
    if (liveAgent.status === "running") {
      return { ok: false, error: { code: "busy", message: "目标会话正在运行中，消息已排队，回合结束后送达" } };
    }
    liveAgent.followup(message);
    return { ok: true, mode: "live", accepted: true };
  }

  // cold 会话：resume → followup → 等回合 → flush → dispose
  const route = foldLastRoute(found.events) ?? defaultModelSelection(ctx);
  if (!route?.provider || !route.model) {
    return { ok: false, error: { code: "no-route", message: "无法确定目标会话模型路由" } };
  }
  try {
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: route.provider, model: route.model },
      setup: await resumeSetupFor(ctx, found.meta, found.events, route),
    });
    const agent = handle?.agent;
    if (!agent) throw new Error("agents.resume 未返回 agent 句柄");
    try {
      await agent.whenIdle();
      agent.followup(message);
      await waitTurn(ctx, agent);
      await sessions.flush?.(agent.session);
    } finally {
      await handle.dispose();
    }
    return { ok: true, mode: "cold", accepted: true };
  } catch (error) {
    const msg = String(error?.message ?? error);
    log(ctx, `跨会话消息投递失败 ${sessionId}: ${msg}`);
    return { ok: false, error: { code: "message-failed", message: msg } };
  }
}

/** 默认模型选择（无会话路由时兜底）。 */
function defaultModelSelection(ctx) {
  try {
    const current = ctx.get("agentDefaultModel")?.currentSelection?.();
    if (current?.provider && current.model) return { provider: current.provider, model: current.model };
  } catch {
    // 服务缺失时返回 null
  }
  return null;
}

/** resume 的 setup：安装模型选择（优先会话最近路由）+ 挂载原 preset 组合（工具等）。 */
async function resumeSetupFor(ctx, meta, events, route) {
  let presetId = null;
  try {
    const presets = ctx.get("agentPresets");
    if (presets) presetId = resolveSessionPreset({ header: meta, events });
  } catch {
    // 无 preset 服务或解析失败：不挂载 preset，仅装模型选择
  }
  return async (agentCtx) => {
    try {
      installModelSelection(agentCtx, {
        current: {
          provider: route.provider,
          model: route.model,
        },
        assembled: void 0,
      });
    } catch (error) {
      log(ctx, `installModelSelection 失败: ${String(error?.message ?? error)}`);
    }
    if (presetId) {
      try {
        await ctx.get("agentPresets").mount(agentCtx, presetId);
      } catch (error) {
        log(ctx, `preset mount 失败 ${presetId}: ${String(error?.message ?? error)}`);
      }
    }
  };
}

/** 回合结束事件 → 若符合自动续跑条件则延迟触发（与自动重命名共用监听入口）。 */
function maybeScheduleContinue(ctx, sessionId) {
  if (!cfg.enabled) return;
  const existing = continueTimers.get(sessionId);
  if (existing !== void 0) clearTimeout(existing);
  const timer = setTimeout(() => {
    continueTimers.delete(sessionId);
    runAutoContinueSession(ctx, sessionId).catch((error) => {
      log(ctx, `自动续跑调度失败 ${sessionId}: ${String(error?.message ?? error)}`);
    });
  }, AUTO_CONTINUE_DEBOUNCE_MS);
  timer.unref?.();
  continueTimers.set(sessionId, timer);
}

/** 自动续跑一个会话（内部：读事件 → 判定 → 门槛 → 执行）。
 *  v1.35.6：整体包 try/catch——判定段任一 throw 不再向调用方逃逸（防 unhandledRejection 杀进程）。
 *  另加 force 参数：面板刚打开自动续跑开关时立即续跑，跳过失败重试延迟（用户体感"处理久"的根因
 *  是开开关后要等最多 scanIntervalMs 才续；现开开关即触发）。
 */
async function runAutoContinueSession(ctx, sessionId, { force = false } = {}) {
  try {
    if (!cfg.enabled) return;
    const state = await pluginState(ctx);
    if (!autoContinueEffectiveForRun(cfg, state, sessionId)) return;
    const found = await sessionEventsOf(ctx, sessionId);
    if (!found) return;
    if (found.live && hasOpenTurn(found.events)) return; // 正在运行
    const info = interruptionInfo(found.events);
    if (!info || !isAutoEligible(info, { live: !!found.live })) return;
    if (!continueAllowed(cfg, state, sessionId, info).ok) return;
    // v1.35.3：本轮运行失败（error）识别后延迟 failRetryDelayMs 再续跑（默认 30s），
    // 避免失败后立即重试；interrupted/open-turn（崩溃残留）不延迟。手动续跑不受影响。
    // v1.35.6：force（用户刚打开开关触发的首次续跑）跳过延迟——用户主动开启不该再等 30s。
    if (!force && info.kind === "error" && cfg.failRetryDelayMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, cfg.failRetryDelayMs);
        timer.unref?.();
      });
    }
    await continueSession(ctx, sessionId, { auto: true });
  } catch (error) {
    log(ctx, `自动续跑 ${sessionId} 异常: ${String(error?.message ?? error)}`);
  }
}

/** 周期扫描：对所有开启自动续跑的会话检查中断并续跑（受活跃上限预算约束）。 */
async function runAutoScan(ctx) {
  if (!cfg.enabled) return;
  const persistence = ctx.get("sessionPersistence");
  const sessionsSvc = ctx.get("sessions");
  if (!persistence?.list || !persistence?.open) return;

  const state = await pluginState(ctx);
  const archived = new Set(ctx.get("workspaceRegistry")?.archivedSessionIds ?? []);
  const liveIds = new Set((sessionsSvc?.list() ?? []).map((s) => s.id));
  const attached = ctx.get("agents")?.list?.().length ?? 0;
  let budget = Math.max(0, cfg.maxAttached - attached);
  if (budget <= 0) {
    log(ctx, `自动续跑扫描暂停：活跃会话已达 ${attached}/${cfg.maxAttached}`);
    return;
  }

  let metas = [];
  try {
    metas = await persistence.list();
  } catch (error) {
    log(ctx, `自动续跑扫描读会话列表失败: ${String(error?.message ?? error)}`);
    return;
  }

  let queued = 0;
  for (const meta of metas) {
    if (budget <= 0) break;
    if (liveIds.has(meta.id)) continue; // live 会话由 turn/end 事件触发
    if (archived.has(meta.id)) continue; // 归档会话不自动续跑
    if (!autoContinueEffectiveForRun(cfg, state, meta.id)) continue;
    let events = null;
    try {
      events = (await readColdSessionEvents(ctx, meta.id))?.events ?? null;
    } catch {
      continue; // 损坏/不可读，跳过
    }
    const info = interruptionInfo(events);
    if (!info || !isAutoEligible(info, { live: false })) continue; // 扫描只处理冷会话
    if (!continueAllowed(cfg, state, meta.id, info).ok) continue;
    budget -= 1;
    queued += 1;
    runAutoContinueSession(ctx, meta.id).catch((error) => {
      log(ctx, `自动续跑 ${meta.id} 失败: ${String(error?.message ?? error)}`);
    });
  }
  if (queued > 0) log(ctx, `自动续跑扫描：本轮排队 ${queued} 个会话`);
}

function scheduleScan(ctx) {
  if (scanTimer !== null) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    runAutoScan(ctx).catch((error) => {
      log(ctx, `自动续跑扫描失败: ${String(error?.message ?? error)}`);
    });
    scheduleScan(ctx); // 常驻周期扫描
  }, cfg.scanIntervalMs);
  scanTimer.unref?.();
}

// ---------- 手动释放（置为不活跃） ----------

/**
 * 把 live 空闲会话的 agent 拆下、释放作用域、detach 会话，回到冷（持久化）状态。
 * 顺序复刻 dsh-agent-loop 生命周期 dispose：cancel → whenIdle → scope.dispose →
 * 注册表移除 + agent/disposed → session flush + detach（session/disposed → 持久化 retire）。
 * 日志完整保留；再次打开/发消息时 DSH 会从持久化自动重新挂载。
 * 守卫：运行中（open turn）拒绝；subagent 拥有的会话拒绝；非 live 幂等返回。
 * 返回 {ok} 或 {ok:false, error:{code,message}}。
 */
export async function detachSessionAgent(ctx, sessionId) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const session = sessions?.get(sessionId);
  if (!session) {
    return { ok: false, error: { code: "not-live", message: "会话不在活跃（live）状态，无需释放" } };
  }

  const agent = agents?.get(sessionId);
  if (agent && hasApiRemoteSubagentOwner(ctx, session, agent)) {
    return { ok: false, error: { code: "subagent-owned", message: "该会话属于子代理（subagent）路由，不能手动释放" } };
  }
  if (agent?.status === "running" || hasOpenTurn(session.events)) {
    return { ok: false, error: { code: "running", message: "会话正在运行中，无法释放（请先停止）" } };
  }

  // 1. 停止机器（idle 时为 no-op；keepInbox 保留排队中的消息，不丢弃）+ 等它安静
  if (agent) {
    try {
      agent.cancel({ kind: "disposed" }, { keepInbox: true });
    } catch {
      // agent 可能已不可用，继续往下拆
    }
    try {
      await agent.whenIdle?.();
    } catch {
      // 忽略
    }
  }

  // 2. 释放 agent 作用域 fiber（卸载其注册的 effect：preset 工具、监听器等）
  if (agent?.scope?.dispose) {
    try {
      await agent.scope.dispose();
    } catch (error) {
      log(ctx, `释放 ${sessionId} 作用域失败（继续拆卸）: ${String(error?.message ?? error)}`);
    }
  }

  // 3. 从 agents 注册表移除并广播 agent/disposed（复刻 detachEntered）
  const entry = agents?.store?.get(sessionId);
  if (entry) {
    agents.store.delete(sessionId);
    if (entry.announced) {
      try {
        agents.emitDisposed(entry);
      } catch (error) {
        log(ctx, `agent/disposed 广播失败 ${sessionId}: ${String(error?.message ?? error)}`);
      }
    }
  }

  // 4. 先 flush 保证日志落盘，再 detach 会话 → session/disposed → 持久化协调器 retire
  try {
    await sessions.flush?.(session);
  } catch (error) {
    log(ctx, `释放 ${sessionId} flush 失败（继续 detach）: ${String(error?.message ?? error)}`);
  }
  try {
    sessions?.store?.get(sessionId)?.detach?.();
  } catch (error) {
    return { ok: false, error: { code: "detach-failed", message: String(error?.message ?? error) } };
  }

  log(ctx, `已释放（置为不活跃）会话 ${sessionId}`);
  return { ok: true };
}

/** 释放全部 live 空闲会话（跳过运行中/subagent/续跑中），返回 {ok, released, skipped}。 */
export async function detachAllIdleSessions(ctx) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const released = [];
  const skipped = [];
  for (const session of sessions?.list() ?? []) {
    const id = session.id;
    if (hasOpenTurn(session.events)) {
      skipped.push({ id, reason: "running" });
      continue;
    }
    const agent = agents?.get(id);
    if (agent && hasApiRemoteSubagentOwner(ctx, session, agent)) {
      skipped.push({ id, reason: "subagent" });
      continue;
    }
    if (continueJobs.has(id)) {
      skipped.push({ id, reason: "continue-in-flight" });
      continue;
    }
    const result = await detachSessionAgent(ctx, id);
    if (result.ok) released.push(id);
    else skipped.push({ id, reason: result.error?.code ?? "failed" });
  }
  return { ok: true, released, skipped };
}

// ---------- 会话列表派生数据落盘缓存（v1.35.10：持久化 + 懒加载）----------
/**
 * 会话列表里只有三个字段必须由**事件流**推导：title（标题）、updatedAt（最后活动）、
 * interruption（中断状态）。而读冷会话事件流走官方 handle 读法
 * （persistence.open('read') → handle.read(0) → close，0.1.6 起 inspect 已失效）——
 * 整份日志解码进内存，
 * 且宿主 coordinator 会把这次 prepared 结果保留做有界复用：**每扫一遍列表 = 把全量会话重新拉进
 * 内存一次**（本机 130 会话 / 253MB 库，实测一次 /list 让 RSS 从 1.0GB 冲到 1.9GB，
 * 逼近 --max-old-space-size=2048 上限，即 v1.35.10 修的那个堆 OOM）。
 *
 * 做法（持久性保存 + 懒加载，内存优先于速度）：
 *   ① 用 persistence.listSnapshots() 拿每个会话的 header + revision（**只读 header 行 + 一次 stat，
 *      不解析日志**），revision 是「该会话日志内容是否变过」的变更令牌；
 *   ② 把上面三个字段连同 revision 落盘到 <DSH_HOME>/storages/dsh-session-conductor/list-cache.json；
 *   ③ 下次列列表时 **revision 没变就直接用落盘结果，一次 inspect 都不做**（懒加载核心）；
 *      只有新会话、或日志真的追加过（revision 变了）才重新解析那一条；
 *   ④ 首次运行（无缓存）需要把现有会话解析一遍（用户接受「慢一点」），解析完落盘，
 *      此后每次启动都是「读缓存 → 秒回」，且进程不再因为拉全量会话而堆爆。
 * 缓存文件随 DSH_HOME 走（resolveDshHome），不写死本机路径；损坏/版本不符按空缓存处理，绝不抛。
 */
const LIST_CACHE_VERSION = 1;
const LIST_CACHE_SUBDIR = ["storages", "dsh-session-conductor"];
let listDiskCache = null; // { version, entries: { [id]: { rev, title, updatedAt, interruption, inspectError } } }
let listDiskCachePath = null;
let listDiskCacheDirty = false;
let listDiskCacheTimer = null;

/** 缓存文件绝对路径（首次调用时解析并缓存）。 */
function listCacheFilePath(ctx) {
  if (listDiskCachePath !== null) return listDiskCachePath;
  const home = resolveDshHome(ctx, cfg);
  listDiskCachePath = home ? path.join(home, ...LIST_CACHE_SUBDIR, "list-cache.json") : "";
  return listDiskCachePath;
}

/** 读落盘缓存（进程内只读一次）。任何异常都退化成空缓存，不向上抛。 */
function loadListDiskCache(ctx) {
  if (listDiskCache !== null) return listDiskCache;
  listDiskCache = { version: LIST_CACHE_VERSION, entries: {} };
  const file = listCacheFilePath(ctx);
  if (!file) return listDiskCache;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version === LIST_CACHE_VERSION && parsed.entries !== null && typeof parsed.entries === "object") {
      listDiskCache = { version: LIST_CACHE_VERSION, entries: parsed.entries };
    }
  } catch {
    // 首次运行（文件不存在）/ 文件损坏 / JSON 非法：按空缓存继续，本次解析完会覆盖写入
  }
  return listDiskCache;
}

/** 标记脏并节流落盘（2s 合并，避免每解析一条会话就写一次盘）。 */
function scheduleSaveListDiskCache(ctx) {
  listDiskCacheDirty = true;
  if (listDiskCacheTimer !== null) return;
  listDiskCacheTimer = setTimeout(() => {
    listDiskCacheTimer = null;
    saveListDiskCacheNow(ctx);
  }, 2000);
  listDiskCacheTimer.unref?.();
}

/** 立即原子落盘（写临时文件再 rename，避免下次启动读到半个文件）。 */
function saveListDiskCacheNow(ctx) {
  if (!listDiskCacheDirty || listDiskCache === null) return;
  const file = listCacheFilePath(ctx);
  if (!file) return;
  listDiskCacheDirty = false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(listDiskCache), "utf8");
    renameSync(tmp, file);
  } catch (error) {
    // 落盘失败只是让下次重新解析，不影响列表功能；记录下来便于诊断
    log(ctx, `会话列表缓存落盘失败（不影响功能）: ${String(error?.message ?? error)}`);
  }
}

/** 由「header 级信息 + 派生字段（可能来自缓存）」组装一条冷会话列表项。
 *  抽出来是为了让「缓存命中」与「刚刚解析完」两条路径产出**完全一致**的结构。 */
function buildColdSessionItem(header, inspected, derived, ctx, storeState, archived) {
  const title = derived.title ?? null;
  // 【原代码】cwd: inspected.cwd ?? meta.cwd ?? null、createdAt: inspected.createdAt ?? meta.createdAt、
  // parentSession: inspected.parentSession ?? meta.parentSession ?? null —— 即「inspect 回的 header 优先，
  // persistence.list 的 header 兜底」。缓存命中时 inspected 用缓存里存的同名字段（见下方解析段），
  // 保证「走缓存」与「刚解析完」两条路径产出完全一致的结构。
  return {
    id: header.id,
    title,
    archiveWs: archived.has(header.id) ? stripArchiveWsPrefix(title ?? "").ws : "",
    cwd: inspected.cwd ?? header.cwd ?? null,
    createdAt: inspected.createdAt ?? header.createdAt,
    updatedAt: derived.updatedAt ?? inspected.createdAt ?? header.createdAt,
    live: false,
    archived: archived.has(header.id),
    running: false,
    interruption: derived.inspectError != null ? null : (derived.interruption ?? null),
    parentSession: inspected.parentSession ?? header.parentSession ?? null,
    autoRename: autoRenameEnabled(ctx, storeState, header.id),
    autoContinue: effectiveAutoContinue(cfg, storeState, header.id),
    continueRunning: continueJobs.has(header.id),
    ...(derived.inspectError != null ? { inspectError: derived.inspectError } : {}),
  };
}

// ---------- 会话列表 ----------

// v1.35.10【崩溃修复·放大器】会话列表缓存 + 并发合并。
// 背景：面板里有 7+ 个组件各自在挂载时调 refresh()（client.js 的 useEffect(refresh)），
// 加上「插件挂载即预取一次」，同一瞬间会打出**多个并发的全量 list 请求**；
// 每个请求都独立重扫全部会话（本机 130 个冷会话、253MB 会话库），内存与 IO 成倍叠加。
// 实测未加缓存时：一次 list 约 25s，进程堆峰值冲向 --max-old-space-size=2048 上限。
// 这里做两件事：①并发合并——同一时刻只允许一次构建在跑，其余请求复用同一个 Promise；
// ②短 TTL 缓存——默认 cfg.listCacheMs（5s）内的重复请求直接复用结果。
// 变更类操作（改开关/归档/删除/改名等）会调 invalidateSessionListCache() 立即失效，保证用户操作后看到最新。
let listCacheAt = 0;
let listCacheItems = null;
let listBuildInflight = null;

/** 让会话列表缓存立即失效（任何会改变列表内容的写操作后调用）。 */
function invalidateSessionListCache() {
  listCacheAt = 0;
  listCacheItems = null;
}

/**
 * 带缓存/并发合并的会话列表。
 * @param ctx 插件上下文
 * @param opts.force true=绕过缓存与合并，强制重新构建（搜索/按规则删除等需要绝对新鲜的场景）
 */
async function buildSessionListCached(ctx, { force = false, onItem = null, serial = false } = {}) {
  // onItem：list 流式输出用（每构建好一个会话回调一次，前端逐行追加）；null = 完整返回
  const emitAll = (items) => { if (onItem) for (const item of items ?? []) onItem(item); };
  if (!force) {
    const ttl = cfg.listCacheMs;
    if (listCacheItems !== null && ttl > 0 && Date.now() - listCacheAt < ttl) { emitAll(listCacheItems); return listCacheItems; }
    // 已有构建在跑：直接复用，避免同一瞬间多个组件刷新时重复全量扫描（内存放大器）
    if (listBuildInflight !== null) return listBuildInflight.then((items) => { emitAll(items); return items; });
  }
  const build = buildSessionList(ctx, { onItem, serial }).then((items) => {
    listCacheItems = items;
    listCacheAt = Date.now();
    return items;
  }).finally(() => {
    if (listBuildInflight === build) listBuildInflight = null;
  });
  listBuildInflight = build;
  return build;
}

/** 组装全部会话（live + 已持久化），按最后活动时间倒序。 */
/** 测试钩子：会话列表缓存/懒加载逻辑的单测入口（生产路径经 buildSessionListCached 调用）。 */
export { buildSessionListCached };

async function buildSessionList(ctx, opts = {}) { // dsh-skip-func-length
  const sessions = ctx.get("sessions");
  const workspaceRegistry = ctx.get("workspaceRegistry");
  const persistence = ctx.get("sessionPersistence");
  const sessionTitle = ctx.get("sessionTitle");
  const storeState = await pluginState(ctx);

  const archived = new Set(workspaceRegistry?.archivedSessionIds ?? []);
  const items = [];
  // 流式输出钩子：list handler 每构建好一个会话立即写出（前端逐行追加）；
  // 不传 onItem 时行为与原来完全一致（完整数组返回）。
  const emit = (item) => { items.push(item); if (opts?.onItem) opts.onItem(item); };

  // live 会话
  for (const session of sessions?.list() ?? []) {
    const events = sessionEventList(session);
    const running = hasOpenTurn(events);
    const title = resolveSessionTitle(sessionTitle, session, events);
    emit({
      id: session.id,
      // 已归档会话：标题保持带前缀的原值（client 剥离显示、按前缀分组），并带 archiveWs 供分组
      title,
      archiveWs: archived.has(session.id) ? stripArchiveWsPrefix(title ?? "").ws : "",
      cwd: session.header?.cwd ?? null,
      createdAt: session.header?.createdAt,
      updatedAt: lastEventTime(events) ?? session.header?.createdAt,
      live: true,
      archived: archived.has(session.id),
      running,
      interruption: running ? null : interruptionInfo(events),
      parentSession: session.header?.parentSession ?? null,
      autoRename: autoRenameEnabled(ctx, storeState, session.id),
      autoContinue: effectiveAutoContinue(cfg, storeState, session.id),
      continueRunning: continueJobs.has(session.id)
    });
  }

  // 已持久化（未 live）会话。30801：sessionTitle.get() 不能喂 {events} 假对象（会抛，allSettled 把整条冷会话丢掉）。
  const liveIds = new Set(items.map((item) => item.id));
  const coldById = new Map(); // id -> { meta: header, revision: string|null }
  if (persistence?.list) {
    try {
      // v1.35.10：优先 listSnapshots()——只读 header 行 + 一次 stat，**不解析日志**，
      // 顺带给出 revision（日志变更令牌），这是「懒加载」的判据（见本段上方缓存说明）。
      if (typeof persistence.listSnapshots === "function") {
        for (const snapshot of await persistence.listSnapshots()) {
          const header = snapshot?.header;
          if (header?.id && !liveIds.has(header.id)) {
            coldById.set(header.id, { meta: header, revision: snapshot.revision == null ? null : String(snapshot.revision) });
          }
        }
      } else {
        // 【原代码】const meta of await persistence.list()（无 revision，退化为每次都重新解析）
        for (const meta of await persistence.list()) {
          if (!liveIds.has(meta.id)) coldById.set(meta.id, { meta, revision: null });
        }
      }
    } catch (error) {
      log(ctx, `sessionPersistence.list 失败（改走归档补全）: ${String(error?.message ?? error)}`);
    }
  }
  // 归档集合是权威隐藏名单：即使 persistence.list 漏扫，也按 id inspect 补进列表。
  for (const id of archived) {
    if (!liveIds.has(id) && !coldById.has(id)) coldById.set(id, { meta: { id }, revision: null });
  }
  if (coldById.size > 0) {
    const disk = loadListDiskCache(ctx);
    const needInspect = [];
    // ① 先吃缓存：revision 一致 → 直接用落盘结果，零解析零内存（懒加载核心）
    for (const [id, entry] of coldById) {
      const cached = disk.entries[id];
      if (cached && entry.revision !== null && cached.rev === entry.revision) {
        // inspected 用缓存里存的 header 派生字段（原来由 inspect 回读提供，现随缓存落盘复用）
        emit(buildColdSessionItem(entry.meta, cached, cached, ctx, storeState, archived));
        continue;
      }
      needInspect.push(entry);
    }
    // ② 只对「新会话 / 日志变过 / 无 revision」的会话解析，且按 cfg.listInspectBatch 分片：
    //    【原代码·根因】曾把全部冷会话一次性 Promise.allSettled 并发 inspect —— 每份日志整解压进
    //    内存，N 个会话 = N 份事件流同时驻留，实测 88 秒把 2GB 堆打满（FATAL ERROR: Ineffective
    //    mark-compacts near heap limit），表现为「启用后重启 → 会话加载不出来 + 隔一会 DSH 死」。
    //    现在片内并发、片间串行，每片解析完即写缓存，事件数组随片结束回收。
    // serial=true（list 流式）：严格串行逐个解析（每获取一个追加一个，不一次性并发）；
    // 其余调用方保持 cfg.listInspectBatch（默认 2，片间串行）。
    const batchSize = Math.max(1, opts?.serial === true ? 1 : (cfg.listInspectBatch ?? DEFAULTS.listInspectBatch));
    for (let start = 0; start < needInspect.length; start += batchSize) {
      const batch = needInspect.slice(start, start + batchSize);
      const settled = await Promise.allSettled(batch.map(async (entry) => {
        let events = [];
        let inspectError = null;
        let inspected = entry.meta;
        try {
          // ⚠️ 0.1.6-alpha.1 起 persistence.inspect 已失效（返回空）→ 冷会话标题全 null。
          //    改用官方 handle 读法（open('read') → read(0) → close），与 session-query 一致。
          const loaded = persistence?.open ? await readColdSessionEvents(ctx, entry.meta.id) : null;
          events = loaded?.events ?? [];
          if (loaded?.meta) inspected = loaded.meta;
        } catch (cause) {
          // 损坏/不可读的 artifact 以无标题呈现，不影响列表；错误信息带出便于诊断
          inspectError = cause instanceof Error ? cause.message : String(cause);
        }
        const derived = {
          title: foldTitle(events) ?? null,
          updatedAt: lastEventTime(events) ?? inspected.createdAt ?? entry.meta.createdAt,
          interruption: interruptionInfo(events),
          inspectError,
        };
        // 解析结果连同 revision 落盘：下次这条会话只要没被追加过就不再解析。
        // cwd/createdAt/parentSession 一并存——它们原先来自 inspect 回读的 header，
        // 缓存命中路径没有 inspect，靠这三项才能产出与「刚解析完」一致的结构。
        if (entry.revision !== null) {
          disk.entries[entry.meta.id] = {
            rev: entry.revision,
            ...derived,
            cwd: inspected.cwd ?? entry.meta.cwd ?? null,
            createdAt: inspected.createdAt ?? entry.meta.createdAt,
            parentSession: inspected.parentSession ?? entry.meta.parentSession ?? null,
          };
          scheduleSaveListDiskCache(ctx);
        }
        return buildColdSessionItem(entry.meta, inspected, derived, ctx, storeState, archived);
      }));
      for (const result of settled) {
        if (result.status === "fulfilled") emit(result.value);
        else log(ctx, `冷会话列表项失败: ${String(result.reason?.message ?? result.reason)}`);
      }
    }
    // ③ 清理已消失会话的缓存条目（删除/移走的会话不该永远占着缓存文件）
    let pruned = 0;
    for (const id of Object.keys(disk.entries)) {
      if (!coldById.has(id) && !liveIds.has(id)) {
        delete disk.entries[id];
        pruned += 1;
      }
    }
    if (pruned > 0 || listDiskCacheDirty) {
      listDiskCacheDirty = true;
      saveListDiskCacheNow(ctx);
    }
  }

  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return items;
}

// ---------- 取消归档 / 删除 ----------

/**
 * 取消归档。DSH 无公开 unarchive API：直接写注册表的持久化状态
 * （domain.global.set），host-apiproxy 的 domain/changed 监听会自动把
 * 新归档集合推送成 host/archived-sessions-changed 帧。
 */
async function unarchiveSession(ctx, sessionId) {
  const registry = ctx.get("workspaceRegistry");
  if (!registry) throw new Error("workspaceRegistry 服务不可用");
  if (!registry.archivedSessionIds.includes(sessionId)) return; // 未归档，幂等
  const state = registry.state ?? registry.requireState();
  await registry.setState({
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
  });
}

/** 删除会话（per-session 串行锁）：拒绝运行中/续跑中 → detach → 取消归档 → 记账清理 → 删磁盘日志 → 清理遗留定时器。
 *  同一会话的并发删除请求排队串行执行（withDeleteLock），不做交错。 */
export async function deleteSession(ctx, sessionId) {
  return withDeleteLock(sessionId, async () => {
    const sessions = ctx.get("sessions");
    const workspaceRegistry = ctx.get("workspaceRegistry");
    const persistence = ctx.get("sessionPersistence");

    // 0. 运行中 / 续跑中的会话拒绝删除
    const live = sessions?.get(sessionId);
    if (live && hasOpenTurn(live.events)) {
      return { ok: false, error: { code: "running", message: "会话正在运行，无法删除" } };
    }
    if (continueJobs.has(sessionId)) {
      return { ok: false, error: { code: "running", message: "会话正在自动续跑中，无法删除" } };
    }

    // 1. live 会话从 store detach → 触发 session/disposed → 前端收 host/session-removed
    if (live) {
      // 内部实现变通：sessions 服务无公开 remove；entry.detach 与 agent 拆卸同一路径。
      const entry = sessions?.store?.get(sessionId);
      entry?.detach?.();
    }

    // 2. 若已归档 → 取消归档
    await unarchiveSession(ctx, sessionId);

    // 3. 从 workspace 记账 detach（detachSession 为公开方法）
    for (const workspace of workspaceRegistry?.list() ?? []) {
      if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId);
    }

    // 4. 删除磁盘 artifact（session 目录）。sqlite 查询索引会对账自动清理。
    //    先 detach 再删文件：持久化协调器在 session/disposed 后退休该会话，
    //    不会再把它写回磁盘。
    if (persistence?.listArtifacts) {
      const artifacts = await persistence.listArtifacts();
      const artifact = artifacts.find((entry) => entry.header?.id === sessionId);
      if (artifact?.path) {
        const sessionDir = path.dirname(artifact.path);
        await rm(sessionDir, { recursive: true, force: true });
        // 尽力清理空的 project 目录（会话删光后不留空壳）
        const projectDir = path.dirname(sessionDir);
        try {
          if ((await readdir(projectDir)).length === 0) await rm(projectDir, { recursive: true, force: true });
        } catch {
          // 目录非空或不可读，保留即可
        }
      }
    }

    // 5. 清理自动重命名 / 自动续跑开关（config.json 两组同步清，防同名会话重建后误判）
    const hadRename = switchGroups.autoRename.delete(sessionId);
    const hadContinue = switchGroups.autoContinue.delete(sessionId);
    if (hadRename || hadContinue) await savePluginConfig(ctx);
    const domain = await pluginDomain(ctx);
    const state = domain.global.get();
    if (state.autoRename?.[sessionId] !== void 0 || state.autoContinue?.[sessionId] !== void 0) {
      // 旧域残留清理（2026-09-27 前落盘数据，此后开关以 config.json 为准）
      const next = { ...state, autoRename: { ...(state.autoRename ?? {}) }, autoContinue: { ...(state.autoContinue ?? {}) } };
      delete next.autoRename[sessionId];
      delete next.autoContinue[sessionId];
      await domain.global.set(next);
    }

    // 6. 清理该会话遗留的防抖定时器/续跑记账（删除后不应再有续跑/重命名调度）
    cancelSessionTimers(sessionId);

    return { ok: true };
  });
}

// ---------- 撤回最后一条用户消息（v1.22.0） ----------

/**
 * 撤回会话「最后一条用户消息」（连同它触发的整轮回复），等效于聊天软件撤回。
 * 原理：直接操作会话日志文件 session.jsonl.zstd —— 逐帧解码 → 删除最后一条
 * user/message 事件所在行及其后所有行 → 多帧写回（header 一帧 + body 一帧，
 * 带 checksum，与官方 jsonl 后端一致）→ 原文件备份到 .undo-backup/。
 * seq 无需重编号：删除的是文件尾部，前面事件 seq 0..N-1 连续不变（写回前用
 * validateSessionText 校验兜底）。
 * 安全（与 deleteSession 同一策略）：拒绝运行中/续跑中；live 空闲会话先走
 * detachSessionAgent（协调器退休）再改文件，防止内存旧事件 flush 覆盖撤回结果；
 * 会话保留在侧边栏列表（detach 链路保证），重新打开即加载撤回后的状态。
 * @returns {{ok:boolean, preview?:string, removedLineCount?:number, removedEventCount?:number,
 *            remainingEventCount?:number, backup?:string, dryRun?:boolean, error?:{code,message}}}
 */
export async function undoLastMessage(ctx, sessionId, { dryRun = false } = {}) {
  return withDeleteLock(sessionId, async () => {
    const sessions = ctx.get("sessions");
    const persistence = ctx.get("sessionPersistence");

    // 0. 运行中 / 续跑中的会话拒绝撤回（与 deleteSession 同一策略）
    const live = sessions?.get(sessionId);
    if (live && hasOpenTurn(live.events)) {
      return { ok: false, error: { code: "running", message: "会话正在运行，无法撤回（等回合结束后再试）" } };
    }
    if (continueJobs.has(sessionId)) {
      return { ok: false, error: { code: "running", message: "会话正在自动续跑中，无法撤回" } };
    }

    // 1. 定位会话日志文件（与 deleteSession 同一来源）
    if (!persistence?.listArtifacts) {
      return { ok: false, error: { code: "no-persistence", message: "sessionPersistence 服务不可用" } };
    }
    const artifacts = await persistence.listArtifacts();
    const artifact = (artifacts ?? []).find((entry) => entry.header?.id === sessionId);
    if (!artifact?.path) {
      return { ok: false, error: { code: "not-found", message: "会话日志不存在" } };
    }
    const filePath = artifact.path;

    // 2. 读取并定位最后一条用户消息所在行（从尾部往前扫，找到即止）
    let text;
    try {
      const { decodeAllFrames } = await lazyZstd();
      text = await decodeAllFrames(readFileSync(filePath));
    } catch (e) {
      return { ok: false, error: { code: "decode-failed", message: "会话日志解码失败: " + String(e?.message ?? e) } };
    }
    const lines = String(text).split("\n");
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length === 0) return { ok: false, error: { code: "empty", message: "会话日志为空" } };

    let targetLineIdx = -1;
    let preview = "";
    let removedEventCount = 0;
    for (let i = lines.length - 1; i >= 1; i--) {
      const { parseLineEvents } = await lazyRepair();
      const events = parseLineEvents(lines[i]);
      if (!events) continue;
      removedEventCount += events.length;
      for (const ev of events) {
        // 只撤回真实用户消息（source.kind === "user"）；注入的
        // runtime context / system-reminder 的 kind 是 plugin / skill-catalog，
        // 不能把注入内容误当用户消息撤回（2026-08-24 实测缺陷修复）
        const srcKind = ev?.data?.source?.kind;
        if ((ev?.type === "user/message" || ev?.type === "user") && srcKind === "user") {
          targetLineIdx = i;
          const content = ev.data?.content;
          if (Array.isArray(content)) {
            preview = content
              .filter((b) => b?.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join("\n");
          }
          break;
        }
      }
      if (targetLineIdx >= 0) break;
    }
    if (targetLineIdx < 0) {
      return { ok: false, error: { code: "no-user-message", message: "会话里没有可撤回的用户消息" } };
    }

    // 删除范围 [targetLineIdx, 行尾]：这条消息 + 它触发的整轮回复（文件尾部）
    const keptLines = lines.slice(0, targetLineIdx);
    const removedLineCount = lines.length - targetLineIdx;
    const newText = keptLines.join("\n") + "\n";

    // 3. 写回前校验（header / seq 连续 / tool-result 结构）
    const { validateSessionText } = await lazyRepair();
    const check = validateSessionText(newText);
    if (!check.ok) {
      return { ok: false, error: { code: "invalid-after-undo", message: "撤回后日志校验失败: " + (check.problems?.[0] ?? "未知") } };
    }

    if (dryRun) {
      return { ok: true, dryRun: true, preview, removedLineCount, removedEventCount, remainingEventCount: check.eventCount };
    }

    // 4. 正式执行：先 detach（协调器退休，防 flush 旧事件覆盖）再改文件
    if (live) {
      const detach = await detachSessionAgent(ctx, sessionId);
      if (!detach?.ok) {
        return { ok: false, error: { code: "detach-failed", message: String(detach?.error?.message ?? "detach 失败") } };
      }
    }

    // 5. 备份原文件到会话同目录 .undo-backup/
    const backupDir = path.join(path.dirname(filePath), ".undo-backup");
    mkdirSync(backupDir, { recursive: true });
    const bak = path.join(backupDir, `${Date.now()}-${sessionId}.zstd`);
    copyFileSync(filePath, bak);

    // 6. 多帧写回（header 一帧 + body 一帧，带 checksum），原子替换
    const { encodeSessionText } = await lazyRepair();
    const newBuf = await encodeSessionText(newText);
    const tmp = filePath + ".undotmp";
    writeFileSync(tmp, newBuf);
    try { chmodSync(tmp, statSync(filePath).mode); } catch { /* CIFS 无 chmod，尽力 */ }
    renameSync(tmp, filePath);

    return { ok: true, preview, removedLineCount, removedEventCount, remainingEventCount: check.eventCount, backup: bak };
  });
}

// ---------- 全文搜索 / 批量删除 / 按条件删除（v1.19.0） ----------

const SEARCH_MIN_QUERY = 2; // 关键词最短长度（低于不搜）
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
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const item of collectSearchableEvents(events)) {
    if (hits.length >= perSessionMax) break;
    const idx = item.text.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const half = Math.floor(previewLen / 2);
      const start = Math.max(0, idx - half);
      const end = Math.min(item.text.length, idx + q.length + half);
      const preview = (start > 0 ? "…" : "") + item.text.slice(start, end).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim() + (end < item.text.length ? "…" : "");
      hits.push({ seq: item.seq, time: item.time, role: item.role, preview });
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
  const q = String(query ?? "").trim();
  if (q.length < SEARCH_MIN_QUERY) return { query: q, scanned: 0, hits: [] };
  const sessions = await buildSessionListCached(ctx, { force: true }); // v1.35.10：搜索需绝对新鲜，绕过缓存
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

/**
 * 批量删除：逐条复用 deleteSession（内部 per-session 串行锁 + 幂等）。
 * 运行中/续跑中的会话跳过并汇总返回，不整体失败。
 * @returns {{requested:number, deleted:string[], skipped:Array<{sessionId:string, reason:string}>}}
 */
export async function deleteBatchSessions(ctx, sessionIds) {
  const ids = [...new Set(
    (Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === "string" && id !== "")
  )];
  const deleted = [];
  const skipped = [];
  // 2026-08-20 修复：预检会话是否存在（live 或已持久化），不存在的进 skipped(not-found)，
  // 不再被误报为「已删除」。persistence 不可用/返回空（如测试 mock）时保守处理：
  // 仅当「明确知道不存在」才跳过，否则交给 deleteSession 正常判定。
  const persistence = ctx.get("sessionPersistence");
  const persistIds = new Set();
  let canCheckPersist = false;
  try {
    // 持久化会话权威来源 = persistence.list()（mock 与真实实现都提供）；
    // listArtifacts 仅作补充（可能未实现/返回空，不代表会话不存在）
    if (persistence?.list) {
      const metas = await persistence.list();
      if (Array.isArray(metas)) {
        canCheckPersist = true;
        for (const m of metas) if (m?.id) persistIds.add(m.id);
      }
    }
  } catch { canCheckPersist = false; }
  const sessionsSvc = ctx.get("sessions");
  const liveIds = new Set(sessionsSvc?.list?.()?.map((s) => s.id) ?? []);
  for (const id of ids) {
    // 仅当列表查询可用且明确不在其中 → not-found；否则尝试删除
    const knownMissing = canCheckPersist ? (!liveIds.has(id) && !persistIds.has(id)) : false;
    if (knownMissing) {
      skipped.push({ sessionId: id, reason: "not-found" });
      continue;
    }
    try {
      const result = await deleteSession(ctx, id);
      if (result.ok) deleted.push(id);
      else skipped.push({ sessionId: id, reason: result.error?.code ?? "error" });
    } catch {
      skipped.push({ sessionId: id, reason: "error" });
    }
  }
  return { requested: ids.length, deleted, skipped };
}

/**
 * 按条件删除：归档状态 / 超期未活跃（updatedAt 距今 > inactiveDays 天）/ cwd 前缀（分组）/
 * 低价值会话（lowValue=true 复用价值分析判定，事件不可读的会话保守保留不删）。
 * dryRun=true 只预览命中（不执行删除）。
 * @returns {{matched:Array<{sessionId,title,cwd,archived,updatedAt,value?,reason?}>, deleted?:string[], skipped?:Array<{sessionId,reason}>}}
 */
export async function deleteByRule(ctx, { archivedOnly = false, inactiveDays = 0, cwdPrefix = "", lowValue = false, dryRun = false } = {}) {
  const sessions = await buildSessionListCached(ctx, { force: true }); // v1.35.10：按规则删除不得拿旧列表决策，绕过缓存
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const prefix = String(cwdPrefix ?? "").replace(/\/+$/, "");
  // lowValue：复用价值分析（analyzeValuesWithKeywords 的 low 集合）；事件不可读会话被
  //   保守判 high（artifact-safe），不会误删；关键词命中也判 high 不删。
  let lowById = null;
  if (lowValue) {
    const texts = {};
    const userTexts = {};
    const featuresById = {};
    for (const s of sessions) {
      try {
        const found = await sessionEventsOf(ctx, s.id);
        if (found) {
          const { lastAssistantText, lastUserText, buildValueFeatures } = await lazyValue();
          texts[s.id] = lastAssistantText(found.events);
          userTexts[s.id] = lastUserText(found.events);
          featuresById[s.id] = buildValueFeatures(found.events, s, new Date(now));
        }
      } catch {
        /* 单会话读取失败：不放入 lowById，保守保留不删 */
      }
    }
    const { analyzeValuesWithKeywords } = await lazyValue();
    const { low } = analyzeValuesWithKeywords(sessions, texts, userTexts, featuresById, [], {}, new Date(now));
    lowById = new Set(low.map((i) => i.id));
  }
  const matched = sessions.filter((s) => {
    if (archivedOnly && s.archived !== true) return false;
    if (inactiveDays > 0) {
      const updated = typeof s.updatedAt === "number" ? s.updatedAt : NaN;
      if (!Number.isFinite(updated) || now - updated < inactiveDays * dayMs) return false;
    }
    if (prefix !== "") {
      const cwd = String(s.cwd ?? "").replace(/\/+$/, "");
      if (cwd !== prefix && !cwd.startsWith(prefix + "/")) return false;
    }
    if (lowValue && !(lowById?.has(s.id) ?? false)) return false;
    return true;
  });
  const preview = matched.map((s) => {
    const item = {
      sessionId: s.id,
      title: s.title,
      cwd: s.cwd,
      archived: s.archived === true,
      updatedAt: s.updatedAt ?? null,
    };
    if (lowValue && lowById) item.value = "low";
    return item;
  });
  if (dryRun) return { ok: true, dryRun: true, matched: preview };
  const result = await deleteBatchSessions(ctx, preview.map((m) => m.sessionId));
  return { ok: true, dryRun: false, matched: preview, deleted: result.deleted, skipped: result.skipped };
}

// ---------- 插件入口 ----------

let cfg = { ...DEFAULTS };


/** 会话模板元信息缓存（systemPrompt section「session-templates」同步读用，templates API 写入后刷新）。 */
let templateStateCache = structuredClone(TEMPLATE_DEFAULTS);

/** 解析 DSH 主目录：DSH_HOME 环境变量 > ~/.dsh */
function resolveDshHome(ctx, c) {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return home ? path.join(home, '.dsh') : '';
}

/**
 * v1.33.0：模板/额外注入系统提示词的「目录浏览」根目录 = DSH 工作区目录（~/.dsh-home/工作区，
 * 即 HOME/工作区；skill 仓库、项目仓库都在其下），而不是 DSH 主目录（~/.dsh，只放落盘文件）。
 * 用户可在设置页配置 skill 仓库路径；浏览根是工作区，能走到工作区内任意目录。
 * 存在性探测：HOME/工作区 存在则用它；否则回退 DSH_HOME（老布局）。
 */
function resolveBrowseRoot(ctx, c) {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const ws = home ? path.join(home, '工作区') : '';
  if (ws) {
    try { if (statSync(ws).isDirectory()) return ws; } catch { /* 不存在则回退 */ }
  }
  return resolveDshHome(ctx, c);
}

/** 测试钩子：直接设置运行期配置（单测用）。 */
export function __setConfigForTest(partial = {}) {
  cfg = {
    enabled: partial?.enabled !== false,
    defaultAutoContinue: partial?.defaultAutoContinue === true, // v1.35.3：缺省关闭，仅显式 true 开启
    failRetryDelayMs: num(partial?.failRetryDelayMs, 0, 10 * 60 * 1000, DEFAULTS.failRetryDelayMs),
    titleStateSuffix: partial?.titleStateSuffix === true, // v1.36.0 起默认取消状态后缀，显式 true 才开启
    maxConcurrent: num(partial?.maxConcurrent, 1, 8, DEFAULTS.maxConcurrent),
    maxAttached: num(partial?.maxAttached, 1, 64, DEFAULTS.maxAttached),
    // v1.35.10：会话列表冷会话 inspect 并发上限（默认 2）——防一次性并发全量会话导致堆 OOM
    listInspectBatch: num(partial?.listInspectBatch, 1, 16, DEFAULTS.listInspectBatch),
    // v1.35.10：list 结果缓存时长（0=不缓存，即时最新；默认 5s 合并面板多组件同时刷新）
    listCacheMs: num(partial?.listCacheMs, 0, 5 * 60 * 1000, DEFAULTS.listCacheMs),
    cooldownMs: num(partial?.cooldownMs, 60 * 1000, 24 * 3600 * 1000, DEFAULTS.cooldownMs),
    maxContinuesPerSession: num(partial?.maxContinuesPerSession, 1, 20, DEFAULTS.maxContinuesPerSession),
    turnTimeoutMs: num(partial?.turnTimeoutMs, 60 * 1000, 6 * 3600 * 1000, DEFAULTS.turnTimeoutMs),
    scanIntervalMs: num(partial?.scanIntervalMs, 30 * 1000, 24 * 3600 * 1000, DEFAULTS.scanIntervalMs),
    // 自动重命名模型路由（成对配置才生效；缺省 = 继承会话 request/header 的对话模型）
    autoRenameProvider: typeof partial?.autoRenameProvider === "string" && partial.autoRenameProvider !== "" ? partial.autoRenameProvider : undefined,
    autoRenameModel: typeof partial?.autoRenameModel === "string" && partial.autoRenameModel !== "" ? partial.autoRenameModel : undefined,
  };
  return cfg;
}

/** 测试钩子：读取模块级定时器/锁状态（单测验证删除清理等）。 */
export function __timersForTest() {
  return { continueTimers, pendingTimers, continueJobs, deleteLocks };}

/** 测试钩子：读取开关配置内存缓存（2026-09-27 起开关落盘 config.json，单测断言这里）。
 * 返回 { autoRename: Map, autoContinue: Map }。 */
export function __switchConfigForTest() {
  return switchGroups;
}

/** 测试钩子：重置模块级单例状态（单测在场景之间调用）。 */
export function __resetForTest() {
  domainPromise = null;
  // 2026-09-27：开关缓存是模块级状态，测试场景之间必须清空，否则上一条用例的开关串到下一条。
  switchGroups.autoRename.clear();
  switchGroups.autoContinue.clear();
  // v1.35.10：会话列表的落盘缓存/内存缓存同样是模块级状态，场景之间必须重置，
  // 否则上一条用例留下的缓存会让下一条「一次 inspect 都不做」，测不出真实行为。
  listDiskCache = null;
  listDiskCachePath = null;
  listDiskCacheDirty = false;
  if (listDiskCacheTimer !== null) clearTimeout(listDiskCacheTimer);
  listDiskCacheTimer = null;
  invalidateSessionListCache();
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  for (const timer of continueTimers.values()) clearTimeout(timer);
  continueTimers.clear();
  continueLocks.clear();
  continueJobs.clear();
  deleteLocks.clear();
  activeContinues = 0;
  activeAnalyses = 0;
  if (scanTimer !== null) clearTimeout(scanTimer);
  scanTimer = null;
}

/** 设置 → 插件 → 插件配置 卡片命名空间（须与客户端 settings.plugin.item 的 key 一致）。 */
export const CONDUCTOR_SETTINGS_NS = {
  group: "session-conductor-group",
  compaction: "session-conductor-compaction",
};

/** 占位 schema：让 Host 把命名空间列入插件配置页；实际读写仍走 /api/session-conductor/*。 */
const PresenceSchema = Schema.object({
  present: Schema.boolean().default(true),
});

export async function apply(ctx, config = {}) {
  // 2026-08-20 修复（热重载兼容）：插件重载时旧 apply 的 disposer 会 close 持久化域，
  // 但模块级 domainPromise 缓存不失效 → 新 apply 复用已 closed 的域 → 所有读写报
  // "domain 'dsh_session_conductor' is closed"（list/value-analysis/search 全挂）。
  // 每次 apply 重置缓存，确保重新 open 域。
  // v1.35.9：改为条件重置。原代码无条件清缓存，遇到「旧的域还活着就重载」时
  // （多条目/热重载时序）会在活域上再 open 一次 → storage 报 already open → list 500。
  // 只有确认域已关闭（或从未打开）才清缓存；域还活着就复用同一份，不再重复 open。
  // 【原代码】此处为两行无条件重置：domainPromise = null 与 pushDomainPromise = null（push 域已随自动推送功能移除）
  if (!domainLive) domainPromise = null;
  cfg = {
    enabled: config?.enabled !== false,
    defaultAutoContinue: config?.defaultAutoContinue === true, // v1.35.3：缺省关闭，仅显式 true 开启
    failRetryDelayMs: num(config?.failRetryDelayMs, 0, 10 * 60 * 1000, DEFAULTS.failRetryDelayMs),
    titleStateSuffix: config?.titleStateSuffix === true, // v1.36.0 起默认取消状态后缀（吸收官方纯净标题），显式 true 才开启
    maxConcurrent: num(config?.maxConcurrent, 1, 8, DEFAULTS.maxConcurrent),
    maxAttached: num(config?.maxAttached, 1, 64, DEFAULTS.maxAttached),
    // v1.35.10：会话列表冷会话 inspect 并发上限（默认 2）——防一次性并发全量会话导致堆 OOM
    listInspectBatch: num(config?.listInspectBatch, 1, 16, DEFAULTS.listInspectBatch),
    // v1.35.10：list 结果缓存时长（0=不缓存，即时最新；默认 5s 合并面板多组件同时刷新）
    listCacheMs: num(config?.listCacheMs, 0, 5 * 60 * 1000, DEFAULTS.listCacheMs),
    cooldownMs: num(config?.cooldownMs, 60 * 1000, 24 * 3600 * 1000, DEFAULTS.cooldownMs),
    maxContinuesPerSession: num(config?.maxContinuesPerSession, 1, 20, DEFAULTS.maxContinuesPerSession),
    turnTimeoutMs: num(config?.turnTimeoutMs, 60 * 1000, 6 * 3600 * 1000, DEFAULTS.turnTimeoutMs),
    scanIntervalMs: num(config?.scanIntervalMs, 30 * 1000, 24 * 3600 * 1000, DEFAULTS.scanIntervalMs),
    // 自动重命名模型路由（成对配置才生效；缺省 = 继承会话 request/header 的对话模型）
    autoRenameProvider: typeof config?.autoRenameProvider === "string" && config.autoRenameProvider !== "" ? config.autoRenameProvider : undefined,
    autoRenameModel: typeof config?.autoRenameModel === "string" && config.autoRenameModel !== "" ? config.autoRenameModel : undefined,
  };

  // 会话分组（原 dsh-session-group 已合并）：2026-09-26 起仅保留只读展示（status/list）
  // + 分组下新建会话（new-session，workspaceId 缺省 = 上次会话工作区）；分组管理能力回归
  // DSH 官方 workspace 机制。
  // v1.35.6：进程级兜底——宿主 bin.ts 未注册 unhandledRejection/uncaughtException 处理，
  // Node 15+ 默认 --unhandled-rejections=throw，任何插件的异步 rejection 逃逸都会**直接杀死
  // 整个 DSH 进程**（表现为「自动续跑跑一会进程就没了」）。这里注册兜底：仅记录日志、不退出，
  // 避免单个 promise 异常拖垮宿主；插件自身异步链已全部包 try/catch，这里防的是回归与未知路径。
  installProcessGuards(ctx);

  await registerGroupRoutes(ctx, {
    blockGroupNewSession: config?.blockGroupNewSession,
    enabled: config?.groupEnabled !== false,
  }, {
    // 承接会话（new-session 新建）默认开启自动重命名（2026-08-18 约定）
    setAutoRename: (sessionId, enabled) => patchSwitch(ctx, "autoRename", sessionId, { enabled }, { enabled: false }).catch((error) => {
      log(ctx, `承接会话自动重命名设置失败 ${sessionId}: ${String(error?.message ?? error)}`);
    }),
  }).catch((error) => {
    log(ctx, `会话分组模块初始化失败: ${String(error?.message ?? error)}`);
  });

  // 回合开始/结束 → 刷新标题状态后缀；回合结束还触发自动重命名 + 自动续跑判定。
  // 【v1.36.0 吸收官方 all-prompts 节奏】每条真人 user/message 后也触发自动重命名精炼
  // （analyzeSession 内部有「新增≥3条 + 5min 间隔」门槛兜底，不会每条都调 LLM）。
  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type === "turn/start" || type === "turn/end") {
      refreshTitleState(ctx, session).catch((error) => {
        log(ctx, `标题状态刷新失败 ${session?.id}: ${String(error?.message ?? error)}`);
      });
    }
    if (type === "user/message" && event?.data?.source?.kind === "user") {
      const sessionId = session?.id;
      if (typeof sessionId === "string") scheduleAnalysis(ctx, sessionId);
    }
    // 2026-08-20 自动续跑全局闸门：检测到「用户第一次手动对话」（turn/start 由 user 发起）
    // → 自动置 gate=open（放行自动续跑）。guardian 在 DSH 恢复健康时置 closed，
    // 这里保证「用户真的开始对话了」才恢复续跑，杜绝崩溃恢复后批量建空壳。
    if (type === "turn/start") {
      const data = event?.data ?? event;
      const byUser =
        data?.role === "user" ||
        data?.user === true ||
        data?.kind === "user" ||
        data?.source === "user";
      if (byUser) {
        pluginDomain(ctx)
          .then((domain) => {
            const st = domain.global.get();
            if ((st.autoContinueGate ?? "open") === "closed") {
              return domain.global.set({ ...st, autoContinueGate: "open" });
            }
            return null;
          })
          .then((changed) => {
            if (changed) log(ctx, "🔓 检测到用户手动对话，自动续跑闸门已开放（autoContinueGate=open）");
          })
          .catch((error) => {
            log(ctx, `自动续跑闸门开放失败（不影响会话）: ${String(error?.message ?? error)}`);
          });
      }
    }
    if (type !== "turn/end") return;
    const sessionId = session?.id;
    if (typeof sessionId !== "string") return;
    scheduleAnalysis(ctx, sessionId);
    maybeScheduleContinue(ctx, sessionId);
  });

  // 启动后延迟首扫（等持久化/其他服务就绪），随后周期扫描。
  const firstScan = setTimeout(() => {
    runAutoScan(ctx).catch((error) => {
      log(ctx, `自动续跑首扫失败: ${String(error?.message ?? error)}`);
    });
    scheduleScan(ctx);
  }, AUTO_CONTINUE_SCAN_DELAY_MS);
  firstScan.unref?.();
  ctx.effect(() => {
    return () => {
      clearTimeout(firstScan);
      if (scanTimer !== null) clearTimeout(scanTimer);
      for (const timer of continueTimers.values()) clearTimeout(timer);
      continueTimers.clear();
    };
  }, "session-conductor: timers");

  // 在 apply 的活跃 fiber 上预热持久化域并挂 close effect，避免 HTTP handler 首次打开踩 inactive context。
  pluginDomain(ctx).catch((error) => {
    log(ctx, `持久化域预热失败: ${String(error?.message ?? error)}`);
  });

  // 2026-09-27：启动即载入开关配置，并自动把所有自动续跑开关复位为关闭
  // （需求：每次 DSH 启动默认关闭，之后面板逐会话决定；autoRename 不复位）。
  resetAutoContinueOnStart(ctx).catch((error) => {
    log(ctx, `自动续跑开关启动复位失败: ${String(error?.message ?? error)}`);
  });

  // 设置 → 插件 → 插件配置：注册命名空间，浏览器卡片才能被 ConfigurablePluginsTab 配对渲染。
  // 卡片本身仍走 HTTP API，不把业务字段写进 settings.yaml。
  ctx.inject(["settings"], (sctx) => {
    try {
      const settings = sctx.get("settings");
      if (!settings) return;
      const base = { present: true };
      for (const ns of Object.values(CONDUCTOR_SETTINGS_NS)) {
        settings.register(ns, PresenceSchema, { base });
      }
      log(ctx, "已注册设置命名空间（插件配置页卡片）");
    } catch (e) {
      log(ctx, `设置命名空间注册失败: ${e?.message || e}`);
    }
  });

  // apply 运行时刻 webServer 的 fiber 可能尚未创建，必须走 inject。
  // 其余服务（workspaceRegistry / sessions / sessionPersistence / sessionTitle / llm / storageDomain）
  // 在请求到达时必然可用，用 ctx.get() 惰性解析并做空值兜底。
  ctx.inject(["webServer"], (wctx) => {
    const webServer = wctx.get("webServer");

    // ---------- GET /api/session-conductor/i18n ----------
    // 语言包外置 lib/i18n/{zh,en}.json（单份权威，改文案无需重打包 client bundle）：
    // 浏览器端 ModuleLoader 的 require 不支持相对路径 JSON（require("./i18n/*.json") 抛 missed-the-module-table），
    // 故由宿主侧读外置 JSON 经 HTTP 暴露、客户端 fetch 拉取合并（语言包外置做法）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/i18n",
      handler: async (req, res) => {
        try {
          if ((req.method ?? "GET") !== "GET") {
            return send(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
          }
          const zh = JSON.parse(readFileSync(new URL("./i18n/zh.json", import.meta.url), "utf8"));
          const en = JSON.parse(readFileSync(new URL("./i18n/en.json", import.meta.url), "utf8"));
          return send(res, 200, { ok: true, zh, en });
        } catch (error) {
          return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET /api/session-conductor/preview/<settings|panel> ----------
    // 真实后端预览页：单文件 html（assets/preview-*.html）经本路由同源服务，浏览器从 DSH 反代地址
    // 打开即同源 fetch /api/*（file:// 双击会被 CORS 拦——DSH API 不带 Access-Control-Allow-Origin）。
    // 用 kind:"exact" 枚举两个预览（DSH 的 kind:"prefix" 实测 401 不生效）
    const PREVIEW_FILES = {
      settings: new URL("../../assets/preview-settings.html", import.meta.url),
      panel: new URL("../../assets/preview-panel.html", import.meta.url),
    };
    const servePreview = async (req, res, name) => {
      try {
        if ((req.method ?? "GET") !== "GET") {
          return send(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
        }
        const file = PREVIEW_FILES[name];
        if (!file) return send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知预览: " + name } });
        const html = readFileSync(file, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch (error) {
        return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(error?.message ?? error) } });
      }
    };
    for (const name of ["settings", "panel"]) {
      webServer.register({
        kind: "exact",
        path: "/api/session-conductor/preview/" + name,
        handler: (req, res) => servePreview(req, res, name),
      });
    }

    // ---------- GET /api/session-conductor/list ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/list",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          // v1.38.0：list 流式（仅当请求声明 Accept: application/x-ndjson）——live 会话先快速
          // 写出，冷会话串行逐个解析边写边出，前端 fetch stream 逐行追加（每获取一个立即显示，
          // 不等全部）；排序由前端按 updatedAt 倒序插入保持（流式下后端不再整体排序）。
          // 默认（无 Accept 头/旧前端/预览页垫片）仍返回普通 JSON——兼容不匹配的调用方。
          const wantStream =
            /application\/x-ndjson/i.test(req.headers?.accept ?? "") || String(req.url ?? "").includes("stream=1");
          if (!wantStream) {
            const sessions = await buildSessionListCached(ctx);
            send(res, 200, { ok: true, sessions });
            return;
          }
          res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          if (res.socket?.setNoDelay) res.socket.setNoDelay(true);
          res.write(JSON.stringify({ ok: true, stream: true }) + "\n"); // 头行（前端跳过非会话行）
          const onItem = (item) => { try { res.write(JSON.stringify(item) + "\n"); } catch { /* 连接已断 */ } };
          await buildSessionListCached(ctx, { onItem, serial: true });
          try { res.end(); } catch { /* 连接已断 */ }
        } catch (error) {
          try {
            res.end(JSON.stringify({ ok: false, error: { code: "internal", message: String(error?.message ?? error) } }) + "\n");
          } catch { /* 连接已断 */ }
        }
      },
    });


    // ---------- GET/POST /api/session-conductor/templates ----------
    // v1.31.0 会话模板注入（）：plan（方案模板）/ closing（收尾模板）两个固定槽位，
    // 支持上传本地 md 文件或在线 md 网址（host 下载转存），内容落盘
    // <DSH_HOME>/template-inject-md/<slot>.md → systemPrompt section「session-templates」注入。
    // GET → {ok, slots: {plan:{enabled,name,url,bytes,updatedAt}, closing:{...}}, maxBytes}
    // POST {slot, enabled?} → 只改开关；
    // POST {slot, name, content} → 上传本地 md；
    // POST {slot, url} → 在线 md 网址下载转存；
    // POST {slot, action:"remove"} → 清空槽位。
    {
      const tplHome = resolveDshHome(ctx, cfg);
      // v1.33.0：浏览根与选用校验根唯一来源 = resolveBrowseRoot（工作区目录）。
      // 同一 browseRoot 变量贯穿本块内两个路由：/templates 的 pickPath 校验、/templates/dir 浏览。
      // 落盘仍 tplHome（DSH_HOME/template-inject-md/），浏览/校验/落盘三者职责清晰。
      const browseRoot = resolveBrowseRoot(ctx, cfg);
      if (tplHome) {
        webServer.register({
          kind: "exact",
          path: "/api/session-conductor/templates",
          handler: async (req, res) => {
            try {
              // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
              if (req.method !== "GET") invalidateSessionListCache();
              const domain = await pluginDomain(ctx);
              const st = domain.global.get();
              const meta = st.sessionTemplates ?? structuredClone(TEMPLATE_DEFAULTS);
              templateStateCache = meta;
              // 构造带 content 的 slots（GET/POST 统一：导入/编辑后前端编辑框直接读到内容）
              const buildSlotsWithContent = (meta2) => {
                const out = {};
                for (const slot of TEMPLATE_SLOTS) {
                  const m = meta2[slot] ?? { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 };
                  let content = "";
                  if (m.bytes > 0 || m.name) {
                    // readTemplateSync 返回 sanitized 字符串（无文件/不可读返回空串），不是 {ok,text} 对象
                    try { content = String(readTemplateSync(tplHome, slot) ?? "").slice(0, TEMPLATE_MAX_BYTES); } catch { content = ""; }
                  }
                  out[slot] = { ...m, content };
                }
                return out;
              };
              if (req.method === "GET") {
                return send(res, 200, { ok: true, slots: buildSlotsWithContent(meta), maxBytes: TEMPLATE_MAX_BYTES });
              }
              if (req.method === "POST") {
                const body = await readJson(req);
                // 目录内选用 md 文件（action="pickPath"）——校验用工作区浏览根，落盘用 DSH_HOME
                if (body?.action === "pickPath") {
                  const slot = String(body?.slot ?? "");
                  if (!TEMPLATE_SLOTS.includes(slot)) {
                    return send(res, 400, { ok: false, error: { code: "bad-slot", message: `模板槽位须为 ${TEMPLATE_SLOTS.join("|")}` } });
                  }
                  const saved = await saveTemplateFromPath(browseRoot, slot, body.path, tplHome);
                  if (!saved.ok) return send(res, 400, saved);
                  const cur = meta[slot] ?? { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 };
                  const next = {
                    ...meta,
                    [slot]: {
                      enabled: cur.enabled,
                      enforce: cur.enforce === true,
                      name: saved.name || cur.name,
                      url: "",
                      bytes: saved.bytes,
                      updatedAt: Date.now(),
                    },
                  };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: `模板「${slot}」已从目录选用（${saved.name}），记得点「开启注入」` });
                }
                const slot = String(body?.slot ?? "");
                if (!TEMPLATE_SLOTS.includes(slot)) {
                  return send(res, 400, { ok: false, error: { code: "bad-slot", message: `模板槽位须为 ${TEMPLATE_SLOTS.join("|")}` } });
                }
                const cur = meta[slot] ?? { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 };
                if (body?.action === "remove") {
                  const r = await removeTemplate(tplHome, slot);
                  if (!r.ok) return send(res, 400, r);
                  const next = { ...meta, [slot]: { ...cur, enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 } };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: `模板「${slot}」已清空` });
                }
                let saved = null;
                if (typeof body?.url === "string" && body.url.trim()) {
                  saved = await saveTemplateFromUrl(tplHome, slot, body.url);
                } else if (typeof body?.content === "string") {
                  // 编辑保存：可只带 content（name 保留现值）；也可带 name（本地导入）
                  saved = await saveTemplate(tplHome, slot, { name: (typeof body?.name === "string" && body.name.trim()) ? body.name : cur.name, content: body.content });
                }
                if (saved && saved.ok) {
                  const next = {
                    ...meta,
                    [slot]: {
                      enabled: cur.enabled, // 上传内容不自动开，用户再点开关
                      enforce: cur.enforce === true,
                      name: saved.name || cur.name,
                      url: typeof body?.url === "string" && body.url.trim() ? body.url.trim() : "",
                      bytes: saved.bytes,
                      updatedAt: Date.now(),
                    },
                  };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: `模板「${slot}」已保存，记得点「开启注入」` });
                }
                if (saved && !saved.ok) return send(res, 400, saved);
                if (typeof body?.enabled === "boolean") {
                  const next = { ...meta, [slot]: { ...cur, enabled: body.enabled } };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: body.enabled ? `模板「${slot}」已开启注入` : `模板「${slot}」已关闭` });
                }
                // v1.35.0：方案模板强制门禁开关（{slot:"plan", enforce:bool}）——即时生效，无需重启
                if (slot === "plan" && typeof body?.enforce === "boolean") {
                  const next = { ...meta, plan: { ...cur, enforce: body.enforce } };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: body.enforce
                    ? `方案模板强制门禁已开启（未出提案并获确认前，代码修改类工具调用被拒绝）`
                    : `方案模板强制门禁已关闭` });
                }
                return send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 {slot, name, content}（本地 md）、{slot, url}（在线 md）、{slot, enabled} 或 {slot:'plan', enforce}" } });
              }
              return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET/POST" } });
            } catch (error) {
              send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
            }
          },
        });

        // ---------- GET /api/session-conductor/templates/dir ----------
        // v1.31.0 模板目录浏览（「在工作区目录内找」）：列 DSH 工作区目录树内一层目录。
        // v1.33.0：浏览根与选用校验根同源（上方 browseRoot）；落盘仍在 DSH_HOME/template-inject-md/。
        // GET ?path=... → {ok, path, parent, entries:[{name,path,isDir,isMd}]}（缺省从工作区根开始）
        if (browseRoot) {
          webServer.register({
            kind: "exact",
            path: "/api/session-conductor/templates/dir",
            handler: async (req, res) => {
              try {
                // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
                if (req.method !== "GET") invalidateSessionListCache();
                if (req.method !== "GET") return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET" } });
                const url = new URL(req.url, "http://localhost");
                const path = url.searchParams.get("path") ?? "";
                const r = await listTemplateDir(browseRoot, path);
                if (!r.ok) return send(res, 400, r);
                return send(res, 200, r);
              } catch (error) {
                send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
              }
            },
          });
        }
      }
    }

    // ---------- GET /api/session-conductor/fts-status ----------
    // 全文搜索诊断（v1.19.0 并入，原独立插件 dsh-session-search 已合并）：
    // 报告官方 FTS5（sessionQuery）是否挂载 + 内置 zstd 扫描兜底是否可用。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/fts-status",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const sessionQuery = ctx.get("sessionQuery");
          const sessionEvents = ctx.get("sessionEvents");
          send(res, 200, {
            ok: true,
            plugin: "dsh-session-conductor",
            sessionQueryMounted: sessionQuery !== void 0,
            ftsMode: sessionQuery === void 0 ? "unavailable" : "first-search",
            builtinScanAvailable: typeof searchSessions === "function",
            note:
              sessionQuery === void 0
                ? "官方 FTS5 服务未挂载（检查 session-query-sqlite openAt 配置），使用内置 zstd 扫描兜底"
                : "官方 FTS5 内容搜索已解锁（openAt: first-search），内置 zstd 扫描为兜底",
          });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET/POST /api/session-conductor/compaction-model ----------
    // 压缩模型选择（2026-08-20）：会话模型旁单独选压缩用模型。
    // GET → {ok, compactionModel: {provider,model}|null, follow: true(跟随会话模型)}
    // POST {provider, model} → 设置；POST {follow:true} → 重置为跟随会话模型
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/compaction-model",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const domain = await pluginDomain(ctx);
          const state = domain.global.get();
          const cur = state.compactionModel ?? null;
          if (req.method === "GET") {
            return send(res, 200, { ok: true, compactionModel: cur, follow: cur === null });
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            if (body?.follow === true) {
              await domain.global.set({ ...state, compactionModel: null });
              return send(res, 200, { ok: true, compactionModel: null, follow: true, message: "压缩模型已重置为跟随会话模型" });
            }
            const provider = String(body?.provider ?? "").trim();
            const model = String(body?.model ?? "").trim();
            if (!provider || !model) return send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 provider 和 model" } });
            await domain.global.set({ ...state, compactionModel: { provider, model } });
            return send(res, 200, { ok: true, compactionModel: { provider, model }, follow: false, message: `压缩模型已设为 ${provider}/${model}（重启后生效）` });
          }
          return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET/POST" } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET/POST /api/session-conductor/auto-rename-model ----------
    // 自动重命名模型选择（v1.36.0）：设置页「DSH 同款解析选择器」选定。
    // GET → {ok, selection: {provider,model}|null, follow: true(跟随会话模型), catalog}
    //   catalog = 官方 modelCatalog（provider 分组 + 模型 + 默认），供前端渲染选择器。
    // POST {provider, model} → 设置；POST {follow:true} → 重置为跟随会话模型。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-rename-model",
      handler: async (req, res) => {
        try {
          const domain = await pluginDomain(ctx);
          const state = domain.global.get();
          const cur = state.autoRenameModel ?? null;
          if (req.method === "GET") {
            // 官方解析选择器的数据源：provider 分组 + 模型列表 + 部署默认
            let catalog = null;
            try {
              const sc = ctx.get("sessionController");
              catalog = sc?.modelCatalog ? await sc.modelCatalog() : null;
            } catch (error) {
              log(ctx, `auto-rename-model: 官方 modelCatalog 获取失败（前端仍可手动输入）: ${String(error?.message ?? error)}`);
              catalog = null;
            }
            return send(res, 200, { ok: true, selection: cur, follow: cur === null, catalog });
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            if (body?.follow === true) {
              await domain.global.set({ ...state, autoRenameModel: null });
              return send(res, 200, { ok: true, selection: null, follow: true, message: "自动重命名模型已重置为跟随会话模型" });
            }
            const provider = String(body?.provider ?? "").trim();
            const model = String(body?.model ?? "").trim();
            if (!provider || !model) return send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 provider 和 model" } });
            await domain.global.set({ ...state, autoRenameModel: { provider, model } });
            return send(res, 200, { ok: true, selection: { provider, model }, follow: false, message: `自动重命名模型已设为 ${provider}/${model}` });
          }
          return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET/POST" } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET/POST /api/session-conductor/auto-continue-gate ----------
    // 自动续跑全局闸门（2026-08-20，与 guardian 联动）：
    //   GET → {ok, gate: "open"|"closed", note}
    //   POST {gate:"open"|"closed"} → 设置；closed 时一切自动续跑跳过（周期扫描/scan 自动续跑部分）
    //   guardian 在 DSH 恢复健康时置 closed；用户手动开启或首次手动对话（turn/start user）后自动置 open
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-continue-gate",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const domain = await pluginDomain(ctx);
          const state = domain.global.get();
          const cur = state.autoContinueGate ?? "open";
          if (req.method === "GET") {
            return send(res, 200, {
              ok: true,
              gate: cur,
              note: cur === "closed"
                ? "自动续跑全局闸门关闭：一切自动续跑跳过（DSH 刚启动/崩溃恢复后），用户手动开启或第一次手动对话后自动放行"
                : "自动续跑全局闸门开放：按原有判定（单会话开关 → 全局默认）",
            });
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            const gate = String(body?.gate ?? "");
            if (gate !== "open" && gate !== "closed") {
              return send(res, 400, { ok: false, error: { code: "bad-request", message: 'gate 必须为 "open" 或 "closed"' } });
            }
            await domain.global.set({ ...state, autoContinueGate: gate });
            return send(res, 200, {
              ok: true,
              gate,
              message: gate === "closed" ? "自动续跑闸门已关闭（所有自动续跑暂停）" : "自动续跑闸门已开放",
            });
          }
          return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET/POST" } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/archive ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/archive",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const registry = ctx.get("workspaceRegistry");
          if (!registry) throw new Error("workspaceRegistry 服务不可用");
          // v1.20.0：归档时给标题加「[工作区名] 」前缀（数据层带前缀，面板显示剥离，已归档视图按前缀分组）。
          // 读会话 → 取原标题 → 加前缀 → rename（幂等：已带前缀不叠加）。失败不阻断归档。
          try {
            const sessions = ctx.get("sessions");
            const titleService = ctx.get("sessionTitle");
            const session = sessions?.get(body.sessionId);
            const cwd = session?.header?.cwd ?? null;
            const ws = workspaceNameOf(ctx, cwd);
            const currentTitle = titleString(titleService?.get(session)) ?? (session ? foldTitle(session.events) : null) ?? "";
            if (titleService && ws !== "" && currentTitle !== "") {
              const { title: newTitle } = archiveTitleWithWs(currentTitle, ws);
              if (newTitle !== currentTitle) {
                titleService.rename(session, newTitle);
                log(ctx, `归档加工作区前缀 ${body.sessionId}: "${currentTitle}" → "${newTitle}"`);
              }
            }
          } catch (titleError) {
            log(ctx, `归档标题加前缀失败（不阻断归档）: ${String(titleError?.message ?? titleError)}`);
          }
          await registry.archiveSession(body.sessionId);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "archive-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/unarchive ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/unarchive",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          // v1.20.0：取消归档时去掉「[工作区名] 」前缀还原原标题（数据层带前缀，取消归档即还原）。
          try {
            const sessions = ctx.get("sessions");
            const titleService = ctx.get("sessionTitle");
            const session = sessions?.get(body.sessionId);
            const currentTitle = titleString(titleService?.get(session)) ?? (session ? foldTitle(session.events) : null) ?? "";
            if (titleService && currentTitle !== "") {
              const { title: stripped } = stripArchiveWsPrefix(currentTitle);
              if (stripped !== currentTitle) {
                titleService.rename(session, stripped);
                log(ctx, `取消归档还原标题 ${body.sessionId}: "${currentTitle}" → "${stripped}"`);
              }
            }
          } catch (titleError) {
            log(ctx, `取消归档还原标题失败（不阻断）: ${String(titleError?.message ?? titleError)}`);
          }
          await unarchiveSession(ctx, body.sessionId);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "unarchive-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const result = await deleteSession(ctx, body.sessionId);
          if (!result.ok) return send(res, 409, result);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/undo-message ----------
    // 撤回最后一条用户消息（v1.22.0）：直接操作会话日志文件，删除最后一条 user/message
    // 及其后的整轮回复；dryRun=true 只返回预览（消息文本/将删事件数）不执行；二次确认由前端做。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/undo-message",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const result = await undoLastMessage(ctx, body.sessionId, { dryRun: body?.dryRun === true });
          if (!result.ok) return send(res, 409, result);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "undo-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete-batch ----------
    // 批量删除（v1.19.0）：逐条复用删除链路（per-session 串行锁/幂等），运行中跳过不整体失败
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete-batch",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          // 2026-08-20 修复：空数组（[]）是合法幂等请求，应返回空结果而非报错；
          // 仅「未传/非数组」才视为参数缺失
          if (body?.sessionIds !== void 0 && !Array.isArray(body.sessionIds)) {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "sessionIds 必须是数组" } });
          }
          const result = await deleteBatchSessions(ctx, body?.sessionIds ?? []);
          send(res, 200, { ok: true, ...result });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-batch-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete-by-rule ----------
    // 按条件删除（v1.19.0）：归档状态/超期未活跃/cwd 前缀；dryRun=true 预览不执行
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete-by-rule",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const result = await deleteByRule(ctx, {
            archivedOnly: body?.archivedOnly === true,
            inactiveDays: typeof body?.inactiveDays === "number" && Number.isFinite(body.inactiveDays)
              ? Math.min(3650, Math.max(0, Math.round(body.inactiveDays)))
              : 0,
            cwdPrefix: typeof body?.cwdPrefix === "string" ? body.cwdPrefix : "",
            dryRun: body?.dryRun === true,
          });
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-by-rule-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/search ----------
    // 全文搜索（v1.19.0）：跨会话搜消息内容，返回命中会话 + 上下文片段
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/search",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const query = typeof body?.query === "string" ? body.query : "";
          const scope = ["all", "active", "archived"].includes(body?.scope) ? body.scope : "all";
          if (query.trim().length < SEARCH_MIN_QUERY) {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: `关键词至少 ${SEARCH_MIN_QUERY} 个字符` } });
          }
          const result = await searchSessions(ctx, query, { scope });
          send(res, 200, { ok: true, ...result });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "search-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/auto-rename ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-rename",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const enabled = body.enabled === true;
          const setting = await patchSwitch(ctx, "autoRename", body.sessionId, { enabled }, { enabled: false });
          let analyzed = null;
          if (enabled) analyzed = await runAnalysis(ctx, body.sessionId); // 开启后立即分析一次
          send(res, 200, { ok: true, enabled: setting.enabled, analyzed });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "auto-rename-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/analyze ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/analyze",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const result = await runAnalysis(ctx, body.sessionId, {
            manual: true, // 手动 API：跳过限频/新消息数门槛（显式意图即执行）
            model: typeof body?.model === "string" && body.model !== "" ? body.model : undefined,
          });
          if (!result.ok) return send(res, 409, result);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "analyze-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/continue ----------
    // 手动续跑：异步执行（回合可能耗时数分钟），立即返回 accepted，列表用 continueRunning 反映进行中。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/continue",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const sessionId = body.sessionId;
          const running = continueJobs.has(sessionId) || (() => {
            try {
              const agent = ctx.get("agents")?.get(sessionId);
              return agent?.status === "running";
            } catch {
              return false;
            }
          })();
          if (running) {
            return send(res, 409, { ok: false, error: { code: "busy", message: "该会话已有续跑/回合在进行中" } });
          }
          continueSession(ctx, sessionId, { auto: false }).then((result) => {
            if (!result?.ok) log(ctx, `手动续跑 ${sessionId} 未成功: ${result?.error?.message ?? "?"}`);
          }).catch((error) => {
            // v1.35.6：手动续跑异步链兜底——continueSession 永不 reject（prepare 段已包 try），
            // 此处再兜一层防未来回归把 rejection 逃逸成 unhandledRejection 杀进程。
            log(ctx, `手动续跑 ${sessionId} 异常: ${String(error?.message ?? error)}`);
          });
          send(res, 200, { ok: true, accepted: true, sessionId });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "continue-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/message ----------
    // 跨会话消息投递（2026-08-20）：{targetSessionId, message, fromSessionId?}
    // 向目标会话投递用户消息并唤起（live followup / cold resume+followup），不受"中断"限制。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/message",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const sessionId = body?.targetSessionId || body?.sessionId;
          const text = body?.message;
          if (typeof sessionId !== "string" || sessionId === "" || typeof text !== "string" || text === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 targetSessionId 或 message" } });
          }
          // 异步执行（回合可能耗时），立即返回 accepted
          const r = await sendMessageToSession(ctx, sessionId, text, { fromSessionId: body?.fromSessionId || "" });
          return send(res, r.ok ? 200 : (r.error?.code === "not-found" ? 404 : 400), r);
        } catch (error) {
          return send(res, 400, { ok: false, error: { code: "message-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/auto-continue ----------
    // 开启/关闭某会话的自动续跑（显式 enabled 覆盖全局默认）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-continue",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const enabled = body.enabled === true;
          // 2026-09-27：开关落盘 config.json；先取旧 entry 保留记账字段，enabled 以本次为准。
          const entry = readSwitch("autoContinue", body.sessionId) ?? {};
          await patchSwitch(ctx, "autoContinue", body.sessionId, { ...entry, enabled });
          // v1.35.6：开启开关即触发一次续跑（force 跳过失败重试延迟）——原先要等最长
          // scanIntervalMs（默认 5 分钟）周期扫描才续，用户体感「打开后处理中很久」。
          // 关闭开关不触发；开启是幂等触发点，重复点不会叠加（内部有会话串行锁 + 门槛）。
          if (enabled) {
            runAutoContinueSession(ctx, body.sessionId, { force: true }).catch((error) => {
              log(ctx, `开启自动续跑后立即续跑失败 ${body.sessionId}: ${String(error?.message ?? error)}`);
            });
          }
          send(res, 200, { ok: true, enabled, sessionId: body.sessionId, triggered: enabled });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "auto-continue-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/scan ----------
    // 立即扫描一次全部会话并自动续跑（测试/手动触发用）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/scan",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          runAutoScan(ctx).then((count) => {
            log(ctx, `手动扫描完成（排队 ${count ?? 0}）`);
          }).catch((error) => {
            log(ctx, `手动扫描失败: ${String(error?.message ?? error)}`);
          });
          send(res, 200, { ok: true, accepted: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "scan-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/detach ----------
    // 手动释放（置为不活跃）：把 live 空闲会话拆回冷状态（日志保留，可重新挂载）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/detach",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const result = await detachSessionAgent(ctx, body.sessionId);
          if (!result.ok) return send(res, 409, result);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "detach-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/detach-all ----------
    // 释放全部 live 空闲会话（跳过运行中 / subagent / 续跑中）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/detach-all",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const result = await detachAllIdleSessions(ctx);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "detach-all-failed", message: String(error?.message ?? error) } });
        }
      },
    });


    // ---------- 会话日志修复（扫描/修复损坏会话） ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-sessions",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const { supportsRepair } = await lazyRepair();
          if (!supportsRepair(ctx)) {
            return send(res, 501, { ok: false, error: { code: "unsupported", message: "当前持久化后端不支持修复（需要 jsonl 后端）" } });
          }
          const dryRun = body?.dryRun === true;
          const { scanCorruptSessions, repairCorruptSessions } = await lazyRepair();
          const report = dryRun ? await scanCorruptSessions(ctx) : await repairCorruptSessions(ctx, { dryRun: false });
          if (report.error) return send(res, 500, { ok: false, error: { code: "repair-failed", message: report.error } });
          send(res, 200, { ok: true, dryRun, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/repair-frames ----------
    // 会话日志 zstd 帧修复（救援恢复，2026-08-19）：会话列表消失/corrupt Zstandard 时，
    // 扫描并修复帧损坏（逐帧解码→多帧正确写回，自动备份）。与 repair-sessions 互补：
    // repair-sessions 修 tool-result content 结构；repair-frames 修 zstd 帧格式。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-frames",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const dryRun = body?.dryRun === true;
          const { scanCorruptFrames, repairCorruptFrames } = await lazyRepair();
          const report = dryRun ? await scanCorruptFrames() : await repairCorruptFrames({ dryRun: false });
          send(res, 200, { ok: true, dryRun, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-frames-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/repair-seq-gap ----------
    // 会话日志 seq-gap + token-surface 修复（2026-08-24 实测）：
    //   seq gap 错位（spliced 拼接未重编号）+ replace 引用缺失 + compaction shadowedRange 未映射
    //   三层叠加导致 history unavailable（token surface: no adjacent shadow price）。
    //   dryRun=true 扫描全部会话列出疑似 seq-gap；sessionId 指定则修复单个（自动备份 .seq-gap-backup/）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-seq-gap",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const sessionsRoot = path.join(process.env.DSH_HOME || path.join(process.env.HOME ?? "", ".dsh"), "sessions");
          if (body?.dryRun === true) {
            const { scanSeqGapSessions } = await lazySeqGap();
            const list = await scanSeqGapSessions(sessionsRoot);
            send(res, 200, { ok: true, dryRun: true, corrupt: list, total: list.length });
            return;
          }
          const sessionId = body?.sessionId;
          if (!sessionId) { send(res, 400, { ok: false, error: { code: "session-id-required", message: "need sessionId" } }); return; }
          // 定位会话日志路径（sessionId 需含 session- 前缀，cwd 目录未知 → 全仓查找）
          const { readdirSync, existsSync } = await import("node:fs");
          let targetPath = null;
          for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
            if (!proj.isDirectory()) continue;
            const p = path.join(sessionsRoot, proj.name, sessionId, "session.jsonl.zstd");
            if (existsSync(p)) { targetPath = p; break; }
          }
          if (!targetPath) { send(res, 404, { ok: false, error: { code: "session-not-found", message: sessionId } }); return; }
          const { repairSeqGap } = await lazySeqGap();
          const report = await repairSeqGap(targetPath, { dryRun: false });
          send(res, report.ok ? 200 : 400, { ok: report.ok, sessionId, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-seq-gap-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/repair-eio ----------
    // 会话日志 EIO 坏块修复（2026-09-06 实测固化，来源 sa6400-nested-vm-io-panic skill）：
    //   底层存储（BTRFS csum 损坏 / iSCSI LUN I/O 错误）导致 session.jsonl.zstd 某些 4KB 块
    //   读取抛 EIO（Errno 5）→ 网关 observe 会话报 "EIO: i/o error, read"。
    //   修复 = 块级探测找出第一个 EIO 边界 → 读 [0, 边界) 完好前缀 → 原子写回
    //   （BTRFS COW 换新块）→ DSH 加载时 readZstdPrefix/commitRepair 自动收尾 torn tail。
    //   dryRun=true 全仓扫描；sessionId 指定则修复单个（全仓定位）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-eio",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const { sessionsRootOf: eioSessionsRootOf } = await lazyEio();
          const sessionsRoot = eioSessionsRootOf();
          if (body?.dryRun === true) {
            const { scanEioSessions } = await lazyEio();
            const list = await scanEioSessions(sessionsRoot);
            send(res, 200, { ok: true, dryRun: true, eio: list.eio, total: list.total, healthy: list.healthy, error: list.error });
            return;
          }
          const sessionId = body?.sessionId;
          if (sessionId) {
            // 定位会话日志路径（sessionId 需含 session- 前缀，cwd 目录未知 → 全仓查找）
            const { readdirSync, existsSync } = await import("node:fs");
            let targetPath = null;
            for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
              if (!proj.isDirectory()) continue;
              const p = path.join(sessionsRoot, proj.name, sessionId, "session.jsonl.zstd");
              if (existsSync(p)) { targetPath = p; break; }
            }
            if (!targetPath) { send(res, 404, { ok: false, error: { code: "session-not-found", message: sessionId } }); return; }
            const { repairEioFile } = await lazyEio();
            const report = await repairEioFile(targetPath);
            send(res, report.ok ? 200 : 400, { ok: report.ok, sessionId, report });
            return;
          }
          const { repairEioSessions } = await lazyEio();
          const report = await repairEioSessions({ dryRun: false });
          send(res, 200, { ok: true, dryRun: false, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-eio-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/repair-dual-format ----------
    // 双格式会话修复（v1.35.2）：会话目录同时存在 session.jsonl（明文）+ session.jsonl.zstd
    // （压缩）→ 官方 listArtifacts() 抛 encodingMismatch → 会话列表全失败（侧边栏会话消失）。
    // 纯磁盘级扫描（不走 sessionPersistence，后者自身会被 encodingMismatch 阻断），
    // 把多余明文移入 .dual-format-backup/ 保留 zstd 官方格式；dryRun=true 只扫不写。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-dual-format",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const dryRun = body?.dryRun === true;
          // live 会话跳过：正在写入的会话不应被移动（按 id 查 sessions 服务）
          let skipIds = [];
          try {
            const sessionsSvc = ctx.get("sessions");
            skipIds = (sessionsSvc?.list?.() ?? []).map((s) => s.id);
          } catch {
            // sessions 服务不可用时不做 live 跳过（保守：仍只移非 live 目录）
          }
          const report = dryRun
            ? await (await lazyRepair()).scanDualFormatSessions()
            : await repairDualFormatSessions({ dryRun: false, skipIds });
          if (report.error) {
            send(res, 500, { ok: false, error: { code: "repair-dual-format-failed", message: report.error } });
            return;
          }
          send(res, 200, { ok: true, dryRun, skipped: report.skipped ?? 0, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-dual-format-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/value-analysis ----------
    // 会话价值分析（v1.11.0 规则判定 + v1.20.0 特征/LLM/关键词价值）：
    //   规则分类 completed/unfinished/stale/active + 最后回复摘要；
    //   高/低价值 = assessValue 特征评分（活跃/长度/完成/未完成/细节补充）；
    //   可选 body.keywords=[...] 记录指定关键词 → 标题/最后用户消息命中任一关键词的会话无条件最高价值；
    //   可选 body.llm=true 额外用 LLM 打分（fail-soft）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/value-analysis",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const staleDays = typeof body?.staleDays === "number" && Number.isFinite(body.staleDays)
            ? Math.min(90, Math.max(1, Math.round(body.staleDays)))
            : 3;
          const useLlm = body?.llm === true;
          const sessions = await buildSessionListCached(ctx); // v1.35.10：价值分析走缓存（容忍 5s 陈旧，避免与面板刷新叠加扫描）
          // 一次性读取各会话事件（复用，避免大会话重复解压导致超时/失败）
          const eventsById = {};
          // 逐个会话读取最后 assistant 文本 + 最后用户消息（损坏/不可读会话跳过，用空串）
          const texts = {};
          const userTexts = {};
          for (const s of sessions) {
            try {
              const found = await sessionEventsOf(ctx, s.id);
              if (found) {
                eventsById[s.id] = found.events || [];
                const { lastAssistantText, lastUserText, filterSessionsByKeywords } = await lazyValue();
                texts[s.id] = lastAssistantText(found.events);
                userTexts[s.id] = lastUserText(found.events);
              }
            } catch {
              /* 单会话失败跳过 */
            }
          }
          // 可选 LLM 高/低价值判断
          let llmById = {};
          if (useLlm) {
            llmById = await analyzeValueWithLlm(ctx, sessions, texts, (m) => log(ctx, m));
          }
          // 特征评分（活跃/长度/完成/未完成/细节补充）+ 关键词命中→无条件最高
          const featuresById = {};
          for (const s of sessions) {
            try {
              const { buildValueFeatures } = await lazyValue();
              featuresById[s.id] = buildValueFeatures(eventsById[s.id] || [], s, new Date());
            } catch {
              const { buildValueFeatures: buildValueFeatures2 } = await lazyValue();
              featuresById[s.id] = buildValueFeatures2([], s, new Date());
            }
          }
          const keywords = Array.isArray(body?.keywords) ? body.keywords : [];
          const { analyzeValuesWithKeywords } = await lazyValue();
          const result = analyzeValuesWithKeywords(sessions, texts, userTexts, featuresById, keywords, llmById, new Date(), staleDays);
          const counts = {};
          for (const key of Object.keys(result)) counts[key] = result[key].length;
          send(res, 200, {
            ok: true,
            staleDays,
            llm: !!useLlm,
            keywords: keywords.length ? keywords : void 0,
            keywordHits: keywords.length ? filterSessionsByKeywords(sessions, texts, userTexts, keywords, new Date()) : [],
            generatedAt: Date.now(),
            counts,
            completed: result.completed,
            unfinished: result.unfinished,
            stale: result.stale,
            active: result.active,
            high: result.high,
            low: result.low,
          });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "value-analysis-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- 任务完成汇报（task-completion-report 管道） ----------
    // v1.33.1：收尾约定不再由代码写死注入 systemPrompt——改由模板注入「收尾模板」槽位承担
    // （设置 → 会话管理 → 模板注入 → closing，可自定义内容）。render/check 校验工具保留。
    webServer.register({
      kind: "exact",
      path: "/api/task-completion/status",
      handler: async (req, res) => {
        send(res, 200, {
          ok: true,
          name: "dsh-session-conductor",
          skill: "task-completion-report",
          conventionSource: "template-inject:closing（v1.33.1 起不再代码写死，由收尾模板槽位注入）",
          tools: ["task_completion_render", "task_completion_check"]
        });
      },
    });

    webServer.register({
      kind: "exact",
      path: "/api/task-completion/render",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const block = renderCompletionBlock(body);
          send(res, 200, { ok: true, block });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "render-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    webServer.register({
      kind: "exact",
      path: "/api/task-completion/check",
      handler: async (req, res) => {
        try {
          // v1.35.10：非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.text !== "string") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 text" } });
          }
          send(res, 200, { ok: true, ...checkCompletionText(body.text) });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "check-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    log(ctx, `API 路由已注册 (/api/session-conductor/* + /api/task-completion/*)；自动续跑: enabled=${cfg.enabled}, 默认开启=${cfg.defaultAutoContinue}, maxAttached=${cfg.maxAttached}, maxConcurrent=${cfg.maxConcurrent}`);
  });


  // 任务完成汇报：约定注入每个 agent 系统提示 + 渲染/校验工具。
  // ── v1.35.0 方案模板强制门禁（tools/pre-execute waterfall）────────────────
  // 无状态判定：每次拦截从会话事件流现场推导门状态——「提案」= 确认消息之前那一段 AI 输出里
  // 同时含提案标题与确认段标记；「确认」= 最后一条真实用户消息命中确认词。重启零恢复问题，
  // 门状态永远由真实事件流现场推导。delegationDepth>0 的子 agent 会话豁免（子 agent 无法交互
  // 确认；主会话是强制执行点，注入文本约定主 AI 不得借委派绕过门禁）。
  // ⚠️ waterfall 契约：不拦时必须 next()，否则短路整条链（hooks 桥同款写法，见 PreToolUse 映射）。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      const meta = templateStateCache || TEMPLATE_DEFAULTS;
      if (meta?.plan?.enforce !== true) return next();
      const session = exec?.agent?.session;
      if (!session) return next();
      if ((session?.header?.delegationDepth ?? 0) > 0) return next();
      const name = String(exec?.name ?? "");
      let gated = PLAN_ENFORCE_EDIT_TOOLS.includes(name);
      if (!gated && name === "bash") {
        const cmd = exec?.arguments?.command ?? exec?.arguments?.cmd ?? "";
        gated = typeof cmd === "string" && PLAN_ENFORCE_BASH_WRITE_RE.test(cmd);
      }
      if (!gated) return next();
      if (planGateAllows(session.events)) return next();
      return { kind: "deny", reason: planEnforceDenyMessage(name) };
    } catch (error) {
      // 门禁自身故障 fail-open（不阻断工具链），只留痕
      log(ctx, `方案门禁判定异常（放行）: ${String(error?.message ?? error)}`);
      return next();
    }
  });

  // systemPrompt / tools 可能不在所有组合中，缺失时静默跳过，不影响插件其余功能。
  ctx.inject(["systemPrompt"], (sctx) => {
    try {
      sctx.get("systemPrompt").section({
        name: "task-completion-report",
        order: 1000,
        text: TASK_COMPLETION_CONVENTION
      });
    } catch (error) {
      log(ctx, `systemPrompt 注入失败: ${String(error?.message ?? error)}`);
    }
  });

  // v1.38.0：方案/收尾模板改走**上下文注入**（agent/pre-step，每 agent 首次 step 注入一次，
  // 参考同款形态）——不再塞 systemPrompt section（上下文与系统提示词是两回事，
  // 方案模板一条、收尾模板一条，各带自己的说明，一开始就注入）。
  // 模板内容同步读盘 + templateStateCache（templates API 写入后刷新），enabled 才注入对应条。
  const templateInjectedAgents = new WeakSet();
  if (typeof ctx?.on === "function") {
    const tplDshHome = resolveDshHome(ctx, cfg);
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision?.kind === "reject" || signal?.aborted) return decision;
      if (!agent || templateInjectedAgents.has(agent)) return decision;
      templateInjectedAgents.add(agent);
      try {
        if (!tplDshHome) return decision;
        const metas = templateStateCache ?? TEMPLATE_DEFAULTS;
        const injected = [];
        for (const slot of TEMPLATE_SLOTS) {
          const text = collectTemplateSlotText(tplDshHome, slot, metas);
          if (!text) continue;
          injected.push(createUserMessage({
            content: [{ type: "text", text: `【dsh-session-conductor 模板注入（设置 → 会话管理 → 模板注入）】\n\n${text}` }],
            source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor", form: "instructions" },
          }));
        }
        if (injected.length === 0) return decision;
        return { ...decision, messages: [...(decision.messages || []), ...injected] };
      } catch (error) {
        log(ctx, `会话模板上下文注入失败: ${String(error?.message ?? error)}`);
        return decision;
      }
    });
  }


  ctx.inject(["tools"], (tctx) => {
    const tools = tctx.get("tools");
    tools.register(defineTool({
      name: "task_completion_render",
      description: "渲染任务完成汇报的标准收尾块（醒目分隔线 + ✅ 任务完成 + 交付/验证/遗留 三要素）。任务结束前调用，把返回的文本原样贴到回复结尾。",
      parameters: {
        delivered: { type: "string", description: "交付了什么：文件路径 / 功能 / 结论，可多行" },
        verified: { type: "string", description: "验证状态：实测通过 / 单测通过 / 待人工确认，必须如实" },
        remaining: { type: "string", description: "遗留事项：已知边界 / 待办 / 坑，没有可省略" },
        status: { type: "string", enum: VALID_STATUSES, description: "done=任务完成（默认） / partial=未完成 / failed=失败" }
      },
      output: {
        schema: { type: "string" },
        // ⚠️ 必须返回块数组：tool-result 的 block.content 落盘后会被
        // dsh-session 持久化校验器要求为数组（`message must contain one
        // tool-result block`）；返回纯字符串会导致会话日志损坏（history
        // unavailable）。与官方 bash 工具的 render 模式一致。
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute(args) {
        return renderCompletionBlock(args);
      }
    }));
    tools.register(defineTool({
      name: "task_completion_check",
      description: "校验一段文本是否符合任务完成收尾格式（分隔线/完成标记/交付/验证/遗留）。写完成汇报后自检用，返回缺失项。",
      parameters: {
        text: { type: "string", required: true, description: "要校验的文本（通常是回复的结尾段）" }
      },
      output: {
        schema: { type: "string" },
        // 与 task_completion_render 相同：block.content 必须是块数组，否则落盘损坏
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute(args) {
        const check = checkCompletionText(args.text);
        return check.ok
          ? "收尾格式合规"
          : `收尾格式缺项：${check.missing.join("、")}（分隔线/完成标记/交付/验证/遗留）`;
      }
    }));
    log(ctx, "任务完成汇报工具已注册 (task_completion_render / task_completion_check)");
  });
}

function log(ctx, message) {
  try {
    ctx.logger.info(`dsh-session-conductor: ${message}`);
  } catch {
    console.log(`[dsh-session-conductor] ${message}`);
  }
}
