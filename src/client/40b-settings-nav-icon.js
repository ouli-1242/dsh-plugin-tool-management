
        // ── 设置侧栏「工具管理」那一行的图标 ──
        //
        // 宿主提供了 `settings.section.icon` 这个 slot：
        //   dsh-client-ui-settings-general 的 SettingsPanel 渲染每一行时调用
        //     renderSlot('settings.section.icon', { size, active }, { only: row.id, fallback: navIcon(row.id) })
        // 只要注册 id 与 `settings.section` 的 id 相同，就能拿到自己的字形；没注册的 id
        // 仍旧回落到宿主那张封闭名单（account / models / agent-presets / plugins /
        // archived-sessions），其余一律是默认齿轮。
        //
        // 为什么改掉旧实现：旧宿主没有这个 slot，本插件用的是「CSS 藏掉宿主 svg、
        // 在 ::before 上画自己的图」的 DOM 接管法（dshmarket / dsh-better-sidebar 的先例）。
        // 后来宿主把图标从 `button > svg` 改成了 `button > span.navIcon > svg`，那条
        // `> svg` 选择器随之失配 —— 宿主的齿轮没被藏住，于是同一行并排出现「叠方块 + 齿轮」
        // 两个图标（用户截图里工具管理 / 插件市场 / 侧边卡片都是这个症状，后两家用的也是
        // 同一套接管法）。既然官方把插槽开出来了，MutationObserver 那套搬砖就该整段删掉，
        // 而不是再补一条更宽的选择器去猜宿主的 DOM。
        //
        // 图形与 docs/images/icon.svg 同源（三层叠放方块，1024 视图框），但这里内联 path：
        // 客户端 bundle 是单文件，没有加载外部资源的通道。`fill: currentColor` 让它在
        // 选中 / 悬停 / 切主题时跟旁边那排宿主图标一起变色（旧实现用 mask 绕的也是这件事）。

        /**
         * 本插件设置分区的 id。
         *
         * `settings.section` 与 `settings.section.icon` 两个注册点**必须同值**：
         * 宿主按 `only: row.id` 取图标，对不上就永远不渲染。所以这里只留一份字面量，
         * 41 片注册分区时引用它 —— 两处各写一遍迟早会漂移成「图标消失但没人报错」。
         */
        var SETTINGS_SECTION_ID = 'dsm-tools'

        /** 导航字形的三段 path（取自 docs/images/icon.svg，未改坐标）。 */
        var SETTINGS_NAV_ICON_PATHS = [
          'M592 336h-416c-52.928 0-96 43.072-96 96v416c0 52.928 43.072 96 96 96h416c52.928 0 96-43.072 96-96v-416c0-52.928-43.072-96-96-96z m32 512a32 32 0 0 1-32 32h-416c-17.632 0-32-14.336-32-32v-416c0-17.632 14.368-32 32-32h416c17.664 0 32 14.368 32 32v416z',
          'M720 208h-416a32 32 0 0 0 0 64h416c17.664 0 32 14.368 32 32v416a32 32 0 1 0 64 0v-416c0-52.928-43.072-96-96-96zM528 752h-288a32 32 0 1 0 0 64h288a32 32 0 1 0 0-64z',
          'M848 80h-416a32 32 0 0 0 0 64h416c17.664 0 32 14.368 32 32v416a32 32 0 1 0 64 0v-416c0-52.928-43.072-96-96-96z'
        ]

        /**
         * 侧栏字形组件。
         *
         * 宿主传 `size`（正整数，当前是 16）与 `active`（是否选中）。这里只吃 size：
         * 选中态的着色由宿主按钮的 color 决定，`currentColor` 自动跟随，不需要分支。
         * `display: block` 是给行内基线留的余量 —— span.navIcon 在 0.2.2 是 flex，
         * 但 flex 容器里的 inline svg 仍可能多出几像素行高。
         */
        function SettingsNavIcon(props) {
          var size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 16
          return React.createElement('svg', {
            viewBox: '0 0 1024 1024',
            width: size,
            height: size,
            fill: 'currentColor',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { display: 'block' }
          }, SETTINGS_NAV_ICON_PATHS.map(function (d, i) {
            return React.createElement('path', { key: i, d: d })
          }))
        }

        // 注册。放在 41 片注册 `settings.section` 之前也无妨：slot 是列表，宿主渲染时
        // 才按 id 配对，两边的注册顺序与面板打开顺序都不影响结果。
        //
        // 整段包在 try 里：图标是纯装饰。宿主若还没有这个 slot（0.2.1 及以前），最坏
        // 结果应该是「还是那颗默认齿轮」，绝不能把 apply 带崩 —— 2026-10-18 那次 TDZ
        // 就是一个装饰性功能让整个宿主 boot 失败（"entry did not activate"）。
        try {
          slots.inject('settings.section.icon', function () {
            return slots.register(
              { name: 'settings.section.icon', id: SETTINGS_SECTION_ID, order: 16 },
              function (props) { return SettingsNavIcon(props) }
            )
          })
        } catch (e) {
          try { console.warn('[dsh-plugin-tool-management] 设置侧栏图标不可用，沿用宿主默认图标：' + errMsg(e)) } catch (e2) { /* 控制台不可用 */ }
        }
