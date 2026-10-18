// 插件索引的唯一落盘位置：<DSH_HOME>/storages/dsh-session-conductor/index.json
//
// 【为什么要收敛】此前每类索引各写一个文件（list-cache.json / value-index.json / trash.json），
// 于是同一个目录里躺着三套「版本号 + 原子写 + 路径解析」的复制品：改一处忘一处、
// 备份/迁移要记三份名字、出问题时不知道先看哪个。现在统一成**一个文件、一个版本号、一个原子写**，
// 各模块只关心自己的 section。
//
// 【结构】
//   {
//     version: 1,
//     list:  { entries: { [sessionId]: {...} } },          // 会话列表解析缓存
//     value: { entries: { [sessionId]: {...} } },          // 价值判定索引
//     trash: { entries: { [sessionId]: {...} }, retentionDays }  // 回收站
//   }
//
// 【迁移】首次加载若发现旧文件，按 section 合并进来，并把旧文件改名为
// `<原名>.migrated`（不删、可回滚）。
//
// 【写入】原子写（tmp + rename）。整文件重写：当前规模 30~80 KB、序列化 ~1 ms，
// 各模块的写盘本来就有节流/低频，代价可忽略；等真到上千条再评估换存储。

import { existsSync } from "node:fs";
import path from "node:path";

import { cfg, resolveDshHome } from "./config.js";
import { writeJsonAtomicSync, readJsonSafeSync } from "../shared/json-store.js";

const STORE_VERSION = 1;
const STORE_SUBDIR = ["storages", "dsh-session-conductor"];
const STORE_FILE = "index.json";
/** 旧文件 → section 名（迁移用） */
const LEGACY_FILES = [
  ["list-cache.json", "list"],
  ["value-index.json", "value"],
  ["trash.json", "trash"],
];

let storeCache = null;
let storePath = null;

/** 索引文件绝对路径（首次解析后缓存）。 */
export function storeFilePath(ctx) {
  if (storePath !== null) return storePath;
  const home = resolveDshHome(ctx, cfg);
  storePath = home ? path.join(home, ...STORE_SUBDIR, STORE_FILE) : "";
  return storePath;
}

/** 空结构（各 section 都带默认值，调用方不必判空）。 */
function emptyStore() {
  return { version: STORE_VERSION, list: { entries: {} }, value: { entries: {} }, trash: { entries: {} } };
}

/**
 * 读索引（进程内只读一次）。文件缺失/损坏 → 空结构；随后尝试从旧文件迁移一次。
 */
export function loadStore(ctx) {
  if (storeCache !== null) return storeCache;
  storeCache = emptyStore();
  const file = storeFilePath(ctx);
  if (!file) return storeCache;
  const parsed = readStoreFile(file);
  if (parsed) {
    storeCache = normalizeStore(parsed);
  } else {
    // 文件不存在/损坏：先尝试一次性迁移旧文件
    migrateLegacyFiles(ctx);
  }
  return storeCache;
}

/** 读并解析索引文件；不存在或损坏返回 null（不抛）。 */
function readStoreFile(file) {
  return readJsonSafeSync(file); // 不存在/损坏一律 null，不抛
}

/** 把「磁盘上读到的任意形状」规整成合法结构：每个 section 都有 entries 对象。 */
function normalizeStore(parsed) {
  const entriesOf = (section) => (section?.entries && typeof section.entries === "object" ? section.entries : {});
  return {
    version: STORE_VERSION,
    list: { entries: entriesOf(parsed.list) },
    value: { entries: entriesOf(parsed.value) },
    trash: {
      entries: entriesOf(parsed.trash),
      ...(Number.isFinite(parsed.trash?.retentionDays) ? { retentionDays: parsed.trash.retentionDays } : {}),
    },
  };
}

/**
 * 一次性迁移旧文件：按 section 合并，成功则把旧文件改名 `.migrated`（保留可回滚）。
 * 任一文件解析失败就跳过它（不阻断启动）。
 */
function migrateLegacyFiles(ctx) {
  const file = storeFilePath(ctx);
  if (!file) return;
  const dir = path.dirname(file);
  let migratedAny = false;
  for (const [legacyName, section] of LEGACY_FILES) {
    const legacyPath = path.join(dir, legacyName);
    if (!existsSync(legacyPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
      const entries = parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : null;
      if (entries) {
        storeCache[section] = {
          entries,
          ...(section === "trash" && Number.isFinite(parsed?.retentionDays) ? { retentionDays: parsed.retentionDays } : {}),
        };
        migratedAny = true;
      }
      // 迁移后改名：不删除，出问题可人工回滚
      renameSync(legacyPath, `${legacyPath}.migrated`);
    } catch {
      // 旧文件坏了：跳过，保持空 section
    }
  }
  if (migratedAny) saveStoreNow(ctx);
}

/** 立即落盘（原子写：tmp + rename）。失败只丢本次写入，不抛。 */
export function saveStoreNow(ctx) {
  const file = storeFilePath(ctx);
  if (!file || storeCache === null) return false;
  try {
    writeJsonAtomicSync(file, storeCache); // 统一原子写（tmp + rename），见 shared/json-store.js
    return true;
  } catch {
    return false;
  }
}

/** 取某个 section（不存在时给默认值）。 */
export function getSection(ctx, name) {
  const store = loadStore(ctx);
  if (!store[name]) store[name] = { entries: {} };
  if (!store[name].entries || typeof store[name].entries !== "object") store[name].entries = {};
  return store[name];
}

/** 写某个 section（只改内存，落盘由调用方决定时机）。 */
export function setSection(ctx, name, value) {
  const store = loadStore(ctx);
  store[name] = value;
  return store[name];
}

/** 测试钩子：清空内存态。 */
export function resetStoreForTest() {
  storeCache = null;
  storePath = null;
}
