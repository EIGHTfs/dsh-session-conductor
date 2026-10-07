// 产物一致性护栏：lib/client.js 是 build.cjs 从 lib/client-parts/ 分片拼接出来的**生成物**，
// 改了分片却忘了重建（或有人手改了产物）必须在这里被拦住。
//
// 事故背景：改 lib/client-parts/components/panel.js（归档分组复用工作区分组）后忘记跑 build.cjs，
//   产物 lib/client.js 仍是旧代码 ⇒ 面板行为与源码不一致；实测是手动补跑 `node build.cjs` 才对齐的。
// 本测试把 build.cjs --check（逐字节比对分片拼接结果与产物）钉进测试套件，防再犯。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径从本文件位置派生（不硬编码本机绝对路径）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = join(ROOT, 'build.cjs');
const PARTS = join(ROOT, 'lib', 'client-parts');
const ARTIFACT = join(ROOT, 'lib', 'client.js');

test('lib/client.js 与分片拼接结果逐字节一致（改了分片必须重建产物）', () => {
  assert.ok(existsSync(BUILD), `应有构建脚本 ${BUILD}`);
  assert.ok(existsSync(PARTS), '应有分片源目录 lib/client-parts/');
  assert.ok(existsSync(ARTIFACT), '应有生成物 lib/client.js');
  let out = '';
  try {
    out = execFileSync(process.execPath, [BUILD, '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    assert.fail(`build.cjs --check 失败（分片改了没重建？跑 \`node build.cjs\` 即可）：${String(e?.stdout || e?.message || e).slice(0, 300)}`);
  }
  assert.match(out, /一致/, `--check 应报一致，实得：${out.slice(0, 200)}`);
});
