// dsh-session-conductor — 插件持久化域（全局状态：开关、模型选择、模板元信息）
//
// 【为什么单独成文件】domain schema（90 行）与 open/close 生命周期是插件状态的唯一入口，
// 被列表、续跑、重命名、成员模型切换等多个域读写；抽出后各域只需 import 本模块，
// 不必依赖插件入口（避免循环引用），也让「域已打开/已关闭」的状态只此一份。

import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

/** 插件自身的持久化域：自动重命名/自动续跑开关 + 记账，存于 <DSH_HOME>/storages/dsh-session-conductor.json。
 *  版本保持 1：autoContinue 是纯增量字段（带 default），旧域文件可无损加载。 */
const pluginDomainSpec = defineDomain({
  name: "dsh_session_conductor",
  version: 1,
  global: {
    schema: z.object({
      autoRename: z.record(z.string(), z.object({
        enabled: z.boolean(),
        lastAnalysisSeq: z.number().int().nonnegative().optional(),
        lastAnalysisAt: z.number().nonnegative().optional()
      })).default({}),
      autoContinue: z.record(z.string(), z.object({
        enabled: z.boolean().optional(), // 缺省 = 跟随全局默认 defaultAutoContinue
        lastContinuedSeq: z.number().int().nonnegative().optional(),
        lastContinuedAt: z.number().nonnegative().optional(),
        continueCount: z.number().int().nonnegative().optional()
      })).default({}),
      // ⚠️ ：自动续跑开关与记账已移至 <DSH_HOME>/session-conductor/config.json
      //   （用户流程：控制开关 → 写 config.json → 自动续跑读 config.json；启动时 apply 自动全关）。
      //   上方 autoContinue 字段保留仅为兼容旧域文件（旧数据不再读写，配置以 config.json 为准）。
      // 压缩模型选择：会话模型旁单独选压缩用模型。
      // 取值：{provider, model} 或 null=跟随会话模型。写入后由部署层注入 compaction-basic。
      compactionModel: z.object({
        provider: z.string(),
        model: z.string()
      }).nullable().optional(),
      // 自动重命名模型选择：设置页「DSH 同款解析选择器」选定的模型。
      // 取值：{provider, model} 或 null=跟随会话模型（默认）。优先级：
      //   UI 选择 > patch 配置（autoRenameProvider/Model）> 会话 request/header。
      autoRenameModel: z.object({
        provider: z.string(),
        model: z.string()
      }).nullable().optional(),
      // 自动续跑全局闸门（与 guardian 联动）：
      //   closed → 一切自动续跑跳过（周期扫描/面板 scan 的自动续跑部分均不续）；
      //   open   → 恢复原有判定。DSH 刚启动 guardian 置 closed（防崩溃恢复后自动续跑
      //   批量建空壳会话）；用户手动开启（API/面板）或检测到「用户第一次手动对话」
      //   （turn/start 由 user 发起）后自动置 open。
      autoContinueGate: z.enum(["open", "closed"]).default("open"),
      // 额外 md 注入：设置卡上传的 md 清单（内容落盘 <DSH_HOME>/extra-inject-md/）
      extraMdFiles: z.array(z.object({
        id: z.string(),
        name: z.string(),
        addedAt: z.number().optional()
      })).default([]),
      // 会话模板注入：plan（方案模板）/ closing（收尾模板）两个固定槽位
      // 元信息存 domain，内容落盘 <DSH_HOME>/template-inject-md/<slot>.md
      sessionTemplates: z.object({
        plan: z.object({
          enabled: z.boolean().default(false),
          enforce: z.boolean().default(false), //  强制门禁：未出提案+未确认前拒绝改码工具
          name: z.string().default(""),
          url: z.string().default(""),
          bytes: z.number().default(0),
          updatedAt: z.number().default(0)
        }).default({ enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 }),
        closing: z.object({
          enabled: z.boolean().default(false),
          enforce: z.boolean().default(false),
          name: z.string().default(""),
          url: z.string().default(""),
          bytes: z.number().default(0),
          updatedAt: z.number().default(0)
        }).default({ enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 })
      }).default({ plan: { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 }, closing: { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 } }),
      // 成员模型切换意图（sessionId → {provider, model}）：
      // 切模型随时可做（成员 inactive/未挂载时也能切）——意图持久化在这里，
      // 成员下次 resume/运行时由 resumeSetupFor 应用（优先于会话最近路由）。
      memberModelOverrides: z.record(z.object({
        provider: z.string(),
        model: z.string()
      })).default({})
    }),
    initial: {
      autoRename: {},
      autoContinue: {},
      compactionModel: null,
      autoRenameModel: null,
      autoContinueGate: "open",
      extraMdFiles: [],
      sessionTemplates: {
        plan: { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 },
        closing: { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0 }
      },
      memberModelOverrides: {}
    },
  },
  tables: {}
});

let domainPromise = null;
/** 域当前是否「已打开且尚未关闭」。
 *  用于判断重载时能否复用缓存——只凭 domainPromise 是否为 null 判断不了
 *  「域是活的还是已被关掉」，这正是「domain already open / domain is closed」两类 500 的根源。 */
let domainLive = false;

/**
 * 打开（或复用）插件持久化域。
 * @param {object} ctx 插件上下文
 * @returns {Promise<object>} 域对象；storageDomain 服务缺失时 reject
 */
export function pluginDomain(ctx) {
  if (domainPromise === null) {
    const storage = ctx.get("storageDomain");
    if (!storage) return Promise.reject(new Error("storageDomain 不可用"));
    domainPromise = storage.open(pluginDomainSpec).then((domain) => {
      domainLive = true;
      // 只在 apply 的活跃 fiber 上挂 close；HTTP handler / 事件回调 fiber 是 inactive，
      // ctx.effect 会抛 cannot create effect on inactive context，且 rejected Promise 被缓存后 list 一直 500。
      try {
        ctx.effect(() => () => {
          // 关闭的同时把缓存与存活标记一起清掉——下一次 apply 才会重新 open。
          // 【原代码】只 return domain.close()（缓存不清），靠 apply 开头无条件 domainPromise = null 兜，
          //   遇到「域还活着就重载」时会在旧的活域上再 open 一次 → storage 报 already open → list 500。
          domainLive = false;
          domainPromise = null;
          return domain.close();
        }, "session-conductor: domain close");
      } catch {
        /* 请求路径打开时不挂 effect；apply() 已预热并挂过 */
      }
      return domain;
    }).catch((err) => {
      domainPromise = null;
      domainLive = false;
      throw err;
    });
  }
  return domainPromise;
}

/** 读域里的全局状态对象。 */
export async function pluginState(ctx) {
  const domain = await pluginDomain(ctx);
  return domain.global.get();
}

/** 当前域是否已打开且存活（apply 重载判定用）。 */
export function isDomainLive() {
  return domainLive;
}

/** 测试钩子：清空域缓存（单测在场景之间调用，避免上一条用例的域串到下一条）。 */
export function resetDomainForTest() {
  domainPromise = null;
  domainLive = false;
}
