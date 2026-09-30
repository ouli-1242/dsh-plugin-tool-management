    // ── 斜杠命令「工具」段（对话输入框里直接管六个域）────────────────────────────
    //
    // 要解决的问题：切个场景、临时停一个 MCP，都得离开当前对话去「设置 → 工具」。这一段把
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
    //   ④ 点完不关菜单：宿主的 `settle()` 对**非下钻**的选取一律先 `reduce({type:'close'})`
    //      （input-trigger client.js），所以叶子选取除了把 token 收回本域根，还要在微任务里用
    //      官方口重新打开这一层 —— 连点多个开关是这个功能的主要用法。整段包在 try 里，任何一步
    //      取不到就退回"点完关菜单"，不能把功能本身带坏。
    var SLASH_SOURCE_NAME = 'tool-management'
    /** 快捷提示词那一段自己的源名（与「工具」段分开注册，才能排到官方「技能」段之后）。 */
    var QUICK_SOURCE_NAME = 'tool-quick-prompts'
    /** 「全局」保留场景的目录名 —— 与服务端 `src/memories/constants.ts` 的 `GLOBAL_SCENE` 同值。 */
    var GLOBAL_SCENE = 'global'
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
                return {
                  id: s.name, key: s.name, label: s.name, on: s.name === active, note: s.description,
                  // 单选，但**关得掉**：再点当前这一项 = 退出场景（`scenes:[]` 是服务端明确支持的
                  // 写法，含义是"只注入全局与公共基线"），跟面板上那颗开关同一个出口。
                  run: function (next) { return apiCall('rules-set-active', { scenes: next ? [s.name] : [] }) },
                  done: function (next) { return t(next ? 'slash.did.scene' : 'slash.did.sceneOff', { name: s.name }) },
                }
              }),
            }
          },
        },
        {
          key: 'skill', token: 'tool-skill', label: t('slash.domain.skill'),
          load: async function () {
            const res = await apiCall('skill-state', {})
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
              if (root.scope !== 'project' && root.defaultSource !== true) {
                items.push({
                  id: rootName, key: '@' + root.key, label: rootName + ' · ' + t('slash.skill.sourceRow'),
                  on: root.enabled !== false, group: rootName, first: true,
                  run: function (next) { return apiCall(next ? 'skill-source-enable' : 'skill-source-disable', { root: root.key }) },
                  done: function (next) { return t(next ? 'slash.did.sourceOn' : 'slash.did.sourceOff', { name: rootName }) },
                })
              }
              // 目录停用时**照样把里面的技能读进来**，只是由覆盖表那一层先不显示（`effective`）：
              // 这样"重新启用"当场就能把原本生效的那几条摆回来，不用等下一次真读。状态按"假设来源
              // 开着"算 —— 服务端的 `managerEnabled = 可写 && 来源启用 && 单条没被关掉`，来源关着时
              // 它恒为 false，而单条自己的意图在 `managerOverride` 里，把来源那一项补成 true 就是
              // 启用之后会读到的值。
              const sourceOff = root.enabled === false
              for (const skill of root.skills || []) {
                // 被同名遮蔽的那条按了也没效果（面板不给开关，给的是「启用这个」——那是切首选，
                // 不在"可逆启停"这一类里，所以 `/` 菜单不列）。
                if (skill.shadowedBy) continue
                const view = sourceOff ? Object.assign({}, skill, { managerEnabled: true }) : skill
                items.push({
                  // `key` 带来源，`id` 不带：同名技能在两个目录里各有一行时，`id` 一样而 `key` 不一样
                  // —— 只按 id 找目标会改到另一条（点了没反应就是这个）。alias 那行灰字仍显示短名。
                  id: skill.name, key: root.key + '/' + skill.name,
                  label: skill.declaredName || skill.name, on: isSkillEnabled(view), note: skill.description,
                  // 分组标题 = 来源目录（技能页那套显示名）。技能动辄几十条又分属多个目录，
                  // 不分组就是一片平铺，找不到自己要改的那一条。
                  group: rootName,
                  run: function (next) { return apiCall(next ? 'skill-enable' : 'skill-disable', { root: root.key, name: skill.name }) },
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
              return {
                // 同一台服务器可以在用户级与项目级各有一份（同名同 id），所以 key 带 level。
                id: row.id, key: row.level + ':' + row.id, label: row.serverName || row.id, on: row.disabled !== true, note: row.notes,
                run: function (next) { return apiCall('mcpm-set-enabled', { id: row.id, level: row.level, enabled: next }) },
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
              return {
                id: p.name, key: p.name, label: p.name, on: p.enabled !== false, note: p.description,
                run: function (next) { return apiCall('subagent-toggle', { name: p.name, enabled: next }) },
                done: function (next) { return t(next ? 'slash.did.on' : 'slash.did.off', { name: p.name }) },
              }
            })
            return { summaryOf: slashOnOffSummary(t), items: items }
          },
        },
        {
          key: 'preset', token: 'tool-preset', label: t('slash.domain.preset'),
          load: async function () {
            const res = await apiCall('agentsmd-list', {})
            if (!res || !res.ok) throw new Error(translateError(t, res))
            const items = (res.presets || []).map(function (p) {
              return {
                id: p.id, key: p.id, label: p.id, on: p.active === true, note: p.description,
                // 应用基线改的是**整轮环境**（全局 AGENTS.md）。它可逆（再应用原来那套就切回去），
                // 所以按②的口径可以进 `/`；但这里没有官方确认门可用，于是把"当前是哪套"写进域行
                // 摘要 —— 点之前屏幕上至少说清了要换掉什么。
                // 点"当前这套"不做任何事（`single`）：基线没有"全部不应用"这一态，
                // 把勾去掉等于让全局 AGENTS.md 凭空消失，那不是这里的语义。
                single: true,
                run: function () { return apiCall('agentsmd-apply', { id: p.id }) },
                done: function () { return t('slash.did.preset', { name: p.id }) },
              }
            })
            const quicks = await slashQuickRows(t, quickOn)
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
          load: async function () {
            const res = await apiCall('rules-list', {})
            if (!res || !res.ok) throw new Error(translateError(t, res))
            const active = res.activeScene || ''
            // 场景显示名（`global` → 「全局」）：分组标题用它，别让用户在 `/` 菜单里看到磁盘名。
            const labels = {}
            for (const s of res.scenes || []) if (s && s.name) labels[s.name] = s.label || s.name
            const toRow = function (r) {
              // 记忆的场景 = group 的第一段（与服务端 `sceneOf` 同一口径，见 memories/projection.ts）。
              const scene = String(r.group || '').split('/')[0]
              return {
                id: r.id, key: r.id, label: r.name, on: r.enabled !== false, note: r.description,
                scene: scene,
                // 打了字会跨场景搜，那时按场景分组才看得清是哪里的记忆。
                group: labels[scene] || scene || t('slash.group.noScene'),
                run: function (next) { return apiCall('rules-toggle', { id: r.id, enabled: next }) },
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
    async function slashQuickRows(t, quickOn) {
      if (quickOn === false) return []
      let res
      try { res = await apiCall('quickprompt-list', {}) } catch (e) { return [] }
      if (!res || res.ok !== true) return []
      return (res.prompts || []).map(function (p) {
        return {
          // `key` 带前缀：全局预设与快捷词各存一份目录，同名完全可能（`id` 那一格仍然显示短名）。
          id: p.id, key: 'q:' + p.id, label: p.id, note: p.description,
          on: p.enabled !== false,
          group: t('prompts.group.quick'),
          // 与面板那颗开关同一条 op（`quickprompt-toggle`）：只改 `meta.json` 里那一个布尔，
          // 正文与备注一个字不动。含义是"这条还出现在不在 `/` 的贴文字段里"。
          run: function (next) { return apiCall('quickprompt-toggle', { id: p.id, enabled: next }) },
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
    function slashState() {
      const entries = new Map()
      const overrides = new Map()
      const overrideKey = function (domainKey, itemKey) { return domainKey + '/' + itemKey }
      const clearOverrides = function (domainKey) {
        const prefix = domainKey + '/'
        for (const key of Array.from(overrides.keys())) if (key.indexOf(prefix) === 0) overrides.delete(key)
      }
      const read = function (domain, force) {
        const key = domain.key
        const hit = entries.get(key)
        if (!force && hit && hit.promise) return hit.promise
        if (!force && hit && !hit.promise && Date.now() - hit.at < SLASH_CACHE_TTL_MS) return hit.value
        const promise = Promise.resolve().then(domain.load).then(function (value) {
          clearOverrides(key)
          entries.set(key, { at: Date.now(), value: value })
          return value
        }, function (error) { entries.delete(key); throw error })
        entries.set(key, { promise: promise })
        return promise
      }
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
      const unmark = function (keys) { for (const key of keys) overrides.delete(key) }
      const flush = function () { entries.clear() }
      return { read: read, effective: effective, mark: mark, unmark: unmark, flush: flush }
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
        const state = slashState()
        const sectionTitle = function () { return t('slash.section.tools') }
        // 每次候选都现取一份域表（域名跟着宿主语言走），但「快捷提示词要不要并进提示词域」这个
        // 决定来自启动时读到的那颗开关 —— 三处调用点（候选 / 面包屑 / 点选）必须用同一个判断，
        // 否则面包屑会指到一个候选里根本不存在的域。
        const domainOpts = { quickPrompts: cfg.quickPrompts !== false }
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
         * 为什么必须有它：宿主要么按 query 变化、要么按它自己的目录失效才重取候选，而我们的
         * `state.flush()` 只是把自家缓存清空 —— 菜单没再问，屏幕上就还是**上一次那份快照**：
         * 条目多寡跟着旧状态走（目录刚关掉、里面十几条还列着；刚开、那几条又不见了），勾翻过来了
         * 列表却没换。乐观覆盖管的是"状态"，管不了"这一屏该有哪些行"。菜单已经关了它就是空操作。
         */
        function refreshAfterWrite(sessionId) {
          try {
            const controller = controllerOf(sessionId)
            if (controller && typeof controller.refreshOpenMenu === 'function') controller.refreshOpenMenu()
          } catch (e) { /* 刷不动只是这一屏晚一拍，改动本身已经生效 */ }
        }

        /**
         * 点完把菜单留在这一层（纪律④）。
         *
         * 宿主的 `settle()` 对非下钻选取一律先关菜单，所以这里在微任务里用官方口重开：
         * `sessions.scope(sessionId)` → `inputTriggers.sessionOf(scope)` → `controller.toggleSource`
         * （宿主自己那个 `/` 菜单启动按钮走的就是同一条口，见 dsh-client-ui-conversation 的
         * toggleCommandMenu）。
         *
         * 两处必须照实做，否则会以更难看的方式坏：
         *   · `span.draftRev` **现取**（`conversation.input.for(scope).state`）—— 宿主拿它做 CAS，
         *     差一位下一次点击就被静默拒掉（点了没反应，还查不出原因）；
         *   · 取到之后核对草稿里确实是刚写回的那串，对不上就什么都不做。
         * 任何一步拿不到都只是退回"点完关菜单"，不能把功能本身带坏。
         */
        function keepOpen(sessionId, query, spanStart) {
          if (!sessionId || typeof spanStart !== 'number') return
          try {
            const scope = ctx.sessions && typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined
            if (!scope) return
            const service = ctx.get('inputTriggers')
            const controller = service && typeof service.sessionOf === 'function' ? service.sessionOf(scope) : undefined
            if (!controller || typeof controller.toggleSource !== 'function') return
            // 宿主自己已经把它重开了 —— 再 toggle 一次就是关掉，正好相反。
            if (controller.launcher && typeof controller.launcher.getSnapshot === 'function'
              && controller.launcher.getSnapshot() === SLASH_SOURCE_NAME) return
            const conversation = ctx.get('conversation')
            const input = conversation && conversation.input && typeof conversation.input.for === 'function'
              ? conversation.input.for(scope) : undefined
            const st = input && input.state && typeof input.state.getSnapshot === 'function' ? input.state.getSnapshot() : undefined
            if (!st) return
            const text = '/' + query
            const span = { start: spanStart, end: spanStart + text.length, draftRev: st.draftRev }
            if (String(st.draft || '').slice(span.start, span.end) !== text) return
            controller.toggleSource(SLASH_SOURCE_NAME, {
              trigger: '/', query: query, quoted: false, position: 'leading', span: span,
            })
          } catch (e) { /* 重开失败只是少一次连点，这次改动本身已经生效 */ }
        }

        /** 摘要要单独等：域行不能因为一次读失败就不出现（那样整段会凭空消失，看起来像坏了）。 */
        async function domainRows(domains, query) {
          const picked = domains.filter(function (d) {
            if (!query) return true
            const q = query.toLowerCase()
            return d.token.toLowerCase().indexOf(q) >= 0 || d.label.toLowerCase().indexOf(q) >= 0
          })
          return Promise.all(picked.map(async function (d) {
            let description = ''
            try {
              const data = await state.read(d)
              description = data.summaryOf(state.effective(d, data.items)) || ''
            } catch (e) { description = '' }
            return {
              name: d.token, label: d.label, icon: SlashOffIcon, drill: true,
              ...description ? { description: description } : {},
              section: sectionTitle(), value: d.key,
            }
          }))
        }

        /** 叶子行（下钻后的某域条目）。 */
        async function leafRows(domain, rest) {
          let data
          try {
            data = await state.read(domain)
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
          hit.sort(function (a, b) {
            const ga = order.get(a.group || domain.label)
            const gb = order.get(b.group || domain.label)
            if (ga !== gb) return ga - gb
            // 目录行是这一组的总开关，跟着状态跳到别处就找不着了，所以永远钉在本组第一行。
            const fa = a.first === true ? 0 : 1
            const fb = b.first === true ? 0 : 1
            if (fa !== fb) return fa - fb
            if (a.on !== b.on) return a.on ? -1 : 1
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
              description: note || (item.on ? t('slash.state.on') : t('slash.state.off')),
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
            // 只在行首提供：`帮我看看 /tool` 这种半路打出来的 `/` 不该弹我们的东西。
            if (req.position !== 'leading') return []
            const domains = domainsOf()
            const query = req.query || ''
            const at = query.indexOf('/')
            if (at < 0) return domainRows(domains, query)
            const token = query.slice(0, at)
            const domain = domains.filter(function (d) { return d.token === token })[0]
            if (!domain) return []
            return leafRows(domain, query.slice(at + 1))
          },
          header(session, req) {
            const query = req.query || ''
            if (query.indexOf('/') < 0) return undefined
            const domain = domainsOf().filter(function (d) { return query.indexOf(d.token + '/') === 0 })[0]
            if (!domain) return undefined
            // **不看 req.drilled**：宿主在每次"非下钻"的选取后都会把这个标记清掉
            // （input-trigger client.js 的 `this.drilled = action === 'drill'`），而叶子选取正是
            // 非下钻 —— 用它当判据的话，勾第一次开关之后面包屑就没了，"返回上一级"跟着消失。
            // 官方的 @file 源可以只认 drilled（打字打出来的路径草稿里自带上下文），这里不行。
            return [
              { label: sectionTitle(), value: '/tool-' },
              { label: domain.label, value: '/' + domain.token + '/', current: true },
            ]
          },
          onPick(pick) {
            const candidate = pick.candidate
            const value = candidate.value
            if (typeof value !== 'string' || value === '') return undefined
            const sessionId = pick.session && pick.session.sessionId
            const spanStart = pick.span && typeof pick.span.start === 'number' ? pick.span.start : undefined
            /** 写回 token 并把菜单留在这一层（`inserted` 含前导 `/`，宿主要的是替换整个 token 段）。 */
            const stayAt = function (inserted) {
              const query = inserted.slice(1)
              Promise.resolve().then(function () { keepOpen(sessionId, query, spanStart) })
              return { text: inserted, continue: true }
            }
            // 面包屑：value 就是"回到那一层"要写回的 token（官方语义：回到上层与深入一层是同一个出口）。
            if (value.charAt(0) === '/') return stayAt(value)
            // 域行：原地进入该域。宿主只在点行右侧 › 或按 Tab 时发 action:'drill'，点整行发的是
            // 'pick'（MenuView 的行渲染），所以这里不看 action —— 点哪都该进去。
            if (candidate.drill === true) return stayAt('/' + String(candidate.name) + '/')
            let target = null
            try { target = JSON.parse(value) } catch (e) { return undefined }
            if (!target || !target.domain || target.key === undefined) return undefined
            const domain = domainsOf().filter(function (d) { return d.key === target.domain })[0]
            if (!domain) return undefined
            // 回到本域根 + 菜单不关（纪律④）：执行是异步的，所以先叠一份乐观状态再发请求。
            state.read(domain, true).then(function (data) {
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
                  showPluginToast(res && res.error ? translateError(t, res) : t('slash.err.failed'), 'err')
                  return
                }
                // 写成功后清缓存 + 让菜单重取一次：下一次候选读到真值，覆盖表随之让位（宿主的写
                // 在返回前已经把自己那份快照失效掉了，重读拿到的就是新状态）。
                state.flush()
                refreshAfterWrite(sessionId)
                const warn = stateSyncWarn(t, res) || sceneSyncWarn(t, res)
                showPluginToast(warn ? joinWarn(item.done(next), warn) : item.done(next), warn ? 'warn' : 'ok')
              })
            }).catch(function (e) {
              showPluginToast(errMsg(e), 'err')
            })
            return stayAt('/' + domain.token + '/')
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
        const quickCache = { at: 0, promise: null, rows: null }
        function quickPrompts() {
          if (quickCache.promise) return quickCache.promise
          if (quickCache.rows && Date.now() - quickCache.at < QUICK_TTL_MS) return Promise.resolve(quickCache.rows)
          quickCache.promise = apiCall('quickprompt-list', {}).then(function (res) {
            quickCache.promise = null
            if (!res || res.ok !== true) throw new Error(translateError(t, res) || t('slash.err.failed'))
            quickCache.at = Date.now()
            quickCache.rows = res.prompts || []
            return quickCache.rows
          }, function (e) { quickCache.promise = null; throw e })
          return quickCache.promise
        }
        const quickSource = {
          trigger: '/',
          name: QUICK_SOURCE_NAME,
          order: 3,
          showGroupTitle: false,
          async candidates(session, req) {
            if (req.position !== 'leading') return []
            const query = String(req.query || '')
            // 只列一层：带 `/` 的草稿（`/tool-skill/…`）不是这一段的 token。
            if (query.indexOf('/') >= 0) return []
            let rows
            try { rows = await quickPrompts() } catch (e) {
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
        scope.effect(function () {
          return function () {
            unregisters.forEach(function (off) { try { off() } catch (e) { /* 撤不掉只是多留一个源，不影响界面 */ } })
            setSlashMount('unregistered')
          }
        })
      })
    }
