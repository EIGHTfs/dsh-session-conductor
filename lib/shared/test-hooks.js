/** 测试钩子：配置/定时器注入与状态重置（仅测试使用）。 */

import { resetDomainForTest } from "../core/domain.js";
import { MAX_ATTACHED_LIMIT, MAX_CONTINUES_PER_SESSION_LIMIT } from "./constants.js";
import {
  continueTimers, continueLocks, continueJobs, deleteLocks,
  withDeleteLock, withSessionLock, withConcurrencyGate, cancelSessionTimers,
  getScanTimer, setScanTimer, resetRuntimeStateForTest,
} from "../core/state.js";
import {
  cfg, DEFAULTS, setConfig, resolveDshHome, resolveBrowseRoot,
  readSwitch, patchSwitch, loadPluginConfig, savePluginConfig, resetAutoContinueOnStart,
  autoRenameEnabled, effectiveAutoContinue, resetSwitchGroupsForTest, deleteSwitch, getSwitchGroupsForTest,
} from "../core/config.js";
import { num } from "../shared/util.js";
import { TEMPLATE_DEFAULTS } from "../template-inject.js";
import {
  invalidateSessionListCache, scheduleSaveListDiskCache, saveListDiskCacheNow, resetListCacheForTest,
} from "../sessions/list-cache.js";
import {
  scheduleAnalysis, runAnalysis, resolveModelOverride, analyzeSession, resolveRoute,
  driftAnalysisLlm, extractTitleOnly, parseDriftJson, pendingTimers, resetAnalysisForTest,
} from "../features/rename/analysis.js";
import {
  findTargetAgent, switchAgentModel, getMemberModelOverride, applyModelOverride,
  memberStatusError, validateModelPair, resumeSetupFor, resetMemberModelCacheForTest,
} from "../features/member-model/index.js";

// ---------- 插件入口 ----------

/** 会话模板元信息缓存（systemPrompt section「session-templates」同步读用，templates API 写入后刷新）。 */
export let templateStateCache = structuredClone(TEMPLATE_DEFAULTS);

/**
 * 刷新模板元信息缓存（唯一写入口）。
 *
 * 为什么需要 setter：ESM 的 **import 绑定对导入方是只读的**——`apply.js` 里直接写
 *   `templateStateCache = meta` 会抛 `TypeError: Assignment to constant variable`
 *   （实测：GET /api/session-conductor/templates 500，报错即此句）。
 *   拆分 lib/index.js 前该变量是 apply.js 内的模块级 `let`（可赋值），拆分后被移到本模块，
 *   赋值点却没跟着改 ⇒ 只有归属模块自己才能写，故在此暴露 setter，调用方改用本函数。
 */
export function setTemplateStateCache(v) {
  templateStateCache = v;
}

/** 测试钩子：直接设置运行期配置（单测用）。 */
export function __setConfigForTest(partial = {}) {
  setConfig({
    enabled: partial?.enabled !== false,
    defaultAutoContinue: partial?.defaultAutoContinue === true, // 缺省关闭，仅显式 true 开启
    failRetryDelayMs: num(partial?.failRetryDelayMs, 0, 10 * 60 * 1000, DEFAULTS.failRetryDelayMs),
    titleStateSuffix: partial?.titleStateSuffix === true, //  起默认取消状态后缀，显式 true 才开启
    maxConcurrent: num(partial?.maxConcurrent, 1, 8, DEFAULTS.maxConcurrent),
    maxAttached: num(partial?.maxAttached, 1, MAX_ATTACHED_LIMIT, DEFAULTS.maxAttached),
    // 会话列表冷会话 inspect 并发上限（默认 2）——防一次性并发全量会话导致堆 OOM
    listInspectBatch: num(partial?.listInspectBatch, 1, 16, DEFAULTS.listInspectBatch),
    // list 结果缓存时长（0=不缓存，即时最新；默认 5s 合并面板多组件同时刷新）
    listCacheMs: num(partial?.listCacheMs, 0, 5 * 60 * 1000, DEFAULTS.listCacheMs),
    cooldownMs: num(partial?.cooldownMs, 60 * 1000, 24 * 3600 * 1000, DEFAULTS.cooldownMs),
    maxContinuesPerSession: num(partial?.maxContinuesPerSession, 1, MAX_CONTINUES_PER_SESSION_LIMIT, DEFAULTS.maxContinuesPerSession),
    turnTimeoutMs: num(partial?.turnTimeoutMs, 60 * 1000, 6 * 3600 * 1000, DEFAULTS.turnTimeoutMs),
    scanIntervalMs: num(partial?.scanIntervalMs, 30 * 1000, 24 * 3600 * 1000, DEFAULTS.scanIntervalMs),
    // 自动重命名模型路由（成对配置才生效；缺省 = 继承会话 request/header 的对话模型）
    autoRenameProvider: typeof partial?.autoRenameProvider === "string" && partial.autoRenameProvider !== "" ? partial.autoRenameProvider : undefined,
    autoRenameModel: typeof partial?.autoRenameModel === "string" && partial.autoRenameModel !== "" ? partial.autoRenameModel : undefined,
  });
  return cfg;
}

/** 测试钩子：读取模块级定时器/锁状态（单测验证删除清理等）。 */
export function __timersForTest() {
  return { continueTimers, pendingTimers, continueJobs, deleteLocks };}

/** 测试钩子：读取开关配置内存缓存（起开关落盘 config.json，单测断言这里）。
 * 返回 { autoRename: Map, autoContinue: Map }。 */
export function __switchConfigForTest() {
  return getSwitchGroupsForTest();
}

/** 测试钩子：重置模块级单例状态（单测在场景之间调用）。 */
export function __resetForTest() {
  resetDomainForTest();
  resetMemberModelCacheForTest();
  // 开关缓存是模块级状态，测试场景之间必须清空，否则上一条用例的开关串到下一条。
  resetSwitchGroupsForTest();
  // 会话列表的落盘缓存/内存缓存同样是模块级状态，场景之间必须重置，
  // 否则上一条用例留下的缓存会让下一条「一次 inspect 都不做」，测不出真实行为。
  resetListCacheForTest(); // 清空列表落盘缓存与 TTL 缓存状态
  invalidateSessionListCache();
  resetAnalysisForTest(); // 清理待执行分析定时器 + 复位并发计数
  resetRuntimeStateForTest(); // 清理续跑定时器/锁/记账与扫描定时器
}
