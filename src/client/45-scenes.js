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
          // 切走这一页 → 场景编辑器关窗时那份暂存作废（见 42-shared-ui.js 的 useFormDraftScope）。
          useFormDraftScope('scene:')
          // 「新建记忆」子弹窗误关后的暂存槽（用户 2026-10-17：编辑器里那颗「创建」点开写完，
          // 手一滑点到背板就全没了，而记忆页 / 技能页都有 30 秒兜底）。
          // key 跟着**这次编辑的是哪个场景**走（`modal.draftKey` 就是 `scene:create` /
          // `scene:edit:<名字>`）：固定一个槽会让「在 A 里关掉、到 B 里点创建」取回 A 的草稿。
          // 新建 / 编辑**两个槽分开** —— takeFormDraft 是取回即销账，共用一个槽的话，
          // 先误关一条编辑中的、再去点「创建」，那份就会被当成"不是新建"而白白丢掉。
          // 前缀仍是 `scene:`，切走这一页照旧整组作废。
          function memNewDraftKey(editing) {
            return String((modal && modal.draftKey) || 'scene:create') + (editing ? ':memedit' : ':memnew')
          }
          var pos = React.useState([])
          var presetOptions = pos[0], setPresetOptions = pos[1]
          // 当前**生效中**的提示词预设 id（`agentsmd-list` 里 active 的那份）。预览卡要用它把
          // 「本场景没绑 = 保持现状」写成一句能对照的话 —— 用户 2026-10-12 报障「全局提示词明明
          // 绑定了还显示未绑定」：事实是全局那份一直在生效，只是**这个场景**没去改它；不把那份的
          // 名字报出来，"保持现状"和"未绑定"在用户眼里就是同一个意思。
          var aps = React.useState('')
          var appliedPreset = aps[0], setAppliedPreset = aps[1]
          // 工具表方案下拉的数据源（C1；按用户 2026-09-28 裁定从档案编辑器移进「编辑场景」表单）。
          var tts = React.useState(null)
          var ttInfo = tts[0], setTtInfo = tts[1]
          // 快捷提示词候选（同一族：勾选入口在「修改场景」表单里，档案编辑器不带这一栏）。
          var qps = React.useState([])
          var quickOptions = qps[0], setQuickOptions = qps[1]
          // 快捷提示词的勾选弹窗（2026-10-12 用户「能不能设置成弹窗」）：清单不再就地展开成
          // 一张横跨整行的卡片（它属于顶部第 4 格那颗下拉，却离得很远、又和四组不是同一套卡片），
          // 改成表单格里一颗按钮点开的独立弹窗。null = 关闭；{ draft } = 草稿（确定才写回表单）。
          var qks = React.useState(null)
          var quickPick = qks[0], setQuickPick = qks[1]
          var dts = React.useState(null)
          var drillTools = dts[0], setDrillTools = dts[1]
          // 记忆集组头的「创建」（用户 2026-10-14）：套用记忆页的「新建记忆」表单，但**不带场景
          // 选择器** —— 记忆归属由当前编辑的场景定死，于是这里建出来的条目立刻出现在本组清单里。
          // null = 关闭；{ name, description, body, form, files, error } = 草稿。
          var mns = React.useState(null)
          var memNew = mns[0], setMemNew = mns[1]
          // 「已存在同名记忆」确认弹窗（用户 2026-10-14 第二轮）：`{ name, finalName }` 或 null。
          // 撞名不再在提交那一刻静默退号，先问一句；确认后才按 `finalName` 攒成草稿。
          var mds = React.useState(null)
          var memDupAsk = mds[0], setMemDupAsk = mds[1]
          // 场景本身撞名的确认弹窗（同一天同一套设计）：`{ name, finalName }` 或 null。
          // 场景与记忆共用一颗弹窗组件，但状态分开 —— 两个入口能同时存在（编辑器里开着
          // 记忆新建窗时再点保存场景），合成一个状态会让其中一个把另一个顶掉。
          var sds = React.useState(null)
          var sceneDupAsk = sds[0], setSceneDupAsk = sds[1]
          var memAttachRef = React.useRef(null)
          // 附件上限与服务端 MAX_ATTACH_ENTRY_BYTES 对齐（记忆页同一口径）。
          var MEM_ATTACH_MAX_MB = 8
          var MEM_ATTACH_MAX_BYTES = MEM_ATTACH_MAX_MB << 20
          // 场景回收站：true = 打开本页那一个回收站（42-shared-ui.js 的 TrashModal）。
          // 清单加载 / 恢复 / 永久删除 / 批量都在组件内部完成，本页只在写操作后重读自己的数据。
          var sts = React.useState(false)
          var trash = sts[0], setTrash = sts[1]
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
          /**
           * 「勾选的排前面」的定序快照（用户 2026-10-12：「选择的时候可以不置顶，
           * 但是创建后打开编辑需要置顶」）：编辑器四组共用一张表，**换一次打开就重建**
           * （关弹窗时 `modal` 归 null，key 变化 → 清表）。排序本身用全站同一个 rankedFirst。
           */
          var editorRankRef = React.useRef(null)
          var editorKey = modal && modal.type === 'scene-editor' ? 'editor:' + String(modal.name) : ''
          if (!editorRankRef.current || editorRankRef.current.key !== editorKey) editorRankRef.current = { key: editorKey, table: {} }
          function checkedFirst(group, list, idOf, isChecked) {
            return rankedFirst(editorRankRef.current, function (item) { return group + '|' + String(idOf(item)) }, list, isChecked)
          }
          // 场景卡片的「启用的排前面」同一口径：开关当场不重排，刷新或重进这页才重新置顶。
          var sceneRank = useRank()
          React.useEffect(function () { if (!result || result.ok !== true) return undefined; var timer = setTimeout(function () { setResult(null) }, 2600); return function () { clearTimeout(timer) } }, [result])
          /**
           * 本页要订阅当前层（0.21.2）：卡片边框、开关值、三格统计都跟着层走。
           * 不订阅时切层只重画顶部那颗下拉，卡片还是上一层那一份（"切换会话没有刷新"）。
           */
          var scopeState = useScopeLayer()
          /** 取数用的会话 id：全局层传空串（= 服务端按全局口径算）。 */
          function scopeSessionId() { return scopeIsSession() ? scopeState.sessionId : '' }
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
            // 记忆开关在这页是**全局**状态的一部分：档案弹窗的勾选、进入预览、档案摘要说的都是
            // "全局进入这个场景会发生什么"。会话层不能拿投影后的 `enabled` 顶替 —— 看到的是本
            // 会话的值、点下去写的是 `rules-toggle`（全局），两者会错位成"点了没反应"。
            // 先挂一个 catch：它要在投影那次请求成功之后才被消费，若投影先失败，这个
            // promise 会没有人接 —— 一次网络抖动就会在控制台留一条未处理拒绝。
            var globalRulesCall = scopeIsSession() ? apiCall('rules-list', {}).catch(function () { return null }) : null
            apiCall('rules-list', { sessionId: scopeSessionId() }).then(function (r) {
              // rules 也留下来：档案弹窗「记忆」段的默认勾选要用每条记忆的启用状态
              //（scene-inventory 的 memories 里没有 enabled，客户端自己算，省一次宿主改动）。
              if (r && r.ok) {
                setData(function (prev) { return Object.assign({}, prev, { loading: false, error: null, scenes: r.scenes || [], rules: r.rules || [], activeMode: r.activeMode === 'custom' ? 'custom' : 'all', activeScene: r.activeScene || null, scenePrompt: r.scenePrompt || null, stats: r.stats || prev.stats }) })
                if (globalRulesCall) globalRulesCall.then(function (g) {
                  if (g && g.ok) setData(function (prev) { return Object.assign({}, prev, { rules: g.rules || [] }) })
                }).catch(function () { /* 读不到就先用投影那份兜底，下一次刷新再来 */ })
              } else setData(function (prev) { return Object.assign({}, prev, { loading: false, error: translateError(t, r) }) })
            }).catch(function (e) { setData(function (prev) { return Object.assign({}, prev, { loading: false, error: errMsg(e) }) }) })
          }
          // 切层时**重取**（不是只重渲染）：本层的场景生效值、记忆开关都由服务端按
          // `sessionId` 投影，手里那份是上一层算出来的。
          React.useEffect(function () { refresh() }, [scopeState.sessionId])
          /** 读一次界面设置（读不到就保持默认 = 弹卡，本页其它功能不受影响）。 */
          function loadSceneSettings() {
            apiCall('scene-settings', {}).then(function (res) {
              if (res && res.ok && res.settings) setEnterPreview(res.settings.enterPreview !== false)
            }).catch(function () { /* 读不到 → 保持默认（弹卡） */ })
          }
          React.useEffect(function () { loadSceneSettings() }, [])
          // 预设候选与"当前生效的那份"在挂载时就取一次：预览卡要用后者（见 appliedPreset），
          // 而它此前只在打开编辑器时才拉 —— 于是不打开编辑器就永远读不到。
          React.useEffect(function () { loadPresetOptions() }, [])
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
            var note = ''
            if (sync.error) note += ' · ' + t('scenes.agents.note.error', { reason: String(sync.error) })
            else if (sync.applied) note += ' · ' + t('scenes.agents.note.applied', { id: String(sync.applied) })
            else if (sync.restored) note += ' · ' + t('scenes.agents.note.restored')
            // 「基线快照没能写入」与「AGENTS.md 有没有写」是两件事：前者是**切进去了但退不回来**，
            // 必须单独说，否则用户以为还能退出场景恢复原样（审查 F14）。
            if (sync.baselineError) note += ' · ' + t('scenes.agents.note.baselineLost', { reason: String(sync.baselineError) })
            return note
          }
          // ── 场景启用：**除「全局」外同时只能启用一个**（用户裁定）──
          // 空数组 = 全部关闭（只留恒常的 `_shared` 与 `global`）；服务端也会拒绝多个。
          function setActiveScenes(names) {
            if (busy) return
            setBusy(true); setResult(null)
            apiCall('rules-set-active', { scenes: names }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { setResult({ ok: !(res.agentsMd && (res.agentsMd.error || res.agentsMd.baselineError)), text: t('memory.result.active') + agentsMdNote(res) }); refresh(true); syncScopeBar() }
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
            // 会话作用域（0.21.2）：会话层切场景 = **进入 / 退出场景模式** —— 不调
            // scene-mode-set、不调 rules-set-active、不写 AGENTS.md。与全局层同一副交互：
            // 点生效中的那个 = 退出模式（回到本对话创建时的样子），点别的 = 进入它。
            // 进入时服务端会把档案里勾中、而全局关着的服务器 / 来源按租约临时运行
            // （连接是进程级的，但只有本对话看得见），警告挂到作用域条上。
            if (scopeIsSession()) {
              var flagHere = scopeScene(data.activeScene)
              var next = flagHere.value === scene.name ? null : scene.name
              setBusy(true)
              scopeWriteScene(next, function () { return { ok: true } })
                .then(function (res) {
                  setBusy(false)
                  if (res && res.ok === false) { setResult({ ok: false, text: translateError(t, res) }); return }
                  // 场景绑了工具表方案时把这一档也报出来（0.21.2：方案只套到**本对话**）。
                  var tt = res && res.toolTable
                  var ttText = next !== null && tt && tt.applied
                    ? ' ' + t('scope.scene.toolTable', { preset: tt.preset, count: tt.hidden })
                    : ''
                  setResult({ ok: true, text: (next === null
                    ? scopeT('scope.scene.exitMode')
                    : scopeT('scope.scene.entered', { name: sceneLabel(data.scenes, scene.name) || scene.name })) + ttText })
                  refresh(true)
                })
                .catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
              return
            }
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
              // 这里只放预设本身；表单里那颗下拉会在最前面补一条「无（不绑定提示词）」。
              // 默认选中当前生效的那份（用户裁定「默认就是当前启动的」）。
              var opts = []
              list.forEach(function (p) { opts.push({ value: p.id, label: p.active ? (p.id + ' · ' + t('scenes.prompt.activeTag')) : p.id }) })
              setPresetOptions(opts)
              var activeId = ''
              for (var i = 0; i < list.length; i += 1) { if (list[i].active) { activeId = list[i].id; break } }
              setAppliedPreset(activeId)
              if (typeof onLoaded === 'function') onLoaded(activeId)
            }).catch(function () { /* 候选项加载失败只影响下拉默认值，不值得打断表单 */ })
          }
          /** 表单里没显式选过时，把「提示词」默认填成当前生效的那份（不覆盖已有选择）。 */
          function defaultPromptToActive(activeId) {
            if (!activeId) return
            setSceneForm(function (f) { return (f && String(f.prompt || '') !== '') ? f : Object.assign({}, f, { prompt: activeId }) })
          }
          // ── 场景编辑器（REDESIGN §6.2：新建 / 编辑 / 档案 三弹窗融合，「创建即编辑」）──
          // name=null = 创建态（四组全空、主按钮=创建）；编辑态场景名只读（§6.2）。
          // 快捷提示词在表单里是**三选一**，落盘时映射成 `quickPrompts` 的三种取值：
          //   'current' → null（这一域不绑、进出不碰）／'none' → []（绑空表：进入后全部停用）
          //   ／'custom' → 勾选数组（**空数组也算 custom**）。
          //
          // 为什么表单要单独存一个 `quickMode`，而不是像原来那样从数组反推下拉值：
          // 「无」现在**不显示**「本场景启用」那张勾选卡（用户 2026-10-10），于是"数组为空"
          // 必须能分出两种来 —— 用户主动选了「无」，和用户选了「自定义」但一条都还没勾。
          // 反推的话后者会立刻翻成「无」、卡片当场消失，连勾第二条的机会都没有。
          //
          // 新建场景默认 'none'（用户 2026-10-10：「无应该是第一条，新建场景默认选择」）。
          // 口径与档案里另外三域一致：MCP / 技能 / 人设本来就是「一段都没建 = 该域全部停用」，
          // 新场景起手就是"一个都不启用"，快捷提示词跟着走才不别扭；而 `null`（进出都不碰）
          // 留给 0.18.0 之前建的老场景，编辑时按档案原样回填。
          function openEditor(scene) {
            var name = scene ? scene.name : null
            var sceneArchive = scene ? ((data.archives || {})[name] || {}) : {}
            // 子弹窗（新建记忆）随编辑器一起重开：留着上一轮的草稿会让人以为"我上次填的还在"。
            setMemNew(null)
            var draftKey = name ? 'scene:edit:' + name : 'scene:create'
            // 暂存的是**整份编辑器状态**（基本信息 + 四个工具集的勾选 + 待创建记忆）：
            // 只存基本信息的话，误关一次就把用户真正在挑的东西全丢了（用户 2026-10-16 报的这条）。
            var draft = takeFormDraft(draftKey)
            setSceneForm(Object.assign({
              name: name || '', description: scene ? scene.description || '' : '', prompt: scene ? scene.prompt || '' : '',
              toolTablePreset: typeof sceneArchive.toolTablePreset === 'string' ? sceneArchive.toolTablePreset : '',
              quickMode: !Array.isArray(sceneArchive.quickPrompts)
                ? 'current' : (sceneArchive.quickPrompts.length ? 'custom' : 'none'),
              quickPrompts: Array.isArray(sceneArchive.quickPrompts) ? sceneArchive.quickPrompts.slice() : null,
              error: null,
            }, (draft && draft.form) || {}, { error: null }))
            setModal({
              type: 'scene-editor', name: name, draftKey: draftKey, drill: null, drillError: null, error: null, inventory: null,
              mcpQuery: '', skillQuery: '', subQuery: '', memQuery: '',
              // 创建态里攒下的记忆（见 flushPendingMemories）：`rules-create` 要求目标场景已存在，
              // 所以场景还没落盘时只能先记在这里，等场景建出来再补。编辑态恒为空数组。
              pendingMems: draft ? (draft.pendingMems || []) : [],
              sections: draft && draft.sections ? draft.sections : {
                mcp: sceneArchive.mcp ? Object.assign({}, sceneArchive.mcp) : null,
                mcpNotes: sceneArchive.mcpNotes && Object.keys(sceneArchive.mcpNotes).length ? Object.assign({}, sceneArchive.mcpNotes) : null,
                skills: Array.isArray(sceneArchive.skills) ? sceneArchive.skills.slice() : null,
                subagents: Array.isArray(sceneArchive.subagents) ? sceneArchive.subagents.slice() : null,
              },
            })
            // 提示词绑定的候选：**新建**场景默认选当前生效的那份（用户裁定「默认就是当前启动
            // 的」；那里它是个合理的起手值，也没有"事实"可违背）。
            //
            // 已有场景按它**真实**的绑定回填：没绑就是「无」，不再替它选上"当前生效的那份"——
            // 那会让编辑器显示成"绑了"、而预览卡照实说"没绑"，两边对不上（用户 2026-10-12
            // 报障「全局提示词明明绑定了还显示未绑定」）；更糟的是用户只改个描述再保存，
            // 就会把这个从未存在过的绑定真的写进档案。
            loadPresetOptions(scene ? null : defaultPromptToActive)
            loadToolTablePresets()
            loadQuickOptions()
            // 四组行选择的数据源（服务器 / 技能 / 人设 / 记忆清单）：打开时与绑定候选一起拉，
            // 拉不到就不开弹窗（与旧档案弹窗同一处理 —— 空清单会让四组变成"什么都选不了"）。
            setBusy(true)
            Promise.all([apiCall('scene-mode-get', {}), apiCall('scene-inventory', {})]).then(function (rs) {
              setBusy(false)
              var inv = rs[1]
              if (!(inv && inv.ok)) { setResult({ ok: false, text: translateError(t, inv) }); setModal(null); return }
              setModal(function (cur) {
                if (!cur || cur.type !== 'scene-editor') return cur
                return Object.assign({}, cur, {
                  inventory: {
                    mcpServers: inv.mcpServers || [], skills: inv.skills || [], subagents: inv.subagents || [], tools: inv.tools || [],
                    presets: inv.presets || [],
                    memories: inv.memories || [],
                  },
                })
              })
            }).catch(function (e) { setBusy(false); setModal(null); setResult({ ok: false, text: errMsg(e) }) })
          }
          function openCreateScene() { openEditor(null) }
          /**
           * 快捷提示词勾选弹窗：改的是**草稿**，点「确定」才写回表单 —— 弹窗语义上就该是可
           * 反悔的，取消/关掉都不动表单里那份。
           */
          function openQuickPick() { setQuickPick({ draft: (sceneForm.quickPrompts || []).slice() }) }
          function toggleQuickPick(id) {
            if (!quickPick) return
            var next = quickPick.draft.slice()
            var at = next.indexOf(id)
            if (at >= 0) next.splice(at, 1)
            else next.push(id)
            setQuickPick({ draft: next })
          }
          function applyQuickPick() {
            if (!quickPick) return
            setSceneForm(Object.assign({}, sceneForm, { quickMode: 'custom', quickPrompts: quickPick.draft.slice() }))
            setQuickPick(null)
          }
          /**
           * 编辑器唯一的保存动作：场景本体（名字 / 描述 / 三个绑定）+ 档案四组一起落盘。
           * 创建：rules-create-scene 成功后，若四组里有任何一段已定义，接着 scene-archive-save
           * 把档案写进新场景 —— 原先「创建时顺手绑好」的语义不变；档案没存上时弹窗**不关**、
           * 转为编辑态（主按钮变「保存到场景」），错误挂在弹窗顶部可重试。
           */
          function submitSceneEditor() {
            if (!modal || modal.type !== 'scene-editor') return
            var isEdit = modal.name != null
            var name = String(sceneForm.name || '').trim()
            if (!isValidSceneSegment(name)) { setSceneForm(Object.assign({}, sceneForm, { error: t('error.rules.invalidGroup') })); return }
            /*
             * 新建撞名：**先问一句再退号**（用户 2026-10-14 第二轮）。
             *
             * 这一处不能像记忆页那样"交给服务端报错再问" —— `rules-create-scene` 是**幂等
             * upsert**（已存在则更新描述/标签，不报错），而且模型工具依赖这条语义（见
             * `scene-records.ts` 的注释）。所以撞名只能由界面自己认出来：场景名就是记录键、
             * 不经过任何归一化，`data.scenes` 里查得到就是真的撞了。
             *
             * 编辑态不做这一步：改的是自己，不存在撞名。
             */
            if (!isEdit) {
              var taken = {}
              ;(data.scenes || []).forEach(function (s) { taken[String(s.name)] = true })
              var finalName = uniqueName(name, taken)
              if (finalName !== name) { setSceneDupAsk({ name: name, finalName: finalName }); return }
            }
            saveScene(name, isEdit)
          }
          /** 真正落盘那一步（名字已定）。`name` 来自 `submitSceneEditor` 或确认弹窗。 */
          function saveScene(name, isEdit) {
            if (!modal || modal.type !== 'scene-editor') return
            var description = String(sceneForm.description || '').trim()
            var prompt = String(sceneForm.prompt || '').trim()
            setBusy(true)
            // 工具表方案绑定（C1）：空串 = 解绑；服务端写进档案，改的是启用中的场景时会立即
            // 应用那份方案（见 scene-sync 的包装）。
            var toolTablePreset = String(sceneForm.toolTablePreset || '')
            // 快捷提示词：null = 解绑（回到"保持现状"），数组 = 勾选集（空数组是"一条都不勾"）。
            // 两个方向都必须**显式送出去**；以 `quickMode` 为准而不是从数组反推（见上方注释）。
            var quickPrompts = sceneForm.quickMode === 'current' ? null
              : (sceneForm.quickMode === 'custom' ? (sceneForm.quickPrompts || []).slice() : [])
            // 编辑态场景名只读（§6.2）：nextName 与 name 相同 = 不改名，服务端按原名定位。
            var payload = isEdit
              ? { name: modal.name, nextName: name, description: description, prompt: prompt, toolTablePreset: toolTablePreset, quickPrompts: quickPrompts }
              : { name: name, description: description, prompt: prompt, toolTablePreset: toolTablePreset, quickPrompts: quickPrompts }
            var archivePayload = {}
            if (modal.sections.mcp) archivePayload.mcp = modal.sections.mcp
            if (modal.sections.mcpNotes) archivePayload.mcpNotes = modal.sections.mcpNotes
            if (modal.sections.skills) archivePayload.skills = modal.sections.skills
            if (modal.sections.subagents) archivePayload.subagents = modal.sections.subagents
            var hasArchive = Object.keys(archivePayload).length > 0
            apiCall(isEdit ? 'rules-update-scene' : 'rules-create-scene', payload).then(function (res) {
              if (!(res && res.ok)) { setBusy(false); setSceneForm(Object.assign({}, sceneForm, { error: translateError(t, res) })); return }
              // P5：档案里不再写 memories 段（开关是 rules[*].enabled 单一真相源，勾选即提交）。
              // 编辑态沿用旧档案弹窗的口径：保存 = 整份档案落盘（四段全删 = 存空档案）；
              // 创建态只在真的配了组时才写档案，不给新场景凭空落一份空档案。
              if (isEdit) hasArchive = true
              // 场景已落盘 → 才能补建创建态里攒下的记忆（`rules-create` 要求场景已存在）。
              if (!hasArchive) { flushPendingMemories(name, isEdit, res, null); return }
              apiCall('scene-archive-save', { scene: name, archive: archivePayload }).then(function (ares) {
                if (ares && ares.ok) flushPendingMemories(name, isEdit, res, ares)
                else {
                  // 场景已建/已改、档案没存上：留在编辑器里如实报错，主按钮变「保存到场景」可重试。
                  setBusy(false)
                  setModal(Object.assign({}, modal, { name: name, error: translateError(t, ares) }))
                }
              }).catch(function (e) {
                setBusy(false)
                setModal(Object.assign({}, modal, { name: name, error: errMsg(e) }))
              })
            }).catch(function (e) { setBusy(false); setSceneForm(Object.assign({}, sceneForm, { error: errMsg(e) })) })
          }
          function finishSceneEditor(name, isEdit, sceneRes, archiveRes, memRes) {
            setBusy(false)
            setModal(null)
            // 新建时若把历史默认（全部启用）收敛成单选，如实说一句，别让用户以为场景"自己开了"。
            var ok = true
            var text = sceneRes.collapsedActive && !isEdit
              ? t('scenes.result.created.collapsed', { name: name })
              // 回执动词表（REDESIGN §12.4）：两个方向各取字面量键，不合成三元选词。
              : (isEdit ? t('done.saved', { name: name }) : t('done.created', { name: name }))
            if (archiveRes) {
              if (archiveRes.stale && archiveRes.stale.length) text += ' · ' + t('memory.archive.stale', { items: archiveRes.stale.join('、') })
              if (archiveRes.applyError) { ok = false; text += ' · ' + t('memory.archive.applyFailed', { reason: archiveRes.applyError }) }
            }
            // 攒下的记忆草稿的落盘结果（flushPendingMemories）。三个数分开报：「建了几条」
            // 与两种失败（压根没建上 / 建好了但没配全）—— 后者记忆是存在的，混进前者就是谎报。
            if (memRes) {
              if (memRes.created) text += ' · ' + t('scenes.mem.created', { count: memRes.created })
              if (memRes.incomplete.length) { ok = false; text += ' · ' + t('scenes.mem.incomplete', { count: memRes.incomplete.length, items: memRes.incomplete.join('；') }) }
              if (memRes.failed.length) { ok = false; text += ' · ' + t('scenes.mem.createFailed', { count: memRes.failed.length, items: memRes.failed.join('；') }) }
            }
            setResult({ ok: ok, text: text })
            refresh(true)
            syncScopeBar()
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
                    : t('done.deleted', { name: name }),
                })
                refresh(true)
                syncScopeBar()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          // ── 档案四组（MCP / 技能 / 子智能体 / 记忆）已并入场景编辑器（openEditor）──
          /**
           * 快捷提示词候选（只读 op，没填令牌也拿得到）。读不到就当没有：下拉仍给
           * 「当前启用的（保持现状）」这一项，只是切到「按场景勾选」时列表是空的。
           */
          function loadQuickOptions() {
            apiCall('quickprompt-list', {}).then(function (res) {
              setQuickOptions((res && res.ok && Array.isArray(res.prompts)) ? res.prompts : [])
            }).catch(function () { setQuickOptions([]) })
          }
          /**
           * 工具表方案下拉的数据源（C1）：只读调用（不带 `set:true`），
           * 所以没填令牌也能拿。读不到就当没有（下拉只剩「不绑定」+「出厂默认」）。
           */
          function loadToolTablePresets() {
            apiCall('tool-table', {}).then(function (tt) {
              setTtInfo({
                presets: (tt && tt.ok && Array.isArray(tt.presets)) ? tt.presets : [],
                factoryHiddenCount: (tt && tt.ok && Array.isArray(tt.defaultHidden)) ? tt.defaultHidden.length : 0,
              })
            }).catch(function () { setTtInfo({ presets: [], factoryHiddenCount: 0 }) })
          }
          /**
           * 工具表方案下拉的选项（C1）：不绑定（默认）→ 出厂默认 → 用户存过的方案。
           * 档案里绑的名字若已不在方案清单里（被删了 / 档案是从别的机器带来的），仍把它列出来
           * 并标「方案已不存在」—— 静默把用户存的值改成「不绑定」是替他做决定。
           */
          function toolTablePresetOptions() {
            var info = ttInfo || { presets: [], factoryHiddenCount: 0 }
            var current = String((sceneForm && sceneForm.toolTablePreset) || '')
            var opts = [{ value: '', label: t('scenes.field.toolTable.none') }, { value: 'factory-default', label: t('scenes.field.toolTable.factory', { count: info.factoryHiddenCount || 0 }) }]
            ;(info.presets || []).forEach(function (p) {
              opts.push({ value: p.name, label: p.name + ' · ' + t('scenes.field.toolTable.count', { count: (p.hidden || []).length }) })
            })
            if (current && current !== 'factory-default' && !opts.some(function (o) { return o.value === current })) {
              opts.push({ value: current, label: current + ' · ' + t('scenes.field.toolTable.missing') })
            }
            return opts
          }
          function modalSections() { return modal && modal.type === 'scene-editor' ? modal.sections : null }
          function setSections(sections) { if (modal && modal.type === 'scene-editor') setModal(Object.assign({}, modal, { sections: sections })) }
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
           * 所以「添加 MCP 工具集」当下就等价于「该场景下全部 MCP 停用」。段脚注原先把这句话
           * 印在每一段底下，2026-09-30 用户裁定撤掉（四段同屏时同一件事说了四遍）。
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

          // ── 段 4：记忆（P5：单一真相源 = `rules[*].enabled`）────────────────────
          // 这个段**没有自己的「段定义」概念**：勾选状态**就是**记忆自身的 `enabled`，
          // 与记忆页同一个写入口（`rules-toggle`）。于是「记忆页开了 → 档案页显示开启」
          // 天然成立，不存在两套状态、也不需要双向同步代码。
          //
          // 已存在记忆的勾选**立即提交**（不等「保存到场景」）：它是全局状态，不属于场景档案。
          // 本次新配的记忆是**草稿**，走另一条路 —— 存在 `modal.pendingMems` 里，点「创建 /
          // 保存到场景」时才落盘（见 flushPendingMemories），所以两种时机的行为没有分叉。
          //
          // **只列被编辑场景自己的记忆**：保留场景 `global` 恒定注入（任何对话都生效），
          // 不需要在这里配置，列出来只会让人以为「不勾就不注入」。
          function sceneMemories(sceneName) {
            // inventory 未就位（弹窗刚开、清单在途）时按空清单算，组头动作点下去不会抛错。
            return sceneMemoriesOf((modal.inventory && modal.inventory.memories) || [], sceneName)
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
          /**
           * 编辑器四组共用的组块（REDESIGN §6.2）：组头（标题 + 计数 + 动作）+ 筛选行 + 滚动体。
           * 容器用 --dsw-alias-bg-layer-1 底色 + 1px border-l2 圆角块分层
           * （.dsm-editor-group，描边是 2026-10-12 补的：浅色主题下 layer-1 与弹窗的
           * layer-2 同为白，单靠底色层次四组会融成一片、失去分块）。
           *
           * `hideFilter` = 未建段时不画那一行筛选框：段里一条都没有，筛选框筛不出任何东西，
           * 但它照旧占 30px + 4px 间距 —— 四组 2×2 就是 136px，正好是清单体从 144 涨到 176
           * 抠不出来的那部分（2026-10-12 重排）。
           */
          function editorGroupNode(opts) {
            return React.createElement('div', { className: 'dsm-editor-group' },
              React.createElement('div', { className: 'dsm-editor-group-head' },
                React.createElement('span', { className: 'dsm-editor-group-title' }, opts.title),
                React.createElement('span', { className: 'dsm-editor-group-count' }, opts.count),
                React.createElement('div', { className: 'dsm-editor-group-actions' }, opts.actions || null)),
              React.createElement('div', { className: 'dsm-editor-group-body' },
                opts.hideFilter ? null : segFilter(opts.query, opts.onQuery, opts.queryPlaceholder),
                opts.body))
          }
          /**
           * 组 4：记忆集。两段内容拼在一张清单里：
           *   · 已存在的记忆 —— 勾选**立即提交**（P5：单一真相源 = `rules[*].enabled`，不随「保存」落盘）；
           *   · 本次新配的草稿 —— 只存在于编辑器里，随「创建 / 保存到场景」一起落盘（`pendingMems`）。
           */
          /**
           * 附件标记（回形针 + 个数）。两种来源同一副长相：已落盘的真记忆读宿主在
           * `rules-list` 里补的 `attach` 摘要，本次新配的草稿读弹窗攒下的 `files` ——
           * 不标出来，「勾这条会把参考资料一起带进场景」这件事在行上完全看不出来。
           */
          function attachMark(count, bytes) {
            if (!count) return null
            return React.createElement('span', {
              className: 'dsm-tag dsm-tag-attach',
              title: t('scenes.mem.attach.tip', { count: count, size: fmtBytes(bytes || 0) }),
            }, React.createElement(PaperclipIcon, { size: 11 }), String(count))
          }
          function memoriesGroup() {
            var inv = modal.inventory || { memories: [] }
            var own = sceneMemoriesOf(inv.memories, modal.name || '')
            var q = String(modal.memQuery || '').trim().toLowerCase()
            var items = checkedFirst('memories', q ? own.filter(function (m) {
              return String(m.name).toLowerCase().indexOf(q) >= 0
                || String(m.description || '').toLowerCase().indexOf(q) >= 0
            }) : own, function (m) { return String(m.id) }, function (m) { return memoryEnabled(String(m.id)) })
            var enabledCount = own.filter(function (m) { return memoryEnabled(String(m.id)) }).length
            // 草稿**另算一栏**（`· N 条待创建`），不并进 `x/y 已勾选`：那一栏是「全选 / 全不选」
            // 的作用面（它只认已存在的记忆），并进去就会出现"写着 5/5、全选却只勾了 3 条"。
            // 两栏各说各的：前者 = 这个场景现在有几条、开着几条；后者 = 我这次还配了几条。
            var pending = modal.pendingMems || []
            // 本次编辑里攒下的记忆草稿（还没落盘，两种时机都有）。它们：
            //   · 勾选框照常可用 —— 勾 = 落盘时直接开启，与下面那些真记忆同一语义（新草稿默认勾上）；
            //   · 「编辑」回填草稿，「移除」撤掉草稿；
            //   · 行首标「待创建」，免得跟真的记忆混成一片（标签的 title 补两句非显然的话：
            //     落点取点「创建」那一刻的场景名、勾选的含义）。
            // 草稿行**不受筛选框影响**：它是"我这次配了什么"的台账，被搜索词筛掉只会让人以为它没了。
            var rows = pending.map(function (m, i) {
              return RowSelect({
                disabled: busy,
                key: 'pending:' + i,
                checked: m.enabled === true,
                name: m.name,
                desc: m.description ? clipText(m.description, MEM_DESC_MAX) : null,
                descTitle: m.description || null,
                meta: React.createElement(React.Fragment, null,
                  React.createElement('span', { className: 'dsm-tag', title: t('scenes.mem.pendingTagTitle') }, t('scenes.mem.pendingTag')),
                  attachMark((m.files || []).length, (m.files || []).reduce(function (sum, f) { return sum + Number(f.size || 0) }, 0))),
                actions: [
                  // 编辑与移除都收进 ⋯（用户 2026-10-16 第三轮）：这一列的行本来就是"勾或不勾"，
                  // 两颗按钮把名称与描述挤没；移除在菜单里是红字。
                  // 「移除」撤的只是本次编辑里攒下的草稿，不写盘。
                  React.createElement(RowMenu, {
                    key: 'menu',
                    label: t('row.menu', { name: m.name }),
                    items: [
                      { key: 'edit', label: t('memory.edit'), disabled: busy, onClick: function () { openMemoryEdit(i) } },
                      { key: 'rm', label: t('scenes.mem.removePending'), danger: true, disabled: busy, onClick: function () { dropPendingMemory(i) } },
                    ],
                  }),
                ],
                onChange: function () { togglePendingMemory(i) },
              })
            }).concat(items.map(function (m) {
              return RowSelect({
                disabled: busy,
                key: m.id,
                checked: memoryEnabled(String(m.id)),
                name: m.name,
                // 记忆描述是自由正文的首行，可能很长：截断到 MEM_DESC_MAX，全文放 title。
                desc: m.description ? clipText(m.description, MEM_DESC_MAX) : null,
                descTitle: m.description || null,
                // 带附件的 bundle 记忆标一枚回形针 + 个数（见 attachMark）。
                meta: attachMark(m.attach && m.attach.count, m.attach && m.attach.bytes),
                onChange: function () { toggleMemory(String(m.id)) },
              })
            }))
            return editorGroupNode({
              title: t('memory.archive.memories'),
              count: t('scenes.seg.checked', { checked: enabledCount, total: own.length })
                + (pending.length ? ' · ' + t('scenes.mem.pending', { count: pending.length }) : ''),
              // 「创建」排在最前（用户 2026-10-14：在全选左边），点开的是记忆页那个「新建记忆」
              // 弹窗（少了场景选择器，见 memoryCreateNode）。其余三个组没有这颗 —— 它们的条目
              // 来自磁盘扫描（服务器 / 技能 / 人设），不在这里现造。
              actions: [memoryCreateButton()].concat(segActions({
                defined: true, busy: busy,
                selectAllLabel: t('bulk.selectAll'), clearLabel: t('bulk.unselectAll'),
                onAll: function () { setAllMemories(true) },
                onClear: function () { setAllMemories(false) },
                allChecked: own.length > 0 && enabledCount === own.length,
              })),
              query: modal.memQuery,
              onQuery: function (v) { setModal(Object.assign({}, modal, { memQuery: v })) },
              queryPlaceholder: t('scenes.mem.search'),
              body: rows.length
                ? React.createElement('div', null, rows)
                : React.createElement('div', { className: 'dsm-pick-empty' }, q ? t('scenes.mem.noMatch') : t('scenes.mem.emptyScene')),
            })
          }
          /*
           * 记忆集组头的「创建」（用户 2026-10-14）：套用记忆页那个「新建记忆」弹窗，**只少了
           * 场景选择器** —— 场景由编辑器上下文定死，以只读一行显示。
           *
           * 与其余三组同一条模型：**弹窗里建出来的都只是草稿**，存在 `modal.pendingMems` 里，
           * 点「创建 / 保存到场景」那一刻才真正落盘（`flushPendingMemories`）。创建态如此，
           * 编辑态也一样（用户 2026-10-14：「已经存在的场景，本次创建记忆应该也能编辑、移除，
           * 也是未创建的记录」）—— 于是两种时机只有**落点**不同，行为不再分叉：草稿行一律
           * 可勾选、可编辑、可移除。
           *
           * 落盘仍走记忆页那两个宿主 op（`rules-create` + `rules-attach`）。一处刻意的偏离：
           * 服务端新建记忆默认 `enabled: false`（`ops/memory.ts` 的 P5 口径，记忆页照此），
           * 而这里的草稿**默认勾选**（用户 2026-10-14 裁定）—— 在这个场景里新建记忆本就是为了
           * 让它生效，落盘时按勾选补一次 `rules-toggle`；记忆页那条路径不受影响。
           *
           * 落点：编辑态 = 场景名；创建态 = 左边**正在填**的场景名（没填或非法就没有落点，
           * 入口置灰）。草稿**不记场景名** —— 落点统一取点「创建」那一刻的名字，所以中途改名
           * 不会把早先那条留在旧名字下，也不会各落一半。场景名此刻还只是表单里的一个字串，
           * 把它抄进草稿只会抄出一个马上过期的副本；代价是草稿行上不能写场景名（写了改名后
           * 就是假话），这件事由「待创建」标签的 title 说清。
           */
          /** 这次新建的记忆落到哪个场景：编辑态是场景名，创建态是表单里正在填的那个名字。 */
          function memoryCreateTarget() {
            if (!modal || modal.type !== 'scene-editor') return ''
            return modal.name != null ? String(modal.name) : String(sceneForm.name || '').trim()
          }
          function memoryCreateReady() {
            if (!modal || modal.type !== 'scene-editor') return false
            if (modal.name != null) return true
            return isValidSceneSegment(String(sceneForm.name || '').trim())
          }
          function openMemoryCreate() {
            if (!memoryCreateReady()) return
            // 30 秒内重开：把刚才误关掉的那份填回来（与记忆页 / 技能页同一套，见
            // 42-shared-ui.js 的 stashFormDraft）。只认"新建"那一槽。
            var draft = takeFormDraft(memNewDraftKey(false))
            // `editing` = 这一窗改的是第几条草稿；null = 新建一条。
            setMemNew(draft
              ? Object.assign({}, draft, { editing: null, error: null })
              : { editing: null, name: '', description: '', body: '', form: 'flat', files: [], error: null })
          }
          /** 改一条待创建的记忆：草稿回填进弹窗，保存时**替换**原来那条，而不是又添一条。 */
          function openMemoryEdit(index) {
            if (!modal || modal.type !== 'scene-editor') return
            var m = (modal.pendingMems || [])[index]
            if (!m) return
            // 同一份草稿被误关掉：30 秒内重开填回改了一半的内容。索引会随「删掉别的草稿」
            // 漂移，所以连**目标名**一起核对 —— 只认索引与名字都对得上的那一份，否则宁可
            // 从 `pendingMems` 重读，也不能把 A 改了一半的内容塞进 B 的弹窗里。
            var draft = takeFormDraft(memNewDraftKey(true))
            var restore = draft && draft.editing === index && draft.linkedName === m.name ? draft : null
            setMemNew(restore
              ? Object.assign({}, restore, { editing: index, error: null })
              : {
                editing: index, name: m.name, description: m.description || '', body: m.body || '',
                form: m.form || 'flat', files: (m.files || []).slice(), error: null,
              })
          }
          /** 撤掉一条还没落盘的记忆草稿。 */
          function dropPendingMemory(index) {
            if (!modal || modal.type !== 'scene-editor') return
            var next = (modal.pendingMems || []).slice()
            next.splice(index, 1)
            setModal(Object.assign({}, modal, { pendingMems: next }))
          }
          /**
           * 勾 / 取消勾一条待创建的记忆。语义与记忆页、本组其余行**完全一致**（勾 = 启用），
           * 只是生效时刻晚一步：服务端新建记忆默认不开启（`ops/memory.ts`），所以落盘时
           * create 之后要显式补一次 `rules-toggle`（见 flushPendingMemories）。
           */
          function togglePendingMemory(index) {
            if (!modal || modal.type !== 'scene-editor') return
            var next = (modal.pendingMems || []).slice()
            if (!next[index]) return
            next[index] = Object.assign({}, next[index], { enabled: next[index].enabled !== true })
            setModal(Object.assign({}, modal, { pendingMems: next }))
          }
          function pickMemAttach() { if (memAttachRef.current) memAttachRef.current.click() }
          function onMemAttachPicked(ev) {
            var picked = Array.prototype.slice.call((ev.target && ev.target.files) || [])
            if (ev.target) ev.target.value = '' // 允许连续选中同一个文件
            if (!picked.length) return
            Promise.all(picked.map(function (f) {
              return f.arrayBuffer().then(function (buf) {
                return { name: String(f.name || ''), size: buf.byteLength, data: bytesToBase64(buf) }
              })
            })).then(function (entries) {
              var tooBig = entries.filter(function (e) { return e.size > MEM_ATTACH_MAX_BYTES })
              var keep = entries.filter(function (e) { return e.size <= MEM_ATTACH_MAX_BYTES })
              setMemNew(function (prev) {
                if (!prev) return prev
                var next = Object.assign({}, prev, { files: (prev.files || []).concat(keep) })
                // 超限的当场拦下（服务端还会再拦一次），其余照常加入。
                if (tooBig.length) next.error = t('memory.attach.tooLarge', { name: tooBig[0].name, limit: MEM_ATTACH_MAX_MB })
                return next
              })
            }).catch(function (e) { setMemNew(function (prev) { return prev ? Object.assign({}, prev, { error: errMsg(e) }) : prev }) })
          }
          function dropMemPending(index) {
            setMemNew(function (prev) {
              if (!prev) return prev
              var next = (prev.files || []).slice()
              next.splice(index, 1)
              return Object.assign({}, prev, { files: next })
            })
          }
          /**
           * 名称去重：`测` 已被占用就退成 `测（1）`，再撞就 `测（2）`……
           *
           * 判据是**会落盘的那一套名字** = 本场景已有的记忆 + 本次已攒下的其它草稿。
           * 服务端 `rules-create` 撞名是直接拒绝的（`error.rules.exists`），所以这一步的作用是
           * 让「配两条同名」能正常落盘，而不是报个错让用户自己回去改名（用户 2026-10-14 要求）。
           *
           * `skipIndex` 跳过正在编辑的那条草稿：不跳的话改一次名就会把自己也算成占用者，
           * 于是每保存一次名字就往后挪一位。
           *
           * 退号本身走共享的 `uniqueName`（42-shared-ui.js，八个入口同一套）；这里只负责
           * 把"占用者"凑出来 —— 各域的判据不同，凑法也就留在各域。
           */
          function uniqueMemoryName(raw, skipIndex) {
            var taken = {}
            sceneMemories(modal.name).forEach(function (m) { taken[String(m.name)] = true })
            ;(modal.pendingMems || []).forEach(function (m, i) { if (i !== skipIndex) taken[String(m.name)] = true })
            return uniqueName(raw, taken)
          }
          /**
           * 弹窗的提交动作：**先问一句再退号**（用户 2026-10-14 第二轮）。
           *
           * 原来这里静默退号 —— 输入框里写着「测」，草稿行上却是「测（1）」。现在撞名先弹一个
           * 小窗说明，确认后才按 `测（1）` 攒草稿。落盘仍然是点「创建 / 保存到场景」那一刻
           * （见 flushPendingMemories）：这里一个请求都不发。
           */
          function submitMemoryCreate() {
            if (!memNew || !modal || modal.type !== 'scene-editor') return
            var typed = String(memNew.name || '').trim()
            var finalName = uniqueMemoryName(typed, memNew.editing != null ? memNew.editing : null)
            if (finalName !== typed) { setMemDupAsk({ name: typed, finalName: finalName }); return }
            stageMemoryDraft(typed)
          }
          /**
           * 把草稿写回 `modal.pendingMems`（新增一条，或**替换**被编辑的那条）。`name` 已定。
           *
           * 写的是草稿的**拷贝**：弹窗一关 `memNew` 就归 null，不能再引用它。
           */
          function stageMemoryDraft(name) {
            if (!memNew || !modal || modal.type !== 'scene-editor') return
            var list = (modal.pendingMems || []).slice()
            var editing = memNew.editing != null && list[memNew.editing] ? memNew.editing : null
            var draft = {
              name: name,
              description: String(memNew.description || '').trim(),
              body: memNew.body || '',
              form: memNew.form || 'flat',
              files: (memNew.files || []).slice(),
              // 新草稿默认勾选（用户 2026-10-14 裁定：这个场景里新建的记忆就是要它生效）；
              // 勾选本身住在**行上**（编辑弹窗里没有这一栏，与记忆页的新建弹窗一致），
              // 所以改草稿时原样保留它，别让一次改名顺手抹掉「建好后开启」的意图。
              enabled: editing != null ? list[editing].enabled === true : true,
            }
            if (editing != null) list[editing] = draft
            else list.push(draft)
            setModal(Object.assign({}, modal, { pendingMems: list }))
            setMemNew(null)
          }
          /** 组头那颗「创建」：创建态且场景名还没填/非法时置灰，title 说清差什么。 */
          function memoryCreateButton() {
            var ready = memoryCreateReady()
            return React.createElement('button', {
              key: 'memnew', type: 'button', className: 'dsm-btn dsm-btn-quiet',
              disabled: busy || !ready,
              title: ready ? '' : t('scenes.mem.createNeedScene'),
              onClick: openMemoryCreate,
            }, t('memory.btn.create'))
          }
          /**
           * 把攒下的记忆草稿真正落盘 —— 排在场景本体（与档案）之后，因为 `rules-create` 要求
           * 目标场景**已存在**。两种时机共用这一条：创建态是"场景刚建出来"，编辑态是"场景已改完"。
           * 某一条失败不回滚场景、也不影响同批其余条目，逐条如实报出名字与原因。
           */
          function flushPendingMemories(name, isEdit, sceneRes, archiveRes) {
            var pending = (modal && modal.pendingMems) || []
            if (!pending.length) { finishSceneEditor(name, isEdit, sceneRes, archiveRes, null); return }
            setBusy(true)
            var created = 0
            // 两个失败桶分开：`failed` = 这条记忆压根没建出来；`incomplete` = 建出来了，但
            // 后续两步（开启 / 传附件）有一处没做成。混成一个桶就会谎报 —— 后者文件是存在的。
            var failed = []
            var incomplete = []
            var chain = Promise.resolve()
            pending.forEach(function (m) {
              chain = chain.then(function () {
                return apiCall('rules-create', { group: name, name: m.name, description: m.description, body: m.body, form: m.form }).then(function (res) {
                  if (!res || !res.ok) { failed.push(m.name + '（' + translateError(t, res) + '）'); return null }
                  created += 1
                  var id = (res.rule && res.rule.id) || (name + '/' + m.name)
                  var post = []
                  // 勾选 = 建好后直接开启（服务端新建记忆默认不开启）。
                  if (m.enabled === true) post.push(apiCall('rules-toggle', { id: id, enabled: true }).then(function (tg) {
                    if (!tg || !tg.ok) incomplete.push(m.name + '（' + translateError(t, tg) + '）')
                  }, function (e) { incomplete.push(m.name + '（' + errMsg(e) + '）') }))
                  if ((m.files || []).length) post.push(apiCall('rules-attach', { id: id, files: m.files.map(function (f) { return { path: f.name, data: f.data } }) }).then(function (att) {
                    if (att && att.ok === false) incomplete.push(m.name + '（' + translateError(t, att) + '）')
                  }, function (e) { incomplete.push(m.name + '（' + errMsg(e) + '）') }))
                  // 两个 onRejected 都就地收下错误：漏出去会被外层 catch 记成"没建出来"，
                  // 而那时记忆其实已经在磁盘上了。
                  return post.length ? Promise.all(post) : null
                }).catch(function (e) { failed.push(m.name + '（' + errMsg(e) + '）') })
              })
            })
            chain.then(function () {
              setBusy(false)
              finishSceneEditor(name, isEdit, sceneRes, archiveRes, { created: created, failed: failed, incomplete: incomplete })
            })
          }
          /**
           * 「新建记忆」弹窗本体。字段与记忆页逐项一致（名称 / 描述 / 正文 / 形态 + bundle 附件），
           * 场景一栏改成只读展示 —— 这正是「套用记忆页的新建，但不需要选择场景」。
           */
          function memoryCreateNode() {
            if (!memNew || !modal || modal.type !== 'scene-editor') return null
            var nameInvalid = String(memNew.name || '').trim() !== '' && !isValidSceneSegment(String(memNew.name || '').trim())
            var descLen = String(memNew.description || '').length
            var target = memoryCreateTarget()
            // 撞名改由提交时的确认窗处理（`DupNameDialog`）：输入框下面那行"保存会记为「X」"
            // 是它的**预告版**，用户 2026-10-14 裁定啰嗦，删掉 —— 真撞上了才弹窗问一句。
            // 改草稿时标题与主按钮换成「编辑 / 保存」那一套（与记忆页同词条）——否则同一个弹窗
            // 在"新建"和"改一条已存在的东西"两种语义下长得一模一样，用户分不清点下去会加一条还是改一条。
            var editing = memNew.editing != null
            // 关掉 ≠ 丢掉（与记忆页的 closeEditor 同一条口径）：只有误关这条路进暂存 ——
            // 提交成功走 stageMemoryDraft，它不经过 onClose，所以不会存下一份已经用掉的草稿。
            // 编辑态额外记 `linkedName`：`editing` 是数组下标，期间删掉别的草稿就会漂移，
            // 取回时两个都对得上才认（见 openMemoryEdit）。
            var closeMemoryCreate = function () {
              var pending = (modal.pendingMems || [])[memNew.editing]
              stashFormDraft(memNewDraftKey(editing), {
                editing: editing ? memNew.editing : null,
                linkedName: editing && pending ? pending.name : null,
                name: memNew.name || '', description: memNew.description || '', body: memNew.body || '',
                form: memNew.form || 'flat', files: (memNew.files || []).slice(),
              })
              setMemNew(null)
            }
            return React.createElement(Modal, { key: 'memnew', className: 'dsm-modal-compact', title: editing ? t('memory.edit.title') : t('memory.create.title'), closeLabel: t('btn.close'), onClose: closeMemoryCreate },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.group')),
                  // 只读一行：场景由上下文决定，不给选择器，也不加说明（用户 2026-10-14 裁定
                  // 撤掉那句「记忆归属于当前编辑的场景」—— 灰掉的框里写着场景名，本身就是答案）。
                  React.createElement('input', { className: 'dsm-control', value: sceneLabel(data.scenes, target), disabled: true, onChange: function () {} })),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.name')),
                  React.createElement('input', { className: 'dsm-control' + (nameInvalid ? ' dsm-rule-invalid' : ''), value: memNew.name || '', placeholder: t('memory.field.name.placeholder'), onChange: function (e) { setMemNew(Object.assign({}, memNew, { name: e.target.value })) } }),
                  nameInvalid ? React.createElement('p', { className: 'dsm-rule-hint' }, t('memory.name.invalid')) : null),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('div', { className: 'dsm-budget-meta' },
                    React.createElement('span', { className: 'dsm-label' }, t('memory.field.description')),
                    React.createElement('span', { className: 'dsm-char-count' + (descLen > 500 ? ' dsm-char-over' : '') }, descLen + ' / 500')),
                  React.createElement('input', { className: 'dsm-control', value: memNew.description || '', placeholder: t('memory.field.description.placeholder'), onChange: function (e) { setMemNew(Object.assign({}, memNew, { description: e.target.value })) } })),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.body')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: memNew.body || '', placeholder: t('memory.field.body.placeholder'), onChange: function (e) { setMemNew(Object.assign({}, memNew, { body: e.target.value })) } })),
                React.createElement('div', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('memory.field.form')),
                  // flat / bundle 就两个值：分段按钮摊开、点击即切（与记忆页同一控件）。
                  React.createElement('div', { className: 'dsm-form-seg', role: 'group' },
                    RULE_FORM_OPTIONS.map(function (o) {
                      return React.createElement('button', { key: o.value, type: 'button', 'aria-pressed': (memNew.form || 'flat') === o.value, onClick: function () { setMemNew(Object.assign({}, memNew, { form: o.value })) } }, o.label);
                    })),
                  memNew.form === 'bundle'
                    ? React.createElement('div', { className: 'dsm-field' },
                      React.createElement('div', { className: 'dsm-budget-meta' },
                        React.createElement('span', { className: 'dsm-label' }, t('memory.field.attach')),
                        React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: pickMemAttach }, t('memory.attach.add'))),
                      React.createElement('input', { ref: memAttachRef, type: 'file', multiple: true, className: 'dsm-hidden-input', onChange: onMemAttachPicked }),
                      (memNew.files || []).length
                        ? React.createElement('div', { className: 'dsm-attach-list' }, (memNew.files || []).map(function (f, i) {
                            return React.createElement('div', { key: 'p:' + i + ':' + f.name, className: 'dsm-file', title: f.name },
                              React.createElement('span', { className: 'dsm-file-kind', 'aria-hidden': 'true' }, 'NEW'),
                              React.createElement('span', { className: 'dsm-file-name' }, f.name),
                              React.createElement('span', { className: 'dsm-file-meta' }, fmtBytes(f.size) + ' · ' + t('memory.attach.pending')),
                              React.createElement('button', { type: 'button', className: 'dsm-file-remove', disabled: busy, 'aria-label': t('memory.attach.remove') + ' ' + f.name, onClick: function () { dropMemPending(i) } }, '×'))
                          }))
                        : null)
                    : null),
                memNew.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(memNew.error)) : null),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || nameInvalid || descLen > 500 || !String(memNew.name || '').trim() || !String(memNew.body || '').trim(), onClick: submitMemoryCreate }, editing ? t('memory.btn.save') : t('memory.btn.create'))))
          }
          /** 组 1：MCP 工具集（服务器级行选择 → 行内「编辑」打开次级弹窗：备注 + 工具行选择）。 */
          function mcpGroup() {
            var sections = modalSections()
            var defined = !!sections.mcp
            var servers = (modal.inventory && modal.inventory.mcpServers) || []
            return editorGroupNode({
              title: t('memory.archive.tools'),
              count: defined ? t('scenes.seg.checked', { checked: Object.keys(sections.mcp).length, total: servers.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addTools'),
                function () { setSections(Object.assign({}, modalSections(), { mcp: emptyMcpPreset() })) },
                function () { var s = Object.assign({}, modalSections()); delete s.mcp; setSections(s) },
                mcpSelectAll,
                function () { setSections(Object.assign({}, modalSections(), { mcp: {} })) },
                // 「全选」按钮的全选态：档案里勾了全部服务器（含没在过滤结果里的）。
                defined && servers.length > 0 && servers.every(function (x) { return sections.mcp[x.name] !== undefined })),
              query: modal.mcpQuery,
              onQuery: function (v) { setModal(Object.assign({}, modal, { mcpQuery: v })) },
              queryPlaceholder: t('scenes.filter.servers'),
              hideFilter: !defined,
              // 未建段：空态只留一行（全文进悬浮，REDESIGN §7）—— 长段在 2×2 的格子里
              // 一摆出来就把清单区整个顶掉（用户 2026-10-12「四个集挤在一起」）。
              body: !defined
                ? React.createElement('div', { className: 'dsm-pick-empty', title: t('scenes.mcp.hint') }, t('scenes.mcp.hint.short'))
                : (function () {
                    var q = String(modal.mcpQuery || '').trim().toLowerCase()
                    var shown = checkedFirst('mcp', q ? servers.filter(function (s) { return String(s.name).toLowerCase().indexOf(q) >= 0 }) : servers,
                      function (s) { return String(s.name) }, function (s) { return sections.mcp[s.name] !== undefined })
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
                      return RowSelect({
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
                        actions: selected ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { openDrill(server.name) } }, t('scenes.mcp.edit')) : null,
                        onChange: function () { toggleMcpServer(server.name) },
                      })
                    }))
                  })(),
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
                              return RowSelect({
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
          /** 组 2：技能集（可勾选集 = 未被覆盖且结构完整的技能，与旧档案弹窗同一口径）。 */
          function skillsGroup() {
            var sections = modalSections()
            var defined = !!sections.skills
            var allItems = (modal.inventory && modal.inventory.skills) || []
            /**
             * 可勾选集：**被同名技能覆盖的副本**与**结构不完整的技能**都不算。
             * 它们勾了也不生效（运行时那一步本来就跳过），后端保存时还会按同一口径当失效项丢掉
             * —— 留着只会造成「档案说开着、技能页说没启动」（用户实测：启动一个目录后档案里
             * 多出被覆盖的那个技能）。计数、「全选」、行内开关全部按这一份来。
             */
            var pickable = function (x) { return !x.shadowed && x.loadable !== false }
            var pickableItems = allItems.filter(pickable)
            var items = checkedFirst('skills', (function () {
              var q = String(modal.skillQuery || '').trim().toLowerCase()
              if (!q) return allItems
              // 搜索同时匹配技能名与来源名（用户按"来源"找技能是常见动作）。
              return allItems.filter(function (x) {
                var d = skillDisplay(x)
                return (d.name + ' ' + d.source + ' ' + d.key).toLowerCase().indexOf(q) >= 0
              })
            })(), function (x) { return String(x.key) },
              function (x) { return !!sections.skills && sections.skills.indexOf(x.key) >= 0 })
            var pickedCount = pickableItems.filter(function (x) { return sections.skills && sections.skills.indexOf(x.key) >= 0 }).length
            return editorGroupNode({
              title: t('memory.archive.skills'),
              count: defined ? t('scenes.seg.checked', { checked: pickedCount, total: pickableItems.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addSkills'),
                function () { setSections(Object.assign({}, modalSections(), { skills: [] })) },
                function () { var s = Object.assign({}, modalSections()); delete s.skills; setSections(s) },
                function () { setSections(Object.assign({}, modalSections(), { skills: pickableItems.map(function (x) { return x.key }) })) },
                function () { setSections(Object.assign({}, modalSections(), { skills: [] })) },
                defined && pickableItems.length > 0 && pickableItems.every(function (x) { return sections.skills.indexOf(x.key) >= 0 })),
              query: modal.skillQuery,
              onQuery: function (v) { setModal(Object.assign({}, modal, { skillQuery: v })) },
              queryPlaceholder: t('scenes.filter.skills'),
              hideFilter: !defined,
              body: !defined
                ? React.createElement('div', { className: 'dsm-pick-empty', title: t('scenes.skills.hint') }, t('scenes.skills.hint.short'))
                : items.length
                  ? React.createElement('div', null, items.map(function (item) {
                      var d = skillDisplay(item)
                      var offered = pickable(item)
                      return RowSelect({
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
                  : React.createElement('div', { className: 'dsm-pick-empty' }, modal.skillQuery ? t('scenes.mem.noMatch') : t('scenes.skills.empty')),
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
          function subagentsGroup() {
            var sections = modalSections()
            var defined = !!sections.subagents
            var allItems = (modal.inventory && modal.inventory.subagents) || []
            var items = checkedFirst('subagents', (function () {
              var q = String(modal.subQuery || '').trim().toLowerCase()
              return q ? allItems.filter(function (x) {
                return String(x.name).toLowerCase().indexOf(q) >= 0 || String(x.description || '').toLowerCase().indexOf(q) >= 0
              }) : allItems
            })(), function (x) { return String(x.name) },
              function (x) { return !!sections.subagents && sections.subagents.indexOf(x.name) >= 0 })
            return editorGroupNode({
              title: t('memory.archive.subagents'),
              count: defined ? t('scenes.seg.checked', { checked: sections.subagents.length, total: allItems.length }) : t('scenes.archive.sectionOff'),
              actions: archiveSegActions(defined, t('memory.archive.addSubagents'),
                function () { setSections(Object.assign({}, modalSections(), { subagents: [] })) },
                function () { var s = Object.assign({}, modalSections()); delete s.subagents; setSections(s) },
                function () { setSections(Object.assign({}, modalSections(), { subagents: allItems.map(function (x) { return x.name }) })) },
                function () { setSections(Object.assign({}, modalSections(), { subagents: [] })) },
                defined && allItems.length > 0 && allItems.every(function (x) { return sections.subagents.indexOf(x.name) >= 0 })),
              query: modal.subQuery,
              onQuery: function (v) { setModal(Object.assign({}, modal, { subQuery: v })) },
              queryPlaceholder: t('scenes.filter.subagents'),
              hideFilter: !defined,
              body: !defined
                ? React.createElement('div', { className: 'dsm-pick-empty', title: t('scenes.subagents.hint') }, t('scenes.subagents.hint.short'))
                : items.length
                  ? React.createElement('div', null, items.map(function (item) {
                      return RowSelect({
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
                  : React.createElement('div', { className: 'dsm-pick-empty' }, modal.subQuery ? t('scenes.mem.noMatch') : t('scenes.subagents.empty')),
            })
          }
          /**
           * 场景编辑器（新建 / 编辑 / 档案三弹窗融合，REDESIGN §6.2）：L=720 列表壳。
           * 一行两格（场景名 | 描述）→ 绑定行（三下拉并排）→ 摘要行 → 四组 2×2 →
           * footer [删除场景(仅编辑态,左)] [取消] [保存到场景/创建]。
           * MCP 服务器编辑弹窗渲染在外层：不能放进列表 Modal 的滚动容器里（会被裁掉）。
           */
          function editorNode() {
            if (!modal || modal.type !== 'scene-editor') return null
            var isEdit = modal.name != null
            var label = isEdit ? (sceneLabel(data.scenes, modal.name) || modal.name) : ''
            var own = modal.inventory ? sceneMemories(modal.name || '') : []
            var summary = t('scenes.editor.summary', {
              mcp: modal.sections.mcp ? Object.keys(modal.sections.mcp).length : 0,
              skills: modal.sections.skills ? modal.sections.skills.length : 0,
              subagents: modal.sections.subagents ? modal.sections.subagents.length : 0,
              // 创建态还没落盘的那批也算进去：它们同样会在「创建」那一刻变成这个场景的记忆。
              memories: own.length + ((modal.pendingMems || []).length),
            })
            var descLen = String(sceneForm.description || '').length
            // 字段级错误只留**真正关于本字段**的（用户 2026-10-12：「场景名下面的删除」）。
            // 保存失败时这里会被塞进 `translateError(t, res)`，其中"缺少访问令牌，或令牌不对"
            // 属于门禁、不属于场景名 —— 挂在字段下面既是第二次重复（弹窗头部 TokenGateNotice
            // 已经说了一遍，还带「填写令牌」），又会顺手把名称框标成非法（`dsm-rule-invalid`）。
            // 名称本身的校验错误（error.rules.invalidGroup）照旧显示。
            var fieldError = isTokenGateText(sceneForm.error) ? null : sceneForm.error
            // 快捷提示词下拉里「自定义」那一项要带计数（用户 2026-10-12：「自定义选项应该是
            // 自定义(*/*)」）：`picked` 是已经勾了几个，`total` 是可勾的总数。还没切到自定义时
            // `picked` 取"点下去会被预勾上的那批"（下面 onChange 里预勾的正是"当前启用"的那些）——
            // 两边口径必须一致，否则点一下数字会从 0 跳到 3。
            var quickTotal = (quickOptions || []).length
            var quickPicked = sceneForm.quickMode === 'custom'
              ? (sceneForm.quickPrompts || []).length
              : (quickOptions || []).filter(function (p) { return p.enabled !== false }).length
            // 「删除场景」已从编辑页移除（用户 2026-10-12）：删除是**场景卡片**上那一颗
            // （行内二次确认弹窗），编辑页的主职责是改内容 —— 左下角再挂一颗红键，和
            // 「取消 / 保存到场景」并排，误触代价又最大（会带走该场景下的全部记忆）。
            var main = React.createElement(Modal, { key: 'sedit', list: true, className: 'dsm-modal-list dsm-modal-editor',
              // 档案摘要挂在**标题旁边**（2026-10-12 重排）：它是一句"现在配了多少"的概览，
              // 原来单占一行（24px + 12px 间距）把四组往下顶；并入标题后这一行省给清单体。
              title: React.createElement('span', { className: 'dsm-modal-title-row' },
                isEdit ? t('scenes.editor.title', { name: label }) : t('memory.scene.createTitle'),
                React.createElement('span', { className: 'dsm-editor-summary' }, summary)),
              closeLabel: t('btn.close'), onClose: function () {
                if (modal.draftKey) stashFormDraft(modal.draftKey, { form: sceneForm, sections: modal.sections, pendingMems: modal.pendingMems })
                setModal(null)
              } },
              modal.error ? React.createElement(Notice, { kind: 'err', text: modal.error }) : null,
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('div', { className: 'dsm-field-row dsm-editor-basics' },
                  React.createElement('label', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, t('memory.scene.field.name')),
                    isEdit
                      ? React.createElement('span', { className: 'dsm-editor-name', title: modal.name }, modal.name)
                      : React.createElement('input', {
                          className: 'dsm-control' + (fieldError ? ' dsm-rule-invalid' : ''),
                          value: sceneForm.name || '',
                          placeholder: t('memory.scene.field.name.placeholder'),
                          onChange: function (e) { setSceneForm(Object.assign({}, sceneForm, { name: e.target.value, error: null })) },
                        }),
                    // 编辑态那一行「一级目录名，创建后不可改」已删（用户 2026-10-12）：
                    // 名字在这里是**只读展示**，改不了这件事界面已经替他做到了，不必再说一遍。
                    fieldError ? React.createElement('p', { className: 'dsm-rule-hint' }, fieldError) : null),
                  React.createElement('label', { className: 'dsm-field' },
                    React.createElement('div', { className: 'dsm-budget-meta' },
                      React.createElement('span', { className: 'dsm-label' }, t('memory.scene.field.desc')),
                      // 字数计数只在逼近上限时出现（≥80%，REDESIGN §12.3），平时不占视线。
                      descLen >= SCENE_DESC_MAX * 0.8
                        ? React.createElement('span', { className: 'dsm-char-count' }, descLen + '/' + SCENE_DESC_MAX)
                        : null),
                    React.createElement('input', {
                      className: 'dsm-control',
                      value: sceneForm.description || '',
                      maxLength: SCENE_DESC_MAX,
                      placeholder: t('memory.scene.field.desc.placeholder'),
                      onChange: function (e) { setSceneForm(Object.assign({}, sceneForm, { description: e.target.value, error: null })) },
                    })),
                // 三个绑定与名称/描述**同一行**（2026-10-12 压缩）：原先单独占一行、整行 56px + 12px
                // 间距，而这一档弹窗的高度是四组清单在用的。不带提示 bullet（§6.2「去杂」；
                // 机制细节进 placeholder / title）。
                React.createElement('div', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, t('scenes.field.prompt')),
                    presetOptions.length > 0
                      ? React.createElement(SourceSelect, {
                          options: [{ value: '', label: t('scenes.field.prompt.none') }].concat(presetOptions),
                          value: sceneForm.prompt || '',
                          onChange: function (v) { setSceneForm(Object.assign({}, sceneForm, { prompt: v })) },
                        })
                      : React.createElement('p', { className: 'dsm-help' }, t('scenes.prompt.noPresets'))),
                  React.createElement('div', { className: 'dsm-field' },
                    // 标签行：标题在左，勾选入口「选择」在右（只在「自定义」时出现）。
                    // 入口是标签行里的一颗小按钮（用户 2026-10-12：「改成『选择』，放在快捷提示词
                    // 标题最右边」）—— 早先那颗整宽按钮会把这一格顶高、还和下拉抢位置。
                    React.createElement('div', { className: 'dsm-label-row' },
                      React.createElement('span', { className: 'dsm-label' }, t('scenes.field.quickPrompts')),
                      sceneForm.quickMode === 'custom' && (quickOptions || []).length
                        ? React.createElement('button', {
                            type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: openQuickPick,
                          }, t('scenes.field.quickPrompts.pick'))
                        : null),
                    React.createElement(SourceSelect, {
                      value: sceneForm.quickMode || 'current',
                      // 「无」排第一（用户 2026-10-10：「无应该是第一条」）—— 与全局提示词那一格
                      // 同一条排法，把"新建场景会看到的那个"放在最上面。
                      options: [
                        { value: 'none', label: t('scenes.field.quickPrompts.noneOption') },
                        { value: 'current', label: t('scenes.field.quickPrompts.current') },
                        { value: 'custom', label: t('scenes.field.quickPrompts.customCount', { picked: quickPicked, total: quickTotal }) },
                      ],
                      onChange: function (v) {
                        setSceneForm(Object.assign({}, sceneForm, {
                          quickMode: v,
                          quickPrompts: v === 'none'
                            ? []
                            : v === 'custom'
                              ? (quickOptions || []).filter(function (p) { return p.enabled !== false }).map(function (p) { return p.id })
                              : null,
                        }))
                      },
                    }),
                    // 一条候选都没有时（「提示词」页还没建过）说清去哪儿建 —— 这时标签行里没有入口。
                    sceneForm.quickMode === 'custom' && !(quickOptions || []).length
                      ? React.createElement('p', { className: 'dsm-help' }, t('scenes.field.quickPrompts.none'))
                      : null),
                  React.createElement('div', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, t('scenes.field.toolTable')),
                    React.createElement(SourceSelect, {
                      value: String(sceneForm.toolTablePreset || ''),
                      options: toolTablePresetOptions(),
                      onChange: function (v) { setSceneForm(Object.assign({}, sceneForm, { toolTablePreset: v })) },
                    }))),
                // （原先这里是「自定义」时就地展开的勾选段卡片，2026-10-12 用户「能不能设置成弹窗」
                // 改为独立弹窗 —— 见下面的 quickPick 与 openQuickPick。）
                // 四组 2×2（档案四段并入）：行选择 + 组内滚，组容器底色分层不画边框。
                // 摘要已经并到标题那一行（见上面的 title），这里不再单占一行往下顶。
                React.createElement('div', { className: 'dsm-editor-grid' },
                  mcpGroup(),
                  skillsGroup(),
                  subagentsGroup(),
                  memoriesGroup())),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || !String(sceneForm.name || '').trim(), onClick: submitSceneEditor }, isEdit ? t('memory.archive.save') : t('memory.btn.create'))))
            var edit = modal.drill ? mcpEditNode() : null
            return edit ? React.createElement(React.Fragment, { key: 'sedit-wrap' }, main, edit) : main
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
           * （最后一段），人设本来就是短名。**技能目录（来源）不上卡**：来源级切换是技能
           * 启停的实现细节（勾了技能的来源才启用、一条都没勾就停用），项目来源的 key 还是
           * 一串路径哈希（`project-dsh:47d48f408c5edc5e`），而那个目录对用户可能根本不存在、
           * 也不是新建技能的落点 —— 报出来只会被当成故障（用户 2026-10-15 裁定）。
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
          /**
           * 预览卡正文。三段，顺序固定：
           *
           *   ① 绑定三行（全局提示词 / 快捷提示词 / 模型工具表）—— 排最前，写成 `标签：值`。
           *   ② 会改什么 —— 每域一行，没改动的域不出行。
           *   ③ 进入后是什么 —— MCP 服务器 / 记忆的结果口径。
           *
           * 为什么必须补出①、而且非写成 `标签：值` 不可（用户 2026-10-12：「提醒页正文不清楚」）：
           * 这三个域绑在**场景本体**上（`scene.prompt` / 档案里的 `quickPrompts`、`toolTablePreset`），
           * 进入时要么切换、要么原样不动。原先把"不动"写成「…不接管（这个场景没绑）」这种整句：
           *   · 形态上和下面那些 `标签：值` 的行不是一类，一眼扫不出"这三行是绑定的读数"；
           *   · 更糟的是把"保持现状"说成了"未绑定" —— 用户看到「全局提示词不接管」，理解成
           *     "我的全局提示词没绑"，而事实相反：全局那份一直在生效，只是**这个场景**没去改它。
           *     （用户 2026-10-12 报障：「全局提示词明明绑定了还显示未绑定」。）
           * 所以现在一律把值落在冒号右边，并且"保持现状"必须**带上当前那份的名字**：
           *   · 会切   → `全局提示词：切到「X」`
           *   · 不变   → `全局提示词：保持「X」不变（本场景未绑定）`
           * 拿不到当前那份（一份预设都没有）时才退回不带名字的说法。
           */
          function previewRows(plan) {
            var out = []
            if (plan.hasArchive !== true) out.push(React.createElement('div', { key: 'noarch', className: 'dsm-feedback dsm-warning' }, t('scenes.preview.noArchive')))
            if (plan.exit && plan.exit.scene) out.push(React.createElement('p', { key: 'exit', className: 'dsm-help' }, t(plan.exit.snapshotMissing ? 'scenes.preview.exitNoSnapshot' : 'scenes.preview.exitFirst', { scene: plan.exit.scene })))
            var mcp = plan.mcp || {}
            var sk = plan.skills || {}
            var sub = plan.subagents || {}
            var qp = plan.quickPrompts || {}
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
            function pushRow(rows, key, list, nameOnly) {
              var names = list || []
              if (!names.length) return
              changed += 1
              rows.push(React.createElement('p', { key: key, className: 'dsm-help' }, t(key, { count: names.length, names: previewNames(names, nameOnly === true) })))
            }
            // ── ① 绑定三行 ─────────────────────────────────────────────────────────────
            var bind = []
            function pushBind(key, params) {
              bind.push(React.createElement('p', { key: key, className: 'dsm-help' }, t(key, params)))
            }
            var arcName = String(plan.target || preview.name || '')
            var arc = (data.archives || {})[arcName] || {}
            var targetScene = (data.scenes || []).filter(function (s) { return String(s.name) === arcName })[0]
            var boundPrompt = targetScene && targetScene.prompt ? String(targetScene.prompt) : ''
            // 当前**驱动**基线的那份预设（有场景在驱动时它就是权威口径）；没有场景驱动时退回
            // "文件里生效的那份"（`agentsmd-list` 的 active）—— 后者才是用户眼里那个"明明绑定了"
            // 的全局提示词。两者都没有 = 一份预设都没在生效，才允许说"保持现状"而不带名字。
            var drivingNow = data.scenePrompt && data.scenePrompt.scene ? String(data.scenePrompt.presetId || '') : ''
            var livePrompt = drivingNow || String(appliedPreset || '')
            if (boundPrompt && drivingNow === boundPrompt) pushBind('scenes.preview.bind.promptSame', { name: boundPrompt })
            else if (boundPrompt) pushBind('scenes.preview.bind.prompt', { name: boundPrompt })
            else if (livePrompt) pushBind('scenes.preview.bind.promptKeep', { name: livePrompt })
            else pushBind('scenes.preview.bind.promptKeepNone')
            // 快捷提示词：改动行与"保持现状"行合到同一行族（它们说的是同一个域），只是措辞不同。
            var qOn = qp.on || []
            var qOff = qp.off || []
            if (qOn.length) { changed += 1; pushBind('scenes.preview.bind.quickOn', { count: qOn.length, names: previewNames(qOn) }) }
            if (qOff.length) { changed += 1; pushBind('scenes.preview.bind.quickOff', { count: qOff.length, names: previewNames(qOff) }) }
            if (!qOn.length && !qOff.length) {
              // 档案没定义这一段 = 这一域进都不进；定义了才分"空表"与"勾了几条"。
              if (!Array.isArray(arc.quickPrompts)) pushBind('scenes.preview.bind.quickKeep')
              else if (arc.quickPrompts.length) pushBind('scenes.preview.bind.quickKeepList', { count: arc.quickPrompts.length, names: previewNames(arc.quickPrompts.map(String)) })
              else pushBind('scenes.preview.bind.quickKeepEmpty')
            }
            // 模型工具表：方案已经不存在时（hiddenCount 为 null）说"这次不切换"，不报一个看不懂的数字。
            if (plan.toolPreset) {
              changed += 1
              pushBind(plan.toolPreset.hiddenCount === null ? 'scenes.preview.bind.toolMissing' : 'scenes.preview.bind.tool', { name: plan.toolPreset.name, count: plan.toolPreset.hiddenCount })
            } else pushBind('scenes.preview.bind.toolKeep')
            // ── ② 会改什么 ─────────────────────────────────────────────────────────────
            var rest = []
            pushRow(rest, 'scenes.preview.row.serversOn', mcp.serversOn)
            pushRow(rest, 'scenes.preview.row.serversOff', mcp.serversOff)
            pushRow(rest, 'scenes.preview.row.toolsOn', mcp.toolsOn)
            pushRow(rest, 'scenes.preview.row.toolsOff', mcp.toolsOff)
            pushRow(rest, 'scenes.preview.row.skillsOn', sk.on, true)
            pushRow(rest, 'scenes.preview.row.skillsOff', sk.off, true)
            pushRow(rest, 'scenes.preview.row.personasOn', sub.on)
            pushRow(rest, 'scenes.preview.row.personasOff', sub.off)
            if (mcp.notes) {
              changed += 1
              rest.push(React.createElement('p', { key: 'notes', className: 'dsm-help' }, t('scenes.preview.row.notes', { count: mcp.notes })))
            }
            // ── ③ 进入后是什么 ─────────────────────────────────────────────────────────
            // 「进入后启用 N 台 MCP 服务器」：**结果**口径，与上面四行的"会改什么"互补 ——
            // 上面全空时这一段就整段消失，用户读起来像缺了信息（2026-09-23 裁定）。
            // 但上面**已经有**服务器改动行时这一行必须收起来：同一台服务器会在相邻两行里
            // 各说一遍（「启用 1 台 MCP 服务器：github」紧跟「启用 1 台 MCP：github」）。
            var enterServers = (plan.enter && plan.enter.servers) || []
            var serverChanged = (mcp.serversOn || []).length + (mcp.serversOff || []).length
            if (enterServers.length && plan.noChange !== true && !serverChanged) {
              rest.push(React.createElement('p', { key: 'enter-servers', className: 'dsm-help' }, t('scenes.preview.enter.servers', { count: enterServers.length, names: previewNames(enterServers) })))
            }
            // 「进入后启用 N 个子智能体」：与服务器那一行同一条口径（结果口径 + 上面有改动行时
            // 收起来）。数据在客户端算：档案的 `subagents` 段不在 `plan.enter` 里，但
            // `data.archives[场景名]` 本来就有，和快捷提示词那一行同源。
            // 用户 2026-10-12：「子智能体遗漏了」—— 卡片此前只有 MCP 服务器 / 技能 / 记忆三行，
            // 少说一个域就等于让用户自己去猜"我的人设会不会被关掉"。
            var personaChanged = (sub.on || []).length + (sub.off || []).length
            if (!personaChanged && plan.noChange !== true && Array.isArray(arc.subagents)) {
              if (arc.subagents.length) {
                rest.push(React.createElement('p', { key: 'enter-personas', className: 'dsm-help' }, t('scenes.preview.enter.personas', {
                  count: arc.subagents.length, names: previewNames(arc.subagents.map(String)),
                })))
              } else rest.push(React.createElement('p', { key: 'enter-personas-none', className: 'dsm-help' }, t('scenes.preview.enter.personasNone')))
            }
            // 「进入后启用 N 条记忆」：同上，结果口径（含公共基线与全局，它们也在范围里）。
            // 此前这里还有一行"记忆注入范围收窄到「X」（公共基线与全局不受影响）"—— 用户
            // 2026-09-23 裁定删掉：下面这句把"有几条、是哪些"说全了，那一行只是把同一件事
            // 换个说法再说一遍。
            if (plan.target && plan.noChange !== true) {
              var memScope = memoriesInScopeAfterEnter(plan.target)
              if (memScope.length) {
                rest.push(React.createElement('p', { key: 'enter-memories', className: 'dsm-help' }, t('scenes.preview.enter.memories', {
                  count: memScope.length,
                  names: previewNames(memScope.map(function (r) { return String(r.name || r.id) })),
                })))
              }
            }
            if (plan.truncated) rest.push(React.createElement('p', { key: 'more', className: 'dsm-help' }, t('scenes.preview.truncated')))
            if ((plan.stale || []).length) rest.push(React.createElement('p', { key: 'stale', className: 'dsm-help' }, t('scenes.preview.stale', { count: plan.stale.length, items: previewNames(plan.stale) })))
            if (!changed && !rest.length && !out.length) rest.push(React.createElement('p', { key: 'none', className: 'dsm-help' }, t('scenes.preview.nochange')))
            return out.concat(bind, rest)
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
                syncScopeBar()
              }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }); refresh(true) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          // 场景写成功之后重拉一次作用域条：改档案 / 改绑工具表 / 删场景 / 全局进出模式都会
          // 改"本会话此刻生效什么"，而顶部条与各页的投影读的正是那一份（0.21.2 复核）。
          function syncScopeBar() {
            try { refreshScope() } catch (e) { /* 面板未挂载 = 一次白读，忽略 */ }
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
                syncScopeBar()
              }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }); refresh(true) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /**
           * 退出场景模式（本会话，0.21.2）：回到本对话**创建时**的样子 —— 用户裁定
           * 「不要退回到全局，因为全局是会变的」。服务端把下层换成基线快照（`detached`），
           * 场景模式期间拨过的开关一起清掉。
           */
          function exitSessionMode() {
            if (busy) return
            if (scopeState.locked === true) { setResult({ ok: false, text: scopeT('scope.lock.blockedSession') }); return }
            setBusy(true)
            scopeWriteScene(null, function () { return { ok: true } }).then(function (res) {
              setBusy(false)
              if (res && res.ok === false) { setResult({ ok: false, text: translateError(t, res) }); return }
              setResult({ ok: true, text: scopeT('scope.scene.exitMode') })
              refresh(true)
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /** 锁 / 解锁本会话的覆盖（0.21.2，决策 12）：只冻结这一层，与场景锁互不干扰。 */
          function toggleSessionLock() {
            if (busy) return
            setBusy(true)
            scopeSetLocked(scopeState.locked !== true).then(function (res) {
              setBusy(false)
              if (res && res.ok === false) { setResult({ ok: false, text: translateError(t, res) }); return }
              setResult({ ok: true, text: scopeState.locked === true ? scopeT('scope.lock.unlocked') : scopeT('scope.lock.locked') })
              refresh(true)
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          var modeScene = data.mode && data.mode.scene
          // 会话层（0.21.2）：本会话**生效**的场景（进入的 → 退出后的基线 → 全局的）。
          // 与 `modeScene` 分开：后者是运行时，会话层只改本对话看到什么、不碰运行时。
          var sessionLayer = scopeIsSession()
          var sessionScene = sessionLayer ? (data.activeScene || null) : null
          // 「进入」与「已退出」是两种不同的会话状态：进入 = 场景层（按档案实时算）；
          // 已退出 = 基线层（会话创建时的快照）。都没设 = 跟随全局。
          var sessionEntered = sessionLayer && typeof scopeState.overrides.scene === 'string'
          var sessionDetached = sessionLayer && scopeState.detached === true
          // 遗留检测 + 预设场景过滤 + 三格统计 + 「启用的排前面」：一次算完。这四步只跟
          // `data.scenes` / `data.archives` 有关，弹窗、提示条、忙碌标记之类的状态变化不再重跑。
          // 卡片 key 仍来自场景名，未动。
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
            // 2026-10-12 改成比例口径（用户：「其他几个也重新设计，显示的内容一定要有用」）：
            // 「2 个场景 / 0 个已启用 / 1 个有档案」三个孤立数字答不了"几个正开着、几个上着锁"，
            // 统一给成 `x/总` 之后每一格都自带分母。locked 是新加的 —— 锁定是这一页最需要
            // 一眼看到的状态（锁定期间整个管理域冻结）。
            var stats = {
              total: presets.length,
              // 会话层按本对话生效的场景算（进入的 / 退出后基线里的 / 跟随全局的）；照抄全局值会让
              // 页头数字与本层卡片上的勾对不上。
              active: scopeIsSession()
                ? presets.filter(function (s) { return s.name === data.activeScene; }).length
                : presets.filter(function (s) { return s.active === true; }).length,
              archives: presets.filter(function (s) { return !!data.archives[s.name] }).length,
              locked: presets.filter(function (s) { return s.locked === true }).length,
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
              orderedScenes: rankedFirst(sceneRank, function (scene) { return scene.name }, visible, function (scene) { return scene.active === true; }),
            }
          }, [data.scenes, data.archives, data.activeScene, dq, scopeState])
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
          function archiveSummary(archive, scene) {
            var parts = []
            if (archive) {
              if (archive.mcp) parts.push(t('scenes.profile.mcp', { count: Object.keys(archive.mcp).length }))
              if (Array.isArray(archive.skills)) parts.push(t('scenes.profile.skills', { count: archive.skills.length }))
              if (Array.isArray(archive.subagents)) parts.push(t('scenes.profile.subagents', { count: archive.subagents.length }))
              // 快捷提示词绑了才报（没绑 = 这一域不碰）。**空表也要报** —— 它说的是"进入后全部停用"，
              // 与"没绑"是两件事，漏掉就等于把用户的一个真实选择显示成没有这个选择。
              if (Array.isArray(archive.quickPrompts)) parts.push(t('scenes.profile.quickPrompts', { count: archive.quickPrompts.length }))
            }
            // 记忆：**不在档案里**（P5 起开关就是 `rules[*].enabled` 单一真相源），所以数量得从
            // 当前场景的记忆清单里现算（用户 2026-10-12：「启动场景缺少记忆数量的显示」——
            // 进入场景后注入的正是这几条，它比档案里任何一段都更该出现在这条横幅上）。
            // 报「生效/总数」而不是单个数字：这个场景有 5 条但只开了 2 条，才是用户要看的那件事
            // （与记忆页统计同一口径）。一条都没有的场景不出现这一段。
            var sceneRules = (data.rules || []).filter(function (r) { return r.group === scene })
            if (sceneRules.length > 0) {
              var on = sceneRules.filter(function (r) { return r.enabled !== false }).length
              parts.push(t('scenes.profile.memories', { count: on + '/' + sceneRules.length }))
            }
            return parts.join(' · ')
          }
          // 当前模式场景被锁 → 「退出模式」按钮与开关一起禁用（服务端守卫兜底）。
          // `modeSceneObj` 是那个场景的记录本身：横幅里那颗「锁定」要拿它去调 toggleSceneLock。
          var modeSceneObj = modeScene ? (data.scenes || []).filter(function (s) { return s.name === modeScene })[0] : null
          var modeSceneLocked = !!(modeSceneObj && modeSceneObj.locked === true)
          var modeSummary = modeScene ? archiveSummary(data.archives[modeScene], modeScene) : ''
          return React.createElement('section', { className: 'dsm-section' },
            // 页头一行化（REDESIGN §3 + §6）：新增(实底) · 开启提醒 · 回收站；统计内联。
            React.createElement(PageHead, {
              key: 'head',
              title: t('scenes.title'),
              desc: t('scenes.desc'),
              stats: [
                [sceneStats.active + '/' + sceneStats.total, t('scenes.stat.total')],
                [sceneStats.archives + '/' + sceneStats.total, t('scenes.stat.archives')],
                [sceneStats.locked + '/' + sceneStats.total, t('scenes.stat.locked')],
              ],
              actions: [
                React.createElement('button', { key: 'new', type: 'button', className: 'dsm-btn', disabled: busy, onClick: openCreateScene }, t('memory.btn.newScene')),
                // 进入场景前的提醒开关（用户 2026-09-23 裁定放在「回收站」左边）。按钮文字是
                // **动作**：现在会弹 → 写「关闭提醒」；已经关掉 → 写「开启提醒」。
                // 两个方向各取字面量键，不合成三元选词（词典键必须 t('字面量') 直传）。
                React.createElement('button', {
                  key: 'preview', type: 'button', className: 'dsm-btn dsm-btn-secondary', title: t('scenes.preview.toggle.title'),
                  onClick: function () { saveEnterPreview(!enterPreview) },
                }, enterPreview ? t('scenes.preview.toggle.off') : t('scenes.preview.toggle.on')),
                React.createElement('button', { key: 'trash', type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { setTrash(true) } }, t('trash.btn.open')),
              ],
            }),
            // 列表工具条（REDESIGN §3.3，切片四）：搜索住 children；场景页没有批量动作与筛选下拉。
            React.createElement(Toolbar, { key: 'filters' },
              React.createElement('input', {
                className: 'dsm-control dsm-search', value: query, 'aria-label': t('search'),
                placeholder: t('scenes.search.placeholder'),
                onChange: function (e) { setQuery(e.target.value) },
              })),
            // 会话层（0.21.2）：本对话当前生效的场景 + 会话锁。**不显示**运行时的「退出模式」
            // / 场景锁 —— 那两个动作改的是全局，在本层点它们等于"以为在改本对话、实际改了全局"。
            // 本层自己的「退出模式」= 回到本对话创建时的样子（与全局层那颗同名不同义：
            // 全局那颗退到运行时快照，这一颗退到会话基线）。
            sessionLayer ? React.createElement('div', { key: 'scope-mode', className: 'dsm-mode-bar dsm-mode-bar-scoped' },
              React.createElement('span', { className: 'dsm-mode-dot' + (sessionEntered ? ' dsm-mode-dot-scoped' : '') }),
              React.createElement('div', { className: 'dsm-mode-main' },
                React.createElement('div', { className: 'dsm-mode-title' },
                  sessionEntered
                    ? scopeT('scenes.mode.session', { name: sceneLabel(data.scenes, sessionScene) || sessionScene }) + ' · ' + t('scope.mode.entered')
                    : sessionDetached
                      ? scopeT('scope.mode.detached')
                      : (sessionScene
                        ? scopeT('scenes.mode.session', { name: sceneLabel(data.scenes, sessionScene) || sessionScene }) + ' · ' + t('scope.mode.followGlobal')
                        : scopeT('scope.mode.noScene'))),
                React.createElement('div', { className: 'dsm-mode-sub' }, scopeT('scope.mode.note'))),
              React.createElement('span', { className: 'dsm-mode-acts' },
                sessionEntered
                  ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || scopeState.locked === true, title: scopeState.locked === true ? scopeT('scope.lock.blockedSession') : '', onClick: exitSessionMode }, t('scope.scene.exitMode.btn'))
                  : null,
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-lock', disabled: busy, title: scopeIsWorkspace() ? t('scope.lock.hintWorkspace') : scopeT('scope.lock.hint'), onClick: toggleSessionLock }, scopeState.locked === true ? scopeT('scope.lock.unlock') : scopeT('scope.lock.lock')))) : null,
            // 全局层「当前模式条」：**只在真的进入了模式时才出现**。
            // 以前没有模式时也常驻一条「自由模式 + 一句解释」，用户反馈「这个是干什么的，感觉没什么用」——
            // 静态解释占一整条，而「没有条 = 没有模式」本来就不言自明。现在它只承载有状态的信息：
            // 哪个场景是当前模式、它包含什么档案、怎么退出。
            !sessionLayer && modeScene ? React.createElement('div', { key: 'mode', className: 'dsm-mode-bar' },
              React.createElement('span', { className: 'dsm-mode-dot' }),
              React.createElement('div', { className: 'dsm-mode-main' },
                React.createElement('div', { className: 'dsm-mode-title' },
                  t('scenes.mode.active', { name: sceneLabel(data.scenes, modeScene) || modeScene })),
                React.createElement('div', { className: 'dsm-mode-sub' },
                  modeSummary ? t('scenes.mode.profile', { parts: modeSummary }) : t('scenes.mode.noProfile'))),
              // 「锁定」搬到这条横幅里、挨着「退出模式」（用户 2026-10-18：「锁定改成只有开启后
              // 才出现，而且出现在退出模式旁边」）：锁的是**当前正在用的这个场景**，卡片上每张
              // 都挂一颗、再按 active 置灰，读起来像"这张卡有锁功能但用不了"。只有进入之后才有
              // 锁定这回事，于是它只在这条横幅里出现。
              React.createElement('span', { className: 'dsm-mode-acts' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-lock', disabled: busy, title: t('scenes.lock.hint'), onClick: function () { toggleSceneLock(modeSceneObj) } }, modeSceneLocked ? t('scenes.lock.unlock') : t('scenes.lock.lock')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || modeSceneLocked, title: modeSceneLocked ? t('scenes.lock.blockedExit') : '', onClick: exitMode }, t('memory.mode.exit')))) : null,
            React.createElement(Notice, { key: 'notice', kind: result && result.ok ? 'ok' : 'err', text: result && result.text }),
            React.createElement(UndoBar, { key: 'undo', undo: undo, busy: busy, t: t, onUndo: undoMemories, onClose: dismissUndo }),
            // 历史「全部启用」（active=null）遗留：单选模型下多名场景同时在场是歧义状态。
            // 不静默改写（那会改变注入范围），而是给一个显式收敛按钮，并说清点下去会发生什么。
            legacyAllScenes.length > 1 && !sessionLayer ? React.createElement('div', { key: 'legacyall', className: 'dsm-feedback dsm-warning' },
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
            // 隔离守卫（0.21.2）：索引被隔离 = **所有记忆写操作都被拒**，与悬空引用不同量级。
            // 单独一条横幅 + 一颗一键修复按钮。只在这条 finding 存在时渲染 —— 没有就是没有。
            (function () {
              var doc = data.doctor
              var q = doc && (doc.findings || []).filter(function (r) { return r.kind === 'quarantine' })[0]
              if (!q) return null
              return React.createElement('div', { key: 'quarantine', className: 'dsm-feedback dsm-warning' },
                React.createElement('div', { key: 'head' }, t('scenes.quarantine.title')),
                React.createElement('div', { key: 'row', className: 'dsm-help' }, t('scenes.quarantine.row', { name: q.name })),
                React.createElement('div', { key: 'hint', className: 'dsm-help' }, t('scenes.quarantine.hint')),
                React.createElement('button', {
                  type: 'button', key: 'fix', className: 'dsm-btn dsm-btn-secondary', disabled: busy,
                  onClick: function () {
                    if (busy) return
                    setBusy(true)
                    apiCall('memories-index-repair', {}).then(function (res) {
                      setBusy(false)
                      if (res && res.ok) { setResult({ ok: true, text: t('scenes.quarantine.fixed', { scenes: res.scenes || 0, rules: res.rules || 0 }) }); refresh() }
                      else setResult({ ok: false, text: translateError(t, res) })
                    }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
                  },
                }, t('scenes.quarantine.fix')))
            })(),
            data.error ? React.createElement(Notice, { key: 'gerr', kind: 'err', text: String(data.error) }) : null,
            // 列表四态（REDESIGN §12.2，切片四）：加载 / 失败（EmptyState + 重试）/ 空 /
            // 无结果（+ 清除筛选）/ 有数据（场景卡片网格 —— 场景是「档案」不是列表行，保持卡片）。
            data.loading && !presetScenes.length ? React.createElement(ListStates, { key: 'loading', t: t, state: 'loading' })
              : data.error && !presetScenes.length ? React.createElement(ListStates, { key: 'errstate', t: t, state: 'error', text: String(data.error), onRetry: function () { refresh() } })
                : !presetScenes.length ? React.createElement(ListStates, { key: 'empty', t: t, state: 'empty', text: t('scenes.empty') })
                  : !visibleScenes.length ? React.createElement(ListStates, { key: 'search', t: t, state: 'search', text: t('scenes.empty.search'), onClearFilter: function () { setQuery('') } })
                    : React.createElement('div', { key: 'scenes', className: 'dsm-scenes' }, orderedScenes.map(function (scene) {
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
                // 会话作用域（0.21.2）：**来源标记打在卡片边框上**（用户 2026-10-19 裁定，
                // 颜色统一为绿 —— 停在某一层时看到的绿框说的就是"这一层在用它"）。
                // ⚠️ 判据是**覆盖表里有没有这一条**（进入过），不是「本层生效场景是不是它」：
                // 后者在没进入时等于全局那个场景，会话层一打开就会把全局场景也标成"本会话
                // 进入"—— 而这个标记说的是"这一格与本对话以外不一样"。
                var sceneOver = scopeIsSession() ? scopeState.overrides.scene : undefined
                var enteredHere = typeof sceneOver === 'string' && sceneOver === name
                // 绿框 / 「当前」标签跟着**正在看的那一层**走：会话层 = 本对话生效的场景
                // （进入的 / 退出后基线里的 / 跟随全局的），全局层 = 运行时那个。
                var tileCurrent = scopeIsSession() ? (data.activeScene || null) : modeScene
                var tileClass = 'dsm-scene-tile'
                  + (tileCurrent === name ? ' dsm-scene-tile-mode' : '')
                  + (enteredHere ? ' dsm-scene-tile-scoped' : '')
                return React.createElement('article', { key: 's:' + name, className: tileClass },
                  // 左列：名字 + 描述（两行）。右侧控件是另一格，二者按卡片中线对齐。
                  React.createElement('div', { className: 'dsm-scene-tile-main' },
                    React.createElement('div', { className: 'dsm-scene-tile-head' },
                      React.createElement('span', { className: 'dsm-scene-tile-name', title: label }, label),
                      // 显示名与磁盘目录名不同时才标出真名，方便对文件核对。
                      name === label ? null : React.createElement('span', { className: 'dsm-scene-tile-key' }, name),
                      locked ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.scene.shared')) : null,
                      tileCurrent === name ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('memory.mode.current')) : null,
                      sceneLocked ? React.createElement('span', { className: 'dsm-tag dsm-tag-on' }, t('scenes.lock.tag')) : null,
                      !locked && scene.active === false ? React.createElement('span', { className: 'dsm-tag' }, t('memory.scene.off')) : null,
                      // 「提示词生效中：X」「提示词：X」两枚标签已删（用户 2026-10-18）：绑定关系在
                      // 编辑器里一眼可改，挂在卡片上只是每行多一枚药丸。只留**出问题时**的两枚
                      //（预设不见了 / 文件里不是它）—— 那才是需要人动手的信号。
                      promptMissing ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('scenes.prompt.tag.hint') }, t('scenes.prompt.missing', { id: boundPrompt })) : null,
                      promptMismatch ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('scenes.prompt.mismatch.hint', { id: boundPrompt }) }, t('agm.file.mismatch')) : null),
                    // 描述固定第二行（用户 2026-10-18：「场景页的备注在设置页没显示，应该显示在第二行」）：
                    // 在编辑器里填的描述就是这一句，它不在卡头那一行跟名字抢宽度。没有描述也渲染，
                    // 保持每张卡同样两行高，行与行之间对得齐。
                    React.createElement('div', { className: 'dsm-scene-tile-desc', title: desc || '' }, desc || t('scenes.noDesc'))),
                  // 右列：开关 + ⋯（用户 2026-10-18：「switch 按键和三个点按键没有上下居中」）。
                  // 「锁定」已搬进当前模式横幅，卡片上不再出现 —— 锁的是"正在用的那个场景"。
                  // 编辑 / 删除收进行尾一颗 ⋯：卡片底下那条只有两颗按钮的空 band 白占一截高度。
                  // 锁定态「编辑」照旧置灰（改档案是写盘动作，与记忆 / 子智能体那两页的
                  // "只读能看"不同，场景编辑器一打开就是那张要保存的表）。
                  React.createElement('div', { className: 'dsm-scene-tile-side' },
                    locked ? null : (function () {
                      // 会话作用域（0.21.2）：这一格的值来自 `scopeScene`（本层生效值）；
                      // 本对话进入过它时卡片上另画来源边框（见 10-css.js 的视觉口径）。
                      // 会话层下**没有**「被别的场景挡住」这件事 —— 本对话的场景不占全局名额。
                      // 开关交互与全局层同构：点生效中的那个 = 退出场景模式（回到创建时的
                      // 样子）；点别的 = 进入它。
                      var flag = scopeScene(data.activeScene)
                      var onHere = scopeIsSession() ? flag.value === name : scene.active === true
                      var blockedHere = scopeIsSession() ? false : blockedByOther
                      var enteredNow = scopeIsSession() && typeof scopeState.overrides.scene === 'string' && scopeState.overrides.scene === name
                      var sessionLocked = scopeIsSession() && scopeState.locked === true
                      var switchTitle = blockedHere
                        ? t('scenes.enable.blocked', { name: sceneLabel(data.scenes, data.activeScene) || data.activeScene || '' })
                        : (scopeIsSession() && onHere
                          ? scopeT('scope.scene.exitHint')
                          : (!scopeIsSession() && sceneLocked && scene.active === true ? t('scenes.lock.blockedExit') : ''))
                      return React.createElement('span', {
                        className: 'dsm-scene-tile-switch',
                        title: switchTitle,
                      }, React.createElement(Switch, { on: onHere, scoped: enteredNow, disabled: busy || blockedHere || sessionLocked || (!scopeIsSession() && sceneLocked && scene.active === true), label: t('memory.scene.enable') + ' ' + name, onClick: function () { toggleScene(scene) } }))
                    })(),
                    React.createElement(RowMenu, {
                      key: 'menu',
                      label: t('row.menu', { name: label }),
                      items: [
                        { key: 'edit', label: t('scenes.row.edit'), disabled: busy || sceneLocked, title: sceneLocked ? t('scenes.lock.blockedEdit') : undefined, onClick: function () { openEditor(scene) } },
                      ].concat(locked ? [] : [
                        { key: 'delete', label: t('scenes.row.delete'), danger: true, disabled: busy || sceneLocked, title: sceneLocked ? t('scenes.lock.blockedEdit') : undefined, onClick: function () { setModal({ type: 'scene-delete', name: name }) } },
                      ]),
                    })))
              })),
            modal && modal.type === 'scene-delete' ? React.createElement(Modal, { key: 'sdel', className: 'dsm-modal-sm', title: t('memory.deleteScene.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('memory.deleteScene.desc', { name: modal.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setModal(null) } }, t('btn.cancel')),
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
            // 场景编辑器（新建 / 编辑 / 档案三弹窗融合，见 editorNode）。
            editorNode(),
            // 「新建记忆」弹窗（记忆集组头那颗「创建」）：同样排在编辑器之后 —— 它是编辑器里
            // 开出来的子弹窗，后渲染的盖在上面。
            memoryCreateNode(),
            // 「已存在同名记忆」小窗：叠在「新建记忆」弹窗之上（三个入口的层级从下往上依次是
            // 场景编辑器 → 新建记忆 → 同名确认）。取消 → 回到新建记忆弹窗改名字，正文与附件不动。
            memDupAsk ? React.createElement(DupNameDialog, {
              key: 'memdup', t: t, kind: t('dup.kind.memory'),
              name: memDupAsk.name, finalName: memDupAsk.finalName, action: 'create',
              busy: busy,
              onCancel: function () { setMemDupAsk(null) },
              onConfirm: function () { setMemDupAsk(null); stageMemoryDraft(memDupAsk.finalName) },
            }) : null,
            // 「已存在同名场景」小窗：叠在场景编辑器之上。取消 → 回到编辑器改名，档案四组不动。
            sceneDupAsk ? React.createElement(DupNameDialog, {
              key: 'scenedup', t: t, kind: t('dup.kind.scene'),
              name: sceneDupAsk.name, finalName: sceneDupAsk.finalName, action: 'create',
              busy: busy,
              onCancel: function () { setSceneDupAsk(null) },
              onConfirm: function () { setSceneDupAsk(null); saveScene(sceneDupAsk.finalName, false) },
            }) : null,
            // 快捷提示词勾选弹窗（2026-10-12）：**排在编辑器之后**，两层遮罩同 z-index，
            // 后渲染的在上面 —— 它是编辑器里那颗按钮开出来的子弹窗。
            quickPick ? React.createElement(Modal, {
              key: 'qpick', list: true, className: 'dsm-modal-list dsm-quickpick',
              // 计数挂在标题旁边（与场景编辑器同一排法）：它是"这次勾了几条"的实时回执。
              title: React.createElement('span', { className: 'dsm-modal-title-row' },
                t('scenes.quickPick.title'),
                React.createElement('span', { className: 'dsm-seg-count' },
                  t('scenes.seg.checked', { checked: quickPick.draft.length, total: (quickOptions || []).length }))),
              closeLabel: t('btn.close'), onClose: function () { setQuickPick(null) },
            },
              React.createElement('p', { className: 'dsm-help' }, t('scenes.quickPick.hint')),
              (quickOptions || []).length
                ? React.createElement('div', { className: 'dsm-pick-list' }, (quickOptions || []).map(function (p) {
                    return pickRow({
                      key: p.id, name: p.id, desc: p.description || '',
                      checked: quickPick.draft.indexOf(p.id) >= 0,
                      onChange: function () { toggleQuickPick(p.id) },
                    })
                  }))
                : React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.field.quickPrompts.none')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                segActions({
                  defined: true, busy: busy,
                  selectAllLabel: t('bulk.selectAll'), clearLabel: t('bulk.unselectAll'),
                  allChecked: (quickOptions || []).length > 0 && quickPick.draft.length === (quickOptions || []).length,
                  onAll: function () { setQuickPick({ draft: (quickOptions || []).map(function (p) { return p.id }) }) },
                  onClear: function () { setQuickPick({ draft: [] }) },
                }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { setQuickPick(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: applyQuickPick }, t('scenes.quickPick.confirm'))))
              : null,
            // 本页的回收站（42-shared-ui.js）：数据与写操作在组件内部，本页只管开关与写后刷新。
            trash ? React.createElement(TrashModal, {
              t: t,
              domain: 'scenes',
              onClose: function () { setTrash(false) },
              onReload: function () { refresh(true) },
            }) : null,
          )
        }