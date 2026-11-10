// dsh-session-conductor — 缺失附件引用清理
//
// 【解决什么问题】会话事件里会引用附件（图片/文件）：`content[]` 里形如
//   { type: "image", attachment: { attachmentId: "sha256:<64hex>", name, mediaType, width, height } }
// 附件实体落在 `<DSH_HOME>/attachments/v1/objects/<hash 前 2 位>/<hash>`。
// 把会话从一个环境搬到另一个环境时，只复制 sessions/ 而漏了 attachments/，
// 会话本体看起来完好（事件、seq、工具配对都正常），但宿主组请求时要读附件内容——
// 读不到就整轮失败，表现为「这条会话不会对话」，且报错与模型/provider 都无关，极难定位。
//
// 【怎么修】把「引用了不存在附件的 content 块」替换成一段文本占位，保留位置与索引不变：
//   { type: "text", text: "[附件已缺失：<文件名>（sha256:<前 8 位>…，<mediaType> <宽>×<高>）]" }
// 这样模型仍知道「这里原本有一张图」，上下文结构不被破坏；代价是附件内容永久丢失，
// 因此默认 dryRun，写盘前先备份原文件。
//
// 【为什么不删块】删掉数组元素会让同一条消息里的其它块索引前移，可能碰坏引用关系；
// 原地替换成文本最保守。

import { existsSync, readFileSync } from 'node:fs';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeAllFrames } from '../zstd-frames.js';
import { encodeSessionText } from '../repair.js';

/** 附件对象在磁盘上的相对目录（相对 DSH_HOME）。 */
const ATTACHMENT_OBJECTS_SEGMENTS = ['attachments', 'v1', 'objects'];
/** attachmentId 的算法前缀；只支持这一种，未知前缀一律当作"无法判定"跳过。 */
const SUPPORTED_ATTACHMENT_PREFIX = 'sha256:';
/** 占位文本里展示的 hash 前几位（够区分、又不刷屏）。 */
const HASH_PREVIEW_CHARS = 8;

/**
 * 把一个 attachmentId 解析成磁盘路径。
 * @param {string} home DSH_HOME
 * @param {string} attachmentId 形如 `sha256:<64 位十六进制>`
 * @returns {string|null} 绝对路径；无法解析返回 null
 */
export function attachmentObjectPath(home, attachmentId) {
  const raw = String(attachmentId ?? '');
  if (!raw.startsWith(SUPPORTED_ATTACHMENT_PREFIX)) return null;
  const hash = raw.slice(SUPPORTED_ATTACHMENT_PREFIX.length).trim().toLowerCase();
  // 只接受纯十六进制：防止把 `../` 之类拼进路径
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  return join(home, ...ATTACHMENT_OBJECTS_SEGMENTS, hash.slice(0, 2), hash);
}

/**
 * 生成替换用的占位文本块。
 * @param {{attachmentId: string, name?: string, mediaType?: string, width?: number, height?: number}} attachment
 * @returns {{type: 'text', text: string}}
 */
export function placeholderForAttachment(attachment) {
  const hash = String(attachment?.attachmentId ?? '').slice(SUPPORTED_ATTACHMENT_PREFIX.length);
  const label = attachment?.name ? String(attachment.name) : '未命名附件';
  const hashHint = hash ? `sha256:${hash.slice(0, HASH_PREVIEW_CHARS)}…` : 'hash 未知';
  const typeHint = attachment?.mediaType ? String(attachment.mediaType) : '类型未知';
  const sizeHint = attachment?.width && attachment?.height ? ` ${attachment.width}×${attachment.height}` : '';
  return {
    type: 'text',
    text: `[附件已缺失：${label}（${hashHint}，${typeHint}${sizeHint}）]`,
  };
}

/**
 * 遍历一条消息的 content 数组，挑出「引用了不存在附件」的块下标。
 * 只读，不改动入参。
 * @param {Array<object>} content 消息 content 数组
 * @param {string} home DSH_HOME
 * @returns {Array<{index: number, attachment: object}>}
 */
export function missingAttachmentsInContent(content, home) {
  if (!Array.isArray(content)) return [];
  const out = [];
  content.forEach((block, index) => {
    const attachment = block?.attachment;
    if (!attachment || !attachment.attachmentId) return;
    const path = attachmentObjectPath(home, attachment.attachmentId);
    // 无法解析的 id（未知算法/格式非法）也算缺失：它同样读不出来，且不该静默放过
    if (path === null || !existsSync(path)) out.push({ index, attachment });
  });
  return out;
}

/**
 * 扫描整份事件流里「引用缺失附件」的位置。
 * 会覆盖两个出现面：`data.content`（user/message、assistant/message）
 * 与 `data.inserted[].content`（agent/inbox/spliced 的注入记录）。
 *
 * @param {Array<object>} events 事件数组（不含 header）
 * @param {{home: string}} options
 * @returns {Array<{seq: number, messageIndex: number, index: number, attachment: object}>}
 */
export function findMissingAttachments(events, { home }) {
  const hits = [];
  for (const event of events) {
    const data = event?.data ?? {};
    const arrays = [];
    if (Array.isArray(data.content)) arrays.push({ messageIndex: -1, content: data.content });
    if (Array.isArray(data.inserted)) {
      data.inserted.forEach((item, messageIndex) => {
        if (Array.isArray(item?.content)) arrays.push({ messageIndex, content: item.content });
      });
    }
    for (const { messageIndex, content } of arrays) {
      for (const hit of missingAttachmentsInContent(content, home)) {
        hits.push({ seq: event.seq, messageIndex, index: hit.index, attachment: hit.attachment });
      }
    }
  }
  return hits;
}

/**
 * 按 seq 把缺失附件块原地替换成文本占位。返回新事件数组（不修改入参）。
 *
 * 实现上先整体深拷贝：会话事件树很小（万级事件、几十 MB），
 * 一次拷贝换取"入参绝对不被改动"，比逐节点写克隆分支安全得多。
 *
 * @param {Array<object>} events 事件数组
 * @param {{home: string}} options
 * @returns {{events: Array<object>, stripped: Array<{seq: number, attachment: object}>}}
 */
export function stripMissingAttachments(events, { home }) {
  const cloned = structuredClone(events);
  const stripped = [];
  for (const event of cloned) {
    const data = event?.data ?? {};
    const contentArrays = [];
    if (Array.isArray(data.content)) contentArrays.push(data.content);
    if (Array.isArray(data.inserted)) {
      for (const item of data.inserted) {
        if (Array.isArray(item?.content)) contentArrays.push(item.content);
      }
    }
    for (const content of contentArrays) {
      // 每次替换后重新扫：索引基于当前数组，替换不会移位，但重扫能保证语义简单
      for (const hit of missingAttachmentsInContent(content, home)) {
        content[hit.index] = placeholderForAttachment(hit.attachment);
        stripped.push({ seq: event.seq, attachment: hit.attachment });
      }
    }
  }
  return { events: cloned, stripped };
}

/**
 * 把「header + 事件」重新拼成明文（首行 header，其余每行一条事件）。
 * @param {object} header 会话 header
 * @param {Array<object>} events 事件数组
 * @returns {string}
 */
function composePlain(header, events) {
  return [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n') + '\n';
}

/**
 * 扫描单个会话文件里引用缺失附件的块。
 * @param {string} logPath 会话日志绝对路径（session.v4.jsonl.zstd）
 * @param {{home: string}} options
 * @returns {{ok: boolean, path: string, total: number, missing: Array<object>, error?: string}}
 */
export async function scanSessionAttachmentRefs(logPath, { home }) {
  try {
    const text = await decodeAllFrames(readFileSync(logPath));
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    if (lines.length < 2) return { ok: false, path: logPath, total: 0, missing: [], error: '会话事件不足（至少 header + 1 条）' };
    const header = JSON.parse(lines[0]);
    const events = lines.slice(1).map((line) => JSON.parse(line));
    const missing = findMissingAttachments(events, { home });
    return { ok: true, path: logPath, total: events.length, missing, sessionId: header.id };
  } catch (error) {
    return { ok: false, path: logPath, total: 0, missing: [], error: String(error?.message ?? error) };
  }
}

/**
 * 清理单个会话文件里引用缺失附件的块：解码 → 替换 → 备份 → 原子写回。
 *
 * @param {string} logPath 会话日志绝对路径
 * @param {{home: string, dryRun?: boolean}} options dryRun=true（默认）只报告不改动
 * @returns {Promise<{ok: boolean, dryRun: boolean, path: string, stripped: Array<object>, backupPath?: string, error?: string}>}
 */
export async function repairSessionAttachments(logPath, { home, dryRun = true }) {
  const scanned = await scanSessionAttachmentRefs(logPath, { home });
  if (!scanned.ok) return { ok: false, dryRun, path: logPath, stripped: [], error: scanned.error };
  if (scanned.missing.length === 0) return { ok: true, dryRun, path: logPath, stripped: [] };
  if (dryRun) return { ok: true, dryRun, path: logPath, stripped: scanned.missing };

  try {
    const text = await decodeAllFrames(readFileSync(logPath));
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const header = JSON.parse(lines[0]);
    const events = lines.slice(1).map((line) => JSON.parse(line));
    const { events: cleaned, stripped } = stripMissingAttachments(events, { home });
    const encoded = await encodeSessionText(composePlain(header, cleaned));
    const buffer = Buffer.isBuffer(encoded) ? encoded : encoded?.buffer;
    if (!buffer) return { ok: false, dryRun, path: logPath, stripped: [], error: '编码回 zstd 失败' };

    // 备份原文件（同目录 .bak-<时间戳>），失败就不动原文件
    const backupPath = `${logPath}.bak-attachment-${Date.now()}`;
    writeFileSync(backupPath, readFileSync(logPath));

    // 原子写：先写临时文件再 rename，避免写到一半中断导致会话损坏
    const tmpPath = `${logPath}.tmp-attachment-${Date.now()}`;
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, logPath);
    try { unlinkSync(tmpPath); } catch { /* rename 成功后 tmp 已不存在，忽略 */ }

    return { ok: true, dryRun: false, path: logPath, stripped, backupPath };
  } catch (error) {
    return { ok: false, dryRun, path: logPath, stripped: [], error: String(error?.message ?? error) };
  }
}
