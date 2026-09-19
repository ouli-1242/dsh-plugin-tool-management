// 技能域的 model 工具（2026-09-19 从 index.ts 的注册区抽出）：
// skill_manager_list / skill_manager_set_enabled / skill_manager_create。

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
    description: 'List DSH skills with enabled state, effective/shadowed status and source file path. The injected「本机技能目录」system-reminder carries callable skills and summaries only; use this tool to get a source file path (read the file for the full body) and to see entries that are off. Defaults to enabled skills only; pass all=true for every entry. A copy marked "shadowed by <root>" stays inactive even if enabled.',
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
  register(defineTool({
    name: 'skill_manager_set_enabled',
    description: 'Enable or disable one DSH skill (manager policy only; source files are never modified). Enabling a shadowed copy has no effect.',
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
