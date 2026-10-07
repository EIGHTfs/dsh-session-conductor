// dsh-session-conductor — 从会话事件流折叠「模型路由」
//
// 【为什么单独成文件】foldLastRoute / foldLastModelSelection 是只读折叠函数，
// 被续跑、成员模型切换、重命名等多个域共用；无外部依赖，放在 sessions 域最底层。

/** 折叠会话最近一次 request/header 的模型路由（provider/model），无则 null。 */
export function foldLastRoute(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "request/header") {
      const config = event.data?.header?.config;
      if (config && typeof config.provider === "string" && typeof config.model === "string") {
        return { provider: config.provider, model: config.model };
      }
    }
    if (event?.type === "request/context") {
      const eventData = event.data;
      if (eventData && typeof eventData.provider === "string" && typeof eventData.model === "string") {
        return { provider: eventData.provider, model: eventData.model };
      }
    }
  }
  return null;
}

/**
 * 默认模型选择（无会话路由时兜底）：读部署默认模型，读不到返回 null。
 * @param {object} ctx 插件上下文
 * @returns {{provider: string, model: string} | null}
 */
export function defaultModelSelection(ctx) {
  try {
    const current = ctx.get("agentDefaultModel")?.currentSelection?.();
    if (current?.provider && current.model) return { provider: current.provider, model: current.model };
  } catch {
    // 服务缺失时返回 null
  }
  return null;
}

/**
 * 折叠会话里最后一次 `model/selection` 事件（切模型意图——官方 selectForNextRequest 也写这个事件）。
 * 【为什么】resume 时若只用「最后请求头」当选择，会把切换覆盖回原模型
 * （表现为「切了只生效一个回合」）；优先用该事件可与官方 selectionFor 的投影恢复保持一致。
 * @returns {{provider: string, model: string} | null}
 */
export function foldLastModelSelection(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "model/selection") {
      const eventData = event.data;
      if (eventData && typeof eventData.provider === "string" && typeof eventData.model === "string") {
        return { provider: eventData.provider, model: eventData.model };
      }
    }
  }
  return null;
}
