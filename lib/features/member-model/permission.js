// dsh-session-conductor — 成员（子代理）权限预设的查看与切换
//
// 【这个文件解决什么】子代理会话在界面上无法手动切换权限预设（只有主会话能切），
// 一旦它的 `permission/preset` 指向一个当前不可用的预设，该成员就会永久唤不醒：
// 宿主 permission-presets 的 pinInitialPermission() 在会话发布前校验
//   if (preset === 'auto' && autoAdmit === undefined) throw new Error('cannot restore preset "auto" without its active integration')
// 而 subagent 的 coldResume() 把这个异常统一包成 `subagent/not-resumable`，
// 报错文本完全指不到权限预设这一层。因此需要一条「不依赖界面、直接落到会话日志」的通道。
//
// 【为什么是追加事件而不是改历史】权限三个旋钮（preset / sandbox / approval）在宿主里是**折叠**语义，
// 宿主明确保证「The LAST such event is the session's override」。所以追加一条 `permission/preset`
// 就能让新值生效，已有事件一条不动、可删尾部帧回滚。
//
// 【为什么只写 preset 一条】切换预设时宿主自己会按 spec 补齐 sandbox / approval（见其 apply()）。
// 这里不重复写：若目标预设的 sandbox/approval 与会话现值不同，回执会明确提示「需要宿主侧补齐」，
// 避免我们自己造出「preset 与 knobs 不一致」的标签失配。
import { log } from "../../shared/log.js";
import { findTargetAgent, collectTeamMembers } from "./locate.js";

/** 读会话日志路径（按 sessionId 定位，与切换模型链路同一套定位）。 */
async function locateLog(sessionId) {
  const { findSessionLogById, sessionsRootOf } = await import("../../sessions/events.js");
  const filePath = findSessionLogById(sessionId, sessionsRootOf());
  return filePath ?? null;
}

/**
 * 折叠读成员当前的权限状态（只看最后一条同类事件，与宿主折叠语义一致）。
 *
 * @param {string} sessionId 成员会话 id
 * @returns {Promise<{preset: string|null, sandbox: string|null, approval: string|null, lastSeq: number, error?: string}>}
 */
export async function readMemberPermission(sessionId) {
  const filePath = await locateLog(sessionId);
  if (!filePath) return { preset: null, sandbox: null, approval: null, lastSeq: -1, error: "会话日志不存在" };
  const { readFile } = await import("node:fs/promises");
  const { decodeAllFrames } = await import("../../zstd-frames.js");
  let text;
  try {
    text = await decodeAllFrames(await readFile(filePath));
  } catch (error) {
    return { preset: null, sandbox: null, approval: null, lastSeq: -1, error: `日志解码失败：${String(error?.message ?? error)}` };
  }
  let preset = null;
  let sandbox = null;
  let approval = null;
  let lastSeq = -1;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.seq === "number" && e.seq > lastSeq) lastSeq = e.seq;
    if (e.type === "permission/preset") preset = e.data?.preset ?? null;
    else if (e.type === "sandbox/mode") sandbox = e.data?.mode ?? null;
    else if (e.type === "approval/policy") approval = e.data?.policy ?? null;
  }
  return { preset, sandbox, approval, lastSeq };
}

/**
 * 读宿主当前可选的预设目录（用于校验，避免把会话写成宿主无法恢复的值）。
 *
 * @param {object} ctx 插件 context
 * @returns {Promise<{names: string[], defaults: string[], defaultPreset: string|null, specs: Map<string, {sandbox?: string, approval?: string}>} | {error: string}>}
 */
export async function readPresetCatalog(ctx) {
  const service = ctx.get?.("permissionPresets") ?? null;
  if (!service || typeof service.catalog !== "function") {
    return { error: "拿不到 permissionPresets.catalog（宿主未挂载该服务），无法校验预设名" };
  }
  let catalog;
  try {
    catalog = await service.catalog();
  } catch (error) {
    return { error: `读取预设目录失败：${String(error?.message ?? error)}` };
  }
  const options = Array.isArray(catalog?.options) ? catalog.options : [];
  const names = options.map((o) => String(o?.name ?? o?.id ?? "")).filter(Boolean);
  const specs = new Map();
  for (const option of options) {
    const name = String(option?.name ?? option?.id ?? "");
    if (!name) continue;
    specs.set(name, { sandbox: option?.sandbox, approval: option?.approval });
  }
  return {
    names,
    defaults: Array.isArray(catalog?.defaultOptions) ? catalog.defaultOptions.map((o) => String(o?.name ?? "")) : [],
    defaultPreset: catalog?.defaultPreset ?? null,
    specs,
  };
}

/**
 * 把成员的权限预设切到目标值。
 *
 * 实现：定位会话日志 → 折叠读当前状态 → 校验预设名在宿主目录里 → 追加一条
 * `permission/preset`（独立 zstd 帧、带 checksum、长度 CAS、fsync）→ 写后复核。
 *
 * @param {object} ctx 插件 context
 * @param {string} sessionId 成员会话 id
 * @param {string} preset 目标预设名
 * @returns {Promise<{ok: true, from: string|null, to: string, seq: number, knobs: object, note?: string} | {error: string}>}
 */
export async function switchMemberPermission(ctx, sessionId, preset) {
  const target = String(preset ?? "").trim();
  if (!target) return { error: "预设名不能为空" };

  const catalog = await readPresetCatalog(ctx);
  if (catalog.error) return { error: catalog.error };
  if (!catalog.names.includes(target)) {
    // 明确点出 auto 的特殊性：它只有在「自动审查集成」挂载时才可选，
    // 否则写进去会让该会话下次发布时直接抛错（表现为唤不醒）。
    const hint = target === "auto"
      ? "；注意 auto 只有在「自动审查」集成启用时才可用，写入后一旦关闭该功能，该会话就会唤不醒"
      : "";
    return { error: `预设 "${target}" 不在当前可选列表里（可选：${catalog.names.join(" / ")}）${hint}` };
  }

  const before = await readMemberPermission(sessionId);
  if (before.error) return { error: before.error };
  if (before.preset === target) {
    return { ok: true, from: before.preset, to: target, seq: before.lastSeq, knobs: { sandbox: before.sandbox, approval: before.approval }, note: "已经是该预设，无需重复写入" };
  }

  const filePath = await locateLog(sessionId);
  if (!filePath) return { error: "会话日志不存在" };
  const { appendEventFrame } = await import("../../sessions/tail-io.js");
  const written = await appendEventFrame(filePath, {
    type: "permission/preset",
    seq: before.lastSeq + 1,
    time: Date.now(),
    data: { preset: target },
  });
  if (!written.ok) return { error: `写入会话日志失败：${written.error}` };

  // 写后复核：确认最后一条 preset 已生效（折叠语义下这就是当前值）
  const after = await readMemberPermission(sessionId);
  if (after.error) return { error: `写入后复核失败：${after.error}` };
  if (after.preset !== target) return { error: `写入后复核不一致（期望 ${target}，实际 ${after.preset}）` };

  // 预设有配套的 sandbox/approval 时给出提示：我们只写 preset，旋钮由宿主在下次加载时按 spec 补齐
  const spec = catalog.specs.get(target);
  let note;
  if (spec && (spec.sandbox !== undefined || spec.approval !== undefined)) {
    const mismatch = [];
    if (spec.sandbox !== undefined && before.sandbox !== null && spec.sandbox !== before.sandbox) {
      mismatch.push(`sandbox ${before.sandbox} → ${spec.sandbox}`);
    }
    if (spec.approval !== undefined && before.approval !== null && spec.approval !== before.approval) {
      mismatch.push(`approval ${before.approval} → ${spec.approval}`);
    }
    if (mismatch.length > 0) {
      note = `该预设自带 ${mismatch.join("、")}；本工具只写 preset 事件，旋钮需宿主加载时补齐（若界面显示与实际不一致，属预期）`;
    }
  }
  log(ctx, `权限切换：${sessionId} preset ${before.preset} → ${target}（seq ${written.seq}）`);
  return { ok: true, from: before.preset, to: target, seq: written.seq, knobs: { sandbox: before.sandbox, approval: before.approval }, note };
}

/** 成员标签（有名字就带上，便于人读）。 */
function memberLabel(found) {
  const name = found?.member?.name;
  return name ? `${name}(${found.sessionId})` : String(found?.sessionId ?? "?");
}

/**
 * 渲染单个成员的权限快照（供工具与指令共用）。
 *
 * @param {object} found findTargetAgent 的返回值
 * @returns {Promise<string[]>} 多行文本
 */
export async function describeMemberPermission(found) {
  const state = await readMemberPermission(found.sessionId);
  if (state.error) return [`成员 ${memberLabel(found)}`, `  读取失败：${state.error}`];
  return [
    `成员 ${memberLabel(found)}`,
    `  权限预设：${state.preset ?? "(未记录)"}`,
    `  sandbox：${state.sandbox ?? "(未记录)"} ｜ approval：${state.approval ?? "(未记录)"}`,
    `  末 seq：${state.lastSeq}`,
  ];
}

/** 列出全部成员及其权限预设（指令无参形态）。 */
export async function renderMemberPermissionList(ctx, invocation) {
  const members = collectTeamMembers(ctx, { caller: invocation?.agent ?? null });
  if (members.length === 0) return "没读到任何成员。可能当前不是 Team 成员、名册不可用，或确实还没有队友。";
  const catalog = await readPresetCatalog(ctx);
  const lines = [`成员权限预设（共 ${members.length} 个）`, ""];
  for (const m of members) {
    const state = await readMemberPermission(m.sessionId);
    const name = m.name ? `${m.name}(${m.sessionId})` : m.sessionId;
    const warn = state.preset === "auto" && !catalog.error && !catalog.names.includes("auto")
      ? "  ⚠️ auto 当前不可用（自动审查未启用），该成员可能唤不醒"
      : "";
    lines.push(`  ${name}：${state.preset ?? "(未记录)"}${warn}`);
  }
  lines.push("");
  if (catalog.error) lines.push(`可选预设：${catalog.error}`);
  else lines.push(`可选预设：${catalog.names.join(" / ")}`);
  lines.push("");
  lines.push("切换：/perm-switch <成员名或 sessionId> <预设名>");
  return lines.join("\n");
}

/** 解析「成员 + 预设」两个参数（预设名不含斜杠，直接取剩余文本）。 */
export function parsePermissionArgs(rawInput) {
  const raw = String(rawInput ?? "").trim();
  if (raw === "") return { parts: [] };
  const parts = raw.split(/\s+/).filter(Boolean);
  return { parts };
}

export { findTargetAgent };
