// dsh-session-conductor — 成员模型切换：resume 时的 setup 回调
//
// 【职责】会话 resume 时挂载 preset，并把已记录的切换意图补写成 `model/selection` 事件。

import { log } from "../../shared/log.js";
import { pluginDomain } from "../../core/domain.js";
import { foldLastModelSelection } from "../../sessions/route.js";
import { resolveSessionPreset } from "../inject/preset.js";

/**
 * resume 的 setup：挂载原 preset 组合；若插件记录了模型切换意图，则向会话追加
 * `model/selection` 事件，交给官方 selectionFor 投影接管。
 *
 * 【为什么不自己 installModelSelection】官方 session-controller 的 selectionFor 已经 install
 * 一个 selection（读投影 pending → 会话请求头 → 默认模型）；插件再 install 会形成两个
 * agent/request hook 竞争——表现为「切换当轮生效、下一轮回落」（request/header 序列出现
 * 新模型与默认模型交替）。因此插件只写事件/意图，模型选择完全交给官方机制。
 */
export async function resumeSetupFor(ctx, meta, events, route) {
  let presetId = null;
  try {
    const presets = ctx.get("agentPresets");
    if (presets) presetId = resolveSessionPreset({ header: meta, events });
  } catch {
    // 无 preset 服务或解析失败：不挂载 preset
  }
  let override = null;
  try {
    const domain = await pluginDomain(ctx);
    override = domain.global.get()?.memberModelOverrides?.[meta?.id] ?? null;
  } catch {
    override = null;
  }
  const lastSelection = foldLastModelSelection(events);
  const needApply = !!override
    && (!lastSelection || lastSelection.provider !== override.provider || lastSelection.model !== override.model);
  return async (agentCtx, agent) => {
    if (needApply) {
      try {
        // 追加切换意图事件：官方 selectionFor 读投影 pending → 本次 resume 后立即生效
        agent?.session?.append("model/selection", { provider: override.provider, model: override.model });
        log(ctx, `已应用成员模型切换意图 ${override.provider}/${override.model}（sessionId=${meta?.id}）`);
      } catch (error) {
        log(ctx, `应用模型切换意图失败: ${String(error?.message ?? error)}`);
      }
    }
    if (presetId) {
      try {
        await ctx.get("agentPresets").mount(agentCtx, presetId);
      } catch (error) {
        log(ctx, `preset mount 失败 ${presetId}: ${String(error?.message ?? error)}`);
      }
    }
  };
}
