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
    // timeoutMs 传 0（或负数）= **不设超时**：只适合「本来就慢、但会持续吐数据」的流式接口
    // （会话列表冷缓存要逐份解压上百份日志，实测 41~226 秒；套 30 秒上限必然被中途掐断，
    //  表现为面板刚重启就报「读取会话列表失败」，等缓存建好后重试又正常）。
    // 这类接口的正确判据不是「多久没回完」，而是「有没有在吐数据」，由调用方自己盯流。
    const FETCH_TIMEOUT_MS = 30000;
    window.__scFetch = function (url, opts, timeoutMs) {
      const budget = timeoutMs === void 0 ? FETCH_TIMEOUT_MS : timeoutMs;
      if (!(budget > 0)) return fetch(url, opts || {});
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
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

