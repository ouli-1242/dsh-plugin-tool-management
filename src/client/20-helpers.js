
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
    // 照样通、各域注入照样进上下文。宿主在客户端留了官方口子：`ctx.conversation.blocks`
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

    /**
     * 斜杠命令两段的挂载实况（由 48-slash.js 在注册时写入，兼容页那两枚标签读它）。
     * **按段记**：两段各自是一个源，各自挂没挂上可以不同（只注册了一个、或第二个源重名）。
     *
     * 为什么声明放在这里而不是 48 片：消费它的 CompatPage 在 20 片，比 48 片**早** —— 同一个
     * factory 作用域里函数声明提升没问题，但 `checkJs` 对这条跨片的反向引用会报 TS2304
     * （`npm run typecheck:client` 实测）。共享状态放在两个使用方的**共同上游**这一档。
     *
     * 服务端**不知道**挂没挂上（那是浏览器那半的事），所以这一句只能由客户端说；feature-overview
     * 那一行报的是开关状态，两者不是一回事，别拿一个冒充另一个（见 ops/compat.ts 同一处注释）。
     */
    let slashMountStates = { tools: 'pending', quickPrompts: 'pending' }
    function slashMountStateOf(key) { return slashMountStates[key] || 'pending' }
    /** 传 key 只改那一段；不传是"两段一起"（都关掉了、或整批注册失败）。 */
    function setSlashMount(state, key) {
      if (key) slashMountStates[key] = state
      else slashMountStates = { tools: state, quickPrompts: state }
    }

    /**
     * 一条全局轻提示（body 级，与页面/弹窗无关）。
     *
     * 为什么不是 `Notice`：`Notice` 长在页签里，而斜杠命令是在**对话页**按下的 —— 那时设置页
     * 根本没挂载，面板内的提示条无处可渲染。它与「令牌没填」那条横幅同源同位（40-apply-head.js
     * 的 body 级 append），差别只是这条会自动收。
     *
     * 同时只留一条：后发的直接覆写前一条（连点两下开关不该叠出两层提示）。
     */
    let toastEl = null
    let toastText = null
    let toastTimer = null
    function showPluginToast(text, kind) {
      try {
        if (typeof document === 'undefined' || !document.body) return
        const tone = kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : 'ok'
        if (!toastEl) {
          toastEl = document.createElement('div')
          toastEl.setAttribute('role', 'status')
          toastText = document.createElement('span')
          toastEl.appendChild(toastText)
          document.body.appendChild(toastEl)
        }
        toastText.textContent = String(text == null ? '' : text)
        toastEl.className = 'dsm-toast dsm-toast-' + tone
        toastEl.style.display = ''
        if (toastTimer) clearTimeout(toastTimer)
        // 报错那条留久一点：它常常是"得去设置页填令牌"这类要照着做的话。
        toastTimer = setTimeout(function () {
          if (toastEl) toastEl.style.display = 'none'
          toastTimer = null
        }, tone === 'err' ? 9000 : 4000)
      } catch (e) { /* DOM 不可用 → 只是少一条反馈，不影响已经生效的改动 */ }
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
