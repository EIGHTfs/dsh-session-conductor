// dsh-session-conductor — 运行期配置与开关（插件全局状态）
//
// 【为什么单独成文件】cfg（运行期配置）与 switchGroups（自动重命名/自动续跑开关缓存）
// 是插件被几乎所有域读写的全局状态；集中在此可让各域 import 同一份，
// 不必反向依赖插件入口（避免循环引用），也让「配置从哪来、写到哪」只此一份实现。

import path from "node:path";
import { homedir } from "node:os";
import { readFile, mkdir } from "node:fs/promises";
import { writeFileSync, renameSync, statSync } from "node:fs";
import { log } from "../shared/log.js";

/** 插件默认配置（面板可改；cfg 的初值来源）。 */
export const DEFAULTS = {
  enabled: true, // 自动续跑总开关
  defaultAutoContinue: false, // 单会话默认关闭，面板可逐会话显式开启
  failRetryDelayMs: 30000, // 本轮运行失败识别后延迟续跑（默认 30s，避免立即重试）
  maxConcurrent: 2, // 全局同时续跑的会话数上限
  maxAttached: 12, // 活跃（attached）会话上限，达到后自动续跑暂停
  listInspectBatch: 2, // 会话列表「冷会话 inspect」并发上限（防一次性并发全量会话把内存打爆）
  listCacheMs: 5000, // 会话列表结果缓存时长（毫秒）——合并同一瞬间的多次 list 请求
  cooldownMs: 15 * 60 * 1000, // 同会话两次自动续跑最小间隔
  maxContinuesPerSession: 3, // 每会话自动续跑总次数上限（防死循环）
  turnTimeoutMs: 20 * 60 * 1000, // 单回合续跑最长等待，超时取消
  scanIntervalMs: 5 * 60 * 1000, // 周期扫描间隔
};

/** 运行期配置（面板/测试可改）。外部只读引用；改整体请用 setConfig。 */
export let cfg = { ...DEFAULTS };

/** 整体替换运行期配置（测试钩子 / 面板应用配置时用）。 */
export function setConfig(next) {
  cfg = { ...DEFAULTS, ...(next ?? {}) };
}

/**
 * 开关组缓存：autoRename / autoContinue 两组的「会话 → 开关/记账」。
 * 落盘在 <DSH_HOME>/session-conductor/config.json，内存是它的缓存。
 */
const switchGroups = { autoRename: new Map(), autoContinue: new Map() };

/** 解析 DSH 主目录：DSH_HOME 环境变量 > ~/.dsh */
export function resolveDshHome(ctx, c) {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return home ? path.join(home, '.dsh') : '';
}

/**
 * 模板/额外注入系统提示词的「目录浏览」根目录 = DSH 工作区目录（HOME/工作区），
 * 即工作区（skill 仓库、项目仓库都在其下），而不是 DSH 主目录（~/.dsh，只放落盘文件）。
 * 存在性探测：HOME/工作区 存在则用它；否则回退 DSH_HOME（老布局）。
 */
export function resolveBrowseRoot(ctx, c) {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const ws = home ? path.join(home, '工作区') : '';
  if (ws) {
    try { if (statSync(ws).isDirectory()) return ws; } catch { /* 不存在则回退 */ }
  }
  return resolveDshHome(ctx, c);
}

/** config.json 路径（<DSH_HOME>/session-conductor/config.json）。 */
export function pluginConfigPath(ctx) {
  const home = resolveDshHome(ctx, cfg);
  return home ? path.join(home, "session-conductor", "config.json") : "";
}

/** 读某组（autoRename/autoContinue）某会话的开关/记账（内存缓存；无记录返回 null）。 */
export function readSwitch(group, sessionId) {
  const map = switchGroups[group];
  return map?.get(sessionId) ?? null;
}

/** 改→写：更新缓存并原子落盘 config.json，返回更新后 entry。
 *  group ∈ "autoRename" | "autoContinue"；defaultEntry 为该组无记录时的基线。 */
export async function patchSwitch(ctx, group, sessionId, patch, defaultEntry = {}) {
  const map = switchGroups[group];
  if (!map) throw new Error(`未知开关组 ${group}`);
  const cur = map.get(sessionId) ?? defaultEntry;
  const next = { ...cur, ...patch };
  map.set(sessionId, next);
  await savePluginConfig(ctx);
  return next;
}

/** 从 config.json 载入两组开关到内存缓存（启动时/测试）。文件缺失或损坏 → 空配置。 */
export async function loadPluginConfig(ctx) {
  const file = pluginConfigPath(ctx);
  const parsed = {};
  if (file) {
    try {
      const j = JSON.parse(await readFile(file, "utf8"));
      if (j && typeof j === "object") Object.assign(parsed, j);
    } catch { /* 文件不存在/损坏 → 空配置 */ }
  }
  for (const group of Object.keys(switchGroups)) {
    const src = parsed[group] && typeof parsed[group] === "object" ? parsed[group] : {};
    switchGroups[group].clear();
    for (const [sid, e] of Object.entries(src)) if (e && typeof e === "object") switchGroups[group].set(sid, { ...e });
  }
}

/** 原子落盘 config.json（临时文件 + rename；保留未知顶层字段）。 */
export async function savePluginConfig(ctx) {
  const file = pluginConfigPath(ctx);
  if (!file) return;
  let rest = {};
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    if (j && typeof j === "object") rest = j;
  } catch { /* 文件不存在/损坏 → 全量写 */ }
  await mkdir(path.dirname(file), { recursive: true });
  const tmpPath = file + ".tmp";
  writeFileSync(tmpPath, JSON.stringify({
    ...rest,
    autoRename: Object.fromEntries(switchGroups.autoRename),
    autoContinue: Object.fromEntries(switchGroups.autoContinue),
  }, null, 2), "utf8");
  renameSync(tmpPath, file);
}

/** 启动复位：自动续跑开关全部置 false（每次 DSH 启动默认关闭；autoRename 不复位）。幂等。 */
export async function resetAutoContinueOnStart(ctx) {
  await loadPluginConfig(ctx);
  let anyOn = false;
  for (const e of switchGroups.autoContinue.values()) if (e?.enabled === true) { anyOn = true; break; }
  if (!anyOn) return;
  for (const [sid, e] of switchGroups.autoContinue) switchGroups.autoContinue.set(sid, { ...e, enabled: false });
  await savePluginConfig(ctx);
  log(ctx, "🔒 启动复位：自动续跑开关已全部关闭（面板可逐会话开启）");
}

/** 会话的自动重命名是否开启（读 config 缓存；兼容旧签名，state 忽略）。 */
export function autoRenameEnabled(ctx, state, sessionId) {
  return readSwitch("autoRename", sessionId)?.enabled === true;
}

/** 自动续跑是否生效：面板显式开关优先（读 config），否则跟随全局默认 defaultAutoContinue。 */
export function effectiveAutoContinue(cfgObj, state, sessionId) {
  const entry = readSwitch("autoContinue", sessionId);
  return entry?.enabled ?? cfgObj.defaultAutoContinue;
}

/** 测试钩子：清空开关缓存（单测在场景之间调用）。 */
export function resetSwitchGroupsForTest() {
  switchGroups.autoRename.clear();
  switchGroups.autoContinue.clear();
}

/** 删除某组某会话的开关记录（会话删除时清理），返回是否确实删掉了。 */
export function deleteSwitch(group, sessionId) {
  return switchGroups[group]?.delete(sessionId) ?? false;
}

/** 测试钩子：暴露开关组本身（单测直接断言缓存内容）。 */
export function getSwitchGroupsForTest() {
  return switchGroups;
}
