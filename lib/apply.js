/** 插件入口 apply：注册路由、工具、设置页与各类钩子（本轮拆分后仍含各 handler 实现，下一步继续抽出）。 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { findSessionLog } from "./session-log.js";
// 渲染/校验函数：供 /api/task-completion/render|check 端点使用（LLM 侧工具注册已移除，
//   VALID_STATUSES 不再需要导入——它只在 core.js 的 renderCompletionBlock 内部使用）。
import { renderCompletionBlock, checkCompletionText } from "./core.js";
import { log } from "./shared/log.js";
import {
  MSG_METHOD_ONLY_GET_POST, MSG_NEED_SESSION_ID,
  MAX_ATTACHED_LIMIT, MAX_CONTINUES_PER_SESSION_LIMIT, MAX_STALE_DAYS,
} from "./shared/constants.js";
import { lazyRepair, lazySeqGap, lazyEio, lazyValue, lazyFs } from "./core/lazy.js";
import { pluginDomain, isDomainLive, resetDomainForTest } from "./core/domain.js";
import {
  continueTimers, continueLocks, continueJobs, deleteLocks,
  withDeleteLock, withSessionLock, withConcurrencyGate, cancelSessionTimers,
  getScanTimer, setScanTimer, resetRuntimeStateForTest,
} from "./core/state.js";
import {
  cfg, DEFAULTS, setConfig, resolveDshHome, resolveBrowseRoot,
  readSwitch, patchSwitch, loadPluginConfig, savePluginConfig, resetAutoContinueOnStart,
  autoRenameEnabled, effectiveAutoContinue, resetSwitchGroupsForTest, deleteSwitch, getSwitchGroupsForTest,
} from "./core/config.js";
import { continueSession, sendMessageToSession } from "./features/continue/session.js";
import {
  maybeScheduleContinue, runAutoContinueSession, runAutoScan, scheduleScan, AUTO_CONTINUE_SCAN_DELAY_MS,
} from "./features/continue/scan.js";
import { num } from "./shared/util.js";
import { registerGroupRoutes } from "./group.js";
import { saveTemplate, saveTemplateFromUrl, saveTemplateFromPath, listTemplateDir, removeTemplate, readTemplateSync, TEMPLATE_DEFAULTS, TEMPLATE_SLOTS, TEMPLATE_MAX_BYTES } from "./template-inject.js";
import { name } from "./shared/constants.js";
import { sessionEventsOf } from "./sessions/events.js";
import { detachSessionAgent, detachAllIdleSessions } from "./sessions/detach.js";
import {
  invalidateSessionListCache, scheduleSaveListDiskCache, saveListDiskCacheNow, resetListCacheForTest,
} from "./sessions/list-cache.js";
import { buildSessionListCached } from "./sessions/list.js";
import {
  scheduleAnalysis, runAnalysis, resolveModelOverride, analyzeSession, resolveRoute,
  driftAnalysisLlm, extractTitleOnly, parseDriftJson, pendingTimers, resetAnalysisForTest,
} from "./features/rename/analysis.js";
import { analyzeValueWithLlm } from "./features/rename/value.js";
import {
  collectSessionTitleMessages, resolveSessionTitle, stateSuffixOf, stripTitleStateSuffix, refreshTitleState,
} from "./features/rename/title.js";
import { SEARCH_MIN_QUERY, searchSessions } from './features/search.js';
// 成员模型：本文件用到 findTargetAgent / switchAgentModel / getMemberModelOverride /
//   applyModelOverride / validateModelPair（拆出 apply.js 时漏了这一行 import，
//   运行到相关代码路径会 ReferenceError: getMemberModelOverride is not defined）
import { findTargetAgent, switchAgentModel, getMemberModelOverride, applyModelOverride, validateModelPair } from './features/member-model/index.js';
// 会话操作的路由注册已抽到独立模块（handler 实现见该模块；此处只留注册入口）
import { registerSessionOpsRoutes } from './features/session-ops-routes.js';
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
    // 自动重命名模型路由（成对配置才生效；缺省 = 继承会话 request/header 的对话模型）
    autoRenameProvider: typeof config?.autoRenameProvider === "string" && config.autoRenameProvider !== "" ? config.autoRenameProvider : undefined,
    autoRenameModel: typeof config?.autoRenameModel === "string" && config.autoRenameModel !== "" ? config.autoRenameModel : undefined,
  });

  // 会话分组（原 dsh-session-group 已合并）：仅保留只读展示（status/list）
  // + 分组下新建会话（new-session，workspaceId 缺省 = 上次会话工作区）；分组管理能力回归
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          // list 流式（仅当请求声明 Accept: application/x-ndjson）——live 会话先快速
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
    //  会话模板注入（）：plan（方案模板）/ closing（收尾模板）两个固定槽位，
    // 支持上传本地 md 文件或在线 md 网址（host 下载转存），内容落盘
    // <DSH_HOME>/template-inject-md/<slot>.md → systemPrompt section「session-templates」注入。
    // GET → {ok, slots: {plan:{enabled,name,url,bytes,updatedAt}, closing:{...}}, maxBytes}
    // POST {slot, enabled?} → 只改开关；
    // POST {slot, name, content} → 上传本地 md；
    // POST {slot, url} → 在线 md 网址下载转存；
    // POST {slot, action:"remove"} → 清空槽位。
    {
      const tplHome = resolveDshHome(ctx, cfg);
      // 浏览根与选用校验根唯一来源 = resolveBrowseRoot（工作区目录）。
      // 同一 browseRoot 变量贯穿本块内两个路由：/templates 的 pickPath 校验、/templates/dir 浏览。
      // 落盘仍 tplHome（DSH_HOME/template-inject-md/），浏览/校验/落盘三者职责清晰。
      const browseRoot = resolveBrowseRoot(ctx, cfg);
      if (tplHome) {
        webServer.register({
          kind: "exact",
          path: "/api/session-conductor/templates",
          handler: async (req, res) => {
            try {
              // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
              if (req.method !== "GET") invalidateSessionListCache();
              const domain = await pluginDomain(ctx);
              const st = domain.global.get();
              const meta = st.sessionTemplates ?? structuredClone(TEMPLATE_DEFAULTS);
              // 缓存写入口必须是归属模块的 setter（import 绑定对导入方只读，直接赋值会 TypeError）
              setTemplateStateCache(meta);
              // 构造带 content 的 slots（GET/POST 统一：导入/编辑后前端编辑框直接读到内容）
              const buildSlotsWithContent = (meta2) => {
                const out = {};
                for (const slot of TEMPLATE_SLOTS) {
                  const slotMeta = meta2[slot] ?? { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 };
                  let content = "";
                  if (slotMeta.bytes > 0 || slotMeta.name) {
                    // readTemplateSync 返回 sanitized 字符串（无文件/不可读返回空串），不是 {ok,text} 对象
                    try { content = String(readTemplateSync(tplHome, slot) ?? "").slice(0, TEMPLATE_MAX_BYTES); } catch { content = ""; }
                  }
                  out[slot] = { ...slotMeta, content };
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
                  setTemplateStateCache(next);
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
                  setTemplateStateCache(next);
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
                  setTemplateStateCache(next);
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: `模板「${slot}」已保存，记得点「开启注入」` });
                }
                if (saved && !saved.ok) return send(res, 400, saved);
                if (typeof body?.enabled === "boolean") {
                  const next = { ...meta, [slot]: { ...cur, enabled: body.enabled } };
                  setTemplateStateCache(next);
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: body.enabled ? `模板「${slot}」已开启注入` : `模板「${slot}」已关闭` });
                }
                // 方案模板强制门禁开关（{slot:"plan", enforce:bool}）——即时生效，无需重启
                if (slot === "plan" && typeof body?.enforce === "boolean") {
                  const next = { ...meta, plan: { ...cur, enforce: body.enforce } };
                  setTemplateStateCache(next);
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: body.enforce
                    ? `方案模板强制门禁已开启（未出提案并获确认前，代码修改类工具调用被拒绝）`
                    : `方案模板强制门禁已关闭` });
                }
                return send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 {slot, name, content}（本地 md）、{slot, url}（在线 md）、{slot, enabled} 或 {slot:'plan', enforce}" } });
              }
              return send(res, 405, { ok: false, error: { code: "method", message: MSG_METHOD_ONLY_GET_POST } });
            } catch (error) {
              send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
            }
          },
        });

        // ---------- GET /api/session-conductor/templates/dir ----------
        //  模板目录浏览（「在工作区目录内找」）：列 DSH 工作区目录树内一层目录。
        // 浏览根与选用校验根同源（上方 browseRoot）；落盘仍在 DSH_HOME/template-inject-md/。
        // GET ?path=... → {ok, path, parent, entries:[{name,path,isDir,isMd}]}（缺省从工作区根开始）
        if (browseRoot) {
          webServer.register({
            kind: "exact",
            path: "/api/session-conductor/templates/dir",
            handler: async (req, res) => {
              try {
                // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
    // 全文搜索诊断（ 并入，原独立插件 dsh-session-search 已合并）：
    // 报告官方 FTS5（sessionQuery）是否挂载 + 内置 zstd 扫描兜底是否可用。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/fts-status",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
    // 压缩模型选择：会话模型旁单独选压缩用模型。
    // GET → {ok, compactionModel: {provider,model}|null, follow: true(跟随会话模型)}
    // POST {provider, model} → 设置；POST {follow:true} → 重置为跟随会话模型
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/compaction-model",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
          return send(res, 405, { ok: false, error: { code: "method", message: MSG_METHOD_ONLY_GET_POST } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET/POST /api/session-conductor/auto-rename-model ----------
    // 自动重命名模型选择：设置页「DSH 同款解析选择器」选定。
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
          return send(res, 405, { ok: false, error: { code: "method", message: MSG_METHOD_ONLY_GET_POST } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET/POST /api/session-conductor/auto-continue-gate ----------
    // 自动续跑全局闸门（与 guardian 联动）：
    //   GET → {ok, gate: "open"|"closed", note}
    //   POST {gate:"open"|"closed"} → 设置；closed 时一切自动续跑跳过（周期扫描/scan 自动续跑部分）
    //   guardian 在 DSH 恢复健康时置 closed；用户手动开启或首次手动对话（turn/start user）后自动置 open
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-continue-gate",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
          return send(res, 405, { ok: false, error: { code: "method", message: MSG_METHOD_ONLY_GET_POST } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- 会话操作路由（归档/取消归档/删除/撤回）----------
    // 从本文件抽出为 lib/features/session-ops-routes.js：apply 只保留「注册入口」，
    //   具体 handler 实现见该模块（行为逐字不变，依赖以 deps 传入）。
    registerSessionOpsRoutes({ webServer, ctx, send, readJson, invalidateSessionListCache });

    // ---------- POST /api/session-conductor/search ----------
    // 全文搜索：跨会话搜消息内容，返回命中会话 + 上下文片段
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/search",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const query = typeof body?.query === "string" ? body.query : "";
          const scope = ["all", "active", "archived"].includes(body?.scope) ? body.scope : "all";
          if (query.trim().length < SEARCH_MIN_QUERY) {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: `关键词至少 ${SEARCH_MIN_QUERY} 个字符` } });
          }
          const searchResult = await searchSessions(ctx, query, { scope });
          send(res, 200, { ok: true, ...searchResult });
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
          }
          const analysisResult = await runAnalysis(ctx, body.sessionId, {
            manual: true, // 手动 API：跳过限频/新消息数门槛（显式意图即执行）
            model: typeof body?.model === "string" && body.model !== "" ? body.model : undefined,
          });
          if (!analysisResult.ok) return send(res, 409, analysisResult);
          send(res, 200, analysisResult);
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
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
            // 手动续跑异步链兜底——continueSession 永不 reject（prepare 段已包 try），
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
    // 跨会话消息投递：{targetSessionId, message, fromSessionId?}
    // 向目标会话投递用户消息并唤起（live followup / cold resume+followup），不受"中断"限制。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/message",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
          }
          const enabled = body.enabled === true;
          // 开关落盘 config.json；先取旧 entry 保留记账字段，enabled 以本次为准。
          const entry = readSwitch("autoContinue", body.sessionId) ?? {};
          await patchSwitch(ctx, "autoContinue", body.sessionId, { ...entry, enabled });
          // 开启开关即触发一次续跑（force 跳过失败重试延迟）——原先要等最长
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: MSG_NEED_SESSION_ID } });
          }
          const detachResult = await detachSessionAgent(ctx, body.sessionId);
          if (!detachResult.ok) return send(res, 409, detachResult);
          send(res, 200, detachResult);
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const detachAllResult = await detachAllIdleSessions(ctx);
          send(res, 200, detachAllResult);
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
    // 会话日志 zstd 帧修复（救援恢复，）：会话列表消失/corrupt Zstandard 时，
    // 扫描并修复帧损坏（逐帧解码→多帧正确写回，自动备份）。与 repair-sessions 互补：
    // repair-sessions 修 tool-result content 结构；repair-frames 修 zstd 帧格式。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-frames",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
    // 会话日志 seq-gap + token-surface 修复（实测）：
    //   seq gap 错位（spliced 拼接未重编号）+ replace 引用缺失 + compaction shadowedRange 未映射
    //   三层叠加导致 history unavailable（token surface: no adjacent shadow price）。
    //   dryRun=true 扫描全部会话列出疑似 seq-gap；sessionId 指定则修复单个（自动备份 .seq-gap-backup/）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-seq-gap",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
          const { readdirSync, existsSync } = await lazyFs();
          let targetPath = null;
          for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
            if (!proj.isDirectory()) continue;
            const p = findSessionLog(path.join(sessionsRoot, proj.name, sessionId));
            if (p) { targetPath = p; break; }
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
    // 会话日志 EIO 坏块修复（实测固化，来源 sa6400-nested-vm-io-panic skill）：
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
            const { readdirSync, existsSync } = await lazyFs();
            let targetPath = null;
            for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
              if (!proj.isDirectory()) continue;
              const p = findSessionLog(path.join(sessionsRoot, proj.name, sessionId));
              if (p) { targetPath = p; break; }
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
    // 双格式会话修复：会话目录同时存在 session.jsonl（明文）+ session.jsonl.zstd
    // （压缩）→ 官方 listArtifacts() 抛 encodingMismatch → 会话列表全失败（侧边栏会话消失）。
    // 纯磁盘级扫描（不走 sessionPersistence，后者自身会被 encodingMismatch 阻断），
    // 把多余明文移入 .dual-format-backup/ 保留 zstd 官方格式；dryRun=true 只扫不写。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-dual-format",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
    // 会话价值分析（ 规则判定 +  特征/LLM/关键词价值）：
    //   规则分类 completed/unfinished/stale/active + 最后回复摘要；
    //   高/低价值 = assessValue 特征评分（活跃/长度/完成/未完成/细节补充）；
    //   可选 body.keywords=[...] 记录指定关键词 → 标题/最后用户消息命中任一关键词的会话无条件最高价值；
    //   可选 body.llm=true 额外用 LLM 打分（fail-soft）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/value-analysis",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const staleDays = typeof body?.staleDays === "number" && Number.isFinite(body.staleDays)
            ? Math.min(MAX_STALE_DAYS, Math.max(1, Math.round(body.staleDays)))
            : 3;
          const useLlm = body?.llm === true;
          const sessions = await buildSessionListCached(ctx); // 价值分析走缓存（容忍 5s 陈旧，避免与面板刷新叠加扫描）
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
          const analysisSummary = analyzeValuesWithKeywords(sessions, texts, userTexts, featuresById, keywords, llmById, new Date(), staleDays);
          const counts = {};
          for (const key of Object.keys(analysisSummary)) counts[key] = analysisSummary[key].length;
          send(res, 200, {
            ok: true,
            staleDays,
            llm: !!useLlm,
            keywords: keywords.length ? keywords : void 0,
            keywordHits: keywords.length ? filterSessionsByKeywords(sessions, texts, userTexts, keywords, new Date()) : [],
            generatedAt: Date.now(),
            counts,
            completed: analysisSummary.completed,
            unfinished: analysisSummary.unfinished,
            stale: analysisSummary.stale,
            active: analysisSummary.active,
            high: analysisSummary.high,
            low: analysisSummary.low,
          });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "value-analysis-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- 任务完成汇报（task-completion-report 管道） ----------
    // 收尾约定不再由代码写死注入 systemPrompt——改由模板注入「收尾模板」槽位承担
    // （设置 → 会话管理 → 模板注入 → closing，可自定义内容）。
    // LLM 侧的 render/check 工具已移除，只剩下面的 HTTP 端点（面板/自检用），故 tools 如实回报空列表。
    webServer.register({
      kind: "exact",
      path: "/api/task-completion/status",
      handler: async (req, res) => {
        send(res, 200, {
          ok: true,
          name: "dsh-session-conductor",
          skill: "task-completion-report",
          conventionSource: "template-inject:closing（不再代码写死，由收尾模板槽位注入）",
          tools: []
        });
      },
    });

    webServer.register({
      kind: "exact",
      path: "/api/task-completion/render",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
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
  // ──  方案模板强制门禁（tools/pre-execute waterfall）────────────────
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
      return applyModelOverride(resolved, override);
    });
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
    tools.register(defineTool({
      name: "list_models",
      description: "列出当前可用模型（provider → models[]）。切模型前先用它拿到确切 model id，不要凭记忆猜模型名。",
      parameters: {},
      output: {
        schema: { type: "string" },
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute() {
        try {
          const sc = ctx.get("sessionController");
          if (!sc?.modelCatalog) return "modelCatalog 服务不可用（无法列出模型）";
          const catalog = await sc.modelCatalog();
          const groups = catalog?.groups ?? [];
          if (groups.length === 0) return "模型目录为空（检查 provider 配置）";
          return groups.map((g) => {
            const models = (g.models ?? [])
              .map((m) => `  - ${m.id}${m.name && m.name !== m.id ? `（${m.name}）` : ""}`)
              .join("\n");
            return `${g.id}${g.name && g.name !== g.id ? `（${g.name}）` : ""}:\n${models}`;
          }).join("\n\n");
        } catch (error) {
          return `列出模型失败：${String(error?.message ?? error)}`;
        }
      }
    }));
    tools.register(defineTool({
      name: "set_member_model",
      description: "给指定成员/子代理切换模型（只影响该成员的会话，不动其他成员）。target 传成员名/sessionId/标题关键字；provider 是 list_models 里的分组名（如 agnes / wb），model 是该分组下的模型 id（如 global:deepseek-v4.1-flash）。切换前会校验组合是否存在，避免切到无效组合导致回合失败。",
      parameters: {
        target: { type: "string", required: true, description: "目标成员：成员名（如 model-test）、sessionId 或标题关键字" },
        provider: { type: "string", required: true, description: "provider 分组名（list_models 输出的顶层分组，如 agnes / wb / ai-gateway）" },
        model: { type: "string", required: true, description: "该 provider 下的模型 id（含前缀，如 global:deepseek-v4.1-flash / agnes-3.0-flash）" }
      },
      output: {
        schema: { type: "string" },
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute(args) {
        const provider = String(args?.provider ?? "").trim();
        const model = String(args?.model ?? "").trim();
        if (!provider || !model) return "切换失败：provider 和 model 都必填（先用 list_models 查确切值）";
        // 先校验组合有效性——无效组合会让后续回合的模型请求被拒（表现为「切换生效但回合失败」）
        const pair = await validateModelPair(ctx, provider, model);
        if (pair.error) return `切换失败：${pair.error}`;
        const found = findTargetAgent(ctx, args?.target);
        if (found.error) return `切换失败：${found.error}`;
        const switchResult = await switchAgentModel(ctx, found.sessionId, provider, model, found.agent);
        if (switchResult.error) return `切换失败：${switchResult.error}`;
        const memberLabel = found.member?.name ? `${found.member.name}(${found.sessionId})` : found.sessionId;
        return `已把成员 ${memberLabel}（${found.matched} 匹配）切到 ${provider}/${model}；生效方式：${switchResult.via}`;
      }
    }));
    log(ctx, "成员模型工具已注册 (list_models / set_member_model)");
  });
}
