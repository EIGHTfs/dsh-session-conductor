// 自动重命名解析增强：逐平衡括号候选 + 预算配置（0=不限制）
//
// 【守的是什么】截断/思考噪声场景下 JSON 必须还能取出来：
// 上游一旦把 maxTokens 截断，旧贪婪正则 `\{[\s\S]*\}` 会把思考里多段花括号连成
// 一段非法 JSON 直接判死；新实现逐平衡片段试解析，思考里写对了就能用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { braceCandidates, extractTitleOnly, parseDriftJson, resolveAnalysisMaxTokens } from '../../lib/features/rename/parse.js';

test('parseDriftJson 在思考噪声/坏片段混杂里逐段试到第一个合法对象', () => {
  const noisy = '先想想。主题是 X，{bad json 这里断了\n第二尝试 {"changed": true, "title": "正确标题"} 就用这个';
  assert.deepEqual(parseDriftJson(noisy), { changed: true, title: '正确标题' });
});

test('parseDriftJson 容忍代码围栏与尾随解释文字', () => {
  const fenced = '```json\n{"changed": false}\n```\n以上是我的判断';
  assert.deepEqual(parseDriftJson(fenced), { changed: false });
});

test('parseDriftJson 跳过没有 changed 的对象继续找', () => {
  const multi = '{"note":"先记一下"} 然后 {"changed": true, "title": "T"}';
  assert.deepEqual(parseDriftJson(multi), { changed: true, title: 'T' });
});

test('extractTitleOnly 同样逐候选（思考夹多个对象取第一个有效标题）', () => {
  assert.equal(extractTitleOnly('思考…{"note":"x"}…{"title":"好标题"}'), '好标题');
  assert.equal(extractTitleOnly('{"title":"   "} 空标题不算'), null);
});

test('braceCandidates 每个平衡起点都出候选，未闭合尾巴丢弃', () => {
  assert.deepEqual(braceCandidates('a { "x": { "y": 1 } } b {坏 {'),
    ['{ "x": { "y": 1 } }', '{ "y": 1 }'], '外层与内层都是候选');
});

test('字符串值里的花括号不干扰平衡计数', () => {
  assert.deepEqual(parseDriftJson('前缀 {"title": "含 { 与 } 的标题", "changed": true} 后缀'),
    { changed: true, title: '含 { 与 } 的标题' });
});

test('resolveAnalysisMaxTokens：缺省=不限制(undefined)；正数才限制；0/负/非法=不限制', () => {
  assert.equal(resolveAnalysisMaxTokens(undefined), undefined);
  assert.equal(resolveAnalysisMaxTokens(0), undefined);
  assert.equal(resolveAnalysisMaxTokens(-1), undefined);
  assert.equal(resolveAnalysisMaxTokens('abc'), undefined);
  assert.equal(resolveAnalysisMaxTokens('4096'), 4096);
  assert.equal(resolveAnalysisMaxTokens(2048), 2048);
});
