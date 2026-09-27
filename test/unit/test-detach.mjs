// dsh-session-conductor 手动释放（置为不活跃）单测（mock ctx）。
// 运行：cd dsh-sm-test/profiles/web/node_modules_local/dsh-session-conductor && node test-detach.mjs
import assert from "node:assert/strict";
import { detachSessionAgent, detachAllIdleSessions, __resetForTest } from "../../lib/index.js";

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };
const fail = (name, extra) => { console.log("FAIL:", name, extra ?? ""); process.exitCode = 1; };

const ev = (type, data, seq) => ({ type, seq, time: 1, data });
const idleEvents = () => [ev("turn/start", { turn: 1 }, 1), ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 2)];
const openEvents = () => [ev("turn/start", { turn: 1 }, 1)];

function makeAgent({ running = false, scopeDispose = async () => {} } = {}) {
  const calls = { cancel: 0, whenIdle: 0, scopeDispose: 0 };
  return {
    calls,
    status: running ? "running" : "idle",
    cancel: (cause, opts) => { calls.cancel += 1; },
    whenIdle: async () => { calls.whenIdle += 1; },
    scope: { dispose: async () => { calls.scopeDispose += 1; } },
  };
}

function makeCtx({ sessions = [], agentsById = {}, subagentOrigin = false } = {}) {
  const calls = { flush: 0, sessionDetach: 0, emitDisposed: 0 };
  const sessionObjs = sessions.map((events) => ({
    id: "session-x",
    events,
    header: { origin: subagentOrigin ? "subagent" : "main", parentSession: undefined, cwd: "/w" },
  }));
  const sessionsStore = new Map();
  for (const s of sessionObjs) {
    sessionsStore.set(s.id, { id: s.id, session: s, detach: () => { calls.sessionDetach += 1; } });
  }
  const agentsStore = new Map();
  for (const [id, agent] of Object.entries(agentsById)) {
    agentsStore.set(id, { id, agent, announced: true, carrier: {} });
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (key) => ({
      agents: {
        get: (id) => agentsById[id],
        list: () => Object.values(agentsById),
        store: agentsStore,
        emitDisposed: (entry) => { calls.emitDisposed += 1; },
      },
      sessions: {
        get: (id) => sessionObjs.find((s) => s.id === id),
        list: () => sessionObjs,
        flush: async () => { calls.flush += 1; },
        store: sessionsStore,
      },
      workspaceRegistry: { archivedSessionIds: [] },
      sessionPersistence: { open: async () => ({ header: { id: "session-x" }, inheritedEventCount: 0, read: async () => ({ events: [], eventState: "detached" }), close: async () => {} }) },
    })[key],
  };
  return { ctx, calls };
}

// ---------- 1. live 空闲 → 完整拆卸 ----------
{
  __resetForTest();
  const agent = makeAgent();
  const { ctx, calls } = makeCtx({ sessions: [idleEvents()], agentsById: { "session-x": agent } });
  const result = await detachSessionAgent(ctx, "session-x");
  assert.equal(result.ok, true, "detach 成功");
  assert.equal(agent.calls.cancel, 1, "cancel 一次");
  assert.equal(agent.calls.whenIdle, 1, "whenIdle 一次");
  assert.equal(agent.calls.scopeDispose, 1, "scope.dispose 一次");
  assert.equal(calls.emitDisposed, 1, "agent/disposed 广播一次");
  assert.equal(ctx.get("agents").store.has("session-x"), false, "agents 注册表已移除");
  assert.equal(calls.flush, 1, "session flush 一次");
  assert.equal(calls.sessionDetach, 1, "session detach 一次");
  ok("live 空闲 → cancel/whenIdle/scope.dispose/注册表移除/emitDisposed/flush/detach 全链路");
}

// ---------- 2. 运行中 → 拒绝 ----------
{
  __resetForTest();
  const agent = makeAgent({ running: true });
  const { ctx } = makeCtx({ sessions: [openEvents()], agentsById: { "session-x": agent } });
  const result = await detachSessionAgent(ctx, "session-x");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "running");
  assert.equal(ctx.get("agents").store.has("session-x"), true, "未拆卸");
  ok("运行中 → running 拒绝");
}

// ---------- 3. 非 live（冷会话）→ not-live 幂等 ----------
{
  __resetForTest();
  const { ctx } = makeCtx({ sessions: [], agentsById: {} });
  const result = await detachSessionAgent(ctx, "session-x");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not-live");
  ok("冷会话 → not-live");
}

// ---------- 4. subagent 拥有 → 拒绝 ----------
{
  __resetForTest();
  const agent = makeAgent();
  const { ctx } = makeCtx({ sessions: [idleEvents()], agentsById: { "session-x": agent }, subagentOrigin: true });
  const result = await detachSessionAgent(ctx, "session-x");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "subagent-owned");
  assert.equal(ctx.get("agents").store.has("session-x"), true, "未拆卸");
  ok("subagent → subagent-owned 拒绝");
}

// ---------- 5. detachAllIdleSessions：释放空闲、跳过运行中 ----------
{
  __resetForTest();
  const idleAgent = makeAgent();
  const runningAgent = makeAgent({ running: true });
  const idleEvents2 = () => [ev("turn/start", { turn: 1 }, 1), ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 2)];
  const runningEvents = () => [ev("turn/start", { turn: 1 }, 1)];
  // 两个会话：session-idle（空闲）、session-run（运行中）
  const sessions = [
    { id: "session-idle", events: idleEvents2(), header: { origin: "main", cwd: "/w" } },
    { id: "session-run", events: runningEvents(), header: { origin: "main", cwd: "/w" } },
  ];
  const byId = { "session-idle": idleAgent, "session-run": runningAgent };
  const sessionsStore = new Map();
  for (const s of sessions) sessionsStore.set(s.id, { id: s.id, session: s, detach: () => {} });
  const agentsStore = new Map();
  for (const [id, a] of Object.entries(byId)) agentsStore.set(id, { id, agent: a, announced: true, carrier: {} });
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (key) => ({
      agents: { get: (id) => byId[id], list: () => Object.values(byId), store: agentsStore, emitDisposed: () => {} },
      sessions: { get: (id) => sessions.find((s) => s.id === id), list: () => sessions, flush: async () => {}, store: sessionsStore },
      workspaceRegistry: { archivedSessionIds: [] },
      sessionPersistence: { open: async () => ({ header: {}, inheritedEventCount: 0, read: async () => ({ events: [], eventState: "detached" }), close: async () => {} }) },
    })[key],
  };
  const result = await detachAllIdleSessions(ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.released, ["session-idle"], "释放空闲");
  assert.equal(result.skipped.length, 1, "跳过运行中");
  assert.equal(result.skipped[0].id, "session-run");
  assert.equal(agentsStore.has("session-idle"), false, "空闲 agent 已移除");
  assert.equal(agentsStore.has("session-run"), true, "运行中 agent 保留");
  ok("detachAll：释放空闲、跳过运行中");
}

console.log(`\nTEST PASS: ${pass}`);
if (process.exitCode) console.log("有失败项");
