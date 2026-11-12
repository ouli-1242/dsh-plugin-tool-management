// 「模型工具表开关」这一层：侧车 tool-table.json 的 TTL 缓存、三条写路径、给界面的同一份
// 回包形状，以及 `tool-table` 这个 op 的正文。
//
// 正文从 index.ts 的 apply 闭包里整段搬来，一字未改（唯一的容差是换作用域要少一层缩进，
// 以及下面这几个闭包名字改走 deps —— moved-verify 按这两类机检）：
// ensurePaths / readJsonFile / writeJsonFile / withWriteLock / message / EMPTY_TOOL_SET，
// 加三个**晚到**的邻居 mcp / skillCatalog / subagentCatalog（母文件那三件在本块之后才建，
// 所以按调用方约定用 getter 交进来：取值发生在真正要用的那一刻，既不动原句也不撞 TDZ）。
// 纯函数与类型（normalizeToolTableSettings / toolTableSettingsFrom / migrateLegacyToolNames /
// addPreset / dropPreset / buildToolTableReport / DEFAULT_HIDDEN_TOOLS / PRESET_*）本来就住在
// ./tools/table.js，这里直接引同一份，不转手。
//
// 为什么整簇一起搬：这 134 行共用两份状态 —— toolTableSizes（注册时量到的体积表，随每次
// register 长）与 toolTableCache（{at, value, off} 那份 TTL 缓存）。缓存只在块内改写，
// 而体积表由注册口写、被 op 与场景写路径读，所以它作为**同一个 Map 对象**交回母文件，
// 母文件那几处调用点一个字都不用改。
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { renameWithRetry } from './skills/core-util.js'
import { clearRuntimeNote, noteRuntime } from './compat/runtime-notes.js'
import { hubPath } from './hub.js'
import type { JsonFileRead } from './mcp/disabled-tools.js'
import {
  addPreset, applyToolTableToggles, buildToolTableReport, classifyToolTableSettings, DEFAULT_HIDDEN_TOOLS, DEFAULT_TOOL_TABLE_SETTINGS, dropPreset, migrateLegacyToolNames,
  normalizeToolTableSettings, PRESET_MAX_COUNT, PRESET_NAME_MAX_LENGTH,
  PROACTIVE_MEMORY_TOOL, stripProactiveToolHidden, summarizeToolDescription,
  type ToolTableReport, type ToolTableRow, type ToolTableSettings,
} from './tools/table.js'

/** 工具表切换的依赖：方案存储、可见性接缝与执行守卫。 */
export interface ToolTableSwitchDeps {
  /** 确保 hub 目录存在（读侧车前调用，与母文件同一条）。 */
  ensurePaths(): Promise<any>
  /** 严格读：区分 missing / 解析失败 / IO 失败（不调 ensurePaths）。 */
  readJsonFileStrict(abs: string): Promise<JsonFileRead>
  writeJsonFile(abs: string, data: any): Promise<void>
  /** 全局写锁：侧车的写在它下面串行（同一异步调用链可重入）。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  /** 错误 → 文案（与全仓同源）。 */
  message(e: unknown): string
  /** 预热完成前给的答案：一个都不关。 */
  EMPTY_TOOL_SET: ReadonlySet<string>
  /** 晚到的邻居：关掉一条工具要让可见性重排，那半边住在 mcp manager 里。 */
  mcp: { scheduleToolRestrictions(): void }
  /** 晚到的邻居：名单变了，两个目录里那句「用 `X` 查」的提示要跟着重算。 */
  skillCatalog: { refresh(): Promise<unknown> }
  subagentCatalog: { refresh(): Promise<unknown> }
  /**
   * 「官方载体在场 ⇒ 我们让位」的工具名（当前只有 `skill_manager_read`）。
   *
   * 报表要把它从**可见**里扣掉，否则兼容页在标准预设下会多报一条（虚报 ≈174 tok）。
   * 让位本身是 per-agent 的（取决于那个 scope 解析不解析得到官方 `skill`），而报表是全局的
   * —— 所以由母文件给一份口径明确的**保守估计**（"标准预设下会让位"），这里只转发。
   * 缺省（未给）时按不让位算，与从前逐字一致。
   */
  carrierHiddenTools?: () => readonly string[]
  /**
   * 自主记忆总开关此刻开没开 —— 那一条工具**完全**由它决定，盘上的关停名单无效。
   *
   * 工具表数据里不再出现它（界面不显示、名单 / 方案不保存）；这里只用于拒绝
   * `toggle` 请求与运行时可见性判据。没给（旧装配）按关算 = 藏起来，安全侧。
   */
  proactiveMemoryEnabled?: () => boolean
}

/** 工具表切换的对外面：换方案、还原、读当前关停名单。 */
export interface ToolTableSwitch {
  /** 注册时量到的工具体积（同一个 Map 交回母文件：注册口在别处写它）。 */
  toolTableSizes: Map<string, number>
  /**
   * 工具名 → 一句话用途（描述的首句，截断）。
   *
   * 为什么要有它：模型要判断「这条工具能干什么」时，只有名字是不够的（`scene_manager_switch`
   * 这种名字看不出是进场景还是存档案）。整段描述是给模型读 schema 时用的，整段复制出来
   * 会让一次清单回执变成几千字符 —— 首句够用。
   */
  toolTableSummaries: Map<string, string>
  recordToolSize(def: ToolDefinition): void
  readToolTableSettings(force?: boolean): Promise<ToolTableSettings>
  /**
   * 侧车安全状态：`unknown` = 损坏 / 不可读。此时读取沿用「上次成功值 →
   * 出厂默认」，但**写一律拒绝** —— 覆盖一份读不出来的文件等于把用户的选择洗掉。
   */
  toolTableState(): { state: 'ok' | 'unknown'; issue: 'corrupt' | 'unreadable' | null }
  /** unknown 时统一的拒绝文案（写侧与提示用同一句，不在调用方各写一份）。 */
  toolTableWriteError(): string
  toolTableHidden(): ReadonlySet<string>
  writeToolTableSettings(next: ToolTableSettings): Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * 锁内读-改-写。所有「先读当前值、再算新值」的调用方都必须走这里 —— 分开读再整表写
   * 会让并发的存方案 / 改勾选互相覆盖。回调返回失败对象时不落盘。
   */
  mutateToolTableSettings(
    mutate: (current: ToolTableSettings) => ToolTableSettings | ToolTableMutationFailure,
  ): Promise<{ ok: true; settings: ToolTableSettings } | ToolTableMutationFailure>
  toolTableReport(hidden?: readonly string[]): ToolTableReport
  toolTableOp(args: any): Promise<any>
  /** 损坏侧车的恢复通道：改名留存 + 按出厂名单继续（只在 unknown 状态可用）。 */
  repairToolTable(): Promise<{ ok: true; quarantined: string | null } | { ok: false; error: string }>
}

/** 锁内变更的失败形状：保留 op 层原有的 code / name / limit 字段。 */
export interface ToolTableMutationFailure {
  ok: false
  error?: string
  code?: string
  name?: string
  limit?: number
}

/** 模型工具表开关（侧车 `tool-table.json`）：出厂默认名单、按会话 / 全局改可见集。 */
export function createToolTableSwitch(deps: ToolTableSwitchDeps): ToolTableSwitch {
      // ---------- 模型工具表开关（侧车 `tool-table.json`，界面在「兼容」页）----------
  // 工具表按**每个请求**付钱：整张表的定义合计 ≈6.1k tok 每轮都在。关掉某几个，
  // 它们整份不进请求（实测口径与取舍见 src/tools/table.ts 的文件头）。**出厂就已经关了十八条**：
  // 可勾选的 22 条里藏 17 条（实发 5 条），第十八条是自主笔记、跟随记忆页的总开关（开则实发 6 条）
  // —— 名单、判据与代价在 `DEFAULT_HIDDEN_TOOLS`，只在这个人从没记过
  // 选择时铺（见下面的 `toolTableSettingsFrom`）。
  //
  // 为什么放在目录之前：两个目录的「用 `X` 查」提示要跟着这份设置变（工具关掉后那句话
  // 就是假的），所以它们的构造依赖在这块之后 —— 不做前向引用，顺序就是依赖顺序。
  const TOOL_TABLE_FILE = 'tool-table.json'
  const TOOL_TABLE_TTL_MS = 3000
  /** 注册时量到的工具体积（只记真进了表的那些；量的是 register 收到的整份定义）。 */
  const toolTableSizes = new Map<string, number>()
  /** 工具名 → 一句话用途（描述的首句）。 */
  const toolTableSummaries = new Map<string, string>()
  /**
   * 一句话用途：描述里第一行非空行，截到 {@link TOOL_SUMMARY_MAX} 字符。
   *
   * 为什么只取第一行：各工具描述的组织惯例是「是什么 → 怎么做 → 何时用」，首句就是
   * 「是什么」。整段描述在模型读 schema 时已经在上下文里，重复贴一遍只是把回执撑大。
   */
  function summarizeTool(def: ToolDefinition): string {
    return summarizeToolDescription((def as { description?: unknown }).description)
  }
  function recordToolSize(def: ToolDefinition): void {
    try {
      const name = String((def as { name?: unknown }).name ?? '')
      if (name === '') return
      // 与宿主同一口径（dsh-token-meter 的 estimateToolsTokens 就是把 tools 整份
      // JSON.stringify 后除以 4），所以这里量整份定义，不只量 description。
      toolTableSizes.set(name, JSON.stringify(def).length)
      toolTableSummaries.set(name, summarizeTool(def))
    } catch { /* 量不出来就不记：它只影响界面上的估算数字 */ }
  }
  let toolTableCache: { at: number; value: ToolTableSettings; off: ReadonlySet<string> } | null = null
  let toolTableStateValue: 'ok' | 'unknown' = 'ok'
  let toolTableIssueValue: 'corrupt' | 'unreadable' | null = null

  function publishToolTableNote(issue: 'corrupt' | 'unreadable', reason: string): void {
    noteRuntime({
      id: 'tool-table-file',
      label: '模型工具表侧车',
      kind: 'read',
      fallback: 'inform-only',
      detail: `tool-table.json ${issue === 'corrupt' ? '损坏' : '不可读'}（${reason}）：暂时沿用${toolTableCache ? '上次成功读取' : '出厂默认'}的关停名单；保存已禁用，修复或删除该文件后重试。`,
      detailKey: issue === 'corrupt' ? 'tool-table-file.corrupt' : 'tool-table-file.unreadable',
      params: { reason },
    })
  }

  const toolTableRefuseMessage = (): string =>
    `工具表侧车${toolTableIssueValue === 'corrupt' ? '损坏' : toolTableIssueValue === 'unreadable' ? '不可读' : '状态不可读'}：已拒绝保存；请修复或删除 tool-table.json 后重试`

  /** 严格读的四态 → 结构检查后的结果（missing 仍按"没记过选择"处理）。 */
  function checkToolTableRead(read: JsonFileRead):
    | { status: 'ok'; value: ToolTableSettings }
    | { status: 'missing' }
    | { status: 'corrupt'; error: string }
    | { status: 'unreadable'; error: string } {
    if (read.status !== 'ok') return read
    const checked = classifyToolTableSettings(read.value)
    return checked.ok ? { status: 'ok', value: checked.value } : { status: 'corrupt', error: checked.error }
  }

  async function readToolTableSettings(force = false): Promise<ToolTableSettings> {
    if (toolTableCache && !force && Date.now() - toolTableCache.at < TOOL_TABLE_TTL_MS) return toolTableCache.value
    // 读路径不调 ensurePaths：hubPath 走 resolveDshHome，与补丁路径推导无关。
    const checked = checkToolTableRead(await deps.readJsonFileStrict(hubPath(TOOL_TABLE_FILE)))
    let value: ToolTableSettings
    if (checked.status === 'missing') {
      // 侧车不存在 = 用户从没记过选择 ⇒ 出厂默认（判据见 tools/table.ts 的 DEFAULT_HIDDEN_TOOLS）。
      value = DEFAULT_TOOL_TABLE_SETTINGS
      toolTableStateValue = 'ok'
      toolTableIssueValue = null
      clearRuntimeNote('tool-table-file')
    } else if (checked.status === 'ok') {
      // 旧工具名迁移：读侧翻译一次并**回写盘**（幂等）。不迁移的话，用户"关掉了某条"
      // 的意图会在新名字上静默失效 —— 那条工具照旧每轮发出去，而界面上看不出来。
      // 写失败不回滚本次读取：内存里已经是迁移后的值，下次读会再试一次。
      // 存过盘的一律照盘上那份，包括显式的 `hidden: []` —— 那是"我全都要"，不能被默认值盖掉。
      const migrated = migrateLegacyToolNames(checked.value)
      value = migrated.settings
      if (migrated.changed) {
        try { await deps.writeJsonFile(hubPath(TOOL_TABLE_FILE), value) } catch { /* 回写失败：本次仍按迁移后的值生效 */ }
      }
      toolTableStateValue = 'ok'
      toolTableIssueValue = null
      clearRuntimeNote('tool-table-file')
    } else {
      // 损坏 / 不可读：保留最近一次成功值（没有就出厂默认）。**绝不**把读不出来的
      // hidden 当空表 —— 那等于让用户关掉的工具在执行守卫眼皮底下复活。
      value = toolTableCache ? toolTableCache.value : DEFAULT_TOOL_TABLE_SETTINGS
      toolTableStateValue = 'unknown'
      toolTableIssueValue = checked.status
      publishToolTableNote(checked.status, checked.error)
    }
    // 工具表数据里不保留自主记忆那条工具：旧文件里残留的名字读出来就摘掉。
    // 运行时可见性由 `withProactiveTool` / `overlayWithProactiveTool` 按开关强制。
    value = { ...value, hidden: stripProactiveToolHidden(value.hidden) }
    const changed = toolTableCache === null || toolTableCache.value.hidden.join('\u0000') !== value.hidden.join('\u0000')
    toolTableCache = { at: Date.now(), value, off: new Set(value.hidden) }
    // 首读 / 文件被外部改过 ⇒ 可见性要跟着重排。同步快照的调用方（门禁、注入通道）不会
    // 自己重排，它们只是"下次问的时候读到新值"；把限制摘掉/装上这一步必须有人做。
    // （`mcp` 在 apply 里是同步赋值、本函数只可能在自己的 await 之后回到这里，所以到得了。）
    if (changed) { try { deps.mcp.scheduleToolRestrictions() } catch { /* 兜底：拿不到 manager 就等下一次 tools/change */ } }
    return value
  }
  /**
   * 同步快照（热路径用：工具门禁每次调用、注入通道每个 step 都要问一句）。还没加载时先给
   * **空集**并异步预热 —— 空集不是出厂默认（出厂在 22 条里关着十七条），是刻意的：预热前的这一瞬与
   * 用户的选择可能不一致，但方向必须是安全的那一侧（不隐藏任何东西，绝不因为读盘慢而让
   * 工具凭空消失）。
   */
  function toolTableHidden(): ReadonlySet<string> {
    if (toolTableCache === null) {
      void readToolTableSettings().catch(() => {})
      return deps.EMPTY_TOOL_SET
    }
    return toolTableCache.off
  }
  // 行集是可勾选的那 22 条：自主笔记那条**故意不在里面**（它没有手动开关，开关在记忆页）。
  // 把它塞进来会让界面多画一行改不动的勾选，而"这条在不在表里"与"它发不发"是两件事。
  // 实际发送由 `withProactiveTool` 在总开关开着时补上，报告用 `derived` / `sentCount` 交代。
  const toolTableRows = (): ToolTableRow[] =>
    [...toolTableSizes].filter(([name]) => name !== PROACTIVE_MEMORY_TOOL).map(([name, bytes]) => ({ name, bytes }))
  /**
   * 当前生效的关停名单（只含用户手动关的）。
   *
   * 报表与真实发送必须同一口径：自主笔记那条不在这份名单里（用户改不了），报告通过
   * `derived` 单独说它开没开。顺手摘掉旧文件残留的名字 —— 读侧已经摘过一次，这里是第二道。
   */
  const effectiveHidden = (hidden: readonly string[] = [...toolTableHidden()]): string[] =>
    stripProactiveToolHidden(hidden)
  const toolTableReport = (hidden?: readonly string[]): ToolTableReport =>
    buildToolTableReport(
      toolTableRows(),
      effectiveHidden(hidden),
      deps.carrierHiddenTools ? deps.carrierHiddenTools() : [],
      {
        name: PROACTIVE_MEMORY_TOOL,
        active: proactiveOn() && toolTableSizes.has(PROACTIVE_MEMORY_TOOL),
        bytes: toolTableSizes.get(PROACTIVE_MEMORY_TOOL) ?? 0,
      },
    )
  /** 落盘 + 同步内存缓存；调用方必须已持有写锁。 */
  async function writeToolTableSettingsLocked(next: ToolTableSettings): Promise<{ ok: true } | { ok: false; error: string }> {
    // 锁内再确认一次：外部编辑器可能在这几毫秒里把文件写坏。此时覆盖同样会毁掉原内容。
    const checked = checkToolTableRead(await deps.readJsonFileStrict(hubPath(TOOL_TABLE_FILE)))
    if (checked.status === 'corrupt' || checked.status === 'unreadable') {
      toolTableStateValue = 'unknown'
      toolTableIssueValue = checked.status
      publishToolTableNote(checked.status, checked.error)
      return { ok: false as const, error: toolTableRefuseMessage() }
    }
    // 落盘前再摘一次：旧文件 / 旧方案里残留的名字不能借这次写回磁盘。
    const clean: ToolTableSettings = { ...next, hidden: stripProactiveToolHidden(next.hidden) }
    try {
      await deps.writeJsonFile(hubPath(TOOL_TABLE_FILE), clean)
    } catch (e) {
      return { ok: false as const, error: '设置保存失败: ' + deps.message(e) }
    }
    toolTableCache = { at: Date.now(), value: clean, off: new Set(clean.hidden) }
    toolTableStateValue = 'ok'
    toolTableIssueValue = null
    clearRuntimeNote('tool-table-file')
    return { ok: true as const }
  }
  /** 落盘 + 同步内存缓存（三条写路径共用：改勾选 / 存方案 / 删方案）。 */
  async function writeToolTableSettings(next: ToolTableSettings): Promise<{ ok: true } | { ok: false; error: string }> {
    await deps.ensurePaths()
    // 状态未知时先拒绝：正常入口都会先 read 一次，所以这里挡住的是「文件读不出来还硬写」
    // ——覆盖它等于把用户原来的选择彻底洗掉（没有取证通道）。
    if (toolTableStateValue === 'unknown') return { ok: false as const, error: toolTableRefuseMessage() }
    // 落盘在写锁里，落完**出了锁**再刷新：刷新是两处目录读，不必占着写锁拉长其它写者的
    // 等待（锁可重入，但代价是重入方也一起变慢）。
    return deps.withWriteLock(async () => await writeToolTableSettingsLocked(next))
  }
  /**
   * 修复通道：把**损坏 / 不可读**的侧车改名留存，再按出厂名单继续。
   *
   * 为什么必须有：`unknown` 状态下所有写都被拒（`mutateToolTableSettings` 与
   * `writeToolTableSettings` 两道），而唯一能改变状态的途径就是重写这个文件 ——
   * 没有这条通道，侧车一坏，模型和用户都只能去手动删文件。
   *
   * 只在异常状态可用：健康的文件不做事（返回 `ok:false` 说明原因），免得把「恢复」
   * 误用成「清空我的设置」。改名而不是删除：原文件留在 hub 里供事后排查。
   *
   * 改名后立刻写出厂名单，是因为 `unknown` 状态本身也要清 —— 只改名不写盘的话，
   * 下一次读会把 missing 当默认，但缓存里的 unknown 与上报要等那次读才消。
   *
   * @returns `quarantined` = 留存文件的路径；`null` = 文件本来就不在（无可留存）。
   */
  async function repairToolTable(): Promise<{ ok: true; quarantined: string | null } | { ok: false; error: string }> {
    await deps.ensurePaths()
    return deps.withWriteLock(async () => {
      const abs = hubPath(TOOL_TABLE_FILE)
      const checked = checkToolTableRead(await deps.readJsonFileStrict(abs))
      if (checked.status === 'ok' || checked.status === 'missing') {
        return { ok: false as const, error: '工具表侧车当前可读（未损坏 / 未不可读），修复入口只在状态异常时可用；未改动任何东西' }
      }
      let quarantined: string | null = null
      try {
        quarantined = abs + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')
        await renameWithRetry(abs, quarantined)
      } catch (e) {
        // 改名失败（权限 / 占用）就**不**写：写下去等于把读不出来的原文件覆盖掉。
        return { ok: false as const, error: '修复失败（未改动原文件）：' + deps.message(e) }
      }
      const clean = normalizeHidden([...DEFAULT_HIDDEN_TOOLS])
      try {
        await deps.writeJsonFile(abs, { hidden: clean, presets: [] })
      } catch (e) {
        return { ok: false as const, error: '原文件已留存为 ' + quarantined + '，但写回出厂名单失败：' + deps.message(e) }
      }
      toolTableCache = { at: Date.now(), value: { hidden: clean, presets: [] }, off: new Set(clean) }
      toolTableStateValue = 'ok'
      toolTableIssueValue = null
      clearRuntimeNote('tool-table-file')
      try { deps.mcp.scheduleToolRestrictions() } catch { /* 可见性会等下一次 tools/change */ }
      return { ok: true as const, quarantined }
    })
  }

  /**
   * 锁内读-改-写：strict 读当前值 → 回调算新值 → 再确认一次并落盘。
   * 回调返回 `{ok:false}` 时不写盘；读坏时直接返回拒绝，绝不拿缓存 / 默认值当基线。
   */
  async function mutateToolTableSettings(
    mutate: (current: ToolTableSettings) => ToolTableSettings | ToolTableMutationFailure,
  ): Promise<{ ok: true; settings: ToolTableSettings } | ToolTableMutationFailure> {
    await deps.ensurePaths()
    return deps.withWriteLock(async () => {
      const checked = checkToolTableRead(await deps.readJsonFileStrict(hubPath(TOOL_TABLE_FILE)))
      if (checked.status === 'corrupt' || checked.status === 'unreadable') {
        toolTableStateValue = 'unknown'
        toolTableIssueValue = checked.status
        publishToolTableNote(checked.status, checked.error)
        return { ok: false as const, error: toolTableRefuseMessage() }
      }
      const current = checked.status === 'missing'
        ? DEFAULT_TOOL_TABLE_SETTINGS
        : migrateLegacyToolNames(checked.value).settings
      const outcome = mutate(current)
      if ((outcome as ToolTableMutationFailure).ok === false) return outcome as ToolTableMutationFailure
      const next = outcome as ToolTableSettings
      const saved = await writeToolTableSettingsLocked(next)
      if (!saved.ok) return saved
      return { ok: true as const, settings: next }
    })
  }
  /** 自主记忆总开关此刻开没开。没装配时按关算（藏起来是安全侧）。 */
  const proactiveOn = (): boolean => deps.proactiveMemoryEnabled?.() === true
  /** 此刻不允许被关掉的工具（只认已注册的；开关没开时是空表）。 */
  const forcedVisible = (): string[] =>
    proactiveOn() && toolTableSizes.has(PROACTIVE_MEMORY_TOOL) ? [PROACTIVE_MEMORY_TOOL] : []
  /** 此刻不允许被打开的工具（对称的另一半）。 */
  const forcedHidden = (): string[] =>
    !proactiveOn() && toolTableSizes.has(PROACTIVE_MEMORY_TOOL) ? [PROACTIVE_MEMORY_TOOL] : []
  /**
   * 工具表数据里永远不含自主记忆那条工具（展示与保存都不带它）。
   * 运行时的「开 / 关」由 `withProactiveTool` 与 `overlayWithProactiveTool` 按开关强制。
   */
  const normalizeHidden = (hidden: readonly string[]): string[] => stripProactiveToolHidden(hidden)

  /**
   * 回给界面的同一份形状：当前名单 + 已存方案 + 出厂默认名单 + 体积报告。
   *
   * `defaultHidden` 单独回一份而不是塞进 `presets`：那条**不存在文件里**（它是代码里的
   * `DEFAULT_HIDDEN_TOOLS`），写进文件就会出现"用户删不掉的一条数据"。界面把它排在最前、
   * 不给删除键，词典出它的名字。
   */
  const toolTablePayload = (value: ToolTableSettings) => {
    const hidden = normalizeHidden(value.hidden)
    return {
      ok: true, hidden, presets: value.presets,
      // 出厂名单同样不含自主记忆工具：它在界面上没有行，也不进「出厂默认关 N 条」的计数。
      defaultHidden: stripProactiveToolHidden(DEFAULT_HIDDEN_TOOLS),
      report: toolTableReport(hidden),
      // 侧车状态随每次读回传：界面据此禁用开关并说明原因（unknown 时保存会被服务端拒绝）。
      state: toolTableStateValue, issue: toolTableIssueValue,
    }
  }
  /** 方案名：折叠空白 + 截到上限。空名由调用方报错（这里不猜"用户想叫什么"）。 */
  const presetNameOf = (raw: unknown): string =>
    String(raw ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX_LENGTH)
  async function toolTableOp(args: any): Promise<any> {
    // 两个方向都锁：开着的不能关、关着的不能开，这条工具没有独立于总开关的状态。
    const forced = new Set(forcedVisible())
    const forcedOff = new Set(forcedHidden())
    if (!args || args.set !== true) {
      // 存 / 删方案都不动 `hidden`，所以这两条路**不**重排可见性、也不刷目录（那是 `set`
      // 那一条才有的三处联动）。失败原因回 `code` 不回中文串 —— 英文界面会原样露出中文。
      if (args && args.presetSave !== undefined) {
        const name = presetNameOf(args.presetSave)
        if (name === '') return { ok: false, code: 'nameEmpty' }
        const outcome = await mutateToolTableSettings((current) => {
          const added = addPreset(current, name, current.hidden)
          // 同名不覆盖：撞名要用户换个名字，而不是悄悄改掉已有那份。
          if (added.exists) return { ok: false, code: 'nameTaken', name }
          if (current.presets.length >= PRESET_MAX_COUNT) {
            return { ok: false, code: 'limit', limit: PRESET_MAX_COUNT }
          }
          return added.settings
        })
        if (!outcome.ok) return outcome
        return toolTablePayload(outcome.settings)
      }
      if (args && args.presetDelete !== undefined) {
        const name = presetNameOf(args.presetDelete)
        const outcome = await mutateToolTableSettings((current) => {
          const dropped = dropPreset(current, name)
          return dropped.changed ? dropped.settings : { ok: false, code: 'notFound', name }
        })
        if (!outcome.ok) return outcome
        return toolTablePayload(outcome.settings)
      }
      return toolTablePayload(await readToolTableSettings())
    }
    // 逐条改（`toggle`）：改动落在**当前这份**名单上，在写锁里现读现改 ——
    // 整份替换要先把名单读出来再算差量，读与写之间有窗口，两个写者会互相覆盖。
    if (Array.isArray(args.toggle) && args.toggle.length > 0) {
      const toggles = (args.toggle as any[])
        .filter((t) => t && typeof t.name === 'string' && t.name !== '')
        .map((t) => ({ name: String(t.name), hidden: t.hidden === true }))
        // 只收**已注册**的名字：写进来的陌生名字在下一次 restrict 时会让官方抛错。
        // 锁定的两条方向都不收：模型侧 `tool_manager_tools` 也改不动自主记忆工具。
        .filter((t) => toolTableSizes.has(t.name) && !forced.has(t.name) && !forcedOff.has(t.name))
      if (toggles.length === 0) {
        const names = (args.toggle as any[]).map((t: any) => String(t && t.name))
        const blocked = names.filter((name) => forced.has(name) || forcedOff.has(name))
        return {
          ok: false,
          error: blocked.length
            ? 'this tool follows the autonomous memory switch and cannot be toggled here: ' + blocked.join(', ')
            : 'none of these are this plugin\'s tools: ' + names.join(', '),
        }
      }
      const outcome = await mutateToolTableSettings((current) => ({
        // 归一放在最后：不管盘上留的是上一版哪一边的值，这条工具都只跟总开关走。
        hidden: normalizeHidden(applyToolTableToggles(current.hidden, toggles)),
        presets: current.presets,
      }))
      if (!outcome.ok) return outcome
      deps.mcp.scheduleToolRestrictions()
      await Promise.all([
        deps.skillCatalog.refresh().catch(() => { /* 目录刷新失败不该让保存失败 */ }),
        deps.subagentCatalog.refresh().catch(() => { /* 同上 */ }),
      ])
      return toolTablePayload(outcome.settings)
    }
    // 只收**已注册**的名字：写进来的陌生名字在下一次 restrict 时会让官方抛错
    // （"names unknown global tool"）。注册失败的工具本来也不在表里。
    const outcome = await mutateToolTableSettings((current) => {
      // 先滤掉没注册的名字，再归一那条跟随开关的工具（顺序不能反：归一可能往里加名字）。
      const hidden = normalizeHidden(
        normalizeToolTableSettings({ hidden: args.hidden }).hidden.filter((name) => toolTableSizes.has(name)),
      )
      return { hidden, presets: current.presets }
    })
    if (!outcome.ok) return outcome
    // 三处跟着变：可见性（restrict 名单重排）、两个目录（截断提示里点名的工具可能没了）。
    // 目录的 refresh 会把新的一句话注入出去 —— 内容变了才重发，这是正确行为。
    deps.mcp.scheduleToolRestrictions()
    await Promise.all([
      deps.skillCatalog.refresh().catch(() => { /* 目录刷新失败不该让保存失败 */ }),
      deps.subagentCatalog.refresh().catch(() => { /* 同上 */ }),
    ])
    return toolTablePayload(outcome.settings)
  }
  return {
    toolTableSizes,
    toolTableSummaries,
    recordToolSize,
    readToolTableSettings,
    toolTableState: () => ({ state: toolTableStateValue, issue: toolTableIssueValue }),
    toolTableWriteError: toolTableRefuseMessage,
    toolTableHidden,
    writeToolTableSettings,
    mutateToolTableSettings,
    toolTableReport,
    toolTableOp,
    repairToolTable,
  }
}
