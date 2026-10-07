// dsh-session-conductor — 会话列表：落盘缓存与列表项组装
//
// 【职责】列表的「懒加载」基础：
//  ① 冷会话解析结果按 revision 落盘（<DSH_HOME>/storages/dsh-session-conductor/list-cache.json），
//     revision 未变则直接复用，零解析零内存；
//  ② buildColdSessionItem —— 让「缓存命中」与「刚解析完」两条路径产出完全一致的结构；
//  ③ 列表 TTL 缓存与失效（写操作后 invalidateSessionListCache 立即失效）。
// 列表的构建流程（buildSessionList）在 list.js。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { log } from "../shared/log.js";
import { cfg, resolveDshHome, autoRenameEnabled, effectiveAutoContinue } from "../core/config.js";
import { continueJobs } from "../core/state.js";
import { stripArchiveWsPrefix } from "../features/rename/title.js";

/** 缓存文件版本（不符视为空缓存）。 */
const LIST_CACHE_VERSION = 1;
/** 缓存文件所在子目录。 */
const LIST_CACHE_SUBDIR = ["storages", "dsh-session-conductor"];

/** 落盘缓存内容：{ version, entries: { [id]: { rev, title, updatedAt, interruption, inspectError, cwd, createdAt, parentSession } } } */
let listDiskCache = null;
let listDiskCachePath = null;
let listDiskCacheDirty = false;
let listDiskCacheTimer = null;

/** 缓存文件绝对路径（首次调用时解析并缓存）。 */
export function listCacheFilePath(ctx) {
  if (listDiskCachePath !== null) return listDiskCachePath;
  const home = resolveDshHome(ctx, cfg);
  listDiskCachePath = home ? path.join(home, ...LIST_CACHE_SUBDIR, "list-cache.json") : "";
  return listDiskCachePath;
}

/** 读落盘缓存（进程内只读一次）。任何异常都退化成空缓存，不向上抛。 */
export function loadListDiskCache(ctx) {
  if (listDiskCache !== null) return listDiskCache;
  listDiskCache = { version: LIST_CACHE_VERSION, entries: {} };
  const file = listCacheFilePath(ctx);
  if (!file) return listDiskCache;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version === LIST_CACHE_VERSION && parsed.entries !== null && typeof parsed.entries === "object") {
      listDiskCache = { version: LIST_CACHE_VERSION, entries: parsed.entries };
    }
  } catch {
    // 首次运行（文件不存在）/ 文件损坏 / JSON 非法：按空缓存继续，本次解析完会覆盖写入
  }
  return listDiskCache;
}

/** 标记脏并节流落盘（2s 合并，避免每解析一条会话就写一次盘）。 */
export function scheduleSaveListDiskCache(ctx) {
  listDiskCacheDirty = true;
  if (listDiskCacheTimer !== null) return;
  listDiskCacheTimer = setTimeout(() => {
    listDiskCacheTimer = null;
    saveListDiskCacheNow(ctx);
  }, 2000);
  listDiskCacheTimer.unref?.();
}

/** 立即原子落盘（写临时文件再 rename，避免下次启动读到半个文件）。 */
export function saveListDiskCacheNow(ctx) {
  if (!listDiskCacheDirty || listDiskCache === null) return;
  const file = listCacheFilePath(ctx);
  if (!file) return;
  listDiskCacheDirty = false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(listDiskCache), "utf8");
    renameSync(tmp, file);
  } catch (error) {
    // 落盘失败只是让下次重新解析，不影响列表功能；记录下来便于诊断
    log(ctx, `会话列表缓存落盘失败（不影响功能）: ${String(error?.message ?? error)}`);
  }
}

/** 立即标记为脏（用于「清理完缓存条目后强制落盘」）。 */
export function markListDiskCacheDirty() {
  listDiskCacheDirty = true;
}

/** 当前是否处于脏状态（构建段据此决定收尾是否落盘）。 */
export function isListDiskCacheDirty() {
  return listDiskCacheDirty;
}

/**
 * 由「header 级信息 + 派生字段（可能来自缓存）」组装一条冷会话列表项。
 * 抽出来是为了让「缓存命中」与「刚刚解析完」两条路径产出**完全一致**的结构。
 */
export function buildColdSessionItem(header, inspected, derived, ctx, storeState, archived) {
  const title = derived.title ?? null;
  // 【原代码】cwd: inspected.cwd ?? meta.cwd ?? null、createdAt: inspected.createdAt ?? meta.createdAt、
  // parentSession: inspected.parentSession ?? meta.parentSession ?? null —— 即「inspect 回的 header 优先，
  // persistence.list 的 header 兜底」。缓存命中时 inspected 用缓存里存的同名字段，
  // 保证「走缓存」与「刚解析完」两条路径产出完全一致的结构。
  return {
    id: header.id,
    title,
    archiveWs: archived.has(header.id) ? stripArchiveWsPrefix(title ?? "").ws : "",
    cwd: inspected.cwd ?? header.cwd ?? null,
    createdAt: inspected.createdAt ?? header.createdAt,
    updatedAt: derived.updatedAt ?? inspected.createdAt ?? header.createdAt,
    live: false,
    archived: archived.has(header.id),
    running: false,
    interruption: derived.inspectError != null ? null : (derived.interruption ?? null),
    parentSession: inspected.parentSession ?? header.parentSession ?? null,
    autoRename: autoRenameEnabled(ctx, storeState, header.id),
    autoContinue: effectiveAutoContinue(cfg, storeState, header.id),
    continueRunning: continueJobs.has(header.id),
    ...(derived.inspectError != null ? { inspectError: derived.inspectError } : {}),
  };
}

// ---------- 列表 TTL 缓存与并发合并 ----------
// 背景：面板里有多个组件各自挂载时调 refresh()，同一瞬间会打出多个并发的全量 list 请求；
// 每个请求都独立重扫全部会话，内存与 IO 成倍叠加。这里做两件事：
// ①并发合并——同一时刻只允许一次构建在跑，其余请求复用同一个 Promise；
// ②短 TTL 缓存——cfg.listCacheMs（默认 5s）内的重复请求直接复用结果。
// 变更类操作（改开关/归档/删除/改名等）会调 invalidateSessionListCache() 立即失效。
let listCacheAt = 0;
let listCacheItems = null;
let listBuildInflight = null;

/** 让会话列表缓存立即失效（任何会改变列表内容的写操作后调用）。 */
export function invalidateSessionListCache() {
  listCacheAt = 0;
  listCacheItems = null;
}

/** TTL 缓存读取（命中返回 items，未命中返回 null）。 */
export function peekListCache() {
  const ttl = cfg.listCacheMs;
  if (listCacheItems !== null && ttl > 0 && Date.now() - listCacheAt < ttl) return listCacheItems;
  return null;
}

/** 并发合并：取当前正在进行的构建（有则返回 Promise，无则返回 null）。 */
export function peekListBuildInflight() {
  return listBuildInflight;
}

/** 登记一次构建（供并发合并复用；构建结束后调用 settleListBuild）。 */
export function registerListBuild(promise) {
  listBuildInflight = promise;
  return promise;
}

/** 构建完成：写入 TTL 缓存并清理 inflight 标记。 */
export function settleListBuild(promise, items) {
  listCacheItems = items;
  listCacheAt = Date.now();
  if (listBuildInflight === promise) listBuildInflight = null;
  return items;
}

/** 测试钩子：清空列表缓存状态（单测在场景之间调用）。 */
export function resetListCacheForTest() {
  listDiskCache = null;
  listDiskCachePath = null;
  listDiskCacheDirty = false;
  if (listDiskCacheTimer !== null) clearTimeout(listDiskCacheTimer);
  listDiskCacheTimer = null;
  listCacheAt = 0;
  listCacheItems = null;
  listBuildInflight = null;
}
