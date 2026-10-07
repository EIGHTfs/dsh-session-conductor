// 成员定位（findTargetAgent）——**直接 import 纯模块**的单测。
//
// 背景：原 test-member-model.mjs 从 lib/index.js 导入 8 个函数，而 lib/index.js 静态导入
// 宿主内部模块 @deepseek-ai/dsh-storage-domain（宿主 node_modules 里没有，只在宿主加载器里可解析）
// ⇒ 在工作区根本跑不起来、实际覆盖为零。
// 本次拆分为「可移植」与「需宿主」两部分：
//   可移植（本文件）：findTargetAgent / memberStatusError 等纯逻辑，直接 import locate.js
//   需宿主（待设计）：switchAgentModel / applyModelOverride / getMemberModelOverride
//     —— 依赖链 switch.js → override.js → core/domain.js → 宿主内部包，只能在宿主环境测
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findTargetAgent } from '../../lib/features/member-model/locate.js';

/** 造一个 agent（形状照搬原测试：session.id / session.title / session.append） */
const agent = (id, title) => ({
  session: { id, title, append: () => {} },
  status: 'idle',
  ctx: { on: () => () => {} },
});

/** 造一个最小 ctx：只需 get('agents') 与 get('sessionTitle') */
function makeCtx({ agents = [], titles = {} } = {}) {
  return {
    get(name) {
      if (name === 'agents') {
        return {
          list: () => agents,
          get: (id) => agents.find((a) => a?.session?.id === id),
          roots: () => agents.slice(0, 1),
          currentInitiator: () => undefined,
        };
      }
      if (name === 'sessionTitle') return { get: (s) => (s?.id && titles[s.id] ? { title: titles[s.id] } : null) };
      return undefined;
    },
  };
}

test('findTargetAgent：按 sessionId 定位', () => {
  const ctx = makeCtx({ agents: [agent('sess-1', '后端'), agent('sess-2', '前端')] });
  const r = findTargetAgent(ctx, 'sess-2');
  assert.equal(r?.error, undefined, `不应报错（实得 ${JSON.stringify(r)}）`);
  assert.equal(r?.agent?.session?.id, 'sess-2');
});

test('findTargetAgent：按标题定位', () => {
  // 注意：标题来源是 ctx.get('sessionTitle')，不是 agent.session.title ⇒ mock 必须给 titles
  const ctx = makeCtx({ agents: [agent('sess-1', '后端'), agent('sess-2', '前端')], titles: { 'sess-2': '前端' } });
  const r = findTargetAgent(ctx, '前端');
  assert.equal(r?.error, undefined, `不应报错（实得 ${JSON.stringify(r)}）`);
  assert.equal(r?.agent?.session?.id, 'sess-2');
});

test('findTargetAgent：无匹配 / 空值 / 无活跃成员 都返回 error', () => {
  const ctx = makeCtx({ agents: [agent('sess-1', '后端')] });
  assert.ok(findTargetAgent(ctx, '不存在的成员')?.error, '无匹配应返回 error');
  assert.ok(findTargetAgent(ctx, '')?.error, '空 target 应返回 error');
  assert.ok(findTargetAgent(makeCtx({ agents: [] }), 'x')?.error, '无活跃成员应返回 error');
});
