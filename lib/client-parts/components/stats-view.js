    // ============================================================
    // 会话统计视图（纯 div 绘制：数字卡片 + 条形图 + 直方图）
    // ------------------------------------------------------------
    // 契约 §3.1 的 GET /stats 返回体里，**所有字段必须存在**（拿不到用 null / []），
    // 所以这里对每个字段都做「非数字 → 显示 —」「空数组 → 空态文案」的降级，
    // 保证索引为空 / 只跑了一半 / 接口 500 三种状态下都不白屏（验收 §5③）。
    // 不用任何图表库：条形就是 div + 百分比宽度（契约 §4 要求）。
    // ============================================================

    /** 字节数 → 人类可读。null / undefined / 非数字 / 负数一律 "—"（契约允许字段为 null）。 */
    function scFormatBytes(bytes) {
      const n = Number(bytes);
      if (bytes === null || bytes === undefined || !Number.isFinite(n) || n < 0) return "—";
      if (n < 1024) return `${n} B`;
      const units = ["KB", "MB", "GB", "TB"];
      let value = n / 1024;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      // 100 以上不留小数：`1023.4 MB` 看着比 `1023 MB` 更假精确
      return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
    }

    /** 数字 → 文本。非数字（含 null）→ "—"，并统一千分位，方便一眼比大小。 */
    function scFormatCount(value) {
      const n = Number(value);
      if (value === null || value === undefined || !Number.isFinite(n)) return "—";
      return n.toLocaleString("en-US");
    }

    /** 百分比（0-100）：分母为 0 时返回 0，避免 NaN% 把条形撑爆或塌成 0。 */
    function scPercent(value, max) {
      const n = Number(value);
      const m = Number(max);
      if (!Number.isFinite(n) || !Number.isFinite(m) || m <= 0) return 0;
      return (n / m) * 100;
    }

    /** 数字卡片：{[label, value] 列表} */
    function ScStatsCards(props) {
      const cards = props.cards;
      return react_jsx_runtime.jsx("div", {
        style: S.statsGrid,
        children: cards.map((card) =>
          react_jsx_runtime.jsxs(
            "div",
            {
              style: S.statCard,
              title: `${card.label}: ${card.value}`,
              children: [
                react_jsx_runtime.jsx("span", { style: S.statValue, children: card.value }),
                react_jsx_runtime.jsx("span", { style: S.statLabel, children: card.label }),
              ],
            },
            card.label,
          ),
        ),
      });
    }

    /** 一组横向条形（标签 + 条 + 数值）：用于「按工作区」与「体积最大」。 */
    function ScStatsBars(props) {
      const rows = props.rows;
      return react_jsx_runtime.jsx("div", {
        children: rows.map((row, index) =>
          react_jsx_runtime.jsxs(
            "div",
            {
              style: S.barRow,
              title: row.tip || `${row.label}: ${row.value}`,
              children: [
                react_jsx_runtime.jsx("span", { style: S.barLabel, children: row.label }),
                react_jsx_runtime.jsx("span", {
                  style: S.barTrack,
                  children: react_jsx_runtime.jsx("div", { style: S.barFill(scPercent(row.raw, props.max)) }),
                }),
                react_jsx_runtime.jsx("span", { style: S.barValue, children: row.value }),
              ],
            },
            `${row.label}-${index}`,
          ),
        ),
      });
    }

    /** 最近 N 天直方图：柱高按当日会话数占最大值缩放；底部只标首尾两天，避免 14 个标签挤成糊。 */
    function ScStatsHistogram(props) {
      const daily = Array.isArray(props.daily) ? props.daily : [];
      if (daily.length === 0) {
        return react_jsx_runtime.jsx("div", { style: S.empty, children: props.emptyText });
      }
      let max = 0;
      for (const day of daily) {
        const count = Number(day && day.count);
        if (Number.isFinite(count) && count > max) max = count;
      }
      const label = (day) => String((day && day.date) || "").slice(5); // YYYY-MM-DD → MM-DD
      return react_jsx_runtime.jsxs(react.Fragment, {
        children: [
          react_jsx_runtime.jsx("div", {
            style: S.histogram,
            children: daily.map((day, index) =>
              react_jsx_runtime.jsx(
                "div",
                {
                  style: S.histoBar(scPercent(day && day.count, max)),
                  title: `${label(day)}: ${scFormatCount(day && day.count)}`,
                },
                `${(day && day.date) || index}`,
              ),
            ),
          }),
          react_jsx_runtime.jsxs("div", {
            style: S.histoAxis,
            children: [
              react_jsx_runtime.jsx("span", { style: { ...S.histoAxisItem, textAlign: "left" }, children: label(daily[0]) }),
              react_jsx_runtime.jsx("span", { style: { ...S.histoAxisItem, textAlign: "right" }, children: label(daily[daily.length - 1]) }),
            ],
          }),
        ],
      });
    }

    /**
     * 统计视图本体。
     * props: { t, stats(可能为 null), busy, error, onRefresh }
     * 三态：error → 错误条 + 重试；stats 为 null → 加载/空态；有数据 → 卡片 + 两个条形区 + 直方图。
     */
    function ScStatsView(props) {
      const t = props.t;
      const stats = props.stats;
      const busy = props.busy === true;

      if (props.error) {
        return react_jsx_runtime.jsxs("div", {
          children: [
            react_jsx_runtime.jsx("div", { style: S.error, children: t("stats.failed", { message: String(props.error) }) }),
            react_jsx_runtime.jsx("div", {
              style: { marginTop: 10 },
              children: react_jsx_runtime.jsx("button", {
                type: "button",
                className: "sc-sc-action",
                style: S.actionBtn(false),
                disabled: busy,
                onClick: () => props.onRefresh && props.onRefresh(),
                children: t("stats.retry"),
              }),
            }),
          ],
        });
      }

      if (!stats) {
        return react_jsx_runtime.jsx("div", { style: S.empty, children: busy ? t("stats.loading") : t("stats.empty") });
      }

      const cards = [
        { label: t("stats.card.total"), value: scFormatCount(stats.total) },
        { label: t("stats.card.live"), value: scFormatCount(stats.live) },
        { label: t("stats.card.running"), value: scFormatCount(stats.running) },
        { label: t("stats.card.archived"), value: scFormatCount(stats.archived) },
        { label: t("stats.card.interrupted"), value: scFormatCount(stats.interrupted) },
        { label: t("stats.card.trashed"), value: scFormatCount(stats.trashed) },
        { label: t("stats.card.bytes"), value: scFormatBytes(stats.totalBytes) },
      ];

      const workspaces = Array.isArray(stats.byWorkspace) ? stats.byWorkspace : [];
      let maxWsCount = 0;
      for (const item of workspaces) {
        const count = Number(item && item.count);
        if (Number.isFinite(count) && count > maxWsCount) maxWsCount = count;
      }
      const wsRows = workspaces.map((item) => ({
        label: (item && item.title) || (item && item.workspaceId) || t("stats.unknown"),
        value: `${scFormatCount(item && item.count)} · ${scFormatBytes(item && item.bytes)}`,
        raw: item && item.count,
      }));

      const largest = Array.isArray(stats.topLargest) ? stats.topLargest : [];
      let maxBytes = 0;
      for (const item of largest) {
        const bytes = Number(item && item.bytes);
        if (Number.isFinite(bytes) && bytes > maxBytes) maxBytes = bytes;
      }
      const largestRows = largest.map((item) => ({
        label: (item && (item.title || item.sessionId)) || t("stats.unknown"),
        value: scFormatBytes(item && item.bytes),
        tip: `${(item && item.sessionId) || ""}`,
        raw: item && item.bytes,
      }));

      const sections = [];
      sections.push({
        title: t("stats.section.workspace"),
        body:
          wsRows.length > 0
            ? react_jsx_runtime.jsx(ScStatsBars, { rows: wsRows, max: maxWsCount })
            : react_jsx_runtime.jsx("div", { style: S.empty, children: t("stats.empty") }),
      });
      sections.push({
        title: t("stats.section.daily"),
        body: react_jsx_runtime.jsx(ScStatsHistogram, { daily: stats.daily, emptyText: t("stats.empty") }),
      });
      sections.push({
        title: t("stats.section.largest"),
        body:
          largestRows.length > 0
            ? react_jsx_runtime.jsx(ScStatsBars, { rows: largestRows, max: maxBytes })
            : react_jsx_runtime.jsx("div", { style: S.empty, children: t("stats.empty") }),
      });

      return react_jsx_runtime.jsxs("div", {
        children: [
          react_jsx_runtime.jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8 },
            children: [
              react_jsx_runtime.jsx("span", { style: { ...S.statsSectionTitle, margin: 0, flex: 1 }, children: t("stats.title") }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "sc-sc-action",
                style: S.actionBtn(false),
                disabled: busy,
                onClick: () => props.onRefresh && props.onRefresh(),
                children: busy ? t("stats.loading") : t("stats.refresh"),
              }),
            ],
          }),
          react_jsx_runtime.jsx(ScStatsCards, { cards: cards }),
          sections.map((section) =>
            react_jsx_runtime.jsxs(
              "div",
              {
                style: S.statsSection,
                children: [
                  react_jsx_runtime.jsx("p", { style: S.statsSectionTitle, children: section.title }),
                  section.body,
                ],
              },
              section.title,
            ),
          ),
        ],
      });
    }
