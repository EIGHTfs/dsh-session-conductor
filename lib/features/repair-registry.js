// dsh-session-conductor — 会话日志修复类型的唯一登记处
//
// 【为什么单独成文件】修复能力原先散在三处：后端 6 条路由分在 session-action-routes.js 与
// session-ops-routes.js 两个文件、前端三段「扫描→确认→修复」同构代码、i18n 与 README 各写一份
// 清单。结果是后端有的类型前端没入口（zstd 帧级 / seq 断裂 / 工具参数三类只能 curl 调），
// 新增一种修复要在 4 处同步改，漏一处就出现「后端能修、面板看不见」。
//
// 现在只有这一份清单：新增修复类型 = 在 REPAIR_KINDS 加一项，
// 前端通过 GET /api/session-conductor/repair-kinds 取清单渲染，不再硬编码任何路由。
// 守卫测试（test/unit/test-repair-registry.mjs）会断言每条 route 在代码中真实注册，
// 防止「登记了却没实现」。

/**
 * 修复类型清单。
 * - id：稳定标识（前端循环渲染、日志用）
 * - route：真实注册的 HTTP 路径（守卫测试会核对）
 * - i18nKey：文案键前缀（`<key>.title` / `<key>.desc` / `<key>.scanClean` / `<key>.confirm` / `<key>.done`）
 * - scanBody：扫描请求体（各路由的历史协议不同，逐条适配，不强行统一路由端）
 * - countPath：从扫描响应里取「待修数量」的点路径（数组取长度、数字直接用），
 *   适配各路由不同的返回结构；必须是可序列化的字符串，前端照此取值
 */
export const REPAIR_KINDS = Object.freeze([
  {
    id: "sessions",
    route: "/api/session-conductor/repair-sessions",
    i18nKey: "repair",
    scanBody: { dryRun: true },
    // scanCorruptSessions 把问题会话数放在 report.corrupt
    countPath: "report.corrupt",
  },
  {
    id: "frames",
    route: "/api/session-conductor/repair-frames",
    i18nKey: "repairFrames",
    scanBody: { dryRun: true },
    // scanCorruptFrames 同结构
    countPath: "report.corrupt",
  },
  {
    id: "seq-gap",
    route: "/api/session-conductor/repair-seq-gap",
    i18nKey: "repairSeqGap",
    scanBody: { dryRun: true },
    countPath: "report.corrupt",
  },
  {
    id: "eio",
    route: "/api/session-conductor/repair-eio",
    i18nKey: "repairEio",
    scanBody: { dryRun: true },
    // 这条路由把坏块清单放在顶层 eio 数组（不是 report 里）
    countPath: "eio",
  },
  {
    id: "dual-format",
    route: "/api/session-conductor/repair-dual-format",
    i18nKey: "repairDual",
    scanBody: { dryRun: true },
    // scanDualFormatSessions 的 report.dual 是冲突目录清单
    countPath: "report.dual",
  },
  {
    id: "arguments",
    route: "/api/session-conductor/repair-arguments",
    i18nKey: "repairArguments",
    // 这条路由要求 all:true 才做全库扫描，否则按单会话处理
    scanBody: { dryRun: true, all: true },
    // scanArgumentIssues 把有问题的会话放进 dirty 数组
    countPath: "dirty",
  },
]);

/** 按 id 取一项；未知 id 返回 undefined（调用方据此回 400，不静默当成某种修复）。 */
export function repairKindById(id) {
  return REPAIR_KINDS.find((kind) => kind.id === id) ?? null;
}

/**
 * 供前端渲染的清单：全部字段都是可序列化的标量/对象，前端不需要认识任何具体路由。
 * @returns {Array<{id: string, route: string, i18nKey: string, scanBody: object, countPath: string}>}
 */
export function repairKindsForClient() {
  return REPAIR_KINDS.map(({ id, route, i18nKey, scanBody, countPath }) => ({
    id,
    route,
    i18nKey,
    scanBody: { ...scanBody },
    countPath,
  }));
}
