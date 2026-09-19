// 归档会话域（原 index.ts apply() 闭包内六段，2026-09-19 抽出）。
//
// 这一域管的是「归档会话的外围」：侧车账本的落点与搬迁、保留期设置、到期清扫、
// 批量操作目标的校验、归档列表的分组视图。会话本身的归档 / 恢复 / 删除走宿主
// 注册表（./workspace.ts 的 ArchiveWorkspaceRegistry），这里只做围绕它的记账与投影。
//
// 为什么抽出来：这些内容此前散在 apply() 闭包的六个不相邻段落里（1041 / 1093 /
// 1152 / 1172 / 1683 / 1711），彼此靠闭包隐式共享 `sessions` 实例与侧车路径。抽成
// 工厂后私有状态（实例、目录存在性缓存）收在内部，只经返回对象的七个出口暴露；
// 对外依赖（config / pluginRoot / message / ctx）改为显式入参。
//
// 一处必须守住的语义：侧车三件套放 hub 根（`$DSH_HOME/tool-management/`）而**不是**
// 插件目录 —— npm 安装下 `dsh plugin update` 会整体替换插件目录，账本一丢，保留期
// 基线就从 archivedAt 退回 createdAt，归档会话会被提前清掉。旧位置启动时一次性搬入。

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { hubPath, hubRoot, relocateEntries } from '../hub.js'
import { ArchiveWorkspaceRegistry as SessionsService, workspaceBaseName, workspacePathKey } from './workspace.js'

// ── 对外契约（原在 index.ts，随本域搬出后由本文件导出）─────────────────────────

/** 批量操作目标（与 deleteArchivedSessions 的 target 同构）。 */
export type SessionsBatchTarget = {
  scope: 'all' | 'ungrouped' | 'sessions' | 'workspace'
  sessionIds?: string[]
  workspaceId?: string
}

/**
 * 归档列表的分组视图。宿主侧算好，客户端只按键归并：
 * `live` = 有活登记（含「路径命中但未记账」）；`detached` = 无活登记、按会话目录重建。
 */
export type SessionsGroupView = {
  id: string
  title: string
  kind: 'live' | 'detached'
  /** 活登记为登记路径；重建组为会话目录（目录已不在时为 header 里的原始 cwd）。 */
  path?: string
  /** 该路径在插件「见过的登记」快照里出现过 —— 区分「曾登记、已被移除」与「从未登记」。 */
  registered?: boolean
  /** 目录当前存在，可一键重新登记为工作区（仅 detached 组有意义）。 */
  canRegister?: boolean
  /** 会话目录已从磁盘删除（detached 组且 canRegister=false）：无法重新登记，提示用户会话仍可恢复/删除。 */
  dirMissing?: boolean
}

/** 归档工作区注册表（折叠自 dsh-archive-manager）的最小调用面。 */
export interface SessionsRegistry {
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }>
  deleteSession(sessionId: string): Promise<{ deleted: true }>
  deleteArchivedSessions(target: SessionsBatchTarget): Promise<{ requestedSessionIds: string[]; deletedSessionIds: string[]; skippedSessionIds: string[]; failures: Array<{ sessionId: string; message: string }> }>
  archivedSessionMetadata(): Promise<{ items: Array<{ sessionId: string; createdAt: number }> }>
  archivedSessionDetails?: () => Promise<{ items: Array<{ sessionId: string; createdAt?: number; cwd?: string; title?: string; archivedAt?: number }> }>
  archivedAt?(sessionId: string): number | undefined
  /** 可选：工作区记账表（ArchiveWorkspaceRegistry 提供），history-list 用它反查会话归属与组标题。 */
  requireTable?(): { get(id: string): { title?: string; path?: string; sessionIds: string[] } | undefined; entries(): Array<[string, { title?: string; path?: string; sessionIds: string[] }]> }
  /** 可选：注册表状态；workspaceIds 为权威显示顺序。 */
  requireState?(): { workspaceIds: string[] }
  /** 可选：会话 → 规范路径索引（宿主启动时对全部存储会话建立）。 */
  sessionPaths?: Map<string, string>
  /** 可选：会话 → header（含 cwd）。目录已不在时 cwd 仍是唯一归属线索。 */
  headers?: Map<string, { cwd?: string }>
  /** 可选：「见过的登记」快照（标题/路径），供登记被删后仍按目录显示原命名。 */
  workspaceSnapshot?(): Promise<Map<string, { path: string; title: string; id?: string; at: number }>>
  /** 可选：把当前活登记记入插件自己的快照（未变化时不写盘）。 */
  rememberWorkspaces?(records: Array<{ id?: string; path?: string; title?: string }>): Promise<void>
  /** 可选：为一个已存在目录重新创建宿主工作区登记，并把该目录下已知会话挂回（宿主 resolveByPath / create / attachSession）。 */
  registerWorkspace?(path: string, title?: string): Promise<{
    id: string
    title: string
    path: string
    created: boolean
    attached: string[]
    attachSkipped: Array<{ sessionId: string; reason: string }>
  }>
  /**
   * 可选：恢复归档后把工作区归属一起恢复（按会话 cwd 找到/重建登记并挂回其 sessionIds）。
   * 登记被删除后再重建的记录 `sessionIds` 是空的，不挂回的话恢复出来的会话在宿主侧就是「未分组」。
   */
  ensureWorkspaceAccounting?(sessionIds: string[]): Promise<{
    registered: Array<{ path: string; title: string; created: boolean }>
    attached: string[]
    skipped: Array<{ sessionId: string; reason: string }>
  }>
  /** 可选：批量恢复；缺失时 history-unarchive-batch 返回明确错误。 */
  unarchiveSessions?(target: SessionsBatchTarget): Promise<{ unarchivedSessionIds: string[]; archivedSessionIds: string[] }>
  /** 可选：枚举全部持久化会话（含未归档/冷会话）头部，供导出弹窗选择。 */
  listStoredHeaders?(): Promise<Array<{ id: string; cwd?: string; createdAt?: number }>>
  /** 可选：宿主能力评估快照（compat-status op 与设置页「兼容」页使用）。 */
  capabilities?(force?: boolean): import('../compat/probe.js').HostAssessment
  /** 可选：指定能力 id 中不可用的那些（只读路径降级用，不抛错）。 */
  capabilityRefusals?(ids: readonly string[]): import('../compat/probe.js').CapabilityRefusal[]
}

// ── 依赖与出口 ──────────────────────────────────────────────────────────────

export interface HistoryDomainDeps {
  /** 插件上下文：注册生命周期回调、取宿主服务、写日志（都是 cordis Context 的既有能力）。 */
  ctx: Context
  /** 插件配置（侧车路径 / 清扫周期都可注入，测试用）。 */
  config?: Record<string, unknown>
  /** 插件安装根目录：侧车搬迁的旧位置（`<root>/data`）在它下面。 */
  pluginRoot: string
  /** 通用错误文本提取（index.ts 的同名 helper）。 */
  message(e: unknown): string
}

export interface HistoryDomain {
  getSessionsRegistry(): SessionsRegistry | undefined
  restoreWorkspaceAccounting(sessionIds: string[]): Promise<{
    registered: Array<{ path: string; title: string; created: boolean }>
    attached: string[]
    skipped: Array<{ sessionId: string; reason: string }>
  } | undefined>
  readHistoryRetention(): Promise<{ retentionDays: number; updatedAt: number }>
  writeHistoryRetention(retentionDays: number): Promise<void>
  sweepHistory(): Promise<{ swept: string[] }>
  parseHistoryBatchTarget(raw: unknown): { ok: true; target: SessionsBatchTarget } | { ok: false; error: string }
  buildHistoryGroups(
    registry: SessionsRegistry,
    items: Array<{ sessionId: string; cwd?: string; workspaceId?: string; groupId?: string }>,
  ): Promise<{ groups: SessionsGroupView[]; workspaces: Record<string, { title: string; path?: string }> }>
}

/**
 * 建归档会话域。副作用（构造注册表实例、首次清扫、挂周期定时器）都在工厂内完成 ——
 * 它们原本就写在 apply() 的同一位置，语义是「这个服务自己的启动逻辑」，不是组装层的接线。
 */
export function createHistoryDomain(deps: HistoryDomainDeps): HistoryDomain {
  const { ctx, config, pluginRoot, message } = deps

  // ---------- independent history facade ----------
  // Keep the active workspaceRegistry/sessionProjectionCache instances intact.
  // Native archive extensions are delegated by capability, not package name.
  // Official gaps use a checked adapter (sessions/bridge.ts); no service or
  // storage-domain replacement. Retention uses the existing sidecar ledger.
  // 历史侧车三件套（归档时刻账本 / 保留期设置 / 工作区登记快照）统一放 hub 根
  // （`$DSH_HOME/tool-management/`），**不放插件目录**：npm 安装下插件目录会被
  // `dsh plugin update` 整体替换，放那里等于"升级即丢账本"——账本一丢，保留期基线
  // 就从 archivedAt 退回 createdAt，归档会话会被提前清掉（v0.4 把提示词预设
  // 搬进 hub 是同一条理由，见上方注释；这三个是当时漏掉的）。
  // 旧位置（插件目录 data/）在启动时一次性搬入：只搬不删、绝不覆盖、失败下次再试。
  const historyArchivedAtFile = String((config as { archivedAtFile?: unknown } | undefined)?.archivedAtFile || hubPath('history-archived-at.json'))
  const historyWorkspaceSnapshotFile = String((config as { workspaceSnapshotFile?: unknown } | undefined)?.workspaceSnapshotFile || hubPath('history-workspaces.json'))
  const historyRetentionPath = String((config as { historyRetentionPath?: unknown } | undefined)?.historyRetentionPath || hubPath('history-retention.json'))
  const historySidecarFiles = new Set(['history-archived-at.json', 'history-retention.json', 'history-workspaces.json'])
  const historyStandby = relocateEntries(join(pluginRoot, 'data'), hubRoot(), (name) => historySidecarFiles.has(name))
    .catch(() => 0)
  const sweepIntervalMs = Number((config as { sweepIntervalMs?: unknown } | undefined)?.sweepIntervalMs || 0) || 6 * 60 * 60 * 1000
  let sessions: InstanceType<typeof SessionsService> | undefined
  ctx.effect(() => {
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof (registry as any).archiveSession === 'function') {
      sessions = new SessionsService(ctx, registry, {
        archivedAtFile: historyArchivedAtFile,
        workspaceSnapshotFile: historyWorkspaceSnapshotFile,
        ready: historyStandby,
      })
    }
    return async () => { const current = sessions; sessions = undefined; await current?.dispose() }
  }, 'dsh-plugin-tool-management: independent history')
  function getSessionsRegistry(): SessionsRegistry | undefined {
    return sessions as unknown as SessionsRegistry | undefined
  }

  /**
   * 恢复归档后的**归属恢复**（best-effort，绝不阻断恢复本身）：按会话 cwd 找到或重建
   * 工作区登记，并把会话挂回该登记的 `sessionIds`。恢复成功但归属恢复失败时返回 undefined，
   * 由客户端按"会话已恢复、工作区归属未恢复"如实呈现。
   */
  async function restoreWorkspaceAccounting(sessionIds: string[]): Promise<{
    registered: Array<{ path: string; title: string; created: boolean }>
    attached: string[]
    skipped: Array<{ sessionId: string; reason: string }>
  } | undefined> {
    const registry = getSessionsRegistry()
    if (!registry || typeof registry.ensureWorkspaceAccounting !== 'function' || !sessionIds.length) return undefined
    try { return await registry.ensureWorkspaceAccounting(sessionIds) } catch (e) {
      ctx.logger?.warn?.(`history: workspace accounting after restore failed: ${message(e)}`)
      return undefined
    }
  }

  async function readHistoryRetention(): Promise<{ retentionDays: number; updatedAt: number }> {
    try {
      await historyStandby
      const raw = await readFile(historyRetentionPath, 'utf8')
      const obj = JSON.parse(raw)
      const days = Number((obj && (obj as { retentionDays?: unknown }).retentionDays) ?? 0)
      const updatedAt = Number((obj && (obj as { updatedAt?: unknown }).updatedAt) ?? 0)
      return {
        retentionDays: Number.isFinite(days) && days >= 0 ? days : 0,
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
      }
    } catch { return { retentionDays: 0, updatedAt: 0 } }
  }
  async function writeHistoryRetention(retentionDays: number): Promise<void> {
    await historyStandby
    const dir = dirname(historyRetentionPath)
    await mkdir(dir, { recursive: true })
    // updatedAt = 修改时刻：每次改保留期，已归档会话的到期基线重置为此时刻。
    await writeFile(historyRetentionPath, JSON.stringify({ retentionDays, updatedAt: Date.now() }), 'utf8')
  }
  /**
   * 计算到期应删的归档会话。基线 = max(archivedAt（账本）?? createdAt（元数据),
   * updatedAt（最近一次修改保留期的时刻）)。改保留期即重置倒计时：到期时刻从
   * 修改时刻起按新天数重新计算；updatedAt 缺失（旧配置）时退回归档时刻语义。
   * retentionDays <= 0 表示永久不删除，返回空集。纯函数：便于测试。
   */
  /** 一天的毫秒数（保留期按"天"配置，比较按毫秒）。 */
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  function expiredArchivedIds(
    items: Array<{ sessionId: string; createdAt?: number; archivedAt?: number }>,
    retentionDays: number,
    now: number,
    updatedAt = 0,
  ): string[] {
    if (!(retentionDays > 0)) return []
    const cutoff = now - retentionDays * MS_PER_DAY
    const out: string[] = []
    for (const it of items) {
      const archived = (typeof it.archivedAt === 'number' && Number.isFinite(it.archivedAt))
        ? it.archivedAt
        : (typeof it.createdAt === 'number' && Number.isFinite(it.createdAt) ? it.createdAt : undefined)
      if (archived === undefined) continue
      const baseline = updatedAt > 0 ? Math.max(archived, updatedAt) : archived
      if (baseline <= cutoff) out.push(it.sessionId)
    }
    return out
  }
  async function sweepHistory(): Promise<{ swept: string[] }> {
    const registry = getSessionsRegistry()
    if (!registry) return { swept: [] }
    const { retentionDays, updatedAt } = await readHistoryRetention()
    if (!(retentionDays > 0)) return { swept: [] }
    try {
      const details = (typeof registry.archivedSessionDetails === 'function')
        ? (await registry.archivedSessionDetails()).items
        : (await registry.archivedSessionMetadata()).items.map((i) => ({ sessionId: i.sessionId, createdAt: i.createdAt, archivedAt: registry.archivedAt?.(i.sessionId) }))
      const expired = expiredArchivedIds(details, retentionDays, Date.now(), updatedAt)
      if (expired.length === 0) return { swept: [] }
      const res = await registry.deleteArchivedSessions({ scope: 'sessions', sessionIds: expired })
      return { swept: res.deletedSessionIds || [] }
    } catch (e) {
      console.error('[dsh-plugin-tool-management] history sweep failed:', message(e))
      return { swept: [] }
    }
  }
  // 启动时扫一次，再周期复跑。fake-ctx 测试里 ctx.effect 立即调用并 dispose，
  // interval 未提供时退化为不挂钟（不阻塞测试）。
  try {
    void sweepHistory()
  } catch { /* 非致命 */ }
  try {
    ctx.effect(() => {
      const timer = ctx as unknown as { interval?: (cb: () => void, ms: number) => () => void; setInterval?: (cb: () => void, ms: number) => () => void }
      const fn = typeof timer.interval === 'function' ? timer.interval : (typeof timer.setInterval === 'function' ? timer.setInterval : undefined)
      if (!fn) return () => {}
      return fn(() => { void sweepHistory() }, sweepIntervalMs)
    }, 'dsh-plugin-tool-management: history sweep')
  } catch { /* timer 缺失时静默 */ }

  // 批量操作目标校验：scope 白名单；sessions 需非空 sessionIds；workspace 需
  // workspaceId。与 ArchiveWorkspaceRegistry.archivedBatchTargetSchema 语义一致。
  function parseHistoryBatchTarget(raw: unknown): { ok: true; target: SessionsBatchTarget } | { ok: false; error: string } {
    const t = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
    if (!t) return { ok: false, error: '缺少 target' }
    const scope = t.scope
    if (scope !== 'all' && scope !== 'ungrouped' && scope !== 'sessions' && scope !== 'workspace') {
      return { ok: false, error: 'target.scope 不合法' }
    }
    if (scope === 'sessions') {
      if (!Array.isArray(t.sessionIds) || t.sessionIds.length === 0 ||
          t.sessionIds.some((id) => typeof id !== 'string' || !String(id).trim())) {
        return { ok: false, error: 'scope=sessions 需要非空的 sessionIds 数组' }
      }
    }
    if (scope === 'workspace' && !(typeof t.workspaceId === 'string' && String(t.workspaceId).trim())) {
      return { ok: false, error: 'scope=workspace 需要 workspaceId' }
    }
    return {
      ok: true,
      target: {
        scope,
        ...(scope === 'sessions' ? { sessionIds: (t.sessionIds as string[]).map((s) => String(s).trim()) } : {}),
        ...(scope === 'workspace' ? { workspaceId: String(t.workspaceId).trim() } : {}),
      },
    }
  }

  /**
   * 归档会话的归属解析（三级，宿主侧算好再给客户端）：
   *   1. 活登记的 sessionIds 命中            → 组 = 该登记；
   *   2. 未命中但规范路径命中某活登记        → 组 = 该登记（会话不在其记账里，属正常）；
   *   3. 没有任何活登记                      → 按会话目录重建分组（`path:<归一化路径>`），
   *      目录仍在则可一键重新登记（写回宿主），目录已不在则退到 header 里的原始 cwd。
   * 宿主删除工作区是硬删、不留墓碑，登记一没，`workspaceId` 就再也查不到；但会话目录
   * （`registry.sessionPaths` / header.cwd）还在，所以归属可以按目录重建、并在目录回来时
   * 自动并回同一组。除插件自己 `data/` 下的「见过的登记」快照外，本函数不写任何宿主状态。
   * 任何一步失败都降级为「不分组」，绝不阻断列表。
   */
  async function buildHistoryGroups(
    registry: SessionsRegistry,
    items: Array<{ sessionId: string; cwd?: string; workspaceId?: string; groupId?: string }>,
  ): Promise<{ groups: SessionsGroupView[]; workspaces: Record<string, { title: string; path?: string }> }> {
    const groups: SessionsGroupView[] = []
    const workspaces: Record<string, { title: string; path?: string }> = {}
    try {
      const groupsById = new Map<string, SessionsGroupView>()
      const liveByPath = new Map<string, string>()
      const owned = new Map<string, string>()
      const liveRecords: Array<{ id: string; path: string; title: string }> = []
      const table = typeof registry.requireTable === 'function' ? registry.requireTable() : undefined
      const state = typeof registry.requireState === 'function' ? registry.requireState() : undefined
      if (table) {
        const ids = state && Array.isArray(state.workspaceIds) && state.workspaceIds.length
          ? state.workspaceIds
          : [...table.entries()].map(([id]) => id)
        for (const wid of ids) {
          const rec = table.get(wid)
          if (!rec || !Array.isArray(rec.sessionIds)) continue
          const path = typeof rec.path === 'string' && rec.path ? rec.path : undefined
          const title = (rec.title && String(rec.title)) || (path ? workspaceBaseName(path) : String(wid))
          for (const sid of rec.sessionIds) if (!owned.has(sid)) owned.set(sid, wid)
          if (path) {
            liveByPath.set(workspacePathKey(path), wid)
            liveRecords.push({ id: String(wid), path, title })
          }
          const view: SessionsGroupView = { id: 'ws:' + wid, title, kind: 'live', registered: true, ...(path ? { path } : {}) }
          groupsById.set(view.id, view)
          groups.push(view)
          workspaces[wid] = { title, ...(path ? { path } : {}) }
        }
      }
      // 「见过的登记」快照：登记被删后仍能给出原命名，并区分「已移除」与「从未登记」。
      const snapshot = typeof registry.workspaceSnapshot === 'function' ? await registry.workspaceSnapshot() : undefined
      if (liveRecords.length && typeof registry.rememberWorkspaces === 'function') {
        try { await registry.rememberWorkspaces(liveRecords) } catch { /* 快照写失败不影响分组 */ }
      }
      const sessionPaths = registry.sessionPaths instanceof Map ? registry.sessionPaths : undefined
      const headers = registry.headers instanceof Map ? registry.headers : undefined
      // 「目录真实存在」检查缓存：canRegister 从「宿主 sessionPaths 命中」放宽为
      // 「目录存在」时，同一目录只 stat 一次；结果按归一化键缓存，避免每次刷新重复探盘。
      const dirExistsCache = new Map<string, boolean>()
      async function directoryExists(p: string): Promise<boolean> {
        const k = workspacePathKey(p)
        const hit = dirExistsCache.get(k)
        if (hit !== undefined) return hit
        let ok = false
        try { ok = (await stat(p)).isDirectory() } catch { ok = false }
        dirExistsCache.set(k, ok)
        return ok
      }
      for (const it of items) {
        const sid = it.sessionId
        let wid = owned.get(sid)
        const canonical = sessionPaths ? sessionPaths.get(sid) : undefined
        if (wid === undefined && typeof canonical === 'string' && canonical) {
          const byPath = liveByPath.get(workspacePathKey(canonical))
          if (byPath !== undefined) wid = byPath
        }
        if (wid !== undefined) {
          it.workspaceId = wid
          it.groupId = 'ws:' + wid
          continue
        }
        let path = typeof canonical === 'string' && canonical ? canonical : undefined
        if (path === undefined && it.cwd) path = it.cwd
        if (path === undefined && headers) {
          const cwd = headers.get(sid)?.cwd
          if (typeof cwd === 'string' && cwd) path = cwd
        }
        if (!path) continue
        const key = 'path:' + workspacePathKey(path)
        it.groupId = key
        const known = snapshot ? snapshot.get(workspacePathKey(path)) : undefined
        const existing = groupsById.get(key)
        if (existing) {
          // 同目录的多个会话：宿主索引命中，或磁盘目录真实存在，即可重新登记。
          if (canonical !== undefined || (await directoryExists(path))) {
            existing.canRegister = true
            existing.dirMissing = false
          }
          continue
        }
        const canRegister = canonical !== undefined || (await directoryExists(path))
        const view: SessionsGroupView = {
          id: key,
          title: known?.title || workspaceBaseName(path) || path,
          kind: 'detached',
          registered: known !== undefined,
          canRegister,
          dirMissing: !canRegister,
          path: known?.path || path,
        }
        groupsById.set(key, view)
        groups.push(view)
      }
    } catch { /* 分组是增强：任何异常都退回扁平列表 */ }
    return { groups, workspaces }
  }

  return {
    getSessionsRegistry,
    restoreWorkspaceAccounting,
    readHistoryRetention,
    writeHistoryRetention,
    sweepHistory,
    parseHistoryBatchTarget,
    buildHistoryGroups,
  }
}
