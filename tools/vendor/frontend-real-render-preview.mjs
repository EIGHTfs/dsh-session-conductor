#!/usr/bin/env node
/**
 * frontend-real-render-preview —— 把 DSH 客户端插件的**真实** client.js 渲染成单文件 HTML。
 *
 * 目的：改前端后需要「实际渲染自检」（见 frontend-render-selfcheck），但宿主 GUI 里的插件页面
 *   改一次就要重启/刷新才能看，且报错藏在浏览器控制台里看不见。
 *   本工具把真实组件代码垫片宿主环境后跑起来，产出一个**双击即开、离线可用**的 HTML，
 *   并用无头浏览器探测渲染结果与交互行为，把「看不到页面」变成可自动检测。
 *
 * 与「手抄一份 HTML 模拟稿」的本质区别：跑的是真代码。
 *   手抄稿只能证明「我想要的样式长这样」，证明不了「我的组件真能这样渲染」——
 *   真实缺陷（列表缺 key、动作没接到 props、状态回弹、条件禁用写错）只有跑真代码才暴露。
 *
 * 用法：
 *   node frontend-real-render-preview.mjs --client <插件client.js> --out <输出.html> [选项]
 *
 * 选项：
 *   --client <path>    插件客户端入口（classic script，内部调 window.__ModuleLoader__.load）
 *   --out <path>       输出的单文件 HTML（默认 ./preview.html）
 *   --backend <base>   真实后端 base（如 http://127.0.0.1:30801）：预览页内 fetch 原样打真实后端，
 *                      不垫假数据、不 mock；未提供时退回 --fake/--endpoints 离线兜底
 *   --same-origin      同源模式：预览页经 DSH 同源路由打开时用（fetch 相对路径原样打页面源，
 *                      不拼 base——反代地址打开预览，API 同源可达）
 *   --fake <path>      假数据 JSON（离线兜底用）：作为 settingsScope 的初值（对象）
 *   --endpoints <path> 假接口 JSON（离线兜底用）：{ "URL子串": {响应对象}, ... }，按序匹配
 *   --require-map <path>  require 垫片映射 JSON：{ "包名": "导出说明" }，取值见下方 BUILTIN_REQUIRES
 *   --react <dir>      react UMD 所在目录（默认自动探测，见 findReactUmd）
 *   --section <文本>   渲染指定注册槽（按 spec.name/spec.id 匹配，如 settings.section / sidebar.footer.action；
 *                      默认渲染第一个注册的 slot）
 *   --tab <文本>       自动点击的选项卡文本（生成时注入；配合 --probe 先切页再探测控件）
 *   --open             生成后用无头浏览器打开并打印渲染诊断（需 chromium）
 *   --browser <path>    无头浏览器可执行文件路径（默认 chromium / 环境变量 CHROMIUM）
 *   --probe 自动带 --disable-web-security：file:// 预览页 fetch 真实后端不被 CORS 拦（仅自检用）
 *   --probe            只用无头浏览器探测已有 --out 文件（可用 --tab 先切页、--click 点控件）
 *
 *   --click <sel,...>  探测时依次点击这些选择器，报告点击前后状态是否变化（逗号分隔）
 * 退出码：0 = 生成/探测成功；1 = 参数或渲染错误（错误会打进 HTML 顶部的红色块 + stderr）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/* ═══════════════════ 1. 宿主环境垫片（可复用部分） ═══════════════════ */

/**
 * 内置 require 垫片：把宿主提供的模块换成等价实现。
 *
 * @deepseek-ai/dsh-client-store 常不在本地磁盘上（宿主运行时注入），故用等价的最小实现：
 *   createSnapshotStore(initial) → { set, getSnapshot, subscribe }，语义与宿主一致
 *   （set 后通知所有订阅者），足够让基于它的组件正常渲染与更新。
 */
const BUILTIN_REQUIRES = {
  'react': 'React UMD 全局',
  'react/jsx-runtime': 'jsx/jsxs → React.createElement 适配器',
  '@deepseek-ai/dsh-client-store': 'createSnapshotStore 最小实现（内存 + 订阅通知）',
};

function buildRequireShim(extraMap = {}) {
  return `
window.__requireShim = function (name) {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return window.__jsxRuntime;
  if (name === '@deepseek-ai/dsh-client-store') {
    return { createSnapshotStore: function (initial) {
      var cur = initial, subs = [];
      return {
        set: function (v) { cur = v; subs.forEach(function (f) { f(); }); },
        getSnapshot: function () { return cur; },
        subscribe: function (f) { subs.push(f); return function () {}; },
      };
    } };
  }
  var extra = ${JSON.stringify(extraMap)};
  if (Object.prototype.hasOwnProperty.call(extra, name)) return extra[name];
  throw new Error('未垫片的 require: ' + name + '（用 --require-map 补充）');
};
`;
}

/**
 * jsx-runtime → React.createElement 适配器。
 *
 * ⚠️ 关键坑：React.createElement(type, props, key) 的第 3 个参数是 **children** 而不是 key。
 *   直接把 jsx 的 key 传成第 3 参，会把 props.children 顶掉 → 组件渲染成空壳，
 *   且**不报错**（看起来只是「样式不对」）。正确做法：key 放进 props，children 作为后续实参展开。
 */
const JSX_RUNTIME_ADAPTER = `
window.__jsxRuntime = {
  Fragment: React.Fragment,
  jsx: function (type, props, key) {
    var p = props || {}, children = p.children, rest = {};
    for (var k in p) if (k !== 'children') rest[k] = p[k];
    if (key !== undefined) rest.key = key;
    var args = children === undefined ? [rest] : [rest].concat(Array.isArray(children) ? children : [children]);
    return React.createElement.apply(React, [type].concat(args));
  },
  jsxs: function (type, props, key) { return window.__jsxRuntime.jsx(type, props, key); },
};
`;

/** 错误捕获：把渲染/交互期的报错显示在页面顶部，而不是只进控制台。 */
const ERROR_CAPTURE = `
window.__PREVIEW_ERRORS__ = [];
function __err(kind, msg) {
  window.__PREVIEW_ERRORS__.push(kind + ': ' + msg);
  var d = document.getElementById('__err');
  if (!d) {
    d = document.createElement('pre');
    d.id = '__err';
    d.style.cssText = 'color:#f87171;white-space:pre-wrap;font-size:12px;border:1px solid #f87171;' +
      'padding:8px;margin:0 0 12px;max-width:900px';
    document.body.insertBefore(d, document.body.firstChild);
  }
  d.textContent += kind + ': ' + msg + String.fromCharCode(10);
}
window.addEventListener('error', function (e) { __err('error', e.message); });
window.addEventListener('unhandledrejection', function (e) {
  __err('reject', String((e.reason && e.reason.stack) || e.reason));
});
var __origConsoleError = console.error;
console.error = function () {
  __err('console', Array.prototype.map.call(arguments, function (x) {
    return String((x && x.stack) || x);
  }).join(' '));
  __origConsoleError.apply(console, arguments);
};
`;

/**
 * 假接口 + 假 settingsScope。
 *
 * ⚠️ 关键坑：假接口**必须真的改假数据**。
 *   若 /toggle-xxx 之类只返回 {ok:true} 而不改 fake，
 *   组件「先本地翻转、再重新拉取对账」的逻辑会把状态拉回原样 ——
 *   表现为「点完回弹」，看起来像组件 bug，其实是垫片没实现。
 */
function buildHostShims(fake, endpoints, backend, sameOrigin) {
  return `
window.__BACKEND__ = ${JSON.stringify(backend || "")};
window.__SAME_ORIGIN__ = ${JSON.stringify(!!sameOrigin)};
window.__NATIVE_FETCH__ = window.fetch.bind(window);
window.__FAKE__ = ${JSON.stringify(fake || {})};

// 宿主 settingsScope：内存 store，set 后通知 → 界面真的跟着变
window.__scopeSubs = [];
window.__scopeMock = {
  getSnapshot: function () { return { status: 'ready', writable: true, value: window.__FAKE__ }; },
  subscribe: function (cb) { window.__scopeSubs.push(cb); return function () {}; },
  set: function (key, value) {
    window.__FAKE__[key] = value;
    window.__scopeSubs.forEach(function (f) { f(); });
    return Promise.resolve();
  },
};

window.__ENDPOINTS__ = ${JSON.stringify(endpoints || {})};
window.__MUTATORS__ = window.__MUTATORS__ || {};
window.fetch = function (url, init) {
  var u = String(url);
  // 真实后端模式：不垫假数据，原样转发（相对路径拼 base）；跨域由后端 CORS 决定
  if (window.__BACKEND__) {
    var target = u.indexOf('http') === 0 ? u : window.__BACKEND__ + u;
    return window.__NATIVE_FETCH__(target, init);
  }
  // 同源模式（--same-origin）：预览页经 DSH 同源路由打开，fetch 相对路径原样打页面源
  if (window.__SAME_ORIGIN__) {
    return window.__NATIVE_FETCH__(url, init);
  }
  // 先跑自定义变更器（让写操作真的改假数据，避免「点完回弹」）
  var keys = Object.keys(window.__MUTATORS__);
  for (var i = 0; i < keys.length; i++) {
    if (u.indexOf(keys[i]) >= 0) {
      try { window.__MUTATORS__[keys[i]](window.__FAKE__, init); } catch (e) {
        window.__PREVIEW_ERRORS__.push('mutator(' + keys[i] + '): ' + e.message);
      }
    }
  }
  var ek = Object.keys(window.__ENDPOINTS__);
  for (var j = 0; j < ek.length; j++) {
    if (u.indexOf(ek[j]) >= 0) {
      var body = window.__ENDPOINTS__[ek[j]];
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    }
  }
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } });
};
`;
}

/* ═══════════════════ 2. 渲染挂载 ═══════════════════ */

/**
 * 调用插件的 apply(ctx)，并把注册到的 section 渲染到 #root。
 *
 * flushSync 是必需的：React 18 的 createRoot().render() 是并发异步的，
 *   不 flush 就 dump DOM / 截图会拿到空页面（并在探测脚本里误判为「组件没渲染」）。
 *
 * 同时自动尝试若干常见的注册入口（settings.section / settings.plugin.item 等），
 *   哪个注册上了就渲染哪个，避免为每个插件改工具代码。
 */
function buildMountScript(tabText, sectionId) {
  return `
try {
  window.__SECTIONS__ = [];
  function collect(render, label) {
    if (typeof render === 'function') window.__SECTIONS__.push({ render: render, label: label });
  }
  var ctx = {
    settingsScope: { bind: function () { return window.__scopeMock; } },
    locale: {
      register: function (_ns, _dict) { return function () {}; },
      bind: function (_ns) { return function (key) { return key; }; },
    },
    effect: function (fn) { try { if (typeof fn === 'function') fn(); } catch (e) { __err('effect', (e && e.message) || String(e)); } return function () {}; },
    get: function (k) { return k === 'slots' ? ctx.slots : undefined; },
    slots: {
      inject: function (_n, cb) { if (typeof cb === 'function') cb(); },
      register: function (spec, render) { collect(render, ((spec && (spec.name || spec.id)) || 'slot')); },
    },
    // 兼容直接给出渲染函数的注册形态
    render: function (render) { collect(render, 'render'); },
  };
  // 多块插件：每个 load 块都可能注册 UI/文案，逐个执行其 apply（块间共享 ctx 垫片）
  for (var i = 0; i < window.__CAPTURED__.length; i++) {
    try {
      var mod = window.__CAPTURED__[i].factory(window.__requireShim);
      if (typeof mod.apply === 'function') mod.apply(ctx);
    } catch (e) { __err('factory[' + i + ']', (e && e.message) || String(e)); }
  }
  if (!window.__SECTIONS__.length) throw new Error('未捕获到任何注册的渲染函数（检查 ctx.slots.register 用法）');

  var section = window.__SECTIONS__[0];
  var WANT = ${JSON.stringify(sectionId || '')};
  if (WANT) {
    var hit = window.__SECTIONS__.filter(function (s) { return (s.label || '').indexOf(WANT) >= 0; })[0];
    if (hit) section = hit;
  }
  ReactDOM.flushSync(function () {
    ReactDOM.createRoot(document.getElementById('root')).render(
      React.createElement(function () {
        var el = section.render({
          wide: true,
          onOpenSession: function () {},
          // t：读预览页已 fetch 的真实 i18n 字典（zh 优先，回退键名）；{var} 占位替换
          t: function (key, args) {
            var d = (window.__SC_I18N__ && window.__SC_I18N__.zh) ? window.__SC_I18N__.zh : {};
            // 字典按 NS 分组（{ns: {key: 值}}）：跨分组找键
            var v = key;
            for (var ns in d) { if (d[ns] && d[ns][key]) { v = d[ns][key]; break; } }
            if (args) for (var k in args) v = String(v).split('{' + k + '}').join(args[k]);
            return v;
          },
        });
        return el || React.createElement('div', null, '（渲染函数返回空）');
      }, null)
    );
  });
  window.__READY__ = true;
  var TAB = ${JSON.stringify(tabText || '')};
  if (TAB) {
    setTimeout(function () {
      var b = Array.prototype.slice.call(document.querySelectorAll('button[role=tab],.tab,.dshgp_tab'))
        .filter(function (x) { return x.textContent.trim() === TAB; })[0];
      if (b) b.click();
    }, 50);
  }
} catch (e) {
  __err('harness', (e && e.message) || String(e));
}
`;
}

/* ═══════════════════ 3. React UMD 探测 ═══════════════════ */

/**
 * 在本机 node_modules（含 pnpm 布局）里找 React / ReactDOM 的 UMD 开发版。
 *
 * 用 UMD 开发版而不是生产版：开发版会打印 key 缺失、props 类型等 React 自身告警，
 *   而这些告警正是「列表缺 key」这类真实缺陷的暴露途径。
 * 优先检查本地，避免为了一次预览去下载（check-local-before-download）。
 */
function findReactUmd(explicitDir, startDir) {
  const roots = [];
  if (explicitDir) roots.push(explicitDir);
  // 常见宿主布局：仓库根/node_modules/.pnpm/react@*/node_modules/react/umd
  // 起点优先用插件 client 所在目录：插件就装在宿主 checkout 里，从插件目录往上能找到
  //   宿主 node_modules；而进程 cwd 可能是 /tmp 等无关位置，往上 4 层什么都找不到。
  let dir = startDir && existsSync(startDir)
    ? (statSync(startDir).isDirectory() ? startDir : dirname(startDir))
    : process.cwd();
  for (let i = 0; i < 4 && dir !== '/'; i++) {
    roots.push(join(dir, 'node_modules'));
    dir = dirname(dir);
  }
  // DSH 宿主布局：插件工作区在 <DSH_CHECKOUT>/.dsh-home/工作区/<插件>/，
  //   而 react 装在 <DSH_CHECKOUT>/node_modules —— 从 cwd 往上 4 层够不到，需显式补。
  //   用 DSH_HOME / DSH_ROOT 环境变量（宿主会注入）优先。
  for (const envKey of ['DSH_ROOT', 'DSH_HOME', 'DSH_CHECKOUT']) {
    const v = process.env[envKey];
    if (v) {
      roots.push(join(v, 'node_modules'));
      roots.push(join(dirname(v), 'node_modules'));
    }
  }
  const found = { react: null, reactDom: null };
  for (const root of roots) {
    const pnpm = join(root, '.pnpm');
    const candidates = [root];
    if (existsSync(pnpm)) {
      for (const e of readdirSync(pnpm)) {
        if (/^react@|^react-dom@/.test(e)) candidates.push(join(pnpm, e, 'node_modules'));
      }
    }
    for (const c of candidates) {
      if (!found.react && existsSync(join(c, 'react', 'umd', 'react.development.js'))) {
        found.react = join(c, 'react', 'umd', 'react.development.js');
      }
      if (!found.reactDom && existsSync(join(c, 'react-dom', 'umd', 'react-dom.development.js'))) {
        found.reactDom = join(c, 'react-dom', 'umd', 'react-dom.development.js');
      }
    }
    if (found.react && found.reactDom) break;
  }
  return found;
}

/* ═══════════════════ 4. 生成 HTML ═══════════════════ */

function buildHtml({ clientSrc, reactUmd, domUmd, fake, endpoints, backend, sameOrigin, extraMap, tabText, sectionId, title, banner }) {
  // ⚠️ 顺序坑：client.js 第 1 行就调 window.__ModuleLoader__.load，
  //   所以 __ModuleLoader__ 的垫片必须在 client.js **之前**的 script 里定义。
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title>
<style>
body{margin:0;padding:20px;background:#0f1117;color:#e8eaf0;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.banner{max-width:900px;margin:0 0 14px;padding:10px 12px;border:1px dashed rgba(255,255,255,.18);
  border-radius:10px;color:#a0a6b4;font-size:12px}
.banner b{color:#e8eaf0}
#root{max-width:900px}
</style></head><body>
<div class="banner">${banner}</div>
<div id="root"></div>
<script>${reactUmd}</script>
<script>${domUmd}</script>
<script>${ERROR_CAPTURE}${JSX_RUNTIME_ADAPTER}${buildRequireShim(extraMap)}
window.__CAPTURED__ = [];
window.__ModuleLoader__ = { load: function (m) { window.__CAPTURED__.push(m); } };
</script>
<script>${clientSrc}</script>
<script>${buildHostShims(fake, endpoints, backend, sameOrigin)}</script>
<script>${buildMountScript(tabText, sectionId)}</script>
</body></html>`;
}

/* ═══════════════════ 5. 无头浏览器探测 ═══════════════════ */

/** 用 chromium + CDP 打开页面，回收渲染状态、交互可用性、以及累计报错。 */
async function probe(page, { port = 9333, clickSelectors = [], waitMs = 3500, tabText = '', browser = '' } = {}) {
  // --disable-web-security + --allow-file-access-from-files：file:// 打开的预览页 fetch 真实后端时
  // 不受同源策略/CORS 拦截（仅无头自检用；人工浏览器打开真实后端预览仍需 DSH 同源服务或自行放行）
  const chrome = spawn(browser || process.env.CHROMIUM || 'chromium', [
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-web-security', '--allow-file-access-from-files',
    `--remote-debugging-port=${port}`, page.startsWith('file://') ? page : `file://${page}`,
  ], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const kill = () => { try { chrome.kill(); } catch { /* 已退出 */ } };
  try {
    await sleep(waitMs);
    let list = null;
    for (let i = 0; i < 12; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        list = await res.json();
        if (list?.length) break;
      } catch { /* 还没起来 */ }
      await sleep(700);
    }
    if (!list?.length) return { ok: false, error: 'chromium 未就绪（未取到调试目标）' };
    const target = list.find((t) => t.type === 'page') || list[0];
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const evaluate = (expr) => new Promise((res) => {
      const id = Math.floor(Math.random() * 1e6);
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) {
          ws.removeEventListener('message', onMsg);
          res(m.result?.result?.value ?? JSON.stringify(m.result));
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    });
    const out = { ok: true };
    out.ready = await evaluate('!!window.__READY__');
    // 先切到目标选项卡：默认渲染的是第一个注册的 section，
    //   要探测的控件往往在别的页（如「审计」页的开关），不切页会找不到元素而静默不生效。
    if (tabText) {
      out.tabSwitched = await evaluate(`(() => {
        var b = Array.prototype.slice.call(document.querySelectorAll('button[role=tab],.tab,.dshgp_tab'))
          .filter(function (x) { return x.textContent.trim() === ${JSON.stringify(tabText)}; })[0];
        if (!b) return false;
        b.click(); return true;
      })()`);
      await sleep(500);
    }
    out.errors = await evaluate('JSON.stringify(window.__PREVIEW_ERRORS__ || [])');
    out.text = await evaluate("(document.getElementById('root')||{}).innerText || ''");
    out.rootHtmlLen = await evaluate("((document.getElementById('root')||{}).innerHTML || '').length");
    if (clickSelectors.length) {
      out.clicks = [];
      for (const sel of clickSelectors) {
        const before = await evaluate(`JSON.stringify([...document.querySelectorAll('${sel}')].map(e=>e.checked!==undefined?e.checked:e.className))`);
        await evaluate(`(()=>{const e=document.querySelector('${sel}');if(e)e.click();return 'ok';})()`);
        await sleep(400);
        const after = await evaluate(`JSON.stringify([...document.querySelectorAll('${sel}')].map(e=>e.checked!==undefined?e.checked:e.className))`);
        out.clicks.push({ selector: sel, before, after, changed: before !== after });
      }
    }
    ws.close();
    return out;
  } finally {
    kill();
  }
}

/* ═══════════════════ 6. CLI ═══════════════════ */

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else flags._.push(a);
  }
  return flags;
}

function readJson(path, what) {
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`${what} 文件不存在：${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.probe) {
    const page = resolve(String(flags.out || 'preview.html'));
    const r = await probe(page, {
      clickSelectors: flags.click ? String(flags.click).split(',') : [],
      tabText: flags.tab ? String(flags.tab) : '',
      browser: flags.browser ? String(flags.browser) : '',
    });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok && r.ready ? 0 : 1);
  }

  if (!flags.client) {
    console.error('缺少 --client <插件client.js>。用 --help 看用法。');
    process.exit(1);
  }
  if (flags.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    process.exit(0);
  }

  const clientPath = resolve(String(flags.client));
  if (!existsSync(clientPath)) throw new Error(`client 文件不存在：${clientPath}`);
  const clientSrc = readFileSync(clientPath, 'utf8');
  if (!clientSrc.includes('__ModuleLoader__')) {
    console.error(`⚠️ ${clientPath} 里未见 window.__ModuleLoader__.load —— DSH 客户端插件入口必须是这种形态。`);
  }

  const umd = findReactUmd(flags.react ? resolve(String(flags.react)) : null, dirname(clientPath));
  if (!umd.react || !umd.reactDom) {
    throw new Error('未找到 React/ReactDOM UMD。用 --react <含 react/umd 的目录> 指定。');
  }

  const backend = flags.backend ? String(flags.backend).replace(/\/$/, '') : '';
  const sectionId = flags.section ? String(flags.section) : '';
  const sameOrigin = flags['same-origin'] === true || flags['same-origin'] === 'true';
  const fake = readJson(flags.fake ? resolve(String(flags.fake)) : null, '假数据');
  const endpoints = readJson(flags.endpoints ? resolve(String(flags.endpoints)) : null, '假接口') || {};
  const extraMap = readJson(flags['require-map'] ? resolve(String(flags['require-map'])) : null, 'require 映射') || {};

  const outPath = resolve(String(flags.out || 'preview.html'));
  const html = buildHtml({
    clientSrc,
    reactUmd: readFileSync(umd.react, 'utf8'),
    domUmd: readFileSync(umd.reactDom, 'utf8'),
    fake, endpoints, backend, sameOrigin, extraMap,
    tabText: flags.tab ? String(flags.tab) : '',
    sectionId: sectionId,
    title: `真实渲染预览 · ${clientPath.split('/').pop()}`,
    banner: '这是<b>真实组件渲染预览</b>：跑的是 <b>' + clientPath.split('/').pop() +
      '</b> 本体，只垫片了宿主环境（ModuleLoader / react / settingsScope）。' +
      (backend
        ? '⚠️ <b>接真实后端</b>（' + backend + '）：fetch 原样打真实 API，写操作会真实落库，只读探测优先。'
        : '离线兜底：假接口/假数据，不调真实接口。'),
  });
  writeFileSync(outPath, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`✓ 已生成 ${outPath}（${kb} KB，单文件自包含）`);
  console.log(`  react:    ${umd.react}`);
  console.log(`  react-dom:${umd.reactDom}`);
  if (!fake) console.log('  ⚠️ 未提供 --fake，settingsScope 初值为空对象（页面可能显示空状态）');

  if (flags.open) {
    const r = await probe(outPath, {
      clickSelectors: flags.click ? String(flags.click).split(',') : [],
      tabText: flags.tab ? String(flags.tab) : '',
    });
    console.log('\n── 渲染探测 ──');
    console.log(JSON.stringify(r, null, 2));
    if (r.ok && r.errors && r.errors !== '[]') {
      console.error('\n⚠️ 页面存在运行期报错，见上方 errors。');
      process.exit(1);
    }
    process.exit(0); // 显式退出：chromium 子进程与 CDP WebSocket 会挂住事件循环，命令不返回
  }
}

main().catch((e) => { console.error('❌ ' + (e?.message || e)); process.exit(1); });
