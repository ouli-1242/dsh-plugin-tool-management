// 控制面工具 `tool_manager_tools`：模型自己看得到哪些工具、能不能自己打开。
//
// 为什么要有它：插件出厂只发 6 条工具（`src/tools/table.ts` 的 `DEFAULT_HIDDEN_TOOLS`
// 关掉 20 条）。场景那一族**四条全关**，而场景目录注入只列**当前已启用的**场景 ——
// 一个都没启用时整段不注入（`src/memories/constants.ts` 的 `SCENE_CATALOG_MAX_BYTES` 注释）。
// 于是「用户说进入编程场景」这件事，模型既不知道有哪些场景，也没有开关工具：
// 零信息 + 零手段，是死局。
//
// 这条工具把那个死局解开：**按需**查（列清单）、**按需**开（只对本对话）。
// 它是唯一必须常驻的一条（其余能力一律按需调用，不进每轮的 schema）。
//
// 边界（有意不做的事）：
//   · 只写**管着这个对话的那一层**：按会话 = 这个对话；按工作区 = 这个工作区（那一层本来就
//     是同工作区共享的）；隔离关掉（全局）时没有会话层，管着这个对话的就是全局那一份 ——
//     那一档是机器级改动，调用前会被确认卡问过。
//   · 只认本插件注册过的工具名：MCP 工具归 MCP 停用表管，混进来会写出官方 restrict 认不出的名字。
//   · 自己不可被关：唯一的回头路不能被自己关掉（面板仍然可以关）。

import { text, type ToolDomainDeps } from './deps.js'
import { governingScopeNote } from './deps.js'
import { estimateTok } from './table.js'

/** 控制面工具要的依赖：本插件的工具清单 + 会话工具表的读写。 */
export interface ControlToolDeps extends ToolDomainDeps {
  /** 本插件注册过的工具（名字 → 定义体积，字节）。 */
  toolTableSizes: Map<string, number>
  /** 工具名 → 一句话用途（描述首句）。 */
  toolTableSummaries: Map<string, string>
  /**
   * 本对话当前生效的关停名单（会话层与全局并完的值）。
   *
   * 返回的是**并完**的那份：会话没有自己的名单时就是全局那份 —— 面板上看到的
   * 「这个对话看得见几条」与模型看到的必须是同一份。
   */
  hiddenForSession(agent: unknown): ReadonlySet<string>
  /**
   * 写管着这个对话的那一层的工具表（整份关停名单）。
   *
   * 走面板同一条写路径（`tool-table` op），所以锁、基线补写、可见性重排、两个目录重算
   * 全都照旧 —— 这里不另写一份。带 sessionId 时写会话那一层，不带时写全局那一份
   * （隔离关掉时没有会话层，管着这个对话的就是全局那份；那一档是机器级改动，
   * 调用前已被确认卡问过）。
   */
  writeSessionTable(agent: unknown, hidden: string[]): Promise<{ ok: boolean; error?: string }>
  /**
   * 修复类动作：把**已损坏**的侧车改名留存、按空表继续。
   *
   * 这三个 op 在登记表里刻意**不冻结**（恢复路径不能被场景锁挡在门外），但模型此前
   * 根本没有入口 —— 侧车一坏，模型手里的写操作全被拒，而它一个出口都没有。
   * 破坏性（原始文件被改名留存），所以走确认卡（判据在 `src/confirm-gate.ts`）。
   */
  repair(kind: 'memory-index' | 'scope' | 'mcp-disabled'): Promise<{ ok: boolean; error?: string; message?: string }>
}

/** 一行清单：名字 · 用途 · ≈token。 */
function toolLine(name: string, summary: string, bytes: number): string {
  const purpose = summary === '' ? '' : ' — ' + summary
  return '- ' + name + purpose + ' (≈' + estimateTok(bytes) + ' tok/turn)'
}

/** 这条工具自己的名字（自己不可被关的那条判据用）。 */
const CONTROL_TOOL_NAME = 'tool_manager_tools'

/**
 * 注册控制面工具（`tool_manager_tools`）。
 *
 * 只做三件事：列清单、开工具、关工具。**没有第四件** ——
 * 「打开之后立刻用那条工具」的动作没有做：它要么绕过宿主的工具执行管线
 * （审批、输出校验都在那条管线上），要么依赖宿主「每个模型请求重新解析一次工具集」
 * 这个尚未核实的时序。前者不安全，后者大概率不需要（工具表是**作用域级**的限制，
 * 放开之后下一次请求组 schema 时就带上了）。
 */
export function buildControlTools(deps: ControlToolDeps): void {
  const { defineTool, register } = deps
  try {
    register(defineTool({
      name: CONTROL_TOOL_NAME,
      description:
        'Turn this plugin\'s own tools on or off for the scope that governs this conversation '
        + '(this conversation, its whole workspace under workspace isolation, or every conversation once isolation is off). '
        + 'Call `list` when the user asks for something this conversation cannot do yet (e.g. switching scene while the scene tools are off): it returns the tools that are off here, one line each. '
        + '`enable`/`disable` take one or more names and apply from the next request.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'enable', 'disable', 'repair'],
          description: 'list = tools off here; enable / disable = turn them on / off here; repair = fix a broken sidecar.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names from `list`.',
        },
        target: {
          type: 'string',
          enum: ['memory-index', 'scope', 'mcp-disabled'],
          description: 'For repair: memory-index | scope | mcp-disabled.',
        },
      },
      output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => text(String(v)) },
      async execute(args: any, exec: any) {
        const action = String((args && args.action) || '').trim()
        const agent = exec && (exec as { agent?: unknown }).agent
        if (action === 'list') return listTools(deps, agent)
        if (action === 'repair') return repairState(deps, args)
        if (action !== 'enable' && action !== 'disable') {
          throw new Error('unknown action: ' + (action === '' ? '(missing)' : action) + ' — use list, enable, disable or repair')
        }
        const requested: string[] = (Array.isArray(args && args.tools) ? args.tools : [])
          .map((n: unknown) => String(n ?? '').trim())
          .filter((n: string) => n !== '')
        if (requested.length === 0) throw new Error('missing argument: tools — the names of the tools to ' + action)
        // 只认本插件注册过的名字：陌生名字写进关停名单会让官方的 restrict 抛错。
        const known = requested.filter((n: string) => deps.toolTableSizes.has(n))
        const unknown = requested.filter((n: string) => !deps.toolTableSizes.has(n))
        if (known.length === 0) {
          throw new Error('none of these are this plugin\'s tools: ' + requested.join(', ') +
            ' — call list to see the names')
        }
        // 自己不可被关：这条工具是模型唯一的回头路，关掉它就再也开不回来
        // （面板仍然可以关 —— 用户说了算）。
        if (action === 'disable' && known.includes(CONTROL_TOOL_NAME)) {
          throw new Error('this tool cannot switch itself off — it is the only way back to the others. Only the user can disable it (in the panel).')
        }
        const hidden = deps.hiddenForSession(agent)
        const next = action === 'enable'
          ? [...hidden].filter((n: string) => !known.includes(n))
          : [...hidden, ...known.filter((n: string) => !hidden.has(n))]
        const saved = await deps.writeSessionTable(agent, next)
        if (!saved.ok) throw new Error(saved.error || 'failed to save the tool table for this conversation')
        const changed = action === 'enable' ? known.filter((n) => hidden.has(n)) : known.filter((n) => !hidden.has(n))
        const lines = [
          'OK: ' + (action === 'enable' ? 'enabled' : 'disabled') + ': ' + (changed.join(', ') || '(nothing changed)')
            + governingScopeNote(deps) + '.',
          'These take effect from the next request.',
        ]
        if (unknown.length > 0) lines.push('not this plugin\'s tools (ignored): ' + unknown.join(', '))
        // 说清「这一层看得见的条数」：模型据此判断自己还有没有别的路。
        const total = deps.toolTableSizes.size
        lines.push((total - next.length) + ' of ' + total + ' tools are available here now.')
        return lines.join('\n')
      },
    }))
  } catch (e) {
    console.error('[dsh-plugin-tool-management] control tool registration failed:', deps.message(e))
  }
}

/**
 * 修复动作：把已损坏的侧车改名留存、按空表继续。
 *
 * 回执要把「修好了什么」和「原来的数据去哪了」都写出来：被隔离的文件还在（改名留存），
 * 但插件从此不再读它 —— 模型说「已修复」时，用户得知道代价是什么。
 */
async function repairState(deps: ControlToolDeps, args: any): Promise<string> {
  const target = String((args && args.target) || '').trim()
  if (target !== 'memory-index' && target !== 'scope' && target !== 'mcp-disabled') {
    throw new Error('missing argument: target — memory-index, scope or mcp-disabled')
  }
  const r = await deps.repair(target)
  if (!r || r.ok === false) throw new Error((r && r.error) || 'repair failed')
  const lines = ['OK: repaired ' + target + '.']
  if (r.message) lines.push(String(r.message))
  lines.push('The damaged file was renamed aside, not deleted; the plugin now continues with an empty table, so whatever it held no longer applies.')
  return lines.join('\n')
}

/**
 * 列出本对话现在**关着**的工具（能打开的那些）。
 *
 * 只列关着的：看得见的那些模型手里已经有 schema了，重复列一遍只是浪费上下文。
 */
function listTools(deps: ControlToolDeps, agent: unknown): string {
  const hidden = deps.hiddenForSession(agent)
  const rows: string[] = []
  for (const [name, bytes] of deps.toolTableSizes) {
    if (!hidden.has(name)) continue
    rows.push(toolLine(name, deps.toolTableSummaries.get(name) ?? '', bytes))
  }
  const total = deps.toolTableSizes.size
  if (rows.length === 0) {
    return 'every tool of this plugin is already on here (' + total + ' tools); nothing to enable.'
  }
  return 'tools switched off here (' + rows.length + ' of ' + total + '):\n' +
    rows.join('\n') +
    '\ncall this tool with action="enable" and the names you need (one or more).'
}
