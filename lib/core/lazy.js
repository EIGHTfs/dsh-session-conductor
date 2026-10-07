// dsh-session-conductor — 重量级模块的按需加载器
//
// 【为什么单独成文件】修复/分析类模块（repair、zstd-frames、seq-gap、eio、value）
// 体积大且只在特定功能触发时才用到；按需 import 可让插件启动更快。
// 拆分成多个域后，各域都需要这些加载器——集中在这里避免重复定义与循环引用。

let _lazyRepair = null;
let _lazyZstd = null;
let _lazySeqGap = null;
let _lazyEio = null;
let _lazyValue = null;
let _lazyFs = null;

export const lazyRepair = () => (_lazyRepair ??= import("../repair.js"));
export const lazyZstd = () => (_lazyZstd ??= import("../zstd-frames.js"));
export const lazySeqGap = () => (_lazySeqGap ??= import("../seq-gap-repair.js"));
export const lazyEio = () => (_lazyEio ??= import("../eio-repair.js"));
export const lazyValue = () => (_lazyValue ??= import("../value.js"));
/** node:fs 的按需加载：只有删会话备份扫描等少数路径需要 readdirSync/existsSync。 */
export const lazyFs = () => (_lazyFs ??= import("node:fs"));
