window.__ModuleLoader__.load({
  id: "dsh-session-conductor-compaction-model",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    const NS = "sessionConductorCompaction";
    const zh = {};
    const en = {};
    __scFillI18nDict("sessionConductorCompaction", zh, en);

    const css = `
      .cm_card { border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); border-radius:10px; padding:12px; margin-top:8px; background:var(--dsw-alias-bg-base,#141518); }
      .cm_hint { color:var(--dsw-alias-label-tertiary,#888); font-size:12px; margin:2px 0 10px; line-height:1.5; }
      .cm_row { display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap; }
      .cm_input { height:28px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3)); background:var(--dsw-alias-bg-base,#141518); color:var(--dsw-alias-label-primary,#eee); padding:0 10px; font-size:12.5px; }
      .cm_btn { height:28px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3)); background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15)); color:var(--dsw-alias-label-primary,#eee); cursor:pointer; padding:0 14px; font-size:12.5px; }
      .cm_btn:hover { background:rgba(128,128,128,.25); }
      .cm_msg { font-size:12px; margin-top:6px; }
    `;
    const styleId = "sm-compaction-css";
    if (typeof document !== "undefined" && !document.getElementById(styleId)) {
      const s = document.createElement("style");
      s.id = styleId;
      s.textContent = css;
      document.head.appendChild(s);
    }

    function CompactionModelCard({ t }) {
      const [mode, setMode] = react.useState("follow"); // follow | custom
      const [provider, setProvider] = react.useState("llm-pi-ai");
      const [model, setModel] = react.useState("agnes-2.5-flash");
      const [msg, setMsg] = react.useState(null);
      const [busy, setBusy] = react.useState(false);

      react.useEffect(() => {
        (async () => {
          try {
            const r = await window.__scFetch("/api/session-conductor/compaction-model", { headers: { accept: "application/json" } });
            const d = await r.json();
            if (d?.ok && d.compactionModel) {
              setMode("custom");
              setProvider(d.compactionModel.provider || "");
              setModel(d.compactionModel.model || "");
            } else if (d?.ok) setMode("follow");
          } catch { /* 初始加载失败忽略 */ }
        })();
      }, []);

      const save = async () => {
        setBusy(true); setMsg(null);
        try {
          const body = mode === "follow"
            ? { follow: true }
            : { provider, model };
          const r = await window.__scFetch("/api/session-conductor/compaction-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const d = await r.json();
          setMsg(d?.ok ? t("saved") : (d?.error?.message || t("error")));
        } catch { setMsg(t("error")); }
        setBusy(false);
      };

      return react_jsx_runtime.jsxs("div", { className: "cm_card", children: [
        react_jsx_runtime.jsx("div", { className: "cm_hint", children: t("desc") }),
        react_jsx_runtime.jsxs("div", { className: "cm_row", children: [
          react_jsx_runtime.jsx("label", { children: react_jsx_runtime.jsx("input", { type: "radio", name: "cm-mode", checked: mode === "follow", onChange: () => setMode("follow") }) }),
          react_jsx_runtime.jsx("span", { children: t("follow") }),
          react_jsx_runtime.jsx("label", { children: react_jsx_runtime.jsx("input", { type: "radio", name: "cm-mode", checked: mode === "custom", onChange: () => setMode("custom") }) }),
          react_jsx_runtime.jsx("span", { children: t("custom") }),
        ]}),
        mode === "custom" && react_jsx_runtime.jsxs("div", { className: "cm_row", children: [
          react_jsx_runtime.jsx("span", { children: t("provider") }),
          react_jsx_runtime.jsx("input", { className: "cm_input", value: provider, onChange: (e) => setProvider(e.target.value), style: { width: 110 } }),
          react_jsx_runtime.jsx("span", { children: t("model") }),
          react_jsx_runtime.jsx("input", { className: "cm_input", value: model, onChange: (e) => setModel(e.target.value), style: { width: 160 } }),
        ]}),
        mode === "follow" && react_jsx_runtime.jsx("div", { className: "cm_hint", children: t("followNote") }),
        react_jsx_runtime.jsxs("div", { className: "cm_row", children: [
          react_jsx_runtime.jsx("button", { className: "cm_btn", disabled: busy, onClick: save, children: t("save") }),
          msg && react_jsx_runtime.jsx("span", { className: "cm_msg", children: msg }),
        ]}),
      ]});
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-session-conductor-compaction-model: dictionaries");
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: "session-conductor-compaction",
        locale: NS,
      }, function WrappedCard(props) {
        const t = ctx.locale.bind(NS);
        return react_jsx_runtime.jsxs("div", { children: [
          react_jsx_runtime.jsx("div", { children: t("title") }),
          react_jsx_runtime.jsx(CompactionModelCard, { t }),
        ] });
      }));
    }

    const inject = ["slots", "locale"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
/**
 * dsh-session-conductor — 「会话管理」设置侧边栏页（v1.25.0 新增）
 *
 * 注册 settings.section 侧边栏导航（设置左栏出现「会话管理」条目），
 * 点开是完整聚合页——会话管理说明 + 模板注入。
 * UI 组件 scs_* = 页面级。
 */

