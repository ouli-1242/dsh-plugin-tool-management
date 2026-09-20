
    /** 统一的异常文案：Error 取 message，其余（字符串/对象/null）原样 String。此前 63 处各写一遍。 */
    function errMsg(e) { return e && e.message ? String(e.message) : String(e) }

    function ensureCss() {
      if (typeof document === 'undefined') return
      const id = 'dsh-plugin-tool-management'
      if (document.querySelector('style[data-plugin-css="' + id + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = id
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * 「两种状态文案 + 定宽」的按钮内容：两份文案都渲染、叠在同一格，隐身那份只负责占位
     * （配合 `.dsm-btn.dsm-btn-bulk` 的两段类名选择器）—— 按钮宽度恒等于较宽的那个文案，
     * 状态切换时按钮不跳宽、整行也不重排。「全选 ↔ 取消全选」与「刷新 ↔ 刷新中…」共用这一套。
     * 不写死像素宽度是有意的：中文「取消全选 / 刷新中…」与英文各自自适应，加语言不用改样式。
     */
    function fixedLabelPair(label, other) {
      return [
        React.createElement('span', { key: 'v', className: 'dsm-bulk-label' }, label),
        React.createElement('span', { key: 'g', className: 'dsm-bulk-ghost', 'aria-hidden': 'true' }, other),
      ]
    }

    /**
     * 垃圾桶图标：给「移除来源」这类破坏性操作做纯图标按钮用（按钮本身必须带 title /
     * aria-label —— 图标按钮没有可见文字，说明只能靠它们，别省）。
     */
    function TrashIcon(props) {
      var size = (props && props.size) || 14
      return React.createElement('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', { fill: 'currentColor', d: 'M6.5 1h3l.5 1h3v1.5H3V2h3zM4 5h8l-.6 9.2a1 1 0 0 1-1 .8H5.6a1 1 0 0 1-1-.8z' }))
    }

    /**
     * 回形针图标：bundle 记忆的「N 个附件」标签用（表示"随记忆一起存放的文件"）。
     * 只有一并带文字时才用它 —— 纯图标按钮的说明必须写在 title / aria-label 里。
     */
    function PaperclipIcon(props) {
      var size = (props && props.size) || 11
      return React.createElement('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', { d: 'M9.6 4.2 5.1 8.7a1.9 1.9 0 0 0 2.7 2.7l5-5a3.4 3.4 0 0 0-4.8-4.8L3 6.6a4.9 4.9 0 0 0 6.9 6.9l4.1-4.1' }))
    }

    /* ── 弹窗键盘行为（Modal 与兼容页的手工弹窗共用）──────────────────────────────
       放在**模块作用域**而不是 `apply` 里：兼容页（CompatPage）在 apply 之外，它的
       「清理旧备份」弹窗不能引用 apply 内的任何东西（引用了就是渲染期 ReferenceError、
       整个设置面板白屏，2026-09-19 真踩过）。这三个函数只吃参数与 document，没有闭包
       依赖，挪出来对 `Modal` 毫无影响。 */
    function modalFocusable(modal) { return Array.prototype.slice.call(modal.querySelectorAll("button:not(:disabled), [href], input:not([type=hidden]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex=\"-1\"])") || []); }
    function trapModalFocus(modal, event) { if (event.key !== "Tab") return; var focusable = modalFocusable(modal); if (!focusable.length) return; var active = document.activeElement; if (!modal.contains(active) || (event.shiftKey ? active === focusable[0] : active === focusable[focusable.length - 1])) { event.preventDefault(); (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus(); } }
    function handleModalEscape(event, onClose) { if (event.key !== "Escape") return false; event.preventDefault(); event.stopPropagation(); if (event.nativeEvent && typeof event.nativeEvent.stopImmediatePropagation === "function") event.nativeEvent.stopImmediatePropagation(); onClose(); return true; }

    /**
     * 刷新按钮（全站八处管理页共用：MCP / 技能 / 提示词 / 会话 / 场景 / 子智能体 / 记忆 / 兼容）。
     * 宽度同样按两种文案里更宽的那个固定（见 fixedLabelPair），所以点一下「刷新」不会因为
     * 文案变成「刷新中…」把整行挤走。
     *
     * @param tFn  取词函数 —— MCP 页传 `mt`（模块作用域的 t 会被宿主 locale 覆盖），其余页传各自的 t
     * @param busy 是否正在刷新：决定显示哪份文案（通常也同时决定 disabled）
     * @param args 透传给 <button> 的其余属性（className / disabled / onClick / title …）
     */
    function refreshButton(tFn, busy, args) {
      var idle = tFn('btn.refresh')
      var working = tFn('btn.refreshing')
      // 定宽靠 `.dsm-btn.dsm-btn-bulk`（两段类名，见 CSS 里的注释）—— 由这里统一补上，
      // 调用方只管自己的样式，不用记这个类。
      var cls = ((args && args.className) || 'dsm-btn dsm-btn-secondary') + ' dsm-btn-bulk'
      return React.createElement('button', Object.assign({ type: 'button' }, args, { className: cls }),
        fixedLabelPair(busy ? working : idle, busy ? idle : working))
    }

    // ── 访问令牌（用户裁定 2026-09-18）────────────────────────────────────────────
    // 三条要求：① 宿主没配时能在面板里设置；② 已配时，填对令牌就能关掉整个令牌功能；
    // ③ **填一次只管本次进程** —— DSH 退出再启动就要重填。
    //
    // ③ 靠"和宿主本次启动的标识绑定"实现：宿主在 `token-status` 里回 `bootId`（pid + 进程
    // 启动时刻，同一进程内恒定），这里把填过的令牌连同当时的 bootId 一起存；启动引导时
    // 读到的 bootId 变了，就把存的那份**丢掉并要求重填**。
    //
    // 为什么不用 sessionStorage：它的生命周期跟**浏览器标签页**走，而要求是跟**DSH 进程**走 ——
    // 同一个标签页里重启 DSH 会错误地免填，关掉标签页重开又会在同一次运行里错误地要求重填。
    //
    // legacy 键（'dsh-plugin-tool-management-token' / 'dsh-skill-mcp-manager-token'）里存的是
    // 裸令牌、没有 bootId，无法判断它属于哪次启动 —— 按"过期"处理并删除。这正是 ③ 要的语义：
    // 升级后第一次启动需要重填一次，此后每次启动都要重填。
    const TOKEN_RECORD_KEY = 'dsh-plugin-tool-management-token-record'
    const LEGACY_TOKEN_KEYS = ['dsh-plugin-tool-management-token', 'dsh-skill-mcp-manager-token']
    let TOKEN = ''
    /** 引导（读 bootId、决定要不要恢复已填的令牌）只做一次。 */
    let tokenBootstrap = null

    function readStoredToken() {
      try {
        const raw = window.localStorage.getItem(TOKEN_RECORD_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.token !== 'string' || typeof parsed.bootId !== 'string') return null
        return parsed
      } catch (e) { return null }
    }

    function writeStoredToken(bootId, token) {
      try {
        if (token && bootId) window.localStorage.setItem(TOKEN_RECORD_KEY, JSON.stringify({ bootId, token }))
        else window.localStorage.removeItem(TOKEN_RECORD_KEY)
        for (const legacy of LEGACY_TOKEN_KEYS) window.localStorage.removeItem(legacy)
      } catch (e) { /* storage unavailable */ }
    }

    // 跨标签页联动（storage 事件只在**其它**标签页触发，正好）：A 标签页「清除令牌」之后，
    // B 标签页内存里那串还揣着 —— 它的轮询请求会一直带着旧令牌的请求头，把宿主侧刚用
    // token-unaccept 重新挂上的闩又置回去。所以记录一被删，本页内存令牌立即作废；
    // 这页的输入框锁要等下一次 token-status 判定才会跟上，期间宿主侧门禁兜底。
    try {
      window.addEventListener('storage', function (ev) {
        if (ev.key !== TOKEN_RECORD_KEY || !TOKEN) return
        if (readStoredToken() === null) { TOKEN = ''; clearTokenGate() }
      })
    } catch (e) { /* storage 不可用（极端环境）→ 只是少了跨标签联动 */ }

    /** 当前进程的标识；引导之前是空串（此时不会拿它去匹配任何东西）。 */
    let BOOT_ID = ''

    function setAccessToken(value, bootId) {
      TOKEN = String(value || '').trim()
      writeStoredToken(bootId === undefined ? BOOT_ID : bootId, TOKEN)
      // 用户刚提交了令牌（或清掉）→ 把"令牌没过"的提示收起来。填错了的话，下一次被拒
      // 会立刻重新出现 —— 提示的存续规则是"用户动作能改它，别的都不能"。
      clearTokenGate()
      return TOKEN
    }

    // ── 令牌没填 ⇒ 锁住输入框（用户裁定 2026-09-19）───────────────────────────
    // 口径：本次进程里令牌**在生效**（`active`）且本机这串**没验过**（`!accepted`）。
    // 关掉保护时 `active` 为 false ⇒ 不锁 —— 与写门禁同一口径（见 request-gate.ts）。
    //
    // 为什么这件事得由客户端做：对话走 DSH 自己的 agent / session 通路，而插件的令牌门禁
    // 挂在 `/dsh-plugin-tool-management/api` 上 —— 两条路互不相干，令牌配了、没填，对话
    // 照样通、五域注入照样进上下文。宿主在客户端留了官方口子：`ctx.conversation.blocks`
    // （ComposerBlocks 的注释原文是 "the one way another plugin stops a session's input"），
    // 挂上去的 `reason` 直接当输入框占位文案。
    //
    // 状态放 factory 作用域而不是 apply 里：兼容页的 `applyTokenState` 也要能更新它 ——
    // 用户填对令牌之后锁必须立刻解除，而那条路径在 CompatPage 组件里。
    let tokenLocked = false
    let tokenLockListener = null
    /**
     * 设定锁态。值没变就不通知 —— `token-status` 会被反复拉取（进兼容页、每次提交令牌），
     * 重复通知等于反复给输入框挂/撤锁。
     * @param locked 是否应当锁住输入框。
     */
    function setTokenLock(locked) {
      const next = locked === true
      if (next === tokenLocked) return
      tokenLocked = next
      if (tokenLockListener) { try { tokenLockListener(next) } catch (e) { /* 界面接线失败不影响判定本身 */ } }
    }
    /**
     * 注册锁态监听（apply 侧挂一次）。
     *
     * 注册时**立刻回调一次当前值**：apply 先注册、`token-status` 后回来，但顺序反过来时
     * （apply 重跑）也得把当前锁态补上。只留一个槽位：apply 可能被重跑，数组会积压监听。
     * @param fn 收到锁态的回调。
     */
    function onTokenLockChange(fn) {
      tokenLockListener = fn
      try { fn(tokenLocked) } catch (e) { /* 同上 */ }
    }

    /**
     * 启动引导：问一次宿主本次的 bootId，据此决定"已填的令牌还算不算数"。
     * 必须**先于**任何带令牌的请求完成 —— 否则会把上一次启动的令牌当成本次的发出去，
     * 那等于每次启动都不用重填（与要求 ③ 相反）。所以 apiCall 会等它。
     */
    function ensureTokenBootstrapped() {
      if (tokenBootstrap) return tokenBootstrap
      tokenBootstrap = (function () {
        const stored = readStoredToken()
        // 旧键一律清掉：没有 bootId 就无从判断归属，留着只会让"重启要重填"失效。
        try { for (const legacy of LEGACY_TOKEN_KEYS) window.localStorage.removeItem(legacy) } catch (e) { /* ignore */ }
        return apiCall('token-status', {}, true).then(function (r) {
          BOOT_ID = (r && r.ok && r.bootId) ? String(r.bootId) : ''
          if (stored && BOOT_ID && stored.bootId === BOOT_ID) TOKEN = stored.token
          else if (stored) { TOKEN = ''; writeStoredToken('', '') }
        }).catch(function () { TOKEN = '' })
      })()
      return tokenBootstrap
    }

    /**
     * 发一个请求。
     *
     * @param op   宿主 op 名。
     * @param args 参数。
     * @param skipBootstrap 仅供引导自身使用（引导要发的正是 token-status，等自己会死锁）。
     */
    function apiCall(op, args, skipBootstrap) {
      const send = function () {
        // `x-dsh-plugin` is the cross-site (CSRF) gate header the host half
        // requires on every request; a cross-origin page cannot attach it
        // without a CORS preflight that this route never answers.
        const headers = { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-plugin-tool-management' }
        if (TOKEN) headers['x-dsh-token'] = TOKEN
        return fetch('/dsh-plugin-tool-management/api', {
          method: 'POST',
          headers,
          body: JSON.stringify({ op, args: args || {} }),
        }).then((r) => r.json()).then((payload) => {
          // 令牌没过 → 记到那份与页面/弹窗无关的状态里。**在这里记**（而不是各页面各记一遍）
          // 是唯一能保证"无论哪个入口、无论弹窗盖没盖住页面，提示都出得来"的做法：
          // 每个调用点都记 = 必然有地方漏（2026-09-19 实测漏了十来个弹窗）。
          if (payload && payload.ok === false && isTokenGateText(payload.error)) publishTokenGate(payload.error)
          return payload
        }).catch((e) => ({ ok: false, error: errMsg(e) }))
      }
      return skipBootstrap ? send() : ensureTokenBootstrapped().then(send)
    }

    // ── 「令牌没过」的识别与跳转（用户裁定 2026-09-18）─────────────────────────
    // 要求：这类提醒**文案只有一套**，且每个提醒右侧都要有一个直接跳到填令牌处的按钮。
    //
    // 文案同源已经做到了（宿主侧只有 http-fence.ts 里那两句，界面词典与它们逐字相同），
    // 所以这里按**文本相等**识别是可靠的 —— 而不是去猜关键词（"缺少/未配置"这类词一旦
    // 出现在别的提示里就会误挂按钮）。
    // 列表里同时保留历史文案：宿主没重启时旧句子还会出现，那时按钮也该出来。
    // 例外是「被套进 `error.action` 模板」的形态 —— 见下面的 unwrapActionText。
    //
    // ⚠️ 惰性求值不是多余的：`DICT` 声明在本文件靠后的位置，在模块求值阶段读它会命中
    // const 的 TDZ 而直接抛错（整个客户端加载失败）。只在真要判定时取一次即可。
    let tokenGateTexts = null
    function tokenGateTextsOf() {
      if (tokenGateTexts) return tokenGateTexts
      const out = []
      for (const locale of ['zh', 'en']) {
        const dict = DICT[locale] || {}
        for (const key of ['error.token.required', 'error.secret.noToken', 'error.secret.badToken']) {
          if (dict[key]) out.push(dict[key])
        }
      }
      tokenGateTexts = out.concat([
        // 宿主上两版说过的话：宿主没重启时它还在发这些句子，那时提示与按钮同样必须出来
        // （否则「令牌没过」会被当成一条普通错误，没有跳转按钮 —— 而这正是本次要修的毛病）。
        '缺少或错误的访问令牌（x-dsh-token）：请到「工具 → 兼容」页的「访问令牌」填写与宿主配置相同的值。',
        '宿主未配置访问令牌，明文查看已关闭：请到「工具 → 兼容」页的「访问令牌」填写（还没设置就点「设为宿主密钥」写入配置，重启 DSH 后生效）。',
        // 更早的版本：
        '缺少或错误的访问令牌（x-dsh-token）',
        '缺少或错误的访问令牌（x-dsh-token）：请在「工具 → 兼容」页的「访问令牌」里填入与宿主配置相同的值',
        '访问令牌缺失或不正确：请在界面里填入与宿主配置相同的令牌（随请求以 x-dsh-token 发出）。',
        '明文查看与导出已被禁用：宿主未配置访问令牌。请在本插件配置里加 token（或设环境变量 DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）后重启 DSH，再在界面上填入同一个令牌。',
      ])
      return tokenGateTexts
    }

    /**
     * `error.action` 的模板拆解（"操作失败：{error}" / "Action failed: {error}"）。
     *
     * 很多调用点会把宿主原话套进这个模板再显示 —— 套上之后就**不再与宿主那句逐字相等**，
     * 按文本相等识别会失效，用户看到提示却少一颗「填写令牌」按钮，而且少了之后完全查不出
     * 原因（表现为"有的页面有按钮、有的没有"）。识别前先把这层壳剥掉。
     */
    let tokenActionWrap = null
    function tokenActionWrapOf() {
      if (tokenActionWrap) return tokenActionWrap
      const out = []
      for (const locale of ['zh', 'en']) {
        const tpl = (DICT[locale] || {})['error.action']
        if (typeof tpl !== 'string') continue
        const at = tpl.indexOf('{error}')
        if (at < 0) continue
        out.push({ prefix: tpl.slice(0, at), suffix: tpl.slice(at + '{error}'.length) })
      }
      tokenActionWrap = out
      return tokenActionWrap
    }

    /** 剥掉 `error.action` 的壳；没套壳就原样返回。 */
    function unwrapActionText(text) {
      for (const wrap of tokenActionWrapOf()) {
        if (!wrap.prefix || !text.startsWith(wrap.prefix)) continue
        const rest = text.slice(wrap.prefix.length)
        if (wrap.suffix) { if (rest.endsWith(wrap.suffix)) return rest.slice(0, rest.length - wrap.suffix.length) }
        else return rest
      }
      return text
    }

    /**
     * 「这句话是不是令牌没过」（含被 `error.action` 套过壳的形态）。
     */
    function isTokenGateText(text) {
      const text2 = String(text == null ? '' : text).trim()
      if (text2 === '') return false
      const known = tokenGateTextsOf()
      if (known.indexOf(text2) >= 0) return true
      const inner = unwrapActionText(text2)
      return inner !== text2 && known.indexOf(inner) >= 0
    }

    // ── 令牌提示的**存放位置**：一份与页面/弹窗无关的状态 ─────────────────────────
    //
    // 为什么需要它（用户实测 2026-09-19）：
    //   · 「新增 MCP」弹窗里提交被令牌挡下 —— 错误落进页面级提示条，而它**在弹窗背后**，
    //     被遮罩压暗，用户看到的是"弹窗里什么提示都没有"。
    //   · 「新建场景」弹窗里的错误是弹窗自己渲染的，但那条**没有跳转按钮**。
    //   同一个错误在十来个弹窗里各走各的路，就必然有地方漏。
    //
    // 现在的规则只有一条：**令牌提示同时只渲染一份** ——
    //   · 有弹窗打开 → 由 `Modal` 在弹窗内渲染（它是全插件弹窗的唯一出口）；
    //   · 没有弹窗 → 由页面级提示条渲染（`Notice`）。
    // `apiCall` 见到门禁拒绝就往这里写；用户提交了令牌（`setAccessToken`）就清掉。
    let gateText = null
    let gateModalDepth = 0
    const gateSubs = new Set()
    function gateSnapshot() { return { text: gateText, modalDepth: gateModalDepth } }
    function emitGate() { for (const fn of Array.from(gateSubs)) fn() }
    /** 宿主拒绝了这次请求，且原因是令牌没过 → 记下来（任意弹窗之上都会显示）。 */
    function publishTokenGate(text) {
      if (gateText === text) return
      gateText = text
      emitGate()
    }
    /** 用户提交了令牌（或已确认宿主认可这串）→ 收掉。下一次再被拒会重新出现。 */
    function clearTokenGate() {
      if (gateText === null) return
      gateText = null
      emitGate()
    }
    /** 订阅这份状态（`Modal` 与 `Notice` 共用，保证两边永远看到同一份）。 */
    function useGateSnapshot() {
      const st = React.useState(gateSnapshot)
      React.useEffect(function () {
        const fn = function () { st[1](gateSnapshot()) }
        gateSubs.add(fn)
        fn()
        return function () { gateSubs.delete(fn) }
      }, [])
      return st[0]
    }

    // 跳到「填令牌」的地方。用注册表而不是直接引用页面组件：页签状态在 ToolsSection 里，
    // 而这个模块在它外面 —— 跨作用域直接引用会 ReferenceError（CompatPage 引用 apply 内的
    // Notice 就是这么白屏的）。这条约束**现在没有测试护栏**：原 `test/client-scope.test.mjs`
    // 已于 2026-09-19 随三份界面测试一并移除（`test/_archive/` 目录并未落盘，别当它还守着）。
    let navigateToTab = null
    const tokenFocusListeners = []
    let tokenFocusPending = false
    /** CompatPage 订阅：被要求"填写令牌"时把光标放进输入框。 */
    function onTokenFocus(fn) {
      tokenFocusListeners.push(fn)
      return function () {
        const i = tokenFocusListeners.indexOf(fn)
        if (i >= 0) tokenFocusListeners.splice(i, 1)
      }
    }
    function openTokenPanel() {
      if (navigateToTab) navigateToTab('compat')
      // 两种情况都要管：兼容页已经挂着（订阅者立即聚焦），或者刚被切过去（挂载时消费这个标记）。
      tokenFocusPending = true
      for (const fn of tokenFocusListeners.slice()) {
        try { fn() } catch (e) { /* 单个订阅者出错不影响其它 */ }
      }
    }
    /** 兼容页「功能总览」的行内跳转：跳到该功能所在的页签（注册表在 ToolsSection 里，见上）。 */
    function jumpToTab(tab) {
      try { if (navigateToTab) navigateToTab(tab) } catch (e) { /* 跳转失败不影响本页 */ }
    }
    function consumeTokenFocus() {
      const pending = tokenFocusPending
      tokenFocusPending = false
      return pending
    }

    // Small version badge shown next to each settings-page title; reads the
    // package version from the host (plugin-version op) so it always matches
    // the installed release.
    function VersionBadgeComponent() {
      const [v, setV] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        apiCall('plugin-version', {}).then((r) => { if (alive && r && r.ok) setV(r.version) }).catch(() => {})
        return () => { alive = false }
      }, [])
      return v ? React.createElement('span', { className: 'dsm-version' }, 'v' + v) : null
    }

    // ── 兼容页（/compat-status 的只读投影）──────────────────────────────────────
    // 排布按"先看结论、再看明细"：结论条 → 指标卡 → 阻塞项 → 动作可用性 →
    // 降级能力 → 模块实体 → 命令行提示。回答的是"能不能安全动数据"。
    var OPERATION_LABELS = {
      list: 'compat.op.list', archive: 'compat.op.archive', unarchive: 'compat.op.unarchive',
      batch: 'compat.op.batch', delete: 'compat.op.delete',
    }
    /** 每个操作走哪条路线：仅当有"原生委托"能力可用时才算原生。 */
    function operationRoutes(data) {
      const findings = (data && data.findings) || []
      const byId = {}
      findings.forEach(function (f) { byId[f.id] = f })
      const ok = function (id) { return byId[id] === undefined || byId[id].state === 'ok' }
      const routes = {}
      routes.list = ok('workspace.read-state') && ok('workspace.read-table') && ok('workspace.index-shape') ? 'adapter' : 'none'
      routes.archive = ok('workspace.archive-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      routes.unarchive = ok('workspace.unarchive-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      routes.batch = ok('workspace.batch-native') ? 'native' : (ok('workspace.enqueue') && ok('workspace.set-state') ? 'adapter' : 'none')
      // 与服务端 OPERATION_ROUTES 同源（src/compat/probe.ts）：
      //   · delete 不要求 `projection.delete-native` —— 宿主自带删除屏障是可选槽位，
      //     要求它会把 rc.2 上的删除显示成不可用（服务端有意不要求）；
      //   · 但要求 `projection.table-delete` —— 那是运行时的硬前提（表不可删就没法安全删行）。
      routes.delete = ok('workspace.delete-native') ? 'native'
        : (ok('workspace.enqueue') && ok('workspace.set-state') && ok('workspace.index-header')
          && ok('sessions.detach-live') && ok('sessions.cold-announce') && ok('projection.write')
          && ok('projection.table-delete') ? 'adapter' : 'none')
      return routes
    }

    function CompatPage(props) {
      const t = props.t
      const [data, setData] = React.useState(null)
      const [presetReach, setPresetReach] = React.useState(null)
      // 注入设置（本插件五个注入域的开关；见 src/context-inject.ts）。它和可达性矩阵是一体两面：
      // 矩阵说"到不到得了"，这里决定"要不要"。读不到时这一节不显示。
      const [inject, setInject] = React.useState(null)
      // 注入实况（只读）：最近活跃会话里模型**真正看到**的五域文本 + 本次运行的投递统计。
      // 与「注入」设置是一体两面：设置说"要送什么"，这里说"实际送到了什么"。
      const [live, setLive] = React.useState(null)
      const [liveOpen, setLiveOpen] = React.useState('')
      const [liveCopied, setLiveCopied] = React.useState(false)
      // 功能总览（B6）：按功能点看"现在到底能不能用"。数据来自 feature-overview（只读聚合）。
      const [features, setFeatures] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      // 访问令牌（用户裁定 2026-09-18：入口放兼容页）。它不属于"宿主体检"，但**必须有一个
      // 与页面无关的固定入口**：写操作被拒时那条错误会出现在任意页面（场景 / 技能 / 记忆…），
      // 而输入框此前只长在 MCP 页的详情弹窗里 —— 在场景页看到「缺少或错误的访问令牌」的用户
      // 找不到任何地方能填（实测死路）。宿主侧只回报"配没配 / 本次带的这个对不对"，
      // **不回报令牌本身**。
      const [tokenState, setTokenState] = React.useState(null)
      const [tokenDraft, setTokenDraft] = React.useState('')
      const [tokenMsg, setTokenMsg] = React.useState(null)
      // 令牌管理弹窗：null = 未打开；`{ mode: 'set'|'off'|'clear'|'on', current, next, repeat, value }` = 已打开。
      // 四种配置操作（设置/修改、关闭保护、删除令牌、开启保护）共用**一个**弹窗 —— 表单
      // 一律不落在页面上（用户 2026-09-19 三次反馈：页面要"不跳来跳去"，功能要分类清楚），
      // 弹窗打开时页面纹丝不动，确认后弹窗收起、状态行自己更新。要求输两遍（用户裁定
      // 2026-09-19）与"再输一次当前令牌"的口径都在弹窗内执行。
      const [tokenModal, setTokenModal] = React.useState(null)
      // patch 备份：份数 / 占用（只读，给按钮一个准数）+ 清理弹窗。
      // 每份备份都是整份 patch 的副本，里面的凭据是**明文** —— 所以给一个显式出口让人能删。
      const [backups, setBackups] = React.useState(null)
      // null = 未打开；`{ files, keep, loading, error, confirming, removed, kept, failedCount, failedNames, busy }` = 已打开。
      // `confirming` = 删除的两步确认已经按下第一步（按钮就地变成「确认永久删除」）。
      const [backupClean, setBackupClean] = React.useState(null)
      const tokenInputRef = React.useRef(null)
      // 「设置 / 修改令牌」弹窗里的「当前令牌」那一格：弹窗打开时光标直接落这里（首次设置
      // 没有这一格，落回弹窗根节点）。
      const tokenCurrentRef = React.useRef(null)
      // 令牌弹窗的根节点：打开时把焦点交给它，Esc / Tab 的键盘行为才有个落点（同备份弹窗）。
      // 弹窗是 CompatPage 内联渲染的，拿不到自己的 hooks，所以 ref 与下面的 effect 都在这儿声明。
      const tokenDialogRef = React.useRef(null)
      // 弹窗打开时聚焦一次。依赖用"开 / 关"这个布尔而不是整个 tokenModal —— 后者每敲一个字
      // 都会变，会把焦点从输入框抢回弹窗根节点（同下面备份弹窗的写法）。
      React.useEffect(function () {
        if (!tokenModal || !tokenDialogRef.current) return
        if (tokenModal.mode === 'set' && tokenCurrentRef.current) tokenCurrentRef.current.focus()
        else tokenDialogRef.current.focus()
      }, [tokenModal === null])
      // 备份弹窗的根节点：打开时把焦点交给它，Esc / Tab 的键盘行为才有个落点（同 `Modal`）。
      // 弹窗是 CompatPage 内联渲染的，拿不到自己的 hooks，所以 ref 与下面的 effect 都在这儿声明。
      const backupDialogRef = React.useRef(null)
      /** 被别处要求"填写令牌"时，把光标放进输入框并滚到可见处。令牌弹窗开着的话先收掉：
       *  别处要的是"解锁本次启动"，弹窗（配置操作）不是答案。 */
      const focusTokenInput = function () {
        setTokenModal(null)
        setTimeout(function () {
          const node = tokenInputRef.current
          if (!node) return
          try {
            node.focus()
            if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' })
          } catch (e) { /* 聚焦失败无所谓，用户自己点一下 */ }
        }, 0)
      }
      React.useEffect(function () {
        // 两种到达方式都要管：兼容页已经挂着（订阅者立即聚焦），或刚从别的页签切过来
        // （那时订阅还没建立，靠挂载时消费标记）。
        const off = onTokenFocus(focusTokenInput)
        if (consumeTokenFocus()) focusTokenInput()
        return off
      }, [])
      // 备份弹窗每次「打开」时聚焦一次。依赖用"开 / 关"这个布尔而不是整个 state 对象：
      // 后者每改一次（切层级、busy…）都会变，会把用户刚点的按钮的焦点抢回弹窗根节点。
      React.useEffect(function () {
        if (backupClean && backupDialogRef.current) backupDialogRef.current.focus()
      }, [!!backupClean])
      const apply = function (r, alive) {
        if (alive === false) return
        if (r && r.ok) { setData(r); setError(null) } else { setError((r && r.error) || 'unknown') }
        setBusy(false)
      }
      // 预设可达性是独立的一面镜子：它取不到只意味着这一节不显示，
      // 绝不让它的失败顶掉 compat-status 的结论。
      const applyReach = function (r, alive) {
        if (alive === false) return
        if (r && r.ok) setPresetReach(r)
      }
      const loadReach = function (alive) {
        apiCall('preset-reach', {})
          .then(function (r) { applyReach(r, alive) })
          .catch(function () { /* 未挂载预设服务 → 不渲染这一节 */ })
      }
      // 令牌状态（只读）：宿主配没配、本机浏览器这份对不对。读不到就显示「…」，
      // 不让它把整页顶成错误态。
      const applyTokenState = function (r, alive) {
        if (alive === false || !r || !r.ok) return
        // 收掉那句"去填令牌"的两种情形：
        //   ① 宿主认可了本机这串 ⇒ 用户已经把它填对了，再挂着只会让人以为还没生效；
        //   ② 当前进程里令牌**没在生效**（关掉了 / 从来没配）⇒ 那句话已无处可填，留着就是
        //      在说一件不存在的事（用户 2026-09-19：「未开启令牌功能怎么还有这个提示词」）。
        //      这一态下面板自己会用状态胶囊说清实际情况。
        if (r.accepted === true || r.active !== true) clearTokenGate()
        // 锁态与上面那句提示**同源**：同一个响应里就有答案，不再多发一次 token-status。
        // 于是"进兼容页看一眼"或"提交一次令牌"都会顺手把输入框的锁校准回来。
        setTokenLock(r.active === true && r.accepted !== true)
        setTokenState({
          hostConfigured: r.hostConfigured === true,
          disabled: r.disabled === true,
          active: r.active === true,
          accepted: r.accepted === true,
          configHasToken: r.configHasToken === true,
          configDisabled: r.configDisabled === true,
          configFound: r.configFound === true,
          pendingRestart: r.pendingRestart === true,
        })
      }
      const loadToken = function (alive) {
        apiCall('token-status', {})
          .then(function (r) { applyTokenState(r, alive) })
          .catch(function () { /* 读不到 → 状态显示「…」 */ })
      }
      // patch 备份的份数与占用：只为了在「清理旧备份」按钮上给个准数。
      // 读不到就留空（按钮照旧可用，点开时会再拉一次完整清单）—— 这一节不参与体检结论。
      const loadBackups = function (alive) {
        apiCall('backups-list', {})
          .then(function (r) { if (alive !== false && r && r.ok) setBackups({ total: r.total || 0, totalSize: r.totalSize || 0 }) })
          .catch(function () { /* 读不到 → 按钮不带数字 */ })
      }
      /** 本次进程用：填一次，跟 bootId 绑定（见文件顶部注释）。成功**不弹任何结果框** ——
       *  胶囊从「待解锁」翻成绿「已解锁」就是回执（面板原位换胶囊，行不消失）；失败时
       *  表单留在原地，错误显示在面板内部（field:'run'）。 */
      const saveToken = function () {
        const value = String(tokenDraft || '').trim()
        if (!value) { setTokenMsg({ kind: 'err', text: t('compat.token.empty'), field: 'run' }); return }
        setAccessToken(value)
        setTokenDraft('')
        apiCall('token-status', {}).then(function (r) {
          applyTokenState(r, true)
          if (!r || !r.ok) { setTokenMsg({ kind: 'err', text: t('compat.token.failed'), field: 'run' }); return }
          if (r.hostConfigured !== true) { setTokenMsg({ kind: 'err', text: t('compat.token.noHost'), field: 'run' }); return }
          // 成功（accepted）→ 一句话都不说：胶囊翻转 + 顶部横幅自动消失已经是回执。
          // 「没在生效」也不算失败 —— 值可能是对的（关着 / 待重启），状态行自己会说。
          if (r.accepted !== true && r.active === true) setTokenMsg({ kind: 'err', text: t('compat.token.mismatch'), field: 'run' })
          else setTokenMsg(null)
        }).catch(function () { setTokenMsg({ kind: 'err', text: t('compat.token.failed'), field: 'run' }) })
      }
      const clearToken = function () {
        setAccessToken('')
        setTokenDraft('')
        setTokenMsg(null)
        // 同步把宿主侧「本次启动已验过」的闩重新挂上（token-unaccept）：否则解锁一次之后
        // 清除 + 强刷新，浏览器里没有令牌，pre-step 门禁却因闩还挂着而放行对话
        // （2026-09-19 实测漏洞）。失败不拦清除本身 —— 本机记录已删，宿主闩重启后
        // 也会自然清零，只是那之前对话门暂时没收回来。
        apiCall('token-unaccept', {}).catch(function () { /* 宿主是没这个 op 的旧版：本机照删 */ })
        loadToken(true)
      }
      /**
       * 改宿主侧配置。三种模式：
       *   `set` —— 写入 / 换掉令牌（新值由表单传进来，必须输两遍；宿主已有令牌时还要在
       *            表单里**当场再输一次当前令牌**当凭证，走 `current` 那一栏）；
       *   `off` —— 关掉保护（**令牌留在配置里**，随时能开回来；凭证只能是**这次输入的**当前令牌，
       *            见下面 `value` 的来源 —— 请求头里"已经解锁"这件事对关闭不算数）；
       *   `on`  —— 重新打开保护（凭证 = 解锁过，或输入框里填着当前令牌）。
       * 改完**必须重启 DSH 才生效** —— 当前进程的令牌是启动时读进来的常量，所以这里如实
       * 说"重启后生效"，而不是让用户以为点了没反应。
       *
       * `value` / `current` 一律由调用方给全（每种模式各有来源），这里不再自己挑 `tokenDraft`
       * —— 关闭与修改的凭证都必须是用户当场输的那串，混进解锁框的值就等于把刚立的要求绕过去了。
       * `fieldKey` 标记错误归属哪个表单（解锁面板 / 设置表单 / 各确认框）：**错误只出现在
       * 触发表单内部**，成功则表单收起、状态行自己更新（胶囊 / 待重启横幅），卡片里永远
       * 不出现游离的结果框。
       */
      const configureHostToken = function (mode, value, current, fieldKey) {
        const proof = String(value || '').trim()
        if (mode === 'set' && !proof) { setTokenMsg({ kind: 'err', text: t('compat.token.empty'), field: 'next' }); return }
        if ((mode === 'off' || mode === 'clear') && !proof) { setTokenMsg({ kind: 'err', text: t('compat.token.proofNeed'), field: fieldKey }); return }
        setTokenMsg(null)
        // `current` 只有 set 用：那个值是**新**令牌，证明不了你知道旧值，所以凭证单独一栏
        // （宿主侧同样只认它 —— 请求头里更新过的那份对 set 不作数，见 src/index.ts tokenConfigure）。
        apiCall('token-configure', { mode: mode, token: proof, current: String(current || '').trim() }).then(function (r) {
          if (!r || !r.ok) {
            // 令牌不对时，宿主回的还是那个通用错误码（宿主那句提示指向「本次启动」的解锁流程）
            // —— 那条指引在"就地为关闭 / 修改做确认"的场景里是错的，所以这里按本次操作重说
            // 一遍，而不是把人指到别的地方去。四种模式（含开启保护时填错）共用同一句。
            const wrong = !!(r && r.code === 'error.secret.badToken')
            const text = wrong ? t('compat.token.wrong') : ((r && r.error) || t('compat.token.failed'))
            // 令牌不对时把**那一格**标红（`field`）：整句提示在框内，但"错在哪个框"得看得出
            // —— set 的凭证是「当前令牌」那一栏，其余错误归属触发它的那个表单。
            setTokenMsg({ kind: 'err', text: text, field: wrong && mode === 'set' ? 'current' : fieldKey })
            return
          }
          // 成功：把弹窗收起来就是回执。"要重启"这件事由「待重启」横幅说（状态一刷新它
          // 自然出现），不再另弹一句"已写入配置"—— 两句话叠在一起只会互相稀释。
          setTokenMsg(null)
          if (mode === 'set') {
            // **不**把本机令牌顺手换成新值：换完之后"当前进程"认的还是旧令牌（配置改动要重启），
            // 换了只会让面板立刻显示「不匹配」—— 看起来像改坏了。保留现值 + 那句"重启后生效"
            // 的横幅，语义才是对的（重启后按第 3 条要求本来也要重填一次）。
            setTokenDraft('')
          }
          setTokenModal(null)
          loadToken(true)
        }).catch(function (e) { setTokenMsg({ kind: 'err', text: errMsg(e), field: fieldKey }) })
      }
      /** 打开令牌管理弹窗（四种模式共用一个弹窗，见 tokenModal 的注释）。 */
      const openTokenModal = function (mode) {
        setTokenModal({ mode: mode, current: '', next: '', repeat: '', value: '' })
        setTokenMsg(null)
      }
      const closeTokenModal = function () { setTokenModal(null); setTokenMsg(null) }
      /**
       * 提交弹窗：按钮与回车走**同一条判断**，免得两种入口对"填齐了没有"的要求不一致
       * （按钮那边是 disabled，回车这边只能自己判）。
       */
      const submitTokenModal = function () {
        if (!tokenModal) return
        if (tokenModal.mode === 'set') {
          if (!tokenModal.next.trim() || tokenSetInvalid) return
          if (tokenHostConfigured && !tokenModal.current.trim()) return
          configureHostToken('set', tokenModal.next.trim(), tokenModal.current.trim(), 'next')
          return
        }
        // off / clear 只认当场输入的当前令牌；on 是反风险方向，宿主还接受请求头里
        // 已验过的凭证（accepted 时可以不填直接开，见 src/index.ts tokenConfigure）。
        // clearLocal 是本机操作，宿主不参与：输一次令牌是与其余三行同款的确认手势，
        // 不校验对错 —— 校验了反而把"清除记错的旧令牌"这条路堵死，非空即可确认。
        if (tokenModal.mode === 'clearLocal') {
          if (!tokenModal.value.trim()) return
          clearToken()
          setTokenModal(null)
          return
        }
        const allowEmpty = tokenModal.mode === 'on' && !!(tokenState && tokenState.accepted)
        if (!tokenModal.value.trim() && !allowEmpty) return
        configureHostToken(tokenModal.mode, tokenModal.value.trim(), '', tokenModal.mode)
      }
      /** 弹窗里的输入框按回车 = 确认（所有框挂同一个，顺序无所谓）。 */
      const enterToSubmit = function (ev) { if (ev.key === 'Enter') submitTokenModal() }
      const loadInject = function (alive) {
        apiCall('inject-settings', {})
          .then(function (r) { if (alive !== false && r && r.ok && r.settings) setInject(r.settings) })
          .catch(function () { /* 读不到 → 不渲染这一节 */ })
      }
      const loadLive = function (alive) {
        apiCall('injection-live', {})
          .then(function (r) { if (alive !== false && r && r.ok) setLive(r) })
          .catch(function () { /* 读不到 → 不渲染这一节 */ })
      }
      // 功能总览（B6）：服务端按功能点聚合（装配层 + 宿主能力层 + 用户配置层）。
      // 它是只读的派生视图，取不到就不渲染这一节，绝不影响上面那条结论。
      const loadFeatures = function (alive) {
        apiCall('feature-overview', {})
          .then(function (r) { if (alive !== false && r && r.ok) setFeatures(r) })
          .catch(function () { /* 同上 */ })
      }
      React.useEffect(function () {
        let alive = true
        setBusy(true)
        apiCall('compat-status', { refresh: true })
          .then(function (r) { apply(r, alive) })
          .catch(function (e) { if (alive) { setError(errMsg(e)); setBusy(false) } })
        loadReach(alive)
        loadInject(alive)
        loadLive(alive)
        loadFeatures(alive)
        loadToken(alive)
        loadBackups(alive)
        return function () { alive = false }
      }, [])
      const reload = function () {
        setBusy(true)
        apiCall('compat-status', { refresh: true })
          .then(function (r) { apply(r, true) })
          .catch(function (e) { setError(errMsg(e)); setBusy(false) })
        loadReach(true)
        loadInject(true)
        loadLive(true)
        loadFeatures(true)
        loadToken(true)
        loadBackups(true)
      }
      // 保存注入设置：先乐观更新界面（点一下就该有反馈），服务端返回值到达后以其为准；
      // 失败则重新拉一次。可达性矩阵跟着刷新 —— 芯片要反映新的开关状态。
      const saveInject = function (patch) {
        if (!inject) return
        const next = Object.assign({}, inject, patch)
        setInject(next)
        apiCall('inject-settings', Object.assign({ set: true }, next))
          .then(function (r) {
            if (r && r.ok && r.settings) setInject(r.settings)
            loadReach(true)
          })
          .catch(function () { loadInject(true); loadReach(true) })
      }

      const findings = (data && data.findings) || []
      const degraded = (data && data.degraded) || []
      const blockers = (data && data.blockers) || []
      const routes = operationRoutes(data)
      const sameAsHost = (data && data.sameAsHost) || {}
      const separateCopies = Object.keys(sameAsHost).filter(function (name) { return sameAsHost[name] === false })
      // 「没比成」与「比过、不一样」是两回事：后者是两份拷贝（要动手修），前者是宿主的解析
      // 锚点里找不到这个包 —— 身份校验等于没做。服务端已单列，这里必须说出来，否则界面只有
      // 一排看不懂的「无法比对」，而页头照样报「全部可用」。
      const unverified = (data && data.unverified) || []
      const healthy = degraded.length === 0 && blockers.length === 0 && separateCopies.length === 0
      // 可用 = 探测通过 + 宿主没有但插件自己顶上的（optional）。
      // 后者若不算进分子，本机这种"官方缺三个入口"的正常形态会显示成 12/15，
      // 让人以为三成能力坏了 —— 实际上它们全部可用。
      const usableCount = findings.filter(function (item) { return item.state === 'ok' || item.optional === true }).length
      // 真正拦路的只有"宿主有该服务但缺关键成员"（如 requireState 改名）与未解析的包。
      const blockedCount = degraded.length
        + Object.keys(sameAsHost).filter(function (name) { return sameAsHost[name] === false }).length
      const unavailableCount = Object.keys(OPERATION_LABELS).filter(function (op) { return routes[op] === 'none' }).length

      const routeClass = function (via) {
        return 'dsm-compat-pill' + (via === 'none' ? ' dsm-compat-pill-bad' : via === 'native' ? ' dsm-compat-pill-ok' : '')
      }
      const routeText = function (via) {
        return via === 'none' ? t('compat.op.unavailable') : via === 'native' ? t('compat.op.native') : t('compat.op.adapter')
      }
      const card = function (label, value, note, bad) {
        return React.createElement('div', { className: 'dsm-compat-card' + (bad ? ' dsm-compat-card-bad' : '') },
          React.createElement('span', { className: 'dsm-compat-card-label' }, label),
          React.createElement('strong', { className: 'dsm-compat-card-value' + (bad ? ' dsm-compat-card-value-bad' : '') }, value),
          note ? React.createElement('span', { className: 'dsm-compat-card-note' }, note) : null)
      }
      /**
       * 兼容页的区块。
       *
       * @param boxed 把**内容**包进一圈边框（访问令牌 / 注入实况）。给"可操作的设置块"用：
       *   它们和下面那些只读的体检结论不是一类东西，没有边框时整页就是一长条同质的文字，
       *   用户找不到"我该动哪儿"。
       *   边框只包内容，**小标题留在框外** —— 标题也进框、框里再铺一层深灰底时，
       *   整页会多出一串"盒子里的盒子"，看着更乱（用户裁定 2026-09-19：
       *   「小标题不用在框里」「背景和大背景一样就行」，照「注入」那一块的样子来）。
       */
      const section = function (title, hint, body, boxed) {
        return React.createElement('section', { className: 'dsm-compat-section' },
          React.createElement('div', { className: 'dsm-compat-section-head' },
            React.createElement('h3', { className: 'dsm-compat-section-title' }, title),
            hint ? React.createElement('span', { className: 'dsm-compat-section-hint' }, hint) : null),
          boxed ? React.createElement('div', { className: 'dsm-compat-box' }, body) : body)
      }

      const body = []
      // 块级子项统一在这里加 key：`body` 是数组，React 要求每个直接子项有稳定 key。
      const push = function (node) {
        body.push(React.cloneElement(node, { key: 'compat-' + String(body.length) }))
      }
      // 访问令牌（用户裁定 2026-09-18：放在「注入」**上面** —— 令牌不过时写操作全被拒，
      // 它是"先解决才能用别的"的一件事，位置就该在设置项之前）。
      //
      // 排版口径（2026-09-19 第三次重构；「折叠管理区」首版与「常驻清单」二版之后，
      // 用户点破关键：「按钮、输入框、提示句的位置、大小、长度要统一，页面不要跳来跳去；
      // 功能要分类出来，互通的功能合在一起会很混乱，不必受现有结构束缚」）——
      // 于是按**作用域**拆成两个分区，所有表单搬进弹窗：
      //
      //   ① 访问令牌（本机、临时）：一枚胶囊 + 一句实况 + 一个控件槽，永远只有两行。
      //      待解锁 = 输入框 + 解锁；已解锁 = 原位换绿胶囊（同一个容器，min-height 拉平，
      //      框高不变）；其余状态不放控件。解锁错误顶替实况那一行显示（红色），高度同样不变。
      //   ② 令牌管理（配置文件、持久）：四行**静态**清单 —— 令牌（设置/修改）、保护开关、
      //      删除令牌、清除令牌。行名、说明、按钮三列同形同位同宽，行不随状态增删
      //      （不可用时禁用、由说明解释）；按钮上带 … 的开**弹窗**（照备份弹窗的手工
      //      模式拼装），页面上不存在任何会展开收起的东西。
      //
      //   反馈模型：页面**永远不出现游离的结果框**。成功 = 弹窗收起 / 胶囊翻绿 + 状态行
      //      更新（「待重启」横幅是写配置成功的唯一回执）；失败 = 弹窗不关、错误显示在
      //      弹窗内部（`field` 归属哪个框）。红色只出现在确认按钮上。
      // 它**有意替换**同日早些时候的全部三条口径（「本次启动 / 宿主配置 / 保护开关」三行
      // 常驻、就地展开确认、结果框报告成败）：三行把实现模型摆给用户，就地展开与结果框
      // 是页面跳动的来源。「本次启动」行随之退役。
      const tokenHostConfigured = !!(tokenState && tokenState.hostConfigured)
      // 当前进程里令牌**是否在生效**（宿主回的 `active`：关掉或没配都是 false）。
      const tokenActive = !!(tokenState && tokenState.active)
      // 「保护当下是否算开着」—— 开关行的方向用它，**不能**只看配置文件：令牌也可能
      // 来自环境变量（文件里没有 token），只看配置会把"开着"说成"已关闭"，环境变量用户
      // 就永远找不到关闭入口（好在 TOKEN_DISABLED 是文件侧旗标、对环境变量供的令牌同样
      // 生效，见 src/request-gate.ts createAccessToken，所以「关闭」对他们真实可用）。
      const tokenProtectOn = tokenActive
        || !!(tokenState && tokenState.configHasToken === true && tokenState.configDisabled !== true)
      // 本次进程解锁没有（填过，且宿主认可这串）。
      const tokenUnlocked = !!TOKEN && !!(tokenState && tokenState.accepted)
      // 胶囊四态：未设置 / 已关闭 / 已开启·待解锁 / 已开启·已解锁（状态还没到 → loading）。
      const tokenKind = !tokenState
        ? 'loading'
        : (!tokenHostConfigured ? 'unset'
          : (tokenActive ? (tokenUnlocked ? 'unlocked' : 'locked') : 'off'))
      // 绿=这一程能改配置；告警=要注意（开着但没解锁 / 关着）；灰=还没配。
      const tokenPillTone = tokenKind === 'unlocked'
        ? ' dsm-pill-ok'
        : (tokenKind === 'off' || tokenKind === 'locked' ? ' dsm-pill-warn' : ' dsm-pill-muted')
      const tokenModalOpen = tokenModal !== null
      const tokenSetInvalid = tokenModalOpen && tokenModal.mode === 'set' && tokenModal.next !== tokenModal.repeat
      // 错误只出现在**触发它的弹窗内部**（`field` 归属：run=状态区实况行（顶替实况）/
      // current·next=设置弹窗 / off·clear·on=各自弹窗）；成功则弹窗收起、状态行自己更新。
      const tokenFormError = function (fields) {
        if (!tokenMsg || !tokenMsg.field || fields.indexOf(tokenMsg.field) < 0) return null
        return React.createElement('p', { className: 'dsm-token-ferr dsm-feedback dsm-error', role: 'alert' }, tokenMsg.text)
      }
      // ① 状态区：实况句与解锁错误共用一行 —— 错误顶替实况（红色），行高、位置都不变。
      const tokenStatusLine = !tokenState ? null
        : (tokenMsg && tokenMsg.field === 'run')
          ? React.createElement('span', { className: 'dsm-help dsm-token-stat-err' }, tokenMsg.text)
          : React.createElement('span', { className: 'dsm-help' }, t('compat.token.sentence.' + tokenKind))
      // 控件槽：只有「待解锁」态才有内容（输入框 + 解锁）。已解锁后状态行本身就是
      // 绿胶囊 + 实况，控件槽里再摆一枚「已解锁」纯属重复、框也空落落（用户 2026-09-19
      // 实测反馈）—— 其余状态什么都不放，这一区最省就一行。
      const tokenControl = tokenKind === 'locked'
        ? React.createElement('div', { className: 'dsm-token-unlock' },
          React.createElement('input', {
            ref: tokenInputRef,
            // 令牌填错时把这一格标红（`field` 口径见 configureHostToken / saveToken）。
            className: 'dsm-control' + (tokenMsg && tokenMsg.field === 'run' ? ' dsm-rule-invalid' : ''),
            type: 'password', value: tokenDraft,
            placeholder: t('compat.token.placeholder'), 'aria-label': t('compat.token'),
            onChange: function (ev) { setTokenDraft(ev.target.value) },
            // 回车 = 解锁（与弹窗同一口径：按钮与回车行为一致）。
            onKeyDown: function (ev) { if (ev.key === 'Enter' && tokenDraft.trim()) saveToken() },
          }),
          React.createElement('button', {
            type: 'button', className: 'dsm-btn',
            disabled: !tokenDraft.trim(), onClick: saveToken,
          }, t('compat.token.save')))
        : null
      // ── ② 令牌管理：四行静态清单（配置文件、持久）────────────────────────────────
      // 行构造：名字 · 一句说明 · 按钮，三列网格 —— 每行同形、同位、同宽。行**永远
      // 存在**（不随状态增删，不可用时禁用、由说明解释为什么），按钮一律次级样式，
      // 红色只出现在弹窗里的确认按钮上；点带 … 的按钮开弹窗，页面本身纹丝不动。
      const tokenRow = function (name, hint, btn) {
        return React.createElement('div', { className: 'dsm-token-mrow' },
          React.createElement('span', { className: 'dsm-token-mrow-name' }, name),
          React.createElement('span', { className: 'dsm-token-mrow-hint' }, hint),
          btn)
      }
      /** 状态会翻转的按钮（修改↔设置 / 关闭↔开启）：fixedLabelPair 用隐形占位把两种
       *  文案里更宽的那个当宽度，翻转时按钮尺寸不变（见 fixedLabelPair 上的注释）。 */
      const tokenRowBtn = function (label, otherLabel, disabled, onClick) {
        return React.createElement('button', {
          type: 'button', className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk',
          disabled: disabled, onClick: onClick,
        }, fixedLabelPair(label, otherLabel))
      }
      // 第 1 行：令牌（设置 / 修改）。凭证在弹窗里当场输一次，不要求"先解锁"（原先那道
      // 前置会让用户把同一串令牌填两遍，用户裁定 2026-09-19 移除）。
      const tokenRowValue = tokenRow(
        t(tokenHostConfigured ? 'compat.token.edit' : 'compat.token.setHost'),
        t(tokenHostConfigured ? 'compat.token.edit.rowHint' : 'compat.token.hostHint'),
        tokenRowBtn(
          t(tokenHostConfigured ? 'compat.token.edit.btn' : 'compat.token.setHost.btn'),
          t(tokenHostConfigured ? 'compat.token.setHost.btn' : 'compat.token.edit.btn'),
          !tokenState, function () { openTokenModal('set') }))
      // 第 2 行：保护开关。方向按 tokenProtectOn 判（见其注释）—— 环境变量供的令牌也能
      // 在这里关掉；还没设置令牌时没有可开关的东西，禁用。
      const tokenRowProtect = tokenRow(
        t('compat.token.row.protect'),
        t(tokenProtectOn ? 'compat.token.offHost.rowHint' : 'compat.token.onHint'),
        tokenRowBtn(
          t(tokenProtectOn ? 'compat.token.offHost.btn' : 'compat.token.onHost.btn'),
          t(tokenProtectOn ? 'compat.token.onHost.btn' : 'compat.token.offHost.btn'),
          !tokenState, function () { openTokenModal(tokenProtectOn ? 'off' : 'on') }))
      // 第 3 行：删除令牌。配置文件里没有值可删时禁用 —— 靠环境变量供令牌时是"没有可删
      // 的值"（说明改口解释），还没设置过令牌是正常的禁用。删除回到"还没有令牌"那一态
      // （写操作不再要凭证、明文密钥也可直接查看）。
      const tokenRowDelete = tokenRow(
        t('compat.token.clearHost'),
        tokenState && tokenHostConfigured && tokenState.configHasToken !== true
          ? t('compat.token.clearHost.envHint')
          : t('compat.token.clearHost.rowHint'),
        tokenRowBtn(t('compat.token.clearHost.btn'), t('compat.token.clearHost.btn'),
          !tokenState || tokenState.configHasToken !== true,
          function () { openTokenModal('clear') }))
      // 第 4 行：清除令牌。只清浏览器里记住的那串（本机令牌），不动配置；但与其余三行
      // 同一套交互 —— 弹窗里输一次令牌确认（用户 2026-09-19 要求）。浏览器没记住东西时禁用。
      const tokenRowClearLocal = tokenRow(
        t('compat.token.clearLocal'),
        t('compat.token.clearLocal.rowHint'),
        tokenRowBtn(t('compat.token.clear'), t('compat.token.clear'),
          !TOKEN, function () { openTokenModal('clearLocal') }))
      push(section(t('compat.token'), t('compat.token.hint'),
        React.createElement('div', { className: 'dsm-token-block' },
          // 状态行：胶囊 + 实况（或解锁错误）—— 永远只有这一行，位置不变。
          React.createElement('div', { className: 'dsm-stat-row' },
            React.createElement('span', { className: 'dsm-pill' + tokenPillTone },
              tokenState ? t('compat.token.pill.' + tokenKind) : '…'),
            tokenStatusLine),
          // 控件槽：待解锁 = 输入框 + 解锁；已解锁 = 原位绿胶囊；其余状态不渲染。
          tokenControl,
          // 配置改了但没重启：这句必须显眼，否则用户会以为"设置了却没反应"。它同时是
          // 写配置成功的**唯一回执** —— 成功 = 弹窗收起 + 这句横幅出现，不另弹结果框。
          tokenState && tokenState.pendingRestart
            ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('compat.token.pendingRestart'))
            : null,
          // loader 行读不到：**所有**写配置的操作都会被宿主拒绝 —— 它是管理区的前置
          // 事实，作为一行说明放在状态区底部。
          tokenState && tokenState.configFound === false
            ? React.createElement('p', { className: 'dsm-help' }, t('compat.token.notFound'))
            : null),
        true))
      push(section(t('compat.token.manage.title'), t('compat.token.manage.hint'),
        React.createElement('div', { className: 'dsm-token-rows' },
          tokenRowValue, tokenRowProtect, tokenRowDelete, tokenRowClearLocal),
        true))

      // ── 令牌管理弹窗（手工拼装 —— `Modal` 在 apply 内引用不到，照备份弹窗的模式）──
      // 遮罩点击关闭 + 头部标题/关闭键 + body + 底部动作行；Esc 关闭 / Tab 焦点陷阱
      // 复用模块作用域的那三个助手；打开时的聚焦见 tokenDialogRef 上的 effect。
      // 弹窗内不挂令牌提示（TokenGateNotice 在 apply 内，引它=白屏）：被令牌挡下的操作
      // 由弹窗自己的错误行如实显示。
      let tokenModalEl = null
      if (tokenModal) {
        const m = tokenModal
        const title = t(m.mode === 'set'
          ? (tokenHostConfigured ? 'compat.token.edit' : 'compat.token.setHost')
          : m.mode === 'off' ? 'compat.token.offHost'
            : m.mode === 'clear' ? 'compat.token.clearHost'
              : m.mode === 'clearLocal' ? 'compat.token.clearLocal' : 'compat.token.onHost')
        let fields
        if (m.mode === 'set') {
          // 竖排三格（圆点看不出填的是哪格，竖排靠顺序当说明）：当前令牌（仅宿主已配时 ——
          // 首次设置没有"当前"可证明，宿主同样不要求）、新令牌、再输一次；三格都齐了
          // 才让按：当前令牌是凭证（宿主会验），新令牌输两遍防手滑（用户裁定 2026-09-19）。
          fields = [
            tokenHostConfigured ? React.createElement('input', {
              key: 'current', ref: tokenCurrentRef,
              className: 'dsm-control' + (tokenMsg && tokenMsg.field === 'current' ? ' dsm-rule-invalid' : ''),
              type: 'password', value: m.current,
              placeholder: t('compat.token.edit.current'), 'aria-label': t('compat.token.edit.current'),
              onChange: function (ev) { setTokenModal({ mode: 'set', current: ev.target.value, next: m.next, repeat: m.repeat, value: '' }) },
              onKeyDown: enterToSubmit,
            }) : null,
            React.createElement('input', {
              key: 'next',
              className: 'dsm-control' + (tokenMsg && tokenMsg.field === 'next' ? ' dsm-rule-invalid' : ''),
              type: 'password', value: m.next,
              placeholder: t('compat.token.edit.new'), 'aria-label': t('compat.token.edit.new'),
              onChange: function (ev) { setTokenModal({ mode: 'set', current: m.current, next: ev.target.value, repeat: m.repeat, value: '' }) },
              onKeyDown: enterToSubmit,
            }),
            React.createElement('input', {
              key: 'repeat',
              className: 'dsm-control' + (tokenSetInvalid ? ' dsm-rule-invalid' : ''), type: 'password', value: m.repeat,
              placeholder: t('compat.token.edit.repeat'), 'aria-label': t('compat.token.edit.repeat'),
              onChange: function (ev) { setTokenModal({ mode: 'set', current: m.current, next: m.next, repeat: ev.target.value, value: '' }) },
              onKeyDown: enterToSubmit,
            }),
            tokenSetInvalid ? React.createElement('p', { key: 'mis', className: 'dsm-help dsm-rule-hint' }, t('compat.token.edit.mismatch')) : null,
            tokenFormError(['current', 'next']),
          ]
        } else {
          // "再输一次当前令牌"确认：关闭 / 删除只认当场输入的值（用户裁定 2026-09-19）；
          // 开启是反风险方向，accepted 时宿主还认请求头凭证，可以不填直接开。
          const allowEmpty = m.mode === 'on' && !!(tokenState && tokenState.accepted)
          fields = [
            React.createElement('input', {
              key: 'proof',
              className: 'dsm-control' + (tokenMsg && tokenMsg.field === m.mode ? ' dsm-rule-invalid' : ''),
              type: 'password', value: m.value,
              placeholder: t('compat.token.proofPlaceholder'), 'aria-label': t('compat.token.proofPlaceholder'),
              onChange: function (ev) { setTokenModal({ mode: m.mode, current: '', next: '', repeat: '', value: ev.target.value }) },
              onKeyDown: function (ev) { if (ev.key === 'Enter' && (m.value.trim() || allowEmpty)) submitTokenModal() },
            }),
            React.createElement('p', { key: 'hint', className: 'dsm-help' },
              t(m.mode === 'off' ? 'compat.token.offConfirm.hint'
                : m.mode === 'clear' ? 'compat.token.clearConfirm.hint'
                  : m.mode === 'clearLocal' ? 'compat.token.clearLocalConfirm.hint' : 'compat.token.onHint')),
            tokenFormError([m.mode]),
          ]
        }
        const yesLabel = m.mode === 'set' ? t('compat.token.edit.save')
          : m.mode === 'off' ? t('compat.token.offConfirm.yes')
            : m.mode === 'clear' ? t('compat.token.clearConfirm.yes')
              : m.mode === 'clearLocal' ? t('compat.token.clearLocalConfirm.yes') : t('compat.token.onConfirm.yes')
        const yesDisabled = m.mode === 'set'
          ? (!m.next.trim() || tokenSetInvalid || (tokenHostConfigured && !m.current.trim()))
          : (!m.value.trim() && !(m.mode === 'on' && !!(tokenState && tokenState.accepted)))
        tokenModalEl = React.createElement('div', {
          key: 'token-modal',
          className: 'dsm-mask',
          onMouseDown: function (e) { if (e.target === e.currentTarget) closeTokenModal() },
        }, React.createElement('div', {
          ref: tokenDialogRef, tabIndex: -1,
          className: 'dsm-modal dsm-modal-sm', role: 'dialog', 'aria-modal': 'true',
          'aria-labelledby': 'dsm-token-modal-title',
          onKeyDown: function (e) { if (!handleModalEscape(e, closeTokenModal)) trapModalFocus(e.currentTarget, e) },
        },
          React.createElement('div', { className: 'dsm-modal-head-wrap' },
            React.createElement('div', { className: 'dsm-modal-head' },
              React.createElement('h3', { className: 'dsm-modal-title', id: 'dsm-token-modal-title' }, title),
              React.createElement('button', {
                type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: closeTokenModal,
              }, t('btn.close')))),
          React.createElement('div', { className: 'dsm-modal-body' },
            React.createElement('div', { className: 'dsm-token-form' }, fields),
            React.createElement('div', { className: 'dsm-modal-actions' }, [
              React.createElement('button', {
                key: 'yes', type: 'button',
                className: 'dsm-btn' + (m.mode === 'off' || m.mode === 'clear' || m.mode === 'clearLocal' ? ' dsm-btn-danger' : ''),
                disabled: yesDisabled, onClick: submitTokenModal,
              }, yesLabel),
              React.createElement('button', {
                key: 'cancel', type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: closeTokenModal,
              }, t('compat.token.edit.cancel'))]))))
      }

      // 注入设置块：本插件注入给模型哪些内容的开关。总开关只管
      // "极简这类预设下要不要破例"，五个域勾选在任何预设下都生效。
      //
      // 排版口径（用户裁定 2026-09-16）：勾选**横排**（短标签一行放得下，不再一人一行竖着排），
      // 文案只说到"有这个内容"为止 —— 用户是普通使用者，不解释 persona/载体/路径这些内部机制。
      if (inject) {
        const domains = (inject && inject.domains) || {}
        push(section(t('compat.inject'), t('compat.inject.hint'),
          React.createElement('div', { className: 'dsm-inject-settings' },
            React.createElement('label', { className: 'dsm-pick' },
              React.createElement('input', { type: 'checkbox', checked: inject.underSuppressingPresets === true, onChange: function () { saveInject({ underSuppressingPresets: inject.underSuppressingPresets !== true }) } }),
              React.createElement('span', { className: 'dsm-pick-main' },
                React.createElement('span', { className: 'dsm-pick-name' }, t('compat.inject.force')),
                React.createElement('span', { className: 'dsm-pick-desc' }, t('compat.inject.force.desc')))),
            React.createElement('div', { className: 'dsm-seg-group' },
              React.createElement('span', null, t('compat.inject.domains')),
              React.createElement('span', { className: 'dsm-seg-group-line' })),
            React.createElement('div', { className: 'dsm-inject-domains' },
              ['memory', 'mcp', 'skills', 'subagents', 'prompt'].map(function (key) {
                // 技能与提示词两域在标准类预设下由宿主送、本插件让位 —— 关掉它们时本插件会连
                // 宿主那条一起拦下（见 context-inject.ts 的 officialKindsToSuppress）。这里给
                // 那两项一句 title，免得用户以为"关了没用"。
                const carrier = key === 'skills' || key === 'prompt'
                return React.createElement('label', { className: 'dsm-inject-domain', key: 'domain-' + key, title: carrier ? t('compat.inject.domain.carrier.title') : undefined },
                  React.createElement('input', { type: 'checkbox', checked: domains[key] !== false, onChange: function () {
                    const nextDomains = Object.assign({}, domains)
                    nextDomains[key] = domains[key] === false
                    saveInject({ domains: nextDomains })
                  } }),
                  React.createElement('span', null, t('compat.inject.domain.' + key)))
              })))))
      }
      // 注入实况：紧挨「注入」设置块下方。数据来自 `injection-live`（宿主读最近活跃会话的
      // 可见表面），是"回放"不是"重算"—— 界面显示已注入而模型实际没收到时（场景接管、
      // 压制型预设、开关被关、压缩后还没补发），这里一眼可见。
      // 排版口径：与可达性矩阵同款（名称 + 状态胶囊），正文默认收起、点域名展开；
      // 体积与 ≈tokens 只做展示（token 是估算，标「≈」）。
      if (live) {
        const domainLabel = function (key) { return t('compat.inject.domain.' + key) }
        const fmtSize = function (bytes) {
          var v = Number(bytes) || 0
          if (v < 1024) return v + ' B'
          return (Math.round((v / 1024) * 10) / 10) + ' KB'
        }
        // 中英混合估算：ASCII 按 4 字符/词、非 ASCII 按 2 字符/词（只影响展示）。
        const estTokens = function (text) {
          var ascii = 0
          var wide = 0
          for (var i = 0; i < text.length; i += 1) { if (text.charCodeAt(i) < 128) ascii += 1; else wide += 1 }
          return Math.ceil(ascii / 4 + wide / 2)
        }
        // 状态 → 胶囊：绿 = 本插件注入且已在上下文；琥珀只留给"该投却没投"。
        // 官方载体（技能 / 提示词在标准类预设下由官方送）、已关闭、无内容一律灰的
        // —— 它们都不是问题，报成琥珀会把用户自己的选择读成故障（用户 2026-09-16 指出）。
        const stateOf = function (row) {
          if (row.state === 'in-context') return { cls: ' dsm-compat-pill-ok', text: t('compat.live.state.inContext'), title: '' }
          if (row.state === 'absent') return { cls: ' dsm-compat-pill-warn', text: t('compat.live.state.absent'), title: t('compat.live.state.absent.title') }
          if (row.state === 'official') return { cls: '', text: t('compat.live.state.official'), title: t('compat.live.state.official.title') }
          if (row.state === 'off') return { cls: '', text: t('compat.live.state.off'), title: '' }
          if (row.state === 'empty') return { cls: '', text: t('compat.live.state.empty'), title: '' }
          if (row.state === 'cleared') return { cls: '', text: t('compat.live.state.cleared'), title: '' }
          // 子会话不适用：与「已关闭 / 无内容」同档的灰 —— 它是设计选择，不是故障。
          if (row.state === 'child') return { cls: '', text: t('compat.live.state.child'), title: t('compat.live.state.child.title') }
          return { cls: '', text: t('compat.live.state.unknown'), title: '' }
        }
        // 采纳一行：注入 N 次 / 调用 M 次 / 其中"调用时正文就在眼前"K 次。
        // 只在真的投递过该域时出现 —— 从没投过的域摆一行 0 只是噪声。
        const adoptText = function (row) {
          const a = row.adoption || {}
          const injected = Number(a.injected) || 0
          if (injected === 0) return ''
          const used = Number(a.used) || 0
          if (used === 0) return t('compat.live.adopt.none', { injected: injected })
          return t('compat.live.adopt', { injected: injected, used: used, adopted: Number(a.adopted) || 0 })
        }
        // 有正文的域就是"模型看到的内容"：本插件注入的与官方注入的（技能 / 提示词）都算。
        const hasText = function (row) { return (row.state === 'in-context' || row.state === 'official') && row.text !== '' }
        const copyAll = function () {
          const parts = []
          ;(live.domains || []).forEach(function (row) {
            if (hasText(row)) parts.push('## ' + domainLabel(row.key) + '\n' + row.text)
          })
          const text = parts.join('\n\n')
          if (!text) return
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () {
                setLiveCopied(true)
                setTimeout(function () { setLiveCopied(false) }, 1500)
              })
            }
          } catch (e) { /* 剪贴板不可用就算了：正文仍可手动选中复制 */ }
        }
        const delivered = live.delivered || {}
        const deliveredText = delivered.count > 0
          ? t('compat.live.delivered', { count: delivered.count, time: new Date(delivered.lastAt).toTimeString().slice(0, 5) })
          : t('compat.live.never')
        // 观测面：本进程到底看到过几次本插件的工具调用。必须显示 —— 采纳全是 0 时，
        // 要能分清"模型真的没用"（结论）和"遥测没接上"（故障）。
        const observedCalls = Number((live.observed || {}).toolCalls) || 0
        const observedText = observedCalls > 0
          ? t('compat.live.observe.some', { count: observedCalls })
          : t('compat.live.observe.none')
        const canCopy = (live.domains || []).some(hasText)
        push(React.createElement('section', { className: 'dsm-compat-section' },
          React.createElement('div', { className: 'dsm-compat-section-head' },
            React.createElement('h3', { className: 'dsm-compat-section-title' }, t('compat.live.title')),
            React.createElement('span', { className: 'dsm-compat-section-hint' }, t('compat.live.hint') + ' · ' + deliveredText + ' · ' + observedText),
            React.createElement('span', { className: 'dsm-inject-live-actions' },
              React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: !canCopy, onClick: copyAll },
                liveCopied ? t('compat.live.copied') : t('compat.live.copy')))),
          // 边框只包内容、小标题留在框外（与「访问令牌」同一口径，照「注入」那一块的样子）。
          React.createElement('div', { className: 'dsm-compat-box' },
            live.hasAgent === false
              ? React.createElement('div', { className: 'dsm-empty' }, t('compat.live.noAgent'))
              : React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              (live.domains || []).map(function (row) {
                const st = stateOf(row)
                const open = liveOpen === row.key
                const canOpen = hasText(row)
                const adopt = adoptText(row)
                return React.createElement('div', { className: 'dsm-compat-mod-row', key: row.key },
                  // 域名 + 体积 + 采纳统计都在**同一格**里，不要拆成三个网格子项。
                  // 这行是两列网格（名字 minmax(0,1fr) | 状态胶囊 max-content），第一行只能放两个子项；
                  // 多塞一个会把胶囊挤到第二行，而第二行落在 1fr 那一列里 → 胶囊被拉成整行宽
                  // （用户 2026-09-17 看到"在上下文中跑到下面"就是这个）。采纳统计与体积同性质
                  // （都是关于这个域的统计），跟着名字走；右列只留状态，胶囊右缘才能跨行对齐。
                  React.createElement('span', { className: 'dsm-compat-name dsm-inject-live-name' },
                    // 展开箭头只有"有正文可看"的行才有。但**它占的位置必须给没正文的行留着** ——
                    // 否则那几行的域名会比别行左移一个字宽，整列名字就参差不齐（用户 2026-09-17 指出）。
                    // 用一个 `visibility:hidden` 的同字符占位，而不是给不可展开的行画一个点了没反应的
                    // 箭头：宽度逐像素一致，且不假装它可点。
                    canOpen
                      ? React.createElement('button', { type: 'button', className: 'dsm-inject-live-toggle', onClick: function () { setLiveOpen(open ? '' : row.key) } },
                        (open ? '▾ ' : '▸ ') + domainLabel(row.key))
                      : React.createElement('span', { className: 'dsm-inject-live-static' },
                        React.createElement('span', { className: 'dsm-inject-live-mark-blank', 'aria-hidden': 'true' }, '▸ '),
                        domainLabel(row.key)),
                    canOpen
                      ? React.createElement('span', { className: 'dsm-inject-live-size' }, '· ' + fmtSize(row.bytes) + ' · ' + t('compat.live.est', { count: estTokens(row.text) }))
                      : null,
                    // 分隔符「· 」**恒定带上**：体积那一段自带一个前导「· 」，采纳这段也得有，
                    // 否则拿不到体积（状态是"已关闭 / 未投递"）时会挤成「提示词注入 3 次」。
                    adopt ? React.createElement('span', { className: 'dsm-inject-live-adopt', title: t('compat.live.adopt.title') }, '· ' + adopt) : null),
                  React.createElement('span', { className: 'dsm-compat-pill' + st.cls, title: st.title || undefined }, st.text),
                  open && canOpen ? React.createElement('pre', { className: 'dsm-code dsm-compat-mod-self' }, row.text) : null)
              })))))
      }
      if (error) body.push(React.createElement('div', {
        // CompatPage 在 apply **之外**，用不了 apply 内的 `Notice`（那会白屏），所以这里
        // 按本页既有写法手工拼；令牌没过时同样要挂跳转按钮 —— 本页就是目的地，按下即聚焦输入框。
        className: 'dsm-feedback dsm-error' + (isTokenGateText(error) ? ' dsm-feedback-row' : ''),
        role: 'alert',
      },
        React.createElement('span', { className: 'dsm-feedback-text' }, t('compat.failed') + ': ' + error),
        isTokenGateText(error) ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: openTokenPanel }, t('token.jump')) : null))
      // 体检要跑一轮宿主能力探测，不是瞬时的：此前这一段是空白，用户点「刷新」后看不到任何反馈。
      if (busy && !data && !error) body.push(React.createElement('div', { className: 'dsm-empty' }, t('compat.checking')))
      else if (!busy && !data && !error) body.push(React.createElement('div', { className: 'dsm-empty' }, t('compat.empty')))

      if (data) {
        // 结论条：一句话说清"现在能不能安全动数据"。边框颜色只表达"有没有事"，
        // 与"官方少了几个入口"无关 —— 那些入口缺失时插件自己顶上，不算异常。
        // 这句在客户端按当前语言拼（服务端的 compat-status 只给结构化字段，
        // 它自带的 summary 是中文，直接渲染会让英文界面露出中文）。
        const findingsN = Array.isArray(data.findings) ? data.findings.length : 0
        const degradedN = Array.isArray(data.degraded) ? data.degraded.length : 0
        const summaryText = findingsN === 0
          ? (data.summary || '')
          : t(degradedN === 0 ? 'compat.summary.ok' : 'compat.summary.degraded')
            .replace('{version}', String((data.host && data.host.version) || '?'))
            .replace('{ok}', String(findingsN - degradedN))
            .replace('{total}', String(findingsN))
            .replace('{count}', String(degradedN))
        push(React.createElement('div', { className: 'dsm-compat-bar' + (blockedCount > 0 ? ' dsm-compat-bar-warn' : '') },
          React.createElement('span', { className: 'dsm-compat-dot' + (blockedCount > 0 ? ' dsm-compat-dot-warn' : '') }),
          React.createElement('strong', null, blockedCount > 0 ? t('compat.state.blocked') : t('compat.state.ok')),
          React.createElement('span', { className: 'dsm-compat-sum' }, summaryText)))

        // 指标卡：宿主 / 本插件适配版本 / 可用能力（含插件自补的 optional 槽位）。
        push(React.createElement('div', { className: 'dsm-compat-grid' },
          card(t('compat.host'), (data.host && data.host.version) || '?', t('compat.peer') + ' ≥ ' + (data.minHostVersion || '-'), false),
          card(t('compat.verified'), data.verifiedVersion || '?', t('compat.verified.note'), false),
          card(t('compat.caps'), String(usableCount) + '/' + String(findings.length),
            blockedCount > 0
              ? t('compat.caps.degraded').replace('{count}', String(blockedCount))
              : (usableCount === findings.length ? t('compat.caps.all') : t('compat.caps.substituted')),
            blockedCount > 0)))

        // 版本栅栏（B3）：实际宿主与本插件验证过的版本不同时说出来 —— 否则"照旧版本的印象
        // 判断"会让人把探测结果当成 bug。只提示、不拦（peer 保持无上界是既定决策）。
        const hostVersion = (data.host && data.host.version) || ''
        if (hostVersion && data.verifiedVersion && hostVersion !== data.verifiedVersion) {
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.host.mismatch')
              .replace('{host}', String(hostVersion))
              .replace('{verified}', String(data.verifiedVersion))))
        }

        // 功能总览（B6）：一行一个功能点，状态 = 装配层 + 宿主能力层 + 用户配置层 的合成
        // （服务端聚合，见 feature-overview）。行可点，跳到该功能所在的页签。
        if (features && Array.isArray(features.rows) && features.rows.length) {
          push(section(t('compat.features'), t('compat.features.hint'),
            React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              features.rows.map(function (row) {
                const cls = row.state === 'ok' ? 'dsm-compat-pill-ok'
                  : (row.state === 'disabled' || row.state === 'locked') ? ''
                    : 'dsm-compat-pill-warn'
                return React.createElement('div', {
                  className: 'dsm-compat-mod-row' + (row.tab ? ' dsm-compat-row-link' : ''),
                  key: row.key,
                  role: row.tab ? 'button' : undefined,
                  tabIndex: row.tab ? 0 : undefined,
                  onClick: row.tab ? function () { jumpToTab(row.tab) } : undefined,
                },
                  React.createElement('span', { className: 'dsm-compat-name' }, row.label),
                  React.createElement('span', { className: 'dsm-compat-pill ' + cls },
                    t('compat.feature.state.' + String(row.state || 'unknown'))),
                  React.createElement('span', { className: 'dsm-compat-mod dsm-compat-mod-self' },
                    React.createElement('span', { className: 'dsm-compat-label' }, t('compat.reason')),
                    row.detail))
              }))))
        }

        // 阻塞项放最前：这是唯一"必须动手"的东西。
        if (blockers.length) {
          push(section(t('compat.blockers'), null,
            React.createElement('div', { className: 'dsm-feedback dsm-error' },
              React.createElement('ul', { className: 'dsm-compat-list' },
                blockers.map(function (item, i) { return React.createElement('li', { key: i }, item) })))))
        }

        // 动作可用性：一行一个动作 + 路径标记（不可用的标红）。
        push(section(t('compat.ops'), t('compat.ops.hint'),
          React.createElement('div', { className: 'dsm-compat-mod-list' },
            React.createElement('div', { className: 'dsm-compat-table-head' },
              React.createElement('span', null, t('compat.op.name')),
              React.createElement('span', null, t('compat.op.state'))),
            Object.keys(OPERATION_LABELS).map(function (op) {
              const via = routes[op]
              return React.createElement('div', { className: 'dsm-compat-mod-row', key: op },
                React.createElement('span', { className: 'dsm-compat-name' }, t(OPERATION_LABELS[op])),
                React.createElement('span', { className: routeClass(via) }, routeText(via)))
            }))))

        if (unavailableCount > 0) {
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.ops.disabled').replace('{count}', String(unavailableCount))))
        }

        // 真降级：名称 + 后果 + 原因。原因必须给全，否则用户只看到"不可用"。
        if (degraded.length) {
          push(section(t('compat.degraded'), t('compat.degraded.hint'),
            React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              degraded.map(function (item) {
                return React.createElement('div', { className: 'dsm-compat-mod-row', key: item.id },
                  React.createElement('span', { className: 'dsm-compat-name' }, item.label),
                  React.createElement('span', { className: 'dsm-compat-pill dsm-compat-pill-warn' },
                    item.fallback === 'native-entry' ? t('compat.fallback.native')
                      : item.fallback === 'refuse-operation' ? t('compat.fallback.refuse')
                      : item.fallback === 'inform-only' ? t('compat.fallback.inform')
                      : t('compat.fallback.blocked')),
                  React.createElement('span', { className: 'dsm-compat-mod dsm-compat-mod-self' },
                    React.createElement('span', { className: 'dsm-compat-label' }, t('compat.reason')),
                    item.detail))
              }))))
        }

        // 其它非 ok 项：`optional` 表示"宿主没有这个入口，插件自己顶上"——功能完好，
        // 既不算降级，也不能说按钮被禁用（那句只对真降级成立；早先把两者混在一起
        // 会让用户以为删除功能坏了，实际它照常可用）。
        const optionalAbsent = findings.filter(function (item) { return item.state !== 'ok' && item.optional === true })
        if (optionalAbsent.length) {
          push(section(t('compat.others'), t('compat.others.hint'),
            React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              optionalAbsent.map(function (item) {
                return React.createElement('div', { className: 'dsm-compat-mod-row', key: item.id },
                  React.createElement('span', { className: 'dsm-compat-name' }, item.label),
                  React.createElement('span', { className: 'dsm-compat-pill' }, t('compat.fallback.substituted')),
                  React.createElement('span', { className: 'dsm-compat-mod dsm-compat-mod-self' },
                    React.createElement('span', { className: 'dsm-compat-label' }, t('compat.reason')),
                    item.detail))
              }))))
        }

        // 模块实体：一行一个包，右侧是"同一份模块 / 两份拷贝"。
        push(section(t('compat.modules'), t('compat.modules.hint'),
          React.createElement('div', { className: 'dsm-compat-mod-list' },
            Object.keys(sameAsHost).map(function (name) {
              const same = sameAsHost[name]
              const cls = same === true ? 'dsm-compat-pill-ok' : same === false ? 'dsm-compat-pill-bad' : ''
              const text = same === true ? t('compat.module.same') : same === false ? t('compat.module.separate') : t('compat.module.unknown')
              return React.createElement('div', { className: 'dsm-compat-mod-row', key: name },
                React.createElement('span', { className: 'dsm-compat-name dsm-compat-mod' }, name),
                React.createElement('span', { className: 'dsm-compat-pill ' + cls }, text))
            }))))

        // 「无法比对」必须给原因：否则一排未知标记看起来只是噪音，用户会当成正常现象。
        if (unverified.length) {
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.modules.unverified')
              .replace('{count}', String(unverified.length))
              .replace('{names}', unverified.join('、'))))
        }

        push(React.createElement('p', { className: 'dsm-help' },
          t('compat.hint.doctor'),
          React.createElement('code', { className: 'dsm-compat-code' }, ' node scripts/doctor.mjs')))
      }

      // 预设注入边界：五类内容（记忆 / 全局提示词 / 技能 / MCP / 子智能体）在**每个 Agent
      // 预设**下到不到得了模型。回答的是"面板标着已注入，模型真的看得到吗"——本插件的
      // 注入由它自己在每步发出（极简这类预设下默认不发，可用上面的「注入」块强制），
      // 而全局提示词与技能目录还要看官方那两条行挂没挂（极简都没挂）。单独一块：取不到时
      // 这一节不显示，不影响上面的结论。
      //
      // 排版口径（用户裁定 2026-09-15）：每格一枚描边标签，**绿框=能用、红框=不能用、
      // 灰框=判断不了**；不再出现 ✓/✗ 符号，也不再有任何整行的解释文字 —— 预设损坏与
      // 解析失败缩成预设名旁边的小标签。MCP 与子智能体两列由宿主侧的 preset-reach 给出。
      if (presetReach && Array.isArray(presetReach.rows) && presetReach.rows.length) {
        push(section(t('compat.reach'), t('compat.reach.hint'),
          React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
            presetReach.rows.map(function (row) {
              // ok → 绿框；absent / suppressed → 红框；其余（unknown，含宿主还没回传该字段）
              // 一律灰框，绝不把"读不到"画成"不能用"。
              const chip = function (label, state) {
                const kind = state === 'ok' ? 'ok' : (state === 'absent' || state === 'suppressed') ? 'bad' : 'unknown'
                return React.createElement('span', { className: 'dsm-reach-chip dsm-reach-' + kind, key: label }, label)
              }
              const tags = []
              if (row.suppressing) tags.push(React.createElement('span', { className: 'dsm-tag dsm-tag-off', key: 'suppressing' }, t('compat.reach.suppressing')))
              if (row.broken) tags.push(React.createElement('span', { className: 'dsm-tag dsm-tag-off', key: 'broken' }, t('compat.reach.broken')))
              else if (row.reason) tags.push(React.createElement('span', { className: 'dsm-tag', key: 'reason' }, t('compat.reach.whyUnknown')))
              return React.createElement('div', { className: 'dsm-compat-mod-row', key: row.presetId },
                React.createElement('span', { className: 'dsm-compat-name dsm-reach-name' },
                  React.createElement('span', null, (row.name || row.presetId) + (row.isDefault ? ' · ' + t('compat.reach.default') : '')),
                  tags.length ? React.createElement('span', { className: 'dsm-tags' }, tags) : null),
                // 芯片顺序与「注入」块的勾选顺序一致（用户裁定 2026-09-16）：
                // 场景和记忆 → MCP → 技能 → 子智能体 → 提示词。
                React.createElement('span', { className: 'dsm-compat-reach-marks' },
                  chip(t('compat.reach.mark.memory'), row.memory),
                  chip(t('compat.reach.mark.mcp'), row.mcp),
                  chip(t('compat.reach.mark.skill'), row.skillCatalog),
                  chip(t('compat.reach.mark.subagent'), row.subagent),
                  chip(t('compat.reach.mark.agentsMd'), row.agentsMd)))
            }))))

        // 页脚用「标题 + 条目」清单，与导入弹窗的「文件要求」同款结构与样式（用户裁定
        // 2026-09-16 第二版：条目要短、不列路径与内部机制，使用者知道"有这回事"就够）。
        push(React.createElement('div', { className: 'dsm-upload-requirements' },
          React.createElement('div', { className: 'dsm-label' }, t('compat.reach.tools.title')),
          React.createElement('ul', null,
            [1, 2, 3].map(function (n) {
              return React.createElement('li', { key: n }, t('compat.reach.tools.' + n))
            }))))
      }

      // ── 清理旧备份（兼容页，紧挨「刷新」）──────────────────────────────────────
      // 每份 patch 备份都是**整份配置文件的副本**，env / headers 与令牌在里面是明文。
      // 自动剪枝只保证"每个层级最多 5 份"，不提供"我现在就想清掉多余副本"的出口 —— 而这 5 份
      // 常常挤在几分钟内（本机实测 4 分钟），对回滚几乎没价值、对密钥扩散全是成本。
      // 删除不可逆，所以先拉清单、把"将删几份"摆在按钮上，再让人确认。
      //
      // ⚠⚠ **CompatPage 在 `apply` 之外**（见本文件顶部与下方弹窗处的说明），所以它
      // **引用不到 `apply` 内的任何东西** —— 包括 `Modal` 与 `fmtBytes`。引用了就是渲染期
      // ReferenceError，React 卸载整棵组件树、整个设置面板变空白（2026-09-19 真踩了一次：
      // 点「清理旧备份」直接白屏）。所以这里的弹窗与体积文案都按本页既有写法手工拼，
      // 不用 `Modal`。动这段之前先确认那个符号是不是也在 `apply` 里面。
      // 「删除几份」的档位：**每个层级各自选一份数**（用户裁定 2026-09-19）。此前是一组共用的
      // "各删 N 份"，那条口径有个说不圆的地方：两个层级的份数常常不等（本机实测 4 / 5），
      // 两边都够时总数是偶数，份数少的那层先删光、步长就断了 —— 选「各 5 份」得到 9（奇数），
      // 选中的档位与"删了几个"对不上。逐层级各选一份，任意总数（奇偶都行）都能表达：
      // 全局删 1 + 配置删 2 = 合计 3。
      // 每层档位 = 1..该层现有份数。5 是自动剪枝的封顶（正常每层 ≤ 5），所以档位通常正好
      // 是 1..现有份数；万一手工塞进来更多，仍封顶 5 档，免得摆出一排按钮。
      const BACKUP_DELETE_MAX_TIERS = 5
      // 每层默认删 2 份：跑满的层级（5 份）留 3 份，够回滚一次配置改动，又确实把明文副本压下来。
      const BACKUP_DELETE_DEFAULT = 2
      const backupSizeText = function (n) {
        const v = Number(n) || 0
        if (v < 1024) return v + ' B'
        if (v < 1024 * 1024) return Math.ceil(v / 1024) + ' KB'
        return (v / 1024 / 1024).toFixed(1) + ' MB'
      }
      // 层级显示名（宿主 backupLevelOf 给的是 global / profile:<名> / legacy）。只做名字映射，
      // 不认识的层级原样显示 —— 猜错了比显示原文更坏。
      const backupLevelLabel = function (level) {
        if (level === 'global') return t('compat.backups.level.global')
        if (level.indexOf('profile:') === 0) return t('compat.backups.level.profile', { name: level.slice(8) })
        if (level === 'legacy') return t('compat.backups.level.legacy')
        return level
      }
      // 逐层级明细：每层现有几份、这一层选了几份、删完还剩几份。与删除那边同一套分组口径；
      // 顺序固定 global → profile:* → legacy → 其它（按名），免得同一份清单两次打开顺序还不一样。
      // `delByLevel` 是**每层各删几份**（键就是层级标签，宿主按同一套标签删）；清单新的在前，
      // 所以留下前 `count - del` 份，del 超过该层份数就删空该层。
      const backupBreakdown = function (files, delByLevel) {
        const del = delByLevel || {}
        const byLevel = {}
        for (const f of (files || [])) (byLevel[f.level] = byLevel[f.level] || []).push(f)
        const rank = function (lv) { return lv === 'global' ? 0 : lv.indexOf('profile:') === 0 ? 1 : lv === 'legacy' ? 2 : 3 }
        return Object.keys(byLevel).sort(function (a, b) { return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0) })
          .map(function (lv) {
            const n = byLevel[lv].length
            const doomed = Math.min(n, Math.max(0, Number(del[lv]) || 0))
            return { level: lv, count: n, kept: n - doomed, doomed: doomed }
          })
      }
      const doomedForDelete = function (files, delByLevel) {
        let n = 0
        for (const row of backupBreakdown(files, delByLevel)) n += row.doomed
        return n
      }
      /** 每层的默认档位：删 2 份（少于 2 份的层就是它全部份数）。 */
      const defaultDelByLevel = function (files) {
        const out = {}
        for (const row of backupBreakdown(files, null)) out[row.level] = Math.min(BACKUP_DELETE_DEFAULT, row.count)
        return out
      }
      const openBackupClean = function () {
        setBackupClean({ files: null, delByLevel: {}, confirming: false, loading: true })
        apiCall('backups-list', {})
          .then(function (r) {
            if (!r || !r.ok) { setBackupClean({ files: [], delByLevel: {}, confirming: false, error: (r && r.error) || t('compat.backups.loadFailed') }); return }
            setBackupClean({ files: r.files || [], delByLevel: defaultDelByLevel(r.files || []), confirming: false })
          })
          .catch(function (e) { setBackupClean({ files: [], delByLevel: {}, confirming: false, error: errMsg(e) }) })
      }
      /**
       * 真正落盘删。
       *
       * @param patch 与当前状态合并的额外字段。**必须**由调用方把 `confirming: false` 传进来：
       *   下面每次 setBackupClean 都从闭包快照派发，两次调用会把第一步写下的
       *   `confirming: true` 又盖回去 —— 按了「确认永久删除」却还停在确认态。
       */
      const doBackupClean = function (patch) {
        if (!backupClean) return
        const delByLevel = backupClean.delByLevel || {}
        setBackupClean(Object.assign({}, backupClean, { busy: true, confirming: false }, patch || {}))
        apiCall('backups-clean', { del: delByLevel })
          .then(function (r) {
            if (!r || !r.ok) {
              setBackupClean(Object.assign({}, backupClean, { busy: false, confirming: false, error: (r && r.error) || t('compat.backups.cleanFailed') }))
              return
            }
            // 失败原因（文件被占用等）由界面按当前语言拼：宿主只回结构化字段，
            // 回中文串会让英文界面原样露出中文（与 compat-status 的 summary 同一条纪律）。
            setBackupClean(Object.assign({}, backupClean, {
              busy: false, confirming: false, removed: r.removed || 0, kept: r.kept || 0,
              failedCount: r.failedCount || 0, failedNames: r.failedNames || [], files: [],
            }))
            loadBackups(true)
          })
          .catch(function (e) { setBackupClean(Object.assign({}, backupClean, { busy: false, confirming: false, error: errMsg(e) })) })
      }
      let backupModal = null
      if (backupClean) {
        const files = backupClean.files || []
        const delByLevel = backupClean.delByLevel || {}
        // 清单回落时（比如刚删完）把已选档位夹回该层现有份数，别停在一个已经不存在的档上。
        const breakdown = backupBreakdown(files, delByLevel).map(function (row) {
          const del = Math.min(row.count, Math.max(0, Number(delByLevel[row.level]) || 0))
          return { level: row.level, count: row.count, kept: row.count - del, doomed: del }
        })
        const doomed = doomedForDelete(files, delByLevel)
        // 弹窗自己的忙碌态。**不要**叫 busy：那是本页「刷新」的状态，同名会看错。
        const dialogBusy = !!backupClean.busy || !!backupClean.loading
        const done = backupClean.removed !== undefined
        const rows = []
        // ① 说明：不裁剪、不写文件名、不用字面 `**`（`**` 在这里不会被渲染成加粗，用户看到
        //    的就是两个星号）。用 `.dsm-desc-plain` —— `.dsm-desc` 有 2 行裁剪，照搬进来
        //    会把这段话截断（此前就是截到「而它们常常挤…」）。
        rows.push(React.createElement('p', { className: 'dsm-desc-plain', key: 'desc' }, t('compat.backups.desc')))
        rows.push(React.createElement('p', { className: 'dsm-help', key: 'count' },
          t('compat.backups.count', { count: files.length, size: backupSizeText(files.reduce(function (s, f) { return s + (f.size || 0) }, 0)) })))
        // ② 删除份数：**每个层级一行自己的档位**（用户裁定 2026-09-19）。共用一组"各删 N 份"
        //    时，两份不等量就凑不出奇数总数（4+5 选 5 得 9，选中档位与"删了几个"对不上）；
        //    逐层各选一份，任意总数都能表达：全局删 1 + 配置删 2 = 合计 3。
        //    每行 = 层级名 + 档位组 + 一句"删完还剩几份"（这一层的全部后果都在这一行里，
        //    所以不再另列一份明细表去重复它）。共用同一个 `delByLevel`，键就是层级标签。
        if (!backupClean.loading && !backupClean.error && breakdown.length) {
          rows.push(React.createElement('span', { className: 'dsm-label', key: 'del-label' }, t('compat.backups.del')))
          for (const row of breakdown) {
            const label = backupLevelLabel(row.level)
            const tiers = []
            for (let n = 1; n <= Math.min(row.count, BACKUP_DELETE_MAX_TIERS); n++) tiers.push(n)
            rows.push(React.createElement('div', { className: 'dsm-field', key: 'del-' + row.level },
              React.createElement('span', { className: 'dsm-label' }, label),
              React.createElement('div', { className: 'dsm-actions', role: 'group', 'aria-label': label },
                tiers.map(function (n) {
                  return React.createElement('button', {
                    key: n, type: 'button', disabled: dialogBusy,
                    'aria-pressed': n === row.doomed,
                    className: 'dsm-btn dsm-btn-quiet' + (n === row.doomed ? ' dsm-btn-picked' : ''),
                    // 换档位顺手把两步确认收回去：这一按等于"重新考虑过了"。
                    onClick: function () {
                      const next = Object.assign({}, delByLevel)
                      next[row.level] = n
                      setBackupClean(Object.assign({}, backupClean, { delByLevel: next, confirming: false }))
                    },
                  }, t('compat.backups.delOption', { count: n }))
                })),
              React.createElement('p', { className: 'dsm-help' },
                row.kept > 0
                  ? t('compat.backups.levelKeep', { count: row.count, kept: row.kept })
                  : t('compat.backups.levelClear', { count: row.count }))))
          }
        }
        // 合计（到底会删掉几个文件）只在按下删除后的确认行里出现一次。
        rows.push(React.createElement('p', { className: 'dsm-help', key: 'will' },
          doomed > 0 ? t('compat.backups.irreversible') : t('compat.backups.nothing')))
        if (backupClean.loading) rows.push(React.createElement('div', { className: 'dsm-empty', key: 'loading' }, t('compat.backups.loading')))
        if (backupClean.error) rows.push(React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert', key: 'err' }, backupClean.error))
        if (backupClean.failedCount) {
          rows.push(React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'alert', key: 'warn' },
            t('compat.backups.warnFailed', { count: backupClean.failedCount, names: (backupClean.failedNames || []).join('、') })))
        }
        if (done) {
          rows.push(React.createElement('div', { className: 'dsm-feedback', key: 'done' },
            t('compat.backups.done', { removed: backupClean.removed, kept: backupClean.kept })))
        }
        // ④ 动作：底部行里**只有**这一步该做的事，右上「关闭」是全弹窗唯一的出口 ——
        //    此前底部还常驻一颗「取消」，与右上那颗完全同义（用户 2026-09-19：「功能冗余、
        //    层级浪费」）。两步确认的第 2 步就地替换（同回收站「永久删除」，不叠弹窗）。
        //    完成后不再摆动作行：那时底部再放一颗「关闭」又是重复。
        if (!done) {
          if (backupClean.confirming) {
            rows.push(React.createElement('p', { className: 'dsm-help dsm-rule-hint', key: 'ask' },
              t('compat.backups.confirm.ask', { count: doomed })))
            rows.push(React.createElement('div', { className: 'dsm-modal-actions', key: 'actions' },
              React.createElement('button', {
                type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: dialogBusy,
                onClick: function () { setBackupClean(Object.assign({}, backupClean, { confirming: false })) },
              }, t('btn.cancel')),
              React.createElement('button', {
                type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: dialogBusy,
                onClick: function () { doBackupClean() },
              }, t('compat.backups.confirm.yes'))))
          } else {
            rows.push(React.createElement('div', { className: 'dsm-modal-actions', key: 'actions' },
              React.createElement('button', {
                type: 'button', className: 'dsm-btn dsm-btn-danger',
                disabled: dialogBusy || doomed <= 0,
                onClick: function () { setBackupClean(Object.assign({}, backupClean, { confirming: true })) },
              }, t('compat.backups.confirm'))))
          }
        }
        // 手工拼弹窗（不能用 `Modal`：它在 apply 内，详见上方注释）。结构与 `Modal` 一致 ——
        // 遮罩点击关闭 + 头部标题/关闭键 + body + 底部动作行 —— 键盘行为（Esc 关闭 / Tab 焦点
        // 陷阱）复用模块作用域的那三个函数（见 refreshButton 上方），打开时把焦点交给弹窗自己。
        // 这里**不**挂令牌提示（`TokenGateNotice` 在 apply 内，引它=白屏）：删除被令牌挡下时
        // 弹窗自己的错误行会如实显示那句话。
        backupModal = React.createElement('div', {
          key: 'backup-modal',
          className: 'dsm-mask',
          onMouseDown: function (e) { if (e.target === e.currentTarget) setBackupClean(null) },
        }, React.createElement('div', {
          ref: backupDialogRef, tabIndex: -1,
          className: 'dsm-modal dsm-modal-sm', role: 'dialog', 'aria-modal': 'true',
          'aria-labelledby': 'dsm-backup-clean-title',
          onKeyDown: function (e) { if (!handleModalEscape(e, function () { setBackupClean(null) })) trapModalFocus(e.currentTarget, e) },
        },
          React.createElement('div', { className: 'dsm-modal-head-wrap' },
            React.createElement('div', { className: 'dsm-modal-head' },
              React.createElement('h3', { className: 'dsm-modal-title', id: 'dsm-backup-clean-title' }, t('compat.backups.title')),
              React.createElement('button', {
                type: 'button', className: 'dsm-btn dsm-btn-secondary',
                onClick: function () { setBackupClean(null) },
              }, t('btn.close')))),
          React.createElement('div', { className: 'dsm-modal-body' }, rows)))
      }

      return React.createElement('div', { className: 'dsm-compat' },
        React.createElement('div', { className: 'dsm-head' },
          React.createElement('div', { className: 'dsm-title-block' },
            React.createElement('div', { className: 'dsm-title-row' },
              React.createElement('h2', { className: 'dsm-title' }, t('compat.title'))),
            React.createElement('p', { className: 'dsm-desc' }, t('compat.desc')))),
        React.createElement('div', { className: 'dsm-actions' },
          refreshButton(t, busy, { className: 'dsm-btn dsm-btn-secondary', disabled: busy, onClick: reload }),
          React.createElement('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn-secondary',
            disabled: busy,
            // 份数直接写进按钮文字：它是"要不要清理"的决策依据，只藏在 tooltip 里等于没有
            // （触屏上没有 hover）。体积放不进按钮，留在 title 里补一份。
            title: backups && backups.total
              ? t('compat.backups.btnTitle', { count: backups.total, size: backupSizeText(backups.totalSize || 0) })
              : t('compat.backups.btnHint'),
            onClick: openBackupClean,
          }, backups && backups.total ? t('compat.backups.btnCount', { count: backups.total }) : t('compat.backups.btn'))),
        body,
        backupModal,
        tokenModalEl)
    }

    // 曾经把导出写成 apply 方法体的最后两条语句（`module.exports.DICT = ...` /
    // `module.exports._pages = ...`），而 apply 开头是
    // `const slots = ctx.get('slots'); if (slots === undefined) return`。
    // 对象字面量在 factory 求值时就定了型，方法体里的追加却可能永远不执行——
    // 于是导出里查无 _pages。**任何导出都必须在 factory 作用域落地。**
    const _pages = {}
    // 中英两份词典。声明在 factory 作用域：apply 里的 ctx.locale 只是把它交给宿主，
    // 契约测试则直接从导出里读它（apply 提前返回也必须拿得到）。