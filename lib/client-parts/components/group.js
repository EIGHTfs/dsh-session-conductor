/**
 * 分组卡片的样式：一次性注入到 document.head（按 styleId 去重，重载不重复插）。
 * 提到模块顶层是因为它只是静态文本，放在 factory 里会把装配函数撑长。
 */
const SG_CSS = `
  .sg2_card { display:flex; flex-direction:column; gap:10px; }
  .sg2_row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .sg2_btn { cursor:pointer; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); background:var(--dsw-specific-tip, transparent); color:var(--dsw-alias-label-secondary, inherit); border-radius:8px; height:28px; padding:0 12px; font-size:12px; line-height:26px; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
  .sg2_btn:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); }
  .sg2_btn:disabled { opacity:.45; cursor:default; }
  .sg2_hint { color:var(--dsw-alias-label-tertiary, #888); font-size:11px; line-height:16px; }
  .sg2_listTitle { font-size:12px; color:var(--dsw-alias-label-secondary, inherit); margin-top:4px; }
  .sg2_item { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px; font-size:12px; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); }
  .sg2_item .sg2_name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sg2_item .sg2_meta { color:var(--dsw-alias-label-tertiary, #888); font-size:11px; flex:none; }
  .sg2_msg { font-size:12px; line-height:18px; }
  .sg2_msg.err { color:var(--dsw-state-error-primary, #d9534f); }
  .sg2_msg.ok { color:var(--dsw-state-success-primary, #4caf50); }
`;

const SG_STYLE_ID = "dsh-session-group-css";

/** 注入样式表（宿主没有 document 时静默跳过，SSR/测试环境不炸）。 */
function injectGroupStyles() {
  if (typeof document === "undefined" || document.getElementById(SG_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SG_STYLE_ID;
  style.textContent = SG_CSS;
  document.head.appendChild(style);
}

function SessionGroupCard({ react, jsx, t }) {
const [workspaces, setWorkspaces] = react.useState(null);
const [busy, setBusy] = react.useState(false);
const [msg, setMsg] = react.useState(null);
const load = () => {
  window.__scFetch("/api/session-conductor/group/list").then((r) => r.json()).then((b) => {
    if (b.ok) setWorkspaces(b.workspaces ?? []);
  }).catch(() => setWorkspaces([]));
};
react.useEffect(() => { load(); }, []);
const createIn = async (workspaceId) => {
  if (busy) return;
  setBusy(true); setMsg(null);
  try {
    const r = await window.__scFetch("/api/session-conductor/group/new-session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(workspaceId ? { workspaceId } : {}),
    });
    const b = await r.json();
    if (!b.ok) throw new Error(b.error || ("HTTP " + r.status));
    setMsg({ kind: "ok", text: t("ok") });
    load();
  } catch (e) {
    setMsg({ kind: "err", text: t("fail", { message: (e && e.message) || String(e) }) });
  } finally { setBusy(false); }
};
return jsx.jsxs("div", { className: "sg2_card", children: [
  jsx.jsx("div", { className: "sg2_hint", children: t("desc") }),
  jsx.jsxs("div", { className: "sg2_row", children: [
    jsx.jsx("button", { className: "sg2_btn", disabled: busy, onClick: () => createIn(""), children: busy ? t("busy") : t("newDefault") }),
    jsx.jsx("button", { className: "sg2_btn", disabled: busy, onClick: load, children: t("refresh") }),
  ] }),
  jsx.jsx("div", { className: "sg2_listTitle", children: t("listTitle") }),
  !workspaces
    ? jsx.jsx("div", { className: "sg2_hint", children: t("listEmpty") })
    : workspaces.map((w) => jsx.jsxs("div", { className: "sg2_item", key: w.workspaceId, children: [
    jsx.jsx("span", { className: "sg2_name", children: w.title || w.path }),
    jsx.jsx("span", { className: "sg2_meta", children: __SC_TR__("sessionCount", { n: w.sessionIds?.length ?? 0 }) }),
    jsx.jsx("button", { className: "sg2_btn", disabled: busy, onClick: () => createIn(w.workspaceId), children: busy ? t("busy") : t("newIn") }),
  ] })),
  msg && jsx.jsx("div", { className: "sg2_msg " + (msg.kind === "err" ? "err" : "ok"), children: msg.text }),
] });
  }


window.__ModuleLoader__.load({
  id: "dsh-session-conductor-group",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    const NS = "sessionGroup";
    const zh = {};
    const en = {};
    __scFillI18nDict("sessionGroup", zh, en);
    injectGroupStyles();

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-session-group: dictionaries");
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: "session-conductor-group",
        locale: NS,
      }, function WrappedCard(props) {
        const t = ctx.locale.bind(NS);
        return react_jsx_runtime.jsxs("div", { children: [
          react_jsx_runtime.jsx("div", { children: t("title") }),
          react_jsx_runtime.jsx(SessionGroupCard, { react, jsx: react_jsx_runtime, t }),
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
 * dsh-session-conductor — 「第一条正在处理」队列条目（client 附加模块， 改写）
 *
 * DSH 原生排队逻辑：第一条消息（claimed）立即执行、从 host inbox 移除，因此
 * 原生排队 dock 只显示「后续排队消息」，执行中的第一条不可见。
 * 本模块在原生 dock 区域**上方**渲染一条与原生 QueueDock 同风格的条目：
 * 「⚙️ {第一条消息摘要}」——第一条也显示在排队列表里，回合结束（执行完）自动消失。
 * 排队消息列表仍由原生 dock 负责（不重复渲染）。不改 DSH 原生源码。
 */

