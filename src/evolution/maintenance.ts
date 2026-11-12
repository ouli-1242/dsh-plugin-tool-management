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
import { isAbsolute, join } from 'node:path'
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
  /** 证据档位。确认过的条目老化得慢：用户已经看过它，再问一遍是打扰。 */
  tier: 'confirmed' | 'quoted' | 'inferred'
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
    lastInjectedAt?: string
    lastUsedAt?: string
  }
  /**
   * 已挂着的复核提醒（state 里的 `reviewDue`）。空 = 从没提醒过。
   *
   * 归档**只对提醒过的条目**生效：没提醒过就归档等于跳过用户，而模块承诺是
   * 「先提醒、后归档」。此前判据只有年龄，一条从未被提醒过的旧记忆会在第一次扫描时
   * 直接停用 —— 用户完全没看到「待复核」，它就从上下文里消失了。
   */
  reviewDue?: string
}

export type SweepBucket = 'review' | 'ttl' | 'workspace'

export type SweepAction =
  /** 只挂「待复核」，**不改状态、不停注入**。 */
  | { kind: 'flag'; id: string; bucket: 'review'; reason: string; reviewDue: string }
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
//
// 这个判据只管「这条还算不算活着」（统计口径、tokens 估算）。**TTL 老化另有一条判据**
// （`agesByTtl`）：候选也在这里算活着，但它不参与老化 —— 见那边的理由。
const isLive = (e: SweepEntry): boolean =>
  e.origin === 'auto' && e.locked !== true && (e.status === 'active' || e.status === 'core' || e.status === 'candidate')

/**
 * 这条会不会被 TTL 老化（提醒 / 归档）。
 *
 * 候选**不参与**：它本来就在等用户裁决，去处只有两个 —— 用户确认（→ active）或用户否决
 * （→ archived）。让 TTL 替用户归档，等于静默丢掉一条他从没看过的记忆；而给它挂「该复核了」
 * 又是把两个不同的问题混在一起（复核问的是「这条还成立吗」，候选问的是「这条要不要」）。
 * 候选因此会一直留着，直到用户处理 —— 界面有批量确认入口，这是有意的。
 */
const agesByTtl = (e: SweepEntry): boolean => e.status !== 'candidate'

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
  /** id → 它在 `actions` 里的下标。同一个 id 至多一条动作，后来的决定会覆盖前面的。 */
  const at = new Map<string, number>()
  const counts: Record<SweepBucket, number> = { review: 0, ttl: 0, workspace: 0 }

  const push = (a: SweepAction): void => {
    at.set(a.id, actions.length)
    actions.push(a)
    counts[a.bucket]++
  }

  // 1. TTL：**先提醒，后归档**。
  //
  //    提醒（`flag`）只挂 `reviewDue`，状态与注入都不动 —— 一条记忆突然从上下文里
  //    消失，比它稍微旧一点危险得多。用户看到「待复核」自己判断，点一下「复核」就重置计时。
  //
  //    归档（`archive`）只对**提醒过仍然没人理**的条目：`age >= archiveDays`，且
  //    `archiveDays > reviewDays`。没提醒过就归档等于跳过用户，那正是这一层要修掉的。
  //
  //    时钟取 `updatedAt`（`auto_updated` / 文件 mtime）：它量的是"最后一次被改写"，
  //    而「复核」与「编辑」都会改写它 —— 两者都是用户确认过这条仍然正确的动作。
  for (const e of entries) {
    if (!isLive(e) || at.has(e.id)) continue
    // 偏好与纠正都没有保质期：它们只会被新的偏好 / 新的纠正取代，时间不是判据。
    // 三年前说的「用中文」今天照样成立；「你刚才不该那样写」也不会因为放久了就失效。
    // 判据必须与 `expiredNow` 一致，否则界面上的「过期」数与扫描实际提醒的条数对不上。
    if (e.kind === 'preference' || e.kind === 'correction') continue
    // 候选不参与 TTL 老化：它的去处是用户裁决，不是时间（理由见 `agesByTtl`）。
    if (!agesByTtl(e)) continue
    // **真被用过的条目老化得慢**：模型主动拉过全文（`read > 0`）说明它在干活，
    // 时间对它不是证据。只有从没被读过、却一直占着注入位置的条目才值得催。
    //
    // 这一条把扫描从「按文件年龄清」变成「按有没有用清」。原来的判据只有年龄，
    // 一条每天都在用的记忆和一条从来没人看的记忆会在同一天收到同样的提醒。
    const usedAtLeastOnce = e.counters.read > 0
    // 用户确认过的同样放宽：他已经看过这条原文并点了同意，再问一遍是打扰。
    const trusted = e.tier === 'confirmed'
    const baseReview = Number(e.ttlDays) > 0 ? Number(e.ttlDays) : reviewDays
    const baseArchive = Number(e.ttlDays) > 0 ? baseReview * 3 : archiveDays
    // 倍数只放大不缩小：被用过 / 被确认过是「再等等」的理由，不是「更早清理」的理由。
    const factor = (usedAtLeastOnce ? 2 : 1) * (trusted ? 2 : 1)
    const reviewAt = baseReview * factor
    const archiveAt = baseArchive * factor
    const age = ageDaysOf(e.updatedAt, now)
    // **没提醒过就只提醒，不归档**。模块承诺是「先提醒、后归档」，而此前的判据只有年龄：
    // 一条从没被提醒过的 400 天旧记忆，第一次扫描就被停用 —— 用户没看到「待复核」，
    // 它就静默从上下文里消失了。现在只有已经挂着 `reviewDue` 的条目才够格归档。
    const reminded = typeof e.reviewDue === 'string' && e.reviewDue !== ''
    if (reminded && age >= archiveAt && archiveAt > reviewAt) {
      push({ kind: 'archive', id: e.id, bucket: 'ttl', reason: `not reviewed for ${Math.floor(age)} days` })
    } else if (age >= reviewAt) {
      push({
        kind: 'flag',
        id: e.id,
        bucket: 'review',
        reason: `not reviewed for ${Math.floor(age)} days`,
        reviewDue: 'ttl',
      })
    }
  }

  // 2. 工作区失效：目录拔了 90 天（移动硬盘 / 删了仓库）。记忆留着，但不该继续占注入
  //    名额 —— 它对应的路径已经不存在了。
  //
  // 这一轮**能覆盖上一轮的提醒**：目录都没了，再提醒「这条有点旧了」没有意义 —— 该停用。
  // 早先这里用「已被任何动作拿过就跳过」，于是被 TTL 挂上提醒的条目永远轮不到这一支，
  // 而事实类 / 流程类条目**必然**先被 TTL 拿一次：工作区失效的归档对它们完全失效。
  const missing = opts.workspaceMissingDays ?? new Map<string, number>()
  for (const e of entries) {
    if (!isLive(e)) continue
    if (e.layer !== 'workspace' || !e.workspace) continue
    const days = missing.get(e.workspace)
    if (days === undefined || days < WORKSPACE_MISSING_DAYS) continue
    const action: SweepAction = { kind: 'archive', id: e.id, bucket: 'workspace', reason: `workspace directory missing for ${Math.floor(days)} days` }
    const idx = at.get(e.id)
    const prev = idx === undefined ? undefined : actions[idx]
    if (prev !== undefined && prev.kind === 'archive') continue
    if (idx !== undefined && prev !== undefined) {
      // 覆盖：把上一轮那条提醒从计数里撤回，再写归档。
      counts[prev.bucket]--
      actions[idx] = action
      counts[action.bucket]++
      continue
    }
    push(action)
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
  /** 回收的孤儿状态条目数：文件已经不在，state 里还留着它的证据与计数。 */
  orphans: { removed: number }
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
  /**
   * 这条自动笔记的文件是不是**确实**不在了。
   *
   * 由调用方注入（它知道笔记根目录与 id 的拼法）；本模块不猜路径规则。
   * 实现必须只在 `ENOENT` / `ENOTDIR` 时返回 true —— 读不动（`EACCES` / `EBUSY`）
   * 一律当"还在"，否则一次权限抖动就会把证据链删掉。
   */
  noteFileGone(id: string): Promise<boolean>
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  log(row: Record<string, unknown>): Promise<void>
  message(e: unknown): string
  now?(): number
}

/**
 * 目录还在不在。
 *
 * 判据分三种，不能一律当成「不存在」：
 *   - `ENOENT` / `ENOTDIR` —— 真的没了；
 *   - 其它任何错误（`EACCES` / `EBUSY` / `EIO` / 网络盘断连）—— **不知道**，按"还在"处理。
 *
 * 早先一律 `return false`：一次瞬时 IO 故障就会给工作区写上 `missingAt`，90 天后该项目的
 * 全部记忆被自动归档。而"读不到"与"不存在"是两件事，只有后者该触发清理。
 */
const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch (e) {
    const code = (e as { code?: string } | null)?.code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
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
    orphans: { removed: 0 },
    workspaces: { checked: 0, missing: 0, back: 0, archived: 0 },
    actions: [],
    counts: { review: 0, ttl: 0, workspace: 0 },
    tokensBefore: 0,
    tokensAfter: 0,
    errors: [],
  }

  // `dry` 是「先看看会发生什么」——它**不许删任何东西**。
  //
  // 早先这里不判 `dry`：报告说「只出报告，一个状态都不改」，实际已经把过期的复习原料
  // 与 outbox 行删掉了。用户点「预览」等于真的清理了一次，而报告里只有数字，没有「已删除」。
  if (dry) {
    try {
      report.episodes = await deps.episodes.planPrune(EPISODE_KEEP_DAYS, now)
    } catch (e) {
      report.errors.push('episodes: ' + deps.message(e))
    }
    try {
      report.outbox = await deps.episodes.planCompact(EPISODE_KEEP_DAYS, now)
    } catch (e) {
      report.errors.push('outbox: ' + deps.message(e))
    }
  } else {
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
  }

  const missingDays = new Map<string, number>()
  try {
    const file = await deps.config.readWorkspaces()
    for (const [hash, w] of Object.entries(file.workspaces)) {
      report.workspaces.checked++
      // 判存在性优先用**工作区根**（`key` = scopeKey），不是 `cwd`。
      //
      // `cwd` 是"最近一次在哪个子目录里干过活"，可能是仓库里的 `repo/src`；拿它判断会把
      // "删了一个子目录"读成"整个工作区没了"，90 天后这个项目的全部记忆被归档。
      // 根在，工作区就在。
      //
      // `key` 不是绝对路径时（旧记录 / 非目录型 scope 键）退回 `cwd`：拿一个相对串去 stat
      // 只会得到"不存在"，那是比原来更糟的误判。
      const key = String(w.key || '')
      const root = isAbsolute(key) ? key : String(w.cwd || '')
      const present = root !== '' && (await exists(root))
      if (present) {
        if (w.missingAt) {
          const r = dry ? { ok: true as const, changed: true } : await deps.config.markWorkspaceMissing(hash, null)
          if (r.ok && r.changed) {
            report.workspaces.back++
            // 目录回来了，把它"因工作区失效"归档的记忆同步恢复（用户：删除与恢复要对等）。
            // 只认这条原因的归档：ttl 归档的是"真死了"的记忆，回来的是目录，
            // 不是那些记忆的尸检结论。整段包住：恢复失败不该挡住后面的 TTL / 工作区扫描。
            if (!dry) {
              try {
                const all = await deps.entries()
                const stRead = await deps.state.read()
                const transitionsOf = (id: string): Array<{ from?: string; to?: string; reason?: string }> =>
                  stRead.ok ? (stRead.state.entries[id]?.transitions ?? []) : []
                for (const e of all) {
                  if (e.layer !== 'workspace' || e.workspace !== hash) continue
                  if (e.status !== 'archived') continue
                  const lastArchive = [...transitionsOf(e.id)].reverse().find((x) => x.to === 'archived')
                  if (!lastArchive || !String(lastArchive.reason || '').includes('workspace directory missing')) continue
                  // 还原到**归档前的状态**，不是一律 active。
                  //
                  // 工作区失效会把候选一起归档（理由是「这个目录不在了」，与用户有没有确认过无关，
                  // 所以候选也该归档）。但插回硬盘不该等于用户点了确认 —— 早先这里硬编码 `active`，
                  // 于是一条用户从没看过的候选记忆，因为插回一块硬盘就生效并进入之后每一次对话。
                  // 授权只能由用户给，环境恢复只该把状态还原成原来的样子。
                  const restoreTo = lastArchive.from === 'candidate' ? 'candidate' : 'active'
                  try {
                    await deps.learner.setStatus(e.id, restoreTo, 'sweep', { reason: 'workspace directory is back' })
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
      // `flag` 走 `markReview`（只挂 `reviewDue`，状态与注入都不动）；`archive` 才是停用。
      const r = a.kind === 'archive'
        ? await deps.learner.setStatus(a.id, 'archived', 'sweep', { reason: a.reason })
        : await deps.learner.markReview(a.id, a.reviewDue)
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
    // 孤儿状态：条目文件被删了（用户删文件 / 同步工具 / 换机器），state 里还留着它的
    // 证据链与计数。留着只会让「自动记忆」的数字对不上列表，而且它永远不会自己消失。
    //
    // **不能拿 catalog 当"文件已删"的依据**：`buildCatalog` 逐条 `catch { continue }`
    // （读不动就跳过），目录被临时占住、网络盘断连、权限抖动都会让某一轮少几条。
    // 而 state 里是证据链与计数（不可重建），误删不可恢复。所以逐个确认文件确实不在。
    let orphans: string[] = []
    try {
      // **不能用 `cachedSync()`**：它在缓存冷的时候返回空 state 并后台刷新 —— 空 entries
      // 等于"一条都不在"，孤儿列表会恒为空（这个清理永远不生效）。读侧用带 1 秒缓存的
      // `read()` 就够，写路径才需要 `readFresh()`。
      const snap = await deps.state.read()
      if (!snap.ok) throw new Error(snap.error)
      const live = new Set(entries.map((e) => e.id))
      for (const id of Object.keys(snap.state.entries)) {
        if (live.has(id)) continue
        if (await deps.noteFileGone(id)) orphans.push(id)
      }
    } catch (e) {
      report.errors.push('orphans: ' + deps.message(e))
      orphans = []
    }

    // **走写锁**：`state.update` 是读-改-整份写回，与并发的写入路径（学习 / 确认 / 维护
    // 自己）叠在一起会互相覆盖 —— 典型症状是刚确认的证据链或新写的墓碑在扫描后消失。
    // 上面的 `markReview` / `setStatus` 各自有锁，只有这一笔漏在外面。
    try {
      const doomed = new Set(orphans)
      const r = await deps.withWriteLock(() => deps.state.update((st) => {
        st.watermarks.lastSweepAt = at
        for (const id of doomed) {
          // 锁内再确认一次：算列表到拿锁之间可能有人刚写了这条。
          if (st.entries[id] === undefined) continue
          delete st.entries[id]
          report.orphans.removed++
        }
        return true
      }))
      if (!r.ok) report.errors.push('state: ' + r.error)
    } catch (e) {
      report.errors.push('state: ' + deps.message(e))
    }
  }

  await deps.log({
    at,
    event: 'sweep',
    counts,
    actions: report.actions.length,
    orphans: report.orphans.removed,
    errors: report.errors.length,
  })
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
/**
 * 这条现在算不算「该提醒复核了」。`healthOf` 与 `planSweep` 共用，两处口径不许分叉。
 *
 * 与 `planSweep` 第 1 步逐条对应：只看会进扫描的条目（自动、未锁、active/core/candidate）、
 * 跳过偏好与纠正（都没有保质期）、已经挂着 `reviewDue` 的不重复计（它已经提醒过了，界面上另有计数）。
 */
function expiredNow(e: SweepEntry, reviewDue: string | undefined, now: number): boolean {
  if (!isLive(e)) return false
  // 偏好与纠正都没有保质期：它们只会被新的偏好 / 新的纠正取代，不会「过期」。
  // 两者的 `auto_ttl_days` 都写 3650（字段必须有数），但那个数**不是**复核周期 ——
  // 早先只跳过 `preference`，于是 `correction` 会在第 3650 天触发一次毫无意义的复核提醒。
  // 判据与 `ttlDaysOf` 的注释同源：只有 `fact` / `procedure` 会过期。
  if (e.kind === 'preference' || e.kind === 'correction') return false
  // 候选不参与老化（与 `planSweep` 同口径）：它不注入，提醒「复核」问的是另一件事。
  if (!agesByTtl(e)) return false
  if (typeof reviewDue === 'string' && reviewDue !== '') return false
  const usedAtLeastOnce = e.counters.read > 0
  const trusted = e.tier === 'confirmed'
  const baseReview = Number(e.ttlDays) > 0 ? Number(e.ttlDays) : REVIEW_DAYS
  const factor = (usedAtLeastOnce ? 2 : 1) * (trusted ? 2 : 1)
  return ageDaysOf(e.updatedAt, now) >= baseReview * factor
}

export function healthOf(entries: SweepEntry[], state: { entries: Record<string, { pendingReason?: string; reviewDue?: string }> }, now = Date.now()) {
  const byLayer: Record<string, { active: number; candidate: number; archived: number; tokens: number }> = {}
  for (const layer of ['session', 'scene', 'workspace', 'global'] as MemoryLayer[]) {
    byLayer[layer] = { active: 0, candidate: 0, archived: 0, tokens: 0 }
  }
  let tokens = 0
  let pendingReview = 0
  let reviewDue = 0
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
    if (state.entries[e.id]?.pendingReason) pendingReview++
    if (state.entries[e.id]?.reviewDue) reviewDue++
    // 「过期」= **这一轮真的会被提醒**的条数。判据必须与 `planSweep` 逐条对齐，否则界面上
    // 那个数字无法与维护动作对账 —— 用户看到「3 条过期」，点进去扫描却只提醒了 1 条。
    //
    // 三处早先的偏差：已归档 / 已取代的也数（它们本来就不在扫描范围里）、候选也数
    // （候选压根不注入，提醒它没有意义）、锁定条目也数（扫描跳过锁定条目）。
    if (expiredNow(e, state.entries[e.id]?.reviewDue, now)) expired++
  }
  // 「冲突」= 同 slot 但说法不同、且都还生效的条目。它回答的是"有没有两条互相矛盾的
  // 说法在同时注入"，而这个数字此前**恒为 0**（声明了却从不累加）—— 界面上一格永远是 0
  // 的统计，比不显示更糟：用户会以为"没有冲突"。
  //
  // 判据与写入侧同源：同 `key` 视为同一件事（`gates.ts` 的冲突门）。只数都生效的
  // （归档 / 候选不算），因为只有它们会同时进上下文。
  // 判据只看 id 个数：`SweepEntry` 不带正文，为了一个统计去扩接口不值得（正文会随
  // 条目数量把这份报告撑大）。同 key 下有两个以上**同时生效**的条目，就已经是
  // 注入侧无法解释的状态 —— 该让用户看见。
  const liveByKey = new Map<string, string[]>()
  for (const e of entries) {
    if (e.key === '') continue
    if (e.status !== 'active' && e.status !== 'core' && e.status !== 'playbook') continue
    const seen = liveByKey.get(e.key)
    if (seen === undefined) liveByKey.set(e.key, [e.id])
    else seen.push(e.id)
  }
  let conflicts = 0
  for (const ids of liveByKey.values()) if (ids.length > 1) conflicts += ids.length
  return { byLayer, tokens, conflicts, pendingReview, reviewDue, expired, total: entries.length }
}
