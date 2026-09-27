/**
 * dsh-session-conductor — 会话分组展示 + 分组下新建会话 单测
 *
 * 2026-09-26 裁剪后 group.js 保留：只读 status/list + new-session（分组下新建会话，
 * workspaceId 缺省 = 上次会话的工作区）。分组管理（create/rename/delete/move）已移除。
 * 覆盖：
 *   1. status：workspaceCount / groupRoot / profile
 *   2. list：workspaces 数组（workspaceId / path / title / sessionIds）
 *   3. new-session 显式 workspaceId → 回环 session.create
 *   4. new-session 缺省 workspaceId → 上次会话工作区（lastSessionCwd）
 *   5. blockGroupNewSession=true → 401
 * 运行：node test/unit/test-group.mjs
 */

import { registerGroupRoutes } from "../../lib/group.js";

const registry = {
  list() {
    return [
      { id: "ws-1", path: "ws-a", title: "项目A", sessionIds: ["s1", "s2"], createdAt: 1, updatedAt: 2 },
      { id: "ws-2", path: "ws-b", title: "项目B", sessionIds: [], createdAt: 3, updatedAt: 4 },
    ];
  },
  get(id) {
    return this.list().find((w) => w.id === id) ?? null;
  },
  create(path, title) {
    return { id: "ws-new-" + String(Math.random()).slice(2, 8), path, title };
  },
};

/** mock ctx：webServer + sessions（含 cwd）+ sessionPersistence。 */
function makeCtx({ sessions = [], cold = [] } = {}) {
  return {
    inject: (deps, fn) => fn({
      get: (name) => {
        if (name === "webServer") return webServer;
        if (name === "sessions") return { list: () => sessions };
        if (name === "sessionPersistence") return { list: async () => cold };
        if (name === "workspaceRegistry") return registry;
        return undefined;
      },
      effect: (fn) => (typeof fn === "function" ? fn() : undefined),
    }),
    effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  };
}

let webServer;
async function makeApp(extraCtx = {}, hooks = {}) {
  const handlers = [];
  webServer = { register(entry) { handlers.push(entry.handler); } };
  const ctx = {
    get: (name) => {
      if (name === "webServer") return webServer;
      if (name === "sessions") return { list: () => extraCtx.sessions ?? [] };
      if (name === "sessionPersistence") return { list: async () => extraCtx.cold ?? [] };
      if (name === "workspaceRegistry") return registry;
      return undefined;
    },
    inject: (deps, fn) => fn({
      get: (name) => {
        if (name === "webServer") return webServer;
        if (name === "sessions") return { list: () => extraCtx.sessions ?? [] };
        if (name === "sessionPersistence") return { list: async () => extraCtx.cold ?? [] };
        if (name === "workspaceRegistry") return registry;
        return undefined;
      },
      effect: (fn) => (typeof fn === "function" ? fn() : undefined),
    }),
    effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  };
  await registerGroupRoutes(ctx, extraCtx.cfg ?? {}, hooks);
  return { handlers };
}

/** 用 fake req/res 调路由 handler；fetch 全局 mock。 */
async function callApi(handler, method, path, body, mockFetch) {
  const req = {
    method,
    url: path,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  let status = 0;
  let body2 = null;
  const res = {
    writeHead(code) { status = code; },
    end(text) { body2 = text ? JSON.parse(text) : null; },
  };
  const prevFetch = globalThis.fetch;
  if (mockFetch) globalThis.fetch = mockFetch;
  try {
    await handler(req, res);
  } finally {
    if (mockFetch) globalThis.fetch = prevFetch;
  }
  return { status, body: body2 };
}

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const okFetch = () => async () => ({ ok: true, json: async () => ({ result: { ok: true, value: { sessionId: "ns-1" } } }) });

console.log("\n[1] group/status");
{
  const { handlers } = await makeApp();
  const { status, body } = await callApi(handlers[0], "GET", "/api/session-conductor/group/status");
  check("status 200 且 ok", status === 200 && body.ok === true, JSON.stringify(body));
  check("workspaceCount = 2", body.workspaceCount === 2, String(body.workspaceCount));
  check("groupRoot 非空", typeof body.groupRoot === "string" && body.groupRoot.length > 0);
}

console.log("\n[2] group/list");
{
  const { handlers } = await makeApp();
  const { status, body } = await callApi(handlers[0], "GET", "/api/session-conductor/group/list");
  check("list 200 且 ok，workspaces = 2", status === 200 && body.ok === true && body.workspaces.length === 2, JSON.stringify(body.workspaces));
  const w1 = body.workspaces.find((w) => w.workspaceId === "ws-1");
  check("ws-1 含 title/sessionIds", w1 && w1.title === "项目A" && w1.sessionIds.length === 2);
}

console.log("\n[3] new-session 显式 workspaceId");
{
  const { handlers } = await makeApp();
  const calls = [];
  const { status, body } = await callApi(handlers[0], "POST", "/api/session-conductor/group/new-session", { workspaceId: "ws-1" }, async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ result: { ok: true, value: { sessionId: "ns-1" } } }) };
  });
  check("new-session 200 且 ok", status === 200 && body.ok === true, JSON.stringify(body));
  const createCall = calls.find((c) => c.url.includes("/api/session.create"));
  check("回环调用 session.create", !!createCall, JSON.stringify(calls));
  const payload = JSON.parse(createCall.init.body);
  check("payload.workspaceId = ws-1", payload?.payload?.workspaceId === "ws-1", JSON.stringify(payload));
  check("返回 sessionId", body.sessionId === "ns-1");
}

console.log("\n[4] new-session 缺省 workspaceId → 上次会话工作区");
{
  // sessions 里最近活跃会话 cwd=ws-b（updatedAt 100）→ ws-2
  const { handlers } = await makeApp({
    sessions: [
      { header: { cwd: "ws-a", createdAt: 10, updatedAt: 20 } },
      { header: { cwd: "ws-b", createdAt: 30, updatedAt: 100 } },
    ],
  });
  const calls = [];
  const { status, body } = await callApi(handlers[0], "POST", "/api/session-conductor/group/new-session", {}, async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ result: { ok: true, value: { sessionId: "ns-2" } } }) };
  });
  check("200 且 ok", status === 200 && body.ok === true, JSON.stringify(body));
  const createCall = calls.find((c) => c.url.includes("/api/session.create"));
  const payload = JSON.parse(createCall.init.body);
  check("workspaceId = 上次会话工作区 ws-2", payload?.payload?.workspaceId === "ws-2", JSON.stringify(payload));
}

console.log("\n[5] blockGroupNewSession=true → 401");
{
  const { handlers } = await makeApp({ cfg: { blockGroupNewSession: true } });
  const { status, body } = await callApi(handlers[0], "POST", "/api/session-conductor/group/new-session", { workspaceId: "ws-1" });
  check("401 + blocked code", status === 401 && body?.code === "group-new-session-blocked", JSON.stringify(body));
}

console.log("\n[6] 非分组路由放行");
{
  const { handlers } = await makeApp();
  const { body } = await callApi(handlers[0], "POST", "/api/session-conductor/group/create", {});
  check("POST group/create 返回 undefined（管理路由已移除）", body === null, String(body));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);