// dsh-session-conductor — 成员模型切换：定位与校验
//
// 【职责】把「切模型」的目标解析出来：成员名/sessionId/标题 → 会话，
// 并在切换前做状态门禁与 provider/model 组合校验。

/**
 * 取一个可用于 Team 名册查询的 caller agent（lead 优先）。
 * agentTeams.listMembers(caller) 需要一个 Team 成员作为 caller 来解析名册。
 * @returns {object|null} 可用 agent，取不到返回 null
 */
export function pickTeamCaller(ctx) {
  const agents = ctx.get("agents");
  if (!agents) return null;
  try {
    const initiator = agents.currentInitiator?.();
    if (initiator) return initiator;
  } catch {
    // 不在异步链上下文时忽略
  }
  try {
    const roots = agents.roots?.() ?? [];
    if (roots.length > 0) return roots[0];
  } catch {
    // roots 不可用时忽略
  }
  try {
    const list = agents.list?.() ?? [];
    if (list.length > 0) return list[0];
  } catch {
    // list 不可用时忽略
  }
  return null;
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
  let catalog = null;
  try {
    const sc = ctx.get("sessionController");
    catalog = sc?.modelCatalog ? await sc.modelCatalog() : null;
  } catch {
    catalog = null;
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
export function findTargetAgent(ctx, target) {
  const raw = String(target ?? "").trim();
  if (!raw) return { error: "target 不能为空（传 sessionId / 成员名 / 标题关键字）" };
  const agents = ctx.get("agents");
  const teams = ctx.get("agentTeams");
  // ① Team 名册：name 或 id 精确匹配优先
  if (teams?.listMembers && agents) {
    const caller = pickTeamCaller(ctx);
    if (caller) {
      let members = [];
      try {
        members = teams.listMembers(caller) ?? [];
      } catch {
        members = [];
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
