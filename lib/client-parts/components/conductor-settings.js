window.__ModuleLoader__.load({
  id: "dsh-session-conductor-settings",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    const NS = "sessionConductorSettings";
    const zh = {};
    const en = {};
    __scFillI18nDict("sessionConductorSettings", zh, en);

    const css = `
      .scs_page { display:flex; flex-direction:column; gap:16px; }
      .scs_hero { display:flex; flex-direction:column; gap:6px; }
      .scs_title { font-size:20px; font-weight:650; color:var(--dsw-alias-label-primary); }
      .scs_desc { font-size:13px; line-height:1.6; color:var(--dsw-alias-label-tertiary); max-width:72ch; }
      .scs_hint { font-size:11px; line-height:16px; color:var(--dsw-alias-label-tertiary); }
      .scs_card { display:flex; flex-direction:column; gap:12px; padding:16px; border:.5px solid var(--dsw-alias-border-l4); border-radius:16px; background:var(--dsw-alias-bg-layer-3); }
      .scs_cardtitle { font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
      .scs_note { font-size:12px; line-height:1.7; color:var(--dsw-alias-label-secondary); padding:10px 12px; border:1px dashed var(--dsw-alias-border-l2); border-radius:10px; }
    `;
    const styleId = "scs-css";
    if (typeof document !== "undefined" && !document.getElementById(styleId)) {
      const s = document.createElement("style");
      s.id = styleId;
      s.textContent = css;
      document.head.appendChild(s);
    }



    // ── 设置侧边栏页（settings.section，仿 skill-scoreboard）───────────────
    function ScsPage({ t }) {
      return react_jsx_runtime.jsxs("div", { className: "scs_page", children: [
        react_jsx_runtime.jsxs("div", { className: "scs_hero", children: [
          react_jsx_runtime.jsx("div", { className: "scs_title", children: t("title") }),
          react_jsx_runtime.jsx("div", { className: "scs_desc", children: t("desc") }),
          react_jsx_runtime.jsx("div", { className: "scs_hint", children: t("scopeHint") }),
        ] }),
        react_jsx_runtime.jsxs("div", { className: "scs_note", children: [
          react_jsx_runtime.jsx("b", { children: t("noteTitle") + "：" }),
          t("noteBody"),
        ] }),
      ] });
    }

    function apply(ctx) {
      // 设置页只在主入口 dsh-session-conductor 注册。这里再挂 settings.section
      // 会用 jsx-runtime 把页面打成空白。
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-conductor-settings: dictionaries");
    }

    const inject = ["slots", "locale"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
