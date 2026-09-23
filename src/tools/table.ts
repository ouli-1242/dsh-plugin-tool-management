// 「模型工具表」开关（2026-09-23）。
//
// 为什么要有它：工具表是按**每个请求**付钱的 —— 本插件 18 个工具的 schema 合计 ≈3,439 tok
// （口径：整份 `JSON.stringify(definition).length / 4`，与宿主记录的一致），每一轮都随请求
// 发出，哪怕这一轮根本用不上。关掉某几个工具，它们整份不进请求（不是"把描述写短点"那种省）；
// 面板（118 个 op）与注入通道完全不受影响。
//
// 本文件只放纯逻辑（normalize / 分域分组 / 体积汇总）。落盘与 TTL 缓存在 index.ts，与
// 注入设置（`inject-settings.json`）走同一套写法。
//
// 谁读这份设置：
//   · index.ts 的 op `tool-table`（读写侧车 + 写后刷新可见性与两个目录）；
//   · mcp/manager.ts 的 `pluginHiddenTools` —— 官方 `tools.restrict()` 只允许**每个 agent
//     scope 一层**限制（两处各调一次会互相覆盖），所以 MCP 停用名单与我们的名单必须在那边
//     并成一次 restrict；
//   · 工具执行门禁（关掉的工具即便被点到也不执行 —— 可见性半边失败时仍有这一半）；
//   · 注入通道与两个目录：目录里「用 `skill_manager_list` 查」这类句子在工具关掉后就是假的。

import { INJECT_DOMAIN_KEYS, domainOfTool, type InjectDomainKey } from '../context-inject.js'

/** 侧车 `tool-table.json` 的形状（`hidden` = 不发给模型的工具名）。 */
export interface ToolTableSettings {
  hidden: string[]
}

/** 默认一个都不关：装完即用，省钱的开关由用户自己按需打开。 */
export const DEFAULT_TOOL_TABLE_SETTINGS: ToolTableSettings = { hidden: [] }

/** 把任意输入夹成合法设置（只收非空字符串；重复的只留一份）。 */
export function normalizeToolTableSettings(raw: unknown): ToolTableSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = Array.isArray(obj.hidden) ? obj.hidden : []
  const hidden: string[] = []
  for (const item of list) {
    // 只认字符串：`[7]` 这种手改产物不该被 String() 变成一个看着像工具名的东西。
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name !== '' && hidden.indexOf(name) < 0) hidden.push(name)
  }
  return { hidden }
}

/**
 * 0.14.0 的旧工具名 → 新工具名迁移表。
 *
 * 为什么必须有它：`tool-table.json` 存的是**用户点名关掉的那些工具**。0.14.0 把五族并成 17 条
 * 之后，旧名在新表里根本不存在 —— 不迁移的话，用户"关掉了某条"的意图会在新名字上**静默失效**
 * （那条工具照旧每轮发出去，而他以为早就关了）。
 *
 * 映射规则不是字符串替换而是**语义合并**：两条旧工具并成一条 `save` 时，只要原来关掉了其中
 * 任意一条，就应当关掉新的那条 —— 用户当时的意图是"别让模型碰这件事"。
 *
 * 只翻译**认识的名字**，其余原样保留：我们无法区分"用户的旧名"与"别的插件的工具名"，
 * 误删别人的条目比留着一条死名更糟。
 */
export const LEGACY_TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  // 记忆族：0.14.0 只把 write + update 并成一条 `save`，名字本身没动 —— 所以只有这两条要迁移。
  // （0.14.0 开发中途曾把整族改叫 `scene_memory_manager_*`，但那个名字**从未发布**，用户侧
  // 不可能有它，因此不存在需要从它迁回来的数据。）
  memory_manager_write: 'memory_manager_save',
  memory_manager_update: 'memory_manager_save',
  mcp_manager_set_enabled: 'mcp_manager_switch',
  mcp_manager_restart: 'mcp_manager_switch',
  mcp_manager_add: 'mcp_manager_save',
  skill_manager_create: 'skill_manager_save',
  subagent_manager_create: 'subagent_manager_save',
  subagent_manager_update: 'subagent_manager_save',
})

/**
 * 把一份设置里的旧工具名翻译成新名（**幂等**：已经全是新名时 `changed` 为 false、原样返回）。
 * 翻译后按新名去重（两条旧名并成同一条 save 时只留一份）。
 */
export function migrateLegacyToolNames(settings: ToolTableSettings): { settings: ToolTableSettings; changed: boolean } {
  let changed = false
  const hidden: string[] = []
  for (const raw of settings.hidden) {
    const name = LEGACY_TOOL_NAME_MAP[raw] ?? raw
    if (name !== raw) changed = true
    if (hidden.indexOf(name) < 0) hidden.push(name)
  }
  return changed ? { settings: { hidden }, changed: true } : { settings, changed: false }
}

/** 注册时量到的工具体积（`JSON.stringify(definition).length`，见 index.ts 的 register 包装）。 */
export interface ToolTableRow {
  name: string
  bytes: number
}

export interface ToolTableTool {
  name: string
  tok: number
  hidden: boolean
}

export interface ToolTableGroup {
  /** 域 key；与五个注入域同源。认不出前缀的工具归到 `other`。 */
  key: InjectDomainKey | 'other'
  tools: ToolTableTool[]
  /** 该域全部工具的 ≈token 合计（含关掉的）。 */
  tok: number
  /** 其中当前关掉的 ≈token 合计。 */
  hiddenTok: number
}

export interface ToolTableReport {
  groups: ToolTableGroup[]
  /** 当前会随请求发出的部分。 */
  visibleTok: number
  /** 当前不发的那部分（关对了就是这个数）。 */
  hiddenTok: number
  totalTok: number
  visibleCount: number
  hiddenCount: number
  totalCount: number
}

/**
 * 宿主与界面共用的字符/词比（`dsh-token-meter` 的 `CHARS_PER_TOKEN`，其
 * `estimateToolsTokens` = `ceil(JSON.stringify(tools).length / 4) + 4`）。
 *
 * 这是**估算**：宿主自己也这么说（"Actual usage remains authoritative"，真实用量来自
 * API 的 `stream_options.include_usage`）。界面上必须带「≈」。
 */
export const CHARS_PER_TOKEN = 4

export function estimateTok(bytes: number): number {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value / CHARS_PER_TOKEN)
}

/**
 * 纯函数：把注册时量到的体积按域分组，标出哪些被关掉，给出三档合计。
 *
 * 顺序：域按 `INJECT_DOMAIN_KEYS`（界面与注入通道同一顺序），域内按**注册顺序**
 * —— 改顺序等于改显示顺序，不额外定义"重要性"，免得出现第二份排序真相。
 */
export function buildToolTableReport(rows: readonly ToolTableRow[], hidden: readonly string[]): ToolTableReport {
  const off = new Set(hidden.map((name) => String(name)))
  const buckets = new Map<InjectDomainKey | 'other', ToolTableTool[]>()
  for (const key of INJECT_DOMAIN_KEYS) buckets.set(key, [])
  for (const row of rows) {
    const name = String(row && row.name ? row.name : '').trim()
    if (name === '') continue
    // 认不出前缀的工具归到 `other` 而不是丢掉：丢掉 = 它在界面上根本不出现，
    // 于是"没登记的域"就永远关不掉，而且没人看得出来（静默降级）。
    const key = domainOfTool(name) ?? 'other'
    let list = buckets.get(key)
    if (list === undefined) { list = []; buckets.set(key, list) }
    list.push({ name, tok: estimateTok(row.bytes), hidden: off.has(name) })
  }
  const groups: ToolTableGroup[] = []
  let visibleTok = 0
  let hiddenTok = 0
  let visibleCount = 0
  let totalCount = 0
  for (const [key, tools] of buckets) {
    if (!tools.length) continue
    let tok = 0
    let offTok = 0
    for (const tool of tools) {
      tok += tool.tok
      totalCount += 1
      if (tool.hidden) offTok += tool.tok
      else { visibleTok += tool.tok; visibleCount += 1 }
    }
    hiddenTok += offTok
    groups.push({ key, tools, tok, hiddenTok: offTok })
  }
  return {
    groups, visibleTok, hiddenTok, totalTok: visibleTok + hiddenTok,
    visibleCount, hiddenCount: totalCount - visibleCount, totalCount,
  }
}
