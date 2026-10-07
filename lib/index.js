/**
 * dsh-session-conductor · 统一出口（只做再导出）
 *
 * 拆分说明：原 lib/index.js 2258 行、24 个顶层块（其中 apply 单块 1438 行装的是
 * 路由注册 + 各 handler 实现），按职责切到 lib/ 下的域模块，本文件只保留再导出，
 * 使调用方导入路径与对外导出面完全不变（plugins 入口仍是 lib/index.js）。
 * 下一步（单独一轮）：把 apply 内部的 handler 继续抽成独立模块，apply 只留注册与编排。
 */

import './http.js';
import './guards.js';
export { deleteSession, undoLastMessage, deleteBatchSessions, deleteByRule } from './features/session-ops.js';
export { collectSearchableEvents, searchEventsText, searchSessions } from './features/search.js';
export { __setConfigForTest, __timersForTest, __switchConfigForTest, __resetForTest } from './shared/test-hooks.js';
export { CONDUCTOR_SETTINGS_NS } from './shared/settings.js';
export { apply } from './apply.js';
import {
  continueTimers, continueLocks, continueJobs, deleteLocks,
  withDeleteLock, withSessionLock, withConcurrencyGate, cancelSessionTimers,
  getScanTimer, setScanTimer, resetRuntimeStateForTest,
} from "./core/state.js";
export { cancelSessionTimers };
import {
  autoContinueEffectiveForRun, continueAllowed, buildContinuePrompt,
} from "./features/continue/eligibility.js";
export { autoContinueEffectiveForRun, buildContinuePrompt };
import { continueSession, waitTurn, sendMessageToSession } from "./features/continue/session.js";
export { continueSession, waitTurn, sendMessageToSession };
import {
  maybeScheduleContinue, runAutoContinueSession, runAutoScan, scheduleScan, AUTO_CONTINUE_SCAN_DELAY_MS,
} from "./features/continue/scan.js";
export { runAutoScan };
import {
  cfg, DEFAULTS, setConfig, resolveDshHome, resolveBrowseRoot,
  readSwitch, patchSwitch, loadPluginConfig, savePluginConfig, resetAutoContinueOnStart,
  autoRenameEnabled, effectiveAutoContinue, resetSwitchGroupsForTest, deleteSwitch, getSwitchGroupsForTest,
} from "./core/config.js";
export { patchSwitch, loadPluginConfig, savePluginConfig, resetAutoContinueOnStart };
import { name } from "./shared/constants.js";
export { name };
import { foldLastRoute, foldLastModelSelection } from "./sessions/route.js";
export { foldLastRoute, foldLastModelSelection };
import { detachSessionAgent, detachAllIdleSessions } from "./sessions/detach.js";
export { detachSessionAgent, detachAllIdleSessions };
import {
  invalidateSessionListCache, scheduleSaveListDiskCache, saveListDiskCacheNow, resetListCacheForTest,
} from "./sessions/list-cache.js";
export { invalidateSessionListCache };
import { buildSessionList, buildSessionListCached } from "./sessions/list.js";
export { buildSessionList, buildSessionListCached };
import { interruptionInfo, isAutoEligible } from "./sessions/interruption.js";
export { interruptionInfo, isAutoEligible };
import {
  scheduleAnalysis, runAnalysis, resolveModelOverride, analyzeSession, resolveRoute,
  driftAnalysisLlm, extractTitleOnly, parseDriftJson, pendingTimers, resetAnalysisForTest,
} from "./features/rename/analysis.js";
export {
  scheduleAnalysis, runAnalysis, resolveModelOverride, analyzeSession, resolveRoute,
  driftAnalysisLlm, extractTitleOnly, parseDriftJson,
};
import { analyzeValueWithLlm, parseValueJson } from "./features/rename/value.js";
export { analyzeValueWithLlm, parseValueJson };
import {
  collectSessionTitleMessages, foldTitle, workspaceNameOf, archiveTitleWithWs, stripArchiveWsPrefix,
  titleString, resolveSessionTitle, stateSuffixOf, stripTitleStateSuffix, refreshTitleState,
} from "./features/rename/title.js";
export {
  collectSessionTitleMessages, foldTitle, workspaceNameOf, archiveTitleWithWs, stripArchiveWsPrefix,
  titleString, resolveSessionTitle, stateSuffixOf, stripTitleStateSuffix, refreshTitleState,
};
import {
  findTargetAgent, switchAgentModel, getMemberModelOverride, applyModelOverride,
  memberStatusError, validateModelPair, resumeSetupFor, resetMemberModelCacheForTest,
} from "./features/member-model/index.js";
export {
  findTargetAgent, switchAgentModel, getMemberModelOverride, applyModelOverride,
  memberStatusError, validateModelPair,
};
