// mini-host 假服务注入（测试资产）——用**假数据**驱动 dsh-session-conductor 的真 handler，
// 让 API 测试不再依赖运行中的真宿主（真宿主既慢又与现场数据耦合）。
//
// 用法：
//   DSH_MINIHOST_SERVICES=<本文件绝对路径> \
//   node <skill>/dsh-plugin-minihost.mjs --plugin <插件根> --port <端口>
// 说明：mini-host 的 ctx 垫片默认只提供 webServer/tools/systemPrompt/commands/settings；
//   需要宿主服务的插件会走「服务缺失」降级分支或直接 500。本文件把缺失的服务补上假实现。
//
// 设计：
//   ① 已知服务给「够用的假实现」——插件 apply() 在接线期会调用它们（如 storageDomain.open），
//      形状不对会直接抛错导致**路由一个都不注册**（实测：apply 抛错: storage.open is not a function）。
//   ② 未知成员用宽容代理兜底（返回 no-op 函数），避免 `x.y is not a function` 再次炸接线。
//   ③ 假数据集中在本文件顶部的 FIXTURE；测试要改数据只改这里，不改插件代码。
//
// 路径约定：FIXTURE 里的目录一律由 SC_FIXTURE_ROOT 派生（默认 os.tmpdir()），不硬编码本机绝对路径。
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.env.SC_FIXTURE_ROOT || join(tmpdir(), 'sc-fixture');
const WS_MAIN = join(ROOT, '工作区');
const WS_GITPUSH = join(WS_MAIN, 'dsh-git-push');

export const FIXTURE = {
  workspaces: [
    { workspaceId: 'ws-main', title: '工作区', path: WS_MAIN },
    { workspaceId: 'ws-gitpush', title: 'dsh-git-push', path: WS_GITPUSH },
  ],
  // 需要会话列表的用例在这里塞假会话；字段与真宿主一致：
  //   id / title / cwd / updatedAt / archived / archiveWs / interruption
  sessions: [],
};

/** 宽容代理：未知成员一律返回 no-op 函数（链式调用也不炸）。 */
function tolerant(known = {}) {
  return new Proxy(known, {
    get: (t, k) => (k in t ? t[k] : (() => undefined)),
    has: () => true,
  });
}

export default {
  workspaceRegistry: tolerant({
    list: () => FIXTURE.workspaces.map((w) => ({ ...w })),
    create: async (p, title) => ({ id: 'ws-new', path: p, title }),
  }),

  // 插件接线期会调 storageDomain.open(spec)（lib/core/domain.js:116）——必须返回可用域对象
  storageDomain: tolerant({
    open: async () => ({
      global: {
        get: () => ({}),
        set: async () => {},
      },
    }),
  }),

  sessions: tolerant({ list: async () => FIXTURE.sessions }),
  sessionPersistence: tolerant(),
  sessionTitle: tolerant(),
  sessionController: tolerant(),
  agents: tolerant(),
  llm: tolerant(),
  settings: tolerant(),
};
