// dsh-session-conductor — 成员模型切换（域出口）
//
// 【本域职责】给 Team 队友/子代理单独切模型：
//   · locate.js   目标定位（名册/agents/标题）+ 状态门禁 + 组合校验
//   · override.js override 持久化（domain）与内存镜像 + 请求配置改写
//   · switch.js   执行切换（等空闲 / 写事件 / 未挂载直接写会话日志）
//   · setup.js    resume 时补写切换意图
//
// 对外只暴露本文件——内部文件不直接被域外引用，便于后续再细分或整体提升为顶层目录。

export {
  pickTeamCaller, memberStatusError, validateModelPair, findTargetAgent,
  // 批量目标解析（空 / `*` / `all` = 全部成员，排除 Lead）与 Lead 定位
  collectTeamMembers, isAllTarget, resolveTargets, resolveLeader,
} from "./locate.js";
export { getMemberModelOverride, setMemberModelOverride, applyModelOverride, resetMemberModelCacheForTest } from "./override.js";
export { waitForIdle, appendSelectionEventToLog, switchAgentModel } from "./switch.js";
// 切换查证（事件驱动，注册 job 不阻塞）：登记待查证项 → 每次请求记录实际模型 → 按事件判定 → 结果回报
export {
  registerSwitchWatch, peekSwitchWatch, noteRequestModel, takeSwitchOutcomes,
  peekLastRequestModel, readLastRequestModel, resetSwitchWatchForTest,
} from "./switch.js";
export { resumeSetupFor } from "./setup.js";
// 聊天框指令 /model-switch（用户视角入口，与 AI 工具共用同一条切换 + 查证路径）
export { registerModelSwitchCommand, handleModelSwitchCommand } from "./command.js";
// 权限预设查看/切换（子代理在界面上切不了，只能写会话日志；与模型切换同一套成员定位）
export {
  readMemberPermission, readPresetCatalog, switchMemberPermission,
  describeMemberPermission, renderMemberPermissionList,
} from "./permission.js";
export { registerPermSwitchCommand, handlePermSwitchCommand } from "./permission-command.js";
// 「跟随主代理」的取值来源（Lead 当前真实模型 + 当前权限预设）
export { readLeaderRoute } from "./lead.js";
// 批量应用与回执渲染（串行执行、逐个隔离失败、回执带完整名单）
export { applyModelToMany, applyPermissionToMany, renderBatchReport, memberDisplay } from "./batch.js";
