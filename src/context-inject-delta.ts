// 记忆块的增量差集：只回答"哪些条目新增 / 改了 / 没了"以及怎么把它写成一条消息。
//
// 这一层不碰会话状态，也不决定发不发（那是 context-inject.ts 的增量账本）；纯字符串进出，
// 便于单独钉住格式与排序。差集按 `key` 做，不按文本相似度 —— 记忆的 id 就是身份，
// 改名 / 改正文 / 换场景都是同一条的"更新"，不是删一条再加一条。
import type { IncrementalEntry, IncrementalSnapshot } from './context-inject-contract.js'

/** 上一次发送时一条条目的样子；`group` 也参与比较（换场景 = 更新）。 */
export interface IncrementalEntryState {
  text: string
  group?: string
}

export interface IncrementalDiff {
  added: IncrementalEntry[]
  updated: IncrementalEntry[]
  removed: IncrementalEntry[]
}

/** 上一次的条目 → 这一次的条目。顺序沿用当前快照（确定性），删除项沿用旧 Map 的插入序。 */
export function diffIncremental(
  previous: ReadonlyMap<string, IncrementalEntryState>,
  current: ReadonlyArray<IncrementalEntry>,
): IncrementalDiff {
  const now = new Map(current.map((entry) => [entry.key, entry] as const))
  const added: IncrementalEntry[] = []
  const updated: IncrementalEntry[] = []
  for (const entry of current) {
    const old = previous.get(entry.key)
    if (old === undefined) added.push(entry)
    else if (old.text !== entry.text || old.group !== entry.group) updated.push(entry)
  }
  const removed: IncrementalEntry[] = []
  for (const [key, old] of previous) {
    if (!now.has(key)) removed.push({ key, text: old.text, ...(old.group !== undefined ? { group: old.group } : {}) })
  }
  return { added, updated, removed }
}

/** 差集里一共有几条变化（调用方据此决定"太大就回全量"）。 */
export function diffCount(diff: IncrementalDiff): number {
  return diff.added.length + diff.updated.length + diff.removed.length
}

/**
 * 一条条目在差集里的显示文本。
 *
 * 新增 / 更新给整块（模型需要新正文）；删除只给第一行（名称与描述已经能回答"关的是哪条"，
 * 再贴一遍旧正文只是白付 token）。
 */
function entryTextOf(entry: IncrementalEntry, removed: boolean): string {
  const text = entry.text.replace(/\s+$/, '')
  if (!removed) return text
  const first = text.split('\n').find((line) => line.trim() !== '')
  return first === undefined ? text : first.trimEnd()
}

/** 按分组标题聚合；无分组的（自主笔记）归在空串组，渲染成 `Learned notes`。 */
function grouped(entries: readonly IncrementalEntry[]): Map<string, IncrementalEntry[]> {
  const out = new Map<string, IncrementalEntry[]>()
  for (const entry of entries) {
    const group = entry.group ?? ''
    const list = out.get(group)
    if (list === undefined) out.set(group, [entry])
    else list.push(entry)
  }
  return out
}

function renderGroup(entries: readonly IncrementalEntry[], removed: boolean): string {
  const chunks: string[] = []
  for (const [group, list] of grouped(entries)) {
    // 空串组是自主笔记：全量块里它的标题是 `## Learned notes`，差集沿用同一个名字，
    // 不能让这些"任何对话都成立"的笔记落进上一条用户记忆的场景标题下。
    chunks.push(`### ${group === '' ? 'Learned notes' : group}`)
    for (const entry of list) chunks.push(entryTextOf(entry, removed))
  }
  return chunks.join('\n\n')
}

/**
 * 差集首句：按这次变化由哪几类组成，说清每一类该怎么读。
 *
 * 只有新增时单独写「新增、未替代任何旧条目」—— 这是最常见的情形，也是 `## Added` 下的
 * 分组标题最容易被读成「这个场景的新整份」的地方。混合变化用一句覆盖三类；「未列出的
 * 条目不变」三类都成立，始终留在句尾。
 */
function leadOf(diff: IncrementalDiff): string {
  const kinds = (diff.added.length > 0 ? 1 : 0)
    + (diff.updated.length > 0 ? 1 : 0)
    + (diff.removed.length > 0 ? 1 : 0)
  if (kinds === 1 && diff.added.length > 0) {
    return 'New entries were added below. They are additions — no earlier entry was replaced, and every other entry is unchanged.'
  }
  if (kinds === 1 && diff.updated.length > 0) {
    return 'The entries below were updated. Each replaces its own earlier version; every other entry is unchanged.'
  }
  if (kinds === 1 && diff.removed.length > 0) {
    return 'The entries below were removed. They are no longer in effect; every other entry is unchanged.'
  }
  return 'Only the entries below differ from the earlier block. Added entries are new; updated entries replace their own earlier version; removed entries no longer apply. Every other entry is unchanged.'
}

/**
 * 把差集写成一条注入正文（不含框架标题）。
 *
 * 首句必须说清"这只是变化，不是新的全量"：模型手里还有上一块，差集本身不包含未变化的
 * 条目；不说清的话，它会把没列出的条目当成被关掉了。新增与更新还要分清「追加」与
 * 「同一替换」—— 两者在 `## Added` / `## Updated` 标题下长得一样。
 */
export function renderIncrementalDelta(diff: IncrementalDiff): string {
  const sections: string[] = []
  if (diff.added.length > 0) sections.push('## Added\n\n' + renderGroup(diff.added, false))
  if (diff.updated.length > 0) sections.push('## Updated\n\n' + renderGroup(diff.updated, false))
  if (diff.removed.length > 0) sections.push('## Removed\n\n' + renderGroup(diff.removed, true))
  if (sections.length === 0) return ''
  return leadOf(diff) + '\n\n' + sections.join('\n\n')
}

/** 通道里记的那份增量账本（只读视图，便于纯函数规划）。 */
export interface IncrementalStateLike {
  mode: string
  baseId: string
  deltaIds: readonly string[]
  deltaCount: number
  truncated: boolean
  entries: ReadonlyMap<string, IncrementalEntryState>
}

/**
 * `none` = 账本有效且条目没变（发不发交给上层按正文 / 框架指纹判）；
 * `full` = 必须重发整块；`delta` = 只发差集。
 */
export type IncrementalPlan =
  | { kind: 'none'; mode: string; entries: Map<string, IncrementalEntryState> }
  | { kind: 'full'; mode: string; entries: Map<string, IncrementalEntryState> }
  | { kind: 'delta'; mode: string; entries: Map<string, IncrementalEntryState>; text: string }

/**
 * 决定这一步发全量还是差集。纯函数：所有"为什么回全量"的理由都收在这里，通道只执行。
 *
 * 回全量的情形：首次 / 进程重启 / 账本里的全量或任一条差集已不在可见表面（压缩）/
 * 渲染环境变了 / 上一份被截断而现在不截断（账本只含当时入选的条目）/ 连续差集太多 /
 * 差集条目太多 / 差集不比全量小。截断态本身不强制每步全量 —— 只要账本也是截断态且
 * 条目没变，就交给上层判"没变"。
 */
export function planIncremental(input: {
  snapshot: IncrementalSnapshot
  state: IncrementalStateLike | undefined
  visibleIds: ReadonlySet<string>
  fullText: string
  maxDeltas?: number
  maxChanges?: number
}): IncrementalPlan {
  const entries = new Map(input.snapshot.entries.map((entry) => [entry.key, { text: entry.text, ...(entry.group !== undefined ? { group: entry.group } : {}) }] as const))
  const mode = input.snapshot.mode
  const state = input.state
  if (state === undefined) return { kind: 'full', mode, entries }
  const chainVisible = input.visibleIds.has(state.baseId)
    && state.deltaIds.every((id) => input.visibleIds.has(id))
  if (!chainVisible
    || state.mode !== mode
    || input.snapshot.truncated !== state.truncated
    || state.deltaCount >= (input.maxDeltas ?? 10)) {
    return { kind: 'full', mode, entries }
  }
  // 截断态下差集表达不了"未列出清单"的变化：账本也是截断态就只判"变没变"，
  // 内容一变就由上层回全量；两边都是截断态时不必每步重发。
  if (input.snapshot.truncated) return { kind: 'none', mode, entries }
  const diff = diffIncremental(state.entries, input.snapshot.entries)
  const changes = diffCount(diff)
  if (changes === 0) return { kind: 'none', mode, entries }
  if (changes > (input.maxChanges ?? 40)) return { kind: 'full', mode, entries }
  const text = renderIncrementalDelta(diff)
  // 差集不比全量小就没有省的意义；回全量还能顺手把账本重置成干净的一份。
  if (text === '' || Buffer.byteLength(text, 'utf8') >= Buffer.byteLength(input.fullText, 'utf8')) {
    return { kind: 'full', mode, entries }
  }
  return { kind: 'delta', mode, entries, text }
}
