// src/mcp/state-section.ts —— MCP 服务器状态段（注入通道的数据源，见 src/context-inject.ts）。
//
// 为什么需要它：启停 MCP 只改变**请求里的工具 schema 块**，没有任何显式状态陈述。
// 所以在模型视角里，「配置了但被关掉」和「根本没配过」**完全等价** —— 它连"有哪些
// MCP server"都不知道，更不知道用户为每台 server 写了什么备注。
//
// **备注才是本项的真正价值**：备注输入框的 placeholder 就是
// 「例如：A 不可用时改用 B 兜底」—— 那是用户写给「未来的模型」的**决策提示**。
// 这类信息在任何工具 schema 里都拿不到：工具只暴露 `mcp__<server>__<tool>` 的名字与
// 参数，永远不会说「A 挂了改用 B」。所以「列出 server」只是载体。
//
// 范围（2026-09-15 用户裁定）：
//   - **只列「当前真正可用」的 server**：配置上已启用 **且** 有**未被停用**的工具
//     （enabledToolCount > 0；场景档案收窄与手动逐工具开关都会写停用表，这里如实扣减）。
//     没开的不进（用户明确要求）；工具全被停用的也不进（模型调不到，留着只会谎报数量）。
//   - 只列 **server 名 + 工具数 + 备注**；**具体工具名绝不注入** ——
//     已启用 server 的工具本来就在模型自己的工具 schema 里（`mcp__<server>__<tool>`），
//     段里再列一遍是重复；模型按前缀就能对上号。
//   - 工具数只算**当前可用**的：被停用的那一部分不显示（它就是模型 schema 里没有的），
//     数字必须与模型能调到的工具对得上。
//   - 无备注 → 只有名字 + 工具数（正是「不写就只知道名字」）。
//   - 不写「已启用」字样：能进段的都是可用的，标状态是废话。
//   - 无可用 server → 返回 `''`（renderPrompt 删空段，零 token 成本）。
//
// 同步性：`text()` 必须同步返回（renderPrompt 不接受 Promise），而 MCP 清单是异步读盘 →
// 与子智能体目录同构的 stale-while-revalidate（见 src/subagents/catalog.ts）。

/** 段里最多列几台 server；超出部分只报数量。 */
export const DEFAULT_MCP_MAX_ENTRIES = 50
/** 备注截断长度。备注是自由文本，界面侧另有 maxLength(500) 兜底，段侧再截一刀。 */
export const DEFAULT_MCP_NOTE_MAX_LENGTH = 200
/**
 * 备注的固定前缀（模型侧口径，用户裁定 2026-09-16：字段与段统一叫 user-hint / 用户提示）。
 *
 * 原为「备注：」，取「降低被读成指令的概率」——备注是自由文本，注入后**由插件背书**地到达模型。
 * 改叫「用户提示：」是有意为之：它本来就该被读成**用户的决策提示**（「A 挂了改用 B」），
 * 而不是系统策略。威胁模型不变（内容由用户自己写、仅本机可写，属**自伤**而非被攻击），
 * 但前缀如实标明来源，模型据此权衡即可。
 */
export const MCP_NOTE_PREFIX = '用户提示：'

/** 段里用到的 MCP 行字段（与 `normalizeRow` + `mcpmList` 的产出对应）。 */
export interface McpStateRow {
  /** loader entry id —— **备注按它取**，不是 serverName（两者可能不同）。 */
  id: string
  /** 展示名；工具名 `mcp__<serverName>__<tool>` 用的就是它。 */
  serverName: string
  disabled?: boolean
  /** 已知工具总数（live ∪ 停用表里的单个工具名 ∪ 「已知工具」缓存）。 */
  toolCount?: number
  /** 当前可用工具数（已知总数里未被停用表扣减的；`*` = 整台停用 → 0）。缺省时退回 toolCount。 */
  enabledToolCount?: number
  /** 用户备注（由 `mcpmRowsWithNotes(false)` 合入）。 */
  notes?: string
}

export interface McpStateOptions {
  maxEntries?: number
  noteMaxLength?: number
}

/**
 * 备注压成单行（换行 → 空格）并截断。
 *
 * 导出给模型侧的 `mcp_manager_list` 复用：压制型预设下不注入时，那条工具
 * 是备注唯一的读取路径，两处的压行/截断口径必须一致，否则同一句备注在界面、段、工具里
 * 会是三个样子。
 */
export function normalizeMcpNote(value: unknown, maxLength: number): string {
  const flat = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 3)}...`
}

/**
 * 渲染 MCP 状态段（纯函数，便于单独推理）。
 *
 * 返回 `''` 表示不注入 —— 没有可用 server 的用户零 token 成本。
 */
export function renderMcpStateSection(
  rows: readonly McpStateRow[],
  opts: McpStateOptions = {},
): string {
  const maxEntries = opts.maxEntries ?? DEFAULT_MCP_MAX_ENTRIES
  const noteMaxLength = opts.noteMaxLength ?? DEFAULT_MCP_NOTE_MAX_LENGTH

  // 工具数取**可用数**（停用表扣减后的）；旧调用方只给 toolCount 时退回它，行为不变。
  const countOf = (r: McpStateRow): number => (
    Number.isFinite(Number(r.enabledToolCount)) ? Number(r.enabledToolCount) : (Number(r.toolCount) || 0)
  )

  // 「当前真正可用」= 已启用 且 还有没被停用的工具。任一不满足都不进段。
  const usable = rows.filter((r) => !r.disabled && countOf(r) > 0)
  if (!usable.length) return ''

  // 按展示名排序：即使补丁文件里的行序变化，段文本也保持逐字节稳定（前缀缓存契约）。
  const sorted = [...usable].sort((a, b) => {
    const x = String(a.serverName ?? '')
    const y = String(b.serverName ?? '')
    return x < y ? -1 : x > y ? 1 : 0
  })
  const shown = sorted.slice(0, Math.max(0, maxEntries))
  const lines = shown.map((r) => {
    const count = countOf(r)
    const head = '- **' + String(r.serverName ?? r.id) + '**（' + count + ' 个工具）'
    const note = normalizeMcpNote(r.notes, noteMaxLength)
    return note ? head + ' — ' + MCP_NOTE_PREFIX + note : head
  })

  const out = ['## MCP 服务器', '', ...lines]
  const hidden = sorted.length - shown.length
  if (hidden > 0) out.push('', `（另有 ${hidden} 台未列出。）`)
  return out.join('\n')
}

export interface McpStateDeps {
  /** 必须用 `mcpmRowsWithNotes(false)` —— 传 `true` 会带上**未打码**的 url/headers/env（含明文密钥）。 */
  rows(): Promise<{ ok?: boolean; rows?: McpStateRow[] }>
}

export interface McpStateCatalog {
  /** 同步返回段文本（可能比磁盘状态滞后一个 TTL）。 */
  text: () => string
  /** 立即重算（写操作后调用）。 */
  refresh: () => Promise<void>
  /** 预热：插件加载时调一次，避免首个请求落到空值。 */
  warm: () => Promise<void>
}

export interface McpStateCatalogOptions extends McpStateOptions {
  /**
   * 缓存新鲜度。取 3000ms，与 `readNotes` 的 `SIDECAR_TTL_MS` 对齐；
   * `mcpmList` 比人设目录重（要枚举工具 schema + 读补丁文件），不适合更短的 TTL。
   */
  ttlMs?: number
  now?: () => number
}

/** 创建 SWR 的 MCP 状态目录。计算失败时保留上一次的值，不把段清空。 */
export function createMcpStateCatalog(
  deps: McpStateDeps,
  opts: McpStateCatalogOptions = {},
): McpStateCatalog {
  const ttlMs = opts.ttlMs ?? 3000
  const now = opts.now ?? (() => Date.now())

  let value = ''
  let loadedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | null = null

  const recompute = async (): Promise<void> => {
    try {
      const result = await deps.rows()
      if (result && result.ok !== false) {
        value = renderMcpStateSection(result.rows ?? [], opts)
      }
    } catch { /* 保留上一次的值；首次失败则维持 '' */ }
    loadedAt = now()
  }

  const revalidate = (): Promise<void> => {
    if (inflight) return inflight
    inflight = recompute().finally(() => { inflight = null })
    return inflight
  }

  return {
    text: () => {
      if (now() - loadedAt > ttlMs) void revalidate()
      return value
    },
    refresh: () => {
      loadedAt = Number.NEGATIVE_INFINITY
      return revalidate()
    },
    warm: () => revalidate(),
  }
}
