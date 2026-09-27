// dsh-session-conductor — 会话日志记录编解码（自研，适配 DSH v3 会话格式）
//
// DSH 0.1.6-alpha.1（SESSION_FORMAT_VERSION = 3）已移除旧版公开 API：
//   decodeStorageRecord / packChunkRuns（v0/v1 旧格式的 *-chunks 打包编解码器）。
// 本模块提供功能等价实现，供 repair.js / seq-gap-repair.js / tools/validate-session.mjs 使用：
//   · decodeStorageRecord(record) → 事件数组
//       v3 格式：一行一个事件 JSON（记录即事件对象，含 type 字段）→ 返回 [record]；
//       旧格式容器（{events:[...]}）→ 返回 record.events；
//       无 type 且无 events 的未知记录 → 抛错（调用方 try/catch 判定解析失败）。
//   · packChunkRuns(events) → 记录行数组
//       v3 格式：一行一事件，直接返回事件数组（写回时每个事件 JSON 一行）。

/**
 * 把一条存储记录解码为事件数组（v3 会话格式：记录即单个事件对象）。
 * @param {object} record 从会话日志 JSONL 解析出的记录对象
 * @returns {Array<object>} 事件数组
 * @throws {Error} 未知记录结构时抛错（调用方按解析失败处理）
 */
export function decodeStorageRecord(record) {
  if (record === null || typeof record !== "object") {
    throw new Error("decodeStorageRecord: 非法记录（非对象）");
  }
  // v3 格式：记录即单个事件（header/事件行均含 type 字段）
  if (typeof record.type === "string") return [record];
  // 旧格式容器（兼容）：{ events: [...] }
  if (Array.isArray(record.events)) return record.events;
  throw new Error("decodeStorageRecord: 未知记录结构（无 type 且无 events）");
}

/**
 * 把事件数组打包为记录行数组（v3 格式：一行一事件，原样返回）。
 * @param {Array<object>} events 事件数组
 * @returns {Array<object>} 记录行数组（每个事件对应一行 JSON）
 */
export function packChunkRuns(events) {
  return Array.isArray(events) ? events : [];
}
