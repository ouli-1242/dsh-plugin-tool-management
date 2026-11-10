// 自动段的渲染：每个域只渲染**一层**（全局 / 本工作区）。
//
// 三条硬约束，每一条都对应一个会毁掉体验的具体故障：
//
// ① **预算按层独立**。两个自动记忆域各占一条消息，各自只装自己那一层的条目；上限是该层
//    max + 固定开销。用户记忆是另一条消息，不在这里竞争 —— 手写记忆再多也不会把自动段挤成 0，
//    反过来自动记忆再多也挤不掉用户写的东西。拆域之前两层共用一脚预算，任何一条新增都会让
//    整段（含用户记忆）重发；现在只有变化的那一层会重发。
//
// ② **不按场景分组**。全局层就是全局；「本工作区」块里的工作区 / 旧会话 / 旧场景条目都按
//    本地处理，不写成 `## Scene: X` —— 那会让模型以为用户建了一个叫 `_ws/3f2a` 的场景。
//
// ③ **文本稳定**。注入去重按正文字节比对，任何"按当前时间算"的东西（相对时间、随机顺序、
//    每次重排）都会让整段每轮重发。所以：条目按固定规则排序，时间只体现为分数（影响谁进来），
//    不体现为文本。

import {
  AUTO_BUDGET_DEFAULT, AUTO_BUDGET_MAX, AUTO_BUDGET_MIN, AUTO_BUDGET_RATIO,
  AUTO_L0_MAX, AUTO_LAYER_BUDGET, AUTO_MAX_ENTRIES,
  AUTO_MEMORY_NOTE, AUTO_USER_SEGMENT_HARD_TOKENS, AUTO_USER_SEGMENT_SOFT_TOKENS,
  LAYER_GLOBAL, LAYER_SCENE, LAYER_SESSION, LAYER_WORKSPACE, TRUNCATION_MARKER,
  type MemoryLayer,
} from './constants.js'
import { isInjectableStatus, type CatalogEntry } from './catalog.js'
import { scoreOf, type EntryCounters, type EvolutionState } from '../evolution/state.js'

/** 自动记忆的两个注入层。 */
export type AutoLayer = 'global' | 'workspace'

/**
 * 固定开销：授权语 + 可能的风格行 / 截断行。从总盘里先扣掉，避免"装满了但发不出去"。
 * 比旧单块时代的 120 大：现在每个域各带一份授权语，拆域没有共享这一句。
 */
const OVERHEAD_TOKENS = 200

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
  /**
   * 笔记风格指引（用户设置，一句话）。放在授权语正下方 —— 模型在本会话里学新东西时，
   * 写法照这个来；段文本含它，所以风格变化会随段重发一次（去重按整段字节比对）。
   */
  styleLine?: string
}

export interface AutoRenderResult {
  /** 整段正文（不含框架标题）；空串 = 不注入。 */
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
  /** 真正进入这段文本的条目 id（调用方据此写注入计数）。 */
  pickedIds: string[]
}

const zeroByLayer = (): Record<MemoryLayer, number> => ({ global: 0, workspace: 0, scene: 0, session: 0 })

/** 总盘：`clamp(contextWindow × 1.5%, 800, 2400)`，拿不到窗口用 1600。 */
export function autoBudgetOf(contextWindow: number | undefined): number {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return AUTO_BUDGET_DEFAULT
  const raw = Math.round(contextWindow * AUTO_BUDGET_RATIO)
  return Math.min(AUTO_BUDGET_MAX, Math.max(AUTO_BUDGET_MIN, raw))
}

/** 用户记忆段落在哪一档：正常 / 缩到该层 min / 归零。 */
export function budgetModeOf(userSegmentTokens: number): 'none' | 'min' | 'zero' {
  if (userSegmentTokens > AUTO_USER_SEGMENT_HARD_TOKENS) return 'zero'
  if (userSegmentTokens > AUTO_USER_SEGMENT_SOFT_TOKENS) return 'min'
  return 'none'
}

/**
 * 单层预算：用户记忆太大时缩到该层 min；否则取该层 max，再与总盘取小。
 *
 * 不改用户记忆的渲染（那是既有行为），只缩自动段；两层各自缩，不会互相踩。
 */
export function competitorBudgetOfLayer(
  total: number,
  userSegmentTokens: number,
  layer: AutoLayer,
): { budget: number; reduced: 'none' | 'min' | 'zero' } {
  const mode = budgetModeOf(userSegmentTokens)
  if (mode === 'zero') return { budget: 0, reduced: 'zero' }
  const cap = mode === 'min' ? AUTO_LAYER_BUDGET[layer].min : AUTO_LAYER_BUDGET[layer].max
  return { budget: Math.min(total, cap + OVERHEAD_TOKENS), reduced: mode }
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

/** 这条目录项是否属于这一层。workspace 域兼容旧数据：会话层按 sid、场景层按启用场景。 */
function inLayer(entry: CatalogEntry, layer: AutoLayer, scope: AutoRenderScope): boolean {
  if (layer === 'global') return entry.layer === LAYER_GLOBAL
  if (entry.layer === LAYER_WORKSPACE) return scope.workspaceHash !== undefined && entry.workspace === scope.workspaceHash
  // 会话层 / 场景层已不再写入，但盘上可能还有旧条目：按当前环境放进「本工作区」块，
  // 不让它们静默消失（维护扫描仍按原规则 GC 会话层）。
  if (entry.layer === LAYER_SESSION) return scope.sessionId !== undefined && entry.session === scope.sessionId
  if (entry.layer === LAYER_SCENE) return scope.enabledScenes !== undefined && scope.enabledScenes.has(entry.scene)
  return false
}

/**
 * 渲染某一层的自动段正文。纯函数：同样的输入永远给同样的字节（去重的前提）。
 *
 * 标题不在这里：`# Learned notes (all projects / this workspace)` 由注入框架按域提供。
 */
export function renderAutoLayer(layer: AutoLayer, input: AutoRenderInput): AutoRenderResult {
  const empty: AutoRenderResult = { text: '', count: 0, tokens: 0, budget: 0, dropped: 0, byLayer: zeroByLayer(), pickedIds: [] }
  const total = autoBudgetOf(input.contextWindow)
  const { budget, reduced } = competitorBudgetOfLayer(total, input.userSegmentTokens, layer)
  if (budget <= 0) return { ...empty, budget: 0, dropped: input.entries.length }

  const usable = Math.max(0, budget - OVERHEAD_TOKENS)
  const scope = input.scope

  // 候选：状态可注入 + 层匹配 + 未挂待裁决。L0（core / playbook / pinned）只影响预算次序。
  const maxHelpful = Math.max(1, ...Object.values(input.state.entries).map((e) => e.counters?.helpful ?? 0))
  const candidates: Array<{ entry: CatalogEntry; score: number; l0: boolean }> = []
  for (const entry of input.entries) {
    if (!entry.enabled) continue
    if (!isInjectableStatus(entry.status)) continue
    if (!inLayer(entry, layer, scope)) continue
    const st = input.state.entries[entry.id]
    // 待裁决的不注入：与用户记忆冲突、或表述有歧义的条目，等用户确认后才算数。
    if (st && typeof st.needsReview === 'string' && st.needsReview !== '') continue
    // playbook 是从 core 晋升来的，常驻待遇跟着走：它比普通 active 更值得每次露一面。
    // 不再设信心门槛：能进 `isInjectableStatus` 的条目已经过用户在记忆页 / 卡片上确认；
    // 再拿 confidence 筛一次，正是「确认了却不注入」那类静默失效的来源。
    const l0 = entry.status === 'core' || entry.status === 'playbook' || entry.pinned
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

  const picked: CatalogEntry[] = []
  let l0Count = 0
  let spent = 0
  for (const cand of candidates) {
    if (picked.length >= AUTO_MAX_ENTRIES) break
    if (spent + cand.entry.estTokens > usable) continue
    if (cand.l0) {
      // L0 常驻：不受层配额限制，只受 L0 条数上限与总盘限制。
      if (l0Count >= AUTO_L0_MAX) continue
      l0Count++
    }
    picked.push(cand.entry)
    spent += cand.entry.estTokens
  }

  if (picked.length === 0) return { ...empty, budget, dropped: candidates.length }

  // 单层内按正文排序：先总则后特例在这里没有意义（层已经分开了），稳定才是第一位的。
  picked.sort((a, b) => a.oneLine.localeCompare(b.oneLine) || a.id.localeCompare(b.id))

  const dropped = candidates.length - picked.length
  const lines = [AUTO_MEMORY_NOTE, '']
  if (input.styleLine && String(input.styleLine).trim() !== '') lines.push(`(House style for new notes: ${String(input.styleLine).trim()})`, '')
  lines.push(...picked.map(lineOf))
  if (dropped > 0) lines.push('', `${TRUNCATION_MARKER} ${dropped} more learned note(s) not shown; list them with memory_manager_list (auto=true).`)
  if (reduced === 'min') lines.push('', '(This conversation\'s hand-written memories are large, so learned notes are shown at their minimum budget.)')
  const text = lines.join('\n') + '\n'

  const byLayer = zeroByLayer()
  byLayer[layer] = picked.length
  return {
    text,
    count: picked.length,
    tokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 3),
    budget,
    dropped,
    byLayer,
    pickedIds: picked.map((e) => e.id),
  }
}

/**
 * 估算一段文本的 token（与自动段同一口径：3 bytes/token）。
 * 给"用户记忆段竞争"用 —— 那边只有已渲染的字符串，没有逐条的 token 记账。
 */
export const estimateTextTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text ?? '', 'utf8') / 3)
