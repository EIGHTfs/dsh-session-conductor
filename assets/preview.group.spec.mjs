/**
 * 预览描述：单独挂载「会话分组」设置卡片（settings.plugin.item / key=session-conductor-group）。
 *
 * 【为什么单独一份】默认 spec 挂的是侧边栏面板（sidebar.footer.action），
 * 而 1.4.21 重构动的是分组卡片（CSS 提到模块顶层、组件改为显式接收 react/jsx 参数）。
 * 那份 spec 渲染不到它，这里按 key 精确捕获后挂载，验证重构后的卡片仍能正常渲染。
 */
export default {
  title: "dsh-session-conductor 分组卡片预览",
  post: `
(function () {
  var tries = 0;
  function mount() {
    tries += 1;
    var captured = window.__PREVIEW_CAPTURED__ || [];
    var hit = null;
    for (var i = 0; i < captured.length; i += 1) {
      var def = captured[i].def || {};
      if (def.name !== "settings.plugin.item") continue;
      if (String(def.key || "") !== "session-conductor-group") continue;
      hit = captured[i];
      break;
    }
    if (!hit) {
      if (tries < 80) { setTimeout(mount, 100); return; }
      window.__previewError(new Error("没有捕获到分组卡片（已捕获：" + captured.map(function (x) {
        var d = x.def || {};
        return String(d.name || "?") + "/" + String(d.key || "-");
      }).join(", ") + "）"));
      return;
    }
    var ctx = window.__PREVIEW_CTX__;
    var t = ctx && ctx.locale && typeof ctx.locale.bind === "function"
      ? ctx.locale.bind("sessionGroup")
      : function (k) { return String(k); };
    var injected = {};
    try {
      injected = typeof hit.def.inject === "function" ? (hit.def.inject() || {}) : (hit.def.inject || {});
    } catch (e) { window.__previewError(e); }
    var host = document.createElement("div");
    host.id = "sc-group-host";
    host.style.cssText = "max-width:520px;margin:16px auto;border:1px solid #3a3f4b;border-radius:10px;padding:12px;background:#12141a";
    document.body.appendChild(host);
    try {
      window.ReactDOM.createRoot(host).render(
        window.React.createElement(hit.component, Object.assign({ t: t }, injected))
      );
    } catch (e) { window.__previewError(e); }
  }
  setTimeout(mount, 120);
})();
`,
};
