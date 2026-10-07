    // ---------- UI 常量（主题串 + 尺寸数值）----------
    // 集中命名：同一主题串/尺寸在内联样式与样式表里重复出现，改一处即全站生效。
    const CSS_LABEL_SECONDARY = "var(--dsw-alias-label-secondary, #9a9aa0)";
    const CSS_LABEL_TERTIARY = "var(--dsw-alias-label-tertiary, #77777d)";
    const CSS_LABEL_PRIMARY = "var(--dsw-alias-label-primary, #eee)";
    const CSS_BG_BASE = "var(--dsw-alias-bg-base, #141518)";
    const CSS_BORDER_L2 = "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))";
    const CSS_DANGER = "var(--dsw-state-danger-primary, #d9534f)";
    const CSS_BORDER_HOVER = "1px solid var(--dsw-alias-interactive-bg-hover, #333338)";
    const CONTENT_TYPE_JSON = "application/json";
    const MSG_ACTION_FAILED = "action failed";
    const PADDING_BAR = "8px 12px 0";
    /** 浮层 z-index：压住宿主其它浮层，保证面板在最上。 */
    const OVERLAY_Z_INDEX = 9999;
    /** 触发器行高 / 紧凑行高。 */
    const LINE_HEIGHT_TRIGGER = 1.4;
    const LINE_HEIGHT_COMPACT = 1.35;
    /** 标题字重（半粗）/ 分组标题字重（加粗）/ 表单标签字重。 */
    const FONT_WEIGHT_SEMIBOLD = 600;
    const FONT_WEIGHT_BOLD = 700;
    const LABEL_FONT_WEIGHT = 600;
    /** 顶部状态行最小高度（勾选框与徽章对齐用）。 */
    const ROW_TOP_MIN_HEIGHT = 20;
    /** 胶囊圆角（计数徽章 / 状态徽章共用）：足够大即为胶囊形。 */
    const PILL_RADIUS = 999;
    /** 操作开关之间的间距。 */
    const OPS_TOGGLE_GAP = 14;
    /** 输入控件尺寸：最小宽 / 高 / 圆角。 */
    const CONTROL_MIN_WIDTH = 160;
    const CONTROL_HEIGHT = 28;
    const CONTROL_RADIUS = 6;
    /** 按条件删除表单里的小输入框：天数框宽 / cwd 前缀框最小宽 / 小控件高。 */
    const RULE_DAYS_INPUT_WIDTH = 56;
    const RULE_PREFIX_MIN_WIDTH = 140;
    const SMALL_CONTROL_HEIGHT = 26;
    /** 帮助区描述文字最小宽（与按钮同排时的换行阈值）。 */
    const HELP_DESC_MIN_WIDTH = 180;
    /** 设置页：标签最小宽 / 文本域高度区间 / 两个下拉框宽度。 */
    const LABEL_MIN_WIDTH = 90;
    const TEXTAREA_MIN_HEIGHT = 56;
    const TEXTAREA_MAX_HEIGHT = 340;
    const SELECT_WIDTH_PROVIDER = 170;
    const SELECT_WIDTH_MODEL = 210;
    /** 模板 textarea 行高 / 小字号（列表小字、表单提示共用）。 */
    const LINE_HEIGHT_TEXTAREA = 1.55;
    const LINE_HEIGHT_HELP = 1.65;
    const FONT_SIZE_SMALL = 12.5;
    /** i18n 键：模板槽位简称（plan / closing，多处复用）。 */
    const I18N_TPL_PLAN_SHORT = "tpl.planShort";
    const I18N_TPL_CLOSING_SHORT = "tpl.closingShort";
    /** HTTP 报错前缀：`HTTP 502` 这类状态码提示。 */
    const HTTP_STATUS_PREFIX = "HTTP ";

    // ---------- 样式（主题变量 + 兜底色） ----------
    const S = {
      trigger: (wide) => ({
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: wide ? "6px 10px" : "6px",
        margin: "0 6px 6px",
        borderRadius: 8,
        border: "1px solid transparent",
        background: "transparent",
        color: CSS_LABEL_SECONDARY,
        fontSize: 12,
        lineHeight: LINE_HEIGHT_TRIGGER,
        cursor: "pointer",
        whiteSpace: "nowrap",
        textAlign: "left",
        width: wide ? "auto" : 32,
        justifyContent: wide ? "flex-start" : "center",
      }),
      overlay: { position: "fixed", inset: 0, zIndex: OVERLAY_Z_INDEX },
      backdrop: { position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)" },
      panel: {
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 400,
        maxWidth: "94vw",
        background: "var(--dsw-alias-bg-layer-2, #202024)",
        color: "var(--dsw-alias-label-primary, #ececf0)",
        boxShadow: "-10px 0 32px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
        fontSize: 13,
      },
      header: {
        padding: "14px 16px 10px",
        borderBottom: CSS_BORDER_HOVER,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 8,
      },
      title: { margin: 0, fontSize: 15, fontWeight: FONT_WEIGHT_SEMIBOLD },
      subtitle: { margin: "3px 0 0", fontSize: 12, color: CSS_LABEL_SECONDARY },
      close: {
        background: "transparent",
        border: "none",
        color: CSS_LABEL_SECONDARY,
        fontSize: 16,
        lineHeight: 1,
        cursor: "pointer",
        padding: "2px 6px",
        borderRadius: 6,
      },
      tabs: { display: "flex", gap: 4, padding: "8px 12px 0", borderBottom: CSS_BORDER_HOVER },
      tab: (active) => ({
        background: active ? "var(--dsw-alias-interactive-bg-hover, #333338)" : "transparent",
        border: "none",
        color: active ? "var(--dsw-alias-label-primary, #ececf0)" : CSS_LABEL_SECONDARY,
        padding: "6px 12px",
        borderRadius: "8px 8px 0 0",
        fontSize: FONT_SIZE_SMALL,
        cursor: "pointer",
      }),
      body: { flex: 1, overflowY: "auto", padding: "8px 12px 16px" },
      row: {
        // 会话行改为纵向卡片——顶部状态（checkbox+徽章）/ 中间内容 / 下方操作集中
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 7,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-interactive-bg-hover, #2e2e33)",
        marginTop: 6,
        cursor: "pointer",
      },
      // 顶部状态行：批量勾选 + 状态徽章
      rowTop: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
        minHeight: ROW_TOP_MIN_HEIGHT,
      },
      rowTopBadges: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        flexShrink: 0,
        marginLeft: "auto",
      },
      groupHeader: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 10px 4px",
        marginTop: 10,
        cursor: "pointer",
        userSelect: "none",
        borderBottom: "1px solid var(--dsw-alias-interactive-bg-hover, #2e2e33)",
      },
      groupCaret: { fontSize: 10, color: CSS_LABEL_SECONDARY, flexShrink: 0 },
      groupTitle: { fontWeight: FONT_WEIGHT_BOLD, fontSize: FONT_SIZE_SMALL, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      groupCount: {
        flexShrink: 0,
        fontSize: 10.5,
        padding: "1px 8px",
        borderRadius: PILL_RADIUS,
        border: "1px solid var(--dsw-alias-interactive-bg-hover, #3a3a40)",
        color: CSS_LABEL_SECONDARY,
      },
      groupList: { paddingLeft: 2 },
      rowMain: { flex: 1, minWidth: 0 },
      rowTitle: {
        display: "flex",
        alignItems: "flex-start", // 标题最多 3 行时徽章顶部对齐不被挤压
        gap: 6,
        fontWeight: FONT_WEIGHT_SEMIBOLD,
        fontSize: 13,
        overflow: "hidden",
        lineHeight: LINE_HEIGHT_COMPACT,
      },
      rowMeta: { marginTop: 2, fontSize: 11.5, color: CSS_LABEL_SECONDARY, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      // 第三行小字 session id（等宽小字号，方便复制/排查）
      rowSid: { marginTop: 2, fontSize: 10.5, fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", color: "var(--dsw-alias-label-tertiary, #6f6f76)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", userSelect: "text" },
      badge: (kind) => ({
        flexShrink: 0,
        fontSize: 10.5,
        padding: "1px 7px",
        borderRadius: PILL_RADIUS,
        border: "1px solid",
        ...(kind === "archived"
          ? { color: CSS_LABEL_SECONDARY, borderColor: "#55555c" }
          : kind === "running"
            ? { color: "var(--dsw-state-success-primary, #4caf7d)", borderColor: "currentColor" }
            : { color: CSS_LABEL_TERTIARY, borderColor: "currentColor" }),
      }),
      actions: { flexShrink: 0, display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" },
      actionsCol: { flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 },
      // 下方操作集中区（开关行 + 按钮行，纵向堆叠）
      rowOps: { display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 },
      opsToggles: { display: "flex", alignItems: "center", gap: OPS_TOGGLE_GAP },
      opsButtons: { display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-start" },
      autoToggle: {
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        color: CSS_LABEL_SECONDARY,
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
      },
      actionBtn: (danger) => ({
        background: "transparent",
        border: danger ? "1px solid var(--dsw-state-error-primary, #d9534f)" : "1px solid var(--dsw-alias-interactive-bg-hover, #3a3a40)",
        color: danger ? "var(--dsw-state-error-primary, #d9534f)" : "var(--dsw-alias-label-secondary, #d0d0d6)",
        borderRadius: 6,
        padding: "3px 9px",
        fontSize: 11.5,
        cursor: "pointer",
      }),
      hint: { margin: "10px 0 6px", fontSize: 12, color: CSS_LABEL_SECONDARY },
      helpBlock: {
        marginTop: 10,
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--dsw-alias-interactive-bg-hover, #2a2a30)",
        border: CSS_BORDER_HOVER,
      },
      helpTitle: { fontWeight: FONT_WEIGHT_SEMIBOLD, fontSize: 13, margin: "0 0 4px" },
      helpDesc: { margin: 0, fontSize: FONT_SIZE_SMALL, lineHeight: LINE_HEIGHT_HELP, color: "var(--dsw-alias-label-secondary, #c8c8ce)" },
      empty: { marginTop: 24, textAlign: "center", color: CSS_LABEL_TERTIARY, fontSize: FONT_SIZE_SMALL },
      error: { marginTop: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-state-error-primary, #d9534f)", color: "var(--dsw-state-error-primary, #d9534f)", fontSize: 12 },
    };

    // ---------- 组件 ----------

    // 会话列表长效缓存（localStorage）：插件启动即预取 + 每次刷新落盘，面板重开/页面刷新秒显历史数据
