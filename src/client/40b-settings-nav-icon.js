
        // ── 设置侧栏「工具管理」那一行的图标（2026-10-18）─────────────────────────
        //
        // 为什么需要它：宿主 ui-settings-general 的 SettingsPanel 用 `navIcon(row.id)`
        // 挑侧栏字形，那是一张封闭名单 —— account / models / agent-presets /
        // plugins / archived-sessions 各有专用图标，**其余 id 一律落到默认齿轮**。
        // `settings.section` 这个 slot 只投影 id / order / label 三项（宿主 bundle 里
        // SlotCore 的注册描述符与运行时 slot 清单都只有这三个字段），注册方没有图标可传，
        // 所以每一个第三方分区都戴着那颗齿轮，本插件也是。
        //
        // 做法（dshmarket / dsh-better-sidebar / dsh-skill-mcp-panel 三家都是这么干的，
        // 先例见 dshmarket 的 settings-nav-icon.ts）：本插件的客户端 fiber 在场时，
        // 认领设置面板里**可见文字等于本分区当前 label** 的那一行，给它打一个标记属性，
        // 再用一条样式把宿主的齿轮 svg 藏起来、在 ::before 上画我们自己的图。
        //
        // 几条边界，逐条对应"会不会出事"：
        //   · 认领判据只有**文案全等**（isOwnNavRow）。空 label 匹配不到任何行 ——
        //     语言还没解析出来时不能把整条 nav 都标上。
        //   · 只给标记加属性、注入一条样式，**不碰宿主的 DOM 结构与 React 树**。
        //   · 样式与 observer 都长在 ctx.effect 里，fiber 卸载时一起撤（撤的时候顺手
        //     把标记擦掉，不会留下污染给下一个打开的面板）。
        //   · 宿主重绘面板时 React 会把我们换掉的齿轮**改回来**，所以用 MutationObserver
        //     盯着 document.body 重新贴；这一点不是锦上添花，是这条路能成立的唯一原因。
        //   · 宿主哪天给 settings.section 加了 icon 字段，这个模块（连同调用点）就可以删。
        //
        // 图形用 CSS `mask-image` 而不是 <img>：mask 只读 alpha，可见颜色取自元素的
        // `background-color: currentColor`，于是侧栏选中/悬停/主题切换时图标自动跟着变，
        // 与旁边那排宿主图标完全一致。<img> 做不到这一点（它是死颜色）。
        // 代价是 SVG 必须**纯黑**绘制 —— mask 只认 alpha，任何非黑填充都会变成实心块。
        //
        // ⚠️ 本片整段都在 `apply()` 体内（40 片那个 `apply(ctx) {` 之后的所有分片都是），
        // 所以 `installSettingsNavIcon(...)` 的调用必须写在**这些 const 之后** ——
        // 写在 40 片那个位置会撞 const 的 TDZ（`Cannot access 'NAV_ICON_MARKER'
        // before initialization`），宿主当场 boot 失败。2026-10-18 就是这么挂的。

        /** 标记本插件自己那一行的属性名（前缀跟着本插件，避免与别家插件的标记撞名）。 */
        var NAV_ICON_MARKER = 'data-dsm-nav-icon'

        /**
         * 设置面板的侧栏行。宿主把每个 settings.section 条目渲染成面板 <nav> 里的
         * 一个 <button>（SettingsPanel 在 dsh-client-ui-settings-general）。
         */
        var NAV_ROW_SELECTOR = '[role="dialog"] nav button'

        /**
         * 图标本体：三层叠放的方块（工具管理），取自 docs/images/icon.svg。
         *
         * 纯黑是刻意的（见上面说明）：mask 只读 alpha。viewBox 与源文件一致（1024），
         * 渲染尺寸由 CSS 的 mask-size 决定，所以这里不写宽高。
         */
        function navIconMaskSvg() {
          return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="#000">'
            + '<path d="M592 336h-416c-52.928 0-96 43.072-96 96v416c0 52.928 43.072 96 96 96h416c52.928 0 96-43.072 96-96v-416c0-52.928-43.072-96-96-96z m32 512a32 32 0 0 1-32 32h-416c-17.632 0-32-14.336-32-32v-416c0-17.632 14.368-32 32-32h416c17.664 0 32 14.368 32 32v416z"/>'
            + '<path d="M720 208h-416a32 32 0 0 0 0 64h416c17.664 0 32 14.368 32 32v416a32 32 0 1 0 64 0v-416c0-52.928-43.072-96-96-96zM528 752h-288a32 32 0 1 0 0 64h288a32 32 0 1 0 0-64z"/>'
            + '<path d="M848 80h-416a32 32 0 0 0 0 64h416c17.664 0 32 14.368 32 32v416a32 32 0 1 0 64 0v-416c0-52.928-43.072-96-96-96z"/>'
            + '</svg>'
        }

        /** mask 的 data URL（运行时编码，不手写转义）。 */
        function navIconMaskUrl(svg) {
          return 'data:image/svg+xml,' + encodeURIComponent(svg || navIconMaskSvg())
        }

        /**
         * 这一行是不是本插件的。
         *
         * 纯函数，也是这套逻辑**唯一**的判定：可见文字等于宿主此刻正在投影的本分区
         * label。空 label 一律不匹配 —— 语言没解析出来时不能把整条 nav 都认下来。
         */
        function isOwnNavRow(rowText, wantedLabel) {
          var wanted = String(wantedLabel == null ? '' : wantedLabel).trim()
          if (wanted.length === 0) return false
          return String(rowText == null ? '' : rowText).trim() === wanted
        }

        /**
         * 标记行的样式：藏掉宿主的齿轮，在 ::before 上画我们的图。
         *
         * 16px 与宿主那排字形同尺寸（它的 navIcon 走 size: 16），位置由 flex 排在
         * 标签之前 —— 按钮本身是 flex 行，::before 作为第一个子元素天然就位。
         */
        function navIconCss(maskUrl) {
          return [
            '[' + NAV_ICON_MARKER + '] > svg { display: none; }',
            '[' + NAV_ICON_MARKER + ']::before {',
            "  content: '';",
            '  flex: none;',
            '  width: 16px;',
            '  height: 16px;',
            '  background-color: currentColor;',
            '  -webkit-mask-image: url("' + maskUrl + '");',
            '  mask-image: url("' + maskUrl + '");',
            '  -webkit-mask-repeat: no-repeat;',
            '  mask-repeat: no-repeat;',
            '  -webkit-mask-position: center;',
            '  mask-position: center;',
            '  -webkit-mask-size: 16px 16px;',
            '  mask-size: 16px 16px;',
            '}'
          ].join('\n')
        }

        /**
         * 装上侧栏图标。
         *
         * @param ctx 客户端上下文（effect 的归属者）。
         * @param resolveLabel 本分区当前 label —— 与 settings.section 注册时传的是
         *   同一个 thunk，所以切语言时两边永远一致（label 变了，判据跟着变，不会认错行）。
         */
        function installSettingsNavIcon(ctx, resolveLabel) {
          if (typeof document === 'undefined') return
          ctx.effect(() => {
            const tag = document.createElement('style')
            tag.textContent = navIconCss(navIconMaskUrl())
            document.head.appendChild(tag)
            let disposed = false
            let scheduled = false
            const sync = () => {
              scheduled = false
              if (disposed) return
              const wanted = resolveLabel()
              const rows = document.querySelectorAll(NAV_ROW_SELECTOR)
              for (let i = 0; i < rows.length; i += 1) {
                const row = rows[i]
                if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, '')
                else row.removeAttribute(NAV_ICON_MARKER)
              }
            }
            // 宿主每次重绘面板（打开/关闭、切语言、内容变化）都会重建那几行，
            // 重建后我们换掉的齿轮会被 React 改回去 —— 所以必须能重新贴。
            // queueMicrotask 合批：一次交互往往连触发多轮 mutation，不必每条都扫一遍。
            const schedule = () => {
              if (scheduled || disposed) return
              scheduled = true
              queueMicrotask(sync)
            }
            sync()
            const observer = new MutationObserver(schedule)
            observer.observe(document.body, { childList: true, subtree: true, characterData: true })
            return () => {
              disposed = true
              observer.disconnect()
              const marked = document.querySelectorAll('[' + NAV_ICON_MARKER + ']')
              for (let i = 0; i < marked.length; i += 1) marked[i].removeAttribute(NAV_ICON_MARKER)
              tag.remove()
            }
          }, 'dsh-plugin-tool-management: settings nav icon')
        }

        // 调用点放在本片末尾（见上面 ⚠️ 那段）：必须在这些 const 初始化之后。
        //
        // 整段包在 try 里：侧栏图标是**纯装饰**，取不到 DOM 或宿主换了面板结构时最坏
        // 应该只是"还是那颗齿轮"，绝不能把 apply 带崩 —— 2026-10-18 那次 TDZ 就是
        // 一个装饰性功能让整个宿主 boot 失败（"entry did not activate"）。
        try {
          installSettingsNavIcon(ctx, function () { return t('nav.title') })
        } catch (e) {
          try { console.warn('[dsh-plugin-tool-management] 设置侧栏图标不可用，沿用宿主默认图标：' + errMsg(e)) } catch (e2) { /* 控制台不可用 */ }
        }
