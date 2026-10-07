    function SessionManagerPanel({ wide, t, onOpenSession }) {
      const [open, setOpen] = react.useState(false);
      const [tab, setTab] = react.useState("all");
      const [sessions, setSessions] = react.useState(() => readListCache()); // 启动即从长效缓存加载
      const [groups, setGroups] = react.useState(null); // workspaces[]（group/list）；null = host 无分组 API
      const [collapsed, setCollapsed] = react.useState(() => new Set()); // 折叠的分组（含 "__ungrouped__"）
      const [error, setError] = react.useState(null);
      const [busy, setBusy] = react.useState(null);
      // —— 搜索 + 批量/按条件删除 ——
      const [query, setQuery] = react.useState(""); // 列表过滤关键词
      const [selected, setSelected] = react.useState(() => new Set()); // 批量删除勾选
      const [fullResults, setFullResults] = react.useState(null); // 全文搜索结果（null=未搜索）
      const [fullSearching, setFullSearching] = react.useState(false);
      const [ruleOpen, setRuleOpen] = react.useState(false); // 按条件删除表单展开
      const [ruleArchivedOnly, setRuleArchivedOnly] = react.useState(true);
      const [ruleDays, setRuleDays] = react.useState(7);
      const [rulePrefix, setRulePrefix] = react.useState("");
      const [ruleLowValue, setRuleLowValue] = react.useState(false); // 低价值筛选（复用价值分析）
      const [rulePreview, setRulePreview] = react.useState(null); // dryRun 预览（null=未预览）

      // list 流式——NDJSON 每行一个会话，读到立即追加显示（每获取一个追加一个，
      // 不等全部）；按 updatedAt 倒序插入保持列表顺序；旧一次性 JSON（预览页离线垫片/
      // 缓存路径）走 setSessions 全量。
      const insertSorted = (cur, item) => {
        const next = cur.filter((x) => x.id !== item.id);
        let i = 0;
        while (i < next.length && (next[i].updatedAt ?? 0) > (item.updatedAt ?? 0)) i += 1;
        next.splice(i, 0, item);
        return next;
      };
      const refresh = react.useCallback(async () => {
        try {
          const listPromise = window.__scFetch("/api/session-conductor/list", { headers: { Accept: "application/x-ndjson" } });
          const groupPromise = window.__scFetch("/api/session-conductor/group/list")
            .then((r) => (r.ok ? r.json() : { ok: false })).catch(() => ({ ok: false }));
          const listRes = await listPromise;
          if (!listRes.ok) throw new Error("list failed: HTTP " + listRes.status);
          let lastBatch = null;
          if (typeof listRes.body?.getReader === "function") {
            // 流式 NDJSON：逐行解析追加
            const reader = listRes.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            const batch = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let nl;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let parsedLine;
                try { parsedLine = JSON.parse(line); } catch { continue; } // 半行/头行跳过
                if (parsedLine && parsedLine.id) {
                  batch.push(parsedLine);
                  setSessions((cur) => insertSorted(cur, parsedLine)); // 每获取一个追加一个
                }
              }
            }
            lastBatch = batch;
          } else {
            const body = await listRes.json();
            if (!body.ok) throw new Error(body.error?.message ?? "list failed");
            setSessions(body.sessions ?? []);
            lastBatch = body.sessions ?? [];
          }
          if (lastBatch !== null) writeListCache(lastBatch); // 长效保存：刷新结果落 localStorage
          const groupRes = await groupPromise;
          setGroups(groupRes?.ok === true ? groupRes.workspaces ?? [] : null);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      // 启动即自动加载（插件挂载就预取一次，不依赖面板打开）；打开面板时再刷新一次保证最新
      react.useEffect(() => {
        refresh();
      }, [refresh]);
      react.useEffect(() => {
        if (open) refresh();
      }, [open, refresh]);

      // 通用会话操作（archive/unarchive/delete）：乐观更新——点了立即改 UI，后端异步处理，
      // 失败回滚 + 提示；不阻塞其他会话的操作（不设全局 busy）。
      const act = async (sessionId, action) => {
        let prev = null;
        setSessions((cur) => {
          prev = cur.find((s) => s.id === sessionId) ?? null;
          if (action === "delete") return cur.filter((s) => s.id !== sessionId);
          if (action === "archive" || action === "unarchive") {
            return cur.map((s) => (s.id === sessionId ? { ...s, archived: action === "archive" } : s));
          }
          return cur;
        });
        try {
          const res = await window.__scFetch(`/api/session-conductor/${action}`, {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionId }),
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? MSG_ACTION_FAILED);
          await refresh();
        } catch (cause) {
          // 回滚乐观更新
          if (prev) {
            setSessions((cur) => {
              if (action === "delete") return cur.some((s) => s.id === sessionId) ? cur : [...cur, prev];
              return cur.map((s) => (s.id === sessionId ? prev : s));
            });
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        }
      };

      const confirmDelete = (session) => {
        const label = session.title || session.cwd || session.id;
        const yes = window.confirm(`${t("confirm.delete.title", { title: label })}\n\n${t("confirm.delete.body")}`);
        if (yes) act(session.id, "delete");
      };

      //  撤回最后一条消息：dryRun 先预览 → 二次确认 → 执行 → 刷新
      const undoLast = async (session) => {
        setBusy(session.id);
        try {
          const res = await window.__scFetch("/api/session-conductor/undo-message", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionId: session.id, dryRun: true }),
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? "preview failed");
          const preview = body.preview || t("undo.preview.empty");
          const yes = window.confirm(`${t("confirm.undo.title")}\n\n${t("confirm.undo.body", { preview })}`);
          if (!yes) return;
          const res2 = await window.__scFetch("/api/session-conductor/undo-message", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionId: session.id }),
          });
          const body2 = await res2.json();
          if (!body2.ok) throw new Error(body2.error?.message ?? "undo failed");
          window.alert(t("undo.done", { preview }));
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      // 自动重命名开关：乐观翻转（点了立即变），后端异步处理，失败回滚；不阻塞其他操作。
      const toggleAutoRename = async (sessionId, enabled) => {
        setSessions((cur) => cur.map((s) => (s.id === sessionId ? { ...s, autoRename: enabled } : s)));
        try {
          const res = await window.__scFetch("/api/session-conductor/auto-rename", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionId, enabled }),
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? MSG_ACTION_FAILED);
          // 开启时后端立即分析，若已改名（analyzed.after）→ 马上用新标题重显示，
          // 不等 refresh 全量冷扫描（可能数秒~数十秒）
          if (enabled && body.analyzed?.ok && typeof body.analyzed?.after === "string" && body.analyzed.after !== "") {
            setSessions((cur) => cur.map((s) => (s.id === sessionId ? { ...s, title: body.analyzed.after } : s)));
          }
          await refresh();
        } catch (cause) {
          setSessions((cur) => cur.map((s) => (s.id === sessionId ? { ...s, autoRename: !enabled } : s)));
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        }
      };

      const analyzeNow = async (sessionId) => {
        setBusy(sessionId);
        try {
          const res = await window.__scFetch("/api/session-conductor/analyze", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionId }),
          });
          const body = await res.json();
          if (!body.ok) {
            const message = body.error?.message ?? MSG_ACTION_FAILED;
            window.alert(`${t("action.analyze")}: ${message}`);
          } else {
            window.alert(body.renamed ? `${t("action.analyze")}: ${body.reason} → ${body.title}` : `${t("action.analyze")}: ${body.reason}`);
          }
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      /** 扫描并修复损坏会话日志（先 dry-run 扫描，确认后真正修复）。 */
      const scanAndRepair = async () => {
        if (busy) return;
        setBusy("__repair__");
        try {
          const scanRes = await window.__scFetch("/api/session-conductor/repair-sessions", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ dryRun: true }),
          });
          const scan = await scanRes.json();
          if (!scan.ok) throw new Error(scan.error?.message ?? "scan failed");
          const corrupt = scan.report?.corrupt ?? 0;
          const msg = corrupt === 0
            ? t("repair.scanClean")
            : t("repair.confirm", { n: corrupt });
          if (corrupt > 0 && !window.confirm(msg)) { setBusy(null); return; }
          if (corrupt === 0) { window.alert(msg); setBusy(null); return; }
          const fixRes = await window.__scFetch("/api/session-conductor/repair-sessions", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ dryRun: false }),
          });
          const fix = await fixRes.json();
          if (!fix.ok) throw new Error(fix.error?.message ?? "repair failed");
          window.alert(t("repair.done", { n: fix.report?.fixed ?? 0 }));
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      /** 扫描并修复 EIO 坏块会话（先 dry-run 扫描，确认后真正修复）。
       *  需求来源：「failed to observe session xxx: EIO: i/o error, read」+
       *  「把这个功能写进会话管理插件…新增修复会话」。
       *  思路：与 scanAndRepair 同构（scan → confirm → fix），但走 /repair-eio 端点，
       *  该端点做块级 EIO 探测与截断修复（见 lib/eio-repair.js）。 */
      const scanAndRepairEio = async () => {
        if (busy) return;
        setBusy("__repair_eio__");
        try {
          const scanRes = await window.__scFetch("/api/session-conductor/repair-eio", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ dryRun: true }),
          });
          const scan = await scanRes.json();
          if (!scan.ok) throw new Error(scan.error?.message ?? "eio scan failed");
          const eioCount = (scan.eio ?? []).length;
          const msg = eioCount === 0
            ? t("repairEio.scanClean")
            : t("repairEio.confirm", { n: eioCount });
          if (eioCount === 0) { window.alert(msg); setBusy(null); return; }
          if (!window.confirm(msg)) { setBusy(null); return; }
          const fixRes = await window.__scFetch("/api/session-conductor/repair-eio", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ dryRun: false }),
          });
          const fix = await fixRes.json();
          if (!fix.ok) throw new Error(fix.error?.message ?? "eio repair failed");
          window.alert(t("repairEio.done", { n: fix.report?.fixed ?? 0 }));
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      /** 扫描并修复双格式会话（先 dry-run 扫描，确认后真正修复）。
       *  需求来源：会话目录同时存在 session.jsonl + session.jsonl.zstd 时官方
       *  listArtifacts() 抛 encodingMismatch → 会话列表全失败（侧边栏会话消失）。
       *  思路：与 scanAndRepairEio 同构（scan → confirm → fix），但走
       *  /repair-dual-format 端点（纯磁盘扫描，旁路 persistence，见 lib/repair.js）。 */
      const scanAndRepairDual = async () => {
        if (busy) return;
        setBusy("__repair_dual__");
        try {
          const scanRes = await window.__scFetch("/api/session-conductor/repair-dual-format", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ dryRun: true }),
          });
          const scan = await scanRes.json();
          if (!scan.ok) throw new Error(scan.error?.message ?? "dual-format scan failed");
          const dualCount = scan.report?.dual ?? 0;
          const msg = dualCount === 0
            ? t("repairDual.scanClean")
            : t("repairDual.confirm", { n: dualCount });
          if (dualCount === 0) { window.alert(msg); setBusy(null); return; }
          if (!window.confirm(msg)) { setBusy(null); return; }
          const fixRes = await window.__scFetch("/api/session-conductor/repair-dual-format", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ dryRun: false }),
          });
          const fix = await fixRes.json();
          if (!fix.ok) throw new Error(fix.error?.message ?? "dual-format repair failed");
          window.alert(t("repairDual.done", { n: fix.report?.fixed ?? 0 }));
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      // 自动续跑开关：乐观翻转（点了立即变），后端异步处理，失败回滚；不阻塞其他操作。
      const toggleAutoContinue = async (sessionId, enabled) => {
        setSessions((cur) => cur.map((s) => (s.id === sessionId ? { ...s, autoContinue: enabled } : s)));
        try {
          const res = await window.__scFetch("/api/session-conductor/auto-continue", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionId, enabled }),
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? MSG_ACTION_FAILED);
          await refresh();
        } catch (cause) {
          setSessions((cur) => cur.map((s) => (s.id === sessionId ? { ...s, autoContinue: !enabled } : s)));
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        }
      };

      const releaseNow = async (sessionId) => {
        setBusy(sessionId);
        try {
          const res = await window.__scFetch("/api/session-conductor/detach", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionId }),
          });
          const body = await res.json();
          if (!body.ok) {
            window.alert(t("error.action", { message: body.error?.message ?? "release failed" }));
          }
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      const releaseAll = async () => {
        if (busy) return;
        const label = t("confirm.releaseAll.title");
        const yes = window.confirm(`${label}\n\n${t("confirm.releaseAll.body")}`);
        if (!yes) return;
        setBusy("__all__");
        try {
          const res = await window.__scFetch("/api/session-conductor/detach-all", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({}),
          });
          const body = await res.json();
          if (!body.ok) {
            window.alert(t("error.action", { message: body.error?.message ?? "release all failed" }));
          } else if (body.released?.length > 0) {
            window.alert(`${t("action.releaseAll")}: ${body.released.length}`);
          }
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      const continueNow = async (sessionId) => {
        setBusy(sessionId);
        try {
          const res = await window.__scFetch("/api/session-conductor/continue", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionId }),
          });
          const body = await res.json();
          if (!body.ok) {
            window.alert(t("error.action", { message: body.error?.message ?? "continue failed" }));
          }
          await refresh();
          // 续跑进行中：轮询刷新几次以反映 continueRunning / running 状态
          const POLL_TIMES = 6;              // 续跑后轮询刷新次数
          const POLL_INTERVAL_MS = 3000;     // 轮询间隔
          for (let i = 0; i < POLL_TIMES; i++) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            await refresh();
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      // —— 全文搜索（官方 FTS5 优先，不可用时降级内置扫描）——
      const SEARCH_LIMIT = 50; // 单次搜索最大返回条数
      const runFullSearch = async (keyword) => {
        const keywordText = String(keyword ?? query ?? "").trim();
        if (keywordText.length < 2) return;
        setFullSearching(true);
        setFullResults(null);
        try {
          let res = await window.__scFetch("/api/session-search/query", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ query: keywordText, limit: SEARCH_LIMIT }),
          });
          let body = res.ok ? await res.json() : null;
          let usedFallback = false;
          if (!body?.ok || !Array.isArray(body?.items)) {
            // 官方搜索不可用 → 降级到本插件内置扫描
            res = await window.__scFetch("/api/session-conductor/search", {
              method: "POST",
              headers: { "Content-Type": CONTENT_TYPE_JSON },
              body: JSON.stringify({ query: keywordText, scope: "all" }),
            });
            body = res.ok ? await res.json() : null;
            usedFallback = true;
          }
          if (!body?.ok) throw new Error(body?.error?.message ?? "search failed");
          const hits = (body.items ?? []).map((h) => ({
            sessionId: h.sessionId,
            title: h.title ?? null,
            cwd: h.cwd ?? null,
            archived: h.archived === true,
            running: h.running === true,
            updatedAt: h.updatedAt ?? null,
            matches: Array.isArray(h.matches) ? h.matches : (h.match ? [h.match] : []),
          }));
          setFullResults({ query: keywordText, hits, usedFallback });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setFullSearching(false);
        }
      };

      // —— 批量删除选中 ——
      const deleteSelected = async () => {
        const ids = [...selected];
        if (ids.length === 0) return;
        const yes = window.confirm(`${t("deleteBatch.confirm.title", { n: ids.length })}\n\n${t("deleteBatch.confirm.body")}`);
        if (!yes) return;
        setBusy("__batch__");
        try {
          const res = await window.__scFetch("/api/session-conductor/delete-batch", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({ sessionIds: ids }),
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? "delete-batch failed");
          const skippedText = body.skipped?.length > 0 ? t("deleteBatch.skipped", { n: body.skipped.length }) : "";
          window.alert(t("deleteBatch.done", { deleted: body.deleted?.length ?? 0, skippedText }));
          setSelected(new Set());
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      // —— 按条件删除（预览 + 执行）——
      // 预览页离线模式（window.__BACKEND__ === ""）：按条件删除在快照数据上本地计算预览
      // （真实 GUI 走后端 API；预览页点预览可立即看到命中，无需后端）
      const previewLocally = () => {
        const ep = window.__ENDPOINTS__ || {};
        const listBody = ep["/api/session-conductor/list"];
        const vaBody = ep["/api/session-conductor/value-analysis"];
        const rows = (listBody?.sessions ?? []).map((s) => ({
          sessionId: s.id,
          title: s.title,
          cwd: s.cwd,
          archived: s.archived === true,
          updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : null,
        }));
        const now = Date.now();
        const lowIds = new Set((vaBody?.low ?? []).map((i) => i.id));
        const prefix = rulePrefix.trim().replace(/\/+$/, "");
        const days = Number(ruleDays) || 0;
        const matched = rows.filter((m) => {
          if (ruleArchivedOnly && !m.archived) return false;
          if (days > 0) {
            const updated = m.updatedAt;
            if (!Number.isFinite(updated) || now - updated < days * 86400000) return false;
          }
          if (prefix !== "") {
            const cwd = String(m.cwd ?? "").replace(/\/+$/, "");
            if (cwd !== prefix && !cwd.startsWith(prefix + "/")) return false;
          }
          if (ruleLowValue && !lowIds.has(m.sessionId)) return false;
          return true;
        });
        return matched;
      };

      const previewRuleDelete = async () => {
        setBusy("__rule__");
        setRulePreview(null);
        if (typeof window.__BACKEND__ !== "undefined" && window.__BACKEND__ === "") {
          // 预览页离线：本地计算
          try {
            const matched = previewLocally();
            setRulePreview(matched);
            if (matched.length === 0) window.alert(t("deleteByRule.noMatch"));
          } catch (cause) {
            window.alert(t("error.action", { message: cause instanceof Error ? cause.message : String(cause) }));
          } finally {
            setBusy(null);
          }
          return;
        }
        try {
          const res = await window.__scFetch("/api/session-conductor/delete-by-rule", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({
              archivedOnly: ruleArchivedOnly,
              inactiveDays: Number(ruleDays) || 0,
              cwdPrefix: rulePrefix.trim(),
              lowValue: ruleLowValue,
              dryRun: true,
            }),
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? "preview failed");
          setRulePreview(body.matched ?? []);
          if (!body.matched || body.matched.length === 0) window.alert(t("deleteByRule.noMatch"));
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      const runRuleDelete = async () => {
        if (!rulePreview || rulePreview.length === 0) return;
        // 预览页离线模式：不执行真实删除（破坏性操作需真实后端），提示到 DSH GUI
        if (typeof window.__BACKEND__ !== "undefined" && window.__BACKEND__ === "") {
          window.alert(t("deleteByRule.offlineHint"));
          return;
        }
        const yes = window.confirm(t("deleteByRule.preview", { n: rulePreview.length }));
        if (!yes) return;
        setBusy("__rule__");
        try {
          const res = await window.__scFetch("/api/session-conductor/delete-by-rule", {
            method: "POST",
            headers: { "Content-Type": CONTENT_TYPE_JSON },
            body: JSON.stringify({
              archivedOnly: ruleArchivedOnly,
              inactiveDays: Number(ruleDays) || 0,
              cwdPrefix: rulePrefix.trim(),
              lowValue: ruleLowValue,
              dryRun: false,
            }),
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? "delete failed");
          window.alert(t("deleteBatch.done", {
            deleted: body.deleted?.length ?? 0,
            skippedText: body.skipped?.length > 0 ? t("deleteBatch.skipped", { n: body.skipped.length }) : "",
          }));
          setRuleOpen(false);
          setRulePreview(null);
          await refresh();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(t("error.action", { message }));
        } finally {
          setBusy(null);
        }
      };

      const rows = sessions ?? [];
      // 列表过滤：标题 / cwd / id / 状态词（大小写不敏感）
      const ql = query.trim().toLowerCase();
      const matchesQuery = (row) => {
        if (!ql) return true;
        const hay = [
          row.title ?? "", row.cwd ?? "", row.id ?? "",
          row.archived ? "已归档 archived" : "",
          row.running ? "运行中 running" : "",
          row.interruption ? "已中断 interrupted" : "",
        ].join(" ").toLowerCase();
        return hay.includes(ql);
      };
      // tab=active 显示活跃会话（live 挂载中 或 running 运行中），归档的除外
      const shown = tab === "archived" ? rows.filter((row) => row.archived)
        : tab === "active" ? rows.filter((row) => !row.archived && (row.live === true || row.running === true))
        : rows;
      const filteredShown = shown.filter(matchesQuery);

      /** 通用分桶（「全部会话」与「已归档」共用，避免两套分组实现各写一份）：
       *  keyOf(session) 返回桶键（空 → 落 rest「未分组」）；makeBucket(key) 造桶对象；
       *  只保留有会话的桶（0 会话分组不显示）。 */
      const bucketSessions = (list, keyOf, makeBucket) => {
        const buckets = [];
        const index = new Map();
        const rest = [];
        for (const s of list) {
          const key = keyOf(s);
          if (!key) { rest.push(s); continue; }
          if (!index.has(key)) {
            const b = makeBucket(key);
            index.set(key, b);
            buckets.push(b);
          }
          index.get(key).sessions.push(s);
        }
        return { buckets, rest };
      };

      /** 按工作区分组：会话归入「其 cwd 的最深祖先分组」——
       *  cwd === 分组 path，或 cwd 位于分组 path 目录之下（path 是 cwd 的祖先目录）；
       *  多个分组匹配时取 path 最深者（如 move-test 子目录会话归 move-test，其余归 workspace 根）。
       *  只保留有会话的分组（0 会话分组不显示）；无任何匹配的归入「未分组」。 */
      const groupByWorkspace = (list) => {
        if (!Array.isArray(groups)) return null; // host 无分组 API → 平铺
        const norm = (p) => String(p ?? "").replace(/\/+$/, "");
        /** 会话归属的分组对象（最深祖先；无匹配返回 null）。 */
        const groupOfSession = (s) => {
          const cwd = norm(s.cwd);
          if (!cwd) return null;
          let best = null;
          let bestLen = -1;
          for (const w of groups) {
            const p = norm(w.path);
            if (p !== "" && (cwd === p || cwd.startsWith(p + "/")) && p.length > bestLen) {
              best = w;
              bestLen = p.length;
            }
          }
          return best;
        };
        return bucketSessions(
          list,
          (s) => norm(groupOfSession(s)?.path ?? ""),
          (path) => {
            const workspaceEntry = groups.find((x) => norm(x.path) === path) ?? {};
            return { workspaceId: workspaceEntry.workspaceId, title: workspaceEntry.title, path: workspaceEntry.path, sessions: [] };
          },
        );
      };

      /** 已归档视图分组：**复用上面同一套工作区分组**。
       *  历史实现按 `s.archiveWs` 分桶，但该字段实测**恒为空**（66 个已归档会话全部为空），
       *  于是所有会话都落进「未分组」，看起来就是「已归档里没有正确分组」。
       *  归档会话的 cwd 是有效的（数据层保留），故直接按 cwd 的工作区分组即可正确分节。
       *  host 无分组 API 时退化为平铺（与「全部会话」同口径）。 */
      const groupByArchiveWs = (list) => groupByWorkspace(list);

      const grouped = tab === "all" ? groupByWorkspace(filteredShown) : tab === "archived" ? groupByArchiveWs(filteredShown) : null;

      const toggleCollapse = (key) => {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };

      const renderRow = (session) => {
        // 已归档会话标题数据层带「[工作区名] 」前缀，显示层剥离（只显示原标题）
        let label = session.title || basenameOf(session.cwd) || session.id;
        if (session.archived && session.archiveWs && label.startsWith(`[${session.archiveWs}] `)) {
          label = label.slice(session.archiveWs.length + 3); // 去掉 "[工作区名] "
        }
        const meta = [session.cwd ? basenameOf(session.cwd) : "", timeAgo(session.updatedAt, t)]
          .filter(Boolean)
          .join(" · ");
        // running 由顶部「● 运行中」独立显示（含 live），archived/interrupted 走 badge
        const badge = session.archived ? "archived" : session.interruption ? "interrupted" : null;
        const processing = busy === session.id || session.continueRunning === true;
        const interruptionTitle = session.interruption ? t("interruption.tooltip", { message: session.interruption.message ?? session.interruption.kind }) : undefined;
        // 行内改为纵向卡片——顶部（批量勾选+状态徽章）/ 中间（内容）/ 下方（操作集中）
        return (0, react_jsx_runtime.jsx)("div", {
          key: session.id, // map 渲染列表时必需（filteredShown.map / g.sessions.map）
          style: S.row,
          onClick: () => {
            if (onOpenSession && !processing) {
              onOpenSession(session.id);
              setOpen(false);
            }
          },
          children: [
            // —— 顶部：批量勾选 + 状态徽章 ——
            (0, react_jsx_runtime.jsxs)("div", {
              style: S.rowTop,
              children: [
                (0, react_jsx_runtime.jsx)("label", {
                  style: { display: "flex", alignItems: "center", cursor: "pointer", flex: "none" },
                  title: t("deleteBatch.action", { n: 1 }),
                  onClick: (event) => event.stopPropagation(),
                  children: (0, react_jsx_runtime.jsx)("input", {
                    type: "checkbox",
                    checked: selected.has(session.id),
                    onChange: (event) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (event.target.checked) next.add(session.id);
                        else next.delete(session.id);
                        return next;
                      });
                    },
                  }),
                }),
                (0, react_jsx_runtime.jsxs)("div", {
                  style: S.rowTopBadges,
                  children: [
                    session.running === true && (0, react_jsx_runtime.jsx)("span", {
                      style: { ...S.badge("running"), display: "inline-flex", alignItems: "center", gap: 4 },
                      children: ["● ", t("badge.running")],
                    }),
                    session.live === true && !session.running && (0, react_jsx_runtime.jsx)("span", {
                      style: { ...S.badge("running"), display: "inline-flex", alignItems: "center", gap: 4 },
                      children: [t("badge.live")],
                    }),
                    badge !== null && (0, react_jsx_runtime.jsx)("span", {
                      style: S.badge(badge),
                      title: badge === "interrupted" ? interruptionTitle : undefined,
                      children: badge === "archived" ? t("badge.archived") : t("badge.interrupted"),
                    }),
                  ],
                }),
              ],
            }),
            // —— 中间：会话内容 ——
            (0, react_jsx_runtime.jsxs)("div", {
              style: S.rowMain,
              children: [
                (0, react_jsx_runtime.jsx)("div", {
                  style: { ...S.rowTitle, gap: 0 },
                  children: (0, react_jsx_runtime.jsx)("span", {
                    style: { overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", wordBreak: "break-word" },
                    children: label,
                  }),
                }),
                (0, react_jsx_runtime.jsx)("div", {
                  style: S.rowMeta,
                  children: meta || session.id,
                }),
                (0, react_jsx_runtime.jsx)("div", {
                  style: S.rowSid,
                  title: "session id",
                  children: session.id,
                }),
              ],
            }),
            // —— 下方：操作集中（开关 + 按钮）——
            (0, react_jsx_runtime.jsxs)("div", {
              style: S.rowOps,
              onClick: (event) => event.stopPropagation(),
              children: [
                (0, react_jsx_runtime.jsxs)("div", {
                  style: S.opsToggles,
                  children: [
                    (0, react_jsx_runtime.jsxs)("label", {
                      style: S.autoToggle,
                      title: t("help.autoRename.title"),
                      children: [
                        (0, react_jsx_runtime.jsx)("input", {
                          type: "checkbox",
                          checked: session.autoRename === true,
                          disabled: processing,
                          onChange: (event) => toggleAutoRename(session.id, event.target.checked),
                        }),
                        (0, react_jsx_runtime.jsx)("span", { children: t("action.autoRename") }),
                      ],
                    }),
                    (0, react_jsx_runtime.jsxs)("label", {
                      style: S.autoToggle,
                      title: t("help.autoContinue.title"),
                      children: [
                        (0, react_jsx_runtime.jsx)("input", {
                          type: "checkbox",
                          checked: session.autoContinue === true,
                          disabled: processing,
                          onChange: (event) => toggleAutoContinue(session.id, event.target.checked),
                        }),
                        (0, react_jsx_runtime.jsx)("span", { children: t("action.autoContinue") }),
                      ],
                    }),
                  ],
                }),
                (0, react_jsx_runtime.jsxs)("div", {
                  style: S.opsButtons,
                  children: [
                    session.autoRename === true &&
                      (0, react_jsx_runtime.jsx)("button", {
                        style: S.actionBtn(false),
                        disabled: processing,
                        onClick: () => analyzeNow(session.id),
                        children: processing ? t("action.busy") : t("action.analyze"),
                      }),
                    session.interruption !== null && session.interruption !== undefined && !session.running &&
                      (0, react_jsx_runtime.jsx)("button", {
                        style: { ...S.actionBtn(false), borderColor: "var(--dsw-state-warning-primary, #e6a23c)", color: "var(--dsw-state-warning-primary, #e6a23c)" },
                        disabled: processing,
                        onClick: () => continueNow(session.id),
                        children: session.continueRunning === true ? t("action.continueRunning") : t("action.continue"),
                      }),
                    session.live === true && !session.running && session.continueRunning !== true &&
                      (0, react_jsx_runtime.jsx)("button", {
                        style: S.actionBtn(false),
                        disabled: processing,
                        onClick: () => releaseNow(session.id),
                        children: processing ? t("action.busy") : t("action.release"),
                      }),
                    session.archived
                      ? (0, react_jsx_runtime.jsx)("button", {
                          style: S.actionBtn(false),
                          disabled: processing,
                          onClick: () => act(session.id, "unarchive"),
                          children: processing ? t("action.busy") : t("action.restore"),
                        })
                      : (0, react_jsx_runtime.jsx)("button", {
                          style: S.actionBtn(false),
                          disabled: processing,
                          onClick: () => act(session.id, "archive"),
                          children: processing ? t("action.busy") : t("action.archive"),
                        }),
                    !session.running && !session.continueRunning &&
                      (0, react_jsx_runtime.jsx)("button", {
                        style: S.actionBtn(false),
                        disabled: processing,
                        title: t("help.undo.title"),
                        onClick: () => undoLast(session),
                        children: processing ? t("action.busy") : t("action.undo"),
                      }),
                    (0, react_jsx_runtime.jsx)("button", {
                      style: S.actionBtn(true),
                      disabled: processing || session.running,
                      onClick: () => confirmDelete(session),
                      children: processing ? t("action.busy") : t("action.delete"),
                    }),
                  ],
                }),
              ],
            }),
          ],
        });
      };

      const renderHelp = () => (0, react_jsx_runtime.jsxs)("div", {
        children: [
          (0, react_jsx_runtime.jsx)("p", {
            style: S.hint,
            children: t("help.tip"),
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: { ...S.helpBlock, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
            children: [
              (0, react_jsx_runtime.jsx)("p", {
                style: { ...S.helpDesc, margin: 0, flex: 1, minWidth: HELP_DESC_MIN_WIDTH },
                children: t("help.repair.desc"),
              }),
              (0, react_jsx_runtime.jsx)("button", {
                style: S.actionBtn(false),
                disabled: busy !== null,
                onClick: scanAndRepair,
                children: busy !== null ? t("action.busy") : t("action.repair"),
              }),
            ],
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: { ...S.helpBlock, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
            children: [
              (0, react_jsx_runtime.jsx)("p", {
                style: { ...S.helpDesc, margin: 0, flex: 1, minWidth: HELP_DESC_MIN_WIDTH },
                children: t("help.repairEio.desc"),
              }),
              (0, react_jsx_runtime.jsx)("button", {
                style: S.actionBtn(false),
                disabled: busy !== null,
                onClick: scanAndRepairEio,
                children: busy !== null ? t("action.busy") : t("action.repairEio"),
              }),
            ],
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: { ...S.helpBlock, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
            children: [
              (0, react_jsx_runtime.jsx)("p", {
                style: { ...S.helpDesc, margin: 0, flex: 1, minWidth: HELP_DESC_MIN_WIDTH },
                children: t("help.repairDual.desc"),
              }),
              (0, react_jsx_runtime.jsx)("button", {
                style: S.actionBtn(false),
                disabled: busy !== null,
                onClick: scanAndRepairDual,
                children: busy !== null ? t("action.busy") : t("action.repairDual"),
              }),
            ],
          }),
          (0, react_jsx_runtime.jsx)("p", {
            style: { ...S.hint, fontWeight: LABEL_FONT_WEIGHT },
            children: t("help.works"),
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: S.helpBlock,
            children: [
              (0, react_jsx_runtime.jsx)("p", { style: S.helpTitle, children: t("help.autoRename.title") }),
              (0, react_jsx_runtime.jsx)("p", { style: S.helpDesc, children: t("help.autoRename.desc") }),
            ],
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: S.helpBlock,
            children: [
              (0, react_jsx_runtime.jsx)("p", { style: S.helpTitle, children: t("help.autoContinue.title") }),
              (0, react_jsx_runtime.jsx)("p", { style: S.helpDesc, children: t("help.autoContinue.desc") }),
            ],
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: S.helpBlock,
            children: [
              (0, react_jsx_runtime.jsx)("p", { style: S.helpTitle, children: t("help.release.title") }),
              (0, react_jsx_runtime.jsx)("p", { style: S.helpDesc, children: t("help.release.desc") }),
            ],
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: S.helpBlock,
            children: [
              (0, react_jsx_runtime.jsx)("p", { style: S.helpTitle, children: t("help.delete.title") }),
              (0, react_jsx_runtime.jsx)("p", { style: S.helpDesc, children: t("help.delete.desc") }),
            ],
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: S.helpBlock,
            children: [
              (0, react_jsx_runtime.jsx)("p", { style: S.helpTitle, children: t("help.grouped.title") }),
              (0, react_jsx_runtime.jsx)("p", { style: S.helpDesc, children: t("help.grouped.desc") }),
            ],
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: S.helpBlock,
            children: [
              (0, react_jsx_runtime.jsx)("p", { style: S.helpTitle, children: t("help.newSession.title") }),
              (0, react_jsx_runtime.jsx)("p", { style: S.helpDesc, children: t("help.newSession.desc") }),
            ],
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            style: S.helpBlock,
            children: [
              (0, react_jsx_runtime.jsx)("p", { style: S.helpTitle, children: t("help.value.title") }),
              (0, react_jsx_runtime.jsx)("p", { style: S.helpDesc, children: t("help.value.desc") }),
            ],
          }),
        ],
      });

      return (0, react_jsx_runtime.jsxs)(react.Fragment, {
        children: [
          (0, react_jsx_runtime.jsx)("button", {
            title: t("trigger.aria"),
            "aria-label": t("trigger.aria"),
            onClick: () => setOpen(true),
            style: S.trigger(wide),
            children: [
              (0, react_jsx_runtime.jsx)(SessionIcon, { size: 16 }),
              wide ? t("trigger.label") : null,
            ],
          }),
          open &&
            (0, react_jsx_runtime.jsxs)("div", {
              style: S.overlay,
              children: [
                (0, react_jsx_runtime.jsx)("div", {
                  style: S.backdrop,
                  onClick: () => setOpen(false),
                }),
                (0, react_jsx_runtime.jsxs)("div", {
                  style: S.panel,
                  children: [
                    (0, react_jsx_runtime.jsxs)("div", {
                      style: S.header,
                      children: [
                        (0, react_jsx_runtime.jsxs)("div", {
                          children: [
                            (0, react_jsx_runtime.jsx)("h2", { style: S.title, children: t("panel.title") }),
                            (0, react_jsx_runtime.jsx)("p", { style: S.subtitle, children: t("panel.subtitle") }),
                          ],
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: S.close,
                          "aria-label": "close",
                          onClick: () => setOpen(false),
                          children: "✕",
                        }),
                      ],
                    }),
                    (0, react_jsx_runtime.jsxs)("div", {
                      style: S.tabs,
                      children: [
                        (0, react_jsx_runtime.jsx)("button", {
                          style: S.tab(tab === "all"),
                          onClick: () => setTab("all"),
                          children: t("tab.all"),
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: S.tab(tab === "archived"),
                          onClick: () => setTab("archived"),
                          children: `${t("tab.archived")} (${rows.filter((row) => row.archived).length})`,
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: S.tab(tab === "active"),
                          onClick: () => setTab("active"),
                          children: `${t("tab.active")} (${rows.filter((row) => !row.archived && (row.live === true || row.running === true)).length})`,
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: S.tab(tab === "help"),
                          onClick: () => setTab("help"),
                          children: t("tab.help"),
                        }),
                      ],
                    }),
                    (0, react_jsx_runtime.jsx)("div", {
                      style: { display: "flex", gap: 6, padding: PADDING_BAR, alignItems: "center", flexWrap: "wrap" },
                      children: [
                        (0, react_jsx_runtime.jsx)("input", {
                          type: "text",
                          value: query,
                          placeholder: t("search.placeholder"),
                          style: { flex: 1, minWidth: CONTROL_MIN_WIDTH, height: CONTROL_HEIGHT, borderRadius: CONTROL_RADIUS, border: CSS_BORDER_L2, background: CSS_BG_BASE, color: CSS_LABEL_PRIMARY, padding: "0 10px", fontSize: FONT_SIZE_SMALL, outline: "none" },
                          onChange: (event) => { setQuery(event.target.value); setFullResults(null); },
                          onKeyDown: (event) => {
                            if (event.key === "Enter") runFullSearch(query);
                          },
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: S.actionBtn(false),
                          disabled: fullSearching || busy !== null,
                          onClick: () => runFullSearch(query),
                          children: fullSearching ? t("search.fullBusy") : t("search.full"),
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: { ...S.actionBtn(true), borderColor: CSS_DANGER, color: CSS_DANGER },
                          disabled: selected.size === 0 || busy !== null,
                          onClick: () => deleteSelected(),
                          children: t("deleteBatch.action", { n: selected.size }),
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: S.actionBtn(false),
                          disabled: busy !== null,
                          onClick: () => { setRuleOpen((v) => !v); setRulePreview(null); },
                          children: t("deleteByRule.action"),
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: { ...S.actionBtn(false), marginLeft: "auto" },
                          disabled: busy !== null,
                          onClick: () => releaseAll(),
                          children: busy === "__all__" ? t("action.releaseAllBusy") : t("action.releaseAll"),
                        }),
                      ],
                    }),
                    // —— 按条件删除表单（展开式） ——
                    ruleOpen &&
                      (0, react_jsx_runtime.jsxs)("div", {
                        style: { display: "flex", gap: 8, padding: PADDING_BAR, alignItems: "center", flexWrap: "wrap", fontSize: FONT_SIZE_SMALL },
                        children: [
                          (0, react_jsx_runtime.jsxs)("label", {
                            style: { display: "flex", alignItems: "center", gap: 4, color: CSS_LABEL_SECONDARY },
                            children: [
                              (0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: ruleArchivedOnly, onChange: (e) => setRuleArchivedOnly(e.target.checked) }),
                              t("deleteByRule.label.archivedOnly"),
                            ],
                          }),
                          (0, react_jsx_runtime.jsxs)("label", {
                            style: { display: "flex", alignItems: "center", gap: 4, color: CSS_LABEL_SECONDARY },
                            title: t("deleteByRule.label.lowValue"),
                            children: [
                              (0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: ruleLowValue, onChange: (e) => setRuleLowValue(e.target.checked) }),
                              t("deleteByRule.label.lowValue"),
                            ],
                          }),
                          (0, react_jsx_runtime.jsxs)("label", {
                            style: { display: "flex", alignItems: "center", gap: 4, color: CSS_LABEL_SECONDARY, flexWrap: "nowrap" },
                            children: [
                              t("deleteByRule.label.inactiveDays.pre"),
                              (0, react_jsx_runtime.jsx)("input", {
                                type: "number", min: 0, max: 3650, value: ruleDays,
                                style: { width: RULE_DAYS_INPUT_WIDTH, height: SMALL_CONTROL_HEIGHT, borderRadius: CONTROL_RADIUS, border: CSS_BORDER_L2, background: CSS_BG_BASE, color: CSS_LABEL_PRIMARY, padding: "0 6px", fontSize: FONT_SIZE_SMALL },
                                onChange: (e) => setRuleDays(e.target.value),
                              }),
                              t("deleteByRule.label.inactiveDays.post"),
                            ],
                          }),
                          (0, react_jsx_runtime.jsx)("input", {
                            type: "text", value: rulePrefix, placeholder: t("deleteByRule.label.cwdPrefix"),
                            style: { flex: 1, minWidth: RULE_PREFIX_MIN_WIDTH, height: SMALL_CONTROL_HEIGHT, borderRadius: CONTROL_RADIUS, border: CSS_BORDER_L2, background: CSS_BG_BASE, color: CSS_LABEL_PRIMARY, padding: "0 8px", fontSize: FONT_SIZE_SMALL, outline: "none" },
                            onChange: (e) => { setRulePrefix(e.target.value); setRulePreview(null); },
                          }),
                          (0, react_jsx_runtime.jsx)("button", {
                            style: S.actionBtn(false),
                            disabled: busy !== null,
                            onClick: previewRuleDelete,
                            children: t("deleteByRule.previewBtn"),
                          }),
                          rulePreview !== null && rulePreview.length > 0 &&
                            (0, react_jsx_runtime.jsx)("button", {
                              style: { ...S.actionBtn(true), borderColor: CSS_DANGER, color: CSS_DANGER },
                              disabled: busy !== null,
                              onClick: runRuleDelete,
                              children: t("deleteByRule.run") + ` (${rulePreview.length})`,
                            }),
                          rulePreview !== null && rulePreview.length > 0 &&
                            (0, react_jsx_runtime.jsx)("span", {
                              style: { color: CSS_LABEL_TERTIARY, fontSize: 12 },
                              children: t("search.hits", { n: rulePreview.length }),
                            }),
                        ],
                      }),
                    (0, react_jsx_runtime.jsx)("div", {
                      style: S.body,
                      children: tab === "help"
                        ? renderHelp()
                        : (0, react_jsx_runtime.jsxs)(react.Fragment, {
                            children: [
                              // —— 全文搜索结果区（官方 FTS5 优先，自研兜底） ——
                              fullResults !== null &&
                                (0, react_jsx_runtime.jsxs)("div", {
                                  style: { margin: PADDING_BAR, borderRadius: 10, border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", overflow: "hidden" },
                                  children: [
                                    (0, react_jsx_runtime.jsxs)("div", {
                                      style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08))" },
                                      children: [
                                        (0, react_jsx_runtime.jsx)("span", { style: { fontSize: FONT_SIZE_SMALL, fontWeight: FONT_WEIGHT_SEMIBOLD, color: CSS_LABEL_PRIMARY }, children: `${t("search.hits", { n: fullResults.hits.length })}：${fullResults.query}` }),
                                        fullResults.usedFallback && (0, react_jsx_runtime.jsx)("span", { style: { fontSize: 11.5, color: CSS_LABEL_TERTIARY }, children: t("search.fallback") }),
                                        (0, react_jsx_runtime.jsx)("button", {
                                          style: { ...S.actionBtn(false), marginLeft: "auto" },
                                          onClick: () => setFullResults(null),
                                          children: t("search.close"),
                                        }),
                                      ],
                                    }),
                                    fullResults.hits.length === 0
                                      ? (0, react_jsx_runtime.jsx)("div", { style: { ...S.empty, margin: 0, padding: "14px 0" }, children: t("search.noResult") })
                                      : fullResults.hits.map((hit) => (0, react_jsx_runtime.jsxs)("div", {
                                          style: { padding: "6px 10px", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15))", cursor: "pointer" },
                                          onClick: () => { if (onOpenSession) { onOpenSession(hit.sessionId); setOpen(false); } },
                                          children: [
                                            (0, react_jsx_runtime.jsxs)("div", {
                                              style: { fontSize: FONT_SIZE_SMALL, fontWeight: FONT_WEIGHT_SEMIBOLD, color: CSS_LABEL_PRIMARY, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                                              children: [hit.title || basenameOf(hit.cwd) || hit.sessionId, hit.archived ? ` · ${t("badge.archived")}` : "", hit.running ? ` · ${t("badge.running")}` : ""],
                                            }),
                                            (0, react_jsx_runtime.jsx)("div", { style: { fontSize: 11.5, color: CSS_LABEL_TERTIARY, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: hit.cwd || hit.sessionId }),
                                            (hit.matches ?? []).map((m, mi) => (0, react_jsx_runtime.jsxs)("div", {
                                              style: { fontSize: 12, lineHeight: 1.5, color: CSS_LABEL_SECONDARY },
                                              children: [
                                                (0, react_jsx_runtime.jsx)("span", {
                                                  style: { display: "inline-block", marginRight: 6, padding: "0 5px", borderRadius: 4, fontSize: 11, background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))", color: CSS_LABEL_TERTIARY },
                                                  children: m.role === "user" ? t("search.matchRole.user") : m.role === "assistant" ? t("search.matchRole.assistant") : (m.surface ?? m.type ?? ""),
                                                }),
                                                (0, react_jsx_runtime.jsx)("span", { children: m.snippet ?? m.preview ?? "" }),
                                              ],
                                            }, `${hit.sessionId}-m${mi}`)),
                                          ],
                                        }, hit.sessionId)),
                                  ],
                                }),
                              error !== null &&
                                (0, react_jsx_runtime.jsxs)("div", {
                                  style: S.error,
                                  children: [
                                    t("list.error", { message: error }),
                                    " ",
                                    (0, react_jsx_runtime.jsx)("button", {
                                      style: { ...S.actionBtn(false), marginLeft: 6 },
                                      onClick: refresh,
                                      children: t("action.retry"),
                                    }),
                                  ],
                                }),
                              sessions === null && error === null
                                ? (0, react_jsx_runtime.jsx)("div", { style: S.empty, children: t("list.loading") })
                                : filteredShown.length === 0
                                  ? (0, react_jsx_runtime.jsx)("div", {
                                      style: S.empty,
                                      children: tab === "archived" ? t("list.archivedEmpty") : tab === "active" ? t("list.activeEmpty") : t("list.empty"),
                                    })
                                  : grouped === null
                                    ? filteredShown.map(renderRow)
                                    : (0, react_jsx_runtime.jsxs)(react.Fragment, {
                                        children: [
                                          grouped.buckets.map((g) => (0, react_jsx_runtime.jsxs)("div", {
                                            key: g.workspaceId,
                                            children: [
                                              (0, react_jsx_runtime.jsxs)("div", {
                                                style: S.groupHeader,
                                                onClick: () => toggleCollapse(g.workspaceId),
                                                children: [
                                                  (0, react_jsx_runtime.jsx)("span", {
                                                    style: S.groupCaret,
                                                    children: collapsed.has(g.workspaceId) ? "▸" : "▾",
                                                  }),
                                                  (0, react_jsx_runtime.jsx)("span", { style: S.groupTitle, children: (tab === "archived" ? t("badge.archived") + " · " : "") + g.title }),
                                                  (0, react_jsx_runtime.jsx)("span", { style: S.groupCount, children: g.sessions.length }),
                                                ],
                                              }),
                                              !collapsed.has(g.workspaceId) && (0, react_jsx_runtime.jsxs)("div", {
                                                style: S.groupList,
                                                children: g.sessions.map(renderRow),
                                              }),
                                            ],
                                          })),
                                          grouped.rest.length > 0 && (0, react_jsx_runtime.jsxs)("div", {
                                            key: "__ungrouped__",
                                            children: [
                                              (0, react_jsx_runtime.jsxs)("div", {
                                                style: S.groupHeader,
                                                onClick: () => toggleCollapse("__ungrouped__"),
                                                children: [
                                                  (0, react_jsx_runtime.jsx)("span", {
                                                    style: S.groupCaret,
                                                    children: collapsed.has("__ungrouped__") ? "▸" : "▾",
                                                  }),
                                                  (0, react_jsx_runtime.jsx)("span", { style: S.groupTitle, children: t("group.ungrouped") }),
                                                  (0, react_jsx_runtime.jsx)("span", { style: S.groupCount, children: grouped.rest.length }),
                                                ],
                                              }),
                                              !collapsed.has("__ungrouped__") && (0, react_jsx_runtime.jsxs)("div", {
                                                style: S.groupList,
                                                children: grouped.rest.map(renderRow),
                                              }),
                                            ],
                                          }),
                                        ],
                                      }),
                            ],
                          }),
                    }),
                  ],
                }),
              ],
            }),
        ],
      });
    }

