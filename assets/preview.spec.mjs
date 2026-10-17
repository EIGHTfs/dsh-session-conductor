/**
 * 预览描述（dsh-useful-tools 的 `preview` 工具用）。
 *
 * 【为什么需要】默认自动挂载按「设置页 > 插件配置卡 > 侧边栏」优先级只挂**一个**组件，
 * 而会话管理面板注册在 `sidebar.footer.action`，且组件签名是
 * `SessionManagerPanel({ wide, t, onOpenSession })` —— 少了 `t` 直接崩。
 * 这个 spec 在默认垫片之上再挂一次面板，并补上 `t`（取插件自己的语言包），
 * 用来对「筛选 → 自动勾选 → 删除选中」这条链路做**真实点击**验证。
 */
export default {
  title: "dsh-session-conductor 面板预览",
  post: `
(function () {
  var tries = 0;
  function mountPanel() {
    tries += 1;
    var captured = window.__PREVIEW_CAPTURED__ || [];
    var hit = null;
    for (var i = 0; i < captured.length; i += 1) {
      var name = String((captured[i].def && captured[i].def.name) || "");
      if (name === "sidebar.footer.action") { hit = captured[i]; break; }
    }
    if (!hit) {
      if (tries < 80) setTimeout(mountPanel, 100);
      else window.__previewError(new Error("没有捕获到 sidebar.footer.action 组件（已捕获：" + captured.map(function (x) { return (x.def && x.def.name) || "?"; }).join(", ") + "）"));
      return;
    }
    var ctx = window.__PREVIEW_CTX__;
    // t：用插件注册进 locale 的字典（ns = sessionConductor），键名与真机一致
    var t = ctx && ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind("sessionConductor") : function (k) { return String(k); };
    var injected = {};
    try {
      injected = typeof hit.def.inject === "function" ? (hit.def.inject() || {}) : (hit.def.inject || {});
    } catch (e) { window.__previewError(e); }
    var host = document.createElement("div");
    host.id = "sc-panel-host";
    host.style.cssText = "max-width:560px;margin:16px auto;border:1px solid #3a3f4b;border-radius:10px;padding:10px;background:#12141a";
    document.body.appendChild(host);
    var props = Object.assign({ wide: false, t: t }, injected);
    try {
      window.ReactDOM.createRoot(host).render(window.React.createElement(hit.component, props));
    } catch (e) { window.__previewError(e); }
  }
  setTimeout(mountPanel, 120);
})();
`,
};
