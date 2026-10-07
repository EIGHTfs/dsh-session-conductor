// dsh-session-conductor — 会话 preset 解析（模板注入域的只读解析器）
//
// 【为什么单独成文件】preset 解析被续跑 setup 与成员 resume 共用；
// 先于模板注入主体抽出，避免其它域反向依赖插件入口。

/**
 * 解析会话当前使用的 agent preset：
 * 读 header.agentPreset，再被后续 agent-preset/selected 事件覆盖（与 agentPreset projection 一致）。
 * @param {{header?: object, events?: Array}} source 会话 header 与事件流
 * @returns {string|null} preset id，无则 null
 */
export function resolveSessionPreset({ header, events } = {}) {
  let presetId = header?.agentPreset ?? null;
  for (const event of events ?? []) {
    if (event?.type === "agent-preset/selected" && event.data?.agentPreset != null) {
      presetId = event.data.agentPreset;
    }
  }
  return presetId;
}
