// 跨机转发的客户端：把一次投递送到对端（零依赖叶子）
//
// 【为什么要单独成文件】这段逻辑有两个调用方——`/relay/*` 路由与 `send_to_session` 工具。
// 若放在 relay-routes.js 里，工具模块 import 它就会被路由链上的 `continue/session.js`
// 拉住，而后者 import 宿主的 `@deepseek-ai/dsh-llm`；单测环境没有那个可选 peer，
// 一 import 就 ERR_MODULE_NOT_FOUND（本项目已因此踩过三次）。
// 本文件只用全局 fetch 与 node:os，不碰宿主服务，单测与工具都能安全 import。

import { hostname } from 'node:os';

import { cfg } from '../core/config.js';
import { normalizeTarget } from './ip-allow.js';

/** 转发给对端时的等待上限：够快反馈，也不至于让调用方干等。 */
export const RELAY_TIMEOUT_MS = 5000;

/**
 * 本机标识（给对端看的名字）。配置留空则用 hostname。
 * @returns {string}
 */
export function relayNodeName() {
  const configured = typeof cfg?.relayNodeName === 'string' ? cfg.relayNodeName.trim() : '';
  if (configured !== '') return configured;
  try {
    return hostname();
  } catch {
    return 'dsh';
  }
}

/**
 * 带超时的 JSON POST（失败不抛，用返回值区分网络失败与业务失败）。
 * @param {string} url 目标地址
 * @param {object} body 请求体
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<{ok: boolean, status?: number, payload?: object, error?: string}>}
 */
export async function postJson(url, body, timeoutMs = RELAY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return { ok: true, status: response.status, payload };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return { ok: false, error: aborted ? 'timeout' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把一次投递转发到对端的 `/relay/message`。
 *
 * @param {string} base 已规范化的 base URL（normalizeTarget 的结果）
 * @param {{sessionId: string, message: string, fromSessionId?: string}} payload 投递内容
 * @returns {Promise<{status: number, body: object}>} 状态码与要回给调用方的响应体
 */
export async function forwardRelayMessage(base, payload) {
  const forwarded = await postJson(`${base}/api/session-conductor/relay/message`, {
    sessionId: payload?.sessionId ?? '',
    message: payload?.message ?? '',
    fromLabel: relayNodeName(),
    fromSessionId: payload?.fromSessionId ?? '',
  });
  if (!forwarded.ok) {
    return {
      status: 502,
      body: { ok: false, target: base, error: { code: 'relay-unreachable', message: `对端无响应：${forwarded.error}` } },
    };
  }
  return {
    status: forwarded.status,
    body: { ok: forwarded.status === 200 && forwarded.payload?.ok === true, target: base, ...(forwarded.payload ?? {}) },
  };
}

/** 供路由复用：把 target 规范化后转发；target 非法直接回 400 语义。 */
export async function forwardToTarget(target, payload) {
  const base = normalizeTarget(target);
  if (base === null) {
    return { status: 400, body: { ok: false, error: { code: 'bad-request', message: 'ip 非法（形如 10.0.0.5:30800）' } } };
  }
  return forwardRelayMessage(base, payload);
}
