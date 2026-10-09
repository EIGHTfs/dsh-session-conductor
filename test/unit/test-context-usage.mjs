// 上下文用量自查工具（context_usage）——**直接 import 纯模块**的单测。
//
// 覆盖三层：
//   ① formatTokens / resolveOccupancy —— 纯换算（口径必须与前端 context-occupancy.ts 一致）
//   ② readContextUsage —— 读投影（用最小 mock ctx，不依赖宿主）
//   ③ formatContextUsage —— 输出格式（含高占用提醒与缺数据说明）
// 不覆盖：registerContextUsageTool 的 tools.register 调用（需要宿主 tools 服务）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HIGH_USAGE_PERCENT,
  formatTokens,
  resolveOccupancy,
  readContextUsage,
  formatContextUsage,
} from '../../lib/features/context-usage/index.js';

/** 造一个只提供 sessionProjections 的最小 ctx */
function makeCtx(values) {
  return {
    get(name) {
      if (name === 'sessionProjections') {
        return { snapshot: () => ({ values }) };
      }
      return undefined;
    },
  };
}

/** 造一个带 session 的最小 agent */
const agentWithSession = { session: { id: 'sess-1' } };

// ---------- ① 换算 ----------

test('formatTokens：边界与单位', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1K');
  assert.equal(formatTokens(3600), '3.6K');       // <100 保留 1 位小数
  assert.equal(formatTokens(82000), '82K');      // >=100 取整（82000/1000=82）
  assert.equal(formatTokens(82100), '82.1K');    // 82.1 < 100 → 保留 1 位小数
  assert.equal(formatTokens(1000000), '1M');
  assert.equal(formatTokens(1048576), '1M');
  assert.equal(formatTokens(Number.NaN), '-');    // 非法值不炸
});

test('resolveOccupancy：projectedTokens 优先于 pressureTokens', () => {
  const occ = resolveOccupancy({ contextWindow: 1_000_000, pressureTokens: 80_000, projectedTokens: 82_000 });
  assert.equal(occ.usedTokens, 82_000);
  assert.equal(occ.source, 'projected');
  assert.equal(occ.percent, 8);                   // 82000/1000000 → 8%
});

test('resolveOccupancy：无 projected 时退回 pressureTokens', () => {
  const occ = resolveOccupancy({ contextWindow: 1_000_000, pressureTokens: 80_000 });
  assert.equal(occ.usedTokens, 80_000);
  assert.equal(occ.source, 'reported');
  assert.equal(occ.percent, 8);
});

test('resolveOccupancy：缺容量或缺用量都返回 null（与 UI 一致）', () => {
  assert.equal(resolveOccupancy({ pressureTokens: 1000 }), null, '缺 contextWindow 应为 null');
  assert.equal(resolveOccupancy({ contextWindow: 1000 }), null, '缺用量应为 null');
  assert.equal(resolveOccupancy(undefined), null);
});

test('resolveOccupancy：percent 上限 100（估算可能略微超容量）', () => {
  const occ = resolveOccupancy({ contextWindow: 1000, pressureTokens: 1500 });
  assert.equal(occ.percent, 100);
});

// ---------- ② 读投影 ----------

test('readContextUsage：exec.agent 缺失时如实报错，不抛异常', () => {
  const snap = readContextUsage(makeCtx({}), undefined);
  assert.equal(snap.ok, false);
  assert.match(snap.reason, /拿不到当前会话/);
});

test('readContextUsage：sessionProjections 不可用时如实报错', () => {
  const snap = readContextUsage({ get: () => undefined }, agentWithSession);
  assert.equal(snap.ok, false);
  assert.match(snap.reason, /sessionProjections 服务不可用/);
});

test('readContextUsage：正常读取占用与分项', () => {
  const ctx = makeCtx({
    contextPressure: { contextWindow: 1_000_000, pressureTokens: 80_000, projectedTokens: 82_000 },
    contextBreakdown: { systemTokens: 3600, toolsTokens: 8500, messageTokens: 55200 },
  });
  const snap = readContextUsage(ctx, agentWithSession);
  assert.equal(snap.ok, true);
  assert.equal(snap.occupancy.percent, 8);
  assert.equal(snap.breakdown.toolsTokens, 8500);
  assert.deepEqual(snap.missing, []);
});

test('readContextUsage：服务在但投影为空时，missing 说明缺什么', () => {
  const snap = readContextUsage(makeCtx({}), agentWithSession);
  assert.equal(snap.ok, true);
  assert.equal(snap.occupancy, null);
  assert.equal(snap.breakdown, null);
  assert.equal(snap.missing.length, 2, `应报两项缺失，实得 ${JSON.stringify(snap.missing)}`);
});

test('readContextUsage：投影 snapshot 抛错时兜住并返回 ok:false', () => {
  const ctx = { get: () => ({ snapshot: () => { throw new Error('boom'); } }) };
  const snap = readContextUsage(ctx, agentWithSession);
  assert.equal(snap.ok, false);
  assert.match(snap.reason, /读会话投影失败.*boom/);
});

// ---------- ③ 输出格式 ----------

test('formatContextUsage：包含百分比、用量与三个分项', () => {
  const ctx = makeCtx({
    contextPressure: { contextWindow: 1_000_000, projectedTokens: 82_000 },
    contextBreakdown: { systemTokens: 3600, toolsTokens: 8500, messageTokens: 55200 },
  });
  const text = formatContextUsage(readContextUsage(ctx, agentWithSession));
  assert.match(text, /上下文已用 8%/);
  assert.match(text, /~82K \/ 1M tokens/);
  assert.match(text, /系统提示词 {2}~3\.6K/);
  assert.match(text, /工具定义 {2}~8\.5K/);
  assert.match(text, /对话消息 {2}~55\.2K/);
  assert.match(text, /启发式估算/, '必须提示这是估算，不是计费值');
});

test(`formatContextUsage：占用 >= ${HIGH_USAGE_PERCENT}% 时附收敛建议`, () => {
  const ctx = makeCtx({ contextPressure: { contextWindow: 100_000, projectedTokens: 90_000 } });
  const text = formatContextUsage(readContextUsage(ctx, agentWithSession));
  assert.match(text, /上下文已用 90%/);
  assert.match(text, /⚠️ 占用已达 90%/, '高占用应出现提醒');
});

test(`formatContextUsage：低于 ${HIGH_USAGE_PERCENT}% 时不打扰`, () => {
  const ctx = makeCtx({ contextPressure: { contextWindow: 100_000, projectedTokens: 50_000 } });
  const text = formatContextUsage(readContextUsage(ctx, agentWithSession));
  assert.doesNotMatch(text, /⚠️/);
});

test('formatContextUsage：数据缺失时说明原因而不是给空', () => {
  const text = formatContextUsage(readContextUsage(makeCtx({}), agentWithSession));
  assert.match(text, /缺：/, '应有一段说明缺了什么');
  assert.match(text, /contextPressure/);
});

test('formatContextUsage：ok:false 时输出失败原因', () => {
  const text = formatContextUsage({ ok: false, reason: '测试原因' });
  assert.match(text, /无法读取上下文用量：测试原因/);
});
