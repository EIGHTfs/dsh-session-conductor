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

    // 统一 fetch 入口（url, opts, timeoutMs）。**默认不设超时**。
    // 曾经默认 30 秒「兜底」，结果两次把慢但正常的请求掐成失败：
    //   · 会话列表冷缓存要逐份解压上百份日志（实测 41~226 秒）→ 刚重启报「读取会话列表失败」；
    //   · 按条件筛选勾了「低价值」时要逐个会话读事件 → 报「操作失败：signal is aborted…」。
    // 结论：**判定只能按事件驱动**（请求完成 / 失败 / 数据到达），不能靠拍一个秒数上限；
    // 时间阈值一写死，慢就被误读成坏。真要限时，必须由调用方显式传 timeoutMs 并说清依据。
    window.__scFetch = function (url, opts, timeoutMs) {
      if (!(timeoutMs > 0)) return fetch(url, opts || {});
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const next = opts ? Object.assign({}, opts, { signal: controller.signal }) : { signal: controller.signal };
      return fetch(url, next).finally(() => clearTimeout(timer));
    };

    function basenameOf(p) {
      const rawPath = String(p ?? "");
      const cleaned = rawPath.replace(/[/\\]+$/, "");
      const part = cleaned.split(/[/\\]/).pop();
      return part || rawPath;
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

