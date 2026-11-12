        function MemoryPage() {
          var EMPTY_STATS = { total: 0, enabled: 0, scenes: 0 }
          var EMPTY_MEMORY = { usedBytes: 0, maxBytes: 0, truncated: false }
          var state = React.useState({
            loading: true, error: null,
            rules: [], scenes: [], activeMode: 'all',
            sceneMemory: EMPTY_MEMORY, stats: EMPTY_STATS,
            // 服务端的如实清单（扫描/读取被跳过的条目）—— 以前整份丢掉，用户只看到"少了一条"。
            warnings: [],
            // 工作区清单（`rules-list` 回）：名称与目录是否还在。首帧为空，取数后填。
            workspaces: [],
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
          // 切层 / 进场景会连着发几次 rules-list；只认最后一次请求的结果 —— 否则先发后到的
          // 旧响应会把界面盖回上一层的数据，用户看到的是"切了层，列表还是旧的"。
          var refreshSeqRef = React.useRef(0)
          function refresh(silent) {
            var seq = ++refreshSeqRef.current
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('rules-list', { sessionId: scopeSessionId() }).then(function (r) {
              if (seq !== refreshSeqRef.current) return
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
                  // 工作区清单（名称 + 目录是否还在）。**必须一起合并**：漏了这一行，
                  // 服务端回得再对，界面拿到的仍是 `undefined` —— 表现是工作区那一档的
                  // 下拉里一个选项都没有，点了「工作区」看着像没反应。
                  workspaces: Array.isArray(r.workspaces) ? r.workspaces : [],
                }) })
              } else {
                setData(function (prev) { return Object.assign({}, prev, { loading: false, error: translateError(t, r), rules: [], scenes: [], activeMode: 'all', sceneMemory: EMPTY_MEMORY, stats: EMPTY_STATS, warnings: [] }) })
              }
            }).catch(function (e) {
              if (seq !== refreshSeqRef.current) return
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
          /**
           * 取回新建草稿，但**强制覆盖落点**。
           *
           * `closeEditor` 会把整个 editor（含 `group`）暂存下来，那是给「误关弹窗后接着写」用的。
           * 但落点是**这一次点击的意图**：从工作区卡点进来就必须落在工作区，不能被上次在场景卡
           * 里选过的 group 顶掉 —— 否则每个入口打开的都是同一个「上次的位置」。
           * 所以草稿只恢复名称 / 正文 / 形态这些内容字段，`group` 一律用本次传入值。
           */
          function draftForCreate(group) {
            var d = takeFormDraft('mem:create')
            var base = { mode: 'create', id: '', name: '', body: '', form: 'flat', path: '', error: null, files: [], attachments: [] }
            if (!d) return Object.assign(base, { group: group })
            return Object.assign(base, d, { mode: 'create', id: '', group: group })
          }

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
            setEditor(draftForCreate(sceneName || GLOBAL_SCENE))
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
                setEditor(draft || { mode: 'edit', id: rd.id, group: rd.group, name: rd.name, body: rd.body || '', form: rd.form === 'bundle' ? 'bundle' : 'flat', path: rd.path || '', error: null, files: [], attachments: rd.attachments || [], focusAttach: focusAttach === true, stamp: res.stamp })
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
                setEditor({ mode: 'edit', id: rd.id, group: rd.group, name: rd.name, body: rd.body || '', form: rd.form === 'bundle' ? 'bundle' : 'flat', path: rd.path || '', error: null, files: [], attachments: rd.attachments || [], stamp: res.stamp })
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
          // 场景段的截断 / 丢弃清单仍来自 rules-list 的 `sceneMemory`；注入预算的已用
          // 改由服务端 `auto.injectBytes` 给（见下方预算那段），这里不再自己算上限与已用。
          var memInfo = data.sceneMemory || EMPTY_MEMORY
          var droppedNames = React.useMemo(function () {
            return (memInfo.dropped || []).map(function (d) { return (d.scene ? d.scene + '/' : '') + d.name })
          }, [memInfo])
          var q = String(dq || '').toLowerCase()

          // 自主记忆的实况（三级开关 + 计数 + 当前工作区）。声明放在这里而不是卡片那一区：
          // 下面 `curWorkspace` / `view` 要读 `evo.status`，而 `var` 只提升声明不提升赋值 ——
          // 放到后面会让这两处拿到 `undefined`，`.status` 当场抛 TypeError，整页崩成空白。
          var evs = React.useState({ loading: true, status: null, entries: [], error: null })
          var evo = evs[0], setEvo = evs[1]
          // 当前对话的工作区：`evo.status.workspace` 已经有 hash 与显示名（与自主记忆同一份），
          // 记忆页用它把「这个项目」那张卡排最前，并给卡头一个可读的名字。
          var curWorkspace = (function () {
            var w = (evo.status && evo.status.workspace) || null
            var hash = String((w && w.hash) || '')
            if (hash === '') return null
            return { group: '_ws/' + hash, label: String(w.label || '') }
          })()
          // 分桶 / 过滤 / 排序只在数据或（防抖后的）搜索词、场景筛选变化时重算（实现与理由
          // 见组件上方的 `memoryView`）：开关、弹窗、编辑器输入这些重渲染不再重扫全表。
          var view = React.useMemo(function () { return memoryView(data, q, sceneFilter, curWorkspace, t) }, [data, q, sceneFilter, curWorkspace && curWorkspace.group, curWorkspace && curWorkspace.label])
          var buckets = view.buckets, order = view.order
          var sceneOptions = view.sceneOptions, sceneChoices = view.sceneChoices
          var createTargets = view.createTargets || { levels: [], workspace: [], scene: sceneChoices, kindOf: function () { return 'scene' } }
          // 「新建记忆」当前选中的层级：跟随 `editor.group` 反推，不另存一份状态 ——
          // 两份状态会在「打开编辑器时带进来一个 group」时打架（层级说全局、group 却是某场景）。
          var createKind = editor ? createTargets.kindOf(editor.group) : 'global'
          /** 切层级：把 `editor.group` 落到该档的第一个可用项。 */
          function onPickCreateLevel(kind) {
            if (!editor) return
            var next = editor.group
            if (kind === 'global') next = GLOBAL_SCENE
            else if (kind === 'workspace') next = (createTargets.workspace[0] || {}).value || ''
            else next = (createTargets.scene[0] || {}).value || ''
            setEditor(Object.assign({}, editor, { group: next }))
          }
          var filtering = view.filtering, visibleBuckets = view.visibleBuckets, hasAnyRule = view.hasAnyRule
          // 名称 = .md 文件名（单个路径段，不是路径）：用 segment 校验器，与宿主逐字对齐。
          // 中文等任意 Unicode 都合法（`站会流程` → `站会流程.md`）。
          // 未输入时不标红/不报「不合法」——一打开弹窗就飘红会让人以为中文名被拒；
          // 空值改由提交按钮的 disabled 兜住（见下方 disabled 表达式）。
          var editorNameInvalid = editor ? String(editor.name || '').trim() !== '' && !isValidSceneSegment(String(editor.name || '').trim()) : false
          var editorGroupInvalid = editor && editor.mode === 'create' ? String(editor.group || '').trim() !== '' && !isValidScenePath(String(editor.group || '').trim()) : false
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

          /**
           * 行 2 里那个归属串：场景记忆显示场景名，工作区记忆显示**项目名**。
           *
           * 原来直接把 `r.group` 印出来，于是工作区记忆那一行写着 `_ws/8fce1e9335ad60c8` ——
           * `_ws` 是内部目录前缀、后面那串是哈希，两个都是实现细节，用户读不出这是哪个项目。
           * 场景名照旧（它就是用户自己起的名字），多级场景保留完整路径（`写作/禁用词` 有意义）。
           */
          function groupLabelOf(r) {
            var g = String((r && r.group) || '')
            if (g === '' || g === 'global') return ''
            if (g.indexOf('_ws/') === 0) {
              var hash = g.slice('_ws/'.length)
              var hit = (data.workspaces || []).filter(function (w) { return w && String(w.hash) === hash })[0]
              var label = hit ? String(hit.label || '') : ''
              if (label === '') label = String(r.workspaceLabel || '')
              return label
            }
            return g
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
            // 行 2 元信息：正文摘要 + 多级分组路径。摘要与自主记忆行同一口径
            // （服务端压平后按 160 显示宽度截断），行宽不够时再由 CSS 省略。
            // 附件计数不在这一行了 —— 它挪到名称旁与体积并排（见 attachTag）。
            //
            // 体积（`145 B`）放在行 1 的名称旁：它是这一行的"量值"，跟名称一样是**扫读**时
            // 先看的，挤在元信息后面容易被挤掉。形态标签「bundle」也不画 —— 形态由附件计数
            // （`📎 N 个附件`）已经说清了。`memory.form.*` 两个键**仍然在用**（回收站/导出
            // 里按 `'memory.form.' + …` 计算取词），别顺手删掉。
            var attachNode = attachTag(r, shadowed)
            // 列表摘要用正文首行（`excerpt`）；旧数据没有这个字段时退回 `description`，
            // 否则升级后老记忆的行会突然只剩名称。
            var excerptText = r.excerpt || r.description || ''
            var metaBits = [
              excerptText ? React.createElement('span', { key: 'excerpt', className: 'dsm-listrow-meta-desc', title: excerptText }, excerptText) : null,
              groupLabelOf(r) ? React.createElement('span', { key: 'group', className: 'dsm-listrow-meta-info' }, groupLabelOf(r)) : null,
            ]
            // 名称旁那颗体积：纯量值、不可点，所以是 span；等宽数字免得整列右缘跟着抖。
            var sizeTag = typeof r.bytes === 'number'
              ? React.createElement('span', {
                key: 'size',
                className: 'dsm-qty',
                title: t('memory.size.tip', { size: fmtBytes(r.bytes) }),
              }, t('memory.size.tokens', { count: fmtTokensOfBytes(r.bytes) }))
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
            // 全局卡在搜索态可能被强行保留（里面还有自主记忆分节），此时桶不一定存在。
            var bucket = buckets[name] || { name: name, meta: null, rules: [] }
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
            // 搜索命中后的行；空桶在搜索态下可能整卡不可见，但全局卡会因自主记忆分节被强行保留。
            var bucketRows = rowsByBucket[name] || []

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

                    isOrphan ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('memory.scene.orphan.tag')) : null,
                    meta.active === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null),
                  // 场景备注紧跟名称下面一行（用户 2026-10-16：「备注是显示在名称下面，就像图2一样」），
                  // 收着卡片时也照读 —— 它是"这是哪个场景"的一部分，不是展开后才有的细节。
                  // 挂在卡头左侧那一列里、不是整行之下：整行的话右侧按钮把它和名称隔开，读着像页脚。
                  isOrphan || !meta.description ? null : React.createElement('span', { className: 'dsm-source-desc' }, meta.description)),
                React.createElement('div', { className: 'dsm-source-actions' },
                  // 每个场景一张卡：卡内的「全选 / 取消全选」只作用于**这张卡里的**记忆
                  // —— 用户说的「记忆的不同场景都缺少全选清空」。
                  isOrphan || !bucketRows.length ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: busy || scopeWriteLocked(anyLocked) || !cardToggles.length, onClick: function () { setMemories(cardToggles, !cardAllOn, 's:' + name) } }, bulkPair(cardAllOn ? t('bulk.unselectAll') : t('bulk.selectAll'), cardAllOn ? t('bulk.selectAll') : t('bulk.unselectAll'))),
                  // 卡内的「新建记忆」是写盘动作，锁定态必须置灰（用户 2026-10-12：
                  // 「场景锁定情况下新建记忆应该也是灰色的，不能点击」）—— 原先这里只看了 busy。
                  isOrphan ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || anyLocked, onClick: function () { openCreate(name) } }, t('memory.scene.new')))),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                isOrphan ? React.createElement('div', { className: 'dsm-source-note' }, t('memory.scene.orphan.hint')) : null,
                // 表头已随列表行两行制拆除（REDESIGN §3.4 没有表头行；tags 列并入行 2 元信息）。
                bucketRows.length
                  ? bucketRows.map(function (r) { return renderRuleRow(r, meta.active !== false) })
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
          /** 导出条目：按**场景**分组（记忆页的分组维度就是场景），组内只有名称。 */
          function memoryExportItems() {
            var sceneMeta = {}
            ;(data.scenes || []).forEach(function (s) { sceneMeta[s.name] = s })
            return exportableRules.map(function (r) {
              var scene = sceneOf(r.group)
              var meta = sceneMeta[scene]
              var label = (meta && (meta.label || meta.name)) || scene || t('memory.scene.orphan')
              return { key: r.id, name: r.name, group: label }
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
          var evb = React.useState(false)
          var evoBusy = evb[0], setEvoBusy = evb[1]
          var evoOrgState = React.useState(null)
          var evoOrg = evoOrgState[0], setEvoOrg = evoOrgState[1]
          // 后台复习队列：只用来在「有失败 / 无法处理」时给一个重试入口。
          var evq = React.useState(null)
          var evoQueue = evq[0], setEvoQueue = evq[1]
          // 自主记忆弹窗（设置入口）。与 `modal` 分开存：弹窗里点「删除 / 提升 / 整理」
          // 还要再开一层确认弹窗，共用一个槽会把自主记忆一起关掉。
          var eos = React.useState(false)
          var evoOpen = eos[0], setEvoOpen = eos[1]
          // 「查看待确认」弹窗（见 openEvolutionReview）。单独一个槽：它从记忆列表行打开，
          // 与设置弹窗不是同一件事，也不该互相关掉。
          var evr = React.useState(null)
          var evoReview = evr[0], setEvoReview = evr[1]
          // 学习频率的输入态：键 = `learnWindowMinutes` / `maxLearnsPerWindow`，值是未提交的
          // 字符串。输入框常态空着、当前值只在 placeholder 里灰显（与兼容页目录上限同一交互）。
          var evc = React.useState({})
          var evoRateEdits = evc[0], setEvoRateEdits = evc[1]
          // 可用模型清单（「复习模型」下拉框的选项）。`ready` 与空清单分开：
          // 前者管"还没取到"（退回文本框），后者管"取到了但一个都没有"（也退回文本框，
          // 但提示文案不同）。合成一个布尔会让加载中与真的没有模型看起来一样。
          var evms = React.useState({ ready: false, models: [] })
          var evoModelsState = evms[0], setEvoModelsState = evms[1]
          var evoModels = evoModelsState.models
          var evoModelsReady = evoModelsState.ready

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

          /**
           * 每次刷新带一个序号：只有**最后发出**的那次能落地。
           *
           * 没有它时，先发的慢请求（切会话、拨开关、弹卡确认几乎同时触发）会后到并覆盖
           * 新结果 —— 界面上表现为"刚拨的开关自己弹回去了"，而磁盘上的值其实是对的。
           */
          var evoSeq = 0
          function refreshEvolution() {
            var seq = ++evoSeq
            var sid = evoSessionId()
            var args = sid === '' ? {} : { sessionId: sid }
            Promise.all([
              apiCall('evolution-status', args),
              // 全量（含归档 / 已取代）：卡片自己按状态过滤，而「后台复习」那列要用它把
              // 历史快照翻译成**当前**状态 —— 只拿默认清单的话，已归档的条目查不到，
              // 那一行就只能一直挂着学习当时的「待确认」。
              apiCall('evolution-list', { all: true }),
              apiCall('evolution-queue', {}),
            ])
              .then(function (out) {
                // 已经有人发过更新的刷新：这次的结果作废，别用旧数据盖掉新的。
                if (seq !== evoSeq) return
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
                //
                // **合并而不是替换**：`busy` 由"重跑失败项"那个按钮自己管，替换会把正在
                // 跑的忙碌态抹掉，按钮于是重新可点 —— 连点两次就是两条重跑请求。
                setEvoQueue(function (cur) {
                  // 请求**失败**与"这版没接线"是两件事：
                  //   - `q` 为空 / `q.ok === false` 但 `cur` 已存在 → 保留上一次的数据，
                  //     只把错误挂上。整块置空会把失败项列表与它们的重试按钮一起抹掉，
                  //     而那正是用户此刻最需要点的东西。
                  //   - `cur` 也不存在 → 这一版确实没有队列接口，返回 null 让整块不渲染。
                  if (!q || q.ok === false) {
                    if (!cur) return null
                    var msg = q && q.ok === false ? translateError(t, q) : errMsg(new Error('no queue data'))
                    return Object.assign({}, cur, { error: msg })
                  }
                  var fresh = { stats: q.stats || {}, items: q.items || [], recent: q.recent || [], error: null }
                  return cur ? Object.assign({}, fresh, { busy: cur.busy }) : fresh
                })
              })
              .catch(function (e) {
                if (seq !== evoSeq) return
                setEvo({ loading: false, status: null, entries: [], settings: null, error: errMsg(e) })
              })
          }
          // 跟着「当前对话」重取，不跟「选中层」：切对话时这张卡必须跟着变。
          React.useEffect(function () { refreshEvolution() }, [scopeState.currentSessionId])
          // 模型清单：设置弹窗打开时取一次。取不到就一直是 `ready: false`，
          // 下拉框退回文本框（见 `renderEvolutionModelInput`）。
          React.useEffect(function () {
            if (!evoOpen || evoModelsState.ready) return
            apiCall('evolution-models', {}).then(function (r) {
              setEvoModelsState({ ready: true, models: (r && r.ok !== false && Array.isArray(r.models)) ? r.models : [] })
            }).catch(function () { setEvoModelsState({ ready: true, models: [] }) })
          }, [evoOpen, evoModelsState.ready])

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
              } else {
                // 失败也要重取：可能前面几条已经写成功（写是串行的），界面上那个开关
                // 必须回到磁盘上的真实值，否则用户看到的是"点了没反应"。
                setResult({ ok: false, text: translateError(t, bad) })
                refreshEvolution()
              }
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }); refreshEvolution() })
          }


          /** 自动确认：写全局设置；关掉时每次 learn 都会弹卡。 */
          function setEvolutionAutoConfirm(next) {
            setEvoBusy(true)
            apiCall('evolution-settings', { set: true, settings: { autoConfirm: next } }).then(function (res) {
              setEvoBusy(false)
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.saved') })
                refreshEvolution()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          /**
           * 提交学习频率的一项：数字 = 新值，空框 = 回默认值（服务端按 `null` 处理）。
           * 越界值由服务端归一化夹取；这里只挡掉非数字与负值。
           */
          function commitEvolutionRate(key) {
            var raw = evoRateEdits[key]
            if (raw === undefined) return
            var nextEdits = Object.assign({}, evoRateEdits)
            delete nextEdits[key]
            setEvoRateEdits(nextEdits)
            var text = String(raw).trim()
            var parsed = text === '' ? null : Number(text)
            var value = parsed === null ? null : (Number.isFinite(parsed) ? Math.floor(parsed) : null)
            // 学习频率两项的下限是 1（0 分钟窗口 / 0 条配额没有意义），但复习次数**允许 0**：
            // 那是「这个会话一次都不复习」的显式关法，与 `remaining()` 里 `cap = 0` 同一口径。
            if (value !== null && value < (key === 'maxReviewsPerSession' ? 0 : 1)) value = key === 'maxReviewsPerSession' ? 0 : 1
            var current = evo.settings && evo.settings[key]
            if (value !== null && current === value) return
            setEvoBusy(true)
            var settings = {}
            settings[key] = value
            apiCall('evolution-settings', { set: true, settings: settings }).then(function (res) {
              setEvoBusy(false)
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.saved') })
                refreshEvolution()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          /**
           * 待确认记忆的「查看」弹窗。
           *
           * 列表行只给一个入口：确认一条没看过的记忆是盲签 —— 而这条记忆之后会进入每一次
           * 对话的上下文。弹窗里读正文、逐条确认；确认完自动跳下一条，全部确认完自动关窗，
           * 左右两侧的箭头可以随时切换，不必关掉再点开。
           *
           * 快照取点开那一刻的候选清单：确认会让条目离开候选，实时重算会让下标在翻页时
           * 跳位。已确认的 id 记在 `done` 里，找下一条时跳过。
           */
          function candidateIdsNow() {
            return (evo.entries || [])
              .filter(function (e) { return e.status === 'candidate' })
              .map(function (e) { return String(e.id) })
          }

          /**
           * 证据来源的人话标签。
           *
           * 不直接用 `t('evo.tier.' + source)`：`t()` 缺键时回显 key 本身（`evo.tier.xxx`），
           * 而 `EvidenceSource` 是**旧数据里还有两个只读不写的取值**的联合类型 —— 任何
           * 一个漏配都会让用户看到一串英文键名。缺键退回来源原样，至少能读懂。
           */
          function evidenceSourceLabel(source) {
            var key = 'evo.tier.' + String(source || 'model_inference')
            var label = t(key)
            return label === key ? String(source || '') : label
          }

          function loadEvolutionReview(id) {
            apiCall('evolution-read', { id: id }).then(function (res) {
              setEvoReview(function (cur) {
                if (!cur || cur.id !== id) return cur
                if (!res || res.ok === false) {
                  return Object.assign({}, cur, { loading: false, error: translateError(t, res) })
                }
                var boundary = String(res.boundary || '').trim()
                var body = String(res.body || '')
                // 正文落盘时就把「边界：…」拼在了末尾（`renderBody`），而 frontmatter 里
                // 另有一份 `auto_boundary` —— 两个都渲染就是同一句话出现两遍。这里把正文里
                // 那一份摘掉，只留弹窗底部那行带标签的，读起来才是"正文 + 边界"两段。
                // 与服务端 `boundaryOfBody` 同一口径：两种标签都认（`边界：` / `Boundary:`），
                // 大小写不敏感。只认一种时，英文笔记的边界行会留在正文里，与底部那行重复。
                if (boundary !== '') {
                  var tailRe = /\s*(?:边界|Boundary)\s*[:：]\s*/i
                  var tailMatch = tailRe.exec(body)
                  while (tailMatch !== null) {
                    var after = body.slice(tailMatch.index + tailMatch[0].length)
                    // 只摘"标签 + 边界原文"且后面再无内容的那一处：正文里自己写的同名行
                    // 属于内容，吞掉就是丢数据。
                    if (after.trim() === boundary || after.trim() === '') {
                      body = body.slice(0, tailMatch.index).replace(/\s+$/, '')
                      break
                    }
                    tailRe.lastIndex = tailMatch.index + tailMatch[0].length
                    tailMatch = tailRe.exec(body)
                  }
                }
                // 证据链：`describe()` 一直在返回它（`state.evidence`），而界面从没读过 ——
                // 用户在"确认 / 否决"这条时最需要看到的正是「凭什么记这条」：一句用户原话
                // 比模型自己的措辞有力得多。只取来源与引句，时间线不进这个弹窗（信息过载）。
                var ev = (res.state && Array.isArray(res.state.evidence)) ? res.state.evidence : []
                // 只留**真正的用户原话**：`model_inference` 档位的 quote 是正文本身
                //（`runGates` 的 `quote: quote || rawText`），把它当证据展示就是同一段话
                // 在弹窗里出现两遍 —— 而它证明不了任何事。
                var evidence = ev.slice(-3).map(function (x) {
                  return { source: String((x && x.source) || ''), quote: String((x && x.quote) || '') }
                }).filter(function (x) {
                  if (x.quote === '') return false
                  if (x.source === 'model_inference') return false
                  return x.quote !== body
                })
                return Object.assign({}, cur, {
                  loading: false,
                  title: String(res.title || ''),
                  body: body,
                  layer: String(res.layer || ''),
                  kind: String(res.kind || ''),
                  status: String(res.status || ''),
                  boundary: boundary,
                  evidence: evidence,
                  // 模型自己写的「凭什么」（`auto_basis`）：与证据链互补 —— 证据是原话，
                  // basis 是它当时的判断依据。两者都不显示时，用户只能看到一句结论，
                  // 既无法核对也无法反驳。
                  //
                  // 与正文相同的 basis 丢掉：真实数据里模型常把正文原样再写一遍当依据，
                  // 于是弹窗里同一段话出现两次，反而看不出重点。
                  basis: (function (b) {
                    var v = String(b || '').trim()
                    if (v === '') return ''
                    if (v === body.trim()) return ''
                    // 正文是依据的前缀（或反之）也算重复：模型常把正文加一句解释当依据。
                    if (v.length > 40 && (v.indexOf(body.trim()) === 0 || body.trim().indexOf(v) === 0)) return ''
                    return v
                  })(res.basis),
                  error: null,
                })
              })
            }).catch(function (err) {
              setEvoReview(function (cur) {
                return cur && cur.id === id ? Object.assign({}, cur, { loading: false, error: errMsg(err) }) : cur
              })
            })
          }

          function openEvolutionReview(e) {
            setResult(null)
            var ids = candidateIdsNow()
            var at = ids.indexOf(String(e.id))
            if (at < 0) { ids = [String(e.id)]; at = 0 }
            setEvoReview({ ids: ids, index: at, id: ids[at], done: {}, title: '', body: '', layer: '', kind: '', status: '', boundary: '', evidence: [], basis: '', loading: true, busy: false, error: null })
            loadEvolutionReview(ids[at])
          }

          /**
           * 左右切换：首尾相接，1-2-3-1-2-3 循环。
           *
           * 到头绕回另一端，而不是置灰停住 —— 待确认清单是一轮一轮过的，走到底时最自然的
           * 动作是回开头看还有没有漏的，而不是去关窗重开。
           *
           * 只有一条时不绕：原地不动，否则点一下还是自己，看起来像按钮坏了。
           */
          function stepEvolutionReview(dir) {
            var cur = evoReview
            if (!cur || cur.busy) return
            var n = cur.ids.length
            if (n <= 1) return
            var next = ((cur.index + dir) % n + n) % n
            var id = cur.ids[next]
            setEvoReview(Object.assign({}, cur, { index: next, id: id, loading: true, title: '', body: '', error: null }))
            loadEvolutionReview(id)
          }

          /**
           * 处理完当前这条（确认 / 否决）后进入下一条未处理的；全都处理完自动关窗。
           *
           * 分母（`ids`）**随处理递减**：确认 / 否决会让条目离开候选清单，快照里还留着它
           * 就会显示「第 2 条 / 共 3 条」而实际只剩 2 条待处理 —— 那个 3 再也不会变小。
           * 所以每次处理完先把刚处理的 id 从 `ids` 里摘掉，再按新数组定位下一条。
           *
           * 先往后找、再从头上找：左右翻过页再处理时不会漏掉前面剩下的。
           */
          function stepAfterEvolutionReview(cur, done, okText) {
            refreshEvolution()
            var rest = cur.ids.filter(function (x) { return done[x] !== true })
            if (rest.length === 0) {
              setEvoReview(null)
              setResult({ ok: true, text: okText })
              return
            }
            // 下一条按**原顺序**找当前之后第一个未处理的；到末尾则绕回开头。
            var at = cur.ids.indexOf(cur.id)
            var nid = null
            for (var i = at + 1; i < cur.ids.length; i++) {
              if (done[cur.ids[i]] !== true) { nid = cur.ids[i]; break }
            }
            if (nid === null) {
              for (var j = 0; j < cur.ids.length; j++) {
                if (done[cur.ids[j]] !== true) { nid = cur.ids[j]; break }
              }
            }
            if (nid === null) {
              setEvoReview(null)
              setResult({ ok: true, text: okText })
              return
            }
            // 序号按**剩余清单**算：显示的是「这条在还剩的几条里排第几」。
            var next = rest.indexOf(nid)
            setEvoReview({ ids: rest, index: next, id: nid, done: done, title: '', body: '', layer: '', kind: '', status: '', boundary: '', evidence: [], basis: '', loading: true, busy: false, error: null })
            loadEvolutionReview(nid)
          }

          /** 确认当前这条 → 自动进入下一条未处理的。 */
          function approveEvolutionInReview() {
            var cur = evoReview
            if (!cur || cur.busy || cur.loading) return
            var id = cur.id
            setEvoReview(Object.assign({}, cur, { busy: true, error: null }))
            apiCall('evolution-approve', { id: id }).then(function (res) {
              if (!res || res.ok === false) {
                setEvoReview(function (c) {
                  return c && c.id === id ? Object.assign({}, c, { busy: false, error: translateError(t, res) }) : c
                })
                return
              }
              var done = Object.assign({}, cur.done)
              done[id] = true
              stepAfterEvolutionReview(cur, done, t('evo.approved'))
            }).catch(function (e) {
              setEvoReview(function (c) {
                return c && c.id === id ? Object.assign({}, c, { busy: false, error: errMsg(e) }) : c
              })
            })
          }

          /**
           * 否决当前这条 → 正文移进统一回收站，然后进入下一条。
           *
           * 不用 `evolution-forget`：那条会写墓碑，30 天内同义内容学不回来 ——
           * 「这条我不要」和「这个说法以后都别记」是两件事，否决只该表达前一件。
           */
          function rejectEvolutionInReview() {
            var cur = evoReview
            if (!cur || cur.busy || cur.loading) return
            var id = cur.id
            setEvoReview(Object.assign({}, cur, { busy: true, error: null }))
            apiCall('evolution-discard', { id: id }).then(function (res) {
              if (!res || res.ok === false) {
                setEvoReview(function (c) {
                  return c && c.id === id ? Object.assign({}, c, { busy: false, error: translateError(t, res) }) : c
                })
                return
              }
              var done = Object.assign({}, cur.done)
              done[id] = true
              stepAfterEvolutionReview(cur, done, t('evo.rejected'))
            }).catch(function (e) {
              setEvoReview(function (c) {
                return c && c.id === id ? Object.assign({}, c, { busy: false, error: errMsg(e) }) : c
              })
            })
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

          /**
           * 编辑弹窗标题：按层区分。
           *
           * 列表里全局与各工作区的条目同屏，只写「编辑自主记忆」时用户看不出改的是哪一层 ——
           * 而层正是这条记忆的作用范围（全局每条对话都生效）。工作区名取列表回包里的
           * `workspaceLabel`，拿不到时退成 hash 前 8 位（与卡内分节同一套兜底）。
           */
          function evolutionEditorTitle(e) {
            if (e && e.layer === 'workspace') {
              var name = String(e.workspaceLabel || '').trim() || shortWorkspaceHash(String(e.workspace || ''))
              return t('evo.edit.title.workspace', { name: name })
            }
            return t('evo.edit.title.global')
          }

          /** 打开编辑弹窗：先读正文（列表回包里不带正文，省流量）。 */
          function openEvolutionEditor(e) {
            setResult(null)
            apiCall('evolution-read', { id: e.id }).then(function (res) {
              if (res && res.ok !== false) {
                setModal({ type: 'evo-edit', entry: e, title: String(res.title || ''), body: String(res.body || ''), hash: String(res.hash || ''), kind: String(res.kind || ''), busy: false, error: null })
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (err) { setResult({ ok: false, text: errMsg(err) }) })
          }

          /** 保存正文：只改正文，层 / 状态 / 证据不变。 */
          function saveEvolutionEditor() {
            if (!modal || modal.type !== 'evo-edit' || modal.busy) return
            var body = String(modal.body || '').trim()
            if (body === '') {
              setModal(Object.assign({}, modal, { error: t('evo.edit.empty') }))
              return
            }
            var entry = modal.entry
            setModal(Object.assign({}, modal, { busy: true, error: null }))
            apiCall('evolution-update', {
              id: entry.id,
              title: String(modal.title || '').trim(),
              text: body,
              baseHash: modal.hash || '',
              // 空串 = 这条旧数据没写 kind，保持原样；有值才传，服务端会重算保质期。
              ...(modal.kind ? { kind: modal.kind } : {}),
            }).then(function (res) {
              if (res && res.ok !== false) {
                setModal(null)
                setResult({ ok: true, text: t('evo.edit.saved') })
                refreshEvolution()
              } else {
                setModal(Object.assign({}, modal, {
                  busy: false,
                  error: res && res.code === 'stale' ? t('evo.edit.stale') : translateError(t, res),
                }))
              }
            }).catch(function (err) {
              setModal(Object.assign({}, modal, { busy: false, error: errMsg(err) }))
            })
          }

          /** 复核：清掉「待复核」标记并重置计时（不改正文、不改状态）。 */
          function reviewEvolution(id) {
            setEvoBusy(true)
            apiCall('evolution-review', { id: id }).then(function (res) {
              setEvoBusy(false)
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.review.reviewed') })
                refreshEvolution()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          /** 行内开关：只拨启用位；关闭的条目留在列表里，删除才进回收站。 */
          function toggleEvolutionEnabled(id, enabled) {
            setEvoBusy(true)
            apiCall('evolution-set-enabled', { id: id, enabled: enabled }).then(function (res) {
              setEvoBusy(false)
              if (res && res.ok !== false) {
                setResult({ ok: true, text: enabled ? t('evo.enabled') : t('evo.disabled') })
                refreshEvolution()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          /** 算整理草案（只读）。结果留在卡片里，用户逐条「应用」。 */
          function runOrganize() {
            setEvoOrg({ busy: true, drafts: null, scanned: 0, error: null })
            // 全局与本工作区一起扫：只扫本工作区时，全局条目永远进不了整理建议，
            // 用户看到的是「无需整理」，会以为整理没跑。
            apiCall('evolution-organize', { scope: 'all' }).then(function (res) {
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
            setEvoQueue(function (cur) { return cur ? Object.assign({}, cur, { busy: true }) : { stats: {}, items: [], recent: [], error: null, busy: true } })
            var args = id ? { id: id } : {}
            apiCall('evolution-replay', args).then(function (res) {
              // **两条路都要清 busy**：`refreshEvolution` 是「合并而不是替换」，它会把
              // 正在跑的 `busy` 原样保留下来（那是为了防连点）。所以成功分支只调 refresh
              // 等于把按钮永久禁用在"忙碌中"—— 重跑一次之后再也点不动，只能切走再回来。
              if (res && res.ok !== false) {
                setResult({ ok: true, text: id ? t('evo.queue.retried') : t('evo.queue.done', { attempted: Number(res.attempted) || 0 }) })
                setEvoQueue(function (cur) { return cur ? Object.assign({}, cur, { busy: false }) : cur })
                refreshEvolution()
              } else {
                setEvoQueue(function (cur) { return cur ? Object.assign({}, cur, { busy: false, error: translateError(t, res) }) : null })
              }
            }).catch(function (e) {
              setEvoQueue(function (cur) { return cur ? Object.assign({}, cur, { busy: false, error: errMsg(e) }) : null })
            })
          }

          /**
           * 行名：模型给的标题优先；旧条目没有标题时取正文第一个分句。
           * 只用于展示，不写盘 —— 用户在编辑弹窗里补的名称才会成为 title。
           */
          function evolutionNameOf(e) {
            var given = String(e.title || '').trim()
            if (given !== '') return given
            var text = String(e.oneLine || '').trim()
            if (text === '') return String(e.id || '')
            var cut = text.split(/[，,。；;：:！!？?\n]/, 1)[0].trim()
            if (cut === '') return text
            return cut.length > 24 ? cut.slice(0, 24) + '…' : cut
          }

          /**
           * 一行自动记忆，与其他记忆行同构：名称 + 正文，右侧开关 / 确认，⋯ 里编辑与删除。
           * 行名不可点：详情走编辑弹窗，点一下不该把整张列表推开。
           */
          function renderEvolutionRow(e) {
            // core / playbook 是旧数据里仍可注入的两档，按「生效」显示，不标成待确认。
            var statusKey = e.status === 'core' ? 'evo.tag.core'
              : e.status === 'active' || e.status === 'playbook' ? 'evo.tag.active'
                : 'evo.tag.candidate'
            var enabled = e.enabled !== false
            var tone = !enabled ? 'idle' : e.status === 'core' || e.status === 'active' || e.status === 'playbook' ? 'ok' : e.status === 'candidate' ? 'warn' : 'idle'
            var pending = e.status === 'candidate'
            var title = evolutionNameOf(e)
            var body = String(e.oneLine || '').trim()
            var metaBits = []
            // 名称与正文相同（短句旧条目）时不重复第二行。
            if (body !== '' && body !== title) {
              metaBits.push(React.createElement('span', { key: 'body', className: 'dsm-listrow-meta-desc', title: body }, body))
            }
            if (e.wsMissing) metaBits.push(React.createElement('span', { key: 'ws', className: 'dsm-listrow-meta-info' }, t('evo.ws.missing')))
            // 类型：它决定这条会不会过期（事实 / 做法 30 天后提醒复核，偏好 / 纠正不过期）。
            // 列表原本只在复习卡片与编辑弹窗里显示类型，于是用户看到「待复核」却不知道为什么
            // 这条要复核 —— 而原因正是它的类型。只在有值时渲染，旧数据没有这个字段。
            // 类型放在**名称旁边**、加灰边框：它决定这条会不会过期（事实 / 做法 30 天后提醒
            // 复核，偏好 / 纠正不过期），属于「这条是什么」而不是「这条说了什么」，
            // 跟正文摘要挤在一行会被长摘要挤掉。
            var kindTag = null
            var kindLabel = ''
            var kindTtl = ''
            if (e.kind) {
              var kindKey = 'evo.kind.' + String(e.kind)
              var kindText = t(kindKey)
              // 字典里没有这个值时 `t` 会原样回传键名：宁可不显示，也不要把 `evo.kind.xxx` 摆给用户看。
              if (kindText !== kindKey) {
                kindLabel = kindText
                // 保质期与复习弹窗同一判据：事实 / 做法 30 天后提醒复核，偏好 / 纠正不过期。
                kindTtl = (e.kind === 'fact' || e.kind === 'procedure')
                  ? t('evo.review.kind.ttl30')
                  : t('evo.review.kind.ttlForever')
                kindTag = React.createElement('span', { key: 'kind', className: 'dsm-kind-tag' }, kindText)
              }
            }
            // 待复核：维护扫描挂的 `reviewDue`。**不影响注入** —— 它只提示"这条 30 天没动过了"，
            // 用户看一眼确认仍然成立就点菜单里的「复核」，计时重新开始。
            // 与 `pendingReason`（待裁决，不注入）是两个字段：合成一个就会出现
            // "提醒一下 → 这条从上下文里消失"，界面还显示生效。
            //
            // `reviewDue` 不是日期：维护扫描写进去的是标记串（如 `ttl`）。直接当 tooltip 会把
            // 内部标记摆给用户看，所以这里换成本地的一句话，类型已知时带上类型。
            if (e.reviewDue) metaBits.push(React.createElement('span', { key: 'review', className: 'dsm-listrow-meta-info' }, t('evo.review.needed')))
            var reviewTip = ''
            if (e.reviewDue) {
              reviewTip = kindLabel !== ''
                ? t('evo.review.tip', { kind: kindLabel, ttl: kindTtl })
                : t('evo.review.tipNoKind')
            }
            // 停用由行内开关承担（与记忆行同构）；菜单里只留编辑、复核与删除。
            var menuItems = [
              { key: 'edit', label: t('btn.edit'), disabled: evoBusy, onClick: function () { openEvolutionEditor(e) } },
              ...(e.reviewDue ? [{ key: 'reviewed', label: t('evo.review.done'), disabled: evoBusy, onClick: function () { reviewEvolution(e.id) } }] : []),
              { key: 'forget', label: t('evo.forget'), danger: true, disabled: evoBusy, onClick: function () { setModal({ type: 'evo-delete', entry: e }) } },
            ]
            return React.createElement(ListRow, {
              key: e.id,
              dots: [React.createElement(StatusDot, { key: 'd', tone: tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'idle', title: enabled ? t(statusKey) : t('evo.tag.off') })],
              name: title,
              nameAfter: React.createElement('span', { className: 'dsm-qty' }, t('memory.size.tokens', { count: Number(e.tokens) || 0 })),
              tag: kindTag,
              meta: metaBits.length ? metaBits : undefined,
              metaTitle: e.pendingReason || reviewTip || undefined,
              // 候选行右侧是「查看」：先读正文再决定要不要它 —— 确认一条没看过的记忆是盲签，
              // 而它会进入之后每一次对话的上下文。生效行是开关，与记忆行同一语义：
              // 关 = 不再注入，条目保留。
              side: pending
                ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: evoBusy, onClick: function () { openEvolutionReview(e) } }, t('evo.review.open'))
                : React.createElement(Switch, {
                  on: enabled,
                  disabled: evoBusy,
                  label: (enabled ? t('evo.disable') : t('evo.enable')) + ' ' + title,
                  onClick: function () { toggleEvolutionEnabled(e.id, !enabled) },
                }),
              actions: [React.createElement(RowMenu, {
                key: 'menu',
                label: t('evo.menu', { name: title }),
                items: menuItems,
              })],
            })
          }

          /** 复习时间的本地显示；无效时间不显示，避免界面出现 Invalid Date。 */
          function evoTimeText(at) {
            var d = new Date(at)
            return isNaN(d.getTime()) ? '' : d.toLocaleString()
          }
          /**
           * 行内时间：当天只给时分，跨天补上日期。
           *
           * 只写时分会把前几天的记录显示成和今天一模一样的一串数字 —— 那正是「最近」这一列
           * 最容易读错的地方（用户 2026-11-11 实测）。
           */
          function evoTimeShort(at) {
            var d = new Date(at)
            if (isNaN(d.getTime())) return ''
            var hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            var now = new Date()
            var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
            if (sameDay) return hhmm
            var md = (d.getMonth() + 1) + '-' + d.getDate()
            return d.getFullYear() === now.getFullYear() ? md + ' ' + hhmm : d.getFullYear() + '-' + md + ' ' + hhmm
          }

          /**
           * 后台复习：最近学到的条目 + 失败项。
           *
           * 复习完全在后台跑，用户唯一的观察窗口就是「学到了什么」。只报失败数字会让
           * 「开了开关但什么都没学」和「这几轮确实没什么可记」长得一模一样。
           */
          function renderEvolutionReview() {
            if (!evoQueue) return null
            var s = evoQueue.stats || {}
            var failed = Number(s.failed) || 0
            var dead = Number(s.dead) || 0
            var orphan = Number(s.orphan) || 0
            var recent = evoQueue.recent || []
            var busy = !!evoQueue.busy
            var seen = {}
            var learned = []
            recent.forEach(function (run) {
              (run.learnedItems || []).forEach(function (item) {
                var id = String(item.id || '')
                if (id !== '' && seen[id]) return
                if (id !== '') seen[id] = true
                // 只留**现在还留着**的条目（用户 2026-11-11）：归档、已取代、已删除的都是
                // 历史，它们在「已学」里也算过一遍，再挂在这里只会越积越多。
                var cur = (evo.entries || []).find(function (x) { return x.id === id })
                if (cur === undefined) return
                var st = String(cur.status || '')
                if (st !== 'candidate' && st !== 'active' && st !== 'core' && st !== 'playbook') return
                learned.push({ item: item, at: run.at })
              })
            })
            learned = learned.slice(0, 5)
            var lastAt = recent.length > 0 ? recent[0].at : ''

            // orphan 也算失败：episode 文件没了，这条永远不会自己好，但用户得看得见
            // （它不进 failed/dead 计数，只出现在这份列表里）。
            var failures = (evoQueue.items || []).filter(function (x) {
              return x.status === 'failed' || x.status === 'dead' || x.status === 'orphan'
            })
            var emptyLine = null
            if (learned.length === 0) {
              if (recent.length > 0) emptyLine = t('evo.review.nothing')
              else if (failures.length === 0) emptyLine = t('evo.review.empty')
            }
            // 学到的那几行默认收起（用户 2026-11-11）：它是**历史**，不是待办。开着只会让
            // 「学习记录」这张卡越翻越长，而真正需要动手的是下面的失败项 —— 那一块不折叠。
            var reviewOpen = collapsed['evo:review'] === true
            return React.createElement('div', { className: 'dsm-evo-review' },
              // 标题行在框外（与学习频率同版式）：左边是可折叠的标题，右边是最近时间与重试。
              React.createElement('div', { className: 'dsm-evo-review-head' },
                React.createElement('button', {
                  type: 'button', className: 'dsm-evo-section-title dsm-evo-review-toggle',
                  'aria-expanded': reviewOpen && learned.length > 0,
                  disabled: learned.length === 0,
                  onClick: function () { toggleCollapse('evo:review', !reviewOpen) },
                },
                  learned.length > 0 ? React.createElement(CaretIcon, { key: 'caret', open: reviewOpen, className: 'dsm-evo-review-caret' }) : null,
                  t('evo.queue.title')),
                lastAt ? React.createElement('span', { className: 'dsm-help' }, t('evo.review.last', { time: evoTimeText(lastAt) })) : null,
                (failed + dead + orphan > 0)
                  ? React.createElement('button', {
                      type: 'button',
                      className: 'dsm-btn dsm-btn-quiet',
                      disabled: busy,
                      onClick: function () { replayEvolution() },
                    }, busy ? t('evo.queue.busy') : t('evo.queue.retryAll'))
                  : null),
              // 有列表或空态才画框：收起时只剩标题行，别留一个空框。
              (learned.length > 0 && reviewOpen) || emptyLine
                ? React.createElement('div', { className: 'dsm-evo-box' },
                learned.length > 0 && reviewOpen
                  ? React.createElement('div', { className: 'dsm-evo-review-list' },
                      learned.map(function (row, i) {
                        var item = row.item
                        // 合并进已有条目时，learn 返回的是旧 id；标题以列表里的当前名为准，
                        // 否则会出现「复习记录里的名字」和「记忆列表里的名字」不一样。
                        var hit = (evo.entries || []).find(function (x) { return x.id === item.id })
                        var title = hit ? evolutionNameOf(hit)
                          : (String(item.title || '').trim() || evolutionNameOf({ oneLine: item.text, id: item.id }))
                        var body = String(item.text || '').trim()
                        // 状态取**现在**的，不取学习当时的：`learnedItems` 是那一刻的快照，
                        // 之后确认 / 否决 / 删除都不会回写它。上面的过滤已经只放行
                        // candidate / active / core / playbook 四种，这里只剩「待确认」与「生效」。
                        var nowStatus = hit ? String(hit.status || '') : ''
                        var statusKey = nowStatus === 'candidate' ? 'evo.tag.candidate' : 'evo.tag.active'
                        var statusTone = nowStatus === 'candidate' ? 'dsm-tag-warn' : 'dsm-tag-on'
                        return React.createElement('div', { key: String(item.id || '') + ':' + i, className: 'dsm-evo-review-row' },
                          React.createElement('div', { className: 'dsm-evo-review-main' },
                            React.createElement('span', { className: 'dsm-evo-review-title' }, title),
                            body !== '' && body !== title
                              ? React.createElement('span', { className: 'dsm-evo-review-body', title: body }, body)
                              : null),
                          React.createElement('div', { className: 'dsm-evo-review-meta' },
                            React.createElement('span', { className: 'dsm-tag' }, item.layer === 'global' ? t('evo.scope.global') : t('evo.scope.workspace')),
                            React.createElement('span', { className: 'dsm-tag' + (statusTone !== '' ? ' ' + statusTone : '') }, t(statusKey)),
                            // 类型决定保质期，复习记录里也要显示：否则「这次学到了什么」看不到
                            // 它会不会过一阵被催着复核。旧快照没这个字段，缺失时整格不渲染。
                            (function () {
                              var kk = String(item.kind || '')
                              var label = kk === '' ? '' : t('evo.kind.' + kk)
                              // 字典里没有这个值时 `t` 原样回传键名：宁可不显示，也别摆键名给用户。
                              if (label === '' || label === 'evo.kind.' + kk) return null
                              return React.createElement('span', { className: 'dsm-tag' }, label)
                            })(),
                            React.createElement('span', null, evoTimeShort(row.at))))
                      }))
                  : (emptyLine ? React.createElement('p', { className: 'dsm-evo-review-empty' }, emptyLine) : null))
                : null,
              // 失败项常显、不折叠：它是这一段里唯一需要动手的东西。
              failures.length > 0
                ? React.createElement('div', { className: 'dsm-evo-box dsm-evo-review-fails' },
                    React.createElement('span', { className: 'dsm-help' }, t('evo.queue.failStat', { failed: failed, dead: dead, orphan: orphan })),
                    failures.map(function (x) {
                      var reason = String(x.reason || '')
                      return React.createElement('div', { key: x.id, className: 'dsm-evo-review-row' },
                        React.createElement('div', { className: 'dsm-evo-review-main' },
                          React.createElement('span', { className: 'dsm-evo-review-title dsm-evo-review-fail' },
                            x.status === 'dead' ? t('evo.review.dead')
                              : x.status === 'orphan' ? t('evo.review.orphan')
                                : t('evo.review.fail')),
                          reason ? React.createElement('span', { className: 'dsm-evo-review-body', title: reason }, reason) : null),
                        React.createElement('div', { className: 'dsm-evo-review-meta' },
                          React.createElement('span', null, evoTimeShort(x.at)),
                          // orphan 不给「重试」：它的 episode 文件已经没了，重试只会返回 ok 而
                          // 状态不变 —— 用户会以为按钮坏了，反复点。这里明说只能清掉。
                          x.status === 'orphan'
                            ? React.createElement('span', { className: 'dsm-help' }, t('evo.review.orphanHint'))
                            : React.createElement('button', {
                              type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy,
                              onClick: function () { replayEvolution(x.id) },
                            }, t('evo.review.retry'))))
                    }))
                : null,
              evoQueue.error ? React.createElement(Notice, { kind: 'err', text: evoQueue.error }) : null)
          }


          /** 生效（active/core/playbook）且没被停用的行才算"开"，与场景卡同一读法。 */
          function evolutionOnCount(rows) {
            return rows.filter(function (e) { return (e.status === 'active' || e.status === 'core' || e.status === 'playbook') && e.enabled !== false }).length
          }

          /**
           * 过滤一组自主记忆：搜索命中 + 丢掉已归档 / 已取代，并算出生效数。
           *
           * 已归档不再出现在自主记忆目录里：否决与删除都把正文移进了统一回收站，
           * 恢复入口只有回收站一个，这里不需要第二套。
           */
          function evolutionGroupView(groups) {
            return (groups || []).map(function (g) {
              var rows = g.rows
              // 搜索词与场景卡同源同口径：一行摘要 / id 命中即留（大小写不敏感）。
              if (q !== '') {
                rows = rows.filter(function (e) {
                  var hay = String(e.oneLine || '') + ' ' + String(e.id || '')
                  return hay.toLowerCase().indexOf(q) >= 0
                })
              }
              var live = rows.filter(function (e) { return e.status !== 'archived' && e.status !== 'superseded' })
              return { key: g.key, label: g.label, live: live, on: evolutionOnCount(live) }
            })
          }

          /** 分节线：短线 + 名称(启用/总数) + 长线。计数紧跟名称，用英文小括号。 */
          function renderEvolutionDivider(key, label, on, total) {
            return React.createElement('div', { key: key, className: 'dsm-evo-divider' },
              React.createElement('span', { className: 'dsm-evo-divider-line dsm-evo-divider-line-start' }),
              React.createElement('span', { className: 'dsm-evo-divider-label' },
                React.createElement('span', { className: 'dsm-evo-divider-name' }, String(label || '')),
                React.createElement('span', { className: 'dsm-evo-divider-count' }, '(' + on + '/' + total + ')')),
              React.createElement('span', { className: 'dsm-evo-divider-line' }))
          }

          /**
           * 工作区自主记忆卡。`groups` 是这张卡要展示的工作区分组，组间画分节线。
           * `cardKey` 同时是折叠状态的键。
           *
           * 复用场景卡的骨架（.dsm-source），行沿用 renderEvolutionRow（ListRow）：
           * 名称 + 正文，候选行右侧有「确认」，生效行右侧是开关（关闭只停止注入，否决与删除都进回收站）。
           * 卡头右侧的「设置」开设置弹窗（两层开关 / 风格 / 整理），卡片本身只管展示与逐条操作。
           *
           * 已归档 / 已否决 / 已删除都不在这里：正文已经移进统一回收站，恢复入口只有回收站。
           */
          function renderEvolutionCard(opts) {
            var layerOn = opts.layerOn
            var groups = evolutionGroupView(opts.groups)
            var total = 0
            var onCount = 0
            groups.forEach(function (g) {
              total += g.live.length
              onCount += g.on
            })
            // 一条生效的都没有 → 不渲染：空卡只占空间。
            if (total === 0) return null
            // 默认展开跟总开关走（开 = 这里就是它注入的清单，该一眼能看）；手动收起的以手动为准。
            var openFlag = collapsed[opts.cardKey]
            var baseOpen = openFlag === undefined ? layerOn : openFlag !== true
            var open = baseOpen || q !== ''
            var body = []
            groups.forEach(function (g) {
              if (g.live.length === 0) return
              body.push(renderEvolutionDivider('h:' + g.key, g.label, g.on, g.live.length))
              body = body.concat(g.live.map(function (e) { return renderEvolutionRow(e) }))
            })
            // 总开关开 = 卡照常；关 = 整卡置灰（条目还在盘上，只是不再注入）。
            return React.createElement('div', { key: opts.cardKey, className: 'dsm-source' + (layerOn ? '' : ' dsm-rule-off') },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main dsm-source-head-stack', 'aria-expanded': open, onClick: function () { toggleCollapse(opts.cardKey, baseOpen) } },
                  React.createElement('span', { className: 'dsm-source-head-line' },
                    React.createElement('span', { className: 'dsm-source-title' }, opts.title),
                    React.createElement('span', { className: 'dsm-count dsm-count-tight' }, t('memory.scene.count', { on: onCount, total: total })))),
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
           * 工作区记忆卡：`_ws/<hash16>` 下的**用户手写**条目，卡内按工作区分节。
           *
           * 与自主记忆的工作区卡是两张卡：前者是用户自己写的资产（永久、不衰减、不进整理），
           * 后者是 agent 的缓存（会老化、会被合并、会进回收站）。合成一张会让"删掉这条"
           * 在两套语义之间摇摆。
           */
          function renderWorkspaceCard() {
            var groups = (view.wsGroups || []).map(function (g) {
              return { key: g.key, label: g.label, rows: g.rules, on: g.rules.filter(function (r) { return r.enabled !== false }).length }
            })
            var total = 0
            groups.forEach(function (g) { total += g.rows.length })
            if (total === 0) return null
            var cardKey = 'ws:memories'
            var openFlag = collapsed[cardKey]
            var baseOpen = openFlag === undefined ? true : openFlag !== true
            var open = baseOpen || !!q
            var body = []
            groups.forEach(function (g) {
              if (g.rows.length === 0) return
              body.push(renderEvolutionDivider('h:' + g.key, g.label, g.on, g.rows.length))
              body = body.concat(g.rows.map(function (r) { return renderRuleRow(r, true) }))
            })
            var onCount = groups.reduce(function (n, g) { return n + g.on }, 0)
            return React.createElement('div', { key: cardKey, className: 'dsm-source' },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main dsm-source-head-stack', 'aria-expanded': open, onClick: function () { toggleCollapse(cardKey, baseOpen) } },
                  React.createElement('span', { className: 'dsm-source-head-line' },
                    React.createElement('span', { className: 'dsm-source-title' }, t('memory.card.workspace')),
                    React.createElement('span', { className: 'dsm-count dsm-count-tight' }, t('memory.scene.count', { on: onCount, total: total })))),
                React.createElement('div', { className: 'dsm-source-actions' },
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || anyLocked, onClick: function () { openCreateWorkspace() } }, t('memory.scene.new')))),
              open ? React.createElement('div', { className: 'dsm-source-body' }, body) : null)
          }

          /**
           * 在「这个项目」下新建一条工作区记忆。
           *
           * 落点取**这张卡当前显示的分组**，而不是 `curWorkspace.group`：后者来自
           * `evo.status.workspace`（自主记忆那条链路），拿不到时为 null —— 那时点按钮
           * 只会静默什么都不做。卡上已经有分组了，直接用它最稳。
           */
          function openCreateWorkspace() {
            var group = (curWorkspace && curWorkspace.group) || ''
            if (group === '') {
              // 退到卡上实际显示的第一组：它一定对应一个真实的 `_ws/<hash>` 目录。
              var ws = view.wsGroups || []
              for (var i = 0; i < ws.length; i++) {
                var k = String((ws[i] && ws[i].key) || '')
                if (k.indexOf('_ws/') === 0) { group = k; break }
              }
            }
            if (group === '') {
              // Notice 读的是 `text`（`error` 字段不会显示），用错键会让这次点击完全没反馈。
              setResult({ ok: false, text: t('memory.workspace.noCwd') })
              return
            }
            setEditor(draftForCreate(group))
            // 只设 editor 不开弹窗，点了什么也不会发生 —— 编辑器是模态框，必须显式打开。
            setModal({ type: 'editor' })
          }

          /**
           * 自主记忆的工作区卡：所有工作区合成一张，卡内按工作区名称分节。
           * 别的仓库的条目只展示，不会注入当前对话。
           */
          function renderEvolutionCards() {
            if (sceneFilter !== '') return []
            var all = evo.entries || []
            var currentHash = (evo.status && evo.status.workspace && evo.status.workspace.hash) || ''
            // 当前工作区可能还没写进 workspaces.json（从没拨过开关）：status 会按 cwd 给个名字。
            var currentLabel = (evo.status && evo.status.workspace && evo.status.workspace.label) || ''
            var groups = []
            var byHash = {}
            all.forEach(function (e) {
              if (e.layer !== 'workspace') return
              var hash = String(e.workspace || '')
              var group = byHash[hash]
              if (group === undefined) {
                group = byHash[hash] = { key: hash || 'unknown', rows: [], label: '' }
                groups.push(group)
              }
              group.rows.push(e)
              if (group.label === '') group.label = String(e.workspaceLabel || '')
            })
            groups.forEach(function (group) {
              if (group.label === '' && group.key === (currentHash || 'unknown')) group.label = currentLabel
            })
            // 当前对话的工作区排最前；其余按名称排，没有名称的按 hash。
            groups.sort(function (a, b) {
              var aCur = a.key === (currentHash || 'unknown')
              var bCur = b.key === (currentHash || 'unknown')
              if (aCur && !bCur) return -1
              if (bCur && !aCur) return 1
              return a.label.localeCompare(b.label) || a.key.localeCompare(b.key)
            })
            groups.forEach(function (group) {
              if (group.label === '') group.label = shortWorkspaceHash(group.key === 'unknown' ? '' : group.key)
            })
            // 一张「自主记忆」卡，卡内两节：全局 → 各工作区。
            //
            // 全局自主**不并进「全局记忆」卡**：自主记忆是 agent 自己的缓存，与用户手写的
            // 全局记忆是两类东西（一个会老化、会被合并、进回收站；一个永久、不衰减）。
            // 并进用户那张卡会让「删掉这条」在两套语义之间摇摆，用户也看不出这条是谁写的。
            var globalRows = all.filter(function (e) { return e.layer === 'global' })
            var cardGroups = [{ key: 'global', label: t('memory.auto.global'), rows: globalRows }].concat(groups)
            var wsCard = renderEvolutionCard({
              cardKey: 'auto:workspace',
              title: t('evo.title'),
              layerOn: evoGlobalOn || evoWorkspaceOn,
              groups: cardGroups,
            })
            return wsCard ? [wsCard] : []
          }

          /**
           * 自主记忆设置弹窗（清单已搬到记忆页签上，这里只留**设置**）。
           *
           * 只有「总开关 + 一行数字 + 笔记风格 + 本地整理 + 后台失败重试」。确认弹窗走
           * `modal` 那个槽，与 `evoOpen` 分开存，才能叠在它上面而不把整块关掉。
           */
          /**
           * 笔记风格的本地编辑态。
           *
           * 预设与已保存的自定义档点一下就生效；新建 / 编辑自定义档走表单，必须点「保存」
           * 才写入 —— 空表单不能把当前选择打回默认档。
           */
          var evsStyle = React.useState({ busy: false, mode: '', id: '', name: '', guide: '', error: '' })
          var evoStyle = evsStyle[0], setEvoStyle = evsStyle[1]

          function evoCustomStyles() {
            return (evo.settings && evo.settings.customNoteStyles) || []
          }

          function evoCustomStyle(id) {
            var hit = evoCustomStyles().filter(function (s) { return s.id === id })
            return hit.length > 0 ? hit[0] : null
          }

          function evoStyleCustomId(style) {
            var s = String(style || '')
            return s.indexOf('custom:') === 0 ? s.slice('custom:'.length) : ''
          }

          /**
           * 名称的显示宽度与宽字符数：汉字 / 全角 / emoji 算 2，其余算 1。
           * 上限 16 = 8 个汉字 = 16 个字母。口径与服务端 config.ts 的 truncateStyleName 一致。
           */
          function evoNameMetrics(value) {
            var chars = Array.from(String(value || ''))
            var width = 0
            var wide = 0
            for (var i = 0; i < chars.length; i++) {
              var code = chars[i].codePointAt(0)
              var w = (
                (code >= 0x1100 && code <= 0x115f) ||
                code === 0x2329 || code === 0x232a ||
                (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
                (code >= 0xac00 && code <= 0xd7a3) ||
                (code >= 0xf900 && code <= 0xfaff) ||
                (code >= 0xfe10 && code <= 0xfe19) ||
                (code >= 0xfe30 && code <= 0xfe6f) ||
                (code >= 0xff00 && code <= 0xff60) ||
                (code >= 0xffe0 && code <= 0xffe6) ||
                (code >= 0x1f300 && code <= 0x1f64f) ||
                (code >= 0x1f900 && code <= 0x1f9ff) ||
                (code >= 0x20000 && code <= 0x3fffd)
              ) ? 2 : 1
              width += w
              if (w === 2) wide += 1
            }
            return { width: width, wide: wide }
          }

          function evoStyleSet(patch) {
            setEvoStyle(function (cur) { return Object.assign({}, cur, patch) })
          }

          /** 选预设 / 已保存的自定义档：即时保存。自定义档同时打开编辑表单。 */
          function selectNoteStyle(style) {
            var customId = evoStyleCustomId(style)
            var hit = customId === '' ? null : evoCustomStyle(customId)
            evoStyleSet({
              busy: true, error: '',
              mode: hit ? 'edit' : '',
              id: hit ? hit.id : '',
              name: hit ? hit.name : '',
              guide: hit ? hit.guide : '',
            })
            apiCall('evolution-settings', { set: true, settings: { noteStyle: style } }).then(function (res) {
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.style.saved') })
                refreshEvolution()
                evoStyleSet({ busy: false })
              } else {
                setResult({ ok: false, text: translateError(t, res) })
                evoStyleSet({ busy: false })
              }
            }).catch(function (e) {
              setResult({ ok: false, text: errMsg(e) })
              evoStyleSet({ busy: false })
            })
          }

          function openNewNoteStyle() {
            if (evoCustomStyles().length >= 3) {
              evoStyleSet({ busy: false, mode: '', error: t('evo.style.err.limit') })
              return
            }
            evoStyleSet({ busy: false, mode: 'new', id: '', name: '', guide: '', error: '' })
          }

          function closeNoteStyleForm() {
            evoStyleSet({ busy: false, mode: '', id: '', name: '', guide: '', error: '' })
          }

          /** 新建 / 编辑自定义档：校验通过才写，写成功后选中它。 */
          function saveCustomNoteStyle() {
            var mode = evoStyle.mode
            if (mode !== 'new' && mode !== 'edit') return
            var name = String(evoStyle.name || '').trim()
            var guide = String(evoStyle.guide || '').trim().slice(0, 200)
            var nameMetrics = evoNameMetrics(name)
            if (nameMetrics.width < 1 || nameMetrics.width > 16 || nameMetrics.wide > 8) {
              evoStyleSet({ error: t('evo.style.err.name') })
              return
            }
            if (guide === '') {
              evoStyleSet({ error: t('evo.style.err.content') })
              return
            }
            var styles = evoCustomStyles().slice()
            var id = mode === 'edit' ? evoStyle.id : ''
            if (styles.some(function (s) { return s.name === name && s.id !== id })) {
              evoStyleSet({ error: t('evo.style.err.duplicate') })
              return
            }
            if (mode === 'new') {
              if (styles.length >= 3) {
                evoStyleSet({ error: t('evo.style.err.limit') })
                return
              }
              id = 'c' + Date.now().toString(36)
              styles.push({ id: id, name: name, guide: guide })
            } else {
              var hit = false
              styles = styles.map(function (s) {
                if (s.id !== id) return s
                hit = true
                return { id: id, name: name, guide: guide }
              })
              if (!hit) {
                closeNoteStyleForm()
                return
              }
            }
            evoStyleSet({ busy: true, error: '' })
            apiCall('evolution-settings', {
              set: true,
              settings: { customNoteStyles: styles, noteStyle: 'custom:' + id },
            }).then(function (res) {
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.style.saved') })
                refreshEvolution()
                evoStyleSet({ busy: false, mode: 'edit', id: id, name: name, guide: guide })
              } else {
                setResult({ ok: false, text: translateError(t, res) })
                evoStyleSet({ busy: false })
              }
            }).catch(function (e) {
              setResult({ ok: false, text: errMsg(e) })
              evoStyleSet({ busy: false })
            })
          }

          /** 删除自定义档；删的是当前选中档时回到默认档。 */
          function deleteCustomNoteStyle() {
            if (evoStyle.mode !== 'edit') return
            var id = evoStyle.id
            var styles = evoCustomStyles().filter(function (s) { return s.id !== id })
            var settings = { customNoteStyles: styles }
            if ((evo.settings && evo.settings.noteStyle) === 'custom:' + id) settings.noteStyle = 'default'
            evoStyleSet({ busy: true, error: '' })
            apiCall('evolution-settings', { set: true, settings: settings }).then(function (res) {
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.style.deleted') })
                closeNoteStyleForm()
                refreshEvolution()
              } else {
                setResult({ ok: false, text: translateError(t, res) })
                evoStyleSet({ busy: false })
              }
            }).catch(function (e) {
              setResult({ ok: false, text: errMsg(e) })
              evoStyleSet({ busy: false })
            })
          }

          /** 笔记风格：预设 + 已保存的自定义档 + 「自定义」新建入口。 */
          function renderEvolutionStyle() {
            var s = (evo.settings && evo.settings.noteStyle) || 'default'
            var customStyles = evoCustomStyles()
            var builtins = [
              ['default', 'evo.style.default'],
              ['detailed', 'evo.style.detailed'],
              ['minimal', 'evo.style.minimal'],
            ]
            var chip = function (key, label, pressed, onClick) {
              return React.createElement('button', {
                key: key, type: 'button', 'aria-pressed': pressed,
                disabled: evoStyle.busy, onClick: onClick,
              }, label)
            }
            var chips = builtins.map(function (o) {
              return chip(o[0], t(o[1]), s === o[0], function () { selectNoteStyle(o[0]) })
            }).concat(customStyles.map(function (cs) {
              var id = 'custom:' + cs.id
              return chip(id, cs.name, s === id, function () { selectNoteStyle(id) })
            }))
            chips.push(React.createElement('button', {
              key: 'custom-new', type: 'button',
              className: 'dsm-evo-style-add',
              disabled: evoStyle.busy || customStyles.length >= 3,
              title: customStyles.length >= 3 ? t('evo.style.err.limit') : '',
              onClick: openNewNoteStyle,
            }, t('evo.style.custom')))
            var formOpen = evoStyle.mode === 'new' || evoStyle.mode === 'edit'
            return React.createElement('div', { className: 'dsm-evo-style' },
              React.createElement('div', { className: 'dsm-form-seg', role: 'group' }, chips),
              formOpen
                ? React.createElement('div', { className: 'dsm-evo-style-custom' },
                    React.createElement('div', { className: 'dsm-evo-style-row' },
                      React.createElement('input', {
                        className: 'dsm-control dsm-evo-style-name', type: 'text', maxLength: 32,
                        size: Math.max(8, Math.min(16, evoNameMetrics(evoStyle.name).width)),
                        placeholder: t('evo.style.name.placeholder'),
                        'aria-label': t('evo.style.name.placeholder'),
                        value: evoStyle.name,
                        disabled: evoStyle.busy,
                        onChange: function (e) { evoStyleSet({ name: e.target.value, error: '' }) },
                      }),
                      React.createElement('input', {
                        className: 'dsm-control dsm-evo-style-guide', type: 'text', maxLength: 200,
                        placeholder: t('evo.style.custom.hint'),
                        'aria-label': t('evo.style.custom.hint'),
                        value: evoStyle.guide,
                        disabled: evoStyle.busy,
                        onChange: function (e) { evoStyleSet({ guide: e.target.value, error: '' }) },
                      })),
                    React.createElement('div', { className: 'dsm-evo-style-actions' },
                      React.createElement('button', {
                        type: 'button', className: 'dsm-btn dsm-btn-quiet',
                        disabled: evoStyle.busy, onClick: saveCustomNoteStyle,
                      }, t('evo.style.save')),
                      evoStyle.mode === 'edit'
                        ? React.createElement('button', {
                            type: 'button', className: 'dsm-btn dsm-btn-quiet',
                            disabled: evoStyle.busy, onClick: deleteCustomNoteStyle,
                          }, t('evo.style.delete'))
                        : null,
                      React.createElement('button', {
                        type: 'button', className: 'dsm-btn dsm-btn-quiet',
                        disabled: evoStyle.busy, onClick: closeNoteStyleForm,
                      }, t('evo.style.cancel'))))
                : null,
              evoStyle.error ? React.createElement('p', { className: 'dsm-evo-style-error' }, evoStyle.error) : null)
          }

          /**
           * 一行开关：左标题，右控件固定列；三颗开关共用同一条对齐线。
           *
           * 只有一行标题、没有说明：开关名（全局自主记忆 / 工作区自主记忆 / 自动确认）
           * 已经把范围与后果说清，补一句「所有项目都生效」只是重复（用户 2026-11-11）。
           */
          function renderEvolutionSwitchRow(o) {
            return React.createElement('div', { className: 'dsm-evo-row' + (o.sep ? ' dsm-evo-row-sep' : '') },
              React.createElement('div', { className: 'dsm-evo-row-main' },
                React.createElement('span', { className: 'dsm-label' }, o.label),
                // 说明行只给「标题说不完后果」的开关用（目前只有「只学不用」）。
                // 其余三个开关名已经把范围与后果说清，加一句只是重复。
                o.help ? React.createElement('span', { className: 'dsm-help' }, o.help) : null),
              React.createElement('div', { className: 'dsm-evo-row-control' },
                React.createElement(Switch, {
                  on: o.on,
                  disabled: o.disabled,
                  label: o.label,
                  onClick: o.onClick,
                })))
          }

          /**
           * 学习频率里的一个数字框。空框 + placeholder = 当前值，失焦 / 回车提交。
           * 用 text + inputMode 而不是 number：小框里不需要步进箭头。
           */
          function renderEvolutionRateInput(o) {
            var raw = evoRateEdits[o.key]
            return React.createElement('input', {
              className: 'dsm-control dsm-cap-input', type: 'text', inputMode: 'numeric',
              value: raw === undefined ? '' : raw,
              placeholder: String(o.placeholder),
              disabled: o.disabled,
              'aria-label': o.label,
              onChange: function (e) {
                var next = Object.assign({}, evoRateEdits)
                next[o.key] = e.target.value
                setEvoRateEdits(next)
              },
              onBlur: function () { commitEvolutionRate(o.key) },
              onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); commitEvolutionRate(o.key) } },
            })
          }

          /**
           * 复习模型：**下拉框**（首项「跟随当前会话」= 空值）。
           *
           * 原来是自由文本框，要用户自己打 `provider/model` —— 打错不会报错，只会在后台复习时
           * 静默失败，用户看不出原因。改成从宿主 `listProviders()` × `listModels()` 列出的
           * 真实模型里挑，选不到就说明没有可选模型。
           *
           * 取不到清单（老宿主 / llm 服务缺席）时退回原来的文本框：降级方向是「还能用」。
           */
          function renderEvolutionModelInput(o) {
            var current = String(o.value || '')
            // 清单还没到 / 空 → 退回文本框。不显示空下拉：那看起来像坏了。
            if (!evoModelsReady || evoModels.length === 0) {
              var raw = evoRateEdits.model
              return React.createElement('input', {
                className: 'dsm-control dsm-cap-input dsm-evo-model-input', type: 'text',
                value: raw === undefined ? current : raw,
                placeholder: t('evo.review.model.placeholder'),
                disabled: o.disabled,
                'aria-label': t('evo.review.model.label'),
                onChange: function (e) {
                  var next = Object.assign({}, evoRateEdits)
                  next.model = e.target.value
                  setEvoRateEdits(next)
                },
                onBlur: function () { commitEvolutionModel() },
                onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); commitEvolutionModel() } },
              })
            }
            // 选项：首项是「跟随当前会话」（空串），其余按 `provider/model` 拼值。
            //
            // 选项文字**只放模型名**，完整路由进 `title`（悬停可见）。原来的 `名字 (路由)`
            // 形状会把每一行撑到 60+ 字符 —— 菜单宽度跟着触发器走，于是每项折成两三行。
            // 而同一模型名会在不同 provider 下重复（`deepseek-official` / `deepseek-account`），
            // 光看名字分不出来，所以重名时补一个 provider 短名。
            var nameCount = {}
            evoModels.forEach(function (m) { nameCount[m.name] = (nameCount[m.name] || 0) + 1 })
            var opts = [{ value: '', label: t('evo.review.model.follow') }]
            evoModels.forEach(function (m) {
              var v = m.provider + '/' + m.id
              var short = m.provider.indexOf('deepseek-') === 0 ? m.provider.slice('deepseek-'.length) : m.provider
              var label = nameCount[m.name] > 1 ? m.name + ' · ' + short : m.name
              opts.push({ value: v, label: label, title: v })
            })
            // 已保存的值不在清单里（模型被下线 / 换过配置）：补一项，否则下拉会显示成首项，
            // 用户以为设置丢了 —— 实际存的是这个值，只是当前列不出来。
            if (current !== '' && !opts.some(function (x) { return x.value === current })) {
              opts.push({ value: current, label: current + ' · ' + t('evo.review.model.missing') })
            }
            return React.createElement(SourceSelect, {
              options: opts,
              value: current,
              ariaLabel: t('evo.review.model.label'),
              disabled: o.disabled,
              // 菜单至少 380px：触发器只有 260px，而模型名普遍 25–40 字符。
              // 菜单宽度默认跟触发器对齐（`max(box.width, menuMinWidth)`），不抬下限就会折行。
              menuMinWidth: 380,
              onChange: function (v) { commitEvolutionModelValue(v) },
            })
          }
          /** 下拉框直接提交（没有「失焦才提交」这回事：选中即生效）。 */
          function commitEvolutionModelValue(value) {
            var current = (evo.settings && typeof evo.settings.model === 'string') ? evo.settings.model : ''
            if (value === current) return
            setEvoBusy(true)
            apiCall('evolution-settings', { set: true, settings: { model: value } }).then(function (res) {
              setEvoBusy(false)
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.saved') })
                refreshEvolution()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          /** 提交复习模型：空串是合法值（跟随会话），所以不能复用数字那条的 null 归一。 */
          function commitEvolutionModel() {
            var raw = evoRateEdits.model
            if (raw === undefined) return
            var nextEdits = Object.assign({}, evoRateEdits)
            delete nextEdits.model
            setEvoRateEdits(nextEdits)
            var value = String(raw).trim()
            var current = (evo.settings && typeof evo.settings.model === 'string') ? evo.settings.model : ''
            if (value === current) return
            // 半截路由（`provider/` 或 `/model`）存下去不会报错，但 `routeOf` 会把它当**裸 model**
            // 整个当模型名用，于是复习静默拿不到路由 —— 用户看不出是自己写错了。
            // 这里只挡这一个明确的形状，不去猜模型 id 是否存在（那要联网查目录）。
            // 判据必须先排除空串：`lastIndexOf('/')` 与 `length - 1` 在空串上都是 -1，
            // 只写后半句会把「清空输入框 = 回到跟随会话」误判成格式错误 —— 那恰恰是这个
            // 框最常见的用法。
            if (value !== '' && (value.indexOf('/') === 0 || value.lastIndexOf('/') === value.length - 1)) {
              setResult({ ok: false, text: t('evo.review.model.badFormat') })
              return
            }
            setEvoBusy(true)
            apiCall('evolution-settings', { set: true, settings: { model: value } }).then(function (res) {
              setEvoBusy(false)
              if (res && res.ok !== false) {
                setResult({ ok: true, text: t('evo.saved') })
                refreshEvolution()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setEvoBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }

          /**
           * 学习频率：一句话里两个可填框 —— 「每 [10] 分钟最多产生 [5] 条记忆」。
           * 全局 / 工作区共用这一份设置，两层各自计数。
           */
          function renderEvolutionRate(o) {
            return React.createElement('div', { className: 'dsm-caps-row' },
              React.createElement('div', { className: 'dsm-cap-field' },
                React.createElement('span', { className: 'dsm-cap-label' }, t('evo.rate.every')),
                renderEvolutionRateInput({
                  key: 'learnWindowMinutes', placeholder: o.minutes,
                  label: t('evo.rate.window'), disabled: o.disabled,
                }),
                React.createElement('span', { className: 'dsm-cap-unit' }, t('evo.rate.minutes')),
                renderEvolutionRateInput({
                  key: 'maxLearnsPerWindow', placeholder: o.notes,
                  label: t('evo.rate.count'), disabled: o.disabled,
                }),
                React.createElement('span', { className: 'dsm-cap-unit' }, t('evo.rate.notes'))))
          }

          /** 草案里的 id → 用户看得懂的名称；找不到（已归档 / 已删）才退回 id。 */
          function evoNameById(id) {
            var hit = (evo.entries || []).find(function (x) { return x.id === id })
            return hit ? evolutionNameOf(hit) : String(id || '')
          }

          /**
           * 整理结果：始终占一块位置。
           *
           * 没点过 → 一句范围提示；点过没草案 → 报扫描条数；有草案 → 逐条「应用」。
           * 只飘一句「无需整理」会让用户以为按钮没生效。
           */
          function renderEvolutionOrganize() {
            if (!evoOrg) return React.createElement('p', { className: 'dsm-help' }, t('evo.organize.hint'))
            if (evoOrg.busy) return React.createElement('p', { className: 'dsm-help' }, t('evo.organize.scanning'))
            if (evoOrg.error) return React.createElement(Notice, { kind: 'err', text: evoOrg.error })
            var drafts = evoOrg.drafts || []
            if (drafts.length === 0) {
              return React.createElement('p', { className: 'dsm-help' }, t('evo.organize.none', { scanned: Number(evoOrg.scanned) || 0 }))
            }
            return React.createElement('div', { className: 'dsm-evo-organize' },
              React.createElement('div', { className: 'dsm-evo-detail-key' }, t('evo.organize.title', { count: drafts.length })),
              drafts.map(function (d) {
                var names = (d.ids || []).map(evoNameById)
                var reason = String(d.reason || '')
                return React.createElement('div', { key: d.id, className: 'dsm-evo-draft' },
                  React.createElement('span', { className: 'dsm-tag' }, t('evo.organize.action.' + d.action)),
                  React.createElement('span', { className: 'dsm-evo-draft-name', title: names.join(' + ') }, names.join(' + ')),
                  React.createElement('button', {
                    type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: !!evoOrg.busy,
                    onClick: function () { applyOrganizeDraft(d) },
                  }, t('evo.organize.apply')),
                  reason !== '' ? React.createElement('span', { className: 'dsm-evo-draft-reason', title: reason }, reason) : null)
              }))
          }

          function renderEvolutionModal() {
            var st = evo.status
            var auto = (st && st.auto) || { entries: 0, active: 0, pending: 0 }
            var eff = (st && st.effective) || {}
            var overall = eff.enabled === true
            var globalOn = eff.learnGlobal === true
            var workspaceOn = eff.learnWorkspace === true
            var autoConfirm = eff.autoConfirm === true

            // 当前频率：`evolution-list` 回的设置已归一化，字段一定在；拿不到时按出厂值兜底。
            var rateMinutes = evo.settings && typeof evo.settings.learnWindowMinutes === 'number' ? evo.settings.learnWindowMinutes : 10
            var rateNotes = evo.settings && typeof evo.settings.maxLearnsPerWindow === 'number' ? evo.settings.maxLearnsPerWindow : 5
            // 复习成本两项：缺省值与 `DEFAULT_EVOLUTION_SETTINGS` 同源（3 / 空串 = 跟随会话）。
            var reviewLimit = evo.settings && typeof evo.settings.maxReviewsPerSession === 'number'
              ? evo.settings.maxReviewsPerSession : 3
            var reviewModel = (evo.settings && typeof evo.settings.model === 'string') ? evo.settings.model : ''
            var statText = t('evo.stat', {
              learned: auto.entries || 0,
              active: auto.active || 0,
              pending: auto.pending || 0,
            })
            // 待复核只在非零时追加：它表示"需要你做什么"，恒显示一个 0 只会让这行变长。
            var evoDue = Number(auto.reviewDue) || 0
            if (evoDue > 0) statText += t('evo.stat.reviewDue', { due: evoDue })
            // 索引读坏：条目可能整块为空，而用户看到的是"我明明学过几条"。这一句必须显式
            // 说清是读不到，不是没有 —— 否则他会以为自己的记忆丢了。
            if (auto.broken === true) statText += t('evo.stat.broken')
            return React.createElement(Modal, {
              key: 'evo', className: 'dsm-modal-evo', title: t('evo.title'),
              closeLabel: t('btn.close'), onClose: function () { setEvoOpen(false) },
            },
              React.createElement('div', { className: 'dsm-evo-modal' },
                // 学习范围：两层开关 + 自动确认。自动确认是「问不问」，用一条细线和「学不学」分开。
                React.createElement('div', { className: 'dsm-evo-section' },
                  React.createElement('div', { className: 'dsm-evo-section-title' }, t('evo.section.scope')),
                  React.createElement('div', { className: 'dsm-evo-switch-box' },
                    renderEvolutionSwitchRow({
                      label: t('evo.switch.global'),
                      on: globalOn,
                      disabled: evoBusy || (evo.loading && !st),
                      onClick: function () { setEvolutionLayer('global', !globalOn) },
                    }),
                    renderEvolutionSwitchRow({
                      label: t('evo.switch.workspace'),
                      on: workspaceOn,
                      disabled: evoBusy || (evo.loading && !st),
                      onClick: function () { setEvolutionLayer('workspace', !workspaceOn) },
                    }),
                    renderEvolutionSwitchRow({
                      sep: true,
                      label: t('evo.switch.autoConfirm'),
                      on: autoConfirm,
                      disabled: evoBusy || (evo.loading && !st) || !overall,
                      onClick: function () { setEvolutionAutoConfirm(!autoConfirm) },
                    }))),
                // 学习频率：全局 / 工作区共用一份设置；到量后拒绝新的 learn（合并 / 更新不受影响）。
                overall ? React.createElement('div', { className: 'dsm-evo-section' },
                  React.createElement('div', { className: 'dsm-evo-section-title' }, t('evo.rate.title')),
                  // 不再套 dsm-evo-box：`renderEvolutionRate` 里的 .dsm-caps-row 自己带边框，
                  // 再包一层就是两层框套在一起。
                  renderEvolutionRate({
                    minutes: rateMinutes, notes: rateNotes,
                    disabled: evoBusy || (evo.loading && !st),
                  })) : null,
                // 复习成本：**必须挂在这里，不能挂进后台复习那块**。那一块在队列接口拿不到时
                // 整段返回 null（它回答的是「后台在干什么」），设置是配置，不该跟着一起消失 ——
                // 否则队列一出错，用户连复习次数与模型都改不了。
                //
                // 每会话上限直接决定后台花多少钱；0 是合法值 = 这个会话一次都不复习。
                // 模型是下拉框：选项来自宿主的 `listProviders()` × `listModels()`，
                // 首项「跟随当前会话」= 空值。手打 provider/model 会静默写错一个不存在的
                // 模型名，而失败发生在后台复习时，用户看不到原因。
                overall ? React.createElement('div', { className: 'dsm-evo-section' },
                  React.createElement('div', { className: 'dsm-evo-section-title' }, t('evo.review.cost.title')),
                  React.createElement('div', { className: 'dsm-evo-box' },
                    React.createElement('div', { className: 'dsm-evo-review-limit' },
                      React.createElement('span', { className: 'dsm-cap-label' }, t('evo.review.limit.label')),
                      renderEvolutionRateInput({
                        key: 'maxReviewsPerSession',
                        placeholder: reviewLimit,
                        label: t('evo.review.limit.label'),
                        disabled: evoBusy || (evo.loading && !st),
                      }),
                      React.createElement('span', { className: 'dsm-cap-unit' }, t('evo.review.limit.unit'))),
                    React.createElement('div', { className: 'dsm-evo-review-limit' },
                      React.createElement('span', { className: 'dsm-cap-label' }, t('evo.review.model.label')),
                      renderEvolutionModelInput({ value: reviewModel, disabled: evoBusy || (evo.loading && !st) })))) : null,
                // 笔记风格：模型写新记忆的口吻（默认均衡——1–2 句，无表情和语气词）。
                overall ? React.createElement('div', { className: 'dsm-evo-section' },
                  React.createElement('div', { className: 'dsm-evo-section-title' }, t('evo.style')),
                  renderEvolutionStyle()) : null,
                // 学习记录 / 后台复习各成一段：标题在框外，内容在框里 —— 与上面三段
                // （学习范围 / 学习频率 / 笔记风格）同一版式，不再是「两张卡套在一起」。
                React.createElement('div', { className: 'dsm-evo-section' },
                  React.createElement('div', { className: 'dsm-evo-section-title' }, t('evo.section.records')),
                  React.createElement('div', { className: 'dsm-evo-box' },
                    React.createElement('div', { className: 'dsm-evo-records-head' },
                      React.createElement('span', { className: 'dsm-evo-records-stat' }, statText),
                      React.createElement('button', {
                        key: 'org', type: 'button', className: 'dsm-btn dsm-btn-quiet',
                        disabled: !!(evoOrg && evoOrg.busy) || auto.entries === 0, onClick: runOrganize,
                      }, evoOrg && evoOrg.busy ? t('evo.organize.scanning') : t('evo.organize'))),
                    renderEvolutionOrganize())),
                renderEvolutionReview(),
                evo.error ? React.createElement(Notice, { key: 'e', kind: 'err', text: evo.error }) : null,
                evo.loading && !st ? React.createElement('p', { key: 'l', className: 'dsm-help' }, t('loading')) : null))
          }

          // 页头那颗按钮要能一眼看出开没开、有几条待确认，省得每次都点进弹窗确认。
          var evoEff = (evo.status && evo.status.effective) || {}
          var evoGlobalOn = evoEff.learnGlobal === true
          var evoWorkspaceOn = evoEff.learnWorkspace === true
          var evoOn = evoGlobalOn || evoWorkspaceOn
          var evoPending = Number(evo.status && evo.status.auto && evo.status.auto.pending) || 0
          // 页头「记忆域预算」= 记忆域的已用 / 上限，唯一来源是服务端 `auto.injectBytes`
          // （`{ bytes, maxBytes, breakdown, degraded? }`）。`bytes` 是这一轮真正进上下文的
          // 记忆正文：全局 + 工作区 + 跟着场景消息走的场景记忆，三块共用一个总盘。界面别再
          // 按各层自己加，否则会把标题与收尾语重复记一遍。
          //
          // 缺字段（老版本 / 单测）或 `degraded` 非空时显示「未知 / 降级」：拿 0 顶会被读成
          // "记忆不占字节"，超限也不会转红，比留白更糟。
          var injectBytes = evo.status && evo.status.auto && evo.status.auto.injectBytes
          var hasInjectBytes = !!injectBytes && typeof injectBytes === 'object'
            && typeof injectBytes.bytes === 'number' && isFinite(injectBytes.bytes)
          var budgetDegradedText = injectBytes && typeof injectBytes.degraded === 'string' ? injectBytes.degraded : ''
          var budgetUnknown = !hasInjectBytes
          var budgetDegraded = hasInjectBytes && budgetDegradedText !== ''
          var evoBytes = hasInjectBytes ? Math.max(0, injectBytes.bytes) : 0
          var budgetMax = hasInjectBytes && typeof injectBytes.maxBytes === 'number' && isFinite(injectBytes.maxBytes)
            ? Math.max(0, injectBytes.maxBytes) : 0
          // 超限判据与显示用同一个数：两处各算一套时，会出现"红了但数字没超"。
          var budgetOver = !budgetUnknown && !budgetDegraded && budgetMax > 0 && evoBytes > budgetMax
          var budgetValue = budgetUnknown ? t('memory.budget.unknown')
            : budgetDegraded ? t('memory.budget.degraded')
              : t('memory.budget.bytes', { used: evoBytes, max: budgetMax })
          var evoConflicts = Number(evo.status && evo.status.auto && evo.status.auto.conflicts) || 0
          // 工作区自主记忆卡：所有工作区合成一张，卡内按名称分节。场景筛选选了具体场景时
          // 跟着隐藏 —— 自主记忆不绑场景，出现在"某场景里有什么"的答案里只会添乱。
          var evoCards = renderEvolutionCards()
          var cardBuckets = visibleBuckets
          // 页面顺序（用户定的四类记忆，从上到下）：
          //   全局记忆 → 自主记忆 → 工作区记忆 → 场景记忆（每场景一张）。
          // 全局自主记忆与工作区自主记忆都在上面那张自主卡里（见 renderEvolutionCards），
          // 不往全局卡里塞，也不再为了让"只命中自主记忆"的全局卡出现而强插 key ——
          // 那会把一张空的用户记忆卡拉出来。
          var sceneCards = cardBuckets.map(renderSceneCard)
          var wsCard = renderWorkspaceCard()
          var globalIndex = cardBuckets.indexOf('global')
          var head = globalIndex >= 0 ? sceneCards.slice(0, globalIndex + 1) : []
          var tail = globalIndex >= 0 ? sceneCards.slice(globalIndex + 1) : sceneCards
          var allCards = head
            .concat(evoCards)
            .concat(wsCard ? [wsCard] : [])
            .concat(tail)
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
                // 已用只取服务端的 `injectBytes.bytes`（记忆域），不叠加任何本地累加 ——
                // 见上面预算那段注释。取不到时值是「未知 / 降级」，不是 0。
                [budgetValue,
                  budgetOver ? t('memory.budget.label') + ' · ' + t('memory.budget.over') : t('memory.budget.label'),
                  budgetOver ? 'dsm-stat-over' : ''],
                // 冲突格**只在真有时才出现**：恒显示一个 0 的统计比不显示更糟 —— 用户会
                // 以为"没有冲突"，而实际上那个字段此前压根没被赋值过。
                ...(evoConflicts > 0
                  ? [[String(evoConflicts), t('memory.stat.conflicts'), 'dsm-stat-over']]
                  : []),
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
                  key: 'evo', type: 'button', className: 'dsm-btn dsm-btn-secondary' + (evoOn ? ' dsm-evo-head-on' : '') + (evoPending > 0 ? ' dsm-evo-head-pending' : ''),
                  // 有待确认时只换颜色、不再挂数字（用户 2026-11-11）：按钮上的角标会和
                  // 页头统计、卡片里的「待确认 N 条」重复，而条数本身在这里也不可点。
                  title: evoPending > 0 ? t('evo.pending.short', { count: evoPending }) : t('evo.title'),
                  onClick: function () { setResult(null); setEvoOpen(true) },
                }, t('evo.title')),
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
            // 降级原因原样渲染（服务端给的实况串，不进 DICT）：预算数字这时不可信，
            // 用户需要知道是哪个文件读坏了。
            budgetDegraded ? React.createElement('p', { className: 'dsm-help' }, t('memory.budget.degradedTip', { reason: budgetDegradedText })) : null,
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
            evoReview ? React.createElement(Modal, { key: 'evorev', className: 'dsm-modal-evo dsm-modal-evo-review', title: t('evo.review.title'), closeLabel: t('btn.close'), onClose: function () { setEvoReview(null) } },
              // 左右两颗切换键贴边竖排（用户裁定：这是最直观的位置，不要挪进头部）。
              // 箭头固定高度、垂直居中，不随弹窗高度拉伸 —— 拉伸会让它变成一根长条。
              React.createElement('div', { className: 'dsm-evo-review-nav' },
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-evo-review-arrow',
                  // 首尾相接，所以没有「到头」这种状态：只有一条时（绕了也是自己）才禁用。
                  disabled: evoReview.busy || evoReview.ids.length <= 1,
                  title: t('evo.review.prev'), 'aria-label': t('evo.review.prev'),
                  onClick: function () { stepEvolutionReview(-1) },
                }, '‹'),
                React.createElement('div', { className: 'dsm-evo-review-page' },
                  // 头部只放归属信息：层标签与页码。名称移到正文框里作为一行字段 ——
                  // 「名称 / 正文」两个标签并排，用户一眼看清这条记忆长什么样。
                  React.createElement('div', { className: 'dsm-evo-review-head' },
                    React.createElement('span', { className: 'dsm-tag' }, evoReview.layer === 'global' ? t('evo.scope.global') : evoReview.layer === 'workspace' ? t('evo.scope.workspace') : t('evo.tag.candidate')),
                    // 页码写成「3 / 12」：只给序号时用户不知道还剩多少，翻到底才发现没了。
                    evoReview.ids.length > 1
                      ? React.createElement('span', { className: 'dsm-evo-review-count' }, (evoReview.index + 1) + ' / ' + evoReview.ids.length)
                      : null),
                  evoReview.loading
                    ? React.createElement('p', { className: 'dsm-help' }, t('loading'))
                    : React.createElement('div', { className: 'dsm-evo-review-content' },
                        // 名称 + 正文放在同一个带边框的框里，各带一个标签。
                        // 没有标签时用户分不清哪一行是名字、哪一段是内容 —— 两者字号不同，
                        // 但名称有时就是一句话，光靠字号认不出来。
                        React.createElement('div', { className: 'dsm-evo-review-card' },
                          React.createElement('div', { className: 'dsm-evo-review-field' },
                            React.createElement('span', { className: 'dsm-evo-review-field-label' }, t('evo.review.field.title')),
                            React.createElement('span', { className: 'dsm-evo-review-title' }, evoReview.title || evoReview.id)),
                          React.createElement('div', { className: 'dsm-evo-review-field' },
                            React.createElement('span', { className: 'dsm-evo-review-field-label' }, t('evo.review.field.body')),
                            React.createElement('p', { className: 'dsm-evo-review-text' }, evoReview.body || '')),
                          // 边界属于**正文本身**：落盘时 `renderBody` 就把它拼在正文末尾，
                          // 读取时 `boundaryOfBody` 再摘出来。它回答的是「这句话在什么情况下
                          // 成立」，和正文是一体的，不该被归到下面那组「来由」里。
                          evoReview.boundary !== ''
                            ? React.createElement('div', { className: 'dsm-evo-review-field' },
                                React.createElement('span', { className: 'dsm-evo-review-field-label' }, t('evo.review.field.boundary')),
                                React.createElement('span', { className: 'dsm-evo-review-boundary' }, evoReview.boundary))
                            : null,
                        // 注脚区：类型 / 判断依据 / 用户原话 —— 这些是**来由**，不是记忆本身。
                        // 全空时整块不渲染 —— 一张只有正文的卡比一张塞满空标签的卡清楚。
                        (function () {
                          /** @type {Array<{ key: string, label: string, value: string, quote?: boolean }>} */
                          var rows = []
                          // `kind` 决定保质期（事实 / 做法 30 天后提醒复核，偏好 / 纠正不过期），
                          // 而这张卡片正是用户决定「要不要这条」的地方 —— 不显示类型，他看不出
                          // 自己批准的东西会不会过一阵就被催着复核。判据与 `ttlDaysOf` 同源。
                          if (evoReview.kind !== '') {
                            // 值里不能再带「类型：」前缀 —— 标签那一格已经写了「类型」，
                            // 否则渲染出来是「类型  类型：偏好（不会过期）」。
                            rows.push({ key: 'kind', label: t('evo.review.meta.kind'), value: t('evo.review.kindValue', {
                              kind: t('evo.kind.' + evoReview.kind),
                              ttl: (evoReview.kind === 'fact' || evoReview.kind === 'procedure')
                                ? t('evo.review.kind.ttl30')
                                : t('evo.review.kind.ttlForever'),
                            }) })
                          }
                          if (evoReview.basis !== '') {
                            rows.push({ key: 'bs', label: t('evo.review.meta.basis'), value: evoReview.basis })
                          }
                          ;(evoReview.evidence || []).forEach(function (x, i) {
                            rows.push({ key: 'ev' + i, label: evidenceSourceLabel(x.source), value: x.quote, quote: true })
                          })
                          if (rows.length === 0) return null
                          // 分隔线是**独立的网格项**：卡片是两列 grid，字段与标签各自成项，
                          // 分隔线要横跨两列。它不能挂在外层 div 的上边框上 —— 那层已经
                          // display:contents，没有盒子可以画边框。
                          return React.createElement(React.Fragment, null,
                            React.createElement('div', { className: 'dsm-evo-review-sep' }),
                            rows.map(function (row) {
                              return React.createElement('div', { key: row.key, className: 'dsm-evo-review-meta-row' },
                                React.createElement('span', { className: 'dsm-evo-review-meta-label' }, row.label),
                                React.createElement('span', {
                                  className: 'dsm-evo-review-meta-value' + (row.quote === true ? ' dsm-evo-review-meta-quote' : ''),
                                }, row.value))
                            }))
                        })())),
                  evoReview.error ? React.createElement(Notice, { kind: 'err', text: evoReview.error }) : null),
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-evo-review-arrow',
                  disabled: evoReview.busy || evoReview.ids.length <= 1,
                  title: t('evo.review.next'), 'aria-label': t('evo.review.next'),
                  onClick: function () { stepEvolutionReview(1) },
                }, '›')),
              // 左下否决 / 右下确认（用户 2026-11-11）。处理完自动进下一条，全部处理完自动关窗。
              // 否决 = 正文移进回收站，可恢复，但不写墓碑 —— 删除会写墓碑，30 天内同义内容
              // 都学不回来，那是另一件事。
              React.createElement('div', { className: 'dsm-modal-actions dsm-modal-actions-split' },
                // 与「确认」同一档主按钮（用户 2026-11-11）：两个都是对这条记忆的处置，
                // 没有主次，方向由文案与左右位置表达。**不用红色** —— 否决是把正文收进
                // 回收站，可恢复，不是销毁；红色在这里会把「先不采用」说成「危险操作」。
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: evoReview.busy || evoReview.loading, onClick: rejectEvolutionInReview }, t('evo.review.reject')),
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn',
                  disabled: evoReview.busy || evoReview.loading || evoReview.error !== null,
                  onClick: approveEvolutionInReview,
                }, evoReview.busy ? t('evo.review.approving') : t('evo.approve')))) : null,
            modal && modal.type === 'evo-edit' ? React.createElement(Modal, { key: 'evoedit', title: evolutionEditorTitle(modal.entry), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.name')),
                  React.createElement('input', {
                    className: 'dsm-control',
                    value: modal.title || '',
                    placeholder: t('evo.edit.name.placeholder'),
                    disabled: modal.busy,
                    onChange: function (ev) { setModal(Object.assign({}, modal, { title: ev.target.value, error: null })) },
                  })),
                // 类型：模型判错时用户能亲手改。它是**唯一**的修正入口 —— 否则一条被误判成
                // `correction` 的做法会永久驻留（那个类型不过期），用户毫无办法。
                // 改类型会连带重算保质期，所以旁边直接写出「改完会怎样」。
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('evo.review.kind.label')),
                  React.createElement('select', {
                    className: 'dsm-control',
                    value: modal.kind || '',
                    disabled: modal.busy,
                    onChange: function (ev) { setModal(Object.assign({}, modal, { kind: ev.target.value, error: null })) },
                  },
                    // 空串（旧数据没写 kind）= 保持原样，不给它编一个值。
                    modal.kind === '' ? React.createElement('option', { value: '' }, t('evo.review.kind.keep')) : null,
                    ['preference', 'fact', 'correction', 'procedure'].map(function (k) {
                      return React.createElement('option', { key: k, value: k }, t('evo.kind.' + k))
                    })),
                  React.createElement('span', { className: 'dsm-help' }, t('evo.review.kind.hint'))),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.body')),
                  React.createElement('textarea', {
                    className: 'dsm-control dsm-textarea-md',
                    value: modal.body || '',
                    disabled: modal.busy,
                    onChange: function (ev) { setModal(Object.assign({}, modal, { body: ev.target.value, error: null })) },
                  }))),
              modal.error ? React.createElement(Notice, { key: 'e', kind: 'err', text: modal.error }) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: modal.busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: modal.busy || String(modal.body || '').trim() === '', onClick: saveEvolutionEditor }, t('btn.save')))) : null,
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
                  // 标签写「类型」而不是「场景」：这一格现在选的是**落点层级**
                  // （全局 / 工作区 / 场景），下面还会跟一个二级下拉挑具体的场景名。
                  // 仍用「场景」会让用户以为这里只能填场景，看不出还有另外两档。
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.kind')),
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
                   *
                   * 落点做成**三档**（与「生效层级」同一个交互）：全局 / 工作区 / 场景。
                   * 选「全局」直接定 `global`；选另两档时多一个下拉挑具体是哪个工作区 / 场景。
                   * 合成一个扁平下拉做不到这件事 —— 三档的选项集合不同，混在一起用户分不清
                   * 「dsh-plugin-tool-management」是项目名还是一个叫这个名字的场景。
                   *
                   * 工作区那一档只列还活着的工作区：往目录已不存在的项目里写记忆，写进去也
                   * 没人会读到。
                   */
                  editor.mode === 'create'
                    ? React.createElement('div', { className: 'dsm-target-pick' },
                      // 层级下拉只装短标签（全局 / 工作区 / 场景），给它固定窄宽；
                      // 腾出来的横向空间全给右边那个 —— 它装的是工作区名 / 场景名，
                      // 那串名字常比容器还长，收窄了就被截成看不出是哪一档。
                      React.createElement(SourceSelect, {
                        className: 'dsm-target-level',
                        options: createTargets.levels,
                        value: createKind,
                        ariaLabel: t('memory.field.level'),
                        disabled: busy,
                        onChange: function (v) { onPickCreateLevel(v) },
                      }),
                      createKind === 'global' ? null : React.createElement(SourceSelect, {
                        className: 'dsm-target-name',
                        options: createKind === 'workspace' ? createTargets.workspace : createTargets.scene,
                        value: editor.group || '',
                        ariaLabel: createKind === 'workspace' ? t('memory.level.workspace') : t('memory.level.scene'),
                        disabled: busy || (createKind === 'workspace' ? createTargets.workspace.length === 0 : false),
                        onChange: function (v) { setEditor(Object.assign({}, editor, { group: v })) },
                      }))
                    : React.createElement('input', { className: 'dsm-control', value: editor.group || '', disabled: true, onChange: function () {} }),
                editorGroupInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('error.rules.invalidGroup')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.name')),
                  React.createElement('input', { className: 'dsm-control' + (editorNameInvalid ? ' dsm-rule-invalid' : ''), value: editor.name || '', placeholder: t('memory.field.name.placeholder'), onChange: function (e) { setEditor(Object.assign({}, editor, { name: e.target.value })) } }),
                  editorNameInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.name.invalid')) : null),
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
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || anyLocked || editorNameInvalid || editorGroupInvalid || !String(editor.name || '').trim() || !String(editor.body || '').trim(), onClick: editor.mode === 'create' ? submitCreate : function () { submitUpdate(false) } }, editor.mode === 'create' ? t('memory.btn.create') : t('memory.btn.save')))) : null,
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