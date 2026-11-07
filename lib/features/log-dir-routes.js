// 打开日志目录：把「这个会话的原始日志到底在哪」一秒钟摆到用户面前。
//
// 【为什么需要它】插件自己修损坏、算价值、做撤销，全都要读那些 .jsonl.zstd 日志。
// 用户遇到「这条会话为什么显示异常」时，最想要的是**亲手打开那个文件夹**看一眼（甚至备份一份）。
// 没有这个按钮，用户只能自己顺着 DSH_HOME 猜目录名。
//
// 【安全边界】路径来自「按 sessionId 定位到的日志文件」而不是客户端传的路径：
//   ① 客户端只能传 sessionId，不能传目录 —— 传什么路径都不会被执行；
//   ② 定位结果再做一次 `realpath` 前缀校验，必须落在 sessions 根目录之内，
//      防止符号链接/异常 header 把路径带出宿主的日志区（拒绝执行，只回报原因）。
//
// 【为什么真的去拉起文件管理器】官方 harness 有 shell.openPath，插件没有（纯 Node 环境）。
//   按平台 spawn explorer / open / xdg-open 是零依赖方案；spawn 一律 detached + stdio:ignore，
//   拉起完就撒手，不等退出码（explorer.exe 成功打开也常返回 1，等它反而误判失败）。
//   所以 `opened` 只表示「拉起动作已发出」，不表示「用户真的看到了窗口」；
//   客户端同时展示 dir 与「复制路径」，拉起失败也能手动过去。

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { readJson, send } from "../http.js";
import { log } from "../shared/log.js";
import { locateSessionLogFile } from "./session-ops.js";
import { sessionsRootOf } from "../sessions/events.js";

/** 统一的错误信封。 */
function fail(res, status, code, message) {
  return send(res, status, { ok: false, error: { code, message } });
}

/** sessionId 只允许安全字符（它会被拼进路径解析，先挡住 `..` 和分隔符）。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** 取真实路径；不存在或不可解析返回 null（不抛）。 */
function safeRealpath(target) {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/** 目标目录是否落在 sessions 根目录之内（含根目录本身）。 */
function insideSessionsRoot(dir) {
  let root = "";
  try {
    root = String(sessionsRootOf() ?? "");
  } catch {
    root = "";
  }
  if (root === "") return false;
  const realRoot = safeRealpath(root);
  const realDir = safeRealpath(dir);
  if (realRoot === null || realDir === null) return false;
  const normalizedRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realDir === realRoot || realDir.startsWith(normalizedRoot);
}

/** 按平台拉起文件管理器。返回是否成功发出拉起动作（不代表窗口真的出现）。 */
function openInFileManager(dir) {
  const platform = process.platform;
  const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [dir], { detached: true, stdio: "ignore" });
    // 没 attach 的事件监听会让 ENOENT（没装 explorer 的极端环境）变成未捕获异常
    child.on("error", () => {});
    child.unref();
    return true;
  } catch (error) {
    log(null, `open-log-dir: 拉起文件管理器失败（${String(error?.message ?? error)}）`);
    return false;
  }
}

/**
 * 注册打开日志目录路由。
 * @param {object} deps
 * @param {object} deps.webServer 宿主 webServer 服务
 * @param {object} deps.ctx 插件 ctx
 * @returns {void}
 */
export function registerLogDirRoutes({ webServer, ctx }) {
  // ---------- POST /api/session-conductor/open-log-dir ----------
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/open-log-dir",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "POST") return fail(res, 405, "METHOD", "Method Not Allowed");
        const body = await readJson(req).catch(() => ({}));
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId) return fail(res, 400, "NO_SESSION_ID", "缺少 sessionId");
        if (!SAFE_SESSION_ID.test(sessionId)) return fail(res, 400, "BAD_SESSION_ID", "sessionId 含非法字符");

        const file = await locateSessionLogFile(ctx, sessionId);
        if (!file || typeof file !== "string") return fail(res, 404, "NOT_FOUND", "找不到该会话的日志文件");
        const dir = dirname(resolve(file));
        if (!existsSync(dir)) return fail(res, 404, "NOT_FOUND", `日志目录不存在: ${dir}`);
        if (!insideSessionsRoot(dir)) {
          return fail(res, 403, "OUTSIDE_ROOT", "日志目录不在会话日志根目录内，已拒绝打开");
        }

        const opened = openInFileManager(dir);
        return send(res, 200, { ok: true, dir, opened });
      } catch (error) {
        return fail(res, 500, "INTERNAL", String(error?.message ?? error));
      }
    },
  });
}
