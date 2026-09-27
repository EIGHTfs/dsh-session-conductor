window.__ModuleLoader__.load({
  id: "dsh-session-conductor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // ---------- 文案 ----------

    const NS = "sessionConductor";

    const zh = {};
    const en = {};
    __scFillI18nDict("sessionConductor", zh, en);

    // ---------- 工具 ----------

    // 全局 fetch 超时兜底：DSH API 挂起（重负载/路由未注册）时界面不再无限等待。
    // 与 fetch 同签名（url, opts, timeoutMs），默认 30s；分片统一走 __scFetch。
    const FETCH_TIMEOUT_MS = 30000;
    window.__scFetch = function (url, opts, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
      const next = opts ? Object.assign({}, opts, { signal: controller.signal }) : { signal: controller.signal };
      return fetch(url, next).finally(() => clearTimeout(timer));
    };

    function basenameOf(p) {
      const value = String(p ?? "");
      const cleaned = value.replace(/[/\\]+$/, "");
      const part = cleaned.split(/[/\\]/).pop();
      return part || value;
    }

    function timeAgo(ms, t) {
      if (!Number.isFinite(ms)) return "";
      const diff = Date.now() - ms;
      const minute = 60e3;
      const hour = 3600e3;
      const day = 86400e3;
      const month = 30 * day;
      const year = 365 * day;
      if (diff < minute) return t("meta.time.now");
      if (diff < hour) return t("meta.time.minutes", { n: Math.floor(diff / minute) });
      if (diff < day) return t("meta.time.hours", { n: Math.floor(diff / hour) });
      if (diff < month) return t("meta.time.days", { n: Math.floor(diff / day) });
      if (diff < year) return t("meta.time.months", { n: Math.floor(diff / month) });
      return t("meta.time.years", { n: Math.floor(diff / year) });
    }

