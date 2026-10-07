// 分片语法护栏：lib/client-parts/* 是**拼接片段**，由 build.cjs 拼成 lib/client.js。
//
// 结构约定（2026-10-07 改造）：主插件 load 块的**开头/收尾文本由 build.cjs 提供**
//   （HEAD_TEXT / TAIL_TEXT），分片里不再含开/闭括号 ⇒ **每个分片都是完整语法单元**，
//   可以逐个 `node --check`。改造前 opener/closer 分片单独 check 必然报
//   Illegal return / Unexpected token，长期红着等于没有护栏，真语法错被噪声掩盖。
//
// 本测试把这条结构约定钉死：
//   ① 每个分片必须能独立 `node --check`（谁把包裹挪回分片就会失败）；
//   ② 按 PART_ORDER 拼接后整体仍可编译（产物形式）；
//   ③ build.cjs 里确实存在包裹文本（防误删）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARTS_DIR = join(ROOT, 'lib', 'client-parts');
const BUILD = join(ROOT, 'build.cjs');

/** 从 build.cjs 解析 PART_ORDER（不硬编码顺序，改顺序自动跟随）。 */
function partOrder() {
  const build = readFileSync(BUILD, 'utf8');
  const m = build.match(/const\s+PART_ORDER\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'build.cjs 里应能解析出 PART_ORDER');
  const names = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
  assert.ok(names.length > 0, 'PART_ORDER 应至少含一个分片');
  return names;
}

test('每个 client 分片都能独立 node --check（load 包裹由 build.cjs 提供）', () => {
  assert.ok(existsSync(PARTS_DIR), '应有分片目录 lib/client-parts/');
  const failures = [];
  for (const name of partOrder()) {
    const file = join(PARTS_DIR, name);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', timeout: 30000 });
    } catch (e) {
      const first = String(e?.stderr || e?.message || e).split('\n').find((l) => l.trim()) || '未知错误';
      failures.push(`${name} → ${first.trim()}`);
    }
  }
  assert.deepEqual(failures, [], `分片应各自可解析（把 load 包裹挪回分片会导致失败）：\n${failures.join('\n')}`);
});

test('build.cjs 持有主插件 load 的包裹文本（HEAD_TEXT / TAIL_TEXT）', () => {
  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /const\s+HEAD_TEXT\s*=/, 'build.cjs 应有 HEAD_TEXT');
  assert.match(build, /const\s+TAIL_TEXT\s*=/, 'build.cjs 应有 TAIL_TEXT');
  assert.match(build, /__ModuleLoader__\.load\(/, 'HEAD_TEXT 应含 ModuleLoader.load 开头');
});

test('产物 lib/client.js（= PART_ORDER 拼接结果）可解析', () => {
  const artifact = join(ROOT, 'lib', 'client.js');
  assert.ok(existsSync(artifact), '应有产物 lib/client.js');
  try {
    execFileSync(process.execPath, ['--check', artifact], { stdio: 'pipe', timeout: 30000 });
  } catch (e) {
    const first = String(e?.stderr || e?.message || e).split('\n').find((l) => l.trim()) || '未知错误';
    assert.fail(`产物语法错误：${first.trim()}（若分片刚改过，先跑 node build.cjs）`);
  }
});
