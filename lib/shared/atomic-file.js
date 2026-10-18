// 文件级原子操作 —— 全仓唯一实现。
//
// 【为什么抽出来】「写 tmp → 复制原文件权限 → rename 覆盖」这段在 zstd-frames（帧修复、截断修复）
// 与 session-ops（撤回消息写回）各写了一遍，共 3 份；备份那段（已存在不覆盖）也重复了 3 次。
// 这类代码一旦哪份漏了 chmod 或 rename，表现是「文件权限被重置」或「留下半个日志」，
// 而且都发生在**修复会话日志**这种最不能出错的路径上 —— 收敛成一处才好审。
//
// 说明：CIFS/网络盘上 chmod 可能直接失败，因此权限保留是「尽力而为」，失败不影响替换本身。

import { writeFileSync, renameSync, chmodSync, statSync, existsSync, copyFileSync } from "node:fs";

/**
 * 原子替换文件内容：写 tmp → 继承原文件权限 → rename 覆盖。
 * @param {string} targetPath 目标文件
 * @param {string|Buffer} data 新内容
 * @param {{tmpSuffix?: string}} [opts] tmp 后缀（默认 .tmp，便于排查是哪条路径留下的）
 * @returns {string} 实际使用的 tmp 路径（已被 rename，仅供日志）
 */
export function replaceFileSync(targetPath, data, { tmpSuffix = ".tmp" } = {}) {
  const tmpPath = targetPath + tmpSuffix;
  writeFileSync(tmpPath, data);
  try {
    chmodSync(tmpPath, statSync(targetPath).mode);
  } catch {
    // CIFS/网络盘无 chmod：权限沿用默认，替换本身照做
  }
  renameSync(tmpPath, targetPath);
  return tmpPath;
}

/**
 * 备份一次（目标已存在则不覆盖，避免二次操作把原始备份冲掉）。
 * @returns {string} 备份路径
 */
export function ensureBackupSync(srcPath, backupPath) {
  if (!existsSync(backupPath)) copyFileSync(srcPath, backupPath);
  return backupPath;
}
