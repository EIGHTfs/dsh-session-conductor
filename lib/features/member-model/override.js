// dsh-session-conductor — 成员模型切换：override 持久化与内存镜像
//
// 【职责】保存「这个会话要用哪个模型」的 override：domain 持久化 + 内存 Map 镜像，
// 供 agent/request hook 每轮读取（避免每轮请求都 await 存储）。

// 【为什么懒加载】core/domain.js 静态依赖宿主包 @deepseek-ai/dsh-storage-domain；
// 工作区单测没有宿主依赖，静态 import 会让**整个本域**在导入时就 ERR_MODULE_NOT_FOUND
// （实测：查证单测只想要纯逻辑，却被这条链挡住）。改成首次真正读写 domain 时才解析。
let domainModPromise = null;
async function loadPluginDomain(ctx) {
  if (!domainModPromise) domainModPromise = import("../../core/domain.js");
  const mod = await domainModPromise;
  return mod.pluginDomain(ctx);
}

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
      const domain = await loadPluginDomain(ctx);
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
  const domain = await loadPluginDomain(ctx);
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

/**
 * 判断是否要把「官方界面刚选的模型」同步进 override。
 *
 * 【为什么需要它】本插件的 override 是**每轮强制改写请求**的持久状态，优先级高于官方链路。
 * 于是有个致命副作用：一旦写入，用户在主会话界面用官方模型选择器切换**完全无效** ——
 * 界面显示新模型、实际请求走 override 里的旧模型，而且不报错、不提示、无清除入口
 * （实测事故：批量「跟随主代理」把一批会话钉在某个已失效 provider 上，界面怎么切都不动，
 *   改会话日志、重启宿主也都没用，因为 override 存在 domain 里且每轮覆盖）。
 *
 * 【做法：同步，而不是清除】官方切换会往 `modelSelection` 投影写 `pending`；
 * 而插件在 hook 里用 override 改写了请求配置 → 与 pending 不匹配 → `consumeSelection` 不会
 * 清空它，于是 pending 会一直保留。每轮把它与 override 比对，不一致就**把 override 更新成
 * pending 的值**：官方界面选择立刻生效，同时仍享有 override 的「跨轮持久」能力（不会回落）。
 *
 * 只在**已存在 override** 的会话上同步：没有 override 的会话不干预，交给官方链路自己跑。
 *
 * @param {{provider: string, model: string} | null} override 当前生效的 override
 * @param {{provider: string, model: string} | null} pending 官方投影里的待生效选择
 * @returns {{provider: string, model: string} | null} 需要写入的新 override；null = 无需同步
 */
export function adoptOfficialSelection(override, pending) {
  if (!override || !pending) return null;
  if (typeof pending.provider !== "string" || typeof pending.model !== "string") return null;
  if (pending.provider === "" || pending.model === "") return null;
  if (override.provider === pending.provider && override.model === pending.model) return null;
  return { provider: pending.provider, model: pending.model };
}

/**
 * 从会话投影里读官方「待生效」的模型选择（官方界面切换会写这里）。
 *
 * 投影不可用、字段缺失、调用抛错一律返回 null（宁可不同步，也不要在 hook 里抛异常打断请求）。
 *
 * @param {object} ctx 插件 context
 * @param {object} agent 当前请求所属 agent
 * @returns {{provider: string, model: string} | null}
 */
export function readOfficialPendingSelection(ctx, agent) {
  try {
    const projections = ctx?.sessionProjections ?? ctx?.get?.("sessionProjections");
    const state = projections?.stateOf?.(agent?.session, "modelSelection");
    const pending = state?.pending;
    if (!pending || typeof pending !== "object") return null;
    if (typeof pending.provider !== "string" || typeof pending.model !== "string") return null;
    return { provider: pending.provider, model: pending.model };
  } catch {
    return null;
  }
}

/** 测试钩子：清空 override 缓存（单测在场景之间调用）。 */
export function resetMemberModelCacheForTest() {
  memberModelCache.clear();
  memberModelCacheLoaded = false;
}
