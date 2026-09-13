// src/rules/archive.ts —— 场景档案数据模型与模式切换纯逻辑（无 I/O；I/O 由 archive-engine 注入）。
// 勾选集语义（设计 §2.1）：段内存储「勾选的启用集合」；应用时该域置为与勾选集完全一致；
// 段未定义 = 该域不碰；段已定义但全不勾 = 合法（全部停用）。清单只对"实时发现"的条目生效。
// v2：MCP 段为两级——服务器勾选（mcp 键存在）+ 可选工具明细（'*' = 整台，string[] = 指定工具）。

export interface SceneArchive {
  mcp?: Record<string, '*' | string[]>   // serverName → '*' 整台 | 工具名清单；键存在 = 段已定义
  skills?: string[]                      // 勾选的技能选集，key = `<rootKey>/<name>`
  subagents?: string[]                   // 绑定的人设名清单
}

export interface ModeSnapshot { mcp: Record<string, string[]>; skills: Record<string, boolean> }
export interface ModeState { scene: string | null; snapshot: ModeSnapshot | null }

export interface McpPlan {
  /** 每台服务器的精确停用名单（[] = 全部启用）；wildcards 里的服务器写 ['*']。 */
  entries: Record<string, string[]>
  wildcards: string[]
  stale: string[]
}

export function normalizeStringList(raw: unknown): string[] {
  if (typeof raw === 'string') raw = raw.split(/[,，]/)
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))]
}

/** MCP 规范化：serverName → '*' 或工具名清单；非法形态丢弃。 */
export function normalizeMcpSpec(raw: unknown): Record<string, '*' | string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, '*' | string[]> = {}
  for (const [serverRaw, v] of Object.entries(raw as Record<string, unknown>)) {
    const server = serverRaw.trim()
    if (!server) continue
    if (v === '*' || (typeof v === 'string' && v.trim() === '*')) { out[server] = '*'; continue }
    const list = normalizeStringList(v)
    if (list.length) out[server] = list
  }
  return out
}

/** 'mcp'/'skills'/'subagents' 键存在才归一——存在性独立于集合空否。 */
export function normalizeArchive(raw: unknown): SceneArchive {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: SceneArchive = {}
  if ('mcp' in obj) { const mcp = normalizeMcpSpec(obj.mcp); if (mcp) out.mcp = mcp }
  if ('skills' in obj) out.skills = normalizeStringList(obj.skills)
  if ('subagents' in obj) out.subagents = normalizeStringList(obj.subagents)
  return out
}

export function hasSection(archive: SceneArchive, section: 'mcp' | 'skills' | 'subagents'): boolean {
  return archive[section] !== undefined
}

export interface McpPlanInput {
  /** 配置中真实存在的服务器名全集（含未运行的）。 */
  configuredServers: string[]
  /** 每台服务器"已知"的工具名（live schemas ∪ 启停表历史键）；未运行的服务器可能为空。 */
  knownTools: Record<string, string[]>
}

/**
 * MCP 段应用计划：段已定义 → 对并集里每台服务器产出精确停用名单；
 * '*' 整台 → 写 ['*']（guard/restrict 原生支持通配，服务器后加载也会被拦）；
 * 段内服务器若配置里根本不存在 → stale 上报且不写。
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
    if (spec === undefined) { entries[server] = []; continue }
    if (spec === '*') { entries[server] = ['*']; wildcards.push(server); continue }
    const known = input.knownTools[server] || []
    if (known.length) stale.push(...spec.filter((t) => known.indexOf(t) < 0).map((t) => 'mcp/' + server + '/' + t))
    entries[server] = spec.slice()
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

/** 退出模式：MCP 按快照原文整体还原；技能按快照键还原、快照后新增键保持现状。 */
export function computeRestorePlan(snapshot: ModeSnapshot, current: { mcp: Record<string, string[]>; skills: Record<string, boolean> }): { mcp: Record<string, string[]>; skills: Record<string, boolean> } {
  const mcp = Object.fromEntries(Object.entries(snapshot.mcp).map(([k, v]) => [k, v.slice()]))
  for (const [k, v] of Object.entries(current.mcp)) if (!(k in mcp)) mcp[k] = v
  const skillsOut: Record<string, boolean> = {}
  for (const [k, on] of Object.entries(snapshot.skills)) skillsOut[k] = on
  for (const [k, on] of Object.entries(current.skills)) if (!(k in skillsOut)) skillsOut[k] = on
  return { mcp, skills: skillsOut }
}
