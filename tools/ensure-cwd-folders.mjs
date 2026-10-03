#!/usr/bin/env node
/**
 * ensure-cwd-folders.mjs — 一键补齐 DSH 会话指向的 cwd 文件夹
 *
 * 背景：DSH 会话按工作目录（cwd）分组，分组目录名由宿主 projectKey()
 * 有损编码（'/' 与字面 '-' 同形，无法逆向还原）。要"会话指向的文件夹
 * 不存在则创建空文件夹"时，不能靠解码目录名，权威数据源是会话日志
 * 首帧 header 里的 cwd 字段（DSH 官方数据，零歧义）。
 *
 * 做什么：
 *   扫描 DSH 实例 .dsh/sessions/ 下的"会话分组目录"，从组内任意一个
 *   会话日志（zstd 压缩的 JSONL）首帧 header 读取真实 cwd；
 *   若该 cwd 文件夹不存在，则创建空文件夹（mkdir -p，带权限兜底）。
 *
 * 数据源优先级（实测 2026-10-04）：
 *   1. 会话日志首帧 header.cwd —— 权威，直接来自 DSH 运行时
 *   2. 目录名逆向解码（有损，仅作交叉验证，不作创建依据）
 *   两者冲突时以 header.cwd 为准（code-truth-over-md：代码实际值 > 推测值）
 *
 * 依赖：node:zlib（zstdDecompress，Node ≥22 内置）+ node:fs，零第三方包
 *
 * 路径解析（不硬编码任何机器路径）：
 *   优先级：--base <path> 参数 > DSH_BASE 环境变量 > 自动探测
 *   自动探测顺序：
 *     1. $DSH_HOME（宿主注入的会话数据根，形如 <实例根>/.dsh）→ 父目录
 *     2. 脚本所在仓库的数据邻居：从 __dirname 逐级上溯找 .dsh/sessions
 *     3. 探测失败 → 明确报错提示"请显式传 --base 或设 DSH_BASE"
 *   不做无界全盘扫描（low-load-task-discipline）。
 *
 * 权限问题处理：
 *   - 单条 mkdir 失败不中断，逐条记录 errno，最后汇总
 *   - 非 root 遇 root 属主目录：按 root-file-access-escalation 链提权
 *     （本机 sudo → SSH root 直登 → 管理员用户 sudo -i）
 *
 * 用法：
 *   node tools/ensure-cwd-folders.mjs                  # dry-run（默认）
 *   node tools/ensure-cwd-folders.mjs --apply          # 实际创建缺失目录
 *   node tools/ensure-cwd-folders.mjs --base <实例根> --apply
 *   DSH_BASE=<实例根> node tools/ensure-cwd-folders.mjs --apply
 *
 * 实例根（base）= 含 .dsh/sessions 或 sessions 的目录（如 fnOS 实例数据目录）
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 路径解析（无硬编码机器路径）
// ---------------------------------------------------------------------------

/** 解析 --base 参数（--base <path> 或 --base=<path>） */
function parseBaseArg(argv) {
  const i = argv.indexOf('--base');
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  for (const a of argv) {
    if (a.startsWith('--base=')) return a.slice('--base='.length);
  }
  return null;
}

/** 从 DSH_HOME（<实例根>/.dsh）反推实例根 */
function fromDshHome() {
  const home = process.env.DSH_HOME;
  if (!home) return null;
  const p = path.resolve(home);
  // DSH_HOME 本身形如 <base>/.dsh
  if (path.basename(p) === '.dsh') return path.dirname(p);
  return p;
}

/** 从脚本位置逐级上溯，找含 .dsh/sessions 或 sessions 的目录（仓库被放进 DSH 数据树时有效） */
function fromScriptAncestor() {
  let here;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch { return null; }
  let dir = here;
  for (let up = 0; up < 8; up++) {
    for (const cand of [path.join(dir, '.dsh', 'sessions'), path.join(dir, 'sessions')]) {
      try { if (fs.statSync(cand).isDirectory()) return dir; } catch { /* 继续 */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 实例根解析：--base > DSH_BASE > 自动探测；全失败返回 null（main 里报错） */
function resolveBase() {
  return parseBaseArg(process.argv.slice(2))
    || process.env.DSH_BASE
    || fromDshHome()
    || fromScriptAncestor()
    || null;
}

const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// 读会话分组目录内任意一个会话日志的首帧 header（含 cwd）
// 会话日志是 zstd 压缩的 JSONL 容器（多帧拼接），首帧第一行即 header。
// 容错：压缩损坏/空组/读不了 → 返回 null（回退目录名解码）
// ---------------------------------------------------------------------------
function readGroupCwd(groupDir) {
  let entries;
  try {
    entries = fs.readdirSync(groupDir, { withFileTypes: true });
  } catch { return null; }
  // 找组内任意一个 .zstd 会话日志（目录或文件都支持）
  for (const ent of entries) {
    if (ent.isDirectory()) {
      // 新布局：组内是 session-xxx/ 文件夹，内含 session.v3.jsonl.zstd
      let sub;
      try { sub = fs.readdirSync(path.join(groupDir, ent.name)); } catch { continue; }
      const log = sub.find(f => f.endsWith('.zstd'));
      if (log) {
        const cwd = readFirstFrameCwd(path.join(groupDir, ent.name, log));
        if (cwd) return cwd;
      }
    }
  }
  // 旧布局兜底：组内直接是文件
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (/\.zstd$/.test(ent.name)) {
      const cwd = readFirstFrameCwd(path.join(groupDir, ent.name));
      if (cwd) return cwd;
    }
  }
  return null;
}

// 读 zstd 日志首帧 header 里的 cwd
function readFirstFrameCwd(logPath) {
  let buf;
  try { buf = fs.readFileSync(logPath); } catch { return null; }
  let text;
  try {
    text = zlib.zstdDecompressSync(buf).toString('utf8');
  } catch { return null; }
  // 首帧第一行即 header JSON
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let obj;
    try { obj = JSON.parse(l); } catch { continue; }
    if (obj && obj.type === 'session' && typeof obj.cwd === 'string') {
      return obj.cwd;
    }
    // 只取第一帧就够（header 必在首帧）
    break;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 目录名逆向解码（有损，仅作交叉验证）——官方 projectKey() 逐字移植
// 分隔符 / \ : → '-'；安全字符原样；其他 → ~XXXX（4位大写hex，UTF-16码）
// 注意：'-' 既是安全字符又是分隔符，编码有损，无法唯一还原
// ---------------------------------------------------------------------------
function projectKey(cwd) {
  let out = '', sepRun = false;
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sepRun) out += '-';
      sepRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
      sepRun = false;
    } else {
      out += '~' + (ch.charCodeAt(0) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
      sepRun = false;
    }
  }
  // 官方正则为 /^-+/ 去掉开头全部 '-'
  const slug = out.replace(/^-+/, '') || 'root';
  return '--' + slug.slice(0, 251) + '--';
}

// 简单启发式解码（全 '-' 还原为 '/'，已知有损，只用于展示对照）
function decodeHeuristic(name) {
  let inner = name;
  if (inner.startsWith('--')) inner = inner.slice(2);
  if (inner.endsWith('--')) inner = inner.slice(0, -2);
  let out = '';
  let i = 0, n = inner.length;
  while (i < n) {
    const c = inner[i];
    if (c === '~' && i + 4 < n && /^[0-9A-F]{4}$/.test(inner.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
      i += 5;
      continue;
    }
    out += c === '-' ? '/' : c;
    i++;
  }
  return '/' + out;
}

// ---------------------------------------------------------------------------
function findSessionsDirs(base) {
  const cands = [
    path.join(base, '.dsh', 'sessions'),
    path.join(base, 'sessions'),
  ];
  const found = cands.filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  if (found.length) return found;
  // 兜底：base 下 */（多实例并存时逐层找）
  let subs = [];
  try { subs = fs.readdirSync(base, { withFileTypes: true }); } catch { /* base 不存在或不可读 */ }
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    const p = path.join(base, s.name, '.dsh', 'sessions');
    try { if (fs.statSync(p).isDirectory()) found.push(p); } catch { /* 跳过 */ }
  }
  return found;
}

// ---------------------------------------------------------------------------
function main() {
  const base = resolveBase();
  if (!base) {
    console.log('❌ 无法确定 DSH 实例根：请显式传 --base <实例根> 或设 DSH_BASE 环境变量');
    console.log('   （实例根 = 含 .dsh/sessions 或 sessions 的目录）');
    process.exit(1);
  }

  let baseStat;
  try { baseStat = fs.statSync(base); } catch {
    console.log(`❌ 实例根不存在：${base}（可显式传 --base 或设 DSH_BASE 指定）`);
    process.exit(1);
  }
  if (!baseStat.isDirectory()) {
    console.log(`❌ 实例根不是目录：${base}`);
    process.exit(1);
  }

  const sessDirs = findSessionsDirs(base);
  if (sessDirs.length === 0) {
    console.log(`❌ 在 ${base} 下找不到 sessions 目录（可设 DSH_BASE 指向实例根）`);
    process.exit(1);
  }

  let total = 0, missing = 0, created = 0, failed = 0, exists = 0;
  let noCwd = 0, ambiguous = 0;
  const failedLines = [];

  for (const sessDir of sessDirs) {
    console.log(`▸ 扫描：${sessDir}`);
    let groups = [];
    try { groups = fs.readdirSync(sessDir, { withFileTypes: true }); } catch { continue; }
    for (const g of groups.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!g.isDirectory() || !g.name.startsWith('--')) continue;
      total++;
      const groupPath = path.join(sessDir, g.name);

      // 优先从会话日志 header 读权威 cwd
      const cwd = readGroupCwd(groupPath);
      let source = 'header';
      let decoded = decodeHeuristic(g.name); // 仅作对照展示

      if (!cwd) {
        // 组内没有可读日志（空组/损坏）→ 启发式解码兜底，但标注"不确定"
        source = 'heuristic(不确定)';
        noCwd++;
        const probe = decoded;
        // 启发式结果无法验证（编码有损），不创建，只提示
        console.log(`  ? 不确定  ${g.name}\n     启发式候选: ${probe}\n     （组内无可读日志，编码有损无法验证 → 跳过，不猜测创建）`);
        continue;
      }

      // 交叉验证：目录名重编码应含该 cwd（不要求完全相等，有损）
      if (projectKey(cwd) !== g.name) {
        // 不一致也记录（理论上 header 是权威，目录名可能是历史截断/旧版编码）
        ambiguous++;
      }

      if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
        exists++;
        console.log(`  ✓ 已存在  ${cwd}  [来源:${source}]`);
        continue;
      }

      // CIFS/NAS 上 fs.accessSync(W_OK) 对属主目录可能误报无写权限，
      // 因此不做写权限预判，直接尝试 mkdir，失败才按 errno 给准确原因。

      if (APPLY) {
        try {
          fs.mkdirSync(cwd, { recursive: true });
          created++;
          console.log(`  + 已创建  ${cwd}`);
        } catch (e) {
          failed++;
          const msg = (e.code === 'EACCES' || e.code === 'EPERM')
            ? `权限不足（${e.code}）→ 提权链：sudo / SSH root（root-file-access-escalation）`
            : e.message;
          console.log(`  ✗ 创建失败  ${cwd}  ${msg}`);
          failedLines.push(`${cwd}  ${msg}`);
        }
      } else {
        missing++;
        console.log(`  ✗ 缺失    ${cwd}  [来源:${source}]`);
      }
    }
  }

  console.log('');
  console.log('══ 汇总 ══');
  console.log(`扫描分组：${total} ｜ 已存在：${exists} ｜ 不确定（无日志）：${noCwd} ｜ 编码不一致：${ambiguous}`);
  if (APPLY) {
    console.log(`已创建：${created} ｜ 失败：${failed}`);
    if (failedLines.length) {
      console.log('');
      console.log('失败明细（需提权后重跑）：');
      for (const l of failedLines) console.log(`  - ${l}`);
      process.exit(2);
    }
  } else {
    console.log(`缺失：${missing}（dry-run 未创建；加 --apply 实际执行）`);
  }
}

main();
