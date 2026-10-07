/**
 * 单测用的「宿主依赖解析」垫片。
 *
 * 为什么需要：插件部分模块静态 import 宿主包（如 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`），
 *   而工作区插件目录**没有 node_modules**（宿主启动时才从 profile 解析）。单测要 import 这些模块
 *   必须两步：
 *     ① 找到宿主依赖目录（与 test/api/helpers/host-api.mjs 同约定：默认本机实例，SC_DSH_HOME/SC_DEPS 可覆盖）；
 *     ② 用 node:module 的 registerHooks 在 resolve 阶段把宿主包（`@deepseek-ai/…`、`@dsh-…`）指过去。
 *        ⚠️ 块注释里别写星号紧跟斜杠的 glob（那两个字符连写会提前闭合注释——本文件刚踩过）。
 * 依赖缺失时调用方应**明确跳过**并说明原因（skipReason），不伪装通过。
 *
 * 用法：
 *   import { depsReady, skipReason } from './helpers/host-deps.mjs';
 *   const { something } = depsReady ? await import('../../lib/xxx.js') : {};
 *   test('…', { skip: skipReason }, () => { … });
 */
import { createRequire, registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 宿主 DSH_HOME（默认本机 0.2.0-rc.2 实例，可用 SC_DSH_HOME 覆盖）。 */
export const HOST_HOME = process.env.SC_DSH_HOME || '/volume1/@appdata/DeepSeekHarness-NAS/0.2.0-rc.2/.dsh';
/** 宿主依赖目录（可用 SC_DEPS 覆盖）。 */
export const DEPS = process.env.SC_DEPS || join(HOST_HOME, 'profiles', 'web', 'node_modules');
/** 依赖是否就绪（用 schemastery 作探针：插件入口链上出现的首个宿主包）。 */
export const depsReady = existsSync(join(DEPS, '@deepseek-ai', 'schemastery'));
/** 未就绪时的跳过原因（node:test 的 skip 字段用它，测试输出会写明原因）。 */
export const skipReason = depsReady ? false : `缺宿主依赖目录（${DEPS}，用 SC_DEPS 覆盖）`;

if (depsReady) {
  const req = createRequire(join(DEPS, 'noop.cjs'));
  registerHooks({
    resolve(spec, ctx, next) {
      // 相对路径 / 绝对路径 / node: 内建 / file: URL —— 一律交给默认解析
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('file:')) {
        return next(spec, ctx);
      }
      try {
        return next(spec, ctx); // 工作区能解析到就用工作区的
      } catch {
        // 工作区解析不到的裸包（宿主侧依赖：zod、@deepseek-ai/* 等）→ 从宿主依赖目录兜底解析
        return next(pathToFileURL(req.resolve(spec)).href, ctx);
      }
    },
  });
}
