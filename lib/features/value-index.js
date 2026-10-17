// 会话价值索引：把「这条会话值不值得留」的判定结果按会话落盘复用。
//
// 【为什么需要】价值判定必须读会话日志（逐帧解压 + 逐行解析），实测本机样本：
//   0.2 MB ≈ 85 ms、1.6 MB ≈ 311 ms、7 MB ≈ 1.1 s、30 MB ≈ 7 s、86 MB ≈ 16 s（解压吞吐约 5 MB/s）。
//   上百条会话全量重算就是几十秒起步 —— 而判定结果在「会话没变」时是稳定的，
//   每次筛选都重算纯属浪费。
//
// 【失效判据（两条，任一不满足即重算）】
//   ① 变更令牌：列表项 updatedAt 变了（说明又追加了事件）→ 旧结论作废；
//   ② 时间上限：超过 valueIndexTtlHours（默认 24 小时，配置可覆盖）→ 重算一次。
//   两条合起来的语义是「同一份内容 24 小时内只算一次」。
//
// 【落盘】<DSH_HOME>/storages/dsh-session-conductor/value-index.json，原子写（tmp + rename），
//   节流 2 秒合并多次写入；任何异常都退化为「没有索引」，绝不影响筛选本身。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

import { cfg, resolveDshHome } from "../core/config.js";

const VALUE_INDEX_VERSION = 1;
const VALUE_INDEX_SUBDIR = ["storages", "dsh-session-conductor"];
const DEFAULT_TTL_HOURS = 24;
const SAVE_DEBOUNCE_MS = 2000;

/** { version, entries: { [sessionId]: { at, updatedAt, value, score, reason } } } */
let indexCache = null;
let indexPath = null;
let indexDirty = false;
let indexTimer = null;

/** 索引文件绝对路径（首次解析后缓存）。 */
export function valueIndexFilePath(ctx) {
  if (indexPath !== null) return indexPath;
  const home = resolveDshHome(ctx, cfg);
  indexPath = home ? path.join(home, ...VALUE_INDEX_SUBDIR, "value-index.json") : "";
  return indexPath;
}

/** 读索引（进程内只读一次；文件不存在/损坏都按空索引处理，不向上抛）。 */
export function loadValueIndex(ctx) {
  if (indexCache !== null) return indexCache;
  indexCache = { version: VALUE_INDEX_VERSION, entries: {} };
  const file = valueIndexFilePath(ctx);
  if (!file) return indexCache;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version === VALUE_INDEX_VERSION && parsed.entries && typeof parsed.entries === "object") {
      indexCache = { version: VALUE_INDEX_VERSION, entries: parsed.entries };
    }
  } catch {
    // 首次运行 / 文件损坏：按空索引继续，本次算完会覆盖写入
  }
  return indexCache;
}

/** 有效期（毫秒）：默认 24 小时，可由配置 valueIndexTtlHours 覆盖。 */
export function valueIndexTtlMs() {
  const hours = Number(cfg?.valueIndexTtlHours);
  const effective = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS;
  return effective * 3600_000;
}

/**
 * 取可复用的判定结果；没有 / 会话变过 / 超期都返回 null（调用方据此决定重算）。
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 会话 id
 * @param {number|null} updatedAt 列表项上的最后活动时间（变更令牌）
 */
export function getValueVerdict(ctx, sessionId, updatedAt) {
  const entry = loadValueIndex(ctx).entries[sessionId];
  if (!entry) return null;
  if (typeof updatedAt === "number" && typeof entry.updatedAt === "number" && entry.updatedAt !== updatedAt) return null;
  if (Date.now() - (entry.at ?? 0) > valueIndexTtlMs()) return null;
  return entry;
}

/** 写入一条判定结果（标记脏，节流落盘）。 */
export function putValueVerdict(ctx, sessionId, updatedAt, verdict) {
  const index = loadValueIndex(ctx);
  index.entries[sessionId] = {
    at: Date.now(),
    updatedAt: typeof updatedAt === "number" ? updatedAt : null,
    value: verdict.value,
    score: verdict.score ?? 0,
    reason: verdict.reason ?? "",
  };
  indexDirty = true;
  if (indexTimer !== null) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    if (indexDirty) saveValueIndexNow(ctx);
  }, SAVE_DEBOUNCE_MS);
  if (typeof indexTimer?.unref === "function") indexTimer.unref();
}

/**
 * 忘掉某个会话的价值判定（删除会话后必须调用）。
 * 否则删掉的会话还留着一条「低价值」结论，下次筛选若按索引命中就会把它勾出来 ——
 * 而它其实已经不存在了。
 * @returns {boolean} true = 确实删掉了条目
 */
export function forgetValueVerdict(ctx, sessionId) {
  if (!sessionId) return false;
  const index = loadValueIndex(ctx);
  if (!index?.entries || !(sessionId in index.entries)) return false;
  delete index.entries[sessionId];
  indexDirty = true;
  saveValueIndexNow(ctx);
  return true;
}

/** 立即落盘（原子写：tmp + rename）。失败只丢缓存，不抛。 */
export function saveValueIndexNow(ctx) {
  const file = valueIndexFilePath(ctx);
  if (!file || indexCache === null) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmpPath = `${file}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(indexCache), "utf8");
    renameSync(tmpPath, file);
    indexDirty = false;
  } catch {
    // 写盘失败（只读卷/磁盘满）：本次不落盘，下次继续尝试
  }
}

/** 测试钩子：清空内存态并允许重新指定路径。 */
export function resetValueIndexForTest() {
  indexCache = null;
  indexPath = null;
  indexDirty = false;
  if (indexTimer !== null) clearTimeout(indexTimer);
  indexTimer = null;
}
