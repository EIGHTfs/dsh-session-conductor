// dsh-session-conductor — 成员模型切换：override 持久化与内存镜像
//
// 【职责】保存「这个会话要用哪个模型」的 override：domain 持久化 + 内存 Map 镜像，
// 供 agent/request hook 每轮读取（避免每轮请求都 await 存储）。

import { pluginDomain } from "../../core/domain.js";

/**
 * 成员模型切换 override（sessionId → {provider, model}）。
 *
 * 【为什么需要它】官方模型选择链是「投影 pending → 会话请求头 → 部署默认」：
 * 写 `model/selection` 事件只让 pending 生效**一轮**，被 `request/header` 消费后，
 * 新回合会沿请求头链回落——而新回合的请求头本身又是按 `agentDefaultModel`（部署默认）
 * 发出的，于是切换最终回落成默认模型（request/header 序列会出现新模型与默认模型交替）。
 *
 * 因此本插件在 **`agent/request` 瀑布流**里按会话强制改写请求配置（官方模式二：
 * 只影响目标会话、不动全局默认值）——每轮都改，跨轮必然持久。
 *
 * 内存 Map 是 domain（memberModelOverrides）的镜像，避免每轮请求都 await 存储。
 */
const memberModelCache = new Map();
let memberModelCacheLoaded = false;

/**
 * 读某会话的成员模型 override（内存缓存优先；首次访问从 domain 加载一次）。
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 会话 id
 * @returns {Promise<{provider: string, model: string} | null>}
 */
export async function getMemberModelOverride(ctx, sessionId) {
  if (!sessionId) return null;
  if (!memberModelCacheLoaded) {
    try {
      const domain = await pluginDomain(ctx);
      const overrides = domain.global.get()?.memberModelOverrides ?? {};
      for (const [id, sel] of Object.entries(overrides)) {
        if (sel && typeof sel.provider === "string" && typeof sel.model === "string") {
          memberModelCache.set(id, { provider: sel.provider, model: sel.model });
        }
      }
      memberModelCacheLoaded = true;
    } catch {
      // domain 暂不可用：本次按「无 override」处理，下次访问再试
    }
  }
  return memberModelCache.get(sessionId) ?? null;
}

/** 写入一条 override（同时更新 domain 与内存镜像）。 */
export async function setMemberModelOverride(ctx, sessionId, provider, model) {
  const domain = await pluginDomain(ctx);
  const state = domain.global.get() ?? {};
  const overrides = { ...(state.memberModelOverrides ?? {}), [sessionId]: { provider, model } };
  await domain.global.set({ ...state, memberModelOverrides: overrides });
  memberModelCache.set(sessionId, { provider, model });
}

/**
 * 把成员模型 override 应用到一次请求配置上（`agent/request` hook 的核心逻辑，单独导出便于单测）。
 * 丢掉继承的 reasoningEffort：换模型后应回到目标模型自己的 provider 默认行为。
 * @param {object} resolved 下游解析出的 LlmCallConfig
 * @param {{provider: string, model: string} | null} override 目标选择（null = 不改）
 * @returns {object} 改写后的请求配置
 */
export function applyModelOverride(resolved, override) {
  if (!override) return resolved;
  if (resolved?.provider === override.provider && resolved?.model === override.model) return resolved;
  const { reasoningEffort: _inheritedEffort, ...rest } = resolved ?? {};
  return { ...rest, provider: override.provider, model: override.model };
}

/** 测试钩子：清空 override 缓存（单测在场景之间调用）。 */
export function resetMemberModelCacheForTest() {
  memberModelCache.clear();
  memberModelCacheLoaded = false;
}
