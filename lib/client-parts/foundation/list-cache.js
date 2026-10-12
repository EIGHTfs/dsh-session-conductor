    const LIST_CACHE_KEY = "dsh-session-conductor:list:v1";
    function readListCache() {
      // 2026-10-12 修复：无缓存 / 缓存损坏时必须回**空数组**，不能回 null。
      // 调用方 SessionManagerPanel 把返回值当数组用（sessions 初值），null 会让
      // 流式追加路径的 insertSorted(null, item) 抛
      // "Cannot read properties of null (reading 'filter')"，React 更新器抛错后
      // sidebar.footer.action 插槽整块崩溃 —— 表现为「会话管理」入口直接消失。
      try {
        const raw = localStorage.getItem(LIST_CACHE_KEY);
        // if (!raw) return null;
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        // return Array.isArray(parsed?.sessions) ? parsed.sessions : null;
        return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      } catch {
        // return null;
        return [];
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
