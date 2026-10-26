// dsh-session-conductor — 「跟随主代理」的取值来源
//
// 【这个文件解决什么】切换模型/权限时把参数留空表示「跟主代理一致」，这样新建一批成员后
// 不用逐个查 Lead 当前用的什么。这里负责把「主代理当前到底是什么」查准：
//   · 模型：优先请求级权威记录（会话日志里的 request/header，即**真实发出请求时用的值**），
//     退而用本进程内观察到的最近一次请求；都读不到就如实报错，绝不用名册里的静态字段冒充
//     （名册里那个值可能是创建时的旧值，与当前实际不符）。
//   · 权限：取会话日志里最后一条 permission/preset（宿主折叠语义：最后一条即生效值）。
import { peekLastRequestModel, readLastRequestModel } from "./switch.js";
import { readMemberPermission } from "./permission.js";
import { resolveLeader } from "./locate.js";

/**
 * 读 Team Lead 当前的模型与权限预设。
 *
 * @param {object} ctx 插件 context
 * @param {{caller?: object}} [opts] 显式发起方（指令/工具执行时的 agent）
 * @returns {Promise<{sessionId: string, leadSource: string, provider: string|null, model: string|null,
 *                    modelSource: string|null, preset: string|null, sandbox: string|null, approval: string|null,
 *                    warnings: string[]} | {error: string}>}
 */
export async function readLeaderRoute(ctx, { caller = null } = {}) {
  const lead = resolveLeader(ctx, { caller });
  if (lead?.error) return { error: lead.error };

  const warnings = [];
  let provider = null;
  let model = null;
  let modelSource = null;

  // ① 请求级权威记录（日志里的 request/header）
  try {
    const { lastRequest } = await readLastRequestModel(lead.sessionId);
    if (lastRequest?.provider && lastRequest?.model) {
      provider = lastRequest.provider;
      model = lastRequest.model;
      modelSource = "请求级记录（会话日志 request/header）";
    }
  } catch (error) {
    warnings.push(`读请求级记录失败：${String(error?.message ?? error)}`);
  }
  // ② 本进程内观察到的最近一次请求（日志未落盘时的兜底）
  if (!provider) {
    const live = peekLastRequestModel(lead.sessionId);
    if (live?.provider && live?.model) {
      provider = live.provider;
      model = live.model;
      modelSource = "本进程观察（日志尚未落盘）";
      warnings.push("模型取自进程内观察，可能比日志更新；如与界面不一致请以界面为准");
    }
  }
  if (!provider) {
    return {
      error: `读不到主代理（${lead.sessionId}）当前使用的模型：会话日志里没有 request/header，进程内也没有观察记录。请显式指定 provider/model`,
    };
  }

  // ③ 权限预设（最后一条 preset 生效）
  const perm = await readMemberPermission(lead.sessionId);
  if (perm.error) warnings.push(`读主代理权限失败：${perm.error}`);

  return {
    sessionId: lead.sessionId,
    leadSource: lead.source,
    provider,
    model,
    modelSource,
    preset: perm.error ? null : perm.preset,
    sandbox: perm.error ? null : perm.sandbox,
    approval: perm.error ? null : perm.approval,
    warnings,
  };
}
