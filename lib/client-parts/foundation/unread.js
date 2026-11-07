    // ============================================================
    // 未读 / 已读（客户端侧）：判定公式 + 宿主路由封装
    // ------------------------------------------------------------
    // 契约 merge-contract §3.2 明确：宿主只保存「读到哪个时刻」（entries / allReadAt），
    // **未读布尔由客户端自己按公式算**：
    //     unread(session) === (session.updatedAt ?? 0) > max(entries[id] ?? 0, allReadAt ?? 0)
    // 为什么不把未读状态再存一份 localStorage（源插件 dsh-session-manager 的做法）：
    // 宿主已经把这份状态落盘到 index.json 的 unread section，客户端再存一份必然出现
    // 「两个真相」——重启后一边记得一边忘，多窗口下一边读完另一边圆点还亮着。
    // ============================================================

    const SC_UNREAD_ROUTE = "/api/session-conductor/unread";
    const SC_UNREAD_ALL_ROUTE = "/api/session-conductor/unread/all";

    /** 空快照。GET 失败时回退到它（等价「所有更新过的会话都算未读」），
     *  宁可多亮几个圆点，也不要在接口 500 时把用户真正的未读一次性清空。 */
    const SC_UNREAD_EMPTY = { entries: {}, allReadAt: 0 };

    /**
     * 把宿主返回体收敛成 { entries: { "<sessionId>": readAtMs }, allReadAt: ms }。
     * 脏值（null / NaN / 0 / 负数 / 非对象）一律丢弃，避免一次坏响应把整个界面带崩。
     */
    function scNormalizeUnread(body) {
      const entries = {};
      const raw = body && body.entries && typeof body.entries === "object" ? body.entries : null;
      if (raw) {
        for (const key of Object.keys(raw)) {
          const at = Number(raw[key]);
          if (key !== "" && Number.isFinite(at) && at > 0) entries[key] = at;
        }
      }
      const all = Number(body ? body.allReadAt : 0);
      return { entries, allReadAt: Number.isFinite(all) && all > 0 ? all : 0 };
    }

    /** 某会话的「已读水位」= 个人已读时刻与全部已读时刻的较大者（即契约里的 max(...)）。 */
    function scReadWatermark(unread, sessionId) {
      const state = unread || SC_UNREAD_EMPTY;
      const own = Number(state.entries ? state.entries[sessionId] : 0);
      const all = Number(state.allReadAt);
      const ownAt = Number.isFinite(own) && own > 0 ? own : 0;
      const allAt = Number.isFinite(all) && all > 0 ? all : 0;
      return Math.max(ownAt, allAt);
    }

    /**
     * 未读判定（契约原文实现）。
     * updatedAt 缺失或非数字 → 视为**已读**：宁可漏一个圆点，也不要把脏数据整表点成未读。
     */
    function scIsUnread(unread, session) {
      if (!session || typeof session.id !== "string" || session.id === "") return false;
      const updatedAt = Number(session.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
      return updatedAt > scReadWatermark(unread, session.id);
    }

    /** 未读总数：只统计传入的这份列表（角标不跨 tab 瞎算，与列表里看到的圆点严格一致）。 */
    function scUnreadCount(unread, list) {
      if (!Array.isArray(list)) return 0;
      let count = 0;
      for (const session of list) if (scIsUnread(unread, session)) count += 1;
      return count;
    }

    /** 读一次未读快照。永不 reject：面板在接口 500 / 断网时只退化，不白屏。 */
    function scLoadUnread() {
      return window
        .__scFetch(SC_UNREAD_ROUTE, { headers: { Accept: "application/json" } })
        .then((res) => res.json())
        .then((body) => (body && body.ok === true ? scNormalizeUnread(body) : SC_UNREAD_EMPTY))
        .catch(() => SC_UNREAD_EMPTY);
    }

    /**
     * 写未读状态：resolve 为最新快照；宿主明确返回 ok:false 时 reject，
     * 调用方据此回滚乐观更新并提示（契约 §3 的错误信封 { ok:false, error:{ code, message } }）。
     */
    function scPostUnread(route, payload) {
      return window
        .__scFetch(route, {
          method: "POST",
          headers: { "Content-Type": CONTENT_TYPE_JSON, Accept: "application/json" },
          body: JSON.stringify(payload || {}),
        })
        .then((res) => res.json())
        .then((body) => {
          if (!body || body.ok !== true) {
            const message = body && body.error && body.error.message ? body.error.message : MSG_ACTION_FAILED;
            throw new Error(message);
          }
          return scNormalizeUnread(body);
        });
    }
