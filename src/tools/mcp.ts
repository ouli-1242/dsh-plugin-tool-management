// MCP 域的 model 工具（2026-09-19 从 index.ts 的注册区抽出；2026-09-23 合并）：
// mcp_manager_list / mcp_manager_switch / mcp_manager_save。
//
// 两条合并理由（0.14.0 用户裁定）：
//   · set_enabled + restart → switch：两者都是"拨一下这台服务器"，只是动词不同。合并后
//     由 `action` 自报动词，工具名不再需要用长度去区分"启停"与"重启"。
//   · add + edit → save：改一台已配置的服务器（含 URL / 命令）与新增一台危险度同级
//     （stdio 都是宿主按你给的 command 起进程），所以合并后**确认门必须留在 save 上**。
//
// 冻结口径跟着 `src/op-registry.ts` 走，不是"整条工具一刀切"：`mcpm-set-enabled` 与
// `mcpm-tool-enabled` 在登记表里是 `frozen: true`，而 `mcpm-restart` 明确**不冻结**
// —— 锁定期间它是唯一还能落盘改补丁的入口，是"卡住了重连一下"这条恢复路径。
// 所以 switch 里只有 on|off 过 `lockedSceneGuard()`，restart 不过；与面板侧
// `guardLockedOps(frozenOps('all'))` 的口径逐字一致（两处口径不同才是真的"说假话"）。
//
// **改一台已配置服务器时绝不读明文凭据**：`mcpm-edit` 的守卫（`resolveMaskedKv` /
// `resolveMaskedUrl`）就是为"接受打码值并还原"写的 —— 界面编辑框预填的本来就是打码值。
// 所以这里拿 `mcpmListView()` 的**打码视图**把模型没给的字段填回去，让 op 去还原。
// 反过来说，绝不能**省略**字段：`parseKv(undefined)` 返回 `{}`（不是 undefined），
// `mcpm-edit` 里那句 `if (row[field] === undefined) return` 就不会生效，于是
// `resolveMaskedKv({}, 旧值)` 把整份 headers / env 静默清空、连 warning 都不给。

import { DEFAULT_MCP_NOTE_MAX_LENGTH, normalizeMcpNote } from '../mcp/state-section.js'
import { text, type ToolDomainDeps } from './deps.js'

export interface McpToolDeps extends ToolDomainDeps {
  /** MCP 列表视图（含备注、已打码）。 */
  mcpmListView(): Promise<any>
  /** 单台服务器的工具预览（`mcpm-tools`）：名字 + 描述 + 是否被单独关掉。 */
  mcpmTools(args: { serverName: string }): Promise<any>
  mcpmSetEnabled(args: { id: string; level: string; enabled: boolean }): Promise<any>
  mcpmRestart(args: { id: string; level: string }): Promise<any>
  mcpmToolEnabled(args: { serverName: string; tool: string; enabled: boolean }): Promise<any>
  mcpmAdd(args: any): Promise<any>
  mcpmEdit(args: any): Promise<any>
  mcpmNote(args: { id: string; note: string }): Promise<any>
}

/** 「去看清单」那句：`mcp_manager_list` 被关掉时不能点名它（调用方按 `toolVisible` 决定给不给）。 */
const MCP_LIST_HINT = '（用 mcp_manager_list 看清单，all=true 连停用的也列）'

/** 按 serverName 定位条目；同名（project + global 各一台）时要求 level 明确指定。 */
function locate(rows: any[], server: string, level?: string, listHint: string = MCP_LIST_HINT): any {
  const hits = (rows || []).filter((r) => String(r.serverName) === server)
  if (!hits.length) {
    throw new Error('没有这台服务器：' + server + listHint)
  }
  if (level) {
    const picked = hits.filter((r) => r.level === level)
    if (!picked.length) {
      throw new Error('「' + server + '」没有 level=' + level + ' 的那一台（现有：' + hits.map((r) => r.level).join(' / ') + '）')
    }
    return picked[0]
  }
  if (hits.length > 1) {
    throw new Error('「' + server + '」在 ' + hits.map((r) => r.level).join(' 与 ') + ' 各有一台，无法确定动哪一台 —— 传 level 指定')
  }
  return hits[0]
}

/**
 * 打码过的键值映射 → `mcpm-edit` / `mcpm-add` 要的文本形态（每行 `K=V`）。
 *
 * 打码值原样带过去是**有意**的：`resolveMaskedKv` 会把 `••••••` 认成"这一项没改"，
 * 拿补丁文件里的真值顶替回来；非敏感键（`maskValueMap` 只打敏感键）本来就是明文，原样往返。
 */
function kvToText(map: any): string {
  if (!map || typeof map !== 'object') return ''
  return Object.keys(map).map((k) => k + '=' + String(map[k])).join('\n')
}

/** 行数组形态的 args → op 要的空格分隔文本（op 侧 `parseArgs` 再拆回来）。 */
function argsToText(value: any): string {
  return Array.isArray(value) ? value.join(' ') : String(value == null ? '' : value)
}

export function buildMcpTools(deps: McpToolDeps): void {
  const { defineTool, register } = deps
  /** 那句"去看清单"要不要给：`mcp_manager_list` 在出厂默认里就是关着的，点名一条模型没有的工具
   *  只会让它白跑一趟（执行侧拦住它，而它看不出为什么）。 */
  const listHint = () => (deps.toolVisible('mcp_manager_list') ? MCP_LIST_HINT : '')
  register(defineTool({
    name: 'mcp_manager_list',
    // 注入段与本工具的关系要**如实说成筛过的视图**（而非"同一份清单"）：注入段只列可用 +
    // 曾连上现掉线的服务器（停用的不进），也不带 level / loader / 工具数。把这个盲区写出来
    // 是行动依据 —— 模型要知道"停用的那台去哪查"就得靠这句（all=true）。
    description: 'List configured MCP servers (level, enabled state, live loader status, tool count excluding switched-off tools, note). Read a server\'s note before choosing it. The「本机 MCP 服务器的当前状态」reminder carries a filtered view (usable servers, ones that were reachable before but are down now, and their notes; disabled servers are omitted); this tool is the raw view — defaults to enabled servers, all=true for every configured one.',
    parameters: {
      all: { type: 'boolean', description: 'Include disabled servers (default false).' },
      tools: { type: 'boolean', description: 'Also list each server\'s tool names, marking the switched-off ones (default false).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const showAll = Boolean(args && args.all === true)
      const showTools = Boolean(args && args.tools === true)
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
      const lines: string[] = []
      for (const x of shown) {
        const note = normalizeMcpNote(x.notes, DEFAULT_MCP_NOTE_MAX_LENGTH)
        // 工具数 = 可用数（停用表扣减后）：段里给模型的是同一个口径，模型据此与
        // 自己 schema 里的 `mcp__*` 工具对得上；被场景收窄 / 手动关掉的工具不算。
        const usableTools = typeof x.enabledToolCount === 'number' ? x.enabledToolCount : x.toolCount
        lines.push(x.id + ' | ' + x.serverName + ' | ' + x.level + ' | ' + (x.disabled ? 'disabled' : 'enabled') +
          (x.live ? ' | loader:' + (x.live.enabled ? 'on' : 'off') + (x.live.phase ? ':' + x.live.phase : '') : '') +
          (typeof usableTools === 'number' ? ' | tools:' + usableTools : '') +
          (note ? ' | user-hint:' + note : ''))
        if (!showTools) continue
        // 工具名单只在要的时候才去问：`mcpm-tools` 要读 schemas() + 停用表 + 「上次见过」缓存，
        // 是这次列表里最贵的一步，而默认口径（只列服务器）根本用不上它。
        // **不调 `mcpm-tools-refresh`**：那个会临时起进程（npx 冷启动可能几十秒），
        // 那是界面上的显式动作，不该由一次列表调用顺手触发。
        const t: any = await deps.mcpmTools({ serverName: String(x.serverName) })
        const items: any[] = t && t.ok !== false ? (t.tools || []) : []
        if (!items.length) {
          lines.push('    ' + (x.disabled ? '(tools not recorded: server is off)' : '(no tools recorded)'))
          continue
        }
        lines.push('    tools: ' + items.map((it: any) => it.name + (it.enabled === false ? ' (off)' : '')).join(', '))
      }
      const header = 'MCP servers: ' + (showAll
        ? all.length + ' configured'
        : shown.length + ' enabled of ' + all.length + ' configured' +
          (shown.length === all.length ? '' : ' (pass all=true for every configured server)')) + '\n'
      // 注入边界：压制型预设（persona complete / 关闭运行时上下文，如极简）下本插件
      // 默认不注入 —— 模型只有 mcp__* 的工具名与参数，没有服务级信息。不说明的话，
      // 模型会把「能调用这些工具」当成「已经知道有哪些 server、用户给它们写了什么备注」。
      // 提示本身不点名任何工具，所以挂在哪个发现型工具上都不会出现循环指引。
      const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
      return header + (lines.join('\n') || '(none)') + notice
    },
  }))
  register(defineTool({
    name: 'mcp_manager_switch',
    // 为什么 action 是必填枚举而不是两个可选布尔：模型最容易犯的错是"想重启却只传了 server"，
    // 让它在三个动词里选一个，比让它猜两个布尔的组合省一次往返。
    description: 'Turn one configured MCP server on or off, or restart it (reconnects and re-syncs tools). Pass `tool` to switch just that tool. Only when the user asks or approves.',
    parameters: {
      server: { type: 'string', required: true, description: 'Server name as shown in the list.' },
      action: { type: 'string', required: true, enum: ['on', 'off', 'restart'], description: 'on = enable, off = disable, restart = reconnect and re-sync tools.' },
      level: { type: 'string', description: 'project or global — only to disambiguate same-name servers.' },
      tool: { type: 'string', description: 'One tool name on that server (no mcp__ prefix). Only for on/off.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any) {
      const action = String((args && args.action) || '')
      if (action !== 'on' && action !== 'off' && action !== 'restart') {
        throw new Error('action 只能是 on / off / restart（收到：' + (action || '(空)') + '）')
      }
      const server = String((args && args.server) || '').trim()
      const tool = args && args.tool !== undefined ? String(args.tool).trim() : ''
      if (tool !== '' && action === 'restart') {
        throw new Error('重启是整台服务器的动作（先停用、等断开、再按原状态启用），不能只重启一个工具')
      }
      // on|off 会写补丁（`mcpm-set-enabled` / `mcpm-tool-enabled` 在登记表里是 frozen），
      // 所以过场景冻结守卫；restart 不过 —— 它是锁定期间唯一的恢复入口（见文件头）。
      if (action !== 'restart') {
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
      }
      const list = await deps.mcpmListView()
      if (!list || list.ok === false) throw new Error((list && list.error) || '读取 MCP 配置失败')
      const level = args && args.level !== undefined ? String(args.level) : undefined
      const row = locate(list.rows || [], server, level, listHint())
      const enabled = action === 'on'

      if (tool !== '') {
        const r: any = await deps.mcpmToolEnabled({ serverName: String(row.serverName), tool, enabled })
        if (!r || r.ok === false) throw new Error((r && r.error) || '切换工具启停失败')
        // 与面板同一条同步：`mcpm-tool-enabled` 在登记表里带 syncsArchive，漏了就是
        // "页面拨的进档案、模型拨的不进"。
        const syncErr = await deps.syncSwitchToScene('mcpm-tool-enabled', { serverName: String(row.serverName), tool, enabled })
        // 整台停用时，工具级开关在运行时本来就不生效（那个工具压根不存在）—— 不说的话
        // 模型会以为已经生效。与记忆族"启用了一条不在启用场景里的记忆"同一条理由。
        const offNote = row.disabled ? '（注意：整台服务器当前是停用的，这个工具级开关要等它启用才生效）' : ''
        return 'OK: ' + String(row.serverName) + ' tool ' + tool + ' now ' + (enabled ? 'enabled' : 'disabled') + offNote +
          (syncErr ? '\nWARN: 当前场景档案未同步（' + syncErr + '）' : '')
      }

      if (action === 'restart') {
        const r: any = await deps.mcpmRestart({ id: row.id, level: row.level })
        if (!r || r.ok === false) throw new Error((r && r.error) || '重启失败')
        return 'OK: ' + String(row.serverName) + ' (' + row.level + ') restarted'
      }

      const r: any = await deps.mcpmSetEnabled({ id: row.id, level: row.level, enabled })
      if (!r || r.ok === false) throw new Error((r && r.error) || '切换服务器启停失败')
      // 场景未锁定时，页面 / 模型改的开关都要落进当前场景的档案（与 handlers 层同一套同步）。
      const syncErr = await deps.syncSwitchToScene('mcpm-set-enabled', { id: row.id, level: row.level, enabled })
      return 'OK: ' + String(row.serverName) + ' (' + row.level + ') now ' + (enabled ? 'enabled' : 'disabled') +
        (syncErr ? '\nWARN: 当前场景档案未同步（' + syncErr + '）' : '')
    },
  }))
  register(defineTool({
    name: 'mcp_manager_save',
    description: 'Add a new MCP server, or update the one with this name — the receipt says which. Omitted fields keep their current values, so never restate the whole server. Only on the user\'s explicit request.',
    parameters: {
      server: { type: 'string', required: true, description: 'Server name (1-32 chars, [A-Za-z0-9_-]) — the name the mcp__<server>__ tools use.' },
      transport: { type: 'string', description: 'streamable-http or stdio. Required when creating; omit = keep.' },
      url: { type: 'string', description: 'Server URL (streamable-http). Omit = keep.' },
      command: { type: 'string', description: 'Executable to spawn (stdio). Omit = keep.' },
      args: { type: 'string', description: 'Arguments, space separated (stdio). Omit = keep.' },
      headers: { type: 'string', description: 'Extra headers, key=value per line (streamable-http). Omit = keep — omitting is what preserves the real secrets.' },
      env: { type: 'string', description: 'Extra env vars, key=value per line (stdio). Omit = keep.' },
      level: { type: 'string', description: 'project or global (project when creating); only needed for same-name servers.' },
      note: { type: 'string', description: 'Short hint for later: how to use it, or which one to fall back to when it is down.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const server = String((args && args.server) || '').trim()
      if (!server) throw new Error('缺少参数：server（服务器名）')
      const levelArg = args && args.level !== undefined ? String(args.level) : undefined
      const noteText = args && args.note !== undefined ? String(args.note) : ''
      const hasNote = noteText.trim() !== ''
      const list: any = await deps.mcpmListView()
      if (!list || list.ok === false) throw new Error((list && list.error) || '读取 MCP 配置失败')
      const rows: any[] = list.rows || []
      const hits = rows.filter((r) => String(r.serverName) === server)

      // ── 建：transport 与它那一侧的必填项都得给 ─────────────────────────────
      if (!hits.length) {
        const transport = String((args && args.transport) || '').trim()
        if (transport !== 'stdio' && transport !== 'streamable-http') {
          throw new Error('新建服务器必须给 transport：stdio 或 streamable-http')
        }
        if (transport === 'stdio' && String((args && args.command) || '').trim() === '') {
          throw new Error('新建 stdio 服务器必须给 command（宿主会按它 spawn 进程）')
        }
        if (transport === 'streamable-http' && String((args && args.url) || '').trim() === '') {
          throw new Error('新建 streamable-http 服务器必须给 url')
        }
        const payload: any = {
          serverName: server,
          transport,
          url: args.url,
          command: args.command,
          args: args.args,
          headers: args.headers,
          env: args.env,
        }
        if (levelArg) payload.level = levelArg
        const r: any = await deps.mcpmAdd(payload)
        if (!r || r.ok === false) throw new Error((r && r.error) || '新增服务器失败')
        // 备注单独走 `mcpm-note`（`mcpm-add` 不认这个字段）。失败**不回滚**主写入：
        // 服务器已经建好了，"备注没写上"是 warning，不是失败（与 0.13.0 界面同规格）。
        let warn = ''
        if (hasNote) {
          const n: any = await deps.mcpmNote({ id: String(r.row.id), note: noteText })
          if (!n || n.ok === false) warn = '\nWARN: 服务器已建好，但备注没写进去（' + ((n && n.error) || '未知原因') + '）'
        }
        return 'OK: created ' + r.row.id + ' at ' + r.row.level + warn
      }

      // ── 改：省略 = 保持，且必须**显式填回**（见文件头那条 parseKv 的坑）────────
      const cur = locate(hits, server, levelArg, listHint())
      const transport = args && args.transport !== undefined ? String(args.transport) : String(cur.transport)
      if (transport !== 'stdio' && transport !== 'streamable-http') {
        throw new Error('transport 只能是 stdio 或 streamable-http（这台现在是：' + String(cur.transport) + '）')
      }
      const touched: string[] = []
      const ignored: string[] = []
      if (args.transport !== undefined) touched.push('transport')
      const payload: any = { id: cur.id, level: cur.level, serverName: String(cur.serverName), transport }
      if (transport === 'streamable-http') {
        // url 与 headers 都按**打码形态**填回：`resolveMaskedUrl` / `resolveMaskedKv` 会把它们
        // 还原成补丁文件里的真值。这样"只改 headers"不会把 url 的查询串抹掉，也不会把
        // 没重述的密钥写成 `••••••`。
        if (args.url !== undefined) { payload.url = String(args.url); touched.push('url') } else { payload.url = String(cur.url == null ? '' : cur.url) }
        if (args.headers !== undefined) { payload.headers = String(args.headers); touched.push('headers') } else { payload.headers = kvToText(cur.headers) }
        // 与当前传输方式无关的字段：**说出来**而不是静默丢掉（静默丢输入是"看起来成功"）。
        // 逐项写而不是循环：参数表的类型由宿主签名推断，动态键索引会退化成 any（deps.ts 里
        // 特意保住的正是这份推断）。
        if (args.command !== undefined) ignored.push('command')
        if (args.args !== undefined) ignored.push('args')
        if (args.env !== undefined) ignored.push('env')
      } else {
        if (args.command !== undefined) { payload.command = String(args.command); touched.push('command') } else { payload.command = String(cur.command == null ? '' : cur.command) }
        if (args.args !== undefined) { payload.args = String(args.args); touched.push('args') } else { payload.args = argsToText(cur.args) }
        if (args.env !== undefined) { payload.env = String(args.env); touched.push('env') } else { payload.env = kvToText(cur.env) }
        if (args.url !== undefined) ignored.push('url')
        if (args.headers !== undefined) ignored.push('headers')
      }
      const levelChanged = levelArg !== undefined && levelArg !== cur.level
      // 只给了备注：不必走 `mcpm-edit` 把整条重建一遍（那是一次无意义的写盘 + 刷新 updatedAt），
      // 直接写备注。这与"三个可改字段一个都没给就拒"是同一条理由的两面。
      if (!touched.length && !levelChanged) {
        if (!hasNote) throw new Error('没有要改的东西：transport / url / command / args / headers / env / level / note 至少给一个')
        const n: any = await deps.mcpmNote({ id: cur.id, note: noteText })
        if (!n || n.ok === false) throw new Error((n && n.error) || '写备注失败')
        return 'OK: updated ' + String(cur.serverName) + '（改了 note）'
      }
      const r: any = await deps.mcpmEdit(payload)
      if (!r || r.ok === false) throw new Error((r && r.error) || '修改服务器失败')
      const changed = touched.concat(levelChanged ? ['level'] : [], hasNote ? ['note'] : [])
      let warn = ''
      // `mcpm-edit` 的守卫会把"打码值被顶替回真值"这件事回报出来（只含键名，不含值）——
      // 转给模型，它才知道"我没重述的密钥确实保住了"。
      if (r.warning) warn += '\nNOTE: ' + String(r.warning)
      if (hasNote) {
        const n: any = await deps.mcpmNote({ id: cur.id, note: noteText })
        if (!n || n.ok === false) warn += '\nWARN: 服务器已保存，但备注没写进去（' + ((n && n.error) || '未知原因') + '）'
      }
      if (ignored.length) {
        warn += '\nWARN: ' + ignored.join(' / ') + ' 与当前 transport（' + transport + '）无关，已忽略'
      }
      return 'OK: updated ' + String(cur.serverName) + '（改了 ' + changed.join('、') + '）' + warn
    },
  }))
}
