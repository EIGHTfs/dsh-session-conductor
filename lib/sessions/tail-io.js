// dsh-session-conductor — 会话日志的「尾部」增量读写
//
// 【为什么单独成文件】成员模型切换（/model-switch、set_member_model、create_teammate_with_model）
// 需要往会话日志追加一条 model/selection 事件。原实现是「整份解码 → 拼全文 → 全量校验 → 整份重编码」，
// 一次切换要完整解码 3 次，30MB 日志时峰值内存数百 MB 且同步 parse 阻塞事件循环数秒。
//
// 本模块把这条路径改成「只看尾部」：
//   · readTailEvents  —— 只解码最后 N 帧，取最后若干条事件（seq / 行数判定都在尾部完成）
//   · appendEventFrame —— 只把「新事件一行」压缩成一个新帧追加到文件尾，**不重写已有内容**
//
// 【为什么追加帧是合法的】DSH 会话日志是【多帧容器】：第一帧必须恰好一行 header，其后是事件帧，
// 帧与帧之间在解码层直接拼接（见 zstd-frames.js decodeAllFrames）。因此「在文件尾追加一个新事件帧」
// 与「重写整份」在解码后的文本上等价，但内存与 CPU 开销与日志总大小无关。
//
// 【安全性】追加帧只改文件尾，失败时不影响已有帧；调用方仍会在写后自检（自检也走尾部读）。

import { readFile, open } from "node:fs/promises";
import { scanZstdFrames, decodeFrame, ZSTD_MAGIC } from "../zstd-frames.js";
import zlib from "node:zlib";
const { zstdCompress, constants } = zlib;

const FRAME_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/**
 * 只解码会话日志的**最后若干帧**，返回其中的事件与统计信息。
 *
 * 与原「整份解码」的差异：不返回全部行，只返回尾部帧内的事件；
 * 因此内存峰值 = 最后 N 帧的解压结果，与日志总大小无关。
 *
 * @param {Buffer} buf 整份（压缩的）日志文件内容
 * @param {{tailFrames?: number, maxEvents?: number}} [opts]
 * @returns {Promise<{events: object[], frames: number, tailStartFrame: number, torn: boolean}>}
 *          events 为倒序无关、按日志顺序的尾部事件；frames 为总帧数；tailStartFrame 为尾部第一帧序号
 */
export async function readTailEvents(buf, opts = {}) {
  const tailFrames = Math.max(1, opts.tailFrames ?? 3);
  const maxEvents = Math.max(1, opts.maxEvents ?? 2000);
  const { frames, tornStart } = scanZstdFrames(buf);
  const tail = frames.slice(Math.max(0, frames.length - tailFrames));
  // 逐帧解码 → 逐行消费，**不把尾部文本拼成一个大字符串**：
  // 只保留「最后 maxEvents 条事件」，因此单帧再大也只在这一个数组上有峰值。
  const events = [];
  let carry = "";
  for (const fr of tail) {
    const frameText = (await decodeFrame(buf.subarray(fr.start, fr.end))).toString("utf8");
    if (frameText === "") continue;
    const lines = (carry + frameText).split("\n");
    // 最后一段可能是不完整行（帧边界断开），留给下一帧拼接
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 尾部帧里理论上都是完整行；解析失败不致命，交给调用方的 seq 自检兜底
      }
    }
  }
  if (carry.trim() !== "") {
    try {
      events.push(JSON.parse(carry));
    } catch {
      // 末尾残行：容忍，交给调用方自检
    }
  }
  // 只保留最后 maxEvents 条（尾部帧通常很小，这是防止极端大帧的兜底）
  return {
    events: events.length > maxEvents ? events.slice(events.length - maxEvents) : events,
    frames: frames.length,
    tailStartFrame: Math.max(0, frames.length - tail.length),
    torn: tornStart !== undefined,
  };
}

/** 压缩「单行事件」成一个独立的 zstd 帧（带 checksum）。 */
async function compressEventLine(line) {
  const buf = Buffer.from(line.endsWith("\n") ? line : `${line}\n`, "utf8");
  return new Promise((resolve, reject) => {
    zstdCompress(buf, FRAME_OPTIONS, (error, out) => (error ? reject(error) : resolve(out)));
  });
}

/**
 * 把一个事件**以新帧形式追加**到会话日志尾部。
 *
 * 为什么不用「读整份 → 拼字符串 → 重编码」：那条路径内存与 CPU 都随日志大小线性增长，
 * 而这里只压缩一行（几百字节～几 KB），开销恒定。
 *
 * 追加前会自证两件事，任一只怕就直接报错（宁可不动日志）：
 *   ① 文件当前确实是合法的多帧容器（能扫描出帧、首帧能解出 header 行）；
 *   ② 尾部事件的 seq 与将要写入的 seq 严格衔接（调用方传入 expectedSeq 时）。
 *
 * @param {string} filePath 会话日志路径
 * @param {object} event 要追加的事件（会被 JSON.stringify 成一行）
 * @returns {Promise<{ok: true, seq: number, bytes: number} | {ok: false, error: string}>}
 */
export async function appendEventFrame(filePath, event) {
  let buf;
  try {
    buf = await readFile(filePath);
  } catch (error) {
    return { ok: false, error: `读取失败：${String(error?.message ?? error)}` };
  }
  let frames;
  try {
    ({ frames } = scanZstdFrames(buf));
  } catch (error) {
    return { ok: false, error: `帧扫描失败（文件可能已损坏，先修复再追加）：${String(error?.message ?? error)}` };
  }
  if (frames.length === 0) return { ok: false, error: "日志没有任何 zstd 帧" };
  // 首帧必须能解出「一行 header」——否则这个文件不是合法会话日志，拒绝追加
  let headerText;
  try {
    headerText = (await decodeFrame(buf.subarray(frames[0].start, frames[0].end))).toString("utf8");
  } catch (error) {
    return { ok: false, error: `首帧解码失败：${String(error?.message ?? error)}` };
  }
  const headerLine = headerText.split("\n").find((l) => l.trim() !== "");
  if (!headerLine) return { ok: false, error: "首帧没有 header 行" };
  try {
    const header = JSON.parse(headerLine);
    if (header?.type !== "session") return { ok: false, error: "首帧 header 不是 session 类型" };
  } catch (error) {
    return { ok: false, error: `首帧 header 解析失败：${String(error?.message ?? error)}` };
  }

  let frame;
  try {
    frame = await compressEventLine(JSON.stringify(event));
  } catch (error) {
    return { ok: false, error: `压缩新帧失败：${String(error?.message ?? error)}` };
  }
  try {
    const handle = await open(filePath, "r+");
    try {
      // 追加前最后确认一次文件长度未被他人改变（粗粒度 CAS）
      const stat = await handle.stat();
      if (stat.size !== buf.length) {
        return { ok: false, error: "文件在读取后被修改（长度变化），放弃追加" };
      }
      await handle.write(frame, 0, frame.length, buf.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { ok: false, error: `追加写入失败：${String(error?.message ?? error)}` };
  }
  return { ok: true, seq: event.seq, bytes: frame.length };
}

/** 文件是否以 zstd magic 开头（快速判定，避免对非日志文件做帧扫描）。 */
export function looksLikeZstd(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC;
}

/**
 * 从日志**头部若干帧**里找 `subagent/descriptor` 事件。
 *
 * 【为什么要读头部】宿主 cold resume 子代理时，模型与 provider 取自这条 descriptor
 * （见宿主 manager.coldResume → materialize 的 agentOptions），而不是 `model/selection`。
 * 因此切换模型时必须能读到它、并在它指向已下线的 provider 时同步修正，否则成员会永久唤不醒
 * （宿主报 subagent/not-resumable）。
 *
 * @param {Buffer} buf 整份（压缩的）日志文件内容
 * @param {{headFrames?: number}} [opts]
 * @returns {Promise<{descriptor: object|null, index: number|null}>} index 为事件在「解码行序」中的位置
 */
export async function readDescriptorEvent(buf, opts = {}) {
  const headFrames = Math.max(1, opts.headFrames ?? 3);
  const { frames } = scanZstdFrames(buf);
  const head = frames.slice(0, headFrames);
  let lineIndex = 0;
  for (const fr of head) {
    const text = (await decodeFrame(buf.subarray(fr.start, fr.end))).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      lineIndex += 1;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type === "subagent/descriptor") return { descriptor: event.data ?? null, index: lineIndex };
    }
  }
  return { descriptor: null, index: null };
}
