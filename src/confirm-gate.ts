// 按**这一次调用的参数**决定要不要弹确认卡。
//
// 与 `index.ts` 的 `CONFIRM_LABELS` 分工：那张表回答"这条工具要不要门"，这里回答"这一次
// 要不要门"。必须分开，因为同一个工具不同 action 的危险度差得远：
//
//   · `*_remove` 的 `list` 是读、`restore` 是恢复，只有 `trash` 是删除；
//   · `mcp_manager_switch` 的 `restart` 是服务器挂掉时的恢复路径（场景锁都为它开口），
//     `stop` 才是机器级停机；
//   · `prompt_manager_apply` 的 `apply: false` 是撤销，不是改写。
//
// 一律按工具名挂卡会把恢复路径一起堵住 —— 出事时用户反而要多点一次确认。
//
// 另一半判据是**作用域**：几个 `_switch` 默认写本会话（爆炸半径小），只有显式
// `scope: "global"` 或在全局粒度下才变成机器级。给默认路径也挂卡是纯摩擦。
//
// 本模块保持纯函数：不读磁盘、不看会话、不抛错。参数不成立（缺 id / 不是布尔）时返回
// `null` 让工具自己报错 —— 给一次注定失败的调用弹卡只会产生无效审批。

/** 隔离粒度（与 `scope/scope-overrides.ts` 的 `ScopeMode` 同形，这里只取用到的三档）。 */
export type ConfirmScopeMode = 'global' | 'session' | 'workspace'

/**
 * 需要按参数判定的工具名。
 *
 * 不在这张表里的工具仍走 `CONFIRM_LABELS` 的既有分支（无条件问，或按设置开关问）。
 */
export const ARG_CONDITIONAL_CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  'memory_manager_remove',
  'skill_manager_remove',
  'subagent_manager_remove',
  'scene_manager_remove',
  'prompt_manager_remove',
  'prompt_manager_apply',
  'mcp_manager_switch',
  'memory_manager_switch',
  'skill_manager_switch',
  'subagent_manager_switch',
])

/** 取一个必填字符串参数；不是非空字符串就返回空串。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 这次写入是不是落在机器级：显式 `scope: "global"`，或全局粒度下没有会话层。 */
function machineWide(args: Record<string, unknown>, mode: ConfirmScopeMode): boolean {
  return mode === 'global' || args.scope === 'global'
}

/** 开关类回执里的目标名词，避免每个分支各拼一遍。 */
function removeSubject(name: string): string {
  if (name === 'memory_manager_remove') return 'memory'
  if (name === 'skill_manager_remove') return 'skill'
  if (name === 'subagent_manager_remove') return 'persona'
  if (name === 'scene_manager_remove') return 'scene'
  return 'AGENTS.md preset'
}

/**
 * 这一次调用要不要问用户；要问就返回卡上那句理由，不问返回 `null`。
 *
 * @param name 工具名（大小写与注册名一致）。
 * @param rawArgs 工具入参（模型给的那一份，未校验）。
 * @param mode 当前隔离粒度；`global` 下所有开关写入都是机器级。
 * @returns 确认卡的理由；`null` = 不拦，调用方直接 `next()`。
 * @remarks
 * 只有 `remove` 的 `trash`、`mcp_switch` 的 `stop` 与全局 `on`/`off`、`prompt_apply` 的
 * 正向应用、以及三个 `_switch` 的机器级写入会返回理由。其余 action（`list`/`restore`/
 * `restart`/`apply:false`/会话级开关）一律放行。
 */
export function argConditionalConfirmReason(
  name: string,
  rawArgs: unknown,
  mode: ConfirmScopeMode,
): string | null {
  const args = (rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
  const action = text(args.action)

  if (name.endsWith('_remove')) {
    // 只有 trash 是删除。list 是读、restore 是恢复（与 mcp 的 restart 同一档，不该拦）。
    if (action !== 'trash') return null
    const id = text(args.id)
    // 缺 id 时工具自己会拒；先弹一张卡等于让用户批准一次注定失败的删除。
    if (id === '') return null
    return `Delete ${removeSubject(name)}「${id}」 — moved to the trash, restorable from the panel.`
  }

  if (name === 'prompt_manager_apply') {
    // apply=false 是撤销（回到本轮应用之前），可逆，不问。
    if (args.apply === false) return null
    const id = text(args.id)
    if (id === '') return null
    return `Apply AGENTS.md preset「${id}」 — effective next turn, machine-wide. A scene-driven baseline is rebound, not overwritten.`
  }

  if (name === 'mcp_manager_switch') {
    const server = text(args.server)
    if (server === '') return null
    // restart 是恢复路径（服务器挂了只有它能救），场景锁都为它开口 —— 不拦。
    if (action === 'restart') return null
    if (action === 'stop') {
      return `Stop MCP server「${server}」 machine-wide — every conversation still using it is disconnected.`
    }
    if (action !== 'on' && action !== 'off') return null
    if (!machineWide(args, mode)) return null
    return `Turn MCP server「${server}」 ${action} for every conversation (global switch).`
  }

  if (name === 'memory_manager_switch' || name === 'subagent_manager_switch') {
    if (typeof args.enabled !== 'boolean') return null
    if (!machineWide(args, mode)) return null
    const key = name === 'memory_manager_switch' ? text(args.memory) : text(args.name)
    if (key === '') return null
    const subject = name === 'memory_manager_switch' ? 'memory' : 'persona'
    return `Turn ${subject}「${key}」 ${args.enabled ? 'on' : 'off'} for every conversation (global switch).`
  }

  if (name === 'skill_manager_switch') {
    // prefer 也是一次机器级的持久选择，但 `enabled` 缺省时它是唯一动作。
    const prefer = typeof args.prefer === 'boolean'
    if (typeof args.enabled !== 'boolean' && !prefer) return null
    if (!machineWide(args, mode)) return null
    const source = text(args.source)
    const key = source !== '' ? text(args.source) : text(args.name)
    const label = source !== '' ? 'source' : 'skill'
    if (key === '') return null
    if (typeof args.enabled === 'boolean') {
      return `Turn ${label}「${key}」 ${args.enabled ? 'on' : 'off'} for every conversation (global switch).`
    }
    return `${args.prefer ? 'Make' : 'Stop preferring'} the copy of ${label}「${key}」 win its name collision, machine-wide.`
  }

  return null
}
