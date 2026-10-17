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
            // 打开会话的真实入口随宿主版本不同，按优先级尝试（**不要只认一个**）：
            //   · workspaceNavigation.openSession(id) —— dsh-client-ui-conversation 的用法
            //   · ctx.uiWorkspace.openSession(id)    —— dsh-client-ui-chat 的用法
            //   · sessions.open(id)                  —— 早期路径，保留兜底
            // 以前只写了第三个，而宿主客户端并没有 `sessions` 这个服务 ⇒ 可选链把失败吞成
            // 「点了没反应」，且不报错、难查。所以这里：多个入口都试；全失败要留下痕迹。
            try {
              const nav = ctx.get?.("workspaceNavigation");
              if (typeof nav?.openSession === "function") return nav.openSession(sessionId);
              if (typeof ctx.uiWorkspace?.openSession === "function") return ctx.uiWorkspace.openSession(sessionId);
              const legacy = ctx.get?.("sessions");
              if (typeof legacy?.open === "function") return legacy.open(sessionId);
              // eslint-disable-next-line no-console
              console.warn("[session-conductor] 打不开会话：宿主客户端未暴露 workspaceNavigation/uiWorkspace/sessions 任一入口", sessionId);
            } catch (error) {
              // 打开失败不阻塞面板，但不再静默
              // eslint-disable-next-line no-console
              console.warn("[session-conductor] 打开会话失败:", error);
            }
          },
        }),
      }, SessionManagerPanel));
    }

    exports.apply = apply;
    exports.inject = inject;


/**
 * dsh-session-conductor — 「会话分组」精简卡（裁剪后版本）
 *
 * 分组管理（创建/重命名/删除/移动会话）已移除，回归 DSH 官方 workspace 机制。
 * 本卡只保留：
 *   · 分组列表（GET /api/session-conductor/group/list，只读展示）
 *   · 每行「在分组下新建会话」（POST /api/session-conductor/group/new-session {workspaceId}）
 *   · 「新建会话（上一次使用的工作区）」（new-session 不带 workspaceId = 最近活跃会话 cwd 归属分组）
 */

