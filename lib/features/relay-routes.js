// dsh-session-conductor — 跨机会话转发（局域网内两台装了本插件的实例互投消息）
//
// 【为什么是 HTTP 转发而不是新协议】本插件已经有 `POST /message`（向本机某条会话投递用户消息
// 并唤起），跨机缺的只是「把这次投递送到另一台机器上」。所以接收端直接复用
// `sendMessageToSession`，发送端只是把它换成一次 HTTP 调用 —— 语义完全一致，不引入第二套协议。
//
//   接收端 POST /relay/message { sessionId, message, fromLabel? }
//      → ① 来源 IP 白名单校验 ② sendMessageToSession(ctx, sessionId, text, { fromSessionId })
//   发送端 POST /relay/send    { target, sessionId, message }
//      → 转发到对端的 /relay/message
//   两端都有 GET /relay/info（我是谁 + 我最近有哪些会话），供发送端选会话
//
// 【准入】NFS exports 风格的来源 IP 白名单（见 lib/shared/ip-allow.js），空列表只放行本机。
// 用 IP 而不是口令：局域网内机器固定、少一次密钥分发；代价是同机多用户场景不区分身份。
//
// 【错误要能分辨】对端离线 / 被拒绝 / 会话不存在 三种情况回不同错误码，否则「发不出去」
// 只能靠猜。

import { hostname } from "node:os";

import { send } from "../http.js";
import { log } from "../shared/log.js";
import { LOOPBACK_IPV4, ipAllowed, normalizeRemoteAddress, normalizeTarget } from "../shared/ip-allow.js";
import { buildSessionListCached } from "../sessions/list.js";
import { sendMessageToSession } from "./continue/session.js";
import { cfg } from "../core/config.js";

/** 转发给对端时的等待上限：够快反馈，也不至于让面板卡很久。 */
const RELAY_TIMEOUT_MS = 5000;
/** /relay/info 默认返回的会话条数（太多会把响应撑大，对端也不好选）。 */
const RELAY_INFO_DEFAULT_LIMIT = 50;
/** 转发请求里携带的会话条数上限。 */
const RELAY_INFO_MAX_LIMIT = 300;

/**
 * 当前请求的来源是否被白名单允许。
 * @param {object} req Node 请求
 * @returns {{allowed: boolean, ip: string|null}}
 */
function checkSource(req) {
  const ip = normalizeRemoteAddress(req?.socket?.remoteAddress);
  return { allowed: ipAllowed(ip, cfg.relayAllowList), ip };
}

/**
 * 本机标识（给对端看的名字）。
 * @returns {string}
 */
function nodeName() {
  const configured = typeof cfg.relayNodeName === "string" ? cfg.relayNodeName.trim() : "";
  if (configured !== "") return configured;
  try {
    return hostname();
  } catch {
    return "dsh";
  }
}

/**
 * 带超时的 JSON POST。
 * @param {string} url 目标地址
 * @param {object} body 请求体
 * @returns {Promise<{ok: boolean, status?: number, payload?: object, error?: string}>}
 */
async function postJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => null);
    return { ok: true, status: res.status, payload };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带超时的 JSON GET。
 * @param {string} url 目标地址
 * @returns {Promise<{ok: boolean, status?: number, payload?: object, error?: string}>}
 */
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    const payload = await res.json().catch(() => null);
    return { ok: true, status: res.status, payload };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注册跨机中继路由。
 * @param {{webServer: object, ctx: object}} deps
 */
export function registerRelayRoutes({ webServer, ctx }) {
  // ---------- GET /api/session-conductor/relay/info ----------
  // 对端用这个了解「你是谁、你有哪些会话」。同样受白名单限制。
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/relay/info",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "GET") {
          send(res, 405, { ok: false, error: { code: "method", message: "只支持 GET" } });
          return;
        }
        const source = checkSource(req);
        if (!source.allowed) {
          log(ctx, `[relay] 拒绝 info 请求：来源 ${source.ip ?? "未知"} 不在白名单`);
          send(res, 403, { ok: false, error: { code: "relay-forbidden", message: `来源 ${source.ip ?? "未知"} 不在白名单` } });
          return;
        }
        const url = new URL(req.url ?? "/", "http://dsh.local");
        const rawLimit = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), RELAY_INFO_MAX_LIMIT)
          : RELAY_INFO_DEFAULT_LIMIT;
        const sessions = await buildSessionListCached(ctx);
        const items = (Array.isArray(sessions) ? sessions : [])
          .filter((item) => item && typeof item.id === "string")
          .slice(0, limit)
          .map((item) => ({
            id: item.id,
            title: String(item.title ?? ""),
            updatedAt: Number(item.updatedAt) || 0,
            archived: item.archived === true,
            running: item.running === true,
          }));
        send(res, 200, { ok: true, name: nodeName(), sessions: items });
      } catch (error) {
        send(res, 500, { ok: false, error: { code: "relay-info-failed", message: String(error?.message ?? error) } });
      }
    },
  });

  // ---------- POST /api/session-conductor/relay/message ----------
  // 接收对端的投递：校验来源 IP → 复用本机既有的会话投递实现。
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/relay/message",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "POST") {
          send(res, 405, { ok: false, error: { code: "method", message: "只支持 POST" } });
          return;
        }
        const source = checkSource(req);
        if (!source.allowed) {
          log(ctx, `[relay] 拒绝投递：来源 ${source.ip ?? "未知"} 不在白名单`);
          send(res, 403, { ok: false, error: { code: "relay-forbidden", message: `来源 ${source.ip ?? "未知"} 不在白名单` } });
          return;
        }
        const body = await readJsonSafe(req);
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        const message = typeof body?.message === "string" ? body.message : "";
        if (sessionId === "" || message.trim() === "") {
          send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId 或 message" } });
          return;
        }
        // 来源标记写在事件里，便于在会话轨迹上分辨「这条是谁发来的」，不伪装成本机消息
        const fromLabel = typeof body?.fromLabel === "string" ? body.fromLabel.trim() : "";
        const fromSessionId = typeof body?.fromSessionId === "string" ? body.fromSessionId.trim() : "";
        const marker = fromLabel !== "" || fromSessionId !== ""
          ? `relay:${fromLabel || "peer"}${fromSessionId ? `/${fromSessionId}` : ""}`
          : "relay:peer";
        const result = await sendMessageToSession(ctx, sessionId, message, { fromSessionId: marker });
        if (!result?.ok) {
          send(res, result?.error?.code === "not-found" ? 404 : 400, { ok: false, error: result?.error ?? { code: "relay-deliver-failed", message: "投递失败" } });
          return;
        }
        log(ctx, `[relay] 已接收来自 ${source.ip} 的投递 → ${sessionId}`);
        send(res, 200, { ok: true, sessionId, fromIp: source.ip });
      } catch (error) {
        send(res, 500, { ok: false, error: { code: "relay-deliver-failed", message: String(error?.message ?? error) } });
      }
    },
  });

  // ---------- POST /api/session-conductor/relay/send ----------
  // 本机作为发送方：把消息转发到对端的 /relay/message。
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/relay/send",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "POST") {
          send(res, 405, { ok: false, error: { code: "method", message: "只支持 POST" } });
          return;
        }
        const body = await readJsonSafe(req);
        const base = normalizeTarget(body?.target);
        if (base === null) {
          send(res, 400, { ok: false, error: { code: "bad-request", message: "target 非法（形如 10.0.0.5:30800）" } });
          return;
        }
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        const message = typeof body?.message === "string" ? body.message : "";
        if (sessionId === "" || message.trim() === "") {
          send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId 或 message" } });
          return;
        }
        const forwarded = await postJson(`${base}/api/session-conductor/relay/message`, {
          sessionId,
          message,
          fromLabel: nodeName(),
          fromSessionId: typeof body?.fromSessionId === "string" ? body.fromSessionId.trim() : "",
        });
        if (!forwarded.ok) {
          // 分不清「离线」还是「超时」时统一归为 unreachable，但把原因带上
          send(res, 502, {
            ok: false,
            target: base,
            error: { code: "relay-unreachable", message: `对端无响应：${forwarded.error}` },
          });
          return;
        }
        send(res, forwarded.status, {
          ok: forwarded.status === 200 && forwarded.payload?.ok === true,
          target: base,
          ...(forwarded.payload ?? {}),
        });
      } catch (error) {
        send(res, 500, { ok: false, error: { code: "relay-send-failed", message: String(error?.message ?? error) } });
      }
    },
  });

  // ---------- GET /api/session-conductor/relay/peek ----------
  // 拉对端的 /relay/info（供发送端选会话）。
  webServer.register({
    kind: "exact",
    path: "/api/session-conductor/relay/peek",
    handler: async (req, res) => {
      try {
        if ((req.method ?? "GET") !== "GET") {
          send(res, 405, { ok: false, error: { code: "method", message: "只支持 GET" } });
          return;
        }
        const url = new URL(req.url ?? "/", "http://dsh.local");
        const base = normalizeTarget(url.searchParams.get("target"));
        if (base === null) {
          send(res, 400, { ok: false, error: { code: "bad-request", message: "target 非法" } });
          return;
        }
        const fetched = await getJson(`${base}/api/session-conductor/relay/info`);
        if (!fetched.ok) {
          send(res, 502, { ok: false, target: base, error: { code: "relay-unreachable", message: `对端无响应：${fetched.error}` } });
          return;
        }
        send(res, fetched.status, { target: base, ...(fetched.payload ?? {}) });
      } catch (error) {
        send(res, 500, { ok: false, error: { code: "relay-peek-failed", message: String(error?.message ?? error) } });
      }
    },
  });
}

/**
 * 读 JSON 请求体（容错：非法 JSON 当作空对象，避免把 400 变成 500）。
 * @param {object} req Node 请求
 * @returns {Promise<object>}
 */
async function readJsonSafe(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** 供测试引用：默认超时与回环常量。 */
export const RELAY_LIMITS = { timeoutMs: RELAY_TIMEOUT_MS, defaultSessionLimit: RELAY_INFO_DEFAULT_LIMIT, maxSessionLimit: RELAY_INFO_MAX_LIMIT, loopback: LOOPBACK_IPV4 };
