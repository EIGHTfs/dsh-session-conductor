// mini-host 假服务注入（测试资产）——用**假数据**驱动 dsh-session-conductor 的真 handler，
// 让 API 测试不再依赖运行中的真宿主（真宿主既慢又与现场数据耦合）。
//
// 用法（minihost 已收编进独立插件 dsh-useful-tools，本仓库不再自带副本）：
//   DSH_MINIHOST_SERVICES=<本文件绝对路径> \
//   node <dsh-useful-tools>/assets/dsh-plugin-minihost.mjs --plugin <插件根> --port <端口>
//   或直接用该插件的 `minihost` 工具：action=start / call / stop / list
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
// 夹具时间基准取「当天零点」而不是 Date.now()：minihost 每个请求 fork 一个新进程，
// 用 Date.now() 会让同一份会话的 updatedAt 每次差几毫秒 —— 而 updatedAt 正是
// 价值索引的变更令牌，差一毫秒就判定「会话变过」⇒ 索引永远命中不了，测不出缓存效果。
const NOW = Math.floor(Date.now() / 86400000) * 86400000;

export const FIXTURE = {
  workspaces: [
    { workspaceId: 'ws-main', title: '工作区', path: WS_MAIN },
    { workspaceId: 'ws-gitpush', title: 'dsh-git-push', path: WS_GITPUSH },
  ],
  // 需要会话列表的用例在这里塞假会话；字段与真宿主一致：
  //   id / header.cwd / header.createdAt / events（live 会话）
  // 用途：
  //   · s-active / s-archived / s-old —— 验证「归档 / 时间 / 目录」三个条件；
  //   · s-valuable —— 验证「低价值」条件确实**排除**高价值会话：
  //     它的用户消息带「优化 / 补充」这类细节词（assessValue 的 hasDetail 权重 40 分，
  //     远超高价值分界 30），所以必须判 high、不能被低价值筛选勾中。
  sessions: [
    { id: 's-active', header: { cwd: WS_MAIN, createdAt: NOW - 3600_000 }, events: [
      { type: 'user/message', seq: 1, time: NOW - 3600_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '活跃会话' }] } },
    ] },
    { id: 's-archived', header: { cwd: WS_GITPUSH, createdAt: NOW - 86400_000 * 5 }, events: [
      { type: 'user/message', seq: 1, time: NOW - 86400_000 * 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '归档会话' }] } },
    ] },
    { id: 's-old', header: { cwd: WS_MAIN, createdAt: NOW - 86400_000 * 30 }, events: [
      { type: 'user/message', seq: 1, time: NOW - 86400_000 * 30, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '很旧的会话' }] } },
    ] },
    { id: 's-valuable', header: { cwd: WS_MAIN, createdAt: NOW - 1800_000 }, events: [
      { type: 'user/message', seq: 1, time: NOW - 1800_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我优化这段代码，并补充回归测试' }] } },
      { type: 'assistant/message', seq: 2, time: NOW - 1700_000, data: { message: { content: [{ type: 'text', text: '已完成优化。\n══════\n✅ 任务完成\n交付：补了 3 条测试' }] } } },
    ] },
  ],
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
    // 归档集合必须是**数组**：宽容代理对未知成员返回 no-op 函数，
    // 而 lib/sessions/list.js:61 直接对它 .filter() —— 不显式给数组会变成
    // 「(intermediate value ?? []).filter is not a function」，/list 与所有依赖列表的接口全 400。
    archivedSessionIds: ['s-archived'],
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

  // list() 必须是**同步可迭代数组**：lib/sessions/list.js:77 直接 `for (const s of sessions.list())`，
  // 返回 Promise（async）会变成「sessions?.list is not iterable」，列表与依赖列表的接口全 400。
  sessions: tolerant({ list: () => FIXTURE.sessions }),
  // list() 必须返回**可迭代数组**（同上：代理的 no-op 函数会让 for...of 直接抛）
  sessionPersistence: tolerant({ list: async () => [] }),
  sessionTitle: tolerant(),
  sessionController: tolerant(),
  agents: tolerant(),
  llm: tolerant(),
  settings: tolerant(),
};
