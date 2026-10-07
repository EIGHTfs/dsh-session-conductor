// 版本表完整性护栏：docs/VERSIONS.md 必须覆盖**每一个带版本号的提交**。
//
// 事故背景：docs/VERSIONS.md 由人工维护（dsh-git-push 的 doc-version 只维护那个仓库的
//   docs/CHANGELOG.md，不覆盖本仓库），发版时只追加当前版本、没核对整表 ⇒ 1.0.4 / 1.0.5
//   两行长期缺失（表里只剩 1.0.6/1.0.3/1.0.1/1.0.0），版本记录静默掉版本。
// 本测试把「提交里的版本 → 表里的行」钉死，少一行即失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('docs/VERSIONS.md 覆盖全部带版本号的提交（不许掉版本）', () => {
  // 提交主题形如 `feat(1.0.5): ...` / `refactor(1.0.4): ...` / `1.0.1 ...`
  const log = execFileSync('git', ['-C', ROOT, 'log', '--format=%s'], { encoding: 'utf8', timeout: 60000 });
  const versions = [...new Set(
    log.split('\n')
      .map((s) => (s.match(/^\w+\((\d+\.\d+\.\d+)\)/) || s.match(/^(\d+\.\d+\.\d+)\b/) || [])[1])
      .filter(Boolean),
  )];
  assert.ok(versions.length > 0, '应能从提交主题解析出版本号（若为 0 说明提交信息格式变了，需同步本测试）');

  const table = readFileSync(join(ROOT, 'docs', 'VERSIONS.md'), 'utf8');
  const missing = versions.filter((v) => !new RegExp(`^\\| ${v.replace(/\./g, '\\.')} `, 'm').test(table));
  assert.deepEqual(missing, [], `docs/VERSIONS.md 缺少这些版本行（发版时必须补全整表，不是只追加当前版本）：${missing.join(', ')}`);
});
