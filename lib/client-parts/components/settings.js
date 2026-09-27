    // ---------- 插件入口 ----------
    const inject = ["slots", "locale"];

    // 设置页必须单入口 + React.createElement，禁止 jsx-runtime.jsx。
    // 外壳对 settings.section 渲染抛错会吞成空白，所以页面自己兜底。
    const h = react.createElement.bind(react);
    const settingsCss = [
      ".scs_page{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px}",
      ".scs_hero{display:flex;flex-direction:column;gap:6px}",
      ".scs_title{font-size:20px;font-weight:650;color:var(--dsw-alias-label-primary)}",
      ".scs_desc{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-tertiary);max-width:72ch;margin:0}",
      ".scs_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".scs_err{font-size:13px;color:var(--dsw-alias-label-error)}",
      ".scs_card{display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3)}",
      ".scs_cardtitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".scs_note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}",
      ".scs_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".scs_btn{cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-radius:8px;height:28px;padding:0 12px;font-size:12px}",
      ".scs_btn.scs_on{border-color:var(--dsw-state-success-primary,#34a853);color:var(--dsw-state-success-primary,#34a853)}",
      ".scs_btn.scs_off{border-color:var(--dsw-state-error-primary,#d9534f);color:var(--dsw-state-error-primary,#e5484d)}",
      ".scs_input{flex:1;min-width:180px;height:28px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:13px}",
      ".scs_last{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;white-space:pre-wrap;word-break:break-all;max-height:80px;overflow:auto}",
      ".scs_file{display:flex;align-items:center;gap:8px;font-size:12px}",
      ".scs_del{cursor:pointer;border:none;background:transparent;color:#e5484d;font-size:11px}",
      ".scs_select{height:28px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px}",
      ".scs_ta{width:100%;min-height:72px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:8px 10px;font-size:12px;resize:vertical}",
      // 悬浮窗（2026-09-27 改：参考「选择目录」弹窗样式——mask 遮罩 + 居中 dialog + 面包屑 + 上级 + 列表 + 底部确认）
      ".scs_pickermask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)}",
      ".scs_pickerdialog{width:min(520px,88vw);max-height:70vh;display:flex;flex-direction:column;gap:8px;padding:14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:14px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 12px 40px rgba(0,0,0,.35)}",
      ".scs_pickerhead{display:flex;align-items:center;justify-content:space-between}",
      ".scs_pickertitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".scs_pickerclose{font:inherit;font-size:13px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:2px 6px}",
      ".scs_pickerpath{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}",
      ".scs_pickerup{font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer;padding:3px 2px}",
      ".scs_pickerlist{flex:1;min-height:120px;max-height:38vh;overflow-y:auto;display:flex;flex-direction:column;gap:2px}",
      ".scs_pickerrow{font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;padding:5px 8px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".scs_pickerrow:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}",
      ".scs_pickerrow.scs_pickerselected{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-brand-primary)}",
      ".scs_pickerhint{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:8px}",
      ".scs_pickerfoot{display:flex;justify-content:flex-end}",
      ".scs_pickermdfile{font-weight:600}",
      ".scs_rule{display:flex;flex-direction:column;gap:8px;padding:10px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px}",
    ].join("");

    function ensureSettingsCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="dsh-session-conductor"]')) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-conductor";
      tag.dataset.pluginCss = "dsh-session-conductor";
      tag.textContent = settingsCss;
      document.head.appendChild(tag);
    }

    function trSettings(key) {
      // 跨 NS + en 统一取词（修复此前只读 zh 的 bug）
      return window.__SC_TR__(key);
    }

    // —— 模板注入：槽位卡片（独立组件，避免 MainTemplateSection 单函数过长）——
    function TemplateSlotCard(props) {
      const { slot, title, desc, m, busy, edits, importMode, fileRef, MODES, onToggle, onToggleEnforce, onOpenImport, onPickFile, onEdit, onSaveEdit, onRemove } = props;
      const hasContent = !!m.name || (m.bytes > 0);
      const text = edits[slot] !== undefined ? edits[slot] : (m.content ?? "");
      return h("div", { className: "scs_rule", key: slot },
        h("div", { className: "scs_row" },
          h("b", { style: { minWidth: 90 } }, title),
          h("button", { type: "button", className: "scs_btn " + (m.enabled ? "scs_on" : "scs_off"), disabled: busy || !hasContent, onClick: () => onToggle(slot, !m.enabled) }, m.enabled ? __SC_TR__("tpl.injecting") : __SC_TR__("tpl.injectOff")),
          slot === "plan" ? h("button", { type: "button", className: "scs_btn", disabled: busy, onClick: () => onToggleEnforce(!(m.enforce === true)) }, (m.enforce === true ? __SC_TR__("tpl.enforceOn") : __SC_TR__("tpl.enforceOff"))) : null,
        ),
        // 导入行：下拉选方式 + 单个导入按钮
        h("div", { className: "scs_row", style: { marginTop: 8 } },
          h("select", {
            className: "scs_select", value: importMode[slot] || "local",
            onChange: (e) => props.onImportMode(slot, e.target.value),
          }, MODES.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
          h("button", { type: "button", className: "scs_btn", disabled: busy, onClick: () => onOpenImport(slot) }, __SC_TR__("tpl.import")),
          h("input", { ref: fileRef, type: "file", accept: ".md,text/markdown", style: { display: "none" }, onChange: (e) => onPickFile(slot, e) }),
        ),
        // 内容显示 + 可再次编辑（动态高度、自动换行）
        h("textarea", {
          className: "scs_ta",
          style: { width: "100%", minHeight: 56, maxHeight: 340, resize: "vertical", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word", lineHeight: 1.55, fontFamily: "inherit" },
          value: text,
          placeholder: hasContent ? "" : __SC_TR__("tpl.emptyHint"),
          onChange: (e) => onEdit(slot, e.target),
        }),
        h("div", { className: "scs_row", style: { marginTop: 6 } },
          h("button", { type: "button", className: "scs_btn", disabled: busy || edits[slot] === undefined || !(edits[slot] || "").trim(), onClick: () => onSaveEdit(slot) }, __SC_TR__("tpl.saveEdit")),
          h("button", { type: "button", className: "scs_del", disabled: busy || !hasContent, onClick: () => onRemove(slot) }, __SC_TR__("tpl.clear")),
        ),
        h("div", { className: "scs_hint" }, desc + (m.name ? __SC_TR__("tpl.current", { name: m.name }) + (m.url ? "（" + m.url + "）" : "") + (m.updatedAt ? " · " + new Date(m.updatedAt).toLocaleString() : "") : "")),
      );
    }

    // —— 模板注入：统一悬浮窗（url 网址输入 / dir 目录浏览）——
    function TemplatePickerModal(props) {
      const { picker, busy, onClose, onBrowseDir, onPickMd, onImport } = props;
      return h("div", { className: "scs_pickermask", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h("div", { className: "scs_pickerdialog" },
          h("div", { className: "scs_pickerhead" },
            h("span", { className: "scs_pickertitle" }, picker.mode === "url" ? __SC_TR__("tpl.pickerUrl", { slot: picker.slot === "plan" ? __SC_TR__("tpl.planShort") : __SC_TR__("tpl.closingShort") }) : (picker.mode === "dir" ? __SC_TR__("tpl.pickerDir", { slot: picker.slot === "plan" ? __SC_TR__("tpl.planShort") : __SC_TR__("tpl.closingShort") }) : __SC_TR__("tpl.pickerPath", { slot: picker.slot === "plan" ? __SC_TR__("tpl.planShort") : __SC_TR__("tpl.closingShort") }))),
            h("button", { type: "button", className: "scs_pickerclose", onClick: () => onClose() }, "✕"),
          ),
          picker.mode === "url"
            ? h("div", { className: "scs_row", style: { paddingTop: 4 } },
                h("input", { className: "scs_input", style: { flex: 1 }, value: picker.url || "", placeholder: __SC_TR__("tpl.urlPlaceholder"), onChange: (e) => props.onUrlChange(e.target.value) }),
                h("button", { type: "button", className: "scs_btn", disabled: busy || !(picker.url || "").trim(), onClick: () => onImport(picker.slot, "url", (picker.url || "").trim()) }, __SC_TR__("tpl.import")),
              )
            : h("div", {},
                h("div", { className: "scs_pickerpath" }, picker.path || __SC_TR__("tpl.noPath")),
                h("div", { className: "scs_pickerup", onClick: () => { if (picker.parent) onBrowseDir(picker.parent); } }, __SC_TR__("tpl.upDir")),
                h("div", { className: "scs_pickerlist" },
                  picker.entries.length === 0 ? h("div", { className: "scs_pickerhint" }, __SC_TR__("tpl.emptyDir")) : null,
                  picker.entries.map((e) => h("div", {
                    key: e.path,
                    className: "scs_pickerrow" + (e.isMd ? " scs_pickermdfile" : "") + (picker.path === e.path ? " scs_pickerselected" : ""),
                    onClick: () => { if (e.isDir) onBrowseDir(e.path); else if (e.isMd) onPickMd(e.path); },
                  }, (e.isDir ? "📁 " : (e.isMd ? "📄 " : "· ")) + e.name + (e.isDir ? "/" : ""))),
                ),
                h("div", { className: "scs_pickerhint" }, __SC_TR__("tpl.dirHint")),
                h("div", { className: "scs_pickerfoot" },
                  h("button", { type: "button", className: "scs_btn", disabled: busy || !(picker.path || "").trim(), onClick: () => onImport(picker.slot, "dir", (picker.path || "").trim()) }, __SC_TR__("tpl.importSelected")),
                ),
              ),
        ),
      );
    }

    const TEMPLATE_MODES = [
      { value: "local", label: __SC_TR__("tpl.modeLocal") },
      { value: "url", label: __SC_TR__("tpl.modeUrl") },
      { value: "dir", label: __SC_TR__("tpl.modeDir") },
    ];

    function useTemplateFetch(st) {
      const refresh = react.useCallback(() => {
        window.__scFetch("/api/session-conductor/templates", { credentials: "same-origin" })
          .then(async (res) => {
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error((body.error && body.error.message) || ("HTTP " + res.status));
            st.setSlots(body.slots || {});
          })
          .catch((cause) => st.setMsg({ err: (cause && cause.message) || String(cause) }));
      }, [st]);
      react.useEffect(() => { refresh(); }, [refresh]);
      const post = (payload) => window.__scFetch("/api/session-conductor/templates", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) throw new Error((body.error && body.error.message) || ("HTTP " + res.status));
        st.setSlots(body.slots || {});
        return body;
      });
      return { refresh, post };
    }

    // —— 模板导入动作（本地设备上传 / 在线网址 / DSH 目录浏览）——
    function useTemplateImports(st, post) {
      const slotLabel = (slot) => (slot === "plan" ? __SC_TR__("tpl.planShort") : __SC_TR__("tpl.closingShort"));
      const onPickFile = (slot, event) => {
        const f = event.target.files && event.target.files[0];
        if (!f) return;
        event.target.value = "";
        st.setBusy(true); st.setMsg(null);
        f.text()
          .then((content) => post({ slot, name: f.name, content }))
          .then((body) => { st.setMsg({ ok: (body.message) || __SC_TR__("tpl.imported", { slot: slotLabel(slot) }) }); st.setEdits((s) => ({ ...s, [slot]: content })); })
          .catch((cause) => st.setMsg({ err: __SC_TR__("tpl.importFail") + ((cause && cause.message) || String(cause)) }))
          .finally(() => st.setBusy(false));
      };
      const openImport = (slot) => {
        const mode = st.importMode[slot] || "local";
        st.setMsg(null);
        if (mode === "local") {
          if (st.fileRefs[slot].current) st.fileRefs[slot].current.click();
          return;
        }
        if (mode === "url") {
          st.setPicker({ slot, mode: "url", url: "", path: "", parent: null, entries: [] });
          return;
        }
        window.__scFetch("/api/session-conductor/templates/dir", { credentials: "same-origin" })
          .then(async (res) => {
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error((body.error && body.error.message) || ("HTTP " + res.status));
            st.setPicker({ slot, mode, path: body.path, parent: body.parent, entries: body.entries || [] });
          })
          .catch((cause) => st.setMsg({ err: __SC_TR__("tpl.dirFail") + ((cause && cause.message) || String(cause)) }));
      };
      const browseDir = (path) => {
        window.__scFetch("/api/session-conductor/templates/dir?path=" + encodeURIComponent(path), { credentials: "same-origin" })
          .then(async (res) => {
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error((body.error && body.error.message) || ("HTTP " + res.status));
            st.setPicker({ slot: st.picker.slot, mode: st.picker.mode, path: body.path, parent: body.parent, entries: body.entries || [] });
          })
          .catch((cause) => st.setMsg({ err: __SC_TR__("tpl.dirFail") + ((cause && cause.message) || String(cause)) }));
      };
      const importTemplate = (slot, mode, value) => {
        st.setBusy(true); st.setMsg(null);
        post(mode === "url" ? { slot, url: value } : { slot, action: "pickPath", path: value })
          .then((body) => { st.setMsg({ ok: (body.message) || __SC_TR__("tpl.imported", { slot: slotLabel(slot) }) }); st.setPicker(null); })
          .catch((cause) => st.setMsg({ err: __SC_TR__("tpl.importFail") + ((cause && cause.message) || String(cause)) }))
          .finally(() => st.setBusy(false));
      };
      return { onPickFile, openImport, browseDir, importTemplate, slotLabel };
    }

    // —— 模板槽位变更动作（开关 / 强制门禁 / 编辑保存 / 清空）——
    function useTemplateMutations(st, post, slotLabel) {
      const toggle = (slot, enabled) => {
        st.setBusy(true); st.setMsg(null);
        post({ slot, enabled })
          .then((body) => st.setMsg({ ok: (body.message) || __SC_TR__("tpl.toggled", { slot: slotLabel(slot) }) }))
          .catch((cause) => st.setMsg({ err: (cause && cause.message) || String(cause) }))
          .finally(() => st.setBusy(false));
      };
      const toggleEnforce = (enforce) => {
        st.setBusy(true); st.setMsg(null);
        post({ slot: "plan", enforce })
          .then((body) => st.setMsg({ ok: (body.message) || __SC_TR__("tpl.enforceDone") }))
          .catch((cause) => st.setMsg({ err: (cause && cause.message) || String(cause) }))
          .finally(() => st.setBusy(false));
      };
      const onEdit = (slot, el) => {
        const v = el.value;
        st.setEdits((s) => ({ ...s, [slot]: v }));
        el.style.height = "auto";
        el.style.height = (el.scrollHeight + 2) + "px";
      };
      const saveEdit = (slot) => {
        const content = (st.edits[slot] ?? "").trim();
        if (!content) return;
        st.setBusy(true); st.setMsg(null);
        post({ slot, content })
          .then((body) => { st.setMsg({ ok: (body.message) || __SC_TR__("tpl.updated", { slot: slotLabel(slot) }) }); st.setEdits((s) => ({ ...s, [slot]: undefined })); })
          .catch((cause) => st.setMsg({ err: __SC_TR__("tpl.saveFail") + ((cause && cause.message) || String(cause)) }))
          .finally(() => st.setBusy(false));
      };
      const onRemove = (slot) => {
        st.setBusy(true); st.setMsg(null);
        post({ slot, action: "remove" })
          .then((body) => { st.setMsg({ ok: (body.message) || __SC_TR__("tpl.removed", { slot: slotLabel(slot) }) }); st.setEdits((s) => ({ ...s, [slot]: undefined })); })
          .catch((cause) => st.setMsg({ err: (cause && cause.message) || String(cause) }))
          .finally(() => st.setBusy(false));
      };
      return { toggle, toggleEnforce, onEdit, saveEdit, onRemove };
    }

    function MainTemplateSection() {
      const [slots, setSlots] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [edits, setEdits] = react.useState({});
      const [importMode, setImportMode] = react.useState({ plan: "local", closing: "local" });
      const [picker, setPicker] = react.useState(null);
      const fileRefs = { plan: react.useRef(null), closing: react.useRef(null) };
      const st = { slots, setSlots, busy, setBusy, msg, setMsg, edits, setEdits, importMode, setImportMode, picker, setPicker, fileRefs };
      const { post } = useTemplateFetch(st);
      const imports = useTemplateImports(st, post);
      const muts = useTemplateMutations(st, post, imports.slotLabel);
      return h("div", { className: "scs_card" },
        h("div", { className: "scs_cardtitle" }, __SC_TR__("tpl.title")),
        h("div", { className: "scs_hint" }, __SC_TR__("tpl.desc")),
        (slots ? [
          h(TemplateSlotCard, {
            slot: "plan", title: __SC_TR__("tpl.planTitle"), desc: __SC_TR__("tpl.planDesc"),
            m: slots.plan || { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0, content: "" },
            busy, edits, importMode, fileRef: fileRefs.plan, MODES: TEMPLATE_MODES,
            onToggle: muts.toggle, onToggleEnforce: muts.toggleEnforce, onOpenImport: imports.openImport, onPickFile: imports.onPickFile, onEdit: muts.onEdit, onSaveEdit: muts.saveEdit, onRemove: muts.onRemove,
            onImportMode: (s, v) => setImportMode((prev) => ({ ...prev, [s]: v })),
          }),
          h(TemplateSlotCard, {
            slot: "closing", title: __SC_TR__("tpl.closingTitle"), desc: __SC_TR__("tpl.closingDesc"),
            m: slots.closing || { enabled: false, enforce: false, name: "", url: "", bytes: 0, updatedAt: 0, content: "" },
            busy, edits, importMode, fileRef: fileRefs.closing, MODES: TEMPLATE_MODES,
            onToggle: muts.toggle, onToggleEnforce: muts.toggleEnforce, onOpenImport: imports.openImport, onPickFile: imports.onPickFile, onEdit: muts.onEdit, onSaveEdit: muts.saveEdit, onRemove: muts.onRemove,
            onImportMode: (s, v) => setImportMode((prev) => ({ ...prev, [s]: v })),
          }),
        ] : h("div", { className: "scs_hint" }, __SC_TR__("tpl.loading"))),
        msg ? h("div", { className: msg.err ? "scs_err" : "scs_hint" }, msg.err || msg.ok) : null,
        picker ? h(TemplatePickerModal, {
          picker, busy,
          onClose: () => setPicker(null),
          onBrowseDir: imports.browseDir,
          onPickMd: (p) => setPicker((prev) => ({ ...prev, path: p })),
          onUrlChange: (v) => setPicker((prev) => ({ ...prev, url: v })),
          onImport: imports.importTemplate,
        }) : null,
      );
    }



    // ── 自动重命名模型选择（v1.36.0）：DSH 同款解析选择器（provider 分组 + 模型下拉）──
    // 数据来自官方 modelCatalog（GET /api/session-conductor/auto-rename-model 透传），
    // 选择持久化到插件 domain，自动重命名 resolveRoute 三级优先级最优先。
    function AutoRenameModelSection() {
      const [sel, setSel] = react.useState(null);          // {provider, model} | null（null=跟随会话模型）
      const [catalog, setCatalog] = react.useState(null);  // 官方 modelCatalog
      const [provider, setProvider] = react.useState("");  // 编辑态 provider
      const [model, setModel] = react.useState("");        // 编辑态 model
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);

      react.useEffect(() => {
        let alive = true;
        window.__scFetch("/api/session-conductor/auto-rename-model", { headers: { accept: "application/json" } })
          .then((r) => r.json())
          .then((d) => {
            if (!alive || !d?.ok) return;
            setSel(d.selection ?? null);
            setCatalog(d.catalog ?? null);
            if (d.selection) {
              setProvider(d.selection.provider);
              setModel(d.selection.model);
            }
          })
          .catch(() => { /* 目录获取失败：仍允许手动选择（下方兜底输入框） */ });
        return () => { alive = false; };
      }, []);

      const save = async (next) => {
        setBusy(true);
        setMsg(null);
        try {
          const r = await window.__scFetch("/api/session-conductor/auto-rename-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(next),
          });
          const d = await r.json();
          if (d?.ok) {
            setSel(d.selection ?? null);
            setMsg({ ok: d.message || __SC_TR__("saved") });
          } else {
            setMsg({ err: d?.error?.message || __SC_TR__("saveFail") });
          }
        } catch (e) {
          setMsg({ err: String(e?.message ?? e) });
        }
        setBusy(false);
      };

      const groups = catalog?.groups ?? [];
      const providers = groups.map((g) => ({ id: g.id, name: g.name, models: g.models ?? [] }));
      const curProvider = providers.find((p) => p.id === provider) ?? null;
      const models = curProvider?.models ?? [];
      const follow = sel === null;

      return h("div", { className: "scs_card" },
        h("div", { className: "scs_cardtitle" }, __SC_TR__("armTitle")),
        h("div", { className: "scs_hint" }, __SC_TR__("armDesc")),
        h("div", { className: "scs_row", style: { gap: 8, alignItems: "center" } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 4 } },
            h("input", { type: "radio", name: "sc-arm-follow", checked: follow, onChange: () => save({ follow: true }) }),
            __SC_TR__("armFollow"),
          ),
        ),
        h("div", { className: "scs_row", style: { gap: 8, alignItems: "center", flexWrap: "wrap" } },
          h("select", { className: "scs_input", style: { width: 170 }, value: provider, disabled: busy, onChange: (e) => { setProvider(e.target.value); setModel(""); } },
            h("option", { value: "" }, __SC_TR__("armProvider")),
            providers.map((p) => h("option", { key: p.id, value: p.id }, p.name)),
          ),
          h("select", { className: "scs_input", style: { width: 210 }, value: model, disabled: busy || !provider, onChange: (e) => setModel(e.target.value) },
            h("option", { value: "" }, __SC_TR__("armModel")),
            models.map((m) => h("option", { key: m.id, value: m.id }, m.name || m.id)),
          ),
          h("button", { type: "button", className: "scs_btn", disabled: busy || !provider || !model, onClick: () => save({ provider, model }) }, __SC_TR__("armSet")),
        ),
        h("div", { className: "scs_hint" }, follow
          ? __SC_TR__("armCurFollow")
          : (sel ? `当前：${sel.provider}/${sel.model}` : __SC_TR__("armCurNone"))),
        msg ? h("div", { className: msg.err ? "scs_err" : "scs_hint" }, msg.err || msg.ok) : null,
      );
    }

    class SettingsErrorBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { err: "" };
      }
      static getDerivedStateFromError(err) {
        return { err: (err && err.message) || String(err) };
      }
      render() {
        if (this.state.err) {
          return h("div", { className: "scs_page" },
            h("div", { className: "scs_title" }, __SC_TR__("settings.title")),
            h("div", { className: "scs_err" }, __SC_TR__("renderFail") + this.state.err),
          );
        }
        return this.props.children;
      }
    }

    function ConductorSettingsPage() {
      ensureSettingsCss();
      return h(SettingsErrorBoundary, null,
        h("div", { className: "scs_page" },
          h("div", { className: "scs_hero" },
            h("div", { className: "scs_title" }, trSettings("settings.title")),
            h("p", { className: "scs_desc" }, trSettings("settings.desc")),
            h("div", { className: "scs_hint" }, trSettings("settings.scopeHint")),
          ),
          h(AutoRenameModelSection, null),
          h(MainTemplateSection, null),
          h("div", { className: "scs_note" }, trSettings("settings.note")),
        ),
      );
    }

