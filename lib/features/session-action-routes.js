// dsh-session-conductor — 会话动作与日志修复类 HTTP 路由
//
// 【为什么单独成文件】原先这些路由全部内联在 lib/apply.js 的 `ctx.inject(["webServer"])` 回调里，
// 让该回调变成上千行的巨型函数（审计 readability/max-function-length 拦截）。
// 这里只搬「注册」这部分，handler 体逐字保留、行为不变；依赖由调用方以 deps 传入。
//
// 本模块包含的路由（按原文件顺序）：
//   POST /search · /auto-rename · /analyze · /continue · /message · /auto-continue
//        · /scan · /detach · /detach-all
//   以及会话日志修复：/repair-sessions（会话损坏扫描）· /repair-frames（zstd 帧修复）
//        · /repair-seq-gap · /repair-eio · /repair-dual-format
import path from 'node:path';
import { log } from '../shared/log.js';
import { MSG_NEED_SESSION_ID } from '../shared/constants.js';
import { readJson, send } from '../http.js';
import { findSessionLog } from '../session-log.js';
import { invalidateSessionListCache } from '../sessions/list-cache.js';
import { detachSessionAgent, detachAllIdleSessions } from '../sessions/detach.js';
import { continueSession, sendMessageToSession } from '../features/continue/session.js';
import { runAutoScan, runAutoContinueSession } from '../features/continue/scan.js';
import { runAnalysis } from '../features/rename/analysis.js';
import { continueJobs } from '../core/state.js';
import { readSwitch, patchSwitch } from '../core/config.js';
import { lazyEio, lazyFs, lazyRepair, lazySeqGap } from '../core/lazy.js';
import { searchSessions } from './search.js';
import { SEARCH_MIN_QUERY } from './search.js';

/**
 * 注册会话动作与日志修复类路由。
 *
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务（提供 register）
 * @param {object} deps.ctx 插件 ctx（用于 get 各服务）
 * @returns {void}
 */
export function registerSessionActionRoutes({ webServer, ctx }) {
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
            // 修复：原为裸调 `repairDualFormatSessions(...)`，但该名字从未导入 ⇒ 抛
            //   ReferenceError 被下面的 catch 变成 400「repair-dual-format-failed」，非 dryRun 的
            //   双格式修复实际从未执行过。改为与上一行同源的懒加载命名空间调用。
            : await (await lazyRepair()).repairDualFormatSessions({ dryRun: false, skipIds });
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

}
