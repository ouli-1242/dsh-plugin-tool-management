
    module.exports = {
      name: 'dsh-plugin-tool-management-client',
      // 显式注入 locale：兄弟插件提供的服务不会可靠地通过未声明的 ctx.get() 暴露；
      // 不声明时本页会退回中文兜底，导致宿主已切到 English 但「工具」和七个页签仍是中文。
      inject: ['timer', 'locale'],
      // 词典也导出：让 Node 契约测试能断言「bundle 里每个 t('键') 在两份词典里都存在」。
      // 浏览器 UI 的交互验收仍要真浏览器；这一条挡的是「界面直接显示原始键名」这类缺陷。
      dict: DICT,
      // 页面组件（契约测试用）：由 apply 末尾填充。必须在 factory 作用域先落地——
      // 写在 apply 方法体里的导出会随 apply 提前返回而静默消失（见下方注释）。
      pages: _pages,
      apply(ctx) {
        ensureCss()
        // ---------- 闭包边界纪律（07 审查五档问题：8 页共用一个闭包）----------
        // 单文件 + ModuleLoader 的形态下不再拆文件（用户 2026-09-19 裁定：内部重组、不引
        // 打包器），页面间共享只能走两条显式通道，违反即回退成「隐式闭包共享」：
        //   ① factory 模块作用域（4 空格缩进）：纯函数与常量 —— clipText / sceneLabel /
        //      sceneOfGroup / errMsg / 校验器等，不依赖 t / ctx；
        //   ② apply 作用域（8 空格缩进）：宿主接线 —— t / mt / apiCall / NS 等绑定产物。
        // 页面组件内部**不得**引用其他页面作用域的变量（sceneLabel 白屏事故的根因类），
        // 新的共享件一律按上述两档上移，经参数或显式引用传递。
        // ---------- 取词服务（必须最先绑定）----------
        // 放在 apply 开头而不是页面组件附近：设置页的导航标题（slots.inject('settings.section')）
        // 是**注册期**取值，晚绑定会让它在英文界面下永远是中文。
        var NS = 'dsh-plugin-tool-management'
        // 注册期也要跟随宿主当前语言：如果 locale 服务尚未完成注入，读取 html[lang]
        // 作为兜底，不能无条件回退中文，否则设置侧栏会固定显示「工具」。
        var initialLocale = (typeof document !== 'undefined' && document.documentElement && /^en(?:-|$)/i.test(document.documentElement.lang || '')) ? 'en' : 'zh'
        var t = function (key, params) {
          var s = (DICT[initialLocale] && DICT[initialLocale][key]) || (DICT.en && DICT.en[key]) || key
          if (params) Object.keys(params).forEach(function (k) { s = String(s).replace("{" + k + "}", params[k]) })
          return s
        }
        try {
          // 取词服务走显式注入的 locale；直接访问未声明的 `ctx.locale` 会被 cordis
          // 上下文代理拒绝（cannot get property without inject）。同时保留 ctx.get 兼容
          // 不同宿主上下文；locale 注册失败不能让 t 静默退回中文。
          var locale = (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) || ctx.locale
          if (locale && typeof locale.register === 'function') {
            try {
              locale.register(NS, DICT)
            } catch (e) {
              // apply 被重复调用时 register 会因「该 ns 已有该 locale」抛错；
              // 词典已在宿主手里，直接 bind 即可，绝不能因此退回内置兜底。
            }
            t = locale.bind(NS)
          }
        } catch (e) {
          try { console.warn('[dsh-plugin-tool-management] locale 服务不可用，界面将固定使用中文：', e) } catch (e2) { /* ignore */ }
        }

        // ── 令牌没填 ⇒ 锁住输入框（用户裁定 2026-09-19）─────────────────────────
        // 判定与理由见 20-helpers.js 的 `setTokenLock`；这里只做宿主接线：
        //   · `conversation.blocks` —— 官方口子。宿主自己的 `dsh-client-ui-model-selection`
        //     就是这么用的（`ctx.get("conversation")` → `blocks.set(sessionId, {reason})`）；
        //   · `sessions.list`       —— 当前会话的订阅源（快照里的 `current`）。
        // 两个都**不写进 inject**、一律软取：inject 是硬依赖，服务缺席时 cordis 会让整个
        // 插件不加载 —— 设置页会跟着消失，而锁只是锦上添花。取不到就什么都不做。
        // 服务是兄弟插件提供的、可能比本插件晚就绪 ⇒ **每次调用现取**（不缓存句柄），
        // 订阅另做有限次重试（见 `subscribeSessions`）。
        //
        // 锁必须挂在**当前会话**上（`set(sessionId, block)` 按会话存），所以切会话时要给新
        // 会话补挂、把旧的撤掉。
        const serviceOf = function (name) {
          try { return ctx.get(name) } catch (e) { return undefined }
        }
        const currentSessionId = function () {
          try {
            const sessions = serviceOf('sessions')
            const snap = sessions && sessions.list && sessions.list.getSnapshot()
            const id = snap && snap.current
            return typeof id === 'string' && id ? id : undefined
          } catch (e) { return undefined }
        }
        /** 给一个会话挂 / 撤锁；宿主服务不在场时返回 false（静默跳过）。 */
        const setComposerBlock = function (id, locked) {
          try {
            const conversation = serviceOf('conversation')
            const blocks = conversation && conversation.blocks
            if (!blocks || typeof blocks.set !== 'function') return false
            blocks.set(id, locked ? { reason: t('compat.token.lock.composer') } : undefined)
            return true
          } catch (e) { return false }
        }
        // 挂过锁的会话 id。解除时要把它们**全部**撤掉 —— 锁是按会话存的，切走时那一份还留着，
        // 只撤当前会话就会留下"切回去还锁着"的残留。
        const lockedIds = new Set()
        /** 把锁态应用到会话（`locked` 为假 = 撤掉所有挂过的）。 */
        const applyComposerLock = function (locked) {
          const id = currentSessionId()
          if (locked === true) {
            if (id === undefined || lockedIds.has(id)) return
            if (setComposerBlock(id, true)) lockedIds.add(id)
            return
          }
          const stale = Array.from(lockedIds)
          if (id !== undefined) stale.push(id)
          lockedIds.clear()
          for (const each of stale) setComposerBlock(each, false)
        }
        onTokenLockChange(applyComposerLock)
        // 切会话（新建 / 打开历史会话 / 会话被删）→ 给新会话补挂。`current` 没变就不动，
        // 免得每次列表刷新都重挂一遍。
        let lockedSessionId = currentSessionId()
        let sessionSubscribed = false
        const subscribeSessions = function (attempt) {
          if (sessionSubscribed) return
          try {
            const sessions = serviceOf('sessions')
            const list = sessions && sessions.list
            if (list && typeof list.subscribe === 'function') {
              sessionSubscribed = true
              list.subscribe(function () {
                const id = currentSessionId()
                if (id === lockedSessionId) return
                lockedSessionId = id
                applyComposerLock(tokenLocked)
              })
              applyComposerLock(tokenLocked)
              return
            }
          } catch (e) { /* 落到下面的重试 */ }
          // 服务晚就绪：20 × 500ms ≈ 10s 内重试，之后放弃**并留痕** —— 锁是锦上添花、不该
          // 拖累插件本身，但"订阅不上"必须能查（否则表现只是"锁没生效"，没有任何线索）。
          if (attempt >= 20) {
            try { console.warn('[dsh-plugin-tool-management] sessions 服务不可用：令牌未填时不会自动锁住输入框') } catch (e) { /* ignore */ }
            return
          }
          const timer = serviceOf('timer')
          if (timer && typeof timer.timeout === 'function') timer.timeout(function () { subscribeSessions(attempt + 1) }, 500)
        }
        subscribeSessions(0)
        // 语言切换后占位文案要跟着变：锁态没变，`setTokenLock` 不会通知；而重挂一次又会因为
        // "这个会话已经挂过"被去重挡掉 —— 所以这里单独走一遍覆盖写。
        try {
          if (locale && typeof locale.subscribe === 'function') {
            locale.subscribe(function () {
              if (tokenLocked !== true) return
              const id = currentSessionId()
              if (id === undefined || !lockedIds.has(id)) return
              setComposerBlock(id, true)
            })
          }
        } catch (e) { /* 同上 */ }
        // 初始判定：走 apiCall，会先完成令牌引导（那时才知道本次 bootId、以及本地存的那串
        // 还算不算数），再带着令牌问一次 —— 只有这样才能拿到可信的 `accepted`。
        // 失败一律**不锁**：判不出来时不该挡着用户干活。
        apiCall('token-status', {}).then(function (r) {
          if (r && r.ok) setTokenLock(r.active === true && r.accepted !== true)
        }).catch(function () { /* 判不出来 → 不锁 */ })

        const slots = ctx.get('slots')
        if (slots === undefined) return

        /** MCP 页的本地取词：模块作用域的 t 在 apply 里被 locale 覆盖，这里每次取值都用最新的那个。 */
        const mt = (key, params) => t(key, params)
        /** MCP 保存后统一的操作反馈：成功 / 成功但有 loader 告警 / 失败。 */
        const opMsg = (res) => (
          res && res.warning
            ? { kind: 'warn', text: mt('mcp.msg.warn', { warning: res.warning }) }
            : { kind: 'ok', text: mt('mcp.msg.ok') }
        )
        const emptyForm = () => ({ serverName: '', transport: 'streamable-http', url: '', command: '', args: '', headers: '', env: '', level: 'global' })
        const kvToLines = (obj) => (obj ? Object.keys(obj).map((k) => k + '=' + obj[k]).join('\n') : '')
        // 级别筛选选项：必须在**渲染时**取词。原来写成模块级常量，apply() 早于 locale
        // 注册，导致英文界面下这四项永远显示中文（且再也翻不过来）。
        const mcpLevelOptions = () => [
          { value: '', label: mt('mcp.level.all') },
          { value: 'global', label: mt('mcp.level.global') },
          { value: 'project', label: mt('mcp.level.project') },
          { value: 'loader', label: mt('mcp.level.loader') },
        ]
        const MCP_TRANSPORT_OPTIONS = [
          { value: 'streamable-http', label: 'streamable-http' },
          { value: 'stdio', label: 'stdio' },
        ]
        // 界面侧**不再打码**（原来这里有个 maskSecret：保留前 4 个字符 + `****`）。
        // 打码的唯一出处是宿主（`src/mcp/secret-guard.ts` / `maskSecretValue`）：列表视图走
        // `mcpm-list` 拿到的已经是打码值，明文视图走 `mcpm-reveal` 拿到的是真值，两边都
        // 不需要客户端再加工一次。删掉它同时修好两个毛病：
        //   ① 双重打码 —— 宿主给的是 `••••••`，客户端再切前 4 位，详情里显示成 `••••****`；
        //   ② 「显示密钥」解锁后**仍然看不到明文** —— 因为客户端无条件又打了一次码。
        // 另外「打码值不得入库」的判据也要求字形**唯一**：宿主的 `isMaskedValue` 只认
        // 「整串都是 `•`」，客户端再引入 `****` 会让那个判据失效。

        // 顶部栏右端：GitHub 链接（issues 在仓库）+ 版本号（全界面唯一显示处）。