// 创建团队成员，并让**第一轮真实任务**就用指定模型。
//
// 【为什么需要这一层】宿主 `spawn_teammate` 的参数里没有 provider/model，服务层的
// SpawnTeammateRequest 也只有 provider —— 模型只能来自 agent-team 插件的
// freshProvider/forkProvider 配置，所以「创建时就选模型」在原生入口做不到。
//
// 【为什么不只是「创建后切一下」】宿主是「创建即开跑」：直接带真实任务创建，第一轮一定用默认模型跑掉。
// 所以这里拆成四步：
//   ① 用**占位任务**创建（几乎不花钱，也不会动任何文件）
//   ② 立刻中断，把这一轮停掉
//   ③ 把 model/selection 写进该成员的运行记录（与 set_member_model 同一条链路）
//   ④ 再用新模型投递真实任务
// 这样真实任务从第一条指令起就用指定模型，而不是「先跑错一轮再切」。
//
// 【仍然存在的边界】① 占位那一轮确实发生过（只消耗一条极短提示的输入）；
// ② 中断与切换之间存在极短窗口；③ 要彻底「创建前定模型」只能改宿主 agent-team
// （把 model 加进 SpawnTeammateRequest 并在创建时应用），宿主升级会覆盖。
//
// 【两个 "provider" 别混】宿主 spawnTeammate 的 provider = **子代理 provider**（注册在 ctx.subagents，
// 例如 spawn），而模型用的是 **模型 provider**（agnes/wb/d…）。两者是不同命名空间，
// 直接拿模型 provider 去创建会报 `no subagent provider registered for "x"`。
//
// 【权限】只有 Team Lead 能创建成员（宿主会抛 TEAM_LEAD_REQUIRED），调用方 agent 必须透传。

import { log } from "../../shared/log.js";
import { switchAgentModel } from "./switch.js";

/**
 * 占位任务：只为让成员被创建出来，不产生实质动作。
 * 写得极短是为了把首轮消耗压到最低（这一轮拿不到指定模型，越短越不亏）。
 */
export const PLACEHOLDER_PROMPT = "先待命：不要执行任何操作，不要调用任何工具，不要读写任何文件，等待后续消息。";

/**
 * 等成员真正空闲（中断的取消信号被观测完）再投递。
 *
 * 【为什么必须等】只看 `interrupt()` 的返回不够：它只是「发出取消」，成员可能仍在收尾；
 * 这时立刻投递，新一轮会撞上同一个取消信号，表现为成员「stopped/failed before it finished」。
 * 用宿主自己的 `waitForChange` 等状态变化（事件驱动），不睡固定时间。
 * @returns {Promise<{idle:boolean, status:string}>}
 */
export async function waitUntilIdle(teams, caller, name, signal, budget = 60) {
  if (typeof teams?.listMembers !== 'function' || typeof teams?.waitForChange !== 'function') {
    // 老宿主没有这两个能力：退化为「不等待」，行为与之前一致
    return { idle: false, status: 'unknown' };
  }
  for (let round = 0; round < budget; round += 1) {
    let member = null;
    try {
      const list = teams.listMembers(caller) ?? [];
      member = list.find((m) => m?.name === name || m?.target === name) ?? null;
    } catch {
      return { idle: false, status: 'unknown' };
    }
    if (!member || member.status !== 'running') return { idle: true, status: member?.status ?? 'absent' };
    try {
      // 等「下一次团队状态变化」，超时也算一次观察窗口（不是业务超时，只是等待预算）
      await teams.waitForChange(caller, 5000, signal);
    } catch {
      return { idle: false, status: member.status ?? 'unknown' };
    }
  }
  return { idle: false, status: 'still-running' };
}

/**
 * 创建成员 → 中断首轮 → 设置模型 → 投递真实任务。
 * @param {object} ctx 插件上下文
 * @param {object} exec 工具执行上下文（含 agent / signal）
 * @param {object} args 工具参数
 * @returns {Promise<
 *   {ok:true, member:object, interrupt:object, switchResult:object, delivery:object} |
 *   {ok:true, member:object, interrupt:object, switchResult:object, delivery:null, error:string} |
 *   {error:string}>}
 */
export async function createTeammateWithModel(ctx, exec, args) {
  const name = String(args?.name ?? "").trim();
  const description = String(args?.description ?? "").trim();
  const prompt = String(args?.prompt ?? "").trim();
  const modelProvider = String(args?.provider ?? "").trim(); // 模型 provider：agnes / wb / d …
  const model = String(args?.model ?? "").trim();            // 模型 id
  const context = args?.context === "fork" ? "fork" : "fresh";

  if (!name || !description || !prompt) return { error: "name / description / prompt 都必填" };
  if (!modelProvider || !model) return { error: "provider / model 都必填（先用 list_models 查确切值）" };

  const teams = ctx.get("agentTeams");
  if (typeof teams?.spawnTeammate !== "function") {
    return { error: "agentTeams.spawnTeammate 不可用：当前 DSH 版本没有暴露创建接口" };
  }
  if (typeof teams?.sendMessage !== "function") {
    return { error: "agentTeams.sendMessage 不可用：无法在创建后投递真实任务" };
  }
  const caller = exec?.agent ?? null;
  if (!caller) return { error: "拿不到调用方 agent（该工具只能由 Team Lead 在自身的运行上下文里调用）" };

  // 子代理 provider 与模型 provider 是两个命名空间：前者来自 ctx.subagents 注册表
  let subagentProvider = String(args?.subagentProvider ?? "").trim();
  if (!subagentProvider) {
    const subagents = ctx.get("subagents");
    const names = typeof subagents?.list === "function" ? subagents.list() : [];
    subagentProvider = Array.isArray(names) && names.length > 0 ? String(names[0]) : "";
  }
  if (!subagentProvider) {
    return { error: "没有可用的子代理 provider（ctx.subagents.list() 为空）——请在参数里显式传 subagentProvider" };
  }


  // signal：优先用工具调用自带的（可随宿主取消），否则用一个永不自废弃的控制器
  const fallbackController = new AbortController();
  const signal = exec?.signal ?? fallbackController.signal;

  // ① 占位任务创建：真实任务留到模型设好之后再投
  let spawned;
  try {
    spawned = await teams.spawnTeammate(caller, {
      name,
      description,
      prompt: [{ type: "text", text: PLACEHOLDER_PROMPT }],
      context,
      provider: subagentProvider,
      signal,
    });
  } catch (error) {
    return { error: `创建成员失败：${String(error?.message ?? error)}` };
  }

  const member = spawned?.member ?? null;
  const sessionId = member?.id ? String(member.id) : "";
  if (!sessionId) return { error: "创建成功但成员视图里没有 id，无法继续设置模型" };

  // ② 立刻中断：占位那一轮不该继续跑
  let interrupt = { previousStatus: "unknown" };
  let interruptError = "";
  try {
    interrupt = await teams.interrupt(caller, name);
  } catch (error) {
    // 中断失败不致命：成员可能刚好已经空闲（那就取不到 previousStatus）
    interruptError = String(error?.message ?? error);
  }

  // ②·5 等它真正空闲：否则紧接着的投递会撞上同一个取消信号（实测表现为「stopped before it finished」）
  const idleState = await waitUntilIdle(teams, caller, name, signal);
  log(ctx, `创建成员 ${name}：中断后等待空闲 → ${JSON.stringify(idleState)}`);

  // ③ 写 model/selection：与 set_member_model 完全同一条链路（默认不碰任何 @Remote）
  const switchResult = await switchAgentModel(ctx, sessionId, modelProvider, model, null);
  log(ctx, `创建成员 ${name}（${sessionId}）｜ 子代理provider=${subagentProvider} ｜ 中断=${JSON.stringify(interrupt)} ｜ 设模型 ${modelProvider}/${model}=${switchResult.error ? `失败 ${switchResult.error}` : "已写入"}`);

  if (switchResult.error) {
    // 模型没设上就不投递：否则真实任务会用默认模型跑掉，等于白跑
    return {
      ok: true,
      member,
      interrupt,
      switchResult,
      delivery: null,
      error: `模型未设置成功（${switchResult.error}），已放弃投递真实任务；修好后可用 set_member_model + send_to_session 补`,
    };
  }

  // ④ 投递真实任务：成员此时空闲，这条消息会唤醒它并用新模型执行
  let delivery = null;
  try {
    delivery = await teams.sendMessage(caller, {
      target: name,
      content: [{ type: "text", text: prompt }],
      signal,
    });
  } catch (error) {
    return {
      ok: true,
      member,
      interrupt,
      switchResult,
      delivery: null,
      error: `模型已设置，但投递真实任务失败：${String(error?.message ?? error)}`,
    };
  }

  return { ok: true, member, interrupt, idleState, switchResult, delivery, subagentProvider, ...(interruptError ? { interruptError } : {}) };
}

/**
 * 把 createTeammateWithModel 的结果渲染成给模型看的文本。
 * @param {{name:string, provider:string, model:string}} args
 * @param {object} result
 */
export function renderCreateTeammateResult(args, result) {
  if (!result?.ok) return `创建成员失败：${result?.error ?? "未知原因"}`;
  const member = result.member ?? {};
  const sessionId = String(member.id ?? "");
  const interrupt = result.interrupt ?? {};
  const switchResult = result.switchResult ?? {};
  const delivery = result.delivery ?? null;
  const lines = [
    `已创建成员 ${member.name ?? args?.name ?? "?"}（${sessionId}）`,
    `流程：占位任务创建（子代理 provider=${result.subagentProvider ?? "?"}）→ 中断（首轮状态 ${interrupt.previousStatus ?? "unknown"}）→ 等空闲（${result.idleState?.status ?? "unknown"}）→ 设模型 → 投递真实任务`,
    `模型：${args?.provider ?? "?"}/${args?.model ?? "?"}（${switchResult.via ?? "已写入 model/selection"}）`,
  ];
  if (delivery) {
    lines.push(`真实任务已投递：messageId=${delivery.messageId ?? "(无)"} —— 该成员会用上面的模型开始执行`);
  }
  if (result.interruptError) lines.push(`注：中断调用报错（${result.interruptError}），已按成员可能已空闲继续处理`);
  if (result.error) lines.push(`⚠️ ${result.error}`);
  lines.push("边界：占位那一轮确实发生过（只消耗一条极短提示）；要「创建前定模型」只能改宿主 agent-team。");
  return lines.join("\n");
}
