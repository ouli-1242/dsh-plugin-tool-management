// 回收站保留期（0.19.1）—— 超过保留期的回收站条目由清扫**自动永久删除**。
//
// 为什么要有它：回收站此前只有「进来」没有「出去」—— 除了用户一条条点「永久删除」，
// 没有任何自动清空的开关。删掉一个场景、一批技能、一堆记忆之后，条目会一直躺在磁盘上。
// History（归档会话）页早就有这套（`hub/history-retention.json` + `sweepHistory`），
// 这里**刻意同形**：同一个 `{retentionDays, updatedAt}` 侧车形状、同一条到期判据、同一个
// 「改设置即重置倒计时」语义。两处口径一旦分家，用户在两个页面看到的就是两套话术。
//
// 覆盖六类：hub 四类（`trash/<域>-trash/<id>/manifest.json`）+ 技能（`trash/skills-trash/`，
// 元数据文件叫 `metadata.json`，是 core 层自己写的那套）+ 记忆（`memories-trash/`，
// **hub 根下的独立目录**，不在 `trash/` 里 —— 见 hub.ts 顶部那张目录图）。
//
// 三条口径（改这个文件前先读）：
//   ① `retentionDays <= 0` = **永久保留**，清扫是纯 no-op。这是默认值，也是本文件存在的
//      前提：`skills/manager-state.ts` 里有一条更早的产品裁定 ——「回收站没有自动清理：
//      超龄条目通过 warnings 提示用户到 Skills 管理页处理，**避免静默删除用户可能还想
//      恢复的内容**」。那条裁定针对的是「没有开关的自动删除」，所以这里默认关闭、
//      只有用户显式打开才删。默认值改了就等于推翻那条裁定，别顺手改。
//   ② 到期基线 = `max(deletedAt, updatedAt)`，`updatedAt` 是**最近一次改保留期的时刻**。
//      于是「把保留期从 30 天改成 7 天」不会当场删掉一批 8 天前的条目 —— 倒计时从改设置
//      那一刻按新天数重算。与 History 页同一条（那边原话：「改保留期即重置倒计时」）。
//   ③ `deletedAt` 缺失 / 解析失败**不清扫**。判据宁可漏删也不能误删：条目元数据被手改过、
//      或来自更早的版本时，我们并不知道它躺了多久 —— 按「刚删的」处理，让它等下一轮。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { recordAudit } from './audit-log.js'
import {
  hubPath,
  listTrashEntries,
  purgeTrashEntry,
  type TrashEntry,
  type TrashKind,
} from './hub.js'
import { listTrash as listSkillTrash, permanentlyDeleteTrash } from './skills/skill-trash.js'

/** 一天的毫秒数（保留期按「天」配置，比较按毫秒）。与 sessions/history.ts 同一个常量。 */
export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 保留期侧车文件名（放 hub 根，与 `history-retention.json` 并排）。 */
export const TRASH_RETENTION_FILE = 'trash-retention.json'

/** 走 hub 通用回收站的四类（技能与记忆各自另有实现，不在这里）。 */
export const HUB_TRASH_KINDS: readonly TrashKind[] = ['subagents', 'scenes', 'prompts', 'quick-prompts']

/** 永久删除时记流水用的 op 名 —— **复用各域已有的 `*-trash-delete`**，不另造一套。
 *  这样兼容页「最近改动」里自动清理与手工删除长得一样，`compat.audit.op.trashDelete`
 *  那条既有翻译也直接适用（否则会在流水里露出一串没人认识的 op 名）。 */
const AUDIT_OP_BY_KIND: Record<TrashKind, string> = {
  prompts: 'agentsmd-trash-delete',
  'quick-prompts': 'quickprompt-trash-delete',
  subagents: 'subagent-trash-delete',
  scenes: 'scene-trash-delete',
}
const AUDIT_OP_SKILLS = 'skill-trash-delete'
const AUDIT_OP_MEMORIES = 'rules-trash-remove'

/** 保留期设置（侧车形状）。`updatedAt` 单位是毫秒；`0` 表示「从没改过」。 */
export interface TrashRetention {
  retentionDays: number
  updatedAt: number
}

/** 侧车绝对路径。 */
export function trashRetentionPath(): string {
  return hubPath(TRASH_RETENTION_FILE)
}

/**
 * 解析侧车内容（纯函数，坏输入不抛）。
 *
 * 与 `readHistoryRetention` 同判据：`retentionDays` 只认**有限且非负**的数，其余一律 0
 * （= 永久保留）。宁可退化成「什么都不删」，也不能因为一份被手改坏的 JSON 变成
 * 「拿一个负数当保留期」—— 那会让 `now - 负数 * 一天` 落到未来，把全部条目判成到期。
 */
export function parseTrashRetention(raw: unknown): TrashRetention {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const days = Number((obj && obj.retentionDays) ?? 0)
  const updatedAt = Number((obj && obj.updatedAt) ?? 0)
  return {
    retentionDays: Number.isFinite(days) && days >= 0 ? days : 0,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
  }
}

/** 读侧车。文件不存在 / 读坏 / JSON 坏 → `{0, 0}`（= 永久保留）。 */
export async function readTrashRetention(): Promise<TrashRetention> {
  try {
    return parseTrashRetention(JSON.parse(await readFile(trashRetentionPath(), 'utf8')))
  } catch {
    return { retentionDays: 0, updatedAt: 0 }
  }
}

/** 写侧车。`updatedAt` = 本次修改时刻（到期基线随之重置，见文件头第 ② 条）。 */
export async function writeTrashRetention(retentionDays: number): Promise<void> {
  const abs = trashRetentionPath()
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, JSON.stringify({ retentionDays, updatedAt: Date.now() }), 'utf8')
}

/**
 * 算出到期应永久删除的条目 id（纯函数，便于测试）。
 *
 * 参数顺序、返回形状与 `sessions/history.ts` 的 `expiredArchivedIds` 逐字对应 ——
 * 两处保留期必须是同一套判据，改一边就要改另一边。
 *
 * @param entries 至少要有 `id` 与 `deletedAt`（ISO 字符串）
 * @param retentionDays `<= 0` = 永久保留，返回空集
 * @param now 当前时刻（毫秒）
 * @param updatedAt 最近一次改保留期的时刻（毫秒）；`0` = 从没改过，退回到 deletedAt 语义
 */
export function expiredTrashIds<T extends { id: string; deletedAt: string }>(
  entries: readonly T[],
  retentionDays: number,
  now: number,
  updatedAt = 0,
): string[] {
  if (!(retentionDays > 0)) return []
  const cutoff = now - retentionDays * MS_PER_DAY
  const out: string[] = []
  for (const entry of entries) {
    const deleted = Date.parse(String(entry.deletedAt ?? ''))
    // 缺失 / 解析失败 → 不知道躺了多久 → 不清扫（文件头第 ③ 条）。
    if (!Number.isFinite(deleted)) continue
    const baseline = updatedAt > 0 ? Math.max(deleted, updatedAt) : deleted
    if (baseline <= cutoff) out.push(entry.id)
  }
  return out
}

/**
 * 一个待清扫的候选：能算到期、也知道怎么删。
 *
 * 把「收集」与「删除」分开，是为了让 `expiredTrashIds` 保持纯函数 —— 到期判据可以单测，
 * 而六类的收集方式各不相同（hub 走 manifest.json、技能走 metadata.json、记忆走 memories 域）。
 */
export interface TrashCandidate {
  /**
   * 全局唯一键 = `domain + '/' + 条目 id`。
   *
   * 为什么不用裸 id：六类的 id 都由同一条生成器产出（`时间戳base36-uuid8`），
   * 跨域撞 id 的概率极低但**不是零**，而 `expiredTrashIds` 只看 id —— 撞上就会让
   * 「其中一条到期」把另一条没到期的也删掉。域前缀把这条路彻底堵死。
   */
  key: string
  /** 域标识（`prompts` / `skills` / `memories` …），只用于流水与回执。 */
  domain: string
  /** 记流水的对象名（条目名）。**只记名字，不记内容** —— 见 audit-log.ts 第 ① 条。 */
  name: string
  /** ISO 时间戳。 */
  deletedAt: string
  /** 永久删除。返回 `{ok:false}` 或抛错都算失败（下次清扫会再试）。 */
  purge(): Promise<unknown>
}

/** 清扫结果（回执与测试用）。 */
export interface TrashSweepResult {
  /** 已永久删除的条目（`<域>/<名字或 id>`）。 */
  swept: string[]
  /** 删除失败的条数（IO 错误等）。失败条目**留在回收站**，下一轮再试。 */
  failed: number
  /** 本次生效的保留期。`0` = 未启用，一个都没看。 */
  retentionDays: number
}

/** 记忆回收站的收集 / 删除（走 memories 域的 op，避免在这里重抄 `memories-trash` 的 manifest 形状）。 */
export interface MemoryTrashAccess {
  list(): Promise<Array<{ id: string; name: string; deletedAt: string }>>
  purge(id: string): Promise<unknown>
}

/**
 * 收集六类回收站条目（best-effort：某一类读不出来只跳过那一类，不拖垮整轮清扫）。
 *
 * 为什么每类各自 try/catch：清扫是启动期的后台动作，一个坏掉的 manifest 不该让另外五类
 * 永远清不掉 —— 那正是「保留期看起来没生效」这类难查故障的温床。
 */
export async function collectTrashCandidates(memories: MemoryTrashAccess): Promise<TrashCandidate[]> {
  const out: TrashCandidate[] = []

  for (const kind of HUB_TRASH_KINDS) {
    let entries: TrashEntry[] = []
    try { entries = await listTrashEntries(kind) } catch { entries = [] }
    for (const entry of entries) {
      out.push({
        key: `${kind}/${entry.id}`,
        domain: kind,
        name: entry.name,
        deletedAt: String(entry.deletedAt ?? ''),
        purge: () => purgeTrashEntry(kind, entry.id),
      })
    }
  }

  try {
    for (const item of await listSkillTrash()) {
      out.push({
        key: `skills/${item.id}`,
        domain: 'skills',
        name: item.name,
        // `deletedAt` 在技能元数据里是可选的：更早的版本可能没写 → 空串 → 不清扫（第 ③ 条）。
        deletedAt: String(item.deletedAt ?? ''),
        purge: () => permanentlyDeleteTrash(item.id, undefined),
      })
    }
  } catch { /* 技能回收站读不出来 → 本轮跳过 */ }

  try {
    for (const item of await memories.list()) {
      out.push({
        key: `memories/${item.id}`,
        domain: 'memories',
        name: item.name,
        deletedAt: String(item.deletedAt ?? ''),
        purge: () => memories.purge(item.id),
      })
    }
  } catch { /* 记忆回收站读不出来 → 本轮跳过 */ }

  return out
}

/** 删除成功与否：`{ok:false}` 与抛错都算失败（与 `recordOpAudit` 同口径）。 */
async function purgeSucceeded(run: () => Promise<unknown>): Promise<boolean> {
  try {
    const res = await run()
    if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === false) return false
    return true
  } catch {
    return false
  }
}

/**
 * 扫一轮：按当前保留期把到期条目永久删除。
 *
 * **刻意不经 op 表**（与 `sweepHistory` 同一条）：这是引擎自己的后台动作，不是「谁发起的
 * 一次改动」。走 op 表会同时套上令牌门禁与场景冻结 —— 于是「锁着一个场景」就等于
 * 「保留期静默失效」，而用户根本看不出原因。手工删除仍走各域的 `*-trash-delete`（那几条
 * 是冻结的），两条路的差别只在**发起方**：用户点的是写操作，清扫不是。
 *
 * 流水照记（`source: 'engine'`）：自动删掉的东西必须留痕，否则用户只会看到条目"自己消失了"。
 */
export async function sweepTrash(
  memories: MemoryTrashAccess,
  now: number = Date.now(),
): Promise<TrashSweepResult> {
  const { retentionDays, updatedAt } = await readTrashRetention()
  if (!(retentionDays > 0)) return { swept: [], failed: 0, retentionDays }

  const candidates = await collectTrashCandidates(memories)
  const expired = new Set(expiredTrashIds(candidates.map((c) => ({ id: c.key, deletedAt: c.deletedAt })), retentionDays, now, updatedAt))
  const swept: string[] = []
  let failed = 0

  for (const candidate of candidates) {
    if (!expired.has(candidate.key)) continue
    if (await purgeSucceeded(candidate.purge)) {
      swept.push(`${candidate.domain}/${candidate.name || candidate.key}`)
      recordAudit({
        ts: now,
        op: candidate.domain === 'skills' ? AUDIT_OP_SKILLS
          : candidate.domain === 'memories' ? AUDIT_OP_MEMORIES
            : (AUDIT_OP_BY_KIND[candidate.domain as TrashKind] || 'trash-sweep'),
        target: candidate.name || candidate.key,
        source: 'engine',
      })
    } else {
      failed += 1
    }
  }

  return { swept, failed, retentionDays }
}

/** 装配用的 ctx —— 直接用 cordis `Context`（与 `createHistoryDomain` 同一个类型，免得两处签名分家）。 */
export type TrashRetentionCtx = Context

export interface TrashRetentionDomainDeps {
  ctx: TrashRetentionCtx
  /** 插件配置（读 `sweepIntervalMs`，与 history 域共用同一个键）。 */
  config?: unknown
  /** 记忆回收站的收集 / 删除（走 memories 域的 op）。 */
  memories: MemoryTrashAccess
}

export interface TrashRetentionDomain {
  read(): Promise<TrashRetention>
  write(retentionDays: number): Promise<void>
  sweep(): Promise<TrashSweepResult>
}

/**
 * 回收站保留期域：读 / 写侧车 + 清扫，并在**启动时扫一次、之后按 `sweepIntervalMs` 周期复跑**。
 *
 * 与 `createHistoryDomain` 同形（那边是归档会话的保留期）：默认 6 小时一次，`sweepIntervalMs`
 * 由插件配置覆盖。间隔读同一个配置键，是为了让"清扫频率"只有一个说法 —— 两个域各读各的键，
 * 用户调了其中一个却只影响一半，是查不出来的那种不一致。
 *
 * 清扫**不阻断启动**：`void sweep()` 失败只 warn。回收站清理是附属能力，任何时候都不该
 * 让插件起不来（与 audit-log.ts 第 ② 条同一条纪律）。
 */
export function createTrashRetentionDomain(deps: TrashRetentionDomainDeps): TrashRetentionDomain {
  const { ctx, config, memories } = deps
  const configured = Number((config as { sweepIntervalMs?: unknown } | undefined)?.sweepIntervalMs || 0)
  const sweepIntervalMs = configured > 0 ? configured : 6 * 60 * 60 * 1000

  async function sweep(): Promise<TrashSweepResult> {
    try {
      return await sweepTrash(memories)
    } catch (e) {
      ctx.logger?.warn?.(`trash retention sweep failed: ${String((e as Error)?.message ?? e)}`)
      return { swept: [], failed: 0, retentionDays: 0 }
    }
  }

  // 启动时扫一次：上次退出到现在可能已经过了好几个保留期。
  try { void sweep() } catch { /* 非致命 */ }
  try {
    ctx.effect(() => {
      // interval 缺失时退化为不挂钟（fake-ctx 测试里正是如此，不阻塞测试）。
      const timer = ctx as unknown as {
        interval?: (cb: () => void, ms: number) => () => void
        setInterval?: (cb: () => void, ms: number) => () => void
      }
      const fn = typeof timer.interval === 'function' ? timer.interval
        : (typeof timer.setInterval === 'function' ? timer.setInterval : undefined)
      if (!fn) return () => { /* 没有定时器能力：只剩启动那一次 */ }
      return fn(() => { void sweep() }, sweepIntervalMs)
    }, 'dsh-plugin-tool-management: trash retention sweep')
  } catch { /* timer 缺失时静默 */ }

  return {
    read: readTrashRetention,
    write: writeTrashRetention,
    sweep,
  }
}
