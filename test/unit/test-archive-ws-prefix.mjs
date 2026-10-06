// dsh-session-conductor  归档标题工作区前缀 纯函数单测
import { strict as assert } from 'node:assert'

// 与 lib/index.js 相同的实现（测试独立复刻，避免 import 整个插件）
const RE = /^\[([^\]]+)\]\s*/
function archiveTitleWithWs(title, ws) {
  const t = String(title ?? '')
  const stripped = t.replace(RE, '')
  const name = String(ws ?? '').trim()
  if (name === '' || stripped === '') return { title: t, ws: name }
  return { title: `[${name}] ${stripped}`, ws: name }
}
function stripArchiveWsPrefix(title) {
  const t = String(title ?? '')
  const m = t.match(RE)
  if (!m) return { title: t, ws: '' }
  return { title: t.slice(m[0].length), ws: m[1] }
}

let n = 0
function check(desc, actual, expected) {
  assert.deepStrictEqual(actual, expected, desc)
  n++
  console.log(`  ✓ ${desc}`)
}

console.log('归档标题工作区前缀：')
check('加前缀', archiveTitleWithWs('修复分组 404', 'dsh-git-rescue'), { title: '[dsh-git-rescue] 修复分组 404', ws: 'dsh-git-rescue' })
check('幂等（已带前缀不叠加）', archiveTitleWithWs('[dsh-git-rescue] 修复分组 404', 'dsh-git-rescue'), { title: '[dsh-git-rescue] 修复分组 404', ws: 'dsh-git-rescue' })
check('空工作区不加', archiveTitleWithWs('标题', ''), { title: '标题', ws: '' })
check('空标题不动', archiveTitleWithWs('', 'ws'), { title: '', ws: 'ws' })
check('剥离前缀', stripArchiveWsPrefix('[dsh-git-rescue] 修复分组 404'), { title: '修复分组 404', ws: 'dsh-git-rescue' })
check('无前缀原样', stripArchiveWsPrefix('普通标题'), { title: '普通标题', ws: '' })
check('前缀带中文', stripArchiveWsPrefix('[任务] 完成归档'), { title: '完成归档', ws: '任务' })
check('标题含中括号前缀后内容', stripArchiveWsPrefix('[ws] [标题] 内容'), { title: '[标题] 内容', ws: 'ws' })
check('剥离后还原一致', (() => { const a = archiveTitleWithWs('原标题', '任务'); return stripArchiveWsPrefix(a.title) })(), { title: '原标题', ws: '任务' })

console.log(`\n结果: ${n} 通过, 0 失败`)
