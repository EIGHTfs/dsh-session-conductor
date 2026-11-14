// 路径安全判定：sessionId 白名单 / realpath 降级 / 目录前缀比对
//
// 【为什么单独成文件】这些是纯逻辑，零依赖、可独立单测。放在路由文件里会被
// `@deepseek-ai/dsh-llm` 之类宿主包依赖拉住（路由要 import 续跑/分析等模块），
// 单测环境没有那些可选 peer，import 都进不来 —— 而这类函数恰恰最需要测：
// 判错就是把任意目录暴露出去。

import { sep } from 'node:path';

/**
 * sessionId 白名单：它会被拼进路径解析，先挡住 `..` 与路径分隔符。
 *
 * 负向前瞻排除 `.` 与 `..`：`.` 本身在允许字符集里，不加这一条 `..` 会照样通过
 * （单测抓到的真实缺口，不是理论问题）。
 */
export const SAFE_SESSION_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

/**
 * 取真实路径；不存在或不可解析返回 null（不抛）。
 * @param {(p: string) => string} realpath realpathSync 或兼容实现
 * @param {string} target 目标路径
 * @returns {string|null}
 */
export function safeRealpath(realpath, target) {
  try {
    return realpath(target);
  } catch {
    return null;
  }
}

/**
 * 目标是否落在根目录之内（含根目录本身）。
 *
 * 必须带分隔符比对：只做 `startsWith(root)` 会把 `/sessions-evil` 判成 `/sessions` 的子目录。
 *
 * @param {string} target 已 realpath 的绝对路径
 * @param {string} root 已 realpath 的根目录
 * @returns {boolean}
 */
export function insideRoot(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string') return false;
  if (target === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(base);
}
