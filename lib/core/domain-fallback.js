// dsh-session-conductor — 存储域不可用时的文件后备（降级实现）
//
// 【为什么单独成文件】`core/domain.js` 顶层静态依赖宿主包 `@deepseek-ai/dsh-storage-domain`，
// 工作区单测没有宿主依赖，静态 import 会让整个模块在导入时就 ERR_MODULE_NOT_FOUND。
// 把降级逻辑放在这里（只依赖 node 内置 + 已抽出的 json-store），就能被单测直接覆盖。
//
// 【降级触发条件】storageDomain 域出现下面任一情况时，改读写域自己的落盘 JSON：
//   · 服务拿不到（ctx.get("storageDomain") 为空）
//   · 名字仍被占（already open）而查到的旧句柄已 closed 或停在 disposing
// 这两种情况下插件所有依赖持久化的功能本会一路 500，只能重启恢复。

import { join } from "node:path";
import { homedir } from "node:os";
import { readJsonSafeSync, writeJsonAtomicSync } from "../shared/json-store.js";

/** DSH 主目录（与 core/config.js 的 resolveDshHome 同规则；此处内联避免底层模块反向依赖上层配置）。 */
function dshHomePath() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return home ? join(home, ".dsh") : "";
}

/**
 * 判定域句柄是否还能用。
 *
 * 【为什么还要看 disposing】宿主的 DomainImpl 在 close 一开始就置 `disposing = true`，
 * 要等写链排空、存储单元关闭后才置 `closed = true`。如果关闭过程卡住（写链未排空），
 * 句柄会长期停在 `disposing`：`closed` 仍是 false，但任何读写都会抛「domain is closed」。
 * 只看 `closed` 会把它当成活域继续用，于是接口一路 500。
 */
export function isUsableDomain(domain) {
  return Boolean(domain) && domain.closed !== true && domain.disposing !== true;
}

/**
 * 文件后备域：storageDomain 的域不可用（卡在关闭中 / 名字被占导致无法重新打开）时的降级实现。
 *
 * 【为什么要有它】域卡住时插件所有依赖持久化的功能（列表缓存、模板、各开关、成员模型 override）
 * 会全部 500，只能靠重启宿主恢复。而这些状态本来就落盘在
 * `<DSH_HOME>/storages/dsh_session_conductor.json`，直接读写同一份文件即可继续工作。
 *
 * 【只实现 global.get / global.set】全插件对域的使用面只有这两者（外加 close），没有用到 tables，
 * 因此后备实现只管 global 一节，其余字段（unit / tables）原样保留，保证宿主下次启动能正常加载。
 *
 * 【串行写】域本身有写链保证串行；文件后备没有，这里用一条 Promise 链模拟，
 * 避免并发 `global.set` 互相覆盖（读-改-写之间的丢更新）。
 */
export function fileFallbackDomain() {
  const home = dshHomePath();
  const file = home ? join(home, "storages", "dsh_session_conductor.json") : "";
  const readAll = () => {
    if (!file) return {};
    try { return readJsonSafeSync(file) ?? {}; } catch { return {}; }
  };
  let chain = Promise.resolve();
  return {
    // 供 isUsableDomain 判断：后备域永远可用
    closed: false,
    disposing: false,
    __fallback: true,
    global: {
      get() {
        return readAll().global ?? {};
      },
      set(value) {
        chain = chain.then(async () => {
          if (!file) throw new Error("DSH_HOME 未知，无法写入后备存储");
          const current = readAll();
          // 保留 unit / tables 原值：它们由宿主维护，后备路径不改动
          const next = { ...current, global: value, tables: current.tables ?? {} };
          if (current.unit !== undefined) next.unit = current.unit;
          await writeJsonAtomicSync(file, next);
        });
        return chain;
      },
    },
    close() { /* 后备域无需关闭 */ },
  };
}

/** 降级只提示一次，避免每个请求都刷一行日志。 */
let fallbackLogged = false;
export function logOnceFallback(error, reused) {
  if (fallbackLogged) return;
  fallbackLogged = true;
  try {
    console.warn(
      "[session-conductor] 存储域不可用，已降级为直接读写 storages/dsh_session_conductor.json："
      + `open 失败=${String(error?.message ?? error)}`
      + `${reused ? "；复用的句柄已关闭/关闭中" : ""}。重启实例可恢复正常域。`,
    );
  } catch { /* 日志失败不影响主流程 */ }
}
