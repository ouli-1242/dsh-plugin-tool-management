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
          var imps = React.useState('')
          var importScene = imps[0], setImportScene = imps[1]
          // 新建场景弹窗与场景建/删已移至「场景」页（ScenesPage）。
          // 记忆回收站：列表在打开弹窗时按需拉取（rules-trash-list）。
          var trs = React.useState({ loading: false, error: null, entries: [] })
          var trash = trs[0], setTrash = trs[1]
          // D14：导出弹窗的状态（busy + 结果）。刻意不复用本页的 `result`：
          // 那个是页面级回执（会自动消失），导出结果只该出现在弹窗里。
          var exs = React.useState(null)
          var exportState = exs[0], setExportState = exs[1]
          var flipRef = React.useRef(null)
          useFlipReorder(flipRef)
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
          function toggleCollapse(key) {
            setCollapsed(function (prev) {
              var next = Object.assign({}, prev)
              next[key] = !next[key]
              return next
            })
          }

          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('rules-list', {}).then(function (r) {
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
          React.useEffect(function () { refresh() }, [])

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
            setEditor({ mode: 'create', id: '', group: sceneName || '', name: '', description: '', body: '', form: 'flat', path: '', error: null, files: [], attachments: [] })
            setModal({ type: 'editor' })
          }
          function openEditor(rule, focusAttach) {
            if (busy) return
            setBusy(true); setResult(null)
            apiCall('rules-read', { id: rule.id }).then(function (res) {
              setBusy(false)
              if (res && res.ok && res.rule) {
                var rd = res.rule
                setEditor({ mode: 'edit', id: rd.id, group: rd.group, name: rd.name, description: rd.description || '', body: rd.body || '', form: rd.form === 'bundle' ? 'bundle' : 'flat', path: rd.path || '', error: null, files: [], attachments: rd.attachments || [], focusAttach: focusAttach === true })
                setModal({ type: 'editor' })
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          function closeEditor() { setModal(null) }
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
          // 此前删除后只能看到一句"回收站 ID"，界面上无法恢复；这里把入口补齐。
          function loadTrash() {
            setTrash({ loading: true, error: null, entries: [] })
            apiCall('rules-trash-list', {}).then(function (res) {
              if (res && res.ok) setTrash({ loading: false, error: null, entries: res.entries || [] })
              else setTrash({ loading: false, error: translateError(t, res), entries: [] })
            }).catch(function (e) { setTrash({ loading: false, error: errMsg(e), entries: [] }) })
          }
          function openTrash() { setModal({ type: 'trash' }); loadTrash() }
          function submitRestore(entry) {
            if (busy) return
            setBusy(true)
            apiCall('rules-restore', { trashId: entry.trashId }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                setResult({ ok: true, text: t('memory.result.restored', { name: entry.name }) })
                refresh(true)
              } else setTrash(Object.assign({}, trash, { error: translateError(t, res) }))
            }).catch(function (e) { setBusy(false); setTrash(Object.assign({}, trash, { error: errMsg(e) })) })
          }
          function submitTrashDelete(entry) {
            if (busy) return
            setBusy(true)
            apiCall('rules-trash-remove', { trashId: entry.trashId }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setResult({ ok: true, text: t('memory.result.trashRemoved', { name: entry.name }) })
                setModal({ type: 'trash' })
                loadTrash()
              } else setTrash(Object.assign({}, trash, { error: translateError(t, res) }))
            }).catch(function (e) { setBusy(false); setTrash(Object.assign({}, trash, { error: errMsg(e) })) })
          }
          // ── 单条记忆启停（索引层开关，不改文件；停用的记忆仍留在磁盘上）──
          function toggleRule(rule) {
            if (busy) return
            setBusy(true); setResult(null)
            apiCall('rules-toggle', { id: rule.id, enabled: rule.enabled === false }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('memory.result.toggled', { name: rule.name }) }); refresh(true) }
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
            list.forEach(function (id) {
              chain = chain.then(function () {
                if (failed) return null
                return apiCall('rules-toggle', { id: id, enabled: on }).then(function (res) {
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
                revert: function (item) { return apiCall('rules-toggle', { id: item.id, enabled: item.on }) },
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
          function submitCreate() {
            var payload = {
              group: String(editor.group || '').trim(),
              name: String(editor.name || '').trim(),
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
              var name = (res.rule && (res.rule.id || res.rule.name)) || payload.name
              return finishEditor(id, name, pending, 'memory.result.created', 'memory.result.createdAttached')
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
              return finishEditor(editor.id, name, pending, 'memory.result.updated', 'memory.result.updatedAttached')
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
          var memInfo = data.sceneMemory || EMPTY_MEMORY
          var memMax = Number(memInfo.maxBytes) || 0
          var memUsed = Number(memInfo.usedBytes) || 0
          var budgetOver = memMax > 0 && memUsed > memMax
          var budgetPct = memMax > 0 ? Math.min(100, Math.round((memUsed / memMax) * 100)) : 0
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
          // 行的 key 与 data-flip-* 仍来自规则自己（见 renderRuleRow），未动。
          var rowsByBucket = React.useMemo(function () {
            var map = {}
            visibleBuckets.forEach(function (n) {
              map[n] = enabledFirst(buckets[n].rules, function (r) { return r.enabled !== false; })
            })
            return map
          }, [visibleBuckets, buckets])

          /**
           * bundle 记忆的「N 个附件」标签（用户裁定 2026-09-17）。
           *
           * 形态归「bundle」那颗标签，**内容归这一颗** —— 两者语义不同，挤进一个框里中文下会到 7 个字。
           * 数量是宿主在 rules-list 里补的（`r.attach`，口径与注入给模型的附件清单逐字一致）。
           * 0 个附件也显示（灰色），这样"哪些 bundle 是空壳"一眼可见；两种状态都能点，
           * 点了直接开编辑弹窗并**滚到附件区**（不然这颗标签就只是块装饰）。
           * `r.attach` 缺失 = 宿主没读到这个目录（索引残留）→ 什么都不显示，不谎报 0。
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
              className: 'dsm-tag dsm-tag-attach' + (n === 0 ? ' dsm-tag-attach-empty' : ''),
              disabled: busy || shadowed || anyLocked,
              title: title,
              'aria-label': title,
              onClick: function () { openEditor(r, true) },
            }, React.createElement(PaperclipIcon, { size: 11 }), t(countKey('memory.attach.count', n), { count: n }))
          }

          function renderRuleRow(r, sceneActive) {
            var shadowed = r.shadowed === true
            // shadowed = 存在同名 bundle，本条 flat 不会被加载；与文件名是否 kebab-case 无关——
            // 记忆名就是 .md 文件名，中文名同样可以在本页编辑 / 删除。
            var enabled = r.enabled !== false
            // 单条停用（索引层开关）优先于场景状态：原来只有 已启用/被覆盖/场景未启用 三个分支，
            // 单条停用的记忆会被误显示为「已启用」。
            var statusKey = shadowed ? 'status.shadowed' : !enabled ? 'memory.status.off' : sceneActive === false ? 'memory.status.sceneOff' : 'status.enabled'
            var statusCls = shadowed ? 'dsm-shadowed' : (!enabled || sceneActive === false) ? 'dsm-disabled' : 'dsm-enabled'
            return React.createElement('div', { key: r.id, className: 'dsm-row', 'data-flip-key': r.id, 'data-flip-on': enabled ? '1' : '0' },
              React.createElement('div', { className: 'dsm-main' },
                React.createElement('div', { className: 'dsm-name' }, r.name),
                React.createElement('div', { className: 'dsm-note' }, r.description || ''),
                shadowed ? React.createElement('div', { className: 'dsm-rule-shadow-hint' }, t('memory.shadowed.hint')) : null),
              React.createElement('div', { className: 'dsm-tags' },
                r.group && r.group.indexOf('/') >= 0 ? React.createElement('span', { className: 'dsm-tag' }, r.group) : null,
                r.form === 'bundle' ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.form.bundle')) : null,
                attachTag(r, shadowed),
                r.descriptionDerived ? React.createElement('span', { className: 'dsm-tag' }, t('memory.derived')) : null),
              React.createElement('div', { className: 'dsm-status ' + statusCls }, t(statusKey)),
              React.createElement('div', { className: 'dsm-row-actions' },
                React.createElement(Switch, { on: enabled, disabled: busy || shadowed || anyLocked, label: t('memory.enable') + ' ' + r.name, onClick: function () { toggleRule(r) } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || shadowed || anyLocked, onClick: function () { openEditor(r) } }, t('memory.edit')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy || shadowed || anyLocked, onClick: function () { setModal({ type: 'delete', rule: r }) } }, t('memory.delete'))))
          }

          function renderSceneCard(name) {
            var bucket = buckets[name]
            var meta = bucket.meta || { name: name, count: 0, active: true, shared: false, label: null }
            var isShared = meta.shared === true
            var isGlobal = meta.global === true || name === 'global'
            var isOrphan = name === '' && !bucket.meta
            var open = !collapsed['s:' + name]
            // 卡内「全选」的判据只算一次：同一份数组此前在这一行里被扫了五遍（两遍 allMemoriesOn
            // + 三遍 toggleableIds），每次重渲染都重来。
            var cardToggles = toggleableIds(bucket.rules)
            var cardAllOn = allMemoriesOn(bucket.rules)
            // 两种「不进上下文」要分开：游离记忆（没有归属场景）是**真问题**，用错误色；
            // 场景只是没启用是**正常状态**（同时只有一个场景在用），整块灰色置灰即可 ——
            // 此前两者共用一个红类，关着的场景一片红，读起来像出了错。
            var card = React.createElement('div', { key: 's:' + name, className: 'dsm-source' + (isOrphan ? ' dsm-rule-shadowed' : meta.active === false ? ' dsm-rule-off' : '') },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: function () { toggleCollapse('s:' + name) } },
                  React.createElement('span', { className: 'dsm-source-title', title: sceneLabel(data.scenes, name) }, sceneLabel(data.scenes, name)),
                  React.createElement('span', { className: 'dsm-count' }, t('memory.scene.count', { count: bucket.rules.length })),
                  isShared ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.shared')) : null,
                  isGlobal ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.global.tag')) : null,
                  isOrphan ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('memory.scene.orphan.tag')) : null,
                  meta.active === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null,
                  isOrphan ? null : React.createElement('span', { className: 'dsm-note' }, meta.description || '')),
                React.createElement('div', { className: 'dsm-source-actions' },
                  // 每个场景一张卡：卡内的「全选 / 取消全选」只作用于**这张卡里的**记忆
                  // —— 用户说的「记忆的不同场景都缺少全选清空」。
                  isOrphan || !bucket.rules.length ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: busy || anyLocked || !cardToggles.length, onClick: function () { setMemories(cardToggles, !cardAllOn, 's:' + name) } }, bulkPair(cardAllOn ? t('bulk.unselectAll') : t('bulk.selectAll'), cardAllOn ? t('bulk.selectAll') : t('bulk.unselectAll'))),
                  isOrphan ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { openCreate(name) } }, t('memory.scene.new')))),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                isOrphan ? React.createElement('div', { className: 'dsm-source-note' }, t('memory.scene.orphan.hint')) : null,
                bucket.rules.length
                  ? React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'dsm-table-head' },
                      React.createElement('span', null, t('memory.table.name')),
                      React.createElement('span', null, t('memory.table.tags')),
                      React.createElement('span', null, t('memory.table.status')),
                      React.createElement('span', null, '')),
                    (rowsByBucket[name] || []).map(function (r) { return renderRuleRow(r, meta.active !== false) }))
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
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('memory.title'))),
                React.createElement('p', { className: 'dsm-desc' }, t('memory.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, busy || data.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { openCreate(sceneFilter || '') } }, t('memory.btn.new')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { setResult(null); setImportScene(''); setModal({ type: 'import' }) } }, t('memory.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || !exportableRules.length, onClick: function () { setResult(null); setExportState({ busy: false, result: null }) } }, t('export.memories')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: openTrash }, t('memory.trash.open')),
                // 列表级动作与页头其余动作同栏（用户 2026-09-17 裁定）：作用集 = 当前筛选后的可见记忆。
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk', disabled: busy || anyLocked || !bulkIds.length, onClick: function () { setMemories(bulkIds, !bulkAllOn, null) } }, bulkPair(bulkAllOn ? t('bulk.unselectAll') : t('bulk.selectAll'), bulkAllOn ? t('bulk.selectAll') : t('bulk.unselectAll'))))),
            // 两条横幅（与 MCP / 技能 / 子智能体页同源、同位置、同顺序）：
            // 锁定时只留锁定那条 —— 冻结期间"改动会同步写进场景档案"是句空话，两条并排
            // 还会互相矛盾（用户 2026-09-19 指出：锁定时长的场景提示没必要出现）。
            anyLocked ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('lock.banner')) : null,
            (!anyLocked && sceneName) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('scene.switch.banner', { scene: sceneName })) : null,
            React.createElement('div', { className: 'dsm-summary' },
              React.createElement('div', { key: 'total', className: 'dsm-stat' }, React.createElement('strong', null, stats.total || 0), t('memory.stat.total')),
              React.createElement('div', { key: 'scenes', className: 'dsm-stat' }, React.createElement('strong', null, (data.scenes || []).length), t('memory.stat.sceneCount')),
              React.createElement('div', { key: 'active', className: 'dsm-stat' }, React.createElement('strong', null, stats.scenes || 0), t('memory.stat.scenes'))),
            memMax > 0 ? React.createElement('div', { className: 'dsm-rule-budget' },
              React.createElement('div', { className: 'dsm-budget-meta' },
                React.createElement('span', { className: 'dsm-label' }, t('memory.budget.label')),
                React.createElement('span', { className: budgetOver ? 'dsm-budget-over-text' : 'dsm-char-count' },
                  t('memory.budget.bytes', { used: memUsed, max: memMax }) + (budgetOver ? ' · ' + t('memory.budget.over') : ''))),
              React.createElement('div', { className: 'dsm-budget-bar', role: 'progressbar', 'aria-valuenow': budgetPct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t('memory.budget.label') },
                React.createElement('div', { className: 'dsm-budget-fill' + (budgetOver ? ' dsm-budget-over' : ''), style: { width: budgetPct + '%' } })),
              memInfo.truncated ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.budget.truncated')) : null,
              droppedNames.length ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.budget.dropped', { names: droppedNames.join('、') })) : null) : null,
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', type: 'text', placeholder: t('memory.search.placeholder'), value: query, onChange: function (e) { setQuery(e.target.value) } }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, { options: sceneOptions, value: sceneFilter, onChange: setSceneFilter }))),
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
            data.loading && !hasAnyRule ? React.createElement('div', { key: 'loading', className: 'dsm-empty' }, t('memory.loading'))
              : visibleBuckets.length ? React.createElement('div', { key: 'scenes', className: 'dsm-sources', ref: flipRef }, visibleBuckets.map(renderSceneCard))
              : React.createElement('div', { key: 'empty', className: 'dsm-empty' }, q || sceneFilter ? t('memory.empty.search') : t('memory.empty')),
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'del', title: t('memory.delete.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.delete.desc', { name: modal.rule.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDelete(modal.rule) } }, t('memory.btn.delete.confirm')))) : null,
            modal && modal.type === 'import' ? React.createElement(ImportModal, {
              key: 'mimp', t: t, title: t('memory.import.title'), busy: busy,
              requirements: [t('upload.requirement.memory.1'), t('upload.requirement.memory.2'), t('upload.requirement.memory.3'), t('upload.requirement.memory.4')],
              extra: React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, t('memory.import.scene')),
                React.createElement('input', { className: 'dsm-control', value: importScene, placeholder: t('memory.scene.global.hint'), onChange: function (e) { setImportScene(e.target.value) } })),
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
            editor && modal && modal.type === 'editor' ? React.createElement(Modal, { key: 'editor', className: 'dsm-modal-wide', title: editor.mode === 'create' ? t('memory.create.title') : t('memory.edit.title'), closeLabel: t('btn.close'), onClose: closeEditor },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.group')),
                  editor.mode === 'create'
                    ? React.createElement(SceneCombo, {
                      options: sceneChoices,
                      value: editor.group || '',
                      placeholder: t('memory.field.group.placeholder'),
                      browseLabel: t('memory.scene.browse'),
                      label: t('memory.field.group'),
                      disabled: busy,
                      invalid: editorGroupInvalid,
                      onChange: function (v) { setEditor(Object.assign({}, editor, { group: v })) },
                    })
                    : React.createElement('input', { className: 'dsm-control', value: editor.group || '', disabled: true, onChange: function () {} }),
                editor.mode === 'create'
                  ? React.createElement('p', { className: 'dsm-help' }, t('memory.field.group.hint'))
                  : null,
                editorGroupInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('error.rules.invalidGroup')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.name')),
                  React.createElement('input', { className: 'dsm-control' + (editorNameInvalid ? ' dsm-rule-invalid' : ''), value: editor.name || '', placeholder: t('memory.field.name.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { name: e.target.value })) } }),
                  editorNameInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.name.invalid')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.description')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: editor.description || '', placeholder: t('memory.field.description.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { description: e.target.value })) } }),
                  React.createElement('div', { className: 'dsm-char-count' + (editorDescLen > 500 ? ' dsm-char-over' : '') }, editorDescLen + ' / 500')),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.body')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: editor.body || '', placeholder: t('memory.field.body.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { body: e.target.value })) } })),
                React.createElement('div', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.form')),
                  React.createElement(SourceSelect, { options: RULE_FORM_OPTIONS, value: editor.form || 'flat', onChange: function (v) { setEditor(Object.assign({}, editor, { form: v })) } }),
                  editor.form === 'bundle'
                    ? React.createElement('div', { className: 'dsm-field', ref: attachFieldRef },
                      React.createElement('span', { className: 'dsm-label' }, t('memory.field.attach')),
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
                        : React.createElement('p', { className: 'dsm-help' }, t('memory.attach.empty')),
                      React.createElement('div', { className: 'dsm-attach-actions' },
                        React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: pickAttach }, t('memory.attach.add')),
                        React.createElement('span', { className: 'dsm-help' }, t('memory.attach.hint'))))
                    : React.createElement('p', { className: 'dsm-help' }, t('memory.attach.flat'))),
                editor.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(editor.error)) : null),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || editorNameInvalid || editorGroupInvalid || editorDescLen > 500 || !String(editor.name || '').trim() || !String(editor.body || '').trim(), onClick: editor.mode === 'create' ? submitCreate : submitUpdate }, editor.mode === 'create' ? t('memory.btn.create') : t('memory.btn.save')))) : null,
            // 场景建/删/档案弹窗已移至「场景」页（ScenesPage）。
            modal && modal.type === 'trash' ? React.createElement(Modal, { key: 'trash', wide: true, title: t('memory.trash.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              trash.loading ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
                : React.createElement(React.Fragment, null,
                  trash.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(trash.error)) : null,
                  trash.entries.length
                    ? React.createElement(React.Fragment, null,
                      React.createElement('div', { className: 'dsm-count' }, t('memory.trash.count', { count: trash.entries.length })),
                      React.createElement('div', { className: 'dsm-trash-box' }, trash.entries.map(function (entry) {
                        return React.createElement('div', { key: entry.trashId, className: 'dsm-trash-item' },
                          React.createElement('div', { className: 'dsm-trash-main' },
                            React.createElement('div', { className: 'dsm-name' }, entry.name),
                            React.createElement('div', { className: 'dsm-note' },
                              sceneLabel(data.scenes, entry.group) + ' · ' + t('memory.form.' + (entry.form === 'bundle' ? 'bundle' : 'flat')) + ' · ' + entry.bytes + ' B · '
                              + t('memory.trash.deletedAt', { time: entry.deletedAt ? new Date(entry.deletedAt).toLocaleString() : '' }))),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { submitRestore(entry) } }, t('memory.trash.restore')),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'trash-delete', entry: entry }) } }, t('memory.trash.purge')))
                      })))
                    : React.createElement('div', { className: 'dsm-empty' }, t('memory.trash.empty')))) : null,
            modal && modal.type === 'trash-delete' ? React.createElement(Modal, { key: 'trash-delete', title: t('memory.trash.confirmTitle'), closeLabel: t('btn.close'), onClose: function () { setModal({ type: 'trash' }) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.trash.confirmDesc', { name: modal.entry.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitTrashDelete(modal.entry) } }, t('memory.trash.purge')))) : null)
        }