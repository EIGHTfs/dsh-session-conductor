    function apply(ctx) {
      // 插槽排序（slots 顺序权重，小在前）：设置左侧栏「会话管理」页 vs 侧边栏底部入口
      const SETTINGS_SECTION_ORDER = 40;
      const SIDEBAR_ACTION_ORDER = 90;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-conductor: dictionaries");
      const slots = ctx.get("slots");
      if (slots !== undefined) {
        slots.inject("settings.section", () => slots.register(
          { name: "settings.section", id: "session-conductor", order: SETTINGS_SECTION_ORDER, label: () => trSettings("settings.nav") },
          () => h(ConductorSettingsPage, null),
        ));
      }
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "session-conductor",
        order: SIDEBAR_ACTION_ORDER,
        locale: NS,
        inject: () => ({
          onOpenSession: (sessionId) => {
            try {
              ctx.get("sessions")?.open?.(sessionId);
            } catch {
              // 打开失败不阻塞面板
            }
          },
        }),
      }, SessionManagerPanel));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});


/**
 * dsh-session-conductor — 「会话分组」精简卡（2026-09-26 裁剪后版本）
 *
 * 分组管理（创建/重命名/删除/移动会话）已移除，回归 DSH 官方 workspace 机制。
 * 本卡只保留：
 *   · 分组列表（GET /api/session-conductor/group/list，只读展示）
 *   · 每行「在分组下新建会话」（POST /api/session-conductor/group/new-session {workspaceId}）
 *   · 「新建会话（上次会话工作区）」（new-session 不带 workspaceId = 最近活跃会话 cwd 归属分组）
 */

