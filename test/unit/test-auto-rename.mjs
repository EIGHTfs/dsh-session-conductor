// dsh-session-conductor 自动重命名分析逻辑的单测（mock LLM 流）。
// 运行：node test-auto-rename.mjs（需要 workspace/node_modules 软链到 app node_modules，
//       或在能解析 @deepseek-ai/* 的目录下运行）
import assert from "node:assert/strict";
import { parseDriftJson, driftAnalysisLlm, stateSuffixOf, stripTitleStateSuffix, resolveRoute, resolveModelOverride, __setConfigForTest, __resetForTest } from "../../lib/index.js";

// ---------- stateSuffixOf / stripTitleStateSuffix ----------
const ev = (type, data, seq) => ({ type, seq, time: 1, data });
assert.equal(stateSuffixOf([ev("turn/start", { turn: 1 }, 1)]), "（运行中）", "open turn → 运行中");
assert.equal(
  stateSuffixOf([ev("turn/start", { turn: 1 }, 1), ev("turn/end", { turn: 1, reason: { kind: "interrupted" } }, 2)]),
  "（已中断）",
  "interrupted → 已中断"
);
assert.equal(
  stateSuffixOf([ev("turn/start", { turn: 1 }, 1), ev("turn/end", { turn: 1, reason: { kind: "error", error: { code: "TIMEOUT" } } }, 2)]),
  "（已中断）",
  "error → 已中断"
);
assert.equal(
  stateSuffixOf([ev("turn/start", { turn: 1 }, 1), ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 2)]),
  "",
  "completed → 无后缀"
);
assert.equal(
  stateSuffixOf([ev("turn/start", { turn: 1 }, 1), ev("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }, 2)]),
  "",
  "用户取消 → 无后缀"
);
assert.equal(stripTitleStateSuffix("修复登录 bug（运行中）"), "修复登录 bug", "去运行中后缀");
assert.equal(stripTitleStateSuffix("修复登录 bug（已中断）"), "修复登录 bug", "去已中断后缀");
assert.equal(stripTitleStateSuffix("普通标题"), "普通标题", "无后缀原样");
console.log("stateSuffixOf/stripTitleStateSuffix: 8 项断言通过");

// ---------- parseDriftJson ----------
assert.equal(parseDriftJson(""), null, "空串 → null");
assert.equal(parseDriftJson("随便说点什么"), null, "非 JSON → null");
assert.deepEqual(parseDriftJson('{"changed": false}'), { changed: false }, "changed:false");
assert.deepEqual(parseDriftJson('{"changed": true, "title": "测试新标题"}'), { changed: true, title: "测试新标题" }, "changed:true 带标题");
assert.deepEqual(parseDriftJson('```json\n{"changed": true, "title": "围栏标题"}\n```'), { changed: true, title: "围栏标题" }, "容忍代码块围栏");
assert.equal(parseDriftJson('{"changed": "yes"}'), null, "changed 非布尔 → null");
assert.deepEqual(parseDriftJson('{"changed": true, "title": 42}'), { changed: true }, "title 非字符串 → 忽略 title");
console.log("parseDriftJson: 7 项断言通过");

// ---------- driftAnalysisLlm（mock LLM 流） ----------
function fakeLlm(chunks) {
  return {
    async *stream() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function textChunks(fullText) {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: fullText.slice(0, Math.ceil(fullText.length / 2)) },
    { type: "text-delta", index: 0, text: fullText.slice(Math.ceil(fullText.length / 2)) },
    { type: "block-end", index: 0, block: { type: "text", text: fullText } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

const session = { id: "session-test" };
const route = { provider: "fake-provider", model: "fake-model" };
const recent = [{ seq: 1, text: "帮我修一个 bug" }, { seq: 2, text: "问题依旧" }];
const errors = [];
const onError = (message) => errors.push(message);

// 1) changed: true
{
  const llm = fakeLlm(textChunks('{"changed": true, "title": "修复登录 bug"}'));
  const result = await driftAnalysisLlm(llm, session, route, "旧标题", recent, onError);
  assert.deepEqual(result, { kind: "changed", title: "修复登录 bug" }, "changed → {kind:changed}");
}

// 2) changed: false
{
  const llm = fakeLlm(textChunks('{"changed": false}'));
  const result = await driftAnalysisLlm(llm, session, route, "旧标题", recent, onError);
  assert.deepEqual(result, { kind: "unchanged" }, "changed:false → unchanged");
}

// 3) LLM 抛错 → {kind:error} 且 onError 收到日志
{
  const llm = {
    async *stream() {
      throw new Error("provider down");
    },
  };
  const result = await driftAnalysisLlm(llm, session, route, "旧标题", recent, onError);
  assert.equal(result.kind, "error", "LLM 异常 → error");
  assert.match(result.message, /provider down/, "错误信息透传");
  assert.equal(errors.length, 1, "onError 收到一次");
}

// 4) 无 text 块（LLM 没输出）→ error（不再静默当 unchanged，暴露模型异常）
{
  const llm = fakeLlm([
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: "call-0", name: "f", argumentsDelta: "{}" },
    { type: "block-end", index: 0, block: { type: "tool-call", id: "call-0", name: "f", arguments: "{}" } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const result = await driftAnalysisLlm(llm, session, route, "旧标题", recent, onError);
  assert.equal(result.kind, "error", "无文本块 → error（模型输出异常）");
  assert.match(result.message, /无法解析/, "错误信息说明输出异常");
}

// 5) 输出 changed:true 但空标题 → unchanged
{
  const llm = fakeLlm(textChunks('{"changed": true, "title": "  "}'));
  const result = await driftAnalysisLlm(llm, session, route, "旧标题", recent, onError);
  assert.deepEqual(result, { kind: "unchanged" }, "空标题 → unchanged");
}

// 6) LLM 输出非 JSON 文本 → error（不再静默当 unchanged）
{
  const llm = fakeLlm(textChunks("随便说点什么"));
  const result = await driftAnalysisLlm(llm, session, route, "旧标题", recent, onError);
  assert.equal(result.kind, "error", "非 JSON 输出 → error");
}

// 7) forceTitle（fallback 截断标题）：{title} 输出 → changed
{
  const llm = fakeLlm(textChunks('{"title": "搜索功能调研"}'));
  const result = await driftAnalysisLlm(llm, session, route, "每个新会话开始，都会自动重", recent, onError, true);
  assert.deepEqual(result, { kind: "changed", title: "搜索功能调研" }, "forceTitle：直接生成标题替换截断标题");
}

// 8) forceTitle：LLM 无有效 title → error
{
  const llm = fakeLlm(textChunks('{"title": "  "}'));
  const result = await driftAnalysisLlm(llm, session, route, "截断标题", recent, onError, true);
  assert.equal(result.kind, "error", "forceTitle：空 title → error");
  const llm2 = fakeLlm(textChunks("没有 JSON"));
  const result2 = await driftAnalysisLlm(llm2, session, route, "截断标题", recent, onError, true);
  assert.equal(result2.kind, "error", "forceTitle：非 JSON → error");
}

console.log("driftAnalysisLlm: 9 项断言通过");

// ---------- resolveRoute：模型路由选择（配置优先 / 继承 / 只配一个忽略） ----------
__resetForTest();
__setConfigForTest({});
{
  const withHeader = { requestHeader: () => ({ config: { provider: "p-session", model: "m-session" } }) };
  const noHeader = { requestHeader: () => undefined };
  assert.deepEqual(resolveRoute(withHeader, null), { provider: "p-session", model: "m-session" }, "缺省：继承会话 request/header 路由");
  assert.equal(resolveRoute(noHeader, null), null, "无 request/header → null");

  __setConfigForTest({ autoRenameProvider: "p-cfg", autoRenameModel: "m-cfg" });
  assert.deepEqual(resolveRoute(withHeader, null), { provider: "p-cfg", model: "m-cfg" }, "配置成对 → 优先于会话路由");

  __setConfigForTest({ autoRenameProvider: "p-only" }); // 只配一个 → 忽略，退回继承
  assert.deepEqual(resolveRoute(withHeader, null), { provider: "p-session", model: "m-session" }, "只配一个 → 忽略退回继承");

  __setConfigForTest({ autoRenameProvider: "", autoRenameModel: "" }); // 空串等价未配
  assert.deepEqual(resolveRoute(withHeader, null), { provider: "p-session", model: "m-session" }, "空串 → 视为未配置");
}
console.log("resolveRoute: 5 项断言通过");

// ---------- resolveRoute 三级优先级：UI 选择（state.autoRenameModel）> patch 配置 > 会话路由 ----------
__resetForTest();
{
  __setConfigForTest({ autoRenameProvider: "p-cfg", autoRenameModel: "m-cfg" });
  const withHeader = { requestHeader: () => ({ config: { provider: "p-session", model: "m-session" } }) };
  assert.deepEqual(
    resolveRoute(withHeader, null, { autoRenameModel: { provider: "p-ui", model: "m-ui" } }),
    { provider: "p-ui", model: "m-ui" },
    "① UI 选择优先于 patch 配置与会话路由"
  );
  assert.deepEqual(
    resolveRoute(withHeader, null, { autoRenameModel: null }),
    { provider: "p-cfg", model: "m-cfg" },
    "② 无 UI 选择 → patch 配置"
  );
  assert.deepEqual(
    resolveRoute(withHeader, null, {}),
    { provider: "p-cfg", model: "m-cfg" },
    "③ 空 state → patch 配置"
  );
  __setConfigForTest({});
  assert.deepEqual(
    resolveRoute(withHeader, null, { autoRenameModel: { provider: "p-ui", model: "m-ui" } }),
    { provider: "p-ui", model: "m-ui" },
    "④ 无 patch 配置时 UI 选择仍优先"
  );
  assert.deepEqual(
    resolveRoute(withHeader, null, { autoRenameModel: null }),
    { provider: "p-session", model: "m-session" },
    "⑤ 无 UI 无 patch → 会话路由"
  );
}
console.log("resolveRoute 三级优先级: 5 项断言通过");

// ---------- resolveModelOverride：单次模型覆盖（provider/model | 纯模型名匹配 catalog | fallback） ----------
{
  // mock catalog：agnes 组含 agnes3.0flash；deepseek 组含 deepseek-v4-flash
  const ctxWithCatalog = {
    get: (key) => key === "sessionController" ? {
      modelCatalog: async () => ({
        default: { provider: "llm-pi-ai", model: "agnes3.0flash" },
        routableProviders: ["llm-pi-ai", "deepseek-official"],
        groups: [
          { id: "llm-pi-ai", name: "Pi AI", models: [{ id: "agnes3.0flash", name: "Agnes 3.0 Flash" }] },
          { id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }] },
        ],
        failures: [],
      }),
    } : undefined,
  };
  const noCatalogCtx = { get: () => undefined };

  assert.deepEqual(
    await resolveModelOverride(ctxWithCatalog, "agnes3.0flash", { provider: "deepseek-official", model: "deepseek-v4-flash" }),
    { provider: "llm-pi-ai", model: "agnes3.0flash" },
    "纯模型名 → catalog 匹配出 provider"
  );
  assert.deepEqual(
    await resolveModelOverride(ctxWithCatalog, "deepseek-official/deepseek-v4-flash", null),
    { provider: "deepseek-official", model: "deepseek-v4-flash" },
    "provider/model 显式拆分"
  );
  assert.deepEqual(
    await resolveModelOverride(noCatalogCtx, "unknown-model", { provider: "deepseek-official", model: "deepseek-v4-flash" }),
    { provider: "deepseek-official", model: "unknown-model" },
    "catalog 无匹配 → 借用 fallback provider"
  );
  assert.equal(await resolveModelOverride(ctxWithCatalog, "", { provider: "p", model: "m" }), null, "空参数 → null");
  assert.deepEqual(
    await resolveModelOverride(ctxWithCatalog, "/only-model", { provider: "p", model: "m" }),
    { provider: "p", model: "/only-model" },
    "无 provider 的斜杠串 → 走纯模型名路径借用 fallback provider"
  );
}
console.log("resolveModelOverride: 5 项断言通过");

// ---------- driftAnalysisLlm 用传入 route 调 LLM（provider/model 落到请求上） ----------
{
  let captured = null;
  const llm = {
    async *stream(options) {
      captured = options;
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  await driftAnalysisLlm(llm, session, { provider: "p-cfg", model: "m-cfg" }, "旧标题", recent, onError);
  assert.equal(captured.provider, "p-cfg", "LLM 请求 provider 用传入 route");
  assert.equal(captured.model, "m-cfg", "LLM 请求 model 用传入 route");
  assert.equal(captured.purpose, "session-conductor-auto-rename", "purpose 标记不变");
}
console.log("driftAnalysisLlm route 透传: 3 项断言通过");

console.log("ALL PASS");
