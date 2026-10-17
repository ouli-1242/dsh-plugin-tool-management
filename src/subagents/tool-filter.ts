// 工具名单的过滤决策：保留名剔除，与「按当前预设算这次委派下发什么限制」。
//
// 从 subagents/service.ts 整段搬来，一行未改。这一层不碰宿主也不碰文件 —— 输入是人设与
// 当前会话已知的工具名，输出是三态的 restrict 载荷（null = 明确不加限制）。
// decideToolFilter 注释里那四个官方抛错点是本插件的已知契约，改名单逻辑前先读。
import type { PersonaDoc, ToolFilter, ToolFilterDecision } from './persona-types.js'
import { toStringList } from './persona-write.js'

/**
 * 官方 `tools.restrict()` 的**保留名**：名单里出现它时，官方不是"当它不存在"，而是**直接抛错**
 * （`dsh-tools/lib/index.js:2800`：cannot name reserved PTC mode presentation transport），
 * 子代理当场起不来。
 *
 * 为什么必须在这里显式剔除：`run_code` 在宿主面上是**合法可见**的工具名（非 native 模式下
 * 由官方补进可见集合），所以"按当前存在的工具名过滤未知项"剔不掉它 —— 过滤留下的正好是
 * 会让官方抛错的那个。用户的直观预期是"写了就生效（或至少被忽略）"，实际却是整个委派失败。
 */
export const RESERVED_TOOL_NAMES = new Set(['run_code'])

/** 把保留名从名单里剔掉，并说明剔了什么（不静默）。 */
export function stripReserved(names: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  for (const name of names) (RESERVED_TOOL_NAMES.has(name) ? dropped : kept).push(name)
  return { kept, dropped }
}

/**
 * 按**当前会话的 Agent 预设**决定这次委派下发什么工具限制。
 *
 * 为什么必须按预设分：子代理跑在父会话的预设里（官方 `composeFrom(childCtx, parent.ctx)`），
 * 而各预设的工具集合差别极大（极简模式只有持久 shell）。官方 `tools.restrict()` 实有
 * **四个**抛错点（`dsh-tools/lib/index.js:2790-2803`），抛了子代理就起不来：
 *
 *   ① 非 scoped context 调用（宿主 `childCtx` 已满足，无风险）；
 *   ② `allow` 与 `deny` 同时缺省 ⇒ `restrict({})` 抛 —— 本函数用 `filter: null`（不下发）
 *      表达"不加限制"，**从不**调用 `restrict({})`；
 *   ③ **名单含保留名 `run_code` 即抛** —— 而它在宿主面上是合法可见名，"按现有工具名过滤"
 *      剔不掉它，所以这里**显式剔除**并写进 note（见 `stripReserved`）；
 *   ④ 未知名 ⇒ 抛（唯一此前被记录的那条）。
 *
 * 所以：
 *   - 当前预设配了名单（且名单非空）→ 用它；白名单额外并入**当时真实在跑的 MCP 工具**
 *     （官方 allow 是"清单之外全砍"，不并进来会把 MCP 一起砍掉；用户裁定：子代理要能
 *     用当前启动的 MCP）；
 *   - 当前预设没配 → 回落旧的全局 `tools` / `toolsDeny`（老文件行为不变）；
 *   - 名单里有已经消失的工具名、或写了保留名 → **丢掉并在 note 里如实说明**（不接受静默失效）；
 *   - 判断不了当前预设（老宿主 / 异常）→ 不按模式施加，并在 note 里说明。
 *
 * ⚠ 两种失败方向都要记账（它们互斥，且都不是"没生效"这么简单）：名单全落空时本函数返回
 * `filter: null` = **放宽到不限制**（fail-open）；保留名没剔干净时官方抛错 = **收紧到起不来**。
 *
 * 三态返回：`filter: null` = 明确不加限制；`filter: {...}` = 下发该限制。
 */
export function decideToolFilter(
  persona: PersonaDoc,
  presetId: string | null,
  known: { names: Set<string>; mcp: string[] },
): ToolFilterDecision {
  const rule = presetId === null ? undefined : persona.toolsByPreset?.[presetId]
  if (rule && rule.names.length) {
    const knownNames = rule.names.filter((name) => known.names.has(name))
    const reserved = stripReserved(knownNames)
    const usable = reserved.kept
    const dropped = rule.names.filter((name) => !known.names.has(name))
    const notes: string[] = []
    if (dropped.length) notes.push(`these tools in the list do not exist right now and were ignored: ${dropped.join(', ')}`)
    if (reserved.dropped.length) {
      notes.push(`${reserved.dropped.join(', ')} in the list are reserved official names (writing them into the tool restriction would stop the subagent from starting at all) and were ignored`)
    }
    if (!usable.length) {
      const note = notes.length ? notes.join('; ') : undefined
      return { filter: null, note: note ?? `the ${rule.mode === 'allow' ? 'allow' : 'deny'} list of "${presetId}" contains no tool that exists right now, so no tool restriction is applied this time` }
    }
    const droppedNote = notes.length ? notes.join('; ') : undefined
    if (rule.mode === 'allow') return { filter: { allow: [...new Set([...usable, ...known.mcp])] }, ...(droppedNote === undefined ? {} : { note: droppedNote }) }
    return { filter: { deny: usable }, ...(droppedNote === undefined ? {} : { note: droppedNote }) }
  }
  // 旧格式（全局名单）：保持老行为，白名单同样并入 MCP。
  const legacyKnown = [...(persona.tools || []), ...(persona.toolsDeny || [])].filter((name) => known.names.has(name))
  const legacyReserved = stripReserved(legacyKnown)
  const legacyKept = new Set(legacyReserved.kept)
  const legacyAllow = (persona.tools || []).filter((name) => legacyKept.has(name))
  const legacyDeny = (persona.toolsDeny || []).filter((name) => legacyKept.has(name))
  const legacyDropped = [...(persona.tools || []), ...(persona.toolsDeny || [])].filter((name) => !known.names.has(name))
  const filter: ToolFilter = {
    ...(legacyAllow.length ? { allow: [...new Set([...legacyAllow, ...known.mcp])] } : {}),
    ...(legacyDeny.length ? { deny: legacyDeny } : {}),
  }
  const notes: string[] = []
  const hasLegacy = Boolean((persona.tools || []).length || (persona.toolsDeny || []).length)
  if (presetId === null) {
    // 说清这一刻到底靠什么在跑：有旧格式就照旧格式，没有就明说"按模式配的限制这次不生效"。
    notes.push(hasLegacy
      ? 'could not determine the agent preset of this session; running the legacy global list instead'
      : 'could not determine the agent preset of this session; the mode-scoped restriction does not apply this time')
  }
  if (legacyDropped.length) notes.push(`these tools in the list do not exist right now and were ignored: ${legacyDropped.join(', ')}`)
  if (legacyReserved.dropped.length) {
    notes.push(`${legacyReserved.dropped.join(', ')} in the list are reserved official names (writing them into the tool restriction would stop the subagent from starting at all) and were ignored`)
  }
  if (!Object.keys(filter).length) {
    if (presetId === null && !notes.length) notes.push('could not determine the agent preset of this session; no tool restriction is applied this time')
    return { filter: null, ...(notes.length ? { note: notes.join('; ') } : {}) }
  }
  return { filter, ...(notes.length ? { note: notes.join('; ') } : {}) }
}