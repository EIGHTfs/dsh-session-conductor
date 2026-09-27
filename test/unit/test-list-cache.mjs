// dsh-session-conductor 会话列表「落盘缓存 + 懒加载」单测（v1.35.10）。
//
// 为什么单独一个测试文件：test-auto-continue.mjs 覆盖自动续跑流程，本文件覆盖会话列表的
// 内存策略——这是 v1.35.10 修的堆 OOM 根因所在（原代码把全部冷会话一次性并发 inspect，
// 实测 88 秒把 2GB 堆打满、进程被杀）。核心断言只有一条：
// **日志没变过的会话，第二次列列表时一次 inspect 都不许做。**
//
// 运行（必须从 profile 安装点跑，依赖靠父目录 <profile>/node_modules 解析）：
//   cd "$DSH_HOME/profiles/web/node_modules/dsh-session-conductor" && node test-list-cache.mjs
// ⚠️ 禁止在工作区插件根建 node_modules 软链接来跑测试（no-symlink-in-plugin）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSessionListCached, __resetForTest, __setConfigForTest } from "../../lib/index.js";

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };

/** 每个场景用独立临时 DSH_HOME，保证落盘缓存互不串（也绝不碰真实实例的 storages）。 */
const tmpHomes = [];
function makeTmpHome() {
  const dir = mkdtempSync(path.join(tmpdir(), "conductor-listcache-"));
  tmpHomes.push(dir);
  process.env.DSH_HOME = dir;
  return dir;
}

/** 造一条 turn/end(reason=interrupted) 事件，使 interruptionInfo 判定为可续中断。 */
function interruptedEvents() {
  return [
    { type: "request/header", seq: 0, data: { provider: "fake-p", model: "fake-m" } },
    { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "干活" }] } },
    { type: "turn/end", seq: 3, data: { reason: { kind: "interrupted" } } },
  ];
}

/** 造一条带标题的事件流（foldTitle 取**最后一条** session/title 事件的 data.title）。 */
function titledEvents(title) {
  return [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "干活" }] } },
    { type: "session/title", seq: 1, data: { title } },
    { type: "turn/end", seq: 2, data: { reason: null } },
  ];
}

/**
 * mock 插件上下文。inspectCalls 记录每次 inspect 的会话 id——
 * 「懒加载」的验收标准就是它的内容（第二次应该为空）。
 */
function makeCtx({ snapshots, eventsById = {}, inspectFails = new Set() }) {
  const openCalls = [];
  const domain = {
    global: {
      _state: { autoRename: {}, autoContinue: {} },
      get() { return this._state; },
      async set(next) { this._state = next; },
    },
  };
  const persistence = {
    async listSnapshots() { return snapshots(); },
    async list() { return snapshots().map((s) => s.header); },
    // 0.1.6 起插件用官方 handle 读法（open→read→close）替代已失效的 inspect；openCalls 等价记录原 inspectCalls 的语义
    async open(id, mode) {
      openCalls.push(id);
      if (inspectFails.has(id)) throw new Error(`inspect boom ${id}`);
      return {
        header: { id, createdAt: 1000 },
        inheritedEventCount: 0,
        async read() { return { events: eventsById[id] ?? [], eventState: "detached" }; },
        async close() {},
      };
    },
  };
  const ctx = {
    get(name) {
      if (name === "sessions") return { list: () => [] };
      if (name === "workspaceRegistry") return { archivedSessionIds: [] };
      if (name === "sessionPersistence") return persistence;
      if (name === "storageDomain") return { open: async () => domain };
      return undefined;
    },
    effect() {},
    on() {},
  };
  return { ctx, inspectCalls: openCalls };
}

// ---------------------------------------------------------------- 场景 1
__resetForTest();
{
  makeTmpHome();
  const ids = ["session-a", "session-b", "session-c"];
  const { ctx, inspectCalls } = makeCtx({
    snapshots: () => ids.map((id) => ({ header: { id, createdAt: 1000, cwd: "/x" }, revision: `rev-${id}-1` })),
    eventsById: Object.fromEntries(ids.map((id) => [id, titledEvents(`标题 ${id}`)])),
  });

  const first = await buildSessionListCached(ctx, { force: true });
  assert.equal(first.length, 3, "三条会话都在列表里");
  assert.equal(inspectCalls.length, 3, "首次无缓存 → 三条都要解析");
  assert.equal(first.find((s) => s.id === "session-a").title, "标题 session-a", "标题解析正确");

  // 落盘缓存必须真的写了文件（「持久性保存」的验收点）
  const cacheFile = path.join(process.env.DSH_HOME, "storages", "dsh-session-conductor", "list-cache.json");
  assert.ok(existsSync(cacheFile), "落盘缓存文件已生成");
  const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
  assert.equal(Object.keys(parsed.entries).length, 3, "缓存里三条都在");

  // 核心：revision 没变 → 第二次一次 inspect 都不做
  inspectCalls.length = 0;
  const second = await buildSessionListCached(ctx, { force: true });
  assert.equal(inspectCalls.length, 0, "日志未变 → 第二次零 inspect（懒加载核心）");
  assert.equal(second.length, 3, "仍返回三条");
  assert.equal(second.find((s) => s.id === "session-b").title, "标题 session-b", "标题来自缓存，未解析也正确");
  ok("缓存命中：revision 未变则不解析（零 inspect）");
}

// ---------------------------------------------------------------- 场景 2
__resetForTest();
{
  makeTmpHome();
  let revisions = { "session-a": "rev-a-1", "session-b": "rev-b-1" };
  const { ctx, inspectCalls } = makeCtx({
    snapshots: () => Object.entries(revisions).map(([id, rev]) => ({ header: { id, createdAt: 1000 }, revision: rev })),
    eventsById: { "session-a": titledEvents("A"), "session-b": titledEvents("B") },
  });

  await buildSessionListCached(ctx, { force: true });
  assert.equal(inspectCalls.length, 2, "首次两条都解析");

  // 只有 a 的日志被追加过（revision 变化）
  revisions = { "session-a": "rev-a-2", "session-b": "rev-b-1" };
  inspectCalls.length = 0;
  const after = await buildSessionListCached(ctx, { force: true });
  assert.deepEqual(inspectCalls, ["session-a"], "只有变化的会话被重新解析");
  assert.equal(after.length, 2, "两条都在");
  ok("增量：只有 revision 变化的会话重新解析");
}

// ---------------------------------------------------------------- 场景 3
__resetForTest();
{
  makeTmpHome();
  const { ctx, inspectCalls } = makeCtx({
    snapshots: () => [{ header: { id: "session-a", createdAt: 1000 }, revision: "rev-a-1" }],
    eventsById: { "session-a": titledEvents("第一次") },
  });

  await buildSessionListCached(ctx, { force: true });

  // 模拟「进程重启」：内存态全清（落盘缓存文件保留），事务应仍走缓存
  __resetForTest();
  const { ctx: ctx2, inspectCalls: calls2 } = makeCtx({
    snapshots: () => [{ header: { id: "session-a", createdAt: 1000 }, revision: "rev-a-1" }],
    eventsById: { "session-a": titledEvents("不该被读到") },
  });
  const afterRestart = await buildSessionListCached(ctx2, { force: true });
  assert.equal(calls2.length, 0, "重启后命中落盘缓存，不解析");
  assert.equal(afterRestart[0].title, "第一次", "标题来自落盘缓存（而非重新解析）");
  assert.equal(inspectCalls.length, 1, "重启前只解析过一次");
  ok("持久性：进程重启后仍命中落盘缓存");
}

// ---------------------------------------------------------------- 场景 4
__resetForTest();
{
  makeTmpHome();
  const { ctx, inspectCalls } = makeCtx({
    snapshots: () => [{ header: { id: "session-bad", createdAt: 1000 }, revision: "rev-bad-1" }],
    inspectFails: new Set(["session-bad"]),
  });
  const items = await buildSessionListCached(ctx, { force: true });
  assert.equal(items.length, 1, "解析失败的会话仍出现在列表（降级呈现）");
  assert.ok(typeof items[0].inspectError === "string", "带出 inspectError 便于诊断");
  assert.equal(inspectCalls.length, 1, "只试一次");
  ok("解析失败：会话不丢、带错误信息、不抛");
}

// ---------------------------------------------------------------- 场景 5
__resetForTest();
{
  const home = makeTmpHome();
  const cacheFile = path.join(home, "storages", "dsh-session-conductor", "list-cache.json");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, "{ 这不是合法 JSON", "utf8"); // 模拟缓存损坏
  const { ctx } = makeCtx({
    snapshots: () => [{ header: { id: "session-a", createdAt: 1000 }, revision: "rev-a-1" }],
    eventsById: { "session-a": titledEvents("损坏后仍可用") },
  });
  const items = await buildSessionListCached(ctx, { force: true });
  assert.equal(items.length, 1, "缓存损坏时仍正常返回列表");
  assert.equal(items[0].title, "损坏后仍可用", "内容正确");
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).version, 1, "损坏文件已被合法缓存覆盖");
  ok("缓存损坏：按空缓存继续，不抛且自动重建");
}

// ---------------------------------------------------------------- 场景 6
__resetForTest();
{
  makeTmpHome();
  // 后端不支持 listSnapshots（老后端）→ 退化为每次都解析，但绝不能崩
  let listCalls = 0;
  const domain = {
    global: { _state: { autoRename: {}, autoContinue: {} }, get() { return this._state; }, async set(n) { this._state = n; } },
  };
  const ctx = {
    get(name) {
      if (name === "sessions") return { list: () => [] };
      if (name === "workspaceRegistry") return { archivedSessionIds: [] };
      if (name === "sessionPersistence") {
        return {
          async list() { listCalls += 1; return [{ id: "session-a", createdAt: 1000 }]; },
          async open() {
            return {
              header: { id: "session-a", createdAt: 1000 },
              inheritedEventCount: 0,
              read: async () => ({ events: titledEvents("老后端"), eventState: "detached" }),
              close: async () => {},
            };
          },
        };
      }
      if (name === "storageDomain") return { open: async () => domain };
      return undefined;
    },
    effect() {}, on() {},
  };
  const items = await buildSessionListCached(ctx, { force: true });
  assert.equal(items.length, 1, "无 listSnapshots 时仍能列出会话");
  assert.equal(items[0].title, "老后端", "内容正确");
  assert.ok(listCalls >= 1, "走了 list() 回退路径");
  ok("后端回退：无 listSnapshots 时功能不变、不崩");
}

// ---------------------------------------------------------------- 场景 7
__resetForTest();
{
  makeTmpHome();
  __setConfigForTest({ listInspectBatch: 1 }); // 最小并发，验证分片串行仍能全部列出
  const ids = Array.from({ length: 7 }, (_, i) => `session-${i}`);
  const { ctx, inspectCalls } = makeCtx({
    snapshots: () => ids.map((id) => ({ header: { id, createdAt: 1000 }, revision: `rev-${id}` })),
    eventsById: Object.fromEntries(ids.map((id) => [id, titledEvents(`T${id}`)])),
  });
  const items = await buildSessionListCached(ctx, { force: true });
  assert.equal(items.length, 7, "分片后 7 条全在");
  assert.equal(inspectCalls.length, 7, "每条都解析过一次（分片不影响完整性）");
  __setConfigForTest({ listInspectBatch: 2 });
  ok("分片：listInspectBatch=1 时仍完整列出全部会话");
}

// 清理本测试自己创建的临时 DSH_HOME（逐个精确删除；绝不碰 tmpdir() 本身）
for (const dir of tmpHomes) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响测试结论 */ }
}
console.log(`\nTEST PASS: ${pass}`);
