/** 进程级护栏：崩溃/未捕获异常的处理安装与状态查询。 */

import { log } from "./shared/log.js";

/** 进程级异常兜底（，幂等）。
 *  背景：宿主 bin.ts 没有注册 unhandledRejection/uncaughtException，Node 15+ 对未处理的
 *  promise rejection 默认 `throw` → **整个 DSH 进程退出**。自动续跑是长链异步（resume 会话、
 *  等回合、写账），任何一处 rejection 逃逸都会表现为「续跑能用，但 DSH 跑一会就死」。
 *  这里注册兜底 handler：记录日志后**不退出进程**，让宿主与其它插件继续工作；同时把错误
 *  写进插件日志便于后续定位。重复 apply（热重载）不会重复注册。
 */
let processGuardsInstalled = false;

export function installProcessGuards(ctx) {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  try {
    process.on("unhandledRejection", (reason) => {
      try {
        log(ctx, `⚠️ 捕获未处理的 Promise rejection（已阻止进程退出）: ${String(reason?.stack ?? reason?.message ?? reason)}`);
      } catch {
        /* 日志自身失败也不能再抛 */
      }
    });
  } catch {
    /* 某些宿主环境（沙箱/受限 worker）可能不允许注册，忽略 */
  }
}
