    function SkillManagerSection(props) {
      var t = props.t;
      // 订阅「现在编辑的是哪一层」（20b-scope）：技能清单按会话 cwd 推导项目根，
      // 切层必须重新拉一次 —— 不订阅时页面停在切层前那份快照（2026-10-19 实测）。
      var scopeState = useScopeLayer();
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
      var fms = react.useState({ root: "dsh", name: "", description: "", body: "", files: [] }), form = fms[0], setForm = fms[1];
      // 「已存在同名技能」确认弹窗（用户 2026-10-14）：`{ name, finalName }` 或 null。
      // 撞名不再静默退号（`foo` → `foo-1`），先问一句再建。
      var dups = react.useState(null), dupAsk = dups[0], setDupAsk = dups[1];
      var us = react.useState(null), upload = us[0], setUpload = us[1];
      var ds = react.useState(null), detail = ds[0], setDetail = ds[1];
      var cs = react.useState({ path: "", label: "" }), customForm = cs[0], setCustomForm = cs[1];
      // 技能附件（用户 2026-10-16 裁定 A：技能不止名字 + 简介 + 正文，`references/`、`lib/`
      // 这类参考资料也要能在界面里直接给，而且**能在界面里写**，不只是从本机挑文件）：
      // 条目挂在 `form.files` 上随创建一起提交，形状 `{ path, size, data(base64), text? }`。
      // `attachError` 是附件区自己的一行报错（超限 / 撞路径），`draftFile` 是「新建文件」小窗的载荷。
      var afs = react.useState(null), attachError = afs[0], setAttachError = afs[1];
      var dfs = react.useState(null), draftFile = dfs[0], setDraftFile = dfs[1];
      var attachInputRef = react.useRef(null);
      // 切走这一页 → 「创建技能」关窗时那份暂存作废（见 42-shared-ui.js 的 useFormDraftScope）。
      useFormDraftScope('skill:');
      // 组内「启用的排前面」的定序表（见 42-shared-ui.js 的 rankedFirst）：整页一张，
      // 各来源卡片共用 —— 技能 key 带着来源前缀，跨卡片不会撞。
      var skillRank = useRank();
      // 回收站：modal === "trash" 打开本页那一个回收站（42-shared-ui.js 的 TrashModal，
      // domain = skills）。它里面有**两组**：「目录」（不再读取的来源，删的是记账）与
      // 「技能」（删的是真文件），各自独立的批量条 —— 2026-10-10「全选要拆成两部分」的
      // 裁定由分组标题 + 分组批量条承接（原先靠六类导航分成两类，导航已删）。
      // 清单加载 / 勾选 / 恢复 / 永久删除 / 保留期都在组件内部，本页只管开关与写后刷新。
      var ups = useUndoState(), undo = ups[0], setUndo = ups[1], dismissUndo = ups[2];
      var inflightRef = react.useRef(false);
      // 详情弹窗的请求序号（见 openDetail / closeModal）：晚到的响应不得复活/顶掉弹窗内容。
      var detailSeqRef = react.useRef(0);
      var pickerOpenRef = react.useRef(false);
      // 事件回调里要读「当前」的撤销条：点开关到请求返回之间用户可能已经点过撤销。
      var undoRef = react.useRef(null);
      undoRef.current = undo;
      /** 取数用的会话 id：全局层传空串（= 服务端按全局口径算，与 0.21.2 逐字相同）。 */
      function scopeSessionId() { return scopeIsSession() ? scopeState.sessionId : '' }
      /**
       * 来源在**本层**开不开（0.21.2）。
       *
       * 会话层：`skillSources` 域（键 = 来源 root，与注入段、模型工具同一套）。拨开一个
       * 全局关着的来源时，服务端会先在**全局**把它启用（来源关着时技能级开关会被 core
       * 吞掉）—— 警告随回执带回，`scopeWriteFlag` 会把它挂到作用域条上。
       */
      function srcOnInLayer(root) {
        // 全局层读**意图**（`root.globalOn`，0.21.2），运行态兜底：租约期间来源状态是开着的，
        // 读 `root.enabled` 会把"仅为几个对话开着"显示成全局开着。
        var globalOn = typeof root.globalOn === 'boolean' ? root.globalOn : root.enabled !== false
        return scopeIsSession() ? scopeFlag('skillSources', String(root.key), globalOn).value : globalOn
      }
      /**
       * 全局意图的两种"重"动作（0.21.2）：来源停用是 off（有租约就继续跑），
       * 彻底停止（blocked）才会连还在用它的会话一起切断 —— 所以后者走确认。
       */
      function setSourceIntent(root, value) {
        var key = String(root.key || '')
        var name = rootDisplayName(t, root)
        setBusy(true)
        setResult(null)
        return apiCall('scope-intent-set', { domain: 'skillSources', keys: [key], value: value })
          .then(function (res) {
            if (res && res.ok === false) { setResult({ ok: false, text: translateError(t, res) }); return }
            var warnings = res && res.warnings && res.warnings.length ? res.warnings.join('；') : ''
            var leases = scopeLeaseCount('skillSources', key)
            var text = value === 'blocked' ? t('scope.intent.stopped', { name: name })
              : value === 'on' ? t('done.enabled', { name: name })
                : leases > 0 ? t('scope.intent.keptRunning', { count: leases }) : t('done.disabled', { name: name })
            setResult({ ok: true, text: text + (warnings ? ' ' + warnings : '') })
            refreshScope()
            refresh(true)
          })
          .catch(function (error) { setResult({ ok: false, text: t('error.action', { error: translateError(t, error) }) }) })
          .finally(function () { setBusy(false) })
      }
      // 项目技能根按**会话 cwd** 推导（skills/service.ts 的 `sessionCwdOf`），所以带上层。
      function refresh(silent) { if (!silent) setSnapshot({ loading: true, error: null, data: snapshot.data }); return callApi("/state", { body: JSON.stringify({ sessionId: scopeSessionId() }) }).then(function (data) { setSnapshot({ loading: false, error: null, data: data }); return data; }).catch(function (error) { setSnapshot({ loading: false, error: translateError(t, error), data: snapshot.data }); }); }
      react.useEffect(function () { refresh(false); }, [scopeState.sessionId]);
      function post(path, body, successKey, successParams) { if (inflightRef.current) return Promise.reject({ error: "operation already in progress" }); inflightRef.current = true; setBusy(true); setResult(null); return callApi(path, { body: JSON.stringify(body || {}) }).then(function (data) { var warn = joinWarn(sceneSyncWarn(t, data), stateSyncWarn(t, data)); setResult({ ok: !warn, warning: !!warn, text: (successKey ? t(successKey, successParams || data || {}) : t("result.updated")) + (warn ? " " + warn : "") }); return refresh(true).then(function () { return data; }); }).catch(function (error) { setResult({ ok: false, text: t("error.action", { error: translateError(t, error) }) }); throw error; }).finally(function () { inflightRef.current = false; setBusy(false); }); }
      /** post 把失败写进 setResult 后会 re-throw 供链式消费；不消费的调用方挂它吞掉重抛，
          否则控制台全是 unhandled rejection（失败反馈本身 post 已经给过了）。 */
      function swallowPostError() {}
      function openDetail(root, skill) {
        // 详情弹窗的请求序号（配合 closeModal）：载荷里不带"我是哪个技能"，连点两条时
        // 先发的响应可能后到并顶掉后发的那份 —— 序号对不上就丢弃。
        var seq = ++detailSeqRef.current;
        setBusy(true); setDetail(null); setModal("detail");
        callApi("/detail", { body: JSON.stringify({ root: root.key, name: skill.name, sessionId: scopeSessionId() }) })
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
        requestHostDirectory(function (path) { setCustomForm(Object.assign({}, customForm, { path: path })) }, function () { setCustomForm(Object.assign({}, customForm, { picking: true })) });
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
      /**
       * 客户端侧的 `toKebab` 镜像（宿主实现在 `src/skills/frontmatter.ts`）。
       *
       * 为什么界面里要再写一份：技能名落盘前会被宿主归一化（`Foo Bar` → `foo-bar`），而
       * 「新建撞名先问一句」必须在**提交之前**就知道归一化后的名字 —— 否则问出来的
       * 「`Foo Bar-1`」和真正写下去的「`foo-bar-1`」对不上，等于换了个地方骗人。镜像宿主
       * 谓词在本项目有先例（隔壁 `isValidSceneSegment`）。宿主改口径这里要一起改；不一致
       * 的后果只是"提示里的名字和实际不符"，不是写坏数据 —— 服务端那道同名闸仍在。
       */
      function kebabName(raw) {
        var s = String(raw == null ? "" : raw).trim();
        if (s === "") return "";
        return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
          .replace(/[\s_.]+/g, "-").replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-").replace(/^-+|-+$/g, "");
      }
      /**
       * 技能页「创建技能」的提交（用户 2026-10-14 第二轮）：**先问一句，再退号**。
       *
       * 判据只看**落点那一个来源**里的条目名 —— `skill-create` 的同名检查也是按目标根做的
       * （`safeExistingEntryPaths(root, name)`），别的来源里有同名是另一回事（那个由"同名
       * 首选"管，不是冲突）。比的是条目名（文件 / 目录名）而不是 frontmatter 里的展示名，
       * 与服务端同口径。
       *
       * 退号用 `-1`（不是 `（1）`）：技能名必须过 KEBAB_RE，全角括号会被 `toKebab` 抹成 `-`，
       * 写出来本来就是 `foo-1`，不如一开始就按这个写。
       */
      function submitCreate() {
        var typed = String(form.name || "").trim();
        var normalized = kebabName(typed);
        var target = allRoots.filter(function (r) { return String(r.key) === String(form.root); })[0];
        var taken = {};
        ((target && target.skills) || []).forEach(function (sk) { taken[String(sk.name)] = true; });
        var finalName = uniqueName(normalized, taken, "dash");
        if (finalName !== normalized) { setDupAsk({ name: normalized, finalName: finalName }); return; }
        createSkill(finalName);
      }
      /** 真正落盘那一步（名字已定）。`name` 来自 `submitCreate` 或确认弹窗。 */
      function createSkill(name) {
        // 附件只带 path + data：`text` 是界面里再编辑用的缓冲，一起发等于把同一份内容传两遍。
        var payload = Object.assign({}, form, {
          name: name,
          files: (form.files || []).map(function (f) { return { path: f.path, data: f.data } }),
        });
        post("/create", payload, null).then(function (data) { setModal(null); setForm({ root: "dsh", name: "", description: "", body: "", files: [] }); setAttachError(null); setResult(function (prev) { return Object.assign({ ok: true, warning: false }, prev || {}, { text: t("done.created", { name: data.name }) }); }); }).catch(swallowPostError);
      }
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
          // 会话作用域（0.21.2）：判据按**本层**的来源值（本会话藏掉的来源，里面不参与批量）。
          if (root.toggleable !== false && srcOnInLayer(root) && !(activeSource && activeSource !== root.key)) {
            var skills = root.skills || [];
            for (var j = 0; j < skills.length; j++) {
              var sk = skills[j];
              if (sk.loadable === false || sk.shadowedBy) continue;
              if (!matchSkillQuery(Object.assign({}, sk, { rootKey: root.key, rootLabel: displayName }), dq)) continue;
              // 会话作用域（0.21.2）：批量按钮的「全开没有」也按**本层**算 —— 用全局值的话，
              // 会话层刚全关掉，按钮还写着「取消全选」（2026-10-19 实测）。
              // `canonical` 是覆盖键用的声明名；`name` 仍是全局 op 认的目录名，两者别混。
              var canonical = sk.declaredName || sk.name;
              list.push({ root: root.key, name: sk.name, canonical: canonical, on: scopeFlag('skills', root.key + '/' + canonical, skillGlobalOn(sk)).value });
            }
          }
          targets[root.key] = list;
          all = all.concat(list);
        }
        targets[""] = all;
        // 页头「启用 / 总数」在会话层按本层算：`summary.enabled` 是服务端按全局算的，
        // 会话层照抄它，页头那几个数字与下面一排开关就对不上（2026-10-19）。
        var enabledCount = 0;
        for (var r2 = 0; r2 < roots.length; r2++) {
          // 来源级停用时里面一条都加载不了 —— 残留的会话 `true` 不能把它算进"启用"。
          // 判据按本层（会话藏掉的来源同样一条都不算）。
          if (!srcOnInLayer(roots[r2])) continue;
          var rs = roots[r2].skills || [];
          for (var s2 = 0; s2 < rs.length; s2++) {
            // 与 `summary.enabled`（服务端只数胜出者）同一口径：影子副本没有 `enabled` 字段，
            // 走 `isSkillEnabled` 的兜底推导会被算成"开着"，页头那个数字就比服务端多。
            if (rs[s2].loadable === false || rs[s2].shadowedBy) continue;
            if (scopeFlag("skills", roots[r2].key + "/" + (rs[s2].declaredName || rs[s2].name), skillGlobalOn(rs[s2])).value) enabledCount += 1;
          }
        }
        return { filtered: filtered, targets: targets, enabledCount: enabledCount };
        // `scopeState` 进依赖：批量目标集的 `on` 跟着层走（见上面那条 push）。
      }, [roots, dq, activeSource, t, scopeState]);
      // 创建位置候选：只要**用户级**可写根（DSH 技能 / 导入技能）。项目级来源
      // （`project-dsh:<hash>`，标签「项目 DSH · <仓库名>」）排除在外 —— 用户裁定
      // 2026-10-15「新增技能默认 DSH 技能；导入技能功能才是导入技能目录」，新建落点
      // 只在用户级目录里选。更硬的理由是闭环：`skill_manager_save` 的改分支
      // （`skill-update` op）只认 hub + dsh 两个可写根，建在项目目录里的技能模型侧
      // 「再存一次」会被 error.update.notOwnRoot 拒；模型工具没有 root 参数、永远落
      // dsh，这个下拉是唯一能把技能建进项目根的入口。项目来源本身不动 —— 来源卡片
      // 照旧列它（发现 / 启停 / 删除），只是不再作为「创建位置」候选。
      var createRoots = allRoots.filter(function (root) { return root.mutable === true && root.scope !== "project"; }), createOptions = createRoots.map(function (root) { return { value: root.key, label: rootDisplayName(t, root) }; }); if (!createOptions.length) createOptions.push({ value: "hub", label: t("root.hub") });
      // 新建技能的默认落点：DSH 技能（`~/.dsh/skills/`，用户裁定 2026-10-15）。
      // v0.4 起这里默认 hub，现在改回 dsh —— hub（`tool-management/skills/`）只留给「导入技能」
      // 功能（import / upload 走 `skillCreateRootPath()`，不经这一处）。与 `skill-create` 的
      // op 默认值、core.js 的 createSkill 默认值同口径：三处必须一致，否则人点界面和模型调用
      // 会把同一个「新建技能」落到两个不同的根。
      // 用户在技能页筛选了某个来源时，优先用那个来源；筛选来源与 dsh 都不可用时退回 hub。
      // 筛到**项目来源**时不算数（项目来源已不在 createRoots 里，见上方）：那时仍落 dsh ——
      // 新建技能的落点按裁定只在用户级目录里选，不跟着页面筛选拐进项目仓库。
      function defaultCreateRoot() {
        if (createRoots.some(function (root) { return root.key === activeSource; })) return activeSource;
        if (createRoots.some(function (root) { return root.key === "dsh"; })) return "dsh";
        return "hub";
      }
      function openCreate() {
        // 30 秒内重开 = 把刚才关掉的那份填回来（含附件）；落点仍按当前筛选重算。
        var draft = takeFormDraft('skill:create')
        if (draft) { setForm(Object.assign({}, draft, { root: defaultCreateRoot() })); setAttachError(null); setModal("create"); return }
        setForm(Object.assign({}, form, { root: defaultCreateRoot(), files: [] })); setAttachError(null); setModal("create");
      }
      /** 关掉 ≠ 丢掉：只有 onClose 这条路存草稿（提交成功是就地 setModal(null)，不进这里）。 */
      function dismissCreate() { stashFormDraft('skill:create', form); setModal(null); }
      /** 并入清单：SKILL.md 与超限的当场拦下（服务端还会再拦一次），同路径的后者不盖前者。
       *  带回第一条要说的话（'' = 全部收下），由调用方决定挂在弹窗里还是挂在页面上。 */
      function addAttachments(list) {
        var accepted = [], problem = ""
        var lower = {}
        ;(form.files || []).forEach(function (f) { lower[String(f.path).toLowerCase()] = true })
        list.forEach(function (item) {
          if (/(^|\/)skill\.md$/i.test(item.path)) { problem = problem || t('skill.attach.reserved', { path: item.path }); return }
          if (item.size > MAX_UPLOAD_ENTRY_BYTES) { problem = problem || t('skill.attach.tooLarge', { name: item.path, limit: 32 }); return }
          var key = String(item.path).toLowerCase()
          if (lower[key]) { problem = problem || t('skill.attach.dup', { path: item.path }); return }
          lower[key] = true
          accepted.push(item)
        })
        if (accepted.length) setForm(function (prev) { return Object.assign({}, prev, { files: (prev.files || []).concat(accepted) }) })
        return problem
      }
      /** 文件夹名归一：反斜杠当分隔、去掉首尾斜杠；`..`/`.` 段当场拦。空 = 落在技能目录根下。 */
      function attachDir(raw) {
        var d = String(raw == null ? '' : raw).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        return /(^|\/)\.\.?(\/|$)/.test(d) ? null : d
      }
      /**
       * 两框 → 相对路径。文件夹名可空，文件名必填。
       * 拆开写就是为了不用先理解「路径里的 / 是什么意思」—— 非法片段当场拦，不等服务端。
       */
      function attachJoin(dir, name) {
        var d = attachDir(dir)
        if (d === null) return { error: t('skill.attach.baddir') }
        var n = String(name == null ? '' : name).trim().replace(/\\/g, '/').replace(/^\/+/, '')
        if (!n) return { error: t('skill.attach.nameRequired') }
        if (n.charAt(n.length - 1) === '/' || /(^|\/)\.\.?(\/|$)/.test(n)) return { error: t('skill.attach.badname') }
        return { path: d ? d + '/' + n : n, dir: d, name: n }
      }
      /** 打开「选择附件」小窗：里面只有文件夹名 + 拖放区，挑完就地并入清单。 */
      function openPickFiles() { setDraftFile({ mode: "pick", dir: "", error: null }) }
      /** 读入挑到 / 拖到的文件，按小窗里那格文件夹名落路径。 */
      function readAttachFiles(picked) {
        var list = Array.prototype.slice.call(picked || [])
        if (!list.length) return
        var dir = attachDir(draftFile && draftFile.dir)
        if (dir === null) { setDraftFile(Object.assign({}, draftFile, { error: t('skill.attach.baddir') })); return }
        Promise.all(list.map(function (file) {
          return file.arrayBuffer().then(function (buf) {
            var rel = uploadFilePath(file)
            return { path: dir ? dir + '/' + rel : rel, size: buf.byteLength, data: bytesToBase64(buf) }
          })
        })).then(function (entries) {
          var problem = addAttachments(entries)
          setDraftFile(function (prev) { return prev ? Object.assign({}, prev, { error: problem || null }) : prev })
        }).catch(function (error) {
          setDraftFile(function (prev) { return prev ? Object.assign({}, prev, { error: translateError(t, error) }) : prev })
        })
      }
      function onAttachmentsPicked(ev) {
        var files = ev.target && ev.target.files
        var picked = Array.prototype.slice.call(files || [])
        if (ev.target) ev.target.value = '' // 允许连续选中同一个文件
        readAttachFiles(picked)
      }
      function onAttachmentsDropped(ev) {
        ev.preventDefault()
        droppedFiles(ev.dataTransfer).then(readAttachFiles).catch(function (error) { setAttachError(translateError(t, error)) })
      }
      function dropAttachment(index) {
        setForm(function (prev) {
          var next = (prev.files || []).slice()
          next.splice(index, 1)
          return Object.assign({}, prev, { files: next })
        })
        setAttachError(null)
      }
      /** 打开「新建附件」小窗：`index` 为数字 = 改已有那一条（只改界面里写的那份），null = 新增。 */
      function openNewFile(index) {
        var cur = typeof index === "number" ? (form.files || [])[index] : null
        if (cur && cur.text === undefined) return
        var path = cur ? String(cur.path || '') : ''
        var cut = path.lastIndexOf('/')
        setDraftFile({
          mode: "new", index: typeof index === "number" ? index : null,
          dir: cut >= 0 ? path.slice(0, cut) : "", name: cut >= 0 ? path.slice(cut + 1) : path,
          content: cur ? String(cur.text || "") : "", error: null,
        })
      }
      function submitNewFile() {
        var joined = attachJoin(draftFile.dir, draftFile.name)
        if (joined.error) { setDraftFile(Object.assign({}, draftFile, { error: joined.error })); return }
        var path = joined.path
        var clash = (form.files || []).some(function (f, i) {
          return i !== draftFile.index && String(f.path).toLowerCase() === path.toLowerCase()
        })
        if (clash) { setDraftFile(Object.assign({}, draftFile, { error: t('skill.attach.dup', { path: path }) })); return }
        var content = String(draftFile.content || '')
        var bytes = new TextEncoder().encode(content)
        var entry = { path: path, size: bytes.length, data: bytesToBase64(bytes.buffer), text: content }
        setForm(function (prev) {
          var list = (prev.files || []).slice()
          if (typeof draftFile.index === "number") list.splice(draftFile.index, 1, entry)
          else list.push(entry)
          return Object.assign({}, prev, { files: list })
        })
        // 新增：加完清空两个文本框、留着文件夹名（往 references/ 里连写几份是常态）；
        // 改已有那条：改完就走，停在一个"它已经不是那条"的窗里没有意义。
        if (typeof draftFile.index === "number") setDraftFile(null)
        else setDraftFile({ mode: "new", index: null, dir: joined.dir, name: "", content: "", error: null })
        setAttachError(null)
      }
      /** 附件清单里的一行（创建弹窗与「选择附件」小窗共用：两处显示的是同一份 form.files）。 */
      function attachRow(f, i) {
        return h("div", { key: i + ":" + f.path, className: "dsm-file", title: f.path },
          h("span", { className: "dsm-file-kind", "aria-hidden": "true" }, f.text === undefined ? "FILE" : "NEW"),
          h("span", { className: "dsm-file-name" }, f.path),
          h("span", { className: "dsm-file-meta" }, fmtBytes(f.size)),
          f.text === undefined ? null : h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { openNewFile(i) } }, t("skill.attach.edit")),
          h("button", { type: "button", className: "dsm-file-remove", "aria-label": t("skill.attach.remove") + " " + f.path, onClick: function () { dropAttachment(i) } }, "×"))
      }
      /** 附件区：一行「标签 + 两颗动作键」，下面只在有条目时才占高度（清单封顶滚动，空着不占）。 */
      function renderAttachField() {
        var list = form.files || []
        return h("div", { className: "dsm-field" },
          h("div", { className: "dsm-budget-meta" },
            h("span", { className: "dsm-label" }, list.length ? t("skill.attach.label") + " · " + list.length : t("skill.attach.label")),
            h("span", { className: "dsm-attach-actions" },
              h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { openNewFile(null) } }, t("skill.attach.new")),
              h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", onClick: openPickFiles }, t("skill.attach.pick")))),
          list.length
            ? h("div", { className: "dsm-attach-list dsm-attach-cap" }, list.map(attachRow))
            : null,
          attachError ? h("div", { className: "dsm-feedback dsm-error", role: "alert" }, attachError) : null)
      }
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
        var enabled = isSkillEnabled(skill), key = skill.shadowedBy ? "status.shadowed" : skill.loadable === false ? "status.invalid" : enabled ? "status.enabled" : "status.disabled";
        // 覆盖键用**声明名**（`<root>/<declaredName>`）：注入段、档案与模型工具都是这套键。
        var skillName = skill.declaredName || skill.name
        var skillKey = root.key + '/' + skillName
        // 全局层显示「意图 ∪ 租约」的有效值（`globalOn`），不是运行态瞬时值（0.21.2）。
        var globalOnHere = skillGlobalOn(skill)
        // 来源级停用是上层闸（0.21.2）：里面单条技能的会话覆盖即使写着 true 也不生效，
        // 界面与页头统计必须按"关"显示 —— 否则会出现"本对话开着、却加载不了"的绿勾。
        // 0.21.2 起判据是**本层**的来源值（会话层 = `skillSources` 域）：本会话藏掉的来源，
        // 里面的行照"关"显示；本会话拨开的全局关来源，里面按"假设开着"算。
        var rootOff = !srcOnInLayer(root);
        // 行首点 = **这一层**开不开（与右边那颗开关同值）。运行态可能是别的会话的租约拉起来的，
        // 那由行 2 的「临时运行 · N 个对话」说明，不拿绿点冒充「本层开着」（用户 2026-10-21）。
        var flagHere = scopeFlag("skills", skillKey, globalOnHere)
        var onHere = rootOff ? false : flagHere.value
        // 胶囊配色：橙=诊断异常（要人去看），灰=没生效但不是故障（被同名覆盖、本条停用），绿=生效中。
        var tone = skill.shadowedBy ? "muted" : skill.loadable === false ? "warn" : enabled ? "ok" : "muted";
        var canToggle = root.toggleable !== false && skill.loadable !== false;
        // 被覆盖 ≠ 另一份在跑：赢家自己被停用时两份都不生效，这时必须换一句实话，
        // 否则界面会一边把这一行标成「被覆盖」、一边说「同名技能 X 正在生效」（审查 F8）。
        var shadowedHint = skill.shadowedBy ? t(skill.shadowedBy.enabled === false ? "status.shadowed.inert" : "status.shadowed.hint", { name: skill.shadowedBy.name }) : null;
        // 列表行两行制（REDESIGN §3.4，切片四）：行 1 状态点（被覆盖 / 诊断异常换成
        // 「需要处理」的 tag）+ 名称；行 2 简介 + 元信息。原行中标签列并入行 2（切片三移交
        // 的「tags 列清理」）；**来源名不再重复** —— 行永远住在自己的来源组卡里，组头就是来源
        // （组头吸顶后一直在视野内）。
        var attention = !!(skill.shadowedBy || skill.loadable === false);
        var metaBits = [
          h("span", { key: "desc", className: "dsm-listrow-meta-desc", title: skill.description || t("note.missing") }, skill.description || t("note.missing")),
          skill.preferred === true ? h("span", { key: "preferred", className: "dsm-listrow-meta-info" }, t("status.preferred")) : null,
          // 六域租约徽章（0.21.2）：这一条有几个对话在认领它（真写运行态的域，文案「临时运行 · N 个对话」）。
          // 放在行 2 而不是行 1：行 1 的契约是「名称 + 至多 1 个需要处理的 tag」（见 ListRow 注释）。
          leaseTag({ t: t, domain: 'skills', key: skillKey, runtime: true }),
          // （这里曾有一枚「源文件只读」：它说的就是"这一整组来源是只读的"，而组卡头已经把来源
          //  名字摆在上面 —— 每一行重复一遍没有任何新信息，2026-10-12 删掉。）
          root.mutable && !root.deletable ? h("span", { key: "notDeletable", className: "dsm-listrow-meta-info", title: t("status.notDeletable.hint") }, t("status.notDeletable")) : null,
        ];
        // 行尾：「详情」与「删除」常驻（用户 2026-10-16 第三、四轮：详情要留边框、删除要拿出来），
        // 只剩低频的两件（启用这个 / 取消首选）收进一颗 ⋯ —— 没有这两件时那颗 ⋯ 不出现。
        // 锁定期间**只有「详情」还活着**：其余都会改配置，一律置灰
        //（用户 2026-10-12：「锁定情况下删除键应该变灰且不能点击」—— 与子智能体页锁定态同长相）。
        var actions = [];
        var menuItems = [];
        /**
         * 「启用这个」写的是「同名技能该用哪个**来源**」的首选表（`/prefer` →
         * `preferredSkills[名] = 来源 key`，`shadowedBy.root === 本行来源` 即表示撞名发生在
         * **同一个来源目录内部**（两个文件夹都写着 `name: X`）—— 那种情况下首选表怎么指都
         * 指不出区别（值就是来源 key，两份在同一个来源里），按下去只会回一句"已改为生效"、
         * 实际什么都没变（用户 2026-10-14 实测到的那颗假按钮）。
         *
         * 「被覆盖」这个标记照旧保留（同来源里的落选那份确实不会被加载，如实说比不说好），
         * 收掉的只是那颗**做不到它承诺的事**的按钮。判据是来源 key，不是文案。
         */
        var canPrefer = !!skill.shadowedBy && skill.shadowedBy.root !== root.key;
        if (canToggle && canPrefer) menuItems.push({ key: "activate", label: t("btn.activate"), title: t("btn.activate.title"), disabled: busy || anyLocked || scopeIsSession(), onClick: function () { activateShadowed(root, skill); } });
        if (skill.preferred === true) menuItems.push({ key: "unprefer", label: t("btn.unprefer"), title: t("btn.unprefer.title"), disabled: busy || anyLocked || scopeIsSession(), onClick: function () { clearPreferred(root, skill); } });
        actions.push(h("button", { key: "detail", type: "button", className: "dsm-btn dsm-btn-quiet", onClick: function () { openDetail(root, skill); } }, t("btn.detail")));
        // 「删除」留在行内（用户 2026-10-16 第四轮：「技能把删除拿出来」，与会话页同一口径）：
        // 这一页的行本来就靠这颗收尾，藏进 ⋯ 反而要多点一次才找得到。
        if (root.deletable === true) actions.push(h("button", { key: "trash", type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy || anyLocked, onClick: function () { setModal({ type: "trash-confirm", root: root.key, name: skill.name }); } }, t("btn.trash")));
        if (menuItems.length) actions.push(h(RowMenu, { key: "menu", label: t("row.menu", { name: skill.declaredName || skill.name }), items: menuItems }));
        return h(ListRow, {
          key: skill.name,
          // 会话作用域（0.21.2）：来源标记打在点上（用户 2026-10-19 裁定，开关不染色）。
          // 覆盖键用**声明名**（`<root>/<declaredName>`）：注入段、档案与模型工具都是这套键，
          // 目录名与声明名不同时用目录名会写进一条永远读不到的覆盖。
          dots: attention ? [] : [h(StatusDot, { key: "dot", tone: onHere ? "ok" : "idle", scoped: onHere && flagHere.scoped, title: t(onHere ? "status.enabled" : "status.disabled") })],
          name: skill.declaredName || skill.name,
          tag: attention ? h(StatusTag, { tone: tone, text: t(key) }) : null,
          meta: metaBits,
          extra: shadowedHint ? h("div", { className: "dsm-rule-hint" }, shadowedHint) : null,
          // 会话作用域（0.21.2）：这一格的值与"是不是本会话覆盖的"都来自 scopeFlag；
          // 会话层下点击写 `scope-set`，全局层仍走 `/enable` `/disable`。
          side: canToggle && !skill.shadowedBy ? (function () {
            return h(Switch, { on: onHere, scoped: !rootOff && flagHere.scoped, disabled: busy || rootOff || scopeWriteLocked(anyLocked), label: t('skill.toggle') + ' ' + skill.name, onClick: function () {
              // 回执动词表（REDESIGN §12.4）：两个方向各取字面量键，不合成三元选词。
              if (scopeIsSession()) {
                scopeWriteFlag('skills', skillKey, !onHere, function () { return { ok: true } })
                  .then(function (res) { setResult(res && res.ok === false ? { ok: false, text: translateError(t, res) } : { ok: true, text: t(onHere ? 'done.disabled' : 'done.enabled', { name: skillName }) }) })
                return
              }
              if (onHere) post('/disable', { root: root.key, name: skill.name }, 'done.disabled', { name: skillName })
              else post('/enable', { root: root.key, name: skill.name }, 'done.enabled', { name: skillName })
            } })
          })() : null,
          actions: actions,
        });
      }
      function renderRoot(root) {
        if (activeSource && activeSource !== root.key) return null;
        var displayName = rootDisplayName(t, root), filtered = skillView.filtered[root.key] || []; if (dq && !filtered.length) return null;
        // 默认展开与否看**这个来源里有没有开着的技能**（用户 2026-10-16：官方内置 / 导入技能
        // 一条都没开也默认展开了）—— 来源开关本身不是判据：官方根整体是「可管理」，里面
        // 四条全关着也照样算"没在用"。手动点过的以手动为准（表里有值），搜索时强制展开。
        var openFlag = expanded[root.key]
        var baseOpen = openFlag === undefined ? bulkTargets(root.key).some(function (x) { return x.on }) : !!openFlag;
        var open = baseOpen || !!dq;
        var rootCount = root.count == null ? root.skills.length : root.count;
        var srcOnHere = srcOnInLayer(root);
        // 全局意图 / 租约（0.21.2）：与 MCP 页同一套徽章 —— 「彻底停止」与「临时运行 · N 个对话」。
        // 会话层不显示（那一层只回答"这个对话看得到哪些技能"）。
        var rootKeyHere = String(root.key || "");
        var intentHere = scopeIntentOf('skillSources', rootKeyHere);
        var leaseHere = scopeLeaseCount('skillSources', rootKeyHere);
        var intentTag = scopeIsSession() || root.defaultSource === true ? null
          : intentHere === 'blocked' ? h("span", { key: "intent", className: "dsm-tag dsm-tag-off", title: t("scope.intent.blockedHint") }, t("scope.intent.blocked"))
            : h(react.Fragment, { key: "intent" }, leaseTag({ t: t, domain: 'skillSources', key: rootKeyHere, runtime: true }));
        var section = h("section", { key: root.key, className: "dsm-source" }, h("div", { className: "dsm-source-head dsm-source-head-pin" }, h("button", { type: "button", className: "dsm-source-head-main", "aria-expanded": open, onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: !baseOpen })); } }, h("span", { className: "dsm-source-title", title: displayName }, displayName), h("span", { className: "dsm-count" }, String(rootCount)), h("span", { className: "dsm-tag " + (root.scope === "project" ? "dsm-tag-on" : root.defaultSource === true ? "" : srcOnHere ? "dsm-tag-on" : "") }, root.scope === "project" ? t("status.project") : root.defaultSource === true ? t("status.manageable") : t(srcOnHere ? "status.source.on" : "status.source.off")), intentTag, root.scope === "project" ? h("span", { className: "dsm-tag" }, t("status.rank", { rank: root.rank })) : null, h("span", { className: "dsm-path", title: root.path }, root.path)), (function () {
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
          if (bulk.targets.length) acts.push(h("button", { key: "all", type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-bulk", disabled: busy || scopeWriteLocked(anyLocked), title: t("source.bulk.title"), onClick: function () { setExpanded(Object.assign({}, expanded, { [root.key]: true })); submitBulk(bulk.targets, !bulk.on, root.key); } }, bulkPair(bulk.on ? t("bulk.unselectAll") : t("bulk.selectAll"), bulk.on ? t("bulk.selectAll") : t("bulk.unselectAll"))));
          if (showSwitch) {
            // 开关来源时**顺带把卡片展开**（用户裁定 2026-09-17），与旁边那颗「全选」同口径：
            // 启停的结果就是下面这些技能行（开启 = 整目录可用了，关闭 = 逐行变停用），卡片收着
            // 的话点完只剩标签从「已停用」变「已启用」，目录里到底有什么、哪些真的可用了看不见。
            // 只展开、不收起 —— 两个方向都要能看见结果，收起仍然是点卡片头那一行的事。
            // 会话作用域（0.21.2）：会话层写 `skillSources` 域；拨开一个全局关着的来源时
            // 服务端会先在**全局**启用它（来源关着时技能级开关被 core 吞掉），警告挂作用域条。
            var srcFlag = scopeFlag('skillSources', String(root.key), typeof root.globalOn === 'boolean' ? root.globalOn : root.enabled !== false);
            var srcOn = scopeIsSession() ? srcFlag.value : srcOnHere;
            // 全局「彻底停止」压过会话层：会话开关置灰并说明（拨了也会被服务端拒掉）。
            var blockedHere = intentHere === 'blocked';
            acts.push(h(Switch, {
              key: "sw",
              on: srcOn,
              scoped: scopeIsSession() ? srcFlag.scoped : false,
              disabled: busy || scopeWriteLocked(anyLocked) || blockedHere,
              title: blockedHere ? t("scope.intent.blockedHint") : undefined,
              label: t("source.toggle") + " " + displayName,
              onClick: function () {
                setExpanded(Object.assign({}, expanded, { [root.key]: true }));
                if (scopeIsSession()) {
                  scopeWriteFlag('skillSources', String(root.key), !srcOn, function () { return { ok: true } })
                    .then(function (res) {
                      if (res && res.ok === false) { setResult({ ok: false, text: translateError(t, res) }); return }
                      setResult({ ok: true, text: t(srcOn ? 'done.disabled' : 'done.enabled', { name: displayName }) })
                      refresh(true)
                    })
                  return
                }
                // 全局层 = 写**意图**（0.21.2）：off 之后仍被会话认领的来源保持启用（租约），
                // 只有「彻底停止」才切断它们。
                setSourceIntent(root, srcOn ? 'off' : 'on');
              },
            }));
            // 「彻底停止 / 恢复启用」：只在全局层、且确实有区别的时候出现
            //（off 或还有租约 —— 普通开着时那颗开关已经能停，停完再出现"彻底停止"）。
            if (!scopeIsSession()) {
              if (intentHere === 'blocked') {
                acts.push(h("button", { key: "intent", type: "button", className: "dsm-btn dsm-btn-quiet", disabled: busy || scopeWriteLocked(anyLocked), onClick: function () { setSourceIntent(root, 'on'); } }, t("scope.intent.resume")));
              } else if (intentHere === 'off' || leaseHere > 0) {
                acts.push(h("button", { key: "intent", type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy || scopeWriteLocked(anyLocked), title: t("scope.intent.stopHint"), onClick: function () { setModal({ type: "source-stop-confirm", key: root.key, name: displayName }); } }, t("scope.intent.stop")));
              }
            }
            // 「移除来源」只要文字，放在开关**右侧**（用户裁定 2026-10-15，连续推翻两次：
            // 2026-09-17 的「只留图标」与当天早些时候的「图标 + 文字」—— 图标在这颗 quiet
            // 键里只是装饰，「移除来源」四个字已把语义说全；破坏性操作的郑重感由确认弹窗
            // 承担，点击照旧弹红色「移除来源」确认框，说明没有丢）。
            if (root.removable === true) acts.push(h("button", { key: "rm", type: "button", className: "dsm-btn dsm-btn-quiet dsm-btn-danger", disabled: busy || anyLocked, title: t("btn.source.remove.title"), "aria-label": t("btn.source.remove"), onClick: function () { setModal({ type: "source-remove-confirm", key: root.key, name: displayName }); } }, t("btn.source.remove")));
          }
          return acts.length ? h("span", { className: "dsm-source-actions" }, acts) : null;
        })()), open ? h("div", { className: "dsm-source-body" }, filtered.length ? rankedFirst(skillRank, function (skill) { return skill.key || (root.key + "/" + skill.name) }, filtered, function (skill) {
          // 会话层按本层生效值排序（与行内开关同一判据），否则刚全关的技能仍排在「启用」那一段。
          return scopeFlag('skills', root.key + '/' + (skill.declaredName || skill.name), skillGlobalOn(skill)).value;
        }).map(function (skill) { return renderSkill(root, skill); }) : h("div", { className: "dsm-empty" }, dq ? t("empty.search") : t("empty.source"))) : null);
        // 表头已随列表行两行制拆除（REDESIGN §3.4 没有表头行；「来源」列的信息由组头承担，
        // 组头挂 dsm-source-head-pin：滚动长列表时组名 + 计数 + 组内全选吸在页签条下缘，
        // 切片三移交项，样式见 10-css.js 尾段）。
        // 目录那颗「全选」的撤销条贴在这张卡片上方：它只作用于这个目录，而页头那颗的撤销条
        // 在搜索框下面（见 content）。撤销条跟着**触发它的按钮**走，别让人回头找。
        return h(react.Fragment, { key: root.key },
          undo && undo.scope === root.key ? h(UndoBar, { key: "undo", undo: undo, busy: busy, t: t, onUndo: undoBulk, onClose: dismissUndo }) : null,
          section);
      }

      var summary = data.summary || { total: 0, enabled: 0, disabled: 0, issues: 0 };
      /**
       * 统计格标签：取 `key.one` / `key.other` 那份纯名词（「技能」「来源」「诊断」）。
       * 2026-10-12 起标签改成名词在前、值（"12/20" 这种比例）在后，所以这里不再需要
       * 剥数字 —— 保留 replace 只为兼容万一还有带 {count} 的量词文案，纯名词时它是空操作。
       */
      function statLabel(key, count) { return t(countKey(key, count), { count: count }).replace(String(count), ""); }
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
        // 会话作用域（0.21.2）：会话层**逐条写 `scope-set`**，不碰 `skill-set-all`。
        // 那条 op 改的是全局启停名单与首选策略；会话层只是本会话的可见性视图（决策 10），
        // 用它来承接批量按钮就是「批量点了、别的对话一起变了」。串行提交的理由与记忆页
        // 同一条：侧车每次写都要整份重写，并发只是排队，还会让失败时的书写顺序不可读。
        if (scopeIsSession()) {
          var doneN = 0, failText = null;
          var chain = Promise.resolve();
          items.forEach(function (x) {
            chain = chain.then(function () {
              if (failText) return null;
              return scopeWriteFlag('skills', x.root + '/' + (x.canonical || x.name), enabled, function () { return { ok: true } })
                .then(function (res) { if (res && res.ok === false) failText = translateError(t, res); else doneN += 1 })
                .catch(function (e) { failText = errMsg(e) });
            });
          });
          chain.then(function () {
            setBusy(false);
            var changedN = 0;
            for (var k = 0; k < items.length; k++) if (items[k].on !== enabled) changedN += 1;
            // 复用 `bulk.done.skills` 那条（带「失败 N」），失败原因另起一句挂在后面 ——
            // 记忆页那条 `memory.bulk.partial` 的量词是「条记忆」，套到技能上就是错话。
            setResult(failText
              ? { ok: false, text: t("bulk.done.skills", { action: t(enabled ? "bulk.enabled" : "bulk.disabled"), count: doneN, failed: items.length - doneN }) + " · " + failText }
              : { ok: true, text: t("bulk.done.skills", { action: t(enabled ? "bulk.enabled" : "bulk.disabled"), count: changedN, failed: 0 }) });
            if (!failText) {
              // 「当前共 N 个启用」按**本层**算（`skillView.enabledCount` 是本层投影后的值）；
              // 用全局的 `summary.enabled` 会在会话层报一个与页头不一致的数字。
              var enabledNow = skillView.enabledCount;
              setUndo({
                text: t("undo.skills", { action: t(enabled ? "bulk.enabled" : "bulk.disabled"), count: changedN, enabled: enabled ? enabledNow + changedN : enabledNow - changedN }),
                items: items,
                revert: function (item) { return scopeWriteFlag('skills', item.root + '/' + (item.canonical || item.name), item.on, function () { return { ok: true } }) },
                scope: scope || null,
                roots: items.map(function (x) { return x.root; }).filter(function (v, i, a) { return a.indexOf(v) === i; }),
              });
            }
            refresh(true);
          });
          return;
        }
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
      // 页头一行化（REDESIGN §3 + §6）：新增(实底) · 导入 · 导出 · 添加目录 · 全选 · 回收站（恒最右）；
      // 统计内联进页头（tabular-nums）。
      // 「全选」2026-10-12 从列表工具条**再上移一格**到页头、紧挨回收站左侧（用户：「这个地方的
      // 全选移到回收站旁边」）：它和回收站一样是整页范围的动作，同排才成组；留在工具条会把
      // 搜索行挤窄，而那一行现在要让位给搜索框（筛选下拉同时收窄，见 .dsm-source-filter）。
      var content = [h("style", { key: "css" }, CSS),
      h(PageHead, { key: "head", title: t("title"), desc: t("desc"),
        // 三格：技能「启用 / 总数」比例 · 来源目录数 · 诊断项数。第一格此前只给总数
        // （"12 个技能"），答不了"有几个是开着的"；分母服务端一直在给（summary.total）。
        // 诊断项 >0 时整格转错误色（dsm-stat-over），让"有没有问题"一眼可见。
        stats: [[(scopeIsSession() ? skillView.enabledCount : summary.enabled) + "/" + summary.total, statLabel("summary.total", summary.total)], [roots.length, statLabel("summary.sources", roots.length)], [summary.issues, statLabel("summary.issues", summary.issues), summary.issues > 0 ? "dsm-stat-over" : ""]],
        actions: [h("button", { key: "new", type: "button", className: "dsm-btn", disabled: anyLocked, onClick: openCreate }, t("btn.create")), h("button", { key: "import", type: "button", className: "dsm-btn dsm-btn-secondary", disabled: anyLocked, onClick: function () { setResult(null); setUpload(null); setModal("import"); } }, t("btn.import")), h("button", { key: "export", type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: function () { setResult(null); setModal("export"); } }, t("export.skills")), h("button", { key: "custom", type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: function () { setResult(null); setCustomForm({ path: "", label: "" }); setModal("custom-add"); } }, t("btn.custom.add")), h("button", { key: "bulk", type: "button", className: "dsm-btn dsm-btn-secondary dsm-btn-bulk", disabled: busy || scopeWriteLocked(anyLocked) || !bulkAll.targets.length, title: t("bulk.head.title"), onClick: function () { submitBulk(bulkAll.targets, !bulkAll.on, null) } }, bulkPair(bulkAll.on ? t("bulk.unselectAll") : t("bulk.selectAll"), bulkAll.on ? t("bulk.selectAll") : t("bulk.unselectAll"))), h("button", { key: "trash", type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { setModal("trash"); } }, t("trash.btn.open"))] }), anyLocked && !scopeIsSession() ? h("div", { key: "lockbanner", className: "dsm-feedback dsm-warning", role: "status" }, t("lock.banner")) : null,
      // 锁定期间不显示场景那条长句：开关全是灰的，"改动会同步写进档案"没有落点，
      // 两条并排还会互相矛盾（用户 2026-09-19）。
      // 会话层不显示（同 MCP 页）：本层开关写的是会话覆盖，不同步档案。
      (!anyLocked && sceneName && !scopeIsSession()) ? h("div", { key: "scenebanner", className: "dsm-feedback dsm-warning", role: "status" }, t("scene.switch.banner", { scene: sceneName })) : null,
      h(Toolbar, { key: "filters" }, h("input", { className: "dsm-control dsm-search", value: query, "aria-label": t("search"), placeholder: t("search.placeholder"), onChange: function (e) { setQuery(e.target.value); } }), h("div", { className: "dsm-source-filter" }, h(SourceSelect, { value: activeSource, options: options, onChange: setSource }))), undo && undo.scope == null ? h(UndoBar, { key: "undo", undo: undo, busy: busy, t: t, onUndo: undoBulk, onClose: dismissUndo }) : null, result && modal !== "import" ? h(Notice, { key: "result", kind: result.warning ? "warn" : result.ok ? "ok" : "err", text: result.text }) : null].concat((data.warnings || []).map(function (warning, index) { return h(Notice, { key: "warning-" + index, kind: "warn", text: translateError(t, warning) }); }), [snapshot.error ? h(Notice, { key: "error", kind: "err", text: snapshot.error }) : null,
      // 列表四态（REDESIGN §12.2，切片四）：加载 / 失败（EmptyState + 重试，只在完全没有
      // 旧数据时顶掉列表）/ 有数据。错误横幅照旧挂着 —— 它同时承担「有缓存数据时的错误」。
      snapshot.loading && !snapshot.data ? h(ListStates, { key: "loading", t: t, state: "loading" })
        : snapshot.error && !snapshot.data ? h(ListStates, { key: "errstate", t: t, state: "error", text: snapshot.error, onRetry: function () { refresh(); } })
          : h("div", { key: "sources", className: "dsm-sources" }, roots.map(renderRoot))]);

      if (modal === "create") content.push(h(Modal, { key: "create", title: t("create.title"), closeLabel: t("btn.close"), onClose: dismissCreate }, h("div", { className: "dsm-form" },
        // 创建位置用分段控件而不是下拉（用户 2026-10-15）：候选就是全部可写来源，
        // 互斥单选，与「重名处理」「提示词类型」同款；只有一项时也如实显示"只有这一个去处"。
        h("div", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.target")),
          h("div", { className: "dsm-form-seg", role: "group", "aria-label": t("create.target") },
            createOptions.map(function (o) { return h("button", { key: o.value, type: "button", "aria-pressed": form.root === o.value ? "true" : "false", onClick: function () { updateForm("root", o.value); } }, o.label); }))),
        [["name", "create.name", "create.name.placeholder"], ["description", "create.description", "create.description.placeholder"]].map(function (field) { return h("label", { key: field[0], className: "dsm-field" }, h("div", { className: "dsm-budget-meta" }, h("span", { className: "dsm-label" }, t(field[1])), field[0] === "description" ? h("span", { className: "dsm-char-count" }, String(form.description || "").length + " / " + CATALOG_DESC_MAX) : null), h("input", { className: "dsm-control", value: form[field[0]], placeholder: t(field[2]), maxLength: field[0] === "description" ? CATALOG_DESC_MAX : undefined, onChange: function (e) { updateForm(field[0], e.target.value); } })); }), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("create.body")), h("textarea", { className: "dsm-control", value: form.body, placeholder: t("create.body.placeholder"), onChange: function (e) { updateForm("body", e.target.value); } })), renderAttachField()), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn", disabled: busy || !form.name.trim() || !form.description.trim() || !form.body.trim(), onClick: submitCreate }, t("btn.create.now")))));
      // 附件小窗（两种模式共用最上面那格文件夹名）：
      //   new  = 文件名 + 内容，在界面里写一份；
      //   pick = 一块拖放区，挑进来的文件都挂在那格文件夹下（留空 = 技能目录根）。
      if (draftFile) content.push(h(Modal, {
        key: "attach-new", title: draftFile.mode === "pick" ? t("skill.attach.pick") : t("skill.attach.new"),
        closeLabel: t("btn.close"), className: "dsm-modal-compact",
        onClose: function () { setDraftFile(null); },
      }, h("div", { className: "dsm-form" },
        h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("skill.attach.dir")),
          h("input", { className: "dsm-control", value: draftFile.dir, placeholder: t("skill.attach.dir.placeholder"), onChange: function (e) { setDraftFile(Object.assign({}, draftFile, { dir: e.target.value, error: null })) } })),
        draftFile.mode === "pick"
          ? h("div", { className: "dsm-field" },
            h("span", { className: "dsm-label" }, t("skill.attach.files")),
            h("button", {
              type: "button", className: "dsm-dropzone dsm-dropzone-sm",
              onClick: function () { if (attachInputRef.current) attachInputRef.current.click() },
              onDragOver: function (e) { e.preventDefault() }, onDrop: onAttachmentsDropped,
            },
              h("span", { className: "dsm-dropzone-title" }, t("upload.drop.title")),
              h("span", { className: "dsm-dropzone-copy" }, t("skill.attach.drop.copy"))),
            // 挑完的东西就地列出来：不列的话弹窗把后面那份清单挡住，人只知道"按了没反应"。
            (form.files || []).length ? h("div", { className: "dsm-attach-list dsm-attach-cap" }, form.files.map(attachRow)) : null)
          : [
            h("label", { key: "n", className: "dsm-field" }, h("span", { className: "dsm-label" }, t("skill.attach.name")),
              h("input", { className: "dsm-control", value: draftFile.name, placeholder: t("skill.attach.name.placeholder"), onChange: function (e) { setDraftFile(Object.assign({}, draftFile, { name: e.target.value, error: null })) } })),
            h("label", { key: "c", className: "dsm-field" }, h("span", { className: "dsm-label" }, t("skill.attach.content")),
              h("textarea", { className: "dsm-control dsm-textarea-md", value: draftFile.content, placeholder: t("skill.attach.content.placeholder"), onChange: function (e) { setDraftFile(Object.assign({}, draftFile, { content: e.target.value })) } })),
          ],
        draftFile.error ? h("div", { className: "dsm-feedback dsm-error", role: "alert" }, draftFile.error) : null),
        draftFile.mode === "pick" ? h("input", { ref: attachInputRef, type: "file", multiple: true, className: "dsm-hidden-input", onChange: onAttachmentsPicked }) : null,
        h("div", { className: "dsm-modal-actions" },
          draftFile.mode === "pick"
            ? h("button", { type: "button", className: "dsm-btn", onClick: function () { setDraftFile(null); } }, t("skill.attach.done"))
            : [
              h("button", { key: "x", type: "button", className: "dsm-btn dsm-btn-secondary", onClick: function () { setDraftFile(null); } }, t("btn.cancel")),
              h("button", { key: "ok", type: "button", className: "dsm-btn", disabled: !String(draftFile.name || "").trim(), onClick: submitNewFile }, typeof draftFile.index === "number" ? t("memory.btn.save") : t("skill.attach.add")),
            ])));
      // D13：导入弹窗统一用共享 ImportModal（能力取三者并集：拖拽区 + 已选文件行 +
      // 文件要求清单 + 结果反馈）。技能页只保留自己的校验与提交逻辑。
      if (modal === "import") content.push(h(ImportModal, {
        key: "import", t: t, title: t("import.title"), accept: ".zip,.md",
        busy: busy, result: result,
        requirement: t("upload.req.skills"),
        requirementTitle: [t("upload.requirement.skill"), t("upload.requirement.frontmatter"), t("upload.requirement.copy")].join("\n"),
        onClose: function () { pickerOpenRef.current = false; setUpload(null); setResult(null); setModal(null); },
        onSubmit: function (entries, files) {
          var selected = inspectUploadSelection(files);
          if (!selected) return;
          if (selected.error) { setResult({ ok: false, text: translateError(t, selected.error) }); return; }
          setUpload(selected);
          submitImport(selected);
        },
      }));
      if (modal === "detail") content.push(h(Modal, { key: "detail", wide: true, title: t("detail.title"), closeLabel: t("btn.close"), onClose: closeModal }, detail ? h(react.Fragment, null,
        // 路径与「编辑器查看」**同一行**（用户 2026-10-12：「和技能目录一行，中间大面积空白删除」）：
        // 原来是路径一行 + .dsm-modal-actions（右对齐）又一行，两行之间一大片空白。
        // 路径条 flex:1 吃掉剩余宽度、按钮固定不动，窄了路径自己折行（word-break:break-all）。
        h("div", { className: "dsm-detail-path-row" }, h("div", { className: "dsm-detail-path" }, detail.path), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openSource }, t("btn.open.editor"))),
        h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.diagnostics")), detail.diagnostics.length ? detail.diagnostics.map(function (item, index) { return h("div", { key: index, className: "dsm-diag" }, t(item.code, item.params || {})); }) : h("div", { className: "dsm-note" }, t("detail.noIssues"))), h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.frontmatter")), renderFrontmatter(t, detail.frontmatter)),
        // 附件清单（服务端 skill-detail 现在会列 bundle 目录里 SKILL.md 之外的文件）：
        // 建完之后要能在界面里看到它们真的落进去了，否则「加了附件」只有创建那一次是可信的。
        detail.attachments && detail.attachments.length ? h("div", { className: "dsm-detail-section" },
          h("div", { className: "dsm-detail-title" }, t("detail.attachments") + " · " + detail.attachments.length + (detail.attachmentsTruncated ? " +" : "")),
          h("div", { className: "dsm-attach-list dsm-attach-cap" }, detail.attachments.map(function (a) {
            return h("div", { key: a.path, className: "dsm-file", title: a.path },
              h("span", { className: "dsm-file-name" }, a.path),
              h("span", { className: "dsm-file-meta" }, fmtBytes(a.size)))
          }))) : null,
        h("div", { className: "dsm-detail-section" }, h("div", { className: "dsm-detail-title" }, t("detail.body")), h("pre", { className: "dsm-code" }, detail.body || ""))) : h("div", { className: "dsm-empty" }, t("loading"))));
      if (modal === "export") content.push(h(ExportModal, {
        key: "export", t: t, title: t("export.skills"),
        items: exportItems(), busy: busy, result: result,
        onClose: function () { setResult(null); setModal(null); },
        onSubmit: doExport,
      }));
      // 本页的回收站（42-shared-ui.js 的 TrashModal）：原先手写的双块弹窗（目录块 +
      // 技能块、各自勾选批量）已并入共享组件 —— 列表加载 / 勾选 / 恢复 / 永久删除 / 保留期
      // 都在组件内部。「目录」与「技能」两组上下排着，各自的批量条照旧独立
      // （2026-10-10「全选要拆成两部分」的裁定由分组标题 + 分组批量条承接）。
      if (modal === "trash") content.push(h(TrashModal, { key: "trash-modal", t: t, domain: "skills", onClose: function () { setModal(null); }, onReload: function () { refresh(true); } }));
      if (modal && modal.type === "trash-confirm") content.push(h(Modal, { key: "trash-confirm", title: t("confirm.trash.title"), closeLabel: t("btn.close"), className: "dsm-modal-sm", onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.trash.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn", disabled: busy, onClick: function () { post("/delete", { root: modal.root, name: modal.name }, "result.trashed", { name: modal.name }).then(function () { setModal(null); }).catch(swallowPostError); } }, t("btn.trash")))));
      if (modal === "custom-add") content.push(h(Modal, { key: "custom-add", title: t("custom.add.title"), closeLabel: t("btn.close"), onClose: function () { setModal(null); } }, h("div", { className: "dsm-form" }, h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.path")), h("div", { className: "dsm-dir-row" }, h("input", { className: "dsm-control", value: customForm.path, placeholder: defaultIoDir(), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { path: e.target.value })); } }), h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: busy, onClick: openCustomDir, title: t("custom.add.openDir.title") }, t("btn.openDir")))), h("label", { className: "dsm-field" }, h("span", { className: "dsm-label" }, t("custom.add.label")), h("input", { className: "dsm-control", value: customForm.label, placeholder: t("custom.add.label.placeholder"), onChange: function (e) { setCustomForm(Object.assign({}, customForm, { label: e.target.value })); } })), h("p", { className: "dsm-help" }, t("custom.add.help")), result ? h("div", { className: "dsm-feedback" + (result.warning ? " dsm-warning" : result.ok ? "" : " dsm-error"), role: "alert" }, result.text) : null), customForm.picking ? h(DirPickerModal, { key: "custom-dir-picker", title: t("custom.add.picker.title"), initial: String(customForm.path || ""), closeLabel: t("btn.close"), onClose: function () { setCustomForm(Object.assign({}, customForm, { picking: false })); }, onPick: function (path) { setCustomForm(Object.assign({}, customForm, { path: path, picking: false })); } }) : null, h("div", { className: "dsm-modal-actions" }, h("button", { type: "button", className: "dsm-btn", disabled: busy || !String(customForm.path || "").trim(), onClick: submitCustomAdd }, t("custom.add.submit")))));
      if (modal && modal.type === "source-remove-confirm") content.push(h(Modal, { key: "source-remove-confirm", title: t("confirm.source.remove.title"), closeLabel: t("btn.close"), className: "dsm-modal-sm", onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.source.remove.desc", { name: modal.name })), h("p", { className: "dsm-help" }, t("confirm.source.remove.hint")), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { post("/source-remove", { root: modal.key }, "result.sourceRemoved", { name: modal.name }).then(function () { setModal(null); }).catch(swallowPostError); } }, t("btn.source.remove")))));
      if (modal && modal.type === "source-stop-confirm") content.push(h(Modal, { key: "source-stop-confirm", title: t("scope.intent.stopTitle"), closeLabel: t("btn.close"), className: "dsm-modal-sm", onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("scope.intent.stopDesc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { var key = modal.key, name = modal.name; setModal(null); setSourceIntent({ key: key, label: name }, 'blocked'); } }, t("scope.intent.stop")))));
      if (modal && modal.type === "custom-remove-confirm") content.push(h(Modal, { key: "custom-remove-confirm", title: t("confirm.custom.remove.title"), closeLabel: t("btn.close"), className: "dsm-modal-sm", onClose: function () { setModal(null); } }, h("p", { className: "dsm-desc" }, t("confirm.custom.remove.desc", { name: modal.name })), h("div", { className: "dsm-modal-actions" }, h("button", { className: "dsm-btn dsm-btn-danger", disabled: busy, onClick: function () { submitCustomRemove(modal.key, modal.name); } }, t("btn.custom.remove")))));
      // 「已存在同名技能」小窗：叠在「创建技能」弹窗之上（`Modal` 自带 gateModalDepth 计数）。
      // 取消 → 回到创建弹窗改名字，简介与正文一个字都不动。
      if (dupAsk) content.push(h(DupNameDialog, {
        key: "dup-name", t: t, kind: t("dup.kind.skill"),
        name: dupAsk.name, finalName: dupAsk.finalName, action: "create",
        busy: busy,
        onCancel: function () { setDupAsk(null); },
        onConfirm: function () { setDupAsk(null); createSkill(dupAsk.finalName); },
      }));
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