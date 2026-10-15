// 会话列表「id 不变量」回归 —— 列表项必须带非空字符串 id，脏值不得产出无 id 条目。
//
// 【为什么钉这条】线上实测到一条没有 id 的列表项（JSON 里连 id 字段都没有，因为
// JSON.stringify 会丢掉 undefined），表现是列表渲染出一行 `undefined ｜ (无标题)`：
//   {"title":null,"cwd":null,"live":false,"archived":false,
//    "inspectError":"Cannot read properties of undefined (reading 'length')"}
// 根因链（lib/sessions/list.js）：
//   ① 归档 id 集合来自宿主持久化，未过滤 ⇒ 混入 undefined 时
//   ② 补全循环 `coldById.set(id, { meta: { id } })` 造出 `{ id: undefined }` 的 meta
//   ③ 该 meta 成为列表项的 id 来源 ⇒ 产出无 id 条目
//   ④ 读该会话事件时拿 undefined 去读日志 ⇒ "reading 'length'" 报错
//
// 覆盖方式（两层）：
//   · 功能级：直接 import 零依赖叶子模块 lib/sessions/session-id.js 的判据
//   · 结构级：断言 list.js 的四处（净化/守卫/回退校验/emit 兜底）都走该判据，
//     防止有人再写回内联的 `typeof x === "string" && x !== ""` 而漏改其中一处
// 不覆盖：buildSessionList 的整体行为（它经 core/domain.js 拉起宿主存储域，
// 单测环境没有该包；列表整体行为由 test/api 的 mini-host 用例覆盖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidSessionId } from '../../lib/sessions/session-id.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIST_SRC = readFileSync(join(ROOT, 'lib', 'sessions', 'list.js'), 'utf8');

// ---------- ① 功能级：判据本身 ----------

test('isValidSessionId：只认非空字符串', () => {
  assert.equal(isValidSessionId('session-abc'), true);
  assert.equal(isValidSessionId('x'), true);
  // 以下都必须是 false —— 它们是实测遇到过的脏值形态
  assert.equal(isValidSessionId(''), false, '空串不算（会被当成「有 id」却在别处炸）');
  assert.equal(isValidSessionId(undefined), false, '归档集合混入的正是 undefined');
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId(0), false, '数字不算（前端会拿它当 key/路由参数）');
  assert.equal(isValidSessionId(123), false);
  assert.equal(isValidSessionId({ id: 'x' }), false, '对象不算');
  assert.equal(isValidSessionId(['x']), false);
  assert.equal(isValidSessionId(true), false);
});

// ---------- ② 结构级：四处都必须走判据 ----------

test('list.js：归档 id 集合必须先过滤（根因层）', () => {
  assert.match(
    LIST_SRC,
    /archivedSessionIds \?\? \[\]\)\.filter\(isValidSessionId\)/,
    '归档集合必须写成 (... ?? []).filter(isValidSessionId) —— 否则脏 id 会进补全循环造出无 id 条目',
  );
});

test('list.js：归档补全循环必须有守卫（防御层）', () => {
  const m = LIST_SRC.match(/for \(const id of archived\) \{[\s\S]*?\n {2}\}/);
  assert.ok(m, '未找到归档补全循环（结构变了要同步本测试）');
  assert.match(m[0], /if \(!isValidSessionId\(id\)\) continue;/, '补全循环必须先跳过非法 id');
});

test('list.js：persistence.list 回退路径必须校验 id', () => {
  const m = LIST_SRC.match(/for \(const meta of await persistence\.list\(\)\) \{[\s\S]*?\n {8}\}/);
  assert.ok(m, '未找到 persistence.list 回退循环（结构变了要同步本测试）');
  assert.match(m[0], /if \(!isValidSessionId\(meta\?\.id\)\) continue;/, '回退路径必须校验 meta.id');
});

test('list.js：emit 必须守住不变量（单咽喉点兜底）', () => {
  const m = LIST_SRC.match(/const emit = \(item\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(m, '未找到 emit 定义（结构变了要同步本测试）');
  assert.match(m[0], /if \(!item \|\| !isValidSessionId\(item\.id\)\) \{/, 'emit 必须先判 id 再入列表');
  assert.match(m[0], /items\.push\(item\)/, 'emit 仍应把合法项推入列表');
});

test('list.js：不得残留内联的 id 判据（防止绕过判据漏改）', () => {
  // 允许出现在注释里，所以先剥掉注释行再检查
  const codeOnly = LIST_SRC.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const inline = codeOnly.match(/typeof\s+\w+(\?\.\w+)?\s*===\s*["']string["']\s*&&\s*\w+(\?\.\w+)?\s*!==\s*["']["']/g);
  assert.equal(
    inline,
    null,
    `发现内联 id 判据 ${inline ? inline.join(' / ') : ''} —— 请统一改用 isValidSessionId（否则以后漏改一处就又出无 id 条目）`,
  );
});
