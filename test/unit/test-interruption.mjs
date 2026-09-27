// 快速验证中断判定/续跑提示/路由折叠（无需 DSH 服务）
// 运行：NODE_PATH=<测试实例 node_modules> node quick-check.mjs
const { interruptionInfo, isAutoEligible, buildContinuePrompt, foldLastRoute } = await import("../../lib/index.js");

const ev = (type, data, seq) => ({ type, seq, time: 1, data });
let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.log("FAIL:", name); } }

// 1. 正常完成 → null
check("completed → null", interruptionInfo([ev("turn/start", {turn:1},1), ev("turn/end", {turn:1, reason:{kind:"completed"}},2)]) === null);
// 2. interrupted → 判定
let info = interruptionInfo([ev("turn/start", {turn:1},1), ev("turn/end", {turn:1, reason:{kind:"interrupted"}},2)]);
check("interrupted 识别", info?.kind === "interrupted" && info.seq === 2);
check("interrupted 可自动续", isAutoEligible(info));
// 3. error RATE_LIMIT → error + 可自动续
info = interruptionInfo([ev("turn/start", {turn:1},1), ev("turn/end", {turn:1, reason:{kind:"error", error:{code:"RATE_LIMIT", message:"429"}}},2)]);
check("error RATE_LIMIT 识别", info?.kind === "error" && info.code === "RATE_LIMIT");
check("error RATE_LIMIT 可自动续", isAutoEligible(info));
// 4. error UNKNOWN → null
check("error UNKNOWN → null", interruptionInfo([ev("turn/start", {turn:1},1), ev("turn/end", {turn:1, reason:{kind:"error", error:{code:"UNKNOWN"}}},2)]) === null);
// 5. aborted user → null（人为取消）
check("aborted user → null", interruptionInfo([ev("turn/start", {turn:1},1), ev("turn/end", {turn:1, reason:{kind:"aborted", reason:{kind:"user"}}},2)]) === null);
// 6. aborted goal → null
check("aborted goal → null", interruptionInfo([ev("turn/start", {turn:1},1), ev("turn/end", {turn:1, reason:{kind:"aborted", reason:{kind:"goal"}}},2)]) === null);
// 7. aborted disposed → 生命周期拆除：不算中断、不自动续
check("aborted disposed → null", interruptionInfo([ev("turn/start", {turn:1},1), ev("turn/end", {turn:1, reason:{kind:"aborted", reason:{kind:"disposed"}}},2)]) === null);
// 8. aborted Error 实例（生命周期）→ aborted 但不可自动续（保守：主动取消/未知一律不自动）
info = interruptionInfo([ev("turn/start", {turn:1},1), ev("turn/end", {turn:1, reason:{kind:"aborted", reason:new Error("agent lifecycle disposed")}},2)]);
check("aborted Error 实例识别", info?.kind === "aborted" && typeof info.code === "string" && info.code.includes("Error"));
check("aborted Error 不自动续", !isAutoEligible(info));
// 9. open turn 末尾 → open-turn：冷会话可自动续（崩溃残留），live 会话不可（运行中）
info = interruptionInfo([ev("turn/start", {turn:1},1)]);
check("open-turn 识别", info?.kind === "open-turn");
check("open-turn 冷会话可自动续", isAutoEligible(info, { live: false }));
check("open-turn live 不自动续", !isAutoEligible(info, { live: true }));
check("open-turn 默认(冷)可自动续", isAutoEligible(info));
// 10. 空事件 → null
check("空事件 → null", interruptionInfo([]) === null);
// 11. blocked → null
check("blocked → null", interruptionInfo([ev("turn/start",{turn:1},1), ev("turn/end",{turn:1,reason:{kind:"blocked"}},2)]) === null);
// 12. 只看最后边界：前面 interrupted 后面 completed → null
check("只看最后边界", interruptionInfo([ev("turn/start",{turn:1},1), ev("turn/end",{turn:1,reason:{kind:"interrupted"}},2), ev("turn/start",{turn:2},3), ev("turn/end",{turn:2,reason:{kind:"completed"}},4)]) === null);
// 13. 续跑提示按类型
check("prompt interrupted", buildContinuePrompt({kind:"interrupted"}).includes("中断"));
check("prompt error 带 code", buildContinuePrompt({kind:"error", code:"TIMEOUT"}).includes("TIMEOUT"));
// 14. foldLastRoute
const routeEvents = [ev("request/header", {header:{config:{provider:"p1", model:"m1"}}, reason:"initial"}, 5), ev("request/header", {header:{config:{provider:"p2", model:"m2"}}, reason:"change"}, 9)];
check("foldLastRoute 取最近", JSON.stringify(foldLastRoute(routeEvents)) === JSON.stringify({provider:"p2", model:"m2"}));
check("foldLastRoute 无 → null", foldLastRoute([ev("user/message", {}, 1)]) === null);

console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
