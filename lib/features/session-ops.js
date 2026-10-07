/** 会话级操作：归档恢复、删除（单个/批量/按规则）、撤回最后一条消息。 */

import { rm, readdir } from "node:fs/promises";
import { readFileSync, copyFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import { hasOpenTurn } from "../sessions/turn.js";
import { lazyRepair, lazyZstd, lazyValue } from "../core/lazy.js";
import { pluginDomain } from "../core/domain.js";
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
import { sessionEventsOf } from "../sessions/events.js";
import { detachSessionAgent } from "../sessions/detach.js";
import { buildSessionListCached } from "../sessions/list.js";

// ---------- 插件开关配置（：落盘 <DSH_HOME>/session-conductor/config.json）----------
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
 * 新增：全局闸门 autoContinueGate === "closed" 时**一切自动续跑跳过**
 * ——与 guardian 联动，防崩溃恢复后自动续跑批量建空壳。
 * （错峰定时任务移除，原「窗口内强制开启」分支已删。）
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
export async function unarchiveSession(ctx, sessionId) {
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
      // 旧域残留清理（前落盘数据，此后开关以 config.json 为准）
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
        // 不能把注入内容误当用户消息撤回（实测缺陷修复）
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
    const undoTmpPath = filePath + ".undotmp";
    writeFileSync(undoTmpPath, newBuf);
    try { chmodSync(undoTmpPath, statSync(filePath).mode); } catch { /* CIFS 无 chmod，尽力 */ }
    renameSync(undoTmpPath, filePath);

    return { ok: true, preview, removedLineCount, removedEventCount, remainingEventCount: check.eventCount, backup: bak };
  });
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
  // 修复：预检会话是否存在（live 或已持久化），不存在的进 skipped(not-found)，
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
      const deleteResult = await deleteSession(ctx, id);
      if (deleteResult.ok) deleted.push(id);
      else skipped.push({ sessionId: id, reason: deleteResult.error?.code ?? "error" });
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
    const entry = {
      sessionId: s.id,
      title: s.title,
      cwd: s.cwd,
      archived: s.archived === true,
      updatedAt: s.updatedAt ?? null,
    };
    if (lowValue && lowById) entry.value = "low";
    return entry;
  });
  if (dryRun) return { ok: true, dryRun: true, matched: preview };
  const batchResult = await deleteBatchSessions(ctx, preview.map((session) => session.sessionId));
  return { ok: true, dryRun: false, matched: preview, deleted: batchResult.deleted, skipped: batchResult.skipped };
}
