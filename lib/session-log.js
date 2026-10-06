// dsh-session-conductor — 会话日志文件定位（多版本文件名兼容）
//
// 【为什么需要】DSH 的会话日志文件名随 Session Format 版本变化：
//   · v3（0.1.x）      → session.jsonl.zstd
//   · v4（0.2.0 起）   → session.v4.jsonl.zstd
// 插件里多处（帧扫描 / EIO 修复 / seq-gap 修复 / 双格式检测 / 撤回）都要按会话目录找日志文件，
// 硬编码单一文件名会在升级后全部失效——统一走本模块定位。

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 已知的会话日志文件名（按新→旧顺序探测，新增版本时在此追加）。 */
const KNOWN_LOG_NAMES = ["session.v4.jsonl.zstd", "session.jsonl.zstd"];

/**
 * 定位单个会话目录下的会话日志文件（兼容 v3/v4 及未来版本命名）。
 * @param {string} sessionDir 单个会话目录（如 <sessions>/<workspace>/<sessionId>）
 * @returns {string|null} 日志文件路径；目录里没有会话日志时返回 null
 */
export function findSessionLog(sessionDir) {
  if (!sessionDir) return null;
  for (const name of KNOWN_LOG_NAMES) {
    const p = join(sessionDir, name);
    if (existsSync(p)) return p;
  }
  // 兜底：按模式匹配（覆盖 session.v5.jsonl.zstd 等未来命名）
  try {
    const hit = readdirSync(sessionDir)
      .filter((f) => /^session(\.[a-z0-9]+)*\.jsonl\.zstd$/.test(f))
      .sort()
      .pop();
    if (hit) return join(sessionDir, hit);
  } catch {
    // 目录不可读 → 视为没有日志
  }
  return null;
}

/**
 * 判断一个文件名是否像会话日志（用于双格式检测等按文件名判断的场景）。
 * @param {string} name 文件名
 * @returns {boolean}
 */
export function isSessionLogName(name) {
  return typeof name === "string" && /^session(\.[a-z0-9]+)*\.jsonl\.zstd$/.test(name);
}
