// 逐 API 具体测试：其余端点的只读 / 校验路径（零副作用）。
//
// 覆盖服务端 34 处注册里尚未被测到的端点中，**不需要夹具、不产生副作用**的部分：
//   /templates/dir（GET）、/preview/（GET）、/detach、/delete-batch、/delete-by-rule、/search
// 需要夹具才能测正常路径的（detach-all / repair-* / scan / message / analyze / value-analysis /
// auto-rename / auto-continue）留待夹具测试，本文件只钉住「不得 500」这条底线。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, requireHost } from './helpers/host-api.mjs';

const hostUp = await requireHost();
const skip = hostUp ? false : '宿主不可用（未启动或端口不同；可用 SC_HOST 覆盖）';

test('GET /templates/dir：返回模板目录信息（不得 500）', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/templates/dir');
  assert.notEqual(r.status, 500, `不该 500（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
  assert.ok([200, 400, 404].includes(r.status), `可接受 200/400/404，实得 ${r.status}`);
});

test('GET /preview/：路径前缀端点不因缺参 500', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/preview/');
  assert.notEqual(r.status, 500, `不该 500（实得 ${r.status}）`);
  assert.ok([200, 400, 404].includes(r.status), `可接受 200/400/404，实得 ${r.status}`);
});

// ⚠️ 安全边界：本文件**只测只读端点**。
//   原因：delete-batch / delete-by-rule / detach 这类端点的「空 body」语义未核实——
//   delete-by-rule 的界面文案写着「超过 N 天未活跃（0=不限）」，空 body 很可能等于
//   「不限条件」⇒ 可能删掉全部会话。**在读懂其校验逻辑之前，绝不用空 body 探测这类端点。**
//   它们的测试改为：先读 handler 的校验分支，再用明确的「必然不匹配」参数构造用例。

test('GET /search：缺查询参数不得 500', { skip }, async () => {
  const r = await api('GET', '/api/session-conductor/search');
  assert.notEqual(r.status, 500, `不该 500（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
});

test('POST /auto-rename：空 body 必须 400（sessionId 必填）', { skip }, async () => {
  // 实测确认：该端点空 body 回 400（参数校验分支），不会触发重命名动作 ⇒ 安全
  const r = await api('POST', '/api/session-conductor/auto-rename', {});
  assert.equal(r.status, 400, `应回 400（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
  assert.equal(r.json?.ok, false);
});

test('POST /auto-continue：空 body 必须 400（sessionId 必填，校验先于任何落盘）', { skip }, async () => {
  // 读代码确认：sessionId 非空字符串校验在所有副作用之前（否则回 400 并 return）
  // ⇒ 空 body 不会改动 autoContinue 开关、不会启动续跑，属安全用例
  const r = await api('POST', '/api/session-conductor/auto-continue', {});
  assert.equal(r.status, 400, `应回 400（实得 ${r.status}：${String(r.text).slice(0, 140)}）`);
  assert.equal(r.json?.ok, false);
});
