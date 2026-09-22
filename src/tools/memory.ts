// 记忆（rules）域的 model 工具（2026-09-19 从 index.ts 的注册区抽出）：
// memory_manager_list / _read / _write / _set_enabled / _update。
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
    description: 'List memories (id, scene, enabled, description). What is injected each turn is in the「本机当前的场景和记忆」reminder; use this for ids/paths and for entries that are off. Defaults to the ones that would be injected; all=true for every entry.',
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
    description: 'Read the full body of one memory. Only for ones not already in your context (disabled, scene not active, or dropped by the byte budget).',
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
    name: 'memory_manager_set_enabled',
    // 为什么单独一个工具：注入实况里「这个域注入了几次 / 模型调了几次」都看得到，但模型此前
    // 看得到一份记忆却开关不了它 —— 只能回一句"请你去界面上点"。启停是它替用户调整环境时
    // 最常碰的一格，而 `rules-toggle` 这个 op 早就带齐了门禁（写令牌 + 场景冻结）。
    // 三个写侧工具共用一句 consent（`Only when the user asks or approves.` / `Only on the
    // user's instruction.`）：这些动的都是"以后每一轮都会带上"的东西，模型不该顺手做。
    // 描述同时按"省 token"重写了一遍 —— 这 20 段文字每次请求都要发出去，废话是常驻成本。
    description: 'Enable or disable one memory (index switch; the .md file is untouched). Disabled memories stop being injected, freeing the byte budget. Prefer this over deleting — it is reversible. Only when the user asks or approves.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id like <scene>/<name> (from memory_manager_list).' },
      enabled: { type: 'boolean', required: true, description: 'true = enable, false = disable; omission is refused.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const r: any = await deps.rulesOps['rules-toggle'](args)
      if (!r || r.ok === false) throw new Error((r && r.error) || '切换记忆启停失败')
      const rule = r.rule || {}
      // 「启用了一条不在启用场景里的记忆」是一次静默无效：单条开关拨上去了,注入集里却没有它。
      // 这一句不说,模型会以为已经生效 —— 与 skill_manager_set_enabled 说清影子副本同一条理由。
      let sceneNote = ''
      try {
        const all: any = await deps.rulesOps['rules-list']({})
        if (all && all.ok !== false) {
          const group = String(rule.group || '')
          const on = group === 'global' || (group !== '' && (all.activeMode === 'all' || String(all.activeScene || '') === group))
          if (!on) sceneNote = ' — BUT its scene「' + group + '」is not the active one, so it still will not be injected; enable that scene (or move it to global) first'
        }
      } catch { sceneNote = '' }
      return 'OK: memory ' + String(rule.id || args.id) + ' ' + (rule.enabled === false ? 'disabled' : 'enabled') + sceneNote
    },
  }))
  register(defineTool({
    name: 'memory_manager_update',
    description: 'Update a memory: body, description, or name (renaming keeps the old file in the trash). Omit a field to keep it — this merges. Read it with memory_manager_read first and change one part rather than restating the file; if a memory already covers this, update that one instead of adding a second. Only on the user\'s instruction.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id like <scene>/<name> (from memory_manager_list).' },
      body: { type: 'string', description: 'New Markdown body (<=256 KiB, non-empty). Omit to keep the current body.' },
      description: { type: 'string', description: 'New one-sentence description (<=500 chars). Empty string = drop it and re-derive from the body; omit = keep.' },
      name: { type: 'string', description: 'New memory name (= file name). Omit to keep it.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      // 三个可改字段一个都没给 → 直接拒。`rules-update` 会按"保留现有"落一次盘并刷新
      // updatedAt,模型以为改了点什么,其实只是把文件重写了一遍。
      const touches = ['body', 'description', 'name'].filter((k) => (args as Record<string, unknown>)[k] !== undefined)
      if (!touches.length) throw new Error('没有要改的东西：body / description / name 至少给一个')
      const r: any = await deps.rulesOps['rules-update'](args)
      if (!r || r.ok === false) throw new Error((r && r.error) || '更新记忆失败')
      const rule = r.rule || {}
      return 'OK: updated ' + String(rule.id || args.id) + '（改了 ' + touches.join('、') + '）' +
        (rule.id && String(rule.id) !== String(args.id) ? ' → 现在是 ' + rule.id : '')
    },
  }))
  register(defineTool({
    name: 'memory_manager_write',
    // 「能推导的别记」「先查重」这两句是 0.13.0 加的：记忆是唯一直接吃注入预算的域
    // （场景段 128 KiB），而模型很乐意把「这个项目用 pnpm」记一条 —— 那看一眼 `package.json`
    // 就知道，记下来却永久占着每一轮请求。
    description: 'Create a memory (the scene must already exist; global is the always-on one). Memories cost context on EVERY later request, so record only what cannot be re-derived from code, config or git, and check the list for one that already says this — update that instead of adding a near-duplicate. Only on the user\'s instruction.',
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
      // 先扫一遍已有的：疑似重复只**说出来**，不拒绝 —— 猜错一次就把该记的东西记不下去，
      // 比多记一条代价大得多；而且"像不像同一条"本来就是人判断的事。
      const norm = (value: unknown): string => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
      const wantName = norm(args && args.name)
      const wantDesc = norm(args && args.description)
      let similar: string[] = []
      try {
        const before: any = await deps.rulesOps['rules-list']({})
        if (before && before.ok !== false) {
          similar = (before.rules || [])
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
        }
      } catch { /* 查重读不到就当没查到：它不该拦住写入 */ }
      const r: any = await deps.rulesOps['rules-create'](args)
      if (!r || r.ok === false) throw new Error((r && r.error) || '创建规则失败')
      // 刚建好的这条自己会在列表里，从名单里去掉。
      similar = similar.filter((id) => id !== String(r.rule.id))
      const dup = similar.length
        ? `\n注意：已有 ${similar.length} 条名字或描述与它很像（${similar.join('、')}）—— 若是同一件事，改那一条而不是留着两条。`
        : ''
      return 'OK: memory ' + r.rule.id + '（场景「' + (r.rule.group || '未归属') + '」启用后自动生效）' + dup
    },
  }))
}
