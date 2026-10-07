/**
 * dsh-session-conductor — 「打 HTTP API」测试基座
 *
 * 设计要点：
 *   ① **不 import 任何宿主包**：只用 Node 内置的 fetch + fs/path，避免出现
 *      `Cannot find package '@deepseek-ai/dsh-storage-domain'` 这类「测试依赖宿主包」的脆弱形态。
 *   ② **固定基准**：只对**运行中的宿主**发真实 HTTP（默认 127.0.0.1:30801，可用 SC_HOST 覆盖），
 *      不做「工作区跑一遍 / 安装副本再跑一遍」的对照——基准唯一、结果确定。
 *   ③ **登录**：宿主写鉴权 cookie；token 从宿主启动日志的「首次认证」行取（与人工访问同一路径）。
 *
 * 用法：
 *   import { api, requireHost } from './helpers/host-api.mjs';
 *   const r = await api('GET', '/api/session-conductor/group/status');
 *   assert.equal(r.status, 200);
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 宿主基址（固定基准；可用环境变量覆盖以便在测试实例上跑） */
export const HOST = process.env.SC_HOST || 'http://127.0.0.1:30801';
/** DSH_HOME（默认取本机 0.2.0-rc.2 实例；token 从它的启动日志里取） */
export const DSH_HOME = process.env.SC_DSH_HOME || '/volume1/@appdata/DeepSeekHarness-NAS/0.2.0-rc.2/.dsh';
/** 宿主启动日志（含「首次认证 http://…/?token=…」行） */
const LOG_PATH = process.env.SC_LOG || join(DSH_HOME, '..', 'DeepSeekHarness-NAS.log');

let cachedCookie = '';

/** 从宿主启动日志取当前 token（取最后一条「首次认证」） */
export function readHostToken() {
  if (!existsSync(LOG_PATH)) return '';
  const text = readFileSync(LOG_PATH, 'utf8');
  const all = [...text.matchAll(/[?&]token=([A-Za-z0-9_-]{16,})/g)].map((m) => m[1]);
  return all.length ? all[all.length - 1] : '';
}

/** 登录并缓存 cookie（同一次测试进程内只登一次） */
export async function login() {
  if (cachedCookie) return cachedCookie;
  const token = readHostToken();
  if (!token) throw new Error(`无法从宿主日志取 token（${LOG_PATH}）——请确认宿主已启动`);
  const res = await fetch(`${HOST}/?token=${token}`, { redirect: 'manual' });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  cachedCookie = setCookie.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
  if (!cachedCookie) throw new Error('登录未拿到 cookie——宿主鉴权形态可能已变');
  return cachedCookie;
}

/**
 * 调一个 API。
 * @param {string} method GET/POST/…
 * @param {string} path 形如 /api/session-conductor/group/status
 * @param {object} [body] JSON 请求体（POST 用）
 * @returns {Promise<{status:number, json:any, text:string}>}
 */
export async function api(method, path, body) {
  const cookie = await login();
  const headers = { cookie, origin: HOST, accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${HOST}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应（如 ndjson）保持 text */ }
  return { status: res.status, json, text };
}

/** 宿主可用性检查（不可用时测试应**明确跳过**并说明，而不是伪装通过） */
export async function requireHost() {
  try {
    const r = await api('GET', '/api/session-conductor/group/status');
    return r.status === 200;
  } catch {
    return false;
  }
}
