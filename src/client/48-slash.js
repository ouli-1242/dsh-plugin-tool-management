    // ── 斜杠命令「工具」段（对话输入框里直接管六个域）────────────────────────────
    //
    // 要解决的问题：切个场景、临时停一个 MCP，都得离开当前对话去「设置 → 工具管理」。这一段把
    // 这些**可逆**动作搬进宿主的 `/` 菜单：打一个 `/` → 出现「工具」段 → 点一行原地进入该域
    // → 点一条直接启停，**菜单停在原地不关**，接着点下一条也行。
    //
    // 为什么走 `inputTriggers` 而不是更省事的 `commandUi`（官方弹窗壳，宿主 /model 用的那个）：
    // `commandUi` 注册的命令落在哪个段由宿主写死的 `SECTION_ROWS` 表决定，表里没有的一律排到
    // 「指令」段尾（dsh-client-ui-commands 的 sectionRows），插件**拿不到自己的段标题**。
    // 用户要的就是「工具」这个独立分区，所以只能走源这一层 —— 代价是弹窗壳、右下角 ✓ 与官方
    // 确认门都拿不到，状态呈现改由图标位（绿勾 / 空心框）+ 右侧灰字承担。
    //
    // 四条纪律：
    //   ① 读写一律复用面板那批 op，不新增后端通道 —— 面板能做的这里才看得到，两边不会各算一套
    //      状态（技能写完后服务端照旧走 notifyChatCatalog，官方技能目录随之重拉）。
    //   ② 只放**可逆**动作（进场景 / 启停）。增删改、导入导出、改配置仍只在面板里 —— `/` 菜单
    //      里没有确认门可用，把不可逆动作放进来就是拿用户的键盘赌他不多看一眼。
    //   ③ 宿主没有 `inputTriggers` 服务时**什么都不发生**：`ctx.inject` 是等依赖的，服务不出现
    //      回调就不跑（cordis 语义），不报错、不拖累设置页。
    //   ④ 点完不关菜单、也不在输入框留字：宿主的 `settle()` 对**非下钻**的选取一律先
    //      `reduce({type:'close'})`（input-trigger client.js），所以每次选取都交回 `{text:''}`
    //      把那串 token 抹掉，再在微任务里用官方口把菜单开回这一层 —— 连点多个开关是这个功能的
    //      主要用法。整段包在 try 里，任何一步取不到就退回"点完关菜单"，不能把功能本身带坏。
    var SLASH_SOURCE_NAME = 'tool-management'
    /** 快捷提示词那一段自己的源名（与「工具」段分开注册，才能排到官方「技能」段之后）。 */
    var QUICK_SOURCE_NAME = 'tool-quick-prompts'
    /** 「全局」保留场景的目录名 —— 与服务端 `src/memories/constants.ts` 的 `GLOBAL_SCENE` 同值。 */
    var GLOBAL_SCENE = 'global'
    /** 面包屑第一颗「工具」的出口值：半个 token，代表"回到域列表"（`header` 与 `onPick` 共用）。 */
    var SLASH_ROOT_CRUMB = '/tool-'
    /** 域清单读到的数据用多久（界面本身 5s 轮询，这里比它短一档，够一次连续输入）。 */
    var SLASH_CACHE_TTL_MS = 1500
    /**
     * 叶子行右侧那句备注截多长。宿主那一格自己会省略号（`itemDescription` 是 nowrap + ellipsis、
     * `flex:1`），但同一行还要放名字（≤40%）与灰色 alias（≤20%），留给它的大约四成 —— 先按这个
     * 宽度裁一刀，别让一行读起来像两段话。
     */
    var LEAF_NOTE_MAX = 40

    /** 图标位：启用态的绿色对勾。宿主按 `createElement(icon, {size})` 调用。 */
    function SlashOnIcon(props) {
      var s = props && props.size ? props.size : 14
      return React.createElement('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('path', { d: 'M3.2 8.4 6.3 11.5 12.8 4.6', stroke: '#57c27d', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }
    /** 图标位：停用态的空心框（与绿勾同尺寸，两行并排时不会跳）。 */
    function SlashOffIcon(props) {
      var s = props && props.size ? props.size : 14
      return React.createElement('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('rect', { x: 2.6, y: 2.6, width: 10.8, height: 10.8, rx: 3, stroke: '#6b6d75', strokeWidth: 1.6 }))
    }
    /**
     * 这一层的人话主语（0.21.2 隔离粒度）：`scope.mode` 由 `scope-get` 带回，
     * 读不到才退回面板那份（菜单这条路上面板可能根本没打开过）。
     */
    function slashLayerWord(t, scope) {
      var mode = (scope && scope.mode) || (scopeIsWorkspace() ? 'workspace' : 'session')
      if (mode === 'global') return t('scope.layer.global')
      return t(mode === 'workspace' ? 'scope.layer.workspace' : 'scope.layer.session')
    }
    /**
     * 全局层那份快照：`sessionId: ''` = **没有会话层**。
     *
     * 形状与 `scope-get` 在全局粒度下的回答逐字一致（`sessionId: ''` / `overrides: {}` /
     * `mode: 'global'`）—— 域表就是这么区分"写哪一层"的，所以这里不能自己另造一套。
     */
    function slashGlobalLayer() {
      return { sessionId: '', overrides: {}, effective: {}, scene: null, mode: 'global' }
    }
    /**
     * 这份菜单此刻该读写哪一层：`''` = 全局。
     *
     * 全局粒度（0.21.2+）下**没有会话层** —— 服务端 `scope-get` 对任何 sessionId 回的也是
     * 全局层。菜单必须照着这份回答走：继续拿真实 sessionId 去读，会把"保留着但早已不生效"
     * 的旧覆盖当成现状显示；去写则整条被服务端的全局闸拒掉（用户 2026-10-21 实测：点一下
     * 弹出「没有会话层可写」）。全局模式下"改这一条"本来就该改那份共用的设置。
     */
    function slashLayerIdOf(scope, sessionId) {
      return scope && scope.mode === 'global' ? '' : sessionId
    }
    /**
     * 六个域的读法与写法。
     *
     * `opts.quickPrompts` = 兼容页那颗「快捷提示词」开关：开着时快捷词并进「提示词」这一域
     * （用户 2026-10-01 裁定：这一域叫「提示词」，全局与快捷两类都在里面，各自一个分组标题）。
     *
     * `load` 回 `{items, summaryOf}`：items 是叶子行，summaryOf 由**当前显示的那批条目**算出摘要
     * （域行右侧那句话）。摘要不预先算成字符串，是因为乐观覆盖会改条目状态 —— 预先算好的那句
     * 会跟改完的列表自相矛盾（`0 启用 / 6 停用` 配上一排绿勾）。
     *
     * 每条 item 的 `run(next)` / `done(next)` 都**收目标状态为参数**：闭包里存着"读到的时候是什么
     * 状态"，连点两次就会把同一个值发两遍（第二次点了没反应）。
     *
     * 带 `single` 的那一条是**单选且没有"全关"这一态**（全局基线）：点亮它就把同组别的关掉，
     * 再点当前那条什么都不做。域级的 `exclusive` 留给"整域都是单选"的域（场景）—— 一个域里混
     * 两类时这类标记只能挂在条目上：挂在域上会把快捷词那颗开关一起管掉（关掉一条快捷词会被判成
     * "点的就是当前那条"，什么都不发生）。
     *
     * **这一域里没有"贴文字"那种行**：快捷提示词的正文是用户在输入框里自己取用的，走的是
     * `quickSource` 那一段；这一域的每一行只回答"它现在算不算生效"。
     *
     * 每条 item 的 `key` 是**域内唯一身份**，`id` 只是给人看的那一段（也是 `/` 菜单里的 alias）。
     * 两者必须分开：技能名在两个目录里可以完全一样，MCP 服务器可以在用户级和项目级各有一份 ——
     * 只按 id 找目标就会点到 A 却改了 B（表现就是"点了没反应"）。
     */
    function slashDomains(t, opts) {
      const quickOn = !opts || opts.quickPrompts !== false
      /**
       * 会话作用域（0.21.2）：`opts.scope = { sessionId, overrides, effective, scene }`，
       * 三样都来自 `scope-get`（`effective` = 服务端按四层算好、只留与全局不同的那些）。
       *
       * 有它时每一行都要做两件事：**打 `scoped`**（右侧那句「· 本会话」）与**改 `run`**
       * （写 `scope-set`）。两件事必须成对 —— 只打不改就是"显示本会话、改的却是全局"，
       * 那正是这一层要修的不一致。
       */
      const scope = (opts && opts.scope) || null
      const sessionId = scope && scope.sessionId ? String(scope.sessionId) : ''
      const inSession = sessionId !== ''
      // 隔离粒度（0.21.2）：这一层是「本会话」还是「本工作区」，跟着服务端带回的 mode 走。
      const layerWord = slashLayerWord(t, scope)
      /** 某一格在这一层的值：`{ on, scoped }`（`effective` 是服务端算好的四层并值）。 */
      function cell(domain, key, globalOn) {
        if (!inSession) return { on: globalOn === true, scoped: false }
        const map = scope.effective && scope.effective[domain]
        const over = map && typeof map[key] === 'boolean' ? map[key] : undefined
        return over === undefined ? { on: globalOn === true, scoped: false } : { on: over, scoped: true }
      }
      /** 会话层写一个布尔覆盖；全局层走原来的 op。 */
      function runFlag(domain, key, next, globalRun) {
        if (!inSession) return globalRun()
        return apiCall('scope-set', { sessionId: sessionId, domain: domain, key: key, value: next === true })
      }
      return [
        {
          key: 'scene', token: 'tool-scene', label: t('slash.domain.scene'), exclusive: true,
          load: async function () {
            const res = await apiCall('rules-list', {})
            if (!res || !res.ok) throw new Error(translateError(t, res))
            const active = res.activeScene || null
            // 两个保留场景都不列**这一域**：`_shared` 是公共基线（面板里恒为常开、不给开关），
            // `global` 是「全局」—— 它永远跟着生效，列出来就是一行永远点不动的"未启用"。
            // 注意别把这条判断复制到记忆域：全局不进场景区，但它的记忆照样要能启停。
            const scenes = (res.scenes || []).filter(function (s) { return s.shared !== true && s.global !== true })
            return {
              summaryOf: function (items) {
                const now = items.filter(function (x) { return x.on === true })[0]
                return now ? t('slash.sum.current', { name: now.id }) : t('slash.sum.count', { n: items.length })
              },
              items: scenes.map(function (s) {
                // 会话层（0.21.2）：**生效场景** = 服务端算好的（进入的 → 基线里那份 → 全局的）。
                // 所以没进入时绿勾落在正在生效的那个场景上（跟随全局 / 退出后的基线），
                // 不是一片空白 —— 一片空白会让人以为"本会话没有场景"。
                const entered = inSession && scope.overrides && typeof scope.overrides.scene === 'string'
                const effective = inSession && typeof scope.scene === 'string' ? scope.scene : active
                const isScoped = entered && scope.overrides.scene === s.name
                return {
                  id: s.name, key: s.name, label: s.name, on: s.name === effective, scoped: isScoped, note: s.description,
                  // 单选，但**关得掉**：再点当前这一项 = 退出场景（`scenes:[]` 是服务端明确支持的
                  // 写法，含义是"只注入全局与公共基线"），跟面板上那颗开关同一个出口。
                  // 运行时（档案里的 MCP / 技能 / 人设 / 工具表）由服务端在这一次调用里跟着切
                  // —— 见 `ops/scene-sync.ts` 的「两轴恒等」，这里**不需要**再补一枪 `scene-mode-set`。
                  // 会话层（0.21.2）：点亮的 = **进入**（场景层 + 需要的服务器 / 来源按租约临时运行）；
                  // 点灭的 = **退出模式**（回到会话创建时的样子）。都在服务端一条 `scope-set` 里。
                  run: function (next) {
                    if (inSession) {
                      return apiCall('scope-set', { sessionId: sessionId, domain: 'scene', value: next ? s.name : null })
                    }
                    return apiCall('rules-set-active', { scenes: next ? [s.name] : [] })
                  },
                  done: function (next) {
                    if (next) return t('slash.did.scene', { name: s.name })
                    // 全局粒度下这一下改的是全局那份场景，措辞不能再说「本会话回到创建时」
                    // —— 全局模式没有会话层可以回，那句话会读成一句假话。
                    return t(inSession ? 'slash.did.sceneOff' : 'slash.did.sceneOffGlobal', { name: s.name })
                  },
                }
              }),
            }
          },
        },
        {
          key: 'skill', token: 'tool-skill', label: t('slash.domain.skill'),
          load: async function (sessionId) {
            // 会话层（0.21.2）：项目技能根按本会话的 cwd 推导 —— 不带 sessionId 时是全部
            // 活动会话的并集，菜单里会列出别的项目目录里的技能。
            const res = await apiCall('skill-state', sessionId ? { sessionId: sessionId } : {})
            const data = (res && res.data) || {}
            const items = []
            for (const root of data.roots || []) {
              if (root.removed === true) continue
              const rootName = rootDisplayName(t, root)
              // `toggleable === false` 的目录里单条技能没有开关（面板同样不给），列出来就是死行。
              if (root.toggleable === false) continue
              // **目录本身**一行，开着的也列 —— 不然只关得开、关不掉，等于半个开关。
              // 它钉在本组最上面（`first`），读起来像"组标题带一颗开关"，与技能页卡片头那颗
              // 是同一个动作（`skill-source-enable` / `skill-source-disable`）。
              // 默认来源（dsh / hub / 官方内置）与项目作用域没有来源开关，按面板口径不给。
              // 0.21.2：这一格有会话版本了（`skillSources`）—— 会话层照常列；拨开时服务端
              // 会把来源在**全局**启用（来源关着时技能级开关会被 core 吞掉）。
              if (root.scope !== 'project' && root.defaultSource !== true) {
                const srcCell = cell('skillSources', String(root.key), typeof root.globalOn === 'boolean' ? root.globalOn : root.enabled !== false)
                items.push({
                  id: rootName, key: '@' + root.key, label: rootName + ' · ' + t('slash.skill.sourceRow'),
                  on: srcCell.on, scoped: srcCell.scoped, group: rootName, first: true,
                  run: function (next) {
                    if (inSession) {
                      return apiCall('scope-set', { sessionId: sessionId, domain: 'skillSources', key: String(root.key), value: next })
                    }
                    return apiCall('scope-intent-set', { domain: 'skillSources', keys: [String(root.key)], value: next ? 'on' : 'off' })
                  },
                  done: function (next) { return t(next ? 'slash.did.sourceOn' : 'slash.did.sourceOff', { name: rootName }) },
                })
              }
              // 目录停用时**照样把里面的技能读进来**，只是由覆盖表那一层先不显示（`effective`）：
              // 这样"重新启用"当场就能把原本生效的那几条摆回来，不用等下一次真读。状态按"假设来源
              // 开着"算 —— 服务端的 `managerEnabled = 可写 && 来源启用 && 单条没被关掉`，来源关着时
              // 它恒为 false，而单条自己的意图在 `managerOverride` 里，把来源那一项补成 true 就是
              // 启用之后会读到的值。
              // 全局口径读意图（租约期间来源状态是开着的，但别的对话看不到它下面的技能）。
              const sourceOff = (typeof root.globalOn === 'boolean' ? root.globalOn : root.enabled !== false) === false
              // 全局停用的来源照样把技能列出来（0.21.2，修「技能缺少未开启的目录」）：上面
              // 有来源那一行，拨开它（会话层把来源当作租约运行）这些技能立刻能用；
              // 状态按"假设来源开着"算 —— 与服务端 `managerEnabled` 的推导一致。
              for (const skill of root.skills || []) {
                // 被同名遮蔽的那条按了也没效果（面板不给开关，给的是「启用这个」——那是切首选，
                // 不在"可逆启停"这一类里，所以 `/` 菜单不列）。
                if (skill.shadowedBy) continue
                const view = sourceOff ? Object.assign({}, skill, { managerEnabled: true }) : skill
                // 会话层（0.21.2）：覆盖键 = `<root>/<声明名>`，与面板、注入段、模型工具同一份键。
                // 目录名与声明名不同时不能用目录名，否则写进去的覆盖永远读不到。
                const canonical = skill.declaredName || skill.name
                // 兜底读**全局意图**（`globalOn`），不是运行态：别的对话开着的技能是租约，运行态
                // 此刻为 true，但本层没覆盖时它应当显示"全局关着"（与面板同一个 skillGlobalOn）。
                const sc = cell('skills', root.key + '/' + canonical, skillGlobalOn(view))
                items.push({
                  // `key` 带来源，`id` 不带：同名技能在两个目录里各有一行时，`id` 一样而 `key` 不一样
                  // —— 只按 id 找目标会改到另一条（点了没反应就是这个）。alias 那行灰字仍显示短名。
                  id: skill.name, key: root.key + '/' + skill.name,
                  label: skill.declaredName || skill.name, on: sc.on, scoped: sc.scoped, note: skill.description,
                  // 分组标题 = 来源目录（技能页那套显示名）。技能动辄几十条又分属多个目录，
                  // 不分组就是一片平铺，找不到自己要改的那一条。
                  group: rootName,
                  run: function (next) {
                    return runFlag('skills', root.key + '/' + canonical, next, function () {
                      return apiCall(next ? 'skill-enable' : 'skill-disable', { root: root.key, name: skill.name })
                    })
                  },
                  done: function (next) { return t(next ? 'slash.did.on' : 'slash.did.off', { name: skill.name }) },
                })
              }
            }
            // 域行那句「N 启用 / M 停用」只数技能，不数目录行 —— 混进去的话数字里会多出几条
            // 根本不是技能的东西，而这句话是拿来核对"我这批技能现在什么状况"的。
            const skillSummary = slashOnOffSummary(t)
            return {
              summaryOf: function (shown) {
                return skillSummary(shown.filter(function (x) { return x.first !== true }))
              },
              items: items,
            }
          },
        },
        {
          key: 'mcp', token: 'tool-mcp', label: t('slash.domain.mcp'),
          load: async function () {
            const res = await apiCall('mcpm-list', {})
            if (!res || !res.ok) throw new Error(translateError(t, res))
            const items = (res.rows || []).map(function (row) {
              // 会话层（0.21.2，决策 9）：覆盖键是**服务器名**（与停用表、工具全名同一套），
              // 不是 `level:id` —— 会话层只回答"本会话看不看得到这台"，与它在哪一层配的无关。
              // 全局口径读**意图**（`mcpm-list` 的 `globalOn`，0.21.2）：租约期间运行态是开着的，
              // 读 `disabled` 会把"只为几个对话临时跑着"显示成全局开着。
              const mc = cell('mcp', String(row.serverName || row.id), typeof row.globalOn === 'boolean' ? row.globalOn : row.disabled !== true)
              return {
                // 同一台服务器可以在用户级与项目级各有一份（同名同 id），所以 key 带 level。
                id: row.id, key: row.level + ':' + row.id, label: row.serverName || row.id, on: mc.on, scoped: mc.scoped, note: row.notes,
                run: function (next) {
                  // 会话层（0.21.2）：开启一台全局关着的服务器会成为**本会话的租约**
                  //（连接跑起来，别的对话看不到）。没有会话 id 时退回全局意图。
                  return runFlag('mcp', String(row.serverName || row.id), next, function () {
                    return apiCall('scope-intent-set', { domain: 'mcp', keys: [String(row.serverName || row.id)], value: next ? 'on' : 'off' })
                  })
                },
                done: function (next) { return t(next ? 'slash.did.on' : 'slash.did.off', { name: row.serverName || row.id }) },
              }
            })
            return { summaryOf: slashOnOffSummary(t), items: items }
          },
        },
        {
          key: 'agent', token: 'tool-agent', label: t('slash.domain.agent'),
          load: async function () {
            const res = await apiCall('subagent-list', {})
            if (!res || !res.ok) throw new Error(translateError(t, res))
            const items = (res.subagents || []).map(function (p) {
              // 会话层（0.21.2）：覆盖键 = 人设名。
              const ac = cell('subagents', String(p.name), p.enabled !== false)
              return {
                id: p.name, key: p.name, label: p.name, on: ac.on, scoped: ac.scoped, note: p.description,
                run: function (next) {
                  return runFlag('subagents', String(p.name), next, function () {
                    return apiCall('subagent-toggle', { name: p.name, enabled: next })
                  })
                },
                done: function (next) { return t(next ? 'slash.did.on' : 'slash.did.off', { name: p.name }) },
              }
            })
            return { summaryOf: slashOnOffSummary(t), items: items }
          },
        },
        {
          key: 'preset', token: 'tool-preset', label: t('slash.domain.preset'),
          load: async function (sessionId) {
            // 会话层（0.21.2）：菜单停在某个对话里时，这一域要回答**本会话**注入的是哪一份，
            // 写也只写本会话（`scope-prompt-set`）—— 直接 `agentsmd-apply` 改的是全局
            // AGENTS.md，而当前会话冻结在自己的基线里，注入一个字都不会变（用户 2026-10-21 实测）。
            const inSession = typeof sessionId === 'string' && sessionId !== ''
            const res = await apiCall('agentsmd-list', inSession ? { sessionId: sessionId } : {})
            if (!res || !res.ok) throw new Error(translateError(t, res))
            // 本会话手写了正文时，没有任何一行预设算「生效中」（与提示词页同一判据）。
            const promptOver = inSession && scope && scope.overrides && scope.overrides.prompt && typeof scope.overrides.prompt === 'object'
              ? scope.overrides.prompt
              : null
            const sessionCustomBody = !!(promptOver && typeof promptOver.content === 'string' && promptOver.content !== '')
            const sessionPresetId = promptOver && typeof promptOver.presetId === 'string' ? promptOver.presetId : ''
            const items = (res.presets || []).map(function (p) {
              // 会话层看**真正注入的那一份**（服务端按正文比对，`sessionActive`）；全局层维持
              // 「当前基线」口径。两者都不能拿 `p.active` 充数：那是全局 AGENTS.md 的答案。
              const on = inSession ? (!sessionCustomBody && p.sessionActive === true) : p.active === true
              return {
                id: p.id, key: p.id, label: p.id, on, note: p.description,
                // 「· 本会话」只标**本会话单独应用**的那一份；沿用的全局 / 场景 / 快照不标。
                scoped: inSession && !sessionCustomBody && sessionPresetId === p.id,
                // 应用基线改的是**整轮环境**（全局 AGENTS.md）。它可逆（再应用原来那套就切回去），
                // 所以按②的口径可以进 `/`；但这里没有官方确认门可用，于是把"当前是哪套"写进域行
                // 摘要 —— 点之前屏幕上至少说清了要换掉什么。
                // 点"当前这套"不做任何事（`single`）：基线没有"全部不应用"这一态，
                // 把勾去掉等于让全局 AGENTS.md 凭空消失，那不是这里的语义。
                single: true,
                run: function () {
                  if (!inSession) return apiCall('agentsmd-apply', { id: p.id })
                  return apiCall('scope-prompt-set', { sessionId: sessionId, action: 'apply', presetId: p.id })
                },
                done: function () {
                  return inSession
                    ? t('scope.prompt.appliedToSession', { id: p.id, layer: layerWord })
                    : t('slash.did.preset', { name: p.id })
                },
              }
            })
            const quicks = await slashQuickRows(t, quickOn, sessionId)
            // 两类都在时才给全局那一组出行标题：只剩一类时，「全局提示词」这条小标题与面包屑上
            // 的域名说的是同一件事，等于把同一句话写两遍。
            if (quicks.length) for (const it of items) it.group = t('prompts.group.global')
            return {
              summaryOf: function (shown) {
                const globals = shown.filter(function (x) { return x.single === true })
                const now = globals.filter(function (x) { return x.on === true })[0]
                const quicks = shown.filter(function (x) { return x.single !== true })
                // 基线那句只数全局那一类：快捷词不是"当前生效的基线"，把它算进来这句就成谎了。
                const base = now ? t('slash.sum.current', { name: now.id }) : ''
                if (!quicks.length) return base
                // 快捷那一类给个数而不是"当前是哪条"：它们是多对开关，说得出"开着几条"就够了。
                const on = quicks.filter(function (x) { return x.on === true }).length
                const tail = t('slash.sum.quick', { on: on, total: quicks.length })
                return base ? base + ' · ' + tail : tail
              },
              items: items.concat(quicks),
            }
          },
        },
        {
          key: 'memory', token: 'tool-memory', label: t('slash.domain.memory'),
          load: async function (sessionId) {
            // 会话层（0.21.2）：带 sessionId 时 `activeScene` 是本会话生效的场景（钉住的 /
            // 跟随全局），默认列出的记忆才与这个对话实际注入的一致。
            const res = await apiCall('rules-list', sessionId ? { sessionId: sessionId } : {})
            if (!res || !res.ok) throw new Error(translateError(t, res))
            const active = res.activeScene || ''
            // 场景显示名（`global` → 「全局」）：分组标题用它，别让用户在 `/` 菜单里看到磁盘名。
            const labels = {}
            for (const s of res.scenes || []) if (s && s.name) labels[s.name] = s.label || s.name
            const toRow = function (r) {
              // 记忆的场景 = group 的第一段（与服务端 `sceneOf` 同一口径，见 memories/projection.ts）。
              const scene = String(r.group || '').split('/')[0]
              // 会话层（0.21.2）：覆盖键 = 记忆 id（`<场景>/<名>`）。
              const mc = cell('memory', String(r.id), r.enabled !== false)
              return {
                id: r.id, key: r.id, label: r.name, on: mc.on, scoped: mc.scoped, note: r.description,
                scene: scene,
                // 打了字会跨场景搜，那时按场景分组才看得清是哪里的记忆。
                group: labels[scene] || scene || t('slash.group.noScene'),
                run: function (next) {
                  return runFlag('memory', String(r.id), next, function () {
                    return apiCall('rules-toggle', { id: r.id, enabled: next })
                  })
                },
                done: function (next) { return t(next ? 'slash.did.on' : 'slash.did.off', { name: r.name }) },
              }
            }
            const all = (res.rules || []).filter(function (r) { return r.shadowed !== true }).map(toRow)
            // 「全局」这一组排最前面（用户 2026-09-30 裁定）：它恒常注入，是这一域里最常要动的那组，
            // 不该沉在当前场景后面。sort 是稳定的，组内顺序不动。
            const globalFirst = function (list) {
              return list.slice().sort(function (a, b) {
                return (a.scene === GLOBAL_SCENE ? 0 : 1) - (b.scene === GLOBAL_SCENE ? 0 : 1)
              })
            }
            // 默认列**当前场景 + 「全局」**：记忆动辄上百条，全列进来等于把记忆页搬进 `/` 菜单，
            // 而这里要改的几乎总是正在用的那个场景；全局那份虽然不是"当前场景的"，却对任何对话
            // 都成立、恒常在上下文里，用户想停掉的往往正是它。（场景域不列 global 是另一回事：
            // 它没有开关可给；这里的判断对象是记忆条目，不是场景。）打了字才跨场景搜。
            const shown = active ? all.filter(function (r) { return r.scene === active || r.scene === GLOBAL_SCENE }) : all
            return {
              summaryOf: function (items) {
                return active
                  ? t('slash.sum.sceneGlobal', { scene: labels[active] || active, n: items.length })
                  : t('slash.sum.count', { n: all.length })
              },
              items: globalFirst(shown),
              searchPool: active ? globalFirst(all) : null,
            }
          },
        },
      ]
    }

    /** 进入场景时被引擎跳过的档案键（服务端 `rules-set-active` 把 `scene-mode-set` 的 stale 并进来）。 */
    function slashModeStaleWarn(t, res) {
      const stale = res && res.modeStale
      return Array.isArray(stale) && stale.length ? t('memory.archive.stale', { items: stale.join('、') }) : ''
    }

    /**
     * 「提示词」域里快捷那一组（每一行 = 面板上那颗药丸开关，同一个动作、同一份状态）。
     *
     * 读失败或开关关着一律回空数组，**不抛**：这一域的主体是全局基线，不能因为快捷那一组读不到
     * 就把整域打成"读不到"（那连切基线都做不了了）。
     *
     * 这里列**全部**快捷词，包括已经关着的那些 —— 与贴文字那一段（`quickSource`）正好相反：
     * 那一段按 `enabled` 筛过，关掉的不再出现；如果这一域也只列开着的，关掉一条之后两个入口就
     * 都没有它了，只能回设置页去开。域是"管"的那一层，管的东西不能因为被管起来就消失。
     */
    async function slashQuickRows(t, quickOn, sessionId) {
      if (quickOn === false) return []
      let res
      // 会话层（0.21.2）：带上当前会话，服务端按本会话的覆盖算 `enabled`。
      const args = typeof sessionId === 'string' && sessionId ? { sessionId } : {}
      try { res = await apiCall('quickprompt-list', args) } catch (e) { return [] }
      if (!res || res.ok !== true) return []
      // 有会话 id 时**这一行显示的就是本会话的生效值**（上面 `enabled` 已被服务端按覆盖算过）。
      // 于是点击也必须写会话层 —— 否则「显示本会话、改的却是全局」，那正是这次要修的不一致。
      // 会话写入只走 `scope-set`（`quickprompt-toggle` 只改全局 meta.json，与 `rules-toggle`
      // 同一条纪律：带 sessionId 的全局 op 一律不当会话写入使）。
      const scoped = typeof sessionId === 'string' && sessionId !== ''
      return (res.prompts || []).map(function (p) {
        return {
          // `key` 带前缀：全局预设与快捷词各存一份目录，同名完全可能（`id` 那一格仍然显示短名）。
          id: p.id, key: 'q:' + p.id, label: p.id, note: p.description,
          on: p.enabled !== false,
          // 服务端在带 sessionId 时会额外回 `overridden`：这条被本会话覆盖了（行尾加「· 本会话」）。
          scoped: p.overridden === true,
          group: t('prompts.group.quick'),
          // 含义是"这条还出现在不在 `/` 的贴文字段里"。正文与备注一个字不动。
          run: function (next) {
            // 会话 id 在 → **永远写会话层**，与这条有没有现成覆盖无关。按 `p.overridden`
            // 分派会让"本会话还没有覆盖"的那一次点选写进全局 meta.json —— 用户以为只改了
            // 这个对话，实际上所有对话的 `/` 菜单都跟着变了（2026-10-19 实测）。
            if (!scoped) return apiCall('quickprompt-toggle', { id: p.id, enabled: next })
            return apiCall('scope-set', { sessionId: sessionId, domain: 'quickPrompts', key: p.id, value: next })
          },
          done: function (next) { return t(next ? 'slash.did.quickOn' : 'slash.did.quickOff', { name: p.id }) },
        }
      })
    }

    /** 「N 启用 / M 停用」那句摘要（技能 / MCP / 子智能体三个域共用）。 */
    function slashOnOffSummary(t) {
      return function (items) {
        let on = 0
        for (const item of items) if (item.on === true) on += 1
        return t('slash.sum.onoff', { on: on, off: items.length - on })
      }
    }

    /** 条目的身份：`key`（域内唯一）优先，没给就退回 `id`。覆盖表与点选定位都按它走。 */
    function slashItemKey(item) {
      return item.key === undefined ? String(item.id) : String(item.key)
    }

    /**
     * 一次输入期间的读缓存 + 乐观覆盖，按域放在一起。
     *
     * 为什么要覆盖表：点完一条要**立刻**看到勾翻过来，而写请求是异步的、宿主快照也要下一次
     * 候选轮询才重读。覆盖只在"这个域重新真读过一次"时清掉（读回来的是权威状态，继续压着它
     * 就会把面板那边的改动盖住），写失败也立刻撤回。
     */
    function slashState(onFresh, stampOf) {
      const entries = new Map()
      const overrides = new Map()
      /**
       * 当前层快照的代号。每次 `scope-get` 回来发现内容变了就 +1：
       *   · 读到的清单是按**开始那一刻**的层烘出来的（每条 `on` 都来自 `effective`），
       *     晚于层更新落地的读不许清乐观勾（0.21.2 复核三：进场景后勾要等重开菜单）；
       *   · `dirty` = 写过之后还没有一次 `scope-get` 回来 —— 这一窗里读到的层一定是旧的。
       * 取不到时退回 0：只影响"这一拍算不算权威"，不会把功能带坏。
       */
      const stampNow = function () {
        try { return stampOf() } catch (e) { return { rev: 0, dirty: false } }
      }
      const overrideKey = function (domainKey, itemKey) { return domainKey + '/' + itemKey }
      const clearOverrides = function (domainKey) {
        const prefix = domainKey + '/'
        for (const key of Array.from(overrides.keys())) if (key.indexOf(prefix) === 0) overrides.delete(key)
      }
      /**
       * 缓存键 = 域名 + 会话 id（0.21.2）。
       *
       * **会话 id 必须进键**：域表是带 scope 造出来的，每一条的 `run` 都闭包住了"写哪个会话"
       * 与那一层的 `scoped` 标记。只按域名缓存时，A 对话读来的那批行会被 B 对话在 1.5 秒内
       * 直接复用 —— 屏幕上显示的是 A 的勾，点下去写的是 A 的覆盖。它不报错，只在两个对话
       * 交替打开菜单时出现。
       *
       * `sessionId` 同时透给 `domain.load`：「提示词」域的全局预设组（`agentsmd-list` 的
       * `sessionActive`）与快捷词组（`quickprompt-list` 的会话投影）都按它取数。
       */
      const cacheKeyOf = function (domain, sessionId) { return domain.key + "\u0000" + String(sessionId || "") }
      /**
       * 每个域的"第几次改动"计数 + "还没落地的写"条子（0.21.2）。
       *
       * 为什么两个都要：改成"先交旧值、后台重读"之后，一次读可能**在用户点下开关之前**就发出了，
       * 它回来的是改动前那份 —— 直接压住缓存并清掉乐观覆盖，勾就会当着用户的面翻过去又弹回来
       * （用户实测「点击后会先勾选，然后消失，然后再勾选」）。
       *   · `writes`：点下去（`mark`）与写落地（`settle`）各 +1 —— 比它更早发出的读一律算"过期数据"；
       *   · `pending`：点下去 +1、落地 / 失败 -1 —— 只要还有写在飞，任何读回来的都不许清乐观状态。
       */
      const writes = new Map()
      const pending = new Map()
      const bumpWrite = function (domainKey) { writes.set(domainKey, (writes.get(domainKey) || 0) + 1) }
      const beginWrite = function (domainKey) {
        bumpWrite(domainKey)
        pending.set(domainKey, (pending.get(domainKey) || 0) + 1)
      }
      const endWrite = function (domainKey) { pending.set(domainKey, Math.max(0, (pending.get(domainKey) || 0) - 1)) }
      /** 一次真读：in-flight 记在缓存里，**旧值原样留着**给"先交旧的"那条路用。 */
      const startRead = function (domain, sessionId, key) {
        const stale = entries.get(key)
        const hasStale = stale !== undefined && stale.value !== undefined
        const seq = writes.get(domain.key) || 0
        // 这次读用的是哪一份层快照：清单里的 `on` 在 `domain.load` 那一刻就烘进去了。
        const stamp = stampNow()
        const promise = Promise.resolve().then(function () { return domain.load(sessionId) }).then(function (value) {
          // 只有"点下去之后没有再过改动、且此刻没有在飞的写"时，这份数据才算权威 ——
          // 那时才允许收掉乐观覆盖并把缓存标新鲜。否则留着旧值但标过期，下一读再对齐。
          // 层快照换过内容 / 写过还没重新读到层：这份清单按旧层算的勾，同样不算权威。
          const current = stampNow()
          const authoritative = current.rev === stamp.rev && current.dirty !== true &&
            (writes.get(domain.key) || 0) === seq && (pending.get(domain.key) || 0) === 0
          if (authoritative) clearOverrides(domain.key)
          entries.set(key, { at: authoritative ? Date.now() : 0, value: value })
          // 后台读回来的正是"刚才那一屏缺的那一拍"：菜单还开着就让它重取一次候选。
          try { if (onFresh) onFresh(sessionId) } catch (e) { /* 刷不动只是晚一拍 */ }
          return value
        }, function (error) {
          // 读失败：**有旧值就退回继续供旧值**（一次读盘失败不该把菜单打成空屏），
          // 没有旧值才删掉条目，让下一次点重新走冷读。回旧值时**只回 at/value** ——
          // 把这次失败的 promise 留在条目上，下一次读会永远拿到同一个已拒绝的 Promise。
          if (hasStale) entries.set(key, { at: stale.at, value: stale.value })
          else entries.delete(key)
          throw error
        })
        entries.set(key, { at: hasStale ? stale.at : 0, value: hasStale ? stale.value : undefined, promise: promise })
        return promise
      }
      /**
       * 读一个域的清单。**恒回 Promise**（哪怕命中的是缓存）—— 点选那条路上调用方直接
       * `.then(...)`，交一个普通对象就是 `onPick` 同步抛异常，而宿主的 `settle()` 不包 try：
       * 整次点击什么都没发生（菜单开着、点了没反应，也不报错）。
       */
      const read = function (domain, sessionId) {
        const key = cacheKeyOf(domain, sessionId)
        const hit = entries.get(key)
        if (hit !== undefined && hit.value !== undefined) {
          // 后台重读在飞时也**先交旧值**（0.21.2）：进入场景后 `prefetchAfterScene` 会并行
          // 预读六域，用户若这期间点进某一域，等那份冷读就等于又卡回「切过去没有立即响应」。
          // 旧值先画，读回来由 `onFresh` 让宿主重取候选，那一屏自己会跟上。
          if (hit.promise !== undefined) return Promise.resolve(hit.value)
          if (Date.now() - hit.at < SLASH_CACHE_TTL_MS) return Promise.resolve(hit.value)
          // 过期但手里有旧值：**立刻把旧值交出去**，同时后台重读。
          // 这一条才是"卡顿"的正解：`skill-state` 冷启实测 3.4s，同步等它等于菜单停在上一屏、
          // 用户那几下键像被吃掉；先给旧的（行与勾都在），新数据落地后再让宿主重取一次。
          startRead(domain, sessionId, key).catch(function () { /* 已退回旧值，不再抛给调用方 */ })
          return Promise.resolve(hit.value)
        }
        if (hit !== undefined && hit.promise !== undefined) return hit.promise
        return startRead(domain, sessionId, key)
      }
      /** 把某一条缓存标成"过期但留着"（旧值照旧先交出去，重读在后台）。 */
      const expireKey = function (key) {
        const hit = entries.get(key)
        if (hit === undefined || hit.promise !== undefined || hit.value === undefined) return
        entries.set(key, { at: 0, value: hit.value })
      }
      /**
       * 层快照换了内容：每一域清单里的勾都是按旧层算的，全部标过期。
       * 旧值仍先交出去（菜单不当场空屏），下一读按新层重算；还在飞的那条由 `startRead`
       * 的代号判据自己拒绝落成"新鲜"。
       */
      const expireAll = function () {
        for (const key of Array.from(entries.keys())) expireKey(key)
      }
      /**
       * 写落地：撤掉条子、让**被改的那一域**过期重读。
       * 从前这里清的是整张表，下一次候选就得把六个域全部冷读一遍（点一下卡一下）。
       */
      const settle = function (domain, sessionId) {
        endWrite(domain.key)
        bumpWrite(domain.key)
        expireKey(cacheKeyOf(domain, sessionId))
        // 进 / 出场景会同时改好几个域的运行态 —— 场景一开，MCP / 技能 / 人设那几批列表 op 回的
        // 都是旧状态，不能只作废场景自己（其余写只动自己那一域）。
        if (domain.key === 'scene') {
          for (const key of Array.from(entries.keys())) {
            bumpWrite(key.split("\u0000")[0])
            expireKey(key)
          }
        }
      }
      /** 写被拒（锁定 / 失败）：只撤条子，缓存里那份仍然作数。 */
      const abort = function (domain) { endWrite(domain.key) }
      /**
       * 进入某个域那一刻的开关快照（0.21.2，用户裁定）：列表顺序**只在重新进入这一域时重排**。
       * 点一条之后勾翻过来就把那一条顶到前面，等于逼用户重新找那一行，还容易顺手点错下一条。
       */
      const orderSnap = new Map()
      const orderOf = function (domain, sessionId, items) {
        const key = cacheKeyOf(domain, sessionId)
        let snap = orderSnap.get(key)
        if (snap === undefined) {
          snap = new Map()
          for (const item of items) snap.set(slashItemKey(item), item.on === true)
          orderSnap.set(key, snap)
        }
        return snap
      }
      /** 换了一层（回到域列表 / 进了另一个域）就作废快照：下一次渲染按此刻的真值重排。 */
      const forgetOrder = function () { orderSnap.clear() }
      /**
       * 把覆盖表叠到读回来的条目上（返回新数组，不改缓存里那份）。
       *
       * 顺带按**叠完之后**的状态收掉整组：技能目录被（真读或乐观）判成停用时，它里面的技能行不再
       * 出现。服务端在这种组合下根本不让单条生效，留着那几行就是"看得见、点了没反应"；而"目录关了
       * 勾还在"这种半截状态，用户读到的意思是"里面还有技能"，跟面板与下一次真读都对不上。
       */
      const effective = function (domain, items) {
        const mapped = items.map(function (item) {
          const o = overrides.get(overrideKey(domain.key, slashItemKey(item)))
          return o === undefined ? item : Object.assign({}, item, { on: o })
        })
        // 会话作用域（0.21.2）：`scoped` 由**域自己**在 load 里打（只有那六个域知道自己的覆盖键），
        // 这里只负责把乐观覆盖叠加后的 `on` 带过去 —— 两者是不同的东西：`scoped` 是"这一格与
        // 全局不一样"，`on` 是"这一格现在开着没有"。
        const offGroup = {}
        for (const item of mapped) if (item.first === true && item.on !== true) offGroup[item.group] = true
        if (!Object.keys(offGroup).length) return mapped
        return mapped.filter(function (item) { return item.first === true || !offGroup[item.group] })
      }
      /**
       * 记一次"用户已经把它改成 next"。
       *
       * 单选的那一类（场景域的整域 `exclusive`；提示词域里全局那一组的每条 `single`）改一个就是
       * 把别的关掉，只记一条会让屏幕上同时出现两个绿勾，直到下一次真读才自己对齐 —— 那正是
       * "界面在骗人"的那几百毫秒。
       *
       * **只压同组**：提示词这一域里全局基线是单选、快捷词是多对开关，两类共处一域。不按分组收
       * 的话，点亮一条快捷词会把当前生效的那份基线的勾一起抹掉（覆盖表说的是假话，而下一次真读
       * 又把它翻回来 —— 表现就是勾自己跳了一下）。
       */
      const mark = function (domain, items, item, next) {
        // 点下去的那一刻就记一条"未落地的写"：在那之前 / 之间发出的读都不算权威，
        // 不许清掉乐观状态（否则勾翻过去又弹回来）。
        beginWrite(domain.key)
        const touched = [overrideKey(domain.key, slashItemKey(item))]
        overrides.set(touched[0], next)
        if ((domain.exclusive === true || item.single === true) && next === true) {
          for (const other of items) {
            if (slashItemKey(other) === slashItemKey(item) || other.on !== true) continue
            if ((other.group || '') !== (item.group || '')) continue
            const otherKey = overrideKey(domain.key, slashItemKey(other))
            overrides.set(otherKey, false)
            touched.push(otherKey)
          }
        }
        return touched
      }
      /** 只读缓存，绝不触发读：域行要当场决定那句摘要怎么写，不能等一次盘。 */
      const peek = function (domain, sessionId) {
        const hit = entries.get(cacheKeyOf(domain, sessionId))
        return hit !== undefined && hit.value !== undefined ? hit.value : undefined
      }
      const unmark = function (keys) { for (const key of keys) overrides.delete(key) }
      return { read: read, peek: peek, effective: effective, mark: mark, unmark: unmark, settle: settle, abort: abort, orderOf: orderOf, forgetOrder: forgetOrder, expireAll: expireAll }
    }

    /** 名字 / 标题的小写包含匹配（宿主不对 source 的结果二次排序，官方技能源也是自己排的）。 */
    function slashMatch(needle, item) {
      if (!needle) return true
      const q = needle.toLowerCase()
      return String(item.id).toLowerCase().indexOf(q) >= 0 || String(item.label).toLowerCase().indexOf(q) >= 0
    }

    /**
     * 把「工具」段与「快捷提示词」挂进宿主的 `/` 菜单。
     *
     * @param ctx      客户端根上下文（apply 的那个）
     * @param t        取词函数（每次候选都重新取，所以宿主换语言后下一次打开菜单就是新词）
     * @param settings 兼容页那两颗开关 `{ tools, quickPrompts }`，缺字段一律按开处理。
     *                 两段**各挂各的**：「工具」里那个「提示词」域管两类提示词的启停，
     *                 「快捷提示词」那一段管把正文贴进输入框 —— 两颗开关互不代替，关掉前者不会
     *                 顺带把快捷词收走，反之也一样。
     *                 两颗都关掉时**什么都不做**（不注册源，`/` 菜单回到出厂样子），而不是注册一个
     *                 空段 —— 空段会让人以为开关没生效。
     */
    function mountSlashCommands(ctx, t, settings) {
      const cfg = settings || {}
      // 挂载实况按段记：关着的那一段不该在 10s 后被报成"宿主没有这个服务"（那是另一回事），
      // 也不该一直停在"还没挂上" —— 它就是被关着的，照实说。
      const wanted = []
      if (cfg.tools !== false) wanted.push('tools')
      else setSlashMount('disabled', 'tools')
      if (cfg.quickPrompts !== false) wanted.push('quickPrompts')
      else setSlashMount('disabled', 'quickPrompts')
      if (!wanted.length) return
      // 「宿主压根没有这个服务」与「还没就绪」得区分开：`ctx.inject` 是等依赖的，服务不出现时
      // 回调**永远不跑**、也不报错 —— 于是兼容页那两枚标签会一直停在 pending，用户只能猜。
      // 10s 后还 pending 的段照实说"这台宿主没有 inputTriggers"（真缺服务时这是最终事实；
      // 万一它只是慢，源随后照样会挂上，状态会被 registered 覆盖）。
      try {
        setTimeout(function () {
          for (const key of wanted) if (slashMountStateOf(key) === 'pending') setSlashMount('missing', key)
        }, 10000)
      } catch (e) { /* 报不了状态不影响功能本身 */ }
      ctx.inject(['inputTriggers'], function (scope) {
        const triggers = scope.get('inputTriggers')
        // 层快照的代号（`slashScopeCache.rev` / `.dirty`）交给缓存判"这一拍读回来的算不算权威"；
        // 声明在后，但取值发生在一次读**完成**时，那时缓存早已建好。
        const state = slashState(function (sessionId) { refreshMenuFor(sessionId) }, function () {
          return { rev: slashScopeCache.rev, dirty: slashScopeCache.dirty === true }
        })
        const sectionTitle = function () { return t('slash.section.tools') }
        // 每次候选都现取一份域表（域名跟着宿主语言走），但「快捷提示词要不要并进提示词域」这个
        // 决定来自启动时读到的那颗开关 —— 三处调用点（候选 / 面包屑 / 点选）必须用同一个判断，
        // 否则面包屑会指到一个候选里根本不存在的域。
        const domainOpts = { quickPrompts: cfg.quickPrompts !== false }
        /**
         * 会话作用域（0.21.2）：每一行的三态与写入层都跟着**当前会话**走。
         *
         * 覆盖数据从 `scope-get` 取（与面板同一个 op），并缓存 5 秒 —— 菜单每敲一个键都会
         * 重新算候选，每次一个 HTTP 请求会把输入拖慢。缓存按 sessionId 分桶：同一份菜单在
         * 两个对话里看到的勾可以不同，共用一个槽就是串内容。
         */
        const slashScopeCache = {
          at: 0, sessionId: null, overrides: null, effective: null, scene: null, mode: null, promise: null,
          // 层内容代号：每换一份内容 +1，域缓存据此判断"清单里的勾是不是按当前层算的"（0.21.2 复核三）。
          rev: 0,
          // 写过之后还没有一次 `scope-get` 回来：这一窗里的域清单一定按旧层算。
          dirty: false,
          // 每发一次 `scope-get` +1：写后作废在飞的那条，晚回来的旧层不许盖掉新的一份。
          fetchSeq: 0,
          // 上一次落地那份层的内容指纹（与 `rev` 配套，仅用于判断"有没有变"）。
          stamp: '',
        }
        /** 菜单当前停在哪一层（会话 + 域 token）；换了层就重排叶子行的顺序。 */
        let slashEpisode = ''
        /** 缓存里此刻那一层的快照（`overrides === null` = 还没有一份能用的）。 */
        function scopeSnapshotOf(key) {
          // 全局粒度：桶仍按请求的会话 id 记，但**交出去的层是全局** —— 域表据此造全局那份，
          // 每一条的 `run` 落到全局 op，行上也不会再标「· 本会话」。
          if (slashScopeCache.mode === 'global') return slashGlobalLayer()
          return {
            sessionId: key,
            overrides: slashScopeCache.overrides || {},
            effective: slashScopeCache.effective || {},
            scene: typeof slashScopeCache.scene === 'string' ? slashScopeCache.scene : null,
            mode: slashScopeCache.mode,
          }
        }
        /** 一份层快照的内容指纹：只有它变了，域缓存里烘进去的勾才算过时（见 `rev`）。 */
        function layerStampOf(mode, scene, overrides, effective) {
          try { return JSON.stringify([mode || '', scene || '', overrides || {}, effective || {}]) } catch (e) { return '' }
        }
        /** 真发一次 `scope-get`（in-flight 合流；回来的那一拍仍属于本会话才落缓存）。 */
        function startScopeFetch(key) {
          // 换会话时**当场把上一份覆盖作废**：留着它，下面那个同步读会拿旧会话那一份
          // 当新会话的用 —— 菜单里显示的是 B 的值，点下去写的却是 A 的层。
          if (slashScopeCache.sessionId !== key) {
            slashScopeCache.overrides = null; slashScopeCache.effective = null; slashScopeCache.scene = null; slashScopeCache.mode = null
            // 指纹一起清掉：新会话哪怕碰巧也是空层，也该按"换了一份层"处理。
            slashScopeCache.stamp = ''
          }
          slashScopeCache.sessionId = key
          const seq = slashScopeCache.fetchSeq + 1
          slashScopeCache.fetchSeq = seq
          slashScopeCache.promise = apiCall('scope-get', { sessionId: key }).then(function (res) {
            const ok = res && res.ok !== false
            const overrides = ok ? (res.overrides || {}) : {}
            const effective = ok ? (res.effective || {}) : {}
            const scene = ok && typeof res.scene === 'string' ? res.scene : null
            const mode = ok
              ? (res.mode === 'global' || res.mode === 'workspace' ? res.mode : 'session')
              : null
            // 只有"当前缓存的会话仍是这一次请求的会话"才落进缓存：两个会话的请求交错时，
            // 先发的那个晚回来会把 A 的覆盖 / 生效值写成 B 的（菜单显示 A 的勾、点下去写 B 的层）。
            // `fetchSeq` 再挡一层：写后作废的那条旧层请求，晚回来也不许盖掉新的一份。
            if (slashScopeCache.sessionId === key && slashScopeCache.fetchSeq === seq) {
              const stamp = layerStampOf(mode, scene, overrides, effective)
              const changed = slashScopeCache.stamp !== stamp
              slashScopeCache.promise = null
              slashScopeCache.at = Date.now()
              slashScopeCache.dirty = false
              slashScopeCache.overrides = overrides
              slashScopeCache.effective = effective
              slashScopeCache.scene = scene
              slashScopeCache.mode = mode
              slashScopeCache.stamp = stamp
              if (changed) {
                // 六个域清单里的 `on` 都是按上一份层烘进去的（进场景尤其明显：进完后
                // `rules-list` 仍按旧 `effective` 给出"没勾"）。不在这里作废，下一屏就会一直
                // 停在旧勾上，直到用户退出菜单重进（0.21.2 复核三，用户实测）。
                slashScopeCache.rev += 1
                try { state.expireAll() } catch (e) { /* 只影响这一屏晚一拍刷新 */ }
              }
            }
            return { sessionId: mode === 'global' ? '' : key, overrides: overrides, effective: effective, scene: scene, mode: mode }
          }, function () {
            if (slashScopeCache.sessionId === key && slashScopeCache.fetchSeq === seq) {
              slashScopeCache.promise = null
              // 这一轮没读到层：别再拿"脏"卡着乐观勾不放，下一拍重新读。
              slashScopeCache.dirty = false
              // 读失败时手里**有**旧值就留着它（后台那一拍失败不该把已知的覆盖抹平成"跟随全局"），
              // 一份都没有才落空覆盖：写路径据此仍然走 scope-set（写会话层），而不是退回全局 ——
              // 显示的是本会话、改的却是全局，那正是这次要修的不一致。
              if (slashScopeCache.overrides === null) {
                slashScopeCache.at = Date.now()
                slashScopeCache.overrides = {}
                slashScopeCache.effective = {}
                slashScopeCache.scene = null
                slashScopeCache.mode = null
              }
            }
            return scopeSnapshotOf(key)
          })
          return slashScopeCache.promise
        }
        function scopeOfSession(sessionId) {
          if (!sessionId) return Promise.resolve(null)
          const key = String(sessionId)
          if (slashScopeCache.sessionId === key && slashScopeCache.overrides !== null) {
            if (Date.now() - slashScopeCache.at < 5000) return Promise.resolve(scopeSnapshotOf(key))
            // 手里有旧值就**先交旧的**，过期只在后台重读：`scope-get` 服务端要把五个域的列表 op
            // 全扫一遍（实测 `skill-state` 冷启 3.4s），同步等它 = 每敲一个键都可能停在上一拍。
            // 新数据落地后让宿主重取一次候选，那一屏自己会跟上。
            // 已有一次读在飞就复用它：写后 `prefetchAfterScene` 与这一拍会同时要到新覆盖，
            // 各发一条 `scope-get` 只是白白多扫一轮。
            const pending = slashScopeCache.promise && slashScopeCache.sessionId === key
              ? slashScopeCache.promise
              : startScopeFetch(key)
            pending.then(function () { refreshMenuFor(key) }, function () { /* 留着旧值，下一拍再试 */ })
            return Promise.resolve(scopeSnapshotOf(key))
          }
          // 还没有这一层的缓存（首次打开 / 预热失败 / 刚换会话）：**不等**一次 `scope-get`。
          // 先交一份「这一层什么都没覆盖」的快照 —— 域表的写入层仍按本会话算（`inSession`
          // 只看 sessionId），所以点下去不会写错层；勾先按全局口径画，后台读回来再刷新这一屏。
          // 全局粒度下没有会话层，退回全局快照（写也落到全局 op）。
          const fallback = scopeIsGlobalMode()
            ? slashGlobalLayer()
            : { sessionId: key, overrides: {}, effective: {}, scene: null, mode: null }
          const pending = slashScopeCache.promise && slashScopeCache.sessionId === key
            ? slashScopeCache.promise
            : startScopeFetch(key)
          pending.then(function () { refreshMenuFor(key) }, function () { /* 读不到就按这一屏的旧口径 */ })
          return Promise.resolve(fallback)
        }
        /**
         * 同步版（只读缓存）。**onPick 必须同步返回** —— 宿主 settle() 拿到返回值后立刻
         * 执行，不等 Promise（dsh-client-ui-input-trigger/lib/client.js 的 settle →
         * execute；契约 onPick(pick): PickOutcome 也是同步的）。所以点选这条路上不能有
         * await：它一 await，返回的 Promise 里既没有 text 也没有 claim，宿主会当成
         * 一次 insert-reference 且 reference 为 undefined —— 表现就是"点了没反应"。
         *
         * 能点到的行都来自一次 candidates()，而那次已经把覆盖取回来了；取不到只会是
         * "候选在屏幕上停了 5 秒以上"。那时退回全局口径，最坏是这一次写到了全局。
         */
        /**
         * 写完一处覆盖后**作废层缓存**（0.21.2）。
         *
         * 为什么必须有它：这份缓存 TTL 5 秒，而"点一条 → 菜单重取候选"在毫秒级发生。
         * 不作废的话重取拿到的还是**写之前**那份覆盖 —— 屏幕上的勾不翻、或翻一半又弹回来，
         * 正是"斜杠命令有时更新、有时没有勾选"（2026-10-19 实测）。
         */
        function invalidateScopeCache() {
          // **不清 `overrides`**：它是同步路径唯一能拿到的"写哪一层"依据。清掉之后，
          // 紧接着的那一次点击会退回全局口径 —— 屏幕上是本会话的勾、写进去的却是全局
          // （"斜杠命令有时会更新、有时不更新"，2026-10-19）。作废 TTL 就够：下一次
          // `candidates()` 先拿旧值交出去，同时在后台重读一份新的。
          slashScopeCache.at = 0
          slashScopeCache.promise = null
          // 写之前发出的那条 `scope-get` 回来的是旧层：连它在飞的资格一起作废。
          slashScopeCache.fetchSeq += 1
          // 层还没重新读到之前，任何域清单读回来的勾都是按旧层算的 —— 不许它们
          // 把刚叠上的乐观状态清掉（否则进场景那一下的勾会先亮再灭）。
          slashScopeCache.dirty = true
        }
        /**
         * 同步取某一层的覆盖（只读缓存）。
         *
         * **拿不到时返回空覆盖而不是 `null`**：`null` 会让 `domainsFor(null)` 造出全局那份
         * 域表，`run` 就写回全局 —— 而屏幕上明明是本会话那一层。空覆盖的代价只是这一次
         * 的 `on` 值按全局算，写入层仍然是对的。
         *
         * 唯一的例外是**全局粒度**：那一层本来就不存在，返回全局快照（`sessionId: ''`）
         * 才是"写入层是对的"—— 见 `slashLayerIdOf`。
         *
         * 返回 `effective` 与 `scene`（0.21.2 四层模型）：`domainsFor` 按**生效层**造域表
         * （三态勾），`scene` 决定场景行的进/出二态怎么写。
         */
        function scopeOfSessionSync(sessionId) {
          if (!sessionId) return null
          const key = String(sessionId)
          // 还没有这一层的缓存：全局粒度下**不能**退回会话层 —— 服务端在全局粒度下没有这一层，
          // 写过去只会拿到一条拒绝。面板那份粒度是同步可读的，用它兜住这一拍。
          if (slashScopeCache.sessionId !== key) {
            return scopeIsGlobalMode() ? slashGlobalLayer() : { sessionId: key, overrides: {}, effective: {}, scene: null, mode: null }
          }
          if (slashScopeCache.mode === 'global') return slashGlobalLayer()
          return {
            sessionId: key,
            overrides: slashScopeCache.overrides || {},
            effective: slashScopeCache.effective || {},
            scene: typeof slashScopeCache.scene === 'string' ? slashScopeCache.scene : null,
            mode: slashScopeCache.mode,
          }
        }
        /** 取某一层的域表（`scope` 为 null = 全局口径）。 */
        const domainsFor = function (scope) {
          return slashDomains(t, Object.assign({}, domainOpts, { scope: scope }))
        }
        const domainsOf = function () { return slashDomains(t, domainOpts) }

        /** 会话那一份触发器控制器；拿不到就回 undefined（调用方一律静默降级）。 */
        function controllerOf(sessionId) {
          if (!sessionId) return undefined
          const scope = ctx.sessions && typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined
          if (!scope) return undefined
          const service = ctx.get('inputTriggers')
          return service && typeof service.sessionOf === 'function' ? service.sessionOf(scope) : undefined
        }

        /**
         * 写成功之后让菜单重取一次候选（官方口 `controller.refreshOpenMenu()`：只重取，
         * 不改 hit、不闪可见行）。
         *
         * 为什么必须有它：宿主要么按 query 变化、要么按它自己的目录失效才重取候选，而我们这边
         * 只是把自家缓存标成过期 —— 菜单没再问，屏幕上就还是**上一次那份快照**：
         * 条目多寡跟着旧状态走（目录刚关掉、里面十几条还列着；刚开、那几条又不见了），勾翻过来了
         * 列表却没换。乐观覆盖管的是"状态"，管不了"这一屏该有哪些行"。菜单已经关了它就是空操作。
         */
        function refreshAfterWrite(sessionId) {
          try {
            // 快捷词另有一份 15 秒缓存（`quickCache`）：它和工具菜单的 `state` 缓存是两个
            // 入口，只 flush 一个会让「刚在工具菜单关掉的快捷词」继续出现在贴文字段里。
            invalidateQuickCache()
          } catch (e) { /* ignore */ }
          refreshMenuFor(sessionId)
        }

        /** 只让宿主重取一次候选（菜单没开着就是空操作）。后台读落地时走这一条。 */
        function refreshMenuFor(sessionId) {
          try {
            const controller = controllerOf(sessionId)
            if (controller && typeof controller.refreshOpenMenu === 'function') controller.refreshOpenMenu()
          } catch (e) { /* 刷不动只是这一屏晚一拍，改动本身已经生效 */ }
        }

        /**
         * 进 / 出场景后把六个域按**新的一层**重读一遍（后台，不挡这一屏）。
         *
         * 场景写入会同时改 MCP / 技能 / 人设 / 提示词 / 记忆的运行态，`state.settle` 已把
         * 六域的缓存全部标过期。若等用户点进某个域时才读，那一次下钻就要等一份冷读
         * （`skill-state` 冷启实测 3.4s）——用户看到的就是「切到技能 / MCP 没有立即切过去」。
         * 这里在场景回执之后立刻按新覆盖造域表并并行预热，用户下一次点击时数据已经在了。
         *
         * 必须**先**拿到新覆盖再造域表：`load` 会把四层生效值烘进每一条的 `on`，拿旧覆盖
         * 预热会把旧勾当成新场景的状态缓存下来。
         */
        function prefetchAfterScene(sessionId) {
          if (!sessionId) return
          const pending = slashScopeCache.promise && slashScopeCache.sessionId === sessionId
            ? slashScopeCache.promise
            : startScopeFetch(sessionId)
          pending.then(function () {
            const scope = scopeSnapshotOf(sessionId)
            const layerId = slashLayerIdOf(scope, sessionId)
            for (const domain of domainsFor(scope)) {
              state.read(domain, layerId).catch(function () { /* 这一域晚一拍，不影响其余 */ })
            }
            refreshMenuFor(sessionId)
          }, function () { /* 覆盖读不到就按这一屏的旧值，用户点进去时再读 */ })
        }

        /**
         * 本会话的输入态快照（`draft` + `draftRev`）。
         * 宿主拿 `draftRev` 做 CAS，所以任何一次重开 / 回填都要**现取**，不能用上一次的。
         */
        function inputStateOf(sessionId) {
          try {
            const scope = ctx.sessions && typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined
            if (!scope) return undefined
            const conversation = ctx.get('conversation')
            const input = conversation && conversation.input && typeof conversation.input.for === 'function'
              ? conversation.input.for(scope) : undefined
            return input && input.state && typeof input.state.getSnapshot === 'function' ? input.state.getSnapshot() : undefined
          } catch (e) { return undefined }
        }

        /**
         * 用官方口把菜单开在 `query` 那一层。
         *
         * 宿主的 `settle()` 对非下钻选取一律先关菜单，所以点完要重开：
         * `sessions.scope(sessionId)` → `inputTriggers.sessionOf(scope)` → `controller.toggleSource`
         * （宿主自己那个 `/` 菜单启动按钮走的就是同一条口，见 dsh-client-ui-conversation 的
         * toggleCommandMenu）。`toggleSource` 收的是**合成 hit**，宿主只把它记成当前 hit，
         * 不核对草稿里有没有那串字 —— 所以草稿干净的时候（点完开关被我们抹掉了 token）照样能开。
         * 拿不到就什么都不做（退回"点完关菜单"），不能把功能本身带坏。
         */
        function reopenMenu(sessionId, query, span) {
          if (!sessionId || !span) return
          try {
            const scope = ctx.sessions && typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined
            if (!scope) return
            const service = ctx.get('inputTriggers')
            const controller = service && typeof service.sessionOf === 'function' ? service.sessionOf(scope) : undefined
            if (!controller || typeof controller.toggleSource !== 'function') return
            // 宿主自己已经把它重开了 —— 再 toggle 一次就是关掉，正好相反。
            if (controller.launcher && typeof controller.launcher.getSnapshot === 'function'
              && controller.launcher.getSnapshot() === SLASH_SOURCE_NAME) return
            controller.toggleSource(SLASH_SOURCE_NAME, {
              trigger: '/', query: query, quoted: false, position: 'leading', span: span,
            })
          } catch (e) { /* 重开失败只是少一次连点，这次改动本身已经生效 */ }
        }

        /**
         * 点完把菜单留在这一层，且**把 token 从输入框里抹掉**（0.21.2，用户裁定：一律不留字）。
         *
         * 删除本身是宿主做的：onPick 交回 `{ text: '' }` → `slash/input-insert-text` →
         * `shell.insertText('', span)` → `replaceText(span, '')`（`matchEnter` 清掉半个 token
         * 走的就是同一条口）。这里只负责在它删完之后把菜单开回这一层：
         *   · span 收成**零宽**（start = end = 删完后的光标位），所以下一次点选交回的
         *     `{ text: '' }` 对宿主是一次空替换，一个字都不会再写进输入框；
         *   · 万一宿主那一枪没落地（`draftRev` 对不上），草稿里那串字还在 —— 退回带着
         *     token 的那条路重开，连点不丢。
         */
        function keepOpenClean(sessionId, query, caret) {
          if (!sessionId || typeof caret !== 'number') return
          const st = inputStateOf(sessionId)
          if (!st) return
          const text = '/' + query
          const draft = String(st.draft || '')
          const stillThere = draft.slice(caret, caret + text.length) === text
          reopenMenu(sessionId, query, stillThere
            ? { start: caret, end: caret + text.length, draftRev: st.draftRev }
            : { start: caret, end: caret, draftRev: st.draftRev })
        }

        /** 摘要要单独等：域行不能因为一次读失败就不出现（那样整段会凭空消失，看起来像坏了）。 */
        async function domainRows(domains, query, sessionId) {
          const picked = domains.filter(function (d) {
            if (!query) return true
            const q = query.toLowerCase()
            return d.token.toLowerCase().indexOf(q) >= 0 || d.label.toLowerCase().indexOf(q) >= 0
          })
          // 这六行是**固定的**（域名跟着语言走），读盘只为了右侧那句摘要。所以绝不同步等它们：
          // 有缓存就当场写上去，没有就留空并把这一次读排进后台（读回来由 `refreshMenuFor`
          // 让宿主重取一次）。早先是 `Promise.all` 等六个域全读完才交行，最慢的那一个
          // （`skill-state` 冷启实测 3.4s）把第一次按 `/` 变成"卡一下才出现"。
          return picked.map(function (d) {
            const cached = state.peek(d, sessionId)
            if (cached === undefined) {
              try {
                state.read(d, sessionId).catch(function () { /* 摘要留空，不影响能点 */ })
              } catch (e) { /* 同上 */ }
            }
            let description = ''
            if (cached !== undefined) {
              try { description = cached.summaryOf(state.effective(d, cached.items)) || '' } catch (e) { description = '' }
            }
            return {
              name: d.token, label: d.label, icon: SlashOffIcon, drill: true,
              ...description ? { description: description } : {},
              section: sectionTitle(), value: d.key,
            }
          })
        }

        /** 叶子行（下钻后的某域条目）。 */
        async function leafRows(domain, rest, sessionId) {
          let data
          try {
            data = await state.read(domain, sessionId)
          } catch (e) {
            // 读失败：菜单里不出假列表，直接说清楚。列一行"出错了"再让用户点它，点下去什么
            // 也不会发生 —— 那是第二条谎。
            showPluginToast(t('slash.err.load', { domain: domain.label, error: errMsg(e) }), 'err')
            return []
          }
          // 记忆域带了一份跨场景全量：只在打了字的时候用（见 load 里的注释）。
          const pool = rest && data.searchPool ? state.effective(domain, data.searchPool) : state.effective(domain, data.items)
          const hit = pool.filter(function (item) { return slashMatch(rest, item) })
          // 排序三档：先按分组（来源目录 / 场景）**首次出现的顺序**，组内把"目录"那行钉在最上，
          // 再按"已启用的在前 + 名字"。分组顺序不能打乱 —— 宿主只在 section 与上一行不同时才画一条
          // 标题，同组被拆开就会冒出一串重复标题。
          const order = new Map()
          for (const item of hit) {
            const g = item.group || domain.label
            if (!order.has(g)) order.set(g, order.size)
          }
          // "已启用的在前"按**进入这一域那一刻**的快照排（0.21.2，用户裁定）：点一条之后马上把
          // 那一条顶到最前，等于逼用户重新找一遍那一行，还容易顺手点错下一条 —— 位置要不动，
          // 重新进入这一域时才按新状态重排。快照按未筛选的全量建，打字筛过也不会漏。
          const snap = state.orderOf(domain, sessionId, pool)
          const rankOn = function (item) {
            const k = slashItemKey(item)
            return snap.has(k) ? snap.get(k) : item.on === true
          }
          hit.sort(function (a, b) {
            const ga = order.get(a.group || domain.label)
            const gb = order.get(b.group || domain.label)
            if (ga !== gb) return ga - gb
            // 目录行是这一组的总开关，跟着状态跳到别处就找不着了，所以永远钉在本组第一行。
            const fa = a.first === true ? 0 : 1
            const fb = b.first === true ? 0 : 1
            if (fa !== fb) return fa - fb
            const ao = rankOn(a)
            const bo = rankOn(b)
            if (ao !== bo) return ao ? -1 : 1
            return String(a.id).localeCompare(String(b.id))
          })
          // 全量列出，不截断：宿主的候选面板自己带滚动（MenuView 的 viewport + 溢出提示），
          // 之前那套"每域只列 6 条 + 一行继续输入以筛选"是把滚动条的活拿来让用户打字。
          return hit.map(function (item) {
            // 右侧灰字给条目自己的备注（场景说明 / 技能描述 / MCP 备注 / 人设描述 / 预设描述 /
            // 记忆描述）：启用状态图标位那枚勾已经说了，不必再占一格。没有备注的才退回状态词，
            // 免得那一格空着像坏了。
            const note = clipText(item.note, LEAF_NOTE_MAX)
            return {
              name: domain.token + '/' + item.id, label: item.label,
              // 会话作用域：覆盖行右侧追加「· 本会话」/「· 本工作区」（0.21.2 跟着隔离粒度）。
              // 图标**不再换色**（用户裁定：一种颜色更容易理解）—— 来源这一维只由这句灰字承担。
              description: (note || (item.on ? t('slash.state.on') : t('slash.state.off'))) + (item.scoped === true ? ' · ' + t('scope.toggle.session', { layer: slashLayerWord(t, scopeOfSessionSync(sessionId)) }) : ''),
              icon: item.on ? SlashOnIcon : SlashOffIcon,
              section: item.group || domain.label,
              value: JSON.stringify({ domain: domain.key, key: slashItemKey(item) }),
            }
          })
        }

        const source = {
          trigger: '/',
          name: SLASH_SOURCE_NAME,
          // 段的先后按宿主的源表排序走（`roster.sources(trigger)` 以 `order ?? 0` 升序）：
          // 官方「指令」源没写 `order`（=0）、技能源是 2，所以 1 把「工具」夹在两者中间
          // （用户裁定：工具在指令下面、技能上面）。
          order: 1,
          // 每行都自带 section ⇒ 宿主不再渲染源标题行（MenuView 的判据），段名由我们词典出，
          // 中英随宿主语言。源名本身（tool-management）因此不会出现在界面上，只当唯一性用。
          showGroupTitle: false,
          async candidates(session, req) {
            // 行内也认（用户 2026-10-18：「输入框输入了文字，空格后输入斜杠命令没有工具和
            // 快捷提示词」）：宿主自己的 `boundaryOk` 只把「紧跟在文字后面的 `/`」当成普通
            // 字符，前面是空格的 `/` 本来就是合法触发（`position` 报 `inline`）。我们此前一律
            // 只收 `leading`，于是「先打一段话、空格、再打 /」永远弹不出这两段。
            // 真正的"半路打出来的 /"（`https://`、`a/b`）宿主已经挡掉，这里不必再拦一遍。
            const query = req.query || ''
            const at = query.indexOf('/')
            const sessionId = quickSessionIdOf(session)
            // 「停在哪一层」变了（回域列表 / 换进另一个域）就作废顺序快照：列表按新状态重排
            // 只该发生在重新进入这一拍，而不是每次点完开关（见 `leafRows` 里的快照）。
            const episode = String(sessionId || '') + "\u0000" + (at < 0 ? '' : query.slice(0, at))
            if (episode !== slashEpisode) { slashEpisode = episode; state.forgetOrder() }
            // 会话作用域（0.21.2）：先取本会话的覆盖，再拿那一层的域表 —— 顺序不能反
            // （`cell()` 在 `load` 里就要读它）。取不到 = 全局口径，与 0.21.2 逐字相同。
            const scope = await scopeOfSession(sessionId)
            // 全局粒度：这一层就是全局层 —— **读也不带会话 id**。带着它读，会把保留在侧车里
            // 却不生效的旧覆盖当成现状（用户明明切了全局，菜单里还挂着几个对话的旧勾）。
            const layerId = slashLayerIdOf(scope, sessionId)
            const domains = domainsFor(scope)
            if (at < 0) return domainRows(domains, query, layerId)
            const token = query.slice(0, at)
            const domain = domains.filter(function (d) { return d.token === token })[0]
            if (!domain) return []
            return leafRows(domain, query.slice(at + 1), layerId)
          },
          header(session, req) {
            const query = req.query || ''
            if (query.indexOf('/') < 0) return undefined
            // 这里用**不带 scope** 的域表：只需要 token 与 label，与哪一层无关（header 是同步的，
            // 取不到覆盖；而域名在任何层都一样）。
            const domain = domainsOf().filter(function (d) { return query.indexOf(d.token + '/') === 0 })[0]
            if (!domain) return undefined
            // **不看 req.drilled**：宿主在每次"非下钻"的选取后都会把这个标记清掉
            // （input-trigger client.js 的 `this.drilled = action === 'drill'`），而叶子选取正是
            // 非下钻 —— 用它当判据的话，勾第一次开关之后面包屑就没了，"返回上一级"跟着消失。
            // 官方的 @file 源可以只认 drilled（打字打出来的路径草稿里自带上下文），这里不行。
            // 全局粒度（0.21.2+）把这一层写在第一颗面包屑上：没有会话层可写，点下去改的是
            // 所有对话共用的那份 —— 让用户在点之前就知道，而不是靠事后的回执。
            const rootLabel = (slashScopeCache.mode === 'global' || scopeIsGlobalMode())
              ? sectionTitle() + ' · ' + t('scope.layer.global')
              : sectionTitle()
            return [
              { label: rootLabel, value: SLASH_ROOT_CRUMB },
              { label: domain.label, value: '/' + domain.token + '/', current: true },
            ]
          },
          /**
           * 会话出生时的一次预热（官方 `warm` 钩子，fire-and-forget）。
           *
           * 为什么值得：第一次按 `/` 要等的那批读（`scope-get` 与六个域的列表 op）跟"用户要不要
           * 用这个菜单"没关系 —— 会话活着的那一刻起就可以去读了。预热做完，第一次弹出只剩渲染。
           * 顺序不能反：域表要按**本会话那一层**造（每一条的 `run` 闭住了"写哪一层"），所以先取
           * 覆盖、再用那份覆盖造域表去读清单。任何一步失败都只是"第一次照样慢一点"。
           */
          warm(session) {
            const sessionId = quickSessionIdOf(session)
            if (!sessionId) return
            try {
              scopeOfSession(sessionId).then(function (scope) {
                // 六个域的清单并行预热；`read` 恒回 Promise，读失败只等于"这一拍没预热上"。
                // 层与候选时同一条规则（全局粒度 = 不带会话 id），否则预热的那一份会与
                // 真正渲染时那一份分属两个缓存桶 —— 第一次按 `/` 等于没预热。
                const layerId = slashLayerIdOf(scope, sessionId)
                for (const d of domainsFor(scope)) state.read(d, layerId).catch(function () { /* 下一轮再读 */ })
              }, function () { /* 覆盖读不到 = 这一拍不预热 */ })
            } catch (e) { /* 预热失败不影响功能本身 */ }
          },
          /**
           * 点选。**必须是同步函数** —— 宿主 `settle()` 拿到返回值后立刻 `execute()`，
           * 契约 `onPick(pick): PickOutcome` 里也没有 Promise 这一档。上一版把它写成
           * `async` 之后返回的是 Promise：`"text" in outcome` 与 `"claim" in outcome` 全为假，
           * 宿主落进 `insert-reference` 且 `reference` 为 undefined ⇒ 点了没反应、菜单关掉，
           * 而重开那一步因为草稿没变也不会发生（2026-10-19 实测）。
           *
           * 所以会话覆盖改走**同步缓存**（`scopeOfSessionSync`）：能点到的行都来自一次
           * `candidates()`，覆盖那时已经取回；取不到只说明候选在屏幕上停超过 5 秒，
           * 那一刻退回全局口径（最坏是这一次写到了全局，不会点不动）。
           */
          onPick(pick) {
            const candidate = pick.candidate
            const value = candidate.value
            if (typeof value !== 'string' || value === '') return undefined
            // 与 `quickSessionIdOf` 同一条取法：宿主给的会话对象两种字段都见过。只读
            // `sessionId` 时，另一种形状下这里恒为 undefined —— 菜单显示本会话的勾，
            // 点下去却写回全局（静默，不报错）。
            const sessionId = quickSessionIdOf(pick.session)
            const spanStart = pick.span && typeof pick.span.start === 'number' ? pick.span.start : undefined
            /**
             * 一律不在输入框留命令字（0.21.2，用户裁定）：交回 `{ text: '' }` 让宿主把整个 token 段
             * 替换成空（输入框回到点之前的样子），微任务里再用零宽 hit 把菜单开回 `query` 那一层
             * 接着点。代价是菜单开着时"打字筛这一域"不再可能（草稿里没有 token，宿主下一次 track
             * 就关菜单）—— 而每一域本来就全量列出、自己带滚动。
             *
             * `query` 是不带前导 `/` 的那一段：`''` = 域列表，`tool-skill/` = 技能那一层。
             */
            const stayCleared = function (query) {
              if (typeof spanStart === 'number') Promise.resolve().then(function () { keepOpenClean(sessionId, query, spanStart) })
              return { text: '', continue: true }
            }
            // 面包屑：官方语义里"回到上层"与"深入一层"共用一个出口，value 就是那一层的 token
            // （`/tool-` 回域列表、`/tool-skill/` 回技能那一层）。
            if (value.charAt(0) === '/') return stayCleared(value.slice(1))
            // 域行：原地进入该域。宿主只在点行右侧 › 或按 Tab 时发 action:'drill'，点整行发的是
            // 'pick'（MenuView 的行渲染），所以这里不看 action —— 点哪都该进去。
            if (candidate.drill === true) return stayCleared(String(candidate.name) + '/')
            let target = null
            try { target = JSON.parse(value) } catch (e) { return undefined }
            if (!target || !target.domain || target.key === undefined) return undefined
            // 会话作用域（0.21.2）：**必须用同一份带 scope 的域表** —— 这里拿到的是 domain 对象，
            // 而 `item.run` 已经闭包住了"写哪一层"（`runFlag` 在 `load` 时决定的）。
            // 用全局那份域表会让点击写回全局，而屏幕上是本会话的值。
            const scopeSnap = scopeOfSessionSync(sessionId)
            // 缓存与写入用同一层（全局粒度下都是 `''`）：读用 `''` 写用真 sessionId，
            // 会按 A 那份清单定位到条目、却写进另一层，或者干脆被服务端拒掉。
            const layerId = slashLayerIdOf(scopeSnap, sessionId)
            const domain = domainsFor(scopeSnap).filter(function (d) { return d.key === target.domain })[0]
            if (!domain) return undefined
            // 回到本域根 + 菜单不关（纪律④）：执行是异步的，所以先叠一份乐观状态再发请求。
            // **用屏幕上那一份**（0.21.2）：这一行本来就是上一次候选渲染出来的，按用户看到的
            // 那个值翻转就是对的。从前这里要 await 一次读 —— 恰好有一次后台读在飞时，点下去得
            // 等它回来才写、才翻勾，表现就是"点了过一会儿才变"。缓存没有才退回真读。
            const cachedData = state.peek(domain, layerId)
            const located = cachedData === undefined ? state.read(domain, layerId) : Promise.resolve(cachedData)
            located.then(function (data) {
              const pool = (data.searchPool || data.items)
              const shown = state.effective(domain, pool)
              // 按 key 定位，不按 id：技能/来源这类条目会重名（同名技能在两个目录里各有一行），
              // 按 id 取到的是列表里第一条同名的 —— 用户点了自己那行、改的却是别的目录里的。
              const item = shown.filter(function (x) { return slashItemKey(x) === String(target.key) })[0]
              if (!item) { showPluginToast(t('slash.err.gone'), 'err'); return }
              const next = item.on !== true
              if (item.single === true && !next) {
                // 单选又没有"全关"这一态的那一类（AGENTS.md 基线）点"当前这一项"：什么都不做，
                // 只说清楚现在就是它。场景不在这儿 —— 关掉它=退出场景，是一个真实可逆的动作；
                // 快捷提示词也不在这儿 —— 那颗开关关得掉。
                showPluginToast(t('slash.did.already', { name: item.label }), 'ok')
                return
              }
              const touched = state.mark(domain, shown, item, next)
              return Promise.resolve(item.run(next)).then(function (res) {
                if (!res || res.ok === false) {
                  state.unmark(touched)
                  state.abort(domain)
                  // 撤掉乐观覆盖之后**必须再让菜单重取一次候选**：覆盖表只是"状态"，而这一屏
                  // 是上一次取候选时按覆盖表渲染出来的快照 —— 不重取的话那个勾就留在屏幕上，
                  // 直到用户关掉再打开菜单才自己消失。场景锁定时最明显：服务端一律拒绝写，
                  // 面板却先把勾画上了，用户看到的是"开了、但其实没开"（2026-10-12 用户实测
                  // 「虽然不会真的开启，但第一次刷新会显示勾选，重新进入其实是没勾选的」）。
                  // 重取读到的是 `entries` 里那份**改动前**的缓存（失败不作废缓存），
                  // 覆盖表又已经空了 ⇒ 画出来的正好是真实状态。
                  refreshAfterWrite(sessionId)
                  showPluginToast(res && res.error ? translateError(t, res) : t('slash.err.failed'), 'err')
                  return
                }
                // 写成功后：撤"未落地的写"条子 + 只让**被改的那一域**过期重读（整张表全清会让
                // 下一次候选把六个域都冷读一遍，那正是"点一下卡一下"），再作废本插件那份 5 秒
                // 层缓存（少了它，重取读到的还是写之前那份覆盖，勾不翻 —— 2026-10-19），
                // 最后让菜单重取一次。
                state.settle(domain, layerId)
                invalidateScopeCache()
                // 面板那一份覆盖也重读：设置页可能正开着同一个会话那一层，不刷新的话
                // 它显示的还是写之前的勾，直到用户切走再切回来（2026-10-19）。
                try { refreshScope() } catch (e) { /* 面板没开着就什么都不做（见 20b 的 scopeMounted） */ }
                refreshAfterWrite(sessionId)
                // 进 / 出场景会改好几个域的运行态：趁用户还在这一屏时后台把六域读好，
                // 下一次点进去不必再等冷读（见 prefetchAfterScene 的注释）。
                if (domain.key === 'scene') {
                  try { prefetchAfterScene(sessionId) } catch (e) { /* 预热失败只影响下一次下钻的速度 */ }
                }
                const warn = joinWarn(stateSyncWarn(t, res) || sceneSyncWarn(t, res), slashModeStaleWarn(t, res))
                // 全局粒度下这一下改的是**所有对话共用的那份**：回执必须说出来，不然用户会以为
                // 只动了当前这个对话（正是切到全局后最容易误解的一步）。
                const doneText = item.done(next) + (layerId === '' ? t('slash.did.globalTail') : '')
                showPluginToast(warn ? joinWarn(doneText, warn) : doneText, warn ? 'warn' : 'ok')
              })
            }).catch(function (e) {
              showPluginToast(errMsg(e), 'err')
            })
            return stayCleared(domain.token + '/')
          },
          async matchEnter(session, line) {
            // 只认领"整行就是半个 token"这一种：`/tool-skill 帮我…` 后面还跟着正文时不拦，
            // 那是用户在写字，不是手滑按了回车。
            const trimmed = String(line || '').trim()
            if (trimmed.indexOf('/tool-') !== 0 || /\s/.test(trimmed)) return undefined
            showPluginToast(t('slash.err.pick'), 'err')
            return { text: '' }
          },
        }

        // ── 快捷提示词单独成段（贴文字那一段，order 3 ⇒ 排在官方「技能」段之后）──────────────
        //
        // 与「工具 › 提示词」那一域是**两件事**，所以两处都在（用户 2026-10-01 裁定）：域里那一组
        // 回答"这条要不要用"（与面板那颗药丸同一个动作），这一段回答"把这段话拿出来"——
        // 点一下把正文原样贴进输入框。同一屏里出现两种行会互相误读，所以贴文字绝不进域里。
        //
        // 为什么这一段能排到官方「技能」下面：宿主的段先后由**源**的 `order` 决定（`roster.sources`
        // 排序后一组一组渲染），同一个源里的行只能跟自己排顺序 —— 分组标题（section）只管一个源内部。
        //
        // 点一下 = 把正文原样贴进草稿，**不自动发送**（宿主要用户自己按 Enter）：这一段是
        // 用户自己写的现成话，替他按下发送键就是把"贴上来看看"变成"已经发出去了"。
        const QUICK_TTL_MS = 15000
        // 会话层（0.21.2）：这份缓存**按会话分桶** —— 同一份清单在两个对话里 `enabled` 可以不同，
        // 共用一个槽会让 A 的开关状态出现在 B 的菜单里。键 = sessionId（取不到用空串）。
        const quickCache = { at: 0, promise: null, rows: null, key: null }
        /** 作废贴文字段的快捷词缓存（工具菜单写完调用；见 `refreshAfterWrite`）。 */
        function invalidateQuickCache() {
          quickCache.at = 0
          quickCache.rows = null
          quickCache.promise = null
          quickCache.key = null
        }
        /**
         * 宿主在 `candidates(session, req)` 里给的就是当前会话（`sessions.scope(id)` 那份），
         * onPick 的 `pick.session` 同源。两种形状都以 `sessionId` 为主、`id` 兜底 ——
         * 只认一个字段会在另一种形状下静默退回全局口径。
         */
        function quickSessionIdOf(session) {
          const id = session && (session.sessionId || session.id)
          return typeof id === 'string' ? id : ''
        }
        function quickPrompts(sessionId) {
          const key = String(sessionId || '')
          if (quickCache.promise && quickCache.key === key) return quickCache.promise
          if (quickCache.rows && quickCache.key === key && Date.now() - quickCache.at < QUICK_TTL_MS) return Promise.resolve(quickCache.rows)
          const args = key ? { sessionId: key } : {}
          quickCache.key = key
          quickCache.promise = apiCall('quickprompt-list', args).then(function (res) {
            if (!res || res.ok !== true) throw new Error(translateError(t, res) || t('slash.err.failed'))
            const rows = res.prompts || []
            // 只有当缓存仍指向这一次请求的会话时才落盘：两个会话的请求交错时，
            // 先发的那个晚回来会把 A 的清单写成 B 的（菜单显示 A 的快捷词）。
            if (quickCache.key === key) {
              quickCache.promise = null
              quickCache.at = Date.now()
              quickCache.rows = rows
            }
            return rows
          }, function (e) {
            if (quickCache.key === key) quickCache.promise = null
            throw e
          })
          return quickCache.promise
        }
        const quickSource = {
          trigger: '/',
          name: QUICK_SOURCE_NAME,
          order: 3,
          showGroupTitle: false,
          async candidates(session, req) {
            // 同「工具」段：行内也认（前面是空格的 `/` 本来就是合法触发）。
            const query = String(req.query || '')
            // 只列一层：带 `/` 的草稿（`/tool-skill/…`）不是这一段的 token。
            if (query.indexOf('/') >= 0) return []
            let rows
            try {
              const sid = quickSessionIdOf(session)
              const snap = scopeOfSessionSync(sid)
              // 全局粒度（0.21.2+）：这一段也按全局那份清单列 —— 带会话 id 读回来的
              // 是保留着却早已不生效的旧覆盖，会出现"全局开着、这里却不显示"。
              // 粒度还没读到时不阻塞这一屏（读一次 `scope-get` 可能要几秒）：先按当前判断出，
              // 读到全局再让宿主重取一次；`slashScopeCache` 记住粒度之后就不会再触发。
              if (snap !== null && snap.mode === null) {
                scopeOfSession(sid).then(function (s) {
                  if (s && s.mode === 'global') { invalidateQuickCache(); refreshMenuFor(sid) }
                }, function () { /* 读不到就按当前这一屏 */ })
              }
              rows = await quickPrompts(slashLayerIdOf(snap, sid))
            } catch (e) {
              // 读不到就不出这一段。每次按键都弹一条 toast 只会变成噪声 —— 为什么没有这段，
              // 兼容页那行挂载状态说得出"挂上了"，具体哪次读失败在面板里看得境。
              return []
            }
            const q = query.toLowerCase()
            return rows.filter(function (p) {
              // 面板上那颗开关关掉的不出现（与「提示词」域里那一组同一条判据，见 slashQuickRows）。
              if (p.enabled === false) return false
              if (!q) return true
              return String(p.id).toLowerCase().indexOf(q) >= 0 || String(p.description || '').toLowerCase().indexOf(q) >= 0
            }).map(function (p) {
              return {
                name: 'qp-' + p.id, label: p.id, value: p.id,
                // 右侧灰字给备注（与提示词页那一行同一个字段）：正文本身点下去就整段进输入框，
                // 在这里再截一行只是把同一句话占成两处。
                description: String(p.description || ''),
                section: t('slash.section.quick'),
                // 正文随候选带着：宿主的 `settle()` 拿到 onPick 的返回值后**同步**执行插入，
                // 现场发请求读正文来不及（`quickprompt-list` 连正文一起回就是这个原因）。
                body: String(p.content || ''),
              }
            })
          },
          onPick(pick) {
            const body = String((pick.candidate && pick.candidate.body) || '')
            if (!body.trim()) { showPluginToast(t('slash.quick.empty'), 'err'); return undefined }
            // 不带 `continue`：菜单关掉、正文留在草稿里（宿主替换的是整个 `/qp-xxx` token）。
            return { text: body }
          },
          async matchEnter(session, line) {
            const trimmed = String(line || '').trim()
            if (trimmed.indexOf('/qp-') !== 0 || /\s/.test(trimmed)) return undefined
            showPluginToast(t('slash.err.pick'), 'err')
            return { text: '' }
          },
        }
        // 重名会当场抛（`registerSource` 判据是同 trigger 下源名唯一）—— 那是别的插件占了
        // `tool-management` 这个名字，不是本功能的故障，但必须说清"为什么没有这一段"，
        // 否则表现就是"开关开着、菜单里却什么都没有"。
        const unregisters = []
        try {
          // 两段各按自己那颗开关注册：「工具」管六个域，「快捷提示词」管贴文字那一段 ——
          // 域里的快捷词是启停，不是贴文字，所以两处互不代替（见上面两段各自的注释）。
          if (cfg.tools !== false) unregisters.push(triggers.registerSource(source))
          if (cfg.quickPrompts !== false) unregisters.push(triggers.registerSource(quickSource))
        } catch (e) {
          // 后一个源抛了也要把前一个撤掉：只挂一半比一个都不挂更难解释。
          unregisters.forEach(function (off) { try { off() } catch (e2) { /* 已经报不了状态了 */ } })
          setSlashMount('conflict')
          return
        }
        for (const key of wanted) setSlashMount('registered', key)
        // 作用域一变（进 / 退场景、拨开关、清覆盖）两份菜单缓存立刻作废：否则 `/` 菜单
        // 最多 15 秒里还列着本会话已经关掉的快捷词，或按 5 秒前的勾状态去写（0.21.2 复核）。
        //
        // **只作废时效，不抹掉 `overrides` / `effective` / `scene`**（0.21.2 复核二）：面板
        // 每写一次就会通知一次，连同 `onPick` 自己也调 `refreshScope()` —— 把这三样清成 null，
        // 菜单下一次候选就得同步等一次 `scope-get`（要扫五个域的列表，冷启实测数秒），
        // 表现正是「进入场景后切到技能 / MCP / 子代理 / 提示词 / 记忆不立即响应」。
        // 留着旧值：下一次候选当场能画（写入层也仍按本会话算），后台重读回来再刷新这一屏。
        let offScope = null
        try {
          offScope = subscribeScope(function () {
            slashScopeCache.at = 0
            slashScopeCache.promise = null
            invalidateQuickCache()
          })
        } catch (e) { /* 作用域模块不在（老装配）→ 各缓存按自己的 TTL 走 */ }
        scope.effect(function () {
          return function () {
            unregisters.forEach(function (off) { try { off() } catch (e) { /* 撤不掉只是多留一个源，不影响界面 */ } })
            if (typeof offScope === 'function') { try { offScope() } catch (e) { /* 同上 */ } }
            setSlashMount('unregistered')
          }
        })
      })
    }
