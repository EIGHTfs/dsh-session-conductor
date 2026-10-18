// 创建团队成员并**同时**指定模型。
//
// 【为什么需要这一层】宿主 `spawn_teammate` 的参数里没有 provider/model，服务层的
// SpawnTeammateRequest 也只有 provider —— 模型只能来自 agent-team 插件的
// freshProvider/forkProvider 配置，所以「创建时就选模型」在原生入口做不到。
// 这里补一层：调团队服务创建 → 立刻把 model/selection 写进新成员的运行记录。
//
// 【已知边界】宿主是「创建即开跑」，新成员第一轮很可能已经用默认模型发出请求；
// 本工具的切换从**下一回合**生效。要彻底做到「创建前就定模型」只能改宿主
// agent-team（把 model 加进 SpawnTeammateRequest 并在创建时应用），宿主升级会覆盖。
//
// 【权限】只有 Team Lead 能创建成员（宿主会抛 TEAM_LEAD_REQUIRED），所以调用方 agent 必须透传。

import { log } from "../../shared/log.js";
import { switchAgentModel } from "./switch.js";

/**
 * 创建成员 + 立即设置模型。
 * @param {object} ctx 插件上下文
 * @param {object} exec 工具执行上下文（含 agent / signal）
 * @param {object} args 工具参数
 * @returns {Promise<{ok:true, member:object, switchResult:object} | {error:string}>}
 */
export async function createTeammateWithModel(ctx, exec, args) {
  const name = String(args?.name ?? "").trim();
  const description = String(args?.description ?? "").trim();
  const prompt = String(args?.prompt ?? "").trim();
  const provider = String(args?.provider ?? "").trim();
  const model = String(args?.model ?? "").trim();
  const context = args?.context === "fork" ? "fork" : "fresh";

  if (!name || !description || !prompt) return { error: "name / description / prompt 都必填" };
  if (!provider || !model) return { error: "provider / model 都必填（先用 list_models 查确切值）" };

  const teams = ctx.get("agentTeams");
  if (typeof teams?.spawnTeammate !== "function") {
    return { error: "agentTeams.spawnTeammate 不可用：当前 DSH 版本没有暴露创建接口" };
  }
  const caller = exec?.agent ?? null;
  if (!caller) return { error: "拿不到调用方 agent（该工具只能由 Team Lead 在自身的运行上下文里调用）" };

  // signal：优先用工具调用自带的（可随宿主取消），否则用一个永不自废弃的控制器
  const fallbackController = new AbortController();
  let spawned;
  try {
    spawned = await teams.spawnTeammate(caller, {
      name,
      description,
      prompt: [{ type: "text", text: prompt }],
      context,
      provider,
      signal: exec?.signal ?? fallbackController.signal,
    });
  } catch (error) {
    return { error: `创建成员失败：${String(error?.message ?? error)}` };
  }

  const member = spawned?.member ?? null;
  const sessionId = member?.id ? String(member.id) : "";
  if (!sessionId) return { error: "创建成功但成员视图里没有 id，无法继续设置模型" };

  // 立刻切到指定模型：写 model/selection 事件，下一回合生效（官方接口默认关闭，不碰 @Remote）
  const switchResult = await switchAgentModel(ctx, sessionId, provider, model, null);
  log(ctx, `创建成员 ${name}（${sessionId}）→ 设置模型 ${provider}/${model}：${switchResult.error ? `失败 ${switchResult.error}` : "已写入事件"}`);
  return { ok: true, member, switchResult };
}

/**
 * 把 createTeammateWithModel 的结果渲染成给模型看的文本。
 * @param {{name:string, provider:string, model:string}} args
 * @param {object} result
 */
export function renderCreateTeammateResult(args, result) {
  if (result?.error) return `创建成员失败：${result.error}`;
  const member = result.member ?? {};
  const sessionId = String(member.id ?? "");
  const switchResult = result.switchResult ?? {};
  const switchLine = switchResult.error
    ? `模型设置失败：${switchResult.error}（成员已建好，可稍后用 set_member_model 重试）`
    : `模型设置：${switchResult.via ?? "已写入 model/selection 事件"}`;
  return [
    `已创建成员 ${member.name ?? args?.name ?? "?"}（${sessionId}）`,
    `成员视图 provider=${member.provider ?? "?"} ｜ model=${member.model ?? "?"}`,
    switchLine,
    "已知边界：宿主创建即开跑，该成员**第一轮**可能仍用默认模型；切换从下一回合生效。",
  ].join("\n");
}
