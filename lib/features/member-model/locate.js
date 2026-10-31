// dsh-session-conductor — 成员模型切换：定位与校验
//
// 【职责】把「切模型」的目标解析出来：成员名/sessionId/标题 → 会话，
// 并在切换前做状态门禁与 provider/model 组合校验。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "../../core/config.js";
import { log } from "../../shared/log.js";
import { sessionsRootOf } from "../../sessions/events.js";
import { loadTrash } from "../trash.js";

// ── 悬空成员过滤（「删目录 + 列表过滤」方案） ─────────────────────────────────
//
// 【问题】成员记录有两份来源：父会话日志里的 `subagent/catalog` 事件（名册的数据源）
// 和成员自己的会话目录。直接删掉成员会话目录后，父日志里那条 catalog 还在 ——
// 名册于是会列出一个「点不开、切不动、删不掉」的幽灵成员。
//
// 【做法】不改父会话日志（重写会牵动 seq 与压缩引用），只在**读名册这一层**过滤：
//   · 内存里有 live agent → 保留（还在跑，目录异常是另一回事，不能凭空隐藏）
//   · 会话目录存在 → 保留
//   · 两者都没有 → 判定为悬空条目，从列表与目标解析里剔除
//
// 【为什么带缓存】名册会在一次列表/批量解析里被连续调用多次；每次全量扫 sessions/
// 在 CIFS 上代价明显。这里缓存 5s：删完会话目录后最多 5s 刷新到列表。
const SESSION_DIR_TTL_MS = 5000;
let sessionDirCache = { at: 0, ids: null };

/**
 * 扫出当前存在的会话目录名集合（`<sessionsRoot>/<工作区分组>/<会话id>/`）。
 * `session-` 前缀双向归一：宿主在不同路径下用过带/不带前缀两种目录名。
 * @returns {Set<string>|null} 会话 id 集合；根目录不可读时返回 null（表示「无法判定」，调用方不过滤）
 */
export function existingSessionDirIds() {
  const now = Date.now();
  if (sessionDirCache.ids && now - sessionDirCache.at < SESSION_DIR_TTL_MS) return sessionDirCache.ids;
  const ids = new Set();
  try {
    const root = sessionsRootOf();
    for (const group of readdirSync(root)) {
      let names;
      try {
        names = readdirSync(join(root, group));
      } catch {
        continue;
      }
      for (const name of names) {
        ids.add(name);
        if (name.startsWith("session-")) ids.add(name.slice(8));
        else ids.add(`session-${name}`);
      }
    }
  } catch {
    // 根不可读：不缓存「空集」，否则会把整份名册误判成悬空
    return null;
  }
  sessionDirCache = { at: now, ids };
  return ids;
}

/**
 * 取回收站里的会话 id 集合（软删除的会话文件仍在盘上，但已算「用户删掉了」）。
 * @param {object} ctx 插件 context
 * @returns {Set<string>} 会话 id 集合（索引不可用返回空集）
 */
export function trashedSessionIds(ctx) {
  try {
    const trash = loadTrash(ctx);
    return new Set(Object.keys(trash?.entries ?? {}));
  } catch {
    return new Set();
  }
}

/** 清空会话目录缓存（删除成员会话后调用，让列表立刻反映）。 */
export function invalidateSessionDirCache() {
  sessionDirCache = { at: 0, ids: null };
}

/**
 * 过滤掉悬空成员：既没有 live agent、又找不到会话目录的条目。
 *
 * @param {Array<{id: string}>} members 名册条目
 * @param {object|null} agents 宿主 agents 服务（用于判断是否 live）
 * @returns {Array} 过滤后的条目（无法判定目录时不删任何条目）
 */
export function filterDanglingMembers(members, agents, trashedIds = null) {
  const list = Array.isArray(members) ? members : [];
  const dirs = existingSessionDirIds();
  if (!dirs) return list;
  return list.filter((m) => {
    const id = m?.id;
    if (!id) return false;
    // 在回收站里 = 用户已删除：目录还在（软删除保留文件，可还原），但名册不该再显示。
    // 不判这一条的话，「删掉成员」要等回收站到期/清空（默认 7 天）才会从列表消失。
    if (trashedIds && (trashedIds.has(id) || trashedIds.has(String(id).replace(/^session-/, "")))) return false;
    if (dirs.has(id) || dirs.has(String(id).replace(/^session-/, ""))) return true;
    // 目录不在，但进程里还有 agent：不隐藏（可能是未落盘的临时会话）
    try {
      if (agents?.get?.(id)) return true;
    } catch {
      return true;
    }
    return false;
  });
}

/**
 * 取一个可用于 Team 名册查询的 caller agent（lead 优先）。
 * agentTeams.listMembers(caller) 需要一个 Team 成员作为 caller 来解析名册。
 * @returns {object|null} 可用 agent，取不到返回 null
 */
export function pickTeamCaller(ctx, preferred = null) {
  // 0) 调用方显式给的发起方最可靠：命令/工具都能直接拿到 invocation.agent / exec.agent。
  //    currentInitiator() 依赖「当前在某个 agent 的异步链里」，命令处理器里经常拿不到 ——
  //    这正是「工具能切、聊天指令说找不到成员」的根因。
  if (preferred) return preferred;
  const agents = ctx.get("agents");
  if (!agents) return null;
  for (const probe of CALLER_PROBES) {
    const hit = safeProbe(probe, agents);
    if (hit) return hit;
  }
  return null;
}

/** 依次尝试的发起方来源（按可靠性从高到低）。 */
const CALLER_PROBES = [
  (agents) => agents.currentInitiator?.(),
  (agents) => (agents.roots?.() ?? [])[0] ?? null,
  (agents) => (agents.list?.() ?? [])[0] ?? null,
];

/** 任一来源不可用/抛错都当作「没有」，不影响下一个来源。 */
function safeProbe(probe, agents) {
  try {
    return probe(agents) ?? null;
  } catch {
    return null;
  }
}

/**
 * 成员状态门禁：只有 running / inactive 可以切模型。
 *
 * 【为什么】provisioning（创建中）时切模型会干扰创建流程——roster 的持久化恢复校验要求
 * 子会话 descriptor.provider 与成员记录 provider 一致（agent-team/roster.ts 的
 * "persisted child Session does not match the provisioned continuation"），
 * 创建中改选择会让该校验失败 → 成员被标记 failed，并**长期占用 active child 名额**
 * （表现为 spawn_teammate 报 "subagent limit reached"）。failed 成员同理不应再切。
 *
 * @param {object} member TeamMemberView（含 status）
 * @returns {string|null} 不可切时返回错误文案；可切返回 null
 */
export function memberStatusError(member) {
  const status = member?.status;
  if (status === "provisioning") {
    return `成员「${member.name}」正在创建中（provisioning）——创建中切模型会导致创建校验失败并把成员标记 failed，请等它进入 running 再切`;
  }
  if (status === "failed") {
    return `成员「${member.name}」创建已失败（failed）——它会一直占用 active child 名额，请先清理/重建该成员，不要对它切模型`;
  }
  return null;
}

/**
 * 校验 provider/model 组合是否存在于官方 modelCatalog。
 * 【为什么】切到无效组合（如把带前缀的模型 id 当 provider、或 provider 下没有该模型）
 * 会让后续回合的模型请求被拒 → 表现为「切换生效了但回合失败」。
 * modelCatalog 不可用时跳过校验（不阻断，仅在能查到时把关）。
 *
 * @returns {Promise<{ok: true, note?: string} | {error: string}>}
 */
export async function validateModelPair(ctx, provider, model) {
  // 组合校验只是「提前拦住无效组合」，不该成为切换的必经阻塞点：
  //   · 默认就是关闭（modelSwitchValidateCatalog 缺省 false）——@Remote 取目录可能久不返回；
  //   · 无论成败都把耗时打出来（sessionController.modelCatalog 是 @Remote，某些部署上很久才返回）。
  if (cfg.modelSwitchValidateCatalog === false) {
    return { ok: true, note: "已按配置跳过组合校验（modelSwitchValidateCatalog=false）" };
  }
  let catalog = null;
  const startedAt = Date.now();
  try {
    const sc = ctx.get("sessionController");
    catalog = sc?.modelCatalog ? await sc.modelCatalog() : null;
  } catch {
    catalog = null;
  } finally {
    log(ctx, `模型组合校验取目录耗时 ${Date.now() - startedAt}ms（分组数 ${(catalog?.groups ?? []).length}）`);
  }
  const groups = catalog?.groups ?? [];
  if (groups.length === 0) return { ok: true, note: "modelCatalog 不可用，已跳过组合校验" };
  const group = groups.find((g) => g.id === provider);
  if (!group) {
    return { error: `provider「${provider}」不存在（可用：${groups.map((g) => g.id).join(", ")}）` };
  }
  const models = group.models ?? [];
  if (!models.some((m) => m.id === model)) {
    const shown = models.slice(0, 12).map((m) => m.id).join(", ");
    const more = models.length > 12 ? " …" : "";
    return { error: `provider「${provider}」下没有模型「${model}」（该 provider 可用：${shown}${more}）` };
  }
  return { ok: true };
}

/**
 * 定位目标成员 agent。定位顺序：
 * ① Team 名册（ctx.agentTeams.listMembers）——覆盖 spawn_teammate 创建的队友（不在 ctx.agents.list() 里）；
 * ② 普通 agents 列表（ctx.agents.list）——非 Team 场景的活跃 agent；
 * ③ 标题子串匹配（sessionTitle 快照）。
 * @returns {{sessionId: string, agent: object|null, matched: string, member?: object} | {error: string}}
 */
export function findTargetAgent(ctx, target, { caller: explicitCaller = null } = {}) {
  const raw = String(target ?? "").trim();
  if (!raw) return { error: "target 不能为空（传 sessionId / 成员名 / 标题关键字）" };
  const agents = ctx.get("agents");
  const teams = ctx.get("agentTeams");
  // ① Team 名册：name 或 id 精确匹配优先
  if (teams?.listMembers && agents) {
    const caller = pickTeamCaller(ctx, explicitCaller);
    if (caller) {
      let members = [];
      try {
        members = teams.listMembers(caller) ?? [];
      } catch {
        members = [];
      }
      // 悬空成员（会话目录已删、内存无 agent）不参与目标解析：否则切模型会写到一个
      // 不存在的会话、或误报「成员正在执行回合」这类假状态。名单本身仍保留在父日志里。
      const allMembers = members;
      members = filterDanglingMembers(members, agents, trashedSessionIds(ctx));
      if (members.length === 0 && allMembers.length > 0) {
        return { error: `成员「${raw}」的会话目录已被删除（父会话名册里仍有记录，属悬空条目）——请改用其他成员，或先恢复该会话` };
      }
      if (members.length > 0) {
        const exact = members.find((m) => m?.name === raw || m?.id === raw);
        if (exact) {
          const statusError = memberStatusError(exact);
          if (statusError) return { error: statusError };
          // inactive 成员没有 live agent，但官方 selectModel 支持冷会话（内部自动 resume），
          // 因此这里不要求 agent 存在——拿到 sessionId 即可切模型。
          return { sessionId: exact.id, agent: agents.get?.(exact.id) ?? null, matched: exact.name === raw ? "成员名" : "sessionId", member: exact };
        }
        const fuzzy = members.filter((m) => String(m?.name ?? "").toLowerCase().includes(raw.toLowerCase()));
        if (fuzzy.length === 1) {
          const statusError = memberStatusError(fuzzy[0]);
          if (statusError) return { error: statusError };
          return { sessionId: fuzzy[0].id, agent: agents.get?.(fuzzy[0].id) ?? null, matched: "成员名（模糊）", member: fuzzy[0] };
        }
        if (fuzzy.length > 1) {
          return { error: `「${raw}」匹配到 ${fuzzy.length} 个成员，请用完整成员名或 sessionId：${fuzzy.map((m) => `${m.name}(${m.id})`).join(", ")}` };
        }
      }
    }
  }
  // ② 普通 agents 列表（sessionId 精确 → 标题子串）
  let list = [];
  try {
    list = agents?.list?.() ?? [];
  } catch (error) {
    return { error: `agents 服务不可用：${String(error?.message ?? error)}` };
  }
  if (list.length === 0) return { error: "当前没有活跃成员（用 list_agents 查看）" };
  const exactAgent = list.find((a) => a?.session?.id === raw);
  if (exactAgent) return { sessionId: exactAgent.session.id, agent: exactAgent, matched: "sessionId" };
  const titleService = ctx.get("sessionTitle");
  const needle = raw.toLowerCase();
  const hits = list.filter((a) => {
    let text = "";
    try {
      const snapshot = titleService?.get?.(a.session);
      text = typeof snapshot === "string" ? snapshot : String(snapshot?.title ?? "");
    } catch {
      text = "";
    }
    return text.toLowerCase().includes(needle);
  });
  if (hits.length === 1) return { sessionId: hits[0].session.id, agent: hits[0], matched: "标题" };
  if (hits.length === 0) return { error: `没有匹配「${raw}」的活跃成员（可用 list_agents 看成员列表）` };
  return { error: `「${raw}」匹配到 ${hits.length} 个成员，请用 sessionId 精确指定：${hits.map((a) => a?.session?.id).join(", ")}` };
}

/**
 * 统一名册：Team 成员（spawn_teammate 创建的队友，不在普通 agents 列表里）+ 普通 agents。
 *
 * 【为什么要抽公共】聊天指令与 AI 工具原先各写一份「谁是成员」：
 * 命令版靠 `pickTeamCaller(ctx)` 猜发起方，在命令处理器里经常拿不到 ⇒ 名册为空 ⇒
 * 报「没有匹配的活跃成员」，而同样的名字走 AI 工具（在 agent 异步链里调用）却能找到。
 * 现在两处都调这一个函数，并且都显式把 invocation.agent / exec.agent 传进来。
 *
 * @param {object} ctx 插件上下文
 * @param {{caller?: object}} [opts] caller = 发起方 agent（命令/工具里直接给，最可靠）
 * @returns {Array<{id, name, provider?, model?, source}>} 去重后的成员列表（取不到返回空数组）
 */
export function collectTeamMembers(ctx, { caller: explicitCaller = null } = {}) {
  const out = [];
  const seen = new Set();
  const push = (id, name, extra = {}) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: name ?? null, ...extra });
  };
  const teams = ctx?.get?.("agentTeams");
  const caller = pickTeamCaller(ctx, explicitCaller);
  if (teams?.listMembers && caller) {
    try {
      for (const m of teams.listMembers(caller) ?? []) {
        // role/status 是宿主 TeamMemberView 的既有字段：批量操作要排除 Lead 本人，
        // 也要跳过 provisioning/failed 这类不可操作的成员，所以必须带上。
        push(m?.id ?? m?.sessionId, m?.name, {
          provider: m?.provider, model: m?.model, role: m?.role, status: m?.status, source: "名册",
        });
      }
    } catch {
      // 名册不可用：继续用 agents 列表兜底
    }
  }
  try {
    const agents = ctx?.get?.("agents");
    for (const a of agents?.list?.() ?? []) {
      push(a?.session?.id ?? a?.id, a?.session?.title ?? null, { source: "agent" });
    }
  } catch {
    // agents 不可用：保持已有结果
  }
  // 过滤悬空条目：成员会话目录已被删除、且内存里也没有 agent 的，不再出现在列表里
  // （父会话日志里的 catalog 事件不动 —— 重写父日志会牵动 seq 与压缩引用）。
  return filterDanglingMembers(out, ctx?.get?.("agents"), trashedSessionIds(ctx));
}

/** 目标是否为「全部成员」：空、`*`、`all` 都算（大小写不敏感）。 */
export function isAllTarget(target) {
  const t = String(target ?? "").trim().toLowerCase();
  return t === "" || t === "*" || t === "all";
}

/**
 * 把一次操作的 target 解析成「一个或多个」目标。
 *
 * 【为什么要批量形态】批量给所有子代理统一模型/权限是高频需求（新建一批成员后统一对齐），
 * 逐个传 sessionId 既慢又容易漏。约定：空 / `*` / `all` = 全部成员（**排除 Lead 本人**，
 * 因为「所有子代理」的语义就是下属，不该把 Lead 自己也改掉）。
 *
 * @param {object} ctx 插件 context
 * @param {string} target 原始 target
 * @param {{caller?: object}} [opts] 显式发起方
 * @returns {{all: boolean, targets: Array<{sessionId: string, member?: object, agent?: object|null, matched?: string}>} | {error: string}}
 */
export function resolveTargets(ctx, target, { caller: explicitCaller = null } = {}) {
  const agents = ctx?.get?.("agents");
  if (isAllTarget(target)) {
    const members = collectTeamMembers(ctx, { caller: explicitCaller });
    // 只取可操作的下属：排除 Lead，排除正在创建/已失败的成员
    const usable = members.filter((m) => m.role !== "lead" && m.status !== "provisioning" && m.status !== "failed");
    if (usable.length === 0) {
      const why = members.length === 0
        ? "名册里没有任何成员"
        : `名册里有 ${members.length} 个条目，但没有可操作的下属（都排除了 Lead / provisioning / failed）`;
      return { error: `没有可操作的目标成员（${why}）` };
    }
    return {
      all: true,
      targets: usable.map((m) => ({
        sessionId: m.id,
        member: m,
        agent: agents?.get?.(m.id) ?? null,
        matched: "全部",
      })),
    };
  }
  const found = findTargetAgent(ctx, target, { caller: explicitCaller });
  if (found?.error) return { error: found.error };
  return { all: false, targets: [found] };
}

/**
 * 定位 Team Lead 会话（「跟随主代理」的落点）。
 *
 * 【为什么要专门找 Lead】「模型/权限留空 = 跟主代理一致」里的主代理指 Team Lead，
 * 而不是发起这次调用的那个成员——由成员自己发起时，跟随它本身毫无意义。
 * 宿主 TeamMemberView 的 role 字段能直接识别，不需要猜。
 *
 * @param {object} ctx 插件 context
 * @param {{caller?: object}} [opts] 显式发起方
 * @returns {{sessionId: string, agent: object|null, source: string} | {error: string}}
 */
export function resolveLeader(ctx, { caller: explicitCaller = null } = {}) {
  const teams = ctx?.get?.("agentTeams");
  const agents = ctx?.get?.("agents");
  const caller = pickTeamCaller(ctx, explicitCaller);
  if (!caller) return { error: "拿不到发起方，无法定位 Lead（可用 sessionId 显式指定目标）" };
  let members = [];
  try {
    members = teams?.listMembers?.(caller) ?? [];
  } catch (error) {
    return { error: `读取名册失败：${String(error?.message ?? error)}` };
  }
  if (members.length === 0) return { error: "名册为空，无法定位 Lead（可用 sessionId 显式指定目标）" };
  // 发起方自己就是 Lead：直接用（省一次 agents 查找）
  const callerId = caller?.session?.id ?? null;
  const selfRow = callerId ? members.find((m) => m?.id === callerId && m?.role === "lead") : null;
  if (selfRow) return { sessionId: callerId, agent: caller, source: "发起方即 Lead" };
  const leadRow = members.find((m) => m?.role === "lead");
  if (!leadRow) return { error: "名册里没有 Lead 行（role=lead），无法定位主代理" };
  return { sessionId: leadRow.id, agent: agents?.get?.(leadRow.id) ?? null, source: "名册 Lead 行" };
}
