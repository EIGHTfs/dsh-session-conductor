// 自动重命名解析健壮性：正文为空时回退思考块（推理型模型预算被吃掉的情形）
import assert from 'node:assert/strict';
import { pickParseSource, extractTitleOnly, parseDriftJson } from '../../lib/features/rename/parse.js';

// ① 正文有内容 → 用正文（不看思考块）
assert.equal(pickParseSource([
  { type: 'reasoning', text: '想一下：{"title":"错的"}' },
  { type: 'text', text: '{"title":"对的"}' },
]), '{"title":"对的"}');

// ② 正文为空、思考块里有 JSON → 回退到思考块（这是修复点）
const fallback = pickParseSource([
  { type: 'reasoning', text: '先判断是否偏离…… 输出 {"changed": false}' },
  { type: 'text', text: '' },
]);
assert.match(fallback, /changed/);
assert.equal(parseDriftJson(fallback)?.changed, false);

// ③ 两者都空 → 空串（调用方给明确错误，而不是静默当 unchanged）
assert.equal(pickParseSource([{ type: 'text', text: '  ' }]), '');

// ④ 带代码块围栏也能解析（历史行为不能退化）
assert.equal(extractTitleOnly('```json\n{"title":"标题"}\n```'), '标题');

// ⑤ 强制标题模式：思考块回退同样生效
assert.equal(extractTitleOnly(pickParseSource([{ type: 'reasoning', text: '{"title":"回退标题"}' }])), '回退标题');

console.log('全部通过 ✓');
