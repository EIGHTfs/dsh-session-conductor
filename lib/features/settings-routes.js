// dsh-session-conductor — 模板与插件设置类 HTTP 路由
//
// 【为什么单独成文件】原先内联在 lib/apply.js 的 `ctx.inject(["webServer"])` 回调里（该回调上千行，
// 审计 readability/max-function-length 拦截）。这里只搬「注册」与 handler 体，逐字保留、行为不变。
//
// 路由：/templates · /templates/dir（模板浏览与读写）、/fts-status（全文索引状态）、
//       /compaction-model · /auto-rename-model（两条模型设置）、/auto-continue-gate（自动继续闸门）
import { readJson, send } from '../http.js';
import { log } from '../shared/log.js';
// cfg 是核心配置的 live binding（`export let cfg`）：模板落盘目录与浏览根都由它算出来。
// 拆分时漏掉这一个 import 会让 registerSettingsRoutes 在**调用期**抛 ReferenceError，
// 进而使整个 webServer inject 回调中断 —— 表现为「settings 及其之后的所有路由全部 404」。
import { cfg, readSwitch, patchSwitch, resolveBrowseRoot, resolveDshHome } from '../core/config.js';
import { invalidateSessionListCache } from '../sessions/list-cache.js';
import { pluginDomain } from '../core/domain.js';
import { setTemplateStateCache } from '../shared/test-hooks.js';
// 405 响应文案与内置全文检索入口同样是拆分遗漏项：前者在非 GET/POST 分支里被直接引用
// （漏了会在方法不对时抛 ReferenceError），后者用 typeof 探测（漏了不会抛，但会永远判成不可用）。
import { MSG_METHOD_ONLY_GET_POST } from '../shared/constants.js';
import { searchSessions } from './search.js';
// 模板读写实现 + 三个模板常量：常量只在表达式里被引用（不是函数调用），
// 按「找未定义函数调用」的扫描抓不到，拆分时漏过一轮。
import {
  saveTemplate, saveTemplateFromUrl, saveTemplateFromPath, listTemplateDir, removeTemplate, readTemplateSync,
  TEMPLATE_SLOTS, TEMPLATE_DEFAULTS, TEMPLATE_MAX_BYTES,
} from '../template-inject.js';

/**
 * 注册模板与设置类路由。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @returns {void}
 */
/**
 * 处理 /templates 的 GET/POST（列模板槽位与内容 / 写入与导入模板）。
 *
 * 【为什么单独成函数】handler 体 100 余行，内联在 register 回调里会让单函数超长
 * （审计 readability/max-function-length 拦截，阈值 50 行）。抽出只换位置，逻辑一字不改；
 * 缩进保持原样 —— 体内有模板字符串，重排缩进会改变字符串内容。
 *
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {{ctx: object, tplHome: string, browseRoot: string}} deps 显式依赖
 * @returns {Promise<void>}
 */
async function handleTemplatesRoute(req, res, { ctx, tplHome, browseRoot }) {
            try {
              // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
              if (req.method !== "GET") invalidateSessionListCache();
              const domain = await pluginDomain(ctx);
              const st = domain.global.get();
              const meta = st.sessionTemplates ?? structuredClone(TEMPLATE_DEFAULTS);
              // 缓存写入口必须是归属模块的 setter（import 绑定对导入方只读，直接赋值会 TypeError）
              setTemplateStateCache(meta);
              // 构造带 content 的 slots（GET/POST 统一：导入/编辑后前端编辑框直接读到内容）
              if (req.method === "GET") {
                return send(res, 200, { ok: true, slots: buildTemplateSlotsWithContent(meta), maxBytes: TEMPLATE_MAX_BYTES });
              }
              return await handleTemplatesPost(req, res, { ctx, tplHome, browseRoot, meta });
              return send(res, 405, { ok: false, error: { code: "method", message: MSG_METHOD_ONLY_GET_POST } });
            } catch (error) {
              send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
            }
}

/**
 * 构造「带内容的模板槽位表」（GET 与 POST 共用：导入/编辑后前端要拿到最新内容）。
 *
 * 【为什么单独成函数】原先是 handleTemplatesRoute 内的局部箭头函数，抽出来只为把主 handler
 * 压到函数长度阈值内；逻辑与缩进一字不改（体内有模板字符串，重排缩进会改内容）。
 *
 * @param {object} meta2 模板元数据
 * @param {string} tplHome 模板落盘目录
 * @returns {object} slot → 槽位元数据 + content
 */
function buildTemplateSlotsWithContent(meta2, tplHome) {
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
}

/**
 * 处理 /templates 的 POST（写入 / 导入 / 切换模板槽位）。
 *
 * 【为什么单独成函数】该分支 80 行，与主 handler 放一起会超函数长度阈值；
 * 逻辑与缩进一字不改（体内有模板字符串，重排缩进会改内容）。
 * 原分支内的 return 语义保持不变：返回值直接透传给外层 handler。
 *
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {{ctx: object, tplHome: string, browseRoot: string, meta: object}} deps 显式依赖
 * @returns {Promise<void>}
 */
async function handleTemplatesPost(req, res, { ctx, tplHome, browseRoot, meta }) {
                const body = await readJson(req);
                // 目录内选用 md 文件（action="pickPath"）——校验用工作区浏览根，落盘用 DSH_HOME
                 if (body?.action === "pickPath") return await handleTemplatesPickPath(req, res, { browseRoot, tplHome, meta, body });
                const slot = String(body?.slot ?? "");
                if (!TEMPLATE_SLOTS.includes(slot)) {
                  return send(res, 400, { ok: false, error: { code: "bad-slot", message: `模板槽位须为 ${TEMPLATE_SLOTS.join("|")}` } });
                }
                const cur = meta[slot] ?? { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 };
                 if (body?.action === "remove") return await handleTemplatesRemove(req, res, { tplHome, meta, slot, cur });
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
                  return send(res, 200, { ok: true, slots: buildTemplateSlotsWithContent(next), message: `模板「${slot}」已保存，记得点「开启注入」` });
                }
                if (saved && !saved.ok) return send(res, 400, saved);
                if (typeof body?.enabled === "boolean") {
                  const next = { ...meta, [slot]: { ...cur, enabled: body.enabled } };
                  setTemplateStateCache(next);
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildTemplateSlotsWithContent(next), message: body.enabled ? `模板「${slot}」已开启注入` : `模板「${slot}」已关闭` });
                }
                // 方案模板强制门禁开关（{slot:"plan", enforce:bool}）——即时生效，无需重启
                if (slot === "plan" && typeof body?.enforce === "boolean") {
                  const next = { ...meta, plan: { ...cur, enforce: body.enforce } };
                  setTemplateStateCache(next);
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildTemplateSlotsWithContent(next), message: body.enforce
                    ? `方案模板强制门禁已开启（未出提案并获确认前，代码修改类工具调用被拒绝）`
                    : `方案模板强制门禁已关闭` });
                }
                return send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 {slot, name, content}（本地 md）、{slot, url}（在线 md）、{slot, enabled} 或 {slot:'plan', enforce}" } });
}

/**
 * 处理 /templates 的「按路径导入」（action=pickPath）：把工作区内某个 md 文件复制成模板。
 *
 * 【为什么单独成函数】主 POST 处理器里这一支 20 余行，抽出来才让上层函数降到长度阈值内；
 * 逻辑与缩进一字不改。返回值直接透传（内部各分支都是 return send(...)）。
 *
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {{browseRoot: string, tplHome: string, meta: object, body: object}} deps 显式依赖
 * @returns {Promise<void>}
 */
async function handleTemplatesPickPath(req, res, { browseRoot, tplHome, meta, body }) {
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
                  return send(res, 200, { ok: true, slots: buildTemplateSlotsWithContent(next), message: `模板「${slot}」已从目录选用（${saved.name}），记得点「开启注入」` });
}

/**
 * 处理 /templates 的「移除」（action=remove）：清空该槽位并返回最新槽位表。
 *
 * 【为什么单独成函数】同上：把主 POST 处理器压到长度阈值内，逻辑与缩进一字不改。
 *
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {{tplHome: string, meta: object, slot: string, cur: object}} deps 显式依赖
 * @returns {Promise<void>}
 */
async function handleTemplatesRemove(req, res, { tplHome, meta, slot, cur }) {
                  const r = await removeTemplate(tplHome, slot);
                  if (!r.ok) return send(res, 400, r);
                  const next = { ...meta, [slot]: { ...cur, enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 } };
                  setTemplateStateCache(next);
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildTemplateSlotsWithContent(next), message: `模板「${slot}」已清空` });
}

export function registerSettingsRoutes({ webServer, ctx }) {
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
          handler: (req, res) => handleTemplatesRoute(req, res, { ctx, tplHome, browseRoot }),
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
}
