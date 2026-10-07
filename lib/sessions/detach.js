// dsh-session-conductor — 会话释放（把 live 空闲会话放回冷状态）
//
// 【职责】手动/批量把 live 会话的 agent 拆下：
// cancel → whenIdle → scope.dispose → 注册表移除 + agent/disposed → flush → detach。
// 日志完整保留；再次打开/发消息时 DSH 会自动重新挂载。

import { log } from "../shared/log.js";
import { hasOpenTurn } from "./turn.js";
import { hasApiRemoteSubagentOwner } from "./events.js";
import { continueJobs } from "../core/state.js";

/**
 * 把 live 空闲会话的 agent 拆下、释放作用域、detach 会话，回到冷（持久化）状态。
 * 顺序复刻 dsh-agent-loop 生命周期 dispose：cancel → whenIdle → scope.dispose →
 * 注册表移除 + agent/disposed → session flush + detach（session/disposed → 持久化 retire）。
 * 守卫：运行中（open turn）拒绝；subagent 拥有的会话拒绝；非 live 幂等返回。
 * 返回 {ok} 或 {ok:false, error:{code,message}}。
 */
export async function detachSessionAgent(ctx, sessionId) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const session = sessions?.get(sessionId);
  if (!session) {
    return { ok: false, error: { code: "not-live", message: "会话不在活跃（live）状态，无需释放" } };
  }

  const agent = agents?.get(sessionId);
  if (agent && hasApiRemoteSubagentOwner(ctx, session, agent)) {
    return { ok: false, error: { code: "subagent-owned", message: "该会话属于子代理（subagent）路由，不能手动释放" } };
  }
  if (agent?.status === "running" || hasOpenTurn(session.events)) {
    return { ok: false, error: { code: "running", message: "会话正在运行中，无法释放（请先停止）" } };
  }

  // 1. 停止机器（idle 时为 no-op；keepInbox 保留排队中的消息，不丢弃）+ 等它安静
  if (agent) {
    try {
      agent.cancel({ kind: "disposed" }, { keepInbox: true });
    } catch {
      // agent 可能已不可用，继续往下拆
    }
    try {
      await agent.whenIdle?.();
    } catch {
      // 忽略
    }
  }

  // 2. 释放 agent 作用域 fiber（卸载其注册的 effect：preset 工具、监听器等）
  if (agent?.scope?.dispose) {
    try {
      await agent.scope.dispose();
    } catch (error) {
      log(ctx, `释放 ${sessionId} 作用域失败（继续拆卸）: ${String(error?.message ?? error)}`);
    }
  }

  // 3. 从 agents 注册表移除并广播 agent/disposed（复刻 detachEntered）
  const entry = agents?.store?.get(sessionId);
  if (entry) {
    agents.store.delete(sessionId);
    if (entry.announced) {
      try {
        agents.emitDisposed(entry);
      } catch (error) {
        log(ctx, `agent/disposed 广播失败 ${sessionId}: ${String(error?.message ?? error)}`);
      }
    }
  }

  // 4. 先 flush 保证日志落盘，再 detach 会话 → session/disposed → 持久化协调器 retire
  try {
    await sessions.flush?.(session);
  } catch (error) {
    log(ctx, `释放 ${sessionId} flush 失败（继续 detach）: ${String(error?.message ?? error)}`);
  }
  try {
    sessions?.store?.get(sessionId)?.detach?.();
  } catch (error) {
    return { ok: false, error: { code: "detach-failed", message: String(error?.message ?? error) } };
  }

  log(ctx, `已释放（置为不活跃）会话 ${sessionId}`);
  return { ok: true };
}

/** 释放全部 live 空闲会话（跳过运行中 / subagent / 续跑中），返回 {ok, released, skipped}。 */
export async function detachAllIdleSessions(ctx) {
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const released = [];
  const skipped = [];
  for (const session of sessions?.list() ?? []) {
    const id = session.id;
    if (hasOpenTurn(session.events)) {
      skipped.push({ id, reason: "running" });
      continue;
    }
    const agent = agents?.get(id);
    if (agent && hasApiRemoteSubagentOwner(ctx, session, agent)) {
      skipped.push({ id, reason: "subagent" });
      continue;
    }
    if (continueJobs.has(id)) {
      skipped.push({ id, reason: "continue-in-flight" });
      continue;
    }
    const result = await detachSessionAgent(ctx, id);
    if (result.ok) released.push(id);
    else skipped.push({ id, reason: result.error?.code ?? "failed" });
  }
  return { ok: true, released, skipped };
}
