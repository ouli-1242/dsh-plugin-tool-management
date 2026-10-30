// 技能域的 model 工具（从 index.ts 的注册区抽出；合并）：
// skill_manager_list / skill_manager_read / skill_manager_switch / skill_manager_save。
//
// create → save：`skill-create` 对同名是**拒绝**的，所以"建还是改"的判定只能在工具这一侧
// （先读一次 `skill-state`）。改的分支走新加的 `skill-update` op，它只认本插件可写的两个根
// （hub = 导入落点 / dsh = 新建默认落点）里的胜出者。

import { toKebab } from '../skills/core.js'
import { OFFICIAL_SOURCE_KEY, officeKitApplies, officialOfficeRuntimeSection } from '../skills/official.js'
import { effectiveScope, existingNote, globalActionNote, globalUnchangedNote, isolationOffNote, locateSkillRoot, requireGlobalScope, scopeGlobalOnlyDesc, scopeOnlyNote, scopeSessionDesc, sessionLayerOn, sessionScopeOf, text, type ToolDomainDeps } from './deps.js'

/** 技能工具域要的宿主能力：技能 op 表与来源解析。 */
export interface SkillToolDeps extends ToolDomainDeps {
  /** skills service 的 ops 表：skill-state / skill-enable / skill-disable / skill-create / skill-update。 */
  skillsOps: Record<string, (args: any) => Promise<any>>
}

/** 注册技能域的 model 工具（列表 / 启停 / 新建或更新）。 */
export function buildSkillTools(deps: SkillToolDeps): void {
  const { defineTool, register } = deps
  // 面向模型的技能工具：list / toggle / create。create 由下面的 tools/pre-execute 钩子把关
  //（写文件之前必须先问过用户）。
  register(defineTool({
    name: 'skill_manager_list',
    // 关于「官方 `skill` 工具挂载时这条读能力由谁提供」：两处都不写了。
    // 原先把它放在 `skill_manager_read` 的描述里，但那条工具在官方工具挂载时会被
    // `CARRIER_DUPLICATES` 直接隐藏 —— 能看到那句话的 agent，条件必然不成立；条件成立的
    // agent，看不到那句话。这条描述里再写一遍同样是白付 token。工具被隐藏本身就是最准确的信号。
    description: 'List skills with enabled state, effective/shadowed status and source file path. The "Current skills" reminder carries callable skills and summaries only; use this for entries that are off, for source paths, and to see which source wins a name collision — a copy marked "shadowed-by:<root>" stays inactive even if enabled, "preferred" marks the winner. Defaults to enabled only; all=true for every entry.',
    parameters: {
      all: { type: 'boolean', description: 'Include disabled and shadowed entries (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      // 会话层（`skill_manager_list` 按会话过滤）：
      //   · `sessionId` 让 op 只按**本会话的 cwd** 推导项目技能根（不给 = 全部活动会话的并集，
      //     两个对话看到同一份清单）；
      //   · `overrides` 是本会话的逐条开关，标出"全局开着、本会话关掉"的那几条。
      const scoped = sessionScopeOf(deps, exec && exec.agent)
      const r = await deps.skillsOps['skill-state'](scoped === null ? {} : { sessionId: scoped.sessionId })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'skill-state failed')
      const data: any = r.data || {}
      const overrides = scoped?.scope?.skills
      const flagOf = (domain: 'skills' | 'skillSources', key: string): boolean | undefined => {
        if (deps.sessionFlagOf === undefined || key === '') return undefined
        try { return deps.sessionFlagOf(exec && exec.agent, domain, key) } catch { return undefined }
      }
      // 同名（canonical = declaredName || name）跨根重复时只有**一份**生效，排序规则是
      // 「同名首选 > 来源优先级 rank」，**与启用状态无关**（core 的 groupLoadableSkillsByName）。
      // 于是「启用被覆盖的那份」是静默无效的：工具会回 OK，技能却依然不可用 —— 用户实测
      // 踩到的正是这个坑（同一技能在 dsh/agents/claude/custom 各有一份，启错根等于没启）。
      // 这里把生效/被覆盖如实标出来，让模型（和人）不必猜。
      //
      // 默认只列启用的：本机 36 条里只有 1 条启用，全列一次约 4.3k
      // 字符且永久留在 transcript。表头始终给出全量口径（多少条 / 多少同名组），所以
      // 「还有没列出来的」不会变成盲区 —— 要看就传 all=true。
      const rows: Array<{ root: string; text: string; enabled: boolean }> = []
      const counts = new Map<string, number>()
      for (const root of data.roots || []) {
        // 来源级停用 = 上层闸：里面的单条技能一条都加载不了。这一格也有会话层
        // （skillSources）：场景勾中的来源为开、没勾的为关；拨开一个来源时写侧会把它按
        // 租约跑起来（来源关着时技能级 enable 会被 core 吞掉）。
        const rootKey = String(root.key || '')
        const srcFlag = flagOf('skillSources', rootKey)
        // 没有会话层时落到**全局意图**（`globalOn`），不是运行态（`enabled`）：
        // 租约期间两者不同，读运行态会把"只为几个对话开着"报成"全局开着"。
        const rootEnabled = typeof srcFlag === 'boolean' ? srcFlag
          : (typeof root.globalOn === 'boolean' ? root.globalOn : root.enabled !== false)
        const rootLeases = typeof root.leaseCount === 'number' ? root.leaseCount : 0
        for (const skill of root.skills || []) {
          const key = String(skill.declaredName || skill.name || '')
          counts.set(key, (counts.get(key) || 0) + 1)
          // `enabled` 只写在「胜出者」上（core 的 markWinners）；影子副本与不可加载的技能
          // 没有这个字段。原先直接读 skill.enabled，这些技能一律被报成 disabled ——
          // 这里改用与界面同口径的兜底推导（client 的 isSkillEnabled）。
          const globalEnabled = skill.enabled !== undefined
            ? skill.enabled === true
            : (skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false)
          // 会话层：四层并值优先，键与档案 / 注入段逐字一致（`<rootKey>/<声明名>`）。
          const over = key === '' ? undefined : flagOf('skills', rootKey + '/' + key)
          // 这一层没说话时落到**全局意图**（`globalOn`），不是运行态：租约期间两者不同，
          // 读运行态会把"别的对话临时开着"报成"全局开着"（与上面来源那一格同一条）。
          const skillGlobal = typeof skill.globalOn === 'boolean' ? skill.globalOn : globalEnabled
          const enabled = rootEnabled && (typeof over === 'boolean' ? over : skillGlobal)
          // 带标签的 `k: v` 串：此前是无列头的 pipe 串，两个标记
          // （`shadowed by <root>` / `preferred`）还会挤在同一格里、都没有标签 —— 模型得猜哪段
          // 是字段、哪段是标记，以及 `preferred` 到底是什么（它此前**全仓没有定义**）。
          // 与 `mcp_manager_list` 的 `server:` / `level:` / `user-hint:` 同款。
          // 会话层：「本会话关掉 / 开启」必须与「全局停用 / 启用」分开说 —— 前者换个对话就回来了。
          const state = root.intent === 'blocked'
            ? 'source-stopped-machine-wide (overrides every conversation; ' + (rootLeases > 0 ? rootLeases + ' conversation(s) still wanted it' : 'no conversation is using it') + ')'
            : !rootEnabled
              ? 'source-off (the whole source folder is disabled' + (rootLeases > 0 ? '; kept running by ' + rootLeases + ' conversation(s)' : '') + ')'
              : typeof over === 'boolean'
                ? (enabled ? 'enabled-in-this-conversation (global: ' + (globalEnabled ? 'enabled' : 'disabled') + ')'
                  : 'off-here (global: ' + (globalEnabled ? 'enabled' : 'disabled') + ')')
                : (enabled ? 'enabled' : 'disabled')
          rows.push({
            root: String(root.key || ''),
            enabled,
            text: 'skill:' + (skill.name || skill.declaredName || '') + ' | root:' + (root.key || '') +
              ' | ' + state +
              (skill.shadowedBy && skill.shadowedBy.root ? ' | shadowed-by:' + skill.shadowedBy.root : '') +
              (skill.preferred === true ? ' | preferred' : '') +
              (skill.path ? ' | path:' + skill.path : ''),
          })
        }
      }
      const dupGroups = [...counts.values()].filter((n) => n > 1).length
      const shown = showAll ? rows : rows.filter((row) => row.enabled)
      // 会话层：项目技能根按**本会话的 cwd** 推导，所以这份清单可能只是这个对话
      // 看得到的那些。不说清的话，模型会拿它回答"本机装了哪些技能"。
      const sessionNote = scoped === null
        ? ''
        : ' (this scope\'s view: project roots come from its own cwd' +
          (scoped.scope?.scene === undefined ? '' : ', scene "' + scoped.scope.scene + '"') +
          (overrides === undefined ? '' : ', ' + Object.keys(overrides).length + ' switch(es) overridden here') + ')'
      const header = 'Skills: ' + (showAll
        ? rows.length + ' entries'
        : shown.length + ' enabled of ' + rows.length + ' entries') +
        (dupGroups ? ' · ' + dupGroups + ' duplicated names' : '') +
        (showAll || shown.length === rows.length ? '' : ' (pass all=true to include disabled and shadowed entries)') +
        sessionNote + '\n'
      // 注入边界：预设没挂 dsh-tool-skill（如极简）时官方技能目录不在，本插件的
      // 「技能目录」注入域会在开关打开时兜底（见上面的注入通道）；两者都没有时模型看到的
      // 只是这份名单 —— 说清边界，别让它以为上下文里已经有技能正文（正文用路径读）。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + (shown.map((row) => row.text).join('\n') || '(none)') + notice
    },
  }))
  // 一次拿到技能正文。此前读正文要两步：`skill_manager_list` 拿路径 → 自己再去读那个文件。
  // 少的那一步不只是省一次调用 —— 目录里只有名字没有路径，而**同名技能常几份并存**（dsh /
  // agents / claude / 自定义目录各一份），模型自己挑路径时很容易读到被覆盖的那份影子副本：
  // 读完以为在用这个技能，其实生效的是另一份。这里先走 `skill-state`（core 的 markWinners
  // 已在上面标出胜出者），再走 `skill-detail` 读那一份 —— 读到的永远是目录列出来的那一份。
  register(defineTool({
    name: 'skill_manager_read',
    description: 'Read one skill\'s full SKILL.md body by name (the reminder has names and summaries only). Also lists the other files in that skill folder (references/, scripts/), which the body often points at. Resolves name collisions the same way, so you get the copy actually in effect; pass root only to inspect a specific (e.g. shadowed) source.',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill name, exactly as it appears in the catalog (kebab-case).' },
      root: { type: 'string', description: 'Source root key (dsh/hub/agents/codex/claude, a project key, or a custom one). Default: the winning copy of this name.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const wanted = String((args && args.name) || '').trim()
      if (!wanted) throw new Error('name is required')
      const rootWanted = String((args && args.root) || '').trim()
      // 会话层：项目技能根按本会话的 cwd 推导 —— 与 skill_manager_list 同一份口径
      // 否则「列表里有、读不到」（两个对话的 cwd 不同时项目技能各有一份）。
      const scoped = sessionScopeOf(deps, exec && exec.agent)
      const overrides = scoped?.scope?.skills
      const state = await deps.skillsOps['skill-state'](scoped === null ? {} : { sessionId: scoped.sessionId })
      if (!state || state.ok === false) throw new Error((state && state.error) || 'skill-state failed')
      const data: any = state.data || {}
      type Hit = { rootKey: string; entryName: string; path: string; shadowedBy: string; preferred: boolean; enabled: boolean }
      const hits: Hit[] = []
      for (const root of data.roots || []) {
        for (const skill of root.skills || []) {
          if (String(skill.declaredName || skill.name || '') !== wanted && String(skill.name || '') !== wanted) continue
          if (rootWanted && String(root.key || '') !== rootWanted) continue
          hits.push({
            rootKey: String(root.key || ''),
            // `skill-detail` 按**目录名**认条目（core 的 visibleEntryForRoot 比的是 entry.name），
            // 而目录名与 frontmatter 的 name 可以不同 —— 传错一个就读不到。
            entryName: String(skill.name || wanted),
            path: String(skill.path || ''),
            shadowedBy: skill.shadowedBy && skill.shadowedBy.root ? String(skill.shadowedBy.root) : '',
            preferred: skill.preferred === true,
            // 与 skill_manager_list 同一套启停推导（影子副本没有 enabled 字段）。
            // 会话层：覆盖优先 —— 否则「列表里说关着、读出来说 enabled」两处打架。
            enabled: (() => {
              const g = skill.enabled !== undefined
                ? skill.enabled === true
                : (skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false)
              const o = overrides?.[String(root.key || '') + '/' + String(skill.declaredName || skill.name || '')]
              return typeof o === 'boolean' ? o : g
            })(),
          })
        }
      }
      if (!hits.length) {
        // 「去调 skill_manager_list」那句：那条工具在出厂默认里就是关着的，点名一条模型没有的
        // 工具只会让它白跑一趟（执行侧拦住，而它看不出为什么）。判据按 **agent**：
        // 人设用 `toolsDeny` 砍掉它时，全局开关看着是开的。
        const listHint = deps.toolVisibleFor('skill_manager_list', exec && exec.agent)
          ? ' — call skill_manager_list (pass all=true) to see what is installed'
          : ''
        // 名字打错是这条错误最常见的成因，而现成的名字这一次已经扫到了（`data.roots` 在手），
        // 不必再读一次盘。条目多时只列前几个，见 `toolNameList`。
        const names: string[] = []
        for (const root of data.roots || []) {
          for (const skill of root.skills || []) names.push(String(skill.declaredName || skill.name || ''))
        }
        throw new Error('no skill named "' + wanted + '"' + (rootWanted ? ' in source "' + rootWanted + '"' : '') + listHint
          + existingNote(names, 'skills'))
      }
      // 胜出者优先：同名的影子副本读得到，但那不是生效的一份，所以默认不选它。
      const picked = hits.find((hit) => !hit.shadowedBy && hit.enabled)
        || hits.find((hit) => !hit.shadowedBy)
        || hits[0]
      const res = await deps.skillsOps['skill-detail']({ root: picked.rootKey, name: picked.entryName })
      if (!res || res.ok === false) throw new Error((res && res.error) || 'skill-detail failed')
      const detail: any = res.data || res
      const marks: string[] = []
      if (picked.shadowedBy) marks.push('shadowed by "' + picked.shadowedBy + '" — the copy actually in effect is a different one')
      if (picked.preferred) marks.push('preferred copy')
      if (!picked.enabled) marks.push('disabled')
      // 会话层：本会话关掉的技能照样读得到正文（读 ≠ 生效），但必须说清 ——
      // 不说的话模型会以为自己已经掌握了它、下一轮却看不到它。
      const overHere = scoped?.scope?.skills?.[picked.rootKey + '/' + wanted]
      if (overHere === false) marks.push('switched off here only — the global setting is unchanged')
      const dup = hits.filter((hit) => !hit.shadowedBy).length > 1
        ? hits.filter((hit) => !hit.shadowedBy).map((hit) => hit.rootKey).filter((k) => k !== picked.rootKey)
        : []
      // 附件清单：技能正文常写着「详见 references/xxx.md」，而这一条工具是模型
      // 读技能的唯一入口 —— 不列出来，它就会因为"看到的目录里没有那个文件"而凭空猜内容。
      // 只报名与大小、不报正文：正文要走宿主文件工具，这里塞进 transcript 太重。
      const attachments = Array.isArray(detail.attachments) ? detail.attachments : []
      const shown = attachments.slice(0, 20)
      const attLine = shown.length
        ? 'Attachments in this skill folder: ' + shown
          .map((a: any) => String(a.path) + ' (' + Number(a.size || 0) + ' bytes)')
          .join(', ')
          + (attachments.length > shown.length ? ' … ' + (attachments.length - shown.length) + ' more' : '')
          + (detail.attachmentsTruncated ? ' (listing capped at 200)' : '')
          + ' — read them with a file tool if the body refers to one\n'
        : ''
      const header = 'Skill ' + wanted + ' · source ' + picked.rootKey + (marks.length ? ' (' + marks.join('; ') + ')' : '') + '\n' +
        'Path: ' + (detail.path || picked.path || '(unknown)') + '\n' +
        'Description: ' + String(detail.description || '(none)').replace(/\s+/g, ' ').trim() + '\n' +
        (dup.length ? 'Other callable copies with the same name: ' + dup.join(', ') + ' (this one wins; read them only to compare)\n' : '') +
        attLine +
        '--- SKILL.md body ---\n'
      // 注入边界：正文读进来就永久留在这一轮的 transcript 里，压制型预设下目录也可能不在 ——
      // 与 skill_manager_list 同一句说明，别让模型以为"读过就等于技能开着"。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      // 官方 office 操作技能：provider 的 get 会补 LibreOffice Kit 段，这里读到的正文
      // 必须与真正注入的一致，否则模型按少了 node/cli 路径的正文去猜。判据同 get：看正文。
      const body = String(detail.body || '')
      const officeRuntime =
        picked.rootKey === OFFICIAL_SOURCE_KEY && officeKitApplies(body)
          ? officialOfficeRuntimeSection()
          : ''
      return header + body.trim() + officeRuntime + notice
    },
  }))
  register(defineTool({
    name: 'skill_manager_switch',
    description: 'Enable or disable one DSH skill, or a whole source folder via `source`. Pass `prefer` (with `name` + `root`) to make that copy win a same-name collision, or to clear the recorded choice. Enabling a shadowed copy has no effect. Reversible. Only when the user asks or approves.',
    parameters: {
      name: { type: 'string', description: 'Skill name (kebab-case).' },
      // `enabled` 从 required 改成"要么给 enabled、要么给 prefer"：
      // prefer 是一次独立的写（`skill-prefer`），模型不该为了改首选来源先被迫拨一次开关。
      // 缺省仍然**拒绝**（execute 里那条守卫），不然 `args.enabled ? enable : disable`
      // 会把"忘了给"静默当成"停用"。
      enabled: { type: 'boolean', description: 'true to enable, false to disable. Required unless you only pass `prefer`.' },
      source: { type: 'string', description: 'A source root key to switch as a whole (dsh/hub/agents/codex/claude or a project key).' },
      root: { type: 'string', description: 'Source root the skill lives in (with `name`). Default: whichever source holds it. Required with `prefer`.' },
      // 同名首选来源。此前这条工具的回执写着
      // "or make this root the preferred copy **in the panel**" —— 明明一个布尔能解决，
      // 却把用户推去界面点。而 `skill-prefer` / `skill-unprefer` 两个 op 早就在（面板在用）。
      // 代价为零：本工具在出厂默认名单里就是关着的，加参数不进默认上下文。
      prefer: { type: 'boolean', description: 'true = the copy in `root` wins this name\'s collision; false = drop the recorded choice. Needs `name` + explicit `root`; omit = leave it.' },
      // 默认只改**这个对话**。写全局要显式说明。
      // `source` 也有会话版本（拨开时来源按租约跑起来 —— 来源关着时技能级
      // 开关会被 core 吞掉，所以那一步在回执里如实交代）。
      scope: { type: 'string', enum: ['session', 'global'], description: scopeSessionDesc('turning a source or skill on here may start that source for this scope only. global = every conversation.') },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      if (args && args.enabled !== undefined && typeof args.enabled !== 'boolean') {
        throw new Error('enabled must be true or false (omit it to only change the preferred copy)')
      }
      // 场景锁冻结的是**全局**写入：本会话的逐条开关写的是侧车，与锁无关 ——
      // 与面板的 `scopeWriteLocked()` 同一口径。只有真会改全局状态的那几条才过守卫。
      // 全局粒度一律走全局：那一档没有会话层，写的就是状态文件 —— 所以要过场景锁。
      const sessionWrite = Boolean(args && args.enabled !== undefined && effectiveScope(deps, args) === 'session' &&
        !String(args.source || '').trim() && args.prefer === undefined)
      if (!sessionWrite) {
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
      }
      const name = String((args && args.name) || '').trim()
      const source = String((args && args.source) || '').trim()
      // `prefer` 的三态与它自己的前置条件：省略 = 不碰首选表；
      // true / false = 设 / 撤。**必须点名 root** —— 默认值 `dsh` 在"同名首选"这件事上
      // 恰恰是最容易猜错的一格（要选赢的往往是**非 dsh** 那一份），所以这里不接受默认值。
      const preferGiven = Boolean(args && args.prefer !== undefined)
      const prefer = args && args.prefer === true
      if (preferGiven && typeof args.prefer !== 'boolean') throw new Error('prefer must be true or false')
      if (name && source) throw new Error('give either name or source, not both: name is one skill, source is a whole source folder')
      if (preferGiven && source) throw new Error('prefer only makes sense for a single skill: pass name, not source')
      if (!name && !source) throw new Error('missing argument: name (one skill) or source (a whole source folder)')
      if (preferGiven && !name) throw new Error('missing argument: prefer needs name')
      // 会话层：首选来源是**全局**的一张表，没有会话版本。`scope` 省略时默认是
      // session（见参数说明），所以这里必须要求显式 `scope="global"` —— 否则一次「本会话
      // 切个技能」会静默改掉全局的同名胜负。
      const scopeArg = String((args && args.scope) || '')
      // 全局粒度下 prefer 就是全局设置，不必再要一句显式的 scope="global"。
      const isolationOff = !sessionLayerOn(deps)
      if (preferGiven && !isolationOff && scopeArg !== 'global') {
        throw new Error('prefer is a global setting (which copy wins a name collision is the same in every conversation), so it needs scope="global" explicitly. '
          + 'Drop prefer to switch only this scope, or pass scope="global" to change the global choice.')
      }
      if (preferGiven && String((args && args.root) || '').trim() === '') {
        throw new Error('prefer needs root: name the copy that should win this collision (dsh / hub / agents / codex / claude or a project key)')
      }
      // 两个动作一个都没给就拒：`args.enabled ? enable : disable` 会把"忘了给"静默当成"停用"。
      if (args.enabled === undefined && !preferGiven) {
        throw new Error('missing argument: enabled must be true or false (pass prefer if you only want to change which copy wins the collision)')
      }
      if (source) {
        if (args.root !== undefined) throw new Error('source is already a source-level key; do not pass root with it')
        // 会话层：来源这一格有会话版本了（`skillSources`）。拨开时 op 侧会把它
        // 在**全局**启用（来源关着时技能级 enable 会被 core 吞掉）；拨关只影响本会话的
        // 「看不看得到」，别的对话与全局状态都不动。
        if (effectiveScope(deps, args) === 'session') {
          if (!deps.sessionScopeSet) throw new Error('per-conversation switches are unavailable in this host: pass scope="global" to change it for every conversation')
          const sc = await deps.sessionScopeSet(exec && exec.agent, 'skillSources', source, args.enabled === true)
          if (!sc || sc.ok === false) throw new Error((sc && sc.error) || 'failed to switch this source here')
          const warnings = sc.warnings !== undefined && sc.warnings.length > 0 ? '\n' + sc.warnings.join('\n') : ''
          return 'OK: source ' + source + ' now ' + (args.enabled ? 'enabled' : 'disabled') + scopeOnlyNote(deps) +
            (sc.cleared === true ? ' (that matches what this scope would see anyway, so the override was removed)' : '') + warnings +
            (warnings === '' ? '\n' + globalUnchangedNote(deps) : '') +
            ' Pass scope="global" to change it for every conversation.'
        }
        // 全局来源开关 = **意图**：off 之后仍被会话认领的来源保持启用（租约）
        // 只是别的会话看不到它下面的技能。直接改来源状态会让这次会话级开启串到所有会话 ——
        // 与 MCP 那条是同一个修法。
        if (deps.scopeIntentSet) {
          const value: 'on' | 'off' = args.enabled === true ? 'on' : 'off'
          const r = await deps.scopeIntentSet('skillSources', [source], value)
          if (!r || r.ok === false) throw new Error((r && r.error) || 'skill source toggle failed')
          const syncErr = r.sceneSyncError ? String(r.sceneSyncError) : null
          const warnings = r.warnings !== undefined && r.warnings.length > 0 ? '\n' + r.warnings.join('\n') : ''
          return 'OK: source ' + source + ' now ' + (value === 'on'
            ? 'enabled for every conversation'
            : 'disabled globally (conversations still using it keep it enabled until none does)') + warnings +
            (syncErr ? '\nWARN: the current scene archive was not synced (' + syncErr + ')' : '') +
            '\nnote: a whole source folder is global (every conversation); omit scope to switch it here only.' + isolationOffNote(deps)
        }
        // 来源级启停：登记表里 `skill-source-enable` / `skill-source-disable` 都是
        // `{ serviceWrite, frozen, syncsArchive }`，所以守卫已过、档案也要同步
        // —— 同步的入参是 `{ root }`（来源级没有独立字段，档案靠"来源下有没有被勾的技能"反推）。
        const op = args.enabled ? 'skill-source-enable' : 'skill-source-disable'
        const r = await deps.skillsOps[op]({ root: source })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill source toggle failed')
        const syncErr = await deps.syncSwitchToScene(op, { root: source, enabled: args.enabled === true })
        return 'OK: source ' + source + ' now ' + (args.enabled ? 'enabled' : 'disabled') +
          (syncErr ? '\nWARN: the current scene archive was not synced (' + syncErr + ')' : '') +
          '\nnote: a whole source folder is global (every conversation); omit scope to switch it here only.' + isolationOffNote(deps)
      }
      // 不给 root 就在全部来源里找：`skill_manager_save` 的落点
      // 是 hub（`tool-management/skills/`），而这里的默认值原本是 dsh —— 「建完就启用」这条
      // 最自然的链路必然报「技能不存在」。默认值改哪一边都不对（面板是显式传 root 的，
      // 两边都依赖各自的默认），所以判定放到工具侧：按名字找**胜出的那一份**。
      /** 会话覆盖键用的声明名（与目录名可以不同）。 */
      let canonicalName = name
      const resolveRoot = async (): Promise<string> => {
        const explicit = String((args && args.root) || '').trim()
        const found = await locateSkillRoot(deps.skillsOps, name)
        // 声明名按**指定来源那一份**取；没指定就用胜出副本的。找不到就退回传入名，
        // 由后面的全局 op 报"技能不存在"（会话写入不该在这里编一个结论）。
        const match = explicit !== ''
          ? found.matches.filter((m) => m.root === explicit)[0]
          : undefined
        // 指定来源时只认**那个来源**里的声明名；找不到就退回传入名（不能拿别的来源的同名
        // 副本去拼键 —— 那会写出一条 root 与声明名对不上的覆盖）。
        canonicalName = explicit !== ''
          ? (match && match.canonical) || name
          : found.canonical || name
        if (explicit !== '') return explicit
        if (found.root) return found.root
        // 探得到、就是没这个技能：当场把"查过哪些来源"说清楚。否则模型收到 op 那句不带
        // 来源信息的「技能不存在」后，只能猜该传哪个 root（smoke-test P1-4-old 同一处）。
        if (found.ok) {
          throw new Error('no such skill: ' + name + (found.roots.length ? ' (searched ' + found.roots.join(', ') + ')' : '')
            + existingNote(found.names, 'skills'))
        }
        // 探不到（skill-state 失败）就别在这里编结论：退回旧默认，交给 op 报它自己的错。
        return 'dsh'
      }
      const root = await resolveRoot()
      const out: string[] = []
      // 首选来源**先写**（与面板「启用这个」同序：先 prefer 再 enable）。顺序不是随意的 ——
      // 反过来的话，下面那段 `shadowedBy` 是在**旧**首选下算的，紧接着 prefer 又把胜负翻了过来，
      // 回执里那句"它被 X 盖住了"当场就成了过期的假话。
      if (preferGiven) {
        const op = prefer ? 'skill-prefer' : 'skill-unprefer'
        const p: any = await deps.skillsOps[op]({ name: args.name, root })
        if (!p || p.ok === false) throw new Error((p && p.error) || 'failed to set the collision winner')
        // `skill-prefer` 会在"记下了但不会生效"时回 ok:true + warning（首选指向**停用**的来源，
        // 而同名首选会挡住其他副本 → 两份都不生效）。原样转出去，否则模型以为已经生效。
        // 首选来源是**全局**的一张表（同名胜负对所有对话都一样），会话层没有对应键 ——
        // 与 enable 同一次调用时也要说清，否则"本会话切了个技能"会连带改掉全局的胜负。
        out.push((prefer
          ? 'OK: ' + root + '/' + String(p.name || args.name) + ' is now the preferred copy of that name'
          : 'OK: cleared the preferred copy of ' + String(p.name || args.name)) +
          (p.warning ? '\nWARN: ' + String(p.warning) : '') +
          '\nnote: which copy wins a name collision is a global setting (it has no per-conversation version).')
      }
      if (args.enabled !== undefined) {
        // 默认写**本会话**（别的对话不受影响），`scope: "global"` 才改状态文件。
        // 会话层只改"列不列"（决策：会话层不碰启停本身），所以它不需要冻结守卫与场景档案同步 ——
        // 那两样保护的是全局状态。
        if (effectiveScope(deps, args) === 'session') {
          if (!deps.sessionScopeSet) throw new Error('per-conversation switches are unavailable in this host: pass scope="global" to change it for every conversation')
          // 键用**声明名**：目录名与 frontmatter 名字不同时，面板 / 注入段 / 模型列表都按
          // 声明名读写；拿目录名写进去，覆盖永远读不到（"点了没反应"）。
          const sc = await deps.sessionScopeSet(exec && exec.agent, 'skills', root + '/' + canonicalName, args.enabled === true)
          if (!sc || sc.ok === false) throw new Error((sc && sc.error) || 'failed to switch this skill here')
          // 拨开时 op 侧可能顺手在全局把它的**来源**启用（来源关着时技能级开关会被 core 吞掉），
          // 那一步的影响由 `warnings` 如实带出来；没动全局时才说"全局设置未变"。
          const warnings = sc.warnings !== undefined && sc.warnings.length > 0 ? '\n' + sc.warnings.join('\n') : ''
          out.push('OK: ' + args.name + ' now ' + (args.enabled ? 'enabled' : 'disabled') + scopeOnlyNote(deps) +
            (sc.cleared === true ? ' (that matches what this scope would see anyway, so the override was removed)' : '') + warnings +
            (warnings === '' ? '\n' + globalUnchangedNote(deps) : '') +
            ' Pass scope="global" to change it for every conversation.')
          return out.join('\n')
        }
        const op = args.enabled ? 'skill-enable' : 'skill-disable'
        const r = await deps.skillsOps[op]({ name: args.name, root })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill toggle failed')
        // 场景未锁定时同步进当前场景档案（与 handlers 层同一套同步）。
        const syncErr = await deps.syncSwitchToScene(op, { name: args.name, root, enabled: args.enabled === true })
        // 静默无效是这个工具最容易骗人的地方：同名胜负只由「首选 > 来源优先级」决定，
        // 与启用状态无关。对影子副本操作会返回 OK，但技能依然不可用。如实说一句。
        let shadowedBy = ''
        try {
          const state: any = await deps.skillsOps['skill-state']({})
          for (const rt of (state && state.data && state.data.roots) || []) {
            for (const skill of rt.skills || []) {
              if (String(skill.declaredName || skill.name || '') !== String(args.name)) continue
              if (String(rt.key || '') !== root) continue
              if (skill.shadowedBy && skill.shadowedBy.root) shadowedBy = String(skill.shadowedBy.root)
            }
          }
        } catch { shadowedBy = '' }
        // 出路指向**本工具自己的参数**：此前写的是
        // "or make this root the preferred copy in the panel" —— 模型读得到这句却做不到，
        // 只能转述给用户去点界面。现在 `prefer` 就在同一张参数表里；而这条工具在出厂默认
        // 名单里是关着的，模型既然调得到它，就一定拿得到这个参数（不会指到一条它没有的工具）。
        const warn = shadowedBy
          ? ' — BUT this copy is shadowed by the same-name skill in "' + shadowedBy + '", so it stays inactive: enable that copy instead, or make it win with prefer=true and root="' + shadowedBy + '"'
          : ''
        const sceneWarn = syncErr ? '\nWARN: the current scene archive was not synced (' + syncErr + ')' : ''
        out.push('OK: ' + args.name + ' now ' + (args.enabled ? 'enabled' : 'disabled') + warn + sceneWarn + isolationOffNote(deps))
      }
      return out.join('\n')
    },
  }))
  register(defineTool({
    name: 'skill_manager_save',
    // 落点必须和 UI「创建技能」一致 —— 这是本工具与面板之间唯一不能各自默认的地方（否则同一个
    // 「新建技能」动作，人点界面和模型调用会落到两个不同的根）。当前两边都是 **DSH 技能目录**
    // （`~/.dsh/skills/`）：UI 是 `43-skills.js` 的 `defaultCreateRoot`，模型侧就是下面这句
    // `skill-create` 的 op 默认值。hub（`tool-management/skills/`）只留给「导入技能」功能
    // 。历史上两边曾一个 dsh 一个 hub，靠本条纪律对齐。
    //
    // 改的分支**认全部来源里的胜出者**：同名技能在 dsh/hub/项目根各有一份时只有一份生效，
    // 改错那一份会返回 OK 而技能毫无变化 —— 那层判定在 `skill-update` op 里，它同时要求
    // 胜出者落在本插件可写的两个根（hub 导入落点 / dsh 新建落点）。也就是说：本工具建出来
    // 的技能（只落在 dsh）一定还能被本工具改回去，不会建完就改不动。
    //
    // 描述里不写落点路径：模型不按路径行动，而写死路径还会与 `remove.ts` 头注释里的落点
    // 口径打架。真正要它知道的是"建在哪一侧"，而"只认本插件写的技能"那半句已经说清了。
    description: 'Create a DSH skill, or update the one that already has this name — the receipt says which. Only skills this plugin wrote can be updated. Only on the user\'s instruction.',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill name; normalized to kebab-case (≤128 chars, [a-z0-9-]).' },
      description: { type: 'string', description: 'A concise routing description (≤500 chars). Required when creating; omit = keep.' },
      body: { type: 'string', description: 'Markdown instructions (≤256 KiB). Required when creating; omit = keep.' },
      // 技能 / 人设 / 场景 / MCP 服务器是**机器级**对象，没有「本会话的一份」。
      // 这个参数只为一件事：模型以为自己在改会话时，当场纠回来（见 deps.ts 的 requireGlobalScope）。
      scope: { type: 'string', enum: ['session', 'global'], description: scopeGlobalOnlyDesc('a skill file is machine-wide', 'switch it here instead of editing it') },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      requireGlobalScope(args, 'skills', !sessionLayerOn(deps))
      const wanted = String((args && args.name) || '').trim()
      if (!wanted) throw new Error('missing argument: name')
      const kebab = toKebab(wanted)
      if (!kebab) throw new Error('cannot build a valid kebab-case name (raw name: ' + wanted + ')')
      // 建还是改：先看这个（规范化后的）名字在不在。`skill-create` 对同名是**拒绝**的，
      // 所以这条判定只能在这里做 —— 不能指望 op 层兜，也不能让模型自己先查一次
      // （它手里的清单可能已经过期）。
      const state: any = await deps.skillsOps['skill-state']({})
      if (!state || state.ok === false) throw new Error((state && state.error) || 'skill-state failed')
      let exists = false
      for (const root of ((state.data && state.data.roots) || [])) {
        for (const skill of root.skills || []) {
          // 与 list / read 同一套名字口径：`declaredName || name`，再比目录名。
          if (String(skill.declaredName || skill.name || '') === kebab || String(skill.name || '') === kebab) exists = true
        }
      }
      if (!exists) {
        // 建的分支：正文与简介都必填。core 自己会拒（error.create.descriptionRequired /
        // bodyRequired），但那是给用户看的 op 错；模型需要的是"这条工具要什么"。
        const description = String((args && args.description) || '').trim()
        const body = String((args && args.body) || '').trim()
        const missing = [
          description === '' ? 'description' : '',
          body === '' ? 'body' : '',
        ].filter((x) => x !== '')
        if (missing.length) throw new Error('creating a skill needs ' + missing.join(' and ') + ' (' + kebab + ' does not exist yet)')
        const r: any = await deps.skillsOps['skill-create']({ name: wanted, description: args.description, body: args.body })
        if (!r || r.ok === false) throw new Error((r && r.error) || 'skill create failed')
        const data: any = r.data || {}
        // 新建的技能默认停用（与 MCP / 人设同口径）。这句必须留 —— 不说的话模型会直接去用，
        // 然后发现技能不生效，而它不知道自己少拨了一个开关（三个 save
        // 里只有这一条不报启用状态）。点名的 `skill_manager_switch` 在出厂默认名单里就是关着的，
        // 关着就改说"用户启用后才能用"，别指一条模型没有的工具。
        const enableHint = deps.toolVisibleFor('skill_manager_switch', exec && exec.agent)
          ? ' (created disabled; use skill_manager_switch to enable it)'
          : ' (created disabled; the user has to enable it first)'
        // 会话层：技能文件是**机器级**的，本会话的开关只决定这里看不看得到它。
        return 'Created DSH skill ' + (data.name || kebab) + ' at ' + (data.path || '(unknown)') + enableHint +
          globalActionNote(deps, exec && exec.agent, 'skills', 'skill')
      }
      // 改的分支：省略 = 保持。两个可改字段一个都没给就拒 —— op 会按"保持原样"重写一次文件
      // 并刷新时间戳，模型以为改了点什么，其实只是把同一份内容又写了一遍。
      const touched: string[] = []
      if (args.description !== undefined) touched.push('description')
      if (args.body !== undefined) touched.push('body')
      if (!touched.length) throw new Error('nothing to change: pass description and/or body')
      const r: any = await deps.skillsOps['skill-update']({ name: wanted, description: args.description, body: args.body })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'skill update failed')
      const data: any = r.data || {}
      return 'Updated DSH skill ' + (data.name || kebab) + ' at ' + (data.path || '(unknown)') + ' (changed ' + touched.join(', ') + ')' +
        globalActionNote(deps, exec && exec.agent, 'skills', 'skill')
    },
  }))
}
