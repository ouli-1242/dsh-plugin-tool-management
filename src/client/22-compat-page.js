    /**
     * 「生效层级」分段控件的三档（只存键名，取词在渲染时做，跟着宿主语言走）。
     *
     * 顺序 = 从最粗到最细：关（全局一份）→ 按工作区 → 按对话。`global` 不是"第四种键"，
     * 而是**没有会话层** —— 也就是加会话管理之前的样子。
     */
    const SCOPE_MODE_OPTIONS = [
      { value: 'global', labelKey: 'compat.scopeMode.global', tipKey: 'compat.scopeMode.global.tip' },
      { value: 'workspace', labelKey: 'compat.scopeMode.workspace', tipKey: 'compat.scopeMode.workspace.tip' },
      { value: 'session', labelKey: 'compat.scopeMode.session', tipKey: 'compat.scopeMode.session.tip' },
    ]
    function CompatPage(props) {
      const t = props.t
      // 会话作用域（0.21.2）：工具表是**每个对话自己的整份名单**，这一页跟着顶部下拉走。
      // 全局那一层只编辑"新对话的默认模板"。
      const scopeSnap = React.useSyncExternalStore(subscribeScope, scopeSnapshot, scopeSnapshot)
      const scopeSessionId = scopeSnap.sessionId !== SCOPE_GLOBAL ? String(scopeSnap.sessionId || '') : ''
      const scopeSessionLocked = scopeSessionId !== '' && scopeSnap.locked === true
      // 隔离粒度（0.21.2）：会话 / 工作区。切换由服务端落盘并播种另一侧记录，这里只管往返与置灰。
      const scopeMode = scopeSnap.mode === 'workspace' ? 'workspace' : scopeSnap.mode === 'global' ? 'global' : 'session'
      const scopeIsWorkspaceMode = scopeMode === 'workspace'
      const scopeIsGlobalMode = scopeMode === 'global'
      const [scopeModeBusy, setScopeModeBusy] = React.useState(false)
      const [scopeModeError, setScopeModeError] = React.useState(null)
      // 坍缩摘要（0.21.2 审查 P1-2）：切到工作区粒度时，N 个对话的个性化设置收敛成 1 份，
      // 规则是「当前会话优先，否则项数最多」。不告知的话，用户会觉得「切一下我的设置全没了」。
      const [scopeModeNotice, setScopeModeNotice] = React.useState(null)
      const changeScopeMode = function (next) {
        const mode = next === 'workspace' ? 'workspace' : next === 'global' ? 'global' : 'session'
        if (scopeModeBusy || mode === scopeMode) return
        setScopeModeBusy(true)
        setScopeModeError(null)
        setScopeModeNotice(null)
        scopeSetMode(mode)
          .then(function (res) {
            setScopeModeBusy(false)
            if (!res || res.ok === false) { setScopeModeError((res && res.error) || t('compat.scopeMode.failed')); return }
            const sum = res.summary
            if (sum && sum.dropped > 0) {
              setScopeModeNotice(t('compat.scopeMode.collapsed', {
                workspaces: String(sum.workspaces),
                conversations: String(sum.conversations),
                dropped: String(sum.dropped),
              }))
              return
            }
            // 关掉隔离不是删除：那些会话 / 工作区设置原样留着，调回来就恢复。
            const kept = res.kept
            if (kept && kept.scopes > 0) {
              setScopeModeNotice(t('compat.scopeMode.kept', { scopes: String(kept.scopes) }))
            }
          })
          .catch(function (e) { setScopeModeBusy(false); setScopeModeError(errMsg(e)) })
      }
      const [data, setData] = React.useState(null)
      const [presetReach, setPresetReach] = React.useState(null)
      // 注入设置（本插件各注入域的开关，清单见 context-inject 的 INJECT_DOMAIN_KEYS）。它和可达性矩阵是一体两面：
      // 矩阵说"到不到得了"，这里决定"要不要"。读不到时这一节不显示。
      const [inject, setInject] = React.useState(null)
      // 斜杠命令入口（`/` 菜单里那个「工具」段）的开关。与 inject 同一类：读不到就不渲染这一节。
      const [slash, setSlash] = React.useState(null)
      // 模型工具表（哪些工具整份不发给模型；见 src/tools/table.ts）。与「注入」是两种省法：
      // 注入关掉省的是正文，这里关掉省的是工具 schema（工具表按每个请求付钱）。
      const [toolTable, setToolTable] = React.useState(null)
      // 保存往返期间把整块置灰（见 saveToolTable 的注释：不做乐观更新）。
      const [toolTableBusy, setToolTableBusy] = React.useState(false)
      // 会话锁 / 写失败的原因（不静默失败：用户得知道为什么勾了没保存）。
      const [toolTableError, setToolTableError] = React.useState(null)
      // 「方案」弹窗：null = 未打开。`mode:'save'` 给当前这套勾选起名存下来；
      // `mode:'apply'` 列出已存的方案 + 那条不可删的出厂默认，点一行就应用。
      const [toolPreset, setToolPreset] = React.useState(null)
      const toolPresetDialogRef = React.useRef(null)
      const toolPresetInputRef = React.useRef(null)
      // 与备份弹窗同一条依赖口径：用"开 / 关"这个布尔，不是整个 state —— 后者每改一次
      // （输入名字、busy）都会变，会把用户刚聚焦的输入框抢回弹窗根节点。
      React.useEffect(function () {
        if (!toolPreset || !toolPresetDialogRef.current) return
        toolPresetDialogRef.current.focus()
        // 存方案那条路用户是来打字的，光标直接放进输入框，省一次点击。
        if (toolPreset.mode === 'save' && toolPresetInputRef.current) toolPresetInputRef.current.focus()
      }, [!!toolPreset])
      // 注入实况（只读）：最近活跃会话里模型**真正看到**的各域文本 + 那一段对话的投递统计。
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
      // 令牌配置弹窗：null = 未打开；`{ mode: 'set'|'off'|'clear'|'on', current, next, repeat, value, forceProof }` = 已打开。
      // `forceProof`：宿主回了 badToken、但客户端先前以为不用凭证（状态陈旧）时就地补出凭证框，
      // 避免"点了确认却无从输入"的死路。
      // 四种配置操作（设置/修改、关闭保护、删除令牌、开启保护）共用**一个**弹窗 —— 表单
      // 一律不落在页面上（用户 2026-09-19 三次反馈：页面要"不跳来跳去"，功能要分类清楚），
      // 弹窗打开时页面纹丝不动，确认后弹窗收起、状态行自己更新。要求输两遍（用户裁定
      // 2026-09-19）与"再输一次当前令牌"的口径都在弹窗内执行。「锁定本机」只收紧、
      // 不碰配置，因此不走弹窗，点了就地生效。
      const [tokenModal, setTokenModal] = React.useState(null)
      // patch 备份：份数 / 占用（只读，给按钮一个准数）+ 清理弹窗。
      // 每份备份都是整份 patch 的副本，里面的凭据是**明文** —— 所以给一个显式出口让人能删。
      const [backups, setBackups] = React.useState(null)
      // null = 未打开；`{ files, keep, loading, error, confirming, removed, kept, failedCount, failedNames, busy }` = 已打开。
      // `confirming` = 删除的两步确认已经按下第一步（按钮就地变成「确认永久删除」）。
      const [backupClean, setBackupClean] = React.useState(null)
      // 「最近改动」流水（0.15.0 B2）：null = 还没读过；`{entries, loading, error, domain}`。
      // 读的是服务端 hub 里的 `audit.jsonl`（写类 op 成功后的追加式流水），这一栏只读不写。
      const [audit, setAudit] = React.useState(null)
      // 「清除记录」的两步确认（与「清理旧备份」同一口径：不可逆的动作不是一按就删）。
      const [auditConfirm, setAuditConfirm] = React.useState(false)
      const [auditClearing, setAuditClearing] = React.useState(false)
      const loadAudit = function (domain) {
        const want = domain || ''
        setAudit({ entries: [], loading: true, error: null, domain: want })
        apiCall('audit-list', { limit: 100, domain: want })
          .then(function (r) {
            setAudit({
              entries: (r && r.entries) || [],
              loading: false,
              error: (r && r.ok === false) ? ((r && r.error) || t('compat.audit.failed')) : null,
              domain: want,
            })
          })
          .catch(function (e) { setAudit({ entries: [], loading: false, error: errMsg(e), domain: want }) })
      }
      // 进页面读一次：它是「刚才那次改动算没算进去」的核对栏，不该要求用户再点一下。
      React.useEffect(function () { loadAudit('') }, [])
      // 整机迁移（0.15.0 C2）：导出 = 一个目录带走全部；导入 = 先预览、勾选域、再执行。
      // 两个目录初值都取共享的 defaultIoDir()（20 片）—— 导出默认落在那儿，导入也从那儿找
      // 快照。值是**宿主**报的「桌面 → 主目录」，跟着机器与用户走，不写死任何绝对路径
      //（用户 2026-10-12 追问过其他用户 / macOS / Linux 的情况，见 20 片的说明）。
      const [snap, setSnap] = React.useState({ outDir: defaultIoDir(), includeSecrets: false, busy: false, result: null })
      const [snapIn, setSnapIn] = React.useState({ dir: defaultIoDir(), preview: null, loading: false, picked: {}, conflict: 'skip', busy: false, result: null, error: null })
      /**
       * 「浏览」用的目录状态（0.15.0）：`target` 记住这次是给导出选目录还是给导入选快照位置。
       * 走宿主 `dir-list` 逐级列目录 —— 标准浏览器拿不到所选文件夹的绝对路径
       * （`File.path` 只有 Electron 有），所以不能靠 `<input type=file webkitdirectory>` 糊过去。
       */
      const [browse, setBrowse] = React.useState(null)
      const browseLoad = function (dir, target) {
        const want = String(dir || '')
        const keep = target || (browse && browse.target) || 'export'
        setBrowse({ target: keep, path: want, current: '', parent: null, entries: [], loading: true, error: null })
        apiCall('dir-list', { dir: want })
          .then(function (r) {
            if (!r || !r.ok) { setBrowse({ target: keep, path: want, current: '', parent: null, entries: [], loading: false, error: (r && r.error) || t('dir.error.unreadable') }); return }
            setBrowse({ target: keep, path: r.current || want, current: r.current || want, parent: r.parent || null, entries: r.entries || [], loading: false, error: null })
          })
          .catch(function (e) { setBrowse({ target: keep, path: want, current: '', parent: null, entries: [], loading: false, error: errMsg(e) }) })
      }
      /** 把选中的目录落到「导出」或「导入」那一格 —— 系统框与应用内列表两条路共用。 */
      const browseApply = function (target, path) {
        if (target === 'export') setSnap(Object.assign({}, snap, { outDir: path }))
        else setSnapIn(Object.assign({}, snapIn, { dir: path, preview: null, result: null }))
      }
      const browseOpen = function (target, initial) {
        requestHostDirectory(function (path) { browseApply(target, path) }, function () { browseLoad(initial || '', target) })
      }
      const browsePick = function () {
        if (!browse || !browse.current) return
        browseApply(browse.target, browse.current)
        setBrowse(null)
      }
      /** 清空流水。清完会重载 —— 新流水里会留下一条「清空了改动记录」，这是有意的（见 audit-log.ts）。 */
      const doAuditClear = function () {
        setAuditClearing(true)
        apiCall('audit-clear', {})
          .then(function (r) {
            setAuditClearing(false)
            setAuditConfirm(false)
            if (!r || !r.ok) { setAudit(Object.assign({}, audit, { error: (r && r.error) || t('compat.audit.clearFailed') })); return }
            loadAudit((audit && audit.domain) || '')
          })
          .catch(function (e) { setAuditClearing(false); setAudit(Object.assign({}, audit, { error: errMsg(e) })) })
      }
      const doSnapshotExport = function () {        setSnap(Object.assign({}, snap, { busy: true, result: null }))
        apiCall('snapshot-export', { outDir: snap.outDir, includeSecrets: snap.includeSecrets === true })
          .then(function (r) {
            setSnap(Object.assign({}, snap, { busy: false, result: (r && r.ok)
              ? { ok: true, text: t('snapshot.export.done', { dir: r.dir }), counts: domainCountsText((r.manifest && r.manifest.domains) || {}), notes: ((r.manifest && r.manifest.notes) || []).join('；') }
              : { ok: false, text: (r && r.error) || t('snapshot.export.failed') } }))
          })
          .catch(function (e) { setSnap(Object.assign({}, snap, { busy: false, result: { ok: false, text: errMsg(e) } })) })
      }
      const doSnapshotPreview = function () {
        setSnapIn(Object.assign({}, snapIn, { loading: true, error: null, preview: null, result: null }))
        // 顺带问一次场景锁：导入会逐个调各域的 import op，那些 op 在锁定期间被门禁挡着 ——
        // 让用户在执行之前就知道要被拒，而不是点完才看到一屏失败原因。
        Promise.all([apiCall('snapshot-preview', { dir: snapIn.dir }), apiCall('rules-list', {}).catch(function () { return null })])
          .then(function (rs) {
            const r = rs[0], rulesRes = rs[1]
            const scenes = (rulesRes && (rulesRes.scenes || (rulesRes.data && rulesRes.data.scenes))) || []
            const locked = scenes.filter(function (s) { return s && s.locked === true }).map(function (s) { return String(s.name || s.scene || '') }).filter(Boolean)
            if (!r || !r.ok) { setSnapIn(Object.assign({}, snapIn, { loading: false, error: (r && r.error) || t('snapshot.preview.failed'), lockedScenes: locked })); return }
            const picked = {}
            ;(r.domains || []).forEach(function (d) { picked[d.domain] = true })
            setSnapIn(Object.assign({}, snapIn, { loading: false, preview: r, picked: picked, lockedScenes: locked }))
          })
          .catch(function (e) { setSnapIn(Object.assign({}, snapIn, { loading: false, error: errMsg(e) })) })
      }
      const doSnapshotImport = function () {
        const picked = snapIn.picked || {}
        const domains = Object.keys(picked).filter(function (k) { return picked[k] === true })
        if (!domains.length) { setSnapIn(Object.assign({}, snapIn, { result: { ok: false, text: t('snapshot.import.none') } })); return }
        setSnapIn(Object.assign({}, snapIn, { busy: true, result: null }))
        apiCall('snapshot-import', { dir: snapIn.dir, domains: domains, conflict: snapIn.conflict === 'overwrite' ? 'overwrite' : 'skip' })
          .then(function (r) {
            setSnapIn(Object.assign({}, snapIn, { busy: false, result: (r && r.ok)
              ? { ok: true, text: t('snapshot.import.done'), report: r.report || [] }
              : { ok: false, text: (r && r.error) || t('snapshot.import.failed') } }))
          })
          .catch(function (e) { setSnapIn(Object.assign({}, snapIn, { busy: false, result: { ok: false, text: errMsg(e) } })) })
      }
      /** 域名的本地化 + 条数（导出结果与导入预览共用一句人话）。 */
      const domainCountsText = function (domains) {
        return Object.keys(domains).map(function (d) { return t('snapshot.domain.' + d) + ' ' + domains[d] }).join(' · ')
      }
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
        // 收掉那句"去填令牌" + 校准输入框锁态：**判据不在这里**，与横幅的填写弹窗共用
        // `applyTokenStatusSideEffects`（20 片）。抄一份的后果是同一个响应在两边判出不同结论，
        // 而这两个结论直接决定"用户能不能发消息"。
        applyTokenStatusSideEffects(r)
        setTokenState({
          hostConfigured: r.hostConfigured === true,
          disabled: r.disabled === true,
          active: r.active === true,
          accepted: r.accepted === true,
          configHasToken: r.configHasToken === true,
          configDisabled: r.configDisabled === true,
          configFound: r.configFound === true,
          envToken: r.envToken === true,
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
       * 改宿主侧配置。四种模式：
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
        // 只有当前进程**真的拿着**令牌时才要求再输一次。配置里写了、但还没重启加载进来时
        // 没有可验证的值，宿主那边同样不要求 —— 这里不能凭空多要一格。
        if ((mode === 'off' || mode === 'clear') && tokenHostConfigured && !proof) {
          setTokenMsg({ kind: 'err', text: t('compat.token.proofNeed'), field: fieldKey }); return
        }
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
            // 宿主说令牌不对、而客户端先前以为"不用凭证"（状态陈旧 / 环境变量刚变化）：
            // 把凭证框补出来，否则用户看着一句"请填入当前令牌"却没有地方可填。
            if (wrong && (mode === 'off' || mode === 'clear') && !tokenHostConfigured) {
              setTokenModal(function (prev) {
                return prev ? Object.assign({}, prev, { forceProof: true, value: '' }) : prev
              })
            }
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
          // 删除配置令牌 = 一步回到"还没有令牌"：本机记住的那串也跟着作废，并把宿主侧
          // 「本次启动已验过」的闩重新挂上（clearToken 同时做这三件事）。只删配置、把本机
          // 令牌留着的话，用户下次还会以为是自己没填对。
          if (mode === 'clear') clearToken()
          else loadToken(true)
        }).catch(function (e) { setTokenMsg({ kind: 'err', text: errMsg(e), field: fieldKey }) })
      }
      /** 打开令牌管理弹窗（四种模式共用一个弹窗，见 tokenModal 的注释）。 */
      const openTokenModal = function (mode) {
        setTokenModal({ mode: mode, current: '', next: '', repeat: '', value: '', forceProof: false })
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
        const needProof = tokenHostConfigured && (tokenModal.mode === 'off' || tokenModal.mode === 'clear')
        const allowEmpty = tokenModal.mode === 'on' && !!(tokenState && tokenState.accepted)
        const value = tokenModal.value.trim()
        if (needProof && !value) return
        if (tokenModal.mode === 'on' && !value && !allowEmpty) return
        configureHostToken(tokenModal.mode, value, '', tokenModal.mode)
      }
      /** 弹窗里的输入框按回车 = 确认（所有框挂同一个，顺序无所谓）。 */
      const enterToSubmit = function (ev) { if (ev.key === 'Enter') submitTokenModal() }
      const loadInject = function (alive) {
        apiCall('inject-settings', {})
          .then(function (r) { if (alive !== false && r && r.ok && r.settings) setInject(r.settings) })
          .catch(function () { /* 读不到 → 不渲染这一节 */ })
      }
      const loadSlash = function (alive) {
        apiCall('slash-settings', {})
          .then(function (r) { if (alive !== false && r && r.ok && r.settings) setSlash(r.settings) })
          .catch(function () { /* 读不到 → 不渲染这一节 */ })
      }
      // 工具表实况（注册时量到的体积 + 关掉了哪些）。服务端返回的 `report` 自带分组与
      // ≈token 合计 —— 界面不自己算，也不缓存第二份数字。
      const applyToolTable = function (r, alive) {
        if (alive === false) return
        if (r && r.ok && r.report) setToolTable(toolTableFrom(r))
      }
      /** 服务端回包 → 界面那一份状态（三条路径共用：读、改勾选、存/删方案）。 */
      const toolTableFrom = function (r, hiddenFallback) {
        return {
          hidden: r.hidden || hiddenFallback || [], presets: r.presets || [],
          defaultHidden: r.defaultHidden || [], report: r.report,
          // 会话层：当前名单的来源（本对话 / 创建时 / 全局兜底）与全局默认名单（「恢复默认」用）。
          source: r.source || '',
          globalHidden: r.globalHidden || r.hidden || [],
          sessionId: r.sessionId || '',
          // 侧车状态（0.21.2）：unknown 时这一块整体禁写，并挂一条常驻说明。
          state: r.state === 'unknown' ? 'unknown' : 'ok',
          issue: r.issue || null,
        }
      }
      const loadToolTable = function (alive) {
        // 全局层不带 sessionId（老行为）；会话层读这一对话生效的整份名单。
        const sid = scopeSessionId
        apiCall('tool-table', sid ? { sessionId: sid } : {})
          .then(function (r) {
            if (alive === false) return
            if (r && r.ok) { applyToolTable(r, alive); setToolTableError(null) }
          })
          .catch(function () { /* 读不到 → 不渲染这一节 */ })
      }
      /**
       * 保存工具表开关。
       *
       * 刻意**不做乐观更新**（与上面的注入设置不同）：勾选框状态与"关掉后每轮少发多少"
       * 这两个数字必须来自同一份服务端数据（注册时量到的体积），本地先改一个就会在
       * 往返的这几毫秒里出现"框已经勾了、合计还没变"的两种真相。这里是本机 HTTP，
       * 往返可以忽略，所以选择在等待期间把整块变灰。
       */
      const saveToolTable = function (names) {
        if (!toolTable || toolTableBusy || scopeSessionLocked) return
        setToolTableBusy(true)
        setToolTableError(null)
        const payload = { set: true, hidden: names.slice() }
        if (scopeSessionId) payload.sessionId = scopeSessionId
        apiCall('tool-table', payload)
          .then(function (r) {
            if (r && r.ok && r.report) {
              setToolTable(toolTableFrom(r, names))
              // 会话层的工具表也是"这一层的覆盖"：顶部下拉的条数要跟着变。
              if (scopeSessionId) refreshScope()
            } else {
              setToolTableError(r && r.error ? String(r.error) : t('compat.tools.saveFailed'))
              loadToolTable(true)
            }
            // 功能总览那一行写着"一轮发出去多少"，它得跟着变。
            loadFeatures(true)
          })
          .catch(function () {
            setToolTableError(t('compat.tools.saveFailed'))
            loadToolTable(true)
          })
          .then(function () { setToolTableBusy(false) })
      }
      /** 单个工具的勾选：在 hidden 名单里加 / 删一个名字。 */
      const toggleToolTableTool = function (name, on) {
        if (!toolTable || scopeSessionLocked) return
        const hid = (toolTable.hidden || []).filter(function (n) { return n !== name })
        if (!on) hid.push(name)
        saveToolTable(hid)
      }
      /** 整个域一起开 / 关（分组勾选框）。 */
      const toggleToolTableGroup = function (group, on) {
        if (!toolTable || scopeSessionLocked) return
        const names = group.tools.map(function (tool) { return tool.name })
        const hid = (toolTable.hidden || []).filter(function (n) { return names.indexOf(n) < 0 })
        if (!on) Array.prototype.push.apply(hid, names)
        saveToolTable(hid)
      }
      // ---------- 「方案」：把一组勾选存成名字，之后一键换回来 ----------
      // 为什么要它（用户 2026-09-23）：这一块的开关是**成批**用的 —— "这次要让模型自己配
      // 服务器"与"平时只让它查"是两套选择，挨个点二十个框没人愿意重复第二遍。
      // 三条口径：① 方案存的是**关掉的名单**（与 `hidden` 同口径），不是"开着的"，否则
      // 新注册一条工具会让所有旧方案静默地少管一条；② 应用 = 走 `saveToolTable` 那条既有
      // 落盘路径（可见性重排与两处目录刷新都在那边，不开第二条真相）；③ 出厂默认**不在文件里**
      // （它是代码里的 `DEFAULT_HIDDEN_TOOLS`），所以删不掉，界面把它排在第一行。
      /** 工具名 → ≈tok：方案行上那句"开着 X 个 · ≈Y tok/轮"要用，数字仍全部来自服务端报告。 */
      const toolTokByName = function () {
        const map = {}
        const groups = (toolTable && toolTable.report && toolTable.report.groups) || []
        groups.forEach(function (g) {
          (g.tools || []).forEach(function (tool) { map[tool.name] = tool.tok })
        })
        return map
      }
      /** 弹窗里的错误行：服务端回 `code` 时按当前语言出话；回 `error`（落盘失败）只能原样。
       *  认不出的 code 退回通用那句 —— 拼出来的键名如果落空，`t` 会把键本身吐到界面上。 */
      const presetErrorText = function (r) {
        const code = r && r.code
        if (code === 'nameEmpty' || code === 'nameTaken' || code === 'limit' || code === 'notFound') {
          return t('compat.tools.preset.err.' + code, { max: r.limit || 0 })
        }
        return (r && r.error) || t('compat.tools.preset.err.net')
      }
      /** 名字归一化与服务端 `presetNameOf` 同形（折叠空白 + 去首尾），否则本地查重会漏。 */
      const presetNameNorm = function (value) { return String(value || '').replace(/\s+/g, ' ').trim() }
      /** 存方案：空名与撞名在本地先挡住（服务端也会挡，但那是白跑一趟）。 */
      const submitToolPreset = function () {
        if (!toolPreset || toolPreset.busy || scopeSessionId) return
        const name = presetNameNorm(toolPreset.name)
        if (!name) {
          setToolPreset(Object.assign({}, toolPreset, { error: t('compat.tools.preset.err.nameEmpty') }))
          return
        }
        if (((toolTable && toolTable.presets) || []).some(function (p) { return p.name === name })) {
          setToolPreset(Object.assign({}, toolPreset, { name: name, error: t('compat.tools.preset.err.nameTaken', { name: name }) }))
          return
        }
        setToolPreset(Object.assign({}, toolPreset, { busy: true, error: '' }))
        apiCall('tool-table', { presetSave: name })
          .then(function (r) {
            if (r && r.ok) { setToolTable(toolTableFrom(r)); setToolPreset(null) }
            else setToolPreset({ mode: 'save', name: name, error: presetErrorText(r) })
          })
          .catch(function () { setToolPreset({ mode: 'save', name: name, error: presetErrorText(null) }) })
      }
      /** 删方案：留在弹窗里（用户多半还要接着挑），只把清单换成服务端那份。 */
      const deleteToolPreset = function (name) {
        if ((toolPreset && toolPreset.busy) || scopeSessionId) return
        setToolPreset({ mode: 'apply', busy: true })
        apiCall('tool-table', { presetDelete: name })
          .then(function (r) {
            if (r && r.ok) { setToolTable(toolTableFrom(r)); setToolPreset({ mode: 'apply' }) }
            else setToolPreset({ mode: 'apply', error: presetErrorText(r) })
          })
          .catch(function () { setToolPreset({ mode: 'apply', error: presetErrorText(null) }) })
      }
      /** 应用一份方案 = 用它那组名单走既有的保存路径。 */
      const applyToolPreset = function (hidden) {
        setToolPreset(null)
        saveToolTable((hidden || []).slice())
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
      // 工具表跟着顶部作用域走：切对话 / 进出场景都重拉这一层的生效名单。
      // 首挂载也走这里（`lastToolScope` 初值 null），所以下面的挂载 effect 不再单独拉一次。
      // `revision` 进来兜"同一场景里方案改绑"（服务端会把新名单同步到会话，场景名不变）。
      const lastToolScope = React.useRef(null)
      const toolScopeSig = scopeSessionId + '|' + String(scopeSnap.scene || '') + '|' + (scopeSnap.detached === true ? '1' : '0') + '|' + String(Number(scopeSnap.revision) || 0)
      React.useEffect(function () {
        if (lastToolScope.current === toolScopeSig) return
        lastToolScope.current = toolScopeSig
        setToolTable(null)
        setToolTableError(null)
        loadToolTable(true)
      }, [toolScopeSig])
      React.useEffect(function () {
        let alive = true
        setBusy(true)
        apiCall('compat-status', { refresh: true })
          .then(function (r) { apply(r, alive) })
          .catch(function (e) { if (alive) { setError(errMsg(e)); setBusy(false) } })
        loadReach(alive)
        loadInject(alive)
        loadSlash(alive)
        loadLive(alive)
        loadFeatures(alive)
        loadToken(alive)
        loadBackups(alive)
        return function () { alive = false }
      }, [])
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
      /**
       * 保存斜杠命令入口的两颗开关（「工具」段 / 「快捷提示词」段）。与 saveInject 同一条口径：
       * 先乐观更新（点一下就该有反馈），服务端返回值到达后以其为准，失败重拉。
       *
       * **本次启动不会立刻挂上 / 撤下** —— 源注册是启动期一次性的事，所以说明里写清"重启或
       * 重开页面后生效"，别让"关掉了但菜单还在"变成一次报障。
       */
      const saveSlash = function (patch) {
        if (!slash) return
        const next = Object.assign({}, slash, patch)
        setSlash(next)
        apiCall('slash-settings', Object.assign({ set: true }, next))
          .then(function (r) { if (r && r.ok && r.settings) setSlash(r.settings); loadFeatures(true) })
          .catch(function () { loadSlash(true) })
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
      // ── 功能总览的本地化（2026-09-28：英文界面总览半页中文的整改）────────────────
      // 文案归客户端、数值归服务端：feature-overview 行带 key/state/结构化字段，
      // 这里的解析器按键出对应语言的句子；任何一处对不上（服务端加了新键、词典漏了）
      // 都回退服务端中文原文 —— 宁可退回中文，不显示原始键名。
      /** 路由缺失能力（refusal）的标签：键集对齐服务端 probe 的 spec id 与 operation 兜底 id。 */
      const capLabel = function (id, fallback) {
        switch (id) {
          case 'workspace.read-state': return t('compat.cap.workspaceReadState')
          case 'workspace.read-table': return t('compat.cap.workspaceReadTable')
          case 'workspace.index-shape': return t('compat.cap.workspaceIndexShape')
          case 'workspace.read-header': return t('compat.cap.workspaceReadHeader')
          case 'workspace.enqueue': return t('compat.cap.workspaceEnqueue')
          case 'workspace.set-state': return t('compat.cap.workspaceSetState')
          case 'workspace.index-header': return t('compat.cap.workspaceIndexHeader')
          case 'workspace.archive-native': return t('compat.cap.workspaceArchiveNative')
          case 'workspace.unarchive-native': return t('compat.cap.workspaceUnarchiveNative')
          case 'workspace.batch-native': return t('compat.cap.workspaceBatchNative')
          case 'workspace.delete-native': return t('compat.cap.workspaceDeleteNative')
          case 'sessions.detach-live': return t('compat.cap.sessionsDetachLive')
          case 'sessions.cold-announce': return t('compat.cap.sessionsColdAnnounce')
          case 'projection.write': return t('compat.cap.projectionWrite')
          case 'projection.table-delete': return t('compat.cap.projectionTableDelete')
          case 'agentPreset.register': return t('compat.cap.agentPresetRegister')
          case 'tools.restrict-method': return t('compat.cap.toolsRestrictMethod')
          case 'agent.created-event': return t('compat.cap.agentCreatedEvent')
          case 'connection.admit': return t('compat.cap.connectionAdmit')
          case 'archive': return t('compat.cap.opArchive')
          case 'unarchive': return t('compat.cap.opUnarchive')
          case 'batch': return t('compat.cap.opBatch')
          case 'delete': return t('compat.cap.opDelete')
          case 'list': return t('compat.cap.opList')
          default: return fallback || id
        }
      }
      /** 行标签：键集对齐服务端 feature-overview 的 row.key；未知键回退服务端原文。 */
      const ovLabel = function (key) {
        switch (key) {
          case 'mount': return t('compat.ov.mount')
          case 'patch-write-guard': return t('compat.ov.patchWriteGuard')
          case 'context-injection': return t('compat.ov.contextInjection')
          case 'official-suppression': return t('compat.ov.officialSuppression')
          case 'skills-provider': return t('compat.ov.skillsProvider')
          case 'projection-cache-adapter': return t('compat.ov.projectionCacheAdapter')
          case 'mcp-tool-visibility': return t('compat.ov.mcpToolVisibility')
          case 'mcp-tool-guard': return t('compat.ov.mcpToolGuard')
          case 'http-fence-fallback': return t('compat.ov.httpFenceFallback')
          case 'session-delete': return t('compat.ov.sessionDelete')
          case 'session-archive': return t('compat.ov.sessionArchive')
          case 'session-unarchive': return t('compat.ov.sessionUnarchive')
          case 'session-batch': return t('compat.ov.sessionBatch')
          case 'session-list': return t('compat.ov.sessionList')
          case 'injection-domains': return t('compat.ov.injectionDomains')
          case 'token': return t('compat.ov.token')
          case 'scene-lock': return t('compat.ov.sceneLock')
          case 'mcp-tools': return t('compat.ov.mcpTools')
          case 'tool-table': return t('compat.ov.toolTable')
          case 'slash-commands': return t('compat.ov.slashCommands')
          case 'native-delete': return t('compat.ov.nativeDelete')
          case 'host-identity': return t('compat.ov.hostIdentity')
          case 'memory': return t('compat.ov.memory')
          case 'prompts': return t('compat.ov.prompts')
          case 'subagents': return t('compat.ov.subagents')
          case 'scenes': return t('compat.ov.scenes')
          case 'subagent-persona': return t('compat.ov.subagentPersona')
          case 'subagent-tool-restrict': return t('compat.ov.subagentToolRestrict')
          case 'subagent-created-event': return t('compat.ov.subagentCreatedEvent')
          case 'web-admission': return t('compat.ov.webAdmission')
          default: return null
        }
      }
      /** 行详情：detailKey（note 降级）与 key+state（固定模板）出本地化句子，其余回退原文。 */
      const ovDetail = function (row) {
        const params = row.params || {}
        const list = function (items) { return (items || []).join(t('compat.sep')) }
        if (row.detailKey) {
          switch (row.detailKey) {
            case 'skills-provider': return t('compat.note.skillsProvider', params)
            case 'context-injection': return t('compat.note.contextInjection', params)
            case 'context-injection-runtime.domain': return t('compat.note.contextInjectionRuntime.domain', params)
            case 'context-injection-runtime.throw': return t('compat.note.contextInjectionRuntime.throw')
            case 'cordis-original-symbol': return t('compat.note.cordisOriginalSymbol')
            case 'patch-write-guard.no-dep': return t('compat.note.patchWriteGuard.noDep', params)
            case 'patch-write-guard.stale': return t('compat.note.patchWriteGuard.stale', params)
            case 'official-suppression': return t('compat.note.officialSuppression', params)
            case 'projection-cache-adapter.setup': return t('compat.note.projectionCacheAdapter.setup', params)
            case 'projection-cache-adapter.taken-over': return t('compat.note.projectionCacheAdapter.takenOver')
            case 'projection-cache-adapter.first-use': return t('compat.note.projectionCacheAdapter.firstUse')
            case 'mcp-tool-visibility.no-restrict': return t('compat.note.mcpToolVisibility.noRestrict')
            case 'mcp-tool-visibility.partial': return t('compat.note.mcpToolVisibility.partial', params)
            case 'mcp-tool-visibility.schemas-failed': return t('compat.note.mcpToolVisibility.schemasFailed', params)
            case 'mcp-tool-guard.register-failed': return t('compat.note.mcpToolGuard.registerFailed', params)
            case 'mcp-tool-guard.missing': return t('compat.note.mcpToolGuard.missing')
            case 'mcp-disabled-tools.corrupt': return t('compat.note.mcpDisabledTools.corrupt')
            case 'mcp-disabled-tools.unreadable': return t('compat.note.mcpDisabledTools.unreadable')
            case 'mcp-disabled-tools.unknown': return t('compat.note.mcpDisabledTools.unknown')
            case 'http-fence-fallback.missing': return t('compat.note.httpFenceFallback.missing', params)
            case 'http-fence-fallback.threw': return t('compat.note.httpFenceFallback.threw', params)
            case 'tool-table-file.corrupt': return t('compat.note.toolTableFile.corrupt')
            case 'tool-table-file.unreadable': return t('compat.note.toolTableFile.unreadable')
            case 'workspace.delete-native': return t('compat.note.workspaceDeleteNative', params)
            case 'mcp-server-name-ambiguous.separator': return t('compat.note.mcpServerNameAmbiguous.separator', params)
            case 'mcp-server-name-ambiguous.prefix': return t('compat.note.mcpServerNameAmbiguous.prefix', params)
          }
        }
        if (row.key === 'mount' && row.state === 'ok') return t('compat.ov.mount.ok', params)
        if (row.state === 'ok' && (row.key === 'patch-write-guard' || row.key === 'context-injection' || row.key === 'official-suppression' ||
          row.key === 'skills-provider' || row.key === 'projection-cache-adapter' || row.key === 'mcp-tool-visibility' ||
          row.key === 'mcp-tool-guard' || row.key === 'http-fence-fallback')) {
          return t('compat.ov.assembly.ok')
        }
        if (row.key === 'session-delete' || row.key === 'session-archive' || row.key === 'session-unarchive' ||
          row.key === 'session-batch' || row.key === 'session-list') {
          if (row.state === 'unknown') return t('compat.ov.route.unknown')
          if (row.state === 'unavailable') {
            return t('compat.ov.route.none', { list: list((row.refusals || []).map(function (r) { return capLabel(r.id, r.label) })) })
          }
          return t('compat.ov.route.ok', { via: routeText(row.via) })
        }
        if (row.key === 'injection-domains') {
          return row.state === 'disabled'
            ? t('compat.ov.injectionDomains.off', { total: row.total })
            : t('compat.ov.injectionDomains.on', { count: row.count, total: row.total, list: list(row.domains) })
        }
        if (row.key === 'token') {
          return row.state === 'disabled' ? t('compat.ov.token.disabled')
            : row.state === 'locked' ? t('compat.ov.token.locked')
              : t('compat.ov.token.ok')
        }
        if (row.key === 'scene-lock') {
          return row.state === 'ok' ? t('compat.ov.sceneLock.ok')
            : t('compat.ov.sceneLock.locked', { list: list(row.scenes) })
        }
        if (row.key === 'mcp-tools') {
          // 停用表读不出来：不是"没有停用"，而是"所有 mcp__* 已被拒绝"。计数此时没有意义。
          if (row.state === 'degraded') return t('compat.ov.mcpTools.unknown')
          const servers = Number(row.servers || 0)
          const tools = Number(row.tools || 0)
          const body = servers > 0 && tools > 0 ? t('compat.ov.mcpTools.both', { servers: servers, tools: tools })
            : servers > 0 ? t('compat.ov.mcpTools.servers', { servers: servers })
              : tools > 0 ? t('compat.ov.mcpTools.tools', { tools: tools })
                : t('compat.ov.mcpTools.none')
          return body + (servers + tools > 0 ? t('compat.ov.mcpTools.guard') : '')
        }
        if (row.key === 'tool-table') {
          // 侧车读不出来：数字只是兜底值，不能当成"用户的选择"报。
          if (row.state === 'degraded') return t('compat.ov.toolTable.unknown')
          const hidden = Number(row.hidden || 0)
          if (hidden === 0) return t('compat.ov.toolTable.all', { total: row.total })
          return hidden === Number(row.defaults || 0)
            ? t('compat.ov.toolTable.factory', { hidden: hidden, total: row.total })
            : t('compat.ov.toolTable.mixed', { hidden: hidden, total: row.total, defaults: row.defaults })
        }
        if (row.key === 'native-delete' && row.state === 'ok') return t('compat.ov.nativeDelete.ok')
        if (row.key === 'slash-commands') {
          // 两段各自一颗开关：只开一段时不能沿用"两段都在"那句（服务端把两个布尔一起带回来了）。
          if (row.state === 'disabled') return t('compat.ov.slashCommands.off')
          if (row.slashTools && row.slashQuickPrompts) return t('compat.ov.slashCommands.on')
          return t(row.slashTools ? 'compat.ov.slashCommands.onTools' : 'compat.ov.slashCommands.onQuick')
        }
        if (row.key === 'host-identity') {
          if (row.state === 'unknown') return t('compat.ov.route.unknown')
          if (row.state === 'degraded') return t('compat.ov.hostIdentity.degraded', { list: list(row.blockers) })
          // 归档宿主：同版本但不同文件，不能沿用"同源"那句。
          if (row.asarHost) return t('compat.ov.hostIdentity.asar', { version: row.version, name: row.asarName || 'app.asar' })
          return t('compat.ov.hostIdentity.ok', { version: row.version })
        }
        if (row.key === 'subagent-persona' || row.key === 'subagent-tool-restrict' || row.key === 'subagent-created-event' || row.key === 'web-admission') {
          // 宿主契约行：可用时说的是"运行时看到的那份实现"（它的 detail 由探针写成"成员齐备"），
          // 降级时说的是"这条契约没了，对应功能少一半"——两个方向都得按语言说。
          return row.state === 'unknown' ? t('compat.ov.route.unknown')
            : row.state === 'ok' ? t('compat.ov.contract.ok')
              : t('compat.ov.contract.degraded', { detail: row.detail })
        }
        if (row.state === 'ok' && (row.key === 'memory' || row.key === 'prompts' || row.key === 'subagents' || row.key === 'scenes')) {
          // 有宿主模块可核的域（提示词 / 子智能体）按实况说；确实没有可核对象的才说"无降级上报"。
          if (row.key === 'memory' || row.key === 'scenes') return t('compat.ov.plain.ok')
          return t('compat.ov.domain.contract', { detail: row.detail })
        }
        return row.detail
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

      // 「最近改动」「整机迁移」「注入实况」三块收进顶部按钮，点开才看（用户裁定 2026-09-28）：
      // 这三块都是"要看的时候才看"的东西，常驻在长页里把体检结论与设置项挤得更远。
      // 三块的内容各自算成变量（auditContent / snapshotContent / liveContent），这里只给外壳。
      const [compatDialogOpen, setCompatDialog] = React.useState('')
      let auditContent = null
      let snapshotContent = null
      let liveContent = null
      /**
       * 兼容页自己的弹窗外壳。**必须手写 DOM** —— CompatPage 在 `apply` 之外，引用 apply 内的
       * `Modal` 就是渲染期 ReferenceError、整块面板白屏（2026-09-19 真踩过一次）。
       * 与「清理旧备份」「访问令牌」两处同一套行为：点遮罩空白关、Esc 关、Tab 圈在框内。
       *
       * @param fixed 固定高度。只给「最近改动」这种**内容长短会变、但希望框不跳**的列表；
       *   表单类（整机迁移）与条数固定的（注入实况）用自适应高度，否则内容少时框里一片空。
       */
      const compatDialog = function (id, title, content, fixed) {
        const close = function () { setCompatDialog(''); setBrowse(null) }
        return React.createElement('div', {
          key: id + '-mask', className: 'dsm-mask',
          onMouseDown: function (e) { if (e.target === e.currentTarget) close() },
        }, React.createElement('div', {
          tabIndex: -1, className: 'dsm-modal dsm-modal-lg' + (fixed ? ' dsm-compat-dialog' : ''), role: 'dialog', 'aria-modal': 'true',
          'aria-labelledby': 'dsm-compat-dialog-title-' + id,
          onKeyDown: function (e) { if (!handleModalEscape(e, close)) trapModalFocus(e.currentTarget, e) },
        },
          React.createElement('div', { className: 'dsm-modal-head' },
            React.createElement('h3', { className: 'dsm-modal-title', id: 'dsm-compat-dialog-title-' + id }, title),
            // 关闭钮统一走共享的 X 图标钮（REDESIGN §4.2：关闭不是一行文字，是右上角一颗 X）。
            React.createElement(ModalCloseButton, { label: t('btn.close'), onClick: close })),
          React.createElement('div', { className: 'dsm-modal-body' }, content)))
      }
      /** 顶部那一栏的三个入口按钮（quiet 弱化，REDESIGN §6 兼容行特例 §9-1：常驻可见）。 */
      const compatDialogButton = function (id, label) {
        return React.createElement('button', {
          key: id,
          type: 'button', className: 'dsm-btn dsm-btn-quiet',
          onClick: function () { setCompatDialog(id) },
        }, label)
      }

      const body = []
      // 块级子项统一在这里加 key：`body` 是数组，React 要求每个直接子项有稳定 key。
      const push = function (node) {
        body.push(React.cloneElement(node, { key: 'compat-' + String(body.length) }))
      }
      // 访问令牌（用户裁定 2026-09-18：放在「注入」**上面** —— 令牌不过时写操作全被拒，
      // 它是"先解决才能用别的"的一件事，位置就该在设置项之前）。
      //
      // 排版口径（2026-10-22 第四次重构）：原来的「状态框 + 四行管理清单」太占地方，
      // 四行里「删除令牌 / 清除令牌」又几乎看不出区别，于是并成**两行**：
      //
      //   ① 令牌行：胶囊 + 一句实况 + 设置/修改/删除/锁定。待解锁时输入框就长在这一行
      //      下面；写配置的表单全在弹窗里，页面上没有会展开收起的东西。
      //   ② 保护开关行：一颗 Switch（开启后每次启动要解锁）。
      //
      //   「删除令牌」与原来的「清除令牌」合并：删配置的同时忘掉本机记录，一步回到
      //      "还没有令牌"；只想清本机、不动配置时用「锁定」（已解锁时才出现）。
      //
      //   反馈模型不变：页面**永远不出现游离的结果框**。成功 = 弹窗收起 / 胶囊更新；
      //      失败 = 弹窗不关、错误显示在弹窗内部（`field` 归属）。红色只出现在确认按钮上。
      const tokenHostConfigured = !!(tokenState && tokenState.hostConfigured)
      // 配置文件里**有值**（含 tokenDisabled=true 的保留态）。它和 hostConfigured 的区别：
      // 后者说的是"当前进程拿到的值"，刚写入、还没重启时只有它为 true。
      const tokenConfigHasToken = !!(tokenState && tokenState.configHasToken)
      // 「有没有令牌可管理」：配置里有，或当前进程里有（环境变量供的令牌只体现在后者）。
      const tokenConfigured = tokenHostConfigured || tokenConfigHasToken
      // 当前进程里令牌**是否在生效**（宿主回的 `active`：关掉或没配都是 false）。
      const tokenActive = !!(tokenState && tokenState.active)
      // 开关反映**配置意图**（文件里开没开），胶囊反映**当前进程**。改了配置还没重启时
      // 两边会不一致，由下方「待重启」横幅解释；开关若跟着进程走，点完不会动，看起来
      // 像没生效。环境变量供的令牌在配置里没有值，只看文件侧的开关旗标。
      const tokenEnvToken = !!(tokenState && tokenState.envToken)
      const tokenProtectOn = !!tokenState && tokenState.configDisabled !== true
        && (tokenEnvToken || tokenConfigHasToken)
      // 本次进程解锁没有（本机这串被宿主认可了）。
      const tokenUnlocked = !!TOKEN && !!(tokenState && tokenState.accepted)
      // 胶囊五态：未设置 / 待重启 / 已关闭 / 已开启·待解锁 / 已开启·已解锁。
      const tokenKind = !tokenState
        ? 'loading'
        : (!tokenConfigured ? 'unset'
          : (tokenActive
            ? (tokenUnlocked ? 'unlocked' : 'locked')
            : (tokenState.pendingRestart && tokenState.configDisabled !== true ? 'pending' : 'off')))
      // 待解锁 = 胶囊说"待解锁"（本机没填 / 填了没被认可）。控件槽跟胶囊同一判据，
      // 免得出现"说待解锁却没有输入框"的死路。
      const tokenNeedsUnlock = tokenKind === 'locked'
      // 绿=这一程能改配置；告警=要注意（开着但没解锁 / 关着 / 待重启）；灰=还没配。
      const tokenPillTone = tokenKind === 'unlocked'
        ? ' dsm-pill-ok'
        : (tokenKind === 'off' || tokenKind === 'locked' || tokenKind === 'pending' ? ' dsm-pill-warn' : ' dsm-pill-muted')
      const tokenModalOpen = tokenModal !== null
      const tokenSetInvalid = tokenModalOpen && tokenModal.mode === 'set' && tokenModal.next !== tokenModal.repeat
      // 错误只出现在**触发它的弹窗内部**（`field` 归属：run=令牌行的实况 / current·next=
      // 设置弹窗 / off·clear·on=各自弹窗）；成功则弹窗收起、状态自己更新。
      const tokenFormError = function (fields) {
        if (!tokenMsg || !tokenMsg.field || fields.indexOf(tokenMsg.field) < 0) return null
        return React.createElement('p', { className: 'dsm-token-ferr dsm-feedback dsm-error', role: 'alert' }, tokenMsg.text)
      }
      // 令牌行的说明：实况句与解锁 / 开关错误共用一格 —— 错误顶替实况（红色），行高、位置都不变。
      const tokenRowError = !!(tokenMsg && (tokenMsg.field === 'run' || tokenMsg.field === 'protect'))
      const tokenStatusText = !tokenState ? ''
        : tokenRowError
          ? tokenMsg.text
          : (tokenKind === 'unset' ? t('compat.token.sentence.unset')
            : tokenKind === 'pending' ? '' // 下方「待重启」横幅已经把话说完，不重复
              : t('compat.token.sentence.' + tokenKind))
      const tokenStatusLine = tokenStatusText
        ? React.createElement('span', {
            className: tokenRowError ? 'dsm-token-stat-err' : undefined,
          }, tokenStatusText)
        : null
      // 控件槽：只有「待解锁」态才有内容（输入框 + 解锁）。已解锁后胶囊本身就是标识，
      // 不再重复摆一枚「已解锁」。
      const tokenControl = tokenNeedsUnlock
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
      // 令牌行右侧的动作：锁定 / 设置或修改 / 删除，三颗同宽并排。
      // 红色只出现在弹窗里的确认按钮上。
      const tokenActions = []
      // 「锁定」只在本机记住了东西时出现：它只收紧权限（忘掉本机令牌 + 重新挂上
      // 验证闩），不需要再输一次，点了就地生效。
      if (TOKEN) {
        tokenActions.push(React.createElement('button', {
          key: 'lock', type: 'button',
          className: 'dsm-btn dsm-btn-secondary dsm-btn-lock',
          title: t('compat.token.lock.title'),
          onClick: clearToken,
        }, t('compat.token.lock')))
      }
      // 设置↔修改用 fixedLabelPair 定宽：刚写入、还没重启时 tokenHostConfigured 还是
      // false，但配置里已经有值了 —— 文案按 tokenConfigured 判，避免把它说成"设置"。
      tokenActions.push(React.createElement('button', {
        key: 'edit', type: 'button',
        className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk',
        disabled: !tokenState,
        onClick: function () { openTokenModal('set') },
      }, fixedLabelPair(
        t(tokenConfigured ? 'compat.token.edit.btn' : 'compat.token.setHost.btn'),
        t(tokenConfigured ? 'compat.token.setHost.btn' : 'compat.token.edit.btn'))))
      if (tokenConfigured) {
        tokenActions.push(React.createElement('button', {
          key: 'delete', type: 'button',
          className: 'dsm-btn dsm-btn-secondary dsm-btn-bulk',
          // 配置里没有值可删（令牌来自环境变量）时禁用；悬停那句说明原因。
          disabled: !tokenState || !tokenConfigHasToken,
          title: tokenConfigHasToken ? t('compat.token.clearHost.rowHint') : t('compat.token.clearHost.envHint'),
          onClick: function () { openTokenModal('clear') },
        }, fixedLabelPair(t('compat.token.clearHost.btn'), t('compat.token.clearHost.btn'))))
      }
      // 保护开关：没有令牌时没有可开关的东西（开关点了也没有校验对象），禁用。
      // 说明写**当前状态**（不是"点一下会怎样"）—— 开关开着时还写着"暂时停用校验"
      // 会让用户以为它已经停了。
      const tokenProtectHint = !tokenState
        ? ''
        : (!tokenConfigured
          ? t('compat.token.protect.unset')
          : (tokenProtectOn ? t('compat.token.protect.on') : t('compat.token.protect.off')))
      push(section(t('compat.token'), t('compat.token.manage.hint'),
        React.createElement('div', { className: 'dsm-token-block' },
          React.createElement(SettingsRow, {
            name: t('compat.token.row.token'),
            tag: React.createElement('span', { className: 'dsm-pill' + tokenPillTone },
              tokenState ? t('compat.token.pill.' + tokenKind) : '…'),
            desc: tokenStatusLine,
            descTitle: tokenStatusText || null,
            control: tokenActions,
          }),
          tokenControl,
          React.createElement(SettingsRow, {
            name: t('compat.token.row.protect'),
            desc: tokenProtectHint,
            control: React.createElement(Switch, {
              on: tokenProtectOn,
              disabled: !tokenState || !tokenConfigured,
              label: t('compat.token.row.protect'),
              onClick: function () {
                // 关闭是减防护：仍按既定口径弹窗再输一次当前令牌。
                if (tokenProtectOn) { openTokenModal('off'); return }
                // 开启是收紧方向：本次启动已经解锁（请求头带着宿主认可的令牌）就直接开，
                // 不再为一次开关弹一层窗；失败时错误落在令牌行的说明上。
                if (tokenState && tokenState.accepted) {
                  configureHostToken('on', '', '', 'protect')
                  return
                }
                openTokenModal('on')
              },
            }),
          }),
          // 令牌来自环境变量：配置里没有可删的值，删除键是灰的 —— 说清楚它为什么灰。
          tokenEnvToken && !tokenConfigHasToken
            ? React.createElement('p', { className: 'dsm-help' }, t('compat.token.envNote'))
            : null,
          // 配置改了但没重启：这句必须显眼，否则用户会以为"设置了却没反应"。它同时是
          // 写配置成功的**唯一回执** —— 成功 = 弹窗收起 + 这句横幅出现，不另弹结果框。
          tokenState && tokenState.pendingRestart
            ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('compat.token.pendingRestart'))
            : null,
          // loader 行读不到：**所有**写配置的操作都会被宿主拒绝 —— 它是管理区的前置
          // 事实，作为一行说明放在区块底部。
          tokenState && tokenState.configFound === false
            ? React.createElement('p', { className: 'dsm-help' }, t('compat.token.notFound'))
            : null),
        true))

      // 隔离粒度（0.21.2，用户 2026-10-21）：排在「访问令牌」与「注入」之间 —— 它决定这一页
      // 与下面各页"按哪一层取数"。切换不是删除：另一侧的记录原样保留（服务端只播种缺的那一侧）。
      // 小节副标题与"按哪一层隔离"那格按用户口径删掉，只留两颗按钮与当前态那一句。
      push(section(t('compat.scopeMode'), null,
        React.createElement('div', { className: 'dsm-scope-mode' },
          // 两个互斥值用分段控件（与 MCP 的「传输方式」同款，用户 2026-10-21）：下拉要多点一下
          // 才看得见另一档，而这里一共就两档。
          React.createElement('div', { className: 'dsm-form-seg', role: 'group', 'aria-label': t('compat.scopeMode') },
            SCOPE_MODE_OPTIONS.map(function (o) {
              return React.createElement('button', {
                key: o.value, type: 'button', title: t(o.tipKey), disabled: scopeModeBusy,
                'aria-pressed': scopeMode === o.value ? 'true' : 'false',
                onClick: function () { changeScopeMode(o.value) },
              }, t(o.labelKey))
            })),
          React.createElement('span', { className: 'dsm-scope-mode-hint' },
            scopeIsGlobalMode
              ? t('compat.scopeMode.current.global')
              : (scopeIsWorkspaceMode ? t('compat.scopeMode.current.workspace') : t('compat.scopeMode.current.session'))),
          scopeModeError ? React.createElement('span', { className: 'dsm-feedback dsm-warning', role: 'alert' }, scopeModeError) : null,
          // 坍缩摘要只在「确实丢了东西」时出现（dropped > 0），不打扰常规切换。
          scopeModeNotice ? React.createElement('span', { className: 'dsm-feedback dsm-ok', role: 'status' }, scopeModeNotice) : null)))

      // ── 令牌管理弹窗（手工拼装 —— `Modal` 在 apply 内引用不到，照备份弹窗的模式）──
      // 遮罩点击关闭 + 头部标题/关闭键 + body + 底部动作行；Esc 关闭 / Tab 焦点陷阱
      // 复用模块作用域的那三个助手；打开时的聚焦见 tokenDialogRef 上的 effect。
      // 弹窗内不挂令牌提示（TokenGateNotice 在 apply 内，引它=白屏）：被令牌挡下的操作
      // 由弹窗自己的错误行如实显示。
      let tokenModalEl = null
      if (tokenModal) {
        const m = tokenModal
        const title = t(m.mode === 'set'
          ? (tokenConfigured ? 'compat.token.edit' : 'compat.token.setHost')
          : m.mode === 'off' ? 'compat.token.offHost'
            : m.mode === 'clear' ? 'compat.token.clearHost' : 'compat.token.onHost')
        let fields
        if (m.mode === 'set') {
          // 竖排三格（圆点看不出填的是哪格，竖排靠顺序当说明）：当前令牌（仅宿主已配时 ——
          // 首次设置没有"当前"可证明，宿主同样不要求）、新令牌、再输一次；三格都齐了
          // 才让按：当前令牌是凭证（宿主会验），新令牌输两遍防手滑（用户裁定 2026-09-19）。
          fields = [
            // 配置改动一律要重启才生效 —— 写在这里，免得用户改完以为没反应。
            React.createElement('p', { key: 'restart', className: 'dsm-help' }, t('compat.token.edit.restartHint')),
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
          // 但当前进程没拿着令牌时（配置里刚写入、还没重启）没有可验证的值，宿主也
          // 不要求 —— 此时不摆输入框，只让用户确认。
          // 开启是反风险方向，accepted 时宿主还认请求头凭证，可以不填直接开。
          const proofRequired = (tokenHostConfigured || m.forceProof === true) && (m.mode === 'off' || m.mode === 'clear')
          const allowEmpty = m.mode === 'on' && !!(tokenState && tokenState.accepted)
          const showProof = proofRequired || (m.mode === 'on' && !allowEmpty)
          fields = [
            showProof ? React.createElement('input', {
              key: 'proof',
              className: 'dsm-control' + (tokenMsg && tokenMsg.field === m.mode ? ' dsm-rule-invalid' : ''),
              type: 'password', value: m.value,
              placeholder: t('compat.token.proofPlaceholder'), 'aria-label': t('compat.token.proofPlaceholder'),
              onChange: function (ev) { setTokenModal({ mode: m.mode, current: '', next: '', repeat: '', value: ev.target.value, forceProof: m.forceProof === true }) },
              onKeyDown: function (ev) { if (ev.key === 'Enter' && (m.value.trim() || allowEmpty)) submitTokenModal() },
            }) : null,
            React.createElement('p', { key: 'hint', className: 'dsm-help' },
              t(m.mode === 'off' ? (proofRequired ? 'compat.token.offConfirm.hint' : 'compat.token.offConfirm.hintNoProof')
                : m.mode === 'clear' ? (proofRequired ? 'compat.token.clearConfirm.hint' : 'compat.token.clearConfirm.hintNoProof')
                  : 'compat.token.onHint')),
            tokenFormError([m.mode]),
          ]
        }
        const yesLabel = m.mode === 'set' ? t('compat.token.edit.save')
          : m.mode === 'off' ? t('compat.token.offConfirm.yes')
            : m.mode === 'clear' ? t('compat.token.clearConfirm.yes') : t('compat.token.onConfirm.yes')
        const proofRequired = (tokenHostConfigured || m.forceProof === true) && (m.mode === 'off' || m.mode === 'clear')
        const yesDisabled = m.mode === 'set'
          ? (!m.next.trim() || tokenSetInvalid || (tokenHostConfigured && !m.current.trim()))
          : (proofRequired && !m.value.trim())
            || (m.mode === 'on' && !m.value.trim() && !(tokenState && tokenState.accepted))
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
              // 关闭钮统一走共享的 X 图标钮（REDESIGN §4.2）。
              React.createElement(ModalCloseButton, { label: t('btn.close'), onClick: closeTokenModal }))),
          React.createElement('div', { className: 'dsm-modal-body' },
            React.createElement('div', { className: 'dsm-token-form' }, fields),
            React.createElement('div', { className: 'dsm-modal-actions' }, [
              React.createElement('button', {
                key: 'yes', type: 'button',
                className: 'dsm-btn' + (m.mode === 'off' || m.mode === 'clear' ? ' dsm-btn-danger' : ''),
                disabled: yesDisabled, onClick: submitTokenModal,
              }, yesLabel),
              React.createElement('button', {
                key: 'cancel', type: 'button', className: 'dsm-btn dsm-btn-secondary', onClick: closeTokenModal,
              }, t('compat.token.edit.cancel'))]))))
      }

      // 注入设置块：本插件注入给模型哪些内容的开关 + 对话输入框的斜杠命令入口（`/` 菜单里的
      // 「工具」与「快捷提示词」两段）。总开关只管"极简这类预设下要不要破例"，各域勾选在任何
      // 预设下都生效。
      //
      // 排版口径（用户裁定 2026-09-16）：勾选**横排**（短标签一行放得下，不再一人一行竖着排），
      // 文案只说到"有这个内容"为止 —— 用户是普通使用者，不解释 persona/载体/路径这些内部机制。
      //
      // 斜杠命令入口并进这一块（用户 2026-09-30 裁定）：它原先自己成一节，那一节的说明又长又和
      // 勾选框自己的标签重复。现在只剩一条分组标题 + 两段各自一颗勾选框（「工具」/「快捷提示词」，
      // 各自就是一个源，所以能各挂各的）+ 一句"重启才生效"。
      const slashParts = []
      if (slash) {
        // 名字右边那枚标签是"本次启动真挂上了没"：开关值说的是"要不要"，挂没挂上只有浏览器知道
        // （服务端看不到源注册的结果），两件事不能合成一句 —— 合了必有一句是假的。标签只说
        // 已生效 / 未生效，**为什么**没生效挂在悬停那句里（重名抢占 / 宿主没这个服务 / 还没就绪，
        // 三种的处置完全不同）—— 见 48-slash.js 的 setSlashMount。
        // 位置（用户裁定 2026-10-15）：跟在名字右边，不摆开关旁 —— 状态说的是"这一段入口
        // 挂上没"，跟着名字读；与 switch 并排会被读成"开关自己的状态"，而开关只说要不要。
        const liveTag = function (key) {
          const state = slashMountStateOf(key)
          const on = state === 'registered'
          return React.createElement('span', {
            key: 'live-' + key,
            className: 'dsm-tag' + (on ? ' dsm-tag-on' : ''), title: t('compat.slash.mount.' + state),
          }, t(on ? 'compat.slash.live.on' : 'compat.slash.live.off'))
        }
        slashParts.push(
          React.createElement('div', { key: 'slash-head', className: 'dsm-seg-group' },
            React.createElement('span', null, t('compat.slash.title')),
            React.createElement('span', { className: 'dsm-seg-group-line' })),
          // 开关行（REDESIGN §5.2 SettingsRow + Switch，切片五换装）：名字+说明在左，
          // 开关在右；「本次启动真挂上了没」的标签在名字右边（tag，见上）。
          React.createElement(SettingsRow, { key: 'slash-tools', name: t('compat.slash.tools'), desc: t('compat.slash.tools.desc'),
            tag: liveTag('tools'),
            control: React.createElement(Switch, { key: 'sw', on: slash.tools !== false, label: t('compat.slash.tools'), onClick: function () { saveSlash({ tools: slash.tools === false }) } }) }),
          React.createElement(SettingsRow, { key: 'slash-quick', name: t('compat.slash.quick'), desc: t('compat.slash.quick.desc'),
            tag: liveTag('quickPrompts'),
            control: React.createElement(Switch, { key: 'sw', on: slash.quickPrompts !== false, label: t('compat.slash.quick'), onClick: function () { saveSlash({ quickPrompts: slash.quickPrompts === false }) } }) }))
      }
      const injectParts = []
      if (inject) {
        const domains = (inject && inject.domains) || {}
        injectParts.push(
            // 开关行（REDESIGN §5.2，切片五换装）：总开关一行。
            React.createElement(SettingsRow, { key: 'force', name: t('compat.inject.force'),
              control: React.createElement(Switch, { on: inject.underSuppressingPresets === true, label: t('compat.inject.force'), onClick: function () { saveInject({ underSuppressingPresets: inject.underSuppressingPresets !== true }) } }) }),
            React.createElement('div', { key: 'domains-head', className: 'dsm-seg-group' },
              React.createElement('span', null, t('compat.inject.domains')),
              React.createElement('span', { className: 'dsm-seg-group-line' })),
            // 六域**一行**（用户 2026-10-12：「分六行很占用空间，能不能一行显示，而且还能美观、
            // 简洁、高级」）：六颗 chip 等分排开，开 = 成功色描边 + 实心点、关 = 默认描边 + 灰点。
            // 不再用六颗 32px 开关 —— 名字与开关并排要 ~105px，六份就是 630px，一行放不下还得
            // 靠缩小字号硬塞；chip 把「名字」本身变成控件，一行 6 个在 760px 里还有余量，
            // 窄栏按 flex-basis 折成两行也不会挤成一团。
            // a11y：role=switch + aria-checked 挂在 chip 上（它就是一个开关，只是长成了标签的样子），
            // 键盘可聚焦、Enter/Space 由 button 语义自带。
            React.createElement('div', { key: 'domains', className: 'dsm-inject-domains' },
              ['scene', 'memory', 'mcp', 'skills', 'subagents', 'prompt'].map(function (key) {
                // 技能与提示词两域在标准类预设下由宿主送、本插件让位 —— 关掉它们时本插件会连
                // 宿主那条一起拦下（见 context-inject.ts 的 officialKindsToSuppress）。这里给
                // 那两项一句 title，免得用户以为"关了没用"。
                const carrier = key === 'skills' || key === 'prompt'
                const on = domains[key] !== false
                return React.createElement('button', {
                  key: 'domain-' + key,
                  type: 'button',
                  role: 'switch',
                  'aria-checked': on,
                  className: 'dsm-inject-chip' + (on ? ' dsm-inject-chip-on' : ''),
                  title: carrier ? t('compat.inject.domain.carrier.title') : undefined,
                  'aria-label': t('compat.inject.domain.' + key),
                  onClick: function () {
                    const nextDomains = Object.assign({}, domains)
                    nextDomains[key] = domains[key] === false
                    saveInject({ domains: nextDomains })
                  },
                },
                  React.createElement('span', { className: 'dsm-inject-chip-dot' }),
                  React.createElement('span', { className: 'dsm-inject-chip-name' }, t('compat.inject.domain.' + key)))
              })))
      }
      // 两块数据各自独立加载：inject 读不到时斜杠入口照样要出现，反之也一样，所以整块的条件是
      // 「任一有值」—— 缺的那半只是不出现，不把另一半一起吞掉。
      if (inject || slash) {
        push(section(inject ? t('compat.inject') : t('compat.slash.title'), inject ? t('compat.inject.hint') : null,
          React.createElement('div', { className: 'dsm-inject-settings' }, injectParts.concat(slashParts))))
      }
      // 模型工具表：与「注入」并列的第二种省法 —— 那边省正文，这边省工具 schema。
      // 工具表**每个请求都发一遍**（哪怕这一轮用不上），所以关掉的工具是整份不进请求，
      // 这是本插件省 token 最实在的一处；代价是模型调不到它（面板不受影响）。
      // 排版（用户 2026-09-23 指出太乱）：**一行一个工具**、四列固定宽度 —— 勾选框 / 名字 /
      // ≈tok / 一句话介绍。挤成一排的小块每行宽度都不一样，竖着扫不出任何一列。
      // 文字两档：行内那句是"干什么用的"（统一动词开头），悬停给稍详细的一句（含边界与代价）。
      // 两档都按工具名去词典取，取不到就让那一格空着（`translateOrFallback`），
      // 绝不把 `compat.tools.about.x` 这种键名当文案显示出来。
      if (toolTable) {
        const report = toolTable.report
        const hidden = toolTable.hidden || []
        const groups = report.groups || []
        const groupLabel = function (key) { return key === 'other' ? t('compat.tools.other') : t('compat.inject.domain.' + key) }
        const toolTableDisabled = toolTableBusy || scopeSessionLocked || toolTable.state === 'unknown'
        const rows = []
        groups.forEach(function (group) {
          const onCount = group.tools.filter(function (tool) { return !tool.hidden }).length
            rows.push(React.createElement('div', { className: 'dsm-tooltable-group', key: 'g-' + group.key },
              // 组头与工具行：原生勾选框换自绘框 RowCheck（REDESIGN §5.1，切片五）。
              // label 包裹照旧 —— 点击行内任意文字都翻勾（button 是可标注控件）。
              React.createElement('label', { className: 'dsm-tooltable-ghead' },
                React.createElement(RowCheck, {
                  checked: onCount === group.tools.length,
                  // 半开半关时显示成"未全选"，点一下 = 全开（与其余全选控件同款：勾选框只表达
                  // 两种意思，第三种状态靠计数说清）。
                  onChange: function () { toggleToolTableGroup(group, onCount !== group.tools.length) },
                  disabled: toolTableDisabled,
                  label: groupLabel(group.key),
                }),
                React.createElement('span', { className: 'dsm-tooltable-gname' }, groupLabel(group.key)),
                React.createElement('span', { className: 'dsm-tooltable-gcount' }, t('compat.tools.groupCount', { on: onCount, total: group.tools.length, tok: group.tok }))),
              React.createElement('div', { className: 'dsm-tooltable-tools' },
                group.tools.map(function (tool) {
                  const about = translateOrFallback(t, 'compat.tools.about.' + tool.name, '')
                  // 悬停 = 稍详细那句 + 空行 + 当前状态。取不到详细那句时退回行内那句，
                  // 于是"悬停什么也没有"不会发生。
                  const hover = translateOrFallback(t, 'compat.tools.hover.' + tool.name, about)
                  return React.createElement('label', {
                    className: 'dsm-tooltable-tool',
                    key: tool.name,
                    title: (hover ? hover + '\n\n' : '') + (tool.hidden
                      ? (tool.defaultHidden ? t('compat.tools.defaultOffTitle') : t('compat.tools.offTitle'))
                      : t('compat.tools.onTitle')),
                  },
                    React.createElement(RowCheck, { checked: !tool.hidden, disabled: toolTableDisabled, label: tool.name, onChange: function () { toggleToolTableTool(tool.name, !!tool.hidden) } }),
                    React.createElement('span', { className: 'dsm-tooltable-name' }, tool.name),
                    React.createElement('span', { className: 'dsm-tooltable-tok' }, '≈' + tool.tok),
                    React.createElement('span', { className: 'dsm-tooltable-about' }, about))
                }))))
        })
        const presetCount = (toolTable.presets || []).length
        // 会话 / 工作区层那一句：这一张表是谁的、改动影响谁。全局层不显示。
        const scopeLine = scopeSessionId
          ? t('compat.tools.scope.' + (toolTable.source === 'session'
            ? (scopeIsWorkspaceMode ? 'workspace' : 'session')
            : toolTable.source === 'baseline'
              ? (scopeIsWorkspaceMode ? 'baseline.workspace' : 'baseline')
              : (scopeIsWorkspaceMode ? 'global.workspace' : 'global')))
          : null
        push(section(t('compat.tools'), null,
          React.createElement('div', { className: 'dsm-tooltable' + (toolTableBusy ? ' dsm-tooltable-busy' : '') },
            React.createElement('div', { className: 'dsm-tooltable-summary' },
              React.createElement('span', null, hidden.length === 0
                ? t('compat.tools.summaryAll', { total: report.totalCount, tok: report.totalTok })
                : t('compat.tools.summary', { on: report.visibleCount, total: report.totalCount, tok: report.visibleTok, saved: report.hiddenTok })),
              // 按钮钉在合计那一行的最右（用户 2026-09-23 指定位置）：方案管的是**整块**
              // 勾选，不属于任何一个域，所以既不放分组头也不放表尾。
              React.createElement('span', { className: 'dsm-tooltable-preset-actions' },
                // 会话 / 工作区层（0.21.2）：把这一层的工具表恢复成**当前全局默认**（只影响这一层）。
                scopeSessionId ? React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: toolTableDisabled,
                  title: scopeIsWorkspaceMode ? t('compat.tools.reset.tip.workspace') : t('compat.tools.reset.tip'),
                  onClick: function () { saveToolTable((toolTable.globalHidden || []).slice()) },
                }, t('compat.tools.reset')) : null,
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-secondary',
                  // 方案库是全局的：会话 / 工作区层只允许"应用"，存 / 删先切到全局默认。
                  disabled: toolTableDisabled || !!scopeSessionId,
                  title: scopeSessionId
                    ? (scopeIsWorkspaceMode ? t('compat.tools.preset.save.workspaceTip') : t('compat.tools.preset.save.sessionTip'))
                    : t('compat.tools.preset.save.tip'),
                  onClick: function () { setToolPreset({ mode: 'save', name: '', error: '' }) },
                }, t('compat.tools.preset.save')),
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: toolTableDisabled,
                  title: presetCount ? t('compat.tools.preset.apply.tip') : t('compat.tools.preset.apply.tipEmpty'),
                  onClick: function () { setToolPreset({ mode: 'apply' }) },
                }, t('compat.tools.preset.apply')))),
            // 这一张表归属哪一层 / 为什么勾不动（锁）。读不到时这一节本来就不渲染。
            scopeLine ? React.createElement('div', { className: 'dsm-tooltable-scope' }, scopeLine) : null,
            scopeSessionLocked
              ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' },
                scopeIsWorkspaceMode ? t('scope.lock.blockedWorkspace') : scopeT('scope.lock.blockedSession'))
              : null,
            toolTableError ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'alert' }, toolTableError) : null,
            // 侧车 unknown：当前名单是"上次成功值 → 出厂默认"的兜底，保存会被服务端拒绝。
            toolTable.state === 'unknown' ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('compat.tools.stateUnknown')) : null,
            // 合计只留一行。此前下面还有一句"其中 ≈X 是出厂默认关掉的 N 条…"，2026-10-12
            // 删除（用户裁定）：同一件事在说明行与工具悬停提示里都说过了，这里是第三次；
            // 而且"出厂默认关掉"这件事用户不需要为此做什么 —— 要用就勾上，不用管它。
            rows)))
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
          // 取数抛异常：这是**故障**（该域内容还在，但这一步取不到），所以给琥珀 ——
          // 与「未投递」（压缩后待补发）不同档，混在一起会把故障读成延迟（2026-09-30 P1-8）。
          if (row.state === 'error') return { cls: ' dsm-compat-pill-warn', text: t('compat.live.state.error'), title: t('compat.live.state.error.title') }
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
        // 观测面：这段对话里到底看到过几次本插件的工具调用。必须显示 —— 采纳全是 0 时，
        // 要能分清"模型真的没用"（结论）和"遥测没接上"（故障）。
        const observedCalls = Number((live.observed || {}).toolCalls) || 0
        const observedText = observedCalls > 0
          ? t('compat.live.observe.some', { count: observedCalls })
          : t('compat.live.observe.none')
        // 成本一行：总量 / 最费的域 / 重发最多的域。只在**真投过东西**时出现 ——
        // 全 0 时摆一行「累计约 0 B」是噪声（与上面 adoptText 的取向一致：没投过的域不报统计）。
        // 字节数是「当前正文 × 投递次数」的近似（服务端已注明），所以句子带「约」。
        const cost = live.cost || {}
        const costName = function (entry) { return entry ? (domainLabel(entry.key) || String(entry.label || '')) : '' }
        const costBytes = Number(cost.injectedBytes) || 0
        const costText = costBytes > 0 && cost.topDomain
          ? t('compat.live.cost', {
              size: fmtSize(costBytes),
              domain: costName(cost.topDomain),
              resent: costName(cost.mostDelivered),
            })
          : ''
        const canCopy = (live.domains || []).some(hasText)
        liveContent = React.createElement('section', { className: 'dsm-compat-section' },
          React.createElement('div', { className: 'dsm-compat-section-head' },
            // 标题交给弹窗头部，这一行只留实况句与「复制」
            React.createElement('span', { className: 'dsm-compat-section-hint' }, t('compat.live.hint') + ' · ' + deliveredText + ' · ' + observedText + (costText ? ' · ' + costText : '')),
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
              }))))
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
        // 摘要三形态：能力降级 / 仅身份待处理 / 全部可用。仅身份待处理时**不能**说
        // 「全部可用」—— 横幅已转红（有阻塞项），摘要却报一切正常，两句自相矛盾
        // （2026-09-30 桌面版实测）。
        const summaryKey = degradedN > 0 ? 'compat.summary.degraded'
          : blockedCount > 0 ? 'compat.summary.identity' : 'compat.summary.ok'
        const summaryText = findingsN === 0
          ? (data.summary || '')
          : t(summaryKey)
            .replace('{version}', String((data.host && data.host.version) || '?'))
            .replace('{ok}', String(findingsN - degradedN))
            .replace('{total}', String(findingsN))
            .replace('{count}', String(degradedN > 0 ? degradedN : blockedCount))
        push(React.createElement('div', { className: 'dsm-compat-bar' + (blockedCount > 0 ? ' dsm-compat-bar-warn' : '') },
          React.createElement('span', { className: 'dsm-compat-dot' + (blockedCount > 0 ? ' dsm-compat-dot-warn' : '') }),
          React.createElement('strong', null, blockedCount > 0 ? t('compat.state.blocked') : t('compat.state.ok')),
          React.createElement('span', { className: 'dsm-compat-sum' }, summaryText)))

        // 指标卡：宿主 / 本插件适配版本 / 可用能力（含插件自补的 optional 槽位）。
        // 三张卡都只在**有事要说**时带注脚：
        //   * 宿主、适配版本：一个值就够（2026-09-29 用户裁定：删掉「最低要求 ≥ …」与
        //     「本插件按此版本验证」—— 前者是安装期门槛，后者是同一件事说两遍）；
        //   * 可用能力：全通过时不再写「全部通过」（分子分母已经说了这件事），只在有降级
        //     或有插件自补时说清楚是哪一种（2026-09-29 用户裁定）。
        //   * 注脚与红色只跟**能力**降级走（degraded）：身份阻塞项（两份拷贝 / 待处理）
        //     不是能力不可用 —— 此前用 blockedCount（能力 + 身份）当注脚数，桌面版上出现
        //     过「可用能力 18/18」旁边标红「5 项不可用」的自相矛盾（2026-09-30 实测）。
        const capsNote = degraded.length > 0
          ? t('compat.caps.degraded').replace('{count}', String(degraded.length))
          : (usableCount === findings.length ? null : t('compat.caps.substituted'))
        push(React.createElement('div', { className: 'dsm-compat-grid' },
          card(t('compat.host'), (data.host && data.host.version) || '?', null, false),
          card(t('compat.verified'), data.verifiedVersion || '?', null, false),
          card(t('compat.caps'), String(usableCount) + '/' + String(findings.length), capsNote, degraded.length > 0)))

        // 版本栅栏（B3）：实际宿主与本插件验证过的版本不同时说出来 —— 否则"照旧版本的印象
        // 判断"会让人把探测结果当成 bug。只提示、不拦（peer 的上界只管**安装期**收不收，
        // 这里管的是"已经跑起来了，版本对不上要说一声"：同代的 rc 差异提示一次即可）。
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
          push(section(t('compat.features'), null,
            React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              features.rows.map(function (row) {
                const cls = row.state === 'ok' ? 'dsm-compat-pill-ok'
                  : (row.state === 'disabled' || row.state === 'locked' || row.state === 'locked-scene') ? ''
                    : 'dsm-compat-pill-warn'
                return React.createElement('div', {
                  className: 'dsm-compat-mod-row' + (row.tab ? ' dsm-compat-row-link' : ''),
                  key: row.key,
                  role: row.tab ? 'button' : undefined,
                  tabIndex: row.tab ? 0 : undefined,
                  onClick: row.tab ? function () { jumpToTab(row.tab) } : undefined,
                },
                  React.createElement('span', { className: 'dsm-compat-name' }, ovLabel(row.key) || row.label),
                  React.createElement('span', { className: 'dsm-compat-pill ' + cls },
                    t('compat.feature.state.' + String(row.state || 'unknown'))),
                  React.createElement('span', { className: 'dsm-compat-mod dsm-compat-mod-self' },
                    React.createElement('span', { className: 'dsm-compat-label' }, t('compat.reason')),
                    ovDetail(row)))
              }))))
        }

        // 阻塞项放最前：这是唯一"必须动手"的东西。
        if (blockers.length) {
          push(section(t('compat.blockers'), null,
            React.createElement('div', { className: 'dsm-feedback dsm-error' },
              React.createElement('ul', { className: 'dsm-compat-list' },
                blockers.map(function (item, i) { return React.createElement('li', { key: i }, item) })))))
        }

        // 宿主契约（0.2.1 新增的三处适配面 + Web 连接准入）：这几条在能力表里是**必填项**，
        // 不是"宿主没有、插件自己顶上"的可选槽。缺了不抛错，只是功能少一半 —— 所以单独一块
        // 列出来，让"升级后某处悄悄不工作"有一个显眼的位置。
        const contractFindings = findings.filter(function (item) {
          return CONTRACT_CAPABILITY_IDS.indexOf(item.id) !== -1 && item.state !== 'ok'
        })
        push(section(t('compat.contracts'), null,
          contractFindings.length === 0
            ? React.createElement('p', { className: 'dsm-help' }, t('compat.contracts.allOk'))
            : React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
                contractFindings.map(function (item) {
                  return React.createElement('div', { className: 'dsm-compat-mod-row', key: item.id },
                    React.createElement('span', { className: 'dsm-compat-name' }, capLabel(item.id, item.label)),
                    React.createElement('span', { className: 'dsm-compat-pill dsm-compat-pill-warn' }, t('compat.contracts.missing')),
                    React.createElement('span', { className: 'dsm-compat-mod dsm-compat-mod-self' },
                      React.createElement('span', { className: 'dsm-compat-label' }, t('compat.reason')), item.detail))
                }))))

        // 动作可用性：一行一个动作 + 路径标记（不可用的标红）。
        push(section(t('compat.ops'), null,
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
        //
        // 与上面「宿主契约」那块的区别：这里的条目缺了，插件**自有等价实现**（适配路完整可用）；
        // 那块的条目缺了，没有替代实现，功能就是少一半。两块都是"非 ok"，但后果不同，
        // 所以分开显示、各自的胶囊文案也不同。
        const optionalAbsent = findings.filter(function (item) { return item.state !== 'ok' && item.optional === true })
        if (optionalAbsent.length) {
          push(section(t('compat.others'), null,
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
        // 归档宿主（桌面版）先把清单读出来：那几个包两侧的**版本相同**，只是宿主那份在
        // app.asar 里 —— 它们不能显示成「无法比较」后就此打住，得说清是哪种比不了。
        const identityNotes = (data && data.notes) || []
        const asarNote = identityNotes.filter(function (note) {
          return note && note.kind === 'asar-host'
        })[0]
        const asarPackages = (asarNote && asarNote.packages) || []
        const asarNames = asarPackages.map(function (item) { return String(item && item.name || '') })
        // 真实形态取不到的包：那一格同样「无法比较」，但原因与归档无关，得分开标。
        const realpathNoteForPill = identityNotes.filter(function (note) {
          return note && note.kind === 'realpath'
        })[0]
        const realpathNames = ((realpathNoteForPill && realpathNoteForPill.failures) || []).map(function (item) {
          return String(item && item.name || '')
        })
        push(section(t('compat.modules'), null,
          React.createElement('div', { className: 'dsm-compat-mod-list' },
            Object.keys(sameAsHost).map(function (name) {
              const same = sameAsHost[name]
              const inRealpath = realpathNames.indexOf(name) !== -1
              const inAsar = asarNames.indexOf(name) !== -1
              const cls = same === true ? 'dsm-compat-pill-ok' : same === false ? 'dsm-compat-pill-bad' : ''
              const text = same === true ? t('compat.module.same')
                : same === false ? t('compat.module.separate')
                  : inRealpath ? t('compat.module.realpath')
                    : inAsar ? t('compat.module.sameVersion') : t('compat.module.unknown')
              return React.createElement('div', { className: 'dsm-compat-mod-row', key: name },
                React.createElement('span', { className: 'dsm-compat-name dsm-compat-mod' }, name),
                React.createElement('span', { className: 'dsm-compat-pill ' + cls }, text))
            }))))

        // 裸模块解析（与上面那一块的分工：上面比的是**同一份物理模块**，这里看的是**包还在不在**）。
        //
        // 为什么分开：上面那 6 个包是插件的 peerDependency，「两份不同拷贝」那种故障只可能发生在
        // 它们身上；而下面这 4 个包是插件按**裸模块名**在运行时 require 的官方包，宿主不要求插件
        // 依赖它们。官方撤掉其中一个，对应功能静默降级，而身份比对那一栏根本看不见它们 —— 所以
        // 必须在这里列一行。canary 缺失不是「包坏了」，是「该人工复核这条契约」，显示成提示而非红色。
        const contractPackages = (data && data.contracts && data.contracts.packages) || []
        if (contractPackages.length) {
          push(section(t('compat.bareModules'), null,
            React.createElement('div', { className: 'dsm-compat-mod-list dsm-compat-cards' },
              contractPackages.map(function (item) {
                const missing = item.resolved === null
                const drifted = !missing && (item.missingMarkers || []).length > 0
                return React.createElement('div', { className: 'dsm-compat-mod-row', key: item.package },
                  React.createElement('span', { className: 'dsm-compat-name dsm-compat-mod' }, item.package),
                  React.createElement('span', { className: 'dsm-compat-pill ' + (missing ? 'dsm-compat-pill-bad' : drifted ? 'dsm-compat-pill-warn' : 'dsm-compat-pill-ok') },
                    missing ? t('compat.bareModules.absent') : drifted ? t('compat.bareModules.drift') : t('compat.bareModules.present')),
                  React.createElement('span', { className: 'dsm-compat-mod dsm-compat-mod-self' },
                    React.createElement('span', { className: 'dsm-compat-label' }, t('compat.reason')),
                    missing ? t('compat.bareModules.absentWhy', { feature: item.feature })
                      : drifted ? t('compat.bareModules.driftWhy', { feature: item.feature, markers: (item.missingMarkers || []).join('、') })
                        : t('compat.bareModules.presentWhy', { feature: item.feature })))
              }))))
        }

        // 「无法比对」必须给原因：否则一排未知标记看起来只是噪音，用户会当成正常现象。
        // 归档宿主的说明排最前 —— 它解释的正是这一排「无法比较」的成因，而且必须讲明白
        // **不要去跑 host-deps --fix**：那条命令会把插件的依赖指向 npx 缓存里另一个版本。
        if (asarNote) {
          const count = asarPackages.length
          const version = asarNote.hostVersion || '?'
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.modules.asarHost')
              .replace('{name}', String(asarNote.asarName || 'app.asar'))
              .replace('{count}', String(count))
              .replace('{version}', version)))
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.modules.asarHostPackages')
              .replace('{count}', String(count))
              .replace('{version}', version)
              .replace('{names}', asarNames.join('、'))))
        }
        if (unverified.length) {
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.modules.unverified')
              .replace('{count}', String(unverified.length))
              .replace('{names}', unverified.join('、'))))
        }
        // 路径取不到真实形态：这一格是「比不了」，不是「两份拷贝」。必须把原因摆出来 ——
        // 否则用户只会看到一排「无法比较」，而不知道是路径/权限的问题（issue #1）。
        const realpathNote = identityNotes.filter(function (note) {
          return note && note.kind === 'realpath'
        })[0]
        if (realpathNote) {
          const failures = realpathNote.failures || []
          const names = failures.map(function (item) { return String(item && item.name || '') })
          const sideText = function (side) {
            return failures.filter(function (item) { return item && item.side === side })
              .map(function (item) { return String(item && item.path || '') + '（' + String(item && item.reason || '') + '）' })
              .join('；')
          }
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.modules.realpath')
              .replace('{count}', String(failures.length))
              .replace('{names}', names.join('、'))))
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.modules.realpathSides')
              .replace('{host}', sideText('host') || t('compat.modules.realpathNone'))
              .replace('{plugin}', sideText('plugin') || t('compat.modules.realpathNone'))))
        }

        // 命令行体检那句只在源码检出时说：npm 安装形态不带 scripts/，指过去是条走不通的路。
        if (data && data.sourceInstall === true) {
          push(React.createElement('p', { className: 'dsm-help' },
            t('compat.hint.doctor'),
            React.createElement('code', { className: 'dsm-compat-code' }, ' node scripts/doctor.mjs')))
        }
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
        push(section(t('compat.reach'), null,
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
                  React.createElement('span', null, (PRESET_MODE_NAME_KEYS[row.presetId] ? t(PRESET_MODE_NAME_KEYS[row.presetId]) : (row.name || row.presetId)) + (row.isDefault ? ' · ' + t('compat.reach.default') : '')),
                  tags.length ? React.createElement('span', { className: 'dsm-tags' }, tags) : null),
                // 芯片顺序与「注入」块的勾选顺序一致（用户裁定 2026-09-16；2026-09-23 起
                // 场景与记忆是两个域，各占一枚）：场景 → 记忆 → MCP → 技能 → 子智能体 → 提示词。
                React.createElement('span', { className: 'dsm-compat-reach-marks' },
                  chip(t('compat.reach.mark.scene'), row.scene),
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

      // ── 最近改动（0.15.0 B2）─────────────────────────────────────────────────
      // 倒序列表 + 按域过滤 + 「同秒同来源」合并。落盘不去重（保真），合并只发生在展示层：
      // 进一次场景会连写几条，逐条铺开会把「一次动作」读成「很多次改动」。
      // [op 前缀, i18n 键尾]：键名不用前缀原文，`tool-table` 这类带短横线的名字进不了词典键的
      // 正则（check:i18n 只认 [A-Za-z0-9._]），漏过去就是"英文界面显示原始键名"。
      const AUDIT_DOMAINS = [['', 'all'], ['mcpm', 'mcpm'], ['skill', 'skill'], ['rules', 'rules'], ['scene', 'scene'], ['subagent', 'subagent'], ['agentsmd', 'agentsmd'], ['history', 'history'], ['tool-table', 'toolTable'], ['inject-settings', 'injectSettings'], ['backups', 'backups']]
      // 时间列恒显示「月-日 时:分」：流水一屏跨好几天是常态，"今天只给时分"会让人
      // 分不清 22:04 是今晚还是昨晚（用户 2026-09-28）。
      const auditTimeText = function (sec) {
        const d = new Date(sec * 1000)
        return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' +
          ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
      }
      const auditGroups = function (entries) {
        const out = []
        for (const e of (entries || [])) {
          const sec = Math.floor(Number(e.ts) / 1000)
          const last = out.length ? out[out.length - 1] : null
          // 列表已经是倒序，所以「同一组」必然相邻；不排序也就不破坏服务端给的时序。
          if (last && last.sec === sec && last.source === e.source) { last.items.push(e); continue }
          out.push({ sec: sec, source: e.source, items: [e] })
        }
        return out
      }
      auditContent = React.createElement('div', { className: 'dsm-audit' },
          React.createElement('div', { className: 'dsm-audit-bar' },
            React.createElement(SourceSelect, {
              className: 'dsm-audit-filter', ariaLabel: t('compat.audit.domain'),
              options: AUDIT_DOMAINS.map(function (d) { return { value: d[0], label: t('compat.audit.domain.' + d[1]) } }),
              value: (audit && audit.domain) || '', disabled: !audit || audit.loading === true,
              onChange: function (v) { loadAudit(v) },
            }),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: !audit || audit.loading === true, onClick: function () { loadAudit((audit && audit.domain) || '') } }, t('compat.audit.reload')),
            // 清除是两步：按钮先变成「确认清除」+「取消」，不做"一按就没了"（与清理旧备份同口径）。
            auditConfirm === true
              ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet dsm-btn-danger', disabled: auditClearing === true, onClick: doAuditClear }, t('compat.audit.clear.confirm'))
              : React.createElement('button', {
                type: 'button', className: 'dsm-btn dsm-btn-quiet', title: t('compat.audit.clear.title'),
                disabled: !audit || audit.loading === true || auditClearing === true || !(audit.entries || []).length,
                onClick: function () { setAuditConfirm(true) },
              }, t('compat.audit.clear')),
            auditConfirm === true ? React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: auditClearing === true, onClick: function () { setAuditConfirm(false) } }, t('btn.cancel')) : null),
          (!audit || audit.loading) ? React.createElement('div', { className: 'dsm-empty' }, t('compat.audit.loading')) : null,
          audit && audit.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, audit.error) : null,
          audit && !audit.loading && !audit.error && !audit.entries.length ? React.createElement('div', { className: 'dsm-empty' }, t('compat.audit.empty')) : null,
          audit && !audit.loading && audit.entries.length ? React.createElement('div', { className: 'dsm-audit-list' },
            React.createElement('div', { className: 'dsm-compat-table-head dsm-audit-head' },
              React.createElement('span', null, t('compat.audit.col.time')),
              React.createElement('span', null, t('compat.audit.col.action'))),
            auditGroups(audit.entries).map(function (g, i) {
              return React.createElement('div', { className: 'dsm-audit-row', key: g.sec + '-' + g.source + '-' + i },
                React.createElement('span', { className: 'dsm-audit-time' }, auditTimeText(g.sec)),
                React.createElement('span', { className: 'dsm-audit-main' },
                  g.items.map(function (e, j) {
                    return React.createElement('span', { className: 'dsm-audit-item', key: j },
                      AUDIT_OP_LABELS[e.op] ? t(AUDIT_OP_LABELS[e.op]) : e.op,
                      e.target && e.target !== '@config' ? React.createElement('span', { className: 'dsm-audit-target' }, '「' + e.target + '」') : null)
                  }),
                  g.items.length > 1 ? React.createElement('span', { className: 'dsm-audit-more' }, t('compat.audit.group.more', { count: g.items.length })) : null,
                  React.createElement('span', { className: 'dsm-pill' }, t('compat.audit.source.' + g.source))))
            })) : null)

      // ── 整机迁移（0.15.0 C2）──────────────────────────────────────────────────
      // 导出 = 一个目录带走全部；导入 = 先读清单预览、勾选域、选冲突策略，再执行。
      // 两步是硬要求：一次写六个域的失败面太大，用户必须先看到"哪域有多少、几个重名"。
      /** 内联的目录浏览面板（挂在对应输入框下面，不再套一层弹窗）。 */
      const snapBrowsePanel = function (target) {
        if (!browse || browse.target !== target) return null
        return React.createElement('div', { className: 'dsm-snap-browse' },
          React.createElement('div', { className: 'dsm-dir-row' },
            React.createElement('input', {
              className: 'dsm-control', value: browse.path, placeholder: t('dir.pathPlaceholder'),
              onChange: function (e) { setBrowse(Object.assign({}, browse, { path: e.target.value })) },
              onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); browseLoad(e.target.value, target) } },
            }),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', onClick: function () { browseLoad(browse.path, target) } }, t('dir.jump')),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: !browse.parent, onClick: function () { browseLoad(browse.parent, target) } }, t('dir.up'))),
          browse.loading ? React.createElement('div', { className: 'dsm-empty' }, t('dir.loading'))
            : browse.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, browse.error)
              : React.createElement('div', { className: 'dsm-dir-list' }, (browse.entries || []).length
                ? browse.entries.map(function (e) {
                  return React.createElement('button', { key: e.path, type: 'button', className: 'dsm-dir-item', title: e.path, onClick: function () { browseLoad(e.path, target) } }, e.name)
                })
                : React.createElement('div', { className: 'dsm-empty' }, t('dir.empty'))),
          React.createElement('div', { className: 'dsm-snap-browse-foot' },
            React.createElement('span', { className: 'dsm-help' }, browse.current || ''),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: !browse.current, onClick: browsePick }, t('dir.pick'))))
      }
      snapshotContent = React.createElement('div', { className: 'dsm-snap' },
        React.createElement('div', { className: 'dsm-field' },
          React.createElement('span', { className: 'dsm-label' }, t('snapshot.export.dir')),
          React.createElement('div', { className: 'dsm-snap-row' },
            React.createElement('input', {
              className: 'dsm-control', value: snap.outDir, placeholder: defaultIoDir(),
              disabled: snap.busy === true, onChange: function (e) { setSnap(Object.assign({}, snap, { outDir: e.target.value })) },
            }),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: snap.busy === true, onClick: function () { browseOpen('export', snap.outDir) } }, t('snapshot.browse')),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: snap.busy === true || !String(snap.outDir).trim(), onClick: doSnapshotExport }, snap.busy ? t('snapshot.export.busy') : t('snapshot.export.btn'))),
          snapBrowsePanel('export')),
        React.createElement(SettingsRow, { name: t('snapshot.export.secrets'),
          control: React.createElement(Switch, { on: snap.includeSecrets === true, disabled: snap.busy === true, label: t('snapshot.export.secrets'), onClick: function () { setSnap(Object.assign({}, snap, { includeSecrets: !(snap.includeSecrets === true) })) } }) }),
        // 明文警告只在**勾了之后**才出现：默认那一份是打码的，常驻一段吓人的话只会稀释重点。
        snap.includeSecrets === true ? React.createElement('p', { className: 'dsm-help' }, t('snapshot.export.secrets.warn')) : null,
        snap.result ? React.createElement('div', { className: 'dsm-feedback' + (snap.result.ok ? '' : ' dsm-error'), role: snap.result.ok ? 'status' : 'alert' },
          React.createElement('div', null, snap.result.text),
          snap.result.ok && snap.result.counts ? React.createElement('div', { className: 'dsm-help' }, t('snapshot.counts', { items: snap.result.counts })) : null,
          snap.result.ok && snap.result.notes ? React.createElement('div', { className: 'dsm-help' }, t('snapshot.notes', { items: snap.result.notes })) : null) : null,
        React.createElement('div', { className: 'dsm-field' },
          React.createElement('span', { className: 'dsm-label' }, t('snapshot.import.dir')),
          React.createElement('div', { className: 'dsm-snap-row' },
            React.createElement('input', {
              className: 'dsm-control', value: snapIn.dir, placeholder: defaultIoDir(),
              disabled: snapIn.busy === true, onChange: function (e) { setSnapIn(Object.assign({}, snapIn, { dir: e.target.value, preview: null, result: null })) },
            }),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: snapIn.busy === true, onClick: function () { browseOpen('import', snapIn.dir) } }, t('snapshot.browse')),
            React.createElement('button', { type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: snapIn.loading === true || snapIn.busy === true || !String(snapIn.dir).trim(), onClick: doSnapshotPreview }, snapIn.loading ? t('snapshot.import.busy') : t('snapshot.import.preview'))),
          snapBrowsePanel('import')),
        snapIn.error ? React.createElement('div', { className: 'dsm-feedback dsm-error', role: 'alert' }, snapIn.error) : null,
        snapIn.preview ? React.createElement('div', { className: 'dsm-snap-preview' },
          React.createElement('div', { className: 'dsm-help' },
            t('snapshot.import.versionNote', { version: snapIn.preview.pluginVersion || '?' })
            + ' · ' + (snapIn.preview.masked === false ? t('snapshot.import.unmasked') : t('snapshot.import.masked'))
            + ((snapIn.preview.notes || []).length ? ' · ' + t('snapshot.notes', { items: snapIn.preview.notes.join('；') }) : '')),
          (snapIn.preview.domains || []).length ? React.createElement('div', { className: 'dsm-snap-picks' }, (snapIn.preview.domains || []).map(function (d) {
            // 导入预览 = 行选择（REDESIGN §5.1，切片五）：整行可点勾选，域/条数/冲突数一句话。
            return React.createElement(RowSelect, {
              key: d.domain,
              checked: snapIn.picked[d.domain] === true, disabled: snapIn.busy === true,
              name: t('snapshot.import.row', { domain: t('snapshot.domain.' + d.domain), count: d.count, clashes: d.clashes }),
              onChange: function () { var next = Object.assign({}, snapIn.picked); next[d.domain] = snapIn.picked[d.domain] !== true; setSnapIn(Object.assign({}, snapIn, { picked: next })) },
            })
          })) : React.createElement('div', { className: 'dsm-empty' }, t('snapshot.import.notFound')),
          React.createElement('div', { className: 'dsm-audit-bar' },
            // 冲突策略二选一：分段控件（REDESIGN §5.2，切片五换装，原为两颗单选框）。
            React.createElement('div', { className: 'dsm-form-seg', role: 'group' },
              React.createElement('button', { type: 'button', 'aria-pressed': snapIn.conflict === 'skip', onClick: function () { setSnapIn(Object.assign({}, snapIn, { conflict: 'skip' })) } },
                t('snapshot.import.conflict.skip')),
              React.createElement('button', { type: 'button', 'aria-pressed': snapIn.conflict === 'overwrite', onClick: function () { setSnapIn(Object.assign({}, snapIn, { conflict: 'overwrite' })) } },
                t('snapshot.import.conflict.overwrite'))),
            React.createElement('button', {
              type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: snapIn.busy === true || !(snapIn.preview.domains || []).some(function (d) { return snapIn.picked[d.domain] === true }),
              onClick: doSnapshotImport,
            }, snapIn.busy ? t('snapshot.import.busy') : t('snapshot.import.run'))),
          (snapIn.lockedScenes || []).length ? React.createElement('div', { className: 'dsm-feedback dsm-warning', role: 'status' }, t('snapshot.import.locked', { names: snapIn.lockedScenes.join('、') })) : null) : null,
        snapIn.result ? React.createElement('div', { className: 'dsm-feedback' + (snapIn.result.ok ? '' : ' dsm-error'), role: snapIn.result.ok ? 'status' : 'alert' },
          React.createElement('div', null, snapIn.result.text),
          (snapIn.result.report || []).map(function (row, i) {
            var warn = (row.warnings || []).length ? ' ' + t('snapshot.import.reportWarning', { warnings: row.warnings.join('；') }) : ''
            return React.createElement('div', { key: i, className: 'dsm-help' + (warn ? ' dsm-warning' : '') }, (row.error
              ? t('snapshot.import.reportFailed', { domain: t('snapshot.domain.' + row.domain), error: row.error })
              : t('snapshot.import.report', { domain: t('snapshot.domain.' + row.domain), imported: row.imported, skipped: row.skipped })) + warn)
          })) : null)

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
              React.createElement('div', { className: 'dsm-form-seg', role: 'group', 'aria-label': label },
                tiers.map(function (n) {
                  return React.createElement('button', {
                    key: n, type: 'button', disabled: dialogBusy,
                    'aria-pressed': n === row.doomed,
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
        // 陷阱）复用模块作用域的那三个函数（20-helpers.js 的「弹窗键盘行为」一节），打开时把焦点交给弹窗自己。
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
              // 关闭钮统一走共享的 X 图标钮（REDESIGN §4.2）。
              React.createElement(ModalCloseButton, { label: t('btn.close'), onClick: function () { setBackupClean(null) } }))),
          React.createElement('div', { className: 'dsm-modal-body' }, rows)))
      }

      // 「方案」弹窗（保存与恢复共用一颗入口、两种 mode）：结构与令牌 / 备份清理弹窗同款 ——
      // 遮罩点击关闭 + 头部标题与关闭键 + body + 底部动作行，Esc 与焦点陷阱复用模块作用域助手。
      // 为什么恢复要能删：方案是试出来的一旦攒多了就没人在清单里认得出哪个是哪个，
      // 不给出口就只能到磁盘上改文件（用户 2026-09-23 明确要"在恢复弹窗里也能删"）。
      let toolPresetModal = null
      if (toolPreset) {
        const closePreset = function () { setToolPreset(null) }
        const presetBusy = !!toolPreset.busy || toolTableBusy
        const presetRows = []
        if (toolPreset.mode === 'save') {
          const report0 = (toolTable && toolTable.report) || {}
          const nameDraft = String(toolPreset.name || '')
          presetRows.push(React.createElement('p', { className: 'dsm-help', key: 'hint' },
            t('compat.tools.preset.saveHint', {
              on: report0.visibleCount || 0, total: report0.totalCount || 0, tok: report0.visibleTok || 0,
            })))
          presetRows.push(React.createElement('label', { className: 'dsm-field', key: 'name' },
            React.createElement('span', { className: 'dsm-label' }, t('compat.tools.preset.name')),
            React.createElement('input', {
              ref: toolPresetInputRef, className: 'dsm-control', type: 'text',
              maxLength: 40, value: nameDraft, placeholder: t('compat.tools.preset.namePlaceholder'),
              onChange: function (e) { setToolPreset(Object.assign({}, toolPreset, { name: e.target.value, error: '' })) },
              onKeyDown: function (e) { if (e.key === 'Enter') submitToolPreset() },
            })))
          if (toolPreset.error) {
            presetRows.push(React.createElement('p', { className: 'dsm-feedback dsm-warning', role: 'alert', key: 'err' }, toolPreset.error))
          }
          presetRows.push(React.createElement('div', { className: 'dsm-modal-actions', key: 'act' },
            React.createElement('button', {
              type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: presetBusy, onClick: closePreset,
            }, t('btn.cancel')),
            React.createElement('button', {
              type: 'button', className: 'dsm-btn', disabled: presetBusy || !nameDraft.trim(), onClick: submitToolPreset,
            }, t('compat.tools.preset.saveYes'))))
        } else {
          const tokOf = toolTokByName()
          const rep = (toolTable && toolTable.report) || {}
          const total = rep.totalCount || 0
          const totalTok = rep.totalTok || 0
          const entries = [{
            key: '', name: t('compat.tools.preset.default'), builtin: true,
            hidden: (toolTable && toolTable.defaultHidden) || [],
          }]
          const storedPresets = (toolTable && toolTable.presets) || []
          storedPresets.forEach(function (p) {
            // `builtin` 必须显式给 false：数组类型由首元素（出厂默认，builtin: true）推断，
            // 漏了它 typecheck:client 会红；运行时 `e.builtin ? 删除键 : null` 依赖这个假值。
            entries.push({ key: p.name, name: p.name, builtin: false, hidden: p.hidden || [] })
          })
          presetRows.push(React.createElement('p', { className: 'dsm-help', key: 'hint' },
            t('compat.tools.preset.applyHint') + (scopeSessionId
              ? ' ' + (scopeIsWorkspaceMode ? t('compat.tools.preset.applyHint.workspace') : t('compat.tools.preset.applyHint.session'))
              : '')))
          presetRows.push(React.createElement('div', { className: 'dsm-preset-list', key: 'list' },
            entries.map(function (e) {
              // 只数**注册表里真有的**名字：方案可能存自更早的版本（那条工具已经不叫这个了），
              // 把陌生名字算进"关着的"会让这一行报出一个假的合计。应用时服务端本来也会把这些
              // 名字滤掉（`tool-table` 的 set 路径），所以这里显示的与真会生效的是同一份。
              const known = e.hidden.filter(function (n) { return tokOf[n] !== undefined })
              let offTok = 0
              known.forEach(function (n) { offTok += tokOf[n] })
              return React.createElement('div', { className: 'dsm-preset-row', key: e.key },
                React.createElement('span', { className: 'dsm-preset-name' },
                  e.name,
                  e.builtin ? React.createElement('span', { className: 'dsm-preset-tag' }, t('compat.tools.preset.builtin')) : null),
                React.createElement('span', { className: 'dsm-preset-meta' }, t('compat.tools.preset.count', {
                  on: total - known.length, total: total, tok: totalTok - offTok,
                })),
                React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-secondary', disabled: presetBusy,
                  onClick: function () { applyToolPreset(e.hidden) },
                }, t('compat.tools.preset.use')),
                // 出厂默认不在文件里（它是代码里那份名单），所以没有删除键 —— 删它没有意义，
                // 下次读盘它还会回来；能删的只有用户自己存的那几份。
                e.builtin ? null : React.createElement('button', {
                  type: 'button', className: 'dsm-btn dsm-btn-danger', disabled: presetBusy || !!scopeSessionId,
                  title: scopeSessionId
                    ? (scopeIsWorkspaceMode ? t('compat.tools.preset.delete.workspaceTip') : t('compat.tools.preset.delete.sessionTip'))
                    : t('compat.tools.preset.removeTitle', { name: e.name }),
                  onClick: function () { deleteToolPreset(e.name) },
                }, t('btn.custom.remove')))
            })))
          if (toolPreset.error) {
            presetRows.push(React.createElement('p', { className: 'dsm-feedback dsm-warning', role: 'alert', key: 'err' }, toolPreset.error))
          }
        }
        toolPresetModal = React.createElement('div', {
          key: 'preset-modal',
          className: 'dsm-mask',
          onMouseDown: function (e) { if (e.target === e.currentTarget) closePreset() },
        }, React.createElement('div', {
          ref: toolPresetDialogRef, tabIndex: -1,
          className: 'dsm-modal dsm-modal-sm', role: 'dialog', 'aria-modal': 'true',
          'aria-labelledby': 'dsm-preset-title',
          onKeyDown: function (e) { if (!handleModalEscape(e, closePreset)) trapModalFocus(e.currentTarget, e) },
        },
          React.createElement('div', { className: 'dsm-modal-head-wrap' },
            React.createElement('div', { className: 'dsm-modal-head' },
              React.createElement('h3', { className: 'dsm-modal-title', id: 'dsm-preset-title' },
                t(toolPreset.mode === 'save' ? 'compat.tools.preset.saveTitle' : 'compat.tools.preset.applyTitle')),
              // 关闭钮统一走共享的 X 图标钮（REDESIGN §4.2）。
              React.createElement(ModalCloseButton, { label: t('btn.close'), onClick: closePreset }))),
          React.createElement('div', { className: 'dsm-modal-body' }, presetRows)))
      }

      /**
       * 侧栏入口的开关（2026-10-18）：按钮文字说的是**点下去会发生什么**（开着 → 「关闭侧栏」），
       * 与「全选 ↔ 取消全选」「刷新 ↔ 刷新中…」同一套写法。默认开（侧车默认值同）。
       * 失败只回一行提示，不改按钮 —— 回滚由 saveSidebarEntry 做（乐观更新那一步）。
       */
      const sidebarEntry = useSidebarEntrySnapshot()
      const toggleSidebarEntry = function () {
        if (sidebarEntry.busy === true) return
        saveSidebarEntry(sidebarEntry.enabled === false).then(function (r) {
          if (!r || r.ok) return
          showPluginToast(r.error || t('compat.sidebar.failed'), 'err')
        })
      }
      // 三块内容各自只在**打开时**挂进弹窗；说明句留在框内第一行（原来长在区块小标题右侧，
      // 进了弹窗就没有"标题右边"这个位置了）。
      // 按钮**永远点得开**：数据没读到时框里给一句话，而不是摆一枚按了没反应的按钮
      // （与提示词页「被引用的预设点得动但删不掉」同一条口径 —— 禁用按钮连 title 都不弹）。
      const dialogFallback = function () {
        return React.createElement('div', { className: 'dsm-empty' }, t('compat.dialog.empty'))
      }
      const auditDialog = compatDialogOpen === 'audit'
        ? compatDialog('audit', t('compat.audit'), [
          // 说明 ≤1 行（REDESIGN §7）；512KB 清理机制那句全文进悬浮。
          React.createElement('p', { key: 'hint', className: 'dsm-help', title: t('compat.audit.hint.full') }, t('compat.audit.hint')),
          auditContent ? React.cloneElement(auditContent, { key: 'body' }) : dialogFallback(),
        ], true)
        : null
      const snapshotDialog = compatDialogOpen === 'snapshot'
        ? compatDialog('snapshot', t('snapshot.title'), [
          React.createElement('p', { key: 'hint', className: 'dsm-help' }, t('snapshot.hint')),
          snapshotContent ? React.cloneElement(snapshotContent, { key: 'body' }) : dialogFallback(),
        ])
        : null
      const liveDialog = compatDialogOpen === 'live'
        ? compatDialog('live', t('compat.live.title'), liveContent
          ? React.cloneElement(liveContent, { key: 'body' })
          : [dialogFallback()])
        : null

      return React.createElement('div', { className: 'dsm-section dsm-compat' },
        // 页头一行化（REDESIGN §3 + §6 特例 §9-1）：本页没有统计可内联，描述占统计的位置；
        // 四个诊断工具钮保持可见、quiet 弱化（§9-1：诊断工具页，使用者为维护者本人）。
        React.createElement(PageHead, {
          title: t('compat.title'),
          desc: t('compat.desc'),
          actions: [
            compatDialogButton('audit', t('compat.audit')),
            compatDialogButton('snapshot', t('snapshot.title')),
            compatDialogButton('live', t('compat.live.title')),
            React.createElement('button', {
              key: 'backups',
              type: 'button',
              className: 'dsm-btn dsm-btn-quiet',
              disabled: busy,
              // 份数直接写进按钮文字：它是"要不要清理"的决策依据，只藏在 tooltip 里等于没有
              // （触屏上没有 hover）。体积放不进按钮，留在 title 里补一份。
              title: backups && backups.total
                ? t('compat.backups.btnTitle', { count: backups.total, size: backupSizeText(backups.totalSize || 0) })
                : t('compat.backups.btnHint'),
              onClick: openBackupClean,
            }, backups && backups.total ? t('compat.backups.btnCount', { count: backups.total }) : t('compat.backups.btn')),
            // 侧栏入口的开关：放在诊断工具后面，它改的是本插件自己的入口，与上面三块"看数据"
            // 不是一类（用户 2026-10-18 要求摆在兼容页这一排）。
            React.createElement('button', {
              key: 'sidebar-entry',
              type: 'button',
              className: 'dsm-btn dsm-btn-quiet',
              disabled: sidebarEntry.busy === true,
              title: t(sidebarEntry.enabled === false ? 'compat.sidebar.showHint' : 'compat.sidebar.hideHint'),
              onClick: toggleSidebarEntry,
            }, t(sidebarEntry.enabled === false ? 'compat.sidebar.show' : 'compat.sidebar.hide')),
          ],
        }),
        body,
        backupModal,
        tokenModalEl,
        toolPresetModal,
        auditDialog,
        snapshotDialog,
        liveDialog)
    }
