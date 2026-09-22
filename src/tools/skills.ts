// 技能域的 model 工具（2026-09-19 从 index.ts 的注册区抽出）：
// skill_manager_list / skill_manager_read / skill_manager_set_enabled / skill_manager_create。

import { text, type ToolDomainDeps } from './deps.js'

export interface SkillToolDeps extends ToolDomainDeps {
  /** skills service 的 ops 表：skill-state / skill-enable / skill-disable / skill-create。 */
  skillsOps: Record<string, (args: any) => Promise<any>>
}

export function buildSkillTools(deps: SkillToolDeps): void {
  const { defineTool, register } = deps
  // Skill-facing tools: list, toggle, create. create is gated by the
  // tools/pre-execute hook below (the model must ask before writing files).
  register(defineTool({
    name: 'skill_manager_list',
    description: 'List skills with enabled state, effective/shadowed status and source file path. The「本机技能目录」reminder carries callable skills and summaries only; use this for entries that are off and to see which source wins a name collision, and skill_manager_read for a body. Defaults to enabled only; all=true for every entry. A copy marked "shadowed by <root>" stays inactive even if enabled.',
    parameters: {
      all: { type: 'boolean', description: 'Include disabled and shadowed entries (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      const r = await deps.skillsOps['skill-state']({})
      if (!r || r.ok === false) throw new Error((r && r.error) || 'skill-state failed')
      const data: any = r.data || {}
      // 同名（canonical = declaredName || name）跨根重复时只有**一份**生效，排序规则是
      // 「同名首选 > 来源优先级 rank」，**与启用状态无关**（core 的 groupLoadableSkillsByName）。
      // 于是「启用被覆盖的那份」是静默无效的：工具会回 OK，技能却依然不可用 —— 用户实测
      // 踩到的正是这个坑（同一技能在 dsh/agents/claude/custom 各有一份，启错根等于没启）。
      // 这里把生效/被覆盖如实标出来，让模型（和人）不必猜。
      //
      // 默认只列启用的（2026-09-16 用户裁定）：本机 36 条里只有 1 条启用，全列一次约 4.3k
      // 字符且永久留在 transcript。表头始终给出全量口径（多少条 / 多少同名组），所以
      // 「还有没列出来的」不会变成盲区 —— 要看就传 all=true。
      const rows: Array<{ root: string; text: string; enabled: boolean }> = []
      const counts = new Map<string, number>()
      for (const root of data.roots || []) {
        for (const skill of root.skills || []) {
          const key = String(skill.declaredName || skill.name || '')
          counts.set(key, (counts.get(key) || 0) + 1)
          // `enabled` 只写在「胜出者」上（core 的 markWinners）；影子副本与不可加载的技能
          // 没有这个字段。原先直接读 skill.enabled，这些技能一律被报成 disabled ——
          // 这里改用与界面同口径的兜底推导（client 的 isSkillEnabled）。
          const enabled = skill.enabled !== undefined
            ? skill.enabled === true
            : (skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false)
          const marks: string[] = []
          if (skill.shadowedBy && skill.shadowedBy.root) marks.push('shadowed by ' + skill.shadowedBy.root)
          if (skill.preferred === true) marks.push('preferred')
          rows.push({
            root: String(root.key || ''),
            enabled,
            text: (skill.name || skill.declaredName || '') + ' | ' + (root.key || '') + ' | ' + (enabled ? 'enabled' : 'disabled') +
              (marks.length ? ' | ' + marks.join(' ') : '') +
              (skill.path ? ' | ' + skill.path : ''),
          })
        }
      }
      const dupGroups = [...counts.values()].filter((n) => n > 1).length
      const shown = showAll ? rows : rows.filter((row) => row.enabled)
      const header = 'Skills: ' + (showAll
        ? rows.length + ' entries'
        : shown.length + ' enabled of ' + rows.length + ' entries') +
        (dupGroups ? ' · ' + dupGroups + ' duplicated names' : '') +
        (showAll || shown.length === rows.length ? '' : ' (pass all=true to include disabled and shadowed entries)') + '\n'
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
    description: 'Read one skill\'s full SKILL.md body by name — what the「本机技能目录」reminder deliberately leaves out (it has names and summaries only). Resolves name collisions the same way, so you get the copy actually in effect; pass root only to inspect a specific (e.g. shadowed) source. Read-only.',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill name, exactly as it appears in the catalog (kebab-case).' },
      root: { type: 'string', description: 'Source root key (dsh/hub/agents/codex/claude, a project key, or a custom one). Default: the winning copy of this name.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const wanted = String((args && args.name) || '').trim()
      if (!wanted) throw new Error('name is required')
      const rootWanted = String((args && args.root) || '').trim()
      const state = await deps.skillsOps['skill-state']({})
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
            enabled: skill.enabled !== undefined
              ? skill.enabled === true
              : (skill.invocationPolicyValid && skill.modelInvocable && skill.userInvocable && skill.managerEnabled !== false),
          })
        }
      }
      if (!hits.length) {
        throw new Error(rootWanted
          ? `no skill named "${wanted}" in source "${rootWanted}" — call skill_manager_list (pass all=true) to see what is installed`
          : `no skill named "${wanted}" — call skill_manager_list (pass all=true) to see what is installed`)
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
      const dup = hits.filter((hit) => !hit.shadowedBy).length > 1
        ? hits.filter((hit) => !hit.shadowedBy).map((hit) => hit.rootKey).filter((k) => k !== picked.rootKey)
        : []
      const header = 'Skill ' + wanted + ' · source ' + picked.rootKey + (marks.length ? ' (' + marks.join('; ') + ')' : '') + '\n' +
        'Path: ' + (detail.path || picked.path || '(unknown)') + '\n' +
        'Description: ' + String(detail.description || '(none)').replace(/\s+/g, ' ').trim() + '\n' +
        (dup.length ? 'Other callable copies with the same name: ' + dup.join(', ') + ' (this one wins; read them only to compare)\n' : '') +
        '--- SKILL.md body ---\n'
      // 注入边界：正文读进来就永久留在这一轮的 transcript 里，压制型预设下目录也可能不在 ——
      // 与 skill_manager_list 同一句说明，别让模型以为"读过就等于技能开着"。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + String(detail.body || '').trim() + notice
    },
  }))
  register(defineTool({
    name: 'skill_manager_set_enabled',
    description: 'Enable or disable one DSH skill (manager policy only; source files are never modified). Enabling a shadowed copy has no effect. Only when the user asks or approves.',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill name (kebab-case).' },
      enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
      root: { type: 'string', description: 'Source root key (dsh/agents/codex/claude or a project key); default dsh.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const root = String(args.root || 'dsh')
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
      const warn = shadowedBy
        ? ' — BUT this copy is shadowed by the same-name skill in "' + shadowedBy + '", so it stays inactive: enable that copy instead, or make this root the preferred copy in the panel'
        : ''
      const sceneWarn = syncErr ? '\nWARN: 当前场景档案未同步（' + syncErr + '）' : ''
      return 'OK: ' + args.name + ' now ' + (args.enabled ? 'enabled' : 'disabled') + warn + sceneWarn
    },
  }))
  register(defineTool({
    name: 'skill_manager_create',
    // 落点必须和 UI「创建技能」一致：两者都走 core 的默认落点（hub 的
    // tool-management/skills/，hub 缺失时退回 DSH_HOME/skills）。以前这里硬编码
    // root:'dsh'，于是同一个「新建技能」动作，人点界面和模型调用会落到两个不同的根。
    description: 'Create a new DSH skill under DSH_HOME/tool-management/skills. Use only when the user explicitly asks to create or save a reusable skill.',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill name; normalized to kebab-case.' },
      description: { type: 'string', required: true, description: 'A concise routing description for when to use the skill.' },
      body: { type: 'string', required: true, description: 'Markdown instructions that form the skill body.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const r = await deps.skillsOps['skill-create']({ name: args.name, description: args.description, body: args.body })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'skill create failed')
      const data: any = r.data || {}
      return 'Created DSH skill ' + (data.name || args.name) + ' at ' + (data.path || '(unknown)')
    },
  }))
}
