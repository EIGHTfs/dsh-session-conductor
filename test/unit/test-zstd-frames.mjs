/**
 * dsh-session-conductor — zstd 帧修复模块单测（zstd-session-log-repair 能力）
 *
 * 验证：坏文件（整体单帧压缩）检测 / 全仓扫描 / 多帧修复 / 修复后合规 / 事件零丢失
 * 运行: node test-zstd-frames.mjs
 */

import assert from "node:assert/strict";
import { zstdCompress, constants } from "node:zlib";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHeaderFrame, scanAllCorruptFrames, fixZstdFile, decodeAllFrames } from "../../lib/zstd-frames.js";

const zc = promisify(zstdCompress);
const CO = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

const dir = mkdtempSync(join(tmpdir(), "zstd-frames-test-"));
const sessDir = join(dir, "sessions", "proj", "sess1");
mkdirSync(sessDir, { recursive: true });
const header = JSON.stringify({ type: "session", id: "sess1", cwd: "/x" });
const events = [JSON.stringify({ type: "a", seq: 0 }), JSON.stringify({ type: "b", seq: 1 })];
// 坏格式：整体单帧压缩（skill 反面教材）
const bad = await zc(Buffer.from(header + "\n" + events.join("\n") + "\n", "utf8"), CO);
const f = join(sessDir, "session.jsonl.zstd");
writeFileSync(f, bad);

const v = await validateHeaderFrame(readFileSync(f));
ok("坏文件（单帧）检测 corrupt", !v.ok, v.error);

const scan = await scanAllCorruptFrames(join(dir, "sessions"));
ok("全仓扫描发现 1 个损坏", scan.corrupt.length === 1, JSON.stringify(scan.corrupt));

const r = await fixZstdFile(f);
ok("修复成功", r.ok && r.fixed, JSON.stringify(r));
ok("事件数保持 2", r.eventCount === 2, `eventCount=${r.eventCount}`);

const v2 = await validateHeaderFrame(readFileSync(f));
ok("修复后合规（第一帧恰好一行 header）", v2.ok);

const text = await decodeAllFrames(readFileSync(f));
ok("事件零丢失（3 行 = header+2events）", text.split("\n").filter((l) => l.trim()).length === 3);

// 已合规文件不应被重写（幂等）
const r2 = await fixZstdFile(f);
ok("已合规文件跳过（幂等）", r2.ok && r2.fixed === false, JSON.stringify(r2));

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log("全部通过 ✅");
