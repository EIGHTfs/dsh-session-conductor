// dsh-session-conductor — 跨会话消息域：三个 AI 工具的注册
//
// 【本文件职责】只放工具定义（description / parameters / execute）与注册入口；
// 常量、纯函数、限流状态机与本体调用封装在 logic.js。
//
// 【工具注册约定】照 lib/features/context-usage 的写法：注册函数返回 boolean，
// 由 apply.js 在 inject('tools') 回调里调用。`defineTool` 必须由调用方显式传入
// —— 本项目历史事故：文件里直接用 defineTool 却从未导入 ⇒ 该回调抛
// ReferenceError ⇒ 同批工具全部注册不上（详见 lib/apply.js 的注释）。

import {
  TEXT_LIMIT, HOPS_LIMIT, RATE_WINDOW_MS, RATE_MAX, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT,
  currentSessionId, callerCwd, sessionControllerOf, shortError, mapPromptError,
  formatSessionList, listSessions, describeTarget, checkModelPair,
  peekRateLimit, hitRateLimit, isInFlight, markInFlight, clearInFlight,
  newRequestId, deliverPrompt, logMessaging,
} from "./logic.js";

/** 三个工具共用的输出形态（纯文本回执）。 */
const TEXT_OUTPUT = {
  schema: { type: "string" },
  render(args, value) {
    return [{ type: "text", text: String(value) }];
  },
};

// ── 工具：list_sessions ───────────────────────────────────────────────────

/**
 * 刷新路径的「快等待」窗口：先直接等构建这么久，等到了就直接给结果；
 * 等不到再把它交给宿主后台 job（**复用同一份在途 Promise**，不重启构建）。
 *
 * 为什么需要它：冷缓存下全量构建实测 226 秒（201 会话 / 1.5 GB 日志），
 * 工具直接把调用方钉住会让整轮长时间无回应；但热缓存只要 ~47 ms，
 * 一律走 job 又会让常见情况白多一次 job_output 往返。所以按「先等一会儿，超时转 job」处理。
 */
const LIST_FAST_WAIT_MS = 3000;

/**
 * 注册宿主后台 job：带 owner 试一次，失败退「无主」再试，仍失败才降级同步。
 *
 * 宿主契约（照 dsh-git-push 的实测结论抄，不要凭猜）：
 *   · `owner` 必须是**有活 agent 的会话 id 字符串**（`exec.agent.id`），传对象或错的 id 会抛
 *     「session "xxx" has no live agent」；
 *   · owner 缺省（unowned）在存在全局控制器时同样可注册，所以带 owner 失败 ≠ 不能后台化；
 *   · 两步都失败才同步降级，并把失败原因带回去，便于当场定位（不静默降级）。
 *
 * @returns {{jobId?: string, error?: string}}
 */
function startHostJob(jobs, spec, owner) {
  if (!jobs || typeof jobs.start !== "function") return { error: "宿主未挂载 jobs 服务（ctx.get('jobs') 不可用）" };
  const reasons = [];
  if (owner) {
    try { return { jobId: jobs.start({ ...spec, owner }) }; } catch (error) { reasons.push(`带 owner 失败：${(error && error.message) || error}`); }
  }
  try { return { jobId: jobs.start(spec) }; } catch (error) { reasons.push(`无主注册失败：${(error && error.message) || error}`); }
  return { error: reasons.join(" ｜ ") };
}

/** 从落盘索引直接组装一份精简列表（不重建索引）。索引不可用时返回 null。 */
export async function readListIndex(ctx) {
  const { loadListDiskCache } = await import("../../sessions/list-cache.js");
  const entries = loadListDiskCache(ctx)?.entries;
  if (!entries || typeof entries !== "object") return null;
  return Object.entries(entries).map(([id, e]) => ({
    id,
    title: e?.title ?? null,
    cwd: e?.cwd ?? null,
    updatedAt: e?.updatedAt ?? e?.createdAt ?? 0,
    parentSession: e?.parentSession ?? null,
    fromIndex: true,
  }));
}

/** 索引入口（fromIndex=true）用的精简渲染：只给定位所需字段，明确标注来自索引。 */
function formatIndexList(items, { limit, offset, query }) {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  const filtered = q
    ? items.filter((it) => [it.id, it.title ?? "", it.cwd ?? ""].some((v) => String(v).toLowerCase().includes(q)))
    : items;
  const page = filtered.slice(offset, offset + limit);
  const head = `索引直读：命中 ${filtered.length} 条（索引共 ${items.length} 条），本页 ${page.length} 条`
    + (filtered.length > offset + limit ? `；下一页用 offset=${offset + limit}` : "")
    + "。⚠️ 这是落盘索引里的记录，不含 live 状态与归档态；要看实时状态请去掉 fromIndex 走一次刷新。";
  const body = page.map((it) => `- ${it.id}${it.title ? ` ｜ ${it.title}` : ""}${it.cwd ? ` ｜ ${it.cwd}` : ""}`).join("\n");
  return body ? `${head}\n${body}` : `${head}\n（无匹配）`;
}

function registerListSessions(ctx, defineTool, tools) {
  tools.register(defineTool({
    name: "list_sessions",
    description:
      "列出本机 DSH 的会话（id / 标题 / 工作区 / 状态 / 最后活动 / 是否当前会话），供 send_to_session 挑目标。"
      + "只读、无副作用。"
      + `**默认只返回前 ${LIST_DEFAULT_LIMIT} 条**（会话多时整表输出会白烧调用方上下文）：`
      + "先用 query 按 id/标题/工作区子串收窄，再按回执提示的 offset 翻页。"
      + "状态含义：running = 正在跑回合；idle = 已挂载但空闲；inactive = 冷会话（未挂载，被投递时会被唤醒）。"
      + "用法：先调它拿目标 id，再把 id 原样传给 send_to_session —— 不要凭记忆或标题猜 id。"
      + "缺 id 的脏数据会被自动跳过并如实标注。"
      + `**慢路径会注册宿主后台 job**：冷缓存时全量构建很慢（实测 226 秒），`
      + `所以等过 ${LIST_FAST_WAIT_MS / 1000} 秒还没好就转后台 job 并立即回 jobId，`
      + "用宿主 job_output 取正式列表（前台不再被钉住）。"
      + "**想立刻拿一份精简列表可用 fromIndex=true**：直接读落盘索引，不触发重建（很适合「先看有哪些会话、拿 id」这一步）。",
    parameters: {
      query: { type: "string", description: "按 id / 标题 / 工作区子串过滤（不区分大小写），会话多时先用它收窄" },
      limit: { type: "number", description: `本页最多返回多少条（默认 ${LIST_DEFAULT_LIMIT}，上限 ${LIST_MAX_LIMIT}）` },
      offset: { type: "number", description: "跳过前多少条（默认 0；回执里会给出下一页该用的 offset）" },
      fromIndex: { type: "boolean", description: "true = 直接读落盘索引（秒回，不含 live 状态），不触发重建；缺省 = 刷新（可能等很久，超时自动转后台 job）" },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const limit = Number.isSafeInteger(args?.limit) && args.limit > 0
          ? Math.min(args.limit, LIST_MAX_LIMIT)
          : LIST_DEFAULT_LIMIT;
        const offset = Number.isSafeInteger(args?.offset) && args.offset > 0 ? args.offset : 0;
        const currentId = currentSessionId(exec?.agent);

        // ① 索引直读：快路径，不重建索引
        if (args?.fromIndex === true) {
          const items = await readListIndex(ctx);
          if (!items) return "索引直读不可用：落盘索引为空或尚未建立。请去掉 fromIndex 走一次刷新（会重建索引）。";
          return formatIndexList(items, { limit, offset, query: args?.query });
        }

        // ② 刷新路径：构建一次（build 是唯一那份在途 Promise，后面转 job 时复用它，不重启构建）
        const build = (async () => {
          const items = await listSessions(ctx);
          // 本次查询结束后让面板随后的刷新能看到最新结果：失效 TTL + 确保索引落盘。
          // 面板交互本身维持原样（仍走 /list 的 NDJSON 流式），这里只保证它下一次取到的是新数据。
          try {
            const { invalidateSessionListCache, saveListDiskCacheNow } = await import("../../sessions/list-cache.js");
            invalidateSessionListCache();
            saveListDiskCacheNow(ctx);
          } catch { /* 面板更新是尽力而为，不影响工具结果 */ }
          return formatSessionList(items, currentId, { limit, offset, query: args?.query });
        })();

        const timer = new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), LIST_FAST_WAIT_MS);
          t.unref?.();
        });
        const quick = await Promise.race([build, timer]);
        if (quick !== null) return quick; // 快路径：直接给结果

        // ③ 慢路径：交给宿主后台 job（done 直接 await 上面那份 build）
        const jobs = ctx?.get?.("jobs");
        const started = startHostJob(jobs, {
          kind: "session-conductor-list",
          label: "list_sessions 刷新",
          run: () => {
            const done = build.then(
              (output) => ({ status: "completed", output }),
              (error) => ({ status: "failed", detail: shortError(error) }),
            );
            return { cancel: () => {}, done };
          },
        }, exec?.agent?.id);
        if (started.jobId) {
          return `已注册宿主后台 job（正在后台列出，完成会自动返回）；如需主动查：job_output ${started.jobId}`
            + "（想立刻拿一份精简列表可改用 fromIndex=true）";
        }
        // ④ 连 job 都注册不上：退回同步执行，并把原因带回（不静默降级）
        const output = await build;
        return `${output}\n\n（注：宿主后台 job 不可用，已同步执行。原因：${started.error}）`;
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
      "给另一个 DSH 会话投递一条消息（不经过人转达），用于 AI 之间的交接与唤醒。"
      + "投递语义：目标空闲/未挂载时由本体自动唤醒它跑一个回合；目标运行中则排到其下一回合边界；"
      + "mode=\"steer\" 改为注入它正在跑的那个回合。"
      + "何时用：需要对方立刻行动、且是短消息。"
      + "何时不用：要交接上下文/长内容/可追溯 → 落共享文件（工作区里的交接 md）+ git 提交信息，这里只发路径与要点；"
      + "需要人做决策或跨机器 → 人转达。"
      + "硬约束（防唤醒风暴）：禁止投给自己；协作链 hops≥3 拒绝；同一对会话 60s 内最多 5 条；"
      + "requestId 幂等（重试传同一个值不会重复投递）。"
      + "先 dryRun=true 可只校验并预览（不投递、不消耗限流配额），确认无误再真投。"
      + "回执只表示本体已受理，不代表对方已处理完。",
    parameters: {
      sessionId: { type: "string", required: true, description: "目标会话 id（先用 list_sessions 取，别凭记忆写）" },
      text: { type: "string", required: true, description: `消息正文（纯文本，≤${TEXT_LIMIT} 字符；长内容请落文件后只发路径）` },
      mode: { type: "string", description: "queue（默认：排到目标下一回合，空闲时唤醒它）| steer（注入目标正在跑的回合）" },
      requestId: { type: "string", description: "可选幂等键；重试时传同一个值可避免重复投递（缺省由工具生成并在回执里回传）" },
      hops: { type: "number", description: `协作链跳数（AI 之间互相投递时自增；≥${HOPS_LIMIT} 会被拒绝并提示改用共享文件）` },
      dryRun: { type: "boolean", description: "true = 只校验并预览、不真的投递（默认 false）" },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const from = currentSessionId(exec?.agent);
      const to = String(args?.sessionId ?? "").trim();
      const text = String(args?.text ?? "");
      const mode = args?.mode === "steer" ? "steer" : "queue";
      const hops = Number(args?.hops ?? 0);
      const dryRun = args?.dryRun === true;
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
      if (dryRun) {
        // 只读预检：限流只探测不消耗；目标存在性 best-effort
        const rate = peekRateLimit(from, to);
        const target = await describeTarget(ctx, to);
        const rid = String(args?.requestId ?? "").trim();
        return `【dryRun】未投递任何消息，以下是将要发生的事：\n`
          + `- 目标：${to}${target}\n`
          + `- 模式：${mode}${mode === "steer" ? "（注入目标正在跑的回合）" : "（排到目标下一回合；目标空闲时由本体唤醒它）"}\n`
          + `- 正文：${text.length} 字符，开头「${text.slice(0, 40)}${text.length > 40 ? "…" : ""}」\n`
          + `- 幂等键：${rid || "（未指定，真投时自动生成）"}\n`
          + `- 限流：本窗口已用 ${rate.used}/${RATE_MAX}`
          + (rate.limited ? " ⇒ ⚠️ 当前会被限流，需等窗口滚动或改用共享文件" : "（不会触发限流）");
      }
      if (hitRateLimit(from, to)) {
        return `投递失败：限流（同一对会话 ${RATE_WINDOW_MS / 1000}s 内最多 ${RATE_MAX} 条）——稍后再试，或改用共享文件`;
      }
      const requestId = String(args?.requestId ?? "").trim() || newRequestId();
      if (isInFlight(requestId)) return `投递失败：同一 requestId 正在投递中（${requestId}）`;
      markInFlight(requestId);
      try {
        await deliverPrompt(sc, { sessionId: to, text, mode, requestId, from });
        logMessaging(ctx, `跨会话投递 ${from ?? "?"} → ${to}（mode=${mode} requestId=${requestId} hops=${hops}）`);
        return `已投递到 ${to}（mode=${mode} ｜ requestId=${requestId}）。`
          + (mode === "steer"
            ? "目标是运行中会话：消息已注入其当前回合。"
            : "目标空闲时本体已自动唤醒它；目标运行中则在其下一回合边界消费。")
          + " 回执只表示本体已受理，不代表对方已处理完。";
      } catch (error) {
        return `投递失败（${mapPromptError(error)}）：${shortError(error)}`;
      } finally {
        clearInFlight(requestId);
      }
    },
  }));
}

// ── 工具：create_session ──────────────────────────────────────────────────

function registerCreateSession(ctx, defineTool, tools) {
  tools.register(defineTool({
    name: "create_session",
    description:
      "新建一个 DSH 会话（只新建，不删除、不修改其它会话）。可指定 provider/model（建完立即切到该模型），"
      + "可选带一条初始消息让它立刻开始干活。"
      + "工作目录缺省 = **调用方会话自己的 cwd**（发起它的那个 AI 在哪干活，新会话就落在哪）；"
      + "也可显式给 cwd 或 workspaceId（二者互斥）。"
      + "建议用法：① 先用 list_models 查确切的 provider/model；"
      + "② 不确定就先 dryRun=true 预览（会核对模型是否在目录里、报告将用的 cwd 与初始消息），确认无误再真建。"
      + "模型与初始消息是建会话之后的两个独立步骤，任一步失败都会如实回执（如「会话已建，但模型未设置」），不会谎报整体成功。",
    parameters: {
      provider: { type: "string", description: "模型 provider 分组名（list_models 输出的顶层分组，如 agnes / wb）；与 model 成对给出" },
      model: { type: "string", description: "该 provider 下的模型 id（如 agnes-3.0-flash / global:deepseek-v4.1-flash）；与 provider 成对给出" },
      cwd: { type: "string", description: "工作目录（可选；缺省 = 调用方会话的 cwd；与 workspaceId 互斥）" },
      workspaceId: { type: "string", description: "工作区 id（可选；与 cwd 互斥，不能同时给）" },
      sessionId: { type: "string", description: "可选：指定会话 id（幂等 adopt 已有会话）" },
      text: { type: "string", description: `可选：初始消息（给了就立刻投递，≤${TEXT_LIMIT} 字符）` },
      dryRun: { type: "boolean", description: "true = 只校验并预览、不真的建会话（默认 false）" },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const provider = String(args?.provider ?? "").trim();
      const model = String(args?.model ?? "").trim();
      const cwdArg = String(args?.cwd ?? "").trim();
      const workspaceId = String(args?.workspaceId ?? "").trim();
      const wantedId = String(args?.sessionId ?? "").trim();
      const text = String(args?.text ?? "");
      const dryRun = args?.dryRun === true;
      if ((provider && !model) || (!provider && model)) {
        return "新建失败：provider 与 model 必须成对给出（先用 list_models 查确切值）";
      }
      if (cwdArg && workspaceId) return "新建失败：cwd 与 workspaceId 只能给一个（本体同样会拒）";
      if (text.length > TEXT_LIMIT) return `新建失败：text 超长（${text.length} > ${TEXT_LIMIT} 字符）`;
      const sc = sessionControllerOf(ctx);
      if (!sc || typeof sc.create !== "function") {
        return "新建失败：sessionController.create 不可用（本体未挂载该服务或版本不支持）";
      }
      // 缺省 cwd = 调用方会话自己的 cwd。
      // 为什么不交给本体默认：本体的默认是**它自己的运行目录**（实测 /volume1/@appstore/DeepSeekHarness-NAS，
      // 即 DSH 安装目录）—— 新会话落在程序目录里对干活毫无意义。
      const ownCwd = callerCwd(exec?.agent);
      const cwd = cwdArg || (workspaceId ? "" : ownCwd);
      const cwdSource = cwdArg
        ? "显式指定"
        : (workspaceId ? "由 workspaceId 决定" : (ownCwd ? "缺省 = 调用方会话的 cwd" : "缺省（取不到调用方 cwd，交给本体默认）"));
      const modelLabel = provider && model ? `${provider}/${model}` : "（未指定，跟随默认）";
      if (dryRun) {
        // 只读预检：模型目录核对 best-effort（拿不到目录就如实说明，不阻断）
        const pair = provider && model
          ? await checkModelPair(sc, provider, model)
          : { checked: false, found: false, hint: "" };
        const pairNote = provider && model
          ? (pair.checked
            ? (pair.found ? " ✓ 已在模型目录里核对通过" : ` ⚠️ ${pair.hint}`)
            : (pair.hint ? ` （${pair.hint}）` : ""))
          : "";
        return `【dryRun】未创建任何会话，以下是将要发生的事：\n`
          + `- 工作目录：${cwd || "(本体默认)"}（${cwdSource}）\n`
          + (workspaceId ? `- 工作区 id：${workspaceId}\n` : "")
          + (wantedId ? `- 指定会话 id：${wantedId}（幂等 adopt）\n` : "")
          + `- 模型：${modelLabel}${pairNote}\n`
          + `- 初始消息：${text.trim() ? `${text.length} 字符，开头「${text.slice(0, 40)}${text.length > 40 ? "…" : ""}」` : "（无）"}`;
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
          await deliverPrompt(sc, { sessionId, text, mode: "queue", requestId: newRequestId(), from: currentSessionId(exec?.agent) });
        } catch (error) {
          notes.push(`⚠️ 会话已建，但初始消息未投递（${mapPromptError(error)}：${shortError(error)}）`);
        }
      }
      logMessaging(ctx, `新建会话 ${sessionId}（模型 ${provider && model ? `${provider}/${model}` : "默认"}，cwd ${cwd || "本体默认"}，初始消息 ${text.trim() ? "有" : "无"}）`);
      const head = `已新建会话 ${sessionId}（模型 ${modelLabel}，工作目录 ${cwd || "本体默认"}）`;
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
