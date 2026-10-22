// 工具停用的那一层边界：停用表（TTL 缓存）、「已知工具」侧车、以及把停用名单装到每个
// agent scope 上的可见性半边（restrict）+ 执行侧要用的开关写入口。
//
// 正文从 mcp/manager.ts 的 createMcpManager 闭包里整段搬来，一字未改（缩进本来就同层；
// 改的只有闭包作用域的名字走 deps —— moved-verify 按这两类容差机检）：
// ensurePaths / readJsonFile / writeJsonFile / withWriteLock / message / tools /
// normalizeKnownTools，以及侧车的三件常量 SIDECAR_TTL_MS / MCP_DISABLED_TOOLS_FILE /
// MCP_KNOWN_TOOLS_FILE 与落点函数 mcpSidecar。常量按**原名**传进来，是为了让搬来的那些行
// 不必改名 —— 这一段读起来像「读一次侧车、 TTL 内不再读盘」，靠的就是那几个熟悉的名字。
// deps 形参仍叫 deps：块里那五处 `deps.carrierHiddenTools` / `deps.pluginHiddenTools` 是
// 原样文本，换名就要改行。
//
// 为什么这一簇必须整体搬：七个可见性状态量（disabledToolsCache / knownMcpToolsCache /
// restrictTimer / appliedNamesKey / desiredNames / agentRestrictions / appliedByAgent /
// seenAgents / epoch）里，只有 disabledToolsCache 被块外的 ops 段直接改写（改名、删台、
// 整表回写三处 + 出口读两处），所以它由本模块交回两个句柄：setDisabledToolsCache（按原
// 语义刷新 `{at, value}` 那份缓存）与 disabledToolsSnapshot（同步读，无 I/O —— 工具门禁在
// 热路径上）。其余名字块外零引用，跟着走就行。
import { copyFile, stat } from 'node:fs/promises'
import { MCP_TOOL_PREFIX } from '../host-names.js'
import { clearRuntimeNote, noteRuntime } from '../compat/runtime-notes.js'
import {
  classifyDisabledTools,
  cloneDisabledTools,
  DisabledToolsUnavailableError,
  emptyDisabledTools,
  isUnsafeKey,
  type DisabledToolsIssue,
  type DisabledToolsRead,
  type JsonFileRead,
} from './disabled-tools.js'
import type { KnownMcpTool, ToolsService } from './manager.js'

export interface ToolVisibilityDeps {
  /** 通用侧车 JSON 读写（与母文件同一套）。 */
  readJsonFile(abs: string): Promise<any>
  /** 严格读（区分 ENOENT / 解析失败 / IO 失败；不调 ensurePaths）。 */
  readJsonFileStrict(abs: string): Promise<JsonFileRead>
  writeJsonFile(abs: string, data: any): Promise<void>
  /** 确保 hub 目录存在（每次读侧车前都调，与原实现一致）。 */
  ensurePaths(): Promise<any>
  /** 全局写锁：停用表的写都在它下面串行（注意不可重入）。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  /** 错误 → 文案（与全仓同源）。 */
  message(e: unknown): string
  /** 宿主 tools 服务：读不受限的插件级 schema 视图，装层则在 agent scope 上。 */
  tools: ToolsService
  /** 「已知工具」侧车一行的归一化（母文件的纯函数）。 */
  normalizeKnownTools(raw: unknown): KnownMcpTool[]
  /** MCP 侧车绝对路径（都在 hub 内）。 */
  mcpSidecar(name: string): string
  SIDECAR_TTL_MS: number
  MCP_DISABLED_TOOLS_FILE: string
  MCP_KNOWN_TOOLS_FILE: string
  /** 「模型工具表」关掉的本插件工具（同步快照）。 */
  pluginHiddenTools?(): string[]
  /** 「有官方等价物在场就让位」那半边：按 agent 算的额外 hide 名单。 */
  carrierHiddenTools?(agent: unknown): Promise<string[]>
  /**
   * 本会话的 MCP 可见性覆盖（0.21.2）：在**此刻注册着的**工具全名上算出的两个名单。
   *
   * 全名要按"此刻注册了什么"（`tools.schemas()`）算，而那件事只有本模块顺手 —— 让调用方
   * 去拼全名等于把"哪些名字算数"抄第二份。所以调用方的判据（四层并值）是按
   * `(server, tool)` 出的，展开成注册全名的这一步留在 `restrictAgent`（见那里的调用）。
   *
   * 语义边界：会话层**不改连接**（`cordis.patch.yml` 是进程级的），只让工具在本会话里
   * 看不见。`allow` 名单会把全局停用表关着的工具**从 deny 里减掉** —— 本会话看得见、
   * 调得动，别的会话照旧。
   */
  sessionMcpOverlay?(agent: unknown): Promise<{ allow?: readonly string[]; deny?: readonly string[] }>
  /** 本会话的模型工具表覆盖（0.21.2）：与 MCP overlay 合进同一层 restrict。 */
  sessionToolTableOverlay?(agent: unknown): { allow?: readonly string[]; deny?: readonly string[] } | Promise<{ allow?: readonly string[]; deny?: readonly string[] }>
}

export interface ToolVisibility {
  readDisabledTools(force?: boolean): Promise<Record<string, string[]>>
  /** 四态读（需要区分 ok / missing / corrupt / unreadable 时用）。 */
  readDisabledToolsResult(force?: boolean): Promise<DisabledToolsRead>
  /** 同步安全状态：首次读完成前、corrupt / unreadable 都是 unknown。 */
  disabledToolsState(): 'ok' | 'unknown'
  /** 诊断状态：UI 用它区分损坏 / 不可读；正常与 missing 为 null。 */
  disabledToolsIssue(): DisabledToolsIssue | null
  /** 最近一次损坏取证副本的绝对路径（没有副本 / 不可读时为 null）。 */
  disabledToolsForensicPath(): string | null
  /**
   * 强制为异常停用表留一份取证副本（复制失败即抛）。corrupt / unreadable 的覆盖型写入
   * 必须先过这一关；同一份文件已经复制成功过时会复用同一路径。
   */
  ensureDisabledToolsForensics(): Promise<string>
  /**
   * 重置停用表：仅在 corrupt / unreadable 时可用。两者都必须先取证成功才覆盖；
   * 写回空表（原子写）并清掉 unknown 状态与上报。必须在写锁内调用（本函数自己加锁）。
   */
  resetDisabledTools(): Promise<{ ok: true; forensics: string | null; issue: DisabledToolsIssue } | { ok: false; error: string }>
  readKnownMcpTools(force?: boolean): Promise<Record<string, KnownMcpTool[]>>
  writeKnownMcpTools(value: Record<string, KnownMcpTool[]>): Promise<void>
  mutateKnownMcpTools(mutate: (known: Record<string, KnownMcpTool[]>) => boolean): Promise<void>
  mergeLiveToolsInto(known: Record<string, KnownMcpTool[]>, live: Record<string, KnownMcpTool[]>): boolean
  mcpmToolEnabled(args: any): Promise<any>
  attachAgent(agent: unknown): void
  detachAgent(agent: unknown): void
  applyToolRestrictions(): Promise<void>
  scheduleToolRestrictions(): void
  /** 母文件的 ops 段直接改写停用表时的落缓存入口（等价于原来的 `disabledToolsCache = {at, value}`）。 */
  setDisabledToolsCache(value: Record<string, string[]>): void
  /** 停用表的同步快照（无 I/O；未预热过时与原来一样给空表）。 */
  disabledToolsSnapshot(): Record<string, string[]>
  /** 卸载清理：清重排定时器、把挂在每个 agent scope 上的限制都撤掉。 */
  disposeVisibility(): void
}

export function createToolVisibility(deps: ToolVisibilityDeps): ToolVisibility {
  // ---------- per-tool enable/disable (execution + visibility boundary) ----------
  // dsh-mcp-client has no per-tool config, but the DSH tool runtime exposes
  // two official seams: `tools.restrict({ deny })` removes a global tool from
  // every scope's model-visible schema list, and `tools.guard` denies the call
  // before the body runs. Disabled tools therefore become invisible AND
  // uncallable — no patch rewrite, no DSH restart.
  let disabledToolsCache: { at: number; read: DisabledToolsRead; value: Record<string, string[]> } | null = null
  /** 写成功后自增：晚到的旧读不得覆盖新缓存（见 readDisabledToolsResult）。 */
  let disabledToolsEpoch = 0
  /** 同一时刻只有一个读在飞；force 也先等它，避免并发读把磁盘放大。 */
  let disabledToolsInflight: Promise<DisabledToolsRead> | null = null
  /**
   * 损坏文件的取证副本（copyFile，**不 rename**：原文件留在原处，外部工具仍能检查）。
   * `key` = 路径 + size + mtime：同一份坏文件只复制一次，TTL 到期重读不会堆出一串副本。
   */
  let forensicCopy: { key: string; path: string | null } | null = null

  function freshDisabledToolsRead(at: number): DisabledToolsRead | null {
    return disabledToolsCache && at - disabledToolsCache.at < deps.SIDECAR_TTL_MS
      ? disabledToolsCache.read
      : null
  }

  /** 对外安全状态：首次读完成前、corrupt / unreadable 都是 unknown。 */
  function disabledToolsState(): 'ok' | 'unknown' {
    const read = disabledToolsCache?.read
    if (!read) return 'unknown'
    return read.status === 'ok' || read.status === 'missing' ? 'ok' : 'unknown'
  }

  function disabledToolsIssue(): DisabledToolsIssue | null {
    const status = disabledToolsCache?.read.status
    return status === 'corrupt' || status === 'unreadable' ? status : null
  }

  function publishDisabledToolsNotes(read: DisabledToolsRead, forensics: string | null = null): void {
    if (read.status === 'ok' || read.status === 'missing') {
      clearRuntimeNote('mcp-disabled-tools')
    } else {
      const forensicNote = forensics ? `；已保留取证副本：${forensics}` : ''
      noteRuntime({
        id: 'mcp-disabled-tools',
        label: 'MCP 停用表',
        kind: 'read',
        fallback: 'refuse-operation',
        detail: read.status === 'corrupt'
          ? `MCP 停用表损坏（${read.error}）：所有 mcp__* 工具已被拒绝调用；请在 MCP 页重置停用表${forensicNote}。`
          : `MCP 停用表不可读（${read.error}）：所有 mcp__* 工具已被拒绝调用；请检查文件权限或重置停用表${forensicNote}。`,
        detailKey: read.status === 'corrupt' ? 'mcp-disabled-tools.corrupt' : 'mcp-disabled-tools.unreadable',
        params: { reason: read.error, ...(forensics ? { forensics } : {}) },
      })
    }
    if (read.status === 'ok' && read.warnings.length) {
      noteRuntime({
        id: 'mcp-disabled-tools-names',
        label: 'MCP 停用表中的工具名',
        kind: 'read',
        fallback: 'inform-only',
        detail: '停用表里有本插件工具名格式不认识的名字，已原样保留并继续参与拦截：' + read.warnings.join('、'),
        detailKey: 'mcp-disabled-tools.names',
        params: { names: read.warnings.join('、') },
      })
    } else if (read.status !== 'corrupt' && read.status !== 'unreadable') {
      clearRuntimeNote('mcp-disabled-tools-names')
    }
  }

  async function readDisabledToolsOnce(): Promise<DisabledToolsRead> {
    const result = await deps.readJsonFileStrict(deps.mcpSidecar(deps.MCP_DISABLED_TOOLS_FILE))
    if (result.status !== 'ok') return result
    return classifyDisabledTools(result.value)
  }

  async function readDisabledToolsResult(force = false): Promise<DisabledToolsRead> {
    const startedAt = Date.now()
    if (!force) {
      const cached = freshDisabledToolsRead(startedAt)
      if (cached) return cached
    }
    if (disabledToolsInflight) {
      const shared = await disabledToolsInflight
      if (!force) return shared
      if (disabledToolsCache && disabledToolsCache.at >= startedAt) return disabledToolsCache.read
    }
    if (!force) {
      const cached = freshDisabledToolsRead(startedAt)
      if (cached) return cached
    }
    const startEpoch = disabledToolsEpoch
    const task = (async () => {
      const read = await readDisabledToolsOnce()
      // 读期间有写完成：写侧已经把新值放进缓存并 bump 了 epoch，晚到的旧读不得覆盖它。
      if (disabledToolsEpoch !== startEpoch && disabledToolsCache) return disabledToolsCache.read
      // 损坏时自动留一份取证副本（同一份坏文件只留一次）。失败不改变 fail-closed 结论，
      // 只是 note 里没有路径 —— 用户仍可从 MCP 页重置（重置路径会强制取证）。
      let forensics: string | null = null
      if (read.status === 'corrupt') {
        try { forensics = await copyCorruptDisabledTools(false) } catch { forensics = null }
      }
      const value = read.status === 'ok' ? read.value : emptyDisabledTools()
      disabledToolsCache = { at: Date.now(), read, value }
      publishDisabledToolsNotes(read, forensics)
      return read
    })()
    disabledToolsInflight = task
    try {
      return await task
    } finally {
      if (disabledToolsInflight === task) disabledToolsInflight = null
    }
  }

  /**
   * 兼容出口：ok / missing 返回表，corrupt / unreadable 抛具名错误。
   *
   * 新代码应优先用 `readDisabledToolsResult`（需要区分状态时）或 `disabledToolsState`
   * （同步判定）。保留这个出口是为了让“没接状态的消费者”至少 fail-closed，而不是读到空表。
   */
  async function readDisabledTools(force = false): Promise<Record<string, string[]>> {
    const read = await readDisabledToolsResult(force)
    if (read.status === 'ok') return read.value
    if (read.status === 'missing') return emptyDisabledTools()
    throw new DisabledToolsUnavailableError(read.status, read.error)
  }

  /** 同一份坏文件的稳定标识：路径 + 大小 + mtime（读不到元数据时退化为路径）。 */
  async function forensicKeyOf(abs: string): Promise<string> {
    try {
      const st = await stat(abs)
      return abs + ':' + st.size + ':' + st.mtimeMs
    } catch {
      return abs
    }
  }

  /**
   * 把损坏的停用表复制一份到 `<侧车>.corrupt-<ts>`（**不 rename**，原文件留在原处）。
   *
   * `requireSuccess`：重置路径下取证是**前置条件** —— 复制不了就不许覆盖，否则证据没了
   * 还把一个无法解释的状态洗白。读路径下的自动取证失败不算错误（fail-closed 照旧），
   * 只是没有副本可给用户。
   */
  async function copyCorruptDisabledTools(requireSuccess: boolean): Promise<string | null> {
    const abs = deps.mcpSidecar(deps.MCP_DISABLED_TOOLS_FILE)
    const key = await forensicKeyOf(abs)
    if (forensicCopy && forensicCopy.key === key && (forensicCopy.path !== null || !requireSuccess)) {
      return forensicCopy.path
    }
    const dest = abs + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')
    try {
      await copyFile(abs, dest)
      forensicCopy = { key, path: dest }
      return dest
    } catch (e) {
      forensicCopy = { key, path: null }
      if (requireSuccess) throw new Error('取证副本写入失败（未改动原文件）：' + deps.message(e))
      return null
    }
  }

  /** 覆盖型写入的前置条件：异常状态必须先留下一份可检查的原文件副本。 */
  async function ensureDisabledToolsForensics(): Promise<string> {
    const path = await copyCorruptDisabledTools(true)
    if (path === null) throw new Error('取证副本写入失败（未改动原文件）')
    return path
  }

  /** 写成功后的唯一缓存入口：安全克隆 + bump epoch + 清掉损坏上报。 */
  function setDisabledToolsCacheInternal(value: Record<string, string[]>): void {
    disabledToolsEpoch += 1
    const safe = cloneDisabledTools(value)
    disabledToolsCache = { at: Date.now(), read: { status: 'ok', value: safe, warnings: [] }, value: safe }
    clearRuntimeNote('mcp-disabled-tools')
    clearRuntimeNote('mcp-disabled-tools-names')
  }

  /**
   * 重置停用表（仅 unknown 时可用）。
   *
   * 顺序不可换：先**证明**状态确实异常 → 损坏时先取证（复制不了就中止，绝不在
   * "证据保不住"的情况下覆盖）→ 原子写空表 → 清缓存 / note → 重排可见性。
   * 正常可读的表拒绝重置：这个入口是恢复通道，不是"清空我的配置"的捷径。
   */
  async function resetDisabledTools(): Promise<{ ok: true; forensics: string | null; issue: DisabledToolsIssue } | { ok: false; error: string }> {
    return deps.withWriteLock(async () => {
      let read: DisabledToolsRead
      try {
        read = await readDisabledToolsResult(true)
      } catch (e) {
        return { ok: false as const, error: '读取停用表失败：' + deps.message(e) }
      }
      if (read.status === 'ok' || read.status === 'missing') {
        return { ok: false as const, error: '停用表当前可读（未损坏 / 未不可读），重置入口只在状态异常时可用；未改动任何东西' }
      }
      let forensics: string | null = null
      // corrupt 与 unreadable 都是异常状态：覆盖之前必须证明证据保得住。unreadable 时
      // copyFile 往往也会失败 —— 那就如实拒绝（先修权限 / 释放占用），绝不空表覆盖。
      try {
        forensics = await ensureDisabledToolsForensics()
      } catch (e) {
        return { ok: false as const, error: deps.message(e) }
      }
      try {
        await deps.writeJsonFile(deps.mcpSidecar(deps.MCP_DISABLED_TOOLS_FILE), {})
      } catch (e) {
        return { ok: false as const, error: '重置停用表失败（未改动原有内容）：' + deps.message(e) }
      }
      setDisabledToolsCacheInternal(emptyDisabledTools())
      scheduleToolRestrictions()
      return { ok: true as const, forensics, issue: read.status }
    })
  }

  /** Fully-qualified model-facing names (`mcp__<serverName>__<tool>`) of every disabled tool. */
  function disabledToolNames(map: Record<string, string[]>): string[] {
    const out: string[] = []
    for (const serverName of Object.keys(map)) {
      for (const tool of map[serverName]) out.push(MCP_TOOL_PREFIX + serverName + '__' + tool)
    }
    return out
  }
  // ---------- 「已知工具」侧车（v0.8.1）-----------------------------------
  // MCP 工具名只在服务器**运行**时可见（tools.schemas() 里才有）。未运行的服务器在
  // 场景档案里既显示 0 工具、工具明细也空空如也 —— 用户没法给未运行服务器挑工具。
  // 每次枚举到 live 工具时按 serverName 记一份「最后见过的工具名」，未运行时用它兜底：
  // 场景档案能列出/勾选，进入场景后按实际注册的工具生效（restrict 会过滤掉不存在的名字）。
  let knownMcpToolsCache: { at: number; value: Record<string, KnownMcpTool[]> } | null = null
  async function readKnownMcpTools(force = false): Promise<Record<string, KnownMcpTool[]>> {
    if (knownMcpToolsCache && !force && Date.now() - knownMcpToolsCache.at < deps.SIDECAR_TTL_MS) return knownMcpToolsCache.value
    // 读路径不调 ensurePaths：hubPath 走 resolveDshHome，与补丁路径推导无关（见 G1）。
    const raw = await deps.readJsonFile(deps.mcpSidecar(deps.MCP_KNOWN_TOOLS_FILE))
    const out = Object.create(null) as Record<string, KnownMcpTool[]>
    if (raw && typeof raw === 'object') {
      for (const [serverName, value] of Object.entries(raw as Record<string, unknown>)) {
        if (isUnsafeKey(serverName)) continue
        const list = deps.normalizeKnownTools(value)
        if (list.length) out[serverName] = list
      }
    }
    knownMcpToolsCache = { at: Date.now(), value: out }
    return out
  }
  async function writeKnownMcpTools(value: Record<string, KnownMcpTool[]>): Promise<void> {
    const p = await deps.ensurePaths()
    await deps.writeJsonFile(deps.mcpSidecar(deps.MCP_KNOWN_TOOLS_FILE), value)
    knownMcpToolsCache = { at: Date.now(), value: value }
  }
  /**
   * 「已知工具」侧车的**读-改-写**，整段在写锁内。
   *
   * 为什么不能「先 readKnownMcpTools() 再 writeKnownMcpTools()」（2026-09-30 审查 P2-15）：
   * 这个侧车有两个并发写者 —— 列表轮询（`mcpmListView`，每次发现新工具就回写）与
   * 临时启动（`mcpmTools` 等到工具注册后回写）。两步之间是队外窗口，两个写者各读到同一份
   * 旧表、各并进自己那一台服务器的工具，后写的把先写的整份覆盖掉 —— 先那台的"曾经见过"
   * 记录消失，未运行时场景档案里又变成 0 工具。
   *
   * `mutate` 收到的是**锁内刚读出来**的表（`force` 绕 TTL，否则拿到的还是锁外那份缓存）；
   * 返回 `true` 表示有变化、需要落盘。
   * 注意：`withWriteLock` **不可重入** —— 调用方不得已经持有写锁。
   */
  async function mutateKnownMcpTools(mutate: (known: Record<string, KnownMcpTool[]>) => boolean): Promise<void> {
    return deps.withWriteLock(async () => {
      const known = await readKnownMcpTools(true)
      if (!mutate(known)) return
      await writeKnownMcpTools(known)
    })
  }
  /**
   * 把「这次 live 见到的工具」并进一份已知工具表；返回是否有变化。
   *
   * **live 见到就整体替换那一台**（2026-10-19 用户实测：dhole 升级把 `smart_fetch` 一族改名成
   * `web_*` 之后，旧名字永远留在表里，详情页每轮都把死名字当「上次运行时」列出来，「刷新工具」
   * 也刷不掉 —— 它早先只要缓存非空就直接返回，而轮询路径的合并又是只进不出的并集）。理由：
   * 一台**正在运行**的服务器，它注册进来的工具集就是权威全貌，此刻已经不存在的旧名字留着，
   * 只会让界面拿"曾经见过"冒充"现在也有"。这份缓存的存在意义是「服务器没跑时的兜底」，
   * 不是历史博物馆。
   *
   * 只在 `live` 里**有这台并且非空**时才替换：这次没见到（服务器没跑 / 还没注册工具）就原样
   * 保留上一份 —— 否则一台掉线的服务器会被清空，场景档案随即失去挑工具的候选。
   * 描述按「live 优先、旧的兜底」合并：个别服务器会省略描述，别把上次记下来的那份弄丢。
   *
   * 抽出来是为了让"要不要写盘"的判断与"锁内真正合并"用**同一个**函数：调用方先在锁外
   * 对本地缓存跑一遍拿到 `changed`（决定要不要进锁），进锁后再对新鲜表跑一遍（那次的结果
   * 才决定落盘）—— 两边口径不一致的话，要么白写要么漏写。
   */
  function mergeLiveToolsInto(known: Record<string, KnownMcpTool[]>, live: Record<string, KnownMcpTool[]>): boolean {
    let changed = false
    for (const [server, list] of Object.entries(live)) {
      if (!list.length) continue
      const prev = known[server] || []
      const prevByName = new Map(prev.map((t) => [t.name, t] as const))
      const next = list.map((tool) => {
        const old = prevByName.get(tool.name)
        const description = tool.description || (old && old.description) || ''
        return description ? { name: tool.name, description } : { name: tool.name }
      }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const same = next.length === prev.length
        && next.every((t, i) => t.name === prev[i].name && (t.description || '') === (prev[i].description || ''))
      if (!same) changed = true
      known[server] = next
    }
    return changed
  }
  async function mcpmToolEnabled(args: any): Promise<any> {
    const serverName = String((args && args.serverName) || '').trim()
    const tool = String((args && args.tool) || '').trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 不合法' }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(tool)) return { ok: false, error: 'tool 名称不合法' }
    const enabled = (args && args.enabled) !== false
    const p = await deps.ensurePaths()
    return deps.withWriteLock(async () => {
      // Force re-read so an externally edited disabled-tools file is merged, not clobbered.
      const read = await readDisabledToolsResult(true)
      if (read.status === 'corrupt' || read.status === 'unreadable') {
        return {
          ok: false,
          code: 'mcp-disabled-unreadable',
          error: `MCP 停用表${read.status === 'corrupt' ? '损坏' : '不可读'}，已拒绝写入：${read.error}`,
        }
      }
      const map = cloneDisabledTools(read.status === 'ok' ? read.value : emptyDisabledTools())
      const disabled = new Set(map[serverName] || [])
      if (enabled) disabled.delete(tool)
      else disabled.add(tool)
      if (disabled.size) map[serverName] = [...disabled].sort()
      else delete map[serverName]
      try {
        await deps.writeJsonFile(deps.mcpSidecar(deps.MCP_DISABLED_TOOLS_FILE), map)
      } catch (e) {
        return { ok: false, error: '保存失败: ' + deps.message(e) }
      }
      setDisabledToolsCacheInternal(map)
      await applyToolRestrictions()
      return { ok: true, serverName, disabled: map[serverName] || [] }
    })
  }

  // Visibility seam: keep one active restriction per **agent scope**, refreshed whenever
  // the tool set / the disabled set / this agent's carrier set changes. Three facts decide
  // this design（都读过官方源码 dsh-tools 0.1.5-rc.2）：
  //   · `restrict()` **要求 scoped context** —— 插件级 ctx 调用必抛 "requires a scoped
  //     context"，这正是「停用工具从模型可见 schema 消失」这半边此前从未生效的原因（V1）；
  //   · 每次 layer 变化（restriction 就是一次 layer effect）官方都会 emit `tools/change`
  //     （`layers = new ScopedLayers(…, () => this.ctx.emit("tools/change"))`），而重放正挂在
  //     `tools/change` 上 —— 名单没变还重放就是自激；
  //   · 表要取自**不受限**的插件级视图：在 agent scope 里取 `schemas()`，第一次限制生效后
  //     表里就没有被停用的工具了，第二次重放会把它从 deny 名单里筛掉 —— 停用静默复活。
  // （2026-09-23：名单有三处来源，其中 `carrierHiddenTools` 逐 agent 不同，所以从"一份名单给
  //  所有 agent"改成逐 agent 各装一层 —— 见下面 restrictAgent / appliedByAgent 的注释。）
  let restrictTimer: ReturnType<typeof setTimeout> | null = null
  /** 已应用名单的键；相同即返回（防自激，也让每次 tools/change 变成一次廉价判等）。 */
  let appliedNamesKey: string | null = null
  /** 当前期望的**全局** deny 名单（agent 晚到 / 重放时用它，再叠加该 agent 自己那份）。 */
  let desiredNames: string[] = []
  /** agent → 撤掉这层限制的 disposer。 */
  const agentRestrictions = new Map<unknown, () => void>()
  /** agent → 已应用的**合并后**名单键（名单现在与 agent 有关，不能再只记一份全局的）。 */
  const appliedByAgent = new Map<unknown, string>()
  /** 见过的 agent（重放时逐个重新应用；disposed 时移除）。 */
  const seenAgents = new Set<unknown>()
  /**
   * 重放代数：`carrierHiddenTools` 是异步的，算名单期间可能又来了新的一轮重放（或 agent
   * 已经下线）。每次重放自增，回来时代数对不上就作废 —— 否则会用旧名单盖掉新的那一层。
   */
  let epoch = 0

  function scopedToolsOf(agent: any): { restrict?: (filter: { deny?: readonly string[] }) => unknown } | undefined {
    const scoped = agent && agent.ctx && agent.ctx.tools
    return scoped && typeof scoped === 'object' ? scoped : undefined
  }

  /** 撤掉某个 agent 上的限制（名单变了要重装：`restrict` 是叠加层，装新的不撤旧的会越叠越多）。 */
  function liftRestriction(agent: any): void {
    const release = agentRestrictions.get(agent)
    agentRestrictions.delete(agent)
    appliedByAgent.delete(agent)
    if (release) { try { release() } catch (e) { /* ignore */ } }
  }

  /** 把该 agent 该背的名单装到它 scope 上（全局那份 ∓ 会话覆盖 ∪ 它自己那份；空名单 = 不碰它）。 */
  async function restrictAgent(agent: any): Promise<void> {
    const mine = epoch
    let extra: string[] = []
    if (deps.carrierHiddenTools) {
      // 判据失败一律当"没有额外要藏的"：藏错了模型就少一条路，留着只是多花 token。
      try { extra = await deps.carrierHiddenTools(agent) } catch (e) { extra = [] }
    }
    // 会话层的两个方向（0.21.2）：`deny` 追加、`allow` 从全局名单里减掉 —— 允许**减**
    // 是关键：全局停用表（含场景引擎写的收窄）关着的工具，本会话显式拨开 / 场景勾着时
    // 要能重新看见，而全局一个字不动。名单已按注册全名算过（调用方用同一份 schemas），
    // 这里照样过一遍 registered 过滤 —— 认不出的名字官方 restrict 会直接抛。
    let allowSet = new Set<string>()
    if (deps.sessionMcpOverlay) {
      try {
        const ov = await deps.sessionMcpOverlay(agent)
        if (ov) {
          if (ov.deny !== undefined && ov.deny.length) extra = [...extra, ...ov.deny]
          if (ov.allow !== undefined && ov.allow.length) allowSet = new Set(ov.allow)
        }
      } catch { /* 取不到会话覆盖 = 按"没有额外要藏的"算（跟随全局） */ }
    }
    // 模型工具表也按对话走（0.21.2）：本对话的整份名单可能重新打开全局关掉的工具，
    // 也可能关掉全局开着的工具 —— 与 MCP 覆盖同一层 deny，不各装一层。
    if (deps.sessionToolTableOverlay) {
      try {
        const ov = await deps.sessionToolTableOverlay(agent)
        if (ov) {
          if (ov.deny !== undefined && ov.deny.length) extra = [...extra, ...ov.deny]
          if (ov.allow !== undefined && ov.allow.length) for (const name of ov.allow) allowSet.add(name)
        }
      } catch { /* 取不到 = 跟随全局 */ }
    }
    if (mine !== epoch) return
    if (!seenAgents.has(agent)) return
    // unknown 时 desiredNames 已经包含全部 mcp__*；会话 allow 不得把它们减掉
    // （本会话显式开着也不能越过“停用表读不出来”）。工具表的 allow 不受影响。
    const effectiveAllow = disabledToolsState() === 'unknown'
      ? new Set([...allowSet].filter((name) => !name.startsWith(MCP_TOOL_PREFIX)))
      : allowSet
    const names = [...new Set([...desiredNames.filter((name) => !effectiveAllow.has(name)), ...extra])]
    const scoped = scopedToolsOf(agent)
    if (!scoped || typeof scoped.restrict !== 'function') {
      if (names.length === 0) return
      // agent scope 上没有 tools 面（或它没有 restrict）：这半边做不成，如实说 ——
      // 静默跳过会让人以为"停用工具从模型工具表里消失"已经生效。
      noteRuntime({
        id: 'mcp-tool-visibility',
        label: '停用工具的可见性',
        kind: 'write',
        fallback: 'inform-only',
        detail: 'agent scope 上没有可用的 tools.restrict（官方接口变了或该 scope 未暴露 tools）：停用的 MCP 工具与兼容页关掉的本插件工具仍会出现在模型可见的工具表里，执行侧拦截仍然生效。',
        detailKey: 'mcp-tool-visibility.no-restrict',
      })
      return
    }
    const key = names.slice().sort().join('\u0000')
    if (appliedByAgent.get(agent) === key) return
    liftRestriction(agent)
    if (names.length === 0) { clearRuntimeNote('mcp-tool-visibility'); return }
    try {
      const dispose = scoped.restrict({ deny: names })
      agentRestrictions.set(agent, typeof dispose === 'function' ? dispose as () => void : () => {})
      appliedByAgent.set(agent, key)
      clearRuntimeNote('mcp-tool-visibility')
    } catch (e) {
      // 这个名字在这个 scope 里认不出 / scope 已经收了：可见性半边没生效。执行侧的 guard
      // 仍然拦住调用，所以功能不缺 —— 但必须如实上报，不能假装成功（此前正是静默吞掉）。
      noteRuntime({
        id: 'mcp-tool-visibility',
        label: '停用工具的可见性',
        kind: 'write',
        fallback: 'inform-only',
        detail: '有工具没能从模型可见的工具表里摘掉（' + deps.message(e) + '）：执行侧拦截仍然生效，模型仍能看到该工具的名字。',
        detailKey: 'mcp-tool-visibility.partial',
        params: { reason: deps.message(e) },
      })
    }
  }

  /** agent 上线（`agent/created` 或启动期的 agent 列表）：登记并立刻应用当前名单。 */
  function attachAgent(agent: any): void {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return
    seenAgents.add(agent)
    void restrictAgent(agent).catch(() => { /* 可见性半边 best effort */ })
  }

  /** agent 下线（`agent/disposed`）：先撤限制再销登记。 */
  function detachAgent(agent: any): void {
    seenAgents.delete(agent)
    liftRestriction(agent)
  }

  async function applyToolRestrictions(): Promise<void> {
    // 全局 tools 面上没有 restrict → 可见性半边整条做不成，如实上报（2026-09-30 审查 P2-8）。
    // 此前这里是**裸 return**：停用工具仍留在模型可见的工具表里，而兼容页因为没有上报仍报
    // 一行"ok"，用户看到的是"停用了但工具还在"。与 `restrictAgent` 里那条 noteRuntime 同文案、
    // 同 id（noteRuntime 按 id 覆盖，两处不会互相刷屏）。
    if (typeof deps.tools.restrict !== 'function') {
      noteRuntime({
        id: 'mcp-tool-visibility',
        label: '停用工具的可见性',
        kind: 'write',
        fallback: 'inform-only',
        detail: '全局 tools 服务上没有可用的 tools.restrict（官方接口变了）：停用的 MCP 工具与兼容页关掉的本插件工具仍会出现在模型可见的工具表里，执行侧拦截仍然生效。',
        detailKey: 'mcp-tool-visibility.no-restrict',
      })
      return
    }
    // Force re-read: this runs on the tools/change path, which is rare, so a
    // stale cache must not keep an externally edited deny list hidden.
    const read = await readDisabledToolsResult(true)
    const unknown = read.status === 'corrupt' || read.status === 'unreadable'
    const map = read.status === 'ok' ? read.value : emptyDisabledTools()
    let registered: Set<string>
    try {
      registered = new Set((await deps.tools.schemas()).map((schema) => String(schema.name)))
      // 枚举成功 = 上一轮「schemas 失败」已恢复；no-restrict 也在前面那道检查里确认过。
      // 逐 agent 的 partial 若仍成立，restrictAgent 会在下面重新上报。
      clearRuntimeNote('mcp-tool-visibility')
    } catch (e) {
      // 枚举不出工具表 = 这一轮摘不掉任何工具。执行侧 guard 仍拦得住，所以不是"能调"，
      // 但"停用了却还看得见"必须上报 —— 相邻分支都有，这里是唯一静默放弃的一处（审查 N3）。
      noteRuntime({
        id: 'mcp-tool-visibility',
        label: '停用工具的可见性',
        kind: 'write',
        fallback: 'inform-only',
        detail: '枚举宿主工具表失败（' + deps.message(e) + '）：停用的 MCP 工具与兼容页关掉的本插件工具仍可能留在模型可见的工具表里，执行侧拦截仍然生效。',
        detailKey: 'mcp-tool-visibility.schemas-failed',
        params: { reason: deps.message(e) },
      })
      return
    }
    // unknown 时把所有已注册的 mcp__* 都放进 deny；missing / ok 按表算。
    const wanted = unknown
      ? [...registered].filter((name) => name.startsWith(MCP_TOOL_PREFIX))
      : disabledToolNames(map)
    if (!unknown) {
      // 通配 `*`（整服务器停用）先展开成已注册的全名，再与精确名单合并。
      for (const [serverName, list] of Object.entries(map)) {
        if (list.indexOf('*') < 0) continue
        const prefix = MCP_TOOL_PREFIX + serverName + '__'
        for (const fullName of registered) if (fullName.startsWith(prefix)) wanted.push(fullName)
      }
    }
    // 兼容页「模型工具表」关掉的本插件工具并进同一份名单（理由见 deps.pluginHiddenTools）。
    // 交给上面那个 `registered` 过滤是**必要的**而不是保险：官方对认不出的名字直接抛错，
    // 而关掉的工具里可能有一个这次根本没注册成功（注册失败会被子智能体页的黄条报出来）。
    if (deps.pluginHiddenTools) {
      try { for (const name of deps.pluginHiddenTools()) wanted.push(name) } catch (e) { /* 读设置失败 = 这次不摘它们 */ }
    }
    const names = [...new Set(wanted)].filter((name) => registered.has(name))
    const key = names.join('\u0000')
    // 有 `carrierHiddenTools` 时不拿全局键短路：那份名单与"官方工具此时挂没挂"有关，
    // 而它变了不会改全局键（官方挂载/卸载本身就发 tools/change，正是靠这条通路追上）。
    // 代价是每次 tools/change 都重算一遍 —— 逐 agent 的键判等会把绝大多数挡在装层之前，
    // 事实读取也有 TTL 缓存；装层本身会再发一次 tools/change，那一轮键相同即收敛，不自激。
    // 有逐 agent 的名单来源时不拿全局键短路：那份名单与会话覆盖 / 官方挂载状态有关，
    // 它们变了不会改全局键。逐 agent 的键判等会把绝大多数挡在装层之前。
    if (key === appliedNamesKey && deps.carrierHiddenTools === undefined && deps.sessionMcpOverlay === undefined && deps.sessionToolTableOverlay === undefined) return
    appliedNamesKey = key
    desiredNames = names
    // **绝不无条件 lift**（0.21.2 自激振荡根因）：`liftRestriction` 会把 `appliedByAgent` 的键
    // 一并删掉，下一轮 `restrictAgent` 的逐 agent 键判等必然失配 → 拆了又装 → 装层又是一次
    // layer 变化 → 官方再 emit `tools/change` → 去抖后再来一轮 → 无限循环（界面表现为对话里
    // 反复播报「工具已更新 · 新增/移除 N 个」）。
    //
    // 名单变化（含变短、含逐 agent 那份）时的重装由 `restrictAgent` 自己的「键不同 → lift →
    // 装新（或空名单即只 lift）」覆盖，不需要这里先拆一遍。这里只清理**已不在 seenAgents**
    // 的 agent 的残留层（兜底；正常下线走 detachAgent）。
    //
    // 收敛：真实变化 → 一轮拆+装 → 装层发 tools/change → 下一轮重算，逐 agent 键相等 →
    // 空转、零事件 → 稳态。
    epoch += 1
    for (const agent of [...agentRestrictions.keys()]) if (!seenAgents.has(agent)) liftRestriction(agent)
    for (const agent of seenAgents) void restrictAgent(agent).catch(() => { /* best effort */ })
  }
  function scheduleToolRestrictions(): void {
    if (restrictTimer) return
    restrictTimer = setTimeout(() => {
      restrictTimer = null
      applyToolRestrictions().catch(() => { /* best effort */ })
    }, 300)
  }
  /** 卸载清理：清掉重排定时器、把挂在每个 agent scope 上的限制都撤掉（母文件 dispose 的那六行原样搬来）。 */
  function disposeVisibility(): void {
    if (restrictTimer) { clearTimeout(restrictTimer); restrictTimer = null }
    // 插件卸载时把挂在每个 agent scope 上的限制都撤掉（否则那些 scope 会继续背着一层名单）。
    epoch += 1
    for (const agent of [...agentRestrictions.keys()]) liftRestriction(agent)
    appliedByAgent.clear()
    seenAgents.clear()
  }

  return {
    readDisabledTools,
    readDisabledToolsResult,
    disabledToolsState,
    disabledToolsIssue,
    disabledToolsForensicPath: () => (forensicCopy && forensicCopy.path ? forensicCopy.path : null),
    ensureDisabledToolsForensics,
    resetDisabledTools,
    readKnownMcpTools,
    writeKnownMcpTools,
    mutateKnownMcpTools,
    mergeLiveToolsInto,
    mcpmToolEnabled,
    attachAgent,
    detachAgent,
    applyToolRestrictions,
    scheduleToolRestrictions,
    setDisabledToolsCache: setDisabledToolsCacheInternal,
    disabledToolsSnapshot: () => (disabledToolsCache ? disabledToolsCache.value : emptyDisabledTools()),
    disposeVisibility,
  }
}
