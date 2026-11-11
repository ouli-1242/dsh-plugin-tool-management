// 维护扫描（P3）：把"记忆会自己变老"这件事从比喻变成一条可复现的规则。
//
// 三件事，按代价从低到高：
//   1. episode / outbox 裁剪 —— 30 天前的轮次摘要没人会再看，留着只是让目录变大。
//   2. TTL 到期 —— 事实会过期（端口号、包管理器）：先**提醒**（30 天，继续注入），
//      再久没人理才归档（90 天）。提醒不停用，是这一层的核心取舍，见 `planSweep`。
//   3. 工作区失效 —— 目录拔了 90 天（移动硬盘 / 删了仓库），记忆留着只会占注入名额。
//
// 一条纪律：**这套扫描只改状态，不删文件**。归档是可恢复的，删除不是；把两者混在一起，
// 用户迟早会遇到"我的记忆自己消失了"。真正的删除只有 `forget`（带墓碑与回收站）。
//
// 另一个纪律：**纯函数先出计划，再执行**。判断写在 `planSweep` 里，好测、可解释；
// 执行只是把计划翻译成 `setStatus` 调用。否则"为什么它把我的记忆归档了"永远说不清。
//
// 已经删掉的两条，别再按"看起来该有"加回来：
//   - **会话层 GC**：写入路由只剩全局 / 工作区（见 `evolution/route.ts`），门禁第九道
//     还会把残留的 session 层改写成工作区 —— 新数据里根本没有会话层条目。
//   - **衰减**：它读的注入计数只在**渲染文本变化**时 +1，量的是"这个文件多久没被改过"，
//     与"有没有被用"无关。照它归档，等于把一直在干活的记忆按文件年龄清掉。
//   - **配额**：只对 session 50 / scene 100 生效，而这两层正是废弃的那两层。

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryLayer } from '../memories/constants.js'
import type { EvolutionStateStore } from './state.js'
import type { EpisodeStore } from './episodes.js'
import type { Learner } from './write.js'
import { pickField } from './write.js'

/**
 * 事实 / 流程多久提醒一次复核（天）。到点只挂「待复核」，**继续注入**。
 *
 * 为什么是 30 而不是 180：动作从"停用"变成了"提醒"，早提醒的成本几乎为零 ——
 * 用户扫一眼就能判断，而晚提醒的代价是一条已经过时的记忆被当成事实用了半年。
 */
export const REVIEW_DAYS = 30
/** 提醒之后再过多久仍没人理就归档（天）。到期停用一条可能还在用的记忆，代价太大。 */
export const ARCHIVE_DAYS = 90
/** 工作区目录消失多久之后归档它的记忆（设计文档：90 天）。 */
export const WORKSPACE_MISSING_DAYS = 90
/** episode / outbox 保留天数。 */
export const EPISODE_KEEP_DAYS = 30

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

export type SweepBucket = 'review' | 'ttl' | 'workspace'

export type SweepAction =
  /** 只挂「待复核」，**不改状态、不停注入**。 */
  | { kind: 'flag'; id: string; bucket: 'review'; reason: string; needsReview: string }
  | { kind: 'archive'; id: string; bucket: SweepBucket; reason: string }

export interface SweepOptions {
  now?: number
  /** 多久提醒一次复核；默认 `REVIEW_DAYS`。 */
  reviewDays?: number
  /** 提醒后多久归档；默认 `ARCHIVE_DAYS`。 */
  archiveDays?: number
  /** hash → 目录已消失多少天（只含确实不存在的）。 */
  workspaceMissingDays?: Map<string, number>
  /** 只出计划，不改任何状态（界面的「预览」）。 */
  dry?: boolean
}

const day = 86400_000

const ageDaysOf = (iso: string | undefined, now: number): number => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? Math.max(0, (now - t) / day) : 0
}

// playbook 有意排除：它是旧数据里"验证过 3 次 + 用户确认链"的成果，自动老化不该把它降回候选。
// 要下线由用户手动归档。
const isLive = (e: SweepEntry): boolean =>
  e.origin === 'auto' && e.locked !== true && (e.status === 'active' || e.status === 'core' || e.status === 'candidate')

/**
 * 出计划。纯函数：同一份输入永远给同一份输出（`now` 显式传入）。
 *
 * 顺序固定，前面的动作会把条目从后面的判断里拿掉：一条已经被 TTL 归档的条目，
 * 不该在工作区那一轮又被处理一次。
 */
export function planSweep(entries: SweepEntry[], opts: SweepOptions = {}): { actions: SweepAction[]; counts: Record<SweepBucket, number> } {
  const now = opts.now ?? Date.now()
  const reviewDays = opts.reviewDays ?? REVIEW_DAYS
  const archiveDays = opts.archiveDays ?? ARCHIVE_DAYS
  const actions: SweepAction[] = []
  const taken = new Set<string>()
  const counts: Record<SweepBucket, number> = { review: 0, ttl: 0, workspace: 0 }

  const push = (a: SweepAction): void => {
    actions.push(a)
    taken.add(a.id)
    counts[a.bucket]++
  }

  // 1. TTL：**先提醒，后归档**。
  //
  //    提醒（`flag`）只挂一个 `needsReview`，状态与注入都不动 —— 一条记忆突然从上下文里
  //    消失，比它稍微旧一点危险得多。用户看到「待复核」自己判断，点一下「复核」就重置计时。
  //
  //    归档（`archive`）只对**提醒过仍然没人理**的条目：`age >= archiveDays`，且
  //    `archiveDays > reviewDays`。没提醒过就归档等于跳过用户，那正是这版要修掉的。
  //
  //    时钟取 `updatedAt`（`auto_updated` / 文件 mtime）：它量的是"最后一次被改写"，
  //    而「复核」与「编辑」都会改写它 —— 两者都是用户确认过这条仍然正确的动作。
  for (const e of entries) {
    if (!isLive(e) || taken.has(e.id)) continue
    // 偏好没有保质期：它只会被新的偏好取代，时间不是判据。三年前说的「用中文」今天照样成立。
    if (e.kind === 'preference') continue
    // 显式 TTL（`ttlDays` 参数 / frontmatter 的 `auto_ttl_days`）是用户指定的复核间隔；
    // 没给就按 kind 的默认值。归档阈值跟着它放大到 3 倍 —— 提醒过一次仍没人理，
    // 才是「这条可能真的过时了」的信号。
    const reviewAt = Number(e.ttlDays) > 0 ? Number(e.ttlDays) : reviewDays
    const archiveAt = Number(e.ttlDays) > 0 ? reviewAt * 3 : archiveDays
    const age = ageDaysOf(e.updatedAt, now)
    if (age >= archiveAt && archiveAt > reviewAt) {
      push({ kind: 'archive', id: e.id, bucket: 'ttl', reason: `not reviewed for ${Math.floor(age)} days` })
    } else if (age >= reviewAt) {
      push({
        kind: 'flag',
        id: e.id,
        bucket: 'review',
        reason: `not reviewed for ${Math.floor(age)} days`,
        needsReview: 'ttl',
      })
    }
  }

  // 2. 工作区失效：目录拔了 90 天（移动硬盘 / 删了仓库）。记忆留着，但不该继续占注入
  //    名额 —— 它对应的路径已经不存在了。
  const missing = opts.workspaceMissingDays ?? new Map<string, number>()
  for (const e of entries) {
    if (!isLive(e) || taken.has(e.id)) continue
    if (e.layer !== 'workspace' || !e.workspace) continue
    const days = missing.get(e.workspace)
    if (days === undefined || days < WORKSPACE_MISSING_DAYS) continue
    push({ kind: 'archive', id: e.id, bucket: 'workspace', reason: `workspace directory missing for ${Math.floor(days)} days` })
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
    counts: { review: 0, ttl: 0, workspace: 0 },
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
                    await deps.learner.setStatus(e.id, 'active', 'sweep', { reason: 'workspace directory is back' })
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
      // `flag` 走 `markReview`（只挂标记，状态与注入都不动）；`archive` 才是停用。
      const r = a.kind === 'archive'
        ? await deps.learner.setStatus(a.id, 'archived', 'sweep', { reason: a.reason })
        : await deps.learner.markReview(a.id, a.needsReview)
      const ok = Boolean(r && r.ok)
      const err = (r as { error?: string } | undefined)?.error
      report.actions.push({ id: a.id, bucket: a.bucket, kind: a.kind, reason: a.reason, ok, ...(ok ? {} : { error: err }) })
      if (a.bucket === 'workspace' && ok) report.workspaces.archived++
    } catch (e) {
      report.actions.push({ id: a.id, bucket: a.bucket, kind: a.kind, reason: a.reason, ok: false, error: deps.message(e) })
    }
  }

  // 归档之后的估算：只有被归档的不再进注入（`flag` 仍然注入，所以不计入 `changed`）。
  const changed = new Set(report.actions.filter((x) => x.ok && x.kind === 'archive').map((x) => x.id))
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

/**
 * 健康度：界面顶部那三行数字。只读，纯统计。
 *
 * `now` 显式传入（默认当前时间）：与 `planSweep` 同一条纪律 —— 纯统计函数不自己看表，
 * 否则测试只能按真实时钟构造数据。
 */
export function healthOf(entries: SweepEntry[], state: { entries: Record<string, { needsReview?: string }> }, now = Date.now()) {
  const byLayer: Record<string, { active: number; candidate: number; archived: number; tokens: number }> = {}
  for (const layer of ['session', 'scene', 'workspace', 'global'] as MemoryLayer[]) {
    byLayer[layer] = { active: 0, candidate: 0, archived: 0, tokens: 0 }
  }
  let tokens = 0
  let conflicts = 0
  let needsReview = 0
  let expired = 0
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
    // 「过期」= 该提醒复核了。与 `planSweep` 同一判据（偏好没有保质期）。
    if (e.kind !== 'preference' && ageDaysOf(e.updatedAt, now) >= (Number(e.ttlDays) > 0 ? Number(e.ttlDays) : REVIEW_DAYS)) expired++
  }
  return { byLayer, tokens, conflicts, needsReview, expired, total: entries.length }
}
