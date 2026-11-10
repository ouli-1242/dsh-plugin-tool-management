// 维护扫描（P3）：把"记忆会自己变老"这件事从比喻变成一条可复现的规则。
//
// 四类清理，按代价从低到高：
//   1. episode / outbox 裁剪 —— 30 天前的轮次摘要没人会再看，留着只是让目录变大。
//   2. 会话层 GC —— 那个对话早就结束了，`_session/<sid>` 却还在磁盘上。
//   3. TTL 到期 —— 事实会过期（端口号、包管理器），降候选而不是直接归档：
//      "过期"不等于"错"，用户可能还在用，只是该复核一次。
//   4. 衰减 / 工作区失效 / 配额 —— 最久没人用、所在目录都不在了、层已经满了。
//
// 一条纪律：**这套扫描只改状态，不删文件**。归档是可恢复的，删除不是；把两者混在一起，
// 用户迟早会遇到"我的记忆自己消失了"。真正的删除只有 `forget`（带墓碑与回收站）。
//
// 另一个纪律：**纯函数先出计划，再执行**。判断写在 `planSweep` 里，好测、可解释；
// 执行只是把计划翻译成 `setStatus` 调用。否则"为什么它把我的记忆归档了"永远说不清。

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryLayer } from '../memories/constants.js'
import { LAYER_QUOTA } from './gates.js'
import type { EvolutionStateStore } from './state.js'
import { scoreOf } from './state.js'
import type { EpisodeStore } from './episodes.js'
import type { Learner } from './write.js'
import { pickField } from './write.js'

/** 会话层多久没用就回收。会话记忆本来就是"这个对话里有用"，不是长期记忆。 */
export const SESSION_GC_DAYS = 14
/** 多久没注入也没人读 = 死条目。 */
export const DECAY_DAYS = 180
/** 工作区目录消失多久之后归档它的记忆（设计文档：90 天）。 */
export const WORKSPACE_MISSING_DAYS = 90
/** episode / outbox 保留天数。 */
export const EPISODE_KEEP_DAYS = 30
/** 每次配额清理最多归档这一层容量的 20%，避免一次扫描把候选清空。 */
const QUOTA_SWEEP_RATIO = 0.2

export interface SweepEntry {
  id: string
  layer: MemoryLayer
  key: string
  status: string
  origin: 'user' | 'auto'
  confidence: number
  tokens: number
  locked?: boolean
  /** `auto_updated`，读不到时退回文件 mtime。 */
  updatedAt: string
  /** 显式 TTL；0 / 缺失 = 按 kind 的默认值（见 `ttlDaysOf`）。 */
  ttlDays?: number
  kind?: string
  workspace?: string
  counters: {
    injected: number
    read: number
    helpful: number
    harmful: number
    lastInjectedAt?: string
    lastUsedAt?: string
  }
}

export type SweepBucket = 'session-gc' | 'ttl' | 'decay' | 'workspace' | 'quota'

export type SweepAction =
  | { kind: 'demote'; id: string; bucket: 'ttl'; reason: string; needsReview: string }
  | { kind: 'archive'; id: string; bucket: SweepBucket; reason: string }

export interface SweepOptions {
  now?: number
  sessionDays?: number
  decayDays?: number
  /** hash → 目录已消失多少天（只含确实不存在的）。 */
  workspaceMissingDays?: Map<string, number>
  layerCaps?: Partial<Record<MemoryLayer, number>>
  /** 只出计划，不改任何状态（界面的「预览」）。 */
  dry?: boolean
}

const day = 86400_000

const ageDaysOf = (iso: string | undefined, now: number): number => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? Math.max(0, (now - t) / day) : 0
}

const lastTouched = (e: SweepEntry, now: number): number => {
  const candidates = [e.updatedAt, e.counters.lastUsedAt, e.counters.lastInjectedAt]
    .map((x) => (x ? Date.parse(x) : Number.NaN))
    .filter((n) => Number.isFinite(n))
  if (candidates.length === 0) return 0
  return (now - Math.max(...candidates)) / day
}

// playbook 有意排除（P4）：它是"验证过 3 次 + 用户确认链"的成果，TTL / 衰减 / 配额
// 这类自动老化不该把它降回候选（那会把步骤与常驻待遇一起抹掉）。要下线由用户手动归档。
const isLive = (e: SweepEntry): boolean =>
  e.origin === 'auto' && e.locked !== true && (e.status === 'active' || e.status === 'core' || e.status === 'candidate')

/**
 * 出计划。纯函数：同一份输入永远给同一份输出（`now` 显式传入）。
 *
 * 顺序固定，前面的动作会把条目从后面的判断里拿掉：一条刚被会话 GC 归档的条目，
 * 不该在 TTL 那一轮又降一次候选。
 */
export function planSweep(entries: SweepEntry[], opts: SweepOptions = {}): { actions: SweepAction[]; counts: Record<SweepBucket, number> } {
  const now = opts.now ?? Date.now()
  const sessionDays = opts.sessionDays ?? SESSION_GC_DAYS
  const decayDays = opts.decayDays ?? DECAY_DAYS
  const caps = { ...LAYER_QUOTA, ...(opts.layerCaps ?? {}) }
  const actions: SweepAction[] = []
  const taken = new Set<string>()
  const counts: Record<SweepBucket, number> = { 'session-gc': 0, ttl: 0, decay: 0, workspace: 0, quota: 0 }

  const push = (a: SweepAction): void => {
    actions.push(a)
    taken.add(a.id)
    counts[a.bucket]++
  }

  // 1. 会话层 GC：对话结束两周，这些条目不会再被任何会话看见（`_session/<sid>` 只对
  //    那个 sid 生效）。归档而不是删除 —— 用户翻旧对话时还可能想看到它。
  for (const e of entries) {
    if (!isLive(e)) continue
    if (e.layer !== 'session') continue
    if (lastTouched(e, now) < sessionDays) continue
    push({ kind: 'archive', id: e.id, bucket: 'session-gc', reason: `conversation inactive for ${Math.floor(lastTouched(e, now))} days` })
  }

  // 2. TTL：到期的**事实**降候选并标待确认；候选再躺一个 TTL 周期就归档（2×）。
  //    为什么降级要标 needsReview：候选不进注入，但用户得能看见它 —— 否则"记忆自己
  //    变少了"和"记忆还在只是不注入"在界面上长得一模一样。
  for (const e of entries) {
    if (!isLive(e) || taken.has(e.id)) continue
    const ttl = Number(e.ttlDays) > 0 ? Number(e.ttlDays) : e.kind === 'fact' || e.kind === 'procedure' ? 180 : 365
    const age = ageDaysOf(e.updatedAt, now)
    if (age < ttl) continue
    if (e.status === 'active' || e.status === 'core') {
      push({
        kind: 'demote',
        id: e.id,
        bucket: 'ttl',
        reason: `not re-checked for ${Math.floor(age)} days (ttl ${ttl}d)`,
        needsReview: 'ttl',
      })
    } else if (e.status === 'candidate' && age >= ttl * 2) {
      push({ kind: 'archive', id: e.id, bucket: 'ttl', reason: `candidate expired after ${Math.floor(age)} days` })
    }
  }

  // 3. 衰减：半年没被注入、也没人读过。计数与时间戳都来自真实注入 / 读取路径
  //    （`noteInjected` / `noteRead`），不再用"从没注入过"这种永远为真的旧判据。
  //    核心与钉住的条目不在这里 —— 它们本来就不靠"被用到"来证明自己。
  for (const e of entries) {
    if (!isLive(e) || taken.has(e.id)) continue
    if (e.status !== 'active') continue
    const idle = lastTouched(e, now)
    if (idle < decayDays) continue
    push({ kind: 'archive', id: e.id, bucket: 'decay', reason: `not injected or read for ${Math.floor(idle)} days` })
  }

  // 4. 工作区失效：目录拔了 90 天（移动硬盘 / 删了仓库）。记忆留着，但不该继续占注入
  //    名额 —— 它对应的路径已经不存在了。
  const missing = opts.workspaceMissingDays ?? new Map<string, number>()
  for (const e of entries) {
    if (!isLive(e) || taken.has(e.id)) continue
    if (e.layer !== 'workspace' || !e.workspace) continue
    const days = missing.get(e.workspace)
    if (days === undefined || days < WORKSPACE_MISSING_DAYS) continue
    push({ kind: 'archive', id: e.id, bucket: 'workspace', reason: `workspace directory missing for ${Math.floor(days)} days` })
  }

  // 5. 配额：层里活条目超过上限时，按分数从低到高归档候选（只动候选 —— 归档一条
  //    active 等于替用户决定"这条不重要"，而候选本来就是"还没被确认"的那一档）。
  //    每次最多清 20%：一次扫描把候选清空，用户会以为记忆被清库了。
  for (const layer of ['session', 'scene', 'workspace', 'global'] as MemoryLayer[]) {
    const live = entries.filter((e) => isLive(e) && !taken.has(e.id) && e.layer === layer)
    const cap = caps[layer] ?? LAYER_QUOTA[layer]
    if (live.length <= cap) continue
    const maxHelpful = Math.max(0, ...live.map((e) => e.counters.helpful))
    const candidates = live
      .filter((e) => e.status === 'candidate')
      .map((e) => ({ e, score: scoreOf({ confidence: e.confidence, pinned: false, updatedAt: e.updatedAt }, e.counters, maxHelpful, now) }))
      .sort((a, b) => a.score - b.score)
    const budget = Math.max(1, Math.floor(cap * QUOTA_SWEEP_RATIO))
    const need = Math.min(live.length - cap, budget)
    for (const row of candidates.slice(0, need)) {
      push({ kind: 'archive', id: row.e.id, bucket: 'quota', reason: `layer ${layer} is over quota (${live.length}/${cap}); lowest-scoring candidates archived first` })
    }
  }

  return { actions, counts }
}

// ── 执行 ───────────────────────────────────────────────────────────────────

export interface SweepReport {
  at: string
  /** 预览：所有动作都只是"会这么处理"，没有真的改。 */
  dry: boolean
  episodes: { removed: number }
  outbox: { kept: number; dropped: number }
  workspaces: { checked: number; missing: number; back: number; archived: number }
  actions: { id: string; bucket: SweepBucket; kind: string; reason: string; ok: boolean; error?: string }[]
  counts: Record<SweepBucket, number>
  tokensBefore: number
  tokensAfter: number
  errors: string[]
}

export interface SweepDeps {
  /** 现有自动条目（含正文路径，TTL 从文件里读）。 */
  entries(): Promise<(SweepEntry & { filePath?: string })[]>
  learner: Learner
  episodes: EpisodeStore
  state: EvolutionStateStore
  config: {
    readWorkspaces(): Promise<{ workspaces: Record<string, { key: string; cwd: string; missingAt?: string | null }> }>
    markWorkspaceMissing(hash: string, missingAt: string | null): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }>
  }
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  log(row: Record<string, unknown>): Promise<void>
  message(e: unknown): string
  now?(): number
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** TTL 在 frontmatter 里（`auto_ttl_days`）；读不到就交给 `planSweep` 按 kind 取默认值。 */
async function ttlOf(filePath: string | undefined): Promise<number | undefined> {
  if (!filePath) return undefined
  try {
    const text = await readFile(filePath, 'utf8')
    const raw = Number(pickField(text, 'auto_ttl_days'))
    return Number.isFinite(raw) && raw > 0 ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * 跑一遍维护。返回的报告要能解释每一条动作 —— 它会原样出现在界面上。
 *
 * 顺序：先裁剪（纯删派生数据）→ 再扫工作区（只改 workspaces.json）→ 最后改记忆状态。
 * 前面两步失败不该挡住后面：episode 目录权限坏了，也不意味着 TTL 就不该跑。
 */
export async function runSweep(deps: SweepDeps, opts: SweepOptions = {}): Promise<SweepReport> {
  const now = deps.now ? deps.now() : Date.now()
  const at = new Date(now).toISOString()
  const dry = opts.dry === true
  const report: SweepReport = {
    at,
    dry,
    episodes: { removed: 0 },
    outbox: { kept: 0, dropped: 0 },
    workspaces: { checked: 0, missing: 0, back: 0, archived: 0 },
    actions: [],
    counts: { 'session-gc': 0, ttl: 0, decay: 0, workspace: 0, quota: 0 },
    tokensBefore: 0,
    tokensAfter: 0,
    errors: [],
  }

  try {
    report.episodes = await deps.episodes.prune(EPISODE_KEEP_DAYS, now)
  } catch (e) {
    report.errors.push('episodes: ' + deps.message(e))
  }
  try {
    report.outbox = await deps.episodes.compact(EPISODE_KEEP_DAYS, now)
  } catch (e) {
    report.errors.push('outbox: ' + deps.message(e))
  }

  const missingDays = new Map<string, number>()
  try {
    const file = await deps.config.readWorkspaces()
    for (const [hash, w] of Object.entries(file.workspaces)) {
      report.workspaces.checked++
      const present = w.cwd !== '' && (await exists(w.cwd))
      if (present) {
        if (w.missingAt) {
          const r = dry ? { ok: true as const, changed: true } : await deps.config.markWorkspaceMissing(hash, null)
          if (r.ok && r.changed) {
            report.workspaces.back++
            // 目录回来了，把它"因工作区失效"归档的记忆同步恢复（用户：删除与恢复要对等）。
            // 只认这条原因的归档：decay / ttl 归档的是"真死了"的记忆，回来的是目录，
            // 不是那些记忆的尸检结论。整段包住：恢复失败不该挡住后面的 TTL / 衰减扫描。
            if (!dry) {
              try {
                const all = await deps.entries()
                const stRead = await deps.state.read()
                const transitionsOf = (id: string): Array<{ to?: string; reason?: string }> =>
                  stRead.ok ? (stRead.state.entries[id]?.transitions ?? []) : []
                for (const e of all) {
                  if (e.layer !== 'workspace' || e.workspace !== hash) continue
                  if (e.status !== 'archived') continue
                  const lastArchive = [...transitionsOf(e.id)].reverse().find((x) => x.to === 'archived')
                  if (!lastArchive || !String(lastArchive.reason || '').includes('workspace directory missing')) continue
                  try {
                    await deps.learner.setStatus(e.id, 'active', 'dream', { reason: 'workspace directory is back' })
                  } catch (err) {
                    report.errors.push('workspace-restore: ' + deps.message(err))
                  }
                }
              } catch (err) {
                report.errors.push('workspace-restore: ' + deps.message(err))
              }
            }
          }
        }
        continue
      }
      report.workspaces.missing++
      const markedAt = w.missingAt ?? new Date(now).toISOString()
      if (!w.missingAt && !dry) {
        const r = await deps.config.markWorkspaceMissing(hash, markedAt)
        if (!r.ok) report.errors.push('workspace: ' + r.error)
      }
      missingDays.set(hash, ageDaysOf(markedAt, now))
    }
  } catch (e) {
    report.errors.push('workspaces: ' + deps.message(e))
  }

  const raw = await deps.entries()
  const entries: SweepEntry[] = []
  for (const e of raw) {
    const ttlDays = await ttlOf(e.filePath)
    const { filePath: _drop, ...rest } = e
    entries.push(ttlDays === undefined ? rest : { ...rest, ttlDays })
  }
  report.tokensBefore = entries.filter(isLive).reduce((n, e) => n + e.tokens, 0)

  const { actions, counts } = planSweep(entries, { ...opts, now, workspaceMissingDays: missingDays })
  report.counts = counts

  for (const a of actions) {
    if (dry) {
      report.actions.push({ id: a.id, bucket: a.bucket, kind: a.kind, reason: a.reason, ok: true })
      if (a.bucket === 'workspace') report.workspaces.archived++
      continue
    }
    try {
      const r = a.kind === 'archive'
        ? await deps.learner.setStatus(a.id, 'archived', 'dream', { reason: a.reason })
        : await deps.learner.setStatus(a.id, 'candidate', 'dream', { reason: a.reason, needsReview: a.needsReview })
      const ok = Boolean(r && r.ok)
      const err = (r as { error?: string } | undefined)?.error
      report.actions.push({ id: a.id, bucket: a.bucket, kind: a.kind, reason: a.reason, ok, ...(ok ? {} : { error: err }) })
      if (a.bucket === 'workspace' && ok) report.workspaces.archived++
    } catch (e) {
      report.actions.push({ id: a.id, bucket: a.bucket, kind: a.kind, reason: a.reason, ok: false, error: deps.message(e) })
    }
  }

  // 归档/降级之后的估算：被归档的不再进注入，降为候选的也不再进。
  const changed = new Set(report.actions.filter((x) => x.ok).map((x) => x.id))
  report.tokensAfter = entries.filter((e) => isLive(e) && !changed.has(e.id)).reduce((n, e) => n + e.tokens, 0)

  if (!dry) {
    await deps.state.update((st) => {
      st.watermarks.lastSweepAt = at
      return true
    }).catch(() => ({ ok: false as const, error: 'state write failed' }))
  }

  await deps.log({ at, event: 'sweep', counts, actions: report.actions.length, errors: report.errors.length })
  return report
}

/** 每天一次就够：扫描本身很便宜，但它会改状态，跑太勤只会让界面数字乱跳。 */
export const SWEEP_INTERVAL_MS = 24 * 3600_000

export function shouldSweepNow(lastSweepAt: string | undefined, now = Date.now()): boolean {
  if (!lastSweepAt) return true
  const t = Date.parse(lastSweepAt)
  return !Number.isFinite(t) || now - t >= SWEEP_INTERVAL_MS
}

/** 健康度：界面顶部那三行数字。只读，纯统计。 */
export function healthOf(entries: SweepEntry[], state: { entries: Record<string, { needsReview?: string }> }, layerCaps: Partial<Record<MemoryLayer, number>> = {}) {
  const caps = { ...LAYER_QUOTA, ...layerCaps }
  const byLayer: Record<string, { active: number; candidate: number; archived: number; cap: number; tokens: number }> = {}
  for (const layer of ['session', 'scene', 'workspace', 'global'] as MemoryLayer[]) {
    byLayer[layer] = { active: 0, candidate: 0, archived: 0, cap: caps[layer] ?? LAYER_QUOTA[layer], tokens: 0 }
  }
  let tokens = 0
  let conflicts = 0
  let needsReview = 0
  let expired = 0
  const now = Date.now()
  for (const e of entries) {
    const row = byLayer[e.layer]
    if (!row) continue
    if (e.status === 'active' || e.status === 'core' || e.status === 'playbook') {
      row.active++
      row.tokens += e.tokens
      tokens += e.tokens
    } else if (e.status === 'archived' || e.status === 'superseded') row.archived++
    else row.candidate++
    if (state.entries[e.id]?.needsReview) needsReview++
    if (e.counters.harmful >= 2) conflicts++
    const ttl = e.ttlDays && e.ttlDays > 0 ? e.ttlDays : e.kind === 'fact' || e.kind === 'procedure' ? 180 : 365
    if (ageDaysOf(e.updatedAt, now) >= ttl) expired++
  }
  return { byLayer, tokens, conflicts, needsReview, expired, total: entries.length }
}
