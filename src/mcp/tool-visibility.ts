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
import { MCP_TOOL_PREFIX } from '../host-names.js'
import { clearRuntimeNote, noteRuntime } from '../compat/runtime-notes.js'
import type { KnownMcpTool, ToolsService } from './manager.js'

export interface ToolVisibilityDeps {
  /** 通用侧车 JSON 读写（与母文件同一套）。 */
  readJsonFile(abs: string): Promise<any>
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
}

export interface ToolVisibility {
  readDisabledTools(force?: boolean): Promise<Record<string, string[]>>
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
  let disabledToolsCache: { at: number; value: Record<string, string[]> } | null = null
  async function readDisabledTools(force = false): Promise<Record<string, string[]>> {
    if (disabledToolsCache && !force && Date.now() - disabledToolsCache.at < deps.SIDECAR_TTL_MS) return disabledToolsCache.value
    const p = await deps.ensurePaths()
    const raw = await deps.readJsonFile(deps.mcpSidecar(deps.MCP_DISABLED_TOOLS_FILE))
    const out: Record<string, string[]> = {}
    if (raw && typeof raw === 'object') {
      for (const serverName of Object.keys(raw)) {
        const list = (raw as Record<string, unknown>)[serverName]
        if (Array.isArray(list)) {
          // `*` 必须原样保留：它是「整台服务器停用」的通配（场景档案未勾选的服务器写的就是它），
          // 被这里过滤掉的话 guard / restrict / 快照三条链路一起失效——整台停用变成空转。
          const names = list.map((name) => String(name)).filter((name) => name === '*' || /^[A-Za-z0-9_-]{1,128}$/.test(name))
          if (names.length) out[serverName] = names
        }
      }
    }
    disabledToolsCache = { at: Date.now(), value: out }
    return out
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
    const p = await deps.ensurePaths()
    const raw = await deps.readJsonFile(deps.mcpSidecar(deps.MCP_KNOWN_TOOLS_FILE))
    const out: Record<string, KnownMcpTool[]> = {}
    if (raw && typeof raw === 'object') {
      for (const serverName of Object.keys(raw)) {
        const list = deps.normalizeKnownTools((raw as Record<string, unknown>)[serverName])
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
   * 抽出来是为了让"要不要写盘"的判断与"锁内真正合并"用**同一个**函数：调用方先在锁外
   * 对本地缓存跑一遍拿到 `changed`（决定要不要进锁），进锁后再对新鲜表跑一遍（那次的结果
   * 才决定落盘）—— 两边口径不一致的话，要么白写要么漏写。
   */
  function mergeLiveToolsInto(known: Record<string, KnownMcpTool[]>, live: Record<string, KnownMcpTool[]>): boolean {
    let changed = false
    for (const [server, list] of Object.entries(live)) {
      const prev = known[server] || []
      const byName = new Map(prev.map((t) => [t.name, t] as const))
      for (const tool of list) {
        const old = byName.get(tool.name)
        if (!old) { byName.set(tool.name, tool); changed = true; continue }
        if (tool.description && old.description !== tool.description) {
          byName.set(tool.name, { ...old, description: tool.description })
          changed = true
        }
      }
      const next = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      if (next.length !== prev.length) changed = true
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
      const map = Object.assign({}, await readDisabledTools(true))
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
      disabledToolsCache = { at: Date.now(), value: map }
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

  /** 把该 agent 该背的名单装到它 scope 上（全局那份 ∪ 它自己那份；空名单 = 不碰它）。 */
  async function restrictAgent(agent: any): Promise<void> {
    const mine = epoch
    let extra: string[] = []
    if (deps.carrierHiddenTools) {
      // 判据失败一律当"没有额外要藏的"：藏错了模型就少一条路，留着只是多花 token。
      try { extra = await deps.carrierHiddenTools(agent) } catch (e) { extra = [] }
    }
    if (mine !== epoch) return
    if (!seenAgents.has(agent)) return
    const names = [...new Set([...desiredNames, ...extra])]
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
    const map = await readDisabledTools(true)
    // 通配 `*`（整服务器停用）先展开成已注册的全名，再与精确名单合并。
    const wanted = disabledToolNames(map)
    let registered: Set<string>
    try {
      registered = new Set((await deps.tools.schemas()).map((schema) => String(schema.name)))
    } catch (e) { return }
    for (const [serverName, list] of Object.entries(map)) {
      if (list.indexOf('*') < 0) continue
      const prefix = MCP_TOOL_PREFIX + serverName + '__'
      for (const fullName of registered) if (fullName.startsWith(prefix)) wanted.push(fullName)
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
    if (key === appliedNamesKey && deps.carrierHiddenTools === undefined) return
    appliedNamesKey = key
    desiredNames = names
    // 每次重放先撤掉每个 agent 上的旧层：名单变短（重新启用某个工具）时，只有撤掉这层限制
    // 它才会重新可见；名单变了（含逐 agent 那份）也必须重装而不是叠加。
    epoch += 1
    for (const agent of [...agentRestrictions.keys()]) liftRestriction(agent)
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
    readKnownMcpTools,
    writeKnownMcpTools,
    mutateKnownMcpTools,
    mergeLiveToolsInto,
    mcpmToolEnabled,
    attachAgent,
    detachAgent,
    applyToolRestrictions,
    scheduleToolRestrictions,
    setDisabledToolsCache: (value: Record<string, string[]>) => { disabledToolsCache = { at: Date.now(), value } },
    disabledToolsSnapshot: () => (disabledToolsCache ? disabledToolsCache.value : {}),
    disposeVisibility,
  }
}
