// src/skills/catalog.ts —— 技能目录段（注入通道的数据源）。
//
// 为什么需要它：技能目录本来是官方 `@deepseek-ai/dsh-tool-skill` 的活 —— 它随预设挂载，
// 极简这类预设没挂，模型连"有哪些技能"都不知道（网页版把宿主那两条行交给预设后尤其如此）。
// 本模块提供同一份信息的**兜底通道**：只在预设没挂官方那一行时注入（判定在
// src/context-inject.ts 的 `CARRIER_FACT_OF`），格式与官方目录同形（`- \`name\`: description`）。
//
// 数据源用**插件自己的技能清单**（技能服务的 `skill-state`）：它已经含启停 / 被同名覆盖 /
// 同名首选的判定 —— 那正是用户在技能页管的那些开关；官方注册表里的同一份策略也由本插件的
// provider 喂进去，所以两边看到的是同一批技能。
//
// 与官方目录的两处有意差别：
//   - 只列**当前启用且可被模型调用**的（官方只过滤可调用性，不管用户在插件页关掉了谁）。
//   - 结尾多一行：本预设没有官方 `skill` 加载工具（目录与工具是一起挂的），需要正文时得先
//     `skill_manager_list` 取源文件路径再读那个文件 —— 不写这句，模型会以为有 `skill` 工具可调。
//
// 同步性：`text()` 必须同步返回（注入通道每个 step 同步取文本），而技能清单是异步读盘 →
// 与子智能体目录同构的 stale-while-revalidate：`text()` 返回缓存值并在超龄时后台重算，
// `refresh()` 供技能写操作后立即重算。

/** 描述截断长度（与官方目录的 `catalogDescriptionMaxLength` 默认值一致）。 */
export const SKILL_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/** 目录最多列几条；超出只报数量（让模型去调 `skill_manager_list`）。 */
export const SKILL_CATALOG_MAX_ENTRIES = 50

/** 技能清单里的一行（`skill-state` 的 `roots[].skills[]` 子集）。 */
export interface SkillCatalogRow {
  name?: string
  declaredName?: string
  description?: string
  enabled?: boolean
  modelInvocable?: boolean
  userInvocable?: boolean
  invocationPolicyValid?: boolean
  managerEnabled?: boolean
  shadowedBy?: { root?: string; name?: string } | null
}

/** 描述归一化 + 截断（与官方 `catalogDescription` 同款：折叠空白、超出补省略号）。 */
function catalogDescription(value: unknown, maxLength: number): string {
  const normalized = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

/** 与 `skill_manager_list` / 界面（`isSkillEnabled`）同一套启停推导。 */
function isEnabled(row: SkillCatalogRow): boolean {
  if (row.enabled !== undefined) return row.enabled === true
  return row.invocationPolicyValid === true && row.modelInvocable === true && row.userInvocable === true && row.managerEnabled !== false
}

/**
 * 渲染技能目录段（纯函数，便于单独推理）。
 *
 * 返回 `''` 表示没有可注入的技能 —— 没装技能的用户零 token 成本。
 * 名字按字典序排序：底层目录枚举顺序变化时文本仍逐字节稳定（前缀缓存契约）。
 */
export function renderSkillCatalog(
  data: unknown,
  maxEntries: number = SKILL_CATALOG_MAX_ENTRIES,
  maxDescription: number = SKILL_CATALOG_DESCRIPTION_MAX_LENGTH,
): string {
  const roots = (data && typeof data === 'object' ? (data as { roots?: unknown }).roots : undefined) ?? []
  const byName = new Map<string, { name: string; description: string }>()
  if (Array.isArray(roots)) {
    for (const root of roots) {
      const skills = (root && typeof root === 'object' ? (root as { skills?: unknown }).skills : undefined) ?? []
      if (!Array.isArray(skills)) continue
      for (const raw of skills) {
        if (!raw || typeof raw !== 'object') continue
        const row = raw as SkillCatalogRow
        // 影子里那份不可加载（同名只有胜出者生效），启停开关也管不到它 —— 不进目录。
        if (row.shadowedBy) continue
        if (!isEnabled(row) || row.modelInvocable === false) continue
        const name = String(row.declaredName || row.name || '').trim()
        if (name === '') continue
        // 同名（跨根）只留一份：胜出者由 core 标出，这里按出现顺序先到先得，避免重复行。
        if (byName.has(name)) continue
        byName.set(name, { name, description: catalogDescription(row.description, maxDescription) })
      }
    }
  }
  if (byName.size === 0) return ''
  const sorted = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const shown = sorted.slice(0, Math.max(0, maxEntries))
  const lines = shown.map((row) => (row.description ? '- `' + row.name + '`: ' + row.description : '- `' + row.name + '`'))
  const out = [
    '## 技能',
    '',
    '**本预设没有官方 `skill` 加载工具；要技能正文时用 `skill_manager_list` 取源文件路径再读。**',
    '',
    ...lines,
  ]
  const hidden = sorted.length - shown.length
  if (hidden > 0) out.push('', `（另有 ${hidden} 个未列出，用 \`skill_manager_list\` 查。）`)
  return out.join('\n')
}

export interface SkillCatalogDeps {
  /** 取技能清单（插件技能服务的 `skill-state` op）。 */
  state: () => Promise<any>
}

export interface SkillCatalog {
  /** 同步返回段文本（可能比磁盘状态滞后一个 TTL）。 */
  text: () => string
  /** 立即重算（技能写操作后调用）。 */
  refresh: () => Promise<void>
  /** 预热：插件加载时调一次，避免首个请求落到空值。 */
  warm: () => Promise<void>
}

export interface SkillCatalogOptions {
  maxEntries?: number
  maxDescription?: number
  /** 缓存新鲜度；与子智能体目录同量级。 */
  ttlMs?: number
  now?: () => number
}

/**
 * 创建 SWR 的技能目录。计算失败时保留上一次的值（不把段清空），首次失败维持 `''`。
 * 并发调用共享同一次计算（inflight 折叠）。
 */
export function createSkillCatalog(deps: SkillCatalogDeps, opts: SkillCatalogOptions = {}): SkillCatalog {
  const ttlMs = opts.ttlMs ?? 30_000
  const now = opts.now ?? (() => Date.now())
  let value = ''
  let loadedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | null = null

  const recompute = async (): Promise<void> => {
    try {
      const result = await deps.state()
      if (result && result.ok !== false) {
        value = renderSkillCatalog(result.data ?? result, opts.maxEntries, opts.maxDescription)
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
