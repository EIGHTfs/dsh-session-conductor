// dsh-session-conductor 全文搜索 + 批量删除 + 按条件删除 单测（mock ctx，多会话）。
// 运行：node test-search-delete.mjs
import assert from "node:assert/strict";
import {
  __resetForTest,
  __setConfigForTest,
  collectSearchableEvents,
  searchEventsText,
  searchSessions,
  deleteBatchSessions,
  deleteByRule,
} from "../../lib/index.js";

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };
const fail = (name, extra) => { console.log("FAIL:", name, extra ?? ""); process.exitCode = 1; };

// ---------- 工具：构造事件流 ----------
const ev = (type, data, seq) => ({ type, seq, time: 1000 + (seq ?? 0), data });
const userMsg = (text, seq) => ev("user/message", { source: { kind: "user" }, content: [{ type: "text", text }] }, seq);
const assistantChunk = (text, seq) => ev("assistant/chunk", { chunk: { blockType: "text", text } }, seq);

/** 构造多会话 mock ctx。sessions 描述：{id, cwd, events, archived?, running?} */
function makeCtx({ sessions = [] } = {}) {
  const liveIds = new Set();
  const liveMap = new Map();
  for (const s of sessions) {
    if (s.live) { liveIds.add(s.id); liveMap.set(s.id, s); }
  }
  const sessionsSvc = {
    get: (id) => liveMap.get(id) ?? undefined,
    list: () => [...liveMap.values()],
    store: new Map(),
  };
  // live 会话需要 header（buildSessionList 读取 header.cwd/createdAt）与 events
  for (const s of sessions) {
    if (s.live && !s.header) s.header = { cwd: s.cwd ?? "/w", createdAt: 1, id: s.id };
  }
  const persistence = {
    // 0.1.6 起官方 inspect 失效，插件改用 handle 读法（open('read')→read(0)→close）
    open: async (id) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new Error("no such session");
      return {
        header: { id: s.id, cwd: s.cwd, createdAt: 1 },
        inheritedEventCount: 0,
        read: async () => ({ events: s.events ?? [], eventState: "detached" }),
        close: async () => {},
      };
    },
    list: async () => sessions.filter((s) => !liveIds.has(s.id)).map((s) => ({ id: s.id, cwd: s.cwd, createdAt: 1 })),
    listArtifacts: async () => [],
  };
  const registry = {
    archivedSessionIds: sessions.filter((s) => s.archived).map((s) => s.id),
    list: () => [],
    state: { archivedSessionIds: sessions.filter((s) => s.archived).map((s) => s.id) },
    requireState: () => registry.state,
    setState: async (next) => { registry.state = next; },
  };
  const domainObj = {
    global: { get: () => ({ autoRename: {}, autoContinue: {} }), set: async () => {} },
    close: async () => {},
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (key) => ({
      sessions: sessionsSvc,
      agents: { list: () => [] },
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
  return { ctx, registry };
}

// ===================================================================
// [1] collectSearchableEvents：提取 user/assistant 文本
// ===================================================================
console.log("\n[1] collectSearchableEvents");
__resetForTest();
{
  const events = [
    userMsg("帮我看看搜索功能怎么做", 1),
    ev("turn/start", { turn: 1 }, 2),
    assistantChunk("搜索功能需要做全文检索", 3),
    ev("tool/call", { callId: "c1", name: "bash", arguments: "{}" }, 4), // 工具调用不入索引
    ev("assistant/chunk", { chunk: { blockType: "tool-call", text: "nope" } }, 5), // 非 text 块不入索引
    assistantChunk("命中测试 keyword 行", 6),
  ];
  const items = collectSearchableEvents(events);
  if (items.length === 3) ok("提取 3 条可搜索文本（user×1 + assistant text×2）");
  else fail("提取数量不对", JSON.stringify(items.map((i) => [i.role, i.text])));
  if (items[0].role === "user" && items[0].text.includes("搜索功能")) ok("首条为 user 消息");
  else fail("首条应为 user 消息", JSON.stringify(items[0]));
}

// [1b] 系统注入的 user/message（source.kind=plugin）不算正文，不入索引
console.log("\n[1b] collectSearchableEvents：系统注入过滤");
__resetForTest();
{
  const events = [
    userMsg("真人消息内容", 1),
    ev("user/message", { source: { kind: "plugin", plugin: "dsh-git-push" }, content: [{ type: "text", text: "系统注入的运行时上下文 skill 目录" }] }, 2),
    ev("user/message", { source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }, content: [{ type: "text", text: "Current runtime context snapshot" }] }, 3),
    assistantChunk("AI 回复也正常入索引", 4),
  ];
  const items = collectSearchableEvents(events);
  if (items.length === 2) ok("只提取真人 user + assistant（注入 2 条被过滤）");
  else fail("注入过滤失败", JSON.stringify(items.map((i) => [i.role, i.text.slice(0, 20)])));
  if (!items.some((i) => i.text.includes("系统注入"))) ok("注入文本未被提取");
  else fail("注入文本不应出现", JSON.stringify(items));
}

// ===================================================================
// [2] searchEventsText：命中 + preview 上下文
// ===================================================================
console.log("\n[2] searchEventsText");
__resetForTest();
{
  const events = [userMsg("今天完成了归档功能开发", 1), assistantChunk("归档功能已通过测试，支持恢复", 2)];
  const hits = searchEventsText(events, "归档");
  if (hits.length === 2) ok("两行都命中「归档」");
  else fail("命中数不对", JSON.stringify(hits));
  if (hits[0].role === "user" && hits[0].preview.includes("归档")) ok("user 命中带上下文 preview");
  else fail("preview 不含命中词", JSON.stringify(hits[0]));
  const none = searchEventsText(events, "不存在的词xyz");
  if (none.length === 0) ok("无命中返回空");
  else fail("不应命中", JSON.stringify(none));
  const maxed = searchEventsText(events, "功能", { perSessionMax: 1 });
  if (maxed.length === 1) ok("perSessionMax 限制生效");
  else fail("perSessionMax 未生效", JSON.stringify(maxed));
}

// ===================================================================
// [3] searchSessions：跨会话 + 归档过滤 + 损坏跳过 + 上限
// ===================================================================
console.log("\n[3] searchSessions");
__resetForTest();
{
  const { ctx } = makeCtx({
    sessions: [
      { id: "s1", cwd: "/w/proj-a", events: [userMsg("会话一的排队列表测试", 1)] },
      { id: "s2", cwd: "/w/proj-b", events: [userMsg("会话二没有目标词", 1), assistantChunk("排队列表在原生 dock 里", 2)] },
      { id: "s3", cwd: "/w/proj-c", events: [userMsg("排队列表第三条", 1)], archived: true },
      { id: "s4", cwd: "/w/proj-d", events: null }, // 损坏/无事件 → 跳过不崩
    ],
  });
  const r = await searchSessions(ctx, "排队列表");
  if (r.hits.length === 3) ok("3 个会话命中（s1/s2/s3）");
  else fail("命中会话数不对", JSON.stringify(r.hits.map((h) => h.sessionId)));
  const ids = r.hits.map((h) => h.sessionId);
  if (ids.includes("s4")) fail("损坏会话不应命中");
  else ok("损坏会话跳过不崩溃");
  const activeOnly = await searchSessions(ctx, "排队列表", { scope: "active" });
  if (activeOnly.hits.length === 2 && !activeOnly.hits.some((h) => h.sessionId === "s3")) ok("scope=active 排除归档会话");
  else fail("scope=active 过滤错误", JSON.stringify(activeOnly.hits.map((h) => h.sessionId)));
  const archOnly = await searchSessions(ctx, "排队列表", { scope: "archived" });
  if (archOnly.hits.length === 1 && archOnly.hits[0].sessionId === "s3") ok("scope=archived 只搜归档");
  else fail("scope=archived 过滤错误", JSON.stringify(archOnly.hits));
  const capped = await searchSessions(ctx, "排队列表", { maxSessions: 2 });
  if (capped.scanned === 2) ok("maxSessions 扫描上限生效");
  else fail("上限未生效", `scanned=${capped.scanned}`);
  const short = await searchSessions(ctx, "排");
  if (short.hits.length === 0 && short.scanned === 0) ok("关键词短于 2 字符不搜索");
  else fail("短词应拒绝", JSON.stringify(short));
}

// ===================================================================
// [4] deleteBatchSessions：运行中跳过 + 正常删除
// ===================================================================
console.log("\n[4] deleteBatchSessions");
__resetForTest();
{
  // running 事件流（open turn）：turn/start 无 turn/end
  const runningEvents = [ev("turn/start", { turn: 9 }, 1), userMsg("在跑", 2)];
  const { ctx } = makeCtx({
    sessions: [
      { id: "run1", cwd: "/w", events: runningEvents, live: true },   // 运行中 → 跳过
      { id: "ok1", cwd: "/w", events: [userMsg("可删", 1)] },          // cold → 删除
      { id: "dup1", cwd: "/w", events: [userMsg("可删", 1)] },         // 重复 id 应去重
    ],
  });
  const r = await deleteBatchSessions(ctx, ["run1", "ok1", "dup1", "dup1", ""]);
  if (r.requested === 3) ok("去重后请求 3 个（run1/ok1/dup1）");
  else fail("去重失败", JSON.stringify(r));
  if (r.skipped.length === 1 && r.skipped[0].sessionId === "run1" && r.skipped[0].reason === "running") ok("运行中会话跳过并汇报 running");
  else fail("运行中未正确跳过", JSON.stringify(r.skipped));
  if (r.deleted.includes("ok1") && r.deleted.includes("dup1")) ok("可删会话全部删除成功");
  else fail("删除结果不对", JSON.stringify(r.deleted));
  const empty = await deleteBatchSessions(ctx, []);
  if (empty.requested === 0) ok("空列表幂等返回");
  else fail("空列表应返回 0", JSON.stringify(empty));
}

// ===================================================================
// [5] deleteByRule：条件过滤 + dryRun 预览 + 执行
// ===================================================================
console.log("\n[5] deleteByRule");
__resetForTest();
{
  const now = Date.now();
  const old = now - 10 * 24 * 3600 * 1000; // 10 天前
  const { ctx } = makeCtx({
    sessions: [
      { id: "a1", cwd: "/w/proj-x", events: [userMsg("a", 1)], archived: true, live: true, updatedAt: old },
      { id: "a2", cwd: "/w/proj-x", events: [userMsg("b", 1)], archived: true, updatedAt: old },
      { id: "a3", cwd: "/w/proj-x", events: [userMsg("c", 1)], updatedAt: now },       // 未归档 + 新 → 不该命中
      { id: "a4", cwd: "/w/proj-y", events: [userMsg("d", 1)], archived: true, updatedAt: old }, // 不同前缀 → 不命中
    ],
  });
  // dryRun 预览：归档 + 超期 + cwd 前缀 proj-x
  const preview = await deleteByRule(ctx, { archivedOnly: true, inactiveDays: 7, cwdPrefix: "/w/proj-x", dryRun: true });
  if (preview.ok && preview.dryRun === true) ok("dryRun 返回预览");
  else fail("dryRun 应返回预览", JSON.stringify(preview));
  const pids = preview.matched.map((m) => m.sessionId);
  if (pids.includes("a1") && pids.includes("a2") && pids.length === 2) ok("命中 a1/a2（归档+超期+前缀），排除 a3/a4");
  else fail("条件过滤错误", JSON.stringify(pids));
  // 执行：a1 live（非 running）也会被删
  const exec = await deleteByRule(ctx, { archivedOnly: true, inactiveDays: 7, cwdPrefix: "/w/proj-x", dryRun: false });
  if (exec.deleted.length === 2 && exec.skipped.length === 0) ok("执行删除 2 个（a1/a2），无跳过");
  else fail("执行结果不对", JSON.stringify({ deleted: exec.deleted, skipped: exec.skipped }));
  // 无条件 + dryRun：全部命中
  const all = await deleteByRule(ctx, { dryRun: true });
  if (all.matched.length === 4) ok("无条件 dryRun 命中全部 4 个");
  else fail("无条件应命中全部", JSON.stringify(all.matched.length));
}

__resetForTest();
// [5b] deleteByRule lowValue：复用价值分析——低价值（灰尘）会话命中，高价值（细节补充）排除
{
  const now = Date.now();
  const old = now - 30 * 24 * 3600 * 1000; // 30 天前
  const { ctx } = makeCtx({
    sessions: [
      // l1：灰尘会话（1 条无细节消息、极旧、事件少）→ assessValue low
      { id: "l1", cwd: "/w", events: [userMsg("帮我看看", 1)], updatedAt: old },
      // l2：有细节补充（+40 分）→ assessValue high，不删
      { id: "l2", cwd: "/w", events: [userMsg("请补充细节再优化一下方案", 1)], updatedAt: old },
      // l3：灰尘 + 新（updatedAt 近）——lowValue 不看时间，只看价值 → 仍 low 命中
      { id: "l3", cwd: "/w", events: [userMsg("嗯", 1)], updatedAt: now },
    ],
  });
  // dryRun：lowValue 预览——l1/l3 低价值命中，l2 高价值排除
  const preview = await deleteByRule(ctx, { lowValue: true, dryRun: true });
  if (!(preview.ok && preview.dryRun === true)) fail("lowValue dryRun 应返回预览", JSON.stringify(preview));
  const pids = preview.matched.map((m) => m.sessionId);
  if (pids.includes("l1") && pids.includes("l3") && !pids.includes("l2")) {
    ok("lowValue：灰尘会话 l1/l3 命中，细节补充 l2 排除");
  } else {
    fail("lowValue 过滤错误", JSON.stringify(pids));
  }
  if (preview.matched.every((m) => m.value === "low")) ok("lowValue 预览带 value=low 标记");
  else fail("预览应标记 value=low", JSON.stringify(preview.matched));

  // lowValue 与其他条件组合：lowValue + archivedOnly → 只删低价值且已归档
  const comb = await deleteByRule(ctx, { lowValue: true, archivedOnly: true, dryRun: true });
  if (comb.matched.length === 0) ok("lowValue+archivedOnly：无归档会话 → 空命中（组合 AND 生效）");
  else fail("组合条件应空命中", JSON.stringify(comb.matched.map((m) => m.sessionId)));
}

console.log(`\nTEST PASS: ${pass}`);
if (process.exitCode) console.log("有失败项");
