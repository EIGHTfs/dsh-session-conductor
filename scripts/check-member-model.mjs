#!/usr/bin/env node
// 复核「成员模型切换是否生效」——**只认请求级权威记录**。
//
// 用法：
//   node scripts/check-member-model.mjs <sessionId>
//
// 输出：该会话最近一次实际请求使用的 provider/model（来自 `request/header`）+
//       最近一次切换意图（来自 `model/selection`），两者对照即可判断「切没切成」。
//
// 【为什么以 request/header 为准】上下文里注入的 `[model changed: …]` 通知与 `model/selection`
// 事件都只表达「意图」；实测出现过「提示是 agnes、请求头仍是 wb」的不一致 ——
// 只有请求时**真实使用**的 provider/model 算数。
import { readLastRequestModel } from "../lib/features/member-model/switch.js";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("用法：node scripts/check-member-model.mjs <sessionId>");
  process.exit(2);
}

const { lastRequest, lastSelection, scanned } = await readLastRequestModel(sessionId);
if (!lastRequest) {
  console.log(`会话 ${sessionId}：日志里没有 request/header 记录（该会话可能从未发起过请求）`);
} else {
  const when = lastRequest.time ? new Date(lastRequest.time).toLocaleString("zh-CN") : "时间未知";
  console.log(`最近一次实际请求：${lastRequest.provider}/${lastRequest.model}（${when}）`);
}
if (lastSelection) {
  console.log(`最近一次切换意图：${lastSelection.provider}/${lastSelection.model}`);
}
console.log(`（共扫描 ${scanned} 条 request/header；判定只看「最近一次实际请求」）`);
