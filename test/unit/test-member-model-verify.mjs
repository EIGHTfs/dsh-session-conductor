// 成员模型切换「查证」回归 —— 事件判定、回报路由、日志读取。
//
// 【为什么钉这些】
//   · 判定只认「请求时真实使用的 provider/model」（request/header 那条权威记录），
//     不能因为写入了意图就报成功 —— 实测出现过「提示是 agnes、请求头仍是 wb」；
//   · 查证是**注册 job 不阻塞**：切换返回时只给快照，判定发生在下一次请求事件；
//   · 结果必须回报给**发起切换的那一方**（不是被切的成员），否则 AI 收不到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';

// 【为什么直接引 switch.js 而不是域出口 index.js】出口里 setup.js 静态 import 了
// core/domain.js（宿主包）—— 单测环境没有宿主依赖，走出口会在导入期就 ERR_MODULE_NOT_FOUND。
// switch.js 这条链（override 已改懒加载）是宿主无关的，纯逻辑测试引它即可。
import {
  registerSwitchWatch, noteRequestModel, takeSwitchOutcomes,
  peekLastRequestModel, readLastRequestModel, resetSwitchWatchForTest, peekSwitchWatch,
} from '../../lib/features/member-model/switch.js';

test('事件判定：下一请求用了新模型 ⇒ ok=true，且回报给发起方', () => {
  resetSwitchWatchForTest();
  registerSwitchWatch('member-1', 'n', 'deepseek-v4.1-flash', 'requester-1');
  const outcome = noteRequestModel('member-1', { provider: 'n', model: 'deepseek-v4.1-flash' });
  assert.equal(outcome?.ok, true);
  assert.equal(takeSwitchOutcomes('requester-1').length, 1, '结果必须回报给发起方');
  assert.equal(takeSwitchOutcomes('requester-1').length, 0, '取走一次即清空（不重复回报）');
  assert.equal(peekSwitchWatch('member-1'), null, '判定后待查证项应清除');
});

test('事件判定：下一请求仍是旧模型 ⇒ ok=false，且带上实际值（不谎报成功）', () => {
  resetSwitchWatchForTest();
  registerSwitchWatch('member-1', 'n', 'deepseek-v4.1-flash', 'requester-1');
  const outcome = noteRequestModel('member-1', { provider: 'wb', model: 'cn:deepseek-v4-flash' });
  assert.equal(outcome?.ok, false);
  assert.equal(outcome?.actual, 'wb/cn:deepseek-v4-flash');
  assert.match(outcome?.expected ?? '', /n\/deepseek-v4\.1-flash/);
});

test('没有待查证项时只记录、不产生回报', () => {
  resetSwitchWatchForTest();
  assert.equal(noteRequestModel('member-2', { provider: 'wb', model: 'x' }), null);
  assert.deepEqual(takeSwitchOutcomes('requester-1'), []);
  assert.equal(peekLastRequestModel('member-2')?.model, 'x');
});

test('切换未指定发起方时不入队回报（不炸）', () => {
  resetSwitchWatchForTest();
  registerSwitchWatch('member-1', 'n', 'm', null);
  assert.equal(noteRequestModel('member-1', { provider: 'n', model: 'm' })?.ok, true);
  assert.deepEqual(takeSwitchOutcomes('member-1'), []);
});

test('readLastRequestModel：取最近一次 request/header 与最近一次 model/selection（真实多帧 zstd）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mm-verify-'));
  const dir = join(root, '--group--', 'sess-v');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'sess-v', cwd: '/w', createdAt: 1 }),
    JSON.stringify({ seq: 1, type: 'request/header', time: 100, data: { header: { config: { provider: 'wb', model: 'old-model' } } } }),
    JSON.stringify({ seq: 2, type: 'model/selection', time: 110, data: { provider: 'n', model: 'new-model' } }),
    JSON.stringify({ seq: 3, type: 'request/header', time: 200, data: { header: { config: { provider: 'n', model: 'new-model' } } } }),
  ].join('\n') + '\n';
  // 拆两帧，确保跨帧也能取到最后一条
  const half = Math.ceil(lines.length / 2);
  const bufs = [];
  for (const seg of [lines.slice(0, half), lines.slice(half)]) bufs.push(await promisify(zstdCompress)(Buffer.from(seg, 'utf8')));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(bufs));

  const r = await readLastRequestModel('sess-v', root);
  assert.equal(r.lastRequest?.provider, 'n', '必须取**最后**一条 request/header');
  assert.equal(r.lastRequest?.model, 'new-model');
  assert.equal(r.lastSelection?.provider, 'n', '意图也一并返回便于对照');
  assert.equal(r.scanned, 2);
});

test('readLastRequestModel：日志不存在 ⇒ 全 null（调用方据此如实说明）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mm-empty-'));
  const r = await readLastRequestModel('nope', root);
  assert.equal(r.lastRequest, null);
  assert.equal(r.lastSelection, null);
});
