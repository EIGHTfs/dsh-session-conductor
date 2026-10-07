// dsh-session-conductor — 统一日志（插件所有模块共用）
//
// 【为什么单独成文件】log 被 index.js 与所有子模块调用，是拆分后最底层的公共依赖；
// 放在 shared 下可让各域直接 import，不必反向依赖插件入口（避免循环引用）。

/**
 * 输出一行插件日志：优先走宿主 logger，不可用（如请求回调 fiber）时降级到 stdout。
 * @param {object} ctx 插件上下文
 * @param {string} message 日志内容
 */
export function log(ctx, message) {
  try {
    ctx.logger.info(`dsh-session-conductor: ${message}`);
  } catch {
    console.log(`[dsh-session-conductor] ${message}`);
  }
}
