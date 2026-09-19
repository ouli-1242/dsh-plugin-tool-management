    function SkillManagerSection(props) {
      var t = props.t;
      var ss = react.useState({ loading: true, error: null, data: null }), snapshot = ss[0], setSnapshot = ss[1];
      var bs = react.useState(false), busy = bs[0], setBusy = bs[1];
      var qs = react.useState(""), query = qs[0], setQuery = qs[1];
      // 过滤用防抖值（输入框仍绑 `query`）：本页每次渲染都要按来源过滤一遍技能，
      // 并在每张来源卡上再算一次批量目标集（见下方 skillView）。
      var dq = useDebouncedValue(query);
      var fs = react.useState(""), source = fs[0], setSource = fs[1];
      var es = react.useState({}), expanded = es[0], setExpanded = es[1];
      var ms = react.useState(null), modal = ms[0], setModal = ms[1];
      var rs = react.useState(null), result = rs[0], setResult = rs[1];
      var fms = react.useState({ root: "dsh", name: "", description: "", body: "" }), form = fms[0], setForm = fms[1];
      var us = react.useState(null), upload = us[0], setUpload = us[1];
      var ds = react.useState(null), detail = ds[0], setDetail = ds[1];
      var cs = react.useState({ path: "", label: "" }), customForm = cs[0], setCustomForm = cs[1];
      var ups = useUndoState(), undo = ups[0], setUndo = ups[1], dismissUndo = ups[2];
      var inflightRef = react.useRef(false);
      // 详情弹窗的请求序号（见 openDetail / closeModal）：晚到的响应不得复活/顶掉弹窗内容。
      var detailSeqRef = react.useRef(0);
      var pickerOpenRef = react.useRef(false);
      // 事件回调里要读「当前」的撤销条：点开关到请求返回之间用户可能已经点过撤销。
      var undoRef = react.useRef(null);
      undoRef.current = undo;
      var flipRef = react.useRef(null);
      useFlipReorder(flipRef);
      function refresh(silent) { if (!silent) setSnapshot({ loading: true, error: null, data: snapshot.data }); return callApi("/state").then(function (data) { setSnapshot({ loading: false, error: null, data: data }); return data; }).catch(function (error) { setSnapshot({ loading: false, error: translateError(t, error), data: snapshot.data }); }); }
      react.useEffect(function () { refresh(false); }, []);
      function post(path, body, successKey, successParams) { if (inflightRef.current) return Promise.reject({ error: "operation already in progress" }); inflightRef.current = true; setBusy(true); setResult(null); return callApi(path, { body: JSON.stringify(body || {}) }).then(function (data) { var warn = joinWarn(sceneSyncWarn(t, data), stateSyncWarn(t, data)); setResult({ ok: !warn, warning: !!warn, text: (successKey ? t(successKey, successParams || data || {}) : t("result.updated")) + (warn ? " " + warn : "") }); return refresh(true).then(function () { return data; }); }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); throw error; }).finally(function () { inflightRef.current = false; setBusy(false); }); }
      /** post 把失败写进 setResult 后会 re-throw 供链式消费；不消费的调用方挂它吞掉重抛，
          否则控制台全是 unhandled rejection（失败反馈本身 post 已经给过了）。 */
      function swallowPostError() {}
      function openDetail(root, skill) {
        // 详情弹窗的请求序号（配合 closeModal）：载荷里不带"我是哪个技能"，连点两条时
        // 先发的响应可能后到并顶掉后发的那份 —— 序号对不上就丢弃。
        var seq = ++detailSeqRef.current;
        setBusy(true); setDetail(null); setModal("detail");
        callApi("/detail", { body: JSON.stringify({ root: root.key, name: skill.name }) })
          .then(function (data) { if (seq === detailSeqRef.current) setDetail(data); })
          .catch(function (error) {
            if (seq !== detailSeqRef.current) return;
            setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); setModal(null);
          })
          .finally(function () { setBusy(false); });
      }
      /** 关闭本页弹窗：先作废在途的详情响应（否则晚到的那份会把弹窗重新打开），再清 modal。 */
      function closeModal() { detailSeqRef.current += 1; setModal(null); }
      function openSource() { if (!detail || !detail.path) return; setBusy(true); setResult(null); apiCall("skill-open", { path: detail.path }).then(function (res) { if (res && res.ok) setResult({ ok: true, text: t("result.opened", { path: detail.path }) }); else setResult({ ok: false, text: t("error.action", { error: translateError(t, res) }) }); }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); }); }
      function updateForm(key, value) { setForm(Object.assign({}, form, { [key]: value })); }
      // 自定义技能目录：添加 / 移除（走 skill-custom-* ops，成功后静默刷新）。
      function openCustomDir() {
        if (busy) return;
        setCustomForm(Object.assign({}, customForm, { picking: true }));
      }
      function submitCustomAdd() {
        var payload = { path: String(customForm.path || "").trim(), label: String(customForm.label || "").trim() };
        if (!payload.path) return;
        setBusy(true); setResult(null);
        apiCall("skill-custom-add", payload).then(function (res) {
          if (res && res.ok) { setResult({ ok: true, text: t("result.custom.added", { path: res.data && res.data.path || payload.path }) }); setCustomForm({ path: "", label: "" }); setModal(null); return refresh(true); }
          setResult({ ok: false, text: (res && res.error) || t("error.action", { error: "unknown" }) });
        }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); });
      }
      function submitCustomRemove(key, name) {
        setBusy(true); setResult(null);
        apiCall("skill-custom-remove", { key: key }).then(function (res) {
          if (res && res.ok) { setResult({ ok: true, text: t("result.custom.removed", { name: name }) }); setModal(null); return refresh(true); }
          setResult({ ok: false, text: (res && res.error) || t("error.action", { error: "unknown" }) });
        }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); });
      }
      // 回收站「目录」的永久删除：把这条来源记录从插件里删掉（磁盘上的文件夹与文件不动，
      // 这也正是「移除来源」与「永久删除」的区别）。与「自定义目录」的移除是同一个 op ——
      // 只有自定义来源有记录可删，按约定发现的外部来源（agents/codex/claude）删不掉，
      // 所以界面上只对 root.custom === true 的行给这个按钮。
      function submitSourceForget(key, name) {
        setBusy(true); setResult(null);
        apiCall("skill-custom-remove", { key: key }).then(function (res) {
          setModal("trash");
          if (res && res.ok) { setResult({ ok: true, text: t("result.sourceForgotten", { name: name }) }); return refresh(true); }
          setResult({ ok: false, text: t("error.action", { error: translateError(t, res) }) });
        }).catch(function (error) { setModal("trash"); setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); }).finally(function () { setBusy(false); });
      }
      function submitCreate() { post("/create", form, null).then(function (data) { setModal(null); setForm({ root: "dsh", name: "", description: "", body: "" }); setResult(function (prev) { return Object.assign({ ok: true, warning: false }, prev || {}, { text: t("result.created", { name: data.name }) }); }); }).catch(swallowPostError); }
      function selectUploadFiles(files) { pickerOpenRef.current = false; var selected = inspectUploadSelection(files); if (!selected) return; if (selected.error) { setUpload(null); setResult({ ok: false, text: translateError(t, selected.error) }); return; } setUpload(selected); setResult(null); }
      /** D14：导出条目 = 按**来源文件夹**分组，组内列出该文件夹里的全部技能（含同名被遮蔽的）。 */
      function exportItems() {
        var out = [];
        for (var i = 0; i < allRoots.length; i++) {
          var root = allRoots[i], list = root.skills || [];
          var group = rootDisplayName(t, root);
          for (var j = 0; j < list.length; j++) {
            var sk = list[j];
            // key 用**条目名**（文件 / 目录名），不是 frontmatter 里的展示名：服务端按它定位源文件，
            // 用 declaredName 会在「文件名 ≠ 声明名」时找不到文件（静默丢项）。
            var nm = String(sk.name || "");
            if (!nm) continue;
            out.push({ key: String(root.key) + "/" + nm, name: String(sk.declaredName || nm), desc: sk.description || "", group: group });
          }
        }
        return out;
      }
      function doExport(names, outDir) {
        setBusy(true); setResult(null);
        apiCall("bundle-export", { kind: "skills", names: names, outDir: outDir }).then(function (res) {
          setBusy(false);
          if (res && res.ok) setResult({ ok: true, text: exportResultText(t, res) });
          else setResult({ ok: false, text: translateError(t, res) });
        }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }); });
      }
      function submitImport(selection) { var sel = selection || upload; if (!sel) return; buildUploadPayload(sel).then(function (payload) { return post("/upload", payload, null); }).then(function (data) { var summary = summarizeImportResult(t, data); setResult({ ok: summary.ok, warning: summary.warning, text: summary.text }); if (summary.imported) { setModal(null); setUpload(null); } }).catch(function (e) { setBusy(false); setResult({ ok: false, text: t("error.action", { error: translateError(t, e) }) }) }); }
      var anyLocked = !!(snapshot.data && snapshot.data.anyLocked === true);
      // 场景内开关由档案定义：技能开关 / 来源开关 / 首选都置灰（用户裁定）。
      var sceneName = (snapshot.data && snapshot.data.activeScene) || null;
      var data = snapshot.data || { roots: [], trash: [], summary: { total: 0, enabled: 0, disabled: 0, issues: 0 } }, allRoots = data.roots || [];
      // `roots` 的键必须在数据未变时保持不变：下面那份 skillView 以它为依赖（每次渲染新建
      // 一个数组会让 memo 永远失效，等于白做）。
      var roots = react.useMemo(function () { return visibleSkillRoots(allRoots); }, [allRoots]);
      var removedRoots = removedSkillRoots(allRoots), activeSource = roots.some(function (root) { return root.key === source; }) ? source : "";
      /**
       * 每来源的「搜索过滤结果」与「批量目标集」，一次算好。
       *
       * 原先这两件事都发生在渲染途中：每个来源各过滤一遍技能（每次都要 `Object.assign` 补
       * 派生字段），每张来源卡再各算一次批量目标集 —— `bulkTargets` 自己又会重扫全部来源 ×
       * 技能，于是单次渲染就是 O(来源² × 技能)，而点任何一颗开关都会重渲染。
       */
      var skillView = react.useMemo(function () {
        var filtered = {}, targets = {}, all = [];
        for (var i = 0; i < roots.length; i++) {
          var root = roots[i];
          var displayName = rootDisplayName(t, root);
          filtered[root.key] = (root.skills || []).filter(function (skill) { return matchSkillQuery(Object.assign({}, skill, { rootKey: root.key, rootLabel: displayName }), dq); });
          var list = [];
          // 与 bulkTargets 同一口径：来源级开关关掉的不参与；页头那颗还受来源筛选约束。
          if (root.toggleable !== false && root.enabled !== false && !(activeSource && activeSource !== root.key)) {
            var skills = root.skills || [];
            for (var j = 0; j < skills.length; j++) {
              var sk = skills[j];
              if (sk.loadable === false || sk.shadowedBy) continue;
              if (!matchSkillQuery(Object.assign({}, sk, { rootKey: root.key, rootLabel: displayName }), dq)) continue;
              list.push({ root: root.key, name: sk.name, on: isSkillEnabled(sk) });
            }
          }
          targets[root.key] = list;
          all = all.concat(list);
        }
        targets[""] = all;
        return { filtered: filtered, targets: targets };
      }, [roots, dq, activeSource, t]);
      var createRoots = allRoots.filter(function (root) { return root.mutable === true; }), createOptions = createRoots.map(function (root) { return { value: root.key, label: rootDisplayName(t, root) }; }); if (!createOptions.length) createOptions.push({ value: "hub", label: t("root.hub") });
      // 新建技能的默认落点：hub（`tool-management/skills/`）。
      // 用户在技能页筛选了某个来源时，优先用那个来源；两者都不可用时退回 dsh。
      function defaultCreateRoot() {
        if (createRoots.some(function (root) { return root.key === activeSource; })) return activeSource;
        if (createRoots.some(function (root) { return root.key === "hub"; })) return "hub";
        return "dsh";
      }
      function openCreate() { setForm(Object.assign({}, form, { root: defaultCreateRoot() })); setModal("create"); }
      // 项目作用域的来源不一定带 projectName / projectRoot（hub「导入技能」就没有），
      // 旧实现直接拼字符串会把字面量 "undefined" 显示到回收站里。
      function trashRootLabel(item) {
        var root = (item && item.root) || {};
        // 用户级可写来源不止 dsh（hub 也能删，而且是「导入技能」页删除的主战场）：
        // 走和来源卡片同一套显示名解析，别把 hub 的条目显示成「DSH 技能」。
        if (root.scope !== "project") return rootDisplayName(t, root) || t("root.dsh");
        var owner = root.projectName || root.projectRoot || "";
        if (!owner) {
          var byKey = root.localeKey || root.key;
          owner = (byKey ? translateOrFallback(t, "root." + byKey, "") : "") || root.label || "";
        }
        return owner ? t("root.projectDsh") + " · " + owner : t("root.projectDsh");
      }
      var options = [{ value: "", label: t("filter.all") }].concat(roots.map(function (root) { return { value: root.key, label: t("filter.option", { name: rootDisplayName(t, root), count: root.count == null ? root.skills.length : root.count }) }; }));

      // 同名技能：默认按来源优先级取一个生效，其余显示为「被覆盖」。
      // 「启用这个」= 把这个来源设为同名首选 + 启用它（只写本地策略，不动任何源文件）。
      function activateShadowed(root, skill) {
        // 来源整体停用时，切首选 + 单点启用都不会真的生效：先如实说明，别给「已改为生效」的假回执。
        if (root.enabled === false) {
          setResult({ ok: false, text: t("error.root.disabled", { name: rootDisplayName(t, root) }) });
          return;
        }
        post("/prefer", { root: root.key, name: skill.name }, null)
          .then(function () { return post("/enable", { root: root.key, name: skill.name }, null); })
          .then(function () { setResult({ ok: true, text: t("result.preferred", { name: skill.declaredName || skill.name, source: rootDisplayName(t, root) }) }); })
          .catch(swallowPostError);
      }
      function clearPreferred(root, skill) {
        post("/unprefer", { root: root.key, name: skill.name }, null)
          .then(function () { setResult({ ok: true, text: t("result.unpreferred", { name: skill.declaredName || skill.name }) }); })
          .catch(swallowPostError);
      }
      function renderSkill(root, skill) {
        var enabled = isSkillEnabled(skill), key = skill.shadowedBy ? "status.shadowed" : skill.loadable === false ? "status.invalid" : enabled ? "status.enabled" : "status.disabled", cls = skill.shadowedBy ? "dsm-shadowed" : enabled ? "dsm-enabled" : "dsm-disabled";
        var canToggle = root.toggleable !== false && skill.loadable !== false;
        return h("div", { key: skill.name, className: "dsm-row", "data-flip-key": root.key + "/" + skill.name, "data-flip-on": enabled ? "1" : "0" }, h("div", { className: "dsm-main" }, h("div", { className: "dsm-name" }, skill.declaredName || skill.name), h("div", { className: "dsm-note" }, skill.description || t("note.missing")), skill.shadowedBy ? h("div", { className: "dsm-rule-hint" }, t("status.shadowed.hint", { name: skill.shadowedBy.name })) : null), h("div", { className: "dsm-tags" }, h("span", { className: "dsm-tag" }, rootDisplayName(t, root)), skill.preferred === true ? h("span", { className: "dsm-tag dsm-tag-on" }, t("status.preferred")) : null, !root.mutable ? h("span", { className: "dsm-tag" }, t("status.readonly")) : null, root.mutable && !root.deletable ? h("span", { className: "dsm-tag", title: t("status.notDeletable.hint") }, t("status.notDeletable")) : null), h("div", { className: "dsm-status " + cls }, t(key)), h("div", { className: "dsm-row-actions" }, canToggle && skill.shadowedBy ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy, title: t("btn.activate.title"), onClick: function () { activateShadowed(root, skill); } }, t("btn.activate")) : null, canToggle && !skill.shadowedBy ? h(Switch, { on: enabled, disabled: busy || root.enabled === false || anyLocked, label: t("skill.toggle") + " " + skill.name, onClick: function () { post(enabled ? "/disable" : "/enable", { root: root.key, name: skill.name }); } }) : null, skill.preferred === true ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy, title: t("btn.unprefer.title"), onClick: function () { clearPreferred(root, skill); } }, t("btn.unprefer")) : null, h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { openDetail(root, skill); } }, t("btn.detail")), root.deletable === true ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { setModal({ type: "trash-confirm", root: root.key, name: skill.name }); } }, t("btn.trash")) : null));
      }
      function renderRoot(root) {
        if (activeSource && activeSource !== root.key) return null;
        var displayName = rootDisplayName(t, root), filtered = skillView.filtered[root.key] || []; if (dq && !filtered.length) return null; var open = !!expanded[root.key] || !!dq;
        var rootCount = root.count == null ? root.skills.length : root.count;
        var section = h("section", { key: root.key, className: "dsm-source" }, h("div", { className: "dsm-source-head" }, h("button", { type: "button", className: "dsm-source-head-main", "aria-expanded": open, onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: !open })); } }, h("span", { className: "dsm-source-title", title: displayName }, displayName), h("span", { className: "dsm-count" }, t(countKey("summary.group", rootCount), { count: rootCount })), h("span", { className: "dsm-tag " + (root.scope === "project" ? "dsm-tag-on" : root.defaultSource === true ? "" : root.enabled ? "dsm-tag-on" : "dsm-tag-off") }, root.scope === "project" ? t("status.project") : root.defaultSource === true ? t("status.manageable") : t(root.enabled ? "status.source.on" : "status.source.off")), root.scope === "project" ? h("span", { className: "dsm-tag" }, t("status.rank", { rank: root.rank })) : null, h("span", { className: "dsm-path", title: root.path }, root.path)), (function () {
          // 目录级「全选 / 取消全选」（用户裁定 2026-09-17）：只作用于**这个目录下当前
          // 可见且可切换**的技能 —— 与页头那颗同一套目标集逻辑（bulkTargets 传 rootKey），
          // 同名技能只算生效的那一个（被覆盖的副本跳过）。
          // 默认来源（可管理 / DSH 技能）没有来源开关，这颗按钮就独占右侧位置。
          var bulk = bulkState(root.key);
          var showSwitch = root.scope !== "project" && root.defaultSource !== true && root.toggleable !== false;
          var acts = [];
          // 点这颗按钮**顺带把卡片展开**（用户裁定 2026-09-17）：批量开关的结果就在下面这几行里，
          // 卡片收着的话点完只剩按钮文案从「全选」变成「取消全选」，到底改了哪几个技能看不见。
          // 只展开、不收起 —— 两个方向（全选 / 取消全选）都要能看见结果，收起是点卡片头的事。
          if (bulk.targets.length) acts.push(h("button", { key: "all", type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-bulk", disabled: busy || anyLocked, title: t("source.bulk.title"), onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: true })); submitBulk(bulk.targets, !bulk.on, root.key); } }, bulkPair(bulk.on ? t("bulk.unselectAll") : t("bulk.selectAll"), bulk.on ? t("bulk.selectAll") : t("bulk.unselectAll"))));
          if (showSwitch) {
            // 「移除来源」只留图标（用户裁定 2026-09-17）：它是低频的破坏性操作，却和「全选」
            // 并列、还带红框描边 —— 于是整行的视觉重心落在它身上，四字宽度也占地方。
            // 图标按钮必须自带 title + aria-label（没有可见文字）；点击照旧弹确认弹窗，
            // 那里仍是带文字的红色「移除来源」，破坏性操作的说明没有丢。
            if (root.removable === true) acts.push(h("button", { key: "rm", type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger dsm-btn-icon", disabled: busy, title: t("btn.source.remove.title"), "aria-label": t("btn.source.remove.title"), onClick: function () { setModal({ type: "source-remove-confirm", key: root.key, name: displayName }); } }, h(TrashIcon, { size: 14 })));
            // 开关来源时**顺带把卡片展开**（用户裁定 2026-09-17），与旁边那颗「全选」同口径：
            // 启停的结果就是下面这些技能行（开启 = 整目录可用了，关闭 = 逐行变停用），卡片收着
            // 的话点完只剩标签从「已停用」变「已启用」，目录里到底有什么、哪些真的可用了看不见。
            // 只展开、不收起 —— 两个方向都要能看见结果，收起仍然是点卡片头那一行的事。
            acts.push(h(Switch, { key: "sw", on: root.enabled, disabled: busy || anyLocked, label: t("source.toggle") + " " + displayName, onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: true })); post(root.enabled ? "/source-disable" : "/source-enable", { root: root.key }).then(function () { dropUndoForRoot(root.key, displayName); }); } }));
          }
          return acts.length ? h("span", { className: "dsm-source-actions" }, acts) : null;
        })()), open ? h("div", { className: "dsm-source-body" }, filtered.length ? h(react.Fragment, null, h("div", { className: "dsm-table-head" }, h("span", null, t("table.skill")), h("span", null, t("filter.source")), h("span", null, t("table.status")), h("span", null, "")), enabledFirst(filtered, function (skill) { return isSkillEnabled(skill); }).map(function (skill) { return renderSkill(root, skill); })) : h("div", { className: "dsm-empty" }, dq ? t("empty.search") : t("empty.source"))) : null);
        // 目录那颗「全选」的撤销条贴在这张卡片上方：它只作用于这个目录，而页头那颗的撤销条
        // 在搜索框下面（见 content）。撤销条跟着**触发它的按钮**走，别让人回头找。
        return h(react.Fragment, { key: root.key },
          undo && undo.scope === root.key ? h(UndoBar, { key: "undo", undo: undo, busy: busy, t: t, onUndo: undoBulk, onClose: dismissUndo }) : null,
          section);
      }

      var summary = data.summary || { total: 0, enabled: 0, disabled: 0, issues: 0 };
      /**
       * 批量启停的目标集 = 当前**可见**（搜索 + 来源筛选命中）且**可切换**的技能。
       * 条件与单条 Switch 逐字一致（来源可切换、来源没被停用、技能可加载、不是被覆盖的副本），
       * 否则会出现「全选说 12 个、实际只改了 9 个」的假回执。
       *
       * 不传 rootKey → 页头那颗按钮的作用集（全部可见来源）；传 rootKey → 某个目录卡片上
       * 那颗按钮的作用集（只看这一个目录）。同名技能只算**生效的那一个**（被覆盖的副本
       * `shadowedBy` 跳过）——这正是「全选后同名技能只有被启用的那个被勾」的由来。
       */
      function bulkTargets(rootKey) {
        // 目标集在 `skillView` 里一次算好（键 `""` = 页头那颗：全部可见来源）。
        return skillView.targets[rootKey || ""] || [];
      }
      /** 一组批量目标 + 是否已全开（二合一按钮的两个入参）。 */
      function bulkState(rootKey) {
        var targets = bulkTargets(rootKey);
        return { targets: targets, on: targets.length > 0 && targets.every(function (x) { return x.on; }) };
      }
      /**
       * 批量启停。`scope` 说明触发它的是哪一级按钮：`null` = 页头那颗（作用于全部可见来源），
       * 其它 = 某个目录的 key。撤销条据此决定贴在哪里 —— 页头那颗的贴在搜索框下面，目录那颗的
       * 贴在那张卡片上方。撤销条跟着**触发它的按钮**走，别让人回头找（用户裁定 2026-09-18）。
       */
      function submitBulk(items, enabled, scope) {
        if (!items || !items.length) return;
        setBusy(true); setResult(null);
        apiCall("skill-set-all", {
          items: items.map(function (x) { return { root: x.root, name: x.name }; }),
          enabled: enabled,
        }).then(function (res) {
          if (res && res.ok) {
            var payload = (res && res.data) || {};
            var failed = (payload.failed || []).length;
            // 场景内批量开关同样会同步写档案；没跟上就说出来（详见 sceneSyncWarn）。
            var syncWarn = sceneSyncWarn(t, res);
            // 「本次改了几个」= 选中集里**状态确实和目标不同**的那些，不能用服务端回的 `changed`：
            // 它的语义是「成功处理了几个」—— 对一个本来就启用的技能再启用一次，它照样 +1。
            // 实测代价：2 个里只有 1 个真变，却报「已启用 2 个」，连带把「当前共几个启用」也算成 3
            // （实际 2）。`items[].on` 是渲染这一帧读到的开关，正好就是操作前的值，与撤销条同源 ——
            // 结果提示和撤销提示因此不可能再各说各的。
            var changedN = 0;
            for (var k = 0; k < items.length; k++) if (items[k].on !== enabled) changedN += 1;
            setResult({
              ok: failed === 0 && !syncWarn,
              warning: failed > 0 || !!syncWarn,
              text: t("bulk.done.skills", {
                action: t(enabled ? "bulk.enabled" : "bulk.disabled"),
                // 失败的那些没能改成，从改动数里减掉。
                count: Math.max(0, changedN - failed),
                failed: failed,
              }) + (syncWarn ? " " + syncWarn : ""),
            });
            // 全部成功才给撤销条：部分失败时用户该看的是失败原因，而不是再叠一条「撤销」。
            if (failed === 0) {
              // 「当前共 N 个启用」由操作前的快照加减本次改动数得出：`summary` 来自刷新前那一帧，
              // 正好就是操作前的值（撤销条就在这个 .then 里生成，刷新还没回来）。
              setUndo({
                text: t("undo.skills", {
                  action: t(enabled ? "bulk.enabled" : "bulk.disabled"),
                  count: changedN,
                  enabled: enabled ? summary.enabled + changedN : summary.enabled - changedN,
                }),
                items: items,
                revert: function (item) { return apiCall("skill-set-all", { items: [{ root: item.root, name: item.name }], enabled: item.on }); },
                scope: scope || null,
                // 涉及的来源集合（去重）：来源状态一变，这条撤销就不再成立，见 dropUndoForRoot。
                roots: items.map(function (x) { return x.root; }).filter(function (v, i, a) { return a.indexOf(v) === i; }),
              });
            }
            refresh(true);
          } else setResult({ ok: false, text: translateError(t, res) });
        }).catch(function (e) { setResult({ ok: false, text: errMsg(e) }); }).finally(function () { setBusy(false); });
      }
      /** 撤销批量启停：按操作前的状态逐条写回（`items[].on` 就是当时的开关）。 */
      function undoBulk() {
        if (!undo) return;
        var entry = undo;
        setUndo(null); setBusy(true);
        runUndo(entry).then(function (failed) {
          setBusy(false);
          setResult(failed ? { ok: false, text: t("undo.failed", { count: failed }) } : { ok: true, text: t("undo.done") });
          refresh(true);
        });
      }
      /**
       * 来源启停后收起撤销条 —— 否则它就是一条「点了没反应」的提示。
       *
       * 为什么会失效：撤销只写**技能级**开关（`skill-set-all`），而来源停用是**上层**开关 ——
       * 界面按来源状态决定技能是否启用，所以那些写入不会体现在列表里（请求还照样返回成功：
       * 服务端 `setSkillEnabled` 不检查来源是否已停用）。同时条上那句「当前共 N 个启用」是
       * 操作时的快照，来源一变就已经不准。承诺不成立，就别留着。
       *
       * 读 `undoRef` 而不是闭包里的 `undo`：点开关到请求返回之间用户可能已经点过撤销，
       * 那时撤销条早没了，不该再补一句「不再可撤销」。
       */
      function dropUndoForRoot(key, label) {
        var current = undoRef.current;
        if (!current || (current.roots || []).indexOf(key) < 0) return;
        setUndo(null);
        // 合并而不是覆盖：post 刚设的「已更新」还在同一条提示里，两者一起说。
        setResult(function (prev) {
          return {
            ok: true,
            text: (prev && prev.text ? prev.text + " " : "") + t("undo.dropped.source", { root: label }),
          };
        });
      }
      var bulkAll = bulkState();
      var content = [h("style", { key: "css" }, CSS), h("div", { key: "head", className: "dsm-head" }, h("div", { className: "dsm-title-block" }, h("div", { className: "dsm-title-row" }, h("h2", { className: "dsm-title" }, t("title"))), h("p", { className: "dsm-desc" }, t("desc"))), h("div", { className: "dsm-actions" }, refreshButton(t, busy || snapshot.loading, { className: "dsm-btn dsm-btn-secondary", disabled: busy || snapshot.loading, onClick: function () { refresh(false); } }), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: anyLocked, onClick: openCreate }, t("btn.create")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: anyLocked, onClick: function () { setResult(null); setUpload(null); setModal("import"); } }, t("btn.import")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: function () { setResult(null); setModal("export"); } }, t("export.skills")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: function () { setResult(null); setCustomForm({ path: "", label: "" }); setModal("custom-add"); } }, t("btn.custom.add")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal("trash"); } }, t("trash.btn.open")), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary dsm-btn-bulk", disabled: busy || anyLocked || !bulkAll.targets.length, title: t("bulk.head.title"), onClick: function () { submitBulk(bulkAll.targets, !bulkAll.on, null) } }, bulkPair(bulkAll.on ? t("bulk.unselectAll") : t("bulk.selectAll"), bulkAll.on ? t("bulk.selectAll") : t("bulk.unselectAll"))))), anyLocked ? h("div", { key: "lockbanner", className: "dsm-feedback dsm-warning", role: "status" }, t("lock.banner")) : null,
      // 锁定期间不显示场景那条长句：开关全是灰的，"改动会同步写进档案"没有落点，
      // 两条并排还会互相矛盾（用户 2026-09-19）。
      (!anyLocked && sceneName) ? h("div", { key: "scenebanner", className: "dsm-feedback dsm-warning", role: "status" }, t("scene.switch.banner", { scene: sceneName })) : null,
      h("div", { key: "summary", className: "dsm-summary" }, [[summary.total, "summary.total"], [summary.enabled, "summary.enabled"], [summary.issues, "summary.issues"]].map(function (item) { return h("div", { key: item[1], className: "dsm-stat" }, h("strong", null, item[0]), t(countKey(item[1], item[0]), { count: item[0] }).replace(String(item[0]), "")); })), h("div", { key: "filters", className: "dsm-filters" }, h("input", { className: "dsm-control dsm-search", value: query, "aria-label": t("search"), placeholder: t("search.placeholder"), onChange: function (e) { setQuery(e.target.value); } }), h("div", { className: "dsm-source-filter" }, h(SourceSelect, { value: activeSource, options: options, onChange: setSource }))), undo && undo.scope == null ? h(UndoBar, { key: "undo", undo: undo, busy: busy, t: t, onUndo: undoBulk, onClose: dismissUndo }) : null, result && modal !== "import" ? h(Notice, { key: "result", kind: result.warning ? "warn" : result.ok ? "ok" : "err", text: result.text }) : null].concat((data.warnings || []).map(function (warning, index) { return h(Notice, { key: "warning-" + index, kind: "warn", text: translateError(t, warning) }); }), [snapshot.error ? h(Notice, { key: "error", kind: "err", text: snapshot.error }) : null, snapshot.loading && !snapshot.data ? h("div", { key: "loading", className: "dsm-empty" }, t("loading")) : h("div", { key: "sources", className: "dsm-sources", ref: flipRef }, roots.map(renderRoot))]);

      if (modal === "create") content.push(h(Modal, { key: "create", title: t("create.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.target")), h(SourceSelect, { value: form.root, options: createOptions, onChange: function (value) { updateForm("root", value); } })), [["name", "create.name", "create.name.placeholder"], ["description", "create.description", "create.description.placeholder"]].map(function (field) { return h("label", { key: field[0], className: "dsm-field" }, h("span", { className: "dsm-label" }, t(field[1])), h("input", { className: "dsm-control", value: form[field[0]], placeholder: t(field[2]), onChange: function (e) { updateForm(field[0], e.target.value); } })); }), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.body")), h("textarea", { className: "dsm-control", value: form.body, placeholder: t("create.body.placeholder"), onChange: function (e) { updateForm("body", e.target.value); } })), h("p", { className: "dsm-help" }, t("create.chat.note"))), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn", disabled: busy || !form.name.trim() || !form.description.trim() || !form.body.trim(), onClick: submitCreate }, t("btn.create.now")))));
      // D13：导入弹窗统一用共享 ImportModal（能力取三者并集：拖拽区 + 已选文件行 +
      // 文件要求清单 + 结果反馈）。技能页只保留自己的校验与提交逻辑。
      if (modal === "import") content.push(h(ImportModal, {
        key: "import", t: t, title: t("import.title"), accept: ".zip,.md",
        busy: busy, result: result,
        requirements: [t("upload.requirement.skill"), t("upload.requirement.frontmatter"), t("upload.requirement.copy")],
        onClose: function () { pickerOpenRef.current = false; setUpload(null); setResult(null); setModal(null); },
        onSubmit: function (entries, files) {
          var selected = inspectUploadSelection(files);
          if (!selected) return;
          if (selected.error) { setResult({ ok: false, text: translateError(t, selected.error) }); return; }
          setUpload(selected);
          submitImport(selected);
        },
      }));
      if (modal === "detail") content.push(h(Modal, { key: "detail", wide: true, title: t("detail.title"), closeLabel: t("btn.close"), onClose: closeModal }, detail ? h(react.Fragment, null, h("div", { className: "dsm-detail-path" }, detail.path), h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openSource }, t("btn.open.editor"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.diagnostics")), detail.diagnostics.length ? detail.diagnostics.map(function (item, index) { return h("div", { key: index, className: "dsm-diag" }, t(item.code, item.params || {})); }) : h("div", { className: "dsm-note" }, t("detail.noIssues"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.frontmatter")), renderFrontmatter(t, detail.frontmatter)), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.body")), h("pre", { className: "dsm-code" }, detail.body || ""))) : h("div", { className: "dsm-empty" }, t("loading"))));
      if (modal === "export") content.push(h(ExportModal, {
        key: "export", t: t, title: t("export.skills"),
        items: exportItems(), busy: busy, result: result,
        onClose: function () { setResult(null); setModal(null); },
        onSubmit: doExport,
      }));
      // 回收站分两部分：**目录**（被「移除来源」的目录，插件不再读取）与**技能**（移入
      // 回收站的技能）。两部分都给了「恢复」，永久删除在两边都指向"记录/文件真的没了"：
      // 目录那边只删插件里的来源记录（磁盘上的文件夹一个字节都不动），技能那边才删文件。
            if (modal === "trash") {
        // 技能回收站里是**两类后果不同**的东西，弹窗里上下两块（用户要求「弹窗里嵌两个小弹窗」）：
        //   上「不再读取的来源」——插件只是不再扫它，磁盘一个字节都不动（中性色，恢复读取 / 删除记录）；
        //   下「回收站里的技能」——文件真的被移走了，永久删除会真删；两块的「永久删除」按钮都是红色。
        // 两块各自滚动，**大弹窗自己不滚**；两块一直在（空的那块显示自己的空态），别让人以为它没了。
        // 卡片结构复用共享回收站的 .dsm-trash-group（组头 + 计数 + 后果说明 + 行列表），观感与其它页一致。
        var skillTrashRows = data.trash || []
        var removedSourceRows = removedRoots || []
        function trashPane(key, title, count, note, danger, rows, emptyText) {
          return h("div", { key: key, className: "dsm-trash-group" + (danger ? " dsm-trash-group-danger" : "") },
            h("div", { className: "dsm-trash-group-head" },
              h("div", { className: "dsm-trash-group-head-row" },
                h("span", { className: "dsm-trash-group-title" }, title),
                h("span", { className: "dsm-count" }, count)),
              h("p", { className: "dsm-trash-group-sub" }, note)),
            h("div", { className: "dsm-trash-pane-body" }, rows.length ? rows : h("div", { className: "dsm-empty" }, emptyText)))
        }
        content.push(h(Modal, { key: "trash-modal", title: t("trash.title"), closeLabel: t("btn.close"), list: true, className: "dsm-modal-list dsm-modal-trash-split", onClose: function () { setModal(null); } },
          h("div", { className: "dsm-trash-split" },
            trashPane("pane-dirs", t("trash.section.dirs"), t(countKey("trash.dirs.count", removedSourceRows.length), { count: removedSourceRows.length }), t("trash.section.dirs.sub"), false,
              removedSourceRows.map(function (root) {
                var name = rootDisplayName(t, root)
                return h("div", { key: root.key, className: "dsm-trash-item" },
                  h("div", { className: "dsm-trash-main" },
                    h("div", { className: "dsm-name" }, name),
                    h("div", { className: "dsm-note", title: root.path }, root.path)),
                  h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy, onClick: function () { post("/source-restore", { root: root.key }, "result.sourceRestored", { name: name }); } }, t("btn.source.restore")),
                  root.custom === true ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy, onClick: function () { setModal({ type: "source-forget-confirm", key: root.key, name: name, path: root.path }); } }, t("btn.source.forget")) : null)
              }),
              t("trash.section.dirs.empty")),
            trashPane("pane-skills", t("trash.section.skills"), t(countKey("trash.count", skillTrashRows.length), { count: skillTrashRows.length }), t("trash.section.skills.sub"), false,
              skillTrashRows.map(function (item) {
                return h("div", { key: item.id, className: "dsm-trash-item" },
                  h("div", { className: "dsm-trash-main" },
                    h("div", { className: "dsm-name" }, item.name),
                    h("div", { className: "dsm-note" }, t("trash.deletedAt", { time: new Date(item.deletedAt).toLocaleString() }))),
                  h("button", { className: "dsm-btn dsm-btn-quiet", disabled: busy, onClick: function () { post("/trash-restore", { id: item.id }, "result.restored", { name: item.name }); } }, t("btn.restore")),
                  h("button", { className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy, onClick: function () { setModal({ type: "delete-confirm", id: item.id, name: item.name }); } }, t("btn.delete.forever")))
              }),
              t("trash.empty")))))
      }
      if (modal && modal.type === "source-forget-confirm") content.push(h(Modal, { key: "source-forget-confirm", title: t("confirm.source.forget.title"), closeLabel: t("btn.close"), onClose: function () { setModal("trash"); } }, h("p", { className: "dsm-desc" }, t("confirm.source.forget.desc", { name: modal.name })), h("p", { className: "dsm-help" }, t("confirm.source.forget.hint", { path: modal.path })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { submitSourceForget(modal.key, modal.name); } }, t("btn.delete.forever")))));
      if (modal && modal.type === "trash-confirm") content.push(h(Modal, { key: "trash-confirm", title: t("confirm.trash.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.trash.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn", disabled: busy, onClick: function () { post("/delete", { root: modal.root, name: modal.name }, "result.trashed", { name: modal.name }).then(function () { setModal(null); }).catch(swallowPostError); } }, t("btn.trash")))));
      if (modal && modal.type === "delete-confirm") content.push(h(Modal, { key: "delete-confirm", title: t("confirm.delete.title"), closeLabel: t("btn.close"), onClose: function () { setModal("trash"); } }, h("p", { className: "dsm-desc" }, t("confirm.delete.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { post("/trash-delete", { id: modal.id }, "result.deleted", { name: modal.name }).then(function () { setModal("trash"); }).catch(swallowPostError); } }, t("btn.delete.forever")))));
      if (modal === "custom-add") content.push(h(Modal, { key: "custom-add", title: t("custom.add.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.path")), h("div", { className: "dsm-dir-row" }, h("input", { className: "dsm-control", value: customForm.path, placeholder: t("custom.add.path.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { path: e.target.value })); } }), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openCustomDir, title: t("custom.add.openDir.title") }, t("btn.openDir")))), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.label")), h("input", { className: "dsm-control", value: customForm.label, placeholder: t("custom.add.label.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { label: e.target.value })); } })), h("p", { className: "dsm-help" }, t("custom.add.help")), result ? h("div", { className: "dsm-feedback" + (result.warning ? " dsm-warning" : result.ok ? "" : " dsm-error"), role: "alert" }, result.text) : null), customForm.picking ? h(DirPickerModal, { key: "custom-dir-picker", title: t("custom.add.picker.title"), initial: String(customForm.path || ""), closeLabel: t("btn.close"), onClose: function () { setCustomForm(Object.assign({}, customForm, { picking: false })); }, onPick: function (path) { setCustomForm(Object.assign({}, customForm, { path: path, picking: false })); } }) : null, h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn", disabled: busy || !String(customForm.path || "").trim(), onClick: submitCustomAdd }, t("custom.add.submit")))));
      if (modal && modal.type === "source-remove-confirm") content.push(h(Modal, { key: "source-remove-confirm", title: t("confirm.source.remove.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.source.remove.desc", { name: modal.name })), h("p", { className: "dsm-help" }, t("confirm.source.remove.hint")), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { post("/source-remove", { root: modal.key }, "result.sourceRemoved", { name: modal.name }).then(function () { setModal(null); }).catch(swallowPostError); } }, t("btn.source.remove")))));
      if (modal && modal.type === "custom-remove-confirm") content.push(h(Modal, { key: "custom-remove-confirm", title: t("confirm.custom.remove.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.custom.remove.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { submitCustomRemove(modal.key, modal.name); } }, t("btn.custom.remove")))));
      return h("section", { className: "dsm-section" }, content);
    }

        // NS / t 与 locale 绑定已提到 apply 开头（见上方「取词服务」段）：
        // 设置页的导航标题是**注册期**取值，晚绑定会让它在英文界面下永远是中文。
        // ---------- History 页（归档会话管理：恢复 / 永久删除 / 保留期）----------
        // 折叠自 dsh-archive-manager 的归档会话设置页，但客户端经本插件 HTTP API
        // 驱动（history-list / -archive / -unarchive / -delete / -retention-*），不依赖
        // ui-workspace 客户端 store 或 typert remote——会话标题由 host 端 best-effort 读取。
        /**
         * 会话列表的视图（过滤 + 按项目分组 + 逐组排序）。
         *
         * 提到组件外，是为了让它能被 `useMemo` 包住：这段要重扫全表、逐组排序、再对组排序，
         * 而本页**点一次勾选就会重渲染一次**（勾选与列表内容无关）。传进来的 `q` 已经过防抖。
         */
        function historyView(data, q, t) {
          var filtered = data.items
          if (q) {
            var needle = q.toLowerCase()
            filtered = data.items.filter(function (it) {
              return (it.title && it.title.toLowerCase().indexOf(needle) >= 0)
                || (it.sessionId && it.sessionId.toLowerCase().indexOf(needle) >= 0)
                || (it.cwd && it.cwd.toLowerCase().indexOf(needle) >= 0)
            })
          }
          // 按项目分组：宿主回传 groups（活登记 + 按会话目录重建的分组）时用组 id 归并；
          // 旧宿主只回 workspaces 时退回原来的扁平/工作区分组逻辑。
          var groupMeta = new Map()
          ;(data.groups || []).forEach(function (g) { if (g && g.id) groupMeta.set(g.id, g) })
          var grouped = groupMeta.size > 0
          var visibleIds = filtered.map(function (it) { return it.sessionId })
          var groups = []
          var byKey = null
          if (grouped) {
            byKey = new Map()
            filtered.forEach(function (it) {
              var key = it.groupId || 'ungrouped'
              if (!byKey.has(key)) byKey.set(key, [])
              byKey.get(key).push(it)
            })
            byKey.forEach(function (items2, key) {
              var meta = groupMeta.get(key)
              var wid = key.indexOf('ws:') === 0 ? key.slice(3) : null
              var wsRec = wid ? data.workspaces[wid] : null
              var title = (meta && meta.title) || (wid ? ((wsRec && wsRec.title) || wid) : t('hist.ungrouped'))
              items2.sort(function (a, b) { return ((b.archivedAt || b.createdAt) || 0) - ((a.archivedAt || a.createdAt) || 0) })
              var maxAt = 0
              items2.forEach(function (it) { var at = (it.archivedAt || it.createdAt) || 0; if (at > maxAt) maxAt = at })
              groups.push({
                key: key, title: title, workspaceId: wid,
                path: (meta && meta.path) || (wsRec && wsRec.path),
                kind: meta ? meta.kind : null,
                registered: !!(meta && meta.registered),
                canRegister: !!(meta && meta.canRegister),
                dirMissing: !!(meta && meta.dirMissing),
                ungrouped: key === 'ungrouped',
                items: items2, maxAt: maxAt,
              })
            })
          } else if (data.workspaces && Object.keys(data.workspaces).length) {
            grouped = true
            byKey = new Map()
            filtered.forEach(function (it) {
              var wid = data.workspaces[it.workspaceId] ? it.workspaceId : null
              var key = wid ? ('ws:' + wid) : 'ungrouped'
              if (!byKey.has(key)) byKey.set(key, [])
              byKey.get(key).push(it)
            })
            byKey.forEach(function (items2, key) {
              var wid = key === 'ungrouped' ? null : key.slice(3)
              var wsRec = wid ? data.workspaces[wid] : null
              var title = wid ? ((wsRec && wsRec.title) || wid) : t('hist.ungrouped')
              items2.sort(function (a, b) { return ((b.archivedAt || b.createdAt) || 0) - ((a.archivedAt || a.createdAt) || 0) })
              var maxAt = 0
              items2.forEach(function (it) { var at = (it.archivedAt || it.createdAt) || 0; if (at > maxAt) maxAt = at })
              groups.push({ key: key, title: title, workspaceId: wid, path: wsRec && wsRec.path, kind: null, registered: false, canRegister: false, dirMissing: false, ungrouped: key === 'ungrouped', items: items2, maxAt: maxAt })
            })
          }
          if (grouped) {
            // 组按组内最新时间戳降序；未分组固定最后。
            groups.sort(function (g1, g2) {
              if (g1.ungrouped) return 1
              if (g2.ungrouped) return -1
              return g2.maxAt - g1.maxAt
            })
          }
          return { filtered: filtered, grouped: grouped, groups: groups, visibleIds: visibleIds }
        }