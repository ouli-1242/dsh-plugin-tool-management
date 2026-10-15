
        // ---------- Skills 页（移植自 dsh-skills-manager，Apache-2.0；类名前缀 dsm-） ----------
        // `react` / `h` 别名原在这里声明；2026-10-11 切片五上移到 20 片（工厂作用域）——
        // 兼容页与上移到那边的共用控件（Switch / SourceSelect / RowCheck / SettingsRow）同用一套。

        // SKILL.md frontmatter 已知键的标签走 DICT（fm.label.*，未知键原样显示并附原始键名提示）。
        function frontmatterValue(t, value) {
          if (Array.isArray(value)) return value.join('、')
          if (value === true) return t('fm.yes')
          if (value === false) return t('fm.no')
          if (value === null || value === undefined) return ''
          if (typeof value === 'object') return JSON.stringify(value, null, 2)
          return String(value)
        }
        // 详情页把 frontmatter 渲染成键值表（原始 JSON 对使用者几乎不可读）。
        function renderFrontmatter(t, frontmatter) {
          var keys = frontmatter && typeof frontmatter === 'object' ? Object.keys(frontmatter) : []
          if (!keys.length) return h('div', { className: 'dsm-note' }, t('detail.noFrontmatter'))
          return h('div', { className: 'dsm-fm' }, keys.map(function (key) {
            var label = translateOrFallback(t, 'fm.label.' + key, key)
            return h('div', { className: 'dsm-fm-row', key: key },
              h('div', { className: 'dsm-fm-key' }, label, label === key ? null : h('span', { className: 'dsm-fm-raw' }, key)),
              h('div', { className: 'dsm-fm-val' }, frontmatterValue(t, frontmatter[key])))
          }))
        }

    function translateError(t, payload) {
      // HTTP 层抛的 Error 还带 code/params（见 parseApiResponse），声明里没有这两个字段。
      if (payload instanceof Error && !(/** @type {any} */ (payload)).code) return payload.message;
      if (payload && typeof payload === "object") {
        if (payload.code) { var params = Object.assign({}, payload.params || {}); if (params.action) params.action = translateOrFallback(t, "action." + params.action, params.action); var translated = t(payload.code, params); if (typeof translated === "string" && translated !== payload.code) return translated; }
        if (payload.error !== undefined) return translateError(t, payload.error); if (payload.message !== undefined) return String(payload.message);
      }
      return String(payload == null ? "" : payload);
    }
    function parseApiResponse(response) { return response.json().catch(function () { var error = /** @type {any} */ (new Error("non-json response")); error.code = "error.proto.nonJson"; error.params = { status: response.status }; throw error; }).then(function (payload) { if (!response.ok || payload.ok === false) throw payload; return payload.data; }); }
    var OP_BY_PATH = { "/state": "skill-state", "/enable": "skill-enable", "/disable": "skill-disable",
  "/prefer": "skill-prefer", "/unprefer": "skill-unprefer",
  "/source-enable": "skill-source-enable", "/source-disable": "skill-source-disable",
  // 「移除来源 / 恢复读取」两个按钮曾经打的是这两个路径，但映射表里没有它们 ——
  // callApi 直接 reject("unknown action")，弹窗又 catch 掉了，按钮点下去毫无反应。
  "/source-remove": "skill-source-remove", "/source-restore": "skill-source-restore",
  "/delete": "skill-delete", "/trash-restore": "skill-trash-restore", "/trash-delete": "skill-trash-delete",
  "/detail": "skill-detail", "/create": "skill-create", "/import": "skill-import",
  "/upload": "skill-upload", "/browse": "skill-browse" };
function callApi(path, options) {
  var op = OP_BY_PATH[path];
  if (!op) return Promise.reject({ error: "unknown action: " + path });
  var args = {};
  if (options && typeof options.body === "string") { try { args = JSON.parse(options.body) || {}; } catch (e) { args = {}; } }
  return apiCall(op, args).then(function (payload) {
    if (!payload || payload.ok !== true) throw payload || { error: "request failed" };
    // 场景内改开关时宿主会顺手把改动同步写进当前场景档案；同步没跟上（写盘失败 /
    // 场景已被删）时它会挂一个 `sceneSyncError`。这里必须把它带出去 —— 否则页面只会
    // 显示「已更新」，而运行时与档案已经对不上了（v0.9.1 之前正是静默的，用户只能靠肉眼
    // 去档案里比对才发现）。
    if (payload.sceneSyncError) {
      return Object.assign({}, (payload.data && typeof payload.data === "object") ? payload.data : {}, { sceneSyncError: payload.sceneSyncError });
    }
    return payload.data;
  });
}
/**
 * 「改动已生效，但没能同步写进场景档案」的提示文案（没有就返回空串）。
 *
 * 入参可以是原始响应信封，也可以是上面 callApi 贴过字段的 data —— 两种都认。
 */
function sceneSyncWarn(t, res) {
  var err = res && res.sceneSyncError;
  return err ? t("scene.sync.failed", { error: String(err) }) : "";
}
/**
 * 启停状态没能同步（服务端 stateSyncError）。技能页与子智能体页共用：
 * 写盘失败时受影响的条目会停在启用态、下一轮进模型上下文，而回执本来是「成功」。
 * 服务端只给原因原文，句子在这里按当前语言拼。
 */
function stateSyncWarn(t, res) {
  var err = res && res.stateSyncError;
  return err ? t("state.sync.failed", { error: String(err) }) : "";
}
/** 把若干条提示拼成一句（空串自动丢掉，避免多出空格）。 */
function joinWarn() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
  return out.join(" ");
}
/**
 * 批量开关的撤销条状态：`{ text, items, revert }`。四域共用（MCP / 技能 / 记忆）。
 *
 * **为什么是撤销条而不是确认框**：批量启停是**可逆**操作，事前拦一道只会让每次点击都多一步，
 * 而「一次改了三十条、发现改错了」才是真正需要出路的时候。所以事后给一条退路。
 *
 * **为什么没有倒计时**：最初给的是 8 秒自动消失（照 snackbar 的惯例），但那个惯例的前提是
 * 「错过也无所谓」—— 撤销条不是：它是这次批量操作**唯一的**补救通道，错过就永久失去，
 * 背后可能是几十项改动。而 8 秒的预算还会被别的东西吃掉 —— 用户先要读完旁边的结果提示，
 * 才开始判断「我是不是改错了」，判断本身需要时间。所以改成常驻：直到点「撤销」、点「×」、
 * 或发起新的批量操作（新的替换旧的）。切页签仍会清掉（页面是条件渲染），但那个时点已经
 * 隔得够久，算合理的自然失效。
 *
 * `items` 记的是**操作前**的状态，`revert(item)` 把一条写回原值 —— 撤销复用同一批 op，
 * 不需要服务端新增回滚接口，也就不会出现「回滚接口与写入接口口径不一致」这类新问题。
 */
function useUndoState() {
  var pair = React.useState(null)
  var setUndo = pair[1]
  /** 主动收起撤销条（不想要这条退路时）。 */
  function dismiss() { setUndo(null) }
  return [pair[0], setUndo, dismiss]
}
/**
 * 搜索框的防抖值：输入框继续用 `query`（受控，打字不掉字），**过滤用返回值** ——
 * 每次按键都全量过滤一遍大列表是白费的，用户停手 200ms 才更新一次。
 *
 * 只跟 `value` 走：页面自己的定时轮询 / 手动刷新改的是数据，不是输入框的值，所以
 * 轮询不会把防抖计时重置（也不会吞掉用户正在输入的词）。
 */
function useDebouncedValue(value, delay) {
  var wait = delay === undefined ? 200 : delay
  var pair = React.useState(value)
  var debounced = pair[0], setDebounced = pair[1]
  React.useEffect(function () {
    if (debounced === value) return undefined
    var timer = setTimeout(function () { setDebounced(value) }, wait)
    return function () { clearTimeout(timer) }
  }, [value, debounced, wait])
  return debounced
}
/**
 * 撤销条本体：一句话 + 一个「撤销」按钮 + 一个「×」收起按钮。
 *
 * 样式用 `dsm-warning`（琥珀边框 + 琥珀提示句 + 淡琥珀底，见 10-css.js）：它是这次批量
 * 操作**唯一**的补救通道，而原先的灰边框灰字与旁边的普通回执长得一样，扫一眼根本不会
 * 注意到（用户 2026-09-19：「边框和提示句变成黄色的更醒目」）。按钮保持常规样式 ——
 * 整条都染黄会让"可点的动作"和"要读的提示"分不开。
 */
function UndoBar(props) {
  if (!props.undo) return null
  return React.createElement('div', { className: 'dsm-feedback dsm-undo dsm-warning', role: 'status' },
    React.createElement('span', { className: 'dsm-undo-text' }, props.undo.text),
    React.createElement('button', {
      type: 'button', className: 'dsm-btn dsm-btn-secondary',
      disabled: props.busy === true,
      onClick: props.onUndo,
    }, props.t('undo.action')),
    React.createElement('button', {
      type: 'button', className: 'dsm-undo-close',
      // 视觉上是「×」，屏幕阅读器读不到字形，所以要 aria-label；title 顺带给鼠标用户一个提示。
      'aria-label': props.t('undo.dismiss'), title: props.t('undo.dismiss'),
      onClick: props.onClose,
    }, '×'))
}
/**
 * 逐条写回原值，返回失败条数。
 * 并发提交而非顺序：这些 op 在服务端各自走写队列，天然串行，顺序提交只会拉长等待。
 */
function runUndo(entry) {
  return Promise.all(entry.items.map(function (item) {
    return entry.revert(item)
      .then(function (res) { return res && res.ok === false ? 1 : 0 })
      .catch(function () { return 1 })
  })).then(function (codes) {
    var failed = 0
    for (var i = 0; i < codes.length; i++) failed += codes[i]
    return failed
  })
}
/**
 * 已启用的记忆条数 —— 与 `rules[*].enabled !== false` 同一口径（行内 Switch 用的就是它）。
 *
 * 撤销条要说「当前共几条处于启用状态」，而 `data.rules` 是**操作前**的快照
 * （撤销条就在那次操作的 `.then` 里生成，刷新还没回来），所以调用方拿它加减本次改动数，
 * 而不是去读一个还没更新的快照。
 */
function enabledMemoryCount(rules) {
  return (rules || []).filter(function (r) { return r.enabled !== false }).length
}
    function isSkillEnabled(skill) { if (skill.enabled !== undefined) return skill.enabled === true; return skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false; }
    function countKey(key, count) { return key + (Number(count) === 1 ? ".one" : ".other"); }
    function rootDisplayName(t, root) { var base = translateOrFallback(t, "root." + (root.localeKey || root.kind || root.key), root.label); return root.projectName ? base + " · " + root.projectName : base; }
    function summarizeImportResult(t, data) {
      var importedItems = data && data.imported || [];
      var imported = importedItems.map(function (item) { return item.name; });
      var skipped = (data && data.skipped || []).map(function (item) { return item.name; });
      var warnings = [];
      // 「默认停用」没写进去：导入的条目会停在启用态，必须和 import warnings 一起说出来。
      var syncErr = stateSyncWarn(t, data);
      if (syncErr) warnings.push(syncErr);
      importedItems.forEach(function (item) {
        (item.warnings || []).forEach(function (warning) { warnings.push(translateError(t, warning)); });
      });
      var summary;
      if (imported.length && skipped.length) summary = { ok: true, warning: true, imported: true, text: t("result.importPartial", { imported: imported.join(", "), skipped: skipped.join(", ") }) };
      else if (imported.length) summary = { ok: true, warning: false, imported: true, text: t("result.imported", { names: imported.join(", ") }) };
      else if (skipped.length) summary = { ok: false, warning: true, imported: false, text: t("result.importSkipped", { names: skipped.join(", ") }) };
      else summary = { ok: false, warning: false, imported: false, text: t("result.importEmpty") };
      if (warnings.length) {
        summary.warning = true;
        summary.text = t("result.importWarnings", { result: summary.text, warnings: warnings.join("；") });
      }
      return summary;
    }
    function normalizeSkillQuery(query) { return String(query == null ? "" : query).trim().toLowerCase(); }
    function matchSkillQuery(skill, query) { var q = normalizeSkillQuery(query); if (!q) return true; return [skill.name, skill.declaredName, skill.description, skill.kind, skill.kindLabel, skill.statusLabel, skill.rootKey, skill.rootLabel].some(function (value) { return String(value == null ? "" : value).toLowerCase().includes(q); }); }
    function filterSkills(list, options) { var rootKey = options && options.rootKey != null ? options.rootKey : ""; return list.filter(function (skill) { return (!rootKey || skill.rootKey === rootKey) && matchSkillQuery(skill, options && options.query); }); }
    /**
     * 提示词页与子智能体页的搜索匹配（只匹配 id/名 + 描述）。
     *
     * 刻意不复用 `matchSkillQuery`：那一个依赖 `rootKey`/`rootLabel` 这两个**由调用方补齐**
     * 的派生字段，而这两个页面没有它们 —— 复用会得到"搜什么都匹配"或"搜什么都搜不到"。
     */
    function matchByText(fields, query) { var q = normalizeSkillQuery(query); if (!q) return true; return fields.some(function (value) { return String(value == null ? "" : value).toLowerCase().includes(q); }); }
    function matchPresetQuery(preset, query) { return matchByText([preset.id, preset.description], query); }
    function matchPersonaQuery(persona, query) { return matchByText([persona.name, persona.description], query); }
    // 技能页主列表：去掉没有技能的项目级空壳，以及**已被移除**的来源（它们单独一组显示，
    // 在那里可以「恢复读取」）。项目根与已移除根都不参与「全部来源」筛选。
    function visibleSkillRoots(roots) { return (roots || []).filter(function (root) { if (root.removed === true) return false; return root.scope !== "project" || (root.skills || []).length > 0; }); }
    /** 已移除的来源（不在主列表里，但要让用户看得到并恢复）。 */
    function removedSkillRoots(roots) { return (roots || []).filter(function (root) { return root.removed === true; }); }
    var MAX_UPLOAD_ARCHIVE_BYTES = 32 << 20, MAX_UPLOAD_ENTRY_BYTES = 32 << 20, MAX_UPLOAD_TOTAL_BYTES = 64 << 20, MAX_UPLOAD_ENTRIES = 1000;
    /**
     * 注入段里"模型实际能看到多长"的截断长度，同时当输入框的 `maxLength` 与字数计数的分母
     * —— 写多少就能被看到多少，不会出现"界面让你写 500 字、模型只读到前 300"。
     *
     * ⚠️ 宿主侧各有一份真相：`src/mcp/state-section.ts` 的 `DEFAULT_MCP_NOTE_MAX_LENGTH`、
     * `src/skills/catalog.ts` 与 `src/subagents/catalog.ts` 的 `..._DESCRIPTION_MAX_LENGTH`、
     * `src/prompts/service.ts` 的 `DEFAULT_PRESET_DESC_MAX_LENGTH`（提示词预设描述 —— 0.14.0
     * 起它会进模型清单，所以有了预算）。
     * 两边没有编译期约束（计划文档 A3 说的"同一事实两处写"），改一处必须改另一处。
     */
    var MCP_NOTE_MAX = 300, CATALOG_DESC_MAX = 500, PRESET_DESC_MAX = 300;
    function uploadFilePath(file) { return String(file && (file._dssmPath || file.webkitRelativePath || file.name) || "").replace(/\\/g, "/"); }
    function inspectUploadSelection(files) {
      var list = Array.prototype.slice.call(files || []); if (!list.length) return null;
      if (list.length > MAX_UPLOAD_ENTRIES) return { error: { code: "error.upload.tooMany", params: { limit: MAX_UPLOAD_ENTRIES } } };
      var relative = list.some(function (file) { return uploadFilePath(file).includes("/"); });
      if (relative) {
        if (!list.some(function (file) { return /(^|\/)skill\.md$/i.test(uploadFilePath(file)); })) return { error: { code: "select.folder.invalid" } };
        var oversized = list.find(function (file) { return Number(file.size || 0) > MAX_UPLOAD_ENTRY_BYTES; });
        if (oversized) return { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_ENTRY_BYTES } } };
        var total = list.reduce(function (sum, file) { return sum + Number(file.size || 0); }, 0);
        if (total > MAX_UPLOAD_TOTAL_BYTES) return { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_TOTAL_BYTES } } };
        return { kind: "folder", name: uploadFilePath(list[0]).split("/")[0], files: list, count: list.length, size: total };
      }
      if (list.length !== 1) return { error: { code: "select.file.invalid" } };
      var name = String(list[0].name || ""), lower = name.toLowerCase();
      var size = Number(list[0].size || 0);
      if (lower === "skill.md") return size > MAX_UPLOAD_ENTRY_BYTES ? { error: { code: "error.upload.tooLarge", params: { limit: MAX_UPLOAD_ENTRY_BYTES } } } : { kind: "skill", name: name, files: list, count: 1, size: size };
      if (lower.endsWith(".zip")) return size > MAX_UPLOAD_ARCHIVE_BYTES ? { error: { code: "error.upload.archiveTooLarge", params: { limit: MAX_UPLOAD_ARCHIVE_BYTES } } } : { kind: "zip", name: name, files: list, count: 1, size: size };
      return { error: { code: "select.file.invalid" } };
    }
    function bytesToBase64(buffer) { var bytes = new Uint8Array(buffer), binary = "", chunk = 0x8000; for (var i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length))); return btoa(binary); }
    function buildUploadPayload(selection) { return Promise.all(selection.files.map(function (file) { return file.arrayBuffer().then(function (buffer) { return { path: uploadFilePath(file), data: bytesToBase64(buffer) }; }); })).then(function (entries) { return selection.kind === "zip" ? { name: selection.name, zip: entries[0].data } : { name: selection.name, entries: entries }; }); }
    function readDroppedEntry(entry, prefix, output) { if (entry.isFile) return new Promise(function (resolve, reject) { entry.file(function (file) { file._dssmPath = prefix + file.name; output.push(file); resolve(); }, reject); }); if (!entry.isDirectory) return Promise.resolve(); return new Promise(function (resolve, reject) { var reader = entry.createReader(), children = []; function next() { reader.readEntries(function (batch) { if (!batch.length) { Promise.all(children.map(function (child) { return readDroppedEntry(child, prefix + entry.name + "/", output); })).then(resolve, reject); return; } children = children.concat(batch); next(); }, reject); } next(); }); }
    function droppedFiles(dataTransfer) { var items = Array.prototype.slice.call(dataTransfer && dataTransfer.items || []), entries = items.map(function (item) { return item.webkitGetAsEntry && item.webkitGetAsEntry(); }).filter(Boolean); if (!entries.length) return Promise.resolve(Array.prototype.slice.call(dataTransfer && dataTransfer.files || [])); var files = []; return Promise.all(entries.map(function (entry) { return readDroppedEntry(entry, "", files); })).then(function () { return files; }); }
    // 弹窗的键盘行为（Esc 关闭 / Tab 焦点陷阱）在**模块作用域**（本文件顶部「弹窗键盘行为」
    // 一节，20-helpers.js）—— 兼容页在 `apply` 之外，它的手工弹窗与 `Modal` 共用这三个函数。

    /**
     * 「亮着的排在前面」，但**序是定好的**（取代原先每渲染重排的 `enabledFirst`）。
     *
     * 用户 2026-10-12 两条口径：「当时选择时不用置顶，刷新或者重新打开这个功能页才置顶」。
     * 原先每渲染一次就照当前状态分区，于是开关一打、行当场跳位 —— 连着勾几条时点不准，
     * 列表也在晃。这里给每个条目记**第一次被看到时**的序（当时亮着 = 0），之后一律按那个
     * 序排，同半区内保持原有相对次序（`i` 兜底，等价于原先"稳定分区"的语义）。
     *
     * `rank` 由 `useRank()` 给出：**一页一张表，随组件挂载而生**。所以重新定序的时机就是
     * 重新挂载 —— 浏览器刷新、或从别的页签切回来（各页的刷新都是重新拉数据、不换组件）。
     * 返回新数组：入参多是 React state 里的数组，就地改会让列表在别处一起变。
     */
    function rankedFirst(rank, idOf, items, isOn) {
      var list = items || [];
      var table = rank.table;
      return list.map(function (item, i) {
        var k = String(idOf(item));
        if (table[k] === undefined) table[k] = isOn(item) ? 0 : 1;
        return { item: item, rank: table[k], i: i };
      }).sort(function (a, b) { return a.rank - b.rank || a.i - b.i; }).map(function (x) { return x.item });
    }
    /** 一页一张定序表（见 rankedFirst）。组件卸载即丢弃，重挂载 = 重新定序。 */
    function useRank() {
      var ref = React.useRef(null);
      if (!ref.current) ref.current = { table: {} };
      return ref.current;
    }

    // （FLIP 滑移动画与 `useFlipReorder` / `FLIP_MS` / 行上的 data-flip-* 锚点已整体删除：
    //  它是为「开关一打、行当场换位」那套重排做的补偿，而 2026-10-12 起列表改成定序
    //  （rankedFirst：当场不重排，重新挂载才置顶）—— 行不再动，动画就没有触发的时候，
    //  留着只剩成本。）

    // SourceSelect 已上移 20 片（2026-10-11 切片五）：兼容页的下拉也要收编到这里，
    // 而 apply 作用域的声明对兼容页不可见。
    // 场景输入（combobox）：既能从已有场景里挑，也能直接手输一个新场景名——
    // 宿主 rules-create 用 mkdir(recursive) 落盘，所以「自定义场景」无需先建目录。
    //
    // `onPickFolder` 是可选的第二颗按钮（0.18.5，会话导入选工作区）：选项来自登记列表，但用户
    // 也可能要挑一个从没登记过的目录，那就得走目录浏览器。它渲染在 .dsm-combo-row **里面**
    // 而不是外面 —— .dsm-field 是列向 flex，放外面会掉到下拉框下方；而 .dsm-select-menu 相对
    // .dsm-select 绝对定位，另起一行就没有对齐的锚点了。两颗都是 .dsm-btn-secondary，同高。
    function SceneCombo(props) {
      var state = react.useState(false), open = state[0], setOpen = state[1], ref = react.useRef(null);
      react.useEffect(function () { if (!open) return undefined; function close(event) { if (!ref.current || !ref.current.contains(event.target)) setOpen(false); } document.addEventListener("pointerdown", close); return function () { document.removeEventListener("pointerdown", close); }; }, [open]);
      var options = props.options || [];
      return h("div", { className: "dsm-select", ref: ref },
        h("div", { className: "dsm-combo-row" },
          h("input", { className: "dsm-control" + (props.invalid ? " dsm-rule-invalid" : ""), type: "text", value: props.value || "", placeholder: props.placeholder, "aria-label": props.label, onChange: function (e) { props.onChange(e.target.value); } }),
          h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", "aria-haspopup": "listbox", "aria-expanded": open, disabled: props.disabled || !options.length, onClick: function () { setOpen(!open); } }, props.browseLabel),
          // 开目录浏览器前先收菜单：这颗按钮在 ref 里面，document 上那个 pointerdown 关闭器不会替我关。
          props.onPickFolder ? h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", title: props.pickFolderTitle, disabled: props.disabled === true, onClick: function () { setOpen(false); props.onPickFolder(); } }, props.pickFolderLabel) : null),
        open && options.length ? h("div", { className: "dsm-select-menu", role: "listbox" }, options.map(function (o) { return h("button", { key: o.value, type: "button", role: "option", className: "dsm-option", "aria-selected": o.value === props.value, onClick: function () { props.onChange(o.value); setOpen(false); } }, o.label); })) : null);
    }
    function GithubMark16() { return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true, focusable: "false" }, h("path", { fill: "currentColor", d: "M8 0a8 8 0 0 0-2.53 15.59c.4.074.547-.173.547-.385 0-.19-.007-.693-.01-1.36-2.226.484-2.695-1.073-2.695-1.073-.364-.924-.89-1.17-.89-1.17-.726-.496.055-.486.055-.486.803.056 1.225.824 1.225.824.714 1.223 1.872.87 2.328.665.072-.517.28-.87.508-1.07-1.777-.202-3.645-.888-3.645-3.956 0-.874.31-1.588.823-2.148-.083-.202-.357-1.017.078-2.12 0 0 .672-.215 2.2.82A7.65 7.65 0 0 1 8 4.8c.68.003 1.365.092 2.004.27 1.527-1.035 2.197-.82 2.197-.82.437 1.103.162 1.918.08 2.12.513.56.822 1.274.822 2.148 0 3.076-1.872 3.752-3.654 3.95.288.248.544.735.544 1.482 0 1.07-.01 1.932-.01 2.195 0 .214.144.463.55.384A8.001 8.001 0 0 0 8 0Z" })); }
    /**
     * 弹窗原语。`list: true` 时走「列表类」三段式：固定头 / 滚动体 / 固定底，
     * 配 `.dsm-modal-list`（宽高都固定），滚动只发生在 body 这一层 —— 条目数变化时
     * 弹窗不跳、也不会出现嵌套滚动条。普通表单/确认类**不传 list**，结构保持原样。
     */
    /**
     * 工具描述：超过两行才默认只显示两行，点「展开」看全文。
     *
     * 为什么需要：MCP 工具描述动辄几百字（官方 server 的说明普遍很长），全展开会把详情弹窗
     * 撑成一面墙，用户反而找不到工具名。截断 + 展开把「扫一遍有哪些工具」和「细读某一个」
     * 分成两步。纯 CSS 行数裁剪（`-webkit-line-clamp`），不做字符截断 —— 展开时给的是原文，
     * 所以宿主的 `toolDescriptionMaxLength` 设置不影响这里（默认 0 = 不截断）。
     *
     * 按钮只按**真实溢出**显示：短的（哪怕字数不少、两行放得下）不给按钮 —— 字符数阈值
     * 会造出「点了没任何变化」的死按钮。收起态才量（展开后不裁剪，scrollHeight 不再代表
     * 被裁掉的高度）；没有 DOM（测试里的假 dispatcher）时 ref 为空，静默跳过。
     */
    function ToolDesc(props) {
      var openState = react.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var overState = react.useState(false)
      var overflow = overState[0]
      var setOverflow = overState[1]
      var ref = react.useRef(null)
      var text = String(props.text || '')
      react.useEffect(function () {
        if (open) return
        var el = ref.current
        if (!el || typeof el.scrollHeight !== "number" || typeof el.clientHeight !== "number") return
        setOverflow(el.scrollHeight > el.clientHeight + 1)
      }, [text, open])
      return h("div", { className: "dsm-tool-desc-wrap" },
        h("div", { ref: ref, className: "dsm-tool-desc" + (open ? "" : " dsm-tool-desc-clamp") }, text),
        overflow ? h("button", {
          type: "button",
          className: "dsm-tool-desc-toggle",
          onClick: function () { setOpen(!open) },
        }, open ? props.collapseLabel : props.expandLabel) : null)
    }

    /**
     * 「令牌没过」提示条的唯一形态：一句话 + 右侧「填写令牌」。
     *
     * 由 `Modal`（弹窗打开时）或 `ToolsSection`（没有弹窗时）渲染 —— 同时只渲染一份。
     * 见模块顶部 gateText 的说明。
     *
     * 用**告警色**而不是错误色（用户 2026-10-12：「改成黄色警告风格」）：它不是"操作失败"，
     * 而是"还差一步"—— 令牌没验过这件事用户自己能解决，而且顶部那条横幅本来就是琥珀色，
     * 两处同一件事不该一个红一个黄。错误色留给真正的失败（`.dsm-error`）。
     */
    function tokenGateRow(text) {
      return h('div', { className: 'dsm-feedback dsm-warning dsm-feedback-row', role: 'alert' },
        h('span', { className: 'dsm-feedback-text' }, text),
        h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openTokenPanel }, t('token.jump')))
    }
    /**
     * 令牌提示的渲染入口：读那份集中状态（而不是"谁拿到这句话谁渲染"）。
     *
     * 为什么不能靠各页把文本交给 `Notice`：页面各有各的错误渲染写法（有的走 `Notice`、
     * 有的是裸 div、有的只把错误塞进自己的 state），漏一个地方用户就看不到提示，
     * 而且完全看不出为什么（2026-09-19 实测漏了十来个弹窗）。改成集中一份之后，
     * 提示的可见性与"哪个页面怎么渲染错误"彻底无关。
     *
     * @param {object} props 组件 props
     * @param props.pageLevel 页面级那份：**有弹窗打开时让位**给弹窗里那份（否则同一条话
     *   会在弹窗里外各出现一次，弹窗背后那份还被遮罩压暗）。
     */
    function TokenGateNotice(props) {
      var gate = useGateSnapshot()
      if (!gate.text) return null
      if (props && props.pageLevel && gate.modalDepth > 0) return null
      return tokenGateRow(gate.text)
    }
    /**
     * 「填写令牌」弹窗（用户 2026-10-12 提案：横幅那颗键点开一个弹窗，填对自动关）。
     *
     * 为什么是弹窗而不是"跳到设置 → 工具 → 兼容"：那条路要求设置面板已经挂载
     * （`navigateToTab` 只在 ToolsSection 挂载时才有值），从对话页点它就得先想办法把宿主的
     * 设置对话框打开 —— 宿主没有这个服务，只能去 DOM 里认领它自己的设置导航行，又脆又绕。
     * 一个自包含的输入框把整条依赖都去掉了：不碰宿主 DOM、不需要跳页、也不必知道用户当时
     * 在哪一页（横幅是在**任何**页面都能出现的）。
     *
     * 它做的是**解锁**（本次进程填一次），不是改配置：横幅出现的条件就是"宿主配了令牌、
     * 本次启动还没验过"。改配置（换 / 关 / 删）仍然留在兼容页那四态弹窗里 —— 那是持久改动，
     * 带"要重启 DSH 才生效"这类后果，不该塞进一个从横幅弹出来的小框。
     *
     * 字段与按钮与兼容页的解锁面板**逐字同源**（`type=password` + `compat.token.placeholder`
     * + `compat.token.save`「解锁」）：两处填令牌的手感不该有差别。锁态口径也共用
     * `applyTokenStatusSideEffects`，不在这里另判一遍。
     *
     * props：`t` / `onClose`。
     */
    function TokenUnlockDialog(props) {
      var t = props.t
      var draft = React.useState('')
      var value = draft[0], setValue = draft[1]
      var busyState = React.useState(false)
      var busy = busyState[0], setBusy = busyState[1]
      var errState = React.useState(null)
      var err = errState[0], setErr = errState[1]
      var inputRef = React.useRef(null)
      // 打开就聚焦：这个框唯一的用途就是"把一串东西粘进去"。
      React.useEffect(function () { if (inputRef.current) inputRef.current.focus() }, [])
      var submit = function () {
        if (busy) return
        var v = String(value || '').trim()
        if (!v) { setErr(t('compat.token.empty')); return }
        setBusy(true)
        setErr(null)
        // 先把令牌交给本进程（写内存 + 本机存储，并顺手收掉"去填令牌"那句提示），再问宿主
        // 认不认 —— 与兼容页 saveToken 同一顺序。
        setAccessToken(v)
        apiCall('token-status', {}).then(function (r) {
          setBusy(false)
          if (!r || !r.ok) { setErr(t('compat.token.failed')); return }
          // 锁态与提示的口径只有一处（见 applyTokenStatusSideEffects），与兼容页同源。
          applyTokenStatusSideEffects(r)
          // 宿主认可 = 用户要的"输入正确后自动关闭"。锁一解，横幅自己就消失了（同一份锁态）。
          if (r.accepted === true) { props.onClose(); return }
          if (r.hostConfigured !== true) { setErr(t('compat.token.noHost')); return }
          setErr(t('compat.token.mismatch'))
        }).catch(function (e) { setBusy(false); setErr(errMsg(e)) })
      }
      return h(Modal, {
        className: 'dsm-modal-sm',
        title: t('token.dialog.title'),
        closeLabel: t('btn.close'),
        // 这个框里不挂那条「缺少访问令牌，或令牌不对 + 填写令牌」的提示条（用户 2026-10-12）：
        // 用户已经站在"填令牌"这件事里面了，再提示一次"还差令牌"、再给一颗同样通向这里的按钮，
        // 是自指。横幅/页面级那份照旧 —— 它们才是"你还没填"的地方。
        hideGateNotice: true,
        onClose: function () { if (!busy) props.onClose() },
      },
        h('p', { className: 'dsm-help' }, t('compat.token.hint')),
        h('input', {
          ref: inputRef,
          className: 'dsm-control' + (err ? ' dsm-rule-invalid' : ''),
          type: 'password',
          value: value,
          placeholder: t('compat.token.placeholder'),
          'aria-label': t('compat.token'),
          onChange: function (e) { setValue(e.target.value); setErr(null) },
          // 回车 = 解锁（与兼容页解锁面板同一口径：按钮与回车行为一致）。
          onKeyDown: function (e) { if (e.key === 'Enter') submit() },
        }),
        err ? h('p', { className: 'dsm-rule-hint' }, err) : null,
        h('div', { className: 'dsm-modal-actions' },
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { props.onClose() } }, t('btn.cancel')),
          h('button', { type: 'button', className: 'dsm-btn', disabled: busy || !String(value || '').trim(), onClick: submit }, t('compat.token.save'))))
    }
    /**
     * 空态组件（REDESIGN §4.4，全站复用）：16px 线性图标（tertiary）+ 一句话（12 tertiary），
     * 高度 clamp 120~160、垂直居中。禁止「标题 + 巨大空白」；有出路时给一颗 quiet 按钮。
     * `icon` 缺省用一只中性「空盒」线性图标；传 null 可不带图标。
     */
    function EmptyState(props) {
      var icon = props.icon === null ? null : (props.icon || EmptyState.boxIcon)
      return h('div', { className: 'dsm-empty-state' },
        icon ? h('span', { className: 'dsm-empty-state-icon', 'aria-hidden': 'true' }, icon) : null,
        h('p', { className: 'dsm-empty-state-text' }, props.text),
        props.action ? h('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.action.disabled === true, onClick: props.action.onClick }, props.action.label) : null)
    }
    EmptyState.boxIcon = h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, focusable: 'false' },
      h('path', {
        d: 'M2.5 6.5V13A1 1 0 0 0 3.5 14H12.5A1 1 0 0 0 13.5 13V6.5M2.5 6.5L4.5 2.5H11.5L13.5 6.5M2.5 6.5H6A2 2 0 0 0 10 6.5H13.5',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }))
    // RowSelect 已上移 20 片（2026-10-11 切片五）：快照导入预览（兼容页）也要用行选择。
    /**
     * 行状态点（REDESIGN §3.4，切片三）：6px 圆点替代「启用 / 未启用 / 已连」这类
     * 只会复述开关状态的装饰性标签 —— 开关本身就是状态，标签只该留给需要处理的事。
     * tone：ok=启用/已连（success）、idle=默认/未启（灰）、bad=失败/丢失（error）、
     * warn=当前不能用但不是故障、busy=进行中（闪）。
     * 读屏读不到颜色：title 必填（role=img + aria-label 同源，与状态点同一口径）。
     */
    function StatusDot(props) {
      return h('span', {
        className: 'dsm-dot dsm-dot-' + (props.tone || 'idle'),
        role: 'img',
        'aria-label': props.title,
        title: props.title,
      })
    }
    // PageHead（页头，REDESIGN §3）在 20-helpers（factory 作用域）：兼容页（apply 之外）
    // 的单行页头也要用它，apply 侧声明对 factory 作用域不可见 —— 与 ModalCloseButton
    // 同一条边界（2026-10-11 切片五修正：切片三把它落在这里，兼容页一打开就白屏）。
    /**
     * 列表工具条（REDESIGN §3.3，2026-10-11 切片四）：页头之下、列表之上的那一层 ——
     * 搜索 / 筛选住 `children`，全选与批量动作住 `batch`（右侧成组，「出现选中时才有的
     * 批量按钮」也在这里）。八页共用一个出口，禁止页面私拼同款 DOM（§12.6）。
     */
    function Toolbar(props) {
      return h('div', { className: 'dsm-filters' },
        props.children,
        props.batch ? h('div', { className: 'dsm-toolbar-batch' }, props.batch) : null)
    }
    /**
     * 列表行（REDESIGN §3.4，2026-10-11 切片四）：48px 两行制 ——
     *   行1  状态点 + 名称(13/600) + 至多 1 个「需要处理」的 tag
     *   行2  元信息(12 弱色，截断 + title)
     * 右侧：常驻开关（`side` 槽）+ quiet 24px 次级动作组（右对齐，全部常驻可见 ——
     * 2026-10-11 裁定不做悬停浮现）；删除类一律 quiet-danger。
     * 去卡片：行本身不描边，行间 1px 分隔线由容器负责（`.dsm-list` 或分组卡的
     * `.dsm-source-body` 里「.dsm-listrow + .dsm-listrow」），容器才带边框与圆角。
     * 状态点单独一列（`dots`）：名称与元信息都从同一竖线起步 —— 点挂在名字前会造出
     * 「名称比描述右移一格」的错位（dsm-dot-indent 当初修的就是它），把点拎出主列后
     * 两行天然对齐。传空数组 = 保留点槽（同一页里带 tag 的行与带点的行左缘对齐）。
     *
     * props：`dots`（状态点，可省=无点列）/ `name` / `nameTitle` / `nameAfter`
     * （名称**紧邻**之后的一件小东西，如记忆行的体积标签；与 `tag` 分开是因为 `tag` 的契约是
     * 「至多 1 个需要处理的 tag」——状态类，而这个是量值类，两者可能同时出现）/ `tag` / `meta`
     * （字符串或节点数组；空不渲染）/ `metaTitle` / `extra`（行2 之下的追加行，如体检
     * 结果、⚠ 提示）/ `leading`（行首件，会话页勾选框；切片五换 RowSelect）/ `side`
     * （开关等常驻件）/ `actions`（quiet 24px 按钮数组）。
     */
    function ListRow(props) {
      return h('div', {
        className: 'dsm-listrow' + (props.className ? ' ' + props.className : ''),
      },
        props.leading || null,
        props.dots !== undefined ? h('div', { className: 'dsm-listrow-dots' }, props.dots) : null,
        h('div', { className: 'dsm-listrow-main' },
          h('div', { className: 'dsm-listrow-name-row' },
            typeof props.name === 'string'
              ? h('span', { className: 'dsm-listrow-name', title: props.nameTitle || props.name }, props.name)
              : h('span', { className: 'dsm-listrow-name' }, props.name),
            props.nameAfter || null,
            props.tag || null),
          props.meta ? h('div', { className: 'dsm-listrow-meta', title: props.metaTitle || undefined },
            // 字符串元信息包一层可收缩 span：flex 容器本身不吃 text-overflow，
            // 不包的话长描述只会被硬裁、没有省略号。
            typeof props.meta === 'string' ? h('span', { className: 'dsm-listrow-meta-desc' }, props.meta) : props.meta) : null,
          props.extra || null),
        (props.side || props.actions) ? h('div', { className: 'dsm-listrow-side' },
          props.side || null,
          props.actions ? h('div', { className: 'dsm-listrow-actions' }, props.actions) : null) : null)
    }
    /**
     * 列表四态（REDESIGN §12.2，2026-10-11 切片四）：加载 / 空 / 无结果 / 失败 / 有数据，
     * 全站同一套表现 —— 加载 = 一行弱色文字（**不做骨架屏**，§12.8）；空 / 无结果 / 失败 =
     * EmptyState，有出路时带一颗 quiet 按钮（无结果 → 清除筛选；失败 → 重试 —— 这是
     * 错误恢复入口，不属于已裁掉的常驻刷新）；有数据 = 原样渲染 children。
     *
     * 失败态的令牌口径：加载失败可能是「令牌没过」—— 那句话由页面级 TokenGateNotice
     * 渲染（带「填写令牌」直达），这里识别出来后只给通用一句 + 重试，同一句红字不在
     * 两处逐字重复。
     *
     * props：`t`（取词）/ `state`（'loading' | 'empty' | 'search' | 'error' | 'data'）/
     * `text`（empty/search/error 的说明；search/error 缺省走词典）/ `onRetry`（失败态的
     * 重试回调，缺省不渲染按钮）/ `onClearFilter`（无结果态的清除筛选回调）/ `action`
     * （空态出路 {label, onClick, disabled}，如「去新增」）/ `busy`（重试进行中置灰）/
     * `children`（state === 'data' 时的列表本体）。
     */
    function ListStates(props) {
      var t = props.t
      if (props.state === 'loading') return h('div', { className: 'dsm-empty' }, props.text || (t ? t('list.loading') : '…'))
      if (props.state === 'error') {
        var errText = props.text
        if (typeof errText === 'string' && isTokenGateText(errText)) errText = t ? t('list.error') : ''
        return h(EmptyState, {
          text: errText || (t ? t('list.error') : ''),
          action: props.onRetry ? { label: t('list.retry'), onClick: props.onRetry, disabled: props.busy === true } : undefined,
        })
      }
      if (props.state === 'search') {
        return h(EmptyState, {
          text: props.text || (t ? t('list.noMatch') : ''),
          action: props.onClearFilter ? { label: t('list.clearFilter'), onClick: props.onClearFilter } : undefined,
        })
      }
      if (props.state === 'empty') return h(EmptyState, { text: props.text, action: props.action })
      return h(react.Fragment, null, props.children)
    }
    /**
     * 同名退号：`测` → `测（1）` → `测（2）`…（全角括号，用户 2026-10-14 定的写法）。
     *
     * `taken` 是「已经被占用的名字」集合 —— 数组按值判、对象按键判，两种写法在各调用点
     * 手头的数据形状不同（一处是 `list.map(name)`，一处是现拼的字典），这里一并收下。
     *
     * `style`：`'paren'`（缺省）= 全角括号，用在**名字即文件名**的三个域（记忆 / 场景 /
     * 子智能体）；`'dash'` = 半角连字符，只有技能域用 —— 技能名必须过 `KEBAB_RE`
     * （`^[a-z0-9]+(?:-[a-z0-9]+)*$`），全角括号会被 `toKebab` 抹成 `-`，写出来是
     * `foo-1` 而不是 `foo（1）`，不如一开始就按 `-1` 退号，省得"看着叫甲、落盘叫乙"。
     *
     * 上限 999 只是兜底：真到那里说明有一千条同名，再往后试没有意义。
     */
    function uniqueName(raw, taken, style) {
      var isArray = Array.isArray(taken)
      // `hasOwnProperty` 而不是 `!!taken[n]`：占用表是各调用点现拼的普通对象，直接取属性会
      // 把原型上的东西（`constructor` / `toString` / `__proto__`）算成"已被占用" —— 用户给
      // 记忆起名叫 `constructor` 就会被莫名退号。
      var has = isArray
        ? function (n) { return taken.indexOf(n) >= 0 }
        : function (n) { return !!taken && Object.prototype.hasOwnProperty.call(taken, n) }
      var name = String(raw == null ? '' : raw).trim()
      if (!has(name)) return name
      var dash = style === 'dash'
      for (var i = 1; i <= 999; i += 1) {
        var candidate = dash ? name + '-' + i : name + '（' + i + '）'
        if (!has(candidate)) return candidate
      }
      return name
    }
    /**
     * 「已存在同名 X」确认弹窗（用户 2026-10-14）。
     *
     * 起因：撞名原先在**提交那一刻静默退号**（`测` → `测（1）`）—— 名字是被自动改掉的，
     * 用户看着输入框里写着「测」、落盘的却叫「测（1）」。改成先问一句：把撞上的名字与
     * 将要用的名字都摆出来，确认了才建 / 才恢复。
     *
     * 刻意做成**最小的一档**（`dsm-modal-sm`）：这里只有「继续 / 取消」两个答案，没有别的
     * 字段可填 —— 用大弹窗会让人以为还要再改点什么。四个域 × 新建 / 恢复共八个入口共用它，
     * 所以文案走 `dup.*` 一组跨域词条，只有名词（记忆 / 场景 / 技能 / 子智能体）由调用方传。
     *
     * props：`t` / `kind`（已取过词的名词）/ `name`（撞上的名字）/ `finalName`（确认后实际
     * 用的名字）/ `action`（`'create'` | `'restore'`）/ `busy` / `onConfirm` / `onCancel`。
     */
    function DupNameDialog(props) {
      var t = props.t
      var restore = props.action === 'restore'
      return h(Modal, {
        key: 'dup-name', className: 'dsm-modal-sm',
        title: t('dup.title', { kind: props.kind }),
        closeLabel: t('btn.close'), onClose: props.onCancel,
      },
        h('p', { className: 'dsm-desc' }, t('dup.body', { kind: props.kind, name: props.name })),
        h('p', { className: 'dsm-help' }, t(restore ? 'dup.restore' : 'dup.create', { name: props.finalName })),
        h('div', { className: 'dsm-modal-actions' },
          h('button', { type: 'button', className: 'dsm-btn', disabled: props.busy === true, onClick: props.onConfirm }, t(restore ? 'dup.confirm.restore' : 'dup.confirm.create')),
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.busy === true, onClick: props.onCancel }, t('btn.cancel'))))
    }
    function Modal(props) {
      var ref = react.useRef(null)
      // 弹窗存在期间，令牌提示交给**弹窗自己**渲染：页面级那份会被遮罩压暗、盖在弹窗背后，
      // 用户看到的是"弹窗里什么提示都没有"（2026-09-19 实测「新增 MCP」）。
      // 用计数器而不是布尔：弹窗会叠（回收站套详情、导入套导出）。
      react.useEffect(function () {
        gateModalDepth += 1
        emitGate()
        return function () { gateModalDepth -= 1; emitGate() }
      }, [])
      react.useEffect(function () { if (ref.current) ref.current.focus(); }, [])
      var body = props.list ? h("div", { className: "dsm-modal-body" }, props.children) : props.children
      // ⚠️ 提示挂在**头部那一层里面**，而不是插在 head 与 body 之间：后者会让 body 的
      // 位置索引从 1 变 2，React 按位置认子节点 —— 提示一出现/消失就把 body 整棵重挂
      // （输入框失焦、下拉状态归零）。放在 head 的尾部则所有位置都稳定。
      // 关闭钮是 X 图标钮（§4.3）：closeLabel 只进 aria-label / title，不再渲染文字。
      // props.hideGateNotice = 这个弹窗自己就是"填令牌"的地方，提示条在这里是自指（见 TokenUnlockDialog）。
      var head = h("div", { className: "dsm-modal-head-wrap" },
        h("div", { className: "dsm-modal-head" },
          h("h3", { className: "dsm-modal-title" }, props.title),
          h(ModalCloseButton, { label: props.closeLabel, onClick: props.onClose })),
        props.hideGateNotice === true ? null : h(TokenGateNotice, null))
      return h("div", { className: "dsm-mask", onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose(); } }, h("div", { ref: ref, tabIndex: -1, className: "dsm-modal" + (props.wide ? " dsm-modal-wide" : "") + (props.className ? " " + props.className : ""), role: "dialog", "aria-modal": "true", onKeyDown: function (e) { if (!handleModalEscape(e, props.onClose)) trapModalFocus(e.currentTarget, e); } }, head, body));
    }
    /**
     * 全插件唯一的「操作结果」呈现方式：成功 = 右下角浮层（固定定位，不改变页面高度），
     * 警告 / 错误 = 文档流内横幅（需要用户处理，常驻到下一次操作）。所有页面共用，
     * 避免同一件事在不同页看起来不一样、也让成功反馈不再把下方内容顶来顶去。
     */
    function Notice(props) {
      var text = props && props.text
      if (!text) return null
      if (props.kind === "ok") return h("div", { className: "dsm-toast", role: "status", "aria-live": "polite" }, text)
      // 「令牌没过」由 `TokenGateNotice` 统一渲染一份（弹窗里 / 页面顶部），这里不再插手 ——
      // 谁拿到这句话谁渲染，就必然有的地方渲染、有的地方漏（而且漏了看不出来）。
      if (isTokenGateText(text)) return null
      return h("div", { className: "dsm-feedback" + (props.kind === "warn" ? " dsm-warning" : " dsm-error"), role: "alert" }, text)
    }
    /* ── 勾选列表原语（场景档案编辑器 / 人设工具选择器 / 任何「多选一组条目」的地方共用）────
       原先这套排版只在 ScenesPage 内部，人设的工具选择器要么复制一份、要么写成裸 input；
       现在提到模块作用域，页面之间才可能真正长得一样。 */
    /** 段卡片：标题栏 + 固定高度滚动体（高度不随内容增减变化，弹窗不跳）。 */
    function seg(props) {
      return h('div', { className: 'dsm-seg' },
        h('div', { className: 'dsm-seg-head' },
          h('span', { className: 'dsm-seg-title' }, props.title),
          h('span', { className: 'dsm-seg-count' }, props.count),
          h('div', { className: 'dsm-seg-actions' }, props.actions)),
        props.body)
    }
    /**
     * 回收站保留期选择器（0.19.1）。
     *
     * 自己拉、自己写：它是一个**全局设置**（`hub/trash-retention.json`），而回收站的界面
     * 散在五个页面（提示词 / 场景 / 子智能体 / 技能 / 记忆）。把状态放在每个页面的父组件里，
     * 等于同一段读-写-回执逻辑抄五遍，任何一遍漂了都会表现成「这页设了、那页没生效」。
     *
     * 回执写在选择器右边而不是弹窗顶部：用户改完这一格马上要看的是「这次清掉了什么」，
     * 而不是去别处找消息（清扫是异步发生的，没有回执就等于"改了个数字，什么也没看见"）。
     *
     * 副作用面：`trash-retention-set` 成功后服务端会**立即扫一次**，可能真的永久删掉条目。
     * 所以调用方要传 `onReload` —— 否则弹窗里还列着已经不存在的条目，点恢复会报"条目不存在"。
     */
    function RetentionSelect(props) {
      var t = props.t
      var st = React.useState({ loading: true, days: null, busy: false, note: null, error: null })
      var s = st[0], set = st[1]
      React.useEffect(function () {
        var alive = true
        apiCall('trash-retention-get', {}).then(function (res) {
          if (!alive) return
          if (res && res.ok) set({ loading: false, days: Number(res.retentionDays) || 0, busy: false, note: null, error: null })
          else set({ loading: false, days: null, busy: false, note: null, error: (res && res.error) || t('trash.retention.loadFailed') })
        }).catch(function (e) {
          if (alive) set({ loading: false, days: null, busy: false, note: null, error: errMsg(e) })
        })
        return function () { alive = false }
      }, [])
      function choose(value) {
        var days = Number(value) || 0
        set(function (prev) { return Object.assign({}, prev, { busy: true, note: null, error: null }) })
        apiCall('trash-retention-set', { retentionDays: days }).then(function (res) {
          if (res && res.ok) {
            var swept = Number(res.swept) || 0
            var failed = Number(res.failed) || 0
            set({
              loading: false, days: Number(res.retentionDays) || 0, busy: false, error: null,
              // 只在**真的发生了事**的时候出回执：一条都没清掉时写「已保存；本次清理 0 项」
              // 是纯噪音（下拉框本身的值就是"已保存"的回执）。删除失败要如实说 ——
              // `failed > 0` 说明有条目删不掉（IO 错误），只报清掉几项会让用户以为回收站干净了。
              note: failed > 0
                ? t('trash.retention.savedFailed', { count: swept, failed: failed })
                : swept > 0 ? t('trash.retention.saved', { count: swept }) : null,
            })
            // 只在本轮真的删了东西时重读列表：没删东西还重读一次会让弹窗闪一下。
            if (swept > 0 && props.onReload) props.onReload()
          } else {
            set(function (prev) { return Object.assign({}, prev, { busy: false, error: translateError(t, res) }) })
          }
        }).catch(function (e) {
          set(function (prev) { return Object.assign({}, prev, { busy: false, error: errMsg(e) }) })
        })
      }
      // 选项与 History 页那套同形（永久保留 / 7 / 30 天），外加 90 天 —— 回收站里的东西
      // 比归档会话更常需要"留久一点再看"。`0` 是默认值，也是唯一不删任何东西的那一档。
      var PRESETS = [0, 7, 30, 90]
      var days = s.days
      // 侧车里的值可能是手改的、或来自更早的版本（例如 15）—— 不在预设里时把它补成一项，
      // 否则下拉框会显示成空白，用户会以为"根本没设置过"而重设一遍。
      var values = days !== null && PRESETS.indexOf(days) < 0 ? [days].concat(PRESETS) : PRESETS
      // 选项先算好再交给 SourceSelect（它要的是 [{value,label}]）。读不到保留期时只有一项
      // 「读取中…」，且整颗下拉禁用 —— 与原生件时代同一套语义。
      var selectOptions = days === null
        ? [{ value: '', label: t('trash.retention.loading') }]
        : values.map(function (v) {
          return { value: String(v), label: v === 0 ? t('trash.retention.forever') : t('trash.retention.days', { count: v }) }
        })
      return React.createElement('div', { className: 'dsm-trash-retention' },
        React.createElement('span', { className: 'dsm-label' }, t('trash.retention.label')),
        // 原生 `<select>` 换成自绘 SourceSelect（用户 2026-10-12：「回收站的下拉框能不能设计成
        // <MCP 页那个>」）：原生件在深色主题下由系统画高亮（整条实底蓝），与全站自绘控件是两套
        // 长相，菜单样式也完全不可控。SourceSelect 是八页 + 兼容页唯一那一种下拉。
        React.createElement('div', { className: 'dsm-trash-retention-select' },
          React.createElement(SourceSelect, {
            options: selectOptions,
            value: days === null ? '' : String(days),
            disabled: s.loading || s.busy || days === null,
            ariaLabel: t('trash.retention.label'),
            onChange: choose,
          })),
        s.error ? React.createElement('span', { className: 'dsm-trash-hint dsm-trash-retention-err' }, s.error) : null,
        s.note ? React.createElement('span', { className: 'dsm-trash-hint' }, s.note) : null,
        // 说明只在**真的开了保留期**时出现：选着「永久保留」还写「超期自动删除」是自相矛盾的。
        // 文案本身压到 6 个字（用户 2026-10-10：「保留期一行就够了」），全文进 title ——
        // 这一行恒为一行，长句放不下的问题从源头消掉，而不是靠折行兜着。
        days !== null && days > 0
          ? React.createElement('span', { className: 'dsm-trash-hint', title: t('trash.retention.hintFull') }, t('trash.retention.hint'))
          : null)
    }

    /**
     * 通用回收站弹窗：一行一个条目（勾选框 + 名字 + 删除时间），右侧「恢复 / 永久删除」。
     *
     * 子智能体 / 场景 / 提示词预设三处共用；永久删除就在本弹窗里就地二次确认，
     * 不再叠一层弹窗。恢复失败的原因显示在弹窗顶部 —— 不静默（同名已存在时必须说清）。
     *
     * 0.19.1 加的两件事：
     *   · **保留期选择器**（`RetentionSelect`）：回收站此前只有"进来"没有"出去"。
     *   · **批量永久删除**：条目多的时候（本机实测场景回收站 68 条、记忆 120 条）
     *     一条条点等于没法用。勾选 + 「全选」+「永久删除 (N)」。
     *
     * 批量控件**只有一颗删除键**，与「全选」同处工具栏那一行、靠最右（用户 2026-10-10 裁定）：
     * 原先并列「永久删除所选」与「清空回收站」两颗，两者是同一件事的两种范围，
     * 并列必然有一颗是废话 —— 要清空就先「全选」再删，两步。
     * 同理，勾选是**跨组**的（提示词页一次列两组），所以「全选」也必须是全局那一颗：
     * 每组各留一颗「全选」就等于每组也要各配一颗删除键，又变回多颗。
     *
     * 批量为什么走**前端循环调已有的单条删除 op**（`onPurgeMany` 由调用方实现）：
     * 服务端那六条 `*-trash-delete` 各自带着自己的存在性校验与回滚，再写一条"批量版"
     * 就等于把六份判据复制一遍 —— 而且新 op 还要重新过一遍令牌/冻结登记。
     * 条数天然有限（用户手删出来的），循环没有性能问题。
     *
     * `split: true` = **分栏模式**（用户 2026-10-10：「提示词的回收站也要像技能回收站一样分成两部分」）：
     * 两块上下各占一半、各自滚动、**每块自带一条**「已选 N 项 + 全选 + 永久删除 (N)」，
     * 大弹窗自己不滚。为什么不沿用顶部那一颗全局删除键：两块的后果不同（提示词页是
     * 「提示词预设目录」与「快捷提示词目录」），全局「全选 + 永久删除」要跨两块删 ——
     * 勾完之后根本看不出那一键会删掉哪几个。与技能回收站（43-skills.js 的 `trashPane`）
     * 同一套结构与类名，只是那份是手写的，这份做成了 `TrashModal` 的一个模式。
     */
    /**
     * 串行逐条执行一批单条 op。服务端的六条 `*-trash-*` 各自带着存在性校验与回滚，
     * 批量 = 前端循环**已有的单条 op**，不另造批量版（0.19.1 起的口径不变）。
     * 串行而不是并发：条数天然有限（用户手删出来的），串行才给得出
     * 「成功几条、为什么没删掉」；返回 `{ done, failed, firstErr }`。
     * `one(item)` 返回服务端信封（`res.ok`）；抛错按失败计。
     */
    function runSerial(items, one) {
      return new Promise(function (resolve) {
        // `results` 与 `items` **逐位对齐**（失败位是 null）：回收站恢复要用成功那一条回传的
        // 最终名字来回执（退号恢复时它与回收站里的原名不同），只数成功个数是不够的。
        var out = { done: 0, failed: 0, firstErr: null, firstFail: null, results: [] }
        var step = function (i) {
          if (i >= items.length) { resolve(out); return }
          Promise.resolve().then(function () { return one(items[i]) }).then(function (res) {
            if (res && res.ok === true) { out.done += 1; out.results.push(res) }
            else {
              out.failed += 1
              // `firstErr` 仍旧只存**错误文案**（部分失败的回执一直用它，换成整份结果会把
              // 措辞一起换掉 —— 词典里的模板句比 op 原文笼统）；`firstFail` 另存整份失败结果，
              // 因为只有它带着 `code` / `params`（`error.dup.conflict` 的候选名字就在
              // `params.next` 里），回收站那条"撞名先问一句"要靠它。
              if (!out.firstErr) out.firstErr = (res && res.error) || res || 'error'
              if (!out.firstFail) out.firstFail = res || null
              out.results.push(null)
            }
            step(i + 1)
          }, function (e) {
            out.failed += 1; if (!out.firstErr) out.firstErr = errMsg(e)
            if (!out.firstFail) out.firstFail = null
            out.results.push(null)
            step(i + 1)
          })
        }
        step(0)
      })
    }
    /**
     * 这条失败结果是不是「撞名」（四个回收站统一的 `error.dup.conflict`）？
     *
     * 判据是**错误码**，不是文案 —— 文案会随语言和措辞变，码不会。`params.next` 必须有：
     * 弹窗要把它当作"确认后会叫什么"如实写出来，没有候选名字就退回普通报错，别弹一个
     * 说不出结果的确认窗。
     */
    function isDupConflict(res) {
      return !!(res && res.code === 'error.dup.conflict' && res.params && res.params.next)
    }
    /**
     * 每一页的回收站包含哪几组（`TrashModal` 的 `domain`）。
     * 两组的那两页 —— 技能页（技能 + 已移除的目录）、提示词页（提示词预设 + 快捷提示词）——
     * 同域但**后果不同**，所以各带标题与自己的批量条。
     * MCP 页与会话页不在这里：这两域没有回收站（2026-10-12 裁定 —— MCP 删除走宿主配置、
     * 插件不留快照；会话的「归档」列表本身就是它的回收站），界面上也不再给入口。
     */
    const TRASH_DOMAINS = {
      // `split: true` = 两组**上下平分**弹窗、各带一圈边框隔开（用户 2026-10-12：「技能和
      // 提示词的回收站是分为两部分，要两部分应该平分回收站的弹窗，两部分应该有边框进行
      // 隔离区分」）。此前两组是一条长列表一路滚到底，两组的批量条长得一模一样，
      // 读起来像同一组的两条工具条。单组的三个域（人设 / 场景 / 记忆）不走分栏。
      skills: { groups: ['skills', 'dirs'], split: true },
      prompts: { groups: ['presets', 'quick'], split: true },
      agents: { groups: ['agents'] },
      scenes: { groups: ['scenes'] },
      memories: { groups: ['memories'] },
    }
    /**
     * 回收站（2026-10-12 改成「一页一个」）：右栏保留期置顶 + 分组列表 + 每组一条批量条。
     *
     * 原先左栏是六类导航，从任何一页打开都能看到全部六类 —— 用户裁定「回收站一个功能页就是
     * 一个回收站，不需要显示其他的回收站」，于是导航整根拔掉：`domain` 决定这一页有哪几组，
     * 其余组不读也不画（少四类只读调用）。
     * 只有两个域是两组的：**技能页**（技能 + 已移除的目录）与**提示词页**（提示词预设 +
     * 快捷提示词）—— 两组的后果不同，所以各带标题与自己的批量条（2026-10-10 的裁定不变）。
     *
     * 数据在组件内部按域拉取：清单 op 都是**全局只读 op**，从哪个页打开都一样；
     * 写操作逐条调各域已有的单条 op（`runSerial`），成功后重读该域清单并回调
     * `props.onReload` 让宿主页刷新自己的数据。
     *
     * MCP 页与会话页不再有回收站入口：这两域没有回收站类目（MCP 删除走宿主配置、
     * 插件不留快照；会话的「归档」列表本身就是它的回收站）。
     *
     * props：`t` / `onClose` / `onReload`（宿主页写后刷新）/ `domain`（见 `TRASH_DOMAINS`）。
     */
    function TrashModal(props) {
      const t = props.t
      // 每类的数据槽：{ loading, error, entries }。skills 与 dirs 同源（skill-state 一份快照
      // 同时喂两类：技能 = trash 数组；目录 = 已移除的来源 roots）。
      const ds = React.useState(null)
      const data = ds[0], setData = ds[1]
      // 这一页的回收站有哪几组（见文件头 `TRASH_DOMAINS`）。打开时定死，中途不换。
      const domainCfg = TRASH_DOMAINS[props.domain] || TRASH_DOMAINS.skills
      const groupIds = domainCfg.groups
      // 分栏档：两块各占一半、各自滚动、各带边框。只有两组时才有意义。
      const split = domainCfg.split === true && groupIds.length > 1
      const bsx = React.useState(false)
      const busy = bsx[0], setBusy = bsx[1]
      const nsx = React.useState(null)
      const notice = nsx[0], setNotice = nsx[1]
      // 勾选集合。key = `<组 id>|<条目 id>` —— 提示词类两组的 id 可能撞（都叫预设 id 生成器），
      // 只按 id 记会让两组互相勾中（沿用 0.19.1 的组前缀口径）。
      const ssx = React.useState({})
      const selected = ssx[0], setSelected = ssx[1]
      // 行内二次确认。存「哪一组的哪一行在确认」，批量条的 key 为 null。
      const cfx = React.useState(null)
      const confirm = cfx[0], setConfirm = cfx[1]
      // 「已存在同名 X，是否恢复为 X（1）」确认窗（用户 2026-10-14）。null = 没开；开了就是
      // 一条 `{ group, items, kind, name, finalName }` —— 点「继续恢复」才带 `dedupe` 重发。
      const dfx = React.useState(null)
      const dupAsk = dfx[0], setDupAsk = dfx[1]
      // 「详情」只读预览（用户 2026-10-12：「回收站的每条信息应该增加一个详情按键，点开就能看
      // 这个信息是什么样子，不能更改内容，没有保存按键」）。null = 没开；开了就是一条
      // `{ group, id, name, meta, loading, error, files }`：
      //   · `meta` 非 null —— 这条记录没有负载可读（目录组只有"不再读取"这条事实），只显示
      //     来源信息，不读盘；
      //   · 否则按 `id` 调 `trash-preview`，把条目目录里的文件只读地读出来。
      const pvx = React.useState(null)
      const preview = pvx[0], setPreview = pvx[1]
      // 场景锁定（五个管理域整体冻结）。rules-list 回传 anyLocked（记忆页同一来源）。
      // 各组冻不冻**照抄 op-registry 的 `frozen` 标记**（`GROUPS[*].frozen`）：技能 / 目录 /
      // 人设 / 提示词 / 记忆五组都冻结，只有场景自己的回收站不冻 —— `scene-trash-*` 两条 op
      // 本来就没标 frozen。界面与判据同源，才不会出现"画得能点、点下去被拒"。
      const ysx = React.useState(false)
      const anyLocked = ysx[0], setAnyLocked = ysx[1]
      const zsx = React.useState([])
      const sceneList = zsx[0], setSceneList = zsx[1]
      React.useEffect(function () { load(); return undefined }, [])
      const dataOf = function (id) { return (data && data[id]) || { loading: true, error: null, entries: [] } }
      function setSlot(id, slot) {
        setData(function (prev) { var next = Object.assign({}, prev); next[id] = slot; return next })
      }
      function load() {
        // 只读**本页这几组**（2026-10-12「一页一个」）：原先一次打开拉六类清单，
        // 为的是左栏那几个计数徽标 —— 导航拔掉后那些数字没有地方要了。
        groupIds.forEach(function (gid) {
          var g = GROUPS[gid]
          if (g.reload) { g.reload(); return }
          readGroup(gid, g.op, g.pick)
        })
        // 锁定态（只读判断，失败不拦 —— 写操作到了服务端还有 frozen 这道闸）；
        // `sceneList` 只有记忆组用得上（每条要说清属于哪个场景）。
        var needLock = groupIds.some(function (gid) { return GROUPS[gid].frozen === true || gid === 'memories' })
        if (!needLock) return
        apiCall('rules-list', {}).then(function (res) {
          if (res && res.ok) { setAnyLocked(res.anyLocked === true); setSceneList(res.scenes || []) }
        }).catch(function () { })
      }
      function reloadGroup(id) {
        var g = GROUPS[id]
        if (!g) return
        if (g.reload) { g.reload(); return }
        readGroup(id, g.op, g.pick)
      }
      function readGroup(id, op, pick) {
        setSlot(id, { loading: true, error: null, entries: dataOf(id).entries })
        apiCall(op, {}).then(function (res) {
          setSlot(id, res && res.ok ? { loading: false, error: null, entries: pick(res) || [] } : { loading: false, error: translateError(t, res), entries: [] })
        }).catch(function (e) { setSlot(id, { loading: false, error: errMsg(e), entries: [] }) })
      }
      function reloadAll() {
        load()
      }
      // ── 各组清单（`TRASH_DOMAINS` 按页取用）。每组的 restore / purge 都是**全局单条 op**
      //    （apiCall 直呼，信封原样返回）。──
      const noteDefault = function (item) { return t('trash.deletedAt', { time: item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '—' }) }
      /**
       * 「已恢复」回执，四个可退号的域共用。
       *
       * 回执必须写**最终落盘的名字**：退号恢复（撞名 → `测（1）`）时它与回收站里显示的原名
       * 不同，写原名就是谎报 —— 用户回到列表里找不到「测」，因为磁盘上那份叫「测（1）」。
       * 判据用服务端回的 `renamed` 而不是自己比对 `res.name !== it.name`：服务端说没改名就是
       * 没改名，界面不猜。
       */
      const restoredText = function (it, res) {
        var name = (res && res.name) || it.name
        return t(res && res.renamed === true ? 'done.restoredAs' : 'done.restored', { name: name })
      }
      const memoryNote = function (item) {
        return sceneLabel(sceneList, item.group) + ' · '
          + t('memory.form.' + (item.form === 'bundle' ? 'bundle' : 'flat')) + ' · '
          + item.bytes + ' B · '
          + t('memory.trash.deletedAt', { time: item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '' })
      }
      const GROUPS = {
        presets: {
          id: 'presets', title: t('trash.group.presets'), note: t('trash.section.presets.sub'), frozen: true,
          op: 'agentsmd-trash-list', pick: function (res) { return res.trash },
          nameOf: function (it) { return it.name }, noteOf: noteDefault,
          restore: function (it) { return apiCall('agentsmd-trash-restore', { id: it.id }) },
          purge: function (it) { return apiCall('agentsmd-trash-delete', { id: it.id }) },
          resultRestore: function (it) { return t('done.restored', { name: it.name }) },
          resultPurge: function (it) { return t('trash.purged', { name: it.name }) },
        },
        quick: {
          id: 'quick', title: t('trash.group.quick'), note: t('trash.section.quick.sub'), frozen: true,
          op: 'quickprompt-trash-list', pick: function (res) { return res.trash },
          nameOf: function (it) { return it.name }, noteOf: noteDefault,
          restore: function (it) { return apiCall('quickprompt-trash-restore', { id: it.id }) },
          purge: function (it) { return apiCall('quickprompt-trash-delete', { id: it.id }) },
          resultRestore: function (it) { return t('done.restored', { name: it.name }) },
          resultPurge: function (it) { return t('trash.purged', { name: it.name }) },
        },
        skills: {
          // `frozen: true` —— 技能回收站的两条 op（`skill-trash-restore` / `skill-trash-delete`）
          // 在 op-registry 里都标着 frozen，锁定期间服务端一律拒绝。此前这里写成 false，
          // 界面于是把「恢复 / 永久删除 / 全选」画成可点，点下去才吃一个冻结错误
          //（用户 2026-10-12：「技能回收站应该和其他回收站一样灰色的不能选择」）。
          id: 'skills', title: t('trash.section.skills'), note: t('trash.section.skills.sub'), frozen: true,
          nameOf: function (it) { return it.name }, noteOf: noteDefault,
          dupKind: 'dup.kind.skill',
          restore: function (it, dedupe) { return apiCall('skill-trash-restore', { id: it.id, dedupe: dedupe === true }) },
          purge: function (it) { return apiCall('skill-trash-delete', { id: it.id }) },
          resultRestore: restoredText,
          resultPurge: function (it) { return t('trash.purged', { name: it.name }) },
        },
        dirs: {
          // 同 skills：`skill-source-restore` / `skill-custom-remove` 两条 op 也是 frozen。
          id: 'dirs', title: t('trash.section.dirs'), note: t('trash.section.dirs.sub'), frozen: true,
          // 来源条目没有 `id`，只有 `key`（restore / remove 两条 op 都按 key 定位）。
          // 漏了这条就会全部落到 `dirs|undefined` 这一个勾选键上 —— 勾中一行等于勾中全部
          // （用户 2026-10-12 实测「点击一个默认全选了」），行内二次确认同样会串。
          idOf: function (it) { return it.key },
          nameOf: function (it) { return rootDisplayName(t, it) }, noteOf: function (it) { return it.path }, noteTitle: true,
          // 「永久删除」现在对**两类**来源都成立（用户 2026-10-12：「技能的 codex 和 Claude
          // 改成也是可以移除的目录」）：
          //   · 自定义目录 —— 删掉 customRoots 里那条记录（`skill-custom-remove`）；
          //   · 按约定发现的来源（agents / codex / claude）—— 它们不住在 customRoots 里，路径
          //     每次启动都会重新推导出来，只从 removedSources 里删掉的话下一轮它又回来了，
          //     所以走 `skill-source-forget`：另记一份「永久忘记」名单，从此既不读取也不列出。
          // 两条路都**不碰磁盘上的源文件**（一个字节都不动）—— 见 `trash.section.dirs.sub`。
          // 原先这里只认 `custom === true`，于是 codex / claude 那两行只有「恢复读取」，
          // 而它们明明 `removable === true`（技能页上就能移除），两处口径不一致。
          canPurge: function (it) { return it.custom === true || it.removable === true },
          emptyText: t('trash.section.dirs.empty'),
          // 目录组没有"被删掉的东西"可看：这条记录本来就只是「不再读取这个来源」，磁盘上
          // 什么都没动。所以详情改成把来源信息摆出来，**不去读那个目录** —— 读它等于把用户的
          // ~/.codex、~/.claude 整个列到界面上，那是另一个功能，不是"看这条记录是什么"。
          previewMeta: function (it) {
            return [
              [t('trash.preview.field.scope'), it.scope === 'project' ? t('trash.preview.scope.project') : t('trash.preview.scope.user')],
              [t('trash.preview.field.origin'), it.custom === true ? t('trash.preview.origin.custom') : it.defaultSource === true ? t('trash.preview.origin.default') : t('trash.preview.origin.discovered')],
              [t('trash.preview.field.path'), it.path || '—'],
            ]
          },
          restore: function (it) { return apiCall('skill-source-restore', { root: it.key }) },
          purge: function (it) {
            return it.custom === true
              ? apiCall('skill-custom-remove', { key: it.key })
              : apiCall('skill-source-forget', { root: it.key })
          },
          resultRestore: function (it) { return t('result.sourceRestored', { name: rootDisplayName(t, it) }) },
          resultPurge: function (it) { return t('result.sourceForgotten', { name: rootDisplayName(t, it) }) },
        },
        agents: {
          id: 'agents', title: null, note: t('trash.section.agents.sub'), frozen: true,
          op: 'subagent-trash-list', pick: function (res) { return res.trash },
          nameOf: function (it) { return it.name }, noteOf: noteDefault,
          dupKind: 'dup.kind.subagent',
          restore: function (it, dedupe) { return apiCall('subagent-trash-restore', { id: it.id, dedupe: dedupe === true }) },
          purge: function (it) { return apiCall('subagent-trash-delete', { id: it.id }) },
          // 启停状态没能写回（服务端 stateSyncError）必须说出来，不能只报「已恢复」。
          restoreWarn: true,
          resultRestore: restoredText,
          resultPurge: function (it) { return t('trash.purged', { name: it.name }) },
        },
        scenes: {
          id: 'scenes', title: null, note: t('trash.section.scenes.sub'), frozen: false,
          op: 'scene-trash-list', pick: function (res) { return res.trash },
          nameOf: function (it) { return it.name }, noteOf: noteDefault,
          dupKind: 'dup.kind.scene',
          restore: function (it, dedupe) { return apiCall('scene-trash-restore', { id: it.id, dedupe: dedupe === true }) },
          purge: function (it) { return apiCall('scene-trash-delete', { id: it.id }) },
          resultRestore: restoredText,
          resultPurge: function (it) { return t('trash.purged', { name: it.name }) },
        },
        memories: {
          id: 'memories', title: null, note: t('trash.section.memories.sub'), frozen: true,
          op: 'rules-trash-list', pick: function (res) { return res.entries },
          idOf: function (it) { return it.trashId },
          nameOf: function (it) { return it.name }, noteOf: memoryNote,
          dupKind: 'dup.kind.memory',
          restore: function (it, dedupe) { return apiCall('rules-restore', { trashId: it.trashId, dedupe: dedupe === true }) },
          purge: function (it) { return apiCall('rules-trash-remove', { trashId: it.trashId }) },
          resultRestore: restoredText,
          resultPurge: function (it) { return t('memory.result.trashRemoved', { name: it.name }) },
        },
      }
      // skills / dirs 的重读要一起走（同一份 skill-state 快照）。
      GROUPS.skills.reload = GROUPS.dirs.reload = function () {
        setSlot('skills', { loading: true, error: null, entries: dataOf('skills').entries })
        setSlot('dirs', { loading: true, error: null, entries: dataOf('dirs').entries })
        apiCall('skill-state', {}).then(function (res) {
          if (res && res.ok) {
            var d = res.data || {}
            setSlot('skills', { loading: false, error: null, entries: d.trash || [] })
            setSlot('dirs', { loading: false, error: null, entries: (d.roots || []).filter(function (r) { return r.removed === true }) })
          } else {
            var err = translateError(t, res)
            setSlot('skills', { loading: false, error: err, entries: [] })
            setSlot('dirs', { loading: false, error: err, entries: [] })
          }
        }).catch(function (e) {
          var err = errMsg(e)
          setSlot('skills', { loading: false, error: err, entries: [] })
          setSlot('dirs', { loading: false, error: err, entries: [] })
        })
      }
      // 这一页有哪几组 = `groupIds`（见文件头 `TRASH_DOMAINS`）；原先的左栏六类导航
      // 连同 `CATEGORIES` / 计数徽标一起删除（2026-10-12「一页一个回收站」）。
      const frozenOf = function (g) { return g.frozen === true && anyLocked === true }
      const idOfOf = function (g) { return g.idOf || function (it) { return it.id } }
      const selKeyOf = function (g, item) { return g.id + '|' + String(idOfOf(g)(item)) }
      /**
       * 打开一条条目的「详情」。**只看不改**，所以既不看锁定态、也不进 `busy` —— 与
       * 「场景锁定下可以打开编辑页、只是不能保存」同一条口径（用户 2026-10-12 第四轮）。
       *
       * 每条记录的"身份"参数各域不同（`it.id` / `it.trashId` / `it.key`），统一走 `idOfOf`；
       * 回填时按 `group + id` 对一次，避免网络慢时先点 A 再点 B、A 的结果盖掉 B 的窗口。
       */
      function openPreview(g, item) {
        const id = String(idOfOf(g)(item))
        const meta = g.previewMeta ? g.previewMeta(item) : null
        setPreview({ group: g.id, id: id, name: g.nameOf(item), meta: meta, loading: meta === null, error: null, files: [] })
        if (meta !== null) return
        const patch = function (fields) {
          setPreview(function (cur) {
            if (!cur || cur.group !== g.id || cur.id !== id) return cur
            return Object.assign({}, cur, fields)
          })
        }
        apiCall('trash-preview', { domain: g.id, id: id }).then(function (res) {
          if (res && res.ok) patch({ loading: false, error: null, files: res.files || [] })
          else patch({ loading: false, error: translateError(t, res), files: [] })
        }).catch(function (e) { patch({ loading: false, error: errMsg(e), files: [] }) })
      }
      function toggleSel(key) {
        setSelected(function (prev) {
          var next = Object.assign({}, prev)
          if (next[key] === true) delete next[key]
          else next[key] = true
          return next
        })
      }
      function toggleGroup(g, on) {
        setSelected(function (prev) {
          var next = Object.assign({}, prev)
          ;(dataOf(g.id).entries || []).forEach(function (item) {
            var k = selKeyOf(g, item)
            if (on) next[k] = true
            else delete next[k]
          })
          return next
        })
      }
      /** 清掉该组的勾选（动作完成后条目已离开列表，残留的 key 永远勾不中）。 */
      function clearGroupSel(g) {
        setSelected(function (prev) {
          var next = {}
          Object.keys(prev).forEach(function (k) { if (k.indexOf(g.id + '|') !== 0) next[k] = prev[k] })
          return next
        })
      }
      const pickedItems = function (g) {
        return (dataOf(g.id).entries || []).filter(function (item) { return selected[selKeyOf(g, item)] === true })
      }
      function afterWrite(g, ok, text) {
        setNotice({ ok: ok, text: text })
        reloadGroup(g.id)
        clearGroupSel(g)
        setConfirm(null)
        if (props.onReload) props.onReload()
      }
      /**
       * 恢复。`dedupe === true` = 用户在"已存在同名 X"确认窗里点过继续，这一次按退号的名字落盘。
       *
       * 撞名（用户 2026-10-14）：服务端**先拒**并回 `error.dup.conflict` + `params.next`，
       * 这里认出它、把确认窗弹出来；用户点继续才带 `dedupe` 重来。批量恢复**不弹** ——
       * 一次勾了八条、其中三条撞名时弹三个窗没人受得了，那种情形照旧走"部分失败"的回执，
       * 用户看完自己挑单条重试。
       */
      function runRestore(g, items, dedupe) {
        setBusy(true)
        var warns = []
        runSerial(items, function (item) {
          return g.restore(item, dedupe).then(function (res) {
            if (g.restoreWarn && res) { var w = stateSyncWarn(t, res); if (w) warns.push(w) }
            return res
          })
        }).then(function (out) {
          setBusy(false)
          if (out.failed === 1 && items.length === 1 && dedupe !== true && isDupConflict(out.firstFail)) {
            setDupAsk({
              group: g.id, items: items, kind: g.dupKind,
              name: String(out.firstFail.params.name || items[0].name || ''),
              finalName: String(out.firstFail.params.next),
            })
            return
          }
          if (out.failed === 0) {
            var head = items.length === 1 ? g.resultRestore(items[0], out.results[0]) : t('trash.restoreMany.result', { count: out.done })
            afterWrite(g, warns.length === 0, warns.length ? head + ' ' + warns.join(' ') : head)
          } else {
            setBusy(false)
            setNotice({ ok: false, text: t('trash.restoreMany.partial', { count: out.done, failed: out.failed, reason: out.firstErr ? translateError(t, out.firstErr) : '' }) })
            reloadGroup(g.id)
            setConfirm(null)
          }
        })
      }
      function runPurge(g, items) {
        setBusy(true)
        runSerial(items, g.purge).then(function (out) {
          setBusy(false)
          var text
          if (out.failed === 0) {
            text = items.length === 1 ? g.resultPurge(items[0])
              : (g.id === 'dirs' ? t('trash.forgetMany.result', { count: out.done }) : t('trash.purgeMany.result', { count: out.done }))
          } else {
            text = g.id === 'dirs'
              ? t('trash.forgetMany.partial', { count: out.done, failed: out.failed, reason: out.firstErr ? translateError(t, out.firstErr) : '' })
              : t('trash.purgeMany.partial', { count: out.done, failed: out.failed, reason: out.firstErr ? translateError(t, out.firstErr) : '' })
          }
          afterWrite(g, out.failed === 0, text)
        })
      }
      /** 一行条目：行选择（整行可点勾选）+ 右侧「恢复 / 永久删除」，删除走行内二次确认。 */
      const rowNode = function (g, item) {
        const key = String(idOfOf(g)(item))
        const gated = busy === true || frozenOf(g) === true
        const confirming = confirm && confirm.group === g.id && confirm.key === key
        const actions = confirming
          ? [
              React.createElement('span', { className: 'dsm-note', key: 'ask' }, t('trash.purge.confirm')),
              React.createElement('button', { key: 'yes', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: function () { runPurge(g, [item]) } }, t('btn.delete.forever')),
              React.createElement('button', { key: 'no', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { setConfirm(null) } }, t('btn.cancel')),
            ]
          : [
              // 「详情」永远可点：它是**看**，不是改。锁定态下恢复 / 永久删除都灰了，这一颗
              // 仍然亮着 —— 用户 2026-10-12 第四轮定的口径就是「可以打开看，只是不能改」。
              // 所以它**不吃 `gated`**（`gated` 只用来灰那两颗写操作键），放在最左、与它们
              // 拉开语义距离。
              React.createElement('button', { key: 'peek', type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: function () { openPreview(g, item) } }, t('trash.preview.open')),
              React.createElement('button', { key: 'restore', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: gated, onClick: function () { runRestore(g, [item]) } }, t('btn.restore')),
              // `canPurge` 为假 → **不画**这颗按钮（不是画一颗按不动的）：这一行没有"永久删除"
              // 这件事可做。现在只剩默认来源会落进这一档（`dsh` / `hub` / 官方）—— 它们必须读取、
              // 从来不在移除候选里，所以实际也进不了这张列表；留这条判断是防它哪天进来。
              g.canPurge && !g.canPurge(item) ? null
                : React.createElement('button', { key: 'purge', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: gated, onClick: function () { setConfirm({ group: g.id, key: key }) } }, t('btn.delete.forever')),
            ]
        return React.createElement(RowSelect, {
          key: key, checked: selected[selKeyOf(g, item)] === true, disabled: gated,
          name: g.nameOf(item), desc: g.noteOf(item), descTitle: g.noteTitle ? g.noteOf(item) : undefined,
          onChange: function () { toggleSel(selKeyOf(g, item)) },
          actions: actions,
        })
      }
      /**
       * 一条批量条：「已选 N 项 + 全选 + 恢复所选 + 永久删除所选」，二次确认就地替换这一行。
       * 「恢复所选」是安全的可逆操作，不设确认；「永久删除所选」必确认。
       */
      const bulkRow = function (g) {
        const list = dataOf(g.id).entries || []
        const picked = pickedItems(g)
        // 「永久删除」只数**真能删**的那几条：目录组里勾中 3 行、其中 2 行是内置来源时，
        // 那颗键上写的必须是 1 —— 否则按下去删不掉勾上的东西，比数字难看一百倍。
        const purgeable = g.canPurge ? picked.filter(g.canPurge) : picked
        const allHere = list.length > 0 && picked.length === list.length
        const gated = busy === true || frozenOf(g) === true
        if (confirm && confirm.group === g.id && confirm.key === null) {
          return React.createElement('div', { className: 'dsm-trash-bulk dsm-trash-bulk-confirm' },
            React.createElement('span', { className: 'dsm-note' }, t('trash.purgeSelected.confirm', { count: purgeable.length })),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: function () { runPurge(g, purgeable) } }, t('trash.btn.confirmPurgeMany', { count: purgeable.length })),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { setConfirm(null) } }, t('btn.cancel')))
        }
        return React.createElement('div', { className: 'dsm-trash-bulk' },
          React.createElement('span', { className: 'dsm-note' }, t('trash.selected', { count: picked.length })),
          React.createElement('button', {
            type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: gated || !list.length,
            onClick: function () { toggleGroup(g, !allHere) },
          }, bulkPair(allHere ? t('trash.deselectAll') : t('trash.selectAll'), allHere ? t('trash.selectAll') : t('trash.deselectAll'))),
          React.createElement('button', {
            type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: gated || !picked.length,
            onClick: function () { runRestore(g, picked) },
          }, t('trash.btn.restoreSelected', { count: picked.length })),
          // 一条可删的都没勾中就不出现这颗键（目录组里只勾了内置来源时就是这个情形）——
          // 与行内同一个判断，界面上不会出现"看得到却永远按不动"的删除键。
          (!g.canPurge || purgeable.length)
            ? React.createElement('button', {
              // `!purgeable.length` 必须一起禁用：这条批量删除键在**没勾中任何可删项**时
              // 此前是亮的 —— 点下去先弹一句"永久删除所选的 0 项？"，确认后回一句"已永久删除
              // 0 项"。同一排的「恢复所选 (0)」是灰的，两颗键一个灰一个亮，看着像坏了。
              type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: gated || !purgeable.length,
              onClick: function () { setConfirm({ group: g.id, key: null }) },
            }, t('trash.btn.purgeSelected', { count: purgeable.length }))
            : null)
      }
      /** 一组：可选组头（提示词类两组才有）+ 批量条 + 行选择列表 / 空态。
       *  `split` 时这一组自己就是一个带边框的分栏块（上半 / 下半），列表在块内滚动。 */
      const groupNode = function (g, split) {
        const d = dataOf(g.id)
        const list = d.entries || []
        return React.createElement('section', { key: g.id, className: split ? 'dsm-trash-split-pane' : 'dsm-trash-pane-group' },
          g.title ? React.createElement('div', { className: 'dsm-trash-pane-group-head' },
            React.createElement('span', { className: 'dsm-trash-pane-group-title', title: g.note }, g.title),
            React.createElement('span', { className: 'dsm-count' }, t('trash.items.count', { count: list.length }))) : null,
          d.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, d.error) : null,
          list.length ? bulkRow(g) : null,
          d.loading
            ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
            : list.length
              ? React.createElement('div', { className: 'dsm-trash-list' }, list.map(function (item) { return rowNode(g, item) }))
              : React.createElement(EmptyState, { text: g.emptyText || t('trash.empty') }))
      }
      /**
       * 「详情」弹窗（只读预览）。**只有「关闭」，没有保存** —— 用户 2026-10-12 第四轮的原话：
       * 「点开就能看这个信息是什么样子，不能更改内容，没有保存按键」。
       *
       * 三种形态：
       *   · 来源记录（目录组）—— `meta` 是一张「字段 → 值」表，不读盘；
       *   · 负载文件 —— 一份文件一张卡（相对路径 + 大小在头，正文在下面，直接复用 `.dsm-code`）；
       *   · 读不到 —— 只有一句错误，没有别的。
       *
       * 声明在组件**内部**（不是 factory 作用域）：它要用当前的 `t`（语言一换，
       * 窗口里那几行字也得跟着换）与 `setPreview`。
       */
      const previewModalNode = function () {
        const close = function () { setPreview(null) }
        let body
        if (preview.error) {
          body = React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, preview.error)
        } else if (preview.meta) {
          body = React.createElement('div', { className: 'dsm-form' },
            formSection(t('trash.preview.meta')),
            React.createElement('div', { className: 'dsm-fm' }, preview.meta.map(function (row) {
              return React.createElement('div', { key: row[0], className: 'dsm-fm-row' },
                React.createElement('div', { className: 'dsm-fm-key' }, row[0]),
                React.createElement('div', { className: 'dsm-fm-val' }, row[1]))
            })),
            React.createElement('div', { className: 'dsm-preview-note' }, t('trash.preview.dir.note')))
        } else if (preview.loading) {
          body = React.createElement('div', { className: 'dsm-empty' }, t('trash.preview.loading'))
        } else {
          const files = preview.files || []
          body = React.createElement('div', { className: 'dsm-preview' },
            React.createElement('div', { className: 'dsm-preview-note' },
              t('trash.preview.readonly') + ' · ' + t('trash.preview.files', { count: files.length })),
            files.length
              ? React.createElement('div', { className: 'dsm-preview-files' }, files.map(function (f, i) {
                return React.createElement('section', { key: f.path || i, className: 'dsm-preview-file' },
                  React.createElement('div', { className: 'dsm-preview-file-head' },
                    React.createElement('span', { className: 'dsm-preview-path', title: f.path }, f.path),
                    React.createElement('span', { className: 'dsm-preview-size' }, fmtBytes(f.size))),
                  f.text === undefined ? null : React.createElement('pre', { className: 'dsm-code' }, f.text),
                  // 二进制 / 截断各自如实标一句：不标的话用户会以为"这条记录就这么点内容"。
                  f.binary === true ? React.createElement('div', { className: 'dsm-preview-flag' }, t('trash.preview.binary')) : null,
                  f.truncated === true ? React.createElement('div', { className: 'dsm-preview-flag' }, t('trash.preview.truncated')) : null)
              }))
              : React.createElement(EmptyState, { text: t('trash.preview.empty') }))
        }
        // 只读预览单开一档（见 10-css.js 的 .dsm-modal-preview）：这里装的是代码正文，
        // S 档 440 一行要折好几次。负载文件那一档再挂 fill（定高 + 代码区吃掉剩余高度）。
        // ⚠️ 判据用上面那三个分支的**补集**，不能写 `preview.files` —— 那个字段在
        // openPreview 里就初始化成 `[]` 了，空数组是 truthy，来源记录那档会被误挂 fill。
        const isFilePreview = !preview.error && !preview.meta && !preview.loading
        return React.createElement(Modal, {
          key: 'trash-preview-modal',
          title: preview.name,
          closeLabel: t('btn.close'),
          className: 'dsm-modal-preview' + (isFilePreview ? ' dsm-modal-preview-fill' : ''),
          onClose: close,
        },
          body,
          React.createElement('div', { className: 'dsm-modal-actions' },
            React.createElement('button', { type: 'button', className: 'dsm-btn', onClick: close }, t('btn.close'))))
      }
      // 列表类弹窗（L=720）：头/底恒定，body 不滚，滚动交给右栏那一条列表区。
      //
      // 标题旁边那颗总数（用户 2026-10-12「回收站弹窗完善」）：标题原本只有一个「回收站」，
      // 里面装了多少东西得逐组去看计数徽标。**任一组还在读时不报** —— 一个会往上跳的数字
      // 比不报更让人怀疑自己看错了。
      const totalCount = groupIds.reduce(function (n, gid) { return n + (dataOf(gid).entries || []).length }, 0)
      const totalReady = groupIds.every(function (gid) { return dataOf(gid).loading !== true })
      const trashNode = React.createElement(Modal, {
        key: 'trash-modal',
        title: React.createElement('span', { className: 'dsm-modal-title-row' },
          props.title || t('trash.title'),
          totalReady ? React.createElement('span', { className: 'dsm-count' }, t('trash.total', { count: totalCount })) : null),
        closeLabel: t('btn.close'),
        list: true,
        className: 'dsm-modal-list dsm-modal-trash' + (split ? ' dsm-modal-trash-split' : ''),
        onClose: props.onClose,
      },
        notice ? React.createElement('div', { className: 'dsm-feedback dsm-trash-notice ' + (notice.ok ? 'dsm-ok' : 'dsm-error'), role: 'alert' }, notice.text) : null,
        React.createElement('div', { className: 'dsm-trash-pane' },
          React.createElement('div', { className: 'dsm-trash-pane-top' },
            React.createElement(RetentionSelect, { t: t, onReload: reloadAll })),
          // 分栏档的两块**不是**一条滚动链：各自滚、各自带批量条，所以外面这层不滚
          // （`overflow` 交给每块里的 `.dsm-trash-list`）。
          split
            ? React.createElement('div', { className: 'dsm-trash-split' },
                groupIds.map(function (gid) { return groupNode(GROUPS[gid], true) }))
            : React.createElement('div', { className: 'dsm-trash-pane-scroll' },
                groupIds.map(function (gid) { return groupNode(GROUPS[gid], false) }))))
      // 「已存在同名 X」确认窗：叠在回收站之上（`Modal` 自带 gateModalDepth 计数，与「详情」
      // 同一种叠法）。取消 → 回到回收站，勾选与滚动位置都不动，什么都没发生。
      const dupNode = dupAsk ? React.createElement(DupNameDialog, {
        key: 'dup-name', t: t, kind: t(dupAsk.kind),
        name: dupAsk.name, finalName: dupAsk.finalName, action: 'restore',
        busy: busy,
        onCancel: function () { setDupAsk(null) },
        onConfirm: function () { setDupAsk(null); runRestore(GROUPS[dupAsk.group], dupAsk.items, true) },
      }) : null
      if (!preview) return dupNode ? React.createElement(React.Fragment, null, trashNode, dupNode) : trashNode
      // 「详情」弹窗**叠在回收站上面**（`Modal` 自带 gateModalDepth 计数，叠弹窗是既有形态：
      // 导入套导出、自定义目录套选目录都是这样）。关掉它回到回收站，勾选与滚动位置都不动。
      return React.createElement(React.Fragment, null, trashNode, previewModalNode(), dupNode)
    }
    /**
     * 勾选行（2026-10-11 切片五收编）：本质就是行选择 RowSelect —— 导出列表、导入
     * 预览、模式工具这些「整行可点勾选」的列表行走 RowSelect 本尊，原生勾选框不再
     * 有第二种画法（REDESIGN §5.1）。保留 `pickRow` 这个名字：两处调用点的参数形状
     * （key/checked/name/desc/descTitle/meta/actions/disabled/onChange）与 RowSelect
     * 的 props 完全同形，直接透传。
     */
    function pickRow(props) {
      return h(RowSelect, {
        key: props.key, checked: props.checked === true, disabled: props.disabled === true,
        name: props.name, desc: props.desc, descTitle: props.descTitle,
        meta: props.meta, actions: props.actions, onChange: props.onChange,
      })
    }
    /** 段体顶部的筛选行（条目多的段用；勾选状态不受筛选影响）。 */
    function segFilter(value, onChange, placeholder) {
      return h('div', { className: 'dsm-seg-filter' },
        h('input', { className: 'dsm-control', value: value || '', placeholder: placeholder, onChange: function (e) { onChange(e.target.value) } }))
    }
    /** 分组小标题（长列表里给用户地标，避免「一屏看不出层次」）。 */
    function segGroup(label) {
      return h('div', { className: 'dsm-seg-group' },
        h('span', null, label),
        h('span', { className: 'dsm-seg-group-line' }))
    }
    /**
     * 表单分段标题（「基本信息 / 场景绑定」这类模块切分）。
     *
     * 与 `segGroup` 的差别只在**用在哪**：那个是滚动列表内部的地标（左右各留了内缩），
     * 这个是表单第一层，必须与下面的字段左边缘对齐，所以不套那圈 padding。
     */
    function formSection(label) {
      return h('div', { className: 'dsm-form-section' }, h('span', null, label))
    }
    /**
     * 「全选 ↔ 取消全选」二合一按钮的标签对 —— fixedLabelPair 的语义化别名（同一套定宽机制）。
     *
     * 两种文案宽度不同（中文「全选」2 字 vs「取消全选」4 字；英文 Select all vs
     * Deselect all 差得更多），只渲染当前那一份的话，按钮宽度会随点击变来变去 ——
     * 用户实测「点了『全选』变成『取消全选』，整颗按钮换到第二行」。
     */
    function bulkPair(label, other) {
      return fixedLabelPair(label, other)
    }
    /** 段头公共动作：全选 / 清空 / 移除段（未定义时改为「添加」）。 */
    /**
     * 段头动作。**批量动作合二为一**（D11）：同一时刻只有一个方向是合理的 ——
     * 还有没勾的 → 「全选」；全勾了 → 「全不选」。并列两个必然有一个是废话。
     * 未定义的可选段只给「添加」；「移除段」不属于全选族，保留。
     */
    function segActions(props) {
      if (!props.defined) return [h('button', { key: 'add', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.busy, onClick: props.onAdd }, props.addLabel)]
      var out = [h('button', { key: 'all', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: props.busy, onClick: props.allChecked ? props.onClear : props.onAll }, bulkPair(props.allChecked ? props.clearLabel : props.selectAllLabel, props.allChecked ? props.selectAllLabel : props.clearLabel))]
      // 常驻段（记忆，P5 单一真相源）没有「段定义」可移除 → 不传 onRemove 即不渲染。
      if (props.onRemove) out.push(h('button', { key: 'rm', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: props.busy, onClick: props.onRemove }, props.removeLabel))
      return out
    }
    /** 固定高度滚动体内的条目列表（空态居中提示）。 */
    function segList(nodes, emptyText) {
      if (!nodes.length) return h('div', { className: 'dsm-seg-body' }, h('div', { className: 'dsm-pick-empty' }, emptyText))
      return h('div', { className: 'dsm-seg-body' }, nodes)
    }

    /**
     * 字节数转人话（B / KB / MB）。
     *
     * ⚠️ 必须留在**模块作用域**：它被 `ImportModal`（四个页面共用）与记忆页附件列表共用。
     * 它原先只声明在记忆页内部 —— `ImportModal` 一渲染就抛 `fmtBytes is not defined`，
     * 而那是**渲染期**抛错：React 卸载整棵组件树，用户看到的是「设置面板整块空白」
     * （2026-09-19 用户实测：选中导入文件就白屏）。同一个名字声明在兄弟作用域里，
     * 从组件里调用不会报错在编译期，只在**跑到那一行**时炸。
     * 别指望有人替你兜住：原先静态拦它的 `test/client-scope.test.mjs` 已于 2026-09-19
     * 随三份界面测试一并移除（`test/_archive/` 目录并未落盘），这类问题现在是**纯人工**把关
     * —— 所以这个函数的位置是约定，不是被守护的事实。
     */
    function fmtBytes(n) {
      var v = Number(n) || 0
      if (v < 1024) return v + ' B'
      if (v < 1024 * 1024) return Math.ceil(v / 1024) + ' KB'
      return (Math.round((v / (1024 * 1024)) * 10) / 10) + ' MB'
    }

    // 通用导入弹窗（人设 / 记忆共用）：拖放或点选 .md / .zip → 已选计数 → 交由调用方走自己的写 op。
    // t 由调用方注入（各页的 t 是局部函数，不在模块作用域）；extra 用于注入「导入到场景」一类的额外字段。
    function ImportModal(props) {
      // 同时持有原始 File[] 与 base64 entries：前者给需要 `_dssmPath`（拖拽保留相对路径）
      // 或自己做校验的调用方（技能页），后者给只关心 `{name, data}` 的调用方。
      var st = react.useState([]); var picked = st[0], setPicked = st[1]
      var es = react.useState([]); var entries = es[0], setEntries = es[1]
      var ref = react.useRef(null)
      var t = props.t
      function add(list) {
        var next = Array.prototype.slice.call(list || [])
        if (!next.length) return
        Promise.all(next.map(function (f) { return f.arrayBuffer().then(function (buf) { return { name: uploadFilePath(f), data: bytesToBase64(buf) } }) }))
          .then(function (added) {
            setPicked(function (prev) { return prev.concat(next) })
            setEntries(function (prev) { return prev.concat(added) })
          })
          // 本弹窗没有错误展示位：读不进来的文件至少在控制台留痕，别让「选了没反应」无线索。
          .catch(function (e) { console.warn('[dsh-plugin-tool-management] 读取所选文件失败：', e) })
      }
      function dropAt(index) {
        setPicked(function (prev) { return prev.filter(function (_, j) { return j !== index }) })
        setEntries(function (prev) { return prev.filter(function (_, j) { return j !== index }) })
      }
      // 拖拽导入属「单表单」档：默认 M=560（REDESIGN §6.1「技能 / 子智能体 / 会话 导入 | M」）。
      return h(Modal, { title: props.title, closeLabel: t("btn.close"), onClose: props.onClose },
        h("div", { className: "dsm-form" },
          props.extra || null,
          // 拖拽区用**真按钮**而不是带 onClick 的 div：键盘用户 Tab 得到它、Enter/Space 打开文件
          // 选择（原生行为），焦点环也由 .dsm-dropzone:focus-visible 统一给。拖拽与点击语义不变。
          h("button", {
            type: "button",
            className: "dsm-dropzone",
            onClick: function () { if (ref.current) ref.current.click() },
            onDragOver: function (e) { e.preventDefault(); if (e.currentTarget.classList) e.currentTarget.classList.add("dsm-dropzone-active") },
            onDragLeave: function (e) { if (e.currentTarget.classList) e.currentTarget.classList.remove("dsm-dropzone-active") },
            onDrop: function (e) { e.preventDefault(); if (e.currentTarget.classList) e.currentTarget.classList.remove("dsm-dropzone-active"); droppedFiles(e.dataTransfer).then(add) },
          },
            h("span", { className: "dsm-dropzone-title" }, t("upload.drop.title")),
            h("span", { className: "dsm-dropzone-copy" }, props.hint || t("upload.drop.copy"))),
          h("input", { ref: ref, type: "file", multiple: true, accept: props.accept || ".md,.zip", className: "dsm-hidden-input", onChange: function (e) { add(e.target.files); e.target.value = "" } }),
          // 已选文件：一行一个（名字 + 大小 + 移除），与技能页同一形态。
          picked.length ? h("div", null, picked.map(function (f, i) {
            return h("div", { key: i, className: "dsm-file", title: f.name },
              h("span", { className: "dsm-file-kind", "aria-hidden": "true" }, "FILE"),
              h("span", { className: "dsm-file-name" }, f.name),
              h("span", { className: "dsm-file-meta" }, fmtBytes(f.size)),
              h("button", { type: "button", className: "dsm-file-remove", disabled: props.busy, "aria-label": t("upload.remove") + " " + f.name, onClick: function () { dropAt(i) } }, "×"))
          })) : null,
          props.result ? h("div", { className: "dsm-feedback" + (props.result.warning ? " dsm-warning" : props.result.ok ? "" : " dsm-error"), role: "alert" }, props.result.text) : null,
          // 文件要求（REDESIGN §7：说明 ≤1 行，机制细节进悬浮）——区内一行正文，全文进 title。
          props.requirement ? h("div", { className: "dsm-upload-requirements" },
            h("div", { className: "dsm-label" }, t("upload.requirements")),
            h("div", { className: "dsm-upload-req", title: props.requirementTitle || undefined }, props.requirement)) : null),
        h("div", { className: "dsm-modal-actions" },
          picked.length ? h("button", { type: "button", className: "dsm-btn dsm-btn-quiet", disabled: props.busy, onClick: function () { setPicked([]); setEntries([]) } }, t("import.clear")) : null,
          h("button", { type: "button", className: "dsm-btn", disabled: props.busy || !picked.length, onClick: function () { props.onSubmit(entries, picked) } }, props.busy ? t("upload.importing") : t("import.submit"))))
    }

    /**
     * 通用导出弹窗（D14）：选中项 + 目标目录 → 调 `bundle-export` 打包成 zip。
     * 技能 / 子智能体 / 提示词 / 记忆四页共用，避免各写一份。
     * 只读源文件、只往用户指定目录写 zip，不改动任何插件数据。
     */
    function ExportModal(props) {
      var t = props.t
      var ds = react.useState(props.outDir || defaultIoDir()); var outDir = ds[0], setOutDir = ds[1]
      var ps = react.useState(false); var picking = ps[0], setPicking = ps[1]
      var items = props.items || []
      // 默认**不勾选**：导出是"把东西拿出去"，一键全选最容易让人把不该带走的也带走。
      var ss = react.useState([]); var picked = ss[0], setPicked = ss[1]
      var cs = react.useState({}); var collapsed = cs[0], setCollapsed = cs[1]
      function toggle(key) {
        setPicked(function (prev) { return prev.indexOf(key) >= 0 ? prev.filter(function (k) { return k !== key }) : prev.concat([key]) })
      }
      /** 分组：`it.group` 为空 = 不分组（组头不渲染）。组内、组间都保持传入顺序。 */
      var groups = [], byGroup = {}
      items.forEach(function (it) {
        var g = String(it.group == null ? '' : it.group)
        if (!byGroup[g]) { byGroup[g] = []; groups.push({ name: g, rows: byGroup[g] }) }
        byGroup[g].push(it)
      })
      var allKeys = items.map(function (i) { return i.key })
      var allPicked = allKeys.length > 0 && picked.length === allKeys.length
      return h(Modal, { className: 'dsm-modal-list dsm-export-modal', list: true, title: props.title, closeLabel: t('btn.close'), onClose: props.onClose },
        h('div', { className: 'dsm-form dsm-export-form' },
          h('p', { className: 'dsm-help' }, t('export.hint')),
          h('div', { className: 'dsm-field' },
            h('span', { className: 'dsm-label' }, t('export.outDir')),
            h('div', { className: 'dsm-dir-row' },
              h('input', { className: 'dsm-control', type: 'text', value: outDir, placeholder: defaultIoDir(), onChange: function (e) { setOutDir(e.target.value) } }),
              h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: props.busy, onClick: function () { requestHostDirectory(setOutDir, function () { setPicking(true) }) } }, t('btn.openDir')))),
          // 条目列表：始终渲染（哪怕只有一条）—— 默认不勾选意味着「不列出来就没得勾」。
          items.length ? h('div', { className: 'dsm-pick-list' }, groups.map(function (g) {
            var open = collapsed[g.name] !== true
            return h('div', { key: 'g:' + g.name, className: 'dsm-pick-group' },
              g.name ? h('button', {
                type: 'button', className: 'dsm-pick-group-head', 'aria-expanded': open ? 'true' : 'false',
                onClick: function () { setCollapsed(function (prev) { var next = Object.assign({}, prev); next[g.name] = open; return next }) },
              },
                h(CaretIcon, { key: 'caret', open: open, className: 'dsm-pick-caret' }),
                h('span', { className: 'dsm-pick-group-name', title: g.name }, g.name),
                h('span', { className: 'dsm-pick-group-count' }, t('export.group.count', { count: g.rows.length }))) : null,
              open ? g.rows.map(function (it) {
                return pickRow({ key: it.key, checked: picked.indexOf(it.key) >= 0, name: it.name, desc: it.desc, descTitle: it.descTitle || it.desc, onChange: function () { toggle(it.key) } })
              }) : null)
          })) : h('div', { className: 'dsm-pick-empty' }, t('export.empty')),
          props.result ? h('div', { className: 'dsm-feedback' + (props.result.ok ? '' : ' dsm-error'), role: 'alert' }, props.result.text) : null),
        h('div', { className: 'dsm-modal-actions' },
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk', disabled: props.busy || !items.length, onClick: function () { setPicked(allPicked ? [] : allKeys.slice()) } }, bulkPair(allPicked ? t('export.pickNone') : t('export.pickAll'), allPicked ? t('export.pickAll') : t('export.pickNone'))),
          h('button', { type: 'button', className: 'dsm-btn', disabled: props.busy || !picked.length || !outDir.trim(), onClick: function () { props.onSubmit(picked, outDir.trim()) } }, props.busy ? t('export.busy') : t('export.submit'))),
        picking ? h(DirPickerModal, { key: 'dir', title: t('export.pickDir'), initial: outDir, closeLabel: t('btn.close'), onClose: function () { setPicking(false) }, onPick: function (p) { setOutDir(p); setPicking(false) } }) : null)
    }

    /**
     * 导出结果文案（四个导出页共用）：成功条数 + 被跳过的项。
     *
     * 服务端把读不到的项记进 `missing` 而不是整体失败（部分成功也有价值），但**必须说出来**
     * —— 只报「已导出 N 个文件」会把静默丢项显示成完全成功（bundle 型路径曾经就是这样丢的）。
     */
    function exportResultText(t, res) {
      var text = t('export.done', { count: res.written, path: res.zipPath })
      var skipped = (res && res.missing) || []
      if (skipped.length) text += t('export.missing', { count: skipped.length, names: skipped.join(', ') })
      return text
    }

    // 目录选择器：经 host 的 dir-list 逐级浏览目录树，选中后把绝对路径回填给调用方。
    // 标准浏览器不暴露所选文件夹的绝对路径（File.path 仅 Electron 可用），故不走
    // webkitdirectory，改由宿主端列目录 + 前端目录树完成「选择文件夹」。
    function DirPickerModal(props) {
      var stState = react.useState({ loading: true, error: null, current: '', parent: null, entries: [] })
      var st = stState[0], setSt = stState[1]
      var txState = react.useState(props.initial || '')
      var text = txState[0], setText = txState[1]
      function load(dir) {
        setSt({ loading: true, error: null, current: dir || '', parent: null, entries: [] })
        apiCall('dir-list', { dir: dir || '' }).then(function (res) {
          if (res && res.ok) setSt({ loading: false, error: null, current: res.current || '', parent: res.parent || null, entries: res.entries || [] })
          else setSt({ loading: false, error: (res && res.error) || t('dir.error.unreadable'), current: dir || '', parent: null, entries: [] })
        }).catch(function () {
          setSt({ loading: false, error: t('dir.error.unreadable'), current: dir || '', parent: null, entries: [] })
        })
      }
      react.useEffect(function () { load(props.initial || '') }, [])
      function jump() { var v = String(text || '').trim(); if (v) load(v) }
      function goUp() { if (!st.parent) return; setText(st.parent); load(st.parent) }
      function enter(path) { setText(path); load(path) }
      function pick() { var target = String(st.current || '').trim() || String(text || '').trim(); if (target && props.onPick) props.onPick(target) }
      return h(Modal, { title: props.title || t('dir.title'), closeLabel: props.closeLabel || t('btn.close'), onClose: props.onClose },
        h("div", { className: "dsm-form" },
          h("label", { className: "dsm-field" },
            h("span", { className: "dsm-label" }, t('dir.currentPath')),
            h("div", { className: "dsm-dir-row" },
              h("input", { className: "dsm-control", value: text, placeholder: t('dir.pathPlaceholder'), onChange: function (e) { setText(e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); jump(); } } }),
              h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: st.loading || !String(text || '').trim(), onClick: jump }, t('dir.jump')))),
          st.error ? h("div", { className: "dsm-feedback dsm-error", role: "alert" }, st.error) : null,
          h("div", { className: "dsm-dir-list" },
            st.loading ? h("div", { className: "dsm-empty" }, t('dir.loading'))
              : st.entries.length ? st.entries.map(function (e) { return h("button", { key: e.path, type: "button", className: "dsm-dir-item", title: e.path, onClick: function () { enter(e.path); } }, e.name); })
              : h("div", { className: "dsm-empty" }, t('dir.empty'))),
          h("div", { className: "dsm-modal-actions" },
            h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", disabled: st.loading || !st.parent, onClick: goUp }, t('dir.up')),
            h("button", { type: "button", className: "dsm-btn", disabled: st.loading || !(String(st.current || '').trim() || String(text || '').trim()), onClick: pick }, t('dir.pick')))))
    }

    // （MCP 配置体检的 `InspectDot` 已随体检功能一起删除 —— 用户 2026-10-12 裁定移除，
    //  见 41-mcp.js 里 openDetail 上方那段说明。行首现在只剩连接态那一枚点。）

    /**
     * 行内状态标签：挂在名字后面的那颗描边胶囊，四个域共用一个出口（配色口径一致）。
     * tone：ok=能用、bad=坏了、warn=当前不能用但不是故障、muted=没在跑 / 不是问题（灰）。
     */
    function StatusTag(props) {
      var tone = props.tone === 'ok' ? ' dsm-tag-on' : props.tone === 'bad' ? ' dsm-tag-off' : props.tone === 'warn' ? ' dsm-tag-warn' : ''
      return h('span', { className: 'dsm-tag' + tone, title: props.title }, props.text)
    }
