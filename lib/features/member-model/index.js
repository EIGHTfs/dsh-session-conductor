// dsh-session-conductor — 成员模型切换（域出口）
//
// 【本域职责】给 Team 队友/子代理单独切模型：
//   · locate.js   目标定位（名册/agents/标题）+ 状态门禁 + 组合校验
//   · override.js override 持久化（domain）与内存镜像 + 请求配置改写
//   · switch.js   执行切换（等空闲 / 写事件 / 未挂载直接写会话日志）
//   · setup.js    resume 时补写切换意图
//
// 对外只暴露本文件——内部文件不直接被域外引用，便于后续再细分或整体提升为顶层目录。

export { pickTeamCaller, memberStatusError, validateModelPair, findTargetAgent } from "./locate.js";
export { getMemberModelOverride, setMemberModelOverride, applyModelOverride, resetMemberModelCacheForTest } from "./override.js";
export { waitForIdle, appendSelectionEventToLog, switchAgentModel } from "./switch.js";
export { resumeSetupFor } from "./setup.js";
