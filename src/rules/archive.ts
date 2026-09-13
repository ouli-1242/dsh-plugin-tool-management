// src/rules/archive.ts —— 场景档案数据模型与模式切换纯逻辑（无 I/O；I/O 由 archive-engine 注入）。
// 勾选集语义（设计 §2.1）：段内存储「勾选的启用集合」；应用时该域置为与勾选集完全一致；
// 段未定义 = 该域不碰；段已定义但全不勾 = 合法（全部停用）。清单只对"实时发现"的条目生效。
// v2：MCP 段为两级——服务器勾选（mcp 键存在）+ 可选工具明细（'*' = 整台，string[] = 指定工具）。

export interface SceneArchive {
  mcp?: Record<string, '*' | string[]>   // serverName → '*' 整台 | 工具名清单；键存在 = 段已定义
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

export interface ModeSnapshot { mcp: Record<string, string[]>; skills: Record<string, boolean> }
export interface ModeState { scene: string | null; snapshot: ModeSnapshot | null }

export interface McpPlan {
  /** 每台服务器的精确停用名单（[] = 全部启用；['*'] = 整台停用）。 */
  entries: Record<string, string[]>
  /** 整台停用的服务器（entries[server] === ['*']）。 */
  wildcards: string[]
  stale: string[]
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

/** 'mcp'/'skills'/'subagents'/'memories' 键存在且值非 null 才视为"段已定义"——存在性独立于集合空否（null/缺失 = 未定义）。 */
export function normalizeArchive(raw: unknown): SceneArchive {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: SceneArchive = {}
  if (obj.mcp != null) { const mcp = normalizeMcpSpec(obj.mcp); if (mcp) out.mcp = mcp }
  if (obj.skills != null) out.skills = normalizeStringList(obj.skills)
  if (obj.subagents != null) out.subagents = normalizeStringList(obj.subagents)
  if (obj.memories != null) out.memories = normalizeStringList(obj.memories)
  return out
}

export function hasSection(archive: SceneArchive, section: 'mcp' | 'skills' | 'subagents' | 'memories'): boolean {
  return archive[section] !== undefined
}

export interface McpPlanInput {
  /** 配置中真实存在的服务器名全集（含未运行的）。 */
  configuredServers: string[]
  /** 每台服务器"已知"的工具名（live schemas ∪ 启停表历史键）；未运行的服务器可能为空。 */
  knownTools: Record<string, string[]>
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
  return { entries, wildcards, stale }
}

/** 技能段应用计划：已知技能全集 → 勾选集决定启停。 */
export function computeSkillsPlan(skills: string[], knownSkillKeys: Set<string>): { target: Record<string, boolean>; stale: string[] } {
  const target: Record<string, boolean> = {}
  for (const key of knownSkillKeys) target[key] = skills.indexOf(key) >= 0
  const stale = skills.filter((k) => !knownSkillKeys.has(k)).map((k) => 'skills/' + k)
  return { target, stale }
}

export function snapshotRuntime(mcpRaw: Record<string, string[]>, skills: Record<string, boolean>): ModeSnapshot {
  return {
    mcp: Object.fromEntries(Object.entries(mcpRaw).map(([k, v]) => [k, v.slice()])),
    skills: { ...skills },
  }
}

// ── 记忆勾选（v3）──────────────────────────────────────────────────────────
//
// 记忆段与其余三段有一处关键差别：MCP / 技能是**运行时启停**（改了要落表、进/退模式要回滚），
// 记忆只是**投影**（正文进 system prompt）。所以记忆段不产生"应用计划"、不进模式快照，
// 而是在渲染时被查询——勾选后下一个请求即生效，退出模式无需回滚任何东西。

/**
 * 记忆是否应当注入（纯函数，供渲染路径同步调用）。
 *
 * 口径与其余段同构：
 *   - 该记忆所属场景**没有** memories 段 → 全部记忆照常注入（老档案 = 未定义 = 不碰）；
 *   - 有段 → 只有列在段里的记忆注入（段已定义但空 = 该场景记忆全部不注入）。
 *
 * 入参 `sceneEnabled` 是索引里的单条启停（`enabled === false` 的条目在上游已被过滤，
 * 这里只为把两种"不注入"的原因分开，便于体检报告区分）。
 */
export function memoryAllowed(
  archives: Record<string, SceneArchive> | undefined,
  scene: string,
  id: string,
): boolean {
  const archive = archives ? archives[scene] : undefined
  if (!archive || archive.memories === undefined) return true
  return archive.memories.indexOf(id) >= 0
}

/**
 * 记忆段的 stale 上报（档案保存时调用）：段里引用了已经不存在的记忆 id。
 * 记忆段不写任何运行时状态，因此除 stale 外没有别的计划产物。
 */
export function computeMemoriesPlan(memories: string[], knownMemoryIds: Set<string>): { stale: string[] } {
  return { stale: memories.filter((id) => !knownMemoryIds.has(id)).map((id) => 'memories/' + id) }
}
