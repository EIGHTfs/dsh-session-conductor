// dsh-session-conductor — 会话价值分析与任务完成汇报路由
//
// 【为什么单独成文件】原先内联在 lib/apply.js 的 `ctx.inject(["webServer"])` 回调里，
// 让该回调成为上千行巨型函数（审计 readability/max-function-length 拦截）。
// 这里只搬「注册」这部分，handler 体逐字保留、行为不变。
//
// 路由：
//   POST /value-analysis      —— 扫描会话并给出价值评分/清理建议
//   任务完成汇报管道（task-completion-report）
import { readJson, send } from '../http.js';
import { log } from '../shared/log.js';
import { invalidateSessionListCache } from '../sessions/list-cache.js';
import { lazyValue } from '../core/lazy.js';
import { analyzeValueWithLlm } from './rename/value.js';
import { buildSessionListCached } from '../sessions/list.js';
import { getValueVerdict, putValueVerdict, saveValueIndexNow } from './value-index.js';
import { renderCompletionBlock } from '../core.js';
import { sessionEventsOf } from '../sessions/events.js';
import { MAX_STALE_DAYS } from '../shared/constants.js';

/**
 * 注册价值分析与任务汇报路由。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @returns {void}
 */
export function registerValueReportRoutes({ webServer, ctx }) {

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
          // 流式（`?stream=1` 或 Accept: application/x-ndjson）：**每分析完一个会话就推一行**。
          // 前端拿到 value==="low" 立刻勾上（分析出一个勾一个），不必等全量跑完 ——
          // 全量要逐个读上百份日志，慢的是读取本身，而读取是天然可增量的。
          // 判定规则与批量路径同源（value.js 的 classifySessionLevel），不在这里另写一套。
          const wantValueStream = /application\/x-ndjson/i.test(req.headers?.accept ?? "")
            || String(req.url ?? "").includes("stream=1");
          if (wantValueStream) {
            // body.ids：只分析这些会话（面板已先用归档/时间/目录在本地筛过一轮，
            // 没必要把全量会话都读一遍事件）。不传 = 全量。
            const wantedIds = Array.isArray(body?.ids)
              ? new Set(body.ids.filter((id) => typeof id === "string" && id !== ""))
              : null;
            const streamTargets = wantedIds ? sessions.filter((s) => wantedIds.has(s.id)) : sessions;
            res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            if (res.socket?.setNoDelay) res.socket.setNoDelay(true);
            res.write(JSON.stringify({ ok: true, stream: true, total: streamTargets.length }) + "\n");
            try {
              if (typeof res.flushHeaders === "function") res.flushHeaders();
            } catch { /* 老宿主不支持 flush，不影响主流程 */ }
            const { classifySessionLevel } = await lazyValue();
            let done = 0;
            for (const s of streamTargets) {
              done += 1;
              // ① 索引命中（内容没变 + 未超 TTL）→ 零 I/O 直接给结论
              const cachedVerdict = getValueVerdict(ctx, s.id, s.updatedAt);
              if (cachedVerdict) {
                try {
                  res.write(JSON.stringify({
                    id: s.id, value: cachedVerdict.value, score: cachedVerdict.score,
                    reason: cachedVerdict.reason, cached: true, done, total: streamTargets.length,
                  }) + "\n");
                } catch { break; }
                continue;
              }
              // ② 没索引 / 会话变过 / 超 TTL → 真读一次日志
              let events = [];
              try {
                const found = await sessionEventsOf(ctx, s.id);
                events = found?.events ?? [];
              } catch { /* 读不到就当空事件：会走 artifact-safe 保守判 high，不误删 */ }
              const verdict = classifySessionLevel(s, events, new Date(), staleDays);
              putValueVerdict(ctx, s.id, s.updatedAt, verdict);
              try {
                res.write(JSON.stringify({ ...verdict, cached: false, done, total: streamTargets.length }) + "\n");
              } catch { break; }
            }
            saveValueIndexNow(ctx); // 本次算出来的结论立刻落盘（下次筛选直接命中索引）
            try { res.end(); } catch { /* 连接已断 */ }
            return;
          }
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
}
