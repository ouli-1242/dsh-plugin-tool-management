
    module.exports = {
      name: 'dsh-plugin-tool-management-client',
      // 显式注入 locale / sessions：兄弟插件提供的服务不会可靠地通过未声明的 ctx.get()
      // 暴露 —— 不声明 locale 时本页会退回中文兜底（宿主已切到 English 但「工具」与七个
      // 页签仍是中文）；不声明 sessions 时拿不到当前会话 id，令牌未填时的输入框锁定会
      // **静默失效**（用户 2026-09-19 报的就是这个）。宿主自己的插件 —— ui-reference /
      // ui-commands / ui-workspace / ui-model-selection —— 也都把 sessions 写进 inject。
      // 两者都是 web 客户端的常驻服务（api-session-controller / client-locale），
      // 缺席就等于整个会话 UI 不成立，所以这里当硬依赖是安全的。
      inject: ['timer', 'locale', 'sessions'],
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
        /**
         * `conversation` 服务的两次读：先严格读，再**非严格**读。
         *
         * cordis 的 `ctx.get(name, strict = true)` 在「服务已注册、但提供方 fiber 还没进
         * active」时返回空 —— 而本插件比 `dsh-client-ui-conversation` 晚加载，首次探测
         * 恰好撞在这个窗口里就会一直拿不到（2026-09-19 真机实测：控制台反复报
         * 「宿主 conversation.blocks 不可用」，而 `ctx.get('sessions')` 同时是好的）。
         * 非严格读不判 fiber 状态，注册了就给 —— 它只是个注册表，写入不需要提供方 active。
         */
        const conversationService = function () {
          const strict = serviceOf('conversation')
          if (strict) return strict
          try { return ctx.get('conversation', false) } catch (e) { return undefined }
        }
        // 诊断：锁"该生效却没生效"必须留下线索 —— 否则表现只是"锁没生效"，没有任何可查的
        // 东西（用户 2026-09-19 报的就是这个）。同一条原因只报一次，避免轮询刷屏。
        let lockDiag = ''
        const diagLock = function (reason) {
          if (lockDiag === reason) return
          lockDiag = reason
          try { console.warn('[dsh-plugin-tool-management] 输入框锁定未生效：' + reason) } catch (e) { /* ignore */ }
        }
        /**
         * 当前会话 id。
         *
         * 两个来源都试：`list.current` 是列表快照里的当前项（正常路径）；
         * `selection.sessionId` 是持久化的"上次打开的会话"，列表还没 projection 完时它已经有了。
         * 宿主自己的插件都用前者，多这一条兜底是因为我们可能在会话刚建立、列表尚未刷新时挂锁。
         */
        const currentSessionId = function () {
          try {
            const sessions = serviceOf('sessions')
            if (!sessions) return undefined
            const snap = sessions.list && sessions.list.getSnapshot()
            const fromList = snap && snap.current
            if (typeof fromList === 'string' && fromList) return fromList
            const sel = sessions.selection && sessions.selection.getSnapshot()
            const fromSel = sel && sel.sessionId
            return typeof fromSel === 'string' && fromSel ? fromSel : undefined
          } catch (e) { return undefined }
        }
        /**
         * 一次性「服务点名」：锁挂不上时把几个关键服务在**本插件上下文里**的可见性一起写出来。
         * 只报「拿不到 conversation」查不出原因 —— 到底是所有服务都看不见（跨 cordis 实例），
         * 还是只有它看不见（提供方 fiber 没起来），这两种要修的地方完全不同。
         */
        let censusDone = false
        const serviceCensus = function () {
          if (censusDone) return ''
          censusDone = true
          const names = ['conversation', 'sessions', 'slots', 'locale', 'timer']
          const out = []
          for (const n of names) {
            let strict = 'err'
            let loose = 'err'
            try { strict = typeof ctx.get(n) } catch (e) { strict = 'throw' }
            try { loose = typeof ctx.get(n, false) } catch (e) { loose = 'throw' }
            out.push(n + '=' + strict + '/' + loose)
          }
          // 注册表点名：`ctx.reflect.store` 是所有服务实况，能一次看清「有没有 conversation」
          // 以及它注册在哪个 fiber 上（key 是 isolate 标签，不同 key = 不同隔离域）。
          let store = ''
          try {
            const s = ctx.reflect && ctx.reflect.store
            // 服务是按 **Symbol(isolate 标签)** 存的，`Object.keys` 一律返回空 —— 必须走
            // `getOwnPropertySymbols`，否则会得出"注册表是空的"这个假结论（第一版诊断就栽在这）。
            const syms = s ? Object.getOwnPropertySymbols(s) : []
            const all = syms.map(function (k) { return (s[k] && s[k].name) || '?' })
            store = '；服务注册表共 ' + all.length + ' 项，含 conversation：' + (all.indexOf('conversation') >= 0 ? '是' : '否')
          } catch (e) { store = '；注册表读不到：' + errMsg(e) }
          return '；服务点名（严格/非严格）' + out.join('，') + store
        }
        /**
         * 说清 `conversation` 到底怎么了。只写「不可用」查不出原因 —— 而"锁没生效"这件事
         * 恰恰最需要线索（用户以为保护开着）。所以把服务在不在、能看见哪些属性一起写出来。
         */
        const describeConversation = function (conversation) {
          if (conversation === undefined || conversation === null) return 'ctx.get 拿不到 conversation 服务' + serviceCensus()
          let keys = []
          try { keys = Object.keys(conversation) } catch (e) { /* 代理不给枚举 */ }
          return '服务在但 blocks 缺失（可见属性：' + (keys.length ? keys.join(' / ') : '无') + '）'
        }
        /** 给一个会话挂 / 撤锁；宿主服务不在场时返回 false，并留下诊断。 */
        const setComposerBlock = function (id, locked) {
          const conversation = conversationService()
          const blocks = conversation && conversation.blocks
          if (!blocks || typeof blocks.set !== 'function') {
            // **只在"挂"的方向报警**。撤锁是"尽力清掉残留"：清不掉没有任何用户可见后果，
            // 而每次加载都会走一遍撤锁（`applyComposerLock(false)` 会把当前会话一起带上），
            // 于是"令牌根本没开"的常态也刷一条「锁定未生效」—— 假故障把真故障淹没
            // （2026-09-19 实测：这一条一度让人以为锁在令牌关闭时也在失败）。
            if (locked === true) diagLock('宿主 conversation.blocks 不可用：' + describeConversation(conversation))
            return false
          }
          try {
            blocks.set(id, locked ? { reason: t('compat.token.lock.composer') } : undefined)
          } catch (e) { diagLock('写入抛错：' + errMsg(e)); return false }
          // 读回验证：宿主 registry 的 set 在 reason 相同时会直接 return（不写），也可能因
          // 内部状态没就绪而静默失败。读回一次能区分"真挂上了"与"调了但没生效"。
          if (locked === true && typeof blocks.storeFor === 'function') {
            const back = blocks.storeFor(id).getSnapshot()
            if (!back || !back.reason) { diagLock('宿主未接受本次写入（读回为空）'); return false }
          }
          lockDiag = ''
          return true
        }
        // 挂过锁的会话 id。解除时要把它们**全部**撤掉 —— 锁是按会话存的，切走时那一份还留着，
        // 只撤当前会话就会留下"切回去还锁着"的残留。
        const lockedIds = new Set()
        /**
         * 挂不上就**持续重试**，而不是试一次就认命。
         *
         * 两种会自己好起来的失败：① 提供方 fiber 还没 active（见 `conversationService`）；
         * ② 本插件比 ui-conversation 先应用。原先只探一次，撞上这两种就永久失效，而表现只是
         * "锁没生效"—— 用户以为保护开着，实际没有（2026-09-19 真机实测）。
         * 每秒一次；真挂上（或锁被撤）就自己停，不留常驻定时器。
         */
        let lockRetryStop = null
        const stopLockRetry = function () {
          if (!lockRetryStop) return
          try { lockRetryStop() } catch (e) { /* 停不掉不影响判定 */ }
          lockRetryStop = null
        }
        const startLockRetry = function () {
          if (lockRetryStop) return
          try {
            lockRetryStop = ctx.interval(function () {
              if (tokenLocked !== true) { stopLockRetry(); return }
              const id = currentSessionId()
              if (id !== undefined && lockedIds.has(id)) { stopLockRetry(); return }
              applyComposerLock(true)
            }, 1000)
          } catch (e) { diagLock('定时器不可用，无法重试：' + errMsg(e)) }
        }
        /** 把锁态应用到会话（`locked` 为假 = 撤掉所有挂过的）。 */
        const applyComposerLock = function (locked) {
          const id = currentSessionId()
          if (locked === true) {
            if (id === undefined) { diagLock('拿不到当前会话 id（sessions 服务未就绪）'); startLockRetry(); return }
            if (lockedIds.has(id)) return
            if (setComposerBlock(id, true)) lockedIds.add(id)
            else startLockRetry()
            return
          }
          stopLockRetry()
          const stale = Array.from(lockedIds)
          if (id !== undefined) stale.push(id)
          lockedIds.clear()
          for (const each of stale) setComposerBlock(each, false)
        }
        /**
         * 令牌没验过时的**页面级横幅**（唯一能说清"为什么发不出消息"的东西）。
         *
         * 宿主侧的落实是 `agent/pre-step` 直接 reject（见 context-inject.ts 的 tokenGateActive），
         * 而宿主的 blocked 态**在界面上没有任何呈现**，被认领的那条消息还会被丢弃（宿主文档
         * 原文："the pre-step rejection that produced it discarded the claimed messages"）。
         * 没有这条横幅，用户看到的就是"消息没了，也没有任何解释"。
         *
         * 出口写在文案里：解铃在「设置 → 工具 → 兼容」的访问令牌框 —— 那条路全是只读 op，
         * 令牌没验过照样打得开（见 request-gate.ts 的白名单）。
         */
        let tokenBanner = null
        // 文本节点单独用闭包变量持有，不挂在 DOM 节点上（`tokenBanner._text` 是把节点当
        // 储物格，客户端唯一的类型检查会报 TS2339）。横幅只创建一次、从不复位，两者同生命周期。
        let tokenBannerText = null
        // 手动关闭标记：横幅固定在视口顶部，会盖在宿主设置窗口的标题区上 —— 给一个出口，
        // 关掉后本次锁态期间不再出现；解锁（locked 变 false）即重置，下次再锁照常出现。
        // 输入框上的锁与行内说明不受影响，信息不丢。
        let tokenBannerDismissed = false
        const syncTokenBanner = function (locked) {
          try {
            if (typeof document === 'undefined' || !document.body) return
            if (locked !== true) {
              tokenBannerDismissed = false
              if (tokenBanner) tokenBanner.style.display = 'none'
              return
            }
            if (!tokenBanner) {
              tokenBanner = document.createElement('div')
              tokenBanner.className = 'dsm-token-banner'
              tokenBanner.setAttribute('role', 'status')
              // 文案与关闭键分开挂：下面语言切换是往文本节点整体覆写，textContent 写在
              // 根节点上会把关闭键抹掉。
              tokenBannerText = document.createElement('span')
              tokenBannerText.className = 'dsm-token-banner-text'
              tokenBanner.appendChild(tokenBannerText)
              const bannerClose = document.createElement('button')
              bannerClose.type = 'button'
              bannerClose.className = 'dsm-token-banner-close'
              bannerClose.setAttribute('aria-label', t('btn.close'))
              bannerClose.textContent = '×'
              bannerClose.addEventListener('click', function () {
                tokenBannerDismissed = true
                if (tokenBanner) tokenBanner.style.display = 'none'
              })
              tokenBanner.appendChild(bannerClose)
              document.body.appendChild(tokenBanner)
            }
            // 语言切换后文案要跟着变（锁态没变、setTokenLock 不会通知，见下面的 locale 订阅）。
            tokenBannerText.textContent = t('compat.token.banner')
            tokenBanner.style.display = tokenBannerDismissed ? 'none' : ''
          } catch (e) { /* DOM 不可用 → 只是少一条说明，不影响门禁本身 */ }
        }
        onTokenLockChange(function (locked) {
          applyComposerLock(locked)
          syncTokenBanner(locked)
        })
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
          if (attempt >= 20) { diagLock('sessions 服务 10s 内没等到'); return }
          const timer = serviceOf('timer')
          if (timer && typeof timer.timeout === 'function') timer.timeout(function () { subscribeSessions(attempt + 1) }, 500)
        }
        subscribeSessions(0)
        // 语言切换后占位文案要跟着变：锁态没变，`setTokenLock` 不会通知；而重挂一次又会因为
        // "这个会话已经挂过"被去重挡掉 —— 所以这里单独走一遍覆盖写。
        try {
          if (locale && typeof locale.subscribe === 'function') {
            locale.subscribe(function () {
              // 横幅文案与占位文案都要跟着换语言；锁态没变时 `setTokenLock` 不会通知。
              syncTokenBanner(tokenLocked)
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
        // 失败**重试几次**再放弃：apply 跑得很早，插件自己的路由可能还没就绪；一次失败
        // 就永久不锁是"静默失效"，而这正是用户 2026-09-19 报的现象。
        const probeTokenLock = function (attempt) {
          const again = function () {
            if (attempt >= 5) { diagLock('token-status 连续失败，无法判定是否该锁'); return }
            const timer = serviceOf('timer')
            if (timer && typeof timer.timeout === 'function') timer.timeout(function () { probeTokenLock(attempt + 1) }, 1000)
          }
          apiCall('token-status', {}).then(function (r) {
            if (r && r.ok) setTokenLock(r.active === true && r.accepted !== true)
            else again()
          }).catch(again)
        }
        probeTokenLock(0)

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