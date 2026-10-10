
        // ---------- Skills 页（移植自 dsh-skills-manager，Apache-2.0；类名前缀 dsm-） ----------
        var react = React // 上游组件使用小写 react，别名到本文件的 React
        var h = React.createElement

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
    // 弹窗的键盘行为（Esc 关闭 / Tab 焦点陷阱）在**模块作用域**，见 refreshButton 上方的
    // 「弹窗键盘行为」一节 —— 兼容页在 `apply` 之外，它的手工弹窗与 `Modal` 共用这三个函数。

    /**
     * 「启用的排在前面」——on/off 两半各自保持宿主原序（稳定分区，不是排序）。
     * 不用 sort：用户要求「停用后落回原来的位置」，sort 会打乱半区内的相对次序。
     * 返回新数组：入参多是 React state 里的数组，就地改会让列表在别处一起变。
     */
    function enabledFirst(items, isOn) {
      var on = [], off = [];
      (items || []).forEach(function (item) { (isOn(item) ? on : off).push(item); });
      return on.concat(off);
    }

    /** 换位过渡时长（毫秒）。与 .dsm-switch:after 的 160ms 同档，观感一致。 */
    var FLIP_MS = 180;

    /**
     * 列表换位的 FLIP 动画：开关一变、行挪了位，就让它滑过去而不是瞬移。
     * 只在「同一批元素、且启停状态确实变了」的那一帧播放：
     *   搜索 / 筛选 / 展开收起 / 列表加载 → key 有增删 → 只记录不播；
     *   MCP 的轮询与计时器只重渲染同一份列表 → 没有启停变化 → 不播。
     * 用 useLayoutEffect：反向位移必须写在浏览器绘制之前，否则会先闪一帧新布局。
     * 量 offsetTop/offsetLeft（布局坐标）而不是 getBoundingClientRect：
     *   自身动画中的 transform 与页面滚动都不会污染基线；多列网格（场景页）的横向位移也覆盖。
     * 前提：同一容器里的行共用同一个 offsetParent（这些行到卡片链上没有定位元素）。
     * ref 为空（没渲染 / 测试里的假 dispatcher）时静默跳过。
     */
    function useFlipReorder(ref) {
      var prevRef = React.useRef(null);
      // 万一宿主换了个没有 useLayoutEffect 的 React：退到 useEffect（会先闪一帧，但别崩）。
      var useIso = React.useLayoutEffect || React.useEffect;
      useIso(function () {
        var host = ref.current;
        if (!host || typeof host.querySelectorAll !== 'function') return;
        var nodes = Array.prototype.slice.call(host.querySelectorAll('[data-flip-key]'));
        var next = new Map();
        nodes.forEach(function (node) {
          if (!node.offsetWidth && !node.offsetHeight) return; // 没布局（隐藏 / 收起）→ 不可比
          next.set(node.getAttribute('data-flip-key'), {
            left: node.offsetLeft, top: node.offsetTop,
            on: node.getAttribute('data-flip-on'),
          });
        });
        var prev = prevRef.current;
        prevRef.current = { host: host, map: next };
        // 首帧、容器换过（列表卸载重建）、key 有增删、有重复 key → 只记录不播。
        if (!prev || prev.host !== host || next.size === 0
          || next.size !== nodes.length || next.size !== prev.map.size) return;
        var changed = false, sameKeys = true;
        next.forEach(function (item, key) {
          var before = prev.map.get(key);
          if (!before) { sameKeys = false; return; }
          if (before.on !== item.on) changed = true;
        });
        if (!sameKeys || !changed) return;
        if (typeof window !== 'undefined' && window.matchMedia
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        nodes.forEach(function (node) {
          var key = node.getAttribute('data-flip-key'), before = prev.map.get(key);
          if (!before) return;
          var item = next.get(key), dx = before.left - item.left, dy = before.top - item.top;
          if (!dx && !dy) return; // 本来就没挪窝
          // 上一次没播完就再来一次：只在这时要还原（否则轮询会把动画截断成瞬移）。
          if (node.__dsmFlip) { clearTimeout(node.__dsmFlip); node.__dsmFlip = 0; }
          node.style.transition = 'none'; // 先瞬移回原位，否则浏览器把新位置当动画起点
          node.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          void node.offsetWidth;          // 结算样式，让上面两句真的落到起点上
          node.style.transition = 'transform ' + FLIP_MS + 'ms ease';
          node.style.transform = '';
          // 收尾清掉内联样式：留着 transform 会改变包含块、且动画后仍叠在相邻行之上。
          node.__dsmFlip = setTimeout(function () {
            node.__dsmFlip = 0;
            node.style.transition = '';
            node.style.transform = '';
          }, FLIP_MS + 40);
        });
      });
    }

    function SourceSelect(props) {
      var state = react.useState(false), open = state[0], setOpen = state[1], selected = props.options.find(function (o) { return o.value === props.value; }) || props.options[0], ref = react.useRef(null);
      react.useEffect(function () { if (!open) return undefined; function close(event) { if (!ref.current || !ref.current.contains(event.target)) setOpen(false); } document.addEventListener("pointerdown", close); return function () { document.removeEventListener("pointerdown", close); }; }, [open]);
      return h("div", { className: "dsm-select", ref: ref }, h("button", { type: "button", className: "dsm-select-trigger", "aria-haspopup": "listbox", "aria-expanded": open, onClick: function () { setOpen(!open); } }, h("span", null, selected.label)), open ? h("div", { className: "dsm-select-menu", role: "listbox" }, props.options.map(function (o) { return h("button", { key: o.value || "all", type: "button", role: "option", className: "dsm-option", "aria-selected": o.value === props.value, onClick: function () { props.onChange(o.value); setOpen(false); } }, o.label); })) : null);
    }
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
    function Switch(props) { return h("button", { type: "button", className: "dsm-switch" + (props.on ? " dsm-switch-on" : ""), role: "switch", "aria-checked": props.on, "aria-label": props.label, title: props.title, disabled: props.disabled, onClick: props.onClick }); }
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
     */
    function tokenGateRow(text) {
      return h('div', { className: 'dsm-feedback dsm-error dsm-feedback-row', role: 'alert' },
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
      var head = h("div", { className: "dsm-modal-head-wrap" },
        h("div", { className: "dsm-modal-head" },
          h("h3", { className: "dsm-modal-title" }, props.title),
          h("button", { type: "button", className: "dsm-btn dsm-btn-secondary", onClick: props.onClose }, props.closeLabel)),
        h(TokenGateNotice, null))
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
      return React.createElement('div', { className: 'dsm-trash-retention' },
        React.createElement('span', { className: 'dsm-label' }, t('trash.retention.label')),
        React.createElement('select', {
          className: 'dsm-control',
          value: days === null ? '' : String(days),
          disabled: s.loading || s.busy || days === null,
          'aria-label': t('trash.retention.label'),
          onChange: function (e) { choose(e.target.value) },
        },
          days === null ? React.createElement('option', { value: '' }, t('trash.retention.loading')) : null,
          values.map(function (v) {
            return React.createElement('option', { key: v, value: String(v) },
              v === 0 ? t('trash.retention.forever') : t('trash.retention.days', { count: v }))
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
    // 非分栏时那条唯一的批量条用这个哨兵当"确认中"的标记（分栏时用的是那一块的组标题）。
    // 用对象而不是字符串：组标题是用户可见文案，理论上可能撞上任何字符串字面量。
    const TRASH_BULK_ALL = { all: true }
    function TrashModal(props) {
      const t = props.t
      // 分栏模式：上下两块各占一半、各自滚动、**每块自带一条**批量条（见函数头注）。
      const split = props.split === true
      const c = React.useState(null)
      const confirmId = c[0], setConfirmId = c[1]
      // 勾选集合。key = `<组标题>|<条目 id>`，**不能只按 id 记**：提示词页一次列两组
      // （全局预设 + 快捷提示词），两组的 id 来自同一条生成器，只按 id 记会让两组互相勾中。
      const sel = React.useState({})
      const selected = sel[0], setSelected = sel[1]
      // 批量二次确认。存的不是布尔而是"哪一条批量条在确认"：分栏时上下两块**各有一条**，
      // 共用一颗布尔会让下面那块也跟着翻成确认态 —— 它的按钮并不是刚点的那颗。
      // 非分栏时用 `TRASH_BULK_ALL` 这个哨兵（整份列表只有一条批量条）。
      const bc = React.useState(null)
      const bulkConfirm = bc[0], setBulkConfirm = bc[1]
      // 组：默认就是调用方传的那一组（`groupTitle` / `entries`）；给了 `groups` 就按数组列多组
      // —— 提示词页的回收站要一次看完"全局"与"快捷"两类，让用户先猜被删的东西在哪个域里，
      // 等于把恢复这条路堵在他自己手里。每组各自有空的说明，不合并成一句"什么都没删"。
      const groups = props.groups || [{ title: props.groupTitle, sub: props.groupSub, entries: props.entries || [] }]
      const rowKey = function (g, item) { return String(g.title) + '|' + String(item.id) }
      // 平铺一份：非分栏时「全选」与「永久删除」按**整份列表**算，不能只看某一组。
      const flat = []
      groups.forEach(function (g) {
        (g.entries || []).forEach(function (item) { flat.push({ group: g, item: item, key: rowKey(g, item) }) })
      })
      const allKeys = flat.map(function (x) { return x.key })
      // 场景锁定时批量删除一并禁用：单条「永久删除」已经禁用，批量是同一件事，
      // 只禁单条等于留了一个绕过锁定一次删光的口子。
      const batchDisabled = props.busy === true || props.locked === true
      // 没传 onPurgeMany 的调用方（目前没有，但 props 是可选的）不渲染批量控件，
      // 而不是渲染出按不动的按钮。
      const batchEnabled = typeof props.onPurgeMany === 'function' && flat.length > 0
      const toggle = function (key) {
        setSelected(function (prev) {
          var next = Object.assign({}, prev)
          if (next[key] === true) delete next[key]
          else next[key] = true
          return next
        })
      }
      const pickedOf = function (keys) { return keys.filter(function (k) { return selected[k] === true }) }
      const toggleAll = function (keys, on) {
        setSelected(function (prev) {
          var next = Object.assign({}, prev)
          keys.forEach(function (k) { if (on) next[k] = true; else delete next[k] })
          return next
        })
      }
      /**
       * 跑一条批量删除。`keys` 是这条批量条管的范围（非分栏 = 整份列表；分栏 = 那一块）。
       * 按**范围**过滤而不是直接拿整份勾选：分栏时上面那块点确认，不该把下面那块的勾选也删掉。
       * 删完也只清这一批的勾 —— 条目删掉之后 key 就失效了，留着会变成一串永远勾不中的残留；
       * 而另一块的勾选是用户还没处理的选择，不该替他清掉。
       */
      const runBulk = function (keys) {
        var inScope = {}
        keys.forEach(function (k) { inScope[k] = true })
        var items = flat.filter(function (x) { return inScope[x.key] === true && selected[x.key] === true }).map(function (x) { return x.item })
        setBulkConfirm(null)
        setSelected(function (prev) {
          var next = Object.assign({}, prev)
          keys.forEach(function (k) { delete next[k] })
          return next
        })
        if (items.length) props.onPurgeMany(items)
      }
      /**
       * 一条批量条：「已选 N 项 + 全选 + 永久删除 (N)」；二次确认就地替换这一行
       * （避免"确认了但按钮还在原位"的错觉）。非分栏与分栏共用，只是 `keys` 的范围不同。
       */
      const bulkRow = function (keys, confirmKey) {
        var pickedHere = pickedOf(keys)
        var allHere = keys.length > 0 && pickedHere.length === keys.length
        if (bulkConfirm === confirmKey) {
          return React.createElement('div', { className: 'dsm-trash-bulk dsm-trash-bulk-confirm' },
            React.createElement('span', { className: 'dsm-note' }, t('trash.purgeSelected.confirm', { count: pickedHere.length })),
            React.createElement('button', {
              type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: props.busy,
              onClick: function () { runBulk(keys) },
            }, t('trash.btn.confirmPurgeMany', { count: pickedHere.length })),
            React.createElement('button', {
              type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.busy,
              onClick: function () { setBulkConfirm(null) },
            }, t('btn.cancel')))
        }
        return React.createElement('div', { className: 'dsm-trash-bulk' },
          React.createElement('span', { className: 'dsm-note' }, t('trash.selected', { count: pickedHere.length })),
          // 「全选 ↔ 全不选」二合一（`bulkPair` 定宽，避免两种文案宽度不同把按钮推来推去）。
          React.createElement('button', {
            type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk',
            disabled: batchDisabled,
            onClick: function () { toggleAll(keys, !allHere) },
          }, bulkPair(allHere ? t('trash.deselectAll') : t('trash.selectAll'), allHere ? t('trash.selectAll') : t('trash.deselectAll'))),
          React.createElement('button', {
            type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger',
            disabled: batchDisabled || pickedHere.length === 0,
            onClick: function () { setBulkConfirm(confirmKey) },
          }, t('trash.btn.purgeSelected', { count: pickedHere.length })))
      }
      const row = function (g, item) {
        const key = rowKey(g, item)
        const confirming = confirmId === key
        const isPicked = selected[key] === true
        const actions = confirming
          ? [
              React.createElement('span', { className: 'dsm-note', key: 'ask' }, t('trash.purge.confirm')),
              React.createElement('button', { key: 'yes', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: props.busy, onClick: function () { setConfirmId(null); props.onPurge(item) } }, t('btn.delete.forever')),
              React.createElement('button', { key: 'no', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.busy, onClick: function () { setConfirmId(null) } }, t('btn.cancel')),
            ]
          : [
              React.createElement('button', { key: 'restore', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: props.busy || props.locked === true, onClick: function () { props.onRestore(item) } }, t('btn.restore')),
              React.createElement('button', { key: 'purge', type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: props.busy || props.locked === true, onClick: function () { setConfirmId(key) } }, t('btn.delete.forever')),
            ]
        return React.createElement('div', { className: 'dsm-trash-item' + (isPicked ? ' dsm-trash-item-picked' : ''), key: item.id },
          // 勾选框只在能批量删的时候出现：没有 onPurgeMany 的调用方（见上面的 batchEnabled）
          // 渲染一颗永远禁用的勾选框，只会让人以为"这里本来能勾、只是现在不行"。
          batchEnabled
            ? React.createElement('label', { className: 'dsm-trash-pick', title: t('trash.pick.title') },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: isPicked,
                  disabled: batchDisabled,
                  'aria-label': t('trash.pick.title') + ' ' + String(item.name || ''),
                  onChange: function () { toggle(key) },
                }))
            : null,
          React.createElement('div', { className: 'dsm-trash-main' },
            React.createElement('div', { className: 'dsm-name' }, item.name),
            React.createElement('div', { className: 'dsm-note' }, t('trash.deletedAt', {
              time: item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '—',
            }))),
          actions)
      }
      /**
       * 组头（标题 + 计数 + 后果说明）。分栏与非分栏共用同一套排版。
       *
       * 组头**不放按钮**：非分栏时勾选与删除都是跨组的（提示词页一次列两组），组头各放一颗
       * 「全选」就得各配一颗删除键 —— 那正是被砍掉的多颗形态；分栏时两颗动作下到每块自己的
       * 批量条里（`.dsm-trash-pane-batch`），组头仍然只是标题。
       */
      const groupHead = function (g) {
        const list = g.entries || []
        return React.createElement('div', { className: 'dsm-trash-group-head' },
          React.createElement('div', { className: 'dsm-trash-group-head-row' },
            React.createElement('span', { className: 'dsm-trash-group-title' }, g.title),
            React.createElement('span', { className: 'dsm-count' }, t('trash.items.count', { count: list.length }))),
          // 后果说明进组头（sticky 跟着滚）：这组删的是记录还是文件，一眼可辨。
          g.sub ? React.createElement('p', { className: 'dsm-trash-group-sub' }, g.sub) : null)
      }
      /**
       * 分栏模式的一块（组头 + 批量条 + 列表区），与技能回收站（43-skills.js 的 `trashPane`）
       * 同一套结构与类名。批量条挂在**每块里**：两块的后果不同（预设目录 / 快捷提示词目录），
       * 一颗共用的「全选 + 永久删除」会让人勾完之后不知道那一键要删哪个。
       */
      const renderPane = function (g) {
        const list = g.entries || []
        const keys = (g.entries || []).map(function (item) { return rowKey(g, item) })
        const rows = props.loading
          ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
          : list.length === 0
            ? React.createElement('div', { className: 'dsm-empty' }, t('trash.empty'))
            : list.map(function (item) { return row(g, item) })
        return React.createElement('div', { className: 'dsm-trash-group', key: String(g.title) },
          groupHead(g),
          // 批量条只在**这一块真有可删的东西**时出现：空块上挂一条「已选 0 项 + 全选 + 永久删除 (0)」
          // 是纯噪音，两块各占一半高度，那条还白吃掉一行的列表空间（技能页同一条判据）。
          batchEnabled && keys.length
            ? React.createElement('div', { className: 'dsm-trash-pane-batch' }, bulkRow(keys, String(g.title)))
            : null,
          React.createElement('div', { className: 'dsm-trash-pane-body' }, rows))
      }
      const renderGroup = function (g) {
        const list = g.entries || []
        const rows = props.loading
          ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
          : list.length === 0
            ? React.createElement('div', { className: 'dsm-empty' }, t('trash.empty'))
            : list.map(function (item) { return row(g, item) })
        return React.createElement('div', { className: 'dsm-trash-group', key: String(g.title) },
          groupHead(g),
          React.createElement('div', { className: 'dsm-trash-group-body' }, rows))
      }
      // 批量那一行：「已选 N 项」占左侧，**「全选」与唯一的「永久删除」并排靠最右**
      // （用户 2026-10-10 裁定：删除键一个就够，与全选同一行、放最右边）。
      // 分栏时这一行只剩保留期 —— 批量条已经下到两块里，与技能回收站同形。
      const toolbar = split
        ? React.createElement(RetentionSelect, { key: 'retention', t: t, onReload: props.onReload })
        : React.createElement('div', { className: 'dsm-trash-toolbar', key: 'toolbar' },
            React.createElement(RetentionSelect, { t: t, onReload: props.onReload }),
            batchEnabled ? bulkRow(allKeys, TRASH_BULK_ALL) : null)
      // 列表类弹窗：宽高都固定（`.dsm-modal-list` + `.dsm-modal-trash`），滚动只发生在
      // Modal 的 body 这一层 —— 条目数变化时弹窗不跳，也不会出现「弹窗滚 + 组内滚」的嵌套滚动条。
      // 分栏时反过来：body 不滚，滚动下到每块的列表区里（`.dsm-modal-trash-split`）。
      return React.createElement(Modal, {
        key: 'trash-modal',
        title: props.title,
        closeLabel: t('btn.close'),
        list: true,
        className: 'dsm-modal-list dsm-modal-trash' + (split ? ' dsm-modal-trash-split' : ''),
        onClose: props.onClose,
      },
        props.error ? React.createElement(Notice, { kind: 'err', text: props.error }) : null,
        toolbar,
        split
          ? React.createElement('div', { className: 'dsm-trash-split' }, groups.map(renderPane))
          : groups.map(renderGroup))
    }

    /** 勾选行：复选框 + 名称/说明 + 右侧指标 + 可选行内动作。 */
    function pickRow(props) {
      return h('label', { key: props.key, className: 'dsm-pick' },
        h('input', { type: 'checkbox', checked: props.checked === true, disabled: props.disabled === true, onChange: props.onChange }),
        h('span', { className: 'dsm-pick-main' },
          h('span', { className: 'dsm-pick-name' }, props.name),
          // 行内传进来的 desc 可能已被调用方截断，全文走 descTitle（悬浮可见）。
          props.desc ? h('span', { className: 'dsm-pick-desc', title: props.descTitle || undefined }, props.desc) : null),
        props.meta ? h('span', { className: 'dsm-pick-meta' }, props.meta) : null,
        props.actions ? h('span', { className: 'dsm-pick-actions' }, props.actions) : null)
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
      return h(Modal, { className: "dsm-modal-sm", title: props.title, closeLabel: t("btn.close"), onClose: props.onClose },
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
          // 文件要求清单（可选）：调用方按页传，结构上限制「这页需要什么格式」的表达。
          props.requirements && props.requirements.length ? h("div", { className: "dsm-upload-requirements" },
            h("div", { className: "dsm-label" }, t("upload.requirements")),
            h("ul", null, props.requirements.map(function (r, i) { return h("li", { key: i }, r) }))) : null),
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
      var ds = react.useState(props.outDir || ''); var outDir = ds[0], setOutDir = ds[1]
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
              h('input', { className: 'dsm-control', type: 'text', value: outDir, placeholder: t('export.outDir.placeholder'), onChange: function (e) { setOutDir(e.target.value) } }),
              h('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: props.busy, onClick: function () { setPicking(true) } }, t('btn.openDir')))),
          // 条目列表：始终渲染（哪怕只有一条）—— 默认不勾选意味着「不列出来就没得勾」。
          items.length ? h('div', { className: 'dsm-pick-list' }, groups.map(function (g) {
            var open = collapsed[g.name] !== true
            return h('div', { key: 'g:' + g.name, className: 'dsm-pick-group' },
              g.name ? h('button', {
                type: 'button', className: 'dsm-pick-group-head', 'aria-expanded': open ? 'true' : 'false',
                onClick: function () { setCollapsed(function (prev) { var next = Object.assign({}, prev); next[g.name] = open; return next }) },
              },
                h('span', { className: 'dsm-pick-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
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

    // ---------- MCP 配置体检（0.15.0 B1）--------------------------------------
    /**
     * 体检状态点。配色按琥珀语义分工：绿=体检通过、灰=还没体检（**不是**「没问题」）、
     * 黄=查出 warn、info 级说明不点黄（它说的是"这项确认不了"，不是"出了问题"）。
     */
    function InspectDot(props) {
      return h('span', {
        className: 'dsm-dot dsm-dot-' + (props.tone || 'idle'),
        role: 'img',
        'aria-label': props.title,
        title: props.title,
      })
    }

    /**
     * 行内状态标签：挂在名字后面的那颗描边胶囊，四个域共用一个出口（配色口径一致）。
     * tone：ok=能用、bad=坏了、warn=当前不能用但不是故障、muted=没在跑 / 不是问题（灰）。
     */
    function StatusTag(props) {
      var tone = props.tone === 'ok' ? ' dsm-tag-on' : props.tone === 'bad' ? ' dsm-tag-off' : props.tone === 'warn' ? ' dsm-tag-warn' : ''
      return h('span', { className: 'dsm-tag' + tone, title: props.title }, props.text)
    }
