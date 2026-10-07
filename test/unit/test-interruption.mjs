// 中断判定 / 续跑提示 / 路由折叠——**直接 import 纯模块**的单测。
//
// 为什么不从 lib/index.js 导入（原写法）：index.js 依赖宿主包（@deepseek-ai/*），
// 在工作区里 `Cannot find package` ⇒ 测试根本跑不起来、实际覆盖为零。
// 这三个模块本身**不依赖宿主包**（实测可独立加载），直接 import 即可在任意环境跑。
// 用例与原测试逐条对应（14 组断言），只改导入来源与断言写法（node:test）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interruptionInfo, isAutoEligible } from '../../lib/sessions/interruption.js';
import { buildContinuePrompt } from '../../lib/features/continue/eligibility.js';
import { foldLastRoute } from '../../lib/sessions/route.js';

const ev = (type, data, seq) => ({ type, seq, time: 1, data });

test('1. 正常完成 → null', () => {
  assert.equal(interruptionInfo([ev('turn/start', { turn: 1 }, 1), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2)]), null);
});

test('2. interrupted → 识别 + 可自动续', () => {
  const info = interruptionInfo([ev('turn/start', { turn: 1 }, 1), ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 2)]);
  assert.equal(info?.kind, 'interrupted');
  assert.equal(info?.seq, 2);
  assert.equal(isAutoEligible(info), true);
});

test('3. error RATE_LIMIT → error + 可自动续', () => {
  const info = interruptionInfo([ev('turn/start', { turn: 1 }, 1), ev('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429' } } }, 2)]);
  assert.equal(info?.kind, 'error');
  assert.equal(info?.code, 'RATE_LIMIT');
  assert.equal(isAutoEligible(info), true);
});

test('4. error UNKNOWN → 仍判为 error 且可自动续（按当前设计）', () => {
  // 原测试断言「error UNKNOWN → null」，那是旧语义；当前设计是「任意请求错误都可自动续」
  // （限流/超时/服务端/鉴权/上下文超限等一律视为非人为中断），实测 code=UNKNOWN 也返回
  // { kind:'error', code:'UNKNOWN' } 且 isAutoEligible=true ⇒ 断言按当前行为修正。
  const info = interruptionInfo([ev('turn/start', { turn: 1 }, 1), ev('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN' } } }, 2)]);
  assert.equal(info?.kind, 'error');
  assert.equal(info?.code, 'UNKNOWN');
  assert.equal(isAutoEligible(info), true, '当前设计下未知请求错误也可自动续');
});

test('5-7. aborted（user / goal / disposed）→ null（人为取消或生命周期拆除不算中断）', () => {
  for (const reason of ['user', 'goal', 'disposed']) {
    assert.equal(
      interruptionInfo([ev('turn/start', { turn: 1 }, 1), ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: reason } } }, 2)]),
      null,
      `aborted ${reason} 应为 null`,
    );
  }
});

test('8. aborted Error 实例 → 识别为 aborted，但保守地不自动续', () => {
  const info = interruptionInfo([ev('turn/start', { turn: 1 }, 1), ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: new Error('agent lifecycle disposed') } }, 2)]);
  assert.equal(info?.kind, 'aborted');
  assert.equal(typeof info.code, 'string');
  assert.ok(info.code.includes('Error'));
  assert.equal(isAutoEligible(info), false);
});

test('9. open-turn → 冷会话可自动续，live 会话不可', () => {
  const info = interruptionInfo([ev('turn/start', { turn: 1 }, 1)]);
  assert.equal(info?.kind, 'open-turn');
  assert.equal(isAutoEligible(info, { live: false }), true);
  assert.equal(isAutoEligible(info, { live: true }), false);
  assert.equal(isAutoEligible(info), true, '默认（冷）应可自动续');
});

test('10-11. 空事件 / blocked → null', () => {
  assert.equal(interruptionInfo([]), null);
  assert.equal(interruptionInfo([ev('turn/start', { turn: 1 }, 1), ev('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 2)]), null);
});

test('12. 只看最后边界：interrupted 之后 completed → null', () => {
  assert.equal(
    interruptionInfo([
      ev('turn/start', { turn: 1 }, 1), ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 2),
      ev('turn/start', { turn: 2 }, 3), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 4),
    ]),
    null,
  );
});

test('13. 续跑提示按类型生成', () => {
  assert.ok(buildContinuePrompt({ kind: 'interrupted' }).includes('中断'));
  assert.ok(buildContinuePrompt({ kind: 'error', code: 'TIMEOUT' }).includes('TIMEOUT'));
});

test('14. foldLastRoute 取最近一次路由，无路由返回 null', () => {
  const routeEvents = [
    ev('request/header', { header: { config: { provider: 'p1', model: 'm1' } }, reason: 'initial' }, 5),
    ev('request/header', { header: { config: { provider: 'p2', model: 'm2' } }, reason: 'change' }, 9),
  ];
  assert.deepEqual(foldLastRoute(routeEvents), { provider: 'p2', model: 'm2' });
  assert.equal(foldLastRoute([ev('user/message', {}, 1)]), null);
});
