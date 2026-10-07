// dsh-session-conductor —— 会话管理增强插件（宿主半边）。
//
// 提供 /api/session-conductor/* 路由：
//   GET  /api/session-conductor/list                列出全部会话（标题/运行状态/是否归档/是否自动重命名/中断状态/是否自动续跑）
//   POST /api/session-conductor/archive             归档会话（原生 workspaceRegistry.archiveSession）
//   POST /api/session-conductor/unarchive           取消归档（注册表 setState 写回，与原生同一持久化路径）
//   POST /api/session-conductor/delete              删除会话（per-session 串行锁；拒绝运行中/续跑中；
//                                                   detach + 记账清理 + 删磁盘日志 + 清理遗留定时器）
//   POST /api/session-conductor/auto-rename         开启/关闭某会话的「自动重命名」
//   POST /api/session-conductor/analyze             立即分析一次对话主题，必要时自动重命名
//   POST /api/session-conductor/continue            手动续跑一个被中断的会话
//   POST /api/session-conductor/auto-continue       开启/关闭某会话的「自动续跑」（覆盖全局默认）
//   POST /api/session-conductor/scan                立即扫描一遍所有会话并自动续跑可续的
//   POST /api/session-conductor/search               全文搜索：跨会话搜消息内容，返回命中会话+上下文片段
//   POST /api/session-conductor/delete-batch         批量删除：逐条复用删除链路，运行中跳过不整体失败
//   POST /api/session-conductor/undo-message           撤回最后一条用户消息：直接操作会话日志文件，\n//                                                    dryRun 预览 + 二次确认 + .undo-backup 备份
//   POST /api/session-conductor/delete-by-rule       按条件删除：归档状态/超期未活跃/cwd 前缀，可 dryRun 预览
//
// 自动重命名：对开启的会话，每次回合结束（turn/end）后延迟触发一次分析——
//   折叠出最近用户消息与当前标题，调用 LLM 判断「对话主题/方向是否已明显偏离标题」；
//   若偏离则生成新标题并通过 sessionTitle.rename() 落盘（source=user，会 pin 住标题，
//   内置的首条消息自动起名不会覆盖它）。带最小间隔与新增消息数门槛，控制 LLM 成本。
//
// 自动续跑：读取会话记录，识别「非人为中断」的回合，自动让 agent 继续执行——
//   中断判定（只看会话最后一条回合边界）：
//     · turn/end reason.kind === "interrupted"        —— DSH 崩溃修复写入的合成闭合（进程被杀/崩溃）
//     · turn/end reason.kind === "error" 且 code ∈ {RATE_LIMIT, SERVER, TIMEOUT, EMPTY_RESPONSE}
//                                                    —— 可重试的基础设施错误
//     · turn/end reason.kind === "aborted"            —— 一律不自动续：真实数据只有 user / disposed
//        （用户手动停止 / 生命周期拆除），都是主动取消；未知 kind 保守处理，留给手动
//     · 末尾是未闭合 turn/start（open turn）          —— 崩溃中断：冷会话视为崩溃残留可自动续；
//        live 会话的 open-turn 是运行中，绝不续（DSH 修复会把 cold 会话改写成 interrupted）
//   续跑机制：live 会话 → 直接 agent.followup(续跑提示)；
//   cold 会话 → ctx.agents.resume()（按会话最近 request/header 的 provider/model + 原 preset 组合）
//   → followup → 等回合结束 → sessions.flush() → handle.dispose() 释放 agent，
//   活跃会话数回到基线，不会堆积。
//   防护：每会话串行锁 + 全局并发闸（maxConcurrent）+ 活跃会话上限（maxAttached，
//   达到后自动续跑暂停、手动仍可用）+ 同会话冷却（cooldownMs）+ 每会话自动续跑总次数上限
//   （maxContinuesPerSession，防「报错→续跑→再报错」死循环）。
//
// 手动释放（置为不活跃）：DSH 没有「关闭/释放会话」的公开入口（会话一旦被 UI 打开
//   就常驻内存，active 数只增不减）——本插件提供 POST /api/session-conductor/detach：
//   把 live 空闲会话的 agent 从注册表拆除 + 释放作用域 + detach 会话，回到冷（持久化）
//   状态；对话日志完整保留，再次打开/发消息会自动重新挂载。顺序复刻 dsh-agent-loop
//   生命周期 dispose：cancel → whenIdle → scope.dispose → detachAgent(含 agent/disposed) →
//   detachSession(触发 session/disposed → 持久化协调器 retire/flush)。
//   守卫：运行中（open turn）拒绝；subagent 拥有的会话拒绝。
//
// ⚠️ 内部实现变通（DSH 0.1.0-rc.6 无公开 unarchive / session-delete / session-detach API）：
//   1. 取消归档：调用 dsh-workspace WorkspaceRegistry 的 state/setState（原型方法，
//      非 # 私有）。setState 与原生 archiveSession 走完全相同的
//      domain.global.set → domain/changed 持久化路径，host-apiproxy 监听到后
//      自动向所有客户端推送 host/archived-sessions-changed 帧，前端无需额外刷新。
//   2. 删除 live 会话：调用 dsh-session SessionStore 内部 store 条目的 detach()
//      （与 agent 拆卸会话同一路径），触发 session/disposed → 前端收 host/session-removed。
//   3. 自动续跑依赖 dsh-agent-loop 的 ctx.agents.resume() / agent.followup() /
//      handle.dispose()（公开 API，参考 dsh-headless 的直驱写法）。
//   4. 手动释放：agent.cancel()/whenIdle() 公开；agent.scope.dispose()、agents.store
//      条目删除 + agents.emitDisposed()、sessions.store 条目 detach() 为内部实现
//      （与 agent-loop 自身 dispose 同一路径，顺序一致）。
//   升级 DSH 版本后需复核这几处是否仍成立。

import { rm, readdir, readFile, mkdir } from "node:fs/promises";
import { readFileSync, copyFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { interruptedTurnClosers } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
// 注：模型选择交给官方 session-controller 的 selectionFor（读 model/selection 投影 → 请求头 → 默认）。
// 插件**不再**自己 installModelSelection——两个 agent/request hook 会竞争，表现为「切换下一轮回落」。
import Schema from "@deepseek-ai/schemastery";
import { findSessionLog } from "./session-log.js";
// 30801 (dsh--alpha.4)：collectSessionTitleMessages 已改为包内私有函数，不再导出。
// 本地复刻同等逻辑（user/message + source.kind==="user" 的 text 块拼接），避免 import 炸掉整个 plugin tree。





import { renderCompletionBlock, checkCompletionText, VALID_STATUSES } from "./core.js";
import { log } from "./shared/log.js";
import { hasOpenTurn, lastEventTime } from "./sessions/turn.js";
import { lazyRepair, lazyZstd, lazySeqGap, lazyEio, lazyValue } from "./core/lazy.js";
import { pluginDomain, pluginState, isDomainLive, resetDomainForTest } from "./core/domain.js";
import {
  continueTimers, continueLocks, continueJobs, deleteLocks,
  withDeleteLock, withSessionLock, withConcurrencyGate, cancelSessionTimers,
  getScanTimer, setScanTimer, resetRuntimeStateForTest,
} from "./core/state.js";
export { cancelSessionTimers };
import {
  cfg, DEFAULTS, setConfig, resolveDshHome, resolveBrowseRoot,
  readSwitch, patchSwitch, loadPluginConfig, savePluginConfig, resetAutoContinueOnStart,
  autoRenameEnabled, effectiveAutoContinue, resetSwitchGroupsForTest, deleteSwitch, getSwitchGroupsForTest,
} from "./core/config.js";
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
import { num } from "./shared/util.js";
export { patchSwitch, loadPluginConfig, savePluginConfig, resetAutoContinueOnStart };


import { registerGroupRoutes } from "./group.js";
import { saveTemplate, saveTemplateFromUrl, saveTemplateFromPath, listTemplateDir, removeTemplate, readTemplateSync, collectTemplateSlotText, TEMPLATE_DEFAULTS, TEMPLATE_SLOTS, TEMPLATE_MAX_BYTES, PLAN_ENFORCE_EDIT_TOOLS, PLAN_ENFORCE_BASH_WRITE_RE, planGateAllows, planEnforceDenyMessage } from "./template-inject.js";

/** Cordis 插件名（loader 诊断用）。 */
import { name } from "./shared/constants.js";
export { name };
import { foldLastRoute, foldLastModelSelection } from "./sessions/route.js";
export { foldLastRoute, foldLastModelSelection };
import { defaultModelSelection } from "./sessions/route.js";
import { hasApiRemoteSubagentOwner, sessionEventList, sessionEventsOf, readColdSessionEvents } from "./sessions/events.js";
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
import { resolveSessionPreset } from "./features/inject/preset.js";

// ---------- 自动重命名参数 ----------
// （自动重命名的门槛与限流常量随分析引擎迁入 features/rename/analysis.js）


// ---------- 自动续跑参数（可用 patch config 覆盖） ----------
// （标题状态后缀常量随标题域迁入 features/rename/title.js；
//   AUTO_CONTINUE_HUMAN_ABORT_KINDS 随中断判定迁入 sessions/interruption.js）
// （续跑防抖与首扫延迟常量随扫描迁入 features/continue/scan.js）




// ---------- 基础工具 ----------

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 读取 JSON 请求体（POST 必须带 Content-Type: application/json）。 */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}






/** 进程级异常兜底（，幂等）。
 *  背景：宿主 bin.ts 没有注册 unhandledRejection/uncaughtException，Node 15+ 对未处理的
 *  promise rejection 默认 `throw` → **整个 DSH 进程退出**。自动续跑是长链异步（resume 会话、
 *  等回合、写账），任何一处 rejection 逃逸都会表现为「续跑能用，但 DSH 跑一会就死」。
 *  这里注册兜底 handler：记录日志后**不退出进程**，让宿主与其它插件继续工作；同时把错误
 *  写进插件日志便于后续定位。重复 apply（热重载）不会重复注册。
 */
let processGuardsInstalled = false;
function installProcessGuards(ctx) {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  try {
    process.on("unhandledRejection", (reason) => {
      try {
        log(ctx, `⚠️ 捕获未处理的 Promise rejection（已阻止进程退出）: ${String(reason?.stack ?? reason?.message ?? reason)}`);
      } catch {
        /* 日志自身失败也不能再抛 */
      }
    });
  } catch {
    /* 某些宿主环境（沙箱/受限 worker）可能不允许注册，忽略 */
  }
}

// ---------- 插件开关配置（2026-09-27：落盘 <DSH_HOME>/session-conductor/config.json）----------
// 自动重命名（autoRename）与自动续跑（autoContinue）两组逐会话开关统一存放，
// 「改→写→读」走同一公共函数：
//   · 面板/API 控制 → patchSwitch(ctx, group, sessionId, patch) 改缓存 + 原子落盘 config.json
//   · 功能执行（重命名/续跑判定）→ readSwitch(group, sessionId) 读缓存
//   · 启动时 loadPluginConfig 载入文件；自动续跑额外规则：每次 DSH 启动（apply）
//     自动把所有 autoContinue 开关复位为关闭（resetAutoContinueOnStart），
//     之后用户面板逐会话决定；autoRename 不复位（保持用户设置）。


// ---------- 自动重命名分析引擎 ----------







// ---------- 自动续跑引擎 ----------

/**
 * 分析一个会话的事件流，返回「非人为中断」判定（只看最后一条回合边界）：
 *   null —— 无需续跑（正常完成 / blocked / max-tokens / 非可重试错误 / 用户取消）
 *   {kind:"interrupted"|"error"|"aborted"|"open-turn", seq, code?, message?}
 */


/**
 * 依据会话事件流判定标题应附加的状态后缀（live 视角）：
 *   open turn（未闭合回合）= 运行中；interrupted/error/冷 open-turn = 已中断；
 *   正常完成 / 用户取消 = 无后缀。
 */


// （开关统一配置见上方 switchGroups 公共模块；effectiveAutoContinue 已在其中定义，
//   下方仅保留运行判定组合层。）

// ---------- 自动续跑运行判定 ----------

/**
 * 运行期自动续跑判定：跟随会话开关（与面板开关展示一致），仅用于「运行路径」（续跑/扫描）。
 * 2026-08-20 新增：全局闸门 autoContinueGate === "closed" 时**一切自动续跑跳过**
 * ——与 guardian 联动，防崩溃恢复后自动续跑批量建空壳。
 * （2026-09-26 错峰定时任务移除，原「窗口内强制开启」分支已删。）
 */


// 续跑调度状态
















// ---------- 手动释放（置为不活跃） ----------



// ---------- 会话列表派生数据落盘缓存（持久化 + 懒加载）----------
/**
 * 会话列表里只有三个字段必须由**事件流**推导：title（标题）、updatedAt（最后活动）、
 * interruption（中断状态）。而读冷会话事件流走官方 handle 读法
 * （persistence.open('read') → handle.read(0) → close，0.1.6 起 inspect 已失效）——
 * 整份日志解码进内存，
 * 且宿主 coordinator 会把这次 prepared 结果保留做有界复用：**每扫一遍列表 = 把全量会话重新拉进
 * 内存一次**（本机 130 会话 / 253MB 库，实测一次 /list 让 RSS 从 1.0GB 冲到 1.9GB，
 * 逼近 --max-old-space-size=2048 上限，即  修的那个堆 OOM）。
 *
 * 做法（持久性保存 + 懒加载，内存优先于速度）：
 *   ① 用 persistence.listSnapshots() 拿每个会话的 header + revision（**只读 header 行 + 一次 stat，
 *      不解析日志**），revision 是「该会话日志内容是否变过」的变更令牌；
 *   ② 把上面三个字段连同 revision 落盘到 <DSH_HOME>/storages/dsh-session-conductor/list-cache.json；
 *   ③ 下次列列表时 **revision 没变就直接用落盘结果，一次 inspect 都不做**（懒加载核心）；
 *      只有新会话、或日志真的追加过（revision 变了）才重新解析那一条；
 *   ④ 首次运行（无缓存）需要把现有会话解析一遍（用户接受「慢一点」），解析完落盘，
 *      此后每次启动都是「读缓存 → 秒回」，且进程不再因为拉全量会话而堆爆。
 * 缓存文件随 DSH_HOME 走（resolveDshHome），不写死本机路径；损坏/版本不符按空缓存处理，绝不抛。
 */


// （会话列表构建与落盘缓存已迁入 sessions/list.js + sessions/list-cache.js）

// ---------- 取消归档 / 删除 ----------

/**
 * 取消归档。DSH 无公开 unarchive API：直接写注册表的持久化状态
 * （domain.global.set），host-apiproxy 的 domain/changed 监听会自动把
 * 新归档集合推送成 host/archived-sessions-changed 帧。
 */
async function unarchiveSession(ctx, sessionId) {
  const registry = ctx.get("workspaceRegistry");
  if (!registry) throw new Error("workspaceRegistry 服务不可用");
  if (!registry.archivedSessionIds.includes(sessionId)) return; // 未归档，幂等
  const state = registry.state ?? registry.requireState();
  await registry.setState({
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
  });
}

/** 删除会话（per-session 串行锁）：拒绝运行中/续跑中 → detach → 取消归档 → 记账清理 → 删磁盘日志 → 清理遗留定时器。
 *  同一会话的并发删除请求排队串行执行（withDeleteLock），不做交错。 */
export async function deleteSession(ctx, sessionId) {
  return withDeleteLock(sessionId, async () => {
    const sessions = ctx.get("sessions");
    const workspaceRegistry = ctx.get("workspaceRegistry");
    const persistence = ctx.get("sessionPersistence");

    // 0. 运行中 / 续跑中的会话拒绝删除
    const live = sessions?.get(sessionId);
    if (live && hasOpenTurn(live.events)) {
      return { ok: false, error: { code: "running", message: "会话正在运行，无法删除" } };
    }
    if (continueJobs.has(sessionId)) {
      return { ok: false, error: { code: "running", message: "会话正在自动续跑中，无法删除" } };
    }

    // 1. live 会话从 store detach → 触发 session/disposed → 前端收 host/session-removed
    if (live) {
      // 内部实现变通：sessions 服务无公开 remove；entry.detach 与 agent 拆卸同一路径。
      const entry = sessions?.store?.get(sessionId);
      entry?.detach?.();
    }

    // 2. 若已归档 → 取消归档
    await unarchiveSession(ctx, sessionId);

    // 3. 从 workspace 记账 detach（detachSession 为公开方法）
    for (const workspace of workspaceRegistry?.list() ?? []) {
      if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId);
    }

    // 4. 删除磁盘 artifact（session 目录）。sqlite 查询索引会对账自动清理。
    //    先 detach 再删文件：持久化协调器在 session/disposed 后退休该会话，
    //    不会再把它写回磁盘。
    if (persistence?.listArtifacts) {
      const artifacts = await persistence.listArtifacts();
      const artifact = artifacts.find((entry) => entry.header?.id === sessionId);
      if (artifact?.path) {
        const sessionDir = path.dirname(artifact.path);
        await rm(sessionDir, { recursive: true, force: true });
        // 尽力清理空的 project 目录（会话删光后不留空壳）
        const projectDir = path.dirname(sessionDir);
        try {
          if ((await readdir(projectDir)).length === 0) await rm(projectDir, { recursive: true, force: true });
        } catch {
          // 目录非空或不可读，保留即可
        }
      }
    }

    // 5. 清理自动重命名 / 自动续跑开关（config.json 两组同步清，防同名会话重建后误判）
    const hadRename = deleteSwitch("autoRename", sessionId);
    const hadContinue = deleteSwitch("autoContinue", sessionId);
    if (hadRename || hadContinue) await savePluginConfig(ctx);
    const domain = await pluginDomain(ctx);
    const state = domain.global.get();
    if (state.autoRename?.[sessionId] !== void 0 || state.autoContinue?.[sessionId] !== void 0) {
      // 旧域残留清理（2026-09-27 前落盘数据，此后开关以 config.json 为准）
      const next = { ...state, autoRename: { ...(state.autoRename ?? {}) }, autoContinue: { ...(state.autoContinue ?? {}) } };
      delete next.autoRename[sessionId];
      delete next.autoContinue[sessionId];
      await domain.global.set(next);
    }

    // 6. 清理该会话遗留的防抖定时器/续跑记账（删除后不应再有续跑/重命名调度）
    cancelSessionTimers(sessionId);

    return { ok: true };
  });
}

// ---------- 撤回最后一条用户消息 ----------

/**
 * 撤回会话「最后一条用户消息」（连同它触发的整轮回复），等效于聊天软件撤回。
 * 原理：直接操作会话日志文件 session.jsonl.zstd —— 逐帧解码 → 删除最后一条
 * user/message 事件所在行及其后所有行 → 多帧写回（header 一帧 + body 一帧，
 * 带 checksum，与官方 jsonl 后端一致）→ 原文件备份到 .undo-backup/。
 * seq 无需重编号：删除的是文件尾部，前面事件 seq 0..N-1 连续不变（写回前用
 * validateSessionText 校验兜底）。
 * 安全（与 deleteSession 同一策略）：拒绝运行中/续跑中；live 空闲会话先走
 * detachSessionAgent（协调器退休）再改文件，防止内存旧事件 flush 覆盖撤回结果；
 * 会话保留在侧边栏列表（detach 链路保证），重新打开即加载撤回后的状态。
 * @returns {{ok:boolean, preview?:string, removedLineCount?:number, removedEventCount?:number,
 *            remainingEventCount?:number, backup?:string, dryRun?:boolean, error?:{code,message}}}
 */
export async function undoLastMessage(ctx, sessionId, { dryRun = false } = {}) {
  return withDeleteLock(sessionId, async () => {
    const sessions = ctx.get("sessions");
    const persistence = ctx.get("sessionPersistence");

    // 0. 运行中 / 续跑中的会话拒绝撤回（与 deleteSession 同一策略）
    const live = sessions?.get(sessionId);
    if (live && hasOpenTurn(live.events)) {
      return { ok: false, error: { code: "running", message: "会话正在运行，无法撤回（等回合结束后再试）" } };
    }
    if (continueJobs.has(sessionId)) {
      return { ok: false, error: { code: "running", message: "会话正在自动续跑中，无法撤回" } };
    }

    // 1. 定位会话日志文件（与 deleteSession 同一来源）
    if (!persistence?.listArtifacts) {
      return { ok: false, error: { code: "no-persistence", message: "sessionPersistence 服务不可用" } };
    }
    const artifacts = await persistence.listArtifacts();
    const artifact = (artifacts ?? []).find((entry) => entry.header?.id === sessionId);
    if (!artifact?.path) {
      return { ok: false, error: { code: "not-found", message: "会话日志不存在" } };
    }
    const filePath = artifact.path;

    // 2. 读取并定位最后一条用户消息所在行（从尾部往前扫，找到即止）
    let text;
    try {
      const { decodeAllFrames } = await lazyZstd();
      text = await decodeAllFrames(readFileSync(filePath));
    } catch (e) {
      return { ok: false, error: { code: "decode-failed", message: "会话日志解码失败: " + String(e?.message ?? e) } };
    }
    const lines = String(text).split("\n");
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length === 0) return { ok: false, error: { code: "empty", message: "会话日志为空" } };

    let targetLineIdx = -1;
    let preview = "";
    let removedEventCount = 0;
    for (let i = lines.length - 1; i >= 1; i--) {
      const { parseLineEvents } = await lazyRepair();
      const events = parseLineEvents(lines[i]);
      if (!events) continue;
      removedEventCount += events.length;
      for (const ev of events) {
        // 只撤回真实用户消息（source.kind === "user"）；注入的
        // runtime context / system-reminder 的 kind 是 plugin / skill-catalog，
        // 不能把注入内容误当用户消息撤回（2026-08-24 实测缺陷修复）
        const srcKind = ev?.data?.source?.kind;
        if ((ev?.type === "user/message" || ev?.type === "user") && srcKind === "user") {
          targetLineIdx = i;
          const content = ev.data?.content;
          if (Array.isArray(content)) {
            preview = content
              .filter((b) => b?.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join("\n");
          }
          break;
        }
      }
      if (targetLineIdx >= 0) break;
    }
    if (targetLineIdx < 0) {
      return { ok: false, error: { code: "no-user-message", message: "会话里没有可撤回的用户消息" } };
    }

    // 删除范围 [targetLineIdx, 行尾]：这条消息 + 它触发的整轮回复（文件尾部）
    const keptLines = lines.slice(0, targetLineIdx);
    const removedLineCount = lines.length - targetLineIdx;
    const newText = keptLines.join("\n") + "\n";

    // 3. 写回前校验（header / seq 连续 / tool-result 结构）
    const { validateSessionText } = await lazyRepair();
    const check = validateSessionText(newText);
    if (!check.ok) {
      return { ok: false, error: { code: "invalid-after-undo", message: "撤回后日志校验失败: " + (check.problems?.[0] ?? "未知") } };
    }

    if (dryRun) {
      return { ok: true, dryRun: true, preview, removedLineCount, removedEventCount, remainingEventCount: check.eventCount };
    }

    // 4. 正式执行：先 detach（协调器退休，防 flush 旧事件覆盖）再改文件
    if (live) {
      const detach = await detachSessionAgent(ctx, sessionId);
      if (!detach?.ok) {
        return { ok: false, error: { code: "detach-failed", message: String(detach?.error?.message ?? "detach 失败") } };
      }
    }

    // 5. 备份原文件到会话同目录 .undo-backup/
    const backupDir = path.join(path.dirname(filePath), ".undo-backup");
    mkdirSync(backupDir, { recursive: true });
    const bak = path.join(backupDir, `${Date.now()}-${sessionId}.zstd`);
    copyFileSync(filePath, bak);

    // 6. 多帧写回（header 一帧 + body 一帧，带 checksum），原子替换
    const { encodeSessionText } = await lazyRepair();
    const newBuf = await encodeSessionText(newText);
    const tmp = filePath + ".undotmp";
    writeFileSync(tmp, newBuf);
    try { chmodSync(tmp, statSync(filePath).mode); } catch { /* CIFS 无 chmod，尽力 */ }
    renameSync(tmp, filePath);

    return { ok: true, preview, removedLineCount, removedEventCount, remainingEventCount: check.eventCount, backup: bak };
  });
}

// ---------- 全文搜索 / 批量删除 / 按条件删除 ----------

const SEARCH_MIN_QUERY = 2; // 关键词最短长度（低于不搜）
const SEARCH_MAX_SESSIONS = 200; // 单次扫描会话数上限（全文扫描保护）
const SEARCH_PER_SESSION_MAX = 5; // 单会话最多返回命中数
const SEARCH_PREVIEW_LEN = 140; // 命中上下文片段长度

/**
 * 从会话事件流提取可搜索的文本行（user 消息 / assistant 文本块）。
 * 工具调用与结果不参与搜索（正文噪音大）。
 * @param {Array} events 会话事件数组
 * @returns {Array<{seq:number, time:number, role:"user"|"assistant", text:string}>}
 */
export function collectSearchableEvents(events) {
  const out = [];
  for (const ev of events ?? []) {
    const t = ev?.type;
    let role = null;
    let text = null;
    if (t === "user/message" || t === "user") {
      // 只收真人消息：系统注入（runtime context / system-reminder / skill 目录等 source.kind=plugin）
      // 不算正文，否则搜「skill」「DSH」等词会被注入噪音淹没
      if (ev?.data?.source?.kind !== "user") continue;
      const content = ev.data?.content ?? ev.data?.message?.content;
      if (Array.isArray(content)) {
        const txt = content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        if (txt) { role = "user"; text = txt; }
      }
    } else if (t === "assistant/chunk") {
      const chunk = ev?.data?.chunk;
      if (chunk && typeof chunk.text === "string" && (chunk.blockType === "text" || chunk.blockType === "text-chunks")) {
        role = "assistant";
        text = chunk.text;
      }
    } else if (t === "assistant/message" || t === "message") {
      const content = ev?.data?.message?.content ?? ev?.data?.content;
      if (Array.isArray(content)) {
        const txt = content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        if (txt) { role = "assistant"; text = txt; }
      }
    }
    if (role && text) out.push({ seq: ev.seq ?? 0, time: ev.time ?? 0, role, text });
  }
  return out;
}

/**
 * 在事件文本里搜关键词（大小写不敏感），返回命中上下文片段。
 * @returns {Array<{seq:number, time:number, role:string, preview:string}>}
 */
export function searchEventsText(events, query, { perSessionMax = SEARCH_PER_SESSION_MAX, previewLen = SEARCH_PREVIEW_LEN } = {}) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const item of collectSearchableEvents(events)) {
    if (hits.length >= perSessionMax) break;
    const idx = item.text.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const half = Math.floor(previewLen / 2);
      const start = Math.max(0, idx - half);
      const end = Math.min(item.text.length, idx + q.length + half);
      const preview = (start > 0 ? "…" : "") + item.text.slice(start, end).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim() + (end < item.text.length ? "…" : "");
      hits.push({ seq: item.seq, time: item.time, role: item.role, preview });
    }
  }
  return hits;
}

/**
 * 全文搜索：跨所有会话的消息内容搜关键词。
 * scope：all（默认，含归档）/ active（仅未归档）/ archived（仅归档）。
 * 返回命中会话 + 上下文片段；损坏/不可读会话跳过；扫描会话数有上限保护。
 */
export async function searchSessions(ctx, query, { scope = "all", maxSessions = SEARCH_MAX_SESSIONS, perSessionMax = SEARCH_PER_SESSION_MAX } = {}) {
  const q = String(query ?? "").trim();
  if (q.length < SEARCH_MIN_QUERY) return { query: q, scanned: 0, hits: [] };
  const sessions = await buildSessionListCached(ctx, { force: true }); // 搜索需绝对新鲜，绕过缓存
  const hits = [];
  let scanned = 0;
  for (const s of sessions) {
    if (scope === "active" && s.archived) continue;
    if (scope === "archived" && !s.archived) continue;
    if (scanned >= maxSessions) break;
    scanned += 1;
    try {
      const found = await sessionEventsOf(ctx, s.id);
      if (!found) continue;
      const matches = searchEventsText(found.events, q, { perSessionMax });
      if (matches.length > 0) {
        hits.push({
          sessionId: s.id,
          title: s.title,
          cwd: s.cwd,
          archived: s.archived === true,
          running: s.running === true,
          updatedAt: s.updatedAt ?? null,
          matches,
        });
      }
    } catch {
      /* 单个会话失败跳过（损坏日志等），不中断整体搜索 */
    }
  }
  return { query: q, scanned, hits };
}

/**
 * 批量删除：逐条复用 deleteSession（内部 per-session 串行锁 + 幂等）。
 * 运行中/续跑中的会话跳过并汇总返回，不整体失败。
 * @returns {{requested:number, deleted:string[], skipped:Array<{sessionId:string, reason:string}>}}
 */
export async function deleteBatchSessions(ctx, sessionIds) {
  const ids = [...new Set(
    (Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === "string" && id !== "")
  )];
  const deleted = [];
  const skipped = [];
  // 2026-08-20 修复：预检会话是否存在（live 或已持久化），不存在的进 skipped(not-found)，
  // 不再被误报为「已删除」。persistence 不可用/返回空（如测试 mock）时保守处理：
  // 仅当「明确知道不存在」才跳过，否则交给 deleteSession 正常判定。
  const persistence = ctx.get("sessionPersistence");
  const persistIds = new Set();
  let canCheckPersist = false;
  try {
    // 持久化会话权威来源 = persistence.list()（mock 与真实实现都提供）；
    // listArtifacts 仅作补充（可能未实现/返回空，不代表会话不存在）
    if (persistence?.list) {
      const metas = await persistence.list();
      if (Array.isArray(metas)) {
        canCheckPersist = true;
        for (const m of metas) if (m?.id) persistIds.add(m.id);
      }
    }
  } catch { canCheckPersist = false; }
  const sessionsSvc = ctx.get("sessions");
  const liveIds = new Set(sessionsSvc?.list?.()?.map((s) => s.id) ?? []);
  for (const id of ids) {
    // 仅当列表查询可用且明确不在其中 → not-found；否则尝试删除
    const knownMissing = canCheckPersist ? (!liveIds.has(id) && !persistIds.has(id)) : false;
    if (knownMissing) {
      skipped.push({ sessionId: id, reason: "not-found" });
      continue;
    }
    try {
      const result = await deleteSession(ctx, id);
      if (result.ok) deleted.push(id);
      else skipped.push({ sessionId: id, reason: result.error?.code ?? "error" });
    } catch {
      skipped.push({ sessionId: id, reason: "error" });
    }
  }
  return { requested: ids.length, deleted, skipped };
}

/**
 * 按条件删除：归档状态 / 超期未活跃（updatedAt 距今 > inactiveDays 天）/ cwd 前缀（分组）/
 * 低价值会话（lowValue=true 复用价值分析判定，事件不可读的会话保守保留不删）。
 * dryRun=true 只预览命中（不执行删除）。
 * @returns {{matched:Array<{sessionId,title,cwd,archived,updatedAt,value?,reason?}>, deleted?:string[], skipped?:Array<{sessionId,reason}>}}
 */
export async function deleteByRule(ctx, { archivedOnly = false, inactiveDays = 0, cwdPrefix = "", lowValue = false, dryRun = false } = {}) {
  const sessions = await buildSessionListCached(ctx, { force: true }); // 按规则删除不得拿旧列表决策，绕过缓存
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const prefix = String(cwdPrefix ?? "").replace(/\/+$/, "");
  // lowValue：复用价值分析（analyzeValuesWithKeywords 的 low 集合）；事件不可读会话被
  //   保守判 high（artifact-safe），不会误删；关键词命中也判 high 不删。
  let lowById = null;
  if (lowValue) {
    const texts = {};
    const userTexts = {};
    const featuresById = {};
    for (const s of sessions) {
      try {
        const found = await sessionEventsOf(ctx, s.id);
        if (found) {
          const { lastAssistantText, lastUserText, buildValueFeatures } = await lazyValue();
          texts[s.id] = lastAssistantText(found.events);
          userTexts[s.id] = lastUserText(found.events);
          featuresById[s.id] = buildValueFeatures(found.events, s, new Date(now));
        }
      } catch {
        /* 单会话读取失败：不放入 lowById，保守保留不删 */
      }
    }
    const { analyzeValuesWithKeywords } = await lazyValue();
    const { low } = analyzeValuesWithKeywords(sessions, texts, userTexts, featuresById, [], {}, new Date(now));
    lowById = new Set(low.map((i) => i.id));
  }
  const matched = sessions.filter((s) => {
    if (archivedOnly && s.archived !== true) return false;
    if (inactiveDays > 0) {
      const updated = typeof s.updatedAt === "number" ? s.updatedAt : NaN;
      if (!Number.isFinite(updated) || now - updated < inactiveDays * dayMs) return false;
    }
    if (prefix !== "") {
      const cwd = String(s.cwd ?? "").replace(/\/+$/, "");
      if (cwd !== prefix && !cwd.startsWith(prefix + "/")) return false;
    }
    if (lowValue && !(lowById?.has(s.id) ?? false)) return false;
    return true;
  });
  const preview = matched.map((s) => {
    const item = {
      sessionId: s.id,
      title: s.title,
      cwd: s.cwd,
      archived: s.archived === true,
      updatedAt: s.updatedAt ?? null,
    };
    if (lowValue && lowById) item.value = "low";
    return item;
  });
  if (dryRun) return { ok: true, dryRun: true, matched: preview };
  const result = await deleteBatchSessions(ctx, preview.map((m) => m.sessionId));
  return { ok: true, dryRun: false, matched: preview, deleted: result.deleted, skipped: result.skipped };
}

// ---------- 插件入口 ----------




/** 会话模板元信息缓存（systemPrompt section「session-templates」同步读用，templates API 写入后刷新）。 */
let templateStateCache = structuredClone(TEMPLATE_DEFAULTS);



/** 测试钩子：直接设置运行期配置（单测用）。 */
export function __setConfigForTest(partial = {}) {
  setConfig({
    enabled: partial?.enabled !== false,
    defaultAutoContinue: partial?.defaultAutoContinue === true, // 缺省关闭，仅显式 true 开启
    failRetryDelayMs: num(partial?.failRetryDelayMs, 0, 10 * 60 * 1000, DEFAULTS.failRetryDelayMs),
    titleStateSuffix: partial?.titleStateSuffix === true, //  起默认取消状态后缀，显式 true 才开启
    maxConcurrent: num(partial?.maxConcurrent, 1, 8, DEFAULTS.maxConcurrent),
    maxAttached: num(partial?.maxAttached, 1, 64, DEFAULTS.maxAttached),
    // 会话列表冷会话 inspect 并发上限（默认 2）——防一次性并发全量会话导致堆 OOM
    listInspectBatch: num(partial?.listInspectBatch, 1, 16, DEFAULTS.listInspectBatch),
    // list 结果缓存时长（0=不缓存，即时最新；默认 5s 合并面板多组件同时刷新）
    listCacheMs: num(partial?.listCacheMs, 0, 5 * 60 * 1000, DEFAULTS.listCacheMs),
    cooldownMs: num(partial?.cooldownMs, 60 * 1000, 24 * 3600 * 1000, DEFAULTS.cooldownMs),
    maxContinuesPerSession: num(partial?.maxContinuesPerSession, 1, 20, DEFAULTS.maxContinuesPerSession),
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

/** 测试钩子：读取开关配置内存缓存（2026-09-27 起开关落盘 config.json，单测断言这里）。
 * 返回 { autoRename: Map, autoContinue: Map }。 */
export function __switchConfigForTest() {
  return getSwitchGroupsForTest();
}

/** 测试钩子：重置模块级单例状态（单测在场景之间调用）。 */
export function __resetForTest() {
  resetDomainForTest();
  resetMemberModelCacheForTest();
  // 2026-09-27：开关缓存是模块级状态，测试场景之间必须清空，否则上一条用例的开关串到下一条。
  resetSwitchGroupsForTest();
  // 会话列表的落盘缓存/内存缓存同样是模块级状态，场景之间必须重置，
  // 否则上一条用例留下的缓存会让下一条「一次 inspect 都不做」，测不出真实行为。
  resetListCacheForTest(); // 清空列表落盘缓存与 TTL 缓存状态
  invalidateSessionListCache();
  resetAnalysisForTest(); // 清理待执行分析定时器 + 复位并发计数
  resetRuntimeStateForTest(); // 清理续跑定时器/锁/记账与扫描定时器
}

/** 设置 → 插件 → 插件配置 卡片命名空间（须与客户端 settings.plugin.item 的 key 一致）。 */
export const CONDUCTOR_SETTINGS_NS = {
  group: "session-conductor-group",
  compaction: "session-conductor-compaction",
};

/** 占位 schema：让 Host 把命名空间列入插件配置页；实际读写仍走 /api/session-conductor/*。 */
const PresenceSchema = Schema.object({
  present: Schema.boolean().default(true),
});

export async function apply(ctx, config = {}) {
  // 2026-08-20 修复（热重载兼容）：插件重载时旧 apply 的 disposer 会 close 持久化域，
  // 但模块级 domainPromise 缓存不失效 → 新 apply 复用已 closed 的域 → 所有读写报
  // "domain 'dsh_session_conductor' is closed"（list/value-analysis/search 全挂）。
  // 每次 apply 重置缓存，确保重新 open 域。
  // 改为条件重置。原代码无条件清缓存，遇到「旧的域还活着就重载」时
  // （多条目/热重载时序）会在活域上再 open 一次 → storage 报 already open → list 500。
  // 只有确认域已关闭（或从未打开）才清缓存；域还活着就复用同一份，不再重复 open。
  // 【原代码】此处为两行无条件重置：domainPromise = null 与 pushDomainPromise = null（push 域已随自动推送功能移除）
  if (!isDomainLive()) resetDomainForTest();
  setConfig({
    enabled: config?.enabled !== false,
    defaultAutoContinue: config?.defaultAutoContinue === true, // 缺省关闭，仅显式 true 开启
    failRetryDelayMs: num(config?.failRetryDelayMs, 0, 10 * 60 * 1000, DEFAULTS.failRetryDelayMs),
    titleStateSuffix: config?.titleStateSuffix === true, //  起默认取消状态后缀（吸收官方纯净标题），显式 true 才开启
    maxConcurrent: num(config?.maxConcurrent, 1, 8, DEFAULTS.maxConcurrent),
    maxAttached: num(config?.maxAttached, 1, 64, DEFAULTS.maxAttached),
    // 会话列表冷会话 inspect 并发上限（默认 2）——防一次性并发全量会话导致堆 OOM
    listInspectBatch: num(config?.listInspectBatch, 1, 16, DEFAULTS.listInspectBatch),
    // list 结果缓存时长（0=不缓存，即时最新；默认 5s 合并面板多组件同时刷新）
    listCacheMs: num(config?.listCacheMs, 0, 5 * 60 * 1000, DEFAULTS.listCacheMs),
    cooldownMs: num(config?.cooldownMs, 60 * 1000, 24 * 3600 * 1000, DEFAULTS.cooldownMs),
    maxContinuesPerSession: num(config?.maxContinuesPerSession, 1, 20, DEFAULTS.maxContinuesPerSession),
    turnTimeoutMs: num(config?.turnTimeoutMs, 60 * 1000, 6 * 3600 * 1000, DEFAULTS.turnTimeoutMs),
    scanIntervalMs: num(config?.scanIntervalMs, 30 * 1000, 24 * 3600 * 1000, DEFAULTS.scanIntervalMs),
    // 自动重命名模型路由（成对配置才生效；缺省 = 继承会话 request/header 的对话模型）
    autoRenameProvider: typeof config?.autoRenameProvider === "string" && config.autoRenameProvider !== "" ? config.autoRenameProvider : undefined,
    autoRenameModel: typeof config?.autoRenameModel === "string" && config.autoRenameModel !== "" ? config.autoRenameModel : undefined,
  });

  // 会话分组（原 dsh-session-group 已合并）：2026-09-26 起仅保留只读展示（status/list）
  // + 分组下新建会话（new-session，workspaceId 缺省 = 上次会话工作区）；分组管理能力回归
  // DSH 官方 workspace 机制。
  // 进程级兜底——宿主 bin.ts 未注册 unhandledRejection/uncaughtException 处理，
  // Node 15+ 默认 --unhandled-rejections=throw，任何插件的异步 rejection 逃逸都会**直接杀死
  // 整个 DSH 进程**（表现为「自动续跑跑一会进程就没了」）。这里注册兜底：仅记录日志、不退出，
  // 避免单个 promise 异常拖垮宿主；插件自身异步链已全部包 try/catch，这里防的是回归与未知路径。
  installProcessGuards(ctx);

  await registerGroupRoutes(ctx, {
    blockGroupNewSession: config?.blockGroupNewSession,
    enabled: config?.groupEnabled !== false,
  }, {
    // 承接会话（new-session 新建）默认开启自动重命名（2026-08-18 约定）
    setAutoRename: (sessionId, enabled) => patchSwitch(ctx, "autoRename", sessionId, { enabled }, { enabled: false }).catch((error) => {
      log(ctx, `承接会话自动重命名设置失败 ${sessionId}: ${String(error?.message ?? error)}`);
    }),
  }).catch((error) => {
    log(ctx, `会话分组模块初始化失败: ${String(error?.message ?? error)}`);
  });

  // 回合开始/结束 → 刷新标题状态后缀；回合结束还触发自动重命名 + 自动续跑判定。
  // 【 吸收官方 all-prompts 节奏】每条真人 user/message 后也触发自动重命名精炼
  // （analyzeSession 内部有「新增≥3条 + 5min 间隔」门槛兜底，不会每条都调 LLM）。
  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type === "turn/start" || type === "turn/end") {
      refreshTitleState(ctx, session).catch((error) => {
        log(ctx, `标题状态刷新失败 ${session?.id}: ${String(error?.message ?? error)}`);
      });
    }
    if (type === "user/message" && event?.data?.source?.kind === "user") {
      const sessionId = session?.id;
      if (typeof sessionId === "string") scheduleAnalysis(ctx, sessionId);
    }
    // 2026-08-20 自动续跑全局闸门：检测到「用户第一次手动对话」（turn/start 由 user 发起）
    // → 自动置 gate=open（放行自动续跑）。guardian 在 DSH 恢复健康时置 closed，
    // 这里保证「用户真的开始对话了」才恢复续跑，杜绝崩溃恢复后批量建空壳。
    if (type === "turn/start") {
      const data = event?.data ?? event;
      const byUser =
        data?.role === "user" ||
        data?.user === true ||
        data?.kind === "user" ||
        data?.source === "user";
      if (byUser) {
        pluginDomain(ctx)
          .then((domain) => {
            const st = domain.global.get();
            if ((st.autoContinueGate ?? "open") === "closed") {
              return domain.global.set({ ...st, autoContinueGate: "open" });
            }
            return null;
          })
          .then((changed) => {
            if (changed) log(ctx, "🔓 检测到用户手动对话，自动续跑闸门已开放（autoContinueGate=open）");
          })
          .catch((error) => {
            log(ctx, `自动续跑闸门开放失败（不影响会话）: ${String(error?.message ?? error)}`);
          });
      }
    }
    if (type !== "turn/end") return;
    const sessionId = session?.id;
    if (typeof sessionId !== "string") return;
    scheduleAnalysis(ctx, sessionId);
    maybeScheduleContinue(ctx, sessionId);
  });

  // 启动后延迟首扫（等持久化/其他服务就绪），随后周期扫描。
  const firstScan = setTimeout(() => {
    runAutoScan(ctx).catch((error) => {
      log(ctx, `自动续跑首扫失败: ${String(error?.message ?? error)}`);
    });
    scheduleScan(ctx);
  }, AUTO_CONTINUE_SCAN_DELAY_MS);
  firstScan.unref?.();
  ctx.effect(() => {
    return () => {
      clearTimeout(firstScan);
      const running = getScanTimer();
      if (running !== null) clearTimeout(running);
      for (const timer of continueTimers.values()) clearTimeout(timer);
      continueTimers.clear();
    };
  }, "session-conductor: timers");

  // 在 apply 的活跃 fiber 上预热持久化域并挂 close effect，避免 HTTP handler 首次打开踩 inactive context。
  pluginDomain(ctx).catch((error) => {
    log(ctx, `持久化域预热失败: ${String(error?.message ?? error)}`);
  });

  // 2026-09-27：启动即载入开关配置，并自动把所有自动续跑开关复位为关闭
  // （需求：每次 DSH 启动默认关闭，之后面板逐会话决定；autoRename 不复位）。
  resetAutoContinueOnStart(ctx).catch((error) => {
    log(ctx, `自动续跑开关启动复位失败: ${String(error?.message ?? error)}`);
  });

  // 设置 → 插件 → 插件配置：注册命名空间，浏览器卡片才能被 ConfigurablePluginsTab 配对渲染。
  // 卡片本身仍走 HTTP API，不把业务字段写进 settings.yaml。
  ctx.inject(["settings"], (sctx) => {
    try {
      const settings = sctx.get("settings");
      if (!settings) return;
      const base = { present: true };
      for (const ns of Object.values(CONDUCTOR_SETTINGS_NS)) {
        settings.register(ns, PresenceSchema, { base });
      }
      log(ctx, "已注册设置命名空间（插件配置页卡片）");
    } catch (e) {
      log(ctx, `设置命名空间注册失败: ${e?.message || e}`);
    }
  });

  // apply 运行时刻 webServer 的 fiber 可能尚未创建，必须走 inject。
  // 其余服务（workspaceRegistry / sessions / sessionPersistence / sessionTitle / llm / storageDomain）
  // 在请求到达时必然可用，用 ctx.get() 惰性解析并做空值兜底。
  ctx.inject(["webServer"], (wctx) => {
    const webServer = wctx.get("webServer");

    // ---------- GET /api/session-conductor/i18n ----------
    // 语言包外置 lib/i18n/{zh,en}.json（单份权威，改文案无需重打包 client bundle）：
    // 浏览器端 ModuleLoader 的 require 不支持相对路径 JSON（require("./i18n/*.json") 抛 missed-the-module-table），
    // 故由宿主侧读外置 JSON 经 HTTP 暴露、客户端 fetch 拉取合并（语言包外置做法）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/i18n",
      handler: async (req, res) => {
        try {
          if ((req.method ?? "GET") !== "GET") {
            return send(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
          }
          const zh = JSON.parse(readFileSync(new URL("./i18n/zh.json", import.meta.url), "utf8"));
          const en = JSON.parse(readFileSync(new URL("./i18n/en.json", import.meta.url), "utf8"));
          return send(res, 200, { ok: true, zh, en });
        } catch (error) {
          return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET /api/session-conductor/preview/<settings|panel> ----------
    // 真实后端预览页：单文件 html（assets/preview-*.html）经本路由同源服务，浏览器从 DSH 反代地址
    // 打开即同源 fetch /api/*（file:// 双击会被 CORS 拦——DSH API 不带 Access-Control-Allow-Origin）。
    // 用 kind:"exact" 枚举两个预览（DSH 的 kind:"prefix" 实测 401 不生效）
    const PREVIEW_FILES = {
      settings: new URL("../../assets/preview-settings.html", import.meta.url),
      panel: new URL("../../assets/preview-panel.html", import.meta.url),
    };
    const servePreview = async (req, res, name) => {
      try {
        if ((req.method ?? "GET") !== "GET") {
          return send(res, 405, { ok: false, error: { code: "METHOD", message: "Method Not Allowed" } });
        }
        const file = PREVIEW_FILES[name];
        if (!file) return send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知预览: " + name } });
        const html = readFileSync(file, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch (error) {
        return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(error?.message ?? error) } });
      }
    };
    for (const name of ["settings", "panel"]) {
      webServer.register({
        kind: "exact",
        path: "/api/session-conductor/preview/" + name,
        handler: (req, res) => servePreview(req, res, name),
      });
    }

    // ---------- GET /api/session-conductor/list ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/list",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          // list 流式（仅当请求声明 Accept: application/x-ndjson）——live 会话先快速
          // 写出，冷会话串行逐个解析边写边出，前端 fetch stream 逐行追加（每获取一个立即显示，
          // 不等全部）；排序由前端按 updatedAt 倒序插入保持（流式下后端不再整体排序）。
          // 默认（无 Accept 头/旧前端/预览页垫片）仍返回普通 JSON——兼容不匹配的调用方。
          const wantStream =
            /application\/x-ndjson/i.test(req.headers?.accept ?? "") || String(req.url ?? "").includes("stream=1");
          if (!wantStream) {
            const sessions = await buildSessionListCached(ctx);
            send(res, 200, { ok: true, sessions });
            return;
          }
          res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          if (res.socket?.setNoDelay) res.socket.setNoDelay(true);
          res.write(JSON.stringify({ ok: true, stream: true }) + "\n"); // 头行（前端跳过非会话行）
          const onItem = (item) => { try { res.write(JSON.stringify(item) + "\n"); } catch { /* 连接已断 */ } };
          await buildSessionListCached(ctx, { onItem, serial: true });
          try { res.end(); } catch { /* 连接已断 */ }
        } catch (error) {
          try {
            res.end(JSON.stringify({ ok: false, error: { code: "internal", message: String(error?.message ?? error) } }) + "\n");
          } catch { /* 连接已断 */ }
        }
      },
    });


    // ---------- GET/POST /api/session-conductor/templates ----------
    //  会话模板注入（）：plan（方案模板）/ closing（收尾模板）两个固定槽位，
    // 支持上传本地 md 文件或在线 md 网址（host 下载转存），内容落盘
    // <DSH_HOME>/template-inject-md/<slot>.md → systemPrompt section「session-templates」注入。
    // GET → {ok, slots: {plan:{enabled,name,url,bytes,updatedAt}, closing:{...}}, maxBytes}
    // POST {slot, enabled?} → 只改开关；
    // POST {slot, name, content} → 上传本地 md；
    // POST {slot, url} → 在线 md 网址下载转存；
    // POST {slot, action:"remove"} → 清空槽位。
    {
      const tplHome = resolveDshHome(ctx, cfg);
      // 浏览根与选用校验根唯一来源 = resolveBrowseRoot（工作区目录）。
      // 同一 browseRoot 变量贯穿本块内两个路由：/templates 的 pickPath 校验、/templates/dir 浏览。
      // 落盘仍 tplHome（DSH_HOME/template-inject-md/），浏览/校验/落盘三者职责清晰。
      const browseRoot = resolveBrowseRoot(ctx, cfg);
      if (tplHome) {
        webServer.register({
          kind: "exact",
          path: "/api/session-conductor/templates",
          handler: async (req, res) => {
            try {
              // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
              if (req.method !== "GET") invalidateSessionListCache();
              const domain = await pluginDomain(ctx);
              const st = domain.global.get();
              const meta = st.sessionTemplates ?? structuredClone(TEMPLATE_DEFAULTS);
              templateStateCache = meta;
              // 构造带 content 的 slots（GET/POST 统一：导入/编辑后前端编辑框直接读到内容）
              const buildSlotsWithContent = (meta2) => {
                const out = {};
                for (const slot of TEMPLATE_SLOTS) {
                  const m = meta2[slot] ?? { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 };
                  let content = "";
                  if (m.bytes > 0 || m.name) {
                    // readTemplateSync 返回 sanitized 字符串（无文件/不可读返回空串），不是 {ok,text} 对象
                    try { content = String(readTemplateSync(tplHome, slot) ?? "").slice(0, TEMPLATE_MAX_BYTES); } catch { content = ""; }
                  }
                  out[slot] = { ...m, content };
                }
                return out;
              };
              if (req.method === "GET") {
                return send(res, 200, { ok: true, slots: buildSlotsWithContent(meta), maxBytes: TEMPLATE_MAX_BYTES });
              }
              if (req.method === "POST") {
                const body = await readJson(req);
                // 目录内选用 md 文件（action="pickPath"）——校验用工作区浏览根，落盘用 DSH_HOME
                if (body?.action === "pickPath") {
                  const slot = String(body?.slot ?? "");
                  if (!TEMPLATE_SLOTS.includes(slot)) {
                    return send(res, 400, { ok: false, error: { code: "bad-slot", message: `模板槽位须为 ${TEMPLATE_SLOTS.join("|")}` } });
                  }
                  const saved = await saveTemplateFromPath(browseRoot, slot, body.path, tplHome);
                  if (!saved.ok) return send(res, 400, saved);
                  const cur = meta[slot] ?? { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 };
                  const next = {
                    ...meta,
                    [slot]: {
                      enabled: cur.enabled,
                      enforce: cur.enforce === true,
                      name: saved.name || cur.name,
                      url: "",
                      bytes: saved.bytes,
                      updatedAt: Date.now(),
                    },
                  };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: `模板「${slot}」已从目录选用（${saved.name}），记得点「开启注入」` });
                }
                const slot = String(body?.slot ?? "");
                if (!TEMPLATE_SLOTS.includes(slot)) {
                  return send(res, 400, { ok: false, error: { code: "bad-slot", message: `模板槽位须为 ${TEMPLATE_SLOTS.join("|")}` } });
                }
                const cur = meta[slot] ?? { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 };
                if (body?.action === "remove") {
                  const r = await removeTemplate(tplHome, slot);
                  if (!r.ok) return send(res, 400, r);
                  const next = { ...meta, [slot]: { ...cur, enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 } };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: `模板「${slot}」已清空` });
                }
                let saved = null;
                if (typeof body?.url === "string" && body.url.trim()) {
                  saved = await saveTemplateFromUrl(tplHome, slot, body.url);
                } else if (typeof body?.content === "string") {
                  // 编辑保存：可只带 content（name 保留现值）；也可带 name（本地导入）
                  saved = await saveTemplate(tplHome, slot, { name: (typeof body?.name === "string" && body.name.trim()) ? body.name : cur.name, content: body.content });
                }
                if (saved && saved.ok) {
                  const next = {
                    ...meta,
                    [slot]: {
                      enabled: cur.enabled, // 上传内容不自动开，用户再点开关
                      enforce: cur.enforce === true,
                      name: saved.name || cur.name,
                      url: typeof body?.url === "string" && body.url.trim() ? body.url.trim() : "",
                      bytes: saved.bytes,
                      updatedAt: Date.now(),
                    },
                  };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: `模板「${slot}」已保存，记得点「开启注入」` });
                }
                if (saved && !saved.ok) return send(res, 400, saved);
                if (typeof body?.enabled === "boolean") {
                  const next = { ...meta, [slot]: { ...cur, enabled: body.enabled } };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: body.enabled ? `模板「${slot}」已开启注入` : `模板「${slot}」已关闭` });
                }
                // 方案模板强制门禁开关（{slot:"plan", enforce:bool}）——即时生效，无需重启
                if (slot === "plan" && typeof body?.enforce === "boolean") {
                  const next = { ...meta, plan: { ...cur, enforce: body.enforce } };
                  templateStateCache = next;
                  await domain.global.set({ ...st, sessionTemplates: next });
                  return send(res, 200, { ok: true, slots: buildSlotsWithContent(next), message: body.enforce
                    ? `方案模板强制门禁已开启（未出提案并获确认前，代码修改类工具调用被拒绝）`
                    : `方案模板强制门禁已关闭` });
                }
                return send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 {slot, name, content}（本地 md）、{slot, url}（在线 md）、{slot, enabled} 或 {slot:'plan', enforce}" } });
              }
              return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET/POST" } });
            } catch (error) {
              send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
            }
          },
        });

        // ---------- GET /api/session-conductor/templates/dir ----------
        //  模板目录浏览（「在工作区目录内找」）：列 DSH 工作区目录树内一层目录。
        // 浏览根与选用校验根同源（上方 browseRoot）；落盘仍在 DSH_HOME/template-inject-md/。
        // GET ?path=... → {ok, path, parent, entries:[{name,path,isDir,isMd}]}（缺省从工作区根开始）
        if (browseRoot) {
          webServer.register({
            kind: "exact",
            path: "/api/session-conductor/templates/dir",
            handler: async (req, res) => {
              try {
                // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
                if (req.method !== "GET") invalidateSessionListCache();
                if (req.method !== "GET") return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET" } });
                const url = new URL(req.url, "http://localhost");
                const path = url.searchParams.get("path") ?? "";
                const r = await listTemplateDir(browseRoot, path);
                if (!r.ok) return send(res, 400, r);
                return send(res, 200, r);
              } catch (error) {
                send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
              }
            },
          });
        }
      }
    }

    // ---------- GET /api/session-conductor/fts-status ----------
    // 全文搜索诊断（ 并入，原独立插件 dsh-session-search 已合并）：
    // 报告官方 FTS5（sessionQuery）是否挂载 + 内置 zstd 扫描兜底是否可用。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/fts-status",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const sessionQuery = ctx.get("sessionQuery");
          const sessionEvents = ctx.get("sessionEvents");
          send(res, 200, {
            ok: true,
            plugin: "dsh-session-conductor",
            sessionQueryMounted: sessionQuery !== void 0,
            ftsMode: sessionQuery === void 0 ? "unavailable" : "first-search",
            builtinScanAvailable: typeof searchSessions === "function",
            note:
              sessionQuery === void 0
                ? "官方 FTS5 服务未挂载（检查 session-query-sqlite openAt 配置），使用内置 zstd 扫描兜底"
                : "官方 FTS5 内容搜索已解锁（openAt: first-search），内置 zstd 扫描为兜底",
          });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET/POST /api/session-conductor/compaction-model ----------
    // 压缩模型选择（2026-08-20）：会话模型旁单独选压缩用模型。
    // GET → {ok, compactionModel: {provider,model}|null, follow: true(跟随会话模型)}
    // POST {provider, model} → 设置；POST {follow:true} → 重置为跟随会话模型
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/compaction-model",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const domain = await pluginDomain(ctx);
          const state = domain.global.get();
          const cur = state.compactionModel ?? null;
          if (req.method === "GET") {
            return send(res, 200, { ok: true, compactionModel: cur, follow: cur === null });
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            if (body?.follow === true) {
              await domain.global.set({ ...state, compactionModel: null });
              return send(res, 200, { ok: true, compactionModel: null, follow: true, message: "压缩模型已重置为跟随会话模型" });
            }
            const provider = String(body?.provider ?? "").trim();
            const model = String(body?.model ?? "").trim();
            if (!provider || !model) return send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 provider 和 model" } });
            await domain.global.set({ ...state, compactionModel: { provider, model } });
            return send(res, 200, { ok: true, compactionModel: { provider, model }, follow: false, message: `压缩模型已设为 ${provider}/${model}（重启后生效）` });
          }
          return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET/POST" } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET/POST /api/session-conductor/auto-rename-model ----------
    // 自动重命名模型选择：设置页「DSH 同款解析选择器」选定。
    // GET → {ok, selection: {provider,model}|null, follow: true(跟随会话模型), catalog}
    //   catalog = 官方 modelCatalog（provider 分组 + 模型 + 默认），供前端渲染选择器。
    // POST {provider, model} → 设置；POST {follow:true} → 重置为跟随会话模型。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-rename-model",
      handler: async (req, res) => {
        try {
          const domain = await pluginDomain(ctx);
          const state = domain.global.get();
          const cur = state.autoRenameModel ?? null;
          if (req.method === "GET") {
            // 官方解析选择器的数据源：provider 分组 + 模型列表 + 部署默认
            let catalog = null;
            try {
              const sc = ctx.get("sessionController");
              catalog = sc?.modelCatalog ? await sc.modelCatalog() : null;
            } catch (error) {
              log(ctx, `auto-rename-model: 官方 modelCatalog 获取失败（前端仍可手动输入）: ${String(error?.message ?? error)}`);
              catalog = null;
            }
            return send(res, 200, { ok: true, selection: cur, follow: cur === null, catalog });
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            if (body?.follow === true) {
              await domain.global.set({ ...state, autoRenameModel: null });
              return send(res, 200, { ok: true, selection: null, follow: true, message: "自动重命名模型已重置为跟随会话模型" });
            }
            const provider = String(body?.provider ?? "").trim();
            const model = String(body?.model ?? "").trim();
            if (!provider || !model) return send(res, 400, { ok: false, error: { code: "bad-request", message: "需要 provider 和 model" } });
            await domain.global.set({ ...state, autoRenameModel: { provider, model } });
            return send(res, 200, { ok: true, selection: { provider, model }, follow: false, message: `自动重命名模型已设为 ${provider}/${model}` });
          }
          return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET/POST" } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- GET/POST /api/session-conductor/auto-continue-gate ----------
    // 自动续跑全局闸门（2026-08-20，与 guardian 联动）：
    //   GET → {ok, gate: "open"|"closed", note}
    //   POST {gate:"open"|"closed"} → 设置；closed 时一切自动续跑跳过（周期扫描/scan 自动续跑部分）
    //   guardian 在 DSH 恢复健康时置 closed；用户手动开启或首次手动对话（turn/start user）后自动置 open
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-continue-gate",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const domain = await pluginDomain(ctx);
          const state = domain.global.get();
          const cur = state.autoContinueGate ?? "open";
          if (req.method === "GET") {
            return send(res, 200, {
              ok: true,
              gate: cur,
              note: cur === "closed"
                ? "自动续跑全局闸门关闭：一切自动续跑跳过（DSH 刚启动/崩溃恢复后），用户手动开启或第一次手动对话后自动放行"
                : "自动续跑全局闸门开放：按原有判定（单会话开关 → 全局默认）",
            });
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            const gate = String(body?.gate ?? "");
            if (gate !== "open" && gate !== "closed") {
              return send(res, 400, { ok: false, error: { code: "bad-request", message: 'gate 必须为 "open" 或 "closed"' } });
            }
            await domain.global.set({ ...state, autoContinueGate: gate });
            return send(res, 200, {
              ok: true,
              gate,
              message: gate === "closed" ? "自动续跑闸门已关闭（所有自动续跑暂停）" : "自动续跑闸门已开放",
            });
          }
          return send(res, 405, { ok: false, error: { code: "method", message: "仅 GET/POST" } });
        } catch (error) {
          send(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/archive ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/archive",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const registry = ctx.get("workspaceRegistry");
          if (!registry) throw new Error("workspaceRegistry 服务不可用");
          // 归档时给标题加「[工作区名] 」前缀（数据层带前缀，面板显示剥离，已归档视图按前缀分组）。
          // 读会话 → 取原标题 → 加前缀 → rename（幂等：已带前缀不叠加）。失败不阻断归档。
          try {
            const sessions = ctx.get("sessions");
            const titleService = ctx.get("sessionTitle");
            const session = sessions?.get(body.sessionId);
            const cwd = session?.header?.cwd ?? null;
            const ws = workspaceNameOf(ctx, cwd);
            const currentTitle = titleString(titleService?.get(session)) ?? (session ? foldTitle(session.events) : null) ?? "";
            if (titleService && ws !== "" && currentTitle !== "") {
              const { title: newTitle } = archiveTitleWithWs(currentTitle, ws);
              if (newTitle !== currentTitle) {
                titleService.rename(session, newTitle);
                log(ctx, `归档加工作区前缀 ${body.sessionId}: "${currentTitle}" → "${newTitle}"`);
              }
            }
          } catch (titleError) {
            log(ctx, `归档标题加前缀失败（不阻断归档）: ${String(titleError?.message ?? titleError)}`);
          }
          await registry.archiveSession(body.sessionId);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "archive-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/unarchive ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/unarchive",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          // 取消归档时去掉「[工作区名] 」前缀还原原标题（数据层带前缀，取消归档即还原）。
          try {
            const sessions = ctx.get("sessions");
            const titleService = ctx.get("sessionTitle");
            const session = sessions?.get(body.sessionId);
            const currentTitle = titleString(titleService?.get(session)) ?? (session ? foldTitle(session.events) : null) ?? "";
            if (titleService && currentTitle !== "") {
              const { title: stripped } = stripArchiveWsPrefix(currentTitle);
              if (stripped !== currentTitle) {
                titleService.rename(session, stripped);
                log(ctx, `取消归档还原标题 ${body.sessionId}: "${currentTitle}" → "${stripped}"`);
              }
            }
          } catch (titleError) {
            log(ctx, `取消归档还原标题失败（不阻断）: ${String(titleError?.message ?? titleError)}`);
          }
          await unarchiveSession(ctx, body.sessionId);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "unarchive-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const result = await deleteSession(ctx, body.sessionId);
          if (!result.ok) return send(res, 409, result);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/undo-message ----------
    // 撤回最后一条用户消息：直接操作会话日志文件，删除最后一条 user/message
    // 及其后的整轮回复；dryRun=true 只返回预览（消息文本/将删事件数）不执行；二次确认由前端做。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/undo-message",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const result = await undoLastMessage(ctx, body.sessionId, { dryRun: body?.dryRun === true });
          if (!result.ok) return send(res, 409, result);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "undo-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete-batch ----------
    // 批量删除：逐条复用删除链路（per-session 串行锁/幂等），运行中跳过不整体失败
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete-batch",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          // 2026-08-20 修复：空数组（[]）是合法幂等请求，应返回空结果而非报错；
          // 仅「未传/非数组」才视为参数缺失
          if (body?.sessionIds !== void 0 && !Array.isArray(body.sessionIds)) {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "sessionIds 必须是数组" } });
          }
          const result = await deleteBatchSessions(ctx, body?.sessionIds ?? []);
          send(res, 200, { ok: true, ...result });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-batch-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/delete-by-rule ----------
    // 按条件删除：归档状态/超期未活跃/cwd 前缀；dryRun=true 预览不执行
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/delete-by-rule",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const result = await deleteByRule(ctx, {
            archivedOnly: body?.archivedOnly === true,
            inactiveDays: typeof body?.inactiveDays === "number" && Number.isFinite(body.inactiveDays)
              ? Math.min(3650, Math.max(0, Math.round(body.inactiveDays)))
              : 0,
            cwdPrefix: typeof body?.cwdPrefix === "string" ? body.cwdPrefix : "",
            dryRun: body?.dryRun === true,
          });
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "delete-by-rule-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/search ----------
    // 全文搜索：跨会话搜消息内容，返回命中会话 + 上下文片段
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/search",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const query = typeof body?.query === "string" ? body.query : "";
          const scope = ["all", "active", "archived"].includes(body?.scope) ? body.scope : "all";
          if (query.trim().length < SEARCH_MIN_QUERY) {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: `关键词至少 ${SEARCH_MIN_QUERY} 个字符` } });
          }
          const result = await searchSessions(ctx, query, { scope });
          send(res, 200, { ok: true, ...result });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "search-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/auto-rename ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-rename",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const enabled = body.enabled === true;
          const setting = await patchSwitch(ctx, "autoRename", body.sessionId, { enabled }, { enabled: false });
          let analyzed = null;
          if (enabled) analyzed = await runAnalysis(ctx, body.sessionId); // 开启后立即分析一次
          send(res, 200, { ok: true, enabled: setting.enabled, analyzed });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "auto-rename-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/analyze ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/analyze",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const result = await runAnalysis(ctx, body.sessionId, {
            manual: true, // 手动 API：跳过限频/新消息数门槛（显式意图即执行）
            model: typeof body?.model === "string" && body.model !== "" ? body.model : undefined,
          });
          if (!result.ok) return send(res, 409, result);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "analyze-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/continue ----------
    // 手动续跑：异步执行（回合可能耗时数分钟），立即返回 accepted，列表用 continueRunning 反映进行中。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/continue",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const sessionId = body.sessionId;
          const running = continueJobs.has(sessionId) || (() => {
            try {
              const agent = ctx.get("agents")?.get(sessionId);
              return agent?.status === "running";
            } catch {
              return false;
            }
          })();
          if (running) {
            return send(res, 409, { ok: false, error: { code: "busy", message: "该会话已有续跑/回合在进行中" } });
          }
          continueSession(ctx, sessionId, { auto: false }).then((result) => {
            if (!result?.ok) log(ctx, `手动续跑 ${sessionId} 未成功: ${result?.error?.message ?? "?"}`);
          }).catch((error) => {
            // 手动续跑异步链兜底——continueSession 永不 reject（prepare 段已包 try），
            // 此处再兜一层防未来回归把 rejection 逃逸成 unhandledRejection 杀进程。
            log(ctx, `手动续跑 ${sessionId} 异常: ${String(error?.message ?? error)}`);
          });
          send(res, 200, { ok: true, accepted: true, sessionId });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "continue-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/message ----------
    // 跨会话消息投递（2026-08-20）：{targetSessionId, message, fromSessionId?}
    // 向目标会话投递用户消息并唤起（live followup / cold resume+followup），不受"中断"限制。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/message",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const sessionId = body?.targetSessionId || body?.sessionId;
          const text = body?.message;
          if (typeof sessionId !== "string" || sessionId === "" || typeof text !== "string" || text === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 targetSessionId 或 message" } });
          }
          // 异步执行（回合可能耗时），立即返回 accepted
          const r = await sendMessageToSession(ctx, sessionId, text, { fromSessionId: body?.fromSessionId || "" });
          return send(res, r.ok ? 200 : (r.error?.code === "not-found" ? 404 : 400), r);
        } catch (error) {
          return send(res, 400, { ok: false, error: { code: "message-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/auto-continue ----------
    // 开启/关闭某会话的自动续跑（显式 enabled 覆盖全局默认）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/auto-continue",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const enabled = body.enabled === true;
          // 2026-09-27：开关落盘 config.json；先取旧 entry 保留记账字段，enabled 以本次为准。
          const entry = readSwitch("autoContinue", body.sessionId) ?? {};
          await patchSwitch(ctx, "autoContinue", body.sessionId, { ...entry, enabled });
          // 开启开关即触发一次续跑（force 跳过失败重试延迟）——原先要等最长
          // scanIntervalMs（默认 5 分钟）周期扫描才续，用户体感「打开后处理中很久」。
          // 关闭开关不触发；开启是幂等触发点，重复点不会叠加（内部有会话串行锁 + 门槛）。
          if (enabled) {
            runAutoContinueSession(ctx, body.sessionId, { force: true }).catch((error) => {
              log(ctx, `开启自动续跑后立即续跑失败 ${body.sessionId}: ${String(error?.message ?? error)}`);
            });
          }
          send(res, 200, { ok: true, enabled, sessionId: body.sessionId, triggered: enabled });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "auto-continue-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/scan ----------
    // 立即扫描一次全部会话并自动续跑（测试/手动触发用）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/scan",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          runAutoScan(ctx).then((count) => {
            log(ctx, `手动扫描完成（排队 ${count ?? 0}）`);
          }).catch((error) => {
            log(ctx, `手动扫描失败: ${String(error?.message ?? error)}`);
          });
          send(res, 200, { ok: true, accepted: true });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "scan-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/detach ----------
    // 手动释放（置为不活跃）：把 live 空闲会话拆回冷状态（日志保留，可重新挂载）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/detach",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.sessionId !== "string" || body.sessionId === "") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 sessionId" } });
          }
          const result = await detachSessionAgent(ctx, body.sessionId);
          if (!result.ok) return send(res, 409, result);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "detach-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/detach-all ----------
    // 释放全部 live 空闲会话（跳过运行中 / subagent / 续跑中）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/detach-all",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const result = await detachAllIdleSessions(ctx);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "detach-all-failed", message: String(error?.message ?? error) } });
        }
      },
    });


    // ---------- 会话日志修复（扫描/修复损坏会话） ----------
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-sessions",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const { supportsRepair } = await lazyRepair();
          if (!supportsRepair(ctx)) {
            return send(res, 501, { ok: false, error: { code: "unsupported", message: "当前持久化后端不支持修复（需要 jsonl 后端）" } });
          }
          const dryRun = body?.dryRun === true;
          const { scanCorruptSessions, repairCorruptSessions } = await lazyRepair();
          const report = dryRun ? await scanCorruptSessions(ctx) : await repairCorruptSessions(ctx, { dryRun: false });
          if (report.error) return send(res, 500, { ok: false, error: { code: "repair-failed", message: report.error } });
          send(res, 200, { ok: true, dryRun, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/repair-frames ----------
    // 会话日志 zstd 帧修复（救援恢复，2026-08-19）：会话列表消失/corrupt Zstandard 时，
    // 扫描并修复帧损坏（逐帧解码→多帧正确写回，自动备份）。与 repair-sessions 互补：
    // repair-sessions 修 tool-result content 结构；repair-frames 修 zstd 帧格式。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-frames",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const dryRun = body?.dryRun === true;
          const { scanCorruptFrames, repairCorruptFrames } = await lazyRepair();
          const report = dryRun ? await scanCorruptFrames() : await repairCorruptFrames({ dryRun: false });
          send(res, 200, { ok: true, dryRun, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-frames-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/repair-seq-gap ----------
    // 会话日志 seq-gap + token-surface 修复（2026-08-24 实测）：
    //   seq gap 错位（spliced 拼接未重编号）+ replace 引用缺失 + compaction shadowedRange 未映射
    //   三层叠加导致 history unavailable（token surface: no adjacent shadow price）。
    //   dryRun=true 扫描全部会话列出疑似 seq-gap；sessionId 指定则修复单个（自动备份 .seq-gap-backup/）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-seq-gap",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const sessionsRoot = path.join(process.env.DSH_HOME || path.join(process.env.HOME ?? "", ".dsh"), "sessions");
          if (body?.dryRun === true) {
            const { scanSeqGapSessions } = await lazySeqGap();
            const list = await scanSeqGapSessions(sessionsRoot);
            send(res, 200, { ok: true, dryRun: true, corrupt: list, total: list.length });
            return;
          }
          const sessionId = body?.sessionId;
          if (!sessionId) { send(res, 400, { ok: false, error: { code: "session-id-required", message: "need sessionId" } }); return; }
          // 定位会话日志路径（sessionId 需含 session- 前缀，cwd 目录未知 → 全仓查找）
          const { readdirSync, existsSync } = await import("node:fs");
          let targetPath = null;
          for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
            if (!proj.isDirectory()) continue;
            const p = findSessionLog(path.join(sessionsRoot, proj.name, sessionId));
            if (p) { targetPath = p; break; }
          }
          if (!targetPath) { send(res, 404, { ok: false, error: { code: "session-not-found", message: sessionId } }); return; }
          const { repairSeqGap } = await lazySeqGap();
          const report = await repairSeqGap(targetPath, { dryRun: false });
          send(res, report.ok ? 200 : 400, { ok: report.ok, sessionId, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-seq-gap-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/repair-eio ----------
    // 会话日志 EIO 坏块修复（2026-09-06 实测固化，来源 sa6400-nested-vm-io-panic skill）：
    //   底层存储（BTRFS csum 损坏 / iSCSI LUN I/O 错误）导致 session.jsonl.zstd 某些 4KB 块
    //   读取抛 EIO（Errno 5）→ 网关 observe 会话报 "EIO: i/o error, read"。
    //   修复 = 块级探测找出第一个 EIO 边界 → 读 [0, 边界) 完好前缀 → 原子写回
    //   （BTRFS COW 换新块）→ DSH 加载时 readZstdPrefix/commitRepair 自动收尾 torn tail。
    //   dryRun=true 全仓扫描；sessionId 指定则修复单个（全仓定位）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-eio",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const { sessionsRootOf: eioSessionsRootOf } = await lazyEio();
          const sessionsRoot = eioSessionsRootOf();
          if (body?.dryRun === true) {
            const { scanEioSessions } = await lazyEio();
            const list = await scanEioSessions(sessionsRoot);
            send(res, 200, { ok: true, dryRun: true, eio: list.eio, total: list.total, healthy: list.healthy, error: list.error });
            return;
          }
          const sessionId = body?.sessionId;
          if (sessionId) {
            // 定位会话日志路径（sessionId 需含 session- 前缀，cwd 目录未知 → 全仓查找）
            const { readdirSync, existsSync } = await import("node:fs");
            let targetPath = null;
            for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
              if (!proj.isDirectory()) continue;
              const p = findSessionLog(path.join(sessionsRoot, proj.name, sessionId));
              if (p) { targetPath = p; break; }
            }
            if (!targetPath) { send(res, 404, { ok: false, error: { code: "session-not-found", message: sessionId } }); return; }
            const { repairEioFile } = await lazyEio();
            const report = await repairEioFile(targetPath);
            send(res, report.ok ? 200 : 400, { ok: report.ok, sessionId, report });
            return;
          }
          const { repairEioSessions } = await lazyEio();
          const report = await repairEioSessions({ dryRun: false });
          send(res, 200, { ok: true, dryRun: false, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-eio-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/repair-dual-format ----------
    // 双格式会话修复：会话目录同时存在 session.jsonl（明文）+ session.jsonl.zstd
    // （压缩）→ 官方 listArtifacts() 抛 encodingMismatch → 会话列表全失败（侧边栏会话消失）。
    // 纯磁盘级扫描（不走 sessionPersistence，后者自身会被 encodingMismatch 阻断），
    // 把多余明文移入 .dual-format-backup/ 保留 zstd 官方格式；dryRun=true 只扫不写。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/repair-dual-format",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const dryRun = body?.dryRun === true;
          // live 会话跳过：正在写入的会话不应被移动（按 id 查 sessions 服务）
          let skipIds = [];
          try {
            const sessionsSvc = ctx.get("sessions");
            skipIds = (sessionsSvc?.list?.() ?? []).map((s) => s.id);
          } catch {
            // sessions 服务不可用时不做 live 跳过（保守：仍只移非 live 目录）
          }
          const report = dryRun
            ? await (await lazyRepair()).scanDualFormatSessions()
            : await repairDualFormatSessions({ dryRun: false, skipIds });
          if (report.error) {
            send(res, 500, { ok: false, error: { code: "repair-dual-format-failed", message: report.error } });
            return;
          }
          send(res, 200, { ok: true, dryRun, skipped: report.skipped ?? 0, report });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "repair-dual-format-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- POST /api/session-conductor/value-analysis ----------
    // 会话价值分析（ 规则判定 +  特征/LLM/关键词价值）：
    //   规则分类 completed/unfinished/stale/active + 最后回复摘要；
    //   高/低价值 = assessValue 特征评分（活跃/长度/完成/未完成/细节补充）；
    //   可选 body.keywords=[...] 记录指定关键词 → 标题/最后用户消息命中任一关键词的会话无条件最高价值；
    //   可选 body.llm=true 额外用 LLM 打分（fail-soft）。
    webServer.register({
      kind: "exact",
      path: "/api/session-conductor/value-analysis",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const staleDays = typeof body?.staleDays === "number" && Number.isFinite(body.staleDays)
            ? Math.min(90, Math.max(1, Math.round(body.staleDays)))
            : 3;
          const useLlm = body?.llm === true;
          const sessions = await buildSessionListCached(ctx); // 价值分析走缓存（容忍 5s 陈旧，避免与面板刷新叠加扫描）
          // 一次性读取各会话事件（复用，避免大会话重复解压导致超时/失败）
          const eventsById = {};
          // 逐个会话读取最后 assistant 文本 + 最后用户消息（损坏/不可读会话跳过，用空串）
          const texts = {};
          const userTexts = {};
          for (const s of sessions) {
            try {
              const found = await sessionEventsOf(ctx, s.id);
              if (found) {
                eventsById[s.id] = found.events || [];
                const { lastAssistantText, lastUserText, filterSessionsByKeywords } = await lazyValue();
                texts[s.id] = lastAssistantText(found.events);
                userTexts[s.id] = lastUserText(found.events);
              }
            } catch {
              /* 单会话失败跳过 */
            }
          }
          // 可选 LLM 高/低价值判断
          let llmById = {};
          if (useLlm) {
            llmById = await analyzeValueWithLlm(ctx, sessions, texts, (m) => log(ctx, m));
          }
          // 特征评分（活跃/长度/完成/未完成/细节补充）+ 关键词命中→无条件最高
          const featuresById = {};
          for (const s of sessions) {
            try {
              const { buildValueFeatures } = await lazyValue();
              featuresById[s.id] = buildValueFeatures(eventsById[s.id] || [], s, new Date());
            } catch {
              const { buildValueFeatures: buildValueFeatures2 } = await lazyValue();
              featuresById[s.id] = buildValueFeatures2([], s, new Date());
            }
          }
          const keywords = Array.isArray(body?.keywords) ? body.keywords : [];
          const { analyzeValuesWithKeywords } = await lazyValue();
          const result = analyzeValuesWithKeywords(sessions, texts, userTexts, featuresById, keywords, llmById, new Date(), staleDays);
          const counts = {};
          for (const key of Object.keys(result)) counts[key] = result[key].length;
          send(res, 200, {
            ok: true,
            staleDays,
            llm: !!useLlm,
            keywords: keywords.length ? keywords : void 0,
            keywordHits: keywords.length ? filterSessionsByKeywords(sessions, texts, userTexts, keywords, new Date()) : [],
            generatedAt: Date.now(),
            counts,
            completed: result.completed,
            unfinished: result.unfinished,
            stale: result.stale,
            active: result.active,
            high: result.high,
            low: result.low,
          });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "value-analysis-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    // ---------- 任务完成汇报（task-completion-report 管道） ----------
    // 收尾约定不再由代码写死注入 systemPrompt——改由模板注入「收尾模板」槽位承担
    // （设置 → 会话管理 → 模板注入 → closing，可自定义内容）。render/check 校验工具保留。
    webServer.register({
      kind: "exact",
      path: "/api/task-completion/status",
      handler: async (req, res) => {
        send(res, 200, {
          ok: true,
          name: "dsh-session-conductor",
          skill: "task-completion-report",
          conventionSource: "template-inject:closing（ 起不再代码写死，由收尾模板槽位注入）",
          tools: ["task_completion_render", "task_completion_check"]
        });
      },
    });

    webServer.register({
      kind: "exact",
      path: "/api/task-completion/render",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          const block = renderCompletionBlock(body);
          send(res, 200, { ok: true, block });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "render-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    webServer.register({
      kind: "exact",
      path: "/api/task-completion/check",
      handler: async (req, res) => {
        try {
          // 非 GET 请求会改动会话列表内容，先失效列表缓存，使面板随后的 refresh 立刻看到最新（而非 5s TTL 内的旧列表）。
          if (req.method !== "GET") invalidateSessionListCache();
          const body = await readJson(req);
          if (typeof body?.text !== "string") {
            return send(res, 400, { ok: false, error: { code: "bad-request", message: "缺少 text" } });
          }
          send(res, 200, { ok: true, ...checkCompletionText(body.text) });
        } catch (error) {
          send(res, 400, { ok: false, error: { code: "check-failed", message: String(error?.message ?? error) } });
        }
      },
    });

    log(ctx, `API 路由已注册 (/api/session-conductor/* + /api/task-completion/*)；自动续跑: enabled=${cfg.enabled}, 默认开启=${cfg.defaultAutoContinue}, maxAttached=${cfg.maxAttached}, maxConcurrent=${cfg.maxConcurrent}`);
  });


  // 任务完成汇报：约定注入每个 agent 系统提示 + 渲染/校验工具。
  // ──  方案模板强制门禁（tools/pre-execute waterfall）────────────────
  // 无状态判定：每次拦截从会话事件流现场推导门状态——「提案」= 确认消息之前那一段 AI 输出里
  // 同时含提案标题与确认段标记；「确认」= 最后一条真实用户消息命中确认词。重启零恢复问题，
  // 门状态永远由真实事件流现场推导。delegationDepth>0 的子 agent 会话豁免（子 agent 无法交互
  // 确认；主会话是强制执行点，注入文本约定主 AI 不得借委派绕过门禁）。
  // ⚠️ waterfall 契约：不拦时必须 next()，否则短路整条链（hooks 桥同款写法，见 PreToolUse 映射）。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      const meta = templateStateCache || TEMPLATE_DEFAULTS;
      if (meta?.plan?.enforce !== true) return next();
      const session = exec?.agent?.session;
      if (!session) return next();
      if ((session?.header?.delegationDepth ?? 0) > 0) return next();
      const name = String(exec?.name ?? "");
      let gated = PLAN_ENFORCE_EDIT_TOOLS.includes(name);
      if (!gated && name === "bash") {
        const cmd = exec?.arguments?.command ?? exec?.arguments?.cmd ?? "";
        gated = typeof cmd === "string" && PLAN_ENFORCE_BASH_WRITE_RE.test(cmd);
      }
      if (!gated) return next();
      if (planGateAllows(session.events)) return next();
      return { kind: "deny", reason: planEnforceDenyMessage(name) };
    } catch (error) {
      // 门禁自身故障 fail-open（不阻断工具链），只留痕
      log(ctx, `方案门禁判定异常（放行）: ${String(error?.message ?? error)}`);
      return next();
    }
  });

  // systemPrompt / tools 可能不在所有组合中，缺失时静默跳过，不影响插件其余功能。
  ctx.inject(["systemPrompt"], (sctx) => {
    try {
      sctx.get("systemPrompt").section({
        name: "task-completion-report",
        order: 1000,
        text: TASK_COMPLETION_CONVENTION
      });
    } catch (error) {
      log(ctx, `systemPrompt 注入失败: ${String(error?.message ?? error)}`);
    }
  });

  // 方案/收尾模板改走**上下文注入**（agent/pre-step，每 agent 首次 step 注入一次，
  // 参考同款形态）——不再塞 systemPrompt section（上下文与系统提示词是两回事，
  // 方案模板一条、收尾模板一条，各带自己的说明，一开始就注入）。
  // 模板内容同步读盘 + templateStateCache（templates API 写入后刷新），enabled 才注入对应条。
  const templateInjectedAgents = new WeakSet();
  if (typeof ctx?.on === "function") {
    const tplDshHome = resolveDshHome(ctx, cfg);
    // 成员模型切换（官方模式二：agent/request 瀑布流拦截）：按会话强制改写请求模型。
    // 不依赖官方「投影 pending + 请求头链」（那条链在新回合会回落部署默认模型），
    // override 由 set_member_model 写入（domain 持久 + 内存缓存镜像），每轮都改 → 跨轮持久。
    ctx.on("agent/request", async ({ agent }, next) => {
      const resolved = await next();
      const override = await getMemberModelOverride(ctx, agent?.session?.id);
      return applyModelOverride(resolved, override);
    });
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision?.kind === "reject" || signal?.aborted) return decision;
      if (!agent || templateInjectedAgents.has(agent)) return decision;
      templateInjectedAgents.add(agent);
      try {
        if (!tplDshHome) return decision;
        const metas = templateStateCache ?? TEMPLATE_DEFAULTS;
        const injected = [];
        for (const slot of TEMPLATE_SLOTS) {
          const text = collectTemplateSlotText(tplDshHome, slot, metas);
          if (!text) continue;
          injected.push(createUserMessage({
            content: [{ type: "text", text: `【dsh-session-conductor 模板注入（设置 → 会话管理 → 模板注入）】\n\n${text}` }],
            source: { kind: "plugin:dsh-session-conductor", plugin: "dsh-session-conductor", form: "instructions" },
          }));
        }
        if (injected.length === 0) return decision;
        return { ...decision, messages: [...(decision.messages || []), ...injected] };
      } catch (error) {
        log(ctx, `会话模板上下文注入失败: ${String(error?.message ?? error)}`);
        return decision;
      }
    });
  }


  ctx.inject(["tools"], (tctx) => {
    const tools = tctx.get("tools");
    tools.register(defineTool({
      name: "task_completion_render",
      description: "渲染任务完成汇报的标准收尾块（醒目分隔线 + ✅ 任务完成 + 交付/验证/遗留 三要素）。任务结束前调用，把返回的文本原样贴到回复结尾。",
      parameters: {
        delivered: { type: "string", description: "交付了什么：文件路径 / 功能 / 结论，可多行" },
        verified: { type: "string", description: "验证状态：实测通过 / 单测通过 / 待人工确认，必须如实" },
        remaining: { type: "string", description: "遗留事项：已知边界 / 待办 / 坑，没有可省略" },
        status: { type: "string", enum: VALID_STATUSES, description: "done=任务完成（默认） / partial=未完成 / failed=失败" }
      },
      output: {
        schema: { type: "string" },
        // ⚠️ 必须返回块数组：tool-result 的 block.content 落盘后会被
        // dsh-session 持久化校验器要求为数组（`message must contain one
        // tool-result block`）；返回纯字符串会导致会话日志损坏（history
        // unavailable）。与官方 bash 工具的 render 模式一致。
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute(args) {
        return renderCompletionBlock(args);
      }
    }));
    tools.register(defineTool({
      name: "task_completion_check",
      description: "校验一段文本是否符合任务完成收尾格式（分隔线/完成标记/交付/验证/遗留）。写完成汇报后自检用，返回缺失项。",
      parameters: {
        text: { type: "string", required: true, description: "要校验的文本（通常是回复的结尾段）" }
      },
      output: {
        schema: { type: "string" },
        // 与 task_completion_render 相同：block.content 必须是块数组，否则落盘损坏
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute(args) {
        const check = checkCompletionText(args.text);
        return check.ok
          ? "收尾格式合规"
          : `收尾格式缺项：${check.missing.join("、")}（分隔线/完成标记/交付/验证/遗留）`;
      }
    }));
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
    tools.register(defineTool({
      name: "set_member_model",
      description: "给指定成员/子代理切换模型（只影响该成员的会话，不动其他成员）。target 传成员名/sessionId/标题关键字；provider 是 list_models 里的分组名（如 agnes / wb），model 是该分组下的模型 id（如 global:deepseek-v4.1-flash）。切换前会校验组合是否存在，避免切到无效组合导致回合失败。",
      parameters: {
        target: { type: "string", required: true, description: "目标成员：成员名（如 model-test）、sessionId 或标题关键字" },
        provider: { type: "string", required: true, description: "provider 分组名（list_models 输出的顶层分组，如 agnes / wb / ai-gateway）" },
        model: { type: "string", required: true, description: "该 provider 下的模型 id（含前缀，如 global:deepseek-v4.1-flash / agnes-3.0-flash）" }
      },
      output: {
        schema: { type: "string" },
        render(args, value) {
          return [{ type: "text", text: String(value) }];
        }
      },
      async execute(args) {
        const provider = String(args?.provider ?? "").trim();
        const model = String(args?.model ?? "").trim();
        if (!provider || !model) return "切换失败：provider 和 model 都必填（先用 list_models 查确切值）";
        // 先校验组合有效性——无效组合会让后续回合的模型请求被拒（表现为「切换生效但回合失败」）
        const pair = await validateModelPair(ctx, provider, model);
        if (pair.error) return `切换失败：${pair.error}`;
        const found = findTargetAgent(ctx, args?.target);
        if (found.error) return `切换失败：${found.error}`;
        const result = await switchAgentModel(ctx, found.sessionId, provider, model, found.agent);
        if (result.error) return `切换失败：${result.error}`;
        const memberLabel = found.member?.name ? `${found.member.name}(${found.sessionId})` : found.sessionId;
        return `已把成员 ${memberLabel}（${found.matched} 匹配）切到 ${provider}/${model}；生效方式：${result.via}`;
      }
    }));
    log(ctx, "任务完成汇报工具已注册 (task_completion_render / task_completion_check)");
    log(ctx, "成员模型工具已注册 (list_models / set_member_model)");
  });
}


