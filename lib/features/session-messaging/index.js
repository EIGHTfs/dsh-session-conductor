// dsh-session-conductor — 跨会话消息 + 指定模型新建会话（AI 工具域）
//
// 【本域职责】给 AI 三个可直接调用的工具：
//   · list_sessions    列出本机会话（挑投递目标用）
//   · send_to_session  给指定会话投递一条消息（目标空闲时由本体唤醒）
//   · create_session   新建会话，可指定 provider/model，可选带初始消息
//
// 【为什么全部走本体官方 API，而不是自己写会话日志】
//   本体把「投递一条消息给某个会话」做成一等公民：session-controller 的
//   `@Remote('prompt')`，其受理流程**会先 resume 目标会话**（唤醒语义由本体保证），
//   且请求带 `requestId` 幂等键（本体把它持久化在那条被接受的消息上）。
//   反面：会话日志里 inbox 家族**只有 `agent/inbox/spliced` 落盘**，而它的 fold
//   对非法 splice **直接抛错**（message.id 重复、start 越界都会让整份会话读不出来）
//   —— 自己写日志等于拿对方会话的完整性冒险。因此本域**不碰任何日志文件**。
//
// 【工具注册约定】照 lib/features/context-usage 的写法：注册函数返回 boolean，
//   由 apply.js 在 inject('tools') 回调里调用。`defineTool` 必须由调用方显式传入
//   —— 本项目历史事故：文件里直接用 defineTool 却从未导入 ⇒ 该回调抛
//   ReferenceError ⇒ 同批工具全部注册不上（详见 lib/apply.js 的注释）。

import { log } from "../../shared/log.js";

/**
 * 懒加载会话列举。
 * 为什么不在顶层 import：`sessions/list.js` 会拉起 `core/domain.js` →
 * `@deepseek-ai/dsh-storage-domain`（宿主包），工作区里解析不到 ⇒ 本模块将无法被单测
 * 直接 import。改为用到时再加载，行为不变但模块可独立测试（同 apply.js 的懒加载思路）。
 */
async function listSessions(ctx) {
  const { buildSessionListCached } = await import("../../sessions/list.js");
  return buildSessionListCached(ctx, {});
}

/** 单条消息长度上限（字符）：够写交接要点，不够塞长文档（长内容应落共享文件）。 */
const TEXT_LIMIT = 8 * 1024;
/** 协作链跳数上限：到了就说明该改用共享文件交接，而不是继续互相投递。 */
const HOPS_LIMIT = 3;
/** 限流窗口与条数：同一对会话在该窗口内最多投这么多条，防互相唤醒风暴。 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
/** 本体 prompt 受理是本地操作，给足超时但别无限等。 */
const PROMPT_TIMEOUT_MS = 60_000;

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 会话条目 → 状态词（running=正在跑回合 / idle=已挂载空闲 / inactive=冷会话）。 */
function statusOf(item) {
  if (item?.running) return "running";
  return item?.live ? "idle" : "inactive";
}

/**
 * 把会话列表渲染成给 AI 看的文本（纯函数，便于单测）。
 * @param items buildSessionListCached 的产出
 * @param selfId 当前会话 id（用于标出「当前会话」，可为 null）
 * @returns {string} 多行文本；空列表时返回固定提示
 */
export function formatSessionList(items, selfId) {
  if (!Array.isArray(items) || items.length === 0) return "没有可见会话。";
  const lines = items.map((item) => {
    const flags = [statusOf(item)];
    if (item?.archived) flags.push("已归档");
    if (selfId && item?.id === selfId) flags.push("← 当前会话");
    return `- ${item?.id} ｜ ${String(item?.title ?? "(无标题)")} ｜ ${String(item?.cwd ?? "(无工作区)")}`
      + ` ｜ ${flags.join(" / ")} ｜ 最后活动 ${formatTime(item?.updatedAt)}`;
  });
  return `共 ${items.length} 个会话：\n${lines.join("\n")}`;
}

/** 取本体 sessionController 服务（本插件既有取法，见 features/member-model/switch.js）。 */
function sessionControllerOf(ctx) {
  try {
    return ctx.get?.("sessionController") ?? null;
  } catch {
    return null;
  }
}

/** 当前会话 id（用于禁自投与 isSelf 标记）。 */
function currentSessionId(agent) {
  return agent?.session?.id ?? null;
}

/** 把远端错误压成「短码: 原文」一行，便于回执如实说明失败原因。 */
function shortError(error) {
  const code = error?.code ?? error?.name ?? "";
  const msg = String(error?.message ?? error);
  return code ? `${code}: ${msg}` : msg;
}

/** 本体错误码 → 本工具回执的短码（认不出就标 unknown，不臆造）。 */
function mapPromptError(error) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
  if (/session\/not-found/.test(text)) return "session-not-found";
  if (/session\/agent-busy/.test(text)) return "target-busy";
  if (/session\/model-unavailable/.test(text)) return "target-no-model";
  if (/gateway\/bad-request/.test(text)) return "bad-request";
  if (/session\/attachment-invalid/.test(text)) return "attachment-invalid";
  if (/session\/invalid-time-zone/.test(text)) return "bad-time-zone";
  return "unknown";
}

/** 时间戳 → 本地可读时间（无值时不假装有值）。 */
function formatTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "(未知)";
  try {
    return new Date(n).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(n);
  }
}

// ── 限流与在途去重（进程内；重启即清空，不落盘）────────────────────────────

/** `${from}->${to}` → 投递时间戳数组。 */
const rateBuckets = new Map();
/** 正在投递的 requestId（防同一请求并发重复）。 */
const inFlight = new Set();

/** 测试用：清空限流与在途状态。 */
export function resetMessagingStateForTest() {
  rateBuckets.clear();
  inFlight.clear();
}

/** 同一对会话是否已超限（未超则记一次）。 */
function hitRateLimit(from, to, now = Date.now()) {
  const key = `${from ?? "?"}->${to}`;
  const hits = (rateBuckets.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return false;
}

/** 生成幂等键：本体把它持久化在那条被接受的消息上，重试传同键不会重复投递。 */
function newRequestId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `sc-${Date.now().toString(36)}-${rand}`;
}

/** 文本 → 本体要求的 content 块数组（字段名以 types.ts 的 PromptContentPart 为准）。 */
function contentOf(text) {
  return [{ type: "text", text: String(text) }];
}

/** 投递一条消息到目标会话（走本体官方 prompt；目标空闲时会被 resume 唤醒）。 */
function deliverPrompt(sc, { sessionId, text, mode, requestId }) {
  // 本体签名是 prompt(request, signal)：signal 必传（内部会 throwIfAborted）。
  return sc.prompt(
    { requestId, sessionId, mode, content: contentOf(text) },
    AbortSignal.timeout(PROMPT_TIMEOUT_MS),
  );
}

// ── 工具：list_sessions ───────────────────────────────────────────────────

function registerListSessions(ctx, defineTool, tools) {
  tools.register(defineTool({
    name: "list_sessions",
    description:
      "列出本机 DSH 的会话（id / 标题 / 工作区 / 状态 / 最后活动 / 是否当前会话），"
      + "供 send_to_session 挑目标。只读、无参数。"
      + "状态含义：running=正在跑回合；idle=已挂载但空闲；inactive=冷会话（未挂载，投递时会被唤醒）。",
    parameters: {},
    output: {
      schema: { type: "string" },
      render(args, value) {
        return [{ type: "text", text: String(value) }];
      },
    },
    async execute(_args, exec) {
      try {
        const items = await listSessions(ctx);
        return formatSessionList(items, currentSessionId(exec?.agent));
      } catch (error) {
        return `列出会话失败：${shortError(error)}`;
      }
    },
  }));
}

// ── 工具：send_to_session ─────────────────────────────────────────────────

function registerSendToSession(ctx, defineTool, tools) {
  tools.register(defineTool({
    name: "send_to_session",
    description:
      "给另一个 DSH 会话投递一条消息（不经过人转达）。目标空闲时本体会自动唤醒它跑一个回合；"
      + "目标运行中则排到其下一回合边界（mode=steer 可改为注入当前回合）。"
      + "短消息、要对方立刻行动时用它；长内容/需可追溯的交接请落共享文件，这里只发路径与要点。",
    parameters: {
      sessionId: { type: "string", required: true, description: "目标会话 id（用 list_sessions 取）" },
      text: { type: "string", required: true, description: `消息正文（纯文本，≤${TEXT_LIMIT} 字符）` },
      mode: { type: "string", description: "queue（默认：排到目标下一回合，空闲时唤醒它）或 steer（注入目标正在跑的回合）" },
      requestId: { type: "string", description: "可选幂等键；重试时传同一个值可避免重复投递" },
      hops: { type: "number", description: `协作链跳数（AI 之间互相投递时自增；≥${HOPS_LIMIT} 会被拒绝，提示改用共享文件）` },
    },
    output: {
      schema: { type: "string" },
      render(args, value) {
        return [{ type: "text", text: String(value) }];
      },
    },
    async execute(args, exec) {
      const from = currentSessionId(exec?.agent);
      const to = String(args?.sessionId ?? "").trim();
      const text = String(args?.text ?? "");
      const mode = args?.mode === "steer" ? "steer" : "queue";
      const hops = Number(args?.hops ?? 0);
      // 本地能判的一律先判（省一次无谓 RPC，且错误更明确）
      if (!to) return "投递失败：sessionId 必填（先用 list_sessions 查目标）";
      if (from && to === from) return "投递失败：不能投给自己（禁止自投，避免自我唤醒死循环）";
      if (!text.trim()) return "投递失败：text 不能为空";
      if (text.length > TEXT_LIMIT) {
        return `投递失败：text 超长（${text.length} > ${TEXT_LIMIT} 字符）——长内容请落共享文件后只发路径`;
      }
      if (Number.isFinite(hops) && hops >= HOPS_LIMIT) {
        return `投递失败：协作链跳数已达上限（hops=${hops} ≥ ${HOPS_LIMIT}）——请改用共享文件交接，不要继续互相投递`;
      }
      const sc = sessionControllerOf(ctx);
      if (!sc || typeof sc.prompt !== "function") {
        return "投递失败：sessionController.prompt 不可用（本体未挂载该服务或版本不支持）";
      }
      if (hitRateLimit(from, to)) {
        return `投递失败：限流（同一对会话 ${RATE_WINDOW_MS / 1000}s 内最多 ${RATE_MAX} 条）——稍后再试，或改用共享文件`;
      }
      const requestId = String(args?.requestId ?? "").trim() || newRequestId();
      if (inFlight.has(requestId)) return `投递失败：同一 requestId 正在投递中（${requestId}）`;
      inFlight.add(requestId);
      try {
        await deliverPrompt(sc, { sessionId: to, text, mode, requestId });
        log(ctx, `跨会话投递 ${from ?? "?"} → ${to}（mode=${mode} requestId=${requestId} hops=${hops}）`);
        return `已投递到 ${to}（mode=${mode} ｜ requestId=${requestId}）。`
          + (mode === "steer"
            ? "目标是运行中会话：消息已注入其当前回合。"
            : "目标空闲时本体已自动唤醒它；目标运行中则在其下一回合边界消费。")
          + " 回执只表示本体已受理，不代表对方已处理完。";
      } catch (error) {
        return `投递失败（${mapPromptError(error)}）：${shortError(error)}`;
      } finally {
        inFlight.delete(requestId);
      }
    },
  }));
}

// ── 工具：create_session ──────────────────────────────────────────────────

function registerCreateSession(ctx, defineTool, tools) {
  tools.register(defineTool({
    name: "create_session",
    description:
      "新建一个 DSH 会话；可指定 provider/model（建完立即切到该模型），可选带一条初始消息（立刻让它开始干活）。"
      + "只新建，不删除、不修改其它会话。",
    parameters: {
      provider: { type: "string", description: "模型 provider 分组名（list_models 输出的顶层分组，如 wb）；与 model 成对给出" },
      model: { type: "string", description: "该 provider 下的模型 id（如 global:deepseek-v4.1-flash）；与 provider 成对给出" },
      cwd: { type: "string", description: "工作目录（可选；不给则用本体默认工作区）" },
      workspaceId: { type: "string", description: "工作区 id（可选；与 cwd 二选一，不能同时给）" },
      sessionId: { type: "string", description: "可选：指定会话 id（幂等 adopt 已有会话）" },
      text: { type: "string", description: `可选：初始消息（给了就立刻投递，≤${TEXT_LIMIT} 字符）` },
    },
    output: {
      schema: { type: "string" },
      render(args, value) {
        return [{ type: "text", text: String(value) }];
      },
    },
    async execute(args) {
      const provider = String(args?.provider ?? "").trim();
      const model = String(args?.model ?? "").trim();
      const cwd = String(args?.cwd ?? "").trim();
      const workspaceId = String(args?.workspaceId ?? "").trim();
      const wantedId = String(args?.sessionId ?? "").trim();
      const text = String(args?.text ?? "");
      if ((provider && !model) || (!provider && model)) {
        return "新建失败：provider 与 model 必须成对给出（先用 list_models 查确切值）";
      }
      if (cwd && workspaceId) return "新建失败：cwd 与 workspaceId 只能给一个（本体同样会拒）";
      if (text.length > TEXT_LIMIT) return `新建失败：text 超长（${text.length} > ${TEXT_LIMIT} 字符）`;
      const sc = sessionControllerOf(ctx);
      if (!sc || typeof sc.create !== "function") {
        return "新建失败：sessionController.create 不可用（本体未挂载该服务或版本不支持）";
      }
      let created;
      try {
        created = await sc.create({
          ...(workspaceId ? { workspaceId } : {}),
          ...(cwd ? { cwd } : {}),
          ...(wantedId ? { sessionId: wantedId } : {}),
        });
      } catch (error) {
        return `新建失败：${shortError(error)}`;
      }
      const sessionId = String(created?.sessionId ?? "");
      if (!sessionId) return `新建失败：本体未返回 sessionId（回执 ${JSON.stringify(created)}）`;
      // 模型与初始消息是「建会话」之后的两个独立步骤，任一失败都不能谎报整体成功
      const notes = [];
      if (provider && model) {
        try {
          await sc.selectModel({ sessionId, provider, model });
        } catch (error) {
          notes.push(`⚠️ 会话已建，但模型未设置（${shortError(error)}）`);
        }
      }
      if (text.trim()) {
        try {
          await deliverPrompt(sc, { sessionId, text, mode: "queue", requestId: newRequestId() });
        } catch (error) {
          notes.push(`⚠️ 会话已建，但初始消息未投递（${mapPromptError(error)}：${shortError(error)}）`);
        }
      }
      log(ctx, `新建会话 ${sessionId}（模型 ${provider && model ? `${provider}/${model}` : "默认"}，初始消息 ${text.trim() ? "有" : "无"}）`);
      const head = `已新建会话 ${sessionId}（模型 ${provider && model ? `${provider}/${model}` : "未指定，跟随默认"}）`;
      return notes.length ? `${head}\n${notes.join("\n")}` : `${head}\n可用 send_to_session 继续给它发消息。`;
    },
  }));
}

// ── 注册入口 ──────────────────────────────────────────────────────────────

/**
 * 注册本域三个工具。
 * @param ctx 插件上下文
 * @param defineTool 宿主的工具定义函数（**必须由调用方显式传入**，见文件头注释）
 * @param tools 宿主 tools 服务
 * @returns {boolean} 是否注册成功（调用方据此打日志）
 */
export function registerSessionMessagingTools(ctx, defineTool, tools) {
  if (typeof defineTool !== "function" || typeof tools?.register !== "function") return false;
  registerListSessions(ctx, defineTool, tools);
  registerSendToSession(ctx, defineTool, tools);
  registerCreateSession(ctx, defineTool, tools);
  return true;
}
