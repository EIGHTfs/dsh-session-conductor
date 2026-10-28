// 插件持久化域「重复打开」自愈 —— 插件模块重载后必须复用宿主里已开的域，而不是一路 500。
//
// 为什么要钉这条（现场故障）：storageDomain 按域名字占用（facility 的 reserved 集合），
//   重复 open 直接抛 `domain 'dsh_session_conductor' is already open`。
//   插件模块热重载时，新实例的 domainPromise 是 null、而宿主的域还活着 ⇒ 再 open 必失败；
//   表现是 /list、/templates 以及所有要读开关的接口一起 500，直到整个实例重启为止。
//
// 修法与判据：捕获 already-open 之后用宿主的诊断口子 storage.get(name) 复用那份 handle；
//   宿主不提供该口子（老版本）时仍如实抛错，且失败的 open 不留缓存（下次请求会重试）。
//
// 【为什么走 host-deps 垫片】本模块静态 import 宿主内部包 @deepseek-ai/dsh-storage-domain，
//   工作区插件目录没有 node_modules，只有宿主依赖目录能解析（垫片按 SC_DEPS/DSH_HOME 定位）。
//   依赖不可用时按约定**明确跳过**并写出原因，不伪装通过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depsReady, skipReason } from './helpers/host-deps.mjs';

const domainMod = depsReady ? await import('../../lib/core/domain.js') : null;
const { pluginDomain, resetDomainForTest, isDomainLive } = domainMod ?? {};

/** 造一个与宿主 DomainError 同形的重复打开错误（带 code，文案一致）。 */
function alreadyOpenError() {
  const error = new Error("domain 'dsh_session_conductor' is already open");
  error.code = 'already-open';
  return error;
}

/** 造一个最小 ctx：只提供 storageDomain 服务与一个可调用的 effect 注册口。 */
function makeCtx(storage) {
  return { get: (key) => (key === 'storageDomain' ? storage : undefined), effect: () => {} };
}

test('重载后 open 报 already-open ⇒ 复用宿主里已开的域', { skip: skipReason }, async () => {
  resetDomainForTest();
  const live = { global: { get: () => ({}) }, close: async () => {} };
  let openCalls = 0;
  const storage = {
    open: async () => { openCalls += 1; throw alreadyOpenError(); },
    get: (name) => (name === 'dsh_session_conductor' ? live : undefined)
  };
  assert.equal(await pluginDomain(makeCtx(storage)), live);
  assert.equal(isDomainLive(), true);
  // 第二次调用复用缓存：不再碰 storage.open
  assert.equal(await pluginDomain(makeCtx(storage)), live);
  assert.equal(openCalls, 1);
});

test('宿主没有查已开域的口子且 open 报 already-open ⇒ 降级为文件后备（不再整片 500）', { skip: skipReason }, async () => {
  // 行为变更：域不可用时不再抛错让所有依赖持久化的接口一起失败，而是改读写落盘 JSON。
  resetDomainForTest();
  let openCalls = 0;
  const storage = { open: async () => { openCalls += 1; throw alreadyOpenError(); } };
  const d1 = await pluginDomain(makeCtx(storage));
  assert.equal(openCalls, 1, '第一次 open 会尝试');
  assert.equal(d1.closed, false, '拿到的是可用（后备）域，而不是抛错');
  assert.equal(isDomainLive(), false, '后备模式下不算“域存活”');
});

test('非 already-open 的 open 失败 ⇒ 同样降级（不吞错，但也不让功能整体不可用）', { skip: skipReason }, async () => {
  resetDomainForTest();
  const storage = { open: async () => { throw new Error('backend-not-found'); }, get: () => undefined };
  const d2 = await pluginDomain(makeCtx(storage));
  assert.equal(d2.closed, false, '应降级为文件后备');
  assert.equal(isDomainLive(), false);
});

test('storageDomain 服务缺失时降级为文件后备（不再让功能整体不可用）', { skip: skipReason }, async () => {
  resetDomainForTest();
  const d = await pluginDomain({ get: () => undefined, effect: () => {} });
  assert.equal(d.closed, false, '应降级为文件后备而不是抛错');
  assert.equal(typeof d.global.get, 'function', '后备域要能读 global');
  assert.equal(typeof d.global.set, 'function', '后备域要能写 global');
});
