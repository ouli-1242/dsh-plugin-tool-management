    // ── 会话作用域（0.21.2）：面板顶部那颗下拉 + 各页开关的数据源 ────────────────
    //
    // 一套面板，两层：下拉选「全局默认 / 某个会话」，各页控件跟着那一层走。
    //
    // 三条不变量（改这里之前先读）：
    //   1. **生效值 = 服务端算好的差异**。四层并值（覆盖 → 场景层 → 基线 → 全局）在
    //      服务端算一次（scope-overrides.ts + ops/scope.ts），这里只读 `effective` ——
    //      客户端不重算第二份层序。
    //   2. 会话锁只挡本会话的写，不挡全局写；场景锁只挡全局写，不挡会话写。
    //   3. 取不到当前会话 → 一律按全局（不猜、不报错）。
    //
    // 为什么状态放在模块作用域而不是各页各存一份：八个页签都要读同一份「现在编辑的是哪一层」，
    // 各存一份时切页签就会各说各话。订阅者模式与 40 片那份 token 状态同一手法。
    var SCOPE_GLOBAL = ''
    var scopeState = {
      /** 当前编辑的会话 / 工作区作用域键；`SCOPE_GLOBAL` = 全局默认那一层。 */
      sessionId: SCOPE_GLOBAL,
      /** 当前对话的会话 id（永远指向"我正在用的这个"，与 `sessionId` 不是一回事）。 */
      currentSessionId: '',
      /**
       * 当前对话在**当前模式**下的作用域键（0.21.2）：会话模式 = 会话 id；
       * 工作区模式 = 当前会话所在工作区的 `ws:` 键。下拉里标「当前」用它。
       */
      currentScopeKey: '',
      /** 隔离粒度：`global` / `session` / `workspace`（服务端 `scope-sessions-list` 带回）。 */
      mode: 'session',
      /** 下一次刷新把选中层跟到新的当前作用域键（切对话时用；只在"刚才跟的就是当前"时置位）。 */
      followCurrent: false,
      /** 下拉选项：`[{ value, label, title?, meta? }]`。第一项永远是全局。 */
      options: [],
      /** 菜单布局：全局置顶，其余按工作区/会话分组（`[{ key, label?, title?, meta?, options }]`）。 */
      groups: [],
      /** 工作区模式下的工作区行（`[{ id, title, cwd, count, sessions }]`）。 */
      workspaces: [],
      /** 已加载的**原始覆盖**（`sessionId` 那一层的）：`{ scene?, skills?, ... }`。全局层恒为空对象。 */
      overrides: {},
      /** 与全局不同的生效值（各域一张 `key → boolean` 表）——各页画勾就用它。 */
      effective: {},
      /** 本会话生效的场景（进入的 / 基线里那份 / 全局的）。 */
      scene: null,
      /** 已「退出模式」（下层换成基线 = 会话创建时的样子）。 */
      detached: false,
      /** 提示词覆盖投影（0.21.2）：`{ override: {presetId?,content?}|null, effective: string }`。 */
      prompt: { override: null, effective: '' },
      /** 全局快照（`{ scene, flags }`），画开关要用它判断"全局此刻开没开"。 */
      global: { scene: null, flags: {} },
      /** 这一层锁着没有。 */
      locked: false,
      /** 最近一次写入带回来的警告（全局被顺手动过什么），显示一次后等下次写入覆盖。 */
      warning: null,
      /**
       * 最近一次作用域写入的**失败**（0.21.2，错误统一进 ScopeBar）。
       *
       * 为什么单开一格而不是并进 `warning`：失败与"写成了但顺手改了全局"是两件事，
       * 混在一格会让"没写进去"看起来像"写进去了但要注意"。也不并进 `error` —— 那一格是
       * "读不到这一层"，会把整个下拉框标成错误。
       */
      writeError: null,
      /** 加载中 / 错误（下拉本身不因为一次失败而消失）。 */
      loading: false,
      error: null,
      /**
       * 作用域**内容**的修订号（0.21.2 复核）：每次成功重拉 +1。
       *
       * 只跟着 `sessionId` 重取的页面会漏掉"同一层里内容变了"——进 / 退场景后生效值、
       * 场景记忆、提示词生效项全变了，而 id 没变，页面就停在上一份。需要服务端投影的页面
       * 把它加进依赖。
       */
      revision: 0,
    }
    var scopeListeners = new Set()
    function scopeSnapshot() { return scopeState }
    function setScopeState(patch) {
      scopeState = Object.assign({}, scopeState, patch)
      scopeListeners.forEach(function (fn) { try { fn(scopeState) } catch (e) { /* 单个订阅者失败不影响其余 */ } })
    }
    /** 订阅（返回取消函数）。组件里配合 `React.useSyncExternalStore` 用。 */
    function subscribeScope(fn) { scopeListeners.add(fn); return function () { scopeListeners.delete(fn) } }
    /** 现在编辑的是不是会话层（而不是全局默认）。 */
    function scopeIsSession() { return scopeState.sessionId !== SCOPE_GLOBAL }
    /** 当前隔离粒度是不是工作区（0.21.2）。 */
    function scopeIsWorkspace() { return scopeState.mode === 'workspace' }
    /**
     * 当前隔离粒度是不是「全部全局」（0.21.2+）：所有对话共用一套设置，没有会话层。
     *
     * 这里读的是面板那份同步状态，只当**兜底**用 —— 权威答案是 `scope-get` 回的 `mode`。
     * 需要它的地方是"同步路径"（`/` 菜单的点击回调不能 await）：那一拍手里的缓存如果
     * 还没读到粒度，至少别把写入发往一个服务端已经不存在的会话层。
     */
    function scopeIsGlobalMode() { return scopeState.mode === 'global' }
    /** 这一层的人话主语：本会话 / 本工作区。 */
    function scopeLayerWord() {
      if (scopeState.mode === 'global') return scopeDeps.t('scope.layer.global')
      return scopeDeps.t(scopeIsWorkspace() ? 'scope.layer.workspace' : 'scope.layer.session')
    }
    /**
     * 一个「改这一层的开关」的按钮该不该置灰。
     *
     * **两把锁互不干扰**（决策 11 / 12）：场景锁（`anyLocked`，各页自己的变量）挡的是全局写入；
     * 会话锁（`scopeState.locked`）挡的是这一层。所以 `globalLocked` 只在全局层算数 ——
     * 会话层的开关写的是 `scope-set`，场景锁着时本会话照样能改自己的视图；反过来本会话
     * 锁着时全局写不写是另一件事。一把锁把另一层的按钮置灰，用户会以为"解锁才能改另一层"。
     *
     * **只给开关类控件用**：新建 / 删除 / 编辑落的是全局，仍按 `anyLocked` 判（见各页按钮）。
     */
    function scopeWriteLocked(globalLocked) {
      return scopeIsSession() ? scopeState.locked === true : globalLocked === true
    }
    /**
     * 订阅当前层（`sessionId` 那一层），页面组件用它触发重渲染。
     *
     * **为什么每页都要订阅**：页面上的开关值、列表内容、卡片边框都跟着层走。只订阅
     * `ScopeBar` 时，切层只重画那一行下拉 —— 页面本身是上一次渲染的快照，用户看到的
     * 还是上一层的数据（"切换会话没有刷新"，2026-10-19 实测）。
     */
    function useScopeLayer() {
      return React.useSyncExternalStore(subscribeScope, scopeSnapshot, scopeSnapshot)
    }
    // ── 哪些只读 op 认 `sessionId`（0.21.2）：新增页面照这张表传，别猜 ────────────────
    //
    // 只有这几条服务端会按会话投影：
    //   skill-state / skill-detail —— 项目技能根按会话 cwd 推导
    //   rules-list                —— 场景生效值与逐条记忆开关
    //   quickprompt-list          —— 快捷词 enabled
    //
    // 其余（`mcpm-list` / `subagent-list` / `agentsmd-list` …）是全局口径：会话层对它们
    // 只做**本地投影**（`scopeFlag` 判可见性），不能把 sessionId 硬塞过去 —— 服务端不认识
    // 那个参数，塞过去只是让回执里多一个没人读的字段。
    //
    // ⚠️ 两条纪律：
    //   · 写入类 op（`rules-toggle` / `skill-enable` …）**一律不在此列**：它们明确拒绝
    //     `sessionId`（会话写入只有 `scope-set` 一条路）。
    //   · **不在 `apiCall` 里统一注入**。斜杠菜单也用这几条 op，但它要的永远是"这个对话"，
    //     与面板顶部下拉选的那一层无关 —— 一处注入就会让菜单在 A 层显示 B 对话的值。
    /**
     * 某一格在这一层的值：`{ value, scoped }`。
     *
     * `value` = 这一层的**生效值**（服务端按四层算好的差异）；`scoped` = 与全局不同
     * （颜色统一为绿/灰，这个标记只留给"来源点"与统计用）。全局层恒 `scoped: false`。
     */
    function scopeFlag(domain, key, globalValue) {
      // 全局 blocked（旧版「统一关闭」留下的持久停机）压过一切会话层（与后端 `resolveResource` 同一条）：会话里的覆盖、
      // 场景勾选、逐工具 / 单条技能的推导都不能把它显成开着 —— 否则开关是绿的、模型调不到。
      // 技能还要看所在来源：来源被 blocked 时，技能级开着也加载不到。
      if (domain === 'mcp' || domain === 'skills' || domain === 'skillSources') {
        var intentState = scopeIntentOf(domain, key)
        if (intentState === 'blocked') return { value: false, scoped: false }
        // 意图比列表里那份 `globalOn` 新：写完统一关闭后列表还没重读，全局开关也该立刻翻过去。
        if (intentState === 'on') globalValue = true
        else if (intentState === 'off') globalValue = false
      }
      if (domain === 'mcpTools') {
        var mt = String(key).indexOf('/')
        if (mt > 0 && scopeIntentOf('mcp', String(key).slice(0, mt)) === 'blocked') return { value: false, scoped: false }
      }
      if (domain === 'skills') {
        var sk = String(key).indexOf('/')
        if (sk > 0 && scopeIntentOf('skillSources', String(key).slice(0, sk)) === 'blocked') return { value: false, scoped: false }
      }
      if (!scopeIsSession()) return { value: globalValue === true, scoped: false }
      var map = scopeState.effective[domain]
      var over = map && typeof map[key] === 'boolean' ? map[key] : undefined
      return over === undefined ? { value: globalValue === true, scoped: false } : { value: over, scoped: true }
    }
    // ── 全局意图 / 租约（0.21.2）────────────────────────────────────────────
    //
    // MCP 服务器与技能来源两格的全局开关**不是**补丁 / 来源状态，而是意图：
    //   on —— 全局启用；off —— 全局关闭（有会话还在用就保持运行，即租约）；
    //   blocked —— 持久停机（旧版统一关闭；压过租约与一切会话层）。
    // 界面上的全局开关读意图；"临时运行 · N 个对话"来自 `leases`，它是全局 off 却能跑的
    // 唯一解释。会话层不显示意图（那一层只回答"这个对话看不看得到"）。
    /** 某一格的全局意图：`'on' | 'off' | 'blocked' | null`（没记录 = 跟随运行态）。 */
    function scopeIntentOf(domain, key) {
      var intent = scopeState.global && scopeState.global.intent ? scopeState.global.intent[domain] : null
      var state = intent && typeof intent === 'object' ? intent[key] : undefined
      return state === 'on' || state === 'off' || state === 'blocked' ? state : null
    }
    /** 这一格有几个会话在认领（租约）。全局层才读得到；会话层返回 0。 */
    function scopeLeaseCount(domain, key) {
      if (scopeIsSession()) return 0
      var leases = scopeState.global && scopeState.global.leases ? scopeState.global.leases[domain] : null
      var n = leases && typeof leases === 'object' ? Number(leases[key]) : 0
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    }
    /** 这一域此刻有租约的键（全局层专用；会话层返回空）。「全部关闭」按它取目标集。 */
    function scopeLeaseKeys(domain) {
      if (scopeIsSession()) return []
      var leases = scopeState.global && scopeState.global.leases ? scopeState.global.leases[domain] : null
      if (!leases || typeof leases !== 'object') return []
      return Object.keys(leases).filter(function (key) { return Number(leases[key]) > 0 })
    }
    /**
     * 统一关闭成功后**就地**摘掉本地快照里的租约与意图，不等 `scope-get` 回来。
     *
     * 为什么不能改成再拉一次：服务端快照有短 TTL，紧接着的 `scope-get` 可能仍是写前的
     * 那一份 —— 徽章会先消失又冒回来；而且整层重拉会让列表按新状态重新定序，用户刚打开的
     * 几条会被顶到最前。这里只改这次操作真正碰到的那几格。
     */
    function scopeForgetLeases(domain, keys) {
      if (scopeIsSession()) return
      var global = scopeState.global
      if (!global) return
      var list = (Array.isArray(keys) ? keys : [keys]).map(function (key) { return String(key) })
      if (!list.length) return
      var patch = {}
      var leases = global.leases || {}
      var domainLeases = Object.assign({}, leases[domain] || {})
      var leasesChanged = false
      list.forEach(function (key) {
        if (domainLeases[key] !== undefined) { delete domainLeases[key]; leasesChanged = true }
      })
      if (leasesChanged) {
        var nextLeases = Object.assign({}, leases)
        nextLeases[domain] = domainLeases
        patch.leases = nextLeases
      }
      if (domain === 'mcp' || domain === 'skills' || domain === 'skillSources') {
        var intent = global.intent || {}
        var nextDomainIntent = Object.assign({}, intent[domain] || {})
        list.forEach(function (key) { nextDomainIntent[key] = 'off' })
        var nextIntent = Object.assign({}, intent)
        nextIntent[domain] = nextDomainIntent
        patch.intent = nextIntent
      }
      if (patch.leases === undefined && patch.intent === undefined) return
      setScopeState({ global: Object.assign({}, global, patch) })
    }
    /** 有多少个会话 / 工作区进入了场景（全局层专用；会话层返回 0）。传场景名只数那一个。 */
    function scopeSceneLeaseCount(sceneName) {
      if (scopeIsSession()) return 0
      var global = scopeState.global
      if (!global) return 0
      var raw = sceneName === undefined
        ? global.sceneLeases
        : (global.sceneLeaseCounts || {})[String(sceneName)]
      var n = Number(raw)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    }
    /** 统一关闭某个（或全部）场景后，就地改本地计数 —— 理由同 `scopeForgetLeases`。 */
    function scopeForgetSceneLeases(sceneName) {
      if (scopeIsSession()) return
      var global = scopeState.global
      if (!global) return
      var counts = Object.assign({}, global.sceneLeaseCounts || {})
      var total = Number(global.sceneLeases) || 0
      if (sceneName === undefined) {
        counts = {}
        total = 0
      } else {
        var key = String(sceneName)
        var n = Number(counts[key]) || 0
        if (n <= 0) return
        delete counts[key]
        total = Math.max(0, total - n)
      }
      setScopeState({ global: Object.assign({}, global, { sceneLeaseCounts: counts, sceneLeases: total }) })
    }
    /** 全局开关的**显示值**：意图优先（blocked 也是关），没记录才落到运行态。 */
    function scopeGlobalOn(domain, key, runningOn) {
      var state = scopeIntentOf(domain, key)
      if (state === 'on') return true
      if (state === 'off' || state === 'blocked') return false
      return runningOn === true
    }
    /**
     * 写全局意图（`on` / `off` / `blocked`）。**全局层专用** —— 会话层的开关走 `scope-set`，
     * 写的是租约（认领），不是全局定义。
     */
    function scopeWriteIntent(domain, keys, value) {
      if (scopeIsSession()) return Promise.resolve(scopeNoteResult({ ok: false, error: scopeT('scope.intent.globalOnly') }))
      var list = Array.isArray(keys) ? keys : [keys]
      return apiCall('scope-intent-set', { domain: domain, keys: list, value: value })
        .then(function (res) {
          scopeNoteResult(res)
          if (res && res.ok === false) return res
          return refreshScope().then(function () { return res })
        })
    }
    /** 场景单选：`{ value, scoped }`（`value` 是**生效**场景名或 null）。 */
    function scopeScene(globalScene) {
      if (!scopeIsSession()) return { value: globalScene || null, scoped: false }
      var v = scopeState.scene || null
      return { value: v, scoped: v !== (globalScene || null) }
    }
    /**
     * 重新拉一次：会话清单 + 当前层的覆盖 + 全局快照。
     *
     * 下拉列**全部未归档会话**并按工作区分组（用户 2026-10-20）；全局默认仍置顶。
     */
    /**
     * 注入的取词与"当前会话"读数（0.21.2）。
     *
     * 为什么走注入而不是直接引：`t` 与 `currentSessionId` 都定义在**更晚**的分片里
     * （40 片的 apply 作用域），本片按顺序早于它们 —— 直接引用在 `typecheck:client` 当场报红。
     * 与 `translateOrFallback` 收 `t` 为参是同一条纪律。
     */
    var scopeDeps = {
      t: function (k, p) { return k },
      currentSessionId: function () { return '' },
      /** 订阅宿主会话列表 / 工作区记账（归档 / 恢复 / 起标题后下拉要跟着变）；返回取消函数。 */
      subscribeSessionList: function (fn) { return null },
      /** 提示条（修复结果用）；缺省不弹。参数须与 `showPluginToast` 同形，供 checkJs 推断。 */
      toast: function (text, kind) {},
    }
    function configureScopeDeps(next) {
      scopeDeps = Object.assign({}, scopeDeps, next || {})
    }
    /** 取词：自动带上 `{layer}`（本会话 / 本工作区），文案不必为两种模式各写一份。 */
    function scopeT(key, params) { return scopeDeps.t(key, Object.assign({ layer: scopeLayerWord() }, params || {})) }

    /**
     * 服务端 `ok: false` 那一份的错误取成人话。
     *
     * 为什么不能直接 `errMsg(res)`：`errMsg` 只看 `.message`，而 op 的失败回执是
     * `{ ok: false, error: '…' }` —— 没有 `message`，`String(对象)` 得到 `[object Object]`，
     * 用户看到的就是「会话作用域读取失败：[object Object]」（2026-10-19 实测）。
     */
    function scopeErrorText(e) {
      if (e === null || e === undefined) return ''
      if (typeof e === 'string') return e
      if (typeof e.error === 'string' && e.error !== '') return e.error
      return errMsg(e)
    }
    /**
     * 请求代数：切层 / 写后重拉都走 `refreshScope`，两个请求可能交错 —— 先发的（旧层）
     * 晚回来会把**新层**的 `overrides` / `locked` 盖掉，屏幕上就是 B 的标题配 A 的勾与锁。
     * 每次发起自增，回来时代数对不上就整份丢弃。
     */
    var scopeRefreshSeq = 0
    /**
     * 作用域行挂载数。没有面板时 `refreshScope` 直接返回：
     * 斜杠菜单改完一条也会调它，而面板根本不在树上 —— 为看不见的面板跑一次
     * `scope-sessions-list` + `scope-get`（要扫五个域的列表）纯属白花时间，
     * 还会和菜单自己的那一拍抢读。
     */
    var scopeMounted = 0
    /**
     * 后台刷新（静默）的最小间隔。
     *
     * 会话列表在对话流式输出期间按帧通知（任何一条会话的投影更新都会让宿主重建清单），
     * 只靠下面的 400ms 去抖仍然会变成每 400ms 一次重拉 —— 而每次重拉是两条重查询
     * （`scope-sessions-list` 扫会话清单、`scope-get` 扫五个域），页面还会跟着修订号
     * 整份重取，用户看到的就是面板一直闪。清单变化只影响下拉里的标题 / 「当前」标记，
     * 2 秒的滞后看不出来。
     */
    var SCOPE_SILENT_MIN_INTERVAL_MS = 2000
    var scopeLastSilentAt = 0
    /** 会话列表变化后的合并刷新：标题 / 归档 / 恢复可能连着来，400ms 内只重拉一次。 */
    var scopeRefreshTimer = null
    function scheduleScopeRefresh() {
      if (scopeRefreshTimer !== null) return
      var wait = 400
      if (scopeLastSilentAt > 0) {
        var since = Date.now() - scopeLastSilentAt
        if (since < SCOPE_SILENT_MIN_INTERVAL_MS) wait = Math.max(wait, SCOPE_SILENT_MIN_INTERVAL_MS - since)
      }
      scopeRefreshTimer = setTimeout(function () { scopeRefreshTimer = null; refreshScope({ silent: true }) }, wait)
    }
    /** 界面上会被 `refreshScope` 改到的字段指纹（options 已含标题 / 条数 / 「当前」标记）。 */
    function scopeVisibleSig(s) {
      return JSON.stringify([
        s.mode, s.currentSessionId, s.currentScopeKey, s.workspaces, s.options, s.groups,
        s.overrides, s.effective, s.scene, s.detached, s.prompt, s.global, s.locked,
      ])
    }
    /**
     * 页面是否需要重取的指纹。
     *
     * 页面把 `revision` 当依赖（提示词 / 记忆页），而后台上拉只要写一次状态就会让修订号 +1：
     * 内容没变也重取，空列表会整块闪成「加载中」。所以修订号只在**内容真的变了**时推进。
     */
    function scopeContentSig(s) {
      return JSON.stringify([s.mode, s.overrides, s.effective, s.scene, s.detached, s.prompt, s.global, s.locked])
    }
    /**
     * @param {object} [opts] 刷新选项。
     * @param opts.silent 后台刷新：不立 loading、失败不标错误、字段全等时不写状态。
     *   只有宿主会话清单变动这类非用户动作走它；用户切层 / 写回执仍走默认（可见）路径。
     */
    function refreshScope(opts) {
      if (scopeMounted === 0) return Promise.resolve()
      var silent = !!(opts && opts.silent)
      if (silent) scopeLastSilentAt = Date.now()
      var current = ''
      try { current = (typeof scopeDeps.currentSessionId === 'function' ? scopeDeps.currentSessionId() : '') || '' } catch (e) { current = '' }
      var seq = ++scopeRefreshSeq
      if (!silent) setScopeState({ loading: true, error: null, currentSessionId: current })
      // **只按 `sessionId` 取，不拿 `current` 兜底**：全局那一层给空 sessionId，拿的是
      // 全局快照（含意图三态与租约计数），与某个会话那一层同形。用当前会话兜底会把它的
      // `overrides` 与 `locked` 灌进全局层 —— 面板顶上就会挂着「本会话已锁定」。
      // 先取列表再取层（0.21.2）：工作区模式下当前对话的层键要由服务端按 cwd 算出来，
      // 拿旧的 sessionId 直接取会落在错的层上。列表失败仍按旧口径继续（只是选项少）。
      var listCall = apiCall('scope-sessions-list', { sessionId: current }).catch(function () {
        return { ok: false, sessions: [], workspaces: [] }
      })
      return listCall.then(function (listRes) {
        if (seq !== scopeRefreshSeq) return
        var listOk = listRes && listRes.ok !== false
        var mode = listOk
          ? (listRes.mode === 'workspace' ? 'workspace' : listRes.mode === 'global' ? 'global' : 'session')
          : scopeState.mode
        var currentKey = listOk && typeof listRes.currentKey === 'string' && listRes.currentKey !== ''
          ? String(listRes.currentKey)
          : (scopeState.currentScopeKey || current)
        // 名单由服务端给：工作区成员 + 未归档 + 有消息（标题 / 条数都在同一份里）。
        var rows = ((listOk && listRes.sessions) || []).map(function (row) {
          return { id: String(row.id), title: String(row.title || row.id), cwd: String(row.cwd || ''), count: Number(row.count) || 0 }
        })
        var workspaces = ((listOk && listRes.workspaces) || []).map(function (row) {
          return {
            id: String(row.id),
            title: String(row.title || row.id),
            cwd: String(row.cwd || ''),
            count: Number(row.count) || 0,
            sessions: Number(row.sessions) || 0,
          }
        })
        // 当前作用域永远在（服务端已保证；清单读失败 / 会话刚被删掉时这里再兜一次）。
        if (currentKey !== '' && mode === 'workspace' && currentKey.indexOf('ws:') === 0 &&
          !workspaces.some(function (row) { return row.id === currentKey })) {
          workspaces.unshift({ id: currentKey, title: scopeWorkspaceNameFromKey(currentKey), cwd: currentKey.slice(3), count: 0, sessions: 1 })
        } else if (currentKey !== '' && mode === 'session' && !rows.some(function (row) { return row.id === currentKey })) {
          var known = ((listOk && listRes.sessions) || []).filter(function (row) { return String(row.id) === currentKey })[0]
          rows.push({ id: currentKey, title: (known && known.title) || currentKey.slice(0, 8), count: (known && Number(known.count)) || 0, cwd: (known && known.cwd) || '' })
        }
        // 选中层：
        //   · 切对话且刚才跟的就是当前 → 跟到新的当前层键；
        //   · 模式变了 → 回全局默认（旧键在另一套键空间里，停在上面就是一个看不见的层）；
        //   · 选中键与新模式的键空间不符（外部改了模式）→ 同样回全局。
        var modeChanged = mode !== scopeState.mode
        var selected = scopeState.sessionId
        // 全局粒度：没有可选的作用域层，选中层只能是「全局默认」（服务端已把 sessions 清空）。
        if (mode === 'global') selected = SCOPE_GLOBAL
        if (scopeState.followCurrent) selected = currentKey || selected
        else if (modeChanged) selected = SCOPE_GLOBAL
        else if (selected !== SCOPE_GLOBAL) {
          if (mode === 'workspace' && selected.indexOf('ws:') !== 0) selected = SCOPE_GLOBAL
          else if (mode === 'session' && selected.indexOf('ws:') === 0) selected = SCOPE_GLOBAL
        }
        // 选项与分组：会话模式 = 全局 + 按工作区分组的会话；工作区模式 = 全局 + 工作区 + 未归属会话。
        var globalOption = { value: SCOPE_GLOBAL, label: scopeT('scope.global') }
        var options = [globalOption]
        var groups = [{ key: 'global', options: [globalOption] }]
        if (mode === 'workspace') {
          var wsOptions = workspaces.map(function (row) { return scopeWorkspaceOption(row, currentKey) })
          var isoOptions = rows.map(function (row) { return scopeSessionOption(row, currentKey) })
          options = options.concat(wsOptions, isoOptions)
          if (wsOptions.length) {
            groups.push({
              key: 'workspaces', label: scopeT('scope.workspaces'), title: scopeT('scope.workspaces.hint'),
              meta: scopeT('scope.workspaces.count', { count: wsOptions.length }), options: wsOptions,
            })
          }
          if (isoOptions.length) groups.push({ key: 'ungrouped', label: scopeT('scope.ungrouped'), options: isoOptions })
        } else {
          rows.forEach(function (row) { options.push(scopeSessionOption(row, current)) })
          groups = groups.concat(scopeSessionGroups(rows, current))
        }
        // 选中的层不在新名单里（刚被删 / 归档 / 改名）：补一条，免得控件显示空。
        if (selected !== SCOPE_GLOBAL && !options.some(function (option) { return option.value === selected })) {
          options = options.concat([{
            value: selected,
            label: selected.indexOf('ws:') === 0 ? scopeWorkspaceNameFromKey(selected) : String(selected).slice(0, 8),
          }])
        }
        // 取数的键变了（跟着切对话 / 模式变了）→ 用新键再跑一轮，丢掉这一轮取回的旧层数据。
        if (selected !== scopeState.sessionId || scopeState.followCurrent) {
          setScopeState({
            sessionId: selected, mode: mode, currentSessionId: current, currentScopeKey: currentKey,
            followCurrent: false, workspaces: workspaces, options: options, groups: groups,
          })
          return refreshScope(opts)
        }
        return apiCall('scope-get', { sessionId: selected }).then(function (getRes) {
          // 已经有人发起了更新的一次（切了层 / 刚写完）→ 这一份是旧层的，整份丢掉。
          if (seq !== scopeRefreshSeq) return
          if (!getRes || getRes.ok === false) throw new Error(scopeErrorText(getRes))
          var next = {
            loading: false,
            error: null,
            mode: mode,
            currentSessionId: current,
            currentScopeKey: currentKey,
            workspaces: workspaces,
            options: options,
            groups: groups,
            overrides: getRes.overrides || {},
            effective: getRes.effective || {},
            scene: typeof getRes.scene === 'string' ? getRes.scene : null,
            detached: getRes.detached === true,
            prompt: getRes.prompt && typeof getRes.prompt === 'object'
              ? { override: getRes.prompt.override || null, effective: String(getRes.prompt.effective || '') }
              : { override: null, effective: '' },
            global: getRes.global || { scene: null, flags: {} },
            locked: getRes.locked === true,
          }
          var contentChanged = scopeContentSig(next) !== scopeContentSig(scopeState)
          // 后台上拉且一个字段都没变 → 不写状态。每次写都会让所有订阅页重渲染一遍，
          // 对话流式输出期间就是每帧一次（面板看着像在闪）。
          if (silent && !contentChanged && scopeVisibleSig(next) === scopeVisibleSig(scopeState) &&
            scopeState.loading !== true && scopeState.error === null) return
          next.revision = contentChanged ? (Number(scopeState.revision) || 0) + 1 : scopeState.revision
          setScopeState(next)
        })
      }).catch(function (e) {
        // 旧层的失败也不该把新层标成错误。
        if (seq !== scopeRefreshSeq) return
        // 后台上拉失败不把面板标成读不到：下一次成功会自己清掉，页面那份提示仍在。
        if (silent && scopeState.loading !== true) return
        setScopeState({ loading: false, error: errMsg(e) })
      })
    }
    /**
     * 当前对话换了（宿主切会话 / 新建 / 删除）。由 40 片那条 `sessions.list` 订阅调进来。
     *
     * 只跟**一种**情况：此刻正在看的就是「当前对话」那一层。
     *   · 停在全局默认 → 不动。面板默认就是全局（决策 1），一开面板就自己跳到某个会话，
     *     等于把所有人第一眼看到的层换掉，点下去改的是覆盖而不是全局。
     *   · 停在别的会话 → 不动。用户明确选了那个会话，切对话不该把它顶掉。
     *   · 停在上一个「当前对话」→ 跟到新的那一个（"切换会话没有刷新"，2026-10-19）。
     */
    function onCurrentSessionChanged(id) {
      var next = typeof id === 'string' ? id : ''
      var prev = scopeState.currentSessionId || ''
      if (next === prev) return
      // 会话模式：选中的就是上一个当前会话；工作区模式：选中的是上一个当前工作区。
      // 两种都算"跟着当前"，跟到新对话 / 新工作区去（而不是停在旧层）。
      var following = scopeState.sessionId !== SCOPE_GLOBAL &&
        (scopeState.sessionId === prev || (scopeState.currentScopeKey !== '' && scopeState.sessionId === scopeState.currentScopeKey))
      if (!following) {
        setScopeState({ currentSessionId: next })
        // 下拉里「当前对话」那一项 / 它的标题可能变了：重拉一次会话清单（全局层不取覆盖）。
        refreshScope({ silent: true })
        return
      }
      // 新工作区键要等服务端按 cwd 算出来 —— 置 followCurrent，refreshScope 取完列表后会
      // 把选中层换到 currentKey 并用新键重取一次，不拿旧层数据冒充新层。
      setScopeState({ currentSessionId: next, followCurrent: true, overrides: {}, effective: {}, scene: null, detached: false, locked: false, prompt: { override: null, effective: '' } })
      refreshScope({ silent: true })
    }
    /** 一行会话选项：标题进正文，覆盖条数与「当前」放行尾。 */
    function scopeSessionOption(row, current) {
      var full = String(row.title || row.id || '')
      var count = Number(row.count) || 0
      var meta = []
      if (count > 0) meta.push(scopeT('scope.items', { count: count }))
      if (row.id === current) meta.push(scopeT('scope.current'))
      return { value: row.id, label: full.slice(0, 40), title: full, meta: meta.join(' · ') }
    }
    /** 工作区显示名：目录最后一段（完整路径进组头的 title）。 */
    function scopeWorkspaceName(cwd) {
      var trimmed = String(cwd || '').replace(/[\\/]+$/, '')
      var parts = trimmed.split(/[\\/]/)
      return parts.length ? parts[parts.length - 1] : trimmed
    }
    /** 工作区键（`ws:<cwd>`）→ 显示名（键里带完整路径，去掉前缀再取末段）。 */
    function scopeWorkspaceNameFromKey(key) {
      var raw = String(key || '')
      return scopeWorkspaceName(raw.indexOf('ws:') === 0 ? raw.slice(3) : raw) || raw.slice(0, 8)
    }
    /** 一行工作区选项：目录名进正文，覆盖条数与「当前」放行尾。 */
    function scopeWorkspaceOption(row, currentKey) {
      var full = String(row.title || row.id || '')
      var meta = []
      if (row.count > 0) meta.push(scopeT('scope.items', { count: row.count }))
      if (row.sessions > 0) meta.push(scopeT('scope.sessions.count', { count: row.sessions }))
      if (row.id === currentKey) meta.push(scopeT('scope.currentWorkspace'))
      return { value: row.id, label: full.slice(0, 40), title: row.cwd || full, meta: meta.join(' · ') }
    }
    /**
     * 会话按工作区分组（用户 2026-10-20）：组头 = 工作区目录名；组内当前对话置顶，
     * 其余按覆盖条数倒序、同数按标题；组序当前工作区优先，其次按目录名，未归属最后。
     */
    function scopeSessionGroups(rows, current) {
      var groups = [], byCwd = {}
      var currentCwd = null
      rows.forEach(function (row) {
        if (row.id === current) currentCwd = String(row.cwd || '')
        var key = String(row.cwd || '')
        if (!byCwd[key]) { byCwd[key] = { cwd: key, rows: [] }; groups.push(byCwd[key]) }
        byCwd[key].rows.push(row)
      })
      groups.sort(function (a, b) {
        if (currentCwd !== null && a.cwd === currentCwd) return -1
        if (currentCwd !== null && b.cwd === currentCwd) return 1
        if (a.cwd === '') return 1
        if (b.cwd === '') return -1
        return a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0
      })
      return groups.map(function (g) {
        var items = g.rows.slice().sort(function (a, b) {
          if (a.id === current) return -1
          if (b.id === current) return 1
          var diff = (Number(b.count) || 0) - (Number(a.count) || 0)
          if (diff !== 0) return diff
          var an = String(a.title || ''), bn = String(b.title || '')
          return an < bn ? -1 : an > bn ? 1 : 0
        }).map(function (row) { return scopeSessionOption(row, current) })
        return {
          key: 'ws:' + g.cwd,
          label: g.cwd === '' ? scopeT('scope.ungrouped') : scopeWorkspaceName(g.cwd),
          title: g.cwd === '' ? undefined : g.cwd,
          meta: scopeT('scope.sessions.count', { count: items.length }),
          options: items,
        }
      })
    }
    /** 切到另一层（`value` = 会话 / 工作区作用域键或 `SCOPE_GLOBAL`）。 */
    function setScopeSession(value) {
      var next = value === undefined || value === null ? SCOPE_GLOBAL : String(value)
      if (next === scopeState.sessionId) return Promise.resolve()
      setScopeState({ sessionId: next, overrides: {}, effective: {}, scene: null, detached: false, locked: false, prompt: { override: null, effective: '' } })
      return refreshScope()
    }
    /**
     * 切换隔离粒度（0.21.2）：`session` / `workspace`。
     *
     * 切换后回到「全局默认」：旧键在另一套键空间里，停在上面会显示一个看不见的层。
     * 播种由服务端做（首次进入一侧时用另一侧覆盖最多的记录初始化，已有记录保留）；
     * 回执里的 `seeded` 只用于界面说明，不影响选中层。
     */
    function scopeSetMode(mode) {
      var next = mode === 'workspace' ? 'workspace' : mode === 'global' ? 'global' : 'session'
      if (next === scopeState.mode) return Promise.resolve({ ok: true, mode: next, seeded: 0 })
      var current = ''
      try { current = (typeof scopeDeps.currentSessionId === 'function' ? scopeDeps.currentSessionId() : '') || '' } catch (e) { current = '' }
      return apiCall('scope-mode-set', { mode: next, currentSessionId: current })
        .then(function (res) {
          scopeNoteResult(res)
          if (!res || res.ok === false) return res
          setScopeState({
            mode: next, sessionId: SCOPE_GLOBAL, followCurrent: false,
            overrides: {}, effective: {}, scene: null, detached: false, locked: false,
            prompt: { override: null, effective: '' },
          })
          return refreshScope().then(function () { return res })
        })
    }
    /**
     * 写一个布尔开关。
     *
     * **全局层走各域自己的 op**（`globalOp`），会话层走 `scope-set` —— 两条路不能合并：
     * 全局写入有五种各不相同的目标（索引 / 状态文件 / 补丁 / 快捷词 meta / 场景），
     * 而 `scope-set` 只写一个侧车。合并成一个 op 就是第五份会漂移的实现。
     *
     * @returns Promise<结果>；成功后自动重拉一次（覆盖可能被自动清除）。
     */
    function scopeWriteFlag(domain, key, value, globalOp) {
      if (!scopeIsSession()) {
        return Promise.resolve(globalOp()).then(function (res) { return scopeNoteResult(res) })
      }
      return apiCall('scope-set', { sessionId: scopeState.sessionId, domain: domain, key: key, value: value === true })
        .then(function (res) {
          scopeNoteResult(res)
          if (res && res.ok === false) return res
          return refreshScope().then(function () { return res })
        })
    }
    /**
     * 写会话级提示词覆盖（0.21.2）：`{ action: 'apply', presetId }` /
     * `{ action: 'unapply' }` / `{ action: 'edit', content }`。
     *
     * 只在会话层成立 —— 全局层的应用 / 取消应用仍走 `agentsmd-*`（那才是改全局基线）。
     * 失败进 ScopeBar 的 `writeError`，与其余作用域写入同一条出口。
     */
    function scopeWritePrompt(payload) {
      if (!scopeIsSession()) {
        return Promise.resolve({ ok: false, error: scopeT('scope.prompt.sessionOnly') })
      }
      var body = Object.assign({ sessionId: scopeState.sessionId }, payload || {})
      return apiCall('scope-prompt-set', body)
        .then(function (res) {
          scopeNoteResult(res)
          if (res && res.ok === false) return res
          return refreshScope().then(function () { return res })
        })
    }
    /**
     * 写场景。会话层：`scene` = 场景名 = **进入**；`null` = **退出模式**（回到会话创建时的
     * 样子）。全局层走 `globalOp`（真的切运行时）。
     */
    function scopeWriteScene(scene, globalOp) {
      if (!scopeIsSession()) return Promise.resolve(globalOp()).then(function (res) { return scopeNoteResult(res) })
      return apiCall('scope-set', { sessionId: scopeState.sessionId, domain: 'scene', value: scene })
        .then(function (res) {
          scopeNoteResult(res)
          if (res && res.ok === false) return res
          // 回执**不等**整层重拉（0.21.2）：`refreshScope` 要跑会话清单 + `scope-get`
          //（五个域的列表），等它落地就是用户看到的「切换场景的提醒要等很久」。
          // 作用域行在后台更新，结果条先出。
          refreshScope()
          return res
        })
    }
    /**
     * 写 op 回执的统一收口（0.21.2）：**成功带警告**与**失败**都挂到作用域条上。
     *
     * 为什么要有这一层：各页此前只挑自己认识的那几个字段（`warnings`）来显示，失败则常常
     * 各自 setResult 甚至静默 —— 于是"点了没反应"和"没写成"在界面上长得一样。
     * 这里不吞调用方的回执（返回值原样传回去），只多挂一格显示。
     *
     * @returns 入参 `res`（链式继续用）
     */
    function scopeNoteResult(res) {
      if (res && res.ok === false) {
        setScopeState({ writeError: scopeErrorText(res) || scopeT('scope.loadFailed', { error: '' }) })
        return res
      }
      var list = res && res.warnings
      var text = list && list.length ? list.join('\n') : null
      setScopeState({ warning: text, writeError: null })
      return res
    }
    /** 写回执里的**警告**（0.21.2）：进入场景 / 拨开开关时，服务端可能顺手把资源按租约拉起来。 */
    function scopeNoteWarnings(res) {
      scopeNoteResult(res)
    }
    /** 清掉那条警告（用户点掉 / 切层 / 下一次没有警告的写入）。 */
    function scopeClearWarning() {
      if (scopeState.warning !== null) setScopeState({ warning: null })
    }
    /** 清掉写入失败的说明（点掉即隐）。 */
    function scopeClearWriteError() {
      if (scopeState.writeError !== null) setScopeState({ writeError: null })
    }
    /**
     * 隔离损坏的作用域侧车（`scope-repair`）。
     *
     * 只改名、不覆盖：损坏文件留在 hub 里供事后查看，覆盖表/意图表按空表继续。
     * 调用方（ScopeBar）负责二次确认 —— 这是把用户设置退回默认的动作。
     */
    function scopeRepair() {
      return apiCall('scope-repair', {}).then(function (res) {
        if (!res || res.ok !== true) {
          scopeDeps.toast(scopeT('scope.repair.failed', { error: scopeErrorText(res) || '?' }), 'err')
          return res
        }
        var files = []
        if (res.scopeQuarantined) files.push('scope-overrides.json')
        if (res.intentQuarantined) files.push('scope-intent.json')
        scopeDeps.toast(files.length
          ? scopeT('scope.repair.done', { files: files.join(' / ') })
          : scopeT('scope.repair.none'), files.length ? 'ok' : 'warn')
        scopeClearWriteError()
        refreshScope({ silent: true })
        return res
      }).catch(function (e) {
        scopeDeps.toast(scopeT('scope.repair.failed', { error: errMsg(e) }), 'err')
        return { ok: false, error: errMsg(e) }
      })
    }
    /**
     * 锁 / 解锁**本会话**（0.21.2，决策 12）。只在会话层成立：
     * 锁冻结的是这个会话自己的覆盖写入，与场景锁（全局写）互不干扰。
     */
    function scopeSetLocked(locked) {
      if (!scopeIsSession()) {
        return Promise.resolve({ ok: false, error: scopeT('scope.lock.globalOnly') })
      }
      return apiCall('scope-lock', { sessionId: scopeState.sessionId, locked: locked === true })
        .then(function (res) {
          scopeNoteResult(res)
          if (res && res.ok === false) return res
          // 锁态先按写入值落本地：调用方紧接着要读 `scopeState.locked` 拼回执文案，
          // 而 `refreshScope` 那一趟（会话清单 + scope-get）不必挡在中间。
          setScopeState({ locked: locked === true })
          refreshScope()
          return res
        })
    }
    /**
     * 面板顶部的作用域行（0.21.2）。
     *
     * 一个下拉选层（全局默认 / 某个会话），控件随层走。当前对话永远在列表里、并标出来 ——
     * 多标签页共用同一个 `current`（宿主的 `sessions.list.current` 是全局的），不标出来的话
     * 用户会以为"当前"是这一屏的对话。
     *
     * 会话层额外给一句说明（设计里最容易被误解的地方）：改的是**看到什么**，不是运行时。
     */
    function ScopeBar(props) {
      var t = props.t
      var snap = React.useSyncExternalStore(subscribeScope, scopeSnapshot, scopeSnapshot)
      // 修复是破坏性动作：第一次点只切到「确认」，第二次才执行。
      var ra = React.useState(false)
      var repairArmed = ra[0], setRepairArmed = ra[1]
      // 错误消失（修复成功 / 用户点掉）后别让下一次错误直接落在「确认」态。
      React.useEffect(function () {
        if (!snap.writeError) setRepairArmed(false)
      }, [snap.writeError])
      // 首次挂载拉一次：面板一打开就要知道"我在哪一层"。失败不阻塞页面（下拉仍在，只是选项少）。
      // **每次挂载都拉**：设置页与侧栏入口是两个挂载点，切页签又会让页面重新挂载；
      // 只在模块作用域缓存一份的话，别处写进去的覆盖要等下一次下拉操作才看得见。
      React.useEffect(function () {
        scopeMounted += 1
        refreshScope()
        // 会话列表变了（归档 / 恢复 / 起标题 / 新建）→ 下拉内容跟着重拉，别停在旧名单上。
        var off = null
        try { off = scopeDeps.subscribeSessionList(scheduleScopeRefresh) } catch (e) { off = null }
        return function () {
          scopeMounted = Math.max(0, scopeMounted - 1)
          if (typeof off === 'function') { try { off() } catch (e) { /* ignore */ } }
        }
      }, [])
      var sessionLayer = snap.sessionId !== SCOPE_GLOBAL
      var options = snap.options && snap.options.length ? snap.options : [{ value: SCOPE_GLOBAL, label: scopeT('scope.global') }]
      var groups = snap.groups && snap.groups.length ? snap.groups : undefined
      // 当前层的会话被删掉 / 归档之后，下拉里可能已经没有它 → 补一条，免得控件显示空。
      var hasCurrent = options.some(function (o) { return o.value === snap.sessionId })
      if (!hasCurrent && sessionLayer) options = options.concat([{ value: snap.sessionId, label: scopeIsWorkspace() ? scopeWorkspaceNameFromKey(snap.sessionId) : String(snap.sessionId).slice(0, 8) }])
      return h('div', { className: 'dsm-scope-bar' }, [
        // 层标题（用户 2026-10-21）：说明这一行选的是"哪个对话 / 工作区"的设置情况。
        // 全局粒度下没有可选层，标题改成陈述事实 —— 否则这一行会读成"这里能选会话"，
        // 而实际只有一份设置（下拉里也只剩「全局」一项）。
        h('span', { key: 'label', className: 'dsm-scope-bar-label' },
          snap.mode === 'global'
            ? scopeT('scope.globalNoLayer')
            : (scopeIsWorkspace() ? scopeT('scope.currentWorkspaceSettings') : scopeT('scope.currentSettings'))),
        h(SourceSelect, {
          key: 'select',
          options: options,
          groups: groups,
          checkSelected: true,
          value: snap.sessionId,
          ariaLabel: scopeT('scope.title'),
          disabled: snap.loading === true,
          onChange: function (value) { setScopeSession(value) },
        }),
        // 锁着时**就在这一行**给解锁口（0.21.2）：解锁入口原先只在「场景」页的模式条里，
        // 停在技能 / 记忆页的用户看着一排灰开关找不到原因，只能猜着去翻页签。
        snap.locked === true
          ? h('button', {
            key: 'locked',
            type: 'button',
            className: 'dsm-btn dsm-btn-quiet dsm-scope-bar-unlock',
            title: scopeIsWorkspace() ? scopeT('scope.lock.hintWorkspace') : scopeT('scope.lock.hint'),
            onClick: function () { scopeSetLocked(false) },
          }, scopeIsWorkspace() ? scopeT('scope.lock.unlockWorkspace') : scopeT('scope.lock.unlock'))
          : null,
        snap.error ? h('span', { key: 'err', className: 'dsm-scope-bar-hint' }, scopeT('scope.loadFailed', { error: String(snap.error) })) : null,
        // 写入失败（0.21.2，错误统一进作用域条）：与下面那条警告分开 —— 一条是"没写进去"，
        // 一条是"写进去了但顺手动了全局"。两个都出现时各占一行，不互相顶掉。
        snap.writeError
          ? h('div', { key: 'writeerr', className: 'dsm-scope-bar-error', role: 'alert' }, [
            h('span', { key: 'text' }, String(snap.writeError)),
            // 损坏的侧车没有别的恢复入口：写入会一直失败。修复只隔离现场，不覆盖健康文件。
            h('button', {
              key: 'repair',
              type: 'button',
              className: 'dsm-btn dsm-btn-quiet',
              title: scopeT('scope.repair.hint'),
              onClick: function () {
                if (!repairArmed) { setRepairArmed(true); return }
                setRepairArmed(false)
                scopeRepair()
              },
            }, repairArmed ? scopeT('scope.repair.confirm') : scopeT('scope.repair.action')),
            h('button', { key: 'x', type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: function () { scopeClearWriteError() } }, scopeT('scope.warn.dismiss')),
          ])
          : null,
        // 写入回执里的警告（全局被顺手动过什么）：显示在条下方一行，点掉即隐。
        snap.warning
          ? h('div', { key: 'warn', className: 'dsm-scope-bar-warn', role: 'status' }, [
            h('span', { key: 'text' }, String(snap.warning)),
            h('button', { key: 'x', type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: function () { scopeClearWarning() } }, scopeT('scope.warn.dismiss')),
          ])
          : null,
      ])
    }
