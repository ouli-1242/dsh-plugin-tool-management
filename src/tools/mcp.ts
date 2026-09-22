// MCP 域的 model 工具（2026-09-19 从 index.ts 的注册区抽出）：
// mcp_manager_list / mcp_manager_set_enabled / mcp_manager_restart / mcp_manager_add。

import { DEFAULT_MCP_NOTE_MAX_LENGTH, normalizeMcpNote } from '../mcp/state-section.js'
import { text, type ToolDomainDeps } from './deps.js'

export interface McpToolDeps extends ToolDomainDeps {
  /** MCP 列表视图（含备注、已打码）。 */
  mcpmListView(): Promise<any>
  mcpmSetEnabled(args: { id: string; level: string; enabled: boolean }): Promise<any>
  mcpmRestart(args: { id: string; level: string }): Promise<any>
  mcpmAdd(args: any): Promise<any>
}

export function buildMcpTools(deps: McpToolDeps): void {
  const { defineTool, register } = deps
  register(defineTool({
    name: 'mcp_manager_list',
    description: 'List configured MCP servers (level, enabled state, live loader status, tool count excluding switched-off tools, note). Read a server\'s note before choosing it. The same list is injected into your context each turn (the「本机 MCP 服务器的当前状态」system-reminder); this tool is the raw view — all=true includes disabled servers. Defaults to enabled servers; pass all=true for every configured server.',
    parameters: {
      all: { type: 'boolean', description: 'Include disabled servers (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      // 必须走 mcpmListView()（= mcpmRowsWithNotes(false)）：备注在这里合入，且未打码的
      // url/headers/env 已被打码。备注是本插件 MCP 这一项的真正价值（用户写给未来模型的
      // 决策提示，如「A 挂了改用 B」），而它只走注入通道 —— 压制型预设下不注入时，
      // 这里就是唯一的读取路径。
      const r = await deps.mcpmListView()
      if (!r.ok) throw new Error(r.error)
      const all: any[] = r.rows || []
      // 默认只列「已启用」的（用户裁定 2026-09-16，与技能 / 记忆列表同口径）：停用的服务器
      // 模型调不到，列出来只是噪音。表头给出全量口径，所以不会变成盲区。
      const shown = showAll ? all : all.filter((x: any) => !x.disabled)
      const summary = shown.map((x: any) => {
        const note = normalizeMcpNote(x.notes, DEFAULT_MCP_NOTE_MAX_LENGTH)
        // 工具数 = 可用数（停用表扣减后）：段里给模型的是同一个口径，模型据此与
        // 自己 schema 里的 `mcp__*` 工具对得上；被场景收窄 / 手动关掉的工具不算。
        const usableTools = typeof x.enabledToolCount === 'number' ? x.enabledToolCount : x.toolCount
        return x.id + ' | ' + x.serverName + ' | ' + x.level + ' | ' + (x.disabled ? 'disabled' : 'enabled') +
          (x.live ? ' | loader:' + (x.live.enabled ? 'on' : 'off') + (x.live.phase ? ':' + x.live.phase : '') : '') +
          (typeof usableTools === 'number' ? ' | tools:' + usableTools : '') +
          (note ? ' | user-hint:' + note : '')
      })
      const header = 'MCP servers: ' + (showAll
        ? all.length + ' configured'
        : shown.length + ' enabled of ' + all.length + ' configured' +
          (shown.length === all.length ? '' : ' (pass all=true for every configured server)')) + '\n'
      // 注入边界：压制型预设（persona complete / 关闭运行时上下文，如极简）下本插件
      // 默认不注入 —— 模型只有 mcp__* 的工具名与参数，没有服务级信息。不说明的话，
      // 模型会把「能调用这些工具」当成「已经知道有哪些 server、用户给它们写了什么备注」。
      // 提示本身不点名任何工具，所以挂在哪个发现型工具上都不会出现循环指引。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + (summary.join('\n') || '(none)') + notice
    },
  }))
  register(defineTool({
    name: 'mcp_manager_set_enabled',
    description: 'Enable or disable one configured MCP server (writes the patch file; hot-reloaded). Only when the user asks or approves.',
    parameters: {
      id: { type: 'string', required: true, description: 'Entry id of the MCP server, e.g. mcp-stepfun-web-search.' },
      level: { type: 'string', required: true, description: 'project or global.' },
      enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const r = await deps.mcpmSetEnabled({ id: args.id, level: args.level, enabled: args.enabled })
      if (!r.ok) throw new Error(r.error)
      // 场景未锁定时，页面 / 模型改的开关都要落进当前场景的档案（与 handlers 层同一套同步）。
      const syncErr = await deps.syncSwitchToScene('mcpm-set-enabled', args)
      return 'OK: ' + args.id + ' now ' + (args.enabled ? 'enabled' : 'disabled') +
        (syncErr ? '\nWARN: 当前场景档案未同步（' + syncErr + '）' : '')
    },
  }))
  register(defineTool({
    name: 'mcp_manager_restart',
    description: 'Restart one configured MCP server (disable + re-enable; reconnects and re-syncs tools). Only when the user asks or approves.',
    parameters: {
      id: { type: 'string', required: true, description: 'Entry id of the MCP server, e.g. mcp-stepfun-web-search.' },
      level: { type: 'string', required: true, description: 'project or global.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const r = await deps.mcpmRestart({ id: args.id, level: args.level })
      if (!r.ok) throw new Error(r.error)
      return 'OK: ' + args.id + ' restarted'
    },
  }))
  register(defineTool({
    name: 'mcp_manager_add',
    description: 'Add a new MCP server (streamable-http or stdio) at project or global level. Only on the user\'s explicit request.',
    parameters: {
      serverName: { type: 'string', required: true, description: 'Unique server name (1-32 chars, [A-Za-z0-9_-]).' },
      transport: { type: 'string', required: true, description: 'streamable-http or stdio.' },
      url: { type: 'string', description: 'Server URL (required for streamable-http).' },
      command: { type: 'string', description: 'Executable (required for stdio).' },
      args: { type: 'string', description: 'Arguments, space separated (stdio).' },
      headers: { type: 'string', description: 'Extra headers as key=value lines (streamable-http).' },
      env: { type: 'string', description: 'Extra env vars as key=value lines (stdio).' },
      level: { type: 'string', description: 'project or global (default project).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const r = await deps.mcpmAdd(args)
      if (!r.ok) throw new Error(r.error)
      return 'OK: added ' + r.row.id + ' at ' + r.row.level
    },
  }))
}
