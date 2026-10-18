// 原子 JSON 读写 —— 全仓唯一实现。
//
// 【为什么抽出来】config / index-store / memory-recall 三处各写了一遍「写 tmp → rename」：
//   · 任何一处漏掉 rename 都会留下半个文件（下次启动读到坏 JSON）；
//   · tmp 文件名若不带 pid，两个进程/两次并发写会互相踩；
//   · 每处还要各自处理「目录不存在」「文件损坏」。
// 现在统一到这里，调用方只管传 file + data。
//
// 同步版给「一次性初始化 / CLI」用；异步版给「请求路径」用（避免阻塞事件循环）。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

/** tmp 文件名带上 pid，避免并发写互相覆盖。 */
function tmpPathOf(file) {
  return `${file}.tmp-${process.pid}`;
}

/** 同步原子写：先写 tmp 再 rename（rename 在同一文件系统上是原子的）。失败向上抛。 */
export function writeJsonAtomicSync(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmpPath = tmpPathOf(file);
  writeFileSync(tmpPath, JSON.stringify(data), "utf8");
  renameSync(tmpPath, file);
}

/** 异步原子写：语义同上，给请求路径用。失败向上抛。 */
export async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpPath = tmpPathOf(file);
  await writeFile(tmpPath, JSON.stringify(data), "utf8");
  await rename(tmpPath, file);
}

/** 同步读 JSON：文件不存在 / 损坏 / 不是对象 → 返回 null（绝不抛）。 */
export function readJsonSafeSync(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 异步读 JSON：语义同上。 */
export async function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
