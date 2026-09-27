    const LIST_CACHE_KEY = "dsh-session-conductor:list:v1";
    function readListCache() {
      try {
        const raw = localStorage.getItem(LIST_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.sessions) ? parsed.sessions : null;
      } catch {
        return null;
      }
    }
    function writeListCache(sessions) {
      try {
        localStorage.setItem(LIST_CACHE_KEY, JSON.stringify({ at: Date.now(), sessions }));
      } catch {
        /* 存储不可用时静默降级 */
      }
    }

    // 「会话管理」入口图标（学 dsh-side-monitor 的 MonitorIcon：内联 SVG + currentColor 线描）
