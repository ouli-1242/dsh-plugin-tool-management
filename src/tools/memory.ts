// 记忆（rules）域的 model 工具（2026-09-19 从 index.ts 的注册区抽出）：
// memory_manager_list / memory_manager_read / memory_manager_write。
//
// 活动场景的记忆正文会自动注入上下文（无需调用工具读取）；这里的工具用于查询/编辑规则
// 本身。memory_manager_write 受 tools/pre-execute 审批门禁（D2）。
// 路径锚点：$DSH_HOME/tool-management/memories/<场景>/…（场景 `global` = 界面「全局」）。

import { text, type ToolDomainDeps } from './deps.js'

export interface MemoryToolDeps extends ToolDomainDeps {
  /** rules service 的 ops 表：rules-list / rules-read / rules-create。 */
  rulesOps: Record<string, (args: any) => Promise<any>>
}

export function buildMemoryTools(deps: MemoryToolDeps): void {
  const { defineTool, register } = deps
  register(defineTool({
    name: 'memory_manager_list',
    description: 'List memories under ~/.dsh/tool-management/memories (id, scene, enabled, description). The ones actually injected are carried in your context each turn (the「本机当前的场景和记忆」system-reminder); use this tool to find ids/paths or to see entries that are off. Defaults to the memories that will actually be injected; pass all=true for every entry.',
    parameters: {
      group: { type: 'string', description: 'Optional scene filter.' },
      all: { type: 'boolean', description: 'Include memories that are off, in an inactive scene, or shadowed (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      const r: any = await deps.rulesOps['rules-list'](args)
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取规则失败')
      // 「会注入」的判定与记忆段同源（renderSceneMemory）：global 场景恒常注入，其余场景要
      // 在 index.active 里，再叠加单条 enabled 与同名 bundle 的 shadowed。默认只列这些，
      // 全列一次会把没启用的条目也算进上下文（用户裁定 2026-09-16，与技能列表同口径）。
      const sceneOn = (group: string): boolean => group === 'global' ||
        (group !== '' && (r.activeMode === 'all' || String(r.activeScene || '') === group))
      const stateOf = (x: any): { injects: boolean; label: string } => {
        if (x.shadowed === true) return { injects: false, label: '被同名覆盖' }
        if (x.enabled === false) return { injects: false, label: '已停用' }
        if (!sceneOn(String(x.group || ''))) return { injects: false, label: '场景未启用' }
        return { injects: true, label: '已启用' }
      }
      const rows: Array<{ x: any; injects: boolean; label: string }> =
        (r.rules || []).map((x: any) => ({ x, ...stateOf(x) }))
      const shown = showAll ? rows : rows.filter((row) => row.injects)
      const lines = shown.map(({ x, label }) => (
        '- ' + x.id + ' [' + (x.group || '未归属场景') + '] ' + label +
        (x.description ? ' — ' + x.description : '')
      ))
      const scenes = (r.scenes || []).map((s: any) => (s.label || s.name) + (s.active ? '(启用)' : '(未启用)')).join('、')
      const header = '记忆：' + (showAll
        ? rows.length + ' 条'
        : shown.length + ' 条会注入 / 共 ' + rows.length + ' 条' +
          (shown.length === rows.length ? '' : '（传 all=true 看全部）')) + '\n'
      // 注入边界：压制型预设（persona complete / 关闭运行时上下文）下本插件默认不注入，
      // 此时列出的记忆**不在**模型上下文里。必须说出来，否则模型会假设自己已经看到正文。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + (lines.join('\n') || '(无记忆)') +
        '\n场景：' + (scenes || '(无)') + (r.activeMode === 'all' ? '（默认全部启用）' : '（已收窄）') + notice
    },
  }))
  register(defineTool({
    name: 'memory_manager_read',
    description: 'Read the full body of one memory under ~/.dsh/tool-management/memories. Call it only for memories that are not already in your context (disabled, unassigned to a scene, or dropped by the injection budget).',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id like <scene>/<name>.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const r: any = await deps.rulesOps['rules-read'](args)
      if (!r || r.ok === false) throw new Error((r && r.error) || '读取规则失败')
      return '# ' + r.rule.id + '\n\n' + (r.rule.body || '')
    },
  }))
  register(defineTool({
    name: 'memory_manager_write',
    description: 'Create a new memory as ~/.dsh/tool-management/memories/<scene>/<name>.md. The scene must already exist (use global for the always-on scene).',
    parameters: {
      group: { type: 'string', required: true, description: 'Scene name (no path separators or < > : " | ? *); `global` = the always-on scene.' },
      name: { type: 'string', required: true, description: 'Memory name = .md file name without extension; <=64 chars, no path separators or < > : " | ? *, must not start with a dot.' },
      description: { type: 'string', required: true, description: 'One-sentence description (<=500 chars).' },
      body: { type: 'string', required: true, description: 'Markdown body (<=256 KiB).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const r: any = await deps.rulesOps['rules-create'](args)
      if (!r || r.ok === false) throw new Error((r && r.error) || '创建规则失败')
      return 'OK: memory ' + r.rule.id + '（场景「' + (r.rule.group || '未归属') + '」启用后自动生效）'
    },
  }))
}
