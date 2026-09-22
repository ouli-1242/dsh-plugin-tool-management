        // 变更单 01 之后 Rules 与 Scenes 合并为本页：**场景（一级目录）是分组维度，
        // 记忆（.md）是内容**；勾选启用后该目录树内所有 .md 正文自动进入系统提示词。
        // 原 Scenes 页的「agent preset ↔ 分组绑定」降级为页底的「高级」折叠区（可选）。
        // ---------- 场景页：场景清单 + 档案（MCP 工具集/技能集/子智能体绑定，三段自由搭配）+ 当前模式 ----------
        function ScenesPage() {
          var EMPTY_MODE = { scene: null, snapshot: null }
          var state = React.useState({ loading: true, error: null, scenes: [], rules: [], activeMode: 'all', mode: EMPTY_MODE, archives: {} })
          var data = state[0], setData = state[1]
          var bs = React.useState(false)
          var busy = bs[0], setBusy = bs[1]
          var rs = React.useState(null)
          var result = rs[0], setResult = rs[1]
          var ups = useUndoState()
          var undo = ups[0], setUndo = ups[1], dismissUndo = ups[2]
          var ms = React.useState(null)
          var modal = ms[0], setModal = ms[1]
          var sfs = React.useState({ name: '', error: null })
          var sceneForm = sfs[0], setSceneForm = sfs[1]
          var pos = React.useState([])
          var presetOptions = pos[0], setPresetOptions = pos[1]
          var dts = React.useState(null)
          var drillTools = dts[0], setDrillTools = dts[1]
          // 场景回收站（记录 + 档案）：null = 关闭；{loading, error, entries}
          var sts = React.useState(null)
          var trash = sts[0], setTrash = sts[1]
          var stb = React.useState(false)
          var trashBusy = stb[0], setTrashBusy = stb[1]
          // 「进入场景」前的改动预览卡（null = 关闭；{name, loading, error, plan}）。
          // 只有**进入**这条路走它：退出是按快照回原位，不是新做一次改动，再问一遍纯添摩擦。
          var pvs = React.useState(null)
          var preview = pvs[0], setPreview = pvs[1]
          // 要不要弹那张卡（侧车 `scene-settings.json`）。默认开；卡上「不再显示」与右上那颗
          // 按钮改的都是它。读不到时按默认（弹）—— 少弹一次卡是"我没被告知就改了环境"，
          // 多弹一次只是多按一下。
          var eps = React.useState(true)
          var enterPreview = eps[0], setEnterPreview = eps[1]
          // 场景页搜索：与 MCP / 技能 / 提示词 / 子智能体 / 记忆页同一形态（防抖 + `matchByText`）。
          var qs = React.useState('')
          var query = qs[0], setQuery = qs[1]
          var dq = useDebouncedValue(query)
          var flipRef = React.useRef(null)
          useFlipReorder(flipRef)
          function loadTrash(keepOpen) {
            setTrash(Object.assign({ loading: true, error: null, entries: [] }, keepOpen ? trash || {} : {}))
            apiCall('scene-trash-list', {}).then(function (res) {
              if (res && res.ok) setTrash({ loading: false, error: null, entries: res.trash || [] })
              else setTrash({ loading: false, error: (res && res.error) || t('trash.loadFailed'), entries: [] })
            }).catch(function (e) { setTrash({ loading: false, error: errMsg(e), entries: [] }) })
          }
          function restoreScene(item) {
            setTrashBusy(true)
            apiCall('scene-trash-restore', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('trash.restored', { name: item.name }) }); refresh(true); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: errMsg(e) }) }) })
          }
          function purgeScene(item) {
            setTrashBusy(true)
            apiCall('scene-trash-delete', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('trash.purged', { name: item.name }) }); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: errMsg(e) }) }) })
          }
          React.useEffect(function () { if (!result || result.ok !== true) return undefined; var timer = setTimeout(function () { setResult(null) }, 2600); return function () { clearTimeout(timer) } }, [result])
          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('scene-mode-get', {}).then(function (m) {
              if (m && m.ok) setData(function (prev) { return Object.assign({}, prev, { mode: m.mode || EMPTY_MODE, archives: m.archives || {} }) })
            }).catch(function () { /* 模式信息拿不到按空模式渲染；主数据 rules-list 的错误有自己的通道 */ })
            // 悬空引用体检：跟着列表一起读一次（这一页就是档案与绑定的所在地）。
            // **只在首次加载与手动刷新时跑** —— 它要把四个域各枚举一遍（服务器 / 技能 /
            // 人设 / 预设），而页内那些"操作完顺手重读"的 silent 刷新一次点开关就来一趟，
            // 为一个横幅把列表拖慢不值。横幅因此可能滞后一次操作，可它本来就是提示，不是控件。
            if (!silent) apiCall('state-doctor', {}).then(function (d) {
              setData(function (prev) { return Object.assign({}, prev, { doctor: d && d.ok ? { findings: d.findings || [], skipped: d.skipped || [] } : null }) })
            }).catch(function () { setData(function (prev) { return Object.assign({}, prev, { doctor: null }) }) })
            apiCall('rules-list', {}).then(function (r) {
              // rules 也留下来：档案弹窗「记忆」段的默认勾选要用每条记忆的启用状态
              //（scene-inventory 的 memories 里没有 enabled，客户端自己算，省一次宿主改动）。
              if (r && r.ok) setData(function (prev) { return Object.assign({}, prev, { loading: false, error: null, scenes: r.scenes || [], rules: r.rules || [], activeMode: r.activeMode === 'custom' ? 'custom' : 'all', activeScene: r.activeScene || null, scenePrompt: r.scenePrompt || null, stats: r.stats || prev.stats }) })
              else setData(function (prev) { return Object.assign({}, prev, { loading: false, error: translateError(t, r) }) })
            }).catch(function (e) { setData(function (prev) { return Object.assign({}, prev, { loading: false, error: errMsg(e) }) }) })
          }
          React.useEffect(function () { refresh() }, [])
          /** 读一次界面设置（读不到就保持默认 = 弹卡，本页其它功能不受影响）。 */
          function loadSceneSettings() {
            apiCall('scene-settings', {}).then(function (res) {
              if (res && res.ok && res.settings) setEnterPreview(res.settings.enterPreview !== false)
            }).catch(function () { /* 读不到 → 保持默认（弹卡） */ })
          }
          React.useEffect(function () { loadSceneSettings() }, [])
          /**
           * 改「进入场景前弹不弹卡」。乐观更新（点一下就该翻转），失败回读一次并弹结果条 ——
           * 这颗按钮的状态必须与侧车一致，否则会出现"以为关了、下次还弹"。
           */
          function saveEnterPreview(next) {
            setEnterPreview(next)
            apiCall('scene-settings', { set: true, enterPreview: next }).then(function (res) {
              if (res && res.ok && res.settings) setEnterPreview(res.settings.enterPreview !== false)
              else { loadSceneSettings(); setResult({ ok: false, text: translateError(t, res) }) }
            }).catch(function (e) { loadSceneSettings(); setResult({ ok: false, text: errMsg(e) }) })
          }
          /**
           * 切场景的结果提示：宿主会把场景绑定的提示词**写进 `~/.dsh/AGENTS.md`**，
           * 因此必须如实说清写没写、写的是哪份、或者为什么没写成。
           */
          function agentsMdNote(res) {
            var sync = res && res.agentsMd
            if (!sync) return ''
            if (sync.error) return ' · ' + t('scenes.agents.note.error', { reason: String(sync.error) })
            if (sync.applied) return ' · ' + t('scenes.agents.note.applied', { id: String(sync.applied) })
            if (sync.restored) return ' · ' + t('scenes.agents.note.restored')
            return ''
          }
          // ── 场景启用：**除「全局」外同时只能启用一个**（用户裁定）──
          // 空数组 = 全部关闭（只留恒常的 `_shared` 与 `global`）；服务端也会拒绝多个。
          function setActiveScenes(names) {
            if (busy) return
            setBusy(true); setResult(null)
            apiCall('rules-set-active', { scenes: names }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setResult({ ok: !(res.agentsMd && res.agentsMd.error), text: t('memory.result.active') + agentsMdNote(res) }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /**
           * 场景开关（P6）：**唯一入口**。
           *
           * 开 = 进入该场景：应用档案（MCP/技能双向切换）+ 启用场景（提示词绑定生效 + 记忆范围收窄）；
           * 关 = 回到全局默认：恢复档案快照 + 取消场景启用。
           *
           * ⚠️ 核心约束：`mode.scene` 与 `active` **必须恒等**。此前开关只写 `active`、
           * 「切入此模式」按钮只写 `mode.scene`，两者互不知情 —— 于是「拨开关不应用档案」与
           * 「顶部横幅永远不显示」同时发生。现在两条路径都走 enterMode / exitMode。
           */
          function toggleScene(scene) {
            if (busy || scene.shared || scene.global) return
            if (scene.active === true) exitMode()
            else if (enterPreview) askEnter(scene.name)
            else enterMode(scene.name)
          }
          /** 场景锁定（v0.8）：锁上后五个管理域整体只读（场景页 + 各功能页）；启停不受影响。 */
          function toggleSceneLock(scene) {
            if (busy || scene.shared || scene.global) return
            setBusy(true)
            apiCall('rules-scene-lock', { scene: scene.name, locked: scene.locked !== true }).then(function (res) {
              setBusy(false)
              if (res && res.ok) refresh(true)
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /**
           * 提示词预设候选（打开表单时拉一次；失败就只留「不绑定」）。
           * 顺带回传**当前生效的预设 id**：场景表单默认就选它（用户裁定「默认就是当前启动的」），
           * 用户仍可改成别的或选「不绑定」。
           */
          function loadPresetOptions(onLoaded) {
            apiCall('agentsmd-list', {}).then(function (res) {
              var list = (res && res.presets) || []
              // 不再提供「不绑定」：候选就是预设本身，默认选中当前生效的那份。
              var opts = []
              list.forEach(function (p) { opts.push({ value: p.id, label: p.active ? (p.id + ' · ' + t('scenes.prompt.activeTag')) : p.id }) })
              setPresetOptions(opts)
              var activeId = ''
              for (var i = 0; i < list.length; i += 1) { if (list[i].active) { activeId = list[i].id; break } }
              if (typeof onLoaded === 'function') onLoaded(activeId)
            }).catch(function () { /* 候选项加载失败只影响下拉默认值，不值得打断表单 */ })
          }
          /** 表单里没显式选过时，把「提示词」默认填成当前生效的那份（不覆盖已有选择）。 */
          function defaultPromptToActive(activeId) {
            if (!activeId) return
            setSceneForm(function (f) { return (f && String(f.prompt || '') !== '') ? f : Object.assign({}, f, { prompt: activeId }) })
          }
          // ── 场景建 / 改描述 / 改绑定的提示词 / 删 ──
          function openCreateScene() { setSceneForm({ name: '', description: '', prompt: '', error: null }); setModal({ type: 'scene-create' }); loadPresetOptions(defaultPromptToActive) }
          function openEditScene(scene) {
            setSceneForm({ name: scene.name, description: scene.description || '', prompt: scene.prompt || '', error: null })
            setModal({ type: 'scene-edit', name: scene.name })
            // 该场景还没绑定时，默认选中当前生效的那份（用户裁定「默认就是当前启动的」）。
            if (!scene.prompt) loadPresetOptions(defaultPromptToActive)
            else loadPresetOptions()
          }
          /** 新建与编辑共用一个表单：字段相同，只是分别走 rules-create-scene / rules-update-scene。 */
          function submitSceneForm() {
            var isEdit = modal && modal.type === 'scene-edit'
            var name = String(sceneForm.name || '').trim()
            if (!isValidSceneSegment(name)) { setSceneForm(Object.assign({}, sceneForm, { error: t('error.rules.invalidGroup') })); return }
            var description = String(sceneForm.description || '').trim()
            var prompt = String(sceneForm.prompt || '').trim()
            // 编辑时表单里的 name 可能改过：改名走 nextName，服务端按 modal.name（原名）定位、改完再落新名。
            var originalName = isEdit ? String((modal && modal.name) || name) : name
            setBusy(true)
            var payload = isEdit
              ? { name: originalName, nextName: name, description: description, prompt: prompt }
              : { name: name, description: description, prompt: prompt }
            apiCall(isEdit ? 'rules-update-scene' : 'rules-create-scene', payload).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                // 新建时若把历史默认（全部启用）收敛成单选，如实说一句，别让用户以为场景"自己开了"。
                setResult({ ok: true, text: res.collapsedActive ? t('scenes.result.created.collapsed', { name: name }) : t(isEdit ? 'memory.result.sceneUpdated' : 'memory.result.sceneCreated', { name: name }) })
                refresh(true)
              } else setSceneForm(Object.assign({}, sceneForm, { error: translateError(t, res) }))
            }).catch(function (e) { setBusy(false); setSceneForm(Object.assign({}, sceneForm, { error: errMsg(e) })) })
          }
          function submitDeleteScene(name) {
            setBusy(true)
            apiCall('rules-remove-scene', { name: name }).then(function (res) {
              setBusy(false); setModal(null)
              if (res && res.ok) {
                var moved = Number((res && res.movedFiles) || 0)
                // 如实说清「一起删了多少条记忆」：删除场景现在会带走它下面的全部记忆。
                setResult({
                  ok: true,
                  text: moved > 0
                    ? t('memory.result.sceneRemoved.withMemories', { name: name, count: moved })
                    : t('memory.result.sceneRemoved', { name: name }),
                })
                refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          // ── 档案（mcp 两级 / skills / subagents 三段自由搭配）──
          function openArchive(name) {
            setBusy(true)
            Promise.all([apiCall('scene-mode-get', {}), apiCall('scene-inventory', {})]).then(function (rs) {
              setBusy(false)
              var modeRes = rs[0], inv = rs[1]
              if (!(inv && inv.ok)) { setResult({ ok: false, text: translateError(t, inv) }); return }
              var archives = (modeRes && modeRes.ok ? modeRes.archives : null) || data.archives || {}
              var archive = archives[name] || {}
              setModal({ type: 'scene-archive', name: name, drill: null, memQuery: '', skillQuery: '', subQuery: '', mcpQuery: '',
                sections: {
                  mcp: archive.mcp ? Object.assign({}, archive.mcp) : null,
                  mcpNotes: archive.mcpNotes && Object.keys(archive.mcpNotes).length ? Object.assign({}, archive.mcpNotes) : null,
                  skills: Array.isArray(archive.skills) ? archive.skills.slice() : null,
                  subagents: Array.isArray(archive.subagents) ? archive.subagents.slice() : null,
                  memories: Array.isArray(archive.memories) ? archive.memories.slice() : null,
                },
                inventory: {
                  mcpServers: inv.mcpServers || [], skills: inv.skills || [], subagents: inv.subagents || [], tools: inv.tools || [],
                  // 模式名与顺序（标准 → PTC → 极简 → 创造 → 自建）：人设行的限制摘要按这个顺序排。
                  presets: inv.presets || [],
                  // 记忆段的数据源（宿主 scene-inventory 回传；老宿主缺失时退化为空列表而不是崩）。
                  // 只留扁平 memories——记忆段现在按「记忆所属场景」自己筛，不再需要场景清单。
                  memories: inv.memories || [],
                } })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          function modalSections() { return modal && modal.type === 'scene-archive' ? modal.sections : null }
          function setSections(sections) { if (modal && modal.type === 'scene-archive') setModal(Object.assign({}, modal, { sections: sections })) }
          function toggleMcpServer(server) {
            var sections = modalSections(); if (!sections) return
            var mcp = Object.assign({}, sections.mcp || {})
            if (mcp[server] !== undefined) delete mcp[server]
            else mcp[server] = '*'
            setSections(Object.assign({}, sections, { mcp: mcp }))
          }
          /**
           * 场景级 MCP 备注（v0.8.1）：该场景进入时覆盖全局备注、退出恢复。
           * 空值 = 删除该服务器的场景备注；mcpNotes 全空 → null（等同未定义，保存时不上报）。
           */
          function setMcpNote(server, value) {
            var sections = modalSections(); if (!sections) return
            var notes = Object.assign({}, sections.mcpNotes || {})
            var v = String(value == null ? '' : value).trim()
            if (v) notes[server] = v
            else delete notes[server]
            setSections(Object.assign({}, sections, { mcpNotes: Object.keys(notes).length ? notes : null }))
          }
          /**
           * 新加段一律**默认不勾选**（用户明确要求：MCP 工具集 / 技能集 / 子智能体绑定都不预勾）。
           *
           * 取 2026-09-13 前的「预勾当前运行时状态」是错的方向：用户点「添加」只是想开始配，
           * 不是想把自己现有的启用状态抄进档案。代价要讲清楚——勾选集语义是「勾 = 启用」，
           * 空段 = 全部停用（未定义段也是同一个意思，见 archive-engine 的四域同口径），
           * 所以「添加 MCP 工具集」当下就等价于「该场景下全部 MCP 停用」，
           * 段脚注（`memory.archive.emptySection`）与弹窗顶部说明会同时把这句话显示出来。
           */
          function emptyMcpPreset() { return {} }
          /** 全选：列出全部服务器（含未运行的）并各勾「全部工具」。 */
          function mcpSelectAll() {
            var all = {}
            ;(modal.inventory.mcpServers || []).forEach(function (server) { all[server.name] = '*' })
            setSections(Object.assign({}, modalSections(), { mcp: all }))
          }
          function mcpDrillSpec(value) {
            var sections = modalSections(); if (!sections) return
            var mcp = Object.assign({}, sections.mcp || {})
            mcp[modal.drill] = value
            setSections(Object.assign({}, sections, { mcp: mcp }))
          }
          /** 档案各段共用的段头动作（包装共享的 segActions，把 busy / 文案在这里补上）。 */
          function archiveSegActions(defined, addLabel, onAdd, onRemove, onAll, onClear, allChecked) {
            return segActions({
              defined: defined, busy: busy, addLabel: addLabel,
              selectAllLabel: t('bulk.selectAll'), clearLabel: t('bulk.unselectAll'), removeLabel: t('memory.archive.removeSection'),
              onAdd: onAdd, onRemove: onRemove, onAll: onAll, onClear: onClear, allChecked: allChecked,
            })
          }
          /**
           * 段脚注：段已定义但一项未勾必须显式提示，否则像「没保存上」。
           * 各域的后果不同（MCP/技能/记忆 = 全部停用；子智能体 = 不限制），所以文案由调用方给。
           */
          function archiveSegFoot(defined, count, emptyLabel) {
            return segFoot(defined, count, emptyLabel || t('memory.archive.emptySection'))
          }

          // ── 段 4：记忆（P5：单一真相源 = `rules[*].enabled`）────────────────────
          // 这个段**没有自己的「段定义」概念**：勾选状态**就是**记忆自身的 `enabled`，
          // 与记忆页同一个写入口（`rules-toggle`）。于是「记忆页开了 → 档案页显示开启」
          // 天然成立，不存在两套状态、也不需要双向同步代码。
          //
          // 勾选**立即提交**（不等「保存到场景」）：它是全局状态，不属于场景档案。
          //
          // **只列被编辑场景自己的记忆**：保留场景 `global` 恒定注入（任何对话都生效），
          // 不需要在这里配置，列出来只会让人以为「不勾就不注入」。
          function sceneMemories(sceneName) {
            return sceneMemoriesOf(modal.inventory.memories, sceneName)
          }
          /** 「全选 / 全不选」作用的 id 集合 = 本场景的全部记忆。 */
          function allMemoryIds() {
            return sceneMemories(modal.name).map(function (m) { return String(m.id) })
          }
          /** 记忆是否开启 —— 直接读 `rules[*].enabled`（单一真相源）。 */
          function memoryEnabled(id) {
            var rule = (data.rules || []).find(function (r) { return r.id === id })
            return !!(rule && rule.enabled !== false)
          }
          function toggleMemory(id) {
            var next = !memoryEnabled(id)
            setBusy(true)
            apiCall('rules-toggle', { id: id, enabled: next }).then(function (res) {
              setBusy(false)
              if (res && res.ok) refresh(true)
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /** 全选 / 全不选：批量写 `enabled`。并发提交而非顺序 —— 服务端 `rules-toggle` 走写队列天然串行，所以并发不产生竞态；任一失败即如实报错。 */
          function setAllMemories(on) {
            var ids = allMemoryIds()
            if (!ids.length) return
            // 操作前的开关：撤销靠它逐条写回（这组本来就可能一半开一半关）。
            var pre = ids.map(function (id) { return { id: id, on: memoryEnabled(id) } }).filter(function (x) { return x.on !== on })
            setBusy(true)
            Promise.all(ids.map(function (id) { return apiCall('rules-toggle', { id: id, enabled: on }) }))
              .then(function () {
                setBusy(false)
                if (pre.length) setUndo({
                  text: t('undo.memories', {
                    action: t(on ? 'bulk.enabled' : 'bulk.disabled'),
                    count: pre.length,
                    // `data.rules` 是刷新前那一帧的快照（= 操作前的值），加减本次改动数即操作后的启用数。
                    enabled: on ? enabledMemoryCount(data.rules) + pre.length : enabledMemoryCount(data.rules) - pre.length,
                  }),
                  items: pre,
                  revert: function (item) { return apiCall('rules-toggle', { id: item.id, enabled: item.on }) },
                })
                refresh(true)
              })
              .catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
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
          function memoriesSeg() {
            var own = sceneMemories(modal.name)
            var q = String(modal.memQuery || '').trim().toLowerCase()
            var items = q ? own.filter(function (m) {
              return String(m.name).toLowerCase().indexOf(q) >= 0
                || String(m.description || '').toLowerCase().indexOf(q) >= 0
            }) : own
            var enabledCount = own.filter(function (m) { return memoryEnabled(String(m.id)) }).length
            return seg({
              title: t('memory.archive.memories'),
              count: t('scenes.seg.checked', { checked: enabledCount, total: own.length }),
              actions: segActions({
                defined: true, busy: busy,
                selectAllLabel: t('bulk.selectAll'), clearLabel: t('bulk.unselectAll'),
                onAll: function () { setAllMemories(true) },
                onClear: function () { setAllMemories(false) },
                allChecked: own.length > 0 && enabledCount === own.length,
              }),
              body: React.createElement('div', { className: 'dsm-seg-body' },
                segFilter(modal.memQuery, function (v) { setModal(Object.assign({}, modal, { memQuery: v })) }, t('scenes.mem.search')),
                items.length
                  ? React.createElement('div', null, items.map(function (m) {
                      return pickRow({
                        disabled: busy,
                        key: m.id,
                        checked: memoryEnabled(String(m.id)),
                        name: m.name,
                        // 记忆描述是自由正文的首行，可能很长：截断到 MEM_DESC_MAX，全文放 title。
                        // CSS 侧还有单行省略兜底（超长不再横向溢出段边框）。
                        desc: m.description ? clipText(m.description, MEM_DESC_MAX) : null,
                        descTitle: m.description || null,
                        onChange: function () { toggleMemory(String(m.id)) },
                      })
                    }))
                  : React.createElement('div', { className: 'dsm-pick-empty' }, q ? t('scenes.mem.noMatch') : t('scenes.mem.emptyScene'))),
            })
          }
          /** 段 1：MCP 工具集（服务器级勾选 → 行内「编辑」打开固定尺寸弹窗：备注 + 工具勾选）。 */
          function mcpSeg() {
            var sections = modalSections()
            var defined = !!sections.mcp
            var servers = modal.inventory.mcpServers || []
            return seg({
              title: t('memory.archive.tools'),
              count: defined ? t('scenes.seg.checked', { checked: Object.keys(sections.mcp).length, total: servers.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addTools'),
                function () { setSections(Object.assign({}, modalSections(), { mcp: emptyMcpPreset() })) },
                function () { var s = Object.assign({}, modalSections()); delete s.mcp; setSections(s) },
                mcpSelectAll,
                function () { setSections(Object.assign({}, modalSections(), { mcp: {} })) },
                // 「全选」按钮的全选态：档案里勾了全部服务器（含没在过滤结果里的）。
                defined && servers.length > 0 && servers.every(function (x) { return sections.mcp[x.name] !== undefined })),
              body: defined
                ? React.createElement('div', { className: 'dsm-seg-body' },
                    segFilter(modal.mcpQuery, function (v) { setModal(Object.assign({}, modal, { mcpQuery: v })) }, t('scenes.filter.servers')),
                    (function () {
                      var q = String(modal.mcpQuery || '').trim().toLowerCase()
                      var shown = q ? servers.filter(function (s) { return String(s.name).toLowerCase().indexOf(q) >= 0 }) : servers
                      if (!shown.length) return React.createElement('div', { className: 'dsm-pick-empty' }, q ? t('scenes.mem.noMatch') : t('scenes.mcp.noServers'))
                      return React.createElement('div', null, shown.map(function (server) {
                        var selected = sections.mcp[server.name] !== undefined
                        var spec2 = sections.mcp[server.name]
                        var specText = !selected ? '' : spec2 === '*' ? t('scenes.mcp.allTools') : t('scenes.mcp.pickedCount', { count: spec2.length })
                        var hasNote = Boolean((sections.mcpNotes || {})[server.name])
                        // 工具数未知（从未运行过且无记录）：显示引导而不是误导性的 0。
                        var desc = server.toolCount === null || server.toolCount === undefined
                          ? (server.live || server.serverDisabled ? null : t('scenes.mcp.unknownCount'))
                          : t('scenes.mcp.toolCount', { count: server.toolCount })
                        return pickRow({
                          disabled: busy,
                          key: server.name,
                          checked: selected,
                          name: server.name,
                          desc: desc,
                          meta: [
                            server.live ? null : React.createElement('span', { key: 'nr', className: 'dsm-tag dsm-tag-off' }, t('scenes.mcp.notRunning')),
                            specText ? React.createElement('span', { key: 'spec' }, specText) : null,
                            hasNote ? React.createElement('span', { key: 'note', className: 'dsm-tag' }, t('scenes.mcp.hasNote')) : null,
                          ],
                          actions: selected ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function (e) { e.preventDefault(); e.stopPropagation(); openDrill(server.name) } }, t('scenes.mcp.edit')) : null,
                          onChange: function () { toggleMcpServer(server.name) },
                        })
                      }))
                    })())
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.mcp.hint'))),
              foot: archiveSegFoot(defined, defined ? Object.keys(sections.mcp).length : 0),
            })
          }
          /**
           * 服务器编辑弹窗（v0.8.1 重做）：固定尺寸的次级弹窗，第一栏是场景备注输入框，
           * 第二栏是工具勾选列表 —— 「选工具」并入这里，行内不再塞备注输入框。
           */
          function mcpEditNode() {
            var sections = modalSections(); if (!sections) return null
            var server = modal.drill
            var spec = (sections.mcp || {})[server]
            var noteVal = (sections.mcpNotes || {})[server] || ''
            var known = drillTools
            var checkedCount = spec === '*' ? (known || []).length : (Array.isArray(spec) ? spec.length : 0)
            // 工具级的「全选 / 取消全选」也是二合一：全勾了就该给「取消全选」，
            // 并列两个按钮必然有一个是废话（与段头同一口径）。
            var allToolsChecked = checkedCount > 0 && (known || []).length > 0 && checkedCount === (known || []).length
            // 走共享 `Modal`（而不是自己拼遮罩 + dsm-modal）：自己拼的那份会漏掉令牌提示、
            // 也没有 Esc 关闭与焦点陷阱 —— 「令牌提示同时只渲染一份」这条规则的前提正是
            // **所有弹窗都经过同一个出口**（用户裁定 2026-09-19 的审查结论）。
            return React.createElement(Modal, {
              key: 'mcp-edit',
              title: t('scenes.mcp.edit') + ' · ' + server + '（' + t('scenes.seg.checked', { checked: checkedCount, total: (known || []).length }) + '）',
              closeLabel: t('scenes.mcp.done'),
              // 「完成」= 退回上一级（场景档案），而不是把整个弹窗关掉 —— 与原来那颗按钮的行为一致。
              onClose: function () { setModal(Object.assign({}, modal, { drill: null })) },
            },
              React.createElement('div', { className: 'dsm-modal-body' },
                  React.createElement('div', { className: 'dsm-field' },
                    // 上限 = 注入段的截断长度（`MCP_NOTE_MAX`），计数与标签同行（与场景描述框同款）；
                    // 存量的超长备注标红（服务端不校验长度，只有注入时截）。
                    React.createElement('div', { className: 'dsm-budget-meta' },
                      React.createElement('span', { className: 'dsm-label' }, t('scenes.mcp.noteLabel')),
                      React.createElement('span', { className: 'dsm-char-count' + (String(noteVal || '').length > MCP_NOTE_MAX ? ' dsm-char-over' : '') }, String(noteVal || '').length + ' / ' + MCP_NOTE_MAX)),
                    React.createElement('input', { className: 'dsm-control', type: 'text', value: noteVal, maxLength: MCP_NOTE_MAX, placeholder: t('scenes.mcp.notePlaceholder'), onChange: function (e) { setMcpNote(server, e.target.value) } }),
                    React.createElement('p', { className: 'dsm-help' }, t('scenes.mcp.noteHint'))),
                  React.createElement('div', { className: 'dsm-field' },
                    React.createElement('div', { className: 'dsm-mcp-edit-tools-head' },
                      React.createElement('label', { className: 'dsm-label' }, t('scenes.mcp.toolsOf')),
                      React.createElement('div', { className: 'dsm-mcp-edit-tools-actions' },
                        React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk', disabled: busy || !known, onClick: function () { mcpDrillSpec(allToolsChecked ? [] : '*') } }, bulkPair(allToolsChecked ? t('bulk.unselectAll') : t('bulk.selectAll'), allToolsChecked ? t('bulk.selectAll') : t('bulk.unselectAll'))))),
                    known === null
                      ? React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('memory.loading')))
                      : (known || []).length
                        // 探测成功也可能带 warning（临时启用的服务器没能恢复成停用）：这个槽位
                        // 是 drill 面板唯一的提示位，两个分支都得渲染，否则那条提示又变成静默。
                        ? React.createElement(React.Fragment, null,
                            modal.drillError ? React.createElement('div', { className: 'dsm-seg-empty-error' }, modal.drillError) : null,
                            segList((known || []).map(function (item) {
                              var on = spec === '*' ? true : (Array.isArray(spec) && spec.indexOf(item.short) >= 0)
                              return pickRow({
                                disabled: busy,
                                key: item.key,
                                checked: on,
                                name: item.short,
                                onChange: function () { toggleDrillTool(server, item.short) },
                              })
                            }), t('scenes.mcp.noTools')))
                        : React.createElement('div', { className: 'dsm-seg-body' },
                            React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.mcp.noTools')),
                            modal.drillError ? React.createElement('div', { className: 'dsm-seg-empty-error' }, modal.drillError) : null,
                            React.createElement('div', { className: 'dsm-seg-empty-actions' },
                              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: drillTools === null, onClick: probeMcpTools }, t('scenes.mcp.probeTools')))),
                    React.createElement('div', { className: 'dsm-seg-foot' }, t('scenes.mcp.drillHint')))))
          }
          /** 段 2：技能集。 */
          /**
           * 技能行的人类可读展示：技能名 + 来源名。
           *
           * 勾选集里存的仍是 `key`（`<来源 key>/<技能名>`）——它才是身份的载体；但**显示**
           * 必须用技能名与来源名：自定义目录的来源 key 是 `custom-<hash>`，直接显示 key 会
           * 让导入的技能在场景里变成一串哈希（用户 2026-09-15 报的）。
           * 老宿主没回传 name/root* 时退回按 key 拆，至少不再显示整串哈希前缀之外的路径。
           */
          function skillDisplay(item) {
            var key = String((item && item.key) || '')
            var slash = key.indexOf('/')
            var keyName = slash >= 0 ? key.slice(slash + 1) : key
            var keyRoot = slash >= 0 ? key.slice(0, slash) : ''
            var root = {
              key: String((item && item.rootKey) || keyRoot),
              label: String((item && item.rootLabel) || keyRoot),
              localeKey: item && item.rootLocaleKey,
              kind: item && item.rootKind,
            }
            return {
              name: String((item && item.name) || keyName || key),
              source: root.key ? rootDisplayName(t, root) : '',
              key: key,
            }
          }
          function skillsSeg() {
            var sections = modalSections()
            var defined = !!sections.skills
            var allItems = modal.inventory.skills || []
            /**
             * 可勾选集：**被同名技能覆盖的副本**与**结构不完整的技能**都不算。
             * 它们勾了也不生效（运行时那一步本来就跳过），后端保存时还会按同一口径当失效项丢掉
             * —— 留着只会造成「档案说开着、技能页说没启动」（用户实测：启动一个目录后档案里
             * 多出被覆盖的那个技能）。计数、「全选」、行内开关全部按这一份来。
             */
            var pickable = function (x) { return !x.shadowed && x.loadable !== false }
            var pickableItems = allItems.filter(pickable)
            var items = (function () {
              var q = String(modal.skillQuery || '').trim().toLowerCase()
              if (!q) return allItems
              // 搜索同时匹配技能名与来源名（用户按"来源"找技能是常见动作）。
              return allItems.filter(function (x) {
                var d = skillDisplay(x)
                return (d.name + ' ' + d.source + ' ' + d.key).toLowerCase().indexOf(q) >= 0
              })
            })()
            var pickedCount = pickableItems.filter(function (x) { return sections.skills && sections.skills.indexOf(x.key) >= 0 }).length
            return seg({
              title: t('memory.archive.skills'),
              count: defined ? t('scenes.seg.checked', { checked: pickedCount, total: pickableItems.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addSkills'),
                function () { setSections(Object.assign({}, modalSections(), { skills: [] })) },
                function () { var s = Object.assign({}, modalSections()); delete s.skills; setSections(s) },
                function () { setSections(Object.assign({}, modalSections(), { skills: pickableItems.map(function (x) { return x.key }) })) },
                function () { setSections(Object.assign({}, modalSections(), { skills: [] })) },
                defined && pickableItems.length > 0 && pickableItems.every(function (x) { return sections.skills.indexOf(x.key) >= 0 })),
              body: defined
                ? React.createElement('div', { className: 'dsm-seg-body' },
                    segFilter(modal.skillQuery, function (v) { setModal(Object.assign({}, modal, { skillQuery: v })) }, t('scenes.filter.skills')),
                    items.length
                      ? React.createElement('div', null, items.map(function (item) {
                          var d = skillDisplay(item)
                          var offered = pickable(item)
                          return pickRow({
                            disabled: busy || !offered,
                            key: item.key,
                            checked: offered && sections.skills.indexOf(item.key) >= 0,
                            name: d.name,
                            desc: d.source || null,
                            descTitle: d.key,
                            meta: item.shadowed
                              ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('scenes.skills.shadowed.hint') }, t('status.shadowed'))
                              : (item.loadable === false
                                ? React.createElement('span', { className: 'dsm-tag', title: t('scenes.skills.invalid.hint') }, t('status.invalid'))
                                : (item.enabled === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null)),
                            onChange: function () {
                              var list = sections.skills.slice(); var i = list.indexOf(item.key)
                              if (i >= 0) list.splice(i, 1); else list.push(item.key)
                              setSections(Object.assign({}, modalSections(), { skills: list }))
                            },
                          })
                        }))
                      : React.createElement('div', { className: 'dsm-pick-empty' }, modal.skillQuery ? t('scenes.mem.noMatch') : t('scenes.skills.empty')))
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.skills.hint'))),
              foot: archiveSegFoot(defined, defined ? pickedCount : 0),
            })
          }
          /** 段 3：子智能体绑定。 */
          /** 模式名（官方四个走词典，自建预设用它自己的名字，不翻译）。 */
          function scenePresetLabel(id, short) {
            var presets = (modal.inventory && modal.inventory.presets) || []
            var hit = presets.filter(function (p) { return p.id === id })[0]
            var shipped = { minimal: 1, standard: 1, ptc: 1, cordis: 1 }
            if (shipped[id] === 1 && (!hit || String(hit.trust || 'system') !== 'user')) {
              return t((short ? 'preset.short.' : 'preset.name.') + id)
            }
            return hit ? String(hit.name || id) : id
          }
          /**
           * 人设的按模式工具限制摘要（「标准 白3 · PTC 黑2」）。场景本身不引入"模式"这个
           * 维度 —— 会话跑在哪个模式是建会话时定的，场景改不了；这里只如实显示配了什么。
           */
          function personaRuleSummary(p) {
            var rules = (p && p.toolsByPreset) || {}
            var order = ((modal.inventory && modal.inventory.presets) || []).map(function (x) { return x.id })
            // 按 roster 顺序排（标准 → PTC → 极简 → 创造 → 自建），文件里的书写顺序不参与展示。
            var ids = Object.keys(rules).sort(function (a, b) {
              var ia = order.indexOf(a), ib = order.indexOf(b)
              return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
            })
            if (!ids.length) return null
            return ids.map(function (id) {
              var rule = rules[id] || {}
              var count = (rule.names || []).length
              return scenePresetLabel(id, true) + ' ' + t(rule.mode === 'deny' ? 'subagents.mode.denyOn' : 'subagents.mode.allowOn', { count: count })
            }).join(' · ')
          }
          function subagentsSeg() {
            var sections = modalSections()
            var defined = !!sections.subagents
            var allItems = modal.inventory.subagents || []
            var items = (function () {
              var q = String(modal.subQuery || '').trim().toLowerCase()
              return q ? allItems.filter(function (x) {
                return String(x.name).toLowerCase().indexOf(q) >= 0 || String(x.description || '').toLowerCase().indexOf(q) >= 0
              }) : allItems
            })()
            return seg({
              title: t('memory.archive.subagents'),
              count: defined ? t('scenes.seg.checked', { checked: sections.subagents.length, total: allItems.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addSubagents'),
                function () { setSections(Object.assign({}, modalSections(), { subagents: [] })) },
                function () { var s = Object.assign({}, modalSections()); delete s.subagents; setSections(s) },
                function () { setSections(Object.assign({}, modalSections(), { subagents: allItems.map(function (x) { return x.name }) })) },
                function () { setSections(Object.assign({}, modalSections(), { subagents: [] })) },
                defined && allItems.length > 0 && allItems.every(function (x) { return sections.subagents.indexOf(x.name) >= 0 })),
              body: defined
                ? React.createElement('div', { className: 'dsm-seg-body' },
                    segFilter(modal.subQuery, function (v) { setModal(Object.assign({}, modal, { subQuery: v })) }, t('scenes.filter.subagents')),
                    items.length
                      ? React.createElement('div', null, items.map(function (item) {
                          return pickRow({
                disabled: busy,
                            key: item.name,
                            checked: sections.subagents.indexOf(item.name) >= 0,
                            name: item.name,
                            desc: item.description || null,
                            // 按模式配的工具限制摘要（没配就不显示）：场景改不了会话的模式，
                            // 但要让用户看得见"这条人设在某些模式下是被限工具的"。
                            meta: personaRuleSummary(item),
                            onChange: function () {
                              var list = sections.subagents.slice(); var i = list.indexOf(item.name)
                              if (i >= 0) list.splice(i, 1); else list.push(item.name)
                              setSections(Object.assign({}, modalSections(), { subagents: list }))
                            },
                          })
                        }))
                      : React.createElement('div', { className: 'dsm-pick-empty' }, modal.subQuery ? t('scenes.mem.noMatch') : t('scenes.subagents.empty')))
                : React.createElement('div', { className: 'dsm-seg-body' }, React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.subagents.hint'))),
              foot: archiveSegFoot(defined, defined ? sections.subagents.length : 0, t('memory.archive.emptySubagents')),
            })
          }
          /**
           * 档案编辑弹窗：顶部一行摘要（MCP/技能/子智能体/记忆各勾了多少）+ 四段 + 底部动作。
           * 结构固定 —— 加/删段、进出「选工具」/「选记忆」明细都不会改变弹窗尺寸或元素顺序。
           */
          function archiveNode() {
            if (!modal || modal.type !== 'scene-archive') return null
            var main = React.createElement(Modal, { key: 'sarch', wide: true, className: 'dsm-modal-archive', title: t('memory.archive.title') + ' · ' + (modal.name === '' ? t('memory.scene.global') : modal.name), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('div', { className: 'dsm-archive-meta' },
                  React.createElement('span', null, t('scenes.archive.summary', {
                    mcp: modal.sections.mcp ? Object.keys(modal.sections.mcp).length : 0,
                    skills: modal.sections.skills ? modal.sections.skills.length : 0,
                    subagents: modal.sections.subagents ? modal.sections.subagents.length : 0,
                  }))),
                mcpSeg(),
                skillsSeg(),
                subagentsSeg(),
                memoriesSeg(),
                React.createElement('div', { className: 'dsm-modal-actions' },
                  React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: submitArchive }, t('memory.archive.save')))))
            // MCP 服务器编辑弹窗渲染在外层：不能放进列表 Modal 的滚动容器里（会被裁掉）。
            var edit = modal.drill ? mcpEditNode() : null
            return edit ? React.createElement(React.Fragment, { key: 'sarch-wrap' }, main, edit) : main
          }
          function openDrill(server) {
            setModal(Object.assign({}, modal, { drill: server, drillError: null }))
            setDrillTools(null)
            apiCall('mcpm-tools', { serverName: server }).then(function (res) {
              if (res && res.ok) setDrillTools((res.tools || []).map(function (x) { return { key: server + '/' + x.name, short: x.name, enabled: x.enabled !== false } }))
              else setDrillTools([])
            }).catch(function () { setDrillTools([]) })
          }
          /** 从未运行过的服务器：临时启动枚举工具（后端会轮询并在完成后恢复原启停状态）。 */
          function probeMcpTools() {
            var server = modal.drill
            setDrillTools(null)
            apiCall('mcpm-tools-refresh', { serverName: server }).then(function (res) {
              // 成功也可能带 warning：临时启用过的服务器没能恢复成停用。必须落到提示槽，
              // 否则用户看到工具列表、却不知道自己的服务器已被留在启用态。
              if (res && res.ok) { setDrillTools((res.tools || []).map(function (x) { return { key: server + '/' + x.name, short: x.name, enabled: x.enabled !== false } })); setModal(Object.assign({}, modal, { drillError: res.warning ? String(res.warning) : null })) }
              else { setDrillTools([]); setModal(Object.assign({}, modal, { drillError: res && res.error ? String(res.error) : '' })) }
            }).catch(function (e) { setDrillTools([]); setModal(Object.assign({}, modal, { drillError: errMsg(e) })) })
          }
          function toggleDrillTool(server, short) {
            var sections = modalSections(); if (!sections) return
            var mcp = Object.assign({}, sections.mcp || {})
            var cur = mcp[server] === '*' ? (drillTools || []).filter(function (t) { return t.enabled }).map(function (t) { return t.short }) : (mcp[server] || []).slice()
            var i = cur.indexOf(short)
            if (i >= 0) cur.splice(i, 1); else cur.push(short)
            mcp[server] = cur
            setSections(Object.assign({}, sections, { mcp: mcp }))
          }
          function submitArchive() {
            if (!modalSections()) return
            setBusy(true)
            // P5：档案里**不再写 memories 段** —— 记忆的开关是 `rules[*].enabled` 单一真相源，
            // 在段里勾选时已经即时提交了，这里没有「待保存」的记忆状态。
            apiCall('scene-archive-save', { scene: modal.name, archive: (function () { var payload = {}; if (modal.sections.mcp) payload.mcp = modal.sections.mcp; if (modal.sections.mcpNotes) payload.mcpNotes = modal.sections.mcpNotes; if (modal.sections.skills) payload.skills = modal.sections.skills; if (modal.sections.subagents) payload.subagents = modal.sections.subagents; return payload })() }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                // 当前模式的档案保存后**就地生效**；运行时没应用成功要如实说（别假装生效了）。
                var applyNote = res.applyError ? ' · ' + t('memory.archive.applyFailed', { reason: res.applyError }) : ''
                setResult({ ok: !res.applyError, text: t('memory.result.archiveSaved', { name: modal.name }) + (res.stale && res.stale.length ? ' · ' + t('memory.archive.stale', { items: res.stale.join('、') }) : '') + applyNote })
                refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /**
           * 「进入场景」先问一次：拉 `scene-mode-preview` 把这次会改的东西列出来。
           *
           * 为什么值得多这一步：进入场景是本页**唯一一次改运行时环境**的动作（服务器级 +
           * 工具级 + 来源级 + 技能级 + 人设 + 备注六处），而它此前的反馈只有事后那句结果条。
           * 用户实测的用法是"点进去看看"，出来才发现十几个技能被停了 —— 只能靠退出还原，
           * 而还原读的是快照，快照记的是"进场景前"，不是"你以为你改之前的样子"。
           * 预览失败**不拦**：卡上留一条错误 + 「仍然进入」，别让一个附属读数变成进入场景的
           * 新前置条件。
           */
          function askEnter(name) {
            setPreview({ name: name, loading: true, error: null, plan: null })
            apiCall('scene-mode-preview', { scene: name }).then(function (res) {
              if (res && res.ok) setPreview({ name: name, loading: false, error: null, plan: res })
              else setPreview({ name: name, loading: false, error: translateError(t, res), plan: null })
            }).catch(function (e) { setPreview({ name: name, loading: false, error: errMsg(e), plan: null }) })
          }
          function confirmEnter() {
            if (!preview) return
            var name = preview.name
            setPreview(null)
            enterMode(name)
          }
          /**
           * 名单只铺前若干个：一行塞 60 个名字，卡就变成另一份档案编辑器了。
           *
           * `nameOnly`：技能键是 `<来源>/<名字>`，而自定义来源的键是一串机器名
           * （`custom-d38da02b873bdb5c`）—— 铺在卡上没人认得出那是哪个技能。技能只取名字
           * （最后一段），来源与人设本来就是短名（用户 2026-09-23 裁定）。
           */
          function previewNames(list, nameOnly) {
            var names = (list || []).map(function (item) {
              var text = String(item)
              if (!nameOnly) return text
              var parts = text.split('/')
              return parts[parts.length - 1] || text
            })
            var shown = names.slice(0, 12).join('、')
            return names.length > 12 ? shown + t('scenes.preview.more') : shown
          }
          /** 预览卡正文：`scene-mode-preview` 算出的每个方向一行，没有改动的方向不出行。 */
          function previewRows(plan) {
            var out = []
            if (plan.hasArchive !== true) out.push(React.createElement('div', { key: 'noarch', className: 'dsm-feedback dsm-warning' }, t('scenes.preview.noArchive')))
            if (plan.exit && plan.exit.scene) out.push(React.createElement('p', { key: 'exit', className: 'dsm-help' }, t(plan.exit.snapshotMissing ? 'scenes.preview.exitNoSnapshot' : 'scenes.preview.exitFirst', { scene: plan.exit.scene })))
            var mcp = plan.mcp || {}
            var sk = plan.skills || {}
            var sub = plan.subagents || {}
            var changed = 0
            /**
             * 进入 `target` 之后**会注入**的记忆：该场景自己 + 恒常启用的那两个（服务端给
             * `_shared`（公共基线）与 `global`（全局）的 `active` 恒为 true，所以不必在客户端
             * 写死场景名）。逐条判据与记忆页那一行同源（`!shadowed && enabled !== false && 场景 active`），
             * 差别只有一处：目标场景按"进入后它就是活动场景"算 —— 它现在的 `meta.active` 还是 false。
             */
            function memoriesInScopeAfterEnter(target) {
              var meta = {}
              ;(data.scenes || []).forEach(function (s) { meta[String(s.name)] = s })
              return (data.rules || []).filter(function (r) {
                if (!r || r.shadowed === true || r.enabled === false) return false
                var scene = sceneOfGroup(r.group)
                if (scene === target) return true
                var m = meta[scene]
                return !!(m && m.active !== false)
              })
            }
            /** 一行改动：`names` 为空就不出行（卡片只报真的会变的方向）。 */
            function pushRow(key, list, nameOnly) {
              var names = list || []
              if (!names.length) return
              changed += 1
              out.push(React.createElement('p', { key: key, className: 'dsm-help' }, t(key, { count: names.length, names: previewNames(names, nameOnly === true) })))
            }
            // 按域分组：MCP 改动 → MCP 结果 → 技能 → 人设 → 记忆（改动 + 结果）。
            pushRow('scenes.preview.row.serversOn', mcp.serversOn)
            pushRow('scenes.preview.row.serversOff', mcp.serversOff)
            pushRow('scenes.preview.row.toolsOn', mcp.toolsOn)
            pushRow('scenes.preview.row.toolsOff', mcp.toolsOff)
            // 「进入后启用 N 台 MCP 服务器」：**结果**口径，与上面四行的"会改什么"互补 ——
            // 上面全空时这一段就整段消失，用户读起来像缺了信息（2026-09-23 裁定）。
            var enterServers = (plan.enter && plan.enter.servers) || []
            if (enterServers.length && plan.noChange !== true) {
              out.push(React.createElement('p', { key: 'enter-servers', className: 'dsm-help' }, t('scenes.preview.enter.servers', { count: enterServers.length, names: previewNames(enterServers) })))
            }
            pushRow('scenes.preview.row.sourcesOn', sk.sourcesOn)
            pushRow('scenes.preview.row.sourcesOff', sk.sourcesOff)
            pushRow('scenes.preview.row.skillsOn', sk.on, true)
            pushRow('scenes.preview.row.skillsOff', sk.off, true)
            pushRow('scenes.preview.row.personasOn', sub.on)
            pushRow('scenes.preview.row.personasOff', sub.off)
            if (mcp.notes) {
              changed += 1
              out.push(React.createElement('p', { key: 'notes', className: 'dsm-help' }, t('scenes.preview.row.notes', { count: mcp.notes })))
            }
            // 「进入后启用 N 条记忆」：同上，结果口径（含公共基线与全局，它们也在范围里）。
            // 此前这里还有一行"记忆注入范围收窄到「X」（公共基线与全局不受影响）"—— 用户
            // 2026-09-23 裁定删掉：下面这句把"有几条、是哪些"说全了，那一行只是把同一件事
            // 换个说法再说一遍。
            if (plan.target && plan.noChange !== true) {
              var memScope = memoriesInScopeAfterEnter(plan.target)
              if (memScope.length) {
                out.push(React.createElement('p', { key: 'enter-memories', className: 'dsm-help' }, t('scenes.preview.enter.memories', {
                  count: memScope.length,
                  names: previewNames(memScope.map(function (r) { return String(r.name || r.id) })),
                })))
              }
            }
            if (plan.truncated) out.push(React.createElement('p', { key: 'more', className: 'dsm-help' }, t('scenes.preview.truncated')))
            if ((plan.stale || []).length) out.push(React.createElement('p', { key: 'stale', className: 'dsm-help' }, t('scenes.preview.stale', { count: plan.stale.length, items: previewNames(plan.stale) })))
            if (!changed && !out.length) out.push(React.createElement('p', { key: 'none', className: 'dsm-help' }, t('scenes.preview.nochange')))
            return out
          }
          // 「进入某个场景」= 应用它的档案 + 启用它（单选），于是它的记忆与绑定的提示词
          // 一起生效——用户裁定：「进入其中一个场景，提示词就启动成场景的设置的」。
          function enterMode(name) {
            setBusy(true)
            apiCall('scene-mode-set', { scene: name }).then(function (res) {
              if (!res || !res.ok) { setBusy(false); setResult({ ok: false, text: translateError(t, res) }); return }
              apiCall('rules-set-active', { scenes: [name] }).then(function (act) {
                setBusy(false)
                var staleNote = res.stale && res.stale.length ? ' · ' + t('memory.archive.stale', { items: res.stale.join('、') }) : ''
                // 如实报「上层切了几台服务器 / 几个来源」——否则用户不知道勾选到底生效没有。
                var switchNote = res.switched && (res.switched.mcpServers || res.switched.skillSources)
                  ? ' · ' + t('memory.result.modeSwitched', { mcp: res.switched.mcpServers, skills: res.switched.skillSources })
                  : ''
                if (act && act.ok) setResult({ ok: true, text: t('memory.result.modeSet', { name: name }) + switchNote + staleNote })
                else setResult({ ok: false, text: t('memory.result.modeSet', { name: name }) + switchNote + staleNote + ' · ' + translateError(t, act) })
                refresh(true)
              }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }); refresh(true) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /**
           * 退出模式（P6）：与开关**同一条路径** —— 恢复档案 + 取消场景启用，两者一起写。
           * 顶部横幅的「退出模式」按钮和卡片开关点它，效果完全一致（用户裁定：「是真的退出了」）。
           */
          function exitMode() {
            setBusy(true)
            apiCall('scene-mode-set', { scene: null }).then(function (res) {
              if (!res || !res.ok) { setBusy(false); setResult({ ok: false, text: translateError(t, res) }); return }
              // 档案已恢复 → 同步取消场景启用，保证 mode.scene 与 active 恒等。
              apiCall('rules-set-active', { scenes: [] }).then(function (act) {
                setBusy(false)
                if (act && act.ok) setResult({ ok: true, text: t('memory.result.modeExited') })
                else setResult({ ok: false, text: t('memory.result.modeExited') + ' · ' + translateError(t, act) })
                refresh(true)
              }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }); refresh(true) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          var modeScene = data.mode && data.mode.scene
          // 遗留检测 + 预设场景过滤 + 三格统计 + 「启用的排前面」：一次算完。这四步只跟
          // `data.scenes` / `data.archives` 有关，弹窗、提示条、忙碌标记之类的状态变化不再重跑。
          // 卡片 key 与 data-flip-* 仍来自场景名与前两态，未动。
          var sceneView = React.useMemo(function () {
            // 历史「全部启用」遗留检测：单选模型下同时启用多个场景是歧义状态（见下方收敛条）。
            var legacy = (data.scenes || []).filter(function (s) { return s.active === true && !s.shared && !s.global })
            /**
             * 场景页只列**可切换的预设场景**：保留场景 `global`（「全局」）不在这里出现。
             *
             * 用户裁定：「全局记忆都不用设置场景就能注入上下文，如果我需要设置 skills、mcp，我直接去具体页
             * 设置就好了，所以说场景不需要展示全局，不需要设置全局，只有有特定需求才需要设置专门的场景。」
             * —— 全局不是预设而是恒定基线，列成卡片只会让人以为它可启停/可切换；它的记忆在「记忆」页照常
             * 管理，档案弹窗「记忆」段与各种场景选择器也照常保留全局（否则全局记忆在界面上就没有落点了）。
             * 过滤只做在这一页：宿主回传的 `scenes` 仍含全局，记忆页与选择器都依赖它。
             */
            var presets = (data.scenes || []).filter(function (s) { return s.global !== true })
            // 与 MCP / 技能页同构的三格统计（页面之间「头顶长什么样」保持一致）——同样只数可见的预设场景。
            var stats = {
              total: presets.length,
              active: presets.filter(function (s) { return s.active === true }).length,
              archives: presets.filter(function (s) { return !!data.archives[s.name] }).length,
            }
            /**
             * 搜索只过滤列表，不动三格统计 —— 与子智能体页同口径：统计答"这台机器上有几个"，
             * 列表答"当前筛选下看得见几个"。匹配范围 = 卡片上真会显示的四样：目录名、显示名、
             * 一行描述、绑定的提示词预设 id（`_shared` / `global` 这些保留名不在卡片上，不匹配）。
             */
            var visible = presets.filter(function (s) {
              return matchByText([s.name, sceneLabel(data.scenes, s.name), sceneTileDesc(s), s.prompt], dq)
            })
            return {
              legacyAllScenes: legacy,
              presetScenes: presets,
              sceneStats: stats,
              visibleScenes: visible,
              orderedScenes: enabledFirst(visible, function (scene) { return scene.active === true; }),
            }
          }, [data.scenes, data.archives, dq])
          var legacyAllScenes = sceneView.legacyAllScenes
          var presetScenes = sceneView.presetScenes
          var sceneStats = sceneView.sceneStats
          var orderedScenes = sceneView.orderedScenes
          var visibleScenes = sceneView.visibleScenes
          /**
           * 档案里已配的东西，一行摘要（没绑的域不出现）。
           *
           * 它只出现在页首的「当前模式」条上：卡片上不再挂任何数量——那正是「卡片又乱又挤」
           * 的来源。全页只有这一处回答「当前生效的配置是什么」。
           */
          function archiveSummary(archive) {
            if (!archive) return ''
            var parts = []
            if (archive.mcp) parts.push(t('scenes.profile.mcp', { count: Object.keys(archive.mcp).length }))
            if (Array.isArray(archive.skills)) parts.push(t('scenes.profile.skills', { count: archive.skills.length }))
            if (Array.isArray(archive.subagents)) parts.push(t('scenes.profile.subagents', { count: archive.subagents.length }))
            // P5：记忆**不再是档案的一部分**（开关是 `rules[*].enabled` 单一真相源），
            // 所以这里不再统计 memories —— 否则会显示一个已经不存在的段的数量。
            return parts.join(' · ')
          }
          // 当前模式场景被锁 → 「退出模式」按钮与开关一起禁用（服务端守卫兜底）。
          var modeSceneLocked = !!(modeScene && (data.scenes || []).some(function (s) { return s.name === modeScene && s.locked === true }))
          var modeSummary = modeScene ? archiveSummary(data.archives[modeScene]) : ''
          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('scenes.title'))),
                React.createElement('p', { className: 'dsm-desc' }, t('scenes.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, busy || data.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: openCreateScene }, t('memory.btn.newScene')),
                // 进入场景前的提醒开关（用户 2026-09-23 裁定放在「回收站」左边）。按钮文字是
                // **动作**：现在会弹 → 写「关闭提醒」；已经关掉 → 写「开启提醒」。
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-secondary', title: t('scenes.preview.toggle.title'),
                  onClick: function () { saveEnterPreview(!enterPreview) },
                }, t(enterPreview ? 'scenes.preview.toggle.off' : 'scenes.preview.toggle.on')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { loadTrash(false) } }, t('trash.btn.open')))),
            React.createElement('div', { key: 'stats', className: 'dsm-summary' },
              [[sceneStats.total, t('scenes.stat.total')], [sceneStats.active, t('scenes.stat.active')], [sceneStats.archives, t('scenes.stat.archives')]].map(function (item) {
                return React.createElement('div', { key: item[1], className: 'dsm-stat' },
                  React.createElement('strong', null, item[0]), item[1])
              })),
            // 搜索框：统计条之后（与 MCP / 技能 / 记忆 / 提示词 / 子智能体页同一位置与样式）。
            React.createElement('div', { key: 'filters', className: 'dsm-filters' },
              React.createElement('input', {
                className: 'dsm-control dsm-search', value: query, 'aria-label': t('search'),
                placeholder: t('scenes.search.placeholder'),
                onChange: function (e) { setQuery(e.target.value) },
              })),
            // 当前模式条：**只在真的进入了模式时才出现**。
            // 以前没有模式时也常驻一条「自由模式 + 一句解释」，用户反馈「这个是干什么的，感觉没什么用」——
            // 静态解释占一整条，而「没有条 = 没有模式」本来就不言自明。现在它只承载有状态的信息：
            // 哪个场景是当前模式、它包含什么档案、怎么退出。
            modeScene ? React.createElement('div', { key: 'mode', className: 'dsm-mode-bar' },
              React.createElement('span', { className: 'dsm-mode-dot' }),
              React.createElement('div', { className: 'dsm-mode-main' },
                React.createElement('div', { className: 'dsm-mode-title' },
                  t('scenes.mode.active', { name: sceneLabel(data.scenes, modeScene) || modeScene })),
                React.createElement('div', { className: 'dsm-mode-sub' },
                  modeSummary ? t('scenes.mode.profile', { parts: modeSummary }) : t('scenes.mode.noProfile'))),
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || modeSceneLocked, title: modeSceneLocked ? t('scenes.lock.blockedExit') : '', onClick: exitMode }, t('memory.mode.exit'))) : null,
            React.createElement(Notice, { key: 'notice', kind: result && result.ok ? 'ok' : 'err', text: result && result.text }),
            React.createElement(UndoBar, { key: 'undo', undo: undo, busy: busy, t: t, onUndo: undoMemories, onClose: dismissUndo }),
            // 历史「全部启用」（active=null）遗留：单选模型下多名场景同时在场是歧义状态。
            // 不静默改写（那会改变注入范围），而是给一个显式收敛按钮，并说清点下去会发生什么。
            legacyAllScenes.length > 1 ? React.createElement('div', { key: 'legacyall', className: 'dsm-feedback dsm-warning' },
              React.createElement('span', null, t('scenes.legacyAll', { count: legacyAllScenes.length })),
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { enterMode(legacyAllScenes[0].name) } }, t('scenes.legacyAll.fix'))) : null,
            // 改名 / 删除留下的悬空引用：这一条列表上看着还绑着，运行时按那个名字已经找不到了。
            // 只说"哪一条指向谁、那个谁不在了"，不代做修复 —— 猜着改名字比留着更危险。
            (function () {
              var doctor = data.doctor
              if (!doctor) return null
              var findings = doctor.findings || []
              if (!findings.length && !(doctor.skipped || []).length) return null
              var shown = findings.slice(0, 6)
              return React.createElement('div', { key: 'doctor', className: 'dsm-feedback dsm-warning' },
                React.createElement('div', { key: 'head' }, findings.length
                  ? t('scenes.doctor.title', { count: findings.length })
                  : t('scenes.doctor.noneButSkipped'), React.createElement('span', null, ' ' + t('scenes.doctor.hint'))),
                shown.map(function (row, i) {
                  return React.createElement('div', { key: 'd' + i, className: 'dsm-help' }, t('scenes.doctor.row', { where: row.where, name: row.name }))
                }),
                findings.length > shown.length ? React.createElement('div', { key: 'more', className: 'dsm-help' }, t('scenes.doctor.more', { count: findings.length - shown.length })) : null,
                (doctor.skipped || []).length ? React.createElement('div', { key: 'skip', className: 'dsm-help' }, t('scenes.doctor.skipped', { domains: doctor.skipped.join('、') })) : null)
            })(),
            data.error ? React.createElement(Notice, { key: 'gerr', kind: 'err', text: String(data.error) }) : null,
            data.loading && !presetScenes.length ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
              : !presetScenes.length ? React.createElement('div', { key: 'empty', className: 'dsm-empty' }, t('scenes.empty'))
              : !visibleScenes.length ? React.createElement('div', { key: 'emptysearch', className: 'dsm-empty' }, t('scenes.empty.search'))
              : React.createElement('div', { key: 'scenes', className: 'dsm-scenes', ref: flipRef }, orderedScenes.map(function (scene) {
                var name = scene.name
                var label = sceneLabel(data.scenes, name) || name
                var archive = data.archives[name]
                // 全局已被上面的 presetScenes 过滤掉，这里只会遇到可切换的预设；
                // 历史保留场景 `_shared`（「常开」）仍然恒定注入，所以不给开关也不给删除。
                var locked = scene.shared === true
                var sceneLocked = scene.locked === true
                // 档案里有任何一段才值得「切入此模式」——空档案切进去等于什么都没变。
                var desc = sceneTileDesc(scene)
                // 单选：别的场景已启用时，这个开关置灰（点也没用，服务端只接受一个）。
                var blockedByOther = scene.active !== true && scene.selectable === false
                // 绑定的提示词预设：生效中 / 已启用但预设不见了 / 绑了但没启用，三种如实分开。
                var boundPrompt = scene.prompt || ''
                var promptLive = !!(boundPrompt && data.scenePrompt && data.scenePrompt.scene === name)
                var promptMissing = promptLive && data.scenePrompt.missing === true
                // 生效中但 AGENTS.md 里不是它（被手动改过？）——「显示必须等于实际注入」，
                // 不一致就如实标出来，别让用户以为文件里就是它。
                var promptMismatch = promptLive && !promptMissing && data.scenePrompt.duplicate !== true
                return React.createElement('article', { key: 's:' + name, className: 'dsm-scene-tile' + (modeScene === name ? ' dsm-scene-tile-mode' : ''), 'data-flip-key': 's:' + name, 'data-flip-on': scene.active === true ? '1' : '0' },
                  React.createElement('div', { className: 'dsm-scene-tile-head' },
                    React.createElement('span', { className: 'dsm-scene-tile-name', title: label }, label),
                    // 显示名与磁盘目录名不同时才标出真名，方便对文件核对。
                    name === label ? null : React.createElement('span', { className: 'dsm-scene-tile-key' }, name),
                    locked ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.shared')) : null,
                    modeScene === name ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.mode.current')) : null,
                    sceneLocked ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('scenes.lock.tag')) : null,
                    !locked && scene.active === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null,
                    boundPrompt ? React.createElement('span', {
                      className: 'dsm-tag' + (promptMissing ? ' dsm-tag-off' : promptLive ? ' dsm-tag-on' : ''),
                      title: promptMismatch ? t('scenes.prompt.mismatch.hint', { id: boundPrompt }) : t('scenes.prompt.tag.hint'),
                    }, promptMissing
                      ? t('scenes.prompt.missing', { id: boundPrompt })
                      : promptLive ? t('scenes.prompt.live', { id: boundPrompt }) : t('scenes.prompt.bound', { id: boundPrompt })) : null,
                    promptMismatch ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('scenes.prompt.mismatch.hint', { id: boundPrompt }) }, t('agm.file.mismatch')) : null,
                    locked ? null : React.createElement('span', {
                      className: 'dsm-scene-tile-switch',
                      title: blockedByOther ? t('scenes.enable.blocked', { name: sceneLabel(data.scenes, data.activeScene) || data.activeScene || '' }) : (sceneLocked && scene.active === true ? t('scenes.lock.blockedExit') : ''),
                    }, React.createElement(Switch, { on: scene.active === true, disabled: busy || blockedByOther || (sceneLocked && scene.active === true), label: t('memory.scene.enable') + ' ' + name, onClick: function () { toggleScene(scene) } })),
                    locked ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-lock', disabled: busy || scene.active !== true, title: scene.active !== true ? t('scenes.lock.notActive') : t('scenes.lock.hint'), onClick: function () { toggleSceneLock(scene) } }, sceneLocked ? t('scenes.lock.unlock') : t('scenes.lock.lock'))),
                  // 描述行**只有描述**（数量都收进上面的模式条了）；全文放 title，卡片本身永远一行。
                  React.createElement('p', { className: 'dsm-scene-tile-desc', title: desc || '' }, desc || t('scenes.noDesc')),
                  // P6：「切入此模式」按钮已删除 —— 右上角开关就是唯一入口（开 = 进入，关 = 回全局默认）。
                  React.createElement('div', { className: 'dsm-scene-tile-foot' },
                    React.createElement('div', { className: 'dsm-scene-tile-links' },
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || sceneLocked, title: sceneLocked ? t('scenes.lock.blockedEdit') : '', onClick: function () { openArchive(name) } }, t('memory.archive.edit')),
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { openEditScene(scene) } }, t('memory.scene.edit')),
                      locked ? null : React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy || sceneLocked, title: sceneLocked ? t('scenes.lock.blockedEdit') : '', onClick: function () { setModal({ type: 'scene-delete', name: name }) } }, t('memory.btn.deleteScene')))))
              })),
            modal && (modal.type === 'scene-create' || modal.type === 'scene-edit') ? React.createElement(Modal, { key: 'screate', title: modal.type === 'scene-create' ? t('memory.scene.createTitle') : t('memory.scene.editTitle'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.scene.field.name')),
                  React.createElement('input', {
                    className: 'dsm-control' + (sceneForm.error ? ' dsm-rule-invalid' : ''),
                    value: sceneForm.name || '',
                    placeholder: t('memory.scene.field.name.placeholder'),
                    onChange: function (e) { setSceneForm(Object.assign({}, sceneForm, { name: e.target.value, error: null })) },
                  }),
                  React.createElement('p', { className: sceneForm.error ? 'dsm-rule-hint' : 'dsm-help' }, sceneForm.error || (modal.type === 'scene-create' ? t('memory.scene.field.name.hint') : t('memory.scene.field.name.lock')))),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('div', { className: 'dsm-budget-meta' },
                    React.createElement('span', { className: 'dsm-label' }, t('memory.scene.field.desc')),
                    // 字数上限 = 存多少（`SCENE_DESC_MAX`）；卡片那一行靠 CSS 省略号截，不靠这个数。
                    React.createElement('span', { className: 'dsm-char-count' }, String(String(sceneForm.description || '').length) + '/' + SCENE_DESC_MAX)),
                  React.createElement('input', {
                    className: 'dsm-control',
                    value: sceneForm.description || '',
                    maxLength: SCENE_DESC_MAX,
                    placeholder: t('memory.scene.field.desc.placeholder'),
                    onChange: function (e) { setSceneForm(Object.assign({}, sceneForm, { description: e.target.value, error: null })) },
                  })),
                // 提示词预设：一个场景**只能绑一个**（单值字段天然单选）；「不绑定」= 解绑。
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('scenes.field.prompt')),
                  presetOptions.length > 0
                    ? React.createElement(SourceSelect, { options: presetOptions, value: sceneForm.prompt || '', onChange: function (v) { setSceneForm(Object.assign({}, sceneForm, { prompt: v })) } })
                    : React.createElement('p', { className: 'dsm-help' }, t('scenes.prompt.noPresets')),
                  helpBullets(t, 'scenes.field.prompt.hint')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || !String(sceneForm.name || '').trim(), onClick: submitSceneForm }, t(modal.type === 'scene-create' ? 'memory.btn.create' : 'memory.btn.saveScene'))))) : null,
            modal && modal.type === 'scene-delete' ? React.createElement(Modal, { key: 'sdel', title: t('memory.deleteScene.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.deleteScene.desc', { name: modal.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDeleteScene(modal.name) } }, t('memory.btn.deleteScene')))) : null,
            // 「进入场景」的改动预览卡（askEnter）。预览拿不到时不拦进入这条路 ——
            // 这是一张说明卡，不是一道新门禁；把它做成前置条件就等于新增了"进不去场景"。
            //
            // 按钮（用户 2026-09-23 裁定）：**只有「确认进入」与「不再显示」**。原先那颗
            // 「先不进入」与右上角的「关闭」是同一个动作的两颗按钮，删掉那颗；「不再显示」
            // = 关掉卡片 + 以后不再弹（也不进入），想恢复用右上那颗「开启提醒」。
            preview ? React.createElement(Modal, { key: 'spreview', title: t('scenes.preview.title', { name: preview.name }), closeLabel: t('btn.close'), onClose: function () { setPreview(null) } },
              preview.loading ? React.createElement('p', { className: 'dsm-help' }, t('scenes.preview.loading'))
                : preview.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, t('scenes.preview.failed', { error: preview.error }))
                  : previewRows(preview.plan || { target: preview.name }),
              React.createElement('div', { className: 'dsm-modal-actions dsm-modal-actions-split' },
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, title: t('scenes.preview.dismiss.title'),
                  onClick: function () { setPreview(null); saveEnterPreview(false) },
                }, t('scenes.preview.dismiss')),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || preview.loading, onClick: confirmEnter }, t('scenes.preview.enter')))) : null,
            // 档案编辑器（见 archiveNode）：三段共用「段卡片 + 勾选行」排版。
            archiveNode(),
            trash ? React.createElement(TrashModal, {
              t: t,
              title: t('trash.title'),
              groupTitle: t('trash.group.scenes'),
              groupSub: t('trash.section.scenes.sub'),
              entries: trash.entries,
              loading: trash.loading,
              error: trash.error,
              busy: trashBusy,
              onClose: function () { setTrash(null) },
              onRestore: restoreScene,
              onPurge: purgeScene,
            }) : null,
          )
        }