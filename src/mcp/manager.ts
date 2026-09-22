// MCP 管理域 —— 侧车读写（备注 / 设置 / 停用表）+ 补丁文件行编辑 + 16 个 op 的实现。
//
// 2026-09-19 从 index.ts 的 apply 闭包原样抽出（块 A 1795-1913 + 块 B 1920-3100）。
// 为什么单独一个文件：这 1300 行只做一件事 —— 把「MCP 配置」翻译成补丁文件的改动与
// 界面看到的一份状态。它此前夹在注入通道、令牌门禁与场景档案之间，改一处要在 4000 行里穿行。
//
// 边界（两处刻意保留在 index.ts）：
//   * \`pluginVersion\` —— 通用 op，与 MCP 无关；
//   * \`readJsonFile\` / \`writeJsonFile\` —— 通用侧车 JSON 读写，注入设置也在用，
//     所以留在 index.ts 并经 deps 传进来，避免为两个 6 行函数再造一层。
//
// **反向依赖**（本文件被外部调用，共 12 个出口，见 McpManager）：
// 注入通道要 \`mcpmRowsWithNotes(false)\`（打码后那份）、场景档案引擎要读写停用表与备注、
// 工具门禁要读 TTL 缓存判断某工具是否被停用、审批策略要读插件设置。
// 这些以前靠闭包隐式共享，现在全部经返回的 McpManager 显式暴露 —— 谁用了什么一眼可见。
//
// **正向依赖**（本文件调用外部）：补丁行解析用 ./patch-yaml.ts、打码判据用 ./secret-guard.ts，
// 其余 14 项（ensurePaths / withWriteLock / readPatch / pluginInventory / memoriesService 等）
// 由 deps 显式传入。

import { clearRuntimeNote, noteRuntime } from '../compat/runtime-notes.js'

import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MCP_CLIENT_MODULE } from '../host-names.js'
import { hubPath } from '../hub.js'
import { planOverrideCompaction } from './override-blocks.js'
import { createMcpStateCatalog, type McpStateCatalog } from './state-section.js'
import {
  appendBlock, buildDisableBlock, buildInsertBlock, parseRows, removeEntryAll, removeMarked,
  spliceRanges, splitLines, type ManagedRow,
} from './patch-yaml.js'
import { describeMaskedOutcome, maskedKeysIn, resolveMaskedKv, resolveMaskedUrl } from './secret-guard.js'

/** 本文件需要的外部能力（全部显式传入，不再靠闭包捕获）。 */
export interface McpManagerDeps {
  /** 通用侧车 JSON 读写（注入设置也在用，所以留在 index.ts）。 */
  readJsonFile(abs: string): Promise<any>
  writeJsonFile(abs: string, data: any): Promise<void>
  /** 确保 hub 目录存在（写盘前调用）。 */
  ensurePaths(): Promise<any>
  /** 全局写锁：补丁与侧车的写都在它下面串行。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  /** 错误 → 文案（与全仓同源）。 */
  message(e: unknown): string
  /** 宿主 tools 服务（读 live schema）。 */
  tools: ToolsService
  /** 宿主 pluginInventory 服务（枚举 loader 条目）。 */
  pluginInventory: PluginInventoryService | undefined
  /** 定时等待（ctx.timeout）；重启轮询用。 */
  wait(ms: number): Promise<void>
  /** 宿主设置（toolDescriptionMaxLength 等）。 */
  settings: any
  /**
   * 「模型工具表」关掉的本插件工具（同步快照，读 TTL 缓存）。
   *
   * 为什么由 MCP 域代管这一份名单：官方 `tools.restrict()` 是**每个 agent scope 一层限制**，
   * 两处各调一次会互相覆盖（后一层把前一层顶掉）。而停用工具的可见性只在这一个地方算，
   * 所以两边的名字在这里合并成一次 restrict —— 单向依赖：本文件不知道工具表设置长什么样，
   * 只拿到一串名字。
   */
  pluginHiddenTools?(): string[]
  /**
   * 「有官方等价物在场就让位」那半边：按 **agent** 算的额外 hide 名单（异步，读该 agent 的
   * 预设事实 / 观察它 scope 里解析得到什么）。
   *
   * 为什么与 `pluginHiddenTools` 分开：那是用户全局关掉的（一份名单给所有 agent），这是
   * 逐 agent 不同的判断 —— 而本文件不知道哪些工具与官方重复，只负责把两串名字并成该
   * agent 的那一层限制。判错的方向也相反：全局名单来自用户的明确动作，这份是推断出来的，
   * 所以调用方约定**拿不准就返回空**（宁可多花 token，也不让模型少一条路）。
   */
  carrierHiddenTools?(agent: unknown): Promise<string[]>
  /** 读补丁文件原文。 */
  readPatch(abs: string): Promise<string>
  /** 写补丁文件（原子替换；写门禁已在 op 层判定）。 */
  writePatch(abs: string, content: string): Promise<void>
  /** 记忆服务：mcpm-edit 要把停用表写进当前模式的快照。 */
  memoriesService: { readArchiveSlice(): Promise<any>; patchIndex(slice: any): Promise<any> }
}

/** 本文件对外暴露的出口（12 项）。 */
export interface McpManager {
  /** MCP 状态段（注入通道的数据源；index.ts 与重启后的目录刷新都用它）。 */
  stateCatalog: McpStateCatalog
  /** 16 个 MCP op 的 handler（直接 spread 进 ops 表）。 */
  ops: Record<string, (args: any) => Promise<any>>
  /** 停用表（TTL 缓存；force 跳过缓存）。 */
  readDisabledTools(force?: boolean): Promise<Record<string, string[]>>
  /** 最后见过的工具名单（未运行的服务器也能算补集）。 */
  readKnownMcpTools(): Promise<Record<string, Array<{ name: string }>>>
  /** 服务器备注（按 loader id）。 */
  readNotes(force?: boolean): Promise<Record<string, string>>
  /** 写停用表：落盘 + 更新缓存 + 重排工具可见性。 */
  writeDisabledTools(entries: Record<string, string[]>): Promise<void>
  /** 在写锁内读-改-写备注（merge 由调用方给）。 */
  updateNotes(mutate: (map: Record<string, string>) => void): Promise<void>
  /** MCP 服务器列表视图（已打码）。 */
  mcpmListView(): Promise<any>
  /** 列表行（mask=false 时**含明文凭据**，只有注入侧该用 false 那份）。 */
  mcpmRowsWithNotes(mask: boolean): Promise<any[]>
  /** 插件设置（轮询间隔 / 描述长度上限 / 两个确认开关）。 */
  readPluginSettings(force?: boolean): Promise<{ pollIntervalMs: number; toolDescriptionMaxLength: number; requireConfirmForModelRuleWrite: boolean; requireConfirmForModelSubagentRun: boolean }>
  /** 某工具全名是否在停用表里（读 TTL 缓存，无 I/O —— 工具门禁在热路径上）。 */
  isToolDisabled(name: string): boolean
  /** 停用表里的工具条数（读 TTL 缓存；功能总览用）。 */
  disabledToolCount(): number
  /** 启动预热：读一次停用表并应用工具可见性限制。 */
  warmUp(): Promise<void>
  /** 重排工具可见性（tools/change 后调用）。 */
  scheduleToolRestrictions(): void
  /**
   * 可见性半边要落在 agent scope 上（官方 `restrict()` 要求 scoped ctx）：
   * agent 上线时登记并应用当前名单，下线时撤掉。
   */
  attachAgent(agent: unknown): void
  detachAgent(agent: unknown): void
  /** 卸载清理：清掉重排定时器与每个 agent 上的限制。 */
  dispose(): void
}

// ── 宿主服务的最小结构面（本插件只碰这几个方法；完整契约在对应 @deepseek-ai 包）──

export interface ToolsService {
  register(definition: unknown): () => void
  schemas(scope?: unknown): Array<{ name: string; description?: string }>
  /**
   * Optional (dsh-tools): remove global tool names from every scope's
   * model-visible schema list. Fails on names that are not currently
   * registered, so callers must intersect with schemas() first.
   */
  restrict?(filter: { deny?: readonly string[] }): () => void
  /**
   * Optional (dsh-tools): monotonic execution guard — a returned reason string
   * denies the call before the tool body runs.
   */
  guard?(guard: (execution: { name?: string }) => string | undefined): () => void
}

export interface PluginInventoryService {
  list(): Promise<{ entries: PluginInventoryEntry[] }>
}

// ── MCP 域专属的类型与纯函数（2026-09-19 从 index.ts 搬来，逐字未改）──

export interface PluginInventoryEntry {
  entryId: string
  moduleName?: string
  enabled?: boolean
  fiberPhase?: string
}

/**
 * 「已知工具」侧车里的一个条目：工具名 + **最后一次运行时的描述**。
 *
 * 描述是 v0.9.0 才加进来的（此前只存名字）：未运行的服务器在 `tools.schemas()` 里什么都没有，
 * 详情页只能对每个工具重复一句「描述暂不可用」。而描述在服务器运行时就拿得到，顺手存下来，
 * 未运行时就能显示上次见过的描述（界面标「上次运行时」，不假装是实时数据）。
 * 旧侧车文件是 `string[]`，`normalizeKnownTools` 兼容读取。
 */
interface KnownMcpTool {
  name: string
  description?: string
}

/**
 * 归一化「已知工具」侧车的一行值。
 *
 * 兼容两种格式：旧版 `string[]`（只存名字，v0.8.5 及以前）与新版 `Array<{name, description?}>`。
 * 非法名字、重复名字一律丢掉并去重后按名字排序 —— 排序保证写盘内容稳定（不会因为枚举顺序
 * 变化而反复重写侧车）。导出仅为测试接缝（与 client 的 `memDefaultPickIds` 同一用意）。
 */
export function normalizeKnownTools(raw: unknown): KnownMcpTool[] {
  if (!Array.isArray(raw)) return []
  const out: KnownMcpTool[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const name = typeof item === 'string'
      ? item
      : String((item as { name?: unknown } | null)?.name ?? '')
    if (!name || !/^[A-Za-z0-9_-]{1,128}$/.test(name) || seen.has(name)) continue
    seen.add(name)
    const description = typeof item === 'object' && item !== null && typeof (item as { description?: unknown }).description === 'string'
      ? String((item as { description: string }).description)
      : undefined
    out.push({ name, ...(description ? { description } : {}) })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * 「当前可用」工具数：已知工具名里未被停用表扣减的个数；`*` = 整台停用 → 0。
 *
 * 场景档案收窄与手动逐工具开关写的是同一张停用表，所以**段、页面、`mcp_manager_list`
 * 三处的「N 个工具」都必须是这个数** —— 用扣减前的总数会让模型看到自己 schema 里
 * 并不存在的工具（数字与能调的工具对不上），页面也会和详情页的开关自相矛盾。
 * 导出仅为测试接缝（与 `normalizeKnownTools` 同一用意）。
 */
export function countEnabledTools(known: ReadonlySet<string> | readonly string[], disabled: readonly string[]): number {
  const off = Array.isArray(disabled) ? disabled : []
  if (off.indexOf('*') >= 0) return 0
  let n = 0
  for (const tool of known) if (off.indexOf(tool) < 0) n++
  return n
}


export function createMcpManager(deps: McpManagerDeps): McpManager {
  // 外部能力一次解构成局部名：块内代码是逐字搬来的，保持原样最不容易出错。
  const {
    readJsonFile, writeJsonFile, ensurePaths, withWriteLock, message,
    tools, pluginInventory, settings, readPatch, writePatch, memoriesService, wait,
  } = deps

  // MCP 状态段（注入通道的数据源）由本域自己建：它要的 rows 就是本域的 mcpmRowsWithNotes(false)，
  // 让 index.ts 建再传进来会形成 index ↔ manager 的循环引用。
  const mcpStateCatalog = createMcpStateCatalog({ rows: () => mcpmRowsWithNotes(false) })



  // ---------- duplicate loader-id guard ----------
  // Two rows with the same loader id make the plugin composition fail to
  // boot (upstream hit exactly this after renaming an entry), so duplicates
  // are reported on read and new ones are refused before any write.
  function duplicateIdsOf(content: string): string[] {
    const counts = new Map<string, number>()
    for (const row of parseRows(content).rows) {
      if (!row.id) continue
      counts.set(row.id, (counts.get(row.id) || 0) + 1)
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
  }
  function duplicateGuard(before: string, after: string): { ok: false; error: string } | null {
    const known = new Set(duplicateIdsOf(before))
    const introduced = duplicateIdsOf(after).filter((id) => !known.has(id))
    if (!introduced.length) return null
    return { ok: false, error: '写入会产生重复的 loader id（重复 id 会导致 DSH 无法启动）：' + introduced.join('、') }
  }

  // ---------- shared state ----------
  async function collectAll(): Promise<{ ids: Set<string>; serverNames: Set<string>; rows: Array<{ id: string; serverName: string; level: string; disabled: boolean }> }> {
    const p = await ensurePaths()
    const ids = new Set<string>()
    const serverNames = new Set<string>()
    const rows: Array<{ id: string; serverName: string; level: string; disabled: boolean }> = []
    for (const level of ['project', 'global']) {
      const abs = level === 'project' ? p.projectPatch : p.globalPatch
      let content = ''
      try { content = await readPatch(abs) } catch (e) { continue }
      const { rows: fileRows } = parseRows(content)
      for (const r of fileRows) {
        ids.add(r.id)
        const sn = r.config && r.config.serverName ? String(r.config.serverName) : r.id
        serverNames.add(sn)
        rows.push({ id: r.id, serverName: sn, level, disabled: !!r.disabled })
      }
    }
    return { ids, serverNames, rows }
  }

  const bareEntryId = (v: string) => { const s = String(v); const i = s.lastIndexOf(':'); return i >= 0 ? s.slice(i + 1) : s }

  async function liveEntry(id: string): Promise<PluginInventoryEntry | null> {
    if (!pluginInventory) return null
    try {
      const res = await pluginInventory.list()
      return res.entries.find((e) => e.moduleName === MCP_CLIENT_MODULE && bareEntryId(e.entryId) === id) || null
    } catch (e) { return null }
  }

  async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, stepMs: number): Promise<boolean> {
    const start = Date.now()
    for (;;) {
      const v = await pred()
      if (v) return true
      if (Date.now() - start > timeoutMs) return false
      await wait(stepMs)
    }
  }

  async function entryExists(id: string, level: string): Promise<boolean> {
    const p = await ensurePaths()
    const abs = level === 'global' ? p.globalPatch : p.projectPatch
    let content = ''
    try { content = await readPatch(abs) } catch (e) { return false }
    const { rows } = parseRows(content)
    if (rows.some((r) => r.id === id)) return true
    return (await liveEntry(id)) !== null
  }

  function normalizeRow(r: ManagedRow, level: string, abs: string) {
    const cfg = r.config || {}
    return {
      id: r.id,
      serverName: cfg.serverName || r.id,
      transport: cfg.transport || null,
      url: cfg.url || null,
      command: cfg.command || null,
      args: cfg.args || null,
      env: cfg.env || null,
      headers: cfg.headers || null,
      level,
      disabled: !!r.disabled,
      managed: !!r.managed,
    }
  }

  // ---------- import helpers ----------
  function toStrMap(v: unknown): Record<string, string> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const k of Object.keys(v)) out[k] = String((v as Record<string, unknown>)[k])
    return out
  }
  function normalizeImportItem(item: unknown): { ok: true; row: any } | { ok: false; error: string } {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: '条目不是对象' }
    const it = item as Record<string, unknown>
    const serverName = String(it.serverName || '').trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 非法: ' + String(it.serverName) }
    const transport = it.transport === 'stdio' ? 'stdio' : 'streamable-http'
    const level = it.level === 'global' ? 'global' : 'project'
    const baseId = 'mcp-' + serverName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const rawId = String(it.id || '').trim()
    const id = rawId && /^[A-Za-z0-9_.:@%+=/-]+$/.test(rawId) ? rawId : baseId
    const row: any = { id, serverName, transport, level, disabled: !!it.disabled }
    if (transport === 'streamable-http') {
      const url = String(it.url || '').trim()
      if (!/^https?:\/\//.test(url)) return { ok: false, error: serverName + ': url 非法' }
      row.url = url
      row.headers = toStrMap(it.headers)
    } else {
      const command = String(it.command || '').trim()
      if (!command) return { ok: false, error: serverName + ': command 缺失' }
      row.command = command
      row.args = Array.isArray(it.args) ? it.args.map(String) : []
      row.env = toStrMap(it.env)
    }
    return { ok: true, row }
  }

  // User notes are keyed by loader id: they survive renames of the server
  // name and are never touched by config rewrites.
  //
  // Sidecar caches (notes / settings / disabled tools) are short-TTL: reads
  // hit the cache, but every WRITE re-reads the file (force=true) and merges
  // on top of the fresh on-disk state. Without the forced re-read, a manual
  // edit of the sidecar file would be silently overwritten by a stale cache.
  //
  // 落点：**hub 内**（`~/.dsh/tool-management/`），文件名按域取（`mcp-*`）。
  // 它们曾经躺在 `$DSH_HOME` 根下、还带着插件名前缀（`dsh-plugin-tool-management-notes.json`），
  // 2026-09-16 用户要求「插件产生的文件全部收进 hub、名字与当前代码一致」——
  // 旧文件由 hub.ts 的 `migrateHubLayoutSync()` 在启动时搬进来（见 apply()）。
  const SIDECAR_TTL_MS = 3000
  const MCP_NOTES_FILE = 'mcp-notes.json'
  const MCP_SETTINGS_FILE = 'mcp-settings.json'
  const MCP_DISABLED_TOOLS_FILE = 'mcp-disabled-tools.json'
  const MCP_KNOWN_TOOLS_FILE = 'mcp-known-tools.json'
  const MCP_EXPORT_FILE = 'mcp-export.json'
  /** MCP 侧车绝对路径（都在 hub 内）。 */
  const mcpSidecar = (name: string): string => hubPath(name)
  let notesCache: { at: number; value: Record<string, string> } | null = null
  async function readNotes(force = false): Promise<Record<string, string>> {
    if (notesCache && !force && Date.now() - notesCache.at < SIDECAR_TTL_MS) return notesCache.value
    const raw = await readJsonFile(mcpSidecar(MCP_NOTES_FILE))
    const out: Record<string, string> = {}
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(raw)) {
        const value = (raw as Record<string, unknown>)[key]
        if (typeof value === 'string' && value.trim()) out[key] = value
      }
    }
    notesCache = { at: Date.now(), value: out }
    return out
  }
  /**
   * 备注侧车的读-改-写。**必须在调用方已持有写锁时调用** —— 自己再去拿一次锁会自锁。
   * 空 note = 删掉该条目（与 `mcpm-note` 的语义一致）；强制重读，外部改过的侧车是合并而不是覆盖。
   */
  async function writeNoteUnderLock(id: string, note: string): Promise<{ ok: true; notes: Record<string, string> } | { ok: false; error: string }> {
    const map = Object.assign({}, await readNotes(true))
    if (note) map[id] = note
    else delete map[id]
    try {
      await writeJsonFile(mcpSidecar(MCP_NOTES_FILE), map)
    } catch (e) {
      return { ok: false, error: '备注保存失败: ' + message(e) }
    }
    notesCache = { at: Date.now(), value: map }
    return { ok: true, notes: map }
  }
  async function mcpmNote(args: any): Promise<any> {
    const id = String((args && args.id) || '').trim()
    if (!id) return { ok: false, error: '缺少 id' }
    const note = String((args && args.note) == null ? '' : args.note).trim()
    await ensurePaths()
    return withWriteLock(async () => await writeNoteUnderLock(id, note))
  }

  // 界面轮询间隔的合法区间：再快没有意义（列表刷新本身要读文件），再慢就失去"自动跟上"的
  // 意义。两侧都夹住，避免手改侧车文件时写进一个 0 或无穷大把界面刷爆。
  const POLL_INTERVAL_MIN_MS = 2000
  const POLL_INTERVAL_MAX_MS = 60_000
  const SETTINGS_DEFAULTS = { pollIntervalMs: 5000, toolDescriptionMaxLength: 0, requireConfirmForModelRuleWrite: true, requireConfirmForModelSubagentRun: true }
  let pluginSettingsCache: { at: number; value: { pollIntervalMs: number; toolDescriptionMaxLength: number; requireConfirmForModelRuleWrite: boolean; requireConfirmForModelSubagentRun: boolean } } | null = null
  function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    // Number(null) is 0 — treat missing/empty input as "use the default".
    if (value === null || value === undefined || value === '') return fallback
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  async function readPluginSettings(force = false): Promise<{ pollIntervalMs: number; toolDescriptionMaxLength: number; requireConfirmForModelRuleWrite: boolean; requireConfirmForModelSubagentRun: boolean }> {
    if (pluginSettingsCache && !force && Date.now() - pluginSettingsCache.at < SIDECAR_TTL_MS) return pluginSettingsCache.value
    const p = await ensurePaths()
    const raw = await readJsonFile(mcpSidecar(MCP_SETTINGS_FILE))
    pluginSettingsCache = {
      at: Date.now(),
      value: {
        pollIntervalMs: clampInt(raw && raw.pollIntervalMs, POLL_INTERVAL_MIN_MS, POLL_INTERVAL_MAX_MS, SETTINGS_DEFAULTS.pollIntervalMs),
        // 0 = keep descriptions in full (the UI default); > 0 truncates.
        toolDescriptionMaxLength: clampInt(raw && raw.toolDescriptionMaxLength, 0, 2000, SETTINGS_DEFAULTS.toolDescriptionMaxLength),
        // 模型写规则需确认（D2）：程序化强制，只读设置供 tools/pre-execute 判定。
        requireConfirmForModelRuleWrite: (raw && typeof raw.requireConfirmForModelRuleWrite === 'boolean')
          ? raw.requireConfirmForModelRuleWrite
          : SETTINGS_DEFAULTS.requireConfirmForModelRuleWrite,
        // 子代理运行花真 token：默认确认，设置可关（设计 §3.2）。
        requireConfirmForModelSubagentRun: (raw && typeof raw.requireConfirmForModelSubagentRun === 'boolean')
          ? raw.requireConfirmForModelSubagentRun
          : SETTINGS_DEFAULTS.requireConfirmForModelSubagentRun,
      },
    }
    return pluginSettingsCache.value
  }
  async function mcpmSettings(args: any): Promise<any> {
    const current = await readPluginSettings()
    if (!args || args.set !== true) return { ok: true, settings: current }
    const next = {
      pollIntervalMs: clampInt(args.pollIntervalMs, POLL_INTERVAL_MIN_MS, POLL_INTERVAL_MAX_MS, current.pollIntervalMs),
      toolDescriptionMaxLength: clampInt(args.toolDescriptionMaxLength, 0, 2000, current.toolDescriptionMaxLength),
      requireConfirmForModelRuleWrite: (args && typeof args.requireConfirmForModelRuleWrite === 'boolean')
        ? args.requireConfirmForModelRuleWrite
        : current.requireConfirmForModelRuleWrite,
      requireConfirmForModelSubagentRun: (args && typeof args.requireConfirmForModelSubagentRun === 'boolean')
        ? args.requireConfirmForModelSubagentRun
        : current.requireConfirmForModelSubagentRun,
    }
    const p = await ensurePaths()
    return withWriteLock(async () => {
      try {
        await writeJsonFile(mcpSidecar(MCP_SETTINGS_FILE), next)
      } catch (e) {
        return { ok: false, error: '设置保存失败: ' + message(e) }
      }
      pluginSettingsCache = { at: Date.now(), value: next }
      return { ok: true, settings: next }
    })
  }

  // ---------- per-tool enable/disable (execution + visibility boundary) ----------
  // dsh-mcp-client has no per-tool config, but the DSH tool runtime exposes
  // two official seams: `tools.restrict({ deny })` removes a global tool from
  // every scope's model-visible schema list, and `tools.guard` denies the call
  // before the body runs. Disabled tools therefore become invisible AND
  // uncallable — no patch rewrite, no DSH restart.
  let disabledToolsCache: { at: number; value: Record<string, string[]> } | null = null
  async function readDisabledTools(force = false): Promise<Record<string, string[]>> {
    if (disabledToolsCache && !force && Date.now() - disabledToolsCache.at < SIDECAR_TTL_MS) return disabledToolsCache.value
    const p = await ensurePaths()
    const raw = await readJsonFile(mcpSidecar(MCP_DISABLED_TOOLS_FILE))
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
      for (const tool of map[serverName]) out.push('mcp__' + serverName + '__' + tool)
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
    if (knownMcpToolsCache && !force && Date.now() - knownMcpToolsCache.at < SIDECAR_TTL_MS) return knownMcpToolsCache.value
    const p = await ensurePaths()
    const raw = await readJsonFile(mcpSidecar(MCP_KNOWN_TOOLS_FILE))
    const out: Record<string, KnownMcpTool[]> = {}
    if (raw && typeof raw === 'object') {
      for (const serverName of Object.keys(raw)) {
        const list = normalizeKnownTools((raw as Record<string, unknown>)[serverName])
        if (list.length) out[serverName] = list
      }
    }
    knownMcpToolsCache = { at: Date.now(), value: out }
    return out
  }
  async function writeKnownMcpTools(value: Record<string, KnownMcpTool[]>): Promise<void> {
    const p = await ensurePaths()
    await writeJsonFile(mcpSidecar(MCP_KNOWN_TOOLS_FILE), value)
    knownMcpToolsCache = { at: Date.now(), value: value }
  }
  /** 单工具停用判定（含整服务器通配 `*`——场景档案的"MCP 工具集=整台"写的就是它）。 */
  function isToolDisabledIn(map: Record<string, string[]>, fullName: string): boolean {
    if (!fullName.startsWith('mcp__')) return false
    const rest = fullName.slice(5)
    const i = rest.indexOf('__')
    if (i <= 0) return false
    const list = map[rest.slice(0, i)]
    if (!list) return false
    if (list.indexOf('*') >= 0) return true
    return list.indexOf(rest.slice(i + 2)) >= 0
  }
  async function mcpmToolEnabled(args: any): Promise<any> {
    const serverName = String((args && args.serverName) || '').trim()
    const tool = String((args && args.tool) || '').trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 不合法' }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(tool)) return { ok: false, error: 'tool 名称不合法' }
    const enabled = (args && args.enabled) !== false
    const p = await ensurePaths()
    return withWriteLock(async () => {
      // Force re-read so an externally edited disabled-tools file is merged, not clobbered.
      const map = Object.assign({}, await readDisabledTools(true))
      const disabled = new Set(map[serverName] || [])
      if (enabled) disabled.delete(tool)
      else disabled.add(tool)
      if (disabled.size) map[serverName] = [...disabled].sort()
      else delete map[serverName]
      try {
        await writeJsonFile(mcpSidecar(MCP_DISABLED_TOOLS_FILE), map)
      } catch (e) {
        return { ok: false, error: '保存失败: ' + message(e) }
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
        detail: '有工具没能从模型可见的工具表里摘掉（' + message(e) + '）：执行侧拦截仍然生效，模型仍能看到该工具的名字。',
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
    if (typeof tools.restrict !== 'function') return
    // Force re-read: this runs on the tools/change path, which is rare, so a
    // stale cache must not keep an externally edited deny list hidden.
    const map = await readDisabledTools(true)
    // 通配 `*`（整服务器停用）先展开成已注册的全名，再与精确名单合并。
    const wanted = disabledToolNames(map)
    let registered: Set<string>
    try {
      registered = new Set((await tools.schemas()).map((schema) => String(schema.name)))
    } catch (e) { return }
    for (const [serverName, list] of Object.entries(map)) {
      if (list.indexOf('*') < 0) continue
      const prefix = 'mcp__' + serverName + '__'
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

  function truncateText(value: string, limit: number): string {
    if (!limit || value.length <= limit) return value
    return value.slice(0, Math.max(1, limit - 1)).replace(/\s+$/, '') + '…'
  }

  // ---------- secret masking (UI view only) ----------
  // Only sensitive-looking keys are masked; `$VAR` / `!!js` references are
  // indirections rather than secrets, so they stay readable. URL query strings
  // are redacted because MCP credentials often ride there.
  const SENSITIVE_KEY_RE = /(token|secret|password|passwd|auth|credential|api[_-]?key|access[_-]?key|private[_-]?key|cookie|session|signature|bearer)/i
  function maskSecretValue(value: unknown): string {
    const text = String(value == null ? '' : value)
    if (text === '') return ''
    if (text.startsWith('$')) return text
    if (/^!!js\s/.test(text)) return text
    return '••••••'
  }
  function maskValueMap(map: Record<string, string> | null, onlySensitiveKeys: boolean): Record<string, string> | null {
    if (!map || typeof map !== 'object') return map
    const out: Record<string, string> = {}
    for (const key of Object.keys(map)) {
      out[key] = (!onlySensitiveKeys || SENSITIVE_KEY_RE.test(key)) ? maskSecretValue(map[key]) : String(map[key])
    }
    return out
  }
  function maskUrlQuery(url: string | null): string | null {
    if (!url) return url
    try {
      const parsed = new URL(url)
      if (parsed.search) parsed.search = '?<redacted>'
      return parsed.toString()
    } catch (e) { return url }
  }
  /** Shared UI rows: mcpmList plus notes, secrets masked unless `reveal`. */
  async function mcpmRowsWithNotes(reveal: boolean): Promise<any> {
    const result: any = await mcpmList()
    if (!result || result.ok === false) return result
    const notes = await readNotes()
    const rows = (result.rows || []).map((row: any) => {
      const view: any = Object.assign({}, row, { notes: notes[row.id] || '' })
      if (!reveal) {
        view.url = maskUrlQuery(row.url)
        view.headers = maskValueMap(row.headers, true)
        view.env = maskValueMap(row.env, true)
      }
      return view
    })
    return Object.assign({}, result, { rows })
  }
  /** Default list view: secrets always masked. */
  async function mcpmListView(): Promise<any> {
    return mcpmRowsWithNotes(false)
  }
  /**
   * Plain-text view. Split from mcpm-list into its own op so it can live in
   * WRITE_OPS: `mcpm-list` stays token-free for rendering, while revealing
   * env/headers secrets requires `x-dsh-token` when a token is configured —
   * otherwise a LAN-exposed port would leak credentials read-only.
   */
  async function mcpmReveal(): Promise<any> {
    return mcpmRowsWithNotes(true)
  }

  // Tool preview for one MCP server: project the model-facing schemas down to
  // a name + description + parameter-summary list. The registry prefixes every
  // MCP tool with `mcp__<serverName>__`; we filter on that and strip the prefix
  // for display. Only the direct `properties` of the parameters object are
  // summarized — nested object/array children are omitted (one level is enough
  // for a preview, keeps the dialog readable).
  async function mcpmTools(args: any): Promise<any> {
    const serverName = String(args && args.serverName || '').trim()
    if (!serverName) return { ok: false, error: 'serverName 不能为空' }
    const prefix = 'mcp__' + serverName + '__'
    let schemas: any[] = []
    try {
      schemas = await tools.schemas()
    } catch (e) {
      return { ok: false, error: message(e) }
    }
    const descriptionLimit = (await readPluginSettings()).toolDescriptionMaxLength
    const disabledMapHere = await readDisabledTools()
    const disabledHere = new Set(disabledMapHere[serverName] || [])
    const wildcardHere = disabledHere.has('*')
    const toolsList: any[] = []
    for (const s of schemas) {
      const fullName = String(s && s.name || '')
      if (!fullName.startsWith(prefix)) continue
      const rawName = fullName.slice(prefix.length)
      const params: any[] = []
      const props = s.parameters && typeof s.parameters === 'object' ? s.parameters.properties : null
      const requiredSet = new Set<string>()
      if (s.parameters && Array.isArray(s.parameters.required)) {
        for (const k of s.parameters.required) if (typeof k === 'string') requiredSet.add(k)
      }
      if (props && typeof props === 'object') {
        for (const [key, spec] of Object.entries(props as Record<string, any>)) {
          const ps = (spec && typeof spec === 'object') ? spec : {}
          params.push({
            key,
            required: requiredSet.has(key),
            type: typeof ps.type === 'string' ? ps.type : 'any',
            ...(typeof ps.description === 'string' ? { description: ps.description } : {}),
          })
        }
      }
      toolsList.push({
        name: rawName,
        description: truncateText(typeof s.description === 'string' ? s.description : '', descriptionLimit),
        enabled: wildcardHere ? false : !disabledHere.has(rawName),
        parameters: params,
      })
    }
    // Some dsh-tools builds strip restricted tools from schemas(); without
    // this merge a disabled tool would vanish from the dialog with no way to
    // re-enable it from the UI. Names come from the sidecar, so they always
    // stay reachable; the description is unavailable once the schema is gone.
    const listed = new Set(toolsList.map((t: any) => t.name))
    for (const name of disabledHere) {
      if (name === '*') continue // 整服务器通配：已在上方逐工具体现，不再展示占位行
      if (!listed.has(name)) {
        toolsList.push({ name, description: '（已停用；描述暂不可用）', enabled: false, parameters: [] })
      }
    }
    // 「已知工具」缓存兜底：服务器没运行时 schemas() 里没有它任何工具 —— 场景档案里
    // 想给未运行服务器挑工具就全靠这份最后见过的名单。描述也一并带上（v0.9.0 起缓存），
    // 并标 `stale: true`：界面据此说明「上次运行时」，不假装是实时数据。
    for (const known of (await readKnownMcpTools())[serverName] || []) {
      if (listed.has(known.name)) continue
      toolsList.push({
        name: known.name,
        description: known.description || '（服务器未运行；这个名字来自上次运行记录）',
        // 与上方 live 行同一口径：整台停用（`*`）时 stale 行同样报停用，
        // 否则同页「live 行停用、stale 行启用」自相矛盾。
        enabled: wildcardHere ? false : !disabledHere.has(known.name),
        parameters: [],
        stale: true,
      })
      listed.add(known.name)
    }
    return { ok: true, tools: toolsList }
  }

  /**
   * 临时启动服务器以枚举工具（v0.8.1）：从未运行过的服务器在 schemas() 与「已知工具」
   * 缓存里都没有工具名，场景档案勾选器对它一无所知。这里**临时**把它启用（写补丁），
   * 轮询等它的工具注册（npx 冷启动要下载，上限 TOOLS_REFRESH_TIMEOUT_MS），拿到名单后就
   * **恢复原启停状态**—— 用户环境的服务器开关不受影响。已有已知工具时直接返回现有清单，
   * 不做任何改动。
   */
  // npx 首次启动要下载包，慢的那次可能要好几秒；给 30 秒上限，超了就如实报"没等到"。
  const TOOLS_REFRESH_TIMEOUT_MS = 30_000
  async function mcpmToolsRefresh(args: any): Promise<any> {
    const serverName = String((args && args.serverName) || '').trim()
    if (!serverName) return { ok: false, error: 'serverName 不能为空' }
    const existing = await mcpmTools({ serverName })
    if (existing && existing.ok === false) return existing
    if (existing && (existing.tools || []).length) return existing
    const list = await mcpmListView()
    const row = ((list && list.rows) || []).find((r: any) => String(r.serverName) === serverName)
    if (!row) return { ok: false, error: `未找到服务器: ${serverName}` }
    if (row.level !== 'global' && row.level !== 'project') {
      return { ok: false, error: `该服务器不驻留在补丁文件（level=${row.level}），无法临时启动；请先在 MCP 页启用它一次以记录工具` }
    }
    const wasDisabled = !!row.disabled
    // 恢复「停用」必须能被调用方看见：return 的值在 finally 之前就已求值，原来只在
    // finally 里 console.warn，于是恢复失败时调用方仍拿到 ok: true —— 用户停用的服务器
    // 停在启用态，下次会话真的会起进程。所以把结果先存下来、恢复动作在其后显式执行，
    // 失败就改写结果（降级为 ok:false / 附 warning）。
    const restoreDisabled = async (): Promise<string | null> => {
      if (!wasDisabled) return null
      try {
        const r: any = await mcpmSetEnabled({ id: row.id, level: row.level, enabled: false })
        if (!r || r.ok === false) return String((r && r.error) || '未知原因')
        return null
      } catch (e) { return message(e) }
    }
    let result: any
    try {
      if (wasDisabled) {
        const r: any = await mcpmSetEnabled({ id: row.id, level: row.level, enabled: true })
        if (r && r.ok === false) result = r
      }
      if (!result) {
        const deadline = Date.now() + TOOLS_REFRESH_TIMEOUT_MS
        for (;;) {
          const t: any = await mcpmTools({ serverName })
          if (t && t.ok && (t.tools || []).length) {
            // 记进「已知工具」缓存：以后未运行时场景档案也能列出（名字 + 这次的描述）。
            const known = t.tools
              .filter((x: any) => String(x && x.name))
              .map((x: any) => ({ name: String(x.name), ...(typeof x.description === 'string' && x.description ? { description: x.description } : {}) }))
            if (known.length) {
              try {
                const cache = await readKnownMcpTools()
                const byName = new Map((cache[serverName] || []).map((item) => [item.name, item] as const))
                for (const item of known) {
                  const old = byName.get(item.name)
                  byName.set(item.name, old && old.description && !item.description ? old : { ...old, ...item })
                }
                cache[serverName] = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
                await writeKnownMcpTools(cache)
              } catch { /* 缓存写失败不影响本次返回 */ }
            }
            result = t
            break
          }
          if (Date.now() >= deadline) {
            result = { ok: false, error: `等待超时：${serverName} 在 30 秒内没有注册任何工具（服务器可能启动失败或连接过慢）` }
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    } catch (e) {
      // 抛错路径同样要恢复停用状态、同样要刷新目录缓存（原来靠 finally 兜，改显式后不能漏）。
      const failed = await restoreDisabled()
      void mcpStateCatalog.refresh().catch(() => { /* 刷新失败不影响本次结果 */ })
      throw failed ? new Error(`${message(e)}；另外，恢复「${serverName}」的停用状态也失败了（${failed}）`) : e
    }
    const restoreFailed = await restoreDisabled()
    // 目录刷新是副作用，失败不该带崩本次返回（原来没挂 .catch，会变成未处理拒绝）。
    void mcpStateCatalog.refresh().catch(() => { /* 刷新失败不影响本次结果 */ })
    if (restoreFailed) {
      const note = `「${serverName}」的停用状态没能恢复（${restoreFailed}）：它现在处于启用态，下次会话会真的启动它，请到 MCP 页手动关掉`
      if (!result || typeof result !== 'object') result = { ok: true, warning: note }
      else if (result.ok === false) result = { ...result, error: `${result.error}；另外，${note}` }
      else result = { ...result, warning: note }
    }
    return result
  }

  async function mcpmList(): Promise<any> {
    const p = await ensurePaths()
    const rows: any[] = []
    const errors: string[] = []
    for (const level of ['project', 'global']) {
      const abs = level === 'project' ? p.projectPatch : p.globalPatch
      let content = ''
      try { content = await readPatch(abs) } catch (e) { errors.push(level + ': ' + message(e)); continue }
      const { rows: fileRows } = parseRows(content)
      for (const r of fileRows) rows.push(normalizeRow(r, level, abs))
    }
    const toolCounts: Record<string, number> = {}
    const enabledToolCounts: Record<string, number> = {}
    // 只来自**真实 schema** 的两个数，以及只来自**「已知工具」缓存**的一个数。
    //
    // 为什么必须与上面那两个分开（2026-09-17 用户实测发现）：`toolCounts` 是三处并集
    // （live ∪ 停用表 ∪ 缓存），把"这台 server 曾经有什么工具"与"它现在有什么工具"混成了
    // 一个数。界面状态胶囊与注入段此前读的就是它，于是**一台已经连不上的 server 会被报成
    // 「已运行」并注入上下文**，模型照着去调 `mcp__X__*`，而那个工具根本没注册 —— 白烧一轮。
    //
    // 分开之后三个数各有明确含义：
    //   liveToolCounts        当前真实注册的工具数（0 = 一个都没注册）
    //   liveEnabledToolCounts 上面这个数里未被停用表扣减的（真正能调到的）
    //   knownToolCounts       缓存里的工具数 —— 它是**曾经真的连上过**的证据（缓存只在真实
    //                         schema 里见到工具时才写入），0 = 从未连上过
    //
    // 前两个给状态胶囊与注入段用；`toolCounts` / `enabledToolCounts` 语义不变，继续给场景
    // 档案挑工具、详情页清单用（那里"上次见过哪些工具"正是需要的，且已标 `stale`）。
    const liveToolCounts: Record<string, number> = {}
    const liveEnabledToolCounts: Record<string, number> = {}
    const knownToolCounts: Record<string, number> = {}
    try {
      const schemas = await tools.schemas()
      const knownCache = await readKnownMcpTools()
      const disabledMap = await readDisabledTools()
      const liveNames: Record<string, string[]> = {}
      const liveTools: Record<string, KnownMcpTool[]> = {}
      const seen = new Set<string>()
      for (const s of schemas) {
        const fullName = String(s && s.name || '')
        if (seen.has(fullName)) continue
        seen.add(fullName)
        const m = fullName.match(/^mcp__([A-Za-z0-9_-]+)__(.+)$/)
        if (!m) continue
        const list = liveNames[m[1]] || (liveNames[m[1]] = [])
        if (list.indexOf(m[2]) < 0) list.push(m[2])
        // 顺手把描述记下来：未运行时详情页就有东西可显示，不必再重复「描述暂不可用」。
        const bucket = liveTools[m[1]] || (liveTools[m[1]] = [])
        const desc = typeof s.description === 'string' ? s.description : ''
        if (!bucket.some((t) => t.name === m[2])) bucket.push({ name: m[2], ...(desc ? { description: desc } : {}) })
      }
      // 工具数 = live ∪ 停用表里的单个工具名 ∪ 「已知工具」缓存 —— 未运行的服务器
      // 也能显示最后一次见过的工具数，而不是永远 0。
      const union: Record<string, Set<string>> = {}
      const addTool = (server: string, tool: string) => {
        if (!server || !tool) return
        const set = union[server] || (union[server] = new Set())
        set.add(tool)
      }
      for (const [server, list] of Object.entries(liveNames)) for (const t of list) addTool(server, t)
      for (const [server, list] of Object.entries(disabledMap)) for (const t of list) if (t !== '*') addTool(server, t)
      for (const [server, list] of Object.entries(knownCache)) for (const t of list) addTool(server, t.name)
      for (const [server, set] of Object.entries(union)) {
        toolCounts[server] = set.size
        // 可用数 = 已知工具里未被停用表扣减的（`*` = 整台停用 → 0）。场景档案收窄与
        // 手动逐工具开关写的是同一张停用表，段与页面的「N 个工具」都必须按它扣减，
        // 否则收窄后模型看到的数字比它能调的工具多，页面与详情页也会互相矛盾。
        enabledToolCounts[server] = countEnabledTools(set, disabledMap[server] || [])
      }
      // 真实来源的两个数：只数 `liveNames`（schema 里真正注册了的），再按停用表扣减。
      for (const [server, list] of Object.entries(liveNames)) {
        const set = new Set(list)
        liveToolCounts[server] = set.size
        liveEnabledToolCounts[server] = countEnabledTools(set, disabledMap[server] || [])
      }
      // 「曾经连上过」的证据：缓存里这台 server 见过几个工具。注意读的是**回写之前**的
      // `knownCache` —— 回写会把这次 live 见到的并进去，而这次 live 见到的本来就已经算在
      // liveToolCounts 里了，不需要它来充当"曾经"。
      for (const [server, list] of Object.entries(knownCache)) knownToolCounts[server] = list.length
      // 回写「已知工具」：live 见到的名字与描述并入缓存（有变化才写盘，读路径上的 best-effort）。
      // 名字集合变化，或某个已知工具这次拿到了描述而缓存里没有 → 都算变化。
      let cacheChanged = false
      for (const [server, list] of Object.entries(liveTools)) {
        const prev = knownCache[server] || []
        const byName = new Map(prev.map((t) => [t.name, t] as const))
        for (const tool of list) {
          const old = byName.get(tool.name)
          if (!old) { byName.set(tool.name, tool); cacheChanged = true; continue }
          if (tool.description && old.description !== tool.description) {
            byName.set(tool.name, { ...old, description: tool.description })
            cacheChanged = true
          }
        }
        const next = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        if (next.length !== prev.length) cacheChanged = true
        knownCache[server] = next
      }
      if (cacheChanged) void writeKnownMcpTools(knownCache).catch(() => { /* 侧车写失败不影响列表 */ })
    } catch (e) { /* ignore */ }
    let live: PluginInventoryEntry[] = []
    if (pluginInventory) {
      try {
        const res = await pluginInventory.list()
        live = res.entries.filter((e) => e.moduleName === MCP_CLIENT_MODULE)
      } catch (e) { /* ignore */ }
    }
    for (const e of live) {
      const bid = bareEntryId(e.entryId)
      const found = rows.find((r) => r.id === bid)
      if (found) {
        // **补丁说停用 → 它不可能在运行。** loader 的清单偶尔停在上一帧（用户实测：退出场景后
        // 开关已关、进程已停、AI 也调不到，页面却仍显示「已运行」）——同一个响应里两处矛盾时
        // 以**补丁**为准：开关是真正生效的控制面，显示跟着它走，四者（实际 / 显示 / 开关 / AI）
        // 才一致。反方向的偏差（刚停用、进程还在收尾的几秒）同样由补丁给出的答案兜住。
        found.live = found.disabled
          ? { enabled: false, phase: e.fiberPhase }
          : { enabled: e.enabled, phase: e.fiberPhase }
      } else rows.push({ id: e.entryId, serverName: e.entryId, transport: null, url: null, command: null, args: null, env: null, headers: null, level: 'loader', disabled: !e.enabled, managed: false, live: { enabled: e.enabled, phase: e.fiberPhase } })
    }
    for (const row of rows) {
      if (row.toolCount === undefined) row.toolCount = toolCounts[row.serverName] || 0
      if (row.enabledToolCount === undefined) row.enabledToolCount = enabledToolCounts[row.serverName] || 0
      // 这三个**总是**覆盖：它们描述的是"此刻的真实状态"，而缓存合并出来的那两个数
      // 描述的是"这台 server 有过哪些工具"。两者混淆过一次，代价是注入段谎报可用。
      row.liveToolCount = liveToolCounts[row.serverName] || 0
      row.liveEnabledToolCount = liveEnabledToolCounts[row.serverName] || 0
      row.knownToolCount = knownToolCounts[row.serverName] || 0
    }
    // 列表顺序（用户要求 2026-09-17）：**全局在前、应用级在后**，各级按服务器名排，
    // 当前在跑的 loader 行垫底。放在服务端而不是页面里：同一个顺序也是场景档案勾选器
    // （`scene-inventory`）与模型侧 `mcp_manager_list` 的顺序 —— 三处说同一件事。
    // 名字比较与技能页同一套（localeCompare），大小写混排时不会把大写全顶到前面。
    const levelRank: Record<string, number> = { global: 0, project: 1, loader: 2 }
    const serverNameOf = (row: any) => String(row.serverName || row.id || '')
    rows.sort((a, b) =>
      (levelRank[a.level] ?? 3) - (levelRank[b.level] ?? 3) ||
      serverNameOf(a).localeCompare(serverNameOf(b)) ||
      String(a.id).localeCompare(String(b.id)))
    // A loader id that appears twice (same id in both patch files, or twice in
    // one) makes the composition fail to boot. Surface it instead of hiding it.
    const idCounts = new Map<string, number>()
    for (const row of rows) idCounts.set(String(row.id), (idCounts.get(String(row.id)) || 0) + 1)
    const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
    for (const row of rows) row.duplicate = duplicateIds.indexOf(String(row.id)) >= 0
    const warnings: string[] = []
    if (duplicateIds.length) warnings.push('检测到重复的 loader id（会导致 DSH 无法启动，请手动清理补丁文件）：' + duplicateIds.join('、'))
    // 补丁文件里**已经**是打码占位符的密钥：那说明真值曾经被写坏过（本机 2026-09-18 的
    // `TAVILY_API_KEY` 就是）。主动报出来 —— 不报的话用户只会在下次编辑保存时再次触发
    // 同一个坏结果，而原值已经找不回来了，必须让他知道要去重新填。
    const brokenSecrets = [...new Set(rows.flatMap((row: any) => [
      ...maskedKeysIn(row.env),
      ...maskedKeysIn(row.headers),
    ].map((key) => row.serverName + '.' + key)))]
    if (brokenSecrets.length) warnings.push('这些密钥在补丁文件里已是打码占位符，真实值已丢失，请在编辑里重新填写：' + brokenSecrets.join('、'))
    return {
      ok: true,
      rows,
      paths: { project: p.projectPatch, global: p.globalPatch, home: p.home, profile: p.profileName },
      errors,
      warnings,
    }
  }

  async function mcpmAdd(args: any): Promise<any> {
    const p = await ensurePaths()
    const serverName = String(args.serverName || '').trim()
    const transport = args.transport === 'stdio' ? 'stdio' : 'streamable-http'
    const level = args.level === 'global' ? 'global' : 'project'
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 需为 1-32 位 [A-Za-z0-9_-]' }
    const baseId = 'mcp-' + serverName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const existing = await collectAll()
    if (existing.serverNames.has(serverName)) return { ok: false, error: 'serverName "' + serverName + '" 已存在' }
    let id = baseId
    let n = 2
    while (existing.ids.has(id)) { id = baseId + '-' + n; n++ }
    const row: any = { id, serverName, transport }
    // 新增条目**没有旧值可顶替**，所以打码值一律丢弃（判据与理由见 ./mcp/secret-guard.js）：
    // 谁把打码值粘进表单，都不该让它变成一个占位的"密钥"。
    const guardNotes: string[] = []
    const sanitize = (parsed: Record<string, string>): Record<string, string> => {
      const outcome = resolveMaskedKv(parsed, null)
      const note = describeMaskedOutcome(outcome)
      if (note) guardNotes.push(note)
      return outcome.value
    }
    if (transport === 'streamable-http') {
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//.test(url)) return { ok: false, error: 'url 需为 http(s):// 开头的地址' }
      row.url = url
      row.headers = sanitize(parseKv(args.headers))
    } else {
      const command = String(args.command || '').trim()
      if (!command) return { ok: false, error: 'command 不能为空' }
      row.command = command
      row.args = parseArgs(args.args)
      row.env = sanitize(parseKv(args.env))
    }
    const abs = level === 'global' ? p.globalPatch : p.projectPatch
    return withWriteLock(async () => {
      let content = ''
      try { content = await readPatch(abs) } catch (e) { return { ok: false, error: '读取补丁失败: ' + message(e) } }
      const before = content
      content = appendBlock(content, buildInsertBlock(row))
      // v0.8.5：新增服务器默认不启动（用户裁定，与技能 / 子智能体同口径）；
      // 显式传 enabled: true 才创建即启动。
      const defaultDisabled = args.enabled !== true
      if (defaultDisabled) content = appendBlock(content, buildDisableBlock(id, true))
      const guard = duplicateGuard(before, content)
      if (guard) return guard
      try {
        await writePatch(abs, content)
      } catch (e) {
        return { ok: false, error: '写入补丁失败: ' + message(e) }
      }
      const out: any = { ok: true, row: { ...row, level, disabled: defaultDisabled }, ...(guardNotes.length ? { warning: guardNotes.join('；') } : {}) }
      // 备注跟着新增一起落侧车：**id 只有这里算得出来**（重名会加 `-2` 后缀），留给客户端
      // 补一次 `mcpm-note` 就拿不到最终 id。写失败不回滚已建好的条目，只把失败并进同一条 warning。
      const note = String((args && args.note) == null ? '' : args.note).trim()
      if (note) {
        const noted = await writeNoteUnderLock(id, note)
        if (!noted.ok) out.warning = out.warning ? out.warning + '；' + noted.error : noted.error
      }
      return out
    })
  }

  async function mcpmEdit(args: any): Promise<any> {
    const p = await ensurePaths()
    const id = String(args.id || '')
    const level = args.level === 'global' ? 'global' : 'project'
    if (!id) return { ok: false, error: '缺少 id' }
    const all = await collectAll()
    const cur = all.rows.find((r) => r.id === id)
    if (!cur) return { ok: false, error: '未找到条目 ' + id }
    const serverName = String(args.serverName || '').trim()
    const transport = args.transport === 'stdio' ? 'stdio' : 'streamable-http'
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) return { ok: false, error: 'serverName 需为 1-32 位 [A-Za-z0-9_-]' }
    if (serverName !== cur.serverName && all.serverNames.has(serverName)) return { ok: false, error: 'serverName "' + serverName + '" 已被其他服务占用' }
    const row: any = { id, serverName, transport }
    if (transport === 'streamable-http') {
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//.test(url)) return { ok: false, error: 'url 需为 http(s):// 开头的地址' }
      row.url = url
      row.headers = parseKv(args.headers)
    } else {
      const command = String(args.command || '').trim()
      if (!command) return { ok: false, error: 'command 不能为空' }
      row.command = command
      row.args = parseArgs(args.args)
      row.env = parseKv(args.env)
    }
    const oldAbs = cur.level === 'global' ? p.globalPatch : p.projectPatch
    const newAbs = level === 'global' ? p.globalPatch : p.projectPatch
    // 编辑表单不建模 config 里的全部键：手写补丁可能带 toolCallTimeoutMs 这类字段，
    // 重建前从旧条目原样带回，否则一次「编辑」就把它静默删掉。只透传 buildInsertBlock
    // 已有发射路径的键 —— 其余未知键的保真需要值保持式序列化（裸布尔/数字经
    // unquote/yq 往返会漂成字符串），不在此处理，宁可如实丢弃也不写错类型。
    let curRaw: any = null
    try {
      curRaw = parseRows(await readPatch(oldAbs)).rows.find((r) => r.id === id)
      if (curRaw && curRaw.config && curRaw.config.toolCallTimeoutMs != null) {
        row.toolCallTimeoutMs = curRaw.config.toolCallTimeoutMs
      }
    } catch { /* 旧文件读不了时按建模字段重建，与原行为一致 */ }
    // 打码值**不能入库**：编辑弹窗的密钥框预填的就是打码值（界面拿到的行本身就是打码的），
    // 所以这里必须拿旧真值顶替，否则"改个别的字段再保存"就把真密钥覆盖成 `••••••`
    // —— 本机 2026-09-18 的 `TAVILY_API_KEY` 就是这样丢的。旧文件读不出来时 `curRaw`
    // 为空，走"丢弃"分支，方向仍是安全的（宁可少一个键，也不写一个假值）。
    const guardNotes: string[] = []
    const curConfig: any = (curRaw && curRaw.config) || {}
    const applyGuard = (field: 'env' | 'headers'): void => {
      if (row[field] === undefined) return
      const outcome = resolveMaskedKv(row[field], curConfig[field])
      row[field] = outcome.value
      const note = describeMaskedOutcome(outcome)
      if (note) guardNotes.push(note)
    }
    applyGuard('headers')
    applyGuard('env')
    // URL 的打码形态不是 `••••••` 而是把查询串换成 `<redacted>`（`maskUrlQuery`），
    // `isMaskedValue` 永远认不出来 —— 编辑框预填的同样就是这个形态，所以「改个字段再保存」
    // 会把 URL 里的凭据永久写成占位串（README 承诺「打码值永不入库」，此前 URL 是漏网的
    // 那一条）。没有旧真值可顶替时**拒绝整次保存**：URL 不是可丢的键值对，只删查询串会
    // 留下一个"能连上但鉴权失败"的地址，比报错更难发现。
    if (transport === 'streamable-http') {
      const outcome = resolveMaskedUrl(row.url, curConfig.url)
      if (outcome.unrecoverable) {
        return { ok: false, error: 'URL 里的查询串是打码占位符，而补丁文件里没有原值可恢复：请重新填写完整 URL（含查询串）后再保存。' }
      }
      row.url = outcome.value
      if (outcome.restored) guardNotes.push('URL 未改动，已保留原值')
    }
    const block = buildInsertBlock(row)
    return withWriteLock(async () => {
      // Per-tool disable state is keyed by the serverName namespace: migrate
      // it when a rename moves the tools to a new prefix.
      if (serverName !== cur.serverName) {
        const toolMap = Object.assign({}, await readDisabledTools(true))
        if (toolMap[cur.serverName]) {
          toolMap[serverName] = toolMap[cur.serverName]
          delete toolMap[cur.serverName]
          try { await writeJsonFile(mcpSidecar(MCP_DISABLED_TOOLS_FILE), toolMap) } catch (e) { /* non-fatal */ }
          disabledToolsCache = { at: Date.now(), value: toolMap }
        }
        // F-025：运行时快照的 mcp 停用表同样按 serverName 键 —— 改名不跟着改，
        // 退出场景整体回写时旧键成死键、新名工具的停用状态丢失（回到全启用）。
        try {
          const slice: any = await memoriesService.readArchiveSlice()
          const mode: any = slice && slice.mode
          const mcpMap: any = mode && mode.snapshot && mode.snapshot.mcp
          if (mcpMap && Object.prototype.hasOwnProperty.call(mcpMap, cur.serverName)) {
            const next: any = {}
            for (const [k, v] of Object.entries(mcpMap)) next[k === cur.serverName ? serverName : k] = v
            await memoriesService.patchIndex({ mode: { ...mode, snapshot: { ...mode.snapshot, mcp: next } } })
          }
        } catch { /* 快照同步失败不阻断改名本身；残留与修复前一致 */ }
      }
      if (oldAbs !== newAbs) {
        // Level migration: remove from the old file, insert into the new one.
        // Not atomic, so keep the old content and restore it if the second
        // write fails — losing the entry is worse than a transient dup.
        const origOld = await readPatch(oldAbs)
        let c = origOld
        c = removeEntryAll(c, id)
        try {
          await writePatch(oldAbs, c)
        } catch (e) {
          return { ok: false, error: '写入失败: ' + message(e) }
        }
        let c2 = await readPatch(newAbs)
        const beforeNew = c2
        c2 = appendBlock(c2, block)
        if (cur.disabled) c2 = appendBlock(c2, buildDisableBlock(id, true))
        const migrationGuard = duplicateGuard(beforeNew, c2)
        if (migrationGuard) {
          try { await writePatch(oldAbs, origOld) } catch (e2) { /* best effort */ }
          return migrationGuard
        }
        try {
          await writePatch(newAbs, c2)
        } catch (e) {
          try { await writePatch(oldAbs, origOld) } catch (e2) { /* best effort */ }
          return { ok: false, error: '写入失败（已回滚）: ' + message(e) }
        }
      } else {
        let c = await readPatch(newAbs)
        const before = c
        c = removeEntryAll(c, id)
        c = appendBlock(c, block)
        if (cur.disabled) c = appendBlock(c, buildDisableBlock(id, true))
        const guard = duplicateGuard(before, c)
        if (guard) return guard
        await writePatch(newAbs, c)
      }
      return { ok: true, ...(guardNotes.length ? { warning: guardNotes.join('；') } : {}) }
    })
  }

  async function mcpmSetEnabled(args: any): Promise<any> {
    const p = await ensurePaths()
    const { id, level } = args
    const enabled = !!args.enabled
    if (!id || (level !== 'global' && level !== 'project')) return { ok: false, error: '缺少 id 或 level' }
    if (!(await entryExists(id, level))) return { ok: false, error: '未找到条目 ' + id }
    const abs = level === 'global' ? p.globalPatch : p.projectPatch
    return withWriteLock(async () => {
      let c = await readPatch(abs)
      if (enabled) {
        // Drop every `disabled: true` override for this id. If the insert row
        // itself still says disabled (e.g. user hand-edited it), append an
        // explicit `disabled: false` override so the effective state flips.
        // Enable overrides are intentionally left in place — they are the
        // mechanism that lets a disabled-by-default row be turned on.
        c = removeMarked(c, id, 'disable')
        const { rows } = parseRows(c)
        const row = rows.find((r) => r.id === id)
        if (row && row.disabled) c = appendBlock(c, buildDisableBlock(id, false))
      } else {
        c = removeMarked(c, id, 'enable')
        // 幂等：已经生效为「停用」时不再追加 disable 块。无条件 append 会让每次点
        // 「停用」都往 patch 里塞一条重复条目（历史上 18 条互相矛盾的条目就是这么来的，
        // 最终生效值只能靠 last-wins 合并顺序猜），且文件会随每次启停线性膨胀。
        const { rows } = parseRows(c)
        const row = rows.find((r) => r.id === id)
        if (!row || !row.disabled) c = appendBlock(c, buildDisableBlock(id, true))
      }
      await writePatch(abs, c)
      return { ok: true }
    })
  }

  // Bulk enable/disable for every patch-resident server row. Covers both
  // levels at once, or a single level via args.level. Loader-only rows
  // (never written to a patch file) are out of scope. Each file is rewritten
  // at most once; rows already in the target state are left untouched.
  async function mcpmSetAll(args: any): Promise<any> {
    const p = await ensurePaths()
    const enabled = !!args.enabled
    const levelFilter = args.level === 'global' ? 'global' : args.level === 'project' ? 'project' : null
    return withWriteLock(async () => {
      const changed: string[] = []
      for (const level of ['project', 'global']) {
        if (levelFilter && levelFilter !== level) continue
        const abs = level === 'project' ? p.projectPatch : p.globalPatch
        let c = ''
        try { c = await readPatch(abs) } catch (e) { continue }
        const { rows } = parseRows(c)
        for (const row of rows) {
          if (!!row.disabled === !enabled) continue
          changed.push(row.id)
          if (enabled) {
            c = removeMarked(c, row.id, 'disable')
            const { rows: after } = parseRows(c)
            const still = after.find((r) => r.id === row.id)
            if (still && still.disabled) c = appendBlock(c, buildDisableBlock(row.id, false))
          } else {
            c = removeMarked(c, row.id, 'enable')
            c = appendBlock(c, buildDisableBlock(row.id, true))
          }
        }
        await writePatch(abs, c)
      }
      return { ok: true, enabled, changed }
    })
  }

  /** Effective disabled state of a patch row (insert-row flag merged with override blocks). */
  async function isRowDisabled(id: string, level: string): Promise<boolean> {
    const p = await ensurePaths()
    const abs = level === 'global' ? p.globalPatch : p.projectPatch
    try {
      const { rows } = parseRows(await readPatch(abs))
      const row = rows.find((r) => r.id === id)
      return row ? !!row.disabled : false
    } catch (e) { return false }
  }

  // 重启等 loader 反映新状态的上限与轮询间隔。改上限时告警文案会跟着变（文案用
  // `LOADER_STATE_WAIT_MS / 1000` 拼，不再另写一遍秒数）。
  const LOADER_STATE_WAIT_MS = 5000
  const LOADER_STATE_POLL_MS = 300

  async function mcpmRestart(args: any): Promise<any> {
    const p = await ensurePaths()
    const { id, level } = args
    if (!id || (level !== 'global' && level !== 'project')) return { ok: false, error: '缺少 id 或 level' }
    if (!(await entryExists(id, level))) return { ok: false, error: '未找到条目 ' + id }
    const abs = level === 'global' ? p.globalPatch : p.projectPatch
    // A restart reconnects the server; it must NOT flip the enabled state.
    // The recovery write below used to strip every disable override, which
    // silently re-enabled servers the user had disabled on purpose — so the
    // pre-restart state is captured and restored.
    const wasDisabled = await isRowDisabled(id, level)
    const warnings: string[] = []
    // Phase 1 write (short lock): force-disable. Stale disable overrides are
    // cleared first so duplicate blocks never accumulate.
    await withWriteLock(async () => {
      let c = await readPatch(abs)
      c = removeMarked(c, id, 'enable')
      c = removeMarked(c, id, 'disable')
      c = appendBlock(c, buildDisableBlock(id, true))
      await writePatch(abs, c)
    })
    // 阶段 2 必须**无论中间发生什么都要跑**：阶段 1 已经把服务器写成停用并落盘，
    // 等待窗口里任何一次抛错都会把它永久留在停用态（重启本该是"状态与重启前一致"）。
    // 所以把等待段包进 try/finally，恢复写在 finally 里。
    try {
      if (pluginInventory) {
        const off = await waitFor(async () => {
          const e = await liveEntry(id)
          return e ? e.enabled === false : false
        }, LOADER_STATE_WAIT_MS, LOADER_STATE_POLL_MS)
        if (!off) warnings.push(`loader 未在 ${LOADER_STATE_WAIT_MS / 1000} 秒内停用该服务`)
      }
      await wait(1000)
    } finally {
      // Phase 2 write (short lock): restore the pre-restart state. The polling
      // waits deliberately run OUTSIDE the write lock — holding the global
      // write lock for up to ~11s stalled every other write op.
      await withWriteLock(async () => {
        // 并发护栏：阶段 1 的强制写自身必然把 effective 状态置为停用，所以走到这里时
        // 若读到「已启用」，只可能是等待窗口内别的写操作重新启用了它 —— 以现状为准并
        // 警告，绝不按重启前快照把用户的显式选择改回去。其余情形按 wasDisabled 原样恢复。
        // （已知残留：窗口内被「停用」与阶段 1 的写不可区分，仍按快照恢复 —— 重启语义
        // 本就是「状态与重启前一致」，方向性无害。）
        const currentDisabled = await isRowDisabled(id, level)
        if (!currentDisabled && wasDisabled) {
          warnings.push('重启等待窗口内该服务被重新启用：已保留启用状态，未按重启前状态恢复')
          return
        }
        let c = await readPatch(abs)
        c = removeMarked(c, id, 'disable')
        if (wasDisabled) c = appendBlock(c, buildDisableBlock(id, true))
        await writePatch(abs, c)
      }).catch((e) => {
        warnings.push('恢复重启前状态失败（该服务可能停留在停用态）：' + message(e))
      })
    }
    if (pluginInventory) {
      if (!wasDisabled) {
        const on = await waitFor(async () => {
          const e = await liveEntry(id)
          return e ? e.enabled === true : false
        }, LOADER_STATE_WAIT_MS, LOADER_STATE_POLL_MS)
        if (!on) warnings.push(`loader 未在 ${LOADER_STATE_WAIT_MS / 1000} 秒内重新启用该服务`)
      }
    } else await wait(1500)
    return warnings.length ? { ok: true, warning: warnings.join('；') } : { ok: true }
  }

  async function mcpmRemove(args: any): Promise<any> {
    const p = await ensurePaths()
    const { id, level } = args
    if (!id || (level !== 'global' && level !== 'project')) return { ok: false, error: '缺少 id 或 level' }
    const abs = level === 'global' ? p.globalPatch : p.projectPatch
    return withWriteLock(async () => {
      let c = await readPatch(abs)
      c = removeEntryAll(c, id)
      await writePatch(abs, c)
      return { ok: true }
    })
  }

  /**
   * 收敛补丁文件里的启停覆盖块（用户显式点「整理补丁」才走这里）。
   *
   * 只删"删掉也不改变生效状态"的块（判定见 planOverrideCompaction）：insert 行、
   * 带 config 的覆盖块、以及决定当前生效值的那一条都原样保留。删除前 writePatch
   * 会自动备份上一版（保留最近 5 份），所以这一步是可回退的。
   *
   * 基准状态由 planOverrideCompaction 自己从 insert 行读（另一份文件的内容只用来补
   * "insert 行不在本文件里"的情况）。这里**不要**喂 parseRows() 的 rows —— 那是合并
   * 覆盖块之后的生效值，会让每个 decider 都被判成多余：第一版就是这么把 6 台 MCP
   * 全部启用的。同理，界面不显示任何"多余块数"（那个数字也来自同一条错误口径）。
   */
  async function mcpmCompact(): Promise<any> {
    const p = await ensurePaths()
    return withWriteLock(async () => {
      const levels = ['project', 'global'] as const
      const absOf = (level: string): string => (level === 'project' ? p.projectPatch : p.globalPatch)
      const contents: Record<string, string> = {}
      for (const level of levels) {
        try { contents[level] = await readPatch(absOf(level)) } catch (e) { contents[level] = '' }
      }
      const removed: Record<string, number> = {}
      const files: string[] = []
      let total = 0
      for (const level of levels) {
        const content = contents[level]
        if (!content) continue
        const others = levels.filter((other) => other !== level).map((other) => contents[other]).filter(Boolean)
        const plan = planOverrideCompaction(content, others)
        if (!plan.ranges.length) continue
        await writePatch(absOf(level), spliceRanges(splitLines(content), plan.ranges))
        files.push(absOf(level))
        for (const [id, stat] of Object.entries(plan.ids)) {
          if (!stat.dropped) continue
          removed[id] = (removed[id] || 0) + stat.dropped
          total += stat.dropped
        }
      }
      return { ok: true, removed: total, ids: removed, files }
    })
  }

  async function mcpmExport(): Promise<any> {
    const p = await ensurePaths()
    const list = await mcpmList()
    const rows = (list.rows || []).filter((r: any) => r.level !== 'loader').map((r: any) => ({
      id: r.id,
      serverName: r.serverName,
      transport: r.transport,
      url: r.url || undefined,
      command: r.command || undefined,
      args: r.args || undefined,
      env: r.env || undefined,
      headers: r.headers || undefined,
      level: r.level,
      disabled: r.disabled,
    }))
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), rows }, null, 2)
    let savedTo: string | null = null
    try {
      const abs = mcpSidecar(MCP_EXPORT_FILE)
      await writePatch(abs, json)
      savedTo = abs
    } catch (e) { /* non-fatal */ }
    return { ok: true, json, savedTo }
  }

  async function mcpmImport(args: any): Promise<any> {
    const p = await ensurePaths()
    const overwrite = !!(args && args.conflict === 'overwrite')
    let parsed: any = null
    try { parsed = JSON.parse(String(args.json || '')) } catch (e) { return { ok: false, error: 'JSON 解析失败: ' + message(e) } }
    const entries = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rows) ? parsed.rows : null)
    if (!entries) return { ok: false, error: '导入内容格式不正确：需要数组或 { rows: [...] }' }
    const added: string[] = []
    const overwritten: string[] = []
    const skipped: Array<{ id: string; reason: string }> = []
    // 打码值命中的说明（见 ./mcp/secret-guard.js）：导入的 JSON 可能来自"打码状态下
    // 复制出来的配置"，覆盖模式下更要拿旧真值顶替，否则一次导入就把真密钥换成占位符。
    const importNotes: string[] = []
    // 整批导入持**一次**写锁。原先每条目各持一次、并在锁内重跑 collectAll()：
    //   ① 重扫 = 重新读取并解析两个补丁文件，N 条就是 N 次全量解析（行数多时平方级）；
    //   ② 顺带把「整批导入」变成对其它写者的原子操作，不再允许别的写插到条目之间。
    // 存在性判定仍留在锁内（TOCTOU 的初衷不变），改成从一次性快照增量维护。
    // 注意 withWriteLock **不可重入**（它挂在同一条 writeChain 上），所以循环体里不能再包一层。
    await withWriteLock(async () => {
      const existing = await collectAll()
      // 按 id / serverName 两张表维护同一份快照：覆盖模式会摘掉旧行，两张表必须同步。
      const byId = new Map(existing.rows.map((r) => [r.id, r] as const))
      const byName = new Map(existing.rows.map((r) => [r.serverName, r] as const))
      for (const item of entries) {
        const norm = normalizeImportItem(item)
        if (!norm.ok) { skipped.push({ id: (item && (item.id || item.serverName)) || '?', reason: norm.error }); continue }
        const row = norm.row
        const idTaken = byId.has(row.id)
        const nameTaken = byName.has(row.serverName)
        // 打码值不能入库（判据见 ./mcp/secret-guard.js）：覆盖模式下拿被覆盖条目在补丁里的
        // 旧真值顶替；非覆盖模式没有旧值可比，走"丢弃"分支。
        const prevRow: any = idTaken ? byId.get(row.id) : null
        for (const field of ['env', 'headers'] as const) {
          if (row[field] === undefined) continue
          const outcome = resolveMaskedKv(row[field], prevRow ? prevRow[field] : null)
          row[field] = outcome.value
          const note = describeMaskedOutcome(outcome)
          if (note) importNotes.push(row.serverName + '：' + note)
        }
        // serverName is globally unique: a DIFFERENT id owning the name is
        // always skipped, even in overwrite mode.
        if (nameTaken && !idTaken) { skipped.push({ id: row.id, reason: 'serverName 已存在' }); continue }
        if (idTaken && !overwrite) { skipped.push({ id: row.id, reason: 'id 已存在' }); continue }
        // Overwrite: purge every trace of the id from BOTH patch files first,
        // then insert the imported row at its own level. The purge is not
        // atomic with the insert, so keep the pre-purge content of both files
        // and restore it when the insert fails — same trade-off as mcpmEdit's
        // level migration: losing the old entries is worse than a transient dup.
        const origs: Array<{ abs: string; content: string }> = []
        let purgeFailed = false
        if (idTaken && overwrite) {
          for (const lvl of ['project', 'global']) {
            const lAbs = lvl === 'global' ? p.globalPatch : p.projectPatch
            let lContent = ''
            try { lContent = await readPatch(lAbs) } catch (e) { continue }
            origs.push({ abs: lAbs, content: lContent })
            try {
              await writePatch(lAbs, removeEntryAll(lContent, row.id))
            } catch (e) {
              // 前面已清掉的文件也要恢复：purge 中途失败同样不能留下「旧条目没了」的状态。
              for (const o of origs) { try { await writePatch(o.abs, o.content) } catch { /* best effort */ } }
              skipped.push({ id: row.id, reason: '覆盖旧条目失败（已回滚）: ' + message(e) })
              purgeFailed = true
              break
            }
          }
        }
        if (purgeFailed) continue
        const abs = row.level === 'global' ? p.globalPatch : p.projectPatch
        try {
          let c = await readPatch(abs)
          const before = c
          c = appendBlock(c, buildInsertBlock(row))
          if (row.disabled) c = appendBlock(c, buildDisableBlock(row.id, true))
          const guard = duplicateGuard(before, c)
          if (guard) {
            for (const o of origs) { try { await writePatch(o.abs, o.content) } catch { /* best effort */ } }
            skipped.push({ id: row.id, reason: guard.error })
            continue
          }
          await writePatch(abs, c)
        } catch (e) {
          for (const o of origs) { try { await writePatch(o.abs, o.content) } catch { /* best effort */ } }
          skipped.push({ id: row.id, reason: '写入失败（已回滚）: ' + message(e) })
          continue
        }
        // 增量维护快照：后面的条目必须看得见刚写进去的这一行（覆盖模式下旧行已从两个文件里清掉，
        // 它的 serverName 也要从表里摘掉，否则「换个名字覆盖」会被误判成 serverName 已存在）。
        const prev = byId.get(row.id)
        if (prev) byName.delete(prev.serverName)
        byId.set(row.id, row)
        byName.set(row.serverName, row)
        added.push(row.id)
        if (idTaken && overwrite) overwritten.push(row.id)
      }
    })
    const notes = importNotes.length ? { warning: importNotes.join('；') } : {}
    return overwrite ? { ok: true, added, overwritten, skipped, ...notes } : { ok: true, added, skipped, ...notes }
  }

  function parseKv(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    String(text || '').split(/\r?\n/).forEach((line) => {
      const t = line.trim()
      if (!t || t.startsWith('#')) return
      const i = t.indexOf('=')
      if (i <= 0) return
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
    })
    return out
  }
  function parseArgs(text: string): string[] {
    return String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '')
  }
  /**
   * 写停用表。**顺序照搬**原 index.ts 里 archiveService.applyMcpEntries 的那四步：
   * 先确保目录、再在写锁下落盘、然后更新 TTL 缓存、最后重排工具可见性。
   * 顺序有意义：缓存必须在落盘成功之后才更新（失败时不能留下"已生效"的假象）。
   */
  async function writeDisabledTools(entries: Record<string, string[]>): Promise<void> {
    await deps.ensurePaths()
    await deps.withWriteLock(async () => {
      await writeJsonFile(mcpSidecar(MCP_DISABLED_TOOLS_FILE), entries)
    })
    disabledToolsCache = { at: Date.now(), value: entries }
    scheduleToolRestrictions()
  }

  /**
   * 读-改-写备注，整段在写锁内。调用方只给"怎么改"（场景档案按 serverName 存的映射
   * 由它自己决定），避免把引擎的映射规则搬进本文件。
   */
  async function updateNotes(mutate: (map: Record<string, string>) => void): Promise<void> {
    await deps.withWriteLock(async () => {
      const map = Object.assign({}, await readNotes(true))
      mutate(map)
      await deps.ensurePaths()
      await writeJsonFile(mcpSidecar(MCP_NOTES_FILE), map)
      notesCache = { at: Date.now(), value: map }
    })
  }

  /** 启动预热（原 index.ts 的 readDisabledTools().then(applyToolRestrictions)，错误由调用方吞）。 */
  async function warmUp(): Promise<void> {
    await readDisabledTools()
    await applyToolRestrictions()
  }

  /** 卸载清理（原 index.ts 的 cleanup effect 正文）。 */
  function dispose(): void {
    if (restrictTimer) { clearTimeout(restrictTimer); restrictTimer = null }
    // 插件卸载时把挂在每个 agent scope 上的限制都撤掉（否则那些 scope 会继续背着一层名单）。
    epoch += 1
    for (const agent of [...agentRestrictions.keys()]) liftRestriction(agent)
    appliedByAgent.clear()
    seenAgents.clear()
  }


  return {
    stateCatalog: mcpStateCatalog,
    ops: {
      'mcpm-list': mcpmListView,
      'mcpm-reveal': mcpmReveal,
      'mcpm-note': mcpmNote,
      'mcpm-settings': mcpmSettings,
      'mcpm-tool-enabled': mcpmToolEnabled,
      'mcpm-tools': mcpmTools,
      'mcpm-tools-refresh': mcpmToolsRefresh,
      'mcpm-add': mcpmAdd,
      'mcpm-edit': mcpmEdit,
      'mcpm-set-enabled': mcpmSetEnabled,
      'mcpm-set-all': mcpmSetAll,
      'mcpm-restart': mcpmRestart,
      'mcpm-remove': mcpmRemove,
      'mcpm-compact': mcpmCompact,
      'mcpm-export': mcpmExport,
      'mcpm-import': mcpmImport,
    },
    readDisabledTools,
    readKnownMcpTools,
    readNotes,
    writeDisabledTools,
    updateNotes,
    mcpmListView,
    mcpmRowsWithNotes,
    readPluginSettings,
    isToolDisabled: (name: string) => isToolDisabledIn(disabledToolsCache ? disabledToolsCache.value : {}, name),
    /** 停用表里的工具条数（读 TTL 缓存；功能总览用）。 */
    disabledToolCount: () => {
      const map = disabledToolsCache ? disabledToolsCache.value : {}
      let n = 0
      for (const list of Object.values(map)) n += Array.isArray(list) ? list.length : 0
      return n
    },
    warmUp,
    scheduleToolRestrictions,
    attachAgent,
    detachAgent,
    dispose,
  }
}
