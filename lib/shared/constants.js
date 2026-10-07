// dsh-session-conductor — 插件级常量

/** 插件名（日志前缀、工具/路由声明、审计标识统一使用）。 */
export const name = "dsh-session-conductor";

// ── 端点错误文案 ──────────────────────────────────────────────
// 同一句文案在多个 handler 里各写一遍（改文案容易漏改一处、也查不出有几处），抽常量集中维护。
/** 405：本插件端点只接受 GET/POST。 */
export const MSG_METHOD_ONLY_GET_POST = "仅 GET/POST";
/** 400：请求体缺少 sessionId（无法定位目标会话）。 */
export const MSG_NEED_SESSION_ID = "缺少 sessionId";

// ── 配置项硬上限（config 校验用）──────────────────────────────
// apply 的配置校验与测试钩子共用同一份，避免两边各写一个数字后慢慢漂移。
/** 同时附着的会话数上限（防一次挂太多子会话拖垮宿主）。 */
export const MAX_ATTACHED_LIMIT = 64;
/** 单会话自动续跑次数上限。 */
export const MAX_CONTINUES_PER_SESSION_LIMIT = 20;
/** 价值分析「陈旧天数」入参上限。 */
export const MAX_STALE_DAYS = 90;
