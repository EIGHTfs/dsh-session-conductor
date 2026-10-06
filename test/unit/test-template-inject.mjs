/**
 * dsh-session-conductor — 会话模板注入单测
 *
 * 覆盖：
 *   1. TEMPLATE_DEFAULTS / TEMPLATE_SLOTS
 *   2. saveTemplate：本地 md 落盘 / 空内容 / 超限 / 非法槽位
 *   3. saveTemplateFromUrl：非法 URL / 下载失败 / 正常转存
 *   4. saveTemplateFromPath：目录内选用 / 越权拦截 / 非 md 拦截
 *   5. listTemplateDir：目录浏览 / 越权拦截
 *   6. collectTemplatesTextSync：开关控制 / 内容拼接 / 双花括号清洗
 * 运行：node test-template-inject.mjs
 */

import assert from "node:assert";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TEMPLATE_SLOTS,
  TEMPLATE_DEFAULTS,
  TEMPLATE_MAX_BYTES,
  saveTemplate,
  saveTemplateFromUrl,
  saveTemplateFromPath,
  listTemplateDir,
  removeTemplate,
  collectTemplatesTextSync,
  PLAN_ENFORCE_CONFIRM_RE,
  PLAN_ENFORCE_BASH_WRITE_RE,
  PLAN_ENFORCE_EDIT_TOOLS,
  planGateAllows,
  planEnforceDenyMessage,
} from "../../lib/template-inject.js";

let passed = 0;
const fails = [];

async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { fails.push({ name, error: e }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = await fs.mkdtemp(join(tmpdir(), "tpl-test-"));
const PLAN = "# 方案模板\n\n## 一、修改目标\n（描述）";
const CLOSING = "══════════\n✅ 任务完成\n交付：X\n验证：Y\n遗留：Z\n══════════";

console.log('\n[1] 常量');
await ok('两个槽位 plan/closing', () => {
  assert.deepStrictEqual(TEMPLATE_SLOTS, ["plan", "closing"]);
});
await ok('默认模板全关闭', () => {
  assert.strictEqual(TEMPLATE_DEFAULTS.plan.enabled, false);
  assert.strictEqual(TEMPLATE_DEFAULTS.closing.enabled, false);
});

console.log('\n[2] saveTemplate（本地 md 落盘）');
await ok('正常保存 → ok + 落盘', async () => {
  const r = await saveTemplate(ROOT, "plan", { name: "方案.md", content: PLAN });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.slot, "plan");
  const disk = await fs.readFile(join(ROOT, "template-inject-md", "plan.md"), "utf8");
  assert.strictEqual(disk, PLAN);
});
await ok('非法槽位 → bad-slot', async () => {
  const r = await saveTemplate(ROOT, "other", { name: "x.md", content: "x" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, "bad-slot");
});
await ok('空内容 → empty', async () => {
  const r = await saveTemplate(ROOT, "closing", { name: "x.md", content: "" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, "empty");
});

console.log('\n[3] saveTemplateFromUrl（在线 md）');
await ok('非法 URL → bad-url', async () => {
  const r = await saveTemplateFromUrl(ROOT, "closing", "not-a-url");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, "bad-url");
});

console.log('\n[4] saveTemplateFromPath（目录内选用）');
await ok('正常选用目录内 md', async () => {
  const f = join(ROOT, "docs", "计划.md");
  await fs.mkdir(join(ROOT, "docs"), { recursive: true });
  await fs.writeFile(f, PLAN);
  const r = await saveTemplateFromPath(ROOT, "plan", f);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, "计划.md");
  const disk = await fs.readFile(join(ROOT, "template-inject-md", "plan.md"), "utf8");
  assert.strictEqual(disk, PLAN);
});
await ok('越权路径（root 外）→ outside-root', async () => {
  const outside = join(tmpdir(), "tpl-outside-test.md");
  await fs.writeFile(outside, "x");
  const r = await saveTemplateFromPath(ROOT, "plan", outside);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, "outside-root");
  await fs.unlink(outside).catch(() => {});
});
await ok('非 md 文件 → not-md', async () => {
  const f = join(ROOT, "a.txt");
  await fs.writeFile(f, "hello");
  const r = await saveTemplateFromPath(ROOT, "plan", f);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, "not-md");
});

console.log('\n[5] listTemplateDir（目录浏览）');
await ok('列根目录 → 目录/文件/是否 md 标记', async () => {
  const r = await listTemplateDir(ROOT, ROOT);
  assert.strictEqual(r.ok, true);
  assert.ok(r.entries.some((e) => e.name === "docs" && e.isDir));
  assert.ok(r.entries.some((e) => e.name === "a.txt" && !e.isDir && !e.isMd));
  assert.strictEqual(r.parent, null, "根目录无上级");
});
await ok('子目录 → 有上级', async () => {
  const r = await listTemplateDir(ROOT, join(ROOT, "docs"));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.parent, ROOT);
});
await ok('空 path → 主目录根（不误读 cwd）', async () => {
  const r = await listTemplateDir(ROOT, "");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.path, ROOT);
  assert.strictEqual(r.parent, null);
});
await ok('越权目录 → outside-root', async () => {
  const r = await listTemplateDir(ROOT, tmpdir());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, "outside-root");
});

console.log('\n[6] collectTemplatesTextSync（拼接注入）');
await ok('全部关闭 → 空串', () => {
  assert.strictEqual(collectTemplatesTextSync(ROOT, TEMPLATE_DEFAULTS), "");
});
await ok('plan 开启 → 注入方案模板', () => {
  const meta = { plan: { ...TEMPLATE_DEFAULTS.plan, enabled: true, name: "方案.md" }, closing: TEMPLATE_DEFAULTS.closing };
  const t = collectTemplatesTextSync(ROOT, meta);
  assert.ok(t.includes("方案模板"));
  assert.ok(t.includes(PLAN));
  assert.ok(!t.includes("收尾模板"));
});
await ok('closing 开启 → 注入收尾模板', async () => {
  await saveTemplate(ROOT, "closing", { name: "收尾.md", content: CLOSING });
  const meta = { plan: TEMPLATE_DEFAULTS.plan, closing: { ...TEMPLATE_DEFAULTS.closing, enabled: true, name: "收尾.md" } };
  const t = collectTemplatesTextSync(ROOT, meta);
  assert.ok(t.includes("收尾模板"));
  assert.ok(t.includes(CLOSING));
});
await ok('双花括号清洗为单花括号', async () => {
  await saveTemplate(ROOT, "closing", { name: "变量.md", content: "内容含 {{变量}} 双花括号" });
  const meta = { plan: TEMPLATE_DEFAULTS.plan, closing: { ...TEMPLATE_DEFAULTS.closing, enabled: true, name: "变量.md" } };
  const t = collectTemplatesTextSync(ROOT, meta);
  assert.ok(!t.includes("{{"), "不应残留 {{");
  assert.ok(t.includes("{变量}"), "应有单花括号");
});
await ok('removeTemplate 清空 → 不再注入', async () => {
  await removeTemplate(ROOT, "closing");
  const meta = { plan: TEMPLATE_DEFAULTS.plan, closing: { ...TEMPLATE_DEFAULTS.closing, enabled: true, name: "收尾.md" } };
  const t = collectTemplatesTextSync(ROOT, meta);
  assert.ok(!t.includes(CLOSING));
});

// ──  方案模板强制门禁：enforce 字段 / 注入说明 / 判定常量 / 无状态门判定 ──

ok("v1.35 defaults 含 enforce:false（plan/closing）", () => {
  assert.strictEqual(TEMPLATE_DEFAULTS.plan.enforce, false);
  assert.strictEqual(TEMPLATE_DEFAULTS.closing.enforce, false);
});

ok("v1.35 开启 enforce → 注入文本声明强制门禁口径", async () => {
  await saveTemplate(ROOT, "plan", { name: "方案.md", content: PLAN });
  const meta = { plan: { ...TEMPLATE_DEFAULTS.plan, enabled: true, enforce: true, name: "方案.md", bytes: 1 }, closing: TEMPLATE_DEFAULTS.closing };
  const t = collectTemplatesTextSync(ROOT, meta);
  assert.ok(t.includes("强制门禁"));
  assert.ok(t.includes("会被 harness 直接拒绝"));
});

ok("v1.35 enforce 关闭 → 注入文本不含强制声明", async () => {
  const meta = { plan: { ...TEMPLATE_DEFAULTS.plan, enabled: true, enforce: false, name: "方案.md", bytes: 1 }, closing: TEMPLATE_DEFAULTS.closing };
  const t = collectTemplatesTextSync(ROOT, meta);
  assert.ok(!t.includes("强制门禁"));
});

ok("v1.35 bash 写操作启发式：只拦写、放只读", () => {
  const cases = [
    ["echo hi > a.txt", true], ["node test.mjs", false], ["cat a.txt", false],
    ["grep \"a>b\" f", false], ["grep -r pattern >> log", true], ["git commit -m x", true],
    ["sed -i s/a/b/ f", true], ["ls && rm x", true], ["npm test", false], ["mkdir -p d", true],
  ];
  for (const [cmd, want] of cases) assert.strictEqual(PLAN_ENFORCE_BASH_WRITE_RE.test(cmd), want, cmd);
});

ok("v1.35 确认词：整条确认走严格式，长句走宽松式", () => {
  assert.ok(PLAN_ENFORCE_CONFIRM_RE.test("确认"));
  assert.ok(PLAN_ENFORCE_CONFIRM_RE.test("OK"));
  assert.ok(!PLAN_ENFORCE_CONFIRM_RE.test("确认，但先看看"));
  assert.ok(PLAN_ENFORCE_EDIT_TOOLS.length >= 3);
  assert.ok(planEnforceDenyMessage("edit").includes("方案模板强制门禁"));
});

// 门判定：无状态，从会话事件流现场推导（提案 + 确认 双条件）
const gUser = (text) => ({ type: "user/message", data: { content: [{ type: "text", text }] } });
const gAsst = (text) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });
const gPlan = (extra = "") => "# 修改方案提案\n\n## 一、修改目标\n（目标）\n\n## 八、是否执行？\n\n请回复「确认」\n" + extra;

ok("v1.35 门：直接请求未出提案 → 拦", () => {
  assert.strictEqual(planGateAllows([gUser("帮我把 client.js 改成强制")]), false);
});

ok("v1.35 门：出提案未确认 → 拦", () => {
  assert.strictEqual(planGateAllows([gUser("改成强制"), gAsst(gPlan())]), false);
});

ok("v1.35 门：提案 + 确认 → 放", () => {
  assert.strictEqual(planGateAllows([gUser("改成强制"), gAsst(gPlan()), gUser("确认")]), true);
});

ok("v1.35 门：确认但无提案 → 拦", () => {
  assert.strictEqual(planGateAllows([gUser("确认")]), false);
});

ok("v1.35 门：已确认后新请求 → 重新提案（拦）", () => {
  assert.strictEqual(planGateAllows([gUser("改成强制"), gAsst(gPlan()), gUser("确认"), gAsst("已生效"), gUser("再改一版")]), false);
});

ok("v1.35 门：确认后回复「继续」→ 拦（严格口径）", () => {
  assert.strictEqual(planGateAllows([gUser("改成强制"), gAsst(gPlan()), gUser("确认"), gAsst("done"), gUser("继续")]), false);
});

ok("v1.35 门：系统注入消息不干扰判定", () => {
  assert.strictEqual(planGateAllows([gUser("Current runtime context..."), gUser("改成强制"), gAsst(gPlan()), gUser("确认")]), true);
});

ok("v1.35 门：弱确认词（好的/可以）不算确认", () => {
  assert.strictEqual(planGateAllows([gUser("改成强制"), gAsst(gPlan()), gUser("好的")]), false);
});

ok("v1.35 门：确认带尾句仍算确认（宽松式）", () => {
  assert.strictEqual(planGateAllows([gUser("改成强制"), gAsst(gPlan()), gUser("确认，但注意别改 README")]), true);
});

ok("v1.35 门：提案缺确认段标记 → 不算提案", () => {
  assert.strictEqual(planGateAllows([gUser("改成强制"), gAsst("# 修改方案提案\n\n仅目标说明"), gUser("确认")]), false);
});

ok("v1.35 门：空事件 / 单条用户消息 → 拦", () => {
  assert.strictEqual(planGateAllows([]), false);
  assert.strictEqual(planGateAllows([gUser("确认")]), false);
});

await new Promise((r) => setTimeout(r, 50)); // 给剩余微任务一个让路
console.log(`\n结果: ${passed} 通过, ${fails.length} 失败`);
if (fails.length) {
  fails.forEach((f) => console.log(`  FAIL: ${f.name}\n    ${f.error?.stack || f.error}`));
  process.exit(1);
}
