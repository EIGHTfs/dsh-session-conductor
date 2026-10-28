// 切换后同步 live agent 的 options（官方「查看子智能体」视图的模型显示）。
//
// 背景：宿主 experimental/agent-team 的 memberView() 里，成员模型取的是 `live.options.model`
// —— agent **创建时**的 AgentOptions，与我们写的 `model/selection` 事件无关。
// 不同步的话，界面会一直显示创建时的老模型，而实际请求早已换了模型，两边长期对不上。
//
// 为什么能改：宿主 ReactLoopAgent 构造是 `this.options = options` 直接引用、没有 freeze
// （该文件只冻结 boundaryMessages 与请求标记）。这里仍做 isFrozen 兜底：
// 将来宿主若冻结，跳过同步即可，绝不影响切换本身。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncLiveAgentOptions } from '../../lib/features/member-model/switch.js';

/** 最小 ctx（log 只用到 ctx.get/info，缺失时内部会吞掉）。 */
const ctx = { get: () => undefined };

test('正常情况：把 provider 与 model 写进 live.options', () => {
  const live = { options: { provider: 'ccc', model: 'old-model' } };
  const ok = syncLiveAgentOptions(ctx, live, 'sa6400', 'cn:deepseek-v4.1-flash');
  assert.equal(ok, true);
  assert.equal(live.options.provider, 'sa6400');
  assert.equal(live.options.model, 'cn:deepseek-v4.1-flash');
});

test('没有 live agent（成员未挂载）⇒ 跳过，不抛错', () => {
  assert.equal(syncLiveAgentOptions(ctx, null, 'a', 'b'), false);
  assert.equal(syncLiveAgentOptions(ctx, undefined, 'a', 'b'), false);
  assert.equal(syncLiveAgentOptions(ctx, {}, 'a', 'b'), false, '无 options 也跳过');
});

test('options 被冻结时跳过，且不改动其内容', () => {
  const options = Object.freeze({ provider: 'ccc', model: 'old-model' });
  const live = { options };
  const ok = syncLiveAgentOptions(ctx, live, 'sa6400', 'new-model');
  assert.equal(ok, false, '冻结时应返回 false');
  assert.equal(live.options.provider, 'ccc', '冻结对象内容不能变');
  assert.equal(live.options.model, 'old-model');
});

test('options 只读属性抛错时不冒泡（不影响切换本身）', () => {
  const live = {};
  Object.defineProperty(live, 'options', {
    get() { return { get model() { throw new Error('read-only'); } }; },
    enumerable: true,
  });
  const ok = syncLiveAgentOptions(ctx, live, 'sa6400', 'x');
  assert.equal(ok, false, '写失败应返回 false 而不是抛出去');
});
