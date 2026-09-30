        function memoryView(data, q, sceneFilter) {
          function matchRule(r) {
            if (sceneFilter !== '' && sceneOfGroup(r.group) !== sceneFilter) return false
            if (!q) return true
            return (r.name || '').toLowerCase().indexOf(q) >= 0
              || (r.description || '').toLowerCase().indexOf(q) >= 0
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
          data.rules.forEach(function (r) {
            var g = String(r.group == null ? '' : r.group)
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
          return {
            buckets: buckets, order: order, sceneOptions: sceneOptions, sceneChoices: sceneChoices,
            filtering: filtering, visibleBuckets: visibleBuckets, hasAnyRule: data.rules.length > 0,
          }
        }