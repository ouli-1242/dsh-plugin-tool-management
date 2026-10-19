
        // ── 侧栏入口（2026-10-18）─────────────────────────────────────────────────
        //
        // 宿主的侧栏全局入口是**两半**：`main` 里那个键控面板（选中后占中栏）与
        // `sidebar.panellist` 里那一行（图标 + 名字）。两半必须同 id，点行才有地方去。
        //
        // 为什么是"主面板"而不是"打开设置"：设置对话框的开合状态是宿主私有的，没有公开
        // 服务可调（同生态的 dshmarket 在 sidebar-entry.ts 里写明同一件事 —— 主面板是公开
        // 契约里唯一的一键目的地）。所以这一行打开的是本插件页面的**另一份挂载**，内容
        // 与设置面板里那一页同源（都渲染 ToolsSection），不是复制一套界面。
        //
        // 开关在兼容页页头，状态与侧车在 factory 作用域（见 20 片 sidebarEntryState）：
        // 关掉时两半一起撤，撤销前先把中栏从这一页带出去 —— 否则选中项指向一个已注销的
        // key，中栏会空着。
        const SIDEBAR_ENTRY_ID = 'dsm-tools'
        // 排在官方那几行之后（插件 0 / 市场 1 / 自动化任务 10）：本插件是"设置"这一类，
        // 摆在那三行下面比插在插件与市场之间更像话。
        const SIDEBAR_ENTRY_ORDER = 20

        /**
         * 侧栏入口打开的那一页：外层只负责滚动，内层负责留白，内容仍是 ToolsSection 本身。
         *
         * ⚠️ 留白必须落在**内层**：`.dsm-tabs-shell` 是 position:sticky，它的粘附基准是
         * 滚动容器的内容盒 —— 留白留在滚动容器（`.dsm-panel`）上，页签只能粘在内容盒顶端，
         * 视口顶部到页签之间就露出一条滚过去的内容（用户 2026-10-19：内容一长页签浮在半空）。
         * 留白挪到内层后，页签粘到滚动容器顶边，上下都不再透内容。
         */
        function SidebarToolsPage() {
          return React.createElement('div', { className: 'dsm-panel' },
            React.createElement('div', { className: 'dsm-panel-body' }, React.createElement(ToolsSection)))
        }

        /**
         * 侧栏那一行的图标（props：size / active，宿主给）。
         *
         * 与设置侧栏那颗图形同一份（40b 的 mask 版给宿主的封闭名单用），这里直接画 ——
         * 用 currentColor，宿主切换选中 / 悬停 / 主题时自动跟着变。
         */
        function SidebarEntryIcon(props) {
          const size = (props && props.size) || 16
          return React.createElement('svg', { viewBox: '0 0 1024 1024', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
            React.createElement('path', { fill: 'currentColor', d: 'M592 336h-416c-52.928 0-96 43.072-96 96v416c0 52.928 43.072 96 96 96h416c52.928 0 96-43.072 96-96v-416c0-52.928-43.072-96-96-96z m32 512a32 32 0 0 1-32 32h-416c-17.632 0-32-14.336-32-32v-416c0-17.632 14.368-32 32-32h416c17.664 0 32 14.368 32 32v416z' }),
            React.createElement('path', { fill: 'currentColor', d: 'M720 208h-416a32 32 0 0 0 0 64h416c17.664 0 32 14.368 32 32v416a32 32 0 1 0 64 0v-416c0-52.928-43.072-96-96-96zM528 752h-288a32 32 0 1 0 0 64h288a32 32 0 1 0 0-64z' }),
            React.createElement('path', { fill: 'currentColor', d: 'M848 80h-416a32 32 0 0 0 0 64h416c17.664 0 32 14.368 32 32v416a32 32 0 1 0 64 0v-416c0-52.928-43.072-96-96-96z' }))
        }

        /**
         * 一块注册 + 一个 `apply`：开关真翻的那一刻就注册 / 注销，不必等下一次打开面板。
         *
         * @param leavePanel 面板那一半传 true：注销前先把中栏带出去（见文件内那段注释）。
         */
        const sidebarEntryGate = function (options, component, leavePanel) {
          let dispose = null
          const apply = function () {
            const want = sidebarEntrySnapshot().enabled !== false
            if (want && dispose === null) {
              const off = slots.register(options, component)
              dispose = typeof off === 'function' ? off : function () {}
              return
            }
            if (want || dispose === null) return
            const stop = dispose
            dispose = null
            if (leavePanel) {
              const layout = serviceOf('layout')
              try {
                if (layout && layout.panelInfo && layout.panelInfo.getSnapshot().activePanelId === SIDEBAR_ENTRY_ID) layout.selectPanel(null)
              } catch (e) { /* 布局服务不可用 → 交给宿主的 retainMainPanels */ }
            }
            stop()
          }
          apply()
          const unsubscribe = onSidebarEntryChange(apply)
          return function () {
            unsubscribe()
            if (dispose !== null) { const stop = dispose; dispose = null; stop() }
          }
        }

        // 两个 slot 各自注入：宿主没声明侧栏（旧版本 / 精简组合）时这一整段等于不存在，
        // 设置面板里那一页照旧能用。
        slots.inject('main', function () {
          return sidebarEntryGate({ name: 'main', key: SIDEBAR_ENTRY_ID }, SidebarToolsPage, true)
        })
        slots.inject('sidebar.panellist', function () {
          return sidebarEntryGate({
            name: 'sidebar.panellist', id: SIDEBAR_ENTRY_ID, order: SIDEBAR_ENTRY_ORDER,
            label: function () { return t('nav.title') }, locale: NS,
          }, SidebarEntryIcon, false)
        })
        // 读一次存下来的开关（读侧免令牌，见 op-registry 的 sidebar-settings）。读不到就
        // 保持默认（开）；这一次跑在注册之后，所以关着的人会先看到一行再消失 —— 与
        // dshmarket 同一条时序，换的是"不必等服务器往返就能先给界面"。
        apiCall('sidebar-settings', {}).then(function (r) {
          if (r && r.ok && r.settings) setSidebarEntryState({ enabled: r.settings.enabled !== false })
        }).catch(function () { /* 读不到 → 保持默认（开） */ })
