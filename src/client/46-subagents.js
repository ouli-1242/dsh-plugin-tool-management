        // ---------- 子智能体页：人设文件（~/.dsh/subagents/*.md）管理 ----------
        /**
         * 「思考强度」档位的按 (provider, model) 缓存。
         *
         * 为什么放在**组件外**：放进组件里每次渲染都会重建，等于没有缓存，而档位清单要问
         * adapter（`llm.resolveModelInfo`，异步、可能联网）—— 编辑人设时来回切模型不该每次都问。
         * TTL 5 分钟：档位是模型能力声明，短时间内不会变；换模型时才重新问。
         */
        var EFFORT_CACHE_TTL_MS = 5 * 60 * 1000
        var effortCacheByRoute = {}
        function readEffortCache(key) {
          var hit = effortCacheByRoute[key]
          if (!hit) return null
          if (Date.now() - hit.at > EFFORT_CACHE_TTL_MS) { delete effortCacheByRoute[key]; return null }
          return hit.value
        }
        function writeEffortCache(key, value) { effortCacheByRoute[key] = { at: Date.now(), value: value } }
        function SubagentsPage() {
          var state = React.useState({ loading: true, error: null, subagents: [] })
          var data = state[0], setData = state[1]
          var bs = React.useState(false)
          var busy = bs[0], setBusy = bs[1]
          var rs = React.useState(null)
          var result = rs[0], setResult = rs[1]
          var ms = React.useState(null)
          var modal = ms[0], setModal = ms[1]
          /**
           * 「思考强度」的加载状态。key = 已拉取/正在拉取的 `provider\0model`（空串 = 还没选模型）。
           * 与 `cands` 分开两个 state：档位是**按模型**懒加载的，而候选目录是一次性拉的，
           * 混在一起会让"切换模型"误触发整份候选重拉。
           */
          var es = React.useState({ key: '', loading: false, error: null, efforts: [], defaultEffort: null })
          var eff = es[0], setEff = es[1]
          /** 换模型导致已存档位被清掉时的一次性提示（下次换模型或关弹窗即消失）。 */
          var ens = React.useState(null)
          var effNotice = ens[0], setEffNotice = ens[1]
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
          var cands = React.useState({ loaded: false, loading: false, error: null, models: [], providers: [], tools: [], presets: [] })
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
                // providers 是去重后的来源清单，**不能**由 models 去重反推：适配器不提供
                // listModels 时该来源一个模型都报不出来，而"来源有、目录里没模型"正是最需要
                // 手填模型 id 的场景 —— 反推会让这类来源在「模型来源」下拉里整个消失。
                providers: (mres && mres.providers) || [],
                tools: (tres && tres.tools) || [],
                // presets 必须原样带过来：四行模式的名字、顺序、每行的工具清单全靠它，
                // 早先这里只留 models/tools，于是分组标题退回裸 id（中文界面里显示英文）。
                presets: (tres && tres.presets) || [],
              })
            }).catch(function (e) {
              setCand({ loaded: true, loading: false, error: errMsg(e), models: [], providers: [], tools: [], presets: [] })
            })
          }
          /**
           * 拉取某个 (provider, model) 的思考强度档位。**只有真正展开了高级选项、且选了模型**才会
           * 被调到（三个调用点：展开高级选项、模型下拉变更、自定义模型输入失焦）。
           *
           * 两个语义要点（都来自官方源码，见 src/subagents/service.ts 的 `reasoningEffort` 注释）：
           *   · 档位跟模型走 —— 换模型必须重拉，旧清单对新模型无效；
           *   · **拉取失败一律不动已存的值**：只有"成功且当前值不在清单里"才清档。否则一次网络
           *     抖动就把用户设置抹了，而失败本身已经有提示。
           */
          function loadEfforts(provider, model) {
            setEffNotice(null)
            var pv = String(provider || ''), md = String(model || '')
            if (!pv || !md) { setEff({ key: '', loading: false, error: null, efforts: [], defaultEffort: null }); return }
            var key = pv + '\u0000' + md
            var cached = readEffortCache(key)
            if (cached) {
              setEff({ key: key, loading: false, error: cached.ok ? null : cached.error, efforts: cached.efforts || [], defaultEffort: cached.defaultEffort || null })
              if (cached.ok) dropEffortIfGone(cached.efforts || [])
              return
            }
            setEff({ key: key, loading: true, error: null, efforts: [], defaultEffort: null })
            apiCall('model-reasoning', { provider: pv, model: md }).then(function (res) {
              var value = res && res.ok !== false
                ? { ok: true, efforts: res.efforts || [], defaultEffort: res.defaultEffort || null }
                : { ok: false, error: (res && res.error) || t('subagents.effort.unavailable'), efforts: [], defaultEffort: null }
              writeEffortCache(key, value)
              setEff({ key: key, loading: false, error: value.ok ? null : value.error, efforts: value.efforts, defaultEffort: value.defaultEffort })
              if (value.ok) dropEffortIfGone(value.efforts)
            }).catch(function (e) {
              var value = { ok: false, error: errMsg(e), efforts: [], defaultEffort: null }
              writeEffortCache(key, value)
              setEff({ key: key, loading: false, error: value.error, efforts: [], defaultEffort: null })
            })
          }
          /**
           * 自动清档：清单里没有当前存的那一档 → 清掉并给一次性提示。
           *
           * 为什么必须清：官方对**不支持**的显式档位是在 provider I/O 之前直接拒（不夹紧、不别名），
           * 留着它 = 下一次委派直接起不来，而错误要到那时才看得见。
           * 为什么只在"拉取成功"时判断：失败时清单是空的，拿空清单当"没有这一档"会把设置误清。
           */
          function dropEffortIfGone(list) {
            if (!modal || modal.type !== 'editor') return
            var cur = String(modal.form.reasoningEffort || '')
            if (!cur) return
            var has = (list || []).some(function (e) { return String(e && e.id) === cur })
            if (has) return
            setEffNotice(t('subagents.effort.dropped', { effort: cur }))
            setForm({ reasoningEffort: '' })
          }
          /** 当前表单的 (provider, model) 路由键 —— 用来与 `eff.key` 比，确认清单属于当前模型。 */
          function currentRouteKey() {
            return String((modal && modal.form.provider) || '') + '\u0000' + String((modal && modal.form.model) || '')
          }
          /**
           * 当前模型**已就绪**的档位。未就绪一律返回空数组：切换模型后 `eff` 里还留着上一个模型的
           * 清单（新请求还没回来），照它渲染会让用户选中一个不属于这个模型的档位 —— 而官方对不支持的
           * 档位是直接拒，等于埋一次"委派起不来"。
           */
          function currentEfforts() {
            if (!modal || !modal.form.model || eff.loading || eff.error) return []
            return eff.key === currentRouteKey() ? (eff.efforts || []) : []
          }
          /** 空档（不指定）那一行的悬停说明：把 adapter 给的默认档位名字显示出来（拿不到就不显示）。 */
          function defaultEffortTitle() {
            var id = eff.defaultEffort
            if (!id || eff.key !== currentRouteKey()) return undefined
            var hit = (eff.efforts || []).filter(function (e) { return String(e && e.id) === String(id) })[0]
            return hit ? String(hit.name || hit.id) : String(id)
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
            // 允许追问同理：它改变的是"下一次委派会怎么跑"（回执一个 id 而不是产出），
            // 藏在收起的高级选项里等于用户改过又忘了自己改过。
            var continuable = !!(p && p.continuable === true)
            // 思考强度同理：配过就得让人看得见 —— 它是"下一次委派会怎么跑"的一部分，
            // 藏在收起的高级选项里等于用户改过又忘了自己改过。
            return !!(budget || continuable || (p && (p.model || p.provider || p.reasoningEffort)) || (p && ((p.tools || []).length || (p.toolsDeny || []).length || modes)))
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
              setModal({ type: 'editor', mode: 'create', advanced: false, openMode: null, stoppedRules: {}, modeQuery: '', legacyTarget: '', form: { name: '', description: '', provider: '', model: '', reasoningEffort: '', catalogDepth: 1, continuable: false, tools: [], toolsDeny: [], toolsByPreset: {}, body: '', output: '', error: null } })
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
                  // 思考强度：服务端回空串 = 这份人设没指定（不是"没有档位"）。空值不落盘，见 serializePersona。
                  reasoningEffort: p.reasoningEffort || '',
                  // 服务端回的是**生效值**（没写就是默认 1），所以这里不必再兜默认。
                  catalogDepth: typeof p.catalogDepth === 'number' ? p.catalogDepth : 1,
                  // 服务端回布尔；老服务端不带这个字段时按 false（一次性）算。
                  continuable: p.continuable === true,
                  tools: (p.tools || []).slice(), toolsDeny: (p.toolsDeny || []).slice(),
                  toolsByPreset: cloneRules(p.toolsByPreset), body: p.body || '', output: p.output || '', error: null,
                } })
                // 已配过限制的人设**一打开就是展开的**（initialAdvanced）→ 候选数据必须在这里也拉，
                // 否则四行模式先亮"宿主没有回传预设名单"，非得点两次「高级选项」才补上（用户实测）。
                // 思考强度同理：展开着就要有档位清单（它按模型懒加载，所以这里显式带上 model）。
                if (advanced) { loadCandidates(); loadEfforts(p.provider, p.model) }
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
           * 模型下拉的当前值：`provider\0model` 复合键（与每个选项的 value 同构）。
           *
           * 目录里查不到这对 (来源, 模型) 时也**照原样给**，靠 `offCatalogModel()` 那条额外选项
           * 显示出来。0.19.0 之前这里会退回一个「自定义 / 目录里没有…」菜单项并把输入框露出来，
           * 2026-10-07 用户裁定删掉整条手填通道：来源与模型都只从宿主目录里选。
           */
          function modelSelectValue() {
            if (!modal || modal.type !== 'editor') return ''
            var f = modal.form
            if (!f.model) return ''
            return String(f.provider || '') + '\u0000' + String(f.model)
          }
          /**
           * 存的 (来源, 模型) **不在**宿主目录里时，返回 `modelSelectValue()` 的那个值（多列一条
           * 只读选项用）；在目录里、或模型为空时返回 ''。
           *
           * 为什么必须有这一条：0.19.0 之前这两个字段是纯文本框，现存人设里就有目录外的值；
           * 下拉里找不到对应项时浏览器会显示第一项（「继承主会话」）—— **表单在说谎**，而保存时
           * 又把那个看不见的值写回去。多列一条带标记的选项，值就永远看得见。
           */
          function offCatalogModel() {
            if (!modal || modal.type !== 'editor') return ''
            var f = modal.form
            if (!f.model) return ''
            var provider = String(f.provider || '')
            var hit = (cand.models || []).filter(function (m) { return m.provider === provider && m.id === f.model })[0]
            return hit ? '' : modelSelectValue()
          }
          /** 「模型来源」下拉的当前值 —— 就是存的来源本身（目录外的靠 `offCatalogProvider()` 显示）。 */
          function providerSelectValue() {
            if (!modal || modal.type !== 'editor') return ''
            return String(modal.form.provider || '')
          }
          /** 存的来源不在宿主目录里时返回它（多列一条只读选项用）；在目录里或为空返回 ''。 */
          function offCatalogProvider() {
            if (!modal || modal.type !== 'editor') return ''
            var v = String(modal.form.provider || '')
            if (!v) return ''
            var hit = (cand.providers || []).filter(function (p) { return p.id === v })[0]
            return hit ? '' : v
          }
          /**
           * 目录这次**真的读到了**吗。
           *
           * 「目录里没有」是一句断言，只有读成功才配说：读失败（`cand.error`）时清单是空的，
           * 照断言会把"没读到"说成"不存在"。读不到时那条额外选项仍然渲染，只是不带标记。
           */
          function catalogReady() {
            return !!(cand.loaded && !cand.loading && !cand.error)
          }
          /**
           * 来源下拉的选项文字：显示名与 id 不同时两个都给（`DeepSeek · deepseek`）——
           * 显示名给人看，id 是真正写进 frontmatter 的那个键，只给一个都算缺信息。
           */
          function providerLabel(p) {
            var id = String((p && p.id) || '')
            var name = String((p && p.name) || '')
            return name && name !== id ? name + ' · ' + id : id
          }
          /**
           * 模型下拉要列哪些模型：**来源选定后只列该来源的**（用户 2026-10-07）。
           * 不按来源收窄时，一份几十条的扁平列表里选错来源是常态，而错配的 (来源, 模型) 要到
           * 子代理真正启动时才由官方报错 —— 那时人已经在别的页面了。
           * 来源留空则列全部：此时挑中哪一条，就把它的来源一并填上（见 onChange）。
           */
          function modelOptions() {
            if (!modal || modal.type !== 'editor') return []
            var all = cand.models || []
            var p = modal.form.provider || ''
            if (!p) return all
            return all.filter(function (m) { return m.provider === p })
          }
          /** 模型选项文字：已按来源收窄时不再重复来源前缀（左边那一格就是来源）。 */
          function modelOptionLabel(m) {
            var narrowed = !!(modal && modal.type === 'editor' && modal.form.provider)
            return narrowed ? String((m && (m.name || m.id)) || '') : m.provider + ' · ' + m.name
          }
          /**
           * 「高级选项」收起态**第二行**的内容；返回 null = 这一行整个不出现。
           * 只有真配了工具限制才报：收起态挂一句「模式限制：0 项；旧格式：白名单 0 / 黑名单 0」
           * 是用一行废话占位置（用户 2026-10-07 指出）。
           */
          function advLimitLine() {
            if (!modal || modal.type !== 'editor') return null
            var modes = Object.keys(modal.form.toolsByPreset || {}).length
            var allow = (modal.form.tools || []).length
            var deny = (modal.form.toolsDeny || []).length
            if (!modes && !allow && !deny) return null
            return t('subagents.adv.summary2', {
              modes: modes,
              // 旧格式只在有值时报；分隔号写在词典值里（见 adv.summary 的 tail）。
              tail: (allow || deny) ? t('subagents.adv.legacy', { allow: allow, deny: deny }) : '',
            })
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
          /**
           * 该模式下可勾选的工具名 + 每个名字的归属组。
           * `null` = 宿主没给出该模式的清单（读不到，不能假装是空）。
           *
           * `groups` 缺项（老服务端没这个字段）时按 `other` 处理 —— 落错组只是位置不对，
           * 丢掉就是"界面上勾不到"，那是静默降级。
           */
          function modeTools(id) {
            var hit = (cand.presets || []).filter(function (p) { return p.id === id })[0]
            if (!hit || !Array.isArray(hit.tools)) return null
            return { names: hit.tools, groups: hit.toolGroups || {} }
          }
          /** 三组的固定顺序：本插件 → 官方 → 其他。顺序即语义，别按字典序排。 */
          var TOOL_ORIGINS = ['plugin', 'official', 'other']
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
           * 展开后的勾选区：只列**该模式自己的**工具，并按归属分三段
           * （插件工具 / 官方工具 / 其他工具）。这样勾出来的名字天然都属于这个预设，
           * 不会出现"在标准模式勾了只属于 PTC 的工具 → 换模式跑就启动失败"。
           * MCP 工具不在这里（用户裁定）：子代理照旧能用当前在跑的 MCP，那份名单在运行时并入。
           *
           * 分组只是地标，**不改变勾选语义**：三段共用一个 `picked`，「全选 / 取消全选」仍跨组
           * 对整份清单生效；空组不渲染，筛选后为空的组也不渲染。地标复用 `segGroup`（左内缩与
           * `.dsm-pick` 同为 8px，天然对齐，所以不新增样式）。
           *
           * ⚠️ 分组买的是「一眼看出这是谁的东西」，不是「更快找到某个工具」—— 后者是上面那个
           * 筛选框的活，分组不减少滚动量。
           */
          function modeEditor(p) {
            var id = p.id
            var rule = modeRule(id)
            if (!rule) return null
            var view = modeTools(id)
            var all = view ? view.names : null
            if (all === null || all.length === 0) {
              return React.createElement('div', { className: 'dsm-mode-body' },
                React.createElement('div', { className: 'dsm-pick-empty' }, p.broken ? t('subagents.mode.broken') : t('subagents.mode.noTools')))
            }
            var q = String(modal.modeQuery || '').trim().toLowerCase()
            var list = q ? all.filter(function (n) { return n.toLowerCase().indexOf(q) >= 0 }) : all
            var picked = rule.names || []
            // 与其余「全选」同一口径：全勾了就只给「取消全选」（二合一，不并列）。
            var allPickedAll = all.length > 0 && all.every(function (n) { return picked.indexOf(n) >= 0 })
            // 按归属切段。认不出的归属（服务端没给这一项，或给了个没见过的值）一律落「其他」——
            // 落错组只是位置不对，丢掉就是"界面上勾不到"。
            var byOrigin = { plugin: [], official: [], other: [] }
            list.forEach(function (name) {
              var origin = view.groups[name]
              byOrigin[origin === 'plugin' || origin === 'official' ? origin : 'other'].push(name)
            })
            var grid = []
            TOOL_ORIGINS.forEach(function (origin) {
              var names = byOrigin[origin]
              if (!names.length) return
              grid.push(segGroup(t('subagents.tools.group.' + origin)))
              names.forEach(function (name) {
                grid.push(pickRow({ key: 'm:' + id + ':' + name, disabled: busy, checked: picked.indexOf(name) >= 0, name: name, onChange: function () { toggleModeTool(id, name) } }))
              })
            })
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
                ? React.createElement('div', { className: 'dsm-tools-grid' }, grid)
                : React.createElement('div', { className: 'dsm-pick-empty' }, t('scenes.mem.noMatch')))
          }
          /**
           * 一行一个 Agent 预设（roster 顺序：标准 / PTC / 极简 / 创造 / 自建预设）。
           * 默认全部折叠、全部未启动；右侧两个按钮「启动 白名单」「启动 黑名单」互斥。
           *
           * 不再自带标题与说明（0.19.0 重排）：标题由所在分组头承担（`subagents.adv.group.tools`），
           * 白/黑名单语义与「MCP 工具不在候选里」那一行移到分组头正下方。这两句原先挂在字段尾巴上，
           * 叠上另外几处提示后，展开态读起来是一堵墙（用户 2026-10-07 指出）。
           */
          function modeRows() {
            var presets = (cand.presets || []).slice()
            if (!presets.length) {
              return React.createElement('div', { className: 'dsm-pick-empty' }, cand.loading ? t('memory.loading') : t('subagents.mode.noPresets'))
            }
            return React.createElement('div', null,
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
              })))
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
            if (next) {
              loadCandidates()
              // 档位清单与候选目录**分开拉**：候选是本地目录（一次性），档位要问 adapter
              // （按模型、可能联网），所以这里用表单里当前的模型去拉；没选模型就什么都不发。
              loadEfforts(modal.form.provider, modal.form.model)
            }
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
              continuable: modal.form.continuable === true,
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
                    React.createElement('div', { className: 'dsm-source-head-main dsm-persona-main' },
                      React.createElement('div', { className: 'dsm-persona-name-row' },
                        React.createElement('span', { className: 'dsm-source-title', title: p.name }, p.name),
                        // 两个状态都给胶囊：以前只在停用时挂标签，启用的一行什么都不留，
                        // 用户没法一眼看出「没标签 = 启用」。
                        p.enabled === false
                          ? React.createElement(StatusTag, { tone: 'muted', text: t('subagents.disabled'), title: t('subagents.disabled.hint') })
                          : React.createElement(StatusTag, { tone: 'ok', text: t('subagents.enabled') })),
                      // 没有描述就不渲染这一行：空 div 仍占一行行高，行会变成一条无内容的空隙。
                      p.description ? React.createElement('div', { className: 'dsm-persona-desc', title: p.description }, p.description) : null),
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
                  // 描述会整段进「可委派的子智能体」目录，上限就是注入侧的截断长度（`CATALOG_DESC_MAX`）；
                  // 存量人设的超长描述标红（服务端不校验这个长度，只有注入时截）。
                  React.createElement('div', { className: 'dsm-budget-meta' },
                    React.createElement('span', { className: 'dsm-label' }, t('subagents.field.description')),
                    React.createElement('span', { className: 'dsm-char-count' + (String(modal.form.description || '').length > CATALOG_DESC_MAX ? ' dsm-char-over' : '') }, String(modal.form.description || '').length + ' / ' + CATALOG_DESC_MAX)),
                  React.createElement('input', { className: 'dsm-control', value: modal.form.description || '', maxLength: CATALOG_DESC_MAX, placeholder: t('subagents.field.description.placeholder'), onChange: function (e) { setForm({ description: e.target.value }) } })),
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
                    React.createElement('span', { className: 'dsm-adv-title' }, t('subagents.adv.title')),
                    modal.advanced ? null : React.createElement('span', { className: 'dsm-adv-note dsm-adv-sum' },
                      // 摘要**最多两行，且只报有值的那几项**（用户 2026-10-07 定稿）：
                      // 第一行是"下一次委派会怎么跑"（模型 / 思考强度 / 允许追问），
                      // 第二行是工具限制的存量 —— 一项都没有时整行不渲染，不拿「0 项」占位置。
                      // 目录注入不进摘要：它只决定目录出现在哪些会话，不影响委派本身。
                      React.createElement('span', null, t('subagents.adv.summary', {
                        model: modal.form.model ? (modal.form.provider ? modal.form.provider + '/' + modal.form.model : modal.form.model) : t('subagents.adv.inherit'),
                        // 思考强度收起来也要看得见：它是"下一次委派会怎么跑"的一部分。
                        // 没配时报「默认」而**不是**「继承」—— 官方语义里换模型会把继承来的那一档
                        // 删掉（`dsh-subagent/lib/index.js:482`），报「继承」是句假话。
                        effort: modal.form.reasoningEffort ? String(modal.form.reasoningEffort) : t('subagents.effort.none'),
                        // 允许追问接在同一行尾巴上：它同样是"会怎么跑"，而且是**最容易忘**的一项
                        // （结果变成异步回执）。分隔号写在词典值里，英文侧才不用跟着改代码。
                        tail: modal.form.continuable === true ? t('subagents.adv.continuable') : '',
                      })),
                      advLimitLine() ? React.createElement('span', null, advLimitLine()) : null)),
                  modal.advanced ? React.createElement('div', { className: 'dsm-adv-body' },
                    // 三组：模型 / 运行方式 / 工具限制（0.19.0 重排）。重排前是五个字段平铺、
                    // 九处提示文字混用三种形态（单行 dsm-help / 项目符号 / 选择器副标题），
                    // 展开态读起来是一堵墙（用户 2026-10-07 裁定）。现在：分组头 + 一条细线划开；
                    // 静态说明一律不进表单，只留**状态类**提示（拉取中 / 未选模型 / 拉不到 / 报错）。
                    React.createElement('div', { className: 'dsm-adv-group' },
                      React.createElement('div', { className: 'dsm-adv-group-head' }, t('subagents.adv.group.model')),
                      // 模型来源与模型并排：官方把 (provider, model) 当一对解析，跨来源（如 sensenova）
                      // 必须两个键同时给。顺序按解析顺序 —— 先来源，后模型。
                      // 两个字段并排用 `.dsm-field-row`；`.dsm-combo-row` 是**字段内部**的
                      // "下拉 + 它旁边的东西"（这里只剩下拉，`.dsm-combo-row .dsm-select{flex:1}`
                      // 让它填满整格 —— 缺这条时下拉宽度由选项文字撑出，换来源后标签变短、框跟着缩）。
                      React.createElement('div', { className: 'dsm-field-row' },
                        // 模型来源：去重后的来源清单，只从宿主目录里选（手填通道 2026-10-07 删除）。
                        // 换来源要重拉档位 —— 档位清单是按 (provider, model) 给的。
                        // 换来源**不清模型**：清掉是"悄悄改掉用户已配好的值"，而留着会立刻显形 ——
                        // 模型下拉找不到这对 (来源, 模型) 就多列一条带「目录里没有」标记的选项。
                        React.createElement('div', { className: 'dsm-field' },
                          React.createElement('span', { className: 'dsm-label' }, t('subagents.field.provider')),
                          React.createElement('div', { className: 'dsm-combo-row' },
                            React.createElement('div', { className: 'dsm-select' },
                              React.createElement('select', {
                                className: 'dsm-control',
                                value: providerSelectValue(),
                                disabled: busy || cand.loading,
                                onChange: function (e) {
                                  var v = e.target.value
                                  setForm({ provider: v })
                                  loadEfforts(v, modal.form.model || '')
                                },
                              },
                                React.createElement('option', { value: '' }, t('subagents.provider.inherit')),
                                (cand.providers || []).map(function (p) {
                                  return React.createElement('option', { key: p.id, value: p.id }, providerLabel(p))
                                }),
                                // 目录外的旧值：列一条只读选项，值看得见、要改只能重选目录里的。
                                offCatalogProvider()
                                  ? React.createElement('option', { value: offCatalogProvider() },
                                      catalogReady() ? t('subagents.field.offCatalog', { id: offCatalogProvider() }) : offCatalogProvider())
                                  : null)))),
                        // 模型：宿主 LLM 目录里的 (provider, model) 对，只从目录里选。
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
                                  if (v === '') { setForm({ provider: '', model: '' }); loadEfforts('', '') }
                                  else {
                                    var parts = v.split('\u0000')
                                    setForm({ provider: parts[0], model: parts[1] })
                                    // 档位跟模型走：换模型必须重拉（缓存命中时是同步的，不会闪）。
                                    loadEfforts(parts[0], parts[1])
                                  }
                                },
                              },
                                React.createElement('option', { value: '' }, t('subagents.model.inherit')),
                                modelOptions().map(function (m) {
                                  return React.createElement('option', { key: m.provider + '/' + m.id, value: m.provider + '\u0000' + m.id }, modelOptionLabel(m))
                                }),
                                // 目录外的旧值：同来源那条，列一条只读选项。
                                offCatalogModel()
                                  ? React.createElement('option', { value: offCatalogModel() },
                                      catalogReady() ? t('subagents.field.offCatalog', { id: modal.form.model }) : modal.form.model)
                                  : null))),
                          // 目录还在读时给一行状态；读完了不占行 —— 这里原来放的是"留空继承主会话"
                          // 那句静态说明，已随 0.19.0 重排移出表单。
                          cand.loading ? React.createElement('p', { className: 'dsm-help' }, t('memory.loading')) : null)),
                      // 思考强度：值就是 adapter 给的档位 id（不校验合法性，官方在 provider I/O 前会拒）。
                      // 单独占左半列（`.dsm-adv-half`），与上一行的列边界对齐。
                      React.createElement('div', { className: 'dsm-field dsm-adv-half' },
                        React.createElement('span', { className: 'dsm-label' }, t('subagents.field.effort')),
                        React.createElement('div', { className: 'dsm-select' },
                          React.createElement('select', {
                            className: 'dsm-control',
                            value: String(modal.form.reasoningEffort || ''),
                            disabled: busy || eff.loading || !modal.form.model,
                            onChange: function (e) { setEffNotice(null); setForm({ reasoningEffort: e.target.value }) },
                          },
                            React.createElement('option', { value: '', title: defaultEffortTitle() }, t('subagents.effort.default')),
                            currentEfforts().map(function (x) {
                              return React.createElement('option', { key: x.id, value: x.id, title: x.description || undefined }, x.name)
                            }))),
                        // 状态行只在"这一格为什么用不了 / 没有档位"的四种情况下出现；有档位可选时
                        // 这一行不存在 —— 原来这里常驻的是"当前可选择多种思考强度"那句同义反复。
                        !modal.form.model || eff.loading || eff.error || !currentEfforts().length
                          ? React.createElement('p', { className: 'dsm-help' },
                              !modal.form.model
                                ? t('subagents.effort.needModel')
                                : eff.loading
                                  ? t('subagents.effort.loading')
                                  : eff.error
                                    ? String(eff.error)
                                    : t('subagents.effort.unavailable'))
                          : null,
                        effNotice ? React.createElement('p', { className: 'dsm-feedback dsm-warning' }, effNotice) : null)),
                    // ── 运行方式：这份人设"什么时候跑、跑在哪些会话里" ──
                    React.createElement('div', { className: 'dsm-adv-group' },
                      React.createElement('div', { className: 'dsm-adv-group-head' }, t('subagents.adv.group.runtime')),
                      // 目录注入深度：人设目录注入到哪些会话（默认 1 = 只在顶层）。用下拉而不是数字
                      // 输入：只有 1/2/3 三个有意义的档，手写数字写错要到注入时才暴露。
                      //
                      // ⚠️ 它**不是**递归上限。2026-09-17 用户实测后改名（原名 maxDepth /「委派预算」）：
                      // 官方 `dsh-tool-subagent` 默认 `maxDepth: 3`，子代理本来就能继续嵌套，本插件
                      // 也不再向官方传 maxDepth。这个字段只决定常驻目录出现在哪些深度的会话里。
                      React.createElement('label', { className: 'dsm-field dsm-adv-half' },
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
                          })))),
                      // 允许追问（frontmatter `continuable: true`）：这条通道的**产出是异步的** ——
                      // 委派只回执一个 agent id，子代理在后台跑、完成后自己把结果发回来，
                      // 之后可以用宿主自带的 `send_message` 追问、`interrupt_agent` 中止。
                      // 默认关：它占用宿主"可继续子代理"的名额（`maxActiveSubagents`，默认 8），
                      // 且要求宿主加载了持久化与 session query 两个服务。
                      // 机制与代价的完整说明记在 CHANGELOG / README，不进表单（0.19.0 重排）。
                      React.createElement('label', { className: 'dsm-pick' },
                        React.createElement('input', { type: 'checkbox', checked: modal.form.continuable === true, disabled: busy, onChange: function (e) { setForm({ continuable: e.target.checked === true }) } }),
                        React.createElement('span', { className: 'dsm-pick-main' },
                          React.createElement('span', { className: 'dsm-pick-name' }, t('subagents.field.continuable')),
                          React.createElement('span', { className: 'dsm-pick-desc' }, t('subagents.field.continuable.short'))))),
                    // ── 工具限制：按 Agent 预设一行一个模式（默认全折叠、全部未启动，白/黑互斥）。
                    // 旧格式的全局名单（老文件 / 别处导入）在这里只读呈现，点「转换」才搬进某个模式。
                    React.createElement('div', { className: 'dsm-adv-group' },
                      React.createElement('div', { className: 'dsm-adv-group-head' }, t('subagents.adv.group.tools')),
                      // 这是整块里唯一留下的静态说明，两条理由：它回答"这一屏会不会生效"，
                      // 而且藏着一条反直觉的事实（MCP 工具不在候选里）—— 删掉会让人以为能限制 MCP。
                      // 白/黑名单语义那三句已移出表单（词面自解释，按钮与模式摘要里都在用）。
                      React.createElement('p', { className: 'dsm-help' }, t('subagents.field.modes.hint')),
                      legacyNotice(),
                      modeRows()),
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