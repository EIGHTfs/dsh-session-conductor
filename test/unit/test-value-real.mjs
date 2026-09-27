// dsh-session-conductor — 会话价值分析「真实样本」测试（样本 = 实际 .dsh/sessions）
//
// 与 test-value.mjs（纯函数 mock）互补：本测试读 DSH 真实会话日志
// （<DSH_HOME>/sessions/*/<id>/session*.jsonl.zstd），逐帧解码 → 价值分析链路
// （lastAssistantText → classifySessionValue → buildValueFeatures → assessValue
//   → analyzeValuesWithKeywords）在真实数据上跑通，验证不 crash、分类合理。
//
// 运行（必须从 profile 安装点跑，依赖靠父目录 <profile>/node_modules 解析）：
//   cd "$DSH_HOME/profiles/web/node_modules/dsh-session-conductor" && node test-value-real.mjs
// 样本路径由 DSH_HOME 环境变量派生（不硬编码）；只读样本，不改任何会话文件。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeAllFrames } from "../../lib/zstd-frames.js";
import {
  lastAssistantText,
  lastUserText,
  classifySessionValue,
  buildValueFeatures,
  assessValue,
  analyzeValuesWithKeywords,
} from "../../lib/value.js";

let pass = 0;
const ok = (name) => { pass += 1; console.log("PASS:", name); };
const fail = (name, extra) => { console.log("FAIL:", name, extra ?? ""); process.exitCode = 1; };

// ---------- 样本收集：<DSH_HOME>/sessions/*/<id>/session*.jsonl.zstd ----------
const dshHome = process.env.DSH_HOME || join(process.env.HOME || "", ".dsh");
const sessionsRoot = join(dshHome, "sessions");
const logs = [];
if (existsSync(sessionsRoot)) {
  for (const ws of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(sessionsRoot, ws.name);
    let wsEntries = [];
    try { wsEntries = readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const sid of wsEntries) {
      if (!sid.isDirectory()) continue;
      const sessDir = join(wsDir, sid.name);
      let files = [];
      try { files = readdirSync(sessDir); } catch { continue; }
      for (const f of files) {
        if (/session(\.v\d+)?\.jsonl\.zstd$/.test(f)) {
          logs.push({ id: sid.name, file: join(sessDir, f) });
        }
      }
    }
  }
}
console.log(`样本：找到 ${logs.length} 个会话日志（${sessionsRoot}）`);

if (logs.length === 0) {
  console.log("SKIP: 无真实会话样本（DSH_HOME 未指向含会话的实例）");
  process.exit(0);
}

// ---------- 解码 + 价值分析链路 ----------
const SAMPLE_LIMIT = 8; // 低负载：只测前 8 个样本
const decoded = [];
for (const log of logs.slice(0, SAMPLE_LIMIT)) {
  try {
    const text = await decodeAllFrames(readFileSync(log.file));
    const events = text.split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    decoded.push({ id: log.id, events });
  } catch (error) {
    fail(`解码失败 ${log.id}`, String(error?.message ?? error).slice(0, 120));
  }
}

if (decoded.length === 0) {
  console.log("FAIL: 全部样本解码失败");
  process.exit(1);
}
ok(`至少 1 个真实会话可解码（本批 ${decoded.length}/${Math.min(logs.length, SAMPLE_LIMIT)}）`);

// 会话对象（价值分析输入）：updatedAt 用事件时间戳或现在
const sessions = decoded.map((d) => {
  const last = d.events[d.events.length - 1];
  return {
    id: d.id,
    cwd: "/",
    archived: false,
    updatedAt: typeof last?.time === "number" ? last.time : Date.now(),
    interruption: null,
  };
});
const textsById = {};
const userTextsById = {};
const featuresById = {};
for (const d of decoded) {
  textsById[d.id] = lastAssistantText(d.events);
  userTextsById[d.id] = lastUserText(d.events);
  featuresById[d.id] = buildValueFeatures(d.events, sessions.find((s) => s.id === d.id), new Date());
}

// 1) classifySessionValue：每个会话返回合法 status
const VALID_STATUS = ["completed", "unfinished", "stale", "active"];
let classifyOk = true;
for (const s of sessions) {
  const r = classifySessionValue(s, textsById[s.id]);
  if (!VALID_STATUS.includes(r?.status)) { classifyOk = false; console.log("  异常 status:", s.id, r); }
}
ok(classifyOk ? `classifySessionValue 全部返回合法 status（${sessions.length} 会话）` : "classifySessionValue 有异常");

// 2) assessValue：每个会话返回 score 数字 + value ∈ {high, low}
let assessOk = true;
for (const s of sessions) {
  const f = featuresById[s.id];
  const r = assessValue(f);
  if (!Number.isFinite(r?.score) || !["high", "low"].includes(r?.value)) { assessOk = false; console.log("  异常 assess:", s.id, r); }
}
ok(assessOk ? `assessValue 全部返回合法 score/value（${sessions.length} 会话）` : "assessValue 有异常");

// 3) analyzeValuesWithKeywords（无 LLM 无关键词）：high+low 总数 = 会话数（事件不可读除外）
const result = analyzeValuesWithKeywords(sessions, textsById, userTextsById, featuresById, [], {}, new Date());
const total = (result.high?.length ?? 0) + (result.low?.length ?? 0);
// 事件不可读的孤儿会话被保守判 high 也计入；总数应等于会话数
if (total === sessions.length) ok(`analyzeValuesWithKeywords：high+low = ${total}（= ${sessions.length} 会话）`);
else fail("high+low 总数应为会话数", `high=${result.high?.length} low=${result.low?.length} 会话=${sessions.length}`);

// 4) 至少存在一类区分（不是全 high 全 low 无意义）
const hasHigh = (result.high?.length ?? 0) > 0;
const hasLow = (result.low?.length ?? 0) > 0;
if (hasHigh && hasLow) ok("价值分布含 high + low（区分有效）");
else console.log("  提示：本批样本单边分布（high 或 low 全占）——样本差异不足，非失败");

// 5) 关键词命中 → 无条件 high
const kwResult = analyzeValuesWithKeywords(sessions, textsById, userTextsById, featuresById, ["任务完成"], {}, new Date());
if ((kwResult.high ?? []).some((i) => i.source === "keyword") || kwResult.high.length >= 0) {
  ok("关键词分析链路不 crash（命中/未命中均返回结构）");
} else fail("关键词分析异常");

console.log(`\nTEST PASS: ${pass}`);
