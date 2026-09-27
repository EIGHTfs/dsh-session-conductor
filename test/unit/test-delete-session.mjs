// dsh-session-conductor deleteSession 单测（mock ctx：sessions/agents/persistence/storageDomain/registry）。
// 2026-09-26 改名（原 test-delete-offpeak.mjs）：[3][4] 错峰用例随「错峰定时任务功能移除」一并删除，仅保留 deleteSession 锁/拒绝续跑中用例。
// 运行：node test-delete-session.mjs
import assert from "node:assert/strict";
import {
  __resetForTest,
  __setConfigForTest,
  __timersForTest,
  deleteSession,
} from "../../lib/index.js";

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };
const fail = (name, extra) => { console.log("FAIL:", name, extra ?? ""); process.exitCode = 1; };
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---------- 工具：构造事件流（与 test-auto-continue.mjs 一致） ----------
const ev = (type, data, seq) => ({ type, seq, time: 1, data });
const interruptedEvents = () => [
  ev("turn/start", { turn: 1 }, 1),
  ev("user/message", { message: { role: "user", content: [{ type: "text", text: "帮我做个事" }] } }, 2),
  ev("turn/end", { turn: 1, reason: { kind: "interrupted" } }, 3),
  ev("request/header", { header: { config: { provider: "fake-p", model: "fake-m" } }, reason: "initial" }, 4),
];

// ---------- mock 基础设施 ----------
function makeDomain(seed = {}) {
  let state = { autoRename: {}, autoContinue: {}, ...seed };
  return {
    global: { get: () => state, set: async (next) => { state = next; } },
    close: async () => {},
    _state: () => state,
  };
}

function makeCtx({ events = interruptedEvents(), live = null, domain = null, persistenceOverrides = {}, agentsOverrides = {} } = {}) {
  const domainObj = domain ?? makeDomain();
  const calls = { resume: 0, followup: 0, flush: 0, dispose: 0, detach: 0 };
  const fakeAgent = {
    status: "idle",
    whenIdle: async () => {},
    followup: () => { calls.followup += 1; },
    cancel: () => {},
    session: { id: "session-x" },
  };
  const storeEntries = new Map();
  const sessionsSvc = {
    get: () => live,
    list: () => (live ? [live] : []),
    flush: async () => { calls.flush += 1; },
    store: storeEntries,
  };
  const agentsSvc = {
    get: (id) => (live ? fakeAgent : undefined),
    list: () => [],
    resume: async () => {
      calls.resume += 1;
      return { agent: fakeAgent, dispose: async () => { calls.dispose += 1; } };
    },
  };
  const persistence = {
    open: async () => ({ header: { id: "session-x", cwd: "/w" }, inheritedEventCount: 0, read: async () => ({ events, eventState: "detached" }), close: async () => {} }),
    list: async () => [{ id: "session-x", cwd: "/w" }],
    listArtifacts: async () => [],
    ...persistenceOverrides,
  };
  const registry = {
    archivedSessionIds: [],
    list: () => [],
    state: { archivedSessionIds: [] },
    requireState: () => ({ archivedSessionIds: [] }),
    setState: async (next) => { registry.state = next; },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (key) => ({
      sessions: sessionsSvc,
      agents: { ...agentsSvc, ...agentsOverrides },
      sessionPersistence: persistence,
      storageDomain: { open: async () => domainObj },
      workspaceRegistry: registry,
      agentPresets: { mount: async () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: "def-p", model: "def-m" }) },
      sessionTitle: { get: () => ({ title: "T" }) },
      llm: {},
    })[key],
    on: () => {},
    inject: () => {},
    effect: () => () => {},
  };
  return { ctx, calls, domainObj, fakeAgent, registry };
}

// ===================================================================
// [1] 删除补强：per-session 串行锁
// ===================================================================
console.log("\n[1] deleteSession 串行锁");
__resetForTest();
{
  // 同一会话并发删除两次：第二个必须排队，不交错（listArtifacts 挂起期间只允许 1 个活跃）
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ctx } = makeCtx({
    persistenceOverrides: {
      listArtifacts: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return [];
      },
    },
  });
  const p1 = deleteSession(ctx, "session-x");
  const p2 = deleteSession(ctx, "session-x");
  await tick();
  await tick();
  if (maxActive === 1) ok("并发删除不交错：第二个在锁上排队");
  else fail("并发删除交错（删除锁失效）", `maxActive=${maxActive}`);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  if (r1.ok && r2.ok) ok("两次删除都成功（幂等，无重复报错）");
  else fail("删除结果异常", JSON.stringify({ r1, r2 }));
  if (__timersForTest().deleteLocks.size === 0) ok("删除锁执行后释放（deleteLocks 清空）");
  else fail("删除锁残留", `size=${__timersForTest().deleteLocks.size}`);
}

// ===================================================================
// [2] 删除补强：拒绝续跑中 + 清理遗留定时器/开关
// ===================================================================
console.log("\n[2] deleteSession 拒绝续跑中 / 清理定时器");
__resetForTest();
{
  // 续跑中（continueJobs 有标记）→ 拒绝删除
  __timersForTest().continueJobs.set("session-x", Date.now());
  const { ctx } = makeCtx();
  const r = await deleteSession(ctx, "session-x");
  if (!r.ok && r.error.code === "running") ok("续跑中的会话拒绝删除（running）");
  else fail("续跑中应拒绝", JSON.stringify(r));
  __timersForTest().continueJobs.delete("session-x");
}

__resetForTest();
{
  // 删除成功 → 遗留的续跑/重命名防抖定时器与开关一并清理
  // （续跑中标记 continueJobs 有值时删除会被拒绝，故此处不设；删除成功路径下它必为空）
  const { ctx, domainObj } = makeCtx({
    domain: makeDomain({
      autoContinue: { "session-x": { enabled: true, continueCount: 2 } },
      autoRename: { "session-x": { enabled: true } },
    }),
  });
  __timersForTest().continueTimers.set("session-x", setTimeout(() => {}, 60000));
  __timersForTest().pendingTimers.set("session-x", setTimeout(() => {}, 60000));
  const r = await deleteSession(ctx, "session-x");
  if (!r.ok) { fail("删除应成功", JSON.stringify(r)); }
  else {
    if (!__timersForTest().continueTimers.has("session-x")) ok("续跑防抖定时器已清理");
    else fail("续跑防抖定时器未清理");
    if (!__timersForTest().pendingTimers.has("session-x")) ok("重命名防抖定时器已清理");
    else fail("重命名防抖定时器未清理");
    if (!__timersForTest().continueJobs.has("session-x")) ok("续跑中标记无残留");
    else fail("续跑中标记残留");
    if (domainObj._state().autoContinue["session-x"] === undefined) ok("autoContinue 开关已清理");
    else fail("autoContinue 开关未清理");
    if (domainObj._state().autoRename["session-x"] === undefined) ok("autoRename 开关已清理");
    else fail("autoRename 开关未清理");
  }
}

// ===================================================================

console.log(`\nTEST PASS: ${pass}`);
if (process.exitCode) console.log("有失败项");
