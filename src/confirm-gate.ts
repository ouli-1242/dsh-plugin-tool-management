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
  'plugin_manager_remove',
  'prompt_manager_apply',
  'mcp_manager_switch',
  'memory_manager_switch',
  'skill_manager_switch',
  'subagent_manager_switch',
  'tool_manager_tools',
])

/** 取一个必填字符串参数；不是非空字符串就返回空串。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 这次写入是不是落在机器级：显式 `scope: "global"`，或全局粒度下没有会话层。 */
function machineWide(args: Record<string, unknown>, mode: ConfirmScopeMode): boolean {
  return mode === 'global' || args.scope === 'global'
}

/**
 * 删除类工具的域 → 卡上回显的名词。
 *
 * 删除是一条**跨域**工具（`plugin_manager_remove`），所以名词由 `domain` 参数决定，
 * 不由工具名决定 —— 五个域合进一条之后，工具名不再携带是删什么。
 *
 * 域不认识（或没给）时返回 undefined：那种调用注定失败，问了也是一次无效审批。
 */
const REMOVE_SUBJECT: Record<string, string> = {
  memory: 'memory',
  skill: 'skill',
  persona: 'persona',
  preset: 'AGENTS.md preset',
  scene: 'scene',
}

/**
 * 完全权限（approval=never）也**不许跳过**的确认。
 *
 * 完全权限的语义是"用户预先批准了常规审批"，但有几类动作的授权边界在它之上：
 * 用户亲口说过"这种事必须问我"。目前两类：
 *
 *   · 删除类（trash）与机器级停用工具 —— 数据处置 / 拿走能力，出错不可逆或难以察觉。
 *   · 修复类（repair）—— 把损坏侧车改名留存、按空表继续，同属数据处置。
 *
 * 自主记忆 learn 不在其中：它只写一条候选，候选不进上下文，确认发生在记忆页。
 *
 * 返回 false 不代表"不用问"：要不要问仍由 `argConditionalConfirmReason` 决定；这里只在
 * "要问"之后决定"完全权限能不能免问"。纯函数，与上面那张表共用入参。
 */
export function isMustAskConfirm(
  name: string,
  rawArgs: unknown,
  mode: ConfirmScopeMode,
): boolean {
  const args = (rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
  const action = text(args.action)
  if (name.endsWith('_remove')) {
    return action === 'trash' && REMOVE_SUBJECT[text(args.domain)] !== undefined
  }
  if (name === 'tool_manager_tools') {
    if (action === 'repair') return true
    // 机器级停用 = 把工具从所有对话里拿走（"移除工具"）；启用是加回来，可跳过。
    if (action === 'disable' && machineWide(args, mode)) return text(args.tools) !== '' || Array.isArray(args.tools)
    return false
  }
  return false
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
    const subject = REMOVE_SUBJECT[text(args.domain)]
    if (subject === undefined) return null
    return `Delete ${subject}「${id}」 — moved to the trash, restorable from the panel.`
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
    // `memory` 是改名前的参数名，兼容一次；新调用方用 `id`。
    const key = name === 'memory_manager_switch' ? text(args.id !== undefined ? args.id : args.memory) : text(args.name)
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

  if (name === 'tool_manager_tools') {
    // 会话层自开不弹（只动管着这个对话的那一层，随时可退）；隔离关掉时那一层就是全局，
    // 动的是所有对话 —— 与三个 `_switch` 在全局粒度下的口径一致，要问。
    // 修复类动作要问：它会把**已损坏的侧车改名留存**、按空表继续 —— 那是一次不可逆的
    // 数据处置（原始文件还在，但插件从此不再读它），与「换个开关」不是一档。
    if (action === 'repair') {
      const target = text(args.target)
      if (target === '') return null
      const subject = target === 'memory-index' ? '记忆索引'
        : target === 'scope' ? '作用域侧车'
          : target === 'mcp-disabled' ? 'MCP 停用表'
            : target === 'tool-table' ? '模型工具表'
              : ''
      if (subject === '') return null
      // 工具表的恢复值是出厂名单而不是空表（空表 = 所有工具都可见，与出厂相反）。
      const outcome = target === 'tool-table' ? 'back to the factory list' : 'with an empty table'
      return `Repair the ${subject} — the damaged file is renamed aside and the plugin continues ${outcome}. Anything it held is no longer applied.`
    }
    if (action !== 'enable' && action !== 'disable') return null
    if (!machineWide(args, mode)) return null
    const names = Array.isArray(args.tools)
      ? args.tools.map((n) => text(n)).filter((n) => n !== '')
      : []
    if (names.length === 0) return null
    return `Turn ${action === 'enable' ? 'on' : 'off'} ${names.join(', ')} for every conversation (machine-wide tool table).`
  }

  return null
}
