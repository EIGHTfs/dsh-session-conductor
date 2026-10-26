// dsh-session-conductor — 权限预设指令 `/perm-switch` 与 AI 工具 `set_member_permission`
//
// 【为什么需要指令】子代理会话在界面上无法手动切换权限预设（界面只对主会话开放），
// 而权限预设一旦指向当前不可用的值（典型：`auto` 在「自动审查」关闭后悬空），
// 该成员就永久唤不醒，且宿主只报一句 `subagent/not-resumable`，完全指不到权限层。
// 所以必须提供一条不经界面的入口：用户直接在聊天框切，AI 也能用工具切。
//
// 【三条形态】与 `/model-switch` 对齐：
//   · /perm-switch                        → 列出成员与各自权限预设（并标出 auto 悬空告警）
//   · /perm-switch <成员|sessionId>        → 查该成员的 preset / sandbox / approval
//   · /perm-switch <成员|sessionId> <预设>  → 切换（追加 permission/preset 事件）
//
// 【注册方式照宿主官方范例】ctx.commands.register({ definitionId, name, description, input, handler })，
// definitionId 用 @deepseek-ai/dsh-commands/brand 的 CommandDefinitionId() 包一层。
// 全程动态导入宿主包：工作区自测环境没有 @deepseek-ai/* 依赖，静态导入会在导入期
// ERR_MODULE_NOT_FOUND 并连累整个插件加载失败；拿不到就跳过注册并留痕。
import { log } from "../../shared/log.js";
import {
  describeMemberPermission,
  findTargetAgent,
  renderMemberPermissionList,
  readPresetCatalog,
  switchMemberPermission,
} from "./permission.js";
import { resolveTargets, isAllTarget } from "./locate.js";
import { readLeaderRoute } from "./lead.js";
import { applyPermissionToMany, renderBatchReport } from "./batch.js";

const COMMAND_NAME = "perm-switch";
const DEFINITION_ID = "@deepseek-ai/dsh-session-conductor/command-perm-switch";

/**
 * 指令处理入口（导出便于单测直接驱动，不必走宿主）。
 *
 * @param {object} ctx 插件 context
 * @param {{rawInput?: string, agent?: object}} invocation 宿主给的调用信息
 * @returns {Promise<{kind: "success"|"error", text: string}>} 交给聊天框渲染
 */
export async function handlePermSwitchCommand(ctx, invocation) {
  const raw = String(invocation?.rawInput ?? "").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const caller = invocation?.agent ?? null;
  try {
    // 无参：列成员与各自预设（与批量执行分开，避免「空参数」有两种含义）
    if (parts.length === 0) return { kind: "success", text: await renderMemberPermissionList(ctx, invocation) };

    const targetRaw = parts[0];
    if (parts.length === 1) {
      if (isAllTarget(targetRaw)) {
        return {
          kind: "error",
          text: `批量操作需要指定预设：\n  /${COMMAND_NAME} * <预设名>   ← 全部成员切到该预设\n  /${COMMAND_NAME} * auto        ← 全部成员跟随主代理（Lead）当前预设`,
        };
      }
      const found = findTargetAgent(ctx, targetRaw, { caller });
      if (found?.error) return { kind: "error", text: `找不到成员：${found.error}` };
      return { kind: "success", text: (await describeMemberPermission(found)).join("\n") };
    }

    // 二参：切换（单个或全部）
    let preset = parts[1];
    let followedLead = null;
    if (preset.toLowerCase() === "auto") {
      const lead = await readLeaderRoute(ctx, { caller });
      if (lead.error) return { kind: "error", text: `跟随主代理失败：${lead.error}` };
      if (!lead.preset) {
        return { kind: "error", text: `主代理（${lead.sessionId}）自己没有记录权限预设，无法跟随；请显式指定预设名` };
      }
      preset = lead.preset;
      followedLead = lead;
    }

    const resolved = resolveTargets(ctx, targetRaw, { caller });
    if (resolved?.error) return { kind: "error", text: `找不到成员：${resolved.error}` };

    // 单个目标：沿用原有回执（含旋钮与可选预设）
    if (!resolved.all && resolved.targets.length === 1) {
      const found = resolved.targets[0];
      const result = await switchMemberPermission(ctx, found.sessionId, preset);
      if (result.error) return { kind: "error", text: `切换失败：${result.error}` };
      const name = found.member?.name ? `${found.member.name}(${found.sessionId})` : found.sessionId;
      const lines = [`已把成员 ${name} 的权限预设切成 ${result.to}`, `原预设：${result.from ?? "(未记录)"} ｜ 新事件 seq：${result.seq}`];
      if (followedLead) lines.push(`预设来源：跟随主代理 ${followedLead.sessionId}`);
      if (result.note) lines.push(`说明：${result.note}`);
      lines.push(`当前旋钮：sandbox=${result.knobs?.sandbox ?? "(未记录)"} ｜ approval=${result.knobs?.approval ?? "(未记录)"}`);
      const catalog = await readPresetCatalog(ctx);
      if (!catalog.error) lines.push(`可选预设：${catalog.names.join(" / ")}`);
      lines.push("该改动写在会话日志里，成员下次加载/唤醒时按折叠语义生效。");
      return { kind: "success", text: lines.join("\n") };
    }

    // 全部目标：串行逐个切，回执带名单
    const report = await applyPermissionToMany(ctx, resolved.targets, preset);
    const extra = [];
    if (followedLead) {
      extra.push(`预设来源：跟随主代理 ${followedLead.sessionId}（${followedLead.preset}）`);
      for (const w of followedLead.warnings ?? []) extra.push(`提示：${w}`);
    }
    extra.push("批量切换逐条写入各成员会话日志；单个成员失败不影响其余成员。");
    return {
      kind: "success",
      text: renderBatchReport(`批量切换权限预设 → ${preset}`, report, extra),
    };
  } catch (error) {
    return { kind: "error", text: `执行失败：${String(error?.message ?? error)}` };
  }
}

/**
 * 注册 `/perm-switch` 指令。
 *
 * @returns {Promise<boolean>} true = 已注册；false = 宿主 commands 服务或 brand 包不可用（已留痕）
 */
export async function registerPermSwitchCommand(ctx) {
  const commands = ctx?.get?.("commands");
  if (!commands || typeof commands.register !== "function") {
    log(ctx, "权限指令未注册：ctx.commands 不可用（宿主未挂载 commands 服务）");
    return false;
  }
  let CommandDefinitionId = null;
  try {
    const mod = await import("@deepseek-ai/dsh-commands/brand");
    if (typeof mod?.CommandDefinitionId === "function") CommandDefinitionId = mod.CommandDefinitionId;
  } catch { /* 工作区自测环境没有宿主依赖 → 走下面的返回 false */ }
  if (!CommandDefinitionId) {
    log(ctx, "权限指令未注册：拿不到 @deepseek-ai/dsh-commands/brand 的 CommandDefinitionId（缺宿主依赖）");
    return false;
  }
  commands.register({
    definitionId: CommandDefinitionId(DEFINITION_ID),
    name: COMMAND_NAME,
    description: "查看或切换成员（子代理）的权限预设；无参 = 列出成员与各自预设",
    input: { hint: "[<成员名|sessionId> [<预设名>]]" },
    recordInput: false,
    handler: (invocation) => handlePermSwitchCommand(ctx, invocation),
  });
  return true;
}
