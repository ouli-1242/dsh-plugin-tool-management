// 自动段的渲染（`## Learned notes (auto)`）。
//
// 三条硬约束，每一条都对应一个会毁掉体验的具体故障：
//
// ① **预算独立**。用户手写记忆段的预算是 128 KiB（`DEFAULT_MAX_BYTES`），自动段是 1600 token。
//    两者共用一脚预算时，手写记忆一多就把自动段挤成 0，用户看到的是"开了开关但什么都不生效"；
//    反过来，自动记忆一多就把手写记忆挤出去，那是更不可接受的（用户写的永远优先）。
//    所以这里只做自动段自己的分配，`renderSceneMemory` 那边把 `_ws` / `_session` 排除掉。
//
// ② **不进 `## Scene: X` 的分组**。自动条目住的目录（`_ws/<hash>` / `_session/<sid>`）不是场景，
//    按场景渲染会让模型以为"用户建了一个叫 `_ws/3f2a` 的场景"，而两层授权语也会错位。
//
// ③ **文本稳定**。注入去重按正文字节比对，任何"按当前时间算"的东西（相对时间、随机顺序、
//    每次重排）都会让整段每轮重发。所以：条目按固定规则排序，时间只体现为分数（影响谁进来），
//    不体现为文本。
//
// 为什么按层分配而不是全局排序：一层只有 8 条时，"全局排序"会让工作区的 8 条把会话层那 2 条
// 挤掉 —— 而那 2 条恰恰是"这次别动 migrations"这种立刻要用的约束。分层配额保证每层都露头。

import {
  AUTO_BUDGET_DEFAULT, AUTO_BUDGET_MAX, AUTO_BUDGET_MIN, AUTO_BUDGET_RATIO,
  AUTO_L0_MAX, AUTO_LAYER_BUDGET, AUTO_L1_MIN_CONFIDENCE, AUTO_MAX_ENTRIES,
  AUTO_MEMORY_HEADING, AUTO_MEMORY_NOTE,
  AUTO_USER_SEGMENT_HARD_TOKENS, AUTO_USER_SEGMENT_SOFT_TOKENS,
  LAYER_GLOBAL, LAYER_SCENE, LAYER_SESSION, LAYER_WORKSPACE, TRUNCATION_MARKER,
  type MemoryLayer,
} from './constants.js'
import { isInjectableStatus, type CatalogEntry } from './catalog.js'
import { scoreOf, type EntryCounters, type EvolutionState } from '../evolution/state.js'

/** 固定开销：标题 + 授权语 + 可能的截断行。从总盘里先扣掉，避免"装满了但发不出去"。 */
const OVERHEAD_TOKENS = 120

/** kind → 4 字符标签。短标签帮模型快速分型，也省 token。 */
const KIND_TAG: Record<string, string> = {
  preference: 'pref',
  fact: 'fact',
  correction: 'rule',
  procedure: 'proc',
}

export interface AutoRenderScope {
  workspaceHash?: string
  sessionId?: string
  enabledScenes?: Set<string>
}

export interface AutoRenderInput {
  entries: CatalogEntry[]
  state: EvolutionState
  scope: AutoRenderScope
  /** 用户记忆段实际用掉的估算 token（竞争降级用）。 */
  userSegmentTokens: number
  /** 上下文窗口；拿不到就传 undefined。 */
  contextWindow?: number
}

export interface AutoRenderResult {
  /** 整段文本；空串 = 不注入。 */
  text: string
  /** 实际注入条数。 */
  count: number
  /** 估算 token。 */
  tokens: number
  /** 本次总盘。 */
  budget: number
  /** 因预算 / 门槛没进来的条数。 */
  dropped: number
  /** 各层进来几条（诊断与界面用）。 */
  byLayer: Record<MemoryLayer, number>
}

/** 总盘：`clamp(contextWindow × 1.5%, 800, 2400)`，拿不到窗口用 1600。 */
export function autoBudgetOf(contextWindow: number | undefined): number {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return AUTO_BUDGET_DEFAULT
  const raw = Math.round(contextWindow * AUTO_BUDGET_RATIO)
  return Math.min(AUTO_BUDGET_MAX, Math.max(AUTO_BUDGET_MIN, raw))
}

/**
 * 用户段竞争：手写记忆太大时缩自动段。
 *
 * 不改用户段的渲染（那是既有行为，改了就是 breaking change），只缩自己：
 * < 8K token 正常；8–24K 降到所有层的 min 之和；> 24K 归零并让界面提示精简。
 */
export function competitorBudgetOf(total: number, userSegmentTokens: number): { budget: number; reduced: 'none' | 'min' | 'zero' } {
  if (userSegmentTokens > AUTO_USER_SEGMENT_HARD_TOKENS) return { budget: 0, reduced: 'zero' }
  if (userSegmentTokens > AUTO_USER_SEGMENT_SOFT_TOKENS) {
    const floor = Object.values(AUTO_LAYER_BUDGET).reduce((n, v) => n + v.min, 0)
    return { budget: Math.min(total, floor), reduced: 'min' }
  }
  return { budget: total, reduced: 'none' }
}

/**
 * 分层分配：先给每层 min，剩余先本项目后全局填到 max。
 *
 * 为什么这个优先级：本项目层条目更近、更具体，价值密度最高（一次协作里的项目约定
 * 通常直接改变下一步动作）；全局层最稳定，一条说清能用很久，少露几条不亏。
 */
export function allocateByLayer(
  total: number,
  present: MemoryLayer[],
): Record<MemoryLayer, number> {
  const out: Record<MemoryLayer, number> = { global: 0, workspace: 0, scene: 0, session: 0 }
  if (total <= 0 || present.length === 0) return out
  const minSum = present.reduce((n, l) => n + AUTO_LAYER_BUDGET[l].min, 0)
  if (minSum > total) {
    // 连 min 都不够：按 min 比例缩，保证每层都有（宁可每层少一条，也不要整层消失）。
    for (const l of present) out[l] = Math.max(1, Math.floor((AUTO_LAYER_BUDGET[l].min / minSum) * total))
    return out
  }
  for (const l of present) out[l] = AUTO_LAYER_BUDGET[l].min
  let rest = total - minSum
  const order: MemoryLayer[] = [LAYER_SESSION, LAYER_WORKSPACE, LAYER_SCENE, LAYER_GLOBAL]
  // 两轮：第一轮按优先级填到 max；第二轮（若还有富余）再均分给仍有余量的层。
  for (const l of order) {
    if (!present.includes(l) || rest <= 0) continue
    const room = AUTO_LAYER_BUDGET[l].max - out[l]
    const give = Math.min(room, Math.floor(rest / Math.max(1, countRemaining(order, present, l))))
    out[l] += give
    rest -= give
  }
  // 富余没分完（除不尽 / 某层已到 max）：从优先级高的往下补。
  for (const l of order) {
    if (!present.includes(l) || rest <= 0) continue
    const room = AUTO_LAYER_BUDGET[l].max - out[l]
    const give = Math.min(room, rest)
    out[l] += give
    rest -= give
  }
  return out
}

function countRemaining(order: MemoryLayer[], present: MemoryLayer[], from: MemoryLayer): number {
  const i = order.indexOf(from)
  return Math.max(1, order.slice(i).filter((l) => present.includes(l)).length)
}

/**
 * 一行：`- [pref] 正文`；procedure 带 id（它要读全文，没 id 就得多查一次）。
 *
 * **playbook 只放标题**（P4）：它带着十几个步骤，整段塞进每轮上下文会吃掉自动段的大半
 * 预算，而且模型在没决定执行之前根本用不上。这里只告诉它"有这么一份已验证流程、id 是
 * 什么"，真要执行时再 `memory_manager_read` 取全文。预算仍按 `oneLine` 记（高估），
 * 不会因为标题短就多塞几条进来。
 */
export function lineOf(entry: CatalogEntry): string {
  const tag = KIND_TAG[entry.kind] ?? 'note'
  const idPart = entry.kind === 'procedure' && entry.id !== '' ? ` (id: ${entry.id})` : ''
  if (entry.status === 'playbook') {
    const fallback = entry.id.slice(entry.id.lastIndexOf('/') + 1)
    const title = (entry.title ?? '').trim() || entry.key || fallback
    return `- [${tag}] ${title}${idPart || ` (id: ${entry.id})`} — playbook, read the memory for steps`
  }
  return `- [${tag}] ${entry.oneLine}${idPart}`
}

const countersOf = (state: EvolutionState, id: string): EntryCounters =>
  state.entries[id]?.counters ?? { injected: 0, read: 0, helpful: 0, harmful: 0 }

/**
 * 渲染自动段。纯函数：同样的输入永远给同样的字节（去重的前提）。
 */
export function renderAutoBlock(input: AutoRenderInput): AutoRenderResult {
  const empty: AutoRenderResult = { text: '', count: 0, tokens: 0, budget: 0, dropped: 0, byLayer: { global: 0, workspace: 0, scene: 0, session: 0 } }
  const total = autoBudgetOf(input.contextWindow)
  const { budget, reduced } = competitorBudgetOf(total, input.userSegmentTokens)
  if (budget <= 0) return { ...empty, budget: 0, dropped: input.entries.length }

  const usable = Math.max(0, budget - OVERHEAD_TOKENS)
  const scope = input.scope

  // 候选：层匹配 + L1 门槛。L0（core / pinned）不受门槛限制。
  const maxHelpful = Math.max(1, ...Object.values(input.state.entries).map((e) => e.counters?.helpful ?? 0))
  const candidates: Array<{ entry: CatalogEntry; score: number; l0: boolean }> = []
  for (const entry of input.entries) {
    if (!entry.enabled) continue
    if (!isInjectableStatus(entry.status)) continue
    if (entry.layer === LAYER_WORKSPACE && (scope.workspaceHash === undefined || entry.workspace !== scope.workspaceHash)) continue
    if (entry.layer === LAYER_SESSION && (scope.sessionId === undefined || entry.session !== scope.sessionId)) continue
    if (entry.layer === LAYER_SCENE && (!scope.enabledScenes || !scope.enabledScenes.has(entry.scene))) continue
    const st = input.state.entries[entry.id]
    // 待裁决的不注入：与用户记忆冲突、或表述有歧义的条目，等用户确认后才算数。
    if (st && typeof st.needsReview === 'string' && st.needsReview !== '') continue
    if (st && st.locked === true) {
      // 用户编辑过 = 已确认，按 active 处理（不受 L1 门槛限制）。
    }
    // playbook 是从 core 晋升来的，常驻待遇跟着走：它比普通 active 更值得每次露一面。
    const l0 = entry.status === 'core' || entry.status === 'playbook' || entry.pinned
    if (!l0 && !(countersOf(input.state, entry.id).helpful > 0 || entry.confidence >= AUTO_L1_MIN_CONFIDENCE)) continue
    candidates.push({
      entry,
      l0,
      score: scoreOf(
        { confidence: entry.confidence, pinned: entry.pinned, updatedAt: new Date(entry.mtime || 0).toISOString() },
        countersOf(input.state, entry.id),
        maxHelpful,
      ),
    })
  }

  if (candidates.length === 0) return { ...empty, budget, dropped: 0 }

  // 排序必须是**确定**的：分数降序 → id 升序（同分时给一个稳定次序，否则每次 pre-step 顺序都变，
  // 去重指纹跟着变，整段重发）。
  candidates.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))

  const present = [...new Set(candidates.map((c) => c.entry.layer))]
  const quota = allocateByLayer(usable, present)
  const byLayer: Record<MemoryLayer, number> = { global: 0, workspace: 0, scene: 0, session: 0 }
  const picked: CatalogEntry[] = []
  let l0Count = 0
  let spent = 0
  /** 每层已占名额（L0 也算）：L0 优先，但把名额用掉之后该层的 L1 就少了 —— 这是有意的。 */
  const used: Record<MemoryLayer, number> = { global: 0, workspace: 0, scene: 0, session: 0 }

  for (const cand of candidates) {
    if (picked.length >= AUTO_MAX_ENTRIES) break
    if (spent + cand.entry.estTokens > usable) continue
    if (cand.l0) {
      // L0 常驻：不受层配额限制，只受 L0 条数上限与总盘限制。
      if (l0Count >= AUTO_L0_MAX) continue
      l0Count++
    } else if (used[cand.entry.layer] >= quotaOf(quota, cand.entry.layer)) {
      continue
    }
    picked.push(cand.entry)
    used[cand.entry.layer]++
    byLayer[cand.entry.layer]++
    spent += cand.entry.estTokens
  }

  if (picked.length === 0) return { ...empty, budget, dropped: candidates.length }

  // 渲染顺序反过来：全局 → 工作区 → 场景 → 会话（先总则后特例），与注入体例一致。
  picked.sort((a, b) =>
    layerRank(a.layer) - layerRank(b.layer) || a.oneLine.localeCompare(b.oneLine) || a.id.localeCompare(b.id))

  const dropped = candidates.length - picked.length
  const lines = [AUTO_MEMORY_HEADING, '', AUTO_MEMORY_NOTE, '', ...picked.map(lineOf)]
  if (dropped > 0) lines.push('', `${TRUNCATION_MARKER} ${dropped} more learned note(s) not shown; search memories for them.`)
  if (reduced === 'min') lines.push('', '(This conversation\'s hand-written memories are large, so learned notes are shown at their minimum budget.)')
  const text = lines.join('\n') + '\n'

  return {
    text,
    count: picked.length,
    tokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 3),
    budget,
    dropped,
    byLayer,
  }
}

const layerRank = (l: MemoryLayer): number =>
  l === LAYER_GLOBAL ? 0 : l === LAYER_WORKSPACE ? 1 : l === LAYER_SCENE ? 2 : 3

const quotaOf = (quota: Record<MemoryLayer, number>, l: MemoryLayer): number =>
  // token 配额换算成"大约几条"：一条平均 35 token。至少 1 条，否则 min 配额会把整层饿死。
  Math.max(1, Math.floor(quota[l] / 35))

/**
 * 估算一段文本的 token（与自动段同一口径：3 bytes/token）。
 * 给"用户记忆段竞争"用 —— 那边只有已渲染的字符串，没有逐条的 token 记账。
 */
export const estimateTextTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text ?? '', 'utf8') / 3)
