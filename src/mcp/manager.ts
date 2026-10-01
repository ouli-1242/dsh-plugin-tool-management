// MCP 管理域 —— 侧车读写（备注 / 设置 / 停用表）+ 补丁文件行编辑 + 17 个 op 的实现。
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
// 配置体检查 PATH 用（见 mcpmInspect）：execFile 不走 shell，参数是数组 —— 体检只查询
// 命令名，**绝不执行**配置里的命令本身。
import { execFile } from 'node:child_process'
import { MCP_CLIENT_MODULE, MCP_TOOL_PREFIX, ambiguousServerNames, looksLikeMcpPrefixDrift, serverNameCandidates, splitMcpToolName } from '../host-names.js'
import { hubPath } from '../hub.js'
import { planOverrideCompaction } from './override-blocks.js'
// 配置体检的探测（PATH 查询 / 端点连通性 / 检查清单 + mcpm-inspect op），2026-10-01 剥出。
import { createInspectProbe } from './inspect-probe.js'
import { createMcpStateCatalog, type McpStateCatalog } from './state-section.js'
import { createToolVisibility } from './tool-visibility.js'
import {
  appendBlock, buildDisableBlock, buildInsertBlock, insertEntryIds, parseRows, removeEntryAll, removeMarked,
  spliceRanges, splitLines, type ManagedRow,
} from './patch-yaml.js'
import { describeMaskedOutcome, maskSecretValue, maskUrlQuery, maskedKeysIn, resolveMaskedKv, resolveMaskedUrl } from './secret-guard.js'

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
  /** 记忆服务：mcpm-edit 要把停用表写进当前模式的快照；mcpm-remove 清场景引用时用它避开被锁场景。 */
  memoriesService: {
    readArchiveSlice(): Promise<any>
    patchIndex(slice: any): Promise<any>
    /** 场景锁定态（场景名 → 是否被锁）；缺席（旧装配）时按"没有场景被锁"处理。 */
    sceneLocks?(): Promise<Record<string, boolean>>
  }
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
  /**
   * 已配置的 serverName 名单（补丁文件里的**真实**名字；只读补丁，不枚举工具 schema）。
   *
   * 存在的理由（2026-09-30 审查 N1 / R3）：切分 `mcp__<server>__<tool>` 需要一个候选
   * serverName 集合，而另外两个来源都是**插件自己写出来的** —— 停用表的键来自界面勾选、
   * 已知工具缓存的键来自上一次切分。拿它们当候选是循环论证：一旦切错，错键进集合，下次照旧
   * 切错，**且不自愈**。补丁里的 `serverName` 是宿主真正用来拼 `mcp__${publicName}__${name}`
   * 的那一份，是唯一与切分结果无关的来源。
   */
  configuredServerNames(): Promise<string[]>
  /** 列表行（mask=false 时**含明文凭据**，只有注入侧该用 false 那份）。 */
  mcpmRowsWithNotes(mask: boolean): Promise<any[]>
  /** 插件设置（轮询间隔 / 描述长度上限 / 两个确认开关）。 */
  readPluginSettings(force?: boolean): Promise<{ pollIntervalMs: number; toolDescriptionMaxLength: number; requireConfirmForModelRuleWrite: boolean; requireConfirmForModelSubagentRun: boolean }>
  /** 某工具全名是否在停用表里（读 TTL 缓存，无 I/O —— 工具门禁在热路径上）。 */
  isToolDisabled(name: string): boolean
  /** 停用表的两个口径（读 TTL 缓存；功能总览用）：整台停用的服务器数（`*`）与单独停用的工具数。 */
  disabledToolSummary(): { servers: number; tools: number }
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
export interface KnownMcpTool {
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


/**
 * 单工具停用判定（含整服务器通配 `*`——场景档案的"MCP 工具集=整台"写的就是它）。
 *
 * 切分走 `splitMcpToolName`（`host-names.ts`）—— **全插件唯一的一套切分规则**（2026-09-30 审查 N1）。
 *
 * 改之前的两代口径（免得下次又退回老路）：
 *   * 0.16.6 及以前用 `indexOf('__')`（取**第一个**）：serverName 含 `__` 时被截成 `a` → 查表
 *     未命中 → **返回 false（不拦）** → 被停用的工具仍可调用。这是**执行侧**守卫失效，不只是
 *     显示问题：调用链是 `tools.guard`（`index.ts`）→ `mcp.isToolDisabled`（本文件的出口，
 *     喂的就是本函数），而文件头承诺 disabled = invisible AND uncallable。
 *   * 0.16.7 改成「最长已知 serverName 前缀匹配」（候选 = 停用表的键），守卫这一侧修对了；但
 *     显示侧（`index.ts` 的 `toolKeyParts`）当时改成了「取最后一个 `__`」——**两套规则并存**，
 *     于是「工具名含 `__`」时守卫与界面键仍会给出不同的 `(server, tool)`。
 *   * 现在两侧共用 `splitMcpToolName`（最长候选命中，一个都不命中才退回最后一个 `__`）。
 *
 * 候选集合取**停用表的键**，不是「全部已配置服务器」—— 理由见 `splitMcpToolName` 的文档：
 * 设 `a` 的 `b__c` 被停用、而 `a__b` 只是配置了、没停用任何工具，全名 `mcp__a__b__c` 在放宽后
 * 最长匹配取 `a__b`（tool 只剩 `c`）→ 查 `a__b` 未命中 → **放行一个真的被停用的工具**
 * （fail-open）。候选只有 `{a}` 时切出 `a`/`b__c` → 命中 → 拦住。
 * 歧义时偏向「停用表里有的那个服务器」才是守卫该有的方向。
 *
 * 本函数是**纯函数**（不读闭包状态），因此提到模块作用域并导出：既是"两侧同源"的可测接缝，
 * 也让 `createMcpManager` 不再需要为它保留一个闭包内定义。
 */
export function isToolDisabledIn(map: Record<string, string[]>, fullName: string): boolean {
  const parts = splitMcpToolName(fullName, Object.keys(map))
  if (parts === null) return false
  const list = map[parts.server]
  if (!list) return false
  if (list.indexOf('*') >= 0) return true
  return list.indexOf(parts.tool) >= 0
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
    // 扫**全部** insert 子条目的 id，不只 MCP 行（2026-09-30 审查 P1-5）。原实现走
    // `parseRows`，而它只收 `name === MCP_CLIENT_MODULE` 的行 —— 于是导入一条非 MCP 的
    // loader（例如 `{"id":"dsh-plugin-tool-management", ...}`）能撞出第二条同 id 条目，
    // 守卫看不见、直接 `appendBlock` 落盘。而按本仓一贯记载（`:229-231`），同 id 的两条
    // insert 会让插件组装失败、**DSH 下次起不来**。这个约束对任何 loader 都成立。
    for (const id of insertEntryIds(content)) counts.set(id, (counts.get(id) || 0) + 1)
    return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
  }
  function duplicateGuard(before: string, after: string): { ok: false; error: string } | null {
    const known = new Set(duplicateIdsOf(before))
    const introduced = duplicateIdsOf(after).filter((id) => !known.has(id))
    if (!introduced.length) return null
    return { ok: false, error: '写入会产生重复的 loader id（重复 id 会导致 DSH 无法启动）：' + introduced.join('、') }
  }

  // ---------- shared state ----------
  async function collectAll(): Promise<{ ids: Set<string>; serverNames: Set<string>; rows: Array<{ id: string; serverName: string; level: string; disabled: boolean; config: Record<string, unknown> }> }> {
    const p = await ensurePaths()
    const ids = new Set<string>()
    const serverNames = new Set<string>()
    const rows: Array<{ id: string; serverName: string; level: string; disabled: boolean; config: Record<string, unknown> }> = []
    for (const level of ['project', 'global']) {
      const abs = level === 'project' ? p.projectPatch : p.globalPatch
      let content = ''
      try { content = await readPatch(abs) } catch (e) { continue }
      const { rows: fileRows } = parseRows(content)
      for (const r of fileRows) {
        ids.add(r.id)
        const sn = r.config && r.config.serverName ? String(r.config.serverName) : r.id
        serverNames.add(sn)
        // `config` 一并带出（2026-09-30 审查 F4）：`mcpm-import` 的覆盖模式要靠它拿**旧真值**
        // 顶替表单里的打码值（URL 的 userinfo/查询串/片段、env/headers 的整串 `•`）。
        // 此前这里只带 id/serverName/level/disabled，于是 `prevRow.url` 恒为 `undefined` ——
        // 覆盖模式也走"没有原值"分支，把打码值丢弃并报一句"没有原值可保留"（诊断也是错的）。
        rows.push({ id: r.id, serverName: sn, level, disabled: !!r.disabled, config: (r.config || {}) as Record<string, unknown> })
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

  // ---------- per-tool enable/disable + 可见性半边 → ./tool-visibility.ts ----------
  // 那 294 行整段搬进同目录模块，靠 deps 拿这里的闭包名字（侧车读写、写锁、tools 服务、
  // 三个侧车常量），所以母文件这一段只剩接线。
  // 唯一被块外改写的状态是停用表缓存：改名迁移、删台、整表回写三处写它，出口两处同步读它
  // （isToolDisabled / disabledToolSummary）—— 于是块交回两个句柄，语义与原样一致：
  // setDisabledToolsCache(x) ≡ `disabledToolsCache = { at: Date.now(), value: x }`，
  // disabledToolsSnapshot() ≡ `disabledToolsCache ? disabledToolsCache.value : {}`。
  const {
    readDisabledTools, readKnownMcpTools, writeKnownMcpTools, mutateKnownMcpTools, mergeLiveToolsInto,
    mcpmToolEnabled, applyToolRestrictions, scheduleToolRestrictions, attachAgent, detachAgent,
    setDisabledToolsCache, disabledToolsSnapshot, disposeVisibility,
  } = createToolVisibility({
    readJsonFile, writeJsonFile, ensurePaths, withWriteLock, message, tools,
    pluginHiddenTools: deps.pluginHiddenTools, carrierHiddenTools: deps.carrierHiddenTools,
    normalizeKnownTools, mcpSidecar, SIDECAR_TTL_MS, MCP_DISABLED_TOOLS_FILE, MCP_KNOWN_TOOLS_FILE,
  })

  function truncateText(value: string, limit: number): string {
    if (!limit || value.length <= limit) return value
    return value.slice(0, Math.max(1, limit - 1)).replace(/\s+$/, '') + '…'
  }

  // ---------- secret masking (UI view only) ----------
  // Only sensitive-looking keys are masked; `$VAR` / `!!js` references are
  // indirections rather than secrets, so they stay readable. URL query strings
  // are redacted because MCP credentials often ride there.
  const SENSITIVE_KEY_RE = /(token|secret|password|passwd|auth|credential|api[_-]?key|access[_-]?key|private[_-]?key|cookie|session|signature|bearer)/i
  // 单值打码（`maskSecretValue`）与 URL 打码（`maskUrlQuery`）都挪到 ./secret-guard.js ——
  // 那里是这两条形态的唯一口径，使用方现在有三个（本文件的列表视图 + index.ts 的确认卡
  // + ops/snapshot.ts 的整机迁移导出）。此处不再自建一份。
  function maskValueMap(map: Record<string, string> | null, onlySensitiveKeys: boolean): Record<string, string> | null {
    if (!map || typeof map !== 'object') return map
    const out: Record<string, string> = {}
    for (const key of Object.keys(map)) {
      out[key] = (!onlySensitiveKeys || SENSITIVE_KEY_RE.test(key)) ? maskSecretValue(map[key]) : String(map[key])
    }
    return out
  }
  // `maskUrlQuery` 已挪到 ./secret-guard.js：那里是两条打码形态的唯一口径，而使用方
  // 现在有三个（本文件的列表视图 + index.ts 的确认卡 + ops/snapshot.ts 的整机迁移导出）。
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
    const prefix = MCP_TOOL_PREFIX + serverName + '__'
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
                // 读-改-写整段在写锁内（审查 P2-15）：轮询路径也在回写同一份侧车，
                // 锁外两步会互相覆盖。合并规则（保留旧的描述、新的描述优先）与轮询路径同源。
                await mutateKnownMcpTools((cache) => {
                  const byName = new Map((cache[serverName] || []).map((item) => [item.name, item] as const))
                  for (const item of known) {
                    const old = byName.get(item.name)
                    byName.set(item.name, old && old.description && !item.description ? old : { ...old, ...item })
                  }
                  cache[serverName] = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
                  return true
                })
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

  /**
   * 已配置的 serverName 名单 —— 只读补丁 + `parseRows`，**不枚举工具 schema、不回写任何缓存**。
   *
   * 与 `configuredServers`（index.ts 的档案引擎依赖）取的是同一份东西，但那个走
   * `mcpmListView()` → `mcpmList()`，会顺带枚举 schema 并回写「已知工具」缓存；切分的候选集合
   * 只需要名字，不该付那份代价与副作用。顺序与 `mcpmList` 一致（project → global）。
   */
  async function configuredServerNames(): Promise<string[]> {
    const p = await ensurePaths()
    const out: string[] = []
    for (const level of ['project', 'global']) {
      const abs = level === 'project' ? p.projectPatch : p.globalPatch
      let content = ''
      // 读不到某个层级就当它没有条目（与 `mcpmList` 的处理一致：记进 errors 但不影响另一层）。
      try { content = await readPatch(abs) } catch (e) { continue }
      for (const r of parseRows(content).rows) {
        const n = String(normalizeRow(r, level, abs).serverName || '')
        if (n && out.indexOf(n) < 0) out.push(n)
      }
    }
    return out
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
      // 切分走 `splitMcpToolName` —— 与执行侧守卫、界面勾选键**同一套规则**（2026-09-30 审查 N1）。
      //
      // 这里以前是贪婪正则 `^mcp__([A-Za-z0-9_-]+)__(.+)$`（等价于"取最后一个 `__`"）。它不只是
      // 第三套规则：它算出的键就是 `mcp-known-tools.json` 的键，而那个缓存又会被显示侧当候选集合
      // 读回去 —— 规则不一致会**自证**（切错的键进候选，越切越错），所以必须一起换掉。
      //
      // 候选集合取补丁里的真实 serverName ∪ 停用表键 ∪ 已知缓存键：`rows` 来自补丁，是唯一与切分
      // 结果无关的来源；另两份是插件自己写出来的（见 `configuredServerNames` 的文档）。
      const splitCandidates = serverNameCandidates(
        rows.map((r: any) => String((r && r.serverName) || '')).filter(Boolean),
        disabledMap,
        knownCache,
      )
      // 前缀漂移的线索（审查 §5 F6）：判据与理由见 `host-names.ts` 的
      // `looksLikeMcpPrefixDrift` —— 关键是**排除 `mcp_` 开头的那一族**（本插件自己的
      // `mcp_manager_*` 就在里面，不排除的话这条上报每台机器都会误报）。
      const mcpStemOther: string[] = []
      for (const s of schemas) {
        const fullName = String(s && s.name || '')
        if (seen.has(fullName)) continue
        seen.add(fullName)
        if (looksLikeMcpPrefixDrift(fullName) && mcpStemOther.length < 3) mcpStemOther.push(fullName)
        const parts = splitMcpToolName(fullName, splitCandidates)
        // serverName 的合法形态与 `mcpm-set-tool-enabled` / `mcpm-edit` 的校验同口径：不合法的一律
        // 不进表（旧正则的 `[A-Za-z0-9_-]+` 就是这个意思，这里保留，免得凭空多出服务器行）。
        if (!parts || !/^[A-Za-z0-9_-]{1,32}$/.test(parts.server)) continue
        const list = liveNames[parts.server] || (liveNames[parts.server] = [])
        if (list.indexOf(parts.tool) < 0) list.push(parts.tool)
        // 顺手把描述记下来：未运行时详情页就有东西可显示，不必再重复「描述暂不可用」。
        const bucket = liveTools[parts.server] || (liveTools[parts.server] = [])
        const desc = typeof s.description === 'string' ? s.description : ''
        if (!bucket.some((t) => t.name === parts.tool)) bucket.push({ name: parts.tool, ...(desc ? { description: desc } : {}) })
      }
      // 前缀契约的 inform-only 上报（审查 §5 F6）：宿主面上出现了词根后换了分隔符的 `mcp*` 工具名，
      // 同时按本插件认的前缀一条都筛不出来 —— 大概率官方改了 MCP 工具的命名前缀。这时停用表 /
      // 执行侧门禁 / 工具计数会**一起静默失明**（守卫认为"这工具不在我的表里"，于是放行），
      // 而这是纯字符串契约、没有能力探测能提前发现。
      // 证据门槛刻意收紧（见上）：`mcp_` 开头的一族不算证据，且要**至少两个**同名根的工具
      // （改前缀会重命名全部 MCP 工具，孤零零一个像模像样的名字不足为凭）。条件不成立就清掉，
      // 避免陈旧告警。
      if (mcpStemOther.length >= 2 && Object.keys(liveNames).length === 0) {
        noteRuntime({
          id: 'mcp-tool-prefix',
          label: 'MCP 工具命名前缀',
          kind: 'read',
          fallback: 'inform-only',
          detail: `宿主工具表里有多个以 mcp 开头、但用的不是 \`${MCP_TOOL_PREFIX}\` 的工具名（如 ${mcpStemOther.join('、')}），而按本插件认的前缀一条都筛不出来：官方可能改了 MCP 工具的命名前缀。此时停用表、执行侧门禁与工具计数都会失明（守卫会放行它以为"不在表里"的工具）。`,
          detailKey: 'mcp-tool-prefix.mismatch',
          params: { prefix: MCP_TOOL_PREFIX, samples: mcpStemOther.join('、') },
        })
      } else {
        clearRuntimeNote('mcp-tool-prefix')
      }
      // 命名歧义的 inform-only 上报（2026-09-30 审查 N2）：`mcp__<server>__<tool>` 这个契约
      // 对 `__` 本身有歧义，而 `serverName` 的校验（`/^[A-Za-z0-9_-]{1,32}$/`）**允许含 `__`**。
      // 两种形状会让切分变成"猜"：① 某个 serverName 自己含 `__`；② 两个 serverName 互为 `__`
      // 前缀（`a` 与 `a__b`）—— 全名 `mcp__a__b__c` 两种归属都讲得通。
      //
      // **只上报、不改行为**：改校验会把存量服务器从"能管"变成"管不了"（计划 §4 未决 1 的
      // 裁定），而这里要的只是"切不准时出声"。判据本身保证没有这两种形状时一条都不报
      // （`ambiguousServerNames`），条件不成立就清掉，避免陈旧告警 —— 与上面那条同一条纪律。
      // 两条互斥、取**更具体**的那条，永远只出一行：
      // 「互为前缀」必然蕴含「含 `__`」（长的那半就是 `短名 + '__' + 余下`），两条一起报
      // 就是同一件事说两遍。而「互为前缀」更具体 —— 它直接点名了是哪两个名字撞在一起。
      // 反过来「含 `__`」能覆盖"一个前缀对都凑不成"的单名字情形。两边都不成立就都清掉。
      const ambiguous = ambiguousServerNames(splitCandidates)
      const prefixPairs = ambiguous.prefixPairs.map(([a, b]) => `${a} / ${b}`).join('、')
      if (ambiguous.prefixPairs.length) {
        noteRuntime({
          id: 'mcp-server-name-ambiguous',
          label: 'MCP 服务器名互为 `__` 前缀',
          kind: 'read',
          fallback: 'inform-only',
          detail: `这些 MCP 服务器名互为 \`__\` 前缀关系（${prefixPairs}）：例如 \`mcp__a__b__c\` 既可以读成 \`a\` 的 \`b__c\`，也可以读成 \`a__b\` 的 \`c\`，界面上的勾选可能落不到停用表里那条键上（工具本身照常可用）。改名可消除；不改也能用。`,
          detailKey: 'mcp-server-name-ambiguous.prefix',
          params: { pairs: prefixPairs },
        })
      } else if (ambiguous.withSeparator.length) {
        noteRuntime({
          id: 'mcp-server-name-ambiguous',
          label: 'MCP 服务器名含 `__`',
          kind: 'read',
          fallback: 'inform-only',
          detail: `这些 MCP 服务器名里含 \`__\`（${ambiguous.withSeparator.join('、')}）：工具全名 \`mcp__<server>__<tool>\` 因此切不唯一，界面上的勾选可能落不到停用表里那条键上（工具本身照常可用）。改名可消除；不改也能用。`,
          detailKey: 'mcp-server-name-ambiguous.separator',
          params: { names: ambiguous.withSeparator.join('、') },
        })
      } else {
        clearRuntimeNote('mcp-server-name-ambiguous')
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
      // 先在本地这份上跑一遍只为**判断要不要写盘**；真正落盘的那次合并发生在锁内、对象是
      // 刚读出来的新鲜表（审查 P2-15：临时启动路径也在写同一份侧车，锁外两步会互相覆盖）。
      const cacheChanged = mergeLiveToolsInto(knownCache, liveTools)
      if (cacheChanged) void mutateKnownMcpTools((fresh) => mergeLiveToolsInto(fresh, liveTools)).catch(() => { /* 侧车写失败不影响列表 */ })
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
      // 新增条目**没有旧值可顶替** —— 打码 URL 一律拒绝，让用户重填完整地址（判据见
      // ./mcp/secret-guard.js）。原来这里直接 `row.url = url`，于是「把列表里那条打码 URL
      // 复制到新增表单」就会把凭据永久写成 `%3Credacted%3E`，界面还显示成功（审查 F4）。
      const urlGuard = resolveMaskedUrl(url, null)
      if (urlGuard.unrecoverable) {
        return { ok: false, error: 'URL 里的 userinfo / 查询串 / 片段是打码占位符（新增条目没有原值可恢复）：请重新填写完整 URL 后再保存。' }
      }
      row.url = urlGuard.value
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
          setDisabledToolsCache(toolMap)
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

  /** 一份补丁内容里某个 id 的**生效**启停值（insert 行自带的 flag 与顶层覆盖块合并后）。 */
  function effectiveDisabledIn(content: string, id: string): boolean {
    const row = parseRows(content).rows.find((r) => r.id === id)
    return row ? !!row.disabled : false
  }

  /** Effective disabled state of a patch row (insert-row flag merged with override blocks). */
  async function isRowDisabled(id: string, level: string): Promise<boolean> {
    const p = await ensurePaths()
    const abs = level === 'global' ? p.globalPatch : p.projectPatch
    try {
      return effectiveDisabledIn(await readPatch(abs), id)
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
        c = removeMarked(c, id, 'enable')
        // 覆盖块全删掉之后，生效值**回落**到 insert 行自带的 `disabled:`，而它与「重启前的
        // 生效状态」不一定相同 —— insert 行写着 `disabled: true`、靠一条 enable 覆盖块启用，
        // 就是这种形状。此前只在 `wasDisabled` 为真时补一条 disable，于是这种形状下重启会把
        // 服务器**留在停用态**（2026-09-30 审查 P2-11）。所以这里比一次：不等就按 `wasDisabled`
        // 显式补一条覆盖；相等就不补 —— 补了会让每次重启都往补丁里多留一个块，没必要。
        if (effectiveDisabledIn(c, id) !== wasDisabled) c = appendBlock(c, buildDisableBlock(id, wasDisabled))
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
    const removedScenes: string[] = []
    const skippedLockedScenes: string[] = []
    await withWriteLock(async () => {
      // serverName 在锁内取：场景档案（mcp / mcpNotes）与两张工具侧车表都按它键，
      // 补丁条目 id 是另一套；锁外读会和并发写竞态。
      const known = (await collectAll()).rows.find((r) => r.id === id)
      const serverName = known ? known.serverName : ''
      let c = await readPatch(abs)
      c = removeEntryAll(c, id)
      await writePatch(abs, c)
      // ── 同步清引用（best-effort，口径与 mcpm-edit 的改名同步一致）─────────────
      // 只删补丁行的话，引用它的档案/侧车全是死键：场景页会显示一台不存在的服务器，
      // 进/退场景还会去切换一个空条目；界面上则短暂残留宿主 loader 的 include:* 行。
      if (serverName) {
        try {
          const slice: any = await memoriesService.readArchiveSlice()
          let mode = slice.mode
          // 运行时快照的 mcp 同样按 serverName 键：进场景时引擎按它关停/恢复，
          // 死键会在退场景回写时被无害地跳过 —— 但删了就该摘，与改名的 F-025 同口径。
          const snapMcp = mode && mode.snapshot && mode.snapshot.mcp
          if (snapMcp && Object.prototype.hasOwnProperty.call(snapMcp, serverName)) {
            const rest = Object.assign({}, snapMcp)
            delete rest[serverName]
            mode = Object.assign({}, mode, { snapshot: Object.assign({}, mode.snapshot, { mcp: rest }) })
          }
          // 场景档案：被**锁定**的场景档案是用户显式冻结的，跳过并如实上报，
          // 不绕开门禁偷偷写；解锁后重新保存一次档案即可清掉死键。
          let locks: Record<string, boolean> = {}
          try {
            if (typeof memoriesService.sceneLocks === 'function') locks = (await memoriesService.sceneLocks()) || {}
          } catch { /* 锁态读不到时按未锁处理，与修复前的行为一致 */ }
          const archives: Record<string, any> = {}
          let archivesTouched = false
          for (const [name, archive] of Object.entries(slice.archives || {})) {
            const a: any = archive || {}
            const hasMcp = !!(a.mcp && Object.prototype.hasOwnProperty.call(a.mcp, serverName))
            const hasNote = !!(a.mcpNotes && Object.prototype.hasOwnProperty.call(a.mcpNotes, serverName))
            if (!hasMcp && !hasNote) { archives[name] = archive; continue }
            if (locks[name] === true) { skippedLockedScenes.push(name); archives[name] = archive; continue }
            const copy: any = Object.assign({}, a)
            if (hasMcp) {
              const rest = Object.assign({}, a.mcp)
              delete rest[serverName]
              copy.mcp = rest
            }
            if (hasNote) {
              const rest = Object.assign({}, a.mcpNotes)
              delete rest[serverName]
              // mcpNotes 全空 → null：与档案保存（"全空 = 未定义"）同一口径。
              copy.mcpNotes = Object.keys(rest).length ? rest : null
            }
            archives[name] = copy
            archivesTouched = true
            removedScenes.push(name)
          }
          if (archivesTouched || mode !== slice.mode) {
            const patch: any = {}
            if (archivesTouched) patch.archives = archives
            if (mode !== slice.mode) patch.mode = mode
            await memoriesService.patchIndex(patch)
          }
        } catch { /* 清理失败不拦删除本身；死键无行为影响，与修复前一致 */ }
        try {
          // 停用表与「已知工具」也按 serverName 键：整台没了，键留着只会喂出错的口径
          // （补集里多出一台永远凑不上的服务器的旧工具名）。
          const toolMap = Object.assign({}, await readDisabledTools(true))
          if (Object.prototype.hasOwnProperty.call(toolMap, serverName)) {
            delete toolMap[serverName]
            await writeJsonFile(mcpSidecar(MCP_DISABLED_TOOLS_FILE), toolMap)
            setDisabledToolsCache(toolMap)
            await applyToolRestrictions()
          }
          const knownMap = Object.assign({}, await readKnownMcpTools(true))
          if (Object.prototype.hasOwnProperty.call(knownMap, serverName)) {
            delete knownMap[serverName]
            await writeKnownMcpTools(knownMap)
          }
        } catch { /* non-fatal */ }
        try {
          // 备注按 loader id 键：条目删了备注就该走（writeNoteUnderLock 约定在写锁内调用）。
          await writeNoteUnderLock(id, '')
        } catch { /* non-fatal */ }
      }
    })
    // 等 loader 把条目摘掉。等待放在**写锁外**（同 mcpm-restart：锁内等待会卡住其他写）。
    // 宿主清单偶尔停在上一帧，等不到**不算失败** —— 补丁条目确实已经删了，宿主侧收敛有
    // 自己的节奏；但要说出来，否则用户对着残留的 include:* 行只会以为插件没删干净。
    const warnings: string[] = []
    if (pluginInventory) {
      const gone = await waitFor(async () => (await liveEntry(id)) === null, LOADER_STATE_WAIT_MS, LOADER_STATE_POLL_MS)
      if (!gone) warnings.push(`宿主 loader 清单未在 ${LOADER_STATE_WAIT_MS / 1000} 秒内摘除该条目，列表可能短暂残留它的行（宿主收敛后自动消失）`)
    }
    if (removedScenes.length) warnings.push(`已同步摘掉 ${removedScenes.length} 个场景档案里对它的引用（${removedScenes.join('、')}）`)
    if (skippedLockedScenes.length) warnings.push(`场景 ${skippedLockedScenes.join('、')} 已锁定，档案里对它的引用保留未动（解锁后重新保存档案即可清掉）`)
    return warnings.length ? { ok: true, warning: warnings.join('；') } : { ok: true }
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

  // ---------- 配置体检的探测（0.15.0 B1；0.16.5 起含端点探测）----------------------
  // 正文 2026-10-01 整段搬到 ./inspect-probe.js（一字未改，只把闭包作用域的几个名字改走
  // deps）。那段「对补丁只读、`where`/`which` 只查命令名绝不执行配置里的命令、复用列表结果
  // 但不回写任何缓存」的口径连同理由一起搬过去了，见那边的文件头。
  const { mcpmInspect } = createInspectProbe({
    ensurePaths, readPatch, message, normalizeRow, mcpmList,
  })

  // ---------- 配置的导出 / 导入 ----------
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
    const payload = { exportedAt: new Date().toISOString(), rows }
    const json = JSON.stringify(payload, null, 2)
    let savedTo: string | null = null
    try {
      const abs = mcpSidecar(MCP_EXPORT_FILE)
      // 用 `writeJsonFile`（直写 hub 侧车）而**不是** `writePatch`（2026-09-30 审查 P1-3）：
      // `writePatch` 是宿主**补丁文件**的写口，写前会跑 `checkPatchWrite` 的官方方言校验
      // （顶层必须是 YAML 数组），而这里写的是 hub 里一份 JSON **对象** —— 校验必然失败、
      // 异常被下面的 catch 吞掉，于是 `savedTo` 恒为 null，界面显示"没能落盘（hub 目录写入
      // 失败）"，**诊断是错的**（真实原因是方言校验器拒收 JSON 对象）。而且 `writePatch`
      // 自己的调用面纪律（`index.ts`：「不写宿主配置的动作也不该调用它」）本就排除了它 ——
      // 本处是唯一一个传 hub 路径的调用点。顺带省掉一次 `danger-full-access` 策略升级。
      await writeJsonFile(abs, payload)
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
        //
        // `prevConfig` 同时认两种形状：`collectAll()` 出来的行把配置挂在 `config` 下，
        // 而同一个批次里**先前刚导入**的行（`byId.set(row.id, row)`）是 `mcpmAdd` 那种扁平形状。
        // 少认一种，同批里重复 id 的那条就拿不到旧值、被静默丢弃。
        const prevRow: any = idTaken ? byId.get(row.id) : null
        const prevConfig: any = prevRow ? (prevRow.config || prevRow) : {}
        for (const field of ['env', 'headers'] as const) {
          if (row[field] === undefined) continue
          const outcome = resolveMaskedKv(row[field], prevConfig[field])
          row[field] = outcome.value
          const note = describeMaskedOutcome(outcome)
          if (note) importNotes.push(row.serverName + '：' + note)
        }
        // serverName is globally unique: a DIFFERENT id owning the name is
        // always skipped, even in overwrite mode.
        if (nameTaken && !idTaken) { skipped.push({ id: row.id, reason: 'serverName 已存在' }); continue }
        if (idTaken && !overwrite) { skipped.push({ id: row.id, reason: 'id 已存在' }); continue }
        // URL 与 env / headers 同一条纪律（判据见 ./mcp/secret-guard.js）：打码值绝不入库。
        // 覆盖模式下拿被覆盖条目的旧真值顶替；没有旧真值可顶替时**跳过这一条**并给出理由 ——
        // URL 不是可丢的键值对，写一个"能连上但鉴权失败"的地址比不导入更糟。
        // 这条原先不存在，于是 `snapshot-export`（默认 `includeSecrets=false` 会把 URL 打码）
        // 导到目标机后，补丁里落进 `%3Credacted%3E` 而**没有任何 warning**（审查 F4）。
        if (row.transport === 'streamable-http') {
          const urlGuard = resolveMaskedUrl(row.url, prevConfig.url)
          if (urlGuard.unrecoverable) {
            skipped.push({ id: row.id, reason: 'URL 里的 userinfo / 查询串 / 片段是打码占位符，且没有原值可恢复：请重填完整 URL 后再导入' })
            continue
          }
          row.url = urlGuard.value
          if (urlGuard.restored) importNotes.push(row.serverName + '：URL 未改动，已保留原值')
        }
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
    setDisabledToolsCache(entries)
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

  /** 卸载清理（那六行随可见性段搬进 tool-visibility.ts，这里只留出口接线）。 */
  function dispose(): void {
    disposeVisibility()
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
      'mcpm-inspect': mcpmInspect,
    },
    readDisabledTools,
    readKnownMcpTools,
    readNotes,
    writeDisabledTools,
    updateNotes,
    mcpmListView,
    configuredServerNames,
    mcpmRowsWithNotes,
    readPluginSettings,
    isToolDisabled: (name: string) => isToolDisabledIn(disabledToolsSnapshot(), name),
    /** 停用表的两个口径（读 TTL 缓存；功能总览用）：`*` 通配的台数 + 单独停用的工具数。 */
    disabledToolSummary: () => {
      const map = disabledToolsSnapshot()
      let servers = 0
      let tools = 0
      for (const list of Object.values(map)) {
        if (!Array.isArray(list)) continue
        if (list.indexOf('*') >= 0) servers += 1
        tools += list.filter((name) => name !== '*').length
      }
      return { servers, tools }
    },
    warmUp,
    scheduleToolRestrictions,
    attachAgent,
    detachAgent,
    dispose,
  }
}
