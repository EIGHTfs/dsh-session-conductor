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
            // 打开会话的入口，按「宿主真实存在的」优先级逐个试：
            //   · ctx.get("uiWorkspace").openSession(id) —— 宿主自己的会话导航服务
            //     （ui-conversation 内部就是 `const nav = ctx.get('uiWorkspace')` 再 nav.openSession(id)；
            //       实测宿主包里根本没有 workspaceNavigation / openSession 这类名字，早期写法是猜的）
            //   · ctx.uiWorkspace.openSession(id) —— 同一服务，仅在本插件声明过依赖时才作为属性可见
            //   · ctx.get("sessions").open(id)    —— 老版本兜底
            // 必须用 ctx.get(...)：cordis 里未在 inject 声明的服务**没有** ctx.<name> 属性，
            // 但 ctx.get(name) 仍能取到 —— 只写 ctx.uiWorkspace 会永远 undefined，点了没反应。
            try {
              const nav = ctx.get?.("uiWorkspace");
              if (typeof nav?.openSession === "function") return nav.openSession(sessionId);
              if (typeof ctx.uiWorkspace?.openSession === "function") return ctx.uiWorkspace.openSession(sessionId);
              const legacy = ctx.get?.("sessions");
              if (typeof legacy?.open === "function") return legacy.open(sessionId);
              // eslint-disable-next-line no-console
              console.warn("[session-conductor] 打不开会话：宿主未暴露 uiWorkspace.openSession / sessions.open", sessionId);
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

