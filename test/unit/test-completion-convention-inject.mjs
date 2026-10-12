// 回归护栏：收尾汇报约定（systemPrompt.section「task-completion-report」，order 1000）必须真的能注册。
//
// 事故背景：lib/apply.js 里 `text: TASK_COMPLETION_CONVENTION` 引用的标识符**自 1.0.0（首个提交）
//   起就从未定义**——全仓、全历史既没有 const 定义，也没有赋值或 import。构造 section 参数时抛
//   `ReferenceError: TASK_COMPLETION_CONVENTION is not defined`，被同段 try/catch 吞成一行日志
//   ⇒ 该 section 从未注册、收尾约定从未注入（现场表现：「会话指挥家从来没成功注入过」）。
// 本测试钉三点：① 约定文本能从插件自带 skill 同步读出；② 接线绑定到已解析文本；
//   ③ lib/ 下不再存在该未定义标识符的非注释引用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCompletionConventionSync } from '../../lib/template-inject.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('收尾约定文本可从插件自带 skill 同步读出（非空、已去 frontmatter）', () => {
  const text = readCompletionConventionSync();
  assert.ok(text.length > 100, `应读出正文（实得 ${text.length} 字）`);
  assert.ok(text.includes('任务完成汇报'), '应含 skill 正文标题');
  assert.ok(!/^---/.test(text), '不应残留 frontmatter 起始分隔线');
  assert.ok(!/whenToUse:/.test(text), '不应残留 frontmatter 字段');
});

test('注入接线绑定到已解析文本（section.text 取得到正文）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'apply.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, ''); // 去行注释：原写法作为注释保留不影响本断言
  assert.ok(!/text:\s*TASK_COMPLETION_CONVENTION\b/.test(code), 'section.text 仍引用从未定义的常量');
  assert.ok(/text:\s*\(\)\s*=>\s*conventionText/.test(code), 'section.text 应绑定已解析出的约定文本');
});

test('lib/ 下不再存在未定义的 TASK_COMPLETION_CONVENTION 引用（非注释）', () => {
  const entries = readdirSync(join(ROOT, 'lib'), { recursive: true, withFileTypes: true });
  const offenders = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.js')) continue;
    const abs = join(e.parentPath ?? e.path ?? join(ROOT, 'lib'), e.name);
    const code = readFileSync(abs, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .replace(/\/\/.*$/gm, ''); // 行注释
    if (/TASK_COMPLETION_CONVENTION/.test(code)) offenders.push(abs.replace(`${ROOT}/`, ''));
  }
  assert.deepEqual(offenders, [], `仍引用未定义标识符的文件：${offenders.join(', ')}`);
});

test('启动水合护栏：apply.js 必须在两个消费点前调用 hydrateTemplateState', () => {
  // 事故：templateStateCache 初值 = TEMPLATE_DEFAULTS（plan/closing enabled=false、enforce=false），
  //   而只有 /templates 路由被访问过才写缓存 ⇒ 重启后没打开过设置页时，模板注入与方案强制门禁
  //   全部按"默认关闭"执行（设置里明明是开的，却既不注入也不拦）。
  const src = readFileSync(join(ROOT, 'lib', 'apply.js'), 'utf8');
  assert.ok(/const hydrateTemplateState = \(\) => \{/.test(src), '应定义 hydrateTemplateState（启动水合）');
  const calls = (src.match(/await hydrateTemplateState\(\)/g) || []).length;
  assert.ok(calls >= 2, `应在 tools/pre-execute 与 agent/pre-step 两处调用水合，实得 ${calls} 处`);
});

test('lib 内「跨模块导出被引用但没导入」必须为 0（本次事故家族：5 个名字全漏导入）', () => {
  // 事故：lib/template-inject.js 的 collectTemplateSlotText / planGateAllows / PLAN_ENFORCE_EDIT_TOOLS /
  //   PLAN_ENFORCE_BASH_WRITE_RE / planEnforceDenyMessage 在 apply.js 里被使用却从未导入，
  //   运行时抛 ReferenceError 并被 try/catch 吞掉 ⇒ 模板注入与方案强制门禁长期静默失效。
  // 判定：去掉注释后，凡是「被别的 lib 模块 export、在 apply.js 里以裸标识符出现、
  //   既没被 import、也没在文件内声明（含 `const { x } = await lazy...()` 这类解构绑定）」的名字，即视为漏导入。
  const libDir = join(ROOT, 'lib');
  const files = readdirSync(libDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? e.path ?? libDir, e.name));
  const exported = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)) exported.add(m[1]);
  }

  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
  const apFull = stripComments(readFileSync(join(libDir, 'apply.js'), 'utf8'));
  // 扫描文本额外去掉解构声明：`const { a, b: c } = …` 里的**键名**不是自由标识符（误报来源）。
  // 绑定名仍从 apFull 收集进 declared，因此「`const { x } = await lazyX()` + 后续裸用 x」不会被误报。
  const ap = apFull.replace(/(?:const|let|var)\s*\{[^}]*\}\s*=/g, 'const __bound =');

  const named = new Set([...ap.matchAll(/import\s*\{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()))
    .filter(Boolean));
  const declared = new Set([...ap.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map((m) => m[1]));
  for (const m of apFull.matchAll(/(?:const|let|var)\s+(\w+)/g)) declared.add(m[1]);
  for (const m of apFull.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const one of m[1].split(',')) {
      const n = one.trim().split(':').pop().split('=')[0].trim();
      if (n) declared.add(n);
    }
  }
  for (const m of ap.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const n = p.trim().split('=')[0].trim();
      if (n) declared.add(n);
    }
  }

  const missing = [...exported].filter((n) => {
    if (named.has(n) || declared.has(n)) return false;
    return new RegExp(`(?<!\\.)\\b${n}\\b`).test(ap); // 裸标识符用法（排除 ns.xxx 成员访问）
  });
  assert.deepEqual(missing, [], `apply.js 引用了但没导入（运行时会 ReferenceError）：${missing.join(', ')}`);
});
