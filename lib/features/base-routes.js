// dsh-session-conductor — 基础路由（语言包 / 会话列表）
//
// 【为什么单独成文件】原先内联在 lib/apply.js 的 `ctx.inject(["webServer"])` 回调里（该回调上千行，
// 审计 readability/max-function-length 拦截）。这里只搬「注册」这部分，handler 体逐字保留。
//
// ⚠️ 语言包路径：原先写 `./i18n/zh.json`（相对 lib/apply.js）。本文件位于 lib/features/，
// 必须改成 `../i18n/...`，否则运行时读不到语言包、页面文案会整块变空。
import { readFileSync } from 'node:fs';
import { readJson, send } from '../http.js';
import { log } from '../shared/log.js';
import { invalidateSessionListCache } from '../sessions/list-cache.js';
import { readListIndex } from '../features/session-messaging/index.js';
import { buildSessionListCached } from '../sessions/list.js';

/**
 * 注册基础路由（语言包 + 会话列表）。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @returns {void}
 */
export function registerBaseRoutes({ webServer, ctx }) {
    // i18n 语言包：**只读一次并缓存**。原先每个请求都同步读两个 JSON（约 33 KB）并解析，
    // 既阻塞事件循环（审计 io-risk 高风险），又纯属浪费 —— 语言包在一个进程生命周期内不会变。
    let i18nCache = null;
    const loadI18n = () => {
      if (i18nCache !== null) return i18nCache;
      i18nCache = {
        zh: JSON.parse(readFileSync(new URL("../i18n/zh.json", import.meta.url), "utf8")),
        en: JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")),
      };
      return i18nCache;
    };

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
          const { zh, en } = loadI18n();
          return send(res, 200, { ok: true, zh, en });
        } catch (error) {
          return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- 预览页已移出本插件 ----------
    // 原先这里用 /api/session-conductor/preview/<settings|panel> 同源服务 assets/preview-*.html
    // （那两份 html 由已移除的 tools/preview-snapshot.sh 生成）。现在预览能力统一由独立插件
    // dsh-useful-tools 的 `preview` 工具提供：gen 生成 + serve 带 backend 反代真实后端，
    // 效果等价且本插件不必再托管静态页，故路由与产物一并移除。

    // ---------- GET /api/session-conductor/list ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/list",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          // 索引直读（`?fromIndex=true`）：与 `list_sessions` 工具的 `fromIndex` **同义** ——
          //   直接读落盘索引、**不做全量构建**，秒回精简列表（不含 live 状态与归档态）。
          //   原先路由只认 job / stream 两个声明，传 fromIndex 会被**静默忽略** ⇒ 悄悄退化成
          //   226 秒级的全量构建（本机实测一次 41 秒才回），调用方以为拿到了快照、实际被钉在慢路径上。
          if (String(req.url ?? "").includes("fromIndex=true")) {
            const items = await readListIndex(ctx);
            if (!items) {
              send(res, 200, { ok: true, fromIndex: true, sessions: [], hint: "落盘索引为空或尚未建立；去掉 fromIndex 走一次刷新（会重建索引，冷缓存可能很慢）" });
              return;
            }
            send(res, 200, { ok: true, fromIndex: true, sessions: items, hint: "来自落盘索引，不含 live 状态与归档态；要实时状态请去掉 fromIndex 走刷新" });
            return;
          }
          // job 模式（`?job=1` 或 `Accept: application/x-job`）：冷缓存下全量构建很慢
          //   （本机实测 201 份日志 / 1.5 GB 时 226 秒），把构建交给宿主后台 job 并**立即**返回 jobId，
          //   调用方改用 job_output / job_list 取结果，前台不再被钉住。
          //   默认（无 job 声明）仍走下面的普通 JSON / NDJSON 流式分支 —— 一字不动，避免改坏面板。
          const wantJob = /application\/x-job/i.test(req.headers?.accept ?? "")
            || String(req.url ?? "").includes("job=1");
          if (wantJob) {
            const jobs = ctx?.get?.("jobs");
            if (!jobs || typeof jobs.start !== "function") {
              send(res, 501, { ok: false, error: { code: "unsupported", message: "宿主未挂载 jobs 服务，无法注册后台 job；请改用默认（流式/JSON）路径" } });
              return;
            }
            // 构建只做一次；完成后顺手失效 TTL，保证随后任何一条路径读到的都是本次结果
            const done = buildSessionListCached(ctx).then(
              (sessions) => { invalidateSessionListCache(); return { status: "completed", output: JSON.stringify({ ok: true, sessions }) }; },
              (error) => ({ status: "failed", detail: String(error?.message ?? error) }),
            );
            const spec = { kind: "session-conductor-list", label: "list（会话列表刷新）", run: () => ({ cancel: () => {}, done }) };
            // HTTP 入口没有执行主体 ⇒ 用「无主」注册（宿主存在全局 job 控制器即可）；
            // 无主不可用时如实回 501，由调用方决定是否改用默认路径（不静默吞掉）。
            try {
              send(res, 200, { ok: true, async: true, jobId: jobs.start(spec), hint: "用宿主 job_output / job_list 取结果" });
            } catch (error) {
              // 后台 job 不可用（HTTP 入口**没有执行主体**，宿主 job 控制器会拒绝无主注册 ——
              //   实测回的是「no job controller serves this agent」）：不再直接 501 把调用方堵死；
              //   退一步给**索引快照**（秒回、明确标注来源与「不含 live 状态」），索引也没有才如实 501。
              const items = await readListIndex(ctx).catch(() => null);
              if (items) {
                send(res, 200, {
                  ok: true,
                  async: false,
                  fromIndex: true,
                  sessions: items,
                  jobUnavailable: String(error?.message ?? error),
                  hint: "后台 job 不可用，已回退为落盘索引快照（不含 live 状态）；要实时状态请走默认或流式分支",
                });
                return;
              }
              send(res, 501, { ok: false, error: { code: "unsupported", message: `注册后台 job 失败：${String(error?.message ?? error)}（且落盘索引不可用，无回退）` } });
            }
            return;
          }
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
          // 立即把头行推出去：冷缓存时后面要逐份解压上百份日志（实测 41~226 秒），
          // 若头行压在缓冲里，浏览器这侧会一直「没有响应」，看起来就像接口挂了。
          // flushHeaders/flush 老版本不一定有，取不到就跳过（写操作本身已尽量及时）。
          try {
            if (typeof res.flushHeaders === "function") res.flushHeaders();
            if (typeof res.flush === "function") res.flush();
          } catch { /* 不支持 flush 的宿主不影响主流程 */ }
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
}
