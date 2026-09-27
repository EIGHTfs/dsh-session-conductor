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

