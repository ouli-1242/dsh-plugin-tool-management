// 会话覆盖侧车的读写（`hub/scope-overrides.json`）。
//
// 与 `settings-sidecars.ts` 的四份界面设置同一条纪律：**读走 TTL 缓存、写走 apply 的
// 串行写锁**。但有三处不同，都写在这里免得被当成"抄错"：
//
//   1. 写入口只有一条（`mutate`）：它读最新 → 改 → 写回，全程在写锁里。四份界面设置是
//      "整份替换"，而覆盖表是**逐键**改的 —— 分开读再分开写会让两个并发请求互相覆盖。
//   2. 缓存是**整份侧车**的（会话数量级很小），不像记忆那样需要分桶。TTL 300ms：
//      界面开关点一下就要看到回执，而注入器每步都要读 —— 3 秒会让"刚关掉的服务器还在
//      下一步的目录里"变成常态。
//   3. 读不到 / 读坏 = 空表，**不抛**：会话覆盖是叠加在全局之上的偏好，它坏了最坏是
//      "回到全局"，不该让整个面板或注入通道跟着挂（与 `readTrashRetention` 同口径）。
//      **写路径不复用这条**：写锁内必须 strict read，读坏就拒绝落盘；否则一次读失败之后的
//      改一处 → 整份写，会把用户全部会话覆盖换成空表。

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hubPath } from '../hub.js'
import { renameWithRetry } from '../skills/core-util.js'
import {
  normalizeScopeMode,
  normalizeScopeOverrides,
  normalizeSessionScope,
  validRecordKey,
  type ScopeMode,
  type ScopeOverrides,
  type SessionScope,
} from './scope-overrides.js'
import { isWorkspaceScopeKey } from './workspace-key.js'

/** 侧车文件名（hub 根，与 `inject-settings.json` 并排）。 */
export const SCOPE_OVERRIDES_FILE = 'scope-overrides.json'

/** 读缓存 TTL：够密（界面点一下就回）又不至于每个注入 step 都读盘。 */
const TTL_MS = 300

/** 会话覆盖存储的依赖：侧车路径与写锁。 */
export interface ScopeStoreDeps {
  /** apply 的串行写锁：与其余侧车共用同一条队列。 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  /** 错误转人话（apply 里那个 `message`）。 */
  message(e: unknown): string
  /**
   * 宿主会话清单里**此刻还活着**的会话 id（侧车 GC 用）。
   *
   * 不传 = 不做 GC（老行为）。返回 `null` = 这一轮读不到清单 → **不剪**：读不到 ≠ 全被删了，
   * 按空表剪会把所有会话的覆盖一次抹掉。归档会话**算活着**（覆盖留着，恢复后自然回来）。
   */
  liveSessionIds?(): Promise<ReadonlySet<string> | null>
}

/** 会话覆盖存储的对外面：读一层、写一层、清一层。 */
export interface ScopeStore {
  /** 读整份侧车（TTL 缓存；`force` 跳过缓存）。 */
  read(force?: boolean): Promise<ScopeOverrides>
  /**
   * 严格读整份侧车：**文件存在却读不动 / 解析不了**时**抛错**（`read` 会吞成空表）。
   *
   * 只给启动对账的痕迹闸门用。那一处必须在读不到时保守 —— 一律当"有痕迹"
   * 不采纳运行态 —— 而 `read` 的吞错语义分不出"这台机器真的没有会话覆盖"与"这份侧车没读出来"。
   * 文件**不存在**（全新机器 / 从未用过会话作用域）= 确实没有任何会话痕迹，按空表返回，不抛。
   */
  readStrict(): Promise<ScopeOverrides>
  /** 同步快照（注入器每步取用）：还没加载时返回空表并异步预热。 */
  snapshot(): ScopeOverrides
  /** 当前隔离粒度（异步；读一次侧车）。 */
  mode(): Promise<ScopeMode>
  /** 当前隔离粒度（同步；注入热路径用）。缓存未加载时按 `session`。 */
  modeSync(): ScopeMode
  /** 某个会话 / 工作区的覆盖（没有 = undefined）。 */
  scopeOf(sessionId: string | null): Promise<SessionScope | undefined>
  /** 同步版（注入器用）。 */
  scopeOfSync(sessionId: string | null): SessionScope | undefined
  /**
   * 切换隔离粒度，并在**同一次写锁 / 同一次落盘**里补上缺失的那一侧记录。
   *
   * `seeds` 只在目标键**当前没有记录**时生效（已有记录一律保留 —— 来回切换不覆盖）。
   * 播种规则与剥离 `locked` 的判定在 op 层（`ops/scope.ts`），store 只负责原子落盘。
   */
  switchMode(mode: ScopeMode, seeds?: Record<string, SessionScope | undefined>): Promise<{ ok: true; seeded: number } | { ok: false; error: string }>
  /**
   * 改一个会话的覆盖：`mutate` 收到**当前**覆盖，返回新覆盖（`undefined` = 删掉这条）。
   * 全程在写锁里读-改-写，并发请求不会互相覆盖。
   */
  mutate(sessionId: string, mutate: (current: SessionScope | undefined) => SessionScope | undefined): Promise<{ ok: true; scope?: SessionScope } | { ok: false; error: string }>
  /**
   * 跨会话批量改（场景改名 / 删除 / 改绑工具表用）：一次读-改-写，不逐会话落盘。
   *
   * 回调返回**原引用**表示这条不用改（`changed` 只数真正换过引用的）；返回 `undefined` 删除。
   * 与 `mutate` 共用同一条写锁与缓存更新，不会与并发的单会话写互相覆盖。
   */
  mutateAll(mutate: (scope: SessionScope, sessionId: string) => SessionScope | undefined): Promise<{ ok: true; changed: number } | { ok: false; error: string }>
  /** 清掉某个会话的全部覆盖。 */
  clearSession(sessionId: string): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }>
  /**
   * 侧车 GC：剪掉宿主会话清单里**已经删除**的会话的条目，返回剪掉了几条。
   *
   * 归档未删除的**保留**（可恢复）。清单读不到时返回 0 且不写盘（见 `liveSessionIds` 的注释）。
   *
   * `live` 可选：调用方手头**已经有**一份新鲜清单时传进来，免得为剪枝再扫一遍宿主
   * （`scope-sessions-list` 正是这种情况）。不传则走 `deps.liveSessionIds`。
   */
  pruneDeletedSessions(live?: ReadonlySet<string> | null): Promise<{ ok: true; pruned: number } | { ok: false; error: string }>
  /** 丢掉缓存（测试与启动对账用）。 */
  invalidate(): void
}

/** 会话作用域侧车（`scope-overrides.json`）的读写门面：会话 / 工作区两种键共用一张表。 */
export function createScopeStore(deps: ScopeStoreDeps): ScopeStore {
  let cache: { at: number; value: ScopeOverrides } | null = null
  let warming = false

  function file(): string {
    return hubPath(SCOPE_OVERRIDES_FILE)
  }

  async function load(): Promise<ScopeOverrides> {
    try {
      return normalizeScopeOverrides(JSON.parse(await readFile(file(), 'utf8')))
    } catch {
      // 不存在 / 读不动 / JSON 坏 → 空表。**不隔离、不报警**：这份侧车丢了只意味着
      // "所有会话回到全局"，而全局那一份（索引 / 补丁 / 状态文件）一个字都没动。
      return { version: 1, mode: 'session', sessions: Object.create(null) }
    }
  }

  async function read(force = false): Promise<ScopeOverrides> {
    if (!force && cache !== null && Date.now() - cache.at < TTL_MS) return cache.value
    const value = await load()
    cache = { at: Date.now(), value }
    return value
  }

  async function readStrict(): Promise<ScopeOverrides> {
    // **不走缓存**：缓存里那份可能是 `read()` 吞掉失败后的空表，拿它当"读成功"就把
    // 这一趟要分的那件事又抹平了。这一趟本来就只在启动 / 面板刷新时跑。
    const raw = await readFile(file(), 'utf8').catch((e: unknown) => {
      if ((e as { code?: string } | null)?.code === 'ENOENT') return null
      throw e
    })
    if (raw === null) return { version: 1, mode: 'session', sessions: Object.create(null) }
    return normalizeScopeOverrides(JSON.parse(raw))
  }

  function snapshot(): ScopeOverrides {
    if (cache !== null) return cache.value
    if (!warming) {
      warming = true
      void read().catch(() => {}).finally(() => { warming = false })
    }
    return { version: 1, mode: 'session', sessions: Object.create(null) }
  }

  async function mode(): Promise<ScopeMode> {
    return (await read()).mode
  }

  function modeSync(): ScopeMode {
    return snapshot().mode
  }

  async function scopeOf(sessionId: string | null): Promise<SessionScope | undefined> {
    if (sessionId === null) return undefined
    return (await read()).sessions[sessionId]
  }

  function scopeOfSync(sessionId: string | null): SessionScope | undefined {
    if (sessionId === null) return undefined
    return snapshot().sessions[sessionId]
  }

  /** 落盘（调用方必须已在写锁里）。临时文件 + rename：写一半崩掉不会留下半份 JSON。 */
  async function persist(next: ScopeOverrides): Promise<void> {
    const abs = file()
    await mkdir(dirname(abs), { recursive: true })
    const temp = join(dirname(abs), '.' + randomUUID().slice(0, 8) + '.scope-tmp')
    try {
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await renameWithRetry(temp, abs)
    } catch (e) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw e
    }
  }

  async function mutate(
    sessionId: string,
    mutate: (current: SessionScope | undefined) => SessionScope | undefined,
  ): Promise<{ ok: true; scope?: SessionScope } | { ok: false; error: string }> {
    if (!validRecordKey(sessionId)) return { ok: false, error: '缺少或非法的 sessionId' }
    return deps.withWriteLock(async () => {
      try {
        // 写锁里**强制**重读：缓存可能比磁盘旧，而这里是唯一写入口。
        const current = await readStrict()
        const before = current.sessions[sessionId]
        const after = normalizeSessionScope(mutate(before))
        const sessions: Record<string, SessionScope> = Object.assign(Object.create(null), current.sessions)
        if (after === undefined) delete sessions[sessionId]
        else sessions[sessionId] = after
        const next: ScopeOverrides = { version: 1, mode: current.mode, sessions }
        await persist(next)
        cache = { at: Date.now(), value: next }
        return after === undefined ? { ok: true } : { ok: true, scope: after }
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
    })
  }

  async function switchMode(
    nextMode: ScopeMode,
    seeds: Record<string, SessionScope | undefined> = {},
  ): Promise<{ ok: true; seeded: number } | { ok: false; error: string }> {
    const mode = normalizeScopeMode(nextMode)
    return deps.withWriteLock(async () => {
      try {
        const current = await readStrict()
        const sessions: Record<string, SessionScope> = Object.assign(Object.create(null), current.sessions)
        let seeded = 0
        for (const [key, seed] of Object.entries(seeds)) {
          if (!validRecordKey(key) || seed === undefined) continue
          // 已有记录一律保留：播种只填「这一侧还没配过」的键。
          if (sessions[key] !== undefined) continue
          const normalized = normalizeSessionScope(seed)
          if (normalized === undefined) continue
          sessions[key] = normalized
          seeded += 1
        }
        // 模式没变、也没有新播种 → 不写盘（避免一次无意义的 mtime 变化）。
        if (mode === current.mode && seeded === 0) return { ok: true, seeded: 0 }
        const next: ScopeOverrides = { version: 1, mode, sessions }
        await persist(next)
        cache = { at: Date.now(), value: next }
        return { ok: true, seeded }
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
    })
  }

  async function mutateAll(mutate: (scope: SessionScope, sessionId: string) => SessionScope | undefined): Promise<{ ok: true; changed: number } | { ok: false; error: string }> {
    return deps.withWriteLock(async () => {
      try {
        // 与 mutate 同一条纪律：锁内强制重读；缓存可能比磁盘旧。
        const current = await readStrict()
        const sessions: Record<string, SessionScope> = Object.create(null)
        let changed = 0
        for (const [sessionId, before] of Object.entries(current.sessions)) {
          const raw = mutate(before, sessionId)
          if (raw === before) { sessions[sessionId] = before; continue }
          const after = normalizeSessionScope(raw)
          if (after !== undefined) sessions[sessionId] = after
          changed += 1
        }
        if (changed === 0) return { ok: true, changed: 0 }
        const next: ScopeOverrides = { version: 1, mode: current.mode, sessions }
        await persist(next)
        cache = { at: Date.now(), value: next }
        return { ok: true, changed }
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
    })
  }

  async function clearSession(sessionId: string): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
    if (!validRecordKey(sessionId)) return { ok: false, error: '缺少或非法的 sessionId' }
    return deps.withWriteLock(async () => {
      try {
        const current = await readStrict()
        if (current.sessions[sessionId] === undefined) return { ok: true, removed: false }
        const sessions: Record<string, SessionScope> = Object.assign(Object.create(null), current.sessions)
        delete sessions[sessionId]
        const next: ScopeOverrides = { version: 1, mode: current.mode, sessions }
        await persist(next)
        cache = { at: Date.now(), value: next }
        return { ok: true, removed: true }
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
    })
  }

  async function pruneDeletedSessions(live?: ReadonlySet<string> | null): Promise<{ ok: true; pruned: number } | { ok: false; error: string }> {
    // 调用方没给清单（`undefined`）才自己去取；显式给 `null` = 调用方知道这一轮读不到 → 不剪。
    let alive: ReadonlySet<string> | null = live ?? null
    if (live === undefined && deps.liveSessionIds !== undefined) {
      try { alive = await deps.liveSessionIds() } catch { alive = null }
    }
    // 清单读不到 = 不剪（读不到 ≠ 全被删了）。这条在锁外判定：读清单可能很慢。
    if (alive === null) return { ok: true, pruned: 0 }
    const keep = alive
    return deps.withWriteLock(async () => {
      try {
        const current = await readStrict()
        const kept = pruneSessionScopes(current.sessions, keep)
        if (kept.pruned === 0) return { ok: true, pruned: 0 }
        const next: ScopeOverrides = { version: 1, mode: current.mode, sessions: kept.sessions }
        await persist(next)
        cache = { at: Date.now(), value: next }
        return { ok: true, pruned: kept.pruned }
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
    })
  }

  function invalidate(): void {
    cache = null
  }

  return { read, readStrict, snapshot, mode, modeSync, scopeOf, scopeOfSync, switchMode, mutate, mutateAll, clearSession, pruneDeletedSessions, invalidate }
}

/**
 * 剪枝的**纯函数**部分（导出给契约测试）：留下 `live` 里有的会话。
 *
 * 为什么单独导出：GC 的判据（"归档保留、已删除剪掉、清单读不到不剪"）是这条不变式的全部
 * 内容，而它能在没有磁盘的情况下钉死 —— 剩下的读盘 / 写锁只是搬运。
 *
 * 工作区键（`ws:<cwd>`）**不在** `live` 集合里（它不是会话 id），必须原样保留：工作区
 * 可能只是暂时没有会话（设置要在会话回来时还在），删掉就等于把用户配好的工作区设置
 * 当成孤儿清掉。真正的会话记录仍按 `live` 剪。
 */
export function pruneSessionScopes(
  sessions: Record<string, SessionScope>,
  live: ReadonlySet<string>,
): { sessions: Record<string, SessionScope>; pruned: number } {
  const next: Record<string, SessionScope> = Object.create(null)
  let pruned = 0
  for (const [sessionId, scope] of Object.entries(sessions)) {
    if (isWorkspaceScopeKey(sessionId) || live.has(sessionId)) next[sessionId] = scope
    else pruned += 1
  }
  return { sessions: next, pruned }
}
