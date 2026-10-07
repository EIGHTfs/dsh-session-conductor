// dsh-session-conductor — 共享运行时状态与串行锁
//
// 【为什么单独成文件】这些 Map/计数器被多个域共用：
//   continueJobs（进行中的续跑）既被续跑域写、也被会话列表域读（面板展示「续跑中」）；
//   deleteLocks / continueLocks / 并发闸 被续跑、删除、撤回同时用到。
// 集中在此保证「同一份状态」，避免各域各建一份导致计数/状态不一致。

import { cfg } from "./config.js";
import { pendingTimers } from "../features/rename/analysis.js";

/** 防抖定时器（会话 → timer）。 */
export const continueTimers = new Map();
/** 每会话串行锁（续跑排队）。 */
export const continueLocks = new Map();
/** 进行中的续跑（会话 → job；UI 状态用）。 */
export const continueJobs = new Map();
/** 每会话删除锁（删除是破坏性操作，同会话删除请求排队串行）。 */
export const deleteLocks = new Map();

/** 全局并发续跑数（并发闸计数）。 */
let activeContinues = 0;
/** 周期扫描定时器句柄。 */
let scanTimer = null;

/** 每会话删除锁：同一会话的删除请求排队串行执行（并发删除不交错）。 */
export function withDeleteLock(sessionId, fn) {
  const prev = deleteLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, () => fn());
  const guard = run
    .catch(() => void 0)
    .finally(() => {
      if (deleteLocks.get(sessionId) === guard) deleteLocks.delete(sessionId);
    });
  deleteLocks.set(sessionId, guard);
  return run;
}

/** 每会话串行锁：同一会话的续跑排队执行。 */
export function withSessionLock(sessionId, fn) {
  const prev = continueLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, () => fn());
  const guard = run
    .catch(() => void 0)
    .finally(() => {
      if (continueLocks.get(sessionId) === guard) continueLocks.delete(sessionId);
    });
  continueLocks.set(sessionId, guard);
  return run;
}

/** 全局并发闸：达到 cfg.maxConcurrent 时等待。 */
export async function withConcurrencyGate(fn) {
  while (activeContinues >= cfg.maxConcurrent) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  activeContinues += 1;
  try {
    return await fn();
  } finally {
    activeContinues -= 1;
  }
}

/** 取消某会话遗留的防抖定时器与续跑记账（删除时调用，避免删除后定时器再触发）。 */
export function cancelSessionTimers(sessionId) {
  const ct = continueTimers.get(sessionId);
  if (ct !== void 0) {
    clearTimeout(ct);
    continueTimers.delete(sessionId);
  }
  const pt = pendingTimers.get(sessionId);
  if (pt !== void 0) {
    clearTimeout(pt);
    pendingTimers.delete(sessionId);
  }
  if (continueJobs.has(sessionId)) continueJobs.delete(sessionId);
}

/** 周期扫描定时器读写（插件启停扫描用）。 */
export function getScanTimer() {
  return scanTimer;
}
export function setScanTimer(timer) {
  scanTimer = timer;
  return scanTimer;
}

/** 当前并发续跑数（面板/测试观察用）。 */
export function activeContinueCount() {
  return activeContinues;
}

/** 测试钩子：清空全部运行时状态（单测在场景之间调用）。 */
export function resetRuntimeStateForTest() {
  for (const timer of continueTimers.values()) clearTimeout(timer);
  continueTimers.clear();
  continueLocks.clear();
  continueJobs.clear();
  deleteLocks.clear();
  activeContinues = 0;
  if (scanTimer !== null) clearTimeout(scanTimer);
  scanTimer = null;
}
