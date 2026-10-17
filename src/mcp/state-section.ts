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
// 范围（2026-09-15 用户裁定；2026-09-17 按实测修正"可用"的判据；2026-10-18 加第三档）：
//   - 分三档，判据全部可验证：
//       ① **可用**：配置上已启用 **且** 当前真实注册了未被停用的工具
//          （`liveEnabledToolCount > 0`；场景档案收窄与手动逐工具开关都会写停用表，这里如实扣减）。
//       ② **连着但工具全被停用**：当前注册了工具、但停用表把它们全扣光（`liveToolCount > 0`
//          而 `liveEnabledToolCount === 0`）。2026-10-18 起列出来：它是"模型手上一条 MCP 工具
//          都没有，可 server 确实在跑"的唯一线索，而此前不列的理由（"留着只会谎报数量"）
//          随工具数一起作废了。
//       ③ **曾经连上、现在不可用**：已启用、当前一个工具都没注册，但「已知工具」缓存非空。
//          这是**状态变化**，要报 —— 模型据此给"检查网络/命令/凭据"的建议，而不是把
//          "配了但连不上"读成"本机没配"（后者会让它建议用户去装一个）。同时，用户写在那台
//          server 上的备注（placeholder 就是「A 不可用时改用 B 兜底」）恰恰只在此时才有用，
//          不列就永远送不到。
//     不列的两类：**没开**（用户明确要求）、**从未连上过**（缓存也空 —— 一直没成功过，不该反复
//     打扰；这条抄的是 Claude Code 的通知策略：一直没连上的不提示，昨天还好今天挂的才提示）。
//   - 只列 **server 名 + 状态（②③档）+ 备注**；**具体工具名绝不注入** ——
//     已启用 server 的工具本来就在模型自己的工具 schema 里（`mcp__<server>__<tool>`），
//     段里再列一遍是重复；模型按前缀就能对上号。
//   - **工具数不列**（2026-09-23）：模型不能凭"这台有 N 个工具"做任何事（能调哪些在它自己的
//     schema 里），而 17 B/台 × 每轮的开销是白付的。
//   - 无备注 → 只有名字（①档）或名字 + 状态（②③档）。
//   - 不写「已启用」字样：能进段的都是已启用的，标状态是废话；②③档则必须标，否则就是谎报。
//   - **三档都空才返回 `''`**（无 server 可讲时零 token 成本）。注意 2026-10-18 的
//     「无备注就不发」已被同日的用户裁定推翻，理由见 `renderMcpStateSection` 的注释。
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
/**
 * 备注截断长度。界面上那两枚输入框（MCP 页与场景档案）用同一个数当字数上限，
 * 客户端镜像在 `42-shared-ui.js` 的 `MCP_NOTE_MAX` —— 改这里要一起改它。
 */
export const DEFAULT_MCP_NOTE_MAX_LENGTH = 300
/**
 * 备注的固定前缀（模型侧口径，用户裁定 2026-09-16：字段与段统一叫 user-hint / 用户提示）。
 *
 * 原为「备注：」，取「降低被读成指令的概率」——备注是自由文本，注入后**由插件背书**地到达模型。
 * 改叫 `user hint:` 是有意为之：它本来就该被读成**用户的决策提示**（「A 挂了改用 B」），
 * 而不是系统策略。威胁模型不变（内容由用户自己写、仅本机可写，属**自伤**而非被攻击），
 * 但前缀如实标明来源，模型据此权衡即可。
 */
export const MCP_NOTE_PREFIX = 'user hint: '

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

/** 段里一行服务器的状态：可用 / 连着但工具全被停用 / 曾经连上、现在没连上。 */
type McpStatus = 'ok' | 'muted' | 'offline'

/**
 * 渲染 MCP 状态段（纯函数，便于单独推理）。
 *
 * **整段的取舍**（2026-10-18 用户裁定「无备注不发这样不好」，推翻了同日的 A 方案）：
 * 只要有一台该说的 server 就发，不因为"没有备注"而整段省略。理由：
 *   - 这一域是**唯一**说明"这台机器上配了哪些 server、各自什么状态"的地方，而模型手里的工具表
 *     只说得出"我现在能调什么"。少了它，"配过但没连上 / 连着但工具被关掉"与"根本没配过"
 *     在模型看来完全等价 —— 那正是本模块存在的理由（见文件头）。
 *   - 代价已经不是问题：`how` 行按需发、权威声明只在替换时发之后，只有名字的那种段在上下文里
 *     只剩标题 + 一两行，且内容不变就不重发。
 *
 * @param listToolVisible `mcp_manager_list` 在这个 agent 手里吗（尾句那个出口的前提）
 */
export function renderMcpStateSection(
  rows: readonly McpStateRow[],
  opts: McpStateOptions = {},
  listToolVisible: boolean = true,
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

  // 三档，判据全部可验证：
  //   ① `usable`   —— 已启用，当前真注册了未被停用的工具（模型现在就能调）。
  //   ② `muted`    —— 已启用、也真的连着（注册过工具），但**工具全被停用**：场景档案收窄或
  //                   手动逐工具开关的结果。2026-10-18 起列出来并标注（此前不列）：它是
  //                   "模型手上一条工具都没有，但 server 确实在跑"的**唯一**线索，而旧理由
  //                   （"留着只会谎报数量"）随着工具数一起消失了 —— 现在只给名字与状态。
  //   ③ `offline`  —— 已启用、当前一个工具都没注册，但「已知工具」缓存非空（曾经连上过）。
  const usable = rows.filter((r) => !r.disabled && liveEnabledOf(r) > 0)
  const muted = rows.filter((r) => !r.disabled && liveOf(r) > 0 && liveEnabledOf(r) === 0)
  const offline = rows.filter((r) => !r.disabled && liveOf(r) === 0 && knownOf(r) > 0)
  if (!usable.length && !muted.length && !offline.length) return ''

  // 按展示名排序：即使补丁文件里的行序变化，段文本也保持逐字节稳定（前缀缓存契约）。
  // 三档各自排序，可用的一律排在前面（它才是模型当下能用的东西）。
  const byName = (a: McpStateRow, b: McpStateRow): number => {
    const x = String(a.serverName ?? '')
    const y = String(b.serverName ?? '')
    return x < y ? -1 : x > y ? 1 : 0
  }
  const cap = Math.max(0, maxEntries)
  const shownUsable = [...usable].sort(byName).slice(0, cap)
  const shownMuted = [...muted].sort(byName).slice(0, cap)
  const shownOffline = [...offline].sort(byName).slice(0, cap)

  const lineOf = (row: McpStateRow, status: McpStatus): string => {
    const name = String(row.serverName ?? row.id)
    // 非"可用"的两档必须把状态写出来：不写就等于谎报"可用"。
    //
    // 2026-09-23：两档的**工具数都去掉了**（用户看到实际注入后要求精简）。数字对模型没有
    // 动作价值 —— 它不能凭"这台有 8 个工具"列举出工具名（真正能调的都在它自己的工具
    // schema 里，按 `mcp__<server>__` 前缀就能对上号），而每轮都要付 17 B/台。
    // 顺带消掉一处隐患：②档原来写「上次连上时 N 个工具」，那个数字是**历史事实**，措辞上
    // 必须和现状区分开；数字没了，这个歧义也就不存在了。
    const head = status === 'offline'
      ? '- **' + name + '** (not connected now)'
      : status === 'muted'
        ? '- **' + name + '** (no tools enabled here)'
        : '- **' + name + '**'
    const note = normalizeMcpNote(row.notes, noteMaxLength)
    return note ? head + ' — ' + MCP_NOTE_PREFIX + note : head
  }

  const lines = [
    ...shownUsable.map((row) => lineOf(row, 'ok')),
    ...shownMuted.map((row) => lineOf(row, 'muted')),
    ...shownOffline.map((row) => lineOf(row, 'offline')),
  ]

  // 只有清单：标题（`# Current MCP servers`）由注入通道的框架承担
  // （2026-09-18 起，见 context-inject.ts 的 DOMAIN_FRAME）—— 同一件事只有一个出处，
  // 框架已经写了标题，正文再写一遍就是每步多付一行 token。
  const out = [...lines]
  const hidden = (usable.length + muted.length + offline.length)
    - (shownUsable.length + shownMuted.length + shownOffline.length)
  // 超上限时给出口（2026-10-18 审查 B）：技能与子智能体两个目录早就这么写了，这是唯一漏掉
  // 的一处。工具被关掉（兼容页 / 人设 toolsDeny）时不点名 —— 点名一个模型手里没有的工具，
  // 只会让它去猜名字；数量照报，那是实话。
  if (hidden > 0) {
    out.push('', listToolVisible
      ? `(${hidden} more not listed — see them with \`mcp_manager_list\`.)`
      : `(${hidden} more not listed.)`)
  }
  return out.join('\n')
}

export interface McpStateDeps {
  /** 必须用 `mcpmRowsWithNotes(false)` —— 传 `true` 会带上**未打码**的 url/headers/env（含明文密钥）。 */
  rows(): Promise<{ ok?: boolean; rows?: McpStateRow[] }>
  /**
   * `mcp_manager_list` **在这个 agent 手里**吗（尾句那个出口的前提）。默认在。
   *
   * 收 `agent` 而不是零参（2026-10-18 审查 B）：只读全局开关时，某个人设用 `toolsDeny`
   * 砍掉这条工具之后，尾句照样说「用 `mcp_manager_list` 查」—— 指向一条它手里没有的工具。
   * 判据与技能 / 子智能体两个目录同一份（index.ts 的 `toolVisibleFor`），不定义第二份。
   */
  listToolVisible?: (agent?: unknown) => boolean
}

export interface McpStateCatalog {
  /**
   * 同步返回段文本（可能比磁盘状态滞后一个 TTL）。
   *
   * `agent` 只决定**尾句点不点名那个查询工具**（清单本体与它无关）；不传按"在手里"算。
   */
  text: (agent?: unknown) => string
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

  // 缓存的是**行数据**而不是渲染结果（与技能 / 子智能体两个目录同一手法）：清单只依赖磁盘，
  // 而尾句要不要点名查询工具取决于**这个 agent 手里有没有它**。渲染是纯字符串操作，代价可忽略。
  let data: McpStateRow[] | null = null
  let loadedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | null = null
  let rendered: { visible: boolean; text: string } | null = null

  const recompute = async (): Promise<void> => {
    try {
      const result = await deps.rows()
      if (result && result.ok !== false) {
        data = result.rows ?? []
        rendered = null
      }
    } catch { /* 保留上一次的值；首次失败则维持 null */ }
    loadedAt = now()
  }

  const revalidate = (): Promise<void> => {
    if (inflight) return inflight
    inflight = recompute().finally(() => { inflight = null })
    return inflight
  }

  return {
    text: (agent?: unknown) => {
      if (now() - loadedAt > ttlMs) void revalidate()
      if (data === null) return ''
      const visible = deps.listToolVisible ? deps.listToolVisible(agent) : true
      if (rendered && rendered.visible === visible) return rendered.text
      const out = renderMcpStateSection(data, opts, visible)
      rendered = { visible, text: out }
      return out
    },
    refresh: () => {
      loadedAt = Number.NEGATIVE_INFINITY
      return revalidate()
    },
    warm: () => revalidate(),
  }
}
