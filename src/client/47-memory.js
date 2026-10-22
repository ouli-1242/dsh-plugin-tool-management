        function MemoryPage() {
          var EMPTY_STATS = { total: 0, enabled: 0, scenes: 0 }
          var EMPTY_MEMORY = { usedBytes: 0, maxBytes: 0, truncated: false }
          var state = React.useState({
            loading: true, error: null,
            rules: [], scenes: [], activeMode: 'all',
            sceneMemory: EMPTY_MEMORY, stats: EMPTY_STATS,
            // 服务端的如实清单（扫描/读取被跳过的条目）—— 以前整份丢掉，用户只看到"少了一条"。
            warnings: [],
          })
          var data = state[0], setData = state[1]
          // 切走这一页 → 记忆编辑弹窗关窗时那份暂存作废（见 42-shared-ui.js 的 useFormDraftScope）。
          useFormDraftScope('mem:')
          var qs = React.useState('')
          // 场景锁定（v0.8）：任一场景锁定 = 五个域整体冻结；本页全部写控件禁用。
          var anyLocked = data.anyLocked === true
          // 场景内开关由档案定义：本页开关置灰，横幅说明"改动会同步写进该场景的档案"。
          // 与技能 / 子智能体 / MCP 页同源（都取列表响应的 `activeScene`）。
          var sceneName = data.activeScene || null
          var query = qs[0], setQuery = qs[1]
          // 过滤用防抖值（输入框仍绑 `query`）：本页的编辑器弹窗每敲一个字都会重渲染整页，
          // 不防抖就是"每个按键 + 每次重渲染"都重扫全表（视图重算见下方 useMemo）。
          var dq = useDebouncedValue(query)
          var sfs = React.useState('')
          var sceneFilter = sfs[0], setSceneFilter = sfs[1]
          var cs = React.useState({})
          var collapsed = cs[0], setCollapsed = cs[1]
          var ms = React.useState(null)
          var modal = ms[0], setModal = ms[1]
          var rs = React.useState(null)
          var result = rs[0], setResult = rs[1]
          var bs = React.useState(false)
          var busy = bs[0], setBusy = bs[1]
          var es = React.useState(null)
          var editor = es[0], setEditor = es[1]
          var ups = useUndoState()
          var undo = ups[0], setUndo = ups[1], dismissUndo = ups[2]
          var imps = React.useState('global')
          var importScene = imps[0], setImportScene = imps[1]
          // 新建场景弹窗与场景建/删已移至「场景」页（ScenesPage）。
          // 记忆回收站：true = 打开本页那一个回收站（42-shared-ui.js 的 TrashModal）。
          var trs = React.useState(false)
          var trash = trs[0], setTrash = trs[1]
          // D14：导出弹窗的状态（busy + 结果）。刻意不复用本页的 `result`：
          // 那个是页面级回执（会自动消失），导出结果只该出现在弹窗里。
          var exs = React.useState(null)
          var exportState = exs[0], setExportState = exs[1]
          // 「已存在同名记忆」确认弹窗的状态（用户 2026-10-14）：`{ name, finalName }` 或 null。
          // 撞名不再静默退号，先问一句；确认后才按 `finalName` 提交（见 submitCreate）。
          var dqs = React.useState(null)
          var dupAsk = dqs[0], setDupAsk = dqs[1]
          // bundle 附件的隐藏文件选择器；上限与服务端 MAX_ATTACH_ENTRY_BYTES 对齐。
          var attachRef = React.useRef(null)
          var ATTACH_MAX_MB = 8
          var ATTACH_MAX_BYTES = ATTACH_MAX_MB << 20
          // 从「N 个附件」标签进来的那一次，要把附件区滚进视野（否则那颗标签就只是块装饰：
          // 打开弹窗后还得自己往下找）。用回调 ref 会随每次 render 重跑 → 一打字就把页面拽回去，
          // 所以走 effect + 一次性标志，滚完立刻把标志清掉。
          var attachFieldRef = React.useRef(null)
          React.useEffect(function () {
            if (!editor || editor.focusAttach !== true) return
            var node = attachFieldRef.current
            if (node && typeof node.scrollIntoView === 'function') {
              try { node.scrollIntoView({ block: 'center' }) } catch (e) { /* 滚不动不影响使用 */ }
            }
            setEditor(function (prev) { return prev && prev.focusAttach ? Object.assign({}, prev, { focusAttach: false }) : prev })
          }, [editor])

          /** 场景名 = 分组路径的第一段（`web/frontend` 属于场景 `web`）。 */
          function sceneOf(group) {
            var s = String(group == null ? '' : group)
            var i = s.indexOf('/')
            return i >= 0 ? s.slice(0, i) : s
          }
          /** 存的是**有效状态**（true=收起），不是翻转旧值：默认收起的卡片旧值是 undefined，
           *  翻一下算出来还是 true，第一次点击看不出任何变化，要点第二下才展开（用户 2026-10-16 实测）。 */
          function toggleCollapse(key, open) {
            setCollapsed(function (prev) {
              var next = Object.assign({}, prev)
              next[key] = open
              return next
            })
          }

          // 本页订阅当前层（0.21.2）：逐条开关的生效值与来源都跟着层走。
          var scopeState = useScopeLayer()
          /** 取数用的会话 id：全局层传空串（= 服务端按全局口径算）。 */
          function scopeSessionId() { return scopeIsSession() ? scopeState.sessionId : '' }
          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('rules-list', { sessionId: scopeSessionId() }).then(function (r) {
              if (r && r.ok) {
                // 合并式更新：只覆盖本页由 rules-list 驱动的字段，其余 state 键保持不变。
                // `anyLocked` / `activeScene` 必须一起合并 —— 它们此前**从没被写进 state**
                // （初始值里没有、这里也没搬），于是本页的写控件在场景锁定时根本没被禁用、
                // 两条横幅也永远不显示（2026-09-19 用户报的横幅问题，顺带修掉前者）。
                setData(function (prev) { return Object.assign({}, prev, {
                  loading: false, error: null,
                  rules: r.rules || [], scenes: r.scenes || [],
                  activeMode: r.activeMode === 'custom' ? 'custom' : 'all',
                  sceneMemory: r.sceneMemory || EMPTY_MEMORY,
                  stats: r.stats || EMPTY_STATS,
                  paths: r.paths || null,
                  warnings: Array.isArray(r.warnings) ? r.warnings : [],
                  anyLocked: r.anyLocked === true,
                  activeScene: r.activeScene || null,
                }) })
              } else {
                setData(function (prev) { return Object.assign({}, prev, { loading: false, error: translateError(t, r), rules: [], scenes: [], activeMode: 'all', sceneMemory: EMPTY_MEMORY, stats: EMPTY_STATS, warnings: [] }) })
              }
            }).catch(function (e) {
              setData(function (prev) { return Object.assign({}, prev, { loading: false, error: errMsg(e), rules: [], scenes: [], activeMode: 'all', sceneMemory: EMPTY_MEMORY, stats: EMPTY_STATS, warnings: [] }) })
            })
          }
          // 切层要重取：逐条记忆的生效值由服务端按 `sessionId` 投影（见 refresh）。
          // 同一层里进 / 退场景、清覆盖也会改投影（场景记忆预览、activeScene）→ 修订号一起进依赖。
          React.useEffect(function () { refresh() }, [scopeState.sessionId, scopeState.revision])

          // 成功提示自动消失（2.6s）：浮层只是「刚做完什么」的短暂回执，不该长期占屏。
          // 错误（ok === false）不自动清理，一直留到下一次操作把它替换掉。
          React.useEffect(function () {
            if (!result || result.ok !== true) return undefined
            var timer = setTimeout(function () { setResult(null) }, 2600)
            return function () { clearTimeout(timer) }
          }, [result])

          // ── 启用场景开关已移至「场景」页（ScenesPage）──

          // ── 记忆 CRUD ──
          function openCreate(sceneName) {
            /**
             * 默认落点 = 保留场景「全局」（`GLOBAL_SCENE`，与 48-slash.js 那份同名常量同值，
             * 服务端出处 `src/memories/constants.ts`）。
             *
             * 这里必须把"空"落成一个**具体名字**，不能留着 `''`：
             *   · 界面上 `''` 会被 `SourceSelect` 兜到第一项，看着是「全局」，但那是巧合；
             *   · `submitCreate` 的本地查重是按 `r.group` **精确比对**的，而全局桶里那些记忆
             *     的 `group` 是 `'global'` 而不是 `''` —— 留着空值就查不到，撞名要等到服务端
             *     才被拒（`error.rules.exists`），用户拿到的是报错而不是那颗确认弹窗。
             * 宿主侧两种写法等价（`rules-create` 自己把空 group 映射到 `global`），所以这里
             * 只是把它提前落定，不改变任何落盘结果。
             */
            setEditor(takeFormDraft('mem:create') || { mode: 'create', id: '', group: sceneName || GLOBAL_SCENE, name: '', description: '', body: '', form: 'flat', path: '', error: null, files: [], attachments: [] })
            setModal({ type: 'editor' })
          }
          function openEditor(rule, focusAttach) {
            if (busy) return
            setBusy(true); setResult(null)
            var draftKey = 'mem:edit:' + rule.id
            apiCall('rules-read', { id: rule.id }).then(function (res) {
              setBusy(false)
              if (res && res.ok && res.rule) {
                var rd = res.rule
                // 30 秒内重开同一条：把刚才关掉的那份填回来（磁盘那份的内容已经读出来了，
                // 但用户改过的字段以草稿为准，未改的字段两种路径读到的是一样的）。
                var draft = takeFormDraft(draftKey)
                // focusAttach 是"打开就替你把文件框点开"的一次性指令，重放它会凭空弹一次文件选择框。
                if (draft) draft = Object.assign({}, draft, { focusAttach: false, error: null })
                setEditor(draft || { mode: 'edit', id: rd.id, group: rd.group, name: rd.name, description: rd.description || '', body: rd.body || '', form: rd.form === 'bundle' ? 'bundle' : 'flat', path: rd.path || '', error: null, files: [], attachments: rd.attachments || [], focusAttach: focusAttach === true })
                setModal({ type: 'editor' })
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          // 关掉 ≠ 丢掉：只有这一条路存草稿（提交成功走 finishEditor，就地 setModal(null)）。
          function closeEditor() { if (editor) stashFormDraft(editor.mode === 'edit' ? 'mem:edit:' + editor.id : 'mem:create', editor); setModal(null) }
          // ── 导入记忆（.md / .zip；场景留空 = 保留场景「全局」）──
          function submitImport(files) {
            if (!files || !files.length) return
            setBusy(true)
            apiCall('rules-import', { scene: importScene, files: files }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                var names = res.imported || [], skipped = res.skipped || []
                var text = names.length ? t('memory.result.imported', { count: names.length, names: names.join('、') }) : t('import.none')
                if (skipped.length) text += ' · ' + t('import.skipped', { items: skipped.map(function (s) { return s.name + '（' + s.reason + '）' }).join('；') })
                // 导入会为引用的目录名补出场景记录（宿主回传 scenes）——必须告诉用户，
                // 否则「我的场景列表怎么多了一个」就是静默造数据。
                if (res.scenes && res.scenes.length) text += ' · ' + t('memory.import.scenesCreated', { names: res.scenes.join('、') })
                setResult({ ok: true, text: text }); refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          // ── bundle 附件（只有 bundle 有目录可放；flat 是单文件）──
          // `fmtBytes` 在模块作用域（与 ImportModal 共用）—— 别再在这里声明一份。
          function pickAttach() { if (attachRef.current) attachRef.current.click() }
          function onAttachPicked(ev) {
            var picked = Array.prototype.slice.call((ev.target && ev.target.files) || [])
            if (ev.target) ev.target.value = '' // 允许连续选中同一个文件
            if (!picked.length) return
            Promise.all(picked.map(function (f) {
              return f.arrayBuffer().then(function (buf) {
                return { name: String(f.name || ''), size: buf.byteLength, data: bytesToBase64(buf) }
              })
            })).then(function (entries) {
              var tooBig = entries.filter(function (e) { return e.size > ATTACH_MAX_BYTES })
              var keep = entries.filter(function (e) { return e.size <= ATTACH_MAX_BYTES })
              setEditor(function (prev) {
                var next = Object.assign({}, prev, { files: (prev.files || []).concat(keep) })
                // 超限的当场拦下（服务端还会再拦一次），其余照常加入
                if (tooBig.length) next.error = t('memory.attach.tooLarge', { name: tooBig[0].name, limit: ATTACH_MAX_MB })
                return next
              })
            }).catch(function (e) { setEditor(function (prev) { return Object.assign({}, prev, { error: errMsg(e) }) }) })
          }
          function dropPending(index) {
            setEditor(function (prev) {
              var next = (prev.files || []).slice()
              next.splice(index, 1)
              return Object.assign({}, prev, { files: next })
            })
          }
          function removeAttachment(name) {
            if (busy || !editor) return
            setBusy(true)
            apiCall('rules-detach', { id: editor.id, name: name }).then(function (res) {
              setBusy(false)
              if (res && res.ok) setEditor(function (prev) { return Object.assign({}, prev, { attachments: res.attachments || [] }) })
              else setEditor(function (prev) { return Object.assign({}, prev, { error: translateError(t, res) }) })
            }).catch(function (e) { setBusy(false); setEditor(function (prev) { return Object.assign({}, prev, { error: errMsg(e) }) }) })
          }
          /** 附件与记忆本体分两步：先存记忆，再传附件；附件失败只如实报错，不回滚已保存的记忆。 */
          function flushAttachments(id, files) {
            if (!files || !files.length) return Promise.resolve({ ok: true, empty: true })
            return apiCall('rules-attach', { id: id, files: files.map(function (f) { return { path: f.name, data: f.data } }) })
          }

          // （场景档案与当前模式的功能已移至 ScenesPage——「场景」页）

          // （场景建/删也已移至 ScenesPage；场景启停开关同）
          // ── 记忆回收站（rules-remove 移入 / rules-restore 恢复 / rules-trash-remove 永久删除）──
          // 清单加载与恢复/永久删除/批量都在共享 TrashModal（42-shared-ui.js）内部完成；
          // 本页只管开关弹窗（`trash` = true）与写操作后的数据重读。
          function openTrash() { setModal({ type: 'trash' }) }
          // ── 单条记忆启停（索引层开关，不改文件；停用的记忆仍留在磁盘上）──
          function toggleRule(rule) {
            if (busy) return
            setBusy(true); setResult(null)
            // 会话作用域（0.21.2）：会话层只改"本会话注入不注入"，索引里那条记录不动。
            if (scopeIsSession()) {
              var nextOn = rule.enabled === false
              scopeWriteFlag('memory', String(rule.id), nextOn, function () { return { ok: true } })
                .then(function (res) {
                  setBusy(false)
                  if (res && res.ok) { setResult({ ok: true, text: nextOn ? t('done.enabled', { name: rule.name }) : t('done.disabled', { name: rule.name }) }); refresh(true) }
                  else setResult({ ok: false, text: translateError(t, res) })
                })
                .catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
              return
            }
            apiCall('rules-toggle', { id: rule.id, enabled: rule.enabled === false }).then(function (res) {
              setBusy(false)
              // 回执动词表（REDESIGN §12.4）：两个方向各取字面量键，不合成三元选词。
              if (res && res.ok) { setResult({ ok: true, text: rule.enabled === false ? t('done.enabled', { name: rule.name }) : t('done.disabled', { name: rule.name }) }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          /**
           * 批量写 `rules[*].enabled`（记忆页页头、每个场景卡片共用的「全选 / 取消全选」）。
           *
           * 顺序提交而不是 Promise.all：宿主侧每次 toggle 都要重写索引文件，并发提交只是排队，
           * 徒增失败时的书写顺序；串行还能「失败即停」并如实报出中止位置。
           */
          /**
           * 批量启停记忆。`scope` 说明触发它的是哪一级按钮：`null` = 页头那颗（作用于当前筛选后
           * 的全部可见记忆），其它 = 某张场景卡的 key（`'s:' + 场景名`）。撤销条据此决定贴在哪里
           * —— 页头那颗的贴在搜索框下面，场景卡那颗的贴在那张卡上方。撤销条跟着**触发它的按钮**
           * 走，别让人回头找（用户裁定 2026-09-18）。
           */
          function setMemories(ids, on, scope) {
            var list = (ids || []).filter(function (id) { return !!id })
            if (!list.length) return
            // 操作前的开关：撤销要靠它逐条写回。传进来的这组本来就可能一半开一半关，
            // 所以不能只记「把 on 反过来」——那只在「原本全关」时才等价于撤销。
            var pre = list.map(function (id) { return { id: id, on: memoryOn(id) } }).filter(function (x) { return x.on !== on })
            setBusy(true); setResult(null)
            var done = 0
            var failed = null
            var chain = Promise.resolve()
            // 会话作用域（0.21.2）：会话层逐条写 `scope-set`，不碰索引 —— `rules-toggle` 改的是
            // 全局启停名单，用它承接批量按钮就是「本会话全关、别的对话一起被关了」（决策 10）。
            var writeOne = function (id, value) {
              return scopeIsSession()
                ? scopeWriteFlag('memory', String(id), value, function () { return { ok: true } })
                : apiCall('rules-toggle', { id: id, enabled: value })
            }
            list.forEach(function (id) {
              chain = chain.then(function () {
                if (failed) return null
                return writeOne(id, on).then(function (res) {
                  if (res && res.ok) done += 1
                  else failed = translateError(t, res)
                }).catch(function (e) { failed = errMsg(e) })
              })
            })
            chain.then(function () {
              setBusy(false)
              var action = t(on ? 'bulk.enabled' : 'bulk.disabled')
              // 成功那条用 `pre.length`（状态确实和目标不同的那些），不用 `done`（成功响应数）——
              // 选中一条本来就启用的记忆再启用一次，`done` 照样 +1，会和撤销条上的数字对不上。
              // 中止那条仍用 `done`：那时要答的是「已经写进去几条」，不是「本该改几条」。
              setResult(failed
                ? { ok: false, text: t('memory.bulk.partial', { action: action, count: done, error: failed }) }
                : { ok: true, text: t('bulk.done.memories', { action: action, count: pre.length, failed: 0 }) })
              // 全部成功、且确实改了东西才给撤销条（本来就在目标状态的条目不算）。
              if (!failed && pre.length) setUndo({
                text: t('undo.memories', {
                  action: action,
                  count: pre.length,
                  // `data.rules` 是刷新前那一帧的快照（= 操作前的值），加减本次改动数即操作后的启用数。
                  enabled: on ? enabledMemoryCount(data.rules) + pre.length : enabledMemoryCount(data.rules) - pre.length,
                }),
                items: pre,
                revert: function (item) { return writeOne(item.id, item.on) },
                scope: scope || null,
              })
              refresh(true)
            })
          }
          /** 一条记忆当前是否开启 —— 与行内 Switch 同一真相源（`rules[*].enabled`）。 */
          function memoryOn(id) {
            var rule = (data.rules || []).find(function (r) { return r.id === id })
            return !!(rule && rule.enabled !== false)
          }
          /** 撤销批量启停：按操作前的状态逐条写回。 */
          function undoMemories() {
            if (!undo) return
            var entry = undo
            setUndo(null); setBusy(true)
            runUndo(entry).then(function (failed) {
              setBusy(false)
              setResult(failed ? { ok: false, text: t('undo.failed', { count: failed }) } : { ok: true, text: t('undo.done') })
              refresh(true)
            })
          }
          /** 可批量切换的记忆 = 非被同名 bundle 覆盖的（与行内 Switch 同一条件）。 */
          function toggleableIds(rules) {
            return (rules || []).filter(function (r) { return r.shadowed !== true }).map(function (r) { return String(r.id) })
          }
          /** 传进来的一组记忆是否全部开着（决定二合一按钮显示哪一个文案）。 */
          function allMemoriesOn(rules) {
            var rows = (rules || []).filter(function (r) { return r.shadowed !== true })
            return rows.length > 0 && rows.every(function (r) { return r.enabled !== false })
          }

          /** 记忆存好后统一收尾：上传附件 → 关弹窗 → 报结果（附件失败不回滚记忆）。 */
          function finishEditor(id, name, pending, successKey, attachedKey) {
            return flushAttachments(id, pending).then(function (att) {
              setBusy(false)
              setModal(null); setEditor(null)
              if (att && att.ok === false) setResult({ ok: false, text: t('memory.result.attachFailed', { error: translateError(t, att) }) })
              else if (pending.length) setResult({ ok: true, text: t(attachedKey, { name: name, count: pending.length }) })
              else setResult({ ok: true, text: t(successKey, { name: name }) })
              refresh(true)
            })
          }
          /**
           * 记忆页「新增」的提交（用户 2026-10-14 第二轮）：**先问一句，再退号**。
           *
           * 服务端 `rules-create` 撞名是直接拒绝的（`error.rules.exists`），原先界面把这句话
           * 原样摆出来、让用户自己回去改名。现在改成：本地先查一遍**同一组**里的记忆（记忆 id
           * 是 `<场景>/<名>`，所以判据只看同组，跨场景同名是合法的、不该拦），撞上了就弹一个
           * 小窗说明"已有同名"，确认后用 `测（1）` 建 —— 名字在这一刻定死，落盘的就是界面上
           * 写着的那个，不再有"看着叫甲、落盘叫乙"。
           *
           * 本地查重不替代服务端那道闸：期间别人（或模型工具）建了一条同名，提交仍会被拒，
           * 那时照旧如实报错 —— 这里只是把常见情形做顺手，不是替服务端下判断。
           */
          function submitCreate() {
            var typed = String(editor.name || '').trim()
            var group = String(editor.group || '').trim()
            var taken = {}
            ;(data.rules || []).forEach(function (r) { if (String(r.group || '') === group) taken[String(r.name)] = true })
            var finalName = uniqueName(typed, taken)
            if (finalName !== typed) { setDupAsk({ name: typed, finalName: finalName }); return }
            createMemory(typed)
          }
          /** 真正落盘那一步（名字已定）。`name` 来自 `submitCreate` 或确认弹窗。 */
          function createMemory(name) {
            var payload = {
              group: String(editor.group || '').trim(),
              name: name,
              description: String(editor.description || '').trim(),
              body: editor.body || '',
              form: editor.form || 'flat',
            }
            var pending = editor.files || []
            setBusy(true)
            apiCall('rules-create', payload).then(function (res) {
              if (!res || !res.ok) {
                setBusy(false)
                setEditor(Object.assign({}, editor, { error: translateError(t, res) }))
                return null
              }
              var id = (res.rule && res.rule.id) || (payload.group ? payload.group + '/' + payload.name : payload.name)
              var doneName = (res.rule && (res.rule.id || res.rule.name)) || payload.name
              return finishEditor(id, doneName, pending, 'done.created', 'memory.result.createdAttached')
            }).catch(function (e) { setBusy(false); setEditor(Object.assign({}, editor, { error: errMsg(e) })) })
          }
          function submitUpdate() {
            var payload = {
              id: editor.id,
              name: String(editor.name || '').trim(),
              description: String(editor.description || '').trim(),
              body: editor.body || '',
              form: editor.form || 'flat',
            }
            var pending = editor.files || []
            setBusy(true)
            apiCall('rules-update', payload).then(function (res) {
              if (!res || !res.ok) {
                setBusy(false)
                setEditor(Object.assign({}, editor, { error: translateError(t, res) }))
                return null
              }
              var name = (res.rule && (res.rule.id || res.rule.name)) || payload.name
              return finishEditor(editor.id, name, pending, 'done.saved', 'memory.result.updatedAttached')
            }).catch(function (e) { setBusy(false); setEditor(Object.assign({}, editor, { error: errMsg(e) })) })
          }
          function submitDelete(rule) {
            setBusy(true)
            apiCall('rules-remove', { id: rule.id }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                setResult({ ok: true, text: t('memory.result.removed', { name: rule.name, trashId: res.trashId != null ? res.trashId : '' }) })
                refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          // ── 渲染 ──
          var stats = data.stats || EMPTY_STATS
          // 注入预算：宿主 rules-list 一直在返回 sceneMemory，但此前从未渲染 ——
          // 于是"超出预算、部分记忆没进提示词"对用户完全不可见。
          // 展示位 2026-10-12 搬到页头统计格（原来在工具条右侧，带一条 72px 进度条）；
          // 进度条随之下线，超限改由整格转错误色 + 标签补「已超限」表达。
          var memInfo = data.sceneMemory || EMPTY_MEMORY
          var memMax = Number(memInfo.maxBytes) || 0
          var memUsed = Number(memInfo.usedBytes) || 0
          var budgetOver = memMax > 0 && memUsed > memMax
          var droppedNames = React.useMemo(function () {
            return (memInfo.dropped || []).map(function (d) { return (d.scene ? d.scene + '/' : '') + d.name })
          }, [memInfo])
          var q = String(dq || '').toLowerCase()

          // 分桶 / 过滤 / 排序只在数据或（防抖后的）搜索词、场景筛选变化时重算（实现与理由
          // 见组件上方的 `memoryView`）：开关、弹窗、编辑器输入这些重渲染不再重扫全表。
          var view = React.useMemo(function () { return memoryView(data, q, sceneFilter) }, [data, q, sceneFilter])
          var buckets = view.buckets, order = view.order
          var sceneOptions = view.sceneOptions, sceneChoices = view.sceneChoices
          var filtering = view.filtering, visibleBuckets = view.visibleBuckets, hasAnyRule = view.hasAnyRule
          // 名称 = .md 文件名（单个路径段，不是路径）：用 segment 校验器，与宿主逐字对齐。
          // 中文等任意 Unicode 都合法（`站会流程` → `站会流程.md`）。
          // 未输入时不标红/不报「不合法」——一打开弹窗就飘红会让人以为中文名被拒；
          // 空值改由提交按钮的 disabled 兜住（见下方 disabled 表达式）。
          var editorNameInvalid = editor ? String(editor.name || '').trim() !== '' && !isValidSceneSegment(String(editor.name || '').trim()) : false
          var editorGroupInvalid = editor && editor.mode === 'create' ? String(editor.group || '').trim() !== '' && !isValidScenePath(String(editor.group || '').trim()) : false
          var editorDescLen = editor ? String(editor.description || '').length : 0
          /** 页头「全选 / 取消全选」的作用集 = 当前筛选后可见的、可切换的记忆。 */
          var bulkRules = React.useMemo(function () {
            var list = []
            visibleBuckets.forEach(function (n) { list = list.concat(buckets[n].rules) })
            return list
          }, [visibleBuckets, buckets])
          var bulkIds = toggleableIds(bulkRules)
          var bulkAllOn = allMemoriesOn(bulkRules)
          // 卡内行的顺序（「启用的排前面」）：在页面这一层算一次。**不能**放进 renderSceneCard ——
          // 那是个普通函数、按可见场景数被调用，在里面调 Hooks 会破坏 Hooks 调用序。
          // 行的 key 仍来自规则自己（见 renderRuleRow），未动。
          // 定序表整页一张（key 带上桶名，跨场景不撞）：开关当场不重排，刷新或重进这页才重新置顶。
          var memoryRank = useRank()
          var rowsByBucket = React.useMemo(function () {
            var map = {}
            visibleBuckets.forEach(function (n) {
              map[n] = rankedFirst(memoryRank, function (r) { return n + '|' + String(r.id || r.name) }, buckets[n].rules, function (r) { return r.enabled !== false; })
            })
            return map
          }, [visibleBuckets, buckets])

          /**
           * bundle 记忆的附件标记：回形针 + 个数，挂在名称旁那枚体积后面
           * （用户 2026-10-16：「一个图标加一个数字就行，在 145 B 旁边」，同日又要求
           * 去边框降噪 —— 所以它是 `.dsm-qty` 弱色文字，不再是描边胶囊）。
           *
           * 数量是宿主在 rules-list 里补的（`r.attach`，口径与注入给模型的附件清单逐字一致）；
           * 0 个附件也显示，这样"哪些 bundle 是空壳"一眼可见。两种状态都能点，点了直接开编辑
           * 弹窗并**滚到附件区**（不然这颗标记就只是块装饰）。`r.attach` 缺失 = 宿主没读到这个
           * 目录（索引残留）→ 什么都不显示，不谎报 0。
           */
          function attachTag(r, shadowed) {
            if (r.form !== 'bundle' || !r.attach) return null
            var n = r.attach.count
            var names = r.attach.names || []
            var extra = n > names.length ? t('memory.attach.more', { count: n - names.length }) : ''
            var title = n === 0
              ? t('memory.attach.tip.empty')
              : t('memory.attach.tip', { count: n, size: fmtBytes(r.attach.bytes), names: names.join(t('memory.attach.sep')) + extra })
            return React.createElement('button', {
              type: 'button',
              className: 'dsm-qty',
              disabled: busy || shadowed || anyLocked,
              title: title,
              key: 'attach',
              'aria-label': title,
              onClick: function () { openEditor(r, true) },
            }, React.createElement(PaperclipIcon, { size: 11 }), String(n))
          }

          /** 名称旁那一串量值（体积 · 附件数）：中间点分隔，缺件自动跳过（一件时不留孤点）。 */
          function qtyBits() {
            var list = Array.prototype.slice.call(arguments).filter(Boolean)
            if (!list.length) return null
            var out = []
            list.forEach(function (node, i) {
              if (i) out.push(React.createElement('span', { key: 'sep' + i, className: 'dsm-qty-sep' }, '·'))
              out.push(node)
            })
            return out
          }

          function renderRuleRow(r, sceneActive) {
            var shadowed = r.shadowed === true
            // shadowed = 存在同名 bundle，本条 flat 不会被加载；与文件名是否 kebab-case 无关——
            // 记忆名就是 .md 文件名，中文名同样可以在本页编辑 / 删除。
            var enabled = r.enabled !== false
            // 单条停用（索引层开关）优先于场景状态：原来只有 已启用/被覆盖/场景未启用 三个分支，
            // 单条停用的记忆会被误显示为「已启用」。
            var statusKey = shadowed ? 'status.shadowed' : !enabled ? 'memory.status.off' : sceneActive === false ? 'memory.status.sceneOff' : 'status.enabled'
            // 灰=不进上下文但不是故障（被遮蔽 / 本条停用 / 场景没启用），绿=这条真的会注入。
            var statusTone = shadowed || !enabled || sceneActive === false ? 'muted' : 'ok'
            // 「需要处理」只剩「被覆盖」一种：它看着是开的、实际不注入，必须在行上说出来。
            // 「场景未启用」不再占行内标签（用户 2026-10-15 两条一起提的）：分组卡头已经写着
            // 「未启用」，逐行复述是噪音；更要紧的是它原先会把**行首那颗状态点整颗吃掉** ——
            // 在同一场景里启用一条记忆，点当场消失，看着像这一行坏了。现在点照常画
            //（灰 = 不进上下文），原因留在 title 上。
            var attention = shadowed
            // 行 2 元信息（切片三移交的「tags 列清理」）：描述 / 多级分组路径 / 派生标记。
            // 附件计数不在这一行了 —— 它挪到名称旁与体积并排（见 attachTag）。
            //
            // 体积（`145 B`）2026-10-12 从这一行挪到了行 1 的名称旁（用户：「记忆的 145B 带
            // 边框然后加在名称旁边」）：它是这一行的"量值"，跟名称一样是**扫读**时先看的；
            // 挤在描述后面既容易被长描述挤掉，也读不出"多大"。同时删掉「bundle」那颗形态标签
            // （用户：「"bundle" 不用显示」）—— 形态由附件计数（`📎 N 个附件`）已经说清了，
            // 再来一个英文单词只是噪音。`memory.form.*` 两个键**仍然在用**（42 片回收站/导出
            // 里按 `'memory.form.' + …` 计算取词），别顺手删掉。
            var attachNode = attachTag(r, shadowed)
            var metaBits = [
              r.description ? React.createElement('span', { key: 'desc', className: 'dsm-listrow-meta-desc', title: r.description }, r.description) : null,
              r.group && r.group.indexOf('/') >= 0 ? React.createElement('span', { key: 'group', className: 'dsm-listrow-meta-info dsm-mono' }, r.group) : null,
              r.descriptionDerived ? React.createElement('span', { key: 'derived', className: 'dsm-listrow-meta-info' }, t('memory.derived')) : null,
            ]
            // 名称旁那颗体积：纯量值、不可点，所以是 span；等宽数字免得整列右缘跟着抖。
            var sizeTag = typeof r.bytes === 'number'
              ? React.createElement('span', {
                key: 'size',
                className: 'dsm-qty',
                title: t('memory.size.tip', { size: fmtBytes(r.bytes) }),
              }, fmtBytes(r.bytes))
              : null
            return React.createElement(ListRow, {
              key: r.id,
              // 会话作用域（0.21.2）：点 = **这一层**开不开（与开关同值）；「来源」只在开着时染色。
              // 全局层维持原来的状态词（场景里被关的那条仍说 sceneOff）。
              dots: attention ? [] : [(function () {
                var flag = scopeFlag('memory', String(r.id), enabled)
                var onHere = scopeIsSession() ? flag.value : statusKey === 'status.enabled'
                var titleKey = onHere ? 'status.enabled' : (scopeIsSession() ? 'memory.status.off' : statusKey)
                return React.createElement(StatusDot, { key: 'dot', tone: onHere ? 'ok' : 'idle', scoped: onHere && flag.scoped, title: t(titleKey) })
              })()],
              name: r.name,
              // 纯视图域的会话覆盖计数（0.21.2）：有几个对话单独拨过这一条记忆。
              // 与技能 / MCP 的真租约不同 —— 记忆没有要落地的运行态，文案因此分开。
              nameAfter: qtyBits(leaseTag({ t: t, domain: 'memory', key: String(r.id), runtime: false }), sizeTag, attachNode),
              tag: attention ? React.createElement(StatusTag, { tone: statusTone, text: t(statusKey) }) : null,
              meta: metaBits,
              extra: shadowed ? React.createElement('div', { className: 'dsm-rule-shadow-hint' }, t('memory.shadowed.hint')) : null,
              // 会话作用域（0.21.2）：会话层下这一格表示"本会话注入不注入它"；来源看行首那颗点。
              side: (function () {
                var flag = scopeFlag('memory', String(r.id), enabled)
                return React.createElement(Switch, { on: flag.value, scoped: flag.scoped, disabled: busy || shadowed || scopeWriteLocked(anyLocked), label: t('memory.enable') + ' ' + r.name, onClick: function () { toggleRule(r) } })
              })(),
              // 行内只留开关这一颗常驻控件（用户 2026-10-16：「记忆看起来很乱」→ 选定
              // 「编辑 / 删除收进 ⋯ 菜单」）：原先每行三颗、删除常年红描边，一屏六条就是
              // 六个红框。删除仍在菜单里用红字标出，但不再占行内的视觉重量。
              actions: [React.createElement(RowMenu, {
                key: 'menu',
                label: t('row.menu', { name: r.name }),
                items: [
                  // 「编辑」在锁定态**照常可点**（用户 2026-10-12：「场景锁定下改成子智能体、
                  // 提示词、记忆可以打开编辑页面，但是不能保存」）：只读地看一眼内容不该被锁挡住，
                  // 真正写盘的那一步（弹窗里的保存键）才置灰。其余会写盘的动作照旧置灰。
                  { key: 'edit', label: t('memory.edit'), disabled: busy || shadowed, onClick: function () { openEditor(r) } },
                  { key: 'delete', label: t('memory.delete'), danger: true, disabled: busy || shadowed || anyLocked, onClick: function () { setModal({ type: 'delete', rule: r }) } },
                ],
              })],
            })
          }

          function renderSceneCard(name) {
            var bucket = buckets[name]
            var meta = bucket.meta || { name: name, count: 0, active: true, shared: false, label: null }
            var isShared = meta.shared === true
            var isGlobal = meta.global === true || name === 'global'
            var isOrphan = name === '' && !bucket.meta
            // 默认展开与否跟着「这个场景启没启」走（用户 2026-10-16）：没启用的场景一屏摊开
            // 只是噪音，启用的那条才要一眼能改。用户手动点过的那一格以手动为准（表里有值），
            // 没点过（undefined）才按状态给默认 —— 所以切换启用场景时，其余卡片自己收回去。
            var openFlag = collapsed['s:' + name]
            var baseOpen = openFlag === undefined ? meta.active === true : openFlag !== true
            var open = baseOpen || !!q
            // 卡内「全选」的判据只算一次：同一份数组此前在这一行里被扫了五遍（两遍 allMemoriesOn
            // + 三遍 toggleableIds），每次重渲染都重来。
            var cardToggles = toggleableIds(bucket.rules)
            var cardAllOn = allMemoriesOn(bucket.rules)
            // 卡头的计数：`启用 / 总数`（与页头统计、技能页来源卡同一个读法）。
            var cardOn = bucket.rules.filter(function (r) { return r.enabled !== false }).length
            // 两种「不进上下文」要分开：游离记忆（没有归属场景）是**真问题**，用错误色；
            // 场景只是没启用是**正常状态**（同时只有一个场景在用），整块灰色置灰即可 ——
            // 此前两者共用一个红类，关着的场景一片红，读起来像出了错。
            var card = React.createElement('div', { key: 's:' + name, className: 'dsm-source' + (isOrphan ? ' dsm-rule-shadowed' : meta.active === false ? ' dsm-rule-off' : '') },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main dsm-source-head-stack', 'aria-expanded': open, onClick: function () { toggleCollapse('s:' + name, baseOpen) } },
                  React.createElement('span', { className: 'dsm-source-head-line' },
                    React.createElement('span', { className: 'dsm-source-title', title: sceneLabel(data.scenes, name) }, sceneLabel(data.scenes, name)),
                    React.createElement('span', { className: 'dsm-count dsm-count-tight' }, t('memory.scene.count', { on: cardOn, total: bucket.rules.length })),
                    isShared ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.shared')) : null,
                    isGlobal ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.global.tag')) : null,
                    isOrphan ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('memory.scene.orphan.tag')) : null,
                    meta.active === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null),
                  // 场景备注紧跟名称下面一行（用户 2026-10-16：「备注是显示在名称下面，就像图2一样」），
                  // 收着卡片时也照读 —— 它是"这是哪个场景"的一部分，不是展开后才有的细节。
                  // 挂在卡头左侧那一列里、不是整行之下：整行的话右侧按钮把它和名称隔开，读着像页脚。
                  isOrphan || !meta.description ? null : React.createElement('span', { className: 'dsm-source-desc' }, meta.description)),
                React.createElement('div', { className: 'dsm-source-actions' },
                  // 每个场景一张卡：卡内的「全选 / 取消全选」只作用于**这张卡里的**记忆
                  // —— 用户说的「记忆的不同场景都缺少全选清空」。
                  isOrphan || !bucket.rules.length ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: busy || scopeWriteLocked(anyLocked) || !cardToggles.length, onClick: function () { setMemories(cardToggles, !cardAllOn, 's:' + name) } }, bulkPair(cardAllOn ? t('bulk.unselectAll') : t('bulk.selectAll'), cardAllOn ? t('bulk.selectAll') : t('bulk.unselectAll'))),
                  // 卡内的「新建记忆」是写盘动作，锁定态必须置灰（用户 2026-10-12：
                  // 「场景锁定情况下新建记忆应该也是灰色的，不能点击」）—— 原先这里只看了 busy。
                  isOrphan ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || anyLocked, onClick: function () { openCreate(name) } }, t('memory.scene.new')))),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                isOrphan ? React.createElement('div', { className: 'dsm-source-note' }, t('memory.scene.orphan.hint')) : null,
                bucket.rules.length
                  // 表头已随列表行两行制拆除（REDESIGN §3.4 没有表头行；tags 列并入行 2 元信息）。
                  ? (rowsByBucket[name] || []).map(function (r) { return renderRuleRow(r, meta.active !== false) })
                  : React.createElement('div', { className: 'dsm-empty' }, t('memory.scene.empty'))) : null)
            // 这张卡里那颗「全选」的撤销条贴在这张卡上方 —— 它只作用于这张卡里的记忆，而页头
            // 那颗的撤销条在搜索框下面（见 content）。撤销条跟着**触发它的按钮**走。
            return React.createElement(React.Fragment, { key: 's:' + name },
              undo && undo.scope === 's:' + name ? React.createElement(UndoBar, { key: 'undo', undo: undo, busy: busy, t: t, onUndo: undoMemories, onClose: dismissUndo }) : null,
              card)
          }

          // D14 导出：可导出的记忆 = 索引里的规则，排除被同名 bundle 遮蔽的 flat
          // （它们不会被加载，导出去只会让人以为能用）。key 用**记忆 id**：
          // 服务端按 id 在索引里查真实文件路径（bundle 型必须这么做，见 planMemoryExport）。
          var exportableRules = React.useMemo(function () {
            return (data.rules || []).filter(function (r) { return r.shadowed !== true })
          }, [data.rules])
          /** 导出条目：按**场景**分组（记忆页的分组维度就是场景），组内给出名称 + 描述。 */
          function memoryExportItems() {
            var sceneMeta = {}
            ;(data.scenes || []).forEach(function (s) { sceneMeta[s.name] = s })
            return exportableRules.map(function (r) {
              var scene = sceneOf(r.group)
              var meta = sceneMeta[scene]
              var label = (meta && (meta.label || meta.name)) || scene || t('memory.scene.orphan')
              return { key: r.id, name: r.name, desc: r.description || '', group: label }
            })
          }
          function submitExport(names, outDir) {
            setExportState({ busy: true, result: null })
            apiCall('bundle-export', { kind: 'memories', names: names, outDir: outDir }).then(function (res) {
              if (res && res.ok) setExportState({ busy: false, result: { ok: true, text: exportResultText(t, res) } })
              else setExportState({ busy: false, result: { ok: false, text: translateError(t, res) } })
            }).catch(function (e) { setExportState({ busy: false, result: { ok: false, text: errMsg(e) } }) })
          }

          return React.createElement('section', { className: 'dsm-section' },
            // 页头一行化（REDESIGN §3 + §6）：新增(实底) · 导入 · 导出 · 回收站；统计内联。
            React.createElement(PageHead, {
              title: t('memory.title'),
              desc: t('memory.desc'),
              stats: [
                // 三格统一改成「标签 值/总」的比例口径（用户 2026-10-12：「改成记忆：1/4、
                // 场景：1/3、注入预算：*/131072 B」）：分母才是这一页真正要看的东西 ——
                // 「4 条记忆」答不了"有几条真在生效"，「3 个场景」也答不了"几个正开着"。
                // enabled / scenes 两个数服务端 rules-list 一直在给（stats.enabled / stats.scenes），
                // 之前只用了 total 与 scenes 两个字段，等于把答案丢了。
                [(stats.enabled || 0) + '/' + (stats.total || 0), t('memory.stat.total')],
                [(stats.scenes || 0) + '/' + (data.scenes || []).length, t('memory.stat.sceneCount')],
                // 注入预算本来就是"已用/上限"，与上面两格同形；超限整格转错误色。
                [memMax > 0 ? t('memory.budget.bytes', { used: memUsed, max: memMax }) : '—', budgetOver ? t('memory.budget.label') + ' · ' + t('memory.budget.over') : t('memory.budget.label'), budgetOver ? 'dsm-stat-over' : ''],
              ],
              actions: [
                React.createElement('button', { key: 'new', type: 'button', className: 'dsm-btn', disabled: busy || anyLocked, onClick: function () { openCreate(sceneFilter || '') } }, t('memory.btn.new')),
                React.createElement('button', { key: 'import', type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { setResult(null); setImportScene('global'); setModal({ type: 'import' }) } }, t('memory.import')),
                React.createElement('button', { key: 'export', type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || !exportableRules.length, onClick: function () { setResult(null); setExportState({ busy: false, result: null }) } }, t('export.memories')),
                // 「全选」从工具条搬到页头、紧挨回收站左侧（用户 2026-10-12：「全选移到回收站
                // 旁边」）。它管的是列表，但和「回收站」一样是**整页范围**的动作，跟其余页头键
                // 同排读起来才成组；留在工具条会把搜索行挤窄，而那一行现在要让给搜索框。
                React.createElement('button', { key: 'bulk', type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk', disabled: busy || scopeWriteLocked(anyLocked) || !bulkIds.length, onClick: function () { setMemories(bulkIds, !bulkAllOn, null) } }, bulkPair(bulkAllOn ? t('bulk.unselectAll') : t('bulk.selectAll'), bulkAllOn ? t('bulk.selectAll') : t('bulk.unselectAll'))),
                React.createElement('button', { key: 'trash', type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: openTrash }, t('memory.trash.open')),
              ],
            }),
            // 两条横幅（与 MCP / 技能 / 子智能体页同源、同位置、同顺序）：
            // 锁定时只留锁定那条 —— 冻结期间"改动会同步写进场景档案"是句空话，两条并排
            // 还会互相矛盾（用户 2026-09-19 指出：锁定时长的场景提示没必要出现）。
            anyLocked && !scopeIsSession() ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('lock.banner')) : null,
            // 会话层不显示（同 MCP 页）：本层开关写的是会话覆盖，不同步档案。
            (!anyLocked && sceneName && !scopeIsSession()) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('scene.switch.banner', { scene: sceneName })) : null,
            // 工具条（REDESIGN §3.3 + §6 备注，切片四换共享 Toolbar）：搜索 + 场景筛选住 children。
            // batch 槽已空 —— 「全选」上移页头（挨着回收站），预算上移统计格；空槽不传，
            // 免得渲染出一个没有内容的 .dsm-toolbar-batch 把搜索框往里挤。
            React.createElement(Toolbar, { key: 'filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', type: 'text', placeholder: t('memory.search.placeholder'), value: query, onChange: function (e) { setQuery(e.target.value) } }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, { options: sceneOptions, value: sceneFilter, onChange: setSceneFilter }))),
            memInfo.truncated ? React.createElement('p', { className: 'dsm-help' }, t('memory.budget.truncated')) : null,
            droppedNames.length ? React.createElement('p', { className: 'dsm-help' }, t('memory.budget.dropped', { names: droppedNames.join('、') })) : null,
            // 成功 / 失败统一走 Notice（成功浮层 2.6 秒自动消失，见上方 result 清理 effect；
            // 错误留在文档流里不自动消失——错误需要一直看得见）。
            React.createElement(Notice, { key: 'notice', kind: result && result.ok ? 'ok' : 'err', text: result && result.text }),
            // 服务端如实说出的"被跳过"清单：与 MCP / 技能页同口径，原样渲染服务端串，
            // 不进 DICT（它不是界面文案，是这一台机器上这份数据的实况）。
            (data.warnings || []).map(function (w, i) { return React.createElement(Notice, { key: 'warn-' + i, kind: 'warn', text: String(w) }) }),
            // 页头那颗「全选」的撤销条放在搜索框下面（就在这一行）；场景卡那颗的贴在那张卡上方
            // （见 renderSceneCard）。撤销条跟着**触发它的按钮**走。
            undo && undo.scope == null ? React.createElement(UndoBar, { key: 'undo', undo: undo, busy: busy, t: t, onUndo: undoMemories, onClose: dismissUndo }) : null,
            data.error ? React.createElement(Notice, { key: 'error', kind: 'err', text: String(data.error) }) : null,
            // 列表四态（REDESIGN §12.2，切片四）：加载 / 失败（EmptyState + 重试，只在完全没有
            // 旧数据时顶掉列表）/ 无结果（+ 清除筛选）/ 空 / 有数据（场景卡）。data.error 横幅
            // 照旧 —— 它同时承担「有缓存数据时的错误」与令牌没过两种渠道。
            data.loading && !hasAnyRule ? React.createElement(ListStates, { key: 'loading', t: t, state: 'loading' })
              : data.error && !hasAnyRule ? React.createElement(ListStates, { key: 'errstate', t: t, state: 'error', text: String(data.error), onRetry: function () { refresh() } })
                : visibleBuckets.length ? React.createElement('div', { key: 'scenes', className: 'dsm-sources' }, visibleBuckets.map(renderSceneCard))
                  : (q || sceneFilter) ? React.createElement(ListStates, { key: 'search', t: t, state: 'search', text: t('memory.empty.search'), onClearFilter: function () { setQuery(''); setSceneFilter('') } })
                    : React.createElement(ListStates, { key: 'empty', t: t, state: 'empty', text: t('memory.empty') }),
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'del', className: 'dsm-modal-sm', title: t('memory.delete.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.delete.desc', { name: modal.rule.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDelete(modal.rule) } }, t('memory.btn.delete.confirm')))) : null,
            modal && modal.type === 'import' ? React.createElement(ImportModal, {
              key: 'mimp', t: t, title: t('memory.import.title'), busy: busy, hint: t('upload.drop.mzip'),
              requirement: t('upload.req.mdzip'),
              requirementTitle: [t('upload.requirement.memory.1'), t('upload.requirement.memory.2'), t('upload.requirement.memory.3'), t('upload.requirement.memory.4')].join('\n'),
              // 「导入到场景」**只能选**（用户 2026-10-15：手输入口去掉；此前用的是可手输的
              // SceneCombo）。代价说清楚：`rules-import` 本来会为引用的目录名补出场景记录
              // （回传 `scenes`，界面用 `memory.import.scenesCreated` 如实告知），去掉手输之后
              // 要导入到一个全新场景，得先去「场景」页把它建出来。
              // 默认「全局」：`sceneLabel` 已把保留场景 global 映成「全局」，选项里排最前 ——
              // 也就是原来"留空 = 全局"那条语义，只是现在看得见、点得着。选项剔掉 `''`
              // （「未归属场景」那个游离桶）：那不是"新记忆该去的地方"（与编辑器同一口径）。
              extra: React.createElement('div', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, t('memory.import.scene')),
                React.createElement(SourceSelect, {
                  options: sceneChoices.filter(function (o) { return o.value !== '' }),
                  value: importScene,
                  ariaLabel: t('memory.import.scene'),
                  disabled: busy,
                  onChange: setImportScene,
                })),
              onClose: function () { setModal(null) },
              onSubmit: submitImport,
            }) : null,
            exportState ? React.createElement(ExportModal, {
              key: 'mexport', t: t, title: t('export.memories'),
              items: memoryExportItems(),
              busy: exportState.busy, result: exportState.result,
              onClose: function () { setExportState(null) },
              onSubmit: submitExport,
            }) : null,
            editor && modal && modal.type === 'editor' ? React.createElement(Modal, { key: 'editor', className: 'dsm-modal-compact', title: editor.mode === 'create' ? t('memory.create.title') : t('memory.edit.title'), closeLabel: t('btn.close'), onClose: closeEditor },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.group')),
                  /**
                   * 场景**只能选**，不能手输（用户 2026-10-14）。
                   *
                   * 除了"手输容易打错"，更硬的理由在宿主那一侧：`rules-create` 对非全局场景
                   * **要求它已经存在**（`error.rules.sceneNotFound`：「请先在「场景」页创建该场景」），
                   * 所以手输一个不存在的场景名除了换来一条报错之外没有别的结果。要新场景就去
                   * 场景页建 —— 那条路径本来就在，而且它还会把提示词绑定、启用集合一起配好。
                   *
                   * 「全局」是**选项里的一项**，不是"留空"：宿主把空 group 映射到保留场景
                   * `global`（`GLOBAL_SCENE`，恒常注入的真实场景）。所以默认值直接就是它，
                   * 底下那句「留空 = 全局」也一并删掉 —— 字段自己写着「全局」，那句话不再说明什么。
                   *
                   * 选项里剔掉 `''`（「未归属场景」那个游离桶）：那是给历史数据做清理用的分组，
                   * 不是"新记忆该去的地方"（那里的记忆不会被注入上下文）。
                   */
                  editor.mode === 'create'
                    ? React.createElement(SourceSelect, {
                      options: sceneChoices.filter(function (o) { return o.value !== '' }),
                      value: editor.group || '',
                      ariaLabel: t('memory.field.group'),
                      disabled: busy,
                      onChange: function (v) { setEditor(Object.assign({}, editor, { group: v })) },
                    })
                    : React.createElement('input', { className: 'dsm-control', value: editor.group || '', disabled: true, onChange: function () {} }),
                editorGroupInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('error.rules.invalidGroup')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.name')),
                  React.createElement('input', { className: 'dsm-control' + (editorNameInvalid ? ' dsm-rule-invalid' : ''), value: editor.name || '', placeholder: t('memory.field.name.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { name: e.target.value })) } }),
                  editorNameInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.name.invalid')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  // 字数计数与「描述」同一行、贴右缘（与 MCP 备注 / 人设与技能简介同款排版）——
                  // 以前它单起一行落在输入框下面，看着像是另一个字段。
                  React.createElement('div', { className: 'dsm-budget-meta' },
                    React.createElement('span', { className: 'dsm-label' }, t('memory.field.description')),
                    React.createElement('span', { className: 'dsm-char-count' + (editorDescLen > 500 ? ' dsm-char-over' : '') }, editorDescLen + ' / 500')),
                  React.createElement('input', { className: 'dsm-control', value: editor.description || '', placeholder: t('memory.field.description.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { description: e.target.value })) } })),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.body')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: editor.body || '', placeholder: t('memory.field.body.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { body: e.target.value })) } })),
                React.createElement('div', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.form')),
                  // flat / bundle 就两个值：分段按钮摊开、点击即切，不再依赖下拉（弹窗底部会被裁）。
                  React.createElement('div', { className: 'dsm-form-seg', role: 'group' },
                    RULE_FORM_OPTIONS.map(function (o) {
                      return React.createElement('button', { key: o.value, type: 'button', 'aria-pressed': (editor.form || 'flat') === o.value, onClick: function () { setEditor(Object.assign({}, editor, { form: o.value })) } }, o.label);
                    })),
                  editor.form === 'bundle'
                    ? React.createElement('div', { className: 'dsm-field', ref: attachFieldRef },
                      React.createElement('div', { className: 'dsm-budget-meta' },
                        React.createElement('span', { className: 'dsm-label' }, t('memory.field.attach')),
                        React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: pickAttach }, t('memory.attach.add'))),
                      React.createElement('input', { ref: attachRef, type: 'file', multiple: true, className: 'dsm-hidden-input', onChange: onAttachPicked }),
                      (editor.attachments || []).length || (editor.files || []).length
                        ? React.createElement('div', { className: 'dsm-attach-list' },
                          (editor.attachments || []).map(function (a) {
                            return React.createElement('div', { key: 'a:' + a.name, className: 'dsm-file', title: a.name },
                              React.createElement('span', { className: 'dsm-file-kind', 'aria-hidden': 'true' }, 'FILE'),
                              React.createElement('span', { className: 'dsm-file-name' }, a.name),
                              React.createElement('span', { className: 'dsm-file-meta' }, fmtBytes(a.size)),
                              React.createElement('button', { type: 'button', className: 'dsm-file-remove', disabled: busy, 'aria-label': t('memory.attach.remove') + ' ' + a.name, onClick: function () { removeAttachment(a.name) } }, '×'))
                          }),
                          (editor.files || []).map(function (f, i) {
                            return React.createElement('div', { key: 'p:' + i + ':' + f.name, className: 'dsm-file', title: f.name },
                              React.createElement('span', { className: 'dsm-file-kind', 'aria-hidden': 'true' }, 'NEW'),
                              React.createElement('span', { className: 'dsm-file-name' }, f.name),
                              React.createElement('span', { className: 'dsm-file-meta' }, fmtBytes(f.size) + ' · ' + t('memory.attach.pending')),
                              React.createElement('button', { type: 'button', className: 'dsm-file-remove', disabled: busy, 'aria-label': t('memory.attach.remove') + ' ' + f.name, onClick: function () { dropPending(i) } }, '×'))
                          }))
                        : null)
                    : null),
                editor.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(editor.error)) : null),
              // 锁定态把「为什么保存键是灰的」写在弹窗里：编辑页能打开（看内容是只读的），
              // 但写盘这一步被冻结闸挡住 —— 只说结果不说原因，用户会以为界面坏了。
              anyLocked ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('scenes.lock.blockedEdit')) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || anyLocked || editorNameInvalid || editorGroupInvalid || editorDescLen > 500 || !String(editor.name || '').trim() || !String(editor.body || '').trim(), onClick: editor.mode === 'create' ? submitCreate : submitUpdate }, editor.mode === 'create' ? t('memory.btn.create') : t('memory.btn.save')))) : null,
            // 场景建/删/档案弹窗已移至「场景」页（ScenesPage）。
            // 记忆回收站：本页那一个（42-shared-ui.js 的 TrashModal，domain = memories）。
            // 记忆域的备注（场景 / 形态 / 字节数 / 删除时间）在组件内部按同一条口径拼装。
            modal && modal.type === 'trash' ? React.createElement(TrashModal, {
              key: 'trash',
              t: t,
              domain: 'memories',
              onClose: function () { setModal(null) },
              onReload: function () { refresh(true) },
            }) : null,
            // 「已存在同名记忆」小窗叠在编辑弹窗之上（`Modal` 自带 gateModalDepth 计数，
            // 叠弹窗是既有形态）。取消 → 回到编辑弹窗改名字，编辑器里的内容一个字都不动。
            dupAsk ? React.createElement(DupNameDialog, {
              key: 'dup-name', t: t, kind: t('dup.kind.memory'),
              name: dupAsk.name, finalName: dupAsk.finalName, action: 'create',
              busy: busy,
              onCancel: function () { setDupAsk(null) },
              onConfirm: function () { setDupAsk(null); createMemory(dupAsk.finalName) },
            }) : null)
        }