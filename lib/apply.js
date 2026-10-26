/** 插件入口 apply：注册路由、工具、设置页与各类钩子（本轮拆分后仍含各 handler 实现，下一步继续抽出）。 */

// 渲染/校验函数：供 /api/task-completion/render|check 端点使用（LLM 侧工具注册已移除，
//   VALID_STATUSES 不再需要导入——它只在 core.js 的 renderCompletionBlock 内部使用）。
import { log } from "./shared/log.js";
import { MAX_ATTACHED_LIMIT, MAX_CONTINUES_PER_SESSION_LIMIT } from './shared/constants.js';
import { pluginDomain, isDomainLive, resetDomainForTest } from "./core/domain.js";
import { continueTimers, getScanTimer } from './core/state.js';
import { cfg, DEFAULTS, setConfig, resolveDshHome, patchSwitch, resetAutoContinueOnStart } from './core/config.js';
import { maybeScheduleContinue, runAutoScan, scheduleScan, AUTO_CONTINUE_SCAN_DELAY_MS } from './features/continue/scan.js';
import { num } from "./shared/util.js";
import { createContextUsageInjector, readContextUsage } from './features/context-usage/index.js';
import { buildMemoryRecall } from "./features/memory-recall/index.js";
import { registerGroupRoutes } from "./group.js";
import { readCompletionConventionSync, collectTemplateSlotText, planGateAllows, planEnforceDenyMessage, TEMPLATE_DEFAULTS, TEMPLATE_SLOTS, PLAN_ENFORCE_EDIT_TOOLS, PLAN_ENFORCE_BASH_WRITE_RE } from './template-inject.js';
import { name } from "./shared/constants.js";
import { invalidateSessionListCache } from './sessions/list-cache.js';
import { scheduleAnalysis, analyzeSession } from './features/rename/analysis.js';
import { refreshTitleState } from './features/rename/title.js';
// 价值判定索引：同一份会话内容在 TTL（默认 24 小时）内只算一次，避免每次筛选都重读日志
// 成员模型：本文件用到 findTargetAgent / switchAgentModel / getMemberModelOverride /
//   applyModelOverride / validateModelPair（拆出 apply.js 时漏了这一行 import，
//   运行到相关代码路径会 ReferenceError: getMemberModelOverride is not defined）
import { getMemberModelOverride, applyModelOverride, noteRequestModel, takeSwitchOutcomes } from './features/member-model/index.js';
// 会话操作的路由注册已抽到独立模块（handler 实现见该模块；此处只留注册入口）
import { registerSessionOpsRoutes } from './features/session-ops-routes.js';
import { registerMemberModelTools } from './features/member-model/tools.js';
import { registerSessionActionRoutes } from './features/session-action-routes.js';
import { registerBaseRoutes } from './features/base-routes.js';
import { registerSettingsRoutes } from './features/settings-routes.js';
import { registerValueReportRoutes } from './features/value-report-routes.js';
import { registerTrashRoutes } from './features/session-ops-routes.js';
import { purgeExpiredTrash } from './features/session-ops.js';
import { installProcessGuards } from './guards.js';
import { readJson, send } from './http.js';
import { CONDUCTOR_SETTINGS_NS, PresenceSchema } from './shared/settings.js';
import { templateStateCache, setTemplateStateCache } from './shared/test-hooks.js';

export async function apply(ctx, config = {}) {
  // 修复（热重载兼容）：插件重载时旧 apply 的 disposer 会 close 持久化域，
  // 但模块级 domainPromise 缓存不失效 → 新 apply 复用已 closed 的域 → 所有读写报
  // "domain 'dsh_session_conductor' is closed"（list/value-analysis/search 全挂）。
  // 每次 apply 重置缓存，确保重新 open 域。
  // 改为条件重置。原代码无条件清缓存，遇到「旧的域还活着就重载」时
  // （多条目/热重载时序）会在活域上再 open 一次 → storage 报 already open → list 500。
  // 只有确认域已关闭（或从未打开）才清缓存；域还活着就复用同一份，不再重复 open。
  // 【原代码】此处为两行无条件重置：domainPromise = null 与 pushDomainPromise = null（push 域已随自动推送功能移除）
  if (!isDomainLive()) resetDomainForTest();
  setConfig({
    enabled: config?.enabled !== false,
    defaultAutoContinue: config?.defaultAutoContinue === true, // 缺省关闭，仅显式 true 开启
    failRetryDelayMs: num(config?.failRetryDelayMs, 0, 10 * 60 * 1000, DEFAULTS.failRetryDelayMs),
    titleStateSuffix: config?.titleStateSuffix === true, //  起默认取消状态后缀（吸收官方纯净标题），显式 true 才开启
    maxConcurrent: num(config?.maxConcurrent, 1, 8, DEFAULTS.maxConcurrent),
    maxAttached: num(config?.maxAttached, 1, MAX_ATTACHED_LIMIT, DEFAULTS.maxAttached),
    // 会话列表冷会话 inspect 并发上限（默认 2）——防一次性并发全量会话导致堆 OOM
    listInspectBatch: num(config?.listInspectBatch, 1, 16, DEFAULTS.listInspectBatch),
    // list 结果缓存时长（0=不缓存，即时最新；默认 5s 合并面板多组件同时刷新）
    listCacheMs: num(config?.listCacheMs, 0, 5 * 60 * 1000, DEFAULTS.listCacheMs),
    cooldownMs: num(config?.cooldownMs, 60 * 1000, 24 * 3600 * 1000, DEFAULTS.cooldownMs),
    maxContinuesPerSession: num(config?.maxContinuesPerSession, 1, MAX_CONTINUES_PER_SESSION_LIMIT, DEFAULTS.maxContinuesPerSession),
    turnTimeoutMs: num(config?.turnTimeoutMs, 60 * 1000, 6 * 3600 * 1000, DEFAULTS.turnTimeoutMs),
    scanIntervalMs: num(config?.scanIntervalMs, 30 * 1000, 24 * 3600 * 1000, DEFAULTS.scanIntervalMs),
    // 价值判定索引有效期（小时）：同一份会话内容在该时长内只算一次（默认 24 小时，可配置覆盖）
    valueIndexTtlHours: num(config?.valueIndexTtlHours, 1, 24 * 30, DEFAULTS.valueIndexTtlHours),
    // 回收站保留天数（面板上设置的值优先；这里是兜底默认）
    trashRetentionDays: num(config?.trashRetentionDays, 1, 365, DEFAULTS.trashRetentionDays),
    // 自动重命名模型路由（成对配置才生效；缺省 = 继承会话 request/header 的对话模型）
    autoRenameProvider: typeof config?.autoRenameProvider === "string" && config.autoRenameProvider !== "" ? config.autoRenameProvider : undefined,
    autoRenameModel: typeof config?.autoRenameModel === "string" && config.autoRenameModel !== "" ? config.autoRenameModel : undefined,
  });

  // 会话分组（原 dsh-session-group 已合并）：仅保留只读展示（status/list）
  // + 分组下新建会话（new-session，workspaceId 缺省 = 最近活跃会话的工作区）；分组管理能力回归
  // DSH 官方 workspace 机制。
  // 进程级兜底——宿主 bin.ts 未注册 unhandledRejection/uncaughtException 处理，
  // Node 15+ 默认 --unhandled-rejections=throw，任何插件的异步 rejection 逃逸都会**直接杀死
  // 整个 DSH 进程**（表现为「自动续跑跑一会进程就没了」）。这里注册兜底：仅记录日志、不退出，
  // 避免单个 promise 异常拖垮宿主；插件自身异步链已全部包 try/catch，这里防的是回归与未知路径。
  installProcessGuards(ctx);

  await registerGroupRoutes(ctx, {
    blockGroupNewSession: config?.blockGroupNewSession,
    enabled: config?.groupEnabled !== false,
  }, {
    // 承接会话（new-session 新建）默认开启自动重命名（约定）
    setAutoRename: (sessionId, enabled) => patchSwitch(ctx, "autoRename", sessionId, { enabled }, { enabled: false }).catch((error) => {
      log(ctx, `承接会话自动重命名设置失败 ${sessionId}: ${String(error?.message ?? error)}`);
    }),
  }).catch((error) => {
    log(ctx, `会话分组模块初始化失败: ${String(error?.message ?? error)}`);
  });

  // 回合开始/结束 → 刷新标题状态后缀；回合结束还触发自动重命名 + 自动续跑判定。
  // 【 吸收官方 all-prompts 节奏】每条真人 user/message 后也触发自动重命名精炼
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
    // 自动续跑全局闸门：检测到「用户第一次手动对话」（turn/start 由 user 发起）
    // → 自动置 gate=open（放行自动续跑）。guardian 在 DSH 恢复健康时置 closed，
    // 这里保证「用户真的开始对话了」才恢复续跑，杜绝崩溃恢复后批量建空壳。
    if (type === "turn/start") {
      const eventPayload = event?.data ?? event;
      const byUser =
        eventPayload?.role === "user" ||
        eventPayload?.user === true ||
        eventPayload?.kind === "user" ||
        eventPayload?.source === "user";
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
      const running = getScanTimer();
      if (running !== null) clearTimeout(running);
      for (const timer of continueTimers.values()) clearTimeout(timer);
      continueTimers.clear();
    };
  }, "session-conductor: timers");

  // 在 apply 的活跃 fiber 上预热持久化域并挂 close effect，避免 HTTP handler 首次打开踩 inactive context。
  pluginDomain(ctx).catch((error) => {
    log(ctx, `持久化域预热失败: ${String(error?.message ?? error)}`);
  });

  // 启动即载入开关配置，并自动把所有自动续跑开关复位为关闭
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

    // ---------- 基础路由（i18n 语言包 / 会话列表）：整块拆到 features/base-routes.js ----------
    registerBaseRoutes({ webServer, ctx });

    // ---------- 模板与设置类路由：整块拆到 features/settings-routes.js ----------
    registerSettingsRoutes({ webServer, ctx });

    // ---------- 会话操作路由（归档/取消归档/删除/撤回）----------
    // 从本文件抽出为 lib/features/session-ops-routes.js：apply 只保留「注册入口」，
    //   具体 handler 实现见该模块（行为逐字不变，依赖以 deps 传入）。
    registerSessionOpsRoutes({ webServer, ctx, send, readJson, invalidateSessionListCache });

    // ---------- 回收站路由 ----------
    // 删除只是打标记（文件不动），所以还原零成本；真删只发生在到期与一键清空。
    registerTrashRoutes({ webServer, ctx, send, readJson, invalidateSessionListCache });

    // 到期清理：每小时扫一次（回收站保留天数可配，默认 7 天）。
    // 用 unref 的定时器 + 单次 try/catch：清理失败绝不能影响宿主进程。
    try {
      const purgeTimer = setInterval(() => {
        purgeExpiredTrash(ctx).catch(() => { /* 单次清理失败，下一小时再试 */ });
      }, 3600_000);
      if (typeof purgeTimer?.unref === "function") purgeTimer.unref();
      ctx.effect?.(() => () => { try { clearInterval(purgeTimer); } catch { /* 已清理 */ } }, "session-conductor: trash purge timer");
    } catch { /* 定时器建不起来也不影响手动清理 */ }

    // ---------- /search 已并入下面的 session-action-routes（同一类「对会话做动作」）----------
    // 与 /auto-rename、/analyze、/continue、/message、/auto-continue、/scan、/detach、
    // /detach-all 以及 /repair-* 五条修复路由一起，整块拆到 features/session-action-routes.js。
    registerSessionActionRoutes({ webServer, ctx });
    // ---------- 价值分析 + 任务完成汇报：整块拆到 features/value-report-routes.js ----------
    registerValueReportRoutes({ webServer, ctx });

    log(ctx, `API 路由已注册 (/api/session-conductor/* + /api/task-completion/*)；自动续跑: enabled=${cfg.enabled}, 默认开启=${cfg.defaultAutoContinue}, maxAttached=${cfg.maxAttached}, maxConcurrent=${cfg.maxConcurrent}`);
  });

  // 启动水合：把存储里的会话模板状态读进 templateStateCache。
  //
  // 为什么必须有：templateStateCache 的初值是 structuredClone(TEMPLATE_DEFAULTS)（plan/closing 均
  //   enabled=false、enforce=false），而**只有 /templates 路由被访问过**才会用存储值覆写它
  //   ⇒ 宿主重启后若没有打开过设置页（没有任何 /templates 请求），模板注入与「方案模板强制门禁」
  //   就全部按“默认关闭”执行 —— 设置里明明是开启的，却既不注入也不拦截（同一根因两个症状）。
  // 做法：首次需要时从插件存储读一次并写入缓存，之后复用同一个 Promise（只水合一次）。
  let templateHydration = null;
  const hydrateTemplateState = () => {
    if (!templateHydration) {
      templateHydration = (async () => {
        try {
          const domain = await pluginDomain(ctx);
          const st = domain.global.get();
          setTemplateStateCache(st.sessionTemplates ?? structuredClone(TEMPLATE_DEFAULTS));
        } catch (error) {
          log(ctx, `会话模板状态水合失败（按默认值继续）: ${String(error?.message ?? error)}`);
        }
      })();
    }
    return templateHydration;
  };

  // 任务完成汇报：约定注入每个 agent 系统提示 + 渲染/校验工具。
  // ──  方案模板强制门禁（tools/pre-execute waterfall）────────────────
  // 无状态判定：每次拦截从会话事件流现场推导门状态——「提案」= 确认消息之前那一段 AI 输出里
  // 同时含提案标题与确认段标记；「确认」= 最后一条真实用户消息命中确认词。重启零恢复问题，
  // 门状态永远由真实事件流现场推导。delegationDepth>0 的子 agent 会话豁免（子 agent 无法交互
  // 确认；主会话是强制执行点，注入文本约定主 AI 不得借委派绕过门禁）。
  // ⚠️ waterfall 契约：不拦时必须 next()，否则短路整条链（hooks 桥同款写法，见 PreToolUse 映射）。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      // 启动水合：不水合则重启后 enforce 恒为默认 false ⇒ 方案强制门禁静默失效
      await hydrateTemplateState();
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
      // 修复自 1.0.0 起一直存在的静默失败：原写死 `text: TASK_COMPLETION_CONVENTION`，
      //   但该标识符在全仓 / 全历史既没有 const 定义，也没有赋值或 import ⇒ 构造 section 参数时
      //   直接抛 `ReferenceError: TASK_COMPLETION_CONVENTION is not defined`，被下面的 catch
      //   吞成一行日志 ⇒ 该 section 从未注册、收尾约定从未注入（表现即「指挥家从来没注入过」）。
      //   现改为同步读取插件自带的权威文本 skills/task-completion-report.md（去 frontmatter；
      //   读取失败或为空则跳过注册并留痕，不再静默炸）。
      //   原写法（保留供追溯）：text: TASK_COMPLETION_CONVENTION
      const conventionText = readCompletionConventionSync();
      if (conventionText) {
        sctx.get("systemPrompt").section({
          name: "task-completion-report",
          order: 1000,
          text: () => conventionText
        });
      } else {
        log(ctx, "systemPrompt 注入跳过：收尾约定文本为空（skills/task-completion-report.md 缺失或不可读）");
      }
    } catch (error) {
      log(ctx, `systemPrompt 注入失败: ${String(error?.message ?? error)}`);
    }
  });

  // 方案/收尾模板改走**上下文注入**（agent/pre-step，每 agent 首次 step 注入一次，
  // 参考同款形态）——不再塞 systemPrompt section（上下文与系统提示词是两回事，
  // 方案模板一条、收尾模板一条，各带自己的说明，一开始就注入）。
  // 模板内容同步读盘 + templateStateCache（templates API 写入后刷新），enabled 才注入对应条。
  const templateInjectedAgents = new WeakSet();
  if (typeof ctx?.on === "function") {
    const tplDshHome = resolveDshHome(ctx, cfg);
    // 成员模型切换（官方模式二：agent/request 瀑布流拦截）：按会话强制改写请求模型。
    // 不依赖官方「投影 pending + 请求头链」（那条链在新回合会回落部署默认模型），
    // override 由 set_member_model 写入（domain 持久 + 内存缓存镜像），每轮都改 → 跨轮持久。
    ctx.on("agent/request", async ({ agent }, next) => {
      const resolved = await next();
      const override = await getMemberModelOverride(ctx, agent?.session?.id);
      const applied = applyModelOverride(resolved, override);
      // 切换查证（事件驱动）：记录本次请求**真实使用**的 provider/model；若该会话有待查证项，
      // 就在这里按事件判定结果并入队（切换本身不阻塞、不轮询 —— 只等事件到）。
      try {
        noteRequestModel(agent?.session?.id, applied);
      } catch (error) {
        log(ctx, `切换查证记录失败（不影响本次请求）: ${String(error?.message ?? error)}`);
      }
      return applied;
    });
    // createUserMessage 来自宿主包：动态导入 + 守卫。
    //   为什么必须判类型：工作区自测环境没有 @deepseek-ai/* 依赖，直接引用标识符会抛
    //   ReferenceError，被 pre-step 的 try/catch 吞成一行日志 ⇒ 模板注入静默失效
    //   （与历史上 defineTool 的坑同类；实测抓法见 test/api/helpers/fake-services.mjs）。
    let createUserMessage = null;
    try {
      const llmMod = await import("@deepseek-ai/dsh-llm");
      if (typeof llmMod?.createUserMessage === "function") createUserMessage = llmMod.createUserMessage;
    } catch { /* 无宿主依赖（工作区自测）→ 注入分支前会跳过 */ }

    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision?.kind === "reject" || signal?.aborted) return decision;
      if (!agent || templateInjectedAgents.has(agent)) return decision;
      templateInjectedAgents.add(agent);
      try {
        if (!tplDshHome) return decision;
        // 启动水合：不水合则重启后模板状态恒为默认（关）⇒ plan/closing 永不注入
        await hydrateTemplateState();
        const metas = templateStateCache ?? TEMPLATE_DEFAULTS;
        if (typeof createUserMessage !== "function") {
          log(ctx, "会话模板上下文注入跳过：createUserMessage 不可用（缺 @deepseek-ai/dsh-llm）");
          return decision;
        }
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

    // 上下文用量「每轮注入」：把实时用量作为一条 user 消息追加到该步消息批次尾部。
    //   · 为什么放**尾部**而不是系统提示词前缀：前缀保持稳定 ⇒ prompt cache 仍命中，
    //     而 AI 每轮都能直接看到数字（放前缀会让前缀每轮变化，缓存失效、成本上升）。
    //   · 为什么按 **turn** 门控：agent/pre-step 每步都触发，若每步注入，一个回合里会刷出
    //     多条重复的用量行（噪音 + 白烧 token）。
    //   · 默认开启（core/config.js 的 injectContextUsage）；关掉即退化为「按需调用 context_usage 工具」。
    //   · 读不到投影/服务未挂载时注入器返回空串 ⇒ 静默跳过，绝不影响正常回合。
    // 三个开关任一开启就需要本 hook（用量注入 / 记忆取回 / 切换查证回报）；turn 门控保证一回合只注入一次。
    // 固定 enabled=true：切换查证的结果是一句话回报，不能因为前两个功能关了就不送。
    const usageInjector = createContextUsageInjector({ enabled: true });
    ctx.on("agent/pre-step", async ({ agent, turn, signal }, next) => {
      const decision = await next();
      if (decision?.kind === "reject" || signal?.aborted) return decision;
      // 与模板注入同款守卫：工作区自测环境没有 @deepseek-ai/* 依赖，createUserMessage 会是 null
      if (typeof createUserMessage !== "function") return decision;
      if (!usageInjector.shouldInject(agent, turn)) return decision;
      const usageText = cfg?.injectContextUsage === false ? "" : usageInjector.textFor(ctx, agent);
      // 记忆取回：本回合用量比上次明显下降 ⇒ 判定上下文疑似丢失，取回最近几轮消息文本 + AI 首条回应。
      // 与用量注入**合并成同一条消息**（一回合只注入一条，避免叠加）；阈值/轮数/上限见 cfg。
      let recallText = null;
      if (cfg?.retrieveMemory !== false) {
        try {
          const snapshot = readContextUsage(ctx, agent);
          recallText = await buildMemoryRecall(ctx, {
            sessionKey: agent,
            sessionId: agent?.session?.id,
            current: snapshot?.ok ? snapshot.occupancy : null,
            opts: {
              rounds: cfg?.retrieveMemoryRounds,
              minDropRatio: cfg?.retrieveMemoryMinDropRatio,
              minDropTokens: cfg?.retrieveMemoryMinDropTokens,
              maxTotalChars: cfg?.retrieveMemoryMaxChars,
              maxCharsPerItem: cfg?.retrieveMemoryMaxCharsPerItem,
            },
          });
        } catch (error) {
          log(ctx, `记忆取回失败（跳过本次）: ${String(error?.message ?? error)}`);
        }
      }
      // 切换查证回报：切换发起方在**下一次 step** 收到一行结果（切换本身注册 job 后立刻返回，
      // 判定由 agent/request 事件触发 —— 这里只负责把结果送到对的人手上）。
      let switchNote = "";
      try {
        const outcomes = takeSwitchOutcomes(agent?.session?.id);
        if (outcomes.length > 0) {
          switchNote = outcomes.map((o) => (o.ok
            ? `【切换查证】✅ 已确认生效：本次请求实际使用 ${o.actual}`
            : `【切换查证】❌ 未生效：期望 ${o.expected}，本次请求实际使用 ${o.actual}`)).join("\n");
        }
      } catch (error) {
        log(ctx, `切换查证回报失败（跳过本次）: ${String(error?.message ?? error)}`);
      }
      const text = [usageText, recallText, switchNote].filter(Boolean).join("\n\n");
      if (!text) return decision;
      try {
        const injected = createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor", form: "instructions" },
        });
        return { ...decision, messages: [...(decision.messages || []), injected] };
      } catch (error) {
        log(ctx, `上下文用量注入失败: ${String(error?.message ?? error)}`);
        return decision;
      }
    });
  }

  // defineTool 动态加载：工作区自测环境没有 DSH 依赖，装在 profile 内必可解析（与 dsh-git-push 同法）。
  // 此前本文件直接使用 defineTool 却**从未导入** ⇒ inject('tools') 回调抛
  //   ReferenceError: defineTool is not defined ⇒ 四个工具全部注册不上。
  // 实测抓到方式：mini-host + 假服务（test/api/helpers/fake-services.mjs）跑真 handler 时，
  //   warnings 报 `inject(tools) 回调异常: defineTool is not defined`。
  let defineTool = null;
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod?.defineTool === 'function') defineTool = mod.defineTool;
  } catch { /* 无 DSH 依赖（工作区自测）→ 下面跳过注册，不影响其它接线 */ }

  ctx.inject(["tools"], (tctx) => {
    const tools = tctx.get("tools");
    if (!defineTool) return; // 无 DSH 依赖时不注册（避免 ReferenceError 炸掉整个 inject 回调）
    // 成员模型/权限相关的 5 个工具与 2 条聊天指令：整块拆到 member-model/tools.js
    // （原先内联在这里 293 行，把 inject 回调撑成巨型函数；handler 体与错误隔离策略不变）。
    registerMemberModelTools({ ctx, tools, defineTool });
  });
}
