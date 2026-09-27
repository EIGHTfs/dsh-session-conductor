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

// 拼接顺序（= 原单文件行序；改依赖/新增片段必须同步改这里）
const PART_ORDER = [
  // foundation：基础支撑（最先声明，被所有片段引用；主插件 load 开头在此）
  "foundation/i18n.js",
  "foundation/bootstrap.js",
  "foundation/styles.js",
  "foundation/list-cache.js",
  // components：面板组件（同属主插件 factory 闭包，按职责切分）
  "components/session-icon.js",
  "components/panel.js",
  "components/settings.js",
  // 入口：主插件 apply 收尾 + exports
  "apply.js",
  // 独立插件块（各自 ModuleLoader.load，独立闭包互不影响）
  "components/group.js",
  "components/processing.js",
  "components/compaction.js",
  "components/conductor-settings.js",
];

let src = PART_ORDER.map((name) => fs.readFileSync(path.join(partsDir, name), "utf8")).join(""); // 拼接必需全量读入小片段

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
