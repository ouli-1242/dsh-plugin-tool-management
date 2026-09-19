        // ---------- 子智能体页：人设文件（~/.dsh/subagents/*.md）管理 ----------
        function SubagentsPage() {
          var state = React.useState({ loading: true, error: null, subagents: [] })
          var data = state[0], setData = state[1]
          var bs = React.useState(false)
          var busy = bs[0], setBusy = bs[1]
          var rs = React.useState(null)
          var result = rs[0], setResult = rs[1]
          var ms = React.useState(null)
          var modal = ms[0], setModal = ms[1]
          // 搜索词独立一处：`data` 在 refresh 时被整对象替换，寄在它里面会被刷新清空。
          // 过滤用防抖值，输入框仍绑原值（与提示词页同一写法）。
          var qs = React.useState('')
          var query = qs[0], setQuery = qs[1]
          var dq = useDebouncedValue(query)
          // 场景锁定（v0.8）：任一场景锁定 = 五个域整体冻结；本页全部写控件禁用。
          var anyLocked = data.anyLocked === true
          // 场景内开关由档案定义：人设开关置灰（要改就去场景页的档案编辑器里改）。
          var sceneName = data.activeScene || null
          // 回收站：删除人设 = 移入回收站（宿主侧 subagent-delete），这里列出/恢复/永久删除。
          var ts = React.useState(null)
          var trash = ts[0], setTrash = ts[1]
          var tb = React.useState(false)
          var trashBusy = tb[0], setTrashBusy = tb[1]
          var flipRef = React.useRef(null)
          useFlipReorder(flipRef)
          function loadTrash(keepOpen) {
            setTrash(Object.assign({ loading: true, error: null, entries: [] }, keepOpen ? trash || {} : {}))
            apiCall('subagent-trash-list', {}).then(function (res) {
              if (res && res.ok) setTrash({ loading: false, error: null, entries: res.trash || [] })
              else setTrash({ loading: false, error: (res && res.error) || t('trash.loadFailed'), entries: [] })
            }).catch(function (e) { setTrash({ loading: false, error: errMsg(e), entries: [] }) })
          }
          function restorePersona(item) {
            setTrashBusy(true)
            apiCall('subagent-trash-restore', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { var sw = stateSyncWarn(t, res); setResult({ ok: !sw, warning: !!sw, text: t('trash.restored', { name: item.name }) + (sw ? ' ' + sw : '') }); refresh(true); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: errMsg(e) }) }) })
          }
          function purgePersona(item) {
            setTrashBusy(true)
            apiCall('subagent-trash-delete', { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setResult({ ok: true, text: t('trash.purged', { name: item.name }) }); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: errMsg(e) }) }) })
          }
          React.useEffect(function () { if (!result || result.ok !== true) return undefined; var timer = setTimeout(function () { setResult(null) }, 2600); return function () { clearTimeout(timer) } }, [result])
          function refresh(silent) {
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('subagent-list', {}).then(function (r) {
              // `activeScene` 必须一起搬进来：这里是把 `data` 整对象替换掉（搜索词另存就是为了
              // 不被冲掉），漏一个字段等于那个字段永远是初始值 —— 场景横幅因此从来没显示过
              // （2026-09-19 用户报的：技能 / 子智能体 / 记忆三页都看不到"当前处于场景…"）。
              if (r && r.ok) setData({ loading: false, error: null, subagents: r.subagents || [], anyLocked: r.anyLocked === true, activeScene: r.activeScene || null, toolFailures: Array.isArray(r.toolFailures) ? r.toolFailures : [] })
              else setData({ loading: false, error: translateError(t, r), subagents: [], toolFailures: [] })
            }).catch(function (e) { setData({ loading: false, error: errMsg(e), subagents: [], toolFailures: [] }) })
          }
          React.useEffect(function () { refresh() }, [])
          /**
           * 子智能体开关（与记忆页同一套交互）：停用 = 不注入目录段、subagent_manager_list/run
           * 不可见；人设文件不动。开关联动全局状态，立即提交。
           */
          function togglePersona(p) {
            var next = !(p.enabled !== false)
            setBusy(true)
            apiCall('subagent-toggle', { name: p.name, enabled: next }).then(function (r) {
              setBusy(false)
              if (r && r.ok) {
                // 场景内改开关：人设改了、档案没跟上时说清楚（详见 sceneSyncWarn）。
                var warn = sceneSyncWarn(t, r)
                setResult(warn ? { ok: false, warning: true, text: warn } : null)
                refresh(true)
              } else if (r) setResult({ ok: false, text: translateError(t, r) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          /**
           * 人设表单的候选数据（模型目录 / 全体预设工具并集）只在**首次展开高级选项**时拉取：
           * 宿主枚举预设需要为尚未挂载的预设建立 standing mount，不该在打开弹窗时就付这个代价。
           */
          var cands = React.useState({ loaded: false, loading: false, error: null, models: [], tools: [], presets: [] })
          var cand = cands[0], setCand = cands[1]
          function loadCandidates() {
            if (cand.loaded || cand.loading) return
            setCand(Object.assign({}, cand, { loading: true, error: null }))
            Promise.all([apiCall('model-candidates', {}), apiCall('preset-tools', {})]).then(function (rs) {
              var mres = rs[0], tres = rs[1]
              var failed = (!mres || mres.ok === false) && (!tres || tres.ok === false)
              setCand({
                loaded: true, loading: false,
                error: failed ? t('subagents.adv.loadFailed') : null,
                models: (mres && mres.models) || [],
                tools: (tres && tres.tools) || [],
                // presets 必须原样带过来：四行模式的名字、顺序、每行的工具清单全靠它，
                // 早先这里只留 models/tools，于是分组标题退回裸 id（中文界面里显示英文）。
                presets: (tres && tres.presets) || [],
              })
            }).catch(function (e) {
              setCand({ loaded: true, loading: false, error: errMsg(e), models: [], tools: [], presets: [] })
            })
          }
          /** 高级选项：默认收起；已经在用模型/工具限制的人设自动展开（否则用户看不见自己配了什么）。 */
          /** 「不限制嵌套」的取值（与 src/subagents/service.ts 的 UNLIMITED_PERSONA_CATALOG_DEPTH 同值）。 */
          var CATALOG_DEPTH_UNLIMITED = 99
          /** 目录注入深度的选项文案：下拉与折叠摘要共用一处，免得两处说法分叉。 */
          function catalogDepthLabel(n) {
            if (n === 1) return t('subagents.field.catalogDepth.onlyTop')
            if (n === 2) return t('subagents.field.catalogDepth.toChild')
            if (n >= CATALOG_DEPTH_UNLIMITED) return t('subagents.field.catalogDepth.unlimited')
            return t('subagents.field.catalogDepth.toGrand')
          }
          function initialAdvanced(p) {
            var modes = p && p.toolsByPreset ? Object.keys(p.toolsByPreset).length : 0
            // 目录注入深度不是默认值（1）时也算"配过"：它决定常驻目录出现在哪些会话，
            // 藏起来会让"为什么子会话看不到目录"变得无从查起。
            var budget = !!(p && typeof p.catalogDepth === 'number' && p.catalogDepth !== 1)
            return !!(budget || (p && (p.model || p.provider)) || (p && ((p.tools || []).length || (p.toolsDeny || []).length || modes)))
          }
          /** 编辑态里按模式分组的名单（深拷贝：取消编辑不留痕）。 */
          function cloneRules(source) {
            var out = {}
            Object.keys(source || {}).forEach(function (id) {
              var rule = source[id] || {}
              out[id] = { mode: rule.mode === 'deny' ? 'deny' : 'allow', names: (rule.names || []).slice() }
            })
            return out
          }
          function openEditor(name) {
            if (!name) {
              setModal({ type: 'editor', mode: 'create', advanced: false, openMode: null, stoppedRules: {}, modeQuery: '', legacyTarget: '', form: { name: '', description: '', provider: '', model: '', catalogDepth: 1, tools: [], toolsDeny: [], toolsByPreset: {}, body: '', output: '', error: null } })
              return
            }
            setBusy(true)
            apiCall('subagent-get', { name: name }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                var p = res.persona || {}
                var advanced = initialAdvanced(p)
                setModal({ type: 'editor', mode: 'edit', originalName: String(p.name || name), advanced: advanced, openMode: null, stoppedRules: {}, modeQuery: '', legacyTarget: '', form: {
                  name: p.name || name, description: p.description || '', provider: p.provider || '', model: p.model || '',
                  // 服务端回的是**生效值**（没写就是默认 1），所以这里不必再兜默认。
                  catalogDepth: typeof p.catalogDepth === 'number' ? p.catalogDepth : 1,
                  tools: (p.tools || []).slice(), toolsDeny: (p.toolsDeny || []).slice(),
                  toolsByPreset: cloneRules(p.toolsByPreset), body: p.body || '', output: p.output || '', error: null,
                } })
                // 已配过限制的人设**一打开就是展开的**（initialAdvanced）→ 候选数据必须在这里也拉，
                // 否则四行模式先亮"宿主没有回传预设名单"，非得点两次「高级选项」才补上（用户实测）。
                if (advanced) loadCandidates()
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          function setForm(patch) { if (modal && modal.type === 'editor') setModal(Object.assign({}, modal, { form: Object.assign({}, modal.form, patch) })) }
          /** 列表里增删一项（勾选语义：存在 = 勾上）。 */
          function toggled(list, name) {
            var next = (list || []).slice()
            var i = next.indexOf(name)
            if (i >= 0) next.splice(i, 1); else next.push(name)
            return next
          }
          /**
           * 模型下拉的当前值。
           * 宿主目录里有这对 (provider, model) → 用它；只有 model 没有 provider（跨来源手工填的）
           * 或目录里没有 → 走「自定义」，同时把输入框露出来，避免把用户已配好的值悄悄改掉。
           */
          function modelSelectValue() {
            if (!modal || modal.type !== 'editor') return ''
            var f = modal.form
            if (!f.model) return ''
            var hit = (cand.models || []).filter(function (m) { return m.provider === f.provider && m.id === f.model })[0]
            return hit ? (f.provider + '\u0000' + f.model) : '__custom__'
          }
          /**
           * 官方四个预设的中英名走插件词典（官方 preset.yml 里只有中文名，直接用会让英文界面
           * 露出中文）；**自建预设用它自己的名字，不翻译** —— 与官方 display 规则一致。
           * 四个预设 id → 词典键的映射只认官方发布的这四个 id。
           */
          var SHIPPED_PRESET_IDS = { minimal: 1, standard: 1, ptc: 1, cordis: 1 }
          function presetLabel(p) {
            if (!p) return ''
            var id = String(p.id || '')
            if (SHIPPED_PRESET_IDS[id] === 1 && String(p.trust || 'system') !== 'user') return t('preset.name.' + id)
            return String(p.name || id)
          }
          /** 该模式下可勾选的工具名；`null` = 宿主没给出该模式的清单（读不到，不能假装是空）。 */
          function modeTools(id) {
            var hit = (cand.presets || []).filter(function (p) { return p.id === id })[0]
            return hit && Array.isArray(hit.tools) ? hit.tools : null
          }
          function modeRule(id) { return (modal.form.toolsByPreset || {})[id] }
          function setModeRule(id, rule) {
            var next = Object.assign({}, modal.form.toolsByPreset || {})
            if (rule) next[id] = rule; else delete next[id]
            setModal(Object.assign({}, modal, {
              form: Object.assign({}, modal.form, { toolsByPreset: next }),
              openMode: modal.openMode === id && !rule ? null : modal.openMode,
            }))
          }
          /** 模式行上的一句话状态：未开启 / 白名单 N 个 / 黑名单 N 个 / 已开启但没勾（= 不限制）。 */
          function modeSummary(id) {
            var rule = modeRule(id)
            if (!rule) return { text: t('subagents.mode.off'), cls: 'dsm-mode-off' }
            var n = (rule.names || []).length
            if (!n) return { text: t('subagents.mode.empty'), cls: 'dsm-mode-off' }
            return {
              text: t(rule.mode === 'deny' ? 'subagents.mode.denyOn' : 'subagents.mode.allowOn', { count: n }),
              cls: rule.mode === 'deny' ? 'dsm-mode-deny' : 'dsm-mode-allow',
            }
          }
          /**
           * 启动某一侧名单：生效 + 就地展开。同一模式内白/黑互斥 —— 启动一侧就把模式切过去，
           * **已勾选的名字保留**（只换语义），这样"改成黑名单"不用从头再勾一遍。
           */
          function startMode(id, mode) {
            // 刚被「关闭」掉的名字记在 stoppedRules 里：重新启用时带回，免得"关一下再开"把
            // 已勾好的名单清空（用户实测踩到：以为「关闭白名单」是收起设置，再启用就空了）。
            var prev = modeRule(id) || (modal.stoppedRules || {})[id]
            var names = prev && Array.isArray(prev.names) ? prev.names.slice() : []
            setModal(Object.assign({}, modal, {
              openMode: id, modeQuery: '',
              form: Object.assign({}, modal.form, {
                toolsByPreset: Object.assign({}, modal.form.toolsByPreset || {}, { [id]: { mode: mode, names: names } }),
              }),
            }))
          }
          function stopMode(id) {
            var prev = modeRule(id)
            var stopped = Object.assign({}, modal.stoppedRules || {})
            if (prev) stopped[id] = { mode: prev.mode, names: (prev.names || []).slice() }
            var next = Object.assign({}, modal.form.toolsByPreset || {})
            delete next[id]
            setModal(Object.assign({}, modal, {
              stoppedRules: stopped,
              openMode: modal.openMode === id ? null : modal.openMode,
              form: Object.assign({}, modal.form, { toolsByPreset: next }),
            }))
          }
          function toggleModeTool(id, name) {
            var rule = modeRule(id)
            if (!rule) return
            setModeRule(id, { mode: rule.mode, names: toggled(rule.names || [], name) })
          }
          /**
           * 展开后的勾选区：只列**该模式自己的**工具。这样勾出来的名字天然都属于这个预设，
           * 不会出现"在标准模式勾了只属于 PTC 的工具 → 换模式跑就启动失败"。
           * MCP 工具不在这里（用户裁定）：子代理照旧能用当前在跑的 MCP，那份名单在运行时并入。
           */
          function modeEditor(p) {
            var id = p.id
            var rule = modeRule(id)
            if (!rule) return null
            var all = modeTools(id)
            if (all === null || all.length === 0) {
              return React.createElement('div', { className: 'dsm-mode-body' },
                React.createElement('div', { className: 'dsm-pick-empty' }, p.broken ? t('subagents.mode.broken') : t('subagents.mode.noTools')))
            }
            var q = String(modal.modeQuery || '').trim().toLowerCase()
            var list = q ? all.filter(function (n) { return n.toLowerCase().indexOf(q) >= 0 }) : all
            var picked = rule.names || []
            // 与其余「全选」同一口径：全勾了就只给「取消全选」（二合一，不并列）。
            var allPickedAll = all.length > 0 && all.every(function (n) { return picked.indexOf(n) >= 0 })
            return React.createElement('div', { className: 'dsm-mode-body' },
              picked.length
                ? React.createElement('div', { className: 'dsm-tools-chips' }, picked.map(function (name) {
                    return React.createElement('span', { key: 'c:' + name, className: 'dsm-chip' + (rule.mode === 'deny' ? ' dsm-chip-deny' : '') },
                      name,
                      React.createElement('button', { type: 'button', title: t('subagents.tools.remove'), onClick: function () { toggleModeTool(id, name) } }, '×'))
                  }))
                : React.createElement('span', { className: 'dsm-adv-note' }, t(rule.mode === 'deny' ? 'subagents.mode.denyEmpty' : 'subagents.mode.allowEmpty')),
              React.createElement('div', { className: 'dsm-combo-row' },
                React.createElement('input', {
                  className: 'dsm-control',
                  value: modal.modeQuery || '',
                  placeholder: t('subagents.tools.filter'),
                  onChange: function (e) { setModal(Object.assign({}, modal, { modeQuery: e.target.value })) },
                }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk', disabled: busy, onClick: function () { setModeRule(id, { mode: rule.mode, names: allPickedAll ? [] : all.slice() }) } }, bulkPair(allPickedAll ? t('bulk.unselectAll') : t('bulk.selectAll'), allPickedAll ? t('bulk.selectAll') : t('bulk.unselectAll')))),
              list.length
                ? React.createElement('div', { className: 'dsm-tools-grid' }, list.map(function (name) {
                    return pickRow({ key: 'm:' + id + ':' + name, disabled: busy, checked: picked.indexOf(name) >= 0, name: name, onChange: function () { toggleModeTool(id, name) } })
                  }))
                : React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.mem.noMatch')))
          }
          /**
           * 工具限制的两段说明：先「哪一行生效」，再白/黑名单语义。
           * 两段是同一件事的两半，紧贴成一块 —— 分开渲染时中间隔着 12px 空行（用户 2026-09-18 指出）；
           * 后一段按条目清单渲染（一条一行，见 helpBullets）。
           */
          function modeNotes() {
            return React.createElement('div', null,
              React.createElement('p', { className: 'dsm-help' }, t('subagents.field.modes.hint')),
              helpBullets(t, 'subagents.adv.note'))
          }
          /**
           * 一行一个 Agent 预设（roster 顺序：标准 / PTC / 极简 / 创造 / 自建预设）。
           * 默认全部折叠、全部未启动；右侧两个按钮「启动 白名单」「启动 黑名单」互斥。
           */
          function modeRows() {
            var presets = (cand.presets || []).slice()
            if (!presets.length) {
              return React.createElement('div', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, t('subagents.field.modes')),
                React.createElement('div', { className: 'dsm-pick-empty' }, cand.loading ? t('memory.loading') : t('subagents.mode.noPresets')),
                modeNotes())
            }
            return React.createElement('div', { className: 'dsm-field' },
              React.createElement('span', { className: 'dsm-label' }, t('subagents.field.modes')),
              React.createElement('div', { className: 'dsm-modes' }, presets.map(function (p) {
                var id = p.id
                var rule = modeRule(id)
                var summary = modeSummary(id)
                var startButton = function (mode, isDeny) {
                  var active = !!rule && rule.mode === mode
                  return React.createElement('button', {
                    key: mode,
                    type: 'button',
                    className: 'dsm-btn dsm-btn-quiet' + (active ? (mode === 'deny' ? ' dsm-mode-btn-deny' : ' dsm-mode-btn-allow') : ''),
                    disabled: busy,
                    onClick: function () { if (active) stopMode(id); else startMode(id, mode) },
                  }, t(active
                    ? (isDeny ? 'subagents.mode.stopDeny' : 'subagents.mode.stopAllow')
                    : (isDeny ? 'subagents.mode.startDeny' : 'subagents.mode.startAllow')))
                }
                var open = modal.openMode === id
                return React.createElement('div', { className: 'dsm-mode-row' + (rule ? ' dsm-mode-on' : ''), key: id },
                  React.createElement('div', { className: 'dsm-mode-head' },
                    // 行首按钮 = 展开 / 收起名单（用户实测：已配好的模式只有「关闭白名单」可点，
                    // 点下去是把模式停掉、名单设置再也进不去 —— 查看/编辑与启用/停用必须分开）。
                    React.createElement('button', {
                      type: 'button',
                      className: 'dsm-mode-head-main',
                      disabled: !rule,
                      title: rule ? t('subagents.mode.toggleHint') : '',
                      'aria-expanded': open ? 'true' : 'false',
                      onClick: function () {
                        setModal(Object.assign({}, modal, { openMode: open ? null : id, modeQuery: '' }))
                      },
                    },
                      React.createElement('span', { className: 'dsm-mode-caret', 'aria-hidden': 'true' }, rule ? (open ? '▾' : '▸') : ''),
                      React.createElement('span', { className: 'dsm-mode-name' }, presetLabel(p)),
                      p.broken ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, t('compat.reach.broken')) : null,
                      React.createElement('span', { className: 'dsm-mode-sum ' + summary.cls }, summary.text)),
                    React.createElement('span', { className: 'dsm-mode-actions' },
                      startButton('allow', false),
                      startButton('deny', true))),
                  open ? modeEditor(p) : null)
              })),
              modeNotes())
          }
          /**
           * 旧格式（全局 `tools:` / `toolsDeny:`）的只读小结 + 转换入口。
           * 旧键对所有模式生效，运行时仍然照旧执行；**不点转换就不动文件里的旧键**。
           */
          function legacyNotice() {
            var allow = modal.form.tools || []
            var deny = modal.form.toolsDeny || []
            if (!allow.length && !deny.length) return null
            var presets = cand.presets || []
            var target = modal.legacyTarget || (presets[0] ? presets[0].id : '')
            return React.createElement('div', { className: 'dsm-legacy' },
              React.createElement('span', { className: 'dsm-adv-note' }, t('subagents.legacy.note', { allow: allow.length, deny: deny.length })),
              React.createElement('div', { className: 'dsm-combo-row' },
                React.createElement('div', { className: 'dsm-select' },
                  React.createElement('select', {
                    className: 'dsm-control',
                    value: target,
                    disabled: busy || !presets.length,
                    onChange: function (e) { setModal(Object.assign({}, modal, { legacyTarget: e.target.value })) },
                  }, presets.map(function (p) { return React.createElement('option', { key: p.id, value: p.id }, presetLabel(p)) }))),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || !target || !presets.length, onClick: function () {
                  var rule = { mode: allow.length ? 'allow' : 'deny', names: (allow.length ? allow : deny).slice() }
                  setModal(Object.assign({}, modal, {
                    openMode: target,
                    modeQuery: '',
                    legacyTarget: target,
                    form: Object.assign({}, modal.form, {
                      tools: [], toolsDeny: [],
                      toolsByPreset: Object.assign({}, modal.form.toolsByPreset || {}, { [target]: rule }),
                    }),
                  }))
                } }, t('subagents.legacy.convert'))),
              React.createElement('p', { className: 'dsm-help' }, t('subagents.legacy.hint')))
          }
          function toggleAdvanced() {
            if (!modal || modal.type !== 'editor') return
            var next = !modal.advanced
            setModal(Object.assign({}, modal, { advanced: next }))
            if (next) loadCandidates()
          }
          function submitEditor() {
            if (!modal || modal.type !== 'editor') return
            setBusy(true)
            var op = modal.mode === 'create' ? 'subagent-create' : 'subagent-update'
            // 编辑时名字可改：nextName 只在真的改过时才传（服务端按原名定位文件）。
            var renamed = modal.mode === 'edit' && modal.originalName && modal.originalName !== modal.form.name
            apiCall(op, {
              name: renamed ? String(modal.originalName) : modal.form.name,
              ...(renamed ? { nextName: String(modal.form.name || '').trim() } : {}),
              description: modal.form.description,
              provider: modal.form.provider, model: modal.form.model,
              catalogDepth: modal.form.catalogDepth,
              // 旧格式的全局名单原样回写（旧键不点转换就不动），新模式名单另存一块。
              tools: modal.form.tools || [], toolsDeny: modal.form.toolsDeny || [],
              toolsByPreset: modal.form.toolsByPreset || {},
              body: modal.form.body,
              output: modal.form.output || '',
            }).then(function (res) {
              setBusy(false)
              if (res && res.ok) { var sw = stateSyncWarn(t, res); setModal(null); setResult({ ok: !sw, warning: !!sw, text: t('subagents.result.saved', { name: modal.form.name }) + (sw ? ' ' + sw : '') }); refresh(true) }
              else setModal(Object.assign({}, modal, { form: Object.assign({}, modal.form, { error: translateError(t, res) }) }))
            }).catch(function (e) { setBusy(false); setModal(Object.assign({}, modal, { form: Object.assign({}, modal.form, { error: errMsg(e) }) })) })
          }
          function submitDelete(name) {
            setBusy(true)
            apiCall('subagent-delete', { name: name }).then(function (res) {
              setBusy(false); setModal(null)
              if (res && res.ok) { var sw = stateSyncWarn(t, res); setResult({ ok: !sw, warning: !!sw, text: t('subagents.result.deleted', { name: name }) + (sw ? ' ' + sw : '') }); refresh(true) }
              else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          // ── 导入人设（.md / .zip，多选或拖入；同名跳过并报告）──
          function submitImport(files) {
            if (!files || !files.length) return
            setBusy(true)
            apiCall('subagent-import', { files: files }).then(function (res) {
              setBusy(false)
              if (res && res.ok) {
                setModal(null)
                var names = res.imported || [], skipped = res.skipped || []
                var text = names.length ? t('subagents.result.imported', { count: names.length, names: names.join('、') }) : t('import.none')
                if (skipped.length) text += ' · ' + t('import.skipped', { items: skipped.map(function (s) { return s.name + '（' + s.reason + '）' }).join('；') })
                var sw = stateSyncWarn(t, res)
                if (sw) text += ' ' + sw
                setResult({ ok: !sw, warning: !!sw, text: text }); refresh(true)
              } else setResult({ ok: false, text: translateError(t, res) })
            }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) })
          }
          // 过滤只跟数据与（防抖后的）搜索词有关：每次渲染重扫一整份列表没有必要。
          // FLIP 的 key 仍是 `p.name`（过滤只改变"列表里有哪些"，不改变身份）。
          var visibleSubagents = React.useMemo(function () {
            return data.subagents.filter(function (p) { return matchPersonaQuery(p, dq) })
          }, [data.subagents, dq])
          // 「启用的排前面」（用户要求）：与过滤分开记忆 —— 只跟过滤结果有关，弹窗 / 结果提示条
          // 之类的状态变化不再重跑分区。FLIP 的 data-flip-on 仍来自 p.enabled，未动。
          var orderedSubagents = React.useMemo(function () {
            return enabledFirst(visibleSubagents, function (p) { return p.enabled !== false; })
          }, [visibleSubagents])
          var limitedCount = React.useMemo(function () {
            return data.subagents.filter(function (p) { return (p.tools && p.tools.length) || (p.toolsDeny && p.toolsDeny.length) || (p.toolsByPreset && Object.keys(p.toolsByPreset).length) }).length
          }, [data.subagents])
          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('subagents.title'))),
                React.createElement('p', { className: 'dsm-desc' }, t('subagents.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, busy || data.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: busy || data.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { openEditor(null) } }, t('subagents.new')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || anyLocked, onClick: function () { setResult(null); setModal({ type: 'import' }) } }, t('subagents.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy || !data.subagents.length, onClick: function () { setResult(null); setModal({ type: 'export' }) } }, t('export.subagents')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { loadTrash(false) } }, t('trash.btn.open')))),
            anyLocked === true ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('lock.banner')) : null,
            // 锁定期间不显示场景那条长句：开关全是灰的，"改动会同步写进档案"没有落点，
            // 两条并排还会互相矛盾（用户 2026-09-19）。
            (anyLocked !== true && sceneName) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('scene.switch.banner', { scene: sceneName })) : null,
            React.createElement('div', { className: 'dsm-summary', style: { '--dsm-stat-cols': '2' } },
              [['total', data.subagents.length, t('subagents.stat.total')],
                ['limited', limitedCount, t('subagents.stat.limited')]].map(function (item) {
                return React.createElement('div', { key: item[0], className: 'dsm-stat' },
                  React.createElement('strong', null, item[1]), item[2])
              })),
            // 搜索框：统计条之后（与 MCP / 技能 / 记忆 / 提示词页同一位置与样式）。
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', {
                className: 'dsm-control dsm-search', value: query, 'aria-label': t('search'),
                placeholder: t('subagents.search.placeholder'),
                onChange: function (e) { setQuery(e.target.value) },
              })),
            React.createElement(Notice, { kind: result && result.warning ? 'warn' : result && result.ok ? 'ok' : 'err', text: result && result.text }),
            // 走 Notice 而不是裸 div：令牌没过的提醒会在右侧自动多出一颗「填写令牌」按钮。
            data.error ? React.createElement(Notice, { kind: 'err', text: String(data.error) }) : null,
            // 注册失败的工具（`subagent_manager_list` / `_run`）：模型侧只会「查无此工具」，
            // 这条横幅是用户唯一能看到的地方。名字与原因来自服务端，句子在这里按当前语言拼。
            (data.toolFailures || []).length ? React.createElement(Notice, {
              kind: 'warn',
              text: t('subagents.toolFailed', {
                names: (data.toolFailures || []).map(function (f) { return f.name }).join('、'),
                reason: String(((data.toolFailures || [])[0] || {}).reason || ''),
              }),
            }) : null,
            data.loading && !data.subagents.length ? React.createElement('div', { className: 'dsm-empty' }, t('memory.loading'))
              : !data.subagents.length ? React.createElement('div', { className: 'dsm-empty' }, t('subagents.empty'))
                : !visibleSubagents.length ? React.createElement('div', { className: 'dsm-empty' }, t('subagents.empty.search'))
                  : React.createElement('div', { className: 'dsm-sources', ref: flipRef }, orderedSubagents.map(function (p) {
                return React.createElement('div', { key: p.name, className: 'dsm-source', 'data-flip-key': p.name, 'data-flip-on': p.enabled !== false ? '1' : '0' },
                  React.createElement('div', { className: 'dsm-source-head' },
                    React.createElement('div', { className: 'dsm-source-head-main' },
                      React.createElement('span', { className: 'dsm-source-title', title: p.name }, p.name),
                      React.createElement('span', { className: 'dsm-note' }, p.description || ''),
                      p.enabled === false ? React.createElement('span', { className: 'dsm-tag', title: t('subagents.disabled.hint') }, t('subagents.disabled')) : null),
                    React.createElement('div', { className: 'dsm-source-actions' },
                      React.createElement(Switch, { on: p.enabled !== false, disabled: busy || anyLocked, label: t('subagents.toggle') + ' ' + p.name, onClick: function () { togglePersona(p) } }),
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy || anyLocked, onClick: function () { openEditor(p.name) } }, t('memory.edit')),
                      React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy || anyLocked, onClick: function () { setModal({ type: 'delete', name: p.name }) } }, t('memory.delete')))))
              })),
            modal && modal.type === 'editor' ? React.createElement(Modal, { key: 'sedit', wide: true, title: modal.mode === 'create' ? t('subagents.create') : t('subagents.edit') + ' · ' + modal.form.name, closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('div', { className: 'dsm-form' },
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.name')),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.name || '', placeholder: 'code-review', onChange: function (e) { setForm({ name: e.target.value }) } })),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.description')),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.description || '', placeholder: t('subagents.field.description.placeholder'), onChange: function (e) { setForm({ description: e.target.value }) } })),
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.body')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: modal.form.body || '', placeholder: t('subagents.field.body.placeholder'), onChange: function (e) { setForm({ body: e.target.value }) } })),
                // 输出要求（frontmatter `output:`，一条一行）：单独成节写进子代理的系统提示词。
                // 与正文分开是有意的 —— 正文是"这个角色是什么"（散文），这里放"产出必须长什么样"
                // （可检验的硬要求）。混在一起时散文会把硬要求稀释成风格提示（用户实测）。
                React.createElement('label', { className: 'dsm-field' },
                  React.createElement('span', { className: 'dsm-label' }, t('subagents.field.output')),
                  React.createElement('textarea', { className: 'dsm-control dsm-textarea-md', value: modal.form.output || '', placeholder: t('subagents.field.output.placeholder'), onChange: function (e) { setForm({ output: e.target.value }) } }),
                  React.createElement('p', { className: 'dsm-help' }, t('subagents.field.output.hint'))),
                // ── 高级选项（默认收起）──
                // 模型 / 工具限制是「少数人才改」的字段，但一旦改错代价高（跨来源模型、工具名打错
                // 会让子代理直接启动失败）。所以：收起来但**有值就自动展开**，并把候选做成选择器。
                React.createElement('div', { className: 'dsm-adv' },
                  React.createElement('button', { type: 'button', className: 'dsm-adv-head', 'aria-expanded': modal.advanced === true, onClick: toggleAdvanced },
                    React.createElement('span', { className: 'dsm-adv-caret' }, modal.advanced ? '▼' : '▶'),
                    React.createElement('span', null, t('subagents.adv.title')),
                    React.createElement('span', { className: 'dsm-adv-note' },
                      modal.advanced ? '' : t('subagents.adv.summary', {
                        model: modal.form.model ? (modal.form.provider ? modal.form.provider + '/' + modal.form.model : modal.form.model) : t('subagents.adv.inherit'),
                        depth: catalogDepthLabel(typeof modal.form.catalogDepth === 'number' ? modal.form.catalogDepth : 1),
                        modes: Object.keys(modal.form.toolsByPreset || {}).length,
                        allow: (modal.form.tools || []).length,
                        deny: (modal.form.toolsDeny || []).length,
                      }))),
                  modal.advanced ? React.createElement('div', { className: 'dsm-adv-body' },
                    // 模型：宿主 LLM 目录里的 (provider, model) 对 + 自定义兜底。
                    React.createElement('div', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, t('subagents.field.model')),
                      React.createElement('div', { className: 'dsm-combo-row' },
                        React.createElement('div', { className: 'dsm-select' },
                          React.createElement('select', {
                            className: 'dsm-control',
                            value: modelSelectValue(),
                            disabled: busy || cand.loading,
                            onChange: function (e) {
                              var v = e.target.value
                              if (v === '') setForm({ provider: '', model: '' })
                              else if (v !== '__custom__') {
                                var parts = v.split('\u0000')
                                setForm({ provider: parts[0], model: parts[1] })
                              } else setForm({ model: modal.form.model || '' })
                            },
                          },
                            React.createElement('option', { value: '' }, t('subagents.model.inherit')),
                            (cand.models || []).map(function (m) {
                              return React.createElement('option', { key: m.provider + '/' + m.id, value: m.provider + '\u0000' + m.id }, m.provider + ' · ' + m.name)
                            }),
                            React.createElement('option', { value: '__custom__' }, t('subagents.model.customOption')))),
                        modelSelectValue() === '__custom__'
                          ? React.createElement('input', { className: 'dsm-control', value: modal.form.model || '', placeholder: t('subagents.field.model.placeholder'), onChange: function (e) { setForm({ model: e.target.value }) } })
                          : null),
                      React.createElement('p', { className: 'dsm-help' }, cand.loading ? t('memory.loading') : t('subagents.field.model.hint'))),
                    // provider 独立成一项：跨来源模型（如 sensenova）需要 provider+model 两个键同时给。
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, t('subagents.field.provider')),
                      React.createElement('input', { className: 'dsm-control', value: modal.form.provider || '', placeholder: t('subagents.field.provider.placeholder'), onChange: function (e) { setForm({ provider: e.target.value }) } }),
                      React.createElement('p', { className: 'dsm-help' }, t('subagents.field.provider.hint'))),
                    // 目录注入深度：人设目录注入到哪些会话（默认 1 = 只在顶层）。用下拉而不是数字
                    // 输入：只有 1/2/3 三个有意义的档，手写数字写错要到注入时才暴露。
                    //
                    // ⚠️ 它**不是**递归上限。2026-09-17 用户实测后改名（原名 maxDepth /「委派预算」）：
                    // 官方 `dsh-tool-subagent` 默认 `maxDepth: 3`，子代理本来就能继续嵌套，本插件
                    // 也不再向官方传 maxDepth。这个字段只决定常驻目录出现在哪些深度的会话里。
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, t('subagents.field.catalogDepth')),
                      React.createElement('div', { className: 'dsm-select' },
                        React.createElement('select', {
                          className: 'dsm-control',
                          value: String(typeof modal.form.catalogDepth === 'number' ? modal.form.catalogDepth : 1),
                          disabled: busy,
                          onChange: function (e) { setForm({ catalogDepth: Number(e.target.value) }) },
                        }, [1, 2, 3, CATALOG_DEPTH_UNLIMITED].map(function (n) {
                          // 选项文字不带序号：前面再加一个「2 ·」是同一件事说两遍（用户 2026-09-17
                          // 指出）。下拉的 value 仍是数字，存的还是 catalogDepth 本身。
                          return React.createElement('option', { key: n, value: String(n) }, catalogDepthLabel(n))
                        }))),
                      helpBullets(t, 'subagents.field.catalogDepth.hint')),
                    // 工具限制：按 Agent 预设一行一个模式（默认全折叠、全部未启动，白/黑互斥）。
                    // 旧格式的全局名单（老文件 / 别处导入）在这里只读呈现，点「转换」才搬进某个模式。
                    legacyNotice(),
                    modeRows(),
                    cand.error ? React.createElement('div', { className: 'dsm-feedback dsm-warning' }, String(cand.error)) : null)
                    : null),
                modal.form.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, String(modal.form.error)) : null),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy || (modal.mode === 'create' && !String(modal.form.name || '').trim()) || !String(modal.form.body || '').trim(), onClick: submitEditor }, t('memory.btn.save')))) : null,
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'sdel2', title: t('subagents.delete.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('subagents.delete.desc', { name: modal.name })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { submitDelete(modal.name) } }, t('memory.btn.delete.confirm')))) : null,
            modal && modal.type === 'import' ? React.createElement(ImportModal, { key: 'simp', t: t, title: t('subagents.import.title'), busy: busy, requirements: [t('upload.requirement.persona.1'), t('upload.requirement.persona.2'), t('upload.requirement.persona.3')], onClose: function () { setModal(null) }, onSubmit: submitImport }) : null,
            modal && modal.type === 'export' ? React.createElement(ExportModal, {
              key: 'export', t: t, title: t('export.subagents'),
              items: data.subagents.map(function (p) { return { key: p.name, name: p.name, desc: p.description || '' } }),
              busy: busy, result: result,
              onClose: function () { setResult(null); setModal(null) },
              onSubmit: function (names, outDir) {
                setBusy(true); setResult(null);
                apiCall('bundle-export', { kind: 'subagents', names: names, outDir: outDir }).then(function (res) {
                  setBusy(false);
                  if (res && res.ok) setResult({ ok: true, text: exportResultText(t, res) });
                  else setResult({ ok: false, text: translateError(t, res) });
                }).catch(function (e) { setBusy(false); setResult({ ok: false, text: errMsg(e) }) });
              },
            }) : null,
            trash ? React.createElement(TrashModal, {
              t: t,
              title: t('trash.title'),
              groupTitle: t('trash.group.agents'),
              groupSub: t('trash.section.agents.sub'),
              locked: anyLocked,
              entries: trash.entries,
              loading: trash.loading,
              error: trash.error,
              busy: trashBusy,
              onClose: function () { setTrash(null) },
              onRestore: restorePersona,
              onPurge: purgePersona,
            }) : null)
        }

        /**
         * 记忆页的视图（按场景分桶 + 过滤 + 排序）。
         *
         * 提到组件外是为了能被 `useMemo` 包住：这段要遍历全部记忆并逐桶排序，而本页的
         * 编辑器弹窗每敲一个字都会重渲染整页（`editor` 是页内 state）。传进来的 `q` 已防抖。
         */
        function memoryView(data, q, sceneFilter) {
          function matchRule(r) {
            if (sceneFilter !== '' && sceneOfGroup(r.group) !== sceneFilter) return false
            if (!q) return true
            return (r.name || '').toLowerCase().indexOf(q) >= 0
              || (r.description || '').toLowerCase().indexOf(q) >= 0
              || (r.group || '').toLowerCase().indexOf(q) >= 0
          }
          // 场景 → 记忆：场景元数据来自宿主 scenes（含**空场景**与保留场景 global），
          // 记忆按一级目录归位。没有归属场景的记忆（直接放在 memories/ 根层）也单独列出来，
          // 并在体检里报 noScene —— 不能让它既不在列表里、也不在提示词里。
          var buckets = {}
          var order = []
          function ensureBucket(name, meta) {
            if (!buckets[name]) { buckets[name] = { name: name, meta: meta, rules: [] }; order.push(name) }
            else if (meta && !buckets[name].meta) buckets[name].meta = meta
            return buckets[name]
          }
          ;(data.scenes || []).forEach(function (s) { ensureBucket(s.name, s) })
          data.rules.forEach(function (r) {
            var g = String(r.group == null ? '' : r.group)
            var b = ensureBucket(g === '' ? '' : sceneOfGroup(g), null)
            if (matchRule(r)) b.rules.push(r)
          })
          order.sort(function (a, b) {
            if (a === b) return 0
            var am = buckets[a].meta, bm = buckets[b].meta
            // 宿主给的 order（保留场景 global = 0，恒在最前）；无元数据的游离桶排最后。
            var ao = am && typeof am.order === 'number' ? am.order : 1e9
            var bo = bm && typeof bm.order === 'number' ? bm.order : 1e9
            if (ao !== bo) return ao - bo
            if (a === '') return 1
            if (b === '') return -1
            return String(a).localeCompare(String(b))
          })
          var sceneOptions = [{ value: '', label: t('memory.filter.all') }].concat(
            order.map(function (n) { return { value: n, label: sceneLabel(data.scenes, n) } }))
          // 场景选择：保留场景「全局」排最前（它是真实场景，不是「留空」）；
          // 游离桶只在真的存在游离记忆时才出现。
          var sceneChoices = order.map(function (n) { return { value: n, label: sceneLabel(data.scenes, n) } })
          // 空场景（含刚「新建场景」建好的空目录）必须列出来：否则它在页面上直接消失，
          // 卡片上的「新建记忆」入口也就点不到（只能靠顶部按钮再手填场景名）。
          // 只在搜索 / 场景筛选生效时按命中收敛，避免空卡片噪音。
          var filtering = q !== '' || sceneFilter !== ''
          var visibleBuckets = order.filter(function (n) {
            if (sceneFilter !== '' && n !== sceneFilter) return false
            if (!filtering) return true
            return buckets[n].rules.length > 0 || sceneFilter === n
          })
          return {
            buckets: buckets, order: order, sceneOptions: sceneOptions, sceneChoices: sceneChoices,
            filtering: filtering, visibleBuckets: visibleBuckets, hasAnyRule: data.rules.length > 0,
          }
        }