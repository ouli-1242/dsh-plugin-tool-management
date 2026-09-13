// src/rules/archive.ts —— 场景档案数据模型与模式切换纯逻辑（无 I/O；I/O 由 archive-engine 注入）。
// 勾选集语义（设计 §2.1）：段内存储「勾选的启用集合」；应用时该域启停置为与勾选集完全一致；
// 段未定义 = 该域不碰；段已定义但全不勾 = 合法（全部停用）。清单只对"实时发现"的条目生效。

export interface SceneArchive {
  tools?: string[]      // 勾选的工具选集，key = `<serverName>/<toolName>`
  skills?: string[]     // 勾选的技能选集，key = `<rootKey>/<name>`
  subagents?: string[]  // 绑定的人设名清单
}

export interface ModeSnapshot { tools: Record<string, boolean>; skills: Record<string, boolean> }
export interface ModeState { scene: string | null; snapshot: ModeSnapshot | null }

export interface ApplyPlan {
  tools: Record<string, boolean> | null   // null = 该域不碰
  skills: Record<string, boolean> | null
  stale: string[]                          // 勾选集中已不存在的条目（跳过 + 上报，不算失败）
}

export function normalizeStringList(raw: unknown): string[] {
  if (typeof raw === 'string') raw = raw.split(/[,，]/)
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))]
}

/** 'tools'/'skills'/'subagents' 键存在才归一——存在性独立于集合是否为空。 */
export function normalizeArchive(raw: unknown): SceneArchive {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: SceneArchive = {}
  if ('tools' in obj) out.tools = normalizeStringList(obj.tools)
  if ('skills' in obj) out.skills = normalizeStringList(obj.skills)
  if ('subagents' in obj) out.subagents = normalizeStringList(obj.subagents)
  return out
}

export function hasSection(archive: SceneArchive, section: 'tools' | 'skills'): boolean {
  return Array.isArray(archive[section])
}

/** 进入模式的应用计划：已定义段 → 目标 = 勾选集（仅已知条目），stale 跳过上报；未定义段 = null。 */
export function computeApplyPlan(archive: SceneArchive, known: { tools: Set<string>; skills: Set<string> }): ApplyPlan {
  const stale: string[] = []
  const plan: ApplyPlan = { tools: null, skills: null, stale }
  if (hasSection(archive, 'tools')) {
    const target: Record<string, boolean> = {}
    for (const key of known.tools) target[key] = archive.tools!.includes(key)
    for (const key of archive.tools!) if (!known.tools.has(key)) stale.push('tools/' + key)
    plan.tools = target
  }
  if (hasSection(archive, 'skills')) {
    const target: Record<string, boolean> = {}
    for (const key of known.skills) target[key] = archive.skills!.includes(key)
    for (const key of archive.skills!) if (!known.skills.has(key)) stale.push('skills/' + key)
    plan.skills = target
  }
  return plan
}

export function snapshotRuntime(tools: Record<string, boolean>, skills: Record<string, boolean>): ModeSnapshot {
  return { tools: { ...tools }, skills: { ...skills } }
}

/** 退出模式：快照键按快照值还原；快照之后新出现的键保持现状（快照不含 → 不属于被模式改动的集合）。 */
export function computeRestorePlan(snapshot: ModeSnapshot, current: { tools: Record<string, boolean>; skills: Record<string, boolean> }): ApplyPlan {
  const tools: Record<string, boolean> = {}
  for (const [key, on] of Object.entries(snapshot.tools)) tools[key] = on
  for (const [key, on] of Object.entries(current.tools)) if (!(key in tools)) tools[key] = on
  const skills: Record<string, boolean> = {}
  for (const [key, on] of Object.entries(snapshot.skills)) skills[key] = on
  for (const [key, on] of Object.entries(current.skills)) if (!(key in skills)) skills[key] = on
  return { tools, skills, stale: [] }
}
