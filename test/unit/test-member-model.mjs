// dsh-session-conductor 成员模型切换单测（findTargetAgent / switchAgentModel，mock ctx）。
// 覆盖：成员定位（名册/sessionId/标题/无匹配/多匹配）、状态门禁、组合校验、
//      切模型（live agent 写事件；未挂载直接写会话日志）、resume 恢复意图、运行中等待。
// 运行：node test/unit/test-member-model.mjs
import assert from "node:assert/strict";
import { findTargetAgent, switchAgentModel, foldLastModelSelection, memberStatusError, validateModelPair, applyModelOverride, getMemberModelOverride, __resetForTest } from "../../lib/index.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSessionText } from "../../lib/repair.js";
import { decodeAllFrames } from "../../lib/zstd-frames.js";

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };

// ---------- mock ----------
// agent mock：session.append 记录写入的事件（实现会写 model/selection 事件）
const agent = (id, title) => {
  const appended = [];
  return {
    session: { id, title, append: (type, data) => appended.push({ type, data }) },
    status: "idle",
    ctx: { on: () => () => {} },
    appended,
  };
};

function makeCtx({ agents = [], titles = {}, catalog = null, selectModel = null, teamMembers = null, persistenceArtifacts = null } = {}) {
  const calls = { selectModel: [] };
  let state = {}; // 插件 domain 状态（memberModelOverrides 等）
  return {
    calls,
    domainState: () => state,
    get(name) {
      if (name === "agents") {
        return {
          list: () => agents,
          get: (id) => agents.find((a) => a?.session?.id === id),
          roots: () => agents.slice(0, 1),
          currentInitiator: () => undefined,
        };
      }
      if (name === "agentTeams" && teamMembers) return { listMembers: () => teamMembers };
      if (name === "sessionTitle") return { get: (s) => (s?.id && titles[s.id] ? { title: titles[s.id] } : null) };
      if (name === "storageDomain") {
        return {
          open: async () => ({
            global: { get: () => state, set: async (next) => { state = next; } },
            close: async () => {},
          }),
        };
      }
      if (name === "sessionPersistence") return { listArtifacts: async () => persistenceArtifacts ?? [] };
      if (name === "sessionController") {
        const svc = {};
        if (catalog) svc.modelCatalog = async () => catalog;
        if (selectModel) svc.selectModel = async (req) => { calls.selectModel.push(req); return selectModel(req); };
        return svc;
      }
      return undefined;
    },
    logger: { info() {} },
  };
}

// ---------- findTargetAgent ----------
{
  const a1 = agent("sess-1", "前端重构");
  const a2 = agent("sess-2", "后端修 bug");
  const ctx = makeCtx({ agents: [a1, a2], titles: { "sess-1": "前端重构", "sess-2": "后端修 bug" } });

  const byId = findTargetAgent(ctx, "sess-2");
  assert.equal(byId.agent, a2, "sessionId 精确匹配");
  assert.equal(byId.matched, "sessionId");

  const byTitle = findTargetAgent(ctx, "前端");
  assert.equal(byTitle.agent, a1, "标题子串匹配");
  assert.equal(byTitle.matched, "标题");

  assert.ok(findTargetAgent(ctx, "不存在的成员").error, "无匹配返回 error");
  assert.ok(findTargetAgent(ctx, "").error, "空 target 返回 error");
  assert.ok(findTargetAgent(makeCtx({ agents: [] }), "x").error, "无活跃成员返回 error");
  ok("findTargetAgent：sessionId/标题/无匹配/空值/无成员");
}

// ---------- 多匹配拒绝 ----------
{
  const ctx = makeCtx({
    agents: [agent("s1", "同名前缀 A"), agent("s2", "同名前缀 B")],
    titles: { s1: "同名前缀 A", s2: "同名前缀 B" },
  });
  const res = findTargetAgent(ctx, "同名前缀");
  assert.ok(res.error && res.error.includes("2 个成员"), "多匹配报错并给出 sessionId 清单");
  assert.ok(res.error.includes("s1") && res.error.includes("s2"), "错误里列出候选 sessionId");
  ok("findTargetAgent：多匹配拒绝并提示用 sessionId");
}

// ---------- Team 名册定位（成员不在 agents.list()，但在 agentTeams 名册里） ----------
{
  // 复现实测场景：spawn_teammate 创建的队友只出现在 agentTeams 名册，
  // ctx.agents.list() 看不到它 —— 必须走名册（成员名 / 成员 id）定位。
  const teammate = agent("sess-teammate", "队友会话");
  const ctx = makeCtx({
    agents: [teammate],
    teamMembers: [
      { id: "sess-lead", name: "lead", role: "lead", status: "running", model: "global:deepseek-v4.1-flash" },
      { id: "sess-teammate", name: "model-test", role: "teammate", status: "running", model: "global:deepseek-v4.1-flash" },
    ],
  });
  const byName = findTargetAgent(ctx, "model-test");
  assert.equal(byName.agent, teammate, "按成员名从 Team 名册定位");
  assert.equal(byName.matched, "成员名");
  const byId = findTargetAgent(ctx, "sess-teammate");
  assert.equal(byId.agent, teammate, "按成员 sessionId 从名册定位");
  ok("findTargetAgent：Team 名册定位（成员名 / 成员 id）");
}

// ---------- switchAgentModel：selectModel + 事件（官方路径） ----------
{
  __resetForTest();
  const a = agent("sess-sel", "目标");
  const ctx = makeCtx({ agents: [a], titles: { "sess-sel": "目标" }, selectModel: () => ({ ok: true }) });
  const res = await switchAgentModel(ctx, a.session.id, "cn", "agnes-3.0-flash", a);
  assert.equal(res.error, undefined, "selectModel 路径无错误");
  assert.ok(res.via.includes("selectModel"), "走 selectModel");
  assert.equal(ctx.calls.selectModel.length, 1, "selectModel 被调用一次");
  assert.deepEqual(ctx.calls.selectModel[0], { sessionId: "sess-sel", provider: "cn", model: "agnes-3.0-flash" }, "参数含 sessionId+provider+model（官方签名）");
  assert.deepEqual(a.appended, [{ type: "model/selection", data: { provider: "cn", model: "agnes-3.0-flash" } }], "写入 model/selection 事件（官方同款持久化）");
  ok("switchAgentModel：官方 selectModel + model/selection 事件");
}

// ---------- switchAgentModel：无 selectModel → 写 model/selection 事件 ----------
{
  __resetForTest();
  const a = agent("sess-ref", "回退目标");
  const ctx = makeCtx({ agents: [a] });
  const res = await switchAgentModel(ctx, a.session.id, "cn", "agnes-2.5-flash", a);
  assert.equal(res.error, undefined, "ref 路径无错误");
  assert.ok(res.via.includes("model/selection"), "走 model/selection 事件路径");
  assert.equal(a.appended.length, 1, "写入了 model/selection 事件");
  assert.equal(a.appended[0].type, "model/selection");
  ok("switchAgentModel：无 selectModel 时写 model/selection 事件（官方投影接管）");
}

// ---------- switchAgentModel：selectModel 抛错 → 仍走官方同款机制 ----------
{
  __resetForTest();
  const a = agent("sess-err", "异常目标");
  const ctx = makeCtx({ agents: [a], selectModel: () => { throw new Error("remote unavailable"); } });
  const res = await switchAgentModel(ctx, a.session.id, "cn", "m1", a);
  assert.equal(res.error, undefined, "selectModel 抛错后仍成功");
  assert.ok(res.via.includes("model/selection"), "仍写 model/selection 事件");
  assert.equal(a.appended.length, 1, "事件仍被写入");
  ok("switchAgentModel：selectModel 抛错时仍走官方同款机制，不中断");
}

// ---------- switchAgentModel：缺 sessionId ----------
{
  __resetForTest();
  const ctx = makeCtx({});
  const res = await switchAgentModel(ctx, "", "cn", "m1");
  assert.ok(res.error, "缺 sessionId 返回 error");
  ok("switchAgentModel：缺 sessionId 返回明确错误");
}

// ---------- 未挂载（inactive）成员：直接写会话日志 model/selection 事件 ----------
{
  __resetForTest();
  const dir = mkdtempSync(join(tmpdir(), "member-model-"));
  const filePath = join(dir, "session.v4.jsonl.zstd");
  const header = JSON.stringify({ type: "session", version: 0, id: "sess-cold", createdAt: 1, cwd: "/tmp", delegationDepth: 0 });
  const ev = (t, d, s) => JSON.stringify({ type: t, seq: s, time: 1, data: d });
  const text = [header, ev("user/message", { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }, 0)].join("\n") + "\n";
  writeFileSync(filePath, await encodeSessionText(text));
  const lead = agent("sess-lead", "lead");
  const ctx = makeCtx({
    agents: [lead],
    teamMembers: [
      { id: "sess-lead", name: "lead", role: "lead", status: "running", model: "global:deepseek-v4.1-flash" },
      { id: "sess-cold", name: "cold-member", role: "teammate", status: "inactive", model: "global:deepseek-v4.1-flash" },
    ],
    persistenceArtifacts: [{ header: { id: "sess-cold" }, path: filePath }],
  });
  const found = findTargetAgent(ctx, "cold-member");
  assert.equal(found.sessionId, "sess-cold", "inactive 成员仍能从名册定位到 sessionId");
  assert.equal(found.agent, null, "inactive 成员没有 live agent");
  const res = await switchAgentModel(ctx, found.sessionId, "agnes", "agnes-3.0-flash", found.agent);
  assert.equal(res.error, undefined, "未挂载成员直接写日志成功");
  assert.ok(res.via.includes("已写入会话日志"), "返回说明已写日志");
  const after = await decodeAllFrames(readFileSync(filePath));
  const events = after.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const sel = events.filter((e) => e.type === "model/selection");
  assert.equal(sel.length, 1, "日志里新增 1 条 model/selection 事件");
  assert.deepEqual(sel[0].data, { provider: "agnes", model: "agnes-3.0-flash" }, "事件内容正确");
  assert.deepEqual(ctx.domainState().memberModelOverrides["sess-cold"], { provider: "agnes", model: "agnes-3.0-flash" }, "意图也已记录");
  rmSync(dir, { recursive: true, force: true });
  ok("未挂载（inactive）成员：直接写会话日志 model/selection 事件");
}

// ---------- foldLastModelSelection：resume 恢复切换意图（修「切了只生效一个回合」） ----------
{
  const events = [
    { type: "request/header", data: { header: { config: { provider: "wb", model: "global:deepseek-v4.1-flash" } } } },
    { type: "model/selection", data: { provider: "agnes", model: "agnes-2.5-flash" } },
    { type: "request/header", data: { header: { config: { provider: "agnes", model: "agnes-2.5-flash" } } } },
    { type: "model/selection", data: { provider: "agnes", model: "agnes-3.0-flash" } },
  ];
  assert.deepEqual(foldLastModelSelection(events), { provider: "agnes", model: "agnes-3.0-flash" }, "取最后一次 model/selection");
  assert.equal(foldLastModelSelection([]), null, "无事件返回 null");
  assert.equal(foldLastModelSelection([{ type: "request/header", data: {} }]), null, "无 selection 事件返回 null");
  ok("foldLastModelSelection：resume 恢复切换意图（防切了只生效一回合）");
}

// ---------- 状态门禁：provisioning / failed 拒绝 ----------
{
  const ctx = makeCtx({
    agents: [agent("sess-lead", "lead")],
    teamMembers: [
      { id: "sess-lead", name: "lead", role: "lead", status: "running" },
      { id: "sess-prov", name: "prov-member", role: "teammate", status: "provisioning" },
      { id: "sess-fail", name: "fail-member", role: "teammate", status: "failed" },
    ],
  });
  const r1 = findTargetAgent(ctx, "prov-member");
  assert.ok(r1.error && r1.error.includes("创建中"), "provisioning 成员拒绝切换");
  const r2 = findTargetAgent(ctx, "fail-member");
  assert.ok(r2.error && r2.error.includes("failed"), "failed 成员拒绝切换");
  ok("findTargetAgent：provisioning / failed 状态门禁");
}

// ---------- 组合校验：provider / model 不存在 ----------
{
  const ctx = makeCtx({ catalog: { groups: [{ id: "agnes", models: [{ id: "agnes-3.0-flash" }] }] } });
  const badProvider = await validateModelPair(ctx, "不存在", "m");
  assert.ok(badProvider.error && badProvider.error.includes("不存在"), "provider 不存在报错");
  const badModel = await validateModelPair(ctx, "agnes", "no-such-model");
  assert.ok(badModel.error && badModel.error.includes("没有模型"), "provider 下无该模型报错");
  const good = await validateModelPair(ctx, "agnes", "agnes-3.0-flash");
  assert.equal(good.error, undefined, "有效组合通过");
  const noCatalog = await validateModelPair(makeCtx({}), "any", "any");
  assert.equal(noCatalog.error, undefined, "catalog 不可用时跳过校验");
  ok("validateModelPair：provider/model 组合校验");
}

// ---------- 运行中：等它暂停后再切 ----------
{
  __resetForTest();
  const a = agent("sess-busy", "忙碌目标");
  a.status = "running"; // 模拟正在执行回合
  // whenIdle 模拟「回合结束进入空闲」：调用后把 status 置为 idle
  a.whenIdle = async () => { a.status = "idle"; };
  const ctx = makeCtx({ agents: [a], selectModel: () => ({ ok: true }) });
  const res = await switchAgentModel(ctx, a.session.id, "agnes", "agnes-3.0-flash", a);
  assert.equal(res.error, undefined, "等成员空闲后切换成功");
  assert.equal(ctx.calls.selectModel.length, 1, "空闲后才调用 selectModel");
  ok("switchAgentModel：运行中先等暂停（whenIdle）再切，不直接拒绝");
}

// ---------- agent/request 拦截（模式二）：按会话强制改写请求模型 ----------
{
  __resetForTest();
  const base = { provider: "wb", model: "global:deepseek-v4.1-flash", reasoningEffort: "high", maxTokens: 100 };
  const overridden = applyModelOverride(base, { provider: "agnes", model: "agnes-3.0-flash" });
  assert.equal(overridden.provider, "agnes", "provider 被改写");
  assert.equal(overridden.model, "agnes-3.0-flash", "model 被改写");
  assert.equal(overridden.reasoningEffort, undefined, "继承的 reasoningEffort 被清掉");
  assert.equal(overridden.maxTokens, 100, "其它字段保留");
  assert.equal(applyModelOverride(base, null), base, "无 override 时原样返回");
  const same = applyModelOverride(base, { provider: "wb", model: "global:deepseek-v4.1-flash" });
  assert.equal(same, base, "已是目标模型时原样返回（引用相等）");
  ok("applyModelOverride：改写 provider/model 并清继承 effort");
}

// ---------- override 读取：domain 持久 + 内存镜像 ----------
{
  __resetForTest();
  const ctx = makeCtx({});
  assert.equal(await getMemberModelOverride(ctx, "sess-x"), null, "无 override 返回 null");
  const a = agent("sess-y", "目标");
  const ctx2 = makeCtx({ agents: [a], selectModel: () => ({ ok: true }) });
  await switchAgentModel(ctx2, "sess-y", "agnes", "agnes-3.0-flash", a);
  const got = await getMemberModelOverride(ctx2, "sess-y");
  assert.deepEqual(got, { provider: "agnes", model: "agnes-3.0-flash" }, "写入后可读到 override");
  ok("getMemberModelOverride：domain 持久 + 内存镜像");
}

console.log(`TEST PASS: ${pass}`);
