// 模板路由的三个「写」分支必须能真正跑通 —— 它们曾被漏传依赖打成永久 500。
//
// 现场故障：handleTemplatesPost / handleTemplatesPickPath / handleTemplatesRemove 从主 handler
//   抽出成独立函数时，签名只解构了 ctx/tplHome/browseRoot/meta，而函数体里用了 domain 与 st。
//   于是任何「保存 / 导入 / 清空 / 开关」都抛 ReferenceError: domain is not defined，
//   前端只看到「保存失败」，`enforce` 永远写不进去 ⇒ 方案强制门禁从未能开启。
//
// 【为什么这条必须钉住】原有的 API 测试只覆盖了 GET /templates（读），三个写分支零覆盖，
//   所以 ReferenceError 一路逃到用户面前。这里直接驱动真 handler，把三条写路径各跑一遍：
//   它们只要再漏传任何一个依赖，都会在断言前就抛错。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { depsReady, skipReason } from './helpers/host-deps.mjs';

// 模板路由经 core/domain.js 静态 import 宿主的 @deepseek-ai/dsh-storage-domain，
// 工作区没有 node_modules ⇒ 必须走垫片（同 test-domain-reuse 的约定）。
const routeMod = depsReady ? await import('../../lib/features/settings-routes.js') : null;
const handleTemplatesRoute = routeMod?.handleTemplatesRoute;
// 域实例是进程级缓存：不重置的话第二个用例会复用第一个用例的域，读到别的 state。
const domainMod = depsReady ? await import('../../lib/core/domain.js') : null;
const resetDomainForTest = domainMod?.resetDomainForTest;

/**
 * 造最小 ctx：只提供模板路由用到的持久化域。
 * @param {{state?: object}} [seed] 初始域状态
 */
function makeCtx(seed = {}) {
  // 每个用例都用一份全新的域，避免上一个用例的 state 串过来
  resetDomainForTest?.();
  let state = { ...seed };
  const domain = {
    global: {
      get: () => state,
      set: async (next) => { state = { ...next }; },
    },
  };
  return {
    ctx: {
      get: (key) => (key === 'storageDomain'
        ? { open: async () => domain, get: () => domain }
        : undefined),
      effect: () => {},
      logger: { info: () => {} },
    },
    readState: () => state,
  };
}

/**
 * 造最小 req/res：收集响应体，供断言。
 * @param {{method?: string, body?: object, url?: string}} spec
 */
function makeReqRes({ method = 'GET', body = null, url = '/api/session-conductor/templates' } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() { for (const one of chunks) yield one; },
  };
  const captured = { status: 0, body: null };
  const res = {
    headersSent: false,
    writeHead(status) { captured.status = status; this.headersSent = true; },
    end(payload) { try { captured.body = JSON.parse(payload); } catch { captured.body = payload; } },
  };
  return { req, res, captured };
}

/** 建一个临时模板目录（tplHome）。回调是 async，必须 await 后再清理，否则目录会被提前删掉。 */
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tpl-'));
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('POST 开关分支：开启注入不再抛 domain is not defined，且状态真的落进域', { skip: skipReason }, async () => {
  await withTempHome(async (home) => {
    const { ctx, readState } = makeCtx({});
    const { req, res, captured } = makeReqRes({ method: 'POST', body: { slot: 'plan', enabled: true } });
    await handleTemplatesRoute(req, res, { ctx, tplHome: home, browseRoot: home });
    assert.equal(captured.status, 200, `应回 200，实际 ${captured.status}：${JSON.stringify(captured.body)}`);
    assert.equal(captured.body?.ok, true);
    assert.equal(readState().sessionTemplates?.plan?.enabled, true, '开启状态必须写进持久化域');
  });
});

test('POST 强制门禁分支：enforce 能真正写入（此前正是它开不起来）', { skip: skipReason }, async () => {
  await withTempHome(async (home) => {
    const { ctx, readState } = makeCtx({});
    const { req, res, captured } = makeReqRes({ method: 'POST', body: { slot: 'plan', enforce: true } });
    await handleTemplatesRoute(req, res, { ctx, tplHome: home, browseRoot: home });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.equal(readState().sessionTemplates?.plan?.enforce, true, 'enforce 必须写进持久化域');
  });
});

test('POST 保存内容分支：内容落盘 + 状态更新', { skip: skipReason }, async () => {
  await withTempHome(async (home) => {
    const { ctx, readState } = makeCtx({});
    const content = '# 修改方案提案\n\n## 门禁表\n| 任务 | x |\n\n## 八、是否执行\n请确认';
    const { req, res, captured } = makeReqRes({ method: 'POST', body: { slot: 'plan', name: 'x.md', content } });
    await handleTemplatesRoute(req, res, { ctx, tplHome: home, browseRoot: home });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.ok(existsSync(join(home, 'template-inject-md', 'plan.md')), '内容应落盘');
    assert.equal(readState().sessionTemplates?.plan?.bytes > 0, true);
  });
});

test('POST 清空分支：remove 不抛错且状态清空', { skip: skipReason }, async () => {
  await withTempHome(async (home) => {
    const { ctx, readState } = makeCtx({ sessionTemplates: { plan: { enabled: true, enforce: true, name: 'x.md', url: '', bytes: 10, updatedAt: 1 } } });
    const { req, res, captured } = makeReqRes({ method: 'POST', body: { slot: 'plan', action: 'remove' } });
    await handleTemplatesRoute(req, res, { ctx, tplHome: home, browseRoot: home });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.equal(readState().sessionTemplates?.plan?.enabled, false, '清空后应关闭');
    assert.equal(readState().sessionTemplates?.plan?.enforce, false, '清空后应取消门禁');
  });
});

test('POST 目录内选用分支（pickPath）不抛错', { skip: skipReason }, async () => {
  await withTempHome(async (home) => {
    const mdPath = join(home, 'pick.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(mdPath, '# 修改方案提案\n\n## 门禁表\n| a | b |\n\n## 八、是否执行\n请确认', 'utf8');
    const { ctx, readState } = makeCtx({});
    const { req, res, captured } = makeReqRes({ method: 'POST', body: { slot: 'plan', action: 'pickPath', path: mdPath } });
    await handleTemplatesRoute(req, res, { ctx, tplHome: home, browseRoot: home });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.equal(readState().sessionTemplates?.plan?.bytes > 0, true, '选用后应记录字节数');
  });
});

test('GET 仍返回单一 plan 槽位（closing 已并入 systemPrompt 的收尾约定）', { skip: skipReason }, async () => {
  await withTempHome(async (home) => {
    const { ctx } = makeCtx({});
    const { req, res, captured } = makeReqRes({ method: 'GET' });
    await handleTemplatesRoute(req, res, { ctx, tplHome: home, browseRoot: home });
    assert.equal(captured.status, 200);
    assert.deepEqual(Object.keys(captured.body?.slots ?? {}), ['plan']);
  });
});
