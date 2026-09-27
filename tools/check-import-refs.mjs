#!/usr/bin/env node
/**
 * check-import-refs.mjs — 通用 JS 模块引用一致性检查器（v1.1）
 *
 * 背景：ESM 里「import 了一个存在的导出，但代码调用了另一个没导入的名字」
 * 时，模块加载不报错，只有运行到那一行才抛 ReferenceError（例：dsh-session-conductor
 * v1.24.0 的 collectMdInjectTextSync is not defined —— import 的是 collectMdInjectText
 * 异步版，systemPrompt 调用的是同步版）。这类 bug 语法检查（node --check）抓不到，
 * 单元测试若不执行那条路径也抓不到。本脚本静态扫描，提交前跑一遍兜底。
 *
 * 检查两类问题：
 *   [ERROR] named import 引用了源模块不存在的导出（如 import { x } from './a.js'
 *           但 a.js 没有 export x）—— Node 加载时也会报，这里提前批量抓。
 *   [WARN]  函数调用 `foo(` 的 foo 既不在 import 列表、也不在本文件定义、
 *           也不在全局白名单 —— 可能是 bug（调用未导入名），也可能是
 *           对象方法/注释残留（已尽力剥离，仍可能有误报），人工核对。
 *
 * 用法：
 *   node tools/check-import-refs.mjs [路径...]     # 默认扫描 ./lib
 *   路径可以是文件、目录（递归 .js/.mjs/.cjs）。
 *   退出码：有 ERROR → 1；只有 WARN → 0。
 *
 * 适用范围：任何纯 JS 插件/项目（不依赖 DSH）。把本文件复制到目标项目
 * 的 tools/ 或 test/ 下即可用。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';

// ---------- 配置 ----------
const GLOBAL_WHITELIST = new Set([
  // JS 内置
  'console', 'process', 'Buffer', 'global', 'globalThis', 'window', 'document',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'crypto',
  'JSON', 'Math', 'Date', 'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Symbol', 'RegExp', 'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'EvalError', 'URIError', 'AggregateError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'BigInt',
  'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'atob', 'btoa',
  'require', 'module', 'exports', 'import', 'performance', 'localStorage',
  'navigator', 'location', 'history', 'customElements', 'HTMLElement', 'Element',
  // 类型化数组 / 二进制
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'ArrayBuffer',
  'SharedArrayBuffer', 'DataView', 'Atomics', 'WeakRef', 'FinalizationRegistry',
]);

// ---------- 解析 import 语句（按块匹配，支持多行） ----------
function parseImports(source) {
  const imported = new Set();
  const imports = [];
  // 形式：import A, { b, c as d } from 'x' / import { b } from 'x' / import * as ns from 'x' / import A from 'x' / import 'x'
  const re = /\bimport\s*(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\}|\*\s*as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))?\s*(?:from\s*)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const defaultName = m[1] || m[4] || '';
    const named = m[2] || '';
    const nsName = m[3] || '';
    const src = m[5];
    const specs = []; // { source, local }
    if (defaultName) specs.push({ source: defaultName, local: defaultName });
    if (nsName) specs.push({ source: nsName, local: nsName });
    if (named) {
      for (let spec of named.split(',')) {
        spec = spec.trim();
        if (!spec) continue;
        const asIdx = spec.lastIndexOf(' as ');
        specs.push(
          asIdx >= 0
            ? { source: spec.slice(0, asIdx).trim(), local: spec.slice(asIdx + 4).trim() }
            : { source: spec.trim(), local: spec.trim() }
        );
      }
    }
    specs.forEach((s) => s.local && imported.add(s.local));
    imports.push({ source: src, named: specs });
  }
  // 动态 import 解构：const { a, b } = await import('x') / const { a } = await import('x')
  const reDyn = /const\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(/g;
  while ((m = reDyn.exec(source)) !== null) {
    for (let spec of m[1].split(',')) {
      spec = spec.trim();
      if (!spec) continue;
      const asIdx = spec.lastIndexOf(' as ');
      imported.add(asIdx >= 0 ? spec.slice(asIdx + 4).trim() : spec.trim());
    }
  }
  // 动态 import 默认/命名：const x = (await import('y')).default 较少见，跳过
  return { imported, imports };
}

// ---------- 解析本文件定义（全文，含函数体内局部函数/常量） ----------
function parseDefinitions(source) {
  const defs = new Set();
  const code = stripComments(source);
  let m;
  // function / async function 定义（任意位置，前缀为语句边界）
  const reFn = /(?:^|[\s;{}])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(code)) !== null) defs.add(m[1]);
  // const / let / var / class 定义（任意位置）
  const reConst = /(?:^|[\s;{}])(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reConst.exec(code)) !== null) defs.add(m[1]);
  // 数组解构：const [a, setA] = react.useState(...)  → a, setA 都是定义
  const reArr = /(?:^|[\s;{}=])(?:const|let|var)\s+\[\s*([^\]]*)\s*\]\s*=/g;
  while ((m = reArr.exec(code)) !== null) {
    for (let raw of m[1].split(',')) {
      raw = raw.trim();
      if (!raw || raw.startsWith('...')) continue;
      const simple = /^[A-Za-z_$][\w$]*$/.exec(raw);
      if (simple) defs.add(simple[0]);
    }
  }
  // export { a, b as c }
  const reExport = /export\s*\{\s*([^}]+)\s*\}/g;
  while ((m = reExport.exec(code)) !== null) {
    for (let spec of m[1].split(',')) {
      spec = spec.trim();
      if (!spec) continue;
      const asIdx = spec.lastIndexOf(' as ');
      defs.add(asIdx >= 0 ? spec.slice(asIdx + 4).trim() : spec.trim());
    }
  }
  // 箭头函数常量：const f = (x) => ... 和 const f = x => ...（reConst 已抓 f，这里补）
  const reArrow = /(?:^|[\s;{}])(?:export\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  while ((m = reArrow.exec(code)) !== null) defs.add(m[1]);
  // 函数签名参数（被调用的合法场景：回调/resolve/reject/ctx 等）
  // 任何 `(params)` 后跟 `=>` 或 `{` 即参数列表；`[^()]*` 保证匹配内层参数括号
  const reParamList = /\(([^()]*)\)\s*(?:=>|\{)/g;
  let pm;
  while ((pm = reParamList.exec(code)) !== null) {
    const raw = pm[1].trim();
    if (!raw) continue;
    // 展开对象/数组解构与普通参数：逐段提取标识符
    // 先处理对象/数组解构块（内部逗号不能当分隔符）
    const destrRe = /\{([^{}]*)\}|\[([^\[\]]*)\]/g;
    let dm;
    let remaining = raw;
    while ((dm = destrRe.exec(raw)) !== null) {
      const inner = dm[1] !== undefined ? dm[1] : dm[2];
      for (let spec of inner.split(',')) {
        spec = spec.trim();
        if (!spec) continue;
        // 对象解构 `b: c` / 数组解构 `c` / 默认值 `c = 1`
        const asIdx = spec.lastIndexOf(':');
        let nm = (asIdx >= 0 ? spec.slice(asIdx + 1) : spec).trim();
        const eqIdx = nm.indexOf('=');
        if (eqIdx >= 0) nm = nm.slice(0, eqIdx).trim();
        if (nm.startsWith('...')) nm = nm.slice(3);
        const sm = /^[A-Za-z_$][\w$]*$/.exec(nm);
        if (sm) defs.add(sm[0]);
      }
      // 从 remaining 移除已处理的解构块（避免二次拆分）
      remaining = remaining.replace(dm[0], ' ');
    }
    // 普通参数（含默认值 / rest）
    for (let tok of remaining.split(',')) {
      tok = tok.trim();
      if (!tok || tok.startsWith('{') || tok.startsWith('[')) continue;
      let name = tok;
      if (name.startsWith('...')) name = name.slice(3);
      const eqIdx = name.indexOf('=');
      if (eqIdx >= 0) name = name.slice(0, eqIdx).trim();
      const sm = /^[A-Za-z_$][\w$]*$/.exec(name);
      if (sm) defs.add(sm[0]);
    }
  }
  // 对象方法定义：render(...) { ... }（对象字面量内的键方法，调用方在其外）
  const reMethod = /(?:^|[\s,{:])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  while ((m = reMethod.exec(code)) !== null) defs.add(m[1]);
  return defs;
}

// ---------- 解析源模块的导出名（相对路径） ----------
function exportsOfModule(sourceFile, importSource, seen = new Set()) {
  if (!importSource.startsWith('.')) return { ok: true, names: null, reason: 'external' };
  const base = resolve(dirname(sourceFile), importSource);
  const candidates = [
    base, base + '.js', base + '.mjs', base + '.cjs',
    join(base, 'index.js'), join(base, 'index.mjs'),
  ];
  const target = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!target) return { ok: false, names: null, reason: 'file-not-found' };
  if (seen.has(target)) return { ok: true, names: null, reason: 'cycle' };
  seen.add(target);
  let src;
  try { src = readFileSync(target, 'utf8'); } catch { return { ok: false, names: null, reason: 'unreadable' }; }
  const names = new Set();
  const reExp = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = reExp.exec(src)) !== null) names.add(m[1]);
  const reExpObj = /export\s*\{\s*([^}]+)\s*\}/g;
  while ((m = reExpObj.exec(src)) !== null) {
    for (let spec of m[1].split(',')) {
      spec = spec.trim();
      if (!spec) continue;
      const asIdx = spec.lastIndexOf(' as ');
      names.add(asIdx >= 0 ? spec.slice(0, asIdx).trim() : spec.trim());
    }
  }
  if (/\bexport\s+default\b/.test(src)) names.add('default');
  // 再导出：export ... from './x'
  const reRe = /export\s+(?:const|let|var|class|async\s+function|function|default)?\s*([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reRe.exec(src)) !== null) {
    const sub = exportsOfModule(target, m[2], seen);
    if (sub.ok && sub.names) sub.names.forEach((n) => names.add(n));
  }
  const reReObj = /export\s*\{\s*([^}]+)\s*\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reReObj.exec(src)) !== null) {
    const sub = exportsOfModule(target, m[2], seen);
    if (sub.ok && sub.names) {
      for (let spec of m[1].split(',')) {
        spec = spec.trim();
        if (!spec) continue;
        const asIdx = spec.lastIndexOf(' as ');
        names.add(asIdx >= 0 ? spec.slice(0, asIdx).trim() : spec.trim());
      }
    }
  }
  return { ok: true, names, reason: 'ok' };
}

// ---------- 剥离注释与字符串（模板字符串保留 ${...} 表达式），只留代码 ----------
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '"' || c === "'") {
      const q = c;
      out += ' ';
      i++;
      while (i < n) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        if (source[i] === q) { out += ' '; i++; break; }
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '`') {
      // 模板字符串：保留 ${...} 内部代码，其余替换为空格
      out += ' ';
      i++;
      while (i < n) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') {
          out += '${';
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const t = source[i];
            if (t === '{') { depth++; out += t; i++; continue; }
            if (t === '}') { depth--; out += t; i++; continue; }
            if (t === '"' || t === "'" || t === '`') {
              // 表达式内嵌套字符串/模板——递归简单处理：把这一段原样保留到匹配结束
              const subEnd = findStrEnd(source, i);
              out += source.slice(i, subEnd);
              i = subEnd;
              continue;
            }
            out += t;
            i++;
          }
          continue;
        }
        if (source[i] === '`') { out += ' '; i++; break; }
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '/' && looksLikeRegexStart(out)) {
      // 正则字面量 /.../flags（在代码上下文里）
      out += ' ';
      i++;
      let inClass = false;
      while (i < n) {
        const t = source[i];
        if (t === '\\') { out += '  '; i += 2; continue; }
        if (t === '[') { inClass = true; out += ' '; i++; continue; }
        if (t === ']') { inClass = false; out += ' '; i++; continue; }
        if (t === '/' && !inClass) { out += ' '; i++; break; }
        if (t === '\n') break;
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 判断当前位置是否可能开始正则字面量（前面是代码分隔符而非标识符/数字）。 */
function looksLikeRegexStart(prevOut) {
  const trimmed = prevOut.replace(/\s+$/, '');
  if (trimmed === '') return true;
  const last = trimmed[trimmed.length - 1];
  if ('([{,:=!&|?;+-*%^<>'.includes(last)) return true;
  if (/[A-Za-z0-9_$)\]]$/.test(last)) return false; // 标识符/数字/括号尾 → 除法或调用
  return true;
}

/** 找到从 i 开始的字符串结束位置（含 i；处理转义），返回结束下标（含引号）。 */
function findStrEnd(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    i++;
  }
  return src.length;
}

function collectCalls(source) {
  const calls = new Set();
  const code = stripComments(source);
  // 匹配 `标识符(`，排除属性访问 a.b( / 关键字 / 模板字符串 ${ 内
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
         'new', 'delete', 'void', 'do', 'else', 'in', 'of', 'instanceof', 'await',
         'yield', 'throw', 'import', 'export', 'from', 'class', 'extends', 'with',
         'case', 'default', 'debugger', 'async'].includes(name)) continue;
    // 排除 `new Uint8Array(`（new 后跟构造器）——已进白名单
    calls.add(name);
  }
  return calls;
}

// ---------- 主流程 ----------
function collectFiles(targets, out = [], seen = new Set()) {
  for (const t of targets) {
    const abs = resolve(t);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      for (const ent of readdirSync(abs)) {
        if (ent === 'node_modules' || ent === '.git' || ent.startsWith('.')) continue;
        collectFiles([join(abs, ent)], out, seen);
      }
    } else if (st.isFile() && ['.js', '.mjs', '.cjs'].includes(extname(abs))) {
      out.push(abs);
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const targets = args.length ? args : [resolve('lib')];
  const files = collectFiles(targets);
  let errorCount = 0;
  let warnCount = 0;
  const report = [];

  for (const file of files.sort()) {
    const source = readFileSync(file, 'utf8');
    const { imported, imports } = parseImports(source);
    const defs = parseDefinitions(source);

    // [ERROR] named import 引用源模块不存在的导出
    for (const imp of imports) {
      if (!imp.source.startsWith('.')) continue;
      const ex = exportsOfModule(file, imp.source);
      if (!ex.ok) {
        report.push({ level: 'ERROR', file, msg: `import '${imp.source}' 源模块解析失败（${ex.reason}）` });
        errorCount++;
        continue;
      }
      if (!ex.names) continue;
      for (const spec of imp.named) {
        const srcName = spec.source;
        const localName = spec.local;
        if (srcName === 'default') continue;
        if (!ex.names.has(srcName)) {
          const shown = localName === srcName ? srcName : `${srcName} as ${localName}`;
          report.push({ level: 'ERROR', file, msg: `import { ${shown} } from '${imp.source}' 但源模块没有导出 ${srcName}` });
          errorCount++;
        }
      }
    }

    // [WARN] 调用未导入/未定义标识符
    const calls = collectCalls(source);
    for (const name of calls) {
      if (imported.has(name) || defs.has(name) || GLOBAL_WHITELIST.has(name)) continue;
      report.push({ level: 'WARN', file, msg: `调用 ${name}() 既未 import 也未在本文件定义（可能是 bug 或对象方法误报）` });
      warnCount++;
    }
  }

  const relBase = process.cwd();
  for (const r of report) {
    const rel = r.file.startsWith(relBase) ? r.file.slice(relBase.length + 1) : r.file;
    console.log(`[${r.level}] ${rel}: ${r.msg}`);
  }
  console.log(`\n扫描 ${files.length} 个文件 → ERROR ${errorCount} / WARN ${warnCount}`);
  if (errorCount > 0) process.exitCode = 1;
}

main();
