/**
 * dsh-session-conductor — 会话模板注入子模块（ 新增）
 *
 * 作用：两个固定模板槽位——plan（方案/计划模板）、closing（收尾模板）。
 * 每个槽位支持：上传本地 md 文件 / 在线 md 文件网址（host 下载转存），
 * 内容经 systemPrompt.section「session-templates」注入，AI 一开始就看见。
 *
 * 与「额外注入系统提示词」（md-inject.js）的区别：这是「特殊定制单独」——固定两个
 * 语义明确的槽位，注入文本带【方案模板】/【收尾模板】标签；md-inject 是任意多
 * 个文档的通用列表。两者互不影响。
 *
 * 实现（复用 md-inject 模式）：
 *  - 内容落盘 <DSH_HOME>/template-inject-md/<slot>.md（slot = plan | closing）
 *  - 槽位元信息（enabled/name/url/bytes/updatedAt）存插件 domain：sessionTemplates
 *  - systemPrompt section 同步读盘拼接（文件更新/删除无需重启即生效）
 */

import { promises as fs } from 'node:fs'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'

export const TEMPLATE_SLOTS = ['plan', 'closing'];
export const TEMPLATE_MAX_BYTES = 256 * 1024; // 单模板上限 256KB（同 md-inject）

export const TEMPLATE_DEFAULTS = {
  plan: { enabled: false, enforce: false, name: '', url: '', bytes: 0, updatedAt: 0 },
  closing: { enabled: false, enforce: false, name: '', url: '', bytes: 0, updatedAt: 0 },
};

/**
 *  方案模板强制门禁：代码修改类工具（edit/write/apply + bash 写操作启发式）
 * 在「未出提案 + 未获确认」时被 tools/pre-execute 拒绝（deny）。
 * 状态机与拦截器在 index.js；这里只放共享的判定常量，保证注入文案与拦截口径一致。
 */
export const PLAN_ENFORCE_EDIT_TOOLS = ['edit', 'write', 'apply'];
export const PLAN_ENFORCE_CONFIRM_RE = /^\s*(确认|同意|按方案执行|执行吧|go ahead|ok|可以)[\s!！.。~～]*$/i;
export const PLAN_ENFORCE_PROPOSE_TITLE = '修改方案提案';
export const PLAN_ENFORCE_PROPOSE_CONFIRM_SECTION = '八、是否执行';
/** bash 写操作启发式（保守起步：命中即视为写，误拦靠 deny 指引自愈） */
export const PLAN_ENFORCE_BASH_WRITE_RE = /(^|\s|;|&&|\|\|)(>>|>\s*\S|sed\s+-i|rm\s|mv\s|cp\s|tee\s|mkdir|touch\s|chmod|chown|git\s+commit|git\s+reset|git\s+checkout\s+--|patch\b|truncate|dd\s)/;

function sanitizeForPrompt(text) {
  return String(text ?? '').replace(/\{\{/g, '{').replace(/\}\}/g, '}');
}

/** 模板目录：<DSH_HOME>/template-inject-md */
export function templateRoot(dshHome) {
  return join(dshHome, 'template-inject-md');
}

function templateFile(dshHome, slot) {
  return join(templateRoot(dshHome), `${slot}.md`);
}

function validSlot(slot) {
  return TEMPLATE_SLOTS.includes(slot) ? slot : null;
}

/** 保存一个模板（本地 md 上传）：内容 → 落盘 <slot>.md。返回 {ok, slot, name, bytes}。 */
export async function saveTemplate(dshHome, slot, { name, content }) {
  const s = validSlot(slot);
  if (!s) return { ok: false, error: { code: 'bad-slot', message: `模板槽位须为 ${TEMPLATE_SLOTS.join('|')}` } };
  const root = templateRoot(dshHome);
  await fs.mkdir(root, { recursive: true });
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content ?? '');
  if (buf.length === 0) return { ok: false, error: { code: 'empty', message: '模板 md 内容为空' } };
  if (buf.length > TEMPLATE_MAX_BYTES) return { ok: false, error: { code: 'too-large', message: `模板超过上限 ${TEMPLATE_MAX_BYTES} 字节` } };
  const clean = String(name ?? '').slice(0, 120) || `${s}-template.md`;
  await fs.writeFile(templateFile(dshHome, s), buf);
  await fs.chmod(templateFile(dshHome, s), 0o600).catch(() => {});
  return { ok: true, slot: s, name: clean, bytes: buf.length };
}

/**
 * 从在线 md 文件网址下载内容转存（转存内容不是地址）。
 * 校验同 md-inject：http(s) URL、200、文本（非图片）、≤256KB、非二进制。
 * @returns {Promise<{ok:boolean, slot?, name?, bytes?, error?}>}
 */
export async function saveTemplateFromUrl(dshHome, slot, url) {
  const s = validSlot(slot);
  if (!s) return { ok: false, error: { code: 'bad-slot', message: `模板槽位须为 ${TEMPLATE_SLOTS.join('|')}` } };
  const raw = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return { ok: false, error: { code: 'bad-url', message: '仅支持 http(s) 在线 md 文件网址' } };
  let res;
  try {
    res = await fetch(raw, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'dsh-session-conductor/1.31 (+template-inject)' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { ok: false, error: { code: 'fetch-fail', message: `下载失败: ${String(error?.message ?? error)}` } };
  }
  if (!res.ok) return { ok: false, error: { code: 'http-' + res.status, message: `在线 md 下载失败: HTTP ${res.status} ${res.statusText || ''}`.trim() } };
  const contentType = String(res.headers.get('content-type') ?? '');
  if (contentType && /^image\//i.test(contentType)) return { ok: false, error: { code: 'not-md', message: '该网址返回图片，不是 md 文本' } };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > TEMPLATE_MAX_BYTES) return { ok: false, error: { code: 'too-large', message: `在线模板超过上限 ${TEMPLATE_MAX_BYTES} 字节` } };
  if (buf.length === 0) return { ok: false, error: { code: 'empty', message: '在线模板内容为空' } };
  let nul = 0;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nul++;
  if (nul > 8) return { ok: false, error: { code: 'binary', message: '网址内容疑似二进制，拒绝注入' } };
  const urlName = raw.split(/[\/?#]/).pop() || '';
  const name = urlName.endsWith('.md') ? urlName : (urlName ? urlName + '.md' : 'online-template.md');
  return saveTemplate(dshHome, s, { name, content: buf.toString('utf8') });
}

/** 删除一个模板（清空槽位）。 */
export async function removeTemplate(dshHome, slot) {
  const s = validSlot(slot);
  if (!s) return { ok: false, error: { code: 'bad-slot', message: `模板槽位须为 ${TEMPLATE_SLOTS.join('|')}` } };
  const file = templateFile(dshHome, s);
  try { await fs.unlink(file); } catch { /* 无文件也视为清除成功 */ }
  return { ok: true, slot: s, removed: true };
}

/** 同步读单个模板文本（systemPrompt section 用）。文件缺失 → ''。 */
export function readTemplateSync(dshHome, slot) {
  const s = validSlot(slot);
  if (!s || !dshHome) return '';
  const file = templateFile(dshHome, s);
  try {
    if (!existsSync(file)) return '';
    const text = readFileSync(file, 'utf8');
    return sanitizeForPrompt(text);
  } catch { return ''; }
}

/**
 * 拼接两个模板为注入文本（systemPrompt section「session-templates」text 用）。
 * 只有 enabled 且内容非空的槽位注入。带【方案模板】/【收尾模板】标签。
 */
export function collectTemplateSlotText(dshHome, slot, meta = TEMPLATE_DEFAULTS) {
  if (!dshHome) return '';
  const m = (meta && meta[slot]) || {};
  if (m.enabled !== true) return '';
  const text = readTemplateSync(dshHome, slot);
  if (!text.trim()) return '';
  const labels = { plan: '方案模板（修改代码前先按此出提案）', closing: '收尾模板（任务完成汇报格式）' };
  const name = String(m.name || slot).trim();
  // 方案模板开启强制门禁时，注入文本里同步声明拦截口径（AI 与拦截器同一约定）
  const enforceNote = slot === 'plan' && m.enforce === true
    ? '\n\n> ⚠️ **本模板已开启强制门禁**：未按本模板出方案提案并获用户「确认」前，代码修改类工具调用（edit/write/apply 及含写操作的 bash）会被 harness 直接拒绝。先出提案 → 等确认 → 再动手。'
    : '';
  return `## ${labels[slot]}${name ? `（来源：${name}）` : ''}\n\n${text}${enforceNote}`;
}

export function collectTemplatesTextSync(dshHome, meta = TEMPLATE_DEFAULTS) {
  if (!dshHome) return '';
  const parts = [];
  for (const slot of TEMPLATE_SLOTS) {
    const one = collectTemplateSlotText(dshHome, slot, meta);
    if (one) parts.push(one);
  }
  if (parts.length === 0) return '';
  return `【dsh-session-conductor 会话模板（设置 → 会话管理 → 模板注入）】\n\n${parts.join('\n\n---\n\n')}`;
}

/**
 * 列 DSH 主目录树内的一层目录（模板「在 dsh 目录内找」）。
 * 只允许浏览 root（DSH 主目录）及其子目录，杜绝越权。
 * @returns {Promise<{ok:boolean, path?:string, parent?:string|null, entries?:Array<{name,path,isDir,isMd}>, error?}>}
 */
export async function listTemplateDir(root, path) {
  const base = resolve(String(root ?? ''));
  let dir;
  try { dir = resolve(path ? String(path) : base); } catch { dir = base; } // 空 path = 主目录根
  // 越权校验：dir 必须在 base 树内（等于 base 或以其为前缀）
  const rel = relative(base, dir);
  if (rel === '..' || rel.startsWith('..' + sep) || (rel && rel.startsWith(sep))) {
    return { ok: false, error: { code: 'outside-root', message: '只能浏览 DSH 主目录内的目录' } };
  }
  let items = [];
  try { items = await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
    return { ok: false, error: { code: 'list-fail', message: `目录读取失败: ${String(error?.message ?? error)}` } };
  }
  const entries = items
    .filter((e) => !e.name.startsWith('.')) // 隐藏项不显示
    .map((e) => {
      const full = join(dir, e.name);
      const isDir = e.isDirectory();
      const isMd = !isDir && e.name.toLowerCase().endsWith('.md');
      return { name: e.name, path: full, isDir, isMd };
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)));
  return { ok: true, path: dir, parent: dir === base ? null : dir.slice(0, Math.max(dir.lastIndexOf(sep), 0)) || sep, entries };
}

/**
 * 把工作区目录树内的一个 .md 文件读为模板（「在 dsh 目录内找」）。
 * 校验：path 在 browseRoot 树内（ 起 = 工作区目录）、是 .md、≤上限、非空。
 * 落盘到 <saveRoot>/template-inject-md/<slot>.md（saveRoot 缺省 = browseRoot； 起
 * 由 index.js 传 DSH_HOME，保证浏览工作区、落盘 DSH_HOME）。
 * @returns {Promise<{ok:boolean, slot?, name?, bytes?, error?}>}
 */
export async function saveTemplateFromPath(browseRoot, slot, path, saveRoot) {
  const s = validSlot(slot);
  if (!s) return { ok: false, error: { code: 'bad-slot', message: `模板槽位须为 ${TEMPLATE_SLOTS.join('|')}` } };
  const base = resolve(String(browseRoot ?? ''));
  const full = resolve(path ? String(path) : base); // 空 path 兜底为 base（随后校验必失败，不误读 cwd）
  const rel = relative(base, full);
  if (rel === '..' || rel.startsWith('..' + sep) || (rel && rel.startsWith(sep))) {
    return { ok: false, error: { code: 'outside-root', message: '只能选用 DSH 工作区目录内的 md 文件' } };
  }
  if (!full.toLowerCase().endsWith('.md')) return { ok: false, error: { code: 'not-md', message: '只能选用 .md 文件' } };
  let st;
  try { st = statSync(full); } catch (error) {
    return { ok: false, error: { code: 'read-fail', message: `文件读取失败: ${String(error?.message ?? error)}` } };
  }
  if (st.size === 0) return { ok: false, error: { code: 'empty', message: '模板 md 内容为空' } };
  if (st.size > TEMPLATE_MAX_BYTES) return { ok: false, error: { code: 'too-large', message: `模板超过上限 ${TEMPLATE_MAX_BYTES} 字节` } };
  const content = readFileSync(full, 'utf8');
  return saveTemplate(saveRoot || browseRoot, s, { name: full.split(sep).pop(), content });
}

/**
 *  方案模板强制门禁：门判定（无状态，从会话事件流现场推导）。
 * 放行条件 = 「确认消息之前的那一段 AI 输出含提案双标记」且「最后一条真人用户消息命中确认词」。
 * 无状态的好处：重启零恢复问题，门状态永远由真实事件流现场推导，不与内存缓存打架。
 */

export const planEnforceDenyMessage = (toolName) =>
  `⛔ 方案模板强制门禁：检测到代码修改类工具调用（${toolName}），但本回合尚无「已确认的方案提案」。` +
  `请先按方案模板输出完整提案（含「八、是否执行」确认段），等用户回复「确认」后再调用本工具。` +
  `若用户已确认过，请核对：确认必须是紧跟在提案之后的那条用户消息（新请求需重新提案 + 重新确认）。`;

/** 提取一条 message 事件的纯文本（content 块数组，兼容 data.content / data.message.content）。 */
function planGateMessageText(ev) {
  const data = ev?.data ?? {};
  const content = Array.isArray(data.content) ? data.content : Array.isArray(data.message?.content) ? data.message.content : [];
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

/** 跳过系统注入的用户消息（运行时上下文 / pre-step 注入 / 关键词注入），只看真人消息。 */
function planGateIsInjectedUserText(text) {
  return /^\s*(Current runtime context|The user (said|requested)|<system-reminder>|【dsh-|🔑)/.test(text || "");
}

/** 门判定：提案（确认消息之前的 AI 输出段）+ 确认（最后一条真人用户消息）同时成立才放行。 */
export function planGateAllows(events) {
  if (!Array.isArray(events) || events.length === 0) return false;
  let lastUser = null;
  const assistantBeforeLastUser = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const t = ev?.type;
    if (t === "user/message") {
      const text = planGateMessageText(ev);
      if (planGateIsInjectedUserText(text)) continue;
      if (lastUser === null) { lastUser = text; continue; }
      break; // 找到最后两条真人消息即可，不再向前扫
    }
    if (t === "assistant/message" && lastUser !== null) {
      const text = planGateMessageText(ev);
      if (text) assistantBeforeLastUser.push(text);
    }
  }
  if (lastUser === null || assistantBeforeLastUser.length === 0) return false;
  const proposed = assistantBeforeLastUser.some((text) =>
    text.includes(PLAN_ENFORCE_PROPOSE_TITLE) && text.includes(PLAN_ENFORCE_PROPOSE_CONFIRM_SECTION));
  if (!proposed) return false;
  const strict = PLAN_ENFORCE_CONFIRM_RE.test(lastUser.trim());
  const loose = /(确认|同意|按方案执行|执行吧|go ahead)/i.test(lastUser);
  return strict || loose;
}
