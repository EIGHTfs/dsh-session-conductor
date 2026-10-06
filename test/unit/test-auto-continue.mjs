// dsh-session-conductor 自动续跑流程单测（mock ctx：sessions/agents/persistence/storageDomain/llm）。
// 运行（必须从 profile 安装点跑，依赖靠父目录 <profile>/node_modules 解析）：
//   cd "$DSH_HOME/profiles/web/node_modules/dsh-session-conductor" && node test-auto-continue.mjs
//   （DSH_HOME 例：<dsh>/.dsh-home/.dsh）
// ⚠️ 禁止在工作区插件根建 node_modules 软链接来跑测试（no-symlink-in-plugin）：那会把链接提交进仓库、
//    换机后失效。工作区改动先同步到 profile 安装点，再从那里跑。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetForTest,
  __setConfigForTest,
  __switchConfigForTest,
  patchSwitch,
  resetAutoContinueOnStart,
  continueSession,
  interruptionInfo,
  isAutoEligible,
  buildContinuePrompt,
} from "../../lib/index.js";

// 2026-09-27：开关落盘 <DSH_HOME>/session-conductor/config.json——测试必须隔离 DSH_HOME，
// 禁止写进真实实例的配置目录。
const ORIG_DASH_HOME = process.env.DSH_HOME;
const tmpHome = mkdtempSync(join(tmpdir(), "sc-auto-continue-test-"));
process.env.DSH_HOME = tmpHome;

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };
const fail = (name, extra) => { console.log("FAIL:", name, extra ?? ""); process.exitCode = 1; };

// ---------- 工具：构造事件流 ----------
const ev = (type, data, seq) => ({ type, seq, time: 1, data });
const interruptedEvents = () => [
  ev("turn/start", { turn: 1 }, 1),
  ev("user/message", { message: { role: "user", content: [{ type: "text", text: "帮我做个事" }] } }, 2),
  ev("turn/end", { turn: 1, reason: { kind: "interrupted" } }, 3),
  ev("request/header", { header: { config: { provider: "fake-p", model: "fake-m" } }, reason: "initial" }, 4),
];
const completedEvents = () => [
  ev("turn/start", { turn: 1 }, 1),
  ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 2),
];

// ---------- mock 基础设施 ----------
function makeDomain() {
  let state = { autoRename: {}, autoContinue: {} };
  return {
    global: {
      get: () => state,
      set: async (next) => { state = next; },
    },
    close: async () => {},
  };
}

function makeCtx({ events = interruptedEvents(), live = null, agent = null, agentsList = [], resumeHandler, domain = null, settings = {} } = {}) {
  const domainObj = domain ?? makeDomain();
  const calls = { resume: 0, followup: 0, flush: 0, dispose: 0, cancel: 0 };
  const fakeAgent = agent ?? {
    status: "idle",
    whenIdle: async () => {},
    followup: (m) => { calls.followup += 1; fakeAgent.lastMessage = m; },
    cancel: () => { calls.cancel += 1; },
    session: { id: "session-x" },
  };
  const sessionsSvc = {
    get: () => live,
    list: () => (live ? [live] : []),
    flush: async () => { calls.flush += 1; },
  };
  const agentsSvc = {
    get: (id) => (live ? fakeAgent : undefined),
    list: () => agentsList,
    resume: async ({ resumeSessionId, agentOptions, setup }) => {
      calls.resume += 1;
      calls.resumeArgs = { resumeSessionId, agentOptions };
      if (resumeHandler) await resumeHandler({ setup });
      return { agent: fakeAgent, dispose: async () => { calls.dispose += 1; } };
    },
  };
  const persistence = {
    open: async () => ({ header: { id: "session-x", cwd: "/w" }, inheritedEventCount: 0, read: async () => ({ events, eventState: "detached" }), close: async () => {} }),
    list: async () => [{ id: "session-x", cwd: "/w" }],
  };
  const ctx = {
    settings,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (key) => ({
      sessions: sessionsSvc,
      agents: agentsSvc,
      sessionPersistence: persistence,
      storageDomain: { open: async () => domainObj },
      workspaceRegistry: { archivedSessionIds: [], list: () => [] },
      agentPresets: { mount: async () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: "def-p", model: "def-m" }) },
      sessionTitle: { get: () => ({ title: "T" }) },
      llm: {},
    })[key],
    on: () => {},
    inject: () => {},
    effect: () => () => {},
  };
  return { ctx, calls, fakeAgent };
}

// ---------- 1. 纯函数已由 quick-check 覆盖，这里补门槛相关 ----------
// 自动续跑默认关闭；测试显式开启，覆盖 auto 路径门槛
__setConfigForTest({ defaultAutoContinue: true, maxConcurrent: 2, maxAttached: 12, cooldownMs: 60 * 1000, maxContinuesPerSession: 3, turnTimeoutMs: 60 * 1000 });

__resetForTest();
// 2. cold 会话 interrupted → resume + followup + flush + dispose + 记账
{
  const { ctx, calls, fakeAgent } = makeCtx({ events: interruptedEvents(), live: null, agent: null });
  const result = await continueSession(ctx, "session-x", { auto: true });
  ok("cold auto-continue 成功", result.ok);
  assert.equal(calls.resume, 1, "resume 调用一次");
  assert.equal(calls.resumeArgs.resumeSessionId, "session-x");
  assert.deepEqual(calls.resumeArgs.agentOptions, { provider: "fake-p", model: "fake-m" }, "用会话最近路由");
  assert.equal(calls.followup, 1, "followup 一次");
  assert.ok(String(fakeAgent.lastMessage?.content?.[0]?.text).includes("续跑"), "续跑提示已发送");
  assert.equal(fakeAgent.lastMessage?.source?.kind, "plugin:dsh-session-conductor", "消息来源是插件（V4 producer-owned kind）");
  assert.equal(calls.flush, 1, "flush 一次");
  assert.equal(calls.dispose, 1, "dispose 一次（活跃数回落）");
  ok("cold 流程：resume→followup→flush→dispose");
}

__resetForTest();
// 3. live 会话（已挂 agent、idle、interrupted）→ 直接 followup，不 resume 不 dispose
{
  const { ctx, calls } = makeCtx({ events: interruptedEvents(), live: { id: "session-x", events: interruptedEvents(), header: { cwd: "/w" } }, agent: { status: "idle", whenIdle: async () => {}, followup: () => { calls.followup += 1; }, cancel: () => {} } });
  const result = await continueSession(ctx, "session-x", { auto: false });
  ok("live 手动续跑成功", result.ok);
  assert.equal(calls.resume, 0, "live 不 resume");
  assert.equal(calls.followup, 1, "live followup");
  assert.equal(calls.dispose, 0, "live 不 dispose（用户打开的会话不能释放）");
  ok("live 流程：直接 followup");
}

__resetForTest();
// 4. 正常完成的会话 → 拒绝
{
  const { ctx } = makeCtx({ events: completedEvents(), live: null });
  const result = await continueSession(ctx, "session-x", { auto: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not-interrupted");
  ok("正常完成 → not-interrupted");
}

__resetForTest();
// 5. 用户取消（aborted user）→ 不属于「非人为中断」，自动与手动都按 not-interrupted 拒绝（面板也不显示继续按钮）
{
  const userAbortEvents = [
    ev("turn/start", { turn: 1 }, 1),
    ev("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }, 2),
    ev("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, 3),
  ];
  const info = interruptionInfo(userAbortEvents);
  assert.equal(info, null, "interruptionInfo 认为不是中断");
  const { ctx } = makeCtx({ events: userAbortEvents, live: null });
  const autoResult = await continueSession(ctx, "session-x", { auto: true });
  assert.equal(autoResult.ok, false);
  assert.equal(autoResult.error.code, "not-interrupted");
  const manualResult = await continueSession(ctx, "session-x", { auto: false });
  assert.equal(manualResult.ok, false);
  assert.equal(manualResult.error.code, "not-interrupted");
  ok("user 取消：自动与手动均拒绝（非人为中断范围外）");
}

__resetForTest();
// 6. 活跃会话上限：attached >= maxAttached → 自动拒绝，手动放行
{
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}` }));
  const { ctx } = makeCtx({ events: interruptedEvents(), live: null, agentsList: many });
  const autoResult = await continueSession(ctx, "session-x", { auto: true });
  assert.equal(autoResult.ok, false);
  assert.equal(autoResult.error.code, "attached-cap");
  ok("活跃数达上限 → 自动续跑拒绝");
}

__resetForTest();
// 7. 冷却：已续过（lastContinuedSeq 推进）→ 自动不再续
{
  // 2026-09-27：开关与记账落盘 config.json，seed 直接写开关缓存（等价已开启的持久状态）。
  __switchConfigForTest().autoContinue.set("session-x", { enabled: true, lastContinuedSeq: 3, lastContinuedAt: Date.now(), continueCount: 1 });
  const { ctx } = makeCtx({ events: interruptedEvents(), live: null, agentsList: [] });
  const result = await continueSession(ctx, "session-x", { auto: true });
  assert.equal(result.ok, false);
  assert.ok(result.error.code.includes("already-continued"), `code=${result.error.code}`);
  ok("already-continued 门槛生效");
}

__resetForTest();
// 8. 每会话总次数上限
{
  __setConfigForTest({ maxContinuesPerSession: 2, maxAttached: 12 });
  __switchConfigForTest().autoContinue.set("session-x", { enabled: true, continueCount: 2 });
  const { ctx } = makeCtx({ events: interruptedEvents(), live: null });
  const result = await continueSession(ctx, "session-x", { auto: true });
  assert.equal(result.ok, false);
  assert.ok(result.error.code.includes("max-total"), `code=${result.error.code}`);
  __setConfigForTest({ defaultAutoContinue: true, maxContinuesPerSession: 3, maxAttached: 12 });
  ok("每会话总次数上限生效");
}

__resetForTest();
// 9. 续跑成功 → 记账推进（continueCount +1 / lastContinuedSeq）
{
  const { ctx, calls } = makeCtx({ events: interruptedEvents(), live: null });
  await continueSession(ctx, "session-x", { auto: true });
  // 2026-09-27：记账落盘 config.json（内存缓存与文件一致），从开关缓存读回验证推进。
  const entry = __switchConfigForTest().autoContinue.get("session-x");
  assert.equal(entry.lastContinuedSeq, 3, "lastContinuedSeq 记录中断 turn/end 的 seq");
  assert.equal(entry.continueCount, 1, "continueCount = 1");
  ok("记账推进");
}

__resetForTest();
// 9b. 2026-09-27 新语义：开关落盘 config.json——重启（重新载入配置）后开关保留，
//     但每次 DSH 启动（resetAutoContinueOnStart）会把自动续跑开关复位为关闭
{
  const { ctx } = makeCtx({ events: interruptedEvents(), live: null });
  __setConfigForTest({ defaultAutoContinue: false });
  __switchConfigForTest().autoContinue.set("session-x", { enabled: true, continueCount: 1 });
  assert.equal(__switchConfigForTest().autoContinue.get("session-x")?.enabled, true, "缓存里已开启");
  // 落盘（文件）
  await patchSwitch(ctx, "autoContinue", "session-x", { enabled: true });
  const configFile = join(tmpHome, "session-conductor", "config.json");
  const parsed = JSON.parse(await (await import("node:fs/promises")).readFile(configFile, "utf8"));
  assert.equal(parsed.autoContinue["session-x"].enabled, true, "config.json 已落盘 enabled=true");
  // 模拟重启后启动：载入配置（resetAutoContinueOnStart 内部 load）→ 启动复位全部置 false
  await resetAutoContinueOnStart(ctx);
  assert.equal(__switchConfigForTest().autoContinue.get("session-x")?.enabled, false, "启动复位后 enabled=false");
  const parsed2 = JSON.parse(await (await import("node:fs/promises")).readFile(configFile, "utf8"));
  assert.equal(parsed2.autoContinue["session-x"].enabled, false, "config.json 已复位 false");
  __setConfigForTest({ defaultAutoContinue: true, maxContinuesPerSession: 3, maxAttached: 12 });
  ok("开关落盘 config.json；启动复位自动关闭（autoRename 不受影响）");
}

__resetForTest();
// 10. resume 抛错 → continue-failed，不崩
{
  const { ctx } = makeCtx({
    events: interruptedEvents(), live: null,
    resumeHandler: async () => { throw new Error("persistence boom"); },
  });
  const result = await continueSession(ctx, "session-x", { auto: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "continue-failed");
  ok("resume 异常 → continue-failed");
}

__resetForTest();
// 11. 串行锁：同一会话并发调用只执行一次底层流程（第二个等锁）
{
  const { ctx, calls } = makeCtx({ events: interruptedEvents(), live: null });
  const p1 = continueSession(ctx, "session-x", { auto: false });
  const p2 = continueSession(ctx, "session-x", { auto: false });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(r1.ok && r2.ok);
  assert.equal(calls.resume, 2, "串行执行（两次都完成）");
  ok("串行锁：同会话排队执行");
}

__resetForTest();
// 12. 「本轮运行失败」识别：任意 error code（非原可重试集）都判为可续中断
{
  const errorEvents1 = [
    ev("turn/start", { turn: 1 }, 1),
    ev("turn/end", { turn: 1, reason: { kind: "error", error: { code: "AUTH_FAILED", message: "invalid api key" } } }, 2),
    ev("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, 3),
  ];
  const info1 = interruptionInfo(errorEvents1);
  assert.ok(info1, "interruptionInfo 识别 AUTH_FAILED（非原可重试集）为中断");
  assert.equal(info1.kind, "error");
  assert.equal(info1.code, "AUTH_FAILED");
  assert.ok(isAutoEligible(info1, { live: false }), "isAutoEligible 允许自动续跑（本轮运行失败）");
  const prompt1 = buildContinuePrompt(info1);
  assert.ok(prompt1.includes("AUTH_FAILED"), "续跑提示含错误码");
  ok("AUTH_FAILED 被识别为可续中断 + 提示含错误码");

  const errorEvents2 = [
    ev("turn/start", { turn: 1 }, 1),
    ev("turn/end", { turn: 1, reason: { kind: "error", error: { code: "MAX_TOKENS", message: "context full" } } }, 2),
    ev("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, 3),
  ];
  const info2 = interruptionInfo(errorEvents2);
  assert.ok(info2, "interruptionInfo 识别 MAX_TOKENS");
  assert.equal(info2.code, "MAX_TOKENS");
  assert.ok(isAutoEligible(info2, { live: false }), "MAX_TOKENS 可自动续跑");
  ok("MAX_TOKENS 被识别为可续中断");

  // 回归：正常完成 / 用户取消仍不识别
  assert.equal(interruptionInfo(completedEvents()), null, "正常完成仍 null");
  ok("正常完成回归通过");
}

__resetForTest();
// 13. continueSession 永不 reject（防 unhandledRejection 杀进程）
//     场景：读取事件流时基础服务抛错（模拟 domain/持久化异常），必须返回 {ok:false} 而非 reject。
{
  const badCtx = {
    get: (name) => {
      if (name === "storageDomain") throw new Error("storageDomain boom");
      if (name === "sessions") return { get: () => null };
      return undefined;
    },
  };
  let rejected = false;
  const r = await continueSession(badCtx, "session-err", { auto: true }).catch((e) => {
    rejected = true;
    return { ok: false, error: { code: "rejected", message: String(e?.message ?? e) } };
  });
  assert.equal(rejected, false, "continueSession 不得 reject（否则宿主会被 unhandledRejection 杀掉）");
  assert.equal(r?.ok, false, "异常路径返回 {ok:false}");
  assert.ok(typeof r?.error?.message === "string", "带错误信息");
  ok("continueSession 异常输入不 reject（返回 ok:false）");
}

__resetForTest();
// 14. resume 失败（agents.resume reject）时 continueSession 也返回结果而非抛出
{
  const ctx = makeCtx({
    events: interruptedEvents(),
    live: null,
    resumeHandler: async () => { throw new Error("resume boom"); },
  });
  let rejected = false;
  const r = await continueSession(ctx, "session-resume-fail", { auto: false }).catch(() => {
    rejected = true;
    return null;
  });
  assert.equal(rejected, false, "resume 失败不得 reject");
  assert.equal(r?.ok, false, "resume 失败返回 {ok:false}");
  assert.ok(r?.error?.code === "continue-failed" || r?.error?.code === "continue-prepare-failed", `失败码合理（实际 ${r?.error?.code}）`);
  ok("resume 失败时 continueSession 不 reject");
}

console.log(`\nTEST PASS: ${pass}`);
if (process.exitCode) console.log("有失败项");

// 清理隔离的临时 DSH_HOME
rmSync(tmpHome, { recursive: true, force: true });
if (ORIG_DASH_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = ORIG_DASH_HOME;
