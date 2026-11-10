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
                setEditor(draft || { mode: 'edit', id: rd.id, group: rd.group, name: rd.name, description: rd.description || '', body: rd.body || '', form: rd.form === 'bundle' ? 'bundle' : 'flat', path: rd.path || '', error: null, files: [], attachments: rd.attachments || [], focusAttach: focusAttach === true, stamp: res.stamp })
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
          /**
           * 页头「全部关闭」：把各会话 / 工作区 / 场景里单独开着的记忆一并停掉。
           * 只改全局索引停不到别的对话 —— 那些是各层自己的认领，得走全部关闭 op 清掉。
           */
          function stopAllMemories() {
            var keys = scopeLeaseKeys('memory')
            if (!keys.length) return
            setBusy(true); setResult(null)
            apiCall('scope-stop-now', { domain: 'memory', keys: keys }).then(function (res) {
              setBusy(false)
              if (res && res.ok === false) { setResult({ ok: false, text: translateError(t, res) }); return }
              if (res && res.warnings && res.warnings.length) { setResult({ ok: false, text: res.warnings.join('；') }); return }
              setResult({ ok: true, text: t('scope.stopAll.done', { count: keys.length }) })
              // 本地摘掉租约：页头按钮与行内「单独设置」徽章立刻消失，不重拉整层。
              scopeForgetLeases('memory', keys)
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /** 单条记忆的「全部关闭」：清掉各对话 / 工作区单独打开它的覆盖，全局启停不动。 */
          function stopOneMemory(rule) {
            var id = String(rule.id)
            setBusy(true); setResult(null)
            apiCall('scope-stop-now', { domain: 'memory', key: id }).then(function (res) {
              setBusy(false)
              if (res && res.ok === false) { setResult({ ok: false, text: translateError(t, res) }); return }
              setResult({ ok: true, text: t('scope.unifiedClose.viewDone', { name: rule.name || id }) })
              scopeForgetLeases('memory', [id])
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
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
          function submitUpdate(force) {
            var payload = {
              id: editor.id,
              name: String(editor.name || '').trim(),
              description: String(editor.description || '').trim(),
              body: editor.body || '',
              form: editor.form || 'flat',
            }
            // 并发编辑判据：打开编辑器时读到的那份指纹。`force` = 用户明确选择覆盖。
            if (!force && editor.stamp) payload.expectedStamp = editor.stamp
            var pending = editor.files || []
            setBusy(true)
            apiCall('rules-update', payload).then(function (res) {
              if (!res || !res.ok) {
                setBusy(false)
                // 冲突不能只报一句错：文件在别处被改过，用户需要「重新加载 / 覆盖保存」两条出路。
                if (res && res.code === 'stale-write') setEditor(Object.assign({}, editor, { error: t('stale.write.conflict'), stale: true }))
                else setEditor(Object.assign({}, editor, { error: translateError(t, res) }))
                return null
              }
              var name = (res.rule && (res.rule.id || res.rule.name)) || payload.name
              return finishEditor(editor.id, name, pending, 'done.saved', 'memory.result.updatedAttached')
            }).catch(function (e) { setBusy(false); setEditor(Object.assign({}, editor, { error: errMsg(e) })) })
          }
          /** 冲突后的「重新加载」：丢掉本地改动，重读磁盘那一份（连同新指纹）。 */
          function reloadEditor() {
            if (!editor || editor.mode !== 'edit') return
            setBusy(true)
            apiCall('rules-read', { id: editor.id }).then(function (res) {
              setBusy(false)
              if (res && res.ok && res.rule) {
                var rd = res.rule
                setEditor({ mode: 'edit', id: rd.id, group: rd.group, name: rd.name, description: rd.description || '', body: rd.body || '', form: rd.form === 'bundle' ? 'bundle' : 'flat', path: rd.path || '', error: null, files: [], attachments: rd.attachments || [], stamp: res.stamp })
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
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
                  // 「全部关闭」放在最后（删除下面）：它是停机动作（用户 2026-11-06）。
                  ...(scopeLeaseCount('memory', String(r.id)) > 0 ? [{ key: 'stop', label: t('scope.unifiedClose'), danger: true, disabled: busy || scopeWriteLocked(anyLocked), onClick: function () { setModal({ type: 'stop', rule: r }) } }] : []),
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

          // ── 自主记忆（agent 自己学的那一半）──────────────────────────────────
          // 两条 op 分工：`evolution-status` 给三级开关 + 计数（卡片要），`evolution-list`
          // 给具体条目（列表要）。不合成一条：卡片每次刷新都要读，而条目会越攒越多。
          var evs = React.useState({ loading: true, status: null, entries: [], error: null })
          var evo = evs[0], setEvo = evs[1]
          var evb = React.useState(false)
          var evoBusy = evb[0], setEvoBusy = evb[1]
          // 展开的是哪一条（同时只开一条：这一页的行已经够密，开三条会把记忆列表推出一屏）。
          var evd = React.useState(null)
          var evoDetail = evd[0], setEvoDetail = evd[1]
          // 详情缓存（id → evolution-read 的返回）。不缓存的话每点一次都重读一次盘，
          // 而用户会在几条之间来回比。
          var evc = React.useState({})
          var evoCache = evc[0], setEvoCache = evc[1]
          var evoOrgState = React.useState(null)
          var evoOrg = evoOrgState[0], setEvoOrg = evoOrgState[1]
          // 后台复习队列：只用来在「有失败 / 无法处理」时给一个重试入口。
          var evq = React.useState(null)
          var evoQueue = evq[0], setEvoQueue = evq[1]
          // 自主记忆弹窗（设置入口）。与 `modal` 分开存：弹窗里点「删除 / 提升 / 整理」
          // 还要再开一层确认弹窗，共用一个槽会把自主记忆一起关掉。
          var eos = React.useState(false)
          var evoOpen = eos[0], setEvoOpen = eos[1]

          /**
           * 当前**对话**的会话 id。
           *
           * 不是下拉框选中的那一层（`scopeState.sessionId`）—— 那一层是"本页在编辑谁"，
           * 而开关卡回答的是"我现在到底开没开"。两者混用会出现"我给自己开了，结果改的是
           * 另一个对话"。
           */
          function evoSessionId() {
            try { return String((scopeDeps.currentSessionId && scopeDeps.currentSessionId()) || '') } catch (e) { return '' }
          }

          function refreshEvolution() {
            var sid = evoSessionId()
            var args = sid === '' ? {} : { sessionId: sid }
            Promise.all([
              apiCall('evolution-status', args),
              // 默认列表 = 待确认 + 生效；停用的条目已经进回收站，不在卡片里重复出现。
              apiCall('evolution-list', {}),
              apiCall('evolution-queue', {}),
            ])
              .then(function (out) {
                var st = out[0] || null
                var ls = out[1] || null
                var q = out[2] || null
                var err = null
                if (st && st.ok === false) err = translateError(t, st)
                else if (ls && ls.ok === false) err = translateError(t, ls)
                setEvo({
                  loading: false,
                  status: st && st.ok !== false ? st : null,
                  entries: ls && ls.ok !== false ? (ls.entries || []) : [],
                  // 全局设置（含笔记风格）：设置弹窗直接读，不用再发一次请求。
                  settings: ls && ls.ok !== false ? (ls.settings || null) : null,
                  error: err,
                })
                // 队列拿不到（这版没接线）就不显示这一块：它回答的是"后台在干什么"，
                // 不是"学成了什么"，缺了不该让整张卡片报错。
                setEvoQueue(q && q.ok !== false ? { stats: q.stats || {}, items: q.items || [], error: null } : null)
              })
              .catch(function (e) { setEvo({ loading: false, status: null, entries: [], settings: null, error: errMsg(e) }) })
          }
          // 跟着「当前对话」重取，不跟「选中层」：切对话时这张卡必须跟着变。
          React.useEffect(function () { refreshEvolution() }, [scopeState.currentSessionId])

          /**
           * 拨某一层的开关：写全局，并把本工作区 / 本会话原先的覆盖清成「继承」。
           *
           * 为什么要连覆盖一起清：三级开关是逐字段覆盖，只要本会话还留着 `false`，
           * 全局打开后这里依然是关的 —— 用户看到的是"我开了，怎么没反应"。界面已经不再
           * 提供那两行选项（用户 2026-11-09：要更傻瓜），就没有任何地方能把它拨回来，
           * 所以拨动开关必须把它俩一起收回。写串行走，避免并发覆盖配置侧车。
           */
          function setEvolutionLayer(key, next) {
            var sid = evoSessionId()
            var st = evo.status || {}
            var settings = {}
            settings[key === 'global' ? 'learnGlobal' : 'learnWorkspace'] = next
            /** @type {any[]} 三种写形状（settings / inherit），别让 TS 按第一条收窄。 */
            var calls = [{ op: 'evolution-settings', args: { set: true, settings: settings } }]
            if (sid !== '' && st.workspace && st.workspace.defined === true) {
              calls.push({ op: 'evolution-toggle', args: { scope: 'workspace', inherit: true, sessionId: sid } })
            }
            if (sid !== '' && st.session && st.session.defined === true) {
              calls.push({ op: 'evolution-toggle', args: { scope: 'session', inherit: true, sessionId: sid } })
            }
            setEvoBusy(true)
            var outs = []
            var chain = Promise.resolve()
            calls.forEach(function (c) {
              chain = chain.then(function () {
                return apiCall(c.op, c.args).then(function (res) { outs.push(res); return res })
              })
            })
            chain.then(function () {
              setEvoBusy(false)
              var bad = outs.filter(function (r) { return !r || r.ok === false })[0]
              if (!bad) {
                setResult({ ok: true, text: t('evo.saved') })
                refreshEvolution()
                // 工具跟着两个开关一起开 / 关：兼容页若正开着，让它立刻重拉那张表与 chip。
                try { window.dispatchEvent(new Event('dsm:proactive-memory-changed')) } catch (e) {}
              } else setResult({ ok: false, text: translateError(t, bad) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          function approveEvolution(id) {
            setEvoBusy(true)
            apiCall('evolution-approve', { id: id }).then(function (res) {
              setEvoBusy(false)
              if (res && res.ok !== false) { setResult({ ok: true, text: t('evo.approved') }); refreshEvolution() }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          function forgetEvolution(id) {
            setEvoBusy(true)
            apiCall('evolution-forget', { id: id, actor: 'user' }).then(function (res) {
              setEvoBusy(false)
              setModal(null)
              if (res && res.ok !== false) { setResult({ ok: true, text: t('evo.forgotten') }); refreshEvolution() }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setModal(null); setResult({ ok: false, text: errMsg(e) }) })
          }

          /** 停用：条目进回收站、不再注入；恢复在记忆页的回收站里。 */
          function disableEvolution(id) {
            setEvoBusy(true)
            apiCall('evolution-set-status', { id: id, enabled: false, actor: 'user' }).then(function (res) {
              setEvoBusy(false)
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.disabled') })
                setEvoCache({})
                refreshEvolution()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          /** 点行名展开详情：详情按需拉一次（boundary / 待确认理由只在正文与 state 里）。 */
          function toggleEvolutionDetail(id) {
            if (evoDetail === id) { setEvoDetail(null); return }
            setEvoDetail(id)
            if (evoCache[id]) return
            apiCall('evolution-read', { id: id }).then(function (res) {
              if (res && res.ok !== false) {
                setEvoCache(function (cur) { var next = Object.assign({}, cur); next[id] = res; return next })
              }
            }).catch(function () { /* 详情拉不到不影响列表；展开区显示"暂无" */ })
          }

          /** 算整理草案（只读）。结果留在卡片里，用户逐条「应用」。 */
          function runOrganize() {
            setEvoOrg({ busy: true, drafts: null, scanned: 0, error: null })
            apiCall('evolution-organize', { scope: 'workspace' }).then(function (res) {
              if (res && res.ok !== false) {
                setEvoOrg({ busy: false, drafts: res.drafts || [], scanned: Number(res.scanned) || 0, error: null })
              } else setEvoOrg({ busy: false, drafts: null, scanned: 0, error: translateError(t, res) })
            }).catch(function (e) { setEvoOrg({ busy: false, drafts: null, scanned: 0, error: errMsg(e) }) })
          }

          function applyOrganizeDraft(d) {
            setEvoOrg(function (cur) { return cur ? Object.assign({}, cur, { busy: true }) : cur })
            apiCall('evolution-apply-organize', { action: d.action, ids: d.ids, keep: d.keep }).then(function (res) {
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.organize.applied') })
                setEvoCache({})
                setEvoOrg(function (cur) {
                  if (!cur) return cur
                  // 应用过的那条从草案里拿掉：留着会让用户以为没生效、再点一次。
                  return Object.assign({}, cur, {
                    busy: false,
                    drafts: (cur.drafts || []).filter(function (x) { return x.id !== d.id }),
                  })
                })
                refreshEvolution()
              } else {
                setEvoOrg(function (cur) { return cur ? Object.assign({}, cur, { busy: false, error: translateError(t, res) }) : cur })
              }
            }).catch(function (e) {
              setEvoOrg(function (cur) { return cur ? Object.assign({}, cur, { busy: false, error: errMsg(e) }) : cur })
            })
          }

          /** 手动重跑复习。带 id = 只重试那一条（dead-letter 的唯一出口）；不带 = 整队跑一遍。 */
          function replayEvolution(id) {
            setEvoQueue(function (cur) { return cur ? Object.assign({}, cur, { busy: true }) : { stats: {}, items: [], error: null, busy: true } })
            var args = id ? { id: id } : {}
            apiCall('evolution-replay', args).then(function (res) {
              if (res && res.ok !== false) {
                setResult({ ok: true, text: id ? t('evo.queue.retried') : t('evo.queue.done', { attempted: Number(res.attempted) || 0 }) })
                setEvoCache({})
                refreshEvolution()
              } else {
                setEvoQueue(function (cur) { return cur ? Object.assign({}, cur, { busy: false, error: translateError(t, res) }) : null })
              }
            }).catch(function (e) {
              setEvoQueue(function (cur) { return cur ? Object.assign({}, cur, { busy: false, error: errMsg(e) }) : null })
            })
          }

          /**
           * 展开区（用户 2026-11-10：只要重要信息 —— 边界；时间线 / 证据 / 路径全砍）。
           * 数据来自 `evolution-read`（按需拉一次；boundary 不在列表行里）。
           */
          function renderEvolutionDetail(e) {
            var d = evoCache[e.id]
            var out = []
            // "为什么待确认"放展开区第一行：meta 行是单行省略，长理由挤在那里只会被截断
            // （用户 2026-11-10：内容被截断）——这里宽度管够，完整读完。
            if (e.needsReview) out.push(React.createElement('p', { key: 'nr', className: 'dsm-help' }, e.needsReview))
            if (!d) {
              out.push(React.createElement('p', { key: 'l', className: 'dsm-help' }, t('loading')))
            } else if (d.ok === false) {
              out.push(React.createElement('p', { key: 'e', className: 'dsm-help' }, translateError(t, d)))
            } else if (d.boundary) {
              out.push(React.createElement('div', { key: 'bd', className: 'dsm-evo-detail-row' },
                React.createElement('span', { className: 'dsm-evo-detail-key' }, t('evo.detail.boundary')),
                React.createElement('span', null, String(d.boundary))))
            }
            return React.createElement('div', { className: 'dsm-evo-detail' }, out)
          }

          /**
           * 一行自动记忆。
           *
           * 行上只留三样量值（用户 2026-11-10）：层、注入次数、token。状态用标签表达，
           * 候选行右侧一颗「确认」；停用 / 删除收进 ⋯ 菜单。
           */
          function renderEvolutionRow(e) {
            // core / playbook 是旧数据里仍可注入的两档，按「生效」显示，不标成待确认。
            var statusKey = e.status === 'core' ? 'evo.tag.core'
              : e.status === 'active' || e.status === 'playbook' ? 'evo.tag.active'
                : e.status === 'superseded' ? 'evo.tag.superseded'
                  : e.status === 'archived' ? 'evo.tag.archived'
                    : 'evo.tag.candidate'
            var tone = e.status === 'core' || e.status === 'active' || e.status === 'playbook' ? 'ok' : e.status === 'candidate' ? 'warn' : 'idle'
            var pending = e.status === 'candidate'
            var open = evoDetail === e.id
            var metaBits = [
              t('evo.layer.' + e.layer),
              t('evo.injected', { count: (e.counters && Number(e.counters.injected)) || 0 }),
              t('evo.tokens', { count: Number(e.tokens) || 0 }),
            ]
            if (e.wsMissing) metaBits.push(t('evo.ws.missing'))
            // 停用由行内开关承担（与记忆行同构）；菜单里只留编辑与删除。
            var menuItems = []
            menuItems.push({ key: 'forget', label: t('evo.forget'), danger: true, disabled: evoBusy, onClick: function () { setModal({ type: 'evo-delete', entry: e }) } })
            return React.createElement(ListRow, {
              key: e.id,
              dots: [React.createElement(StatusDot, { key: 'd', tone: tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'idle', title: t(statusKey) })],
              // 行名就是展开开关：详情（边界 / 待确认理由）收在名字下面，不另开一个弹窗。
              name: React.createElement('button', {
                type: 'button',
                className: 'dsm-evo-name',
                'aria-expanded': open,
                onClick: function (ev) { ev.stopPropagation(); toggleEvolutionDetail(e.id) },
              }, (e.oneLine || e.id) + (open ? ' ▾' : ' ▸')),
              tag: React.createElement(StatusTag, { tone: tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : undefined, text: t(statusKey) }),
              meta: metaBits.join(' · '),
              metaTitle: e.needsReview || undefined,
              extra: open ? renderEvolutionDetail(e) : null,
              // 候选行右侧是「确认」；生效行是开关，与记忆行同一语义：关 = 停用进回收站。
              side: pending
                ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: evoBusy, onClick: function () { approveEvolution(e.id) } }, t('evo.approve'))
                : React.createElement(Switch, {
                  on: e.enabled !== false,
                  disabled: evoBusy,
                  label: t('evo.disable') + ' ' + (e.oneLine || e.id),
                  onClick: function () { disableEvolution(e.id) },
                }),
              actions: [React.createElement(RowMenu, {
                key: 'menu',
                label: t('evo.menu', { name: e.oneLine || e.id }),
                items: menuItems,
              })],
            })
          }

          /**
           * 后台复习失败：只在真有失败 / 无法处理时出现。
           *
           * 复习完全在后台跑，整批失败时（模型没配、密钥过期、上游 5xx）表现就是
           * 「开了开关但什么都不学」。给一行数字与一个重试出口，不把队列详情铺在设置里。
           */
          function renderEvolutionQueue() {
            if (!evoQueue) return null
            var s = evoQueue.stats || {}
            var failed = Number(s.failed) || 0
            var dead = Number(s.dead) || 0
            if (failed + dead === 0) return null
            var busy = !!evoQueue.busy
            return React.createElement('div', { key: 'queue', className: 'dsm-evo-queue' },
              React.createElement('div', { className: 'dsm-evo-queue-head' },
                React.createElement('span', { className: 'dsm-evo-detail-key' }, t('evo.queue.title')),
                React.createElement('span', { className: 'dsm-help' }, t('evo.queue.failStat', { failed: failed, dead: dead })),
                React.createElement('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn-quiet',
                  disabled: busy,
                  onClick: function () { replayEvolution() },
                }, busy ? t('evo.queue.busy') : t('evo.queue.retryAll'))),
              evoQueue.error ? React.createElement(Notice, { kind: 'err', text: evoQueue.error }) : null)
          }


          /**
           * 一张自主记忆卡。`rows` 已经过滤到这一组（全局 / 某个工作区），
           * `cardKey` 同时是折叠状态的键；标题由调用方按组给。
           *
           * 复用场景卡的骨架（.dsm-source），行沿用 renderEvolutionRow（ListRow）：
           * 点行名展开详情，候选行右侧有「确认」，生效行右侧是开关，停用进记忆页的回收站。
           * 卡头右侧的「设置」开设置弹窗（两层开关 / 风格 / 整理），卡片本身只管展示与逐条操作。
           */
          function renderEvolutionCard(opts) {
            var layerOn = opts.layerOn
            var rows = opts.rows
            // 搜索词与场景卡同源同口径：一行摘要 / id 命中即留（大小写不敏感）。
            if (q !== '') {
              rows = rows.filter(function (e) {
                var hay = String(e.oneLine || '') + ' ' + String(e.id || '')
                return hay.toLowerCase().indexOf(q) >= 0
              })
            }
            // 已取代是历史，已归档在回收站，都不占列表。
            var live = rows.filter(function (e) { return e.status !== 'archived' && e.status !== 'superseded' })
            // 关着且一条都没有 → 不渲染：空卡是噪音。开着但还没学到东西 → 留一张空卡，
            // 让用户知道「它开着，只是还没有内容」。
            if (!layerOn && live.length === 0) return null
            // 「启用 / 总数」与场景卡同一读法：生效（active/core/playbook）且没被停用的才算"开"。
            var onCount = live.filter(function (e) { return (e.status === 'active' || e.status === 'core' || e.status === 'playbook') && e.enabled !== false }).length
            // 默认展开跟总开关走（开 = 这里就是它注入的清单，该一眼能看）；手动收起的以手动为准。
            var openFlag = collapsed[opts.cardKey]
            var baseOpen = openFlag === undefined ? layerOn : openFlag !== true
            var open = baseOpen || q !== ''
            var body = []
            if (live.length === 0) {
              body.push(React.createElement('div', { key: 'empty', className: 'dsm-empty' }, opts.emptyText))
            } else {
              body = body.concat(live.map(function (e) { return renderEvolutionRow(e) }))
            }
            // 总开关开 = 卡照常；关 = 整卡置灰（条目还在盘上，只是不再注入）。
            return React.createElement('div', { key: opts.cardKey, className: 'dsm-source' + (layerOn ? '' : ' dsm-rule-off') },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main dsm-source-head-stack', 'aria-expanded': open, onClick: function () { toggleCollapse(opts.cardKey, baseOpen) } },
                  React.createElement('span', { className: 'dsm-source-head-line' },
                    React.createElement('span', { className: 'dsm-source-title' }, opts.title),
                    React.createElement('span', { className: 'dsm-count dsm-count-tight' }, t('memory.scene.count', { on: onCount, total: live.length })),
                    React.createElement('span', { className: 'dsm-tag' + (layerOn ? ' dsm-tag-on' : '') }, t('memory.auto.tag')))),
                React.createElement('div', { className: 'dsm-source-actions' },
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: function () { setResult(null); setEvoOpen(true) } }, t('evo.settings')))),
              open ? React.createElement('div', { className: 'dsm-source-body' }, body) : null)
          }

          /** 工作区 hash 的短码：workspaces.json 还没登记这个目录时的显示兜底。 */
          function shortWorkspaceHash(hash) {
            var s = String(hash || '')
            return s === '' ? '?' : s.slice(0, 8)
          }

          /**
           * 自主记忆的全部卡片：全局一张，工作区按工作区名称各一张（用户 2026-11-10：
           * 要知道这一组是哪个工作区的）。别的仓库的条目只展示，不会注入当前对话。
           */
          function renderEvolutionCards() {
            if (sceneFilter !== '') return []
            var all = evo.entries || []
            var currentHash = (evo.status && evo.status.workspace && evo.status.workspace.hash) || ''
            // 当前工作区可能还没写进 workspaces.json（从没拨过开关）：status 会按 cwd 给个名字。
            var currentLabel = (evo.status && evo.status.workspace && evo.status.workspace.label) || ''
            var cards = []
            var globalCard = renderEvolutionCard({
              cardKey: 'auto:global',
              title: t('memory.auto.card.global'),
              layerOn: evoGlobalOn,
              rows: all.filter(function (e) { return e.layer === 'global' }),
              emptyText: t('evo.empty.on'),
            })
            if (globalCard) cards.push(globalCard)

            var groups = []
            var byHash = {}
            all.forEach(function (e) {
              if (e.layer !== 'workspace') return
              var hash = String(e.workspace || '')
              var group = byHash[hash]
              if (group === undefined) {
                group = byHash[hash] = { hash: hash, rows: [], label: '' }
                groups.push(group)
              }
              group.rows.push(e)
              if (group.label === '') group.label = String(e.workspaceLabel || e.workspaceCwd || '')
            })
            groups.forEach(function (group) {
              if (group.label === '' && group.hash === currentHash) group.label = currentLabel
            })
            // 当前对话的工作区排最前；其余按名称排，没有名称的按 hash。
            groups.sort(function (a, b) {
              if (a.hash === currentHash && b.hash !== currentHash) return -1
              if (b.hash === currentHash && a.hash !== currentHash) return 1
              return a.label.localeCompare(b.label) || a.hash.localeCompare(b.hash)
            })
            if (groups.length === 0) {
              var emptyWs = renderEvolutionCard({
                cardKey: 'auto:workspace',
                title: t('memory.auto.card.workspace'),
                layerOn: evoWorkspaceOn,
                rows: [],
                emptyText: currentHash === '' ? t('evo.empty.workspace') : t('evo.empty.on'),
              })
              if (emptyWs) cards.push(emptyWs)
            } else {
              groups.forEach(function (group) {
                var label = group.label !== '' ? group.label : shortWorkspaceHash(group.hash)
                var card = renderEvolutionCard({
                  cardKey: 'auto:workspace:' + (group.hash || 'unknown'),
                  title: t('memory.auto.card.workspaceNamed', { name: label }),
                  layerOn: evoWorkspaceOn,
                  rows: group.rows,
                  emptyText: t('evo.empty.on'),
                })
                if (card) cards.push(card)
              })
            }
            return cards
          }

          /**
           * 自主记忆设置弹窗（清单已搬到记忆页签上，这里只留**设置**）。
           *
           * 只有「总开关 + 一行数字 + 笔记风格 + 本地整理 + 后台失败重试」。确认弹窗走
           * `modal` 那个槽，与 `evoOpen` 分开存，才能叠在它上面而不把整块关掉。
           */
          /** 笔记风格的本地编辑态（custom 文本）。预设切换即时保存，custom 要点「保存」。 */
          var evsStyle = React.useState({ busy: false, text: '', open: false })
          var evoStyle = evsStyle[0], setEvoStyle = evsStyle[1]

          function saveNoteStyle(style, custom) {
            setEvoStyle(function (cur) { return Object.assign({}, cur, { busy: true, text: custom, open: style === 'custom' }) })
            apiCall('evolution-settings', { set: true, settings: { noteStyle: style, noteStyleText: custom } }).then(function (res) {
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.style.saved') })
                refreshEvolution()
                setEvoStyle(function (cur) { return Object.assign({}, cur, { busy: false }) })
              } else {
                setResult({ ok: false, text: translateError(t, res) })
                setEvoStyle(function (cur) { return Object.assign({}, cur, { busy: false }) })
              }
            }).catch(function (e) {
              setResult({ ok: false, text: errMsg(e) })
              setEvoStyle(function (cur) { return Object.assign({}, cur, { busy: false }) })
            })
          }

          /** 笔记风格一行（用户 2026-11-10：默认高效，不要表情和语气词；支持自定义）。 */
          function renderEvolutionStyle() {
            var s = (evo.settings && evo.settings.noteStyle) || 'efficient'
            var customText = (evo.settings && evo.settings.noteStyleText) || ''
            var options = [
              ['efficient', 'evo.style.efficient'],
              ['friendly', 'evo.style.friendly'],
              ['minimal', 'evo.style.minimal'],
              ['custom', 'evo.style.custom'],
            ]
            return React.createElement('div', { className: 'dsm-evo-style' },
              React.createElement('span', { className: 'dsm-evo-style-label' }, t('evo.style')),
              React.createElement('div', { className: 'dsm-form-seg', role: 'group' },
                options.map(function (o) {
                  return React.createElement('button', {
                    key: o[0], type: 'button', 'aria-pressed': s === o[0],
                    disabled: evoStyle.busy,
                    onClick: function () { saveNoteStyle(o[0], customText) },
                  }, t(o[1]))
                })),
              // 自定义展开一行输入 + 保存：预设切换即时生效，custom 是用户自己的话，要显式保存。
              s === 'custom' || evoStyle.open
                ? React.createElement('div', { className: 'dsm-evo-style-custom' },
                    React.createElement('input', {
                      className: 'dsm-control', type: 'text',
                      placeholder: t('evo.style.custom.hint'),
                      value: evoStyle.text || customText,
                      onChange: function (ev) { setEvoStyle(function (cur) { return Object.assign({}, cur, { text: ev.target.value, open: true }) }) },
                    }),
                    React.createElement('button', {
                      type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: evoStyle.busy || (evoStyle.text || customText).trim() === '',
                      onClick: function () { saveNoteStyle('custom', (evoStyle.text || customText).trim()) },
                    }, t('evo.style.save')))
                : null)
          }

          function renderEvolutionModal() {
            var st = evo.status
            var auto = (st && st.auto) || { entries: 0, pendingReview: 0 }
            var eff = (st && st.effective) || {}
            var overall = eff.enabled === true
            var globalOn = eff.learnGlobal === true
            var workspaceOn = eff.learnWorkspace === true
            // 本地整理只出建议、逐条「应用」；它不花模型调用，是设置弹窗里唯一的清理入口。
            var drafts = evoOrg ? React.createElement('div', { key: 'org', className: 'dsm-evo-organize' },
              evoOrg.error ? React.createElement(Notice, { kind: 'err', text: evoOrg.error }) : null,
              !evoOrg.error && evoOrg.drafts !== null && evoOrg.drafts.length === 0
                ? React.createElement('p', { className: 'dsm-help' }, t('evo.organize.none', { scanned: evoOrg.scanned }))
                : null,
              !evoOrg.error && evoOrg.drafts && evoOrg.drafts.length
                ? React.createElement('div', null,
                    React.createElement('div', { className: 'dsm-evo-detail-key' }, t('evo.organize.title', { count: evoOrg.drafts.length })),
                    evoOrg.drafts.map(function (d) {
                      return React.createElement('div', { key: d.id, className: 'dsm-evo-draft' },
                        React.createElement('span', { className: 'dsm-tag' }, t('evo.organize.action.' + d.action)),
                        React.createElement('span', { className: 'dsm-evo-draft-id' }, (d.ids || []).join(' + ')),
                        React.createElement('span', { className: 'dsm-evo-draft-reason' }, String(d.reason || '')),
                        React.createElement('button', {
                          type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: !!evoOrg.busy,
                          onClick: function () { applyOrganizeDraft(d) },
                        }, t('evo.organize.apply')))
                    }))
                : null) : null
            return React.createElement(Modal, {
              key: 'evo', className: 'dsm-modal-evo' + (overall ? ' dsm-evo-on' : ''), title: t('evo.title'),
              closeLabel: t('btn.close'), onClose: function () { setEvoOpen(false) },
            },
              React.createElement('div', { className: 'dsm-evo-modal' },
                // 两层各一颗开关：同时管「学不学」与「注不注入」。只开一层时，对话卡片
                // 不会再给出另一层的选项（allowedLayers 由服务端按这两个开关算）。
                React.createElement('div', { className: 'dsm-evo-layers' },
                  React.createElement('div', { className: 'dsm-evo-layer' },
                    React.createElement('span', { className: 'dsm-label' }, t('evo.switch.global')),
                    React.createElement(Switch, {
                      on: globalOn,
                      disabled: evoBusy || (evo.loading && !st),
                      label: t('evo.switch.global'),
                      onClick: function () { setEvolutionLayer('global', !globalOn) },
                    }),
                    React.createElement('span', { className: 'dsm-help' }, t('evo.switch.global.hint'))),
                  React.createElement('div', { className: 'dsm-evo-layer' },
                    React.createElement('span', { className: 'dsm-label' }, t('evo.switch.workspace')),
                    React.createElement(Switch, {
                      on: workspaceOn,
                      disabled: evoBusy || (evo.loading && !st),
                      label: t('evo.switch.workspace'),
                      onClick: function () { setEvolutionLayer('workspace', !workspaceOn) },
                    }),
                    React.createElement('span', { className: 'dsm-help' }, t('evo.switch.workspace.hint')))),
                React.createElement('div', { className: 'dsm-evo-master' },
                  // 开没开只看边框：开启时弹窗与页头按钮走成功色边框，不再写「已开启」。
                  React.createElement('span', { className: 'dsm-help' }, t('evo.stat.short', { learned: auto.entries || 0, pending: auto.pendingReview || 0 })),
                  React.createElement('button', {
                    key: 'org', type: 'button', className: 'dsm-btn dsm-btn-quiet',
                    disabled: !!(evoOrg && evoOrg.busy) || auto.entries === 0, onClick: runOrganize,
                  }, evoOrg && evoOrg.busy ? t('evo.organize.scanning') : t('evo.organize'))),
                // 笔记风格：模型写新记忆的口吻（默认高效——无表情、无语气词）。
                overall ? renderEvolutionStyle() : null,
                React.createElement('p', { className: 'dsm-help' }, t('evo.modal.hint')),
                React.createElement('p', { className: 'dsm-help' }, t('evo.modal.trashHint')),
                evo.error ? React.createElement(Notice, { key: 'e', kind: 'err', text: evo.error }) : null,
                evo.loading && !st ? React.createElement('p', { key: 'l', className: 'dsm-help' }, t('loading')) : null,
                drafts,
                // 后台复习失败只在真有时露一行；没失败就不占地方。
                renderEvolutionQueue()))
          }

          // 页头那颗按钮要能一眼看出开没开、有几条待确认，省得每次都点进弹窗确认。
          var evoEff = (evo.status && evo.status.effective) || {}
          var evoGlobalOn = evoEff.learnGlobal === true
          var evoWorkspaceOn = evoEff.learnWorkspace === true
          var evoOn = evoGlobalOn || evoWorkspaceOn
          var evoPending = Number(evo.status && evo.status.auto && evo.status.auto.pendingReview) || 0
          // 自主记忆卡片：全局一张，工作区按名称分节。场景筛选选了具体场景时跟着隐藏 ——
          // 自主记忆不绑场景，出现在"某场景里有什么"的答案里只会添乱。
          var evoCards = renderEvolutionCards()
          // 顺序（用户 2026-11-10）：全局记忆 → 自主记忆 → 其余场景卡。没有全局卡时
          // 自主记忆排最前；它不绑场景，不该被挤到页面末尾。
          var sceneCards = visibleBuckets.map(renderSceneCard)
          var allCards = sceneCards
          if (evoCards.length > 0) {
            var globalIndex = visibleBuckets.indexOf('global')
            allCards = globalIndex >= 0
              ? sceneCards.slice(0, globalIndex + 1).concat(evoCards, sceneCards.slice(globalIndex + 1))
              : evoCards.concat(sceneCards)
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
                // 自主记忆：紧挨回收站左边（用户 2026-11-09）。原来那张平铺卡片搬进弹窗，
                // 页头只留这一颗入口，记忆列表不再被它顶下去。
                React.createElement('button', {
                  key: 'evo', type: 'button', className: 'dsm-btn dsm-btn-secondary' + (evoOn ? ' dsm-evo-head-on' : ''),
                  title: evoPending > 0 ? t('evo.pending.short', { count: evoPending }) : t('evo.title'),
                  onClick: function () { setResult(null); setEvoOpen(true) },
                }, t('evo.title'),
                  evoPending > 0 ? React.createElement('span', { key: 'p', className: 'dsm-count dsm-count-tight' }, String(evoPending)) : null),
                React.createElement('button', { key: 'trash', type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: openTrash }, t('memory.trash.open')),
                scopeLeaseKeys('memory').length > 0 ? React.createElement('button', { key: 'stopall', type: 'button', className: 'dsm-btn dsm-btn-danger-outline', disabled: busy || scopeWriteLocked(anyLocked), onClick: stopAllMemories }, t('scope.stopAll')) : null,
              ],
            }),
            // 两条横幅（与 MCP / 技能 / 子智能体页同源、同位置、同顺序）：
            // 锁定时只留锁定那条 —— 冻结期间"改动会同步写进场景档案"是句空话，两条并排
            // 还会互相矛盾（用户 2026-09-19 指出：锁定时长的场景提示没必要出现）。
            anyLocked && !scopeIsSession() ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('lock.banner')) : null,
            // 会话层不显示（同 MCP 页）：本层开关写的是会话覆盖，不同步档案。
            // global 是常驻默认场景，不需要「进场景」提示。
            (!anyLocked && sceneName && sceneName !== 'global' && !scopeIsSession()) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('scene.switch.banner', { scene: sceneName })) : null,
            // 自主记忆已从本页移走：页头一颗按钮 → 弹窗（见下方 evoOpen）。
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
                : (visibleBuckets.length || evoCards.length) ? React.createElement('div', { key: 'scenes', className: 'dsm-sources' }, allCards)
                  : (q || sceneFilter) ? React.createElement(ListStates, { key: 'search', t: t, state: 'search', text: t('memory.empty.search'), onClearFilter: function () { setQuery(''); setSceneFilter('') } })
                    : React.createElement(ListStates, { key: 'empty', t: t, state: 'empty', text: t('memory.empty') }),
            // 自主记忆弹窗先渲染：它里面开的确认弹窗排在后面，DOM 顺序决定后一层盖在上面。
            evoOpen ? renderEvolutionModal() : null,
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'del', className: 'dsm-modal-sm', title: t('memory.delete.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.delete.desc', { name: modal.rule.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDelete(modal.rule) } }, t('memory.btn.delete.confirm')))) : null,
            modal && modal.type === 'evo-delete' ? React.createElement(Modal, { key: 'evodel', className: 'dsm-modal-sm', title: t('evo.forget.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('evo.forget.desc', { name: modal.entry.oneLine || modal.entry.id })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: evoBusy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: evoBusy, onClick: function () { forgetEvolution(modal.entry.id) } }, t('evo.forget')))) : null,
            modal && modal.type === 'stop' ? React.createElement(Modal, { key: 'mstop', className: 'dsm-modal-sm', title: t('scope.unifiedClose'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('scope.unifiedClose.viewDesc', { name: modal.rule.name || modal.rule.id })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { var rule = modal.rule; setModal(null); stopOneMemory(rule) } }, t('scope.unifiedClose')))) : null,
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
              // 冲突（文件在别处被改过）：两条出路，别让用户只能关掉重来。
              editor.stale ? React.createElement('div', { className: 'dsm-feedback-row' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: reloadEditor }, t('stale.write.reload')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { submitUpdate(true) } }, t('stale.write.overwrite'))) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || anyLocked || editorNameInvalid || editorGroupInvalid || editorDescLen > 500 || !String(editor.name || '').trim() || !String(editor.body || '').trim(), onClick: editor.mode === 'create' ? submitCreate : function () { submitUpdate(false) } }, editor.mode === 'create' ? t('memory.btn.create') : t('memory.btn.save')))) : null,
            // 场景建/删/档案弹窗已移至「场景」页（ScenesPage）。
            // 记忆回收站：本页那一个（42-shared-ui.js 的 TrashModal，domain = memories）。
            // 记忆域的备注（场景 / 形态 / 字节数 / 删除时间）在组件内部按同一条口径拼装。
            modal && modal.type === 'trash' ? React.createElement(TrashModal, {
              key: 'trash',
              t: t,
              domain: 'memories',
              onClose: function () { setModal(null) },
              // 回收站里也有自动记忆的停用副本：恢复 / 永久删除后两张自主记忆卡要跟着刷新。
              onReload: function () { refresh(true); refreshEvolution() },
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