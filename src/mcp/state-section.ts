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
// 范围（2026-09-15 用户裁定；2026-09-17 按实测修正"可用"的判据）：
//   - 分两档，判据全部可验证：
//       ① **可用**：配置上已启用 **且** 当前真实注册了未被停用的工具
//          （`liveEnabledToolCount > 0`；场景档案收窄与手动逐工具开关都会写停用表，这里如实扣减）。
//       ② **曾经连上、现在不可用**：已启用、当前一个工具都没注册，但「已知工具」缓存非空。
//          这是**状态变化**，要报 —— 模型据此给"检查网络/命令/凭据"的建议，而不是把
//          "配了但连不上"读成"本机没配"（后者会让它建议用户去装一个）。同时，用户写在那台
//          server 上的备注（placeholder 就是「A 不可用时改用 B 兜底」）恰恰只在此时才有用，
//          不列就永远送不到。
//     不列的三类：**没开**（用户明确要求）、**工具全被停用**（模型调不到，留着只会谎报数量）、
//     **从未连上过**（缓存也空 —— 一直没成功过，不该反复打扰；这条抄的是 Claude Code 的通知
//     策略：一直没连上的不提示，昨天还好今天挂的才提示）。
//   - 只列 **server 名 + 工具数 + 备注**；**具体工具名绝不注入** ——
//     已启用 server 的工具本来就在模型自己的工具 schema 里（`mcp__<server>__<tool>`），
//     段里再列一遍是重复；模型按前缀就能对上号。
//   - 工具数只算**当前可用**的：被停用的那一部分不显示（它就是模型 schema 里没有的），
//     数字必须与模型能调到的工具对得上。②档没有当前数字，所以写的是「上次连上时 N 个工具」——
//     那是历史事实，不是现状，措辞上必须区分开。
//   - 无备注 → 只有名字 + 工具数（正是「不写就只知道名字」）。
//   - 不写「已启用」字样：能进段的都是可用的，标状态是废话；②档则必须标，否则就是谎报。
//   - 两档都空 → 返回 `''`（renderPrompt 删空段，零 token 成本）。
//
// 一条**测不出来**的边界（写在这里免得后来者以为它是 bug）：宿主没有暴露"MCP 已连接"这个信号
// （插件清单只有 entryId / moduleName / enabled / fiberPhase），所以本模块只能读"工具有没有注册"。
// 而官方 dsh-mcp-client 在**掉线后不会立刻摘掉工具**：`maxAttempts: 10`、退避 500ms 翻倍到 30s，
// 约 2.5 分钟后才 `tools unregistered`；若把 `reconnect.enabled` 设为 false 则**永久保留**。
// 也就是说那个窗口内本段仍会把它算作①档。这不是判据写错，是插件身份决定的观测上限。
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
  /**
   * **当前真实注册**在宿主工具表里的工具数（只数 schema，不含任何缓存）。`0` = 此刻一个都没有。
   *
   * 与 `toolCount` 的区别是本模块的关键：`toolCount` 里混了「已知工具」缓存（"这台 server
   * 有过哪些工具"），而缓存里的名字在服务器已经连不上时依然存在。判"能不能用"只能用这个数。
   */
  liveToolCount?: number
  /** 上面这个数里未被停用表扣减的（真正能调到的）。缺省时退回 enabledToolCount → toolCount。 */
  liveEnabledToolCount?: number
  /**
   * 「已知工具」缓存里的工具数 —— **这台 server 曾经真的连上过**的证据
   * （缓存只在真实 schema 里见到工具时才写入）。`0` = 从未连上过。
   *
   * 它只用来决定"要不要把一台当前不可用的 server 列出来"，不参与可用性判断。
   */
  knownToolCount?: number
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
 * 分两档：**可用**（当前真注册了可用工具）与**曾经连上、现在不可用**（当前没注册，
 * 但「已知工具」缓存证明它曾经成功过）。判据与不列的三类见文件头。
 *
 * 返回 `''` 表示不注入 —— 没有可用 server 的用户零 token 成本。
 */
export function renderMcpStateSection(
  rows: readonly McpStateRow[],
  opts: McpStateOptions = {},
): string {
  const maxEntries = opts.maxEntries ?? DEFAULT_MCP_MAX_ENTRIES
  const noteMaxLength = opts.noteMaxLength ?? DEFAULT_MCP_NOTE_MAX_LENGTH

  // 当前真实可用的工具数（停用表扣减后）。**优先读 live 那个数** —— 旧调用方只给
  // enabledToolCount / toolCount 时逐级退回，行为与拆分之前一致（那个数在"从未连上过"的
  // server 上恰好也是 0，所以退回不会造成谎报，只会少报）。
  const liveEnabledOf = (r: McpStateRow): number => {
    if (Number.isFinite(Number(r.liveEnabledToolCount))) return Number(r.liveEnabledToolCount)
    return Number.isFinite(Number(r.enabledToolCount)) ? Number(r.enabledToolCount) : (Number(r.toolCount) || 0)
  }
  // 当前注册了**几个**工具（不扣停用）。用来把"什么都没注册"与"注册了但都被停用"分开：
  // 后者是用户的选择（该不列），前者才是"连不上"（该列并标注）。
  const liveOf = (r: McpStateRow): number => (
    Number.isFinite(Number(r.liveToolCount)) ? Number(r.liveToolCount) : liveEnabledOf(r)
  )
  // 曾经连上过的证据。缺省 0 = 从未连上过（旧调用方给不出这个信号，按"不列"处理 —— 少说不错）。
  const knownOf = (r: McpStateRow): number => Number(r.knownToolCount) || 0

  const usable = rows.filter((r) => !r.disabled && liveEnabledOf(r) > 0)
  const offline = rows.filter((r) => !r.disabled && liveOf(r) === 0 && knownOf(r) > 0)
  if (!usable.length && !offline.length) return ''

  // 按展示名排序：即使补丁文件里的行序变化，段文本也保持逐字节稳定（前缀缓存契约）。
  // 两档各自排序，可用的一律排在前面（它才是模型当下能用的东西）。
  const byName = (a: McpStateRow, b: McpStateRow): number => {
    const x = String(a.serverName ?? '')
    const y = String(b.serverName ?? '')
    return x < y ? -1 : x > y ? 1 : 0
  }
  const cap = Math.max(0, maxEntries)
  const shownUsable = [...usable].sort(byName).slice(0, cap)
  const shownOffline = [...offline].sort(byName).slice(0, cap)

  const lineOf = (r: McpStateRow, count: number, isOffline: boolean): string => {
    const name = String(r.serverName ?? r.id)
    // ②档必须把状态写出来：不写就等于谎报"可用"。「上次连上时」四个字不能省 ——
    // 那个数字是历史事实，写成"（N 个工具）"会被读成现状。
    const head = isOffline
      ? '- **' + name + '**（当前未连上；上次连上时 ' + count + ' 个工具）'
      : '- **' + name + '**（' + count + ' 个工具）'
    const note = normalizeMcpNote(r.notes, noteMaxLength)
    return note ? head + ' — ' + MCP_NOTE_PREFIX + note : head
  }

  const lines = [
    ...shownUsable.map((r) => lineOf(r, liveEnabledOf(r), false)),
    ...shownOffline.map((r) => lineOf(r, knownOf(r), true)),
  ]

  // 只有清单：标题（`## 本机 MCP 服务器的当前状态`）与"该拿它做什么"由注入通道的框架承担
  // （2026-09-18 起，见 context-inject.ts 的 DOMAIN_FRAME）—— 同一件事只有一个出处，
  // 框架已经写了标题，正文再写一遍就是每步多付一行 token。
  const out = [...lines]
  const hidden = (usable.length + offline.length) - (shownUsable.length + shownOffline.length)
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
