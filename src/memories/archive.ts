// src/memories/archive.ts —— 场景档案数据模型与模式切换纯逻辑（无 I/O；I/O 由 archive-engine 注入）。
// 勾选集语义（设计 §2.1）：段内存储「勾选的启用集合」；应用时该域置为与勾选集完全一致；
// 段未定义 = 该域不碰；段已定义但全不勾 = 合法（全部停用）。清单只对"实时发现"的条目生效。
// v2：MCP 段为两级——服务器勾选（mcp 键存在）+ 可选工具明细（'*' = 整台，string[] = 指定工具）。

export interface SceneArchive {
  mcp?: Record<string, '*' | string[]>   // serverName → '*' 整台 | 工具名清单；键存在 = 段已定义
  /**
   * 场景级 MCP 服务器备注：serverName → 备注文本。
   * 进入该场景时**覆盖**全局备注（写 notes.json），退出场景时恢复改动前的备注。
   * 键存在即段已定义（可为空对象 = 清除该场景的全部备注覆盖）。
   */
  mcpNotes?: Record<string, string>
  skills?: string[]                      // 勾选的技能选集，key = `<rootKey>/<name>`
  subagents?: string[]                   // 绑定的人设名清单
  /**
   * v3：勾选的记忆（id = `<场景>/<名>`）。
   * 勾选集语义与其余段一致：段已定义 → 未勾的记忆在该场景下**不注入**系统提示词；
   * 段未定义 → 该场景全部记忆照常注入（向后兼容：老档案没有这一段）。
   * 记忆文件不会被删改，只影响投影（真实数据零风险）。
   */
  memories?: string[]
}

/**
 * 进入模式前的运行时快照，用于退出时精确回滚。
 *
 * ⚠️ 老 `memories-index.json` 里的 snapshot 缺下面各选填栏，读取处必须容忍缺失
 * （`?? []` / `?? {}`）；`mcpServers` / `skillSources` 在旧快照里还只记了「被档案
 * 改动过的行」，新快照记**每一行**（见两栏各自的说明）。
 */
export interface ModeSnapshot {
  mcp: Record<string, string[]>
  skills: Record<string, boolean>
  /**
   * **每一行**服务器级启停的进场景前 `disabled`（全量，v0.9.5 起）。
   *
   * 为什么从「只记被档案改动过的行」升级成全量：场景期间用户能在页面上改开关（未锁定时
   * 可用，改动同步进档案），只记进场景时那几行的话，用户自己改的行没有原值可回。
   * 退出只回写与现状不同的行（见 archive-engine 的 mcpServerRowsToRestore）——
   * 状态本来就一致的行一个都不碰。
   */
  mcpServers?: Array<{ id: string; level: string; disabled: boolean }>
  /**
   * **每一行**技能来源级启停的进场景前 `enabled`（全量，同上）。
   *
   * 漏记一行比 MCP 那侧更严重：来源关着时技能级的 enable 会被 core 直接吞掉
   * （`skills/core.js` 的 sourceEnabled 判定），于是「A 目录」和它下面的技能一并不回 ——
   * 用户报的「场景里关掉 A 目录，退出后 A 与其下技能都没开回来」就是漏了这一行。
   */
  skillSources?: Array<{ root: string; enabled: boolean }>
  /**
   * 子智能体开关（v0.8）：进入模式时档案勾选的人设被**自动启用**，这里记的是
   * 其中「改动前处于停用状态」的名字 —— 退出时按名单停回，不动用户手动开关过的其他行。
   */
  subagents?: string[]
  /**
   * 进入模式时被档案**关掉**的人设（改动前是开着的）—— 退出时按名单重新打开。
   *
   * 与上面的 `subagents` 合起来才是完整还原：人设域按「置为与勾选集完全一致」应用
   * （未勾选 = 关闭，含整段未定义 = 一个都没勾），两个方向都要记。老 snapshot
   * 没有这一栏 → 读取处一律 `?? []`（按旧行为只恢复被启用的那批）。
   */
  subagentsOn?: string[]
  /**
   * 人设开关的**全量**映射（名字 → 进入模式时的开关状态），v0.9.1 起写入。
   *
   * 为什么要从「两个方向的部分名单」升级成全量映射：场景内页面开关已开放（未锁定即
   * 可改，改动同步进档案），于是「某个人设现在开着」不再只来自档案勾选 —— 部分名单
   * 答不出「这个人是场景开的，还是用户自己开的」。全量映射没有这个问题：退出时把
   * **表里记过的名字**逐个还原（场景中新建的人设不在表里 → 不动它，与技能域同口径）。
   *
   * 老 snapshot 没有这一栏 → 退回 `subagents` / `subagentsOn` 两个名单（旧行为）。
   */
  subagentsAll?: Record<string, boolean>
  /**
   * 档案改过**备注**的服务器行，记录**改动前**的备注（`null` = 原本没有备注）。
   * 退出时按此恢复；只记被改动的行。
   */
  mcpNotes?: Array<{ id: string; note: string | null }>
}
export interface ModeState { scene: string | null; snapshot: ModeSnapshot | null }

/** 一台服务器的**服务器级**启停现状（`disabled` 来自补丁文件）。 */
export interface McpServerState {
  /** loader entry id —— 改补丁按它定位。 */
  id: string
  /** 展示名；工具名 `mcp__<serverName>__<tool>` 用的就是它。 */
  serverName: string
  /** 补丁所在层级（profile / global）。 */
  level: string
  disabled: boolean
}

export interface McpPlan {
  /** 每台服务器的精确停用名单（[] = 全部启用；['*'] = 整台停用）。 */
  entries: Record<string, string[]>
  /** 整台停用的服务器（entries[server] === ['*']）。 */
  wildcards: string[]
  stale: string[]
  /**
   * 需要改**服务器级**启停的行：勾选的 → 启用（含把进程拉起来）；未勾的 → 停用（含杀进程）。
   * **只含「当前状态 ≠ 目标」的行** —— 不动没必要的行，避免无谓改写补丁文件。
   *
   * 为什么必须做服务器级：工具级停用只在「服务器已经加载」时才有意义。服务器没起来，
   * 它的工具根本不存在，勾选与否毫无区别 —— 这正是用户报的「勾了没开」。
   */
  serverSwitches: Array<{
    id: string
    serverName: string
    level: string
    /** 目标状态。 */
    enabled: boolean
    /** **改动前**的服务器级停用状态 —— 退出模式时按它恢复。 */
    disabledBefore: boolean
  }>
}

export function normalizeStringList(raw: unknown): string[] {
  if (typeof raw === 'string') raw = raw.split(/[,，]/)
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))]
}

/**
 * MCP 规范化：serverName → '*' 或工具名清单；非法形态丢弃。
 * 空清单是**合法值**（勾了服务器但一个工具都不勾 = 该服务器全部停用），必须保留——
 * 否则「段已定义但全不勾 = 全部停用」（设计 §2.1）无法持久化。
 */
export function normalizeMcpSpec(raw: unknown): Record<string, '*' | string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, '*' | string[]> = {}
  for (const [serverRaw, v] of Object.entries(raw as Record<string, unknown>)) {
    const server = serverRaw.trim()
    if (!server) continue
    if (v === '*' || (typeof v === 'string' && v.trim() === '*')) { out[server] = '*'; continue }
    if (typeof v !== 'string' && !Array.isArray(v)) continue   // 畸形形态（null/数字/对象）丢弃
    out[server] = normalizeStringList(v)
  }
  return out
}

/**
 * MCP 场景备注规范化：serverName → 非空备注文本；空值/畸形形态丢弃。
 * 空对象返回 `{}`（段已定义但无覆盖 = 合法，键存在即段已定义）。
 */
export function normalizeMcpNotes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [serverRaw, v] of Object.entries(raw as Record<string, unknown>)) {
    const server = serverRaw.trim()
    const note = String(v ?? '').trim()
    if (!server || !note) continue
    out[server] = note
  }
  return out
}

/** 'mcp'/'skills'/'subagents'/'memories' 键存在且值非 null 才视为"段已定义"——存在性独立于集合空否（null/缺失 = 未定义）。 */
export function normalizeArchive(raw: unknown): SceneArchive {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: SceneArchive = {}
  if (obj.mcp != null) { const mcp = normalizeMcpSpec(obj.mcp); if (mcp) out.mcp = mcp }
  if (obj.mcpNotes != null) out.mcpNotes = normalizeMcpNotes(obj.mcpNotes)
  if (obj.skills != null) out.skills = normalizeStringList(obj.skills)
  if (obj.subagents != null) out.subagents = normalizeStringList(obj.subagents)
  if (obj.memories != null) out.memories = normalizeStringList(obj.memories)
  return out
}

export function hasSection(archive: SceneArchive, section: 'mcp' | 'skills' | 'subagents' | 'memories' | 'mcpNotes'): boolean {
  return archive[section] !== undefined
}

export interface McpPlanInput {
  /** 配置中真实存在的服务器名全集（含未运行的）。 */
  configuredServers: string[]
  /** 每台服务器"已知"的工具名（live schemas ∪ 启停表历史键）；未运行的服务器可能为空。 */
  knownTools: Record<string, string[]>
  /**
   * 各服务器的**服务器级**启停现状。传了才会产出 `serverSwitches`（服务器级双向切换）；
   * 不传 = 只做工具级（保持旧行为，便于单测与降级路径）。
   */
  serverStates?: McpServerState[]
}

/**
 * MCP 段应用计划：段已定义 → 对并集里每台服务器产出**精确停用名单（勾选集的补集）**。
 *   服务器未勾（键缺失）→ ['*'] 整台停用（guard/restrict 原生支持通配，服务器后加载也会被拦）；
 *   服务器勾 '*'      → [] 全启用；
 *   服务器勾清单      → known − 勾选（未运行且无已知工具名的服务器无法枚举补集：不做停用，
 *                       上报 `mcp/<server>/*` 让用户知道未勾项这次没生效）；
 *   段内服务器若配置里根本不存在 → stale 上报且不写。
 */
export function computeMcpPlan(mcp: Record<string, '*' | string[]>, input: McpPlanInput): McpPlan {
  const configured = new Set(input.configuredServers)
  const servers = new Set<string>([...configured, ...Object.keys(input.knownTools), ...Object.keys(mcp)])
  const entries: Record<string, string[]> = {}
  const wildcards: string[] = []
  const stale: string[] = []
  for (const server of servers) {
    if (!configured.has(server)) { if (mcp[server] !== undefined) stale.push('mcp/' + server); continue }
    const spec = mcp[server]
    if (spec === undefined) { entries[server] = ['*']; wildcards.push(server); continue }
    if (spec === '*') { entries[server] = []; continue }
    const known = input.knownTools[server] || []
    if (!known.length) { entries[server] = []; stale.push('mcp/' + server + '/*'); continue }
    const checked = new Set(spec)
    entries[server] = known.filter((t) => !checked.has(t))
    for (const t of spec) if (known.indexOf(t) < 0) stale.push('mcp/' + server + '/' + t)
  }

  // 服务器级双向切换：勾选集 = 该场景下的**服务器启停配置**。
  // 勾了 → 启用；没勾 → 停用。只推入状态需要变化的行。
  const serverSwitches: McpPlan['serverSwitches'] = []
  for (const state of input.serverStates || []) {
    if (!configured.has(state.serverName)) continue
    const enabled = mcp[state.serverName] !== undefined
    if (state.disabled === !enabled) continue   // 已经是目标状态
    serverSwitches.push({ id: state.id, serverName: state.serverName, level: state.level, enabled, disabledBefore: state.disabled })
  }
  return { entries, wildcards, stale, serverSwitches }
}

/** 一个技能来源（root）的启停现状。 */
export interface SkillSourceState { root: string; enabled: boolean }

export interface SkillsPlan {
  target: Record<string, boolean>
  stale: string[]
  /**
   * 需要改**来源级**启停的 root：该来源下有勾选的技能 → 启用；一条都没勾 → 停用。
   * 只含状态需要变化的 root。
   *
   * 为什么必须做来源级：来源关闭时，技能级的 enable 会被直接吞掉（`skills/core.js` 的
   * `sourceEnabled` 判定），勾选写进去了也不生效 —— 这正是用户报的「勾了没开」。
   */
  sourceSwitches: Array<{
    root: string
    /** 目标状态。 */
    enabled: boolean
    /** **改动前**的来源启停状态 —— 退出模式时按它恢复。 */
    enabledBefore: boolean
  }>
}

/**
 * 技能段应用计划：已知技能全集 → 勾选集决定启停。
 *
 * `sourceStates` 传了才会产出 `sourceSwitches`（来源级双向切换）；不传 = 只做技能级。
 */
export function computeSkillsPlan(
  skills: string[],
  knownSkillKeys: Set<string>,
  sourceStates?: SkillSourceState[],
): SkillsPlan {
  const target: Record<string, boolean> = {}
  for (const key of knownSkillKeys) target[key] = skills.indexOf(key) >= 0
  const stale = skills.filter((k) => !knownSkillKeys.has(k)).map((k) => 'skills/' + k)

  const sourceSwitches: SkillsPlan['sourceSwitches'] = []
  if (sourceStates) {
    // 该来源下有没有被勾选的技能（只看已知技能，避免 stale 项把来源"点亮"）。
    const checked = new Set(skills)
    const onRoots = new Set<string>()
    for (const key of knownSkillKeys) {
      if (!checked.has(key)) continue
      const i = key.indexOf('/')
      if (i > 0) onRoots.add(key.slice(0, i))
    }
    for (const state of sourceStates) {
      const enabled = onRoots.has(state.root)
      if (state.enabled === enabled) continue
      sourceSwitches.push({ root: state.root, enabled, enabledBefore: state.enabled })
    }
  }
  return { target, stale, sourceSwitches }
}

/**
 * 把「这次要改的上层行」并进快照 —— **已记录的行保持原值**（先记的才是进场景前的状态）。
 *
 * 为什么需要：新快照已是**全量**（进入时就记了每一行），这里是兜底 —— 旧快照只记了
 * 当时将要改动的行，而模式进行中用户改档案（改档案 = 立即生效）又可能新改到别的行；
 * 退出必须回到「进场景前」，所以这些新改的行也得有记录。
 * 反之，若某行在进入时就记过，它的 `*Before` 才是进场景前的值 —— 这次的中间态值必须丢弃。
 */
export function mergeSnapshotSwitches(
  snapshot: ModeSnapshot,
  mcpServers: Array<{ id: string; level: string; disabledBefore: boolean }> = [],
  skillSources: Array<{ root: string; enabledBefore: boolean }> = [],
): ModeSnapshot {
  const servers = (snapshot.mcpServers ?? []).map((x) => ({ ...x }))
  const seenServer = new Set(servers.map((x) => x.id + '\u0000' + x.level))
  for (const s of mcpServers) {
    const key = s.id + '\u0000' + s.level
    if (seenServer.has(key)) continue
    seenServer.add(key)
    servers.push({ id: s.id, level: s.level, disabled: s.disabledBefore })
  }
  const sources = (snapshot.skillSources ?? []).map((x) => ({ ...x }))
  const seenSource = new Set(sources.map((x) => x.root))
  for (const s of skillSources) {
    if (seenSource.has(s.root)) continue
    seenSource.add(s.root)
    sources.push({ root: s.root, enabled: s.enabledBefore })
  }
  return {
    ...snapshot,
    ...(servers.length ? { mcpServers: servers } : {}),
    ...(sources.length ? { skillSources: sources } : {}),
  }
}

export function snapshotRuntime(
  mcpRaw: Record<string, string[]>,
  skills: Record<string, boolean>,
  /** 上层两行：进场景前**每一行**的原值（全量；退出按「现状 ≠ 原值」回写）。 */
  mcpServers: Array<{ id: string; level: string; disabled: boolean }> = [],
  skillSources: Array<{ root: string; enabled: boolean }> = [],
  /** **将被档案启用**的人设名（改动前停用的子集；退出时按此停回）。 */
  subagents: string[] = [],
  /** **将被档案停用**的人设名（改动前启用的子集；退出时按此重新打开）。 */
  subagentsOn: string[] = [],
  /** **将被档案改动**的备注行，带改动前的备注（null = 原本没有）。 */
  mcpNotes: Array<{ id: string; note: string | null }> = [],
  /**
   * 进入模式时**全部**人设的开关状态（名字 → 是否开着）。给了就写进 `subagentsAll`：
   * 退出时按它精确还原（场景里手动开过的人设也会被还原回进场景前的状态）。
   */
  subagentStates: Record<string, boolean> | null = null,
): ModeSnapshot {
  return {
    mcp: Object.fromEntries(Object.entries(mcpRaw).map(([k, v]) => [k, v.slice()])),
    skills: { ...skills },
    mcpServers: mcpServers.map((x) => ({ id: x.id, level: x.level, disabled: x.disabled })),
    skillSources: skillSources.map((x) => ({ root: x.root, enabled: x.enabled })),
    ...(subagents.length ? { subagents: subagents.slice() } : {}),
    ...(subagentsOn.length ? { subagentsOn: subagentsOn.slice() } : {}),
    ...(subagentStates ? { subagentsAll: { ...subagentStates } } : {}),
    ...(mcpNotes.length ? { mcpNotes: mcpNotes.map((x) => ({ id: x.id, note: x.note })) } : {}),
  }
}

// ── 记忆勾选（v3）──────────────────────────────────────────────────────────
//
// 记忆段与其余三段有一处关键差别：MCP / 技能是**运行时启停**（改了要落表、进/退模式要回滚），
// 记忆只是**投影**（正文进 system prompt）。所以记忆段不产生"应用计划"、不进模式快照，
// 而是在渲染时被查询——勾选后下一个请求即生效，退出模式无需回滚任何东西。

// P5（2026-09-15）已删除 `memoryAllowed` 与 `computeMemoriesPlan`：
// 记忆的注入条件改为**单一真相源** `rules[*].enabled`，场景档案不再持有 `memories` 段。
// 原因是「两个开关串联 + 两步操作」——用户必须先建段、再逐条勾，而且记忆页与档案页
// 各显示一半状态，看起来永远对不上。现在档案弹窗里的记忆勾选直接读写 `enabled`，
// 与记忆页同一个写入口，天然一致。
//
// 老档案兼容：`archives[*].memories` 字段被**忽略**，不做自动迁移。影响可控 ——
// 段内记忆的 `enabled` 通常本就是 true，忽略后行为不变。
