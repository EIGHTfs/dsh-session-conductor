// dsh-session-conductor — 会话日志的流式逐事件读取（公共底座）
//
// 【为什么单独抽出来】「按 zstd 帧流式解码 + 行缓冲 + 逐行 JSON 解析 + 坏行跳过」这段
// 在记忆取回（readRecentUserTurns）与成员轨迹（readMemberTrace）里是**逐字重复**的。
// 两处各写一份的代价不只是重复：帧边界跨行、坏行容错、解码器收尾这些细节只要一边改错，
// 就会表现为「某类会话读出来少了一段」，而且很难察觉。抽成一处后，两个消费方只保留
// 「按 type 怎么组织」的差异。
//
// 【为什么流式】会话日志可达数十 MB、上万事件。全量 decode 再 split 会一次性占用
// 数倍于文件大小的内存；流式逐帧 + 边读边丢，内存只与消费方保留的状态有关。
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { streamDecodedFrames } from "../zstd-frames.js";

/**
 * 逐事件流式读取一个会话日志。
 *
 * 回调收到的顺序与日志顺序一致。单个坏行（截断、半帧、非 JSON）会被跳过并计数，
 * **不中断**整次读取 —— 损坏会话仍能读出可用前缀，这对修复类功能是刚需。
 *
 * @param {Buffer} buf 已读入内存的日志内容（调用方决定读哪个文件；这样也便于单测直接喂 Buffer）
 * @param {(event: object) => void} onEvent 每解析出一个事件调用一次
 * @returns {Promise<{events: number, bad: number}>} events = 成功解析数；bad = 跳过的坏行数
 */
export async function streamSessionEvents(buf, onEvent) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let events = 0;
  let bad = 0;

  const consumeLine = (line) => {
    if (!line || !line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      bad += 1;
      return;
    }
    events += 1;
    onEvent(event);
  };

  await streamDecodedFrames(buf, (chunk) => {
    pending += decoder.write(chunk);
    let idx;
    while ((idx = pending.indexOf("\n")) >= 0) {
      consumeLine(pending.slice(0, idx));
      pending = pending.slice(idx + 1);
    }
  });
  // 解码器收尾：多字节字符可能跨帧被切开，必须 flush 后再处理残留行
  pending += decoder.end();
  consumeLine(pending);

  return { events, bad };
}

/**
 * 读文件并逐事件回调（对 streamSessionEvents 的薄封装，省掉调用方自己 readFile）。
 *
 * @param {string} file 会话日志绝对路径
 * @param {(event: object) => void} onEvent 事件回调
 * @returns {Promise<{events: number, bad: number}>}
 */
export async function streamSessionFile(file, onEvent) {
  return await streamSessionEvents(await readFile(file), onEvent);
}
