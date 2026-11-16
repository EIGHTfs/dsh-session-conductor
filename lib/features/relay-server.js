// 跨机转发的**局域网监听**：插件自己起一个 HTTP 服务，专收对端投递
//
// 【为什么必须自建】宿主给插件的路由只挂在回环端口（实测 127.0.0.1:30801），局域网
// 根本打不到；而对外端口（30800）是认证网关、且没有插件路由。要让「另一台机器」能发消息
// 过来，只能自己监听一个局域网可达的端口。
//
// 【好处】以后要做虚拟局域网/公网访问，只需映射这一个端口，不必把 GUI 暴露出去。
//
// 【准入】只有来源 IP 白名单（lib/shared/ip-allow.js），不走宿主的 cookie 认证——
// 对端不可能持有本机 token。默认只放行本机，必须显式配置 relayAllowList。
//
// 【端口】配置 relayPort 优先（默认 30810）。启动时**检测占用**：被占用就明确报错并记录
// 状态，不自动换端口——静默换端口会让对端配置失效，排查起来极难。

import { createServer } from "node:http";

import { cfg } from "../core/config.js";
import { log } from "../shared/log.js";
import { handleRelayInfo, handleRelayMessage, handleRelayPeek } from "./relay-routes.js";

/** 缺省监听端口（与宿主 30800/30801/30802 错开，避免撞车）。 */
export const DEFAULT_RELAY_PORT = 30810;
/** 缺省绑定地址：局域网可达。只给本机用可配成 127.0.0.1。 */
export const DEFAULT_RELAY_BIND = "0.0.0.0";

/** 运行状态（供自检与日志排查；不落盘，进程重启即重置）。 */
let relayState = { listening: false, port: null, bind: null, error: null, startedAt: 0 };

/**
 * 当前监听状态（只读快照）。
 * @returns {{listening: boolean, port: number|null, bind: string|null, error: string|null, startedAt: number}}
 */
export function relayServerState() {
  return { ...relayState };
}

/**
 * 解析配置里的端口；非法值退回默认。
 * @returns {number}
 */
function resolvePort() {
  const raw = Number(cfg?.relayPort);
  if (Number.isInteger(raw) && raw > 0 && raw < 65536) return raw;
  return DEFAULT_RELAY_PORT;
}

/**
 * 解析配置里的绑定地址；空值退回默认。
 * @returns {string}
 */
function resolveBind() {
  const raw = typeof cfg?.relayBind === "string" ? cfg.relayBind.trim() : "";
  return raw === "" ? DEFAULT_RELAY_BIND : raw;
}

/**
 * 按路径分发到对应的 handler（与宿主端口上那三条同一份实现）。
 * @param {object} ctx 插件 ctx
 * @param {object} req Node 请求
 * @param {object} res Node 响应
 * @returns {Promise<boolean>} 是否命中已知路由
 */
async function dispatch(ctx, req, res) {
  const pathname = new URL(req.url ?? "/", "http://relay.local").pathname;
  if (pathname === "/api/session-conductor/relay/info") {
    await handleRelayInfo(ctx, req, res);
    return true;
  }
  if (pathname === "/api/session-conductor/relay/message") {
    await handleRelayMessage(ctx, req, res);
    return true;
  }
  if (pathname === "/api/session-conductor/relay/peek") {
    await handleRelayPeek(ctx, req, res);
    return true;
  }
  return false;
}

/**
 * 启动局域网监听，并把关闭动作挂到插件生命周期上。
 *
 * 失败不抛（插件其余功能必须照常可用），只把原因记进 relayState 与日志；
 * 调用方可通过 relayServerState() 或日志确认。
 *
 * @param {object} ctx 插件 ctx
 * @returns {Promise<{listening: boolean, port: number|null, bind: string|null, error: string|null}>}
 */
export async function startRelayServer(ctx) {
  const port = resolvePort();
  const bind = resolveBind();

  const server = createServer((req, res) => {
    dispatch(ctx, req, res).then((matched) => {
      if (!matched) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: { code: "not-found", message: "只提供 /relay/{info,message,peek}" } }));
      }
    }).catch((error) => {
      // 已发出响应时不能再改；只记日志
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: { code: "relay-internal", message: String(error?.message ?? error) } }));
        }
      } catch { /* 连接已断 */ }
      log(ctx, `[relay] 自建监听处理异常：${String(error?.message ?? error)}`);
    });
  });

  const settled = await new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };

    server.once("error", (error) => {
      const code = error?.code ?? "";
      const reason = code === "EADDRINUSE"
        ? `端口 ${port} 已被占用（换 relayPort 或释放该端口）`
        : code === "EACCES"
          ? `没有权限监听端口 ${port}（1024 以下需特权）`
          : String(error?.message ?? error);
      finish({ ok: false, reason });
    });

    server.listen(port, bind, () => {
      finish({ ok: true });
    });
  });

  if (!settled.ok) {
    relayState = { listening: false, port, bind, error: settled.reason, startedAt: 0 };
    log(ctx, `[relay] 局域网监听未启动：${settled.reason}`);
    return relayServerState();
  }

  relayState = { listening: true, port, bind, error: null, startedAt: Date.now() };
  log(ctx, `[relay] 局域网监听已启动：http://${bind}:${port}（准入只看来源 IP 白名单）`);

  // 插件卸载/重载时关闭，避免端口泄漏导致下次启动 EADDRINUSE
  ctx.effect?.(() => () => {
    try { server.close(); } catch { /* 已关闭 */ }
    relayState = { listening: false, port, bind, error: null, startedAt: 0 };
  }, "session-conductor: relay server");

  return relayServerState();
}

/** 测试钩子：重置状态。 */
export function resetRelayServerStateForTest() {
  relayState = { listening: false, port: null, bind: null, error: null, startedAt: 0 };
}
