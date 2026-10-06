// dsh-session-conductor 会话日志定位单测（v3/v4 文件名兼容）。
// 背景：DSH 0.2.0 起会话日志文件名是 session.v4.jsonl.zstd（v3 时代是 session.jsonl.zstd），
//      插件的扫描/修复类功能必须兼容两种命名，否则升级后找不到文件。
// 运行：node test/unit/test-session-log.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSessionLog, isSessionLogName } from "../../lib/session-log.js";

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };

const dir = mkdtempSync(join(tmpdir(), "session-log-"));

// v3 命名（0.1.x）
{
  const d = join(dir, "v3");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "session.jsonl.zstd"), "x");
  assert.equal(findSessionLog(d), join(d, "session.jsonl.zstd"), "识别 v3 session.jsonl.zstd");
  ok("findSessionLog：v3 命名");
}

// v4 命名（DSH 0.2.0）
{
  const d = join(dir, "v4");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "session.v4.jsonl.zstd"), "x");
  assert.equal(findSessionLog(d), join(d, "session.v4.jsonl.zstd"), "识别 v4 session.v4.jsonl.zstd");
  ok("findSessionLog：v4 命名（0.2.0）");
}

// 未来版本命名兜底
{
  const d = join(dir, "v9");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "session.v9.jsonl.zstd"), "x");
  assert.equal(findSessionLog(d), join(d, "session.v9.jsonl.zstd"), "兜底匹配未来版本命名");
  ok("findSessionLog：未来命名兜底（v9）");
}

// 无日志 / 空路径
{
  const d = join(dir, "none");
  mkdirSync(d, { recursive: true });
  assert.equal(findSessionLog(d), null, "目录里没有日志返回 null");
  assert.equal(findSessionLog(""), null, "空路径返回 null");
  ok("findSessionLog：无日志 / 空路径返回 null");
}

// 不误认明文
{
  const d = join(dir, "plain");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "session.jsonl"), "x");
  assert.equal(findSessionLog(d), null, "只认 .zstd 压缩日志，不把明文当日志");
  ok("findSessionLog：不误认明文 session.jsonl");
}

// isSessionLogName
{
  assert.equal(isSessionLogName("session.jsonl.zstd"), true, "v3 名");
  assert.equal(isSessionLogName("session.v4.jsonl.zstd"), true, "v4 名");
  assert.equal(isSessionLogName("session.jsonl"), false, "明文不算");
  assert.equal(isSessionLogName("other.zstd"), false, "无关文件不算");
  ok("isSessionLogName：命名判定");
}

rmSync(dir, { recursive: true, force: true });
console.log(`TEST PASS: ${pass}`);
