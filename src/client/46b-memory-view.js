        /**
         * @param data rules-list 的响应
         * @param q 搜索词（小写）
         * @param sceneFilter 场景筛选；空串 = 全部
         * @param ws 当前对话的工作区（`group` = `_ws/<hash16>`，`label` = 显示名）；
         *   只用于把**当前项目**排在最前，取不到时排最后。
         */
        function memoryView(data, q, sceneFilter, ws, t) {
          function matchRule(r) {
            if (sceneFilter !== '' && sceneOfGroup(r.group) !== sceneFilter) return false
            if (!q) return true
            return (r.name || '').toLowerCase().indexOf(q) >= 0
              // 搜索改用 `excerpt`（正文首行）：用户找一条记忆时记得的是正文里的说法，
              // 不是那条独立维护的 `description`。旧数据没有 `excerpt` 时退回 description。
              || (r.excerpt || r.description || '').toLowerCase().indexOf(q) >= 0
              || (r.group || '').toLowerCase().indexOf(q) >= 0
          }
          // 场景 → 记忆：场景元数据来自宿主 scenes（含**空场景**与保留场景 global），
          // 记忆按一级目录归位。没有归属场景的记忆（直接放在 memories/ 根层）也单独列出来，
          // 并在体检里报 noScene —— 不能让它既不在列表里、也不在提示词里。
          var buckets = {}
          var order = []
          function ensureBucket(name, meta) {
            if (!buckets[name]) { buckets[name] = { name: name, meta: meta, rules: [] }; order.push(name) }
            else if (meta && !buckets[name].meta) buckets[name].meta = meta
            return buckets[name]
          }
          ;(data.scenes || []).forEach(function (s) { ensureBucket(s.name, s) })
          // 工作区记忆（`_ws/<hash16>`）不是场景：单独收集，页面把它渲染成「工作区记忆」一张卡，
          // 卡内按工作区分节。混进场景桶会让页面多出一个叫 `_ws` 的假场景，用户点进去看到的
          // 是一堆按 hash 命名的目录。
          var wsRules = []
          // 宿主当前认的工作区 hash 集合。工作区记忆**只显示宿主还认的**：
          // 用户在宿主里删掉一个工作区后，它的记忆条目仍在盘上（我们不删用户数据），
          // 但宿主已经不认这个归属 —— 继续列出来等于让用户管理一批无处可归的记忆。
          // 工作区重新登记时（同一路径 → 同一个 hash），这些条目会**自动回来**，
          // 因为判据是 hash 在不在集合里，不是条目有没有被改过。
          //
          // 取不到 `workspaces` 时（老服务端）不隐藏：降级方向只能是多显示，
          // 不能凭一个缺失的字段就把用户的记忆整片藏掉。
          var liveWs = null
          if (Array.isArray(data.workspaces)) {
            liveWs = {}
            data.workspaces.forEach(function (w) {
              if (w && w.hash) liveWs[String(w.hash)] = true
            })
          }
          data.rules.forEach(function (r) {
            var g = String(r.group == null ? '' : r.group)
            if (g === '_ws' || g.indexOf('_ws/') === 0) {
              if (liveWs !== null && g.indexOf('_ws/') === 0) {
                var hash = g.slice('_ws/'.length).split('/')[0]
                if (liveWs[hash] !== true) return
              }
              if (matchRule(r)) wsRules.push(r)
              return
            }
            var b = ensureBucket(g === '' ? '' : sceneOfGroup(g), null)
            if (matchRule(r)) b.rules.push(r)
          })
          order.sort(function (a, b) {
            if (a === b) return 0
            var am = buckets[a].meta, bm = buckets[b].meta
            // 宿主给的 order（保留场景 global = 0，恒在最前）；无元数据的游离桶排最后。
            var ao = am && typeof am.order === 'number' ? am.order : 1e9
            var bo = bm && typeof bm.order === 'number' ? bm.order : 1e9
            if (ao !== bo) return ao - bo
            if (a === '') return 1
            if (b === '') return -1
            return String(a).localeCompare(String(b))
          })
          // 空的 `_shared`（界面「常开」）不列：它是历史保留场景，恒常注入、没有开关，
          // 一条记忆都没有时既不能管也不注入。此前它随磁盘目录一起出现在列表里，
          // 读起来就像"凭空多了一个和「全局」一样的常驻场景" —— 而真正恒常的只有 global。
          // 有内容的照常列（老用户的公共基线不能因此消失）。
          order = order.filter(function (n) { return !(n === '_shared' && buckets[n].rules.length === 0) })
          var sceneOptions = [{ value: '', label: t('memory.filter.all') }].concat(
            order.map(function (n) { return { value: n, label: sceneLabel(data.scenes, n) } }))
          // 场景选择：保留场景「全局」排最前（它是真实场景，不是「留空」）；
          // 游离桶只在真的存在游离记忆时才出现。
          var sceneChoices = order.map(function (n) { return { value: n, label: sceneLabel(data.scenes, n) } })
          // 空场景（含刚「新建场景」建好的空目录）必须列出来：否则它在页面上直接消失，
          // 卡片上的「新建记忆」入口也就点不到（只能靠顶部按钮再手填场景名）。
          // 只在搜索 / 场景筛选生效时按命中收敛，避免空卡片噪音。
          var filtering = q !== '' || sceneFilter !== ''
          var visibleBuckets = order.filter(function (n) {
            if (sceneFilter !== '' && n !== sceneFilter) return false
            if (!filtering) return true
            return buckets[n].rules.length > 0 || sceneFilter === n
          })
          // 工作区记忆按 group 分组（一个工作区一节），当前对话的工作区排最前 ——
          // 与自主记忆那张卡的分节顺序一致，两块看起来才是同一个项目。
          var wsByGroup = {}
          var wsGroups = []
          wsRules.forEach(function (r) {
            var g = String(r.group == null ? '' : r.group)
            var grp = wsByGroup[g]
            if (grp === undefined) {
              grp = wsByGroup[g] = { key: g, label: '', rules: [] }
              wsGroups.push(grp)
            }
            grp.rules.push(r)
            if (grp.label === '') grp.label = String(r.workspaceLabel || '')
          })
          var curWsLabel = String((ws && ws.label) || '')
          var curWsGroup = String((ws && ws.group) || '')
          // 工作区显示名：服务端 `rules-list` 的 `workspaces[]` 是权威（它读的是登记表），
          // 条目自带的 `workspaceLabel` 只覆盖自主记忆那一侧。两边都没有才退 hash 短码 ——
          // 那是「这个目录从没被登记过」时的兜底，不是正常显示。
          var wsLabels = {}
          ;(data.workspaces || []).forEach(function (w) {
            if (w && w.hash) wsLabels[String(w.hash)] = String(w.label || '')
          })
          wsGroups.forEach(function (grp) {
            var h = grp.key.indexOf('_ws/') === 0 ? grp.key.slice('_ws/'.length) : grp.key
            if (grp.label === '' && wsLabels[h] !== undefined) grp.label = wsLabels[h]
            if (grp.label === '' && grp.key === curWsGroup) grp.label = curWsLabel
            if (grp.label === '') grp.label = h.slice(0, 8)
          })
          wsGroups.sort(function (a, b) {
            var aCur = a.key === curWsGroup
            var bCur = b.key === curWsGroup
            if (aCur && !bCur) return -1
            if (bCur && !aCur) return 1
            return a.label.localeCompare(b.label) || a.key.localeCompare(b.key)
          })
          // 「新建记忆」的落点：全局 → 当前工作区 → 各场景。
          //
          // 工作区记忆是**用户自己写的资产**（与自主记忆那种 agent 缓存是两回事），必须能从
          // 「新增记忆」直接写出来 —— 否则用户只能先去工作区卡片的「新建」按钮，而那个按钮
          // 只在已经有同工作区条目时才出现（空卡不渲染），这条路径就断在第一次。
          //
          // 值用 `_ws/<hash16>`（服务端 `workspaceGroupOf` 认这个形状）。没有工作区上下文时
          // 不给这一项，也不退化成全局 —— 静默改落点会让用户以为写进了工作区。
          //
          // 声明必须在 `curWsGroup` 之后：`var` 只提升声明不提升赋值，提前读会拿到
          // `undefined`，`.slice` 当场抛错把整页渲染带崩。
          // 三档落点，与「生效层级」同一个交互：先选层级，再按层级给下拉。
          //
          // 工作区那一档**只列还活着的工作区**（`missing` 为真的不进落点）：往一个目录已经
          // 不存在的项目里写记忆，写进去也没人会读到。归档的同样不列；目录恢复后
          // `missing` 自然变回 false，它会重新出现在这里。
          //
          // 值仍用 `_ws/<hash16>`（服务端 `workspaceGroupOf` 认这个形状）。
          var wsChoices = (data.workspaces || [])
            .filter(function (w) { return w && w.hash && w.missing !== true })
            .map(function (w) {
              return { value: '_ws/' + String(w.hash), label: String(w.label || '') || String(w.hash).slice(0, 8) }
            })
          // 当前对话的工作区即使还没登记也要能选（第一次写记忆就是这种情况）。
          if (curWsGroup !== '' && !wsChoices.some(function (o) { return o.value === curWsGroup })) {
            wsChoices.unshift({ value: curWsGroup, label: curWsLabel !== '' ? curWsLabel : curWsGroup.slice('_ws/'.length, '_ws/'.length + 8) })
          }
          // 「场景」那一档**必须剔掉 `global`**：它已经单独占着「全局」这一档，
          // 留在里面会让 `scene[0]` 就是 `global` —— 用户点「场景」，`editor.group` 被填成
          // `global`，而 `kindOf('global')` 又判回 `global`，下拉当场跳回「全局」，
          // 看起来像点了没反应。`''`（未归属游离桶）同样不是新记忆该去的地方。
          var sceneTargetChoices = order
            .filter(function (n) { return n !== '' && n !== 'global' })
            .map(function (n) { return { value: n, label: sceneLabel(data.scenes, n) } })
          var createTargets = {
            levels: [
              { value: 'global', label: t('memory.level.global') },
              { value: 'workspace', label: t('memory.level.workspace') },
              { value: 'scene', label: t('memory.level.scene') },
            ],
            workspace: wsChoices,
            scene: sceneTargetChoices,
            kindOf: function (group) {
              var g = String(group || '')
              if (g === 'global') return 'global'
              return g.indexOf('_ws/') === 0 ? 'workspace' : 'scene'
            },
          }
          return {
            buckets: buckets, order: order, sceneOptions: sceneOptions, sceneChoices: sceneChoices,
            createTargets: createTargets,
            filtering: filtering, visibleBuckets: visibleBuckets, hasAnyRule: data.rules.length > 0,
            wsGroups: wsGroups, wsRules: wsRules,
          }
        }