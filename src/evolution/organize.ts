// 「整理记忆」的草案计算（纯函数，不碰磁盘）。
//
// 为什么只算草案、不直接动手：整理是**不可逆**的（合并会丢一条的独立地位、归档会让它不再
// 注入）。模型说一句"整理一下记忆"就把五条合并了，用户没有机会看它到底合了什么。所以这里
// 只产出「建议 + 理由」，落盘由 `write.ts` 的 `applyOrganize` 在用户确认后做。
//
// 两类草案，判据都只依赖可观测的数据，且**都不做模型调用**：
//   · merge   —— 同层两条说法几乎一样（bigram Jaccard ≥ 0.82），key 不同 → 合成一条
//   · archive —— 候选长期没人确认 → 收起来（不删）
//
// `OrganizeAction` 里还有 `promote`（工作区条目提为全局），这里**从不产出**：
// 跨层提升不是「整理」—— 它改变的是适用范围，而整理只重排同一层里的东西。
// 类型与 `applyOrganize` 都留着它，是因为 `evolution-promote` 这个 op 仍然注册着
// （模型侧与界面都不调用，见 `op-registry.ts`）；产出它的判据要是将来加进来，
// 落盘路径已经通了。别在 `draftOrganize` 里补一条 —— 那会让「整理」一次改掉两层。
//
// 为什么不用模型判断"这两条是不是一回事"：草案要可解释、可复现。同一个库、同样的输入，
// 今天算出 3 条建议、明天算出 5 条，用户会不敢点。相似度阈值偏保守（宁可漏合并）正是为此。

import { MERGE_SIMILARITY, similarity, type ExistingEntry } from './gates.js'
import { tierOf, type EntryState } from './state.js'
import type { MemoryLayer } from '../memories/constants.js'

export type OrganizeAction = 'merge' | 'archive' | 'promote'

export interface OrganizeDraft {
  /** 确定性 id：同一批条目算出同一个串，便于界面「应用」时回传。 */
  id: string
  action: OrganizeAction
  /** 涉及的条目；merge 的第一条是保留项。 */
  ids: string[]
  layer?: MemoryLayer
  /** merge 保留哪条。 */
  keep?: string
  /** 给用户看的一句话理由（不是给模型看的提示词）。 */
  reason: string
}

export interface OrganizeInput {
  /** 全部记忆（用户 + 自动）。 */
  entries: ExistingEntry[]
  /** 自动条目的状态（证据、计数器、置信度）。 */
  states: Record<string, EntryState>
  /** 现在（毫秒）；测试注入用。 */
  now?: number
}

/** 候选超过这么久没人确认 → 建议收起来。 */
const CANDIDATE_STALE_DAYS = 21

/** 条目最近一次状态变化的时间（毫秒）；没有转移记录就用 0。 */
function lastTouchedAt(st: EntryState | undefined): number {
  const last = st?.transitions?.at(-1)
  if (!last || typeof last.at !== 'string') return 0
  const t = Date.parse(last.at)
  return Number.isFinite(t) ? t : 0
}

function draftIdOf(action: OrganizeAction, ids: string[]): string {
  return action + ':' + ids.join('>')
}

/**
 * 算一批草案。
 *
 * 顺序固定（merge → archive → promote，组内按 id 排序），这样界面不会每次刷新都换一遍顺序。
 * 已被 merge 吸收的条目不重复出现在 archive / promote 里 —— 两份草案点两次的结果是
 * "先合并、再归档这条已经不存在的东西"，第二次必然失败。
 */
export function draftOrganize(input: OrganizeInput): OrganizeDraft[] {
  const now = input.now ?? Date.now()
  const autos = input.entries
    .filter((e) => e.origin === 'auto' && e.status !== 'superseded' && e.status !== 'archived')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
  const stateOf = (id: string): EntryState | undefined => input.states[id]
  /**
   * 合并时保留哪条：证据档位高的 → id 小的（确定性兜底）。
   *
   * 早先比的是 `confidence` 小数，而那个数只由模型自报的 `source` 换算，两条同为
   * 推断的笔记之间它的差别没有意义。档位至少是能解释的：确认过的说法优先留下来。
   */
  const tierRankOf = (id: string): number => {
    const st = stateOf(id)
    return st ? { confirmed: 3, quoted: 2, inferred: 1 }[tierOf(st.evidence)] : 0
  }

  const drafts: OrganizeDraft[] = []
  const taken = new Set<string>()

  // ── merge：同层、不同 key、文本几乎一样 ──────────────────────────────────
  // 为什么要求 key 不同：同 key 的两条在写入管线里已经合成一条了，能同时存在的同 key 条目
  // 只可能是"手改过 key 的旧文件"，那不是合并问题，是数据修问题。
  for (let i = 0; i < autos.length; i++) {
    const a = autos[i]!
    if (taken.has(a.id) || a.text.trim() === '') continue
    for (let j = i + 1; j < autos.length; j++) {
      const b = autos[j]!
      if (taken.has(b.id) || b.layer !== a.layer || b.key === a.key) continue
      if (b.text.trim() === '') continue
      // 类型不同的两条不合并：相似度高只说明说法像，不说明它们是同一类东西。
      // 把 `procedure` 并进 `preference` 会让「30 天后提醒复核」凭空消失（偏好不过期）。
      // 两边都缺 kind（旧数据）时放行 —— 那种情况下没有可丢的类型信息。
      if (a.kind !== undefined && b.kind !== undefined && a.kind !== b.kind) continue
      const sim = similarity(a.text, b.text)
      if (sim < MERGE_SIMILARITY) continue
      const keep = tierRankOf(b.id) > tierRankOf(a.id) ? b : a
      const drop = keep === a ? b : a
      // 已经在同一层里"合并过一对"的不再参与第二对：三条几乎一样时两两合并会算两次，
      // 第二次合并的目标在第一次里已被吸收。
      taken.add(keep.id)
      taken.add(drop.id)
      drafts.push({
        id: draftIdOf('merge', [keep.id, drop.id]),
        action: 'merge',
        ids: [keep.id, drop.id],
        keep: keep.id,
        layer: keep.layer,
        reason: 'both say the same thing (' + Math.round(sim * 100) + '% alike) — keep `' + keep.key + '`, fold `' + drop.key + '` into it',
      })
      break
    }
  }

  // ── archive：候选过期（没人确认） ────────────────────────────────────────
  for (const e of autos) {
    if (taken.has(e.id)) continue
    if (e.status !== 'candidate') continue
    const touched = lastTouchedAt(stateOf(e.id))
    const days = touched === 0 ? 0 : (now - touched) / 86400_000
    if (touched > 0 && days >= CANDIDATE_STALE_DAYS) {
      drafts.push({
        id: draftIdOf('archive', [e.id]),
        action: 'archive',
        ids: [e.id],
        layer: e.layer,
        reason: 'candidate for ' + Math.floor(days) + ' days and never confirmed',
      })
      taken.add(e.id)
    }
  }

  return drafts
}
