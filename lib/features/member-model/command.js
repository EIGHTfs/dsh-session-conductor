// dsh-session-conductor — 成员模型切换：聊天框指令 `/model-switch`
//
// 【这个文件解决什么】把「看/切成员（子代理）模型」搬到**用户聊天框**里：原来只有 AI 工具
//   和程序内函数两条路，用户自己想在输入框切一个成员得绕道求 AI。指令做成三条形态：
//     · `/model-switch`                      → 列成员与各自模型（含本插件记录的 override）
//     · `/model-switch <成员>`                → 查这个成员**实际**在用哪个模型（读请求级权威记录）
//     · `/model-switch <成员> <provider>/<模型>` → 切换，并回显查证快照（最近一次实际请求 + 判定）
//
// 【宿主的指令 API（照官方范例 @deepseek-ai/dsh-command-goal 抄，不是猜）】
//   · 注册：`ctx.commands.register({ definitionId, name, description, input, handler })`
//     definitionId 需用 `@deepseek-ai/dsh-commands/brand` 的 `CommandDefinitionId()` 包一层；
//   · 取参：handler 收到 invocation，文本从 `invocation.rawInput`（命令后的原文）取，
//     发起会话从 `invocation.agent` 取；
//   · 回显：handler 返回 `{ kind: "success" | "error", text }`，由聊天框渲染。
//
// 【为什么全程动态导入宿主包】工作区自测环境没有 @deepseek-ai/* 依赖；静态导入会在**导入期**
//   就抛 ERR_MODULE_NOT_FOUND，连累整个插件加载失败（本项目在 defineTool / createUserMessage
//   上踩过同类坑）。因此拿不到宿主能力时**跳过注册并如实留痕**，绝不影响插件其它功能。
import { log } from "../../shared/log.js";
import { findTargetAgent, collectTeamMembers, resolveTargets, isAllTarget } from "./locate.js";
import { readLeaderRoute } from "./lead.js";
import { applyModelToMany, renderBatchReport } from "./batch.js";
import { getMemberModelOverride } from "./override.js";
import { readLastRequestModel, registerSwitchWatch, switchAgentModel, peekLastRequestModel } from "./switch.js";

const COMMAND_NAME = "model-switch";
const DEFINITION_ID = "@deepseek-ai/dsh-session-conductor/command-model-switch";

/** 把 `provider/model` 拆开（只按**第一个**斜杠切，模型 id 自身可能含斜杠/冒号）。 */
function splitPair(text) {
  const raw = String(text ?? "").trim();
  const at = raw.indexOf("/");
  if (at <= 0) return { error: "模型要写成 <provider>/<model>（例：n/deepseek-v4.1-flash）" };
  const provider = raw.slice(0, at).trim();
  const model = raw.slice(at + 1).trim();
  if (!provider || !model) return { error: "provider 与 model 都不能为空（例：n/deepseek-v4.1-flash）" };
  return { provider, model };
}

/** 成员标签（有名字就带上，便于人读）。 */
function memberLabel(found) {
  const name = found?.member?.name;
  return name ? `${name}(${found.sessionId})` : String(found?.sessionId ?? "?");
}

/** 无参：列成员与各自模型（**便宜来源**：本插件 override → 进程内最近一次请求 → 名册记录值）。 */
async function renderMemberList(ctx, invocation) {
  const members = collectTeamMembers(ctx, { caller: invocation?.agent ?? null });
  if (members.length === 0) {
    return "没读到任何成员。可能当前不是 Team 成员、名册不可用，或确实还没有队友。";
  }
  const lines = [`成员模型（共 ${members.length} 个）`, ""];
  for (const m of members) lines.push(await describeMemberLine(ctx, m));
  lines.push("");
  lines.push("要查**实际**在用什么（含历史请求，不只本次进程）或切换：");
  lines.push(`  /${COMMAND_NAME} <成员名或 sessionId>              ← 查实际模型`);
  lines.push(`  /${COMMAND_NAME} <成员名或 sessionId> <provider>/<模型>  ← 切换并回显查证`);
  lines.push("");
  lines.push("和别人对齐 / 批量：");
  lines.push(`  /${COMMAND_NAME} * auto   ← 最常用：所有子代理都换成「我自己现在用的」模型`);
  lines.push(`  /${COMMAND_NAME} <成员名> auto   ← 只让这一个成员换成我自己现在用的模型`);
  lines.push(`  /${COMMAND_NAME} * <provider>/<模型>   ← 所有子代理换成一个指定的模型`);
  lines.push("");
  lines.push("* = 全部成员（不含我自己）；auto = 「跟我保持一致」，不用去查我用的是哪个模型。");
  return lines.join("\n");
}

/**
 * 把三个来源整理成展示片段：本插件 override → 进程内最近请求 → 名册记录值。
 * 都没有时如实说「未知」，并提示用「一参」形态查实际模型。
 */
function formatModelSources(override, live, record) {
  const shown = [];
  if (override) shown.push(`目标=${override.provider}/${override.model}`);
  if (live) shown.push(`最近请求=${live.provider}/${live.model}`);
  if (shown.length === 0 && record) shown.push(`名册记录=${record}`);
  if (shown.length === 0) shown.push("未知（用下一条查实际模型）");
  return shown.join(" ｜ ");
}

/**
 * 单个成员的一行摘要：本插件 override → 进程内最近一次请求 → 名册记录值（都不读日志，瞬时）。
 * 三者都拿不到时如实说「未知」，并提示用「一参」形态查实际模型。
 */
async function describeMemberLine(ctx, member) {
  let override = null;
  try {
    override = await getMemberModelOverride(ctx, member.id);
  } catch {
    // domain 暂不可用：按「无 override」显示，不阻断列表
  }
  const live = peekLastRequestModel(member.id); // 进程内最近一次请求：不读日志，瞬时
  const record = member.provider && member.model ? `${member.provider}/${member.model}` : null;
  const shownText = formatModelSources(override, live, record);
  const drift = Boolean(live && override && (live.provider !== override.provider || live.model !== override.model));
  const flag = drift ? "  ⚠️ 与目标不一致（下一回合生效前属正常）" : "";
  return `· ${member.name ?? "(无名)"}(${member.id}) — ${shownText}${flag}`;
}

/** 一参：查该成员**实际**在用哪个模型（优先读日志里的 request/header = 请求级权威记录）。 */
async function renderMemberDetail(found) {
  const { lastRequest, lastSelection } = await readLastRequestModel(found.sessionId);
  // 日志里还没有记录时回退到「本次进程内观察到的最近请求」——比直接说「没有」有用得多
  // （例如成员本进程刚跑过一轮，只是日志还没落盘/被截断）。
  const live = peekLastRequestModel(found.sessionId);
  const actual = lastRequest
    ? `${lastRequest.provider}/${lastRequest.model}`
      + (lastRequest.time ? `（${new Date(lastRequest.time).toLocaleString("zh-CN")}）` : "")
    : live
      ? `${live.provider}/${live.model}（本次进程内观察到；日志里还没有 request/header 记录）`
      : "日志里还没有 request/header（该成员可能从未发起过请求）";
  const lines = [`成员 ${memberLabel(found)}`, "", `实际请求使用：${actual}`];
  if (lastSelection) lines.push(`最近切换意图：${lastSelection.provider}/${lastSelection.model}`);
  lines.push("");
  lines.push(`切换：/${COMMAND_NAME} ${found.member?.name ?? found.sessionId} <provider>/<模型>`);
  return lines.join("\n");
}

/**
 * 二参：切换 + 回显查证快照（与 AI 工具 `set_member_model` 同一套落点：
 * 写 override / 事件、登记查证任务、按请求级记录给判定）。
 */
async function switchMember(ctx, found, provider, model, invocation, override = false) {
  const result = await switchAgentModel(ctx, found.sessionId, provider, model, found.agent, { override });
  if (result.error) return { kind: "error", text: `切换失败：${result.error}` };
  // 登记查证任务：该成员下次发起请求时由 agent/request 事件判定，结果会注入发起方
  try {
    registerSwitchWatch(found.sessionId, provider, model, invocation?.agent?.session?.id ?? null);
  } catch (error) {
    log(ctx, `模型指令：登记查证失败（不影响切换）: ${String(error?.message ?? error)}`);
  }
  const lines = [`已把成员 ${memberLabel(found)} 切到 ${provider}/${model}`, `生效方式：${result.via}`];
  try {
    const { lastRequest, lastSelection } = await readLastRequestModel(found.sessionId);
    if (lastRequest) {
      const same = lastRequest.provider === provider && lastRequest.model === model;
      lines.push(`最近一次实际请求：${lastRequest.provider}/${lastRequest.model}`
        + (lastRequest.time ? `（${new Date(lastRequest.time).toLocaleString("zh-CN")}）` : ""));
      lines.push(same
        ? "判定：✅ 该成员最近的请求已经是新模型"
        : "判定：⏳ 待下一回合生效（最近一次请求是切换前发出的，属正常）");
    } else {
      lines.push("判定：⏳ 该成员还没发起过请求，待首次运行后生效");
    }
    if (lastSelection) lines.push(`最近一次切换意图：${lastSelection.provider}/${lastSelection.model}`);
  } catch (error) {
    lines.push(`查证快照读取失败：${String(error?.message ?? error)}`);
  }
  lines.push("确认结果会在该成员下次发起请求时注入回发起方（事件驱动，不阻塞）。");
  return { kind: "success", text: lines.join("\n") };
}

/**
 * 指令处理入口（导出便于单测直接驱动，不必走宿主）。
 *
 * @param {object} ctx 插件 context
 * @param {{rawInput?: string, agent?: object}} invocation 宿主给的调用信息
 * @returns {Promise<{kind: "success"|"error", text: string}>} 交给聊天框渲染
 */
export async function handleModelSwitchCommand(ctx, invocation) {
  const raw = String(invocation?.rawInput ?? "").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const caller = invocation?.agent ?? null;
  try {
    // 无参：列成员（保留原行为——列表和批量执行不能共用同一种输入，否则语义含糊）
    if (parts.length === 0) return { kind: "success", text: await renderMemberList(ctx, invocation) };

    const targetRaw = parts[0];
    // 单参：查成员实际模型（`*` 没有「查」的意义，直接提示正确用法）
    if (parts.length === 1) {
      if (isAllTarget(targetRaw)) {
        return {
          kind: "error",
          text: `批量操作需要指定模型：\n  /${COMMAND_NAME} * auto   ← 所有子代理换成我自己现在用的模型（最常用）\n  /${COMMAND_NAME} * <provider>/<模型>   ← 所有子代理换成指定模型`,
        };
      }
      const found = findTargetAgent(ctx, targetRaw, { caller });
      if (found?.error) return { kind: "error", text: `找不到成员：${found.error}` };
      return { kind: "success", text: await renderMemberDetail(found) };
    }

    // 二/三参：切换（单个或全部）。可选尾参 `override` = 旧行为（额外写每轮强制改写的
    // override）；默认不写 —— 官方 model/selection 链路当轮生效且持久，不压 UI 的选择。
    const wantOverride = parts.some((x) => x.toLowerCase() === "override");
    const routeRaw = parts[1];
    let provider;
    let model;
    let followedLead = null;
    if (routeRaw.toLowerCase() === "auto") {
      // auto = 跟随主代理（Lead）：从请求级记录读它当前真实使用的模型
      const lead = await readLeaderRoute(ctx, { caller });
      if (lead.error) return { kind: "error", text: `跟随主代理失败：${lead.error}` };
      provider = lead.provider;
      model = lead.model;
      followedLead = lead;
    } else {
      const pair = splitPair(routeRaw);
      if (pair.error) return { kind: "error", text: pair.error };
      provider = pair.provider;
      model = pair.model;
    }

    const resolved = resolveTargets(ctx, targetRaw, { caller });
    if (resolved?.error) return { kind: "error", text: `找不到成员：${resolved.error}` };

    // 单个目标：沿用原有路径（带查证快照与查证任务登记）
    if (!resolved.all && resolved.targets.length === 1) {
      return await switchMember(ctx, resolved.targets[0], provider, model, invocation, wantOverride);
    }

    // 全部目标：串行逐个切，回执必须带完整名单
    const report = await applyModelToMany(ctx, resolved.targets, { provider, model, override: wantOverride });
    const extra = [];
    if (followedLead) {
      extra.push(`模型来源：跟随主代理 ${followedLead.sessionId}（${followedLead.modelSource}）`);
      for (const w of followedLead.warnings ?? []) extra.push(`提示：${w}`);
    }
    extra.push("批量切换逐条写入各成员会话日志；单个成员失败不影响其余成员。");
    return {
      kind: "success",
      text: renderBatchReport(`批量切换模型 → ${provider}/${model}`, report, extra),
    };
  } catch (error) {
    return { kind: "error", text: `执行失败：${String(error?.message ?? error)}` };
  }
}

/**
 * 注册 `/model-switch` 指令。
 *
 * @returns {Promise<boolean>} true = 已注册；false = 宿主 commands 服务或 brand 包不可用（已留痕）
 */
export async function registerModelSwitchCommand(ctx) {
  const commands = ctx?.get?.("commands");
  if (!commands || typeof commands.register !== "function") {
    log(ctx, `模型指令未注册：ctx.commands 不可用（宿主未挂载 commands 服务）`);
    return false;
  }
  let CommandDefinitionId = null;
  try {
    const mod = await import("@deepseek-ai/dsh-commands/brand");
    if (typeof mod?.CommandDefinitionId === "function") CommandDefinitionId = mod.CommandDefinitionId;
  } catch { /* 工作区自测环境没有宿主依赖 → 走下面的返回 false */ }
  if (!CommandDefinitionId) {
    log(ctx, `模型指令未注册：拿不到 @deepseek-ai/dsh-commands/brand 的 CommandDefinitionId（缺宿主依赖）`);
    return false;
  }
  commands.register({
    definitionId: CommandDefinitionId(DEFINITION_ID),
    name: COMMAND_NAME,
    description: "查看或切换成员（子代理）的模型，并回显查证结果；无参 = 列出成员与各自模型",
    input: { hint: "[<成员名|sessionId> [provider]/[model]]" },
    recordInput: false,
    handler: (invocation) => handleModelSwitchCommand(ctx, invocation),
  });
  return true;
}
