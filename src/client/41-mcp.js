        function FeedbackLinks() {
          return React.createElement('div', { className: 'dsm-feedback-links' },
            React.createElement('a', { className: 'dsm-feedback-link', href: 'https://github.com/ouli-1242/dsh-plugin-tool-management', target: '_blank', rel: 'noreferrer', 'aria-label': t('link.project'), title: t('link.project') },
              React.createElement(GithubMark16, null)),
            React.createElement(VersionBadgeComponent, null))
        }

        // MCP 服务页：与 Skills 页共用 dsm-* 设计语言（统计卡 / 筛选 / 分组卡片 / 模态框）。
        function MCPPage() {
          const [state, setState] = React.useState({ loading: true, error: null, rows: [], paths: null, errors: [], warnings: [] })
          const [msg, setMsg] = React.useState(null)
          const [busy, setBusy] = React.useState(null)
          const [query, setQuery] = React.useState('')
          // 过滤用防抖值（输入框仍绑 `query`）：本页每 5 秒轮询一次（内容没变不重渲染，
          // 见 applyRows 的指纹去重），不防抖就是"每个按键"都全量扫一遍列表。轮询改的是
          // rows 不是 query，所以输入期间不会被轮询打断。
          const debouncedQuery = useDebouncedValue(query)
          const [levelFilter, setLevelFilter] = React.useState('')
          const [collapsed, setCollapsed] = React.useState({})
          const [formModal, setFormModal] = React.useState(null)
          // 表单的本地校验结果（不塞进 formModal：那对象是发给服务端的 payload 形状）。
          const [formError, setFormError] = React.useState(null)
          const [detail, setDetail] = React.useState(null)
          // 详情弹窗的请求序号：见 openDetail / closeDetail（晚到响应不得复活弹窗）。
          const detailSeqRef = React.useRef(0)
          const [confirmRow, setConfirmRow] = React.useState(null)
          const [reveal, setReveal] = React.useState(false)
          const [settings, setSettings] = React.useState(null)
          const [noteDraft, setNoteDraft] = React.useState('')
          const [compactConfirm, setCompactConfirm] = React.useState(false)
          // A1：粘贴 JSON 导入 / 导出两个弹窗（0.15.0）。
          const [jsonImportOpen, setJsonImportOpen] = React.useState(false)
          const [jsonExportOpen, setJsonExportOpen] = React.useState(false)
          // B1：配置体检结果。键 = `level/id`，值 = 未体检 / {busy:true} / {checks:[…]} / {error}。
          // 刻意不落盘（服务器数量级小、每次现查），但**配置一改就作废** —— 见下面的 signature effect：
          // 挂着上一次的绿点说「刚改过的配置没问题」是假承诺。
          const [inspections, setInspections] = React.useState({})
          const inspectKeyOf = (row) => String(row.level || '') + '/' + row.id
          const [undo, setUndo, dismissUndo] = useUndoState()
          const flipRef = React.useRef(null)
          useFlipReorder(flipRef)

          // 上一次列表响应的内容指纹（applyRows 写入）。轮询通常带回一模一样的数据：
          // 指纹没变就跳过 setState，否则每 5 秒整页换一批新对象，所有 useMemo、React
          // 协调、开着的弹窗全部跟着空转一遍 —— 自动化点击与用户输入都可能被这阵重渲染
          // 打断（2026-09-29 GUI 测试实录）。
          const lastListFingerprint = React.useRef(null)

          const refresh = (withReveal, onRows, silent) => {
            const useReveal = withReveal === undefined ? reveal : withReveal === true
            // 手动刷新（含首次加载）先把按钮切到「刷新中…」并禁用 —— 点完毫无反馈等于没点。
            // 轮询不算（定时器传 silent=true）：它每几秒跑一次，切文案会让按钮一直闪。
            if (!silent) setState((prev) => Object.assign({}, prev, { loading: true }))
            // 明文视图走独立的 mcpm-reveal op（host 端要求带对的访问令牌），
            // mcpm-list 始终脱敏、无令牌也能渲染页面。
            const applyRows = (res) => {
              const rows = (res && res.rows) || []
              // 指纹必须覆盖 setState 会写进 state 的每个字段（loading / error 除外：
              // 它们由下面的 updater 单独判定 —— 手动刷新挂起的 loading、上一轮的错误
              // 提示，即使数据没变也要用这次响应收尾）。
              const fingerprint = JSON.stringify([
                res && res.ok, res && res.error, rows, res && res.paths, res && res.errors,
                res && res.warnings, (res && res.anyLocked) === true, (res && res.activeScene) || null,
              ])
              const changed = fingerprint !== lastListFingerprint.current
              lastListFingerprint.current = fingerprint
              setState((prev) => (changed || prev.loading || prev.error ? {
                loading: false,
                error: res && res.ok ? null : ((res && res.error) || mt('mcp.msg.loadFailed')),
                rows,
                paths: (res && res.paths) || null,
                errors: (res && res.errors) || [],
                warnings: (res && res.warnings) || [],
                locked: (res && res.anyLocked) === true,
                // 场景内开关由档案定义：页面上这些开关置灰，并说明去哪儿改。
                scene: (res && res.activeScene) || null,
              } : prev))
              if (onRows) onRows(rows)
            }
            apiCall(useReveal ? 'mcpm-reveal' : 'mcpm-list', {}).then((res) => {
              // 明文被拒（未配令牌 / 令牌不对）：退回脱敏列表。**提示本身不在这里管** ——
              // apiCall 已经把「令牌没过」记进了那份与页面无关的状态，由弹窗或页面级提示条
              // 渲染一份（原来这里存一份 revealError，好处是没有的，坑是：每次刷新都得
              // 小心别把它抹掉 —— 见 2026-09-18 的"提示几秒后自己消失"）。
              if (useReveal && res && res.ok === false) {
                setReveal(false)
                return apiCall('mcpm-list', {}).then(applyRows)
              }
              applyRows(res)
            }).catch((e) => setState({
              loading: false, error: errMsg(e), rows: [], paths: null, errors: [], warnings: [], locked: false,
            }))
          }
          // The polling tick must always call the newest refresh closure, while
          // the interval itself only changes when the saved settings change.
          const refreshRef = React.useRef(refresh)
          refreshRef.current = refresh

          React.useEffect(() => { refresh(false) }, [])
          React.useEffect(() => {
            apiCall('mcpm-settings', {}).then((res) => {
              if (res && res.ok && res.settings) setSettings(res.settings)
            }).catch(() => {})
          }, [])
          React.useEffect(() => {
            const ms = (settings && settings.pollIntervalMs) || 5000
            return ctx.interval(() => refreshRef.current(undefined, null, true), ms)
          }, [settings])
          React.useEffect(() => {
            // 只有**成功**提示才自动消失：警告 / 错误要么需要用户去处理（点提示右侧的
            // 「填写令牌」之类），要么是"这次没生效"的唯一线索 —— 4 秒后自己没了，用户
            // 就只能看到「点了没反应」。这也与 Notice 的既定语义一致（错误常驻到下一次操作，
            // 而 run() 每次操作都会先 setMsg(null) 收掉旧的）。2026-09-19 用户实测。
            if (!msg || msg.kind !== 'ok') return undefined
            return ctx.timeout(() => setMsg(null), 4000)
          }, [msg])

          const run = (method, args, label, onOk) => {
            setMsg(null)
            setBusy(label)
            apiCall(method, args).then((res) => {
              if (res && res.ok) {
                // 场景内改开关：档案没跟上的话要说出来，别只报「成功」（详见 sceneSyncWarn）。
                const warn = sceneSyncWarn(mt, res)
                setMsg(warn ? { kind: 'warn', text: opMsg(res) + ' ' + warn } : opMsg(res))
                refresh()
                if (onOk) onOk()
              } else setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
            }).catch((e) => setMsg({ kind: 'err', text: errMsg(e) })).then(() => setBusy(null))
          }

          /**
           * 全部启动 / 全部停用。
           *
           * 只算本操作真正管得到的行：`mcpm-set-all` 改的是补丁里的行，而列表里还混着 loader 行
           * （`level === 'loader'` —— 宿主 loader 清单里有、补丁里却没有对应条目的那些）。
           * 把它们算进来会让「本次改动 N 个」虚高，撤销还会去调一个补丁里并不存在的条目。
           *
           * 撤销条上的「当前共 N 个处于启用状态」用目标态直接推算，不等刷新回来 ——
           * 全部启动 / 停用会把每一条都设成目标态，所以结果是个确定值。
           */
          const setAllServers = () => {
            const target = summary.enabled < summary.total
            const managed = (state.rows || []).filter((r) => r.level !== 'loader')
            const items = managed.filter((r) => !r.disabled !== target).map((r) => ({ id: r.id, level: r.level, on: !r.disabled }))
            run('mcpm-set-all', { enabled: target }, 'setall', () => setUndo({
              text: mt('undo.mcp', {
                action: mt(target ? 'bulk.enabled' : 'bulk.disabled'),
                count: items.length,
                enabled: target ? managed.length : 0,
              }),
              items: items,
              revert: (item) => apiCall('mcpm-set-enabled', { id: item.id, level: item.level, enabled: item.on }),
            }))
          }

          /**
           * 撤销刚做的批量启停：按**操作前**的状态逐条写回。
           * 复用 `mcpm-set-enabled` 而不是再调一次 `mcpm-set-all` —— 后者只有一个 enabled 参数，
           * 「原本一半开一半关」时会把那些也一并打开，等于撤销撤销错了。
           */
          const undoSetAll = () => {
            const entry = undo
            if (!entry) return
            setUndo(null)
            setBusy('undo')
            runUndo(entry).then((failed) => {
              setBusy(null)
              setMsg(failed ? { kind: 'err', text: mt('undo.failed', { count: failed }) } : { kind: 'ok', text: mt('undo.done') })
              refresh()
            })
          }

            const openAdd = () => { setFormError(null); setFormModal(Object.assign({ mode: 'add', id: null }, emptyForm())) }
              const openEdit = (row) => {
                setFormError(null)
                setFormModal({
                  mode: 'edit',
                  id: row.id,
                  serverName: row.serverName || '',
                  transport: row.transport === 'stdio' ? 'stdio' : 'streamable-http',
                  url: row.url || '',
                  command: row.command || '',
                  args: (row.args || []).join('\n'),
                  headers: kvToLines(row.headers),
                  env: kvToLines(row.env),
                  level: row.level === 'global' ? 'global' : 'project',
                })
              }
            const closeForm = () => { setFormError(null); setFormModal(null) }
            const setFormField = (key) => (ev) => { setFormError(null); setFormModal(Object.assign({}, formModal, { [key]: ev.target.value })) }
            const setFormValue = (key, value) => { setFormError(null); setFormModal(Object.assign({}, formModal, { [key]: value })) }
            /**
             * 提交前先把服务端的三条硬规则在本地过一遍（`mcpm-add` / `mcpm-edit` 里同一套判据）：
             * 服务名 1-32 位 `[A-Za-z0-9_-]`、http(s) 传输的地址必须以 http(s):// 开头、stdio 的命令非空。
             * 不在本地拦，就得等一次往返才拿到一句报错 —— 而且弹窗还开着，用户看不出刚才错在哪。
             * 判据刻意只抄这三条：**重名**依赖服务端全量名单，本地拿不全，交给服务端。
             */
            const validateForm = (payload) => {
              const serverName = String(payload.serverName || '').trim()
              if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return mt('mcp.form.err.serverName')
              if (payload.transport === 'stdio') {
                if (!String(payload.command || '').trim()) return mt('mcp.form.err.command')
              } else if (!/^https?:\/\//.test(String(payload.url || '').trim())) {
                return mt('mcp.form.err.url')
              }
              return null
            }
            const submitForm = () => {
              const payload = Object.assign({}, formModal)
              if (payload.transport === 'stdio') { payload.url = ''; payload.headers = '' }
              else { payload.command = ''; payload.args = ''; payload.env = '' }
              const invalid = validateForm(payload)
              if (invalid) { setFormError(invalid); return }
            const args = {
              serverName: payload.serverName,
              transport: payload.transport,
              level: payload.level,
              url: payload.url,
              command: payload.command,
              args: payload.args,
              headers: payload.headers,
              env: payload.env,
            }
            if (payload.mode === 'edit') args.id = payload.id
            // 备注只在新增时带：服务端在写补丁的同一次锁里落进侧车（见 mcpmAdd）。
            else args.note = payload.note
            run(payload.mode === 'edit' ? 'mcpm-edit' : 'mcpm-add', args, 'form', closeForm)
          }

          // Toggling updates only the clicked row (scroll position and expanded
          // groups survive); a failed write re-reads the server state instead.
          const toggleRow = (row) => {
            const nextDisabled = !row.disabled
            setMsg(null)
            setState((prev) => Object.assign({}, prev, {
              rows: (prev.rows || []).map((item) => (
                item.id === row.id && item.level === row.level
                  ? Object.assign({}, item, { disabled: nextDisabled })
                  : item
              )),
            }))
            setBusy(row.id + ':toggle')
            apiCall('mcpm-set-enabled', { id: row.id, level: row.level, enabled: row.disabled }).then((res) => {
              if (res && !res.ok) {
                setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
                refresh()
              } else if (res && res.warning) {
                setMsg({ kind: 'warn', text: mt('mcp.msg.warn', { warning: res.warning }) })
              }
            }).catch((e) => {
              setMsg({ kind: 'err', text: errMsg(e) })
              refresh()
            }).then(() => setBusy(null))
          }
          const toggleReveal = () => {
            const next = !reveal
            setReveal(next)
            // Re-read the list and feed the fresh row back into the open dialog,
            // so the masking actually flips where the user is looking.
            // 取序号：弹窗若在这趟请求回来之前就被关掉（或换了另一台服务器的详情），
            // 这次回写必须作废 —— 否则晚到的响应会把刚关掉的弹窗重新打开。
            const seq = detailSeqRef.current
            refresh(next, (rows) => {
              if (!detail || seq !== detailSeqRef.current) return
              const fresh = rows.find((item) => item.id === detail.row.id && item.level === detail.row.level)
              if (fresh) setDetail(Object.assign({}, detail, { row: fresh }))
            })
          }
          const saveNote = () => {
            const row = detail && detail.row
            if (!row) return
            run('mcpm-note', { id: row.id, note: noteDraft }, 'note', () => {
              setDetail(Object.assign({}, detail, { row: Object.assign({}, row, { notes: noteDraft.trim() }) }))
            })
          }
          const confirmRemove = () => {
            const row = confirmRow
            setConfirmRow(null)
            if (row) run('mcpm-remove', { id: row.id, level: row.level }, row.id + ':remove')
          }
          // 「整理补丁」：删掉多余的启停覆盖块（生效值不变，只删被盖住的块与纯 no-op）。
          // 成功文案带真实删除数量；一条都没删时如实说"已经是干净的"，而不是笼统的"成功"。
          const doCompact = () => {
            setCompactConfirm(false)
            setMsg(null)
            setBusy('compact')
            apiCall('mcpm-compact', {}).then((res) => {
              if (res && res.ok) {
                const n = Number(res.removed || 0)
                setMsg({ kind: 'ok', text: n > 0 ? mt('mcp.compact.done', { count: n }) : mt('mcp.compact.clean') })
                refresh()
              } else setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
            }).catch((e) => setMsg({ kind: 'err', text: errMsg(e) })).then(() => setBusy(null))
          }
          /**
           * 体检一次：`target` 省略 = 全部。服务端每次重读补丁文件，界面只按 `level/id` 存结果。
           * 单台与全部走同一个 op（服务端支持 id+level 过滤），免得两种口径的检查结果对不上。
           */
          const runInspect = (target) => {
            const all = !target
            const args = all ? {} : { id: target.id, level: target.level }
            if (all) {
              const busyMap = {}
              ;(state.rows || []).forEach((item) => { busyMap[inspectKeyOf(item)] = { busy: true } })
              setInspections(busyMap)
            } else {
              setInspections(Object.assign({}, inspections, { [inspectKeyOf(target)]: { busy: true } }))
            }
            apiCall('mcpm-inspect', args).then((res) => {
              if (!res || !res.ok) {
                const text = (res && res.error) || mt('mcp.inspect.failed')
                setInspections(all ? {} : Object.assign({}, inspections, { [inspectKeyOf(target)]: { error: text } }))
                if (all) setMsg({ kind: 'err', text })
                return
              }
              const next = {}
              ;(res.results || []).forEach((item) => { next[inspectKeyOf(item)] = { checks: item.checks || [] } })
              setInspections((prev) => (all ? next : Object.assign({}, prev, next)))
              // 补丁文件读不到时体检只覆盖了余下部分 —— 如实说出来，不给「整页都绿」的假结论。
              if (res.errors && res.errors.length) setMsg({ kind: 'warn', text: mt('mcp.inspect.errors', { errors: res.errors.join('；') }) })
            }).catch((e) => {
              const text = errMsg(e)
              setInspections(all ? {} : Object.assign({}, inspections, { [inspectKeyOf(target)]: { error: text } }))
              if (all) setMsg({ kind: 'err', text })
            })
          }
          // 配置内容指纹：只有**配置本身**变了才作废旧结果。轮询每 5 秒换一批新对象但不改内容，
          // 直接依赖 rows 会让体检每 5 秒被清空一遍。
          const patchSignature = React.useMemo(() => (state.rows || []).map((r) => [
            r.level, r.id, r.serverName, r.transport, r.command, r.url,
            (r.args || []).join(','), JSON.stringify(r.env || {}), JSON.stringify(r.headers || {}), r.disabled ? '1' : '0',
          ].join(':'))
            .join('|'), [state.rows])
          React.useEffect(() => { setInspections({}) }, [patchSignature])

          const openDetail = (row) => {
            // 请求序号（每次开窗 +1）：两处详情弹窗共用同一份 `detail`，连点两台服务器时
            // 先发的响应可能后到并覆盖后发的那份 —— 序号对不上就丢弃。
            const seq = ++detailSeqRef.current
            setNoteDraft(row.notes || '')
            setDetail({ row, loading: true, error: null, tools: [] })
            apiCall('mcpm-tools', { serverName: row.serverName }).then((res) => {
              if (seq !== detailSeqRef.current) return
              if (res && res.ok) setDetail({ row, loading: false, error: null, tools: res.tools || [] })
              else setDetail({ row, loading: false, error: (res && res.error) || mt('mcp.tools.loadFailed'), tools: [] })
            }).catch((e) => {
              if (seq !== detailSeqRef.current) return
              setDetail({ row, loading: false, error: errMsg(e), tools: [] })
            })
          }
          /** 关闭详情弹窗：先作废在途响应（否则晚到的那份会把弹窗重新打开），再清 state。 */
          const closeDetail = () => {
            detailSeqRef.current += 1
            setDetail(null)
          }

          const toggleTool = (row, tool) => {
            const nextEnabled = tool.enabled === false
            setMsg(null)
            setBusy('tool:' + tool.name)
            apiCall('mcpm-tool-enabled', { serverName: row.serverName, tool: tool.name, enabled: nextEnabled }).then((res) => {
              if (res && res.ok) {
                setDetail(Object.assign({}, detail, { tools: (detail.tools || []).map((item) => (item.name === tool.name ? Object.assign({}, item, { enabled: nextEnabled }) : item)) }))
                setMsg({ kind: 'ok', text: mt(nextEnabled ? 'mcp.msg.toolOn' : 'mcp.msg.toolOff', { name: tool.name }) })
              } else setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
            }).catch((e) => setMsg({ kind: 'err', text: errMsg(e) })).then(() => setBusy(null))
          }

          const rows = state.rows || []
          // 工具数的三个口径（与 src/mcp/state-section.ts 同源，理由见那里的文件头）：
          //   liveToolCount        当前真实注册了几个工具（**不含**「已知工具」缓存）
          //   liveEnabledToolCount 其中未被停用表扣减的（真正能调到的）
          //   knownToolCount       缓存里的数量 —— >0 表示这台 server **曾经真的连上过**
          // 拆分的原因：缓存里的工具名在服务器已经连不上时依然存在，把它算进"当前工具数"
          // 会让一台挂掉的 server 显示成「已运行」并被注入上下文（2026-09-17 实测）。
          // 旧数据没有前两个字段时逐级退回，行为与拆分之前一致。
          const liveEnabledOf = (row) => {
            if (typeof row.liveEnabledToolCount === 'number') return row.liveEnabledToolCount
            return typeof row.enabledToolCount === 'number' ? row.enabledToolCount : (typeof row.toolCount === 'number' ? row.toolCount : 0)
          }
          const liveOf = (row) => typeof row.liveToolCount === 'number' ? row.liveToolCount : liveEnabledOf(row)
          const knownOf = (row) => typeof row.knownToolCount === 'number' ? row.knownToolCount : 0
          const normalizedQuery = debouncedQuery.trim().toLowerCase()
          // 「已加载」= 当前真正在运行的条目（loader 已启用且 active）。
          const isRunning = (row) => !!(row.live && row.live.enabled && row.live.phase === 'active')
          const matchesRow = (row) => {
            if (levelFilter === 'loader') { if (!isRunning(row)) return false }
            else if (levelFilter && row.level !== levelFilter) return false
            if (!normalizedQuery) return true
            return [row.serverName, row.id, row.url, row.command, row.transport].some((value) => String(value == null ? '' : value).toLowerCase().indexOf(normalizedQuery) >= 0)
          }
          // 过滤只在 rows / 搜索词 / 层级筛选变化时重算（轮询换 rows 时会重算一次，那是必要的）。
          const visibleRows = React.useMemo(() => rows.filter(matchesRow), [rows, normalizedQuery, levelFilter])
          // 工具数两个口径：total = 当前真实注册数；enabled = 其中可用的（停用表扣减后，
          // 与详情页每行的开关一致）。两者不同时显示「可用/总数」，不让全部数量冒充可用数。
          // 只数真实注册的 —— 缓存里那些"上次见过"的名字不能计入页面总数，否则一台挂掉的
          // server 会让这里的数字虚高，与它自己那行的「无可用工具」自相矛盾。
          const toolTotals = React.useMemo(() => rows.reduce((acc, row) => {
            const total = liveOf(row)
            acc.total += total
            acc.enabled += liveEnabledOf(row)
            return acc
          }, { total: 0, enabled: 0 }), [rows])
          const summary = React.useMemo(() => ({
            total: rows.length,
            enabled: rows.filter((row) => !row.disabled).length,
            tools: toolTotals.enabled,
            toolsTotal: toolTotals.total,
          }), [rows, toolTotals])
          const profilePath = state.paths && state.paths.profile ? 'profile: ' + state.paths.profile : null
          const groups = React.useMemo(() => (levelFilter === 'loader'
            ? [{ key: 'live', title: mt('mcp.level.loader'), path: profilePath, match: isRunning }]
            // 分组顺序（用户要求 2026-09-17）：全局在前、应用级在后 —— 全局那一层跨应用
            // 生效，是更"外面"的一层；此前应用级在前，与"局部覆盖全局"的读法相反。
            // 组内顺序直接用行的到达顺序：服务端 `mcpmList` 已按 全局 → 应用级 → loader、
            // 同级内按服务器名排好（同一个顺序也是场景档案勾选器与模型侧列表的顺序）。
            : [
                { key: 'global', title: mt('mcp.level.global'), path: state.paths ? state.paths.global : null, match: (row) => row.level === 'global' },
                { key: 'project', title: mt('mcp.level.project'), path: state.paths ? state.paths.project : null, match: (row) => row.level === 'project' },
                { key: 'loader', title: mt('mcp.level.loader'), path: profilePath, match: (row) => row.level === 'loader' && isRunning(row) },
              ]), [levelFilter, profilePath])
          // 分组 + 「启用的排前面」一次算完：以前这步在 renderGroup 里，每个组每次渲染各跑一遍
          // filter 与分区（5 秒轮询换 rows 时整页重渲染也要重跑）。行的 key 与 data-flip-* 未动。
          const grouped = React.useMemo(
            () => groups.map((group) => ({ group: group, rows: enabledFirst(visibleRows.filter(group.match), (row) => !row.disabled) })),
            [groups, visibleRows],
          )

          // 状态口径：tone 只决定胶囊配色（ok=能用、bad=坏了、warn=当前没工具、muted=没在跑）。
          const liveStatus = (row) => {
            if (!row.live) return { text: mt('mcp.live.notLoaded'), tone: 'muted' }
            if (row.live.phase === 'failed') return { text: mt('mcp.live.failed'), tone: 'bad' }
            if (!row.live.enabled) return { text: mt('mcp.live.stopped'), tone: 'muted' }
            if (row.live.phase && row.live.phase !== 'active') return { text: mt('mcp.live.loading'), tone: 'muted' }
            // 判"有没有可用工具"只看**真实注册**的那个数（缓存不算）。
            if (liveEnabledOf(row) === 0) return { text: mt('mcp.live.noTools'), tone: 'warn' }
            return { text: mt('mcp.live.running'), tone: 'ok' }
          }
          const liveHint = (row) => {
            if (!row.live) return null
            if (row.live.phase === 'failed') return mt('mcp.live.failedHint')
            if (row.live.phase === 'active' && liveEnabledOf(row) === 0) {
              if (liveOf(row) === 0) {
                // 一个工具都没注册。曾经连上过 → 这是"断了"，给可行动的说明；
                // 从未连上过 → 说清"从来没成功过"，别让用户以为是刚坏的。
                return knownOf(row) > 0
                  ? mt('mcp.live.offlineHint', { count: knownOf(row) })
                  : mt('mcp.live.neverHint')
              }
              // 注册了但全被停用：这是用户自己的选择，不是故障。
              return mt('mcp.live.allOffHint')
            }
            return null
          }
          // 工具数标签：有被停用的工具时给「可用/总数」（场景档案收窄与手动逐工具开关
          // 写的是同一张停用表），否则就是总数 —— 与详情页每个工具的开关状态一致。
          //
          // 只按**真实注册**的数来显示：一个都没注册时不给数字（那台 server 现在没有工具，
          // 摆一个"13 个工具"就是拿缓存冒充现状；它上次连上时有多少个，由下面那行提示说明）。
          const toolCountTag = (row) => {
            const total = liveOf(row)
            if (total <= 0) return null
            const enabled = liveEnabledOf(row)
            return enabled < total
              ? React.createElement('span', { className: 'dsm-tag' }, mt('mcp.tools.countPartial', { enabled: enabled, total: total }))
              : React.createElement('span', { className: 'dsm-tag' }, mt('mcp.tools.count', { count: total }))
          }

          const renderRow = (row) => {
            const status = liveStatus(row)
            const hint = liveHint(row)
            // 场景锁定期间整页只读（开关 / 编辑 / 删除一并消失）。
            const editable = row.level !== 'loader' && state.locked !== true
            // 体检状态：未体检=灰（不是"没问题"）、进行中=闪、有 warn=黄、info 级说明不点黄。
            const insp = inspections[inspectKeyOf(row)]
            const warnCount = insp && insp.checks ? insp.checks.filter((c) => c.level === 'warn').length : 0
            const inspTone = insp && insp.busy ? 'busy' : insp && insp.error ? 'warn' : !insp ? 'idle' : warnCount > 0 ? 'warn' : 'ok'
            const inspTitle = insp && insp.busy ? mt('mcp.inspect.busy')
              : insp && insp.error ? insp.error
              : !insp ? mt('mcp.inspect.idle')
              : warnCount > 0 ? mt('mcp.inspect.warnCount', { count: warnCount })
              : mt('mcp.inspect.pass')
            return React.createElement('div', { key: row.id, className: 'dsm-row dsm-row-compact', 'data-flip-key': String(row.level || '') + '/' + row.id, 'data-flip-on': row.disabled ? '0' : '1' },
              React.createElement('div', { className: 'dsm-main dsm-dot-indent' },
                // 体检点与状态都收进名字这一行（用户裁定 2026-09-29）：点要在名字前面才第一眼
                // 看得到，状态改成胶囊跟着名字走，与子智能体那一页同形。
                React.createElement('div', { className: 'dsm-name-row' },
                  React.createElement(InspectDot, { tone: inspTone, title: inspTitle }),
                  React.createElement('div', { className: 'dsm-name' }, row.serverName),
                  React.createElement(StatusTag, { tone: status.tone, text: status.text })),
                // 备注与标签同一行（用户裁定 2026-09-29）：标签以前自己占一行，带备注的行就比
                // 不带的高出一截，同一页里行高不齐 —— 两行是这行的固定预算。
                React.createElement('div', { className: 'dsm-meta-row' },
                  (levelFilter === 'loader' && row.level && row.level !== 'loader') ? React.createElement('span', { className: 'dsm-tag' }, mt('mcp.level.' + row.level)) : null,
                  toolCountTag(row),
                  row.duplicate ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, mt('mcp.duplicate')) : null,
                  row.notes ? React.createElement('div', { className: 'dsm-note dsm-note-user', title: row.notes }, mt('mcp.note.prefix') + row.notes) : null)),
              React.createElement('div', { className: 'dsm-row-actions' },
                editable ? React.createElement(Switch, { on: !row.disabled, disabled: busy !== null || state.locked === true, label: mt('mcp.toggleServer') + ' ' + row.serverName, onClick: () => toggleRow(row) }) : null,
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: !!(insp && insp.busy), onClick: () => runInspect(row) }, mt('mcp.inspect.row.btn')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: () => openDetail(row) }, mt('mcp.btn.detail')),
                editable ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: () => openEdit(row) }, mt('mcp.btn.edit')) : null,
                editable ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy !== null, onClick: () => setConfirmRow(row) }, mt('mcp.btn.remove')) : null),
              (insp && insp.checks && insp.checks.length > 0)
                ? React.createElement('div', { className: 'dsm-inspect' }, insp.checks.map((c) => React.createElement('div', { key: c.id, className: 'dsm-inspect-line' + (c.level === 'warn' ? ' dsm-inspect-warn' : '') }, mt('mcp.inspect.check.' + c.id, c.params || {}))))
                : null,
              hint ? React.createElement('div', { className: 'dsm-row-hint' }, '⚠ ' + hint) : null)
          }

          const renderGroup = (group, groupRows) => {
            if (groupRows.length === 0) return null
            const open = collapsed[group.key] !== true || !!normalizedQuery
            // 翻的是**收起标记本身**（与记忆 / 会话页的 `toggleCollapse` 同一写法）。这里原先写的是
            // `!open` —— 展开态下 `!open` 是 false，而 `false` 在这张表里的意思正是"没收起"，
            // 于是每次点击都把同一个值写回去：**这张卡片从写下那天起就收不起来**（0.11.0 起，用户实测）。
            const flip = () => setCollapsed((prev) => Object.assign({}, prev, { [group.key]: prev[group.key] !== true }))
            return React.createElement('section', { key: group.key, className: 'dsm-source' },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: flip },
                  React.createElement('span', { className: 'dsm-source-title', title: group.title }, group.title),
                  React.createElement('span', { className: 'dsm-count' }, mt('mcp.servers.count', { count: groupRows.length })),
                  group.path ? React.createElement('span', { className: 'dsm-path', title: group.path }, group.path) : null)),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                React.createElement(React.Fragment, null,
                  React.createElement('div', { className: 'dsm-table-head dsm-row-compact' },
                    React.createElement('span', { className: 'dsm-dot-indent' }, mt('mcp.table.name')),
                    React.createElement('span', null, '')),
                  groupRows.map(renderRow))) : null)
          }

          const configRow = (label, value) => React.createElement('div', { className: 'dsm-fm-row', key: label },
            React.createElement('div', { className: 'dsm-fm-key' }, label),
            React.createElement('div', { className: 'dsm-fm-val' }, value))

          const toolListNode = detail && (detail.loading
            ? React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.loading'))
            : detail.error
              ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, mt('mcp.tools.loadFailed') + detail.error)
              : (detail.tools || []).length === 0
                ? React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.none'))
                : React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.note')),
                    React.createElement('div', { className: 'dsm-tools' }, (detail.tools || []).map((tool) => React.createElement('div', { className: 'dsm-tool' + (tool.enabled === false ? ' dsm-tool-off' : ''), key: tool.name },
                      React.createElement('div', { className: 'dsm-tool-name-row' },
                        React.createElement('div', { className: 'dsm-tool-name' }, tool.name),
                        // 描述来自「已知工具」缓存（服务器未运行）→ 标明是旧数据，不假装实时。
                        tool.stale ? React.createElement('span', { className: 'dsm-tag' }, mt('mcp.tools.stale')) : null,
                        React.createElement(Switch, { on: tool.enabled !== false, disabled: busy !== null || state.locked === true, label: mt('mcp.toggleTool') + ' ' + tool.name, onClick: () => toggleTool(detail.row, tool) })),
                      tool.description ? React.createElement(ToolDesc, { text: tool.description, expandLabel: mt('mcp.tools.expand'), collapseLabel: mt('mcp.tools.collapse') }) : null,
                      (tool.parameters && tool.parameters.length > 0) ? React.createElement('div', { className: 'dsm-tool-params' }, tool.parameters.map((param) => React.createElement('div', { className: 'dsm-tool-param', key: param.key },
                          React.createElement('span', { className: 'dsm-tool-param-key' }, param.key + (param.required ? ' *' : '')),
                          React.createElement('span', { className: 'dsm-tool-param-type' }, param.type || 'any'),
                          React.createElement('span', { className: 'dsm-tool-param-desc' }, param.description || '')))) : null)))))

          const anyGroupVisible = grouped.some((entry) => entry.rows.length > 0)
          const groupsNode = (state.loading && rows.length === 0)
            ? React.createElement('div', { className: 'dsm-empty' }, mt('mcp.loading'))
            : anyGroupVisible
              ? React.createElement('div', { className: 'dsm-sources', ref: flipRef }, grouped.map((entry) => renderGroup(entry.group, entry.rows)))
              : React.createElement('div', { className: 'dsm-empty' }, (normalizedQuery || levelFilter) ? mt('mcp.empty.search') : mt('mcp.empty'))

          // 密钥框里出现打码值时给一句说明：宿主侧会拿旧真值顶替、不会把打码值写进补丁
          // （见 src/mcp/secret-guard.ts），但用户得先知道自己眼前看到的**不是原文** ——
          // 否则他会以为真密钥长这样，或者以为保存会把它改掉。
          // `!!formModal` 不能省：弹窗关着时它就是 null，这里先读 `.env` 会在每次渲染抛错。
          const maskedInForm = !!formModal && /•{3,}/.test(String(formModal.env || '') + String(formModal.headers || ''))
          const formModalNode = formModal && React.createElement(Modal, {
            key: 'mcp-form',
            title: formModal.mode === 'edit' ? mt('mcp.form.editTitle') + formModal.id : mt('mcp.form.addTitle'),
            closeLabel: mt('btn.close'),
            onClose: closeForm,
          },
              React.createElement('div', { className: 'dsm-form' },
                maskedInForm ? React.createElement(Notice, { kind: 'warn', text: mt('mcp.form.maskedHint') }) : null,
                formError ? React.createElement(Notice, { kind: 'error', text: formError }) : null,
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.serverName')),
                React.createElement('input', { className: 'dsm-control', value: formModal.serverName, placeholder: 'e.g. github', onChange: setFormField('serverName') }),
                React.createElement('span', { className: 'dsm-help' }, mt('mcp.field.serverName.hint'))),
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.transport')),
                React.createElement(SourceSelect, { value: formModal.transport, options: MCP_TRANSPORT_OPTIONS, onChange: (value) => setFormValue('transport', value) })),
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.level')),
                React.createElement(SourceSelect, {
                  value: formModal.level,
                  options: [
                    { value: 'global', label: mt('mcp.field.level.global', { path: state.paths ? state.paths.global : '~/.dsh/cordis.patch.yml' }) },
                    { value: 'project', label: mt('mcp.field.level.project', { path: state.paths ? state.paths.project : 'profiles/*/cordis.patch.yml' }) },
                  ],
                  onChange: (value) => setFormValue('level', value),
                })),
              formModal.transport === 'streamable-http'
                ? React.createElement('label', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.url')),
                    React.createElement('input', { className: 'dsm-control', value: formModal.url, placeholder: 'https://host/mcp', onChange: setFormField('url') }),
                    React.createElement('span', { className: 'dsm-help' }, mt('mcp.field.url.hint')))
                : React.createElement(React.Fragment, null,
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.command')),
                      React.createElement('input', { className: 'dsm-control', value: formModal.command, placeholder: 'npx -y @modelcontextprotocol/server-github', onChange: setFormField('command') })),
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.args')),
                      React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.args, placeholder: '-y\n@modelcontextprotocol/server-github', onChange: setFormField('args') })),
                    React.createElement('label', { className: 'dsm-field' },
                      React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.env')),
                      React.createElement('span', { className: 'dsm-help' }, mt('mcp.field.env.hint')),
                      React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.env, placeholder: 'GITHUB_TOKEN=xxx', onChange: setFormField('env') }))),
              formModal.transport === 'streamable-http'
                ? React.createElement('label', { className: 'dsm-field' },
                    React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.headers')),
                    React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.headers, placeholder: 'Authorization=Bearer xxx', onChange: setFormField('headers') }))
                : null,
              // 备注放在表单**最下面**：它是可选项，说的又是"这台怎么用"，不该插在必填的连接参数中间。
              // 默认不填 = 侧车里不产生条目；只在新增时出现（`mcpm-edit` 不碰侧车，改备注走详情里那枚
              // 输入框）。上限就是注入段的截断长度 `MCP_NOTE_MAX` —— 写多少模型就能读到多少。
              formModal.mode === 'edit' ? null : React.createElement('label', { className: 'dsm-field' },
                React.createElement('div', { className: 'dsm-budget-meta' },
                  React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.note')),
                  React.createElement('span', { className: 'dsm-char-count' }, String(formModal.note || '').length + ' / ' + MCP_NOTE_MAX)),
                React.createElement('input', { className: 'dsm-control', value: formModal.note || '', maxLength: MCP_NOTE_MAX, placeholder: mt('mcp.field.note.placeholder'), onChange: setFormField('note') }))),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy === 'form' || !formModal.serverName.trim(), onClick: submitForm }, formModal.mode === 'edit' ? mt('mcp.btn.save') : mt('mcp.btn.add'))))

          const detailStatus = detail ? liveStatus(detail.row) : null
          const detailHint = detail ? liveHint(detail.row) : null
          // 令牌没过的提示面板。**页面上一份、详情弹窗里也要有一份** —— 用户是在弹窗里点的
          // 「显示密钥」，而提示此前只长在弹窗背后：弹窗盖着它，等于没有提示（2026-09-18 用户指出）。
          //
          // 这里**不再放输入框**（用户裁定 2026-09-18）：提示右侧已经有「填写令牌」直达兼容页，
          // 那里能填写、也能设置/关闭令牌；同一件事摆两个入口，用户还得先判断该用哪个。
          // 宿主根本没配令牌时同样只给说明 + 跳转 —— 输入框按了必然失败。
          const detailNode = detail && React.createElement(Modal, {
            key: 'mcp-detail',
            wide: true,
            // 运行状态做成标题右侧的描边标签（用户裁定 2026-09-16）：状态是「一眼」信息，
            // 不该占一整块，也不该跟配置事实（是否登记在 Loader）用冒号拼成一句话。
            title: React.createElement('span', { className: 'dsm-modal-title-row' },
              mt('mcp.detail.title') + detail.row.serverName,
              React.createElement('span', { className: 'dsm-pill dsm-pill-' + detailStatus.tone }, detailStatus.text)),
            closeLabel: mt('btn.close'),
            onClose: closeDetail,
          },
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title dsm-detail-title-row' },
                mt('mcp.detail.config'),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: toggleReveal }, reveal ? mt('mcp.detail.hideSecret') : mt('mcp.detail.showSecret'))),
              React.createElement('div', { className: 'dsm-fm' },
                configRow(mt('mcp.detail.entryId'), detail.row.id),
                configRow(mt('mcp.field.level'), mt('mcp.level.' + detail.row.level)),
                configRow(mt('mcp.field.transport'), detail.row.transport || '—'),
                configRow(mt('mcp.detail.loader'), detail.row.live ? mt('mcp.detail.loader.yes') : mt('mcp.detail.loader.no')),
                detail.row.url ? configRow(mt('mcp.field.url'), detail.row.url) : null,
                detail.row.command ? configRow(mt('mcp.field.command'), detail.row.command + ((detail.row.args && detail.row.args.length) ? ' ' + detail.row.args.join(' ') : '')) : null,
                (detail.row.headers && Object.keys(detail.row.headers).length > 0) ? configRow(mt('mcp.field.headersShort'), Object.keys(detail.row.headers).map((k) => k + ': ' + detail.row.headers[k]).join('\n')) : null,
                (detail.row.env && Object.keys(detail.row.env).length > 0) ? configRow(mt('mcp.field.envShort'), Object.keys(detail.row.env).map((k) => k + ' = ' + detail.row.env[k]).join('\n')) : null)),
            // 运行状态一节只在**有可操作信息**时出现（启动失败 / 连上了但没工具）——
            // 状态本身已在标题标签里，再复述一遍就是噪音。
            detailHint ? React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title' }, mt('mcp.detail.status')),
              React.createElement('div', { className: 'dsm-feedback' + (detailStatus.tone === 'bad' ? ' dsm-error' : ' dsm-warning') }, detailHint)) : null,
            React.createElement('div', { className: 'dsm-detail-section' },
              // 字数计数摆在小标题同一行右侧：备注的上限就是注入段的截断长度（`MCP_NOTE_MAX`）。
              // 超限标红沿用记忆页描述那套（`dsm-char-over`）—— 服务端不校验备注长度，
              // 这条之前存的长备注会整条存着、注入时被截掉，得让人看得见超了多少。
              React.createElement('div', { className: 'dsm-budget-meta' },
                React.createElement('div', { className: 'dsm-detail-title' }, mt('mcp.detail.note')),
                React.createElement('span', { className: 'dsm-char-count' + (String(noteDraft || '').length > MCP_NOTE_MAX ? ' dsm-char-over' : '') }, String(noteDraft || '').length + ' / ' + MCP_NOTE_MAX)),
              React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: noteDraft, maxLength: MCP_NOTE_MAX, placeholder: mt('mcp.detail.note.placeholder'), onChange: (ev) => setNoteDraft(ev.target.value) }),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || noteDraft.trim() === String(detail.row.notes || ''), onClick: saveNote }, mt('mcp.detail.note.save')))),
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title' }, mt('mcp.detail.tools', { count: detail.loading ? '…' : (detail.tools || []).length })),
              toolListNode))


          const compactNode = compactConfirm && React.createElement(Modal, {
            key: 'mcp-compact',
            title: mt('mcp.compact.title'),
            closeLabel: mt('btn.close'),
            onClose: () => setCompactConfirm(false),
          },
            React.createElement('p', { className: 'dsm-desc' }, mt('mcp.compact.desc')),
            // 底部不再放「关闭」：头部已有一个，同一个动作两个按钮是重复（用户 2026-09-18 指出）。
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null, onClick: doCompact }, mt('mcp.compact.confirm'))))

          const confirmNode = confirmRow && React.createElement(Modal, {
            key: 'mcp-remove',
            title: mt('mcp.remove.title'),
            closeLabel: mt('btn.close'),
            onClose: () => setConfirmRow(null),
          },
            React.createElement('p', { className: 'dsm-desc' }, mt('mcp.remove.desc', { name: confirmRow.serverName })),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', onClick: confirmRemove }, mt('mcp.btn.remove'))))

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, 'MCP')),
                React.createElement('p', { className: 'dsm-desc' }, mt('mcp.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(mt, busy !== null || state.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || state.loading, onClick: () => refresh() }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.locked === true, onClick: openAdd }, mt('mcp.btn.new')),
                // 「导入」是「一次建好一批」，与新增同一个写路径（`mcpm-import`），所以场景锁定期间同样置灰。
                // 导出是只读动作，锁定期间照常用（拿配置不该要求先解锁环境）。
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.locked === true, onClick: () => setJsonImportOpen(true) }, mt('mcp.importJson.btn')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.loading, onClick: () => setJsonExportOpen(true) }, mt('mcp.exportJson.btn')),
                // 体检不改本插件的任何状态（补丁只读；streamable-http 行会向配置地址发一次
                // 连通性探测），所以锁定期间照点 —— 冻的是改动，不是"看一眼配置对不对"。
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.loading || !summary.total, onClick: () => runInspect(null) }, mt('mcp.inspect.btn')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy !== null || state.loading || state.locked === true, title: mt('mcp.btn.compact.title'), onClick: () => setCompactConfirm(true) }, mt('mcp.btn.compact')),
                // 批量启停与页头其余动作同栏（用户 2026-09-17 裁定）。场景内**照常可用**：
                // 改动会同步写进当前场景的档案（宿主 syncSwitchToScene），只有场景锁定才冻结。
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || state.loading || !summary.total, onClick: setAllServers }, mt(summary.total > 0 && summary.enabled === summary.total ? 'mcp.btn.disableAll' : 'mcp.btn.enableAll')))),
            state.locked === true ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, mt('lock.banner')) : null,
            // 场景未锁定时开关照常可用：说清「改动会同步写进该场景的档案」，别让用户担心白改。
            // 锁定期间不显示 —— 那时开关是灰的，"改动会写进档案"是句空话，与上一条锁定横幅
            // 并排还会互相矛盾（用户 2026-09-19）。
            (state.locked !== true && state.scene) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, mt('scene.switch.banner', { scene: state.scene })) : null,
            React.createElement('div', { className: 'dsm-stat-row' },
              React.createElement('div', { className: 'dsm-summary' },
                [['total', summary.total, mt('mcp.stat.total')], ['enabled', summary.enabled, mt('mcp.stat.enabled')], ['tools', summary.tools < summary.toolsTotal ? summary.tools + '/' + summary.toolsTotal : summary.tools, mt('mcp.stat.tools')]].map((item) =>
                  React.createElement('div', { key: item[0], className: 'dsm-stat' },
                    React.createElement('strong', null, item[1]), item[2])))),
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', value: query, 'aria-label': mt('mcp.search'), placeholder: mt('mcp.search.placeholder'), onChange: (ev) => setQuery(ev.target.value) }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, { value: levelFilter, options: mcpLevelOptions(), onChange: setLevelFilter }))),
            React.createElement(Notice, { kind: msg && msg.kind, text: msg && msg.text }),
            React.createElement(Notice, { kind: 'err', text: state.error }),
            React.createElement(Notice, { kind: 'warn', text: (state.errors && state.errors.length > 0) ? mt('mcp.err.warnings') + state.errors.join('；') : null }),
            React.createElement(Notice, { kind: 'warn', text: (state.warnings && state.warnings.length > 0) ? state.warnings.join('；') : null }),
            React.createElement(UndoBar, { key: 'undo', undo: undo, busy: busy !== null, t: mt, onUndo: undoSetAll, onClose: dismissUndo }),
            groupsNode,
            formModalNode,
            detailNode,
            compactNode,
            confirmNode,
            jsonImportOpen ? React.createElement(McpJsonImportModal, {
              key: 'mcp-import-json',
              t: mt,
              // 冲突标记按当前列表判（名字与 id 两张表，与服务端一致）：预览说「将新增」而服务端
              // 回头报「已存在」是最糟的结果。
              existingNames: rows.map((r) => r.serverName),
              existingIds: rows.map((r) => r.id),
              onClose: () => setJsonImportOpen(false),
              onDone: () => refresh(),
            }) : null,
            jsonExportOpen ? React.createElement(McpJsonExportModal, { key: 'mcp-export-json', t: mt, onClose: () => setJsonExportOpen(false) }) : null)
        }

        // ---------- AGENTS.md 预设页：多套全局指令基线，应用=写入 ~/.dsh/AGENTS.md ----------
        function PromptsPage() {
          // deny = 一次性「拒绝」说明（如：被引用的预设不能删）。它**不替换列表**——
          // 复用 error 会让整页列表消失，用户删不动之后连列表都看不到了。
          var st = React.useState({ loading: true, error: null, presets: [], current: null, deny: null })
          var state = st[0], setState = st[1]
          // 搜索词独立一处：`state` 在 refresh 时被整对象替换（见下方 setState({...})），
          // 寄在它里面的话每次刷新搜索词都会被清空。过滤用防抖值，输入框仍绑原值。
          var pq = React.useState(''), query = pq[0], setQuery = pq[1]
          var dq = useDebouncedValue(query)
          var busyState = React.useState(null), busy = busyState[0], setBusy = busyState[1]
          var em = React.useState(null), editModal = em[0], setEditModal = em[1]
          var cm = React.useState(null), createModal = cm[0], setCreateModal = cm[1]
          var ac = React.useState(null), applyConfirm = ac[0], setApplyConfirm = ac[1]
          // 回收站：null = 关闭；{loading, error, entries}
          var ts = React.useState(null), trash = ts[0], setTrash = ts[1]
          var tb = React.useState(false), trashBusy = tb[0], setTrashBusy = tb[1]
          // D14：导出弹窗（null = 关闭；{busy, result}）。
          var xo = React.useState(null), exportState = xo[0], setExportState = xo[1]
          var flipRef = React.useRef(null)
          useFlipReorder(flipRef)
          // ── 快捷提示词（用户存好的现成文字，只在对话框 `/` 菜单里由自己点出来）────
          // 独立一处状态，不塞进上面的 `state`：那边 `refresh()` 是整对象替换，两份数据混在
          // 一次替换里更容易漏；而快捷列表读失败不该把预设列表一起打成错误页。
          var qs = React.useState({ loading: true, error: null, prompts: [] })
          var quick = qs[0], setQuick = qs[1]
          var qk = React.useState(null), quickEdit = qk[0], setQuickEdit = qk[1]
          var qf = React.useState(null), quickConfirm = qf[0], setQuickConfirm = qf[1]
          function refreshQuick() {
            apiCall('quickprompt-list', {})
              .then(function (res) {
                if (res && res.ok) setQuick({ loading: false, error: null, prompts: res.prompts || [] })
                else setQuick({ loading: false, error: (res && res.error) || t('mcp.msg.loadFailed'), prompts: [] })
              })
              .catch(function (e) { setQuick({ loading: false, error: errMsg(e), prompts: [] }) })
          }
          /** 打开/刷新回收站（两个提示词域一起列：点一次「回收站」要看全）。 */
          function loadTrash(keepOpen) {
            var prev = keepOpen ? trash || {} : {}
            setTrash(Object.assign({ loading: true, error: null, presets: [], quick: [] }, prev))
            var read = function (op) {
              return apiCall(op, {}).catch(function (e) { return { ok: false, error: errMsg(e) } })
            }
            Promise.all([read('agentsmd-trash-list'), read('quickprompt-trash-list')]).then(function (both) {
              var errs = []
              if (!both[0] || both[0].ok === false) errs.push((both[0] && both[0].error) || t('trash.loadFailed'))
              if (!both[1] || both[1].ok === false) errs.push((both[1] && both[1].error) || t('trash.loadFailed'))
              setTrash({
                loading: false, error: errs.length ? errs.join(t('agm.ref.sep')) : null,
                presets: ((both[0] && both[0].trash) || []).map(function (e) { return Object.assign({ kind: 'presets' }, e) }),
                quick: ((both[1] && both[1].trash) || []).map(function (e) { return Object.assign({ kind: 'quick' }, e) }),
              })
            })
          }
          /** 回收站两个域共用一套按钮：条目自带 `kind`，op 名按它挑（不再各写一份恢复/永久删除）。 */
          function trashOp(item, action) {
            return item.kind === 'quick' ? 'quickprompt-trash-' + action : 'agentsmd-trash-' + action
          }
          function restorePreset(item) {
            setTrashBusy(true)
            apiCall(trashOp(item, 'restore'), { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: t('trash.restored', { name: item.name }) } }) }); refresh(); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: errMsg(e) }) }) })
          }
          function purgePreset(item) {
            setTrashBusy(true)
            apiCall(trashOp(item, 'delete'), { id: item.id }).then(function (res) {
              setTrashBusy(false)
              if (res && res.ok) { setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: t('trash.purged', { name: item.name }) } }) }); loadTrash(true) }
              else setTrash(function (cur) { return Object.assign({}, cur, { error: (res && res.error) || t('mcp.msg.failed') }) })
            }).catch(function (e) { setTrashBusy(false); setTrash(function (cur) { return Object.assign({}, cur, { error: errMsg(e) }) }) })
          }
          // 导入：与技能页同一个 ImportModal（拖拽区 + 文件要求清单 + 结果反馈）。
          // 一次可选多份 .md，逐个读取正文导入；同名/失败逐条回报，不因一个失败中断其余的。
          // 两个提示词域共用这一颗按钮，类型在弹窗顶部选（`extra` 槽）—— 选完导入的是哪一档
          // 就写进哪一档，不靠"看当前在哪个分组"猜。
          var impOpenState = React.useState(false); var importOpen = impOpenState[0], setImportOpen = impOpenState[1]
          var impBusyState = React.useState(false); var importBusy = impBusyState[0], setImportBusy = impBusyState[1]
          var impResultState = React.useState(null); var importResult = impResultState[0], setImportResult = impResultState[1]
          var impKindState = React.useState('global'); var importKind = impKindState[0], setImportKind = impKindState[1]
          /**
           * 「全局提示词 / 快捷提示词」二选一的勾选行（与兼容页同款打勾框）。
           *
           * 为什么放在弹窗里而不是页头：这两类东西的**读法完全不同**（一份会覆盖写全局
           * AGENTS.md、一份只是贴进对话框的文字），把它们混进同一个列表再打标签，用户要先
           * 看懂标签才知道点下去会发生什么。新建与导入都先问一次，问在最贴近动作的地方。
           *
           * 两颗框恒有一棵勾着（点已勾着的那颗不改状态）—— 没有"都不选"这一态，所以是
           * 单选的语义、打勾框的样子。
           */
          function kindPicker(value, onChange) {
            const pick = function (kind) {
              return React.createElement('label', { className: 'dsm-kind-pick' },
                React.createElement('input', { type: 'checkbox', checked: value === kind, onChange: function () { onChange(kind) } }),
                t('prompts.kind.' + kind))
            }
            return React.createElement('div', { className: 'dsm-field' },
              React.createElement('span', { className: 'dsm-label' }, t('prompts.kind.label')),
              React.createElement('div', { className: 'dsm-kind-picks' }, pick('global'), pick('quick')),
              React.createElement('p', { className: 'dsm-help' }, t(value === 'quick' ? 'prompts.kind.quick.hint' : 'prompts.kind.global.hint')))
          }
          function importIdOf(name) {
            return String(name || '').replace(/\.(md|markdown|txt)$/i, '').trim().replace(/[\\/<>:"|?*]+/g, '-') || 'imported'
          }
          function doImportFiles(files) {
            var list = Array.prototype.slice.call(files || [])
            if (!list.length) return
            setImportBusy(true); setImportResult(null)
            var done = [], failed = []
            var quickIn = importKind === 'quick'
            var chain = Promise.resolve()
            list.forEach(function (file) {
              chain = chain.then(function () {
                return file.text().then(function (text) {
                  var id = importIdOf(file.name)
                  return apiCall(quickIn ? 'quickprompt-create' : 'agentsmd-import', { id: id, content: String(text) }).then(function (res) {
                    if (res && res.ok) done.push(res.id || id)
                    else failed.push(String(file.name) + '（' + ((res && res.error) || '') + '）')
                  })
                })
              }).catch(function (e) { failed.push(String(file.name) + '（' + errMsg(e) + '）') })
            })
            chain.then(function () {
              setImportBusy(false)
              if (!done.length) setImportResult({ ok: false, text: failed.length ? t('import.skipped', { items: failed.join('、') }) : t('import.none') })
              else setImportResult({
                ok: true, warning: failed.length > 0,
                text: t('agm.result.imported', { count: done.length, names: done.join('、') }) + (failed.length ? t('import.skipped', { items: failed.join('、') }) : ''),
              })
              refresh()
            })
          }

          function refresh(silent) {
            // 手动刷新（含首次加载）要把按钮切到「刷新中…」——点完毫无反馈等于没点。
            // 页面内部那些「操作完顺手重读」的调用传 silent，免得按钮每次都闪一下。
            if (!silent) setState(function (s) { return Object.assign({}, s, { loading: true }) })
            refreshQuick()
            apiCall('agentsmd-list', {}).then(function (res) {
              // 刷新即清掉上一次的「拒绝」说明（它解释的是那一次点击，不是常驻状态）。
              setState(function (s) { return { loading: false, error: res && res.ok ? null : ((res && res.error) || mt('mcp.msg.loadFailed')), presets: (res && res.presets) || [], current: s.current, scenePrompt: (res && res.scenePrompt) || null, anyLocked: (res && res.anyLocked) === true, deny: res && res.ok ? null : s.deny } })
            }).catch(function (e) { setState({ loading: false, error: errMsg(e), presets: [], current: null, scenePrompt: null, deny: null }) })
            apiCall('agentsmd-get-current', {}).then(function (res) {
              if (res && res.ok) setState(function (s) { return Object.assign({}, s, { current: res }) })
              else actionFailed(res)
            }).catch(actionFailed)
          }
          /**
           * 局部操作的失败出口。这些调用原先一律 `.catch(function () {})` —— 点了没反应，
           * 用户只能猜是「还没加载完」还是「坏了」（编辑按钮尤其：读不到正文就什么都不发生）。
           * 走一次性提示条，不顶掉列表（`state.error` 走的是三分支里的一支，会把列表换成错误页）。
           */
          function actionFailed(resOrErr) {
            var text = (resOrErr && resOrErr.ok === false)
              ? translateError(t, resOrErr)
              : errMsg(resOrErr)
            setState(function (s) { return Object.assign({}, s, { notice: { kind: 'err', text: t('error.action', { error: text }) } }) })
          }
          React.useEffect(function () { refresh() }, [])

          var cur = state.current
          // 场景接管基线时（scenePrompt 指向某个启用场景的绑定），提示词页的「应用」只对
          // 场景绑定的那一份可用：应用别的预设会绕过场景绑定，造成「场景页显示 A、实际注入 B、
          // A 不能删而 B 能删」这类各说各话的状态（用户实测）。同一份 = 「重新应用」
          // （把被手改的 AGENTS.md 写回场景绑定的内容）→ 仍放行。
          var sceneDriver = state.scenePrompt && state.scenePrompt.scene && state.scenePrompt.presetId && state.scenePrompt.missing !== true ? state.scenePrompt : null
          var sceneDriverLabel = sceneDriver ? (sceneDriver.label || sceneDriver.scene) : ''
          /** 引用说明：判定在宿主（scene-prompt-sync），这里只负责把它说成人话。 */
          function refText(r) {
            if (r.kind === 'scene') return t(r.active ? 'agm.ref.sceneActive' : 'agm.ref.scene', { scene: r.label || r.scene })
            if (r.kind === 'restore') return t('agm.ref.restore')
            return t('agm.ref.file')
          }
          function refsOf(p) { return (p.refs || []).map(refText) }
          // 结果提示的存续时长：**成功**短暂显示（与场景页的结果条同一节奏），
          // **失败常驻**到下一次操作为止 —— 这正是 Notice 的既定语义（「警告 / 错误需要
          // 用户处理，常驻到下一次操作」）。此前不分种类一律 4 秒消失，等于把唯一的线索
          // 丢掉：令牌没过时用户还要点提示右侧的「填写令牌」，提示先没了就什么都做不了
          // （2026-09-19 用户实测）。
          React.useEffect(function () {
            if (!state.notice || state.notice.kind !== 'ok') return undefined
            var timer = setTimeout(function () { setState(function (s) { return Object.assign({}, s, { notice: null }) }) }, 4000)
            return function () { clearTimeout(timer) }
          }, [state.notice])

          /**
           * 开始一次新操作：把上一次的结果提示收起来。
           *
           * 结果提示的存续规则是「常驻到下一次操作」（见 Notice 的说明），这句话要成立
           * 就得有人来收 —— 否则一次失败会一直挂在页面上，直到用户离开这个页签。
           */
          function beginAction() {
            setState(function (s) { return Object.assign({}, s, { notice: null }) })
          }
          function openEdit(p) {
            beginAction()
            // id 可改：改名 = 目录改名，宿主会把场景绑定一起改名（见 rules-rebind-prompt）。
            apiCall('agentsmd-read', { id: p.id }).then(function (res) {
              if (res && res.ok) setEditModal({ id: p.id, nextId: p.id, content: res.content, description: p.description || '' })
              else actionFailed(res)
            }).catch(actionFailed)
          }
          function doApply(id) {
            beginAction()
            setBusy('apply-' + id)
            // 应用会写全局基线（接管期间还可能改绑场景），失败必须可见 —— 静默返回会让
            // 用户以为已写入（按钮恢复可点，文件却没变）。与 doRemove 同一套显示路径。
            //
            // ⚠️ 失败**不能**写进 `state.error`：那一支是「列表加载失败」的位置，会把整份
            // 预设列表换成一条错误横幅 —— 统计还在（读的是 state.presets）、列表没了，看起来
            // 就像「提示词被覆盖了」（用户实测 2026-09-19，令牌没过时点「重新应用」即如此）。
            // 走 actionFailed 的一次性横幅：可见、不顶掉列表。
            apiCall('agentsmd-apply', { id: id }).then(function (res) {
              setBusy(null); setApplyConfirm(null)
              if (res && res.ok === false) actionFailed(res)
              else refresh()
            }).catch(function (e) { setBusy(null); setApplyConfirm(null); actionFailed(e) })
          }
          function doRemove(p) {
            beginAction()
            setBusy('rm-' + p.id)
            // 宿主会拒绝删除「正在生效」的预设（按钮已禁用，这里兜住旧页面/竞态），
            // 因此必须把响应里的错误显示出来，不能静默什么都不发生。
            apiCall('agentsmd-remove', { id: p.id }).then(function (res) {
              setBusy(null); setApplyConfirm(null)
              if (res && res.ok === false) actionFailed(res)
              else refresh()
            }).catch(function (e) { setBusy(null); setApplyConfirm(null); actionFailed(e) })
          }
          function doCreate(id, content, description) {
            beginAction()
            setBusy('create')
            if (createModal && createModal.kind === 'quick') {
              // 快捷提示词：正文原样存。没有"空模板"也没有"从现有复制"——那两个概念都属于
              // 会覆盖全局 AGENTS.md 的基线预设，套到快捷词上只会让人以为贴进对话框的文字会被注入。
              apiCall('quickprompt-create', {
                id: id, content: String(content || ''), description: String(description == null ? '' : description),
              }).then(function (res) {
                setBusy(null)
                if (res && res.ok) { setCreateModal(null); refreshQuick() }
                else if (res) setCreateModal(Object.assign({}, createModal, { error: res.error }))
              }).catch(function () { setBusy(null) })
              return
            }
            // 留空 = 宿主那一份空白模板（`agentsmd-create` 自己的默认）。
            apiCall('agentsmd-create', {
              id: id,
              ...(content ? { content: content } : {}),
              // 描述存 meta.json，**不写进 AGENTS.md**（那个文件的正文会被原样注入）。
              // 0.14.0 起模型也在 `prompt_manager_list` 的清单里看得到它，所以有了字数上限
              // （输入框那枚 maxLength / 计数就是它）。
              description: String(description == null ? '' : description),
            }).then(function (res) {
              setBusy(null)
              if (res && res.ok) { setCreateModal(null); refresh() }
              else if (res) setCreateModal(Object.assign({}, createModal, { error: res.error }))
            }).catch(function () { setBusy(null) })
          }
          function doUpdate() {
            beginAction()
            setBusy('update')
            apiCall('agentsmd-update', { id: editModal.id, nextId: String(editModal.nextId || editModal.id), content: editModal.content, description: String(editModal.description == null ? '' : editModal.description) }).then(function (res) {
              setBusy(null)
              if (res && res.ok) {
                setEditModal(null)
                if (res.renamedFrom) setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: t('agm.result.renamed', { id: res.id }) + (res.reboundScenes ? t('agm.result.rebound', { count: res.reboundScenes }) : '') } }) })
                refresh()
              } else if (res) setEditModal(Object.assign({}, editModal, { error: res.error }))
            }).catch(function () { setBusy(null) })
          }
          /**
           * 快捷提示词的编辑与删除。
           *
           * 打开编辑**不再发一次读请求**：`quickprompt-list` 连正文一起回（服务端那份清单的
           * 理由见 `src/prompts/quick-service.ts` 头注 —— `/` 菜单点的时候要当场有字可插），
           * 预设那边要单独 `agentsmd-read` 是因为它的 list 只有元信息。
           * 改名也不牵连别处：快捷提示词不被场景绑定、不被引用，改完就是改完。
           */
          function openQuickEdit(p) {
            beginAction()
            setQuickEdit({ id: p.id, nextId: p.id, content: p.content || '', description: p.description || '' })
          }
          function doQuickUpdate() {
            beginAction()
            setBusy('quick-update')
            apiCall('quickprompt-update', {
              id: quickEdit.id, nextId: String(quickEdit.nextId || quickEdit.id),
              content: quickEdit.content, description: String(quickEdit.description == null ? '' : quickEdit.description),
            }).then(function (res) {
              setBusy(null)
              if (res && res.ok) { setQuickEdit(null); refreshQuick() }
              else if (res) setQuickEdit(Object.assign({}, quickEdit, { error: res.error }))
            }).catch(function () { setBusy(null) })
          }
          function doQuickRemove(id) {
            beginAction()
            setBusy('quick-remove')
            apiCall('quickprompt-remove', { id: id }).then(function (res) {
              setBusy(null); setQuickConfirm(null)
              if (res && res.ok) refreshQuick()
              else if (res) actionFailed(res)
            }).catch(function (e) { setBusy(null); setQuickConfirm(null); actionFailed(e) })
          }
          /**
           * 那颗开关：只改"这条在不在对话框 `/` 菜单里出现"，正文与备注一个字不动。
           * 与子智能体那一档同一条口径：成功不弹提示（列表重读后开关自己翻过来），失败要说人话。
           */
          function toggleQuick(p) {
            beginAction()
            const next = p.enabled === false
            setBusy('quick-toggle-' + p.id)
            apiCall('quickprompt-toggle', { id: p.id, enabled: next }).then(function (res) {
              setBusy(null)
              if (res && res.ok) refreshQuick()
              else if (res) actionFailed(res)
            }).catch(function (e) { setBusy(null); actionFailed(e) })
          }
          // 只有「还没有任何内容」时才让加载占位顶掉列表：手动点刷新时列表不该凭空消失，
          // 反馈由刷新按钮自己的「刷新中…」承担（与记忆页 / 技能页同一口径）。
          // 过滤只跟数据与（防抖后的）搜索词有关：每次渲染重扫一整份列表没有必要。
          var visiblePresets = React.useMemo(function () {
            return state.presets.filter(function (p) { return matchPresetQuery(p, dq) })
          }, [state.presets, dq])
          // 启用的排前面（用户要求）：与过滤分开记忆 —— 分区只跟过滤结果有关，弹窗/提示条之类
          // 的状态变化不再重跑它（FLIP 的 data-flip-on 仍来自 p.active，未动）。
          var orderedPresets = React.useMemo(function () {
            return enabledFirst(visiblePresets, function (p) { return !!p.active; })
          }, [visiblePresets])
          var activeCount = React.useMemo(function () {
            return state.presets.filter(function (p) { return p.active }).length
          }, [state.presets])
          var visibleQuick = React.useMemo(function () {
            return quick.prompts.filter(function (p) { return matchPresetQuery(p, dq) })
          }, [quick.prompts, dq])
          // 与上面预设那一档同一条口径：亮着的排前面。关掉的照样列着（那只是"不在 `/` 菜单里出现"，
          // 不是删掉），沉到底部是为了让常用的那几条留在第一眼。
          var orderedQuick = React.useMemo(function () {
            return enabledFirst(visibleQuick, function (p) { return p.enabled !== false })
          }, [visibleQuick])
          // ── 两组都是**可折叠卡片**（用户 2026-10-01 裁定：做成技能那样）──────────
          // 默认展开；打了字强制展开 —— 卡片收着的话搜索结果一行都看不见（技能页 / MCP 页同口径）。
          var cg = React.useState({})
          var groupsCollapsed = cg[0], setGroupsCollapsed = cg[1]
          function toggleGroup(key) {
            // 翻的是**收起标记本身**：`groupsCollapsed[key] === true` 才是收着的。
            // 写成 `!(groupsCollapsed[key] !== true)` 的话，展开态下算出来是 `false`，
            // 而 `false` 在这张表里的意思正是"没收起" —— 每次点击把同一个值写回去，卡片收不起来。
            setGroupsCollapsed(function (prev) { return Object.assign({}, prev, { [key]: prev[key] !== true }) })
          }
          /** 一张分组卡片：标题 + 条数（点标题行收起/展开）+ 右侧动作 + 展开时的卡片体。 */
          function groupCard(key, label, count, actions, bodyNode) {
            var open = groupsCollapsed[key] !== true || !!dq
            return React.createElement('section', { key: key, className: 'dsm-source' },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: function () { toggleGroup(key) } },
                  React.createElement('span', { className: 'dsm-source-title', title: label }, label),
                  React.createElement('span', { className: 'dsm-count' }, t('trash.items.count', { count: count }))),
                actions ? React.createElement('div', { className: 'dsm-source-actions' }, actions) : null),
              open ? React.createElement('div', { className: 'dsm-source-body' }, bodyNode) : null)
          }
          /**
           * 快捷那组的「全选 / 取消全选」：只作用于**当前可见**的那几条（与技能页那颗同一条口径），
           * 目标集 = 状态与"这一组现在是不是全开"相反的行。点完顺带把卡片展开 —— 收着的话
           * 到底改了哪几条看不见。
           *
           * 全局那一组**不给**这颗按钮（用户 2026-10-01 明确裁定）：那一档是单选，
           * "把所有基线都应用"根本没有意义 —— 应用一份就是关掉其余每一份。
           */
          function toggleQuickBulk() {
            var list = visibleQuick
            if (!list.length) return
            var turnOn = !list.every(function (p) { return p.enabled !== false })
            var targets = list.filter(function (p) { return (p.enabled !== false) !== turnOn })
            if (!targets.length) return
            beginAction()
            setGroupsCollapsed(Object.assign({}, groupsCollapsed, { quick: false }))
            setBusy('quick-bulk')
            // 逐条走同一个 `quickprompt-toggle`（不新增批量 op）：每条都要能被场景档案同步跟上
            // （登记表里那颗 syncsArchive），自己拼一条批量通道就会把这件事漏掉。
            Promise.all(targets.map(function (p) {
              return apiCall('quickprompt-toggle', { id: p.id, enabled: turnOn })
                .catch(function (e) { return { ok: false, error: errMsg(e) } })
            })).then(function (all) {
              setBusy(null)
              refreshQuick()
              var bad = all.filter(function (r) { return !r || r.ok !== true }).length
              if (bad) setState(function (s) { return Object.assign({}, s, { notice: { kind: 'err', text: t('prompts.bulk.failed', { done: all.length - bad, failed: bad }) } }) })
            })
          }
          var quickAllOn = visibleQuick.length > 0 && visibleQuick.every(function (p) { return p.enabled !== false })
          var quickBulkButton = React.createElement('button', {
            type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk',
            disabled: busy !== null || state.anyLocked === true || !visibleQuick.length,
            title: t('prompts.bulk.quick'),
            onClick: toggleQuickBulk,
          }, bulkPair(t(quickAllOn ? 'bulk.unselectAll' : 'bulk.selectAll'), t(quickAllOn ? 'bulk.selectAll' : 'bulk.unselectAll')))
          function renderQuick(p) {
            return React.createElement('div', { key: p.id, className: 'dsm-source', 'data-flip-key': 'q:' + p.id },
              React.createElement('div', { className: 'dsm-source-head' },
                // 与子智能体行同一形状：名字一行、备注一行，都在头部里 —— 备注不再单独占一条
                // 带分隔线的卡片底（用户 2026-09-30 要求少占空间）。
                // 不挂「生效中」那类标签：快捷提示词不写 AGENTS.md、不进上下文，它唯一的两种状态
                // （在不在 `/` 菜单里出现）就是左边那颗开关。
                React.createElement('div', { className: 'dsm-source-head-main dsm-persona-main' },
                  React.createElement('div', { className: 'dsm-persona-name-row' },
                    React.createElement('span', { className: 'dsm-source-title', title: p.id }, p.id)),
                  p.description ? React.createElement('div', { className: 'dsm-persona-desc', title: p.description }, p.description) : null),
                React.createElement('div', { className: 'dsm-source-actions' },
                  React.createElement(Switch, {
                    on: p.enabled !== false,
                    disabled: busy !== null || state.anyLocked === true,
                    label: t('quickprompt.toggle') + ' ' + p.id,
                    title: t('quickprompt.toggle.hint'),
                    onClick: function () { toggleQuick(p) } }),
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: state.anyLocked === true, onClick: function () { openQuickEdit(p) } }, t('agm.btn.edit')),
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy !== null || state.anyLocked === true, title: state.anyLocked === true ? t('scenes.lock.blockedEdit') : '', onClick: function () { setQuickConfirm({ id: p.id }) } }, t('agm.btn.delete')))))
          }
          // 快捷提示词那一组。整段独立于上面的 `body`：它读失败只红自己那一组，
          // 不该把预设列表一起打成错误页（两件事各自有各自的结论）。
          var quickSection = groupCard('quick', t('prompts.group.quick'), quick.prompts.length, quickBulkButton,
            quick.error
              ? React.createElement(Notice, { kind: 'err', text: quick.error })
              : !quick.prompts.length
                ? React.createElement('div', { className: 'dsm-empty' }, t('quickprompt.empty'))
                : !visibleQuick.length
                  ? React.createElement('div', { className: 'dsm-empty' }, t('agm.empty.search'))
                  : React.createElement('div', { className: 'dsm-sources' }, orderedQuick.map(renderQuick)))
          var body = state.loading && !state.presets.length
            ? React.createElement('div', { className: 'dsm-empty' }, t('agm.loading'))
            : state.error
              ? React.createElement(Notice, { kind: 'err', text: state.error })
              : !state.presets.length
                ? React.createElement('div', { className: 'dsm-empty' }, t('agm.empty'))
                : !visiblePresets.length
                  ? React.createElement('div', { className: 'dsm-empty' }, t('agm.empty.search'))
                  : React.createElement('div', { className: 'dsm-sources', ref: flipRef }, orderedPresets.map(function (p) {
                    // 「生效中」= 当前真正在起作用的基线：启用的场景绑了它，就是它（用户裁定）；
                    // 否则看文件比对。p.fileApplied 单独留着，说明「AGENTS.md 里确实是它」。
                    var viaScene = p.activeVia === 'scene'
                    var refs = p.refs || []
                    var restoreRef = refs.some(function (r) { return r.kind === 'restore' })
                    var refTexts = refsOf(p)
                    // 场景绑的就是它，但 AGENTS.md 里的内容不是它（被手改过？）→ 说清楚，
                    // 并留"再点一次那颗开关"这条路写回。
                    var fileMismatch = !!sceneDriver && sceneDriver.presetId === p.id && !p.fileApplied
                    // 场景接管的是**别的**预设时，应用这一份 = 把该场景改绑到它（用户裁定
                    // 2026-09-17：未锁定时切换要可用，并且同步写进场景档案），所以不再拦截；
                    // 只在 title 里把后果说出来，用户点了才知道会发生什么。
                    var applyRebinds = !!sceneDriver && sceneDriver.presetId !== p.id
                    return React.createElement('div', { key: p.id, className: 'dsm-source', 'data-flip-key': p.id, 'data-flip-on': p.active ? '1' : '0' },
                      React.createElement('div', { className: 'dsm-source-head' },
                        // 与子智能体行同一形状：名字（带标签）一行、备注一行，都在头部里 ——
                        // 备注不再单独占一条带分隔线的卡片底（用户 2026-09-30 要求少占空间）。
                        React.createElement('div', { className: 'dsm-source-head-main dsm-persona-main' },
                          React.createElement('div', { className: 'dsm-persona-name-row' },
                            React.createElement('span', { className: 'dsm-source-title', title: p.id }, p.id),
                            p.active ? React.createElement('span', { className: 'dsm-tag dsm-tag-on', title: viaScene ? t('agm.active.hint.scene', { scene: (state.scenePrompt && state.scenePrompt.label) || (state.scenePrompt && state.scenePrompt.scene) || '' }) : t('agm.active.hint.file') }, t('agm.active')) : null,
                            !p.active && p.fileApplied ? React.createElement('span', { className: 'dsm-tag', title: t('agm.file.applied.hint') }, t('agm.file.applied')) : null,
                            fileMismatch ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('agm.file.mismatch.hint') }, t('agm.file.mismatch')) : null,
                            // 场景绑定**不在这里标标签**（用户裁定）：多场景绑同一份时标签会把行挤爆；
                            // 谁在引用它，点「删除」时会逐条说出来（`agm.btn.delete.blocked.refs`）。
                            restoreRef ? React.createElement('span', { className: 'dsm-tag', title: t('agm.restore.tag.hint') }, t('agm.restore.tag')) : null),
                          p.description ? React.createElement('div', { className: 'dsm-persona-desc', title: p.description }, p.description) : null),
                        React.createElement('div', { className: 'dsm-source-actions' },
                          // 「应用 / 重新应用」换成与子智能体同一颗药丸开关（用户 2026-09-30 裁定）：
                          // 那一档是单选，屏幕上永远只有一份生效中 —— 开关说的正是这件事，而两颗文字
                          // 按钮把"当前是哪份"留给标签去猜。关不掉是**语义**不是缺功能：基线没有
                          // "全部不应用"这一态，所以点已亮着的那颗 = 重新写回（把被手改的 AGENTS.md
                          // 拉回来），与旧「重新应用」同一个出口，确认弹窗也照旧。
                          React.createElement(Switch, {
                            on: p.active === true,
                            disabled: busy !== null || state.anyLocked === true,
                            label: t('agm.apply.switch') + ' ' + p.id,
                            title: applyRebinds ? t('agm.apply.rebindScene', { scene: sceneDriverLabel })
                              : p.active ? t('agm.apply.switch.on') : t('agm.apply.hint'),
                            onClick: function () { setApplyConfirm({ id: p.id }) } }),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: state.anyLocked === true, onClick: function () { openEdit(p) } }, t('agm.btn.edit')),
                          React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy !== null || state.anyLocked === true, title: refTexts.length > 0 ? t('agm.btn.delete.blocked.refs', { refs: refTexts.join(t('agm.ref.sep')) }) : t('scenes.lock.blockedEdit'), onClick: function () {
                            // 被引用的预设**点得动但删不掉**：当面说出「谁在用」，而不是让用户对着
                            // 禁用按钮猜（disabled 的按钮连 title 都不弹）。宿主侧同样拒绝，这里只是先说。
                            if (refTexts.length > 0) { setState(function (s) { return Object.assign({}, s, { deny: t('agm.btn.delete.blocked.refs', { refs: refTexts.join(t('agm.ref.sep')) }) }) }); return }
                            setApplyConfirm({ id: p.id, remove: true })
                          } }, t('agm.btn.delete')))))
                  }))

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('tabs.prompts'))),
                React.createElement('p', { className: 'dsm-desc' }, t('prompts.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, state.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: state.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.anyLocked === true, onClick: function () { setCreateModal({ kind: 'global', id: '', content: '', description: '', error: null }) } }, t('agm.btn.new')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || state.anyLocked === true, onClick: function () { setImportResult(null); setImportOpen(true) } }, t('agm.btn.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || !(state.presets.length || quick.prompts.length), onClick: function () { setExportState({ busy: false, result: null }) } }, t('export.presets')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { loadTrash(false) } }, t('trash.btn.open')))),
            state.anyLocked === true ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('lock.banner')) : null,
            // 场景接管时把「为什么应用按钮点不动」直接写出来，而不是让用户对着置灰的按钮猜。
            // **锁定期间不显示**：那时「应用别的预设会改绑场景」是句空话（按钮全灰），与上面
            // 那条锁定横幅并排还会互相矛盾 —— MCP / 技能 / 子智能体 / 记忆四页都是
            // 「锁定时只显示锁定横幅」，提示词页此前漏了这层互斥，于是同一件事说了两遍
            // （用户 2026-09-19 截图：提示词页两条黄条，其他管理页只有一条）。
            (state.anyLocked !== true && sceneDriver) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('agm.sceneLock.notice', { scene: sceneDriverLabel, id: sceneDriver.presetId })) : null,
            // 一次性拒绝说明（被引用的预设删不掉）：不替换列表，只加一条横幅。
            state.deny ? React.createElement(Notice, { kind: 'warn', text: state.deny }) : null,
            // 三枚指标：两类各自计数 + 生效中。第一枚的文案点明「全局」—— 页面上现在有两类
            // 提示词，只说「个提示词」会让用户以为快捷那几条没被算进来。
            React.createElement('div', { className: 'dsm-summary', style: { '--dsm-stat-cols': '3' } },
              [['total', state.presets.length, t('agm.stat.total')], ['active', activeCount, t('agm.stat.active')],
                ['quick', quick.prompts.length, t('quickprompt.stat')]].map(function (item) {
                return React.createElement('div', { key: item[0], className: 'dsm-stat' },
                  React.createElement('strong', null, item[1]), item[2])
              })),
            // 搜索框：统计条之后、列表之前（与 MCP / 技能 / 记忆页同一位置与样式）。
            // 只放一个输入框、没有第二个筛选器，就不套 `dsm-source-filter`（宽度交给 CSS）。
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', {
                className: 'dsm-control dsm-search', value: query, 'aria-label': t('search'),
                placeholder: t('agm.search.placeholder'),
                onChange: function (e) { setQuery(e.target.value) },
              })),
            // 两段各一张可折叠卡片：卡片头是组名 + 条数（点它收起/展开），卡片体里才是条目。
            groupCard('global', t('prompts.group.global'), state.presets.length, null, body),
            quickSection,
            state.notice ? React.createElement(Notice, { kind: state.notice.kind, text: state.notice.text }) : null,
            exportState ? React.createElement(ExportModal, {
              key: 'export', t: t, title: t('export.presets'),
              // 两类一起列、按类分组（键前缀 `q:` 标快捷）：勾完一次就能把两类都带走，
              // 不必为了导另一类再开一次弹窗。
              items: state.presets.map(function (p) { return { key: p.id, name: p.id, desc: p.description || '', group: t('prompts.group.global') } })
                .concat(quick.prompts.map(function (p) { return { key: 'q:' + p.id, name: p.id, desc: p.description || '', group: t('prompts.group.quick') } })),
              busy: exportState.busy, result: exportState.result,
              onClose: function () { setExportState(null) },
              onSubmit: function (names, outDir) {
                setExportState({ busy: true, result: null })
                var quickIds = [], presetIds = []
                names.forEach(function (k) {
                  if (String(k).indexOf('q:') === 0) quickIds.push(String(k).slice(2))
                  else presetIds.push(String(k))
                })
                var calls = []
                if (presetIds.length) calls.push({ kind: 'presets', call: apiCall('bundle-export', { kind: 'presets', names: presetIds, outDir: outDir }) })
                if (quickIds.length) calls.push({ kind: 'quick-prompts', call: apiCall('bundle-export', { kind: 'quick-prompts', names: quickIds, outDir: outDir }) })
                Promise.all(calls.map(function (c) { return c.call.catch(function (e) { return { ok: false, error: errMsg(e) } }) })).then(function (all) {
                  // 两类各打一个 zip（文件名里带 kind，不会互相覆盖）。两份结果都要说出来：
                  // 只报第一个就是"看起来全导了"，而第二个可能根本没写出去。
                  var texts = all.map(function (res, i) {
                    var one = res && res.ok ? exportResultText(t, res) : translateError(t, res)
                    return calls.length > 1 ? t(calls[i].kind === 'presets' ? 'prompts.group.global' : 'prompts.group.quick') + '：' + one : one
                  })
                  var okAll = all.length > 0 && all.every(function (res) { return res && res.ok })
                  setExportState({ busy: false, result: { ok: okAll, warning: okAll && all.some(function (r) { return (r.missing || []).length }) }, text: texts.join('；') })
                })
              },
            }) : null,
            trash ? React.createElement(TrashModal, {
              t: t,
              title: t('trash.title'),
              // 两组一起列：回收站是"找回被删的东西"的地方，让用户先猜它在哪个域里再切弹窗，
              // 等于把恢复这条路堵在自己手里。
              groups: [
                { title: t('trash.group.presets'), sub: t('trash.section.presets.sub'), entries: trash.presets || [] },
                { title: t('trash.group.quick'), sub: t('trash.section.quick.sub'), entries: trash.quick || [] },
              ],
              locked: state.anyLocked === true,
              loading: trash.loading,
              error: trash.error,
              busy: trashBusy,
              onClose: function () { setTrash(null) },
              onRestore: restorePreset,
              onPurge: purgePreset,
            }) : null,
            // 编辑：id 与内容都可改（改 id = 目录改名，场景绑定由宿主一起改名）。
            editModal ? React.createElement(Modal, { title: t('agm.edit.title') + ' · ' + editModal.id, closeLabel: t('btn.close'), onClose: function () { setEditModal(null) } },
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.id')),
                React.createElement('input', { className: 'dsm-control', value: editModal.nextId || '', onChange: function (e) { setEditModal(Object.assign({}, editModal, { nextId: e.target.value, error: null })) } }),
                React.createElement('p', { className: 'dsm-help' }, t('agm.field.id.hint'))),
              React.createElement('div', { className: 'dsm-field' },
                // 上限与宿主侧 `src/prompts/service.ts` 的 `DEFAULT_PRESET_DESC_MAX_LENGTH`
                // 同数（客户端镜像 `PRESET_DESC_MAX`）：描述从 0.14.0 起会进模型清单
                // （`prompt_manager_list` 要打出来，模型才能在预设之间做选择），所以它有了
                // 预算 —— 写多少模型就能读到多少，与 MCP 备注那条同一条口径。
                React.createElement('div', { className: 'dsm-budget-meta' },
                  React.createElement('label', { className: 'dsm-label' }, t('agm.field.desc')),
                  React.createElement('span', { className: 'dsm-char-count' + (String(editModal.description || '').length > PRESET_DESC_MAX ? ' dsm-char-over' : '') }, String(editModal.description || '').length + ' / ' + PRESET_DESC_MAX)),
                React.createElement('input', { className: 'dsm-control', maxLength: PRESET_DESC_MAX, placeholder: t('agm.field.desc.placeholder'), value: editModal.description || '', onChange: function (e) { setEditModal(Object.assign({}, editModal, { description: e.target.value })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.content')),
                React.createElement('textarea', { className: 'dsm-control dsm-textarea-lg', value: editModal.content, onChange: function (e) { setEditModal(Object.assign({}, editModal, { content: e.target.value })) } })),
              editModal.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, editModal.error) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null || !String(editModal.nextId || '').trim(), onClick: doUpdate }, t('agm.btn.save')))) : null,
            // 新建：id + 描述 + **正文文本框**（用户直接写内容）。原先还有一格「或从现有预设复制」，
            // 用户 2026-09-30 要求删掉 —— 抄一份再改是编辑页的事，新建时只想直接写。
            // 弹窗定高（`dsm-modal-fixed`）：切类型时说明那一句长短不同，框不该跟着跳（手正停在
            // 下一格上），多出来的高度给正文文本框吃掉。
            createModal ? React.createElement(Modal, { title: t('agm.btn.new'), closeLabel: t('btn.close'), className: 'dsm-modal-fixed', onClose: function () { setCreateModal(null) } },
              kindPicker(createModal.kind, function (v) { setCreateModal(Object.assign({}, createModal, { kind: v, error: null })) }),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.id')),
                React.createElement('input', { className: 'dsm-control', placeholder: t('agm.field.id.placeholder'), value: createModal.id, onChange: function (e) { setCreateModal(Object.assign({}, createModal, { id: e.target.value, error: null })) } }),
                React.createElement('p', { className: 'dsm-help' }, t('agm.field.id.hint'))),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('div', { className: 'dsm-budget-meta' },
                  React.createElement('label', { className: 'dsm-label' }, t('agm.field.desc')),
                  React.createElement('span', { className: 'dsm-char-count' + (String(createModal.description || '').length > PRESET_DESC_MAX ? ' dsm-char-over' : '') }, String(createModal.description || '').length + ' / ' + PRESET_DESC_MAX)),
                React.createElement('input', { className: 'dsm-control', maxLength: PRESET_DESC_MAX, placeholder: t('agm.field.desc.placeholder'), value: createModal.description || '', onChange: function (e) { setCreateModal(Object.assign({}, createModal, { description: e.target.value })) } })),
              // 原先这里有一格「或从现有预设复制」—— 用户 2026-09-30 要求删掉：新建时想要的正文
              // 直接写在下面那格里，抄一份再改是编辑页的事。
              React.createElement('div', { className: 'dsm-field dsm-field-grow' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.content')),
                React.createElement('textarea', { className: 'dsm-control dsm-textarea-lg', placeholder: t(createModal.kind === 'quick' ? 'quickprompt.field.content.placeholder' : 'agm.field.content.placeholder'), value: createModal.content || '', onChange: function (e) { setCreateModal(Object.assign({}, createModal, { content: e.target.value })) } })),
              createModal.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, createModal.error) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null || !String(createModal.id || '').trim(), onClick: function () { doCreate(createModal.id, createModal.content, createModal.description) } }, t('agm.btn.create')))) : null,
            applyConfirm ? React.createElement(Modal, { title: applyConfirm.remove ? (t('agm.remove.title') + ' · ' + applyConfirm.id) : (t('agm.applyModal.title') + ' · ' + applyConfirm.id), closeLabel: t('btn.close'), onClose: function () { setApplyConfirm(null) } },
              applyConfirm.remove
                ? React.createElement('p', { className: 'dsm-help' }, t('agm.remove.title') + ' ' + applyConfirm.id + t('agm.remove.suffix'))
                : React.createElement('div', null,
                    React.createElement('p', { className: 'dsm-help' }, t('agm.apply.prefix') + applyConfirm.id + t('agm.apply.suffix')),
                    React.createElement('div', { className: 'dsm-feedback dsm-warning' }, t('agm.apply.note'))),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn ' + (applyConfirm.remove ? 'dsm-btn-danger' : ''), disabled: busy !== null, onClick: function () { if (applyConfirm.remove) doRemove({ id: applyConfirm.id }); else doApply(applyConfirm.id) } }, applyConfirm.remove ? t('agm.btn.confirmRemove') : t('agm.btn.confirmApply')))) : null,
            importOpen ? React.createElement(ImportModal, {
              key: 'imp', t: t, title: t('agm.btn.import'), accept: '.md',
              busy: importBusy, result: importResult,
              // 类型选择放在弹窗顶部（`extra` 槽）：一次导入只进一类，选完再拖文件。
              extra: kindPicker(importKind, setImportKind),
              requirements: [t('upload.requirement.prompt.1'), t('upload.requirement.prompt.2'), t('upload.requirement.prompt.3')],
              onClose: function () { setImportOpen(false); setImportResult(null) },
              onSubmit: function (entries, files) { doImportFiles(files) },
            }) : null,
            // 快捷提示词的编辑：正文直接来自列表（`quickprompt-list` 连正文一起回），
            // 不像预设那样还要再发一次 read。
            quickEdit ? React.createElement(Modal, { title: t('quickprompt.edit.title') + ' · ' + quickEdit.id, closeLabel: t('btn.close'), onClose: function () { setQuickEdit(null) } },
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.id')),
                React.createElement('input', { className: 'dsm-control', value: quickEdit.nextId || '', onChange: function (e) { setQuickEdit(Object.assign({}, quickEdit, { nextId: e.target.value, error: null })) } }),
                React.createElement('p', { className: 'dsm-help' }, t('quickprompt.field.id.hint'))),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('div', { className: 'dsm-budget-meta' },
                  React.createElement('label', { className: 'dsm-label' }, t('agm.field.desc')),
                  React.createElement('span', { className: 'dsm-char-count' + (String(quickEdit.description || '').length > PRESET_DESC_MAX ? ' dsm-char-over' : '') }, String(quickEdit.description || '').length + ' / ' + PRESET_DESC_MAX)),
                React.createElement('input', { className: 'dsm-control', maxLength: PRESET_DESC_MAX, placeholder: t('quickprompt.field.desc.placeholder'), value: quickEdit.description || '', onChange: function (e) { setQuickEdit(Object.assign({}, quickEdit, { description: e.target.value })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('quickprompt.field.content')),
                React.createElement('textarea', { className: 'dsm-control dsm-textarea-lg', value: quickEdit.content, onChange: function (e) { setQuickEdit(Object.assign({}, quickEdit, { content: e.target.value })) } })),
              quickEdit.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, quickEdit.error) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null || !String(quickEdit.nextId || '').trim(), onClick: doQuickUpdate }, t('agm.btn.save')))) : null,
            quickConfirm ? React.createElement(Modal, { title: t('quickprompt.remove.title') + ' · ' + quickConfirm.id, closeLabel: t('btn.close'), onClose: function () { setQuickConfirm(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('quickprompt.remove.hint')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: function () { setQuickConfirm(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy !== null, onClick: function () { doQuickRemove(quickConfirm.id) } }, t('agm.btn.confirmRemove')))) : null)
        }

        // 「工具」设置页：一个侧栏项，内部 tab 切换 场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话。
        function ToolsSection() {
          var tabState = React.useState('scenes')
          var active = tabState[0], setActive = tabState[1]
          // 把切页签的能力登记给模块作用域：任何页面里的「填写令牌」按钮都走这里跳过来
          // （页签状态在本组件里，而那个按钮长在页面内部，注册表是唯一不跨作用域引用的通路）。
          React.useEffect(function () {
            navigateToTab = setActive
            return function () { if (navigateToTab === setActive) navigateToTab = null }
          }, [])
          var sectionRef = React.useRef(null)
          React.useEffect(function () {
            // 设置宿主的真正滚动容器，而不是 body：不同页签内容高度不同，
            // 让滚动条按需出现会改变 options 宽度，页签/GitHub 随之左右跳动。
            //
            // ⚠️ 必须**向上查找**而不是固定跳两级：`.dsm-tabs-shell` 的 position:sticky
            // 依赖祖先链上没有被 overflow 裁剪的层，宿主 DOM 结构一变，「上两级」就可能
            // 指到非滚动容器（sticky 随之失效，页签被内容滚走）。
            var section = sectionRef.current
            if (!section) return undefined
            var host = null
            var node = section.parentElement
            while (node && node !== document.body) {
              var oy = window.getComputedStyle(node).overflowY
              if (oy === 'auto' || oy === 'scroll') { host = node; break }
              node = node.parentElement
            }
            // 找不到（宿主换了实现）→ 退回原来的「上两级」，保持兼容。
            if (!host) host = section.parentElement && section.parentElement.parentElement
            if (!host) return undefined
            host.classList.add('dsm-settings-scroll-host')
            return function () { host.classList.remove('dsm-settings-scroll-host') }
          }, [])
          var page = active === 'scenes' ? React.createElement(ScenesPage)
            : active === 'mcp' ? React.createElement(MCPPage)
            : active === 'skills' ? React.createElement(SkillManagerSection, { t: t })
            : active === 'subagents' ? React.createElement(SubagentsPage)
            : active === 'prompts' ? React.createElement(PromptsPage)
            : active === 'memory' ? React.createElement(MemoryPage)
            : active === 'compat' ? React.createElement(CompatPage, { t: t })
            : React.createElement(SessionsPage)
          // 页签（[key, 显示名]，顺序即渲染顺序；选项只有一份，键位处理与渲染不会走岔）。
          var TABS = [['scenes', t('tabs.scenes')], ['mcp', 'MCP'], ['skills', t('tabs.skills')], ['subagents', t('tabs.subagents')], ['prompts', t('tabs.prompts')], ['memory', t('tabs.memory')], ['sessions', t('tabs.sessions')], ['compat', t('tabs.compat')]]
          // 方向键在页签间移动焦点。这不是锦上添花：非活动页签 tabIndex=-1（roving），
          // 没有方向键的话键盘用户只能 Tab 到当前这一个页签，别的都到不了。
          var onTabKeyDown = function (e) {
            var i = TABS.map(function (x) { return x[0] }).indexOf(active)
            if (i < 0) return
            var next = e.key === 'ArrowRight' ? (i + 1) % TABS.length
              : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length
                : e.key === 'Home' ? 0
                  : e.key === 'End' ? TABS.length - 1
                    : -1
            if (next < 0) return
            e.preventDefault()
            setActive(TABS[next][0])
            var el = document.getElementById('dsm-tab-' + TABS[next][0])
            if (el && el.focus) el.focus()
          }
          // 键盘导航第一步：`/` 聚焦当前页的搜索框、Esc 清空它 —— 只做这两个键。
          //
          // 为什么挂在 `section` 上而不是 `window`：本插件只是宿主设置面板里的一个块，
          // 全局监听会抢走宿主自己的键。挂在根上则只覆盖我们自己的 UI（焦点落在哪一页
          // 就筛哪一页），也不需要在 effect 里管监听器的增删。
          var onSectionKeyDown = function (e) {
            var el = e.target
            if (!el || typeof el.closest !== 'function') return
            // 弹窗开着时整个放行：Esc 关窗与 Tab 焦点陷阱由 Modal 自己处理（见 trapModalFocus）。
            if (el.closest('.dsm-modal')) return
            if (e.key === '/') {
              // 焦点已在任意文本控件里 → `/` 是用户要打的字符，不是快捷键。
              if (el.closest('input, textarea, select, [contenteditable]')) return
              var boxes = sectionRef.current ? sectionRef.current.querySelectorAll('input.dsm-search') : []
              for (var i = 0; i < boxes.length; i += 1) {
                // 只挑真正可见的那个：MCP 页的弹窗里还藏着一枚搜索框，聚焦到
                // `display:none` 的子树里等于把焦点弄丢（用户只会觉得"按了没反应"）。
                var box = /** @type {HTMLInputElement} */ (boxes[i])
                if (box.offsetParent !== null) { e.preventDefault(); box.focus(); return }
              }
              return
            }
            if (e.key !== 'Escape') return
            var search = /** @type {HTMLInputElement} */ (el.closest('input.dsm-search'))
            // 已经是空的就不拦：让这次 Esc 继续往宿主冒（关设置窗口），别让快捷键吃掉别的行为。
            if (!search || !search.value) return
            // 清空要走原生 setter 再复演一次 input 事件：直接改 `search.value` 不触发 React 的
            // onChange，界面上看着清了、过滤条件还留着（列表仍是筛过的）。
            var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
            if (!desc || !desc.set) return
            e.preventDefault()
            desc.set.call(search, '')
            search.dispatchEvent(new Event('input', { bubbles: true }))
          }
          // 子节点用**带 key 的数组**给（而不是并列的三个实参）：并列实参会退化成按位置
          // 认子节点，令牌提示一出现/消失就把 `page` 换一个位置 → React 把整页卸载重挂
          // （页面状态与列表全丢，看起来像"页面自己刷新了"）。带 key 之后位置永远稳定。
          return React.createElement('section', { ref: sectionRef, className: 'dsm-section', onKeyDown: onSectionKeyDown }, [
            React.createElement('div', { key: 'tabs', className: 'dsm-tabs-shell' },
              React.createElement('div', { className: 'dsm-tabs', role: 'tablist', 'aria-label': t('nav.title'), onKeyDown: onTabKeyDown },
                TABS.map(function (entry) {
                  var key = entry[0], label = entry[1], on = active === key
                  return React.createElement('button', {
                    key: key,
                    type: 'button',
                    role: 'tab',
                    id: 'dsm-tab-' + key,
                    'aria-selected': on,
                    'aria-controls': 'dsm-tabpanel',
                    tabIndex: on ? 0 : -1,
                    className: 'dsm-tab' + (on ? ' dsm-tab-active' : ''),
                    onClick: function () { setActive(key) },
                    title: label,
                  }, label)
                })),
              React.createElement(FeedbackLinks, null)),
            // 令牌提示的**页面级**那一份：放在页签下面、页面内容上面。位置固定在入口组件里，
            // 与"当前是哪一页、那一页怎么渲染错误"无关 —— 谁拿到这句话谁渲染，就必然有地方漏
            // （用户实测：十来个弹窗里有的没提示、有提示的没有跳转按钮）。
            // 有弹窗打开时它让位（那一份由 Modal 渲染），这里就不再出现。
            React.createElement(TokenGateNotice, { key: 'gate', pageLevel: true }),
            // 页容器：`aria-controls` 得指向一个真实存在的元素（只有当前页在树上，但 id 恒在）。
            // 这层 div 是纯承载，不设样式也不设 container-type —— 布局仍由 .dsm-section 决定。
            React.createElement('div', { key: 'page', role: 'tabpanel', id: 'dsm-tabpanel', 'aria-labelledby': 'dsm-tab-' + active },
              React.cloneElement(page, { key: 'page' })),
          ])
        }
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsm-tools', order: 16, label: function () { return t('nav.title') }, locale: NS },
          () => React.createElement(ToolsSection)
        ))
