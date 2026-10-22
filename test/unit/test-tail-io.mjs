// 尾部增量写（tail-io）自测：追加帧必须与「整份重编码」等价，且不破坏已有帧。
//
// 背景：成员模型切换原先是「整份解码 → 拼全文 → 全量校验 → 整份重编码」，30MB 日志时
// 峰值内存数百 MB。优化后改为「只读尾部若干帧 + 把新事件压缩成一个新帧追加到文件尾」。
// 本测试把「等价性」钉死：追加后的解码文本 = 原文本 + 新事件行，且 seq 严格 +1 连续，
// 首帧仍是恰好一行 header（DSH 的 assertZstdHeaderFrame 语义）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAllFrames, scanZstdFrames, validateHeaderFrame } from "../../lib/zstd-frames.js";
import { readTailEvents, appendEventFrame } from "../../lib/sessions/tail-io.js";
import { encodeSessionText } from "../../lib/repair.js";

/** 造一个多帧会话日志（header 帧 + 事件帧），返回文件路径。 */
async function makeLog(dir, eventCount) {
  const header = { type: "session", version: 4, id: "session-tail-io-test", createdAt: 1, cwd: "/tmp/demo" };
  const lines = [JSON.stringify(header)];
  for (let i = 0; i < eventCount; i += 1) {
    lines.push(JSON.stringify({ type: "step/end", seq: i, time: 1000 + i, data: { turn: 1, step: i + 1 } }));
  }
  const file = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(file, await encodeSessionText(lines.join("\n") + "\n"));
  return file;
}

test("追加帧后：解码文本 = 原文本 + 新事件行，seq 连续", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-tail-io-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = await makeLog(home, 20);

  const before = await decodeAllFrames(readFileSync(file));
  const beforeLines = before.split("\n").filter((l) => l.trim() !== "");
  const lastSeq = JSON.parse(beforeLines.at(-1)).seq;

  const event = { type: "model/selection", seq: lastSeq + 1, time: Date.now(), data: { provider: "sa6400", model: "deepseek-v4.1-flash" } };
  const r = await appendEventFrame(file, event);
  assert.equal(r.ok, true, JSON.stringify(r));

  const after = await decodeAllFrames(readFileSync(file));
  const afterLines = after.split("\n").filter((l) => l.trim() !== "");
  assert.equal(afterLines.length, beforeLines.length + 1, "应只多一行");
  assert.deepEqual(afterLines.slice(0, beforeLines.length), beforeLines, "原有内容必须逐字节不变");
  const appended = JSON.parse(afterLines.at(-1));
  assert.equal(appended.type, "model/selection");
  assert.equal(appended.seq, lastSeq + 1);
  assert.deepEqual(appended.data, { provider: "sa6400", model: "deepseek-v4.1-flash" });

  // 全量 seq 连续性
  let prev = -1;
  for (const line of afterLines.slice(1)) {
    const e = JSON.parse(line);
    if (typeof e.seq !== "number") continue;
    assert.equal(e.seq, prev + 1, `seq 跳号：期望 ${prev + 1} 实际 ${e.seq}`);
    prev = e.seq;
  }
});

test("追加帧后：首帧仍是恰好一行 header（DSH 首帧契约）", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-tail-io-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = await makeLog(home, 5);
  await appendEventFrame(file, { type: "model/selection", seq: 5, time: Date.now(), data: { provider: "p", model: "m" } });
  const check = await validateHeaderFrame(readFileSync(file));
  assert.equal(check.ok, true, JSON.stringify(check));
});

test("readTailEvents：只解尾部帧也拿得到最后事件与总帧数", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-tail-io-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = await makeLog(home, 30);
  const { frames } = scanZstdFrames(readFileSync(file));
  const tail = await readTailEvents(readFileSync(file), { tailFrames: 2 });
  assert.equal(tail.frames, frames.length, "总帧数应等于文件实际帧数");
  assert.ok(tail.tailStartFrame < tail.frames, "尾部起点帧应小于总帧数");
  assert.ok(tail.events.length > 0, "尾部应能取到事件");
  assert.equal(tail.events.at(-1).seq, 29, "最后一个事件 seq 应为 29");
});

test("追加到「已有 model/selection」的日志：seq 继续递增、不重复", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-tail-io-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = await makeLog(home, 3);
  await appendEventFrame(file, { type: "model/selection", seq: 3, time: Date.now(), data: { provider: "a", model: "x" } });
  await appendEventFrame(file, { type: "model/selection", seq: 4, time: Date.now(), data: { provider: "b", model: "y" } });
  const lines = (await decodeAllFrames(readFileSync(file))).split("\n").filter((l) => l.trim() !== "");
  const selections = lines.slice(1).map((l) => JSON.parse(l)).filter((e) => e.type === "model/selection");
  assert.equal(selections.length, 2);
  assert.deepEqual(selections.map((s) => s.seq), [3, 4]);
  assert.equal(selections.at(-1).data.provider, "b");
});

test("对非 zstd 文件追加：如实报错且不写坏文件", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-tail-io-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "session.v4.jsonl.zstd");
  writeFileSync(file, "这不是 zstd 数据");
  const before = readFileSync(file);
  const r = await appendEventFrame(file, { type: "model/selection", seq: 0, time: Date.now(), data: { provider: "p", model: "m" } });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /帧扫描失败|首帧/);
  assert.deepEqual(readFileSync(file), before, "失败时文件必须保持原样");
});
