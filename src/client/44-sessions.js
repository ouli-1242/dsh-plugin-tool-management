        function SessionsPage() {
          var state = React.useState({ loading: true, items: [], workspaces: {}, groups: [], retentionDays: 0, error: null })
          var data = state[0], setData = state[1]
          var modalState = React.useState(null)
          var modal = modalState[0], setModal = modalState[1]
          var searchState = React.useState('')
          var query = searchState[0], setQuery = searchState[1]
          // 过滤用防抖值（视图重算见下方 useMemo）：输入框仍绑 `query`，打字不掉字。
          var dq = useDebouncedValue(query)
          var busyState = React.useState(false)
          var busy = busyState[0], setBusy = busyState[1]
          // 多选集合：勾选的 sessionId。最小 React 支持函数式初值（Set 惰性创建）。
          var selState = React.useState(function () { return new Set() })
          var selected = selState[0], setSelected = selState[1]
          // 导入对话弹窗：null = 关闭；{ busy, error, result, cwd } = 打开。
          var impState = React.useState(null)
          var imp = impState[0], setImp = impState[1]
          // 导出对话弹窗：null = 关闭；{ busy, error, result, outDir, format, wsFilter, selectedIds } = 打开。
          var expState = React.useState(null)
          var exp = expState[0], setExp = expState[1]
          // 分组卡片折叠状态：key → true（收起）。默认全部展开。
          var collState = React.useState({})
          var collapsed = collState[0], setCollapsed = collState[1]
          // 操作结果提示（成功/警告一句话），与 MCP 等页共用 Notice 组件。
          var noticeState = React.useState(null)
          var notice = noticeState[0], setNotice = noticeState[1]

          function refresh(silent) {
            // 手动刷新（含首次加载）要把按钮切到「刷新中…」——点完毫无反馈等于没点。
            // 页面内部那些「操作完顺手重读」的调用传 silent，免得按钮每次都闪一下。
            if (!silent) setData(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
            apiCall('history-list', {}).then(function (r) {
              if (r && r.ok) {
                var items = r.items || []
                setData({ loading: false, items: items, workspaces: r.workspaces || {}, groups: r.groups || [], retentionDays: r.retentionDays || 0, error: null })
                // 裁剪选中集合：已被外部恢复/删除的会话不再计入。
                setSelected(function (prev) {
                  var has = new Set(items.map(function (it) { return it.sessionId }))
                  var next = new Set()
                  prev.forEach(function (id) { if (has.has(id)) next.add(id) })
                  return next
                })
              } else setData({ loading: false, items: [], workspaces: {}, groups: [], retentionDays: 0, error: (r && r.error) || t('hist.err.load') })
            }).catch(function (e) {
              // 请求被拒 / 网络异常：必须把 loading 收回来，否则按钮会永远停在「刷新中…」
              // 且一直禁用（这一支原来根本没有 —— 失败时页面停在旧数据上，什么都没有说）。
              setData(function (prev) { return Object.assign({}, prev, { loading: false, error: errMsg(e) }) })
            })
          }
          React.useEffect(function () { refresh() }, [])

          function shortId(id) { var s = String(id || ''); return s.length > 12 ? s.slice(0, 8) + '…' + s.slice(-4) : s }

          // 视图只在数据 / （防抖后的）搜索词 / 词条变化时重算：勾选、翻弹窗、按钮 busy
          // 这些与列表内容无关的重渲染不再重扫全表（`historyView` 的实现与理由见组件上方）。
          var view = React.useMemo(function () { return historyView(data, dq, t) }, [data, dq, t])
          var filtered = view.filtered, grouped = view.grouped, groups = view.groups, visibleIds = view.visibleIds

          // 「全选」状态：当前过滤结果是否全部选中（按钮文案切换为「取消全选」）。
          var allVisible = filtered.length > 0 && visibleIds.every(function (id) { return selected.has(id) })

          function doUnarchive(sessionId) {
            setBusy(true)
            apiCall('history-unarchive', { sessionId: sessionId }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setNotice(restoreNotice(r, 1)); refresh() } else setModal({ type: 'error', message: (r && r.error) || t('hist.err.unarchive') })
            })
          }
          /**
           * 恢复归档的归属结果 → 一句话结论。宿主恢复只移出归档集合；登记被删过的情况下
           * 插件会顺带把工作区重新登记并把会话挂回（`ensureWorkspaceAccounting`），
           * 这属于写宿主状态，必须如实告诉用户；没有变化时返回 null（不打扰）。
           */
          function restoreNotice(res, count) {
            var ws = res && res.workspace
            if (!ws) return null
            var attached = (ws.attached || []).length
            var createdList = (ws.registered || []).filter(function (item) { return item.created })
            var skipped = ws.skipped || []
            var title = (ws.registered && ws.registered[0] && ws.registered[0].title) || ''
            if (skipped.length) {
              return { kind: 'warn', text: t('hist.restore.note.skip', { count: skipped.length, reason: String(skipped[0].reason || '') }) }
            }
            if (attached && createdList.length) {
              return { kind: 'ok', text: t('hist.restore.note.registered', { count: attached, title: (createdList[0] && createdList[0].title) || title }) }
            }
            if (attached) return { kind: 'ok', text: t('hist.restore.note.attached', { count: attached, title: title }) }
            return null
          }
          function doDelete(sessionId) {
            setBusy(true)
            apiCall('history-delete', { sessionId: sessionId }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setModal(null); refresh() } else setModal({ type: 'error', message: (r && r.error) || t('hist.err.delete') })
            })
          }
          function setRetention(days) {
            apiCall('history-retention-set', { retentionDays: days }).then(function (r) {
              if (r && r.ok) setData(Object.assign({}, data, { retentionDays: days }))
              else setModal({ type: 'error', message: (r && r.error) || t('hist.err.retention') })
            })
          }

          // ---------- 多选 / 批量交互 ----------
          function toggleSelect(id) {
            setSelected(function (prev) {
              var next = new Set(prev)
              if (next.has(id)) next.delete(id); else next.add(id)
              return next
            })
          }
          function toggleGroup(ids) {
            setSelected(function (prev) {
              var next = new Set(prev)
              var all = ids.every(function (id) { return next.has(id) })
              ids.forEach(function (id) { if (all) next.delete(id); else next.add(id) })
              return next
            })
          }
          function toggleAllVisible(ids) {
            if (!ids.length) return
            setSelected(function (prev) {
              var next = new Set(prev)
              var all = ids.every(function (id) { return next.has(id) })
              ids.forEach(function (id) { if (all) next.delete(id); else next.add(id) })
              return next
            })
          }
          function doUnarchiveBatch() {
            var ids = Array.from(selected)
            if (!ids.length) return
            setBusy(true)
            apiCall('history-unarchive-batch', { target: { scope: 'sessions', sessionIds: ids } }).then(function (r) {
              setBusy(false)
              if (r && r.ok) {
                var gone = new Set(r.unarchivedSessionIds || [])
                setSelected(function (prev) { var next = new Set(prev); gone.forEach(function (id) { next.delete(id) }); return next })
                setNotice(restoreNotice(r, gone.size))
                refresh()
              } else setModal({ type: 'error', message: (r && r.error) || t('hist.err.unarchive') })
            })
          }
          function doDeleteBatch() {
            var ids = Array.from(selected)
            if (!ids.length) return
            setBusy(true)
            apiCall('history-delete-batch', { target: { scope: 'sessions', sessionIds: ids } }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setModal(null); setSelected(new Set()); refresh() }
              else setModal({ type: 'error', message: (r && r.error) || t('hist.err.delete') })
            })
          }
          // 重新登记工作区：写宿主状态（新增一条登记），因此只走确认弹窗，不静默执行。
          function doRegisterWorkspace(path) {
            if (busy) return
            setBusy(true)
            apiCall('history-workspace-register', { path: path }).then(function (r) {
              setBusy(false)
              if (r && r.ok) { setModal({ type: 'registered', workspace: r.workspace || {} }); refresh() }
              else setModal({ type: 'error', message: (r && r.error) || t('hist.err.register') })
            })
          }

          // ---------- 导入对话（从其他 Agent）----------
          function doImportFile(file) {
            if (!file || !imp) return
            var reader = new FileReader()
            reader.onload = function () {
              var snap = imp
              setImp(Object.assign({}, imp, { busy: true, error: null, result: null }))
              apiCall('history-import', {
                fileName: String(file.name || 'transcript.txt'),
                content: String(reader.result || ''),
                cwd: String(snap.cwd || '').trim(),
              }).then(function (res) {
                if (res && res.ok) {
                  setImp(Object.assign({}, snap, { busy: false, result: res }))
                  refresh()
                } else setImp(Object.assign({}, snap, { busy: false, error: (res && res.error) || t('hist.err.import') }))
              }).catch(function () {
                setImp(Object.assign({}, snap, { busy: false, error: t('hist.err.import') }))
              })
            }
            reader.readAsText(file)
          }
          function openImportPicker() {
            setImp({ busy: false, error: null, result: null, cwd: '' })
          }
          // ---------- 导出对话：弹窗内选范围/工作区 → 勾选会话 → 写入指定目录 ----------
          function openExportPicker() {
            setExp({ busy: false, error: null, result: null, outDir: '', format: 'markdown', wsFilter: '', archFilter: 'all', items: [], loading: true, selectedIds: new Set() })
            // 拉取全部持久化会话（含未归档/冷会话），供选择导出。
            apiCall('history-sessions', {}).then(function (res) {
              setExp(function (prev) {
                if (!prev) return prev
                return Object.assign({}, prev, {
                  loading: false,
                  error: (res && res.ok) ? prev.error : ((res && res.error) || t('hist.err.sessions')),
                  items: (res && res.ok && Array.isArray(res.items)) ? res.items : prev.items,
                })
              })
            }).catch(function () {
              setExp(function (prev) { return prev ? Object.assign({}, prev, { loading: false, error: t('hist.err.sessions') }) : prev })
            })
            // 拉取默认导出目录（桌面），仅当用户尚未输入时填充。
            apiCall('history-export-defaults', {}).then(function (res) {
              setExp(function (prev) {
                if (!prev || prev.outDir) return prev
                if (res && res.ok && typeof res.defaultDir === 'string' && res.defaultDir) {
                  return Object.assign({}, prev, { outDir: res.defaultDir })
                }
                return prev
              })
            }).catch(function () { /* 默认导出目录是可选增强：拿不到就保持空，主列表的加载/错误另有通道 */ })
          }
          // 弹出目录选择器：选中后把导出目录回填到输入框。
          function openExportDir() {
            if (exp.busy) return
            setExp(Object.assign({}, exp, { pickingDir: true }))
          }
          function toggleExportSelect(id) {
            setExp(function (prev) {
              var next = new Set(prev.selectedIds)
              if (next.has(id)) next.delete(id); else next.add(id)
              return Object.assign({}, prev, { selectedIds: next })
            })
          }
          function doExport() {
            var ids = Array.from(exp.selectedIds)
            if (!ids.length || !String(exp.outDir || '').trim()) return
            setExp(Object.assign({}, exp, { busy: true, error: null, result: null }))
            apiCall('history-export', { sessionIds: ids, format: exp.format, outDir: String(exp.outDir).trim() }).then(function (res) {
              if (res && res.ok) setExp(Object.assign({}, exp, { busy: false, result: res }))
              else setExp(Object.assign({}, exp, { busy: false, error: (res && res.error) || t('hist.err.export') }))
            }).catch(function () {
              setExp(Object.assign({}, exp, { busy: false, error: t('hist.err.export') }))
            })
          }
          // 把选中的会话批量归档到 History（纳入保留期管理），随后刷新列表与页面。
          function doArchiveSelected() {
            var ids = Array.from(exp.selectedIds)
            if (!ids.length || exp.busy) return
            setExp(Object.assign({}, exp, { busy: true, error: null, result: null }))
            apiCall('history-archive-batch', { sessionIds: ids }).then(function (res) {
              if (res && res.ok) {
                refresh()
                return apiCall('history-sessions', {}).then(function (r2) {
                  setExp(function (prev) {
                    if (!prev) return prev
                    return Object.assign({}, prev, {
                      busy: false,
                      selectedIds: new Set(),
                      result: { archived: (res.archived || []).length, failed: (res.failed || []).length },
                      items: (r2 && r2.ok && Array.isArray(r2.items)) ? r2.items : prev.items,
                    })
                  })
                })
              }
              setExp(function (prev) { return prev ? Object.assign({}, prev, { busy: false, error: (res && res.error) || t('hist.err.archive') }) : prev })
            }).catch(function () {
              setExp(function (prev) { return prev ? Object.assign({}, prev, { busy: false, error: t('hist.err.archive') }) : prev })
            })
          }

          var RETENTION_OPTS = [
            { value: 0, label: t('hist.retention.forever') },
            { value: 7, label: t('hist.retention.days', { count: 7 }) },
            { value: 30, label: t('hist.retention.days', { count: 30 }) },
          ]
          var EXPORT_FORMAT_OPTS = [
            { value: 'markdown', label: 'Markdown' },
            { value: 'jsonl', label: 'JSONL' },
          ]
          var EXPORT_ARCH_OPTS = [
            { value: 'all', label: t('hist.arch.all') },
            { value: 'archived', label: t('hist.arch.archived') },
            { value: 'live', label: t('hist.arch.live') },
            { value: 'missing', label: t('hist.arch.missing') },
          ]
          // 导出弹窗内的工作区筛选选项与候选会话（随弹窗状态/数据刷新重算）。
          // 组 id 与列表页同源（活登记 + 按会话目录重建的分组）。
          var exportWsOptions = [{ value: '', label: t('hist.ws.all') }]
          if (exp && data.groups && data.groups.length) {
            data.groups.forEach(function (g) { exportWsOptions.push({ value: g.id, label: g.title }) })
            exportWsOptions.push({ value: 'ungrouped', label: t('hist.ungrouped') })
          } else if (exp && data.workspaces) {
            Object.keys(data.workspaces).forEach(function (wid) {
              exportWsOptions.push({ value: 'ws:' + wid, label: (data.workspaces[wid].title || wid) })
            })
            exportWsOptions.push({ value: 'ungrouped', label: t('hist.ungrouped') })
          }
          var exportItems = []
          if (exp) {
            var useGroups = !!(data.groups && data.groups.length)
            exportItems = (exp.items || []).filter(function (it) {
              if (exp.archFilter === 'archived' && !it.archived) return false
              if (exp.archFilter === 'live' && it.archived) return false
              if (exp.archFilter === 'missing' && !it.cwdMissing) return false
              if (!exp.wsFilter) return true
              if (useGroups) {
                if (exp.wsFilter === 'ungrouped') return !it.groupId
                return it.groupId === exp.wsFilter
              }
              if (exp.wsFilter === 'ungrouped') return !it.workspaceId || !data.workspaces[it.workspaceId]
              var wid = exp.wsFilter.slice(3)
              return it.workspaceId === wid && !!data.workspaces[wid]
            })
          }

          function renderRow(it) {
            return React.createElement('div', { className: 'dsm-hist-row', key: it.sessionId },
              React.createElement('input', { type: 'checkbox', className: 'dsm-hist-check', checked: selected.has(it.sessionId), onChange: function () { toggleSelect(it.sessionId) } }),
              React.createElement('div', { className: 'dsm-hist-main' },
                React.createElement('div', { className: 'dsm-hist-title' }, it.title || ('Session ' + shortId(it.sessionId))),
                it.cwd ? React.createElement('div', { className: 'dsm-hist-cwd', title: it.cwd }, it.cwd) : null),
              React.createElement('div', { className: 'dsm-hist-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, onClick: function () { doUnarchive(it.sessionId) } }, t('hist.btn.restore')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'delete', sessionId: it.sessionId, title: it.title || ('Session ' + shortId(it.sessionId)) }) } }, t('hist.btn.purge'))))
          }

          // 分组卡片：dsm-source 卡片 + 可折叠表头（与 MCP / Skills 页一致的源卡片语言）。
          function toggleGroupCollapse(key) {
            setCollapsed(function (prev) {
              var next = Object.assign({}, prev)
              next[key] = !next[key]
              return next
            })
          }
          function renderGroup(g) {
            var groupIds = g.items.map(function (it) { return it.sessionId })
            var allChecked = groupIds.length > 0 && groupIds.every(function (id) { return selected.has(id) })
            var open = !collapsed[g.key]
            // 重建组（宿主里没有对应登记）：标出「曾登记、已被移除」或「从未登记」，目录仍在则给一键重新登记。
            var detached = g.kind === 'detached'
            return React.createElement('div', { className: 'dsm-source', key: 'g:' + g.key },
              React.createElement('div', { className: 'dsm-source-head dsm-hist-group-head' },
                React.createElement('input', { type: 'checkbox', className: 'dsm-hist-group-check', checked: allChecked, onChange: function () { toggleGroup(groupIds) }, 'aria-label': t('hist.selectGroup', { title: g.title }) }),
                React.createElement('button', { type: 'button', className: 'dsm-source-head-main', 'aria-expanded': open, onClick: function () { toggleGroupCollapse(g.key) } },
                  React.createElement('span', { className: 'dsm-source-title dsm-hist-group-title', title: g.title }, g.title),
                  React.createElement('span', { className: 'dsm-count' }, t('hist.group.count', { count: g.items.length }))),
                detached ? React.createElement('div', { className: 'dsm-hist-group-extra' },
                  React.createElement('span', { className: 'dsm-tag', title: t('hist.group.removed.hint') },
                    t('hist.group.removed')),
                  g.canRegister ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy, title: t('hist.btn.registerWs.hint'), onClick: function () { setModal({ type: 'register', path: g.path, title: g.title }) } }, t('hist.btn.registerWs')) : null,
                  g.dirMissing ? React.createElement('span', { className: 'dsm-hist-dir-missing', title: t('hist.group.dirMissing.hint') }, '⚠ ' + t('hist.group.dirMissing')) : null) : null,
                g.path ? React.createElement('span', { className: 'dsm-path', title: g.path }, g.path) : null),
              open ? React.createElement('div', { className: 'dsm-source-body' }, g.items.map(renderRow)) : null)
          }

          return React.createElement('section', { className: 'dsm-section' },
            React.createElement('div', { className: 'dsm-head' },
              React.createElement('div', { className: 'dsm-title-block' },
                React.createElement('div', { className: 'dsm-title-row' },
                  React.createElement('h2', { className: 'dsm-title' }, t('tabs.sessions'))),
                React.createElement('p', { className: 'dsm-desc' }, t('sessions.desc'))),
              React.createElement('div', { className: 'dsm-actions' },
                refreshButton(t, data.loading, { className: 'dsm-btn dsm-btn-secondary', disabled: data.loading, onClick: function () { refresh() } }),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openImportPicker }, t('hist.btn.import')),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openExportPicker }, t('hist.btn.export')),
                // 「全选 / 取消全选」紧挨导出（用户 2026-09-17 裁定）：它是列表级动作，
                // 与其余页头动作同栏，不再和统计数字挤在一行。
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk', disabled: !filtered.length, onClick: function () { toggleAllVisible(visibleIds) } }, bulkPair(allVisible ? t('hist.deselectAll') : t('hist.selectAll'), allVisible ? t('hist.selectAll') : t('hist.deselectAll'))),
                // 「已选 N 项」不另立一栏：两颗按钮各自带着份数（恢复所选 (152) / 删除所选 (152)），
                // 第三遍数字只会把这一行挤到折行（用户 2026-09-19：把「已选 152 项」删掉就有位置了）。
                selected.size > 0 ? React.createElement('div', { className: 'dsm-hist-batch' },
                  React.createElement('div', { className: 'dsm-hist-batch-actions' },
                    React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: function () { doUnarchiveBatch() } }, t('hist.btn.restoreSelected', { count: selected.size })),
                    React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { setModal({ type: 'deleteBatch', count: selected.size }) } }, t('hist.btn.deleteSelected', { count: selected.size })))) : null)),
            React.createElement('div', { className: 'dsm-stat-row' },
              React.createElement('div', { className: 'dsm-summary' },
                [['archived', data.items.length, t('hist.stat.archived')], ['projects', grouped ? groups.length : '—', t('hist.stat.projects')], ['retention', data.retentionDays ? String(data.retentionDays) : '∞', t('hist.stat.retention')]].map(function (item) {
                  return React.createElement('div', { key: item[0], className: 'dsm-stat' },
                    React.createElement('strong', null, item[1]), item[2])
                }))),
            React.createElement('div', { className: 'dsm-filters' },
              React.createElement('input', { className: 'dsm-control dsm-search', type: 'text', placeholder: t('hist.search.placeholder'), value: query, onChange: function (e) { setQuery(e.target.value) } }),
              React.createElement('div', { className: 'dsm-source-filter' },
                React.createElement(SourceSelect, {
                  options: RETENTION_OPTS, value: data.retentionDays, onChange: function (v) { setRetention(Number(v)) },
                }))),
            // 走 Notice 而不是裸 div：令牌没过的提醒会在右侧自动多出一颗「填写令牌」按钮。
            data.error ? React.createElement(Notice, { kind: 'err', text: String(data.error) }) : null,
            notice ? React.createElement(Notice, { kind: notice.kind, text: notice.text }) : null,
            data.loading && !data.items.length ? React.createElement('div', { className: 'dsm-empty' }, t('hist.loading'))
              : filtered.length === 0 ? React.createElement('div', { className: 'dsm-empty' }, dq ? t('hist.empty.search') : t('hist.empty.none'))
              : React.createElement('div', { className: 'dsm-sources' },
                grouped ? groups.map(renderGroup) : React.createElement('div', { className: 'dsm-source' }, filtered.map(renderRow))),
            modal && modal.type === 'delete' ? React.createElement(Modal, { key: 'del', title: t('hist.purge.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.purge.one', { title: modal.title })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { doDelete(modal.sessionId) } }, t('hist.btn.confirmPurge')))) : null,
            modal && modal.type === 'deleteBatch' ? React.createElement(Modal, { key: 'delb', title: t('hist.purge.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.purge.batch', { count: modal.count })),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: busy, onClick: function () { doDeleteBatch() } }, t('hist.btn.confirmPurge')))) : null,
            modal && modal.type === 'register' ? React.createElement(Modal, { key: 'reg', title: t('hist.register.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.register.body', { title: modal.title })),
              React.createElement('p', { className: 'dsm-help dsm-hist-register-path' }, String(modal.path || '')),
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: busy, onClick: function () { doRegisterWorkspace(modal.path) } }, t('hist.register.confirm')))) : null,
            modal && modal.type === 'registered' ? React.createElement(Modal, { key: 'regdone', title: t('hist.register.done.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.register.done.body', { title: (modal.workspace && modal.workspace.title) || '' })),
              (modal.workspace && modal.workspace.attached && modal.workspace.attached.length)
                ? React.createElement('p', { className: 'dsm-help' }, t('hist.register.done.attached', { count: modal.workspace.attached.length }))
                : null,
              (modal.workspace && modal.workspace.attachSkipped && modal.workspace.attachSkipped.length)
                ? React.createElement('p', { className: 'dsm-help dsm-warning' }, t('hist.register.done.skipped', { count: modal.workspace.attachSkipped.length, reason: String(modal.workspace.attachSkipped[0].reason || '') }))
                : null) : null,
            // D13：会话页也改用共享 ImportModal（能力取三者并集）。差异只在 extra 区
            // （项目目录）与提交回调：选完文件直接导入，没有二次确认。
            imp ? React.createElement(ImportModal, {
              key: 'imp',
              t: t,
              title: t('hist.btn.import'),
              accept: '.jsonl,.json,.md,.markdown,.txt',
              busy: imp.busy === true,
              requirements: [t('upload.requirement.session.1'), t('upload.requirement.session.2'), t('upload.requirement.session.3')],
              result: imp.error ? { ok: false, text: String(imp.error) } : (imp.result ? { ok: true, text: t('hist.import.done', { id: imp.result.sessionId, count: imp.result.count }) } : null),
              extra: React.createElement('div', null,
                React.createElement('div', { className: 'dsm-field' },
                  React.createElement('label', { className: 'dsm-label' }, t('hist.import.cwd')),
                  React.createElement('input', { className: 'dsm-control', type: 'text', placeholder: t('hist.import.cwd.placeholder'), value: imp.cwd || '', onChange: function (e) { setImp(Object.assign({}, imp, { cwd: e.target.value })) } }))),
              onClose: function () { setImp(null) },
              onSubmit: function (entries, files) { doImportFile(files[0]) },
            }) : null,
            exp ? React.createElement(Modal, { key: 'exp', className: 'dsm-modal-list dsm-export-modal', list: true, title: t('hist.btn.export'), closeLabel: t('btn.close'), onClose: function () { setExp(null) } },
              React.createElement('p', { className: 'dsm-help' }, t('hist.export.hint')),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('hist.export.dir')),
                React.createElement('div', { className: 'dsm-dir-row' },
                  React.createElement('input', { className: 'dsm-control', type: 'text', placeholder: 'D:\\backups\\dsh\\exports', value: exp.outDir || '', onChange: function (e) { setExp(Object.assign({}, exp, { outDir: e.target.value })) } }),
                  React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: exp.busy, onClick: openExportDir, title: t('hist.export.browse') }, t('hist.btn.browse'))),
                exp.pickingDir ? React.createElement(DirPickerModal, { key: 'exp-dir-picker', title: t('hist.export.pickDir'), initial: String(exp.outDir || ''), closeLabel: t('btn.close'), onClose: function () { setExp(Object.assign({}, exp, { pickingDir: false })) }, onPick: function (path) { setExp(Object.assign({}, exp, { outDir: path, pickingDir: false })) } }) : null),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('hist.export.format')),
                React.createElement(SourceSelect, { options: EXPORT_FORMAT_OPTS, value: exp.format, onChange: function (v) { setExp(Object.assign({}, exp, { format: v })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('hist.export.scope')),
                React.createElement(SourceSelect, { options: EXPORT_ARCH_OPTS, value: exp.archFilter, onChange: function (v) { setExp(Object.assign({}, exp, { archFilter: v, selectedIds: new Set() })) } })),
              React.createElement('div', { className: 'dsm-field' },
                React.createElement('label', { className: 'dsm-label' }, t('hist.export.workspace')),
                React.createElement(SourceSelect, { options: exportWsOptions, value: exp.wsFilter, onChange: function (v) { setExp(Object.assign({}, exp, { wsFilter: v, selectedIds: new Set() })) } })),
              React.createElement('div', { className: 'dsm-field dsm-export-body' },
                React.createElement('div', { className: 'dsm-label' }, t('hist.export.sessions', { count: exportItems.length })),
                React.createElement('div', { className: 'dsm-source dsm-pick-list' },
                  exp.loading ? React.createElement('div', { className: 'dsm-empty' }, t('hist.export.loading'))
                    : exportItems.length ? (function () {
                        // 按**工作区目录**分组：不同文件夹的会话分开列，组头可折叠。
                        var groups = [], byCwd = {}
                        exportItems.forEach(function (it) {
                          var ck = String(it.cwd || '')
                          if (!byCwd[ck]) { byCwd[ck] = []; groups.push({ cwd: ck, rows: byCwd[ck] }) }
                          byCwd[ck].push(it)
                        })
                        return groups.map(function (g) {
                          var key = 'exp:' + g.cwd
                          var open = collapsed[key] !== true
                          return React.createElement('div', { key: key, className: 'dsm-pick-group' },
                            React.createElement('button', { type: 'button', className: 'dsm-pick-group-head', 'aria-expanded': open ? 'true' : 'false', onClick: function () { toggleGroupCollapse(key) } },
                              React.createElement('span', { className: 'dsm-pick-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
                              React.createElement('span', { className: 'dsm-pick-group-name', title: g.cwd || t('hist.ungrouped') }, g.cwd || t('hist.ungrouped')),
                              React.createElement('span', { className: 'dsm-pick-group-count' }, t('export.group.count', { count: g.rows.length }))),
                            open ? g.rows.map(function (it) {
                              return React.createElement('label', { key: it.sessionId, className: 'dsm-hist-row' },
                                React.createElement('input', { type: 'checkbox', className: 'dsm-hist-check', checked: exp.selectedIds.has(it.sessionId), onChange: function () { toggleExportSelect(it.sessionId) } }),
                                React.createElement('div', { className: 'dsm-hist-main' },
                                  React.createElement('div', { className: 'dsm-hist-title' }, it.title || ('Session ' + shortId(it.sessionId))),
                                  it.cwdMissing ? React.createElement('div', { className: 'dsm-hist-cwd dsm-hist-cwd-missing', title: t('hist.cwd.missing') + it.cwd }, '⚠ ' + it.cwd) : null),
                                React.createElement('div', { className: 'dsm-hist-actions' },
                                  React.createElement('span', { className: 'dsm-tag' + (it.archived ? '' : ' dsm-tag-on') }, it.archived ? t('hist.tag.archived') : t('hist.tag.live'))))
                            }) : null)
                        })
                      })() : React.createElement('div', { className: 'dsm-empty' }, t('hist.export.empty')))),
              exp.error ? React.createElement('div', { className: 'dsm-feedback dsm-error' }, String(exp.error)) : null,
              exp.result ? React.createElement('div', { className: 'dsm-feedback' },
                exp.result.exported
                  ? (t('hist.result.exported', { count: (exp.result.exported || []).length, dir: String(exp.outDir || '').trim() })
                    + ((exp.result.skipped && exp.result.skipped.length) ? t('hist.result.skipped', { count: exp.result.skipped.length, ids: exp.result.skipped.map(function (s) { return s.sessionId }).join('、') }) : ''))
                  : (t('hist.result.archived', { count: exp.result.archived })
                    + (exp.result.failed ? t('hist.result.archiveFailed', { count: exp.result.failed }) : ''))) : null,
              React.createElement('div', { className: 'dsm-modal-actions' },
                React.createElement('span', { className: 'dsm-hist-batch-count' }, t('hist.selected', { count: exp.selectedIds.size })),
                React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: exp.busy || !exp.selectedIds.size, onClick: doArchiveSelected, title: t('hist.btn.archiveSelected.title') }, t('hist.btn.archiveSelected')),
                React.createElement('button', { type: 'button', className: 'dsm-btn', disabled: exp.busy || !exp.selectedIds.size || !String(exp.outDir || '').trim(), onClick: doExport }, exp.busy ? t('hist.export.busy') : t('hist.btn.exportSelected', { count: exp.selectedIds.size })))) : null,
            modal && modal.type === 'error' ? React.createElement(Modal, { key: 'err', title: t('hist.error.title'), closeLabel: t('btn.close'), onClose: function () { setModal(null) } },
              React.createElement('p', { className: 'dsm-help' }, String(modal.message || t('hist.error.unknown')))) : null)
        }

    // ---------- Rules 页（v0.3 规则层：场景 = 一级目录，勾选即自动生效）----------
    // 场景/分组名校验：与宿主 src/memories/service.ts 的 isValidGroupSegment 保持一致。
    // 变更单 01 放宽为**任意 Unicode**（`办公` / `日常` 必须通过），只保留文件系统安全约束。
    var SCENE_RESERVED_RE = /[<>:"|?*\\/]/
    function isValidSceneSegment(segment) {
      var s = String(segment == null ? '' : segment)
      if (s === '' || s === '.' || s === '..') return false
      if (s.length > 64) return false
      if (s.charAt(0) === '.') return false
      if (SCENE_RESERVED_RE.test(s)) return false
      if (s !== s.trim()) return false
      if (/[.\s]$/.test(s)) return false
      return true
    }
    function isValidScenePath(group) {
      var s = String(group == null ? '' : group)
      if (s === '' || s.charAt(0) === '/' || s.charAt(s.length - 1) === '/') return false
      return s.split('/').every(isValidSceneSegment)
    }
    var RULE_FORM_OPTIONS = [
      { value: 'flat', label: 'flat' },
      { value: 'bundle', label: 'bundle' },
    ]
    /**
     * 场景显示名：宿主给出的 `label` 优先（保留场景 `global` 的 label 是「全局」，由宿主决定），
     * 界面不再自己拼中文；没有元数据的游离桶（`''`）用专门的说明文案。
     *
     * 定义在模块作用域、把 `scenes` 作为**参数**传入：它原本是 MemoryPage 内部的闭包，
     * 而 ScenesPage 也调用它——两个页面是各自独立的函数作用域，闭包不可能共享。
     * 那正是「工具」页整页白屏的原因（ScenesPage 渲染卡片时 ReferenceError: sceneLabel
     * is not defined，被 shell 的 slot 边界吞成一条日志，面板什么都不画）。
     */
    function sceneLabel(scenes, name) {
      if (name === '') return t('memory.scene.orphan')
      // 两个保留场景的名字由宿主回传（label 恒为中文「全局」/「常开」），必须先按名字取词条：
      // 放在 `row.label` 之后就会被中文 label 抢先，英文界面下这两个名字一直是中文。
      if (name === 'global') return t('memory.scene.global')
      if (name === '_shared') return t('memory.scene.shared')
      var row = (scenes || []).filter(function (s) { return s.name === name })[0]
      if (row && row.label) return row.label
      return name
    }

    /**
     * 场景描述最多存多少个字（新建/编辑表单的 `maxLength` 与字数计数都用它）。
     *
     * 卡片那一行**不靠这个数撑腰**：`.dsm-scene-tile-desc` 是 `nowrap` + 省略号，
     * 再长也只占一行、不会把卡片撑成纵向。显示层仍按它裁一次，兜住历史数据。
     */
    var SCENE_DESC_MAX = 300
    /** 记忆描述在勾选行里最多显示多少个字：记忆正文可能很长，行内只留一行，超长截断（全文进 title）。 */
    var MEM_DESC_MAX = 80
    /** 压平空白并裁到 max 个字符（含省略号）；返回空串 = 没有描述。 */
    function clipText(value, max) {
      var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
      if (s.length <= max) return s
      return s.slice(0, max - 1) + '…'
    }
    /**
     * 记忆归属的场景名 = 分组路径的第一段（`办公/流程/站会` → `办公`）。
     *
     * 与宿主的 `sceneOf()`、渲染路径里的 `ref.scene` 逐字一致（`src/memories/service.ts:763`、
     * `scene` 由一级目录写入 `probe.refs`）。界面若按完整 group 比对，多级分组的记忆会整个看不见。
     */
    function sceneOfGroup(group) {
      var s = String(group == null ? '' : group)
      var i = s.indexOf('/')
      return i >= 0 ? s.slice(0, i) : s
    }
    /** 某个场景的记忆（按名称排序）。**只含该场景自己的**——跨场景勾选在宿主侧是不生效的，见下。 */
    function sceneMemoriesOf(memories, scene) {
      var list = Array.isArray(memories) ? memories : []
      return list
        .filter(function (m) { return m && sceneOfGroup(m.scene) === scene })
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)) })
    }
    /**
     * 「添加记忆段」的默认勾选：**只勾被编辑场景里已启用的那几条**，其余一律不勾。
     *
     * 记忆段的语义是「勾 = 该场景的记忆是否注入」，所以默认值取「用户已经让这个场景生效的那几条」——
     * 既不改变现状，也不会把没打算注入的记忆塞进档案。启用状态来自 `rules-list`（记忆 id 就是
     * 规则 id），因此纯客户端可算，不需要宿主配合。
     */
    function memDefaultPickIds(memories, rules, scene) {
      var enabled = {}
      var rows = Array.isArray(rules) ? rules : []
      rows.forEach(function (r) {
        if (!r || r.shadowed === true || r.enabled === false) return
        enabled[String(r.id)] = true
      })
      return sceneMemoriesOf(memories, scene)
        .filter(function (m) { return enabled[String(m && m.id)] === true })
        .map(function (m) { return String(m.id) })
    }
    /** 场景页卡片上的描述行：**只有描述**，数量（记忆条数 / 已配 N 台 MCP…）不进卡片。 */
    function sceneTileDesc(scene) {
      return clipText(scene && scene.description, SCENE_DESC_MAX)
    }

    // ---------- 场景记忆页（场景 = scene-memory/ 下的一级目录；内容自动生效）----------
        //