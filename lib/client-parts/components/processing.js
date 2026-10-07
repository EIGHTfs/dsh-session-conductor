window.__ModuleLoader__.load({
  id: "dsh-session-conductor-processing",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    const NS = "sessionConductorProcessing";
    const zh = {};
    const en = {};
    __scFillI18nDict("sessionConductorProcessing", zh, en);

    /** 预览文本上限（字符）：提示条只展示开头一段，避免撑高。 */
    const PREVIEW_MAX_CHARS = 120;
    /** 插槽顺序：排在原生排队 dock（order 20）之前，本条显示在排队列表上方。 */
    const DOCK_ORDER = 19;

    // 样式对齐原生 QueueDock（同容器宽度/圆角/row 高度/字体），保证与原生排队列表视觉连体
    const css = `
      .sm-processing-dock { box-sizing: border-box; width: calc(100% - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-dock-inset, 0px) - var(--dsh-composer-dock-inset, 0px)); max-width: calc(var(--dsh-composer-card-max-width, 748px) - var(--dsh-composer-dock-inset, 0px) - var(--dsh-composer-dock-inset, 0px)); margin: 0 auto calc(0px - var(--dsh-composer-stack-gap, 0px) - 3px); padding: 0 var(--dsh-composer-dock-inset, 0px); flex: none; }
      .sm-processing-panel { background: var(--dsw-specific-tip, rgba(128,128,128,.06)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); border-bottom: none; border-radius: 12px 12px 0 0; width: 100%; padding: 2px 0; position: relative; }
      .sm-processing-row { box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 4px 12px; border-radius: 8px; color: var(--dsw-alias-label-primary-dimmed, #c9c9ce); font-family: Inter, var(--dsw-font-family); font-size: 13px; }
      .sm-processing-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: sm-processing-rotate .8s linear infinite; flex: none; }
      .sm-processing-text { min-width: 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
      @keyframes sm-processing-rotate { to { transform: rotate(360deg); } }
    `;
    const styleId = "sm-processing-css";
    if (typeof document !== "undefined" && !document.getElementById(styleId)) {
      const s = document.createElement("style");
      s.id = styleId;
      s.textContent = css;
      document.head.appendChild(s);
    }

    /** 从会话节点里提取当前回合（正在执行）的用户消息文本。 */
    function activeUserText(nodes) {
      if (!Array.isArray(nodes)) return "";
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n === null || n === undefined) continue;
        const kind = n.kind;
        if (kind === "assistant" || kind === "assistant-step" || kind === "tool-result" || kind === "command") break;
        if (kind === "user") {
          const text = typeof n.text === "string" ? n.text
            : Array.isArray(n.content) ? n.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
            : "";
          if (text) return text;
        }
      }
      return "";
    }

    function ProcessingBar({ useSession, t }) {
      const running = useSession((s) => s.running);
      const nodes = useSession((s) => s.nodes);
      const active = react.useMemo(() => activeUserText(nodes), [running, nodes]);
      // 仅当「第一条消息执行中」时显示（执行完自动消失）；排队消息由原生 dock 展示
      if (!running || !active) return null;
      const preview = active.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX_CHARS);
      const label = t("processing") + "：" + preview;
      return react_jsx_runtime.jsx("div", {
        className: "sm-processing-dock",
        children: react_jsx_runtime.jsx("div", {
          className: "sm-processing-panel",
          children: react_jsx_runtime.jsx("div", {
            className: "sm-processing-row",
            title: preview,
            children: [react_jsx_runtime.jsx("span", { className: "sm-processing-spin" }), react_jsx_runtime.jsx("span", { className: "sm-processing-text", children: label })],
          }),
        }),
      });
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "sm-processing: dictionaries");
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
        name: "conversation.input.dock",
        id: "sm-processing",
        order: DOCK_ORDER, // 在原生排队 dock（order 20）之前：第一条条目显示在排队列表上方
        locale: NS,
      }, ProcessingBar));
    }

    const inject = ["slots", "locale"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

/**
 * dsh-session-conductor — 压缩模型选择设置卡片
 * 设置 → 插件配置 → 「压缩模型」：会话模型旁单独选压缩用模型（省 pro 成本）。
 * 可选：跟随会话模型（默认）/ 指定便宜模型（agnes 等）。写入 /api/session-conductor/compaction-model。
 */
