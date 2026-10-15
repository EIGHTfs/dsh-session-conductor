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
  formatContextUsageCompact,
  createContextUsageInjector,
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

// ---------- ④ 每轮注入用的紧凑格式（v1.2.0 新增） ----------

test('formatContextUsageCompact：单行含百分比/用量/三分项', () => {
  const text = formatContextUsageCompact(readContextUsage(
    makeCtx({
      contextPressure: { contextWindow: 1_000_000, projectedTokens: 461_000 },
      contextBreakdown: { systemTokens: 3600, toolsTokens: 8500, messageTokens: 276_000 },
    }),
    agentWithSession,
  ));
  assert.match(text, /^【上下文用量】已用 46%/);
  assert.match(text, /~461K \/ 1M tokens/);
  assert.match(text, /系统 ~3\.6K/);
  assert.match(text, /工具 ~8\.5K/);
  assert.match(text, /消息 ~276K/);
  assert.ok(!text.includes('\n'), '必须是单行（每轮都进上下文，不能占多行）');
});

test('formatContextUsageCompact：高占用时附收敛提醒', () => {
  const text = formatContextUsageCompact(readContextUsage(
    makeCtx({ contextPressure: { contextWindow: 100_000, projectedTokens: 90_000 } }),
    agentWithSession,
  ));
  assert.match(text, new RegExp(`已达 ${HIGH_USAGE_PERCENT}%`));
});

test('formatContextUsageCompact：拿不到数据时返回空串（调用方据此跳过注入）', () => {
  assert.equal(formatContextUsageCompact({ ok: false, reason: 'x' }), '');
  assert.equal(formatContextUsageCompact(readContextUsage(makeCtx({}), agentWithSession)), '');
  assert.equal(formatContextUsageCompact(null), '');
});

// ---------- ⑤ 按轮门控的注入器（v1.2.0 新增） ----------

test('injector：同一 turn 只放行一次（pre-step 每步都触发，不能每步都注入）', () => {
  const inj = createContextUsageInjector();
  const agent = { session: { id: 'a' } };
  assert.equal(inj.shouldInject(agent, 1), true);
  assert.equal(inj.shouldInject(agent, 1), false, '同一回合第二步不得重复注入');
  assert.equal(inj.shouldInject(agent, 1), false);
  assert.equal(inj.shouldInject(agent, 2), true, '下一回合要重新注入');
});

test('injector：不同 agent 各自记账（互不影响）', () => {
  const inj = createContextUsageInjector();
  const a1 = { session: { id: 'a1' } };
  const a2 = { session: { id: 'a2' } };
  assert.equal(inj.shouldInject(a1, 1), true);
  assert.equal(inj.shouldInject(a2, 1), true, '另一个 agent 的同一 turn 也该注入');
});

test('injector：关闭时一律不放行', () => {
  const inj = createContextUsageInjector({ enabled: false });
  assert.equal(inj.shouldInject({ session: { id: 'a' } }, 1), false);
});

test('injector：agent 缺失或 turn 非法时不放行（不抛错）', () => {
  const inj = createContextUsageInjector();
  assert.equal(inj.shouldInject(null, 1), false);
  assert.equal(inj.shouldInject({ session: { id: 'a' } }, undefined), false);
  assert.equal(inj.shouldInject({ session: { id: 'a' } }, 'abc'), false);
});

test('injector：textFor 用注入的假实现（可单测、不依赖宿主投影）', () => {
  const inj = createContextUsageInjector({
    readUsage: () => ({ ok: true, occupancy: { percent: 7 }, breakdown: null }),
    format: (s) => (s.ok ? `用量 ${s.occupancy.percent}%` : ''),
  });
  assert.equal(inj.textFor({}, {}), '用量 7%');
});

test('injector：读投影抛错时 textFor 返回空串（不影响回合）', () => {
  const inj = createContextUsageInjector({
    readUsage: () => { throw new Error('投影炸了'); },
  });
  assert.equal(inj.textFor({}, {}), '');
});
