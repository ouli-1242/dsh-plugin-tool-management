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
import { hubPath } from './hub.js'
import {
  addPreset, buildToolTableReport, DEFAULT_HIDDEN_TOOLS, dropPreset, migrateLegacyToolNames,
  normalizeToolTableSettings, PRESET_MAX_COUNT, PRESET_NAME_MAX_LENGTH, toolTableSettingsFrom,
  type ToolTableReport, type ToolTableRow, type ToolTableSettings,
} from './tools/table.js'

export interface ToolTableSwitchDeps {
  /** 确保 hub 目录存在（读侧车前调用，与母文件同一条）。 */
  ensurePaths(): Promise<any>
  readJsonFile(abs: string): Promise<any>
  writeJsonFile(abs: string, data: any): Promise<void>
  /** 全局写锁：侧车的写在它下面串行（不可重入）。 */
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
}

export interface ToolTableSwitch {
  /** 注册时量到的工具体积（同一个 Map 交回母文件：注册口在别处写它）。 */
  toolTableSizes: Map<string, number>
  recordToolSize(def: ToolDefinition): void
  readToolTableSettings(force?: boolean): Promise<ToolTableSettings>
  toolTableHidden(): ReadonlySet<string>
  writeToolTableSettings(next: ToolTableSettings): Promise<{ ok: true } | { ok: false; error: string }>
  toolTableReport(hidden?: readonly string[]): ToolTableReport
  toolTableOp(args: any): Promise<any>
}

export function createToolTableSwitch(deps: ToolTableSwitchDeps): ToolTableSwitch {
      // ---------- 模型工具表开关（侧车 `tool-table.json`，界面在「兼容」页）----------
  // 工具表按**每个请求**付钱：20 个工具的整份定义合计 ≈3,769 tok 每轮都在。关掉某几个，
  // 它们整份不进请求（实测口径与取舍见 src/tools/table.ts 的文件头）。**出厂就已经关了十五条**
  // （20 条里实发只剩 5 条）—— 名单、判据与代价在 `DEFAULT_HIDDEN_TOOLS`，只在这个人从没记过
  // 选择时铺（见下面的 `toolTableSettingsFrom`）。
  //
  // 为什么放在目录之前：两个目录的「用 `X` 查」提示要跟着这份设置变（工具关掉后那句话
  // 就是假的），所以它们的构造依赖在这块之后 —— 不做前向引用，顺序就是依赖顺序。
  const TOOL_TABLE_FILE = 'tool-table.json'
  const TOOL_TABLE_TTL_MS = 3000
  /** 注册时量到的工具体积（只记真进了表的那些；量的是 register 收到的整份定义）。 */
  const toolTableSizes = new Map<string, number>()
  function recordToolSize(def: ToolDefinition): void {
    try {
      const name = String((def as { name?: unknown }).name ?? '')
      if (name === '') return
      // 与宿主同一口径（dsh-token-meter 的 estimateToolsTokens 就是把 tools 整份
      // JSON.stringify 后除以 4），所以这里量整份定义，不只量 description。
      toolTableSizes.set(name, JSON.stringify(def).length)
    } catch { /* 量不出来就不记：它只影响界面上的估算数字 */ }
  }
  let toolTableCache: { at: number; value: ToolTableSettings; off: ReadonlySet<string> } | null = null
  async function readToolTableSettings(force = false): Promise<ToolTableSettings> {
    if (toolTableCache && !force && Date.now() - toolTableCache.at < TOOL_TABLE_TTL_MS) return toolTableCache.value
    await deps.ensurePaths()
    const raw = await deps.readJsonFile(hubPath(TOOL_TABLE_FILE))
    // 0.14.0 旧工具名迁移：读侧翻译一次并**回写盘**（幂等）。不迁移的话，用户"关掉了某条"
    // 的意图会在新名字上静默失效 —— 那条工具照旧每轮发出去，而界面上看不出来。
    // 写失败不回滚本次读取：内存里已经是迁移后的值，下次读会再试一次。
    // 侧车不存在（`readJsonFile` 给 null）= 用户从没记过选择 ⇒ 用**出厂默认**（十五条不发，
    // 实发 5 条；判据与代价见 tools/table.ts 的 DEFAULT_HIDDEN_TOOLS）。存过盘的
    // 一律照盘上那份，包括显式的 `hidden: []` —— 那是"我全都要"，不能被默认值盖掉。
    const migrated = migrateLegacyToolNames(toolTableSettingsFrom(raw))
    const value = migrated.settings
    if (migrated.changed) {
      try { await deps.writeJsonFile(hubPath(TOOL_TABLE_FILE), value) } catch { /* 回写失败：本次仍按迁移后的值生效 */ }
    }
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
   * **空集**并异步预热 —— 空集不是出厂默认（出厂关着五条），是刻意的：预热前的这一瞬与
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
  const toolTableRows = (): ToolTableRow[] => [...toolTableSizes].map(([name, bytes]) => ({ name, bytes }))
  const toolTableReport = (hidden: readonly string[] = [...toolTableHidden()]): ToolTableReport =>
    buildToolTableReport(toolTableRows(), hidden)
  /** 落盘 + 同步内存缓存（三条写路径共用：改勾选 / 存方案 / 删方案）。 */
  async function writeToolTableSettings(next: ToolTableSettings): Promise<{ ok: true } | { ok: false; error: string }> {
    await deps.ensurePaths()
    // 落盘在写锁里，落完**出了锁**再刷新（`withWriteLock` 是一条不可重入的链：锁里再调
    // 一次会等自己，直接卡死）。刷新是两处目录读，本来也不必占着写锁。
    return deps.withWriteLock(async () => {
      try {
        await deps.writeJsonFile(hubPath(TOOL_TABLE_FILE), next)
      } catch (e) {
        return { ok: false as const, error: '设置保存失败: ' + deps.message(e) }
      }
      toolTableCache = { at: Date.now(), value: next, off: new Set(next.hidden) }
      return { ok: true as const }
    })
  }
  /**
   * 回给界面的同一份形状：当前名单 + 已存方案 + 出厂默认名单 + 体积报告。
   *
   * `defaultHidden` 单独回一份而不是塞进 `presets`：那条**不存在文件里**（它是代码里的
   * `DEFAULT_HIDDEN_TOOLS`），写进文件就会出现"用户删不掉的一条数据"。界面把它排在最前、
   * 不给删除键，词典出它的名字。
   */
  const toolTablePayload = (value: ToolTableSettings) => ({
    ok: true, hidden: value.hidden, presets: value.presets,
    defaultHidden: [...DEFAULT_HIDDEN_TOOLS], report: toolTableReport(value.hidden),
  })
  /** 方案名：折叠空白 + 截到上限。空名由调用方报错（这里不猜"用户想叫什么"）。 */
  const presetNameOf = (raw: unknown): string =>
    String(raw ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX_LENGTH)
  async function toolTableOp(args: any): Promise<any> {
    const current = await readToolTableSettings()
    if (!args || args.set !== true) {
      // 存 / 删方案都不动 `hidden`，所以这两条路**不**重排可见性、也不刷目录（那是 `set`
      // 那一条才有的三处联动）。失败原因回 `code` 不回中文串 —— 英文界面会原样露出中文。
      if (args && args.presetSave !== undefined) {
        const name = presetNameOf(args.presetSave)
        if (name === '') return { ok: false, code: 'nameEmpty' }
        const added = addPreset(current, name, current.hidden)
        // 同名不覆盖（用户裁定）：撞名要用户换个名字，而不是悄悄改掉已有那份。
        if (added.exists) return { ok: false, code: 'nameTaken', name }
        if (current.presets.length >= PRESET_MAX_COUNT) {
          return { ok: false, code: 'limit', limit: PRESET_MAX_COUNT }
        }
        const saved = await writeToolTableSettings(added.settings)
        if (!saved.ok) return saved
        return toolTablePayload(added.settings)
      }
      if (args && args.presetDelete !== undefined) {
        const name = presetNameOf(args.presetDelete)
        const dropped = dropPreset(current, name)
        if (!dropped.changed) return { ok: false, code: 'notFound', name }
        const saved = await writeToolTableSettings(dropped.settings)
        if (!saved.ok) return saved
        return toolTablePayload(dropped.settings)
      }
      return toolTablePayload(current)
    }
    // 只收**已注册**的名字：写进来的陌生名字在下一次 restrict 时会让官方抛错
    // （"names unknown global tool"）。注册失败的工具本来也不在表里。
    const hidden = normalizeToolTableSettings({ hidden: args.hidden }).hidden
      .filter((name) => toolTableSizes.has(name))
    const next: ToolTableSettings = { hidden, presets: current.presets }
    const saved = await writeToolTableSettings(next)
    if (!saved.ok) return saved
    // 三处跟着变：可见性（restrict 名单重排）、两个目录（截断提示里点名的工具可能没了）。
    // 目录的 refresh 会把新的一句话注入出去 —— 内容变了才重发，这是正确行为。
    deps.mcp.scheduleToolRestrictions()
    await Promise.all([
      deps.skillCatalog.refresh().catch(() => { /* 目录刷新失败不该让保存失败 */ }),
      deps.subagentCatalog.refresh().catch(() => { /* 同上 */ }),
    ])
    return toolTablePayload(next)
  }
  return {
    toolTableSizes,
    recordToolSize,
    readToolTableSettings,
    toolTableHidden,
    writeToolTableSettings,
    toolTableReport,
    toolTableOp,
  }
}
