// dsh-session-conductor —— 浏览器端模板拼接构建（参考 dsh-theme-mediascape 分片模式）
//
// 用法：node build.cjs [--check]
//   · 无参数：读 lib/client-parts/ 片段按 PART_ORDER 拼接 → 写 lib/client.js
//   · --check：只比对「分片拼接结果」与现有 lib/client.js，一致退出 0，不一致退出 1（不写文件）
//
// 纪律：
//   · 改 UI 只改 lib/client-parts/ 分片，产物 lib/client.js 由本脚本生成（不手改产物）
//   · PART_ORDER 顺序决定依赖（foundation 最先 → components → apply 收尾 → 独立块），
//     顺序不变则产物逐字节一致（幂等）；调整依赖必须同步改 PART_ORDER
//   · lib/client.js 仍入库（部署副本经 sync-plugin 从 git 同步，产物必须提交）
//   · 主插件块（dsh-session-conductor）的片段同属一个 factory 闭包，公共函数/常量
//     放在 foundation 片段（最先拼接），跨片段引用安全
const fs = require("fs");
const path = require("path");

const root = __dirname;
const partsDir = path.join(root, "lib", "client-parts");
const clientPath = path.join(root, "lib", "client.js");

// 主插件块的包裹文本（原散落在两个分片里：开头在 foundation/bootstrap.js、收尾在 apply.js）：
//   · 挪到构建脚本后，**每个分片都成为可独立 `node --check` 的完整语法单元**——
//     否则 opener/closer 分片单独解析必然报 Illegal return / Unexpected token，
//     连审计的 tokenizer 也会走偏（把 CSS 模板串里的数字误当代码魔数）。
//   · 文本与原来逐字一致（分片里删掉、这里补上），产物 lib/client.js 字节不变。
// 幂等注册守卫（拼接时所有 load 调用都改走它）。
//
// 【解决什么】宿主对插件模块用「invalidate-then-register」保证重载合法，但它只 invalidate
// **插件主模块**一个 id（cordis-client-runner: modules.invalidate(moduleId)）。本插件是分片拼接，
// 除主块外还有 group / processing / compaction / conductor-settings 四个各自 load() 的独立块，
// 它们没被 invalidate。于是 client.js 的 rev 一变（任一服务端文件改动导致 bundle 重算），
// 浏览器执行新 URL 时这些分片 id 已在模块表里 ⇒ duplicate factory registration，整个前端带崩。
//
// 【两个版本的教训】
// · v1「同 id 只注册一次」（window 级 Set）：重载场景反而坏事 —— 宿主先 invalidate 主模块 id
//   再执行新 bundle，守卫一看 Set 里有就跳过，结果主模块没注册回去，宿主加载后校验
//   `factories.has(主id)` 失败 ⇒ `loaded without registering`（比 duplicate 更糟，插件直接加载不出）。
// · v2（本版）按「谁会被宿主清掉」分治：
//   · 主模块 id：宿主每次重载前必然已 invalidate ⇒ **无条件注册**（合法且必须）；
//   · 分片 id：宿主不清 ⇒ 每次 bundle 执行都换新 id（加执行周期后缀 @n），天然不与旧表冲突；
//   · 同一执行周期内再用 Set 防同 id 重复（防未来分片重复注册）。
//   代价：每次重载旧分片 factory 留在宿主模块表里（内存多几份小闭包，可忽略；硬刷新即清）。
const GUARD_TEXT = [
  'function __dshScLoad(registration) {',
  '  const host = window.__ModuleLoader__;',
  '  if (registration.id === "dsh-session-conductor") { host.load(registration); return; }',
  '  const cycle = (window.__dshScCycle = (window.__dshScCycle ?? 0) + (window.__dshScCycleOpen ? 0 : 1));',
  '  window.__dshScCycleOpen = true;',
  '  const seen = (window.__dshScSeen ??= new Set());',
  '  const id = `${registration.id}@${cycle}`;',
  '  if (seen.has(id)) return;',
  '  seen.add(id);',
  '  host.load({ ...registration, id });',
  '}',
  'window.__dshScCycleOpen = false;',
  '',
].join('\n');

const HEAD_TEXT = [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-session-conductor",',
  '  factory: (require) => {',
  '',
].join('\n');
const TAIL_TEXT = [
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n');

// 拼接顺序（= 原单文件行序；改依赖/新增片段必须同步改这里）
const PART_ORDER = [
  // foundation：基础支撑（最先声明，被所有片段引用；主插件 load 由本脚本补开头）
  "foundation/i18n.js",
  "foundation/bootstrap.js",
  "foundation/styles.js",
  "foundation/list-cache.js",
  // components：面板组件（同属主插件 factory 闭包，按职责切分）
  "components/session-icon.js",
  "components/panel.js",
  "components/settings.js",
  // 入口：主插件 apply 收尾 + exports（收尾由本脚本补）
  "apply.js",
  // 独立插件块（各自 ModuleLoader.load，独立闭包互不影响）
  "components/group.js",
  "components/processing.js",
  "components/compaction.js",
  "components/conductor-settings.js",
];

let src = GUARD_TEXT;
for (const name of PART_ORDER) {
  if (name === "foundation/bootstrap.js") src += HEAD_TEXT; // 主插件 load 开头
  src += fs.readFileSync(path.join(partsDir, name), "utf8");
  if (name === "apply.js") src += TAIL_TEXT; // 主插件 load 收尾
}

// 主块（HEAD_TEXT）与四个独立块都是 window.__ModuleLoader__.load({ ... }) 形态，统一改走守卫
src = src.replaceAll("window.__ModuleLoader__.load({", "__dshScLoad({");

if (process.argv.includes("--check")) {
  const cur = fs.existsSync(clientPath) ? fs.readFileSync(clientPath, "utf8") : "";
  if (src === cur) {
    console.log(`✅ 分片拼接与 lib/client.js 逐字节一致（${src.length} 字节）`);
    process.exit(0);
  }
  console.error(`❌ 分片拼接与 lib/client.js 不一致（分片 ${src.length} 字节 / 产物 ${cur.length} 字节）`);
  process.exit(1);
}

fs.writeFileSync(clientPath, src);
console.log(`✅ 已生成 lib/client.js（${src.length} 字节，${PART_ORDER.length} 个分片）`);
