// 模型组合校验：显示名 → 模型 id 的归一化（纯函数，可独立单测）
//
// 【为什么需要】宿主只按「模型 id」查表。模型目录里 id 与显示名是两套东西：
//   id   = global:deepseek-v4.1-flash
//   name = Deepseek-V4.1-Flash
// 传显示名时宿主会报「没有配置该模型」，而且那句话里还提 context window，
// 很容易被读成「窗口不够大」而去调窗口——实际只是名字对不上。
// 所以校验层要能把显示名归一化成 id：唯一命中就纠正，多个命中就报歧义，不猜。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelByLabel } from '../../lib/features/member-model/locate.js';

/** 与真实目录同形状的最小样本（id 与 name 不同，是问题发生的前提）。 */
const MODELS = [
  { id: 'global:deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
  { id: 'cn:deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash-CN' },
  { id: 'global:hy3', name: 'Hy3' },
  { id: 'auto' },
];

test('传显示名 → 解析出模型 id', () => {
  assert.deepEqual(resolveModelByLabel(MODELS, 'Deepseek-V4.1-Flash'), {
    id: 'global:deepseek-v4.1-flash',
    ambiguous: [],
  });
});

test('大小写/空格/连字符/点差异都能匹配（归一化后比较）', () => {
  for (const variant of ['deepseek-v4.1-flash', 'DEEPSEEK V4.1 FLASH', 'Deepseek.V4.1.Flash', 'deepseek_v4_1_flash']) {
    assert.equal(resolveModelByLabel(MODELS, variant).id, 'global:deepseek-v4.1-flash', `变体「${variant}」应命中`);
  }
});

test('传的本来就是 id 时也命中（幂等，不会误改）', () => {
  assert.equal(resolveModelByLabel(MODELS, 'cn:deepseek-v4.1-flash').id, 'cn:deepseek-v4.1-flash');
  assert.equal(resolveModelByLabel(MODELS, 'auto').id, 'auto');
});

test('多个模型归一化后同名 → 报歧义，不替用户选', () => {
  const dup = [
    { id: 'a:flash', name: 'Flash' },
    { id: 'b:flash', name: 'Flash' },
  ];
  const result = resolveModelByLabel(dup, 'Flash');
  assert.equal(result.id, null, '歧义时必须返回 null');
  assert.equal(result.ambiguous.length, 2);
});

test('完全不存在 → 返回空结果（交给调用方报可用清单）', () => {
  assert.deepEqual(resolveModelByLabel(MODELS, 'gpt-9-ultra'), { id: null, ambiguous: [] });
  assert.deepEqual(resolveModelByLabel(MODELS, ''), { id: null, ambiguous: [] });
  assert.deepEqual(resolveModelByLabel(null, 'x'), { id: null, ambiguous: [] });
});

test('name 缺失的条目只按 id 匹配，不会误命中', () => {
  assert.equal(resolveModelByLabel(MODELS, 'auto').id, 'auto');
  assert.equal(resolveModelByLabel([{ id: 'auto' }], 'Auto Label').id, null);
});
