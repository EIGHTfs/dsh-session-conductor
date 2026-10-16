// 聊天框指令 `/model-switch` 回归 —— 注册守卫、参数解析、可读回显。
//
// 【为什么钉这些】
//   · 宿主依赖（@deepseek-ai/dsh-commands/brand）在工作区**不存在**，注册必须**跳过并留痕**，
//     不能抛 —— 插件历史上在 defineTool / createUserMessage 上踩过「静态引用宿主包 ⇒ 整个插件
//     加载失败」的坑，指令这条路径同样必须守卫；
//   · 指令的输入直接来自用户在聊天框敲的字，写法五花八门（少参、多参、斜杠位置错）——
//     每一种都要给人话错误，而不是抛异常或静默无响应；
//   · 回显文本是用户唯一能看到的东西，必须包含「下一步该敲什么」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerModelSwitchCommand, handleModelSwitchCommand } from '../../lib/features/member-model/command.js';

test('注册守卫：没有 commands 服务 ⇒ 返回 false（不抛）', async () => {
  assert.equal(await registerModelSwitchCommand({}), false);
  assert.equal(await registerModelSwitchCommand({ get: () => undefined }), false);
});

test('注册守卫：有 commands 服务但拿不到 brand 包 ⇒ 仍为 false（工作区无宿主依赖的实测路径）', async () => {
  const registered = [];
  const ctx = { get: (n) => (n === 'commands' ? { register: (d) => registered.push(d) } : undefined) };
  const ok = await registerModelSwitchCommand(ctx);
  assert.equal(ok, false, '缺 @deepseek-ai/dsh-commands/brand 时必须放弃注册');
  assert.equal(registered.length, 0, '不该注册半成品描述符');
});

test('无参：空名册也要给人话提示，且指明下一步敲什么', async () => {
  const r = await handleModelSwitchCommand({ get: () => undefined }, { rawInput: '' });
  assert.equal(r.kind, 'success');
  assert.match(r.text, /没读到任何成员/);
});

test('找不到成员：error 且带原因（不抛）', async () => {
  const r = await handleModelSwitchCommand({ get: () => undefined }, { rawInput: '不存在的成员' });
  assert.equal(r.kind, 'error');
  assert.match(r.text, /找不到成员/);
});

test('模型写法非法：拒绝并给出正确写法', async () => {
  // 目标能定位到（用假的 agents 列表让它命中），但第二段不是 provider/model
  const ctx = {
    get: (n) => {
      if (n === 'agents') return { list: () => [{ session: { id: 'sess-1', title: '甲' } }] };
      return undefined;
    },
  };
  const r = await handleModelSwitchCommand(ctx, { rawInput: 'sess-1 只有模型名没有斜杠' });
  assert.equal(r.kind, 'error');
  assert.match(r.text, /provider\/<model>|provider>\//);
});

test('多参：只取前两段（多余内容不误当模型名）', async () => {
  const ctx = {
    get: (n) => {
      if (n === 'agents') return { list: () => [{ session: { id: 'sess-1', title: '甲' } }] };
      return undefined;
    },
  };
  // 第二段合法、第三段是噪声：解析应只看第二段（切换会因无 domain 失败，但不该报「写法非法」）
  const r = await handleModelSwitchCommand(ctx, { rawInput: 'sess-1 wb/global:glm-5.3-flash 额外噪声' });
  assert.equal(r.kind, 'error', '工作区没有 domain ⇒ 切换必然失败，这是预期');
  assert.doesNotMatch(r.text, /要写成 <provider>/, '不该被判成写法非法');
});
