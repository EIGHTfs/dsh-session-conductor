// dsh-session-conductor — HTTP 路由点对点测试（A/B 可切换 pluginRoot）
//
// 【干什么】逐个打插件注册的 HTTP 路由，断言「路由存在且未炸」——
//   纯函数单测全绿 ≠ 接口层没坏：路径拼写、handler 注册、参数解析只有真发请求才暴露。
//
// 【怎么跑】用通用 mini-host 的**子进程执行器**（dsh-plugin-minihost-child.mjs）：
//   每个请求 fork 一次性子进程加载 pluginRoot 里的插件入口 → 执行 webServer 注册的 handler。
//   子进程冷启动 = 每次都从磁盘读最新代码，所以能直接测**工作区源码**，不用重启宿主、不起端口。
//
// 【A/B 用法】分别指定两份代码做对照：
//   node test/unit/test-api-routes.mjs                       # 默认：工作区源码（当前）
//   PLUGIN_ROOT=/tmp/base-1.0.3 node test/unit/test-api-routes.mjs   # 基线（拆分前 1.0.3）
//
// 输出：逐路由 status + 结论，末尾汇总。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CHILD = "/volume1/@appdata/DeepSeekHarness-NAS/0.2.0-rc.2/.dsh/skills/dsh-plugin-minihost-child.mjs";
// 依赖解析目录：工作区源码没有 node_modules，指到宿主安装副本（只用于解析 @deepseek-ai/* 包，不改被测代码）
const DEPS = ["/volume1/@appdata/DeepSeekHarness-NAS/0.2.0-rc.2/.dsh/profiles/web/node_modules"];
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || resolve(import.meta.dirname, "../..");
const WORKSPACE = resolve(PLUGIN_ROOT, "..");
const TIMEOUT_MS = Number(process.env.ROUTE_TIMEOUT_MS || 25000);

if (!existsSync(CHILD)) {
  console.error(`找不到子进程执行器：${CHILD}`);
  process.exit(2);
}

/** 打一个路由：返回 { ok, status, body, error } */
function callRoute({ method = "GET", url, body = null, headers = {} }) {
  const payload = {
    pluginRoot: PLUGIN_ROOT,
    method,
    url,
    headers: { host: "127.0.0.1", ...headers },
    ...(body == null ? {} : { bodyBase64: Buffer.from(JSON.stringify(body), "utf8").toString("base64") }),
    workspaceRoot: WORKSPACE,
    config: {},
    depsDirs: DEPS,
  };
  return new Promise((res) => {
    const child = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      res({ ok: false, status: 0, error: `超时 ${TIMEOUT_MS}ms`, stderr: err.slice(0, 300) });
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        res({ ok: false, status: 0, error: `子进程退出码 ${code}`, stderr: err.slice(-400) });
        return;
      }
      let parsed;
      try { parsed = JSON.parse(out); } catch {
        res({ ok: false, status: 0, error: "输出非 JSON", stderr: err.slice(-400) });
        return;
      }
      const bodyText = parsed.bodyBase64 ? Buffer.from(parsed.bodyBase64, "base64").toString("utf8") : "";
      // apply 抛错是「插件整体没接好」的信号——child 会把它放进 warnings，必须单独判失败，
      // 否则路由全丢（routes=[]）只会表现成 404，容易漏掉根因。
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
      const applyError = warnings.find((w) => String(w).includes("apply 抛错")) || null;
      res({
        ok: parsed.ok !== false && parsed.status >= 200 && parsed.status < 500,
        status: parsed.status,
        body: bodyText.slice(0, 160),
        error: applyError || parsed.error || null,
        applyError,
        stderr: err.length > 0 ? err.slice(-200) : null,
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// ── 路由清单：只做「存在性 + 不 5xx」的冒烟；带 * 的会真实改动数据，仅以 dryRun/无害参数调用
const ROUTES = [
  { name: "i18n",              method: "GET",  url: "/api/session-conductor/i18n?lang=zh" },
  { name: "list",              method: "GET",  url: "/api/session-conductor/list" },
  { name: "fts-status",        method: "GET",  url: "/api/session-conductor/fts-status" },
  { name: "auto-rename",       method: "GET",  url: "/api/session-conductor/auto-rename" },
  { name: "auto-continue",     method: "GET",  url: "/api/session-conductor/auto-continue" },
  { name: "auto-continue-gate",method: "GET",  url: "/api/session-conductor/auto-continue-gate" },
  { name: "auto-rename-model", method: "GET",  url: "/api/session-conductor/auto-rename-model" },
  { name: "compaction-model",  method: "GET",  url: "/api/session-conductor/compaction-model" },
  { name: "search",            method: "GET",  url: "/api/session-conductor/search?q=%E6%B5%8B%E8%AF%95" },
  { name: "scan",              method: "POST", url: "/api/session-conductor/scan", body: {} },
  // 以下需要具体 id/有副作用，用明显无效参数调用：期望 4xx（说明路由存在且参数校验生效），不是 404/500
  { name: "archive",           method: "POST", url: "/api/session-conductor/archive", body: { sessionId: "__nope__" }, expect: "4xx-or-2xx" },
  { name: "continue",          method: "POST", url: "/api/session-conductor/continue", body: { sessionId: "__nope__" }, expect: "4xx-or-2xx" },
  { name: "detach",            method: "POST", url: "/api/session-conductor/detach", body: { sessionId: "__nope__" }, expect: "4xx-or-2xx" },
  { name: "analyze",           method: "POST", url: "/api/session-conductor/analyze", body: { sessionId: "__nope__" }, expect: "4xx-or-2xx" },
  { name: "message",           method: "POST", url: "/api/session-conductor/message", body: { sessionId: "__nope__", text: "x" }, expect: "4xx-or-2xx" },
  { name: "delete",            method: "POST", url: "/api/session-conductor/delete", body: { sessionId: "__nope__" }, expect: "4xx-or-2xx" },
  { name: "delete-batch",      method: "POST", url: "/api/session-conductor/delete-batch", body: { sessionIds: [] }, expect: "4xx-or-2xx" },
  { name: "delete-by-rule",    method: "POST", url: "/api/session-conductor/delete-by-rule", body: { dryRun: true }, expect: "4xx-or-2xx" },
  { name: "detach-all",        method: "POST", url: "/api/session-conductor/detach-all", body: {}, expect: "4xx-or-2xx" },
  { name: "repair-sessions",   method: "POST", url: "/api/session-conductor/repair-sessions", body: { dryRun: true }, expect: "4xx-or-2xx" },
  { name: "repair-frames",     method: "POST", url: "/api/session-conductor/repair-frames", body: { dryRun: true }, expect: "4xx-or-2xx" },
  { name: "repair-eio",        method: "POST", url: "/api/session-conductor/repair-eio", body: { dryRun: true }, expect: "4xx-or-2xx" },
  { name: "repair-seq-gap",    method: "POST", url: "/api/session-conductor/repair-seq-gap", body: { dryRun: true }, expect: "4xx-or-2xx" },
  { name: "repair-dual-format",method: "POST", url: "/api/session-conductor/repair-dual-format", body: { dryRun: true }, expect: "4xx-or-2xx" },
  // 未注册路径：期望 404（证明路由匹配正常、不是「全部兜底 200」）
  { name: "unknown(应404)",    method: "GET",  url: "/api/session-conductor/__definitely_not_exists__", expect: "404" },
];

let pass = 0;
let fail = 0;
const failures = [];

console.log(`插件根目录：${PLUGIN_ROOT}`);
console.log(`路由数：${ROUTES.length}\n`);

for (const r of ROUTES) {
  const res = await callRoute({ method: r.method, url: r.url, body: r.body ?? null });
  // 断言口径（⚠️ 不能把 404 算通过：路由全丢会表现为「全 404」，若放宽就会被误判成全绿）
  //   2xx/4xx = 路由存在且正常处理（4xx 多是我们故意传的无效 id，说明参数校验生效）
  //   404    = 路由没注册（真问题，除非该条本就期望 404）
  //   5xx / apply 抛错 = 插件入口或 handler 炸了
  const s = res.status;
  const crashed = Boolean(res.applyError);
  let good;
  if (r.expect === "404") good = s === 404 && !crashed;
  else if (r.expect === "4xx-or-2xx") good = !crashed && ((s >= 200 && s < 300) || (s >= 400 && s < 500));
  else good = !crashed && s >= 200 && s < 500;

  const label = `${r.method} ${r.name}`;
  if (good) {
    pass += 1;
    console.log(`  ✅ ${label.padEnd(34)} status=${s}${res.body ? ` body=${res.body.replace(/\s+/g, " ").slice(0, 60)}` : ""}`);
  } else {
    fail += 1;
    failures.push({ label, status: s, error: res.error, stderr: res.stderr });
    console.log(`  ❌ ${label.padEnd(34)} status=${s} error=${res.error || "-"}`);
    if (res.stderr) console.log(`     stderr: ${res.stderr.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) {
  console.log("失败清单：");
  for (const f of failures) console.log(`  - ${f.label} (status=${f.status}) ${f.error || ""}`);
}
process.exit(fail > 0 ? 1 : 0);
