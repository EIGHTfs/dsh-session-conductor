// dsh-session-conductor — 成员模型/权限相关的 AI 工具与聊天指令注册
//
// 【为什么单独成文件】原先这 293 行全部内联在 lib/apply.js 的 `ctx.inject(["tools"])` 回调里，
// 使该回调变成一个巨型函数（审计 readability/max-function-length 拦截），
// 而它内部其实只有两类内容：① 5 个工具的注册（list_models / set_member_model /
// list_permission_presets / set_member_permission / create_teammate_with_model）
// ② 两条聊天指令的注册（/model-switch、/perm-switch）。两者都属于「成员模型/权限」这一域，
// 整体搬出来即可，handler 体与错误隔离策略逐字保留。
//
// 【错误隔离约定（必须保留）】每个工具单独包 try/catch：defineTool 抛错会让整个
// inject 回调中止，历史上因此导致四个工具一起消失（宿主侧表现为「tool 不存在」）。
import { log } from "../../shared/log.js";
import { findTargetAgent, resolveTargets, validateModelPair } from "./locate.js";
import { switchAgentModel, registerSwitchWatch, readLastRequestModel } from "./switch.js";
import { createTeammateWithModel, renderCreateTeammateResult } from "./create-teammate.js";
import { switchMemberPermission, describeMemberPermission, readPresetCatalog } from "./permission.js";
import { readLeaderRoute } from "./lead.js";
import { applyModelToMany, applyPermissionToMany, renderBatchReport } from "./batch.js";
import { registerModelSwitchCommand } from "./command.js";
import { registerContextUsageTool } from "../context-usage/index.js";
import { registerMemoryRecallTool } from "../memory-recall/index.js";
import { registerSessionMessagingTools } from "../session-messaging/index.js";
import { registerPermSwitchCommand } from "./permission-command.js";

/**
 * 注册成员模型/权限相关的全部 AI 工具与聊天指令。
 *
 * @param {object} deps
 * @param {object} deps.ctx 插件 context
 * @param {object} deps.tools 宿主 tools 服务（提供 register）
 * @param {Function} deps.defineTool 宿主 defineTool（工作区自测环境可能为 undefined，调用方已判空）
 * @returns {void}
 */
export function registerMemberModelTools({ ctx, tools, defineTool }) {
    tools.register(defineTool({
      name: "list_models",
      description: "列出当前可用模型（provider → models[]）。切模型前先用它拿到确切 model id，不要凭记忆猜模型名。",
      parameters: {},
      output: {
        schema: { type: "string" },
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute() {
        try {
          const sc = ctx.get("sessionController");
          if (!sc?.modelCatalog) return "modelCatalog 服务不可用（无法列出模型）";
          const catalog = await sc.modelCatalog();
          const groups = catalog?.groups ?? [];
          if (groups.length === 0) return "模型目录为空（检查 provider 配置）";
          return groups.map((g) => {
            const models = (g.models ?? [])
              .map((m) => `  - ${m.id}${m.name && m.name !== m.id ? `（${m.name}）` : ""}`)
              .join("\n");
            return `${g.id}${g.name && g.name !== g.id ? `（${g.name}）` : ""}:\n${models}`;
          }).join("\n\n");
        } catch (error) {
          return `列出模型失败：${String(error?.message ?? error)}`;
        }
      }
    }));
/**
 * 切换后的「查证快照」：最近一次实际请求 + 最近一次切换意图 + 一行判定。
 * 抽出来是因为这段有 4 个分支，塞在工具 execute 里把圈复杂度顶到 18；
 * 判定只认「请求时真实使用的模型」（request/header），不信注入的提示语。
 * @returns {Promise<{snap: string, verdict: string}>}
 */
async function describeSwitchSnapshot(ctx, sessionId, provider, model) {
  const startedAt = Date.now();
  const { lastRequest, lastSelection, scanned } = await readLastRequestModel(sessionId);
  // 读整份日志取「最近一次请求」，大日志上这一步本身就要时间
  log(ctx, `切换查证快照耗时 ${Date.now() - startedAt}ms（命中请求记录 ${scanned ?? 0} 条）`);
  if (!lastRequest) {
    return {
      snap: "【查证·最近一次实际请求】会话日志里还没有 request/header 记录（该成员可能从未运行过）",
      verdict: "【查证·判定】⏳ 待该成员首次运行后生效",
    };
  }
  const when = lastRequest.time ? `（${new Date(lastRequest.time).toLocaleString("zh-CN")}）` : "";
  const snap = `【查证·最近一次实际请求】${lastRequest.provider}/${lastRequest.model}${when}`
    + (lastSelection ? `\n【查证·最近一次切换意图】${lastSelection.provider}/${lastSelection.model}` : "");
  const alreadyNew = lastRequest.provider === provider && lastRequest.model === model;
  return {
    snap,
    verdict: alreadyNew
      ? "【查证·判定】✅ 该成员最近的请求已经是新模型"
      : "【查证·判定】⏳ 待下一回合生效：最近一次请求是切换前发出的（属正常，不代表失败）",
  };
}

    tools.register(defineTool({
      name: "set_member_model",
      description: "给成员/子代理切换模型。三个参数都可空：target 留空 = 作用于全部成员（慎用，会改所有子代理）；provider/model 留空 = 跟随主代理（Team Lead）当前实际使用的模型。target 传成员名/sessionId/标题关键字。切换前会校验 provider/model 组合是否存在。批量时逐条执行、回执带完整名单。",
      parameters: {
        target: { type: "string", description: "目标成员：成员名、sessionId 或标题关键字。留空 = 全部成员（排除 Lead）" },
        provider: { type: "string", description: "provider 分组名（list_models 的顶层分组）。留空 = 跟随主代理的 provider" },
        model: { type: "string", description: "该 provider 下的模型 id（含前缀）。留空 = 跟随主代理的 model" }
      },
      output: {
        schema: { type: "string" },
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute(args, exec) {
        const caller = exec?.agent ?? null;
        let provider = String(args?.provider ?? "").trim();
        let model = String(args?.model ?? "").trim();
        // provider/model 留空 = 跟随主代理（Team Lead）当前实际使用的模型。
        // 取值只认「请求级权威记录」，读不到就如实报错，绝不用名册里的静态字段冒充。
        let followedLead = null;
        if (!provider || !model) {
          const lead = await readLeaderRoute(ctx, { caller });
          if (lead.error) return `切换失败：${lead.error}`;
          provider = lead.provider;
          model = lead.model;
          followedLead = lead;
        }
        // 先校验组合有效性——无效组合会让后续回合的模型请求被拒（表现为「切换生效但回合失败」）
        const pair = await validateModelPair(ctx, provider, model);
        if (pair.error) return `切换失败：${pair.error}`;
        // target 留空 = 作用于全部成员；与聊天指令 /model-switch 走同一套目标解析
        const resolved = resolveTargets(ctx, args?.target, { caller });
        if (resolved.error) return `切换失败：${resolved.error}`;
        if (resolved.all) {
          const report = await applyModelToMany(ctx, resolved.targets, { provider, model });
          const extra = [];
          if (followedLead) {
            extra.push(`模型来源：跟随主代理 ${followedLead.sessionId}（${followedLead.modelSource}）`);
            for (const w of followedLead.warnings ?? []) extra.push(`提示：${w}`);
          }
          if (pair.note) extra.push(`【校验】${pair.note}`);
          return renderBatchReport(`批量切换模型 → ${provider}/${model}`, report, extra);
        }
        const found = resolved.targets[0];
        const switchResult = await switchAgentModel(ctx, found.sessionId, provider, model, found.agent);
        if (switchResult.error) return `切换失败：${switchResult.error}`;
        const memberLabel = found.member?.name ? `${found.member.name}(${found.sessionId})` : found.sessionId;
        // 查证（注册 job，不阻塞）：登记待查证项 → 该成员下次发起请求时由 agent/request 事件判定
        // → 结果注入回本次调用方。同时立刻附一份快照：最近一次实际请求 + 最近一次切换意图。
        // 判定只认「请求时真实使用的模型」（request/header），不信注入的提示语。
        try {
          registerSwitchWatch(found.sessionId, provider, model, exec?.agent?.session?.id ?? null);
        } catch (error) {
          log(ctx, `切换查证登记失败（不影响本次切换）: ${String(error?.message ?? error)}`);
        }
        let snap = "";
        let verdict = "";
        try {
          ({ snap, verdict } = await describeSwitchSnapshot(ctx, found.sessionId, provider, model));
        } catch (error) {
          snap = `【查证·快照】读取会话日志失败：${String(error?.message ?? error)}`;
        }
        // 复核命令按**当前插件安装位置**生成（不写死本机路径），可直接复制执行
        const scriptUrl = new URL("../scripts/check-member-model.mjs", import.meta.url);
        const cmd = `node ${decodeURIComponent(scriptUrl.pathname)} ${found.sessionId}`;
        return [
          `已把成员 ${memberLabel}（${found.matched} 匹配）切到 ${provider}/${model}；生效方式：${switchResult.via}`,
          // 组合校验默认关闭（避免 @Remote 卡顿）；跳过时如实告知，别让人以为「拼错也会被拦住」
          pair.note ? `【校验】${pair.note}` : "",
          snap,
          verdict,
          "【查证·任务】已登记（不阻塞）：该成员下次发起请求时按事件判定，结果会在下一次 step 注入给你",
          `复核命令（可直接复制）：\n${cmd}`,
        ].filter(Boolean).join("\n");
      }
    }));
    // 列出宿主当前可选的权限预设。存在的意义是让 set_member_permission 的 preset 参数
    // 有可查来源，避免凭记忆猜名字（不可用的预设名写进会话会让成员加载失败）。
    try {
      tools.register(defineTool({
        name: "list_permission_presets",
        description: "列出宿主当前可选的权限预设（permission preset）名称与默认值。给成员切换权限前先用它确认确切名字。",
        parameters: {},
        output: {
          schema: { type: "string" },
          render(args, value) {
            return [{ type: "text", text: String(value) }];
          }
        },
        async execute() {
          const catalog = await readPresetCatalog(ctx);
          if (catalog.error) return `读取失败：${catalog.error}`;
          const lines = [`可选权限预设（共 ${catalog.names.length} 个）`, ""];
          for (const name of catalog.names) lines.push(`  - ${name}`);
          if (catalog.defaultPreset) lines.push("", `新会话默认预设：${catalog.defaultPreset}`);
          if (catalog.names.includes("auto")) {
            lines.push("", "注意：auto 依赖「自动审查」集成；该功能一旦关闭，带 auto 的会话会无法恢复（宿主报 subagent/not-resumable）。");
          }
          return lines.join("\n");
        }
      }));
    } catch (error) {
      log(ctx, `list_permission_presets 工具注册失败（不影响其它工具）: ${String(error?.message ?? error)}`);
    }
    // 查看/切换成员（子代理）的权限预设。
    // 子代理会话在界面上无法手动切权限预设（界面只对主会话开放），而 preset 一旦指向
    // 当前不可用的值（典型：auto 在「自动审查」关闭后悬空），该成员就永久唤不醒——
    // 宿主 permission-presets 在会话发布前抛错，再被 subagent 的 coldResume 统一包成
    // `subagent/not-resumable`，报错文本完全指不到权限层。此工具提供不改界面的修正通道。
    // 与其它工具一致：render 必须放在 output 里；单独包 try/catch，避免一个工具抛错
    // 让整个 inject("tools") 中止（历史上四个工具一起消失过）。
    try {
      tools.register(defineTool({
        name: "set_member_permission",
        description: "给成员/子代理切换权限预设（写在该成员会话日志里，下次加载生效）。子代理无法在界面上手动切换权限预设，只能用这个工具。两个参数都可空：target 留空 = 作用于全部成员（慎用）；preset 留空 = 跟随主代理（Team Lead）当前预设。preset 必须在宿主当前可选列表里，可用 list_permission_presets 查。批量时逐条执行、回执带完整名单。",
        parameters: {
          target: { type: "string", description: "目标成员：成员名、sessionId 或标题关键字。留空 = 全部成员（排除 Lead）" },
          preset: { type: "string", description: "目标权限预设名（如 danger-full-access）。留空 = 跟随主代理的预设" }
        },
        output: {
          schema: { type: "string" },
          render(args, value) {
            return [{ type: "text", text: String(value) }];
          }
        },
        async execute(args, exec) {
          const caller = exec?.agent ?? null;
          let preset = String(args?.preset ?? "").trim();
          // preset 留空 = 跟随主代理（Team Lead）当前预设；主代理自己没记录预设时如实报错，
          // 不猜一个默认值塞进去（写错预设会让成员加载失败）。
          let followedLead = null;
          if (!preset) {
            const lead = await readLeaderRoute(ctx, { caller });
            if (lead.error) return `切换失败：${lead.error}`;
            if (!lead.preset) return `切换失败：主代理（${lead.sessionId}）没有记录权限预设，无法跟随；请显式指定 preset（可用 list_permission_presets 查）`;
            preset = lead.preset;
            followedLead = lead;
          }
          // target 留空 = 作用于全部成员
          const resolved = resolveTargets(ctx, args?.target, { caller });
          if (resolved.error) return `切换失败：${resolved.error}`;
          if (resolved.all) {
            const report = await applyPermissionToMany(ctx, resolved.targets, preset);
            const extra = [];
            if (followedLead) {
              extra.push(`预设来源：跟随主代理 ${followedLead.sessionId}（${followedLead.preset}）`);
              for (const w of followedLead.warnings ?? []) extra.push(`提示：${w}`);
            }
            return renderBatchReport(`批量切换权限预设 → ${preset}`, report, extra);
          }
          const found = resolved.targets[0];
          const label = found.member?.name ? `${found.member.name}(${found.sessionId})` : found.sessionId;
          const result = await switchMemberPermission(ctx, found.sessionId, preset);
          if (result.error) return `切换失败：${result.error}`;
          const lines = [
            `已把成员 ${label} 的权限预设切成 ${result.to}`,
            `原预设：${result.from ?? "(未记录)"} ｜ 新事件 seq：${result.seq}`,
          ];
          if (followedLead) lines.push(`预设来源：跟随主代理 ${followedLead.sessionId}`);
          if (result.note) lines.push(`说明：${result.note}`);
          lines.push(`当前旋钮：sandbox=${result.knobs?.sandbox ?? "(未记录)"} ｜ approval=${result.knobs?.approval ?? "(未记录)"}`);
          lines.push("改动写在会话日志里，成员下次加载/唤醒时按折叠语义生效（最后一条 preset 事件为准）。");
          return lines.join("\n");
        }
      }));
    } catch (error) {
      log(ctx, `set_member_permission 工具注册失败（不影响其它工具）: ${String(error?.message ?? error)}`);
    }
    // 创建成员并同时指定模型：宿主 spawn_teammate 没有 provider/model 参数，这里补齐。
    // 形状必须与其它工具一致（render 放在 output 里）；且单独包 try/catch——
    // 这个回调里任何一个 defineTool 抛错都会让整个 inject("tools") 中止，四个工具一起消失。
    try {
      tools.register(defineTool({
        name: "create_teammate_with_model",
        description: "创建团队成员，并让第一轮真实任务就用指定模型（宿主 spawn_teammate 没有 provider/model 参数，此工具补齐）。内部流程：占位任务创建 → 立刻中断（避免用默认模型把首轮跑掉）→ 写 model/selection → 投递真实任务。只能由 Team Lead 调用。",
        parameters: {
          name: { type: "string", required: true, description: "成员名（lower-kebab-case，唯一）" },
          description: { type: "string", required: true, description: "职责简述" },
          prompt: { type: "string", required: true, description: "该成员的初始任务全文" },
          provider: { type: "string", required: true, description: "模型 provider 分组名（agnes / wb / d …；先用 list_models 查确切值）" },
          model: { type: "string", required: true, description: "模型 id（先用 list_models 查确切值）" },
          subagentProvider: { type: "string", description: "子代理 provider（与模型 provider 不是一回事；默认取 ctx.subagents.list() 第一个，通常就是 spawn）。一般不用填" },
          context: { type: "string", description: "上下文来源：fresh（默认，不继承）或 fork（继承调用方已有回合）" },
        },
        output: {
          schema: { type: "string" },
          render(args, value) {
            return [{ type: "text", text: String(value) }];
          },
        },
        async execute(args, exec) {
          const result = await createTeammateWithModel(ctx, exec, args);
          return renderCreateTeammateResult(args, result);
        },
      }));
    } catch (error) {
      log(ctx, `create_teammate_with_model 注册失败（不影响其它工具）: ${String(error?.message ?? error)}`);
    }

    // 上下文用量自查工具：让 AI 自己按需查占用与构成，而不是每轮把数值注入系统提示词
    // （每轮注入会让系统提示词前缀每轮变化 → prompt cache 失效 → 成本上升）。
    if (registerContextUsageTool(ctx, defineTool, tools)) {
      log(ctx, "上下文用量工具已注册 (context_usage)");
    }
    // 跨会话消息 + 指定模型新建会话（三个工具一次注册）。
    // 整体包 try/catch：注册期抛错会连累同批其它工具（本项目历史事故），失败只留痕、不阻断。
    try {
      if (registerSessionMessagingTools(ctx, defineTool, tools)) {
        log(ctx, "跨会话工具已注册 (list_sessions / send_to_session / create_session)");
      }
    } catch (error) {
      log(ctx, `跨会话工具注册失败（不影响其它工具）: ${String(error?.message ?? error)}`);
    }
    try {
      // 记忆取回的手动通道：让 AI 自己按需回溯（自动注入之外的补充）
      if (registerMemoryRecallTool(ctx, defineTool, tools)) {
        log(ctx, "记忆取回工具已注册 (recall_memory)");
      }
    } catch (error) {
      log(ctx, `记忆取回工具注册失败（不影响其它工具）: ${String(error?.message ?? error)}`);
    }
    log(ctx, "成员模型工具已注册 (list_models / set_member_model)");
    // 聊天框指令 `/model-switch`：用户自己就能看/切成员模型的入口（与 AI 工具同一套切换 + 查证路径）。
    // 异步注册 + 独立兜底：宿主 commands 服务或 brand 包不可用时只留痕，绝不影响其它功能（同既有约定）。
    registerModelSwitchCommand(ctx)
      .then((ok) => { if (ok) log(ctx, "聊天框指令已注册 (/model-switch)"); })
      .catch((error) => log(ctx, `聊天框指令注册失败（不影响其它功能）: ${String(error?.message ?? error)}`));
    // 聊天框指令 `/perm-switch`：子代理在界面上切不了权限预设，只能靠这条写会话日志的通道。
    registerPermSwitchCommand(ctx)
      .then((ok) => { if (ok) log(ctx, "聊天框指令已注册 (/perm-switch)"); })
      .catch((error) => log(ctx, `权限指令注册失败（不影响其它功能）: ${String(error?.message ?? error)}`));
}
