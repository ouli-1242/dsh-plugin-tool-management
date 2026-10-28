        // 顶部栏右上角那一行（0.21.2）：版本号 · 检查更新 · GitHub，横排贴住作用域行右端。
        //
        // 用户 2026-10-22 提案：「检查更新能放在 GitHub 图标上吗，用户点击检查更新就知道有没有
        // 新版本」→ 澄清「是 GitHub 图标**上面**……这一栏的最右边」→ 再定「GitHub 图标也上去
        // 并排」→ 最后定「统一一个图标显示就可以了，不必有版本更新时增加『更新』二字」。
        // 所以最终形态是一行三件：
        //   · 版本号（小灰字，最左）——回答"我现在装的是哪个版本"；
        //   · 更新键——**永远只是那一颗向上箭头的图标**，有没有新版本都不变宽、不改字；
        //     有新版本只在右上角多一个红点；
        //   · GitHub 图标——原样保留，仓库入口一个都不能少。
        //
        // 交互约定：
        //   · 没有更新时点击 = 查一次（只读 op `update-status` + `refresh:true`）；
        //   · 有更新时点击 = 打开升级卡，展示**固定版本**的 CLI 命令供复制。
        //     插件跑在宿主的 node_modules 里，不能自我安装；宿主也没有"更新已装插件"的接口
        //     （`installBundle` 对已在 profile 依赖里的包在 HMR 下必拒），所以这里只给命令，
        //     不承诺在界面内完成安装，也不出现 `@latest`。
        //   · 检查结论用 toast 说（一句话结论，不必弹窗）；只有要给人抄命令时才弹卡。
        //
        // 结果存**会话级**（`updateProbe`）：设置面板每次打开都会重挂本组件，重挂不该把
        // 「更新」抹掉，也不该每次都去读一遍盘。
        var updateProbe = { info: null, asked: false }

        function FeedbackLinks() {
          var st = React.useState({ busy: false, info: updateProbe.info })
          var state = st[0], setState = st[1]
          var co = React.useState(false)
          var cardOpen = co[0], setCardOpen = co[1]
          var cp = React.useState(false)
          var copied = cp[0], setCopied = cp[1]
          var busy = state.busy === true
          var info = state.info
          var hasUpdate = !!info && String(info.status || '') === 'update-available'
          var targetVersion = String((info && info.bestCompatible) || '')
          // 服务端按当前 profile 拼好的命令；缓存读数读到 old cache 时也会重建（见 update-check.ts）。
          var command = String((info && info.command) || '')

          // 只改给到的字段：补读数 / 检查两路异步回填不能互相覆盖。
          var patch = function (next) { setState(function (prev) { return Object.assign({}, prev, next) }) }

          // 挂载时补一次缓存读数（不带 refresh）：服务端启动时预热过，这一次通常零网络，
          // 只是把盘上 `update-check.json` 的结论先摆上来。读不到 = 少一个「更新」标记，不报错。
          React.useEffect(function () {
            if (updateProbe.asked) return undefined
            updateProbe.asked = true
            var alive = true
            apiCall('update-status', {}).then(function (r) {
              if (!r || !r.ok) return
              updateProbe.info = r
              // 用户已经自己点过一次（拿到的是更新的结果）就不覆盖。
              if (alive) setState(function (prev) { return prev.info ? prev : Object.assign({}, prev, { info: r }) })
            }).catch(function () { /* 静默：这个标记只是便利，不是结论 */ })
            return function () { alive = false }
          }, [])

          var check = function () {
            if (busy) return
            patch({ busy: true })
            // `refresh:true`：点这一下就是要一个**现在**的答案。读 12 小时前的缓存等于骗人
            // ——「已是最新」可能是在某个版本发布之前算出来的。
            apiCall('update-status', { refresh: true }).then(function (r) {
              if (!r || !r.ok) throw new Error(String((r && r.error) || t('compat.update.unknown')))
              updateProbe.info = r
              patch({ busy: false, info: r })
              var s = String(r.status || 'unknown')
              showPluginToast(updateStatusText(r, t), s === 'up-to-date' ? 'ok' : 'warn')
            }).catch(function (e) {
              patch({ busy: false })
              showPluginToast(t('update.failed', { error: errMsg(e) }), 'err')
            })
          }

          /**
           * 复制升级命令。命令由服务端按当前 profile 拼好（固定版本），这里只负责放进剪贴板。
           * 剪贴板不可用时命令仍显示在卡里，用户可以直接选中复制。
           */
          var copyCommand = function () {
            if (command === '') return
            var done = function () {
              setCopied(true)
              showPluginToast(t('update.install.copied'), 'ok')
            }
            var fail = function () { showPluginToast(t('update.install.copyFailed'), 'err') }
            try {
              if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(command).then(done, fail)
                return
              }
            } catch (e) { /* 落到下面的失败提示 */ }
            fail()
          }

          var onUpdateClick = function () {
            if (busy) return
            if (hasUpdate) { setCopied(false); setCardOpen(true); return }
            check()
          }

          // 标题就是"这一下会做什么"：没答案时"查一次"，有答案时"再查一遍"，
          // 有更新时"查看升级命令"。
          var tip = busy ? t('update.checking')
            : hasUpdate ? updateStatusText(info, t) + ' · ' + t('update.install.open')
              : info ? updateStatusText(info, t) + ' · ' + t('update.recheck')
                : t('update.check')
          var label = hasUpdate ? t('update.action') : t('update.check')
          return React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dsm-feedback-links' },
              // 版本号在最左：它回答的是"我现在装的是哪个版本"，与右边两颗键各自回答的问题不同，
              // 所以不并进按钮文字里（并进去就成了"要变成哪个版本"，两件事会混）。
              React.createElement(VersionBadgeComponent, null),
              React.createElement('button', {
                type: 'button',
                // 永远是同一颗图标键（用户 2026-10-22：不必在有更新时多出「更新」二字）——
                // 有更新只多一个红点，宽度不变，这一行也就不会因为状态变化而抖一下。
                className: 'dsm-feedback-link dsm-feedback-check' + (busy ? ' dsm-feedback-link-busy' : ''),
                'aria-label': label,
                'aria-busy': busy ? 'true' : 'false',
                title: tip,
                onClick: onUpdateClick,
              },
                React.createElement(UpdateMark16, null),
                hasUpdate ? React.createElement('span', { className: 'dsm-feedback-dot', 'aria-hidden': 'true' }) : null),
              React.createElement('a', {
                className: 'dsm-feedback-link',
                href: 'https://github.com/ouli-1242/dsh-plugin-tool-management',
                target: '_blank',
                rel: 'noreferrer',
                'aria-label': t('link.project'),
                title: t('link.project'),
              },
                React.createElement(GithubMark16, null))),
            cardOpen ? React.createElement(Modal, {
              title: t('update.install.title', { version: targetVersion }),
              closeLabel: t('btn.close'),
              onClose: function () { setCardOpen(false) },
              className: 'dsm-modal-sm',
            },
              React.createElement('p', { className: 'dsm-help' }, t('update.install.body', {
                current: String((info && info.current) || '?'),
                version: targetVersion,
              })),
              command !== ''
                ? React.createElement('pre', { className: 'dsm-code' }, command)
                : React.createElement('p', { className: 'dsm-help' }, t('update.install.noCommand')),
              React.createElement('div', { className: 'dsm-feedback dsm-warning' }, t('update.install.after')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-secondary',
                  onClick: function () { setCardOpen(false) },
                }, t('btn.close')),
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn', disabled: command === '',
                  onClick: copyCommand,
                }, copied ? t('update.install.copied') : t('update.install.copy'))))
              : null)
        }

        // MCP 服务页：与 Skills 页共用 dsm-* 设计语言（统计卡 / 筛选 / 分组卡片 / 模态框）。
        function MCPPage() {
          // 本页订阅当前层（0.21.2）：行首圆点的蓝标、开关的生效值都跟着层走。
          // `mcpm-list` 是全局口径（服务端不认识 sessionId），会话层只做本地投影，
          // 所以这里**不重取**，只重渲染 —— 5 秒一次的轮询已经把全局那份带回来了。
          var scopeState = useScopeLayer()
          const [state, setState] = React.useState({ loading: true, error: null, rows: [], paths: null, errors: [], warnings: [], patchStamps: {} })
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
          // 切走这一页 → 这一页的关窗暂存作废（见 42-shared-ui.js 的 useFormDraftScope）。
          useFormDraftScope('mcp:')
          // 表单的本地校验结果（不塞进 formModal：那对象是发给服务端的 payload 形状）。
          const [formError, setFormError] = React.useState(null)
          const [detail, setDetail] = React.useState(null)
          // 详情弹窗的请求序号：见 openDetail / closeDetail（晚到响应不得复活弹窗）。
          const detailSeqRef = React.useRef(0)
          const [confirmRow, setConfirmRow] = React.useState(null)
          // 「统一关闭」确认：与删除不同，它切断的是**正在用它的会话** —— 必须问一次。
          const [stopConfirm, setStopConfirm] = React.useState(null)
          const [reveal, setReveal] = React.useState(false)
          const [settings, setSettings] = React.useState(null)
          const [compactConfirm, setCompactConfirm] = React.useState(false)
          // 停用表损坏 / 不可读时的恢复入口（0.21.2）：破坏性写，先确认再执行。
          const [disabledResetConfirm, setDisabledResetConfirm] = React.useState(false)
          // A1：粘贴 JSON 导入 / 导出两个弹窗（0.15.0）。
          const [jsonImportOpen, setJsonImportOpen] = React.useState(false)
          const [jsonExportOpen, setJsonExportOpen] = React.useState(false)
          // （这里曾经有一颗「回收站」：MCP 本域没有回收站类目，点开的是六类共用的全局视图。
          //  2026-10-12 裁定「回收站一个功能页就是一个」后删掉 —— 会话页同理。MCP 的删除走
          //  宿主配置，插件不留快照，所以这一域本来就没有可恢复的东西。）
          // （B1 的「配置体检」状态与 `inspectKeyOf` 已随体检功能一起删除，见下方 openDetail
          //  上面那段说明。原先这里还有一颗每行「检查」按钮和它的结果面板。）
          const [undo, setUndo, dismissUndo] = useUndoState()

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
                (res && res.disabledState) || 'ok', (res && res.disabledIssue) || null,
                (res && res.patchStamps) || {},
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
                // 停用表状态（0.21.2）：unknown 时所有 mcp__* 都被执行侧拒绝，
                // 页面要挂横幅并把逐工具开关锁住，不能报成"全部开着"。
                disabledState: (res && res.disabledState) || 'ok',
                disabledIssue: (res && res.disabledIssue) || null,
                // 每层补丁的内容指纹：编辑表单保存时带回去，服务端核对后才写。
                patchStamps: (res && res.patchStamps) || {},
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
              disabledState: 'ok', disabledIssue: null, patchStamps: {},
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

          const run = (method, args, label, onOk, onFail) => {
            setMsg(null)
            setBusy(label)
            apiCall(method, args).then((res) => {
              if (res && res.ok) {
                // 场景内改开关：档案没跟上的话要说出来，别只报「成功」（详见 sceneSyncWarn）。
                const warn = sceneSyncWarn(mt, res)
                setMsg(warn ? { kind: 'warn', text: opMsg(res) + ' ' + warn } : opMsg(res))
                refresh()
                if (onOk) onOk()
              } else if (!(onFail && onFail(res) === true)) {
                setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
              }
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
            const turnOn = !bulkAllOn
            const changed = bulkServers
              .map((row) => ({ serverName: String(row.serverName || row.id), on: rowOnInLayer(row) }))
              .filter((item) => item.on !== turnOn)
            if (!changed.length) return
            // 会话作用域（0.21.2，决策 9）：会话层只改"本对话看不看得到"（认领 / 撤销认领），
            // **不写补丁**。逐台写 `scope-set`；撤销按操作前的生效值写回。
            if (scopeIsSession()) {
              const sessionId = scopeState.sessionId
              setMsg(null)
              setBusy('setall')
              Promise.all(changed.map((item) => apiCall('scope-set', {
                sessionId: sessionId, domain: 'mcp', key: item.serverName, value: turnOn,
              }).catch((e) => ({ ok: false, error: errMsg(e) })))).then((results) => {
                setBusy(null)
                const failed = results.filter((r) => !r || r.ok === false).length
                if (failed) setMsg({ kind: 'err', text: mt('mcp.msg.failed') })
                else setMsg({ kind: 'ok', text: mt('mcp.msg.ok') })
                try { refreshScope() } catch (e) { /* 面板没开着也只是白跑一次读 */ }
                refresh()
                if (failed) return
                setUndo({
                  text: mt('undo.mcp', {
                    action: mt(turnOn ? 'bulk.enabled' : 'bulk.disabled'),
                    count: changed.length,
                    enabled: turnOn ? bulkServers.length : 0,
                  }),
                  items: changed,
                  sessionScoped: true,
                  revert: (item) => apiCall('scope-set', {
                    sessionId: sessionId, domain: 'mcp', key: item.serverName, value: item.on,
                  }),
                })
              })
              return
            }
            // 全局层 = 写**意图**（0.21.2）：off 不再立刻停 —— 还在用它的会话按租约继续跑，
            // 只有「统一关闭」才切断。撤销按操作前的意图值逐台写回。
            setMsg(null)
            setBusy('setall')
            apiCall('scope-intent-set', { domain: 'mcp', keys: changed.map((item) => item.serverName), value: turnOn ? 'on' : 'off' })
              .then((res) => {
                if (res && res.ok === false) { setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') }); return }
                if (res && res.warnings && res.warnings.length) setMsg({ kind: 'warn', text: res.warnings.join('；') })
                else setMsg({ kind: 'ok', text: mt('mcp.msg.ok') })
                try { refreshScope() } catch (e) { /* 同上 */ }
                refresh()
                setUndo({
                  text: mt('undo.mcp', {
                    action: mt(turnOn ? 'bulk.enabled' : 'bulk.disabled'),
                    count: changed.length,
                    enabled: turnOn ? bulkServers.length : 0,
                  }),
                  items: changed,
                  // 这一栏只用来在撤销后重拉作用域（意图改了，面板的全局开关要跟着变）。
                  sessionScoped: true,
                  revert: (item) => apiCall('scope-intent-set', { domain: 'mcp', keys: [item.serverName], value: item.on ? 'on' : 'off' }),
                })
              })
              .catch((e) => setMsg({ kind: 'err', text: errMsg(e) }))
              .then(() => setBusy(null))
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
              if (entry.sessionScoped === true) {
                try { refreshScope() } catch (e) { /* 面板没开着也只是白跑一次读 */ }
              }
              refresh()
            })
          }

            // 新增与编辑各存一份（编辑按条目 id 分键：改 A 关窗不会串到 B）。
            const formDraftKey = (modal) => (modal && modal.mode === 'edit' ? 'mcp:edit:' + modal.id : 'mcp:create')
            const openAdd = () => {
              setFormError(null)
              setFormModal(takeFormDraft('mcp:create') || Object.assign({ mode: 'add', id: null }, emptyForm()))
            }
              const openEdit = (row, force) => {
                setFormError(null)
                // `force` = 冲突后重新加载：跳过草稿，用磁盘上的最新一行重建表单。
                if (!force) {
                  const draft = takeFormDraft('mcp:edit:' + row.id)
                  if (draft) { setFormModal(draft); return }
                }
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
                  // 备注也在编辑表单里改（用户 2026-10-18：「mcp 备注编辑功能应该在编辑页，
                  // 详细页只能看」）：详情页是只读视图，写动作一律回到这张表。
                  // `origNote` 留一份原文用于判断"这次到底改没改备注"—— 没改就不多写一次侧车。
                  note: row.notes || '',
                  origNote: row.notes || '',
                  // 打开时那一层补丁的内容指纹：保存时带回去，服务端核对后才写（并发编辑判据）。
                  stamp: (state.patchStamps || {})[row.level] || null,
                })
              }
            const closeForm = () => { setFormError(null); setFormModal(null) }
            // 只有"关掉"这条路存草稿（提交成功走的是 closeForm 本身，不进这里）——
            // 所以不需要"成功后清草稿"那一步。
            const dismissForm = () => { const cur = formModal; closeForm(); if (cur) stashFormDraft(formDraftKey(cur), cur) }
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
            const submitForm = (force) => {
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
            if (payload.mode === 'edit') {
              args.id = payload.id
              // 并发编辑判据：打开表单时那一层补丁的指纹。`force` = 用户明确选择覆盖。
              if (!force && payload.stamp) args.expectedStamp = payload.stamp
            }
            // 备注只在新增时带：服务端在写补丁的同一次锁里落进侧车（见 mcpmAdd）。
            else args.note = payload.note
            // 编辑态：备注在**保存之后**单独写一次（`mcpm-edit` 不碰侧车）。改过才写 ——
            // 没改就多一次写盘 + 刷新 updatedAt，没有意义。
            const noteChanged = payload.mode === 'edit' && String(payload.note || '').trim() !== String(payload.origNote || '').trim()
            run(payload.mode === 'edit' ? 'mcpm-edit' : 'mcpm-add', args, 'form', function () {
              closeForm()
              if (noteChanged) {
                apiCall('mcpm-note', { id: payload.id, note: payload.note }).then(function (res) {
                  if (res && res.ok === false) setMsg({ kind: 'warn', text: mt('mcp.msg.noteFailed') })
                }).catch(function () { setMsg({ kind: 'warn', text: mt('mcp.msg.noteFailed') }) }).then(function () { refresh() })
              }
            }, function (res) {
              // 补丁文件在别处被改过：留在表单里，给出「重新加载 / 覆盖保存」两条出路。
              if (res && res.code === 'stale-write') {
                setFormModal(Object.assign({}, formModal, { stale: true }))
                setFormError(t('stale.write.conflict'))
                return true
              }
              return false
            })
          }
          /**
           * 冲突后的「重新加载」：重读补丁，用磁盘上的那一行重建表单（丢掉本地改动）。
           * 直接调 `mcpm-list` 而不是等下一次轮询 —— 轮询的 5 秒里用户会以为按钮坏了。
           */
          const reloadForm = () => {
            if (!formModal || formModal.mode !== 'edit') return
            setBusy('form')
            apiCall('mcpm-list', {}).then(function (res) {
              setBusy(null)
              if (!res || !res.ok) { setFormError((res && res.error) || mt('mcp.msg.loadFailed')); return }
              const rows = res.rows || []
              setState(function (prev) { return Object.assign({}, prev, { rows: rows, patchStamps: res.patchStamps || {} }) })
              const row = rows.find(function (r) { return r.id === formModal.id && r.level === formModal.level })
              if (!row) { closeForm(); refresh(); return }
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
                note: row.notes || '',
                origNote: row.notes || '',
                stamp: (res.patchStamps || {})[row.level] || null,
              })
              setFormError(null)
            }).catch(function (e) { setBusy(null); setFormError(errMsg(e)) })
          }

          // 「启动中」的乐观记账（用户 2026-10-15：呼吸灯要过一会才出现）：翻开开关那一刻宿主
          // 还没把条目起起来，轮询到的仍是停用前的那份状态，于是灯要等下一次轮询（5 秒）才呼吸。
          // 点下时先记一笔，相位报回 active 即不再算数；30 秒后自动作废 —— 真起不来的条目不该永远呼吸。
          const STARTING_TTL_MS = 30000
          const [startingRows, setStartingRows] = React.useState({})
          const startingKey = (row) => row.id + '@' + row.level
          const markStarting = (row) => {
            setStartingRows((prev) => Object.assign({}, prev, { [startingKey(row)]: Date.now() }))
          }
          const clearStarting = (row) => {
            setStartingRows((prev) => {
              if (prev[startingKey(row)] === undefined) return prev
              const next = Object.assign({}, prev)
              delete next[startingKey(row)]
              return next
            })
          }
          const isStarting = (row) => {
            const ts = startingRows[startingKey(row)]
            return ts !== undefined && Date.now() - ts < STARTING_TTL_MS
          }

          // Toggling updates only the clicked row (scroll position and expanded
          // groups survive); a failed write re-reads the server state instead.
          const toggleRow = (row) => {
            setMsg(null)
            // 会话作用域（0.21.2）：会话层下只改"本会话看不看得到这台服务器"（租约 / 撤销认领），
            // **不动补丁、不断连接** —— 别的对话照常用。
            if (scopeIsSession()) {
              // 同名两层行按"任一行开着"算全局（与会话快照同一口径）。
              const globalOn = serverGlobalOn(row)
              const current = scopeFlag('mcp', String(row.serverName || row.id), globalOn)
              const nextOn = !current.value
              setBusy(row.id + ':toggle')
              scopeWriteFlag('mcp', String(row.serverName), nextOn, function () { return { ok: true } })
                .then((res) => {
                  if (res && res.ok === false) { setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') }); return }
                  // 拨开一台全局关着的服务器会成为本会话的**租约**（连接跑起来、别的对话
                  // 看不到）；服务端把这件事写进回执的警告里，这里照实转述。
                  if (res && res.warnings && res.warnings.length) setMsg({ kind: 'warn', text: res.warnings.join('；') })
                  refresh()
                })
                .catch((e) => { setMsg({ kind: 'err', text: errMsg(e) }); refresh() })
                .then(() => setBusy(null))
              return
            }
            // 全局层（0.21.2）= 写**意图**，不是补丁：off 之后仍被会话认领的服务器保持运行
            // （租约），只有「统一关闭」才切断它们。开关读的也是意图（见 `serverGlobalOn`）。
            const name = String(row.serverName || row.id)
            const nextOn = !serverGlobalOn(row)
            // 翻开 = 先按「启动中」显示（宿主拉起进程要几秒）；关掉 = 销账。
            if (nextOn) markStarting(row); else clearStarting(row)
            setBusy(row.id + ':toggle')
            scopeWriteIntent('mcp', [name], nextOn ? 'on' : 'off')
              .then((res) => {
                if (res && res.ok === false) { setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') }); return }
                if (res && res.warnings && res.warnings.length) { setMsg({ kind: 'warn', text: res.warnings.join('；') }); return }
                const leases = scopeLeaseCount('mcp', name)
                if (!nextOn && leases > 0) setMsg({ kind: 'warn', text: mt('mcp.intent.keptRunning', { count: leases }) })
                else setMsg({ kind: 'ok', text: mt(nextOn ? 'mcp.intent.onOk' : 'mcp.intent.offOk', { name: name }) })
                refresh()
              })
              .catch((e) => { setMsg({ kind: 'err', text: errMsg(e) }); refresh() })
              .then(() => setBusy(null))
          }
          /**
           * 重连一台服务（`mcpm-restart`）：服务端先把它临时停用、等 loader 摘掉、再按重启前的
           * 状态恢复 —— 最长约 11 秒，所以**不走 `run()`**（那条路只服务"一按就回"的写操作，
           * 也没有地方放 warnings）。启用状态不变，这正是"重启"与"关掉再打开"的区别。
           * 只有驻留在补丁文件里的条目可重连：loader 行没有可写的 id/level，调用点据此置灰。
           */
          const restartRow = (row) => {
            setMsg(null)
            setBusy(row.id + ':restart')
            apiCall('mcpm-restart', { id: row.id, level: row.level }).then((res) => {
              if (res && res.ok === false) {
                setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
              } else if (res && res.warnings && res.warnings.length) {
                setMsg({ kind: 'warn', text: mt('mcp.msg.restartWarn', { warning: res.warnings.join('；') }) })
              } else {
                setMsg({ kind: 'ok', text: mt('mcp.msg.restarted', { name: row.serverName }) })
              }
            }).catch((e) => setMsg({ kind: 'err', text: errMsg(e) })).then(() => { setBusy(null); refresh() })
          }

          /**
           * MCP「统一关闭」是一次性动作：全局意图写 off，并把正在认领它的会话 / 工作区
           * 一并写成显式关闭 —— 这样租约不会把它重新拉起来，也不会留下「恢复启用」状态。
           * 走 op 而不是 `scope-intent-set`：后者只能写意图，写不到那些层的开关。
           */
          const stopServerNow = (row) => {
            const name = String(row.serverName || row.id)
            setMsg(null)
            setBusy(row.id + ':intent')
            apiCall('scope-stop-now', { domain: 'mcp', key: name }).then((res) => {
              if (res && res.ok === false) { setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') }); return }
              if (res && res.warnings && res.warnings.length) setMsg({ kind: 'warn', text: res.warnings.join('；') })
              else setMsg({ kind: 'ok', text: mt('mcp.intent.stopped', { name: name }) })
              // 租约徽章 / 行菜单立即跟着消失。不重拉整层：紧接着的 `scope-get` 可能读到写前
              // 的短 TTL 快照，而且整层重拉会按新状态重排列表。
              scopeForgetLeases('mcp', [name])
            }).catch((e) => { setMsg({ kind: 'err', text: errMsg(e) }) }).then(() => setBusy(null))
          }

          /**
           * 页头「全部关闭」：逐台走同一个 op，与行菜单里的「统一关闭」是一回事 ——
           * 只改意图停不掉正在认领它的场景 / 工作区，那些层的开关也得写成显式关闭。
           * 只在真有临时运行时出现（`scopeLeaseKeys` 非空），没东西可停就不占页头。
           */
          const stopAllServers = () => {
            const keys = scopeLeaseKeys('mcp')
            if (!keys.length) return
            setMsg(null)
            setBusy('stopall')
            apiCall('scope-stop-now', { domain: 'mcp', keys }).then((res) => {
              if (res && res.ok === false) { setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') }); return }
              if (res && res.warnings && res.warnings.length) setMsg({ kind: 'warn', text: res.warnings.join('；') })
              else setMsg({ kind: 'ok', text: mt('scope.stopAll.done', { count: keys.length }) })
              // 页头按钮、行内徽章与开关都靠本地快照这一改立刻收掉；列表状态由 5 秒轮询跟上。
              scopeForgetLeases('mcp', keys)
            }).catch((e) => setMsg({ kind: 'err', text: errMsg(e) })).then(() => setBusy(null))
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
          // 备注的写入随「编辑」一起提交（见 submitForm 的 noteChanged），详情页只读 ——
          // 原先这里那颗 saveNote / noteDraft 随「详细页只能看」一并删除。
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
           * 重置停用表（恢复通道）：只在停用表 corrupt / unreadable 时可用，服务端会拒绝
           * 正常状态下的调用。损坏时先留取证副本再写空表 —— 回执里把副本路径如实带回来。
           */
          const doDisabledReset = () => {
            setDisabledResetConfirm(false)
            setMsg(null)
            setBusy('disabled-reset')
            apiCall('mcpm-disabled-reset', {}).then((res) => {
              if (res && res.ok) {
                setMsg({
                  kind: 'ok',
                  text: res.forensics
                    ? mt('mcp.disabledReset.doneWithCopy', { path: res.forensics })
                    : mt('mcp.disabledReset.done'),
                })
                refresh()
              } else setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
            }).catch((e) => setMsg({ kind: 'err', text: errMsg(e) })).then(() => setBusy(null))
          }
          /**
           * 体检（`mcpm-inspect`）已整条移除（用户 2026-10-12：「MCP 的检查功能可以移除，
           * 作用不大」）：页头那颗「全部检查」与每行的「检查」按钮、结果面板、`inspections`
           * 状态、配置指纹失效这几处一起删。它要发连通性探测、还要把 PATH 查询结果铺成
           * 一列检查项，而它给出的结论（"命令在不在 PATH 上""端点通不通"）用户在点一次
           * 「详情」时就看到了，不值得占页头一格 + 每行一颗按钮。
           * 宿主侧也一并拆掉：op-registry 的登记、manager 的装配与 `mcpm-inspect` 句柄、
           * `mcp/inspect-probe.ts` 整个模块 —— 界面既然不再有调用方，留着就是一条没人走、
           * 却仍要维护的免令牌出口。
           */
          const openDetail = (row) => {
            // 请求序号（每次开窗 +1）：两处详情弹窗共用同一份 `detail`，连点两台服务器时
            // 先发的响应可能后到并覆盖后发的那份 —— 序号对不上就丢弃。
            const seq = ++detailSeqRef.current
            setDetail({ row, loading: true, error: null, tools: [], disabledState: 'ok' })
            apiCall('mcpm-tools', { serverName: row.serverName }).then((res) => {
              if (seq !== detailSeqRef.current) return
              if (res && res.ok) setDetail({ row, loading: false, error: null, tools: res.tools || [], disabledState: res.disabledState || 'ok' })
              else setDetail({ row, loading: false, error: (res && res.error) || mt('mcp.tools.loadFailed'), tools: [], disabledState: 'ok' })
            }).catch((e) => {
              if (seq !== detailSeqRef.current) return
              setDetail({ row, loading: false, error: errMsg(e), tools: [], disabledState: 'ok' })
            })
          }
          /** 关闭详情弹窗：先作废在途响应（否则晚到的那份会把弹窗重新打开），再清 state。 */
          const closeDetail = () => {
            detailSeqRef.current += 1
            setDetail(null)
          }

          /** 详情页的停用表是不是读不出来：此时执行侧拒绝所有 mcp__*，任何"开着"都是谎话。 */
          const detailToolsUnknown = !!detail && detail.disabledState === 'unknown'
          /** 详情页某条工具在**本层**的值（`{ value, scoped }`）。会话层 = `mcpTools` 域
           *  （键 `<server>/<tool>`，与注入段、模型工具同一套）；全局层 = `mcpm-tools` 的读数。 */
          const toolFlag = (row, tool) => {
            const globalOn = detailToolsUnknown ? false : tool.enabled !== false
            return scopeIsSession()
              ? scopeFlag('mcpTools', String(row.serverName || row.id) + '/' + tool.name, globalOn)
              : { value: globalOn, scoped: false }
          }
          const toggleTool = (row, tool) => {
            setMsg(null)
            setBusy('tool:' + tool.name)
            // 会话作用域（0.21.2，用户裁定「逐工具开关也按会话独立」）：会话层写 `mcpTools`。
            // 开关只在服务器于本层已可见时可用（见 `detailServerHidden`）；服务器由上面
            // 那颗开关按租约拉起，警告随回执带回来，照实转述。
            if (scopeIsSession()) {
              const serverName = String(row.serverName || row.id)
              const nextEnabled = !toolFlag(row, tool).value
              scopeWriteFlag('mcpTools', serverName + '/' + tool.name, nextEnabled, function () { return { ok: true } })
                .then((res) => {
                  if (res && res.ok === false) { setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') }); return }
                  // 乐观翻一下那一行（`scopeFlag` 的回退值就是它）：refreshScope 回来之前
                  // 屏幕上的开关就该是刚点出来的样子。
                  setDetail((prev) => (prev === null ? prev : Object.assign({}, prev, { tools: (prev.tools || []).map((item) => (item.name === tool.name ? Object.assign({}, item, { enabled: nextEnabled }) : item)) })))
                  if (res && res.warnings && res.warnings.length) setMsg({ kind: 'warn', text: res.warnings.join('；') })
                  else setMsg({ kind: 'ok', text: nextEnabled ? mt('done.enabled', { name: tool.name }) : mt('done.disabled', { name: tool.name }) })
                })
                .catch((e) => setMsg({ kind: 'err', text: errMsg(e) }))
                .then(() => setBusy(null))
              return
            }
            const nextEnabled = tool.enabled === false
            apiCall('mcpm-tool-enabled', { serverName: row.serverName, tool: tool.name, enabled: nextEnabled }).then((res) => {
              if (res && res.ok) {
                setDetail(Object.assign({}, detail, { tools: (detail.tools || []).map((item) => (item.name === tool.name ? Object.assign({}, item, { enabled: nextEnabled }) : item)) }))
                // 回执动词表（REDESIGN §12.4）：两个方向各取字面量键，不合成三元。
                setMsg({ kind: 'ok', text: nextEnabled ? mt('done.enabled', { name: tool.name }) : mt('done.disabled', { name: tool.name }) })
              } else setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
            }).catch((e) => setMsg({ kind: 'err', text: errMsg(e) })).then(() => setBusy(null))
          }

          /**
           * 详情页里"现在去问一次工具清单"（`mcpm-tools-refresh`）：对还没有缓存的服务器，
           * 服务端是真的**临时启动一次**去抓工具名，拿到后恢复原启用状态 —— 所以它慢、也可能失败。
           * 详情那节的「工具：N」平时只读缓存，这是唯一的主动刷新入口；在途响应按打开详情时的
           * 序号作废（换了一台服务器就不该把旧结果写进去）。
           */
          const refreshTools = () => {
            const row = detail && detail.row
            if (!row) return
            const seq = detailSeqRef.current
            setMsg(null)
            setBusy('tools:refresh')
            apiCall('mcpm-tools-refresh', { serverName: row.serverName }).then((res) => {
              if (seq !== detailSeqRef.current) return
              if (res && res.ok === false) {
                setMsg({ kind: 'err', text: (res && res.error) || mt('mcp.msg.failed') })
                return
              }
              const tools = (res && res.tools) || []
              setDetail((prev) => (prev === null ? prev : Object.assign({}, prev, { loading: false, error: null, tools: tools })))
              if (res && res.warning) setMsg({ kind: 'warn', text: mt('mcp.msg.warn', { warning: res.warning }) })
              else setMsg({ kind: 'ok', text: mt('mcp.msg.toolsRefreshed', { count: tools.length }) })
            }).catch((e) => { if (seq === detailSeqRef.current) setMsg({ kind: 'err', text: errMsg(e) }) }).then(() => setBusy(null))
          }

          const rows = state.rows || []
          /**
           * 同一台服务器可能在两层各有一行（project + global）。`mcpm-list` 的 `disabled` 是
           * **逐行**的，而会话覆盖的键是 serverName —— 会话层问的是"这台服务器看不看得到"，
           * 所以先按名字合并成"任一行开着 = 这台开着"，与 `configuredServerStates()` 同口径。
           */
          const serverOnMap = React.useMemo(() => {
            const map = new Map()
            for (const row of rows) {
              const name = String(row.serverName || row.id)
              map.set(name, map.get(name) === true || row.disabled !== true)
            }
            return map
          }, [rows])
          /**
           * 这台服务器在**全局**开没开（合并同名行）—— 读**意图**（0.21.2），运行态兜底。
           *
           * 必须读意图而不是补丁：全局 off、但还有会话在用（租约）时补丁仍是开着，读补丁会把
           * "临时运行"显示成"全局开着"。`scopeGlobalOn` 就是这条口径。
           */
          const serverGlobalOn = (row) => {
            const name = String(row.serverName || row.id)
            return scopeGlobalOn('mcp', name, serverOnMap.get(name) === true)
          }
          /** 这一行在**本层**开不开：会话层 = 本地投影（含租约认领），全局层 = 全局意图。 */
          const rowOnInLayer = (row) => scopeIsSession()
            ? scopeFlag('mcp', String(row.serverName || row.id), serverGlobalOn(row)).value
            : serverGlobalOn(row)
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
            // 会话层藏掉的服务器，它的工具在这个对话里一条也调不到 —— 分子按本层算。
            // 分母仍是全机注册数，这样这组数字回答的是"这台机器上注册的里面，本对话能用几个"。
            if (rowOnInLayer(row)) acc.enabled += liveEnabledOf(row)
            return acc
          }, { total: 0, enabled: 0 }), [rows, scopeState])
          const summary = React.useMemo(() => ({
            total: rows.length,
            enabled: rows.filter(rowOnInLayer).length,
            tools: toolTotals.enabled,
            toolsTotal: toolTotals.total,
          }), [rows, toolTotals, scopeState])
          // 「全部启用 / 全部停用」按**服务器名**去重（会话覆盖与全局意图都按 serverName 键）：
          // 同名两层行只算一台，loader 行在全局层不可操作（补丁里没有它）。
          const bulkServers = React.useMemo(() => {
            const byName = new Map()
            for (const row of rows) {
              const name = String(row.serverName || row.id)
              if (byName.has(name)) continue
              if (!scopeIsSession() && row.level === 'loader') continue
              byName.set(name, row)
            }
            return [...byName.values()]
          }, [rows, scopeState.sessionId])
          const bulkAllOn = bulkServers.length > 0 && bulkServers.every(rowOnInLayer)
          const bulkEmpty = bulkServers.length === 0
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
          // filter 与分区（5 秒轮询换 rows 时整页重渲染也要重跑）。行的 key 未动。
          // 定序表 `mcpRank`：开关当场**不重排**，只有重新进这一页（组件重挂载）才重新置顶
          // —— 这一页没有「刷新」按钮（它自己 5 秒轮询），所以也不往 refresh 上挂 resetRank。
          const mcpRank = useRank()
          const grouped = React.useMemo(
            () => groups.map((group) => ({ group: group, rows: rankedFirst(mcpRank, (row) => row.id, visibleRows.filter(group.match), rowOnInLayer) })),
            [groups, visibleRows, scopeState],
          )

          // 状态口径：tone 只决定胶囊配色（ok=能用、bad=坏了、warn=当前没工具、muted=没在跑）。
          const liveStatus = (row) => {
            // 「刚翻开开关」这一条排在最前（但仍在 failed 之后）：新写进补丁的条目在宿主读到
            // 之前 `row.live` 干脆是空的，若让它先落到「未加载 / 已停止」，界面就是"点了开关
            // 先灰几秒才绿" —— 用户 2026-10-15 报的"看不出是不是启动中"正是这几秒。
            if (row.live && row.live.phase === 'failed') return { text: mt('mcp.live.failed'), tone: 'bad' }
            if (isStarting(row) && !(row.live && row.live.phase === 'active')) return { text: mt('mcp.live.loading'), tone: 'busy' }
            if (!row.live) return { text: mt('mcp.live.notLoaded'), tone: 'muted' }
            if (!row.live.enabled) return { text: mt('mcp.live.stopped'), tone: 'muted' }
            if (row.live.phase && row.live.phase !== 'active') return { text: mt('mcp.live.loading'), tone: 'busy' }
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
          // 工具数元信息：有被停用的工具时给「可用/总数」（场景档案收窄与手动逐工具开关
          // 写的是同一张停用表），否则就是总数 —— 与详情页每个工具的开关状态一致。
          //
          // 只按**真实注册**的数来显示：一个都没注册时不给数字（那台 server 现在没有工具，
          // 摆一个"13 个工具"就是拿缓存冒充现状；它上次连上时有多少个，由下面那行提示说明）。
          // 列表行改两行制（REDESIGN §3.4）后它从行中标签降为行 2 的元信息文字（tabular-nums）。
          const toolCountText = (row) => {
            const total = liveOf(row)
            if (total <= 0) return null
            const enabled = liveEnabledOf(row)
            return enabled < total
              ? mt('mcp.tools.countPartial', { enabled: enabled, total: total })
              : mt('mcp.tools.count', { count: total })
          }

          const renderRow = (row) => {
            const status = liveStatus(row)
            const hint = liveHint(row)
            // `loader` 行本来就没有可编辑面（配置来自 profile，不是补丁），开关 / 编辑 / 删除
            // 一律不出现；场景锁定则是"能改但被冻住" —— 控件**照常显示、置灰**，不再凭空消失
            //（用户 2026-10-12：「锁定情况下的 mcp 应该显示药丸开关、编辑、删除，只是变灰且
            // 不能删除」，与子智能体页锁定态同一副长相）。消失的控件让人以为"这行本来就不能
            // 编辑"，灰掉的控件才说得清"现在不能改"。
            const editable = row.level !== 'loader'
            const frozen = state.locked === true
            const actDisabled = frozen || busy !== null
            // 行 2 元信息：层级（loader 视图）/ 工具数 / 备注 —— 原行中标签列并入（REDESIGN §3.4）。
            // 启动命令 / URL **不上行**（用户 2026-10-16：`python -m fastgraph` 那串不需要显示）：
            // 它是详情弹窗里的字段，摆在列表行只会把行 2 变成一屏等宽噪声。
            const meta = []
            if (levelFilter === 'loader' && row.level && row.level !== 'loader') meta.push(React.createElement('span', { key: 'level' }, mt('mcp.level.' + row.level)))
            const toolCount = toolCountText(row)
            if (toolCount) meta.push(React.createElement('span', { key: 'tools', className: 'dsm-listrow-meta-info' }, toolCount))
            // 备注可能很长：给可收缩的 desc 类（min-width:0 + 省略号），超宽时截断而不是把行撑爆。
            if (row.notes) meta.push(React.createElement('span', { key: 'note', className: 'dsm-listrow-meta-desc', title: row.notes }, mt('mcp.note.prefix') + row.notes))
            // 全局层的意图状态只挂**临时运行 · N 个对话** —— 它是"全局 off 却仍在跑"的
            // 唯一解释，不标出来，用户会以为全局开关坏了。
            // 统一关闭不挂标签：开关本身就是关的，标签会长期占着这一行；状态由开关的
            // 悬浮说明承担。
            // 同名两层行只标在**第一行**上（两行说同一件事，标两遍只是噪声）。
            if (!scopeIsSession()) {
              const rowName = String(row.serverName || row.id)
              const firstOfName = rows.find((item) => String(item.serverName || item.id) === rowName) === row
              if (firstOfName) {
                // 六域共用的租约徽章出口：同一 HTML / class / tooltip。
                meta.push(leaseTag({ t: mt, tagKey: 'intent', domain: 'mcp', key: rowName, runtime: true }))
              }
            }
            // 行尾：一颗常驻动作 + 一颗 ⋯（用户 2026-10-16：「详情」要留边框）。
            // 「详情」是只读动作，锁定期间照常可用；编辑 / 删除进菜单，删除在菜单里红字。
            const actions = [
              React.createElement('button', { key: 'detail', type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: () => openDetail(row) }, mt('mcp.btn.detail')),
            ]
            if (editable) actions.push(React.createElement(RowMenu, {
              key: 'menu',
              label: mt('row.menu', { name: row.serverName }),
              items: [
                // 全局层的「统一关闭」：只在真有其他对话 / 工作区在临时用它时出现（没有租约时
                // 普通开关就能停，菜单不必多一项）。它是一次性动作，不在菜单里留「恢复启用」。
                // 会话层没有这一项 —— 会话只能"看不到它"，停整台机器是全局动作。
                ...(scopeIsSession() || scopeLeaseCount('mcp', String(row.serverName || row.id)) <= 0 ? [] : [{ key: 'intent-stop', label: mt('mcp.intent.stop'), danger: true, disabled: actDisabled, onClick: () => setStopConfirm(row) }]),
                { key: 'edit', label: mt('mcp.btn.edit'), disabled: actDisabled, onClick: () => openEdit(row) },
                { key: 'remove', label: mt('mcp.btn.remove'), danger: true, disabled: actDisabled, onClick: () => setConfirmRow(row) },
              ],
            }))
            return React.createElement(ListRow, {
              key: row.id,
              // 行首状态点只剩连接态一个（体检态那枚随体检一起删）：它的 title 就是
              // 「已连接 / 未运行 / 未启用」，正是原来那枚体检点想说的"这台现在什么状态"。
              // 会话作用域（0.21.2）：来源标记打在点上（用户 2026-10-19 裁定，开关不染色）。
              // 0.21.2 起不再用"全局开着"当门禁：全局关着的服务器也能被本会话拨开，
              // 那一格的来源标记照实画（点 = 这一格与本对话以外的状态不一样）。
              dots: [(function () {
                const name = String(row.serverName || row.id)
                const running = serverGlobalOn(row)
                const flag = scopeFlag('mcp', name, running)
                // 点 = **这一层**开不开（与右边那颗开关同值）。全局关着、被某个会话的租约
                // 拉起时点仍是灰的 —— 谁在用它由行 2 的「临时运行 · N 个对话」说明
                // （用户 2026-10-21）。开着的行继续用连接态（失败 / 加载中 / 工具全停）。
                const layerOn = scopeIsSession() ? flag.value : scopeGlobalOn('mcp', name, running)
                return React.createElement(StatusDot, {
                  key: 'live',
                  tone: layerOn ? (status.tone === 'muted' ? 'idle' : status.tone) : 'idle',
                  // 来源色只在「开着」时染；连接失败的红不能被来源绿盖掉。
                  scoped: layerOn && flag.scoped && (status.tone === 'ok' || status.tone === 'muted'),
                  title: layerOn ? status.text : mt('mcp.live.stopped'),
                })
              })()],
              name: row.serverName,
              tag: row.duplicate ? React.createElement('span', { className: 'dsm-tag dsm-tag-off' }, mt('mcp.duplicate')) : null,
              meta: meta.length ? meta : null,
              extra: [
                hint ? React.createElement('div', { key: 'hint', className: 'dsm-row-hint' }, '⚠ ' + hint) : null,
              ],
              // 会话作用域（0.21.2）：会话层下这一格表示"本会话看不看得到它"；来源看行首那颗点。
              // 会话层不要求可编辑（补丁里那行怎么配的与本会话无关）。
              side: (function () {
                if (scopeIsSession()) {
                  // 会话层的开关是**服务器级**（同名两层行合并后只有一个状态）。
                  var globalOn = serverGlobalOn(row)
                  var flag = scopeFlag('mcp', String(row.serverName || row.id), globalOn)
                  // 旧的全局 blocked 记录压过会话层：那颗开关拨了也会被服务端拒掉，直接置灰并说明。
                  var blockedHere = scopeIntentOf('mcp', String(row.serverName || row.id)) === 'blocked'
                  // 全局关着的服务器也能在本会话拨开（0.21.2）：成为本会话的租约（仅本对话可见）。
                  return React.createElement(Switch, {
                    on: flag.value,
                    scoped: flag.scoped,
                    disabled: busy !== null || scopeWriteLocked(false) || blockedHere,
                    title: blockedHere ? mt('scope.intent.blockedHint')
                      : globalOn ? undefined : mt('mcp.session.startGlobal'),
                    label: mt('mcp.toggleServer') + ' ' + row.serverName,
                    onClick: () => toggleRow(row),
                  })
                }
                // 全局层 = **意图**（0.21.2）：开关值是 `on / off`，运行态（补丁）由对账器维持。
                // 同名两行显示同一个意图值（意图按 serverName 键），不会一行开一行关。
                const nameHere = String(row.serverName || row.id)
                const intentHere = scopeIntentOf('mcp', nameHere)
                const leasesHere = scopeLeaseCount('mcp', nameHere)
                return editable ? React.createElement(Switch, {
                  on: serverGlobalOn(row),
                  scoped: false,
                  disabled: actDisabled,
                  title: intentHere === 'blocked' ? mt('mcp.intent.blockedHint')
                    : leasesHere > 0 ? mt('mcp.intent.leaseHint', { count: leasesHere })
                      : undefined,
                  label: mt('mcp.toggleServer') + ' ' + row.serverName,
                  onClick: () => toggleRow(row),
                }) : null
              })(),
              actions,
            })
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
                  // 分组头只留数字（用户 2026-10-17）：量词（"个服务"）在每一组的标题里已经说过
                  // 一遍，再挂在数字后面只是重复；同一个数字在三页里一个样，扫起来才对得齐。
                  React.createElement('span', { className: 'dsm-count' }, String(groupRows.length)),
                  group.path ? React.createElement('span', { className: 'dsm-path', title: group.path }, group.path) : null)),
              open ? React.createElement('div', { className: 'dsm-source-body' },
                // 表头已随两行制拆除（REDESIGN §3.4 没有表头行；列对齐改由行内两行承担），
                // 行直接铺在卡片体里、行间分隔线（切片四）。
                groupRows.map(renderRow)) : null)
          }

          const configRow = (label, value) => React.createElement('div', { className: 'dsm-fm-row', key: label },
            React.createElement('div', { className: 'dsm-fm-key' }, label),
            React.createElement('div', { className: 'dsm-fm-val' }, value))

          // 会话层里服务器本身看不到时，逐工具开关置灰（先开服务器再拨工具）：
          // 这里不提供"拨一个工具就把整台服务器拉起来"的捷径，避免用户只想要一条工具、
          // 结果整台服务器临时跑起来。服务器开关本身仍可在本层打开（按租约临时运行）。
          const detailServerHidden = !!detail && scopeIsSession() &&
            !scopeFlag('mcp', String(detail.row.serverName || detail.row.id), serverGlobalOn(detail.row)).value
          const toolListNode = detail && (detail.loading
            ? React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.loading'))
            : detail.error
              ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, mt('mcp.tools.loadFailed') + detail.error)
              : (detail.tools || []).length === 0
                ? React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.none'))
                : React.createElement(React.Fragment, null,
                    // 停用表读不出来：所有开关都会是灰的，先解释为什么，别让用户以为是自己关的。
                    detailToolsUnknown ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, mt('mcp.tools.stateUnknown')) : null,
                    React.createElement('div', { className: 'dsm-help' }, mt('mcp.tools.note')),
                    React.createElement('div', { className: 'dsm-tools' }, (detail.tools || []).map((tool) => React.createElement('div', { className: 'dsm-tool' + ((detailServerHidden ? false : toolFlag(detail.row, tool).value) === false ? ' dsm-tool-off' : ''), key: tool.name },
                      React.createElement('div', { className: 'dsm-tool-name-row' },
                        React.createElement('div', { className: 'dsm-tool-name' }, tool.name),
                        // 描述来自「已知工具」缓存（服务器未运行）→ 标明是旧数据，不假装实时。
                        tool.stale ? React.createElement('span', { className: 'dsm-tag' }, mt('mcp.tools.stale')) : null,
                        // 逐工具的「N 个对话单独设置」：这一格此前**两侧都没有徽章来源**
                        // （`countViewClaims` 只列了 memory / subagents / quickPrompts，
                        // `INTENT_DOMAINS` 又不含 mcpTools）—— 会话里拨开一个全局关着的工具，
                        // 全局页这一格什么标记都没有。键与覆盖表 / 档案同一套 `<server>/<tool>`。
                        leaseTag({ t: mt, tagKey: 'lease', domain: 'mcpTools', key: String(detail.row.serverName || detail.row.id) + '/' + tool.name, runtime: false }),
                        // 会话作用域（0.21.2）：逐工具开关在本层拨（会话层写 `mcpTools`，
                        // 键 `<server>/<tool>`）。全局关着的那条也能在本会话拨开 ——
                        // 服务端把它的服务器按租约临时运行，警告随回执带回来。
                        React.createElement(Switch, {
                          on: detailServerHidden ? false : toolFlag(detail.row, tool).value,
                          scoped: detailServerHidden ? false : toolFlag(detail.row, tool).scoped,
                          disabled: busy !== null || scopeWriteLocked(state.locked === true) || detailServerHidden || detailToolsUnknown,
                          title: detailToolsUnknown ? mt('mcp.tools.stateUnknown')
                            : detailServerHidden ? mt('mcp.tools.serverOff')
                              : !scopeIsSession() || tool.enabled !== false ? undefined : mt('mcp.session.startGlobal'),
                          label: mt('mcp.toggleTool') + ' ' + tool.name,
                          onClick: () => toggleTool(detail.row, tool),
                        })),
                      tool.description ? React.createElement(ToolDesc, { text: tool.description, expandLabel: mt('mcp.tools.expand'), collapseLabel: mt('mcp.tools.collapse') }) : null,
                      (tool.parameters && tool.parameters.length > 0) ? React.createElement('div', { className: 'dsm-tool-params' }, tool.parameters.map((param) => React.createElement('div', { className: 'dsm-tool-param', key: param.key },
                          React.createElement('span', { className: 'dsm-tool-param-key' }, param.key + (param.required ? ' *' : '')),
                          React.createElement('span', { className: 'dsm-tool-param-type' }, param.type || 'any'),
                          React.createElement('span', { className: 'dsm-tool-param-desc' }, param.description || '')))) : null)))))

          const anyGroupVisible = grouped.some((entry) => entry.rows.length > 0)
          // 列表四态（REDESIGN §12.2，切片四）：加载 / 失败（EmptyState + 重试）/ 无结果
          // （EmptyState + 清除筛选）/ 空 / 有数据。失败时页面顶部那条错误横幅照旧 ——
          // 它同时承担「有缓存数据时的错误」与令牌没过两种渠道，列表区这里不再裸奔空话。
          const groupsNode = (state.loading && rows.length === 0)
            ? React.createElement(ListStates, { key: 'states', t: mt, state: 'loading' })
            : state.error
              ? React.createElement(ListStates, { key: 'states', t: mt, state: 'error', text: state.error, onRetry: () => refresh() })
              : anyGroupVisible
                ? React.createElement('div', { className: 'dsm-sources' }, grouped.map((entry) => renderGroup(entry.group, entry.rows)))
                : (normalizedQuery || levelFilter)
                  ? React.createElement(ListStates, { key: 'states', t: mt, state: 'search', text: mt('mcp.empty.search'), onClearFilter: () => { setQuery(''); setLevelFilter('') } })
                  : React.createElement(ListStates, { key: 'states', t: mt, state: 'empty', text: mt('mcp.empty') })

          // 密钥框里出现打码值时给一句说明：宿主侧会拿旧真值顶替、不会把打码值写进补丁
          // （见 src/mcp/secret-guard.ts），但用户得先知道自己眼前看到的**不是原文** ——
          // 否则他会以为真密钥长这样，或者以为保存会把它改掉。
          // `!!formModal` 不能省：弹窗关着时它就是 null，这里先读 `.env` 会在每次渲染抛错。
          const maskedInForm = !!formModal && /•{3,}/.test(String(formModal.env || '') + String(formModal.headers || ''))
          const formModalNode = formModal && React.createElement(Modal, {
            key: 'mcp-form',
            className: 'dsm-modal-mcp-form',
            title: formModal.mode === 'edit' ? mt('mcp.form.editTitle') + formModal.id : mt('mcp.form.addTitle'),
            closeLabel: mt('btn.close'),
            onClose: dismissForm,
          },
              React.createElement('div', { className: 'dsm-form' },
                maskedInForm ? React.createElement(Notice, { kind: 'warn', text: mt('mcp.form.maskedHint') }) : null,
                formError ? React.createElement(Notice, { kind: 'error', text: formError }) : null,
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.serverName')),
                React.createElement('input', { className: 'dsm-control', value: formModal.serverName, placeholder: 'e.g. github', onChange: setFormField('serverName') }),
                React.createElement('span', { className: 'dsm-help' }, mt('mcp.field.serverName.hint'))),
              // 传输方式用分段控件而不是下拉（用户 2026-10-15）：只有 stdio /
              // streamable-http 两个互斥值，下拉要多点一下才能看见全部选项，
              // 且选中态只占一行里的一小条。与「重名处理」「提示词类型」同款。
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.transport')),
                React.createElement('div', { className: 'dsm-form-seg', role: 'group', 'aria-label': mt('mcp.field.transport') },
                  MCP_TRANSPORT_OPTIONS.map(function (o) {
                    return React.createElement('button', {
                      key: o.value, type: 'button',
                      'aria-pressed': formModal.transport === o.value ? 'true' : 'false',
                      onClick: function () { setFormValue('transport', o.value) },
                    }, o.label);
                  }))),
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
                    React.createElement('label', { className: 'dsm-field dsm-field-fill' },
                      React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.args')),
                      React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.args, placeholder: '-y\n@modelcontextprotocol/server-github', onChange: setFormField('args') })),
                    // 环境变量的「路径按系统写法填」那句提示删除（用户 2026-10-15）：它讲的是
                    // 少数人才会碰的细节，却把这一格顶高一行、也让 stdio 与 http 两档更不齐。
                    React.createElement('label', { className: 'dsm-field dsm-field-fill' },
                      React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.env')),
                      React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.env, placeholder: 'GITHUB_TOKEN=xxx', onChange: setFormField('env') }))),
              formModal.transport === 'streamable-http'
                ? React.createElement('label', { className: 'dsm-field dsm-field-fill' },
                    React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.headers')),
                    React.createElement('textarea', { className: 'dsm-control dsm-textarea-sm', value: formModal.headers, placeholder: 'Authorization=Bearer xxx', onChange: setFormField('headers') }))
                : null,
              // 备注放在表单**最下面**：它是可选项，说的又是"这台怎么用"，不该插在必填的连接参数中间。
              // 默认不填 = 侧车里不产生条目。新增与编辑**都出现**（用户 2026-10-18：「备注编辑功能
              // 应该在编辑页，详细页只能看」）：详情页只读，写备注这一件事只在这里做。
              // 上限就是注入段的截断长度 `MCP_NOTE_MAX` —— 写多少模型就能读到多少。
              React.createElement('label', { className: 'dsm-field' },
                React.createElement('div', { className: 'dsm-budget-meta' },
                  React.createElement('span', { className: 'dsm-label' }, mt('mcp.field.note')),
                  React.createElement('span', { className: 'dsm-char-count' }, String(formModal.note || '').length + ' / ' + MCP_NOTE_MAX)),
                React.createElement('input', { className: 'dsm-control', value: formModal.note || '', maxLength: MCP_NOTE_MAX, placeholder: mt('mcp.field.note.placeholder'), onChange: setFormField('note') }))),
            // 冲突（补丁在别处被改过）：两条出路，别让用户只能关掉重来。
            formModal.stale ? React.createElement('div', { className: 'dsm-feedback-row' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy === 'form', onClick: reloadForm }, t('stale.write.reload')),
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy === 'form', onClick: function () { submitForm(true) } }, t('stale.write.overwrite'))) : null,
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy === 'form' || !formModal.serverName.trim(), onClick: function () { submitForm(false) } }, formModal.mode === 'edit' ? mt('mcp.btn.save') : mt('mcp.btn.add'))))

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
                // 两颗动作包成一组（用户 2026-10-15：「重启怎么在中间」）—— space-between
                // 摊三个子元素时中间那个会被顶到整行正中，标题左、动作组右才对。
                React.createElement('span', { className: 'dsm-detail-title-acts' },
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', title: mt('mcp.btn.restart.title'), disabled: busy !== null || detail.row.level === 'loader', onClick: () => restartRow(detail.row) }, mt('mcp.btn.restart')),
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: toggleReveal }, reveal ? mt('mcp.detail.hideSecret') : mt('mcp.detail.showSecret')))),
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
              // 备注在详情页**只读**（用户 2026-10-18：「mcp 备注编辑功能应该在编辑页，详细页只能看」）：
              // 详情是"看这台现在配了什么"的地方，要改就走 ⋯ →「编辑」那张表 ——
              // 写动作只有一个入口，不会出现"改了这里忘了那里"。
              // 没备注时**也渲染同一个框**（用户 2026-10-18：「没备注也应该有边框，只是显示灰色字
              // 当前没有备注」）：有备注时是一块正文，没备注时只剩标题、这一节看着像没渲染出来。
              React.createElement('div', { className: 'dsm-detail-title' }, mt('mcp.detail.note')),
              React.createElement('p', { className: 'dsm-detail-note' + (detail.row.notes ? '' : ' dsm-detail-note-empty') },
                detail.row.notes || mt('mcp.detail.note.empty'))),
            React.createElement('div', { className: 'dsm-detail-section' },
              React.createElement('div', { className: 'dsm-detail-title dsm-detail-title-row' },
                mt('mcp.detail.tools', { count: detail.loading ? '…' : (detail.tools || []).length }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null || detail.loading === true, onClick: refreshTools }, mt('mcp.detail.toolsRefresh'))),
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

          const disabledResetNode = disabledResetConfirm && React.createElement(Modal, {
            key: 'mcp-disabled-reset',
            title: mt('mcp.disabledReset.title'),
            closeLabel: mt('btn.close'),
            onClose: () => setDisabledResetConfirm(false),
          },
            React.createElement('p', { className: 'dsm-desc' }, mt('mcp.disabledReset.desc')),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy !== null, onClick: doDisabledReset }, mt('mcp.disabledReset.confirm'))))

          const confirmNode = confirmRow && React.createElement(Modal, {
            key: 'mcp-remove',
            title: mt('mcp.remove.title'),
            closeLabel: mt('btn.close'),
            onClose: () => setConfirmRow(null),
          },
            React.createElement('p', { className: 'dsm-desc' }, mt('mcp.remove.desc', { name: confirmRow.serverName })),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', onClick: confirmRemove }, mt('mcp.btn.remove'))))

          // 「统一关闭」确认：它会**立即**停掉连接，还会把正在用它的会话 / 工作区的开关
          // 一并关掉 —— 与普通关闭不是一回事，必须问一次，并把影响说清。
          const stopNode = stopConfirm && React.createElement(Modal, {
            key: 'mcp-stop',
            title: mt('mcp.intent.stopTitle'),
            closeLabel: mt('btn.close'),
            onClose: () => setStopConfirm(null),
          },
            React.createElement('p', { className: 'dsm-desc' }, mt('mcp.intent.stopDesc', { name: stopConfirm.serverName })),
            React.createElement('div', { className: 'dsm-modal-actions' },
              React.createElement('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn-danger',
                onClick: () => { const row = stopConfirm; setStopConfirm(null); stopServerNow(row) },
              }, mt('mcp.intent.stop'))))

          return React.createElement('section', { className: 'dsm-section' },
            // 页头一行化（REDESIGN §3 + §6）：新增(实底) · 导入 · 导出 · 整理补丁 · 全部启用。
            // 低频两件（整理补丁 / 批量启停）用 quiet 弱化视觉权重（§6 备注），全部常驻可见 ——
            // 不收 ⋯ 菜单、不做悬停浮现。（原先这里还有一颗「全部检查」，2026-10-12 已移除。）
            React.createElement(PageHead, {
              title: 'MCP',
              desc: mt('mcp.desc'),
              stats: [
                // 两格都是「开着的 / 总数」的比例口径（用户 2026-10-12：统计要"有用"）：
                // 「7 个服务」答不了"有几个真在跑"，「42 个工具」也答不了"挂了多少没挂上"。
                // 分母服务端一直在给（summary.total / toolsTotal），此前只显示分子等于把答案丢了。
                [summary.enabled + '/' + summary.total, mt('mcp.stat.total')],
                [summary.tools + '/' + summary.toolsTotal, mt('mcp.stat.tools')],
              ],
              actions: [
                React.createElement('button', { key: 'new', type: 'button', className: 'dsm-btn', disabled: state.locked === true, onClick: openAdd }, mt('mcp.btn.new')),
                // 「导入」是「一次建好一批」，与新增同一个写路径（`mcpm-import`），所以场景锁定期间同样置灰。
                // 导出是只读动作，锁定期间照常用（拿配置不该要求先解锁环境）。
                React.createElement('button', { key: 'import', type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.locked === true, onClick: () => setJsonImportOpen(true) }, mt('mcp.importJson.btn')),
                React.createElement('button', { key: 'export', type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: state.loading, onClick: () => setJsonExportOpen(true) }, mt('mcp.exportJson.btn')),
                React.createElement('button', { key: 'compact', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null || state.loading || state.locked === true, title: mt('mcp.btn.compact.title'), onClick: () => setCompactConfirm(true) }, mt('mcp.btn.compact')),
                // 批量启停与页头其余动作同栏。场景内**照常可用**：
                // 改动会同步写进当前场景的档案（宿主 syncSwitchToScene），只有场景锁定才冻结。
                // 两个方向各取各的字面量键，不合成三元（词典键必须 t('字面量') 直传）。
                React.createElement('button', { key: 'setall', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null || state.loading || bulkEmpty || scopeWriteLocked(false), onClick: setAllServers },
                  // 会话层只能藏不能连：全局关着的那几台本来就不可能亮起来，判"是不是全开"
                  // 要把它们排除 —— 否则全部可见之后按钮仍写着「全部启用」，点了什么也不发生。
                  bulkAllOn ? mt('mcp.btn.disableAll') : mt('mcp.btn.enableAll')),
                // 只在有临时运行时出现（会话 / 场景 / 工作区正在认领某几台）；
                // 与行菜单的「统一关闭」同一个 op，别在这里另写一条只改意图的路径。
                scopeLeaseKeys('mcp').length > 0 ? React.createElement('button', { key: 'stopall', type: 'button', className: 'dsm-btn dsm-btn-danger-outline', disabled: busy !== null || state.loading || state.locked === true, onClick: stopAllServers }, mt('scope.stopAll')) : null,
              ],
            }),
            // 场景锁只冻结全局写入；会话层改的是本对话的可见性，照样能改 —— 不显示这条。
            state.locked === true && !scopeIsSession() ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, mt('lock.banner')) : null,
            // 场景未锁定时开关照常可用：说清「改动会同步写进该场景的档案」，别让用户担心白改。
            // 锁定期间不显示 —— 那时开关是灰的，"改动会写进档案"是句空话，与上一条锁定横幅
            // 并排还会互相矛盾（用户 2026-09-19）。
            // 会话层不显示这条：它说的是「改动会同步档案」，而本层的开关写的是会话覆盖，
            // 与档案无关（说了就是假话）。本层另有作用域条上那句说明。
            (state.locked !== true && state.scene && !scopeIsSession()) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, mt('scene.switch.banner', { scene: state.scene })) : null,
            // 列表工具条（REDESIGN §3.3，切片四）：搜索 + 层级筛选住 children；本页无批量动作，
            // batch 槽留空。
            React.createElement(Toolbar, { key: 'filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', value: query, 'aria-label': mt('mcp.search'), placeholder: mt('mcp.search.placeholder'), onChange: (ev) => setQuery(ev.target.value) }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, { value: levelFilter, options: mcpLevelOptions(), onChange: setLevelFilter }))),
            React.createElement(Notice, { kind: msg && msg.kind, text: msg && msg.text }),
            React.createElement(Notice, { kind: 'err', text: state.error }),
            React.createElement(Notice, { kind: 'warn', text: (state.errors && state.errors.length > 0) ? mt('mcp.err.warnings') + state.errors.join('；') : null }),
            React.createElement(Notice, { kind: 'warn', text: (state.warnings && state.warnings.length > 0) ? state.warnings.join('；') : null }),
            // 停用表 unknown：不是"没有停用"，而是"读不出来"。所有 mcp__* 已被执行侧拒绝，
            // 详情页的逐工具开关也会锁住（见 detailToolsUnknown）。这一条必须带恢复入口 ——
            // 只告诉用户"坏了"而不给动作，等于把他推回文件系统。
            state.disabledState === 'unknown' ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' },
              React.createElement('span', null, mt('mcp.disabled.unknown')),
              React.createElement('button', { key: 'reset', type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy !== null, onClick: () => setDisabledResetConfirm(true) }, mt('mcp.disabledReset.btn'))) : null,
            React.createElement(UndoBar, { key: 'undo', undo: undo, busy: busy !== null, t: mt, onUndo: undoSetAll, onClose: dismissUndo }),
            groupsNode,
            formModalNode,
            detailNode,
            compactNode,
            disabledResetNode,
            confirmNode,
            stopNode,
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
          // 新建撞名确认窗（42-shared-ui.js 的 DupNameDialog）：`{ name, finalName, kind }`。
          // 提示词是**第五个**用它的域（记忆 / 场景 / 技能 / 子智能体之外）—— 前四个在 2026-10-14
          // 一起改成了"先问一句"，提示词当时漏在外面，撞名照旧是一句「id 已存在」把人挡回去。
          var ca = React.useState(null), dupAsk = ca[0], setDupAsk = ca[1]
          var ac = React.useState(null), applyConfirm = ac[0], setApplyConfirm = ac[1]
          // 回收站：true = 打开本页那一个回收站（42-shared-ui.js 的 TrashModal，domain = prompts）。
          // 提示词域（预设 + 快捷）的清单加载与恢复/永久删除都在组件内部完成，
          // 本页只在写操作后重读自己的数据。
          var ts = React.useState(false), trash = ts[0], setTrash = ts[1]
          // 会话层「编辑本会话生效正文」（0.21.2）：null = 关闭；{content, error}。
          var se = React.useState(null), sessionEdit = se[0], setSessionEdit = se[1]
          // D14：导出弹窗（null = 关闭；{busy, result}）。
          var xo = React.useState(null), exportState = xo[0], setExportState = xo[1]
          // ── 快捷提示词（用户存好的现成文字，只在对话框 `/` 菜单里由自己点出来）────
          // 独立一处状态，不塞进上面的 `state`：那边 `refresh()` 是整对象替换，两份数据混在
          // 一次替换里更容易漏；而快捷列表读失败不该把预设列表一起打成错误页。
          var qs = React.useState({ loading: true, error: null, prompts: [] })
          var quick = qs[0], setQuick = qs[1]
          var qk = React.useState(null), quickEdit = qk[0], setQuickEdit = qk[1]
          var qf = React.useState(null), quickConfirm = qf[0], setQuickConfirm = qf[1]
          // 单条快捷提示词的「统一关闭」确认（`{ id }`）：切断的是各对话 / 工作区正在单独用它的那份。
          var qz = React.useState(null), quickStop = qz[0], setQuickStop = qz[1]
          // 三个弹窗（新增预设 / 编辑预设 / 编辑快捷提示词）各自一份关窗暂存（见 42-shared-ui.js：
          // 关窗存、打开取，成功提交不走这条路，所以没有"成功后要记得清"那一步）。
          useFormDraftScope('prompt:')
          /** 取数用的会话 id：全局层传空串（= 服务端按全局口径算）。 */
          function scopeSessionId() { return scopeIsSession() ? scopeState.sessionId : '' }
          function refreshQuick() {
            // 快捷词的 `enabled` 按本会话覆盖投影（quick-prompts.ts）；不带 sessionId 时
            // 会话层看到的永远是全局值 —— 切了层却看不出任何一行变了，就是这个漏。
            apiCall('quickprompt-list', { sessionId: scopeSessionId() })
              .then(function (res) {
                if (res && res.ok) setQuick({ loading: false, error: null, prompts: res.prompts || [] })
                else setQuick({ loading: false, error: (res && res.error) || t('mcp.msg.loadFailed'), prompts: [] })
              })
              .catch(function (e) { setQuick({ loading: false, error: errMsg(e), prompts: [] }) })
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
           * 「全局提示词 / 快捷提示词」二选一（REDESIGN §5.2 分段控件，切片五换装）。
           *
           * 为什么放在弹窗里而不是页头：这两类东西的**读法完全不同**（一份会覆盖写全局
           * AGENTS.md、一份只是贴进对话框的文字），把它们混进同一个列表再打标签，用户要先
           * 看懂标签才知道点下去会发生什么。新建与导入都先问一次，问在最贴近动作的地方。
           *
           * 两项恒有一项按下（点已按下的那颗不改状态）—— 没有"都不选"这一态，所以是
           * 单选的语义；原先是「单选语义、打勾框的样子」，现在是同语义的正确控件。
           */
          function kindPicker(value, onChange) {
            const pick = function (kind) {
              return React.createElement('button', { key: kind, type: 'button', 'aria-pressed': value === kind, onClick: function () { onChange(kind) } },
                t('prompts.kind.' + kind))
            }
            return React.createElement('div', { className: 'dsm-field' },
              React.createElement('span', { className: 'dsm-label' }, t('prompts.kind.label')),
              React.createElement('div', { className: 'dsm-form-seg', role: 'group' }, pick('global'), pick('quick')),
              React.createElement('p', { className: 'dsm-help' }, t('prompts.kind.' + value + '.hint')))
          }
          function importIdOf(name) {
            return String(name || '').replace(/\.(md|markdown|txt)$/i, '').trim().replace(/[\\/<>:"|?*]+/g, '-') || 'imported'
          }
          function doImportFiles(files) {
            if (promptWriteDenied()) return
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
            // 会话层把本会话 id 一起带上：服务端拿「本会话真正注入的正文」与每份预设比对，
            // 标出会话层沿用的那一份（全局应用 / 场景 / 冻结快照都不带 presetId，只能比内容）。
            apiCall('agentsmd-list', scopeIsSession() ? { sessionId: scopeState.sessionId } : {}).then(function (res) {
              // 刷新即清掉上一次的「拒绝」说明（它解释的是那一次点击，不是常驻状态）。
              // **`notice` 要留着**：操作成功后是先写回执、再调 refresh 重读的；这里返回一个
              // 新状态对象会把回执一起吞掉（全局应用的「不影响已存在会话」正是这样消失的）。
              setState(function (s) { return { loading: false, error: res && res.ok ? null : ((res && res.error) || mt('mcp.msg.loadFailed')), presets: (res && res.presets) || [], current: s.current, scenePrompt: (res && res.scenePrompt) || null, anyLocked: (res && res.anyLocked) === true, deny: res && res.ok ? null : s.deny, notice: s.notice } })
            }).catch(function (e) { setState(function (s) { return { loading: false, error: errMsg(e), presets: [], current: null, scenePrompt: null, deny: null, notice: s.notice } }) })
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
          // 本页订阅当前层（0.21.2）：快捷词每一行的生效值与来源都跟着层走。
          var scopeState = useScopeLayer()
          // 本会话的提示词覆盖（会话层才有）：`{presetId?} / {content?}`，null = 没覆盖。
          var sessionPrompt = scopeIsSession() && scopeState.prompt ? scopeState.prompt.override : null
          // 本会话正文是**手写**的（不是某份预设）：此时列表里哪一份都不该标「沿用」——
          // 注入的正文不来自任何预设，标了就会让用户以为应用的是那一份（0.21.2 复核）。
          var sessionCustomBody = !!sessionPrompt && typeof sessionPrompt.content === 'string' && sessionPrompt.content !== ''
          // 切层要重取：`quickprompt-list` 带 `sessionId` 时按本会话投影 `enabled`；
          // 预设那两块（`agentsmd-list` / `agentsmd-get-current`）是全局口径，跟着重取一次
          // 也无妨 —— 它们在会话层里不该显示覆盖值，重取正好把上一层的残留清掉。
          React.useEffect(function () { refresh() }, [scopeState.sessionId, scopeState.revision])

          var cur = state.current
          // 场景接管基线时（scenePrompt 指向某个启用场景的绑定），提示词页的「应用」只对
          // 场景绑定的那一份可用：应用别的预设会绕过场景绑定，造成「场景页显示 A、实际注入 B、
          // A 不能删而 B 能删」这类各说各话的状态（用户实测）。同一份 = 「重新应用」
          // （把被手改的 AGENTS.md 写回场景绑定的内容）→ 仍放行。
          var sceneDriver = state.scenePrompt && state.scenePrompt.scene && state.scenePrompt.presetId && state.scenePrompt.missing !== true ? state.scenePrompt : null
          var sceneDriverLabel = sceneDriver ? (sceneDriver.label || sceneDriver.scene) : ''
          // 「取消应用」可不可用 = 宿主那边 `__last-applied__` 里有没有「链起点」
          // （`agentsmd-get-current` 回的 `unapplyAvailable`）。**播种出来的 default 没有记录**
          // —— 它内容与 AGENTS.md 相同、显示「生效中」，却从未发生过写入，所以关不掉；
          // 那种情况点开关只给一条说明，并把出路（应用别的预设 / 直接编辑 AGENTS.md）说清楚。
          var unapplyReady = !!(state.current && state.current.unapplyAvailable === true)
          // 取消应用会**删掉文件**（开始应用之前 AGENTS.md 根本不存在）—— 这是个不可逆感很强的动作，
          // 确认弹窗与开关悬停都必须提前说清，不能点下去才知道（用户 2026-10-10 反馈
          // 「取消应用，AGENTS.md 还是存在」，那次的成因是删文件这一支压根走不通）。
          var unapplyRemoves = unapplyReady && state.current.unapplyRemoves === true
          /** 引用说明：判定在宿主（scene-prompt-sync），这里只负责把它说成人话。 */
          function refText(r) {
            if (r.kind === 'scene') return t(r.active ? 'agm.ref.sceneActive' : 'agm.ref.scene', { scene: r.label || r.scene })
            if (r.kind === 'restore') return t('agm.ref.restore')
            // 两处 `t(...)` 分开写，**不要合成 `t(cond ? 'a' : 'b')`**：check-i18n 只认
            // `t('字面量')`，写成三元之后两个键都不再被统计，改名或打错字就没人拦得住了。
            return r.applied === true ? t('agm.ref.fileApplied') : t('agm.ref.file')
          }
          /**
           * **拦得住删除的**引用说明（其余引用由行上的标签承担）。
           *
           * 判据与宿主逐字一致（`ops/prompts.ts` 的 `agentsmd-remove`），两边必须同源 ——
           * 不同源就会出现「按钮点得动、点了却被拒」或反过来「按钮灰着、其实删得掉」。
           *   ① 场景绑定 → 删了场景静默失效。
           *   ② **当前应用的**那份（`file` + `applied`）→ 删了会留下一个用户看不懂的中间态：
           *      AGENTS.md 内容一字不变、**照旧生效**，但界面上再没有预设对应它。用户看到的是
           *      「我把它删了，怎么全局提示词还在？」（2026-10-10 反馈），所以拦住并引导先取消应用。
           *
           * **`applied === false` 的 `file` 必须放行**：那是首次打开时自动播种出来的副本（内容与
           * AGENTS.md 相同、却从未被「应用」过），拦它没有任何出路 —— 它没有链起点可回，
           * 取消应用也关不掉，就是死路。
           */
          function blockingRefsOf(p) {
            return (p.refs || []).filter(function (r) { return r.kind === 'scene' || (r.kind === 'file' && r.applied === true) }).map(refText)
          }
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
          /**
           * 写口的**最后一道收口**（0.21.2）：按钮置灰只是提示，键盘 / 残留状态 / 未来的新入口
           * 都可能绕过它。所有会写提示词内容的函数开头都过这一关，拦下时把原因说成一条 notice。
           *
           * `promptWriteBlocked` 是渲染期赋值的 `var`（函数作用域提升），这些写函数只在
           * 用户事件里调用 —— 那时渲染早已跑完，读到的是最新一份判据。
           */
          function promptWriteDenied() {
            if (!promptWriteBlocked) return false
            setState(function (s) { return Object.assign({}, s, { notice: { kind: 'warn', text: promptBlockTitle } }) })
            return true
          }
          function openEdit(p) {
            beginAction()
            // 30 秒内重开同一份：把刚才关掉的那份编辑内容填回去，不重读磁盘。
            var draft = takeFormDraft('prompt:edit:' + p.id)
            if (draft) { setEditModal(draft); return }
            // id 可改：改名 = 目录改名，宿主会把场景绑定一起改名（见 rules-rebind-prompt）。
            apiCall('agentsmd-read', { id: p.id }).then(function (res) {
              if (res && res.ok) setEditModal({ id: p.id, nextId: p.id, content: res.content, description: p.description || '', stamp: res.stamp })
              else actionFailed(res)
            }).catch(actionFailed)
          }
          /**
           * 冲突后的「重新加载」：丢掉本地改动，重读磁盘那一份（连同新指纹）。
           * 不做静默合并 —— 两边都改过时没有任何可靠的合并判据，让用户看着最新内容重改更安全。
           */
          function reloadEdit() {
            if (!editModal) return
            beginAction()
            setBusy('reload')
            apiCall('agentsmd-read', { id: editModal.id }).then(function (res) {
              setBusy(null)
              if (res && res.ok) {
                setEditModal({ id: editModal.id, nextId: editModal.nextId || editModal.id, content: res.content, description: editModal.description || '', stamp: res.stamp })
              } else actionFailed(res)
            }).catch(function (e) { setBusy(null); actionFailed(e) })
          }
          function doApply(id) {
            // 会话层：应用预设 = 写侧车 `prompt.presetId`（全局基线一个字不动）。
            if (scopeIsSession()) {
              beginAction()
              setBusy('apply-' + id)
              scopeWritePrompt({ action: 'apply', presetId: id }).then(function (res) {
                setBusy(null); setApplyConfirm(null)
                if (res && res.ok === false) { actionFailed(res); return }
                setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: scopeT('scope.prompt.appliedToSession', { id: id }) } }) })
                refresh()
              }).catch(function (e) { setBusy(null); setApplyConfirm(null); actionFailed(e) })
              return
            }
            if (promptWriteDenied()) return
            beginAction()
            setBusy('apply-' + id)
            // 应用会写全局基线（接管期间还可能改绑场景），失败必须可见 —— 静默返回会让
            // 用户以为已写入（按钮恢复可点，文件却没变）。与 doRemove 同一套显示路径。
            //
            // ⚠️ 失败**不能**写进 `state.error`：那一支是「列表加载失败」的位置，会把整份
            // 预设列表换成一条错误横幅 —— 统计还在（读的是 state.presets）、列表没了，看起来
            // 就像「提示词被覆盖了」（用户实测 2026-09-19，令牌没过时点「重新应用」即如此）。
            // 走 actionFailed 的一次性横幅：可见、不顶掉列表。
            // `expectedStamp` = 页面加载 / 上次刷新时那份全局文件的指纹：文件在别处被改过时
            // 拒绝覆盖（应用会整份改写 AGENTS.md，静默覆盖别人的手改是最贵的一种丢数据）。
            var applyArgs = { id: id }
            if (state.current && state.current.stamp) applyArgs.expectedStamp = state.current.stamp
            apiCall('agentsmd-apply', applyArgs).then(function (res) {
              setBusy(null); setApplyConfirm(null)
              if (res && res.ok === false) {
                actionFailed(res.code === 'stale-write' ? { ok: false, error: t('stale.write.conflictApply') } : res)
                return
              }
              // 0.21.2 第三轮：全局写口改成「未来基线的来源」，已存在会话冻结在各自快照里。
              // 回执必须把这一点说出来，否则用户会以为刚应用的那份已经进了当前上下文。
              setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: scopeIsWorkspace() ? t('scope.prompt.globalApplied.workspace', { id: id }) : t('scope.prompt.globalApplied', { id: id }) } }) })
              refresh()
            }).catch(function (e) { setBusy(null); setApplyConfirm(null); actionFailed(e) })
          }
          /**
           * 取消应用：把全局基线恢复成**链起点**（宿主按 `__last-applied__` 里的记录办）——
           * 起点有内容就把那份写回去，起点文件不存在就把 AGENTS.md 删掉。**中途应用过别的预设
           * 也一并撤销**（一步回到起点，不是只退一步；见 `service.ts` 的 `backupGlobal`）。
           * 这是那颗「生效中」开关的**关**方向 —— 此前只有「应用」没有反向动作，于是
           * 「只有一份预设且它生效中」时开关关不掉、删除又被引用拦着（2026-10-10 实测反馈）。
           * 显示路径与 doApply 完全相同：失败走一次性横幅（不顶掉列表），成功重读页面。
           *
           * 成功时给一条**回执**（0.19.1，用户 2026-10-10 反馈「取消应用，AGENTS.md 还是存在」）：
           * 原来只 `refresh()`，界面上唯一的变化是那颗开关灭了 —— 而"文件被删掉了"和"文件还在、
           * 只是内容换回去了"在界面上长得一模一样，用户只能自己去翻磁盘。回执按宿主回的
           * `removed` 分两种说法，把"到底发生了什么"直接写在页面上。
           */
          function doUnapply() {
            // 会话层：取消应用 = 清侧车 `prompt` 域，内容回退全局链。
            if (scopeIsSession()) {
              beginAction()
              setBusy('unapply')
              scopeWritePrompt({ action: 'unapply' }).then(function (res) {
                setBusy(null); setApplyConfirm(null)
                if (res && res.ok === false) { actionFailed(res); return }
                setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: scopeT('scope.prompt.clearedToGlobal') } }) })
                refresh()
              }).catch(function (e) { setBusy(null); setApplyConfirm(null); actionFailed(e) })
              return
            }
            if (promptWriteDenied()) return
            beginAction()
            setBusy('unapply')
            apiCall('agentsmd-unapply', {}).then(function (res) {
              setBusy(null); setApplyConfirm(null)
              if (res && res.ok === false) { actionFailed(res); return }
              setState(function (s) {
                // 同样分开写（见 refText 的说明）：check-i18n 只统计字面量调用。
                return Object.assign({}, s, { notice: { kind: 'ok', text: (res && res.removed) ? t('agm.result.unappliedRemove') : t('agm.result.unapplied') } })
              })
              refresh()
            }).catch(function (e) { setBusy(null); setApplyConfirm(null); actionFailed(e) })
          }
          /**
           * 会话层「编辑本会话生效正文」（0.21.2）：以**当前生效正文**预填
           * （`scope-get` 的 `prompt.effective`，含会话覆盖 / 场景预设 / AGENTS.md 的退化结果）；
           * 保存写侧车 `prompt.content` —— 原本是 `presetId` 引用时，这一步展开为正文并清引用。
           */
          function openSessionEdit() {
            beginAction()
            var draft = takeFormDraft('prompt:session')
            if (draft) { setSessionEdit(draft); return }
            var effective = scopeState.prompt && typeof scopeState.prompt.effective === 'string' ? scopeState.prompt.effective : ''
            setSessionEdit({ content: effective, error: null })
          }
          function doSessionEditSave() {
            if (!sessionEdit) return
            if (String(sessionEdit.content || '').trim() === '') {
              setSessionEdit(Object.assign({}, sessionEdit, { error: t('scope.prompt.contentEmpty') }))
              return
            }
            beginAction()
            setBusy('session-edit')
            scopeWritePrompt({ action: 'edit', content: String(sessionEdit.content) }).then(function (res) {
              setBusy(null)
              if (res && res.ok === false) { setSessionEdit(Object.assign({}, sessionEdit, { error: res.error })); return }
              setSessionEdit(null)
              setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: scopeT('scope.prompt.editSaved') } }) })
              refresh()
            }).catch(function (e) { setBusy(null); setSessionEdit(Object.assign({}, sessionEdit, { error: errMsg(e) })) })
          }
          function doRemove(p) {
            if (promptWriteDenied()) return
            beginAction()
            setBusy('rm-' + p.id)
            // 删除只有**场景绑定**拦得住（宿主侧 agentsmd-remove 同一判据）。被场景绑定的那份
            // 按钮点得动但删不掉（点了当面列出「谁在用」），所以响应里的错误必须显示出来，
            // 不能静默什么都不发生。
            apiCall('agentsmd-remove', { id: p.id }).then(function (res) {
              setBusy(null); setApplyConfirm(null)
              if (res && res.ok === false) actionFailed(res)
              else refresh()
            }).catch(function (e) { setBusy(null); setApplyConfirm(null); actionFailed(e) })
          }
          /**
           * 新建提示词的**入口**：先按目标那一档的现有 id 查重（用户 2026-10-14）。
           *
           * 撞名原先只在服务端被拒（`agentsmd-create` / `quickprompt-create` 各回一句
           * 「id 已存在」），用户看到的是"这条 id 不能用"，而不是"要不要叫 `1（1）`" ——
           * 与其余四个域（记忆 / 场景 / 技能 / 子智能体）的口径不一致。这里补上同一套：
           * 撞名先弹 `DupNameDialog`，确认了才带着退号后的 id 落盘。
           *
           * 查重只在**同一档内部**做：全局提示词与快捷提示词各占一个目录
           * （`prompts/<id>/` 与 `quick-prompts/<id>/`），两边的 id 互不影响。
           *
           * 本地查重不替代服务端那道闸：期间别人（或模型工具）建了同一条，提交仍会被拒，
           * 那时照旧如实报错 —— 这里只是把常见情形做顺手，不是替服务端下判断。
           */
          function submitCreate(id, content, description) {
            var typed = String(id || '').trim()
            var isQuick = createModal && createModal.kind === 'quick'
            var taken = {}
            ;(isQuick ? quick.prompts : state.presets).forEach(function (p) { taken[String(p.id)] = true })
            var finalId = uniqueName(typed, taken)
            // 正文与描述一并带进确认窗：确认时直接用它们，不再回头读 `createModal` ——
            // 那样确认动作就依赖"那个弹窗还开着"，而这两件事没有必然关系。
            if (finalId !== typed) { setDupAsk({ name: typed, finalId: finalId, content: content, description: description }); return }
            doCreate(typed, content, description)
          }
          /** 真正落盘那一步（id 已定）。`id` 来自 `submitCreate` 或确认弹窗。 */
          function doCreate(id, content, description) {
            if (promptWriteDenied()) return
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
          function doUpdate(force) {
            if (promptWriteDenied()) return
            beginAction()
            setBusy('update')
            // `expectedStamp`：打开编辑时读到的那一份指纹。服务端不符就拒绝，界面据此给出
            // 「重新加载 / 覆盖保存」两条出路。`force` = 用户明确选择覆盖。
            var payload = { id: editModal.id, nextId: String(editModal.nextId || editModal.id), content: editModal.content, description: String(editModal.description == null ? '' : editModal.description) }
            if (!force && editModal.stamp) payload.expectedStamp = editModal.stamp
            apiCall('agentsmd-update', payload).then(function (res) {
              setBusy(null)
              if (res && res.ok) {
                setEditModal(null)
                if (res.renamedFrom) setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: t('agm.result.renamed', { id: res.id }) + (res.reboundScenes ? t('agm.result.rebound', { count: res.reboundScenes }) : '') } }) })
                refresh()
              } else if (res && res.code === 'stale-write') {
                setEditModal(Object.assign({}, editModal, { error: t('stale.write.conflict'), stale: true }))
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
            var draft = takeFormDraft('prompt:quick:' + p.id)
            if (draft) { setQuickEdit(draft); return }
            setQuickEdit({ id: p.id, nextId: p.id, content: p.content || '', description: p.description || '' })
          }
          function doQuickUpdate() {
            if (promptWriteDenied()) return
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
            if (promptWriteDenied()) return
            beginAction()
            setBusy('quick-remove')
            apiCall('quickprompt-remove', { id: id }).then(function (res) {
              setBusy(null); setQuickConfirm(null)
              if (res && res.ok) refreshQuick()
              else if (res) actionFailed(res)
            }).catch(function (e) { setBusy(null); setQuickConfirm(null); actionFailed(e) })
          }
          /**
           * 单条快捷提示词的「统一关闭」：清掉各对话 / 工作区单独打开它的覆盖。
           * 全局启停不动（页面那颗开关管的是它），这里只收临时的那一份。
           */
          function doQuickStop(id) {
            beginAction()
            setBusy('quick-stop')
            apiCall('scope-stop-now', { domain: 'quickPrompts', key: id }).then(function (res) {
              setBusy(null); setQuickStop(null)
              if (res && res.ok === false) { actionFailed(res); return }
              setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: t('scope.unifiedClose.viewDone', { name: id }) } }) })
              scopeForgetLeases('quickPrompts', [id])
            }).catch(function (e) { setBusy(null); setQuickStop(null); actionFailed(e) })
          }
          /**
           * 那颗开关：只改"这条在不在对话框 `/` 菜单里出现"，正文与备注一个字不动。
           * 与子智能体那一档同一条口径：成功不弹提示（列表重读后开关自己翻过来），失败要说人话。
           */
          function toggleQuick(p) {
            beginAction()
            const next = p.enabled === false
            setBusy('quick-toggle-' + p.id)
            // 会话作用域（0.21.2，决策 8）：会话层下写 `scope-set`（`quickPrompts` 域），
            // 全局层仍走 `quickprompt-toggle`。两条路不能合并：后者改的是 `meta.json`，
            // 前者只写一个侧车 —— 合并就意味着会话层要把全局值改掉。
            if (scopeIsSession()) {
              scopeWriteFlag('quickPrompts', p.id, next, function () { return { ok: true } })
                .then(function (res) { setBusy(null); if (res && res.ok) refreshQuick(); else if (res) actionFailed(res) })
                .catch(function (e) { setBusy(null); actionFailed(e) })
              return
            }
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
          // 的状态变化不再重跑它。
          // 两张定序表分开：预设 id 与快捷提示词 id 是两个命名空间，共用一张表会互相顶位。
          var presetRank = useRank()
          var quickRank = useRank()
          var orderedPresets = React.useMemo(function () {
            return rankedFirst(presetRank, function (p) { return p.id }, visiblePresets, function (p) { return !!p.active; })
          }, [visiblePresets])
          var activeCount = React.useMemo(function () {
            return state.presets.filter(function (p) { return p.active }).length
          }, [state.presets])
          // 会话层的「生效中」：本会话真正注入的正文对上哪一份预设就是哪一份 —— 会话覆盖、
          // 全局沿用、场景绑定、冻结快照都算（服务端按内容比对，见 agentsmd-list 的 sessionActive）。
          // 手写的会话正文不算任何预设（见 `sessionCustomBody`），但它本身是一份生效中的正文。
          var sessionActiveCount = sessionCustomBody ? 1 : (state.presets.some(function (p) { return p.sessionActive === true }) ? 1 : 0)
          // 快捷提示词里"还开着"的条数（关掉的留在列表里，只是不进 `/` 菜单）。页头统计要用
          // 「启用 / 总数」，所以除了总数还得有这个分子。
          var quickEnabledCount = React.useMemo(function () {
            return quick.prompts.filter(function (p) { return scopeFlag('quickPrompts', p.id, p.enabled !== false).value }).length
          }, [quick.prompts, scopeState])
          var visibleQuick = React.useMemo(function () {
            return quick.prompts.filter(function (p) { return matchPresetQuery(p, dq) })
          }, [quick.prompts, dq])
          // 与上面预设那一档同一条口径：亮着的排前面。关掉的照样列着（那只是"不在 `/` 菜单里出现"，
          // 不是删掉），沉到底部是为了让常用的那几条留在第一眼。
          var orderedQuick = React.useMemo(function () {
            return rankedFirst(quickRank, function (p) { return p.id }, visibleQuick, function (p) { return scopeFlag('quickPrompts', p.id, p.enabled !== false).value })
          }, [visibleQuick, scopeState])
          // ── 两组都是**可折叠卡片**（用户 2026-10-01 裁定：做成技能那样）──────────
          // 默认展开；打了字强制展开 —— 卡片收着的话搜索结果一行都看不见（技能页 / MCP 页同口径）。
          var cg = React.useState({})
          var groupsCollapsed = cg[0], setGroupsCollapsed = cg[1]
          function toggleGroup(key, baseOpen) {
            // 存的是**有效状态**（true=收起），不是翻转旧值：默认收起的那一组旧值是 undefined，
            // 翻一下算出来还是 true，第一次点击看不出任何变化，得点第二下才展开（用户 2026-10-16 实测）。
            setGroupsCollapsed(function (prev) { return Object.assign({}, prev, { [key]: baseOpen }) })
          }
          /** 一张分组卡片：标题 + 条数（点标题行收起/展开）+ 右侧动作 + 展开时的卡片体。
           *  `defaultOpen` = 没手动点过时要不要展开（记忆页 / 技能页同一口径：这一组里
           *  一条都没在用的就默认收着，用户 2026-10-16「提示词也是」）。 */
          function groupCard(key, label, count, actions, bodyNode, defaultOpen) {
            var openFlag = groupsCollapsed[key]
            var baseOpen = openFlag === undefined ? defaultOpen !== false : openFlag !== true
            var open = baseOpen || !!dq
            return React.createElement('section', { key: key, className: 'dsm-source' },
              React.createElement('div', { className: 'dsm-source-head' },
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: function () { toggleGroup(key, baseOpen) } },
                  React.createElement('span', { className: 'dsm-source-title', title: label }, label),
                  React.createElement('span', { className: 'dsm-count' }, String(count))),
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
            // 本层的生效值（会话层 = 覆盖优先，全局层 = meta.json）。
            var onOf = function (p) { return scopeFlag('quickPrompts', p.id, p.enabled !== false).value }
            var turnOn = !list.every(onOf)
            var targets = list.filter(function (p) { return onOf(p) !== turnOn })
            if (!targets.length) return
            beginAction()
            setGroupsCollapsed(Object.assign({}, groupsCollapsed, { quick: false }))
            setBusy('quick-bulk')
            // 会话作用域（0.21.2，决策 8）：会话层逐条写 `scope-set`，**不动 meta.json**。
            // 用 `quickprompt-toggle` 承接批量就是「本会话全开、别的对话一起被打开」。
            if (scopeIsSession()) {
              var sid = scopeState.sessionId
              Promise.all(targets.map(function (p) {
                return apiCall('scope-set', { sessionId: sid, domain: 'quickPrompts', key: p.id, value: turnOn })
                  .catch(function (e) { return { ok: false, error: errMsg(e) } })
              })).then(function (all) {
                setBusy(null)
                try { refreshScope() } catch (e) { /* 面板没开着也只是白跑一次读 */ }
                refreshQuick()
                var bad = all.filter(function (r) { return !r || r.ok !== true }).length
                if (bad) setState(function (s) { return Object.assign({}, s, { notice: { kind: 'err', text: t('prompts.bulk.failed', { done: all.length - bad, failed: bad }) } }) })
              })
              return
            }
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
          var quickAllOn = visibleQuick.length > 0 && visibleQuick.every(function (p) { return scopeFlag('quickPrompts', p.id, p.enabled !== false).value })
          /**
           * 页头「全部关闭」：把各会话 / 工作区 / 场景里单独开着的快捷提示词一并停掉 ——
           * 「本对话关掉、别的对话还开着」不算全部关闭，所以走统一关闭 op 清各层认领，
           * 而不是只写全局 `meta.json`。全局那一档是单选基线，没有"临时运行"可言。
           */
          function stopAllQuick() {
            var keys = scopeLeaseKeys('quickPrompts')
            if (!keys.length) return
            beginAction()
            setBusy('quick-stopall')
            apiCall('scope-stop-now', { domain: 'quickPrompts', keys: keys }).then(function (res) {
              setBusy(null)
              if (res && res.ok === false) { actionFailed(res); return }
              if (res && res.warnings && res.warnings.length) {
                setState(function (s) { return Object.assign({}, s, { notice: { kind: 'warn', text: res.warnings.join('；') } }) })
                return
              }
              setState(function (s) { return Object.assign({}, s, { notice: { kind: 'ok', text: t('scope.stopAll.done', { count: keys.length }) } }) })
              // 本地摘掉租约：页头按钮与行内「单独设置」徽章立刻消失，不重拉整层。
              scopeForgetLeases('quickPrompts', keys)
            }).catch(function (e) { setBusy(null); actionFailed(e) })
          }
          /**
           * **预设库**（新建 / 导入 / 编辑 / 删除 / 回收站恢复）是全局资产：
           *   · 会话层：一律置灰并提示切到全局默认（预设库写口不随对话走）；
           *   · 全局层：受场景锁（`anyLocked`）拦。
           *
           * 应用 / 取消应用 / 编辑本会话正文**不在此列**：会话层写的是侧车 `prompt` 域，
           * 场景锁不挡（`scopeWritePrompt` 只受会话锁约束）。
           */
          var promptWriteBlocked = state.anyLocked === true || scopeIsSession()
          var promptBlockTitle = scopeIsSession() ? t('scope.prompt.libraryGlobalOnly') : t('scenes.lock.blockedEdit')
          var quickBulkButton = React.createElement('button', {
            type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-bulk',
            disabled: busy !== null || scopeWriteLocked(state.anyLocked === true) || !visibleQuick.length,
            title: t('prompts.bulk.quick'),
            onClick: toggleQuickBulk,
          }, bulkPair(t(quickAllOn ? 'bulk.unselectAll' : 'bulk.selectAll'), t(quickAllOn ? 'bulk.selectAll' : 'bulk.unselectAll')))
          function renderQuick(p) {
            // 列表行两行制（REDESIGN §3.4，切片四）：行 1 状态点 + id，行 2 描述；
            // 开关 + 编辑/删除（quiet 24px，删除 quiet-danger）常驻右侧。
            // 不挂「生效中」那类标签：快捷提示词不写 AGENTS.md、不进上下文，它唯一的两种状态
            // （在不在 `/` 菜单里出现）就是左边那颗开关，行首点只复述它。
            return React.createElement(ListRow, {
              key: p.id,
              dots: [(function () {
                var flag = scopeFlag('quickPrompts', p.id, p.enabled !== false)
                return React.createElement(StatusDot, {
                  key: 'dot',
                  tone: flag.value ? 'ok' : 'idle',
                  scoped: flag.value && flag.scoped,
                  title: flag.value ? t('status.enabled') : t('status.disabled'),
                })
              })()],
              name: p.id,
              // 纯视图域的会话覆盖计数（0.21.2）：有几个对话单独拨过这一条快捷提示词。
              nameAfter: leaseTag({ t: t, domain: 'quickPrompts', key: String(p.id), runtime: false }),
              meta: p.description || null,
              // 会话作用域（0.21.2）：值来自 `scopeFlag`；来源看行首那颗点，开关本身不染色。
              side: (function () {
                var flag = scopeFlag('quickPrompts', p.id, p.enabled !== false)
                return React.createElement(Switch, {
                  on: flag.value,
                  scoped: flag.scoped,
                  disabled: busy !== null || scopeWriteLocked(state.anyLocked === true),
                  label: t('quickprompt.toggle') + ' ' + p.id,
                  title: t('quickprompt.toggle.hint'),
                  onClick: function () { toggleQuick(p) },
                })
              })(),
              actions: [
                // 编辑 / 删除**都**收进 ⋯（用户 2026-10-16 第二轮）：这一页的行只有名字与描述，
                // 行尾留两颗按钮就把两行文字挤没了。删除在菜单里是红字。
                // 「编辑」在锁定态照常可点（用户 2026-10-12：「子智能体、提示词、记忆可以打开
                // 编辑页面，但是不能保存」）：看内容不该被锁挡住，写盘那一步（弹窗里的保存键）才置灰。
                React.createElement(RowMenu, {
                  key: 'menu',
                  label: t('row.menu', { name: p.id }),
                  items: [
                    ...(scopeLeaseCount('quickPrompts', p.id) > 0 ? [{ key: 'stop', label: t('scope.unifiedClose'), danger: true, disabled: busy !== null || state.anyLocked === true, onClick: function () { setQuickStop({ id: p.id }) } }] : []),
                    { key: 'edit', label: t('agm.btn.edit'), disabled: busy !== null || scopeIsSession(), title: scopeIsSession() ? promptBlockTitle : undefined, onClick: function () { openQuickEdit(p) } },
                    { key: 'delete', label: t('agm.btn.delete'), danger: true, disabled: busy !== null || promptWriteBlocked, title: promptWriteBlocked ? promptBlockTitle : undefined, onClick: function () { setQuickConfirm({ id: p.id }) } },
                  ],
                }),
              ],
            })
          }
          // 快捷提示词那一组。整段独立于上面的 `body`：它读失败只红自己那一组，
          // 不该把预设列表一起打成错误页（两件事各自有各自的结论）。
          // 列表四态（切片四）：失败 = EmptyState + 重试（只重读本组清单）。
          var quickSection = groupCard('quick', t('prompts.group.quick'), quick.prompts.length, quickBulkButton,
            quick.error
              ? React.createElement(ListStates, { t: t, state: 'error', text: quick.error, onRetry: function () { refreshQuick() } })
              : !quick.prompts.length
                ? React.createElement(ListStates, { t: t, state: 'empty', text: t('quickprompt.empty') })
                : !visibleQuick.length
                  ? React.createElement(ListStates, { t: t, state: 'search', text: t('agm.empty.search'), onClearFilter: function () { setQuery('') } })
                  : orderedQuick.map(renderQuick), quickEnabledCount > 0)
          // 列表四态（切片四）：加载 / 失败（EmptyState + 重试）/ 空 / 无结果（+ 清除筛选）/ 有数据。
          var body = state.loading && !state.presets.length
            ? React.createElement(ListStates, { t: t, state: 'loading' })
            : state.error
              ? React.createElement(ListStates, { t: t, state: 'error', text: state.error, onRetry: function () { refresh() } })
              : !state.presets.length
                ? React.createElement(ListStates, { t: t, state: 'empty', text: t('agm.empty') })
                : !visiblePresets.length
                  ? React.createElement(ListStates, { t: t, state: 'search', text: t('agm.empty.search'), onClearFilter: function () { setQuery('') } })
                  : React.createElement('div', null, orderedPresets.map(function (p) {
                    // 「生效中」= 当前真正在起作用的基线：启用的场景绑了它，就是它（用户裁定）；
                    // 否则看文件比对。p.fileApplied 单独留着，说明「AGENTS.md 里确实是它」。
                    var viaScene = p.activeVia === 'scene'
                    // 会话层（0.21.2）：生效标记按**本会话真正注入的正文**投影 —— 会话覆盖、
                    // 全局沿用、场景绑定、冻结快照都算（服务端按内容比对，见 sessionActive）。
                    // `sessionOwned` 才是「本会话单独应用了它」；开关的开态看**是否生效**
                    // （用户 2026-10-21：全局那行明明「本会话沿用」，开关却是关的，看起来像没开）。
                    // 沿用的那份点开关 = 把它钉到本会话（不是关掉：提示词域没有「不用任何预设」态）。
                    var sessionOwned = scopeIsSession() && !!sessionPrompt && sessionPrompt.presetId === p.id
                    var sessionActive = scopeIsSession() && !sessionCustomBody && (sessionOwned || p.sessionActive === true)
                    var rowOn = scopeIsSession() ? sessionActive : p.active === true
                    var refs = p.refs || []
                    var restoreRef = refs.some(function (r) { return r.kind === 'restore' })
                    // 场景绑定与「当前应用的」那份拦得住删除（判据见 blockingRefsOf 的说明）。
                    var blockingTexts = blockingRefsOf(p)
                    // 场景绑的就是它，但 AGENTS.md 里的内容不是它（被手改过？）→ 说清楚，
                    // 并留"再点一次那颗开关"这条路写回。
                    var fileMismatch = !!sceneDriver && sceneDriver.presetId === p.id && !p.fileApplied
                    // 场景接管的是**别的**预设时，应用这一份 = 把该场景改绑到它（用户裁定
                    // 2026-09-17：未锁定时切换要可用，并且同步写进场景档案），所以不再拦截；
                    // 只在 title 里把后果说出来，用户点了才知道会发生什么。
                    var applyRebinds = !!sceneDriver && sceneDriver.presetId !== p.id
                    // 列表行两行制（REDESIGN §3.4，切片四）：行 1 状态点 + id + 至多 1 个
                    // 「需要处理」的 tag（内容与 AGENTS.md 不一致）；行 2 描述 + 元信息。
                    // 「生效中」由行首点承担（含义在悬停里），「AGENTS.md 里是它 / 退出场景
                    // 后恢复」降为行 2 的弱色元信息；场景绑定不在这里标（谁在引用它，
                    // 点「删除」时会逐条说出来）。
                    return React.createElement(ListRow, {
                      key: p.id,
                      dots: [React.createElement(StatusDot, {
                        key: 'dot',
                        tone: (scopeIsSession() ? sessionActive : rowOn) ? 'ok' : 'idle',
                        // 来源标记只标**本会话覆盖**：沿用的那一份是绿点但不是 scoped（用户
                        // 2026-10-21：沿用被点上"来源"环，看起来像本会话单独设过）。
                        scoped: scopeIsSession() && sessionOwned,
                        title: scopeIsSession()
                          ? (sessionOwned ? scopeT('scope.prompt.sessionOverride')
                            : sessionActive ? scopeT('scope.prompt.inherited') : t('agm.inactive'))
                          : (rowOn
                            ? (viaScene ? t('agm.active.hint.scene', { scene: (state.scenePrompt && state.scenePrompt.label) || (state.scenePrompt && state.scenePrompt.scene) || '' }) : t('agm.active.hint.file'))
                            : t('agm.inactive')),
                      })],
                      name: p.id,
                      tag: !scopeIsSession() && fileMismatch ? React.createElement('span', { className: 'dsm-tag dsm-tag-off', title: t('agm.file.mismatch.hint') }, t('agm.file.mismatch')) : null,
                      // 会话层只留描述：AGENTS.md 的文件比对 / 退出恢复是全局口径，摆在这一层会各说各话。
                      meta: [
                        p.description ? React.createElement('span', { key: 'desc', className: 'dsm-listrow-meta-desc', title: p.description }, p.description) : null,
                        // 会话层沿用（全局 / 场景 / 冻结快照）时点出「这不是本会话单独应用的」，
                        // 否则用户会以为右边那颗开关本来就开着。
                        scopeIsSession() && sessionActive && !sessionOwned
                          ? React.createElement('span', { key: 'inherited', className: 'dsm-listrow-meta-info', title: scopeT('scope.prompt.inherited.hint') }, scopeT('scope.prompt.inherited'))
                          : null,
                        !scopeIsSession() && !p.active && p.fileApplied ? React.createElement('span', { key: 'applied', className: 'dsm-listrow-meta-info', title: t('agm.file.applied.hint') }, t('agm.file.applied')) : null,
                        !scopeIsSession() && restoreRef ? React.createElement('span', { key: 'restore', className: 'dsm-listrow-meta-info', title: t('agm.restore.tag.hint') }, t('agm.restore.tag')) : null,
                      ],
                      side: React.createElement(Switch, {
                        // 「应用 / 取消应用」同一颗药丸开关（0.19.1 起有两个方向）：
                        //   关 → 点 = 应用（把这份内容写进 AGENTS.md）；
                        //   开（AGENTS.md 里就是它）→ 点 = **取消应用**（把 AGENTS.md 恢复成
                        //     **开始应用提示词之前**的那一份 —— 中途应用过别的预设也一并撤销，
                        //     不是只退一步；见 `service.ts` 的 `backupGlobal`）。此前这颗开关只有
                        //     「应用」一个方向，用户实测「开启后无法关闭，也不能删除」—— 那是开关
                        //     与删除保护一起构成的死锁。
                        //   开但由**场景**驱动（`activeVia === 'scene'`）→ 点 = 应用（重新写回 /
                        //     换绑场景）；撤销归场景页管，本页不该把场景的绑定偷偷撤掉。
                        // 没有链起点可回时（播种出来的 default 就是这样）不开弹窗，
                        // 只给一条说明，并把出路（应用别的预设 / 直接编辑 AGENTS.md）说清楚。
                        on: rowOn,
                        disabled: busy !== null || (scopeIsSession() ? scopeState.locked === true : promptWriteBlocked),
                        label: t('agm.apply.switch') + ' ' + p.id,
                        title: scopeIsSession()
                          ? (sessionOwned ? t('scope.prompt.restoreGlobal')
                            : sessionActive ? scopeT('scope.prompt.pinSwitch', { id: p.id })
                            : scopeT('scope.prompt.applyToSession', { id: p.id }))
                          : promptWriteBlocked ? promptBlockTitle
                          : applyRebinds ? t('agm.apply.rebindScene', { scene: sceneDriverLabel })
                          : p.active
                            ? (viaScene ? t('agm.apply.switch.on')
                              : (unapplyReady ? (unapplyRemoves ? t('agm.unapply.switch.onRemove') : t('agm.unapply.switch.on')) : t('agm.unapply.switch.blocked')))
                            : t('agm.apply.hint'),
                        onClick: function () {
                          if (scopeIsSession()) {
                            if (sessionOwned) { setApplyConfirm({ id: p.id, unapply: true, session: true }); return }
                            setApplyConfirm({ id: p.id, session: true }); return
                          }
                          if (!p.active || viaScene) { setApplyConfirm({ id: p.id }); return }
                          if (!unapplyReady) { setState(function (s) { return Object.assign({}, s, { deny: t('agm.unapply.unavailable') }) }); return }
                          setApplyConfirm({ id: p.id, unapply: true })
                        },
                      }),
                      actions: [
                        // 同快捷提示词：编辑与删除都收进 ⋯，锁定态能打开编辑页、保存键在弹窗里置灰。
                        React.createElement(RowMenu, {
                          key: 'menu',
                          label: t('row.menu', { name: p.id }),
                          items: [
                            // 会话层（0.21.2 第三轮）：预设库仍是全局资产，「编辑」这一项切换语义 ——
                            // 编辑的是**本会话生效正文**（写侧车），不再禁用。全局状态区块删除后，
                            // 「编辑本会话正文」就靠这一项保持可达（用户裁定不新开区块）。
                            scopeIsSession()
                              ? { key: 'edit-session', label: scopeT('scope.prompt.editSessionBody'), disabled: busy !== null || scopeState.locked === true, title: scopeState.locked === true ? scopeT('scope.lock.blockedSession') : undefined, onClick: openSessionEdit }
                              : { key: 'edit', label: t('agm.btn.edit'), disabled: busy !== null, onClick: function () { openEdit(p) } },
                            // 「恢复全局」在会话层必须有出口：content 覆盖时没有哪一行显示「生效中」，
                            // 那颗开关也就指不到它。挂在行菜单里（覆盖存在时每行都有，语义相同）。
                            scopeIsSession() && sessionPrompt
                              ? { key: 'restore-global', label: t('scope.prompt.restoreGlobal'), disabled: busy !== null || scopeState.locked === true, onClick: function () { setApplyConfirm({ id: sessionPrompt.presetId || '', unapply: true, session: true }) } }
                              : null,
                            {
                              key: 'delete', label: t('agm.btn.delete'), danger: true,
                              disabled: busy !== null || promptWriteBlocked,
                              title: blockingTexts.length > 0 ? t('agm.btn.delete.blocked.refs', { refs: blockingTexts.join(t('agm.ref.sep')) }) : promptBlockTitle,
                              onClick: function () {
                                // 被引用中的预设**点得动但删不掉**：当面说出「谁在用 / 该怎么解除」，
                                // 而不是让用户对着禁用按钮猜（disabled 的按钮连 title 都不弹）。
                                // 宿主侧同一判据同样拒绝，这里只是先说。
                                // 拦的是两类：场景绑定、以及**当前应用的**那份（后者删了 AGENTS.md
                                // 照旧生效，会留下一个看不懂的中间态）。播种出来的副本不在其列。
                                if (blockingTexts.length > 0) { setState(function (s) { return Object.assign({}, s, { deny: t('agm.btn.delete.blocked.refs', { refs: blockingTexts.join(t('agm.ref.sep')) }) }) }); return }
                                setApplyConfirm({ id: p.id, remove: true, removeFileApplied: p.fileApplied === true })
                              },
                            },
                          ].filter(Boolean),
                        }),
                      ],
                    })
                  }))

          return React.createElement('section', { className: 'dsm-section' },
            // 页头一行化（REDESIGN §3 + §6）：新增(实底) · 导入 · 导出 · 回收站；统计内联。
            React.createElement(PageHead, {
              title: t('tabs.prompts'),
              desc: t('prompts.desc'),
              // 三格：两类各自计数 + 生效中。第一格的文案点明「全局」—— 页面上现在有两类
              // 提示词，只说「提示词」会让用户以为快捷那几条没被算进来。快捷那格用
              // 「启用 / 总数」的比例（关掉的照样列着，只是不进 `/` 菜单，所以"总数"要看得见）。
              stats: [
                [state.presets.length, t('agm.stat.total')],
                [scopeIsSession() ? sessionActiveCount : activeCount, t('agm.stat.active')],
                [quickEnabledCount + '/' + quick.prompts.length, t('quickprompt.stat')],
              ],
              actions: [
                React.createElement('button', { key: 'new', type: 'button', className: 'dsm-btn', disabled: promptWriteBlocked, title: promptWriteBlocked ? promptBlockTitle : undefined, onClick: function () { setCreateModal(takeFormDraft('prompt:create') || { kind: 'global', id: '', content: '', description: '', error: null }) } }, t('agm.btn.new')),
                React.createElement('button', { key: 'import', type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || promptWriteBlocked, title: promptWriteBlocked ? promptBlockTitle : undefined, onClick: function () { setImportResult(null); setImportOpen(true) } }, t('agm.btn.import')),
                React.createElement('button', { key: 'export', type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null || !(state.presets.length || quick.prompts.length), onClick: function () { setExportState({ busy: false, result: null }) } }, t('export.presets')),
                React.createElement('button', { key: 'trash', type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: function () { setTrash(true) } }, t('trash.btn.open')),
                scopeLeaseKeys('quickPrompts').length > 0 ? React.createElement('button', { key: 'stopall', type: 'button', className: 'dsm-btn dsm-btn-danger-outline', disabled: busy !== null || state.anyLocked === true, onClick: stopAllQuick }, t('scope.stopAll')) : null,
              ],
            }),
            state.anyLocked === true && !scopeIsSession() ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('lock.banner')) : null,
            // 场景接管时把「为什么应用按钮点不动」直接写出来，而不是让用户对着置灰的按钮猜。
            // **锁定期间不显示**：那时「应用别的预设会改绑场景」是句空话（按钮全灰），与上面
            // 那条锁定横幅并排还会互相矛盾 —— MCP / 技能 / 子智能体 / 记忆四页都是
            // 「锁定时只显示锁定横幅」，提示词页此前漏了这层互斥，于是同一件事说了两遍
            // （用户 2026-09-19 截图：提示词页两条黄条，其他管理页只有一条）。
            (state.anyLocked !== true && sceneDriver && !scopeIsSession()) ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('agm.sceneLock.notice', { scene: sceneDriverLabel, id: sceneDriver.presetId })) : null,
            // 共享 agents 根那一份 AGENTS.md（`~/.agents/AGENTS.md`）**只读提示**：0.2.1 起
            // 官方把用户全局链扩成两份并列（`$DSH_HOME/AGENTS.md` → `<agentsHome>/AGENTS.md`），
            // 这一页只管得到前一份。所以"改了没生效"有了第二个解释 —— 真正在说话的是后一份。
            // 只提示、不给写入入口：这不是本插件的预设，写它会与官方的去重/刷新规则互相覆盖。
            (state.current && state.current.agentsHomeAgentsMd && state.current.agentsHomeAgentsMd.exists)
              ? React.createElement('div', { className: 'dsm-feedback', role: 'status' }, t('agm.agentsHome.present', { path: state.current.agentsHomeAgentsMd.path }))
              : null,
            // 本会话正文是手写的（不属于任何预设）：列表里没有一行会显示「生效中」，
            // 不说一句用户就会以为提示词没生效（0.21.2 复核）。恢复入口在行菜单的「恢复全局」。
            scopeIsSession() && sessionCustomBody
              ? React.createElement('div', { className: 'dsm-feedback', role: 'status' }, scopeT('scope.prompt.customBody'))
              : null,
            // 一次性拒绝说明（被引用的预设删不掉）：不替换列表，只加一条横幅。
            state.deny ? React.createElement(Notice, { kind: 'warn', text: state.deny }) : null,
            // 搜索框：页头之下、列表之前（与 MCP / 技能 / 记忆页同一位置与样式）。
            // 只放一个输入框、没有第二个筛选器，就不套 `dsm-source-filter`（宽度交给 CSS）。
            // 列表工具条（REDESIGN §3.3，切片四）：搜索住 children；两类共用一颗搜索框，
            // 全选（快捷组那颗）按 2026-10-01 裁定留在组头，batch 槽留空。
            React.createElement(Toolbar, null,
              React.createElement('input', {
                className: 'dsm-control dsm-search', value: query, 'aria-label': t('search'),
                placeholder: t('agm.search.placeholder'),
                onChange: function (e) { setQuery(e.target.value) },
              })),
            // 会话层不再有独立状态区块（用户 2026-10-21 裁定）：应用 / 取消应用仍是行内那颗
            // 开关，编辑本会话正文 / 恢复全局走行菜单（见上面 RowMenu）。冻结状态不另做展示 ——
            // 需要查证时看「注入实况」。
            // 两段各一张可折叠卡片：卡片头是组名 + 条数（点它收起/展开），卡片体里才是条目。
            groupCard('global', t('prompts.group.global'), state.presets.length, null, body, activeCount > 0),
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
            // 本页的回收站（42-shared-ui.js）：两组 —— 提示词预设 + 快捷提示词，
            // 各带标题与自己的批量条（2026-10-10「提示词的回收站要分成两部分」的裁定不变）。
            trash ? React.createElement(TrashModal, {
              t: t,
              domain: 'prompts',
              // 恢复 / 永久删除写的都是全局那一份提示词内容 → 与其余写口同一判据（0.21.2：
              // 此前只挡会话层，场景锁着时回收站里的写仍然能过）。
              locked: promptWriteBlocked,
              onClose: function () { setTrash(false) },
              onReload: function () { refresh(true) },
            }) : null,
            // 编辑：id 与内容都可改（改 id = 目录改名，场景绑定由宿主一起改名）。
            editModal ? React.createElement(Modal, { className: 'dsm-modal-form-tall', title: t('agm.edit.title') + ' · ' + editModal.id, closeLabel: t('btn.close'), onClose: function () { stashFormDraft('prompt:edit:' + editModal.id, editModal); setEditModal(null) } },
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
              // 冲突（文件在别处被改过）：给两条出路，别让用户只能关掉重来。
              // 覆盖保存 = 不带指纹重发，服务端按旧行为写；重新加载 = 丢掉本地改动读磁盘那份。
              editModal.stale ? React.createElement('div', { className: 'dsm-feedback-row' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null, onClick: reloadEdit }, t('stale.write.reload')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy !== null, onClick: function () { doUpdate(true) } }, t('stale.write.overwrite'))) : null,
              // 锁定态与会话层都说「为什么保存键是灰的」：编辑页照常能打开（用户 2026-10-12），
              // 挡的只是写盘那一步 —— 提示词全局一份，停在某个对话里改不动它。
              promptWriteBlocked ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, promptBlockTitle) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null || promptWriteBlocked || !String(editModal.nextId || '').trim(), onClick: function () { doUpdate(false) } }, t('agm.btn.save')))) : null,
            // 新建：id + 描述 + **正文文本框**（用户直接写内容）。原先还有一格「或从现有预设复制」，
            // 用户 2026-09-30 要求删掉 —— 抄一份再改是编辑页的事，新建时只想直接写。
            // 弹窗高度跟着内容走（2026-10-10 拆掉 `dsm-modal-fixed` 定高）：当初定高是怕切类型时
            // 「从现有预设复制」那行出现/消失让框跳，那格删掉后内容不再随类型变化，定高失去
            // 理由；余下高度留在正文框和动作栏之间，成了一截空白（用户截图）。普通弹窗装不下
            // 自己滚，正文框静止在 dsm-textarea-lg 的下限上、只能往下拖（与新建人设同款手感）。
            // 标题用 agm.new.title（「新增提示词」）而不是按钮那颗 agm.btn.new（「新增」）：
            // 弹窗里已经看不到那颗按钮了，标题光写"新增"不知道在新增什么（用户 2026-10-12）。
            createModal ? React.createElement(Modal, { className: 'dsm-modal-form-tall', title: t('agm.new.title'), closeLabel: t('btn.close'), onClose: function () { stashFormDraft('prompt:create', createModal); setCreateModal(null) } },
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
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('agm.field.content')),
                React.createElement('textarea', { className: 'dsm-control dsm-textarea-lg', placeholder: t(createModal.kind === 'quick' ? 'quickprompt.field.content.placeholder' : 'agm.field.content.placeholder'), value: createModal.content || '', onChange: function (e) { setCreateModal(Object.assign({}, createModal, { content: e.target.value })) } })),
              createModal.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, createModal.error) : null,
              // 与编辑弹窗同一口径（0.21.2）：会话层 / 锁定态都能打开表单，写盘那一步置灰并说明。
              promptWriteBlocked ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, promptBlockTitle) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null || promptWriteBlocked || !String(createModal.id || '').trim(), onClick: function () { submitCreate(createModal.id, createModal.content, createModal.description) } }, t('agm.btn.create')))) : null,
            // 三种确认共用一个弹窗：删除 / 取消应用 / 应用（`applyConfirm` 上的标记位区分）。
            applyConfirm ? React.createElement(Modal, {
              className: 'dsm-modal-sm',
              title: applyConfirm.session
                ? (applyConfirm.unapply ? t('scope.prompt.restoreGlobal') : scopeT('scope.prompt.applyToSession', { id: applyConfirm.id }))
                : applyConfirm.remove ? (t('agm.remove.title') + ' · ' + applyConfirm.id) : ((applyConfirm.unapply ? t('agm.unapply.title') : t('agm.applyModal.title')) + ' · ' + applyConfirm.id),
              closeLabel: t('btn.close'), onClose: function () { setApplyConfirm(null) },
            },
              applyConfirm.session
                ? React.createElement('div', null,
                    React.createElement('p', { className: 'dsm-help' }, applyConfirm.unapply
                      ? scopeT('scope.prompt.clearSessionBodyGeneric')
                      : scopeT('scope.prompt.applySessionBody', { id: applyConfirm.id })),
                    React.createElement('div', { className: 'dsm-feedback dsm-warning' }, scopeT('scope.prompt.applySessionNote')))
                : applyConfirm.remove
                ? React.createElement('div', null,
                    React.createElement('p', { className: 'dsm-help' }, t('agm.remove.title') + ' ' + applyConfirm.id + t('agm.remove.suffix')),
                    // 删的正是「AGENTS.md 里就是它」的那一份 → 必须说清**文件不会被改动、
                    // 全局提示词照旧生效**，否则用户会以为删除把全局提示词一起清掉了。
                    // 注意这条只可能落在**播种出来的副本**上：真正「当前应用的」那份已经在
                    // blockingRefsOf 里被拦住，根本走不到这个弹窗（用户 2026-10-10 的要求）。
                    applyConfirm.removeFileApplied ? React.createElement('div', { className: 'dsm-feedback dsm-warning' }, t('agm.remove.fileNote')) : null)
                : applyConfirm.unapply
                  ? React.createElement('div', null,
                      // 删文件那一支必须换文案：说"恢复成开始应用之前的那份内容"会让用户以为文件还在。
                      React.createElement('p', { className: 'dsm-help' }, unapplyRemoves ? t('agm.unapply.bodyRemove', { id: applyConfirm.id }) : t('agm.unapply.body', { id: applyConfirm.id })),
                      React.createElement('div', { className: 'dsm-feedback dsm-warning' }, unapplyRemoves ? t('agm.unapply.noteRemove') : t('agm.unapply.note')))
                  : React.createElement('div', null,
                      React.createElement('p', { className: 'dsm-help' }, t('agm.apply.prefix') + applyConfirm.id + t('agm.apply.suffix')),
                      React.createElement('div', { className: 'dsm-feedback dsm-warning' }, t('agm.apply.note')),
                      // 0.21.2 第三轮：全局层写的是**未来基线**，已存在会话冻结在各自快照里。
                      // 必须在点下去之前就说清，否则"应用了却没变化"会被当成故障。
                      React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, scopeIsWorkspace() ? t('scope.prompt.globalApplyNote.workspace') : t('scope.prompt.globalApplyNote'))),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn ' + (!applyConfirm.session && (applyConfirm.remove || (applyConfirm.unapply && unapplyRemoves)) ? 'dsm-btn-danger' : ''), disabled: busy !== null, onClick: function () { if (applyConfirm.remove) doRemove({ id: applyConfirm.id }); else if (applyConfirm.unapply) doUnapply(); else doApply(applyConfirm.id) } }, applyConfirm.session
                  ? (applyConfirm.unapply ? t('scope.prompt.restoreGlobal') : t('agm.btn.confirmApply'))
                  : applyConfirm.remove ? t('agm.btn.confirmRemove') : (applyConfirm.unapply ? (unapplyRemoves ? t('agm.btn.confirmUnapplyRemove') : t('agm.btn.confirmUnapply')) : t('agm.btn.confirmApply'))))) : null,
            // 会话层「编辑本会话生效正文」（0.21.2）：预填生效正文，保存写侧车。
            sessionEdit ? React.createElement(Modal, {
              className: 'dsm-modal-form-tall',
              title: scopeT('scope.prompt.editTitle'),
              closeLabel: t('btn.close'),
              onClose: function () { stashFormDraft('prompt:session', sessionEdit); setSessionEdit(null) },
            },
              React.createElement('p', { className: 'dsm-help' }, scopeT('scope.prompt.editHint')),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, scopeT('scope.prompt.editTitle')),
                React.createElement('textarea', {
                  className: 'dsm-control dsm-textarea-lg',
                  value: sessionEdit.content || '',
                  onChange: function (e) { setSessionEdit(Object.assign({}, sessionEdit, { content: e.target.value, error: null })) },
                })),
              sessionEdit.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, sessionEdit.error) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null, onClick: doSessionEditSave }, t('agm.btn.save')))) : null,
            importOpen ? React.createElement(ImportModal, {
              key: 'imp', t: t, title: t('agm.btn.import'), accept: '.md', hint: t('upload.drop.prompt'),
              busy: importBusy, result: importResult,
              // 会话层 / 锁定态：提示词内容写的是全局那一份，导入链同样收口（0.21.2）。
              disabled: promptWriteBlocked,
              disabledTitle: promptBlockTitle,
              // 类型选择放在弹窗顶部（`extra` 槽）：一次导入只进一类，选完再拖文件。
              extra: kindPicker(importKind, setImportKind),
              requirement: t('upload.req.prompt'),
              requirementTitle: [t('upload.requirement.prompt.1'), t('upload.requirement.prompt.2'), t('upload.requirement.prompt.3')].join('\n'),
              onClose: function () { setImportOpen(false); setImportResult(null) },
              onSubmit: function (entries, files) { doImportFiles(files) },
            }) : null,
            // 快捷提示词的编辑：正文直接来自列表（`quickprompt-list` 连正文一起回），
            // 不像预设那样还要再发一次 read。
            quickEdit ? React.createElement(Modal, { title: t('quickprompt.edit.title') + ' · ' + quickEdit.id, closeLabel: t('btn.close'), onClose: function () { stashFormDraft('prompt:quick:' + quickEdit.id, quickEdit); setQuickEdit(null) } },
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
              // 同预设编辑：锁定态 / 会话层都能打开，保存键置灰并说明原因（0.21.2：
              // 会话层那句用 `scope.prompt.libraryGlobalOnly`，与预设编辑弹窗同一口径）。
              promptWriteBlocked ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, promptBlockTitle) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy !== null || promptWriteBlocked || !String(quickEdit.nextId || '').trim(), onClick: doQuickUpdate }, t('agm.btn.save')))) : null,
            quickConfirm ? React.createElement(Modal, { className: 'dsm-modal-sm', title: t('quickprompt.remove.title') + ' · ' + quickConfirm.id, closeLabel: t('btn.close'), onClose: function () { setQuickConfirm(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('quickprompt.remove.hint')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: function () { setQuickConfirm(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy !== null, onClick: function () { doQuickRemove(quickConfirm.id) } }, t('agm.btn.confirmRemove')))) : null,
            quickStop ? React.createElement(Modal, { key: 'quick-stop', className: 'dsm-modal-sm', title: t('scope.unifiedClose'), closeLabel: t('btn.close'), onClose: function () { setQuickStop(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('scope.unifiedClose.viewDesc', { name: quickStop.id })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy !== null, onClick: function () { setQuickStop(null) } }, t('btn.cancel')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy !== null, onClick: function () { doQuickStop(quickStop.id) } }, t('scope.unifiedClose')))) : null,
            // 新建撞名确认窗。放在最后渲染 = 盖在新建弹窗之上（两个弹窗都开着，用户确认/取消
            // 之后回到那张还填着内容的表单，不用重新输入）。
            dupAsk ? React.createElement(DupNameDialog, {
              key: 'dup-name', t: t, kind: t('dup.kind.prompt'),
              name: dupAsk.name, finalName: dupAsk.finalId, action: 'create',
              busy: busy !== null,
              onConfirm: function () { setDupAsk(null); doCreate(dupAsk.finalId, dupAsk.content, dupAsk.description) },
              onCancel: function () { setDupAsk(null) },
            }) : null)
        }

        // 「工具」设置页：一个侧栏项，内部 tab 切换 场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话。
        function ToolsSection() {
          var tabState = React.useState('scenes')
          var active = tabState[0], setActive = tabState[1]
          // 把切页签的能力登记给模块作用域：任何页面里的「填写令牌」按钮都走这里跳过来
          // （页签状态在本组件里，而那个按钮长在页面内部，注册表是唯一不跨作用域引用的通路）。
          // 只有**面板内部**那几个调用点走它 —— 横幅那颗键改走自包含弹窗（见 40 片
          // openTokenDialog），所以这里不再需要消费"寄存的页签请求"。
          React.useEffect(function () {
            navigateToTab = setActive
            return function () { if (navigateToTab === setActive) navigateToTab = null }
          }, [])
          var sectionRef = React.useRef(null)
          var headRef = React.useRef(null)
          // 页签条下缘的位置随「作用域行」是否换行 / 是否多出警告行而变：技能页的组头
          // 要吸在页签下缘（`.dsm-source-head-pin` 的 top），所以把整个粘附头的实时
          // 高度写成变量，CSS 用它算 top —— 写死像素会在窄一点的面板里把组头藏进头里。
          React.useEffect(function () {
            var section = sectionRef.current
            var head = headRef.current
            if (!section || !head) return undefined
            var sync = function () { section.style.setProperty('--dsm-head-h', head.offsetHeight + 'px') }
            sync()
            var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null
            if (ro) ro.observe(head)
            return function () {
              if (ro) ro.disconnect()
              section.style.removeProperty('--dsm-head-h')
            }
          }, [])
          React.useEffect(function () {
            // 设置宿主的真正滚动容器，而不是 body：不同页签内容高度不同，
            // 让滚动条按需出现会改变 options 宽度，页签/GitHub 随之左右跳动。
            //
            // ⚠️ 必须**向上查找**而不是固定跳两级：`.dsm-panel-head` 的 position:sticky
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
            // 会话作用域 + 页签共用一个粘附头：往下滚时两行一起钉住（用户 2026-10-20：
            // 「下滑下拉框就消失，应该固定住」）。作用域行在下拉之上（决策 1）：它是
            // "整个面板正在编辑哪一层"，与当前是哪一页无关。
            React.createElement('div', { key: 'head', ref: headRef, className: 'dsm-panel-head' }, [
              React.createElement(ScopeBar, { key: 'scope', t: t }),
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
                  }))),
              // 检查更新 / GitHub / 版本号这一簇挂在**粘附头**下，不挂在页签容器里（0.21.2）：
              // 它要跨"作用域行 + 页签行"两行贴住面板右上角 —— 新键在 GitHub 图标上面，
              // 又都在这一栏最右边（用户 2026-10-22 的定位）。跨两行只有头的网格排得出来，
              // 塞进 `.dsm-tabs-shell` 就只能挤在页签那一行里。
              React.createElement(FeedbackLinks, { key: 'links' })]),
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
