/**
 * dsh-session-conductor — 会话分组：只读展示 + 分组下新建会话（宿主半边）
 *
 * 裁剪：插件不再提供「重新分组」的管理能力（创建/重命名/删除分组、
 * 移动会话已移除，分组管理回归 DSH 官方 workspace 机制），保留：
 *
 *   GET  /api/session-conductor/group/status      状态（分组数/groupRoot/profile）
 *   GET  /api/session-conductor/group/list        全部分组（含 sessionIds / path / title）
 *   POST /api/session-conductor/group/new-session 在分组下新建会话 {workspaceId?, prompt?, handoff?}
 *        —— workspaceId 缺省 = **上次会话的工作区**（最近活跃会话 cwd 归属的分组）；
 *           找不到则兜底 .dsh 上一层 /workspace 默认工作区（不存在自动创建）。
 *
 * 面板「全部会话按工作区分组」渲染用 group/list（只读数据源）；
 * 归档会话标题的「[工作区名] 」前缀用 index.js 的 workspaceNameOf（独立实现，不依赖本模块）。
 */

import z from '@deepseek-ai/schemastery';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// 本模块由 dsh-session-conductor 的 index.js 调用，name/Config 由 index.js 统一导出
const DEFAULT_HOME = process.env.DSH_HOME
  ? resolve(process.env.DSH_HOME)
  : join(homedir(), '.dsh');

const Config = z.object({
  /** 禁止「在分组下直接新建会话」：true 时 new-session RPC 直接拒绝（401） */
  blockGroupNewSession: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

/** 承接会话行为约束（起生效，注入 new-session 的交接说明）：
 *  被移交工作的新建会话只简单了解情况 + 把已知信息总结发给用户，不直接开始写代码；
 *  即使发现原理/代码有 bug 也不动手，先汇报情况。 */
const HANDOFF_BEHAVIOR_RULE = `【行为约定（所有 AI 遵守）】你是被移交工作的承接会话：请先简单了解情况，把已知信息总结发回；未得到指令前不要直接开始写代码——即使发现原理/代码有 bug 也不要动手，先汇报情况。`;

/** 承接会话默认开启「自动重命名」（起）：new-session 新建的承接会话，
 *  创建即打开会话管理面板的 autoRename 开关（可随时关闭）。失败只记日志，不阻断主流程。 */
function tryEnableAutoRename(hooks, sessionId) {
  if (typeof hooks?.setAutoRename !== 'function' || !sessionId) return;
  Promise.resolve(hooks.setAutoRename(sessionId, true)).catch((error) => {
    console.error(`[session-conductor:group] 开启承接会话自动重命名失败 ${sessionId}: ${String(error?.message ?? error)}`);
  });
}

function detectProfileName() {
  const argv = process.argv ?? [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  return 'web';
}

/** DSH 实例端口：优先从进程 argv 的 --port 取（插件在 DSH 进程内运行，回环 RPC 用它），
 *  其次 env（PORT / TEST_DSH_PORT），最后默认 3081。不写死本机端口。 */
function detectHostPort() {
  const argv = process.argv ?? [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
    if (argv[i].startsWith('--port=')) return argv[i].slice('--port='.length);
  }
  return process.env.PORT ?? process.env.TEST_DSH_PORT ?? '3081';
}

// ---------- HTTP ----------

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

/** 请求体上限：1 MiB——分组接口只收小 JSON（workspaceId 等），超限即拒，防内存放大。 */
const MAX_JSON_BODY_BYTES = 1 << 20;

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function wsView(w) {
  return {
    workspaceId: w?.id,
    path: w?.path,
    title: w?.title,
    sessionIds: w?.sessionIds ?? [],
    createdAt: w?.createdAt,
    updatedAt: w?.updatedAt,
  };
}

/** 会话 cwd 归属的分组 id：cwd 等于分组 path 或以 path + '/' 开头即归属；无则空串。 */
function workspaceIdOfCwd(registry, cwd) {
  const items = registry?.list?.() ?? [];
  const cwdText = String(cwd ?? '');
  if (!cwdText) return '';
  const ws = items.find((w) => {
    const p = String(w?.path ?? '');
    return p && (cwdText === p || cwdText.startsWith(p + '/'));
  });
  return ws?.id ?? '';
}

/** 「上次会话」的 cwd：最近活跃（updatedAt/createdAt 最大）会话的工作目录（live + 冷会话合并）。 */
async function lastSessionCwd(ctx) {
  const sessions = ctx.get('sessions');
  const persistence = ctx.get('sessionPersistence');
  let best = { t: -1, cwd: null };
  for (const s of sessions?.list?.() ?? []) {
    const header = s?.header ?? s ?? {};
    const updatedAtMs = Number(header?.updatedAt ?? header?.createdAt ?? 0);
    if (updatedAtMs >= best.t && header?.cwd) best = { t: updatedAtMs, cwd: header.cwd };
  }
  try {
    if (typeof persistence?.listSnapshots === 'function') {
      for (const snap of await persistence.listSnapshots()) {
        const header = snap?.header ?? {};
        const updatedAtMs = Number(header?.updatedAt ?? header?.createdAt ?? 0);
        if (updatedAtMs >= best.t && header?.cwd) best = { t: updatedAtMs, cwd: header.cwd };
      }
    } else {
      for (const snapshot of await persistence?.list?.() ?? []) {
        const updatedAtMs = Number(snapshot?.updatedAt ?? snapshot?.createdAt ?? 0);
        if (updatedAtMs >= best.t && snapshot?.cwd) best = { t: updatedAtMs, cwd: snapshot.cwd };
      }
    }
  } catch { /* 冷会话扫描失败不影响 live 结果 */ }
  return best.cwd;
}

// ---------- 插件入口 ----------

/**
 * 注册会话分组路由（由 dsh-session-conductor 的 apply 调用）。
 * 提供只读展示（status/list）+ 分组下新建会话（new-session）。
 * @param {object} ctx - cordis 上下文
 * @param {object} [config] - 配置子集 {blockGroupNewSession?, enabled?}
 * @param {object} [hooks] - 宿主回调 {setAutoRename?(sessionId, enabled)}：new-session 创建的
 *   承接会话默认开启自动重命名；宿主（index.js）注入。
 */
export async function registerGroupRoutes(ctx, config = {}, hooks = {}) {
  const cfg = Config(config);
  if (cfg.enabled === false) {
    console.log('[session-conductor:group] 已禁用');
    return;
  }
  const dshHome = DEFAULT_HOME;
  const groupRoot = join(dshHome, 'git');

  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer');
    if (!webServer) return;
    wctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/api/session-conductor/group',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local');
          const p = url.pathname;
          const method = req.method ?? 'GET';

          const registry = ctx.get('workspaceRegistry');

          if (p === '/api/session-conductor/group/status' && method === 'GET') {
            const items = registry?.list?.() ?? [];
            return send(res, 200, {
              ok: true,
              workspaceCount: items.length,
              groupRoot,
              profile: detectProfileName(),
              dshHome: DEFAULT_HOME,
            });
          }

          if (p === '/api/session-conductor/group/list' && method === 'GET') {
            const items = (registry?.list?.() ?? []).map(wsView);
            return send(res, 200, { ok: true, workspaces: items });
          }

          if (p === '/api/session-conductor/group/new-session' && method === 'POST') {
            if (cfg.blockGroupNewSession) {
              return send(res, 401, {
                ok: false,
                code: 'group-new-session-blocked',
                error: '已在配置中禁止「在分组下直接新建会话」（blockGroupNewSession: true）。请改用 workspace 根新建会话，或关闭该配置。',
              });
            }
            const body = await readJsonBody(req);
            let workspaceId = String(body?.workspaceId ?? '').trim();
            if (!workspaceId) {
              // workspaceId 缺省 = 上次会话的工作区（最近活跃会话 cwd 归属的分组）
              const lastCwd = await lastSessionCwd(ctx);
              if (lastCwd) workspaceId = workspaceIdOfCwd(registry, lastCwd);
            }
            if (!workspaceId) {
              // 兜底：默认工作区（.dsh 上一层 /workspace，不存在自动创建）
              const parentDir = resolve(DEFAULT_HOME, '..');
              const defPath = resolve(join(parentDir, 'workspace'));
              await fs.mkdir(defPath, { recursive: true });
              const items = registry?.list?.() ?? [];
              let ws = items.find((w) => String(w?.path ?? '') === defPath);
              if (!ws) {
                const created = await registry.create(defPath, 'workspace');
                ws = created;
              }
              workspaceId = ws?.id ?? '';
              if (!workspaceId) return send(res, 500, { ok: false, error: '默认工作区创建失败' });
            }
            const ws = registry.get(workspaceId);
            if (!ws) return send(res, 404, { ok: false, error: `分组不存在: ${workspaceId}` });
            await fs.mkdir(ws.path, { recursive: true }).catch(() => {});
            // 官方路径：转发到公开 RPC session/create（与 GUI 分组行「+」按钮一致）：
            //   cwd 自动取分组 path → ensureSession → workspace.attachSession（自动归属）。
            // 修复（实测四处全错，导致「分组下新建会话」恒 500）：
            //   ① 路径是 **/api/session/create**（斜杠），旧写的 `/api/session.create`（点号）回 404；
            //   ② 信封 method 必须与 endpoint 同名：**"session/create"**，旧写 "session.create" 被判不匹配；
            //   ③ 载荷是三层：**payload.args.request**（旧直接放 payload.workspaceId ⇒ 参数描述符报
            //      「missing "request"; unexpected "workspaceId"」）；
            //   ④ **必须带调用方鉴权**：回环请求不带 cookie 时宿主回纯文本 unauthorized，
            //      .json() 直接抛「Unexpected token 'u'」→ 500（这就是用户看到的现象）。
            const hostPort = detectHostPort();
            const cookie = String(req.headers?.cookie ?? '');
            const raw = await fetch(`http://127.0.0.1:${hostPort}/api/session/create`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(cookie ? { cookie } : {}),
                origin: `http://127.0.0.1:${hostPort}`,
              },
              body: JSON.stringify({
                type: 'client-request',
                rpcId: 'sg-new-session',
                method: 'session/create',
                payload: { args: { request: { workspaceId } } },
              }),
            }).then((r) => r.text()).catch((e) => `__fetch_error__${String(e?.message ?? e)}`);
            let rpc = null;
            try { rpc = JSON.parse(raw); } catch {
              // 非 JSON（如未鉴权时的纯文本 unauthorized）→ 给出可读原因，不再抛解析异常
              return send(res, 502, {
                ok: false,
                error: `session/create 转发失败：宿主返回非 JSON（${String(raw).slice(0, 80)}）`,
              });
            }
            const rpcResult = rpc?.result;
            if (!rpcResult?.ok) {
              return send(res, 500, { ok: false, error: rpcResult?.error?.message || 'session.create 转发失败' });
            }
            const sessionId = rpcResult?.value?.sessionId ?? null;
            if (!sessionId) {
              return send(res, 500, { ok: false, error: '会话创建成功但未返回 sessionId' });
            }
            // 「移动 = 工作移交给新建会话」：创建后立即把交接说明 + 行为约束作为首条消息发过去
            // 约定：承接会话只总结情况发给用户、不直接写代码（即使发现 bug 也不动手）
            const userHandoff = typeof body?.handoff === 'string' ? body.handoff.trim() : '';
            const handoff = [userHandoff, HANDOFF_BEHAVIOR_RULE].filter(Boolean).join('\n');
            // 承接会话默认开启自动重命名（约定，会话管理面板可随时关闭）
            tryEnableAutoRename(hooks, sessionId);
            if (handoff) {
              const prompt = await fetch(`http://127.0.0.1:${hostPort}/api/session.prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'client-request',
                  rpcId: 'sg-handoff',
                  method: 'session.prompt',
                  payload: {
                    sessionId,
                    mode: 'queue',
                    content: [{ type: 'text', text: handoff }],
                  },
                }),
              }).then((r) => r.json()).catch(() => ({ result: { ok: false } }));
              const promptOk = prompt?.result?.ok === true;
              return send(res, 200, { ok: true, sessionId, workspaceId, cwd: ws.path, handoff, handoffAccepted: promptOk });
            }
            return send(res, 200, { ok: true, sessionId, workspaceId, cwd: ws.path });
          }

          // 前缀路由未匹配任何分支时必须**回一个响应**：本路由是 kind:'prefix'
          //   （path=/api/session-conductor/group，整个子命名空间都归本插件），
          //   返回 undefined 不会让框架继续找别的路由 —— 请求会**永不响应**（实测：
          //   GET /api/session-conductor/group 缺 workspaceId 时挂死，测试 timeout 124）。
          return send(res, 404, { ok: false, error: `未知分组接口: ${p}` });
        } catch (e) {
          return send(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      },
    }));
  });

  console.log(`[session-conductor:group] 已启动（只读展示 + 分组下新建会话）: groupRoot=${groupRoot}`);
}