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
import { findTargetAgent, pickTeamCaller } from "./locate.js";
import { getMemberModelOverride } from "./override.js";
import { readLastRequestModel, registerSwitchWatch, switchAgentModel } from "./switch.js";

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

/**
 * 名册：Team 成员（spawn_teammate 创建的队友，不在普通 agents 列表里）+ 普通 agents。
 * 两条来源都取不到时返回空数组（调用方据此给出可读提示）。
 */
function collectMembers(ctx) {
  const out = [];
  const seen = new Set();
  const push = (id, name, extra = {}) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: name ?? null, ...extra });
  };
  try {
    const teams = ctx?.get?.("agentTeams");
    const caller = pickTeamCaller(ctx);
    if (teams?.listMembers && caller) {
      for (const m of teams.listMembers(caller) ?? []) push(m?.id ?? m?.sessionId, m?.name, { provider: m?.provider, model: m?.model, source: "名册" });
    }
  } catch (error) {
    log(ctx, `模型指令：读 Team 名册失败（跳过该来源）: ${String(error?.message ?? error)}`);
  }
  try {
    const agents = ctx?.get?.("agents");
    for (const a of agents?.list?.() ?? []) push(a?.session?.id ?? a?.id, a?.session?.title ?? null, { source: "agent" });
  } catch (error) {
    log(ctx, `模型指令：读 agents 列表失败（跳过该来源）: ${String(error?.message ?? error)}`);
  }
  return out;
}

/** 无参：列成员与各自模型（cheap 来源：本插件 override + 名册记录值，不做逐会话日志扫描）。 */
async function renderMemberList(ctx) {
  const members = collectMembers(ctx);
  if (members.length === 0) {
    return "没读到任何成员。可能当前会话不是 Team 成员、名册不可用，或确实还没有队友。";
  }
  const lines = [`成员模型（共 ${members.length} 个）`, ""];
  for (const m of members) {
    let override = null;
    try { override = await getMemberModelOverride(ctx, m.id); } catch { /* domain 暂不可用：按无 override 显示 */ }
    const record = m.provider && m.model ? `${m.provider}/${m.model}` : "未知";
    const mark = override ? `override=${override.provider}/${override.model}` : `记录值=${record}`;
    lines.push(`· ${m.name ?? "(无名)"}(${m.id}) — ${mark}`);
  }
  lines.push("");
  lines.push("要看**实际**在用什么（而非记录值）或切换：");
  lines.push(`  /${COMMAND_NAME} <成员名>              ← 查实际模型`);
  lines.push(`  /${COMMAND_NAME} <成员名> <provider>/<模型>  ← 切换并回显查证`);
  return lines.join("\n");
}

/** 一参：查该成员**实际**在用哪个模型（读日志里的 request/header = 请求级权威记录）。 */
async function renderMemberDetail(found) {
  const { lastRequest, lastSelection } = await readLastRequestModel(found.sessionId);
  const actual = lastRequest
    ? `${lastRequest.provider}/${lastRequest.model}`
      + (lastRequest.time ? `（${new Date(lastRequest.time).toLocaleString("zh-CN")}）` : "")
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
async function switchMember(ctx, found, provider, model, invocation) {
  const result = await switchAgentModel(ctx, found.sessionId, provider, model, found.agent);
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
  try {
    if (parts.length === 0) return { kind: "success", text: await renderMemberList(ctx) };
    const found = findTargetAgent(ctx, parts[0]);
    if (found?.error) return { kind: "error", text: `找不到成员：${found.error}` };
    if (parts.length === 1) return { kind: "success", text: await renderMemberDetail(found) };
    const pair = splitPair(parts[1]);
    if (pair.error) return { kind: "error", text: pair.error };
    return await switchMember(ctx, found, pair.provider, pair.model, invocation);
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
