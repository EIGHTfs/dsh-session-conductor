// dsh-session-conductor — 把成员「换名」成新成员（新建 + 搬会话内容）
//
// 【为什么需要它】宿主的 Team 成员名是**不可变身份字段**：`team/member` 投影里有断言
//   if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context)
//     throw new Error('changed immutable identity fields')
// 而且只允许 provisioning → active 这一次写入，已 active 的成员再写必被 phase 校验拒绝；
// 宿主侧也没有任何 rename 接口。所以「改名」唯一可行的路是：**新建一个成员，再把旧内容搬过去**。
//
// 【为什么这条路成立】成员名与会话内容是两份独立数据：
//   · 成员名 → 存在 **Lead 会话日志**的 `team/member` 事件里（换名时由 spawn 写入新名）
//   · 会话内容 → 存在 **成员自己的会话日志**里（本模块替换的就是这一份，其中没有 team/member）；
//     实测该日志的事件里 0 处引用自己的 sessionId，因此**只换 header 就够**。
//
// 【搬运必须「原样复制」（一次真实事故换来的结论）】会话事件之间布满了跨事件引用：
//   顶层 `sourceEventSeqs`、顶层 `surfaceOp { startSeq, endSeq }`、`data.messageSeqs`、
//   `data.shadowedSeqs`、`data.headerSeq`，以及 compaction 的 start → summary/prune → end 强配对。
//   任何 seq 重排或事件增删都会让这些关系断裂，宿主加载时直接判 corrupt。实测连续撞过三种：
//     ① `sourceEventSeqs ranges must contain unique earlier seqs`
//     ② `session/title messageSeqs must cite distinct earlier human user/message events`
//     ③ `successful compaction/end requires one summary`
//   而搬运本质就是复制：源 seq 本来就是 0..N 连续，所以正确做法是
//   **事件一条不改、seq 一个不动，只替换 header 里的身份字段**。
//
// 【必须保留的两条硬约束】
//   ① 帧必须带校验和：宿主读帧会验 checksum，缺了就报「会话文件 总和检查码不匹配」直接拒读；
//   ② 目标成员不能正在跑：宿主以内存态优先，对运行中的成员改磁盘文件不生效，还可能被覆盖回去。
import { readFileSync, writeFileSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { log } from "../../shared/log.js";
import { findTargetAgent } from "./locate.js";
import { PLACEHOLDER_PROMPT, waitUntilIdle } from "./create-teammate.js";

/**
 * 把源会话的事件原样搬到目标会话日志，**只替换 header 身份**。
 *
 * 设计要点（每一条都是为了避免破坏跨事件引用）：
 *   · 源事件一条不丢、seq 一个不改 —— 引用关系因此天然保持，compaction 配对也完整；
 *   · header 用**目标**自己的（id / cwd / parentSession / origin / delegationDepth / isSeeded），
 *     否则新成员会变成旧成员；
 *   · 只允许改 `subagent/descriptor` 里的 label / 模型路由（纯字符串字段，不参与任何引用）。
 *
 * @param {string} sourceFile 源成员会话日志
 * @param {string} targetFile 目标成员会话日志
 * @param {{label?: string, seedProvider?: string, seedModel?: string}} [opts]
 *        label 改写 descriptor 的描述；seedProvider/seedModel 改写 descriptor 的模型路由（省略则沿用源）
 * @returns {Promise<{ok: true, events: number, backup: string, size: number} | {ok: false, error: string}>}
 */
export async function transplantSessionLog(sourceFile, targetFile, opts = {}) {
  const { decodeAllFrames } = await import("../../zstd-frames.js");
  const { encodeSessionText } = await import("../../repair.js");

  // ① 目标 header：新成员的身份，原样保留
  let targetHead;
  try {
    const text = await decodeAllFrames(readFileSync(targetFile));
    targetHead = JSON.parse(text.split("\n").find((l) => l.trim() !== ""));
  } catch (error) {
    return { ok: false, error: `读取目标会话 header 失败：${String(error?.message ?? error)}` };
  }
  if (!targetHead?.id) return { ok: false, error: "目标会话 header 缺少 id，无法确定新成员身份" };

  // ② 源事件：全部读取，一条不丢（只跳过 header 那一行）
  let sourceEvents;
  try {
    const text = await decodeAllFrames(readFileSync(sourceFile));
    sourceEvents = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type === "session") continue;   // header 用目标的
      sourceEvents.push(e);
    }
  } catch (error) {
    return { ok: false, error: `读取源会话失败：${String(error?.message ?? error)}` };
  }
  if (sourceEvents.length === 0) return { ok: false, error: "源会话没有可搬运的事件" };

  // ③ 仅改写 descriptor 的人类可读字段（不碰 seq、不碰任何引用）
  for (const e of sourceEvents) {
    if (e?.type !== "subagent/descriptor" || !e.data) continue;
    if (opts.label !== undefined) e.data.label = String(opts.label);
    if (opts.seedProvider !== undefined) e.data.agentProvider = String(opts.seedProvider);
    if (opts.seedModel !== undefined) e.data.agentModel = String(opts.seedModel);
  }

  const outText = [JSON.stringify(targetHead), ...sourceEvents.map((e) => JSON.stringify(e))].join("\n") + "\n";
  const encoded = await encodeSessionText(outText);   // 官方编码器：自带 checksum

  // ④ 写前自检：解码回来**逐条与源对比**。这是唯一能证明「除 header 与 descriptor 外一字未改」的检查，
  //    也是唯一能保证「源能加载 ⇒ 目标也能加载」的依据（跨事件引用全部原样）。
  let verifyLines;
  try {
    const verifyText = await decodeAllFrames(encoded);
    verifyLines = verifyText.split("\n").filter((l) => l.trim() !== "");
  } catch (error) {
    return { ok: false, error: `写前自检解码失败：${String(error?.message ?? error)}` };
  }
  if (verifyLines.length !== sourceEvents.length + 1) {
    return { ok: false, error: `写前自检事件数不符（期望 ${sourceEvents.length + 1} 行，实际 ${verifyLines.length}）` };
  }
  const verifyHead = JSON.parse(verifyLines[0]);
  if (verifyHead.id !== targetHead.id) {
    return { ok: false, error: `写前自检 header 身份不符（期望 ${targetHead.id}，实际 ${verifyHead.id}）` };
  }
  const normalize = (v) => JSON.stringify(v);
  for (let i = 0; i < sourceEvents.length; i += 1) {
    let got;
    try { got = JSON.parse(verifyLines[i + 1]); } catch {
      return { ok: false, error: `写前自检第 ${i + 2} 行不是合法 JSON` };
    }
    const want = sourceEvents[i];
    if (normalize(got) === normalize(want)) continue;
    // descriptor 允许 label / 模型路由不同，其余必须逐字段一致
    if (want?.type === "subagent/descriptor" && got?.type === "subagent/descriptor") {
      const a = { ...want.data }; const b = { ...got.data };
      delete a.label; delete b.label; delete a.agentProvider; delete b.agentProvider;
      delete a.agentModel; delete b.agentModel;
      if (normalize(a) === normalize(b) && got.seq === want.seq) continue;
    }
    return { ok: false, error: `写前自检失败：第 ${i + 2} 行（seq ${want?.seq ?? "?"} / ${want?.type ?? "?"}）与源不一致，放弃写入` };
  }

  // ⑤ 备份目标原日志 → 原子写回
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dirname(targetFile), `session.before-clone-${stamp}.bak`);
  try {
    copyFileSync(targetFile, backup);
  } catch (error) {
    return { ok: false, error: `备份目标日志失败（未写入）：${String(error?.message ?? error)}` };
  }
  const tmp = join(dirname(targetFile), ".session.clone.tmp");
  writeFileSync(tmp, encoded, { mode: 0o600 });
  renameSync(tmp, targetFile);

  return { ok: true, events: sourceEvents.length, backup, size: statSync(targetFile).size };
}

/**
 * 把成员 A 的会话内容克隆到一个新成员 B（B 用新名字，A 不动）。
 *
 * 四步：① 解析源成员 ② spawn 新成员（占位任务，只消耗极短提示）③ 中断并等它空闲
 *      ④ 把源会话内容原样搬进新成员日志。
 *
 * @param {object} ctx 插件 context
 * @param {object} exec 执行上下文（含 agent）
 * @param {{source: string, name: string, description?: string, withHistory?: boolean,
 *          provider?: string, model?: string, subagentProvider?: string}} args 参数
 * @returns {Promise<object>} 回执对象（成功含 newMember，失败含 error）
 */
export async function cloneMemberAs(ctx, exec, args) {
  const caller = exec?.agent ?? null;
  const source = String(args?.source ?? "").trim();
  const name = String(args?.name ?? "").trim();
  if (!source) return { error: "source 不能为空（成员名 / sessionId / 标题关键字）" };
  if (!name) return { error: "name 不能为空（新成员名，lower-kebab-case）" };

  // ① 源成员
  const found = findTargetAgent(ctx, source, { caller });
  if (found?.error) return { error: `找不到源成员：${found.error}` };
  if (found.sessionId === name) return { error: "新成员名与源成员相同，无需克隆" };

  // 目标会话日志路径要在 spawn 之前确认定位能力可用（否则白建一个成员）
  const { findSessionLogById, sessionsRootOf } = await import("../../sessions/events.js");
  const sourceFile = findSessionLogById(found.sessionId, sessionsRootOf());
  if (!sourceFile) return { error: `源成员会话日志不存在（sessionId=${found.sessionId}）` };

  // ② 能力检查
  const teams = ctx.get("agentTeams");
  if (typeof teams?.spawnTeammate !== "function") return { error: "宿主未挂载 agentTeams.spawnTeammate，无法新建成员" };
  const lead = caller;
  if (!lead) return { error: "拿不到发起方 Agent（请从 Lead 会话调用）" };
  let subagentProvider = String(args?.subagentProvider ?? "").trim();
  if (!subagentProvider) {
    try {
      const list = ctx.get("subagents")?.list?.() ?? [];
      subagentProvider = String(list[0] ?? "");
    } catch { subagentProvider = ""; }
  }
  if (!subagentProvider) return { error: "拿不到子代理 provider（ctx.subagents.list() 为空），可显式传 subagentProvider" };

  // ③ spawn + 中断 + 等空闲
  let spawned;
  try {
    spawned = await teams.spawnTeammate(lead, {
      name,
      description: String(args?.description ?? `克隆自 ${found.member?.name ?? found.sessionId}`),
      prompt: [{ type: "text", text: PLACEHOLDER_PROMPT }],
      context: "fresh",
      provider: subagentProvider,
    });
  } catch (error) {
    return { error: `新建成员失败：${String(error?.message ?? error)}` };
  }
  const newId = spawned?.id ?? spawned?.sessionId ?? null;
  if (!newId) return { error: "新建成员成功但拿不到 sessionId" };

  try {
    if (typeof teams.interrupt === "function") {
      try { await teams.interrupt(lead, name); } catch { /* 可能已结束，继续等 */ }
    }
    const idle = await waitUntilIdle(teams, lead, name, null);
    if (!idle.idle) {
      return { error: `新成员仍在运行（status=${idle.status}），为避免覆盖其内存态，未搬内容；可稍后重试`, newMember: { name, sessionId: newId } };
    }

    // ④ 搬内容
    if (args?.withHistory === false) {
      return { ok: true, newMember: { name, sessionId: newId }, events: 0, note: "已按要求只建空成员，未搬历史" };
    }
    const targetFile = findSessionLogById(newId, sessionsRootOf());
    if (!targetFile) return { error: `新成员会话日志不存在（sessionId=${newId}）`, newMember: { name, sessionId: newId } };

    const moved = await transplantSessionLog(sourceFile, targetFile, {
      seedProvider: String(args?.provider ?? "").trim() || undefined,
      seedModel: String(args?.model ?? "").trim() || undefined,
    });
    if (!moved.ok) return { error: `搬会话内容失败：${moved.error}`, newMember: { name, sessionId: newId } };

    log(ctx, `成员克隆：${found.sessionId} → ${newId}（${moved.events} 事件，${(moved.size / 1048576).toFixed(2)}MB）`);
    return {
      ok: true,
      newMember: { name, sessionId: newId },
      sourceMember: { name: found.member?.name ?? null, sessionId: found.sessionId },
      events: moved.events,
      backup: moved.backup,
      sizeMB: Number((moved.size / 1048576).toFixed(2)),
    };
  } catch (error) {
    return { error: `克隆过程失败：${String(error?.message ?? error)}`, newMember: { name, sessionId: newId } };
  }
}

/**
 * 渲染 clone_member_as 的回执。
 *
 * 要点：① 明确「新成员已建、旧成员未动」，避免误以为旧成员被改名/删除；
 * ② 报出搬了多少事件与多大体积（这是唯一能说明「内容真的搬过去了」的量）；
 * ③ 报出备份路径（搬错可回滚）；④ 失败时连带已建成员一起说明，免得留下孤儿成员。
 *
 * @param {{source?: string, name?: string, withHistory?: boolean}} args 调用参数
 * @param {object} result cloneMemberAs 的返回
 * @returns {string}
 */
export function renderCloneMemberResult(args, result) {
  const lines = [];
  if (result?.error) {
    lines.push(`克隆失败：${result.error}`);
    if (result.newMember?.sessionId) {
      lines.push(`已创建但未搬内容的新成员：${result.newMember.name}(${result.newMember.sessionId})`);
      lines.push("该成员是空壳，可按需删除（delete 或团队面板移除）。");
    }
    return lines.join("\n");
  }
  const nm = result.newMember ?? {};
  lines.push(`已新建成员：${nm.name}(${nm.sessionId})`);
  if (result.sourceMember?.sessionId) {
    lines.push(`内容来源：${result.sourceMember.name ?? "(未命名)"}(${result.sourceMember.sessionId}) — 该成员本身未改动`);
  }
  if (result.note) {
    lines.push(result.note);
  } else {
    lines.push(`搬运事件：${result.events} 条 ｜ 会话体积：${result.sizeMB}MB`);
    lines.push(`回滚备份：${result.backup}`);
  }
  lines.push("");
  lines.push("生效方式：新成员下次被唤醒时按磁盘日志加载（当前是冷会话，此时替换才生效）。");
  lines.push("如需「改名」效果，旧成员可自行删除；名字唯一性由宿主保证，新名不能与现有成员重复。");
  return lines.join("\n");
}
