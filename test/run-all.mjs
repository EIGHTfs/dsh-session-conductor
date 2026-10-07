/**
 * dsh-session-conductor — 统一跑测入口（固定基准）
 *
 * 为什么需要它：项目里同时存在**三种**测试输出格式——
 *   · node:test 的 `# pass/# fail`（test/api/*.mjs）
 *   · TAP 的 `ok N - 名称`（同上，reporter 差异）
 *   · 各测试自带的 `PASS: … / ALL PASS / ✅ …`（test/unit/*.mjs 里的老写法）
 * 按输出文本判定必然出错（曾把「退出码 0 但非 # pass 格式」误判为失败），
 * 所以这里**只认退出码**：0 = 通过，非 0 = 失败；超时也判失败。
 *
 * 用法：
 *   node test/run-all.mjs            # 跑 unit + api
 *   node test/run-all.mjs --unit     # 只跑 unit（不依赖运行中的宿主）
 *   node test/run-all.mjs --api      # 只跑 api（需要宿主；不可用时测试自身会明确跳过）
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = Number(process.env.SC_TEST_TIMEOUT_MS || 300_000);
const only = process.argv.includes('--unit') ? 'unit' : process.argv.includes('--api') ? 'api' : '';

/** 收集某个目录下的测试文件（按名排序，输出稳定） */
function collect(dir) {
  try {
    return readdirSync(join(ROOT, 'test', dir))
      .filter((f) => f.endsWith('.mjs'))
      .sort()
      .map((f) => join('test', dir, f));
  } catch {
    return [];
  }
}

const groups = [
  ['unit', collect('unit')],
  ['api', collect('api')],
].filter(([name]) => !only || name === only);

let pass = 0;
let fail = 0;
const failures = [];

for (const [name, files] of groups) {
  if (!files.length) continue;
  console.log(`\n── ${name}（${files.length} 个文件）──`);
  for (const rel of files) {
    const r = spawnSync(process.execPath, [rel], { cwd: ROOT, timeout: TIMEOUT_MS, encoding: 'utf8' });
    const ok = r.status === 0;
    if (ok) pass += 1;
    else {
      fail += 1;
      failures.push(`${rel}（退出码 ${r.status ?? '超时/信号'}）`);
    }
    console.log(`${ok ? '✅' : '❌'} ${rel}`);
  }
}

console.log(`\n合计：通过 ${pass} ｜ 失败 ${fail}`);
if (failures.length) {
  console.log('失败清单：');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
