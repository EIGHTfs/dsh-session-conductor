// 前缀路由兜底回归（lib/group.js）——**必须回响应，不得空响应挂死**。
//
// 事故现场（2026-10-07 之前）：/api/session-conductor/group 是 kind:'prefix' 路由，
//   整个子命名空间都归本插件，框架**不会**在 handler 返回 undefined 后继续找别的路由。
//   旧实现在末尾直接 `return`（无响应）⇒ GET /api/session-conductor/group（缺 workspaceId）
//   永不响应 ⇒ test/api/test-group-api.mjs 挂死、整轮 api 测试 timeout 124，
//   表现为「一个看不见的失败」而不是一条红色用例。
//
// 本测试不依赖运行中的宿主：直接捕获 registerGroupRoutes 注册的 prefix handler 并调用它，
//   用 mock req/res 断言「任何未匹配的路径/方法都必须就地收到 404」——把兜底行为钉死在单测里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 宿主依赖解析：lib/group.js 静态 import `@deepseek-ai/schemastery`，而工作区插件目录
 * 没有 node_modules（宿主启动时才从 profile 解析）。单测要 import 它就得分两处：
 *   ① 依赖目录沿用与 test/api/helpers/host-api.mjs 相同的约定（默认本机实例，SC_DSH_HOME/SC_DEPS 可覆盖）；
 *   ② 用 node:module 的 registerHooks 在 resolve 阶段把 `@deepseek-ai/*` 指过去。
 * 依赖缺失时本文件**明确跳过**并说明原因，而不是伪装通过。
 */
const HOST_HOME = process.env.SC_DSH_HOME || '/volume1/@appdata/DeepSeekHarness-NAS/0.2.0-rc.2/.dsh';
const DEPS = process.env.SC_DEPS || join(HOST_HOME, 'profiles', 'web', 'node_modules');
const depsReady = existsSync(join(DEPS, '@deepseek-ai', 'schemastery'));
const skip = depsReady ? false : `缺宿主依赖目录（${DEPS}，用 SC_DEPS 覆盖）`;

if (depsReady) {
  const req = createRequire(join(DEPS, 'noop.cjs'));
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec.startsWith('@deepseek-ai/') || spec.startsWith('@dsh-')) {
        try { return next(pathToFileURL(req.resolve(spec)).href, ctx); } catch { /* 落回默认解析 */ }
      }
      return next(spec, ctx);
    },
  });
}

const { registerGroupRoutes } = depsReady ? await import('../../lib/group.js') : {};

/** 最小 mock res：记录状态码与响应体，end 即视为「已响应」。 */
function mockRes() {
  const state = { statusCode: null, body: '', ended: false };
  const res = {
    writeHead(code) { state.statusCode = code; return res; },
    end(chunk) { state.body = chunk === undefined ? '' : String(chunk); state.ended = true; return res; },
    setHeader() { return res; },
    getHeader() { return undefined; },
  };
  return { res, state };
}

/** 捕获 registerGroupRoutes 注册的 prefix handler（fake webServer + 宽容 ctx）。 */
async function captureHandler() {
  let registered = null;
  const webServer = { register: (spec) => { registered = spec; return () => {}; } };
  const wctx = {
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (fn) => { if (typeof fn === 'function') fn(); return () => {}; },
  };
  const ctx = {
    inject: (names, fn) => fn(wctx),
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (fn) => { if (typeof fn === 'function') fn(); return () => {}; },
  };
  await registerGroupRoutes(ctx, {}, {});
  assert.ok(registered, 'registerGroupRoutes 应注册一个 prefix 路由');
  return registered;
}

/** 给 handler 加超时：无响应时**快速失败并说明原因**，而不是让测试挂死。 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 在 ${ms}ms 内没有任何响应（prefix 兜底缺失）`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test('prefix 路由：未匹配的路径/方法必须就地回 404（不得空响应挂死）', { skip }, async () => {
  const spec = await captureHandler();
  assert.equal(spec.kind, 'prefix', '注册类型应为 prefix（子命名空间全归本插件）');
  assert.equal(spec.path, '/api/session-conductor/group');

  const cases = [
    ['GET', '/api/session-conductor/group'],                    // 缺 workspaceId（历史挂死点）
    ['GET', '/api/session-conductor/group/__nope__'],           // 不存在的子接口
    ['POST', '/api/session-conductor/group/status'],            // 方法不匹配（status 只认 GET）
    ['GET', '/api/session-conductor/group/list/extra'],         // 前缀更长的未知路径
  ];
  for (const [method, url] of cases) {
    const { res, state } = mockRes();
    await withTimeout(spec.handler({ method, url, headers: {} }, res), 2000, `${method} ${url}`);
    assert.equal(state.ended, true, `${method} ${url} 必须结束响应（否则请求挂死）`);
    assert.equal(state.statusCode, 404, `${method} ${url} 应回 404，实得 ${state.statusCode}`);
    assert.ok(state.body.includes('ok'), `响应体应是 JSON 错误结构，实得 ${state.body.slice(0, 80)}`);
  }
});

test('prefix 路由：handler 抛错时回 500 且仍然结束响应', { skip }, async () => {
  const spec = await captureHandler();
  // 触发异常路径：url 解析失败（传入非法的 url 类型）
  const { res, state } = mockRes();
  await withTimeout(spec.handler({ method: 'GET', url: { toString() { throw new Error('bad url'); } }, headers: {} }, res), 2000, 'GET <bad url>');
  assert.equal(state.ended, true, '异常路径也必须结束响应');
  assert.equal(state.statusCode, 500, `应回 500，实得 ${state.statusCode}`);
});
