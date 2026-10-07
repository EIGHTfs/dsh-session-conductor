/** 插件设置命名空间与设置 schema。 */

import Schema from "@deepseek-ai/schemastery";

/** 设置 → 插件 → 插件配置 卡片命名空间（须与客户端 settings.plugin.item 的 key 一致）。 */
export const CONDUCTOR_SETTINGS_NS = {
  group: "session-conductor-group",
  compaction: "session-conductor-compaction",
};

/** 占位 schema：让 Host 把命名空间列入插件配置页；实际读写仍走 /api/session-conductor/*。 */
export const PresenceSchema = Schema.object({
  present: Schema.boolean().default(true),
});
