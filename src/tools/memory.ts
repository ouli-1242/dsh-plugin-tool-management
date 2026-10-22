// 记忆（rules）域的 model 工具（2026-09-19 从 index.ts 的注册区抽出；2026-09-23 改名合并、
// 同日把场景能力分出去）：memory_manager_list / _read / _switch / _save。
//
// 为什么族名在 0.14.0 里绕了一圈回到 `memory_manager_`：中途改成 `scene_memory_manager_`
// 是为了跟注入段名（`scene-memory-manager-catalog`）对齐，但那个名字描述的是**域**，
// 而这个族操作的全是记忆。加场景能力时这个错配就现形了 —— 场景是另一个对象（容器，
// 进入时切换 mcp / 技能 / 人设），硬塞进 `save` 会让 `description` 变成双义参数（给
// `memory` 时是记忆描述、给 `scene` 时是场景描述），门禁也得按参数分叉（记忆写入有开关
// 可放行，场景写入是改运行时环境、不该有那条路）。所以拆成两族：这里管记忆内容，
// `scene_manager_*`（tools/scene.ts）管场景本身。
//
// 场景清单也不挂在这条 list 的尾巴上（同日第四轮裁定：「记忆就管记忆，场景就管场景」）——
// 它在 `scene_manager_list`，理由记在 tools/scene.ts 头部，别当"少写了一段"再加回来。
//
// 为什么 write + update 并成 save：两者的判定（同名 = 改、无同名 = 建）本来就只有
// `rules-create` 知道 —— 它对同名是**拒绝**的，op 层不会替你 upsert。分开两条工具时，
// 模型必须自己先查一次再决定调哪条，而它手里的清单可能已经过期。合并后由工具侧兜住。
//
// 活动场景的记忆正文会自动注入上下文（无需调用工具读取）；这里的工具用于查询/编辑规则
// 本身。memory_manager_save 受 tools/pre-execute 审批门禁（D2）。
// 路径锚点：$DSH_HOME/tool-management/memories/<场景>/…（场景 `global` = 界面「全局」）。

import { effectiveScope, globalActionNote, isolationOffNote, scopeOnlyNote, scopeSessionDesc, sessionScopeOf, text, type ToolDomainDeps } from './deps.js'

export interface MemoryToolDeps extends ToolDomainDeps {
  /** rules service 的 ops 表：rules-list / rules-read / rules-create / rules-update / rules-toggle。 */
  rulesOps: Record<string, (args: any) => Promise<any>>
}

export function buildMemoryTools(deps: MemoryToolDeps): void {
  const { defineTool, register } = deps
  register(defineTool({
    name: 'memory_manager_list',
    // 末尾**不点名** `scene_manager_list`：场景一族在出厂默认里就是关着的，指向一条模型没有的
    // 工具只会让它去猜名字（用户 2026-09-23 把默认名单扩到十五条时去掉的这句）。
    description: 'List memories (id, scene, enabled, form flat|bundle, description) plus the scene the injection follows. What is injected each turn is in the "Current memories" reminder; use this for ids and for entries that are off. Pass `scene` to filter; all=true lists everything.',
    parameters: {
      // 参数名与其余五个域同词（2026-10-14 对抗性审查 P1-3）：同一个概念在工具面只该有一个名字，
      // 而 `scene` 是它在 `scene_manager_*`、`<scene>/<name>` 与注入段标题里的叫法。
      // op 的内部契约字段仍是 `group`（`rules-list` 与界面侧调用方都读它），所以 execute 里
      // 显式映射一次 —— 改 op 的字段名要动界面，那不是这一条能顺手做的事。
      scene: { type: 'string', description: 'Optional scene filter; `global` is the always-on scene.' },
      all: { type: 'boolean', description: 'Include memories that are off, in an inactive scene, or shadowed (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      // `scene` → `group`：只把 op 认的那个字段传过去，别把 `scene` 也塞给它（它不认）。
      const opArgs: any = {}
      if (args && args.scene !== undefined) opArgs.group = args.scene
      // 会话层（0.21.2，计划 §8.2「memory_manager_list 只列本会话场景」）：带上 sessionId，
      // op 就按本会话钉住的场景与逐条开关投影 —— 「会注入」这一栏与模型真实看到的一致。
      // 取不到会话 = 不给，op 退回全局口径（不报错）。
      const scoped = sessionScopeOf(deps, exec && exec.agent)
      if (scoped !== null) opArgs.sessionId = scoped.sessionId
      const r: any = await deps.rulesOps['rules-list'](opArgs)
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read memories')
      // 「会注入」的判定与记忆段同源（renderSceneMemory）：global 场景恒常注入，其余场景要
      // 在 index.active 里，再叠加单条 enabled 与同名 bundle 的 shadowed。默认只列这些，
      // 全列一次会把没启用的条目也算进上下文（用户裁定 2026-09-16，与技能列表同口径）。
      const sceneOn = (group: string): boolean => group === 'global' ||
        (group !== '' && (r.activeMode === 'all' || String(r.activeScene || '') === group))
      const stateOf = (x: any): { injects: boolean; label: string } => {
        if (x.shadowed === true) return { injects: false, label: 'shadowed' }
        if (x.enabled === false) return { injects: false, label: 'disabled' }
        if (!sceneOn(String(x.group || ''))) return { injects: false, label: 'scene off' }
        return { injects: true, label: 'injects' }
      }
      const rows: Array<{ x: any; injects: boolean; label: string }> =
        (r.rules || []).map((x: any) => ({ x, ...stateOf(x) }))
      const shown = showAll ? rows : rows.filter((row) => row.injects)
      const lines = shown.map(({ x, label }) => (
        '- ' + x.id + ' [' + (x.group || 'no scene') + '] ' + label +
        // 形态与附件（2026-10-15）：此前不报，模型分不清哪条是 bundle、更不知道它带了几个附件
        // （`rules-list` 早就把 `form` 与 bundle 的附件摘要给了出来，只是这里没渲染）。
        (x.form === 'bundle'
          ? ' · bundle' + (x.attach && x.attach.count ? ' (' + x.attach.count + ' attachment(s))' : '')
          : '') +
        (x.description ? ' — ' + x.description : '')
      ))
      // 注入按哪个场景走 —— 上面那句「场景未启用」只有配上它才可解读：少了这一行，
      // 模型看到一片"未启用"会以为是条目自己的问题。（场景本身的清单在 `scene_manager_list`，
      // 2026-09-23 拆过去了；这里只留"记忆按哪一集注入"，因为那是记忆域自己的现状。）
      const scope = r.activeMode === 'all'
        ? 'every scene (historical default, not narrowed)'
        : (r.activeScene ? '"' + String(r.activeScene) + '"' : 'no scene is on')
      // 会话层（0.21.2）：本会话钉了场景 / 改了个别开关时，上面那行报的是**本会话**的投影，
      // 与全局可能不同。不说清的话，模型会拿这份名单去回答"全局现在是什么" —— 那是错的答案。
      const sessionNote = scoped === null || scoped.scope === undefined
        ? ''
        : '\nthis is the view here (this conversation, or its whole workspace under per-workspace isolation)' +
          (scoped.scope.scene !== undefined ? ' — scene pinned to "' + scoped.scope.scene + '"; the machine-wide scene may differ' : '') +
          (scoped.scope.memory !== undefined ? '; ' + Object.keys(scoped.scope.memory).length + ' switch(es) applied here' : '')
      const header = 'memories: ' + (showAll
        ? rows.length + ' total'
        : shown.length + ' injecting / ' + rows.length + ' total' +
          (shown.length === rows.length ? '' : ' (pass all=true for all)')) +
        '\ninjects from: ' + scope + ' + global (global always injects)' + sessionNote + '\n'
      // 注入边界：压制型预设（persona complete / 关闭运行时上下文）下本插件默认不注入，
      // 此时列出的记忆**不在**模型上下文里。必须说出来，否则模型会假设自己已经看到正文。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + (lines.join('\n') || '(none)') + notice
    },
  }))
  register(defineTool({
    name: 'memory_manager_read',
    // "dropped by the byte budget" 改成"left out of it"（2026-10-15 注入文本审查）：byte budget
    // 是本插件内部术语，模型没有这个概念 —— 它只知道"这条在不在我上下文里"。说内部机制
    // 等于让它去猜一个它观测不到的量。
    description: 'Read one memory\'s full body, its form (flat|bundle) and its attachment names. Only for ones not already in your context (disabled, in an inactive scene, or left out). Attachment contents are not returned — use your file tools.',
    parameters: {
      memory: { type: 'string', required: true, description: 'Memory id like <scene>/<name>.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      // op 的字段名是 `id`，不改 op：这里显式转换（键名对模型是 `<场景>/<名字>`，对 op 是 `id`）。
      const r: any = await deps.rulesOps['rules-read']({ id: String((args && args.memory) || '') })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read memories')
      const rule: any = r.rule || {}
      // 形态与附件名（2026-10-15）：op 一直把 `attachments` 给了出来，这里此前**整个丢掉**，
      // 于是模型连"这条记忆是 bundle、带了 3 个附件"都看不到。只给名字不给内容 ——
      // 附件可能是图片或大 md，全文塞回来会吃光这一轮的上下文（与注入段附件行同口径）。
      const attach: any[] = Array.isArray(rule.attachments) ? rule.attachments : []
      const form = rule.form === 'bundle' ? 'bundle' : 'flat'
      const attLine = attach.length
        ? '\nattachments (' + attach.length + '): ' + attach.map((a: any) => String((a && a.name) || a)).join(', ')
        : ''
      // 会话层（0.21.2）：这条记忆在本会话是关着的（或不在本会话钉住的场景里）时，读得到
      // 正文 ≠ 它会进上下文。不说清的话，模型会以为自己已经掌握了它、下一轮却看不到。
      const scoped = sessionScopeOf(deps, exec && exec.agent)
      const over = scoped?.scope?.memory?.[String(rule.id)]
      const offHere = over === false
        ? '\n(switched off here only — the body above is not injected here; the global setting is unchanged) '
        : ''
      return '# ' + rule.id + ' (' + form + ')' + attLine + '\n\n' + (rule.body || '') + offHere
    },
  }))
  register(defineTool({
    name: 'memory_manager_switch',
    // 为什么叫 `_switch` 而不是 `_set_enabled`（2026-09-23 用户裁定）：六个域里"拨一个开关"
    // 是同一件事，名字该同形 —— `mcp_manager_switch` 早就是这个名字，`_set_enabled` 只剩
    // 记忆 / 技能 / 人设三族在叫。**参数保留 `enabled` 布尔**：这里没有 `restart` 那第三个
    // 动词，`action: 'on' | 'off'` 只会在 `true`/`false` 之上多一层映射、多付一段 schema。
    // 旧名不注册别名（同 0.14.0 的口径：注册就进工具表、就要付 token）；用户的旧设置由
    // `tools/table.ts` 的 `LEGACY_TOOL_NAME_MAP` 翻译。
    //
    // 为什么单独一个工具：注入实况里「这个域注入了几次 / 模型调了几次」都看得到，但模型此前
    // 看得到一份记忆却开关不了它 —— 只能回一句"请你去界面上点"。启停是它替用户调整环境时
    // 最常碰的一格，而 `rules-toggle` 这个 op 早就带齐了门禁（写令牌 + 场景冻结）。
    // 三个写侧工具共用一句 consent（`Only when the user asks or approves.` / `Only on the
    // user's instruction.`）：这些动的都是"以后每一轮都会带上"的东西，模型不该顺手做。
    // 描述同时按"省 token"重写了一遍 —— 这几段文字每次请求都要发出去，废话是常驻成本。
    // 后半句"freeing the byte budget"删掉（2026-10-15 注入文本审查）：byte budget 是本插件
    // 内部术语，模型据此做不了任何判断 —— "不再被注入"已经是它需要的全部因果。
    description: 'Enable or disable one memory. Disabled memories stop being injected. Reversible. Only when the user asks or approves.',
    parameters: {
      memory: { type: 'string', required: true, description: 'Memory id like <scene>/<name>.' },
      enabled: { type: 'boolean', required: true, description: 'true = enable, false = disable.' },
      // 决策 10（2026-10-19）：默认只改**这个对话**。写全局要显式说明。
      scope: { type: 'string', enum: ['session', 'global'], description: scopeSessionDesc('global = every conversation (the memory index).') },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const memory = String((args && args.memory) || '')
      // `enabled` 必须是布尔：`rules-toggle` 缺了它直接拒（ops/memory.ts），但那是给用户看的
      // 中文 op 错；这里先挡一句说清"这条工具要什么"。
      if (typeof (args && args.enabled) !== 'boolean') throw new Error('missing argument: enabled must be true or false')
      // 场景锁冻结的是**全局**写入（决策 11）：会话覆盖写的是侧车，与锁无关 ——
      // 与面板的 `scopeWriteLocked()` 同一口径。只有全局那条路才过守卫。
      // 全局粒度下 `effectiveScope` 一律返回 global：那一档没有会话层，写的就是索引本身。
      const scope = effectiveScope(deps, args)
      const sessionOnly = scope === 'session'
      if (!sessionOnly) {
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
      }
      // 决策 10：默认写**本会话**（别的对话不受影响），`scope: "global"` 才改索引。
      // 会话层只改"注入不注入"，不碰索引里那条记录 —— 所以不需要场景档案同步。
      if (sessionOnly) {
        if (!deps.sessionScopeSet) throw new Error('per-conversation switches are unavailable in this host: pass scope="global" to change it for every conversation')
        const sc = await deps.sessionScopeSet(exec && exec.agent, 'memory', memory, args.enabled === true)
        if (!sc || sc.ok === false) throw new Error((sc && sc.error) || 'failed to switch this memory here')
        return 'OK: ' + memory + ' now ' + (args.enabled ? 'enabled' : 'disabled') + scopeOnlyNote() +
          (sc.cleared === true ? ' (that matches the global setting, so the per-conversation override was removed)' : '') +
          '. The global setting is unchanged; other conversations keep theirs. Pass scope="global" to change it for every conversation.'
      }
      const r: any = await deps.rulesOps['rules-toggle']({ id: memory, enabled: args.enabled })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to switch this memory')
      const rule = r.rule || {}
      // 「启用了一条不在启用场景里的记忆」是一次静默无效：单条开关拨上去了，注入集里却没有它。
      // 这一句不说，模型会以为已经生效 —— 与 skill_manager_switch 说清影子副本同一条理由。
      let sceneNote = ''
      try {
        const all: any = await deps.rulesOps['rules-list']({})
        if (all && all.ok !== false) {
          const group = String(rule.group || '')
          const on = group === 'global' || (group !== '' && (all.activeMode === 'all' || String(all.activeScene || '') === group))
          if (!on) sceneNote = ' — BUT its scene "' + group + '" is not the one injecting, so it still will not be injected; turn that scene on (or move it to global) first'
        }
      } catch { sceneNote = '' }
      return 'OK: memory ' + String(rule.id || memory) + ' ' + (rule.enabled === false ? 'disabled' : 'enabled') + sceneNote + isolationOffNote(deps)
    },
  }))
  register(defineTool({
    name: 'memory_manager_save',
    // 「能推导的别记」「先查重」这两句是 0.13.0 加的：记忆是唯一直接吃注入预算的域
    // （场景段 128 KiB），而模型很乐意把「这个项目用 pnpm」记一条 —— 那看一眼 `package.json`
    // 就知道，记下来却永久占着每一轮请求。合并 write/update 后这两句更要留：upsert 降低了
    // "再记一条"的摩擦，而摩擦正是这里唯一拦得住它的东西。
    description: 'Create a memory, or update the one with this id — the receipt says which. Memories cost context on every later request: record only what cannot be re-derived from code, config or git, and update an existing one rather than adding a near-duplicate. Blocked while the active scene is locked. Only on the user\'s instruction.',
    parameters: {
      memory: { type: 'string', required: true, description: 'Memory id like <scene>/<name> — copy it from the list. `global` is the always-on scene.' },
      description: { type: 'string', description: 'One-sentence description (<=500 chars). Required when creating. Empty string = drop it and re-derive from the body; omit = keep.' },
      body: { type: 'string', description: 'Markdown body (<=256 KiB). Required when creating. Omit to keep the current body.' },
      // 不再承诺「旧文件进回收站」（2026-10-14 对抗性审查 P0-3）：bundle 记忆改名走的是
      // 「只重写正文、目录不动」那条路，一个字都不进回收站 —— 对 bundle 说进回收站是假话。
      // 与上一轮 P1-1 同口径：**只说可逆，不说实现细节**。
      nextName: { type: 'string', description: 'New memory name (= file name); omit to keep it.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const memory = String((args && args.memory) || '').trim()
      // 拆成 `<场景>/<名字>`：要求两段都非空。**不做"没有斜杠就落 global"的兜底** —— 那会把
      // 一次拼错的 id 变成一条"每轮都注入"的全局记忆，而清单上看起来完全正常。
      // 清单里打印的就是 `<场景>/<名字>`，照抄比拼装准（§2 规则一）。
      const slash = memory.indexOf('/')
      if (slash <= 0 || slash === memory.length - 1) {
        throw new Error('memory must be <scene>/<name> (copy that from the listing; the always-on scene is written global/<name>): ' + (memory || '(empty)'))
      }
      const group = memory.slice(0, slash)
      const name = memory.slice(slash + 1)
      // 先取全量：既用来定位（命中 = 改、未命中 = 建），也是查重的数据源。判定必须在工具
      // 这一侧 —— `rules-create` 对同名是**拒绝**的（`error.rules.exists`），op 不会 upsert。
      const all: any = await deps.rulesOps['rules-list']({})
      if (!all || all.ok === false) throw new Error((all && all.error) || 'failed to read memories')
      const hit = (all.rules || []).find((x: any) => String(x.id) === memory)

      if (hit) {
        // 改的分支一律 read-modify-write（省略 = 保持），因为 `rules-update` 是整份重写。
        // 三个可改字段一个都没给就拒：op 会按"保留现有"落一次盘并刷新 updatedAt，
        // 模型以为改了点什么，其实只是把文件重写了一遍。
        const touched = ['body', 'description', 'nextName'].filter((k) => (args as Record<string, unknown>)[k] !== undefined)
        if (!touched.length) throw new Error('nothing to change: give at least one of body / description / nextName')
        const payload: any = { id: memory }
        // 只带模型真给过的键：`description` 传空串在 op 里是"删除并重新派生"，与"未给"是两种
        // 意图，都必须原样透传 —— 所以用 `!== undefined` 而不是真值判断。
        if (args.body !== undefined) payload.body = args.body
        if (args.description !== undefined) payload.description = args.description
        if (args.nextName !== undefined) payload.name = args.nextName
        const r: any = await deps.rulesOps['rules-update'](payload)
        if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to update the memory')
        const rule = r.rule || {}
        return 'OK: updated ' + String(rule.id || memory) + ' (changed ' + touched.join(', ') + ')' +
          (rule.id && String(rule.id) !== memory ? ' → now ' + rule.id : '')
      }

      // 建的分支：正文与描述都必填。`rules-create` 自己会拒空正文与非法名（ops/memory.ts），
      // 但那是给用户看的中文 op 错；模型需要的是"这条工具要什么"，所以在工具侧先挡、点名缺哪个。
      const body = args && args.body !== undefined ? String(args.body) : ''
      const description = args && args.description !== undefined ? String(args.description) : ''
      const missing = [
        body.trim() === '' ? 'body' : '',
        description.trim() === '' ? 'description' : '',
      ].filter((x) => x !== '')
      if (missing.length) throw new Error('creating a memory needs ' + missing.join(' and ') + ' (' + memory + ' does not exist yet)')
      // 查重只**说出来**，不拒绝 —— 猜错一次就把该记的东西记不下去，比多记一条代价大得多；
      // 而且"像不像同一条"本来就是人判断的事。只在建的分支提示：改的分支没有"再记一条"的风险。
      const norm = (value: unknown): string => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
      const wantName = norm(name)
      const wantDesc = norm(description)
      const similar: string[] = (all.rules || [])
        .filter((x: any) => {
          const have = norm(x.name)
          const desc = norm(x.description)
          if (have === wantName) return true
          if (wantDesc !== '' && desc !== '' && desc === wantDesc) return true
          // 名字互相包含：只在两边都不短于 4 个字符时算，否则 "git" 会把所有条目都匹配上。
          return have.length >= 4 && wantName.length >= 4 && (have.includes(wantName) || wantName.includes(have))
        })
        .map((x: any) => String(x.id))
        .slice(0, 3)
      const r: any = await deps.rulesOps['rules-create']({ group, name, description, body })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to create the memory')
      // 刚建好的这条自己会在列表里，从名单里去掉。
      const dup = similar.filter((id) => id !== String(r.rule.id))
      const warn = dup.length
        ? `\nnote: ${dup.length} existing memories have a similar name or description (${dup.join(', ')}) — if it is the same thing, update that one instead of keeping two.`
        : ''
      // 回执必须同时说清**两个**条件（2026-10-15 smoke-test P1-3）：新建的记忆在 op 层是
      // `enabled: false`（ops/memory.ts 的 rulesCreate），而原先这句只提场景 —— 读起来像
      // "场景一开它就自动生效"，模型据此以为已经生效，实际还差一次开关。与 skill_manager_save
      // 的 enableHint 同一形状：点名的工具在出厂默认名单里是关着的，关着就改说"用户开启后"。
      // 「会不会注入」按**本会话**的投影判（0.21.2）：会话钉了别的场景时，这条记忆落进的
      // 那个场景在这个对话里根本没开着 —— 照全局口径回一句"打开就能用"是错的答案。
      const scoped = sessionScopeOf(deps, exec && exec.agent)
      const effScene = scoped?.scope?.scene
      const activeNow = effScene === undefined ? all.activeScene : effScene
      const activeMode = effScene === undefined ? all.activeMode : 'custom'
      const sceneActive = group === 'global' ||
        (group !== '' && (activeMode === 'all' || String(activeNow || '') === group))
      const sceneTail = sceneActive ? '' : ', and turn scene "' + group + '" on'
      const enableHint = deps.toolVisible('memory_manager_switch')
        ? ' (created disabled — turn it on first with memory_manager_switch' + sceneTail + ')'
        : ' (created disabled — the user has to turn it on first' + sceneTail + ')'
      // 会话层：这条记忆写的是**磁盘上的那一份**（所有对话共用），本会话的开关只决定
      // "这里看不看得到"。模型据此回一句"记下了"时，用户很容易读成"只在这个对话里"。
      return 'OK: created ' + r.rule.id + enableHint + warn +
        globalActionNote(deps, exec && exec.agent, 'memory', 'memory')
    },
  }))
}
