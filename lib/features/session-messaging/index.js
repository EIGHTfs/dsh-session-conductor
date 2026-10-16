// dsh-session-conductor — 跨会话消息域（域出口）
//
// 【本域职责】给 AI 三个可直接调用的工具：
//   · list_sessions    列出本机会话（挑投递目标用）
//   · send_to_session  给指定会话投递一条消息（目标空闲时由本体唤醒；支持 dryRun 预览）
//   · create_session   新建会话，可指定 provider/model，可选带初始消息（支持 dryRun 预览）
//
// 【文件分工】logic.js = 常量 / 纯函数 / 限流状态机 / 本体调用封装；
//   tools.js = 三个工具的注册；本文件只做再导出 —— 域外只 import 本文件，
//   内部结构可自由调整（照 features/member-model 的写法）。
//
// 【设计口径】全部走本体官方 API（sessionController 的 create / selectModel / prompt），
//   不自己写会话日志 —— 原因见 logic.js 头部注释。

export { registerSessionMessagingTools, readListIndex } from "./tools.js";
export {
  formatSessionList,
  resetMessagingStateForTest,
  statusOf,
  shortError,
  mapPromptError,
  checkModelPair,
  TEXT_LIMIT,
  HOPS_LIMIT,
  RATE_MAX,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
} from "./logic.js";
